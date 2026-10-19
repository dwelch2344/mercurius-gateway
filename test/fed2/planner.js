'use strict'

const { test } = require('node:test')
const { parse } = require('graphql')
const { composeSupergraph } = require('../../lib/compose')
const { buildQueryPlan, printPlan } = require('../../lib/planner')
const { productsV2, usersV2, inventoryV2, userV1, postV1 } = require('../utils/fed2-fixtures')

function plan (composed, source) {
  const document = parse(source)
  const operation = document.definitions.find(d => d.kind === 'OperationDefinition')
  const fragments = {}
  for (const d of document.definitions) if (d.kind === 'FragmentDefinition') fragments[d.name.value] = d
  return buildQueryPlan({ schema: composed.schema, planIndex: composed.planIndex, operation, fragments })
}

const v1 = composeSupergraph({
  services: [{ name: 'user', schemaDefinition: userV1 }, { name: 'post', schemaDefinition: postV1 }]
})
const v2 = composeSupergraph({
  services: [
    { name: 'products', schemaDefinition: productsV2 },
    { name: 'users', schemaDefinition: usersV2 },
    { name: 'inventory', schemaDefinition: inventoryV2 }
  ]
})

test('single-subgraph query is one root fetch', t => {
  const p = plan(v1, '{ me { id name } }')
  t.assert.strictEqual(p.roots.length, 1)
  t.assert.strictEqual(p.roots[0].graph, 'user')
  t.assert.deepStrictEqual(p.roots[0].responseKeys, ['me'])
  t.assert.strictEqual(p.roots[0].children.length, 0)
  t.assert.strictEqual(p.roots[0].document, 'query Query_me {\n  me {\n    id\n    name\n  }\n}')
})

test('root fields are grouped per subgraph and run in parallel', t => {
  const p = plan(v1, 'query Q { me { id } topPosts { pid } }')
  t.assert.strictEqual(p.ordered, false)
  t.assert.deepStrictEqual(p.roots.map(r => [r.graph, r.responseKeys]), [['user', ['me']], ['post', ['topPosts']]])
  t.assert.match(p.roots[0].document, /^query Q \{/)
})

test('mutations keep order and only merge contiguous same-subgraph fields', t => {
  const composed = composeSupergraph({
    services: [
      { name: 'a', schemaDefinition: 'extend type Mutation { a1: Int a2: Int } type Query { x: Int }' },
      { name: 'b', schemaDefinition: 'extend type Mutation { b1: Int } type Query { y: Int }' }
    ]
  })
  const p = plan(composed, 'mutation { a1 b1 a2 }')
  t.assert.strictEqual(p.ordered, true)
  t.assert.deepStrictEqual(p.roots.map(r => [r.graph, r.responseKeys]), [['a', ['a1']], ['b', ['b1']], ['a', ['a2']]])
})

test('entity hop: fields owned by another subgraph become a child fetch keyed on @key', t => {
  const p = plan(v1, '{ me { id name posts { pid author { id name } } } }')
  const root = p.roots[0]
  t.assert.strictEqual(root.graph, 'user')
  // key + __typename are added to the parent selection
  t.assert.strictEqual(root.document, 'query Query_me {\n  me {\n    id\n    name\n    __typename\n  }\n}')
  t.assert.strictEqual(root.children.length, 1)
  const child = root.children[0]
  t.assert.strictEqual(child.graph, 'post')
  t.assert.strictEqual(child.entityType, 'User')
  t.assert.deepStrictEqual(child.path, ['me'])
  t.assert.match(child.document, /query EntitiesQuery\(\$representations: \[_Any!\]!\)/)
  t.assert.match(child.document, /\.\.\. on User \{\n {6}posts \{\n {8}pid\n {8}author \{\n {10}id\n {10}__typename\n {8}\}\n {6}\}\n {4}\}/)
  // author.name lives in user: a grand-child fetch under posts.@.author
  t.assert.strictEqual(child.children.length, 1)
  t.assert.deepStrictEqual(child.children[0].path, ['me', 'posts', '@', 'author'])
  t.assert.strictEqual(child.children[0].graph, 'user')
  t.assert.match(child.children[0].document, /\.\.\. on User \{\n {6}name\n {4}\}/)
})

test('fragments are inlined and aliases/arguments/variables are preserved', t => {
  const p = plan(v1, 'query ($c: Int) { me { ...U } } fragment U on User { nick: name posts { pid } }')
  const root = p.roots[0]
  t.assert.match(root.document, /\.\.\. on User \{\n {6}nick: name\n {6}__typename\n {6}id\n {4}\}/)
  t.assert.deepStrictEqual([...root.variableNames], [])
  t.assert.strictEqual(root.children[0].graph, 'post')
})

test('variables used by a fetch are declared only on that fetch', t => {
  const p = plan(v2, 'query ($id: ID!, $f: Filter) { product(id: $id, f: $f) { sku createdBy { name } } me { email } }')
  const products = p.roots.find(r => r.graph === 'products')
  const users = p.roots.find(r => r.graph === 'users')
  t.assert.deepStrictEqual([...products.variableNames].sort(), ['f', 'id'])
  t.assert.deepStrictEqual([...users.variableNames], [])
  t.assert.match(products.document, /^query Query_product\(\$id: ID!, \$f: Filter\)/)
  t.assert.match(users.document, /^query Query_me \{/)
})

test('@override routes the field to the overriding subgraph', t => {
  const p = plan(v2, '{ me { name yearsOfEmployment } }')
  const root = p.roots[0]
  t.assert.strictEqual(root.graph, 'users')
  t.assert.match(root.document, /me \{\n {4}yearsOfEmployment\n {4}__typename\n {4}email\n {2}\}/)
  t.assert.strictEqual(root.children[0].graph, 'products')
  t.assert.match(root.children[0].document, /\.\.\. on User \{\n {6}name\n {4}\}/)
})

test('@shareable value type is read from the current subgraph, no hop', t => {
  const p = plan(v2, '{ product(id: "1") { dims { size weight } } }')
  t.assert.strictEqual(p.roots.length, 1)
  t.assert.strictEqual(p.roots[0].children.length, 0)
})

test('@provides lets the current subgraph serve provided fields without a hop', t => {
  const p = plan(v2, '{ product(id: "1") { createdBy { email totalProductsCreated } } }')
  t.assert.strictEqual(p.roots[0].children.length, 0)
  t.assert.match(p.roots[0].document, /createdBy \{\n {6}email\n {6}totalProductsCreated\n {4}\}/)

  const p2 = plan(v2, '{ product(id: "1") { createdBy { email yearsOfEmployment } } }')
  t.assert.strictEqual(p2.roots[0].children.length, 1)
  t.assert.strictEqual(p2.roots[0].children[0].graph, 'users')
  t.assert.deepStrictEqual(p2.roots[0].children[0].path, ['product', 'createdBy'])
})

test('@requires: required fields are fetched first and added to the representation', t => {
  const p = plan(v2, '{ me { avg } }')
  const root = p.roots[0]
  t.assert.strictEqual(root.graph, 'users')
  // totalProductsCreated is owned by users: fetched in the root
  t.assert.match(root.document, /me \{\n {4}totalProductsCreated\n {4}__typename\n {4}email\n {2}\}/)
  const child = root.children[0]
  t.assert.strictEqual(child.graph, 'products')
  t.assert.strictEqual(child.requires.length, 1)
})

test('nested @requires across a hop: delivery requires dims from products', t => {
  const p = plan(v2, '{ inv(id: "1") { ... on OpenSourceInventory { products { delivery } } } }')
  const root = p.roots[0]
  t.assert.strictEqual(root.graph, 'inventory')
  // inventory owns Product.delivery but requires dims{size weight} from products
  const dimsFetch = root.children[0]
  t.assert.strictEqual(dimsFetch.graph, 'products')
  t.assert.deepStrictEqual(dimsFetch.path, ['inv', 'products', '@'])
  t.assert.match(dimsFetch.document, /dims \{\n {8}size\n {8}weight\n {6}\}/)
  const deliveryFetch = dimsFetch.children[0]
  t.assert.strictEqual(deliveryFetch.graph, 'inventory')
  t.assert.match(deliveryFetch.document, /delivery/)
  t.assert.strictEqual(deliveryFetch.requires[0], v2.planIndex.types.Product.fields.delivery.requires.inventory.selectionSet)
})

test('union members from the same subgraph are resolved inline; other-subgraph fields hop', t => {
  const p = plan(v2, '{ search { ... on Product { sku } ... on User { yearsOfEmployment } } }')
  const root = p.roots[0]
  t.assert.match(root.document, /search \{\n {4}\.\.\. on Product \{\n {6}sku\n {4}\}\n {4}\.\.\. on User \{\n {6}__typename\n {6}email\n {4}\}\n {4}__typename\n {2}\}/)
  t.assert.strictEqual(root.children.length, 1)
  t.assert.strictEqual(root.children[0].entityType, 'User')
  t.assert.deepStrictEqual(root.children[0].path, ['search', '@'])
})

test('printPlan renders the tree', t => {
  const p = plan(v1, '{ me { id posts { pid } } }')
  const text = printPlan(p)
  t.assert.match(text, /^QueryPlan\(query\) \{\n {2}Parallel \{\n {4}Fetch\(graph: user\) \{/)
  t.assert.match(text, /Flatten\(path: me\) Fetch\(graph: post, type: User, key: "id"\)/)
})

test('unsupported (phase 6): key bridging through a third subgraph raises a planning error', t => {
  const composed = composeSupergraph({
    services: [
      { name: 'a', schemaDefinition: 'type Query { t: T } type T @key(fields: "id") { id: ID! }' },
      { name: 'b', schemaDefinition: 'type T @key(fields: "id") @key(fields: "sku") { id: ID! sku: ID! } type Query { u: Int }' },
      { name: 'c', schemaDefinition: 'type T @key(fields: "sku") { sku: ID! x: Int } type Query { v: Int }' }
    ]
  })
  t.assert.throws(() => plan(composed, '{ t { x } }'), { code: 'MER_ERR_GQL_GATEWAY_PLANNING_UNSUPPORTED', message: /multi-hop/ })
})
