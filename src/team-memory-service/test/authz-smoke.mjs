// KOS authz 收口冒烟：正控 + 负控。不依赖 DB。
// 用法：node test/authz-smoke.mjs [authz.mjs 路径]
// 省略参数 = 测同仓的 ../lib/authz.mjs。原来参数必填且不校验，忘传直接崩在
// `undefined.replace` 上（看起来像 authz 坏了，其实是没给参数）——默认值消掉这个坑。
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const modPath = process.argv[2] || resolve(here, '..', 'lib', 'authz.mjs')
const m = await import(pathToFileURL(resolve(modPath)).href)
const { resolvePrincipalAuthorization, authorizeRequestedScopes, authorizeWriteScope, resolveWriteScopes, resolveDefaultScopes } = m

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); pass++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++ }
}
const throws = (fn, why) => { try { fn() } catch { return } throw new Error(`应该抛错但没抛：${why}`) }
const eq = (a, b, why) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${why}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`) }

const CORE = 'r-core', LINE = 'r-line', READER = 'r-read'
process.env.TM_MEMORY_AUTHZ_GRANTS = JSON.stringify({
  by_resident_id: {
    [CORE]: { scopes: ['all-agents', 'shared', 'line-example'], writeScopes: ['all-agents', 'shared'], permissions: ['memory:read', 'memory:write', 'memory:promote'], roles: ['approver'] },
    [LINE]: { scopes: ['shared', 'line-example'], writeScopes: ['line-example'], permissions: ['memory:read', 'memory:write', 'memory:promote'], roles: [] },
    [READER]: { scopes: ['shared'], permissions: ['memory:read'], roles: [] },
  },
})

console.log('\n— 正控 —')
// 请求侧故意仍传 legacy 名 all-agents：2026-08-06 Commons 更名 core 后，授权层要把
// 它归一成 canonical 再返回。断言写成 core 才测得到这次归一——写成 all-agents 等于
// 断言「改名没发生」（这条曾停在改名前的期望上，实现对、测试错）。
t('core 可读三环（legacy 名请求归一为 canonical）', () => eq(authorizeRequestedScopes(resolvePrincipalAuthorization({ resident_id: CORE }), ['all-agents', 'line-example'], []).sort(), ['core', 'line-example']))
t('line 可读 shared', () => eq(authorizeRequestedScopes(resolvePrincipalAuthorization({ resident_id: LINE }), ['shared'], []), ['shared']))
t('line 可写自己环', () => eq(authorizeWriteScope(resolvePrincipalAuthorization({ resident_id: LINE }), 'line-example'), 'line-example'))
t('只读 principal 免填 writeScopes', () => { const p = resolvePrincipalAuthorization({ resident_id: READER }); eq(p.scopes, ['shared']) })

console.log('\n— 负控（必须全部拒绝）—')
t('line 不能读 all-agents', () => throws(() => authorizeRequestedScopes(resolvePrincipalAuthorization({ resident_id: LINE }), ['all-agents'], []), 'line 越权读 Commons'))
t('line 不能写 shared（读得到但不能写）', () => throws(() => authorizeWriteScope(resolvePrincipalAuthorization({ resident_id: LINE }), 'shared'), 'line 写 shared'))
t('未知 principal 全拒', () => throws(() => authorizeRequestedScopes(resolvePrincipalAuthorization({ resident_id: 'nobody' }), ['shared'], []), '未知 principal'))
t('无 resident_id 全拒', () => throws(() => authorizeRequestedScopes(resolvePrincipalAuthorization({ agent_name: 'x' }), ['shared'], []), '无 resident_id'))
t('只读 principal 不能写', () => throws(() => authorizeWriteScope(resolvePrincipalAuthorization({ resident_id: READER }), 'shared'), '只读越权写'))

console.log('\n— 部署陷阱：有 write 权但缺 writeScopes 的旧式 grant —')
process.env.TM_MEMORY_AUTHZ_GRANTS = JSON.stringify({
  by_resident_id: { [CORE]: { scopes: ['all-agents'], permissions: ['memory:read', 'memory:write'], roles: [] } },
})
t('旧式 grant → 该 principal 无授权（fail-closed，不是放行）', () => {
  const p = resolvePrincipalAuthorization({ resident_id: CORE })
  if (p.permissions.length !== 0 || p.scopes.length !== 0) throw new Error(`竟然拿到了权限: ${JSON.stringify(p)}`)
})

console.log('\n— writeScopes 必须是 scopes 子集 —')
process.env.TM_MEMORY_AUTHZ_GRANTS = JSON.stringify({
  by_resident_id: { [CORE]: { scopes: ['line-example'], writeScopes: ['all-agents'], permissions: ['memory:write'], roles: [] } },
})
t('越界 writeScopes → 整条 grant 无效', () => {
  const p = resolvePrincipalAuthorization({ resident_id: CORE })
  if (p.scopes.length !== 0) throw new Error(`竟然生效: ${JSON.stringify(p)}`)
})

console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
