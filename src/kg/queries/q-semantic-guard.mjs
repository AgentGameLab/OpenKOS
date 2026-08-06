#!/usr/bin/env node
// q-semantic-guard.mjs — 检查 git diff 里的语义级违规
// 当前检查项：
//   1. Supabase/Drizzle 混用（同一文件同时 import 两个 client）
//   2. 跨 owner 模块写入（api route 写了不属于自己 owner 的路径）
//   3. 铁律 #10 违反：平台代码调用 LLM API
//
// 用法：
//   git diff main...HEAD | node scripts/kg/queries/q-semantic-guard.mjs
//   node scripts/kg/queries/q-semantic-guard.mjs --file <diff-file>
//   node scripts/kg/queries/q-semantic-guard.mjs --staged

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { loadRoster } from '../../kos/roster.mjs'

const roster = loadRoster()
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const TEAM_MEMORY_DECISIONS = path.join(process.env.KOS_DATA_ROOT || path.resolve(SCRIPT_DIR, '..', '..', '..'), 'team-memory', 'decisions')

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const staged = args.includes('--staged')
const fileArg = args.find((_, i) => args[i - 1] === '--file')

async function getDiff() {
  if (fileArg) return fs.readFileSync(fileArg, 'utf-8')
  if (staged) {
    try { return execSync('git diff --cached', { encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }) }
    catch { console.error('git diff --cached failed'); process.exit(1) }
  }
  if (!process.stdin.isTTY) {
    const chunks = []
    process.stdin.resume()
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf-8')
  }
  // 默认：main...HEAD
  try { return execSync('git diff main...HEAD', { encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }) }
  catch {
    try { return execSync('git diff origin/main...HEAD', { encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }) }
    catch (e) { console.error(`无法获取 diff（${e.code || e.message}）——若为 ENOBUFS 说明 diff 过大而非 ref 缺失；否则请通过 stdin 或 --file 提供`); process.exit(1) }
  }
}

let diffText = await getDiff()

const violations = []

// ── 解析 diff 为文件块 ────────────────────────────────────────────────────
const fileBlocks = []
let currentFile = null
let currentLines = []
for (const line of diffText.split('\n')) {
  if (line.startsWith('diff --git ')) {
    if (currentFile) fileBlocks.push({ file: currentFile, lines: currentLines })
    const m = line.match(/b\/(.+)$/)
    currentFile = m ? m[1] : null
    currentLines = []
  } else if (currentFile) {
    currentLines.push(line)
  }
}
if (currentFile) fileBlocks.push({ file: currentFile, lines: currentLines })

// ── 规则 1：Supabase/Drizzle 混用 ────────────────────────────────────────
const SUPABASE_IMPORT = /from ['"]@supabase\/supabase-js['"]|createClient\s*\(|supabase\.from\s*\(/
const DRIZZLE_IMPORT = /from ['"]drizzle-orm|from ['"]@\/lib\/db|createDb\s*\(|drizzle\s*\(/
for (const { file, lines } of fileBlocks) {
  if (!file.endsWith('.ts') && !file.endsWith('.tsx') && !file.endsWith('.js') && !file.endsWith('.mjs')) continue
  const addedLines = lines.filter(l => l.startsWith('+')).join('\n')
  const hasSupabase = SUPABASE_IMPORT.test(addedLines)
  const hasDrizzle = DRIZZLE_IMPORT.test(addedLines)
  if (hasSupabase && hasDrizzle) {
    violations.push({
      rule: 'db-split',
      severity: 'HIGH',
      file,
      message: 'Supabase client 和 Drizzle 同时出现在新增代码中，可能违反 DB split-brain 隔离原则',
      suggestion: '读路径可用 Supabase client，写路径必须走 API Route + Drizzle。参考 ADR-002',
    })
  }
}

// ── 规则 2：铁律 #10 — 平台代码禁止调 LLM ─────────────────────────────
const LLM_CALL = /new Anthropic\s*\(|openai\s*\.\s*chat|anthropic\.messages\.create|OpenAI\s*\(/
const LLM_IMPORT = /from ['"]@anthropic-ai|from ['"]openai['"]/
for (const { file, lines } of fileBlocks) {
  if (!file.startsWith('src/')) continue // 只检查运行时代码
  if (file.includes('test') || file.includes('spec') || file.includes('__tests__')) continue
  const addedLines = lines.filter(l => l.startsWith('+')).join('\n')
  if (LLM_CALL.test(addedLines) || LLM_IMPORT.test(addedLines)) {
    violations.push({
      rule: 'iron-10-no-llm',
      severity: 'CRITICAL',
      file,
      message: '平台运行时代码调用 LLM API（铁律 #10 违反）',
      suggestion: 'LLM 推理是 Agent 主会话/daemon 的行为，通过他们自己的 token 跑。平台只提供通信基础设施。',
    })
  }
}

// ── 规则 3：force push / reset --hard 模式 ───────────────────────────────
// 只检查 GHA workflow 修改中是否新增了 force push
for (const { file, lines } of fileBlocks) {
  if (!file.includes('.github/workflows')) continue
  const addedLines = lines.filter(l => l.startsWith('+')).join('\n')
  if (/git push.*--force|git push.*-f\b/.test(addedLines)) {
    violations.push({
      rule: 'no-force-push',
      severity: 'HIGH',
      file,
      message: 'GHA workflow 新增 force push 操作',
      suggestion: `破坏性 git 操作需 ${roster.roles.approver} 审批`,
    })
  }
}

// ── 规则 4：ADR supersedes_patterns — advisory scan ───────────────────────
// 加载所有已 ship 的 ADR，检查 diff 新增行是否包含被废弃的 patterns
// ADVISORY 级别：参见 ADR 2026-05-25 supersedes_patterns_caveat — 不 hard fail，advisory warn only
const advisories = []

function parseSimpleFm(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const m = normalized.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const fm = {}
  let currentList = null
  for (const line of m[1].split('\n')) {
    const listItem = line.match(/^  - (.+)$/)
    if (listItem && currentList) { currentList.push(listItem[1].trim().replace(/^["']|["']$/g, '')); continue }
    const kv = line.match(/^(\w[\w_]*):\s*(.*)$/)
    if (kv) {
      currentList = null
      if (kv[2].trim() === '') { fm[kv[1]] = []; currentList = fm[kv[1]] }
      else { fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '') }
    }
  }
  return fm
}

if (fs.existsSync(TEAM_MEMORY_DECISIONS)) {
  const shippedAdrs = fs.readdirSync(TEAM_MEMORY_DECISIONS)
    .filter(f => f.endsWith('.md'))
    .flatMap(f => {
      const fm = parseSimpleFm(fs.readFileSync(path.join(TEAM_MEMORY_DECISIONS, f), 'utf-8'))
      if (fm.status !== 'ship') return []
      const patterns = Array.isArray(fm.supersedes_patterns) ? fm.supersedes_patterns : []
      return patterns.length ? [{ adr: f, patterns }] : []
    })

  for (const { adr, patterns } of shippedAdrs) {
    for (const { file, lines } of fileBlocks) {
      const addedText = lines.filter(l => l.startsWith('+')).join('\n')
      for (const pattern of patterns) {
        if (addedText.includes(pattern)) {
          advisories.push({
            adr,
            pattern,
            file,
            message: `新增行包含 ADR 已废弃的 pattern "${pattern}"`,
            suggestion: `ADR ${adr} 已 supersede 此 pattern，建议走新架构或显式 mark transitional fallback`,
          })
        }
      }
    }
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────────
if (jsonMode) {
  console.log(JSON.stringify({ violations, advisories, files_checked: fileBlocks.length }, null, 2))
  process.exit(violations.some(v => v.severity === 'CRITICAL') ? 2 : violations.length ? 1 : 0)
}

console.log(`# q-semantic-guard`)
console.log(`检查了 ${fileBlocks.length} 个文件`)
console.log('')

if (violations.length === 0 && advisories.length === 0) {
  console.log('✅ 无语义级违规')
  process.exit(0)
}

for (const v of violations) {
  const icon = v.severity === 'CRITICAL' ? '🚨' : '⚠️'
  console.log(`${icon} [${v.severity}] ${v.rule}`)
  console.log(`   文件: ${v.file}`)
  console.log(`   问题: ${v.message}`)
  console.log(`   建议: ${v.suggestion}`)
  console.log('')
}

if (advisories.length > 0) {
  console.log(`── ADR supersedes_patterns advisory (不阻断，仅提示) ──`)
  for (const a of advisories) {
    console.log(`💡 [ADVISORY] stale-pattern`)
    console.log(`   文件: ${a.file}`)
    console.log(`   Pattern: "${a.pattern}"`)
    console.log(`   来源 ADR: ${a.adr}`)
    console.log(`   建议: ${a.suggestion}`)
    console.log('')
  }
}

const criticals = violations.filter(v => v.severity === 'CRITICAL').length
const highs = violations.filter(v => v.severity === 'HIGH').length
if (violations.length > 0) console.log(`> 共 ${violations.length} 个违规: ${criticals} CRITICAL / ${highs} HIGH`)
if (advisories.length > 0) console.log(`> ${advisories.length} 个 advisory（不影响 exit code）`)

process.exit(criticals > 0 ? 2 : violations.length ? 1 : 0)
