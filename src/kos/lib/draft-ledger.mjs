import fs from 'node:fs'
import path from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OFFICE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const LEDGER = path.join(OFFICE, '.asi', 'kos-draft-tryout.jsonl')
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const TAIL_BYTES = 256 * 1024
const MAX_LEDGER_BYTES = 4 * 1024 * 1024
const MAX_LEDGER_LINES = 2000

// 只对真正的团队记忆卡记账。research/by-owner/** 这类个人工作区文件也会被召回并带 maturity:draft，
// 但它们不是「待升格的卡」，升 verified 对其无意义 —— 放进对账只会把提醒稀释成噪音（R7/R8 的死法）。
// 分类必须与 kos-index-sync.mjs 的团队卡索引源保持同步。
const TEAM_CARD_CATEGORIES = ['rules', 'playbooks', 'decisions', 'findings', 'methods', 'references', 'specs', 'strategy']
const CARD_PATH_RE = new RegExp(`(?:^|/)team-memory/(?:${TEAM_CARD_CATEGORIES.join('|')})/|^(?:${TEAM_CARD_CATEGORIES.join('|')})/`)

function readLedgerTail() {
  let fd
  try {
    fd = fs.openSync(LEDGER, 'r')
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    const bytesRead = fs.readSync(fd, buffer, 0, length, size - length)

    let tail = buffer.subarray(0, bytesRead).toString('utf8')
    if (size > length) {
      const firstNewline = tail.indexOf('\n')
      tail = firstNewline === -1 ? '' : tail.slice(firstNewline + 1)
    }
    return tail.trimEnd().split(/\r?\n/).slice(-MAX_LEDGER_LINES)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function compactLedgerIfNeeded() {
  try {
    if (fs.statSync(LEDGER).size <= MAX_LEDGER_BYTES) return
    const lines = fs.readFileSync(LEDGER, 'utf8').trimEnd().split(/\r?\n/).slice(-MAX_LEDGER_LINES)
    const temp = `${LEDGER}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${lines.join('\n')}\n`, 'utf8')
    fs.renameSync(temp, LEDGER)
  } catch {
    // Ledger compaction is best-effort only.
  }
}

export function recordDraftRecall(results, query) {
  try {
    if (!Array.isArray(results) || results.length === 0) return
    if (!results.some((item) => item?.maturity === 'draft')) return

    fs.mkdirSync(path.dirname(LEDGER), { recursive: true })

    let recentLines = []
    try {
      recentLines = readLedgerTail()
    } catch {
      recentLines = []
    }

    const cutoff = Date.now() - SEVEN_DAYS_MS
    const recentSlugs = new Set()
    for (const line of recentLines) {
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        if (entry.slug && Date.parse(entry.ts) > cutoff) recentSlugs.add(entry.slug)
      } catch {
        // Ignore malformed ledger lines.
      }
    }

    const truncatedQuery = String(query ?? '').slice(0, 200)
    const agent = process.env.KOS_AGENT_ID || process.env.AGENT_ID || 'unknown'

    for (const item of results) {
      if (item?.maturity !== 'draft') continue
      const cardPath = String(item.path || '').replace(/\\/g, '/')
      if (!CARD_PATH_RE.test(cardPath)) continue
      // slug 缺失时回落到文件名而非数字 id —— 提醒里要给人看的是卡名，不是行号
      const slug = item.slug || path.basename(cardPath, '.md') || item.id
      if (!slug || recentSlugs.has(slug)) continue

      const entry = {
        ts: new Date().toISOString(),
        slug,
        path: item.path,
        query: truncatedQuery,
        agent,
        session: process.env.CLAUDE_CODE_SESSION_ID || 'unknown',
      }
      fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`, 'utf8')
      recentSlugs.add(slug)
    }

    compactLedgerIfNeeded()
  } catch {
    // Draft recall accounting must never affect recall behavior.
  }
}
