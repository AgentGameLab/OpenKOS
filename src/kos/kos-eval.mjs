#!/usr/bin/env node
// kos-eval · KOS-Plus v1 P1.2 Wave 3.2
// Replay historical queries captured in .asi/kos-query-reflex-metrics.jsonl
// against the current kos-recall algorithm. Computes Jaccard@k, top-1
// stability, and latency stats. Zero LLM.
//
// Usage:
//   node scripts/kos/kos-eval.mjs replay [--since <ISO>] [--limit N]
//                                        [--k 5] [--format json|text]

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..')
const METRIC_PATH = path.join(ROOT, '.asi', 'kos-query-reflex-metrics.jsonl')
const KOS_RECALL = url.fileURLToPath(new URL('./kos-recall.mjs', import.meta.url))

function usage() {
  console.error('Usage: node scripts/kos/kos-eval.mjs replay [--since <ISO>] [--limit N] [--k 5] [--format json|text]')
}

function parseArgs(argv) {
  const args = { command: argv[0] || '', since: null, limit: Infinity, k: 5, format: 'text' }
  for (let i = 1; i < argv.length; i++) {
    const raw = argv[i]
    const eq = raw.indexOf('=')
    const flag = eq >= 0 ? raw.slice(0, eq) : raw
    const readValue = () => {
      if (eq >= 0) return raw.slice(eq + 1)
      i += 1
      return argv[i]
    }
    if (flag === '--since') args.since = readValue()
    else if (flag === '--limit') args.limit = Number.parseInt(readValue(), 10)
    else if (flag === '--k') args.k = Number.parseInt(readValue(), 10)
    else if (flag === '--format') args.format = readValue()
    else return { error: `unknown option: ${raw}` }
  }
  if (args.command !== 'replay') return { error: 'first arg must be: replay' }
  if (!Number.isFinite(args.limit) || args.limit < 1) args.limit = Infinity
  if (!Number.isInteger(args.k) || args.k < 1) args.k = 5
  if (args.format !== 'json' && args.format !== 'text') return { error: '--format must be json or text' }
  return { args }
}

function loadHistory(args) {
  if (!fs.existsSync(METRIC_PATH)) return []
  const lines = fs.readFileSync(METRIC_PATH, 'utf-8').split('\n').filter(Boolean)
  const sinceMs = args.since ? Date.parse(args.since) : null
  const out = []
  for (const line of lines) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if ((row.schema_version || 0) < 2) continue
    if (!Array.isArray(row.retrieved_paths)) continue
    if (!row.query) continue
    if (sinceMs && Date.parse(row.ts) < sinceMs) continue
    out.push(row)
    if (out.length >= args.limit) break
  }
  return out
}

function rerunRecall(query, k) {
  const start = process.hrtime.bigint()
  let raw
  try {
    raw = execFileSync(process.execPath, [KOS_RECALL, '--query', query, '--limit', String(k), '--format', 'json'], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return { paths: [], latency_ms: null, error: 'recall_failed' }
  }
  const elapsedMs = Number((process.hrtime.bigint() - start) / 1000000n)
  let arr = []
  try {
    const parsed = JSON.parse(raw.trim() || '[]')
    arr = Array.isArray(parsed) ? parsed : []
  } catch {
    return { paths: [], latency_ms: elapsedMs, error: 'parse_failed' }
  }
  const paths = arr.slice(0, k).map((r, i) => ({
    rank: i + 1,
    path: r.path || '',
    score: Number(r.score) || 0,
  })).filter(p => p.path)
  return { paths, latency_ms: elapsedMs }
}

function jaccard(oldSet, newSet) {
  if (oldSet.size === 0 && newSet.size === 0) return 1
  let inter = 0
  for (const v of oldSet) if (newSet.has(v)) inter += 1
  const union = oldSet.size + newSet.size - inter
  return union === 0 ? 0 : inter / union
}

function compareOne(oldRow, k) {
  const oldPaths = oldRow.retrieved_paths.slice(0, k).map(p => p.path).filter(Boolean)
  const oldSet = new Set(oldPaths)
  const oldTop1 = oldPaths[0] || null
  const fresh = rerunRecall(oldRow.query, k)
  const newPaths = fresh.paths.map(p => p.path)
  const newSet = new Set(newPaths)
  const newTop1 = newPaths[0] || null
  return {
    query: oldRow.query,
    ts: oldRow.ts,
    old_k: oldPaths.length,
    new_k: newPaths.length,
    jaccard: jaccard(oldSet, newSet),
    top1_stable: oldTop1 === newTop1,
    old_top1: oldTop1,
    new_top1: newTop1,
    new_latency_ms: fresh.latency_ms,
    error: fresh.error || null,
  }
}

function summarize(rows, k) {
  if (rows.length === 0) {
    return {
      n: 0,
      n_valid: 0,
      k,
      mean_jaccard: null,
      top1_stable_ratio: null,
      mean_latency_ms: null,
      mismatches: [],
    }
  }
  const validJ = rows.filter(r => !r.error)
  const totalJ = validJ.reduce((s, r) => s + r.jaccard, 0)
  const stable = validJ.filter(r => r.top1_stable).length
  const validL = validJ.filter(r => Number.isFinite(r.new_latency_ms))
  const meanL = validL.length ? validL.reduce((s, r) => s + r.new_latency_ms, 0) / validL.length : null
  const mismatches = validJ.filter(r => !r.top1_stable).slice(0, 10).map(r => ({
    query: r.query,
    old_top1: r.old_top1,
    new_top1: r.new_top1,
    jaccard: Number(r.jaccard.toFixed(3)),
  }))
  return {
    n: rows.length,
    n_valid: validJ.length,
    k,
    mean_jaccard: validJ.length ? Number((totalJ / validJ.length).toFixed(3)) : null,
    top1_stable_ratio: validJ.length ? Number((stable / validJ.length).toFixed(3)) : null,
    mean_latency_ms: meanL != null ? Number(meanL.toFixed(1)) : null,
    mismatches,
  }
}

function printText(summary) {
  console.log(`KOS-Plus eval replay · k=${summary.k} · n=${summary.n} (valid=${summary.n_valid || 0})`)
  if (summary.n === 0) {
    console.log('(no historical queries with schema_version >= 2 found — capture more usage first)')
    return
  }
  console.log(`  mean Jaccard@${summary.k}    : ${summary.mean_jaccard ?? 'N/A'}`)
  console.log(`  top-1 stable ratio   : ${summary.top1_stable_ratio ?? 'N/A'}`)
  console.log(`  mean new latency (ms): ${summary.mean_latency_ms ?? 'N/A'}`)
  if (summary.mismatches.length) {
    console.log(`\nTop-1 mismatches (up to 10):`)
    for (const m of summary.mismatches) {
      console.log(`  - "${m.query}" J=${m.jaccard}`)
      console.log(`      old → ${m.old_top1}`)
      console.log(`      new → ${m.new_top1}`)
    }
  }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(parsed.error)
    usage()
    process.exit(2)
  }
  const { args } = parsed
  const history = loadHistory(args)
  const compared = history.map(row => compareOne(row, args.k))
  const summary = summarize(compared, args.k)
  if (args.format === 'json') {
    console.log(JSON.stringify({ summary, rows: compared }, null, 2))
  } else {
    printText(summary)
  }
}

main()
