/**
 * 记忆星云 —— Host 侧。
 *
 * 三件事：
 *   1. 把 memory-nebula 的 viewer_server.py 作为本地 sidecar 拉起来（只绑 127.0.0.1）；
 *   2. 在 127.0.0.1 上开一个状态接口，页面里的按钮据此决定能不能打开星云；
 *   3. 给智能体注册记忆工具：查状态、检索记忆、修订记忆。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const SCRIPT = 'viewer_server.py'
const STATUS_PORT_DEFAULT = 6183
const HEALTH_TIMEOUT_MS = 25000
const UPDATE_OPS = ['important', 'less', 'pin', 'unpin', 'forget', 'restore', 'edit', 'delete', 'merge']

// 插件自带一份框架运行时：首次安装时用它给用户建一个属于他自己的记忆库。
const HERE_DIR = path.dirname(fileURLToPath(import.meta.url))
const FRAMEWORK_DIR = path.join(HERE_DIR, 'framework')
const INIT_SCRIPT = path.join(FRAMEWORK_DIR, 'tools', 'init_store.py')
const BRIDGE_SCRIPT = path.join(FRAMEWORK_DIR, 'tools', 'dsh_bridge.py')

const PY_CANDIDATES = [
  ['py', ['-3']],
  ['python', []],
  ['python3', []],
]

function expandHome(value) {
  const p = String(value || '').trim()
  if (!p) return ''
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

function dataDirCandidates(config) {
  const home = os.homedir()
  const out = []
  const configured = expandHome(config?.dataDir)
  if (configured) out.push(configured)
  const fromEnv = expandHome(process.env.DSH_MEMORY_NEBULA_DIR)
  if (fromEnv) out.push(fromEnv)
  out.push(path.join(home, '.dsh', 'memory-nebula'))
  out.push(path.join(home, 'memory-nebula'))
  out.push(path.join(home, 'Documents', 'memory-nebula'))
  return out
}

function resolveDataDir(config) {
  for (const dir of dataDirCandidates(config)) {
    try {
      if (dir && fs.existsSync(path.join(dir, SCRIPT))) return dir
    } catch {
      /* 忽略不可读的候选目录 */
    }
  }
  return ''
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.on('error', () => resolve(0))
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function probe(command, prefix) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    let child
    try {
      child = spawn(command, [...prefix, '-c', 'print(1)'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      done(false)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 进程可能已经退出 */
      }
      done(false)
    }, 4000)
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
  })
}

async function pickPython(config) {
  const preferred = String(config?.python || '').trim()
  const candidates = preferred
    ? [[preferred, []], ...PY_CANDIDATES]
    : PY_CANDIDATES
  for (const [command, prefix] of candidates) {
    if (await probe(command, prefix)) return { command, prefix }
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitHealthy(baseUrl, signal) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let lastError = ''
  while (Date.now() < deadline) {
    if (signal?.aborted) return lastError || 'aborted'
    try {
      const res = await fetch(baseUrl + '/api/mode', { signal: AbortSignal.timeout(1500) })
      if (res.ok) return ''
      lastError = 'HTTP ' + res.status
    } catch (error) {
      lastError = String(error?.message || error)
    }
    await sleep(300)
  }
  return lastError || 'timeout'
}

async function readJson(url, init, timeoutMs = 12000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text.slice(0, 400) }
  }
  if (!res.ok) {
    const detail = typeof body?.error === 'string' ? body.error : 'HTTP ' + res.status
    throw new Error(detail)
  }
  return body
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, code, body) {
  const origin = res.__origin || '*'
  res.writeHead(code, {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(body))
}

export const inject = ['tools']

export function apply(ctx, config) {
  const state = {
    phase: 'starting', // starting | running | failed | unconfigured
    port: 0,
    url: '',
    dataDir: '',
    python: '',
    py: null,
    error: '',
    child: null,
    statusServer: null,
  }
  let disposed = false
  const abort = new AbortController()

  function snapshot() {
    return {
      phase: state.phase,
      running: state.phase === 'running',
      url: state.url,
      port: state.port,
      dataDir: state.dataDir,
      python: state.python,
      error: state.error,
      // 页面里的面板据此决定用「内嵌面板」还是退化成「新标签页」。
      capabilities: { graph: true, update: true },
    }
  }

  function stopChild() {
    const child = state.child
    state.child = null
    if (!child) return
    try {
      child.kill()
    } catch {
      /* 已经退出 */
    }
  }

  function stopStatusServer() {
    const server = state.statusServer
    state.statusServer = null
    if (!server) return
    try {
      server.close()
    } catch {
      /* 已经关闭 */
    }
  }

  function fail(message) {
    state.phase = 'failed'
    state.error = message
    state.url = ''
    stopChild()
    ctx.logger?.warn?.(`[memory-nebula] ${message}`)
  }

  function spawnSidecar(python, port) {
    const child = spawn(python.command, [...python.prefix, '-X', 'utf8', SCRIPT, String(port)], {
      cwd: state.dataDir,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        // 显式钉到这家库：不然 memory_view 会回落到「聊天机器人」那份默认库，
        // 新用户就会看到别人的记忆。
        SHARED_DB: path.join(state.dataDir, 'bridge.db'),
        VIEW_DB: path.join(state.dataDir, 'brain.db'),
        NEBULA_DATA: path.join(state.dataDir, 'data'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-1200)
    })
    child.on('error', (error) => {
      if (!disposed) fail(`sidecar 起不来：${error?.message || error}`)
    })
    child.on('close', (code) => {
      if (disposed || state.child !== child) return
      state.child = null
      if (state.phase === 'running') {
        fail(`sidecar 退出了（code ${code}）${stderr ? '：' + stderr.trim() : ''}`)
      }
    })
    return child
  }

  /** 首次安装：用插件自带的框架，给用户建一个属于他自己的记忆库。 */
  function scaffoldStore(python, target) {
    return new Promise((resolve) => {
      if (!fs.existsSync(INIT_SCRIPT)) {
        resolve('插件里缺 framework/tools/init_store.py')
        return
      }
      const child = spawn(python.command, [...python.prefix, '-X', 'utf8', INIT_SCRIPT, target], {
        cwd: FRAMEWORK_DIR,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-600)
      })
      child.on('error', (error) => resolve(String(error?.message || error)))
      child.on('close', (code) => resolve(code === 0 ? '' : stderr.trim() || `exit ${code}`))
    })
  }

  /** 跑一次 dsh_bridge.py，拿它输出的 JSON。记忆读写都走这条，不依赖 sidecar 是否在跑。 */
  function runBridge(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const python = state.py
      if (!python) {
        reject(new Error('Python 3 不可用'))
        return
      }
      if (!state.dataDir) {
        reject(new Error('还没有记忆库目录'))
        return
      }
      const child = spawn(
        python.command,
        [...python.prefix, '-X', 'utf8', BRIDGE_SCRIPT, '--store', state.dataDir, ...args],
        {
          cwd: FRAMEWORK_DIR,
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 已退出 */
        }
        reject(new Error('记忆桥超时'))
      }, timeoutMs)
      child.stdout?.on('data', (chunk) => {
        out += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        err = (err + String(chunk)).slice(-600)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(String(error?.message || error)))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(err.trim() || `记忆桥退出（code ${code}）`))
          return
        }
        try {
          resolve(JSON.parse(out))
        } catch {
          reject(new Error('记忆桥输出不是 JSON：' + out.slice(0, 200)))
        }
      })
    })
  }

  async function bootstrap() {
    const python = await pickPython(config)
    if (!python) {
      fail('没找到可用的 Python 3，请安装或设置 config.python')
      return
    }
    state.py = python
    state.python = [python.command, ...python.prefix].join(' ')
    if (disposed) return

    state.dataDir = resolveDataDir(config)
    if (!state.dataDir && config?.autoInit !== false) {
      const target = expandHome(config?.dataDir) || path.join(os.homedir(), '.dsh', 'memory-nebula')
      ctx.logger?.info?.(`[memory-nebula] 首次运行，正在 ${target} 建库…`)
      const why = await scaffoldStore(python, target)
      if (disposed) return
      if (why) {
        fail(`自动建库失败：${why}`)
        return
      }
      state.dataDir = resolveDataDir(config)
      ctx.logger?.info?.(`[memory-nebula] 新库已建好：${state.dataDir}`)
    }
    if (!state.dataDir) {
      state.phase = 'unconfigured'
      state.error = '没找到 memory-nebula（缺 viewer_server.py）；请把 dataDir 指向项目目录'
      return
    }
    const port = Number(config?.port) > 0 ? Number(config.port) : (await freePort()) || 8765 + Math.floor(Math.random() * 8)
    state.port = port
    state.url = `http://127.0.0.1:${port}/`

    if (disposed) return

    state.child = spawnSidecar(python, port)
    const problem = await waitHealthy(state.url.replace(/\/$/, ''), abort.signal)
    if (disposed) return
    if (problem) {
      fail(`sidecar 没就绪：${problem}`)
      return
    }
    state.phase = 'running'
    state.error = ''
    ctx.logger?.info?.(`[memory-nebula] 已就绪 ${state.url}（${state.dataDir}）`)
  }

  function startStatusServer() {
    const port = Number(config?.statusPort) > 0 ? Number(config.statusPort) : STATUS_PORT_DEFAULT
    const server = http.createServer(async (req, res) => {
      res.__origin = req.headers.origin || '*'
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': res.__origin,
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        })
        res.end()
        return
      }
      const url = (req.url || '').split('?')[0]
      try {
        if (url === '/state' && req.method === 'GET') {
          sendJson(res, 200, snapshot())
          return
        }
        if (url === '/graph' && req.method === 'GET') {
          if (state.phase !== 'running') {
            sendJson(res, 503, { error: state.error || '记忆星云没在运行' })
            return
          }
          sendJson(res, 200, await graph())
          return
        }
        if (url === '/memory' && req.method === 'POST') {
          const body = await readBody(req)
          sendJson(res, 200, await updateMemory(body))
          return
        }
        if (url === '/restart' && req.method === 'POST') {
          stopChild()
          state.phase = 'starting'
          state.error = ''
          void bootstrap()
          sendJson(res, 202, snapshot())
          return
        }
        sendJson(res, 404, { error: 'not found' })
      } catch (error) {
        sendJson(res, 400, { error: String(error?.message || error) })
      }
    })
    server.on('error', (error) => {
      ctx.logger?.warn?.(`[memory-nebula] 状态端口 ${port} 打不开：${error?.message || error}`)
    })
    server.listen(port, '127.0.0.1')
    state.statusServer = server
  }

  async function graph() {
    if (state.phase !== 'running') throw new Error(state.error || '记忆星云没在运行')
    return readJson(state.url.replace(/\/$/, '') + '/api/graph')
  }

  /** 写入记忆后让图跟上（面板读的是 graph.json，不重建就看不到新条目）。 */
  async function rebuildQuietly() {
    if (state.phase !== 'running') return
    try {
      await fetch(state.url.replace(/\/$/, '') + '/api/rebuild', {
        method: 'POST',
        headers: { 'X-Viewer': '1' },
        signal: AbortSignal.timeout(30000),
      })
    } catch {
      /* 图重建失败不影响记忆本身 */
    }
  }

  function normalizeUpdate(body) {
    const store = String(body?.store || '')
    if (store !== 's' && store !== 'b') throw new Error('store 只能是 s 或 b')
    const id = Number(body?.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('id 必须是正整数')
    const op = String(body?.op || '')
    if (!UPDATE_OPS.includes(op)) throw new Error('op 不支持：' + op)
    const payload = { store, id, op }
    if (body?.text !== undefined) payload.text = String(body.text)
    return payload
  }

  async function updateMemory(body) {
    const payload = normalizeUpdate(body)
    if (state.phase !== 'running') throw new Error(state.error || '记忆星云没在运行')
    return readJson(state.url.replace(/\/$/, '') + '/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Viewer': '1' },
      body: JSON.stringify(payload),
    })
  }

  ctx.effect(() => {
    startStatusServer()
    void bootstrap()
    return () => {
      disposed = true
      abort.abort()
      stopChild()
      stopStatusServer()
    }
  })

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_status',
      description:
        '查看「记忆星云」记忆库的状态：是否运行、数据目录、访问地址、记忆条数与来源。想检索或修订记忆前可以先用它确认服务正常。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            running: { type: 'boolean' },
            url: { type: 'string' },
            dataDir: { type: 'string' },
            counts: { type: 'object' },
            memories: { type: 'number' },
            mood: { type: 'object' },
            generated: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render(_args, value) {
          if (!value?.running) {
            return [{ type: 'text', text: `记忆星云未运行：${value?.error || '未知原因'}` }]
          }
          const c = value.counts || {}
          const parts = Object.entries(c).map(([k, v]) => `${k}=${v}`).join('，')
          return [{ type: 'text', text: `记忆星云运行中 ${value.url}${parts ? '（' + parts + '）' : ''}` }]
        },
      },
      async execute() {
        const out = snapshot()
        if (state.phase !== 'running') return out
        try {
          const g = await graph()
          out.counts = g?.meta?.counts || {}
          out.generated = g?.meta?.generated || ''
        } catch (error) {
          out.error = String(error?.message || error)
        }
        // 图是缓存，直接查库更准（尤其刚用 nebula_remember 写进去、图还没重建时）
        try {
          const stats = await runBridge(['stats'], 15000)
          out.memories = Number(stats?.counts?.shared || 0) + Number(stats?.counts?.local || 0)
          out.mood = stats?.mood || {}
        } catch {
          /* 查库失败就只报图上的数 */
        }
        return out
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_search',
      description:
        '在「记忆星云」记忆库里检索记忆。按关键词在记忆正文里模糊匹配，返回命中的记忆（含节点 id、正文、重要性、是否永久、状态），可用于回忆用户提过的事、偏好和历史决定。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词；空字符串表示按重要度取前几条。' },
          limit: { type: 'number', description: '最多返回几条，默认 10，最大 50。' },
          includeFaded: { type: 'boolean', description: '是否包含已遗忘（faded）的记忆，默认 false。' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'number' },
            items: { type: 'array' },
          },
        },
        render(_args, value) {
          const items = Array.isArray(value?.items) ? value.items : []
          if (!items.length) return [{ type: 'text', text: '没有匹配的记忆。' }]
          const lines = items.map((n, i) => {
            const mark = n.pinned ? '📌' : n.status === 'faded' ? '🌫' : '·'
            return `${i + 1}. ${mark} ${String(n.text || '').replace(/\s+/g, ' ').slice(0, 120)}`
          })
          return [{ type: 'text', text: `命中 ${items.length} 条（共 ${value?.total ?? '?'} 条记忆）：\n${lines.join('\n')}` }]
        },
      },
      async execute(args) {
        const query = String(args?.query ?? '').trim()
        const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 50)
        const includeFaded = args?.includeFaded === true
        const g = await graph()
        const nodes = Array.isArray(g?.nodes) ? g.nodes : []
        const memories = nodes.filter((n) => n && n.type === 'memory')
        const needle = query.toLowerCase()
        const hits = memories.filter((n) => {
          if (!includeFaded && n.status === 'faded') return false
          if (!needle) return true
          const text = String(n.text || n.label || '').toLowerCase()
          return text.includes(needle)
        })
        hits.sort((a, b) => {
          const pin = Number(b.pinned || 0) - Number(a.pinned || 0)
          if (pin !== 0) return pin
          return Number(b.importance || 0) - Number(a.importance || 0)
        })
        const items = hits.slice(0, limit).map((n) => ({
          id: n.id,
          text: String(n.text || n.label || ''),
          importance: Number(n.importance || 0),
          pinned: n.pinned ? 1 : 0,
          status: String(n.status || ''),
          store: String(n.id || '').split(':')[1] || '',
        }))
        return { total: memories.length, items }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_recall',
      description:
        '从「记忆星云」里按相关度取回记忆（重要度 + 新近度 + 是否永久 + 关键词命中的加权排序，不是简单包含匹配）。想知道用户提过什么、有什么偏好和历史决定时先调它。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要回想的关键词；留空表示按重要度和新近度取前几条。' },
          limit: { type: 'number', description: '最多返回几条，默认 8。' },
          includeFaded: { type: 'boolean', description: '是否包含已遗忘的记忆，默认 false。' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            total: { type: 'number' },
            matched: { type: 'number' },
            items: { type: 'array' },
          },
        },
        render(_args, value) {
          const items = Array.isArray(value?.items) ? value.items : []
          if (!items.length) return [{ type: 'text', text: '这次没想起来相关的记忆。' }]
          const lines = items.map((n, i) => {
            const mark = n.pinned ? '📌' : n.status === 'faded' ? '🌫' : '·'
            return `${i + 1}. ${mark} [${n.score}] ${String(n.text || '').replace(/\s+/g, ' ').slice(0, 120)}`
          })
          return [{ type: 'text', text: `想起来 ${items.length} 条（库里共 ${value?.total ?? '?'} 条）：\n${lines.join('\n')}` }]
        },
      },
      async execute(args) {
        const query = String(args?.query ?? '').trim()
        const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 30)
        const argv = ['recall', '--query', query, '--limit', String(limit)]
        if (args?.includeFaded === true) argv.push('--include-faded')
        return runBridge(argv)
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_remember',
      description:
        '把一条信息写进「记忆星云」，之后能通过 nebula_recall 想起来。适合记住用户的偏好、事实、约定和承诺；正文要写成一句话，不要带无关上下文。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容，一句话。' },
          importance: { type: 'number', description: '重要度 0..1，默认 0.6；长期偏好给 0.8 以上。' },
          speaker: { type: 'string', description: '这条记忆属于谁（可选）。' },
          pinned: { type: 'boolean', description: '是否直接设为永久记忆。' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
            duplicate: { type: 'boolean' },
          },
        },
        render(_args, value) {
          if (value?.duplicate) return [{ type: 'text', text: `这条已经记过了：${value.id}` }]
          return [{ type: 'text', text: `记住了（${value?.id}）：${value?.text || ''}` }]
        },
      },
      async execute(args) {
        const text = String(args?.text ?? '').trim()
        if (!text) throw new Error('text 不能为空')
        const argv = ['remember', '--text', text]
        if (args?.importance !== undefined) {
          const imp = Math.min(Math.max(Number(args.importance), 0), 1)
          argv.push('--importance', String(imp))
        }
        if (args?.speaker) argv.push('--speaker', String(args.speaker))
        if (args?.pinned === true) argv.push('--pinned')
        const saved = await runBridge(argv)
        if (!saved?.duplicate) void rebuildQuietly()
        return saved
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_mood',
      description:
        '读取或更新「记忆星云」里的心情状态（效价 valence / 唤醒 arousal / 亲近 affection，各 -1..1 与 0..1）。想了解用户当前情绪基调，或想把这次对话的情绪基调记下来时用它。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'], description: 'get 读取，set 写入。' },
          speaker: { type: 'string', description: '针对谁的心情（可选）。' },
          valence: { type: 'number', description: '效价 -1（低落）..1（愉快）。' },
          arousal: { type: 'number', description: '唤醒 -1（平静）..1（激动）。' },
          affection: { type: 'number', description: '亲近 0..1。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            mood: { type: 'object' },
            saved: { type: 'object' },
          },
        },
        render(_args, value) {
          const data = value?.saved || value?.mood || {}
          const rows = Object.entries(data).map(([who, m]) =>
            `${who}: 效价 ${m.valence} / 唤醒 ${m.arousal} / 亲近 ${m.affection}`)
          if (!rows.length) return [{ type: 'text', text: '还没有记录过心情。' }]
          return [{ type: 'text', text: rows.join('\n') }]
        },
      },
      async execute(args) {
        if (args?.action === 'set') {
          const v = Number(args?.valence ?? 0)
          const a = Number(args?.arousal ?? 0)
          const f = Number(args?.affection ?? 0.5)
          const argv = ['mood', '--set', `${v},${a},${f}`]
          if (args?.speaker) argv.push('--speaker', String(args.speaker))
          return runBridge(argv)
        }
        const argv = ['mood']
        if (args?.speaker) argv.push('--speaker', String(args.speaker))
        return runBridge(argv)
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'nebula_memory_update',
      description:
        '修订「记忆星云」里的一条记忆：调整重要度、设为永久、忘掉或恢复、改正文、删除、合并。nodeId 用 nebula_search 返回的 id（形如 mem:s:9）。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'nebula_search 返回的记忆节点 id。' },
          op: {
            type: 'string',
            enum: ['important', 'less', 'pin', 'unpin', 'forget', 'restore', 'edit', 'delete', 'merge'],
            description: '要做的操作。',
          },
          text: { type: 'string', description: 'op=edit 时的新正文。' },
        },
        required: ['nodeId', 'op'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, rebuild: { type: 'object' }, error: { type: 'string' } },
        },
        render(_args, value) {
          if (value?.ok === false) return [{ type: 'text', text: `修订失败：${value?.error || '未知错误'}` }]
          return [{ type: 'text', text: '已写入，图已重建。' }]
        },
      },
      async execute(args) {
        const nodeId = String(args?.nodeId || '')
        const parts = nodeId.split(':')
        if (parts.length !== 3 || parts[0] !== 'mem') {
          return { ok: false, error: `无法解析节点 id：${nodeId}` }
        }
        const store = parts[1]
        const id = Number(parts[2])
        if (!Number.isFinite(id)) return { ok: false, error: `无法解析记忆序号：${nodeId}` }
        const body = { store, id, op: String(args.op), text: args?.text }
        try {
          const out = await updateMemory(body)
          return { ok: out?.ok !== false, rebuild: out?.rebuild || {} }
        } catch (error) {
          return { ok: false, error: String(error?.message || error) }
        }
      },
    }),
  )
}