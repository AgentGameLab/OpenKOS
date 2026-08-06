#!/usr/bin/env node
// kos-recall · universal read-only KOS query CLI.
// Supports the R-Query Reflex in a configured sync-reflex rule.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { enforceContextBudget, startTrace } from './recall-guards.mjs'
import { findMatchingNodes, oneHopNeighbors as graphOneHopNeighbors } from '../kg/lib/graph-adjacency.mjs'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..')
const PROJECT_MEMORY_KEY = path.resolve(ROOT)
  .replace(/^([A-Za-z]):/, '$1-')
  .replace(/[\\/]/g, '-')
// Personal memory may be configured directly; otherwise derive Claude's project key from KOS_DATA_ROOT.
const PERSONAL_MEMORY_DIRS = [
  process.env.KOS_MEMORY_DIR || path.resolve(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects', PROJECT_MEMORY_KEY, 'memory'),
]
const PERSONAL_MEMORY_DIR = PERSONAL_MEMORY_DIRS[0]  // 向后兼容

const VALID_TYPES = new Set(['rule', 'playbook', 'decision', 'incident', 'all'])
const VALID_SCOPES = new Set(['team', 'personal', 'all'])
const VALID_FORMATS = new Set(['json', 'text'])
const DEFAULT_RECALL_MAX_CHARS = 8000
const DEFAULT_RECALL_MAX_ENTRIES = 20
const MATURITY_RANK_OFFSET = { proven: -2, verified: 0, draft: 4 }

function usage() {
  console.error('Usage: node scripts/kos/kos-recall.mjs --query "<phrase>" [--limit 5] [--type rule|playbook|decision|incident|all] [--scope team|personal|all] [--format json|text]')
}

function parseArgs(argv) {
  // 2026-05-20 21:00 catch: 20:59 ship default scope=team 是 over-correction.
  // KOS 设计上早就隔离 (3 层): file system (team-memory/ vs personal/ 独立 dir) + store layer
  // (kos-remember TYPE_ROUTING: rule/playbook/decision→team, feedback/reference/correction→personal) +
  // 写入 dir 自动隔离. Query layer default 'all' = utility convenience (单 agent main session
  // 自查自己 memory + team-memory), 不 leak 给其他 agent, 不破坏 file/store isolation.
  // → revert default 'team' → 'all' (恢复 utility convenience). Architectural isolation 仍在 file+store 层.
  const args = {
    query: '',
    limit: 5,
    type: 'all',
    scope: 'all',
    format: 'text',
  }

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    const eq = raw.indexOf('=')
    const flag = eq >= 0 ? raw.slice(0, eq) : raw
    const inlineValue = eq >= 0 ? raw.slice(eq + 1) : null
    const readValue = () => {
      if (inlineValue != null) return inlineValue
      if (i + 1 >= argv.length) return ''
      i++
      return argv[i]
    }

    if (flag === '--query') args.query = readValue()
    else if (flag === '--limit') args.limit = Number.parseInt(readValue(), 10)
    else if (flag === '--type') args.type = readValue()
    else if (flag === '--scope') args.scope = readValue()
    else if (flag === '--format') args.format = readValue()
    else return { error: `unknown option: ${raw}` }
  }

  if (!args.query) return { error: 'missing --query' }
  if (!Number.isInteger(args.limit) || args.limit < 1) return { error: '--limit must be a positive integer' }
  if (!VALID_TYPES.has(args.type)) return { error: '--type must be rule, playbook, decision, incident, or all' }
  if (!VALID_SCOPES.has(args.scope)) return { error: '--scope must be team, personal, or all' }
  if (!VALID_FORMATS.has(args.format)) return { error: '--format must be json or text' }

  return { args }
}

function positiveEnvInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function recallGuardConfig() {
  return {
    maxChars: positiveEnvInteger('KOS_RECALL_MAX_CHARS', DEFAULT_RECALL_MAX_CHARS),
    maxEntries: positiveEnvInteger('KOS_RECALL_MAX_ENTRIES', DEFAULT_RECALL_MAX_ENTRIES),
  }
}

function parseFrontmatter(text) {
  text = text.replace(/\r\n/g, '\n') // CRLF 容错：归一化后再解析（否则 CRLF 文件 frontmatter 解析失败 / 值带 \r 尾）
  if (!text.startsWith('---\n')) return { fm: {}, body: text }
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) return { fm: {}, body: text }
  const fm = {}
  const lines = text.slice(4, end).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const rest = m[2]
    if (rest === '') {
      const arr = []
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        i++
        arr.push(stripQuotes(lines[i].replace(/^\s+-\s+/, '').trim()))
      }
      fm[key] = arr
    } else if (rest === '[]') {
      fm[key] = []
    } else if (/^\[.*\]$/.test(rest.trim())) {
      fm[key] = rest.trim().slice(1, -1).split(',').map((x) => stripQuotes(x.trim())).filter(Boolean)
    } else {
      fm[key] = stripQuotes(rest.trim())
    }
  }
  return { fm, body: text.slice(end + 5) }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

// 排除目录名集合 (snapshot/ snapshots/ pointers/ _drafts)
const EXCLUDED_DIR_NAMES = new Set(['snapshot', 'snapshots', 'pointers', '_drafts'])

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        // 跳过排除目录
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
        stack.push(fullPath)
      } else if (entry.isFile()) {
        // 跳过非 .md 文件、以及 credentials.md
        if (!entry.name.endsWith('.md')) continue
        if (entry.name === 'credentials.md') continue
        out.push(fullPath)
      }
    }
  }
  return out
}

function teamDirsForType(type) {
  if (type === 'rule') return [path.join(ROOT, 'team-memory', 'rules')]
  if (type === 'playbook') return [path.join(ROOT, 'team-memory', 'playbooks')]
  if (type === 'decision' || type === 'incident') return [path.join(ROOT, 'team-memory', 'decisions')]
  // type === 'all' — 扩展目录白名单
  return [
    path.join(ROOT, 'team-memory', 'rules'),
    path.join(ROOT, 'team-memory', 'playbooks'),
    path.join(ROOT, 'team-memory', 'decisions'),
    path.join(ROOT, 'team-memory', 'references'),
    path.join(ROOT, 'team-memory', 'game-teardowns'),
    path.join(ROOT, 'team-memory', 'findings'),
    path.join(ROOT, 'team-memory', 'members'),
    path.join(ROOT, 'team-memory', 'methods'),
    path.join(ROOT, 'team-memory', 'articles'),
    path.join(ROOT, 'team-memory', 'specs'),
    path.join(ROOT, 'team-memory', 'strategy'),
    path.join(ROOT, 'team-memory', 'eval'),
    path.join(ROOT, 'team-memory', 'state'),
  ]
}

// ADR-047-A2 · sediment-chunks 每日沉淀扫描 (type=all 时可见)
function sedimentDirs() {
  const base = path.join(ROOT, 'research', 'by-owner')
  if (!fs.existsSync(base)) return []
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(base, e.name, 'sediment-chunks'))
      .filter((p) => fs.existsSync(p))
  } catch { return [] }
}

function candidateFiles({ type, scope }) {
  const files = []
  if (scope === 'team' || scope === 'all') {
    for (const dir of teamDirsForType(type)) files.push(...listMarkdownFiles(dir))
    // sediment 只在 type == 'all' 时可见
    if (type === 'all') {
      for (const dir of sedimentDirs()) files.push(...listMarkdownFiles(dir))
    }
  }
  if (scope === 'personal' || scope === 'all') {
    for (const dir of PERSONAL_MEMORY_DIRS) files.push(...listMarkdownFiles(dir))
  }
  return [...new Set(files)]
}

function normalize(value) {
  return String(value || '').toLowerCase()
}

function queryTerms(query) {
  return normalize(query).trim().split(/\s+/).filter(Boolean)
}

function termAliases(term) {
  if (term === '飞书') return ['飞书', 'feishu', 'display-name', 'team-display-name']
  if (term === 'ou_id') {
    return ['ou_id', 'ou_xxx', 'open_id', 'open id', 'union_id', 'display-name-ground-truth', 'team-display-name-ground-truth']
  }
  return [term]
}

function matchesQuery(value, query) {
  const text = normalize(value)
  const q = normalize(query).trim()
  if (!q) return false
  if (text.includes(q)) return true
  const terms = queryTerms(query)
  return terms.length > 1 && terms.every((term) => termAliases(term).some((alias) => text.includes(alias)))
}

function matchedTermCount(value, query) {
  const text = normalize(value)
  return queryTerms(query).filter((term) => termAliases(term).some((alias) => text.includes(alias))).length
}

function fieldScore(value, query, points) {
  // ADR-047-A2 Route E v0.3: 全 query term 命中 → +1 flat bonus
  if (matchesQuery(value, query)) return points + 1
  const terms = queryTerms(query)
  if (terms.length <= 1) return 0
  return (points * matchedTermCount(value, query)) / terms.length
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value == null || value === '') return []
  return [String(value)]
}

function inferType(filePath, fm) {
  if (fm.type) return fm.type
  const rel = displayPath(filePath)
  if (rel.startsWith('team-memory/rules/')) return 'rule'
  if (rel.startsWith('team-memory/playbooks/')) return 'playbook'
  if (rel.startsWith('team-memory/decisions/')) return 'decision'
  if (rel.startsWith('team-memory/references/')) return 'reference'
  if (rel.startsWith('team-memory/game-teardowns/')) return 'game-teardown'
  if (rel.startsWith('team-memory/findings/')) return 'finding'
  if (rel.startsWith('team-memory/members/')) return 'member'
  if (rel.startsWith('team-memory/methods/')) return 'method'
  if (rel.startsWith('team-memory/articles/')) return 'article'
  if (rel.startsWith('team-memory/specs/')) return 'spec'
  if (rel.startsWith('team-memory/strategy/')) return 'strategy'
  if (rel.startsWith('team-memory/eval/')) return 'eval'
  if (rel.startsWith('team-memory/state/')) return 'state'
  return ''
}

function scoreMemory({ filePath, fm, body }, query) {
  const slug = fm.slug || path.basename(filePath, '.md')
  const name = fm.name || ''
  const tags = asArray(fm.tags)
  const description = fm.description || ''
  let score = 0

  score += fieldScore(slug, query, 3)
  score += fieldScore(name, query, 3)
  score += Math.max(0, ...tags.map((tag) => fieldScore(tag, query, 3)))
  score += fieldScore(description, query, 2)
  score += fieldScore(body, query, 2)  // ADR-047-A2 Route E: body ×1→×2

  return score
}

function snippetFor({ fm, body }, query) {
  // 2026-05-15 v0.1.1 (challenge #1): 同时返回 line number 让 LLM 直接 read filePath:line
  // body 行从 1 开始；frontmatter 衍生（description/name/tags）无 source line → null
  const bodyLines = body.split(/\r?\n/)
  for (let i = 0; i < bodyLines.length; i++) {
    if (matchesQuery(bodyLines[i], query)) {
      return { line: i + 1, snippet: compactSnippet(bodyLines[i], query) }
    }
  }
  for (let i = 0; i < bodyLines.length; i++) {
    if (matchedTermCount(bodyLines[i], query) > 0) {
      return { line: i + 1, snippet: compactSnippet(bodyLines[i], query) }
    }
  }
  // frontmatter fallback：没 body 行命中时用 description / name / tags（无 line）
  const fmFallback = [fm.description || '', fm.name || '', asArray(fm.tags).join(', ')]
    .find((source) => matchedTermCount(source, query) > 0) || ''
  return { line: null, snippet: compactSnippet(fmFallback, query) }
}

function compactSnippet(text, query) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim()
  if (oneLine.length <= 200) return oneLine
  const q = normalize(query).trim()
  const terms = queryTerms(query)
  let index = normalize(oneLine).indexOf(q)
  if (index < 0 && terms.length > 0) index = normalize(oneLine).indexOf(terms[0])
  const start = Math.max(0, index - 80)
  const end = Math.min(oneLine.length, start + 200)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < oneLine.length ? '...' : ''
  return `${prefix}${oneLine.slice(start, end).trim()}${suffix}`.slice(0, 200)
}

function displayPath(filePath) {
  const rel = path.relative(ROOT, filePath)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/')
  return filePath.replace(/\\/g, '/')
}

// KOS-Plus v1 P0.3 Wave 1B: 1-hop typed neighbor enrichment
const NEIGHBOR_LABELS = new Set(['enforced_by', 'decides', 'supersedes', 'superseded_by', 'related'])

function oneHopNeighbors(docPath, maxPerLabel = 2) {
  const byLabel = new Map()
  for (const neighbor of graphOneHopNeighbors(docPath, ROOT)) {
    if (!NEIGHBOR_LABELS.has(neighbor.edge)) continue
    const neighborPath = neighbor.node.canonical_path || neighbor.node.id
    if (!neighborPath) continue
    if (!byLabel.has(neighbor.edge)) byLabel.set(neighbor.edge, [])
    const bucket = byLabel.get(neighbor.edge)
    if (bucket.length >= maxPerLabel) continue
    if (bucket.some(n => n.path === neighborPath)) continue
    bucket.push({ path: neighborPath, edge: neighbor.edge, direction: neighbor.direction })
  }
  return [...byLabel.values()].flat()
}

function memoryResult(filePath, args, recallSource, minimumScore = 0) {
  try {
    const text = fs.readFileSync(filePath, 'utf-8')
    const parsed = parseFrontmatter(text)
    const type = inferType(filePath, parsed.fm)
    if (args.type !== 'all' && type !== args.type) return null
    const score = scoreMemory({ filePath, ...parsed }, args.query)
    if (score < minimumScore) return null
    const { line, snippet } = snippetFor(parsed, args.query)
    const slug = parsed.fm.slug || path.basename(filePath, '.md')
    return {
      id: parsed.fm.id || slug,
      path: displayPath(filePath),
      line,
      score,
      slug,
      type,
      maturity: parsed.fm.maturity || '',
      status: parsed.fm.status || '',
      snippet,
      tags: asArray(parsed.fm.tags),
      description: parsed.fm.description || '',
      recall_sources: [recallSource],
    }
  } catch {
    return null
  }
}

// Tier-0：低基数实体命中直接返回实体及 1-hop memory，任何 KG 异常均回退 Tier-1。
function tier0Recall(args) {
  try {
    const maxMatches = positiveEnvInteger('KOS_TIER0_MAX_MATCHES', 8)
    const matchedNodes = findMatchingNodes(args.query, ROOT)
    if (matchedNodes.length < 1 || matchedNodes.length > maxMatches) return null

    const filesByPath = new Map(candidateFiles(args).map((filePath) => [displayPath(filePath), filePath]))
    const direct = []
    const directPaths = new Set()
    for (const node of matchedNodes) {
      const filePath = filesByPath.get(String(node.canonical_path || '').replace(/\\/g, '/'))
      if (!filePath || directPaths.has(filePath)) continue
      const entry = memoryResult(filePath, args, 'kg-tier0')
      if (!entry) continue
      directPaths.add(filePath)
      direct.push(entry)
    }
    // 非 markdown / 当前 scope 不可见的 KG 节点不能使正常 recall 变为空。
    if (direct.length === 0) return null

    const neighbors = []
    const neighborPaths = new Set(directPaths)
    for (const node of matchedNodes) {
      for (const neighbor of graphOneHopNeighbors(node, ROOT)) {
        const filePath = filesByPath.get(String(neighbor.node.canonical_path || '').replace(/\\/g, '/'))
        if (!filePath || neighborPaths.has(filePath)) continue
        const entry = memoryResult(filePath, args, 'kg-tier0')
        if (!entry) continue
        neighborPaths.add(filePath)
        neighbors.push(entry)
      }
    }
    return [...direct, ...neighbors].slice(0, args.limit)
  } catch {
    return null
  }
}

function localRecall(args) {
  const out = []
  for (const filePath of candidateFiles(args)) {
    const text = fs.readFileSync(filePath, 'utf-8')
    const parsed = parseFrontmatter(text)
    const type = inferType(filePath, parsed.fm)
    if (args.type !== 'all' && type !== args.type) continue

    const score = scoreMemory({ filePath, ...parsed }, args.query)
    if (score <= 0) continue

    const { line, snippet } = snippetFor(parsed, args.query)
    const slug = parsed.fm.slug || path.basename(filePath, '.md')
    out.push({
      id: parsed.fm.id || slug,
      path: displayPath(filePath),
      line,
      score,
      slug,
      type,
      maturity: parsed.fm.maturity || '',
      status: parsed.fm.status || '',
      snippet,
      tags: asArray(parsed.fm.tags),
      description: parsed.fm.description || '',
    })
  }

  out.sort((a, b) => {
    if (args.scope === 'all') {
      const scopeDelta = scopeRank(a.path) - scopeRank(b.path)
      if (scopeDelta !== 0) return scopeDelta
    }
    return b.score - a.score || a.path.localeCompare(b.path)
  })
  return out.slice(0, args.limit)
}

function scopeRank(displayPathValue) {
  return displayPathValue.startsWith('team-memory/') ? 0 : 1
}

// 加载 .env.local（kos-recall 可能在 daemon 外跑，process.env 未注入时兜底；不覆盖已有值）
function loadEnvLocal() {
  try {
    const p = path.join(ROOT, '.env.local')
    if (!fs.existsSync(p)) return
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  } catch { /* 兜底失败不阻塞 */ }
}

// client 端 embed query（铁律#10：service 不替 client 调 LLM）— port 自 team-prompt-recall.mjs L98-121
async function embedQuery(text) {
  const key = process.env.EMBEDDING_API_KEY
  if (!key || !text) return null
  const base = process.env.EMBEDDING_API_BASE_URL || 'https://api.openai.com/v1'
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small'
  const dim = parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10)
  try {
    const r = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text.length > 4000 ? text.slice(0, 4000) : text, dimensions: dim, encoding_format: 'float' }),
      signal: AbortSignal.timeout(3000),
    })
    if (!r.ok) return null
    const v = (await r.json()).data?.[0]?.embedding
    return (Array.isArray(v) && v.length === dim) ? v : null
  } catch { return null }
}

// CLI scope → DB scope_filter（2026-06-06 拍 + scope 语义）
// DB scope 词表：'all-agents'（全员共享）/ 'team' / '<agent-id>'（私有）。
// CLI personal 主要由 Tier-1 本地 markdown 覆盖；Tier-2(DB) 私有需 caller agent-id（KOS_AGENT_SCOPE env）。
function scopeToDbFilter(scope) {
  const self = process.env.KOS_AGENT_SCOPE || process.env.AGENT_ID
  if (scope === 'team') return ['all-agents', 'team']
  if (scope === 'personal') return self ? [self] : ['all-agents']
  return self ? ['all-agents', 'team', self] : ['all-agents', 'team']  // 'all'
}

// Tier-2 召回：走 HTTP /api/recall（2026-06-06 拍设计点）。
// 旧版直连 DB（需 TM_DATABASE_URL，客户端没有 → 等于没启用）；改走 HTTP + client embed，
// 复用 team-prompt-recall hook pattern，凭据收在 service 单点（不扩散 DB URL 到客户端）。
async function pgRecall(args) {
  loadEnvLocal()
  const base = (process.env.KOS_SERVICE_URL || process.env.TM_SERVICE_URL || '').replace(/\/$/, '')
  const token = process.env.KOS_SERVICE_TOKEN
  if (!base || !token) return []  // 未配置 → 优雅返空，不报错
  const queryEmbedding = await embedQuery(args.query)  // null → service 降级 FTS
  let data
  try {
    const r = await fetch(`${base}/api/recall`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: args.query,
        query_embedding: queryEmbedding,
        limit: args.limit,
        min_importance: 0,
        type_filter: args.type && args.type !== 'all' ? [args.type] : undefined,
        scope_filter: scopeToDbFilter(args.scope),
        source: 'kos-recall-cli',
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) throw new Error('recall HTTP ' + r.status)
    data = await r.json()
  } catch (e) { throw e }
  const rows = data?.hits || []
  return rows.slice(0, args.limit).map((row) => ({
    id: row.id ?? row.memory_id ?? row.slug ?? '',
    path: row.source_file || row.path || row.file || row.location || '',
    // pgRecall 暂无 line number（chunk-based embedding 不带源行；后续 v0.2 可加 chunk_start_line column）
    line: row.line ?? row.chunk_start_line ?? null,
    score: Number(row.rrf_score ?? row.score ?? 0),
    slug: row.slug || '',
    type: row.type || '',
    maturity: row.maturity || '',
    status: row.status || '',
    snippet: compactSnippet(row.snippet || row.content || row.description || '', args.query),
    tags: asArray(row.tags),
    description: row.description || '',
  }))
}

// Tier-1（本地词面 fieldScore，整数量纲，可到几十）与 Tier-2（pgRecall RRF，量纲 ~1/(60+rank)≈0.016）
// 分数不同量纲、跨条不可比。旧代码统一 toFixed(1) → 所有 Tier-2 语义命中一律显示 "0.0"，
// 消费方（LLM agent）会把精准的语义召回误读成「零命中」而跳过。排序本身是 rank-based 合并（见
// mergeRankedResults），不受影响——坏的只有显示层。这里按量纲自适应精度，保证小分数不塌成 0.0。
function formatScoreForDisplay(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 'n/a'
  if (n === 0) return '0'
  if (Math.abs(n) >= 1) return n.toFixed(1)
  return n.toPrecision(2)  // 0.01639… → "0.016"
}

function formatTextEntries(results) {
  return results.map((r, i) => {
    // v0.1.1: 带行号则输出 path:line（LLM 可直接 Read filePath, offset=line），不带则降级 path
    const loc = r.line ? `${r.path}:${r.line}` : r.path
    const lines = [
      `[${i + 1}] ${loc}  (score: ${formatScoreForDisplay(r.score)})`,
      `    id: ${r.id || r.slug}`,
      `    slug: ${r.slug}`,
      `    type: ${r.type || '(unknown)'} | maturity: ${r.maturity || '(unknown)'} | status: ${r.status || '(unknown)'}`,
      `    snippet: ${r.snippet}`,
    ]
    if (Array.isArray(r.neighbors) && r.neighbors.length) {
      const formatted = r.neighbors.map(n => `${n.edge}${n.direction === 'in' ? '←' : '→'}${n.path}`).join(', ')
      lines.push(`    📎 1-hop: ${formatted}`)
    }
    return lines.join('\n')
  })
}

function recallIdSet(results) {
  return new Set(results.map((result) => result.id ?? result.slug).filter((id) => id != null && id !== '').map(String))
}

// Tier-1/Tier-2 都已在各自层内排序；在路径去重后按合并排名做 maturity 偏移，
// 不对 RRF/keyword 分数乘权，避免把 draft 隐性硬过滤。无 maturity 的 file 层条目按 verified 同档。
function mergeRankedResults(tiers, limit) {
  const mergedByKey = new Map()
  for (const tier of tiers) {
    tier.forEach((item, i) => {
      const key = item.path || item.id
      const norm = 1 / (i + 1)
      const existing = mergedByKey.get(key)
      if (!existing || norm > existing.norm) mergedByKey.set(key, { item, norm })
    })
  }

  return [...mergedByKey.values()]
    .sort((a, b) => b.norm - a.norm)
    .map(({ item }, index) => ({
      item,
      rank: index + 1,
      effectiveRank: Math.max(1, index + 1 + (MATURITY_RANK_OFFSET[item.maturity] ?? 0)),
    }))
    .sort((a, b) => a.effectiveRank - b.effectiveRank || a.rank - b.rank)
    .map(({ item }) => item)
    .slice(0, limit)
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    usage()
    process.exit(2)
  }

  const { args } = parsed
  const guardConfig = recallGuardConfig()
  const trace = startTrace('kos-recall')
  trace.step('recall.params', { ...args, ...guardConfig })

  try {
    let results = []
    let backend = 'tier1'
    let tier1Failed = false
    let tier2Failed = false

    // 0) Tier-0 KG entity short-circuit（低命中数才接管，失败则静默回退）。
    const tier0 = tier0Recall(args)
    if (tier0) {
      results = tier0
      backend = 'kg-tier0'
    } else {
      // 1) Tier-1 local recall
      try {
        results = localRecall(args)
      } catch (error) {
        tier1Failed = true
        trace.step('recall.backend_error', { backend: 'tier1', error: error.message })
      }
    }

    // 2) Tier-2 触发门：无结果 或 最高分 < 2.0
    const TIER2_TRIGGER_THRESHOLD = 2.0
    const tier1TopScore = results.length > 0 ? Math.max(...results.map(r => Number(r.score) || 0)) : 0
    const needTier2 = backend !== 'kg-tier0' && (tier1Failed || results.length === 0 || tier1TopScore < TIER2_TRIGGER_THRESHOLD)

    if (needTier2) {
      const tier1Results = tier1Failed ? [] : results
      try {
        const tier2 = await pgRecall(args)
        results = mergeRankedResults([tier1Results, tier2], args.limit)
        backend = tier1Failed ? 'tier2' : 'tier1+tier2'
      } catch (error) {
        tier2Failed = true
        trace.step('recall.backend_error', { backend: 'tier2', error: error.message })
        // 如果 tier1 有结果则保留，否则空
        results = tier1Results.slice(0, args.limit)
        backend = 'tier1'
      }
    }

    trace.step('recall.results', {
      backend,
      count: results.length,
      tier1Failed,
      tier2Failed,
    })

    if (tier1Failed && tier2Failed) {
      console.error('[kos-recall] all backends failed')
      process.exitCode = 5
      return
    }

    // KOS-Plus v1 P0.3 Wave 1B: 1-hop typed neighbor enrichment (silent if KG missing)
    for (const r of results) {
      r.neighbors = oneHopNeighbors(r.path)
    }

    const contextEntries = args.format === 'json' ? results : formatTextEntries(results)
    const budgeted = enforceContextBudget(contextEntries, guardConfig)
    const keptResults = results.slice(0, budgeted.kept.length)
    const validIds = recallIdSet(keptResults)
    trace.step('context.filter', {
      inputEntries: contextEntries.length,
      keptEntries: budgeted.kept.length,
      droppedEntries: budgeted.dropped.length,
      reason: budgeted.reason,
      ...guardConfig,
    })
    trace.step('id_whitelist.prepared', {
      validIdCount: validIds.size,
      validIds: [...validIds],
    })

    const finalContext = args.format === 'json'
      ? JSON.stringify(budgeted.kept)
      : budgeted.kept.join('\n\n')
    trace.step('context.final', {
      format: args.format,
      entries: budgeted.kept.length,
      chars: finalContext.length,
    })

    if (finalContext) process.stdout.write(finalContext)
    else if (args.format === 'json') process.stdout.write('[]')
    else process.stdout.write(`(no matches for '${args.query}')`)
  } finally {
    try {
      trace.end()
    } catch (error) {
      console.error(`[kos-recall] trace write failed: ${error.message}`)
      if (!process.exitCode) process.exitCode = 6
    }
  }
}

main().catch(() => {
  console.error('[kos-recall] all backends failed')
  process.exit(5)
})
