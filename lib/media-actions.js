const IMAGE_KINDS = new Set(['dsh-tavern-image/image', 'dsh-tavern-comfy/image'])
const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000

function keyOf(input) {
  return JSON.stringify([String(input.gameId), Number(input.turn), String(input.textVersion), String(input.mediaId)])
}

function safeError(error) {
  return String(error?.message || error || '生图失败').slice(0, 500)
}

function pause(ms, signal) {
  return new Promise(resolve => {
    let timer
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted) finish()
  })
}

/**
 * Per-media redraw/retry actions. This service only mutates plugin-owned media
 * through Tavern's public API; the source image stays visible until replacement
 * bytes have been saved and update() succeeds.
 */
export function createMediaActions({
  tavern, attachments, getJob, refreshJob, startReplacement, cancelJob, readFileAsBytes,
  logger, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = 700,
} = {}) {
  const tasks = new Map()
  const recovering = new Map()
  const log = (message, error) => { try { logger?.warn?.('dsh-tavern-image[单图操作]: ' + message + (error ? '：' + safeError(error) : '')) } catch {} }
  // 最近若干条关键动作，供 /state 读。
  // 「作业明明出图了、正文却没换上」这类问题在前端完全看不出来 —— 前端只知道最后显示了什么，
  // 不知道宿主这边走到哪一步、为什么中止。把这条链记下来，下次一眼可查，不必再靠猜。
  const trail = []
  function note(stage, info) {
    try {
      trail.push(Object.assign({ at: Date.now(), stage }, info || {}))
      if (trail.length > 40) trail.splice(0, trail.length - 40)
    } catch { /* 记录失败不影响主流程 */ }
  }
  let disposed = false

  function assertAvailable() {
    if (disposed) throw new Error('插件已卸载')
    if (!tavern?.getTurn || !tavern?.list || !tavern?.update) throw new Error('当前 Tavern 缺少单图操作所需的公开媒体接口')
    if (typeof startReplacement !== 'function' || typeof getJob !== 'function' || typeof readFileAsBytes !== 'function' || typeof attachments?.saveImage !== 'function') {
      throw new Error('单图重绘服务尚未就绪')
    }
  }

  async function readJob(jobId) {
    try { return await getJob(jobId) } catch { return null }
  }

  async function locate(input) {
    const { gameId, turn, textVersion, mediaId } = input
    if (typeof gameId !== 'string' || !gameId || !Number.isSafeInteger(Number(turn)) || Number(turn) < 1
      || typeof textVersion !== 'string' || !textVersion || typeof mediaId !== 'string' || !mediaId) {
      throw new Error('缺少有效的 gameId、turn、textVersion 或 mediaId')
    }
    const snapshot = await tavern.getTurn({ gameId, turn: Number(turn) })
    if (!snapshot || snapshot.textVersion !== textVersion) throw Object.assign(new Error('正文版本已变化，不能操作旧图片'), { code: 'STALE_VERSION' })
    const items = await tavern.list({ gameId, turn: Number(turn) }) || []
    const item = items.find(value => value.id === mediaId)
    if (!item || !IMAGE_KINDS.has(item.kind) || Number(item.turn) !== Number(turn) || item.textVersion !== textVersion) {
      throw Object.assign(new Error('图片不存在、不属于本插件，或不属于当前正文版本'), { code: 'MEDIA_NOT_FOUND' })
    }
    return { snapshot, item }
  }

  async function assertLive(task) {
    task.controller.signal.throwIfAborted()
    if (disposed) throw new Error('插件已卸载')
    const { gameId, turn, textVersion } = task.input
    const snapshot = await tavern.getTurn({ gameId, turn: Number(turn) })
    task.controller.signal.throwIfAborted()
    if (!snapshot || snapshot.textVersion !== textVersion) {
      note('assert-abort', { why: 'turn-textVersion', want: String(textVersion || '').slice(0, 12), got: String(snapshot && snapshot.textVersion || '').slice(0, 12), jobId: String(task.jobId || '').slice(0, 8) })
      task.controller.abort(new Error('正文版本已变化，停止旧图发布'))
      task.controller.signal.throwIfAborted()
    }
    const items = await tavern.list({ gameId, turn: Number(turn) }) || []
    const current = items.find(value => value.id === task.input.mediaId)
    if (!current || !IMAGE_KINDS.has(current.kind) || current.textVersion !== textVersion) {
      note('assert-abort', { why: !current ? 'no-item' : !IMAGE_KINDS.has(current.kind) ? 'kind' : 'item-textVersion', want: String(textVersion || '').slice(0, 12), got: String(current && current.textVersion || '').slice(0, 12), jobId: String(task.jobId || '').slice(0, 8) })
      task.controller.abort(new Error('图片已删除或版本已变化，停止旧图发布'))
      task.controller.signal.throwIfAborted()
    }
    // 「已被更新的请求替代」的判定要收紧到「确实有另一个任务在跑」。
    // 原先只看 replacement.jobId 是否等于本次的作业号 —— 而用户切换查看的图片时，
    // 写回会把 replacement.jobId 改成他看到的那张（那只是「看哪张」，不是新的生成请求）。
    // 于是「进图片 → 切到别的图 → 点生图」这条最常见的路径上，结果永远发布不出去：
    // 作业其实出图了，媒体项却一直不更新，用户既看不到生成中、正文也不换图（用户反馈）。
    // trail 里留下的痕迹正是 publish-fail / reason=单图操作已被更新的请求替代。
    const repJobId = String(current.data?.replacement?.jobId || '')
    const repActive = ['pending', 'running', 'queued', 'processing'].includes(String(current.data?.replacement?.state || ''))
    if (repJobId && repJobId !== task.jobId && repActive) {
      note('assert-abort', { why: 'replaced-by-newer', want: String(task.jobId || '').slice(0, 8), got: repJobId.slice(0, 8), state: String(current.data?.replacement?.state || '') })
      task.controller.abort(new Error('单图操作已被更新的请求替代'))
      task.controller.signal.throwIfAborted()
    }
    return current
  }

  async function writeState(task, state, patch = {}) {
    const item = await assertLive(task)
    const data = { ...(item.data || {}), replacement: { ...(item.data?.replacement || {}), jobId: task.jobId, state, ...patch } }
    await tavern.update(item.id, { data, ...(patch.error ? { error: String(patch.error).slice(0, 500) } : {}) })
  }

  async function finishFailure(task, state, error) {
    const message = safeError(error)
    try {
      const item = await assertLive(task)
      const data = { ...(item.data || {}), replacement: { ...(item.data?.replacement || {}), jobId: task.jobId, state, error: message } }
      await tavern.update(item.id, { data, error: message, ...(item.attachment ? { status: 'ready' } : { status: 'failed' }) })
    } catch (updateError) {
      if (!task.controller.signal.aborted) log('无法写入单图任务结果', updateError)
    }
  }

  async function finishStopped(task) {
    if (task.cancelOutcomeUncertain) return
    const reason = safeError(task.controller.signal.reason || '任务已停止')
    try {
      const items = await tavern.list({ gameId: task.input.gameId, turn: Number(task.input.turn) }) || []
      if (task.cancelOutcomeUncertain) return
      const item = items.find(value => value.id === task.input.mediaId)
      if (!item || item.data?.replacement?.jobId !== task.jobId) return
      if (item.data?.replacement?.state === 'uncertain') return
      await tavern.update(item.id, {
        ...(item.attachment ? { status: 'ready' } : { status: 'failed' }),
        data: { ...(item.data || {}), replacement: { ...item.data.replacement, state: 'cancelled', error: reason } },
      })
    } catch (error) { log('无法记录已停止的单图任务', error) }
  }

  async function waitForJob(task) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await assertLive(task)
      let job
      try { job = await getJob(task.jobId) } catch (error) { throw Object.assign(new Error(safeError(error)), { uncertain: true }) }
      if (!job) throw Object.assign(new Error('查不到新作业状态；请先到生图平台确认，不能自动重发'), { uncertain: true })
      if (job.state === 'uncertain' || job.requestMayHaveSucceeded === true) {
        throw Object.assign(new Error(job.error || '作业提交结果未知；请先到生图平台确认，不能自动重发'), { uncertain: true })
      }
      if (TERMINAL.has(job.state)) return job
      if (!['pending', 'running', 'queued', 'processing'].includes(job.state)) {
        throw Object.assign(new Error('作业返回未知状态；请先到生图平台确认，不能自动重发'), { uncertain: true })
      }
      await pause(pollMs, task.controller.signal)
    }
    throw Object.assign(new Error('等待作业超时；请先到生图平台确认，不能自动重发'), { uncertain: true })
  }

  async function run(task) {
    try {
      await writeState(task, 'pending', { startedAt: Date.now(), error: '' })
      const job = await waitForJob(task)
      if (job.state !== 'done' || !job.file) {
        await finishFailure(task, job.state === 'cancelled' ? 'cancelled' : 'failed', job.error || '生图失败')
        return
      }
      const bytes = await readFileAsBytes(job.file)
      await assertLive(task)
      const mediaType = String(job.mediaType || 'image/png').split(';')[0].toLowerCase()
      const ext = ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/png': 'png' })[mediaType] || 'png'
      const attachment = await attachments.saveImage({ data: bytes, mediaType, name: 'tavern-comfy-' + task.jobId.slice(0, 8) + '.' + ext })
      const current = await assertLive(task)
      const data = {
        ...(current.data || {}), jobId: task.jobId,
        ...(job.channelId || task.input.channelId ? { channelId: job.channelId || task.input.channelId } : {}),
        replacement: { ...(current.data?.replacement || {}), jobId: task.jobId, state: 'ready', error: '', finishedAt: Date.now() },
      }
      await tavern.update(current.id, { status: 'ready', attachment, progress: 1, error: '', data })
      note('publish-ok', { jobId: String(task.jobId || '').slice(0, 8), mediaId: String(current.id || '').slice(0, 14), bytes: bytes.length })
    } catch (error) {
      note('publish-fail', { jobId: String(task.jobId || '').slice(0, 8), aborted: task.controller.signal.aborted ? 1 : 0, reason: safeError(task.controller.signal.reason), error: safeError(error) })
      if (!task.controller.signal.aborted) await finishFailure(task, error?.uncertain ? 'uncertain' : 'failed', error)
      else await finishStopped(task)
    } finally {
      if (tasks.get(task.key) === task) tasks.delete(task.key)
    }
  }

  async function start(input, item) {
    const data = item.data || {}
    const existing = data.replacement
    if (existing?.state === 'pending' || existing?.state === 'uncertain') {
      // 这里原先对 uncertain 是一刀切拒绝，结果是「取消一次就永久锁死这一处」——
      // 因为 cancel() 把 replacement 落成 uncertain（本地已停、平台可能仍在跑），
      // 用户之后每次点生图都只会收到「上一次请求结果未知」，再也生不出图（用户反馈）。
      // 改为：先查作业的真实状态，只有「确实可能已经发到平台」时才拒绝。
      if (existing.operation && (existing.operation !== input.operation || (existing.prompt || '') !== (input.prompt || '')
        || (existing.negative || '') !== (input.negative || '') || (existing.channelId || '') !== (input.channelId || ''))) {
        throw Object.assign(new Error('这张图片已有不同的重绘任务正在运行'), { code: 'ACTION_BUSY' })
      }
      const job = await readJob(existing.jobId)
      // 关键判据：标记说「还在跑」，但作业其实早就完成了 —— 这种情况绝不能复用。
      // 复用等于「前端提示已提交、后端什么都没做」，用户点了生图却没有新图
      //（本次反馈就是这个：复用了 9 分钟前那个已完成、已出图的作业 jobId）。
      // 标记停滞的成因很常见：任务放在内存里，宿主重启后没人回写终态。
      // 所以只要作业已经出图/已终结，就把陈旧标记顺手落成终态，然后走下面正常的新提交路径。
      const jobSettled = job && (job.state === 'done' || job.state === 'ready' || job.state === 'failed' || job.state === 'cancelled')
      // 「平台可能仍在跑」的痕迹：有它才需要保守拒绝（防重复扣费）。
      // 只是本地不确定、而作业其实早已终结且没有这些痕迹时，应当放行。
      const providerRisky = Boolean(job && (job.requestMayHaveSucceeded === true || job.cancelMayHaveContinued === true))
      if (jobSettled && !providerRisky) {
        note('start-settled', { stale: String(existing.jobId || '').slice(0, 8), jobState: String(job && job.state || '') })
        await tavern.update(item.id, { data: { ...data, replacement: { ...existing, state: 'ready', error: '' } } })
      } else {
        // 注意 !job 仍然算风险：查不到作业就无从判断是否已扣费，保持保守（有专门的测试守这条契约）。
        if (!job || job.state === 'uncertain' || job.requestMayHaveSucceeded === true) {
          await tavern.update(item.id, { data: { ...data, replacement: { ...existing, state: 'uncertain', error: '查不到作业状态；请先到生图平台确认，不能自动重发' } } })
          throw Object.assign(new Error('查不到作业状态；请先到生图平台确认，不能自动重发'), { code: 'UNCERTAIN' })
        }
        const key = keyOf(input)
        let task = tasks.get(key)
        if (!task) {
          task = { key, input, jobId: existing.jobId, controller: new AbortController() }
          tasks.set(key, task)
          task.promise = run(task)
        }
        return { ok: true, jobId: existing.jobId, mediaId: item.id, state: 'pending' }
      }
    }
    // 重绘/重试的「源作业」应当是用户当前看到的那一张 —— 前端把它放在 input.jobId 里
    //（正文里的插图渲染时带着 displayMediaContext，覆盖后 jobId 会跟着当前显示走）。
    // 而 data.jobId 是媒体项上记录的旧值，在用户切换过图片、或宿主重启后未必等于当前显示
    // 的那张。拿它当源就会出现「切到别的图再点生成 → 报错，或提示已提交却没真的生成」
    //（用户反馈的问题）。所以顺序反过来：前端给什么就用什么。
    const sourceJobId = String(input.jobId || data.jobId || '')
    if (!sourceJobId) throw new Error('找不到原始作业号，不能重绘或重试')
    const sourceJob = await readJob(sourceJobId)
    const latestJob = existing?.jobId && existing.jobId !== sourceJobId ? await readJob(existing.jobId) : sourceJob
    if ([sourceJob, latestJob].some(job => job?.state === 'cancelled' && (job.requestStarted === true || job.cancelMayHaveContinued === true))) {
      throw Object.assign(new Error('取消时平台请求可能仍在处理；请先查询原任务结果，暂不能重新提交'), { code: 'UNCERTAIN' })
    }
    if (sourceJob?.state === 'uncertain' || sourceJob?.requestMayHaveSucceeded === true) {
      throw Object.assign(new Error('原作业提交结果未知；请先确认生图平台，不能通过重绘绕过不确定状态'), { code: 'UNCERTAIN' })
    }
    if (input.operation === 'retry' && !['failed', 'cancelled'].includes(existing?.state) && item.status !== 'failed') {
      throw new Error('只有已确认失败或已取消的单图任务可以重试')
    }
    const localRejected = existing?.submissionNotStarted === true && !existing?.jobId
    if (input.operation === 'retry' && !localRejected) {
      if (data.cancelMayHaveContinued === true) {
        throw Object.assign(new Error('取消时请求可能已提交到生图平台；请先确认平台结果，不能安全地重试'), { code: 'UNCERTAIN' })
      }
      const retryJobId = existing?.jobId || sourceJobId
      try { await refreshJob?.(retryJobId) } catch (error) { log('刷新旧作业状态失败，继续按本地已知状态判断', error) }
      const retryJob = await readJob(retryJobId)
      if (!retryJob || retryJob.state === 'uncertain' || retryJob.requestMayHaveSucceeded === true
        || (retryJob.state === 'cancelled' && retryJob.requestStarted === true)
        || !['failed', 'cancelled'].includes(retryJob.state)) {
        throw Object.assign(new Error('找不到可确认失败的作业；为避免重复扣费，暂不能重试'), { code: 'UNCERTAIN' })
      }
    }
    if (input.operation === 'retry' && (input.jobId !== sourceJobId && input.jobId !== existing?.jobId)) {
      throw Object.assign(new Error('作业号与这张图片当前记录不匹配'), { code: 'JOB_MISMATCH' })
    }
    const key = keyOf(input)
    const dedupe = JSON.stringify([key, input.operation, sourceJobId, input.prompt || '', input.negative || '', input.channelId || ''])
    let task = tasks.get(key)
    if (task) {
      if (task.dedupe !== dedupe) throw Object.assign(new Error('这张图片已有不同的重绘任务正在运行'), { code: 'ACTION_BUSY' })
      if (task.startPromise) await task.startPromise
      return { ok: true, jobId: task.jobId, mediaId: item.id, state: 'pending' }
    }
    const controller = new AbortController()
    const taskInput = { ...input, turn: Number(input.turn) }
    const taskBase = { key, input: taskInput, sourceJobId, controller, dedupe, jobId: '', startPromise: null }
    tasks.set(key, taskBase)
    taskBase.startPromise = (async () => {
      // Start has a timeout boundary: a lost reply is not evidence that no request was paid.
      let startTimer
      let started
      try {
        started = await Promise.race([
          Promise.resolve().then(() => startReplacement({
            sourceJobId, prompt: input.prompt, negative: input.negative, channelId: input.channelId,
            sessionId: input.gameId, turn: Number(input.turn), textVersion: input.textVersion,
          })),
          new Promise((_resolve, reject) => { startTimer = setTimeout(() => reject(Object.assign(new Error('提交作业超时；请到生图平台确认，不能安全地自动重发'), { uncertain: true })), 60000) }),
        ])
      } catch (error) {
      if (error?.submissionNotStarted === true) {
          try { await tavern.update(item.id, { data: { ...data, replacement: { jobId: '', state: 'failed', submissionNotStarted: true, error: safeError(error), prompt: input.prompt || '', negative: input.negative || '', channelId: input.channelId || '' } } }) } catch {}
          error.code ||= 'REJECTED'
          throw error
        }
        const unknownId = 'unknown-' + Date.now().toString(36)
        taskBase.jobId = unknownId
        try { await tavern.update(item.id, { data: { ...data, replacement: { jobId: unknownId, state: 'uncertain', error: safeError(error), prompt: input.prompt || '', negative: input.negative || '', channelId: input.channelId || '' } } }) } catch {}
        throw Object.assign(new Error(safeError(error)), { code: 'UNCERTAIN' })
      } finally { clearTimeout(startTimer) }
      const jobId = String(started?.jobId || started?.id || '')
      if (!jobId) {
        const unknownId = 'unknown-' + Date.now().toString(36)
        taskBase.jobId = unknownId
        await tavern.update(item.id, { data: { ...data, replacement: { jobId: unknownId, state: 'uncertain', error: '提交结果未知；请到生图平台确认，不能自动重发' } } })
        throw Object.assign(new Error('提交结果未知；请到生图平台确认，不能自动重发'), { code: 'UNCERTAIN' })
      }
      const { item: latest } = await locate(taskInput)
      if (latest.id !== item.id || latest.data?.jobId !== data.jobId) {
        try { await cancelJob?.(jobId) } catch {}
        throw Object.assign(new Error('图片记录已变化，拒绝发布旧请求结果'), { code: 'STALE_MEDIA' })
      }
      taskBase.jobId = jobId
      await tavern.update(item.id, { data: { ...data, replacement: { jobId, state: 'pending', operation: input.operation, sourceJobId, prompt: input.prompt || '', negative: input.negative || '', channelId: input.channelId || '', startedAt: Date.now() } } })
      return jobId
    })()
    let jobId
    try { jobId = await taskBase.startPromise }
    catch (error) {
      if (tasks.get(key) === taskBase) tasks.delete(key)
      throw error
    }
    taskBase.startPromise = null
    taskBase.promise = run(taskBase)
    return { ok: true, jobId, mediaId: item.id, state: 'pending' }
  }

  async function recover(input, item) {
    const previous = item.data?.replacement
    const jobId = String(previous?.jobId || item.data?.jobId || '')
    if (!jobId || jobId.startsWith('unknown-')) throw Object.assign(new Error('没有可只读查询的作业号，请到生图平台手动检查'), { code: 'UNCERTAIN' })
    if (input.jobId && input.jobId !== jobId) throw Object.assign(new Error('作业号与这张图片当前记录不匹配'), { code: 'JOB_MISMATCH' })
    const key = keyOf(input)
    const existingTask = tasks.get(key)
    if (existingTask) return { ok: true, jobId, mediaId: item.id, state: 'pending' }
    let job = await readJob(jobId)
    if (!job) throw Object.assign(new Error('查不到此作业的本地状态；请到生图平台手动检查'), { code: 'UNCERTAIN' })
    if (['uncertain', 'pending', 'running', 'queued', 'processing'].includes(job.state) || (job.state === 'cancelled' && (job.requestStarted || job.cancelMayHaveContinued))) {
      try { await refreshJob?.(jobId, { recoverCancelled: true }) }
      catch (error) {
        log('只读刷新作业状态失败', error)
        if (job.state === 'cancelled') throw error
      }
      job = await readJob(jobId) || job
    }
    assertAvailable()
    const current = (await locate(input)).item
    if (String(current.data?.replacement?.jobId || current.data?.jobId || '') !== jobId) {
      throw Object.assign(new Error('查询期间图片任务已变化，请重新打开这张图'), { code: 'JOB_MISMATCH' })
    }
    item = current
    if (tasks.has(key)) return { ok: true, jobId, mediaId: item.id, state: 'pending' }
    if (['failed', 'cancelled'].includes(job.state)) {
      const message = String(job.error || (job.state === 'cancelled' ? '已取消' : '生图失败'))
      await tavern.update(item.id, {
        ...(item.attachment ? { status: 'ready' } : { status: 'failed', error: message }),
        data: { ...item.data, ...(job.state === 'failed' ? { cancelled: false, cancelMayHaveContinued: false } : {}), replacement: { ...(previous || {}), jobId, state: job.state === 'cancelled' ? 'cancelled' : 'failed', operation: 'recover', requestStarted: job.requestStarted === true, cancelMayHaveContinued: job.state === 'cancelled' && (job.requestStarted === true || job.cancelMayHaveContinued === true), error: message } },
      })
      return { ok: true, jobId, mediaId: item.id, state: job.state === 'cancelled' ? 'cancelled' : 'failed', requestStarted: job.requestStarted === true, cancelMayHaveContinued: job.state === 'cancelled' && (job.requestStarted === true || job.cancelMayHaveContinued === true) }
    }
    const task = { key, input, jobId, controller: new AbortController() }
    tasks.set(key, task)
    await tavern.update(item.id, {
      data: { ...item.data, replacement: { ...(previous || {}), jobId, operation: 'recover', state: 'pending', error: '' } },
    })
    task.promise = run(task)
    return { ok: true, jobId, mediaId: item.id, state: 'pending' }
  }

  async function cancel(input, item) {
    const replacement = item.data?.replacement
    const replacementPending = ['pending', 'running', 'uncertain'].includes(replacement?.state)
    const initialCandidate = !replacement && Boolean(item.data?.jobId)
    // 前端指定的作业号优先。它是「这一组里最新提交的那个」，比媒体项上记录的更准 ——
    // 媒体项那份可能停在旧作业上（登记停摆、或用户切换过显示），拿它比对就会把
    // 真正在跑的任务放过去：表现为「反复点取消都只回 pending、实际取消不掉」（用户反馈）。
    // input.jobId 仍做归属校验（见下面 readJob 之后那步），但不是用来早退的。
    const jobId = String(
      input.jobId
      || (replacementPending ? replacement?.jobId || '' : initialCandidate ? item.data?.jobId || '' : '')
    )
    if (!jobId) {
      return { ok: true, mediaId: item.id, jobId: null, state: replacement?.state || item.status }
    }
    let job = await readJob(jobId)
    if (!job) {
      if (replacementPending) await tavern.update(item.id, { data: { ...item.data, replacement: { ...replacement, state: 'uncertain', error: '查不到作业状态；请检查生图平台' } } })
      return { ok: true, mediaId: item.id, jobId, state: 'uncertain' }
    }
    if (job.state === 'done') return { ok: true, mediaId: item.id, jobId, state: 'done' }
    if (job.state === 'uncertain' || job.requestMayHaveSucceeded === true) {
      const message = job.error || '请求结果未知；请检查生图平台，不能确认已停止'
      if (replacementPending) await tavern.update(item.id, { data: { ...item.data, replacement: { ...replacement, state: 'uncertain', error: message } } })
      else await tavern.update(item.id, { error: message, data: { ...item.data, error: message } })
      return { ok: true, mediaId: item.id, jobId, state: 'uncertain' }
    }
    if (!['pending', 'running', 'queued', 'processing'].includes(job.state)) {
      return { ok: true, mediaId: item.id, jobId, state: job.state }
    }
    const key = keyOf(input)
    const task = tasks.get(key)
    await locate(input)
    const requestStarted = job.requestStarted === true
    let result
    try { result = await cancelJob?.(jobId) } catch (error) {
      const message = '取消结果未知：' + safeError(error) + '；请检查生图平台，不能确认已停止'
      if (task) {
        task.cancelOutcomeUncertain = true
        task.controller.abort(new Error(message))
      }
      if (replacementPending) await tavern.update(item.id, { data: { ...item.data, replacement: { ...replacement, state: 'uncertain', requestStarted, cancelMayHaveContinued: requestStarted, error: message } } })
      else await tavern.update(item.id, { error: message, data: { ...item.data, error: message, requestStarted, cancelMayHaveContinued: requestStarted } })
      return { ok: true, mediaId: item.id, jobId, state: 'uncertain' }
    }
    job = await readJob(jobId)
    if (job?.state === 'uncertain' || job?.requestMayHaveSucceeded === true) {
      const message = job.error || '取消结果未知；请检查生图平台'
      if (task) {
        task.cancelOutcomeUncertain = true
        task.controller.abort(new Error(message))
      }
      if (replacementPending) await tavern.update(item.id, { data: { ...item.data, replacement: { ...replacement, state: 'uncertain', requestStarted, cancelMayHaveContinued: requestStarted, error: message } } })
      else await tavern.update(item.id, { error: message, data: { ...item.data, error: message, requestStarted, cancelMayHaveContinued: requestStarted } })
      return { ok: true, mediaId: item.id, jobId, state: 'uncertain' }
    }
    const explicitlyCancelled = job?.state === 'cancelled' || result?.state === 'cancelled' || result?.cancelled === true
    const explicitlyFailed = job?.state === 'failed' || result?.state === 'failed'
    if (!explicitlyCancelled && !explicitlyFailed) {
      const message = '取消结果尚未确认；请检查生图平台'
      if (task) {
        task.cancelOutcomeUncertain = true
        task.controller.abort(new Error(message))
      }
      if (replacementPending) await tavern.update(item.id, { data: { ...item.data, replacement: { ...replacement, state: 'uncertain', requestStarted, cancelMayHaveContinued: requestStarted, error: message } } })
      else await tavern.update(item.id, { error: message, data: { ...item.data, error: message, requestStarted, cancelMayHaveContinued: requestStarted } })
      return { ok: true, mediaId: item.id, jobId, state: 'uncertain' }
    }
    const state = explicitlyCancelled ? 'cancelled' : 'failed'
    const mayContinue = requestStarted || job?.requestStarted === true
    task?.controller.abort(new Error(explicitlyCancelled ? '已取消' : '生图失败'))
    const message = explicitlyCancelled
      ? mayContinue ? '本地已停止等待；请求可能已提交到生图平台，平台仍可能继续生成并产生费用' : '已取消'
      : String(job?.error || result?.error || '生图失败')
    if (replacementPending) {
      await tavern.update(item.id, {
        ...(item.attachment ? { status: 'ready' } : { status: 'failed', error: message }),
        data: { ...item.data, replacement: { ...replacement, state, requestStarted: requestStarted || job?.requestStarted === true, cancelMayHaveContinued: explicitlyCancelled && mayContinue, error: message } },
      })
    } else {
      await tavern.update(item.id, {
        ...(item.attachment ? { status: 'ready' } : { status: 'failed', error: message }),
        data: { ...item.data, cancelled: explicitlyCancelled, cancelMayHaveContinued: explicitlyCancelled && mayContinue, error: message },
        ...(item.attachment ? { error: message } : {}),
      })
    }
    return { ok: true, mediaId: item.id, jobId, state, requestStarted: mayContinue, cancelMayHaveContinued: explicitlyCancelled && mayContinue }
  }

  async function handle(input = {}) {
    assertAvailable()
    if (!['redraw', 'retry', 'cancel', 'recover'].includes(input.operation)) throw new Error('operation 必须是 redraw、retry、cancel 或 recover')
    const normalized = { ...input, turn: Number(input.turn) }
    const { item } = await locate(normalized)
    // 校验「前端给的作业号确实属于这一处」。不能再用「等于 item.data.jobId」来判了：
    // 用户在查看器里切换过图片后，前端传的是覆盖后的当前显示那张 —— 它仍是这个媒体项的
    // 一个版本（同一 groupId），但与 data.jobId 不同，按旧写法会误报
    // 「作业号与所选图片不匹配」（用户反馈：切换图片后点生图就报这个）。
    // 真正要防的是「传来一个与本处无关的作业号」，所以按「同一组」来判。
    // 老作业没有 groupId，退回用 mount（正文里被挂载的那句话）当同一处的标识。
    const wantJob = String(input.jobId || '')
    if (wantJob && wantJob !== item.data?.jobId && wantJob !== item.data?.replacement?.jobId) {
      const groupOf = async id => {
        if (!id) return ''
        try {
          const job = await readJob(String(id))
          if (!job) return ''
          return String(job.groupId || '') || 'mount:' + String(job.mount || '')
        } catch { return '' }
      }
      const wantGroup = await groupOf(wantJob)
      const selfGroup = await groupOf(item.data?.jobId || item.data?.replacement?.jobId)
      if (!wantGroup || wantGroup !== selfGroup) {
        throw Object.assign(new Error('作业号与所选图片不匹配'), { code: 'JOB_MISMATCH' })
      }
    }
    if (input.operation === 'cancel') return cancel(normalized, item)
    if (input.operation === 'recover') {
      const key = keyOf(normalized)
      if (recovering.has(key)) return recovering.get(key)
      const recovery = recover(normalized, item)
      recovering.set(key, recovery)
      try { return await recovery }
      finally { if (recovering.get(key) === recovery) recovering.delete(key) }
    }
    return start(normalized, item)
  }

  function invalidate(predicate, reason) {
    for (const task of tasks.values()) if (predicate(task)) {
      task.controller.abort(new Error(reason))
      try { Promise.resolve(cancelJob?.(task.jobId)).catch(() => {}) } catch {}
    }
  }

  return {
    trail: () => trail.slice(),
    handle,
    gameRemoved({ gameId } = {}) { invalidate(task => task.input.gameId === gameId, '这一局已删除') },
    timelineChanged({ gameId, turn } = {}) { invalidate(task => task.input.gameId === gameId && (!turn || Number(task.input.turn) >= Number(turn)), '剧情线已变化') },
    dispose() {
      disposed = true
      invalidate(() => true, '插件已卸载')
      tasks.clear()
    },
  }
}
