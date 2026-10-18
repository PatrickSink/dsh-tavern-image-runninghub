import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEntryActivation, selectPlannerContext, charactersFromDesignLore, charactersFromDesignArchive } from '../lib/planner-context.js'

const chars = { characters: [
  { id: 'a', name: '安', match: 'Ann, Ann Lee', traits: { face: 'A face' } },
  { id: 'b', name: 'Anna', match: 'Anna Smith', traits: { face: 'B face' } },
  { id: 'c', name: '小明', match: 'Xiao Ming, Ming', traits: { face: 'C face' } },
] }

test('activation defaults to resident and preserves ordinary ST keyword fields', () => {
  assert.deepEqual(normalizeEntryActivation({}), { activation: 'always', keywords: [], backends: [] })
  assert.deepEqual(normalizeEntryActivation({ key: ['Ann', '安'], constant: false, backend: 'comfyui' }), {
    activation: 'keywords', keywords: ['Ann', '安'], backends: ['comfyui'],
  })
  assert.equal(normalizeEntryActivation({ key: ['Ann'], constant: true }).activation, 'always')
  assert.equal(normalizeEntryActivation({ key: ['Ann'], use_regex: true }).activation, 'always')
  assert.equal(normalizeEntryActivation({ activation: 'always', keywords: ['Ann'] }).activation, 'always')
  assert.equal(normalizeEntryActivation({ activation: 'keywords', keywords: ['Ann'] }).activation, 'keywords')
  assert.equal(normalizeEntryActivation({ key: ['Ann'], keysecondary: [] }).activation, 'keywords')
  assert.equal(normalizeEntryActivation({ key: ['Ann'], keysecondary: ['woman'] }).activation, 'always')
  assert.equal(normalizeEntryActivation({ key: ['Ann'], selectiveLogic: 'and' }).activation, 'keywords')
  assert.equal(normalizeEntryActivation({ key: ['Ann'], selective: true, selectiveLogic: 'and' }).activation, 'always')
  assert.deepEqual(normalizeEntryActivation(null), { activation: 'always', keywords: [], backends: [] })
})

test('selection honors legacy, explicit keyword, disabled, and backend rules', () => {
  const entries = [
    { index: 0, comment: 'legacy', content: 'resident' },
    { index: 1, comment: 'hit', content: 'hit rule', activation: 'keywords', keywords: ['Ann'] },
    { index: 2, comment: 'miss', content: 'miss rule', activation: 'keywords', keywords: ['Anna'] },
    { index: 3, comment: 'empty', content: 'empty rule', activation: 'keywords', keywords: [] },
    { index: 4, comment: 'off', content: 'off rule', enabled: false },
    { index: 5, comment: 'other backend', content: 'other', activation: 'always', backends: ['novelai'] },
  ]
  const result = selectPlannerContext({ entries, text: 'Ann met 安。', definitions: chars, backend: 'comfyui' })
  assert.match(result.staticRules, /resident/)
  assert.doesNotMatch(result.staticRules, /hit rule/)
  assert.match(result.dynamicRules, /hit rule/)
  assert.deepEqual(result.diagnostics.omittedEntries.map(x => [x.index, x.reason]), [
    [2, 'keyword-miss'], [3, 'empty-keywords'], [4, 'disabled'], [5, 'backend-mismatch'],
  ])
  assert.deepEqual(result.diagnostics.includedCharacters.map(x => x.stable_id), ['a'])
  assert.deepEqual(result.definitions.characters.map(x => x.id), ['a'])
  assert.match(result.rosterIndex, /Anna \[stable_id=b\]/)
  assert.match(result.rosterIndex, /小明 \[stable_id=c\]/)
})

test('CJK and comma aliases match; Latin names do not match substrings', () => {
  const alias = selectPlannerContext({ definitions: chars, text: 'Xiao Ming arrived.' })
  assert.deepEqual(alias.definitions.characters.map(x => x.id), ['c'])
  const ann = selectPlannerContext({ definitions: chars, text: 'Anna Smith arrived.' })
  assert.deepEqual(ann.definitions.characters.map(x => x.id), ['b'])
  const cjk = selectPlannerContext({ definitions: chars, text: '小明到了。' })
  assert.deepEqual(cjk.definitions.characters.map(x => x.id), ['c'])
  const latinBesideCjk = selectPlannerContext({ definitions: chars, text: 'Ann走进房间。' })
  assert.deepEqual(latinBesideCjk.definitions.characters.map(x => x.id), ['a'])
  const mixed = selectPlannerContext({
    entries: [{ index: 0, content: 'floor rule', activation: 'keywords', keywords: ['3楼药铺'] }],
    text: '他们走进3楼药铺里。',
  })
  assert.match(mixed.dynamicRules, /floor rule/)
})

test('zero reliable name hits conservatively includes all characters', () => {
  const result = selectPlannerContext({ definitions: chars, text: '她走进房间。', characterUpdates: true })
  assert.equal(result.diagnostics.characterFallback, true)
  assert.deepEqual(result.definitions.characters.map(x => x.id), ['a', 'b', 'c'])
  assert.equal(result.fullTraits, true)
})

test('empty backend restrictions include on every backend', () => {
  const result = selectPlannerContext({ entries: [{ index: 0, content: 'all', backends: [] }], backend: 'novelai' })
  assert.match(result.staticRules, /all/)
})

test('legacy entries retain the previous selected-list default', () => {
  const result = selectPlannerContext({ entries: [
    { index: 0, content: 'default resident' },
    { index: 20, content: 'legacy unselected' },
  ] })
  assert.match(result.staticRules, /default resident/)
  assert.doesNotMatch(result.staticRules, /legacy unselected/)
  assert.equal(result.diagnostics.omittedEntries[0].reason, 'not-selected')
})

test('blank content is omitted from diagnostics instead of counted as included', () => {
  const result = selectPlannerContext({ entries: [{ index: 0, comment: 'empty', content: '  ' }] })
  assert.deepEqual(result.diagnostics.includedEntries, [])
  assert.deepEqual(result.diagnostics.omittedEntries, [{ index: 0, comment: 'empty', reason: 'empty-content' }])
})

// ── 人物白描改从本体的「设计人物」来 ─────────────────────────────────────
// 设计人物是本局世界书里的条目（标题「人物设计 · <名>」），正文由 character-design
// skill 按固定五段写出。下面这条用的是真实数据形状，含那个很长的「剧情作用…」标签。

const designEntry = (name, fields) => ({
  title: '人物设计 · ' + name,
  keys: [name],
  constant: false,
  content: ['人物：' + name, ...Object.entries(fields).map(([label, value]) => label + '：' + value)].join('\n\n'),
})

test('设计人物条目 → 人物白描：按标题前缀识别，分字段解析', () => {
  const lore = [
    designEntry('刀疤番僧', {
      '身份': '欢喜教在中原暗线上最实的经手人，认差事不认人情',
      '性格': '对人怀有猎户看牲口般的耐心，不急于一时之欢',
      '外貌': '年约五十，身量高瘦如枯竹，脊背却笔直。面上自眉骨斜至嘴角一道旧疤；身着暗黄旧僧袍，颈挂乌木念珠，足踏厚底麻鞋',
      '说话方式': '汉话说得生硬，字字咬重，句子短而硬',
      '剧情作用与可能的发展（不是已发生的事实）': '把林凡的一腔血气按回泥里，逼出他第一次惨败',
    }),
    { title: '宗门规矩', keys: ['宗门'], constant: true, content: '这不是人物条目，不该被当成角色' },
    { title: '人物设计 · 空条目', keys: [], constant: false, content: '' },
  ]
  const out = charactersFromDesignLore(lore)

  assert.equal(out.length, 1, '只应识别出 1 个设计人物')
  const monk = out[0]
  assert.equal(monk.name, '刀疤番僧')
  assert.equal(monk.match, '刀疤番僧')
  assert.equal(monk.enabled, true)
  // 外貌整段进 face（含日常穿着），这是唯一的画面依据
  assert.match(monk.traits.face, /身量高瘦如枯竹/)
  assert.match(monk.traits.face, /暗黄旧僧袍/)
  // 身份与性格进 feature，供规划模型判断气质
  assert.match(monk.traits.feature, /欢喜教/)
  assert.match(monk.traits.feature, /猎户看牲口/)
  // 很长的标签也要认出来
  assert.ok(!/剧情作用/.test(monk.traits.face), '剧情作用不该混进外貌')
})

test('设计人物：姓名以正文「人物：」行为准，同一名字只取一次', () => {
  const lore = [
    { title: '人物设计 · 旧标题', keys: ['叶冰'], constant: false, content: '人物：叶冰\n\n外貌：白衣，削肩，眉目很冷' },
    { title: '人物设计 · 叶冰', keys: ['叶冰'], constant: false, content: '人物：叶冰\n\n外貌：重复条目' },
  ]
  const out = charactersFromDesignLore(lore)
  assert.equal(out.length, 1)
  assert.equal(out[0].name, '叶冰', '以正文里的名字为准')
  assert.match(out[0].traits.face, /白衣/)
})

test('设计人物：没有设计条目时返回空，不报错', () => {
  assert.deepEqual(charactersFromDesignLore([]), [])
  assert.deepEqual(charactersFromDesignLore(null), [])
  assert.deepEqual(charactersFromDesignLore([{ title: '别的条目', content: '正文' }]), [])
})

// ── 人物白描走 Tavern 的专用接口 getCharacterDesigns ─────────────────────
// 形状来自 projectCharacterDesignDocument：characters[].sections 是
// { key, label, text } 五项（身份/性格/外貌/说话方式/剧情作用）。

const designArchive = (list) => ({ revision: 1, updatedAt: Date.now(), characters: list })

const designChar = (name, sections, extra = {}) => ({
  name,
  aliases: extra.aliases ?? [],
  identity: extra.identity ?? '',
  narrativeRole: extra.narrativeRole ?? '',
  updatedAt: Date.now(),
  sections: Object.entries(sections).map(([label, text]) => ({
    key: { 身份: 'identity', 性格: 'personality', 外貌: 'appearance', 说话方式: 'speechStyle', 剧情作用: 'narrativeRole' }[label] ?? label,
    label, text,
  })),
})

test('人物设计档案 → 白描：外貌进 face，身份+性格进 feature', () => {
  const out = charactersFromDesignArchive(designArchive([
    designChar('刀疤番僧', {
      身份: '欢喜教在中原暗线上的经手人',
      性格: '猎户看牲口般的耐心',
      外貌: '年约五十，身量高瘦如枯竹；身着暗黄旧僧袍，颈挂乌木念珠',
      说话方式: '字字咬重',
      剧情作用: '逼出林凡第一次惨败',
    }, { aliases: ['番僧'] }),
  ]))

  assert.equal(out.length, 1)
  const monk = out[0]
  assert.equal(monk.name, '刀疤番僧')
  assert.match(monk.traits.face, /身量高瘦如枯竹/)
  assert.match(monk.traits.face, /暗黄旧僧袍/)
  assert.match(monk.traits.feature, /欢喜教/)
  assert.match(monk.traits.feature, /猎户看牲口/)
  assert.match(monk.match, /番僧/, '别名应进 match 参与正文命中')
  assert.ok(!/剧情作用|说话方式/.test(monk.traits.face), '剧情作用与说话方式不该混进外貌')
})

test('人物设计档案：空档案 / 缺字段 / 匿名条目都安全', () => {
  assert.deepEqual(charactersFromDesignArchive(null), [])
  assert.deepEqual(charactersFromDesignArchive({ characters: [] }), [])
  assert.deepEqual(charactersFromDesignArchive({ characters: [{ name: '' }] }), [])
  // 只有身份、没有外貌时也不该抛错
  const out = charactersFromDesignArchive(designArchive([designChar('莉奈', { 身份: '女仆' })]))
  assert.equal(out.length, 1)
  assert.equal(out[0].traits.face, '')
  assert.equal(out[0].traits.feature, '女仆')
})

test('人物设计档案：交进 selectPlannerContext 能按正文命中被选中', () => {
  const chars = charactersFromDesignArchive(designArchive([
    designChar('莉奈', { 外貌: 'silver hair' }),
    designChar('塞西莉亚', { 外貌: 'green eyes' }),
  ]))
  const out = selectPlannerContext({ entries: [], selected: [], text: '莉奈端来茶。', definitions: { characters: chars }, backend: 'runninghub' })
  const names = (out.diagnostics.includedCharacters || []).map(c => c.name)
  assert.deepEqual(names, ['莉奈'])
})
