#!/usr/bin/env node
// skill-score-prune.mjs — UCE 评分 + prune sweep（P2 scaffold，dry-run 优先）
//
// 设计依据: docs/architecture/proposal-2026-06-04-failure-driven-skill-self-evolution.md (C1+C2)
//   论文 UCE (2606.02304) 的「经验单元评分 + 失效淘汰」本地化。
//   关键：cite 不可 hook 观测（check-kos-query-reflex 2 周 0 trigger 实证），
//   所以评分**从已有信号被动派生**——不埋点、不靠 hook。
//
// 数据源（全部已存在）：
//   - team-memory/.knowledge-graph.json （ADR-022，1655 节点/5803 边）→ 图入度
//   - git log --grep 命中规则文件名 → 实战 cite 频次
//   - frontmatter last_verified → 新鲜度衰减
//
// 复合评分 v0（论文未披露评分函数，等 6/9 code release tune）：
//   score = w1·norm(入度) + w2·norm(git_cite) + w3·freshness
//   低分（长期 0 引用 + 高龄未 verify）→ archive 候选（**dry-run 输出报告，不真动**；
//   --apply 才移动到 _archive/，且方案要求 owner ack）。
//
// 用法：
//   node scripts/kos/skill-score-prune.mjs            # dry-run，输出评分 + archive 候选
//   node scripts/kos/skill-score-prune.mjs --json     # 机读
//   node scripts/kos/skill-score-prune.mjs --apply    # 真移动到 _archive/（需谨慎，建议 owner ack 后）

import { readFileSync, existsSync, readdirSync, mkdirSync, renameSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = process.env.KOS_DATA_ROOT || path.resolve(__dirname, '..', '..')
const GRAPH = path.join(REPO, 'team-memory', '.knowledge-graph.json')
const RULES_DIR = path.join(REPO, 'team-memory', 'rules')
const PLAYBOOKS_DIR = path.join(REPO, 'team-memory', 'playbooks')
const ARCHIVE_DIR = path.join(REPO, 'team-memory', '_archive')

// 评分权重 v0（直觉值，等论文 code tune）
const W = { indeg: 0.45, cite: 0.35, fresh: 0.20 }
// archive 阈值：综合分 < 0.15 且 90 天无 cite/verify
const ARCHIVE_SCORE = 0.15
const STALE_DAYS = 90

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const apply = args.includes('--apply')

function loadGraph() {
  if (!existsSync(GRAPH)) return { nodes: [], edges: [] }
  try { return JSON.parse(readFileSync(GRAPH, 'utf8')) } catch { return { nodes: [], edges: [] } }
}

// 图入度：指向该节点的边数（被依赖/被引用/被 enforce）
function buildInDegree(graph) {
  const indeg = new Map()
  const edges = graph.edges || []
  for (const e of edges) {
    if (!e || !e.to) continue
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1)
  }
  return indeg
}

// git cite 频次：commit message 命中文件 basename（近 180 天）
// Windows 安全：不用 wc/-/dev/null（cmd.exe 无），git log 输出在 JS 数行；stderr 走 stdio ignore
const _citeCache = new Map()
function gitCiteCount(basename) {
  if (_citeCache.has(basename)) return _citeCache.get(basename)
  let n = 0
  try {
    const safe = basename.replace(/[^a-zA-Z0-9_.-]/g, '')
    if (safe) {
      const out = execSync(
        `git -C "${REPO}" log --since="180 days ago" --oneline --grep="${safe}"`,
        { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      n = out.trim() ? out.trim().split('\n').length : 0
    }
  } catch (e) {
    // 归 0 会让「被引用最多的规则」反而更容易进 prune 候选（反向指标）——失败必须可见，
    // 且不写缓存，避免一次超时把整轮打分钉死在 0。
    process.stderr.write(`[skill-score-prune] cite 统计失败(${e.code || e.message}) basename=${basename} → 本条 cite 记 0，勿据此 prune\n`)
    return 0
  }
  _citeCache.set(basename, n)
  return n
}

function lastVerifiedDays(content) {
  const m = content.match(/^(?:last_verified|promoted|created|date):\s*(\d{4}-\d{2}-\d{2})/m)
  if (!m) return null
  const days = (Date.now() - Date.parse(m[1])) / 86400000
  return Number.isFinite(days) ? days : null
}

function norm(v, max) { return max > 0 ? Math.min(1, v / max) : 0 }

// P1-B: path-scoped 注入镜像类（iron-NN-* / daemon-* / 路径含 iron）永不入 archive 候选——
// 它们被引用走 .claude/rules/ mirror 注入路径，不走 KG indeg / commit msg，分数必然被低估。
function isProtectedType(relFile) {
  const base = relFile.split('/').pop() || ''
  return /^iron-\d+-/.test(base) || /^daemon-/.test(base) || /iron/i.test(relFile)
}

function scoreDir(dir, kind, indeg, maxes) {
  if (!existsSync(dir)) return []
  const rows = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue
    const file = path.join(dir, f)
    const rel = path.relative(REPO, file).replace(/\\/g, '/')
    let content = ''
    try { content = readFileSync(file, 'utf8') } catch { continue }
    const indegV = indeg.get(rel) || indeg.get(f) || 0
    const citeV = gitCiteCount(f.replace('.md', ''))
    const ageDays = lastVerifiedDays(content)
    const fresh = ageDays === null ? 0.3 : Math.max(0, 1 - ageDays / 365) // 1 年线性衰减
    const score = W.indeg * norm(indegV, maxes.indeg) + W.cite * norm(citeV, maxes.cite) + W.fresh * fresh
    rows.push({ file: rel, kind, indeg: indegV, cite: citeV, ageDays: ageDays === null ? null : Math.round(ageDays), score: Number(score.toFixed(3)) })
  }
  return rows
}

function main() {
  const graph = loadGraph()
  const indeg = buildInDegree(graph)
  // 先扫一遍算 max 用于归一化
  const pre = []
  for (const [dir, kind] of [[RULES_DIR, 'rule'], [PLAYBOOKS_DIR, 'playbook']]) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md') || f.startsWith('_')) continue
      const rel = path.relative(REPO, path.join(dir, f)).replace(/\\/g, '/')
      pre.push({ indeg: indeg.get(rel) || indeg.get(f) || 0, cite: gitCiteCount(f.replace('.md', '')) })
    }
  }
  const maxes = {
    indeg: Math.max(1, ...pre.map((p) => p.indeg)),
    cite: Math.max(1, ...pre.map((p) => p.cite)),
  }

  let rows = [
    ...scoreDir(RULES_DIR, 'rule', indeg, maxes),
    ...scoreDir(PLAYBOOKS_DIR, 'playbook', indeg, maxes),
  ].sort((a, b) => a.score - b.score)

  // P0-A（review catch）：null-age 不再当「stale 放行」——无 last_verified 字段的规则默认不动，
  //   否则 archive gate 自身失效（13 候选全 null-age 含 stable 规则）。等 freshness 字段对齐再扫。
  // P1-B（review catch）：path-scoped 注入镜像类（iron-* / daemon-*）的 indeg/git-cite 抓不到
  //   （走 mirror path 不走 commit msg），靠类型门豁免，不靠分数。
  const candidates = rows.filter((r) =>
    r.score < ARCHIVE_SCORE
    && r.cite === 0
    && r.ageDays !== null && r.ageDays > STALE_DAYS   // ← null-age 默认保护
    && !isProtectedType(r.file),                       // ← 类型门豁免 iron-*/daemon-*
  )

  if (asJson) {
    console.log(JSON.stringify({ generated: 'skill-score-prune v0', total: rows.length, maxes, archive_candidates: candidates, all: rows }, null, 2))
    return
  }

  console.log(`# Skill Score + Prune (UCE v0) — ${rows.length} 单元\n`)
  console.log(`权重 indeg=${W.indeg} cite=${W.cite} fresh=${W.fresh} | 归一化 max: indeg=${maxes.indeg} cite=${maxes.cite}`)
  console.log(`archive 阈值: score<${ARCHIVE_SCORE} + 0 git-cite + >${STALE_DAYS}d 未 verify\n`)
  console.log(`## 最低分 15 条（archive 候选用 ▼ 标）`)
  for (const r of rows.slice(0, 15)) {
    const mark = candidates.includes(r) ? '▼' : ' '
    console.log(`${mark} ${r.score.toFixed(3)}  ${r.kind.padEnd(8)} indeg=${String(r.indeg).padStart(3)} cite=${String(r.cite).padStart(2)} age=${r.ageDays ?? '?'}d  ${r.file}`)
  }
  console.log(`\n## archive 候选: ${candidates.length} 条（dry-run，未移动）`)
  for (const c of candidates) console.log(`  - ${c.file}（score=${c.score}）`)
  console.log(`\n⚠️ 方案要求 archive 不删 + owner ack 后才动。--apply 才会移动到 team-memory/_archive/。`)

  if (apply && candidates.length) {
    mkdirSync(ARCHIVE_DIR, { recursive: true })
    for (const c of candidates) {
      const src = path.join(REPO, c.file)
      const dst = path.join(ARCHIVE_DIR, path.basename(c.file))
      try { renameSync(src, dst); console.log(`  archived: ${c.file} → _archive/`) }
      catch (e) { console.error(`  archive 失败 ${c.file}: ${e.message}`) }
    }
  }
}

main()
