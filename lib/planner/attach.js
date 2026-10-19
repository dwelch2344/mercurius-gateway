'use strict'

const { isObjectType, isIntrospectionType, parse, validate, getOperationAST } = require('graphql')
const { buildQueryPlan } = require('./build-query-plan')
const { PlanExecutor } = require('./execute-plan')
const { printPlan } = require('./print-plan')
const { preGatewaySubscriptionExecutionHandler } = require('../handlers')
const { MER_ERR_GQL_GATEWAY_PLANNING } = require('./errors')

const kPlanRun = Symbol('mercurius.gateway.plan-run')
const kQueryPlan = Symbol('mercurius.gateway.query-plan')

function readFromParent (parent, args, context, info) {
  return parent === null || parent === undefined ? parent : parent[info.path.key]
}

function pickVariables (node, variables) {
  const result = {}
  for (const name of node.variableNames) {
    if (variables && name in variables) result[name] = variables[name]
  }
  return result
}

/**
 * Attach the planner to an executable gateway schema.
 *
 * Root fields (Query/Mutation) share one plan execution per request: the first
 * root resolver to run plans the whole operation (from `info.operation`),
 * executes it, and every root resolver returns its slice of the result.
 * Every other object field reads from its parent. Subscription root fields
 * subscribe to the owning subgraph and run the plan's entity hops on each
 * event.
 *
 * Plans are cached per operation AST node (mercurius caches parsed documents,
 * so repeated queries hit the cache; documents rewritten by hooks are planned
 * afresh). `gateway.cache: false` disables plan caching.
 */
function attachPlanner ({ schema, planIndex, serviceMap, cachePlans = true }) {
  const plans = new WeakMap()

  function planFor (operation, fragments) {
    let plan = cachePlans ? plans.get(operation) : undefined
    if (!plan) {
      plan = buildQueryPlan({ schema, planIndex, operation, fragments })
      if (cachePlans) plans.set(operation, plan)
    }
    return plan
  }

  function startRun (context, info) {
    const plan = planFor(info.operation, info.fragments)
    context[kQueryPlan] = plan
    const executor = new PlanExecutor({ context, variables: info.variableValues, serviceMap })
    return executor.run(plan)
  }

  function rootResolver (parent, args, context, info) {
    let run = context[kPlanRun]
    if (!run) {
      run = startRun(context, info)
      context[kPlanRun] = run
    }
    return run.then(({ data, rootErrors }) => {
      const key = info.path.key
      if (rootErrors.has(key)) throw rootErrors.get(key)
      return data[key]
    })
  }

  async function subscriptionResolver (parent, args, context, info) {
    const plan = planFor(info.operation, info.fragments)
    context[kQueryPlan] = plan
    const node = plan.roots[0]
    const service = serviceMap[node.graph]
    const { pubsub } = context

    if (context.gateway.preGatewaySubscriptionExecution !== null) {
      await preGatewaySubscriptionExecutionHandler({
        schema: service.schema,
        document: node.documentNode,
        context,
        service
      })
    }

    const variables = pickVariables(node, info.variableValues)
    const subscriptionId = service.createSubscription(node.document, variables, pubsub.publish.bind(pubsub), context)
    context.gateway.subscriptionMap.set(context.id, { serviceName: service.name, subscriptionId })
    const iterator = await pubsub.subscribe(`${service.name}_${subscriptionId}`)

    if (node.children.length === 0) {
      return iterator
    }

    const executor = new PlanExecutor({ context, variables: info.variableValues, serviceMap })
    return (async function * () {
      for await (const payload of iterator) {
        await executor.runChildren(node, payload)
        yield payload
      }
    })()
  }

  const rootTypes = new Set([schema.getQueryType(), schema.getMutationType()].filter(Boolean).map(t => t.name))
  const subscriptionType = schema.getSubscriptionType()

  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || isIntrospectionType(type)) continue
    const isRoot = rootTypes.has(type.name)
    const isSubscription = subscriptionType && type.name === subscriptionType.name
    for (const field of Object.values(type.getFields())) {
      if (isSubscription) {
        field.subscribe = subscriptionResolver
        field.resolve = readFromParent
      } else if (isRoot) {
        field.resolve = rootResolver
      } else {
        field.resolve = readFromParent
      }
    }
  }

  /**
   * Public API: build (and optionally print) the plan for a query string.
   */
  function buildPlan (source, operationName) {
    const document = typeof source === 'string' ? parse(source) : source
    const errors = validate(schema, document)
    if (errors.length > 0) {
      const err = new MER_ERR_GQL_GATEWAY_PLANNING(errors.map(e => e.message).join('; '))
      err.errors = errors
      throw err
    }
    const operation = getOperationAST(document, operationName)
    if (!operation) {
      throw new MER_ERR_GQL_GATEWAY_PLANNING(`operation "${operationName}" not found`)
    }
    const fragments = {}
    for (const definition of document.definitions) {
      if (definition.kind === 'FragmentDefinition') fragments[definition.name.value] = definition
    }
    return buildQueryPlan({ schema, planIndex, operation, fragments })
  }

  return {
    buildQueryPlan: buildPlan,
    explain: (source, operationName) => printPlan(buildPlan(source, operationName))
  }
}

/**
 * JSON-serialisable view of a plan (for `extensions.queryPlan`).
 */
function serializePlan (plan) {
  const node = n => ({
    graph: n.graph,
    ...(n.entityType === null ? { responseKeys: n.responseKeys } : { entityType: n.entityType, representationType: n.representationType, path: n.path }),
    document: n.document,
    children: n.children.map(node)
  })
  return {
    operation: plan.operation,
    operationName: plan.operationName,
    ordered: plan.ordered,
    roots: plan.roots.map(node)
  }
}

module.exports = { attachPlanner, serializePlan, kPlanRun, kQueryPlan }
