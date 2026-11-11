// 冒烟测试：不启动 sidecar，只验证包契约和客户端模块的可加载性。
// 用法：node test/smoke.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(root, p))

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    console.error('  FAIL ' + name)
    console.error('       ' + (error?.message || error))
    process.exitCode = 1
  }
}

console.log('manifest')

const manifest = JSON.parse(read('package.json'))

await check('declares dsh.bundle.patch and the file exists', () => {
  assert.equal(typeof manifest.dsh?.bundle?.patch, 'string')
  assert.ok(exists(manifest.dsh.bundle.patch), 'patch file missing: ' + manifest.dsh.bundle.patch)
})

await check('declares a web client half', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(manifest.exports?.['./client'], 'missing ./client export')
  assert.ok(exists('client.js'))
})

await check('exports locale and icon resources', () => {
  assert.ok(manifest.exports?.['./locale/*.json'])
  assert.ok(manifest.exports?.['./icon'])
  assert.ok(exists('icon.svg'))
  assert.ok(exists('locale/zh.json'))
  assert.ok(exists('locale/en.json'))
})

await check('files[] covers every shipped runtime file', () => {
  const declared = new Set(manifest.files || [])
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md']) {
    assert.ok(declared.has(file) || declared.has('locale/*.json'), 'files[] misses ' + file)
  }
  assert.ok(declared.has('locale/*.json'), 'files[] misses locale/*.json')
})

console.log('assets')

await check('icon is a small, well-formed svg', () => {
  const svg = read('icon.svg')
  const bytes = fs.statSync(path.join(root, 'icon.svg')).size
  assert.ok(bytes < 256 * 1024, 'icon too large: ' + bytes)
  assert.ok(svg.trimStart().startsWith('<svg'), 'icon is not svg')
  assert.ok(svg.includes('</svg>'), 'icon is truncated')
  assert.ok(svg.includes('viewBox'), 'icon has no viewBox')
})

await check('locale files carry display metadata', () => {
  for (const lang of ['zh', 'en']) {
    const meta = JSON.parse(read(`locale/${lang}.json`)).meta
    assert.ok(meta?.title, lang + ' has no meta.title')
    assert.ok(meta?.description, lang + ' has no meta.description')
  }
})

console.log('loader patch')

await check('patch inserts exactly the manifest package name', () => {
  const patch = read('cordis.patch.yml')
  assert.ok(patch.includes(`name: '${manifest.name}'`), 'patch name does not match package name')
  assert.ok(patch.includes('insert:'), 'patch has no insert block')
})

console.log('client module')

await check('client registers one sidebar action', async () => {
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (mod) => { loaded = mod } } }

  const React = {
    createElement: () => ({}),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
  }

  await import(pathToFileURL(path.join(root, 'client.js')).href + '?smoke=' + Date.now())
  assert.ok(loaded, 'client.js never called __ModuleLoader__.load')
  assert.equal(loaded.id, manifest.name, 'loader id must equal package name')

  const plugin = loaded.factory((name) => (name === 'react' ? React : {}))
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('slots'))

  const registrations = []
  const ctx = {
    effect: (fn) => { fn() },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_owner, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)

  assert.equal(registrations.length, 1, 'expected exactly one registration')
  assert.equal(registrations[0].options.name, 'sidebar.footer.action')
  assert.equal(registrations[0].options.id, 'memory-nebula')
  assert.equal(typeof registrations[0].component, 'function')

  delete globalThis.window
})

console.log('')
if (process.exitCode) {
  console.error('smoke: FAILED')
} else {
  console.log('smoke: ' + passed + ' checks passed')
}