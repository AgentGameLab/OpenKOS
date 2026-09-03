import { tokenizeZh } from './zh-tokenize.mjs'

export const EMBED_INPUT_VERSION = '2'

const EMBED_INPUT_MAX_CHARS = 6000
const LEADING_FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/

export function stripFrontmatter(text) {
  if (!text) return text || ''
  return String(text).replace(LEADING_FRONTMATTER, '')
}

export function buildTokenText({ name, description, summary, content }) {
  return tokenizeZh(
    [name, description, summary, stripFrontmatter(content)]
      .filter(Boolean)
      .join('\n')
  )
}

export function buildEmbedText({ name, description, summary, content }) {
  const input = `${name || ''}\n${description || summary || ''}\n${stripFrontmatter(content)}`
  return input.slice(0, EMBED_INPUT_MAX_CHARS)
}
