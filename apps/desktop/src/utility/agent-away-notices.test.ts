// MODULE: agent-away-notices.test.ts - which conversation is handed which away state, across starts, tool calls and restarts (Story 76.4)
import { AWAY_AGENT_TEXT, AWAY_BACK_AGENT_TEXT, type AwayRecord } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { AwayNotices, type AwayTold } from './agent-away-notices'
import type { AgentBriefEvent } from './agent-briefs'

const NOW = new Date(2026, 9, 17, 1, 0)
const SINCE = new Date(2026, 9, 16, 22, 10).toISOString()
const ENDED = new Date(2026, 9, 17, 0, 40).toISOString()
type State = Pick<AwayRecord, 'state' | 'revision' | 'since' | 'endedAt'>
const away = (revision = 1): State => ({ state: 'away', revision, since: SINCE, endedAt: null })
const back = (revision = 2): State => ({ state: 'back', revision, since: SINCE, endedAt: ENDED })
const none: State = { state: 'none', revision: 0, since: null, endedAt: null }

function notices(live: Record<string, string> = { s1: 'i1' }) {
  const saved: Array<Array<[string, AwayTold]>> = []
  const tracker = new AwayNotices({ liveIncarnationId: (sessionId) => live[sessionId], now: () => NOW, save: async (entries) => { saved.push(entries) } })
  return { tracker, saved }
}
const start = (source: string, over: Partial<AgentBriefEvent> = {}): AgentBriefEvent =>
  ({ sessionId: 's1', incarnationId: 'i1', agent: 'claude', event: 'SessionStart', source, turn: { conversation: 'c1', nested: false }, ...over })
const tool = (over: Partial<AgentBriefEvent> = {}): AgentBriefEvent =>
  ({ sessionId: 's1', incarnationId: 'i1', agent: 'claude', event: 'PostToolUse', source: null, turn: { conversation: 'c1', nested: false }, ...over })

describe('AwayNotices (Story 76.4 AC1-AC2)', () => {
  it('tells a new conversation the state only while he is away, with its stamp and the whole text', () => {
    const { tracker } = notices()
    expect(tracker.answer(start('startup'), back())).toBeNull()
    expect(tracker.answer(start('startup'), none)).toBeNull()
    const told = tracker.answer(start('startup', { turn: { conversation: 'c2', nested: false } }), away(3))
    expect(told).toEqual({ revision: 3, text: `[BMN state: the owner is away since Fri 22:10 (revision 3). Context from BMN, not a new task.]\n${AWAY_AGENT_TEXT}` })
  })

  it('hands a working agent the change once, at its next tool call, and back after away', () => {
    const { tracker } = notices()
    expect(tracker.answer(tool(), none)).toBeNull()
    expect(tracker.answer(tool(), away())?.revision).toBe(1)
    expect(tracker.answer(tool(), away())).toBeNull()
    const backNotice = tracker.answer(tool(), back())
    expect(backNotice?.text).toBe(`[BMN state: the owner is back since 00:40 (revision 2). Context from BMN, not a new task.]\n${AWAY_BACK_AGENT_TEXT}`)
    expect(tracker.answer(tool(), back())).toBeNull()
    expect(tracker.answer(tool(), away(3))?.revision).toBe(3)
  })

  it('hands one of two overlapping hooks of one conversation the change: the claim is taken before the answer returns', async () => {
    const { tracker } = notices()
    const [first, second] = await Promise.all([Promise.resolve().then(() => tracker.answer(tool(), away())), Promise.resolve().then(() => tracker.answer(tool(), away()))])
    expect([first?.revision ?? null, second?.revision ?? null].toSorted()).toEqual([1, null])
  })

  it('keeps handing when the record cannot be saved, and saves everything again with the next change', async () => {
    const saved: Array<Array<[string, AwayTold]>> = []
    let fail = true
    const tracker = new AwayNotices({ liveIncarnationId: () => 'i1', now: () => NOW,
      save: async (entries) => { if (fail) throw new Error('disk full'); saved.push(entries) } })
    expect(tracker.answer(tool(), away())?.revision).toBe(1)
    await Promise.resolve()
    expect(saved).toEqual([])
    fail = false
    expect(tracker.answer(tool({ turn: { conversation: 'c2', nested: false } }), away())?.revision).toBe(1)
    await Promise.resolve()
    expect(saved.at(-1)?.map(([key]) => key.split(String.fromCharCode(0))[2])).toEqual(['c1', 'c2'])
  })

  it('never hands an away that is already over when it was never handed (they coalesce only then)', () => {
    const { tracker } = notices()
    expect(tracker.answer(tool(), back())).toBeNull()
    expect(tracker.toldTo('s1', 'claude', 'c1')).toBeUndefined()
  })

  it('hands back to a conversation whose away was handed but not reported printed', () => {
    const { tracker } = notices()
    tracker.answer(tool(), away())
    expect(tracker.toldTo('s1', 'claude', 'c1')?.status).toBe('claimed')
    expect(tracker.answer(tool(), back())?.revision).toBe(2)
  })

  it('never hands a revision older than the one handed', () => {
    const { tracker } = notices()
    tracker.answer(tool(), away(5))
    expect(tracker.answer(tool(), back(4))).toBeNull()
    expect(tracker.answer(start('compact'), away(4))).toBeNull()
  })

  it('tells a resumed or forked conversation only what changed, and a compacted or cleared one again', () => {
    const { tracker } = notices()
    tracker.answer(start('startup'), away())
    expect(tracker.answer(start('resume'), away())).toBeNull()
    expect(tracker.answer(start('compact'), away())?.revision).toBe(1)
    expect(tracker.answer(start('clear'), away())?.revision).toBe(1)
    expect(tracker.answer(start('resume'), back())?.revision).toBe(2)
    expect(tracker.answer(start('compact'), back())?.revision).toBe(2)
    expect(tracker.answer(start('fork', { turn: { conversation: 'c9', nested: false } }), back())).toBeNull()
    expect(tracker.answer(start('fork', { turn: { conversation: 'c9', nested: false } }), away(3))?.revision).toBe(3)
  })

  it('tells back to a conversation resumed after a BMN restart, from what was kept', async () => {
    const first = notices()
    first.tracker.answer(tool(), away())
    const kept = first.saved.at(-1)!
    const restarted = notices({ s1: 'i2' })
    restarted.tracker.load(kept)
    expect(restarted.tracker.answer(start('resume', { incarnationId: 'i2' }), back())?.revision).toBe(2)
    const fresh = notices({ s1: 'i2' })
    expect(fresh.tracker.answer(start('resume', { incarnationId: 'i2' }), back())).toBeNull()
  })

  it('hands nothing to a sub-agent, a process no longer live, an app it was not measured in or an event without a conversation', () => {
    const { tracker } = notices()
    expect(tracker.answer(tool({ turn: { conversation: 'c1', nested: true } }), away())).toBeNull()
    expect(tracker.answer(tool({ incarnationId: 'old' }), away())).toBeNull()
    expect(tracker.answer(tool({ incarnationId: null }), away())).toBeNull()
    expect(tracker.answer(tool({ agent: 'opencode' }), away())).toBeNull()
    expect(tracker.answer(tool({ turn: undefined }), away())).toBeNull()
    expect(tracker.answer(tool({ event: 'PreToolUse' }), away())).toBeNull()
    expect(tracker.answer(tool({ agent: 'codex' }), away())?.revision).toBe(1)
  })

  it('records printed for the revision handed only, and never as read', () => {
    const { tracker } = notices()
    tracker.answer(tool(), away())
    expect(tracker.printed('s1', 'claude', 'c1', 2)).toBe(false)
    expect(tracker.printed('s1', 'claude', 'c1', 1)).toBe(true)
    expect(tracker.printed('s1', 'claude', 'c1', 1)).toBe(false)
    expect(tracker.toldTo('s1', 'claude', 'c1')).toEqual({ revision: 1, state: 'away', status: 'printed', incarnationId: 'i1' })
  })
})
