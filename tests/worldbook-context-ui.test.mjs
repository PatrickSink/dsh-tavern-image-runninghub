import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.apply = apply', 'exports.apply = apply; exports.__test = { SettingsPanel }')
const flush = () => new Promise(resolve => setImmediate(resolve))

function harness(worldbook, plannerContext = null, options = {}) {
  const hooks = []
  let cursor = 0
  let effects = []
  let api
  let tree
  const requests = []
  const timers = new Map()
  let timerId = 0
  const state = {
    config: { plannerEnabled: true, plannerCount: 2, imageBackend: 'comfyui', imageChannels: [] },
    workflows: [], definitions: { characters: [], outfits: [] }, outfits: [], tasks: [],
    worldbook, plannerContext,
  }
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) } },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], update => { hooks[index] = typeof update === 'function' ? update(hooks[index]) : update }]
    },
    useRef(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index] },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = hooks[index]
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous[i]))) effects.push(effect)
      hooks[index] = deps
    },
  }
  const context = {
    window: { location: { origin: 'http://test.local' }, top: { location: { origin: 'http://test.local' } }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, addEventListener() {}, __ModuleLoader__: { load({ factory }) { api = factory(name => { assert.equal(name, 'react'); return React }) } } },
    location: { origin: 'http://test.local', href: 'http://test.local' },
    document: { baseURI: 'http://test.local', createElement() { return { click() {} } } },
    confirm: () => true, URL, console, Date, Math, Promise, TypeError,
    setInterval() { return 1 }, clearInterval() {}, setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout(id) { timers.delete(id) },
    async fetch(url, init = {}) {
      const parsed = new URL(url)
      const path = parsed.pathname.split('/').at(-1)
      const body = init.body ? JSON.parse(init.body) : null
      requests.push({ path, method: init.method || 'GET', body })
      if (path === 'worldbook-entry') {
        options.worldbookEntryCalls = (options.worldbookEntryCalls || 0) + 1
        if (options.beforeWorldbookEntry) await options.beforeWorldbookEntry(body)
        if (options.failWorldbookEntry?.(body, options.worldbookEntryCalls)) throw new Error('temporary write failure')
        if (body?.patch) state.worldbook[body.index] = { ...state.worldbook[body.index], ...body.patch }
      }
      const result = path === 'state' ? state : path === 'llm-models' ? { providers: [] } : path === 'worldbook-export' ? { ok: true, worldbook: { name: 'fixture', entries: [{ comment: 'rule', content: 'fixture' }] } } : { ok: true }
      return { ok: true, status: 200, json: async () => result }
    },
  }
  vm.runInNewContext(source, context)
  const nodes = root => !root || typeof root !== 'object' ? [] : [root, ...(root.children || []).flatMap(nodes)]
  const text = node => (node?.children || []).map(child => typeof child === 'object' ? text(child) : child ?? '').join('')
  function render() { cursor = 0; effects = []; tree = api.__test.SettingsPanel(); effects.forEach(effect => effect()); return tree }
  function find(predicate, root = tree) { const node = nodes(root).find(predicate); assert.ok(node, 'UI control was not found'); return node }
  async function ready() { render(); await flush(); render(); await flush(); render() }
  function openWorldbook() { find(node => node.type === 'button' && text(node) === '世界书').props.onClick(); render() }
  async function flushTimers() { for (const callback of [...timers.values()]) callback(); timers.clear(); for (let i = 0; i < 5; i++) await flush() }
  function runTimers() { for (const callback of [...timers.values()]) callback(); timers.clear() }
  return { render, find, nodes, text, ready, openWorldbook, flushTimers, runTimers, requests, state, get tree() { return tree } }
}

test('编辑触发方式、关键词和渠道会分别提交约定字段', async () => {
  const ui = harness([{ index: 0, comment: '氛围规则', content: '雨夜灯光', enabled: true, length: 4 }])
  await ui.ready(); ui.openWorldbook()
  ui.find(node => node.type === 'button' && ui.text(node) === '编辑').props.onClick(); ui.render()
  ui.find(node => node.type === 'input' && node.props.type === 'radio' && node.props.value === 'keywords').props.onChange()
  ui.render()
  const keywords = ui.find(node => node.type === 'textarea' && node.props['aria-label'] === '触发关键词 0')
  keywords.props.onChange({ target: { value: '雨夜，咖啡馆\n深夜' } }); ui.render()
  await ui.flushTimers()
  const geminiLabel = ui.find(node => node.type === 'label' && ui.text(node).trim() === 'Gemini')
  geminiLabel.children.find(node => node?.type === 'input').props.onChange({ target: { checked: true } })
  await flush()

  const writes = ui.requests.filter(request => request.path === 'worldbook-entry')
  assert.ok(writes.some(request => request.body.patch.activation === 'keywords'))
  assert.ok(writes.some(request => JSON.stringify(request.body.patch.keywords) === JSON.stringify(['雨夜', '咖啡馆', '深夜'])))
  assert.ok(writes.some(request => request.body.patch.backends?.includes('gemini')))
})

test('关键词为空时明确说明条目不会注入', async () => {
  const ui = harness([{ index: 0, comment: '仅关键词', content: '', enabled: true, activation: 'keywords', keywords: [], backends: [] }])
  await ui.ready(); ui.openWorldbook()
  ui.find(node => node.type === 'button' && ui.text(node) === '编辑').props.onClick(); ui.render()
  assert.match(ui.text(ui.tree), /没有关键词：此条目不会注入/)
})

test('关键词输入后发生 rerender 仍保留本地文本', async () => {
  const ui = harness([{ index: 0, comment: '关键词规则', content: '', enabled: true, activation: 'keywords', keywords: ['旧词'], backends: [] }])
  await ui.ready(); ui.openWorldbook()
  ui.find(node => node.type === 'button' && ui.text(node) === '编辑').props.onClick(); ui.render()
  ui.find(node => node.type === 'textarea' && node.props['aria-label'] === '触发关键词 0').props.onChange({ target: { value: '新词，另一个词' } })
  ui.render()
  assert.equal(ui.find(node => node.type === 'textarea' && node.props['aria-label'] === '触发关键词 0').props.value, '新词，另一个词')
})

test('700ms 内编辑内容和关键词会合并保存', async () => {
  const ui = harness([{ index: 0, comment: '关键词规则', content: '旧内容', enabled: true, activation: 'keywords', keywords: ['旧词'], backends: [] }])
  await ui.ready(); ui.openWorldbook()
  ui.find(node => node.type === 'button' && ui.text(node) === '编辑').props.onClick(); ui.render()
  ui.find(node => node.type === 'textarea' && node.props.placeholder === '条目内容（作为画图规则发给模型）').props.onChange({ target: { value: '新内容' } })
  ui.render()
  ui.find(node => node.type === 'textarea' && node.props['aria-label'] === '触发关键词 0').props.onChange({ target: { value: '新词，另一个词' } })
  await ui.flushTimers()
  const writes = ui.requests.filter(request => request.path === 'worldbook-entry')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].body.patch.content, '新内容')
  assert.deepEqual(writes[0].body.patch.keywords, ['新词', '另一个词'])
})

test('关键词尚在防抖时切换到常驻会先保存关键词再保存触发方式', async () => {
  const ui = harness([{ index: 0, comment: '关键词规则', content: '', enabled: true, activation: 'keywords', keywords: ['旧词'], backends: [] }])
  await ui.ready(); ui.openWorldbook()
  ui.find(node => node.type === 'button' && ui.text(node) === '编辑').props.onClick(); ui.render()
  ui.find(node => node.type === 'textarea' && node.props['aria-label'] === '触发关键词 0').props.onChange({ target: { value: '最新关键词' } })
  ui.render()
  await ui.find(node => node.type === 'input' && node.props.type === 'radio' && node.props.value === 'always').props.onChange()
  const writes = ui.requests.filter(request => request.path === 'worldbook-entry')
  assert.deepEqual(writes.map(request => request.body.patch), [{ keywords: ['最新关键词'] }, { activation: 'always' }])
  assert.deepEqual(ui.state.worldbook[0].keywords, ['最新关键词'])
  assert.equal(ui.state.worldbook[0].activation, 'always')
})

test('首次没有规划诊断时显示空态', async () => {
  const ui = harness([])
  await ui.ready(); ui.openWorldbook()
  assert.match(ui.text(ui.tree), /暂无诊断记录/)
  assert.match(ui.text(ui.tree), /完成一轮规划后/)
})

test('有诊断时展示条目纳入/排除原因、角色和字符统计', async () => {
  const ui = harness([], {
    turn: 14, backend: 'gemini-chat', at: '2026-10-10T03:04:05Z',
    includedEntries: [{ index: 2, comment: '常驻画风', reason: 'always' }],
    omittedEntries: [{ index: 3, comment: '雨夜', reason: 'keyword-miss' }],
    includedCharacters: [{ name: '小林', reason: 'name-match' }],
    staticChars: 120, dynamicChars: 18, bodyChars: 640,
  })
  await ui.ready(); ui.openWorldbook()
  assert.match(ui.text(ui.tree), /上次规划的诊断/)
  assert.match(ui.text(ui.tree), /轮次 14 · 渠道 Gemini Chat · 时间 2026-10-10T03:04:05Z/)
  assert.match(ui.text(ui.tree), /常驻画风 — 常驻规则/)
  assert.match(ui.text(ui.tree), /雨夜 — 正文未命中关键词/)
  assert.match(ui.text(ui.tree), /小林 — 正文提及角色/)
  assert.match(ui.text(ui.tree), /固定 120 · 动态 18 · 正文 640/)
})

test('剪贴板不可用时世界书导出仍提供 JSON 文本，不显示导出失败', async () => {
  const ui = harness([])
  await ui.ready(); ui.openWorldbook()
  await ui.find(node => node.type === 'button' && ui.text(node) === '📤 导出（复制 JSON）').props.onClick()
  ui.render()
  assert.match(ui.text(ui.tree), /剪贴板不可用/)
  assert.doesNotMatch(ui.text(ui.tree), /导出失败/)
  const textarea = ui.find(node => node.type === 'textarea' && node.props.placeholder === '把世界书 JSON 或纯文本粘在这里…')
  assert.match(textarea.props.value, /"name": "fixture"/)
  assert.ok(ui.requests.some(request => request.path === 'worldbook-export' && request.method === 'GET'))
})
