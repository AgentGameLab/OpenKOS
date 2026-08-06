#!/usr/bin/env node

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..')
const DEFAULT_PORT = 7321
const MAX_PORT = 7330
const DEFAULT_REMOTE_POLL = 60
const LOCAL_DEBOUNCE_MS = 1000
const SSE_KEEPALIVE_MS = 15000
const GRAPH_HTML = path.join(ROOT, 'team-memory', '.knowledge-graph.html')
const GRAPH_JSON = path.join(ROOT, 'team-memory', '.knowledge-graph.json')
const RENDER_HTML = fileURLToPath(new URL('./render-html.mjs', import.meta.url))
const QUERY_LIB = fileURLToPath(new URL('./queries/_lib.mjs', import.meta.url))
const WATCH_TARGETS = [
  'team-memory',
  'skills',
  'docs',
  path.join('.claude', 'hooks'),
  path.join('.claude', 'rules'),
  'scripts',
]
const GENERATED_FILES = new Set([
  '.knowledge-graph.dot',
  '.knowledge-graph.html',
  '.knowledge-graph.json',
  '.knowledge-graph.tfidf.json',
])

const args = parseArgs(process.argv.slice(2))
const state = {
  clients: new Set(),
  keepaliveTimer: null,
  localTimer: null,
  remoteTimer: null,
  remoteBusy: false,
  shuttingDown: false,
  server: null,
  port: args.port,
  watchedPaths: WATCH_TARGETS.map((rel) => path.join(ROOT, rel)).filter((full) => fs.existsSync(full)),
  watchers: [],
  warned: new Set(),
  lastRemoteSha: readGit(['rev-parse', 'origin/main']),
  renderModulePromise: null,
  queryModulePromise: null,
}

await main()

async function main() {
  process.on('SIGINT', shutdown)

  state.server = http.createServer((req, res) => {
    void handleRequest(req, res)
  })

  state.port = await listenWithFallback(state.server, args.port, MAX_PORT)
  startWatchers()
  startKeepalive()
  startRemotePolling()

  const pollText = args.remotePoll > 0
    ? `polling origin/main every ${args.remotePoll}s`
    : 'remote polling disabled'
  console.log(`🕸 KG server: http://localhost:${state.port}/  (watching ${state.watchedPaths.length} source dirs, ${pollText})`)
  if (!args.noOpen) openBrowser(`http://localhost:${state.port}/`)
}

function parseArgs(argv) {
  let port = DEFAULT_PORT
  let noOpen = false
  let remotePoll = DEFAULT_REMOTE_POLL

  for (const arg of argv) {
    if (arg === '--no-open') {
      noOpen = true
      continue
    }
    if (arg.startsWith('--port=')) {
      const value = Number(arg.slice('--port='.length))
      if (Number.isInteger(value) && value > 0) port = value
      continue
    }
    if (arg.startsWith('--remote-poll=')) {
      const value = Number(arg.slice('--remote-poll='.length))
      if (Number.isFinite(value) && value >= 0) remotePoll = value
    }
  }

  return { port, noOpen, remotePoll }
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || '/', `http://localhost:${state.port}`)

  if (requestUrl.pathname === '/') {
    const result = await ensureHtmlFresh()
    if (result.kind === 'html' && fs.existsSync(GRAPH_HTML)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(fs.readFileSync(GRAPH_HTML, 'utf8'))
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(result.message)
    return
  }

  if (requestUrl.pathname === '/graph.json') {
    try {
      const graph = await loadGraphJson()
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify(graph))
    } catch (error) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify({ error: error.message }))
    }
    return
  }

  if (requestUrl.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    state.clients.add(res)
    req.on('close', () => state.clients.delete(res))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

function startWatchers() {
  for (const full of state.watchedPaths) {
    try {
      const watcher = fs.watch(full, { recursive: true }, (_eventType, filename) => {
        if (shouldIgnoreWatch(filename)) return
        if (state.localTimer) clearTimeout(state.localTimer)
        state.localTimer = setTimeout(() => {
          state.localTimer = null
          broadcastReload('local-source', readGitShort('HEAD'))
        }, LOCAL_DEBOUNCE_MS)
      })
      watcher.on('error', (error) => warnOnce(`watch:${full}`, `watch error for ${toRepoPath(full)}: ${error.message}`))
      state.watchers.push(watcher)
    } catch (error) {
      warnOnce(`watch:${full}`, `watch unavailable for ${toRepoPath(full)}: ${error.message}`)
    }
  }
}

function startKeepalive() {
  state.keepaliveTimer = setInterval(() => {
    for (const client of state.clients) {
      try {
        client.write(': keep-alive\n\n')
      } catch {
        state.clients.delete(client)
      }
    }
  }, SSE_KEEPALIVE_MS)
}

function startRemotePolling() {
  if (args.remotePoll <= 0) return
  state.remoteTimer = setInterval(() => {
    if (state.shuttingDown || state.remoteBusy) return
    state.remoteBusy = true
    try {
      runGit(['fetch', 'origin', 'main', '--quiet'])
      const nextSha = readGit(['rev-parse', 'origin/main'])
      if (nextSha && nextSha !== state.lastRemoteSha) {
        state.lastRemoteSha = nextSha
        broadcastReload('remote-main', nextSha.slice(0, 12))
      }
    } catch (error) {
      warnOnce('remote-poll', `remote poll failed: ${error.message}`)
    } finally {
      state.remoteBusy = false
    }
  }, args.remotePoll * 1000)
}

async function ensureHtmlFresh() {
  const htmlStat = safeStat(GRAPH_HTML)
  const graphStat = safeStat(GRAPH_JSON)
  if (htmlStat && (!graphStat || htmlStat.mtimeMs >= graphStat.mtimeMs)) return { kind: 'html' }
  if (!fs.existsSync(RENDER_HTML)) {
    warnOnce('render-html-missing', 'render-html.mjs missing; serving fallback message')
    return { kind: 'message', message: 'graph.html not built; run scripts/kg/render-html.mjs' }
  }

  try {
    const mod = await loadRenderModule()
    if (!mod || typeof mod.writeHtmlShell !== 'function') {
      throw new Error('writeHtmlShell export not found')
    }
    mod.writeHtmlShell({ defaultPort: state.port })
  } catch (error) {
    warnOnce('render-html-failed', `render-html.mjs failed: ${error.message}`)
  }

  if (fs.existsSync(GRAPH_HTML)) return { kind: 'html' }
  return { kind: 'message', message: 'graph.html not built; run scripts/kg/render-html.mjs' }
}

async function loadGraphJson() {
  const mod = await loadQueryModule()
  if (!mod || typeof mod.loadGraph !== 'function') {
    throw new Error('loadGraph export not found')
  }
  return mod.loadGraph({ skipStaleCheck: false })
}

async function loadRenderModule() {
  state.renderModulePromise ||= import(pathToFileURL(RENDER_HTML).href)
  return state.renderModulePromise
}

async function loadQueryModule() {
  state.queryModulePromise ||= import(pathToFileURL(QUERY_LIB).href)
  return state.queryModulePromise
}

function shouldIgnoreWatch(filename) {
  if (!filename) return false
  const normalized = String(filename).replace(/\\/g, '/')
  if (normalized.includes('.knowledge-graph.snapshots/')) return true
  return GENERATED_FILES.has(path.basename(normalized))
}

function broadcastReload(reason, sha) {
  const payload = JSON.stringify({
    reason,
    ts: new Date().toISOString(),
    sha: sha || '--',
  })
  const frame = `event: reload\ndata: ${payload}\n\n`
  for (const client of state.clients) {
    try {
      client.write(frame)
    } catch {
      state.clients.delete(client)
    }
  }
}

async function listenWithFallback(server, startPort, maxPort) {
  let port = startPort
  while (true) {
    try {
      await listenOnce(server, port)
      return port
    } catch (error) {
      if (error.code === 'EADDRINUSE' && port < maxPort) {
        port += 1
        continue
      }
      throw error
    }
  }
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onListening = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      server.off('error', onError)
      server.off('listening', onListening)
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port)
  })
}

function shutdown() {
  if (state.shuttingDown) return
  state.shuttingDown = true

  if (state.localTimer) {
    clearTimeout(state.localTimer)
    state.localTimer = null
  }
  if (state.keepaliveTimer) clearInterval(state.keepaliveTimer)
  if (state.remoteTimer) clearInterval(state.remoteTimer)

  for (const watcher of state.watchers) {
    try { watcher.close() } catch {}
  }
  for (const client of state.clients) {
    try { client.end() } catch {}
  }
  state.clients.clear()

  if (!state.server || !state.server.listening) {
    process.exit(0)
    return
  }
  state.server.close(() => process.exit(0))
}

function safeStat(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

function readGitShort(ref) {
  return readGit(['rev-parse', '--short=12', ref]) || '--'
}

function readGit(argsList) {
  try {
    return execFileSync('git', argsList, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
  } catch {
    return ''
  }
}

function runGit(argsList) {
  execFileSync('git', argsList, {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  })
}

function openBrowser(target) {
  const command = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]]
  try {
    spawn(command[0], command[1], {
      detached: true,
      stdio: 'ignore',
      windowsHide: process.platform === 'win32',
    }).unref()
  } catch (error) {
    warnOnce('browser-open', `browser open failed: ${error.message}`)
  }
}

function warnOnce(key, message) {
  if (state.warned.has(key)) return
  state.warned.add(key)
  console.warn(`[kg/serve] ${message}`)
}

function toRepoPath(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/')
}
