
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DICT_PATH = resolve(__dirname, '../dict/team-terms.txt')

let _dict = null      // Set<string>
let _dictRe = null    // RegExp | false（词典空/缺失）

function loadDict() {
  if (_dict) return _dict
  _dict = new Set()
  try {
    for (const line of readFileSync(DICT_PATH, 'utf8').split(/\r?\n/)) {
      const w = line.trim()
      if (w && !w.startsWith('#')) _dict.add(w)
    }
  } catch {
  }
  return _dict
}

function getDictRe() {
  if (_dictRe !== null) return _dictRe
  const words = [...loadDict()].sort((a, b) => b.length - a.length)
  if (!words.length) { _dictRe = false; return _dictRe }
  const esc = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  _dictRe = new RegExp(`(${esc.join('|')})`, 'g')
  return _dictRe
}

const CJK_RUN = /[一-鿿㐀-䶿]+/g          // 中文连续段
const NON_CJK_WORD = /[A-Za-z0-9_][A-Za-z0-9_.+-]*/g      // 英文/数字 token

function bigrams(run) {
  if (run.length <= 2) return [run]
  const out = []
  for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  return out
}

export function tokenizeZh(text) {
  if (!text) return ''
  const s = String(text)
  const dict = loadDict()
  const re = getDictRe()
  const out = []
  const pieces = re ? s.split(re) : [s]
  for (const piece of pieces) {
    if (!piece) continue
    if (dict.has(piece)) { out.push(piece); continue }
    for (const run of piece.match(CJK_RUN) || []) out.push(...bigrams(run))
    for (const w of piece.match(NON_CJK_WORD) || []) out.push(w)
  }
  return out.join(' ')
}

export function dictStats() {
  return { size: loadDict().size, path: DICT_PATH }
}
