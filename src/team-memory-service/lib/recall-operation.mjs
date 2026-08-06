const REQUEST_FIELDS = [
  'limit',
  'source',
  'min_importance',
  'maturity_filter',
  'type_filter',
  'scope_filter',
  'include_expired',
  'include_superseded',
]

function summarizeRequest(request = {}) {
  const summary = {
    query: String(request.query ?? request.queryText ?? '').slice(0, 200),
  }
  for (const field of REQUEST_FIELDS) {
    if (request[field] !== undefined) summary[field] = request[field]
  }
  return summary
}

function summarizeResponse(response) {
  if (!response) return null
  return {
    hit_count: Array.isArray(response.hits) ? response.hits.length : 0,
    query_path: response.query_path || null,
    recall_log_id: response.recall_log_id ?? null,
  }
}

function errorClass(error) {
  if (!error) return null
  if (error.name && error.name !== 'Error') return error.name
  return error.code || error.name || error.constructor?.name || 'Error'
}

export function createRecallOperation({
  semaphore,
  auditLog,
  now = () => Date.now(),
  warn = (message) => console.warn(message),
}) {
  if (!semaphore || typeof semaphore.acquire !== 'function') {
    throw new TypeError('semaphore.acquire is required')
  }
  if (typeof auditLog !== 'function') {
    throw new TypeError('auditLog is required')
  }

  function emit(entry) {
    try {
      const pending = auditLog(entry)
      if (pending && typeof pending.catch === 'function') {
        pending.catch((error) => warn(`[audit] asynchronous sink failed: ${error.message}`))
      }
    } catch (error) {
      warn(`[audit] sink failed: ${error.message}`)
    }
  }

  return async function runRecall({ caller = 'unknown', request = {}, execute }) {
    if (typeof execute !== 'function') throw new TypeError('execute is required')

    const startedAt = now()
    let permit
    let response = null
    let failure = null

    try {
      permit = await semaphore.acquire({ action: 'recall', caller })
      response = await execute()
      return response
    } catch (error) {
      failure = error
      throw error
    } finally {
      const endedAt = now()
      permit?.release()
      emit({
        ts: new Date(startedAt).toISOString(),
        action: 'recall',
        caller,
        request_summary: summarizeRequest(request),
        response_summary: summarizeResponse(response),
        latency_ms: Math.max(0, Math.round(endedAt - startedAt)),
        error_class: errorClass(failure),
        queued_ms: permit?.queuedMs ?? 0,
      })
    }
  }
}
