import test from 'node:test'
import assert from 'node:assert/strict'
import { createMediaActions } from '../lib/media-actions.js'

const source = (overrides = {}) => ({
  id: 'media-a', owner: 'dsh-tavern-image', turn: 4, textVersion: 'version-a',
  kind: 'dsh-tavern-image/image', status: 'ready', anchor: 'paragraph one',
  attachment: { id: 'old-attachment', mediaType: 'image/png' },
  data: { jobId: 'old-job', prompt: 'original prompt', channelId: 'channel-old' },
  ...overrides,
})

function fixture({ media = [source()], jobs = {}, start, cancel, refresh, delay = 1, timeoutMs = 100, pollMs = 1 } = {}) {
  let current = { textVersion: 'version-a', text: 'settled text' }
  let starts = []
  let cancels = []
  const state = { media, current }
  const tavern = {
    async getTurn() { return state.current },
    async list() { return state.media.map(item => structuredClone(item)) },
    async update(id, patch) {
      const item = state.media.find(value => value.id === id)
      if (!item) throw new Error('missing item')
      Object.assign(item, structuredClone(patch))
      return { id }
    },
    onGameRemoved(handler) { this.removed = handler; return () => {} },
    onTimelineChanged(handler) { this.timeline = handler; return () => {} },
  }
  const actions = createMediaActions({
    tavern,
    attachments: { async saveImage(value) { return { id: 'new-attachment-' + starts.length, mediaType: value.mediaType } } },
    getJob: async id => jobs[id] || null,
    refreshJob: async (id, options) => refresh?.(id, jobs, options),
    startReplacement: async args => {
      starts.push(args)
      if (start) return start(args, starts.length)
      const id = 'job-' + starts.length
      jobs[id] = { state: 'done', file: 'bytes-' + id, mediaType: 'image/png' }
      return { jobId: id }
    },
    cancelJob: async id => { cancels.push(id); if (cancel) return cancel(id); jobs[id] = { state: 'cancelled' }; return { state: 'cancelled' } },
    readFileAsBytes: async file => new Uint8Array([file.length]),
    timeoutMs, pollMs,
  })
  return { state, actions, jobs, starts, cancels, tavern }
}

const request = (overrides = {}) => ({
  operation: 'redraw', gameId: 'game-a', turn: 4, textVersion: 'version-a',
  mediaId: 'media-a', jobId: 'old-job', prompt: 'redrawn', negative: 'bad', channelId: 'channel-new',
  ...overrides,
})

async function until(predicate, message = 'timed out') {
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail(message)
}

test('redraw updates the same media id only after ready and preserves channel scope', async () => {
  const f = fixture()
  const before = f.state.media[0].attachment
  const result = await f.actions.handle(request())
  assert.deepEqual({ ok: result.ok, mediaId: result.mediaId, state: result.state }, { ok: true, mediaId: 'media-a', state: 'pending' })
  assert.deepEqual(f.state.media[0].attachment, before)
  assert.equal(f.starts[0].channelId, 'channel-new')
  await until(() => f.state.media[0].data.jobId === result.jobId && f.state.media[0].data.replacement.state === 'ready')
  assert.equal(f.state.media.length, 1)
  assert.equal(f.state.media[0].id, 'media-a')
  assert.notEqual(f.state.media[0].attachment.id, 'old-attachment')
  assert.equal(f.state.media[0].data.channelId, 'channel-new')
})

test('known failure leaves the ready old attachment intact and records replacement error', async () => {
  const jobs = {}
  const f = fixture({ jobs, start: (_args, n) => { jobs['job-' + n] = { state: 'failed', error: 'provider rejected' }; return { jobId: 'job-' + n } } })
  const result = await f.actions.handle(request())
  await until(() => f.state.media[0].data.replacement?.state === 'failed')
  assert.equal(f.state.media[0].attachment.id, 'old-attachment')
  assert.equal(f.state.media[0].status, 'ready')
  assert.match(f.state.media[0].error, /provider rejected/)
  assert.equal(result.jobId, 'job-1')
})

test('cancel is scoped to the selected image replacement job', async () => {
  const jobs = { 'replace-me': { state: 'running' }, 'other-job': { state: 'running' } }
  const f = fixture({ jobs, media: [source({ data: { jobId: 'old-job', replacement: { jobId: 'replace-me', state: 'pending' } } }), source({ id: 'media-b', data: { jobId: 'other-job' } })] })
  const result = await f.actions.handle(request({ operation: 'cancel', jobId: 'replace-me' }))
  assert.equal(result.state, 'cancelled')
  assert.deepEqual(f.cancels, ['replace-me'])
  assert.equal(jobs['other-job'].state, 'running')
  assert.equal(f.state.media[1].attachment.id, 'old-attachment')
})

test('initial queued image can be cancelled without affecting another image, and a confirmed queued cancel can be retried', async () => {
  const jobs = {
    'initial-queued': { state: 'queued', requestMayHaveSucceeded: false, requestStarted: false },
    'other-running': { state: 'running', requestStarted: true },
  }
  const f = fixture({ jobs, media: [
    source({ status: 'pending', attachment: null, data: { jobId: 'initial-queued' } }),
    source({ id: 'media-b', status: 'pending', attachment: null, data: { jobId: 'other-running' } }),
  ] })
  const result = await f.actions.handle(request({ operation: 'cancel', jobId: 'initial-queued' }))
  assert.equal(result.state, 'cancelled')
  assert.deepEqual(f.cancels, ['initial-queued'])
  assert.equal(f.state.media[0].status, 'failed')
  assert.equal(f.state.media[0].data.cancelled, true)
  assert.equal(f.state.media[0].error, '已取消')
  assert.equal(jobs['other-running'].state, 'running')
  const retried = await f.actions.handle(request({ operation: 'retry', jobId: 'initial-queued' }))
  assert.equal(retried.state, 'pending')
  assert.equal(f.starts.length, 1)
})

test('completed primary image is not cancelled', async () => {
  const jobs = { 'old-job': { state: 'done', file: 'old.png', mediaType: 'image/png' } }
  const f = fixture({ jobs })
  const result = await f.actions.handle(request({ operation: 'cancel' }))
  assert.equal(result.state, 'done')
  assert.deepEqual(f.cancels, [])
  assert.equal(f.state.media[0].attachment.id, 'old-attachment')
})

test('uncertain initial request is not reported cancelled', async () => {
  const jobs = { 'old-job': { state: 'uncertain', requestMayHaveSucceeded: true } }
  const f = fixture({ jobs, media: [source({ status: 'pending', attachment: null })] })
  const result = await f.actions.handle(request({ operation: 'cancel' }))
  assert.equal(result.state, 'uncertain')
  assert.deepEqual(f.cancels, [])
  assert.equal(f.state.media[0].data.cancelled, undefined)
})

test('cancelled inflight request warns that the provider may continue and blocks retry', async () => {
  const jobs = { 'old-job': { state: 'running', requestStarted: true, requestMayHaveSucceeded: false } }
  const f = fixture({ jobs, media: [source({ status: 'pending', attachment: null })] })
  const result = await f.actions.handle(request({ operation: 'cancel' }))
  assert.equal(result.state, 'cancelled')
  assert.match(f.state.media[0].error, /可能继续生成并产生费用/)
  await assert.rejects(f.actions.handle(request({ operation: 'retry' })), { code: 'UNCERTAIN' })
  assert.equal(f.starts.length, 0)
})

test('stale text versions are rejected before starting a job', async () => {
  const f = fixture()
  f.state.current = { textVersion: 'version-b', text: 'new text' }
  await assert.rejects(f.actions.handle(request()), { code: 'STALE_VERSION' })
  assert.equal(f.starts.length, 0)
})

test('double-clicking the same action while submission is pending starts only once', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const jobs = {}
  const f = fixture({ jobs, start: async (_args, n) => { await gate; jobs['job-' + n] = { state: 'done', file: 'newfile', mediaType: 'image/png' }; return { jobId: 'job-' + n } } })
  const first = f.actions.handle(request())
  await new Promise(resolve => setTimeout(resolve, 2))
  const second = f.actions.handle(request())
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(f.starts.length, 1)
  assert.equal(a.jobId, b.jobId)
  await until(() => f.state.media[0].data.replacement.state === 'ready')
})

test('unknown submission outcome blocks automatic retry', async () => {
  const f = fixture({ start: async () => { throw new Error('connection lost') } })
  await assert.rejects(f.actions.handle(request()), { code: 'UNCERTAIN' })
  assert.equal(f.state.media[0].data.replacement.state, 'uncertain')
  await assert.rejects(f.actions.handle(request({ operation: 'retry' })), { code: 'UNCERTAIN' })
  assert.equal(f.starts.length, 1)
})

test('explicit local validation rejection stays failed and may be retried after editing', async () => {
  let attempts = 0
  const f = fixture({ start: async () => {
    attempts++
    if (attempts === 1) throw Object.assign(new Error('所选渠道已删除'), { submissionNotStarted: true })
    const id = 'job-' + attempts
    f.jobs[id] = { state: 'done', file: 'new-' + id, mediaType: 'image/png' }
    return { jobId: id }
  } })
  await assert.rejects(f.actions.handle(request()), error => error.code === 'REJECTED' && error.submissionNotStarted === true)
  assert.equal(f.state.media[0].data.replacement.state, 'failed')
  assert.equal(f.state.media[0].attachment.id, 'old-attachment')
  const result = await f.actions.handle(request({ operation: 'retry', prompt: 'edited valid prompt' }))
  assert.equal(result.state, 'pending')
  assert.equal(attempts, 2)
})

test('uncertain provider jobs cannot be retried or bypassed with redraw', async () => {
  const jobs = { 'old-job': { state: 'uncertain', requestMayHaveSucceeded: true, error: 'provider response lost' } }
  const f = fixture({ jobs })
  await assert.rejects(f.actions.handle(request()), { code: 'UNCERTAIN' })
  await assert.rejects(f.actions.handle(request({ operation: 'retry' })), { code: 'UNCERTAIN' })
  assert.equal(f.starts.length, 0)
})

test('confirmed failure can be explicitly retried', async () => {
  const jobs = { 'failed-redraw': { state: 'failed', error: 'provider rejected' } }
  const f = fixture({ jobs, media: [source({ data: { jobId: 'old-job', replacement: { jobId: 'failed-redraw', state: 'failed', prompt: 'retry this' } } })] })
  const result = await f.actions.handle(request({ operation: 'retry', prompt: 'retry this' }))
  assert.equal(result.state, 'pending')
  assert.equal(f.starts.length, 1)
})

test('media not owned by this plugin cannot be changed even with a valid client job id', async () => {
  const f = fixture({ media: [source({ kind: 'some-other-plugin/image' })] })
  await assert.rejects(f.actions.handle(request()), { code: 'MEDIA_NOT_FOUND' })
  assert.equal(f.starts.length, 0)
})

test('a removed or changed media item cannot receive an old result', async () => {
  const jobs = {}
  const f = fixture({ jobs, start: (_args, n) => { jobs['job-' + n] = { state: 'done', file: 'newfile', mediaType: 'image/png' }; return { jobId: 'job-' + n } } })
  const response = await f.actions.handle(request())
  f.state.current = { textVersion: 'version-b', text: 'edited' }
  await until(() => f.state.media[0].data.replacement.state === 'cancelled')
  assert.equal(f.state.media[0].attachment.id, 'old-attachment')
  assert.equal(f.state.media[0].data.jobId, 'old-job')
  assert.equal(response.state, 'pending')
})

test('confirmed read-only recovery publishes a known completed job without a new submission', async () => {
  const jobs = { 'old-job': { state: 'uncertain', requestMayHaveSucceeded: true } }
  const f = fixture({ jobs, refresh: async (_id, all) => { all['old-job'] = { state: 'done', file: 'recovered-file', mediaType: 'image/png' } } })
  const response = await f.actions.handle(request({ operation: 'recover' }))
  assert.equal(response.jobId, 'old-job')
  assert.equal(response.state, 'pending')
  await until(() => f.state.media[0].data.replacement?.state === 'ready')
  assert.equal(f.starts.length, 0)
  assert.equal(f.state.media[0].data.jobId, 'old-job')
  assert.notEqual(f.state.media[0].attachment.id, 'old-attachment')
})

test('explicit recovery queries a cancelled submitted task and publishes in the same slot without resubmission', async () => {
  const jobs = { 'old-job': { state: 'cancelled', requestStarted: true } }
  const f = fixture({ jobs, refresh: async (id, all, options) => {
    assert.equal(options.recoverCancelled, true)
    all[id] = { state: 'done', file: 'recovered-file', mediaType: 'image/png' }
  } })
  await f.actions.handle(request({ operation: 'recover' }))
  await until(() => f.state.media[0].data.replacement?.state === 'ready')
  assert.equal(f.starts.length, 0)
  assert.equal(f.state.media.length, 1)
})

test('cancelled recovery without a queryable task reports the limitation without submitting', async () => {
  const jobs = { 'old-job': { state: 'cancelled', requestStarted: true } }
  const f = fixture({ jobs, refresh: async () => { throw new Error('没有可查询的平台任务号') } })
  await assert.rejects(f.actions.handle(request({ operation: 'recover' })), /没有可查询的平台任务号/)
  assert.equal(f.starts.length, 0)
  assert.equal(jobs['old-job'].state, 'cancelled')
})

test('cancelled recovery with unfinished provider task retains billing risk and blocks redraw', async () => {
  const jobs = { 'old-job': { state: 'cancelled', requestStarted: true } }
  const f = fixture({ jobs, refresh: async () => {} })
  const result = await f.actions.handle(request({ operation: 'recover' }))
  assert.equal(result.state, 'cancelled')
  assert.equal(result.cancelMayHaveContinued, true)
  await assert.rejects(f.actions.handle(request()), /平台请求可能仍在处理/)
  assert.equal(f.starts.length, 0)
})

test('a cancelled replacement cannot bypass its billing risk through the original failed job', async () => {
  const jobs = { 'old-job': { state: 'failed' }, 'replacement': { state: 'cancelled', requestStarted: true } }
  const f = fixture({ jobs, media: [source({ data: { jobId: 'old-job', replacement: { jobId: 'replacement', state: 'cancelled' } } })] })
  await assert.rejects(f.actions.handle(request()), /平台请求可能仍在处理/)
  assert.equal(f.starts.length, 0)
})

test('simultaneous read-only recovery shares one query and publishes once', async () => {
  let queries = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const jobs = { 'old-job': { state: 'cancelled', requestStarted: true } }
  const f = fixture({ jobs, refresh: async (id, all) => {
    queries++
    await gate
    all[id] = { state: 'done', file: 'recovered-file', mediaType: 'image/png' }
  } })
  const first = f.actions.handle(request({ operation: 'recover' }))
  const second = f.actions.handle(request({ operation: 'recover' }))
  await until(() => queries === 1)
  release()
  assert.deepEqual(await first, await second)
  await until(() => f.state.media[0].data.replacement?.state === 'ready')
  assert.equal(queries, 1)
  assert.equal(f.starts.length, 0)
})

test('rejected cancellation preserves the old image and uncertain state against task cleanup race', async () => {
  const jobs = { 'job-1': { state: 'running', requestStarted: true } }
  const f = fixture({ jobs, start: () => ({ jobId: 'job-1' }), cancel: async () => { throw new Error('cancel endpoint failed') } })
  await f.actions.handle(request())
  await until(() => f.state.media[0].data.replacement?.state === 'pending')
  const result = await f.actions.handle(request({ operation: 'cancel', jobId: 'job-1' }))
  assert.equal(result.state, 'uncertain')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.state.media[0].data.replacement.state, 'uncertain')
  assert.equal(f.state.media[0].attachment.id, 'old-attachment')
  assert.equal(f.starts.length, 1)
})

test('delayed cancellation does not abort publishing until the selected job cancellation is confirmed', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const jobs = { 'job-1': { state: 'running', requestStarted: true } }
  const f = fixture({ jobs, start: () => ({ jobId: 'job-1' }), cancel: async id => { await gate; jobs[id] = { state: 'cancelled', requestStarted: true }; return { state: 'cancelled' } } })
  await f.actions.handle(request())
  await until(() => f.state.media[0].data.replacement?.state === 'pending')
  const cancelling = f.actions.handle(request({ operation: 'cancel', jobId: 'job-1' }))
  await new Promise(resolve => setTimeout(resolve, 4))
  assert.equal(f.state.media[0].data.replacement.state, 'pending')
  release()
  const result = await cancelling
  assert.equal(result.state, 'cancelled')
  assert.equal(f.state.media[0].data.replacement.cancelMayHaveContinued, true)
  assert.equal(f.state.media[0].attachment.id, 'old-attachment')
})
