'use strict'

const { test } = require('node:test')
const { composeSupergraph } = require('../../lib/compose')
const { productsV2, usersV2, inventoryV2, userV1, postV1 } = require('../utils/fed2-fixtures')

function rich () {
  return composeSupergraph({
    services: [
      { name: 'products', schemaDefinition: productsV2 },
      { name: 'users', schemaDefinition: usersV2 },
      { name: 'inventory', schemaDefinition: inventoryV2 }
    ]
  })
}

test('graphs are indexed by subgraph name and enum value', t => {
  const { planIndex } = rich()
  t.assert.deepStrictEqual(Object.keys(planIndex.graphs).sort(), ['inventory', 'products', 'users'])
  t.assert.strictEqual(planIndex.graphByEnum.PRODUCTS, 'products')
  t.assert.strictEqual(planIndex.graphs.users.enumValue, 'USERS')
})

test('entity keys per graph, including composite keys, extension and resolvable flags', t => {
  const { planIndex } = rich()
  const product = planIndex.types.Product
  t.assert.strictEqual(product.kind, 'OBJECT')
  t.assert.deepStrictEqual(product.graphs.products.keys.map(k => k.fields), ['id', 'sku variation { id }'])
  t.assert.deepStrictEqual(product.graphs.inventory.keys.map(k => k.fields), ['id'])
  t.assert.deepStrictEqual(product.interfaces, ['Node'])
  t.assert.deepStrictEqual(product.implementsIn, { products: ['Node'] })

  const user = planIndex.types.User
  t.assert.strictEqual(user.graphs.products.extension, true)
  t.assert.strictEqual(user.graphs.users.extension, false)
  t.assert.strictEqual(user.graphs.users.resolvable, true)
})

test('field ownership: shareable, single owner, external, requires, provides, override', t => {
  const { planIndex } = rich()
  const { Product, User, Dims, Query } = planIndex.types

  // value type shared by all three graphs: no @join__field → every graph owns it
  t.assert.deepStrictEqual([...Dims.fields.size.owners].sort(), ['inventory', 'products', 'users'])

  // dims is external in inventory, owned by products
  t.assert.deepStrictEqual([...Product.fields.dims.owners], ['products'])
  t.assert.deepStrictEqual([...Product.fields.dims.external], ['inventory'])

  // nested @requires
  t.assert.deepStrictEqual([...Product.fields.delivery.owners], ['inventory'])
  t.assert.strictEqual(Product.fields.delivery.requires.inventory.fields, 'dims { size weight }')

  // @provides
  t.assert.strictEqual(Product.fields.createdBy.provides.products.fields, 'totalProductsCreated')

  // @override: only the overriding graph owns the field
  t.assert.deepStrictEqual([...User.fields.name.owners], ['products'])
  t.assert.strictEqual(User.fields.name.overrideFrom, 'users')
  t.assert.strictEqual(User.fields.name.overridingGraph, 'products')

  // external + requires on the extension side
  t.assert.deepStrictEqual([...User.fields.totalProductsCreated.owners], ['users'])
  t.assert.deepStrictEqual([...User.fields.totalProductsCreated.external], ['products'])
  t.assert.strictEqual(User.fields.avg.requires.products.fields, 'totalProductsCreated')

  // root fields
  t.assert.deepStrictEqual([...Query.fields.me.owners], ['users'])
  t.assert.deepStrictEqual([...Query.fields.product.owners], ['products'])
  t.assert.deepStrictEqual(Query.fields.product.arguments, ['id', 'f'])
})

test('@inaccessible is recorded on types and fields', t => {
  const { planIndex, schema } = rich()
  t.assert.strictEqual(planIndex.types.Secret.inaccessible, true)
  t.assert.strictEqual(planIndex.types.Product.fields.secret.inaccessible, true)
  t.assert.strictEqual(planIndex.types.Product.fields.sku.inaccessible, false)
  t.assert.strictEqual(schema.getType('Secret'), undefined)
  t.assert.strictEqual(schema.getType('Product').getFields().secret, undefined)
})

test('interfaces, interface objects, unions and enums', t => {
  const { planIndex } = rich()
  const { Inventory, OpenSourceInventory, SearchResult, Color, Node } = planIndex.types

  t.assert.strictEqual(Inventory.kind, 'INTERFACE')
  t.assert.strictEqual(Inventory.graphs.products.isInterfaceObject, true)
  t.assert.strictEqual(Inventory.graphs.inventory.isInterfaceObject, false)
  t.assert.deepStrictEqual([...Inventory.fields.deprecated.owners], ['products'])
  t.assert.deepStrictEqual([...Inventory.fields.products.owners], ['inventory'])

  // the implementation gains the interface-object graph and the contributed field
  t.assert.deepStrictEqual(OpenSourceInventory.implementsIn, { inventory: ['Inventory'] })
  t.assert.strictEqual(OpenSourceInventory.graphs.products.isInterfaceObject, true)
  t.assert.deepStrictEqual(OpenSourceInventory.graphs.products.keys.map(k => k.fields), ['id'])
  t.assert.deepStrictEqual([...OpenSourceInventory.fields.deprecated.owners], ['products'])
  t.assert.strictEqual(OpenSourceInventory.fields.deprecated.viaInterfaceObject, true)
  t.assert.strictEqual(OpenSourceInventory.fields.products.viaInterfaceObject, false)

  t.assert.strictEqual(SearchResult.kind, 'UNION')
  t.assert.deepStrictEqual(Object.keys(SearchResult.members).sort(), ['Product', 'User'])
  t.assert.deepStrictEqual([...SearchResult.members.Product], ['products'])

  t.assert.strictEqual(Color.kind, 'ENUM')
  t.assert.deepStrictEqual([...Color.values.RED.graphs], ['products'])
  t.assert.strictEqual(Node.kind, 'INTERFACE')
  t.assert.deepStrictEqual([...Node.fields.id.owners], ['products'])
})

test('federation 1 subgraphs produce the same index shape', t => {
  const { planIndex, federationVersions } = composeSupergraph({
    services: [
      { name: 'user', schemaDefinition: userV1 },
      { name: 'post', schemaDefinition: postV1 }
    ]
  })
  t.assert.deepStrictEqual(federationVersions, { user: 1, post: 1 })
  const { User, PageInfo, Query } = planIndex.types
  t.assert.deepStrictEqual([...User.fields.name.owners], ['user'])
  t.assert.deepStrictEqual([...User.fields.posts.owners], ['post'])
  t.assert.deepStrictEqual([...User.fields.id.owners].sort(), ['post', 'user'])
  t.assert.deepStrictEqual([...PageInfo.fields.hasNext.owners].sort(), ['post', 'user'])
  t.assert.deepStrictEqual([...PageInfo.fields.extra.owners], ['post'])
  t.assert.deepStrictEqual([...Query.fields.topPosts.owners], ['post'])
})
