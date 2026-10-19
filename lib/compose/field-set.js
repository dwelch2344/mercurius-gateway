'use strict'

const { parse, Kind, print } = require('graphql')

/**
 * Parse a federation FieldSet string (the argument of @key/@requires/@provides,
 * e.g. `sku variation { id }`) into a graphql-js SelectionSet node.
 */
function parseFieldSet (fields) {
  const document = parse(`{ ${fields} }`, { noLocation: true })
  return document.definitions[0].selectionSet
}

/**
 * Canonical string form of a FieldSet (whitespace-normalised), used as a key
 * when de-duplicating.
 */
function printFieldSet (selectionSet) {
  return print(selectionSet).replace(/\s+/g, ' ').replace(/^\{ ?/, '').replace(/ ?\}$/, '').trim()
}

/**
 * True when `obj` carries every field of `selectionSet` (recursively for nested
 * selections, element-wise for arrays). Used to decide whether a representation
 * for a given @key can be built from data we already hold.
 */
function satisfiedBy (obj, selectionSet) {
  if (obj === null || typeof obj !== 'object') {
    return false
  }
  for (const selection of selectionSet.selections) {
    /* istanbul ignore next: FieldSets only contain fields */
    if (selection.kind !== Kind.FIELD) continue
    const name = selection.name.value
    const value = obj[name]
    if (value === undefined) {
      return false
    }
    if (selection.selectionSet) {
      if (value === null) continue
      if (Array.isArray(value)) {
        if (!value.every(item => item === null || satisfiedBy(item, selection.selectionSet))) {
          return false
        }
      } else if (!satisfiedBy(value, selection.selectionSet)) {
        return false
      }
    }
  }
  return true
}

/**
 * Copy only the fields named by `selectionSet` out of `obj` (recursively).
 */
function pick (obj, selectionSet) {
  const result = {}
  for (const selection of selectionSet.selections) {
    /* istanbul ignore next: FieldSets only contain fields */
    if (selection.kind !== Kind.FIELD) continue
    const name = selection.name.value
    const value = obj[name]
    if (value === undefined) continue
    if (selection.selectionSet && value !== null && typeof value === 'object') {
      result[name] = Array.isArray(value)
        ? value.map(item => (item === null ? null : pick(item, selection.selectionSet)))
        : pick(value, selection.selectionSet)
    } else {
      result[name] = value
    }
  }
  return result
}

module.exports = { parseFieldSet, printFieldSet, satisfiedBy, pick }
