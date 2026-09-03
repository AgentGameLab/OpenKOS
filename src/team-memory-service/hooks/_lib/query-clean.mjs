const SYSTEM_PROMPT_PREFIX = /^(?:<task-notification\b|<cross-session-message\b|<system-reminder\b|\[SYSTEM NOTIFICATION\b)/i
const XML_BLOCK = /<([A-Za-z][\w:.-]*)(?:\s[^<>]*?)?>[\s\S]*?<\/\1\s*>/gi
const SYSTEM_BLOCK = /<(task-notification|cross-session-message|system-reminder)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const XML_TAG = /<\/?[A-Za-z][^<>]*>/g
const FILE_URL = /\bfile:\/\/\/?[^\s<>"'`]+/gi
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s<>"'`]+/g
const POSIX_PATH = /(^|[\s([{"'])\/[^\s<>"'`]+/g

function basenameWithTrailingPunctuation(value) {
  const trailing = value.match(/[),.;!?}\]]+$/)?.[0] || ''
  const path = trailing ? value.slice(0, -trailing.length) : value
  const withoutUrlPrefix = path.replace(/^file:\/\/\/?/i, '')
  const withoutQuery = withoutUrlPrefix.replace(/[?#].*$/, '').replace(/[\\/]+$/, '')
  const basename = withoutQuery.split(/[\\/]/).pop() || ''
  return basename + trailing
}

export function isSystemPrompt(prompt) {
  if (typeof prompt !== 'string') return false
  const text = prompt.trim()
  if (!text) return false
  if (SYSTEM_PROMPT_PREFIX.test(text)) return true

  let blockCharacters = 0
  XML_BLOCK.lastIndex = 0
  for (const match of text.matchAll(XML_BLOCK)) blockCharacters += Array.from(match[0]).length

  return blockCharacters / Array.from(text).length > 0.6
}

export function cleanQuery(prompt, { maxChars = 500 } = {}) {
  if (typeof prompt !== 'string') return ''

  let cleaned = prompt
    .replace(SYSTEM_BLOCK, ' ')
    .replace(XML_TAG, ' ')
    .replace(FILE_URL, basenameWithTrailingPunctuation)
    .replace(WINDOWS_PATH, basenameWithTrailingPunctuation)
    .replace(POSIX_PATH, (match, prefix) => {
      const path = match.slice(prefix.length)
      return prefix + basenameWithTrailingPunctuation(path)
    })
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return ''

  const characters = Array.from(cleaned)
  if (characters.length > maxChars) {
    cleaned = `${characters.slice(0, 320).join('')} ... ${characters.slice(-160).join('')}`
  }

  return cleaned
}
