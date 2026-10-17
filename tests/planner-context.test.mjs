import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEntryActivation, selectPlannerContext } from '../lib/planner-context.js'

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
