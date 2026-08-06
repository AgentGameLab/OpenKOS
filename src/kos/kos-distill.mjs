#!/usr/bin/env node
// kos-distill.mjs — KOS 蒸馏层 v1（Trace2Skill 频率加权合并 落地）
// 把 team-memory/decisions(+incidents) 这批现成"轨迹语料"离线聚类，
// 找出【跨 ≥N 条独立 decision 复现】的主题 = 升格候选（candidate-worthy），
// singleton 不丢、降级 situational（对齐 Trace2Skill §4.4 低支持度→reference）。
//
// 借点：Trace2Skill ② 频率加权合并（≥2 独立轨迹才升格，1 次=特例降级）。
// 设计铁律：① 只 report / 只写 _candidates/，永不写 rules/ 正区（ADR-043）
//          ② v1 zero-LLM 纯启发式（验语料信号，够了再 Phase B 接 LLM）
//          ③ 升格永远止步 candidate，需人判闸门才进 rules/
//
// 用法: node scripts/kos/kos-distill.mjs [--since 14d] [--min 2] [--write]
//   默认 report-only（不写文件）；--write 写一份 digest 到 _candidates/，仍需人 ack 升格。
import { appendFileSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.KOS_DATA_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const WRITE = argv.includes('--write')
const MIN = parseInt(getArg('--min', '2'), 10)        // ≥N 独立 decision 才升 candidate
const MIN_AUTHORS = parseInt(getArg('--min-authors', '2'), 10) // 至少 N 位独立作者交叉印证
const SINCE = getArg('--since', null)                  // 例 14d / 30d；空=全量
const DEC_DIR = join(ROOT, 'team-memory/decisions')
const INC_DIR = join(ROOT, 'team-memory/incidents')
const CAND_DIR = join(ROOT, 'team-memory/rules/_candidates')
const REJECTION_PATH = join(CAND_DIR, '.rejections.jsonl')
const REJECT_DAYS = parseInt(getArg('--reject-days', '30'), 10)
const rejectIndex = argv.indexOf('--reject')
const REJECT_THEME = rejectIndex >= 0 ? argv[rejectIndex + 1] : null

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

// since 窗口 → 最早允许日期（按 created/date frontmatter）
let sinceDate = null
if (SINCE) {
  const m = SINCE.match(/^(\d+)d$/)
  if (m) { const d = new Date(); d.setUTCDate(d.getUTCDate() - parseInt(m[1], 10)); sinceDate = d.toISOString().slice(0, 10) }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) sinceDate = SINCE
}

// 关键词 category 兜底（tags/topic 缺失时从 name+description 推）—— 受控小集合
function categoryOf(text) {
  const s = norm(text)
  if (/(kos|knowledge|记忆|recall|mneme|dedup|embedding|蒸馏)/.test(s)) return 'knowledge-system'
  if (/(contribution|贡献|画像|股权|分配|eval|评估)/.test(s)) return 'contribution-eval'
  if (/(daemon|harness|evolve|hook|心跳|supervisor|进化)/.test(s)) return 'daemon-infra'
  if (/(render|渲染|godot|ssim|光照|spine|美术|生图)/.test(s)) return 'rendering-art'
  if (/(火种|fire-seed|imprint|地虾城|gclaw|游戏|玩法|配方|gai)/.test(s)) return 'game-product'
  if (/(security|安全|injection|ssrf|防护|权限|a2a)/.test(s)) return 'security'
  if (/(brand|品牌|叙事|营销|发行|推广|商业化|变现)/.test(s)) return 'gtm-narrative'
  if (/(migration|迁移|rds|db|部署|deploy|ecs|repo|split)/.test(s)) return 'infra-migration'
  if (/(review|pr|merge|codeowner|ci|管线|治理)/.test(s)) return 'review-governance'
  return 'general'
}

function parseFm(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)
  const out = { name: '', description: '', topic: '', type: '', date: '', owner: 'unknown', tags: [] }
  if (!fm) return out
  const b = fm[1]
  const get = (k) => { const m = b.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')); return m ? m[1].trim() : '' }
  out.name = get('name') || get('title')
  out.description = get('description')
  out.topic = get('topic')
  out.type = get('type')
  out.date = get('created') || get('date')
  out.owner = get('owner') || get('author') || 'unknown'
  // tags: 支持 [a, b] 行内 或 - 列表
  const inline = b.match(/^tags:\s*\[(.+)\]/m)
  if (inline) out.tags = inline[1].split(',').map(t => norm(t.replace(/['"]/g, ''))).filter(Boolean)
  else {
    const blk = b.match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m)
    if (blk) out.tags = blk[1].split('\n').map(l => norm(l.replace(/^\s*-\s*/, '').replace(/['"]/g, ''))).filter(Boolean)
  }
  return out
}

function collect(dir, kind) {
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
    let fm
    try { fm = parseFm(readFileSync(join(dir, f), 'utf8')) } catch { continue }
    if (sinceDate && fm.date && fm.date < sinceDate) continue
    // 每条 decision 的主题信号集 = tags ∪ topic ∪ 关键词category
    const cat = categoryOf(fm.name + ' ' + fm.description + ' ' + f)
    const signals = new Set([...fm.tags, fm.topic, cat].map(norm).filter(s => s && s.length > 1))
    out.push({ file: kind + '/' + f, name: fm.name || f, date: fm.date, author: norm(fm.owner) || 'unknown', signals: [...signals], cat })
  }
  return out
}

// 人工否决是追加式审计记录：永不删历史，只按冷却窗口忽略过期记录。
if (rejectIndex >= 0) {
  if (!REJECT_THEME || REJECT_THEME.startsWith('--') || !norm(REJECT_THEME)) {
    console.error('[kos-distill] --reject 需要一个非空主题名')
    process.exit(1)
  }
  if (!existsSync(CAND_DIR)) mkdirSync(CAND_DIR, { recursive: true })
  const rejection = { theme: norm(REJECT_THEME), rejected_at: new Date().toISOString() }
  appendFileSync(REJECTION_PATH, JSON.stringify(rejection) + '\n', 'utf8')
  console.log('[kos-distill] 已记录候选否决 →', REJECTION_PATH, `(${rejection.theme})`)
  process.exit(0)
}

function liveRejections() {
  if (!existsSync(REJECTION_PATH) || !Number.isFinite(REJECT_DAYS) || REJECT_DAYS <= 0) return new Map()
  const now = Date.now()
  const windowMs = REJECT_DAYS * 24 * 60 * 60 * 1000
  const live = new Map()
  for (const line of readFileSync(REJECTION_PATH, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      const rejectedAt = new Date(record.rejected_at).getTime()
      const theme = norm(record.theme)
      if (!theme || !Number.isFinite(rejectedAt)) continue
      const remainingMs = rejectedAt + windowMs - now
      if (remainingMs > 0) {
        const daysRemaining = Math.ceil(remainingMs / (24 * 60 * 60 * 1000))
        const current = live.get(theme)
        if (!current || daysRemaining > current.daysRemaining) live.set(theme, { daysRemaining })
      }
    } catch {
      // 追加式日志允许保留历史坏行；扫描时跳过即可。
    }
  }
  return live
}

const corpus = [...collect(DEC_DIR, 'decisions'), ...collect(INC_DIR, 'incidents')]

// 频率合并：每个 signal → 哪些独立 decision 含它
const bySignal = new Map()
for (const d of corpus) for (const sig of d.signals) {
  if (!bySignal.has(sig)) bySignal.set(sig, [])
  bySignal.get(sig).push({ file: d.file, author: d.author })
}

const candidates = [], situational = [], rejected = [], singleAuthor = []
const rejectedThemes = liveRejections()
for (const [sig, occurrences] of bySignal) {
  if (sig === 'general') continue          // 兜底噪声桶，不当候选
  const distinct = new Map()
  for (const occurrence of occurrences) if (!distinct.has(occurrence.file)) distinct.set(occurrence.file, occurrence.author)
  const decisions = [...distinct.keys()]
  const authors = [...new Set(distinct.values())]
  const entry = { theme: sig, occurrences: decisions.length, decisions, authors }
  if (decisions.length < MIN) situational.push(entry)
  else if (rejectedThemes.has(sig)) rejected.push({ ...entry, ...rejectedThemes.get(sig) })
  else if (authors.length < MIN_AUTHORS) singleAuthor.push(entry)
  else candidates.push(entry)
}
candidates.sort((a, b) => b.occurrences - a.occurrences)
rejected.sort((a, b) => b.occurrences - a.occurrences)
singleAuthor.sort((a, b) => b.occurrences - a.occurrences)

// 噪声过滤：太泛的 general 单独标，便于人忽略
console.log(`\n[kos-distill v1] 语料: ${corpus.length} 条 (decisions+incidents)${SINCE ? ' · since ' + SINCE : ' · 全量'} · 升格门槛 ≥${MIN}`)
console.log(`候选主题(≥${MIN} 条独立 decision 复现、≥${MIN_AUTHORS} 位作者): ${candidates.length} · singleton(降级 situational): ${situational.length}\n`)
console.log('--- 升格候选(按复现频率) ---')
for (const c of candidates.slice(0, 25)) {
  console.log(`  [${c.occurrences}x] ${c.theme}`)
}
if (singleAuthor.length) {
  console.log('\n--- single-author (needs second voice) ---')
  for (const c of singleAuthor.slice(0, 25)) console.log(`  [${c.occurrences}x · ${c.authors.length} author] ${c.theme}`)
}
if (rejected.length) {
  console.log('\n--- rejected (cooloff) ---')
  for (const c of rejected.slice(0, 25)) console.log(`  [${c.occurrences}x · ${c.daysRemaining} days remaining] ${c.theme}`)
}

if (WRITE) {
  if (!existsSync(CAND_DIR)) mkdirSync(CAND_DIR, { recursive: true })
  const today = new Date().toISOString().slice(0, 10)
  const lines = [
    '---', 'type: rule', 'slug: distilled-digest-' + today, 'name: KOS 蒸馏候选 digest (' + today + ')',
    'maturity: candidate', 'status: needs_review', 'falsifiable_contract: PENDING_DOGFOOD',
    'distill_method: kos-distill.mjs v1 (Trace2Skill 频率合并, zero-LLM)', 'created: ' + today, '---', '',
    '> 自动蒸馏的**升格候选**，非权威 rule。每个主题由 ≥' + MIN + ' 条独立 decision、≥' + MIN_AUTHORS + ' 位作者交叉印证。',
    '> 人判闸门：owner 审 → 真值得成 rule 的，手写进 rules/ 并 kos-remember --maturity verified。30 天未升格 → 归档。', '',
    '## 升格候选主题（' + candidates.length + ' 个）', '',
  ]
  for (const c of candidates) {
    lines.push(`### [${c.occurrences}×] ${c.theme}`)
    for (const f of c.decisions) lines.push(`- ${f}`)
    lines.push('')
  }
  if (singleAuthor.length) {
    lines.push('## single-author (needs second voice)', '')
    for (const c of singleAuthor) lines.push(`- [${c.occurrences}× · ${c.authors.length} author] ${c.theme}`)
    lines.push('')
  }
  if (rejected.length) {
    lines.push('## rejected (cooloff)', '')
    for (const c of rejected) lines.push(`- [${c.occurrences}× · ${c.daysRemaining} days remaining] ${c.theme}`)
    lines.push('')
  }
  const out = join(CAND_DIR, 'distilled-digest-' + today + '.md')
  writeFileSync(out, lines.join('\n'), 'utf8')
  console.log('\n写入候选 digest →', out, '(maturity:candidate, 永不进 rules/ 正区, 需人 ack 升格)')
} else {
  console.log('\n(report-only · 加 --write 写 digest 到 _candidates/ 供人判闸门)')
}
