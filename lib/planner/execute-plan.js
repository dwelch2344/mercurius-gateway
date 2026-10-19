'use strict'

const { preGatewayExecutionHandler } = require('../handlers')
const { collect } = require('../collectors')
const { FederatedError, addErrorsToContext } = require('../errors')
const { buildRepresentation } = require('./build-query-plan')

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Merge `source` into `target` in place: nested plain objects merge
 * recursively, arrays merge element-wise, anything else is overwritten.
 */
function deepMerge (target, source) {
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key]
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      deepMerge(targetValue, sourceValue)
    } else if (Array.isArray(sourceValue) && Array.isArray(targetValue) && sourceValue.length === targetValue.length) {
      for (let i = 0; i < sourceValue.length; i++) {
        if (isPlainObject(sourceValue[i]) && isPlainObject(targetValue[i])) {
          deepMerge(targetValue[i], sourceValue[i])
        } else {
          targetValue[i] = sourceValue[i]
        }
      }
    } else {
      target[key] = sourceValue
    }
  }
  return target
}

/**
 * All objects found at `path` in `data` ('@' descends into arrays), with the
 * concrete response path of each.
 */
function collectAt (data, path) {
  let current = [{ value: data, path: [] }]
  for (const segment of path) {
    const next = []
    for (const { value, path: valuePath } of current) {
      if (segment === '@') {
        if (!Array.isArray(value)) continue
        value.forEach((item, i) => {
          if (item !== null && item !== undefined) next.push({ value: item, path: [...valuePath, i] })
        })
      } else {
        const item = value === null || value === undefined ? undefined : value[segment]
        if (item !== null && item !== undefined) next.push({ value: item, path: [...valuePath, segment] })
      }
    }
    current = next
  }
  return current
}

/**
 * Does this parent object belong to the entity fetch? Objects at an abstract
 * position must carry a matching __typename; at a concrete position a missing
 * __typename (a subgraph that ignored the request for it) is tolerated.
 */
function matchesEntity (value, node) {
  if (value.__typename === node.entityType) return true
  if (value.__typename === node.representationType) return true
  return value.__typename === undefined && !node.parentAbstract
}

/**
 * Response keys an entity fetch fills in on the parent object: its fields,
 * including those inside inline fragments.
 */
function responseKeysOf (selections, acc = []) {
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      acc.push(selection.alias ? selection.alias.value : selection.name.value)
    } else if (selection.kind === 'InlineFragment') {
      responseKeysOf(selection.selectionSet.selections, acc)
    }
  }
  return acc
}

/**
 * Group the parent objects of an entity fetch by representation, so each
 * distinct entity is requested once.
 */
function groupRepresentations (node, parents) {
  const groups = []
  const groupIndex = new Map()
  for (const parent of parents) {
    const representation = buildRepresentation(parent.value, node)
    if (representation === null) continue
    const key = JSON.stringify(representation)
    let index = groupIndex.get(key)
    if (index === undefined) {
      index = groups.length
      groupIndex.set(key, index)
      groups.push({ representation, parents: [] })
    }
    groups[index].parents.push(parent)
  }
  return groups
}

/**
 * Errors a subgraph reports next to partial `_entities` data were already
 * added to the context by the request layer; point their paths at the
 * gateway response instead of `_entities[i]`.
 */
function rewriteEntityPaths (errors, groups) {
  for (const error of errors) {
    if (!Array.isArray(error.path) || error.path[0] !== '_entities') continue
    const group = groups[error.path[1]]
    /* istanbul ignore next: subgraphs only report paths for representations we sent */
    if (!group) continue
    error.path = [...group.parents[0].path, ...error.path.slice(2)]
  }
}

function pickVariables (node, variables) {
  const result = {}
  if (!variables) return result
  for (const name of node.variableNames) {
    if (name in variables) result[name] = variables[name]
  }
  return result
}

class PlanExecutor {
  constructor ({ context, variables, serviceMap }) {
    this.context = context
    this.variables = variables || {}
    this.serviceMap = serviceMap
    this.reply = context.reply
    this.data = {}
    this.rootErrors = new Map()
  }

  service (graph) {
    const service = this.serviceMap[graph]
    /* istanbul ignore next: the plan only references composed subgraphs */
    if (!service) throw new Error(`Unknown subgraph "${graph}"`)
    return service
  }

  /**
   * Run the preGatewayExecution hooks for a fetch. Hooks run one fetch at a
   * time (deterministic error order) even when the requests go out in parallel.
   */
  async prepare (node) {
    const service = this.service(node.graph)
    const { context } = this
    if (context.gateway && context.gateway.preGatewayExecution !== null) {
      const { modifiedQuery } = await preGatewayExecutionHandler({
        schema: service.schema,
        document: node.documentNode,
        context,
        service
      })
      if (modifiedQuery) return modifiedQuery
    }
    return node.document
  }

  async send (node, query, variables, queryIds) {
    const service = this.service(node.graph)
    const response = await this.request(service, { query, variables })
    this.afterResponse(service, response, queryIds)
    return response
  }

  /**
   * One HTTP request carrying several operations (`allowBatchedQueries`).
   * Returns one outcome ({ response } or { error }) per operation, in order.
   */
  async sendBatch (graph, operations) {
    const service = this.service(graph)
    const response = await this.request(service, operations.map(({ query, variables }) => ({ query, variables })))
    const results = Array.isArray(response.json) ? response.json : []
    return operations.map((operation, i) => {
      const json = results[i] || { data: null, errors: [{ message: `missing batched response ${i} from "${service.name}"` }] }
      if (json.errors && json.errors.length) {
        if (json.data == null) {
          return { error: new FederatedError(json.errors) }
        }
        addErrorsToContext(this.context, json.errors)
      }
      const single = { statusCode: response.statusCode, headers: response.headers, json }
      this.afterResponse(service, single, operation.queryIds)
      return { response: single }
    })
  }

  request (service, body) {
    return service.sendRequest({
      method: 'POST',
      body: JSON.stringify(body),
      originalRequestHeaders: this.reply ? this.reply.request.headers : {},
      context: this.context
    })
  }

  afterResponse (service, response, queryIds) {
    if (service.collectors) {
      for (const queryId of queryIds) {
        collect({ collectors: service.collectors, context: this.context, queryId, response, serviceName: service.name })
      }
    }
    service.setResponseHeaders(this.reply || {})
  }

  async run (plan) {
    if (plan.ordered) {
      for (const root of plan.roots) {
        await this.runRoot(root, await this.prepare(root))
      }
    } else {
      const queries = []
      for (const root of plan.roots) queries.push(await this.prepare(root))
      await Promise.all(plan.roots.map((root, i) => this.runRoot(root, queries[i])))
    }
    return { data: this.data, rootErrors: this.rootErrors }
  }

  async runRoot (node, query) {
    let response
    try {
      response = await this.send(node, query, pickVariables(node, this.variables), node.responseKeys)
    } catch (err) {
      for (const key of node.responseKeys) this.rootErrors.set(key, err)
      return
    }
    const data = response.json.data || {}
    for (const key of node.responseKeys) {
      this.data[key] = data[key] === undefined ? null : data[key]
    }
    await this.runChildren(node)
  }

  /**
   * Execute the children of `node` against the data gathered so far: all in
   * parallel, each followed by its own children. `rootData` lets a caller
   * (subscriptions) run the entity hops of a plan over an externally supplied
   * payload. Sibling fetches to a subgraph that accepts batched queries share
   * one HTTP request.
   */
  async runChildren (node, rootData = this.data) {
    const pending = []
    for (const child of node.children) {
      const parents = collectAt(rootData, child.path)
        .filter(({ value }) => isPlainObject(value) && matchesEntity(value, child))
      if (parents.length === 0) continue
      const groups = groupRepresentations(child, parents)
      if (groups.length === 0) continue
      const variables = {
        ...pickVariables(child, this.variables),
        representations: groups.map(g => g.representation)
      }
      pending.push({ child, groups, variables, query: await this.prepare(child), queryIds: [child.path.join('.')] })
    }

    const batches = new Map()
    const runs = []
    for (const item of pending) {
      if (this.service(item.child.graph).allowBatchedQueries) {
        if (!batches.has(item.child.graph)) batches.set(item.child.graph, [])
        batches.get(item.child.graph).push(item)
      } else {
        runs.push(this.runSingle(item, rootData))
      }
    }
    for (const [graph, items] of batches) {
      runs.push(items.length === 1 ? this.runSingle(items[0], rootData) : this.runBatch(graph, items, rootData))
    }
    await Promise.all(runs)
  }

  async runSingle (item, rootData) {
    let outcome
    try {
      outcome = { response: await this.send(item.child, item.query, item.variables, item.queryIds) }
    } catch (error) {
      outcome = { error }
    }
    await this.finishEntity(item, outcome, rootData)
  }

  async runBatch (graph, items, rootData) {
    let outcomes
    try {
      outcomes = await this.sendBatch(graph, items)
    } catch (error) {
      outcomes = items.map(() => ({ error }))
    }
    await Promise.all(items.map((item, i) => this.finishEntity(item, outcomes[i], rootData)))
  }

  /**
   * Merge the outcome of an entity fetch into its parent objects, then run
   * the fetches that depend on it.
   */
  async finishEntity ({ child: node, groups }, outcome, rootData) {
    const responseKeys = responseKeysOf(node.selections)

    if (outcome.error) {
      this.recordEntityError(outcome.error, groups)
      for (const group of groups) {
        for (const parent of group.parents) {
          this.nullify(parent, node, responseKeys, rootData)
        }
      }
      return
    }

    const { response } = outcome
    const entities = (response.json.data && response.json.data._entities) || []
    if (response.json.errors) rewriteEntityPaths(response.json.errors, groups)

    for (let i = 0; i < groups.length; i++) {
      const entity = entities[i]
      for (const parent of groups[i].parents) {
        if (entity === null || entity === undefined) {
          this.nullify(parent, node, responseKeys, rootData)
        } else {
          if (node.representationType !== node.entityType) {
            // an @interfaceObject subgraph answers with the interface name; keep the concrete type
            delete entity.__typename
          }
          deepMerge(parent.value, entity)
        }
      }
    }
    await this.runChildren(node, rootData)
  }

  /**
   * The subgraph could not resolve the entity. When the parent object is a bare
   * reference (it only carries __typename and key fields) the whole object
   * becomes null, mirroring a reference resolver returning null; otherwise
   * only the fields this fetch was responsible for become null.
   */
  nullify (parent, node, responseKeys, rootData) {
    const keyNames = new Set(['__typename', ...node.keyFields.selections.map(s => s.name.value)])
    const isBareReference = Object.keys(parent.value).every(k => keyNames.has(k))
    if (isBareReference && parent.path.length > 0) {
      const containerPath = parent.path.slice(0, -1)
      const last = parent.path[parent.path.length - 1]
      let container = rootData
      for (const segment of containerPath) container = container[segment]
      container[last] = null
      return
    }
    for (const key of responseKeys) parent.value[key] = null
  }

  recordEntityError (err, groups) {
    const errors = err instanceof FederatedError && Array.isArray(err.extensions.errors)
      ? err.extensions.errors
      : [err]
    const rewritten = errors.map(error => {
      if (!Array.isArray(error.path) || error.path[0] !== '_entities') return error
      const group = groups[error.path[1]]
      /* istanbul ignore next: subgraphs only report paths for representations we sent */
      if (!group) return error
      return { ...error, message: error.message, path: [...group.parents[0].path, ...error.path.slice(2)] }
    })
    addErrorsToContext(this.context, rewritten)
  }
}

async function executePlan (plan, options) {
  const executor = new PlanExecutor(options)
  return executor.run(plan)
}

module.exports = { executePlan, PlanExecutor, collectAt, deepMerge }
