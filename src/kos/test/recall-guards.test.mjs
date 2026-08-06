import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  enforceContextBudget,
  startTrace,
  stripHallucinatedIds,
} from '../recall-guards.mjs'

test('stripHallucinatedIds removes only id references outside the recall whitelist', () => {
  const text = [
    '[id:101 rule proven] first real memory',
    '[id:fake-202 rule draft] fabricated memory',
    '[id:303 decision verified] second real memory',
    '[id:999999 playbook draft] fabricated numeric memory',
  ].join('\n')

  const result = stripHallucinatedIds(text, new Set(['101', '303']))

  assert.match(result.cleanText, /id:101/)
  assert.match(result.cleanText, /id:303/)
  assert.doesNotMatch(result.cleanText, /id:fake-202/)
  assert.doesNotMatch(result.cleanText, /id:999999/)
  assert.deepEqual(result.strippedIds, ['fake-202', '999999'])
})

test('enforceContextBudget keeps the ranked prefix within the entry cap', () => {
  const entries = Array.from({ length: 25 }, (_, index) => `entry-${index + 1}`)

  const result = enforceContextBudget(entries, { maxChars: 100_000, maxEntries: 20 })

  assert.deepEqual(result.kept, entries.slice(0, 20))
  assert.deepEqual(result.dropped, entries.slice(20))
  assert.equal(result.reason, 'maxEntries')
})

test('enforceContextBudget counts the exact rendered string context', () => {
  const entries = ['1234', '5678', '90']

  const result = enforceContextBudget(entries, { maxChars: 10, maxEntries: 20 })

  assert.deepEqual(result.kept, ['1234', '5678'])
  assert.deepEqual(result.dropped, ['90'])
  assert.equal(result.reason, 'maxChars')
  assert.equal(result.kept.join('\n\n').length, 10)
})

test('startTrace returns and atomically persists a structured JSON trace', () => {
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-recall-trace-'))
  const previousTraceDir = process.env.KOS_RECALL_TRACE_DIR
  process.env.KOS_RECALL_TRACE_DIR = traceDir

  try {
    const trace = startTrace('unit-test')
    trace.step('recall.params', { query: 'guard test', limit: 25 })
    trace.step('recall.results', { count: 25 })
    const jsonTrace = trace.end()

    assert.equal(jsonTrace.callSite, 'unit-test')
    assert.equal(jsonTrace.steps.length, 2)
    assert.deepEqual(jsonTrace.steps.map((step) => step.name), ['recall.params', 'recall.results'])
    assert.ok(jsonTrace.traceFile.startsWith(traceDir))

    const persisted = JSON.parse(fs.readFileSync(jsonTrace.traceFile, 'utf-8'))
    assert.deepEqual(persisted, jsonTrace)

    fs.unlinkSync(jsonTrace.traceFile)
    fs.rmdirSync(traceDir)
  } finally {
    if (previousTraceDir === undefined) delete process.env.KOS_RECALL_TRACE_DIR
    else process.env.KOS_RECALL_TRACE_DIR = previousTraceDir
  }
})

test('kos-recall caps a real file recall and writes the guard trace', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-recall-data-'))
  const rulesDir = path.join(fixtureRoot, 'team-memory', 'rules')
  const traceDir = path.join(fixtureRoot, 'traces')
  fs.mkdirSync(rulesDir, { recursive: true })

  for (let index = 1; index <= 25; index++) {
    const slug = `guard-probe-${String(index).padStart(2, '0')}`
    fs.writeFileSync(
      path.join(rulesDir, `${slug}.md`),
      `---\nslug: ${slug}\ntype: rule\ndescription: guardprobe\n---\n\nguardprobe memory ${index}\n`,
      'utf-8',
    )
  }

  try {
    const recallScript = fileURLToPath(new URL('../kos-recall.mjs', import.meta.url))
    const recall = spawnSync(
      process.execPath,
      [recallScript, '--query', 'guardprobe', '--limit', '25', '--scope', 'team', '--format', 'json'],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          KOS_DATA_ROOT: fixtureRoot,
          KOS_RECALL_MAX_CHARS: '100000',
          KOS_RECALL_MAX_ENTRIES: '20',
          KOS_RECALL_TRACE_DIR: traceDir,
        },
      },
    )

    assert.equal(recall.status, 0, recall.stderr)
    const results = JSON.parse(recall.stdout)
    assert.equal(results.length, 20)

    const traceFiles = fs.readdirSync(traceDir).filter((name) => name.endsWith('.json'))
    assert.equal(traceFiles.length, 1)
    const trace = JSON.parse(fs.readFileSync(path.join(traceDir, traceFiles[0]), 'utf-8'))
    const filterStep = trace.steps.find((step) => step.name === 'context.filter')
    assert.deepEqual(filterStep.meta, {
      inputEntries: 25,
      keptEntries: 20,
      droppedEntries: 5,
      reason: 'maxEntries',
      maxChars: 100000,
      maxEntries: 20,
    })
  } finally {
    if (fs.existsSync(traceDir)) {
      for (const file of fs.readdirSync(traceDir)) fs.unlinkSync(path.join(traceDir, file))
      fs.rmdirSync(traceDir)
    }
    for (const file of fs.readdirSync(rulesDir)) fs.unlinkSync(path.join(rulesDir, file))
    fs.rmdirSync(rulesDir)
    fs.rmdirSync(path.dirname(rulesDir))
    fs.rmdirSync(fixtureRoot)
  }
})
