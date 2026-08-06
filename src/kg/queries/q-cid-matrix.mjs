#!/usr/bin/env node
// q-cid-matrix.mjs — 改动影响检测矩阵（Change Impact Detection）
// 给定 git diff 或文件列表，自动输出：
//   - 涉及的规则/playbook（通过 implements 边反查）
//   - 规则对应的 Owner（governs_paths 推导）
//   - 需要同步的文档（rule.related 字段）
//   - 是否有 data_source=both 的危险文件（DB split-brain 风险）
//
// 用法：
//   git diff main...HEAD | node scripts/kg/queries/q-cid-matrix.mjs
//   node scripts/kg/queries/q-cid-matrix.mjs --staged
//   node scripts/kg/queries/q-cid-matrix.mjs --files src/app/api/town/a2a/send/route.ts src/lib/db.ts
//   node scripts/kg/queries/q-cid-matrix.mjs --json

import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { loadRoster } from '../../kos/roster.mjs'
import { loadGraph, indexNodes, indexEdges } from './_lib.mjs'

const roster = loadRoster()
const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const staged = args.includes('--staged')
const filesArgIdx = args.indexOf('--files')
const fileListArg = filesArgIdx !== -1 ? args.slice(filesArgIdx + 1) : null

// ── 获取变动文件列表 ──────────────────────────────────────────────────────────
async function getChangedFiles() {
  if (fileListArg?.length) return fileListArg

  let diffText
  if (staged) {
    try { diffText = execSync('git diff --cached', { encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }) }
    catch { console.error('git diff --cached failed'); process.exit(1) }
  } else if (!process.stdin.isTTY) {
    const chunks = []
    process.stdin.resume()
    for await (const chunk of process.stdin) chunks.push(chunk)
    diffText = Buffer.concat(chunks).toString('utf-8')
  } else {
    try { diffText = execSync('git diff main...HEAD', { encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }) }
    catch {
      try { diffText = execSync('git diff origin/main...HEAD', { encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }) }
      catch { console.error('无法获取 diff，请通过 stdin 或 --files 提供'); process.exit(1) }
    }
  }

  const files = new Set()
  for (const line of diffText.split('\n')) {
    const m = line.match(/^diff --git .+ b\/(.+)$/)
    if (m) files.add(m[1])
  }
  return [...files]
}

const changedFiles = await getChangedFiles()

// ── 加载图 ───────────────────────────────────────────────────────────────────
const graph = loadGraph()
const byId = indexNodes(graph)
const { out: outEdges, in: inEdges } = indexEdges(graph)

// ── 对每个改动文件做影响分析 ─────────────────────────────────────────────────
const results = []
const globalRules = new Map()   // ruleId → node
const globalDocs = new Set()
let splitBrainFiles = []

for (const file of changedFiles) {
  // 在图里找最佳匹配节点（以 file 路径为 substring 匹配）
  const matchedIds = [...byId.entries()].filter(([id, n]) => {
    const cp = n.canonical_path || id.replace(/^\.\.\/code-repo\//, '')
    return id.includes(file) || file.includes(cp) || cp.includes(file)
  }).map(([id]) => id)
  const nodeId = matchedIds[0] || null
  const node = nodeId ? byId.get(nodeId) : null

  // data_source=both 预警
  if (node?.data_source === 'both') splitBrainFiles.push(file)

  // 通过 implements 边找关联规则
  const implEdges = nodeId ? (inEdges.get(nodeId) || []).filter(e => e.label === 'governs') : []
  // governs 入边 from = rule/playbook，反向即 implements
  const ruleIds = implEdges.map(e => e.from)

  for (const ruleId of ruleIds) {
    const ruleNode = byId.get(ruleId)
    if (!ruleNode) continue
    globalRules.set(ruleId, ruleNode)
    // related 文档也要同步
    const related = ruleNode.related || []
    for (const r of related) globalDocs.add(r)
  }

  results.push({
    file,
    nodeId,
    data_source: node?.data_source || 'unknown',
    ruleIds,
  })
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
if (jsonMode) {
  console.log(JSON.stringify({
    changed_files: changedFiles.length,
    split_brain_risk: splitBrainFiles,
    impacted_rules: [...globalRules.entries()].map(([id, n]) => ({
      id,
      name: n.name,
      type: n.type,
      maturity: n.maturity,
    })),
    docs_to_sync: [...globalDocs],
    per_file: results,
  }, null, 2))
  process.exit(splitBrainFiles.length > 0 ? 1 : 0)
}

console.log('# q-cid-matrix — 改动影响矩阵')
console.log('')
console.log(`改动文件: ${changedFiles.length}`)
console.log('')

// split-brain 风险
if (splitBrainFiles.length > 0) {
  console.log('## 🚨 DB split-brain 风险文件')
  console.log('')
  for (const f of splitBrainFiles) console.log(`  - ${f}  (data_source=both: Supabase + Drizzle 同时出现)`)
  console.log('')
}

// 涉及规则
if (globalRules.size > 0) {
  console.log('## 涉及规则/Playbook（需确认仍满足）')
  console.log('')
  for (const [id, n] of globalRules) {
    const matBadge = n.maturity === 'proven' ? ' ★proven' : n.maturity ? ` (${n.maturity})` : ''
    console.log(`  - [${n.type}] ${n.name}${matBadge}`)
    console.log(`    ${id}`)
  }
  console.log('')
} else {
  console.log('## 涉及规则')
  console.log('')
  console.log('  (无 governs 边命中改动文件，可能是新路径或图未覆盖)')
  console.log('')
}

// 需要同步的文档
if (globalDocs.size > 0) {
  console.log('## 需同步文档')
  console.log('')
  for (const d of globalDocs) console.log(`  - ${d}`)
  console.log('')
}

// per-file 明细
console.log('## 文件明细')
console.log('')
for (const { file, data_source, ruleIds } of results) {
  const ds = data_source !== 'none' && data_source !== 'unknown' ? ` [${data_source}]` : ''
  const rules = ruleIds.length > 0 ? ` → ${ruleIds.length} 条规则` : ' → 无规则覆盖'
  console.log(`  ${file}${ds}${rules}`)
}

console.log('')
console.log(`> 如有 ★proven 规则涉及，改动前建议 ${roster.roles.approver} review。`)
process.exit(splitBrainFiles.length > 0 ? 1 : 0)
