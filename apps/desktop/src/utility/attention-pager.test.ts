// MODULE: attention-pager.test.ts - one page per request revision, only when still open and unseen after the wait
import type { AttentionRecord } from '@ai-terminal/protocol'
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
    ...change
  }
}

function pagerFixture(): {
  pager: ReturnType<typeof createAttentionPager>
  stored: Map<string, AttentionRecord>
  sent: AttentionRecord[]
  waits: number[]
  elapse(): Promise<void>
} {
  const stored = new Map<string, AttentionRecord>()
  const sent: AttentionRecord[] = []
  const waits: number[] = []
  let due: Array<() => void> = []
  const pager = createAttentionPager({
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
  const elapse = async (): Promise<void> => {
    const ready = due
    due = []
    for (const callback of ready) callback()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { pager, stored, sent, waits, elapse }
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

  it('cancels waiting requests when it closes', async () => {
    const { pager, stored, sent, elapse } = pagerFixture()
    const opened = record()
    stored.set(opened.requestId, opened)
    pager.opened(opened)

    pager.close()
    await elapse()
    pager.opened(record({ requestId: 'later' }))
    await elapse()

    expect(sent).toEqual([])
  })
})
