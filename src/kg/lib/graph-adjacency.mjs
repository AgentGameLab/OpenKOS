// Knowledge graph adjacency：读取失败时一律返空，不能阻塞 recall。

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const DEFAULT_DATA_ROOT = path.resolve(__dirname, '..', '..', '..')
const cacheByPath = new Map()

function normalizedPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function graphFile(dataRoot) {
  return path.join(dataRoot || process.env.KOS_DATA_ROOT || DEFAULT_DATA_ROOT, 'team-memory', '.knowledge-graph.json')
}

function loadGraph(dataRoot) {
  try {
    const filePath = graphFile(dataRoot)
    const mtimeMs = fs.statSync(filePath).mtimeMs
    const cached = cacheByPath.get(filePath)
    if (cached && cached.mtimeMs === mtimeMs) return cached.graph

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : []
    const edges = Array.isArray(parsed.edges) ? parsed.edges : []
    const nodeByReference = new Map()
    for (const node of nodes) {
      for (const reference of [node.id, node.canonical_path]) {
        const key = normalizedPath(reference)
        if (key) nodeByReference.set(key, node)
      }
    }

    const adjacency = new Map()
    const addNeighbor = (from, to, edge, direction) => {
      const fromKey = normalizedPath(from?.canonical_path)
      if (!fromKey || !to) return
      if (!adjacency.has(fromKey)) adjacency.set(fromKey, [])
      adjacency.get(fromKey).push({ node: to, edge: edge.label || '', direction })
    }
    for (const edge of edges) {
      const from = nodeByReference.get(normalizedPath(edge.from))
      const to = nodeByReference.get(normalizedPath(edge.to))
      if (!from || !to) continue
      addNeighbor(from, to, edge, 'out')
      addNeighbor(to, from, edge, 'in')
    }

    const graph = { nodes, nodeByReference, adjacency }
    cacheByPath.set(filePath, { mtimeMs, graph })
    return graph
  } catch {
    return null
  }
}

function searchTokens(value) {
  return normalizedPath(value).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []
}

/** 查询 KG 节点；全词命中或节点 token 前缀命中。 */
export function findMatchingNodes(query, dataRoot) {
  try {
    const graph = loadGraph(dataRoot)
    const normalizedQuery = normalizedPath(query).toLocaleLowerCase()
    const tokens = searchTokens(query)
    if (!graph || !normalizedQuery || tokens.length === 0) return []
    return graph.nodes.filter((node) => {
      const fields = [node.name, node.id]
      return fields.some((field) => {
        const value = normalizedPath(field).toLocaleLowerCase()
        if (value === normalizedQuery) return true
        const nodeTokens = searchTokens(field)
        return nodeTokens.length > 0 && tokens.every((token) => nodeTokens.some((nodeToken) => nodeToken.startsWith(token)))
      })
    })
  } catch {
    return []
  }
}

/** 返回节点的 1-hop 邻居和边方向；查询失败时返空。 */
export function oneHopNeighbors(nodeOrPath, dataRoot) {
  try {
    const graph = loadGraph(dataRoot)
    if (!graph) return []
    const reference = typeof nodeOrPath === 'object'
      ? (nodeOrPath.canonical_path || nodeOrPath.id)
      : nodeOrPath
    const node = graph.nodeByReference.get(normalizedPath(reference))
    if (!node) return []
    return graph.adjacency.get(normalizedPath(node.canonical_path)) || []
  } catch {
    return []
  }
}

/** 判断两个 canonical path 是否为 1-hop 邻居；查询失败时返回 false。 */
export function areOneHopNeighbors(firstPath, secondPath, dataRoot) {
  try {
    const target = normalizedPath(secondPath)
    if (!target) return false
    return oneHopNeighbors(firstPath, dataRoot)
      .some(({ node }) => normalizedPath(node.canonical_path) === target)
  } catch {
    return false
  }
}
