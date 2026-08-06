const MAX_INJECTED_HIT_CHARS = 300

export function capText(value, maxChars = MAX_INJECTED_HIT_CHARS) {
  return Array.from(String(value || '')).slice(0, maxChars).join('')
}


export function isFreshHit(hit, windowDays, now = Date.now()) {
  const t = Date.parse(hit?.created_at || '')
  return Number.isFinite(t) && now - t <= windowDays * 86_400_000
}

export function applyFreshSlot(hits, { topSlots = 3, windowDays = 14, now = Date.now() } = {}) {
  const top = hits.slice(0, topSlots)
  if (top.some(h => isFreshHit(h, windowDays, now))) return { top, freshPick: null }
  const freshPick = hits.slice(topSlots).find(h => isFreshHit(h, windowDays, now)) || null
  if (!freshPick) return { top, freshPick: null }
  return { top: [...top.slice(0, topSlots - 1), freshPick], freshPick }
}

export function trimToBudget(items, budgetChars, textOf = (x) => String(x)) {
  const kept = []
  let used = 0
  for (const item of items) {
    const len = Array.from(String(textOf(item))).length
    if (kept.length > 0 && used + len > budgetChars) break
    kept.push(item)
    used += len
  }
  return { kept, used, trimmed: items.length - kept.length }
}

export function recallLayer(hit) {
  const maturity = String(hit?.maturity || '').toLowerCase()
  if (maturity === 'proven' || maturity === 'verified' || maturity === 'draft') return maturity
  return 'unknown'
}

function stripFrontmatter(text) {
  const s = String(text || '')
  if (!/^\s*---\r?\n/.test(s)) return s
  const end = s.indexOf('\n---', 3)
  if (end === -1) return s
  return s.slice(s.indexOf('\n', end + 1) + 1).trimStart()
}

function renderPreviousHit(hit) {
  const tags = hit.tags?.length ? ` #${hit.tags.slice(0, 3).join(' #')}` : ''
  const sum = hit.summary ? `\n  📌 ${hit.summary}` : ''
  const stripped = stripFrontmatter(hit.content)
  const body = stripped.slice(0, MAX_INJECTED_HIT_CHARS).replace(/\n+/g, ' ')
  const srcs = hit.recall_sources?.length ? ` ${hit.recall_sources.join('+')}` : ''
  return `[id:${hit.id} ${hit.type} ${hit.maturity} ★${hit.importance}${srcs}]${tags}${sum}\n  ${body}${stripped.length > MAX_INJECTED_HIT_CHARS ? '...' : ''}`
}

export function renderRecallHit(hit) {
  let layer = 'unknown'
  try {
    layer = recallLayer(hit)
    if (layer === 'draft') {
      const name = hit.name || hit.slug || hit.id || '(unnamed)'
      const sourceFile = hit.source_file || hit.path || '(unknown source)'
      return { layer, text: capText(`${name} — ${sourceFile}`) }
    }
  } catch {
  }
  return { layer, text: renderPreviousHit(hit) }
}
