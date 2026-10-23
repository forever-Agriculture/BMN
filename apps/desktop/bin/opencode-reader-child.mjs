// MODULE: opencode-reader-child.mjs - Explicit bounded child lifetime for the pinned one-argument OpenCode SDK

/** A failed interrupt terminates only the BMN standalone helper process that loaded this private plugin. */
export async function runReaderChild(ctx, context, value, admit, { timeoutMs = 60000, cleanupMs = 1000,
  accounting, fatal = () => process.kill(process.pid, 'SIGTERM') } = {}) {
  let ledger = null, child = null, expired = false, stopped = null, rejectAbort
  const aborted = new Promise((_, reject) => { rejectAbort = reject })
  const stop = () => {
    if (!child) return Promise.resolve()
    if (stopped) return stopped
    stopped = (async () => {
      let timer
      try {
        await Promise.race([ctx.session.interrupt({ sessionID: child.id }), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('BMN child interruption timed out')), cleanupMs)
        })])
        ledger?.terminated()
      } catch { fatal(); throw new Error('BMN child interruption could not be confirmed') }
      finally { clearTimeout(timer) }
    })()
    return stopped
  }
  const abort = () => {
    if (expired) return
    expired = true
    rejectAbort(new Error('BMN reader child was cancelled or exceeded its time limit'))
    void stop().catch(() => undefined)
  }
  const check = () => { if (expired || context.signal?.aborted) throw new Error('BMN reader child was cancelled or exceeded its time limit') }
  const timer = setTimeout(abort, timeoutMs)
  context.signal?.addEventListener('abort', abort, { once: true })
  try {
    const work = (async () => {
      check()
      const parent = await ctx.session.get({ sessionID: context.sessionID })
      check(); admit(context.sessionID, parent.parentID !== undefined && parent.parentID !== null)
      if (!accounting) throw new Error('BMN child accounting is unavailable')
      ledger = accounting.begin(parent.id, context.id)
      child = await ctx.session.create({ parentID: parent.id, title: (value.description ?? 'BMN read-only child').slice(0, 200), agent: 'bmn-reader', model: parent.model })
      try {
        ledger.identify(child.id)
        if (expired) {
          void context.progress({ sessionID: child.id, status: 'cancelled' }).catch(() => undefined)
          await stop(); check()
        }
        // Record identity before prompting, so failed, cancelled and late-created children remain attributable.
        await context.progress({ sessionID: child.id, status: 'running' })
        check()
        await ctx.session.prompt({ sessionID: child.id, text: value.prompt })
        check(); await ctx.session.wait({ sessionID: child.id })
        check(); const messages = await ctx.session.context({ sessionID: child.id })
        check(); const answer = messages.filter(message => message.type === 'assistant' && !message.error).at(-1)
        const text = answer?.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        if (!text) throw new Error('BMN reader child returned no answer')
        return { content: text, metadata: { sessionID: child.id } }
      } finally { if (expired) await stop() }
    })()
    return await Promise.race([work, aborted])
  } finally {
    clearTimeout(timer); context.signal?.removeEventListener('abort', abort)
    await stop()
  }
}
