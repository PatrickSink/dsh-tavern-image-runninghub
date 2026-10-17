import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeChannels, publicChannels, channelConfigPatch } from '../lib/image-channels.js'
import { runPlanner } from '../lib/planner.js'

const sourceRoot = fileURLToPath(new URL('..', import.meta.url))
let fixtureId = 0

async function bootPlugin(root) {
  const routes = new Map()
  const disposers = []
  const comfyRequests = []
  const originalFetch = globalThis.fetch
  const fixtureFetch = async (input, init) => {
    const url = new URL(input)
    if (url.hostname === 'comfy.test') {
      comfyRequests.push({ path: url.pathname, headers: init?.headers ?? {} })
      return new Response(JSON.stringify({ system: { comfyui_version: 'fixture' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return originalFetch(input, init)
  }
  globalThis.fetch = fixtureFetch
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    llm: { stream: async function* () {}, async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'low' }] } } } },
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
    inject(names, install) { if (names.every(name => this[name])) install(this) },
    effect(install) { const dispose = install(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
  }
  const entry = pathToFileURL(join(root, 'lib', 'index.js')).href + '?fixture=' + (++fixtureId)
  const { apply } = await import(entry)
  apply(ctx, { comfyUrl: 'http://comfy.test' })
  const request = (pathname, body, method = 'POST') => new Promise((resolveRequest, reject) => {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(request, { method, url: '/plugins/dsh-tavern-image/' + pathname, headers: { host: 'localhost', 'content-type': 'application/json' } })
    const response = {
      headersSent: false,
      writeHead(status) { this.status = status; this.headersSent = true },
      end(value) { try { resolveRequest({ status: this.status, body: JSON.parse(String(value)) }) } catch (error) { reject(error) } },
    }
    const handler = routes.get(request.url)
    if (!handler) return reject(new Error('fixture route missing: ' + request.url))
    handler(request, response)
  })
  return { request, comfyRequests, dispose() {
    for (const dispose of disposers.reverse()) dispose()
    if (globalThis.fetch === fixtureFetch) globalThis.fetch = originalFetch
  } }
}

async function makePluginFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-settings-test-'))
  await mkdir(join(root, 'lib'))
  await mkdir(join(root, 'workflows'))
  await cp(join(sourceRoot, 'lib'), join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'worldbook.json'), JSON.stringify({ name: 'fixture', entries: [] }))
  await writeFile(join(root, 'definitions.json'), JSON.stringify({ characters: [], settings: [], props: [], outfits: [] }))
  const instances = []
  t.after(async () => {
    for (const instance of instances.reverse()) instance.dispose()
    assert.equal(resolve(root).startsWith(resolve(tmpdir())), true)
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    async boot() { const instance = await bootPlugin(root); instances.push(instance); return instance },
  }
}

test('channel patches preserve credentials across partial edits and expose only presence flags', () => {
  const original = normalizeChannels([{
    id: 'openai-main', provider: 'openai', name: 'Main', baseUrl: 'https://example.test/v1',
    authMode: 'basic', username: 'account', apiKey: 'test-only-key', password: 'test-only-password',
  }])
  const updated = normalizeChannels([{
    id: 'openai-main', provider: 'openai', name: 'Renamed', baseUrl: 'https://example.test/v2',
    authMode: 'basic', username: 'account', apiKey: '', password: '',
  }], original)

  assert.equal(updated[0].apiKey, 'test-only-key')
  assert.equal(updated[0].password, 'test-only-password')
  const publicValue = publicChannels(updated)[0]
  assert.equal(publicValue.hasApiKey, true)
  assert.equal(publicValue.hasPassword, true)
  assert.equal('apiKey' in publicValue, false)
  assert.equal('password' in publicValue, false)
})

test('channel credentials are removed only by explicit clear flags', () => {
  const original = normalizeChannels([{
    id: 'openai-main', provider: 'openai', name: 'Main', apiKey: 'test-only-key', password: 'test-only-password',
  }])
  const cleared = normalizeChannels([{
    id: 'openai-main', provider: 'openai', name: 'Main', clearApiKey: true, clearPassword: true,
  }], original)
  assert.equal(cleared[0].apiKey, '')
  assert.equal(cleared[0].password, '')
})

test('partial config channel patches retain saved credentials and unrelated channel fields', () => {
  const config = {
    imageBackend: 'openai', activeImageChannel: 'openai-main',
    imageChannels: normalizeChannels([{
      id: 'openai-main', provider: 'openai', name: 'Main', model: 'image-model',
      apiKey: 'test-only-key', options: { quality: 'high' },
    }]),
  }
  const patch = channelConfigPatch(config, {
    imageChannels: [{ id: 'openai-main', provider: 'openai', name: 'Main', model: 'new-model', options: { quality: 'high' } }],
  })
  assert.equal(patch.imageChannels[0].apiKey, 'test-only-key')
  assert.equal(patch.imageChannels[0].model, 'new-model')
  assert.equal(patch.imageChannels[0].options.quality, 'high')
  assert.equal(patch.imageBackend, 'openai')
})

test('正文图片显示宽度默认保持现有显示效果，保存后跨刷新与重启依然生效', async t => {
  const fixture = await makePluginFixture(t)
  const first = await fixture.boot()
  const initial = await first.request('state', undefined, 'GET')
  assert.equal(initial.body.config.imageDisplayWidth, 0, '没设置过就是 0（默认），等于不改变现在的正文显示')

  const saved = await first.request('config', { config: { imageDisplayWidth: 900 } })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.state.config.imageDisplayWidth, 900, '/config 回包里立刻能看到新值')
  first.dispose()

  // 重新 boot = 用户刷新页面 / 重启 DSH：不重新设置也要按保存的宽度显示。
  const restarted = await fixture.boot()
  const refreshed = await restarted.request('state', undefined, 'GET')
  assert.equal(refreshed.body.config.imageDisplayWidth, 900)
  const persisted = JSON.parse(await readFile(join(fixture.root, 'config.json'), 'utf8'))
  assert.equal(persisted.imageDisplayWidth, 900)
})

test('正文图片显示宽度只接受 160–2000，异常值退回默认而不会写进配置', async t => {
  const fixture = await makePluginFixture(t)
  const instance = await fixture.boot()
  const save = async value => (await instance.request('config', { config: { imageDisplayWidth: value } })).body.state.config.imageDisplayWidth

  // 过大的宽度不能把正文撑爆，过小的也要收到能看的下限。
  assert.equal(await save(99999), 2000)
  assert.equal(await save(4000), 2000)
  assert.equal(await save(10), 160)
  assert.equal(await save(159.6), 160)
  assert.equal(await save(160), 160)
  assert.equal(await save(1200), 1200)
  // 前端滑块传的是字符串，得能正常收下。
  assert.equal(await save('512.4'), 512)
  // NaN、负数、乱填的字符串、空值：一律退回默认，绝不留下 NaN 或负宽度。
  assert.equal(await save('NaN'), 0)
  assert.equal(await save('abc'), 0)
  assert.equal(await save(-40), 0)
  assert.equal(await save(0), 0)
  assert.equal(await save(null), 0)
  assert.equal(await save(''), 0)

  const persisted = JSON.parse(await readFile(join(fixture.root, 'config.json'), 'utf8'))
  assert.equal(persisted.imageDisplayWidth, 0)
  assert.equal(typeof persisted.imageDisplayWidth, 'number')
  const state = await instance.request('state', undefined, 'GET')
  assert.equal(state.body.config.imageDisplayWidth, 0)
})

test('planner and vision effort settings survive a fresh plugin boot and state refresh', async t => {
  const fixture = await makePluginFixture(t)
  const first = await fixture.boot()
  const saved = await first.request('config', { config: {
    plannerProvider: 'test-provider', plannerModel: 'test-model', plannerEffort: 'low',
    visionProvider: 'test-provider', visionModel: 'test-vision-model', visionEffort: 'low',
  } })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.state.config.plannerEffort, 'low')
  assert.equal(saved.body.state.config.visionEffort, 'low')
  first.dispose()

  const refreshed = await (await fixture.boot()).request('state', undefined, 'GET')
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.config.plannerEffort, 'low')
  assert.equal(refreshed.body.config.visionEffort, 'low')
  const persisted = JSON.parse(await readFile(join(fixture.root, 'config.json'), 'utf8'))
  assert.equal(persisted.plannerEffort, 'low')
  assert.equal(persisted.visionEffort, 'low')
})

test('ComfyUI credentials stay secret, blank saves retain them, clear flags remove them, and fresh state/auth still work', async t => {
  const fixture = await makePluginFixture(t)
  const first = await fixture.boot()
  const saved = await first.request('config', { config: {
    comfyAuthMode: 'bearer', comfyAuthToken: 'comfy-fixture-token', comfyAuthPass: 'comfy-fixture-pass',
  } })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.state.config.comfyHasAuthToken, true)
  assert.equal(saved.body.state.config.comfyHasAuthPass, true)
  assert.equal(Object.hasOwn(saved.body.state.config, 'comfyAuthToken'), false)
  assert.equal(Object.hasOwn(saved.body.state.config, 'comfyAuthPass'), false)
  assert.equal(JSON.stringify(saved.body).includes('comfy-fixture-token'), false)
  assert.equal(JSON.stringify(saved.body).includes('comfy-fixture-pass'), false)

  await first.request('config', { config: { comfyAuthToken: '', comfyAuthPass: '' } })
  const afterBlank = JSON.parse(await readFile(join(fixture.root, 'config.json'), 'utf8'))
  assert.equal(afterBlank.comfyAuthToken, 'comfy-fixture-token')
  assert.equal(afterBlank.comfyAuthPass, 'comfy-fixture-pass')
  const bearerState = await first.request('state', undefined, 'GET')
  assert.equal(bearerState.body.config.comfyHasAuthToken, true)
  assert.equal(first.comfyRequests.at(-1).headers.authorization, 'Bearer comfy-fixture-token')

  await first.request('config', { config: {
    comfyAuthMode: 'basic', comfyAuthUser: 'comfy-fixture-user', comfyAuthPass: 'comfy-fixture-pass',
  } })
  first.dispose()

  const restarted = await fixture.boot()
  const freshState = await restarted.request('state', undefined, 'GET')
  assert.equal(freshState.body.config.comfyHasAuthToken, true)
  assert.equal(freshState.body.config.comfyHasAuthPass, true)
  assert.equal(freshState.body.config.comfyAuthUser, 'comfy-fixture-user')
  assert.equal(restarted.comfyRequests.at(-1).headers.authorization, 'Basic ' + Buffer.from('comfy-fixture-user:comfy-fixture-pass').toString('base64'))
  assert.equal(JSON.stringify(freshState.body).includes('comfy-fixture-pass'), false)

  const cleared = await restarted.request('config', { config: { clearComfyAuthToken: true, clearComfyAuthPass: true } })
  assert.equal(cleared.body.state.config.comfyHasAuthToken, false)
  assert.equal(cleared.body.state.config.comfyHasAuthPass, false)
  const afterClear = JSON.parse(await readFile(join(fixture.root, 'config.json'), 'utf8'))
  assert.equal(afterClear.comfyAuthToken, '')
  assert.equal(afterClear.comfyAuthPass, '')
})

async function capturePlannerOptions(resolveModelInfo, effort = 'high') {
  let received
  const llm = {
    resolveModelInfo,
    stream(options) {
      received = options
      return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
    },
  }
  await runPlanner(llm, {
    provider: 'test-provider', model: 'test-model', system: '', text: 'test', reasoningEffort: effort,
  })
  return received
}

test('planner resolves exact-model capabilities and forwards supported low effort using the DSH field', async () => {
  let resolved
  const options = await capturePlannerOptions(async (provider, model) => {
    resolved = [provider, model]
    return { reasoning: { efforts: [{ id: 'low' }] } }
  }, 'low')
  assert.deepEqual(resolved, ['test-provider', 'test-model'])
  assert.equal(options.reasoningEffort, 'low')
})

test('planner leaves effort at DSH default when the model does not support it or cannot be checked', async () => {
  const unsupported = await capturePlannerOptions(async () => ({ reasoning: { efforts: [{ id: 'low' }] } }))
  assert.equal(Object.hasOwn(unsupported, 'reasoningEffort'), false)

  const uncheckable = await capturePlannerOptions(undefined)
  assert.equal(Object.hasOwn(uncheckable, 'reasoningEffort'), false)
})
