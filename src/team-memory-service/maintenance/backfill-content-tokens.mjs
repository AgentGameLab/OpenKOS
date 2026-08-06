#!/usr/bin/env node
// backfill-content-tokens.mjs — 给存量行补 content_tokens（20260722_001 migration 配套）
//
// 默认 dry-run 只报数量；--apply 真写。批量 200/轮防长事务。
// 用法：
//   node maintenance/backfill-content-tokens.mjs            # dry-run
//   node maintenance/backfill-content-tokens.mjs --apply
//
// 与 store.mjs 写入路径同源：token 串 = tokenizeZh(content + name + summary)。

import { query } from '../lib/db.mjs'
import { tokenizeZh, dictStats } from '../lib/zh-tokenize.mjs'

const APPLY = process.argv.includes('--apply')
const BATCH = 200

async function main() {
  const { size } = dictStats()
  console.log(`[backfill] dict loaded: ${size} terms · mode=${APPLY ? 'APPLY' : 'dry-run'}`)

  const pending = await query(
    `SELECT count(*) AS n FROM team_memory.memories WHERE content_tokens IS NULL`
  )
  const total = Number(pending.rows[0].n)
  console.log(`[backfill] rows with content_tokens IS NULL: ${total}`)
  if (!APPLY || total === 0) {
    if (!APPLY && total > 0) console.log('[backfill] dry-run 结束 — 用 --apply 真写')
    process.exit(0)
  }

  let done = 0
  for (;;) {
    const r = await query(
      `SELECT id, content, name, summary FROM team_memory.memories
       WHERE content_tokens IS NULL ORDER BY id LIMIT $1`,
      [BATCH]
    )
    if (r.rows.length === 0) break
    for (const row of r.rows) {
      const tokens = tokenizeZh([row.content, row.name, row.summary].filter(Boolean).join(' '))
      await query(
        `UPDATE team_memory.memories SET content_tokens = $1 WHERE id = $2`,
        [tokens, row.id]
      )
      done++
    }
    console.log(`[backfill] ${done}/${total}`)
  }
  console.log(`[backfill] done: ${done} rows updated`)
  process.exit(0)
}

main().catch(e => { console.error('[backfill] FATAL:', e.message); process.exit(1) })
