'use strict'

const { Kind, print, visit } = require('graphql')

function nameNode (value) {
  return { kind: Kind.NAME, value }
}

function fieldNode (name, selections) {
  const node = { kind: Kind.FIELD, name: nameNode(name), arguments: [], directives: [] }
  if (selections) {
    node.selectionSet = { kind: Kind.SELECTION_SET, selections }
  }
  return node
}

function typenameField () {
  return fieldNode('__typename')
}

/**
 * Variable names referenced anywhere inside the given selections (arguments,
 * nested input objects/lists, directives).
 */
function collectVariableNames (selections, acc = new Set()) {
  visit({ kind: Kind.SELECTION_SET, selections }, {
    Variable (node) {
      acc.add(node.name.value)
    }
  })
  return acc
}

const REPRESENTATIONS_VARIABLE = {
  kind: Kind.VARIABLE_DEFINITION,
  variable: { kind: Kind.VARIABLE, name: nameNode('representations') },
  type: {
    kind: Kind.NON_NULL_TYPE,
    type: {
      kind: Kind.LIST_TYPE,
      type: { kind: Kind.NON_NULL_TYPE, type: { kind: Kind.NAMED_TYPE, name: nameNode('_Any') } }
    }
  },
  directives: []
}

/**
 * Root fetch: `<operation> <Name>($vars) { ...selections }`.
 */
function buildRootDocument ({ operation, name, selections, variableDefinitions }) {
  return {
    kind: Kind.DOCUMENT,
    definitions: [
      {
        kind: Kind.OPERATION_DEFINITION,
        operation,
        name: nameNode(name),
        variableDefinitions,
        directives: [],
        selectionSet: { kind: Kind.SELECTION_SET, selections }
      }
    ]
  }
}

/**
 * Entity fetch: `query EntitiesQuery($representations: [_Any!]!, $vars) {
 *   _entities(representations: $representations) { __typename ... on T { ...selections } }
 * }`
 */
function buildEntityDocument ({ typeName, selections, variableDefinitions }) {
  return {
    kind: Kind.DOCUMENT,
    definitions: [
      {
        kind: Kind.OPERATION_DEFINITION,
        operation: 'query',
        name: nameNode('EntitiesQuery'),
        variableDefinitions: [REPRESENTATIONS_VARIABLE, ...variableDefinitions],
        directives: [],
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [
            {
              kind: Kind.FIELD,
              name: nameNode('_entities'),
              arguments: [
                {
                  kind: Kind.ARGUMENT,
                  name: nameNode('representations'),
                  value: { kind: Kind.VARIABLE, name: nameNode('representations') }
                }
              ],
              directives: [],
              selectionSet: {
                kind: Kind.SELECTION_SET,
                selections: [
                  typenameField(),
                  {
                    kind: Kind.INLINE_FRAGMENT,
                    typeCondition: { kind: Kind.NAMED_TYPE, name: nameNode(typeName) },
                    directives: [],
                    selectionSet: { kind: Kind.SELECTION_SET, selections }
                  }
                ]
              }
            }
          ]
        }
      }
    ]
  }
}

module.exports = {
  nameNode,
  fieldNode,
  typenameField,
  collectVariableNames,
  buildRootDocument,
  buildEntityDocument,
  print
}
