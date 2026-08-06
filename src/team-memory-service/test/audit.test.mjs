import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { createAuditLogger } from '../lib/audit.mjs'

const FIXED_NOW = new Date('2026-07-15T12:34:56.789Z')

async function withTempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kos-audit-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('writes one required-schema JSONL entry without awaiting the caller path', async (t) => {
  const logDir = await withTempDir(t)
  const logger = createAuditLogger({
    logDir,
    now: () => new Date(FIXED_NOW),
    sweepIntervalMs: 0,
  })
  t.after(() => logger.stop())

  const entry = {
    ts: FIXED_NOW.toISOString(),
    action: 'recall',
    caller: 'agent-a',
    request_summary: { query: 'iron rule', limit: 3 },
    response_summary: { hit_count: 2, query_path: 'fts' },
    latency_ms: 17,
    error_class: null,
    queued_ms: 4,
  }

  assert.equal(logger.log(entry), undefined)
  await logger.drain()

  const raw = await readFile(path.join(logDir, '2026-07-15.jsonl'), 'utf8')
  const lines = raw.trimEnd().split('\n')
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), entry)
})

test('retention sweep deletes only date-named audit files older than 30 days', async (t) => {
  const logDir = await withTempDir(t)
  await mkdir(logDir, { recursive: true })
  await Promise.all([
    writeFile(path.join(logDir, '2026-06-14.jsonl'), 'old\n'),
    writeFile(path.join(logDir, '2026-06-15.jsonl'), 'boundary\n'),
    writeFile(path.join(logDir, 'notes.jsonl'), 'unmanaged\n'),
  ])

  const logger = createAuditLogger({
    logDir,
    retentionDays: 30,
    now: () => new Date(FIXED_NOW),
    sweepIntervalMs: 0,
  })
  t.after(() => logger.stop())

  await logger.sweep()

  await assert.rejects(readFile(path.join(logDir, '2026-06-14.jsonl')), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(logDir, '2026-06-15.jsonl'), 'utf8'), 'boundary\n')
  assert.equal(await readFile(path.join(logDir, 'notes.jsonl'), 'utf8'), 'unmanaged\n')
})
