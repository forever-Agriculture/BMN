// MODULE: attention-pager.test.ts - one page per request revision, only when still open and unseen after the wait, and only while the owner is away
import type { AttentionRecord } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { createAttentionPager } from './attention-pager'

function record(change: Partial<AttentionRecord> = {}): AttentionRecord {
  return {
    requestId: 'request-1',
    sessionId: 'session-1',
    incarnationId: null,
    requestKey: 'claude:permission',
    kind: 'permission',
    title: 'Claude needs your permission to use Bash',
    body: null,
    state: 'open',
    resolution: null,
    openedAt: '2026-09-15T00:00:00.000Z',
    expiresAt: null,
    resolvedAt: null,
    seenAt: null,
    revision: 1,
    openedBy: null,
    resolvedBy: null,
    prompt: null,
    ...change
  }
}

function pagerFixture(): {
  pager: ReturnType<typeof createAttentionPager>
  stored: Map<string, AttentionRecord>
  sent: AttentionRecord[]
  waits: number[]
  presence: { away: boolean | null; now: number }
  elapse(): Promise<void>
  settle(): Promise<void>
} {
  const stored = new Map<string, AttentionRecord>()
  const sent: AttentionRecord[] = []
  const waits: number[] = []
  const presence: { away: boolean | null; now: number } = { away: true, now: 0 }
  let due: Array<() => void> = []
  const pager = createAttentionPager({
    ownerAway: () => presence.away,
    now: () => presence.now,
    current: async (requestId) => stored.get(requestId) ?? null,
    send: async (value) => {
      sent.push(value)
    },
    schedule: (callback, ms) => {
      waits.push(ms)
      due.push(callback)
      return () => {
        due = due.filter((candidate) => candidate !== callback)
      }
    }
  })
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  const elapse = async (): Promise<void> => {
    const ready = due
    due = []
    for (const callback of ready) callback()
    await settle()
  }
  return { pager, stored, sent, waits, presence, elapse, settle }
}

describe('attention pager', () => {
  it('sends a request once however often the agent repeats it, after the wait for its kind', async () => {
    const { pager, stored, sent, waits, elapse } = pagerFixture()
    const opened = record()
    stored.set(opened.requestId, opened)

    pager.opened(opened)
    pager.opened(opened)
    await elapse()
    pager.opened(opened)
    await elapse()
    pager.opened(record({ requestId: 'turn', kind: 'notice' }))

    expect(sent).toEqual([opened])
    expect(waits).toEqual([15_000, 60_000])
  })

  it('sends nothing for a request seen, answered or changed while it waited, and sends the changed one', async () => {
    const { pager, stored, sent, elapse } = pagerFixture()
    const seen = record({ requestId: 'seen' })
    const answered = record({ requestId: 'answered' })
    const changed = record({ requestId: 'changed' })
    const revised = record({ requestId: 'changed', title: 'Claude needs your permission to use Edit', revision: 2 })
    for (const value of [seen, answered, changed]) pager.opened(value)
    stored.set('seen', { ...seen, seenAt: '2026-09-15T00:00:05.000Z' })
    stored.set('answered', { ...answered, state: 'answered', revision: 2 })
    stored.set('changed', revised)
    pager.opened(revised)

    await elapse()

    expect(sent).toEqual([revised])
  })

  it('holds a request that falls due at the desk and sends it only if the owner leaves soon after it opened', async () => {
    const { pager, stored, sent, presence, elapse, settle } = pagerFixture()
    const early = record({ requestId: 'early' })
    const late = record({ requestId: 'late' })
    const answered = record({ requestId: 'answered' })
    for (const value of [early, late, answered]) stored.set(value.requestId, value)
    presence.away = false

    pager.opened(early)
    presence.now = 5 * 60_000
    pager.opened(late)
    pager.opened(answered)
    await elapse()
    expect(sent).toEqual([])

    stored.set('answered', { ...answered, state: 'answered', revision: 2 })
    presence.now = 12 * 60_000
    presence.away = true
    pager.ownerLeft()
    await settle()
    pager.ownerLeft()
    await settle()

    // early opened 12 minutes ago, past the 10 minute window; late opened 7 minutes ago.
    expect(sent).toEqual([late])
  })

  it('sends as before when presence cannot be read, and never for a request answered at the desk', async () => {
    const { pager, stored, sent, presence, elapse, settle } = pagerFixture()
    const unknown = record({ requestId: 'unknown' })
    const atDesk = record({ requestId: 'at-desk' })
    for (const value of [unknown, atDesk]) stored.set(value.requestId, value)

    presence.away = null
    pager.opened(unknown)
    await elapse()
    presence.away = false
    pager.opened(atDesk)
    await elapse()
    stored.set('at-desk', { ...atDesk, seenAt: '2026-09-15T00:00:20.000Z' })
    presence.away = true
    pager.ownerLeft()
    await settle()

    expect(sent).toEqual([unknown])
  })

  it('cancels waiting requests when it closes', async () => {
    const { pager, stored, sent, presence, elapse } = pagerFixture()
    const opened = record()
    stored.set(opened.requestId, opened)
    pager.opened(opened)
    presence.away = false
    pager.opened(record({ requestId: 'held' }))
    await elapse()

    pager.close()
    pager.ownerLeft()
    await elapse()
    pager.opened(record({ requestId: 'later' }))
    await elapse()

    expect(sent).toEqual([])
  })
})

function retryFixture() {
  const stored = new Map<string, AttentionRecord>()
  const sent: AttentionRecord[] = []
  const state = { away: true, now: 0, available: false, ambiguous: false, hold: null as Promise<void> | null, attempts: 0 }
  let due: Array<() => void> = []
  const pager = createAttentionPager({
    current: async id => stored.get(id) ?? null,
    ownerAway: () => state.away,
    now: () => state.now,
    send: async value => {
      const available = state.available
      state.attempts += 1
      if (state.hold) await state.hold
      if (!available) return false
      if (state.ambiguous) throw new Error('Response lost after a possible send')
      sent.push(value)
      return true
    },
    schedule: callback => {
      due.push(callback)
      return () => { due = due.filter(value => value !== callback) }
    }
  })
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
  const elapse = async (): Promise<void> => {
    const ready = due; due = []
    for (const callback of ready) callback()
    await settle()
  }
  return { pager, stored, sent, state, settle, elapse }
}

describe('definitely unsent attention', () => {
  it('sends once after recovery despite repeated recovery, departure and open events', async () => {
    const h = retryFixture(), opened = record()
    h.stored.set(opened.requestId, opened); h.pager.opened(opened)
    await h.elapse(); expect(h.sent).toEqual([])
    h.state.available = true
    h.pager.retryUnsent(); h.pager.retryUnsent(); h.pager.ownerLeft(); h.pager.opened(opened)
    await h.settle(); await h.elapse()
    expect(h.sent).toEqual([opened]); expect(h.state.attempts).toBe(2)
    h.pager.retryUnsent(); await h.settle(); expect(h.sent).toEqual([opened])
  })

  it('never retries an ambiguous send', async () => {
    const h = retryFixture(), opened = record()
    h.state.available = true; h.state.ambiguous = true
    h.stored.set(opened.requestId, opened); h.pager.opened(opened); await h.elapse()
    h.state.ambiguous = false; h.pager.retryUnsent(); h.pager.ownerLeft(); h.pager.opened(opened)
    await h.elapse(); expect(h.state.attempts).toBe(1); expect(h.sent).toEqual([])
  })

  it.each(['seen', 'closed', 'revised', 'shutdown'] as const)('suppresses retained work after %s', async change => {
    const h = retryFixture(), opened = record()
    h.stored.set(opened.requestId, opened); h.pager.opened(opened); await h.elapse()
    if (change === 'seen') h.stored.set(opened.requestId, { ...opened, seenAt: '2026-09-15T00:01:00Z' })
    if (change === 'closed') h.stored.set(opened.requestId, { ...opened, state: 'answered' })
    if (change === 'revised') h.stored.set(opened.requestId, { ...opened, revision: 2 })
    if (change === 'shutdown') h.pager.close()
    h.state.available = true; h.pager.retryUnsent(); await h.settle()
    expect(h.sent).toEqual([]); expect(h.state.attempts).toBe(1)
  })

  it('waits for another departure and keeps prior away eligibility through a long outage', async () => {
    const h = retryFixture(), opened = record()
    h.stored.set(opened.requestId, opened); h.pager.opened(opened); await h.elapse()
    h.state.available = true; h.state.away = false; h.state.now = 20 * 60_000
    h.pager.retryUnsent(); await h.settle(); expect(h.sent).toEqual([])
    h.state.away = true; h.pager.ownerLeft(); await h.settle()
    expect(h.sent).toEqual([opened])
  })

  it('does not strand an unsent result when recovery arrives while the attempt settles', async () => {
    const h = retryFixture(), opened = record()
    let release!: () => void
    h.state.hold = new Promise<void>(resolve => { release = resolve })
    h.stored.set(opened.requestId, opened); h.pager.opened(opened); await h.elapse()
    h.state.available = true; h.pager.retryUnsent(); h.state.hold = null; release()
    await h.settle(); expect(h.sent).toEqual([opened]); expect(h.state.attempts).toBe(2)
  })
})
