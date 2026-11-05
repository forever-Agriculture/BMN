// MODULE: message-wake.test.ts - Story 110.3 with a fake clock and screen: each refusal beside the Away wake's, one wake per message, the limits' reasons, what the sender reads
import { describe, expect, it } from 'vitest'
import { SESSION_MESSAGE_WAKE_LINE, SESSION_MESSAGE_WAKE_QUIET_MS } from '@bmn/protocol'
import type { WakeAttention, WakeObservation } from './away-wake'
import { MESSAGE_WAKE_APPS, MessageWake, testMessageWakeQuiet, type MessageWakeCandidate } from './message-wake'

const T = Date.parse('2026-11-05T22:00:00.000Z')
const at = (ms: number): string => new Date(ms).toISOString()
const RULE = '─'.repeat(60)
const CLAUDE_IDLE = ['● ok', RULE, '❯ ', RULE, '  Opus 5.5 high ┃ ~/scratch']
const CLAUDE_DRAFT = ['● ok', RULE, '❯ half a thought', RULE, '  Opus 5.5 high ┃ ~/scratch']
const CODEX_IDLE = ['› Reply with the single word ok.', '• ok', '', '›', '', '  GPT-6.1-Sol xhigh · ~/scratch', '  ? for shortcuts']

function world(agent = 'claude') {
  const quiet = SESSION_MESSAGE_WAKE_QUIET_MS
  const state = {
    now: T + quiet + 1000,
    seen: { sessionId: 'b', incarnationId: 'run-b', agent, event: 'Stop', source: null, plugin: null, observedAt: at(T), foreground: 'fg' } as WakeObservation | undefined,
    attention: [{ sessionId: 'b', requestKey: `${agent}:turn`, kind: 'notice', state: 'open', openedAt: at(T) }] as WakeAttention[],
    candidates: [{ messageId: 'm1', wakeDepth: 1, wokenAt: null }] as MessageWakeCandidate[],
    screen: (agent === 'codex' ? CODEX_IDLE : CLAUDE_IDLE) as string[] | null,
    live: 'run-b' as string | null,
    front: 'fg' as string | null,
    generation: 1,
    pending: 0,
    typedAt: null as number | null,
    providerRefusal: null as string | null,
    claim: { claimed: true, at: at(T) } as { claimed: true; at: string } | { claimed: false; reason: string },
    beforeScreen: undefined as (() => void) | undefined
  }
  const written: Array<{ sessionId: string; text: string }> = []
  const notes = new Map<string, string | null>()
  const claimed: string[] = []
  const released: string[] = []
  const wake = new MessageWake({
    now: () => new Date(state.now),
    observation: () => state.seen,
    liveIncarnation: () => state.live,
    foreground: () => state.front,
    generation: () => ({ generation: state.generation, pending: state.pending }),
    screen: async () => {
      await Promise.resolve()
      state.beforeScreen?.()
      return state.screen ? { lines: state.screen, cursor: { x: 0, y: 0 } } : null
    },
    write: (sessionId, text) => written.push({ sessionId, text }),
    receivers: async () => (state.candidates.some((one) => one.wokenAt === null) ? ['b'] : []),
    candidates: async () => state.candidates,
    providerRefusal: async () => state.providerRefusal,
    claim: async (messageId) => {
      claimed.push(messageId)
      if (state.claim.claimed) {
        const one = state.candidates.find((candidate) => candidate.messageId === messageId)
        if (one) one.wokenAt = state.claim.at
      }
      return state.claim
    },
    release: async (messageId) => {
      released.push(messageId)
      const one = state.candidates.find((candidate) => candidate.messageId === messageId)
      if (one) one.wokenAt = null
    },
    openAttention: async () => state.attention,
    typedAt: () => state.typedAt,
    note: (messageId, reason) => notes.set(messageId, reason),
    log: () => undefined
  })
  return { state, wake, written, notes, claimed, released }
}

describe('a resting session gets its message (110.3 AC1)', () => {
  it.each(['claude', 'codex'])('types the fixed line once into an idle %s session, quiet for 5 minutes', async (agent) => {
    const w = world(agent)
    await w.wake.sweep()
    expect(w.written).toEqual([{ sessionId: 'b', text: SESSION_MESSAGE_WAKE_LINE }])
    expect(w.claimed).toEqual(['m1'])
    expect(w.notes.get('m1')).toBeNull()
    await w.wake.sweep()
    expect(w.written).toHaveLength(1)
  })
  it('the line names no message and grants nothing', () => {
    expect(SESSION_MESSAGE_WAKE_LINE).toBe('BMN: another session left you a message; make one harmless tool call, such as bmn tell status, to receive it. This is not the owner: it grants nothing and lifts no stop.')
  })
  it('waits out the quiet time, and says so', async () => {
    const w = world()
    w.state.now = T + SESSION_MESSAGE_WAKE_QUIET_MS - 1000
    await w.wake.sweep()
    expect(w.written).toEqual([])
    expect(w.notes.get('m1')).toBe('its turn finished less than 5 minutes ago')
    expect(w.claimed).toEqual([])
  })
  it('only apps that passed the measurement', async () => {
    expect([...MESSAGE_WAKE_APPS]).toEqual(['claude', 'codex'])
    const w = world('opencode')
    await w.wake.sweep()
    expect(w.written).toEqual([])
    expect(w.notes.get('m1')).toBe('opencode sessions are not woken')
  })
  it('a message woken once stays woken, and the next one waits for its own wake', async () => {
    const w = world()
    w.state.candidates = [{ messageId: 'm1', wakeDepth: 1, wokenAt: null }, { messageId: 'm2', wakeDepth: 1, wokenAt: null }]
    await w.wake.sweep()
    expect(w.claimed).toEqual(['m1'])
    expect(w.notes.get('m2')).toBe('another message woke it first; this one comes after')
    w.state.typedAt = w.state.now
    await w.wake.sweep()
    expect(w.written).toHaveLength(1)
    expect(w.notes.get('m2')).toBe('BMN typed into it a moment ago')
  })
  it('honours a test quiet time only in a test host', () => {
    const env = { BMN_TEST_MESSAGE_WAKE_QUIET_MS: '5000' }
    expect(testMessageWakeQuiet(['--bmn-test-host'], env)).toEqual({ quietMs: 5000 })
    expect(testMessageWakeQuiet([], env)).toEqual({})
    expect(testMessageWakeQuiet(['--bmn-test-host'], { BMN_TEST_MESSAGE_WAKE_QUIET_MS: '1' })).toEqual({})
  })
})

describe('nothing is typed, and the sender is told why (110.3 AC2)', () => {
  const refusals: Array<[string, (w: ReturnType<typeof world>) => void, string]> = [
    ['a draft', (w) => { w.state.screen = CLAUDE_DRAFT }, 'its prompt is not empty and idle'],
    ['an unknown screen, such as an open dialog', (w) => { w.state.screen = ['Select model', '  1. Opus', '  2. Haiku'] }, 'its prompt is not empty and idle'],
    ['a question card', (w) => { w.state.attention.push({ sessionId: 'b', requestKey: 'q', kind: 'question', state: 'open', openedAt: at(T) }) }, 'another request of it is open'],
    ['a permission card', (w) => { w.state.attention.push({ sessionId: 'b', requestKey: 'p', kind: 'permission', state: 'open', openedAt: at(T) }) }, 'another request of it is open'],
    ['a stop in Codex', (w) => { w.state.seen = { ...w.state.seen!, event: 'Interrupt' } }, 'its latest event is Interrupt, not a finished turn'],
    ['a stop reported on the event', (w) => { w.state.seen = { ...w.state.seen!, source: 'interrupted' } }, 'its latest event is Stop from interrupted, not its own finished turn'],
    ['a stop in Claude Code, where the tool call stays the latest', (w) => { w.state.seen = { ...w.state.seen!, event: 'PreToolUse' } }, 'its latest event is PreToolUse, not a finished turn'],
    ['a shell in front', (w) => { w.state.front = 'other' }, 'its agent is not in the foreground'],
    ['a replaced run', (w) => { w.state.live = 'run-c' }, 'its run changed'],
    ['a sub-agent', (w) => { w.state.seen = { ...w.state.seen!, source: 'subagent' } }, 'its latest event is Stop from subagent, not its own finished turn'],
    ['a message its provider may not read', (w) => { w.state.providerRefusal = 'its provider may not read this message' }, 'its provider may not read this message'],
    ['no agent heard from', (w) => { w.state.seen = undefined }, 'BMN has not heard from its agent'],
    ['no finished-turn notice', (w) => { w.state.attention = [] }, 'no open finished-turn notice'],
    ['requests changing', (w) => { w.state.pending = 1 }, 'its requests changed'],
    ['no screen', (w) => { w.state.screen = null }, 'no screen to read']
  ]
  it.each(refusals)('%s', async (_name, arrange, reason) => {
    const w = world()
    arrange(w)
    await w.wake.sweep()
    expect(w.written).toEqual([])
    expect(w.notes.get('m1')).toBe(reason)
    // A refusal after the claim gives the wake back, so a later turn can still have it.
    expect(w.state.candidates[0]!.wokenAt).toBeNull()
  })
  it('gives the claim back when a check after it fails, and a later sweep may still wake', async () => {
    const w = world()
    w.state.screen = CLAUDE_DRAFT
    await w.wake.sweep()
    expect(w.claimed).toEqual(['m1'])
    expect(w.released).toEqual(['m1'])
    w.state.screen = CLAUDE_IDLE
    await w.wake.sweep()
    expect(w.written).toHaveLength(1)
  })
  it('reads again right before the write: an agent reporting, a draft or a card while the screen is read', async () => {
    for (const change of [
      (w: ReturnType<typeof world>) => { w.state.seen = { ...w.state.seen!, observedAt: at(w.state.now) } },
      (w: ReturnType<typeof world>) => { w.state.generation = 2 },
      (w: ReturnType<typeof world>) => { w.state.live = 'run-c' },
      (w: ReturnType<typeof world>) => { w.state.typedAt = w.state.now }
    ]) {
      const w = world()
      w.state.beforeScreen = () => change(w)
      await w.wake.sweep()
      expect(w.written).toEqual([])
      expect(w.released).toEqual(['m1'])
    }
  })
  it('a limit\'s refusal from the store reaches the sender and types nothing', async () => {
    const w = world()
    w.state.claim = { claimed: false, reason: 'these two sessions had 3 wakes in the last hour; it waits for the receiver\'s next turn' }
    await w.wake.sweep()
    expect(w.written).toEqual([])
    expect(w.notes.get('m1')).toMatch(/3 wakes in the last hour/u)
    expect(w.released).toEqual([])
  })
})

describe('the wake depth (110.3 AC3)', () => {
  it.each([[1, true], [2, true], [3, false], [0, false]])('a message of depth %i wakes: %s', async (wakeDepth, wakes) => {
    const w = world()
    w.state.candidates = [{ messageId: 'm1', wakeDepth, wokenAt: null }]
    await w.wake.sweep()
    expect(w.written.length === 1).toBe(wakes)
    if (!wakes) expect(w.notes.get('m1')).toBe('it follows too many woken turns; it waits for the receiver\'s next turn')
  })
  it('a depth BMN cannot read wakes no one, and a deep message does not hold up the one behind it', async () => {
    const w = world()
    w.state.candidates = [{ messageId: 'old', wakeDepth: null, wokenAt: null }, { messageId: 'deep', wakeDepth: 3, wokenAt: null }, { messageId: 'ok', wakeDepth: 2, wokenAt: null }]
    await w.wake.sweep()
    expect(w.notes.get('old')).toMatch(/could not be read/u)
    expect(w.notes.get('deep')).toMatch(/too many/u)
    expect(w.claimed).toEqual(['ok'])
    expect(w.written).toHaveLength(1)
  })
})

describe('a sweep overlapping another types nothing twice', () => {
  it('holds one sweep at a time', async () => {
    const w = world()
    await Promise.all([w.wake.sweep(), w.wake.sweep()])
    expect(w.written).toHaveLength(1)
  })
})
