'use strict'

const { test } = require('node:test')
const { parse } = require('graphql')
const { composeSupergraph, detectFederationVersion } = require('../../lib/compose')
const { productsV2, usersV2, inventoryV2, userV1, postV1 } = require('../utils/fed2-fixtures')

test('detectFederationVersion', t => {
  t.assert.strictEqual(detectFederationVersion(parse(userV1)), 1)
  t.assert.strictEqual(detectFederationVersion(parse(usersV2)), 2)
  t.assert.strictEqual(detectFederationVersion(parse('extend schema @link(url: "https://specs.apollo.dev/other/v1.0") type Query { a: Int }')), 1)
})

test('composes federation 2 subgraphs into an executable schema without join machinery', t => {
  const result = composeSupergraph({
    services: [
      { name: 'products', url: 'http://products', schemaDefinition: productsV2 },
      { name: 'users', schemaDefinition: parse(usersV2) },
      { name: 'inventory', schemaDefinition: inventoryV2 }
    ]
  })
  t.assert.deepStrictEqual(result.federationVersions, { products: 2, users: 2, inventory: 2 })
  t.assert.match(result.supergraphSdl, /join__graph\(name: "products", url: "http:\/\/products"\)/)
  const typeNames = Object.keys(result.schema.getTypeMap()).filter(n => !n.startsWith('__'))
  t.assert.ok(!typeNames.some(n => n.startsWith('join__') || n.startsWith('link__')), typeNames.join(','))
  t.assert.ok(result.schema.getType('Product'))
  t.assert.strictEqual(result.schema.getType('Product').getFields().notes.astNode.directives.length, 0, '@tag is stripped from the API schema')
  // composed custom directive survives
  t.assert.ok(result.schema.getDirective('custom'))
  t.assert.strictEqual(result.schema.getDirective('inaccessible'), undefined)
  t.assert.strictEqual(result.schema.getDirective('key'), undefined)
  t.assert.strictEqual(result.schema.getQueryType().name, 'Query')
  t.assert.match(result.publicSdl, /type Product implements Node @custom/)
})

test('federation 1 subgraphs: custom directive definitions are re-added and de-duplicated', t => {
  const { schema } = composeSupergraph({
    services: [
      { name: 'user', schemaDefinition: userV1 },
      { name: 'post', schemaDefinition: postV1 }
    ]
  })
  t.assert.deepStrictEqual(
    schema.getDirectives().map(d => d.name).sort(),
    ['custom', 'deprecated', 'include', 'oneOf', 'skip', 'specifiedBy']
  )
  t.assert.deepStrictEqual(Object.keys(schema.getType('User').getFields()).sort(), ['id', 'name', 'posts'])
})

test('conflicting custom directive definitions throw MER_ERR_GQL_GATEWAY_DUPLICATE_DIRECTIVE', t => {
  t.assert.throws(() => composeSupergraph({
    services: [
      { name: 'user', schemaDefinition: userV1 },
      { name: 'post', schemaDefinition: postV1.replace('@custom(input: ID)', '@custom(input: String)') }
    ]
  }), { code: 'MER_ERR_GQL_GATEWAY_DUPLICATE_DIRECTIVE' })
})

test('composition errors are wrapped with their codes', t => {
  const a = 'extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"]) type Query { a: T } type T @key(fields: "id") { id: ID! x: String }'
  const b = 'extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"]) type Query { b: T } type T @key(fields: "id") { id: ID! x: String }'
  try {
    composeSupergraph({ services: [{ name: 'a', schemaDefinition: a }, { name: 'b', schemaDefinition: b }] })
    t.assert.fail('should throw')
  } catch (err) {
    t.assert.strictEqual(err.code, 'MER_ERR_GQL_GATEWAY_COMPOSITION')
    t.assert.match(err.message, /\[INVALID_FIELD_SHARING\] Non-shareable field "T.x"/)
    t.assert.strictEqual(err.errors.length, 1)
    t.assert.strictEqual(err.errors[0].extensions.code, 'INVALID_FIELD_SHARING')
  }
})

test('a precomposed supergraph can be used instead of services', t => {
  const composed = composeSupergraph({
    services: [
      { name: 'products', schemaDefinition: productsV2 },
      { name: 'users', schemaDefinition: usersV2 },
      { name: 'inventory', schemaDefinition: inventoryV2 }
    ]
  })
  const fromSdl = composeSupergraph({ supergraphSdl: composed.supergraphSdl })
  t.assert.strictEqual(fromSdl.supergraphSdl, composed.supergraphSdl)
  t.assert.deepStrictEqual(Object.keys(fromSdl.planIndex.graphs).sort(), ['inventory', 'products', 'users'])
  t.assert.deepStrictEqual([...fromSdl.planIndex.types.Product.fields.delivery.owners], ['inventory'])
  t.assert.strictEqual(fromSdl.publicSdl, composed.publicSdl)
  t.assert.deepStrictEqual(fromSdl.federationVersions, {})

  const fromDocument = composeSupergraph({ supergraphSdl: composed.supergraphDocument })
  t.assert.strictEqual(fromDocument.publicSdl, composed.publicSdl)
})

test('invalid inputs', t => {
  t.assert.throws(() => composeSupergraph({}), { code: 'MER_ERR_GQL_GATEWAY_COMPOSITION', message: /either "services" or "supergraphSdl"/ })
  t.assert.throws(() => composeSupergraph({ services: [] }), { code: 'MER_ERR_GQL_GATEWAY_COMPOSITION' })
  t.assert.throws(() => composeSupergraph({ supergraphSdl: 'type Query { a: Int }' }), { code: 'MER_ERR_GQL_GATEWAY_COMPOSITION', message: /not a supergraph/ })
})
