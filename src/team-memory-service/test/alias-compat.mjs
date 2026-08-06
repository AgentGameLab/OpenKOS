// 别名兼容：all-agents / team 改名 core 后，存量调用方不能被打断
const modPath = process.argv[2]
const m = await import(`file:///${modPath.split(String.fromCharCode(92)).join('/')}`)
const { resolvePrincipalAuthorization, authorizeRequestedScopes, authorizeWriteScope } = m

let pass = 0, fail = 0
const t = (n, f) => { try { f(); console.log('  PASS  ' + n); pass++ } catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++ } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(w + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)) }

process.env.TM_MEMORY_AUTHZ_GRANTS = JSON.stringify({
  by_resident_id: {
    'r-legacy': { scopes: ['all-agents'], writeScopes: ['team'], permissions: ['memory:read', 'memory:write', 'memory:promote'], roles: [] },
  },
})

console.log('\n— 别名兼容（存量调用方写旧名）—')
t('grant 里写 all-agents/team → 归一成 core', () => {
  const p = resolvePrincipalAuthorization({ resident_id: 'r-legacy' })
  eq(p.scopes, ['core'], 'scopes'); eq(p.writeScopes, ['core'], 'writeScopes')
})
t('召回请求写 all-agents → 放行并归一', () =>
  eq(authorizeRequestedScopes(resolvePrincipalAuthorization({ resident_id: 'r-legacy' }), ['all-agents'], []), ['core'], 'recall'))
t('写入请求写 team → 放行并归一', () =>
  eq(authorizeWriteScope(resolvePrincipalAuthorization({ resident_id: 'r-legacy' }), 'team'), 'core', 'write'))
t('写入请求直接写 core → 放行', () =>
  eq(authorizeWriteScope(resolvePrincipalAuthorization({ resident_id: 'r-legacy' }), 'core'), 'core', 'write-core'))

console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
