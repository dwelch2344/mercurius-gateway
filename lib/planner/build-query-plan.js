'use strict'

const { Kind, print, isListType, isNonNullType, isAbstractType, getNamedType } = require('graphql')
const {
  fieldNode,
  typenameField,
  collectVariableNames,
  buildRootDocument,
  buildEntityDocument
} = require('./fetch-document')
const { satisfiedBy } = require('../compose/field-set')
const { MER_ERR_GQL_GATEWAY_PLANNING, MER_ERR_GQL_GATEWAY_PLANNING_UNSUPPORTED } = require('./errors')

const INTROSPECTION_FIELDS = new Set(['__schema', '__type', '__typename'])

function responseKeyOf (selection) {
  return selection.alias ? selection.alias.value : selection.name.value
}

/**
 * Add `selection` to `list`, merging it into an existing field with the same
 * response key (nested selection sets are merged recursively).
 */
function addSelection (list, selection) {
  if (selection.kind === Kind.FIELD) {
    const existing = list.find(s =>
      s.kind === Kind.FIELD &&
      responseKeyOf(s) === responseKeyOf(selection) &&
      s.name.value === selection.name.value
    )
    if (existing) {
      if (existing.selectionSet && selection.selectionSet) {
        for (const nested of selection.selectionSet.selections) {
          addSelection(existing.selectionSet.selections, nested)
        }
      }
      return
    }
  }
  list.push(selection)
}

/**
 * A query plan is a tree of Fetch nodes.
 *
 *   plan = { operation, roots: [FetchNode], ordered: boolean }
 *
 * `roots` are the root fetches (one per subgraph for queries, one per
 * contiguous run of same-subgraph root fields for mutations, executed in order
 * when `ordered` is true). Every node's `children` are entity fetches that need
 * data produced by that node: they run after it, in parallel with each other.
 *
 *   FetchNode = {
 *     id, graph, operation,
 *     entityType: string | null,     // null for a root fetch
 *     path: string[],                // where parent objects live ('@' = list)
 *     selections: SelectionNode[],   // what to ask the subgraph at that position
 *     keyFields: SelectionSetNode,   // entity: chosen @key
 *     requires: SelectionSetNode[],  // entity: extra representation fields
 *     responseKeys: string[],        // root: response keys this fetch provides
 *     variableNames: Set<string>,
 *     variableDefinitions, documentNode, document: string,
 *     children: FetchNode[]
 *   }
 */

class PlanBuilder {
  constructor ({ schema, planIndex, operation, fragments, options = {} }) {
    this.schema = schema
    this.index = planIndex
    this.operation = operation
    this.fragments = fragments || {}
    this.options = options
    this.nextId = 1
  }

  build () {
    const operationType = this.operation.operation
    const rootType = operationType === 'query'
      ? this.schema.getQueryType()
      : operationType === 'mutation'
        ? this.schema.getMutationType()
        : this.schema.getSubscriptionType()
    /* istanbul ignore next: validation rejects operations without a root type */
    if (!rootType) {
      throw new MER_ERR_GQL_GATEWAY_PLANNING(`schema has no ${operationType} type`)
    }

    const rootTypeName = rootType.name
    const ordered = operationType === 'mutation'
    const roots = []
    const rootByGraph = new Map()

    const rootSelections = this.inlineFragments(this.operation.selectionSet.selections, rootTypeName)

    for (const selection of rootSelections) {
      /* istanbul ignore next: root selections are fields after fragment inlining */
      if (selection.kind !== Kind.FIELD) continue
      const fieldName = selection.name.value
      if (INTROSPECTION_FIELDS.has(fieldName)) continue
      const responseKey = selection.alias ? selection.alias.value : fieldName

      const graph = this.pickRootOwner(rootTypeName, fieldName, ordered ? roots[roots.length - 1] : null, rootByGraph)
      let node
      if (ordered) {
        const last = roots[roots.length - 1]
        node = last && last.graph === graph ? last : null
      } else {
        node = rootByGraph.get(graph) || null
      }
      if (!node) {
        node = this.createNode({ graph, operation: operationType, entityType: null, path: [] })
        roots.push(node)
        rootByGraph.set(graph, node)
      }
      node.responseKeys.push(responseKey)

      const fieldType = rootType.getFields()[fieldName].type
      const fieldSelections = selection.selectionSet
        ? this.collect(selection.selectionSet.selections, getNamedType(fieldType).name, graph, this.extendPath([], responseKey, fieldType), node, null, false, [], null)
        : undefined
      addSelection(node.selections, { ...selection, selectionSet: fieldSelections ? { kind: Kind.SELECTION_SET, selections: fieldSelections } : undefined })
    }

    for (const root of roots) this.finalize(root)

    return { operation: operationType, operationName: this.operation.name ? this.operation.name.value : null, ordered, roots }
  }

  createNode ({ graph, operation, entityType, path }) {
    return {
      id: this.nextId++,
      graph,
      operation,
      entityType,
      path,
      selections: [],
      keyFields: null,
      // typename used in the representation and the `... on` fragment; differs
      // from entityType when hopping into an @interfaceObject subgraph
      representationType: entityType,
      requires: [],
      parentAbstract: false,
      responseKeys: [],
      variableNames: new Set(),
      variableDefinitions: [],
      documentNode: null,
      document: null,
      children: [],
      childMap: new Map()
    }
  }

  extendPath (path, responseKey, type) {
    const next = [...path, responseKey]
    let t = type
    while (true) {
      if (isNonNullType(t)) {
        t = t.ofType
      } else if (isListType(t)) {
        next.push('@')
        t = t.ofType
      } else {
        break
      }
    }
    return next
  }

  typeInfo (typeName) {
    const type = this.index.types[typeName]
    /* istanbul ignore next: the API schema only contains types present in the supergraph */
    if (!type) throw new MER_ERR_GQL_GATEWAY_PLANNING(`type "${typeName}" is not in the supergraph`)
    return type
  }

  pickRootOwner (rootTypeName, fieldName, previousNode, rootByGraph) {
    const field = this.typeInfo(rootTypeName).fields[fieldName]
    /* istanbul ignore next: validation rejects unknown fields */
    if (!field) throw new MER_ERR_GQL_GATEWAY_PLANNING(`unknown root field ${rootTypeName}.${fieldName}`)
    const owners = [...field.owners].sort()
    /* istanbul ignore next: composition guarantees a root field has an owner */
    if (owners.length === 0) throw new MER_ERR_GQL_GATEWAY_PLANNING(`no subgraph resolves ${rootTypeName}.${fieldName}`)
    if (previousNode && owners.includes(previousNode.graph)) return previousNode.graph
    for (const graph of owners) if (rootByGraph.has(graph)) return graph
    return owners[0]
  }

  /**
   * Replace fragment spreads with inline fragments (recursively), so fetch
   * documents never need fragment definitions.
   */
  inlineFragments (selections, parentTypeName) {
    const result = []
    for (const selection of selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = this.fragments[selection.name.value]
        /* istanbul ignore next: validation rejects unknown fragments */
        if (!fragment) throw new MER_ERR_GQL_GATEWAY_PLANNING(`unknown fragment "${selection.name.value}"`)
        result.push({
          kind: Kind.INLINE_FRAGMENT,
          typeCondition: fragment.typeCondition,
          directives: selection.directives || [],
          selectionSet: fragment.selectionSet
        })
      } else {
        result.push(selection)
      }
    }
    return result
  }

  /**
   * True when `graph` can return every field of `selectionSet` for objects of
   * `typeName` (used for @key / @requires satisfiability).
   */
  graphResolves (selectionSet, typeName, graph) {
    const type = this.typeInfo(typeName)
    for (const selection of selectionSet.selections) {
      /* istanbul ignore next: FieldSets only contain fields */
      if (selection.kind !== Kind.FIELD) continue
      const field = type.fields[selection.name.value]
      if (!field || !field.owners.has(graph)) return false
      if (selection.selectionSet) {
        const nested = getNamedType(this.schema.getType(typeName).getFields()[selection.name.value].type).name
        if (!this.graphResolves(selection.selectionSet, nested, graph)) return false
      }
    }
    return true
  }

  getOrCreateEntityChild (node, graph, typeName, path, key, parentAbstract, representationType = typeName) {
    const mapKey = `${graph}|${typeName}|${representationType}|${path.join('.')}`
    let child = node.childMap.get(mapKey)
    if (!child) {
      child = this.createNode({ graph, operation: 'query', entityType: typeName, path })
      child.keyFields = key.selectionSet
      child.representationType = representationType
      child.parentAbstract = parentAbstract
      node.childMap.set(mapKey, child)
      node.children.push(child)
    }
    return child
  }

  /**
   * Walk `selections` (on objects of `typeName`, produced by `graph`, located at
   * `path`) and return the selections to send to `graph`. Fields `graph`
   * cannot resolve are delegated to entity fetches registered as children of
   * the node that produces the nearest ancestor entity (`frames`).
   *
   * `provided` is a FieldSet selection the parent field @provides, whose fields
   * count as resolvable by `graph` at this position.
   */
  collect (selections, typeName, graph, path, node, provided, positionAbstract = false, parentFrames = [], fieldNode = null) {
    const type = this.typeInfo(typeName)
    const schemaType = this.schema.getType(typeName)
    const abstract = isAbstractType(schemaType)
    const frame = {
      typeName,
      graph,
      path,
      node,
      fieldNode,
      positionAbstract: abstract || positionAbstract,
      keyFieldsToAdd: [],
      needsTypename: abstract
    }
    const frames = [...parentFrames, frame]
    const out = []

    // An @interfaceObject subgraph returns the interface itself (its objects
    // carry the interface name as __typename). Everything it does not own,
    // every concrete fragment, and the real __typename come from a subgraph
    // that defines the interface: one entity hop anchored here.
    const interfaceObjectHere = type.kind === 'INTERFACE' && type.graphs[graph] && type.graphs[graph].isInterfaceObject
    if (interfaceObjectHere) {
      return this.collectInterfaceObject(selections, typeName, graph, path, node, frame)
    }

    for (const selection of this.expandInterfaceFields(this.inlineFragments(selections, typeName), typeName, graph)) {
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        const conditionName = selection.typeCondition ? selection.typeCondition.name.value : typeName
        if (conditionName === typeName) {
          const inner = this.collect(selection.selectionSet.selections, typeName, graph, path, node, provided, positionAbstract, parentFrames, fieldNode)
          addSelection(out, { ...selection, selectionSet: { kind: Kind.SELECTION_SET, selections: inner } })
          continue
        }
        const conditionType = this.typeInfo(conditionName)
        if (conditionType.kind === 'INTERFACE' || conditionType.kind === 'UNION') {
          throw new MER_ERR_GQL_GATEWAY_PLANNING_UNSUPPORTED(`fragment on abstract type "${conditionName}" inside "${typeName}"`)
        }
        if (!conditionType.graphs[graph]) {
          // `graph` never returns objects of this concrete type at this position.
          continue
        }
        frame.needsTypename = true
        // A concrete fragment is its own anchor: hops from inside it are keyed on the concrete type.
        const inner = this.collect(selection.selectionSet.selections, conditionName, graph, path, node, null, true, [], null)
        addSelection(out, { ...selection, selectionSet: { kind: Kind.SELECTION_SET, selections: inner } })
        continue
      }

      /* istanbul ignore next: only fields remain after inlining fragments */
      if (selection.kind !== Kind.FIELD) continue
      const fieldName = selection.name.value
      if (fieldName === '__typename') {
        addSelection(out, selection)
        continue
      }
      const field = type.fields[fieldName]
      /* istanbul ignore next: validation rejects unknown fields */
      if (!field) throw new MER_ERR_GQL_GATEWAY_PLANNING(`unknown field ${typeName}.${fieldName}`)
      const responseKey = selection.alias ? selection.alias.value : fieldName
      const fieldType = schemaType.getFields()[fieldName].type
      const returnTypeName = getNamedType(fieldType).name
      const childPath = this.extendPath(path, responseKey, fieldType)
      const bareField = { ...selection, selectionSet: undefined }

      const providedHere = provided && provided.selections.find(s => s.kind === Kind.FIELD && s.name.value === fieldName)
      const ownedHere = field.owners.has(graph) && !(field.requires[graph] && !providedHere)

      if (ownedHere || providedHere) {
        const nestedProvided = providedHere && providedHere.selectionSet
          ? providedHere.selectionSet
          : (field.provides[graph] ? field.provides[graph].selectionSet : null)
        const inner = selection.selectionSet
          ? this.collect(selection.selectionSet.selections, returnTypeName, graph, childPath, node, nestedProvided, false, frames, bareField)
          : undefined
        addSelection(out, { ...selection, selectionSet: inner ? { kind: Kind.SELECTION_SET, selections: inner } : undefined })
        continue
      }

      if (abstract) {
        throw new MER_ERR_GQL_GATEWAY_PLANNING_UNSUPPORTED(`field "${fieldName}" of abstract type "${typeName}" is not resolved by subgraph "${graph}"`)
      }

      // Entity hop: another subgraph resolves this field. Anchor the fetch on
      // the nearest enclosing type for which the owner accepts a key we can
      // build: this type itself, or an ancestor when this is a keyless value
      // type nested inside an entity.
      const { frameIndex, steps } = this.findHop(frames, field, typeName)
      const { graph: owner } = steps[steps.length - 1]
      const key = steps[0].key
      const anchor = frames[frameIndex]
      let parent = anchor.node
      const requires = field.requires[owner]
      if (requires) {
        if (anchor !== frame) {
          throw new MER_ERR_GQL_GATEWAY_PLANNING_UNSUPPORTED(`@requires on ${typeName}.${fieldName} nested inside a value type`)
        }
        // Required fields must be present on the parent objects first. Collect
        // them from `graph`; anything `graph` cannot resolve becomes a child
        // fetch that the requiring fetch must wait for.
        const requiredSelections = this.collect(requires.selectionSet.selections, typeName, graph, path, node, null, positionAbstract, parentFrames, fieldNode)
        for (const s of requiredSelections) addSelection(out, s)
        // The requiring fetch must run after the fetch(es) that supply the
        // required fields: attach it under the last child at this position
        // that selects one of them (that child may pre-date this field).
        const requiredNames = new Set(requires.selectionSet.selections.map(s => s.name.value))
        const supplier = node.children.filter(child =>
          child.path.join('.') === path.join('.') &&
          child.selections.some(s => s.kind === Kind.FIELD && requiredNames.has(s.name.value))
        ).pop()
        if (supplier) parent = supplier
      }
      anchor.needsTypename = true
      if (!anchor.keyFieldsToAdd.includes(key)) anchor.keyFieldsToAdd.push(key)

      // Bridge hops: each intermediate fetch pulls the key the next one needs.
      for (let i = 0; i < steps.length - 1; i++) {
        const step = steps[i]
        const bridge = this.getOrCreateEntityChild(parent, step.graph, anchor.typeName, anchor.path, step.key, anchor.positionAbstract, step.representationType)
        for (const selection of steps[i + 1].key.selectionSet.selections) addSelection(bridge.selections, this.stripLoc(selection))
        parent = bridge
      }
      const last = steps[steps.length - 1]
      const child = this.getOrCreateEntityChild(parent, owner, anchor.typeName, anchor.path, last.key, anchor.positionAbstract, last.representationType)
      if (requires && !child.requires.includes(requires.selectionSet)) child.requires.push(requires.selectionSet)
      const inner = selection.selectionSet
        ? this.collect(selection.selectionSet.selections, returnTypeName, owner, childPath, child, field.provides[owner] ? field.provides[owner].selectionSet : null, false, [], null)
        : undefined
      let hopped = { ...selection, selectionSet: inner ? { kind: Kind.SELECTION_SET, selections: inner } : undefined }
      // Re-root the selection under the chain of fields leading from the anchor here.
      for (let i = frames.length - 1; i > frameIndex; i--) {
        hopped = { ...frames[i].fieldNode, selectionSet: { kind: Kind.SELECTION_SET, selections: [hopped] } }
      }
      addSelection(child.selections, hopped)
    }

    if (frame.needsTypename && !out.some(s => s.kind === Kind.FIELD && s.name.value === '__typename' && !s.alias)) {
      out.push(typenameField())
    }
    for (const key of frame.keyFieldsToAdd) {
      for (const selection of key.selectionSet.selections) {
        addSelection(out, this.stripLoc(selection))
      }
    }

    return out
  }

  /**
   * On an interface position, a field `graph` does not resolve on the interface
   * is rewritten as `... on Impl { field }` for every implementation `graph`
   * can return, so the concrete entity logic takes over.
   */
  expandInterfaceFields (selections, typeName, graph) {
    const type = this.typeInfo(typeName)
    if (type.kind !== 'INTERFACE') return selections
    const result = []
    for (const selection of selections) {
      if (selection.kind !== Kind.FIELD || selection.name.value === '__typename') {
        result.push(selection)
        continue
      }
      const field = type.fields[selection.name.value]
      if (!field || field.owners.has(graph)) {
        result.push(selection)
        continue
      }
      const implementations = Object.values(this.index.types)
        .filter(t => t.kind === 'OBJECT' && t.interfaces.includes(typeName) && t.graphs[graph])
      for (const impl of implementations) {
        result.push({
          kind: Kind.INLINE_FRAGMENT,
          typeCondition: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: impl.name } },
          directives: [],
          selectionSet: { kind: Kind.SELECTION_SET, selections: [selection] }
        })
      }
    }
    return result
  }

  /**
   * Selections on an interface returned by an @interfaceObject subgraph.
   */
  collectInterfaceObject (selections, typeName, graph, path, node, frame) {
    const type = this.typeInfo(typeName)
    const local = []
    const remote = [typenameField()]
    for (const selection of this.inlineFragments(selections, typeName)) {
      if (selection.kind === Kind.FIELD && selection.name.value !== '__typename' && type.fields[selection.name.value] && type.fields[selection.name.value].owners.has(graph)) {
        local.push(selection)
      } else {
        remote.push(selection)
      }
    }

    // Target: a subgraph that defines the interface for real, reachable by a key this subgraph can build.
    let target = null
    for (const [candidate, entry] of Object.entries(type.graphs).sort()) {
      if (entry.isInterfaceObject) continue
      const key = entry.keys.find(k => k.resolvable !== false && this.graphResolves(k.selectionSet, typeName, graph))
      if (key) {
        target = { graph: candidate, key }
        break
      }
    }
    if (!target) {
      throw new MER_ERR_GQL_GATEWAY_PLANNING_UNSUPPORTED(`no subgraph can resolve the concrete type of interface "${typeName}" returned by "${graph}"`)
    }

    const child = this.getOrCreateEntityChild(node, target.graph, typeName, path, target.key, true, typeName)
    const inner = this.collect(remote, typeName, target.graph, path, child, null, false, [], null)
    for (const selection of inner) addSelection(child.selections, selection)

    const out = []
    for (const selection of local) {
      const field = type.fields[selection.name.value]
      const fieldType = this.schema.getType(typeName).getFields()[selection.name.value].type
      const returnTypeName = getNamedType(fieldType).name
      const responseKey = selection.alias ? selection.alias.value : selection.name.value
      const nested = selection.selectionSet
        ? this.collect(selection.selectionSet.selections, returnTypeName, graph, this.extendPath(path, responseKey, fieldType), node, field.provides[graph] ? field.provides[graph].selectionSet : null, false, [], null)
        : undefined
      addSelection(out, { ...selection, selectionSet: nested ? { kind: Kind.SELECTION_SET, selections: nested } : undefined })
    }
    out.push(typenameField())
    for (const selection of target.key.selectionSet.selections) addSelection(out, this.stripLoc(selection))
    return out
  }

  /**
   * Find where to anchor the entity fetch for `field` (of `typeName`, the last
   * frame) and how to get there: the innermost frame from whose subgraph an
   * owner of the field is reachable through a chain of @key hops (a direct hop
   * when the owner accepts a key the frame's subgraph can build, otherwise a
   * bridge through subgraphs that can translate between keys). The owner must
   * also resolve every intermediate field between the frame and `field`.
   *
   * Returns { frameIndex, steps } where each step is { graph, key, representationType }.
   */
  findHop (frames, field, typeName) {
    const candidates = [...field.owners].sort()
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i]
      const owners = candidates.filter(graph => this.ownsChain(frames, i, graph))
      const steps = this.findKeyPath(frame, owners)
      if (steps) return { frameIndex: i, steps }
    }
    const current = frames[frames.length - 1]
    const reason = candidates.length === 0
      ? `no subgraph resolves ${typeName}.${field.name}`
      : `${typeName}.${field.name} is resolved by ${candidates.join(', ')} but no chain of @key hops leads there from subgraph "${current.graph}"`
    throw new MER_ERR_GQL_GATEWAY_PLANNING_UNSUPPORTED(reason)
  }

  /**
   * Breadth-first search over subgraphs defining `frame.typeName`: an edge
   * X → Y exists when Y has a resolvable @key whose fields X can return.
   * Prefers a subgraph that already has an entity fetch at this position.
   */
  findKeyPath (frame, owners) {
    if (owners.length === 0) return null
    const type = this.typeInfo(frame.typeName)
    const pathKey = frame.path.join('.')
    const stepTo = (from, graph) => {
      const entry = type.graphs[graph]
      if (!entry) return null
      const key = entry.keys.find(k => k.resolvable !== false && this.graphResolves(k.selectionSet, frame.typeName, from))
      if (!key) return null
      const representationType = entry.isInterfaceObject
        ? type.interfaces.find(name => {
          const iface = this.index.types[name]
          return iface && iface.graphs[graph] && iface.graphs[graph].isInterfaceObject
        }) || frame.typeName
        : frame.typeName
      return { graph, key, representationType }
    }

    // direct hops first, preferring an existing fetch at this position
    const direct = owners.map(graph => stepTo(frame.graph, graph)).filter(Boolean)
    if (direct.length > 0) {
      const existing = direct.find(step => frame.node.childMap.has(`${step.graph}|${frame.typeName}|${step.representationType}|${pathKey}`))
      return [existing || direct[0]]
    }

    const graphs = Object.keys(type.graphs).sort()
    const visited = new Set([frame.graph])
    const queue = [{ graph: frame.graph, steps: [] }]
    while (queue.length > 0) {
      const { graph: from, steps } = queue.shift()
      for (const graph of graphs) {
        if (visited.has(graph)) continue
        const step = stepTo(from, graph)
        if (!step) continue
        const next = [...steps, step]
        if (owners.includes(graph)) return next
        visited.add(graph)
        queue.push({ graph, steps: next })
      }
    }
    return null
  }

  /**
   * Can `graph` resolve every field on the chain from frames[from] down to the
   * last frame (the intermediate value-type fields)?
   */
  ownsChain (frames, from, graph) {
    for (let i = from + 1; i < frames.length; i++) {
      const parentType = this.typeInfo(frames[i - 1].typeName)
      const field = parentType.fields[frames[i].fieldNode.name.value]
      if (!field || !field.owners.has(graph)) return false
    }
    return true
  }

  stripLoc (node) {
    return JSON.parse(JSON.stringify(node, (k, v) => (k === 'loc' ? undefined : v)))
  }

  finalize (node) {
    node.variableNames = collectVariableNames(node.selections)
    node.variableDefinitions = (this.operation.variableDefinitions || []).filter(
      def => node.variableNames.has(def.variable.name.value)
    )
    if (node.entityType === null) {
      const name = this.operation.name
        ? this.operation.name.value
        : `Query_${node.responseKeys.join('_')}`
      node.documentNode = buildRootDocument({
        operation: node.operation,
        name,
        selections: node.selections,
        variableDefinitions: node.variableDefinitions
      })
    } else {
      node.documentNode = buildEntityDocument({
        typeName: node.representationType || node.entityType,
        selections: node.selections,
        variableDefinitions: node.variableDefinitions
      })
    }
    node.document = print(node.documentNode)
    delete node.childMap
    for (const child of node.children) this.finalize(child)
  }
}

function buildQueryPlan ({ schema, planIndex, operation, fragments, options }) {
  return new PlanBuilder({ schema, planIndex, operation, fragments, options }).build()
}

/**
 * Build the `_entities` representation for one parent object.
 */
function buildRepresentation (object, node) {
  const representation = { __typename: node.representationType || node.entityType }
  if (!satisfiedBy(object, node.keyFields)) return null
  Object.assign(representation, pickFields(object, node.keyFields))
  for (const requires of node.requires) {
    Object.assign(representation, pickFields(object, requires))
  }
  return representation
}

function pickFields (object, selectionSet) {
  const { pick } = require('../compose/field-set')
  return pick(object, selectionSet)
}

module.exports = { buildQueryPlan, buildRepresentation, fieldNode }
