import assert from 'node:assert'
import { LEGACY_TEAM_ALIASES, isCanonicalScope, isLineScope } from '../lib/scopes.mjs'
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
console.log('PASS  scope 路由回归 5/5')
