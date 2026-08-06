import test from 'node:test'
import assert from 'node:assert/strict'

import { OperationSemaphore } from '../lib/db-budget.mjs'
import { createRecallOperation } from '../lib/recall-operation.mjs'

test('returns recall result and emits the required bounded success audit entry', async () => {
  const entries = []
  const times = [1_700_000_000_000, 1_700_000_000_025]
  const runRecall = createRecallOperation({
    semaphore: new OperationSemaphore({ cap: 2, name: 'recall' }),
    auditLog: (entry) => entries.push(entry),
    now: () => times.shift(),
  })
  const result = { hits: [{ id: 1 }, { id: 2 }], query_path: 'fts', recall_log_id: 9 }

  assert.equal(await runRecall({
    caller: 'agent-a',
    request: { query: 'q'.repeat(250), limit: 2, source: 'rest', scope_filter: ['all-agents'] },
    execute: async () => result,
  }), result)

  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0], {
    ts: new Date(1_700_000_000_000).toISOString(),
    action: 'recall',
    caller: 'agent-a',
    request_summary: {
      query: 'q'.repeat(200),
      limit: 2,
      source: 'rest',
      scope_filter: ['all-agents'],
    },
    response_summary: { hit_count: 2, query_path: 'fts', recall_log_id: 9 },
    latency_ms: 25,
    error_class: null,
    queued_ms: 0,
  })
})

test('rethrows the original recall error after auditing its class', async () => {
  const entries = []
  const expected = new TypeError('database unavailable')
  const times = [2_000, 2_030]
  const runRecall = createRecallOperation({
    semaphore: new OperationSemaphore({ cap: 1, name: 'recall' }),
    auditLog: (entry) => entries.push(entry),
    now: () => times.shift(),
  })

  await assert.rejects(runRecall({
    caller: 'agent-b',
    request: { query: 'failure' },
    execute: async () => { throw expected },
  }), (error) => error === expected)

  assert.equal(entries.length, 1)
  assert.equal(entries[0].error_class, 'TypeError')
  assert.equal(entries[0].response_summary, null)
  assert.equal(entries[0].latency_ms, 30)
})

test('does not await an asynchronous audit sink', async () => {
  const runRecall = createRecallOperation({
    semaphore: new OperationSemaphore({ cap: 1, name: 'recall' }),
    auditLog: () => new Promise(() => {}),
  })

  const result = await Promise.race([
    runRecall({ caller: 'agent-c', request: { query: 'fast' }, execute: async () => 'ok' }),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ])

  assert.equal(result, 'ok')
})
