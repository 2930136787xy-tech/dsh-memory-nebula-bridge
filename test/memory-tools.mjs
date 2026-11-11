// 记忆工具集成测试：用插件自带的框架建一家临时库，再验证
// nebula_remember → nebula_recall → nebula_mood 这条「会话里能记住/能想起来/有心情」的链路。
//
//   node test/memory-tools.mjs
//
// 全程只碰临时目录，不接触任何真实记忆库。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const framework = path.join(root, 'framework')
const initScript = path.join(framework, 'tools', 'init_store.py')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-tools-'))
const STATUS_PORT = 6201

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

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout?.on('data', (c) => (out += String(c)))
    child.stderr?.on('data', (c) => (err += String(c)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}`))))
  })
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
      const res = await fetch(`http://127.0.0.1:${STATUS_PORT}/state`, { cache: 'no-store' })
      const state = await res.json()
      if (state.phase === 'running') return state
      if (state.phase === 'failed' || state.phase === 'unconfigured') {
        throw new Error('phase=' + state.phase + ' ' + (state.error || ''))
      }
    } catch (error) {
      if (String(error?.message || '').startsWith('phase=')) throw error
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('sidecar 没在 60s 内就绪')
}

const store = path.join(tmp, 'store')

try {
  await run('py', ['-3', initScript, store, '--persona', 'alice=Alice', '--admin', 'alice'], framework)
  console.log('  ok   用内置框架建了一家临时库')

  const mod = await import(pathToFileURL(path.join(root, 'index.js')).href)
  mod.apply(ctx, { dataDir: store, statusPort: STATUS_PORT })
  await waitRunning()

  await check('注册了记忆/心情四个工具', () => {
    for (const name of ['nebula_status', 'nebula_recall', 'nebula_remember', 'nebula_mood', 'nebula_memory_update']) {
      assert.ok(tools.has(name), 'missing tool: ' + name)
    }
  })

  const saved = await tools.get('nebula_remember').execute({ text: '用户喜欢在深夜写代码', importance: 0.9 })

  await check('nebula_remember 写入并返回 id', () => {
    assert.match(String(saved.id), /^mem:s:\d+$/)
    assert.equal(saved.duplicate, undefined)
  })

  await check('nebula_remember 对重复正文不再写一条', async () => {
    const again = await tools.get('nebula_remember').execute({ text: '用户喜欢在深夜写代码' })
    assert.equal(again.duplicate, true)
    assert.equal(again.id, saved.id)
  })

  const recalled = await tools.get('nebula_recall').execute({ query: '写代码', limit: 5 })

  await check('nebula_recall 能按关键词想起来', () => {
    assert.ok(recalled.total >= 1, 'empty store')
    const hit = recalled.items.find((x) => String(x.text).includes('深夜写代码'))
    assert.ok(hit, 'not recalled')
    assert.ok(hit.score > 0, 'score missing')
  })

  await check('nebula_recall 按相关度降序', () => {
    const scores = recalled.items.map((x) => Number(x.score))
    const sorted = [...scores].sort((a, b) => b - a)
    assert.deepEqual(scores, sorted)
  })

  await check('nebula_mood 写入后能读回', async () => {
    await tools.get('nebula_mood').execute({ action: 'set', valence: 0.6, arousal: 0.2, affection: 0.8, speaker: 'alice' })
    const read = await tools.get('nebula_mood').execute({ action: 'get', speaker: 'alice' })
    assert.equal(Math.round(Number(read.mood.alice.valence) * 10), 6)
    assert.equal(Math.round(Number(read.mood.alice.affection) * 10), 8)
  })

  await check('nebula_status 里能看到记忆条数', async () => {
    const out = await tools.get('nebula_status').execute({})
    assert.equal(out.running, true)
    assert.ok(Number(out.memories) >= 1, 'memories=' + out.memories)
  })
} catch (error) {
  failed = true
  console.error('  FAIL setup: ' + (error?.message || error))
} finally {
  await shutdown()
}

console.log('')
console.log(failed ? 'tools: FAILED' : 'tools: all checks passed')
process.exitCode = failed ? 1 : 0