
import { createHash } from 'node:crypto'
import { getPool } from './db.mjs'
import { resolvePrincipalAuthorization } from './authz.mjs'

const tokenCache = new Map()  // token → { payload, expires_at, validated_at }
const negativeTokenCache = new Map()  // token hash → expires_at
const CACHE_TTL_MS = 5 * 60 * 1000
const SENSITIVE_CACHE_TTL_MS = 30 * 1000
const NEGATIVE_CACHE_TTL_MS = 10 * 1000
const MAX_NEGATIVE_CACHE_ENTRIES = 1000
const SERVICE_TOKEN_TYPES = Object.freeze(['agent'])

function cacheNegativeToken(tokenHash, now) {
  if (negativeTokenCache.size >= MAX_NEGATIVE_CACHE_ENTRIES) {
    negativeTokenCache.delete(negativeTokenCache.keys().next().value)
  }
  negativeTokenCache.set(tokenHash, now + NEGATIVE_CACHE_TTL_MS)
}

export function invalidateTokenCache(token) {
  if (token === undefined) {
    tokenCache.clear()
    negativeTokenCache.clear()
    return
  }
  tokenCache.delete(token)
  if (typeof token === 'string') {
    negativeTokenCache.delete(createHash('sha256').update(token).digest('hex'))
  }
}

export function extractToken(req) {
  const auth = req.headers.authorization || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (m) return m[1].trim()
  if (process.env.TM_ALLOW_QUERY_TOKEN === '1' && req.url) {
    try {
      const u = new URL(req.url, 'http://x')
      const t = u.searchParams.get('token')
      if (t) return t
    } catch {}
  }
  return null
}

export async function verifyToken(token, dbUrl, { sensitive = false } = {}) {
  if (!token || !dbUrl) return null
  const now = Date.now()
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const maxCacheAgeMs = sensitive ? SENSITIVE_CACHE_TTL_MS : CACHE_TTL_MS
  const cached = tokenCache.get(token)
  if (
    cached &&
    cached.expires_at > now &&
    cached.validated_at + maxCacheAgeMs > now
  ) {
    return cached.payload
  }
  if (cached) tokenCache.delete(token)

  const negativeExpiresAt = negativeTokenCache.get(tokenHash)
  if (negativeExpiresAt > now) return null
  if (negativeExpiresAt) negativeTokenCache.delete(tokenHash)

  let payload = null
  let lookupSucceeded = false
  try {
    const s = await getPool().query(
        `SELECT id AS token_id, agent_name, principal_id, expires_at
           FROM team_memory.service_tokens
          WHERE token_hash = $1
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())
          LIMIT 1`,
        [tokenHash]
      )
    lookupSucceeded = true
    if (s.rows.length) {
        const row = s.rows[0]
        const dbExpiresAtMs = row.expires_at === null
          ? Number.POSITIVE_INFINITY
          : new Date(row.expires_at).getTime()
        if (
          !row.token_id ||
          typeof row.principal_id !== 'string' ||
          row.principal_id.length === 0 ||
          typeof row.agent_name !== 'string' ||
          row.agent_name.length === 0 ||
          (!Number.isFinite(dbExpiresAtMs) && dbExpiresAtMs !== Number.POSITIVE_INFINITY) ||
          dbExpiresAtMs <= now
        ) {
          cacheNegativeToken(tokenHash, now)
          return null
        }
        const authorization = resolvePrincipalAuthorization({
          resident_id: row.principal_id,   // authz 的 by_resident_id 按 principal_id 匹配
          agent_name: row.agent_name,
        })
        payload = {
          agent_id: row.principal_id,
          agent_name: row.agent_name,
          token_id: row.token_id,
          token_type: 'service',
          expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
          roles: authorization.roles,
          scopes: authorization.scopes,
          writeScopes: authorization.writeScopes,
          defaultScopes: authorization.defaultScopes,
          permissions: authorization.permissions,
        }
      }
  } catch (e) {
    const message = e?.message || String(e)
    console.error('[auth] token verification failed:', message)
    payload = null
  }

  if (payload) {
    const validatedAt = Date.now()
    const dbExpiresAtMs = payload.expires_at
      ? new Date(payload.expires_at).getTime()
      : Number.POSITIVE_INFINITY
    tokenCache.set(token, {
      payload,
      validated_at: validatedAt,
      expires_at: Math.min(validatedAt + maxCacheAgeMs, dbExpiresAtMs),
    })
  } else if (lookupSucceeded) {
    cacheNegativeToken(tokenHash, Date.now())
  }
  return payload
}

export async function checkTokenTableAccess(dbUrl) {
  if (!dbUrl) return { ok: false, error: 'TM_DATABASE_URL not set' }
  const errors = []
  for (const table of ['team_memory.service_tokens']) {
    try {
      await getPool().query(`SELECT 1 FROM ${table} LIMIT 1`)
    } catch (e) {
      errors.push(`${table}: ${e.message}`)
    }
  }
  if (errors.length) return { ok: false, error: errors.join(' | ') }
  return { ok: true }
}

export async function authenticate(req, dbUrl, options = {}) {
  try {
    const token = extractToken(req)
    if (!token) return { ok: false, error: 'missing token (Authorization: Bearer <KOS_SERVICE_TOKEN>)' }
    const agent = await verifyToken(token, dbUrl, options)
    if (!agent) return { ok: false, error: 'invalid or revoked token' }
    return { ok: true, agent }
  } catch (e) {
    console.error('[auth] authentication failed:', e?.message || String(e))
    return { ok: false, error: 'invalid or revoked token' }
  }
}
