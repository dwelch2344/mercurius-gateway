'use strict'

const { test } = require('node:test')
const Fastify = require('fastify')
const plugin = require('../../index')
const { createFed2Service } = require('../utils/create-fed2-service')

const LINK = 'extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable", "@external", "@requires", "@interfaceObject"])'

const products = {
  'apollo-federation': { id: 'apollo-federation', sku: 'federation', dimensions: { size: 'small', weight: 1 } },
  'apollo-studio': { id: 'apollo-studio', sku: 'studio', dimensions: { size: 'large', weight: 3 } }
}
const deprecated = [{ id: 'fed-v1', sku: 'apollo-federation-v1', reason: 'Migrate to Federation V2' }]
const inventories = {
  'apollo-oss': { __typename: 'OpenSourceInventory', id: 'apollo-oss', productIds: ['apollo-federation'], license: 'MIT' },
  'apollo-paid': { __typename: 'CommercialInventory', id: 'apollo-paid', productIds: ['apollo-studio'], seats: 42 }
}

// Defines the Inventory interface for real.
async function inventoryService (t) {
  return createFed2Service(t, `
    ${LINK}
    interface Inventory @key(fields: "id") {
      id: ID!
      products: [Product!]!
    }
    type OpenSourceInventory implements Inventory @key(fields: "id") {
      id: ID!
      products: [Product!]!
      license: String
    }
    type CommercialInventory implements Inventory @key(fields: "id") {
      id: ID!
      products: [Product!]!
      seats: Int
    }
    type Product @key(fields: "id") {
      id: ID!
      dimensions: ProductDimension @external
      delivery(zip: String): String @requires(fields: "dimensions { size weight }")
    }
    type ProductDimension @shareable { size: String weight: Float }
    type Query { inv(id: ID!): Inventory allInventories: [Inventory!]! }
  `, {
    Query: { inv: (_, { id }) => inventories[id], allInventories: () => Object.values(inventories) },
    // reference resolution for an interface entity: the reference carries only the key
    Inventory: { resolveType: obj => obj.__typename || inventories[obj.id].__typename },
    OpenSourceInventory: {
      __resolveReference: ref => inventories[ref.id],
      products: inv => inv.productIds.map(id => ({ __typename: 'Product', id }))
    },
    CommercialInventory: {
      __resolveReference: ref => inventories[ref.id],
      products: inv => inv.productIds.map(id => ({ __typename: 'Product', id }))
    },
    Product: {
      __resolveReference: ref => ({ ...ref }),
      delivery: (p, { zip }) => `${p.dimensions.size}/${p.dimensions.weight}kg to ${zip || 'anywhere'}`
    }
  })
}

// Sees Inventory only as an @interfaceObject.
async function productsService (t) {
  return createFed2Service(t, `
    ${LINK}
    type Product @key(fields: "id") {
      id: ID!
      sku: String
      dimensions: ProductDimension
    }
    type DeprecatedProduct @key(fields: "id") { id: ID! sku: String reason: String }
    type ProductDimension @shareable { size: String weight: Float }
    type Inventory @interfaceObject @key(fields: "id") {
      id: ID!
      deprecatedProducts: [DeprecatedProduct!]!
    }
    type Query { product(id: ID!): Product inventory(id: ID!): Inventory }
  `, {
    Query: { product: (_, { id }) => products[id], inventory: (_, { id }) => ({ id }) },
    Product: { __resolveReference: ref => products[ref.id] },
    Inventory: {
      __resolveReference: ref => ({ id: ref.id }),
      deprecatedProducts: inv => (inv.id === 'apollo-oss' ? deprecated : [])
    }
  })
}

async function createGateway (t, services) {
  const gateway = Fastify()
  t.after(() => gateway.close())
  await gateway.register(plugin, { gateway: { services } })
  await gateway.ready()
  return gateway
}

async function query (gateway, source, variables) {
  const res = await gateway.inject({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    url: '/graphql',
    body: JSON.stringify({ query: source, variables })
  })
  return JSON.parse(res.body)
}

test('interface fields: owned fields stay inline, hops are keyed on the concrete implementation', async t => {
  const i = await inventoryService(t)
  const p = await productsService(t)
  const gateway = await createGateway(t, [{ name: 'inventory', url: i.url }, { name: 'products', url: p.url }])

  t.assert.deepStrictEqual(await query(gateway, '{ allInventories { id __typename products { id sku delivery } ... on OpenSourceInventory { license } } }'), {
    data: {
      allInventories: [
        { id: 'apollo-oss', __typename: 'OpenSourceInventory', products: [{ id: 'apollo-federation', sku: 'federation', delivery: 'small/1kg to anywhere' }], license: 'MIT' },
        { id: 'apollo-paid', __typename: 'CommercialInventory', products: [{ id: 'apollo-studio', sku: 'studio', delivery: 'large/3kg to anywhere' }] }
      ]
    }
  })
  // Product.sku + dimensions come from products in one batched hop, then delivery goes back to inventory
  const hops = p.requests.filter(r => r.query.includes('_entities'))
  t.assert.strictEqual(hops.length, 1)
  t.assert.deepStrictEqual(hops[0].variables.representations.map(r => r.id), ['apollo-federation', 'apollo-studio'])
})

test('hop into an @interfaceObject subgraph uses the interface as the representation type', async t => {
  const i = await inventoryService(t)
  const p = await productsService(t)
  const gateway = await createGateway(t, [{ name: 'inventory', url: i.url }, { name: 'products', url: p.url }])

  // deprecatedProducts is an interface field that only the @interfaceObject subgraph resolves
  t.assert.deepStrictEqual(await query(gateway, '{ inv(id: "apollo-oss") { id deprecatedProducts { sku reason } } }'), {
    data: { inv: { id: 'apollo-oss', deprecatedProducts: [{ sku: 'apollo-federation-v1', reason: 'Migrate to Federation V2' }] } }
  })
  const hop = p.requests.find(r => r.query.includes('_entities'))
  t.assert.deepStrictEqual(hop.variables.representations, [{ __typename: 'Inventory', id: 'apollo-oss' }])
  t.assert.match(hop.query, /\.\.\. on Inventory \{/)
  t.assert.match(gateway.graphqlGateway.explain('{ inv(id: "x") { deprecatedProducts { sku } } }'), /type: OpenSourceInventory, as: Inventory/)
})

test('an @interfaceObject subgraph returning the interface: the concrete type and its fields come from the defining subgraph', async t => {
  const i = await inventoryService(t)
  const p = await productsService(t)
  const gateway = await createGateway(t, [{ name: 'inventory', url: i.url }, { name: 'products', url: p.url }])

  t.assert.deepStrictEqual(await query(gateway, `{
    inventory(id: "apollo-oss") {
      id
      __typename
      deprecatedProducts { sku }
      products { id }
      ... on OpenSourceInventory { license }
      ... on CommercialInventory { seats }
    }
  }`), {
    data: {
      inventory: {
        id: 'apollo-oss',
        __typename: 'OpenSourceInventory',
        deprecatedProducts: [{ sku: 'apollo-federation-v1' }],
        products: [{ id: 'apollo-federation' }],
        license: 'MIT'
      }
    }
  })
  const toInventory = i.requests.find(r => r.query.includes('_entities'))
  t.assert.deepStrictEqual(toInventory.variables.representations, [{ __typename: 'Inventory', id: 'apollo-oss' }])
  t.assert.match(toInventory.query, /\.\.\. on OpenSourceInventory \{\s*license/)

  // even without asking for anything else, the typename hop happens so the gateway can resolve the interface
  t.assert.deepStrictEqual(await query(gateway, '{ inventory(id: "apollo-paid") { id } }'), { data: { inventory: { id: 'apollo-paid' } } })
  const plan = gateway.graphqlGateway.buildQueryPlan('{ inventory(id: "apollo-paid") { id } }')
  t.assert.strictEqual(plan.roots[0].children[0].graph, 'inventory')
  t.assert.match(plan.roots[0].children[0].document, /__typename/)
})
