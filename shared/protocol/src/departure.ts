// MODULE: departure.ts - bounded departure selection, delivery facts and the shared list shown in BMN and Telegram
import { grantChoice, type GrantPeriod, type GrantRun } from './grant'
import type { OwnerGrantView } from './grant'
import type { OwnerAwayView } from './away'
import { isIso } from './shared-helpers'

export const DEPARTURE_ANSWER_MS = 3 * 60_000
export const DEPARTURE_AUTO_MS = 10 * 60_000
export const DEPARTURE_RECENT_MS = 12 * 60 * 60_000
export const DEPARTURE_QUIET_MS = 20_000
export const DEPARTURE_LINE = 'BMN: the owner is getting ready to leave. If work he authorised is unfinished, answer now with bmn grant ask: your list, or --nothing. This is not the owner: it grants nothing and lifts no stop.'

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
  phone: { state: 'pending' | 'sent' | 'unreachable' | 'uncertain'; messageId: number | null; autoAnnounced: boolean }
}

export function selectDepartureSessions(input: Array<Pick<DepartureSession, 'sessionId' | 'incarnationId' | 'name' | 'agent' | 'lastEventAt'>>, now: string): DepartureSession[] {
  let selected = 0
  // Recent supported sessions occupy the bounded record first, so old rows cannot hide selected ones.
  const eligible = (session: typeof input[number]): boolean => ['claude', 'codex'].includes(session.agent) && session.lastEventAt !== null &&
    Date.parse(session.lastEventAt) <= Date.parse(now) && Date.parse(now) - Date.parse(session.lastEventAt) <= DEPARTURE_RECENT_MS
  return [...input].sort((a, b) => Number(eligible(b)) - Number(eligible(a))).slice(0, 64).map(session => {
    const recent = session.lastEventAt !== null && Date.parse(session.lastEventAt) <= Date.parse(now) &&
      Date.parse(now) - Date.parse(session.lastEventAt) <= DEPARTURE_RECENT_MS
    const reason = !['claude', 'codex'].includes(session.agent) ? 'app not supported' : !recent ? 'no work in 12 hours'
      : selected >= 32 ? 'the list is full' : null
    if (reason === null) selected++
    return { ...session, selectedAt: now, selected: reason === null, reason, toldAt: null, via: null, claim: null }
  })
}

export function newDepartureCollection(sessions: DepartureSession[], now: string): DepartureCollection {
  return { version: 1, selectedAt: now, autoAwayAt: new Date(Date.parse(now) + DEPARTURE_AUTO_MS).toISOString(), autoStartedAt: null, openedAt: null, presentedAt: null,
    sessions, phone: { state: 'pending', messageId: null, autoAnnounced: false } }
}

/** Delivery fields are evidence, not proof of an idle prompt or permission to type. */
export function readDepartureCollection(value: unknown): DepartureCollection | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as DepartureCollection
  if (row.version !== 1 || !isIso(row.selectedAt) || !isIso(row.autoAwayAt) ||
    row.autoStartedAt !== null && !isIso(row.autoStartedAt) || row.openedAt !== null && !isIso(row.openedAt) || !Array.isArray(row.sessions) || row.sessions.length > 64 ||
    row.presentedAt != null && !isIso(row.presentedAt) ||
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
  if (runs.length > 0) return { state: 'nothing', runs, reason: runs.map(run => run.card.scope).join(' · ') }
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
    lines: period.runs.reduce((count, run) => count + (run.card.state === 'withdrawn' ? 0 : run.card.terms.filter(term =>
      run.answer?.cardRevision !== run.card.revision || grantChoice(run.answer.choices, term.id) === undefined).length), 0) }
}
