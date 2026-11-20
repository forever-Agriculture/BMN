// MODULE: away-wake.test.ts - Stories 90.6 and 113.6 with a fake clock: ticks, claims, every eligibility and pre-write check, restarts, the recorded idle prompts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EMPTY_AWAY_RECORD, type AwayRecord, type AwayWakeDecision, type AwayWakeTick } from '@bmn/protocol'
import { AWAY_WAKE_LINE, AwayWake, idlePrompt, testAwayWakeTimes, type WakeAttention, type WakeObservation, type WakeScreen } from './away-wake'
import { ScreenMirror } from './screen-mirror'

const T = Date.parse('2026-10-23T22:00:00.000Z')
const HOUR = 60 * 60 * 1000
const at = (ms: number): string => new Date(ms).toISOString()
const RULE = '─'.repeat(60)
/** Shapes recorded from real sessions on 2026-10-23 (Claude Code 2.1.309, Codex 0.164.0), dim placeholders blanked. */
const CLAUDE_IDLE = ['● ok', '✻ Brewed for 3s', RULE, '❯ ', RULE, '  Opus 5.5 high ┃ ~/scratch']
const CODEX_IDLE = ['› Reply with the single word ok.', '• ok', '', '›', '', '  GPT-6.1-Sol xhigh · ~/scratch', '  ? for shortcuts']

interface Session { seen: WakeObservation; screen: string[] | null; front: string | null; live: string; generation: number; pending: number }

function world(now0 = T + 2 * HOUR) {
  let now = now0
  let away: AwayRecord = { ...EMPTY_AWAY_RECORD, state: 'away', revision: 3, periodId: 'p1', since: at(T) }
  const sessions = new Map<string, Session>()
  let attention: WakeAttention[] = []
  const written: Array<{ sessionId: string; text: string }> = []
  const logs: string[] = []
  const records: Array<{ tick: AwayWakeTick; decisions: AwayWakeDecision[] }> = []
  let unreadable = false
  let beforeScreen: (() => void) | undefined
  // BMN's in-memory record of each run's last finished turn (the message wake's, Story 110.3); empty unless a case sets it.
  const finished = new Map<string, string>()
  const add = (sessionId: string, agent: string, extra: Partial<Session> & { event?: string; observedAt?: string; source?: string | null } = {}): void => {
    const { event, observedAt, source, ...rest } = extra
    sessions.set(sessionId, {
      seen: { sessionId, incarnationId: `inc-${sessionId}`, agent, event: event ?? 'Stop', source: source ?? null,
        observedAt: observedAt ?? at(T + HOUR), foreground: `fg-${sessionId}` },
      screen: agent === 'codex' ? CODEX_IDLE : CLAUDE_IDLE,
      front: `fg-${sessionId}`, live: `inc-${sessionId}`, generation: 1, pending: 0, ...rest
    })
    attention.push({ sessionId, requestKey: `${agent}:turn`, kind: 'notice', state: 'open', openedAt: at(T + HOUR) })
  }
  const make = (): AwayWake => new AwayWake({
    now: () => new Date(now),
    away: () => away,
    observations: () => [...sessions.values()].map((session) => session.seen),
    observation: (id) => sessions.get(id)?.seen,
    openAttention: async () => { if (unreadable) throw new Error('database locked'); return attention },
    finishedTurn: (id, incarnationId) => sessions.get(id)?.seen.incarnationId === incarnationId ? finished.get(id) ?? null : null,
    liveIncarnation: (id) => sessions.get(id)?.live,
    foreground: (id) => sessions.get(id)?.front ?? null,
    generation: (id) => ({ generation: sessions.get(id)?.generation ?? 0, pending: sessions.get(id)?.pending ?? 0 }),
    screen: async (id): Promise<WakeScreen | null> => {
      await Promise.resolve(); beforeScreen?.()
      const session = sessions.get(id)
      return session?.screen ? { lines: session.screen } : null
    },
    write: (sessionId, text) => written.push({ sessionId, text }),
    log: (line) => logs.push(line),
    record: (tick, decisions) => records.push({ tick, decisions })
  })
  return {
    add, make, sessions, written, logs, finished, records,
    set unreadable(value: boolean) { unreadable = value },
    set now(value: number) { now = value },
    set away(value: AwayRecord) { away = value },
    get attention() { return attention }, set attention(value: WakeAttention[]) { attention = value },
    set beforeScreen(value: () => void) { beforeScreen = value }
  }
}

describe('the Away wake-up (Story 90.6)', () => {
  it('types nothing when the agent reports again while the screen is read, such as a tool starting (epic review)', async () => {
    const w = world(T)
    w.add('a', 'codex')
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR
    w.beforeScreen = () => { const session = w.sessions.get('a')!; session.seen = { ...session.seen, event: 'PreToolUse', observedAt: at(T + 2 * HOUR - 1) } }
    await wake.sweep()
    expect(w.written).toEqual([])
    expect(w.logs.at(-1)).toContain('its agent reported again')
  })

  it('reads a Codex draft that runs on below an empty first line as a draft (epic review)', () => {
    expect(idlePrompt('codex', CODEX_IDLE)).toBe(true)
    expect(idlePrompt('codex', ['• ok', '', '›', '  unsent second line', '', '  GPT-6.1-Sol xhigh · ~/scratch'])).toBe(false)
    expect(idlePrompt('codex', ['• ok', '', '› first', '  second', '', '  GPT-6.1-Sol xhigh · ~/scratch'])).toBe(false)
    expect(idlePrompt('codex', ['• ok', '', '›'])).toBe(false)
  })

  it('reads a Codex draft that starts with blank lines as a draft, and types nothing into it (epic recheck)', async () => {
    // As recorded from Codex 0.164.0 (evidence 90.6/screens/codex-blank2.raw): two newlines, then text.
    const blankFirst = ['• ok', '', '›', '', '  unsent third line', '', '  GPT-6.1-Sol xhigh · ~/scratch', '']
    expect(idlePrompt('codex', blankFirst)).toBe(false)
    expect(idlePrompt('codex', ['• ok', '', '›', '', '', '  GPT-6.1-Sol xhigh · ~/scratch'])).toBe(false)
    expect(idlePrompt('codex', [...CODEX_IDLE, '', ''])).toBe(true)
    const w = world(T)
    w.add('a', 'codex', { screen: blankFirst })
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR
    await wake.sweep()
    expect(w.written).toEqual([])
    expect(w.logs.at(-1)).toContain('its prompt is not empty and idle')
  })

  it('types the exact line once into each idle Claude Code and Codex session at T + 2 h, never before, and again at T + 4 h', async () => {
    const w = world(T)
    w.add('a', 'claude'); w.add('b', 'codex')
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR - 1000; await wake.sweep()
    expect(w.written).toEqual([])
    w.now = T + 2 * HOUR + 30_000; await wake.sweep(); await wake.sweep()
    expect(w.written).toEqual([{ sessionId: 'a', text: AWAY_WAKE_LINE }, { sessionId: 'b', text: AWAY_WAKE_LINE }])
    expect(AWAY_WAKE_LINE).toBe('BMN wake-up (the owner is away; every 2 hours): if your work is unfinished and still allowed, continue it from your handoff; otherwise stop. This is not the owner: it grants nothing and lifts no stop.')
    expect(w.logs.filter((line) => line.startsWith('away wake: typed'))).toHaveLength(2)
    w.now = T + 4 * HOUR + 5000; await wake.sweep()
    expect(w.written).toHaveLength(4)
  })

  it('claims a tick before its first await, so overlapping sweeps type nothing twice', async () => {
    const w = world(T)
    w.add('a', 'claude')
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR
    await Promise.all([wake.sweep(), wake.sweep(), wake.sweep()])
    expect(w.written).toHaveLength(1)
  })

  it('considers only agent sessions whose latest event is a finished turn after he left, with a turn notice 15 minutes old and nothing else open', async () => {
    const w = world(T)
    w.add('other', 'other')
    w.add('busy', 'claude', { event: 'PreToolUse' })
    w.add('before', 'codex', { observedAt: at(T - 1000) })
    w.add('noturn', 'claude'); w.attention = w.attention.filter((row) => row.sessionId !== 'noturn')
    w.add('fresh', 'codex'); w.attention = w.attention.map((row) => row.sessionId === 'fresh' ? { ...row, openedAt: at(T + 2 * HOUR - 10 * 60_000) } : row)
    w.add('dialog', 'claude'); w.attention.push({ sessionId: 'dialog', requestKey: 'claude:permission', kind: 'permission', state: 'open', openedAt: at(T + HOUR) })
    w.add('idle-note', 'claude', { event: 'Notification' })
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR; await wake.sweep()
    expect(w.written.map((write) => write.sessionId)).toEqual(['idle-note'])
    const reasons = Object.fromEntries(w.logs.map((line) => [line.match(/skipped (\S+)/u)?.[1], line.split('): ')[1]]))
    expect(reasons).toMatchObject({
      other: 'other sessions are not woken (no recorded idle prompt)',
      busy: 'its latest event is PreToolUse, not a finished turn',
      before: 'no hook event since the owner left',
      noturn: 'BMN did not see this run finish a turn',
      fresh: 'its turn finished less than 15 minutes ago',
      dialog: 'another request of it is open'
    })
  })

  it('rechecks right before the write: Back, a new run, a shell in front, a dialog arriving, a draft or no screen each skip that tick', async () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => void, string]> = [
      ['back', (w) => { w.beforeScreen = () => { w.away = { ...EMPTY_AWAY_RECORD, state: 'back', revision: 4, periodId: 'p1', since: at(T), endedAt: at(T + HOUR) } } }, 'the owner is no longer away in this period'],
      ['new-run', (w) => { w.beforeScreen = () => { w.sessions.get('s')!.live = 'inc-other' } }, 'its run changed'],
      ['shell', (w) => { w.sessions.get('s')!.front = null }, 'its agent is not in the foreground'],
      ['other-program', (w) => { w.sessions.get('s')!.front = 'fg-vim' }, 'its agent is not in the foreground'],
      ['dialog-arrives', (w) => { w.beforeScreen = () => { w.sessions.get('s')!.generation += 1 } }, 'its requests changed'],
      ['pending', (w) => { w.sessions.get('s')!.pending = 1 }, 'its requests changed'],
      ['draft', (w) => { w.sessions.get('s')!.screen = [RULE, '❯ half a sentence', RULE] }, 'its prompt is not empty and idle'],
      ['unknown-screen', (w) => { w.sessions.get('s')!.screen = ['Do you want to proceed?', '❯ 1. Yes', '  2. No'] }, 'its prompt is not empty and idle'],
      ['no-mirror', (w) => { w.sessions.get('s')!.screen = null }, 'no screen to read']
    ]
    for (const [name, arrange, reason] of cases) {
      const w = world(T)
      w.add('s', 'claude')
      const wake = w.make()
      await wake.sweep()
      arrange(w)
      w.now = T + 2 * HOUR
      await wake.sweep()
      expect(w.written, name).toEqual([])
      expect(w.logs.at(-1), name).toContain(reason)
      // A skipped session waits for the next tick, never retried within this one.
      await wake.sweep()
      expect(w.logs.filter((line) => line.includes('skipped s ')), name).toHaveLength(1)
    }
  })

  it('types nothing while only leaving or back, and a new Away period starts its own times', async () => {
    const w = world(T)
    w.add('a', 'claude')
    w.away = { ...EMPTY_AWAY_RECORD, state: 'back', revision: 4, periodId: 'p1', since: at(T), endedAt: at(T + HOUR) }
    const wake = w.make()
    w.now = T + 3 * HOUR; await wake.sweep()
    expect(w.written).toEqual([])
    const T2 = T + 3 * HOUR
    w.away = { ...EMPTY_AWAY_RECORD, state: 'away', revision: 5, periodId: 'p2', since: at(T2) }
    w.sessions.get('a')!.seen.observedAt = at(T2 + HOUR)
    w.attention = w.attention.map((row) => ({ ...row, openedAt: at(T2 + HOUR) }))
    await wake.sweep()
    w.now = T2 + 2 * HOUR - 1; await wake.sweep()
    expect(w.written).toEqual([])
    w.now = T2 + 2 * HOUR; await wake.sweep()
    expect(w.written).toHaveLength(1)
  })

  it('after a restart during Away, the next time is the next T + k × 2 h after now; missed times are not made up', async () => {
    const w = world(T + 2 * HOUR + 10 * 60_000)
    w.add('a', 'claude')
    const restarted = w.make()
    await restarted.sweep()
    expect(w.written).toEqual([])
    w.now = T + 4 * HOUR - 1; await restarted.sweep()
    expect(w.written).toEqual([])
    w.now = T + 4 * HOUR; await restarted.sweep()
    expect(w.written).toHaveLength(1)
  })

  it('reads the recorded empty prompts as idle and a draft, a dialog or history as not', () => {
    expect(idlePrompt('claude', CLAUDE_IDLE)).toBe(true)
    expect(idlePrompt('codex', CODEX_IDLE)).toBe(true)
    expect(idlePrompt('claude', [RULE, '❯ draft text', RULE])).toBe(false)
    expect(idlePrompt('claude', ['❯ Reply with the single word ok.', '● ok'])).toBe(false)
    expect(idlePrompt('codex', ['›', '› draft text'])).toBe(false)
    expect(idlePrompt('codex', ['nothing here'])).toBe(false)
  })

  it('replays recorded Codex screens through the mirror: the empty prompt is idle, both drafts are not (epic recheck)', async () => {
    const replay = async (name: string, columns: number, rows: number): Promise<boolean> => {
      const mirror = new ScreenMirror(columns, rows, new Uint8Array(readFileSync(new URL(`./test-fixtures/away-wake/${name}.raw`, import.meta.url))))
      await mirror.settled()
      return idlePrompt('codex', mirror.undimmedLines())
    }
    expect(await replay('codex-idle', 120, 40)).toBe(true)
    expect(await replay('codex-multiline', 100, 32)).toBe(false)
    expect(await replay('codex-blank2', 100, 32)).toBe(false)
  })

  it('blanks dim placeholder text on the mirror, keeping typed text', async () => {
    const placeholder = new ScreenMirror(80, 6, new TextEncoder().encode('\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\r\n\r\n  \x1b[38;2;246;226;183mGPT-6.1-Sol xhigh\x1b[39m · ~/scratch\r\n'))
    await placeholder.settled()
    expect(idlePrompt('codex', placeholder.undimmedLines())).toBe(true)
    expect(placeholder.lines()[0]).toBe('› Ask Codex to do anything')
    const draft = new ScreenMirror(80, 6, new TextEncoder().encode('\x1b[1m›\x1b[0m draft text\r\n'))
    await draft.settled()
    expect(idlePrompt('codex', draft.undimmedLines())).toBe(false)
    const claude = new ScreenMirror(80, 6, new TextEncoder().encode(`${RULE}\r\n\x1b[39m❯\u00a0\x1b[2mTry "how do I log an error?"\x1b[0m\r\n${RULE}\r\n`))
    await claude.settled()
    expect(idlePrompt('claude', claude.undimmedLines())).toBe(true)
  })

  it('shortens its times only in a test-mode host', () => {
    const env = { BMN_TEST_AWAY_WAKE_EVERY_MS: '60000', BMN_TEST_AWAY_WAKE_QUIET_MS: '5000' }
    expect(testAwayWakeTimes(['electron'], env)).toEqual({})
    expect(testAwayWakeTimes(['--bmn-test-host'], env)).toEqual({ everyMs: 60000, quietMs: 5000 })
    expect(testAwayWakeTimes(['--bmn-test-host'], { BMN_TEST_AWAY_WAKE_EVERY_MS: '5' })).toEqual({})
  })
})

describe('the Away wake-up after his night of 2026-11-06 (Epic 111 F17, F19)', () => {
  it('wakes a Claude session whose turn an API error ended (StopFailure), as it wakes one after Stop', async () => {
    const w = world(T)
    w.add('a', 'claude', { event: 'StopFailure' })
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR; await wake.sweep()
    expect(w.written).toEqual([{ sessionId: 'a', text: AWAY_WAKE_LINE }])
  })

  it('wakes a session he opened after its turn finished: the cleared notice is no proof, BMN\'s finish time is', async () => {
    const w = world(T)
    w.add('a', 'claude')
    w.attention = []
    w.finished.set('a', at(T + HOUR))
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR; await wake.sweep()
    expect(w.written).toEqual([{ sessionId: 'a', text: AWAY_WAKE_LINE }])
  })

  it('still skips a session whose finish BMN never saw, and one that finished under 15 minutes ago', async () => {
    const w = world(T)
    w.add('a', 'claude')
    w.attention = []
    w.add('b', 'claude')
    w.attention = w.attention.filter((row) => row.sessionId !== 'b')
    w.finished.set('b', at(T + 2 * HOUR - 60_000))
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR; await wake.sweep()
    expect(w.written).toEqual([])
    expect(w.logs.join('\n')).toContain('BMN did not see this run finish a turn')
    expect(w.logs.join('\n')).toContain('its turn finished less than 15 minutes ago')
  })

  it('an agent\'s own bmn ask card or another notice does not hold it; the app\'s own question or permission does', async () => {
    const w = world(T)
    w.add('a', 'claude')
    w.add('b', 'claude')
    w.add('c', 'codex')
    w.attention.push({ sessionId: 'a', requestKey: 'deploy-go', kind: 'question', state: 'open', openedAt: at(T + HOUR), openedBy: 'cli' })
    w.attention.push({ sessionId: 'a', requestKey: 'watch:repeat', kind: 'notice', state: 'open', openedAt: at(T + HOUR), openedBy: 'bmn' })
    w.attention.push({ sessionId: 'b', requestKey: 'claude:question', kind: 'question', state: 'open', openedAt: at(T + HOUR), openedBy: 'hook:claude:PreToolUse' })
    w.attention.push({ sessionId: 'c', requestKey: 'codex:permission', kind: 'permission', state: 'open', openedAt: at(T + HOUR), openedBy: 'hook:codex:PermissionRequest' })
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR; await wake.sweep()
    expect(w.written).toEqual([{ sessionId: 'a', text: AWAY_WAKE_LINE }])
  })
})

describe('the facts of each tick (Story 113.6 AC1)', () => {
  it('keeps per session the reason code of every early skip, text-free, with no screen facts before the last checks', async () => {
    const w = world(T)
    w.add('other', 'other')
    w.add('busy', 'claude', { event: 'PreToolUse' })
    w.add('before', 'codex', { observedAt: at(T - 1000) })
    w.add('noturn', 'claude'); w.attention = w.attention.filter((row) => row.sessionId !== 'noturn')
    w.add('fresh', 'codex'); w.attention = w.attention.map((row) => row.sessionId === 'fresh' ? { ...row, openedAt: at(T + 2 * HOUR - 10 * 60_000) } : row)
    w.add('dialog', 'claude'); w.attention.push({ sessionId: 'dialog', requestKey: 'claude:permission', kind: 'permission', state: 'open', openedAt: at(T + HOUR) })
    // A session OpenCode reported before its retirement (Epic 123): never woken.
    w.add('retired', 'opencode')
    w.add('idle', 'claude', { event: 'Notification' })
    const wake = w.make()
    await wake.sweep()
    expect(w.records).toEqual([])
    w.now = T + 2 * HOUR; await wake.sweep()
    expect(w.records).toHaveLength(1)
    const { tick, decisions } = w.records[0]!
    expect(tick).toEqual({ periodId: 'p1', tick: 1, at: at(T + 2 * HOUR), processStartedAt: at(T), state: 'swept', sessionsSeen: 8 })
    expect(Object.fromEntries(decisions.map((row) => [row.sessionId, row.reason]))).toEqual({
      other: 'app-not-woken', busy: 'not-finished-turn', before: 'no-event-since-away', noturn: 'finish-unknown', fresh: 'quiet',
      dialog: 'request-open', retired: 'app-not-woken', idle: null
    })
    expect(decisions.find((row) => row.sessionId === 'busy')).toEqual({ sessionId: 'busy', incarnationId: 'inc-busy', app: 'claude',
      foreground: null, generation: 1, prompt: null, outcome: 'skipped', reason: 'not-finished-turn' })
    expect(decisions.find((row) => row.sessionId === 'idle')).toEqual({ sessionId: 'idle', incarnationId: 'inc-idle', app: 'claude',
      foreground: true, generation: 1, prompt: 'idle', outcome: 'typed', reason: null })
    // Nothing in a kept row is screen or prompt text.
    expect(JSON.stringify(w.records)).not.toMatch(/❯|›|Brewed/u)
  })

  it('keeps the last checks\' facts: the foreground and the prompt state that decided the skip', async () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => void, Partial<AwayWakeDecision>]> = [
      ['back', (w) => { w.beforeScreen = () => { w.away = { ...EMPTY_AWAY_RECORD, state: 'back', revision: 4, periodId: 'p1', since: at(T), endedAt: at(T + HOUR) } } }, { reason: 'owner-back', foreground: null, prompt: null }],
      ['new-run', (w) => { w.beforeScreen = () => { w.sessions.get('s')!.live = 'inc-other' } }, { reason: 'run-changed', foreground: null }],
      ['shell', (w) => { w.sessions.get('s')!.front = null }, { reason: 'not-foreground', foreground: false, prompt: null }],
      ['dialog-arrives', (w) => { w.beforeScreen = () => { w.sessions.get('s')!.generation += 1 } }, { reason: 'requests-changed', foreground: true, prompt: null }],
      ['draft', (w) => { w.sessions.get('s')!.screen = [RULE, '❯ half a sentence', RULE] }, { reason: 'prompt-busy', foreground: true, prompt: 'busy' }],
      ['no-mirror', (w) => { w.sessions.get('s')!.screen = null }, { reason: 'no-screen', foreground: true, prompt: 'none' }]
    ]
    for (const [name, arrange, expected] of cases) {
      const w = world(T)
      w.add('s', 'claude')
      const wake = w.make()
      await wake.sweep()
      arrange(w)
      w.now = T + 2 * HOUR
      await wake.sweep()
      expect(w.records.at(-1)!.decisions[0], name).toMatchObject({ outcome: 'skipped', ...expected })
    }
  })

  it('records a tick once however often it is swept, a quiet tick with no sessions, and unreadable requests as an unreadable tick', async () => {
    const w = world(T)
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR; await wake.sweep(); await wake.sweep()
    expect(w.records).toEqual([{ tick: expect.objectContaining({ tick: 1, state: 'swept', sessionsSeen: 0 }), decisions: [] }])
    w.add('late', 'claude')
    await wake.sweep()
    expect(w.records).toHaveLength(2)
    expect(w.records[1]!.decisions.map((row) => row.sessionId)).toEqual(['late'])
    w.unreadable = true
    w.now = T + 4 * HOUR; await wake.sweep()
    expect(w.records[2]).toEqual({ tick: expect.objectContaining({ tick: 2, state: 'unreadable', sessionsSeen: 1 }), decisions: [] })
  })

  it('a failure to keep the facts never stops the wake', async () => {
    const w = world(T)
    w.add('s', 'claude')
    const wake = new AwayWake({ ...(w.make() as unknown as { options: ConstructorParameters<typeof AwayWake>[0] }).options, record: () => { throw new Error('disk full') } })
    await wake.sweep()
    w.now = T + 2 * HOUR; await wake.sweep()
    expect(w.written).toHaveLength(1)
  })
})
