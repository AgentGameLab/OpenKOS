import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'

const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_LOG_DIR = path.resolve(__dirname, '..', '..', '..', 'audit-logs')
const AUDIT_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

function toJsonLine(entry, now) {
  const normalized = {
    ts: entry.ts || now().toISOString(),
    action: entry.action || 'unknown',
    caller: entry.caller || 'unknown',
    request_summary: entry.request_summary ?? null,
    response_summary: entry.response_summary ?? null,
    latency_ms: Number.isFinite(entry.latency_ms) ? entry.latency_ms : null,
    error_class: entry.error_class || null,
  }
  if (Number.isFinite(entry.queued_ms)) normalized.queued_ms = entry.queued_ms
  return JSON.stringify(normalized, (_key, value) => {
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Error) return value.name
    return value
  }) + '\n'
}

export function createAuditLogger({
  logDir = process.env.KOS_AUDIT_LOG_DIR || DEFAULT_LOG_DIR,
  retentionDays = DEFAULT_RETENTION_DAYS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  now = () => new Date(),
} = {}) {
  let pending = Promise.resolve()
  let stopped = false

  function warn(message, error) {
    console.warn(`[audit] ${message}: ${error.message}`)
  }

  function log(entry) {
    if (stopped) return
    const observedAt = now()
    const day = observedAt.toISOString().slice(0, 10)
    const line = toJsonLine(entry || {}, () => observedAt)

    pending = pending
      .then(async () => {
        await mkdir(logDir, { recursive: true })
        await appendFile(path.join(logDir, `${day}.jsonl`), line, 'utf8')
      })
      .catch((error) => warn('write failed', error))
  }

  async function sweep() {
    let entries
    try {
      entries = await readdir(logDir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }

    const cutoff = new Date(now())
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays)
    const cutoffDay = cutoff.toISOString().slice(0, 10)

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) return
      const match = entry.name.match(AUDIT_FILE_RE)
      if (!match || match[1] >= cutoffDay) return
      await unlink(path.join(logDir, entry.name))
    }))
  }

  const timer = sweepIntervalMs > 0
    ? setInterval(() => {
        sweep().catch((error) => warn('retention sweep failed', error))
      }, sweepIntervalMs)
    : null
  timer?.unref?.()

  return {
    log,
    sweep,
    async drain() {
      await pending
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
    },
  }
}
