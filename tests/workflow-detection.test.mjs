import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWorkflow } from '../lib/index.js'

const encode = (text) => ({ class_type: 'CLIPTextEncode', inputs: { clip: ['10', 1], text } })

test('sampler bindings trace through CLIP encoders to multiline prompt inputs', () => {
  const workflow = normalizeWorkflow({
    '1': { class_type: 'KSampler', inputs: { positive: ['2', 0], negative: ['3', 0], seed: 4, steps: 20 } },
    '2': encode(['4', 0]),
    '3': encode('low quality, placeholder negative'),
    '4': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'subject placeholder\nsecond line' } },
  })

  assert.deepEqual(workflow.bindings.positive, [{ node: '4', input: 'value' }])
  assert.deepEqual(workflow.bindings.negative, [{ node: '3', input: 'text' }])
})

test('string references are not mistaken for links and unrelated strings are not prompt bindings', () => {
  const workflow = normalizeWorkflow({
    '1': { class_type: 'KSampler', inputs: { positive: ['2', 0] } },
    '2': encode('4'),
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors', title: 'model' } },
    '5': { class_type: 'UnknownUtility', inputs: { mode: 'portrait', path: 'images/output' } },
  })

  // The text literal belongs to the encoder; neither a string that resembles a node ID nor
  // strings on loader/unknown nodes should redirect or create prompt bindings.
  assert.deepEqual(workflow.bindings.positive, [{ node: '2', input: 'text' }])
  assert.deepEqual(workflow.bindings.negative, [])
})

test('already supplied prompt bindings survive normalization unchanged', () => {
  const bindings = { positive: [{ node: '7', input: 'content' }], negative: [], custom: { keep: true } }
  const prompt = { '7': { class_type: 'Text Multiline', inputs: { content: 'existing' } } }
  const workflow = normalizeWorkflow({ format: 'dsh-tavern-image-v1', prompt, bindings, outputNode: '9' })

  assert.deepEqual(workflow.bindings, bindings)
  assert.equal(workflow.prompt, prompt)
})

test('two samplers deduplicate the same prompt targets and titles identify negative text', () => {
  const workflow = normalizeWorkflow({
    '1': { class_type: 'KSampler', inputs: { positive: ['2', 0], negative: ['3', 0] } },
    '4': { class_type: 'KSamplerAdvanced', inputs: { positive: ['2', 0], negative: ['3', 0] } },
    '2': encode(['5', 0]),
    '3': encode(['6', 0]),
    '5': { class_type: 'Text Multiline', inputs: { text: 'positive text' } },
    '6': { class_type: 'Text Multiline', _meta: { title: 'Negative prompt' }, inputs: { text: 'negative text' } },
    '7': { class_type: 'Text Multiline', _meta: { title: 'Negative prompt' }, inputs: { text: 'other negative' } },
  })

  assert.deepEqual(workflow.bindings.positive, [{ node: '5', input: 'text' }])
  assert.deepEqual(workflow.bindings.negative, [{ node: '6', input: 'text' }])
})

test('SDXL text_g and text_l both bind through their upstream text nodes', () => {
  const workflow = normalizeWorkflow({
    '1': { class_type: 'KSampler', inputs: { positive: ['2', 0] } },
    '2': { class_type: 'CLIPTextEncodeSDXL', inputs: { clip: ['10', 1], text_g: ['3', 0], text_l: ['4', 0] } },
    '3': { class_type: 'Text Multiline', inputs: { text: 'global placeholder' } },
    '4': { class_type: 'Text Multiline', inputs: { text: 'local placeholder' } },
  })

  assert.deepEqual(workflow.bindings.positive, [
    { node: '3', input: 'text' },
    { node: '4', input: 'text' },
  ])
})

test('text backtracking stops at cycles and after eight links', () => {
  const cycle = normalizeWorkflow({
    '1': { class_type: 'KSampler', inputs: { positive: ['2', 0] } },
    '2': { class_type: 'Text Relay', inputs: { text: ['3', 0] } },
    '3': { class_type: 'Text Relay', inputs: { text: ['2', 0] } },
  })
  assert.deepEqual(cycle.bindings.positive, [])

  const withinLimit = { '1': { class_type: 'KSampler', inputs: { positive: ['2', 0] } } }
  for (let id = 2; id <= 10; id += 1) {
    withinLimit[String(id)] = id === 10
      ? { class_type: 'Text Multiline', inputs: { text: 'reachable at eight hops' } }
      : { class_type: 'Text Relay', inputs: { text: [String(id + 1), 0] } }
  }
  assert.deepEqual(normalizeWorkflow(withinLimit).bindings.positive, [{ node: '10', input: 'text' }])

  const overLimit = { '1': { class_type: 'KSampler', inputs: { positive: ['2', 0] } } }
  for (let id = 2; id <= 11; id += 1) {
    overLimit[String(id)] = id === 11
      ? { class_type: 'Text Multiline', inputs: { text: 'too far' } }
      : { class_type: 'Text Relay', inputs: { text: [String(id + 1), 0] } }
  }
  assert.ok(!normalizeWorkflow(overLimit).bindings.positive.some(binding => binding.node === '11'))
})

test('TextMultiline value fields remain valid prompt binding inputs', () => {
  const workflow = normalizeWorkflow({
    '1': { class_type: 'KSampler', inputs: { positive: ['2', 0] } },
    '2': encode(['3', 0]),
    '3': { class_type: 'TextMultiline', inputs: { value: 'editable multiline text' } },
  })
  assert.deepEqual(workflow.bindings.positive, [{ node: '3', input: 'value' }])
})

test('prompt composition ignores delimiters and zeroed conditioning is not a negative prompt', () => {
  const workflow = normalizeWorkflow({
    '1': { class_type: 'KSampler', inputs: { positive: ['2', 0], negative: ['3', 0] } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: ['4', 0] } },
    '3': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['2', 0] } },
    '4': { class_type: 'StringConcatenate', inputs: { string_a: ['5', 0], string_b: ['6', 0], delimiter: ', ' } },
    '5': { class_type: 'TriggerWord Toggle', inputs: { text: 'style trigger' } },
    '6': { class_type: 'easy stylesSelector', inputs: { positive: ['7', 0] } },
    '7': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'actual editable prompt' } },
  })

  assert.deepEqual(workflow.bindings.positive, [{ node: '7', input: 'value' }])
  assert.deepEqual(workflow.bindings.negative, [])
})
