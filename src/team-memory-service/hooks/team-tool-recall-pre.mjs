#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logTrace, logWarn } from './_lib/hook-log.mjs'

const HOOK_NAME = 'team-tool-recall-pre'
const HOME = process.env.USERPROFILE || process.env.HOME || ''
const ROOT = process.env.KOS_DATA_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const HOOK_FIRE_COUNTER = resolve(ROOT, 'logs', 'hook-fire-counter.jsonl')

function loadEnvFromFile(path) {
  try {
    const text = readFileSync(path, 'utf-8')
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  } catch {}
}
for (const p of [
  process.env.TEAM_MEMORY_ENV_FILE,            // 显式指定，最高优先
  resolve(HOME, '.claude/.env.local'),         // 通用位置（跨 owner 都该有）
  process.env.AGENT_WORKSPACE_ENV,             // 各 owner 自己的 workspace env
].filter(Boolean)) loadEnvFromFile(p)

const TM_SERVICE_URL = process.env.KOS_SERVICE_URL || process.env.TM_SERVICE_URL || 'http://127.0.0.1:3000'
const EMBEDDING_API_BASE = process.env.EMBEDDING_API_BASE_URL || 'https://api.openai.com/v1'
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small'
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10)

const envNum = (name, dflt) => { const v = Number.parseFloat(process.env[name] || ''); return Number.isFinite(v) && v > 0 ? v : dflt }
const BUDGET_HINT_CHARS   = envNum('KOS_BUDGET_HINT_CHARS', 420)
const BUDGET_RECALL_CHARS = envNum('KOS_BUDGET_RECALL_CHARS', 1600)  // ≤5 条 × ~290 字的现状包络

async function embedQuery(text) {
  if (!EMBEDDING_API_KEY) return null
  try {
    const r = await fetch(`${EMBEDDING_API_BASE}/embeddings`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${EMBEDDING_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIM, encoding_format: 'float' }),
      signal: AbortSignal.timeout(2000),
    })
    if (!r.ok) {
      logWarn(HOOK_NAME, 'embed_failed', { cause: 'http_' + r.status })
      return null
    }
    return (await r.json()).data[0].embedding
  } catch (e) {
    logWarn(HOOK_NAME, 'embed_failed', { cause: e.name === 'TimeoutError' ? 'timeout' : 'fetch', err: String(e.message).slice(0, 120) })
    return null
  }
}

const TEAM_TOOL_QUERY_HINTS = {
  'hq-send':          '飞书 CG 群 通信路由 团队广播 消息（ADR-029 后单一通道）',
  'send-as-xiaomeng': '飞书群消息 通信路由 daemon helper',
  'town-inbox':       '飞书 daemon 收件箱 通信路由',
  'town-status':      'town status 心跳 主会话',
  'town-claim-session': 'town claim session 主会话 daemon',

  'asi':       'ASI协议 codex 调度 mirror state',
  'codex-run': 'codex prompt 大小 调用协议 主权 4KB',

  'q-impact-radius':  'KG 影响面 改rule 评估 节点',
  'q-feature-trace':  'KG feature 跨产物 追溯',
  'q-vector-search':  'KG 语义检索 概念',
  'q-find-file':      'KG 找文件 节点',
  'q-lint':           'KG 健康 cold-rule sweep stale',
  'q-cold-leaves':    'KG cold 叶节点 maturity 降级',
  'q-stale-chains':   'KG stale chain 长期未引用',
  'q-hub-rules':      'KG centrality hub rule',
  'q-channel-routing-audit': '通信路由 zone DM channel 审计',
  'knowledge-graph-gen': 'KG 生成 regen incremental ADR-022',

  'memory-audit':           'memory audit 孤儿 stale 索引',
  'maturity-auto-update':   '[RETIRED ADR-047 2026-06-16] 旧 maturity 自动升降，已退役',
  'maturity-draft-digest':  'draft 积压每日 digest → DM owner promote/expire（ADR-047 后安全网）',
  'cold-rule-sweep':        'cold rule sweep 60天 maturity 降级',
  'hook-rule-reference-audit': 'rule 引用 60天窗口 git log',
  'topic-promotion-scorer': '议题池 promotion rule 候选 阈值',
  'backfill-maturity':      'maturity backfill 历史 frontmatter',

  'daemon-self-check':  'daemon 自检 健康 watchdog',
  'snapshot-refresh':   'snapshot 状态 daemon 刷新',
}

const TOOL_REGEX = /(?:^|\s|\/|\\)([\w-]+)\.(mjs|sh|bat|cjs|js|py)\b/g

function detectTeamTool(command) {
  if (!command || typeof command !== 'string') return null
  TOOL_REGEX.lastIndex = 0
  let m
  while ((m = TOOL_REGEX.exec(command)) !== null) {
    const name = m[1]
    if (name in TEAM_TOOL_QUERY_HINTS) return name
  }
  return null
}

function emitRuleFireTelemetry(hits, triggerKeyword) {
  const ruleHits = hits.filter(h => h?.type === 'rule')
  if (ruleHits.length === 0) return
  const now = new Date().toISOString()
  const lines = ruleHits.map(h => JSON.stringify({
    ts: now,
    rule_id: String(h.id),
    rule_name: h.name || h.summary || '',
    trigger_keyword: triggerKeyword,
  })).join('\n') + '\n'
  try {
    mkdirSync(dirname(HOOK_FIRE_COUNTER), { recursive: true })
    appendFileSync(HOOK_FIRE_COUNTER, lines, 'utf-8')
  } catch (e) {
    logWarn(HOOK_NAME, 'telemetry_write_failed', { err: e.message })
  }
}

let input = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', d => input += d)
process.stdin.on('end', async () => {
  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { process.exit(0) }

  const sessionId = payload.session_id || payload.sessionId || 'unknown'
  const cmd = payload.tool_input?.command || ''
  const toolName = detectTeamTool(cmd)
  if (!toolName) process.exit(0)  // 不在团队白名单，放行

  const MEMO_TTL_MS = 30 * 60 * 1000
  const memoDir = resolve(process.env.TEMP || process.env.TMPDIR || '/tmp', 'claude-hooks')
  const memoPath = resolve(memoDir, `team-tool-recall-${sessionId}.json`)
  let memo = {}
  try { memo = JSON.parse(readFileSync(memoPath, 'utf-8')) } catch {}
  if (memo[toolName] && Date.now() - memo[toolName] < MEMO_TTL_MS) {
    logTrace(HOOK_NAME, 'memo_skip', { sessionId, tool: toolName })
    process.exit(0)
  }

  const token = process.env.KOS_SERVICE_TOKEN
  if (!token) {
    logWarn(HOOK_NAME, 'no_token', { sessionId, tool: toolName })
    process.exit(0)
  }

  const queryText = TEAM_TOOL_QUERY_HINTS[toolName] || toolName

  const queryEmbedding = await embedQuery(queryText)

  let recallData
  try {
    const r = await fetch(`${TM_SERVICE_URL}/api/recall`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: queryText,
        query_embedding: queryEmbedding,
        limit: 5,
        min_importance: 6,
        scope_filter: ['all-agents'],
        source: 'team-tool-recall-hook',
        session_id: sessionId,
      }),
      signal: AbortSignal.timeout(2500),
    })
    if (!r.ok) {
      logWarn(HOOK_NAME, 'service_error', { status: r.status, sessionId, tool: toolName })
      process.exit(0)
    }
    recallData = await r.json()
  } catch (e) {
    logWarn(HOOK_NAME, 'fetch_failed', { err: e.message, sessionId, tool: toolName })
    process.exit(0)
  }

  const hits = recallData.hits || []
  if (hits.length === 0) {
    logTrace(HOOK_NAME, 'miss', { sessionId, tool: toolName })
    process.exit(0)
  }
  emitRuleFireTelemetry(hits, toolName)

  const tagLine = (line) => {
    if (/用法|usage|命令格式|调用方式|参数|启动命令|配置|format|铁律|规则|protocol|SOP|速查|入口|api/i.test(line)) return '🟢 ' + line
    if (/事故|坑\b|误写|陷阱|历史踩坑|失败|被丢弃|incident|fix\b/i.test(line)) return '🔴 ' + line
    if (/警告|注意|cooldown|侧记|note:|warning|side[-_]?note/i.test(line)) return '🟡 ' + line
    return '⚪ ' + line
  }

  const renderedLines = hits.slice(0, 5).map(h => {
    const sum = h.summary ? `📌 ${h.summary}` : (h.name || '(no summary)')
    const body = (h.content || '').slice(0, 200).replace(/\n+/g, ' ')
    const line = `[id:${h.id} ${h.type} ${h.maturity} ★${h.importance}] ${sum}\n  ${body}${(h.content || '').length > 200 ? '...' : ''}`
    return tagLine(line)
  })

  const lines_out = []
  let recallUsed = 0
  for (const line of renderedLines) {
    const len = Array.from(line).length
    if (lines_out.length > 0 && recallUsed + len > BUDGET_RECALL_CHARS) break
    lines_out.push(line)
    recallUsed += len
  }
  const trimmed = renderedLines.length - lines_out.length

  let headerText =
    `🌐 [team-tool-recall] \`${toolName}\` 命中 ${hits.length} 条**团队** meta（铁律/playbook/ADR）。\n` +
    `**优先按团队规范跑，避免漂移**——挑 🟢 直接采用，🔴/🟡 防坑参考：\n\n`
  let footerText = `\n\n（⏱ ${recallData.duration_ms}ms ${recallData.query_path} · 跟个人 🔧 hook 共存：个人版召踩坑 / 本 hook 召团队规范）`
  if (Array.from(headerText).length + Array.from(footerText).length > BUDGET_HINT_CHARS) {
    footerText = ''
    headerText = Array.from(headerText).slice(0, BUDGET_HINT_CHARS).join('')
  }

  const additionalContext = headerText + lines_out.join('\n\n') + footerText

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext,
    },
  }))
  logTrace(HOOK_NAME, 'hit', {
    sessionId,
    tool: toolName,
    hits: hits.length,
    injected: lines_out.length,
    budget: { hint: Array.from(headerText).length + Array.from(footerText).length, recall: recallUsed, trimmed },
  })
  try {
    mkdirSync(memoDir, { recursive: true })
    memo[toolName] = Date.now()
    writeFileSync(memoPath, JSON.stringify(memo))
  } catch {}
  process.exit(0)
})
