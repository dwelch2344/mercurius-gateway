'use strict'

const createError = require('@fastify/error')

module.exports = {
  MER_ERR_GQL_GATEWAY_PLANNING: createError(
    'MER_ERR_GQL_GATEWAY_PLANNING',
    'Query planning failed: %s'
  ),
  MER_ERR_GQL_GATEWAY_PLANNING_UNSUPPORTED: createError(
    'MER_ERR_GQL_GATEWAY_PLANNING_UNSUPPORTED',
    'Query planning does not support this yet: %s'
  )
}
