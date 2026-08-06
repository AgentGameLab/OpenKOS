// 追加用例：默认召回面 vs 可见面分离（防跨环投毒 · codex P1-6）
const modPath = process.argv[2]
const m = await import(`file:///${modPath.split(String.fromCharCode(92)).join('/')}`)
const { resolvePrincipalAuthorization, authorizeRequestedScopes, authorizeWriteScope, resolveDefaultScopes } = m
let pass = 0, fail = 0
const t = (n, f) => { try { f(); console.log('  PASS  ' + n); pass++ } catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++ } }
const throws = (f, w) => { try { f() } catch { return } throw new Error('应该抛错但没抛：' + w) }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(w + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)) }

process.env.TM_MEMORY_AUTHZ_GRANTS = JSON.stringify({
  by_resident_id: {
    'r-core2': { scopes: ['core','shared','line-example'], writeScopes: ['core','shared','line-example'], defaultScopes: ['core','shared'], permissions: ['memory:read','memory:write','memory:promote'], roles: ['approver'] },
    'r-line2': { scopes: ['shared','line-example'], writeScopes: ['line-example'], permissions: ['memory:read','memory:write','memory:promote'], roles: [] },
  },
})
console.log('\n— 默认召回面与可见面分离（防跨环投毒）—')
t('core 默认召回不含线级环', () => eq(resolveDefaultScopes(resolvePrincipalAuthorization({ resident_id: 'r-core2' })).sort(), ['core','shared'], 'default'))
t('core 显式请求仍可读线级环', () => eq(authorizeRequestedScopes(resolvePrincipalAuthorization({ resident_id: 'r-core2' }), ['line-example'], []), ['line-example'], 'explicit'))
t('core 可写 shared 与线级环', () => { const p = resolvePrincipalAuthorization({ resident_id: 'r-core2' }); eq(authorizeWriteScope(p,'shared'),'shared','w1'); eq(authorizeWriteScope(p,'line-example'),'line-example','w2') })
t('线级 principal 默认召回=自己可见面', () => eq(resolveDefaultScopes(resolvePrincipalAuthorization({ resident_id: 'r-line2' })).sort(), ['line-example','shared'], 'linedefault'))
t('线级仍不能写 shared', () => throws(() => authorizeWriteScope(resolvePrincipalAuthorization({ resident_id: 'r-line2' }), 'shared'), '线级写 shared'))
t('defaultScopes 越界 → 整条 grant 无效', () => {
  process.env.TM_MEMORY_AUTHZ_GRANTS = JSON.stringify({ by_resident_id: { x: { scopes: ['shared'], defaultScopes: ['core'], permissions: ['memory:read'], roles: [] } } })
  if (resolvePrincipalAuthorization({ resident_id: 'x' }).scopes.length !== 0) throw new Error('竟然生效')
})
console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
