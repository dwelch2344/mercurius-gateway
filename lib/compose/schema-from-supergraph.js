'use strict'

const { Kind, print, buildASTSchema, GraphQLSchema, isSpecifiedDirective } = require('graphql')
const { transformSupergraphToPublicSchema } = require('@theguild/federation-composition')
const { MER_ERR_GQL_GATEWAY_DUPLICATE_DIRECTIVE } = require('../errors')

// Directives that belong to the federation / link specs and must never be
// copied from a subgraph SDL into the gateway schema.
const SPEC_DIRECTIVES = new Set([
  'key', 'requires', 'provides', 'external', 'extends', 'shareable', 'override',
  'inaccessible', 'tag', 'interfaceObject', 'composeDirective', 'link',
  'authenticated', 'requiresScopes', 'policy', 'context', 'fromContext',
  'cost', 'listSize'
])

function isSpecDirective (name) {
  return SPEC_DIRECTIVES.has(name) || name.startsWith('federation__') || name.startsWith('link__') || name.startsWith('join__')
}

/**
 * Custom directive definitions declared by subgraphs. Federation 1 subgraphs
 * cannot @composeDirective, and the previous (v1) gateway exposed every custom
 * directive definition it found in a subgraph; keep that behaviour so client
 * tooling that introspects directives keeps working.
 *
 * Definitions with the same name must be identical across subgraphs.
 */
function collectCustomDirectiveDefinitions (subgraphDocuments, alreadyDefined) {
  const definitions = []
  const seen = new Map(alreadyDefined.map(d => [d.name.value, print(d)]))

  for (const { document } of subgraphDocuments) {
    for (const definition of document.definitions) {
      if (definition.kind !== Kind.DIRECTIVE_DEFINITION) continue
      const name = definition.name.value
      if (isSpecDirective(name)) continue
      const printed = print(definition)
      if (seen.has(name)) {
        if (seen.get(name) !== printed) {
          throw new MER_ERR_GQL_GATEWAY_DUPLICATE_DIRECTIVE(name)
        }
        continue
      }
      seen.set(name, printed)
      definitions.push(definition)
    }
  }

  return definitions
}

/**
 * Build the executable gateway schema from a supergraph document:
 *  - strip join__/link__ machinery and everything marked @inaccessible
 *    (delegated to the composition library's public-schema transform);
 *  - re-add custom directive definitions declared by the subgraphs.
 *
 * Resolvers are attached later by the planner adapter.
 */
function schemaFromSupergraph (supergraphDocument, { subgraphDocuments = [] } = {}) {
  const publicDocument = transformSupergraphToPublicSchema(supergraphDocument)
  const existingDirectives = publicDocument.definitions.filter(d => d.kind === Kind.DIRECTIVE_DEFINITION)
  const customDirectives = collectCustomDirectiveDefinitions(subgraphDocuments, existingDirectives)

  const document = customDirectives.length === 0
    ? publicDocument
    : { ...publicDocument, definitions: [...customDirectives, ...publicDocument.definitions] }

  const built = buildASTSchema(document, { assumeValidSDL: true })
  const config = built.toConfig()
  const schema = new GraphQLSchema({
    ...config,
    directives: [
      ...config.directives.filter(d => isSpecifiedDirective(d)),
      ...config.directives.filter(d => !isSpecifiedDirective(d))
    ]
  })

  return { schema, publicDocument: document, publicSdl: print(document) }
}

module.exports = { schemaFromSupergraph, isSpecDirective }
