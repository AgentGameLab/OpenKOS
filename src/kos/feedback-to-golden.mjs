#!/usr/bin/env node
// feedback-to-golden.mjs — L0 Rollout 活水：把 feedback_*.md 中的人工修正批量抽成 golden candidate。
// SkillOpt 映射的 L0：feedback 写完不再是 dead-end，自动落 golden 语料供 eval rollout。
// 产物由 eval 维护者复核。
//
// 用法: node scripts/kos/feedback-to-golden.mjs --memory-dir <dir> [--out <file>] [--dry]
//   memory-dir 可通过 KOS_MEMORY_DIR 或 --memory-dir 指定；out = data/kos-eval/golden-candidates-backfill.jsonl
// 产物 status=candidate + needs_review=true：原始抽取，wrong_output/situation 待人工精修，绝不自动进 core。
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { loadRoster } from './roster.mjs'

const argv = process.argv.slice(2)
const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const DRY = argv.includes('--dry')
const MEM_DIR = process.env.KOS_MEMORY_DIR || getArg('--memory-dir')
if (!MEM_DIR) {
  console.error('缺少记忆目录：请设置 KOS_MEMORY_DIR，或传入 --memory-dir <dir>。')
  process.exit(1)
}
const OUT = getArg('--out', join(process.cwd(), 'data', 'kos-eval', 'golden-candidates-backfill.jsonl'))
const GOLDEN = join(process.cwd(), 'data', 'kos-eval', 'golden.jsonl')

// pinned normalize + signature_hash（与 golden-eval-standard.md §一 一致，不许各写各的）
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
const sigHash = (root, cat) => crypto.createHash('sha1').update(norm(root) + '|' + norm(cat)).digest('hex').slice(0, 8)

// 配置的团队成员名（用于 caught_by 抽取；空数组时自然跳过）
const PEOPLE = loadRoster().people.filter(Boolean)
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const CATCH_VERBS = /(catch|指出|点破|拍|反馈|纠正|问|recall|challenge|抓|提醒)/

// category 启发式（从文件名关键词 → 受控小集合）
function categoryOf(slug) {
  const s = slug.toLowerCase()
  if (/(evidence|verify|production_log|counter_evidence|liveness|revparse|migration_audit)/.test(s)) return 'evidence-over-impression'
  if (/(channel|broadcast|dm|at_mention|ou|reaction|notify|group_voice)/.test(s)) return 'communication-routing'
  if (/(owner|boundary|cross_owner|substitute|branch|parallel|p2p)/.test(s)) return 'owner-boundary'
  if (/(autonomy|mandate|ack|over|inflate|ab_choice|ops_reporting)/.test(s)) return 'autonomy-calibration'
  if (/(sync|cid|codeowners|memory_sync|three_line|git_pull|commit|push)/.test(s)) return 'doc-sync'
  if (/(rule|iron|whitelist|grep_rules|symptom|rootcause)/.test(s)) return 'rule-application'
  if (/(daemon|hook|tsc|lint|restart|backend|vendored)/.test(s)) return 'daemon-infra'
  if (/(audience|domestic|additive|strategic|positioning)/.test(s)) return 'product-positioning'
  return 'general-correction'
}

function parseFeedback(text, slug) {
  // frontmatter
  const fm = text.match(/^---\n([\s\S]*?)\n---/)
  let name = '', description = ''
  if (fm) {
    const nm = fm[1].match(/^name:\s*(.+)$/m); if (nm) name = nm[1].trim()
    const dm = fm[1].match(/^description:\s*(.+)$/m); if (dm) description = dm[1].trim()
  }
  const body = fm ? text.slice(fm[0].length) : text
  // Why 段（实证/catch/错在哪）
  const why = body.match(/\*\*Why[^*]*\*\*[:：]?\s*([\s\S]*?)(?:\n\*\*How|\n## |$)/)
  const whyText = why ? why[1].replace(/\n+/g, ' ').trim() : ''
  // 规则陈述（body 第一段非空，作 correct_output 兜底）
  const firstPara = body.replace(/^\s+/, '').split(/\n\n/)[0].replace(/\n/g, ' ').trim()
  // caught_by
  let caughtBy = null
  const scope = (whyText + ' ' + description)
  for (const p of PEOPLE) {
    const re = new RegExp(escapeRegExp(p) + '[^。.]{0,12}' + CATCH_VERBS.source)
    if (re.test(scope)) { caughtBy = p; break }
  }
  if (!caughtBy) { for (const p of PEOPLE) { if (scope.includes(p)) { caughtBy = p; break } } }
  // situation: 取 Why 前 1-2 句，跳过太短/纯日期列表的开头碎片
  const whySents = whyText.split(/[。.]/).map(s => s.trim()).filter(Boolean)
  let situation = ''
  for (const s of whySents) { situation += (situation ? '。' : '') + s; if (situation.length >= 30) break }
  if (situation.length < 15) situation = description
  return {
    name, description,
    correct_output: (name || firstPara).replace(/^#+\s*/, '').replace(/（\d{4}-\d\d-\d\d）\s*$/, '').slice(0, 160),
    situation: situation.slice(0, 200),
    wrong_output: whyText ? whyText.slice(0, 240) : '(待人工补：feedback 未显式记录错误行为)',
    root_cause: description || name,
    caught_by: caughtBy || 'unknown',
    category: categoryOf(slug),
  }
}

// 已有 golden 的 signature_hash（去重）
const existingSigs = new Set()
if (existsSync(GOLDEN)) {
  for (const line of readFileSync(GOLDEN, 'utf8').trim().split('\n')) {
    try { const o = JSON.parse(line); if (o.signature_hash) existingSigs.add(o.signature_hash) } catch {}
  }
}

const files = readdirSync(MEM_DIR).filter(f => /^feedback_.*\.md$/.test(f))
const candidates = []
const seen = new Set()
let skippedDup = 0
for (const f of files) {
  const slug = f.replace(/^feedback_/, '').replace(/\.md$/, '')
  let parsed
  try { parsed = parseFeedback(readFileSync(join(MEM_DIR, f), 'utf8'), slug) } catch { continue }
  const sig = sigHash(parsed.root_cause, parsed.category)
  if (existingSigs.has(sig) || seen.has(sig)) { skippedDup++; continue }
  seen.add(sig)
  candidates.push({
    id: 'gold-bf-' + slug.slice(0, 40),
    situation: parsed.situation,
    wrong_output: parsed.wrong_output,
    correct_output: parsed.correct_output,
    root_cause: parsed.root_cause,
    category: parsed.category,
    source_type: 'human-correction',
    caught_by: parsed.caught_by,
    status: 'candidate',
    last_verified: null,
    detector_id: 'feedback-backfill',
    occurrences: 1,
    refutations: 0,
    promoted_at: null,
    confidence_tier: 'mid',
    signature_hash: sig,
    needs_review: true,
    source_file: 'memory/' + f,
  })
}

const byCat = {}
for (const c of candidates) byCat[c.category] = (byCat[c.category] || 0) + 1
const unknownCaught = candidates.filter(c => c.caught_by === 'unknown').length

console.log(`feedback files: ${files.length} | candidates: ${candidates.length} | skipped(dup sig): ${skippedDup} | caught_by=unknown: ${unknownCaught}`)
console.log('by category:', JSON.stringify(byCat))
if (DRY) {
  console.log('\n--- 3 样例 ---')
  for (const c of candidates.slice(0, 3)) console.log(JSON.stringify(c, null, 2))
} else {
  writeFileSync(OUT, candidates.map(c => JSON.stringify(c)).join('\n') + '\n')
  console.log('written →', OUT)
}
