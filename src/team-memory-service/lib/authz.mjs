
import { normalizeLegacyScope } from './scopes.mjs'

const ALLOWED_PERMISSIONS = new Set([
  'memory:read',
  'memory:write',
  'memory:promote',
])

const EMPTY_GRANT = Object.freeze({
  scopes: Object.freeze([]),
  writeScopes: Object.freeze([]),
  defaultScopes: Object.freeze([]),
  permissions: Object.freeze([]),
  roles: Object.freeze([]),
})

export class AuthorizationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthorizationError'
    this.code = 'forbidden'
    this.statusCode = 403
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeScope(scope) {
  return normalizeLegacyScope(scope)
}

function validateStringArray(value, field) {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.length > 0)) {
    throw new TypeError(`${field} must be an array of non-empty strings`)
  }
  return [...new Set(value)]
}

function validateGrant(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  const scopes = validateStringArray(value.scopes, `${label}.scopes`).map(normalizeScope)
  const permissions = validateStringArray(value.permissions, `${label}.permissions`)
  const roles = validateStringArray(value.roles, `${label}.roles`)
  const writeScopes = value.writeScopes === undefined
    ? []
    : validateStringArray(value.writeScopes, `${label}.writeScopes`).map(normalizeScope)
  if (!permissions.every(permission => ALLOWED_PERMISSIONS.has(permission))) {
    throw new TypeError(`${label}.permissions contains an unsupported permission`)
  }
  if (
    permissions.some(permission => permission === 'memory:write' || permission === 'memory:promote') &&
    writeScopes.length === 0
  ) {
    throw new TypeError(`${label}.writeScopes is required for memory:write or memory:promote`)
  }
  const defaultScopes = value.defaultScopes === undefined
    ? []
    : validateStringArray(value.defaultScopes, `${label}.defaultScopes`).map(normalizeScope)
  const normalizedScopes = [...new Set(scopes)]
  const normalizedWriteScopes = [...new Set(writeScopes)]
  const normalizedDefaultScopes = [...new Set(defaultScopes)]
  if (normalizedWriteScopes.some(scope => !normalizedScopes.includes(scope))) {
    throw new TypeError(`${label}.writeScopes must be a subset of scopes`)
  }
  if (normalizedDefaultScopes.some(scope => !normalizedScopes.includes(scope))) {
    throw new TypeError(`${label}.defaultScopes must be a subset of scopes`)
  }
  return Object.freeze({
    scopes: Object.freeze(normalizedScopes),
    writeScopes: Object.freeze(normalizedWriteScopes),
    defaultScopes: Object.freeze(normalizedDefaultScopes),
    permissions: Object.freeze(permissions),
    roles: Object.freeze(roles),
  })
}

function validateGrantMap(value, label) {
  if (value === undefined) return Object.freeze({})
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, grant]) => {
      if (!key) throw new TypeError(`${label} contains an empty key`)
      return [key, validateGrant(grant, `${label}.${key}`)]
    })
  ))
}

function loadAuthorizationConfig(raw) {
  if (!raw) {
    console.error('[authz] TM_MEMORY_AUTHZ_GRANTS 未配置；所有 principal 默认无权限')
    return Object.freeze({ byResidentId: Object.freeze({}), byAgentName: Object.freeze({}) })
  }

  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) throw new TypeError('root must be an object')
    return Object.freeze({
      byResidentId: validateGrantMap(parsed.by_resident_id, 'by_resident_id'),
      byAgentName: validateGrantMap(parsed.by_agent_name, 'by_agent_name'),
    })
  } catch (error) {
    console.error(`[authz] TM_MEMORY_AUTHZ_GRANTS 配置无效；所有 principal 默认无权限：${error.message}`)
    return Object.freeze({ byResidentId: Object.freeze({}), byAgentName: Object.freeze({}) })
  }
}

let loadedConfigRaw
let authorizationConfig

function getAuthorizationConfig() {
  const raw = process.env.TM_MEMORY_AUTHZ_GRANTS
  if (authorizationConfig === undefined || raw !== loadedConfigRaw) {
    loadedConfigRaw = raw
    authorizationConfig = loadAuthorizationConfig(raw)
  }
  return authorizationConfig
}

export function resolvePrincipalAuthorization({ resident_id: residentId, agent_name: agentName } = {}) {
  if (!residentId) return { ...EMPTY_GRANT }

  const config = getAuthorizationConfig()
  const residentGrant = Object.hasOwn(config.byResidentId, residentId)
    ? config.byResidentId[residentId]
    : null
  const nameGrant = typeof agentName === 'string' && Object.hasOwn(config.byAgentName, agentName)
    ? config.byAgentName[agentName]
    : null
  const grant = residentGrant || nameGrant || EMPTY_GRANT
  return {
    scopes: [...grant.scopes],
    writeScopes: [...grant.writeScopes],
    defaultScopes: [...(grant.defaultScopes || [])],
    permissions: [...grant.permissions],
    roles: [...grant.roles],
  }
}

export function requirePermission(principal, permission) {
  if (!ALLOWED_PERMISSIONS.has(permission)) {
    throw new AuthorizationError('unsupported permission')
  }
  if (!Array.isArray(principal?.permissions) || !principal.permissions.includes(permission)) {
    throw new AuthorizationError(`缺少权限：${permission}`)
  }
}

export function requireRole(principal, role) {
  if (!Array.isArray(principal?.roles) || !principal.roles.includes(role)) {
    throw new AuthorizationError(`缺少角色：${role}`)
  }
}

export function authorizeRequestedScopes(principal, requestedScopes, defaultScopes) {
  const requested = requestedScopes === undefined || requestedScopes === null
    ? defaultScopes
    : requestedScopes
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new AuthorizationError('scope_filter 必须是非空数组')
  }
  if (!requested.every(scope => typeof scope === 'string' && scope.length > 0)) {
    throw new AuthorizationError('scope_filter 包含无效 scope')
  }

  const normalizedRequested = [...new Set(requested.map(normalizeScope))]
  const allowedScopes = new Set(
    Array.isArray(principal?.scopes) ? principal.scopes.map(normalizeScope) : []
  )
  const unauthorized = normalizedRequested.filter(scope => !allowedScopes.has(scope))
  if (unauthorized.length > 0) {
    throw new AuthorizationError(`无权访问 scope：${unauthorized.join(', ')}`)
  }
  return normalizedRequested.filter(scope => allowedScopes.has(scope))
}

export function resolveWriteScopes(principal) {
  return principal?.writeScopes ?? principal?.scopes
}

export function resolveDefaultScopes(principal) {
  const d = principal?.defaultScopes
  return Array.isArray(d) && d.length ? d : principal?.scopes
}

export function authorizeWriteScope(principal, requestedScope) {
  if (typeof requestedScope !== 'string' || requestedScope.length === 0) {
    throw new AuthorizationError('写入 scope 无效')
  }
  const writeScopes = resolveWriteScopes(principal)
  return authorizeRequestedScopes({ scopes: writeScopes }, [requestedScope], writeScopes)[0]
}
