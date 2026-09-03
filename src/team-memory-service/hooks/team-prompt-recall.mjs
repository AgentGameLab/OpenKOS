#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logTrace, logWarn } from './_lib/hook-log.mjs'
import { cleanQuery, isSystemPrompt } from './_lib/query-clean.mjs'
import { renderRecallHit, applyFreshSlot, isFreshHit, trimToBudget, capText } from './team-prompt-recall-format.mjs'

let loadRoster = null
try { ({ loadRoster } = await import('../../kos/roster.mjs')) } catch {}

const __hookDir = dirname(fileURLToPath(import.meta.url))

const HOOK_NAME = 'team-prompt-recall'
const HOME = process.env.USERPROFILE || process.env.HOME || ''

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
function rosterFromEnv() {
  try {
    const f = process.env.KOS_ROSTER || resolve(HOME, '.claude/kos-roster.json')
    const r = JSON.parse(readFileSync(f, 'utf-8'))
    const terms = Array.isArray(r.teamTerms) ? r.teamTerms.filter(x => typeof x === 'string' && x) : []
    if (!terms.length) return null
    const out = { teamTerms: terms }
    if (r.roles && typeof r.roles.approver === 'string' && typeof r.roles.reviewer === 'string') out.roles = r.roles
    return out
  } catch { return null }
}
const rosterBase = loadRoster
  ? loadRoster()
  : { roles: { approver: 'the maintainer', reviewer: 'a reviewer' }, people: [], identityMap: {}, teamTerms: [] }
const roster = rosterBase.teamTerms.filter(Boolean).length
  ? rosterBase
  : { ...rosterBase, ...(rosterFromEnv() || {}) }
const configuredTeamTerms = roster.teamTerms.filter(Boolean)
const teamTermPattern = configuredTeamTerms.length
  ? new RegExp(configuredTeamTerms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))
  : null

const TM_SERVICE_URL = process.env.KOS_SERVICE_URL || process.env.TM_SERVICE_URL || 'http://127.0.0.1:3000'
const EMBEDDING_API_BASE = process.env.EMBEDDING_API_BASE_URL || 'https://api.openai.com/v1'
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small'
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10)

const envNum = (name, dflt) => { const v = Number.parseFloat(process.env[name] || ''); return Number.isFinite(v) && v > 0 ? v : dflt }
const BUDGET_HINT_CHARS   = envNum('KOS_BUDGET_HINT_CHARS', 420)    // 常驻 hint 层：头尾固定文案（脚手架），超帽先砍 footer
const BUDGET_RECALL_CHARS = envNum('KOS_BUDGET_RECALL_CHARS', 1200) // 触发召回层：按 rrf 降序累计，超帽整条砍尾
const BUDGET_FRESH_CHARS  = envNum('KOS_BUDGET_FRESH_CHARS', 450)   // fresh-slot 层：新沉淀保底槽单独记账，不挤占召回层
const FRESH_WINDOW_DAYS   = envNum('KOS_FRESH_WINDOW_DAYS', 14)     // 「新沉淀」时间窗
const TOP_SLOTS           = 3                                       // 总注入槽位（fresh-slot 占其一；无 fresh 候选时全归召回层）

const TRIGGER_PATTERNS = [
  /怎么(?:启|跑|运行|开|连|装|配|改|修|登|连接|push|commit|merge|review)/,
  /(?:在|放在|位于|装在)哪/,
  /如何(?:启动|运行|配置|连接|登录|push|commit|review)/,

  /铁律\s*#?\d+/,                                // "铁律 #18" "铁律18"
  ...(teamTermPattern ? [teamTermPattern] : []),             // 配置的团队成员词；空配置时跳过此信号
  /Office\s*仓?|code[\s-]?repo|town|hq[-_]?managers|hq[\s-]?send/i,
  /CGA2A|GAI|ARP|ASI|CKG|KG|knowledge[\s-]?graph/i,
  /codex|daemon|watchdog|gateway|monitor/i,
  /CODEOWNERS|cross[-_]?owner|ruleset|protect[-_]?main/i,

  /commit|PR|review|merge|push\s+main|push\s+origin/i,
  /autonomy|自主性|edge|边界|权限/i,
  /协议|playbook|ADR|decision|rule/i,

  /asi\.mjs|hq-send|town-inbox|send-as-xiaomeng|kg query|q-impact|q-feature|q-vector/i,

  /推文|文章|写稿|出稿|长文|公众号|标题|草稿|文案/,
  /spec|eval|评分卡|checklist|硬门/i,
  /引流|传播|涨粉|蹭热点|发布|投放|social|小红书|知乎/i,

  /怎么(算|做|设计|实现|定|选|评)/,
  /(拆解|逆向|原型|竞品|案例|参考|对标)/,
  /(方法论?|经验|教训|踩坑|复盘)/,
  /(日报|扫描|雷达|动态)/,
  /有没有|有什么|哪些/,
]

function shouldTrigger(prompt) {
  if (!prompt || prompt.length < 4) return false
  if (prompt.length > 1500) return false  // 长粘贴跳
  return TRIGGER_PATTERNS.some(re => re.test(prompt))
}

function dedupePath(sessionId) {
  const safe = (sessionId || 'unknown').replace(/[^\w-]/g, '_').slice(0, 36)
  return resolve(HOME, `.claude/hooks/.team-prompt-recall-injected-${safe}.json`)
}

function loadInjected(sessionId) {
  try {
    const p = dedupePath(sessionId)
    if (!existsSync(p)) return new Set()
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    return new Set(Array.isArray(data.ids) ? data.ids : [])
  } catch { return new Set() }
}

function saveInjected(sessionId, idSet) {
  try {
    const p = dedupePath(sessionId)
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const ids = Array.from(idSet).slice(-200)
    writeFileSync(p, JSON.stringify({ ids, ts: Date.now() }))
  } catch (e) {
    logWarn(HOOK_NAME, 'dedupe_write_failed', { err: e.message })
  }
}

async function embedQuery(text) {
  if (!EMBEDDING_API_KEY) return null
  const truncated = text.length > 4000 ? text.slice(0, 4000) : text
  try {
    const r = await fetch(`${EMBEDDING_API_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${EMBEDDING_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: truncated,
        dimensions: EMBEDDING_DIM,
        encoding_format: 'float',
      }),
      signal: AbortSignal.timeout(2500),
    })
    if (!r.ok) {
      logWarn(HOOK_NAME, 'embed_failed', { cause: 'http_' + r.status })
      return null
    }
    const j = await r.json()
    return j.data[0].embedding
  } catch (e) {
    logWarn(HOOK_NAME, 'embed_failed', { cause: e.name === 'TimeoutError' ? 'timeout' : 'fetch', err: String(e.message).slice(0, 120) })
    return null
  }
}

function emitBlindNotice(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `⚠️ [team memory] 召回服务不可用（${reason}），本轮无团队记忆注入——涉及团队规范/协议/成员分工的判断，先 kos-recall 手动补查再下结论。`,
    },
  }))
}

let input = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', d => input += d)
async function handleInput() {
  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch { process.exit(0) }

  const sessionId = payload.session_id || payload.sessionId || 'unknown'
  const prompt = (payload.prompt || '').trim()

  if (!shouldTrigger(prompt)) process.exit(0)
  if (isSystemPrompt(prompt)) {
    logTrace(HOOK_NAME, 'skip_system_prompt', { sessionId })
    process.exit(0)
  }

  const query = cleanQuery(prompt)
  if (query.length < 4) {
    logTrace(HOOK_NAME, 'empty_after_clean', { sessionId })
    process.exit(0)
  }

  const token = process.env.KOS_SERVICE_TOKEN
  if (!token) {
    logWarn(HOOK_NAME, 'no_token', { sessionId })
    process.exit(0)
  }

  const queryEmbedding = await embedQuery(query)

  let recallData
  try {
    const r = await fetch(`${TM_SERVICE_URL}/api/recall`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        query_embedding: queryEmbedding,
        limit: 10,  // fresh-slot 后备池 + session 去重回填需要余量（维护者机 fork 2026-07-17 loop-audit 实证值上翻正典）
        min_importance: 0,
        scope_filter: ['all-agents'],
        source: 'team-prompt-recall-hook',
        session_id: sessionId,
      }),
      signal: AbortSignal.timeout(3000),
    })
    if (!r.ok) {
      logWarn(HOOK_NAME, 'service_error', { status: r.status, sessionId })
      emitBlindNotice(`service_${r.status}`)
      process.exit(0)
    }
    recallData = await r.json()
  } catch (e) {
    logWarn(HOOK_NAME, 'fetch_failed', { err: e.message, sessionId })
    emitBlindNotice(e.name === 'TimeoutError' ? 'timeout_3s' : 'fetch_failed')
    process.exit(0)
  }

  const allHits = recallData.hits || []
  const recallLogId = recallData.recall_log_id


  const updateFinal = async (n) => {
    if (!recallLogId) return
    fetch(`${TM_SERVICE_URL}/api/update-final`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recall_log_id: recallLogId, final_count: n }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {})
  }

  if (allHits.length < 2) {
    updateFinal(0)
    logTrace(HOOK_NAME, 'low_consensus', { sessionId, count: allHits.length })
    process.exit(0)
  }

  const injected = loadInjected(sessionId)
  const fresh = allHits.filter(h => !injected.has(h.id))
  if (fresh.length === 0) {
    updateFinal(0)
    logTrace(HOOK_NAME, 'all_dup', { sessionId })
    process.exit(0)
  }

  try {
    const { areOneHopNeighbors } = await import('../../kg/lib/graph-adjacency.mjs')
    const dataRoot = process.env.KOS_DATA_ROOT || resolve(__hookDir, '..', '..', '..')
    const graphBoost = (() => { const v = Number.parseFloat(process.env.KOS_GRAPH_BOOST || ''); return Number.isFinite(v) && v > 0 ? v : 1.2 })()
    const boosted = new Set()
    for (let i = 0; i < fresh.length; i++) {
      const a = fresh[i].source_file
      if (!a) continue
      for (let j = i + 1; j < fresh.length; j++) {
        const b = fresh[j].source_file
        if (b && areOneHopNeighbors(a, b, dataRoot)) { boosted.add(fresh[i]); boosted.add(fresh[j]) }
      }
    }
    if (boosted.size) {
      for (const h of boosted) h.rrf_score = (Number(h.rrf_score) || 0) * graphBoost
      fresh.sort((x, y) => (Number(y.rrf_score) || 0) - (Number(x.rrf_score) || 0))
      logTrace(HOOK_NAME, 'kg_boost', { sessionId, boosted: boosted.size })
    }
  } catch { /* KG/模块不可用 → 保持 service 原始排序 */ }

  fresh.sort((x, y) => (Number(y.rrf_score) || 0) - (Number(x.rrf_score) || 0))

  const { top, freshPick } = applyFreshSlot(fresh, { topSlots: TOP_SLOTS, windowDays: FRESH_WINDOW_DAYS })

  const recallEntries = top.filter(h => h !== freshPick).map(h => ({ h, ...renderRecallHit(h) }))
  const { kept: keptRecall, used: recallUsed, trimmed } = trimToBudget(recallEntries, BUDGET_RECALL_CHARS, e => e.text)

  let freshEntry = null
  if (freshPick) {
    const r = renderRecallHit(freshPick)
    const text = capText(`🆕(fresh-slot·近${FRESH_WINDOW_DAYS}天新沉淀) ${r.text}`, BUDGET_FRESH_CHARS)
    freshEntry = { h: freshPick, layer: r.layer, text }
  }
  const freshUsed = freshEntry ? Array.from(freshEntry.text).length : 0

  const finalEntries = [...keptRecall, ...(freshEntry ? [freshEntry] : [])]
  updateFinal(finalEntries.length)

  let headerText = `🌐 [team memory] 你的问题跟 ${finalEntries.length} 条团队记忆重合（draft 同样召回，⚠️ 表示未实证${freshEntry ? '；🆕 为 fresh-slot 新沉淀保底槽' : ''}），优先按下方铁律/playbook/ADR 走，**避免漂移团队规范**：\n\n`
  let footerText = `\n\n（⏱ ${recallData.duration_ms}ms ${recallData.query_path} · 通过 \`team_promote_maturity\` 升 proven 需 ${roster.roles.approver} ack；如果记忆过时请 store 新版 + supersedes 旧 id）`
  if (Array.from(headerText).length + Array.from(footerText).length > BUDGET_HINT_CHARS) {
    footerText = ''
    headerText = capText(headerText, BUDGET_HINT_CHARS)
  }

  const additionalContext = headerText + finalEntries.map(e => e.text).join('\n\n') + footerText

  for (const e of finalEntries) injected.add(e.h.id)
  saveInjected(sessionId, injected)

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }))
  logTrace(HOOK_NAME, 'injected', {
    sessionId,
    ids: finalEntries.map(e => e.h.id),
    total_hits: allHits.length,
    hits: finalEntries.map(e => ({ id: e.h.id, layer: e.layer })),
    fresh_slot: freshPick ? freshPick.id : null,
    fresh_natural: freshPick ? false : top.some(h => isFreshHit(h, FRESH_WINDOW_DAYS)),
    budget: {
      hint: Array.from(headerText).length + Array.from(footerText).length,
      recall: recallUsed,
      fresh: freshUsed,
      trimmed,
    },
  })
  process.exit(0)
}

process.stdin.on('end', () => {
  handleInput().catch(() => process.exit(0))
})
