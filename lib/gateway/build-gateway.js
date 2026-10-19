'use strict'

const buildServiceMap = require('./service-map')
const { composeSupergraph } = require('../compose')
const { attachPlanner } = require('../planner/attach')
const {
  MER_ERR_GQL_GATEWAY_REFRESH,
  MER_ERR_GQL_GATEWAY_INIT,
  MER_ERR_SERVICE_RETRY_FAILED
} = require('../errors')

function defaultErrorHandler (error, service) {
  if (service.mandatory) {
    throw error
  }
}

async function resolveSupergraphSdl (gatewayOpts) {
  const { supergraphSdl } = gatewayOpts
  if (supergraphSdl === undefined || supergraphSdl === null) return null
  return typeof supergraphSdl === 'function' ? supergraphSdl() : supergraphSdl
}

/**
 * Compose the current service map into a schema + plan index and attach the
 * planner. Returns null when nothing (no SDL) is available.
 */
function composeServiceMap (serviceMap, supergraphSdl, app) {
  const services = []
  for (const [name, service] of Object.entries(serviceMap)) {
    if (service.error !== null) {
      app.log.warn(`Initializing service "${name}" failed with message: "${service.error.message}"`)
      continue
    }
    services.push({ name, url: service.url, schemaDefinition: service.schemaDefinition })
  }

  if (supergraphSdl) {
    const composed = composeSupergraph({ supergraphSdl })
    for (const graph of Object.keys(composed.planIndex.graphs)) {
      if (!serviceMap[graph]) {
        throw new MER_ERR_GQL_GATEWAY_INIT(`supergraph references subgraph "${graph}" which is not configured in "services"`)
      }
    }
    return composed
  }

  if (services.length < 1) return null
  return composeSupergraph({ services })
}

async function buildGateway (serviceMap, gatewayOpts, app, lruGatewayResolvers) {
  const { services, errorHandler = defaultErrorHandler } = gatewayOpts

  if (typeof services === 'function') {
    await buildServiceMap(serviceMap, await services(), errorHandler, app.log)
  } else {
    await buildServiceMap(serviceMap, services, errorHandler, app.log)
  }

  const supergraphSdl = await resolveSupergraphSdl(gatewayOpts)
  const composed = composeServiceMap(serviceMap, supergraphSdl, app)

  if (composed === null) {
    for (const service of Object.values(serviceMap)) {
      await service.close()
    }
    throw new MER_ERR_GQL_GATEWAY_INIT('No valid service SDLs were provided')
  }

  const cachePlans = lruGatewayResolvers !== null
  const planner = attachPlanner({ schema: composed.schema, planIndex: composed.planIndex, serviceMap, cachePlans })

  const close = async () => {
    for (const service of Object.values(serviceMap)) {
      await service.close()
    }
  }

  const gateway = {
    schema: composed.schema,
    planIndex: composed.planIndex,
    supergraphSdl: composed.supergraphSdl,
    publicSdl: composed.publicSdl,
    federationVersions: composed.federationVersions,
    buildQueryPlan: planner.buildQueryPlan,
    explain: planner.explain,
    serviceMap,
    subscriptionMap: new Map(),
    pollingInterval: gatewayOpts.pollingInterval,
    serviceFn: typeof gatewayOpts.services === 'function' ? gatewayOpts.services : undefined,
    // SDLs the current schema was composed from; refresh() is a no-op while
    // they are unchanged.
    _serviceSDLs: currentSdls(serviceMap, supergraphSdl),
    async refresh (isRetry) {
      const failedMandatoryServices = []

      if (this.serviceFn) {
        const newServices = await this.serviceFn()
        const oldServices = Object.keys(serviceMap)
        const addedServices = newServices.filter(({ name }) => !oldServices.includes(name))
        const deletedServices = oldServices.filter(name => !newServices.find(service => service.name === name))
        for (const name of deletedServices) {
          serviceMap[name].close().catch(() => {})
          delete serviceMap[name]
        }
        await buildServiceMap(serviceMap, addedServices, errorHandler, app.log)
      }

      const $refreshResult = await Promise.allSettled(
        Object.values(serviceMap).map(service =>
          service.refresh().catch(err => {
            // If non-mandatory service or if retry count has exceeded for mandatory service then throw
            if (!service.mandatory || !isRetry) {
              errorHandler(err, service)
            }

            // If service is mandatory and retry count has not exceeded then add to service to
            // failedMandatoryServices so it can be returned for retrying
            if (service.mandatory) {
              failedMandatoryServices.push(service)
            }
          })
        )
      )

      if (failedMandatoryServices.length > 0) {
        const serviceNames = failedMandatoryServices.map(
          service => service.name
        )
        const err = new MER_ERR_SERVICE_RETRY_FAILED(serviceNames.join(', '))
        err.failedServices = serviceNames
        throw err
      }

      const rejectedResults = $refreshResult
        .filter(({ status }) => status === 'rejected')
        .map(({ reason }) => reason)

      if (rejectedResults.length) {
        const err = new MER_ERR_GQL_GATEWAY_REFRESH()
        err.errors = rejectedResults
        throw err
      }

      const newSupergraphSdl = typeof gatewayOpts.supergraphSdl === 'function'
        ? await gatewayOpts.supergraphSdl()
        : supergraphSdl

      const _serviceSDLs = currentSdls(serviceMap, newSupergraphSdl)
      if (this._serviceSDLs === _serviceSDLs) {
        return null
      }
      this._serviceSDLs = _serviceSDLs

      await Promise.allSettled(
        Object.values(serviceMap).map(service =>
          service.reconnectSubscription()
        )
      )
      const recomposed = composeServiceMap(serviceMap, newSupergraphSdl, app)
      /* istanbul ignore next: refresh only runs on an already composed gateway */
      if (recomposed === null) {
        throw new MER_ERR_GQL_GATEWAY_REFRESH()
      }
      const planner = attachPlanner({ schema: recomposed.schema, planIndex: recomposed.planIndex, serviceMap, cachePlans })

      this.schema = recomposed.schema
      this.planIndex = recomposed.planIndex
      this.supergraphSdl = recomposed.supergraphSdl
      this.publicSdl = recomposed.publicSdl
      this.federationVersions = recomposed.federationVersions
      this.buildQueryPlan = planner.buildQueryPlan
      this.explain = planner.explain
      app.graphql.replaceSchema(this.schema)

      return this.schema
    },
    close
  }

  return gateway
}

function currentSdls (serviceMap, supergraphSdl) {
  if (supergraphSdl) return supergraphSdl
  return Object.values(serviceMap)
    .map(service => service.schemaDefinition)
    .join(' ')
}

module.exports = buildGateway
