const TRAIT_FIELDS = new Set(['feature', 'face', 'faceBack', 'bodySFW', 'bodySFWBack', 'lowerSFW', 'lowerSFWBack', 'bodyNSFW', 'bodyNSFWBack', 'lowerNSFW', 'lowerNSFWBack'])
const BASE_TRAIT_FIELDS = new Set([...TRAIT_FIELDS, 'negative'])
const MAX_CHANGES = 120
const MAX_TEXT = 700

function clip(value, max = MAX_TEXT) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) }
function size(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8') }

export function emptyCharacterSnapshot() {
  return { version: 1, characters: {}, changes: [] }
}

export function mergeCharacterUpdates(previous, definitions, updates, meta = {}) {
  const snapshot = previous && typeof previous === 'object' ? structuredClone(previous) : emptyCharacterSnapshot()
  if (!snapshot.characters || typeof snapshot.characters !== 'object') snapshot.characters = {}
  if (!Array.isArray(snapshot.changes)) snapshot.changes = []
  const characters = Array.isArray(definitions?.characters) ? definitions.characters : []
  const byId = new Map()
  for (const character of characters) {
    if (!character || character.enabled === false || !character.id) continue
    const id = String(character.id)
    byId.set(id, [...(byId.get(id) ?? []), character])
  }
  const changes = []
  const updatedIds = new Set()
  for (const raw of Array.isArray(updates) ? updates : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('角色更新条目格式无效')
    const name = clip(raw.name, 100)
    const hintedId = clip(raw.id, 100)
    const matches = hintedId ? byId.get(hintedId) ?? [] : []
    const character = matches.length === 1 ? matches[0] : null
    if (!character || raw.permanent !== true) throw new Error('角色更新必须指向唯一的已知角色并明确标记 permanent=true')
    if (name && ![character.name, character.match, ...(Array.isArray(character.aliases) ? character.aliases : [])]
      .some(alias => clip(alias, 100).toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error('角色更新名称与 stable id 不匹配')
    }
    const id = String(character.id)
    if (updatedIds.has(id)) throw new Error('角色更新中包含重复角色：' + clip(character.name, 100))
    updatedIds.add(id)
    const supplied = raw.fields
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('角色更新 fields 必须是对象')
    const entries = Object.entries(supplied)
    if (!entries.length || entries.some(([key, value]) => !TRAIT_FIELDS.has(key) || typeof value !== 'string' || !clip(value))) {
      throw new Error('角色更新包含无效字段或空描述')
    }
    const fields = entries
    const overlay = snapshot.characters[character.id] ||= { traits: {} }
    overlay.baseTraits ||= Object.fromEntries(Object.entries(character.traits ?? {}).filter(([key, value]) => BASE_TRAIT_FIELDS.has(key) && clip(value)).map(([key, value]) => [key, clip(value)]))
    overlay.identity ||= { name: clip(character.name, 100), match: clip(character.match, 200) }
    overlay.traits ||= {}
    const reason = clip(raw.reason, 240)
    for (const [key, value] of fields) {
      const next = clip(value)
      const before = clip(overlay.traits[key] || character.traits?.[key])
      if (!next || next === before) continue
      overlay.traits[key] = next
      changes.push({
        id, name: clip(character.name, 100), field: key,
        before, after: next, reason: reason || '正文明确叙述永久外貌变化',
        turn: Number(meta.turn) || 0, textVersion: clip(meta.textVersion, 120), at: Number(meta.at) || Date.now(),
      })
    }
  }
  if (changes.length) snapshot.changes.push(...changes)
  snapshot.changes = snapshot.changes.slice(-MAX_CHANGES)
  snapshot.version = 1
  return { snapshot, changes }
}

/** Overlay timeline facts on the untouched user-authored character definitions. */
export function applyCharacterSnapshot(definitions, snapshot) {
  const state = snapshot?.characters && typeof snapshot.characters === 'object' ? snapshot.characters : {}
  return {
    ...(definitions ?? {}),
    characters: (definitions?.characters ?? []).map(character => {
      const overlay = state[String(character?.id)]
      return overlay?.traits || overlay?.baseTraits
        ? { ...character, ...(overlay.identity ?? {}), traits: { ...(overlay.baseTraits ?? character.traits ?? {}), ...(overlay.traits ?? {}) } }
        : character
    }),
  }
}

/**
 * 裁剪实时档案，压到每轮存档上限以内。
 *
 * 与 boundCharacterSnapshot 的区别：那个只认 traits（永久特征），
 * 会把 state / baseTraits 之外的东西丢掉 —— 用它裁实时档案等于把状态清空。
 */
export function boundSceneState(input, maxBytes = 60 * 1024) {
  const snapshot = input && typeof input === 'object' ? structuredClone(input) : emptyCharacterSnapshot()
  if (!snapshot.characters || typeof snapshot.characters !== 'object') snapshot.characters = {}
  if (!Array.isArray(snapshot.sceneChanges)) snapshot.sceneChanges = []
  snapshot.sceneChanges = snapshot.sceneChanges.slice(-200)
  const keep = new Set(SCENE_STATE_FIELDS.map(([key]) => key))
  for (const key of Object.keys(snapshot.characters)) {
    const source = snapshot.characters[key] ?? {}
    const state = {}
    for (const field of keep) {
      const value = clipState(source.state?.[field])
      if (value) state[field] = value
    }
    const identity = source.identity && typeof source.identity === 'object'
      ? { name: clipState(source.identity.name).slice(0, 100), match: clipState(source.identity.match).slice(0, 200) }
      : {}
    if (!identity.name && !Object.keys(state).length) { delete snapshot.characters[key]; continue }
    snapshot.characters[key] = {
      ...(identity.name ? { identity } : {}),
      state,
      ...(Array.isArray(source.mvuBacked) && source.mvuBacked.length
        ? { mvuBacked: source.mvuBacked.filter(field => keep.has(field)) } : {}),
    }
  }
  // 仍超限就去掉最早的变化记录
  while (snapshot.sceneChanges.length && size(snapshot) > maxBytes) snapshot.sceneChanges.shift()
  if (size(snapshot) > maxBytes) {
    // 只留 state，丢掉记录再试
    delete snapshot.sceneChanges
    if (size(snapshot) > maxBytes) throw new Error('角色档案超出每轮存档限制')
  }
  return snapshot
}

/** Fit safely under Tavern's 64 KB per-turn snapshot cap; retain newest history. */
export function boundCharacterSnapshot(input, maxBytes = 60 * 1024) {
  const snapshot = input && typeof input === 'object' ? structuredClone(input) : emptyCharacterSnapshot()
  if (!snapshot.characters || typeof snapshot.characters !== 'object') snapshot.characters = {}
  if (!Array.isArray(snapshot.changes)) snapshot.changes = []
  snapshot.changes = snapshot.changes.slice(-MAX_CHANGES)
  for (const id of Object.keys(snapshot.characters)) {
    const source = snapshot.characters[id] ?? {}
    const filterTraits = (traits, allowed) => Object.fromEntries(Object.entries(traits ?? {}).filter(([key, value]) => allowed.has(key) && clip(value)).map(([key, value]) => [key, clip(value)]))
    snapshot.characters[id] = {
      ...(source.identity && typeof source.identity === 'object' ? { identity: { name: clip(source.identity.name, 100), match: clip(source.identity.match, 200) } } : {}),
      baseTraits: filterTraits(source.baseTraits, BASE_TRAIT_FIELDS), traits: filterTraits(source.traits, TRAIT_FIELDS),
    }
  }
  while (snapshot.changes.length && size(snapshot) > maxBytes) snapshot.changes.shift()
  if (size(snapshot) > maxBytes) throw new Error('角色历史数据超出每轮存档限制')
  return snapshot
}

export function characterHistoryChanges(snapshot) { return Array.isArray(snapshot?.changes) ? snapshot.changes.slice(-MAX_CHANGES) : [] }

/* ---------------------------------------------------------------------------
 * 实时角色档案（生图专用）
 *
 * 和上面那套「永久外貌变化」的区别：
 *   traits  = 不变的东西（长相、体型、发色、瞳色、永久伤痕）—— 跨轮不变
 *   state   = 这一刻的东西（当前服装、发型变化、裸露状态、姿势、所在位置）—— 每轮都在变
 *
 * 生图最需要的恰恰是 state：正文很少每段都重写「她现在穿着什么」，
 * 但只要前几轮写过、之后没换装，画面就该沿用。这就是这份档案存在的意义。
 *
 * 有 MVU 时优先用 MVU 的值（它是结算后的权威状态）；
 * 没有 MVU 时靠正文推断，并沿用上一轮没被推翻的值 —— 所以它是累积的，不是每轮重建。
 * ------------------------------------------------------------------------- */

/** 实时状态字段：名字 → 说明（这套字段只为生图服务，不参与正文写作）。 */
export const SCENE_STATE_FIELDS = [
  ['outfit', '当前服装：从上到下的完整穿着，含颜色、材质、款式、是否凌乱/湿透/半褪，写清遮覆到哪'],
  ['hair', '当前发型：发色 + 发型 + 是否有变化（散开、削短、沾湿、沾血），未变化时可省略'],
  ['exposure', '裸露与暴露状态：此刻哪些部位露在外面、被什么遮住、衣物褪到什么位置'],
  ['posture', '当前姿势与动作：站着/跪着/躺着，重心在哪，四肢分别在哪'],
  ['location', '当前所在位置：场所 + 具体位置（门边、床沿、廊柱旁）'],
  ['condition', '身体状态：汗、泪、伤痕、体液、妆容花了、喘息 —— 只写看得见的'],
  ['sceneProps', '身边相关的器物：被褥、桌椅、武器、正在用的东西，只写画面里该出现的'],
]
const SCENE_STATE_KEYS = new Set(SCENE_STATE_FIELDS.map(([key]) => key))
const MAX_STATE_TEXT = 400

function clipState(value) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_STATE_TEXT) }

/**
 * 把本轮的实时状态合并进快照。
 *
 * 关键语义：**只覆盖正文/MVU 明确提到的字段**，没提到的保留上一轮的值。
 * 这就是「正文没写服装也知道穿什么」的实现方式。
 *
 * @param previous  上一轮快照
 * @param updates   [{ name, id?, fields: { outfit?, hair?, ... }, reason? }]
 */
export function mergeSceneState(previous, updates, meta = {}) {
  const snapshot = previous && typeof previous === 'object' ? structuredClone(previous) : emptyCharacterSnapshot()
  if (!snapshot.characters || typeof snapshot.characters !== 'object') snapshot.characters = {}
  if (!Array.isArray(snapshot.changes)) snapshot.changes = []
  const applied = []
  for (const raw of Array.isArray(updates) ? updates : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const name = clipState(raw.name).slice(0, 100)
    if (!name) continue
    const fields = raw.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields) ? raw.fields : {}
    const key = String(raw.id || name)
    const entry = snapshot.characters[key] ||= { identity: { name, match: '' }, traits: {}, state: {} }
    entry.identity ||= { name, match: '' }
    entry.state ||= {}
    let touched = false
    for (const [field, value] of Object.entries(fields)) {
      if (!SCENE_STATE_KEYS.has(field)) continue
      const next = clipState(value)
      // 空值视为「本轮没有新信息」，保留旧值 —— 不能因为模型没写就把已有状态清掉
      if (!next) continue
      const before = clipState(entry.state[field])
      if (before === next) continue
      entry.state[field] = next
      touched = true
      if (before) applied.push({ key, name, field, before, after: next, reason: clipState(raw.reason).slice(0, 200), turn: Number(meta.turn) || 0 })
    }
    if (touched) applied.push({ key, name, field: '#updated', after: '', at: Date.now() })
  }
  if (applied.length) {
    snapshot.sceneChanges = (Array.isArray(snapshot.sceneChanges) ? snapshot.sceneChanges : []).concat(applied.filter(item => item.field !== '#updated')).slice(-200)
  }
  snapshot.version = 2
  return { snapshot, applied: applied.filter(item => item.field !== '#updated') }
}

/**
 * 字段名 → 标准字段。按语义匹配，不依赖某张卡的具体命名。
 * 顺序有意义：越具体的先判，避免「服饰状态」被当成 condition。
 */
const FIELD_RULES = [
  [/服饰|服装|衣着|穿着|衣装|装束|(^|[._])衣$|clothes|outfit|attire|dress/i, 'outfit'],
  [/发色|发型|头发|发式|青丝|hair/i, 'hair'],
  [/姿势|体位|姿态|体态|动作|(^|[._])pose|posture|stance/i, 'posture'],
  [/裸露|暴露|遮覆|遮蔽|走光|exposure|nudity|bare/i, 'exposure'],
  [/位置|地点|所在|场所|身处|location|place|scene/i, 'location'],
  [/表情|神色|神态|神情|脸色|expression/i, 'condition'],
  [/状态|情况|模样|身体|condition|state/i, 'condition'],
]

function fieldOf(name) {
  for (const [re, field] of FIELD_RULES) if (re.test(name)) return field
  return ''
}

/**
 * 猜一个路径里哪一段是人物名。
 *
 * 不写死「周围人物/角色」这种容器名 —— 每张卡的 MVU 结构都不一样。
 * 改按「像人名的那一段」判：带容器含义的词跳过，取第一个剩下的。
 * 都判不出来就记到「场景」名下（顶层字段就是这种情况）。
 */
const CONTAINER_HINTS = /^(周围人物|人物|角色|人物列表|characters?|people|npcs?|chars|units|actors?|实体|列表|数据|世界|scene|场景|环境)$/i
/** 「角色[0]」「characters[2]」这种带下标的容器不是人名，去掉下标再判断。 */
const stripIndex = value => String(value).replace(/\[\d+\]$/,'')
function guessOwner(parts) {
  if (parts.length < 2) return '场景'
  let skippedContainer = false
  for (let i = 0; i < parts.length - 1; i++) {
    const raw = String(parts[i]).trim()
    if (!raw) continue
    const bare = stripIndex(raw)
    if (!bare) continue
    if (CONTAINER_HINTS.test(bare)) { skippedContainer = true; continue }
    if (/^\d+$/.test(bare)) { skippedContainer = true; continue }
    // 容器有下标、后面紧跟「名字」字段时，真正的名字在下一条
    const next = String(parts[i + 1] ?? '').trim()
    if (skippedContainer && /^(名字|姓名|名称|name)$/i.test(stripIndex(next))) continue
    return bare
  }
  return '场景'
}

/**
 * 用 MVU 变量覆盖状态里对应的字段。
 *
 * 通用适配：不假设任何一张卡的变量结构，只看两件事 ——
 *   ① 这个路径里哪一段像人名（guessOwner）
 *   ② 这段路径的字段名像哪一类画面信息（fieldOf，按语义匹配）
 * 认不出来的一律跳过，交给正文与 Agent 补。
 *
 * Agent 也可以在 scene_state 里直接用 MVU 的原始路径（fields 的键写成路径），
 * 那时按路径映射；否则按标准字段名。
 */
export function overlayMvuState(snapshot, mvuFields) {
  const out = snapshot && typeof snapshot === 'object' ? structuredClone(snapshot) : emptyCharacterSnapshot()
  if (!out.characters || typeof out.characters !== 'object') out.characters = {}
  const list = Array.isArray(mvuFields) ? mvuFields : []
  // 先扫一遍：形如「角色[0].名字=苏念」的显式姓名字段，用来给同前缀的其它字段定归属。
  // 很多 MVU 卡把名字单独存一个字段，光靠猜路径猜不出人名。
  const explicit = new Map()
  for (const item of list) {
    const path = String(item?.path ?? '')
    const value = String(item?.value ?? '').trim()
    if (!path || !value) continue
    const parts = path.split(/[./]/).filter(Boolean)
    if (!/^(名字|姓名|名称|名|name|fullname)$/i.test(parts[parts.length - 1] ?? '')) continue
    const prefix = parts.slice(0, -1).join('.')
    if (prefix && value.length <= 40) explicit.set(prefix, value)
  }
  for (const item of list) {
    const rawPath = String(item?.path ?? '')
    const value = item?.value
    if (!rawPath || !value) continue
    const parts = rawPath.split(/[./]/).filter(Boolean)
    if (!parts.length) continue
    // 显式名字优先：同前缀的字段都归这个人物
    let owner = ''
    for (const [prefix, name] of explicit) {
      if (rawPath.startsWith(prefix + '.') || rawPath.startsWith(prefix + '/')) { owner = name; break }
    }
    if (!owner) owner = guessOwner(parts)
    // 字段名可能在中段（「叶冰.服饰」）也可能在末段（「服饰.上装」）——
    // 从后往前找第一个能识别的，这样「服饰.上装」会算作 outfit。
    let field = ''
    for (let i = parts.length - 1; i >= 0; i--) {
      const hit = fieldOf(parts[i])
      if (hit) { field = hit; break }
    }
    // 名字段本身不该被当字段（角色名叫「发哥」之类），跳过它再找一次
    if (!field) continue
    const entry = out.characters[owner] ||= { identity: { name: owner, match: '' }, traits: {}, state: {} }
    entry.identity ||= { name: owner, match: '' }
    entry.state ||= {}
    // 同一个字段被多条路径命中时，取更具体（更长）的那条 —— 「服饰」只是大类，
    // 「服饰.上装」才是具体某件衣服。这里用长度做粗略的「具体度」比较。
    const prev = entry._mvuLen?.[field] ?? -1
    if (rawPath.length < prev) continue
    entry.state[field] = clipState(value)
    entry._mvuLen = { ...(entry._mvuLen || {}), [field]: rawPath.length }
    entry.mvuBacked ||= []
    if (!entry.mvuBacked.includes(field)) entry.mvuBacked.push(field)
  }
  for (const entry of Object.values(out.characters)) delete entry._mvuLen
  return out
}

/** 把快照里的实时状态渲染成给规划模型读的文本；按名字逐个列。 */
export function renderSceneState(snapshot, options = {}) {
  const characters = snapshot?.characters && typeof snapshot.characters === 'object' ? snapshot.characters : {}
  const wanted = Array.isArray(options.names) && options.names.length ? new Set(options.names.map(String)) : null
  const lines = []
  for (const [key, entry] of Object.entries(characters)) {
    const name = clipState(entry?.identity?.name || key)
    if (!name) continue
    if (wanted && !wanted.has(name) && !wanted.has(key)) continue
    const state = entry?.state || {}
    const parts = []
    for (const [field, label] of SCENE_STATE_FIELDS) {
      const value = clipState(state[field])
      if (value) parts.push('  - ' + label.split('：')[0] + '：' + value)
    }
    if (!parts.length) continue
    lines.push('### ' + name + (Array.isArray(entry.mvuBacked) && entry.mvuBacked.length ? '（MVU 权威值）' : ''))
    lines.push(...parts)
  }
  return lines.join('\n')
}

/** 列出快照里有哪些角色（给「先抓名字、再取详情」用）。 */
export function sceneStateRoster(snapshot) {
  const characters = snapshot?.characters && typeof snapshot.characters === 'object' ? snapshot.characters : {}
  const out = []
  for (const [key, entry] of Object.entries(characters)) {
    const name = clipState(entry?.identity?.name || key)
    if (name) out.push({ key, name })
  }
  return out
}
