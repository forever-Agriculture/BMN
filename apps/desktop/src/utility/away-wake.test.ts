// MODULE: away-wake.test.ts - Story 90.6 with a fake clock: ticks, claims, every eligibility and pre-write check, restarts, the recorded idle prompts
import { describe, expect, it } from 'vitest'
import { EMPTY_AWAY_RECORD, type AwayRecord } from '@bmn/protocol'
import { AWAY_WAKE_LINE, AwayWake, idlePrompt, testAwayWakeTimes, type WakeAttention, type WakeObservation } from './away-wake'
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
  let beforeScreen: (() => void) | undefined
  const add = (sessionId: string, agent: string, extra: Partial<Session> & { event?: string; observedAt?: string } = {}): void => {
    sessions.set(sessionId, {
      seen: { sessionId, incarnationId: `inc-${sessionId}`, agent, event: extra.event ?? 'Stop', observedAt: extra.observedAt ?? at(T + HOUR), foreground: `fg-${sessionId}` },
      screen: agent === 'codex' ? CODEX_IDLE : CLAUDE_IDLE, front: `fg-${sessionId}`, live: `inc-${sessionId}`, generation: 1, pending: 0, ...extra
    })
    attention.push({ sessionId, requestKey: `${agent}:turn`, kind: 'notice', state: 'open', openedAt: at(T + HOUR) })
  }
  const make = (): AwayWake => new AwayWake({
    now: () => new Date(now),
    away: () => away,
    observations: () => [...sessions.values()].map((session) => session.seen),
    openAttention: async () => attention,
    liveIncarnation: (id) => sessions.get(id)?.live,
    foreground: (id) => sessions.get(id)?.front ?? null,
    generation: (id) => ({ generation: sessions.get(id)?.generation ?? 0, pending: sessions.get(id)?.pending ?? 0 }),
    screen: async (id) => { await Promise.resolve(); beforeScreen?.(); return sessions.get(id)?.screen ?? null },
    write: (sessionId, text) => written.push({ sessionId, text }),
    log: (line) => logs.push(line)
  })
  return {
    add, make, sessions, written, logs,
    set now(value: number) { now = value },
    set away(value: AwayRecord) { away = value },
    get attention() { return attention }, set attention(value: WakeAttention[]) { attention = value },
    set beforeScreen(value: () => void) { beforeScreen = value }
  }
}

describe('the Away wake-up (Story 90.6)', () => {
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
    w.add('opencode', 'opencode')
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
      opencode: 'opencode sessions are not woken (no recorded idle prompt)',
      busy: 'its latest event is PreToolUse, not a finished turn',
      before: 'no hook event since the owner left',
      noturn: 'no open finished-turn notice',
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

  it('blanks dim placeholder text on the mirror, keeping typed text', async () => {
    const placeholder = new ScreenMirror(80, 6, new TextEncoder().encode('\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\r\n'))
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
