#!/usr/bin/env node
// golden-eval-runner.mjs v1 — 用 golden 集量 KOS 召回，并把「召不回」与「没沉淀」分开
//
// 起源：agent 自我进化 synthesis（docs/research/agent-self-improvement-synthesis-2026-06-06.md）+
//   golden 标准（team-memory/rules/golden-eval-standard.md）。
//
// ⚠️ v0 是坏的，读数全程在骗人（2026-08-18 查清，commit a0be87a09）：
//   1. hit 判据用 /[一-龥]{2,6}/ 从标准答案贪婪切词，切出「点名个人的具」「体操作走」这种
//      跨词硬切串，永远匹配不到任何文档 → coverage 天然趋零 → hit 恒假。
//      它常年报 recall 9% 的假低分，差点导致一次没必要的召回算法重构——
//      **优化假指标会把好的东西改坏，比不优化危险**。真值以 data/kos-eval/runs/ 落盘记录为准，
//      口头/注释里的数字一律不算数（2026-08-19 曾有「真值 71%」的声明因无 artifact 复现被删）。
//   2. v0 的 hypothesis（「miss 高 = 答案在语料却召不回」）从没被验证。抽查 4 条 miss，
//      3 条的答案根本不在库里。「召不回」要改算法，「没沉淀」要补卡，指向相反的行动，
//      合并成一个数必然把人带向错的那一侧。
//
// v1 判据（三态，不再用词覆盖率判 hit——词覆盖降级为参考列）：
//   expected_source: <path> → 知识在库，判 recall@K 的 top-K 里有没有那张卡
//   knowledge_gap: true     → 知识不在库，单独计数，不进 recall 分母
//   两者都无                → pending，未人工核实，不进任何分母（留白优于瞎标）
//
// 用法：node scripts/kos/golden-eval-runner.mjs [--limit 8] [--json] [--lint]
//   --lint: 有 pending 就 exit 1，可挂 cron/CI，让「新 golden 忘了标注」变成会响的信号
//   每次运行自动落盘 data/kos-eval/runs/<date>-<n>.md（--no-persist 关闭）——
//   没有落盘记录的分数不存在，防止「记忆里的读数」再变成下一个 71%。

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..', '..')
const GOLDEN = join(REPO, 'data', 'kos-eval', 'golden.jsonl')  // v3: 指向统一 golden(原指旧 15 条 split 文件,已废)
const args = process.argv.slice(2)
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? Number(args[i + 1]) : 5 })()
const AS_JSON = args.includes('--json')
const LINT = args.includes('--lint')
const PERSIST = !args.includes('--no-persist')

// 每次运行落盘 runs/<date>-<n>.md——分数只认落盘 artifact，不认记忆/注释里的数
function persistRun(reportText) {
  const dir = join(REPO, 'data', 'kos-eval', 'runs')
  mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const n = readdirSync(dir).filter((f) => f.startsWith(date) && f.endsWith('.md')).length + 1
  const file = join(dir, `${date}-${n}.md`)
  writeFileSync(file, reportText, 'utf8')
  return file
}

// 从文本抽中文/英文关键词（≥2 字中文片段 / ≥3 字母英文词），去停用词
const STOP = new Set(['的', '了', '是', '在', '不', '和', '与', 'the', 'and', 'for', 'not', 'should'])
function keyTerms(s) {
  const terms = new Set()
  for (const m of (s || '').match(/[一-龥]{2,6}/g) || []) if (!STOP.has(m)) terms.add(m)
  for (const m of (s || '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []) if (!STOP.has(m)) terms.add(m)
  return [...terms]
}

function recall(query) {
  try {
    const out = execFileSync(process.execPath,
      [fileURLToPath(new URL('./kos-recall.mjs', import.meta.url)), '--query', query, '--limit', String(LIMIT), '--scope', 'all', '--format', 'json'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true, cwd: REPO })
    return JSON.parse(out)
  } catch { return null }
}

function loadGolden() {
  return readFileSync(GOLDEN, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function main() {
  const golden = loadGolden()
  const results = []
  for (const g of golden) {
    const rec = recall(g.situation || g.question)
    const recalledText = JSON.stringify(rec || {}).toLowerCase()
    // 词覆盖率降级为**参考信息**，不再当 hit 判据（见文件头 v1 说明）
    const expectTerms = keyTerms(`${g.correct_output || g.correct_answer} ${g.root_cause}`)
    const hitTerms = expectTerms.filter((t) => recalledText.includes(t.toLowerCase()))
    const coverage = expectTerms.length ? hitTerms.length / expectTerms.length : 0

    const question = (g.situation || g.question || '').slice(0, 40)
    if (g.knowledge_gap) {
      results.push({ id: g.id, verdict: 'gap', coverage: Number(coverage.toFixed(2)), question })
      continue
    }
    if (!g.expected_source) {
      results.push({ id: g.id, verdict: 'pending', coverage: Number(coverage.toFixed(2)), question })
      continue
    }
    // 真 recall@K：召回结果的 path 里有没有那张承载答案的卡
    const want = String(g.expected_source).replace(/\\/g, '/').toLowerCase()
    // kos-recall --format json 顶层就是数组。曾误写成 rec.results / rec.hits，
    // 结果 paths 恒空、全判 miss，读出 0/7 的假数——靠「gold-004 人工确认应命中」这个
    // 正控才发现。任何新判据上线前必须有一条已知应该通过的用例，否则量具坏了看不出来。
    const rows = Array.isArray(rec) ? rec : ((rec && (rec.results || rec.hits)) || [])
    const paths = rows.map((x) => String(x.path || x.file || '').replace(/\\/g, '/').toLowerCase())
    const rank = paths.findIndex((p) => p === want || p.endsWith(want) || want.endsWith(p))
    results.push({
      id: g.id,
      verdict: rank >= 0 ? 'hit' : 'miss',
      rank: rank >= 0 ? rank + 1 : null,
      expected_source: g.expected_source,
      coverage: Number(coverage.toFixed(2)),
      question,
    })
  }

  const scored = results.filter((r) => r.verdict === 'hit' || r.verdict === 'miss')
  const hits = results.filter((r) => r.verdict === 'hit').length
  const gaps = results.filter((r) => r.verdict === 'gap').length
  const pending = results.filter((r) => r.verdict === 'pending').length
  const recallRate = scored.length ? hits / scored.length : 0
  const summary = {
    generated: 'golden-eval-runner v1',
    total: golden.length,
    scored: scored.length,
    recall_hits: hits,
    recall_rate: Number(recallRate.toFixed(2)),
    miss_rate: Number((1 - recallRate).toFixed(2)),
    knowledge_gaps: gaps,
    pending_annotation: pending,
    hypothesis: 'recall_rate 低 → 改召回；knowledge_gaps 高 → 补卡。两者指向相反的行动，不可合并成一个数',
  }
  // 报告正文统一先攒进 lines（--json 模式 stdout 走 JSON，但 md 报告照样落盘）
  const ICON = { hit: '✅', miss: '❌', gap: '📭', pending: '⬜' }
  const lines = []
  lines.push(`# Golden Eval Run — ${new Date().toISOString()}\n`)
  lines.push(`> golden-eval-runner v1 · recall@${LIMIT} · golden.jsonl ${golden.length} 条\n`)
  lines.push(`**recall_rate: ${(recallRate * 100).toFixed(0)}%**（${summary.recall_hits}/${summary.scored} 条已标注且知识在库的）`)
  lines.push(`📭 沉淀缺口 ${gaps} 条（知识根本不在库，改召回也召不出来）· ⬜ 待标注 ${pending} 条（不计入任何分母）\n`)
  lines.push('| golden | 判定 | rank | 词覆盖(参考) | question |')
  lines.push('|---|---|---|---|---|')
  for (const r of results) {
    lines.push(`| ${r.id} | ${ICON[r.verdict]} ${r.verdict} | ${r.rank ?? '—'} | ${(r.coverage * 100).toFixed(0)}% | ${r.question} |`)
  }
  lines.push(`\n**两个数指向相反的行动**：recall_rate 低 → 改召回算法；沉淀缺口多 → 补卡。`)
  lines.push(`合成一个数就会像 v0 那样，让人看着 9% 去改召回——而抽查发现多数 miss 的答案压根不在库里。`)
  if (pending > 0) lines.push(`\n⚠️ ${pending} 条尚未标注 expected_source，当前 recall_rate 只覆盖 ${summary.scored}/${summary.total}。标注前别把这个数当全局结论。`)

  const report = lines.join('\n') + '\n'
  let runFile = null
  if (PERSIST) runFile = persistRun(report)

  if (AS_JSON) { console.log(JSON.stringify({ summary, run_file: runFile, results }, null, 2)); return }
  process.stdout.write(report)
  if (runFile) console.log(`\n📝 本次结果已落盘：${runFile}`)

  // --lint：把「新 golden 忘了标注」变成会响的信号。
  // golden 入集是 candidate → 人工复核 → golden.jsonl，强制点落在人工那一步，靠不住；
  // 而漏标的代价是 recall_rate 静默缩水覆盖面（分母只算已标注的，看不出少了谁）。
  // 挂进 cron/CI 用非零退出码兜底，不靠谁记得。
  if (LINT) {
    if (pending > 0) {
      console.error(`\n[lint] ✗ ${pending} 条 golden 缺 expected_source / knowledge_gap 标注：`)
      for (const r of results.filter((x) => x.verdict === 'pending')) console.error(`  - ${r.id}  ${r.question}`)
      console.error(`  标注方式：答案在库 → 填 expected_source: <卡路径>；知识不在库 → 填 knowledge_gap: true`)
      console.error(`  拿不准就留着别瞎标——标错会让这个量具重新变成骗人的，而且带「已核实」的假权威。`)
      process.exitCode = 1
      return
    }
    console.log(`\n[lint] ✓ ${golden.length} 条 golden 标注齐全`)
  }
}

main()
