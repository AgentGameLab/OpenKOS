#!/usr/bin/env node
// q-cold-leaves.mjs — 找叶子节点 + references count == 0 = cold candidate
//
// 用法：node scripts/kg/queries/q-cold-leaves.mjs [--days=60]
//
// 喂 COEF KPI-4 cold-rule-sweep + maturity 升降
// 叶子定义：incoming references 边数 == 0 且 type ∈ {rule, playbook}

import { loadRoster } from '../../kos/roster.mjs'
import { loadGraph, indexNodes, indexEdges, fmtTable } from './_lib.mjs'

const roster = loadRoster()
const args = process.argv.slice(2)
const daysArg = args.find(a => a.startsWith('--days='))
const days = daysArg ? parseInt(daysArg.slice('--days='.length), 10) : 60

const graph = loadGraph()
const byId = indexNodes(graph)
const { in: inEdges } = indexEdges(graph)

const cold = []
for (const n of graph.nodes || []) {
  if (!['rule', 'playbook'].includes(n.type)) continue
  if ((n.status || '').toLowerCase().startsWith('superseded')) continue  // 已替代不算 cold

  const incoming = inEdges.get(n.id) || []
  const refCount = incoming.filter(e => e.label === 'references').length

  if (refCount === 0) {
    cold.push({
      id: n.id,
      name: n.name || n.id,
      type: n.type,
      maturity: n.maturity || 'unknown',
      last_verified: n.last_verified || '?',
      incoming_total: incoming.length,
    })
  }
}

console.log(`# q-cold-leaves · ${new Date().toISOString()}`)
console.log('')
console.log(`Found ${cold.length} cold leaf candidate(s) (references=0, not superseded):`)
console.log('')

if (cold.length === 0) {
  console.log('✓ No cold leaf candidates — every rule/playbook is referenced at least once')
  process.exit(0)
}

cold.sort((a, b) => {
  // 优先顺序：maturity proven 在前（cold proven 最危险）+ last_verified 早的在前
  const mPri = { proven: 0, verified: 1, draft: 2, unknown: 3 }
  const am = mPri[a.maturity] ?? 3
  const bm = mPri[b.maturity] ?? 3
  if (am !== bm) return am - bm
  return (a.last_verified || '').localeCompare(b.last_verified || '')
})

console.log(fmtTable(
  ['id', 'maturity', 'last_verified', 'incoming_other_edges'],
  cold.map(c => [c.id, c.maturity, c.last_verified, c.incoming_total])
))
console.log('')
console.log(`> Suggested actions:`)
console.log(`> - **proven cold**: unusually high priority — once core, now 0 references; the whole topic may be obsolete. Have ${roster.roles.approver} review and decide between demotion and archiving`)
console.log(`> - **verified cold**: 0 references for >${days} days should drop back to draft (see memory-protocol §11)`)
console.log(`> - **draft cold**: promotion decision point (fold into a rule / archive / keep watching)`)
