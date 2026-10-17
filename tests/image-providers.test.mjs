import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IMAGE_PROVIDERS, USER_AGENT, generateImage, testImageChannel } from '../lib/image-providers.js'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const b64 = png.toString('base64')
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const image = value => new Response(value, { headers: { 'content-type': 'image/png' } })
const channel = (provider, extra = {}) => ({ provider, baseUrl: 'https://provider.test/v1', model: '', apiKey: 'top-secret', authMode: 'bearer', options: {}, ...extra })
const request = { positive: 'A blue bird', negative: 'blur', width: 512, height: 768, seed: 9, steps: 22, cfg: 6 }

function storedZip(name, contents) {
  const file = Buffer.from(name), crc = 0, size = contents.length
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(file.length, 26)
  const localRecord = Buffer.concat([local, file, contents])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(file.length, 28)
  const centralRecord = Buffer.concat([central, file])
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(centralRecord.length, 12); end.writeUInt32LE(localRecord.length, 16)
  return Buffer.concat([localRecord, centralRecord, end])
}
function mockFetch(fn) {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), ...init }); return fn(String(url), init, calls.length) }
  return { fetchImpl, calls }
}

test('exports all requested providers with stable ids and localized labels', () => {
  assert.deepEqual(IMAGE_PROVIDERS.map(x => x.id), ['novelai', 'openai', 'gemini', 'gemini-chat', 'grok', 'seedream', 'qwen', 'sdwebui', 'runninghub'])
  assert.equal(IMAGE_PROVIDERS.find(x => x.id === 'qwen').model, 'qwen-image-3.0')
  assert.equal(IMAGE_PROVIDERS.find(x => x.id === 'runninghub').label, 'RunningHub 云端 ComfyUI')
})

test('NovelAI sends separate positive/negative prompts and extracts a bounded ZIP image', async () => {
  const zip = storedZip('result.png', png), { fetchImpl, calls } = mockFetch(() => new Response(zip))
  const out = await generateImage(channel('novelai', { baseUrl: 'https://image.test' }), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(calls[0].url, 'https://image.test/ai/generate-image')
  assert.equal(body.input, request.positive)
  assert.equal(body.parameters.negative_prompt, request.negative)
  assert.equal(body.parameters.steps, request.steps)
  assert.equal(body.parameters.scale, request.cfg)
  assert.deepEqual(body.parameters.v4_prompt, { caption: { base_caption: request.positive, char_captions: [] }, use_coords: false, use_order: true })
  assert.deepEqual(body.parameters.v4_negative_prompt, { caption: { base_caption: request.negative, char_captions: [] }, legacy_uc: false })
  assert.equal(out.mediaType, 'image/png')
  assert.deepEqual(out.bytes, png)
})

test('NovelAI option CFG, steps, and explicit dimensions override request defaults', async () => {
  const zip = storedZip('result.png', png), { fetchImpl, calls } = mockFetch(() => new Response(zip))
  await generateImage(channel('novelai', { baseUrl: 'https://image.test', options: { cfg: 4.5, steps: 31, size: '1024x1536' } }), { ...request, cfg: undefined, steps: undefined }, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(body.parameters.scale, 4.5)
  assert.equal(body.parameters.steps, 31)
  assert.equal(body.parameters.width, 1024)
  assert.equal(body.parameters.height, 1536)
})

test('OpenAI Images uses an orientation size and returns validated base64 image bytes', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  const out = await generateImage(channel('openai'), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(calls[0].url, 'https://provider.test/v1/images/generations')
  assert.equal(body.size, '1024x1536')
  assert.equal(body.quality, 'medium')
  assert.deepEqual(out.bytes, png)
})

test('blank OpenAI size option is ignored and supported explicit size is honored', async () => {
  const first = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  await generateImage(channel('openai', { options: { size: '' } }), request, { fetchImpl: first.fetchImpl })
  assert.equal(JSON.parse(first.calls[0].body).size, '1024x1536')
  const second = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  await generateImage(channel('openai', { options: { size: '1024x1024' } }), request, { fetchImpl: second.fetchImpl })
  assert.equal(JSON.parse(second.calls[0].body).size, '1024x1024')
})

test('Gemini native uses documented generateContent route and x-goog-api-key auth', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }] } }] }))
  await generateImage(channel('gemini'), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.match(calls[0].url, /\/models\/gemini-3\.1-flash-image:generateContent$/)
  assert.equal(calls[0].headers['x-goog-api-key'], 'top-secret')
  assert.equal(calls[0].headers.authorization, undefined)
  assert.deepEqual(body.generationConfig.responseModalities, ['IMAGE'])
  assert.equal(body.contents[0].parts[0].text, 'A blue bird\n\nAvoid: blur')
})

test('Gemini chat parses markdown image URLs and never forwards credentials to the image host', async () => {
  const { fetchImpl, calls } = mockFetch((_url, _init, n) => n === 1 ? json({ choices: [{ message: { content: 'Rendered: ![image](https://cdn.test/out.png)' } }] }) : image(png))
  const out = await generateImage(channel('gemini-chat'), request, { fetchImpl })
  assert.deepEqual(out.bytes, png)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'https://cdn.test/out.png')
  assert.deepEqual(calls[1].headers, {})
  assert.equal(calls[0].redirect, 'error')
})

test('Gemini chat extracts inline data URLs from OpenRouter-style content parts', async () => {
  const { fetchImpl } = mockFetch(() => json({ choices: [{ message: { content: [{ type: 'text', text: 'done' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] } }] }))
  const out = await generateImage(channel('gemini-chat'), request, { fetchImpl })
  assert.deepEqual(out.bytes, png)
})

test('Grok uses its documented image endpoint without unsupported dimension parameters', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  await generateImage(channel('grok'), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(calls[0].url, 'https://provider.test/v1/images/generations')
  assert.equal('size' in body, false)
})

test('Seedream uses the OpenAI-compatible Ark images route', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  await generateImage(channel('seedream'), request, { fetchImpl })
  assert.equal(calls[0].url, 'https://provider.test/v1/images/generations')
  assert.equal(JSON.parse(calls[0].body).model, 'doubao-seedream-5-0-pro-260628')
  assert.equal(JSON.parse(calls[0].body).size, '2K')
})

test('Seedream honors valid size tier overrides', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  await generateImage(channel('seedream', { options: { size: '1.5K' } }), request, { fetchImpl })
  assert.equal(JSON.parse(calls[0].body).size, '1.5K')
})

test('Qwen-Image uses current sync multimodal-generation schema without async header', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ output: { choices: [{ message: { content: [{ image: `data:image/png;base64,${b64}` }] } }] } }))
  const out = await generateImage(channel('qwen'), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.match(calls[0].url, /multimodal-generation\/generation$/)
  assert.equal(body.model, 'qwen-image-3.0')
  assert.equal(body.input.messages[0].content[0].text, request.positive)
  assert.equal(body.parameters.negative_prompt, request.negative)
  assert.equal(body.parameters.seed, request.seed)
  assert.equal(calls[0].headers['X-DashScope-Async'], undefined)
  assert.deepEqual(out.bytes, png)
})

test('Qwen-Image normalizes a 32-bit plugin seed to documented signed range', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ output: { choices: [{ message: { content: [{ image: `data:image/png;base64,${b64}` }] } }] } }))
  await generateImage(channel('qwen'), { ...request, seed: 0xffffffff }, { fetchImpl })
  assert.equal(JSON.parse(calls[0].body).parameters.seed, 2147483647)
})

test('legacy DashScope async task path polls without retrying generation', async () => {
  const { fetchImpl, calls } = mockFetch((_url, _init, n) => n === 1 ? json({ output: { task_id: 'task-1', task_status: 'PENDING' } }) : n === 2 ? json({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.test/qwen.png' }] } }) : image(png))
  const out = await generateImage(channel('qwen', { options: { apiMode: 'async', pollIntervalMs: 1 } }), request, { fetchImpl })
  assert.equal(calls.length, 3)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['X-DashScope-Async'], 'enable')
  assert.equal(calls[1].method, 'GET')
  assert.deepEqual(calls[2].headers, {})
  assert.deepEqual(out.bytes, png)
})

test('SD WebUI uses its txt2img API and keeps positive and negative prompts separate', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ images: [b64] }))
  await generateImage(channel('sdwebui', { baseUrl: 'http://forge.test:7860' }), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(calls[0].url, 'http://forge.test:7860/sdapi/v1/txt2img')
  assert.equal(body.prompt, request.positive)
  assert.equal(body.negative_prompt, request.negative)
  assert.equal(body.steps, request.steps)
})

test('SD WebUI honors option steps, CFG, explicit size, and aspect ratio', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ images: [b64] }))
  await generateImage(channel('sdwebui', { baseUrl: 'http://forge.test:7860', options: { steps: 33, cfg: 8.5, size: '1024x1024', aspectRatio: '2:3' } }), { ...request, cfg: undefined, steps: undefined }, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(body.steps, 33)
  assert.equal(body.cfg_scale, 8.5)
  assert.equal(body.width, 840)
  assert.equal(body.height, 1256)
})

test('rejects non-HTTP endpoints, absolute override paths, invalid images, and oversized bytes', async () => {
  await assert.rejects(generateImage(channel('openai', { baseUrl: 'file:///tmp' }), request, { fetchImpl: async () => json({}) }), /HTTP\(S\)/)
  await assert.rejects(generateImage(channel('openai', { options: { generatePath: 'https://steal.test/generate' } }), request, { fetchImpl: async () => json({}) }), /relative|相对/)
  const bad = mockFetch(() => json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }))
  await assert.rejects(generateImage(channel('openai'), request, { fetchImpl: bad.fetchImpl }), /受支持的图片格式|不是有效图片/)
  const large = mockFetch(() => json({ data: [{ b64_json: Buffer.alloc(5000).toString('base64') }] }))
  await assert.rejects(generateImage(channel('openai'), request, { fetchImpl: large.fetchImpl, maxImageBytes: 1024 }), /过大|size|limit/i)
})

test('errors redact secrets and generation requests are never retried', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ error: { message: `invalid key top-secret` } }), { status: 401 }) }
  await assert.rejects(generateImage(channel('openai'), request, { fetchImpl }), error => !error.message.includes('top-secret') && /redacted/.test(error.message))
  assert.equal(calls, 1)
})

test('testImageChannel uses only a safe read-only model probe and generation-free configured result otherwise', async () => {
  const safe = mockFetch(() => json({ data: [{ id: 'img-model' }] }))
  const result = await testImageChannel(channel('openai'), { fetchImpl: safe.fetchImpl })
  assert.equal(result.status, 'reachable')
  assert.deepEqual(result.models, ['img-model'])
  assert.equal(safe.calls[0].method, 'GET')
  const configured = await testImageChannel(channel('seedream'), { fetchImpl: async () => { throw new Error('must not call') } })
  assert.equal(configured.status, 'configured')
})

test('testImageChannel safely probes NovelAI subscription endpoint with User-Agent header', async () => {
  const probe = mockFetch(() => json({ tier: 3, anlas: 10000 }))
  const result = await testImageChannel(channel('novelai', { baseUrl: 'https://image.novelai.net' }), { fetchImpl: probe.fetchImpl })
  assert.equal(result.status, 'reachable')
  assert.equal(result.ok, true)
  assert.equal(result.message, '连接正常。')
  assert.equal(probe.calls.length, 1)
  assert.equal(probe.calls[0].method, 'GET')
  assert.equal(probe.calls[0].url, 'https://image.novelai.net/user/subscription')
  assert.equal(probe.calls[0].headers.authorization, 'Bearer top-secret')
  assert.equal(probe.calls[0].headers['user-agent'], USER_AGENT)
})

test('User-Agent stays in sync with the package version', () => {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.equal(USER_AGENT, `dsh-tavern-image/${version}`)
})

test('testImageChannel skips invalid entries in provider model lists', async () => {
  const openai = mockFetch(() => json({ data: [{ id: 'first' }, null, 42, { name: 'second' }] }))
  const dataResult = await testImageChannel(channel('openai'), { fetchImpl: openai.fetchImpl })
  assert.equal(dataResult.status, 'reachable')
  assert.deepEqual(dataResult.models, ['first', 'second'])

  const modelList = mockFetch(() => json({ data: {}, models: [null, 'ignored', { name: 'fallback' }] }))
  const modelsResult = await testImageChannel(channel('openai'), { fetchImpl: modelList.fetchImpl })
  assert.equal(modelsResult.status, 'reachable')
  assert.deepEqual(modelsResult.models, ['fallback'])

  const sdwebui = mockFetch(() => json([null, 'ignored', { model_name: 'checkpoint' }, {}]))
  const sdResult = await testImageChannel(channel('sdwebui'), { fetchImpl: sdwebui.fetchImpl })
  assert.equal(sdResult.status, 'reachable')
  assert.deepEqual(sdResult.models, ['checkpoint'])
})

test('testImageChannel honors custom testPath for NovelAI reverse proxy', async () => {
  const probe = mockFetch(() => json({ active: true }))
  const result = await testImageChannel(channel('novelai', { baseUrl: 'https://proxy.test', options: { testPath: '/ai/user/subscription' } }), { fetchImpl: probe.fetchImpl })
  assert.equal(result.status, 'reachable')
  assert.equal(result.ok, true)
  assert.equal(probe.calls[0].url, 'https://proxy.test/ai/user/subscription')
})

test('requestHeaders includes User-Agent on generation requests', async () => {
  const zip = storedZip('result.png', png), { fetchImpl, calls } = mockFetch(() => new Response(zip))
  await generateImage(channel('novelai', { baseUrl: 'https://image.test' }), request, { fetchImpl })
  assert.equal(calls[0].headers['user-agent'], USER_AGENT)
})

test('external image URLs receive neither bearer nor Basic credentials', async () => {
  const { fetchImpl, calls } = mockFetch((_url, _init, n) => n === 1 ? json({ data: [{ url: 'https://cdn.test/image.png' }] }) : image(png))
  await generateImage(channel('openai', { authMode: 'basic', username: 'user', password: 'secret-pass' }), request, { fetchImpl })
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from('user:secret-pass').toString('base64')}`)
  assert.deepEqual(calls[1].headers, {})
})

test('abort signal stops a pending provider request', async () => {
  const controller = new AbortController()
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  const pending = generateImage(channel('openai'), request, { fetchImpl, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending)
})

test('lost generation responses and image downloads are uncertain, never automatically repeated', async () => {
  for (const mode of ['network', 'server', 'download']) {
    const { fetchImpl, calls } = mockFetch((_url, _init, n) => {
      if (mode === 'server') return new Response('upstream unavailable', { status: 502 })
      if (mode === 'download' && n === 1) return json({ data: [{ url: 'https://cdn.test/result.png' }] })
      throw new Error('connection lost')
    })
    await assert.rejects(generateImage(channel('openai'), request, { fetchImpl }), error => error.requestMayHaveSucceeded === true)
    assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  }
})

test('explicit platform rejection and pre-submission validation do not imply a paid task', async () => {
  const denied = mockFetch(() => new Response('not authorized', { status: 401 }))
  await assert.rejects(generateImage(channel('openai'), request, { fetchImpl: denied.fetchImpl }), error => error.requestMayHaveSucceeded === false)
  const invalid = mockFetch(() => { throw new Error('must not fetch') })
  await assert.rejects(generateImage(channel('openai', { options: { generatePath: '//other.test/generate' } }), request, { fetchImpl: invalid.fetchImpl }), error => error.requestMayHaveSucceeded === false)
  assert.equal(invalid.calls.length, 0)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(generateImage(channel('openai'), request, { fetchImpl: invalid.fetchImpl, signal: controller.signal }), error => error.requestMayHaveSucceeded === false)
  assert.equal(invalid.calls.length, 0)
})

test('Qwen acknowledges the task before polling and resumes the same task without POST', async () => {
  const observed = []
  const lost = mockFetch((_url, _init, n) => {
    if (n === 1) return json({ output: { task_id: 'task-recover', task_status: 'PENDING' } })
    assert.deepEqual(observed, [{ provider: 'qwen', taskId: 'task-recover' }])
    throw new Error('poll connection lost')
  })
  const settings = channel('qwen', { options: { apiMode: 'async', pollIntervalMs: 1 } })
  await assert.rejects(generateImage(settings, request, { fetchImpl: lost.fetchImpl, onTask: value => observed.push(value) }), error => error.requestMayHaveSucceeded === true)
  const recovered = mockFetch((_url, _init, n) => n === 1
    ? json({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.test/recovered.png' }] } }) : image(png))
  const result = await generateImage(settings, request, { fetchImpl: recovered.fetchImpl, resumeTaskId: observed[0].taskId })
  assert.deepEqual(result.bytes, png)
  assert.ok(recovered.calls.every(call => call.method === 'GET'))
  assert.match(recovered.calls[0].url, /\/tasks\/task-recover$/)
})

test('Qwen confirmed task failure can be retried, but an invalid resume id never sends a request', async () => {
  const rejected = mockFetch(() => json({ output: { task_status: 'FAILED', message: 'model rejected prompt' } }))
  await assert.rejects(generateImage(channel('qwen', { options: { pollIntervalMs: 1 } }), request, { fetchImpl: rejected.fetchImpl, resumeTaskId: 'task-failed' }), error => error.requestMayHaveSucceeded === false)
  assert.equal(rejected.calls.length, 1)
  assert.equal(rejected.calls[0].method, 'GET')
  await assert.rejects(generateImage(channel('qwen'), request, { fetchImpl: rejected.fetchImpl, resumeTaskId: '../foreign' }), /任务编号/)
  assert.equal(rejected.calls.length, 1)
})

// ── RunningHub 云端 ComfyUI ─────────────────────────────────────────────
// 覆盖三条实测得来的行为，防回归：有编号时不能同时发 workflow（导出 JSON 里
// 带 %width% 这类占位符会被平台拒）、nodeInfoList 的节点推断、轮询 taskId 用字符串。

const rhWorkflow = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a very long default positive prompt', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'bad quality', clip: ['4', 1] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
  '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 7, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['3', 0] } },
}
const rhChannel = (extra = {}) => channel('runninghub', {
  baseUrl: 'https://www.runninghub.cn',
  ...extra,
  options: { workflowId: '1904136902449209346', workflowJson: JSON.stringify(rhWorkflow), ...(extra.options || {}) },
})

function rhFetch(outputsPayload = { code: 0, msg: 'success', data: [{ fileUrl: 'https://img.test/out.png', fileType: 'png', nodeId: '9' }] }) {
  const calls = []
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      const target = String(url)
      calls.push({ url: target, body: init.body ? JSON.parse(init.body) : null })
      if (target.endsWith('/task/openapi/create')) return json({ code: 0, msg: 'success', data: { taskId: '2111243484420239362' } })
      if (target.endsWith('/task/openapi/outputs')) return json(outputsPayload)
      if (target === 'https://img.test/out.png') return image(png)
      throw new Error('unexpected request ' + target)
    },
  }
}

test('RunningHub: 有工作流编号时不发送 workflow，并据此推断节点绑定', async () => {
  const { fetchImpl, calls } = rhFetch()
  const out = await generateImage(rhChannel(), request, { fetchImpl })
  const create = calls[0]

  assert.equal(create.url, 'https://www.runninghub.cn/task/openapi/create')
  assert.equal(create.body.apiKey, 'top-secret')
  assert.equal(create.body.workflowId, '1904136902449209346')
  assert.equal('workflow' in create.body, false, '有编号时不该把本地 JSON 发上去')
  // 提示词进内容最长的那个 CLIPTextEncode，负面进另一个；尺寸与采样各就各位
  const byKey = Object.fromEntries(create.body.nodeInfoList.map(x => [x.nodeId + '.' + x.fieldName, x.fieldValue]))
  assert.equal(byKey['6.text'], request.positive)
  assert.equal(byKey['7.text'], request.negative)
  assert.equal(byKey['5.width'], request.width)
  assert.equal(byKey['5.height'], request.height)
  assert.equal(byKey['3.seed'], request.seed)
  assert.equal(byKey['3.steps'], request.steps)
  assert.equal(byKey['3.cfg'], request.cfg)
  assert.equal(out.mediaType, 'image/png')
})

test('RunningHub: 只有本地 JSON 时才发送 workflow', async () => {
  const { fetchImpl, calls } = rhFetch()
  await generateImage(rhChannel({ options: { workflowId: '' } }), request, { fetchImpl })
  assert.equal(typeof calls[0].body.workflow, 'string')
  assert.equal('workflowId' in calls[0].body, false)
})

test('RunningHub: 轮询 taskId 原样发字符串（19 位，转数字会丢精度）', async () => {
  const { fetchImpl, calls } = rhFetch()
  await generateImage(rhChannel(), request, { fetchImpl })
  const poll = calls.find(x => x.url.endsWith('/task/openapi/outputs'))
  assert.equal(typeof poll.body.taskId, 'string')
  assert.equal(poll.body.taskId, '2111243484420239362')
})

test('RunningHub: 显式节点映射优先于自动推断', async () => {
  const { fetchImpl, calls } = rhFetch()
  await generateImage(rhChannel({ options: { nodeBindings: '{"prompt":[{"node":"7","input":"text"}]}' } }), request, { fetchImpl })
  const byKey = Object.fromEntries(calls[0].body.nodeInfoList.map(x => [x.nodeId + '.' + x.fieldName, x.fieldValue]))
  // 显式指定的节点必须收到正面词；负面的自动推断不能反过来顶掉它，
  // 而应该按 Avoid 写法并进同一个节点（没有独立负面节点时的既定行为）。
  const text = byKey['7.text']
  assert.ok(text.startsWith(request.positive), '显式映射的节点应收到正面词')
  assert.ok(text.includes('Avoid: ' + request.negative), '没有独立负面节点时并进同一节点')
})

test('RunningHub: 队列中(code 804)继续轮询，任务失败时报明确原因', async () => {
  let polls = 0
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url); calls.push(target)
    if (target.endsWith('/task/openapi/create')) return json({ code: 0, msg: 'success', data: { taskId: '1' } })
    if (target.endsWith('/task/openapi/outputs')) {
      polls++
      return polls === 1
        ? json({ code: 804, msg: 'APIKEY_TASK_IS_RUNNING', data: {} })
        : json({ code: 0, msg: 'success', data: [{ fileUrl: 'https://img.test/out.png', fileType: 'png' }] })
    }
    return image(png)
  }
  const out = await generateImage(rhChannel({ options: { pollIntervalMs: 1000 } }), request, { fetchImpl })
  assert.equal(polls, 2)
  assert.equal(out.mediaType, 'image/png')

  const failImpl = async (url) => String(url).endsWith('/task/openapi/create')
    ? json({ code: 0, msg: 'success', data: { taskId: '2' } })
    : json({ code: 805, msg: 'APIKEY_TASK_STATUS_ERROR', data: { failedReason: 'OOM' } })
  await assert.rejects(
    () => generateImage(rhChannel(), request, { fetchImpl: failImpl }),
    /RunningHub 任务失败/,
  )
})

test('RunningHub: 缺工作流或 Key 时给出可读的报错，测试连接只核对配置', async () => {
  await assert.rejects(() => generateImage(rhChannel({ options: { workflowId: '', workflowJson: '' } }), request, { fetchImpl: rhFetch().fetchImpl }), /请填 RunningHub 工作流编号/)
  await assert.rejects(() => generateImage(rhChannel({ apiKey: '' }), request, { fetchImpl: rhFetch().fetchImpl }), /没有填 API Key/)

  const noKey = await testImageChannel(channel('runninghub', { apiKey: '' }), { fetchImpl: rhFetch().fetchImpl })
  assert.equal(noKey.ok, false)
  assert.match(noKey.message, /API Key/)

  const ok = await testImageChannel(rhChannel(), { fetchImpl: rhFetch().fetchImpl })
  assert.equal(ok.ok, true)
  assert.equal(ok.status, 'configured', 'RunningHub 没有无计费探测接口，只能说配置已成形')
  assert.match(ok.message, /未提交任务/)
})
