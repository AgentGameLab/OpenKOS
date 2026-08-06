import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import { OperationSemaphore, resolveBudgetCap } from '../lib/db-budget.mjs'

test('limits active operations to the cap and starts queued callers FIFO', async () => {
  const semaphore = new OperationSemaphore({ cap: 2, name: 'recall' })
  let active = 0
  let peak = 0
  const starts = []

  const jobs = Array.from({ length: 6 }, (_, index) => semaphore.run(async () => {
    starts.push(index)
    active += 1
    peak = Math.max(peak, active)
    await delay(20)
    active -= 1
    return index
  }, { action: 'recall', caller: `caller-${index}` }))

  const results = await Promise.all(jobs)

  assert.equal(peak, 2)
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5])
  assert.deepEqual(results.map((result) => result.value), [0, 1, 2, 3, 4, 5])
  assert.equal(results[0].queuedMs, 0)
  assert.ok(results.slice(2).some((result) => result.queuedMs > 0))
  assert.equal(semaphore.activeCount, 0)
  assert.equal(semaphore.queuedCount, 0)
})

test('warns with action and caller only after the queue threshold', async () => {
  const warnings = []
  const semaphore = new OperationSemaphore({
    cap: 1,
    name: 'recall',
    warnAfterMs: 5,
    warn: (message) => warnings.push(message),
  })

  const first = semaphore.run(() => delay(20), { action: 'recall', caller: 'first' })
  const second = semaphore.run(() => 'done', { action: 'recall', caller: 'second' })
  await Promise.all([first, second])

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /action=recall/)
  assert.match(warnings[0], /caller=second/)
  assert.match(warnings[0], /queued_ms=\d+/)
})

test('uses default cap 8 for invalid configuration', () => {
  assert.equal(resolveBudgetCap(undefined), 8)
  assert.equal(resolveBudgetCap('0'), 8)
  assert.equal(resolveBudgetCap('nope'), 8)
  assert.equal(resolveBudgetCap('3'), 3)
})
