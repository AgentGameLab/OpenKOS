#!/usr/bin/env node
// q-stale-chains.mjs — 找 superseded 节点的下游 incoming 引用，标"待迁移"
//
// 用法：node scripts/kg/queries/q-stale-chains.mjs
//
// 逻辑：
//   1. 找所有 status: superseded 或带 superseded_by 边的节点 X
//   2. 对每个 X，遍历 incoming "references" / "related" 边 → 下游节点 Y
//   3. Y 仍引用 X（已 superseded） = 待迁移
//   4. 过滤"intentional historical context"假阳性（v1.1, 2026-05-15）：
//      - upstream frontmatter `supersedes:` / `amends:` / `superseded_by:` 含 target
//      - upstream `related:` 数组里 target 行带"superseded/取代/废/amend"措辞
//      - upstream body 含 target 的 basename + "superseded by | supersedes | 已废 | 取代" 同行
//   5. 输出 markdown 表

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGraph, indexNodes, indexEdges, fmtTable, isIntentionalHistoricalRef } from './_lib.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

const graph = loadGraph()
const byId = indexNodes(graph)
const { in: inEdges } = indexEdges(graph)

// supersededIds: 只信节点自身 status，不从 superseded_by/supersedes 边推断。
// 实证（2026-05-29 KOS audit）：边推断在当前图 100% 假阳性 ——
//   (1) KG gen 会造反向 superseded_by 边（如 ADR-025 Proposed 活提案被误标退役、
//       ADR-007 accepted 被误标），(2) `supersedes` 边的 from 是「取代方」(更新节点, 非被取代)。
//   真正退役的节点（adr-014 / adr-027 / ADR-007a / ADR-008）全部已正确设 status: superseded*，
//   故只读 status 零漏检 + 清掉全部假阳性。
const supersededIds = new Set()
for (const n of graph.nodes || []) {
  const s = (n.status || '').toLowerCase()
  if (s.startsWith('superseded') || s.startsWith('deprecated')) {
    supersededIds.add(n.id)
  }
}

// isIntentionalHistoricalRef + 文件读取/ADR 短引用 helper 已抽到 _lib.mjs 共享
// （2026-05-29 KOS audit: 让 q-lint 复用同一过滤逻辑，stale 计数对齐）

const rows = []
const skipped = []
for (const id of supersededIds) {
  const node = byId.get(id)
  const incoming = inEdges.get(id) || []
  const stale = incoming.filter(e => e.label === 'references' || e.label === 'related')
  for (const e of stale) {
    const upstream = byId.get(e.from)
    if (isIntentionalHistoricalRef(e.from, id)) {
      skipped.push([e.from, e.label, id, 'intentional historical ref'])
      continue
    }
    rows.push([
      e.from,
      e.label,
      id,
      node?.status || '?',
      upstream?.maturity || '?',
    ])
  }
}

console.log(`# q-stale-chains · ${new Date().toISOString()}`)
console.log('')
if (rows.length === 0) {
  console.log(`✓ No stale chains (${skipped.length} intentional historical ref(s) filtered out)`)
  if (skipped.length > 0) {
    console.log('')
    console.log('## Filtered historical refs (for verification only, not pending migration)：')
    console.log('')
    console.log(fmtTable(
      ['upstream', 'edge', 'target', 'reason'],
      skipped.sort((a, b) => a[0].localeCompare(b[0]))
    ))
  }
  process.exit(0)
}

console.log(`Found ${rows.length} stale reference(s) → pending migration:`)
console.log('')
console.log(fmtTable(
  ['upstream (still referencing)', 'edge', 'superseded target', 'target status', 'upstream maturity'],
  rows.sort((a, b) => a[0].localeCompare(b[0]))
))
console.log('')
console.log(`> Action: upstream nodes should repoint their reference at the target's ${supersededIds.size > 0 ? 'superseded_by' : 'replacement'}.`)
if (skipped.length > 0) {
  console.log('')
  console.log(`(${skipped.length} more intentional historical ref(s) filtered out by the v1.1 frontmatter/body heuristics)`)
}
