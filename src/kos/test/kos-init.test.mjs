import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// 相对测试文件定位，Office(scripts/kos) 与引擎镜像(src/kos) 两种布局都成立
const KOS_INIT = fileURLToPath(new URL('../kos-init.mjs', import.meta.url))
const KOS_REMEMBER = fileURLToPath(new URL('../kos-remember.mjs', import.meta.url))
const TEMPLATE = fileURLToPath(new URL('../templates/kos-route-map.json', import.meta.url))

function cleanEnv(overrides = {}) {
  const env = { ...process.env }
  for (const key of ['KOS_DATA_ROOT', 'KOS_MEMORY_DIR']) delete env[key]
  Object.assign(env, overrides)
  return env
}

function runInit(args, overrides = {}) {
  return spawnSync(process.execPath, [KOS_INIT, ...args], {
    encoding: 'utf-8',
    env: cleanEnv(overrides),
  })
}

function tmpRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('init seeds route manifest + dir skeleton, verify-routes passes out of the box', () => {
  const root = tmpRoot('kos-init-fresh-')
  try {
    const res = runInit(['--data-root', root])
    assert.equal(res.status, 0, res.stderr)

    const manifestPath = path.join(root, 'team-memory', 'pointers', 'kos-route-map.json')
    assert.ok(fs.existsSync(manifestPath), 'route manifest should be written')
    assert.equal(fs.readFileSync(manifestPath, 'utf-8'), fs.readFileSync(TEMPLATE, 'utf-8'))

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    for (const route of Object.values(manifest.types)) {
      for (const rel of [route.path, route.team_path]) {
        if (rel) assert.ok(fs.existsSync(path.join(root, rel)), `dir ${rel} should exist`)
      }
    }
    assert.ok(fs.existsSync(path.join(root, 'team-memory', '_drafts')))

    const verify = spawnSync(process.execPath, [KOS_REMEMBER, '--verify-routes'], {
      encoding: 'utf-8',
      env: cleanEnv({ KOS_DATA_ROOT: root }),
    })
    assert.equal(verify.status, 0, verify.stderr)
    assert.match(verify.stdout, /OK: \d+ dirs declared, 0 undeclared/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('init is idempotent: existing manifest kept verbatim, only missing dirs repaired', () => {
  const root = tmpRoot('kos-init-idem-')
  try {
    assert.equal(runInit(['--data-root', root]).status, 0)

    // 用户改过清单（加一个新 type/新目录）→ 再跑 init 不得覆盖清单，但要按现有清单补目录
    const manifestPath = path.join(root, 'team-memory', 'pointers', 'kos-route-map.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    manifest.types.experiment = { scope: 'team', path: 'team-memory/experiments' }
    const customised = JSON.stringify(manifest, null, 2)
    fs.writeFileSync(manifestPath, customised, 'utf-8')

    const rerun = runInit(['--data-root', root])
    assert.equal(rerun.status, 0, rerun.stderr)
    assert.equal(fs.readFileSync(manifestPath, 'utf-8'), customised, 'manifest must stay untouched without --force')
    assert.ok(fs.existsSync(path.join(root, 'team-memory', 'experiments')), 'missing dir from customised manifest should be created')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('kos-remember stays fail-closed on uninitialised root and points at kos-init', () => {
  const root = tmpRoot('kos-init-failclosed-')
  try {
    const res = spawnSync(process.execPath, [KOS_REMEMBER, '--verify-routes'], {
      encoding: 'utf-8',
      env: cleanEnv({ KOS_DATA_ROOT: root }),
    })
    assert.notEqual(res.status, 0, 'missing manifest must still throw (fail-closed)')
    assert.match(res.stderr, /无法加载路由清单/)
    assert.match(res.stderr, /kos-init/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('init refuses to guess the data root', () => {
  const res = runInit([])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /未指定数据根/)
})
