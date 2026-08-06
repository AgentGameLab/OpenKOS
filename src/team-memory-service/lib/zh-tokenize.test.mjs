// zh-tokenize 单测 — 纯函数、不连 DB。Run: node lib/zh-tokenize.test.mjs

import { tokenizeZh, dictStats } from './zh-tokenize.mjs'

let pass = 0, fail = 0
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label}${detail ? ' -- ' + detail : ''}`) }
}

const stats = dictStats()
check('team dict loads (>= 30 terms)', stats.size >= 30, `size=${stats.size}`)

// 词典词整词切出（通用分词会把「示例助手」「示例维护者」切碎/粘连）
const t1 = tokenizeZh('示例助手负责的模块')
check('dict term 示例助手 survives as whole token', t1.split(' ').includes('示例助手'), `got="${t1}"`)

const t2 = tokenizeZh('示例维护者在示例团队做KOS召回优化')
const t2s = t2.split(' ')
check('multiple dict terms all whole (示例维护者/示例团队/KOS/召回)',
  ['示例维护者', '示例团队', 'KOS', '召回'].every(w => t2s.includes(w)), `got="${t2}"`)

// 通用中文过 Segmenter 切词（非词典词也要能切）
const t3 = tokenizeZh('数据库连接失败')
check('generic Chinese splits into multiple tokens', t3.split(' ').length >= 2, `got="${t3}"`)

// 英文/数字原样保留
const t4 = tokenizeZh('deploy ECS pm2 reload 47.103')
check('English/digit tokens preserved',
  ['deploy', 'ECS', 'pm2', 'reload'].every(w => t4.split(' ').includes(w)), `got="${t4}"`)

// 混合文本
const t5 = tokenizeZh('ExampleProject 的 A2A envelope 由示例维护者 review')
const t5s = t5.split(' ')
check('mixed text keeps dict + English + generic',
  t5s.includes('ExampleProject') && t5s.includes('示例维护者') && t5s.includes('review'), `got="${t5}"`)

// 幂等：已分词文本再过一遍不变（query 侧无条件调用的前提）
const once = tokenizeZh('示例助手 负责 的 模块 deploy')
check('idempotent on already-tokenized text', tokenizeZh(once) === once,
  `once="${once}" twice="${tokenizeZh(once)}"`)

// 空/异常输入
check('empty/null-ish inputs return empty string',
  tokenizeZh('') === '' && tokenizeZh(null) === '' && tokenizeZh(undefined) === '')

// 最长匹配：示例团队群 优先于 示例团队（词典两者都有，长词赢）
const t6 = tokenizeZh('发到示例团队群里')
check('longest-match wins (示例团队群 over 示例团队)', t6.split(' ').includes('示例团队群'), `got="${t6}"`)

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
