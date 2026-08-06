import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const requestedRoot = process.env.TEAM_MEMORY_REPO_ROOT || process.cwd()
const ROOT = fs.existsSync(path.join(requestedRoot, 'team-memory'))
  ? requestedRoot
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const MEMORY_DIRS = ['rules', 'playbooks', 'decisions', 'findings', 'specs', 'methods']
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'http', 'https', 'com', 'www', 'md', 'mjs'])

function scalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'))
  return match ? match[1].replace(/^['\"]|['\"]$/g, '').trim() : ''
}

function arrayValue(value) {
  if (!value) return []
  const text = value.trim().replace(/^\[|\]$/g, '')
  return text.split(',').map((item) => item.trim().replace(/^['\"]|['\"]$/g, '')).filter(Boolean)
}

function arrayField(frontmatter, key) {
  const inline = frontmatter.match(new RegExp(`^${key}:\\s*(\\[[^\\n]*\\])\\s*$`, 'm'))
  if (inline) return arrayValue(inline[1])
  const block = frontmatter.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+[^\\n]+\\n?)*)`, 'm'))
  return block ? [...block[1].matchAll(/^\s+-\s+(.+)$/gm)].map((match) => match[1].trim().replace(/^['\"]|['\"]$/g, '')).filter(Boolean) : []
}

function cueArray(frontmatter, key) {
  const inline = frontmatter.match(new RegExp(`^\\s+${key}:\\s*(\\[[^\\n]*\\])\\s*$`, 'm'))
  if (inline) return arrayValue(inline[1])
  const block = frontmatter.match(new RegExp(`^\\s+${key}:\\s*\\n((?:\\s+-\\s+[^\\n]+\\n?)*)`, 'm'))
  if (block) return [...block[1].matchAll(/^\s+-\s+(.+)$/gm)].map((match) => match[1].trim().replace(/^['\"]|['\"]$/g, '')).filter(Boolean)
  const flow = frontmatter.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`))
  return flow ? arrayValue(`[${flow[1]}]`) : []
}

function deriveEntities(name, description, tags, type) {
  const values = [...tags.filter((tag) => tag.toLowerCase() !== 'team' && tag.toLowerCase() !== type.toLowerCase())]
  const text = `${name} ${description}`
  const tokens = text.match(/[a-z][a-z0-9._-]{2,}/gi) || []
  for (const token of tokens) {
    const value = token.toLowerCase()
    if (!STOPWORDS.has(value)) values.push(value)
  }
  values.push(...(text.match(/[\u4e00-\u9fff]{2,6}/g) || []))
  return [...new Set(values.map((value) => value.toLowerCase()))].slice(0, 12)
}

function parseEntry(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  const frontmatter = match[1]
  const status = scalar(frontmatter, 'status').toLowerCase()
  if (status === 'deprecated' || status === 'superseded') return null
  const name = scalar(frontmatter, 'name')
  const type = scalar(frontmatter, 'type')
  const maturity = scalar(frontmatter, 'maturity')
  const tags = arrayField(frontmatter, 'tags')
  const cues = {
    paths: cueArray(frontmatter, 'paths').slice(0, 8),
    tools: cueArray(frontmatter, 'tools').slice(0, 8),
    cmds: cueArray(frontmatter, 'cmds').slice(0, 12),
    entities: cueArray(frontmatter, 'entities').slice(0, 12),
  }
  if (!cues.entities.length) cues.entities = deriveEntities(name, scalar(frontmatter, 'description'), tags, type)
  return {
    slug: path.basename(filePath, '.md'),
    rel: path.relative(ROOT, filePath).replace(/\\/g, '/'),
    type,
    maturity,
    cues,
  }
}

const entries = []
for (const directory of MEMORY_DIRS) {
  const directoryPath = path.join(ROOT, 'team-memory', directory)
  if (!fs.existsSync(directoryPath)) continue
  for (const item of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith('.md')) continue
    const entry = parseEntry(path.join(directoryPath, item.name))
    if (entry) entries.push(entry)
  }
}

const outputDir = path.join(ROOT, '.asi')
fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(path.join(outputDir, 'cue-index.json'), `${JSON.stringify({ built_at: new Date().toISOString(), entries }, null, 2)}\n`, 'utf8')
process.stdout.write(`${entries.length}\n`)
