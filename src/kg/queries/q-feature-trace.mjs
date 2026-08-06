#!/usr/bin/env node
// q-feature-trace.mjs — 给定 feature/topic name，输出涉及所有节点 + 它们的 1-hop 邻居
//
// 用法：
//   node scripts/kg/queries/q-feature-trace.mjs <feature> [--hops=2]
//
// 示例：
//   q-feature-trace.mjs school        # 找 school 模块所有相关节点（含 rule + skill + code-file + doc）
//   q-feature-trace.mjs guest-claim
//   q-feature-trace.mjs cga2a
//
// 这是 q-find-file 的扩展版：找到匹配后再追溯 N-hop 邻居，给 agent 一次性看清整个 feature 的"知识 + 代码"上下文

import { loadGraph, indexEdges, fmtTable } from './_lib.mjs'

const args = process.argv.slice(2)
const feature = args.find(a => !a.startsWith('--'))
const hopsArg = args.find(a => a.startsWith('--hops='))
const HOPS = hopsArg ? parseInt(hopsArg.split('=')[1], 10) : 2

if (!feature) {
  console.error('Usage: q-feature-trace.mjs <feature> [--hops=N]')
  process.exit(1)
}

const graph = loadGraph()
const { out: outE, in: inE } = indexEdges(graph)
const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
const lower = feature.toLowerCase()

// 第一波：所有 id/name 含 keyword 的节点
const seeds = graph.nodes.filter(n => {
  const id = (n.id || '').toLowerCase()
  const name = (n.name || '').toLowerCase()
  return id.includes(lower) || name.includes(lower)
})

if (seeds.length === 0) {
  console.error(`✗ 无匹配 "${feature}"。试更短或更通用的关键词。`)
  process.exit(0)
}

// BFS 邻居
const visited = new Map()
for (const s of seeds) visited.set(s.id, { hop: 0, seed: true })
let frontier = seeds.map(s => s.id)
for (let h = 1; h <= HOPS; h++) {
  const next = []
  for (const id of frontier) {
    for (const e of (outE.get(id) || [])) {
      if (!visited.has(e.to)) {
        visited.set(e.to, { hop: h, via: `→${e.label}→` })
        next.push(e.to)
      }
    }
    for (const e of (inE.get(id) || [])) {
      if (!visited.has(e.from)) {
        visited.set(e.from, { hop: h, via: `←${e.label}←` })
        next.push(e.from)
      }
    }
  }
  frontier = next
  if (frontier.length === 0) break
}

const all = [...visited.entries()].map(([id, info]) => ({
  id,
  hop: info.hop,
  via: info.via || '(seed)',
  type: nodeMap.get(id)?.type || '?',
  subtype: nodeMap.get(id)?.subtype || '-',
  maturity: nodeMap.get(id)?.maturity || '-',
}))

// 按 type 分组输出
const byType = new Map()
for (const n of all) {
  if (!byType.has(n.type)) byType.set(n.type, [])
  byType.get(n.type).push(n)
}

console.log(`# q-feature-trace · "${feature}"`)
console.log('')
console.log(`Seed 节点: ${seeds.length}`)
console.log(`总涉及（${HOPS}-hop）: ${all.length} 节点`)
console.log('')

// 优先 high-impact type：rule / decision / skill > code-file > hook
const TYPE_ORDER = ['rule', 'decision', 'playbook', 'skill', 'skill-internal', 'doc', 'pointer', 'rule-paths-scoped', 'hook', 'code-file']

for (const type of TYPE_ORDER) {
  const list = byType.get(type) || []
  if (list.length === 0) continue
  console.log(`## ${type} (${list.length})`)
  console.log('')
  console.log(fmtTable(
    ['id', 'hop', 'subtype', 'maturity', 'via'],
    list.sort((a, b) => a.hop - b.hop || a.id.localeCompare(b.id))
        .slice(0, 25)
        .map(n => [n.id, n.hop, n.subtype, n.maturity, n.via])
  ))
  console.log('')
}

console.log(`> Agent 用法：seed (hop=0) 是关键词直接命中；hop≥1 是相关上下文。`)
console.log(`> 改 feature 时优先关注 rule/decision (高 leverage) + 高 maturity 节点。`)
