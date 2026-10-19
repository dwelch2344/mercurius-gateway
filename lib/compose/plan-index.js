'use strict'

const { Kind } = require('graphql')
const { parseFieldSet, printFieldSet } = require('./field-set')

const JOIN_GRAPH = 'join__graph'
const JOIN_TYPE = 'join__type'
const JOIN_FIELD = 'join__field'
const JOIN_IMPLEMENTS = 'join__implements'
const JOIN_UNION_MEMBER = 'join__unionMember'
const JOIN_ENUM_VALUE = 'join__enumValue'
const INACCESSIBLE = 'inaccessible'

const KIND_BY_NODE = {
  [Kind.OBJECT_TYPE_DEFINITION]: 'OBJECT',
  [Kind.INTERFACE_TYPE_DEFINITION]: 'INTERFACE',
  [Kind.UNION_TYPE_DEFINITION]: 'UNION',
  [Kind.ENUM_TYPE_DEFINITION]: 'ENUM',
  [Kind.INPUT_OBJECT_TYPE_DEFINITION]: 'INPUT_OBJECT',
  [Kind.SCALAR_TYPE_DEFINITION]: 'SCALAR'
}

function directivesNamed (node, name) {
  return (node.directives || []).filter(d => d.name.value === name)
}

function argValue (directive, name) {
  const arg = (directive.arguments || []).find(a => a.name.value === name)
  if (!arg) return undefined
  switch (arg.value.kind) {
    case Kind.STRING:
    case Kind.ENUM:
      return arg.value.value
    case Kind.BOOLEAN:
      return arg.value.value
    /* istanbul ignore next: join__ directives only use string/enum/boolean args */
    default:
      return undefined
  }
}

function hasDirective (node, name) {
  return directivesNamed(node, name).length > 0
}

function fieldSetEntry (fields) {
  const selectionSet = parseFieldSet(fields)
  return { fields: printFieldSet(selectionSet), selectionSet }
}

/**
 * Build the PlanIndex from a supergraph document (join spec v0.3).
 *
 * The index answers, for the planner:
 *  - which subgraphs ("graphs") exist and how they are named;
 *  - for each type: which graphs define it, with which keys, whether it is an
 *    interface object / extension / resolvable there;
 *  - for each field: which graphs can resolve it (owners), where it is external,
 *    its @requires / @provides selections per graph, @override information;
 *  - interface implementations and union memberships per graph;
 *  - @inaccessible flags (the executable schema strips them; the planner still
 *    needs them to avoid selecting hidden key fields).
 */
function buildPlanIndex (supergraphDocument) {
  const index = {
    graphs: {},
    graphByEnum: {},
    types: {}
  }

  // Pass 1: graphs
  for (const definition of supergraphDocument.definitions) {
    if (definition.kind === Kind.ENUM_TYPE_DEFINITION && definition.name.value === 'join__Graph') {
      for (const value of definition.values || []) {
        const [graphDirective] = directivesNamed(value, JOIN_GRAPH)
        /* istanbul ignore next: composition always annotates join__Graph values */
        if (!graphDirective) continue
        const name = argValue(graphDirective, 'name')
        const enumValue = value.name.value
        index.graphs[name] = { name, enumValue, url: argValue(graphDirective, 'url') || '' }
        index.graphByEnum[enumValue] = name
      }
    }
  }

  const graphName = enumValue => {
    const name = index.graphByEnum[enumValue]
    /* istanbul ignore next: a supergraph always declares every graph it references */
    if (!name) throw new Error(`Unknown join__Graph value "${enumValue}"`)
    return name
  }

  // Pass 2: types
  for (const definition of supergraphDocument.definitions) {
    const kind = KIND_BY_NODE[definition.kind]
    if (!kind) continue
    const typeName = definition.name.value
    if (typeName.startsWith('join__') || typeName.startsWith('link__')) continue

    const type = {
      name: typeName,
      kind,
      graphs: {},
      interfaces: (definition.interfaces || []).map(i => i.name.value),
      implementsIn: {},
      members: {},
      fields: {},
      inaccessible: hasDirective(definition, INACCESSIBLE)
    }

    for (const joinType of directivesNamed(definition, JOIN_TYPE)) {
      const graph = graphName(argValue(joinType, 'graph'))
      const entry = type.graphs[graph] || (type.graphs[graph] = {
        keys: [],
        resolvable: true,
        isInterfaceObject: false,
        extension: false
      })
      const key = argValue(joinType, 'key')
      if (key !== undefined) {
        const keyEntry = fieldSetEntry(key)
        if (!entry.keys.some(k => k.fields === keyEntry.fields)) {
          entry.keys.push(keyEntry)
        }
        const resolvable = argValue(joinType, 'resolvable')
        if (resolvable === false) {
          keyEntry.resolvable = false
        } else {
          keyEntry.resolvable = true
        }
      }
      if (argValue(joinType, 'isInterfaceObject') === true) entry.isInterfaceObject = true
      if (argValue(joinType, 'extension') === true) entry.extension = true
    }
    for (const graphEntry of Object.values(type.graphs)) {
      graphEntry.resolvable = graphEntry.keys.length === 0 || graphEntry.keys.some(k => k.resolvable)
    }

    for (const impl of directivesNamed(definition, JOIN_IMPLEMENTS)) {
      const graph = graphName(argValue(impl, 'graph'))
      const iface = argValue(impl, 'interface')
      ;(type.implementsIn[graph] || (type.implementsIn[graph] = [])).push(iface)
    }

    for (const member of directivesNamed(definition, JOIN_UNION_MEMBER)) {
      const graph = graphName(argValue(member, 'graph'))
      const memberName = argValue(member, 'member')
      ;(type.members[memberName] || (type.members[memberName] = new Set())).add(graph)
    }
    if (kind === 'UNION') {
      for (const memberType of definition.types || []) {
        if (!type.members[memberType.name.value]) type.members[memberType.name.value] = new Set()
      }
    }

    if (kind === 'ENUM') {
      type.values = {}
      for (const value of definition.values || []) {
        const graphs = new Set(directivesNamed(value, JOIN_ENUM_VALUE).map(d => graphName(argValue(d, 'graph'))))
        type.values[value.name.value] = {
          graphs: graphs.size > 0 ? graphs : new Set(Object.keys(type.graphs)),
          inaccessible: hasDirective(value, INACCESSIBLE)
        }
      }
    }

    const allGraphs = Object.keys(type.graphs)
    for (const fieldNode of definition.fields || []) {
      const fieldName = fieldNode.name.value
      const field = {
        name: fieldName,
        owners: new Set(),
        external: new Set(),
        requires: {},
        provides: {},
        overrideFrom: null,
        overridingGraph: null,
        viaInterfaceObject: false,
        inaccessible: hasDirective(fieldNode, INACCESSIBLE),
        arguments: (fieldNode.arguments || []).map(a => a.name.value)
      }
      const joinFields = directivesNamed(fieldNode, JOIN_FIELD)
      if (joinFields.length === 0) {
        // No @join__field: every graph defining the type resolves the field.
        for (const graph of allGraphs) field.owners.add(graph)
      } else {
        for (const joinField of joinFields) {
          const graphEnum = argValue(joinField, 'graph')
          if (graphEnum === undefined) {
            // Bare @join__field: the field is contributed through an
            // @interfaceObject on another graph; no graph resolves it on this
            // concrete type directly.
            field.viaInterfaceObject = true
            continue
          }
          const graph = graphName(graphEnum)
          if (argValue(joinField, 'external') === true) {
            field.external.add(graph)
          } else {
            field.owners.add(graph)
          }
          const requires = argValue(joinField, 'requires')
          if (requires !== undefined) field.requires[graph] = fieldSetEntry(requires)
          const provides = argValue(joinField, 'provides')
          if (provides !== undefined) field.provides[graph] = fieldSetEntry(provides)
          const override = argValue(joinField, 'override')
          if (override !== undefined) {
            field.overrideFrom = override
            field.overridingGraph = graph
          }
        }
      }
      type.fields[fieldName] = field
    }

    index.types[typeName] = type
  }

  // Pass 3: interface-object contributions. A field of interface I that graph G
  // resolves through @interfaceObject is resolvable for every implementation of I
  // in G, using I as the representation typename.
  for (const type of Object.values(index.types)) {
    if (type.kind !== 'INTERFACE') continue
    const interfaceObjectGraphs = Object.entries(type.graphs)
      .filter(([, entry]) => entry.isInterfaceObject)
      .map(([graph]) => graph)
    if (interfaceObjectGraphs.length === 0) continue
    for (const impl of Object.values(index.types)) {
      if (impl.kind !== 'OBJECT' || !impl.interfaces.includes(type.name)) continue
      for (const graph of interfaceObjectGraphs) {
        if (!impl.graphs[graph]) {
          impl.graphs[graph] = {
            keys: type.graphs[graph].keys,
            resolvable: type.graphs[graph].resolvable,
            isInterfaceObject: true,
            extension: false
          }
        }
        for (const [fieldName, ifaceField] of Object.entries(type.fields)) {
          if (!ifaceField.owners.has(graph)) continue
          const field = impl.fields[fieldName]
          /* istanbul ignore next: composition guarantees implementations carry interface fields */
          if (!field) continue
          field.owners.add(graph)
          field.viaInterfaceObject = true
          if (ifaceField.requires[graph]) field.requires[graph] = ifaceField.requires[graph]
          if (ifaceField.provides[graph]) field.provides[graph] = ifaceField.provides[graph]
        }
      }
    }
  }

  return index
}

module.exports = { buildPlanIndex }
