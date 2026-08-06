import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const THIS_TEST = fileURLToPath(import.meta.url)
const GRAPH_GENERATOR = path.join(REPO_ROOT, 'src', 'kg', 'knowledge-graph-gen.mjs')
const CROSS_QUERY = path.join(REPO_ROOT, 'src', 'kg', 'cross-query.mjs')

// 整套用例依赖引擎仓布局（REPO_ROOT/src/{kg,kos,team-memory-service}）；Office 镜像布局无 src/，全部 skip。
const engineLayout = fs.existsSync(path.join(REPO_ROOT, 'src'))
const engineOnly = engineLayout ? {} : { skip: 'engine-layout suite: REPO_ROOT/src not present (Office layout)' }

function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...overrides }
  for (const key of ['KOS_DATA_ROOT', 'KOS_CODE_REPO', 'KOS_RECALL_TRACE_DIR', 'EMBEDDING_API_KEY']) delete env[key]
  Object.assign(env, overrides)
  return env
}

function runGraphGenerator(dataRoot, overrides = {}) {
  return spawnSync(process.execPath, [GRAPH_GENERATOR, '--quiet'], {
    cwd: dataRoot,
    encoding: 'utf-8',
    env: cleanEnv({ KOS_DATA_ROOT: dataRoot, ...overrides }),
  })
}

test('graph build outside git succeeds with the code repo feature disabled', engineOnly, () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-portable-graph-'))
  fs.mkdirSync(path.join(fixtureRoot, 'team-memory'), { recursive: true })

  try {
    const probe = runGraphGenerator(fixtureRoot)
    assert.equal(probe.status, 0, probe.stderr)

    const graphPath = path.join(fixtureRoot, 'team-memory', '.knowledge-graph.json')
    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'))
    assert.equal(graph.meta.gitCommitHash, null)
    assert.equal(graph.nodes.some(node => node.id.startsWith('../code-repo/')), false)
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'team-memory', '.knowledge-graph.snapshots', '.code-repo-cache.json')), false)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('graph build indexes files from KOS_CODE_REPO when enabled', engineOnly, () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-portable-graph-'))
  const codeRepoRoot = path.join(fixtureRoot, 'external-code')
  const codeFile = path.join(codeRepoRoot, 'src', 'lib', 'portable.ts')
  fs.mkdirSync(path.join(fixtureRoot, 'team-memory'), { recursive: true })
  fs.mkdirSync(path.dirname(codeFile), { recursive: true })
  fs.writeFileSync(codeFile, 'export const portable = true\n', 'utf-8')

  try {
    const probe = runGraphGenerator(fixtureRoot, { KOS_CODE_REPO: codeRepoRoot })
    assert.equal(probe.status, 0, probe.stderr)

    const graphPath = path.join(fixtureRoot, 'team-memory', '.knowledge-graph.json')
    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'))
    assert.ok(graph.nodes.some(node => node.id === '../code-repo/src/lib/portable.ts'))
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'team-memory', '.knowledge-graph.snapshots', '.code-repo-cache.json')), true)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('cross-query loads and bridges the UA graph from KOS_CODE_REPO', engineOnly, () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-portable-cross-query-'))
  const codeRepoRoot = path.join(fixtureRoot, 'external-code')
  const codeFile = path.join(codeRepoRoot, 'src', 'lib', 'portable.ts')
  const selfGraphPath = path.join(fixtureRoot, 'team-memory', '.knowledge-graph.json')
  const uaGraphPath = path.join(codeRepoRoot, '.understand-anything', 'knowledge-graph.json')
  fs.mkdirSync(path.dirname(selfGraphPath), { recursive: true })
  fs.mkdirSync(path.dirname(uaGraphPath), { recursive: true })
  fs.mkdirSync(path.dirname(codeFile), { recursive: true })
  fs.writeFileSync(codeFile, 'export const portable = true\n', 'utf-8')
  fs.writeFileSync(selfGraphPath, JSON.stringify({
    nodes: [{ id: '../code-repo/src/lib/portable.ts', type: 'code-file' }],
    edges: [],
  }), 'utf-8')
  fs.writeFileSync(uaGraphPath, JSON.stringify({
    nodes: [{ id: 'file:src/lib/portable.ts', filePath: 'src/lib/portable.ts' }],
    edges: [],
  }), 'utf-8')

  try {
    const probe = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { lookup } from ${JSON.stringify(pathToFileURL(CROSS_QUERY).href)}; process.stdout.write(JSON.stringify(lookup(${JSON.stringify(codeFile)})))`,
      'cross-query-probe',
    ], {
      cwd: fixtureRoot,
      encoding: 'utf-8',
      env: cleanEnv({ KOS_DATA_ROOT: fixtureRoot, KOS_CODE_REPO: codeRepoRoot }),
    })
    assert.equal(probe.status, 0, probe.stderr)
    const result = JSON.parse(probe.stdout)
    assert.equal(result.key, 'code:src/lib/portable.ts')
    assert.equal(result.bridged, true)
    assert.equal(result.selfMatches.length, 1)
    assert.equal(result.uaMatches.length, 1)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('recall trace default follows a relocated module to the repo-root traces directory', engineOnly, () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-portable-trace-'))
  const moduleDir = path.join(fixtureRoot, 'src', 'kos')
  const copiedModule = path.join(moduleDir, 'recall-guards.mjs')
  fs.mkdirSync(moduleDir, { recursive: true })
  fs.copyFileSync(path.join(REPO_ROOT, 'src', 'kos', 'recall-guards.mjs'), copiedModule)

  let traceFile
  try {
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { startTrace } from ${JSON.stringify(pathToFileURL(copiedModule).href)}; process.stdout.write(startTrace('portable-default').end().traceFile)`,
      ],
      { encoding: 'utf-8', env: cleanEnv() },
    )
    assert.equal(probe.status, 0, probe.stderr)
    traceFile = probe.stdout
    assert.ok(traceFile.startsWith(path.join(fixtureRoot, 'traces') + path.sep), traceFile)
  } finally {
    if (traceFile && fs.existsSync(traceFile)) fs.unlinkSync(traceFile)
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('kos-distill fallback follows a relocated module to the engine repo root', engineOnly, () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-portable-distill-'))
  const moduleDir = path.join(fixtureRoot, 'src', 'kos')
  const decisionsDir = path.join(fixtureRoot, 'team-memory', 'decisions')
  const copiedModule = path.join(moduleDir, 'kos-distill.mjs')
  const marker = `portable-fixture-${process.pid}`
  fs.mkdirSync(moduleDir, { recursive: true })
  fs.mkdirSync(decisionsDir, { recursive: true })
  fs.copyFileSync(path.join(REPO_ROOT, 'src', 'kos', 'kos-distill.mjs'), copiedModule)
  fs.writeFileSync(
    path.join(decisionsDir, 'portable-fixture.md'),
    `---\nname: Portable fixture\ntags: [${marker}]\n---\n`,
    'utf-8',
  )

  try {
    const probe = spawnSync(process.execPath, [copiedModule, '--min', '1'], {
      encoding: 'utf-8',
      env: cleanEnv(),
    })
    assert.equal(probe.status, 0, probe.stderr)
    assert.match(probe.stdout, new RegExp(marker))
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('every legacy service URL read has a generic env fallback with higher precedence', engineOnly, () => {
  const pending = [path.join(REPO_ROOT, 'src')]
  const sourceFiles = []
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(absolute)
      else if (/\.m?js$/.test(entry.name) && absolute !== THIS_TEST) sourceFiles.push(absolute)
    }
  }

  for (const file of sourceFiles) {
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (line.includes('process.env.TM_SERVICE_URL')) {
        assert.ok(
          line.includes('process.env.KOS_SERVICE_URL || process.env.TM_SERVICE_URL'),
          `${path.relative(REPO_ROOT, file)}:${index + 1}`,
        )
      }
    }
  }
})

test('service hook prefers the generic URL and token env names', engineOnly, () => {
  const hook = path.join(REPO_ROOT, 'src', 'team-memory-service', 'hooks', 'team-tool-recall-pre.mjs')
  const preload = `globalThis.fetch = async (url, options) => { console.log(JSON.stringify({ url: String(url), authorization: options.headers.Authorization })); return { ok: true, json: async () => ({ hits: [] }) } }`
  const importUrl = `data:text/javascript,${encodeURIComponent(preload)}`
  const input = JSON.stringify({ session_id: 'portability-test', tool_input: { command: 'node scripts/asi.mjs' } })
  const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kos-portable-env-'))

  function run(overrides) {
    const probe = spawnSync(process.execPath, ['--import', importUrl, hook], {
      encoding: 'utf-8',
      input,
      env: cleanEnv({ USERPROFILE: fixtureHome, HOME: fixtureHome, ...overrides }),
    })
    assert.equal(probe.status, 0, probe.stderr)
    return JSON.parse(probe.stdout.trim().split(/\r?\n/)[0])
  }

  try {
    assert.deepEqual(
      run({
        KOS_SERVICE_URL: 'https://new.example',
        TM_SERVICE_URL: 'https://old.example',
        KOS_SERVICE_TOKEN: 'new-token',
      }),
      { url: 'https://new.example/api/recall', authorization: 'Bearer new-token' },
    )
    assert.deepEqual(
      run({ TM_SERVICE_URL: 'https://old.example', KOS_SERVICE_TOKEN: 'generic-token' }),
      { url: 'https://old.example/api/recall', authorization: 'Bearer generic-token' },
    )
  } finally {
    fs.rmSync(fixtureHome, { recursive: true, force: true })
  }
})
