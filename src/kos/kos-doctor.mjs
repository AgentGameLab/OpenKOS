#!/usr/bin/env node
// ============================================================
// scripts/kos/onboard/kos-doctor.mjs — one-shot KOS onboarding health check (Cursor side)
//
// Design: docs(xqq)/kos-onboarding-coverage-design.md v1.1 §5.
// A self-service tool for Cursor users self-hosted network: 4 checks, pass/fail output plus a
// fix for each, so a problem can be located in about a minute.
// The "real recall" check doubles as an install receipt: source + query carry a version tag into
// recall_log, so the service gets install-state/version observability with zero changes on its
// side (parsed by coverage-cron).
//
// Usage:
//   node kos-doctor.mjs                    # self-check (source=kos-doctor)
//   node kos-doctor.mjs --source kos-install   # called by the installer (receipt tagged install)
//   node kos-doctor.mjs --url https://<vm8>:3000   # override the service address (defaults to mcp.json)
//
// exit: 0=all green / 1=at least one failure (the installer uses this to decide install failed)
// ============================================================

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const PKG_VERSION = '1.0.0'   // installer package version; bump together with install.mjs/README on release

const HOME = process.env.USERPROFILE || homedir()
const MCP_JSON = join(HOME, '.cursor', 'mcp.json')
const SERVER_KEY = 'team-memory'

const argv = process.argv.slice(2)
const flagOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}

const green = (s) => `\x1b[32m✅ ${s}\x1b[0m`
const red = (s) => `\x1b[31m❌ ${s}\x1b[0m`
const dim = (s) => `\x1b[2m   ${s}\x1b[0m`

// Each check returns { ok, label, fix? , data? }
function checkMcpJson() {
  if (!existsSync(MCP_JSON)) {
    return { ok: false, label: `Cursor MCP config not found: ${MCP_JSON}`, fix: 'run the installer (install.bat/install.sh) to write the config' }
  }
  let conf
  try { conf = JSON.parse(readFileSync(MCP_JSON, 'utf-8')) }
  catch (e) { return { ok: false, label: `mcp.json is not valid JSON: ${e.message}`, fix: 'fix the JSON syntax, or delete the file and re-run the installer (it backs up automatically)' } }
  const entry = conf.mcpServers?.[SERVER_KEY]
  if (!entry) return { ok: false, label: `mcp.json has no ${SERVER_KEY} entry`, fix: 're-run the installer' }
  const token = entry.headers?.Authorization?.replace(/^Bearer\s+/i, '')
  if (!entry.url) return { ok: false, label: `${SERVER_KEY} entry has no url`, fix: 're-run the installer' }
  if (!token || !token.startsWith('kos_')) return { ok: false, label: `${SERVER_KEY} entry token is missing or malformed (must start with kos_)`, fix: 're-run the installer with a valid token (request one from your admin)' }
  return { ok: true, label: `mcp.json config complete (${SERVER_KEY} → ${entry.url})`, data: { url: entry.url, token } }
}

async function checkHealth(base) {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return { ok: false, label: `service /health HTTP ${r.status}`, fix: 'server-side failure, contact your admin; on an self-hosted network, confirm the KOS channel (firewall/allowlist) has not changed' }
    const j = await r.json()
    return { ok: true, label: `service reachable (${j.server} up ${Math.round((j.uptime_sec || 0) / 3600)}h)` }
  } catch (e) {
    return { ok: false, label: `service unreachable: ${e.message}`, fix: `check that ${base} is reachable (self-hosted network → KOS channel); if the URL changed, re-run the installer with --url <new address>` }
  }
}

async function checkRecall(base, token, source) {
  try {
    const r = await fetch(`${base}/api/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: `[kos-onboard-ack] v${PKG_VERSION} ${source}`, limit: 1, source }),
      signal: AbortSignal.timeout(15000),
    })
    if (r.status === 401 || r.status === 403) return { ok: false, label: `token rejected (HTTP ${r.status})`, fix: 'token is invalid/expired/revoked — request a new one from your admin and re-run the installer' }
    if (!r.ok) return { ok: false, label: `recall endpoint HTTP ${r.status}`, fix: 'server-side failure, contact your admin' }
    const j = await r.json()
    const n = j.hits?.length ?? j.results?.length ?? (Array.isArray(j) ? j.length : 0)
    return { ok: true, label: `recall path works (${n} hits returned; this call is the install receipt v${PKG_VERSION})` }
  } catch (e) {
    return { ok: false, label: `recall request failed: ${e.message}`, fix: 'network or server-side problem, contact your admin' }
  }
}

export async function runDoctor({ urlOverride = null, source = 'kos-doctor' } = {}) {
  console.log(`\nKOS onboarding health check v${PKG_VERSION} · ${new Date().toISOString().slice(0, 19)}\n`)
  const results = []

  const c1 = checkMcpJson()
  results.push(c1)
  console.log(c1.ok ? green(c1.label) : red(c1.label))
  if (!c1.ok) console.log(dim(`Fix: ${c1.fix}`))

  if (c1.ok || urlOverride) {
    const base = (urlOverride || c1.data.url).replace(/\/mcp\/?$/, '')   // mcp endpoint → service root
    const c2 = await checkHealth(base)
    results.push(c2)
    console.log(c2.ok ? green(c2.label) : red(c2.label))
    if (!c2.ok) console.log(dim(`Fix: ${c2.fix}`))

    if (c2.ok && c1.ok) {
      const c3 = await checkRecall(base, c1.data.token, source)
      results.push(c3)
      console.log(c3.ok ? green(c3.label) : red(c3.label))
      if (!c3.ok) console.log(dim(`Fix: ${c3.fix}`))
    }
  }

  const allOk = results.every(r => r.ok) && results.length >= 3
  console.log(allOk
    ? `\n${green('All checks passed — KOS onboarding is healthy')}\n`
    : `\n${red('Problems found — apply the fixes above and re-run; if you are stuck, send this output to your admin')}\n`)
  return allOk
}

if (process.argv[1] && process.argv[1].endsWith('kos-doctor.mjs')) {
  runDoctor({ urlOverride: flagOf('url', null), source: flagOf('source', 'kos-doctor') })
    .then(ok => process.exit(ok ? 0 : 1))
    .catch(e => { console.error(red(`doctor itself crashed: ${e.message}`)); process.exit(1) })
}
