#!/usr/bin/env node
// q-vector-search.mjs — deterministic TF-IDF retrieval over KG-backed docs

import fs from 'node:fs'
import path from 'node:path'
import { GRAPH_PATH, ROOT, fmtTable, loadGraph } from './_lib.mjs'

const CACHE_PATH = path.join(ROOT, 'team-memory', '.knowledge-graph.tfidf.json')
const INDEXABLE_TYPES = new Set([
  'rule',
  'playbook',
  'decision',
  'skill',
  'doc',
  'pointer',
])
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'about', 'after', 'before',
  'have', 'has', 'had', 'were', 'was', 'will', 'would', 'should', 'could', 'their', 'there',
  'then', 'than', 'when', 'where', 'what', 'which', 'while', 'your', 'you', 'our', 'are', 'but',
  'not', 'all', 'any', 'can', 'may', 'also', 'only', 'via', 'per', 'etc', 'team',
  '我们', '你们', '他们', '以及', '一个', '两个', '没有', '已经', '不是', '因为', '如果', '需要',
  '可以', '进行', '作为', '对于', '所有', '相关', '问题', '路径', '字段', '文件', '当前', '通过',
  '默认', '支持', '然后', '这里', '那个', '这个', '一种', '二个', '产物',
])
const GRAPH_EDGE_WEIGHTS = {
  superseded_by: 0.95,
  related: 0.75,
  references: 0.45,
}

function parseArgs(argv) {
  const options = { top: 10, type: null, minScore: 0 }
  const terms = []
  for (const arg of argv) {
    if (arg.startsWith('--top=')) options.top = Number.parseInt(arg.slice(6), 10)
    else if (arg.startsWith('--type=')) options.type = arg.slice(7)
    else if (arg.startsWith('--min-score=')) options.minScore = Number.parseFloat(arg.slice(12))
    else terms.push(arg)
  }
  return { query: terms.join(' ').trim(), ...options }
}

function usage() {
  console.error('Usage: q-vector-search.mjs <query-text> [--top=N] [--type=rule|playbook|decision|skill|doc] [--min-score=0.0]')
}

function safeSlice(text, limit) {
  return Array.from(text).slice(0, limit).join('')
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function sortObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)))
}

function tokenize(text) {
  const lower = text.toLowerCase()
  const tokens = []
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    const token = match[0]
    if (!STOPWORDS.has(token)) tokens.push(token)
  }
  for (const match of lower.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = match[0]
    for (let i = 0; i < run.length - 1; i++) {
      const token = run.slice(i, i + 2)
      if (!STOPWORDS.has(token)) tokens.push(token)
    }
  }
  tokens.sort()
  return tokens
}

function countTokens(tokens) {
  const counts = Object.create(null)
  for (const token of tokens) counts[token] = (counts[token] || 0) + 1
  return sortObject(counts)
}

function shouldRebuildCache() {
  if (!fs.existsSync(CACHE_PATH)) return true
  return fs.statSync(GRAPH_PATH).mtimeMs > fs.statSync(CACHE_PATH).mtimeMs
}

function readIndexableText(node) {
  if (!INDEXABLE_TYPES.has(node.type)) return null
  const full = path.join(ROOT, node.id)
  const lower = full.toLowerCase()
  if (!fs.existsSync(full)) return null
  if (!(lower.endsWith('.md') || lower.endsWith('skill.md'))) return null
  try {
    return fs.readFileSync(full, 'utf8')
  } catch {
    return null
  }
}

function buildCache() {
  const graph = loadGraph()
  const docs = []
  const docFreq = Object.create(null)
  const sortedNodes = [...(graph.nodes || [])].sort((a, b) => a.id.localeCompare(b.id))
  for (const node of sortedNodes) {
    const text = readIndexableText(node)
    if (!text) continue
    const tf = countTokens(tokenize(text))
    const terms = Object.keys(tf)
    if (terms.length === 0) continue
    for (const term of terms) docFreq[term] = (docFreq[term] || 0) + 1
    let quality = 1
    if (node.id.includes('/_candidates/')) quality *= 0.65
    const status = (text.match(/^status:\s*(.+)$/m)?.[1] || '').toLowerCase()
    if (status.includes('superseded')) quality *= 0.75
    docs.push({ id: node.id, type: node.type, tf, quality: Number(quality.toFixed(4)) })
  }

  const totalDocs = docs.length || 1
  const idf = sortObject(Object.fromEntries(
    Object.keys(docFreq).sort().map(term => [term, Number((Math.log((1 + totalDocs) / (1 + docFreq[term])) + 1).toFixed(8))])
  ))

  for (const doc of docs) {
    let norm = 0
    for (const [term, freq] of Object.entries(doc.tf)) norm += (freq * idf[term]) ** 2
    doc.norm = Number(Math.sqrt(norm).toFixed(8))
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    graphMtimeMs: fs.statSync(GRAPH_PATH).mtimeMs,
    totalDocs: docs.length,
    idf,
    documents: docs.map(doc => ({
      id: doc.id,
      type: doc.type,
      norm: doc.norm,
      quality: doc.quality,
      tf: doc.tf,
    })),
  }
  fs.writeFileSync(CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

function loadCache() {
  if (shouldRebuildCache()) return buildCache()
  return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
}

function buildSnippet(id, queryTerms) {
  const full = path.join(ROOT, id)
  if (!fs.existsSync(full)) return '-'
  let text = fs.readFileSync(full, 'utf8').replace(/\r/g, '')
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const chunks = text
    .split(/[。！？!?\n]+/g)
    .map(part => part.replace(/^#+\s*/, '').replace(/[`*_>\-]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  for (const chunk of chunks) {
    const sentenceTokens = new Set(tokenize(chunk))
    if (queryTerms.some(term => sentenceTokens.has(term))) return safeSlice(chunk, 80)
  }
  return safeSlice(chunks[0] || '-', 80)
}

function buildAdjacency(graph, allowedIds) {
  const adjacency = new Map()
  const add = (from, to, label) => {
    if (!allowedIds.has(from) || !allowedIds.has(to) || !GRAPH_EDGE_WEIGHTS[label]) return
    if (!adjacency.has(from)) adjacency.set(from, [])
    adjacency.get(from).push({ id: to, label })
  }
  for (const edge of graph.edges || []) {
    add(edge.from, edge.to, edge.label)
    add(edge.to, edge.from, edge.label)
  }
  return adjacency
}

function scoreDocuments(cache, graph, query, typeFilter, minScore) {
  const queryTf = countTokens(tokenize(query))
  const terms = Object.keys(queryTf).filter(term => cache.idf[term] != null)
  if (terms.length === 0) return []

  let queryNorm = 0
  for (const term of terms) queryNorm += (queryTf[term] * cache.idf[term]) ** 2
  queryNorm = Math.sqrt(queryNorm) || 1

  const baseScores = new Map()
  for (const doc of cache.documents) {
    if (typeFilter && doc.type !== typeFilter) continue
    let numerator = 0
    let matchedTerms = 0
    for (const term of terms) {
      const freq = doc.tf[term]
      if (freq) {
        numerator += cache.idf[term] * queryTf[term] * freq
        matchedTerms++
      }
    }
    if (numerator === 0 || doc.norm === 0) continue
    const coverage = matchedTerms / terms.length
    const score = (numerator / (doc.norm * queryNorm)) * coverage * (doc.quality || 1)
    if (score >= minScore) baseScores.set(doc.id, { id: doc.id, type: doc.type, score, quality: doc.quality || 1 })
  }
  const scored = [...baseScores.values()].sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
  const allowedIds = new Set(cache.documents.filter(doc => !typeFilter || doc.type === typeFilter).map(doc => doc.id))
  const adjacency = buildAdjacency(graph, allowedIds)
  const finalScores = new Map(scored.map(item => [item.id, { ...item, score: item.score }]))
  const seeds = scored.slice(0, 5)

  for (const seed of seeds) {
    for (const hop1 of adjacency.get(seed.id) || []) {
      const edge1 = GRAPH_EDGE_WEIGHTS[hop1.label]
      const target1 = finalScores.get(hop1.id)
      if (!edge1 || !target1) continue
      target1.score += seed.score * edge1 * 0.55 * target1.quality
      finalScores.set(hop1.id, target1)

      for (const hop2 of adjacency.get(hop1.id) || []) {
        if (hop2.id === seed.id) continue
        const edge2 = GRAPH_EDGE_WEIGHTS[hop2.label]
        const target2 = finalScores.get(hop2.id)
        if (!edge2 || !target2) continue
        target2.score += seed.score * edge1 * edge2 * 0.35 * target2.quality
        finalScores.set(hop2.id, target2)
      }
    }
  }

  const reranked = [...finalScores.values()]
    .filter(item => item.type && item.score >= minScore)
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
  return reranked
}

const { query, top, type, minScore } = parseArgs(process.argv.slice(2))
if (!query || !Number.isFinite(top) || top <= 0 || !Number.isFinite(minScore)) {
  usage()
  process.exit(1)
}

const cache = loadCache()
const graph = loadGraph({ skipStaleCheck: true })
const matches = scoreDocuments(cache, graph, query, type, minScore).slice(0, top)
console.log(`# q-vector-search · "${query}"${type ? ` (type=${type})` : ''}`)
console.log('')
if (matches.length === 0) {
  console.log('无结果。可尝试更短 query、放宽 `--min-score`、或去掉 `--type`。')
} else {
  console.log(fmtTable(
    ['rank', 'id', 'type', 'score', 'snippet'],
    matches.map((match, index) => [
      index + 1,
      escapeCell(match.id),
      escapeCell(match.type),
      match.score.toFixed(4),
      escapeCell(buildSnippet(match.id, Object.keys(countTokens(tokenize(query))))),
    ])
  ))
}
console.log('')
console.log('> 与 q-find-file 的区别：这里按文档正文的 TF-IDF 语义相似度检索，不是按 id/name 的字面子串打分。')
