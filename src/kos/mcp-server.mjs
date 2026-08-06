#!/usr/bin/env node
// ============================================================
// KOS L3 MCP Server v0.1.0 — Knowledge Orchestration System
//
// 为 KOS 团队提供双 KG（self + UA）桥接查询工具。
// 按 ADR-028 设计。原 batch 4 的 kos_health / kos_remember 已补齐——5 工具 handler 全部实现。
//
// 工具清单（5 个全实现）：
//   kos_impact   — 影响面查询（path or repoKey:relPath）→ kg/cross-query.mjs
//   kos_feature  — 跨产物追踪（列出双 KG 桥接节点）→ kg/cross-query.mjs
//   kos_stats    — KOS 双 KG 桥接率统计 → kg/cross-query.mjs
//   kos_health   — KG 健康四件套聚合（cold-leaves + stale-chains + lint + sediment）
//   kos_remember — KOS 写入（路由到 ./kos-remember.mjs）
//
// 每次调用 emit metric 到 <ROOT>/.asi/kos-query-metrics.jsonl
// ⚠️ 运行时实证：自 2026-05-10 注册起 0 成功调用（kos-query-metrics.jsonl 从未生成）；
//    ADR-028 §4 KPI 累计 13、5-14 后归 0、40x gap。L3 MCP indirection 待 sunset。
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { handleKosRememberRequest, kosRememberInputSchema } from './kos-remember-tool.mjs'

// ── 路径解析 ───────────────────────────────────────────────────────────────

const ROOT = path.resolve(process.env.KOS_DATA_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const METRICS_DIR = path.join(ROOT, '.asi')
const METRICS_FILE = path.join(METRICS_DIR, 'kos-query-metrics.jsonl')

// ── Metric emit ────────────────────────────────────────────────────────────

function emitMetric(tool, args, latency_ms, ok) {
  try {
    fs.mkdirSync(METRICS_DIR, { recursive: true })
  } catch {}
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tool,
      args,
      latency_ms,
      ok,
    }) + '\n'
    fs.appendFileSync(METRICS_FILE, line)
  } catch {}
}

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'kos-mcp-server',
  version: '0.1.0',
})

// ── kos_impact ─────────────────────────────────────────────────────────────

server.tool(
  'kos_impact',
  '影响面查询：改某 file/rule 影响哪些产物（双 KG 桥接）',
  {
    input: z.string().describe('path or repoKey:relPath'),
  },
  async ({ input }) => {
    const t0 = Date.now()
    let ok = false
    try {
      const mod = await import('../kg/cross-query.mjs')
      const result = await mod.lookup(input)
      ok = true
      const text = JSON.stringify(result, null, 2)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `kos_impact failed: ${err.message}` }],
        isError: true,
      }
    } finally {
      emitMetric('kos_impact', { input }, Date.now() - t0, ok)
    }
  }
)

// ── kos_feature ────────────────────────────────────────────────────────────

server.tool(
  'kos_feature',
  '跨产物追踪：列出双 KG 桥接节点（self + UA 都命中）',
  {
    limit: z.number().int().min(1).max(100).optional().default(20),
  },
  async ({ limit }) => {
    const t0 = Date.now()
    let ok = false
    try {
      const mod = await import('../kg/cross-query.mjs')
      const result = await mod.listBridged()
      const sliced = Array.isArray(result) ? result.slice(0, limit) : result
      ok = true
      const text = JSON.stringify(sliced, null, 2)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `kos_feature failed: ${err.message}` }],
        isError: true,
      }
    } finally {
      emitMetric('kos_feature', { limit }, Date.now() - t0, ok)
    }
  }
)

// ── kos_stats ──────────────────────────────────────────────────────────────

server.tool(
  'kos_stats',
  'KOS 双 KG 桥接率统计',
  {},
  async () => {
    const t0 = Date.now()
    let ok = false
    try {
      const mod = await import('../kg/cross-query.mjs')
      const result = await mod.stats()
      ok = true
      const text = JSON.stringify(result, null, 2)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `kos_stats failed: ${err.message}` }],
        isError: true,
      }
    } finally {
      emitMetric('kos_stats', {}, Date.now() - t0, ok)
    }
  }
)

// ── kos_health ─────────────────────────────────────────────────────────────
// KG 健康综合检查（cold leaves + stale chains + lint 三件套）
// 三个 q-*.mjs 都是 CLI 主入口式（无 export），用 spawn 调，解析 stdout 抽要点
// ADR-028 Phase C2 — L3 整合 KOS health 检查给 L4 hook 用

const KG_QUERIES_DIR = fileURLToPath(new URL('../kg/queries', import.meta.url))

function runQuery(script, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(KG_QUERIES_DIR, script)], {
      cwd: ROOT,
      env: { ...process.env, KOS_DATA_ROOT: ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { child.kill('SIGTERM') } catch {}
      resolve({ ok: false, stdout: out, stderr: err + `\n[timeout ${timeoutMs}ms]`, code: -1 })
    }, timeoutMs)
    child.stdout.on('data', d => { out += d.toString() })
    child.stderr.on('data', d => { err += d.toString() })
    child.on('close', code => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout: out, stderr: err, code })
    })
    child.on('error', e => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stdout: out, stderr: err + e.message, code: -2 })
    })
  })
}

// 从 q-cold-leaves.mjs stdout 抽要点：cold leaf 总数 + maturity 拆分
function countBefore(stdout, anchor) {
  const match = stdout.match(new RegExp(`^[^\\n]*?(\\d+)[^\\d\\n]{0,16}${anchor}`, 'im'))
  return match ? parseInt(match[1], 10) : 0
}

function parseColdLeaves(stdout) {
  const total = countBefore(stdout, 'cold\\s+leaf')
  const lines = stdout.split('\n')
  let proven = 0, verified = 0, draft = 0
  for (const l of lines) {
    if (/^\|/.test(l)) {
      if (/\|\s*proven\s*\|/.test(l)) proven++
      else if (/\|\s*verified\s*\|/.test(l)) verified++
      else if (/\|\s*draft\s*\|/.test(l)) draft++
    }
  }
  return { total, breakdown: { proven, verified, draft } }
}

// 从 q-stale-chains.mjs stdout 抽要点
function parseStaleChains(stdout) {
  return { total: countBefore(stdout, 'stale') }
}

// 从 q-lint.mjs stdout 抽 health score + 各项 count
function parseLint(stdout) {
  const score = stdout.match(/\*\*Health score\*\*:\s*(\d+)\/100/)
  const issues = stdout.match(/(\d+)\s+issues/)
  const staleRefs = stdout.match(/Stale references[^*]*\*\*(\d+)\*\*/)
  const coldRules = stdout.match(/Cold rules\/playbooks[^*]*\*\*(\d+)\*\*/)
  const orphan = stdout.match(/Orphan code-files[^*]*\*\*(\d+)\*\*/)
  const audience = stdout.match(/Audience mismatches:\s*\*\*(\d+)\*\*/)
  const maturityMissing = stdout.match(/Maturity[^*\n]*\*\*(\d+)\*\*/)
  const channelSuspects = stdout.match(/Channel-routing suspects[^*]*\*\*(\d+)\*\*/)
  return {
    healthScore: score ? parseInt(score[1], 10) : null,
    totalIssues: issues ? parseInt(issues[1], 10) : null,
    staleRefs: staleRefs ? parseInt(staleRefs[1], 10) : 0,
    coldRules: coldRules ? parseInt(coldRules[1], 10) : 0,
    orphanCode: orphan ? parseInt(orphan[1], 10) : 0,
    audienceMismatches: audience ? parseInt(audience[1], 10) : 0,
    maturityMissing: maturityMissing ? parseInt(maturityMissing[1], 10) : 0,
    channelSuspects: channelSuspects ? parseInt(channelSuspects[1], 10) : 0,
  }
}

// ── C: sediment candidates 缓存读取 (sediment-hooks plan §C, 21:55 reconcile) ──
// 不实时跑 (避免 git log + grep 拖慢 kos_health), 读 cron 写的 .asi/sediment-candidates.json
// 配套 cron: scripts/qa/sediment-candidates-cron.mjs (每月 1 号跑)
// Q3 拍板: sediment_candidates 不影响 healthy boolean, 只 surface 给 owner 决策
const SEDIMENT_CANDIDATES_CACHE = path.join(ROOT, '.asi', 'sediment-candidates.json')
const SEDIMENT_STALE_DAYS = 35  // > 35 天没 refresh 标 staleWarning (月度 +5 天 buffer)

function readSedimentCandidates() {
  if (!fs.existsSync(SEDIMENT_CANDIDATES_CACHE)) {
    return { available: false, reason: 'cache_not_generated', hint: 'run: node scripts/qa/sediment-candidates-cron.mjs' }
  }
  try {
    const data = JSON.parse(fs.readFileSync(SEDIMENT_CANDIDATES_CACHE, 'utf-8'))
    const generatedAt = new Date(data.generated_at)
    const ageDays = (Date.now() - generatedAt.getTime()) / (1000 * 60 * 60 * 24)
    return {
      available: true,
      total: data.total || 0,
      byType: data.by_type || {},
      generatedAt: data.generated_at,
      windowDays: data.window_days,
      ageDays: Math.round(ageDays * 10) / 10,
      staleWarning: ageDays > SEDIMENT_STALE_DAYS,
      recentCommits: (data.candidates || []).slice(0, 10),  // surface top 10 in kos_health, full list 在 cache file
    }
  } catch (err) {
    return { available: false, reason: 'cache_parse_error', error: err.message }
  }
}

server.tool(
  'kos_health',
  'KG 健康综合检查：cold leaves + stale chains + lint + sediment candidates 四件套聚合（ADR-028 Phase C2 + sediment-hooks §C）',
  {
    verbose: z.boolean().optional().default(false).describe('true 返回每项原始 stdout，false 只返回摘要'),
  },
  async ({ verbose }) => {
    const t0 = Date.now()
    let ok = false
    try {
      const [cold, stale, lint] = await Promise.all([
        runQuery('q-cold-leaves.mjs'),
        runQuery('q-stale-chains.mjs'),
        runQuery('q-lint.mjs'),
      ])

      const coldSummary = parseColdLeaves(cold.stdout)
      const staleSummary = parseStaleChains(stale.stdout)
      const lintSummary = parseLint(lint.stdout)
      const sedimentCandidates = readSedimentCandidates()

      // healthy 不受 sediment_candidates 影响 (21:55 Q3 拍板: healthy = "需要 attention", 跟 "是否漏沉淀" 解耦)
      const healthy =
        (lintSummary.healthScore ?? 0) >= 80 &&
        coldSummary.breakdown.proven === 0 &&
        staleSummary.total === 0

      const result = {
        healthy,
        summary: {
          score: lintSummary.healthScore,
          totalIssues: lintSummary.totalIssues,
          coldLeaves: coldSummary.total,
          coldProven: coldSummary.breakdown.proven,
          staleChains: staleSummary.total,
          orphanCode: lintSummary.orphanCode,
          audienceMismatches: lintSummary.audienceMismatches,
          maturityMissing: lintSummary.maturityMissing,
          channelSuspects: lintSummary.channelSuspects,
          sedimentCandidatesTotal: sedimentCandidates.available ? sedimentCandidates.total : null,
        },
        coldLeaves: coldSummary,
        staleChains: staleSummary,
        lintIssues: lintSummary,
        sedimentCandidates,
        queryStatus: {
          coldLeaves: { ok: cold.ok, code: cold.code },
          staleChains: { ok: stale.ok, code: stale.code },
          lint: { ok: lint.ok, code: lint.code },
        },
      }
      if (verbose) {
        result.raw = {
          coldLeaves: cold.stdout,
          staleChains: stale.stdout,
          lint: lint.stdout,
        }
      }
      ok = true
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `kos_health failed: ${err.message}` }],
        isError: true,
      }
    } finally {
      emitMetric('kos_health', { verbose }, Date.now() - t0, ok)
    }
  }
)

// ── kos_remember ───────────────────────────────────────────────────────────

server.tool(
  'kos_remember',
  'KOS 写入 memory（ADR-030 §3 Persist 元）：type 决策树路由 + Self-Reflex frontmatter + metric emit',
  kosRememberInputSchema,
  async (args) => handleKosRememberRequest(args, { emitMetric })
)

// ── 启动 ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[kos-mcp] ready')
}

main().catch(err => {
  console.error('[kos-mcp] fatal:', err.message)
  process.exit(1)
})
