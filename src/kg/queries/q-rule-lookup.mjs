#!/usr/bin/env node
// q-rule-lookup.mjs — 给代码文件路径，找所有 governs 它的 rule/playbook 节点
//
// 用法：node scripts/kg/queries/q-rule-lookup.mjs <file-path-substring>
//   file-path-substring: 文件路径片段（如 "src/app/api/auth" 或 "a2a/transport"）

import { loadGraph, indexNodes, indexEdges, fmtTable } from './_lib.mjs'

const args = process.argv.slice(2)
const target = args.find(a => !a.startsWith('--'))
const jsonMode = args.includes('--json')

if (!target) {
  console.error('Usage: q-rule-lookup.mjs <file-path-substring>')
  process.exit(1)
}

const graph = loadGraph()
const byId = indexNodes(graph)
const { in: inEdges } = indexEdges(graph)

// 找所有匹配目标路径的节点
// Normalize: users often type "src/..." but code-repo graph nodes use a synthetic prefix.
const normalizedTargets = [target, `../code-repo/${target}`]
const matchedNodes = graph.nodes.filter(n => normalizedTargets.some(t => n.id.includes(t)))
if (matchedNodes.length === 0) {
  console.error(`No nodes match "${target}"`)
  process.exit(1)
}

// 对每个匹配节点，沿 governs 边反向找 rule/playbook
const ruleSet = new Map() // ruleId → {node, via: [fileId]}
for (const fileNode of matchedNodes) {
  const incoming = inEdges.get(fileNode.id) || []
  for (const e of incoming) {
    if (e.label !== 'governs') continue
    const ruleNode = byId.get(e.from)
    if (!ruleNode) continue
    if (!ruleSet.has(e.from)) ruleSet.set(e.from, { node: ruleNode, via: [] })
    ruleSet.get(e.from).via.push(fileNode.id)
  }
}

if (jsonMode) {
  const result = [...ruleSet.values()].map(({ node, via }) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    topic: node.topic,
    maturity: node.maturity,
    via,
  }))
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

console.log(`# q-rule-lookup · "${target}"`)
console.log('')
console.log(`匹配到 ${matchedNodes.length} 个文件节点，找到 ${ruleSet.size} 条相关规则`)
console.log('')

if (ruleSet.size === 0) {
  console.log('> 暂无通过 governs_paths 声明的覆盖规则。')
  console.log('> 如需建立关联，在 rule frontmatter 加 governs_paths: [<path-pattern>]')
  process.exit(0)
}

const rows = [...ruleSet.values()].sort((a, b) => {
  const mScore = { proven: 3, verified: 2, draft: 1 }
  return (mScore[b.node.maturity] || 0) - (mScore[a.node.maturity] || 0)
})

console.log(fmtTable(
  ['rule', 'type', 'topic', 'maturity'],
  rows.map(({ node }) => [node.id, node.type || '?', node.topic || '-', node.maturity || '-'])
))
console.log('')
console.log(`> proven 规则改动需升级 review；via governs_paths 显式声明。`)
