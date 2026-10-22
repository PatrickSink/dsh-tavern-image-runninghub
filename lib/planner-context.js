import { RULE_ENTRY_HINT, stripEngineSyntax } from './planner.js'

const list = value => Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\n]/) : []
const clean = values => [...new Set(values.map(v => String(v ?? '').trim()).filter(Boolean))]

/** Normalize ordinary activation metadata while retaining legacy ST keyword fields. */
export function normalizeEntryActivation(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {}
  const backendValues = raw.backends ?? raw.backend ?? raw.imageBackends ?? []
  const backends = clean(list(backendValues))
  const explicit = String(raw.activation ?? raw.activationMode ?? '').toLowerCase()
  const rawKeywords = raw.keywords ?? raw.keys ?? raw.key
  const keywords = clean(list(rawKeywords))
  const constant = raw.constant === true || raw.constant === 1 || raw.constant === 'true'
  const enabled = value => value === true || value === 1 || value === 'true'
  const secondary = clean(list(raw.keysecondary))
  const complexTrigger = Boolean(enabled(raw.use_regex) || enabled(raw.useRegex) || enabled(raw.regex)
    || enabled(raw.caseSensitive) || enabled(raw.wholeWords)
    || secondary.length || (enabled(raw.selective) && (raw.selectiveLogic != null || raw.triggerLogic != null)))
  // ST constant entries remain resident. Other simple keyword entries remain conditional.
  const activation = explicit === 'always' || explicit === 'keywords'
    ? explicit
    : (!complexTrigger && !constant && keywords.length && (raw.keywords != null || raw.keys != null || raw.key != null) ? 'keywords' : 'always')
  return { activation, keywords, backends }
}

function matches(text, keyword) {
  const q = String(keyword).trim()
  if (!q) return false
  // Require boundaries only at Latin/numeric ends. CJK text has no spaces between words.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const isCjk = ch => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)
  const latinWord = '[\\p{Script=Latin}\\p{N}_]'
  const left = isCjk(q[0]) ? '' : `(?:^|[^${latinWord.slice(1, -1)}])`
  const right = isCjk(q[q.length - 1]) ? '' : `(?:$|[^${latinWord.slice(1, -1)}])`
  return new RegExp(`${left}${escaped}${right}`, 'iu').test(String(text))
}

function entryReason(entry, text) {
  const activation = normalizeEntryActivation(entry)
  if (entry.enabled === false || entry.disable === true) return { included: false, reason: 'disabled' }
  if (activation.activation === 'always') return { included: true, reason: 'always' }
  if (!activation.keywords.length) return { included: false, reason: 'empty-keywords' }
  return activation.keywords.some(key => matches(text, key))
    ? { included: true, reason: 'keyword-match' }
    : { included: false, reason: 'keyword-miss' }
}

function characterTerms(character) {
  const name = String(character.name ?? '').trim()
  const aliases = String(character.match ?? '').split(/[,，]/).map(v => v.trim()).filter(Boolean)
  return clean([name, ...aliases])
}

/** Split resident/dynamic rules and scope character detail to names found in the story. */
export function selectPlannerContext({ entries = [], selected = [], text = '', definitions = {}, backend = '', characterUpdates = false } = {}) {
  const staticBlocks = [], dynamicBlocks = []
  const diagnostics = { includedEntries: [], omittedEntries: [], includedCharacters: [], omittedCharacters: [], characterFallback: false }
  const hasEnabled = entries.some(e => e && 'enabled' in e)
  const selectedList = Array.isArray(selected) && selected.length ? selected : RULE_ENTRY_HINT
  const wanted = new Set(selectedList.map(Number))
  for (const entry of entries) {
    const index = Number(entry?.index ?? -1)
    let reason
    if (entry?.enabled === false || entry?.disable === true) reason = { included: false, reason: 'disabled' }
    else {
      const meta = normalizeEntryActivation(entry)
      if (meta.backends.length && !meta.backends.includes(String(backend))) reason = { included: false, reason: 'backend-mismatch' }
      else if (!hasEnabled && !wanted.has(index)) reason = { included: false, reason: 'not-selected' }
      else reason = entryReason(entry, text)
    }
    if (!String(entry?.content ?? '').trim()) reason = { included: false, reason: 'empty-content' }
    const record = { index, comment: String(entry?.comment ?? ''), reason: reason.reason }
    if (!reason.included) { diagnostics.omittedEntries.push(record); continue }
    diagnostics.includedEntries.push(record)
    const body = stripEngineSyntax(entry?.content ?? '').trim()
    if (!body) continue
    const block = `<!-- ${record.comment} -->\n${body}`
    ;(normalizeEntryActivation(entry).activation === 'keywords' ? dynamicBlocks : staticBlocks).push(block)
  }

  const characters = (definitions?.characters ?? []).filter(c => c && c.enabled !== false)
  const hit = characters.filter(c => characterTerms(c).some(term => matches(text, term)))
  const fallback = characters.length > 0 && hit.length === 0
  const included = fallback ? characters : hit
  diagnostics.characterFallback = fallback
  diagnostics.includedCharacters = included.map(c => ({ name: String(c.name ?? ''), stable_id: String(c.id ?? ''), reason: fallback ? 'fallback-no-name-match' : 'name-match' }))
  diagnostics.omittedCharacters = characters.filter(c => !included.includes(c)).map(c => ({ name: String(c.name ?? ''), stable_id: String(c.id ?? ''), reason: 'not-mentioned' }))
  const fullSet = new Set(included)
  const scoped = { ...definitions, characters: included }
  const rosterIndex = characters.filter(c => !fullSet.has(c)).map(c => `- ${String(c.name ?? '')} [stable_id=${String(c.id ?? '')}]`).join('\n')
  return { staticRules: staticBlocks.join('\n\n'), dynamicRules: dynamicBlocks.join('\n\n'), definitions: scoped, rosterIndex, fullTraits: Boolean(characterUpdates), diagnostics }
}

/** 本体「设计人物」写成的世界书条目标题前缀。 */
export const DESIGN_ENTRY_PREFIX = '人物设计 · '

/**
 * 把本体的「设计人物」转成插件的人物白描。
 *
 * 目前未被调用：人物外貌已交给 Agent 自己用 character_design_read 读设计人物档案，
 * 插件不再注入白描。保留它是因为这段解析逻辑有测试覆盖，回退旧路径时可直接启用。
 *
 * 本体的设计人物任务（Skill：character-design）把档案写成一条本局世界书条目：
 *   标题：人物设计 · <名字>
 *   正文：人物：<名字> / 身份：… / 性格：… / 外貌：… / 说话方式：… / 剧情作用…：…
 * 这些条目是关键词触发的（primaryKeys 是姓名与别名），随正文命中被召回；而
 * getCardContext().lore 拿到的正是这一轮召回的世界书条目，所以插件读得到它，
 * 不必再维护自己那一套人物库。
 *
 * 「外貌」是唯一的画面依据（skill 里已经要求它分部位写、含日常穿着），整段进
 * traits.face；身份与性格拼进 traits.feature，供规划模型判断人物气质。
 */
export function charactersFromDesignLore(lore = []) {
  const out = []
  const seen = new Set()
  for (const entry of Array.isArray(lore) ? lore : []) {
    const title = String(entry?.title ?? '').trim()
    if (!title.startsWith(DESIGN_ENTRY_PREFIX)) continue
    const content = String(entry?.content ?? '').trim()
    if (!content) continue
    const fields = {}
    for (const block of content.split(/\n{2,}/)) {
      const m = /^([^：:\n]{1,40})[：:]\s*([\s\S]*)$/.exec(block.trim())
      if (!m) continue
      const label = m[1].trim(), value = m[2].trim()
      if (!value) continue
      if (label.startsWith('人物')) fields.personName = value
      else if (label.startsWith('身份')) fields.identity = value
      else if (label.startsWith('性格')) fields.personality = value
      else if (label.startsWith('外貌')) fields.appearance = value
      else if (label.startsWith('说话方式')) fields.speechStyle = value
      else if (label.startsWith('剧情作用')) fields.narrativeRole = value
    }
    const name = String(fields.personName || title.slice(DESIGN_ENTRY_PREFIX.length)).trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({
      id: 'design-' + name,
      name,
      match: name,
      enabled: true,
      source: 'tavern-design',
      traits: {
        feature: [fields.identity, fields.personality].filter(Boolean).join('｜'),
        face: fields.appearance ?? '',
      },
    })
  }
  return out
}

/**
 * 把 Tavern 的人物设计档案（tavern.getCharacterDesigns）转成插件的人物白描。
 *
 * 这是官方为此准备的接口 —— 源码注释写着「This game's character design archive:
 * the one text and pictures share」，正文与图片共用同一份档案。
 *
 * 返回形状：{ revision, updatedAt, characters: [{ name, aliases, identity,
 * narrativeRole, sections: [{ key, label, text }] }] }，其中 sections 由
 * 身份/性格/外貌/说话方式/剧情作用五项组成。
 *
 * 「外貌」是唯一的画面依据（含日常穿着），整段进 traits.face；
 * 身份与性格拼进 traits.feature 供模型判断气质。
 */
export function charactersFromDesignArchive(archive) {
  const out = []
  for (const item of Array.isArray(archive?.characters) ? archive.characters : []) {
    const name = String(item?.name ?? '').trim()
    if (!name) continue
    const sections = Array.isArray(item?.sections) ? item.sections : []
    const section = key => String(sections.find(s => s && s.key === key)?.text ?? '').trim()
    const aliases = Array.isArray(item?.aliases) ? item.aliases.map(v => String(v ?? '').trim()).filter(Boolean) : []
    out.push({
      id: 'design-' + name,
      name,
      match: [name, ...aliases].join(', '),
      enabled: true,
      source: 'tavern-design',
      traits: {
        // 身份在 sections 与顶层各有一份（投影里 identity 是 design.identity 的副本），
        // 以 sections 为准，顶层作回退。
        feature: [section('identity') || String(item?.identity ?? '').trim(), section('personality')]
          .filter(Boolean).join('｜'),
        face: section('appearance'),
      },
    })
  }
  return out
}


/* ---------------------------------------------------------------------------
 * MVU 变量读取（给规划 Agent 的自建工具用）
 *
 * 不做预注入：预注入只是把文本塞进 prompt，界面上看不到，玩家没法确认到底用没用。
 * 改成 Agent 自己调一次工具，步骤列表里会显式出现，读到了什么也看得见。
 *
 * 宿主不会给插件任务 tavern_read_variables（不在 BACKGROUND_TOOLS，也不在 sharedTools），
 * 所以这里用 runTask 的 tools 参数自带一个，名字避开宿主已用的工具名。
 * ------------------------------------------------------------------------- */

const VISUAL_KEY_HINTS = [
  /服装|衣着|服饰|穿着|衣物|衣装|打扮|装束|衣/,
  /姿势|体位|姿态|动作|体态|姿/,
  /表情|神色|神态|神情|脸色|面容/,
  /裸露|暴露|赤裸|裸露度|遮覆|遮蔽|覆盖|走光/,
  /位置|地点|场景|所在|身处|场所|房间|环境/,
  /状态|情况|模样|样子|外观|形象|外貌|样貌/,
  /体表|肌肤|皮肤|伤痕|标记|纹|印记/,
  /道具|器物|手持|佩戴|饰品|武器/,
  /内衣|亵衣|下装|上装|外衣|裙|袜|鞋|冠|发饰/,
  /情绪|心情|感受|羞耻|兴奋|快感|理智|清醒/,
  /身材|体型|胸|腰|臀|腿|足/,
  /体液|痕迹|湿|汗/,
]
const MECHANIC_KEY = /(好感|信任|堕落|淫乱|数值|进度|经验|等级|count|uuid|flag|回合|轮次|timestamp|score|point|exp$|lv$|hp$|mp$)/i

function isDescriptive(value) {
  return typeof value === 'string' && value.trim().length >= 2 && !/^-?\d+(?:\.\d+)?$/.test(value.trim())
}

function walkLeaves(node, path, out, depth) {
  if (depth > 6 || out.length > 500) return
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkLeaves(item, path + '[' + index + ']', out, depth + 1))
    return
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) walkLeaves(value, path ? path + '.' + key : key, out, depth + 1)
    return
  }
  if (!isDescriptive(node)) return
  out.push({ path, key: String(path).split('.').pop() ?? path, value: String(node).trim() })
}

export function visualScore(path) {
  const full = String(path)
  const leaf = full.split('.').pop() ?? full
  if (MECHANIC_KEY.test(leaf)) return 0
  let score = 0
  VISUAL_KEY_HINTS.forEach((re, index) => { if (!score && re.test(leaf)) score = 100 - index * 4 })
  if (!score) {
    const parent = full.slice(0, Math.max(0, full.lastIndexOf('.')))
    if (parent) VISUAL_KEY_HINTS.forEach((re, index) => { if (!score && re.test(parent)) score = 72 - index * 3 })
  }
  return score
}

/** 列出画面相关字段的路径（给工具 list/search 用）。 */
export function listVisualPaths(variables, limit = 40) {
  const root = variables?.stat_data && typeof variables.stat_data === 'object' ? variables.stat_data : variables
  if (!root || typeof root !== 'object' || Array.isArray(root)) return []
  const leaves = []
  walkLeaves(root, '', leaves, 0)
  return leaves
    .map(leaf => ({ ...leaf, score: visualScore(leaf.path) }))
    .filter(leaf => leaf.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
}

/** 按路径读一个值（支持中文键，用 / 或 . 分隔）。 */
export function readVisualPath(variables, path) {
  const root = variables?.stat_data && typeof variables.stat_data === 'object' ? variables.stat_data : variables
  if (!root || typeof root !== 'object') return undefined
  const parts = String(path ?? '').replace(/^\/+|\/+$/g, '').split(/[/.]/).filter(Boolean)
  let node = root
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return undefined
    if (!(part in node)) return undefined
    node = node[part]
  }
  return node
}

/** 把命中的变量渲染成工具结果文本（只挑画面相关的内容，避免整份倒给模型）。 */
export function renderVisualState(variables, options = {}) {
  const limit = Math.max(1, Math.min(60, Number(options.limit) || 30))
  const root = variables?.stat_data && typeof variables.stat_data === 'object' ? variables.stat_data : variables
  if (!root || typeof root !== 'object' || Array.isArray(root)) return ''
  const leaves = []
  walkLeaves(root, '', leaves, 0)
  const picked = leaves
    .map(leaf => ({ ...leaf, score: visualScore(leaf.path) }))
    .filter(leaf => leaf.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
  if (!picked.length) return ''
  return picked.map(leaf => '- ' + leaf.path + '：' + (leaf.value.length > 200 ? leaf.value.slice(0, 200) + '…' : leaf.value)).join('\n')
}
