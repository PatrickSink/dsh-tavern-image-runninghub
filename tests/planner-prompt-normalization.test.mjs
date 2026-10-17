import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePrompts } from '../lib/planner.js'

test('Comfy prompts remove Chinese passages and keep a known English character alias', () => {
  const result = normalizePrompts('小明，站在雨中的街道，wearing a blue coat，cinematic lighting', {
    characters: [{ name: '小明', match: 'Xiaoming, male' }],
  }, { backend: 'comfyui', mode: 'natural' })

  assert.equal(result, 'Xiaoming, wearing a blue coat cinematic lighting')
})

test('Chinese-capable image backends retain Chinese natural-language prompts', () => {
  const prompt = '一位少女站在雨中的街道，柔和的电影光线'
  const definitions = { characters: [{ name: '小明', match: 'Xiaoming, male' }] }

  for (const backend of ['openai', 'gemini', 'gemini-chat', 'qwen']) {
    assert.equal(normalizePrompts(`小明，${prompt}`, definitions, { backend, mode: 'natural' }), `小明，${prompt}`)
  }
})

test('Chinese-only Comfy prompts fail before submission after cleanup and deduplication', () => {
  for (const prompt of ['雨中的少女在街道', '雨中的少女,,,,，']) {
    assert.throws(() => normalizePrompts(prompt, {}, { backend: 'comfyui', mode: 'tags' }), error => {
      assert.equal(error.message, 'ComfyUI 提示词清理后为空，请改用英文提示词。')
      assert.equal(error.submissionNotStarted, true)
      return true
    })
  }
})

test('callers without backend context keep legacy Comfy cleanup behavior', () => {
  assert.equal(normalizePrompts('蓝色外套，blue coat'), 'blue coat')
  assert.throws(() => normalizePrompts('雨中的少女在街道'), error => error.submissionNotStarted === true)
  assert.equal(normalizePrompts(''), '')
  assert.equal(normalizePrompts(',,,,', {}, { backend: 'comfyui' }), '')
})
