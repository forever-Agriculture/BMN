// MODULE: away-night.ts - Story 113.6: what the Away wake decided each tick, kept text-free, and the night's account read from it
/**
 * Why the Away wake left a session alone on one tick, as a closed code (113.6 AC1: no prompt or screen text is kept).
 * `early` codes are the checks before BMN reads the screen; `last` codes are the final checks right before the one write.
 * `missed` says the session had passed every early check and BMN itself could not finish the proof: the owner should look.
 */
export const AWAY_WAKE_REASONS = Object.freeze({
  'no-event-since-away': { stage: 'early', missed: false, words: 'no hook event since the owner left' },
  'app-not-woken': { stage: 'early', missed: false, words: 'its app is not woken (no recorded idle prompt)' },
  'not-finished-turn': { stage: 'early', missed: false, words: 'its latest event is not a finished turn' },
  'child-or-stop': { stage: 'early', missed: false, words: 'its latest event came from a child or from the owner\'s stop' },
  'plugin-earlier': { stage: 'early', missed: false, words: 'its OpenCode runs an earlier BMN plugin' },
  'finish-unknown': { stage: 'early', missed: false, words: 'BMN did not see this run finish a turn' },
  quiet: { stage: 'early', missed: false, words: 'its turn finished less than 15 minutes before' },
  'request-open': { stage: 'early', missed: false, words: 'its own question or permission was open' },
  'owner-back': { stage: 'early', missed: false, words: 'the owner was no longer away' },
  'run-changed': { stage: 'last', missed: false, words: 'its run changed' },
  'reported-again': { stage: 'last', missed: false, words: 'its agent reported again' },
  'requests-changed': { stage: 'last', missed: false, words: 'its requests changed' },
  'not-foreground': { stage: 'last', missed: true, words: 'its agent was not in the foreground' },
  'no-screen': { stage: 'last', missed: true, words: 'BMN had no screen to read' },
  'prompt-busy': { stage: 'last', missed: true, words: 'its prompt was not empty and idle' },
  unreadable: { stage: 'last', missed: true, words: 'BMN could not read its state' },
  other: { stage: 'last', missed: true, words: 'a reason this BMN does not name' }
} as const)

export type AwayWakeReason = keyof typeof AWAY_WAKE_REASONS
export const AWAY_WAKE_REASON_CODES = Object.freeze(Object.keys(AWAY_WAKE_REASONS) as AwayWakeReason[])

/** The skip text away-wake.ts returns, mapped to its code; a text it does not know is `other`, never dropped. */
export function awayWakeReasonCode(reason: string): AwayWakeReason {
  if (reason === 'no hook event since the owner left') return 'no-event-since-away'
  if (/ sessions are not woken /u.test(reason)) return 'app-not-woken'
  if (/^its latest event is .* from (?:subagent|interrupted), /u.test(reason)) return 'child-or-stop'
  if (/^its latest event is .*, not a finished turn$/u.test(reason)) return 'not-finished-turn'
  if (/earlier BMN plugin/u.test(reason)) return 'plugin-earlier'
  if (reason === 'BMN did not see this run finish a turn' || reason === 'no open finished-turn notice') return 'finish-unknown'
  if (/^its turn finished less than /u.test(reason)) return 'quiet'
  if (reason === 'another request of it is open') return 'request-open'
  if (reason === 'the owner is no longer away in this period') return 'owner-back'
  if (reason === 'its run changed') return 'run-changed'
  if (reason === 'its agent reported again') return 'reported-again'
  if (reason === 'its requests changed') return 'requests-changed'
  if (reason === 'its agent is not in the foreground') return 'not-foreground'
  if (reason === 'no screen to read') return 'no-screen'
  if (reason === 'its prompt is not empty and idle') return 'prompt-busy'
  if (reason === 'unreadable state') return 'unreadable'
  return 'other'
}

/** The bounds of the kept facts, like hook history's: newest rows per period and per session in a period. */
export const AWAY_WAKE_LIMITS = Object.freeze({ perPeriod: 1024, perSession: 30, periods: 30 })

/** One session's facts on one tick (113.6 AC1). `prompt` is null when BMN never reached the screen. */
export interface AwayWakeDecision {
  sessionId: string
  incarnationId: string
  app: string
  /** Whether the session's agent was the foreground program at the last check; null before that check. */
  foreground: boolean | null
  /** The session's request generation BMN held when it chose the session. */
  generation: number | null
  prompt: 'idle' | 'busy' | 'none' | null
  outcome: 'typed' | 'skipped'
  /** Null when typed. */
  reason: AwayWakeReason | null
}

/** One tick this BMN process swept; a tick with no row was never looked at (113.6 AC3). */
export interface AwayWakeTick {
  periodId: string
  tick: number
  at: string
  /** When the BMN process that swept it started: a different value from the tick before is a restart. */
  processStartedAt: string
  /** `unreadable`: the open requests could not be read, so no session was decided on that tick. */
  state: 'swept' | 'unreadable'
  sessionsSeen: number
}

export interface AwayWakeDecisionRow extends AwayWakeDecision {
  periodId: string
  tick: number
  at: string
}

export interface AwayNightSession {
  sessionId: string
  app: string | null
  /** For woken, when; for skipped and missed, the reason that decides it. */
  reason: AwayWakeReason | null
  at: string | null
}

/** The account of one Away period (113.6 AC2–AC3). */
export interface AwayNight {
  periodId: string
  since: string
  until: string
  everyMs: number
  woken: AwayNightSession[]
  skipped: AwayNightSession[]
  missed: AwayNightSession[]
  /** Agent sessions running in the period that no tick decided. */
  unknown: AwayNightSession[]
  /** Spans with no swept tick, merged, with why: BMN not running or just restarted, requests unreadable, or no record. */
  unknownSpans: Array<{ from: string; to: string; why: 'restart' | 'unreadable' | 'not-recorded' }>
  /** Ticks in the period, and how many of them a BMN process swept. */
  ticks: { expected: number; swept: number }
  /** False when rows were dropped by the bounds, so a session may read unknown that was decided. */
  complete: boolean
}

/**
 * The night from its kept ticks and decisions. A session is woken once any tick typed into it; missed while eligible
 * when it passed every early check on some tick and BMN could not finish the proof (a `missed` code) and it was never
 * woken; correctly skipped otherwise, by its last tick's reason; unknown with no decision. Ticks with no swept row
 * (BMN not running, the first tick after a start, which is never acted on, or requests unreadable) are unknown
 * spans: they never count as woken or missed (AC3).
 */
export function awayNightAccount(input: {
  periodId: string
  since: string
  until: string
  everyMs: number
  ticks: readonly AwayWakeTick[]
  decisions: readonly AwayWakeDecisionRow[]
  /** Agent sessions BMN ran in the period, with their app when known. */
  sessions: ReadonlyArray<{ sessionId: string; app: string | null }>
  complete?: boolean
}): AwayNight {
  const since = Date.parse(input.since)
  // Tick k runs at since + k × every while he is still away, so only ticks strictly before the period's end count.
  const expected = Math.max(0, Math.ceil((Date.parse(input.until) - since) / input.everyMs) - 1)
  const byTick = new Map(input.ticks.filter((tick) => tick.periodId === input.periodId && tick.tick >= 1 && tick.tick <= expected)
    .map((tick) => [tick.tick, tick]))
  const unknownSpans: AwayNight['unknownSpans'] = []
  const at = (tick: number): string => new Date(since + tick * input.everyMs).toISOString()
  let previous: AwayWakeTick | undefined
  for (let tick = 1; tick <= expected; tick++) {
    const row = byTick.get(tick)
    if (row?.state === 'swept') { previous = row; continue }
    const next = [...byTick.values()].filter((item) => item.tick > tick).sort((a, b) => a.tick - b.tick)[0]
    const why = row?.state === 'unreadable' ? 'unreadable'
      : next !== undefined && (previous === undefined || next.processStartedAt !== previous.processStartedAt) ? 'restart' : 'not-recorded'
    const last = unknownSpans.at(-1)
    if (last && last.to === at(tick) && last.why === why) last.to = at(tick + 1) > input.until ? input.until : at(tick + 1)
    else unknownSpans.push({ from: at(tick), to: at(tick + 1) > input.until ? input.until : at(tick + 1), why })
  }
  const decisions = input.decisions.filter((row) => row.periodId === input.periodId)
    .slice().sort((a, b) => a.tick - b.tick || a.at.localeCompare(b.at))
  const bySession = new Map<string, AwayWakeDecisionRow[]>()
  for (const row of decisions) bySession.set(row.sessionId, [...(bySession.get(row.sessionId) ?? []), row])
  const night: AwayNight = {
    periodId: input.periodId, since: input.since, until: input.until, everyMs: input.everyMs,
    woken: [], skipped: [], missed: [], unknown: [], unknownSpans,
    ticks: { expected, swept: [...byTick.values()].filter((tick) => tick.state === 'swept').length },
    complete: input.complete ?? true
  }
  for (const [sessionId, rows] of bySession) {
    const app = rows.at(-1)!.app
    const typed = rows.filter((row) => row.outcome === 'typed')
    if (typed.length > 0) { night.woken.push({ sessionId, app, reason: null, at: typed.at(-1)!.at }); continue }
    const missed = rows.filter((row) => row.reason !== null && AWAY_WAKE_REASONS[row.reason].missed)
    if (missed.length > 0) { night.missed.push({ sessionId, app, reason: missed.at(-1)!.reason, at: missed.at(-1)!.at }); continue }
    night.skipped.push({ sessionId, app, reason: rows.at(-1)!.reason, at: rows.at(-1)!.at })
  }
  for (const session of input.sessions) {
    if (!bySession.has(session.sessionId)) night.unknown.push({ sessionId: session.sessionId, app: session.app, reason: null, at: null })
  }
  return night
}

/** The account as plain lines for `bmn away --night` and the dialog: one line per session, names when known. */
export function awayNightLines(night: AwayNight, names: Readonly<Record<string, string>> = {}): string[] {
  const name = (session: AwayNightSession): string => `${names[session.sessionId] ?? session.sessionId}${session.app ? ` (${session.app})` : ''}`
  const hours = (from: string, to: string): string => `${from.slice(11, 16)}–${to.slice(11, 16)} UTC`
  const WHY = { restart: 'BMN was not running or had just started', unreadable: 'BMN could not read the open requests', 'not-recorded': 'BMN swept no tick (the computer asleep, or no record)' }
  const lines = [`The wake: ${night.ticks.swept} of ${night.ticks.expected} ticks swept, from ${night.since} to ${night.until}`]
  for (const session of night.woken) lines.push(`woken: ${name(session)} at ${session.at}`)
  for (const session of night.missed) lines.push(`missed while eligible: ${name(session)}: ${AWAY_WAKE_REASONS[session.reason ?? 'other'].words}`)
  for (const session of night.skipped) lines.push(`skipped: ${name(session)}: ${AWAY_WAKE_REASONS[session.reason ?? 'other'].words}`)
  for (const session of night.unknown) lines.push(`unknown: ${name(session)}: no tick decided it`)
  for (const span of night.unknownSpans) lines.push(`unknown hours: ${hours(span.from, span.to)}: ${WHY[span.why]}`)
  if (!night.complete) lines.push('Some older rows were no longer kept, so a session may read unknown.')
  if (lines.length === 1) lines.push('No agent session ran in this period.')
  return lines
}
