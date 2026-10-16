// MODULE: away.ts - the owner's said away state: one versioned record, its one change rule and what each caller may see (Story 76.3)

/** Who said it: the owner in the app, the owner's CLI token, an agent on his words, or Telegram. */
export type AwaySource = 'app' | 'cli' | 'agent' | 'telegram'
export const AWAY_SOURCES: readonly AwaySource[] = Object.freeze(['app', 'cli', 'agent', 'telegram'])
/** `none`: he has never said either, and BMN goes by the measured desk input alone, as before Epic 76. */
export type AwayState = 'none' | 'away' | 'back'

/** The longest note; longer input is refused, never cut (R76-NFR3). */
export const AWAY_NOTE_LIMIT = 200
/** Operation keys remembered, so a retried operation returns its first result instead of changing the record again. */
export const AWAY_OPERATIONS_KEPT = 100
/** The raw setting that holds the record (R76-NFR4: no new table). */
export const AWAY_RECORD_KEY = 'owner-away-v1'

export interface AwayRecord {
  version: 1
  state: AwayState
  /** Grows by one with every change; an agent names the one it saw. */
  revision: number
  /** The away period: set when he leaves, kept after back until the next away. */
  periodId: string | null
  since: string | null
  endedAt: string | null
  /** Who started the period and who ended it. */
  source: AwaySource | null
  endedBy: AwaySource | null
  /** The agent's session when an agent said it on his words. */
  agentSessionId: string | null
  /** His own words, for his eyes only. */
  note: string | null
  /** When the summary of the closed period was first shown; null until then. */
  summaryShownAt: string | null
  /** Recent operation keys and the revision each produced. */
  operations: Array<{ key: string; revision: number }>
}

export const EMPTY_AWAY_RECORD: AwayRecord = Object.freeze({
  version: 1, state: 'none', revision: 0, periodId: null, since: null, endedAt: null, source: null, endedBy: null,
  agentSessionId: null, note: null, summaryShownAt: null, operations: []
}) as AwayRecord

export interface AwayChange {
  to: 'away' | 'back'
  source: AwaySource
  /** The session of the agent that said it; required when source is 'agent'. */
  agentSessionId?: string | null
  /** Only with `away`: replaces the period's note. */
  note?: string | null
  /** The revision the caller saw; an agent always names it. A different current revision refuses the change. */
  expectedRevision?: number
  /** A retry of the same operation returns the first result. */
  operationKey?: string
  periodId: string
}

export type AwayChangeResult =
  | { outcome: 'changed'; record: AwayRecord }
  | { outcome: 'unchanged'; record: AwayRecord }
  | { outcome: 'repeated'; record: AwayRecord }
  | { outcome: 'stale'; record: AwayRecord }
  | { outcome: 'invalid'; record: AwayRecord; reason: string }

const isText = (value: unknown): value is string => typeof value === 'string'
const isIso = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value))
const orNull = <T>(value: unknown, test: (value: unknown) => value is T): T | null => test(value) ? value : null
const isSource = (value: unknown): value is AwaySource => AWAY_SOURCES.includes(value as AwaySource)

/** A note as stored: plain text of at most AWAY_NOTE_LIMIT characters, controls refused; null clears. */
export function awayNoteProblem(note: unknown): string | null {
  if (note === null || note === undefined) return null
  if (!isText(note)) return 'The note must be text'
  if ([...note].length > AWAY_NOTE_LIMIT) return `The note is longer than ${AWAY_NOTE_LIMIT} characters; nothing was changed`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(note)) return 'The note may not hold control or direction characters'
  return null
}

/**
 * The stored value read back: anything unreadable, of another version or inconsistent is the empty record, so a damaged
 * value makes BMN go by the desk input as before, never by a half-read state.
 */
export function parseAwayRecord(value: unknown): AwayRecord {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_AWAY_RECORD, operations: [] }
  const row = value as Record<string, unknown>
  const state = row.state
  if (row.version !== 1 || (state !== 'none' && state !== 'away' && state !== 'back')) return { ...EMPTY_AWAY_RECORD, operations: [] }
  const revision = Number.isSafeInteger(row.revision) && (row.revision as number) >= 0 ? row.revision as number : 0
  const since = orNull(row.since, isIso)
  const periodId = orNull(row.periodId, isText)
  if (state !== 'none' && (since === null || periodId === null)) return { ...EMPTY_AWAY_RECORD, revision, operations: [] }
  const note = isText(row.note) && awayNoteProblem(row.note) === null ? row.note : null
  const operations = Array.isArray(row.operations)
    ? row.operations.filter((item): item is { key: string; revision: number } => typeof item === 'object' && item !== null &&
      isText((item as { key: unknown }).key) && Number.isSafeInteger((item as { revision: unknown }).revision)).slice(-AWAY_OPERATIONS_KEPT)
    : []
  return {
    version: 1, state, revision, periodId, since,
    endedAt: state === 'back' ? orNull(row.endedAt, isIso) : null,
    source: orNull(row.source, isSource), endedBy: state === 'back' ? orNull(row.endedBy, isSource) : null,
    agentSessionId: orNull(row.agentSessionId, isText), note, summaryShownAt: state === 'back' ? orNull(row.summaryShownAt, isIso) : null,
    operations
  }
}

/**
 * The one change rule (Story 76.3 AC1). A repeated away keeps the period's since and note unless a note is given; a repeated
 * back, or a back with nothing said, changes nothing; a stale revision changes nothing; a retried operation key returns the
 * revision it produced the first time and changes nothing.
 */
export function applyAwayChange(current: AwayRecord, change: AwayChange, now: string): AwayChangeResult {
  if (change.operationKey !== undefined && current.operations.some((item) => item.key === change.operationKey)) {
    return { outcome: 'repeated', record: current }
  }
  if (change.source === 'agent' && (change.expectedRevision === undefined || !change.agentSessionId)) {
    return { outcome: 'invalid', record: current, reason: 'An agent names the away revision it saw and its session' }
  }
  if (change.expectedRevision !== undefined && change.expectedRevision !== current.revision) return { outcome: 'stale', record: current }
  if (change.to === 'back' && change.note !== undefined && change.note !== null) {
    return { outcome: 'invalid', record: current, reason: 'A note goes with away, not back' }
  }
  const problem = awayNoteProblem(change.note)
  if (problem !== null) return { outcome: 'invalid', record: current, reason: problem }
  const remember = (record: AwayRecord): AwayRecord => change.operationKey === undefined ? record
    : { ...record, operations: [...record.operations, { key: change.operationKey, revision: record.revision }].slice(-AWAY_OPERATIONS_KEPT) }
  if (change.to === 'back') {
    if (current.state !== 'away') return { outcome: 'unchanged', record: current }
    return { outcome: 'changed', record: remember({ ...current, state: 'back', revision: current.revision + 1, endedAt: now, endedBy: change.source, summaryShownAt: null }) }
  }
  if (current.state === 'away') {
    if (change.note === undefined || change.note === current.note) return { outcome: 'unchanged', record: current }
    return { outcome: 'changed', record: remember({ ...current, revision: current.revision + 1, note: change.note }) }
  }
  return {
    outcome: 'changed',
    record: remember({
      version: 1, state: 'away', revision: current.revision + 1, periodId: change.periodId, since: now, endedAt: null,
      source: change.source, endedBy: null, agentSessionId: change.source === 'agent' ? change.agentSessionId ?? null : null,
      note: change.note ?? null, summaryShownAt: null, operations: current.operations
    })
  }
}

/** What the owner's own surfaces get: everything but the operation keys. */
export interface OwnerAwayView {
  state: AwayState
  revision: number
  periodId: string | null
  since: string | null
  endedAt: string | null
  source: AwaySource | null
  endedBy: AwaySource | null
  note: string | null
  summaryShownAt: string | null
  /** The session of the agent that said away on his words, for the tooltip's source words. */
  agentSessionId: string | null
}
/** What an agent token gets: the state, since and revision; never the note or another session's details (R76-NFR3). */
export interface AgentAwayView {
  state: AwayState
  since: string | null
  revision: number
}

export function ownerAwayView(record: AwayRecord): OwnerAwayView {
  return {
    state: record.state, revision: record.revision, periodId: record.periodId, since: record.since, endedAt: record.endedAt,
    source: record.source, endedBy: record.endedBy, note: record.note, summaryShownAt: record.summaryShownAt,
    agentSessionId: record.agentSessionId
  }
}

export function agentAwayView(record: AwayRecord): AgentAwayView {
  return { state: record.state, since: record.state === 'none' ? null : record.since, revision: record.revision }
}

/**
 * Effective delivery presence (R76-NFR1): away while he said away; otherwise the measured value, unknown included. Back never
 * implies he is watching.
 */
export function effectiveAway(record: Pick<AwayRecord, 'state'>, measured: boolean | null): boolean | null {
  return record.state === 'away' ? true : measured
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (value: number): string => String(value).padStart(2, '0')
const clock = (at: Date): string => `${pad(at.getHours())}:${pad(at.getMinutes())}`
const dayStart = (at: Date): number => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()

/**
 * A moment in the owner's local time as Fable's notes word it (Story 76.1): "22:10" today, "Wed 22:10" within six days,
 * "Oct 9, 22:10" before that, so a weekday never names two days.
 */
export function awayMomentWords(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '--:--'
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000)
  if (days === 0) return clock(at)
  if (days > 0 && days <= 6) return `${WEEKDAYS[at.getDay()]} ${clock(at)}`
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${clock(at)}`
}

/** The head's checked words: "Away since 22:10", "Away since Wed 22:10", "Away since Oct 9, 22:10". */
export function awaySinceWords(since: string, now: Date = new Date()): string {
  return `Away since ${awayMomentWords(since, now)}`
}

/** "35 min", "9 h 30 min", "2 d 3 h" (Story 76.1). */
export function awayDurationWords(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000))
  if (!Number.isFinite(minutes)) return '--'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`
}

/** "Wed 22:10 – Thu 07:40"; one day: "Thu 13:05 – 13:40"; older than six days: "Oct 9, 22:10 – Oct 10, 07:40". */
export function awayPeriodWords(fromIso: string, toIso: string, now: Date = new Date()): string {
  const from = new Date(fromIso)
  const to = new Date(toIso)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return '--'
  const old = Math.round((dayStart(now) - dayStart(from)) / 86_400_000) > 6
  const day = (at: Date): string => old ? `${MONTHS[at.getMonth()]} ${at.getDate()}, ${clock(at)}` : `${WEEKDAYS[at.getDay()]} ${clock(at)}`
  return dayStart(from) === dayStart(to) ? `${day(from)} – ${clock(to)}` : `${day(from)} – ${day(to)}`
}
