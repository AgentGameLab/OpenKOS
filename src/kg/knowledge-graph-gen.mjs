#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..')
const TEAM_MEMORY = path.join(ROOT, 'team-memory')
const CODE_REPO_ROOT = process.env.KOS_CODE_REPO ? path.resolve(process.env.KOS_CODE_REPO) : null
const CODE_REPO_SRC = CODE_REPO_ROOT ? path.join(CODE_REPO_ROOT, 'src') : null
const CODE_REPO_NODE_CAP = 1500  // bounded to keep graph generation predictable as repositories grow
const OUTPUT_JSON = path.join(TEAM_MEMORY, '.knowledge-graph.json')
const OUTPUT_DOT = path.join(TEAM_MEMORY, '.knowledge-graph.dot')
const SNAPSHOT_DIR = path.join(TEAM_MEMORY, '.knowledge-graph.snapshots')
const CODE_REPO_CACHE = path.join(SNAPSHOT_DIR, '.code-repo-cache.json')
const ASI_KG_COVERAGE = path.join(ROOT, '.asi', 'kg-coverage.jsonl')
const ASI_KG_CHANNEL_AUDIT = path.join(ROOT, '.asi', 'kg-channel-audit.jsonl')
const ROOT_GITIGNORE = path.join(ROOT, '.gitignore')
const SCRIPTS_ROOT = path.join(ROOT, 'scripts')
const DAEMON_ACTIONS_ROOT = path.join(ROOT, 'daemon-actions')
const SCHEDULER_CONFIG = path.join(SCRIPTS_ROOT, 'scheduler-config.json')
const ZONE_CONFIG = path.join(ROOT, '.claude', 'hooks', 'zone-config.json')
const DS_SUPABASE = /createServiceClient\s*\(|createAdminClient\s*\(|supabase\.from\s*\(|from ['"]@supabase\/supabase-js['"]/
const DS_DRIZZLE = /createDb\s*\(|\bdrizzle\s*\(|from ['"]drizzle-orm|from ['"]@\/lib\/db['"]/

const SCRIPT_EXCLUDE_IDS = new Set([
  'scripts/kg/queries/_lib.mjs',
])
const SCRIPT_EXCLUDE_PREFIXES = [
  'scripts/lib/asi-resources/__tests__/',
]
const TARGET_DIRS = ['rules', 'playbooks', 'decisions', 'pointers']
const CORE_DOCS = [
  'docs/team-workflow.md',
  'docs/memory-protocol.md',
  'docs/cga2a-architecture.md',
  'docs/agent-runtime-protocol.md',
  'docs/gai-protocol.md',
]
const TARGET_FIELDS = new Set([
  'name',
  'type',
  'maturity',
  'status',
  'supersedes',
  'superseded_by',
  'related',
  'authoritative_sources',
  'last_verified',
  'created',
  'topic',
  'audience',
  'paths',
  'deciders',
  'governs_paths',
])
const LIST_FIELDS = new Set(['supersedes', 'superseded_by', 'related', 'authoritative_sources', 'paths', 'deciders', 'governs_paths'])
const MATURITY_COLORS = {
  proven: '#c9f2c7',
  verified: '#cfe7ff',
  draft: '#e1e1e1',
}
const REFERENCE_TARGET_TYPES = new Set(['rule', 'playbook', 'decision', 'rule-paths-scoped', 'script'])

const { dryRun, maxDepth, diffDate, quiet, includeCodeRepo } = parseArgs(process.argv.slice(2))

main()

function main() {
  const docs = loadDocs()
  const codeRepo = loadCodeRepoArtifacts()
  const resolver = createResolver(docs)
  const graph = buildGraph(docs, resolver, codeRepo)
  const snapshotPath = path.join(SNAPSHOT_DIR, `${getDateStamp(new Date())}.json`)

  if (!dryRun) {
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(graph.json, null, 2) + '\n', 'utf8')
    fs.writeFileSync(OUTPUT_DOT, buildDot(graph), 'utf8')
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })
    fs.writeFileSync(snapshotPath, JSON.stringify(graph.json, null, 2) + '\n', 'utf8')
    ensureGitignoreEntry('/team-memory/.knowledge-graph.snapshots/')
    if (codeRepo.cache) {
      fs.writeFileSync(CODE_REPO_CACHE, JSON.stringify(codeRepo.cache, null, 2) + '\n', 'utf8')
    }
    const daemonRuntimeCount = docs.filter(d => d.kind === 'daemon-runtime').length
    const messageEmitterCount = docs.filter(d => d.type === 'message-emitter').length
    const coverageLine = JSON.stringify({
      ts: new Date().toISOString(),
      total_nodes: graph.nodes.length,
      daemon_runtime_files: daemonRuntimeCount,
      message_emitter_count: messageEmitterCount,
    }) + '\n'
    try { fs.appendFileSync(ASI_KG_COVERAGE, coverageLine, 'utf8') } catch { /* .asi may not exist */ }
    appendChannelAuditMetric(graph.json)
  }

  if (quiet) return  // lazy regen 调用方不需要 stdout

  let report = renderReport(graph, { dryRun, maxDepth, snapshotPath })
  if (diffDate) report += renderSnapshotDelta(diffDate, graph.json)
  console.log(report)
}

function parseArgs(argv) {
  let dryRun = false
  let maxDepth = Infinity
  let diffDate = null
  let quiet = false
  let includeCodeRepo = true

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--quiet') quiet = true
    else if (arg === '--no-code-repo') includeCodeRepo = false
    else if (arg === '--max-depth') {
      const value = Number(argv[i + 1])
      if (Number.isFinite(value) && value >= 0) maxDepth = value
      i += 1
    } else if (arg.startsWith('--max-depth=')) {
      const value = Number(arg.slice('--max-depth='.length))
      if (Number.isFinite(value) && value >= 0) maxDepth = value
    } else if (arg === '--diff') {
      diffDate = argv[i + 1] || null
      i += 1
    } else if (arg.startsWith('--diff=')) {
      diffDate = arg.slice('--diff='.length) || null
    }
  }

  return { dryRun, maxDepth, diffDate, quiet, includeCodeRepo }
}

function appendChannelAuditMetric(graph) {
  const asiDir = path.dirname(ASI_KG_CHANNEL_AUDIT)
  if (!fs.existsSync(asiDir)) {
    console.warn(`[kg] ASI mirror dir missing, skip channel audit metric: ${asiDir}`)
    return
  }

  try {
    const rows = computeChannelAuditRows(graph)
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      total_emitters: rows.length,
      suspect_count: rows.filter(row => row.suspect === 'yes').length,
    }) + '\n'
    fs.appendFileSync(ASI_KG_CHANNEL_AUDIT, line, 'utf8')
  } catch (err) {
    console.warn(`[kg] channel audit metric skipped: ${err.message}`)
  }
}

function computeChannelAuditRows(graph) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph.edges) ? graph.edges : []
  const byId = new Map(nodes.map(node => [node.id, node]))
  const zoneById = loadZoneNameById()
  const hostByEmitter = new Map()
  const cronScopesByScript = new Map()

  for (const edge of edges) {
    if (edge.label === 'emits-from') hostByEmitter.set(edge.from, edge.to)
    if (edge.label !== 'triggers') continue
    const cronNode = byId.get(edge.from)
    if (!cronNode || cronNode.type !== 'cron-task') continue
    if (!cronScopesByScript.has(edge.to)) cronScopesByScript.set(edge.to, new Set())
    cronScopesByScript.get(edge.to).add(cronNode.scope || 'N/A')
  }

  return nodes
    .filter(node => node.type === 'message-emitter')
    .map(node => {
      const host = hostByEmitter.get(node.id) || node.host_script || ''
      const scopes = [...(cronScopesByScript.get(host) || [])].sort()
      const scope = scopes.length > 0 ? scopes.join(',') : 'N/A'
      const target = node.target_kind === 'zone'
        ? (zoneById.get(node.target_value) || node.target_value || 'unresolved')
        : (node.target_value || 'unresolved')
      return {
        scope,
        target,
        suspect: scope.split(',').includes('per-node') && target === 'hq-managers' ? 'yes' : 'no',
      }
    })
}

function loadZoneNameById() {
  const out = new Map()
  if (!fs.existsSync(ZONE_CONFIG)) return out
  try {
    const parsed = JSON.parse(fs.readFileSync(ZONE_CONFIG, 'utf8'))
    for (const [name, config] of Object.entries(parsed)) {
      if (config?.id) out.set(config.id, name)
    }
  } catch {}
  return out
}

function loadDocs() {
  const docs = [
    ...loadTeamMemoryDocs(),
    ...loadSkillDocs(),
    ...loadArchitectureDecisions(),
    ...loadCoreDocs(),
    ...loadScripts(),
    ...loadCronTasks(),
    ...loadMessageEmitters(),
    ...loadHooks(),
    ...loadPathScopedRules(),
    ...loadDaemonRuntimeFiles(),
  ]

  return docs.sort((a, b) => a.id.localeCompare(b.id))
}

function loadTeamMemoryDocs() {
  const docs = []

  for (const dir of TARGET_DIRS) {
    for (const file of walkMd(path.join(TEAM_MEMORY, dir))) {
      const raw = fs.readFileSync(file, 'utf8')
      const fm = parseFrontmatter(raw)
      if (!fm) continue

      docs.push({
        id: toRepoRel(file),
        name: fm.name || findFirstHeading(raw) || path.basename(file, '.md'),
        type: mapTeamMemoryType(dir),
        declared_type: fm.type || null,
        maturity: fm.maturity || null,
        status: fm.status || null,
        topic: fm.topic || null,
        last_verified: fm.last_verified || null,
        created: fm.created || null,
        supersedes: toArray(fm.supersedes),
        superseded_by: toArray(fm.superseded_by),
        related: toArray(fm.related),
        authoritative_sources: toArray(fm.authoritative_sources),
        audience: fm.audience || null,
        paths: toArray(fm.paths),
        governs_paths: toArray(fm.governs_paths),
        body: stripFrontmatter(raw),
        stem: path.basename(file, '.md'),
      })
    }
  }

  return docs
}

function loadSkillDocs() {
  const docs = []

  for (const file of walkNamedFile(path.join(ROOT, 'skills'), 'SKILL.md')) {
    const raw = fs.readFileSync(file, 'utf8')
    const fm = parseFrontmatter(raw) || {}
    const rel = toRepoRel(file)
    const internal = isInternalSkillPath(rel)
    const skillDir = path.dirname(rel)

    docs.push({
      id: rel,
      name: fm.name || skillDir.replace(/^skills\//, ''),
      type: internal ? 'skill-internal' : 'skill',
      declared_type: fm.type || null,
      maturity: fm.maturity || null,
      status: fm.status || null,
      topic: fm.topic || null,
      last_verified: fm.last_verified || null,
      created: fm.created || null,
      supersedes: [],
      superseded_by: [],
      related: [],
      authoritative_sources: [],
      audience: fm.audience || null,
      paths: [],
      body: stripFrontmatter(raw),
      stem: path.basename(skillDir),
    })
  }

  return docs
}

function loadArchitectureDecisions() {
  const docs = []
  const archDir = path.join(ROOT, 'docs', 'architecture')

  for (const file of walkMd(archDir)) {
    if (!/^adr-.*\.md$/i.test(path.basename(file))) continue
    const raw = fs.readFileSync(file, 'utf8')
    const fm = parseFrontmatter(raw) || {}

    docs.push({
      id: toRepoRel(file),
      name: fm.name || fm.title || findFirstHeading(raw) || path.basename(file, '.md'),
      type: 'decision',
      declared_type: fm.type || null,
      maturity: fm.maturity || null,
      status: fm.status || null,
      topic: fm.topic || null,
      last_verified: fm.last_verified || null,
      created: fm.created || fm.date || null,
      supersedes: toArray(fm.supersedes),
      deciders: toArray(fm.deciders),
      superseded_by: toArray(fm.superseded_by),
      related: toArray(fm.related),
      authoritative_sources: toArray(fm.authoritative_sources),
      audience: null,
      paths: [],
      body: stripFrontmatter(raw),
      stem: path.basename(file, '.md'),
    })
  }

  return docs
}

function loadCoreDocs() {
  return CORE_DOCS
    .map(rel => path.join(ROOT, ...rel.split('/')))
    .filter(file => fs.existsSync(file))
    .map(file => {
      const raw = fs.readFileSync(file, 'utf8')
      const fm = parseFrontmatter(raw) || {}
      return {
        id: toRepoRel(file),
        name: fm.name || findFirstHeading(raw) || path.basename(file, '.md'),
        type: 'doc',
        declared_type: fm.type || null,
        maturity: fm.maturity || null,
        status: fm.status || null,
        topic: fm.topic || null,
        last_verified: fm.last_verified || null,
        created: fm.created || null,
        supersedes: toArray(fm.supersedes),
        superseded_by: toArray(fm.superseded_by),
        related: toArray(fm.related),
        authoritative_sources: toArray(fm.authoritative_sources),
        audience: null,
        paths: [],
        body: stripFrontmatter(raw),
        stem: path.basename(file, '.md'),
      }
    })
}

function loadHooks() {
  const hooksDir = path.join(ROOT, '.claude', 'hooks')
  if (!fs.existsSync(hooksDir)) return []

  return fs.readdirSync(hooksDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => {
      const file = path.join(hooksDir, entry.name)
      return {
        id: toRepoRel(file),
        name: path.basename(entry.name, '.js'),
        type: 'hook',
        declared_type: null,
        maturity: null,
        status: null,
        topic: null,
        last_verified: null,
        created: null,
        supersedes: [],
        superseded_by: [],
        related: [],
        authoritative_sources: [],
        audience: null,
        paths: [],
        body: fs.readFileSync(file, 'utf8'),
        stem: path.basename(entry.name, '.js'),
      }
    })
}

function loadScripts() {
  if (!fs.existsSync(SCRIPTS_ROOT)) return []

  const files = listFiles(SCRIPTS_ROOT, { recursive: true, extensions: new Set(['.mjs']) })
    .map(file => normalizeFsPath(file))
    .filter(file => shouldIncludeScriptFile(toRepoRel(file)))

  const metas = files.map(file => {
    const rel = toRepoRel(file)
    const body = fs.readFileSync(file, 'utf8')
    return { file, rel, body }
  })
  const idByAbsPath = new Map(metas.map(meta => [normalizeFsPath(meta.file), meta.rel]))

  return metas.map(({ file, rel, body }) => ({
    id: rel,
    name: path.basename(file, '.mjs'),
    type: 'script',
    kind: classifyScriptKind(rel),
    declared_type: null,
    maturity: null,
    status: null,
    topic: null,
    last_verified: null,
    created: null,
    supersedes: [],
    superseded_by: [],
    related: [],
    authoritative_sources: [],
    audience: null,
    paths: [],
    body,
    stem: path.basename(file, '.mjs'),
    script_imports: resolveScriptRefs(file, parseImportSpecifiers(body), idByAbsPath),
    script_spawns: resolveScriptRefs(file, parseScriptSpawnSpecifiers(body), idByAbsPath),
    script_references: extractTeamMemoryReferences(body),
  }))
}

function loadCronTasks() {
  if (!fs.existsSync(SCHEDULER_CONFIG)) return []

  const raw = fs.readFileSync(SCHEDULER_CONFIG, 'utf8')
  const parsed = JSON.parse(raw)
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : []

  return tasks
    .filter(task => task && task.id)
    .map(task => ({
      id: `cron://${task.id}`,
      name: task.id,
      type: 'cron-task',
      declared_type: null,
      maturity: null,
      status: null,
      topic: null,
      last_verified: null,
      created: null,
      supersedes: [],
      superseded_by: [],
      related: [],
      authoritative_sources: [],
      audience: null,
      paths: [],
      body: '',
      stem: task.id,
      cron: task.cron || null,
      enabled: typeof task.enabled === 'boolean' ? task.enabled : null,
      description: task.description || null,
      scope: task.scope || null,
      triggers: task.script ? [task.script.replace(/\\/g, '/')] : [],
    }))
}

function loadMessageEmitters() {
  const files = [
    ...listFiles(SCRIPTS_ROOT, { recursive: true, extensions: new Set(['.mjs']) })
      .map(file => normalizeFsPath(file))
      .filter(file => shouldIncludeScriptFile(toRepoRel(file))),
    ...listFiles(DAEMON_ACTIONS_ROOT, { recursive: true, extensions: new Set(['.mjs']) })
      .map(file => normalizeFsPath(file)),
  ]

  const emitters = []
  for (const file of [...new Set(files)].sort()) {
    const rel = toRepoRel(file)
    const body = fs.readFileSync(file, 'utf8')
    const constants = extractStringConstants(body)
    for (const hit of extractMessageEmitters(body, rel, constants)) {
      emitters.push({
        id: `${rel}#L${hit.line}`,
        name: hit.name,
        type: 'message-emitter',
        declared_type: null,
        maturity: null,
        status: null,
        topic: null,
        last_verified: null,
        created: null,
        supersedes: [],
        superseded_by: [],
        related: [],
        authoritative_sources: [],
        audience: null,
        paths: [],
        body: '',
        stem: `${path.basename(file, '.mjs')}#L${hit.line}`,
        channel_type: hit.channel_type,
        target_kind: hit.target_kind,
        target_value: hit.target_value,
        target_symbol: hit.target_symbol,
        line: hit.line,
        host_script: rel,
        emitter_hosts: [rel],
      })
    }
  }

  return emitters.sort((a, b) => a.id.localeCompare(b.id))
}

function extractMessageEmitters(body, rel, constants) {
  return [
    ...extractTownMessageInsertEmitters(body, rel, constants),
    ...extractZoneHelperEmitters(body, rel, constants),
  ].sort((a, b) => a.line - b.line)
}

function extractTownMessageInsertEmitters(body, rel, constants) {
  const emitters = []
  const pattern = /INSERT\s+INTO\s+town_messages/gi
  let match

  while ((match = pattern.exec(body)) !== null) {
    const stringBounds = findStringLiteralAround(body, match.index)
    if (!stringBounds) continue

    const sql = body.slice(stringBounds.start + 1, stringBounds.end)
    const parsedSql = parseTownMessageInsertSql(sql)
    if (!parsedSql) continue

    const arrayBounds = findNextArrayLiteral(body, stringBounds.end + 1)
    const params = arrayBounds ? splitTopLevel(body.slice(arrayBounds.start + 1, arrayBounds.end)) : []
    const line = lineNumberAt(body, match.index)
    const channelExpr = parsedSql.valueByColumn.get('channel_type') || null
    const zoneExpr = parsedSql.valueByColumn.get('to_zone_id') || null
    const agentExpr = parsedSql.valueByColumn.get('to_agent_id') || null
    const targetKind = zoneExpr ? 'zone' : (agentExpr ? 'agent' : 'unknown')
    const targetExpr = zoneExpr || agentExpr || null
    const channel = resolveSqlValue(channelExpr, params, constants)
    const target = resolveSqlValue(targetExpr, params, constants)

    emitters.push({
      name: findEnclosingFunctionName(body, match.index) || 'inline',
      line,
      channel_type: normalizeChannelType(channel.value),
      target_kind: targetKind,
      target_value: normalizeEmitterValue(target.value),
      target_symbol: target.symbol || null,
    })
  }

  return emitters
}

function extractZoneHelperEmitters(body, rel, constants) {
  const emitters = []
  const pattern = /\bsendZoneIdempotent\s*\(/g
  let match

  while ((match = pattern.exec(body)) !== null) {
    const before = body.slice(Math.max(0, match.index - 32), match.index)
    if (/\bfunction\s+$/.test(before) || /\basync\s+function\s+$/.test(before)) continue

    const objectStart = body.indexOf('{', pattern.lastIndex)
    if (objectStart === -1) continue
    const objectEnd = findBalancedEnd(body, objectStart, '{', '}')
    if (objectEnd === -1) continue

    const props = parseObjectProperties(body.slice(objectStart + 1, objectEnd))
    const zone = resolveSqlValue(props.get('zoneId') || null, [], constants)
    const line = lineNumberAt(body, match.index)
    emitters.push({
      name: findEnclosingFunctionName(body, match.index) || 'inline',
      line,
      channel_type: 'zone',
      target_kind: 'zone',
      target_value: normalizeEmitterValue(zone.value),
      target_symbol: zone.symbol || null,
    })
  }

  return emitters
}

function parseObjectProperties(input) {
  const props = new Map()
  for (const part of splitTopLevel(input)) {
    const index = part.indexOf(':')
    if (index === -1) continue
    const key = part.slice(0, index).trim().replace(/^['"]|['"]$/g, '')
    const value = part.slice(index + 1).trim()
    if (key) props.set(key, value)
  }
  return props
}

function parseTownMessageInsertSql(sql) {
  const normalized = sql.replace(/\s+/g, ' ')
  const match = normalized.match(/INSERT\s+INTO\s+town_messages\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/i)
  if (!match) return null

  const columns = splitTopLevel(match[1]).map(value => value.trim().replace(/^"|"$/g, '').toLowerCase())
  const values = splitTopLevel(match[2]).map(value => value.trim())
  if (columns.length === 0 || values.length === 0) return null

  const valueByColumn = new Map()
  columns.forEach((column, index) => {
    if (column) valueByColumn.set(column, values[index] || null)
  })
  return { valueByColumn }
}

function resolveSqlValue(expr, params, constants) {
  if (!expr) return { value: 'unresolved', symbol: null }

  let value = stripSqlCast(expr.trim())
  const placeholder = value.match(/^\$(\d+)$/)
  if (placeholder) {
    const index = Number(placeholder[1]) - 1
    value = params[index] ? params[index].trim() : 'unresolved'
  }

  value = stripSqlCast(value)
  const literal = parseQuotedLiteral(value)
  if (literal !== null) return { value: literal, symbol: null }

  const symbol = value.match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/) ? value : null
  if (symbol && constants.has(symbol)) return { value: constants.get(symbol), symbol }
  return { value: symbol || value || 'unresolved', symbol }
}

function normalizeChannelType(value) {
  if (value === 'dm' || value === 'zone') return value
  return 'unknown'
}

function normalizeEmitterValue(value) {
  const clean = String(value || '').trim()
  return clean || 'unresolved'
}

function stripSqlCast(value) {
  return String(value || '').trim().replace(/::[A-Za-z0-9_."[\\]]+$/g, '').trim()
}

function parseQuotedLiteral(value) {
  const match = String(value || '').trim().match(/^(['"`])([\s\S]*)\1$/)
  if (!match) return null
  return match[2].replace(/\\(['"`\\])/g, '$1')
}

function extractStringConstants(body) {
  const constants = new Map()
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`]*?)\2/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    constants.set(match[1], match[3])
  }
  return constants
}

function findStringLiteralAround(body, index) {
  let best = null
  for (const quote of ['`', "'", '"']) {
    const start = body.lastIndexOf(quote, index)
    if (start === -1) continue
    const end = findStringEnd(body, start)
    if (end !== -1 && end > index && (!best || start > best.start)) {
      best = { start, end, quote }
    }
  }
  return best
}

function findStringEnd(body, start) {
  const quote = body[start]
  for (let i = start + 1; i < body.length; i += 1) {
    if (body[i] === '\\') {
      i += 1
      continue
    }
    if (body[i] === quote) return i
  }
  return -1
}

function findNextArrayLiteral(body, fromIndex) {
  const start = body.indexOf('[', fromIndex)
  if (start === -1) return null
  const end = findBalancedEnd(body, start, '[', ']')
  return end === -1 ? null : { start, end }
}

function findBalancedEnd(body, start, openChar, closeChar) {
  let depth = 0
  let stringQuote = null
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i]
    if (stringQuote) {
      if (ch === '\\') i += 1
      else if (ch === stringQuote) stringQuote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      stringQuote = ch
      continue
    }
    if (ch === openChar) depth += 1
    else if (ch === closeChar) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function splitTopLevel(input) {
  const parts = []
  let start = 0
  let depth = 0
  let stringQuote = null
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (stringQuote) {
      if (ch === '\\') i += 1
      else if (ch === stringQuote) stringQuote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      stringQuote = ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(input.slice(start, i).trim())
      start = i + 1
    }
  }
  const tail = input.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

function lineNumberAt(body, index) {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (body[i] === '\n') line += 1
  }
  return line
}

function findEnclosingFunctionName(body, index) {
  const prefix = body.slice(0, index)
  const patterns = [
    /\basync\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/g,
  ]
  let best = null
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(prefix)) !== null) {
      if (!best || match.index > best.index) best = { index: match.index, name: match[1] }
    }
  }
  return best?.name || null
}

function loadPathScopedRules() {
  const rulesDir = path.join(ROOT, '.claude', 'rules')
  if (!fs.existsSync(rulesDir)) return []

  return fs.readdirSync(rulesDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.md$/i.test(entry.name))
    .map(entry => {
      const file = path.join(rulesDir, entry.name)
      const raw = fs.readFileSync(file, 'utf8')
      const fm = parseFrontmatter(raw) || {}
      return {
        id: toRepoRel(file),
        name: findFirstHeading(raw) || path.basename(entry.name, '.md'),
        type: 'rule-paths-scoped',
        declared_type: fm.type || null,
        maturity: fm.maturity || null,
        status: fm.status || null,
        topic: fm.topic || null,
        last_verified: fm.last_verified || null,
        created: fm.created || null,
        supersedes: toArray(fm.supersedes),
        superseded_by: toArray(fm.superseded_by),
        related: toArray(fm.related),
        authoritative_sources: toArray(fm.authoritative_sources),
        audience: null,
        paths: toArray(fm.paths),
        body: stripFrontmatter(raw),
        stem: path.basename(entry.name, '.md'),
      }
    })
    .filter(rule => rule.paths.length > 0)
}

function loadDaemonRuntimeFiles() {
  const DAEMON_SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'logs'])
  const files = []

  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && /^town-.*\.mjs$/.test(entry.name)) {
      files.push(path.join(ROOT, entry.name))
    }
  }

  const libDir = path.join(ROOT, 'lib')
  if (fs.existsSync(libDir)) {
    for (const entry of fs.readdirSync(libDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.mjs')) {
        files.push(path.join(libDir, entry.name))
      }
    }
  }

  const daemonActionsDir = path.join(ROOT, 'daemon-actions')
  if (fs.existsSync(daemonActionsDir)) {
    for (const file of walkMjsFiles(daemonActionsDir, DAEMON_SKIP_DIRS)) {
      files.push(file)
    }
  }

  const metas = files.map(file => {
    const rel = toRepoRel(file)
    const body = fs.readFileSync(file, 'utf8')
    return { file, rel, body }
  })
  const idByAbsPath = new Map(metas.map(meta => [normalizeFsPath(meta.file), meta.rel]))

  return metas.map(({ file, rel, body }) => ({
    id: rel,
    name: path.basename(file, '.mjs'),
    type: 'script',
    kind: 'daemon-runtime',
    declared_type: null,
    maturity: null,
    status: null,
    topic: null,
    last_verified: null,
    created: null,
    supersedes: [],
    superseded_by: [],
    related: [],
    authoritative_sources: [],
    audience: null,
    paths: [],
    body,
    stem: path.basename(file, '.mjs'),
    script_imports: resolveScriptRefs(file, parseImportSpecifiers(body), idByAbsPath),
    script_spawns: resolveScriptRefs(file, parseScriptSpawnSpecifiers(body), idByAbsPath),
    script_references: extractTeamMemoryReferences(body),
  }))
}

function walkMjsFiles(dir, skipDirs) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name) && !entry.name.startsWith('.codex-tmp')) {
        out.push(...walkMjsFiles(path.join(dir, entry.name), skipDirs))
      }
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

function mapTeamMemoryType(dir) {
  if (dir === 'rules') return 'rule'
  if (dir === 'playbooks') return 'playbook'
  if (dir === 'decisions') return 'decision'
  return 'pointer'
}

function walkMd(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkMd(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

function walkNamedFile(dir, filename) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkNamedFile(full, filename))
    else if (entry.isFile() && entry.name === filename) out.push(full)
  }
  return out
}

function shouldIncludeScriptFile(relPath) {
  const normalized = relPath.replace(/\\/g, '/')
  if (SCRIPT_EXCLUDE_IDS.has(normalized)) return false
  return !SCRIPT_EXCLUDE_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

function classifyScriptKind(relPath) {
  const normalized = relPath.replace(/\\/g, '/')
  if (/^scripts\/proactive-[^/]+\.mjs$/i.test(normalized)) return 'proactive'
  if (normalized.startsWith('scripts/qa/')) return 'qa'
  if (normalized.startsWith('scripts/memory/')) return 'memory'
  if (normalized.startsWith('scripts/kg/')) return 'kg'
  if (normalized.startsWith('scripts/eval/')) return 'eval'
  if (normalized.startsWith('scripts/lib/')) return 'lib'
  return 'other'
}

function parseFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!match) return null

  const fm = {}
  let currentKey = null

  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/\t/g, '  ')
    const keyMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (keyMatch) {
      const key = keyMatch[1]
      currentKey = TARGET_FIELDS.has(key) ? key : null
      if (!currentKey) continue

      const value = keyMatch[2].trim()
      if (LIST_FIELDS.has(key)) {
        fm[key] = parseListValue(value)
      } else if (value) {
        fm[key] = stripQuotes(value)
      }
      continue
    }

    if (currentKey && LIST_FIELDS.has(currentKey)) {
      const itemMatch = line.match(/^\s*-\s*(.+?)\s*$/)
      if (itemMatch) {
        if (!Array.isArray(fm[currentKey])) fm[currentKey] = []
        fm[currentKey].push(stripQuotes(itemMatch[1].trim()))
      }
    }
  }

  return fm
}

function parseListValue(value) {
  if (!value) return []
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return trimmed ? [stripQuotes(trimmed)] : []
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []
  return inner.split(',').map(part => stripQuotes(part.trim())).filter(Boolean)
}

function stripQuotes(value) {
  return value.replace(/^['"]|['"]$/g, '').trim()
}

function toArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean)
}

function stripFrontmatter(content) {
  return content.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '')
}

function findFirstHeading(content) {
  const match = stripFrontmatter(content).match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : null
}

function createResolver(docs) {
  const direct = new Set(docs.map(doc => doc.id))
  const aliasBuckets = new Map()

  for (const doc of docs) {
    const id = doc.id
    const ext = path.posix.extname(id)
    const stem = ext ? id.slice(0, -ext.length) : id
    const base = path.posix.basename(stem)

    addAlias(id, id)
    addAlias(stem, id)
    addAlias(base, id)
    if (ext) addAlias(base + ext, id)
  }

  const aliases = new Map()
  for (const [alias, ids] of aliasBuckets.entries()) {
    if (ids.size === 1) aliases.set(alias, [...ids][0])
  }

  return raw => {
    const candidate = normalizeReference(raw)
    if (!candidate) return null
    const normalized = candidate.replace(/\\/g, '/')
    if (aliases.has(normalized)) return { id: aliases.get(normalized), missing: false }

    const teamCandidate = normalizeTeamMemoryPath(normalized)
    if (teamCandidate && aliases.has(teamCandidate)) return { id: aliases.get(teamCandidate), missing: false }
    if (teamCandidate) return { id: teamCandidate, missing: !direct.has(teamCandidate) }
    return null
  }

  function addAlias(alias, id) {
    if (!alias) return
    if (!aliasBuckets.has(alias)) aliasBuckets.set(alias, new Set())
    aliasBuckets.get(alias).add(id)
  }
}

function normalizeReference(raw) {
  if (!raw) return null
  let value = String(raw).trim()
  const mdLink = value.match(/\[[^\]]+\]\(([^)]+)\)/)
  if (mdLink) value = mdLink[1].trim()
  value = value.replace(/[，。；;,]+$/g, '').trim()

  const pathMatch = value.match(/((?:team-memory|docs|skills|\.claude)\/[^\s()（）]+(?:\.(?:md|js))?)/)
  if (pathMatch) return sanitizeReferenceCandidate(pathMatch[1])

  const relativePath = value.match(/^\.{0,2}\/[A-Za-z0-9._/-]+(?:\.(?:md|js))?$/)
  if (relativePath) return sanitizeReferenceCandidate(relativePath[0])

  const bareFile = value.match(/^([A-Za-z0-9._-]+(?:\.(?:md|js))?)$/)
  if (bareFile) return sanitizeReferenceCandidate(bareFile[1])

  return null
}

function sanitizeReferenceCandidate(candidate) {
  if (!candidate) return null
  const normalized = candidate.replace(/\\/g, '/').replace(/\/+$/g, '')
  const base = path.posix.basename(normalized)
  if (!normalized || normalized.endsWith('/.') || normalized.endsWith('/..')) return null
  if (base === '.' || base === '..') return null
  return normalized
}

function normalizeTeamMemoryPath(candidate) {
  if (!candidate) return null
  let value = candidate.replace(/\\/g, '/')
  if (!value.endsWith('.md') && !path.posix.extname(value)) value += '.md'
  if (value.startsWith('team-memory/')) return value
  if (TARGET_DIRS.some(dir => value.startsWith(dir + '/'))) return `team-memory/${value}`
  return null
}

// KOS-Plus v1 P0.1: typed entity edge extractors (zero-LLM regex)
function extractHookRefs(body) {
  if (!body) return []
  const re = /\.claude\/hooks\/[a-z0-9_-]+\.(?:m?js|cjs)/gi
  return [...new Set(body.match(re) || [])]
}

function splitDeciderField(deciders) {
  if (!deciders || !deciders.length) return []
  return deciders
    .flatMap(s => String(s).split(/\s*\/\s*|\s*,\s*/))
    .map(s => s.trim())
    .filter(Boolean)
}

function buildGraph(docs, resolveRef, codeRepo) {
  const edges = []
  const seen = new Set()
  const missingNodes = new Set()
  const directDocIds = new Set(docs.map(doc => doc.id))

  // 统一 canonical_path：剥离 ../code-repo/ 前缀，使两图路径命名空间一致
  // governs/implements 匹配用 canonical_path，避免路径前缀差异导致的误匹配/漏匹配
  for (const n of codeRepo.nodes) if (!n.canonical_path) n.canonical_path = toCanonicalPath(n.id)
  for (const d of docs) if (!d.canonical_path) d.canonical_path = toCanonicalPath(d.id)

  for (const doc of docs) {
    addRefs(doc.id, doc.supersedes, 'supersedes', false)
    addRefs(doc.id, doc.superseded_by, 'superseded_by', true)
    addRefs(doc.id, doc.related, 'related', false, true)
    addRefs(doc.id, doc.authoritative_sources, 'points-to', false, false, true)
    addDirectRefs(doc.id, doc.script_imports, 'imports')
    addDirectRefs(doc.id, doc.script_spawns, 'spawns')
    addRefs(doc.id, doc.script_references || [], 'references', false)
    addDirectRefs(doc.id, doc.triggers, 'triggers')
    addDirectRefs(doc.id, doc.emitter_hosts, 'emits-from')
    addDirectRefs(doc.id, splitDeciderField(doc.deciders), 'decides')
    addDirectRefs(doc.id, extractHookRefs(doc.body), 'enforced_by')
    // governs 边：rule/playbook.governs_paths 显式声明管辖的代码路径
    // implements 边：governs 反向，code-file → rule（"此文件实现了该规则约束的路径"）
    if ((doc.type === 'rule' || doc.type === 'rule-paths-scoped' || doc.type === 'playbook') && doc.governs_paths?.length) {
      for (const pattern of doc.governs_paths) {
        const p = String(pattern).replace(/\\/g, '/')
        for (const n of codeRepo.nodes) {
          if ((n.canonical_path || n.id).includes(p)) {
            pushEdge(doc.id, n.id, 'governs')
            pushEdge(n.id, doc.id, 'implements')
          }
        }
        for (const d of docs) {
          if (d.id !== doc.id && (d.canonical_path || d.id).includes(p)) pushEdge(doc.id, d.id, 'governs')
        }
      }
    }
  }

  const crossArtifactReferences = addReferenceEdges()
  const audienceMatrix = addAudienceMismatchEdges()

  // Bi-temporal schema (v1.4 / ADR-022 Tier 1):
  // confidence: maturity 推导（proven=1.0 / verified=0.7 / draft=0.4 / null=0.5 default）
  // t_valid: 节点首次有效时间（created 字段；缺则 null，不阻断查询）
  // t_invalid: 节点失效时间（仅 status=superseded 时设 last_verified；其他 null）
  // 学习自 Zep / Hindsight / Collaborative Memory bi-temporal 设计
  const MATURITY_CONFIDENCE = { proven: 1.0, verified: 0.7, draft: 0.4 }
  const nodes = docs.map(doc => {
    const maturityConf = MATURITY_CONFIDENCE[doc.maturity] ?? 0.5
    const isSuperseded = (doc.status || '').toLowerCase().startsWith('superseded')
    return {
      id: doc.id,
      canonical_path: doc.canonical_path,
      name: doc.name,
      type: doc.type,
      declared_type: doc.declared_type,
      maturity: doc.maturity,
      status: doc.status,
      topic: doc.topic,
      last_verified: doc.last_verified,
      created: doc.created,
      audience: doc.audience,
      paths: doc.paths,
      governs_paths: doc.governs_paths || [],
      kind: doc.kind || null,
      cron: doc.cron || null,
      enabled: typeof doc.enabled === 'boolean' ? doc.enabled : null,
      scope: doc.scope || null,
      description: doc.description || null,
      channel_type: doc.channel_type || null,
      target_kind: doc.target_kind || null,
      target_value: doc.target_value || null,
      target_symbol: doc.target_symbol || null,
      line: doc.line || null,
      host_script: doc.host_script || null,
      // bi-temporal
      confidence: maturityConf,
      t_valid: doc.created || null,
      t_invalid: isSuperseded ? (doc.last_verified || null) : null,
    }
  })
  nodes.push(...codeRepo.nodes)
  for (const edge of codeRepo.edges) pushEdge(edge.from, edge.to, edge.label)
  const crossRepoSummary = summarizeCodeRepo(codeRepo.nodes, codeRepo.edges)
  const gitCommitHash = getGitCommitHash()
  const builtAt = new Date().toISOString()

  return {
    nodes,
    edges,
    missingNodes: [...missingNodes].sort(),
    crossArtifactReferences,
    audienceMatrix,
    crossRepoSummary,
    json: {
      generated_at: new Date().toISOString(),
      meta: {
        gitCommitHash,
        built_at: builtAt,
      },
      nodes,
      edges,
      cross_artifact_references: crossArtifactReferences,
      audience_matrix: audienceMatrix,
    },
  }

  function addRefs(from, refs, label, invert = false, bidirectional = false, pointsToOnly = false) {
    for (const ref of refs) {
      const resolved = resolveRef(ref)
      if (!resolved) continue
      if (pointsToOnly && resolved.missing) continue
      if (resolved.missing) missingNodes.add(resolved.id)
      const source = invert ? resolved.id : from
      const target = invert ? from : resolved.id
      pushEdge(source, target, label)
      if (bidirectional) pushEdge(target, source, label)
    }
  }

  function addDirectRefs(from, refs, label) {
    for (const ref of refs || []) {
      const target = String(ref || '').trim().replace(/\\/g, '/')
      if (!target) continue
      if (!directDocIds.has(target)) missingNodes.add(target)
      pushEdge(from, target, label)
    }
  }

  function addReferenceEdges() {
    const targets = docs.filter(doc => REFERENCE_TARGET_TYPES.has(doc.type))
    const sources = docs.filter(doc => isReferenceSource(doc))
    const matchers = buildReferenceMatchers(targets)
    const counts = new Map(
      targets.map(target => [target.id, { id: target.id, name: target.name, type: target.type, refs_in_hooks: 0, refs_in_skills: 0, refs_in_docs: 0 }]),
    )

    for (const source of sources) {
      const group = classifyReferenceSource(source)
      const hits = []
      for (const matcher of matchers) {
        if (matcher.id === source.id) continue
        if (!matcher.pattern.test(source.body)) continue
        hits.push(matcher.id)
      }

      for (const targetId of [...new Set(hits)].sort()) {
        pushEdge(source.id, targetId, 'references')
        const row = counts.get(targetId)
        if (!row) continue
        if (group === 'hooks') row.refs_in_hooks += 1
        else if (group === 'skills') row.refs_in_skills += 1
        else if (group === 'docs') row.refs_in_docs += 1
      }
    }

    return [...counts.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  function addAudienceMismatchEdges() {
    const skillDocs = docs.filter(doc => doc.type === 'skill' || doc.type === 'skill-internal')
    const mismatches = []

    for (const doc of skillDocs) {
      const audience = String(doc.audience || '').toLowerCase()
      const internalPath = isInternalSkillPath(doc.id)
      let reason = null

      if (audience === 'internal' && !internalPath) {
        reason = 'audience: internal outside skills/_internal/'
      } else if (audience === 'public' && internalPath) {
        reason = 'audience: public inside skills/_internal/'
      }

      if (!reason) continue
      pushEdge(doc.id, doc.id, 'audience-mismatch', { reason })
      mismatches.push({
        id: doc.id,
        name: doc.name,
        audience,
        reason,
      })
    }

    return {
      public_skill_count: skillDocs.filter(doc => doc.type === 'skill').length,
      internal_skill_count: skillDocs.filter(doc => doc.type === 'skill-internal').length,
      mismatch_count: mismatches.length,
      mismatches: mismatches.sort((a, b) => a.id.localeCompare(b.id)),
    }
  }

  function pushEdge(from, to, label, extra = null) {
    const key = `${from}>>${label}>>${to}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push(extra ? { from, to, label, ...extra } : { from, to, label })
  }
}

function buildReferenceMatchers(targets) {
  const aliasBuckets = new Map()

  for (const target of targets) {
    for (const alias of getReferenceAliases(target)) {
      const key = alias.toLowerCase()
      if (!aliasBuckets.has(key)) aliasBuckets.set(key, new Set())
      aliasBuckets.get(key).add(target.id)
    }
  }

  const aliasesById = new Map(targets.map(target => [target.id, new Set()]))
  for (const [alias, ids] of aliasBuckets.entries()) {
    if (ids.size !== 1) continue
    const [id] = [...ids]
    aliasesById.get(id).add(alias)
  }

  return targets
    .map(target => {
      const aliases = [...aliasesById.get(target.id)]
      if (aliases.length === 0) return null
      return {
        id: target.id,
        pattern: createReferencePattern(aliases),
      }
    })
    .filter(Boolean)
}

function getReferenceAliases(target) {
  const aliases = new Set([target.stem])
  const adrMatch = target.stem.match(/^(adr-\d+)/i)
  if (adrMatch) aliases.add(adrMatch[1].toUpperCase())
  return [...aliases].filter(alias => alias && alias.length >= 3)
}

function createReferencePattern(aliases) {
  const alternation = aliases
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(alias => escapeRegExp(alias))
    .join('|')
  return new RegExp(`(^|[^A-Za-z0-9_])(?:${alternation})(?:\\.md)?(?=$|[^A-Za-z0-9_])`, 'i')
}

function isReferenceSource(doc) {
  return doc.type === 'skill' || doc.type === 'skill-internal' || doc.type === 'hook' || doc.id.startsWith('docs/')
}

function classifyReferenceSource(doc) {
  if (doc.type === 'hook') return 'hooks'
  if (doc.type === 'skill' || doc.type === 'skill-internal') return 'skills'
  return 'docs'
}

function renderReport(graph, options) {
  const byType = tally(graph.nodes, node => node.type || 'unknown')
  const byMaturity = tally(graph.nodes, node => node.maturity || 'unknown')
  const degrees = computeDegrees(graph)
  const crossRepoSummary = graph.crossRepoSummary || summarizeCodeRepo([], [])
  const top = [...degrees.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
  const orphans = graph.nodes
    .filter(node => (degrees.get(node.id) || 0) === 0)
    .map(node => node.id)
    .sort()
  const staleChains = findStaleChains(graph, options.maxDepth)
  const sampleEdges = graph.edges.slice(0, 5)

  let out = `# Knowledge Graph Report${options.dryRun ? ' (dry-run)' : ''}\n\n`
  out += `- Generated nodes: **${graph.nodes.length}**\n`
  out += `- Generated edges: **${graph.edges.length}**\n`
  out += `- Max depth: **${Number.isFinite(options.maxDepth) ? options.maxDepth : 'unlimited'}**\n`
  if (!options.dryRun) {
    out += `- Wrote: \`team-memory/.knowledge-graph.json\`, \`team-memory/.knowledge-graph.dot\`, \`${toRepoRel(options.snapshotPath)}\`\n`
  }
  out += '\n## Node Summary\n\n'
  out += `- Total: **${graph.nodes.length}**\n`
  out += `- By type: ${formatTally(byType)}\n`
  out += `- By maturity: ${formatTally(byMaturity)}\n`
  out += '\n## Cross-repo summary\n\n'
  out += `- Total code repo nodes: **${crossRepoSummary.total}**\n`
  out += `- By subtype: ${formatTally(crossRepoSummary.bySubtype)}\n`
  out += crossRepoSummary.topHubs.length
    ? `${crossRepoSummary.topHubs.map((item, index) => `${index + 1}. \`${item.id}\` — import in-degree ${item.importInDegree}`).join('\n')}\n`
    : '- Top 5 hubs: none\n'
  out += '\n## Top Connected Nodes\n\n'
  out += top.length
    ? top.map(([id, degree], index) => `${index + 1}. \`${id}\` — degree ${degree}`).join('\n') + '\n'
    : '- none\n'
  out += '\n## Orphan Nodes\n\n'
  out += orphans.length ? orphans.map(id => `- \`${id}\``).join('\n') + '\n' : '- none\n'
  out += '\n## Stale Supersede Chains\n\n'
  out += staleChains.length
    ? staleChains.map(chain => `- ${chain}`).join('\n') + '\n'
    : '- none\n'
  out += '\n## Cross-artifact references\n\n'
  out += graph.crossArtifactReferences.length
    ? graph.crossArtifactReferences
      .map(row => `- \`${row.id}\` — refs_in_hooks=${row.refs_in_hooks}, refs_in_skills=${row.refs_in_skills}, refs_in_docs=${row.refs_in_docs}`)
      .join('\n') + '\n'
    : '- none\n'
  out += '\n## Audience matrix\n\n'
  out += `- public_skill_count: ${graph.audienceMatrix.public_skill_count}\n`
  out += `- internal_skill_count: ${graph.audienceMatrix.internal_skill_count}\n`
  out += `- mismatch_count: ${graph.audienceMatrix.mismatch_count}\n`
  out += graph.audienceMatrix.mismatches.length
    ? graph.audienceMatrix.mismatches.map(item => `- mismatch: \`${item.id}\` (${item.audience}) — ${item.reason}`).join('\n') + '\n'
    : '- mismatches: none\n'
  out += '\n## Sample Edges\n\n'
  out += sampleEdges.length
    ? sampleEdges.map(edge => `- \`${edge.from}\` --${edge.label}--> \`${edge.to}\``).join('\n') + '\n'
    : '- none\n'
  return out
}

function renderSnapshotDelta(diffDate, currentGraph) {
  const snapshotPath = path.join(SNAPSHOT_DIR, `${diffDate}.json`)
  let out = `\n## Snapshot delta vs ${diffDate}\n\n`

  if (!fs.existsSync(snapshotPath)) {
    out += `- Snapshot not found: \`${toRepoRel(snapshotPath)}\`\n`
    return out
  }

  let previous
  try {
    previous = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  } catch (error) {
    out += `- Snapshot unreadable: \`${toRepoRel(snapshotPath)}\` (${error.message})\n`
    return out
  }

  const previousNodes = new Set((previous.nodes || []).map(node => node.id))
  const currentNodes = new Set((currentGraph.nodes || []).map(node => node.id))
  const previousEdges = new Set((previous.edges || []).map(edge => edgeKey(edge)))
  const currentEdges = new Set((currentGraph.edges || []).map(edge => edgeKey(edge)))

  const addedNodes = [...currentNodes].filter(id => !previousNodes.has(id)).sort()
  const removedNodes = [...previousNodes].filter(id => !currentNodes.has(id)).sort()
  const addedEdges = [...currentEdges].filter(id => !previousEdges.has(id)).sort()
  const removedEdges = [...previousEdges].filter(id => !currentEdges.has(id)).sort()

  out += formatDeltaList('Added nodes', addedNodes)
  out += formatDeltaList('Removed nodes', removedNodes)
  out += formatDeltaList('Added edges', addedEdges)
  out += formatDeltaList('Removed edges', removedEdges)
  return out
}

function formatDeltaList(label, items) {
  if (items.length === 0) return `- ${label}: none\n`
  return `- ${label}:\n${items.map(item => `  - \`${item}\``).join('\n')}\n`
}

function edgeKey(edge) {
  return `${edge.from}>>${edge.label}>>${edge.to}`
}

function tally(items, getKey) {
  const map = new Map()
  for (const item of items) {
    const key = getKey(item)
    map.set(key, (map.get(key) || 0) + 1)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

function formatTally(rows) {
  return rows.map(([key, value]) => `\`${key}\`=${value}`).join(', ') || '(none)'
}

function computeDegrees(graph) {
  const map = new Map(graph.nodes.map(node => [node.id, 0]))
  for (const edge of graph.edges) {
    if (map.has(edge.from)) map.set(edge.from, map.get(edge.from) + 1)
    if (map.has(edge.to)) map.set(edge.to, map.get(edge.to) + 1)
  }
  return map
}

function findStaleChains(graph, maxDepth) {
  const direct = graph.edges.filter(edge => edge.label === 'supersedes' || edge.label === 'superseded_by')
  if (direct.length === 0) return []

  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  const olderToNewer = new Map()
  const indegree = new Map()

  for (const edge of direct) {
    if (!olderToNewer.has(edge.to)) olderToNewer.set(edge.to, [])
    olderToNewer.get(edge.to).push(edge.from)
    indegree.set(edge.from, (indegree.get(edge.from) || 0) + 1)
    if (!indegree.has(edge.to)) indegree.set(edge.to, indegree.get(edge.to) || 0)
  }

  const roots = [...olderToNewer.keys()].filter(id => (indegree.get(id) || 0) === 0).sort()
  const out = []

  for (const root of roots) {
    const chain = [root]
    const seen = new Set(chain)
    let current = root

    while (olderToNewer.has(current)) {
      if (Number.isFinite(maxDepth) && chain.length - 1 >= maxDepth) break
      const next = [...olderToNewer.get(current)].sort()[0]
      if (seen.has(next)) break
      chain.push(next)
      seen.add(next)
      current = next
    }

    const terminal = chain[chain.length - 1]
    const terminalNode = nodeById.get(terminal)
    const terminalStatus = (terminalNode?.status || '').toLowerCase()
    const noReplacement = !olderToNewer.has(terminal)
    if (terminalStatus === 'archived' || noReplacement) {
      out.push(`${chain.map(id => `\`${id}\``).join(' -> ')}${noReplacement ? ' _(no newer replacement)_' : ''}${terminalStatus === 'archived' ? ' _(terminal archived)_' : ''}`)
    }
  }

  return out
}

function buildDot(graph) {
  const lines = [
    'digraph TeamMemoryKnowledgeGraph {',
    '  rankdir=LR;',
    '  graph [fontname="Helvetica"];',
    '  node [shape=box style="rounded,filled" fontname="Helvetica"];',
    '  edge [fontname="Helvetica"];',
  ]

  for (const node of graph.nodes) {
    const fill = MATURITY_COLORS[node.maturity] || MATURITY_COLORS.draft
    const label = escapeDot(`${node.name}\\n${node.id}`)
    lines.push(`  "${escapeDot(node.id)}" [label="${label}", fillcolor="${fill}"];`)
  }

  for (const id of graph.missingNodes) {
    lines.push(`  "${escapeDot(id)}" [label="${escapeDot(`${id}\\n(missing)`)}", style="rounded,dashed,filled", fillcolor="#fff4f4", color="#c0392b"];`)
  }

  for (const edge of graph.edges) {
    lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [label="${escapeDot(edge.label)}"];`)
  }

  lines.push('}')
  return lines.join('\n') + '\n'
}

function loadCodeRepoArtifacts() {
  if (!includeCodeRepo || !CODE_REPO_ROOT) return { nodes: [], edges: [], cache: null }
  if (!fs.existsSync(CODE_REPO_ROOT)) {
    process.stderr.write(`KOS_CODE_REPO not found at ${CODE_REPO_ROOT}, skipping\n`)
    return { nodes: [], edges: [], cache: null }
  }

  const priorCache = readCodeRepoCache()
  const files = collectCodeRepoFiles()
  const limitedFiles = files.slice(0, CODE_REPO_NODE_CAP)

  if (files.length > CODE_REPO_NODE_CAP) {
    process.stderr.write(`warning: code repo node cap hit (${CODE_REPO_NODE_CAP}); skipped ${files.length - CODE_REPO_NODE_CAP} files\n`)
  }

  const nodes = []
  const idByAbsPath = new Map()
  const cacheEntries = {}

  for (const file of limitedFiles) {
    const repoRel = toCodeRepoRel(file)
    const meta = readCodeRepoFileMetadata(file, repoRel, priorCache.files?.[repoRel] || null)
    cacheEntries[repoRel] = meta
    const node = {
      id: toCodeRepoNodeId(file),
      name: path.basename(file),
      type: 'code-file',
      subtype: classifyCodeRepoSubtype(file),
      data_source: meta.data_source || 'none',
    }
    nodes.push(node)
    idByAbsPath.set(normalizeFsPath(file), node.id)
  }

  const edges = []
  const seen = new Set()
  const siblingsByDir = new Map()

  for (const node of nodes) {
    const absPath = toCodeRepoAbsPath(node.id)
    const dir = path.dirname(absPath)
    if (!siblingsByDir.has(dir)) siblingsByDir.set(dir, [])
    siblingsByDir.get(dir).push(node.id)

    const repoRel = toCodeRepoRel(absPath)
    const imports = cacheEntries[repoRel]?.imports || []
    for (const specifier of imports) {
      const importee = resolveCodeRepoImport(absPath, specifier, idByAbsPath)
      if (!importee) continue
      pushLocalEdge(node.id, importee, 'imports')
    }
  }

  for (const siblings of siblingsByDir.values()) {
    const ordered = [...siblings].sort()
    for (const nodeId of ordered) {
      let count = 0
      for (const siblingId of ordered) {
        if (nodeId === siblingId) continue
        pushLocalEdge(nodeId, siblingId, 'co-located')
        count += 1
        if (count >= 3) break
      }
    }
  }

  return {
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => (
      a.from.localeCompare(b.from) ||
      a.label.localeCompare(b.label) ||
      a.to.localeCompare(b.to)
    )),
    cache: {
      generated_at: new Date().toISOString(),
      version: 1,
      files: cacheEntries,
    },
  }

  function pushLocalEdge(from, to, label) {
    const key = `${from}>>${label}>>${to}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ from, to, label })
  }
}

function collectCodeRepoFiles() {
  const files = new Set()
  addWalk(path.join(CODE_REPO_SRC, 'app'), new Set(['.ts', '.tsx']))
  addWalk(path.join(CODE_REPO_SRC, 'lib'), new Set(['.ts']))
  addWalk(path.join(CODE_REPO_SRC, 'components'), new Set(['.ts', '.tsx']))
  addWalk(path.join(CODE_REPO_SRC, 'services'), new Set(['.ts']))
  addWalk(path.join(CODE_REPO_SRC, 'types'), new Set(['.ts']))
  addFlat(path.join(CODE_REPO_ROOT, 'migrations'), new Set(['.sql']))
  // CI/CD and config files — needed for iron-11 (domestic artifact) governs edges
  addWalk(path.join(CODE_REPO_ROOT, '.github', 'workflows'), new Set(['.yml', '.yaml']))

  const drizzleSchemaDir = path.join(CODE_REPO_ROOT, 'drizzle', 'schema')
  const drizzleRootDir = path.join(CODE_REPO_ROOT, 'drizzle')
  const schemaFiles = listFiles(drizzleSchemaDir, { recursive: false, extensions: new Set(['.ts']) })
  const drizzleFiles = schemaFiles.length > 0
    ? schemaFiles
    : listFiles(drizzleRootDir, { recursive: false, extensions: new Set(['.ts']) })
  for (const file of drizzleFiles) files.add(normalizeFsPath(file))

  return [...files].sort()

  function addWalk(dir, extensions) {
    for (const file of listFiles(dir, { recursive: true, extensions })) {
      files.add(normalizeFsPath(file))
    }
  }

  function addFlat(dir, extensions) {
    for (const file of listFiles(dir, { recursive: false, extensions })) {
      files.add(normalizeFsPath(file))
    }
  }
}

function listFiles(dir, options) {
  if (!fs.existsSync(dir)) return []
  const out = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (options.recursive) out.push(...listFiles(full, options))
      continue
    }

    if (entry.isFile() && options.extensions.has(path.extname(entry.name).toLowerCase())) {
      out.push(full)
    }
  }

  return out
}

function readCodeRepoCache() {
  if (!fs.existsSync(CODE_REPO_CACHE)) return { files: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(CODE_REPO_CACHE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : { files: {} }
  } catch {
    return { files: {} }
  }
}

function detectDataSource(content) {
  const hasSupa = DS_SUPABASE.test(content)
  const hasDrizzle = DS_DRIZZLE.test(content)
  if (hasSupa && hasDrizzle) return 'both'
  if (hasSupa) return 'supabase'
  if (hasDrizzle) return 'drizzle'
  return 'none'
}

function readCodeRepoFileMetadata(file, repoRel, cached) {
  const stat = fs.statSync(file)
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    Array.isArray(cached.imports) &&
    cached.data_source !== undefined
  ) {
    return cached
  }

  const ext = path.extname(file).toLowerCase()
  const isTs = ext === '.ts' || ext === '.tsx'
  const content = isTs ? fs.readFileSync(file, 'utf8') : null
  const imports = isTs ? parseImportSpecifiers(content) : []
  const data_source = isTs ? detectDataSource(content) : 'none'

  return {
    path: repoRel,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    imports,
    data_source,
  }
}

function parseImportSpecifiers(content) {
  const specs = []
  const pattern = /^\s*import\b[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/gm
  let match

  while ((match = pattern.exec(content)) !== null) {
    const s = match[1]
    if (s?.startsWith('.') || s?.startsWith('@/')) specs.push(s)
  }

  return [...new Set(specs)].sort()
}

function parseScriptSpawnSpecifiers(content) {
  const refs = new Set()
  const patterns = [
    /(?:execFile|execSync|spawn)\s*\(\s*(['"`])([\s\S]*?)\1/gm,
    /(?:execFile|spawn)\s*\(\s*[^,]+,\s*\[\s*(['"`])([\s\S]*?)\1/gm,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(content)) !== null) {
      const literal = match[2]
      if (!literal || (!literal.includes('.mjs') && !literal.includes('scripts/'))) continue
      for (const specifier of extractScriptPathCandidates(literal)) refs.add(specifier)
    }
  }

  return [...refs].sort()
}

function extractScriptPathCandidates(value) {
  const refs = []
  const pattern = /(?:^|[^A-Za-z0-9_./-])((?:\.{1,2}\/|scripts\/)[A-Za-z0-9_./-]+\.mjs)(?=$|[^A-Za-z0-9_./-])/g
  let match

  while ((match = pattern.exec(value)) !== null) {
    refs.push(match[1])
  }

  return refs
}

function resolveScriptRefs(importerPath, specifiers, idByAbsPath) {
  const refs = new Set()

  for (const specifier of specifiers) {
    const resolved = resolveScriptRef(importerPath, specifier, idByAbsPath)
    if (resolved) refs.add(resolved)
  }

  return [...refs].sort()
}

function resolveScriptRef(importerPath, specifier, idByAbsPath) {
  if (!specifier) return null
  const normalized = specifier.replace(/\\/g, '/')
  const base = normalized.startsWith('scripts/')
    ? path.resolve(ROOT, normalized)
    : path.resolve(path.dirname(importerPath), normalized)
  const candidates = []
  const ext = path.extname(base).toLowerCase()

  if (ext) {
    candidates.push(base)
  } else {
    candidates.push(
      `${base}.mjs`,
      path.join(base, 'index.mjs'),
    )
  }

  for (const candidate of candidates) {
    const scriptId = idByAbsPath.get(normalizeFsPath(candidate))
    if (scriptId) return scriptId
  }

  return null
}

function extractTeamMemoryReferences(content) {
  const refs = new Set()
  const pattern = /team-memory\/(?:rules|playbooks|decisions)\/[A-Za-z0-9._/-]+(?:\.md)?/g
  let match

  while ((match = pattern.exec(content)) !== null) {
    const ref = sanitizeReferenceCandidate(match[0])
    if (!ref || path.posix.basename(ref).startsWith('_')) continue
    refs.add(ref)
  }

  return [...refs].sort()
}

function resolveCodeRepoImport(importerPath, specifier, idByAbsPath) {
  const base = path.resolve(path.dirname(importerPath), specifier)
  const candidates = []
  const ext = path.extname(base).toLowerCase()

  if (ext) {
    candidates.push(base)
  } else {
    candidates.push(
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, 'index.ts'),
      path.join(base, 'index.tsx'),
    )
  }

  for (const candidate of candidates) {
    const normalized = normalizeFsPath(candidate)
    if (!normalized.startsWith(normalizeFsPath(CODE_REPO_SRC) + '/')) continue
    const nodeId = idByAbsPath.get(normalized)
    if (nodeId) return nodeId
  }

  return null
}

function summarizeCodeRepo(nodes, edges) {
  const bySubtype = tally(nodes, node => node.subtype || 'code-other')
  const importInDegree = new Map(nodes.map(node => [node.id, 0]))

  for (const edge of edges) {
    if (edge.label !== 'imports') continue
    if (!importInDegree.has(edge.to)) continue
    importInDegree.set(edge.to, importInDegree.get(edge.to) + 1)
  }

  const topHubs = [...importInDegree.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([id, importInDegree]) => ({ id, importInDegree }))

  return {
    total: nodes.length,
    bySubtype,
    topHubs,
  }
}

function escapeDot(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ensureGitignoreEntry(entry) {
  const current = fs.existsSync(ROOT_GITIGNORE) ? fs.readFileSync(ROOT_GITIGNORE, 'utf8') : ''
  if (current.includes(entry)) return
  const next = current.endsWith('\n') || current.length === 0 ? current : `${current}\n`
  fs.writeFileSync(ROOT_GITIGNORE, `${next}${entry}\n`, 'utf8')
}

function getGitCommitHash() {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim() || null
  } catch {
    return null
  }
}

function getDateStamp(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isInternalSkillPath(relPath) {
  return relPath.replace(/\\/g, '/').startsWith('skills/_internal/')
}

function classifyCodeRepoSubtype(file) {
  const rel = toCodeRepoRel(file)
  if (/^src\/app\/api(?:\/.*)?\/route\.(ts|tsx)$/i.test(rel)) return 'api-route'
  if (/^src\/app\/.*page\.(ts|tsx)$/i.test(rel)) return 'page'
  if (/^src\/components\/.+\.(ts|tsx)$/i.test(rel)) return 'component'
  if (/^src\/lib\/.+\.ts$/i.test(rel)) return 'lib'
  if (/^migrations\/.+\.sql$/i.test(rel)) return 'migration'
  if (/^drizzle\/.+\.ts$/i.test(rel)) return 'drizzle-schema'
  return 'code-other'
}

function toCodeRepoRel(file) {
  return path.relative(CODE_REPO_ROOT, file).replace(/\\/g, '/')
}

function toCodeRepoNodeId(file) {
  return `../code-repo/${toCodeRepoRel(file)}`
}

function toCodeRepoAbsPath(nodeId) {
  return path.resolve(CODE_REPO_ROOT, nodeId.replace(/^\.\.\/code-repo\//, ''))
}

function normalizeFsPath(file) {
  return path.resolve(file).replace(/\\/g, '/')
}

function toRepoRel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/')
}

function toCanonicalPath(id) {
  return id.replace(/^\.\.\/code-repo\//, '').replace(/\\/g, '/')
}
