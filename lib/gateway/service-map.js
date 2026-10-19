'use strict'

const URL = require('url').URL

const { default: pmap } = require('p-map')
const { buildSchema, GraphQLSchema, GraphQLError } = require('graphql')

const { buildRequest, sendRequest } = require('./request')

const { SubscriptionClient } = require('@mercuriusjs/subscription-client')
const { MER_ERR_GQL_GATEWAY_INIT } = require('../errors')
const { buildFederationSchema } = require('@mercuriusjs/federation')

async function getWsOpts (service) {
  let opts = {
    serviceName: service.name,
    keepAlive: service.keepAlive
  }
  if (typeof service.wsConnectionParams === 'object') {
    opts = { ...opts, ...service.wsConnectionParams }
  } else if (typeof service.wsConnectionParams === 'function') {
    opts = { ...opts, ...(await service.wsConnectionParams()) }
  }

  return opts
}

async function getRemoteSchemaDefinition (serviceConfig, initHeaders) {
  let headers
  if (typeof initHeaders === 'function') {
    headers = await initHeaders()
  } else if (typeof initHeaders === 'object') {
    headers = initHeaders
  }

  const response = await serviceConfig.sendRequest({
    body: JSON.stringify({
      query: `
        query ServiceInfo {
          _service {
            sdl
          }
        }
        `
    }),
    headers
  })

  const {
    json: { data = null, error, message, statusCode }
  } = response

  if (data === null) {
    const err = new MER_ERR_GQL_GATEWAY_INIT()
    err.error = error
    err.message = message
    err.statusCode = statusCode

    throw err
  }

  return data._service.sdl
}

function safeBuildSchema (schemaDefinition) {
  try {
    return buildSchema(schemaDefinition)
  } catch (e) {
    return buildFederationSchema(schemaDefinition)
  }
}

async function buildServiceMap (serviceMap, services, errorHandler, log) {
  for (const service of services) {
    const {
      mandatory = false,
      initHeaders,
      useSecureParse = false,
      ...opts
    } = service

    const { request, close } = buildRequest(opts)
    const url = new URL(Array.isArray(opts.url) ? opts.url[0] : opts.url)

    const serviceConfig = {
      mandatory,
      url: Array.isArray(opts.url) ? opts.url[0] : opts.url,
      sendRequest: sendRequest(request, url, useSecureParse),
      setResponseHeaders: reply =>
        opts.setResponseHeaders ? opts.setResponseHeaders(reply) : null,
      close,
      async refresh () {
        // if this is using a supplied schema refresh is done manually with setSchema
        if (opts.schema) {
          return serviceConfig
        }

        const { schema, schemaDefinition } = await serviceConfig.init()

        serviceConfig.schema = schema
        serviceConfig.schemaDefinition = schemaDefinition
        serviceConfig.error = null

        return serviceConfig
      },
      async reconnectSubscription () {
        if (serviceConfig.client) {
          serviceConfig.client.close()

          const wsOpts = await getWsOpts(service)
          const client = new SubscriptionClient(service.wsUrl, wsOpts)

          client.connect()
          serviceConfig.client = client
          serviceConfig.createSubscription =
            client.createSubscription.bind(client)
          serviceConfig.unsubscribe = client.unsubscribe.bind(client)
        }
      },
      async init () {
        const schemaDefinition =
          opts.schema ||
          (await getRemoteSchemaDefinition(serviceConfig, initHeaders))

        // The service schema is handed to the preGatewayExecution hooks.
        const schema = safeBuildSchema(schemaDefinition)

        return { schema, schemaDefinition }
      },
      setSchema (schemaDefinition) {
        if (serviceConfig.schemaDefinition === schemaDefinition) {
          return serviceConfig
        }

        const schema = safeBuildSchema(schemaDefinition)

        serviceConfig.schema = schema
        serviceConfig.schemaDefinition = schemaDefinition

        return serviceConfig
      }
    }

    if (service.wsUrl) {
      const wsOpts = await getWsOpts(service)
      const client = new SubscriptionClient(service.wsUrl, wsOpts)
      client.connect()
      serviceConfig.client = client
      serviceConfig.createSubscription = client.createSubscription.bind(client)
      serviceConfig.unsubscribe = client.unsubscribe.bind(client)
    }

    serviceMap[service.name] = serviceConfig
  }

  const mapper = async service => {
    let serviceConfig
    let serviceConfigErr

    try {
      serviceConfig = await serviceMap[service.name].init()
    } catch (err) {
      serviceConfigErr = err
      if (!service.mandatory || err instanceof GraphQLError) {
        log.warn(
          `Initializing service "${service.name}" failed with message: "${err.message}"`
        )
        errorHandler(err, service)
      }
    }

    if (serviceConfig) {
      serviceMap[service.name].schema = serviceConfig.schema
      serviceMap[service.name].schemaDefinition = serviceConfig.schemaDefinition
      serviceMap[service.name].error = null
    } else {
      serviceMap[service.name].schema = new GraphQLSchema({})
      serviceMap[service.name].schemaDefinition = ''
      serviceMap[service.name].error = serviceConfigErr
    }

    serviceMap[service.name].name = service.name
    serviceMap[service.name].allowBatchedQueries = service.allowBatchedQueries
    serviceMap[service.name].collectors = service.collectors
  }

  await pmap(services, mapper, { concurrency: 8 })

  return serviceMap
}

module.exports = buildServiceMap
