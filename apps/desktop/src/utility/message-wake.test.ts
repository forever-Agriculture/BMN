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
    finished: { incarnationId: 'run-b', at: at(T) } as { incarnationId: string; at: string } | null,
    beforeScreen: undefined as (() => void) | undefined
  }
  const written: Array<{ sessionId: string; text: string }> = []
  const notes = new Map<string, string | null>()
  const claimed: string[] = []
  const released: string[] = []
  const logs: string[] = []
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
    finishedTurn: (_sessionId, incarnationId) => (state.finished?.incarnationId === incarnationId ? state.finished.at : null),
    typedAt: () => state.typedAt,
    note: (messageId, reason) => notes.set(messageId, reason),
    log: (line) => logs.push(line)
  })
  return { state, wake, written, notes, claimed, released, logs }
}

describe('what the wake records (125.2 AC1)', () => {
  const quiet = SESSION_MESSAGE_WAKE_QUIET_MS
  it('a typed wake is logged with the quiet time in force and the finished turn it was weighed against', async () => {
    const w = world('codex')
    await w.wake.sweep()
    expect(w.logs).toEqual([`message wake: typed the wake line into b for m1 (quiet ${quiet} ms; turn finished ${at(T)}; 1 waiting)`])
  })
  it('a session whose turn finished inside the quiet time stays waiting, and the log alone says why', async () => {
    const w = world('codex')
    w.state.now = T + quiet - 1000
    await w.wake.sweep()
    expect(w.written).toEqual([])
    expect(w.logs).toEqual([`message wake: skipped b: its turn finished less than 5 minutes ago (quiet ${quiet} ms; turn finished ${at(T)}; 1 waiting)`])
  })
  it('a run BMN never saw finish a turn is logged as not seen, never as a time', async () => {
    const w = world('codex')
    w.state.finished = null
    await w.wake.sweep()
    expect(w.written).toEqual([])
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toMatch(/^message wake: skipped b: .+ \(quiet \d+ ms; turn finished not seen; 1 waiting\)$/u)
  })
  it('each early refusal is logged too: no agent heard, an app that is never woken, no message that may wake it', async () => {
    const unheard = world()
    unheard.state.seen = undefined
    await unheard.wake.sweep()
    expect(unheard.logs).toEqual([`message wake: skipped b: BMN has not heard from its agent (quiet ${quiet} ms; turn finished not seen; 1 waiting)`])
    const other = world('opencode')
    await other.wake.sweep()
    expect(other.logs[0]).toMatch(/^message wake: skipped b: opencode sessions are not woken \(quiet/u)
    const deep = world()
    deep.state.candidates = [{ messageId: 'm1', wakeDepth: 9, wokenAt: null }]
    await deep.wake.sweep()
    expect(deep.logs).toEqual([`message wake: skipped b: no waiting message may wake it; each sender reads why (quiet ${quiet} ms; turn finished ${at(T)}; 1 waiting)`])
    expect(deep.notes.get('m1')).toMatch(/too many woken turns/u)
  })
})

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
  it('a session the owner has looked at still rests: selecting it cleared its reminder, not its finished turn', async () => {
    const w = world()
    w.state.attention = []
    await w.wake.sweep()
    expect(w.written).toHaveLength(1)
    expect(w.notes.get('m1')).toBeNull()
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
    ['a turn BMN did not see finish, or one that ended with work still in flight', (w) => { w.state.finished = null }, 'BMN did not see this run finish a turn with nothing in flight'],
    ['a finished turn of an earlier run', (w) => { w.state.finished = { incarnationId: 'run-a', at: at(T) } }, 'BMN did not see this run finish a turn with nothing in flight'],
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

describe('a message past its pair\'s limit holds up no other pair (113.7 AC2-AC3)', () => {
  it('the next message, from a sender within its limits, wakes the receiver once; the limited one keeps its reason', async () => {
    const w = world()
    const PAIR = 'these two sessions had 3 wakes in the last hour; it waits for the receiver\'s next turn'
    w.state.candidates = [{ messageId: 'limited', wakeDepth: 1, wokenAt: null }, { messageId: 'other', wakeDepth: 1, wokenAt: null }]
    const claim = (messageId: string) => {
      w.claimed.push(messageId)
      if (messageId === 'limited') return { claimed: false as const, reason: PAIR }
      w.state.candidates.find((one) => one.messageId === messageId)!.wokenAt = at(T)
      return { claimed: true as const, at: at(T) }
    }
    ;(w.wake as unknown as { options: { claim: (id: string) => Promise<ReturnType<typeof claim>> } }).options.claim = async (messageId) => claim(messageId)
    await w.wake.sweep()
    expect(w.claimed).toEqual(['limited', 'other'])
    expect(w.written).toEqual([{ sessionId: 'b', text: SESSION_MESSAGE_WAKE_LINE }])
    expect(w.notes.get('limited')).toBe(PAIR)
    expect(w.notes.get('other')).toBeNull()
  })

  it('every message limited: nothing typed, each keeps its own reason', async () => {
    const w = world()
    w.state.candidates = [{ messageId: 'm1', wakeDepth: 1, wokenAt: null }, { messageId: 'm2', wakeDepth: 1, wokenAt: null }]
    w.state.claim = { claimed: false, reason: 'this workspace had 12 wakes in the last hour; it waits for the receiver\'s next turn' }
    await w.wake.sweep()
    expect(w.written).toEqual([])
    expect(w.notes.get('m1')).toMatch(/12 wakes/u)
    expect(w.notes.get('m2')).toMatch(/12 wakes/u)
  })
})

describe('a sweep overlapping another types nothing twice', () => {
  it('holds one sweep at a time', async () => {
    const w = world()
    await Promise.all([w.wake.sweep(), w.wake.sweep()])
    expect(w.written).toHaveLength(1)
  })
})

describe('two receivers in one sweep (110.3 AC2, full review)', () => {
  it('a card that opens for the second while the first is checked stops the second write', async () => {
    const generations = new Map([['a', 1], ['b', 1]])
    const attention: WakeAttention[] = []
    const written: string[] = []
    const finished = at(T)
    const seen = (sessionId: string): WakeObservation => ({ sessionId, incarnationId: `run-${sessionId}`, agent: 'claude', event: 'Stop', source: null, plugin: null, observedAt: at(T), foreground: `fg-${sessionId}` })
    const wake = new MessageWake({
      now: () => new Date(T + SESSION_MESSAGE_WAKE_QUIET_MS + 1000),
      observation: (sessionId) => seen(sessionId),
      liveIncarnation: (sessionId) => `run-${sessionId}`,
      foreground: (sessionId) => `fg-${sessionId}`,
      generation: (sessionId) => ({ generation: generations.get(sessionId) ?? 0, pending: 0 }),
      screen: async (sessionId) => {
        await Promise.resolve()
        // While A's screen is read, B's permission card opens: B's generation moves on.
        if (sessionId === 'a' && !attention.length) {
          attention.push({ sessionId: 'b', requestKey: 'claude:permission', kind: 'permission', state: 'open', openedAt: at(T) })
          generations.set('b', 2)
        }
        return { lines: CLAUDE_IDLE, cursor: { x: 0, y: 0 } }
      },
      write: (sessionId) => written.push(sessionId),
      receivers: async () => ['a', 'b'],
      candidates: async (sessionId) => [{ messageId: `m-${sessionId}`, wakeDepth: 1, wokenAt: null }],
      providerRefusal: async () => null,
      claim: async () => ({ claimed: true, at: at(T) }),
      release: async () => undefined,
      // Read once, before the card opens.
      openAttention: async () => [...attention],
      finishedTurn: () => finished,
      typedAt: () => null,
      note: () => undefined,
      log: () => undefined
    })
    await wake.sweep()
    expect(written).toEqual(['a'])
  })
})
