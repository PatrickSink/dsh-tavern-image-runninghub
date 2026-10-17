import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

const source = fileURLToPath(new URL('..', import.meta.url))

async function fixture(t, entries = [], definitions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-test-'))
  await mkdir(join(root, 'workflows'))
  await cp(join(source, 'lib'), join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'worldbook.json'), JSON.stringify({ name: 'Test', entries }))
  await writeFile(join(root, 'definitions.json'), JSON.stringify(definitions))
  const routes = new Map(), disposes = [], calls = []
  // 规划现在走 tavern.runTask（一次性后台 Agent）。测试里把 runTask 桥到同一个 stream mock，
  // 并保持 prompt → args.system 的语义对应（用例正是从 calls 里读 system 检查世界书注入）。
  const streamMock = async function* (args) {
    calls.push(args)
    yield { type: 'text-delta', text: '<decision>skip</decision><reason>Only testing context</reason>' }
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    llm: { stream: streamMock },
    tavern: {
      apiVersion: 2,
      async attach() { return { id: 'media-mock' } },
      promptSection() { return () => {} },
      onTurnSettled() { return () => {} },
      onTimelineChanged() { return () => {} },
      onGameRemoved() { return () => {} },
      async list() { return [] },
      async getTurn() { return null },
      async readTurnData() { return null },
      async runTask({ prompt }) {
        let text = ''
        for await (const chunk of streamMock({ system: prompt, text: '' })) {
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        }
        return { text }
      },
    },
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
    inject(names, install) { if (names.every(name => this[name])) install(this) },
    effect(install) { const off = install(); if (typeof off === 'function') disposes.push(off); return off },
  }
  const { apply } = await import(pathToFileURL(join(root, 'lib/index.js')).href)
  apply(ctx, {
    plannerProvider: 'mock', plannerModel: 'mock', imageBackend: 'openai', activeImageChannel: 'test',
    imageChannels: [{ id: 'test', provider: 'openai', name: 'test', baseUrl: 'http://unused.test', model: 'image-model', apiKey: '' }],
  })
  t.after(async () => {
    for (const dispose of disposes.reverse()) dispose()
    await delay(45)
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'))
    assert.ok(basename(root).startsWith('dsh-context-test-'))
    await rm(root, { recursive: true, force: true })
  })
  const request = (action, body, method = 'POST') => new Promise((done, reject) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: '/plugins/dsh-tavern-image/' + action, headers: { host: 'localhost', 'content-type': 'application/json' } })
    const response = {
      writeHead(status) { this.status = status },
      end(value) { try { done({ status: this.status, body: JSON.parse(String(value)) }) } catch (error) { reject(error) } },
    }
    routes.get(req.url)(req, response)
  })
  return { root, calls, request }
}

test('worldbook activation survives import, partial edits, export, and later planning', async t => {
  const f = await fixture(t)
  const imported = await f.request('worldbook-import', { worldbook: { name: 'Rules', entries: [
    { comment: 'Core', content: 'CORE_RULE', enabled: true },
    { comment: 'Shop', content: 'SHOP_RULE', activation: 'keywords', keywords: ['药铺'], backends: ['openai'] },
    { comment: 'Comfy', content: 'COMFY_ONLY', backends: ['comfyui'] },
  ] } })
  assert.equal(imported.body.ok, true)
  assert.equal((await f.request('worldbook-entry', { index: 1, patch: { comment: 'New shop title' } })).body.ok, true)
  const exported = (await f.request('worldbook-export', undefined, 'GET')).body.worldbook
  assert.equal(exported.entries[0].activation, 'always')
  assert.deepEqual(exported.entries[1].keywords, ['药铺'])
  assert.deepEqual(exported.entries[1].backends, ['openai'])
  assert.equal(exported.entries[1].activation, 'keywords')
  await f.request('plan', { text: '他们走进药铺。', messageId: 'shop', manual: true })
  assert.match(f.calls[0].system, /CORE_RULE/)
  assert.match(f.calls[0].system, /SHOP_RULE/)
  assert.doesNotMatch(f.calls[0].system, /COMFY_ONLY/)
  await f.request('plan', { text: '他们走进树林。', messageId: 'forest', manual: true })
  assert.doesNotMatch(f.calls[1].system, /SHOP_RULE/)
  const state = (await f.request('state', undefined, 'GET')).body
  assert.ok(state.plannerContext)
  assert.equal(state.plannerContext.includedEntries.length, 1)
  assert.equal(state.plannerContext.omittedEntries.length, 2)
})

test('parallel edits preserve activation, keywords, and content; invalid conditions leave stored data intact', async t => {
  const f = await fixture(t, [{ comment: 'Rule', content: 'original' }])
  const results = await Promise.all([
    f.request('worldbook-entry', { index: 0, patch: { activation: 'keywords', keywords: ['药铺'] } }),
    f.request('worldbook-entry', { index: 0, patch: { content: 'edited' } }),
  ])
  assert.ok(results.every(result => result.body.ok))
  const before = await readFile(join(f.root, 'worldbook.json'), 'utf8')
  const entry = JSON.parse(before).entries[0]
  assert.equal(entry.content, 'edited')
  assert.equal(entry.activation, 'keywords')
  assert.deepEqual(entry.keywords, ['药铺'])
  const invalid = await f.request('worldbook-entry', { index: 0, patch: { backends: ['unknown-provider'] } })
  assert.equal(invalid.status, 400)
  assert.equal(await readFile(join(f.root, 'worldbook.json'), 'utf8'), before)
})

test('legacy rules remain always injected and plain-text worldbooks can still be imported', async t => {
  const f = await fixture(t, [{ comment: 'Old', content: 'LEGACY_RULE' }, { comment: 'Disabled', content: 'DISABLED_RULE', enabled: false }])
  await f.request('plan', { text: '任何正文。', manual: true })
  assert.match(f.calls[0].system, /LEGACY_RULE/)
  assert.doesNotMatch(f.calls[0].system, /DISABLED_RULE/)
  assert.equal((await f.request('worldbook-import', { worldbook: 'First rule\n\nSecond rule' })).body.count, 2)
  const after = (await f.request('worldbook-export', undefined, 'GET')).body.worldbook
  assert.ok(after.entries.every(entry => entry.activation === 'always'))
})

test('backend planning uses one DSH model call per round and reports character counts without exposing prompts', async t => {
  const f = await fixture(t, [{ comment: 'Core', content: 'CORE_STABLE' }], { characters: [
    { id: 'a', name: '韩月梅', traits: { face: 'blue eyes' } },
    { id: 'b', name: '秦雨薇', traits: { face: 'green eyes' } },
  ] })
  await f.request('plan', { text: '韩月梅来到院子里。', messageId: 'one', count: 1, manual: true })
  await f.request('plan', { text: '秦雨薇来到药铺里。', messageId: 'two', count: 3, manual: true })
  assert.equal(f.calls.length, 2)
  const [one, two] = f.calls.map(call => call.system)
  const marker = '\n\n<本轮上下文>\n'
  assert.ok(one.includes(marker), 'stable prefix should be explicitly separated from the turn context')
  assert.equal(one.split(marker)[0], two.split(marker)[0])
  assert.match(one, /blue eyes/)
  assert.doesNotMatch(one, /green eyes/)
  assert.match(two, /green eyes/)
  assert.doesNotMatch(two, /blue eyes/)
  const state = (await f.request('state', undefined, 'GET')).body
  assert.ok(state.plannerContext.staticChars > 0)
  assert.ok(state.plannerContext.dynamicChars > 0)
  assert.equal(state.plannerContext.bodyChars, '秦雨薇来到药铺里。'.length)
  assert.equal(state.plannerContext.includedCharacters.length, 1)
  assert.equal(JSON.stringify(state.plannerContext).includes('green eyes'), false)
})
