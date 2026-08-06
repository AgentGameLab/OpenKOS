#!/usr/bin/env node
// q-sync-checklist.mjs — 给节点生成完整同步清单
// 组合 impact-radius（下游影响）+ rule-lookup（相关规则）+ 文档/Skill 检查
//
// 用法：node scripts/kg/queries/q-sync-checklist.mjs <node-id-substring>

import { loadGraph, indexNodes, indexEdges, fmtTable } from './_lib.mjs'

const args = process.argv.slice(2)
const target = args.find(a => !a.startsWith('--'))
const hopsArg = args.find(a => a.startsWith('--hops='))
const jsonMode = args.includes('--json')
const maxHops = hopsArg ? parseInt(hopsArg.slice(7), 10) : 2

if (!target) {
  console.error('Usage: q-sync-checklist.mjs <node-id-substring> [--hops=N] [--json]')
  process.exit(1)
}

const graph = loadGraph()
const byId = indexNodes(graph)
const { out: outEdges, in: inEdges } = indexEdges(graph)

// Normalize: users often type "src/..." but code-repo graph nodes use a synthetic prefix.
const normalizedTargets = [target, `../code-repo/${target}`]
const candidates = graph.nodes.filter(n => normalizedTargets.some(t => n.id.includes(t)))
if (candidates.length === 0) {
  console.error(`No nodes match "${target}"`)
  process.exit(1)
}
const startNode = candidates[0]
const startId = startNode.id

// ── 1. Impact radius（BFS 下游） ────────────────────────────────────────────
const visited = new Map() // id → {hop, via}
visited.set(startId, { hop: 0, via: '(self)' })
let frontier = [startId]
for (let hop = 1; hop <= maxHops; hop++) {
  const next = []
  for (const id of frontier) {
    for (const e of outEdges.get(id) || []) {
      if (!visited.has(e.to)) {
        visited.set(e.to, { hop, via: `→${e.label}→` })
        next.push(e.to)
      }
    }
  }
  frontier = next
  if (!frontier.length) break
}

// ── 2. Rule lookup（反向 governs 边） ────────────────────────────────────────
const relatedRules = new Map() // ruleId → node
for (const [id] of visited) {
  for (const e of inEdges.get(id) || []) {
    if (e.label !== 'governs') continue
    const ruleNode = byId.get(e.from)
    if (ruleNode) relatedRules.set(e.from, ruleNode)
  }
}

// ── 3. 分类下游节点 ────────────────────────────────────────────────────────
const impacted = [...visited.entries()]
  .filter(([id]) => id !== startId)
  .map(([id, info]) => ({ id, ...info, node: byId.get(id) }))

const byType = {
  rule: impacted.filter(x => x.node?.type === 'rule' || x.node?.type === 'rule-paths-scoped'),
  skill: impacted.filter(x => x.node?.type === 'skill'),
  doc: impacted.filter(x => x.node?.type === 'doc' || x.node?.type === 'decision'),
  hook: impacted.filter(x => x.node?.type === 'hook'),
  code: impacted.filter(x => x.node?.type === 'code-file' || x.node?.type === 'script'),
  other: impacted.filter(x => !['rule','rule-paths-scoped','skill','doc','decision','hook','code-file','script'].includes(x.node?.type)),
}

if (jsonMode) {
  console.log(JSON.stringify({
    start: { id: startId, type: startNode.type, name: startNode.name },
    impact_radius: impacted.map(x => ({ id: x.id, hop: x.hop, via: x.via, type: x.node?.type })),
    related_rules: [...relatedRules.values()].map(n => ({ id: n.id, name: n.name, topic: n.topic, maturity: n.maturity })),
    sync_items: {
      rules_to_check: byType.rule.map(x => x.id),
      skills_to_update: byType.skill.map(x => x.id),
      docs_to_update: byType.doc.map(x => x.id),
      hooks_affected: byType.hook.map(x => x.id),
      code_affected: byType.code.map(x => x.id),
    },
  }, null, 2))
  process.exit(0)
}

console.log(`# q-sync-checklist · ${startId}`)
console.log('')
console.log(`节点: ${startNode.name || startId} | 类型: ${startNode.type || '?'}`)
console.log('')

// 相关规则
console.log(`## ① 需要检查的规则 (${relatedRules.size})`)
if (relatedRules.size > 0) {
  console.log(fmtTable(
    ['rule', 'topic', 'maturity'],
    [...relatedRules.values()].map(n => [n.id, n.topic || '-', n.maturity || '-'])
  ))
} else {
  console.log('无显式 governs 规则 — 可在 rule frontmatter 加 governs_paths')
}
console.log('')

// 影响的 Skill/文档
console.log(`## ② 需要同步的 Skill/文档 (${byType.skill.length + byType.doc.length})`)
const syncDocs = [...byType.skill, ...byType.doc]
if (syncDocs.length > 0) {
  for (const x of syncDocs) console.log(`  - [ ] ${x.id}  _(${x.hop}-hop via ${x.via})_`)
} else {
  console.log('  无下游 Skill/文档节点')
}
console.log('')

// 影响的 Hook
console.log(`## ③ 受影响的 Hook (${byType.hook.length})`)
if (byType.hook.length > 0) {
  for (const x of byType.hook) console.log(`  - ${x.id}`)
} else {
  console.log('  无下游 Hook')
}
console.log('')

// 影响的代码
console.log(`## ④ 下游代码文件 (${byType.code.length})`)
if (byType.code.length > 0) {
  for (const x of byType.code.slice(0, 15)) console.log(`  - ${x.id}`)
  if (byType.code.length > 15) console.log(`  ... 及其他 ${byType.code.length - 15} 个`)
} else {
  console.log('  无下游代码节点')
}
console.log('')

const totalImpacted = impacted.length
console.log(`> 影响半径: ${totalImpacted} 节点 (${maxHops}-hop) | 相关规则: ${relatedRules.size}`)
