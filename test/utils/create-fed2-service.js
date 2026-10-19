'use strict'

const Fastify = require('fastify')
const GQL = require('mercurius')
const { buildFederationSchema } = require('@mercuriusjs/federation')

/**
 * Start a federated subgraph for tests. Every request body is recorded on the
 * returned `requests` array so tests can assert which subgraph was asked what.
 */
async function createFed2Service (t, schema, resolvers = {}, opts = {}) {
  const service = Fastify()
  const requests = []
  service.addHook('preHandler', async (req) => {
    if (Array.isArray(req.body)) requests.push(req.body)
    else if (req.body && req.body.query && !req.body.query.includes('_service')) requests.push(req.body)
  })
  service.register(GQL, {
    schema: buildFederationSchema(schema),
    resolvers,
    ...opts
  })
  await service.listen({ port: 0 })
  if (t) t.after(() => service.close())
  return { service, port: service.server.address().port, requests, url: `http://localhost:${service.server.address().port}/graphql` }
}

module.exports = { createFed2Service }
