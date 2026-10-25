// MODULE: away-wake.ts - Stories 90.6 and 93.3: while the owner is Away, one fixed line every 2 hours into each agent session that is provably idle at an empty prompt
import type { AwayRecord } from '@bmn/protocol'

export const AWAY_WAKE_EVERY_MS = 2 * 60 * 60 * 1000
/** A finished turn must have waited this long, so a session that just paused for a moment is left alone. */
export const AWAY_WAKE_QUIET_MS = 15 * 60 * 1000
/** The one line BMN ever types (R90-FR6, 90.6 AC5). It is never an approval, an answer or a resume of a stopped run. */
export const AWAY_WAKE_LINE = 'BMN wake-up (the owner is away; every 2 hours): if your work is unfinished and still allowed, continue it from your handoff; otherwise stop. This is not the owner: it grants nothing and lifts no stop.'

type WakeApp = 'claude' | 'codex' | 'opencode'

/** The latest hook event a session's current run reported, as the companion service keeps it. */
export interface WakeObservation {
  sessionId: string
  incarnationId: string
  agent: string
  event: string
  /** Who the event speaks for when not the session itself: an OpenCode child's `subagent`, the owner's `interrupted` stop (Story 93.3). */
  source: string | null
  observedAt: string
  foreground: string | null
}

/** The settled mirror's rows with dim cells blanked, and its cursor, read together. */
export interface WakeScreen {
  lines: string[]
  cursor: { x: number; y: number }
}

export interface WakeAttention {
  sessionId: string
  requestKey: string
  kind: string
  state: string
  openedAt: string
}

export interface AwayWakeOptions {
  now(): Date
  /** The said-away record as the service holds it now; read again right before the write. */
  away(): AwayRecord
  observations(): Iterable<WakeObservation>
  /** The session's latest hook observation now, read again right before the write. */
  observation(sessionId: string): WakeObservation | undefined
  openAttention(): Promise<readonly WakeAttention[]>
  liveIncarnation(sessionId: string): string | null | undefined
  foreground(sessionId: string): string | null
  generation(sessionId: string): { generation: number; pending: number }
  /** The session's screen with dim cells blanked, once every byte so far is drawn; null when there is no mirror. */
  screen(sessionId: string, incarnationId: string): Promise<WakeScreen | null>
  write(sessionId: string, text: string): void
  log(line: string): void
  everyMs?: number
  quietMs?: number
}

/**
 * Which agents report a finished turn with which hook events (Claude's idle_prompt Notification repeats its Stop;
 * BMN's OpenCode plugin reports a root run that succeeded, or that the owner stopped, as `session.idle`).
 */
const FINISHED: Record<WakeApp, readonly string[]> = { claude: ['Stop', 'Notification'], codex: ['Stop'], opencode: ['session.idle'] }
const isWakeApp = (agent: string): agent is WakeApp => agent === 'claude' || agent === 'codex' || agent === 'opencode'

/**
 * The app's empty prompt, recorded from real sessions on 2026-10-23 (plan/references/090, evidence 90.6/screens):
 * Claude Code's input line starts with `❯` directly between two rules. Codex's is its last line starting with `›`,
 * followed by exactly one blank line, one block of footer lines and only blank lines to the end of the screen: a
 * draft's further lines, even after blank ones, would make a second block. Empty means nothing after the marker once
 * dim placeholder text is blanked; anything else (a draft, a dialog's options, an unknown screen) is not idle.
 *
 * OpenCode 2's, recorded from pinned 2.0.29 and 2.0.32 on 2026-10-25 (Story 93.1, plan/references/093): its composer is
 * one block of `  ┃` rows whose last names the agent and model (`  ┃  Build · …`) above a `  ╹▀▀…` rule. Empty means
 * the block's top row, one blank content row and one blank row above the name, with the cursor on the content row's
 * first cell. An open dialog leaves that block drawn but holds the cursor in its own field, so OpenCode needs the cursor;
 * a draft, a paste's `[Pasted ~N lines]` or a second line fills or grows the block, and Home or a child view draws none.
 */
export function idlePrompt(app: WakeApp, lines: readonly string[], cursor?: { x: number; y: number }): boolean {
  const rule = (line: string | undefined): boolean => line !== undefined && /^─{10,}\s*$/u.test(line)
  const empty = (line: string, marker: string): boolean => line.slice(line.indexOf(marker) + marker.length).replace(/\s/gu, '') === ''
  if (app === 'claude') {
    const inputs = lines.flatMap((line, index) => line.startsWith('❯') && rule(lines[index - 1]) && rule(lines[index + 1]) ? [line] : [])
    return inputs.length === 1 && empty(inputs[0]!, '❯')
  }
  if (app === 'opencode') {
    const names = lines.flatMap((line, index) => /^ {2}┃ {2}\S.* · /u.test(line) && /^ {2}╹▀{10,}/u.test(lines[index + 1] ?? '') ? [index] : [])
    if (cursor === undefined || names.length !== 1) return false
    const name = names[0]!
    let top = name
    while (top > 0 && lines[top - 1]!.startsWith('  ┃')) top -= 1
    return name - top === 3 && lines.slice(top, name).every((line) => /^ {2}┃\s*$/u.test(line)) && cursor.x === 5 && cursor.y === top + 1
  }
  let index = lines.length - 1
  while (index >= 0 && !lines[index]!.startsWith('›')) index -= 1
  if (index < 0 || !empty(lines[index]!, '›')) return false
  const blank = (line: string): boolean => line.trim() === ''
  const rest = lines.slice(index + 1)
  let end = rest.length
  while (end > 0 && blank(rest[end - 1]!)) end -= 1
  const footer = rest.slice(1, end)
  return rest.length > 0 && blank(rest[0]!) && footer.length > 0 && !footer.some(blank)
}

export class AwayWake {
  /** The tick each Away period stood at when this process first saw it: missed times are never made up (AC4). */
  private readonly firstTick = new Map<string, number>()
  /** `period␀session` → the last tick claimed, taken before any await so overlapping sweeps type nothing twice. */
  private readonly claimed = new Map<string, number>()

  constructor(private readonly options: AwayWakeOptions) {}

  async sweep(): Promise<void> {
    const record = this.options.away()
    if (record.state !== 'away' || record.periodId === null || record.since === null) return
    const since = Date.parse(record.since)
    if (!Number.isFinite(since)) return
    const period = record.periodId
    const tick = Math.floor((this.options.now().getTime() - since) / (this.options.everyMs ?? AWAY_WAKE_EVERY_MS))
    if (!this.firstTick.has(period)) {
      this.firstTick.clear()
      this.claimed.clear()
      this.firstTick.set(period, Math.max(tick, 0))
    }
    if (tick <= this.firstTick.get(period)!) return
    const candidates: Array<{ seen: WakeObservation; generation: number }> = []
    for (const seen of this.options.observations()) {
      const key = `${period}\0${seen.sessionId}`
      if ((this.claimed.get(key) ?? 0) >= tick) continue
      this.claimed.set(key, tick)
      candidates.push({ seen: { ...seen }, generation: this.options.generation(seen.sessionId).generation })
    }
    if (candidates.length === 0) return
    let open: readonly WakeAttention[]
    try { open = await this.options.openAttention() } catch {
      this.options.log(`away wake: tick ${tick} of ${period} skipped: open requests unreadable`)
      return
    }
    for (const candidate of candidates) {
      const reason = await this.wake(candidate.seen, candidate.generation, open, period, since).catch(() => 'unreadable state')
      this.options.log(reason === null
        ? `away wake: typed the wake line into ${candidate.seen.sessionId} (period ${period}, tick ${tick})`
        : `away wake: skipped ${candidate.seen.sessionId} (period ${period}, tick ${tick}): ${reason}`)
    }
  }

  /** Null once the line was typed; otherwise why this session was left alone for this tick. */
  private async wake(seen: WakeObservation, generation: number, open: readonly WakeAttention[], period: string, since: number): Promise<string | null> {
    const app = seen.agent
    if (!isWakeApp(app)) return `${app} sessions are not woken (no recorded idle prompt)`
    if (!FINISHED[app].includes(seen.event)) return `its latest event is ${seen.event}, not a finished turn`
    // A child's turn is not the session's, and a stop the owner made stays a stop (R93-FR2).
    if (seen.source === 'subagent' || seen.source === 'interrupted') return `its latest event is ${seen.event} from ${seen.source}, not its own finished turn`
    if (Date.parse(seen.observedAt) <= since) return 'no hook event since the owner left'
    const mine = open.filter((row) => row.sessionId === seen.sessionId && row.state === 'open')
    const turn = mine.find((row) => row.kind === 'notice' && row.requestKey === `${app}:turn`)
    if (!turn) return 'no open finished-turn notice'
    if (this.options.now().getTime() - Date.parse(turn.openedAt) < (this.options.quietMs ?? AWAY_WAKE_QUIET_MS)) return 'its turn finished less than 15 minutes ago'
    if (mine.length !== 1) return 'another request of it is open'
    const screen = await this.options.screen(seen.sessionId, seen.incarnationId)
    // The last checks run together, synchronously, right before the one write.
    const now = this.options.away()
    if (now.state !== 'away' || now.periodId !== period) return 'the owner is no longer away in this period'
    if (this.options.liveIncarnation(seen.sessionId) !== seen.incarnationId) return 'its run changed'
    const latest = this.options.observation(seen.sessionId)
    if (!latest || latest.agent !== seen.agent || latest.event !== seen.event || latest.source !== seen.source ||
      latest.observedAt !== seen.observedAt) return 'its agent reported again'
    const front = this.options.foreground(seen.sessionId)
    if (front === null || seen.foreground === null || front !== seen.foreground) return 'its agent is not in the foreground'
    const changes = this.options.generation(seen.sessionId)
    if (changes.generation !== generation || changes.pending > 0) return 'its requests changed'
    if (screen === null) return 'no screen to read'
    if (!idlePrompt(app, screen.lines, screen.cursor)) return 'its prompt is not empty and idle'
    this.options.write(seen.sessionId, AWAY_WAKE_LINE)
    return null
  }
}

/** The test-only interval and quiet time (90.6 Verification), honoured only in a test-mode host. */
export function testAwayWakeTimes(argv: readonly string[], env: NodeJS.ProcessEnv): { everyMs?: number; quietMs?: number } {
  if (!argv.includes('--bmn-test-host')) return {}
  const read = (value: string | undefined): number | undefined => {
    const number = Number(value)
    return value !== undefined && Number.isSafeInteger(number) && number >= 1000 ? number : undefined
  }
  const everyMs = read(env.BMN_TEST_AWAY_WAKE_EVERY_MS)
  const quietMs = read(env.BMN_TEST_AWAY_WAKE_QUIET_MS)
  return { ...(everyMs === undefined ? {} : { everyMs }), ...(quietMs === undefined ? {} : { quietMs }) }
}
