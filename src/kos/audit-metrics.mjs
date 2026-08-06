#!/usr/bin/env node
// scripts/kos/audit-metrics.mjs
// KOS 流水统计：扫 .asi/kos-*-metrics.jsonl → 输出 24h / 7d / all 窗口的 total / ok / skipped / error / ok_rate
//
// CLI:
//   node scripts/kos/audit-metrics.mjs [--window 24h|7d|all]
//
// 产出：
//   1. stdout markdown table（人看）
//   2. .asi/kos-audit-report.md（机器消费 / 邮件 / 周报引用）
//
// 设计说明：
//   - ok_rate 计算时分母剔除 skipped:true（这部分是 dedup_24h 等"主动跳过"，不算成功也不算失败）
//   - 错误数 = ok=false 且 skipped 不是 true
//   - 当前 jsonl schema 各文件略不同（write 有 args / trigger 有 commit_hash / query 有 latency_ms），
//     但 ok / skipped 字段口径统一，audit 只看这两字段做汇总
//   - 不读 jsonl 之外的源（PG / vec），避免与 .asi flat-file 真理源耦合

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ASI_DIR = path.join(REPO_ROOT, '.asi');

const SOURCES = [
  { key: 'write', label: 'kos_remember 写入', file: 'kos-write-metrics.jsonl' },
  { key: 'trigger', label: 'auto-remember-on-commit', file: 'kos-trigger-metrics.jsonl' },
  { key: 'correction', label: 'capture-correction', file: 'kos-correction-metrics.jsonl' },
  { key: 'query', label: 'MCP tool calls', file: 'kos-query-metrics.jsonl' },
];

// ── CLI 参数 ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { window: '24h' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--window' || a === '-w') {
      out.window = argv[++i] || '24h';
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/kos/audit-metrics.mjs [--window 24h|7d|all]

Options:
  --window, -w   时间窗（24h / 7d / all）。默认 24h
  --help, -h     显示帮助

输出：
  - stdout markdown table
  - 写到 .asi/kos-audit-report.md
`);
}

// ── 窗口换算 ─────────────────────────────────────────────────────────────
function windowToMs(w) {
  if (w === 'all') return Infinity;
  if (w === '24h') return 24 * 3600 * 1000;
  if (w === '7d') return 7 * 24 * 3600 * 1000;
  // 兜底：解析 \d+(h|d)
  const m = /^(\d+)(h|d)$/.exec(w);
  if (m) {
    const n = Number(m[1]);
    return m[2] === 'h' ? n * 3600 * 1000 : n * 24 * 3600 * 1000;
  }
  throw new Error(`未知 window 格式：${w}（支持 24h / 7d / all 或 \\d+(h|d)）`);
}

// ── 读 jsonl + 过滤窗口 + 统计 ───────────────────────────────────────────
function readJsonl(file) {
  if (!fs.existsSync(file)) return { exists: false, lines: [] };
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // 跳过坏行（jsonl 容错），不影响统计
    }
  }
  return { exists: true, lines: parsed };
}

function statsFor(entries, windowMs, now) {
  const cutoff = windowMs === Infinity ? -Infinity : now - windowMs;
  const inWindow = entries.filter(e => {
    if (!e.ts) return false;
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= cutoff;
  });

  let okCount = 0;
  let skipped = 0;
  let errors = 0;
  for (const e of inWindow) {
    const isSkipped = e.skipped === true;
    if (isSkipped) {
      skipped++;
      continue;
    }
    if (e.ok === true) {
      okCount++;
    } else if (e.ok === false) {
      errors++;
    } else {
      // 没 ok 字段——按错误对待（schema 不全也算可疑）
      errors++;
    }
  }
  const denom = okCount + errors; // skipped 剔除分母
  const okRate = denom === 0 ? null : okCount / denom;

  return {
    total: inWindow.length,
    ok: okCount,
    skipped,
    errors,
    okRate,
  };
}

function fmtRate(r) {
  if (r === null) return 'N/A';
  return `${(r * 100).toFixed(1)}%`;
}

// ── 渲染 markdown ───────────────────────────────────────────────────────
function renderReport({ window: win, generatedAt, rows, totals }) {
  const lines = [];
  lines.push(`# KOS Metrics Audit Report`);
  lines.push('');
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: \`${win}\``);
  lines.push(`- Sources: ${SOURCES.length} jsonl files under \`.asi/\``);
  lines.push('');
  lines.push(`## 汇总（window=${win}）`);
  lines.push('');
  lines.push(`| Source | File | Total | OK | Skipped | Errors | OK Rate (excl. skipped) |`);
  lines.push(`|---|---|---:|---:|---:|---:|---:|`);
  for (const row of rows) {
    const fileCell = row.exists ? `\`${row.file}\`` : `\`${row.file}\` *(missing)*`;
    lines.push(
      `| ${row.label} | ${fileCell} | ${row.total} | ${row.ok} | ${row.skipped} | ${row.errors} | ${fmtRate(row.okRate)} |`
    );
  }
  lines.push(
    `| **TOTAL** | — | **${totals.total}** | **${totals.ok}** | **${totals.skipped}** | **${totals.errors}** | **${fmtRate(totals.okRate)}** |`
  );
  lines.push('');
  lines.push(`## 字段口径`);
  lines.push('');
  lines.push(`- **Total**: 时间窗内 jsonl 行数（已过滤无效 ts）`);
  lines.push(`- **OK**: \`ok=true\` 且 \`skipped\` 非 true`);
  lines.push(`- **Skipped**: \`skipped=true\`（dedup_24h 等主动跳过，不计入成功率分母）`);
  lines.push(`- **Errors**: \`ok=false\` 或缺 \`ok\` 字段（且 \`skipped\` 非 true）`);
  lines.push(`- **OK Rate**: OK / (OK + Errors)；分母为 0 显示 N/A`);
  lines.push('');
  return lines.join('\n');
}

// ── 主流程 ──────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  let windowMs;
  try {
    windowMs = windowToMs(args.window);
  } catch (e) {
    process.stderr.write(`[audit-metrics] ${e.message}\n`);
    return 2;
  }

  const now = Date.now();
  const rows = [];
  const totals = { total: 0, ok: 0, skipped: 0, errors: 0 };

  for (const src of SOURCES) {
    const fp = path.join(ASI_DIR, src.file);
    const { exists, lines } = readJsonl(fp);
    const s = exists ? statsFor(lines, windowMs, now) : { total: 0, ok: 0, skipped: 0, errors: 0, okRate: null };
    rows.push({
      key: src.key,
      label: src.label,
      file: src.file,
      exists,
      total: s.total,
      ok: s.ok,
      skipped: s.skipped,
      errors: s.errors,
      okRate: s.okRate,
    });
    totals.total += s.total;
    totals.ok += s.ok;
    totals.skipped += s.skipped;
    totals.errors += s.errors;
  }

  const totalsDenom = totals.ok + totals.errors;
  totals.okRate = totalsDenom === 0 ? null : totals.ok / totalsDenom;

  const generatedAt = new Date(now).toISOString();
  const md = renderReport({ window: args.window, generatedAt, rows, totals });

  // stdout
  process.stdout.write(md);
  process.stdout.write('\n');

  // 落地 .asi/kos-audit-report.md
  const outFile = path.join(ASI_DIR, 'kos-audit-report.md');
  try {
    if (!fs.existsSync(ASI_DIR)) fs.mkdirSync(ASI_DIR, { recursive: true });
    fs.writeFileSync(outFile, md, 'utf-8');
    process.stderr.write(`[audit-metrics] report written → ${path.relative(REPO_ROOT, outFile)}\n`);
  } catch (e) {
    process.stderr.write(`[audit-metrics] write report failed: ${e.message}\n`);
    return 3;
  }
  return 0;
}

const code = main();
process.exit(code);
