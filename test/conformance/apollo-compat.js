'use strict'

// Gateway-side counterpart of the Apollo Federation subgraph compatibility
// suite: the suite exercises a subgraph through Apollo Router; here the same
// three subgraphs are composed by this gateway and the router-level queries of
// the suite (plus a few that cross every subgraph) are run against it.

const { test, before, after } = require('node:test')
const Fastify = require('fastify')
const plugin = require('../../index')
const { createFed2Service } = require('../utils/create-fed2-service')
const { productsSubgraph, usersSubgraph, inventorySubgraph, user } = require('./fixtures')

let gateway
let services

before(async () => {
  services = {
    products: await createFed2Service(null, productsSubgraph.schema, productsSubgraph.resolvers),
    users: await createFed2Service(null, usersSubgraph.schema, usersSubgraph.resolvers),
    inventory: await createFed2Service(null, inventorySubgraph.schema, inventorySubgraph.resolvers)
  }
  gateway = Fastify()
  await gateway.register(plugin, {
    gateway: {
      services: Object.entries(services).map(([name, { url }]) => ({ name, url }))
    }
  })
  await gateway.ready()
})

after(async () => {
  await gateway.close()
  for (const { service } of Object.values(services)) await service.close()
})

async function query (source, variables) {
  const res = await gateway.inject({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    url: '/graphql',
    body: JSON.stringify({ query: source, variables })
  })
  return JSON.parse(res.body)
}

test('composition: supergraph lists the three subgraphs; @inaccessible and @tag are not in the API schema; @composeDirective keeps @custom', t => {
  const { planIndex, schema, publicSdl } = gateway.graphqlGateway
  t.assert.deepStrictEqual(Object.keys(planIndex.graphs).sort(), ['inventory', 'products', 'users'])
  t.assert.strictEqual(schema.getType('ProductDimension').getFields().unit, undefined)
  t.assert.doesNotMatch(publicSdl, /@tag/)
  t.assert.ok(schema.getDirective('custom'))
  t.assert.match(publicSdl, /type Product implements .*@custom|type Product @custom/)
  t.assert.strictEqual(schema.getType('Inventory').constructor.name, 'GraphQLInterfaceType')
})

test('@shareable: ProductDimension resolves through products', async t => {
  const resp = await query('query GetProduct($id: ID!) { product(id: $id) { dimensions { size weight } } }', { id: 'apollo-federation' })
  t.assert.deepStrictEqual(resp, { data: { product: { dimensions: { size: 'small', weight: 1 } } } })
})

test('@override: User.name comes from products, not users', async t => {
  const resp = await query('query GetProduct($id: ID!) { product(id: $id) { createdBy { name } } }', { id: 'apollo-federation' })
  t.assert.deepStrictEqual(resp, { data: { product: { createdBy: { name: 'Jane Smith' } } } })
  t.assert.ok(!services.users.requests.some(r => /\bname\b/.test(r.query)))
})

test('@requires: averageProductsCreatedPerYear is computed from @provides and users data', async t => {
  const resp = await query('query ($id: ID!) { product(id: $id) { createdBy { averageProductsCreatedPerYear email } } }', { id: 'apollo-federation' })
  t.assert.deepStrictEqual(resp, { data: { product: { createdBy: { averageProductsCreatedPerYear: 134, email: user.email } } } })
  const representation = services.products.requests.find(r => r.query.includes('_entities')).variables.representations[0]
  t.assert.deepStrictEqual(representation, { __typename: 'User', email: user.email, totalProductsCreated: 1337, yearsOfEmployment: 10 })
})

test('@provides: totalProductsCreated is served by products without visiting users', async t => {
  services.users.requests.length = 0
  const resp = await query('query ($id: ID!) { product(id: $id) { createdBy { email totalProductsCreated } } }', { id: 'apollo-federation' })
  t.assert.deepStrictEqual(resp, { data: { product: { createdBy: { email: user.email, totalProductsCreated: 1337 } } } })
  t.assert.strictEqual(services.users.requests.length, 0)
})

test('@interfaceObject: inventory from products gains deprecatedProducts', async t => {
  const resp = await query('query ($id: ID!) { inventory(id: $id) { deprecatedProducts { sku reason } } }', { id: 'apollo-oss' })
  t.assert.deepStrictEqual(resp, { data: { inventory: { deprecatedProducts: [{ sku: 'apollo-federation-v1', reason: 'Migrate to Federation V2' }] } } })
})

test('multiple keys, nested @requires and interface resolution across all three subgraphs', async t => {
  const resp = await query(`query ($id: ID!) {
    inventory(id: $id) {
      id
      __typename
      deprecatedProducts { sku createdBy { email name } }
      ... on OpenSourceInventory {
        products {
          id sku package variation { id }
          research { study { caseNumber description } outcome }
          delivery(zip: "94111") { estimatedDelivery }
          createdBy { email yearsOfEmployment }
        }
      }
    }
    deprecatedProduct(sku: "apollo-federation-v1", package: "@apollo/federation-v1") { reason }
  }`, { id: 'apollo-oss' })
  t.assert.deepStrictEqual(resp, {
    data: {
      inventory: {
        id: 'apollo-oss',
        __typename: 'OpenSourceInventory',
        deprecatedProducts: [{ sku: 'apollo-federation-v1', createdBy: { email: user.email, name: 'Jane Smith' } }],
        products: [{
          id: 'apollo-federation',
          sku: 'federation',
          package: '@apollo/federation',
          variation: { id: 'OSS' },
          research: [{ study: { caseNumber: '1234', description: 'Federation Study' }, outcome: null }],
          delivery: { estimatedDelivery: '5/1/2019' },
          createdBy: { email: user.email, yearsOfEmployment: 10 }
        }]
      },
      deprecatedProduct: { reason: 'Migrate to Federation V2' }
    }
  })
})

test('query plan for the cross-subgraph query', t => {
  const text = gateway.graphqlGateway.explain('{ inventory(id: "x") { ... on OpenSourceInventory { products { sku delivery(zip: "94111") { estimatedDelivery } } } } }')
  // Query.inventory is shared by inventory and products; the planner starts in inventory (the real
  // interface owner), hops to products for sku + the @requires'd dimensions, then back to inventory for delivery.
  t.assert.match(text, /Fetch\(graph: inventory\)[\s\S]*Flatten\(path: inventory.products.@\) Fetch\(graph: products, type: Product, key: "id"\)[\s\S]*Flatten\(path: inventory.products.@\) Fetch\(graph: inventory, type: Product, key: "id"\)/)
})
