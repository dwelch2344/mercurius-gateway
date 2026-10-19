'use strict'

const { test } = require('node:test')
const Fastify = require('fastify')
const plugin = require('../../index')
const { createFed2Service } = require('../utils/create-fed2-service')

const LINK = 'extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable", "@external", "@requires", "@provides"])'

const products = {
  'apollo-federation': { id: 'apollo-federation', sku: 'federation', package: '@apollo/federation', variation: { id: 'OSS' } },
  'apollo-studio': { id: 'apollo-studio', sku: 'studio', package: '', variation: { id: 'platform' } }
}
const research = [
  { study: { caseNumber: '1234', description: 'Federation Study' }, outcome: null },
  { study: { caseNumber: '1235', description: 'Studio Study' }, outcome: null }
]
const dimension = { size: 'small', weight: 1 }

async function productsService (t) {
  return createFed2Service(t, `
    ${LINK}
    type Query { product(id: ID!): Product research: [ProductResearch!]! }
    type Product @key(fields: "id") @key(fields: "sku package") @key(fields: "sku variation { id }") {
      id: ID!
      sku: String
      package: String
      variation: ProductVariation
      dimensions: ProductDimension
      research: [ProductResearch!]!
    }
    type ProductVariation { id: ID! }
    type ProductDimension @shareable { size: String weight: Float }
    type ProductResearch @key(fields: "study { caseNumber }") {
      study: CaseStudy!
      outcome: String
    }
    type CaseStudy { caseNumber: ID! description: String }
  `, {
    Query: { product: (_, { id }) => products[id], research: () => research },
    Product: {
      __resolveReference: ref => {
        if (ref.id) return products[ref.id]
        if (ref.sku && ref.package !== undefined) return Object.values(products).find(p => p.sku === ref.sku && p.package === ref.package)
        return Object.values(products).find(p => p.sku === ref.sku && p.variation.id === ref.variation.id)
      },
      dimensions: () => dimension,
      research: product => research.filter(r => (product.id === 'apollo-federation' ? r.study.caseNumber === '1234' : r.study.caseNumber === '1235'))
    },
    ProductResearch: {
      __resolveReference: ref => research.find(r => r.study.caseNumber === ref.study.caseNumber)
    }
  })
}

// Knows products only by (sku, package) and research by study.
async function inventoryService (t) {
  return createFed2Service(t, `
    ${LINK}
    type Query { bySku(sku: String!): Product labs: [Lab!]! }
    type Product @key(fields: "sku package") {
      sku: String
      package: String
      dimensions: ProductDimension @external
      delivery(zip: String): String @requires(fields: "dimensions { size weight }")
      stock: Int
    }
    type ProductDimension @shareable { size: String weight: Float }
    type Lab { name: String! paper: ProductResearch }
    type ProductResearch @key(fields: "study { caseNumber }", resolvable: false) {
      study: CaseStudy!
    }
    type CaseStudy { caseNumber: ID! }
  `, {
    Query: {
      bySku: (_, { sku }) => ({ sku, package: Object.values(products).find(p => p.sku === sku).package }),
      labs: () => [{ name: 'Lab A', paper: { study: { caseNumber: '1235' } } }]
    },
    Product: {
      __resolveReference: ref => ({ ...ref }),
      delivery: (product, { zip }) => `${product.dimensions.size}/${product.dimensions.weight}kg to ${zip || 'anywhere'}`,
      stock: product => (product.sku === 'federation' ? 3 : 0)
    }
  })
}

// Knows products only by the composite (sku, variation { id }) key.
async function catalogService (t) {
  return createFed2Service(t, `
    ${LINK}
    type Query { byVariation(sku: String!, variation: ID!): Product }
    type Product @key(fields: "sku variation { id }") {
      sku: String
      variation: ProductVariation
      label: String
    }
    type ProductVariation { id: ID! }
  `, {
    Query: { byVariation: (_, { sku, variation }) => ({ sku, variation: { id: variation } }) },
    Product: {
      __resolveReference: ref => ({ ...ref }),
      label: product => `${product.sku}/${product.variation.id}`
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

test('multiple @key: the hop uses whichever key the current subgraph can supply', async t => {
  const p = await productsService(t)
  const i = await inventoryService(t)
  const gateway = await createGateway(t, [{ name: 'products', url: p.url }, { name: 'inventory', url: i.url }])

  // products → inventory: products has id, sku, package and variation; stock lives in inventory
  t.assert.deepStrictEqual(await query(gateway, '{ product(id: "apollo-federation") { id stock } }'), {
    data: { product: { id: 'apollo-federation', stock: 3 } }
  })
  const toInventory = i.requests.find(r => r.query.includes('_entities'))
  t.assert.deepStrictEqual(toInventory.variables.representations, [{ __typename: 'Product', sku: 'federation', package: '@apollo/federation' }])

  // inventory (sku + package only) → products: id is not available, the (sku package) key is used
  t.assert.deepStrictEqual(await query(gateway, '{ bySku(sku: "studio") { sku id dimensions { size } } }'), {
    data: { bySku: { sku: 'studio', id: 'apollo-studio', dimensions: { size: 'small' } } }
  })
  const toProducts = p.requests.find(r => r.query.includes('_entities'))
  t.assert.deepStrictEqual(toProducts.variables.representations, [{ __typename: 'Product', sku: 'studio', package: '' }])
})

test('composite @key with a nested selection', async t => {
  const p = await productsService(t)
  const i = await inventoryService(t)
  const c = await catalogService(t)
  const gateway = await createGateway(t, [{ name: 'products', url: p.url }, { name: 'inventory', url: i.url }, { name: 'catalog', url: c.url }])

  // catalog → products on (sku variation { id })
  t.assert.deepStrictEqual(await query(gateway, '{ byVariation(sku: "federation", variation: "OSS") { id package } }'), {
    data: { byVariation: { id: 'apollo-federation', package: '@apollo/federation' } }
  })
  const toProducts = p.requests.find(r => r.query.includes('_entities'))
  t.assert.deepStrictEqual(toProducts.variables.representations, [{ __typename: 'Product', sku: 'federation', variation: { id: 'OSS' } }])
  // the parent fetch had to select the nested key fields
  t.assert.match(c.requests[0].query, /variation \{\s*id\s*\}/)

  // products → catalog on the same composite key
  t.assert.deepStrictEqual(await query(gateway, '{ product(id: "apollo-studio") { label } }'), {
    data: { product: { label: 'studio/platform' } }
  })
  const toCatalog = c.requests.find(r => r.query.includes('_entities'))
  t.assert.deepStrictEqual(toCatalog.variables.representations, [{ __typename: 'Product', sku: 'studio', variation: { id: 'platform' } }])

  t.assert.deepStrictEqual(await query(gateway, '{ labs { name paper { study { caseNumber description } outcome } } }'), {
    data: { labs: [{ name: 'Lab A', paper: { study: { caseNumber: '1235', description: 'Studio Study' }, outcome: null } }] }
  })
  const researchHop = p.requests.filter(r => r.query.includes('_entities')).pop()
  t.assert.deepStrictEqual(researchHop.variables.representations, [{ __typename: 'ProductResearch', study: { caseNumber: '1235' } }])
})

test('nested @requires: required object fields are fetched from their owner and sent in the representation', async t => {
  const p = await productsService(t)
  const i = await inventoryService(t)
  const gateway = await createGateway(t, [{ name: 'products', url: p.url }, { name: 'inventory', url: i.url }])

  t.assert.deepStrictEqual(await query(gateway, '{ product(id: "apollo-studio") { sku delivery(zip: "90210") } }'), {
    data: { product: { sku: 'studio', delivery: 'small/1kg to 90210' } }
  })
  const toInventory = i.requests.find(r => r.query.includes('_entities'))
  t.assert.deepStrictEqual(toInventory.variables.representations, [
    { __typename: 'Product', sku: 'studio', package: '', dimensions: { size: 'small', weight: 1 } }
  ])
  t.assert.doesNotMatch(p.requests[0].query, /delivery/)
  t.assert.match(p.requests[0].query, /dimensions \{\s*size\s*weight\s*\}/)

  // from the inventory side the required fields need a hop to products first, then back to inventory
  t.assert.deepStrictEqual(await query(gateway, '{ bySku(sku: "federation") { delivery } }'), {
    data: { bySku: { delivery: 'small/1kg to anywhere' } }
  })
  const plan = gateway.graphqlGateway.buildQueryPlan('{ bySku(sku: "federation") { delivery } }')
  t.assert.strictEqual(plan.roots[0].graph, 'inventory')
  t.assert.strictEqual(plan.roots[0].children[0].graph, 'products')
  t.assert.strictEqual(plan.roots[0].children[0].children[0].graph, 'inventory')
})

test('@key(resolvable: false) is never used as a hop target', async t => {
  const p = await productsService(t)
  const i = await inventoryService(t)
  const gateway = await createGateway(t, [{ name: 'products', url: p.url }, { name: 'inventory', url: i.url }])

  // research from products: inventory declares ProductResearch non-resolvable, so nothing can hop there
  // and every field of ProductResearch is served by products.
  const plan = gateway.graphqlGateway.buildQueryPlan('{ research { study { caseNumber } outcome } }')
  t.assert.strictEqual(plan.roots.length, 1)
  t.assert.strictEqual(plan.roots[0].children.length, 0)
  t.assert.strictEqual(gateway.graphqlGateway.planIndex.types.ProductResearch.graphs.inventory.resolvable, false)
})
