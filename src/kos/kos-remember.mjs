#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import crypto from 'node:crypto'
import { spawn, execSync } from 'node:child_process'
import { checkDuplicate, upsertEntry } from './kos-dedup.mjs'
import { scanContent } from './lib/sentinel-scan.mjs'
import { LEGACY_TEAM_ALIASES, isCanonicalScope, isLineScope } from '../team-memory-service/lib/scopes.mjs'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..')

let _gitIdentityCache
function gitIdentityFallback() {
  if (_gitIdentityCache !== undefined) return _gitIdentityCache
  try {
    _gitIdentityCache = execSync('git config user.name', {
      cwd: __dirname, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null
  } catch {
    _gitIdentityCache = null
  }
  return _gitIdentityCache
}
const METRIC_PATH = path.join(ROOT, '.asi', 'kos-write-metrics.jsonl')
const TIER_PATTERNS_PATH = path.resolve(__dirname, '..', 'hooks', 'lib', 'tier-patterns.json')
const PROJECT_MEMORY_KEY = path.resolve(ROOT)
  .replace(/^([A-Za-z]):/, '$1-')
  .replace(/[\\/]/g, '-')

const PERSONAL_MEMORY_DIR = process.env.KOS_MEMORY_DIR || path.resolve(
  process.env.USERPROFILE || process.env.HOME,
  '.claude', 'projects', PROJECT_MEMORY_KEY, 'memory'
)

const ROUTE_MANIFEST_PATH = path.join(ROOT, 'team-memory', 'pointers', 'kos-route-map.json')
let ROUTE_MANIFEST
try {
  ROUTE_MANIFEST = JSON.parse(fs.readFileSync(ROUTE_MANIFEST_PATH, 'utf-8'))
} catch (err) {
  throw new Error(
    `[kos-remember] 无法加载路由清单 ${ROUTE_MANIFEST_PATH}: ${err.message}\n` +
    `  数据根尚未初始化？运行: node ${path.join(__dirname, 'kos-init.mjs')} --data-root <数据根>`
  )
}
if (!ROUTE_MANIFEST || typeof ROUTE_MANIFEST.types !== 'object' || Array.isArray(ROUTE_MANIFEST.types)) {
  throw new Error(`[kos-remember] 路由清单 ${ROUTE_MANIFEST_PATH} 缺少有效的 types 对象`)
}
const TYPE_ROUTING = ROUTE_MANIFEST.types

const MATURITY_RANK = { draft: 0, verified: 1, proven: 2 }
const STATUS_RANK   = { deprecated: 0, active: 1 }
const MATURITY_ALIASES = {
  validated: 'verified',
  'signed-off': 'verified',
  stable: 'verified',
  proposed: 'draft',
  candidate: 'draft',
  'in-progress': 'draft',
  latticework: 'draft',
  latticework_draft: 'draft',
  active: 'draft',
}

function rankOf(table, v) {
  if (v == null) return -1
  return table[v] != null ? table[v] : -1
}

function gateMaturity(maturity, existingMaturity) {
  if (maturity === undefined) return { maturity }
  if (Object.hasOwn(MATURITY_RANK, maturity)) return { maturity }

  if (maturity === 'superseded') {
    const mapped = Object.hasOwn(MATURITY_RANK, existingMaturity)
      ? existingMaturity
      : 'draft'
    return { maturity: mapped, status: 'superseded', superseded: true, original: maturity }
  }

  if (Object.hasOwn(MATURITY_ALIASES, maturity)) {
    return { maturity: MATURITY_ALIASES[maturity], original: maturity }
  }

  throw new Error(`maturity=${JSON.stringify(maturity)} 无效；规范枚举仅支持：draft, verified, proven`)
}

const KG_INCREMENTAL_SKIP_LOG = path.join(ROOT, '.asi', 'kg-incremental-skip.jsonl')

function hasUnstagedTeamMemoryChanges() {
  try {
    const out = execSync('git status -s team-memory/', { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] })
    const lines = out.split('\n').filter(Boolean)
    return lines.length > 1
  } catch {
    return false
  }
}

function scheduleKgRefresh(writtenFile) {
  if (hasUnstagedTeamMemoryChanges()) {
    try {
      fs.mkdirSync(path.dirname(KG_INCREMENTAL_SKIP_LOG), { recursive: true })
      fs.appendFileSync(KG_INCREMENTAL_SKIP_LOG, JSON.stringify({
        ts: new Date().toISOString(),
        reason: 'unstaged_team_memory_changes',
        triggered_by: path.relative(ROOT, writtenFile).replace(/\\/g, '/'),
      }) + '\n', 'utf-8')
    } catch {}
    return { skipped: true }
  }
  try {
    const child = spawn(process.execPath, [url.fileURLToPath(new URL('../kg/knowledge-graph-gen.mjs', import.meta.url)), '--quiet'], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return { skipped: false, pid: child.pid }
  } catch {
    return { skipped: true, reason: 'spawn_failed' }
  }
}


const RAW_FM_LINES = Symbol('kos-raw-fm-lines')
const UNPARSEABLE = Symbol('kos-fm-unparseable')

function makeRawFmValue(lines) {
  return { [RAW_FM_LINES]: lines }
}

function isRawFmValue(value) {
  return value != null && typeof value === 'object' && Array.isArray(value[RAW_FM_LINES])
}

function serializeFmField(key, value) {
  if (isRawFmValue(value)) return [...value[RAW_FM_LINES]]
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}: []`]
    return [`${key}:`, ...value.map(item => `  - ${item}`)]
  }
  if (key === 'cues' && value && typeof value === 'object') {
    const lines = [`${key}:`]
    for (const cueKey of CUE_KEYS) {
      const cueValues = value[cueKey]
      if (!Array.isArray(cueValues) || cueValues.length === 0) continue
      lines.push(`  ${cueKey}:`)
      for (const cueValue of cueValues) lines.push(`    - ${cueValue}`)
    }
    return lines
  }
  if (key === 'written_by' && value && typeof value === 'object') {
    return [
      `${key}:`,
      `  agent_id: ${value.agent_id}`,
      `  session_id: ${value.session_id}`,
      `  ts: ${value.ts}`,
    ]
  }
  if (value && typeof value === 'object') {
    throw new Error(`frontmatter 字段 ${key} 是对象但无已知序列化形状（仅 cues/written_by 支持对象值）`)
  }
  return [`${key}: ${value}`]
}

function parseKnownShape(key, rest, blockLines) {
  let value
  if (rest !== '') {
    if (blockLines.length !== 1) return UNPARSEABLE // scalar 带续行（如 `k: >` 折叠串）→ raw
    value = rest === '[]' ? [] : rest
  } else {
    const tail = blockLines.slice(1)
    const obj = {}
    let k = 0
    while (k < tail.length) {
      const nested = tail[k].match(/^  ([A-Za-z0-9_]+):\s*(.*)$/)
      if (!nested) break
      k++
      if (nested[2] === '') {
        const arr = []
        while (k < tail.length && /^    -\s+/.test(tail[k])) {
          arr.push(tail[k].replace(/^    -\s+/, ''))
          k++
        }
        obj[nested[1]] = arr
      } else if (nested[2] === '[]') {
        obj[nested[1]] = []
      } else {
        obj[nested[1]] = nested[2]
      }
    }
    if (Object.keys(obj).length) {
      if (k !== tail.length) return UNPARSEABLE // 对象后还有残行（旧实现把残行漏回顶层循环丢掉）
      value = obj
    } else {
      const arr = []
      let j = 0
      while (j < tail.length && /^\s+-\s+/.test(tail[j])) {
        arr.push(tail[j].replace(/^\s+-\s+/, ''))
        j++
      }
      if (j !== tail.length) return UNPARSEABLE // 对象列表（`- k: v` + 续行）走这里 → raw
      value = arr
    }
  }
  let out
  try {
    out = serializeFmField(key, value)
  } catch {
    return UNPARSEABLE
  }
  if (out.length !== blockLines.length) return UNPARSEABLE
  for (let n = 0; n < out.length; n++) {
    if (out[n] !== blockLines[n]) return UNPARSEABLE
  }
  return value
}

function parseFrontmatter(text) {
  text = text.replace(/\r\n/g, '\n') // CRLF 容错：归一化后再解析，否则 CRLF 文件 startsWith('---\n') 失败 → oldFm 空 → 更新时吐降级 frontmatter
  if (!text.startsWith('---\n')) return { fm: {}, body: text, comments: {}, orphanLines: [] }
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) return { fm: {}, body: text, comments: {}, orphanLines: [] }
  const fmText = text.slice(4, end)
  const body = text.slice(end + 5) // skip '\n---\n'
  const fm = {}
  const comments = {}
  const orphanLines = []
  let pendingComments = []
  const lines = fmText.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (/^#/.test(line)) { pendingComments.push(line); i++; continue }
    const blockLines = [line]
    i++
    while (i < lines.length) {
      const next = lines[i]
      if (next.trim() && /^\s/.test(next)) { blockLines.push(next); i++; continue }
      if (!next.trim()) {
        let j = i + 1
        while (j < lines.length && !lines[j].trim()) j++
        if (j < lines.length && /^\s/.test(lines[j])) {
          for (; i < j; i++) blockLines.push(lines[i])
          continue
        }
      }
      break
    }
    const m = blockLines[0].match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!m) {
      orphanLines.push(...pendingComments, ...blockLines)
      pendingComments = []
      continue
    }
    const key = m[1]
    if (pendingComments.length) {
      comments[key] = [...(comments[key] || []), ...pendingComments]
      pendingComments = []
    }
    const value = parseKnownShape(key, m[2], blockLines)
    fm[key] = value === UNPARSEABLE ? makeRawFmValue(blockLines) : value
  }
  if (pendingComments.length) orphanLines.push(...pendingComments)
  return { fm, body, comments, orphanLines }
}

let tierPatternsCache = null

function loadTierPatterns() {
  if (tierPatternsCache) return tierPatternsCache
  try {
    const parsed = JSON.parse(fs.readFileSync(TIER_PATTERNS_PATH, 'utf-8'))
    if (!Array.isArray(parsed.patterns)) throw new Error('缺少 patterns 数组')
    tierPatternsCache = parsed.patterns.map((pattern, index) => {
      if (!pattern || typeof pattern.label !== 'string' || typeof pattern.source !== 'string') {
        throw new Error(`patterns[${index}] 缺少有效 label/source`)
      }
      return { ...pattern, regex: new RegExp(pattern.source, pattern.flags || '') }
    })
    return tierPatternsCache
  } catch (err) {
    throw new Error(`BLOCKED: 无法加载分级词表 ${TIER_PATTERNS_PATH}: ${err.message}。敏感度先行——Core/Restricted 永不进 KOS`)
  }
}

function findTierMatches(patterns, text) {
  return patterns.filter(pattern => pattern.regex.test(text))
}

function level2Headings(body) {
  const headings = []
  for (const line of String(body).replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^##(?!#)[\t ]+(.+?)[\t ]*$/)
    if (!match) continue
    const heading = match[1].replace(/[\t ]+#+[\t ]*$/, '').trim()
    if (heading) headings.push(heading)
  }
  return headings
}

function inspectBodyShrink(existingBody, incomingBody) {
  const incomingHeadings = new Set(level2Headings(incomingBody))
  const missingHeadings = [...new Set(level2Headings(existingBody))]
    .filter(heading => !incomingHeadings.has(heading))
  const existingLength = Array.from(existingBody).length
  const incomingLength = Array.from(incomingBody).length
  const ratio = existingLength === 0 ? 1 : incomingLength / existingLength
  return { missingHeadings, existingLength, incomingLength, ratio }
}

const TEAM_SCOPE_ALIASES = new Set(['core', 'all-agents', ...LEGACY_TEAM_ALIASES])

function normalizeScope(scope) {
  if (!scope) return null
  const s = String(scope).trim().toLowerCase()
  return TEAM_SCOPE_ALIASES.has(s) ? 'team' : String(scope).trim()
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function validateSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug) || WINDOWS_DEVICE_NAME.test(slug)) {
    throw new Error('slug 必须匹配 ^[a-z0-9][a-z0-9._-]{0,127}$，且不能使用 Windows 设备名')
  }
}

function isRepositoryScope(scope) {
  return scope === 'team' || scope === 'shared' || isLineScope(scope)
}

function resolveRingDirectory(finalScope, route) {
  const teamRoute = route.path || route.team_path
  if (!teamRoute) return null
  const typeDir = path.basename(teamRoute)
  if (finalScope === 'shared') {
    return path.join(ROOT, 'team-memory', 'shared', typeDir)
  }
  if (isLineScope(finalScope)) {
    return path.join(ROOT, 'team-memory', 'lines', finalScope.slice('line-'.length), typeDir)
  }
  return null
}

function assertPathContained(assignedDir, targetPath) {
  const absoluteDir = path.resolve(assignedDir)
  const absoluteTarget = path.resolve(targetPath)
  const rel = path.relative(absoluteDir, absoluteTarget)
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) {
    throw new Error(`目标路径逃出 scope 目录: ${absoluteTarget}`)
  }
  return absoluteTarget
}

const CUE_KEYS = ['paths', 'tools', 'cmds', 'entities']
const GENERIC_CUE_TAGS = new Set(['team', 'wide-scan', 'domain-research', 'padi'])
const CUE_ENTITY_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'http', 'https', 'com', 'www', 'md', 'mjs'])
const INVALID_CUE_START = /^[-?:#&*!|>'\"%@`\[{,]/

function normalizeCues(cues) {
  if (!cues || typeof cues !== 'object' || Array.isArray(cues)) return undefined

  const normalized = {}
  for (const key of CUE_KEYS) {
    if (!Array.isArray(cues[key])) continue
    const values = cues[key]
      .filter(value => typeof value === 'string')
      .map(value => value.trim())
      .filter(value => value && value.length <= 200 && !/[\r\n\t]/.test(value) && !INVALID_CUE_START.test(value))
      .map(value => key === 'entities' ? value.toLowerCase() : value)
    const unique = [...new Set(values)]
    if (unique.length) normalized[key] = unique
  }
  return Object.keys(normalized).length ? normalized : undefined
}

function deriveCueEntities({ type, tags, name, description }) {
  const tagEntities = Array.isArray(tags)
    ? tags
      .filter(tag => typeof tag === 'string')
      .map(tag => tag.trim().toLowerCase())
      .filter(tag => tag && tag !== type.toLowerCase() && !GENERIC_CUE_TAGS.has(tag))
    : []
  const text = [name, description].filter(value => typeof value === 'string').join(' ')
  const textEntities = (text.match(/[a-z][a-z0-9._-]{2,}/gi) || [])
    .map(token => token.toLowerCase().replace(/[._-]+$/, ''))
    .filter(token => token.length >= 3 && !CUE_ENTITY_STOPWORDS.has(token))
  const cjkEntities = (text.match(/\p{Script=Han}+/gu) || [])
    .filter(run => {
      const length = [...run].length
      return length >= 2 && length <= 6
    })
  return [...new Set([...tagEntities, ...textEntities, ...cjkEntities])].slice(0, 12)
}

function detectCueCandidates(content) {
  const text = String(content || '').replace(/https?:\/\/\S+/g, ' ')
  const uniq = (values, limit) => [...new Set(
    values.map(v => v.replace(/^(?:\.\.?\/)+/, '').replace(/[.,;:)\]`]+$/, '').trim())
      .filter(v => v && v.length <= 120)
  )].slice(0, limit)
  const paths = uniq(
    text.match(/[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)+|\b[A-Za-z0-9_-]+\.(?:mjs|cjs|js|ts|tsx|md|json|ya?ml|sh|ps1|py|sql)\b/g) || [],
    8,
  )
  const tools = uniq(
    text.match(/\bmcp__[a-z0-9-]+__[a-z0-9_]+\b|\b[a-z0-9]+(?:-[a-z0-9]+)*-cli\b/gi) || [],
    6,
  )
  const cmds = uniq(
    (text.match(/\b(?:node|npx|npm|git|gh|curl|bash|python3?|codex|aliyun)\s+[^\s`][^`\n一-鿿　-〿＀-￯]{2,80}/g) || [])
      .flatMap(c => c.match(/[A-Za-z0-9_-]+\.(?:mjs|cjs|js|sh|ps1|py|bat)\b/g) || [])
      .map(v => v.toLowerCase()),
    5,
  )
  const out = {}
  if (paths.length) out.paths = paths
  if (tools.length) out.tools = tools
  if (cmds.length) out.cmds = cmds
  return out
}

const ADR_HOMES = ['docs/architecture', 'team-memory/decisions']

function findExistingAdrFiles(slug) {
  const wanted = `${slug.toLowerCase()}.md`
  const matches = []
  for (const dir of ADR_HOMES) {
    let entries = []
    try { entries = fs.readdirSync(path.join(ROOT, dir)) } catch { continue }
    const hit = entries.find(f => f.toLowerCase() === wanted)
    if (hit) matches.push(path.join(ROOT, dir, hit))
  }
  return matches
}

export function resolveAdrWritePath(slug) {
  const matches = findExistingAdrFiles(slug)
  return matches[0] || path.join(ROOT, 'docs/architecture', `${slug}.md`)
}

function resolveFilePath({ type, slug, finalScope, route, draft, updateTarget }) {
  if (updateTarget && /[\\/]/.test(String(updateTarget))) {
    if (draft) {
      throw new Error('update_target 与 draft 互斥：草稿模式不寻址既有文件')
    }
    const rel = String(updateTarget).replace(/\\/g, '/').replace(/^\.\//, '')
    if (path.isAbsolute(rel) || rel.split('/').includes('..') || !/^(team-memory|docs\/architecture)\/.+\.md$/.test(rel)) {
      throw new Error(`update_target 仅允许 team-memory/ 或 docs/architecture/ 下的仓内相对 .md 路径（收到: ${updateTarget}）`)
    }
    const target = path.join(ROOT, rel)
    if (!fs.existsSync(target)) {
      throw new Error(`update_target 指向的文件不存在: ${rel}。新建条目请去掉 update_target 走 type 路由。`)
    }
    return { filePath: target, assignedDir: path.dirname(target) }
  }
  if (draft) {
    const assignedDir = path.join(ROOT, 'team-memory/_drafts')
    return { filePath: path.join(assignedDir, `${type}_${slug}.md`), assignedDir }
  }
  const ringDir = resolveRingDirectory(finalScope, route)
  if (ringDir) {
    return { filePath: path.join(ringDir, `${slug}.md`), assignedDir: ringDir }
  }
  if ((finalScope === 'shared' || isLineScope(finalScope)) && !ringDir) {
    throw new Error(`type="${type}" 无团队路径，不能写入 scope=${finalScope}`)
  }
  if (type === 'decision' && /^adr-/i.test(slug)) {
    const matches = findExistingAdrFiles(slug)
    if (matches.length > 1) {
      const rels = matches.map(m => path.relative(ROOT, m).replace(/\\/g, '/'))
      throw new Error(`ADR slug "${slug}" 在两处均有既有文件（摘要卡/全文卡并存），无法判定更新目标。请加 update_target 显式指定其一：\n  ${rels.join('\n  ')}`)
    }
    if (matches.length === 1) return { filePath: matches[0], assignedDir: path.dirname(matches[0]) }
    const assignedDir = path.join(ROOT, 'docs/architecture')
    return { filePath: path.join(assignedDir, `${slug}.md`), assignedDir }
  }
  if (finalScope === 'team' && (route.path || route.team_path)) {
    const assignedDir = path.join(ROOT, route.path || route.team_path)
    return { filePath: path.join(assignedDir, `${slug}.md`), assignedDir }
  }
  if (finalScope === 'team' && !route.path && !route.team_path) {
    throw new Error(
      `type="${type}" 默认 personal scope、无团队路径；显式 scope:team 会静默落个人目录（团队不可见）。` +
      `团队知识请改用 type=rule|playbook|decision（slug=${slug}）。`
    )
  }
  return {
    filePath: path.join(PERSONAL_MEMORY_DIR, `${type}_${slug}.md`),
    assignedDir: PERSONAL_MEMORY_DIR,
  }
}

export async function remember({
  content,                  // 必填：memory 正文（markdown）
  type,                     // 必填：rule | playbook | decision | feedback | reference | incident | correction
  slug,                     // 必填：文件名 slug
  scope,                    // optional：'personal' | 'team'（默认按 type 路由）
  tags,
  cues,
  supersedes,               // 旧 memory id / file path
  lastCorrectedAt,     // ISO date or null（ADR-030 §3 Self-Reflex 字段）
  authoritativeSources,     // ADR-030 §3 Self-Reflex 字段
  lastVerified,             // YYYY-MM-DD「最后一次被实证确认」（2026-08-09 补）
  description,
  name,
  maturity,                 // optional：显式 maturity（仅允许 ≥ 旧值时生效）
  status,                   // optional：显式 status（同上）
  visibility,               // 'private' | 'department' | 'company'
  mode,                     // 'sandbox' | 'ranked'
  outputType,               // 'rule' | 'playbook' | 'adr' | 'commit' | 'review' | 'kg_entry'
  deptId,                   // 'AI' | 'Game' | 'QA' | 'Design' | 'BD'
  draft,                    // D4: true → 写 team-memory/_drafts/ 不入索引等 owner promote
  confirmNew,
  dedupReason,
  updateTarget,
  allowTierReview,
  tierReason,
  allowShrink,
}) {
  const hasExplicitCues = Object.hasOwn(arguments[0] || {}, 'cues')
  if (!content || !type || !slug) {
    throw new Error('content, type, slug 必填')
  }
  validateSlug(slug)
  const route = TYPE_ROUTING[type]
  if (!route) {
    throw new Error(`未知 type: ${type}（支持：${Object.keys(TYPE_ROUTING).join(', ')}）`)
  }
  const finalScope = normalizeScope(scope) || route.scope
  if (finalScope !== 'team' && !isCanonicalScope(finalScope)) {
    throw new Error(`未知 scope: ${finalScope}`)
  }
  const tierPatterns = loadTierPatterns()

  const now = new Date().toISOString()
  const agentId = process.env.KOS_AGENT_ID || process.env.CLAUDE_AGENT_ID || gitIdentityFallback() || 'unknown'
  const sessionId = process.env.CLAUDE_SESSION_ID || process.env.KOS_SESSION_ID || null
  const id = crypto
    .createHash('sha256')
    .update(`${type}:${slug}:${content}`)
    .digest('hex')
    .slice(0, 16)

  const resolvedTarget = resolveFilePath({ type, slug, finalScope, route, draft, updateTarget })
  const filePath = assertPathContained(resolvedTarget.assignedDir, resolvedTarget.filePath)

  let oldFm = {}
  let oldBody = ''
  let oldFmComments = {}
  let oldOrphanLines = []
  const exists = fs.existsSync(filePath)
  if (exists) {
    try {
      const oldText = fs.readFileSync(filePath, 'utf-8')
      const parsed = parseFrontmatter(oldText)
      oldFm = parsed.fm
      oldBody = parsed.body
      oldFmComments = parsed.comments
      oldOrphanLines = parsed.orphanLines
    } catch {
      oldFm = {}
      oldBody = ''
      oldFmComments = {}
      oldOrphanLines = []
    }
  }

  if (exists) {
    const shrink = inspectBodyShrink(oldBody, content)
    const bodyTooShort = shrink.ratio < 0.6
    if (shrink.missingHeadings.length || bodyTooShort) {
      const details = []
      if (shrink.missingHeadings.length) details.push(`缺失 ## 标题: ${shrink.missingHeadings.join('、')}`)
      if (bodyTooShort) {
        const reducedBy = Math.max(0, shrink.existingLength - shrink.incomingLength)
        details.push(`正文减少 ${reducedBy} 字符，长度 ${shrink.incomingLength}/${shrink.existingLength}（${Math.round(shrink.ratio * 100)}%，低于 60%）`)
      }
      if (!allowShrink) {
        throw new Error(`BLOCKED: UPDATE 可能截断现有正文；${details.join('；')}。确认有意删除时加 --allow-shrink`)
      }
      console.error(`[kos_remember] ⚠️ --allow-shrink 已启用，允许删除：${details.join('；')}`)
    }
  }

  const maturityGate = gateMaturity(maturity, oldFm.maturity)
  if (maturityGate.original !== undefined) {
    const statusHint = maturityGate.status ? `；status: ${maturityGate.status}` : ''
    console.warn(`[kos-remember] ⚠️ maturity: ${maturityGate.original} → ${maturityGate.maturity}${statusHint}（规范枚举：draft | verified | proven）`)
  }

  const provided = {}
  if (name !== undefined) provided.name = name
  if (description !== undefined) provided.description = description
  provided.type = type
  provided.scope = finalScope
  if (tags !== undefined) provided.tags = tags
  const normalizedCues = normalizeCues(cues)
  if (hasExplicitCues) provided.cues = normalizedCues || {}
  if (supersedes !== undefined) provided.supersedes = supersedes
  if (lastCorrectedAt !== undefined) provided.last_corrected_at = lastCorrectedAt
  if (authoritativeSources !== undefined) provided.authoritative_sources = authoritativeSources
  if (lastVerified !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lastVerified))) {
      throw new Error(`BLOCKED: lastVerified 必须是 YYYY-MM-DD（收到「${String(lastVerified).slice(0, 30)}」）——时效判断靠它，坏格式会静默失效`)
    }
    provided.last_verified = lastVerified
  }
  if (maturity !== undefined) provided.maturity = maturityGate.maturity
  if (status !== undefined) provided.status = status
  if (maturityGate.status !== undefined) provided.status = maturityGate.status
  if (visibility !== undefined) provided.visibility = visibility
  if (mode !== undefined) provided.mode = mode
  if (outputType !== undefined) provided.output_type = outputType
  if (deptId !== undefined) provided.dept_id = deptId

  const merged = { ...oldFm, ...provided }

  if (!merged.name) merged.name = slug
  if (!merged.description) merged.description = `${type} · ${slug}`
  if (!merged.tags) merged.tags = []
  if (!merged.created) merged.created = now.slice(0, 10)
  if (!exists) merged.written_by = { agent_id: agentId, session_id: sessionId, ts: now }
  merged.id = id

  const tierReasonText = typeof tierReason === 'string' ? tierReason.trim() : ''
  if (allowTierReview && (!tierReasonText || tierReasonText.startsWith('--'))) {
    throw new Error('BLOCKED: --allow-tier-review 必须同时提供 --tier-reason "<why>"')
  }
  const tierScanText = `${content}\n${merged.name}\n${merged.description}`
  const tierMatches = findTierMatches(tierPatterns, tierScanText)
  if (tierMatches.length && !allowTierReview) {
    const matched = tierMatches.map(pattern => `${pattern.label} /${pattern.source}/${pattern.flags || ''}`).join('；')
    throw new Error(`BLOCKED: 命中 Core/Restricted 分级词表：${matched}。敏感度先行——Core/Restricted 永不进 KOS`)
  }
  if (allowTierReview) {
    merged.tier_review_reason = tierReasonText
    const matched = tierMatches.length
      ? tierMatches.map(pattern => pattern.label).join('、')
      : '未命中词表（主动复核）'
    console.error(`[kos_remember] 🚨 TIER REVIEW OVERRIDE：${matched}；原因：${tierReasonText}`)
  }

  const cuesIsRaw = isRawFmValue(merged.cues)
  let mergedCues = null
  if (!cuesIsRaw) {
    mergedCues = normalizeCues(merged.cues)
    if (mergedCues) {
      merged.cues = mergedCues
    } else {
      delete merged.cues
    }
    if (!hasExplicitCues) {
      const derivedEntities = deriveCueEntities({
        type,
        tags: merged.tags,
        name: merged.name,
        description: merged.description,
      })
      const entities = [...new Set([...(merged.cues?.entities || []), ...derivedEntities])].slice(0, 12)
      if (entities.length) {
        merged.cues = { ...(merged.cues || {}), entities }
      }
    }
  }

  if (oldFm.maturity == null && provided.maturity == null) {
    merged.maturity = 'draft'
    console.warn('[kos-remember] ⚠️ maturity 未显式提供，默认 draft（召回降权 0.7 + ⚠️未实证标记）。有实证请显式标 verified。')
  }
  if (!maturityGate.superseded && provided.maturity !== undefined && oldFm.maturity !== undefined) {
    if (rankOf(MATURITY_RANK, provided.maturity) < rankOf(MATURITY_RANK, oldFm.maturity)) {
      merged.maturity = oldFm.maturity
    }
  }
  if (!maturityGate.superseded && provided.status !== undefined && oldFm.status !== undefined) {
    if (rankOf(STATUS_RANK, provided.status) < rankOf(STATUS_RANK, oldFm.status)) {
      merged.status = oldFm.status
    }
  }

  const HEAD_ORDER = [
    'name', 'description', 'type', 'scope', 'tags', 'cues',
    'created', 'written_by', 'id', 'supersedes',
    'last_corrected_at', 'authoritative_sources',
    'tier_review_reason',
    'maturity', 'status',
    'visibility', 'mode', 'output_type', 'dept_id',
  ]
  const orderedKeys = []
  for (const k of HEAD_ORDER) {
    if (merged[k] !== undefined) orderedKeys.push(k)
  }
  for (const k of Object.keys(merged)) {
    if (!orderedKeys.includes(k) && merged[k] !== undefined) orderedKeys.push(k)
  }

  const fmLines = []
  const emittedCommentKeys = new Set()
  for (const k of orderedKeys) {
    if (oldFmComments[k]) {
      fmLines.push(...oldFmComments[k])
      emittedCommentKeys.add(k)
    }
    fmLines.push(...serializeFmField(k, merged[k]))
  }
  for (const [k, commentLines] of Object.entries(oldFmComments)) {
    if (!emittedCommentKeys.has(k)) fmLines.push(...commentLines)
  }
  fmLines.push(...oldOrphanLines)
  const fmYaml = '---\n' + fmLines.join('\n') + '\n---\n\n'
  const body = fmYaml + content

  if (['rule', 'playbook'].includes(type) && isRepositoryScope(finalScope) && !draft && process.env.KOS_SENTINEL_GATE !== 'off') {
    const findings = scanContent(body).findings
    const fatal = findings.filter(finding => finding.severity === 'fatal')
    const warnings = findings.filter(finding => finding.severity === 'warn')
    if (fatal.length) {
      const details = fatal.map(finding => `L${finding.line} ${finding.rule}: ${finding.excerpt}`).join('\n')
      const err = new Error(`KOS_SENTINEL_GATE: 检测到 ${fatal.length} 条 fatal 内容\n${details}\n如确认可接受，显式设置 KOS_SENTINEL_GATE=off 覆盖。`)
      err.code = 'KOS_SENTINEL_GATE'
      err.findings = findings
      throw err
    }
    for (const finding of warnings) {
      console.error(`[kos-remember] sentinel warn L${finding.line} ${finding.rule}: ${finding.excerpt}`)
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const action = exists ? 'updated' : 'created'

  const GATE = process.env.KOS_DEDUP_GATE
  let hintCandidates = []
  if (!exists && isRepositoryScope(finalScope) && GATE !== 'off' && !confirmNew && !supersedes && !updateTarget) {
    const rel = path.relative(ROOT, filePath).replace(/\\/g, '/')
    const tau = Number(process.env.KOS_DEDUP_THRESHOLD || '0.60')
    const dup = await checkDuplicate({ type, slug, name: merged.name, description: merged.description, content, rel, threshold: tau })
    hintCandidates = dup.hint_candidates || []
    if (dup.candidates && dup.candidates.length) {
      const err = new Error('KOS_DEDUP_GATE')
      err.code = 'KOS_DEDUP_GATE'; err.candidates = dup.candidates; err.maxScore = dup.maxScore; err.attempted = { type, slug }
      throw err
    }
  }

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}-${crypto.randomUUID()}.tmp`,
  )
  try {
    fs.writeFileSync(tempPath, body, 'utf-8')

    const writtenBody = fs.readFileSync(tempPath, 'utf-8')
    if (writtenBody !== body) {
      throw new Error(`Post-write verification failed for ${filePath}: read-back content differs`)
    }

    fs.renameSync(tempPath, filePath)
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath)
    }
  }

  let cuesWarning = null
  const cuesWarnLevel = { rule: 'strong', playbook: 'strong', decision: 'light' }[type]
  if (cuesWarnLevel && !cuesIsRaw && process.env.KOS_CUES_WARN !== 'off') {
    const hasStrongCues = !!mergedCues && ['paths', 'tools', 'cmds'].some(key => (mergedCues[key] || []).length > 0)
    const hasExplicitNonEmpty = hasExplicitCues && !!normalizedCues
    if (!hasStrongCues && !hasExplicitNonEmpty) {
      const candidates = detectCueCandidates(content)
      if (merged.cues?.entities?.length) candidates.entities = merged.cues.entities
      cuesWarning = { level: cuesWarnLevel, candidates }
      const example = '"cues": { "paths": ["scripts/kos/kos-recall.mjs"], "tools": ["mcp__kos__kos_remember"], "cmds": ["node scripts/kos/kos-recall.mjs --query <X>"], "entities": ["召回", "cues"] }'
      if (cuesWarnLevel === 'strong') {
        const lines = [
          `[kos-remember] 🚨 cues 缺失：type=${type} 是机械召回主力卡型，没有 paths/tools/cmds 就只能靠语义检索兜底（2026-08-02 诊断：全库 651 卡仅 3 张带 cues，机械通道饿死中）。`,
        ]
        const detected = ['paths', 'tools', 'cmds'].filter(key => (candidates[key] || []).length > 0)
        if (detected.length) {
          lines.push('  正文自动探测到候选（确认相关后建议直接采纳进 cues 字段）：')
          for (const key of detected) lines.push(`    ${key}: ${candidates[key].join('  |  ')}`)
        } else {
          lines.push('  正文未探测到明显候选——请人工补「哪些文件路径/工具/命令出现时该召回这张卡」。')
        }
        if ((candidates.entities || []).length) lines.push(`    entities（已自动兜底写入 frontmatter）: ${candidates.entities.join('  |  ')}`)
        lines.push(`  cues 字段格式（--from-json 顶层，paths/tools/cmds/entities 四键均选填）：${example}`)
        lines.push('  （warn 模式不阻断写入；KOS_CUES_WARN=off 可临时关闭）')
        console.error(lines.join('\n'))
      } else {
        console.error(`[kos-remember] ⚠️ cues 缺失：decision 卡建议补 cues 提升机械召回命中。格式（四键均选填）：${example}`)
      }
    }
  }

  for (const hint of hintCandidates) {
    const hintSlug = hint.slug || '(unknown)'
    console.error(`[kos_remember] 提示: 与既有条目相近 (cosine ${Number(hint.score || 0).toFixed(2)}): ${hintSlug} — 若为演化/纠正请 --supersedes ${hintSlug}; 若为补充请正文 [[${hintSlug}]] 关联; 时序更替/细化不算重复, 可忽略本提示`)
  }

  try {
    fs.mkdirSync(path.dirname(METRIC_PATH), { recursive: true })
    fs.appendFileSync(
      METRIC_PATH,
      JSON.stringify({
        ts: now,
        tool: 'kos_remember',
        agent_id: agentId,
        session_id: sessionId,
        cwd: process.cwd(),
        args: { type, slug, scope: finalScope, supersedes: supersedes || null },
        action,
        file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
        id,
        ok: true,
      }) + '\n',
      'utf-8'
    )
  } catch {}

  try { await upsertEntry({ rel: path.relative(ROOT, filePath).replace(/\\/g, '/'), slug, type, name: merged.name, description: merged.description, content }) } catch {}

  let kgRefresh = null
  if (isRepositoryScope(finalScope) && filePath.startsWith(ROOT)) {
    kgRefresh = scheduleKgRefresh(filePath)
  }

  return { id, location: filePath, status: action, scope: finalScope, kgRefresh, hint_candidates: hintCandidates, ...(cuesWarning ? { cues_warning: cuesWarning } : {}) }
}


const SEDIMENT_TYPE_HEURISTICS = [
  { re: /\bADR-(\d+)\b/i,           type: 'decision', slugFn: (m, d) => `adr-${m[1]}` },
  { re: /\biron\s+rule\s+#?(\d+)/i, type: 'rule',     slugFn: (m, d) => `iron-${m[1]}` },
  { re: /\blesson:/i,               type: 'feedback', slugFn: (m, d) => `lesson-${d}` },
  { re: /教训/,                      type: 'feedback', slugFn: (m, d) => `lesson-${d}` },
  { re: /\bfix-class\b/i,           type: 'playbook', slugFn: (m, d) => `fix-class-${d}` },
  { re: /\bmilestone\b|里程碑/,       type: 'decision', slugFn: (m, d) => `milestone-${d}` },
  { re: /\bdogfood\s+闭环\b/i,       type: 'decision', slugFn: (m, d) => `dogfood-${d}` },
]

function readFlagValue(args, flag) {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

function printDedupBlocked(err) {
  console.error(`[kos_remember] BLOCKED: ${err.candidates.length} 条既有条目语义相近 (max cosine ${Number(err.maxScore || 0).toFixed(3)}). 这可能是重复。`)
  for (const c of err.candidates) {
    console.error(`  - ${c.slug} (${c.type}) cosine=${Number(c.score || 0).toFixed(3)}`)
  }
  console.error('解决: 用 --supersedes <id> 取代旧条目 / 改写 type+slug 为既有 slug 做 UPDATE / 确为新概念则加 --confirm-new --dedup-reason "<why distinct>"')
}

async function exitDedupBlocked(err) {
  printDedupBlocked(err)
  await new Promise((resolve) => setTimeout(resolve, 25))
  process.exit(3)
}

async function runFromCommit(args) {
  const hash = (args[0] && !args[0].startsWith('--')) ? args[0] : 'HEAD'
  const writeFlag = args.includes('--write')
  const draftMode = !writeFlag  // default draft on (不需 dry-run/write 二元抉择)
  const confirmNew = args.includes('--confirm-new')
  const dedupReason = readFlagValue(args, '--dedup-reason')
  const allowTierReview = args.includes('--allow-tier-review')
  const tierReason = readFlagValue(args, '--tier-reason')
  const allowShrink = args.includes('--allow-shrink')

  let log = ''
  try {
    log = execSync(`git log -1 ${hash} --format=%H%x00%an%x00%ai%x00%s%x00%b`, {
      encoding: 'utf-8', cwd: ROOT,
    })
  } catch (err) {
    console.error(`[kos_remember --from-commit] git log failed: ${err.message}`)
    process.exit(1)
  }
  const [fullHash, author, date, subject, ...bodyParts] = log.split('\x00')
  const body = bodyParts.join('\x00').trim()
  const dateOnly = (date || '').slice(0, 10)
  const fullMsg = `${subject || ''}\n${body}`

  let detected = null
  for (const h of SEDIMENT_TYPE_HEURISTICS) {
    const m = fullMsg.match(h.re)
    if (m) { detected = { type: h.type, slug: h.slugFn(m, dateOnly) }; break }
  }
  if (!detected) {
    console.error(`[kos_remember --from-commit] 无法推断 type/slug from commit ${hash.slice(0,12)} msg. 显式用 --from-json 指定 type/slug.`)
    process.exit(1)
  }

  const content = `${body || subject}\n\n<!-- source: commit ${(fullHash || hash).slice(0, 12)} by ${author || 'unknown'} on ${dateOnly} -->\n`
  const result = await remember({
    content, type: detected.type, slug: detected.slug, draft: draftMode, confirmNew, dedupReason,
    allowTierReview, tierReason, allowShrink,
  })
  console.log(JSON.stringify({ ...result, draft: draftMode, derived: detected }, null, 2))
}

function runQuick(type, slug, draftFlag, confirmNew, dedupReason, allowTierReview, tierReason, allowShrink) {
  const chunks = []
  process.stdin.on('data', c => chunks.push(c))
  process.stdin.on('end', async () => {
    const content = Buffer.concat(chunks).toString('utf-8').trim()
    if (!content) {
      console.error('[kos_remember --quick] stdin 为空, 必须 pipe content (e.g. `echo "x" | ...`)')
      process.exit(1)
    }
    try {
      const result = await remember({
        content, type, slug, draft: draftFlag, confirmNew, dedupReason,
        allowTierReview, tierReason, allowShrink,
      })
      console.log(JSON.stringify(result, null, 2))
    } catch (err) {
      if (err.code === 'KOS_DEDUP_GATE') {
        await exitDedupBlocked(err)
        return
      }
      console.error(`[kos_remember --quick] ${err.message}`)
      process.exit(1)
    }
  })
}

const TEMPLATES = {
  incident:   { type: 'incident',   slug: 'incident-YYYY-MM-DD-TODO', content: '## 现象\n\n## 根因\n\n## 修复\n\n## 复发反射\n' },
  rule:       { type: 'rule',       slug: 'TODO',                     content: '## 规则\n\n## 触发\n\n## 反 pattern\n\n## 例外\n' },
  playbook:   { type: 'playbook',   slug: 'TODO',                     content: '## 触发场景\n\n## 步骤\n\n## 验收\n\n## 反例\n' },
  decision:   { type: 'decision',   slug: 'TODO',                     content: '## 决策\n\n## 替代方案\n\n## 理由\n\n## 实施\n' },
  feedback:   { type: 'feedback',   slug: 'TODO',                     content: 'one-line gist' },
  correction: { type: 'correction', slug: 'correction-TODO',          content: '## 错误\n\n## 正确\n\n## 反射\n' },
}
function runFromTemplate(name) {
  const t = TEMPLATES[name]
  if (!t) {
    console.error(`[kos_remember --from-template] 未知 template: ${name}. 支持: ${Object.keys(TEMPLATES).join(', ')}`)
    process.exit(1)
  }
  console.log(JSON.stringify(t, null, 2))
}

function verifyRoutes() {
  const teamMemoryDir = path.join(ROOT, 'team-memory')
  const declaredDirs = new Set([
    ...Object.values(TYPE_ROUTING)
      .flatMap(route => [route.path, route.team_path])
      .filter(Boolean)
      .map(routePath => path.basename(routePath)),
    ...Object.keys(ROUTE_MANIFEST.legacy_dirs || {}),
    ...Object.keys(ROUTE_MANIFEST.non_memory_dirs || {}),
  ])
  const actualDirs = fs.readdirSync(teamMemoryDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => fs.readdirSync(path.join(teamMemoryDir, entry.name), { withFileTypes: true })
      .some(child => child.isFile() && child.name.endsWith('.md')))
    .map(entry => entry.name)
  const undeclared = actualDirs.filter(dir => !declaredDirs.has(dir)).sort()
  const missing = [...declaredDirs].filter(dir => !fs.existsSync(path.join(teamMemoryDir, dir))).sort()

  for (const dir of undeclared) {
    console.error(`Undeclared directory: ${dir}`)
  }
  for (const dir of missing) {
    console.warn(`Warning: declared directory does not exist: ${dir}`)
  }
  if (undeclared.length) {
    process.exit(1)
  }
  console.log(`OK: ${declaredDirs.size} dirs declared, 0 undeclared`)
}

const invokedPath = process.argv[1] ? url.pathToFileURL(process.argv[1]).href : ''
const isCli = import.meta.url === invokedPath

if (isCli) {
  const argv = process.argv.slice(2)
  const flag = argv[0]
  const draftFlag = argv.includes('--draft')
  const confirmNew = argv.includes('--confirm-new')
  const dedupReason = readFlagValue(argv, '--dedup-reason')
  const allowTierReview = argv.includes('--allow-tier-review')
  const tierReason = readFlagValue(argv, '--tier-reason')
  const allowShrink = argv.includes('--allow-shrink')

  if (flag === '--verify-routes') {
    verifyRoutes()
  } else if (flag === '--from-json' && argv[1]) {
    try {
      const json = JSON.parse(fs.readFileSync(argv[1], 'utf-8'))
      if (draftFlag) json.draft = true  // D4 --draft override
      if (json.confirm_new !== undefined) json.confirmNew = json.confirm_new
      if (json.dedup_reason !== undefined) json.dedupReason = json.dedup_reason
      if (json.update_target !== undefined) json.updateTarget = json.update_target
      if (json.allow_tier_review !== undefined) json.allowTierReview = json.allow_tier_review
      if (json.tier_reason !== undefined) json.tierReason = json.tier_reason
      if (json.allow_shrink !== undefined) json.allowShrink = json.allow_shrink
      if (confirmNew) json.confirmNew = true
      if (dedupReason !== undefined) json.dedupReason = dedupReason
      if (allowTierReview) json.allowTierReview = true
      if (tierReason !== undefined) json.tierReason = tierReason
      if (allowShrink) json.allowShrink = true
      const result = await remember(json)
      console.log(JSON.stringify(result, null, 2))
      process.exit(0)
    } catch (err) {
      if (err.code === 'KOS_DEDUP_GATE') {
        await exitDedupBlocked(err)
      } else {
        console.error(`[kos_remember] error: ${err.message}`)
        process.exit(1)
      }
    }
  } else if (flag === '--from-commit') {
    try {
      await runFromCommit(argv.slice(1))
    } catch (err) {
      if (err.code === 'KOS_DEDUP_GATE') {
        await exitDedupBlocked(err)
      } else {
        throw err
      }
    }
  } else if (flag === '--quick' && argv[1] && argv[2]) {
    runQuick(argv[1], argv[2], draftFlag, confirmNew, dedupReason, allowTierReview, tierReason, allowShrink)
  } else if (flag === '--from-template' && argv[1]) {
    runFromTemplate(argv[1])
  } else {
    console.log('Usage:')
    console.log('  node kos-remember.mjs --from-json <input.json>           (原 mode, 完整 JSON)')
    console.log('  node kos-remember.mjs --from-commit [<hash>] [--write]   (D1: 自动 derive type/slug from commit, default --draft)')
    console.log('  echo "<content>" | node kos-remember.mjs --quick <type> <slug> [--draft]  (D2: stdin 读 content)')
    console.log('  node kos-remember.mjs --from-template <name>             (D3: 打印 JSON 模板, name = incident|rule|playbook|decision|feedback|correction)')
    console.log('  node kos-remember.mjs --verify-routes                    (检查 team-memory 目录与路由清单一致性)')
    console.log('')
    console.log('--draft (D4): 写到 team-memory/_drafts/ 不入正式 KOS 索引, 等 owner promote (2026-05-26 propose, sediment-hooks plan §D 采纳)')
    console.log('--confirm-new --dedup-reason "<why>": 语义相近但确认为新概念时绕过去重闸')
    console.log('--allow-tier-review --tier-reason "<why>": 人工复核后覆盖分级词表闸，并记录原因')
    console.log('--allow-shrink: UPDATE 时确认允许删除既有章节或将正文缩短到 60% 以下')
    console.log('')
    console.log('--from-json input.json fields:')
    console.log('  content (string, required)               memory 正文 markdown')
    console.log('  type (enum, required)                    rule | playbook | decision | feedback | reference | incident | correction')
    console.log('  slug (string, required)                  文件名 slug')
    console.log('  scope (enum, optional)                   personal | team（默认按 type 路由）')
    console.log('  tags (array, optional)                   tag 列表')
    console.log('  cues (object, optional)                  paths | tools | cmds | entities string arrays')
    console.log('  supersedes (string, optional)            旧 memory id / file path')
    console.log('  lastCorrectedAt (date, optional)    Self-Reflex 字段')
    console.log('  authoritativeSources (array, optional)   Self-Reflex 字段')
    console.log('  lastVerified (YYYY-MM-DD, optional)      最后一次实证确认日期')
    console.log('  description / name (string, optional)    frontmatter 字段覆盖')
    console.log('  maturity / status (string, optional)     强字段（不允许降级）')
    console.log('  visibility (enum, optional)              private | department | company (ADR-034)')
    console.log('  mode (enum, optional)                    sandbox | ranked (ADR-034)')
    console.log('  outputType (enum, optional)              rule | playbook | adr | commit | review | kg_entry (ADR-034)')
    console.log('  deptId (enum, optional)                  AI | Game | QA | Design | BD (ADR-034)')
    console.log('  draft (bool, optional)                   true → 写 _drafts/ (D4, sediment-hooks plan §D)')
    console.log('  update_target (string, optional)         含 / 时 = 仓内相对路径显式覆盖写入目标（限 team-memory/ 与 docs/architecture/ 下已存在 .md；ADR 摘要卡/全文卡并存时必填）；裸 slug 仅跳过去重闸')
    console.log('  allow_tier_review / tier_reason          分级词表闸复核覆盖及必填原因')
    console.log('  allow_shrink (bool, optional)            UPDATE 正文截断闸覆盖')
    process.exit(argv.length === 0 ? 0 : 1)
  }
}
