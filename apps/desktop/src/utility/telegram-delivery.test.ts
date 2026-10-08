import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttentionRecord } from '@bmn/protocol'
import { createAttentionPager } from './attention-pager'
import { TelegramCardKeeper } from './telegram-card-keeper'
import { TelegramConnectorError, type CardMessageOptions } from './telegram-connector'

function fixture() {
  const record: AttentionRecord = {
    requestId: 'synthetic-notice', sessionId: 'synthetic-session', incarnationId: 'synthetic-incarnation',
    requestKey: 'codex:turn', kind: 'notice', title: 'PRIVATE-TITLE', body: 'PRIVATE-BODY',
    state: 'open', resolution: null, openedAt: '2026-10-02T17:58:30.696Z', expiresAt: null,
    resolvedAt: null, seenAt: null, revision: 1, openedBy: 'hook:codex:Stop', resolvedBy: null, prompt: null
  }
  const state = { record, away: true, connected: true, failSend: false, failObserver: false,
    failStore: false, refuseHtml: false, failFallback: false }
  const events: unknown[] = [], stored: unknown[] = []
  const observeDelivery = (event: unknown): void => {
    if (state.failObserver) throw new Error('Diagnostic storage unavailable')
    events.push(event)
  }
  const sendMessage = vi.fn(async (_text: string, options: CardMessageOptions = {}) => {
    if (state.failSend) throw new TelegramConnectorError('network', 'PRIVATE-ERROR-TOKEN')
    if (state.refuseHtml && options.html) throw new TelegramConnectorError('http', "can't parse entities", 400)
    if (state.failFallback && !options.html) throw new TelegramConnectorError('network', 'PRIVATE-FALLBACK-ERROR')
    return { messageId: 1 }
  })
  const connector = { sendMessage, editMessageText: async () => {}, answerCallbackQuery: async () => {} }
  const keeper = new TelegramCardKeeper({
    connector: () => state.connected ? connector : undefined,
    getAttention: async () => state.record,
    header: () => ({ session: 'PRIVATE-SESSION-NAME', agent: 'codex', flag: null }),
    answerability: async () => ({ answerable: true, deny: false }), answerEpoch: () => null,
    liveIncarnationId: () => record.incarnationId!, answer: async () => ({ state: 'confirmed', sent: [] }),
    store: { put: async row => {
      if (state.failStore) throw new Error('PRIVATE-STORE-ERROR')
      stored.push(row)
    }, update: async () => {}, list: async () => [], message: async () => {} },
    home: null, observeDelivery
  })
  const pager = createAttentionPager({
    current: async () => state.record, send: row => keeper.page(row), ownerAway: () => state.away,
    now: () => Date.now(), schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    }, observeDelivery
  })
  return { state, pager, keeper, sendMessage, stored, events, close: () => { pager.close(); keeper.dispose() } }
}

afterEach(() => vi.useRealTimers())

describe('Telegram delivery diagnosis without message contents', () => {
  it('records elapsed time when the timer runs late', async () => {
    vi.useFakeTimers(); const h = fixture()
    try {
      h.pager.opened(h.state.record)
      vi.setSystemTime(Date.now() + 20_000)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(h.events).toContainEqual(expect.objectContaining({ phase: 'timer-fired', elapsedMs: 80_000 }))
      expect(h.sendMessage).toHaveBeenCalledTimes(1)
    } finally { h.close() }
  })

  it('records a mapping failure after confirmed delivery without resending', async () => {
    vi.useFakeTimers(); const h = fixture()
    try {
      h.state.failStore = true; h.pager.opened(h.state.record); await vi.advanceTimersByTimeAsync(60_000)
      await h.keeper.page(h.state.record)
      expect(h.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: 'send-confirmed' }), expect.objectContaining({ phase: 'mapping-write-failed' })
      ]))
      expect(h.sendMessage).toHaveBeenCalledTimes(1)
      expect(h.stored).toHaveLength(0)
      expect(JSON.stringify(h.events)).not.toContain('PRIVATE-')
    } finally { h.close() }
  })

  it.each([false, true])('records the format fallback outcome (failure=%s)', async failFallback => {
    vi.useFakeTimers(); const h = fixture()
    try {
      h.state.refuseHtml = true; h.state.failFallback = failFallback
      h.pager.opened(h.state.record); await vi.advanceTimersByTimeAsync(60_000)
      expect(h.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: 'format-fallback' }),
        expect.objectContaining({ phase: failFallback ? 'fallback-failed' : 'send-confirmed' })
      ]))
      h.pager.retryUnsent(); await vi.advanceTimersByTimeAsync(0)
      expect(h.sendMessage).toHaveBeenCalledTimes(2)
      expect(h.stored).toHaveLength(failFallback ? 0 : 1)
      expect(JSON.stringify(h.events)).not.toContain('PRIVATE-')
    } finally { h.close() }
  })

  it('distinguishes a due notice and a confirmed send from an absent receipt', async () => {
    vi.useFakeTimers(); const h = fixture()
    try {
      h.pager.opened(h.state.record)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(h.stored).toHaveLength(1)
      expect(h.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: 'scheduled', requestId: 'synthetic-notice', revision: 1, delayMs: 60_000 }),
        expect.objectContaining({ phase: 'timer-fired', away: true, elapsedMs: 60_000 }),
        expect.objectContaining({ phase: 'send-started' }), expect.objectContaining({ phase: 'send-confirmed' })
      ]))
      expect(JSON.stringify(h.events)).not.toContain('PRIVATE-')
    } finally { h.close() }
  })

  it('distinguishes desktop activity followed by seeing the notice', async () => {
    vi.useFakeTimers(); const h = fixture()
    try {
      h.pager.opened(h.state.record); h.state.away = false
      await vi.advanceTimersByTimeAsync(60_000)
      h.state.record = { ...h.state.record, seenAt: '2026-10-02T17:59:39.036Z' }
      h.state.away = true; h.pager.ownerLeft(); await vi.advanceTimersByTimeAsync(0)
      expect(h.sendMessage).not.toHaveBeenCalled()
      expect(h.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: 'held-at-desk', away: false }), expect.objectContaining({ phase: 'request-seen' })
      ]))
    } finally { h.close() }
  })

  it('distinguishes an unavailable connector from a send attempt without changing recovery', async () => {
    vi.useFakeTimers(); const h = fixture()
    try {
      h.state.connected = false; h.pager.opened(h.state.record); await vi.advanceTimersByTimeAsync(60_000)
      expect(h.sendMessage).not.toHaveBeenCalled()
      expect(h.events).toContainEqual(expect.objectContaining({ phase: 'connector-unavailable' }))
      h.state.connected = true; h.pager.retryUnsent(); await vi.advanceTimersByTimeAsync(0)
      expect(h.sendMessage).toHaveBeenCalledTimes(1)
      expect(h.stored).toHaveLength(1)
    } finally { h.close() }
  })

  it('records an uncertain send without retaining its error or retrying', async () => {
    vi.useFakeTimers(); const h = fixture()
    try {
      h.state.failSend = true; h.pager.opened(h.state.record); await vi.advanceTimersByTimeAsync(60_000)
      h.state.failSend = false; h.pager.retryUnsent(); h.pager.ownerLeft(); await vi.advanceTimersByTimeAsync(300_000)
      expect(h.sendMessage).toHaveBeenCalledTimes(1)
      expect(h.stored).toHaveLength(0)
      expect(h.events).toContainEqual(expect.objectContaining({ phase: 'send-uncertain' }))
      expect(JSON.stringify(h.events)).not.toContain('PRIVATE-')
    } finally { h.close() }
  })

  it('keeps delivery independent of a failing diagnostic observer', async () => {
    vi.useFakeTimers(); const h = fixture()
    try {
      h.state.failObserver = true; h.pager.opened(h.state.record); await vi.advanceTimersByTimeAsync(60_000)
      expect(h.sendMessage).toHaveBeenCalledTimes(1)
      expect(h.stored).toHaveLength(1)
    } finally { h.close() }
  })
})
