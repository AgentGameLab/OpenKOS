#!/usr/bin/env node
// q-channel-routing-audit.mjs — list town_messages emitters and cron routing risk

import fs from 'node:fs'
import path from 'node:path'
import { loadGraph, indexEdges, indexNodes, fmtTable, ROOT } from './_lib.mjs'

const ZONE_CONFIG = path.join(ROOT, '.claude', 'hooks', 'zone-config.json')

const graph = loadGraph()
const byId = indexNodes(graph)
const { in: inE, out } = indexEdges(graph)
const zoneById = loadZoneNameById()

const rows = (graph.nodes || [])
  .filter(node => node.type === 'message-emitter')
  .map(node => {
    const host = findHostScript(node)
    const scope = findScope(host)
    const target = formatTarget(node)
    const suspect = scope.split(',').includes('per-node') && target === 'hq-managers' ? 'yes' : 'no'
    return {
      fileLine: node.id,
      channelType: node.channel_type || 'unknown',
      targetKind: node.target_kind || 'unknown',
      target,
      scope,
      suspect,
    }
  })
  .sort((a, b) => {
    if (a.suspect !== b.suspect) return a.suspect === 'yes' ? -1 : 1
    return a.fileLine.localeCompare(b.fileLine)
  })

const report = []
report.push(`# Channel routing audit`)
report.push('')
report.push(`Total emitters: ${rows.length}`)
report.push(`Suspect rows: ${rows.filter(row => row.suspect === 'yes').length}`)
report.push('')
report.push(fmtTable(
  ['file:line', 'channel_type', 'target_kind', 'target', 'scope', 'suspect'],
  rows.map(row => [
    row.fileLine,
    row.channelType,
    row.targetKind,
    row.target,
    row.scope,
    row.suspect,
  ]),
))

console.log(report.join('\n'))

function findHostScript(node) {
  const emitsFrom = (out.get(node.id) || []).find(edge => edge.label === 'emits-from')
  return emitsFrom?.to || node.host_script || null
}

function findScope(hostScript) {
  if (!hostScript) return 'N/A'
  const scopes = new Set()
  for (const edge of inE.get(hostScript) || []) {
    if (edge.label !== 'triggers') continue
    const cron = byId.get(edge.from)
    if (cron?.type === 'cron-task') scopes.add(cron.scope || 'N/A')
  }
  return scopes.size > 0 ? [...scopes].sort().join(',') : 'N/A'
}

function formatTarget(node) {
  const value = node.target_value || 'unresolved'
  if (node.target_kind === 'zone') return zoneById.get(value) || value
  if (node.target_kind === 'agent') return formatAgentTarget(value)
  return value
}

function formatAgentTarget(value) {
  if (!value || value === 'unresolved') return 'unresolved'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return value.slice(0, 8)
  }
  return value
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
