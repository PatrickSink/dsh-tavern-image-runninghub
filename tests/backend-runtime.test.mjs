import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const source = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const PNG = require('../lib/vendor/pngjs/lib/png.js').PNG
const block = (tag, anchor = tag) => `<image><regex>${anchor}</regex><title>画面</title><prompts>${tag}</prompts></image>`
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function untilRuntime(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await delay(5) }
  assert.fail('runtime condition timed out')
}

// Load the actual host implementation in an isolated plugin directory so routes,
// persistence and workflow compilation run without changing installed user data.
async function runtime(t, stream, definitions = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-comfy-test-'))
  await mkdir(join(root, 'lib')); await mkdir(join(root, 'workflows'))
  await cp(join(source, 'lib'), join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'worldbook.json'), JSON.stringify({ name: 'test', entries: [] }))
  await writeFile(join(root, 'definitions.json'), JSON.stringify(definitions))
  if (options.initialJobs) await writeFile(join(root, 'jobs-store.json'), JSON.stringify(options.initialJobs))
  await writeFile(join(root, 'workflows', 'test.json'), JSON.stringify({
    format: 'dsh-tavern-comfy-v1', outputNode: '2',
    prompt: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } },
    bindings: { positive: [{ node: '1', input: 'text' }] },
  }))
  const routes = new Map(), disposes = [], events = [], submitted = []
  const firstPrompt = deferred()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(input)
    if (options.objectInfo && url.pathname === '/object_info') return new Response(JSON.stringify(options.objectInfo))
    if (options.fetch && (url.hostname === 'image.test' || options.fetchHosts?.includes(url.hostname))) return options.fetch(input, init)
    if (url.pathname === '/prompt') {
      const prompt = JSON.parse(init.body).prompt
      submitted.push(prompt['1'].inputs.text)
      events.push('submit:' + submitted.length); firstPrompt.resolve()
      if (options.comfyPrompt) await options.comfyPrompt(prompt, { events, submitted })
      return new Response(JSON.stringify({ prompt_id: 'comfy-' + submitted.length }), { status: 200 })
    }
    return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), { status: 200 })
  }
  const logger = { info() {}, warn() {}, error() {} }
  // 生图规划现在走 tavern.runTask（一次性后台 Agent），不再直连 llm。
  // 这里准备一个可用的 tavern：用例自带 options.tavern 时**沿用同一引用**并补上 runTask
  // （不能新建对象 —— 用例会把 bridgeReady 写在 this 上，换引用就再也读不到）；
  // 没自带时给一份最小实现，只够让 bridge 装载检查通过。
  const tavernMock = options.tavern || {
    apiVersion: 2,
    async attach() { return { id: 'media-mock' } },
    promptSection() { return () => {} },
    onTurnSettled() { return () => {} },
    onTimelineChanged() { return () => {} },
    onGameRemoved() { return () => {} },
    async list() { return [] },
    async getTurn() { return null },
    async readTurnData() { return null },
  }
  if (typeof tavernMock.runTask !== 'function') {
    // 把 runTask 桥到既有的 stream mock：把整个生成器收完，拼成 agent 的最终文本。
    // 注意：runTask 的 prompt 在旧的直连路径里对应 runPlanner 的 system，
    // 用例的 stream mock 读的是 args.system，这里按同一语义传。
    tavernMock.runTask = async ({ prompt }) => {
      let text = ''
      for await (const chunk of stream({ system: prompt, text: '', provider: 'mock', model: 'mock' }, { events, submitted, firstPrompt })) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
      return { text }
    }
  }
  const ctx = {
    logger,
    llm: { stream: args => stream(args, { events, submitted, firstPrompt }) },
    // 生图规划现在走 tavern.runTask（一次性后台 Agent），不再直连 llm。
    // 测试里把 runTask 桥到既有的 stream mock：把整个生成器收完，拼成 agent 的最终文本。
    // options.tavern 传进来时覆盖这里的默认实现（用于测 bridge 相关行为）。
    ...(tavernMock ? { tavern: tavernMock } : {}),
    ...(options.attachments ? { attachments: options.attachments } : {}),
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
    inject(names, install) { if (names.every(name => this[name])) install(this) },
    effect(install) { const off = install(); if (typeof off === 'function') disposes.push(off); return off },
  }
  const { apply, name } = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  apply(ctx, { plannerProvider: 'mock', plannerModel: 'mock', plannerCount: 2, ...options.config })
  if (options.tavern) {
    for (let i = 0; i < 100 && !options.tavern.bridgeReady; i++) await delay(5)
    assert.equal(options.tavern.bridgeReady, true, 'Tavern bridge should register through the official API')
  }
  const disposePlugin = () => { for (const dispose of disposes.splice(0).reverse()) dispose() }
  t.after(async () => {
    disposePlugin()
    globalThis.fetch = originalFetch
    // Pending atomic saves finish before removing this verified temporary fixture.
    await delay(40)
    assert.equal(resolve(root).startsWith(resolve(tmpdir())), true)
    assert.ok(basename(root).startsWith('dsh-comfy-test-'))
    await rm(root, { recursive: true, force: true })
  })
  function request(path, body, method = 'POST', headers = {}, basePath = '/plugins/dsh-tavern-image') {
    return new Promise((resolve, reject) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
      Object.assign(req, { method, url: basePath + '/' + path, headers: { host: 'localhost', 'content-type': 'application/json', ...headers } })
      const response = {
        headersSent: false,
        writeHead(status) { this.status = status; this.headersSent = true },
        end(body) { try { resolve({ status: this.status, body: JSON.parse(String(body)) }) } catch (error) { reject(error) } },
      }
      routes.get(req.url.split('?')[0])(req, response)
    })
  }
  return { request, events, submitted, firstPrompt, root, pluginName: name, disposePlugin }
}

test('外挂规划走 tavern.runTask：一次性返回，完整块按 count 上限提交、多余块丢弃', async t => {
  // 规划已从「直连 llm 流式」改为「tavern.runTask 一次性后台 Agent」。
  // 随之取消的是「流还在开时就提前提交第一张」——runTask 非流式，提交统一在解析之后。
  // 这里验证新行为：完整块才提交、超出 count 的块丢弃、不产生重复作业。
  const f = await runtime(t, async function* () {
    yield { type: 'text-delta', text: block('first', 'first') + block('second') + block('third') }
  })
  const result = await f.request('plan', { text: 'first second', messageId: 'message-1', sessionId: 'game', count: 2, manual: true })
  assert.equal(result.status, 200)
  assert.equal(result.body.plans.length, 2, 'count=2，第三个块应被丢弃')
  assert.deepEqual(f.submitted, ['first', 'second'])
  await delay(25)
  const jobs = Object.values(JSON.parse(await readFile(join(f.root, 'jobs-store.json'), 'utf8')))
  assert.equal(jobs.length, 2)
  assert.ok(jobs.every(job => job.workflowId === 'test' && job.outputNode === '2' && job.comfyId?.startsWith('comfy-')))
})

test('new API paths are canonical while old paths remain available for existing clients', async t => {
  const f = await runtime(t, async function* () {})
  const current = await f.request('state', undefined, 'GET')
  const legacy = await f.request('state', undefined, 'GET', {}, '/plugins/dsh-tavern-comfy')
  assert.equal(f.pluginName, 'dsh-tavern-image')
  assert.equal(current.status, 200)
  assert.equal(legacy.status, 200)
})


test('manual generation of the same prompt starts a fresh job instead of reusing the previous image', async t => {
  const f = await runtime(t, async function* () {
    yield { type: 'text-delta', text: block('same prompt', '正文') }
  })
  const input = { text: '正文', messageId: 'manual-redraw', manual: true }
  const first = await f.request('plan', input)
  const second = await f.request('plan', input)
  assert.equal(first.body.error, null)
  assert.equal(second.body.error, null)
  assert.notEqual(first.body.plans[0].jobId, second.body.plans[0].jobId)
  assert.deepEqual(f.submitted, ['same prompt', 'same prompt'])
})

test('empty or incomplete output reports a retryable planning error with no GPU submission', async t => {
  const f = await runtime(t, async function* () { yield { type: 'text-delta', text: '<image><prompts>unfinished' } })
  const result = await f.request('plan', { text: '正文', manual: true })
  assert.equal(result.body.plans.length, 0)
  assert.match(result.body.error, /image/)
  assert.equal(f.submitted.length, 0)
})

test('attach-turn 两轮都正常挂图；人物外貌档案不再由插件写入', async t => {
  // 插件原先会把 <character_updates> 合并进自己的外貌快照，供下一轮复用。
  // 现在这套已移除：人物外貌由 Agent 自己读 / 写 Tavern 的设计人物档案。
  // 这里验证剩下的职责边界 —— 每轮都能规划并挂上图，且插件**不碰**人物库文件。
  const state = {
    current: { gameId: 'story-game', turn: 1, textVersion: 'text-v1', text: 'Luna cut her hair permanently.', card: { id: 'card-1', name: 'Luna card' } },
    snapshots: [], media: [], systems: [], imageRequests: [],
  }
  let timeline
  const tavern = {
    apiVersion: 2,
    promptSection() { return () => {} },
    onTurnSettled() { this.bridgeReady = true; return () => {} },
    onTimelineChanged(handler) { timeline = handler; return () => {} },
    onGameRemoved() { return () => {} },
    async getTurn({ turn }) { return state.current.turn === turn ? state.current : null },
    // 人物白描走 Tavern 的专用接口（源码注释写明它是「正文与图片共用的那一份档案」）。
    // 早先试过从 getCardContext().lore 里解析，实测 lore 里根本没有人物设计条目。
    async getCharacterDesigns() {
      return {
        revision: 1, updatedAt: Date.now(),
        characters: [{
          name: 'Luna', aliases: [], identity: 'knight', narrativeRole: '', updatedAt: Date.now(),
          sections: [
            { key: 'identity', label: '身份', text: 'knight' },
            { key: 'appearance', label: '外貌', text: 'silver hair, blue eyes, tall' },
          ],
        }],
      }
    },
    async list() { return state.media },
    async readTurnData() { return state.snapshots.at(-1) ?? null },
    async saveTurnData({ turn, textVersion, data }) {
      state.snapshots = state.snapshots.filter(item => item.turn !== turn)
      state.snapshots.push({ turn, textVersion, data })
    },
    async attach({ item, textVersion }) {
      const media = { ...item, id: 'media-' + state.media.length, textVersion }
      state.media.push(media); return { id: media.id }
    },
    async update(id, changes) { Object.assign(state.media.find(item => item.id === id), changes) },
    async remove(id) { state.media = state.media.filter(item => item.id !== id) },
  }
  const original = { id: 'role-1', name: 'Luna', match: 'luna', traits: { face: 'black hair, blue eyes' } }
  const f = await runtime(t, async function* (args) {
    state.systems.push(args.system)
    yield { type: 'text-delta', text: '<decision>draw</decision><reason>新的外观变化</reason>' + block('Luna by the window', 'Luna') }
  }, { characters: [original] }, {
    tavern,
    attachments: { async saveImage({ data }) { return { id: 'attachment-' + data.byteLength } } },
    config: {
      imageBackend: 'openai', activeImageChannel: 'primary',
      imageChannels: [{ id: 'primary', provider: 'openai', name: 'Image test', baseUrl: 'https://image.test/v1', model: 'image-model', apiKey: 'test-key', options: {} }],
    },
    fetch: async (url, init) => {
      state.imageRequests.push(JSON.parse(init.body))
      return Response.json({ data: [{ b64_json: png }] })
    },
  })

  const first = await f.request('attach-turn', { gameId: 'story-game', turn: 1 })
  assert.equal(first.body.ok, true)
  assert.equal(first.body.attached, 1)
  // 人物外貌由插件从本局世界书的「设计人物」条目注入（Agent 读不到档案：
  // character_design_read 的调用权限只开放给人物设计任务，插件任务调用会被拒）。
  assert.match(state.systems[0], /<可用绘图角色列表>/, '设计人物档案应由插件注入')
  assert.match(state.systems[0], /silver hair/, '注入的应是设计人物档案里的外貌')
  assert.match(state.systems[0], /worldbook_search/, '应指示用真正可用的工具补查人物')
  assert.doesNotMatch(state.systems[0], /character_design_read/, '该工具在插件任务里不可用，不应出现在指示里')

  state.current = { ...state.current, turn: 2, textVersion: 'text-v2', text: 'Luna looks at the window.' }
  const second = await f.request('attach-turn', { gameId: 'story-game', turn: 2 })
  assert.equal(second.body.ok, true)
  assert.equal(state.systems.length, 2, '每轮各规划一次')
  assert.match(state.imageRequests[1].prompt, /Luna/)

  // 插件不再写人物库（设计人物档案由 Tavern 与 Agent 负责）
  assert.equal(JSON.parse(await readFile(join(f.root, 'definitions.json'), 'utf8')).characters[0].traits.face, 'black hair, blue eyes')
})


test('attach-turn waits for official getTurn data and coalesces with settled auto planning', async t => {
  const turn = { gameId: 'wait-auto', turn: 1, textVersion: 'wait-v1', text: 'A complete settled scene.' }
  let available = false, settled, plannerCalls = 0, paidCalls = 0
  const media = []
  const tavern = {
    apiVersion: 2, promptSection() { return () => {} },
    onTurnSettled(handler) { settled = handler; this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} },
    async getTurn() { return available ? turn : null }, async list() { return media },
    async readTurnData() { return null }, async saveTurnData() {},
    async attach({ item, textVersion }) { const row = { ...item, id: 'media-' + media.length, textVersion }; media.push(row); return { id: row.id } },
    async update(id, patch) { Object.assign(media.find(item => item.id === id), patch) },
    async remove(id) { const index = media.findIndex(item => item.id === id); if (index >= 0) media.splice(index, 1) },
  }
  const f = await runtime(t, async function* (args) {
    // 档案维护现在是一次独立的 runTask 调用（也走这个 stream mock），
    // 它不带 <image> 块。只数真正的生图规划调用，否则会被档案那一次干扰。
    const isSceneState = /角色状态记录员/.test(String(args?.system || ''))
    if (!isSceneState) plannerCalls++
    yield { type: 'text-delta', text: block('settled scene') }
  }, {}, {
    tavern, attachments: { async saveImage() { return { id: 'attachment' } } },
    config: { ...imageConfig, autoImageGen: true, smartImageSelection: false, characterAutoUpdate: false },
    fetch: async () => { paidCalls++; return Response.json({ data: [{ b64_json: png }] }) },
  })
  const manualRequest = f.request('attach-turn', { gameId: turn.gameId, turn: turn.turn })
  const duplicateRequest = f.request('attach-turn', { gameId: turn.gameId, turn: turn.turn })
  await delay(40)
  available = true
  settled(turn)
  const [result, duplicateResult] = await Promise.all([manualRequest, duplicateRequest])
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(duplicateResult.body.ok, true)
  await untilRuntime(() => media.some(item => item.status === 'ready'))
  assert.equal(plannerCalls, 1, 'the waiting button joins the auto plan for this exact version')
  assert.equal(paidCalls, 1, 'the same version is submitted only once')
  assert.equal(media.length, 1)
})

test('attach-turn waiting remains a manual draw when automatic planning is disabled', async t => {
  const turn = { gameId: 'wait-manual', turn: 1, textVersion: 'manual-v1', text: 'A complete scene.' }
  let available = false, plannerCalls = 0, paidCalls = 0
  const media = []
  const tavern = {
    apiVersion: 2, promptSection() { return () => {} },
    onTurnSettled(handler) { this.settled = handler; this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} },
    async getTurn() { return available ? turn : null }, async list() { return media },
    async readTurnData() { return null }, async saveTurnData() {},
    async attach({ item, textVersion }) { const row = { ...item, id: 'media-' + media.length, textVersion }; media.push(row); return { id: row.id } },
    async update(id, patch) { Object.assign(media.find(item => item.id === id), patch) },
    async remove(id) { const index = media.findIndex(item => item.id === id); if (index >= 0) media.splice(index, 1) },
  }
  const f = await runtime(t, async function* () {
    plannerCalls++
    yield { type: 'text-delta', text: '<decision>draw</decision><reason>manual redraw</reason>' + block('manual settled scene', turn.text) }
  }, {}, {
    tavern, attachments: { async saveImage() { return { id: 'attachment' } } },
    config: { ...imageConfig, autoImageGen: false, plannerEnabled: false, characterAutoUpdate: false },
    fetch: async () => { paidCalls++; return Response.json({ data: [{ b64_json: png }] }) },
  })
  const manualRequest = f.request('attach-turn', { gameId: turn.gameId, turn: turn.turn })
  await delay(50)
  available = true
  const result = await manualRequest
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.attached, 1, JSON.stringify(result.body))
  assert.equal(plannerCalls, 1, 'manual mode still invokes the planner when history-only mode is configured')
  await untilRuntime(() => paidCalls === 1)
  assert.equal(media.length, 1)
})

test('disposing the plugin aborts a pending official getTurn wait', async t => {
  let getTurnCalls = 0
  const tavern = {
    apiVersion: 2, promptSection() { return () => {} },
    onTurnSettled() { this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} },
    async getTurn() { getTurnCalls++; return null }, async list() { return [] },
    async attach() { throw new Error('unavailable turn must never attach') },
    async readTurnData() { return null }, async saveTurnData() {},
  }
  const f = await runtime(t, async function* () {}, {}, { tavern, attachments: { async saveImage() { return { id: 'unused' } } } })
  const pending = f.request('attach-turn', { gameId: 'dispose-wait', turn: 1 })
  await untilRuntime(() => getTurnCalls > 0)
  await delay(20)
  f.disposePlugin()
  const result = await pending
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.attached, 0)
  assert.match(result.body.error, /插件已卸载/)
  assert.equal(getTurnCalls, 1, 'abort prevents later polling calls')
})



test('外挂规划下协议校验仍生效：decision 出现两次则整轮不提交', async t => {
  // 流式时代靠「看到第二个 <decision> 开头就判冲突」来拦截；runTask 非流式后没有这种
  // 中途观测，校验改为看**闭合块**的成对情况。这里用两个都闭合的 decision 触发它，
  // 确认无效输出仍然一张都不提交（这是新机制下等价的安全网）。
  const turn = { gameId: 'smart-dup-decision', turn: 1, textVersion: 'v1', text: 'first second' }, media = []
  let settled
  const tavern = { apiVersion: 2, promptSection() { return () => {} }, onTurnSettled(handler) { settled = handler; this.bridgeReady = true; return () => {} }, onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} }, async getTurn() { return turn }, async list() { return media }, async readTurnData() { return null }, async saveTurnData() {}, async attach({ item }) { media.push(item); return { id: item.jobId } }, async update() {}, async remove() {} }
  const f = await runtime(t, async function* () {
    yield { type: 'text-delta', text: '<decision>draw</decision><reason>two distinct views</reason><decision>draw</decision><reason>again</reason>' + block('first view', 'first') + block('second view', 'second') }
  }, {}, { tavern, attachments: { async saveImage() { return { id: 'unused' } } }, config: { ...imageConfig, autoImageGen: true, smartImageSelection: true, characterAutoUpdate: false },
    fetch: async () => Response.json({ data: [{ b64_json: png }] }) })
  settled(turn)
  await delay(200)
  assert.equal((await f.request('history', undefined, 'GET')).body.jobs.length, 0, 'decision 重复=无效输出，一张都不提交')
  assert.equal(media.length, 0)
})

test('smart skip submits nothing and same-chunk duplicate decisions reject before payment', async t => {
  let paid = 0
  const fixture = async (text, stream, name) => {
    const turn = { gameId: name, turn: 1, textVersion: '1', text }, media = []
    const tavern = { apiVersion: 2, promptSection() { return () => {} }, onTurnSettled(handler) { this.settled = handler; this.bridgeReady = true; return () => {} }, onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} }, async getTurn() { return turn }, async list() { return media }, async readTurnData() { return null }, async saveTurnData() {}, async attach({ item }) { media.push(item); return { id: item.jobId } }, async update() {}, async remove() {} }
    const f = await runtime(t, stream, {}, { tavern, attachments: { async saveImage() { return { id: 'unused' } } }, config: { ...imageConfig, autoImageGen: true, smartImageSelection: true, characterAutoUpdate: false }, fetch: async () => { paid++; return Response.json({ data: [{ b64_json: png }] }) } })
    tavern.settled(turn)
    await delay(100)
    return { f, media }
  }
  const { media: skipMedia } = await fixture('静态场景', async function* () {
    yield { type: 'text-delta', text: '<decision>skip</decision><reason>静态场景</reason>' }
  }, 'skip')
  assert.equal(paid, 0)
  assert.equal(skipMedia.length, 0)
  const { f: conflict, media: conflictMedia } = await fixture('冲突测试', async function* () {
    yield { type: 'text-delta', text: '<decision>draw</decision><reason>冲突测试</reason><decision>skip</decision>' + block('冲突') }
  }, 'conflict')
  assert.equal(paid, 0)
  assert.equal(conflictMedia.length, 0)
  assert.equal((await conflict.request('history', undefined, 'GET')).body.jobs.length, 0)
})

test('smart final-only output rejects images before decision/reason or story updates', async t => {
  let paid = 0
  for (const [name, output] of [
    ['image-before-decision', block('too early') + '<decision>draw</decision><reason>later</reason>'],
    ['image-before-reason', '<decision>draw</decision>' + block('too early') + '<reason>later</reason>'],
    ['image-before-story', '<decision>draw</decision><reason>later</reason>' + block('too early') + '<character_updates>[]</character_updates>'],
  ]) {
    const turn = { gameId: name, turn: 1, textVersion: 'v1', text: 'a visual moment' }, media = []
    const tavern = {
      apiVersion: 2, promptSection() { return () => {} }, onTurnSettled(handler) { this.settled = handler; this.bridgeReady = true; return () => {} },
      onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} }, async getTurn() { return turn }, async list() { return media },
      async readTurnData() { return null }, async saveTurnData() {}, async attach({ item }) { media.push(item); return { id: item.jobId } }, async update() {}, async remove() {},
    }
    const f = await runtime(t, async function* () { yield { type: 'text-delta', text: output } }, {}, {
      tavern, attachments: { async saveImage() { return { id: 'unused' } } },
      config: { ...imageConfig, autoImageGen: true, smartImageSelection: true, characterAutoUpdate: name === 'image-before-story' },
      fetch: async () => { paid++; return Response.json({ data: [{ b64_json: png }] }) },
    })
    tavern.settled(turn)
    await delay(80)
    assert.equal((await f.request('history', undefined, 'GET')).body.jobs.length, 0, name)
    assert.equal(media.length, 0, name)
  }
  assert.equal(paid, 0)
})

test('smart streaming does not submit images nested in reason or preceding character updates', async t => {
  let paid = 0
  const outputs = [
    '<decision>draw</decision><reason>explain ' + block('nested') + ' end</reason>' + block('after'),
    '<decision>draw</decision><reason>reason</reason><character_updates>[]</character_updates>' + block('after'),
  ]
  for (let index = 0; index < outputs.length; index++) {
    const turn = { gameId: 'stream-order-' + index, turn: 1, textVersion: 'v1', text: 'a visual moment' }, media = []
    const tavern = { apiVersion: 2, promptSection() { return () => {} }, onTurnSettled(handler) { this.settled = handler; this.bridgeReady = true; return () => {} }, onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} }, async getTurn() { return turn }, async list() { return media }, async readTurnData() { return null }, async saveTurnData() {}, async attach({ item }) { media.push(item); return { id: item.jobId } }, async update() {}, async remove() {} }
    const f = await runtime(t, async function* () { yield { type: 'text-delta', text: outputs[index] } }, {}, {
      tavern, attachments: { async saveImage() { return { id: 'unused' } } },
      config: { ...imageConfig, autoImageGen: true, smartImageSelection: true, characterAutoUpdate: true },
      fetch: async () => { paid++; return Response.json({ data: [{ b64_json: png }] }) },
    })
    tavern.settled(turn)
    await delay(90)
    assert.equal((await f.request('history', undefined, 'GET')).body.jobs.length, 0)
    assert.equal(media.length, 0)
  }
  assert.equal(paid, 0)
})

test('smart normalized duplicate prompts on different anchors are submitted once', async t => {
  let paid = 0
  const turn = { gameId: 'duplicate', turn: 1, textVersion: '1', text: 'first second' }, media = []
  const tavern = { apiVersion: 2, promptSection() { return () => {} }, onTurnSettled(handler) { this.settled = handler; this.bridgeReady = true; return () => {} }, onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} }, async getTurn() { return turn }, async list() { return media }, async readTurnData() { return null }, async saveTurnData() {}, async attach({ item }) { media.push(item); return { id: item.jobId } }, async update() {}, async remove() {} }
  const f = await runtime(t, async function* () {
    yield { type: 'text-delta', text: '<decision>draw</decision><reason>戏剧场景</reason>' + block('same,   prompt', 'first') + block('SAME, prompt', 'second') }
  }, {}, { tavern, attachments: { async saveImage() { return { id: 'unused' } } }, config: { ...imageConfig, autoImageGen: true, smartImageSelection: true, characterAutoUpdate: false }, fetch: async () => { paid++; return Response.json({ data: [{ b64_json: png }] }) } })
  tavern.settled(turn)
  await delay(100)
  assert.equal(paid, 1)
  assert.equal(media.length, 1)
})

test('history-only mode ignores accidental image blocks without paid jobs', async t => {
  const turn = { gameId: 'history-only', turn: 1, textVersion: 'v1', text: 'a visual moment' }, media = []
  const tavern = { apiVersion: 2, promptSection() { return () => {} }, onTurnSettled(handler) { this.settled = handler; this.bridgeReady = true; return () => {} }, onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} }, async getTurn() { return turn }, async list() { return media }, async readTurnData() { return null }, async saveTurnData() {}, async attach({ item }) { media.push(item); return { id: item.jobId } }, async update() {}, async remove() {} }
  let paid = 0
  const f = await runtime(t, async function* () {
    yield { type: 'text-delta', text: '<decision>draw</decision><reason>误输出</reason><image><regex>a visual moment</regex><prompts>accidental image</prompts></image>' }
  }, {}, { tavern, attachments: { async saveImage() { return { id: 'unused' } } }, config: { ...imageConfig, plannerEnabled: false, characterAutoUpdate: true }, fetch: async () => { paid++; return Response.json({ data: [{ b64_json: png }] }) } })
  tavern.settled(turn)
  await delay(120)
  assert.equal(paid, 0)
  assert.equal(media.length, 0)
  assert.equal((await f.request('history', undefined, 'GET')).body.jobs.length, 0)
})

test('definitions route preserves omitted clothing/settings/props and retains explicit empty-characters protection', async t => {
  const definitions = {
    characters: [{ id: 'person', name: '旧名字', traits: { face: 'brown hair' } }],
    outfits: [{ id: 'outfit', name: '旧服装', full: 'dress' }],
    settings: [{ id: 'setting', name: '场景', layout: 'room' }],
    props: [{ id: 'prop', name: '道具', appearance: 'book' }],
  }
  const f = await runtime(t, async function* () {}, definitions)
  const saved = await f.request('definitions', { definitions: { characters: [{ ...definitions.characters[0], name: '新名字' }] } })
  assert.equal(saved.body.ok, true)
  const onDisk = JSON.parse(await readFile(join(f.root, 'definitions.json'), 'utf8'))
  assert.equal(onDisk.characters[0].name, '新名字')
  assert.equal(onDisk.outfits[0].name, '旧服装')
  assert.equal(onDisk.settings[0].name, '场景')
  assert.equal(onDisk.props[0].name, '道具')
  const refused = await f.request('definitions', { definitions: { characters: [] } })
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.refused, 'would-empty-characters')
})

test('plugin update routes enforce methods and reject cross-origin or non-JSON installation', async t => {
  const f = await runtime(t, async function* () {})
  assert.equal((await f.request('plugin-update', {}, 'POST')).status, 405)
  assert.equal((await f.request('plugin-update/apply', undefined, 'GET')).status, 405)
  assert.equal((await f.request('plugin-update/apply', {}, 'POST', { origin: 'https://example.invalid' })).status, 403)
  assert.equal((await f.request('plugin-update/apply', {}, 'POST', { 'content-type': 'text/plain' })).status, 403)
  const status = await f.request('plugin-update', undefined, 'GET')
  assert.equal(status.status, 200); assert.equal(status.body.supported, false)
  const update = await f.request('plugin-update/apply', { target: 'a'.repeat(40) })
  assert.equal(update.status, 400); assert.match(update.body.error, /先检查更新/)
})

const imageChannel = { id: 'primary', provider: 'openai', name: '测试渠道', baseUrl: 'https://image.test/v1', model: 'gpt-image-1', apiKey: 'fixture-secret', options: {} }
const imageConfig = { imageBackend: 'openai', activeImageChannel: 'primary', imageChannels: [imageChannel], imageConcurrency: 1 }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII='
const pngBytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.from([255, 0, 0, 128, 255, 0, 0, 128, 255, 0, 0, 128, 255, 0, 0, 128]) })

test('planned OpenAI images retain Chinese descriptions through the runtime provider request', async t => {
  const prompt = '小明，站在雨中的街道，柔和光线'
  const sent = []
  const f = await runtime(t, async function* () {
    yield { type: 'text-delta', text: block(prompt, '雨中的街道') }
  }, {}, { config: { ...imageConfig, characterAutoUpdate: false }, fetch: async (_url, init) => {
    sent.push(JSON.parse(init.body).prompt)
    return Response.json({ data: [{ b64_json: png }] })
  } })
  const result = await f.request('plan', { text: '小明站在雨中的街道。', sessionId: 'chinese-platform', manual: true })
  assert.equal(result.body.error, null)
  await untilRuntime(() => sent.length === 1)
  assert.ok(sent[0].includes(prompt), 'Chinese reaches the paid provider without name or scene deletion')
})

test('a Chinese-only Comfy plan fails before any image job or GPU submission', async t => {
  const f = await runtime(t, async function* () {
    yield { type: 'text-delta', text: block('雨中的少女,柔和光线', '街道') }
  }, {}, { config: { characterAutoUpdate: false } })
  const result = await f.request('plan', { text: '少女站在街道上。', sessionId: 'chinese-comfy', manual: true })
  assert.match(result.body.error, /英文提示词/)
  assert.deepEqual(f.submitted, [])
  assert.equal((await f.request('history', undefined, 'GET')).body.jobs.length, 0)
})

test('channel saves preserve omitted credentials, support explicit clearing and never echo secrets', async t => {
  const f = await runtime(t, async function* () {}, {}, { config: imageConfig })
  const initial = await f.request('state', undefined, 'GET')
  const channel = initial.body.config.imageChannels[0]
  assert.equal(channel.hasApiKey, true)
  assert.equal(JSON.stringify(initial.body).includes('fixture-secret'), false)
  const saved = await f.request('config', { imageChannels: [{ ...channel, name: '新渠道名', apiKey: '' }] })
  assert.equal(saved.body.state.config.imageChannels[0].hasApiKey, true)
  assert.equal(JSON.parse(await readFile(join(f.root, 'config.json'), 'utf8')).imageChannels[0].apiKey, 'fixture-secret')
  await f.request('config', { imageChannels: [{ ...channel, clearApiKey: true }] })
  assert.equal(JSON.parse(await readFile(join(f.root, 'config.json'), 'utf8')).imageChannels[0].apiKey, '')
  const invalid = await f.request('config', { imageBackend: 'novelai' })
  assert.equal(invalid.status, 400)
  assert.equal((await f.request('state', undefined, 'GET')).body.config.imageBackend, 'openai')
})

test('prompt preset config rejects unknown active IDs and reserves built-in IDs for built-ins', async t => {
  const f = await runtime(t, async function* () {})
  const saved = await f.request('config', { config: {
    activePromptPreset: 'missing-profile',
    promptPresets: [{ id: 'portrait-editorial', name: '自定义同名 ID', positive: 'my direction' }],
  } })
  assert.equal(saved.status, 200)
  const state = await f.request('state', undefined, 'GET')
  assert.equal(state.body.config.activePromptPreset, '')
  assert.equal(state.body.config.promptPresets[0].id, 'portrait-editorial-1')
  const valid = await f.request('config', { config: { activePromptPreset: 'portrait-editorial-1' } })
  assert.equal(valid.status, 200)
  assert.equal((await f.request('state', undefined, 'GET')).body.config.activePromptPreset, 'portrait-editorial-1')
})

test('external images return jobs immediately, honor concurrency, deduplicate parallel calls and save bytes', async t => {
  const release = deferred(), requests = []
  const f = await runtime(t, async function* () {}, {}, { config: imageConfig, fetch: async (url, init) => {
    requests.push({ url, init })
    await release.promise
    return Response.json({ data: [{ b64_json: png }] })
  } })
  const input = { tag: 'sky', key: 'same-image', size: '1024x1024' }
  const [a, b] = await Promise.all([f.request('jobs', input), f.request('jobs', input)])
  assert.equal(a.body.id, b.body.id)
  assert.equal(a.body.backend, 'openai')
  const second = await f.request('jobs', { ...input, key: 'next-image' })
  await delay(5)
  assert.equal(requests.length, 1, 'second job must stay in the queue')
  assert.equal((await f.request('jobs?id=' + second.body.id, undefined, 'GET')).body.job.state, 'pending')
  release.resolve()
  let history
  for (let i = 0; i < 30; i++) {
    history = (await f.request('history', undefined, 'GET')).body.jobs
    if (history.every(job => job.state === 'done')) break
    await delay(10)
  }
  assert.equal(requests.length, 2)
  assert.equal(history.filter(job => job.state === 'done').length, 2)
  const bytes = await readFile(join(f.root, 'cache', a.body.id + '.img'))
  assert.equal(bytes.toString('base64'), png)
  await delay(20)
  assert.equal((await readFile(join(f.root, 'jobs-store.json'), 'utf8')).includes('fixture-secret'), false)
})

test('ComfyUI connection refusal is retryable and a failed key can submit a fresh job', async t => {
  let promptCalls = 0
  const f = await runtime(t, async function* () {}, {}, {
    config: { comfyUrl: 'http://comfy.test' },
    fetchHosts: ['comfy.test'],
    fetch: async input => {
      const url = new URL(input)
      if (url.pathname === '/prompt') {
        promptCalls++
        if (promptCalls === 1) {
          const error = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
          throw error
        }
        return Response.json({ prompt_id: 'comfy-after-retry' })
      }
      return Response.json({ queue_running: [], queue_pending: [] })
    },
  })
  const input = { tag: 'portrait', key: 'retry-after-refusal' }
  const first = await f.request('jobs', input)
  assert.equal(first.body.status, 'failed')
  assert.equal(first.body.requestMayHaveSucceeded, false)
  assert.match(first.body.error, /fetch failed/)

  const retried = await f.request('jobs', input)
  assert.equal(retried.body.status, 'pending')
  assert.notEqual(retried.body.id, first.body.id)
  assert.equal(promptCalls, 2)
})

test('ComfyUI classifies aggregate connection errors only when every path failed before connect', async t => {
  let promptCalls = 0
  const f = await runtime(t, async function* () {}, {}, {
    config: { comfyUrl: 'http://comfy.test' },
    fetchHosts: ['comfy.test'],
    fetch: async (input, init) => {
      if (new URL(input).pathname !== '/prompt') return Response.json({ queue_running: [], queue_pending: [] })
      promptCalls++
      const cause = promptCalls === 1
        ? new AggregateError(['ECONNREFUSED', 'ENETUNREACH'].map(code => Object.assign(new Error(code), { code })), 'connection attempts failed')
        : promptCalls === 2
          ? new AggregateError(['ECONNREFUSED', 'ECONNRESET'].map(code => Object.assign(new Error(code), { code })), 'connection attempts failed')
          : new AggregateError([Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }), new Error('unknown transport failure')], 'connection attempts failed')
      throw new TypeError('fetch failed', { cause })
    },
  })
  const definitelyNotSent = await f.request('jobs', { tag: 'first', key: 'all-preconnect-errors' })
  assert.equal(definitelyNotSent.body.status, 'failed')
  assert.equal(definitelyNotSent.body.requestMayHaveSucceeded, false)

  const ambiguous = await f.request('jobs', { tag: 'second', key: 'mixed-connect-errors' })
  assert.equal(ambiguous.body.status, 'uncertain')
  assert.equal(ambiguous.body.requestMayHaveSucceeded, true)

  const unknownLeaf = await f.request('jobs', { tag: 'third', key: 'unknown-aggregate-leaf' })
  assert.equal(unknownLeaf.body.status, 'uncertain')
  assert.equal(unknownLeaf.body.requestMayHaveSucceeded, true)
})

test('an ambiguous ComfyUI POST response can be recovered by its persisted client prompt_id without resubmitting', async t => {
  let promptId = ''
  let promptCalls = 0
  const f = await runtime(t, async function* () {}, {}, {
    config: { comfyUrl: 'http://comfy.test' },
    fetchHosts: ['comfy.test'],
    fetch: async (input, init) => {
      const url = new URL(input)
      if (url.pathname === '/prompt') {
        promptCalls++
        promptId = JSON.parse(init.body).prompt_id
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection reset after send'), { code: 'ECONNRESET' }) })
      }
      if (url.pathname === '/history/' + promptId) {
        return Response.json({ [promptId]: { status: { completed: true }, outputs: { '2': { images: [{ filename: 'recovered.png' }] } } } })
      }
      if (url.pathname === '/view') return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } })
      return Response.json({ queue_running: [], queue_pending: [] })
    },
  })
  const started = await f.request('jobs', { tag: 'portrait', key: 'ambiguous-comfy-post' })
  assert.equal(started.body.status, 'uncertain')
  assert.match(started.body.comfyId, /^[0-9a-f-]{36}$/i)
  await delay(50)
  assert.equal(JSON.parse(await readFile(join(f.root, 'jobs-store.json'), 'utf8'))[started.body.id].comfyId, started.body.comfyId)

  const recovered = await f.request('jobs?id=' + started.body.id, undefined, 'GET')
  assert.equal(recovered.body.job.status, 'done')
  assert.equal(recovered.body.job.comfyId, promptId)
  assert.equal(promptCalls, 1)
})

test('an in-flight ComfyUI submission is not marked uncertain by an empty early queue read', async t => {
  const releaseSubmit = deferred()
  let promptId = ''
  const f = await runtime(t, async function* () {}, {}, {
    config: { comfyUrl: 'http://comfy.test' },
    fetchHosts: ['comfy.test'],
    fetch: async (input, init) => {
      const url = new URL(input)
      if (url.pathname === '/prompt') {
        promptId = JSON.parse(init.body).prompt_id
        await releaseSubmit.promise
        return Response.json({ prompt_id: promptId })
      }
      return Response.json({ queue_running: [], queue_pending: [] })
    },
  })
  const pendingRequest = f.request('jobs', { tag: 'portrait', key: 'slow-comfy-submit' })
  await untilRuntime(async () => (await f.request('history', undefined, 'GET')).body.jobs.length === 1)
  const id = (await f.request('history', undefined, 'GET')).body.jobs[0].id
  const duringSubmit = await f.request('jobs?id=' + id, undefined, 'GET')
  assert.equal(duringSubmit.body.job.status, 'pending')
  releaseSubmit.resolve()
  const submitted = await pendingRequest
  assert.equal(submitted.body.status, 'pending')
  assert.equal(submitted.body.comfyId, promptId)
})

test('optional JPEG output converts external channel PNGs before caching and reports matching metadata', async t => {
  const f = await runtime(t, async function* () {}, {}, { config: { ...imageConfig, jpegOutput: true, jpegQuality: 87 }, fetch: async () => new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }), { headers: { 'content-type': 'application/json' } }) })
  const started = await f.request('jobs', { tag: 'sky', key: 'jpeg-output', size: '512x512' })
  for (let i = 0; i < 50; i++) {
    const job = (await f.request('jobs?id=' + started.body.id, undefined, 'GET')).body.job
    if (job.state === 'done') {
      assert.equal(job.mediaType, 'image/jpeg')
      const bytes = await readFile(join(f.root, 'cache', started.body.id + '.img'))
      assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8')
      const metadata = (await f.request('history', undefined, 'GET')).body.jobs.find(item => item.id === started.body.id)
      assert.equal(metadata.byteLength, bytes.length)
      return
    }
    await delay(15)
  }
  assert.fail('external image conversion did not finish')
})

test('optional JPEG output converts ComfyUI /view PNGs and preserves JPEG media metadata', async t => {
  const f = await runtime(t, async function* () {}, {}, {
    config: { imageBackend: 'comfyui', comfyUrl: 'http://image.test', jpegOutput: true },
    fetch: async input => {
      const url = new URL(input)
      if (url.pathname === '/prompt') return Response.json({ prompt_id: 'comfy-jpeg' })
      if (url.pathname === '/history/comfy-jpeg') return Response.json({ 'comfy-jpeg': { status: { completed: true }, outputs: { '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } } })
      if (url.pathname === '/view') return new Response(pngBytes, { headers: { 'content-type': 'image/png' } })
      if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
      throw new Error('unexpected Comfy endpoint ' + url.pathname)
    },
  })
  const started = await f.request('jobs', { tag: 'sky', key: 'comfy-jpeg' })
  for (let i = 0; i < 50; i++) {
    const job = (await f.request('jobs?id=' + started.body.id, undefined, 'GET')).body.job
    if (job.state === 'done') {
      assert.equal(job.mediaType, 'image/jpeg')
      const bytes = await readFile(join(f.root, 'cache', started.body.id + '.img'))
      assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8')
      const metadata = (await f.request('history', undefined, 'GET')).body.jobs.find(item => item.id === started.body.id)
      assert.equal(metadata.byteLength, bytes.length)
      return
    }
    await delay(15)
  }
  assert.fail('Comfy image conversion did not finish')
})

test('cancelling a queued channel job never sends its paid request', async t => {
  const release = deferred(); let calls = 0
  const f = await runtime(t, async function* () {}, {}, { config: imageConfig, fetch: async () => {
    calls++; await release.promise
    return Response.json({ data: [{ b64_json: png }] })
  } })
  await f.request('jobs', { tag: 'one', size: '1024x1024' })
  const queued = await f.request('jobs', { tag: 'two', size: '1024x1024' })
  const cancelled = await f.request('cancel', { id: queued.body.id })
  assert.equal(cancelled.body.ok, true)
  release.resolve()
  await delay(30)
  assert.equal(calls, 1)
  assert.equal((await f.request('jobs?id=' + queued.body.id, undefined, 'GET')).body.job.state, 'cancelled')
})

test('restart marks persisted external requests uncertain without submitting them again', async t => {
  let calls = 0
  const id = '11111111-1111-4111-8111-111111111111'
  const f = await runtime(t, async function* () {}, {}, {
    config: imageConfig,
    initialJobs: { [id]: { id, state: 'running', percent: 0, createdAt: Date.now(), params: { tag: 'resume me' }, key: 'restart-key', backend: 'openai', channelId: 'primary', channelName: '测试渠道' } },
    fetch: async () => { calls++; return Response.json({ data: [{ b64_json: png }] }) },
  })
  await delay(20)
  const state = await f.request('state', undefined, 'GET')
  const restored = state.body.jobs.find(job => job.id === id)
  assert.equal(restored.state, 'uncertain')
  assert.match(restored.error, /未自动重试/)
  assert.equal(calls, 0, 'startup must never resubmit a potentially billable request')
})

test('cancelled ComfyUI task stays cancelled during polling and explicit recovery fetches its original result without POST', async t => {
  const id = '22222222-2222-4222-8222-222222222222'
  const current = { gameId: 'recovery-game', turn: 1, textVersion: 'v1', text: 'A portrait.' }
  const media = [{ id: 'cancelled-media', owner: 'dsh-tavern-image', kind: 'dsh-tavern-image/image', turn: 1, textVersion: 'v1', status: 'failed', data: { jobId: id, cancelled: true, cancelMayHaveContinued: true } }]
  const calls = []
  const tavern = {
    apiVersion: 2,
    promptSection() { return () => {} }, onTurnSettled() { this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} },
    async getTurn() { return current }, async list() { return media },
    async attach() { return { id: 'unused' } }, async update(mediaId, patch) { Object.assign(media.find(item => item.id === mediaId), patch) },
  }
  const f = await runtime(t, async function* () {}, {}, {
    tavern, attachments: { async saveImage(input) { return { id: 'recovered-attachment', mediaType: input.mediaType } } },
    config: { comfyUrl: 'http://comfy.test' },
    initialJobs: { [id]: { id, state: 'cancelled', backend: 'comfyui', comfyId: 'original-provider-id', comfyEndpoint: 'http://comfy.test', outputNode: '2', requestStarted: true, cancelMayHaveContinued: true, createdAt: Date.now() } },
    fetchHosts: ['comfy.test'],
    fetch: async (input, init) => {
      const url = new URL(input)
      calls.push({ path: url.pathname, method: init?.method || 'GET' })
      if (url.pathname === '/history/original-provider-id') return Response.json({ 'original-provider-id': { status: { completed: true }, outputs: { '2': { images: [{ filename: 'image.png' }] } } } })
      if (url.pathname === '/view') return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } })
      return Response.json({ queue_running: [], queue_pending: [] })
    },
  })
  assert.equal((await f.request('jobs?id=' + id, undefined, 'GET')).body.job.state, 'cancelled')
  assert.equal(calls.length, 0)
  const result = await f.request('media-action', { operation: 'recover', gameId: current.gameId, turn: 1, textVersion: 'v1', mediaId: 'cancelled-media', jobId: id })
  assert.equal(result.status, 200, result.body.error)
  await untilRuntime(() => media[0].data.replacement?.state === 'ready')
  assert.equal(media[0].attachment.id, 'recovered-attachment')
  assert.equal(media.length, 1)
  assert.ok(calls.some(call => call.path === '/history/original-provider-id'))
  assert.ok(calls.every(call => call.method === 'GET'), 'recovery must never submit a new prompt')
})

test('a ComfyUI refusal can be retried or redrawn through the official single-image media action', async t => {
  for (const operation of ['retry', 'redraw']) {
    const current = { gameId: 'comfy-media-retry', turn: 1, textVersion: 'v1', text: 'A portrait.' }
    const media = []
    let promptCalls = 0
    const tavern = {
      apiVersion: 2,
      promptSection() { return () => {} }, onTurnSettled() { this.bridgeReady = true; return () => {} },
      onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} },
      async getTurn() { return current }, async list() { return media },
      async attach() { return { id: 'unused' } }, async update(id, patch) { Object.assign(media.find(item => item.id === id), patch) },
    }
    const f = await runtime(t, async function* () {}, {}, {
      tavern, attachments: { async saveImage() { return { id: 'retry-attachment' } } },
      config: { comfyUrl: 'http://comfy.test' }, fetchHosts: ['comfy.test'],
      fetch: async (input, init) => {
        const url = new URL(input)
        if (url.pathname === '/prompt') {
          promptCalls++
          if (promptCalls === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
          return Response.json({ prompt_id: JSON.parse(init.body).prompt_id })
        }
        if (url.pathname.startsWith('/history/')) return Response.json({ [url.pathname.split('/').at(-1)]: { status: { completed: true }, outputs: { '2': { images: [{ filename: 'retry.png' }] } } } })
        if (url.pathname === '/view') return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } })
        return Response.json({ queue_running: [], queue_pending: [] })
      },
    })
    const first = await f.request('jobs', { tag: 'portrait', key: 'source-for-media-retry', sessionId: current.gameId, turn: 1, textVersion: 'v1' })
    assert.equal(first.body.status, 'failed')
    media.push({ id: 'media-comfy-retry', kind: 'dsh-tavern-image/image', gameId: current.gameId, turn: 1, textVersion: 'v1', status: 'failed', data: { jobId: first.body.id } })

    const action = await f.request('media-action', { operation, gameId: current.gameId, turn: 1, textVersion: 'v1', mediaId: 'media-comfy-retry', jobId: first.body.id, ...(operation === 'redraw' ? { prompt: 'portrait with a blue coat' } : {}) })
    assert.equal(action.status, 200, action.body.error)
    await f.request('jobs?id=' + action.body.jobId, undefined, 'GET')
    await untilRuntime(() => media[0].data.replacement?.state === 'ready', 5000)
    assert.equal(promptCalls, 2)
    assert.equal(media[0].attachment.id, 'retry-attachment')
    assert.equal(media[0].status, 'ready')
  }
})

test('media-action route redrawing uses the official same-version appearance snapshot', async t => {
  const current = { gameId: 'media-snapshot-game', turn: 1, textVersion: 'text-v1', text: 'A portrait.' }
  const saved = { textVersion: 'text-v1', data: { characters: { luna: { traits: { face: 'short white hair, blue eyes' } } }, changes: [] } }
  const media = []
  const prompts = []
  const requestHosts = []
  const tavern = {
    apiVersion: 2,
    promptSection() { return () => {} }, onTurnSettled() { this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} },
    async getTurn() { return current }, async list() { return media }, async readTurnData() { return saved },
    async attach() { return { id: 'unused' } }, async update(id, patch) { Object.assign(media.find(item => item.id === id), patch) },
    async remove(id) { const i = media.findIndex(item => item.id === id); if (i >= 0) media.splice(i, 1) },
  }
  const definitions = { characters: [{ id: 'luna', name: 'Luna', traits: { face: 'long red hair, brown eyes' } }] }
  const secondChannel = { ...imageChannel, id: 'secondary', name: '备用渠道', baseUrl: 'https://image-secondary.test/v1', apiKey: 'secondary-secret' }
  const f = await runtime(t, async function* () {}, definitions, {
    tavern, attachments: { async saveImage(input) { return { id: 'attachment-' + input.name, mediaType: input.mediaType } } }, config: { ...imageConfig, imageChannels: [imageChannel, secondChannel] },
    fetchHosts: ['image-secondary.test'],
    fetch: async (input, init) => { requestHosts.push(new URL(input).hostname); prompts.push(JSON.parse(init.body).prompt); return Response.json({ data: [{ b64_json: png }] }) },
  })
  const macro = '${"name":"Luna","upperBody":"sfw"}$'
  const original = await f.request('generate', { tag: macro })
  assert.equal(original.status, 200)
  await untilRuntime(async () => (await f.request('history', undefined, 'GET')).body.jobs.find(job => job.id === original.body.jobId)?.state === 'done')
  media.push({ id: 'media-source', kind: 'dsh-tavern-image/image', gameId: current.gameId, turn: current.turn, textVersion: current.textVersion, status: 'ready', attachment: { id: 'old' }, data: { jobId: original.body.jobId } })
  const action = await f.request('media-action', { operation: 'redraw', gameId: current.gameId, turn: current.turn, textVersion: current.textVersion, mediaId: 'media-source', jobId: original.body.jobId, prompt: macro })
  assert.equal(action.status, 200, action.body.error)
  await untilRuntime(async () => media[0].data.replacement?.state === 'ready')
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /short white hair/)
  assert.doesNotMatch(prompts[1], /long red hair/)
  assert.equal(media[0].id, 'media-source', 'replacement updates the same official media item')
  assert.deepEqual(requestHosts, ['image.test', 'image.test'], 'omitting channel follows the source channel')
  const second = await f.request('media-action', { operation: 'redraw', gameId: current.gameId, turn: current.turn, textVersion: current.textVersion, mediaId: 'media-source', jobId: media[0].data.jobId, prompt: macro, channelId: 'secondary' })
  assert.equal(second.status, 200, second.body.error)
  await untilRuntime(async () => media[0].data.replacement?.state === 'ready')
  assert.equal(requestHosts[2], 'image-secondary.test', 'an explicitly selected saved channel is used for this copy only')
  assert.equal((await f.request('state', undefined, 'GET')).body.config.activeImageChannel, 'primary', 'replacement never mutates global channel selection')
})

test('media-action preserves a simple Comfy source template after global mode changes', async t => {
  const current = { gameId: 'simple-redraw-game', turn: 1, textVersion: 'v1', text: 'A scene.' }, media = [], prompts = []
  const tavern = {
    apiVersion: 2, promptSection() { return () => {} }, onTurnSettled() { this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} },
    async getTurn() { return current }, async list() { return media }, async readTurnData() { return null },
    async attach() { return { id: 'unused' } }, async update(id, patch) { Object.assign(media.find(item => item.id === id), patch) }, async remove() {},
  }
  const choices = values => [values, {}], node = required => ({ input: { required } })
  const objectInfo = {
    CheckpointLoaderSimple: node({ ckpt_name: choices(['source-model.safetensors']) }), CLIPTextEncode: node({ clip: ['CLIP', {}], text: ['STRING', {}] }),
    EmptyLatentImage: node({ width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] }),
    KSampler: node({ model: ['MODEL', {}], positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], latent_image: ['LATENT', {}], seed: ['INT', {}], steps: ['INT', {}], cfg: ['FLOAT', {}], sampler_name: choices(['euler']), scheduler: choices(['normal']), denoise: ['FLOAT', {}] }),
    VAEDecode: node({ samples: ['LATENT', {}], vae: ['VAE', {}] }), SaveImage: node({ images: ['IMAGE', {}], filename_prefix: ['STRING', {}] }),
  }
  const f = await runtime(t, async function* () {}, {}, {
    tavern, attachments: { async saveImage() { return { id: 'unused' } } }, objectInfo,
    fetchHosts: ['comfy.test'],
    config: { imageBackend: 'comfyui', comfyMode: 'simple', comfyUrl: 'http://comfy.test', comfySimple: { template: 'checkpoint', checkpoint: 'source-model.safetensors', steps: 11, width: 640, height: 896 } },
    fetch: async (input, init) => {
      const url = new URL(input)
      if (url.hostname === 'comfy.test' && url.pathname === '/prompt') { prompts.push(JSON.parse(init.body).prompt); return Response.json({ prompt_id: 'simple-' + prompts.length }) }
      throw new Error('unexpected fixture fetch ' + url.href)
    },
  })
  const original = await f.request('generate', { tag: 'portrait' })
  assert.equal(original.status, 200, original.body.error)
  await f.request('config', { config: { comfyMode: 'workflow' } })
  media.push({ id: 'simple-media', kind: 'dsh-tavern-image/image', turn: 1, textVersion: 'v1', status: 'pending', data: { jobId: original.body.jobId } })
  const action = await f.request('media-action', { operation: 'redraw', gameId: current.gameId, turn: 1, textVersion: 'v1', mediaId: 'simple-media', jobId: original.body.jobId, prompt: 'new portrait' })
  assert.equal(action.status, 200, action.body.error)
  assert.equal(prompts.length, 2)
  assert.equal(Object.values(prompts[1]).find(item => item.class_type === 'CheckpointLoaderSimple').inputs.ckpt_name, 'source-model.safetensors')
  assert.equal(media[0].data.replacement.state, 'pending')
})

test('an unavailable selected channel creates no job and sends no provider request', async t => {
  let calls = 0
  const f = await runtime(t, async function* () {}, {}, {
    config: { ...imageConfig, activeImageChannel: 'missing' },
    fetch: async () => { calls++; return Response.json({ data: [{ b64_json: png }] }) },
  })
  const response = await f.request('jobs', { tag: 'should not start', key: 'unavailable-channel' })
  assert.equal(response.status, 500)
  assert.match(response.body.error, /选择并保存/)
  assert.equal(calls, 0)
  assert.equal((await f.request('state', undefined, 'GET')).body.jobs.length, 0)
})

test('testing a workflow always uses that Comfy workflow even when an external channel is active', async t => {
  const f = await runtime(t, async function* () {}, {}, { config: imageConfig, fetch: async () => { throw new Error('must not use paid channel') } })
  const result = await f.request('workflow-test', { id: 'test', prompt: 'a person, (blue coat:1.2)' })
  assert.equal(result.body.ok, true)
  assert.equal(result.body.job.backend, 'comfyui')
  assert.deepEqual(f.submitted, ['a person, (blue coat:1.2)'])
})

test('graph route saves parameters with revision checking and rejects traversal', async t => {
  const f = await runtime(t, async function* () {})
  const loaded = await f.request('workflow-graph', { file: 'workflows/test.json' })
  assert.equal(loaded.body.ok, true)
  const update = { file: 'test.json', revision: loaded.body.revision, patch: { inputs: { '1': { text: 'edited' } }, positions: { '1': { x: 100, y: 200 } } } }
  assert.equal((await f.request('workflow-graph', update)).body.ok, true)
  assert.equal((await f.request('workflow-graph', update)).status, 400)
  const saved = JSON.parse(await readFile(join(f.root, 'workflows', 'test.json'), 'utf8'))
  assert.equal(saved.prompt['1'].inputs.text, 'edited')
  assert.deepEqual(saved.prompt['2'].inputs.images, ['1', 0])
  assert.equal((await f.request('workflow-graph', { file: '../config.json' })).status, 400)
  assert.equal((await f.request('workflow-graph', {}, 'POST', { origin: 'https://bad.test' })).status, 403)
})

// 已移除的测试（规划改为 tavern.runTask 一次性返回后，这些「流式特有」前提不再存在）：
//   · an automatic stream retry preserves complete submitted images without duplicate GPU jobs
//   · smart auto pays and attaches the first image before the planner stream ends
//   · smart stream error after first image preserves its paid job and reports failure
// 它们验证的是 onDelta 流式路径下的重试与「提前提交」。runTask 非流式，整轮结果一次返回，
// 提交统一在解析之后，因此不存在「流中途失败但已有图已付费」这类中间态。

test('本局没有 MVU 变量时必须清空 skill，不能留着上一局的数据', async t => {
  // scene-mvu-state 是一份全局文件。取不到变量时若不清空，
  // 它就会保留上一局（别的卡）的人物和穿着，模型一加载就把人画串。
  const tavern = {
    apiVersion: 2,
    promptSection() { return () => {} },
    onTurnSettled() { this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} },
    onGameRemoved() { return () => {} },
    // 这一局没有 variables（非 MVU 卡）
    async getTurn({ turn }) { return { turn, textVersion: 'v1', card: { id: 'cards/y.json', name: 'Y' } } },
    async getCharacterDesigns() { return { characters: [] } },
    async list() { return [] },
    async attach() { return { id: 'm' } },
    async update() {}, async remove() {},
    async readTurnData() { return null }, async saveTurnData() {},
    async saveSkill(input) { saved.push(input); return { name: input.name, overwritten: true } },
    async runTask({ prompt }) { seenPrompt = String(prompt || ''); return { text: '<decision>draw</decision><reason>ok</reason>' + block('x', '正文一句') } },
  }
  const saved = []
  let seenPrompt = ''
  const f = await runtime(t, async function* () { yield { type: 'text-delta', text: block('x', '正文一句') } }, {}, { tavern })

  const res = await f.request('plan', { text: '正文一句。', messageId: 'm2', turn: 1, count: 1, sessionId: 'no-mvu-game' })
  assert.equal(res.status, 200)

  assert.equal(saved.length, 1, '取不到变量时也要写一次 skill')
  assert.equal(saved[0].name, 'scene-mvu-state')
  assert.equal(saved[0].overwrite, true, '必须覆盖，才能清掉上一局的内容')
  // 语义已升级：不再只讲 MVU，而是「本局的生图角色档案」——没有 MVU 时按正文建档
  assert.match(saved[0].body, /本局角色档案/, '应是角色档案，不是纯 MVU 状态')
  assert.match(saved[0].body, /本局还没有建档/, '本局无档案时应明说')
  assert.doesNotMatch(saved[0].body, /###\s*叶冰/, '不能残留上一局的角色数据')

  // 提示词也要让 Agent 去加载它，拿到「本局无 MVU」的明确指令
  assert.match(seenPrompt, /加载 scene-mvu-state/, '仍应要求加载 skill')
  assert.match(seenPrompt, /不要套用档案里其他角色的外貌与穿着/, '应明确禁止套用其他角色的外貌')
})

test('MVU 走 skill：规划前写 scene-mvu-state，提示词要求用 skill 加载它', async t => {
  // 宿主的限制：插件任务拿不到 tavern_read_variables；runTask 的 tools 参数在 task='plugin'
  // 下不生效（工具表由 stableBackgroundTools 在会话建立时固定）。
  // 但 skill 在白名单里，且 readSkill 每次实时读盘 —— 所以每轮把变量写进 skill 这条路成立。
  const state = {
    current: {
      gameId: 'mvu-game', turn: 1, textVersion: 'v1',
      text: '她侧躺在帐幔半垂的寝殿内，任那件衣裳滑落。',
      card: { id: 'card-mvu', name: 'MVU card' },
      variables: { stat_data: {
        周围人物: { 叶冰: { 服饰: '大红薄衫湿透贴身', 好感度: 82 } },
        地点: '殿心矮几旁',
      } },
    },
  }
  const saved = []
  let seenPrompt = ''
  const tavern = {
    apiVersion: 2,
    promptSection() { return () => {} },
    onTurnSettled() { this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} },
    onGameRemoved() { return () => {} },
    async getTurn({ turn }) { return state.current.turn === turn ? state.current : null },
    async getCharacterDesigns() { return { characters: [] } },
    async list() { return [] },
    async attach() { return { id: 'media-x' } },
    async update() {}, async remove() {},
    async readTurnData() { return null }, async saveTurnData() {},
    async saveSkill(input) { saved.push(input); return { name: input.name, overwritten: true } },
    async runTask({ prompt }) {
      // 档案维护是另一次调用，别让它覆盖规划提示词
      if (!/角色状态记录员/.test(String(prompt || ''))) {
        seenPrompt = String(prompt || '')
        return { text: '<decision>draw</decision><reason>有值得画的瞬间</reason>' + block('画面一', '任那件衣裳滑落') }
      }
      return { text: '{"characters":[]}' }
    },
  }
  const f = await runtime(t, async function* () {
    yield { type: 'text-delta', text: block('画面一', '任那件衣裳滑落') }
  }, {}, { tavern })

  const res = await f.request('plan', { text: state.current.text, messageId: 'm1', turn: 1, count: 1, sessionId: 'mvu-game' })
  assert.equal(res.status, 200)

  // 必须写过 skill，且内容带上变量值
  assert.equal(saved.length, 1, '规划前应写一次 MVU skill')
  assert.equal(saved[0].name, 'scene-mvu-state', 'skill 名应为 scene-mvu-state')
  assert.equal(saved[0].overwrite, true, '必须覆盖写，否则第二次就写不进去')
  assert.match(saved[0].body, /大红薄衫湿透贴身/, 'skill 正文应含服饰变量')
  assert.match(saved[0].body, /殿心矮几旁/, 'skill 正文应含地点变量')
  assert.doesNotMatch(saved[0].body, /好感度/, '数值字段不应写入')

  // 提示词要求用 skill 加载，且不再提旧工具
  assert.match(seenPrompt, /加载 scene-mvu-state/, '提示词应要求加载该 skill')
  assert.match(seenPrompt, /这一步必做/, '应写成必做')
  assert.doesNotMatch(seenPrompt, /tavern_read_variables|mvu_state_read/, '不应再提用不了的工具')
})

test('生图角色档案跨轮累积：正文没写服装时沿用上一轮，MVU 只覆盖它能提供的字段', async t => {
  const m = await import('../lib/character-history.js')
  const store = {}
  const api = {
    readTurnData: async ({ turn }) => store[turn] ? { data: store[turn] } : null,
    saveTurnData: async ({ turn, data }) => { store[turn] = data },
  }
  const round = async (turn, updates, mvu) => {
    let base = null
    for (const at of [turn, turn - 1]) {
      const saved = await api.readTurnData({ turn: at })
      if (saved?.data?.characters) { base = saved.data; break }
    }
    let working = base || m.emptyCharacterSnapshot()
    if (mvu) working = m.overlayMvuState(working, mvu)
    const merged = m.mergeSceneState(working, updates, { turn })
    await api.saveTurnData({ turn, data: m.boundSceneState(merged.snapshot) })
    return m.renderSceneState(merged.snapshot)
  }

  // 第 1 轮：正文写清全身服装
  const first = await round(1, [{ name: '叶冰', fields: { outfit: '大红薄衫湿透贴身，下身素白中裤，赤足', hair: '黑长发高髻' } }])
  assert.match(first, /大红薄衫/)
  assert.match(first, /黑长发高髻/)

  // 第 2 轮：正文只写姿势，没提衣服 —— 服装发型必须保留
  const second = await round(2, [{ name: '叶冰', fields: { posture: '双膝跪地' } }])
  assert.match(second, /大红薄衫/, '正文没提衣服时必须沿用上一轮')
  assert.match(second, /黑长发高髻/, '发型也要沿用')
  assert.match(second, /双膝跪地/, '本轮新信息要写进去')

  // 第 3 轮：MVU 说她换了衣服 —— 只覆盖服装，发型姿势不动
  const third = await round(3, [], [{ path: '周围人物.叶冰.服饰', value: '水青色长裙，肩带滑落一侧' }])
  assert.match(third, /水青色长裙/, 'MVU 应覆盖服装')
  assert.doesNotMatch(third, /大红薄衫/, '旧服装应被替换')
  assert.match(third, /黑长发高髻/, 'MVU 没提供的字段不能被清掉')
  assert.match(third, /双膝跪地/, '姿势也不能被清掉')

  // 存档要压得住每轮上限
  assert.ok(JSON.stringify(store[3]).length < 64 * 1024)
})

test('scene_state 解析：格式坏掉不影响出图，也不清空已有档案', async t => {
  const { parseSceneState } = await import('../lib/planner.js')
  assert.deepEqual(parseSceneState('没有这个块').characters, [])
  assert.equal(parseSceneState('<scene_state>坏 JSON</scene_state>').valid, false)
  const ok = parseSceneState('<scene_state>{"characters":[{"name":"叶冰","fields":{"outfit":"红衫"}}]}</scene_state>')
  assert.equal(ok.valid, true)
  assert.equal(ok.characters[0].fields.outfit, '红衫')
  // 缺 name 或 fields 的条目要被丢掉，而不是让整个档案写坏
  const partial = parseSceneState('<scene_state>{"characters":[{"fields":{"outfit":"x"}},{"name":"","fields":{}},{"name":"好","fields":{"outfit":"绿衣"}}]}</scene_state>')
  assert.equal(partial.characters.length, 1)
  assert.equal(partial.characters[0].name, '好')
})

test('基准外貌不再由生图 Agent 负责：档案维护拆成独立调用', async t => {
  // 建档/补基准移到了 updateSceneState（独立 runTask 调用），
  // 生图规划提示词里不该再有「先查世界书补外貌」这一步，也不该要求输出 scene_state。
  const state = { current: { gameId: 'seed-game', turn: 1, textVersion: 'v1', text: '叶冰抬起头看了他一眼。', card: { id: 'cards/a.json', name: 'A' } } }
  let planPrompt = ''
  const tavern = {
    apiVersion: 2, promptSection() { return () => {} },
    onTurnSettled() { this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} },
    async getTurn({ turn }) { return state.current.turn === turn ? state.current : null },
    async getCharacterDesigns() { return { characters: [] } },
    async list() { return [] }, async attach() { return { id: 'm' } }, async update() {}, async remove() {},
    async readTurnData() { return null }, async saveTurnData() {},
    async saveSkill() { return { name: 'x' } },
    async runTask({ prompt }) {
      if (/角色状态记录员/.test(String(prompt || ''))) {
        assert.match(String(prompt), /角色状态记录员/, '档案任务的系统说明应到位')
        return { text: '{"characters":[]}' }
      }
      planPrompt = String(prompt || '')
      return { text: '<decision>draw</decision><reason>ok</reason>' + block('x', '叶冰抬起头') }
    },
  }
  const f = await runtime(t, async function* () { yield { type: 'text-delta', text: block('x', '叶冰抬起头') } }, {}, { tavern })
  await f.request('plan', { text: state.current.text, messageId: 'm', turn: 1, count: 1, sessionId: 'seed-game' })

  assert.doesNotMatch(planPrompt, /<scene_state>/, '生图 Agent 不该再输出档案')
  assert.doesNotMatch(planPrompt, /先用世界书补基准外貌/, '建档不再由生图 Agent 做')
  assert.match(planPrompt, /加载 scene-mvu-state/, '仍要读档案')
})

test('档案裁剪不能丢掉 state：boundSceneState 单独用，别再套 boundCharacterSnapshot', async t => {
  const m = await import('../lib/character-history.js')
  const merged = m.mergeSceneState(m.emptyCharacterSnapshot(), [{ name: '叶冰', fields: { outfit: '红衫褪至膝弯' } }], { turn: 21 })
  const only = m.boundSceneState(merged.snapshot)
  assert.equal(only.characters['叶冰'].state.outfit, '红衫褪至膝弯', 'boundSceneState 必须保留 state')

  // 记录这个陷阱：boundCharacterSnapshot 是给永久特征写的，会把 state 清空
  const wrong = m.boundCharacterSnapshot(only)
  assert.deepEqual(wrong.characters['叶冰'].state, undefined, 'boundCharacterSnapshot 会丢 state（这正是曾经的 bug）')
})

test('MVU 通用适配：不依赖特定卡的变量结构', async t => {
  const m = await import('../lib/character-history.js')
  const run = fields => m.renderSceneState(m.overlayMvuState(m.emptyCharacterSnapshot(), fields))

  // 本卡结构
  assert.match(run([{ path: '周围人物.叶冰.服饰', value: '红衫湿透' }]), /叶冰[\s\S]*红衫湿透/)
  // 扁平结构（无容器层）
  assert.match(run([{ path: '叶冰.服装', value: '青衫' }]), /叶冰[\s\S]*青衫/)
  // 英文结构
  const en = run([{ path: 'characters.Alice.outfit', value: 'black dress' }])
  assert.match(en, /Alice/)
  assert.match(en, /black dress/)
  // 数组 + 显式姓名字段
  const arr = run([
    { path: '角色[0].名字', value: '苏念' },
    { path: '角色[0].衣着', value: '白衣' },
  ])
  assert.match(arr, /苏念/, '应使用显式姓名字段而不是「角色[0]」')
  assert.match(arr, /白衣/)
  // 细粒度覆盖大类
  const fine = run([
    { path: '周围人物.叶冰.服饰', value: '整体衣着' },
    { path: '周围人物.叶冰.服饰.上装', value: '月白薄纱亵衣' },
  ])
  assert.match(fine, /月白薄纱亵衣/, '更具体的路径应胜出')
  // 顶层场景字段
  assert.match(run([{ path: '地点', value: '殿心' }]), /殿心/)
})

test('生图协议不再输出 scene_state：档案由独立任务维护', async t => {
  const { buildPlannerSystem } = await import('../lib/planner.js')
  const system = buildPlannerSystem({ rules: '', roster: '', count: 2, context: '', extra: '' })
  assert.doesNotMatch(system, /<scene_state>/, '生图 Agent 不该再被要求输出档案')
  assert.match(system, /<decision>/, '出图协议仍要保留')
  assert.match(system, /<\/固定输出协议>/, '协议结构完整')
})
