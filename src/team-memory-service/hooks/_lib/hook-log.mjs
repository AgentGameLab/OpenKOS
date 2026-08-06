// ============================================================
// Hook 观测共享模块（team-memory-service 版，与个人 hook-log 同接口）
//
//   - logTrace(hookName, event, detail?): 每次 hook 触发写一行到 hook-trace.jsonl
//   - logWarn(hookName, reason, detail?): 异常/校验失败留痕到 hook-warn.jsonl
//   - wrap(hookName, fn): 包一个 async 函数，自动记 triggered + completed/failed + durMs
//
// 设计原则：
//   - Fire-and-forget：log 写入失败不能阻塞 hook 主流程
//   - JSONL：每行一个独立 JSON，便于流式处理和 grep
//   - 零外部依赖：只用 node:fs + node:path
// ============================================================

import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const HOOK_DIR = resolve(process.env.HOME || process.env.USERPROFILE || '', '.claude/hooks')
const TRACE_LOG = resolve(HOOK_DIR, 'hook-trace.jsonl')
const WARN_LOG = resolve(HOOK_DIR, 'hook-warn.jsonl')

function safeAppend(file, line) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, line, 'utf-8')
  } catch {}
}

export function logTrace(hookName, event, detail = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    hook: hookName,
    event,
    ...detail,
  }) + '\n'
  safeAppend(TRACE_LOG, line)
}

export function logWarn(hookName, reason, detail = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    hook: hookName,
    reason,
    ...detail,
  }) + '\n'
  safeAppend(WARN_LOG, line)
  logTrace(hookName, 'failed', { reason, ...detail })
}

export async function wrap(hookName, fn) {
  const start = Date.now()
  logTrace(hookName, 'triggered')
  try {
    const result = await fn()
    logTrace(hookName, 'completed', { durMs: Date.now() - start })
    return result
  } catch (e) {
    logWarn(hookName, 'uncaught_exception', {
      error: e?.message || String(e),
      durMs: Date.now() - start,
    })
    throw e
  }
}

export const HOOK_LOG_PATHS = { TRACE_LOG, WARN_LOG, HOOK_DIR }
