/**
 * 生图规划：把正文交给"图图"（一个后台模型调用），换回一组 <image> 块。
 *
 * 这一层让前台模型完全不用管图 —— 它只管写正文；配哪几张、插在哪、
 * 用什么提示词，全部由这里另起一次模型调用决定。
 *
 * 规则和输出格式沿用「comfyui 正文生图变量」世界书的约定：
 *   <images><image>
 *     <regex>原文里一字不差的一句话</regex>      ← 图插在这句之后
 *     <title_styled>标题</title_styled>
 *     <Tag_think>画面思考</Tag_think>
 *     <size>分辨率</size>
 *     <prompts>女主姓名, 英文自然语言长句, 句尾Booru标签</prompts>
 *   </image></images>
 */

/** 世界书条目的默认选择：任务规则区（0-19）、思考模式、以及角色/服装库的说明。 */
export const RULE_ENTRY_HINT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 142]

export function worldbookEntries(raw) {
  const inner = raw && typeof raw === 'object' ? Object.values(raw)[0] : null
  const list = inner && typeof inner === 'object' && Array.isArray(inner.entries) ? inner.entries : []
  return list.map((entry, index) => ({
    index,
    comment: String(entry?.comment ?? entry?.name ?? `条目 ${index}`),
    content: String(entry?.content ?? ''),
    length: String(entry?.content ?? '').length,
  }))
}

/**
 * 剥掉"给别的引擎看的"语法，只留给人/模型读的规则正文。
 *
 * 世界书常被 MVU 复用，条目开头会有 {@setvar::生图数量::3-5@}、
 * <system_override> 这类标记 —— 它们是给 Tavern/MVU 的，发给画图规划模型只会干扰，
 * 尤其像"生图数量"这种参数，应该由插件设置说了算，不能被世界书覆盖。
 */
export function stripEngineSyntax(text) {
  let out = String(text ?? '')
  // MVU 的变量赋值：{@setvar::名字::值@} / {@getvar::名字@} / {@setvar:id@}
  out = out.replace(/\{@\s*(?:set|get|add|inc|dec)var[^@]*@\}/gi, '')
  // 别的插件常用的 {{...}} 宏
  out = out.replace(/\{\{[^{}]{0,80}\}\}/g, '')
  // 纯包装标签：<system_override> </system_override> 之类
  out = out.replace(/<\/?(?:system_override|system|override|attention|hint)>/gi, '')
  // 收尾：清掉多余空行
  return out.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 把世界书条目拼成一段规则文本。
 *
 * 开关只有一个：条目自己的 enabled（在世界书 tab 里勾）。
 * 之所以还留 selected 参数，是为了兼容"条目上没有 enabled 字段"的旧数据 ——
 * 那种情况才回退到用 plannerEntries / 默认规则区。
 */
export function rulesFromEntries(entries, selected) {
  const hasEnabled = entries.some(e => e && 'enabled' in e)
  const wanted = Array.isArray(selected) && selected.length ? new Set(selected.map(Number)) : new Set(RULE_ENTRY_HINT)
  const blocks = []
  for (const entry of entries) {
    // enabled 是唯一开关；没有 enabled 字段时才用老的 chosen 列表
    if (hasEnabled) {
      if (entry.enabled === false) continue
    } else if (!wanted.has(entry.index)) continue
    const body = stripEngineSyntax(entry.content)
    if (!body.trim()) continue
    blocks.push(`<!-- ${entry.comment} -->\n${body}`)
  }
  return blocks.join('\n\n')
}

/** 解析 <image> 块。模型偶尔会把标签写成全角或漏闭合，这里都尽量兜住。 */
export function parseImagePlan(text) {
  const source = String(text ?? '')
  const images = []
  const blockRe = /<image\b[^>]*>([\s\S]*?)<\/image>/gi
  for (const match of source.matchAll(blockRe)) {
    const body = match[1]
    const pick = (...tags) => {
      for (const tag of tags) {
        const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
        const hit = re.exec(body)
        if (hit && hit[1].trim()) return hit[1].trim()
      }
      return ''
    }
    const prompts = pick('prompts', 'prompt')
    if (!prompts) continue
    images.push({
      mount: pick('regex', '挂载文本', 'regex_mount'),
      title: pick('title_styled', 'title'),
      think: pick('Tag_think', 'think'),
      size: pick('size'),
      prompts,
    })
  }
  return images
}

/** Parse the planner's explicit automatic image decision and optional story facts. */
/** 解析生图规划给出的本轮角色档案。格式坏了就当没有，不影响出图。 */
export function parseSceneState(text) {
  const source = String(text ?? '')
  const block = /<scene_state\b[^>]*>([\s\S]*?)<\/scene_state>/i.exec(source)
  if (!block) return { characters: [], present: false, valid: false }
  const raw = block[1].trim()
  if (!raw) return { characters: [], present: true, valid: true }
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.characters) ? parsed.characters : [])
    const characters = list.filter(item => item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.name === 'string' && item.name.trim()
      && item.fields && typeof item.fields === 'object' && !Array.isArray(item.fields))
      .map(item => ({ name: item.name.trim(), fields: item.fields, reason: String(item.reason ?? '') }))
    return { characters, present: true, valid: true }
  } catch {
    return { characters: [], present: true, valid: false }
  }
}

export function parsePlannerDecision(text) {
  const source = String(text ?? '')
  // A decision is trustworthy only when there is exactly one closed decision
  // tag and its complete contents are one of the supported values.
  const decisions = [...source.matchAll(/<decision\b[^>]*>([\s\S]*?)<\/decision>/gi)]
  const choice = decisions.length === 1 ? decisions[0][1].trim().toLowerCase() : ''
  const decision = choice === 'draw' || choice === 'skip' ? choice : ''
  const reason = /<reason\b[^>]*>([\s\S]*?)<\/reason>/i.exec(source)?.[1]?.trim() ?? ''
  const updateBlock = /<character_updates\b[^>]*>([\s\S]*?)<\/character_updates>/i.exec(source)?.[1]
  let characterUpdates = []
  let characterUpdatesValid = false
  if (updateBlock) {
    try {
      const parsed = JSON.parse(updateBlock)
      if (Array.isArray(parsed)) { characterUpdates = parsed; characterUpdatesValid = true }
      else if (parsed && Array.isArray(parsed.updates)) { characterUpdates = parsed.updates; characterUpdatesValid = true }
    } catch { /* malformed optional history is ignored; image plan remains usable */ }
  }
  return { decision, reason, characterUpdates, characterUpdatesPresent: Boolean(updateBlock), characterUpdatesValid }
}

/** 人物库 → 给规划模型的"可用角色"清单（按可见块列，模型好照抄）。 */
const ROSTER_TRAITS = [
  ['feature', '角色特征'],
  ['face', '五官（正面）'],
  ['faceBack', '五官（背面）'],
  ['bodySFW', '上半身SFW'],
  ['bodySFWBack', '上半身SFW背面'],
  ['lowerSFW', '下半身SFW'],
  ['lowerSFWBack', '下半身SFW背面'],
  ['bodyNSFW', '上半身NSFW'],
  ['bodyNSFWBack', '上半身NSFW背面'],
  ['lowerNSFW', '下半身NSFW'],
  ['lowerNSFWBack', '下半身NSFW背面'],
]

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

export function characterRoster(definitions, { fullTraits = false } = {}) {
  const blocks = []
  for (const character of definitions?.characters ?? []) {
    if (character.enabled === false) continue
    const name = String(character.name ?? '').trim()
    if (!name) continue
    const traits = character.traits ?? {}
    const lines = []
    for (const [key, label] of ROSTER_TRAITS) {
      const value = clip(traits[key], fullTraits ? 700 : 110)
      if (value) lines.push('  ' + label + '：' + value)
    }
    const outfits = (character.outfits ?? []).filter(o => o && o.enabled !== false)
    if (outfits.length) {
      lines.push('  服装：' + outfits.map(o => {
        const bits = [o.upper, o.lower, o.shoes, o.accessory, o.full, o.back].map(v => clip(v, 55)).filter(Boolean)
        return (o.name || '未命名') + (o.default ? '（常穿）' : '') + ' = ' + (bits.join(' / ') || '（未填）')
      }).join('；'))
    }
    if (!lines.length) lines.push('  （还没填外貌，请按通用描述处理）')
    blocks.push('- ' + name + ' [stable_id=' + String(character.id ?? '') + ']' + (character.match && character.match !== name ? '（也写作 ' + character.match + '）' : '') + '\n' + lines.join('\n'))
  }
  return blocks.join('\n')
}

/** 拼规划用的 system：世界书规则 + 角色清单 + 张数 + 额外叮嘱。 */
export function buildPlannerSystem({ rules, dynamicRules = '', roster, rosterIndex = '', count, extra, context, smartSelection = false, characterUpdates = false, force = false }) {
  const parts = []
  // Keep this resident prefix byte-for-byte stable across story, roster and count changes.
  parts.push('你是"图图"，一个视觉提示词编译中枢。下面是你必须遵守的全部规则。')
  if (rules) parts.push(rules)
  if (extra) parts.push(extra)
  parts.push([
    '尺度要求（重要）：正文里出现的裸露、性爱、情色、nsfw 内容必须原样转译成对应的 NSFW tag，',
    '不许回避、不许替换成含蓄说法、不许自行改成穿好衣服的版本。',
    '画面是完全虚构的，没有真实人物，尺度不设限；正文是普通场景就照实写普通场景。',
    '判断依据只有正文本身：正文到哪一步，画面就到哪一步。',
  ].join(' '))
  parts.push([
    '<固定输出协议>',
    '输出只包含 XML。先完整输出且只输出一次 <decision>draw</decision> 或 <decision>skip</decision>，紧接一个 <reason>简短具体原因</reason>；decision 之后不可修改。skip 时不输出 image。draw 时按顺序逐张尽快输出完整 image 块，使用以下结构，不输出额外长思考：',
    '<images><image><regex>正文中逐字一致的一句话</regex><title_styled>一句简短标题</title_styled><size>...</size><prompts>完整画面提示词</prompts></image></images>',
    '每张图承担不同叙事功能、景别或动作，并先呈现最重要的瞬间。每张按正文对应时点写服装、地点和外貌；服装、姿势、表情、裸露程度以 scene-mvu-state skill 写明的变量取值为准（那是本回合结算后的准确状态），正文没写具体细节时尤其要照它写；变量里没有的，才沿用此前已确立的状态。只根据这些材料和工具结果，不编造。',
    '</固定输出协议>',
  ].join('\n'))
  parts.push('<本轮上下文>')
  if (dynamicRules) parts.push('以下按正文触发的世界书规则必须遵守：\n\n' + dynamicRules)
  if (context) parts.push('以下是当前卡片的设定与本次正文命中的世界书条目，写画面时必须以它为准：\n\n' + context)
  if (roster) {
    parts.push([
      '<可用绘图角色列表>',
      '当前可采用的绘图角色（出现这些名字时必须按这里的白描写外貌，不要自己编）：',
      roster,
      '</可用绘图角色列表>',
    ].join('\n'))
  }
  if (rosterIndex) parts.push('<其他已知角色索引>\n正文没有明确提到以下人物；此索引仅用于识别称谓和代词，不要为他们补充外貌或安排出场：\n' + rosterIndex + '\n</其他已知角色索引>')
  if (Number(count) === 0) {
    parts.push('<本次任务>\n只做角色视觉历史检查，不生成图片，也不要输出任何 <image> 块。')
  } else if (smartSelection && !force) {
    parts.push('<本次任务>\n你正在判断这一轮是否值得配图，最多生成 ' + count + ' 张；可以选择 0 到 ' + count + ' 张。\n'
      + '如果没有值得单独呈现的视觉瞬间，必须明确输出 <decision>skip</decision><reason>简短具体原因</reason>，并且不要输出任何 <image> 块。\n'
      + '如果值得配图，完整输出一次 <decision>draw</decision> 与 <reason>简短具体原因</reason>，之后决定不可修改，然后输出 1 到 ' + count + ' 个完整 <image> 块。不得为了凑数制造画面。\n'
      + '先呈现正文中最重要的视觉瞬间。多张图必须各有不同叙事功能、景别或动作，并按重要性排序；服装、地点与外貌按各自对应的正文时点描述，正文明确变化时如实反映，未写出变化时才延续前一张状态。只依据正文，不编造事件、道具或事实。每个 image 块尽快完整输出，不要添加冗长思考。\n'
      + '本次的 0 到上限选择优先于世界书里固定图片数量的通用要求。\n'
      + 'image 块严格按上面的格式输出；只输出 XML，不要其他解释。')
  } else {
    parts.push('<本次任务>\n把用户给你的这段正文，转译成 ' + count + ' 张插图。\n'
      + '必须完整输出一次 <decision>draw</decision> 与 <reason>简短具体原因</reason>，随后输出 ' + count + ' 个完整的 <image> 块；decision 一旦输出不可修改。先输出正文中最重要的瞬间，多张图各有不同叙事功能、景别或动作并按重要性排序；服装、地点与外貌按各自对应的正文时点描述，正文明确变化时如实反映，未写出变化时才延续前一张状态。只依据正文，不编造。每个 image 块尽快完整输出，不要添加冗长思考。\n'
      + '本次要求的张数优先于世界书里固定图片数量的通用要求。\n'
      + '宁可每张写得紧凑，也要凑够张数。严格按上面的输出格式返回 <images>...</images>，只输出 XML，不要任何解释。')
  }
  if (characterUpdates) {
    const taskAt = parts.findIndex(part => part.startsWith('<本次任务>'))
    const update = '<角色视觉历史>\n在本次同一份分析中检查正文是否明确叙述了已知人物永久外貌的改变，例如新留疤、永久剪发、失明或永久义肢。只记录正文明确确认的永久变化，不能推测或补充 traits。衣着、姿势、表情、妆容、临时伤痕、场景状态都不是永久外貌更新。只更新可用角色列表中的人物，并复制角色列表的 stable_id。若更新某一字段，输出该字段的完整新描述，并保留该字段里正文未改变的旧事实；不要只写变化片段。先输出 <character_updates>{"updates":[{"id":"stable_id","name":"角色原名","permanent":true,"fields":{"face":"该字段完整的新描述"},"reason":"引用正文明确叙述的永久变化"}]}</character_updates>，无变化时也必须输出空数组。必须在 decision 与任何 image 块之前完整输出这个标签。字段只可用 feature、face、faceBack、bodySFW、bodySFWBack、lowerSFW、lowerSFWBack、bodyNSFW、bodyNSFWBack、lowerNSFW、lowerNSFWBack。'
    parts.splice(taskAt < 0 ? parts.length : taskAt, 0, update)
  }
  return parts.join('\n\n').replace('\n\n<本轮上下文>\n\n', '\n\n<本轮上下文>\n')
}

/** 世界书里的"角色调用 / 服装调用"写法：${"name":"han yuemei","angle":"from front"}$ → 展开成 tag。 */
const CALL_SKIP = new Set(['sfw', 'hidden', 'visible', 'none', 'n/a', 'null', 'undefined', 'negligible', ''])

export function expandCallMacros(text) {
  return String(text ?? '').replace(/\$\{([\s\S]*?)\}\$/g, (_match, body) => {
    const source = String(body ?? '').trim()
    if (!source) return ''
    const picked = []
    try {
      const parsed = JSON.parse('{' + source + '}')
      for (const value of Object.values(parsed)) {
        if (typeof value !== 'string') continue
        const item = value.trim()
        if (!item || CALL_SKIP.has(item.toLowerCase())) continue
        picked.push(item)
      }
    } catch {
      // 不是 JSON 就原样取内容
      const plain = source.replace(/^["']|["']$/g, '').trim()
      if (plain && !CALL_SKIP.has(plain.toLowerCase())) picked.push(plain)
    }
    return picked.join(', ')
  })
}

/** Clean planner prompts for the selected image backend while preserving text for multilingual APIs. */
export function normalizePrompts(text, definitions, context = {}) {
  let out = expandCallMacros(text)
  // Legacy callers retain the original local-prompt cleanup. Runtime callers pass the
  // selected backend so Chinese-capable image APIs can receive Chinese descriptions.
  const backend = typeof context === 'string' ? context : String(context?.backend ?? '')
  const shouldCleanChinese = !backend || backend.toLowerCase() === 'comfyui'
  if (shouldCleanChinese) {
    const hadChinese = /[\u4e00-\u9fa5]/.test(out)
    // A leading Chinese character name is useful for local models only when replaced by its
    // English alias. Keep it untouched for image APIs that accept Chinese descriptions.
    const lead = /^\s*([\u4e00-\u9fa5]{2,6})\s*[,，]\s*/.exec(out)
    if (lead) {
      const known = (definitions?.characters ?? []).find(item => item.name === lead[1])
      const alias = String(known?.match ?? '').split(',')[0].trim()
      out = out.replace(lead[0], alias ? alias + ', ' : '')
    }
    // Remove full Chinese passages as well as CJK punctuation; planners can return an entire
    // scene description in Chinese even when the instruction asks for English.
    out = out.replace(/[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff5e\u2018-\u201f\u2026\u2014\u00b7]+/g, ' ')
    out = out.replace(/\s{2,}/g, ' ').trim()
    const cleaned = dedupeTags(out)
    if (hadChinese && !cleaned) {
      throw Object.assign(new Error('ComfyUI 提示词清理后为空，请改用英文提示词。'), { submissionNotStarted: true })
    }
    return cleaned
  }
  out = out.replace(/\s{2,}/g, ' ').trim()
  return dedupeTags(out)
}

/** 同一个 tag 只留第一次出现（大小写不敏感）。 */
export function dedupeTags(text) {
  const seen = new Set()
  const kept = []
  for (const part of String(text ?? '').split(',')) {
    const tag = part.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(tag)
  }
  return kept.join(', ')
}

/**
 * 一次模型请求失败后值得重试的判定：只认瞬时性故障——限流、5xx、传输中断、
 * 超时、空响应。认证失败、内容拒绝、参数错误不在内，重试它们只是白烧钱。
 */
const RETRYABLE_FAILURE_PATTERN = /(^|\D)(429|500|502|503|504)(\D|$)|rate.?limit|too many requests|RATE_LIMIT|upstream request failed|endpoint is unavailable|server.?error|internal server|bad gateway|service unavailable|gateway time-?out|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|EMPTY_RESPONSE|空响应|服务不可用|上游请求失败/i

function isRetryableFailure(error, signal) {
  if (signal?.aborted) return false
  if (error?.name === 'AbortError') return false
  const message = String(error?.message ?? error ?? '')
  if (!message) return false
  return RETRYABLE_FAILURE_PATTERN.test(message)
}

/** 带抖动的指数退避。 */
function plannerRetryDelayMs(attempt, baseMs, maxMs) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 16)
  const raw = Math.min(baseMs * 2 ** exponent, maxMs)
  const jitter = 0.85 + Math.random() * 0.3
  return Math.max(1, Math.min(Math.round(raw * jitter), maxMs))
}

/** 可被 signal 打断的等待。 */
function sleepUnlessAborted(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('规划被取消'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('规划被取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 重试轨迹留一份，控制台里能直接看见撞了几次、隔了多久。 */
function recordRetry(entry) {
  try {
    if (!Array.isArray(globalThis.__rphubLlmRetries)) globalThis.__rphubLlmRetries = []
    globalThis.__rphubLlmRetries.push(entry)
    if (globalThis.__rphubLlmRetries.length > 20) globalThis.__rphubLlmRetries.shift()
    globalThis.__rphubLastRetry = entry
  } catch {}
}

/**
 * 真正调模型，把流式文本收完。
 *
 * `ctx.llm.stream()` 是裸调用，不走 agent loop 的 `agent/request-error` 瀑布，
 * 所以宿主的 dsh-llm-retry 全局策略管不到这里 —— 撞一次 429 就整次规划失败。
 * 重试必须在这一层自己做。
 */
export async function runPlanner(llm, { provider, model, system, text, maxTokens = 12000, temperature = 1, signal, onDelta, images, reasoningEffort, retryTimes = 5, retryBaseMs = 1000, retryMaxMs = 30000 }) {
  signal?.throwIfAborted()
  if (!llm || typeof llm.stream !== 'function') throw new Error('当前 DSH 没有可用的 llm 服务')
  if (!provider || !model) throw new Error('还没在控制台里选规划用的模型')
  // 图片消息：DSH 的格式是 { type: 'image', attachment: <附件引用> }
  // 之前这个参数根本不存在，导致"看图写 tag"和"参考图设计"都是在瞎编。
  const content = [{ type: 'text', text: String(text ?? '') }]
  for (const item of Array.isArray(images) ? images : []) {
    const ref = item && typeof item === 'object' && item.ref ? item.ref : item
    if (!ref || typeof ref !== 'object') continue
    if (ref.attachment && typeof ref.attachment === 'object') content.push({ type: 'image', attachment: ref.attachment })
    else if (ref.id || ref.mediaType || ref.path) content.push({ type: 'image', attachment: ref })
  }
  // 探针：把本次实际发出的图片消息条数暴露出来（供 /state 读取，验证图片真的发出去了）
  const imageParts = content.filter(part => part && part.type === 'image')
  const callRecord = {
    at: Date.now(),
    provider, model,
    textLen: String(text ?? '').length,
    imageCount: imageParts.length,
    imageShape: imageParts.length ? Object.keys(imageParts[0].attachment ?? {}).slice(0, 8) : [],
    contentTypes: content.map(part => part?.type),
  }
  globalThis.__rphubLastLlmCall = callRecord
  try {
    if (!Array.isArray(globalThis.__rphubLlmCalls)) globalThis.__rphubLlmCalls = []
    globalThis.__rphubLlmCalls.push(callRecord)
    if (globalThis.__rphubLlmCalls.length > 6) globalThis.__rphubLlmCalls.shift()
  } catch {}
  // DSH exposes exact-model capabilities and the official GenerateOptions field
  // is `reasoningEffort`. Only pass a persisted choice when this exact route
  // advertises it; stale choices for another model silently use its default.
  let selectedEffort = ''
  if (reasoningEffort && typeof llm.resolveModelInfo === 'function') {
    try {
      const info = await llm.resolveModelInfo(provider, model, signal)
      if (info?.reasoning?.efforts?.some(item => String(item.id) === String(reasoningEffort))) selectedEffort = String(reasoningEffort)
    } catch { /* if capability lookup is unavailable, retain the DSH default */ }
  }
  const times = Number.isSafeInteger(Number(retryTimes)) && Number(retryTimes) >= 0 ? Number(retryTimes) : 5
  const baseMs = Number(retryBaseMs) > 0 ? Number(retryBaseMs) : 1000
  const maxMs = Number(retryMaxMs) > 0 ? Number(retryMaxMs) : 30000
  for (let attempt = 1; ; attempt += 1) {
    let output = ''
    let usage = null
    let failure = null
    try {
      const chunks = llm.stream({
        provider,
        model,
        ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
        system,
        temperature,
        maxTokens,
        signal,
        messages: [{ role: 'user', content }],
      })
      for await (const chunk of chunks) {
        signal?.throwIfAborted()
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          output += chunk.text
          onDelta?.(chunk.text)
        } else if (chunk.type === 'usage') {
          usage = chunk.usage ?? null
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason ?? {}
          if (reason.kind === 'error' || reason.kind === 'aborted') {
            failure = reason.failure?.message || (reason.kind === 'aborted' ? '规划被取消' : '规划调用失败')
          }
        }
      }
      signal?.throwIfAborted()
      if (failure && !output.trim()) throw new Error(failure)
      if (attempt > 1) {
        globalThis.__rphubLastLlmCall = { ...callRecord, attempts: attempt, recovered: true }
      }
      return { text: output, usage, failure }
    } catch (error) {
      // 已经吐出正文的流不能重来：重试会重复计费、也会把半截输出拼成两遍。
      const safeToRetry = attempt <= times && !output.trim() && isRetryableFailure(error, signal)
      if (!safeToRetry) throw error
      const delay = plannerRetryDelayMs(attempt, baseMs, maxMs)
      recordRetry({
        at: Date.now(),
        provider,
        model,
        attempt,
        maxAttempts: times + 1,
        delayMs: delay,
        error: String(error?.message ?? error).slice(0, 300),
      })
      try {
        console.warn?.('[dsh-tavern-image] 模型请求失败，' + delay + 'ms 后第 ' + attempt + '/' + times + ' 次重试：' + String(error?.message ?? error).slice(0, 160))
      } catch {}
      await sleepUnlessAborted(delay, signal)
    }
  }
}

/** 解析设计输出的 <人物> / <服装> 块。 */
function fieldOf(body, label) {
  // 允许标签前有 markdown 记号（**中文名称**、- 中文名称、1. 中文名称、# 中文名称）。
  // 标签和冒号之间只允许空白/星号/下划线 —— 否则「上半身SFW」会误匹配「上半身SFW背面」。
  const re = new RegExp('^[ \t>*_\\-#\\d.、)]*' + label + '[ \t*_]*[:：][ \t]*([^\\n]+)', 'm')
  const hit = re.exec(body)
  if (!hit) return ''
  return String(hit[1]).trim().replace(/^\*+|\*+$/g, '').trim()
}

export function parseDesign(text) {
  const source = String(text ?? '')
  const people = []
  for (const match of source.matchAll(/<人物[^>]*>([\s\S]*?)<\/人物>/g)) {
    const body = match[1]
    const person = {
      name: fieldOf(body, '中文名称'),
      match: fieldOf(body, '英文名称'),
      note: fieldOf(body, '角色说明'),
      traits: {
        feature: fieldOf(body, '角色特征'),
        face: fieldOf(body, '五官外貌'),
        faceBack: fieldOf(body, '五官外貌背面'),
        bodySFW: fieldOf(body, '上半身SFW'),
        bodySFWBack: fieldOf(body, '上半身SFW背面'),
        lowerSFW: fieldOf(body, '下半身SFW'),
        lowerSFWBack: fieldOf(body, '下半身SFW背面'),
        bodyNSFW: fieldOf(body, '上半身NSFW'),
        bodyNSFWBack: fieldOf(body, '上半身NSFW背面'),
        lowerNSFW: fieldOf(body, '下半身NSFW'),
        lowerNSFWBack: fieldOf(body, '下半身NSFW背面'),
        negative: fieldOf(body, '负面'),
      },
      outfits: [],
    }
    for (const fit of body.matchAll(/<服装[^>]*>([\s\S]*?)<\/服装>/g)) {
      const inner = fit[1]
      person.outfits.push({
        name: fieldOf(inner, '服装名称') || '服装',
        upper: fieldOf(inner, '上衣'),
        lower: fieldOf(inner, '下装'),
        shoes: fieldOf(inner, '鞋袜'),
        accessory: fieldOf(inner, '配饰'),
        full: fieldOf(inner, '整体'),
        back: fieldOf(inner, '背面'),
        negative: fieldOf(inner, '负面'),
      })
    }
    if (person.name || person.traits.face) people.push(person)
  }

  // 服装块也可能写在 <人物> 外面（规范里就是"人物1 → 人物1的服装 → 人物2 → …"），
  // 靠「归属人」关联到对应角色。这里把没被上面吃掉的服装块补挂上去。
  if (people.length) {
    const inside = people.reduce((n, p) => n + (p.outfits?.length ?? 0), 0)
    for (const fit of source.matchAll(/<服装[^>]*>([\s\S]*?)<\/服装>/g)) {
      const inner = fit[1]
      const item = {
        name: fieldOf(inner, '服装名称') || fieldOf(inner, '名称') || '服装',
        upper: fieldOf(inner, '上衣'),
        lower: fieldOf(inner, '下装'),
        shoes: fieldOf(inner, '鞋袜'),
        accessory: fieldOf(inner, '配饰'),
        full: fieldOf(inner, '整体'),
        back: fieldOf(inner, '背面'),
        negative: fieldOf(inner, '负面'),
      }
      if (!item.name && !item.upper && !item.lower && !item.full) continue
      const owner = fieldOf(inner, '归属人') || fieldOf(inner, '角色')
      const key = String(owner).toLowerCase().replace(/[\s_\-.]/g, '')
      let target = null
      if (key) {
        target = people.find(p => {
          const a = String(p.name ?? '').toLowerCase().replace(/[\s_\-.]/g, '')
          const b = String(p.match ?? '').toLowerCase().replace(/[\s_\-.]/g, '')
          return (a && (a === key || a.includes(key) || key.includes(a))) || (b && (b === key || b.includes(key) || key.includes(b)))
        })
      }
      if (!target && people.length === 1) target = people[0]
      if (!target) continue
      const dup = (target.outfits ?? []).some(o => o.name === item.name)
      if (dup) continue
      target.outfits = (target.outfits ?? []).concat([item])
    }
    // 静默统计，方便排查
    const after = people.reduce((n, p) => n + (p.outfits?.length ?? 0), 0)
    if (after !== inside) {
      // 只在真的补挂了服装时才动
    }
  }
  // 没有 <人物> 包起来时，退一步：整篇里直接找 <服装>。
  // 但必须能定位到归属人，否则会产出"名字和字段全空的角色"污染人物库（曾经因此入库两个空条目）。
  if (!people.length) {
    for (const fit of source.matchAll(/<服装[^>]*>([\s\S]*?)<\/服装>/g)) {
      const inner = fit[1]
      const owner = fieldOf(inner, '归属人')
      const fitName = fieldOf(inner, '服装名称')
      const upper = fieldOf(inner, '上衣')
      if (!owner || (!fitName && !upper)) continue
      people.push({
        name: owner, match: owner, note: '', traits: {}, outfits: [{
          name: fitName || '服装',
          upper, lower: fieldOf(inner, '下装'), shoes: fieldOf(inner, '鞋袜'),
          accessory: fieldOf(inner, '配饰'), full: fieldOf(inner, '整体'), back: fieldOf(inner, '背面'),
          negative: fieldOf(inner, '负面'),
        }],
      })
    }
  }
  return people
}
