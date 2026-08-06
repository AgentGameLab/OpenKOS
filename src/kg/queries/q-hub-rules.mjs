#!/usr/bin/env node
// q-hub-rules.mjs — degree centrality 排序，找改动影响面大的核心 rule
//
// 用法：node scripts/kg/queries/q-hub-rules.mjs [--top=10]
//
// 高中心度节点改动 → 影响面大 → 决策权重高（approver review 必要）
// 低中心度节点 → 叶子，daemon 自主修

import { loadRoster } from '../../kos/roster.mjs'
import { loadGraph, indexNodes, indexEdges, fmtTable } from './_lib.mjs'

const roster = loadRoster()
const args = process.argv.slice(2)
const topArg = args.find(a => a.startsWith('--top='))
const TOP = topArg ? parseInt(topArg.slice('--top='.length), 10) : 10

const graph = loadGraph()
const byId = indexNodes(graph)
const { out: outEdges, in: inEdges } = indexEdges(graph)

const ranked = []
for (const n of graph.nodes || []) {
  const out = (outEdges.get(n.id) || []).length
  const inDeg = (inEdges.get(n.id) || []).length
  ranked.push({
    id: n.id,
    name: n.name || n.id,
    type: n.type,
    maturity: n.maturity || '?',
    out_deg: out,
    in_deg: inDeg,
    total: out + inDeg,
  })
}

ranked.sort((a, b) => b.total - a.total)

console.log(`# q-hub-rules · top ${TOP}`)
console.log('')
console.log('按 degree centrality（in + out）排序——改动影响面最大的节点优先：')
console.log('')

console.log(fmtTable(
  ['rank', 'id', 'type', 'maturity', 'in', 'out', 'total'],
  ranked.slice(0, TOP).map((r, i) => [
    i + 1, r.id, r.type, r.maturity, r.in_deg, r.out_deg, r.total
  ])
))
console.log('')
console.log(`> 行动：top ${TOP} 节点的改动应触发 R6 三路广播 + ${roster.roles.approver} review。`)
console.log(`> 决策依据：高 centrality + proven maturity = 团队公约级，单方修改有破坏团队共识风险。`)
