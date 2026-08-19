import assert from 'node:assert'
import { registerHooks } from 'node:module'
import { LEGACY_TEAM_ALIASES, isCanonicalScope, isLineScope, normalizeLegacyScope } from '../lib/scopes.mjs'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '../../kos/kos-remember.mjs'), 'utf-8')
const m = src.match(/const TEAM_SCOPE_ALIASES = new Set\(\[([^\]]*)\]/)
assert.ok(m, 'TEAM_SCOPE_ALIASES 没找到 —— 路由实现变了，请同步本用例')
const literals = m[1]

assert.ok(literals.includes("'core'"), "kos-remember 的 TEAM_SCOPE_ALIASES 必须含 'core'，否则用正式名写入会 misroute 到个人目录")
assert.ok(literals.includes("'all-agents'"), "旧名 all-agents 仍须被接受（存量调用方）")
assert.ok(isCanonicalScope('core'), 'core 必须是 canonical')
assert.ok(!LEGACY_TEAM_ALIASES.includes('shared'), 'shared 不能是 team 别名')
assert.ok(isLineScope('line-example') && !isLineScope('line-../x'), 'line scope 文法')

globalThis.__scopeRoutingIndexOnlyWrites = []
const hooks = registerHooks({
  load(moduleUrl, context, nextLoad) {
    if (moduleUrl.endsWith('/lib/store.mjs')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export async function storeMemory(input) {
            globalThis.__scopeRoutingIndexOnlyWrites.push(input)
            return { id: 'scope-routing-index-only', hash: 'test-hash', status: 'created' }
          }
        `,
      }
    }
    if (moduleUrl.endsWith('/lib/db.mjs')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export async function query() { throw new Error("unexpected query") }',
      }
    }
    if (moduleUrl.endsWith('/kos/kos-remember.mjs')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export async function remember() { throw new Error('unexpected remember') }
          export function resolveAdrWritePath() { throw new Error('unexpected resolveAdrWritePath') }
        `,
      }
    }
    return nextLoad(moduleUrl, context)
  },
})

try {
  const endpointUrl = new URL('../lib/memory-endpoint.mjs?scope-routing-regression', import.meta.url)
  const { handleMemoryWrite } = await import(endpointUrl.href)
  const response = await handleMemoryWrite({
    index_only: true,
    content: 'scope routing regression',
    type: 'rule',
    name: 'scope-routing-regression',
    kos_file: 'team-memory/rules/scope-routing-regression.md',
  }, { agent_id: 'scope-routing-test' })

  assert.equal(response.status, 200, 'index_only 写入应成功')
  assert.equal(globalThis.__scopeRoutingIndexOnlyWrites.length, 1, 'index_only 应只写一行')
  const stored = globalThis.__scopeRoutingIndexOnlyWrites[0]
  const canonicalCommonsScope = normalizeLegacyScope('all-agents')
  assert.equal(stored.scope, canonicalCommonsScope, 'index_only 必须写入 canonical Commons scope')
  assert.equal(stored.source_file, 'team-memory/rules/scope-routing-regression.md', 'index_only 必须把 kos_file 作为卡级 source_file')
  assert.notEqual(stored.scope, 'all-agents', 'legacy scope 名写进库 = 对已归一的 scopeFilter 不可见')
} finally {
  hooks.deregister()
  delete globalThis.__scopeRoutingIndexOnlyWrites
}

console.log('PASS  scope 路由回归 9/9')

{
  const endpointUrl2 = new URL('../lib/memory-endpoint.mjs?kos-file-validation', import.meta.url)
  const { handleMemoryWrite: hw } = await import(endpointUrl2.href)
  const base = { index_only: true, content: 'x', type: 'rule', name: 'kos-file-validation' }

  for (const bad of [
    '../../root/.claude/x.md', '../escape.md', '/etc/passwd',
    'C:/abs/path.md', 'C:\\abs\\path.md', '//server/share/x.md',
    'team-memory/../../escape.md',
  ]) {
    const r = await hw({ ...base, kos_file: bad }, { agent_id: 't' })
    assert.equal(r.status, 400, `kos_file=${bad} 必须 400`)
    assert.equal(r.body.field, 'kos_file')
  }
  const okBody = { ...base, kos_file: 'team-memory/rules/ok.md' }
  const rOk = await hw(okBody, { agent_id: 't' })
  assert.notEqual(rOk.status, 400, '仓内相对路径不该被拦')
  console.log("PASS  kos_file 路径校验 8/8")
}
