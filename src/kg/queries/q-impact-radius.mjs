#!/usr/bin/env node
// q-impact-radius.mjs — 给定节点 ID，输出 N-hop 邻居（改动影响半径）
//
// 用法：node scripts/kg/queries/q-impact-radius.mjs <node-id> [--hops N]
//   node-id: 部分匹配（grep substring）或全路径
//   --hops: 默认 2

import { loadRoster } from '../../kos/roster.mjs'
import { loadGraph, indexNodes, indexEdges, fmtTable } from './_lib.mjs'

const roster = loadRoster()
const args = process.argv.slice(2)
const target = args.find(a => !a.startsWith('--'))
const hopsArg = args.find(a => a.startsWith('--hops='))
const maxHops = hopsArg ? parseInt(hopsArg.slice('--hops='.length), 10) : 2

if (!target) {
  console.error('Usage: q-impact-radius.mjs <node-id-substring> [--hops=N]')
  process.exit(1)
}

const graph = loadGraph()
const byId = indexNodes(graph)
const { out: outEdges, in: inEdges } = indexEdges(graph)

const candidates = [...byId.keys()].filter(id => id.includes(target))
if (candidates.length === 0) {
  console.error(`No node matches "${target}". Available sample: ${[...byId.keys()].slice(0, 5).join(', ')}`)
  process.exit(1)
}
if (candidates.length > 1) {
  console.error(`Ambiguous "${target}", matches:`)
  for (const c of candidates.slice(0, 10)) console.error(`  ${c}`)
  process.exit(1)
}

const startId = candidates[0]
const startNode = byId.get(startId)

// BFS 双向（incoming + outgoing）
const visited = new Map()  // id → {hop, paths: [edge labels]}
visited.set(startId, { hop: 0, via: '(self)' })

let frontier = [startId]
for (let hop = 1; hop <= maxHops; hop++) {
  const next = []
  for (const id of frontier) {
    const out = outEdges.get(id) || []
    const inE = inEdges.get(id) || []
    for (const e of out) {
      if (!visited.has(e.to)) {
        visited.set(e.to, { hop, via: `→${e.label}→` })
        next.push(e.to)
      }
    }
    for (const e of inE) {
      if (!visited.has(e.from)) {
        visited.set(e.from, { hop, via: `←${e.label}←` })
        next.push(e.from)
      }
    }
  }
  frontier = next
  if (frontier.length === 0) break
}

console.log(`# q-impact-radius · ${startId}`)
console.log('')
console.log(`Node: ${startNode.name || startId}`)
console.log(`Type: ${startNode.type || '?'} | maturity: ${startNode.maturity || '?'} | status: ${startNode.status || '?'}`)
console.log(`Radius: ${maxHops}-hop`)
console.log('')

const byHop = new Map()
for (const [id, info] of visited) {
  if (id === startId) continue
  if (!byHop.has(info.hop)) byHop.set(info.hop, [])
  byHop.get(info.hop).push({ id, via: info.via, node: byId.get(id) })
}

let totalImpacted = 0
for (let h = 1; h <= maxHops; h++) {
  const list = byHop.get(h) || []
  totalImpacted += list.length
  if (list.length === 0) continue
  console.log(`## ${h}-hop (${list.length} nodes)`)
  console.log('')
  console.log(fmtTable(
    ['id', 'via', 'type', 'maturity'],
    list.map(({ id, via, node }) => [id, via, node?.type || '?', node?.maturity || '?'])
  ))
  console.log('')
}

console.log(`> Change impact radius: ${totalImpacted} nodes (within ${maxHops}-hop)`)
console.log(`> Changes to high-maturity (proven) nodes should be escalated to ${roster.roles.approver} review.`)
