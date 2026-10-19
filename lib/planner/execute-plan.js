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
  return value.__typename === undefined && !node.parentAbstract
}

function responseKeyOf (selection) {
  return selection.alias ? selection.alias.value : selection.name.value
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
    const { context } = this

    const response = await service.sendRequest({
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      originalRequestHeaders: this.reply ? this.reply.request.headers : {},
      context
    })

    if (service.collectors) {
      for (const queryId of queryIds) {
        collect({ collectors: service.collectors, context, queryId, response, serviceName: service.name })
      }
    }
    service.setResponseHeaders(this.reply || {})

    return response
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
   * payload.
   */
  async runChildren (node, rootData = this.data) {
    const pending = []
    for (const child of node.children) {
      const parents = collectAt(rootData, child.path)
        .filter(({ value }) => isPlainObject(value) && matchesEntity(value, child))
      if (parents.length === 0) continue
      pending.push({ child, parents, query: await this.prepare(child) })
    }
    await Promise.all(pending.map(async ({ child, parents, query }) => {
      const ok = await this.runEntity(child, parents, query, rootData)
      if (ok) await this.runChildren(child, rootData)
    }))
  }

  async runEntity (node, parents, query, rootData) {
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
    if (groups.length === 0) return false

    const variables = {
      ...pickVariables(node, this.variables),
      representations: groups.map(g => g.representation)
    }
    const responseKeys = node.selections.map(responseKeyOf)

    let entities
    try {
      const response = await this.send(node, query, variables, [node.path.join('.')])
      entities = (response.json.data && response.json.data._entities) || []
    } catch (err) {
      this.recordEntityError(err, groups)
      for (const group of groups) {
        for (const parent of group.parents) {
          this.nullify(parent, node, responseKeys, rootData)
        }
      }
      return false
    }

    for (let i = 0; i < groups.length; i++) {
      const entity = entities[i]
      for (const parent of groups[i].parents) {
        if (entity === null || entity === undefined) {
          this.nullify(parent, node, responseKeys, rootData)
        } else {
          deepMerge(parent.value, entity)
        }
      }
    }
    return true
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
