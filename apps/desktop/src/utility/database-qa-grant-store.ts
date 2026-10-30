// MODULE: database-qa-grant-store.ts - one SQLite writer owns immutable approvals, at-most-once uses and durable QA audit
import { createHash } from 'node:crypto'
import { QA_ACTIVITIES, QA_AUDIT_LIMIT, isQaAuditEvent, isQaGrantTerms, isQaRequestMeta, type QaAuditEvent, type QaAuditGap, type QaAuditRecord, type QaAuditState, type QaGrant, type QaGrantTerms, type QaGrantUse, type QaHostSummary, type QaUseDecision, type QaUseRequest } from '@bmn/protocol'
import { canonicalJson } from '../../bin/shared-helpers.mjs'
import type { DatabaseConnection } from './database-initialization'
import { getQaRun, sealQaRunAccounts, writeQaRunAudit } from './database-qa-store'
import { invalidWorkspaceStore as invalid } from './database-workspace-store'

const read = <T>(row: unknown): T | null => row ? JSON.parse((row as { record_json: string }).record_json) as T : null
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identifier = (value: string): boolean => /^[A-Za-z0-9_:@.-]{1,128}$/.test(value)
const clock = (now: string): number => { const time = Date.parse(now); if (!Number.isFinite(time)) return invalid('QA_TIME_INVALID'); return time }
const mutable = (database: DatabaseConnection, qaId: string): void => {
  if (getQaRun(database, qaId)?.accountsSealedAt) invalid('QA_ACCOUNTS_SEALED')
}
const auditState = (database: DatabaseConnection, qaId: string): QaAuditState => {
  const run = getQaRun(database, qaId)
  if (!run) return invalid('QA_NOT_FOUND')
  return run.audit ?? { complete: true, open: false, nextSequence: 1, gaps: [] }
}
export function getQaGrant(database: DatabaseConnection, id: string): QaGrant | null { return read(database.prepare('SELECT record_json FROM qa_grant WHERE grant_id = ?').get(id)) }
export function qaGrantForKey(database: DatabaseConnection, qaId: string, key: string): QaGrant | null { return read(database.prepare('SELECT record_json FROM qa_grant WHERE qa_id = ? AND request_key = ?').get(qaId, key)) }
export function qaGrantForCard(database: DatabaseConnection, id: string): QaGrant | null { return read(database.prepare('SELECT record_json FROM qa_grant WHERE card_id = ?').get(id)) }
const writeGrant = (database: DatabaseConnection, grant: QaGrant): QaGrant => {
  database.prepare('UPDATE qa_grant SET card_id = ?, record_json = ? WHERE grant_id = ?').run(grant.card?.id ?? null, JSON.stringify(grant), grant.id)
  return getQaGrant(database, grant.id)!
}
export function askQaGrant(database: DatabaseConnection, request: { id: string; key: string; terms: QaGrantTerms }, now: string): QaGrant {
  if (!identifier(request.id) || !identifier(request.key) || !isQaGrantTerms(request.terms)) return invalid('QA_GRANT_INVALID')
  const time = clock(now), expiry = clock(request.terms.expiresAt), run = getQaRun(database, request.terms.qaId)
  if (!run || !['preparing', 'running'].includes(run.state)) return invalid('QA_NOT_RUNNING')
  mutable(database, run.id)
  if (expiry <= time || expiry - time > 24 * 60 * 60 * 1000) return invalid('QA_GRANT_EXPIRY_INVALID')
  return database.transaction(() => {
    const previous = qaGrantForKey(database, request.terms.qaId, request.key)
    const termsSha256 = digest(request.terms)
    if (previous) { if (previous.termsSha256 !== termsSha256) return invalid('QA_GRANT_KEY_CONFLICT'); return previous }
    const grant: QaGrant = { id: request.id, key: request.key, terms: request.terms, termsSha256, revision: 1, state: 'pending', createdAt: now, card: null, approval: null }
    database.prepare('INSERT INTO qa_grant(grant_id,qa_id,request_key,card_id,record_json) VALUES(?,?,?,NULL,?)').run(grant.id, grant.terms.qaId, grant.key, JSON.stringify(grant))
    return getQaGrant(database, grant.id)!
  })()
}
export function bindQaGrantCard(database: DatabaseConnection, id: string, card: NonNullable<QaGrant['card']>): QaGrant {
  const grant = getQaGrant(database, id)
  if (!grant || grant.state !== 'pending' || !identifier(card.id) || !Number.isSafeInteger(card.revision) || card.revision < 1 || !/^[a-f0-9]{64}$/.test(card.sha256)) return invalid('QA_GRANT_CARD_INVALID')
  if (grant.card) { if (JSON.stringify(grant.card) !== JSON.stringify(card)) return invalid('QA_GRANT_CARD_CONFLICT'); return grant }
  return writeGrant(database, { ...grant, card })
}
/** Host-only caller: the app/verified Telegram handler verifies the actual unchanged card before this transaction. */
export function answerQaGrant(database: DatabaseConnection, answer: { id: string; cardId: string; cardRevision: number; cardSha256: string; approved: boolean; via: 'app' | 'telegram'; operationKey: string }, now: string): QaGrant {
  clock(now)
  return database.transaction(() => {
    const grant = getQaGrant(database, answer.id)
    if (!grant || !identifier(answer.operationKey) || !['app', 'telegram'].includes(answer.via) || typeof answer.approved !== 'boolean') return invalid('QA_GRANT_ANSWER_INVALID')
    mutable(database, grant.terms.qaId)
    if (!grant.card || grant.card.id !== answer.cardId || grant.card.revision !== answer.cardRevision || grant.card.sha256 !== answer.cardSha256) return invalid('QA_GRANT_ANSWER_STALE')
    if (grant.approval?.operationKey === answer.operationKey) {
      if (grant.approval.approved !== answer.approved) return invalid('QA_GRANT_ANSWER_CONFLICT')
      return grant
    }
    if (grant.state !== 'pending' || !grant.card || grant.card.id !== answer.cardId || grant.card.revision !== answer.cardRevision || grant.card.sha256 !== answer.cardSha256 || clock(grant.terms.expiresAt) <= clock(now)) return invalid('QA_GRANT_ANSWER_STALE')
    return writeGrant(database, { ...grant, state: answer.approved ? 'approved' : 'denied', revision: grant.revision + 1, approval: { via: answer.via, operationKey: answer.operationKey, at: now, approved: answer.approved } })
  })()
}
export function revokeQaGrant(database: DatabaseConnection, id: string): QaGrant {
  const grant = getQaGrant(database, id)
  if (!grant) return invalid('QA_GRANT_NOT_FOUND')
  mutable(database, grant.terms.qaId)
  return grant.state === 'revoked' ? grant : writeGrant(database, { ...grant, state: 'revoked', revision: grant.revision + 1 })
}
export function getQaGrantUse(database: DatabaseConnection, id: string): QaGrantUse | null { return read(database.prepare('SELECT record_json FROM qa_grant_use WHERE use_id = ?').get(id)) }
const writeUse = (database: DatabaseConnection, use: QaGrantUse): QaGrantUse => {
  database.prepare('UPDATE qa_grant_use SET record_json = ? WHERE use_id = ?').run(JSON.stringify(use), use.id)
  return getQaGrantUse(database, use.id)!
}
function append(database: DatabaseConnection, qaId: string, event: QaAuditEvent, now: string): { recorded: boolean; complete: boolean } {
  mutable(database, qaId)
  if (!isQaAuditEvent(event)) return invalid('QA_AUDIT_METADATA_INVALID')
  clock(now)
  const state = auditState(database, qaId)
  if (state.nextSequence > QA_AUDIT_LIMIT) {
    writeQaRunAudit(database, qaId, { ...state, complete: false, gaps: [...new Set([...state.gaps, 'overflow' as const])] })
    return { recorded: false, complete: false }
  }
  const record: QaAuditRecord = { ...event, qaId, sequence: state.nextSequence, at: now }
  database.prepare('INSERT INTO qa_audit(qa_id,sequence,record_json) VALUES(?,?,?)').run(qaId, record.sequence, JSON.stringify(record))
  writeQaRunAudit(database, qaId, { ...state, open: true, nextSequence: state.nextSequence + 1 })
  return { recorded: true, complete: state.complete }
}
export function appendQaAudit(database: DatabaseConnection, qaId: string, event: QaAuditEvent, now: string): { recorded: boolean; complete: boolean } {
  return database.transaction(() => append(database, qaId, event, now))()
}
const useAudit = (use: QaGrantUse, grant: QaGrant, result: QaAuditEvent['result'], status: number | null = null): QaAuditEvent => ({ ...use.request, accountAlias: grant.terms.account.alias, classification: 'activity', result, grantId: grant.id, cardId: grant.card?.id ?? null, useId: use.id, status })
/** Internal coordinator only: real account/contract and native proof must be validated before entering this ledger. */
export function reserveQaGrantUse(database: DatabaseConnection, request: QaUseRequest, now: string): QaUseDecision {
  if (!identifier(request.id) || !QA_ACTIVITIES.includes(request.activity) || !/^[a-f0-9]{64}$/.test(request.requestSha256) || !isQaRequestMeta(request.request)) return invalid('QA_USE_INVALID')
  return database.transaction((): QaUseDecision => {
    const old = getQaGrantUse(database, request.id)
    if (old) {
      if (old.qaId !== request.qaId || old.grantId !== request.grantId || old.activity !== request.activity || old.requestSha256 !== request.requestSha256 || digest(old.request) !== digest(request.request)) return invalid('QA_USE_KEY_CONFLICT')
      return { allowed: false, reason: 'already-reserved-or-used', use: old }
    }
    const grant = getQaGrant(database, request.grantId), run = getQaRun(database, request.qaId)
    if (!grant || grant.terms.qaId !== request.qaId || !run || run.state !== 'running') return { allowed: false, reason: 'run-or-grant-unavailable' }
    mutable(database, run.id)
    if (grant.state !== 'approved' || !grant.approval?.approved || !grant.card) return { allowed: false, reason: 'not-approved' }
    if (clock(grant.terms.expiresAt) <= clock(now)) return { allowed: false, reason: 'expired' }
    if (grant.terms.account.revision !== request.accountRevision || grant.terms.contract.sha256 !== request.contractSha256 || grant.terms.origin !== request.request.origin) return { allowed: false, reason: 'scope-changed' }
    const limit = grant.terms.limits.find(item => item.activity === request.activity)?.count ?? 0
    const used = (database.prepare('SELECT COUNT(*) AS n FROM qa_grant_use WHERE grant_id = ? AND activity = ?').get(grant.id, request.activity) as { n: number }).n
    if (used >= limit) return { allowed: false, reason: 'exhausted' }
    const pending = database.prepare("SELECT use_id FROM qa_grant_use WHERE account_id = ? AND json_extract(record_json,'$.state') IN ('reserved','sent','uncertain') LIMIT 1").get(grant.terms.account.id)
    if (pending) return { allowed: false, reason: 'account-outcome-pending' }
    const use: QaGrantUse = { id: request.id, qaId: request.qaId, grantId: grant.id, accountId: grant.terms.account.id, activity: request.activity, requestSha256: request.requestSha256, request: request.request, state: 'reserved', reservedAt: now, settledAt: null, status: null }
    if (!append(database, request.qaId, useAudit(use, grant, 'reserved'), now).recorded) return { allowed: false, reason: 'audit-incomplete' }
    database.prepare('INSERT INTO qa_grant_use(use_id,qa_id,grant_id,account_id,activity,record_json) VALUES(?,?,?,?,?,?)').run(use.id, use.qaId, use.grantId, use.accountId, use.activity, JSON.stringify(use))
    return { allowed: true, use }
  })()
}
/** The send commitment is one-shot. A lost reply never permits the caller to send or retry. */
export function sendQaGrantUse(database: DatabaseConnection, qaId: string, id: string, accountRevision: number, now: string): QaUseDecision {
  return database.transaction((): QaUseDecision => {
    const use = getQaGrantUse(database, id)
    if (!use || use.qaId !== qaId) return invalid('QA_USE_NOT_FOUND')
    mutable(database, qaId)
    if (use.state !== 'reserved') return { allowed: false, reason: 'already-sent-or-uncertain', use }
    const grant = getQaGrant(database, use.grantId), run = getQaRun(database, qaId)
    if (!grant || grant.state !== 'approved' || clock(grant.terms.expiresAt) <= clock(now) || grant.terms.account.revision !== accountRevision || run?.state !== 'running') return { allowed: false, reason: 'no-longer-permitted', use: writeUse(database, { ...use, state: 'uncertain', settledAt: now }) }
    if (!append(database, qaId, useAudit(use, grant, 'sent'), now).recorded) return { allowed: false, reason: 'audit-incomplete', use: writeUse(database, { ...use, state: 'uncertain', settledAt: now }) }
    return { allowed: true, use: writeUse(database, { ...use, state: 'sent' }) }
  })()
}
export function settleQaGrantUse(database: DatabaseConnection, qaId: string, id: string, state: 'succeeded' | 'failed' | 'uncertain', status: number | null, now: string): QaGrantUse {
  if (!['succeeded', 'failed', 'uncertain'].includes(state) || status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) return invalid('QA_USE_OUTCOME_INVALID')
  return database.transaction(() => {
    const use = getQaGrantUse(database, id)
    if (!use || use.qaId !== qaId) return invalid('QA_USE_NOT_FOUND')
    mutable(database, qaId)
    if (['succeeded', 'failed', 'uncertain'].includes(use.state)) {
      if (use.state !== state || use.status !== status) return invalid('QA_USE_TERMINAL')
      return use
    }
    if (use.state !== 'sent' && state !== 'uncertain') return invalid('QA_USE_NOT_SENT')
    const grant = getQaGrant(database, use.grantId)!
    append(database, qaId, useAudit(use, grant, state, status), now)
    return writeUse(database, { ...use, state, status, settledAt: now })
  })()
}
export function closeQaAudit(database: DatabaseConnection, qaId: string, gap: QaAuditGap | null = null): QaAuditState {
  mutable(database, qaId)
  const state = auditState(database, qaId)
  if (gap !== null && !['overflow', 'interrupted', 'relay-incomplete', 'broker-unreachable'].includes(gap)) return invalid('QA_AUDIT_GAP_INVALID')
  const next = { ...state, open: false, complete: state.complete && gap === null, gaps: gap === null ? state.gaps : [...new Set([...state.gaps, gap])] }
  writeQaRunAudit(database, qaId, next)
  return next
}
export function qaAuditSummary(database: DatabaseConnection, qaId: string): QaAuditState & { entries: number } {
  const state = auditState(database, qaId)
  return { ...state, entries: state.nextSequence - 1 }
}
export function qaAuditRecords(database: DatabaseConnection, qaId: string): QaAuditRecord[] { return database.prepare('SELECT record_json FROM qa_audit WHERE qa_id = ? ORDER BY sequence').all(qaId).map(row => read<QaAuditRecord>(row)!) }
/** Fresh transactional projection, never a model-authored counter. No raw request data leaves this summary. */
export function qaHostSummary(database: DatabaseConnection, qaId: string): QaHostSummary {
  return database.transaction((): QaHostSummary => {
    const run = getQaRun(database, qaId)
    if (!run?.accountsSealedAt) return invalid('QA_SUMMARY_NOT_SEALED')
    const records = qaAuditRecords(database, qaId), state = qaAuditSummary(database, qaId)
    const uses = database.prepare('SELECT record_json FROM qa_grant_use WHERE qa_id = ? ORDER BY use_id').all(qaId).map(row => read<QaGrantUse>(row)!)
    const traffic = new Map<string, QaHostSummary['audit']['observedTraffic'][number]>()
    for (const record of records) {
      const group = { accountAlias: record.accountAlias, origin: record.origin, classification: record.classification, result: record.result }
      const key = canonicalJson(group), previous = traffic.get(key)
      traffic.set(key, { ...group, count: (previous?.count ?? 0) + 1 })
    }
    const grants = database.prepare('SELECT record_json FROM qa_grant WHERE qa_id = ? ORDER BY grant_id').all(qaId).map(row => read<QaGrant>(row)!).map(grant => ({
      grantId: grant.id, termsSha256: grant.termsSha256, state: grant.state, account: grant.terms.account,
      origin: grant.terms.origin, contract: grant.terms.contract, expiresAt: grant.terms.expiresAt, card: grant.card,
      approval: grant.approval ? { via: grant.approval.via, at: grant.approval.at, approved: grant.approval.approved } : null,
      activities: [...grant.terms.limits].sort((a, b) => a.activity < b.activity ? -1 : 1).map(limit => {
        const own = uses.filter(use => use.grantId === grant.id && use.activity === limit.activity)
        return { activity: limit.activity, granted: grant.approval?.approved ? limit.count : 0, reserved: own.length,
          sent: new Set(records.filter(record => record.grantId === grant.id && record.result === 'sent' && own.some(use => use.id === record.useId)).map(record => record.useId)).size,
          succeeded: own.filter(use => use.state === 'succeeded').length, failed: own.filter(use => use.state === 'failed').length, uncertain: own.filter(use => use.state === 'uncertain').length }
      })
    }))
    return { version: 1, receiptId: `${qaId}:summary:1`, qaId, briefSha256: run.inputSha256, revision: String(run.brief.revision ?? ''), grants,
      audit: { ...state, recordsSha256: createHash('sha256').update(canonicalJson(records)).digest('hex'), observedTraffic: [...traffic.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value) } }
  })()
}
/** Host-only: prevent new requests before resolving outstanding uses and taking an immutable receipt. */
export function sealQaHostSummary(database: DatabaseConnection, qaId: string, now: string): QaHostSummary {
  clock(now)
  return database.transaction(() => {
    const run = getQaRun(database, qaId)
    if (!run) return invalid('QA_NOT_FOUND')
    if (!run.accountsSealedAt) {
      const pending = database.prepare("SELECT record_json FROM qa_grant_use WHERE qa_id = ? AND json_extract(record_json,'$.state') IN ('reserved','sent') ORDER BY use_id").all(qaId).map(row => read<QaGrantUse>(row)!)
      for (const use of pending) { const grant = getQaGrant(database, use.grantId)!; writeUse(database, { ...use, state: 'uncertain', settledAt: now }); append(database, qaId, useAudit(use, grant, 'uncertain'), now) }
      closeQaAudit(database, qaId)
      sealQaRunAccounts(database, qaId, now)
    }
    return qaHostSummary(database, qaId)
  })()
}
/** Every unfinished reservation remains spent and locks its account; restart never sends or refunds. */
export function recoverQaGrantUses(database: DatabaseConnection, now: string): void {
  database.transaction(() => {
    const uses = database.prepare("SELECT record_json FROM qa_grant_use WHERE json_extract(record_json,'$.state') IN ('reserved','sent')").all().map(row => read<QaGrantUse>(row)!)
    for (const use of uses) { writeUse(database, { ...use, state: 'uncertain', settledAt: now }); const grant = getQaGrant(database, use.grantId)!; append(database, use.qaId, useAudit(use, grant, 'uncertain'), now) }
    for (const row of database.prepare('SELECT record_json FROM qa_run').all()) {
      const run = read<{ id: string; audit?: QaAuditState }>(row)!
      if (run.audit?.open) closeQaAudit(database, run.id, 'interrupted')
    }
  })()
}
export const QA_GRANT_OPERATIONS = Object.freeze({ askQaGrant, getQaGrant, qaGrantForKey, qaGrantForCard, bindQaGrantCard, answerQaGrant, revokeQaGrant, reserveQaGrantUse, sendQaGrantUse, settleQaGrantUse, getQaGrantUse, appendQaAudit, closeQaAudit, qaAuditSummary, qaAuditRecords, recoverQaGrantUses, qaHostSummary, sealQaHostSummary })
