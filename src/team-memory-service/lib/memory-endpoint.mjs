
import fs from 'node:fs'
import path from 'node:path'
import { remember as kosRemember, resolveAdrWritePath } from '../../kos/kos-remember.mjs'
import { storeMemory } from './store.mjs'
import { resolveWriteScopes } from './authz.mjs'
import { query } from './db.mjs'
import {
  CANONICAL_SCOPES,
  LEGACY_TEAM_ALIASES,
  isCanonicalScope,
  isLineScope,
  normalizeLegacyScope,
} from './scopes.mjs'
import { ROOT, isInsideRepo, emitGitMirrorEvent, loadCanonicalCard } from './canonical-card.mjs'

const VALID_TYPES = ['rule', 'playbook', 'decision', 'feedback', 'reference', 'incident', 'correction']
const MATURITY_RANK = { draft: 0, verified: 1, proven: 2 }
const STATUS_RANK = { deprecated: 0, active: 1 }


const PERSONAL_MEMORY_DIR = process.env.KOS_PROJECT_MEMORY_DIR || path.join(process.cwd(), '.openkos', 'memory')

const TYPE_ROUTING = {
  rule: { scope: 'all-agents', dir: 'team-memory/rules' },
  playbook: { scope: 'all-agents', dir: 'team-memory/playbooks' },
  decision: { scope: 'all-agents', dir: 'team-memory/decisions' },
  incident: { scope: 'all-agents', dir: 'team-memory/decisions' },
  feedback: { scope: 'personal', dir: null },
  reference: { scope: 'personal', dir: null },
  correction: { scope: 'personal', dir: null },
}

const PG_ALLOWED_TYPES = ['snapshot', 'pointer', 'rule', 'playbook', 'decision', 'feedback', 'user', 'general', 'incident', 'reference', 'correction']


export function transformInput(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body must be a JSON object', field: 'body' }
  }
  if (typeof body.content !== 'string' || body.content.length === 0) {
    return { ok: false, error: 'content is required (non-empty string)', field: 'content' }
  }
  if (!VALID_TYPES.includes(body.type)) {
    return { ok: false, error: `type must be one of [${VALID_TYPES.join(', ')}]`, field: 'type' }
  }
  if (typeof body.slug !== 'string' || body.slug.length === 0) {
    return { ok: false, error: 'slug is required (non-empty string)', field: 'slug' }
  }
  const normalizedScope = body.scope === undefined ? undefined : normalizeLegacyScope(body.scope)
  if (normalizedScope !== undefined && !isCanonicalScope(normalizedScope)) {
    const acceptedScopes = [...CANONICAL_SCOPES, 'line-*', ...LEGACY_TEAM_ALIASES]
    return { ok: false, error: `scope must be one of [${acceptedScopes.join(', ')}]`, field: 'scope' }
  }
  if (normalizedScope !== undefined && normalizedScope !== 'personal' && TYPE_ROUTING[body.type] && !TYPE_ROUTING[body.type].dir) {
    return {
      ok: false,
      error: `type=${body.type} 是 personal-only（团队仓无对应目录），不能指定 scope=${normalizedScope}。个人记忆请用 scope=personal（或省略）。`,
      field: 'scope',
    }
  }
  if (body.maturity !== undefined && !(body.maturity in MATURITY_RANK)) {
    return { ok: false, error: `maturity must be one of [${Object.keys(MATURITY_RANK).join(', ')}]`, field: 'maturity' }
  }
  if (body.status !== undefined && !(body.status in STATUS_RANK)) {
    return { ok: false, error: `status must be one of [${Object.keys(STATUS_RANK).join(', ')}]`, field: 'status' }
  }
  if (body.tags !== undefined && !Array.isArray(body.tags)) {
    return { ok: false, error: 'tags must be an array of strings', field: 'tags' }
  }
  if (body.authoritativeSources !== undefined && !Array.isArray(body.authoritativeSources)) {
    return { ok: false, error: 'authoritativeSources must be an array of strings', field: 'authoritativeSources' }
  }
  if (body.updateTarget !== undefined && typeof body.updateTarget !== 'string') {
    return { ok: false, error: 'updateTarget must be a string (repo-relative path or slug)', field: 'updateTarget' }
  }
  const cueKeys = ['paths', 'tools', 'cmds', 'entities']
  const cuesProvided = Object.hasOwn(body, 'cues')
  if (cuesProvided) {
    const cuesPrototype = body.cues === null || typeof body.cues !== 'object'
      ? null
      : Object.getPrototypeOf(body.cues)
    if (body.cues === null || typeof body.cues !== 'object' || Array.isArray(body.cues) || (cuesPrototype !== Object.prototype && cuesPrototype !== null)) {
      return { ok: false, error: 'cues must be a plain object', field: 'cues' }
    }
    for (const key of cueKeys) {
      if (Object.hasOwn(body.cues, key) && (!Array.isArray(body.cues[key]) || body.cues[key].some(value => typeof value !== 'string' || value.trim().length === 0))) {
        return { ok: false, error: `cues.${key} must be an array of non-empty strings`, field: `cues.${key}` }
      }
    }
  }
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (typeof body.expiresAt !== 'string') {
      return { ok: false, error: 'expiresAt must be ISO 8601 datetime string or null', field: 'expiresAt' }
    }
    const d = new Date(body.expiresAt)
    if (Number.isNaN(d.getTime())) {
      return { ok: false, error: 'expiresAt must parse as valid datetime', field: 'expiresAt' }
    }
  }
  const out = {
    content: body.content,
    type: body.type,
    slug: body.slug,
  }
  if (normalizedScope !== undefined) out.scope = normalizedScope
  if (body.tags !== undefined) out.tags = body.tags
  if (body.supersedes !== undefined) out.supersedes = body.supersedes
  if (body.lastCorrectedAt !== undefined) out.lastCorrectedAt = body.lastCorrectedAt
  if (body.authoritativeSources !== undefined) out.authoritativeSources = body.authoritativeSources
  if (body.description !== undefined) out.description = body.description
  if (body.name !== undefined) out.name = body.name
  if (body.maturity !== undefined) out.maturity = body.maturity
  if (body.status !== undefined) out.status = body.status
  if (body.expiresAt !== undefined) out.expiresAt = body.expiresAt  // P1 ADR-032
  if (body.updateTarget !== undefined) out.updateTarget = body.updateTarget  // 2026-08-02 原位更新覆盖口
  if (cuesProvided) {
    out.cues = {}
    for (const key of cueKeys) {
      if (Object.hasOwn(body.cues, key)) out.cues[key] = body.cues[key]
    }
  }
  if (body.confirmNew !== undefined) out.confirmNew = body.confirmNew
  if (body.dedupReason !== undefined) out.dedupReason = body.dedupReason
  if (body.allowShrink !== undefined) out.allowShrink = body.allowShrink
  if (body.allowTierReview !== undefined) out.allowTierReview = body.allowTierReview
  if (body.tierReason !== undefined) out.tierReason = body.tierReason
  return { ok: true, body: out }
}

function resolveTargetPath({ type, slug, scope, updateTarget }) {
  const route = TYPE_ROUTING[type]
  if (!route) return null
  const finalScope = scope || route.scope
  if (updateTarget && /[\\/]/.test(String(updateTarget))) {
    const rel = String(updateTarget).replace(/\\/g, '/')
    if (!path.isAbsolute(rel) && !rel.split('/').includes('..')) return path.join(ROOT, rel)
    return null
  }
  if (finalScope === 'shared' && route.dir) {
    return path.join(ROOT, 'team-memory', 'shared', path.basename(route.dir), `${slug}.md`)
  }
  if (isLineScope(finalScope) && route.dir) {
    return path.join(ROOT, 'team-memory', 'lines', finalScope.slice('line-'.length), path.basename(route.dir), `${slug}.md`)
  }
  if (type === 'decision' && /^adr-/i.test(slug)) {
    return resolveAdrWritePath(slug)
  }
  if (finalScope === 'all-agents' && route.dir) {
    return path.join(ROOT, route.dir, `${slug}.md`)
  }
  return path.join(PERSONAL_MEMORY_DIR, `${type}_${slug}.md`)
}

function readExistingStrongFields(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  try {
    const text = fs.readFileSync(filePath, 'utf-8')
    if (!text.startsWith('---\n')) return {}
    const end = text.indexOf('\n---\n', 4)
    if (end < 0) return {}
    const fmText = text.slice(4, end)
    const out = {}
    for (const line of fmText.split('\n')) {
      const m = line.match(/^(maturity|status):\s*(\S+)\s*$/)
      if (m) out[m[1]] = m[2]
    }
    return out
  } catch {
    return {}
  }
}

export function detectMaturityConflict(input) {
  const target = resolveTargetPath(input)
  const oldFm = readExistingStrongFields(target)
  if (!oldFm) return null
  if (input.maturity !== undefined && oldFm.maturity !== undefined) {
    const oldRank = MATURITY_RANK[oldFm.maturity]
    const newRank = MATURITY_RANK[input.maturity]
    if (oldRank !== undefined && newRank !== undefined && newRank < oldRank) {
      return { conflict: true, field: 'maturity', old_value: oldFm.maturity, new_value: input.maturity }
    }
  }
  if (input.status !== undefined && oldFm.status !== undefined) {
    const oldRank = STATUS_RANK[oldFm.status]
    const newRank = STATUS_RANK[input.status]
    if (oldRank !== undefined && newRank !== undefined && newRank < oldRank) {
      return { conflict: true, field: 'status', old_value: oldFm.status, new_value: input.status }
    }
  }
  return null
}


export async function applyIndexMaturity({ id, requested, authAgent, kosFile }) {
  if (!requested || !['draft', 'verified', 'proven'].includes(requested)) return { changed: false, skipped: 'no valid maturity' }

  const cur = await query('SELECT maturity FROM team_memory.memories WHERE id = $1', [id])
  const from = cur.rows[0]?.maturity ?? null
  if (from === requested) return { changed: false, from, to: requested }

  await query('UPDATE team_memory.memories SET maturity = $1 WHERE id = $2', [requested, id])

  let writtenBy = null
  try {
    const card = kosFile ? loadCanonicalCard(kosFile) : null
    if (card?.found) writtenBy = card.fm?.written_by?.agent_id || null
  } catch { /* 记账不该拖垮写入 */ }

  try {
    await query(
      `INSERT INTO team_memory.promotion_log (memory_id, from_maturity, to_maturity, approved_by, approved_by_name, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        from ?? 'draft',
        requested,
        authAgent?.agent_id || null,
        authAgent?.agent_name || null,
        `frontmatter 直写（index_only 通道）：.md 声明 ${requested}，索引跟随`,
        JSON.stringify({
          via: 'index_only',
          canonical_file: kosFile || null,
          frontmatter_written_by: writtenBy,
          note: 'approved_by 是推送这条 sync 的 principal，不是标定档位的人',
        }),
      ]
    )
  } catch (err) {
    console.warn(`[/api/memory] maturity 记账失败 id=${id} ${from}→${requested}: ${err.message}`)
  }
  return { changed: true, from, to: requested }
}

async function handleIndexOnlyWrite(rawBody, authAgent, t0) {
  if (!rawBody.content || typeof rawBody.content !== 'string' || rawBody.content.length === 0) {
    return { status: 400, body: { ok: false, error: 'content is required' } }
  }
  const validIndexTypes = ['snapshot','pointer','rule','playbook','decision','feedback','user','general','incident','reference','correction']
  const type = rawBody.type
  if (!validIndexTypes.includes(type)) {
    return { status: 400, body: { ok: false, error: `type must be one of [${validIndexTypes.join(', ')}]` } }
  }
  const name = rawBody.name || rawBody.slug
  if (!name || typeof name !== 'string' || name.length === 0) {
    return { status: 400, body: { ok: false, error: 'slug or name is required' } }
  }

  const kosFile = rawBody.kos_file ?? null
  if (kosFile !== null) {
    if (typeof kosFile !== 'string' || !isInsideRepo(kosFile)) {
      return {
        status: 400,
        body: { ok: false, error: 'kos_file must be a repo-relative path (no absolute path, no ".." traversal)', field: 'kos_file' },
      }
    }
  }
  const normalizedKosFile = kosFile === null ? null : kosFile.replace(/\\/g, '/')

  try {
    const result = await storeMemory({
      content: rawBody.content,
      name,
      description: rawBody.description,
      type,
      scope: normalizeLegacyScope('all-agents'),
      tags: Array.isArray(rawBody.tags) ? rawBody.tags : [],
      importance: rawBody.importance,
      metadata: {
        kos_slug: rawBody.slug || null,
        kos_type: rawBody.kos_type || type,
        kos_file: normalizedKosFile,
        indexed_by: 'kos-index-sync',
      },
      author_agent_id: authAgent?.agent_id || null,
      source_file: normalizedKosFile,
    })

    if (result.status === 'duplicate' && normalizedKosFile !== null) {
      try {
        const existing = await query('SELECT source_file FROM team_memory.memories WHERE id = $1', [result.id])
        if (!existing.rows[0]) {
          console.warn(`[/api/memory] duplicate source_file 回填失败 id=${result.id} path=${normalizedKosFile}: row not found`)
        } else if (existing.rows[0].source_file === null) {
          const backfill = await query(
            'UPDATE team_memory.memories SET source_file = $1 WHERE id = $2 AND source_file IS NULL',
            [normalizedKosFile, result.id]
          )
          if (backfill.rowCount > 0) {
            console.log(`[/api/memory] duplicate source_file 已回填 id=${result.id} path=${normalizedKosFile}`)
          } else {
            console.warn(`[/api/memory] duplicate source_file 回填失败 id=${result.id} path=${normalizedKosFile}: row changed before update`)
          }
        }
      } catch (err) {
        console.warn(`[/api/memory] duplicate source_file 回填失败 id=${result.id} path=${normalizedKosFile}: ${err.message}`)
      }
    }

    await applyIndexMaturity({
      id: result.id,
      requested: rawBody.maturity,
      authAgent,
      kosFile: normalizedKosFile,
    })

    return {
      status: 200,
      body: {
        ok: true,
        id: result.id,
        hash: result.hash,
        status: result.status,
        index_only: true,
        duration_ms: Date.now() - t0,
      },
    }
  } catch (err) {
    return { status: 502, body: { ok: false, error: `index_only store failed: ${err.message}` } }
  }
}

export async function handleMemoryWrite(rawBody, authAgent, opts = {}) {
  const t0 = Date.now()

  if (rawBody.index_only === true) {
    return handleIndexOnlyWrite(rawBody, authAgent, t0)
  }

  const v = transformInput(rawBody)
  if (!v.ok) {
    return { status: 400, body: { ok: false, error: v.error, field: v.field } }
  }
  const input = v.body

  if (input.allowTierReview) {
    const writable = resolveWriteScopes(authAgent) || []
    if (!writable.includes('all-agents')) {
      return {
        status: 403,
        body: {
          ok: false,
          error: '分级闸豁免（allowTierReview）仅 core 可用。命中词表说明内容可能含敏感信息，请改写，或联系 core 成员复核后代写。',
          field: 'allowTierReview',
        },
      }
    }
    if (typeof input.tierReason !== 'string' || input.tierReason.trim().length < 5) {
      return {
        status: 400,
        body: { ok: false, error: 'allowTierReview 必须同时提供 tierReason（说明为什么这条不算敏感）', field: 'tierReason' },
      }
    }
  }

  const conflict = detectMaturityConflict(input)
  if (conflict) {
    return {
      status: 409,
      body: {
        ok: false,
        error: `Cannot downgrade ${conflict.field} from ${conflict.old_value} to ${conflict.new_value}`,
        field: conflict.field,
        old_value: conflict.old_value,
        new_value: conflict.new_value,
      },
    }
  }

  let kosResult
  try {
    kosResult = await kosRemember(input)
  } catch (err) {
    const POLICY_ERROR_CODES = new Set(['KOS_DEDUP_GATE', 'KOS_SENTINEL_GATE'])
    const isDedupBlock = err.code === 'KOS_DEDUP_GATE'
    const isPolicyBlock =
      POLICY_ERROR_CODES.has(err.code) ||
      (typeof err.message === 'string' && err.message.startsWith('BLOCKED:'))
    if (isPolicyBlock) {
      if (isDedupBlock) {
        return {
          status: 409,
          body: {
            ok: false,
            error: err.message,
            blocked: true,
            code: err.code,
            candidates: err.candidates,
            max_score: err.maxScore,
            attempted: err.attempted,
          },
        }
      }
      return {
        status: 422,
        body: {
          ok: false,
          error: err.message,
          blocked: true,
          ...(err.code ? { code: err.code } : {}),
          ...(err.findings ? { findings: err.findings } : {}),
        },
      }
    }
    console.error('[kos_remember] failed:', err.stack || err.message)
    return {
      status: 502,
      body: { ok: false, error: `kos_remember failed: ${err.message}` },
    }
  }

  const route = TYPE_ROUTING[input.type]
  const finalScope = input.scope || route.scope
  const relPath = path.relative(ROOT, kosResult.location).replace(/\\/g, '/')

  const pgMirror = { attempted: false, ok: false }
  if (!opts.skipPgMirror && finalScope !== 'personal') {
    pgMirror.attempted = true
    try {
      const pgType = input.type
      if (PG_ALLOWED_TYPES.includes(pgType)) {
        const mirrorTags = Array.isArray(input.tags) ? [...input.tags] : []
        await storeMemory({
          content: input.content,
          name: input.name || input.slug,
          description: input.description,
          type: pgType,
          scope: finalScope,
          tags: mirrorTags,
          metadata: {
            kos_slug: input.slug,
            kos_type: input.type,
            kos_file: relPath,
          },
          source_file: relPath,
          author_agent_id: authAgent?.agent_id || null,
          last_corrected_at: input.lastCorrectedAt || null,
          expires_at: input.expiresAt || null,
          supersedes: input.supersedes || [],
          authorizedWriteScopes: resolveWriteScopes(authAgent) || [],
        })
        pgMirror.ok = true
      } else {
        pgMirror.skipped = `type ${input.type} not in PG ALLOWED_TYPES (fs-only)`
      }
    } catch (err) {
      pgMirror.error = err.message
      console.warn(`[/api/memory] PG mirror failed (non-fatal): ${err.message}`)
    }
  }

  emitGitMirrorEvent({
    id: `kos:${input.type}:${input.slug}`,
    relPath,
    scope: finalScope,
    kosAction: kosResult.status,
    authorAgentId: authAgent?.agent_id || null,
  })

  return {
    status: 200,
    body: {
      ok: true,
      id: `kos:${input.type}:${input.slug}`,
      path: relPath,
      merged: kosResult.status === 'updated',
      preservedFields: [],   // 409 在前已 reject 降级；此处 fs merge 不会保留旧 maturity/status
      kos_action: kosResult.status,
      pg_mirror: pgMirror,
      metric: {
        tool: 'kos_remember',
        type: input.type,
        slug: input.slug,
        duration_ms: Date.now() - t0,
        ok: true,
      },
    },
  }
}
