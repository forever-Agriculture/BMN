// MODULE: database-departure-store.ts - all owner departure actions compete in the database worker's single transaction
import { randomUUID } from 'node:crypto'
import {
  answerGrant, awayNoteProblem, grantChoice, grantReoffer, openGrantPeriod, ownerAwayView, ownerGrantView, setDepartureCollection, startDeparture, touchDeparture, upgradeGrantRecord,
  type AwaySource, type DepartureCollection, type GrantRead
} from '@bmn/protocol'
import { changeAway, getAway, rememberDepartureCommand } from './database-away-store'
import { grantBase, readGrantRow, writeGrantRow } from './database-grant-store'
import type { DatabaseConnection } from './database-initialization'

export interface DepartureAction {
  action: 'start' | 'go' | 'cancel' | 'open' | 'presented' | 'auto' | 'same'
  periodId: string | null
  expectedRevision: number
  expectedGeneration?: number
  operationKey: string
  source: AwaySource
  agentSessionId?: string | null
  collection?: DepartureCollection
  note?: string | null
}

/** Transaction-time `now` is passed by the worker, never read from a surface's timer. */
export function departureAction(database: DatabaseConnection, input: DepartureAction, now: string) {
  const read = readGrantRow(database)
  const reply = (outcome: 'changed' | 'unchanged' | 'repeated' | 'stale' | 'unknown', current: GrantRead = read, detail?: string) =>
    ({ outcome, view: ownerGrantView(current), away: ownerAwayView(getAway(database)), awayRecord: getAway(database), read: current, detail: detail ?? null })
  if (read.state !== 'read' && (read.generation === null || input.action !== 'start' || read.reason.includes('unknown version'))) return reply('unknown', read, read.reason)
  if ((input.expectedGeneration ?? 0) !== read.generation) return reply('stale', read, 'The grant record was replaced. Look again.')
  if (input.source === 'telegram' && getAway(database).operations.some(operation => operation.key === input.operationKey)) return reply('repeated')
  let record = grantBase(read)
  const key = `departure:${input.action}:${input.periodId ?? 'new'}:${input.operationKey}`
  if (record.operations.some(operation => operation.key === key)) return reply('repeated')
  let period = openGrantPeriod(record)
  const stale = (): ReturnType<typeof reply> => reply('stale', read, period?.state === 'away'
    ? `Already away since ${period.awayAt}` : 'The list changed. Look again; nothing was changed by this action.')
  // A trusted desktop acknowledgment records a fact even if Go, Back or a card won after showModal.
  // It cannot reopen a departure or move any deadline, and never treats old mixed openedAt as proof.
  const shown = input.action === 'presented' && input.source === 'app' ? record.periods.find(other => other.periodId === input.periodId) : undefined
  if (shown?.collection !== undefined) {
    if (shown.collection.presentedAt != null) return reply('unchanged')
    record = setDepartureCollection(record, shown.periodId, { ...shown.collection, openedAt: now, presentedAt: now })
    record = { ...record, operations: [...record.operations, { key, revision: record.revision }].slice(-500) }
    return reply('changed', writeGrantRow(database, record, now))
  }
  if (record.revision !== input.expectedRevision) return stale()
  if (awayNoteProblem(input.note) !== null) return reply('unchanged', read, awayNoteProblem(input.note)!)
  if (period?.state === 'leaving' && period.collection === undefined && (input.action === 'open' || input.action === 'presented') && input.collection !== undefined) {
    record = setDepartureCollection(upgradeGrantRecord(record), period.periodId, input.collection)
    period = openGrantPeriod(record)
  }
  if (input.action === 'start') {
    if (period !== null || getAway(database).state === 'away') return input.periodId === period?.periodId ? reply('unchanged') : stale()
    if (input.periodId !== null || input.collection === undefined) return stale()
    record = startDeparture(record, { source: input.source, agentSessionId: input.agentSessionId ?? null, periodId: randomUUID(), collection: input.collection }, getAway(database).state, now).record
    if (input.note !== undefined) record = { ...record, periods: record.periods.map(other => other.state === 'leaving' ? { ...other, note: input.note ?? null } : other) }
    writeGrantRow(database, record, now)
    if (!input.collection.sessions.some(session => session.selected)) {
      changeAway(database, { to: 'away', source: input.source, ...(input.source === 'agent' ? { agentSessionId: input.agentSessionId, expectedRevision: getAway(database).revision } : {}) }, now)
      const next = readGrantRow(database)
      if (next.state !== 'read') return reply('unknown', next)
      record = next.record
    }
  } else {
    if (period === null || period.periodId !== input.periodId || period.state !== 'leaving') return stale()
    if (input.action === 'presented') {
      if (period.collection === undefined) return reply('unknown', read, 'The departure has no collection record.')
      if (input.source !== 'app') return reply('unchanged')
      if (period.collection.presentedAt != null) return reply('unchanged')
      record = setDepartureCollection(record, period.periodId, { ...period.collection, openedAt: now, presentedAt: now })
    } else if (input.action === 'open') {
      record = touchDeparture(record, period.periodId, now)
      if (input.note !== undefined) record = { ...record, periods: record.periods.map(other => other.periodId === period.periodId ? { ...other, note: input.note ?? null } : other) }
    }
    else if (input.action === 'same') {
      for (const run of period.runs) {
        const offer = grantReoffer(record, period, run)
        const choices = Object.fromEntries(Object.entries(offer?.choices ?? {}).filter(([id]) => run.answer?.cardRevision !== run.card.revision || grantChoice(run.answer.choices, id) === undefined))
        if (Object.keys(choices).length === 0) continue
        const answered = answerGrant(record, { periodId: period.periodId, runId: run.runId, cardRevision: run.card.revision,
          expectedRevision: record.revision, choices, via: input.source === 'telegram' ? 'telegram' : 'app', operationKey: `${key}:${run.runId}` }, now)
        if (answered.outcome === 'refused') throw Error('The repeat offers changed; no answers were saved')
        record = answered.record
      }
    } else {
      if (input.action === 'auto') {
        if (period.collection === undefined || Date.parse(period.collection.autoAwayAt) > Date.parse(now)) return reply('unchanged')
        record = setDepartureCollection(record, period.periodId, { ...period.collection, autoStartedAt: now })
        writeGrantRow(database, record, now)
      }
      const changed = changeAway(database, { to: input.action === 'cancel' ? 'back' : 'away', source: input.source,
        ...(input.source === 'agent' ? { agentSessionId: input.agentSessionId, expectedRevision: getAway(database).revision } : {}) }, now)
      if (changed.outcome === 'invalid' || changed.outcome === 'stale') return stale()
      const next = readGrantRow(database)
      if (next.state !== 'read') return reply('unknown', next)
      record = next.record
    }
  }
  record = { ...record, operations: [...record.operations, { key, revision: record.revision }].slice(-500) }
  const saved = writeGrantRow(database, record, now)
  if (input.source === 'telegram') rememberDepartureCommand(database, input.operationKey, now)
  return reply('changed', saved)
}

/** Claim persists before terminal I/O. An ambiguous write keeps it forever in this period. */
export function departureDelivery(database: DatabaseConnection, input: {
  periodId: string; sessionId: string; kind: 'claim' | 'release' | 'told' | 'reason'; token: string; reason?: string
}, now: string) {
  const read = readGrantRow(database)
  if (read.state !== 'read') return { claimed: false, read }
  const period = openGrantPeriod(read.record)
  const collection = period?.collection
  const session = collection?.sessions.find(other => other.sessionId === input.sessionId)
  if (period?.periodId !== input.periodId || collection === undefined || session === undefined || !session.selected) return { claimed: false, read }
  if (input.kind === 'claim' && (period.state !== 'leaving' || session.toldAt !== null || session.claim !== null ||
    Date.parse(now) - Date.parse(session.selectedAt) >= 3 * 60_000)) return { claimed: false, read }
  if ((input.kind === 'release' || input.kind === 'told') && session.claim !== input.token) return { claimed: false, read }
  const next = input.kind === 'claim' ? { ...session, claim: input.token }
    : input.kind === 'release' ? { ...session, claim: null }
      : input.kind === 'told' ? { ...session, toldAt: session.toldAt ?? now, via: session.via ?? 'typed' as const, reason: null }
        : { ...session, reason: input.reason ?? null }
  let record = setDepartureCollection(read.record, period.periodId, { ...collection, sessions: collection.sessions.map(other => other === session ? next : other) })
  if (input.kind === 'told' && !period.told.includes(session.sessionId)) {
    // Delivery metadata and the old told list are saved together.
    record = { ...record, periods: record.periods.map(other => other.periodId === period.periodId ? { ...other, told: [...other.told, session.sessionId].slice(-64) } : other) }
  }
  return { claimed: input.kind === 'claim', read: record === read.record ? read : writeGrantRow(database, record, now) }
}

export function departurePhone(database: DatabaseConnection, periodId: string, phone: DepartureCollection['phone'], now: string) {
  const read = readGrantRow(database)
  if (read.state !== 'read') return read
  const period = read.record.periods.find(other => other.periodId === periodId)
  if (period?.collection === undefined) return read
  const record = setDepartureCollection(read.record, periodId, { ...period.collection, phone })
  return record === read.record ? read : writeGrantRow(database, record, now)
}

export const DEPARTURE_OPERATIONS = { departureAction, departureDelivery, departurePhone }
