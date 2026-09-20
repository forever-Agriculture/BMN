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
