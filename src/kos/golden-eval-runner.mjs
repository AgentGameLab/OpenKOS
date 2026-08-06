#!/usr/bin/env node
// golden-eval-runner.mjs — 用 golden 集测「错题答案在语料却不召回」假设（验证层首跑 v0）
//
// 起源：agent 自我进化 synthesis（docs/research/agent-self-improvement-synthesis-2026-06-06.md）+
//   golden 标准 v0.1（team-memory/playbooks/golden-eval-set-standard.md）。
//   假设（Anthropic 自助分析篇）：~80% 错题的正确答案其实在语料里，但 recall 没召回 → 复犯。
//   本 runner 对每条 golden question 跑 kos-recall，检查是否召回到该 golden 的「正确知识」，
//   产出 recall@K + miss 清单。这是验证层从「有标准」→「有反馈」的第一个真信号。
//
// 注意（v0 局限，待 refine）：
//   - hit 判据是启发式（recall 结果的 matched terms ∩ golden 关键词 非空），非语义精确
//   - kos-recall 是关键词召回（localRecall），本就是被测对象——低召回率正是要暴露的 gap
//
// 用法：node scripts/kos/golden-eval-runner.mjs [--limit 5] [--json]

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..', '..')
const GOLDEN = join(REPO, 'data', 'kos-eval', 'golden.jsonl')  // v3: 指向统一 golden(原指旧 15 条 split 文件,已废)
const args = process.argv.slice(2)
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? Number(args[i + 1]) : 5 })()
const AS_JSON = args.includes('--json')

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
    // recall 结果序列化成一坨文本，看 golden 的「正确知识」关键词覆盖度
    const recalledText = JSON.stringify(rec || {}).toLowerCase()
    const expectTerms = keyTerms(`${g.correct_output || g.correct_answer} ${g.root_cause}`)
    const hitTerms = expectTerms.filter((t) => recalledText.includes(t.toLowerCase()))
    const coverage = expectTerms.length ? hitTerms.length / expectTerms.length : 0
    // hit 判据：关键词覆盖 ≥ 40%（v0 启发式阈值）
    const hit = coverage >= 0.4
    results.push({ id: g.id, hit, coverage: Number(coverage.toFixed(2)), question: (g.situation || g.question || '').slice(0, 40), hit_terms: hitTerms.length, expect_terms: expectTerms.length })
  }
  const hits = results.filter((r) => r.hit).length
  const recallRate = golden.length ? hits / golden.length : 0
  const summary = {
    generated: 'golden-eval-runner v0',
    total: golden.length,
    recall_hits: hits,
    recall_rate: Number(recallRate.toFixed(2)),
    miss_rate: Number((1 - recallRate).toFixed(2)),
    hypothesis: '若 miss_rate 高 → 「答案在语料却不召回」假设在 CG 成立 → recall 是验证层真缺口',
  }
  if (AS_JSON) { console.log(JSON.stringify({ summary, results }, null, 2)); return }
  console.log(`# Golden Eval Runner v0 — recall@${LIMIT}\n`)
  console.log(`总 golden: ${summary.total} · 召回命中: ${summary.recall_hits} · **recall_rate: ${(recallRate * 100).toFixed(0)}%** · miss: ${(summary.miss_rate * 100).toFixed(0)}%\n`)
  console.log('| golden | hit | coverage | question |')
  console.log('|---|---|---|---|')
  for (const r of results) console.log(`| ${r.id} | ${r.hit ? '✅' : '❌'} | ${(r.coverage * 100).toFixed(0)}% | ${r.question} |`)
  console.log(`\n假设检验：miss_rate=${(summary.miss_rate * 100).toFixed(0)}% — ${summary.miss_rate >= 0.5 ? '⚠️ 高 miss，「答案在语料却不召回」假设 CG 成立，recall 是真缺口' : '低 miss，召回基本够用'}`)
}

main()
