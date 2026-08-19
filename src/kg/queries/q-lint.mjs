#!/usr/bin/env node
// q-lint.mjs — 综合 KG lint：stale chains + cold leaves + audience mismatches + missing references
//
// 灵感：Karpathy LLM Wiki "lint operation"（agentmemory）—— weekly cron 输出 health report
// 用法：node scripts/kg/queries/q-lint.mjs [--feishu]
//
// 单次综合所有 query 库 → 给 harness-evolve / weekly cron 一份 1K-token health report
// --feishu: 写到 /tmp/kg-lint-feishu.md 供 cron caller 发飞书

import fs from 'node:fs'
import path from 'node:path'
import { loadRoster } from '../../kos/roster.mjs'
import { loadGraph, indexEdges, indexNodes, ROOT, isIntentionalHistoricalRef } from './_lib.mjs'

const roster = loadRoster()
const args = process.argv.slice(2)
const FEISHU = args.includes('--feishu')
const FEISHU_PATH = '/tmp/kg-lint-feishu.md'

const graph = loadGraph()
const { in: inE, out: outE } = indexEdges(graph)
const byId = indexNodes(graph)

// (1) stale chains
// supersededIds: 只信节点自身 status，不从 superseded_by/supersedes 边推断。
// 实证（2026-05-29 KOS audit）：边推断在当前图 100% 假阳性 —— KG gen 造反向 superseded_by 边
//   (ADR-025 Proposed 活提案 / ADR-007 accepted 被误标退役)，且 `supersedes` 边 from 是取代方(更新)。
//   真退役节点(adr-014/adr-027/ADR-007a/ADR-008)全部已正确设 status，只读 status 零漏检 + 清假阳性。
const supersededIds = new Set()
for (const n of graph.nodes) {
  const s = (n.status || '').toLowerCase()
  if (s.startsWith('superseded') || s.startsWith('deprecated')) supersededIds.add(n.id)
}
// 与 q-stale-chains 对齐：过滤掉「有意的历史 ACK」假阳性（upstream 显式 ACK 自己引用了
//   superseded target，如 ADR-025 body 写明「ADR-008 superseded」）—— 否则 health 分被有意历史引用拖低。
const staleRefs = []
for (const id of supersededIds) {
  const incoming = inE.get(id) || []
  for (const e of incoming) {
    if (e.label !== 'references' && e.label !== 'related') continue
    if (isIntentionalHistoricalRef(e.from, id)) continue
    staleRefs.push({ from: e.from, to: id, label: e.label })
  }
}

// (2) cold leaves (rule + playbook only)
// cold = 没有任何「有意义入边」的 rule/playbook。
// 旧逻辑只数 references 边 → 把 iron-10(552 入边)/iron-11(356) 这类 hub 规则误判为 cold，
//   导致 143 个 cold（占 health issue 83%）几乎全是假阳性。
// 修复：把 governs/implements/enforced_by/related/points-to 一并计入「被依赖」信号
//   （co-located 是目录相邻噪声、superseded_* 是退役标记，故排除）。
const LIVE_INBOUND = new Set(['references', 'related', 'enforced_by', 'governs', 'implements', 'points-to'])
const refCounts = new Map()
for (const e of graph.edges) {
  if (LIVE_INBOUND.has(e.label)) refCounts.set(e.to, (refCounts.get(e.to) || 0) + 1)
}
const cold = graph.nodes.filter(n => {
  if (!['rule', 'playbook'].includes(n.type)) return false
  if ((n.status || '').toLowerCase().startsWith('superseded')) return false
  return (refCounts.get(n.id) || 0) === 0
})

// (3) orphan code-files (no imports edge in or out, rare for src)
const codeFiles = graph.nodes.filter(n => n.type === 'code-file')
const codeWithEdges = new Set()
for (const e of graph.edges) {
  if (e.label === 'imports') {
    codeWithEdges.add(e.from)
    codeWithEdges.add(e.to)
  }
}
const orphanCode = codeFiles.filter(n => !codeWithEdges.has(n.id))

// (4) audience mismatches
const audienceMismatches = graph.edges.filter(e => e.label === 'audience-mismatch')

// (5) maturity unknown (rule/playbook 缺 maturity)
const maturityMissing = graph.nodes.filter(n =>
  ['rule', 'playbook'].includes(n.type) && !n.maturity
)

// (6) channel-routing suspects（per-node cron 写到团队 zone = 私事污染主战场）
// 数据源：type='message-emitter' KG 节点（v1.3 起，由 knowledge-graph-gen.mjs/loadMessageEmitters 抽取）
const ZONE_CONFIG_PATH = path.join(ROOT, '.claude', 'hooks', 'zone-config.json')
const zoneById = loadZoneNameById(ZONE_CONFIG_PATH)
const channelSuspects = []
for (const n of graph.nodes) {
  if (n.type !== 'message-emitter') continue
  const host = (outE.get(n.id) || []).find(e => e.label === 'emits-from')?.to
  const scopes = new Set()
  for (const edge of inE.get(host) || []) {
    if (edge.label !== 'triggers') continue
    const cron = byId.get(edge.from)
    if (cron?.type === 'cron-task') scopes.add(cron.scope || 'N/A')
  }
  const target = n.target_kind === 'zone'
    ? (zoneById.get(n.target_value) || n.target_value || 'unresolved')
    : (n.target_value || 'unresolved')
  if (scopes.has('per-node') && target === 'hq-managers') {
    channelSuspects.push({ id: n.id, target, scope: [...scopes].sort().join(',') })
  }
}

// (7) 图外文件：解析失败 → 根本没有节点 → 不出现在上面任何一项里
//
// 2026-08-18 加。此前 health score / maturity 缺失 / cold 全部只统计**已建进图**的节点，
// 而 frontmatter 缺失或未闭合的 .md 压根不生成节点 —— 于是最坏的那批文件对所有指标不可见。
// 实测：q-lint 报 maturity 缺失 8（算得完全正确），直接扫 frontmatter 边界得 15，
// 差额 7 全是无 frontmatter 文件，抽查 3/3 确认不在 .knowledge-graph.json。
// 判据来源 team-memory/rules/rate-metric-denominator-hides-missed-runs.md：
// 分母由「会排除失败者的机制」决定时，失败得越彻底越不进分母。
//
// 所以这一项**必须绕开 graph，直接扫文件系统** —— 用一个独立于被测系统的口径。
const SCANNED_DIRS = ['rules', 'playbooks']
const unparseable = []
for (const sub of SCANNED_DIRS) {
  const dir = path.join(ROOT, 'team-memory', sub)
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { continue }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue
    const rel = `team-memory/${sub}/${f}`
    let raw
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8') } catch { continue }
    const text = raw.replace(/\r\n/g, '\n')
    if (!text.startsWith('---\n')) { unparseable.push({ path: rel, why: '无 frontmatter' }); continue }
    if (text.slice(4).indexOf('\n---\n') === -1) { unparseable.push({ path: rel, why: 'frontmatter 未闭合' }) }
  }
}

function loadZoneNameById(p) {
  const m = new Map()
  if (!fs.existsSync(p)) return m
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    for (const [name, config] of Object.entries(parsed)) {
      if (config?.id) m.set(config.id, name)
    }
  } catch {}
  return m
}

// 综合报告
const report = []
report.push(`# KG lint · ${new Date().toISOString()}`)
report.push('')
report.push(`Graph: ${graph.nodes.length} nodes / ${graph.edges.length} edges`)
report.push('')
report.push('## Health summary')
report.push('')
report.push(`- 🔁 Stale references (upstream references a superseded node): **${staleRefs.length}**`)
report.push(`- ❄️  Cold rules/playbooks (0 ref): **${cold.length}**`)
report.push(`- 🔗 Orphan code-files (no imports edge): **${orphanCode.length}** / ${codeFiles.length} total`)
report.push(`- ⚠️  Audience mismatches: **${audienceMismatches.length}**`)
report.push(`- ❓ Maturity field missing: **${maturityMissing.length}**`)
report.push(`- 📨 Channel-routing suspects (per-node + hq zone): **${channelSuspects.length}**`)
report.push(`- ⛔ 图外文件（解析失败，不进上面任何一项）: **${unparseable.length}**`)
report.push('')

const totalIssues = staleRefs.length + cold.length + audienceMismatches.length + maturityMissing.length + channelSuspects.length + unparseable.length
// 分类加权 + 每类饱和上限。旧公式 max(0,100-issues*2) 在 50 个 issue 就锁死到 0：
//   任何 50~1000 个 issue 都得 0 分 → 指标退化成「过/不过 50」的二值 flag，无分辨力。
//   而 88 rules+87 playbooks 的库，单 cold/maturity 检测就结构性超 50，分数永久红。
// 新公式：stale ref（活引用指向 superseded 节点）是唯一真正危害 agent 答案的类目，
//   权重最高；cold/maturity 是 hygiene debt，低权重 + 低上限，不让结构性类目把分锁死。
const penalty =
  Math.min(40, staleRefs.length * 4) +
  Math.min(15, audienceMismatches.length * 3) +
  Math.min(15, channelSuspects.length * 3) +
  Math.min(15, cold.length * 1.5) +
  Math.min(10, maturityMissing.length * 0.5) +
  // 图外文件权重高于 maturity 缺失：那只是少个字段，这是整份内容不进图、不参与召回 = 写了没入库。
  // 上限 20（低于 stale 的 40，高于 hygiene 类）——留出分辨力，不让它单独把分数锁死。
  Math.min(20, unparseable.length * 2.5)
const healthScore = Math.max(0, Math.round(100 - penalty))

report.push(`**Health score**: ${healthScore}/100 (${totalIssues} issues · stale=${staleRefs.length} cold=${cold.length} maturity=${maturityMissing.length} audience=${audienceMismatches.length} channel=${channelSuspects.length} offgraph=${unparseable.length})`)
report.push('')

if (unparseable.length > 0) {
  report.push('## ⛔ 图外文件（解析失败 → 无节点 → 上面所有指标都看不见它们）')
  report.push('')
  for (const u of unparseable) report.push(`- \`${u.path}\` — ${u.why}`)
  report.push('')
  report.push('> 代价不止统计不好看：无节点 = 不参与 lint/cold/stale 检测，且 `kos-recall` 的 description/name/tags 三路打分全空，只剩 body ×2，排名结构性偏低——**等于写了没入库**。')
  report.push('> 修法：补 frontmatter（至少 name/type/maturity）。防复发的写入闸见 `.claude/hooks/check-maturity-frontmatter.js` 守则 3。')
  report.push('')
}

if (staleRefs.length > 0) {
  report.push('## 🔁 Stale references (top 10)')
  report.push('')
  for (const s of staleRefs.slice(0, 10)) {
    report.push(`- \`${s.from}\` --${s.label}--> \`${s.to}\` (superseded)`)
  }
  report.push('')
}

if (cold.length > 0) {
  report.push('## ❄️ Cold rules / playbooks')
  report.push('')
  const proven = cold.filter(n => n.maturity === 'proven')
  if (proven.length > 0) {
    report.push(`**proven cold (high priority to surface)**: ${proven.length}`)
    for (const n of proven) report.push(`  - \`${n.id}\` (last_verified=${n.last_verified || '?'})`)
  }
  const verified = cold.filter(n => n.maturity === 'verified')
  if (verified.length > 0) {
    report.push(`**verified cold**: ${verified.length}`)
    for (const n of verified.slice(0, 5)) report.push(`  - \`${n.id}\``)
  }
  report.push('')
}

if (audienceMismatches.length > 0) {
  report.push('## ⚠️ Audience mismatches')
  report.push('')
  for (const m of audienceMismatches) report.push(`- \`${m.from}\``)
  report.push('')
}

if (channelSuspects.length > 0) {
  report.push('## 📨 Channel-routing suspects')
  report.push('')
  report.push('A per-node cron posting to hq-managers = private coordination polluting the team main channel')
  report.push('')
  for (const s of channelSuspects) {
    report.push(`- \`${s.id}\` → ${s.target} (scope=${s.scope})`)
  }
  report.push('')
  report.push('Action: switch to_zone_id to to_agent_id (DM the individual), or change the cron scope to singleton. See q-channel-routing-audit for details.')
  report.push('')
}

if (maturityMissing.length > 0) {
  report.push('## ❓ Maturity missing')
  report.push('')
  for (const n of maturityMissing.slice(0, 10)) report.push(`- \`${n.id}\``)
  report.push('')
}

report.push('---')
report.push('')
report.push(`> Suggested actions: staleRefs / audienceMismatches / channelSuspects → fix now; cold proven → ${roster.roles.approver} decides; cold verified → auto-downgraded to draft after 6mo; missing maturity → backfill.`)

console.log(report.join('\n'))

if (FEISHU && totalIssues > 0) {
  const summary = [
    `**🕸 KG lint · health ${healthScore}/100**`,
    '',
    `- Stale refs: ${staleRefs.length}`,
    `- Cold rules: ${cold.length}（${cold.filter(n => n.maturity === 'proven').length} proven，要 surface）`,
    `- Audience mismatch: ${audienceMismatches.length}`,
    `- Maturity 缺失: ${maturityMissing.length}`,
    `- Channel-routing suspects: ${channelSuspects.length}`,
    '',
    `详见 \`scripts/kg/queries/q-lint.mjs\` 输出。`,
  ].join('\n')
  fs.mkdirSync(path.dirname(FEISHU_PATH), { recursive: true })
  fs.writeFileSync(FEISHU_PATH, summary, 'utf8')
  console.log(`\nFEISHU_LINT_PATH=${FEISHU_PATH}`)
}
