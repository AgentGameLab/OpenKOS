// scripts/kg/queries/_lib.mjs — 共享 KG reader / graph utils
// 所有 q-*.mjs 用这个 lib 读 team-memory/.knowledge-graph.json
//
// **Lazy regen**（2026-05-03 灵活性需求）：每次 loadGraph 自动检查 source mtime
// 超过 graph mtime → 自动调 knowledge-graph-gen.mjs --quiet 重生成。
// 这样团队成员 git pull 拉到新 commit 后，第一次 query 自动出最新 KG，永远 fresh。
// 不再依赖 daily cron——cron 仅作 ASI mirror 同步用。

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
export const ROOT = process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..', '..')
export const GRAPH_PATH = path.join(ROOT, 'team-memory', '.knowledge-graph.json')
export const SNAPSHOTS_DIR = path.join(ROOT, 'team-memory', '.knowledge-graph.snapshots')
const GEN_SCRIPT = url.fileURLToPath(new URL('../knowledge-graph-gen.mjs', import.meta.url))
const KG_QUERY_METRICS_DIR = path.join(ROOT, '.asi')
const KG_QUERY_METRICS_FILE = path.join(KG_QUERY_METRICS_DIR, 'kg-query-metrics.jsonl')

// 监听 source dirs/files——任意一个 newer than graph → 触发 regen
// 2026-05-04 加 scripts/ + scheduler-config.json (Tier 2 KG 扩展后 script/cron-task 也是 first-class 节点)
const WATCHED_DIRS = [
  'team-memory/rules',
  'team-memory/playbooks',
  'team-memory/decisions',
  'team-memory/pointers',
  'skills',
  'docs/architecture',
  '.claude/hooks',
  '.claude/rules',
  'scripts',
]
const WATCHED_FILES = [
  'scripts/scheduler-config.json',
]

function maxMtimeRecursive(dir, limit = Infinity) {
  let max = 0
  if (!fs.existsSync(dir)) return 0
  const stack = [dir]
  let count = 0
  while (stack.length && count < limit) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) {
        if (e.name === '.knowledge-graph.snapshots') continue  // 不监听 snapshot 自身
        stack.push(full)
      } else if (e.isFile()) {
        try {
          const m = fs.statSync(full).mtimeMs
          if (m > max) max = m
        } catch {}
        count++
      }
    }
  }
  return max
}

function isStale() {
  if (!fs.existsSync(GRAPH_PATH)) return true
  const graphMtime = fs.statSync(GRAPH_PATH).mtimeMs
  for (const rel of WATCHED_DIRS) {
    const full = path.join(ROOT, rel)
    if (maxMtimeRecursive(full, 5000) > graphMtime) return true
  }
  for (const rel of WATCHED_FILES) {
    const full = path.join(ROOT, rel)
    try {
      if (fs.statSync(full).mtimeMs > graphMtime) return true
    } catch {}
  }
  return false
}

function regenerateGraph() {
  process.stderr.write('[kg] graph stale, regenerating...\n')
  try {
    execSync(`node "${GEN_SCRIPT}" --quiet`, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })
  } catch (e) {
    process.stderr.write(`[kg] regen failed: ${e.message}\n`)
    if (!fs.existsSync(GRAPH_PATH)) throw new Error('graph regen failed and no fallback exists')
  }
}

function emitLoadGraphMetric(graph) {
  try {
    fs.mkdirSync(KG_QUERY_METRICS_DIR, { recursive: true })
    const scriptPath = process.argv[1] || ''
    const record = {
      ts: new Date().toISOString(),
      query_script: path.basename(scriptPath, path.extname(scriptPath)),
      query_args: process.argv.slice(2).join(' '),
      node_count: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
      edge_count: Array.isArray(graph?.edges) ? graph.edges.length : 0,
      caller_pid: process.pid,
    }
    fs.appendFileSync(KG_QUERY_METRICS_FILE, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {}
}

export function loadGraph({ skipStaleCheck = false } = {}) {
  if (!skipStaleCheck && isStale()) regenerateGraph()
  if (!fs.existsSync(GRAPH_PATH)) {
    console.error(`graph not found at ${GRAPH_PATH}`)
    console.error(`run: node scripts/kg/knowledge-graph-gen.mjs`)
    process.exit(1)
  }
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'))
  emitLoadGraphMetric(graph)
  return graph
}

export function loadSnapshot(date) {
  const file = path.join(SNAPSHOTS_DIR, `${date}.json`)
  if (!fs.existsSync(file)) {
    console.error(`snapshot not found: ${file}`)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function indexNodes(graph) {
  const byId = new Map()
  for (const n of graph.nodes || []) byId.set(n.id, n)
  return byId
}

export function indexEdges(graph) {
  const out = new Map()  // from → [edge]
  const inMap = new Map() // to → [edge]
  for (const e of graph.edges || []) {
    if (!out.has(e.from)) out.set(e.from, [])
    if (!inMap.has(e.to)) inMap.set(e.to, [])
    out.get(e.from).push(e)
    inMap.get(e.to).push(e)
  }
  return { out, in: inMap }
}

/** BFS N-hop 邻居 */
export function bfs(graph, startId, maxHops = 2, edgeFilter = null) {
  const { out } = indexEdges(graph)
  const visited = new Set([startId])
  const result = [{ id: startId, hop: 0 }]
  let frontier = [startId]
  for (let hop = 1; hop <= maxHops; hop++) {
    const next = []
    for (const id of frontier) {
      for (const e of (out.get(id) || [])) {
        if (edgeFilter && !edgeFilter(e)) continue
        if (visited.has(e.to)) continue
        visited.add(e.to)
        next.push(e.to)
        result.push({ id: e.to, hop, via: e.label })
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return result
}

export function fmtTable(headers, rows) {
  const sep = headers.map(() => '---')
  return [
    `| ${headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ].join('\n')
}

// ─── Stale-ref 「intentional historical」过滤（q-stale-chains + q-lint 共享）───
// 判断 upstream 节点引用一个 superseded target 是否是「有意的历史 ACK」(则不算 stale 待迁移)。
// 2026-05-29 KOS audit: 从 q-stale-chains 抽取共享, 让 q-lint 的 stale 计数与 q-stale-chains 一致
//   (此前 q-lint 数未过滤超集 → 把有意历史引用也算进 health 扣分)。
function _readFileSoft(relPath) {
  try {
    const full = path.join(ROOT, relPath)
    if (!fs.existsSync(full)) return { fm: '', body: '' }
    const text = fs.readFileSync(full, 'utf-8')
    const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    return m ? { fm: m[1], body: m[2] } : { fm: '', body: text }
  } catch { return { fm: '', body: '' } }
}
function _inferAdrShortRefs(relPath) {
  const m = path.basename(relPath, '.md').match(/^adr-(\d+[a-z]*)/i)
  if (!m) return []
  return [`ADR-${m[1].toUpperCase()}`, `adr-${m[1].toLowerCase()}`]
}
function _escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export function isIntentionalHistoricalRef(upstreamId, targetId) {
  const { fm, body } = _readFileSoft(upstreamId)
  if (!fm && !body) return false
  const targetBase = path.basename(targetId, '.md')
  const adrRefs = _inferAdrShortRefs(targetId)
  const allMatchers = [targetBase, ...adrRefs]

  // 1. frontmatter 显式字段
  for (const m of allMatchers) {
    if (new RegExp(`(supersedes|amends|superseded_by):\\s*[\\s\\S]{0,200}?${_escapeReg(m)}`, 'i').test(fm)) return true
  }
  // 2. related: 数组中 target 这一行含历史措辞
  const relMatch = fm.match(/^related:\s*\n([\s\S]*?)(?=\n[a-zA-Z_]+:|\n*$)/m)
  if (relMatch) {
    for (const m of allMatchers) {
      const targetLine = relMatch[1].split('\n').find(l => l.includes(m))
      if (targetLine && /(superseded|取代|废|amend|deprecated)/i.test(targetLine)) return true
    }
  }
  // 3. body 里 target 短引用 + 历史措辞同行 / 邻 2 行
  const bodyLines = body.split('\n')
  for (let i = 0; i < bodyLines.length; i++) {
    let hit = null
    for (const m of allMatchers) { if (bodyLines[i].includes(m)) { hit = m; break } }
    if (!hit) continue
    const window = bodyLines.slice(Math.max(0, i - 2), Math.min(bodyLines.length, i + 3)).join(' ')
    // 取代措辞 + 前车之鉴/反面教材措辞(2026-06-11: ADR-036 在风险表引 deprecated 的 ADR-026「同款死因」当反例,
    // 是正当历史引用非 stale,但原启发器只认取代词漏判 → 补 cautionary-cite 词汇)
    if (/(superseded\s*(by)?|supersedes|amend(ed|ment)?|取代|已废|历史|deprecat|激活|backfilled|死因|反面|前车|教训|反例|重蹈|覆辙|吸取|警示|cautionary|anti-pattern|反模式)/i.test(window)) return true
  }
  return false
}
