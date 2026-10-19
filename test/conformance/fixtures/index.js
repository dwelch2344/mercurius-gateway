'use strict'

// The three subgraphs of the Apollo Federation subgraph compatibility suite
// (https://github.com/apollographql/apollo-federation-subgraph-compatibility):
// schemas copied verbatim, data as specified in COMPATIBILITY.md and the
// suite's reference `users` and `inventory` implementations.

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { GraphQLError } = require('graphql')

const sdl = name => readFileSync(join(__dirname, `${name}.graphql`), 'utf8')

const dimension = { size: 'small', weight: 1, unit: 'kg' }
const user = { email: 'support@apollographql.com', name: 'Jane Smith', totalProductsCreated: 1337, yearsOfEmployment: 10 }
const deprecatedProduct = { sku: 'apollo-federation-v1', package: '@apollo/federation-v1', reason: 'Migrate to Federation V2', createdBy: user }
const productsResearch = [
  { study: { caseNumber: '1234', description: 'Federation Study' }, outcome: null },
  { study: { caseNumber: '1235', description: 'Studio Study' }, outcome: null }
]
const products = [
  { id: 'apollo-federation', sku: 'federation', package: '@apollo/federation', variation: { id: 'OSS' }, dimensions: dimension, research: [productsResearch[0]], createdBy: user, notes: null },
  { id: 'apollo-studio', sku: 'studio', package: '', variation: { id: 'platform' }, dimensions: dimension, research: [productsResearch[1]], createdBy: user, notes: null }
]
const inventory = { id: 'apollo-oss', deprecatedProducts: [deprecatedProduct] }

const productsSubgraph = {
  schema: sdl('products'),
  resolvers: {
    Query: {
      product: (_, { id }) => products.find(p => p.id === id),
      deprecatedProduct: (_, { sku, package: pkg }) =>
        sku === deprecatedProduct.sku && pkg === deprecatedProduct.package ? deprecatedProduct : null
    },
    Product: {
      __resolveReference: ref => {
        if (ref.id) return products.find(p => p.id === ref.id)
        if (ref.sku && ref.package !== undefined) return products.find(p => p.sku === ref.sku && p.package === ref.package)
        if (ref.sku && ref.variation) return products.find(p => p.sku === ref.sku && p.variation.id === ref.variation.id)
        return null
      }
    },
    DeprecatedProduct: {
      __resolveReference: ref => (ref.sku === deprecatedProduct.sku && ref.package === deprecatedProduct.package ? deprecatedProduct : null)
    },
    ProductResearch: {
      __resolveReference: ref => productsResearch.find(r => r.study.caseNumber === ref.study.caseNumber)
    },
    User: {
      __resolveReference: ref => (ref.email ? { ...user, ...ref } : null),
      averageProductsCreatedPerYear: u => {
        if (u.email !== user.email) throw new GraphQLError("user.email was not 'support@apollographql.com'")
        return u.totalProductsCreated ? Math.round(u.totalProductsCreated / u.yearsOfEmployment) : null
      }
    },
    Inventory: {
      __resolveReference: ref => (ref.id === inventory.id ? inventory : null)
    }
  }
}

// reference users subgraph: note the different name, overridden by products
const users = [{ email: 'support@apollographql.com', name: 'Apollo Studio Support', totalProductsCreated: 10, yearsOfEmployment: 10 }]
const usersSubgraph = {
  schema: sdl('users'),
  resolvers: {
    User: { __resolveReference: ref => users.find(u => u.email === ref.email) }
  }
}

const deliveryEstimate = { estimatedDelivery: '5/1/2019', fastestDelivery: '5/1/2019' }
const inventories = [{ id: 'apollo-oss', products: [{ id: 'apollo-federation' }] }]
const inventorySubgraph = {
  schema: sdl('inventory'),
  resolvers: {
    Query: { inventory: (_, { id }) => inventories.find(i => i.id === id) },
    Product: {
      delivery: (product, { zip }) => {
        if (product.id !== 'apollo-federation') throw new GraphQLError("product.id was not 'apollo-federation'")
        if (product.dimensions.size !== 'small') throw new GraphQLError("product.dimensions.size was not 'small'")
        if (product.dimensions.weight !== 1) throw new GraphQLError("product.dimensions.weight was not '1'")
        if (zip !== '94111') throw new GraphQLError("product.delivery input zip was not '94111'")
        return deliveryEstimate
      }
    },
    Inventory: {
      resolveType: inv => (inv.id === 'apollo-oss' ? 'OpenSourceInventory' : null)
    },
    OpenSourceInventory: {
      __resolveReference: ref => inventories.find(i => i.id === ref.id)
    }
  }
}

module.exports = { productsSubgraph, usersSubgraph, inventorySubgraph, user, deprecatedProduct, products }
