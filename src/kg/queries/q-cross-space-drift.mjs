#!/usr/bin/env node
// q-cross-space-drift.mjs — 个人 memory + team memory 同 topic 节点 diff
//
// 用法：node scripts/kg/queries/q-cross-space-drift.mjs [--user=<agent_id>]
//
// **已废 2026-05-11**: 个人 MEMORY.md 索引已废。本 query 加载
// MEMORY.md 做 drift 检测的逻辑跑不通——MEMORY.md 不存在。未来若需重写：
// 改为遍历 ~/.claude/projects/<proj>/memory/*.md 文件名约定 + frontmatter
// description。本次保留作历史不删，执行入口检测 MEMORY.md 缺失即友好退出。
//
// **铁律（2026-05-03）**：本 query 仅 dry-run 输出，不动文件。
// 个人 Space 是私域，跨 Space drift 检测帮 agent 自己 audit，永不写 team commit。
//
// 逻辑：
//   1. 加载团队 graph（已 build, team-memory/.knowledge-graph.json）
//   2. 加载个人 memory MEMORY.md 索引（~/.claude/projects/<proj>/memory/MEMORY.md）
//   3. 提取个人 memory 条目 list
//   4. 同 topic / name 模糊匹配（>50% token overlap）
//   5. 输出 drift 候选清单，提示个人 audit

import { loadGraph } from './_lib.mjs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const userArg = args.find(a => a.startsWith('--user='))
const projectDirName = path.resolve(process.env.KOS_DATA_ROOT || process.cwd())
  .replace(/^([A-Za-z]):/, '$1-')
  .replace(/[\\/]/g, '-')
const USER_PROJECT = userArg
  ? userArg.slice('--user='.length)
  : projectDirName

const PERSONAL_MEM = path.join(os.homedir(), '.claude', 'projects', USER_PROJECT, 'memory', 'MEMORY.md')

console.log(`# q-cross-space-drift · ${new Date().toISOString()}`)
console.log('')
console.log(`**模式**: dry-run（铁律：永不写个人 Space 也不动 team commit）`)
console.log(`**个人 memory 索引**: ${PERSONAL_MEM}`)
console.log('')

if (!fs.existsSync(PERSONAL_MEM)) {
  console.log(`✗ 个人 memory 索引不存在：${PERSONAL_MEM}`)
  console.log(`提示：用 --user=<project_dir_name> 指定（如 ${projectDirName}）`)
  process.exit(0)
}

const personalIdx = fs.readFileSync(PERSONAL_MEM, 'utf8')

// 解析个人 memory 索引行：- [name](file.md) — description
const personalEntries = []
for (const line of personalIdx.split('\n')) {
  const m = line.match(/^-\s+\[([^\]]+)\]\(([^)]+)\)\s+—\s+(.+)$/)
  if (m) personalEntries.push({ name: m[1], file: m[2], desc: m[3] })
}

const graph = loadGraph()
const teamNodes = graph.nodes.filter(n => ['rule', 'playbook', 'decision'].includes(n.type))

// 模糊匹配：tokenize name + 取 set 交集 / set 并集 = Jaccard
function tokenize(s) {
  return new Set(
    s.toLowerCase()
      .split(/[\s\-_/，。、（）()【】\[\]"'""]+/)
      .filter(t => t.length >= 2)
  )
}

function jaccard(a, b) {
  const A = tokenize(a)
  const B = tokenize(b)
  if (A.size === 0 || B.size === 0) return 0
  const inter = [...A].filter(t => B.has(t)).length
  const union = new Set([...A, ...B]).size
  return inter / union
}

const candidates = []
for (const p of personalEntries) {
  for (const t of teamNodes) {
    const score = jaccard(p.name, t.name || t.id)
    if (score >= 0.3) {
      candidates.push({ personal: p, team: t, score })
    }
  }
}

candidates.sort((a, b) => b.score - a.score)

console.log(`个人 memory 索引条目: ${personalEntries.length}`)
console.log(`团队 memory 节点: ${teamNodes.length}`)
console.log(`潜在 drift 候选 (Jaccard ≥ 0.3): ${candidates.length}`)
console.log('')

if (candidates.length === 0) {
  console.log('✓ 无明显跨 Space 重叠主题')
  process.exit(0)
}

console.log('## 候选清单（个人 ↔ 团队同主题）')
console.log('')
for (const c of candidates.slice(0, 30)) {
  console.log(`- **${(c.score * 100).toFixed(0)}%** 重叠`)
  console.log(`  - 个人: ${c.personal.name} (${c.personal.file})`)
  console.log(`  - 团队: ${c.team.name || c.team.id} (${c.team.id})`)
  console.log(`  - 个人 desc: ${c.personal.desc.slice(0, 100)}`)
}
console.log('')
console.log('> 行动建议（agent 自己来）:')
console.log('> 1. 高重叠 (>60%): 检查个人 memory 是否过时，对比团队最新版')
console.log('> 2. 中重叠 (30-60%): 视情况 — 可能正交关心不同维度')
console.log('> 3. 决策修个人 memory frontmatter `last_verified` 或合并到团队 → 走团队 PR')
console.log('> **永不**: 自动写个人或团队文件（仅 dry-run）')
