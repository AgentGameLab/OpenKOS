
import { query } from './db.mjs'
import { createHash } from 'node:crypto'
import { AuthorizationError } from './authz.mjs'
import { buildEmbedText, buildTokenText } from './text-prep.mjs'
import {
  loadCanonicalCard,
  planCanonicalMaturity,
  writeCanonicalCard,
  emitGitMirrorEvent,
} from './canonical-card.mjs'

export async function assertSupersedesWithinWriteScopes(supersedes, authorizedWriteScopes) {
  const ids = (Array.isArray(supersedes) ? supersedes : [])
    .map(Number)
    .filter(n => Number.isFinite(n))
  if (ids.length === 0) return
  if (ids.length > 50) throw new AuthorizationError('supersedes must contain at most 50 ids')
  const scopes = Array.isArray(authorizedWriteScopes) ? authorizedWriteScopes : []
  if (scopes.length === 0) throw new AuthorizationError('无写入 scope，不能 supersede')
  const r = await query(
    'SELECT id, scope FROM team_memory.memories WHERE id = ANY($1)',
    [ids]
  )
  const outside = r.rows.filter(row => !scopes.includes(row.scope))
  if (outside.length > 0) {
    throw new AuthorizationError(
      `无权 supersede 以下 scope 的记忆：${[...new Set(outside.map(r2 => r2.scope))].join(', ')}`
    )
  }
}

const ALLOWED_TYPES = ['snapshot', 'pointer', 'rule', 'playbook', 'decision', 'feedback', 'user', 'general', 'incident', 'reference', 'correction']
const ALLOWED_STATUS = ['active', 'superseded', 'planned', 'draft', 'archived']
const ALLOWED_LEVELS = ['concrete_trace', 'semi_abstract', 'meta_knowledge']

export function cardKey(row) {
  return String(row.source_file || '').trim() || `name:${String(row.name || '').trim()}`
}

export const CARD_KEY_SQL = `CASE
  WHEN btrim(COALESCE(source_file, '')) <> '' THEN btrim(source_file)
  ELSE 'name:' || btrim(COALESCE(name, ''))
END`

export async function embedContent(text) {
  if (!text) return null
  const key = process.env.EMBEDDING_API_KEY
  if (!key) {
    console.error('[store] ⚠️⚠️ EMBEDDING_API_KEY MISSING — 写 NULL 向量，recall 将降级。这是 prod-env-被剥 复发根因，立即检查 ECS PM2 env！ metric:embed_key_missing=1')
    return null
  }
  const base = process.env.EMBEDDING_API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-v3'
  const dim = parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10)
  const RETRYABLE = new Set([429, 500, 502, 503, 504])
  const MAX_ATTEMPTS = 3
  let lastStatus = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text, dimensions: dim, encoding_format: 'float' }),
      })
      if (!r.ok) {
        lastStatus = r.status
        if (RETRYABLE.has(r.status) && attempt < MAX_ATTEMPTS) {
          const backoffMs = 300 * 2 ** (attempt - 1) // 300ms, 600ms
          console.error(`[store] embed failed HTTP ${r.status}, retry ${attempt}/${MAX_ATTEMPTS} in ${backoffMs}ms`)
          await new Promise(res => setTimeout(res, backoffMs))
          continue
        }
        console.error('[store] embed failed HTTP', r.status, attempt >= MAX_ATTEMPTS ? '(exhausted retries — writing NULL vector, needs backfill)' : '')
        return null
      }
      const j = await r.json()
      const v = j.data?.[0]?.embedding
      return (Array.isArray(v) && v.length === dim) ? v : null
    } catch (e) {
      lastStatus = 'network_error'
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = 300 * 2 ** (attempt - 1)
        console.error(`[store] embed error: ${e.message}, retry ${attempt}/${MAX_ATTEMPTS} in ${backoffMs}ms`)
        await new Promise(res => setTimeout(res, backoffMs))
        continue
      }
      console.error('[store] embed error (exhausted retries):', e.message)
      return null
    }
  }
  return null
}

export async function storeMemory(mem) {
  if (!mem.content || mem.content.length === 0) {
    throw new Error('content is required')
  }

  const rawSupersedes = Array.isArray(mem.supersedes) ? mem.supersedes : []
  if (rawSupersedes.length > 50) {
    throw new Error('supersedes must contain at most 50 ids')
  }
  if (
    rawSupersedes.length > 0 &&
    (!Array.isArray(mem.authorizedWriteScopes) ||
      mem.authorizedWriteScopes.length === 0 ||
      !mem.authorizedWriteScopes.every(scope => typeof scope === 'string' && scope.length > 0))
  ) {
    throw new Error('authorizedWriteScopes must be a non-empty array of strings when supersedes is provided')
  }
  const authorizedWriteScopes = mem.authorizedWriteScopes || []
  const supersedes = rawSupersedes.map(Number).filter(n => Number.isFinite(n))

  const content = mem.content
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 32)

  const existing = await query('SELECT id FROM team_memory.memories WHERE hash = $1', [hash])
  if (existing.rows.length) {
    const keptId = Number(existing.rows[0].id)
    const dupSupersedes = supersedes
      .filter(n => Number.isFinite(n) && n !== keptId)
    let superseded = 0
    if (dupSupersedes.length) {
      const pool = (await import('./db.mjs')).getPool()
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        const targets = await c.query(
          'SELECT id, scope FROM team_memory.memories WHERE id = ANY($1) FOR UPDATE',
          [dupSupersedes]
        )
        if (targets.rows.some(row => !authorizedWriteScopes.includes(row.scope))) {
          throw new Error('supersedes contains a memory outside authorized write scopes')
        }
        const res = await c.query(
          `UPDATE team_memory.memories
              SET t_invalid = now(), status = 'superseded'
            WHERE id = ANY($1) AND scope = ANY($2) AND t_invalid IS NULL`,
          [dupSupersedes, authorizedWriteScopes]
        )
        superseded = res.rowCount ?? 0
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        c.release()
      }
    }
    return { id: keptId, hash, status: 'duplicate', superseded }
  }

  const type = ALLOWED_TYPES.includes(mem.type) ? mem.type : 'rule'
  const memory_level = ALLOWED_LEVELS.includes(mem.memory_level) ? mem.memory_level : 'meta_knowledge'
  const importance = Math.max(1, Math.min(10, parseInt(mem.importance, 10) || 5))
  const scope = mem.scope || 'all-agents'
  const sourceFile = mem.source_file || (mem.metadata && mem.metadata.kos_file) || null
  const identity = cardKey({ source_file: sourceFile, name: mem.name })
  const hasCardIdentity = identity !== 'name:'

  const requires_review = type === 'decision'

  const textFields = {
    name: mem.name,
    description: mem.description,
    summary: mem.summary,
    content,
  }
  const contentTokens = buildTokenText(textFields)

  let contentVector = null
  if (Array.isArray(mem.content_vector) && mem.content_vector.length === 1024) {
    contentVector = '[' + mem.content_vector.join(',') + ']'
  } else {
    const vec = await embedContent(buildEmbedText(textFields))
    if (vec) contentVector = '[' + vec.join(',') + ']'
  }

  const client = (await import('./db.mjs')).getPool().connect ? null : null  // 用 query helper 的话 transaction 麻烦
  const pool = (await import('./db.mjs')).getPool()
  const c = await pool.connect()

  let result
  try {
    await c.query('BEGIN')

    if (hasCardIdentity) {
      await c.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [scope, identity]
      )
    }

    const racedExisting = hasCardIdentity
      ? await c.query('SELECT id FROM team_memory.memories WHERE hash = $1', [hash])
      : { rows: [] }
    if (racedExisting.rows.length) {
      const keptId = Number(racedExisting.rows[0].id)
      const dupSupersedes = supersedes.filter(n => n !== keptId)
      let superseded = 0
      if (dupSupersedes.length) {
        const targets = await c.query(
          'SELECT id, scope FROM team_memory.memories WHERE id = ANY($1) FOR UPDATE',
          [dupSupersedes]
        )
        if (targets.rows.some(row => !authorizedWriteScopes.includes(row.scope))) {
          throw new Error('supersedes contains a memory outside authorized write scopes')
        }
        const res = await c.query(
          `UPDATE team_memory.memories
              SET t_invalid = now(), status = 'superseded'
            WHERE id = ANY($1) AND scope = ANY($2) AND t_invalid IS NULL`,
          [dupSupersedes, authorizedWriteScopes]
        )
        superseded = res.rowCount ?? 0
      }
      await c.query('COMMIT')
      result = { id: keptId, hash, status: 'duplicate', superseded }
      return result
    }

    const ins = await c.query(
      `INSERT INTO team_memory.memories (
        hash, name, description, content, content_tokens, summary,
        type, topic, scope, status,
        maturity, requires_review,
        confidence, importance, memory_level, category,
        author_agent_id, supersedes,
        tags, metadata, content_vector,
        last_corrected_at,
        expires_at,
        source_file
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, 'active',
        'draft', $10,
        0.4, $11, $12, $13,
        $14, $15,
        $16,
        COALESCE($17::jsonb, '{}'::jsonb)
          || CASE WHEN $18::vector IS NOT NULL
               THEN '{"embed_input_v":"2"}'::jsonb
               ELSE '{}'::jsonb
             END,
        $18::vector,
        $19,
        $20::timestamptz,
        $21
      )
      RETURNING id`,
      [
        hash,
        mem.name || null,
        mem.description || null,
        content,
        contentTokens,
        mem.summary || null,
        type,
        mem.topic || null,
        scope,
        requires_review,
        importance,
        memory_level,
        mem.category || type,
        mem.author_agent_id || null,
        supersedes,
        Array.isArray(mem.tags) ? mem.tags : [],
        JSON.stringify(mem.metadata || {}),
        contentVector,
        mem.last_corrected_at || null,
        mem.expires_at || null,  // 2026-05-14 ADR-032 P1 lifecycle
        sourceFile,
      ]
    )
    const newId = Number(ins.rows[0].id)

    const explicitSupersedes = supersedes.filter(id => id !== newId)
    if (explicitSupersedes.length > 0) {
      const targets = await c.query(
        'SELECT id, scope FROM team_memory.memories WHERE id = ANY($1) FOR UPDATE',
        [explicitSupersedes]
      )
      if (targets.rows.some(row => !authorizedWriteScopes.includes(row.scope))) {
        throw new Error('supersedes contains a memory outside authorized write scopes')
      }
      await c.query(
        `UPDATE team_memory.memories
         SET t_invalid = now(), status = 'superseded'
         WHERE id = ANY($1) AND scope = ANY($2) AND t_invalid IS NULL`,
        [explicitSupersedes, authorizedWriteScopes]
      )
    }

    if (hasCardIdentity) {
      await c.query(
        `UPDATE team_memory.memories
            SET t_invalid = now(), status = 'superseded'
          WHERE scope = $1
            AND id <> $2
            AND t_invalid IS NULL
            AND (status IS NULL OR status <> 'superseded')
            AND (${CARD_KEY_SQL}) = $3`,
        [scope, newId, identity]
      )

      const active = await c.query(
        `SELECT count(*)::int AS active_count
           FROM team_memory.memories
          WHERE scope = $1
            AND t_invalid IS NULL
            AND (status IS NULL OR status <> 'superseded')
            AND (${CARD_KEY_SQL}) = $2`,
        [scope, identity]
      )
      if (Number(active.rows[0]?.active_count) !== 1) {
        throw new Error(`card upsert invariant failed for scope=${scope} card=${identity}: expected exactly one active row`)
      }
    }

    await c.query('COMMIT')
    result = { id: newId, hash, status: 'inserted' }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }

  return result
}

const MATURITY_ORDER = { draft: 0, verified: 1, proven: 2 }
const rankOfMaturity = (m) => (Object.hasOwn(MATURITY_ORDER, m) ? MATURITY_ORDER[m] : -1)

const defaultCanonicalOps = {
  loadCanonicalCard,
  planCanonicalMaturity,
  writeCanonicalCard,
  emitGitMirrorEvent,
}

async function changeMaturity({
  memoryId,
  toMaturity,
  direction,
  approvedBy,
  approvedByName,
  reason,
  authorizedWriteScopes,
  allowFrozen = false,
  canonicalOps = defaultCanonicalOps,
}) {
  if (
    !Array.isArray(authorizedWriteScopes) ||
    authorizedWriteScopes.length === 0 ||
    !authorizedWriteScopes.every(scope => typeof scope === 'string' && scope.length > 0)
  ) {
    throw new Error('authorizedWriteScopes must be a non-empty array of strings')
  }

  const pool = (await import('./db.mjs')).getPool()
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const cur = await c.query(
      'SELECT maturity, scope, source_file FROM team_memory.memories WHERE id = $1 FOR UPDATE',
      [memoryId]
    )
    if (!cur.rows.length) throw new Error('memory not found')
    const scope = cur.rows[0].scope
    if (!authorizedWriteScopes.includes(scope)) {
      throw new Error('memory scope is outside authorized write scopes')
    }
    const fromMaturity = cur.rows[0].maturity
    const sourceFile = String(cur.rows[0].source_file || '').trim()

    if (direction === 'demote' && !['verified', 'proven'].includes(fromMaturity)) {
      throw new Error(`cannot demote ${fromMaturity} → ${toMaturity}`)
    }

    const siblings = sourceFile
      ? (await c.query(
        `SELECT id, maturity FROM team_memory.memories
          WHERE scope = $1
            AND id <> $2
            AND t_invalid IS NULL
            AND (status IS NULL OR status <> 'superseded')
            AND btrim(COALESCE(source_file, '')) = $3
          ORDER BY id
          FOR UPDATE`,
        [scope, memoryId, sourceFile]
      )).rows
      : []

    const card = canonicalOps.loadCanonicalCard(sourceFile)
    if (card && !card.found) {
      throw new Error(
        `canonical 文件找不到：${card.rel}（PG 行 id=${memoryId} 指向它）。` +
        '卡可能已改名/删除，或服务端仓还没拉到这张新卡 —— 先确认 .md 已 push 到 origin/main 再重试；' +
        '若这张卡确实不该再存在，走 supersede 退役该行，别升它的格。'
      )
    }
    if (card && card.maturity && !Object.hasOwn(MATURITY_ORDER, card.maturity)) {
      throw new Error(
        `canonical ${card.rel} 的 maturity=${JSON.stringify(card.maturity)} 不是 draft|verified|proven，` +
        '无法判断当前档位。先把 frontmatter 修成正统三档再升格。'
      )
    }

    const fileMaturity = card ? card.maturity : null
    const effectiveFrom = rankOfMaturity(fileMaturity) > rankOfMaturity(fromMaturity)
      ? fileMaturity
      : fromMaturity
    if (direction === 'promote' && rankOfMaturity(toMaturity) < rankOfMaturity(effectiveFrom)) {
      const side = effectiveFrom === fileMaturity && fileMaturity !== fromMaturity
        ? `canonical ${card.rel} 已是 ${fileMaturity}（PG 行是 ${fromMaturity}，索引落后）`
        : `当前是 ${fromMaturity}`
      throw new Error(`cannot promote ${effectiveFrom} → ${toMaturity}：${side}。降级请走 demote，别用升格接口反向写。`)
    }

    const higherSiblings = siblings.filter(
      row => rankOfMaturity(row.maturity) > rankOfMaturity(toMaturity)
    )
    if (direction === 'promote' && higherSiblings.length) {
      throw new Error(
        `同一张卡（${sourceFile}）在 PG 还有更高档的活行：` +
        higherSiblings.map(row => `id=${row.id}(${row.maturity})`).join(' / ') +
        `。升到 ${toMaturity} 会让同卡两档并存，哪张权威无法自动判定 —— ` +
        '先用 kos-dedup-rows 收敛成一行，或直接对那张更高档的行操作。'
      )
    }

    const plan = card ? canonicalOps.planCanonicalMaturity(card, toMaturity) : { changed: false }

    const staleRows = [
      ...(fromMaturity === toMaturity ? [] : [{ id: memoryId, maturity: fromMaturity }]),
      ...siblings.filter(row => row.maturity !== toMaturity),
    ]

    if (!plan.changed && staleRows.length === 0) {
      throw new Error(
        direction === 'promote'
          ? `cannot promote ${fromMaturity} → ${toMaturity}`
          : `cannot demote ${fromMaturity} → ${toMaturity}`
      )
    }

    if (plan.changed && card.frozen && !allowFrozen) {
      throw new Error(
        `canonical ${card.rel} 是 frozen 锚点（frozen_since ${card.fm.frozen_since || '?'}），` +
        `改它的 maturity 等于改冻结内容，需 founder 显式解冻。` +
        '确已获批 → 带 allow_frozen=true 重试，理由会一并写进 promotion_log。'
      )
    }

    if (plan.changed) canonicalOps.writeCanonicalCard(card, plan.text)

    if (staleRows.length) {
      await c.query(
        'UPDATE team_memory.memories SET maturity = $1 WHERE id = ANY($2) AND scope = ANY($3)',
        [toMaturity, staleRows.map(row => Number(row.id)), authorizedWriteScopes]
      )
      for (const row of staleRows) {
        const isTarget = Number(row.id) === Number(memoryId)
        await c.query(
          `INSERT INTO team_memory.promotion_log (memory_id, from_maturity, to_maturity, approved_by, approved_by_name, reason, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            row.id,
            row.maturity,
            toMaturity,
            approvedBy || null,
            approvedByName || null,
            isTarget ? (reason || null) : `[同卡索引行随 id=${memoryId} 同步] ${reason || ''}`.trim(),
            JSON.stringify({
              via: 'promote_tool',
              canonical_file: card ? card.rel : null,
              canonical_written: Boolean(plan.changed),
              canonical_frozen_override: Boolean(plan.changed && card?.frozen && allowFrozen),
              sibling_of: isTarget ? null : Number(memoryId),
            }),
          ]
        )
      }
    }

    await c.query('COMMIT')
    return {
      id: memoryId,
      scope,
      from: fromMaturity,
      to: toMaturity,
      updatedIds: staleRows.map(row => Number(row.id)),
      siblingIds: siblings.map(row => Number(row.id)),
      canonical: card
        ? { file: card.rel, written: Boolean(plan.changed), was: fileMaturity }
        : { file: null, written: false, was: null },
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

export async function promoteMaturity(args) {
  if (!['verified', 'proven'].includes(args.toMaturity)) {
    throw new Error('toMaturity must be verified or proven')
  }
  const result = await changeMaturity({ ...args, direction: 'promote' })
  if (result.canonical.written) {
    defaultCanonicalOps.emitGitMirrorEvent({
      id: `kos:promote:${result.canonical.file}`,
      relPath: result.canonical.file,
      scope: result.scope,
      kosAction: 'updated',
      authorAgentId: args.approvedBy || null,
    })
  }
  return result
}

export async function demoteMaturity(args) {
  if (args.toMaturity !== 'draft') {
    throw new Error('toMaturity must be draft')
  }
  const result = await changeMaturity({ ...args, direction: 'demote' })
  if (result.canonical.written) {
    defaultCanonicalOps.emitGitMirrorEvent({
      id: `kos:demote:${result.canonical.file}`,
      relPath: result.canonical.file,
      scope: result.scope,
      kosAction: 'updated',
      authorAgentId: args.approvedBy || null,
    })
  }
  return result
}
