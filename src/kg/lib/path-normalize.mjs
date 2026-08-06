import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..', '..')
const CODE_REPO_ROOT = process.env.KOS_CODE_REPO ? path.resolve(process.env.KOS_CODE_REPO) : null

const DEFAULT_REPO_ROOTS = [
  { key: 'office', path: ROOT },
  ...(CODE_REPO_ROOT ? [{ key: 'code', path: CODE_REPO_ROOT }] : []),
]

export function normalizePathKey(input, { repoRoots = DEFAULT_REPO_ROOTS } = {}) {
  const raw = String(input ?? '')
  if (raw.includes('\0')) throw new Error('path contains NUL byte')
  if (!raw.trim()) throw new Error('path is empty')

  const roots = normalizeRepoRoots(repoRoots)
  const lexicalPath = path.resolve(ROOT, raw)
  const lexicalMatch = findRootMatch(lexicalPath, roots, 'lexicalComparePath')
  let realPath

  try {
    realPath = fs.realpathSync.native(lexicalPath)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (!lexicalMatch) throw new Error(`path escapes known repo roots: ${raw}`)
      return `${lexicalMatch.key}:${toRepoRel(lexicalMatch.lexicalPath, lexicalPath)}`
    }
    throw error
  }

  const realMatch = findRootMatch(realPath, roots, 'realComparePath')
  if (!realMatch) {
    if (!lexicalMatch) throw new Error(`path escapes known repo roots: ${raw}`)
    return {
      key: `${lexicalMatch.key}:${toRepoRel(lexicalMatch.lexicalPath, lexicalPath)}`,
      external: true,
    }
  }

  return `${realMatch.key}:${toRepoRel(realMatch.realPath, realPath)}`
}

export function parsePathKey(key) {
  const raw = String(key ?? '')
  const index = raw.indexOf(':')
  if (index <= 0 || index === raw.length - 1) throw new Error(`invalid path key: ${raw}`)

  const repoKey = raw.slice(0, index)
  const relPath = raw.slice(index + 1)
  if (repoKey.includes('\0') || relPath.includes('\0')) throw new Error('path key contains NUL byte')
  if (path.posix.isAbsolute(relPath) || relPath.split('/').includes('..')) {
    throw new Error(`invalid relative path in key: ${raw}`)
  }

  return { repoKey, relPath }
}

function normalizeRepoRoots(repoRoots) {
  if (!Array.isArray(repoRoots) || repoRoots.length === 0) throw new Error('repoRoots must not be empty')

  return repoRoots
    .map(root => {
      const key = String(root?.key ?? '').trim()
      const rootPath = String(root?.path ?? '')
      if (!key) throw new Error('repo root key is empty')
      if (key.includes(':')) throw new Error(`repo root key contains colon: ${key}`)
      if (!rootPath.trim()) throw new Error(`repo root path is empty for ${key}`)

      const lexicalPath = path.resolve(rootPath)
      const realPath = fs.realpathSync.native(lexicalPath)
      return {
        key,
        lexicalPath,
        realPath,
        lexicalComparePath: casefoldPath(lexicalPath),
        realComparePath: casefoldPath(realPath),
      }
    })
    .sort((a, b) => b.realComparePath.length - a.realComparePath.length)
}

function findRootMatch(candidatePath, roots, compareField) {
  const comparePath = casefoldPath(candidatePath)
  return roots.find(root => isWithinRoot(comparePath, root[compareField]))
}

function isWithinRoot(candidatePath, rootPath) {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`)
}

function toRepoRel(rootPath, candidatePath) {
  const rel = path.relative(rootPath, candidatePath).replace(/\\/g, '/')
  if (!rel || rel === '.') throw new Error('repo root itself is not a file path key')
  if (path.posix.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error(`path escapes repo root: ${candidatePath}`)
  }
  return rel
}

function casefoldPath(value) {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}
