import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadRoster } from '../roster.mjs'

const DEFAULT_ROSTER = {
  roles: { approver: 'the maintainer', reviewer: 'a reviewer' },
  people: [],
  identityMap: {},
  teamTerms: [],
}

function withRosterEnv(values, fn) {
  const previous = {
    KOS_ROSTER: process.env.KOS_ROSTER,
    KOS_DATA_ROOT: process.env.KOS_DATA_ROOT,
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { return fn() } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('loadRoster returns the anonymous built-in default when no roster is configured', () => {
  const roster = withRosterEnv(
    { KOS_ROSTER: undefined, KOS_DATA_ROOT: undefined },
    () => loadRoster(),
  )

  assert.deepEqual(roster, DEFAULT_ROSTER)
})

test('loadRoster prefers the KOS_ROSTER file over the data-root roster', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-roster-'))
  const dataRoot = path.join(root, 'data')
  const explicitPath = path.join(root, 'explicit.json')
  const dataPath = path.join(dataRoot, 'kos-roster.json')
  fs.mkdirSync(dataRoot)
  fs.writeFileSync(explicitPath, JSON.stringify({
    roles: { approver: 'explicit approver', reviewer: 'explicit reviewer' },
    people: ['Explicit Person'],
    identityMap: { Committer: 'Explicit Person' },
    teamTerms: ['Explicit Team'],
  }), 'utf-8')
  fs.writeFileSync(dataPath, JSON.stringify({
    roles: { approver: 'data approver', reviewer: 'data reviewer' },
    people: ['Data Person'],
    identityMap: {},
    teamTerms: [],
  }), 'utf-8')

  try {
    const roster = withRosterEnv(
      { KOS_ROSTER: explicitPath, KOS_DATA_ROOT: dataRoot },
      () => loadRoster(),
    )
    assert.equal(roster.roles.approver, 'explicit approver')
    assert.deepEqual(roster.people, ['Explicit Person'])
  } finally {
    fs.unlinkSync(explicitPath)
    fs.unlinkSync(dataPath)
    fs.rmdirSync(dataRoot)
    fs.rmdirSync(root)
  }
})

test('loadRoster reads kos-roster.json from KOS_DATA_ROOT when no explicit file is set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-roster-data-'))
  const rosterPath = path.join(root, 'kos-roster.json')
  const expected = {
    roles: { approver: 'data approver', reviewer: 'data reviewer' },
    people: ['Data Person'],
    identityMap: { Committer: 'Data Person' },
    teamTerms: ['Data Team'],
  }
  fs.writeFileSync(rosterPath, JSON.stringify(expected), 'utf-8')

  try {
    const roster = withRosterEnv(
      { KOS_ROSTER: undefined, KOS_DATA_ROOT: root },
      () => loadRoster(),
    )
    assert.deepEqual(roster, expected)
  } finally {
    fs.unlinkSync(rosterPath)
    fs.rmdirSync(root)
  }
})

test('KG query output uses the configured approver role', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-roster-query-'))
  const teamMemoryDir = path.join(root, 'team-memory')
  const graphPath = path.join(teamMemoryDir, '.knowledge-graph.json')
  const rosterPath = path.join(root, 'roster.json')
  fs.mkdirSync(teamMemoryDir)
  fs.writeFileSync(graphPath, JSON.stringify({ nodes: [], edges: [] }), 'utf-8')
  fs.writeFileSync(rosterPath, JSON.stringify({
    roles: { approver: 'Configured Maintainer', reviewer: 'Configured Reviewer' },
    people: [],
    identityMap: {},
    teamTerms: [],
  }), 'utf-8')

  try {
    const queryScript = fileURLToPath(new URL('../../kg/queries/q-cid-matrix.mjs', import.meta.url))
    const query = spawnSync(process.execPath, [queryScript, '--files', 'src/example.mjs'], {
      encoding: 'utf-8',
      env: { ...process.env, KOS_DATA_ROOT: root, KOS_ROSTER: rosterPath },
    })

    assert.equal(query.status, 0, query.stderr)
    assert.match(query.stdout, /Configured Maintainer review/)
  } finally {
    const metricsPath = path.join(root, '.asi', 'kg-query-metrics.jsonl')
    if (fs.existsSync(metricsPath)) fs.unlinkSync(metricsPath)
    if (fs.existsSync(path.dirname(metricsPath))) fs.rmdirSync(path.dirname(metricsPath))
    fs.unlinkSync(rosterPath)
    fs.unlinkSync(graphPath)
    fs.rmdirSync(teamMemoryDir)
    fs.rmdirSync(root)
  }
})

test('loadRoster never throws and warns only once for malformed or missing configured files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-roster-bad-'))
  const malformedPath = path.join(root, 'malformed.json')
  fs.writeFileSync(malformedPath, '{not json', 'utf-8')
  const warnings = []
  const originalError = console.error
  console.error = (...args) => warnings.push(args.join(' '))

  try {
    const malformed = withRosterEnv(
      { KOS_ROSTER: malformedPath, KOS_DATA_ROOT: undefined },
      () => loadRoster(),
    )
    const missing = withRosterEnv(
      { KOS_ROSTER: path.join(root, 'missing.json'), KOS_DATA_ROOT: undefined },
      () => loadRoster(),
    )
    assert.deepEqual(malformed, DEFAULT_ROSTER)
    assert.deepEqual(missing, DEFAULT_ROSTER)
    assert.equal(warnings.length, 1)
  } finally {
    console.error = originalError
    fs.unlinkSync(malformedPath)
    fs.rmdirSync(root)
  }
})
