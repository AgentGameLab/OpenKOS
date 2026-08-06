
export const CANONICAL_SCOPES = ['personal', 'core', 'shared']

export const LEGACY_TEAM_ALIASES = ['all-agents', 'team', 'all_agents', 'allagents', 'all', 'everyone']

const CANONICAL_SCOPE_SET = new Set(CANONICAL_SCOPES)
const LEGACY_TEAM_ALIAS_SET = new Set(LEGACY_TEAM_ALIASES)

export function isLineScope(s) {
  return typeof s === 'string' && /^line-[a-z0-9][a-z0-9-]{0,31}$/.test(s)
}

export function isCanonicalScope(s) {
  return CANONICAL_SCOPE_SET.has(s) || isLineScope(s)
}

export function normalizeLegacyScope(s) {
  return LEGACY_TEAM_ALIAS_SET.has(s) ? 'core' : s
}
