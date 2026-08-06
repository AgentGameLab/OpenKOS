#!/usr/bin/env node
// q-find-file.mjs — Agent 直接通过 KG 找目标文件，不需要 Read + grep
//
// 用法：
//   node scripts/kg/queries/q-find-file.mjs <keyword> [--type=<filter>] [--limit=20]
//
// 示例：
//   q-find-file.mjs auth         # 找所有含 "auth" 的节点
//   q-find-file.mjs api/town --type=code-file --limit=10
//   q-find-file.mjs maturity --type=rule
//
// 让 agent 立即定位文件 — KG = 全仓导航索引

import { loadGraph, fmtTable } from './_lib.mjs'

const args = process.argv.slice(2)
const keyword = args.find(a => !a.startsWith('--'))
const typeArg = args.find(a => a.startsWith('--type='))
const limitArg = args.find(a => a.startsWith('--limit='))

if (!keyword) {
  console.error('Usage: q-find-file.mjs <keyword> [--type=<filter>] [--limit=N]')
  console.error('Available types: rule, playbook, decision, skill, skill-internal, doc, hook, code-file, rule-paths-scoped, pointer, script, cron-task')
  process.exit(1)
}

const TYPE = typeArg ? typeArg.split('=')[1] : null
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 20

const graph = loadGraph()
const lower = keyword.toLowerCase()

// 评分：
//   - id 含 keyword: 5 分
//   - id 全词匹配 (basename 等于 keyword): 10 分
//   - name 含: 3 分
//   - 同 dir 兄弟: 1 分
//   - subtype 匹配 (api-route 等): 2 分
function score(node) {
  let s = 0
  const id = (node.id || '').toLowerCase()
  const name = (node.name || '').toLowerCase()
  const subtype = (node.subtype || '').toLowerCase()

  if (id.includes(lower)) s += 5
  const stem = id.split(/[/\\]/).pop().replace(/\.\w+$/, '')
  if (stem === lower) s += 10
  if (name.includes(lower)) s += 3
  if (subtype.includes(lower)) s += 2
  return s
}

const matches = []
for (const node of graph.nodes || []) {
  if (TYPE && node.type !== TYPE) continue
  const s = score(node)
  if (s > 0) matches.push({ ...node, _score: s })
}

matches.sort((a, b) => b._score - a._score)

console.log(`# q-find-file · "${keyword}"${TYPE ? ` (type=${TYPE})` : ''}`)
console.log('')
console.log(`找到 ${matches.length} 个匹配节点（top ${Math.min(LIMIT, matches.length)} 显示）:`)
console.log('')

if (matches.length === 0) {
  console.log(`✗ 无匹配。建议：`)
  console.log(`  - 用更短的 keyword 或子串`)
  console.log(`  - 检查 type filter（当前: ${TYPE || 'all'}）`)
  console.log(`  - 跑 \`node scripts/kg/knowledge-graph-gen.mjs\` 刷新 graph`)
  process.exit(0)
}

console.log(fmtTable(
  ['rank', 'id', 'type', 'subtype', 'maturity', 'score'],
  matches.slice(0, LIMIT).map((m, i) => [
    i + 1,
    m.id,
    m.type,
    m.subtype || '-',
    m.maturity || '-',
    m._score,
  ])
))
console.log('')
console.log(`> Agent 用法：直接 Read top 候选；如需影响半径，跑 q-impact-radius.mjs <id>`)
