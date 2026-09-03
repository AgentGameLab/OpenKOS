import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const RECALL = fileURLToPath(new URL('../kos-recall.mjs', import.meta.url))

function runRecall(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RECALL, '--query', 'maturity-probe', '--limit', '3', '--scope', 'team', '--format', 'json'], {
      encoding: 'utf-8',
      env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('Tier-1/Tier-2 fusion uses maturity as a tie-breaker and honors env overrides', async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'kos-recall-maturity-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))

  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/recall')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      hits: [
        { id: 'draft', source_file: 'team-memory/rules/draft.md', maturity: 'draft', rrf_score: 9 },
        { id: 'verified', source_file: 'team-memory/rules/verified.md', maturity: 'verified', rrf_score: 8 },
        { id: 'proven', source_file: 'team-memory/rules/proven.md', maturity: 'proven', rrf_score: 7 },
      ],
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()

  const baseEnv = {
    ...process.env,
    KOS_DATA_ROOT: dataRoot,
    KOS_SERVICE_URL: `http://127.0.0.1:${port}`,
    KOS_SERVICE_TOKEN: 'test-token',
    KOS_RECALL_TRACE_DIR: path.join(dataRoot, 'traces'),
  }
  delete baseEnv.KOS_MATURITY_OFFSETS

  const result = await runRecall(baseEnv)

  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).map((hit) => hit.id), ['draft', 'verified', 'proven'])

  const overridden = await runRecall({
    ...baseEnv,
    KOS_MATURITY_OFFSETS: '{"proven":-2,"verified":0,"draft":4}',
  })
  assert.equal(overridden.code, 0, overridden.stderr)
  assert.deepEqual(JSON.parse(overridden.stdout).map((hit) => hit.id), ['proven', 'verified', 'draft'])

  for (const invalidValue of ['not-json', '{"proven":-1,"verified":0,"draft":"1"}']) {
    const invalid = await runRecall({ ...baseEnv, KOS_MATURITY_OFFSETS: invalidValue })
    assert.equal(invalid.code, 0, invalid.stderr)
    assert.deepEqual(JSON.parse(invalid.stdout).map((hit) => hit.id), ['draft', 'verified', 'proven'])
    assert.equal(invalid.stderr.match(/Ignoring invalid KOS_MATURITY_OFFSETS/g)?.length, 1)
  }
})
