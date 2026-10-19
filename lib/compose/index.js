'use strict'

const { parse, print, Kind } = require('graphql')
const {
  composeServices,
  compositionHasErrors
} = require('@theguild/federation-composition')
const { buildPlanIndex } = require('./plan-index')
const { schemaFromSupergraph } = require('./schema-from-supergraph')
const { compositionError, MER_ERR_GQL_GATEWAY_COMPOSITION } = require('./errors')

const FEDERATION_SPEC_PREFIX = 'https://specs.apollo.dev/federation/v'

function toDocument (schemaDefinition) {
  if (typeof schemaDefinition === 'string') {
    return parse(schemaDefinition)
  }
  /* istanbul ignore else: callers pass either SDL strings or DocumentNodes */
  if (schemaDefinition && schemaDefinition.kind === Kind.DOCUMENT) {
    return schemaDefinition
  }
  /* istanbul ignore next */
  throw new MER_ERR_GQL_GATEWAY_COMPOSITION('service schema must be an SDL string or a DocumentNode')
}

/**
 * A supergraph document always declares the `join__Graph` enum.
 */
function isSupergraphDocument (document) {
  return document.definitions.some(
    d => d.kind === Kind.ENUM_TYPE_DEFINITION && d.name.value === 'join__Graph'
  )
}

/**
 * Federation version of a subgraph document: 2 when a schema-level @link to the
 * federation spec is present, otherwise 1.
 */
function detectFederationVersion (document) {
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.SCHEMA_DEFINITION && definition.kind !== Kind.SCHEMA_EXTENSION) continue
    for (const directive of definition.directives || []) {
      if (directive.name.value !== 'link') continue
      const url = (directive.arguments || []).find(a => a.name.value === 'url')
      if (url && url.value.kind === Kind.STRING && url.value.value.startsWith(FEDERATION_SPEC_PREFIX)) {
        return 2
      }
    }
  }
  return 1
}

/**
 * Compose subgraph SDLs into a supergraph and derive everything the gateway
 * needs from it.
 *
 * @param {Object} input
 * @param {Array<{ name: string, url?: string, schemaDefinition: string|DocumentNode }>} [input.services]
 * @param {string|DocumentNode} [input.supergraphSdl] a precomposed supergraph (Rover, Hive, this library)
 * @returns {{ schema, planIndex, supergraphSdl, supergraphDocument, publicSdl, federationVersions }}
 */
function composeSupergraph ({ services, supergraphSdl } = {}) {
  let supergraphDocument
  let subgraphDocuments = []
  const federationVersions = {}

  if (supergraphSdl !== undefined && supergraphSdl !== null) {
    supergraphDocument = toDocument(supergraphSdl)
    if (!isSupergraphDocument(supergraphDocument)) {
      throw new MER_ERR_GQL_GATEWAY_COMPOSITION('"supergraphSdl" is not a supergraph (missing join spec)')
    }
  } else if (Array.isArray(services) && services.length > 0) {
    subgraphDocuments = services.map(service => {
      const document = toDocument(service.schemaDefinition)
      federationVersions[service.name] = detectFederationVersion(document)
      return { name: service.name, url: service.url, document }
    })

    const result = composeServices(subgraphDocuments.map(({ name, url, document }) => ({
      name,
      url,
      typeDefs: document
    })))

    if (compositionHasErrors(result)) {
      throw compositionError(result.errors)
    }
    supergraphDocument = result.supergraphDocumentNode
  } else {
    throw new MER_ERR_GQL_GATEWAY_COMPOSITION('either "services" or "supergraphSdl" is required')
  }

  const planIndex = buildPlanIndex(supergraphDocument)
  const { schema, publicSdl } = schemaFromSupergraph(supergraphDocument, { subgraphDocuments })

  return {
    schema,
    planIndex,
    supergraphDocument,
    supergraphSdl: typeof supergraphSdl === 'string' ? supergraphSdl : print(supergraphDocument),
    publicSdl,
    federationVersions
  }
}

module.exports = {
  composeSupergraph,
  detectFederationVersion,
  buildPlanIndex,
  schemaFromSupergraph,
  MER_ERR_GQL_GATEWAY_COMPOSITION
}
