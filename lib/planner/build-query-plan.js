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

  getOrCreateEntityChild (node, graph, typeName, path, key, parentAbstract) {
    const mapKey = `${graph}|${typeName}|${path.join('.')}`
    let child = node.childMap.get(mapKey)
    if (!child) {
      child = this.createNode({ graph, operation: 'query', entityType: typeName, path })
      child.keyFields = key.selectionSet
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

    for (const selection of this.inlineFragments(selections, typeName)) {
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
      const hop = this.findHop(frames, field, typeName)
      const { frameIndex, graph: owner, key } = hop
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
        const before = node.children.length
        const requiredSelections = this.collect(requires.selectionSet.selections, typeName, graph, path, node, null, positionAbstract, parentFrames, fieldNode)
        for (const s of requiredSelections) addSelection(out, s)
        if (node.children.length > before) {
          parent = node.children[node.children.length - 1]
        }
      }
      anchor.needsTypename = true
      if (!anchor.keyFieldsToAdd.includes(key)) anchor.keyFieldsToAdd.push(key)

      const child = this.getOrCreateEntityChild(parent, owner, anchor.typeName, anchor.path, key, anchor.positionAbstract)
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
   * Find where to anchor the entity fetch for `field` (of `typeName`, the last
   * frame): the innermost frame whose type the field's owner can resolve by a
   * key buildable from that frame's subgraph, and through which the owner can
   * reach the field (it must resolve every intermediate field).
   */
  findHop (frames, field, typeName) {
    const candidates = [...field.owners].sort()
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i]
      const frameType = this.typeInfo(frame.typeName)
      const pathKey = frame.path.join('.')
      const usable = []
      for (const graph of candidates) {
        const graphEntry = frameType.graphs[graph]
        if (!graphEntry) continue
        if (!this.ownsChain(frames, i, graph)) continue
        const key = graphEntry.keys.find(k => k.resolvable !== false && this.graphResolves(k.selectionSet, frame.typeName, frame.graph))
        if (key) usable.push({ frameIndex: i, graph, key })
      }
      if (usable.length === 0) continue
      const existing = usable.find(({ graph }) => frame.node.childMap.has(`${graph}|${frame.typeName}|${pathKey}`))
      return existing || usable[0]
    }
    const current = frames[frames.length - 1]
    const reason = candidates.length === 0
      ? `no subgraph resolves ${typeName}.${field.name}`
      : `${typeName}.${field.name} is resolved by ${candidates.join(', ')} but none of their keys can be built from subgraph "${current.graph}" (multi-hop key bridging is not implemented yet)`
    throw new MER_ERR_GQL_GATEWAY_PLANNING_UNSUPPORTED(reason)
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
        typeName: node.entityType,
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
  const representation = { __typename: node.entityType }
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
