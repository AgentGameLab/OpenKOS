const DEFAULT_CAP = 8
const DEFAULT_WARN_AFTER_MS = 1000

export function resolveBudgetCap(value, fallback = DEFAULT_CAP) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export class OperationSemaphore {
  constructor({
    cap = DEFAULT_CAP,
    name = 'operation',
    warnAfterMs = DEFAULT_WARN_AFTER_MS,
    warn = (message) => console.warn(message),
    now = () => Date.now(),
  } = {}) {
    this.cap = resolveBudgetCap(cap)
    this.name = name
    this.warnAfterMs = warnAfterMs
    this.warn = warn
    this.now = now
    this.activeCount = 0
    this.waiters = []
  }

  get queuedCount() {
    return this.waiters.length
  }

  async acquire({ action = this.name, caller = 'unknown' } = {}) {
    const queuedAt = this.now()

    if (this.activeCount >= this.cap) {
      await new Promise((resolve) => {
        this.waiters.push(resolve)
      })
    } else {
      this.activeCount += 1
    }

    const queuedMs = Math.max(0, Math.round(this.now() - queuedAt))
    if (queuedMs > this.warnAfterMs) {
      this.warn(`[db-budget] queued action=${action} caller=${caller} queued_ms=${queuedMs} cap=${this.cap}`)
    }

    let released = false
    return {
      queuedMs,
      release: () => {
        if (released) return
        released = true
        const next = this.waiters.shift()
        if (next) next()
        else this.activeCount -= 1
      },
    }
  }

  async run(task, metadata) {
    const permit = await this.acquire(metadata)
    try {
      return { value: await task(), queuedMs: permit.queuedMs }
    } finally {
      permit.release()
    }
  }
}
