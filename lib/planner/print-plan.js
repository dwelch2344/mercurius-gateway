'use strict'

function indent (text, depth) {
  const pad = '  '.repeat(depth)
  return text.split('\n').map(line => (line.length ? pad + line : line)).join('\n')
}

function printNode (node, depth) {
  const lines = []
  if (node.entityType === null) {
    lines.push(indent(`Fetch(graph: ${node.graph}) {`, depth))
  } else {
    const key = node.keyFields ? require('../compose/field-set').printFieldSet(node.keyFields) : ''
    lines.push(indent(`Flatten(path: ${node.path.join('.')}) Fetch(graph: ${node.graph}, type: ${node.entityType}, key: "${key}") {`, depth))
  }
  lines.push(indent(node.document, depth + 1))
  if (node.children.length > 0) {
    lines.push(indent('then {', depth + 1))
    for (const child of node.children) lines.push(printNode(child, depth + 2))
    lines.push(indent('}', depth + 1))
  }
  lines.push(indent('}', depth))
  return lines.join('\n')
}

/**
 * Human-readable rendering of a query plan, for `explain()` and snapshots.
 */
function printPlan (plan) {
  const lines = [`QueryPlan(${plan.operation}${plan.operationName ? ` ${plan.operationName}` : ''}) {`]
  lines.push(indent(`${plan.ordered ? 'Sequence' : 'Parallel'} {`, 1))
  for (const root of plan.roots) lines.push(printNode(root, 2))
  lines.push(indent('}', 1))
  lines.push('}')
  return lines.join('\n')
}

module.exports = { printPlan }
