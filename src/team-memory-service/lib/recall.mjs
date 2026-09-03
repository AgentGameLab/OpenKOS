// Hybrid recall：FTS5 + pgvector + RRF 融合
//
// 输入：query 文本 + filters
// 输出：top-N memories 数组 + recall_log_id（让 hook 后置 update final_hit_count）
//
// 设计：
//   1. 接受 client 端 embedding（铁律 #10：service 不调 LLM）
//      - 如 client 不传 embedding → 仅走 FTS 路径（功能降级，召回率下降）
//   2. FTS 路径：stored tsv_zh + to_tsquery（短查询 AND，长查询 OR）
//   3. Vector 路径：cosine 距离 + ivfflat 索引
//   4. RRF 融合（k=60）+ maturity/type/条件式 recency 排名偏移
//      RRF 分数曲线极平（1/61 vs 1/75 仅差 19%），乘 0.7 等于把 draft rank-1 压到 verified rank-26 之后，池内 verified 充足时 draft 结构性不可见，违背 ADR-047-A1「低位可见」意图；改为排名偏移，效果可预测。
//   5. 仅召回 t_invalid IS NULL 的（过期的不返回）
//   6. 写 recall_log（流水打点）

import { query } from './db.mjs'
import { isDictWord, tokenizeZh } from './zh-tokenize.mjs'

// KG 邻接模块 lazy 加载：ECS 部署单元只 rsync team-memory-service/ 目录（deploy-to-ecs.sh），
// 不含 ../kg/——顶层静态 import 会在云端直接 crash。lazy + null 缓存让模块缺失也 fail-open。
let _adjacencyMod
async function loadAdjacency() {
  if (_adjacencyMod !== undefined) return _adjacencyMod
  try {
    _adjacencyMod = await import('../../kg/lib/graph-adjacency.mjs')
  } catch {
    _adjacencyMod = null
  }
  return _adjacencyMod
}

const RRF_K = 60
const DEFAULT_MATURITY_RANK_OFFSET = Object.freeze({ proven: -1, verified: 0, draft: 1 })

function maturityRankOffsets() {
  const raw = process.env.KOS_MATURITY_OFFSETS
  if (!raw) return DEFAULT_MATURITY_RANK_OFFSET

  try {
    const parsed = JSON.parse(raw)
    const valid = parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      Object.keys(DEFAULT_MATURITY_RANK_OFFSET).every(key => Number.isFinite(parsed[key]))
    if (!valid) throw new TypeError('expected finite numeric proven, verified, and draft values')
    return Object.freeze({
      proven: parsed.proven,
      verified: parsed.verified,
      draft: parsed.draft,
    })
  } catch {
    console.warn('[recall] Ignoring invalid KOS_MATURITY_OFFSETS; using defaults.')
    return DEFAULT_MATURITY_RANK_OFFSET
  }
}

const MATURITY_RANK_OFFSET = maturityRankOffsets()
const TYPE_RANK_OFFSET = { snapshot: 6, pointer: 4 }
const FTS_VECTOR_SQL = 'tsv_zh'
const DAY_MS = 86_400_000
const FTS_OR_CANDIDATE_LIMIT = 150
const FTS_STOP_REFRESH_MS = 6 * 60 * 60 * 1000
const DEFAULT_FTS_STOP_DF = 0.20

let _ftsStopTerms = new Set()
let _ftsStopTermsRefreshedAt = 0
let _ftsStopTermsLoadPromise = null

function quoteTsTerm(term) {
  return `'${term.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

function formatTsQuery(terms, mode) {
  const operator = mode === 'and' ? ' & ' : ' | '
  return terms.map(quoteTsTerm).join(operator)
}

/**
 * 构造与 content_tokens 同源的 PostgreSQL to_tsquery 文本。
 * @param {string} queryText
 * @param {{ stopTerms?: Set<string> }} [options]
 * @returns {{ tsquery: string|null, terms: string[], mode: 'and'|'or', stopDropped: string[] }}
 */
export function buildFtsQuery(queryText, { stopTerms = _ftsStopTerms } = {}) {
  const rawTokens = tokenizeZh(queryText).split(/\s+/).filter(Boolean)
  const seen = new Set()
  const candidates = []

  for (const rawToken of rawTokens) {
    const token = /^[\x00-\x7F]+$/.test(rawToken) ? rawToken.toLowerCase() : rawToken
    if (!token || /^[\p{P}\p{S}]+$/u.test(token) || seen.has(token)) continue
    seen.add(token)
    candidates.push({ token, dictionary: isDictWord(rawToken), index: candidates.length })
  }

  const usable = candidates.length === 1
    ? candidates
    : candidates.filter(({ token }) => [...token].length > 1)
  const mode = usable.length <= 6 ? 'and' : 'or'
  const removableStops = mode === 'or'
    ? usable.filter(({ token, dictionary }) => !dictionary && stopTerms.has(token))
    : []
  const maxStopDrops = usable.length >= 3 ? usable.length - 3 : Math.max(usable.length - 1, 0)
  const droppedCandidates = new Set(removableStops.slice(0, maxStopDrops))
  const withoutStops = usable.filter(candidate => !droppedCandidates.has(candidate))
  const keptCandidates = withoutStops.length > 0 ? withoutStops : usable
  const stopDropped = withoutStops.length > 0
    ? usable.filter(candidate => droppedCandidates.has(candidate)).map(({ token }) => token)
    : []
  const terms = keptCandidates
    .toSorted((left, right) => Number(right.dictionary) - Number(left.dictionary) || left.index - right.index)
    .slice(0, 24)
    .map(({ token }) => token)

  return {
    tsquery: terms.length > 0 ? formatTsQuery(terms, mode) : null,
    terms,
    mode,
    stopDropped,
  }
}

export function getFtsStopTermsForTest() {
  return new Set(_ftsStopTerms)
}

export function setFtsStopTermsForTest(stopTerms) {
  _ftsStopTerms = new Set(stopTerms)
  _ftsStopTermsRefreshedAt = Date.now()
}

export function ftsStopDf() {
  const value = Number(process.env.KOS_FTS_STOP_DF)
  return Number.isFinite(value) && value > 0 && value < 1 ? value : DEFAULT_FTS_STOP_DF
}

function refreshFtsStopTermsInBackground() {
  const now = Date.now()
  if (_ftsStopTermsLoadPromise || now - _ftsStopTermsRefreshedAt < FTS_STOP_REFRESH_MS) return

  // Mark the attempt immediately so a failing DB does not create a query storm.
  _ftsStopTermsRefreshedAt = now
  _ftsStopTermsLoadPromise = Promise.resolve().then(() => query(`
    WITH stats AS (
      SELECT word, ndoc
      FROM ts_stat($$SELECT tsv_zh FROM team_memory.memories WHERE t_invalid IS NULL AND (status IS NULL OR status <> 'superseded')$$)
    ), visible AS (
      SELECT count(*)::bigint AS row_count
      FROM team_memory.memories
      WHERE t_invalid IS NULL AND ${VISIBLE_STATUS_SQL}
    )
    SELECT stats.word, stats.ndoc, visible.row_count
    FROM visible
    LEFT JOIN stats ON true
  `)).then(({ rows }) => {
    const rowCount = Number(rows[0]?.row_count ?? 0)
    _ftsStopTerms = new Set(rows
      .filter(row => row.word && Number(row.ndoc) > rowCount * ftsStopDf() && !isDictWord(row.word))
      .map(row => row.word))
  }).catch(error => {
    console.error('[recall] FTS stop-term refresh failed:', error.message)
  }).finally(() => {
    _ftsStopTermsLoadPromise = null
  })
}

/**
 * OR 召回候选按命中查询词覆盖数优先，再按 PostgreSQL FTS 分数排序。
 * 返回克隆行，避免把仅用于重排的 content_tokens 泄漏到响应链路。
 */
export function coverageRerank(rows, terms, keep) {
  const distinctTerms = new Set(terms)
  return rows.map((row, index) => {
    const tokenSet = new Set(String(row.content_tokens ?? '').split(/\s+/).filter(Boolean))
    let ftsCoverage = 0
    for (const term of distinctTerms) {
      if (tokenSet.has(term)) ftsCoverage += 1
    }
    const { content_tokens: _contentTokens, ...rest } = row
    return { ...rest, fts_coverage: ftsCoverage, _coverage_index: index }
  }).sort((left, right) => (
    right.fts_coverage - left.fts_coverage ||
    Number(right.fts_score ?? 0) - Number(left.fts_score ?? 0) ||
    left._coverage_index - right._coverage_index
  )).slice(0, keep).map(({ _coverage_index: _index, ...row }) => row)
}

function timestampMs(value) {
  if (value == null) return null
  const parsed = value instanceof Date
    ? value.getTime()
    : (typeof value === 'number' ? value : Date.parse(value))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * layered profile 的排名偏移；nowMs 显式传入，保证离线测试确定性。
 * @param {Object} row
 * @param {number} nowMs
 * @returns {{ maturity: number, type: number, recency: number, total: number }}
 */
export function rankOffsets(row, nowMs) {
  // A fresh draft (<=14d) nets +1 maturity + (-2) recency = -1, slightly ahead of verified.
  const maturity = MATURITY_RANK_OFFSET[row?.maturity] ?? MATURITY_RANK_OFFSET.draft
  const type = TYPE_RANK_OFFSET[row?.type] ?? 0
  let recency = 0

  if (row?.maturity == null || row.maturity === 'draft') {
    const timestamps = [row?.t_valid, row?.created_at]
      .map(timestampMs)
      .filter(value => value != null)
    const latestTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : null
    const ageMs = latestTimestamp == null ? Number.POSITIVE_INFINITY : nowMs - latestTimestamp
    if (ageMs <= 14 * DAY_MS) recency = -2
    else if (ageMs <= 60 * DAY_MS) recency = -1
  }

  return { maturity, type, recency, total: maturity + type + recency }
}

function graphBoost() {
  const value = Number.parseFloat(process.env.KOS_GRAPH_BOOST || '')
  return Number.isFinite(value) && value > 0 ? value : 1.2
}

function ftsOrWeight() {
  const value = Number.parseFloat(process.env.KOS_FTS_OR_WEIGHT || '')
  return Number.isFinite(value) && value >= 0 ? value : 0.5
}

/**
 * Hybrid recall
 *
 * @param {Object} opts
 * @param {string} opts.queryText 查询词
 * @param {number[]} [opts.queryEmbedding] 客户端预计算的 embedding（1024d）。不传则只走 FTS
 * @param {number} [opts.limit=8] 最终返回条数
 * @param {number} [opts.minImportance=0] 最低重要性
 * @param {string[]} [opts.maturityFilter=null] 默认不过滤（ADR-047-A1：draft 可召回、靠排名偏移保低位）；显式传数组才硬过滤.
 * @param {string[]} [opts.typeFilter] 限定 type
 * @param {string[]} opts.scopeFilter 限定 scope
 * @param {'layered'|'flat'} [opts.rankProfile='layered'] eval 消融臂（eval/README.md 纪律 3）：
 *   flat 关掉全部分层结构（排名偏移 + KG 邻接 boost），只跑底层 FTS+vec 纯 RRF，
 *   返回值回显 rank_profile 供 eval fail-closed 校验。生产调用不传即 layered，行为不变
 * @param {boolean} [opts.explain=false] 返回逐条 RRF 排名构成
 * @param {Object} [opts.logCtx] { source, agentId, agentName, sessionId } 打点用
 * @returns {Promise<{ hits: Array, recall_log_id: number }>}
 */
// 可见性口径单一源（2026-08-03）：任何"这条记忆算不算活的"判断都必须复用这个谓词。
// 只过 t_invalid、不过 status 会把已退役行当活行——报表/对账工具历来在这里各写各的，
// 实测 133 行受影响，且同一个坑 07-30 修过 dedup 脚本后又在 pg-sync/health-eval/stats 复发。
export const VISIBLE_STATUS_SQL = `(status IS NULL OR status <> 'superseded')`

export async function hybridRecall(opts = {}) {
  const {
    queryText,
    queryEmbedding,
    limit = 8,
    minImportance = 0,
    maturityFilter = null,
    typeFilter,
    scopeFilter,
    rankProfile = 'layered',
    logCtx = {},
  } = opts
  const flatArm = rankProfile === 'flat'

  if (!Array.isArray(scopeFilter) || scopeFilter.length === 0) {
    throw new Error('scopeFilter must be a non-empty array of authorized scopes')
  }

  const startTs = Date.now()
  const candidatePool = Math.max(limit * 3, 30)

  // 构造 WHERE 公共条件
  // 2026-05-14 ADR-032 P2: 默认 hide expired (expires_at < now() OR expired_at NOT NULL)
  // caller 显式传 includeExpired=true 才返回过期条目（追溯用）
  const whereParts = ['t_invalid IS NULL']
  if (!opts.includeExpired) {
    whereParts.push('(expires_at IS NULL OR expires_at > now())')
    whereParts.push('expired_at IS NULL')
  }
  // 2026-06-02 PR #162 research-lifecycle §4: 默认 hide superseded（避免 stale 召回 + 新旧成对污染）
  // caller 显式传 includeSuperseded=true 才返回被取代的历史快照（追溯/对比用）
  // 对齐 kos-recall.mjs --include-superseded（commit 162 ship），让 file recall + service recall 行为一致
  if (!opts.includeSuperseded) {
    whereParts.push(VISIBLE_STATUS_SQL)
  }
  const baseParams = []
  let pIdx = 0
  if (maturityFilter && maturityFilter.length) {
    whereParts.push(`maturity = ANY($${++pIdx})`)
    baseParams.push(maturityFilter)
  }
  if (typeFilter && typeFilter.length) {
    whereParts.push(`type = ANY($${++pIdx})`)
    baseParams.push(typeFilter)
  }
  whereParts.push(`scope = ANY($${++pIdx})`)
  baseParams.push(scopeFilter)
  if (minImportance > 0) {
    whereParts.push(`importance >= $${++pIdx}`)
    baseParams.push(minImportance)
  }
  const whereSql = whereParts.join(' AND ')

  // FTS 路径。过滤与排名都直接读取 stored tsvector，避免逐行重算 token vector。
  const stopTerms = _ftsStopTerms
  const stopDf = ftsStopDf()
  const ftsPlan = buildFtsQuery(queryText, { stopTerms })
  if (ftsPlan.tsquery) refreshFtsStopTermsInBackground()
  const ftsMode = ftsPlan.tsquery ? ftsPlan.mode : null
  let ftsFormUsed = null
  let ftsQueryMs = 0
  let ftsCandidates = 0
  let ftsRows = []
  if (ftsPlan.tsquery) {
    const runFtsQuery = async (tsquery, form) => {
      const candidateLimit = form === 'or' ? FTS_OR_CANDIDATE_LIMIT : candidatePool
      const ftsParams = [...baseParams, tsquery, candidateLimit]
      const contentTokensSelect = form === 'or' ? ', content_tokens' : ''
      const ftsSql = `
      SELECT id, name, coalesce(summary, description) AS summary, content, type, topic, scope, status, maturity,
             confidence, importance, memory_level, category, tags, source_file,
             metadata->>'kos_slug' AS kos_slug,
             created_at, t_valid${contentTokensSelect},
             ts_rank_cd(${FTS_VECTOR_SQL}, to_tsquery('simple', $${pIdx + 1}), 1) AS fts_score
      FROM team_memory.memories
      WHERE ${whereSql}
        AND ${FTS_VECTOR_SQL} @@ to_tsquery('simple', $${pIdx + 1})
      ORDER BY fts_score DESC
      LIMIT $${pIdx + 2}
    `
      return (await query(ftsSql, ftsParams)).rows
    }

    const ftsStartTs = Date.now()
    ftsRows = await runFtsQuery(ftsPlan.tsquery, ftsPlan.mode)
    if (ftsPlan.mode === 'and' && ftsRows.length < 3) {
      ftsRows = await runFtsQuery(formatTsQuery(ftsPlan.terms, 'or'), 'or')
      ftsCandidates = ftsRows.length
      ftsRows = coverageRerank(ftsRows, ftsPlan.terms, candidatePool)
      ftsFormUsed = ftsRows.length > 0 ? 'or' : null
    } else {
      ftsCandidates = ftsRows.length
      ftsFormUsed = ftsRows.length > 0 ? ftsPlan.mode : null
      if (ftsPlan.mode === 'or') {
        ftsRows = coverageRerank(ftsRows, ftsPlan.terms, candidatePool)
      } else {
        const coverage = new Set(ftsPlan.terms).size
        ftsRows = ftsRows.map(row => ({ ...row, fts_coverage: coverage }))
      }
    }
    ftsQueryMs = Date.now() - ftsStartTs
  }

  // Vector 路径（仅 client 传 embedding 时）
  let vecRows = []
  let vecQueryMs = 0
  if (queryEmbedding && Array.isArray(queryEmbedding) && queryEmbedding.length === 1024) {
    const vecStartTs = Date.now()
    const vecStr = '[' + queryEmbedding.join(',') + ']'
    const vecParams = [...baseParams, vecStr, candidatePool]
    const vecSql = `
      SELECT id, name, coalesce(summary, description) AS summary, content, type, topic, scope, status, maturity,
             confidence, importance, memory_level, category, tags, source_file,
             metadata->>'kos_slug' AS kos_slug,
             created_at, t_valid,
             content_vector <=> $${pIdx + 1}::vector AS vec_dist
      FROM team_memory.memories
      WHERE ${whereSql} AND content_vector IS NOT NULL
      ORDER BY vec_dist
      LIMIT $${pIdx + 2}
    `
    const r = await query(vecSql, vecParams)
    vecRows = r.rows
    vecQueryMs = Date.now() - vecStartTs
  }

  // RRF 融合（排名偏移加权）
  const scores = new Map()  // id → { row, rrf, srcs }
  const appliedFtsWeight = flatArm ? 1 : (ftsFormUsed === 'or' ? ftsOrWeight() : 1)
  ftsRows.forEach((row, idx) => {
    const offsets = flatArm
      ? { maturity: 0, type: 0, recency: 0, total: 0 }
      : rankOffsets(row, startTs)
    const effRank = Math.max(1, idx + 1 + offsets.total)
    const contribution = appliedFtsWeight / (RRF_K + effRank)
    scores.set(row.id, {
      row, rrf: contribution, srcs: ['fts'], ftsRank: idx + 1, vecRank: null, offsets, kgBoost: 1,
      ftsWeight: appliedFtsWeight, ftsCoverage: row.fts_coverage,
    })
  })
  vecRows.forEach((row, idx) => {
    const ex = scores.get(row.id)
    const offsets = flatArm
      ? { maturity: 0, type: 0, recency: 0, total: 0 }
      : rankOffsets(row, startTs)
    const effRank = Math.max(1, idx + 1 + offsets.total)
    const contribution = 1 / (RRF_K + effRank)
    if (ex) {
      ex.rrf += contribution
      ex.srcs.push('vec')
      ex.vecRank = idx + 1
    } else {
      scores.set(row.id, {
        row, rrf: contribution, srcs: ['vec'], ftsRank: null, vecRank: idx + 1, offsets, kgBoost: 1,
        ftsWeight: appliedFtsWeight, ftsCoverage: null,
      })
    }
  })

  // KG 邻接只放大已融合候选；模块缺失（云端部署单元）/ 图不可用 / lookup 失败均保持原始 RRF 排名。
  // flat 消融臂整段跳过（分层结构之一）。
  try {
    const adjacency = flatArm ? null : await loadAdjacency()
    if (adjacency) {
      const candidates = [...scores.values()]
      const neighborCandidates = new Set()
      for (let i = 0; i < candidates.length; i++) {
        const firstPath = candidates[i].row.source_file
        if (!firstPath) continue
        for (let j = i + 1; j < candidates.length; j++) {
          const secondPath = candidates[j].row.source_file
          if (secondPath && adjacency.areOneHopNeighbors(firstPath, secondPath)) {
            neighborCandidates.add(candidates[i])
            neighborCandidates.add(candidates[j])
          }
        }
      }
      const boost = graphBoost()
      for (const candidate of neighborCandidates) {
        candidate.rrf *= boost
        candidate.kgBoost = boost
      }
    }
  } catch { /* KG fail-open：不影响召回 */ }

  // 排序 + 切 top-N
  const merged = Array.from(scores.values())
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)

  const hits = merged.map(m => ({
    id: m.row.id,
    name: m.row.name,
    summary: m.row.summary,
    content: m.row.content,
    type: m.row.type,
    topic: m.row.topic,
    scope: m.row.scope,
    status: m.row.status,
    maturity: m.row.maturity,
    confidence: m.row.confidence,
    importance: m.row.importance,
    memory_level: m.row.memory_level,
    category: m.row.category,
    tags: m.row.tags,
    source_file: m.row.source_file,
    // 2026-08-22：canonical(.md) ↔ PG 对账要能把一行映射回具体文件。此前返回体既无 slug 也无
    // 可靠身份，只能按 name 猜——而同名多行在库里是常态（实测同一张卡存在 2-3 行、id 各异），
    // 按 name 匹配必然张冠李戴。source_file 才是 store.mjs cardKey 认的卡级身份，
    // kos_slug 作为人可读的第二判据一并回传。
    kos_slug: m.row.kos_slug ?? null,
    created_at: m.row.created_at,
    rrf_score: m.rrf,
    recall_sources: m.srcs,
    ...(opts.explain === true ? {
      explain: {
        fts_rank: m.ftsRank,
        vec_rank: m.vecRank,
        fts_weight: m.ftsWeight,
        fts_coverage: m.ftsCoverage,
        offsets: m.offsets,
        kg_boost: m.kgBoost,
        rrf: m.rrf,
      },
    } : {}),
  }))

  // 写 recall_log（流水打点）
  const queryPath = vecRows.length > 0 && ftsRows.length > 0 ? 'hybrid'
    : (vecRows.length > 0 ? 'vec' : (ftsRows.length > 0 ? 'fts' : 'empty'))
  const durationMs = Date.now() - startTs

  let recallLogId = null
  try {
    const r = await query(
      `INSERT INTO team_memory.recall_log
        (source, agent_id, agent_name, session_id, query, hit_ids, hit_count, duration_ms,
         filter_level, filter_min_importance, query_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        logCtx.source || 'unknown',
        logCtx.agentId || null,
        logCtx.agentName || null,
        logCtx.sessionId || null,
        (queryText || '').slice(0, 200),
        hits.map(h => h.id),
        hits.length,
        durationMs,
        maturityFilter ? maturityFilter.join(',') : null,
        minImportance || null,
        queryPath,
      ]
    )
    recallLogId = Number(r.rows[0].id)

    // 更新 access_count + last_accessed
    if (hits.length > 0) {
      await query(
        `UPDATE team_memory.memories SET access_count = access_count + 1, last_accessed = now()
         WHERE id = ANY($1)`,
        [hits.map(h => h.id)]
      )
    }
  } catch (e) {
    console.error('[recall] log insert failed:', e.message)
  }

  return {
    hits,
    recall_log_id: recallLogId,
    duration_ms: durationMs,
    query_path: queryPath,
    rank_profile: rankProfile,
    fts_mode: ftsMode,
    fts_terms: ftsPlan.terms,
    fts_stop_dropped: ftsPlan.stopDropped,
    fts_stop_df: stopDf,
    fts_stop_terms_count: stopTerms.size,
    fts_form_used: ftsFormUsed,
    fts_candidates: ftsCandidates,
    fts_query_ms: ftsQueryMs,
    vec_query_ms: vecQueryMs,
  }
}

/**
 * 身份清单枚举（对账专用，非召回）
 *
 * 为什么不复用 /api/recall：recall 是「按语义找 top-k」，结构上枚举不全，也不该为了对账
 * 去骗它（构造空 query 拉全库会写脏 recall_log、刷 access_count、把审计读混进使用信号）。
 * canonical(.md) ↔ PG 的 slug 级一致性需要的是**全量身份清单**，只要身份字段、不要正文。
 *
 * 刻意不返回 content/summary/向量：对账不需要正文，返回正文会让这个端点变成整库导出口。
 * 可见性口径、scope 授权与 recall 完全一致（VISIBLE_STATUS_SQL 单一源），不新增可达面。
 * 不写 recall_log、不动 access_count —— 对账是旁路观测，不能污染召回统计。
 *
 * @param {Object} opts
 * @param {string[]} opts.scopeFilter 已授权 scope（authorizeRequestedScopes 的返回值）
 * @param {number} [opts.after=0] id 游标（exclusive，按 id 升序翻页）
 * @param {number} [opts.limit=500] 单页条数，硬上限 1000
 * @param {boolean} [opts.includeExpired=false]
 * @param {boolean} [opts.includeSuperseded=false]
 * @returns {Promise<{ rows: Array, next_after: number|null, count: number }>}
 */
export async function listMemories(opts = {}) {
  const {
    scopeFilter,
    after = 0,
    includeExpired = false,
    includeSuperseded = false,
  } = opts
  const limit = Math.min(Math.max(Number.parseInt(opts.limit ?? 500, 10) || 500, 1), 1000)
  const cursor = Math.max(Number.parseInt(after, 10) || 0, 0)

  if (!Array.isArray(scopeFilter) || scopeFilter.length === 0) {
    throw new Error('scopeFilter must be a non-empty array of authorized scopes')
  }

  const whereParts = ['t_invalid IS NULL', 'id > $1', 'scope = ANY($2)']
  if (!includeExpired) {
    whereParts.push('(expires_at IS NULL OR expires_at > now())')
    whereParts.push('expired_at IS NULL')
  }
  if (!includeSuperseded) whereParts.push(VISIBLE_STATUS_SQL)

  const r = await query(
    `SELECT id, name, type, scope, status, maturity, source_file,
            metadata->>'kos_slug' AS kos_slug,
            created_at, updated_at
     FROM team_memory.memories
     WHERE ${whereParts.join(' AND ')}
     ORDER BY id
     LIMIT $3`,
    [cursor, scopeFilter, limit]
  )

  // next_after 只在满页时给：不满页说明已到尾，返回 null 让调用方停止翻页
  // （给个非 null 值会让对账脚本多打一轮空请求，且分不清「到尾」和「被截断」）。
  const nextAfter = r.rows.length === limit ? Number(r.rows[r.rows.length - 1].id) : null
  return { rows: r.rows, next_after: nextAfter, count: r.rows.length }
}

/**
 * 后置更新 final_hit_count（hook 后置过滤完调用）
 */
export async function updateFinalCount(recallLogId, finalCount) {
  if (!recallLogId || finalCount == null) return
  try {
    await query(
      `UPDATE team_memory.recall_log SET final_hit_count = $1 WHERE id = $2`,
      [finalCount, recallLogId]
    )
  } catch (e) {
    console.error('[recall] update final_count failed:', e.message)
  }
}
