// 宿主集成测试：起一个真实的 sidecar（建在临时副本上），验证 /state 能力声明、
// /graph 代理、/memory 代理与三个工具。不碰真实记忆库。
//
//   MEMORY_NEBULA_SOURCE=D:\path\to\memory-nebula node test/host.mjs
//
// 没设 MEMORY_NEBULA_SOURCE 时跳过（仓库里不该带真实数据）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = process.env.MEMORY_NEBULA_SOURCE || ''
if (!source || !fs.existsSync(path.join(source, 'viewer_server.py'))) {
  console.log('host test skipped: set MEMORY_NEBULA_SOURCE to a memory-nebula project directory')
  process.exit(0)
}

const STATUS_PORT = 6199
const SIDECAR_PORT = 8899
const base = `http://127.0.0.1:${STATUS_PORT}`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-host-'))
fs.cpSync(source, tmp, { recursive: true })

const cleanups = []
const tools = new Map()
const ctx = {
  effect(fn) {
    const off = fn()
    if (typeof off === 'function') cleanups.push(off)
    return off
  },
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
  },
  logger: { info() {}, warn() {} },
}

let failed = false
async function check(name, fn) {
  try {
    await fn()
    console.log('  ok   ' + name)
  } catch (error) {
    failed = true
    console.error('  FAIL ' + name)
    console.error('       ' + (error?.message || error))
  }
}

async function shutdown() {
  for (const off of cleanups.reverse()) {
    try {
      await off()
    } catch {
      /* 尽力而为 */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 600))
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* 文件可能还被占用 */
  }
}

async function waitRunning(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + '/state', { cache: 'no-store' })
      const state = await res.json()
      if (state.phase === 'running') return state
      if (state.phase === 'failed' || state.phase === 'unconfigured') {
        throw new Error('phase=' + state.phase + ' ' + (state.error || ''))
      }
    } catch (error) {
      if (String(error?.message || '').startsWith('phase=')) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error('sidecar 没在 60s 内就绪')
}

try {
  const mod = await import(pathToFileURL(path.join(root, 'index.js')).href)
  assert.equal(typeof mod.apply, 'function')
  mod.apply(ctx, { dataDir: tmp, statusPort: STATUS_PORT, port: SIDECAR_PORT })

  const state = await waitRunning()

  await check('state advertises graph/update capabilities', () => {
    assert.equal(state.running, true)
    assert.equal(state.capabilities?.graph, true)
    assert.equal(state.capabilities?.update, true)
    assert.ok(String(state.url).startsWith('http://127.0.0.1:'), 'sidecar must bind loopback')
  })

  const graph = await (await fetch(base + '/graph', { cache: 'no-store' })).json()

  await check('GET /graph proxies the star map', () => {
    assert.ok(Array.isArray(graph.nodes), 'no nodes array')
    assert.ok(graph.nodes.length > 0, 'empty graph')
    assert.ok(graph.nodes.some((n) => n.type === 'memory'), 'no memory nodes')
  })

  await check('GET /graph carries CORS headers', async () => {
    const res = await fetch(base + '/graph', { headers: { Origin: 'http://127.0.0.1:65190' } })
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:65190')
  })

  const target = graph.nodes.find((n) => n.type === 'memory' && n.status !== 'faded')
  const [, store, id] = String(target.id).split(':')
  const before = Number(target.importance)
  const op = before < 0.9 ? 'important' : 'less'

  const updated = await (
    await fetch(base + '/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store, id: Number(id), op }),
    })
  ).json()

  await check('POST /memory rebuilds and reports counts', () => {
    assert.notEqual(updated.ok, false)
    assert.ok(updated.rebuild && Number(updated.rebuild.nodes) > 0, 'rebuild counts missing')
  })

  const after = (await (await fetch(base + '/graph', { cache: 'no-store' })).json()).nodes.find((n) => n.id === target.id)

  await check('importance actually changed on disk', () => {
    assert.notEqual(Number(after.importance), before)
  })

  await check('POST /memory renames text via edit', async () => {
    const marker = '宿主集成测试标记 ' + Date.now()
    const res = await fetch(base + '/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store, id: Number(id), op: 'edit', text: marker }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.notEqual(body.ok, false)
    const graph2 = await (await fetch(base + '/graph', { cache: 'no-store' })).json()
    const node = graph2.nodes.find((n) => n.id === target.id)
    assert.equal(String(node.text), marker)
  })

  await check('POST /memory rejects an unknown op', async () => {
    const res = await fetch(base + '/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store, id: Number(id), op: 'nuke' }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(String(body.error), /op/)
  })

  await check('POST /memory rejects a bad store', async () => {
    const res = await fetch(base + '/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store: 'x', id: 1, op: 'pin' }),
    })
    assert.equal(res.status, 400)
  })

  await check('nebula_search tool returns hits', async () => {
    const tool = tools.get('nebula_search')
    assert.ok(tool, 'tool not registered')
    const out = await tool.execute({ query: '', limit: 3 })
    assert.ok(out.total > 0)
    assert.ok(out.items.length > 0 && out.items.length <= 3)
  })

  await check('nebula_status tool mirrors /state', async () => {
    const tool = tools.get('nebula_status')
    const out = await tool.execute({})
    assert.equal(out.running, true)
    assert.ok(Number(out.counts.memory) > 0, 'counts.memory missing')
  })
} catch (error) {
  failed = true
  console.error('  FAIL setup: ' + (error?.message || error))
} finally {
  await shutdown()
}

console.log('')
console.log(failed ? 'host: FAILED' : 'host: all checks passed')
process.exitCode = failed ? 1 : 0