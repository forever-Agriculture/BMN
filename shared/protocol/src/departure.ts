// MODULE: departure.ts - bounded departure selection, delivery facts and the shared list shown in BMN and Telegram
import { grantChoice, grantNothingWords, type GrantPeriod, type GrantRun } from './grant'
import type { OwnerGrantView } from './grant'
import type { OwnerAwayView } from './away'
import { isIso } from './shared-helpers'

export const DEPARTURE_ANSWER_MS = 3 * 60_000
export const DEPARTURE_AUTO_MS = 10 * 60_000
export const DEPARTURE_RECENT_MS = 12 * 60 * 60_000
export const DEPARTURE_QUIET_MS = 20_000
export const DEPARTURE_LINE = 'BMN: the owner is getting ready to leave. If work he authorised is unfinished, answer now with bmn grant ask: your list, or --nothing --reason. This is not the owner: it grants nothing and lifts no stop.'

export interface OwnerDepartureInput {
  action: 'start' | 'go' | 'cancel' | 'open' | 'presented' | 'same'
  periodId: string | null
  expectedRevision: number
  expectedGeneration?: number
  operationKey: string
  note?: string | null
}
export type DesktopDepartureInput = Omit<OwnerDepartureInput, 'action'> & {
  action: Exclude<OwnerDepartureInput['action'], 'presented'>
}
export interface OwnerDepartureReply {
  outcome: 'changed' | 'unchanged' | 'repeated' | 'stale' | 'unknown'
  view: OwnerGrantView
  away: OwnerAwayView
  detail: string | null
}

/** Internal desktop handshake; a reservation is never evidence that a modal appeared. */
export type DeparturePresentationInput =
  | { action: 'reserve' | 'manual'; periodId: string; expectedGeneration?: number }
  | { action: 'decline' | 'ack'; periodId: string; token: string }
export interface DeparturePresentationReply {
  token: string | null
  reply: OwnerDepartureReply | null
}

export interface DepartureSession {
  sessionId: string
  incarnationId: string | null
  name: string
  agent: string
  lastEventAt: string | null
  selectedAt: string
  selected: boolean
  reason: string | null
  toldAt: string | null
  via: 'hook' | 'typed' | null
  claim: string | null
}
export interface DepartureCollection {
  version: 1
  selectedAt: string
  autoAwayAt: string
  autoStartedAt: string | null
  openedAt: string | null
  /** Verified post-show desktop acknowledgment. Older openedAt values had mixed provenance. */
  presentedAt?: string | null
  sessions: DepartureSession[]
  /** D13: sessions beyond the 64 rows, counted per reason; absent in older records, which never invent a count. */
  omitted?: Record<string, number>
  phone: { state: 'pending' | 'sent' | 'unreachable' | 'uncertain'; messageId: number | null; autoAnnounced: boolean }
}

type DepartureCandidate = Pick<DepartureSession, 'sessionId' | 'incarnationId' | 'name' | 'agent' | 'lastEventAt'>
export const DEPARTURE_SELECTED_LIMIT = 32
export const DEPARTURE_ROW_LIMIT = 64

/** Every candidate with its reason, recent supported sessions first, so old rows cannot hide selected ones. */
function rankDepartureSessions(input: DepartureCandidate[], now: string): DepartureSession[] {
  let selected = 0
  const recent = (session: DepartureCandidate): boolean => session.lastEventAt !== null &&
    Date.parse(session.lastEventAt) <= Date.parse(now) && Date.parse(now) - Date.parse(session.lastEventAt) <= DEPARTURE_RECENT_MS
  const eligible = (session: DepartureCandidate): boolean => ['claude', 'codex'].includes(session.agent) && recent(session)
  return [...input].sort((a, b) => Number(eligible(b)) - Number(eligible(a))).map(session => {
    const reason = !['claude', 'codex'].includes(session.agent) ? 'app not supported' : !recent(session) ? 'no work in 12 hours'
      : selected >= DEPARTURE_SELECTED_LIMIT ? 'the list is full' : null
    if (reason === null) selected++
    return { ...session, selectedAt: now, selected: reason === null, reason, toldAt: null, via: null, claim: null }
  })
}

export function selectDepartureSessions(input: DepartureCandidate[], now: string): DepartureSession[] {
  return rankDepartureSessions(input, now).slice(0, DEPARTURE_ROW_LIMIT)
}

/** D13: the sessions beyond the row limit, counted per reason, so no session is left out uncounted. */
export function omittedDepartureCounts(input: DepartureCandidate[], now: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const session of rankDepartureSessions(input, now).slice(DEPARTURE_ROW_LIMIT)) counts[session.reason!] = (counts[session.reason!] ?? 0) + 1
  return counts
}

/** D13: one line per reason for sessions counted, not listed, for the window's and Telegram's heads. */
export function departureOmittedLines(collection: DepartureCollection | undefined): string[] {
  return Object.entries(collection?.omitted ?? {}).map(([reason, count]) => `${count} more ${count === 1 ? 'session' : 'sessions'} not asked: ${reason}`)
}

export function newDepartureCollection(sessions: DepartureSession[], now: string, omitted: Record<string, number> = {}): DepartureCollection {
  return { version: 1, selectedAt: now, autoAwayAt: new Date(Date.parse(now) + DEPARTURE_AUTO_MS).toISOString(), autoStartedAt: null, openedAt: null, presentedAt: null,
    sessions, ...(Object.keys(omitted).length > 0 ? { omitted } : {}), phone: { state: 'pending', messageId: null, autoAnnounced: false } }
}

/** Delivery fields are evidence, not proof of an idle prompt or permission to type. */
export function readDepartureCollection(value: unknown): DepartureCollection | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as DepartureCollection
  if (row.version !== 1 || !isIso(row.selectedAt) || !isIso(row.autoAwayAt) ||
    row.autoStartedAt !== null && !isIso(row.autoStartedAt) || row.openedAt !== null && !isIso(row.openedAt) || !Array.isArray(row.sessions) || row.sessions.length > DEPARTURE_ROW_LIMIT ||
    row.presentedAt != null && !isIso(row.presentedAt) ||
    row.omitted !== undefined && (typeof row.omitted !== 'object' || row.omitted === null || Array.isArray(row.omitted) || Object.entries(row.omitted).length > 8 ||
      Object.entries(row.omitted).some(([reason, count]) => reason.length === 0 || reason.length > 80 || !Number.isSafeInteger(count) || count < 1)) ||
    !row.phone || !['pending', 'sent', 'unreachable', 'uncertain'].includes(row.phone.state) ||
    row.phone.messageId !== null && (!Number.isSafeInteger(row.phone.messageId) || row.phone.messageId < 1) || typeof row.phone.autoAnnounced !== 'boolean') return null
  const ids = new Set<string>()
  for (const session of row.sessions) {
    if (!session || typeof session.sessionId !== 'string' || ids.has(session.sessionId) ||
      session.incarnationId !== null && typeof session.incarnationId !== 'string' || typeof session.name !== 'string' ||
      typeof session.agent !== 'string' || session.lastEventAt !== null && !isIso(session.lastEventAt) || !isIso(session.selectedAt) ||
      typeof session.selected !== 'boolean' || session.reason !== null && typeof session.reason !== 'string' ||
      session.toldAt !== null && !isIso(session.toldAt) || ![null, 'hook', 'typed'].includes(session.via) ||
      session.claim !== null && typeof session.claim !== 'string' || (session.toldAt === null) !== (session.via === null)) return null
    ids.add(session.sessionId)
  }
  return row
}

export type DepartureRowState = 'asking' | 'list' | 'nothing' | 'no-answer' | 'not-told' | 'not-selected'
export function departureSessionState(period: GrantPeriod, session: DepartureSession, now: Date): { state: DepartureRowState; runs: GrantRun[]; reason: string | null } {
  const runs = period.runs.filter(run => run.card.sessionId === session.sessionId)
  if (runs.some(run => !run.card.nothing)) return { state: 'list', runs, reason: null }
  if (runs.length > 0) return { state: 'nothing', runs, reason: runs.map(run => grantNothingWords(run.card)).join(' · ') }
  if (!session.selected) return { state: 'not-selected', runs, reason: session.reason }
  if (session.toldAt !== null) return { state: now.getTime() - Date.parse(session.toldAt) < DEPARTURE_ANSWER_MS ? 'asking' : 'no-answer', runs, reason: null }
  if (now.getTime() - Date.parse(session.selectedAt) < DEPARTURE_ANSWER_MS) return { state: 'asking', runs, reason: session.reason }
  return { state: 'not-told', runs, reason: session.claim === null ? session.reason ?? 'no idle proof' : 'delivery unconfirmed' }
}

export function departureCounts(period: GrantPeriod, now: Date): { asked: number; asking: number; lines: number; notTold: number } {
  const sessions = period.collection?.sessions ?? []
  return { asked: sessions.filter(session => session.selected).length,
    asking: sessions.filter(session => departureSessionState(period, session, now).state === 'asking').length,
    notTold: sessions.filter(session => ['not-told', 'not-selected'].includes(departureSessionState(period, session, now).state)).length,
    lines: period.runs.reduce((count, run) => count + (run.card.state === 'withdrawn' ? 0 : run.card.nothing ? (run.card.despiteFacts?.length ?? 0) : run.card.terms.filter(term =>
      run.answer?.cardRevision !== run.card.revision || grantChoice(run.answer.choices, term.id) === undefined).length), 0) }
}
