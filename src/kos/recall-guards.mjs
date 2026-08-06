import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const DEFAULT_TRACE_DIR = fileURLToPath(new URL('../../traces/', import.meta.url))
const ID_REFERENCE_RE = /\bid:([A-Za-z0-9][A-Za-z0-9._:-]*)/gi

function normalizeIdSet(validIdSet) {
  if (validIdSet == null || typeof validIdSet[Symbol.iterator] !== 'function') {
    throw new TypeError('validIdSet must be iterable')
  }
  return new Set([...validIdSet].map((id) => String(id)))
}

export function stripHallucinatedIds(text, validIdSet) {
  const validIds = normalizeIdSet(validIdSet)
  const strippedIds = []
  const seenStrippedIds = new Set()
  const cleanText = String(text ?? '').replace(ID_REFERENCE_RE, (reference, id) => {
    if (validIds.has(id)) return reference
    if (!seenStrippedIds.has(id)) {
      seenStrippedIds.add(id)
      strippedIds.push(id)
    }
    return ''
  })

  return { cleanText, strippedIds }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return value
}

function renderedContextChars(entries) {
  if (entries.length === 0) return 0
  if (entries.every((entry) => typeof entry === 'string')) {
    return entries.join('\n\n').length
  }
  return JSON.stringify(entries).length
}

export function enforceContextBudget(entries, { maxChars, maxEntries }) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array')
  requirePositiveInteger(maxChars, 'maxChars')
  requirePositiveInteger(maxEntries, 'maxEntries')

  const kept = []
  let reason = null
  let droppedIndex = entries.length

  for (let index = 0; index < entries.length; index++) {
    if (kept.length >= maxEntries) {
      reason = 'maxEntries'
      droppedIndex = index
      break
    }

    const candidate = [...kept, entries[index]]
    if (renderedContextChars(candidate) > maxChars) {
      reason = 'maxChars'
      droppedIndex = index
      break
    }
    kept.push(entries[index])
  }

  return {
    kept,
    dropped: entries.slice(droppedIndex),
    reason,
  }
}

function traceDirectory() {
  return path.resolve(process.env.KOS_RECALL_TRACE_DIR || DEFAULT_TRACE_DIR)
}

function safeCallSite(callSite) {
  const value = String(callSite || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)
  return value || 'unknown'
}

export function startTrace(callSite) {
  const startedMs = Date.now()
  const startedAt = new Date(startedMs).toISOString()
  const normalizedCallSite = safeCallSite(callSite)
  const traceId = `${startedAt.replace(/[:.]/g, '-')}-${process.pid}-${randomUUID()}`
  const steps = []
  let completedTrace = null

  return {
    step(name, meta = {}) {
      if (completedTrace) throw new Error('cannot append to an ended recall trace')
      steps.push({
        name: String(name),
        at: new Date().toISOString(),
        elapsedMs: Date.now() - startedMs,
        meta,
      })
    },

    end() {
      if (completedTrace) return completedTrace

      const endedMs = Date.now()
      const dir = traceDirectory()
      const traceFile = path.join(dir, `${normalizedCallSite}-${traceId}.json`)
      completedTrace = {
        traceId,
        callSite: normalizedCallSite,
        startedAt,
        endedAt: new Date(endedMs).toISOString(),
        durationMs: endedMs - startedMs,
        steps: [...steps],
        traceFile,
      }

      fs.mkdirSync(dir, { recursive: true })
      const temporaryFile = `${traceFile}.${randomUUID()}.tmp`
      try {
        fs.writeFileSync(temporaryFile, `${JSON.stringify(completedTrace, null, 2)}\n`, {
          encoding: 'utf-8',
          flag: 'wx',
        })
        fs.renameSync(temporaryFile, traceFile)
      } catch (error) {
        try {
          if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile)
        } catch {}
        completedTrace = null
        throw error
      }

      return completedTrace
    },
  }
}
