#!/usr/bin/env node
// scripts/kg/cross-query.mjs
//
// Cross-KG bridge: lookup a path → find matching nodes in BOTH
// self-built KG (Office) AND UA-KG (configured code repo).
//
// Bridge key format: "<repoKey>:<posix-relative-path>"
//   - "office:docs/architecture/adr-028-...md"
//   - "code:src/lib/foo.ts"
//
// self KG node.paths[] (frontmatter array) → normalize via path-normalize.mjs
// UA KG node.id "type:filePath" → strip type, prepend "code:"
//
// CLI:
//   node scripts/kg/cross-query.mjs <path>
//
// Programmatic:
//   import { lookup } from './scripts/kg/cross-query.mjs'
//   const r = lookup('docs/architecture/adr-028-...md')

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { normalizePathKey } from './lib/path-normalize.mjs'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..')
const CODE_REPO_ROOT = process.env.KOS_CODE_REPO ? path.resolve(process.env.KOS_CODE_REPO) : null
const SELF_KG_PATH = path.join(ROOT, 'team-memory', '.knowledge-graph.json')
const UA_KG_PATH = CODE_REPO_ROOT
  ? path.join(CODE_REPO_ROOT, '.understand-anything', 'knowledge-graph.json')
  : null

let _cache = null

function buildIndex() {
  if (_cache) return _cache

  const idx = new Map()

  // Load self KG (Office) — nodes with .paths frontmatter array
  let self = { nodes: [] }
  if (fs.existsSync(SELF_KG_PATH)) {
    self = JSON.parse(fs.readFileSync(SELF_KG_PATH, 'utf-8'))
    for (const n of self.nodes || []) {
      const paths = Array.isArray(n.paths) ? n.paths : (n.path ? [n.path] : [])
      // Also use node.id as candidate path (self KG ids are often relative paths)
      if (n.id && typeof n.id === 'string' && !n.id.includes(':')) paths.push(n.id)
      for (const p of paths) {
        try {
          const r = typeof p === 'string' && p.startsWith('../code-repo/')
            ? `code:${p.slice('../code-repo/'.length)}`
            : normalizePathKey(p)
          // Accept both string and object return shapes from path-normalize
          const key = typeof r === 'string' ? r : (r && r.key)
          if (key) {
            if (!idx.has(key)) idx.set(key, { self: [], ua: [] })
            idx.get(key).self.push(n)
          }
        } catch {
          /* skip invalid path entries */
        }
      }
    }
  }

  // Load UA KG (configured code repo) — nodes with .filePath, id format "type:filePath"
  let ua = null
  if (UA_KG_PATH && fs.existsSync(UA_KG_PATH)) {
    ua = JSON.parse(fs.readFileSync(UA_KG_PATH, 'utf-8'))
    for (const n of ua.nodes || []) {
      const fp = n.filePath
      if (!fp || typeof fp !== 'string') continue
      const key = `code:${fp.replace(/\\/g, '/')}`
      if (!idx.has(key)) idx.set(key, { self: [], ua: [] })
      idx.get(key).ua.push(n)
    }
  }

  _cache = { idx, self, ua }
  return _cache
}

export function lookup(input) {
  const { idx } = buildIndex()
  let key = null
  // If input already in "repoKey:rel/path" form, use as-is
  if (typeof input === 'string' && /^(office|code):/.test(input)) {
    key = input
  } else {
    try {
      const r = normalizePathKey(input)
      key = typeof r === 'string' ? r : (r && r.key)
    } catch (err) {
      return { key: null, selfMatches: [], uaMatches: [], bridged: false, error: err.message }
    }
  }

  if (!key) return { key: null, selfMatches: [], uaMatches: [], bridged: false }

  const hit = idx.get(key) || { self: [], ua: [] }
  return {
    key,
    selfMatches: hit.self,
    uaMatches: hit.ua,
    bridged: hit.self.length > 0 && hit.ua.length > 0,
  }
}

export function listBridged() {
  const { idx } = buildIndex()
  const bridged = []
  for (const [key, hit] of idx) {
    if (hit.self.length > 0 && hit.ua.length > 0) {
      bridged.push({
        key,
        selfCount: hit.self.length,
        uaCount: hit.ua.length,
      })
    }
  }
  return bridged
}

export function stats() {
  const { idx, self, ua } = buildIndex()
  let selfOnly = 0, uaOnly = 0, bridged = 0
  for (const hit of idx.values()) {
    if (hit.self.length > 0 && hit.ua.length > 0) bridged++
    else if (hit.self.length > 0) selfOnly++
    else if (hit.ua.length > 0) uaOnly++
  }
  return {
    totalKeys: idx.size,
    selfOnly,
    uaOnly,
    bridged,
    bridgeRate: idx.size > 0 ? (bridged / idx.size).toFixed(4) : '0',
    selfNodes: (self.nodes || []).length,
    uaNodes: ua ? (ua.nodes || []).length : 0,
  }
}

// CLI entry
const isCli = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
              import.meta.url === url.pathToFileURL(process.argv[1]).href
if (isCli) {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--stats') {
    console.log(JSON.stringify(stats(), null, 2))
    process.exit(0)
  }
  if (argv[0] === '--list-bridged') {
    console.log(JSON.stringify(listBridged(), null, 2))
    process.exit(0)
  }
  const result = lookup(argv[0])
  console.log(JSON.stringify({
    key: result.key,
    bridged: result.bridged,
    selfCount: result.selfMatches.length,
    uaCount: result.uaMatches.length,
    selfSample: result.selfMatches.slice(0, 3).map(n => ({ id: n.id, name: n.name, type: n.type })),
    uaSample: result.uaMatches.slice(0, 3).map(n => ({ id: n.id, name: n.name, type: n.type })),
  }, null, 2))
}
