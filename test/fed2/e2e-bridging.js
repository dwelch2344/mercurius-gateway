'use strict'

const { test } = require('node:test')
const Fastify = require('fastify')
const plugin = require('../../index')
const { createFed2Service } = require('../utils/create-fed2-service')

const LINK = 'extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])'

test('a field whose owner only accepts a key the current subgraph lacks is reached through an intermediate subgraph', async t => {
  const items = { i1: { id: 'i1', sku: 'S-1' }, i2: { id: 'i2', sku: 'S-2' } }
  const prices = { 'S-1': 10, 'S-2': 20 }

  const a = await createFed2Service(t, `
    ${LINK}
    type Query { items: [Item!]! }
    type Item @key(fields: "id") { id: ID! }
  `, { Query: { items: () => [{ id: 'i1' }, { id: 'i2' }] }, Item: { __resolveReference: ref => ref } })

  const b = await createFed2Service(t, `
    ${LINK}
    type Query { b: Int }
    type Item @key(fields: "id") @key(fields: "sku") { id: ID! sku: String! }
  `, { Item: { __resolveReference: ref => (ref.id ? items[ref.id] : Object.values(items).find(i => i.sku === ref.sku)) } })

  const c = await createFed2Service(t, `
    ${LINK}
    type Query { c: Int }
    type Item @key(fields: "sku") { sku: String! price: Int }
  `, { Item: { __resolveReference: ref => ({ sku: ref.sku, price: prices[ref.sku] }) } })

  const gateway = Fastify()
  t.after(() => gateway.close())
  await gateway.register(plugin, { gateway: { services: [{ name: 'a', url: a.url }, { name: 'b', url: b.url }, { name: 'c', url: c.url }] } })

  const res = await gateway.inject({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    url: '/graphql',
    body: JSON.stringify({ query: '{ items { id price } }' })
  })
  t.assert.deepStrictEqual(JSON.parse(res.body), { data: { items: [{ id: 'i1', price: 10 }, { id: 'i2', price: 20 }] } })

  t.assert.deepStrictEqual(b.requests[0].variables.representations, [{ __typename: 'Item', id: 'i1' }, { __typename: 'Item', id: 'i2' }])
  t.assert.deepStrictEqual(c.requests[0].variables.representations, [{ __typename: 'Item', sku: 'S-1' }, { __typename: 'Item', sku: 'S-2' }])
  t.assert.match(gateway.graphqlGateway.explain('{ items { price } }'), /Fetch\(graph: b, type: Item, key: "id"\)[\s\S]*Fetch\(graph: c, type: Item, key: "sku"\)/)
})
