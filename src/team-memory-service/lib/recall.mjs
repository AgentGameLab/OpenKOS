// Hybrid recall：FTS5 + pgvector + RRF 融合
//
// 输入：query 文本 + filters
// 输出：top-N memories 数组 + recall_log_id（让 hook 后置 update final_hit_count）
//
// 设计：
//   1. 接受 client 端 embedding（铁律 #10：service 不调 LLM）
//      - 如 client 不传 embedding → 仅走 FTS 路径（功能降级，召回率下降）
//   2. FTS 路径：to_tsvector('simple', content) + plainto_tsquery
//   3. Vector 路径：cosine 距离 + ivfflat 索引
//   4. RRF 融合（k=60）+ maturity 排名偏移（draft +4, proven -2）
//      RRF 分数曲线极平（1/61 vs 1/75 仅差 19%），乘 0.7 等于把 draft rank-1 压到 verified rank-26 之后，池内 verified 充足时 draft 结构性不可见，违背 ADR-047-A1「低位可见」意图；改为排名偏移，效果可预测。
//   5. 仅召回 t_invalid IS NULL 的（过期的不返回）
//   6. 写 recall_log（流水打点）

import { query } from './db.mjs'

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
const MATURITY_RANK_OFFSET = { proven: -2, verified: 0, draft: 4 }

function graphBoost() {
  const value = Number.parseFloat(process.env.KOS_GRAPH_BOOST || '')
  return Number.isFinite(value) && value > 0 ? value : 1.2
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
    logCtx = {},
  } = opts

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

  // FTS 路径
  // ⚠️ tsvector 拼接顺序必须与 idx_memories_tsv 索引表达式逐字一致（content→summary→name），
  // 否则 PG 走 Seq Scan 全表实时计算（1116 行实测 1087ms，曾把 /api/recall 顶过 hook 3s 超时线）
  let ftsRows = []
  if (queryText && queryText.length >= 2) {
    const ftsParams = [...baseParams, queryText, candidatePool]
    const ftsSql = `
      SELECT id, name, summary, content, type, topic, scope, status, maturity,
             confidence, importance, memory_level, category, tags, source_file,
             created_at, t_valid,
             ts_rank(to_tsvector('simple', coalesce(content,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(name,'')),
                     plainto_tsquery('simple', $${pIdx + 1})) AS fts_score
      FROM team_memory.memories
      WHERE ${whereSql}
        AND to_tsvector('simple', coalesce(content,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(name,'')) @@ plainto_tsquery('simple', $${pIdx + 1})
      ORDER BY fts_score DESC
      LIMIT $${pIdx + 2}
    `
    const r = await query(ftsSql, ftsParams)
    ftsRows = r.rows
  }

  // Vector 路径（仅 client 传 embedding 时）
  let vecRows = []
  if (queryEmbedding && Array.isArray(queryEmbedding) && queryEmbedding.length === 1024) {
    const vecStr = '[' + queryEmbedding.join(',') + ']'
    const vecParams = [...baseParams, vecStr, candidatePool]
    const vecSql = `
      SELECT id, name, summary, content, type, topic, scope, status, maturity,
             confidence, importance, memory_level, category, tags, source_file,
             created_at, t_valid,
             content_vector <=> $${pIdx + 1}::vector AS vec_dist
      FROM team_memory.memories
      WHERE ${whereSql} AND content_vector IS NOT NULL
      ORDER BY vec_dist
      LIMIT $${pIdx + 2}
    `
    const r = await query(vecSql, vecParams)
    vecRows = r.rows
  }

  // RRF 融合（排名偏移加权）
  const scores = new Map()  // id → { row, rrf, srcs }
  ftsRows.forEach((row, idx) => {
    const off = MATURITY_RANK_OFFSET[row.maturity] ?? 4
    const effRank = idx + 1 + off
    const contribution = 1 / (RRF_K + effRank)
    scores.set(row.id, { row, rrf: contribution, srcs: ['fts'] })
  })
  vecRows.forEach((row, idx) => {
    const ex = scores.get(row.id)
    const off = MATURITY_RANK_OFFSET[row.maturity] ?? 4
    const effRank = idx + 1 + off
    const contribution = 1 / (RRF_K + effRank)
    if (ex) {
      ex.rrf += contribution
      ex.srcs.push('vec')
    } else {
      scores.set(row.id, { row, rrf: contribution, srcs: ['vec'] })
    }
  })

  // KG 邻接只放大已融合候选；模块缺失（云端部署单元）/ 图不可用 / lookup 失败均保持原始 RRF 排名。
  try {
    const adjacency = await loadAdjacency()
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
      for (const candidate of neighborCandidates) candidate.rrf *= boost
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
    created_at: m.row.created_at,
    rrf_score: m.rrf,
    recall_sources: m.srcs,
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

  return { hits, recall_log_id: recallLogId, duration_ms: durationMs, query_path: queryPath }
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
