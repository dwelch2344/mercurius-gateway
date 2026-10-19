'use strict'

const { test } = require('node:test')
const { parseFieldSet, printFieldSet, satisfiedBy, pick } = require('../../lib/compose/field-set')

test('parseFieldSet / printFieldSet round-trip and normalise whitespace', t => {
  const set = parseFieldSet('sku   variation {  id }')
  t.assert.strictEqual(set.selections.length, 2)
  t.assert.strictEqual(printFieldSet(set), 'sku variation { id }')
})

test('satisfiedBy checks nested selections, arrays and nulls', t => {
  const set = parseFieldSet('sku variation { id }')
  t.assert.strictEqual(satisfiedBy({ sku: 'a', variation: { id: 'x' } }, set), true)
  t.assert.strictEqual(satisfiedBy({ sku: 'a', variation: null }, set), true)
  t.assert.strictEqual(satisfiedBy({ sku: 'a', variation: {} }, set), false)
  t.assert.strictEqual(satisfiedBy({ sku: 'a' }, set), false)
  t.assert.strictEqual(satisfiedBy(null, set), false)
  const list = parseFieldSet('items { id }')
  t.assert.strictEqual(satisfiedBy({ items: [{ id: 1 }, null] }, list), true)
  t.assert.strictEqual(satisfiedBy({ items: [{ id: 1 }, {}] }, list), false)
})

test('pick copies only the selected fields', t => {
  const set = parseFieldSet('sku variation { id } items { id }')
  t.assert.deepStrictEqual(
    pick({ sku: 'a', extra: 1, variation: { id: 'x', name: 'n' }, items: [{ id: 1, z: 2 }, null] }, set),
    { sku: 'a', variation: { id: 'x' }, items: [{ id: 1 }, null] }
  )
  t.assert.deepStrictEqual(pick({ sku: 'a', variation: null }, set), { sku: 'a', variation: null })
})
