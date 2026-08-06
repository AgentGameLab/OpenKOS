// Guards the two things that quietly broke this surface before:
//
//   1. OpenKOS is marketed in English, but its CLI grew up inside a Chinese-language
//      codebase. Every user-visible string had to be translated; nothing stops the
//      next contributor from adding a Chinese console.log and shipping it.
//   2. mcp-server.mjs parses the stdout of the q-*.mjs scripts. Those parsers used to
//      anchor on Chinese words, so translating a report silently zeroed out kos_health
//      instead of failing loudly. The parsers are language-agnostic now — this pins that.
//
// Chinese *data* literals (tokenizers, stopword lists, patterns matched against a
// Chinese memory corpus) are legitimate and must NOT be flagged. The output test only
// inspects what the scripts actually print.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const EXAMPLES = path.join(REPO, 'examples')
const CJK = /[一-鿿]/

// The scripts a first-time user reaches through the README, plus the two whose
// stdout mcp-server parses.
const USER_FACING = [
  ['src/kg/knowledge-graph-gen.mjs', []],
  ['src/kos/kos-recall.mjs', ['--query', 'how do we stop agents inventing facts']],
  ['src/kg/queries/q-impact-radius.mjs', ['every-rule-needs-falsifiable-contract']],
  ['src/kg/queries/q-lint.mjs', []],
  ['src/kg/queries/q-cold-leaves.mjs', []],
  ['src/kg/queries/q-stale-chains.mjs', []],
]

function run(script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, KOS_DATA_ROOT: EXAMPLES, ...env },
    timeout: 30_000,
  })
}

for (const [script, args] of USER_FACING) {
  test(`${script} prints no Chinese to a user`, () => {
    const { stdout, stderr, status } = run(script, args)
    assert.equal(status, 0, `exited ${status}: ${stderr}`)

    const offenders = `${stdout}\n${stderr}`
      .split('\n')
      .filter(line => CJK.test(line))

    assert.deepEqual(
      offenders,
      [],
      `${script} emitted Chinese:\n${offenders.join('\n')}`,
    )
  })
}

test('a relative KOS_DATA_ROOT still resolves for spawned queries', async () => {
  // Regression: ROOT was passed to children as their cwd while the children also
  // inherited the raw relative KOS_DATA_ROOT, so "./examples" resolved to
  // examples/examples. Every query exited 1 and kos_health reported zeros with no
  // error — the exact setup the README tells people to use.
  const request = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'kos_health', arguments: {} } },
  ].map(m => JSON.stringify(m)).join('\n') + '\n'

  const { stdout, status } = spawnSync(process.execPath, [path.join(REPO, 'src/kos/mcp-server.mjs')], {
    cwd: REPO,
    input: request,
    encoding: 'utf-8',
    env: { ...process.env, KOS_DATA_ROOT: './examples' },
    timeout: 60_000,
  })
  assert.equal(status, 0, 'mcp-server exited non-zero')

  const call = stdout.trim().split('\n').map(l => JSON.parse(l)).find(m => m.id === 2)
  const health = JSON.parse(call.result.content[0].text)

  for (const [name, state] of Object.entries(health.queryStatus)) {
    assert.equal(state.ok, true, `query ${name} failed under a relative KOS_DATA_ROOT`)
  }
  // Proves the language-agnostic parsers actually read the English reports rather
  // than falling through to their zero defaults.
  assert.equal(health.summary.score, 100)
  assert.equal(health.coldLeaves.total, 8)
  assert.deepEqual(health.coldLeaves.breakdown, { proven: 2, verified: 4, draft: 2 })
})
