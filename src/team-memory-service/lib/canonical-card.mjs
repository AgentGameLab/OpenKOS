
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import crypto from 'node:crypto'
import { parseFrontmatter, renderFrontmatter } from '../../kos/kos-remember.mjs'

const __filename = url.fileURLToPath(import.meta.url)
const __libdir = path.dirname(__filename)
export const ROOT = process.env.KOS_DATA_ROOT || path.resolve(__libdir, '..', '..', '..')

export function mirrorRepoRoot() {
  return process.env.KOS_MIRROR_REPO_ROOT || ROOT
}

const GIT_MIRROR_QUEUE = path.join(ROOT, '.asi', 'git-mirror-queue.jsonl')

export const MATURITY_RANK = { draft: 0, verified: 1, proven: 2 }

export function isInsideRepo(relPath) {
  if (!relPath || typeof relPath !== 'string') return false
  const p = relPath.replace(/\\/g, '/')
  if (path.isAbsolute(relPath)) return false
  if (/^[a-zA-Z]:[/\\]/.test(relPath)) return false   // Windows 盘符
  if (p.startsWith('//')) return false                 // UNC
  if (p.startsWith('/')) return false                  // posix 绝对
  const norm = path.posix.normalize(p)
  return norm !== '..' && !norm.startsWith('../')
}

export function emitGitMirrorEvent({ id, relPath, scope, kosAction, authorAgentId }) {
  if (scope === 'personal') return // personal 不入仓

  if (!isInsideRepo(relPath)) {
    console.warn(`[/api/memory] git-mirror skip: 路径逃出仓 (${relPath}) — 个人记忆不入团队 mirror 队列`)
    return
  }

  try {
    const entry = {
      ts: new Date().toISOString(),
      id,
      path: relPath,
      scope,
      kos_action: kosAction,
      author_agent_id: authorAgentId || null,
    }
    const dir = path.dirname(GIT_MIRROR_QUEUE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(GIT_MIRROR_QUEUE, JSON.stringify(entry) + '\n', 'utf-8')
  } catch (err) {
    console.warn(`[/api/memory] git-mirror queue emit failed (non-fatal): ${err.message}`)
  }
}

function resolveVariants(sourceFile) {
  const rel = String(sourceFile || '').trim().replace(/\\/g, '/')
  if (!rel) return []
  const out = [rel]
  if (!rel.startsWith('team-memory/')) out.push(`team-memory/${rel}`)
  return out.filter(isInsideRepo)
}

function readIfExists(root, rel) {
  const abs = path.join(root, rel)
  try {
    if (!fs.statSync(abs).isFile()) return null
  } catch { return null }
  return { abs, text: fs.readFileSync(abs, 'utf-8') }
}

export function loadCanonicalCard(sourceFile) {
  const variants = resolveVariants(sourceFile)
  if (variants.length === 0) {
    return String(sourceFile || '').trim() ? { found: false, rel: String(sourceFile).trim() } : null
  }

  for (const root of [...new Set([mirrorRepoRoot(), ROOT])]) {
    for (const rel of variants) {
      const hit = readIfExists(root, rel)
      if (!hit) continue
      const { fm, body, comments, orphanLines } = parseFrontmatter(hit.text)
      const maturity = typeof fm.maturity === 'string' ? fm.maturity.trim() : null
      return {
        found: true,
        rel,
        readRoot: root,
        readPath: hit.abs,
        writePath: path.join(ROOT, rel),
        text: hit.text,
        fm, body, comments, orphanLines,
        maturity,
        frozen: fm.frozen === true || fm.frozen === 'true',
        maturityUnreadable: fm.maturity != null && typeof fm.maturity !== 'string',
      }
    }
  }
  return { found: false, rel: variants[0] }
}

export function planCanonicalMaturity(card, maturity) {
  if (!card || !card.found) throw new Error('planCanonicalMaturity: card not found')
  if (card.maturityUnreadable) throw new Error(`canonical frontmatter 的 maturity 不是标量，无法安全改写：${card.rel}`)
  if (card.maturity === maturity) return { changed: false, text: card.text }
  const nextFm = { ...card.fm, maturity }
  const fmYaml = renderFrontmatter(nextFm, card.comments, card.orphanLines)
  const text = fmYaml.slice(0, -1) + card.body
  return { changed: true, text }
}

export function writeCanonicalCard(card, text) {
  const filePath = card.writePath
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}-${crypto.randomUUID()}.tmp`,
  )
  try {
    fs.writeFileSync(tempPath, text, 'utf-8')
    const readBack = fs.readFileSync(tempPath, 'utf-8')
    if (readBack !== text) {
      throw new Error(`canonical 回写校验失败 ${filePath}: read-back content differs`)
    }
    fs.renameSync(tempPath, filePath)
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
  return filePath
}
