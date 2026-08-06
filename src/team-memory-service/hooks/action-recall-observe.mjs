import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const killer = setTimeout(() => process.exit(0), 1500)
const MAX_STDIN_CHARS = 262144
const SENSITIVE_TOKEN = /(bearer|authorization|token|secret|password|api[_-]?key|sk-[a-z0-9])/i
const SENSITIVE_TOKEN_GLOBAL = /(bearer|authorization|token|secret|password|api[_-]?key|sk-[a-z0-9])/gi

function exit() {
  clearTimeout(killer)
  process.exit(0)
}

function readStdin() {
  return new Promise((resolve) => {
    let text = ''
    let capped = false
    process.stdin.on('data', (chunk) => {
      if (capped) return
      const value = chunk.toString('utf8')
      const remaining = MAX_STDIN_CHARS - text.length
      if (remaining <= 0) {
        capped = true
        return
      }
      text += value.slice(0, remaining)
      if (value.length > remaining) capped = true
    })
    process.stdin.on('end', () => resolve(capped ? null : text))
    process.stdin.on('error', () => resolve(null))
  })
}

try {
  const startedAt = Date.now()
  const rawInput = await readStdin()
  if (rawInput === null) exit()
  const input = JSON.parse(rawInput.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
  const toolName = String(input.tool_name || '')
  if (!['Edit', 'Write', 'Bash'].includes(toolName)) exit()

  const toolInput = input.tool_input || {}
  let filePath = ''
  let tokens = []
  if (toolName === 'Edit' || toolName === 'Write') {
    filePath = String(toolInput.file_path || '').replace(/\\/g, '/').toLowerCase()
    const parts = filePath.split('/').filter(Boolean)
    const basename = parts.at(-1) || ''
    const extension = path.posix.extname(basename)
    const stem = extension ? basename.slice(0, -extension.length) : basename
    tokens = [...parts, stem, extension].filter(Boolean)
  } else {
    const command = String(toolInput.command || '').slice(0, 400).toLowerCase()
    tokens = (command.match(/[a-z][a-z0-9._-]{2,}/g) || []).slice(0, 30)
  }
  const traceCtx = toolName === 'Bash' ? [] : tokens.filter((token) => !SENSITIVE_TOKEN.test(token)).slice(0, 10)

  const repoRoot = process.env.TEAM_MEMORY_REPO_ROOT || process.cwd()
  const indexPath = path.join(repoRoot, '.asi', 'cue-index.json')
  const home = process.env.USERPROFILE || process.env.HOME
  const tracePath = path.join(home || '.', '.claude', 'hooks', 'action-recall-trace.jsonl')
  const writeTrace = (event) => {
    try {
      fs.mkdirSync(path.dirname(tracePath), { recursive: true })
      if (fs.existsSync(tracePath) && fs.statSync(tracePath).size > 5 * 1024 * 1024) {
        const rotatedPath = `${tracePath}.1`
        fs.rmSync(rotatedPath, { force: true })
        fs.renameSync(tracePath, rotatedPath)
      }
      const serialized = JSON.stringify(event, (_key, value) => typeof value === 'string'
        ? value.replace(SENSITIVE_TOKEN_GLOBAL, '[redacted]')
        : value)
      fs.appendFileSync(tracePath, `${serialized}\n`, 'utf8')
    } catch {}
  }

  if (!fs.existsSync(indexPath)) {
    writeTrace({
      ts: new Date().toISOString(),
      session_id: input.session_id || null,
      tool_name: toolName,
      ctx: traceCtx,
      hits: [],
      total_candidates: 0,
      cache_age_min: null,
      duration_ms: Date.now() - startedAt,
    })
    exit()
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
  const builtAt = Date.parse(index.built_at)
  const ageMilliseconds = Date.now() - builtAt
  const cacheAgeMinutes = Number.isFinite(ageMilliseconds) ? Math.max(0, Math.floor(ageMilliseconds / 60000)) : null
  if (!Number.isFinite(ageMilliseconds) || ageMilliseconds > 6 * 60 * 60 * 1000) {
    const lockPath = path.join(repoRoot, '.asi', 'cue-index-build.lock')
    let lockIsFresh = false
    try {
      lockIsFresh = Date.now() - fs.statSync(lockPath).mtimeMs < 10 * 60 * 1000
    } catch {}
    if (!lockIsFresh) {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true })
      fs.writeFileSync(lockPath, String(Date.now()), 'utf8')
      const builder = path.join(repoRoot, 'scripts', 'team-memory-service', 'hooks', 'build-cue-index.mjs')
      const child = spawn(process.execPath, [builder], {
        cwd: repoRoot,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, TEAM_MEMORY_REPO_ROOT: repoRoot },
      })
      child.unref()
    }
  }

  const joinedTokens = tokens.join(' ')
  const globRegexCache = new Map()
  const pathMatches = (pattern) => {
    try {
      const value = String(pattern || '').toLowerCase()
      if (!value || !filePath) return false
      if (!value.includes('*')) return filePath.includes(value)
      if (value.length > 120 || (value.match(/\*/g) || []).length > 8) {
        const plain = value.replace(/\*/g, '')
        return Boolean(plain) && filePath.includes(plain)
      }
      if (globRegexCache.has(value)) return globRegexCache.get(value).test(filePath)
      const source = value.startsWith('**/') ? value.slice(3) : value
      const escaped = source.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
      const regex = new RegExp(escaped)
      globRegexCache.set(value, regex)
      return regex.test(filePath)
    } catch {
      return false
    }
  }
  const hits = (Array.isArray(index.entries) ? index.entries : []).map((entry) => {
    const cues = entry.cues || {}
    let score = 0
    for (const cue of Array.isArray(cues.paths) ? cues.paths : []) if (pathMatches(cue)) score += 3
    for (const cue of Array.isArray(cues.cmds) ? cues.cmds : []) if (toolName === 'Bash' && tokens.includes(String(cue).toLowerCase())) score += 2
    for (const cue of Array.isArray(cues.tools) ? cues.tools : []) {
      const value = String(cue).toLowerCase()
      if (value === toolName.toLowerCase() || (toolName === 'Bash' && tokens.includes(value))) score += 2
    }
    for (const cue of Array.isArray(cues.entities) ? cues.entities : []) if (joinedTokens.includes(String(cue).toLowerCase())) score += 1
    const maturity = String(entry.maturity || '').toLowerCase()
    if (maturity === 'proven') score *= 1.2
    else if (maturity === 'verified') score *= 1.1
    return { slug: entry.slug, score }
  }).filter((entry) => entry.score >= 2).sort((left, right) => right.score - left.score).slice(0, 3)

  writeTrace({
    ts: new Date().toISOString(),
    session_id: input.session_id || null,
    tool_name: toolName,
    ctx: traceCtx,
    hits,
    total_candidates: Array.isArray(index.entries) ? index.entries.length : 0,
    cache_age_min: cacheAgeMinutes,
    duration_ms: Date.now() - startedAt,
  })
  exit()
} catch {
  exit()
}
