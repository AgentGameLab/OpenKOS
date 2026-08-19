#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { hybridRecall, VISIBLE_STATUS_SQL } from './lib/recall.mjs'
import { storeMemory, promoteMaturity, assertSupersedesWithinWriteScopes } from './lib/store.mjs'
import { getPool, closePool, query } from './lib/db.mjs'
import { authenticate, checkTokenTableAccess } from './lib/auth.mjs'
import {
  AuthorizationError,
  authorizeRequestedScopes,
  authorizeWriteScope,
  resolveWriteScopes,
  resolveDefaultScopes,
  requirePermission,
  requireRole,
} from './lib/authz.mjs'
import { handleMemoryWrite } from './lib/memory-endpoint.mjs'
import { createAuditLogger } from './lib/audit.mjs'
import { OperationSemaphore, resolveBudgetCap } from './lib/db-budget.mjs'
import { createRecallOperation } from './lib/recall-operation.mjs'
import { loadRoster } from '../kos/roster.mjs'


const ENV_CANDIDATES = [
  process.env.KOS_SERVICE_ENV_FILE,
  process.env.USERPROFILE ? `${process.env.USERPROFILE}/.team-memory-service/.env` : null,
  process.env.HOME ? `${process.env.HOME}/.team-memory-service/.env` : null,
].filter(Boolean)

let envLoadedFrom = null
for (const candidate of ENV_CANDIDATES) {
  try {
    const envText = readFileSync(candidate, 'utf-8')
    for (const line of envText.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
    envLoadedFrom = candidate
    break
  } catch { /* try next */ }
}

const roster = loadRoster()

const auditLogger = createAuditLogger()
const recallBudget = new OperationSemaphore({
  cap: resolveBudgetCap(process.env.KOS_DB_BUDGET),
  name: 'recall',
})
const runRecallOperation = createRecallOperation({
  semaphore: recallBudget,
  auditLog: (entry) => auditLogger.log(entry),
})
const MAX_RECALL_LIMIT = 20
const MAX_JSON_BODY_BYTES = 1024 * 1024

class RequestBodyError extends Error {
  constructor(statusCode, message, cause) {
    super(message)
    this.name = 'RequestBodyError'
    this.statusCode = statusCode
    this.cause = cause
  }
}

function recallCaller(authContext, fallback) {
  return authContext?.agent_name || authContext?.agent_id || fallback || 'unknown'
}

function normalizeRecallLimit(value) {
  if (!Number.isInteger(value)) return 5
  return Math.max(1, Math.min(value, MAX_RECALL_LIMIT))
}

async function updateOwnedFinalCount(recallLogId, finalCount, agentId) {
  const result = await query(
    `UPDATE team_memory.recall_log
     SET final_hit_count = $1
     WHERE id = $2 AND agent_id = $3
     RETURNING id`,
    [finalCount, recallLogId, agentId]
  )
  return result.rowCount === 1
}

function createServer(authContext) {
  const s = new McpServer({ name: 'team-memory', version: '0.1.0' })

  s.tool(
    'team_recall_memory',
    '从团队共享记忆（team-memory）召回相关条目。涉及团队铁律 / 协作 / 架构决策 / playbook 时调用。返回 hybrid（FTS + vector RRF）召回的 top-N。',
    {
      query: z.string().describe('查询词，自然语言'),
      limit: z.number().int().min(1).max(MAX_RECALL_LIMIT).optional().default(5).describe('返回条数（默认 5）'),
      min_importance: z.number().int().min(1).max(10).optional().default(0).describe('最低重要性（默认 0=不限）'),
      maturity_filter: z.array(z.enum(['draft', 'verified', 'proven'])).optional().describe('maturity 硬过滤（ADR-047-A1 默认不过滤：draft 可召回但通过 rank-offset（draft +4）低可见度保低位，输出带 ⚠️ 标记；只在明确要"仅定稿知识"时才传）'),
      type_filter: z.array(z.string()).optional().describe('type 过滤（rule/playbook/decision/...）'),
      scope_filter: z.array(z.string()).optional().describe('scope 过滤（默认当前 principal 的可见 scopes）'),
      include_superseded: z.boolean().optional().default(false).describe('是否包含 status=superseded 历史条目（默认 false 过滤掉，追溯/对比用才设 true）'),
      query_embedding: z.array(z.number()).length(1024).optional().describe('1024d query embedding（可选；不传则只走 FTS）'),
    },
    async (args) => {
      requirePermission(authContext, 'memory:read')
      const authorizedScopes = authorizeRequestedScopes(authContext, args.scope_filter, resolveDefaultScopes(authContext))
      const recallOptions = {
        queryText: args.query,
        queryEmbedding: args.query_embedding,
        limit: args.limit,
        minImportance: args.min_importance,
        maturityFilter: args.maturity_filter,
        typeFilter: args.type_filter,
        scopeFilter: authorizedScopes,
        includeSuperseded: args.include_superseded === true,
        logCtx: {
          source: 'mcp',
          agentId: authContext?.agent_id,
          agentName: authContext?.agent_name,
        },
      }
      const result = await runRecallOperation({
        caller: recallCaller(authContext, 'mcp'),
        request: { ...args, source: 'mcp' },
        execute: () => hybridRecall(recallOptions),
      })

      if (result.hits.length === 0) {
        return { content: [{ type: 'text', text: '（无相关团队记忆）' }] }
      }

      const lines = result.hits.map(h => {
        const tags = h.tags?.length ? ` #${h.tags.slice(0, 3).join(' #')}` : ''
        const sum = h.summary ? `\n  📌 ${h.summary}` : ''
        const body = (h.content || '').slice(0, 300).replace(/\n+/g, ' ')
        const trust = ['proven', 'verified'].includes(h.maturity) ? '' : ' ⚠️未实证·仅供参考'
        return `[id:${h.id} ${h.type} ${h.maturity || 'no-maturity'}${trust} ★${h.importance} ${h.recall_sources.join('+')}]${tags}${sum}\n  ${body}${(h.content || '').length > 300 ? '...' : ''}`
      })

      const text = `🌐 [team memory] 命中 ${result.hits.length} 条（${result.query_path} · ${result.duration_ms}ms · recall_log_id=${result.recall_log_id}）：\n\n${lines.join('\n\n')}`
      return {
        content: [{ type: 'text', text }],
        _meta: { recall_log_id: result.recall_log_id, query_path: result.query_path, duration_ms: result.duration_ms },
      }
    }
  )

  s.tool(
    'team_store_memory',
    `存入团队共享记忆。新写入默认 maturity=draft（必须经 promotion 流程升 verified/proven）。type=decision 自动 requires_review=true 等 ${roster.roles.approver} + ${roster.roles.reviewer} 双签。`,
    {
      content: z.string().min(10).describe('记忆内容（必填）'),
      name: z.string().optional().describe('可读名'),
      description: z.string().optional().describe('一句话钩子'),
      summary: z.string().optional().describe('一句话摘要'),
      type: z.enum(['snapshot', 'pointer', 'rule', 'playbook', 'decision', 'feedback', 'user', 'general']).optional().default('rule'),
      topic: z.string().optional(),
      scope: z.string().optional().default('all-agents'),
      importance: z.number().int().min(1).max(10).optional().default(5),
      memory_level: z.enum(['concrete_trace', 'semi_abstract', 'meta_knowledge']).optional().default('meta_knowledge'),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
      supersedes: z.array(z.number()).optional().describe('被取代的旧记忆 id 列表（同步设 t_invalid）'),
      content_vector: z.array(z.number()).length(1024).optional().describe('1024d content embedding（client 端预算）'),
      metadata: z.record(z.any()).optional(),
    },
    async (args) => {
      requirePermission(authContext, 'memory:write')
      const authorizedScope = authorizeWriteScope(authContext, args.scope)
      const result = await storeMemory({
        ...args,
        scope: authorizedScope,
        author_agent_id: authContext?.agent_id || null,
        authorizedWriteScopes: resolveWriteScopes(authContext),
      })
      const note = result.status === 'duplicate'
        ? `⚠️ 已存在相同 content（hash=${result.hash}），返回原 id=${result.id}（未重复写入）`
        : `✓ 存入 team-memory id=${result.id} maturity=draft（默认 draft，待 cron 升 verified / 或人工审 proven）`
      return { content: [{ type: 'text', text: note }] }
    }
  )

  s.tool(
    'team_memory_stats',
    '查看团队记忆统计：总数 / 按 type / 按 maturity / 近 24h recall 调用数',
    {},
    async () => {
      requirePermission(authContext, 'memory:read')
      const total = await query(`SELECT COUNT(*) AS c FROM team_memory.memories WHERE t_invalid IS NULL AND ${VISIBLE_STATUS_SQL} AND scope = ANY($1)`, [authContext.scopes])
      const byType = await query(`SELECT type, COUNT(*) AS c FROM team_memory.memories WHERE t_invalid IS NULL AND ${VISIBLE_STATUS_SQL} AND scope = ANY($1) GROUP BY type ORDER BY c DESC`, [authContext.scopes])
      const byMat = await query(`SELECT maturity, COUNT(*) AS c FROM team_memory.memories WHERE t_invalid IS NULL AND ${VISIBLE_STATUS_SQL} AND scope = ANY($1) GROUP BY maturity ORDER BY maturity`, [authContext.scopes])
      const recall24h = await query(`SELECT COUNT(*) AS c FROM team_memory.recall_log WHERE ts > now() - interval '24 hours'`)
      const out = [
        `total: ${total.rows[0].c}`,
        `by type: ${byType.rows.map(r => `${r.type}=${r.c}`).join(' / ')}`,
        `by maturity: ${byMat.rows.map(r => `${r.maturity}=${r.c}`).join(' / ')}`,
        `recall calls (24h): ${recall24h.rows[0].c}`,
      ].join('\n')
      return { content: [{ type: 'text', text: out }] }
    }
  )

  s.tool(
    'team_promote_maturity',
    `提升 memory 的 maturity 等级（draft → verified 由 owner 显式 promote，2026-06-16 ADR-047 退役了自动 cron；verified → proven 必须 ${roster.roles.approver} ack）。手动调此工具 = ack 操作。⚠️ draft 不被 recall，写完必升 verified。`,
    {
      memory_id: z.number().int().describe('memory id'),
      to_maturity: z.enum(['verified', 'proven']),
      reason: z.string().optional().describe('升降原因'),
    },
    async (args) => {
      requirePermission(authContext, 'memory:promote')
      if (args.to_maturity === 'proven') requireRole(authContext, 'approver')
      const r = await promoteMaturity({
        memoryId: args.memory_id,
        toMaturity: args.to_maturity,
        approvedBy: authContext?.agent_id,
        approvedByName: authContext?.agent_name,
        reason: args.reason,
        authorizedWriteScopes: resolveWriteScopes(authContext),
      })
      return { content: [{ type: 'text', text: `✓ 升格 id=${r.id}: ${r.from} → ${r.to}` }] }
    }
  )

  s.tool(
    'team_update_recall_final_count',
    'hook 后置过滤完后回写 final_hit_count（区分 raw 候选池 vs 真注入数）。fire-and-forget 即可。',
    {
      recall_log_id: z.number().int(),
      final_count: z.number().int().min(0),
    },
    async (args) => {
      requirePermission(authContext, 'memory:read')
      const updated = await updateOwnedFinalCount(
        args.recall_log_id,
        args.final_count,
        authContext?.agent_id
      )
      if (!updated) throw new AuthorizationError('recall_log record not owned by caller')
      return { content: [{ type: 'text', text: `✓ updated recall_log id=${args.recall_log_id} final_count=${args.final_count}` }] }
    }
  )

  return s
}

const args = process.argv.slice(2)
const useHttp = args.includes('--transport=http')
const portArg = args.find(a => a.startsWith('--port='))
const PORT = portArg ? parseInt(portArg.split('=')[1], 10) : 3000
const bindArg = args.find(a => a.startsWith('--bind='))
const HOST = bindArg ? bindArg.split('=')[1] : '127.0.0.1'

let httpServer = null

const gracefulExit = async (reason) => {
  console.error(`[team-memory] graceful exit: ${reason}`)
  try {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve))
  } catch {}
  try { await auditLogger.drain() } catch {}
  auditLogger.stop()
  try { await closePool() } catch {}
  process.exit(0)
}

if (!useHttp) {
  console.error('team-memory-service 仅支持 HTTP transport（团队多 client 共享）。请加 --transport=http')
  process.exit(1)
}

const sessions = new Map()  // sessionId → { transport, server, agent, principalId }
const TM_DB_URL = process.env.TM_DATABASE_URL
let tokenTableHealth = { ok: false, status: 'checking' }

if (!TM_DB_URL) {
  console.error('❌ TM_DATABASE_URL not set. 加载 .env.local 失败 / 或 ECS 未配置 env')
  process.exit(1)
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let byteLength = 0
    let settled = false
    const contentLength = Number.parseInt(req.headers['content-length'] || '', 10)
    if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
      settled = true
      reject(new RequestBodyError(413, 'request body too large'))
    }
    req.on('data', (c) => {
      if (settled) return
      byteLength += c.length
      if (byteLength > MAX_JSON_BODY_BYTES) {
        settled = true
        chunks.length = 0
        reject(new RequestBodyError(413, 'request body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      try {
        settled = true
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'))
      } catch (e) {
        settled = true
        reject(new RequestBodyError(400, 'invalid JSON body', e))
      }
    })
    req.on('error', (e) => {
      if (settled) return
      settled = true
      reject(e)
    })
  })
}

httpServer = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(tokenTableHealth.ok ? 200 : 503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: tokenTableHealth.ok,
      status: tokenTableHealth.status,
      server: 'team-memory-service',
      version: '0.1.0',
      transport: 'http',
      active_sessions: sessions.size,
      uptime_sec: Math.floor(process.uptime()),
      checks: {
        auth_token_table: { ok: tokenTableHealth.ok },
      },
    }))
    return
  }

  if (req.url?.startsWith('/api/')) {
    try {
      const u = new URL(req.url, 'http://x')
      const path = u.pathname
      const sensitive = (
        (path === '/api/memory' || path === '/api/store') &&
        req.method === 'POST'
      )
      const auth = await authenticate(req, TM_DB_URL, { sensitive })
      if (!auth.ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: auth.error }))
        return
      }

      if (path === '/api/recall' && req.method === 'POST') {
        const body = await readJsonBody(req)
        requirePermission(auth.agent, 'memory:read')
        const authorizedScopes = authorizeRequestedScopes(auth.agent, body.scope_filter, resolveDefaultScopes(auth.agent))
        const rankProfile = body.rank_profile === undefined ? 'layered' : body.rank_profile
        if (!['layered', 'flat'].includes(rankProfile)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `rank_profile 只接受 layered/flat，收到 ${String(body.rank_profile)}` }))
          return
        }
        const recallOptions = {
          queryText: body.query,
          queryEmbedding: body.query_embedding,
          limit: normalizeRecallLimit(body.limit),
          minImportance: body.min_importance || 0,
          maturityFilter: body.maturity_filter || null,
          typeFilter: body.type_filter,
          scopeFilter: authorizedScopes,
          includeExpired: body.include_expired === true,
          includeSuperseded: body.include_superseded === true,
          rankProfile,
          logCtx: {
            source: body.source || 'rest',
            agentId: auth.agent.agent_id,
            agentName: auth.agent.agent_name,
            sessionId: body.session_id || null,
          },
        }
        const result = await runRecallOperation({
          caller: recallCaller(auth.agent, body.source || 'rest'),
          request: body,
          execute: () => hybridRecall(recallOptions),
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      if ((path === '/api/memory' || path === '/api/store') && req.method === 'POST') {
        const body = await readJsonBody(req)
        requirePermission(auth.agent, 'memory:write')
        if (
          body.index_only === true &&
          body.scope !== undefined &&
          !['all-agents', 'team'].includes(body.scope)
        ) {
          throw new AuthorizationError('index_only 仅允许 all-agents/team scope')
        }
        const requestedScope = body.index_only === true
          ? 'all-agents'
          : body.scope !== undefined ? body.scope : (
              ['feedback', 'reference', 'correction'].includes(body.type)
                ? 'personal'
                : 'team'
            )
        authorizeWriteScope(auth.agent, requestedScope)
        await assertSupersedesWithinWriteScopes(body.supersedes, resolveWriteScopes(auth.agent))
        if (body.maturity === 'verified' || body.maturity === 'proven') {
          requirePermission(auth.agent, 'memory:promote')
        }
        if (body.maturity === 'proven') requireRole(auth.agent, 'approver')
        const authorizedBody = body.index_only === true
          ? body
          : { ...body, scope: requestedScope }
        const result = await handleMemoryWrite(authorizedBody, auth.agent, { skipPgMirror: false })
        const headers = { 'Content-Type': 'application/json' }
        if (path === '/api/store') {
          headers['Deprecation'] = 'true'
          headers['Sunset'] = 'Wed, 10 Jun 2026 00:00:00 GMT'
          headers['Link'] = '</api/memory>; rel="successor-version"'
          headers['Warning'] = '299 - "/api/store deprecated; use /api/memory (sunset 2026-06-10)"'
        }
        res.writeHead(result.status, headers)
        res.end(JSON.stringify(result.body))
        return
      }

      if (path === '/api/update-final' && req.method === 'POST') {
        requirePermission(auth.agent, 'memory:read')
        const body = await readJsonBody(req)
        if (
          !Number.isInteger(body.recall_log_id) ||
          body.recall_log_id < 1 ||
          !Number.isInteger(body.final_count) ||
          body.final_count < 0
        ) {
          throw new RequestBodyError(400, 'invalid update-final body')
        }
        const updated = await updateOwnedFinalCount(
          body.recall_log_id,
          body.final_count,
          auth.agent.agent_id
        )
        if (!updated) throw new AuthorizationError('recall_log record not owned by caller')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (path === '/api/stats' && req.method === 'GET') {
        requirePermission(auth.agent, 'memory:read')
        const total = await query(`SELECT COUNT(*) AS c FROM team_memory.memories WHERE t_invalid IS NULL AND ${VISIBLE_STATUS_SQL}`)
        const byType = await query(`SELECT type, COUNT(*) AS c FROM team_memory.memories WHERE t_invalid IS NULL AND ${VISIBLE_STATUS_SQL} GROUP BY type`)
        const byMat = await query(`SELECT maturity, COUNT(*) AS c FROM team_memory.memories WHERE t_invalid IS NULL AND ${VISIBLE_STATUS_SQL} GROUP BY maturity`)
        const recall24h = await query(`SELECT COUNT(*) AS c FROM team_memory.recall_log WHERE ts > now() - interval '24 hours'`)
        const vecCov = await query(`SELECT COUNT(*) AS total, COUNT(content_vector) AS with_vec
          FROM team_memory.memories WHERE t_invalid IS NULL AND status = 'active'`)
        const qPath24h = await query(`SELECT query_path, COUNT(*) AS c FROM team_memory.recall_log
          WHERE ts > now() - interval '24 hours' GROUP BY query_path`)
        const vTotal = Number(vecCov.rows[0].total), vWith = Number(vecCov.rows[0].with_vec)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          total: Number(total.rows[0].c),
          by_type: Object.fromEntries(byType.rows.map(r => [r.type, Number(r.c)])),
          by_maturity: Object.fromEntries(byMat.rows.map(r => [r.maturity, Number(r.c)])),
          recall_calls_24h: Number(recall24h.rows[0].c),
          vec_coverage: {
            active_total: vTotal,
            with_vector: vWith,
            null_vector: vTotal - vWith,
            coverage_pct: vTotal ? Math.round((vWith / vTotal) * 1000) / 10 : null,
          },
          query_path_24h: Object.fromEntries(qPath24h.rows.map(r => [r.query_path, Number(r.c)])),
        }))
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown REST endpoint' }))
    } catch (e) {
      console.error('[REST] error:', e?.cause?.stack || e?.stack || e)
      if (!res.headersSent) {
        const status = e instanceof AuthorizationError
          ? 403
          : e instanceof RequestBodyError ? e.statusCode : 500
        const message = status === 403
          ? 'forbidden'
          : status === 413
            ? 'request body too large'
            : status === 400 ? 'invalid request body' : 'internal server error'
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: message }))
      }
    }
    return
  }

  if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
    try {
      const auth = await authenticate(req, TM_DB_URL, { sensitive: true })
      if (!auth.ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: auth.error }))
        return
      }

      const sessionId = req.headers['mcp-session-id']
      const principalId = auth.agent.agent_id
      let entry = sessionId ? sessions.get(sessionId) : null
      if (entry && entry.principalId !== principalId) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'MCP session principal mismatch' }))
        return
      }

      if (!entry) {
        const newServer = createServer(auth.agent)
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, {
              transport: newTransport,
              server: newServer,
              agent: auth.agent,
              principalId,
            })
            console.error(`[team-memory] session opened: ${newSessionId.slice(0, 8)} (agent=${auth.agent.agent_name}, total=${sessions.size})`)
          },
          onsessionclosed: (closedSessionId) => {
            sessions.delete(closedSessionId)
            console.error(`[team-memory] session closed: ${closedSessionId.slice(0, 8)} (total=${sessions.size})`)
          },
        })
        await newServer.connect(newTransport)
        entry = { transport: newTransport, server: newServer, agent: auth.agent, principalId }
      }
      await entry.transport.handleRequest(req, res)
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal server error' }))
      }
      console.error('[team-memory] handler error:', e?.stack || e)
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
})

getPool()
const tokenTableAccess = await checkTokenTableAccess(TM_DB_URL)
tokenTableHealth = tokenTableAccess.ok
  ? { ok: true, status: 'healthy' }
  : { ok: false, status: 'degraded' }
if (!tokenTableAccess.ok) {
  console.error(
    `[team-memory-service] ⚠️  CRITICAL: database role cannot SELECT team_memory.service_tokens — ` +
    `所有 token 验证都会失败（全员 401）。修复：GRANT SELECT ON team_memory.service_tokens TO database role;`
  )
  console.error(`[team-memory-service] 探测错误：${tokenTableAccess.error}`)
  if (process.env.TM_STRICT_STARTUP === '1') {
    console.error('[team-memory-service] TM_STRICT_STARTUP=1，自检失败，拒绝启动')
    auditLogger.stop()
    await closePool().catch(() => {})
    process.exit(1)
  }
} else {
  console.error('[team-memory-service] Auth self-check OK (agent_tokens readable)')
}

httpServer.listen(PORT, HOST, () => {
  console.error(`[team-memory-service] HTTP MCP server listening on http://${HOST}:${PORT}/mcp (PID ${process.pid})`)
  console.error(`[team-memory-service] Health: http://${HOST}:${PORT}/health`)
  console.error(`[team-memory-service] Auth: Bearer <KOS_SERVICE_TOKEN>`)
})

process.on('SIGINT', () => gracefulExit('SIGINT'))
process.on('SIGTERM', () => gracefulExit('SIGTERM'))
process.on('SIGHUP', () => gracefulExit('SIGHUP'))
