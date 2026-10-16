// MODULE: agent-away-notices.test.ts - which conversation is handed which away state, across starts, tool calls and restarts (Story 76.4)
import { AWAY_AGENT_TEXT, AWAY_BACK_AGENT_TEXT, type AwayRecord } from '@bmn/protocol'
import { describe, expect, it, vi } from 'vitest'
import { AWAY_NOTICES_REMEMBERED, AwayNotices, type AwayNoticeAnswer, type AwayTold } from './agent-away-notices'
import type { AgentBriefEvent } from './agent-briefs'

const NOW = new Date(2026, 9, 17, 1, 0)
const SINCE = new Date(2026, 9, 16, 22, 10).toISOString()
const ENDED = new Date(2026, 9, 17, 0, 40).toISOString()
type State = Pick<AwayRecord, 'state' | 'revision' | 'since' | 'endedAt'>
const away = (revision = 1): State => ({ state: 'away', revision, since: SINCE, endedAt: null })
const back = (revision = 2): State => ({ state: 'back', revision, since: SINCE, endedAt: ENDED })
const none: State = { state: 'none', revision: 0, since: null, endedAt: null }

function notices(live: Record<string, string> = { s1: 'i1' }, save?: (entries: Array<[string, AwayTold]>) => Promise<void>) {
  const saved: Array<Array<[string, AwayTold]>> = []
  const tracker = new AwayNotices({ liveIncarnationId: (sessionId) => live[sessionId], now: () => NOW, save: save ?? (async (entries) => { saved.push(entries) }) })
  const claims = new Map<string, string>()
  /** One hook holding its conversation's lock (or not) asks for the state the host holds now. */
  const ask = async (event: AgentBriefEvent, state: State, locked = true): Promise<AwayNoticeAnswer | null> => {
    const answer = await tracker.answer(event, () => state, locked)
    if (answer !== null) claims.set(event.turn!.conversation, answer.claimId)
    return answer
  }
  /** The hook's report that it printed the last claim it was handed. */
  const print = (conversation = 'c1'): Promise<boolean> => tracker.printed('s1', 'claude', conversation, claims.get(conversation) ?? 'none')
  return { tracker, saved, ask, print, claims }
}
const start = (source: string, over: Partial<AgentBriefEvent> = {}): AgentBriefEvent =>
  ({ sessionId: 's1', incarnationId: 'i1', agent: 'claude', event: 'SessionStart', source, turn: { conversation: 'c1', nested: false }, ...over })
const tool = (over: Partial<AgentBriefEvent> = {}): AgentBriefEvent =>
  ({ sessionId: 's1', incarnationId: 'i1', agent: 'claude', event: 'PostToolUse', source: null, turn: { conversation: 'c1', nested: false }, ...over })
const revisionOf = (answer: AwayNoticeAnswer | null): number | null => answer?.revision ?? null

describe('AwayNotices (Story 76.4 AC1-AC2)', () => {
  it('tells a new conversation the state only while he is away, with its stamp and the whole text', async () => {
    const { ask } = notices()
    expect(await ask(start('startup'), back())).toBeNull()
    expect(await ask(start('startup'), none)).toBeNull()
    const told = await ask(start('startup', { turn: { conversation: 'c2', nested: false } }), away(3))
    expect(told).toMatchObject({ revision: 3, text: `[BMN state: the owner is away since Fri 22:10 (revision 3). Context from BMN, not a new task.]\n${AWAY_AGENT_TEXT}` })
    expect(told?.claimId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('hands a working agent the change once, at its next tool call, and back after away', async () => {
    const { ask, print } = notices()
    expect(await ask(tool(), none)).toBeNull()
    expect(revisionOf(await ask(tool(), away()))).toBe(1)
    await print()
    expect(await ask(tool(), away())).toBeNull()
    const backNotice = await ask(tool(), back())
    expect(backNotice?.text).toBe(`[BMN state: the owner is back since 00:40 (revision 2). Context from BMN, not a new task.]\n${AWAY_BACK_AGENT_TEXT}`)
    await print()
    expect(await ask(tool(), back())).toBeNull()
    expect(revisionOf(await ask(tool(), away(3)))).toBe(3)
  })

  it('hands nothing to a hook that does not hold its conversation\'s lock; the state waits for one that does', async () => {
    const { ask } = notices()
    expect(await ask(tool(), away(), false)).toBeNull()
    expect(revisionOf(await ask(tool(), away()))).toBe(1)
  })

  it('hands the current state again to the next lock holder when a claim was never reported printed: its hook has ended', async () => {
    const { ask, print } = notices()
    await ask(tool(), away())
    expect(revisionOf(await ask(tool(), away()))).toBe(1)
    await print()
    await ask(tool(), back())
    expect(revisionOf(await ask(tool(), back()))).toBe(2)
  })

  it('confirms only the claim a printed report names, so a late report of an older claim confirms nothing (the recheck\'s [2, 1] schedule)', async () => {
    const { tracker, ask, print, claims } = notices()
    await ask(tool(), away())
    const older = claims.get('c1')!
    // Its hook ended without a report; the next lock holder is handed back, and only then does the older report arrive.
    await ask(tool(), back())
    expect(await tracker.printed('s1', 'claude', 'c1', older)).toBe(false)
    expect(tracker.toldTo('s1', 'claude', 'c1')).toMatchObject({ revision: 2, state: 'back', status: 'claimed' })
    expect(await print()).toBe(true)
    expect(await print()).toBe(false)
  })

  it('makes claims one after another: two asks at once are each decided against what the one before left', async () => {
    const { tracker } = notices()
    const [first, second] = await Promise.all([tracker.answer(tool(), () => away(), true), tracker.answer(tool(), () => away(), true)])
    // The second asker holds the lock only after the first ended, so the unconfirmed first claim is handed again.
    expect([first?.revision, second?.revision]).toEqual([1, 1])
    expect(first?.claimId).not.toBe(second?.claimId)
    expect(tracker.toldTo('s1', 'claude', 'c1')?.claimId).toBe(second?.claimId)
  })

  it('stores a claim before answering it: a claim that cannot be stored hands nothing and the next tool call tries again', async () => {
    let fail = true
    const saved: Array<Array<[string, AwayTold]>> = []
    const { ask } = notices({ s1: 'i1' }, async (entries) => { if (fail) throw new Error('disk full'); saved.push(entries) })
    expect(await ask(tool(), away())).toBeNull()
    fail = false
    expect(revisionOf(await ask(tool(), away()))).toBe(1)
    expect(saved).toHaveLength(1)
    expect(saved[0]![0]![1]).toMatchObject({ revision: 1, state: 'away', status: 'claimed' })
  })

  it('tries a failed save of a printed report again by itself; the stored claim meanwhile stays uncertain', async () => {
    vi.useFakeTimers()
    try {
      const saved: Array<Array<[string, AwayTold]>> = []
      let calls = 0
      const { ask, print } = notices({ s1: 'i1' }, async (entries) => { calls += 1; if (calls === 2) throw new Error('disk full'); saved.push(entries) })
      await ask(tool(), away())
      expect(saved.at(-1)![0]![1].status).toBe('claimed')
      expect(await print()).toBe(true)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(saved.at(-1)![0]![1].status).toBe('printed')
    } finally { vi.useRealTimers() }
  })

  it('never hands an away that is already over when it was never handed (they coalesce only then)', async () => {
    const { tracker, ask } = notices()
    expect(await ask(tool(), back())).toBeNull()
    expect(tracker.toldTo('s1', 'claude', 'c1')).toBeUndefined()
  })

  it('never hands a revision older than the one handed', async () => {
    const { ask } = notices()
    await ask(tool(), away(5))
    expect(await ask(tool(), back(4))).toBeNull()
    expect(await ask(start('compact'), away(4))).toBeNull()
  })

  it('tells a resumed or forked conversation only what changed, and a compacted or cleared one again', async () => {
    const { ask, print } = notices()
    await ask(start('startup'), away())
    await print()
    expect(await ask(start('resume'), away())).toBeNull()
    expect(revisionOf(await ask(start('compact'), away()))).toBe(1)
    expect(revisionOf(await ask(start('clear'), away()))).toBe(1)
    await print()
    expect(revisionOf(await ask(start('resume'), back()))).toBe(2)
    await print()
    expect(revisionOf(await ask(start('compact'), back()))).toBe(2)
    expect(await ask(start('fork', { turn: { conversation: 'c9', nested: false } }), back())).toBeNull()
    expect(revisionOf(await ask(start('fork', { turn: { conversation: 'c9', nested: false } }), away(3)))).toBe(3)
  })

  it('tells back to a conversation resumed after a BMN restart, from what was stored before the away was handed', async () => {
    const first = notices()
    await first.ask(tool(), away())
    const kept = first.saved.at(-1)!
    const restarted = notices({ s1: 'i2' })
    restarted.tracker.load(kept)
    expect(revisionOf(await restarted.ask(start('resume', { incarnationId: 'i2' }), back()))).toBe(2)
    const fresh = notices({ s1: 'i2' })
    expect(await fresh.ask(start('resume', { incarnationId: 'i2' }), back())).toBeNull()
    const again = notices({ s1: 'i2' })
    again.tracker.load(kept)
    expect(revisionOf(await again.ask(start('resume', { incarnationId: 'i2' }), away()))).toBe(1)
  })

  it('forgets conversations told back first, keeping every one still told away past the usual bound', async () => {
    const { tracker, ask, print } = notices()
    for (let index = 0; index < AWAY_NOTICES_REMEMBERED; index += 1) {
      const conversation = `b${index}`
      await ask(tool({ turn: { conversation, nested: false } }), away())
      await print(conversation)
      await ask(tool({ turn: { conversation, nested: false } }), back())
      await print(conversation)
    }
    await ask(tool({ turn: { conversation: 'kept-away', nested: false } }), away(3))
    for (let index = 0; index < 10; index += 1) await ask(tool({ turn: { conversation: `n${index}`, nested: false } }), away(3))
    expect(tracker.toldTo('s1', 'claude', 'kept-away')).toMatchObject({ state: 'away' })
    expect(tracker.toldTo('s1', 'claude', 'b0')).toBeUndefined()
  })

  it('hands nothing to a sub-agent, a process no longer live, an app it was not measured in or an event without a conversation', async () => {
    const { ask } = notices()
    expect(await ask(tool({ turn: { conversation: 'c1', nested: true } }), away())).toBeNull()
    expect(await ask(tool({ incarnationId: 'old' }), away())).toBeNull()
    expect(await ask(tool({ incarnationId: null }), away())).toBeNull()
    expect(await ask(tool({ agent: 'opencode' }), away())).toBeNull()
    expect(await ask(tool({ event: 'PreToolUse' }), away())).toBeNull()
    expect(revisionOf(await ask(tool({ agent: 'codex' }), away()))).toBe(1)
  })

  it('records printed for the claim handed only, and never as read', async () => {
    const { tracker, ask, print, claims } = notices()
    await ask(tool(), away())
    expect(await tracker.printed('s1', 'claude', 'c1', 'another-claim')).toBe(false)
    expect(await print()).toBe(true)
    expect(await print()).toBe(false)
    expect(tracker.toldTo('s1', 'claude', 'c1')).toEqual({ revision: 1, state: 'away', status: 'printed', incarnationId: 'i1', claimedAt: NOW.toISOString(), claimId: claims.get('c1') })
  })
})
