#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import crypto from 'node:crypto'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
export const ROOT = process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..')
export const INDEX_PATH = path.join(ROOT, 'team-memory/.kos-embeddings.json')

function loadEnvLocal() {
  try {
    const p = path.join(ROOT, '.env.local')
    if (!fs.existsSync(p)) return
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  } catch {}
}

function embeddingConfig() {
  loadEnvLocal()
  return {
    base: process.env.EMBEDDING_API_BASE_URL || 'https://api.openai.com/v1',
    key: process.env.EMBEDDING_API_KEY,
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    dim: Number.parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10),
  }
}

export async function embedSignature(text) {
  const { base, key, model, dim } = embeddingConfig()
  if (!key || !text) return null
  // 手动 AbortController + clearTimeout：不用 AbortSignal.timeout，
  // 否则其遗留 timer 在 process.exit() 时触发 Windows libuv 断言崩溃（src/win/async.c:76）
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10000)
  try {
    const r = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: text.length > 4000 ? text.slice(0, 4000) : text,
        dimensions: dim,
        encoding_format: 'float',
      }),
      signal: ac.signal,
    })
    if (!r.ok) return null
    const embedding = (await r.json()).data?.[0]?.embedding
    return Array.isArray(embedding) ? embedding : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0
    const y = Number(b[i]) || 0
    dot += x * y
    aa += x * x
    bb += y * y
  }
  if (aa === 0 || bb === 0) return 0
  return dot / (Math.sqrt(aa) * Math.sqrt(bb))
}

function emptyIndex() {
  loadEnvLocal()
  return { version: 1, model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small', entries: {} }
}

export function loadIndex() {
  try {
    const raw = fs.readFileSync(INDEX_PATH, 'utf-8')
    const idx = JSON.parse(raw)
    if (idx?.version !== 1 || typeof idx.entries !== 'object' || idx.entries === null) return emptyIndex()
    return idx
  } catch {
    return emptyIndex()
  }
}

export function saveIndex(idx) {
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true })
  fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2) + '\n', 'utf-8')
}

export function signatureOf({ name, description, content }) {
  return `${name || ''}\n${description || ''}\n${String(content || '').slice(0, 1500)}`
}

export function sha(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16)
}

function parseFrontmatter(text) {
  text = text.replace(/\r\n/g, '\n') // CRLF 容错：归一化后再解析（否则 CRLF 文件 name/description 解析为空 → signature 退化、削弱去重闸）
  if (!text.startsWith('---\n')) return { fm: {}, body: text }
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) return { fm: {}, body: text }
  const fm = {}
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (m && m[2] !== '') fm[m[1]] = stripQuotes(m[2].trim())
  }
  return { fm, body: text.slice(end + 5) }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === '_drafts') continue
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(fullPath)
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(fullPath)
    }
  }
  return out
}

function inferType(rel, fm) {
  if (fm.type) return fm.type
  if (rel.startsWith('team-memory/rules/')) return 'rule'
  if (rel.startsWith('team-memory/playbooks/')) return 'playbook'
  if (rel.startsWith('team-memory/decisions/')) return 'decision'
  if (rel.startsWith('docs/architecture/')) return 'decision'
  return ''
}

export async function refreshIndex(idx) {
  if (!idx || typeof idx !== 'object') idx = emptyIndex()
  if (!idx.entries || typeof idx.entries !== 'object') idx.entries = {}
  const dirs = [
    path.join(ROOT, 'team-memory', 'rules'),
    path.join(ROOT, 'team-memory', 'playbooks'),
    path.join(ROOT, 'team-memory', 'decisions'),
    path.join(ROOT, 'docs', 'architecture'),
  ]
  const files = dirs.flatMap(listMarkdownFiles)
  const seen = new Set()
  let embedded = 0

  for (const filePath of files) {
    const rel = path.relative(ROOT, filePath).replace(/\\/g, '/')
    seen.add(rel)
    let text = ''
    try {
      text = fs.readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }
    const hash = sha(text)
    if (idx.entries[rel]?.hash === hash) continue
    const { fm, body } = parseFrontmatter(text)
    const slug = path.basename(filePath, '.md')
    const type = inferType(rel, fm)
    const name = fm.name || fm.title || slug
    const description = fm.description || ''
    const embedding = await embedSignature(signatureOf({ name, description, content: body }))
    if (!embedding) continue
    idx.entries[rel] = { slug, type, name, description, hash, embedding }
    embedded++
  }

  for (const rel of Object.keys(idx.entries)) {
    if (!seen.has(rel)) delete idx.entries[rel]
  }

  return { idx, embedded, total: files.length }
}

export async function nearest(idx, embedding, { excludeRel, topK = 3 } = {}) {
  const rows = []
  for (const [rel, entry] of Object.entries(idx?.entries || {})) {
    if (excludeRel && rel === excludeRel) continue
    const score = cosine(embedding, entry.embedding)
    rows.push({ rel, slug: entry.slug, name: entry.name, type: entry.type, score })
  }
  rows.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
  return rows.slice(0, topK)
}

export async function checkDuplicate({ type, slug, name, description, content, rel, threshold }) {
  const idx = loadIndex()
  await refreshIndex(idx)
  saveIndex(idx)
  const embedding = await embedSignature(signatureOf({ name, description, content }))
  if (!embedding) return { candidates: [], maxScore: 0, skipped: true, hint_candidates: [] }
  const top = await nearest(idx, embedding, { excludeRel: rel, topK: 3 })
  const maxScore = top.length ? top[0].score : 0
  const tau = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.60
  const hintThreshold = Number.isFinite(Number(process.env.KOS_DEDUP_HINT_THRESHOLD)) ? Number(process.env.KOS_DEDUP_HINT_THRESHOLD) : 0.45
  const hintCandidates = top
    .filter((row) => row.score >= hintThreshold && row.score < tau)
    .map(({ slug, type, score }) => ({ slug, type, score }))
  return { candidates: top.filter((row) => row.score >= tau), maxScore, hint_candidates: hintCandidates }
}

export async function upsertEntry({ rel, slug, type, name, description, content }) {
  try {
    const embedding = await embedSignature(signatureOf({ name, description, content }))
    if (!embedding) return
    const idx = loadIndex()
    if (!idx.entries || typeof idx.entries !== 'object') idx.entries = {}
    idx.entries[rel] = {
      slug,
      type,
      name,
      description,
      hash: sha(content),
      embedding,
    }
    saveIndex(idx)
  } catch {}
}
