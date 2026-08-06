#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..'))
const TEAM_MEMORY = path.join(ROOT, 'team-memory')
const METRIC_PATH = path.join(ROOT, '.asi', 'kos-query-reflex-metrics.jsonl')
const REPORT_DIR = path.join(ROOT, 'dream-reports')

const PROTECTED_DIRS = new Set(['_archive', 'pointers'])
const PROTECTED_MATURITY = new Set(['proven', 'verified'])
const EPHEMERAL_RE = /^(\.|CLAUDE\.local\.md)/

function usage() {
  console.error('Usage: node scripts/kos/kos-dream-cycle.mjs [--phase link-fix|prune-cold|expired|stale-draft|all] [--cold-days 30] [--stale-days 45] [--format text|json] [--write-report] [--apply-link-fixes]')
}

function parseArgs(argv) {
  const args = { phase: 'all', coldDays: 30, staleDays: 45, format: 'text', writeReport: false, applyLinkFixes: false }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    const eq = raw.indexOf('=')
    const flag = eq >= 0 ? raw.slice(0, eq) : raw
    const readValue = () => {
      if (eq >= 0) return raw.slice(eq + 1)
      i += 1
      return argv[i]
    }
    if (flag === '--phase') args.phase = readValue()
    else if (flag === '--cold-days') args.coldDays = Number.parseInt(readValue(), 10)
    else if (flag === '--stale-days') args.staleDays = Number.parseInt(readValue(), 10)
    else if (flag === '--format') args.format = readValue()
    else if (flag === '--write-report') args.writeReport = true
    else if (flag === '--apply-link-fixes') args.applyLinkFixes = true
    else return { error: `unknown option: ${raw}` }
  }
  if (!['all', 'link-fix', 'prune-cold', 'expired', 'stale-draft'].includes(args.phase)) return { error: '--phase must be all | link-fix | prune-cold | expired | stale-draft' }
  if (!Number.isInteger(args.coldDays) || args.coldDays < 1) return { error: '--cold-days must be a positive integer' }
  if (!Number.isInteger(args.staleDays) || args.staleDays < 1) return { error: '--stale-days must be a positive integer' }
  if (!['text', 'json'].includes(args.format)) return { error: '--format must be text or json' }
  return { args }
}

function walkMd(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (PROTECTED_DIRS.has(entry.name)) continue
      walkMd(abs, acc)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      acc.push(abs)
    }
  }
  return acc
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { fm: {} }
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) return { fm: {} }
  const block = text.slice(4, end)
  const fm = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (!m) continue
    fm[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return { fm }
}

function relPath(abs) {
  return path.relative(ROOT, abs).replace(/\\/g, '/')
}

function buildBasenameIndex() {
  const index = new Map()
  const walkAll = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walkAll(abs)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const key = entry.name.toLowerCase()
        if (!index.has(key)) index.set(key, [])
        index.get(key).push(relPath(abs))
      }
    }
  }
  walkAll(TEAM_MEMORY)
  return index
}

function toSourceRelative(file, repoRelTarget) {
  const rel = path.relative(path.dirname(file), path.join(ROOT, repoRelTarget)).replace(/\\/g, '/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

function classifyLink(file, target, basenameIndex) {
  const cleaned = target.split('#')[0].split(' ')[0]
  if (fs.existsSync(path.resolve(path.dirname(file), cleaned))) return { kind: 'ok' }
  if (!cleaned.startsWith('.') && !path.isAbsolute(cleaned)) {
    if (fs.existsSync(path.resolve(ROOT, cleaned))) return { kind: 'ok' }
  }
  const resolved = path.resolve(path.dirname(file), cleaned)
  const insideRoot = resolved === ROOT || resolved.startsWith(ROOT + path.sep)
  if (path.isAbsolute(cleaned) || !insideRoot) return { kind: 'external', reason: 'outside-repo' }
  if (EPHEMERAL_RE.test(relPath(resolved))) return { kind: 'external', reason: 'ephemeral' }
  const candidates = basenameIndex.get(path.basename(cleaned).toLowerCase()) || []
  const selfRef = candidates.length === 1 && candidates[0] === relPath(file)
  return {
    kind: 'broken',
    suggestion: selfRef || candidates.length !== 1 ? null : candidates[0],
    candidates: candidates.length > 1 ? candidates : undefined,
    note: selfRef ? 'self-reference — likely a pointer template written for another directory' : undefined,
  }
}

function phaseLinkFix(files, basenameIndex, applyFixes) {
  const broken = []
  const external = []
  let fixedCount = 0
  const linkRe = /\[[^\]]+\]\(([^)]+\.md)(?:#[^)]*)?\)/g
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8')
    const edits = []
    let m
    while ((m = linkRe.exec(text)) !== null) {
      const target = m[1].trim()
      if (target.startsWith('http://') || target.startsWith('https://')) continue
      const verdict = classifyLink(file, target, basenameIndex)
      if (verdict.kind === 'ok') continue
      const lineNo = text.slice(0, m.index).split('\n').length
      const record = { from: relPath(file), line: lineNo, target }
      if (verdict.kind === 'external') {
        external.push({ ...record, reason: verdict.reason })
        continue
      }
      record.suggestion = verdict.suggestion
      if (verdict.candidates) record.candidates = verdict.candidates
      if (verdict.note) record.note = verdict.note
      broken.push(record)
      if (applyFixes && verdict.suggestion) {
        const start = m.index + m[0].lastIndexOf(m[1])
        edits.push({ start, end: start + m[1].length, replacement: toSourceRelative(file, verdict.suggestion) })
        record.fixed_to = toSourceRelative(file, verdict.suggestion)
      }
    }
    linkRe.lastIndex = 0
    if (edits.length) {
      let next = text
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end)
      }
      fs.writeFileSync(file, next, 'utf-8')
      fixedCount += edits.length
    }
  }
  return { broken, external, fixedCount }
}

function teamMemoryPath(sourceFile) {
  if (!sourceFile) return null
  const source = String(sourceFile).trim().replace(/\\/g, '/')
  if (!source) return null
  const root = ROOT.replace(/\\/g, '/')
  if (source.startsWith(`${root}/`)) return source.slice(root.length + 1)
  const marker = '/team-memory/'
  const markerIndex = source.indexOf(marker)
  if (markerIndex >= 0) return source.slice(markerIndex + 1)
  if (source.startsWith('team-memory/')) return source
  return `team-memory/${source.replace(/^\.\//, '')}`
}

function loadMetricRecallHits() {
  const hits = new Set()
  if (!fs.existsSync(METRIC_PATH)) return hits
  for (const line of fs.readFileSync(METRIC_PATH, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!Array.isArray(row.retrieved_paths)) continue
    for (const p of row.retrieved_paths) {
      const rel = teamMemoryPath(p && p.path)
      if (rel) hits.add(rel)
    }
  }
  return hits
}

async function loadRecallData(recallDays) {
  let closePool = null
  try {
    const db = await import('../team-memory-service/lib/db.mjs')
    closePool = db.closePool
    const result = await db.query(
      `SELECT source_file
       FROM team_memory.memories
       WHERE source_file IS NOT NULL
         AND last_accessed >= now() - ($1 * interval '1 day')`,
      [recallDays]
    )
    const hits = new Set()
    for (const row of result.rows) {
      const rel = teamMemoryPath(row.source_file)
      if (rel) hits.add(rel)
    }
    return { source: 'pg', hits }
  } catch {
    const hits = loadMetricRecallHits()
    return { source: hits.size > 0 || fs.existsSync(METRIC_PATH) ? 'metric-file' : 'none', hits }
  } finally {
    if (closePool) {
      try { await closePool() } catch { /* 只读扫描结束时关闭失败不影响降级语义 */ }
    }
  }
}

function lastActivity(file, fm) {
  let activityMs = fs.statSync(file).mtimeMs
  if (fm.last_verified) {
    const verifiedMs = Date.parse(fm.last_verified)
    if (Number.isFinite(verifiedMs)) activityMs = Math.max(activityMs, verifiedMs)
  }
  return activityMs
}

function phasePruneCold(files, coldDays, recallHits) {
  const thresholdMs = Date.now() - coldDays * 24 * 60 * 60 * 1000
  const cold = []
  for (const file of files) {
    const rel = relPath(file)
    if (rel.startsWith('team-memory/_archive/')) continue
    const text = fs.readFileSync(file, 'utf-8')
    const { fm } = parseFrontmatter(text)
    const maturity = (fm.maturity || '').toLowerCase()
    if (PROTECTED_MATURITY.has(maturity)) continue
    if (rel.startsWith('docs/architecture/adr-')) continue
    if (/\/ADR-\d+/i.test(rel)) continue  // legacy ADRs in team-memory/decisions/
    if (rel.includes('-iron-')) continue
    const activityMs = lastActivity(file, fm)
    if (activityMs > thresholdMs) continue
    if (recallHits.has(rel)) continue
    cold.push({
      path: rel,
      maturity: maturity || '(none)',
      last_activity_iso: new Date(activityMs).toISOString().slice(0, 10),
      age_days: Math.floor((Date.now() - activityMs) / (24 * 60 * 60 * 1000)),
    })
  }
  cold.sort((a, b) => b.age_days - a.age_days)
  return cold
}

function phaseExpired(files) {
  const today = new Date().toISOString().slice(0, 10)
  const expired = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8')
    const { fm } = parseFrontmatter(text)
    const validUntil = fm.valid_until || fm.expires_at
    const date = typeof validUntil === 'string' ? validUntil.slice(0, 10) : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= today) continue
    expired.push({
      path: relPath(file),
      valid_until: date,
      maturity: (fm.maturity || '').toLowerCase() || '(none)',
      suggestion: 'status: deprecated',
    })
  }
  expired.sort((a, b) => a.valid_until.localeCompare(b.valid_until) || a.path.localeCompare(b.path))
  return expired
}

function phaseStaleDraft(files, staleDays, recallHits) {
  const thresholdMs = Date.now() - staleDays * 24 * 60 * 60 * 1000
  const staleDrafts = []
  for (const file of files) {
    const rel = relPath(file)
    const text = fs.readFileSync(file, 'utf-8')
    const { fm } = parseFrontmatter(text)
    if ((fm.maturity || '').toLowerCase() !== 'draft') continue
    if (recallHits.has(rel)) continue
    const activityMs = lastActivity(file, fm)
    if (activityMs > thresholdMs) continue
    staleDrafts.push({
      path: rel,
      maturity: 'draft',
      last_activity_iso: new Date(activityMs).toISOString().slice(0, 10),
      age_days: Math.floor((Date.now() - activityMs) / (24 * 60 * 60 * 1000)),
      suggestion: 'review for demotion',
    })
  }
  staleDrafts.sort((a, b) => b.age_days - a.age_days || a.path.localeCompare(b.path))
  return staleDrafts
}

function printText({ broken, externalLinks, cold, expired, staleDrafts, recallSource, args }) {
  console.log(`KOS-Plus dream-cycle · ${new Date().toISOString().slice(0, 10)} · recall source: ${recallSource}`)
  if (args.phase === 'all' || args.phase === 'link-fix') {
    const repairable = broken.filter((b) => b.suggestion).length
    console.log(`\n[Phase 1: link-fix] ${broken.length} broken inner link(s) · ${repairable} auto-repairable · ${externalLinks.length} external (unverifiable, not counted as broken)`)
    for (const b of broken.slice(0, 50)) {
      const hint = b.suggestion ? `   [→ ${b.suggestion}]` : (b.candidates ? `   [${b.candidates.length} candidates]` : (b.note ? `   [${b.note}]` : ''))
      console.log(`  ${b.from}:${b.line}  →  ${b.target}${hint}`)
    }
    if (broken.length > 50) console.log(`  ...and ${broken.length - 50} more`)
  }
  if (args.phase === 'all' || args.phase === 'prune-cold') {
    console.log(`\n[Phase 2: prune-cold] ${cold.length} cold memory file(s) (age > ${args.coldDays}d, maturity not proven/verified, zero recall hits)`)
    for (const c of cold.slice(0, 50)) {
      console.log(`  ${c.age_days}d  ${c.maturity.padEnd(10)}  ${c.path}`)
    }
    if (cold.length > 50) console.log(`  ...and ${cold.length - 50} more`)
  }
  if (args.phase === 'all' || args.phase === 'expired') {
    console.log(`\n[Phase 3: expired] ${expired.length} expired memory file(s) (valid_until/expires_at before today)`)
    for (const item of expired.slice(0, 50)) {
      console.log(`  ${item.valid_until}  ${item.maturity.padEnd(10)}  ${item.path}`)
    }
    if (expired.length > 50) console.log(`  ...and ${expired.length - 50} more`)
  }
  if (args.phase === 'all' || args.phase === 'stale-draft') {
    console.log(`\n[Phase 4: stale-draft] ${staleDrafts.length} demote candidate(s) (draft, age > ${args.staleDays}d, zero recall hits)`)
    for (const item of staleDrafts.slice(0, 50)) {
      console.log(`  ${item.age_days}d  ${item.path}`)
    }
    if (staleDrafts.length > 50) console.log(`  ...and ${staleDrafts.length - 50} more`)
  }
  console.log('\n(report-only — review then archive manually via: git mv <path> team-memory/_archive/)')
}

function renderReport({ broken, externalLinks, cold, expired, staleDrafts, recallSource, args }) {
  const today = new Date().toISOString().slice(0, 10)
  const lines = []
  lines.push(`# Dream-Cycle Report · ${today}`)
  lines.push('')
  lines.push(`Generated by \`scripts/kos/kos-dream-cycle.mjs\` (KOS-Plus v1 Wave 4.1 · recall source: \`${recallSource}\`).`)
  lines.push('')
  if (args.phase === 'all' || args.phase === 'link-fix') {
    lines.push(`## Phase 1 · Broken inner links (${broken.length})`)
    lines.push('')
    if (broken.length === 0) {
      lines.push('_None found._')
    } else {
      lines.push('| From | Line | Broken Target | Suggested fix |')
      lines.push('|---|---|---|---|')
      for (const b of broken) {
        const hint = b.suggestion ? `\`${b.suggestion}\`` : (b.candidates ? `${b.candidates.length} candidates — needs owner` : '_no in-repo match_')
        lines.push(`| \`${b.from}\` | ${b.line} | \`${b.target}\` | ${hint} |`)
      }
      lines.push('')
      lines.push('Run `node scripts/kos/kos-dream-cycle.mjs --phase link-fix --apply-link-fixes` to rewrite the unique-match rows.')
    }
    lines.push('')
    lines.push(`### External pointers (${externalLinks.length}) — outside the repo or gitignored, not broken`)
    lines.push('')
    if (externalLinks.length === 0) {
      lines.push('_None._')
    } else {
      lines.push('| From | Line | Target | Reason |')
      lines.push('|---|---|---|---|')
      for (const e of externalLinks) {
        lines.push(`| \`${e.from}\` | ${e.line} | \`${e.target}\` | ${e.reason} |`)
      }
    }
    lines.push('')
  }
  if (args.phase === 'all' || args.phase === 'prune-cold') {
    lines.push(`## Phase 2 · Cold memories (age > ${args.coldDays}d, ${cold.length})`)
    lines.push('')
    if (cold.length === 0) {
      lines.push('_None found._')
    } else {
      lines.push('| Age (days) | Maturity | Path |')
      lines.push('|---|---|---|')
      for (const c of cold) {
        lines.push(`| ${c.age_days} | ${c.maturity} | \`${c.path}\` |`)
      }
    }
    lines.push('')
  }
  if (args.phase === 'all' || args.phase === 'expired') {
    lines.push(`## Phase 3 · Expired memories (${expired.length})`)
    lines.push('')
    if (expired.length === 0) {
      lines.push('_None found._')
    } else {
      lines.push('| Valid until | Maturity | Path | Suggestion |')
      lines.push('|---|---|---|---|')
      for (const item of expired) {
        lines.push(`| ${item.valid_until} | ${item.maturity} | \`${item.path}\` | ${item.suggestion} |`)
      }
    }
    lines.push('')
  }
  if (args.phase === 'all' || args.phase === 'stale-draft') {
    lines.push(`## Phase 4 · Stale draft demote candidates (age > ${args.staleDays}d, ${staleDrafts.length})`)
    lines.push('')
    if (staleDrafts.length === 0) {
      lines.push('_None found._')
    } else {
      lines.push('| Age (days) | Last activity | Path | Suggestion |')
      lines.push('|---|---|---|---|')
      for (const item of staleDrafts) {
        lines.push(`| ${item.age_days} | ${item.last_activity_iso} | \`${item.path}\` | ${item.suggestion} |`)
      }
    }
    lines.push('')
  }
  lines.push('---')
  lines.push('Action: review entries, then `git mv <path> team-memory/_archive/` for prunable ones; fix broken links in source files.')
  return lines.join('\n') + '\n'
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(parsed.error)
    usage()
    process.exit(2)
  }
  const { args } = parsed
  const files = walkMd(TEAM_MEMORY)
  const runLinkFix = args.phase === 'all' || args.phase === 'link-fix'
  const linkResult = runLinkFix
    ? phaseLinkFix(files, buildBasenameIndex(), args.applyLinkFixes)
    : { broken: [], external: [], fixedCount: 0 }
  const { broken, external: externalLinks, fixedCount } = linkResult
  if (args.applyLinkFixes) {
    console.error(`[kos-dream-cycle] rewrote ${fixedCount} link(s) with a unique in-repo match`)
  }
  const recallData = await loadRecallData(Math.max(args.coldDays, args.staleDays))
  const cold = (args.phase === 'all' || args.phase === 'prune-cold') ? phasePruneCold(files, args.coldDays, recallData.hits) : []
  const expired = (args.phase === 'all' || args.phase === 'expired') ? phaseExpired(files) : []
  const staleDrafts = (args.phase === 'all' || args.phase === 'stale-draft') ? phaseStaleDraft(files, args.staleDays, recallData.hits) : []

  if (args.writeReport) {
    fs.mkdirSync(REPORT_DIR, { recursive: true })
    const today = new Date().toISOString().slice(0, 10)
    const reportPath = path.join(REPORT_DIR, `${today}.md`)
    fs.writeFileSync(reportPath, renderReport({ broken, externalLinks, cold, expired, staleDrafts, recallSource: recallData.source, args }), 'utf-8')
    console.error(`[kos-dream-cycle] report written to ${path.relative(ROOT, reportPath).replace(/\\/g, '/')}`)
  }

  if (args.format === 'json') {
    console.log(JSON.stringify({
      generated_at: new Date().toISOString(),
      phase: args.phase,
      cold_days_threshold: args.coldDays,
      stale_days_threshold: args.staleDays,
      recall_source: recallData.source,
      broken_links: broken,
      external_links: externalLinks,
      links_rewritten: fixedCount,
      cold_memories: cold,
      expired_memories: expired,
      stale_draft_candidates: staleDrafts,
    }, null, 2))
  } else {
    printText({ broken, externalLinks, cold, expired, staleDrafts, recallSource: recallData.source, args })
  }
}

main()
