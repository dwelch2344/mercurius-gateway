'use strict'

const { lru } = require('tiny-lru')
const { MER_ERR_INVALID_OPTS } = require('./errors')

function buildCache (opts) {
  if (Object.prototype.hasOwnProperty.call(opts, 'cache')) {
    const isBoolean = typeof opts.cache === 'boolean'
    const isNumber = typeof opts.cache === 'number'

    if (isBoolean && opts.cache === false) {
      // no cache
      return null
    } else if (isNumber) {
      // cache size as specified
      return lru(opts.cache)
    } else if (!isBoolean && !isNumber) {
      throw new MER_ERR_INVALID_OPTS('Cache type is not supported')
    }
  }

  // default cache, 1024 entries
  return lru(1024)
}

module.exports = {
  buildCache
}
