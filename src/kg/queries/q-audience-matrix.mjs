#!/usr/bin/env node
// q-audience-matrix.mjs — skill audience 一致性矩阵
//
// 用法：node scripts/kg/queries/q-audience-matrix.mjs
//
// 输出：
//   - public skill 数量
//   - internal skill 数量
//   - audience-mismatch 数量 + 具体清单（要么 public 在 _internal/，要么 internal 不在 _internal/）

import { loadGraph } from './_lib.mjs'

const graph = loadGraph()

const skills = graph.nodes.filter(n => n.type === 'skill' || n.type === 'skill-internal')
const mismatches = graph.edges.filter(e => e.label === 'audience-mismatch')

let pub = 0, intern = 0, missing = 0
for (const s of skills) {
  if (s.audience === 'public') pub++
  else if (s.audience === 'internal') intern++
  else missing++
}

console.log(`# q-audience-matrix · ${new Date().toISOString()}`)
console.log('')
console.log(`总 skill 数: ${skills.length}`)
console.log(`- audience=public: ${pub}`)
console.log(`- audience=internal: ${intern}`)
console.log(`- 字段缺失: ${missing}`)
console.log(`- 不一致 (audience-mismatch edges): ${mismatches.length}`)
console.log('')

if (mismatches.length > 0) {
  console.log('## 不一致清单')
  console.log('')
  for (const m of mismatches) {
    console.log(`- ${m.from} (audience-mismatch)`)
  }
  console.log('')
  console.log('> 行动：mv 到正确路径 OR 改 audience 字段对齐。配套 `.claude/hooks/check-skill-audience-explicit.js` 已激活，新 push 会被拦。')
}

if (missing > 0) {
  console.log('## 字段缺失清单（v1.3 起 audience 必填）')
  console.log('')
  for (const s of skills.filter(x => !x.audience || (x.audience !== 'public' && x.audience !== 'internal'))) {
    console.log(`- ${s.id}`)
  }
  console.log('')
  console.log('> 行动：跑 scripts/qa/backfill-skill-audience.mjs（若存在）或手工加 frontmatter。')
}

if (mismatches.length === 0 && missing === 0) {
  console.log('✓ 全部 skill audience 一致 + 完整')
}
