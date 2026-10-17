import { inflateRawSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

const DEFAULT_MAX = 32 * 1024 * 1024
const DEFAULT_TIMEOUT = 300_000
const PROVIDERS = {
  novelai: ['NovelAI / 同协议第三方', 'https://image.novelai.net', 'nai-diffusion-4-5-full'],
  openai: ['OpenAI / Images 兼容中转', 'https://api.openai.com/v1', 'gpt-image-2.5-flare'],
  gemini: ['Google Gemini 原生', 'https://generativelanguage.googleapis.com/v1', 'gemini-3.1-flash-image'],
  'gemini-chat': ['Banana / Gemini 聊天兼容中转', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash-image'],
  grok: ['Grok Images', 'https://api.x.ai/v1', 'grok-imagine-image-2.0'],
  seedream: ['Seedream / 火山方舟', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seedream-5-0-pro-260628'],
  qwen: ['百炼 Qwen-Image', 'https://dashscope-intl.aliyuncs.com/api/v1', 'qwen-image-3.0'],
  sdwebui: ['Stable Diffusion WebUI / Forge', 'http://127.0.0.1:7860', ''],
  runninghub: ['RunningHub 云端 ComfyUI', 'https://www.runninghub.cn', '']
}

export const IMAGE_PROVIDERS = Object.entries(PROVIDERS).map(([id, [label, baseUrl, model]]) => ({ id, label, baseUrl, model }))

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const secretValues = channel => [channel?.apiKey, channel?.password].filter(Boolean).map(String)
function redact(text, channel) {
  let out = String(text ?? '').replace(/[\r\n\t]+/g, ' ')
  const secrets = secretValues(channel).flatMap(secret => [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')])
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]')
  return out.slice(0, 500)
}
function validateBase(channel) {
  let url
  try { url = new URL(channel?.baseUrl || PROVIDERS[channel?.provider]?.[1]) } catch { throw new Error('生图渠道地址必须是完整的 HTTP(S) 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('生图渠道地址必须是干净的 HTTP(S) 服务地址')
  return url.href.replace(/\/+$/, '')
}
function joinUrl(base, path) {
  if (/^https?:\/\//i.test(path) || String(path).startsWith('//')) throw new Error('接口路径必须是相对路径')
  return `${base.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`
}
function checkedRemoteUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('服务返回了无效的图片地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('服务返回了不安全的图片地址')
  return url.href
}
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const USER_AGENT = `dsh-tavern-image/${packageVersion}`

function authHeaders(channel, json = true) {
  const headers = json ? { 'content-type': 'application/json' } : {}
  if (channel.authMode === 'none') return headers
  if (channel.authMode === 'basic') {
    if (channel.username || channel.password) headers.authorization = `Basic ${Buffer.from(`${channel.username || ''}:${channel.password || ''}`).toString('base64')}`
    return headers
  }
  if (channel.apiKey) headers.authorization = `Bearer ${channel.apiKey}`
  return headers
}
function requestHeaders(channel, provider, json = true) {
  const headers = authHeaders(channel, json)
  headers['user-agent'] = USER_AGENT
  if (provider === 'gemini' && channel.authMode !== 'none' && channel.authMode !== 'basic' && channel.apiKey) {
    delete headers.authorization
    headers['x-goog-api-key'] = channel.apiKey
  }
  return headers
}
function bounded(value, min = 1, max = DEFAULT_MAX) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : max
}
function clampedNumber(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}
function imageType(bytes, declared = '') {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (declared && imageTypes.has(declared.toLowerCase().split(';')[0].trim())) throw new Error('服务返回的数据不是有效图片')
  throw new Error('服务没有返回受支持的图片格式')
}
async function readLimited(response, limit) {
  const size = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(size) && size > limit) throw new Error('服务响应超过允许大小')
  const reader = response.body?.getReader?.()
  if (reader) {
    const parts = []; let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > limit) { await reader.cancel().catch(() => {}); throw new Error('服务响应超过允许大小') }
        parts.push(Buffer.from(value))
      }
    } finally { reader.releaseLock?.() }
    return Buffer.concat(parts, total)
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length > limit) throw new Error('服务响应超过允许大小')
  return data
}
function abortScope(signal, timeoutMs = DEFAULT_TIMEOUT) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs)
  timer.unref?.()
  return { signal: controller.signal, close() { clearTimeout(timer); signal?.removeEventListener('abort', abort) } }
}
async function fetchBytes(fetchImpl, url, init, max, signal, channel) {
  const response = await fetchImpl(url, { ...init, redirect: 'error', signal })
  if (!response.ok) {
    const raw = await readLimited(response, Math.min(max, 64 * 1024)).catch(() => Buffer.alloc(0))
    let message = raw.toString('utf8')
    try { const j = JSON.parse(message); message = j.error?.message || j.message || j.detail || message } catch {}
    throw new Error(`生图服务 HTTP ${response.status}${message ? `：${redact(message, channel)}` : ''}`)
  }
  const bytes = await readLimited(response, max)
  const type = imageType(bytes, response.headers?.get?.('content-type') || '')
  return { bytes, mediaType: type }
}
async function fetchJson(fetchImpl, url, init, limit, signal, channel) {
  const response = await fetchImpl(url, { ...init, redirect: 'error', signal })
  const bytes = await readLimited(response, limit)
  if (!response.ok) {
    let message = bytes.toString('utf8')
    try { const j = JSON.parse(message); message = j.error?.message || j.message || j.detail || message } catch {}
    throw new Error(`生图服务 HTTP ${response.status}${message ? `：${redact(message, channel)}` : ''}`)
  }
  try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error('生图服务返回了无效 JSON') }
}
function combinedPrompt(request) {
  const prompt = String(request.positive ?? '').trim()
  const negative = String(request.negative ?? '').trim()
  return negative ? `${prompt}\n\nAvoid: ${negative}` : prompt
}
function dims(request) {
  const width = bounded(request.width ?? 1024, 64, 8192), height = bounded(request.height ?? 1024, 64, 8192)
  return { width, height }
}
function option(channel, name, fallback) {
  const value = channel.options?.[name]
  return value === undefined || value === null || (typeof value === 'string' && !value.trim()) ? fallback : value
}
function findImage(value, max) {
  if (typeof value !== 'string' || !value) return null
  const data = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/i)
  if (data) return decodeBase64(data[2], max, data[1])
  const md = value.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i)
  if (md) return { url: md[1] }
  const embedded = value.match(/data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+/i)
  if (embedded) return findImage(embedded[0], max)
  if (/^https?:\/\//i.test(value)) return { url: value }
  if (/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(value) && value.length > 100) return decodeBase64(value, max)
  return null
}
async function fetchRaw(fetchImpl, url, init, max, signal, channel) {
  const response = await fetchImpl(url, { ...init, redirect: 'error', signal })
  if (!response.ok) {
    const raw = await readLimited(response, Math.min(max, 64 * 1024)).catch(() => Buffer.alloc(0))
    throw new Error(`生图服务 HTTP ${response.status}${raw.length ? `：${redact(raw.toString('utf8'), channel)}` : ''}`)
  }
  return readLimited(response, max)
}
function decodeBase64(value, max, declared = '') {
  const clean = String(value).replace(/\s/g, '')
  if (clean.length > Math.ceil(max * 4 / 3) + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) throw new Error('服务返回的图片编码无效或过大')
  const bytes = Buffer.from(clean, 'base64')
  if (!bytes.length || bytes.length > max) throw new Error('服务返回的图片超过允许大小')
  return { bytes, mediaType: imageType(bytes, declared) }
}
async function fromDataObject(data, fetchImpl, max, signal, channel) {
  const item = Array.isArray(data) ? data[0] : data
  if (!item) throw new Error('生图服务没有返回图片')
  for (const key of ['b64_json', 'base64', 'image', 'data']) {
    if (typeof item[key] === 'string' && !/^https?:\/\//.test(item[key])) return decodeBase64(item[key], max, item.mime_type || item.mimeType || '')
  }
  const url = item.url || item.image_url?.url || item.image_url
  if (url) return fetchBytes(fetchImpl, checkedRemoteUrl(url), { method: 'GET', headers: {} }, max, signal, channel)
  throw new Error('生图服务没有返回可用图片数据')
}
function zipImage(bytes, max) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('NovelAI 返回了无效 ZIP 图片')
  let eocd = -1
  for (let i = Math.max(0, bytes.length - 65557); i <= bytes.length - 22; i++) if (bytes.readUInt32LE(i) === 0x06054b50) eocd = i
  if (eocd < 0) throw new Error('NovelAI ZIP 缺少目录')
  const count = bytes.readUInt16LE(eocd + 10), offset = bytes.readUInt32LE(eocd + 16)
  let cursor = offset
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('NovelAI ZIP 目录无效')
    const method = bytes.readUInt16LE(cursor + 10), packed = bytes.readUInt32LE(cursor + 20), unpacked = bytes.readUInt32LE(cursor + 24)
    const nameLen = bytes.readUInt16LE(cursor + 28), extraLen = bytes.readUInt16LE(cursor + 30), commentLen = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42)
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    if (/\.(png|jpe?g|webp|gif)$/i.test(name)) {
      if (unpacked > max || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('NovelAI 图片超过允许大小或 ZIP 无效')
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
      if (start + packed > bytes.length) throw new Error('NovelAI ZIP 图片数据损坏')
      let output
      try { output = method === 0 ? bytes.subarray(start, start + packed) : method === 8 ? inflateRawSync(bytes.subarray(start, start + packed), { maxOutputLength: max }) : null } catch { throw new Error('NovelAI ZIP 图片无法解压') }
      if (!output) throw new Error('NovelAI ZIP 使用了不支持的压缩格式')
      if (output.length > max || (unpacked && output.length !== unpacked)) throw new Error('NovelAI ZIP 图片大小校验失败')
      const image = Buffer.from(output)
      return { bytes: image, mediaType: imageType(image) }
    }
    cursor += 46 + nameLen + extraLen + commentLen
  }
  throw new Error('NovelAI ZIP 中没有图片')
}
function endpointFromOption(channel, key, fallback) { return String(option(channel, key, fallback)) }

async function generateNovelai(channel, request, ctx) {
  const { base, fetchImpl, signal, max, channel: ch } = ctx
  const { width, height } = requestedDims(ch, request)
  const positive = String(request.positive || ''), negative = String(request.negative || '')
  const payload = { input: String(request.positive || ''), model: ch.model || PROVIDERS.novelai[2], action: 'generate', parameters: {
    width, height, seed: Number.isFinite(Number(request.seed)) ? Number(request.seed) : Math.floor(Math.random() * 2 ** 32),
    steps: bounded(request.steps ?? option(ch, 'steps', 28), 1, 100), scale: clampedNumber(request.cfg ?? option(ch, 'cfg', option(ch, 'scale', 5)), 0, 30, 5), n_samples: 1,
    negative_prompt: negative, sampler: option(ch, 'sampler', 'k_euler_ancestral'), noise_schedule: option(ch, 'noiseSchedule', 'karras'),
    qualityToggle: true, ucPreset: 3, sm: false, dynamic_thresholding: false, params_version: 3,
    v4_prompt: { caption: { base_caption: positive, char_captions: [] }, use_coords: false, use_order: true },
    v4_negative_prompt: { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false },
    add_original_image: true, legacy: false, legacy_uc: false, controlnet_strength: 1
  } }
  const bytes = await fetchRaw(fetchImpl, joinUrl(base, endpointFromOption(ch, 'generatePath', '/ai/generate-image')), { method: 'POST', headers: requestHeaders(ch, 'novelai'), body: JSON.stringify(payload) }, Math.min(max + 1024 * 1024, 129 * 1024 * 1024), signal, ch)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return zipImage(bytes, max)
  return { bytes, mediaType: imageType(bytes) }
}

async function generateOpenai(channel, request, ctx, provider) {
  const { base, fetchImpl, signal, max, channel: ch, jsonLimit } = ctx
  const { width, height } = requestedDims(ch, request)
  const path = endpointFromOption(ch, 'generatePath', '/images/generations')
  const orientationSize = width > height * 1.15 ? '1536x1024' : height > width * 1.15 ? '1024x1536' : '1024x1024'
  const size = provider === 'seedream' ? option(ch, 'size', '2K') : option(ch, 'size', orientationSize)
  const payload = { model: ch.model || PROVIDERS[provider][2], prompt: combinedPrompt(request), size, n: 1 }
  if (provider === 'openai') {
    if (payload.model.startsWith('gpt-image-')) {
      payload.quality = option(ch, 'quality', 'medium')
      payload.output_format = option(ch, 'outputFormat', 'png')
    }
  }
  if (provider === 'grok') delete payload.size
  const data = await fetchJson(fetchImpl, joinUrl(base, path), { method: 'POST', headers: requestHeaders(ch, provider), body: JSON.stringify(payload) }, jsonLimit, signal, ch)
  return fromDataObject(data.data, fetchImpl, max, signal, ch)
}

async function generateGemini(channel, request, ctx) {
  const { base, fetchImpl, signal, max, channel: ch, jsonLimit } = ctx
  const model = encodeURIComponent(ch.model || PROVIDERS.gemini[2])
  const { width, height } = dims(request)
  const ratio = option(ch, 'aspectRatio', closestRatio(width, height))
  let imageSize = option(ch, 'imageSize', option(ch, 'size', sizeLabel(width, height)))
  const sizePixels = String(imageSize).match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i)
  if (sizePixels) imageSize = sizeLabel(Number(sizePixels[1]), Number(sizePixels[2]))
  const payload = { contents: [{ parts: [{ text: combinedPrompt(request) }] }], generationConfig: {
    responseModalities: ['IMAGE'], responseFormat: { image: { aspectRatio: ratio, imageSize } }
  } }
  const data = await fetchJson(fetchImpl, joinUrl(base, `/models/${model}:generateContent`), { method: 'POST', headers: requestHeaders(ch, 'gemini'), body: JSON.stringify(payload) }, jsonLimit, signal, ch)
  const parts = data.candidates?.flatMap(candidate => candidate.content?.parts || []) || []
  for (const part of parts) if (part.inlineData?.data || part.inline_data?.data) {
    const blob = part.inlineData || part.inline_data
    return decodeBase64(blob.data, max, blob.mimeType || blob.mime_type || '')
  }
  throw new Error('Gemini 没有返回图片内容')
}
function closestRatio(w, h) {
  const ratios = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9']
  return ratios.reduce((best, ratio) => Math.abs(Math.log(w / h / ratio.split(':').map(Number).reduce((a, b) => a / b))) < Math.abs(Math.log(w / h / best.split(':').map(Number).reduce((a, b) => a / b))) ? ratio : best, ratios[0])
}
function sizeLabel(w, h) { const pixels = w * h; return pixels > 7_000_000 ? '4K' : pixels > 2_000_000 ? '2K' : '1K' }
function requestedDims(channel, request) {
  let { width, height } = dims(request)
  const rawSize = String(option(channel, 'size', '')).trim()
  const match = rawSize.match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i)
  if (match) { width = bounded(match[1], 64, 8192); height = bounded(match[2], 64, 8192) }
  else {
    const tier = rawSize.match(/^(1|1\.5|2|4)\s*k$/i)
    if (tier) width = height = Number(tier[1]) * 1024
  }
  const ratio = String(option(channel, 'aspectRatio', '')).trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/)
  if (ratio) {
    const area = width * height, value = Number(ratio[1]) / Number(ratio[2])
    if (value > 0 && Number.isFinite(value)) {
      const unit = channel.provider === 'sdwebui' ? 8 : 64
      width = Math.max(64, Math.round(Math.sqrt(area * value) / unit) * unit)
      height = Math.max(64, Math.round(Math.sqrt(area / value) / unit) * unit)
    }
  }
  return { width, height }
}
async function generateGeminiChat(channel, request, ctx) {
  const { base, fetchImpl, signal, max, channel: ch, jsonLimit } = ctx
  const payload = { model: ch.model || PROVIDERS['gemini-chat'][2], messages: [{ role: 'user', content: combinedPrompt(request) }], n: 1 }
  const data = await fetchJson(fetchImpl, joinUrl(base, endpointFromOption(ch, 'generatePath', '/chat/completions')), { method: 'POST', headers: requestHeaders(ch, 'gemini-chat'), body: JSON.stringify(payload) }, jsonLimit, signal, ch)
  const message = data.choices?.[0]?.message || data
  const contents = [message.content, ...(Array.isArray(message.images) ? message.images.map(x => x.image_url?.url || x.url || x) : [])]
  for (const content of contents) {
    const parts = Array.isArray(content) ? content : [content]
    for (const part of parts) {
      const value = typeof part === 'string' ? part : (part.image_url?.url || part.url || part.text || part.image?.url || '')
      const found = findImage(value, max)
      if (found?.bytes) return found
      if (found?.url) return fetchBytes(fetchImpl, checkedRemoteUrl(found.url), { method: 'GET', headers: {} }, max, signal, ch)
    }
  }
  throw new Error('聊天兼容服务没有返回图片或图片地址')
}
async function generateQwen(channel, request, ctx) {
  const { base, fetchImpl, signal, max, channel: ch, jsonLimit } = ctx
  const { width, height } = dims(request)
  const legacyAsync = Boolean(ctx.resumeTaskId) || option(ch, 'apiMode', 'sync') === 'async'
  const payload = legacyAsync ? {
    model: ch.model || 'wanx-v1', input: { prompt: String(request.positive || '') }, parameters: { negative_prompt: String(request.negative || ''), size: `${width}*${height}`, n: 1 }
  } : {
    model: ch.model || PROVIDERS.qwen[2], input: { messages: [{ role: 'user', content: [{ text: String(request.positive || '') }] }] }, parameters: {
      negative_prompt: String(request.negative || ''), size: `${width}*${height}`, n: 1,
      ...(Number.isFinite(Number(request.seed)) ? { seed: ((Math.trunc(Number(request.seed)) % 2147483648) + 2147483648) % 2147483648 } : {})
    }
  }
  const path = endpointFromOption(ch, 'generatePath', legacyAsync ? '/services/aigc/text2image/image-synthesis' : '/services/aigc/multimodal-generation/generation')
  const headers = requestHeaders(ch, 'qwen')
  if (legacyAsync) headers['X-DashScope-Async'] = 'enable'
  const response = ctx.resumeTaskId ? { output: { task_id: ctx.resumeTaskId } }
    : await fetchJson(fetchImpl, joinUrl(base, path), { method: 'POST', headers, body: JSON.stringify(payload) }, jsonLimit, signal, ch)
  if (!legacyAsync) {
    const content = response.output?.choices?.[0]?.message?.content || []
    const image = content.find?.(part => part.image)?.image
    if (image) {
      const embedded = findImage(image, max)
      if (embedded?.bytes) return embedded
      return fetchBytes(fetchImpl, checkedRemoteUrl(embedded?.url || image), { method: 'GET', headers: {} }, max, signal, ch)
    }
    throw new Error(redact(response.message || response.code || 'Qwen-Image 没有返回图片', ch))
  }
  const taskId = response.output?.task_id
  if (!taskId) {
    const image = response.output?.choices?.[0]?.message?.content?.find?.(item => item.image)?.image
    if (image) return fetchBytes(fetchImpl, checkedRemoteUrl(image), { method: 'GET', headers: {} }, max, signal, ch)
    throw new Error(redact(response.message || response.code || 'DashScope 没有返回任务编号', ch))
  }
  await ctx.onTask?.({ provider: 'qwen', taskId: String(taskId) })
  const pollPath = endpointFromOption(ch, 'taskPath', '/tasks/')
  const deadline = Date.now() + bounded(option(ch, 'pollTimeoutMs', 240000), 1000, 600000)
  while (Date.now() < deadline) {
    await wait(bounded(option(ch, 'pollIntervalMs', 1500), 1, 30_000), signal)
    const task = await fetchJson(fetchImpl, joinUrl(base, `${pollPath.replace(/\/?$/, '/')}${encodeURIComponent(taskId)}`), { method: 'GET', headers: requestHeaders(ch, 'qwen', false) }, jsonLimit, signal, ch)
    const output = task.output || task
    if (['SUCCEEDED', 'succeeded', 'done', 'completed'].includes(output.task_status || output.status)) {
      const urls = output.results?.map(item => item.url) || output.choices?.flatMap(choice => choice.message?.content?.map(part => part.image).filter(Boolean) || []) || []
      if (urls[0]) return fetchBytes(fetchImpl, checkedRemoteUrl(urls[0]), { method: 'GET', headers: {} }, max, signal, ch)
      throw new Error('DashScope 任务完成但没有返回图片地址')
    }
    if (['FAILED', 'failed', 'CANCELED', 'cancelled'].includes(output.task_status || output.status)) {
      const error = new Error(redact(task.message || output.message || 'DashScope 生图任务失败', ch))
      error.providerDefinitiveFailure = true
      throw error
    }
  }
  throw new Error('DashScope 生图任务等待超时')
}
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || new Error('请求已取消'))
    const timer = setTimeout(done, ms)
    function done() { signal.removeEventListener('abort', abort); resolve() }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason || new Error('请求已取消')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
async function generateSdwebui(channel, request, ctx) {
  const { base, fetchImpl, signal, max, channel: ch, jsonLimit } = ctx
  const { width, height } = requestedDims(ch, request)
  const payload = { prompt: String(request.positive || ''), negative_prompt: String(request.negative || ''), width, height,
    steps: bounded(request.steps ?? option(ch, 'steps', 20), 1, 200), cfg_scale: clampedNumber(request.cfg ?? option(ch, 'cfg', 7), 0, 50, 7), seed: Number.isFinite(Number(request.seed)) ? Number(request.seed) : -1, sampler_name: option(ch, 'sampler', 'Euler a'), batch_size: 1 }
  const data = await fetchJson(fetchImpl, joinUrl(base, endpointFromOption(ch, 'generatePath', '/sdapi/v1/txt2img')), { method: 'POST', headers: requestHeaders(ch, 'sdwebui'), body: JSON.stringify(payload) }, jsonLimit, signal, ch)
  if (!Array.isArray(data.images) || !data.images[0]) throw new Error('SD WebUI 没有返回图片')
  return decodeBase64(String(data.images[0]).replace(/^data:image\/[^;]+;base64,/i, ''), max)
}

export async function generateImage(channel, request, { signal, fetchImpl = globalThis.fetch, maxImageBytes = DEFAULT_MAX, onTask, resumeTaskId } = {}) {
  if (!channel || !PROVIDERS[channel.provider]) throw new Error('不支持的生图渠道')
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有可用的网络请求功能')
  const base = validateBase(channel), max = bounded(maxImageBytes, 1024, 128 * 1024 * 1024)
  const jsonLimit = Math.min(192 * 1024 * 1024, max * 2 + 1024 * 1024)
  if (resumeTaskId && (!['qwen', 'runninghub'].includes(channel.provider) || typeof resumeTaskId !== 'string' || resumeTaskId.length > 200 || !/^[\w-]+$/.test(resumeTaskId))) throw new Error('无效的平台任务编号')
  const scope = abortScope(signal, bounded(channel.options?.timeoutMs, 1000, 600_000))
  let sentGeneration = Boolean(resumeTaskId)
  let generationStatus = resumeTaskId ? 200 : null
  const trackedFetch = async (url, init = {}) => {
    if (scope.signal.aborted) throw scope.signal.reason || new Error('请求已取消')
    const generation = String(init.method ?? 'GET').toUpperCase() === 'POST'
    if (generation) sentGeneration = true
    const response = await fetchImpl(url, init)
    if (generation) generationStatus = response.status
    return response
  }
  const ctx = { base, fetchImpl: trackedFetch, signal: scope.signal, max, jsonLimit, channel, onTask, resumeTaskId }
  try {
    if (channel.provider === 'novelai') return await generateNovelai(channel, request, ctx)
    if (channel.provider === 'openai' || channel.provider === 'grok' || channel.provider === 'seedream') return await generateOpenai(channel, request, ctx, channel.provider)
    if (channel.provider === 'gemini') return await generateGemini(channel, request, ctx)
    if (channel.provider === 'gemini-chat') return await generateGeminiChat(channel, request, ctx)
    if (channel.provider === 'qwen') return await generateQwen(channel, request, ctx)
    if (channel.provider === 'runninghub') return await generateRunningHub(channel, request, ctx)
    return await generateSdwebui(channel, request, ctx)
  } catch (error) {
    const message = scope.signal.aborted && !signal?.aborted ? '生图请求超时' : redact(error.message || '生图请求失败', channel)
    const failure = new Error(message)
    // A lost POST response or a later image-download error does not prove the
    // paid generation failed. Never silently turn it into a safe-to-retry job.
    failure.requestMayHaveSucceeded = error.providerDefinitiveFailure !== true && sentGeneration && (generationStatus === null || generationStatus >= 500 || generationStatus < 400)
    throw failure
  } finally { scope.close() }
}

export async function testImageChannel(channel, { signal, fetchImpl = globalThis.fetch } = {}) {
  if (!channel || !PROVIDERS[channel.provider]) throw new Error('不支持的生图渠道')
  const base = validateBase(channel)
  // RunningHub 没有无计费只读探测接口，只能核对配置是否成形。
  if (channel.provider === 'runninghub') return testRunningHubChannel(channel, base, fetchImpl)
  const safePaths = { novelai: '/user/subscription', openai: '/models', grok: '/models', 'gemini-chat': '/models', gemini: '/models', sdwebui: '/sdapi/v1/sd-models' }
  const path = safePaths[channel.provider] && endpointFromOption(channel, 'testPath', safePaths[channel.provider])
  if (!path) return { ok: true, status: 'configured', message: '地址和渠道参数已配置；此服务没有可安全探测的无计费接口。' }
  const scope = abortScope(signal, 8000)
  try {
    const headers = requestHeaders(channel, channel.provider)
    const response = await fetchImpl(joinUrl(base, path), { method: 'GET', headers, redirect: 'error', signal: scope.signal })
    if (!response.ok) return { ok: false, status: 'reachable', message: `服务已响应 HTTP ${response.status}` }
    const bytes = await readLimited(response, 2 * 1024 * 1024)
    let parsed = null; try { parsed = JSON.parse(bytes.toString('utf8')) } catch {}
    if (!parsed) return { ok: false, status: 'reachable', message: '服务已响应，但返回内容不是有效 JSON。' }
    const models = channel.provider === 'sdwebui'
      ? (Array.isArray(parsed) ? parsed.map(x => x && typeof x === 'object' ? x.model_name : null).filter(Boolean) : [])
      : (Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : []).map(x => x && typeof x === 'object' ? x.id || x.name : null).filter(Boolean)
    return { ok: true, status: 'reachable', message: '连接正常。', ...(models.length ? { models: models.slice(0, 200) } : {}) }
  } catch (error) {
    if (signal?.aborted) throw error
    return { ok: false, status: 'configured', message: redact(error.message || '连接失败', channel) }
  } finally { scope.close() }
}

/* ============================================================================
 * RunningHub 云端 ComfyUI
 *
 * 和本地 ComfyUI 的差别：不经 /prompt + /history，而是走平台的开放接口 ——
 *   POST {base}/task/openapi/create   提交任务（apiKey 写在请求体里）
 *   POST {base}/task/openapi/outputs  轮询结果（Authorization: Bearer）
 * 文档写明了接口要求 Host 头与域名一致（www.runninghub.ai / www.runninghub.cn），
 * Node 的 fetch 会自己按 URL 填 Host，不要手写，否则重复头反而被拒。
 *
 * 工作流二选一：
 *   · 平台工作流编号 workflowId（在 RunningHub 里通过 API 调用的那个 ID）
 *   · 本地 API 格式工作流 JSON（直接塞进 create 的 workflow 字段，覆盖 workflowId）
 *     注意 ComfyUI 界面导出的「画布格式」不能直接用：本地 ComfyUI 收到那种格式
 *     会自动从 /object_info 补输入，RunningHub 的 REST 接口不会补。所以本地 JSON
 *     走 RunningHub 时，每个节点必须自带完整 inputs。
 *
 * 参数怎么进工作流：nodeBindings 是「角色 → 节点字段」的映射，形如
 *   {"prompt":[{"node":"6","input":"text"}],"negative":[{"node":"7","input":"text"}]}
 * 没配某个角色时，按工作流 JSON 自动认：提示词写进内容最长的 CLIPTextEncode（正面），
 * 其余 CLIPTextEncode 当负面；尺寸找 EmptyLatentImage / 名字带 width、height 的节点；
 * KSampler 的 seed / steps / cfg 也认。自动认不准就以显式映射为准。
 * 正向提示词里出现 <name> 时，自动切分写进多个节点，实现正面 / 负面分流。
 * ========================================================================== */

const RUNNINGHUB_MAX_WORKFLOW_BYTES = 2 * 1024 * 1024
const RUNNINGHUB_DEFAULT_POLL_MS = 5000
const RUNNINGHUB_MIN_POLL_MS = 1000

function runninghubOption(channel, name, fallback) {
  const value = channel.options?.[name]
  return value === undefined || value === null || (typeof value === 'string' && !value.trim()) ? fallback : value
}

function runninghubNumber(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback
}

/** 把 nodeBindings 收成 { prompt: [{node, input}], ... }，非法项直接丢掉。 */
function runninghubBindings(channel) {
  const raw = runninghubOption(channel, 'nodeBindings', null)
  const source = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { throw new Error('节点映射不是合法的 JSON') } })() : raw
  if (source === null || source === undefined) return {}
  if (typeof source !== 'object' || Array.isArray(source)) throw new Error('节点映射必须是对象')
  const out = {}
  for (const [role, list] of Object.entries(source)) {
    const items = Array.isArray(list) ? list : [list]
    const cleaned = items
      .filter(item => item && item.node !== undefined && item.node !== null && String(item.node).trim())
      .map(item => ({ node: String(item.node).trim(), input: String(item.input ?? 'text').trim() || 'text' }))
      .slice(0, 20)
    if (cleaned.length) out[role] = cleaned
  }
  return out
}

function runninghubWorkflowNodes(workflow) {
  const nodes = workflow?.prompt && typeof workflow.prompt === 'object' ? workflow.prompt : workflow
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return {}
  const out = {}
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object') continue
    if (typeof node.class_type !== 'string' && typeof node.classType !== 'string') continue
    out[String(id)] = {
      classType: String(node.class_type ?? node.classType),
      inputs: node.inputs && typeof node.inputs === 'object' ? node.inputs : {},
    }
  }
  return out
}

/** 从工作流 JSON 猜节点角色。猜不出来就不塞，宁可让用户显式配。 */
function runninghubInferBindings(nodes, includeNegative) {
  const ids = Object.keys(nodes)
  const roles = {}
  const textNodes = ids.filter(id => nodes[id].classType === 'CLIPTextEncode')
  if (textNodes.length) {
    const weight = id => String(nodes[id].inputs?.text ?? '').length
    const sorted = [...textNodes].sort((a, b) => weight(b) - weight(a))
    const positive = (sorted.find(id => /positive|pos\b/i.test(String(nodes[id].inputs?.text ?? ''))) ) || sorted[0]
    roles.prompt = [{ node: positive, input: 'text' }]
    if (includeNegative && sorted.length > 1) roles.negative = [{ node: sorted[1], input: 'text' }]
  }
  const latent = ids.find(id => nodes[id].classType === 'EmptyLatentImage')
  if (latent) roles.size = [{ node: latent, input: 'width' }, { node: latent, input: 'height' }]
  else {
    const widthNode = ids.find(id => 'width' in nodes[id].inputs)
    const heightNode = ids.find(id => 'height' in nodes[id].inputs)
    if (widthNode || heightNode) roles.size = [
      ...(widthNode ? [{ node: widthNode, input: 'width' }] : []),
      ...(heightNode ? [{ node: heightNode, input: 'height' }] : []),
    ]
  }
  const sampler = ids.find(id => /KSampler|SamplerCustom/.test(nodes[id].classType))
  if (sampler) {
    roles.seed = [{ node: sampler, input: 'seed' }]
    if ('steps' in nodes[sampler].inputs) roles.steps = [{ node: sampler, input: 'steps' }]
    if ('cfg' in nodes[sampler].inputs) roles.cfg = [{ node: sampler, input: 'cfg' }]
  }
  return roles
}

function runninghubBuildNodeInfoList(channel, request, workflow, explicit) {
  const nodes = runninghubWorkflowNodes(workflow)
  const roles = { ...explicit }
  const inferred = runninghubInferBindings(nodes, !roles.negative)
  for (const key of Object.keys(inferred)) if (!roles[key]) roles[key] = inferred[key]

  const overrides = []
  const add = (nodeId, fieldName, fieldValue) => {
    if (nodeId === undefined || nodeId === null) return
    overrides.push({ nodeId: String(nodeId), fieldName: String(fieldName || 'text'), fieldValue })
  }

  // 正面 / 负面分流：配了 negative 映射就各写各的；没配就把负面词并进正面那个节点
  // （combinedPrompt 的 Avoid 写法），保持和其他渠道一致的观感。
  const positive = String(request.positive ?? '').trim()
  const negative = String(request.negative ?? '').trim()
  const positiveTargets = roles.prompt || []
  const negativeTargets = roles.negative || []
  if (positiveTargets.length && negativeTargets.length) {
    for (const binding of positiveTargets) add(binding.node, binding.input, positive)
    for (const binding of negativeTargets) add(binding.node, binding.input, negative)
  } else {
    const text = combinedPrompt(request)
    if (positiveTargets.length) for (const binding of positiveTargets) add(binding.node, binding.input, text)
    else if (!Object.keys(nodes).length && !text) add(null, 'text', text)
  }

  const width = bounded(request.width ?? 1024, 64, 8192), height = bounded(request.height ?? 1024, 64, 8192)
  const sizeOption = String(runninghubOption(channel, 'size', '') ?? '')
  const sizeMatch = sizeOption.match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i)
  const finalWidth = sizeMatch ? runninghubNumber(sizeMatch[1], 64, 8192, width) : width
  const finalHeight = sizeMatch ? runninghubNumber(sizeMatch[2], 64, 8192, height) : height
  for (const binding of roles.size || []) {
    if (binding.input === 'width') add(binding.node, binding.input, finalWidth)
    else if (binding.input === 'height') add(binding.node, binding.input, finalHeight)
  }
  if (Number.isFinite(Number(request.seed))) {
    const seed = Math.floor(Number(request.seed))
    for (const binding of roles.seed || []) add(binding.node, binding.input, seed)
  }
  if (Number.isFinite(Number(request.steps))) {
    for (const binding of roles.steps || []) add(binding.node, binding.input, runninghubNumber(request.steps, 1, 200, 20))
  }
  if (Number.isFinite(Number(request.cfg))) {
    for (const binding of roles.cfg || []) add(binding.node, binding.input, Number(request.cfg))
  }

  // 同一节点同一字段以最后一次为准。
  const merged = new Map()
  for (const item of overrides) merged.set(item.nodeId + '\u0000' + item.fieldName, item)
  return [...merged.values()]
}

/** 本地 JSON 里若有 ComfyUI 的可变占位符（%width% / {seed} 之类），发上来会被平台拒。 */
const RUNNINGHUB_PLACEHOLDER = /%\s*[a-z_][a-z0-9_]*\s*%|\{\s*[a-z_][a-z0-9_]*\s*\}/i

function runninghubWorkflowPayload(channel) {
  const inline = runninghubOption(channel, 'workflowJson', '')
  const workflowId = String(runninghubOption(channel, 'workflowId', '') || '').trim()
  const text = typeof inline === 'string' ? inline.trim() : JSON.stringify(inline)
  let workflow = null
  let placeholders = false
  if (text) {
    if (Buffer.byteLength(text, 'utf8') > RUNNINGHUB_MAX_WORKFLOW_BYTES) throw new Error('工作流 JSON 超过 2 MB，请改用平台工作流编号')
    try { workflow = JSON.parse(text) } catch { throw new Error('工作流 JSON 不是合法 JSON') }
    placeholders = RUNNINGHUB_PLACEHOLDER.test(text)
  }
  if (!workflow && !workflowId) throw new Error('请填 RunningHub 工作流编号，或粘贴一份工作流 JSON')
  if (workflowId && !/^[\w-]{1,64}$/.test(workflowId)) throw new Error('工作流编号只能包含字母、数字、下划线和连字符')
  // 实测结论：两者同时发时，平台会采用 workflow，而导出的 JSON 常带 %width% 这类可变
  // 占位符（平台界面对话框里替换），一提交就 prompt_outputs_failed_validation。
  // 平台自己存的工作流定义是干净的，所以有编号就只发编号，JSON 退居推断节点之用。
  const useInline = !workflowId
  return { workflow: useInline ? workflow : null, workflowId, localWorkflow: workflow, placeholders }
}

function runninghubAccessPassword(channel) {
  const password = String(channel.password ?? '').trim()
  return password || undefined
}

/** create 请求体。apiKey 按 RunningHub 文档写在 body 里。 */
function runninghubCreatePayload(channel, request, explicit) {
  const { workflow, workflowId, localWorkflow } = runninghubWorkflowPayload(channel)
  const payload = { apiKey: String(channel.apiKey ?? '').trim() }
  if (workflow) payload.workflow = JSON.stringify(workflow)
  else {
    // 有编号时也要显式带上：实测只发 workflow 会被平台的必填校验拒掉（must not be null）。
    if (workflowId) payload.workflowId = workflowId
  }
  // 节点推断仍按本地 JSON 走（若填了），它的节点结构就是从平台导出的那一份。
  const inferenceSource = localWorkflow || workflow || {}
  const accessPassword = runninghubAccessPassword(channel)
  if (accessPassword) payload.accessPassword = accessPassword
  const nodeInfoList = runninghubBuildNodeInfoList(channel, request, inferenceSource, explicit)
  if (nodeInfoList.length) payload.nodeInfoList = nodeInfoList
  const instanceType = String(runninghubOption(channel, 'instanceType', '') || '').trim()
  if (['default', 'plus', 'ultra'].includes(instanceType)) payload.instanceType = instanceType
  const model = String(channel.model ?? '').trim()
  if (model) payload.workflowLabel = model
  return payload
}

async function testRunningHubChannel(channel, base, fetchImpl) {
  if (!String(channel.apiKey ?? '').trim()) return { ok: false, status: 'configured', message: '还没有填 API Key。' }
  try {
    const { workflow, workflowId, localWorkflow, placeholders } = runninghubWorkflowPayload(channel)
    const nodes = runninghubWorkflowNodes(localWorkflow || workflow || {})
    const count = Object.keys(nodes).length
    const used = workflowId ? '平台工作流 ' + workflowId : '本地工作流 ' + count + ' 个节点'
    const notes = []
    if (workflowId && localWorkflow) notes.push('编号和 JSON 都填了，出图时用平台那一份；JSON 只用来认节点（共 ' + count + ' 个）')
    else if (workflowId) notes.push('没有本地 JSON，节点按平台工作流的默认结构走；提示词 / 尺寸要显式填节点字段映射才生效')
    if (placeholders && !workflowId) notes.push('⚠️ 这份 JSON 里有 %width% 这类可变占位符，平台会直接拒（433）。请在 RunningHub 里用工作流编号，或把占位符换成真实数值')
    return { ok: true, status: 'configured', message: '参数已成形：' + used + '。' + (notes.length ? notes.join('；') + '。' : '') + 'RunningHub 没有无计费的只读探测接口，未提交任务；实际能否出图要跑一次才知道。' }
  } catch (error) {
    return { ok: false, status: 'configured', message: redact(error.message || '配置不完整', channel) }
  }
}

export const RUNNINGHUB_ERROR_HINTS = {
  400: '请求参数不完整或工作流编号无效',
  401: 'API Key 无效或与当前域名（.cn / .ai）不匹配',
  433: '工作流配置错误',
  804: '任务还在排队或执行中',
  805: '任务失败',
  806: '任务已取消',
  807: '工作流 JSON 无法解析',
  808: '非法的工作流 JSON',
  809: '工作流节点字段不存在',
  810: '工作流节点字段类型不匹配',
  811: 'API Key 被占用',
  812: '账号并发已满（稍后重试不收额外费用）',
  813: '任务正在运行，状态待确认',
  814: '个人队列已满（上限 1000 条）',
  815: '余额不足',
  816: '机器不足，任务排队中',
  817: '无权限运行该工作流',
  818: '非法参数',
  819: '登录失败',
  820: '提交参数过长',
  821: '任务不存在',
  822: '账号被冻结',
}

function runninghubMessage(payload, fallback) {
  const code = Number(payload?.code)
  const text = String(payload?.msg ?? payload?.message ?? '').trim()
  const hint = RUNNINGHUB_ERROR_HINTS[code]
  if (hint) return text ? `${hint}（${text}）` : hint
  return text || fallback
}

function runninghubDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('已取消')); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('已取消')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function generateRunningHub(channel, request, ctx) {
  const { base, fetchImpl, signal, max, onTask, resumeTaskId } = ctx
  const apiKey = String(channel.apiKey ?? '').trim()
  if (!apiKey) throw new Error('RunningHub 渠道没有填 API Key')

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  const explicit = runninghubBindings(channel)

  // 首次提交；失败就是失败，不能当成「可能已扣费」。
  if (resumeTaskId) {
    if (typeof onTask === 'function') onTask({ provider: 'runninghub', taskId: String(resumeTaskId) })
  }
  let taskId = resumeTaskId ? String(resumeTaskId) : ''
  if (!taskId) {
    let payload
    try { payload = runninghubCreatePayload(channel, request, explicit) } catch (error) { throw new Error(error.message) }
    const created = await fetchJson(fetchImpl, joinUrl(base, '/task/openapi/create'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal,
    }, ctx.jsonLimit, signal, channel).catch(error => { throw error })
    if (Number(created?.code) !== 0 || !created?.data?.taskId) {
      const failure = new Error('RunningHub 提交失败：' + runninghubMessage(created, '没有返回任务编号'))
      // 明确被拒 = 没有受理，不算「可能已扣费」。
      failure.providerDefinitiveFailure = true
      throw failure
    }
    taskId = String(created.data.taskId)
    if (typeof onTask === 'function') onTask({ provider: 'runninghub', taskId })
  }

  const interval = runninghubNumber(runninghubOption(channel, 'pollIntervalMs', RUNNINGHUB_DEFAULT_POLL_MS), RUNNINGHUB_MIN_POLL_MS, 60_000, RUNNINGHUB_DEFAULT_POLL_MS)
  const deadline = Number.isFinite(Number(channel.options?.timeoutMs))
    ? Date.now() + runninghubNumber(channel.options.timeoutMs, 1000, 600_000, DEFAULT_TIMEOUT)
    : Infinity
  while (true) {
    if (signal?.aborted) throw signal.reason || new Error('已取消')
    // taskId 原样发字符串：平台编号是 19 位，转成 Number 会丢精度（...898754 → ...898800），
    // 那样永远匹配不到任务。实测字符串形式平台接受。
    const body = { apiKey, taskId }
    const password = runninghubAccessPassword(channel)
    if (password) body.accessPassword = password
    const result = await fetchJson(fetchImpl, joinUrl(base, '/task/openapi/outputs'), {
      method: 'POST', headers: authHeaders, body: JSON.stringify(body), redirect: 'error', signal,
    }, ctx.jsonLimit, signal, channel)
    const code = Number(result?.code)
    if (code === 0) {
      const items = Array.isArray(result.data) ? result.data : []
      const image = items.find(item => item && typeof item.fileUrl === 'string' && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(item.fileUrl))
        || items.find(item => item && typeof item.fileUrl === 'string')
      if (!image) throw new Error('RunningHub 任务已完成，但没有返回图片（这个工作流可能只输出视频或其他文件）')
      const url = checkedRemoteUrl(image.fileUrl)
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal })
      if (!response.ok) throw new Error(`下载出的图片失败 HTTP ${response.status}`)
      const bytes = await readLimited(response, max)
      if (!bytes.length) throw new Error('RunningHub 返回了空图片')
      return { bytes, mediaType: imageType(bytes, String(image.fileType ?? '').includes('jpeg') ? 'image/jpeg' : '') }
    }
    // 804 = 排队/执行中，816 = 机器不足排队中，都是「继续等」。
    if (code === 804 || code === 816) {
      if (Date.now() >= deadline) throw new Error('RunningHub 任务等待超时（任务可能仍在平台执行，先到平台核对再决定是否重跑）')
      await runninghubDelay(interval, signal)
      continue
    }
    const failure = new Error('RunningHub 任务失败：' + runninghubMessage(result, '未知错误'))
    if (code === 805 || code === 806 || code === 821) failure.providerDefinitiveFailure = true
    throw failure
  }
}

