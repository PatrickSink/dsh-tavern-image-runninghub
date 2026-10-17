import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

test('workflow parameter editor reads and saves a TextMultiline value binding', async t => {
  const source = fileURLToPath(new URL('..', import.meta.url))
  const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-values-test-'))
  await mkdir(join(root, 'lib')); await mkdir(join(root, 'workflows'))
  await cp(join(source, 'lib'), join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'worldbook.json'), JSON.stringify({ name: 'test', entries: [] }))
  await writeFile(join(root, 'definitions.json'), JSON.stringify({ characters: [] }))
  await writeFile(join(root, 'workflows', 'text.json'), JSON.stringify({
    format: 'dsh-tavern-image-v1', outputNode: '4',
    prompt: {
      '1': { class_type: 'KSampler', inputs: { positive: ['2', 0] } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: ['3', 0] } },
      '3': { class_type: 'TextMultiline', inputs: { value: 'original multiline prompt' } },
      '4': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    },
    bindings: { positive: [{ node: '3', input: 'value' }] },
  }))

  const routes = new Map(), disposes = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    llm: { stream: async function* () {} },
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
    inject(names, install) { if (names.every(name => this[name])) install(this) },
    effect(install) { const off = install(); if (typeof off === 'function') disposes.push(off); return off },
  }
  // The plugin derives its data root from its copied lib/index.js; no installed data is touched.
  const { apply } = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  apply(ctx, { plannerProvider: 'mock', plannerModel: 'mock' })
  const request = (body) => new Promise((resolvePromise, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method: 'POST', url: '/plugins/dsh-tavern-image/workflow-values', headers: { host: 'localhost', 'content-type': 'application/json' } })
    const res = {
      headersSent: false,
      writeHead(status) { this.status = status; this.headersSent = true },
      end(content) { try { resolvePromise({ status: this.status, body: JSON.parse(String(content)) }) } catch (error) { reject(error) } },
    }
    routes.get(req.url)(req, res)
  })
  t.after(async () => {
    for (const dispose of disposes.reverse()) dispose()
    assert.equal(resolve(root).startsWith(resolve(tmpdir())), true)
    await rm(root, { recursive: true, force: true })
  })

  const loaded = await request({ file: 'text.json' })
  assert.equal(loaded.status, 200)
  assert.equal(loaded.body.values.positive, 'original multiline prompt')
  const saved = await request({ file: 'text.json', values: { positive: 'new line one\nnew line two' } })
  assert.equal(saved.status, 200)
  const workflow = JSON.parse(await readFile(join(root, 'workflows', 'text.json'), 'utf8'))
  assert.equal(workflow.prompt['3'].inputs.value, 'new line one\nnew line two')
})
