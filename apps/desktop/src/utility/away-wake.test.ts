// MODULE: away-wake.test.ts - Stories 90.6 and 93.3 with a fake clock: ticks, claims, every eligibility and pre-write check, restarts, the recorded idle prompts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EMPTY_AWAY_RECORD, type AwayRecord } from '@bmn/protocol'
import { AWAY_WAKE_LINE, AwayWake, idlePrompt, testAwayWakeTimes, type WakeAttention, type WakeObservation, type WakeScreen } from './away-wake'
import { ScreenMirror } from './screen-mirror'

const T = Date.parse('2026-10-23T22:00:00.000Z')
const HOUR = 60 * 60 * 1000
const at = (ms: number): string => new Date(ms).toISOString()
const RULE = '─'.repeat(60)
/** Shapes recorded from real sessions on 2026-10-23 (Claude Code 2.1.309, Codex 0.164.0), dim placeholders blanked. */
const CLAUDE_IDLE = ['● ok', '✻ Brewed for 3s', RULE, '❯ ', RULE, '  Opus 5.5 high ┃ ~/scratch']
const CODEX_IDLE = ['› Reply with the single word ok.', '• ok', '', '›', '', '  GPT-6.1-Sol xhigh · ~/scratch', '  ? for shortcuts']
/** OpenCode 2's empty composer as recorded on 2.0.29 and 2.0.32 (Story 93.1), with its cursor on the content row's first cell. */
const OPENCODE_IDLE = ['   Synthetic root         +', '', '  ┃', '  ┃', '  ┃', '  ┃  Build · Synthetic Synthetic loopback', `  ╹${'▀'.repeat(60)}`, '  ~/work:master  ctrl+p commands']
const OPENCODE_CURSOR = { x: 5, y: 3 }

interface Session { seen: WakeObservation; screen: string[] | null; cursor: { x: number; y: number }; front: string | null; live: string; generation: number; pending: number }

function world(now0 = T + 2 * HOUR) {
  let now = now0
  let away: AwayRecord = { ...EMPTY_AWAY_RECORD, state: 'away', revision: 3, periodId: 'p1', since: at(T) }
  const sessions = new Map<string, Session>()
  let attention: WakeAttention[] = []
  const written: Array<{ sessionId: string; text: string }> = []
  const logs: string[] = []
  let beforeScreen: (() => void) | undefined
  const add = (sessionId: string, agent: string, extra: Partial<Session> & { event?: string; observedAt?: string; source?: string | null } = {}): void => {
    const { event, observedAt, source, ...rest } = extra
    sessions.set(sessionId, {
      seen: { sessionId, incarnationId: `inc-${sessionId}`, agent, event: event ?? (agent === 'opencode' ? 'session.idle' : 'Stop'), source: source ?? null,
        observedAt: observedAt ?? at(T + HOUR), foreground: `fg-${sessionId}` },
      screen: agent === 'codex' ? CODEX_IDLE : agent === 'opencode' ? OPENCODE_IDLE : CLAUDE_IDLE,
      cursor: agent === 'opencode' ? OPENCODE_CURSOR : { x: 0, y: 0 }, front: `fg-${sessionId}`, live: `inc-${sessionId}`, generation: 1, pending: 0, ...rest
    })
    attention.push({ sessionId, requestKey: `${agent}:turn`, kind: 'notice', state: 'open', openedAt: at(T + HOUR) })
  }
  const make = (): AwayWake => new AwayWake({
    now: () => new Date(now),
    away: () => away,
    observations: () => [...sessions.values()].map((session) => session.seen),
    observation: (id) => sessions.get(id)?.seen,
    openAttention: async () => attention,
    liveIncarnation: (id) => sessions.get(id)?.live,
    foreground: (id) => sessions.get(id)?.front ?? null,
    generation: (id) => ({ generation: sessions.get(id)?.generation ?? 0, pending: sessions.get(id)?.pending ?? 0 }),
    screen: async (id): Promise<WakeScreen | null> => {
      await Promise.resolve(); beforeScreen?.()
      const session = sessions.get(id)
      return session?.screen ? { lines: session.screen, cursor: session.cursor } : null
    },
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

/** Story 93.1's recordings: each pinned version's composer capture and the provenance capture's events and hook bodies. */
interface OpenCodeRecordings {
  versions: Record<string, { chunks: number[]; states: Array<{ name: string; bytes: number }> }>
  provenance: Record<string, { events: Array<{ type: string; data: Record<string, unknown> }>; hooks: Array<{ pinned: string; body: Record<string, unknown> }> }>
}
const RECORDED = JSON.parse(readFileSync(new URL('./test-fixtures/away-wake/opencode-states.json', import.meta.url), 'utf8')) as OpenCodeRecordings
/** The states 93.1 recorded that are OpenCode's empty prompt (any agent label); every other state must be refused. */
const RECORDED_IDLE = ['root-initial', 'root-return', 'root-after-child', 'draft-cleared', 'multiline-cleared', 'spaces-cleared',
  'palette-cleared', 'dialog-cleared', 'paste-cleared', 'agent-cycle', 'agent-restored']
const RECORDED_REFUSED = ['home', 'same-title-child', 'typed-draft', 'blank-first-multiline', 'leading-spaces', 'command-palette',
  'agent-dialog', 'bracketed-paste']

/** Each recorded state's screen, read the way the service reads it: the raw output fed to the product mirror in its recorded chunks. */
async function recordedScreens(version: string): Promise<Map<string, WakeScreen>> {
  const raw = readFileSync(new URL(`./test-fixtures/away-wake/opencode-${version}.raw`, import.meta.url))
  const { chunks, states } = RECORDED.versions[version]!
  const mirror = new ScreenMirror(120, 40)
  const screens = new Map<string, WakeScreen>()
  let offset = 0
  let chunk = 0
  for (const state of states) {
    while (offset < state.bytes) {
      const length = chunks[chunk++]!
      mirror.write(new Uint8Array(raw.subarray(offset, offset + length)))
      offset += length
    }
    expect(offset, state.name).toBe(state.bytes)
    await mirror.settled()
    screens.set(state.name, { lines: mirror.undimmedLines(), cursor: mirror.cursor() })
  }
  mirror.dispose()
  return screens
}

describe('the Away wake-up for OpenCode (Story 93.3)', () => {
  it.each(['2.0.29', '2.0.32'])('replays every state recorded on OpenCode %s: the empty prompt under any agent is idle, nothing else is', async (version) => {
    const screens = await recordedScreens(version)
    expect([...screens.keys()].sort()).toEqual([...RECORDED_IDLE, ...RECORDED_REFUSED].sort())
    for (const name of RECORDED_IDLE) expect(idlePrompt('opencode', screens.get(name)!.lines, screens.get(name)!.cursor), name).toBe(true)
    for (const name of RECORDED_REFUSED) expect(idlePrompt('opencode', screens.get(name)!.lines, screens.get(name)!.cursor), name).toBe(false)
  })

  it.each(['2.0.29', '2.0.32'])('sweeps each state recorded on OpenCode %s: one exact line at an empty prompt, nothing at any other', async (version) => {
    for (const [name, screen] of await recordedScreens(version)) {
      const w = world(T)
      w.add('s', 'opencode', { screen: screen.lines, cursor: screen.cursor })
      const wake = w.make()
      await wake.sweep()
      w.now = T + 2 * HOUR
      await wake.sweep()
      expect(w.written, name).toEqual(RECORDED_IDLE.includes(name) ? [{ sessionId: 's', text: AWAY_WAKE_LINE }] : [])
      if (!RECORDED_IDLE.includes(name)) expect(w.logs.at(-1), name).toContain('its prompt is not empty and idle')
    }
  })

  it('needs the cursor: a dialog leaves the empty composer drawn but holds the cursor in its own field', () => {
    expect(idlePrompt('opencode', OPENCODE_IDLE, OPENCODE_CURSOR)).toBe(true)
    expect(idlePrompt('opencode', OPENCODE_IDLE)).toBe(false)
    expect(idlePrompt('opencode', OPENCODE_IDLE, { x: 34, y: 13 })).toBe(false)
    expect(idlePrompt('opencode', OPENCODE_IDLE, { x: 5, y: 4 })).toBe(false)
  })

  it('refuses a composer it cannot read as one empty row (synthetic shapes, not recorded ones)', () => {
    const variant = (index: number, line: string): string[] => OPENCODE_IDLE.map((row, at) => at === index ? line : row)
    const rule = `  ╹${'▀'.repeat(60)}`
    const cases: Array<[string, string[], { x: number; y: number }]> = [
      ['text in the row', variant(3, '  ┃  half a sentence'), OPENCODE_CURSOR],
      ['a second content row', ['', '  ┃', '  ┃', '  ┃', '  ┃', '  ┃  Build · Synthetic', rule], { x: 5, y: 2 }],
      ['one row too few', ['', '', '  ┃', '  ┃', '  ┃  Build · Synthetic', rule], { x: 5, y: 3 }],
      ['no rule under the name', variant(6, ''), OPENCODE_CURSOR],
      ['no agent and model on the name row', variant(5, '  ┃  Build'), OPENCODE_CURSOR],
      ['two composers', [...OPENCODE_IDLE.slice(0, 7), ...OPENCODE_IDLE.slice(2, 7)], OPENCODE_CURSOR],
      ['nothing on screen', [], { x: 0, y: 0 }]
    ]
    for (const [name, lines, cursor] of cases) expect(idlePrompt('opencode', lines, cursor), name).toBe(false)
  })

  it('wakes a root whose own run finished, never one whose latest event is a child\'s or the owner\'s interrupt', async () => {
    const w = world(T)
    w.add('root', 'opencode')
    w.add('child', 'opencode', { source: 'subagent' })
    w.add('stopped', 'opencode', { source: 'interrupted' })
    w.add('busy', 'opencode', { event: 'session.status' })
    w.add('switched', 'opencode', { event: 'tui.session.select' })
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR; await wake.sweep()
    expect(w.written).toEqual([{ sessionId: 'root', text: AWAY_WAKE_LINE }])
    const reasons = Object.fromEntries(w.logs.map((line) => [line.match(/skipped (\S+)/u)?.[1], line.split('): ')[1]]))
    expect(reasons).toMatchObject({
      child: 'its latest event is session.idle from subagent, not its own finished turn',
      stopped: 'its latest event is session.idle from interrupted, not its own finished turn',
      busy: 'its latest event is session.status, not a finished turn',
      switched: 'its latest event is tui.session.select, not a finished turn'
    })
  })

  it.each(['subagent', 'interrupted'])('types nothing when the root\'s latest idle turns out to be from %s while the screen is read', async (source) => {
    const w = world(T)
    w.add('s', 'opencode')
    const wake = w.make()
    await wake.sweep()
    w.now = T + 2 * HOUR
    w.beforeScreen = () => { const session = w.sessions.get('s')!; session.seen = { ...session.seen, source } }
    await wake.sweep()
    expect(w.written).toEqual([])
    expect(w.logs.at(-1)).toContain('its agent reported again')
  })

  it.each(['2.0.29', '2.0.32'])('replays OpenCode %s\'s recorded turns: a finished root wakes; a later child run or the owner\'s interrupt does not, nor child traffic after it', async (version) => {
    // The plugin's hook bodies as 93.1 recorded them, as the host keeps each: the child's carry `subagent` (the hook runtime
    // marks every event of a session other than the pinned root), and the interrupt the plugin now marks `interrupted`.
    const { hooks, events } = RECORDED.provenance[version]!
    expect(events.find((event) => event.type === 'session.execution.interrupted')?.data).toMatchObject({ sessionID: 'ses_root', reason: 'user' })
    const observed = hooks.map((hook, index) => ({ event: String(hook.body.hook_event_name), source: hook.body.sessionID === hook.pinned ? null : 'subagent', index }))
    const lastRootIdle = observed.filter((item) => item.event === 'session.idle' && item.source === null).at(-1)!.index
    const sweepAfter = async (seen: { event: string; source: string | null }): Promise<number> => {
      const w = world(T)
      w.add('s', 'opencode', seen)
      const wake = w.make()
      await wake.sweep()
      w.now = T + 2 * HOUR; await wake.sweep()
      return w.written.length
    }
    // The root's second turn (the paste) finished by itself: woken.
    const rootTurns = observed.filter((item) => item.event === 'session.idle' && item.source === null)
    expect(rootTurns.length).toBe(3)
    expect(await sweepAfter(rootTurns[1]!)).toBe(1)
    // Then a child of it ran and finished: its idle is the latest event, so the root is not woken.
    const childIdle = observed.find((item) => item.event === 'session.idle' && item.source === 'subagent')!
    expect(childIdle.index).toBeGreaterThan(rootTurns[1]!.index)
    expect(await sweepAfter(childIdle)).toBe(0)
    // The last root idle is the owner's interrupt, which the plugin now reports as such.
    expect(lastRootIdle).toBe(rootTurns[2]!.index)
    expect(await sweepAfter({ event: 'session.idle', source: 'interrupted' })).toBe(0)
    expect(await sweepAfter({ event: 'session.status', source: 'subagent' })).toBe(0)
  })
})
