#!/usr/bin/env node
// ============================================================
// kos-init · 数据根 bootstrap
//
// kos-remember 从 <数据根>/team-memory/pointers/kos-route-map.json 读写入路由，
// 清单缺失即 module load throw（fail-closed；勿在代码里内置默认路由兜底，
// 会复活路由双源——见 kos-remember-route-table-blindspot 卡）。
// 本命令是唯一的官方 bootstrap 路径：把仓内模板 templates/kos-route-map.json
// 拷贝进数据根 + 按清单建目录骨架，让全新数据根 out-of-the-box 可写。
//
// 用法：
//   node kos-init.mjs --data-root <dir>       # 显式指定数据根
//   KOS_DATA_ROOT=<dir> node kos-init.mjs     # 或走 env
//   --force                                   # 已有清单时用模板覆盖（默认拒绝）
//
// 行为：
//   - 数据根必须显式给出（flag 或 env），不回退 cwd / 仓根——bootstrap 写文件，落点不能靠猜
//   - 清单已存在且无 --force：不动清单，只按「现有清单」补缺失目录（幂等修复模式）
//   - 建目录范围：types[*].path / types[*].team_path + non_memory_dirs 各键（team-memory/ 下）
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'kos-route-map.json')

function fail(msg) {
  console.error(`[kos-init] ${msg}`)
  process.exit(1)
}

function usage() {
  console.log('Usage:')
  console.log('  node kos-init.mjs --data-root <dir> [--force]')
  console.log('  KOS_DATA_ROOT=<dir> node kos-init.mjs [--force]')
  console.log('')
  console.log('把默认路由清单模板拷进 <数据根>/team-memory/pointers/kos-route-map.json 并建目录骨架。')
  console.log('清单已存在时默认只补缺失目录；--force 才会用模板覆盖现有清单。')
}

function readFlagValue(argv, flag) {
  const idx = argv.indexOf(flag)
  if (idx === -1) return undefined
  const value = argv[idx + 1]
  if (value === undefined || value.startsWith('--')) fail(`${flag} 需要一个值`)
  return value
}

// 与 kos-remember.mjs module load 时的清单校验保持同一形状要求
function validateManifest(manifest, label) {
  if (!manifest || typeof manifest.types !== 'object' || Array.isArray(manifest.types)) {
    fail(`${label} 缺少有效的 types 对象`)
  }
}

// 从清单推导应存在的目录（相对数据根），不在代码里硬编码路由知识
function dirsFromManifest(manifest) {
  const dirs = new Set()
  for (const route of Object.values(manifest.types)) {
    for (const p of [route.path, route.team_path]) {
      if (p) dirs.add(p)
    }
  }
  for (const name of Object.keys(manifest.non_memory_dirs || {})) {
    dirs.add(path.posix.join('team-memory', name))
  }
  return [...dirs].sort()
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  usage()
  process.exit(0)
}
const force = argv.includes('--force')
const dataRootArg = readFlagValue(argv, '--data-root') || process.env.KOS_DATA_ROOT
if (!dataRootArg) {
  usage()
  fail('未指定数据根：传 --data-root <dir> 或设置 KOS_DATA_ROOT')
}

const ROOT = path.resolve(dataRootArg)
const MANIFEST_TARGET = path.join(ROOT, 'team-memory', 'pointers', 'kos-route-map.json')

let templateRaw
try {
  templateRaw = fs.readFileSync(TEMPLATE_PATH, 'utf-8')
} catch (err) {
  fail(`无法读取模板 ${TEMPLATE_PATH}: ${err.message}`)
}
let template
try {
  template = JSON.parse(templateRaw)
} catch (err) {
  fail(`模板 ${TEMPLATE_PATH} 不是合法 JSON: ${err.message}`)
}
validateManifest(template, `模板 ${TEMPLATE_PATH}`)

const manifestExists = fs.existsSync(MANIFEST_TARGET)
let wroteManifest = false
if (!manifestExists || force) {
  fs.mkdirSync(path.dirname(MANIFEST_TARGET), { recursive: true })
  fs.writeFileSync(MANIFEST_TARGET, templateRaw, 'utf-8')
  wroteManifest = true
}

// 建目录骨架按「数据根里实际生效的清单」走：
// 新写入 = 模板；已存在且未覆盖 = 现有清单（可能已被用户增改过 types）
let effective
try {
  effective = JSON.parse(fs.readFileSync(MANIFEST_TARGET, 'utf-8'))
} catch (err) {
  fail(`现有清单 ${MANIFEST_TARGET} 不是合法 JSON: ${err.message}（如需重置用 --force）`)
}
validateManifest(effective, `现有清单 ${MANIFEST_TARGET}`)

const created = []
for (const rel of dirsFromManifest(effective)) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(abs, { recursive: true })
    created.push(rel)
  }
}

console.log(`[kos-init] 数据根: ${ROOT}`)
if (wroteManifest) {
  console.log(`[kos-init] 路由清单${manifestExists ? '已覆盖（--force）' : '已写入'}: ${MANIFEST_TARGET}`)
} else {
  console.log(`[kos-init] 路由清单已存在，保持不动（覆盖用 --force）: ${MANIFEST_TARGET}`)
}
console.log(created.length
  ? `[kos-init] 新建目录 ${created.length} 个: ${created.join(', ')}`
  : '[kos-init] 目录骨架已齐，无需新建')
console.log('[kos-init] 下一步:')
console.log(`  export KOS_DATA_ROOT=${ROOT}`)
console.log('  node kos-remember.mjs --verify-routes   # 应输出 OK')
