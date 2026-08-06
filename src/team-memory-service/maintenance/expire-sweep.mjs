#!/usr/bin/env node
// ADR-032 P3: expire-sweep daemon
//
// 每天 cron 跑一次：UPDATE team_memory.memories
//   SET expired_at = now()
//   WHERE expires_at IS NOT NULL
//     AND expires_at < now()
//     AND expired_at IS NULL;
//
// 永远不 `DELETE FROM` · 仅 mark expired_at（追溯链完整保留）。
//
// 部署：scheduler-config.json 加 cron `0 4 * * *`（每日 4am UTC = 12pm CST）
// 跑 ECS team-memory-service 内置 (design vote)

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { Client } = require('pg')

const __here = dirname(fileURLToPath(import.meta.url))
const OFFICE_ENV = resolve(__here, '..', '..', '..', '.env.local')
let url = process.env.TM_DATABASE_URL  // 2026-06-29 KOS→pm01: 不 fallback DATABASE_URL(=老 RDS)
if (!url) {
  try {
    const env = readFileSync(OFFICE_ENV, 'utf-8')
    url = env.split(/\r?\n/).find(l => l.startsWith('TM_DATABASE_URL='))?.split('=').slice(1).join('=').trim()
  } catch {}
}
if (!url) {
  console.error('[expire-sweep] no TM_DATABASE_URL / DATABASE_URL')
  process.exit(1)
}

const DRY_RUN = process.argv.includes('--dry-run')

const c = new Client({ connectionString: url })
await c.connect()

try {
  // dry-run: count + list candidates
  const candidates = await c.query(`
    SELECT id, name, type, expires_at, (now() - expires_at) AS overdue
    FROM team_memory.memories
    WHERE expires_at IS NOT NULL
      AND expires_at < now()
      AND expired_at IS NULL
    ORDER BY expires_at ASC
  `)

  console.log(`[expire-sweep] candidates: ${candidates.rowCount}`)
  if (candidates.rowCount > 0) {
    for (const row of candidates.rows.slice(0, 10)) {
      console.log(`  id=${row.id} type=${row.type} name="${row.name}" overdue=${row.overdue}`)
    }
    if (candidates.rowCount > 10) console.log(`  ... +${candidates.rowCount - 10} more`)
  }

  if (DRY_RUN) {
    console.log('[expire-sweep] dry-run, no UPDATE executed')
  } else if (candidates.rowCount > 0) {
    const r = await c.query(`
      UPDATE team_memory.memories
      SET expired_at = now()
      WHERE expires_at IS NOT NULL
        AND expires_at < now()
        AND expired_at IS NULL
      RETURNING id
    `)
    console.log(`[expire-sweep] marked ${r.rowCount} rows expired_at = now()`)
  } else {
    console.log('[expire-sweep] no candidates, nothing to do')
  }
} catch (e) {
  console.error('[expire-sweep] error:', e.message)
  process.exit(1)
} finally {
  await c.end()
}
