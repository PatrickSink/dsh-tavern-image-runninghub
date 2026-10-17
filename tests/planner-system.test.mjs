import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPlannerSystem } from '../lib/planner.js'

test('resident system prefix stays stable when story, roster, and count change', () => {
  const base = { rules: '常驻规则', extra: '静态画风规则' }
  const one = buildPlannerSystem({ ...base, count: 1, dynamicRules: '正文规则甲', roster: '角色甲' })
  const many = buildPlannerSystem({ ...base, count: 5, dynamicRules: '正文规则乙', roster: '角色乙', rosterIndex: '其他角色' })
  const residentPrefix = system => system.split(/以下按正文触发的世界书规则/)[0]
  assert.equal(residentPrefix(one), residentPrefix(many))
  assert.ok(residentPrefix(one).indexOf('常驻规则') < residentPrefix(one).indexOf('静态画风规则'))
  assert.ok(residentPrefix(one).includes('尺度要求'))
  assert.ok(residentPrefix(one).includes('<固定输出协议>'))
  assert.ok(residentPrefix(one).includes('<regex>正文中逐字一致的一句话</regex>'))
  assert.ok(residentPrefix(one).includes('<title_styled>一句简短标题</title_styled>'))
  assert.ok(residentPrefix(one).includes('<prompts>完整画面提示词</prompts>'))
  assert.ok(residentPrefix(one).includes('decision 之后不可修改'))
})

test('dynamic instructions and roster follow resident rules; update and decision precede images', () => {
  const system = buildPlannerSystem({
    rules: '常驻规则', dynamicRules: '按需规则', roster: '命中角色全资料', rosterIndex: '未出场角色索引',
    count: 3, smartSelection: true, characterUpdates: true,
  })
  assert.ok(system.indexOf('常驻规则') < system.indexOf('以下按正文触发的世界书规则'))
  assert.ok(system.indexOf('以下按正文触发的世界书规则') < system.indexOf('命中角色全资料'))
  assert.ok(system.indexOf('未出场角色索引') < system.indexOf('<角色视觉历史>'))
  assert.ok(system.indexOf('<角色视觉历史>') < system.indexOf('<本次任务>'))
  assert.match(system, /<decision>draw<\/decision>/)
  assert.match(system, /决定不可修改/)
  assert.match(system, /不同叙事功能、景别或动作/)
  assert.match(system, /正文明确变化时如实反映/)
  assert.match(system, /未写出变化时才延续前一张状态/)
  assert.match(system, /不要添加冗长思考/)
})

test('old buildPlannerSystem call shape remains supported', () => {
  const system = buildPlannerSystem({ rules: '旧规则', roster: '旧名单', count: 2, extra: '旧叮嘱' })
  assert.match(system, /旧规则/)
  assert.match(system, /旧名单/)
  assert.match(system, /旧叮嘱/)
  assert.match(system, /2 张插图/)
})
