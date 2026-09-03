#!/usr/bin/env node
// backfill-content-tokens.mjs — 给存量行补 content_tokens（20260722_001 migration 配套）
//
// 默认 dry-run 只报数量；--apply 真写。批量 200/轮防长事务。
// 用法：
//   node maintenance/backfill-content-tokens.mjs            # dry-run
//   node maintenance/backfill-content-tokens.mjs --apply
//   node maintenance/backfill-content-tokens.mjs --apply --limit 500
//
// 与 store.mjs 写入路径同源：统一走 buildTokenText，排除 YAML frontmatter。

import { query } from '../lib/db.mjs'
import { buildTokenText } from '../lib/text-prep.mjs'
import { dictStats } from '../lib/zh-tokenize.mjs'

const APPLY = process.argv.includes('--apply')
const BATCH = 200
const limitIndex = process.argv.indexOf('--limit')
const LIMIT = limitIndex === -1 ? null : Number(process.argv[limitIndex + 1])

if (limitIndex !== -1 && (!Number.isInteger(LIMIT) || LIMIT <= 0)) {
  throw new Error('--limit requires a positive integer')
}

async function main() {
  const { size } = dictStats()
  console.log(`[backfill] dict loaded: ${size} terms · mode=${APPLY ? 'APPLY' : 'dry-run'}`)

  const pending = await query(
    `SELECT count(*) AS n FROM team_memory.memories WHERE content_tokens IS NULL`
  )
  const total = Number(pending.rows[0].n)
  console.log(`[backfill] rows with content_tokens IS NULL: ${total}`)
  const target = LIMIT === null ? total : Math.min(total, LIMIT)
  if (LIMIT !== null) console.log(`[backfill] selected by --limit: ${target}`)
  if (!APPLY || target === 0) {
    if (!APPLY && target > 0) console.log('[backfill] dry-run 结束 — 用 --apply 真写')
    process.exit(0)
  }

  let done = 0
  while (done < target) {
    const batchSize = Math.min(BATCH, target - done)
    const r = await query(
      `SELECT id, content, name, description, summary FROM team_memory.memories
       WHERE content_tokens IS NULL ORDER BY id LIMIT $1`,
      [batchSize]
    )
    if (r.rows.length === 0) break
    for (const row of r.rows) {
      const tokens = buildTokenText(row)
      await query(
        `UPDATE team_memory.memories SET content_tokens = $1 WHERE id = $2`,
        [tokens, row.id]
      )
      done++
      if (done % 100 === 0) console.log(`[backfill] progress: ${done}/${target}`)
    }
  }
  if (done % 100 !== 0) console.log(`[backfill] progress: ${done}/${target}`)
  console.log(`[backfill] done: ${done} rows updated`)
  process.exit(0)
}

main().catch(e => { console.error('[backfill] FATAL:', e.message); process.exit(1) })
