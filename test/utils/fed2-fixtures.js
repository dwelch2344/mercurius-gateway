'use strict'

// Shared SDL fixtures for Federation 2 tests. The "rich" set exercises every
// join__ shape the PlanIndex has to understand.

const productsV2 = `
  extend schema
    @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable", "@inaccessible", "@external", "@requires", "@provides", "@interfaceObject", "@composeDirective", "@tag", "@override"])
    @link(url: "https://myspecs.dev/custom/v1.0", import: ["@custom"])
    @composeDirective(name: "@custom")

  directive @custom(input: ID) on OBJECT | FIELD_DEFINITION

  enum Color { RED GREEN }
  input Filter { color: Color q: String = "x" }
  scalar Date
  interface Node { id: ID! }

  type Product implements Node @key(fields: "id") @key(fields: "sku variation { id }") @custom {
    id: ID!
    sku: String
    variation: Variation
    dims: Dims
    createdBy: User @provides(fields: "totalProductsCreated")
    color: Color
    created: Date
    secret: Secret @inaccessible
    notes: String @tag(name: "internal")
  }
  type Secret @inaccessible { x: String }
  type Variation { id: ID! }
  type Dims @shareable { size: String weight: Float }

  extend type User @key(fields: "email") {
    email: ID! @external
    totalProductsCreated: Int @external
    name: String @override(from: "users")
    avg: Int @requires(fields: "totalProductsCreated")
  }

  union SearchResult = Product | User

  type Query {
    product(id: ID!, f: Filter): Product
    search: [SearchResult]
    node(id: ID!): Node
    inventory(id: ID!): Inventory
  }

  type Inventory @interfaceObject @key(fields: "id") {
    id: ID!
    deprecated: [Product]
  }
`

const usersV2 = `
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable"])

  type User @key(fields: "email") {
    email: ID!
    name: String
    totalProductsCreated: Int
    yearsOfEmployment: Int
  }
  type Dims @shareable { size: String weight: Float }
  type Query { me: User }
`

const inventoryV2 = `
  extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@external", "@requires", "@shareable"])

  interface Inventory @key(fields: "id") {
    id: ID!
    products: [Product!]!
  }
  type OpenSourceInventory implements Inventory @key(fields: "id") {
    id: ID!
    products: [Product!]!
  }
  type Product @key(fields: "id") {
    id: ID!
    dims: Dims @external
    delivery: String @requires(fields: "dims { size weight }")
  }
  type Dims @shareable { size: String weight: Float }
  type Query { inv(id: ID!): Inventory }
`

const userV1 = `
  directive @custom(input: ID) on OBJECT | FIELD_DEFINITION

  type Query @extends {
    me: User @custom
  }

  type User @key(fields: "id") {
    id: ID!
    name: String! @custom
  }

  type PageInfo { hasNext: Boolean }
`

const postV1 = `
  directive @custom(input: ID) on OBJECT | FIELD_DEFINITION

  type Post @key(fields: "pid") {
    pid: ID!
    author: User
  }

  extend type User @key(fields: "id") {
    id: ID! @external
    posts: [Post]
  }

  type PageInfo { hasNext: Boolean extra: String }

  extend type Query { topPosts: [Post] }
`

module.exports = { productsV2, usersV2, inventoryV2, userV1, postV1 }
