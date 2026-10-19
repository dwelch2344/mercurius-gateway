'use strict'

const createError = require('@fastify/error')

const MER_ERR_GQL_GATEWAY_COMPOSITION = createError(
  'MER_ERR_GQL_GATEWAY_COMPOSITION',
  'Supergraph composition failed: %s'
)

/**
 * Wrap composition errors (GraphQLError[] from the composition library) into a
 * single MER_ERR_GQL_GATEWAY_COMPOSITION. Each original error is kept on
 * `err.errors`; its `extensions.code` (e.g. INVALID_FIELD_SHARING) is preserved.
 */
function compositionError (errors) {
  const summary = errors.map(e => {
    const code = e.extensions && e.extensions.code ? `[${e.extensions.code}] ` : ''
    return `${code}${e.message}`
  }).join('; ')
  const err = new MER_ERR_GQL_GATEWAY_COMPOSITION(summary)
  err.errors = errors
  return err
}

module.exports = { MER_ERR_GQL_GATEWAY_COMPOSITION, compositionError }
