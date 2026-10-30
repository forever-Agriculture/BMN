// MODULE: database-qa-grant-store.test.ts - synthetic SQLite proof for approval binding, at-most-once limits and restart/audit failures
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_ID, QA_AUDIT_LIMIT, type QaAuditEvent, type QaGrantTerms, type QaRun, type QaUseRequest } from '@bmn/protocol'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { bindQaRun, reserveQaRun, writeQaRunAudit } from './database-qa-store'
import { answerQaGrant, appendQaAudit, askQaGrant, bindQaGrantCard, closeQaAudit, getQaGrant, getQaGrantUse, qaAuditRecords, qaAuditSummary, recoverQaGrantUses, reserveQaGrantUse, revokeQaGrant, sendQaGrantUse, settleQaGrantUse } from './database-qa-grant-store'

// Ledger layer only: synthetic rows do not prove A1, Codex tool closure or the owner-window/relay path.
const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-10-29T13:00:00.000Z', later = '2026-10-29T13:01:00.000Z', expired = '2026-10-29T14:01:00.000Z'
const sha = 'a'.repeat(64), card = { id: 'card-a', revision: 1, sha256: 'b'.repeat(64) }
let database: DatabaseConnection, root: string, path: string
const terms = (): QaGrantTerms => ({ version: 1, qaId: 'run-a', account: { id: 'account-a', alias: 'synthetic', revision: 1 }, origin: 'http://127.0.0.1:4173', contract: { id: 'synthetic-paid@1', sha256: sha }, limits: [{ activity: 'report.generate', count: 1 }, { activity: 'brainstorm.start', count: 1 }], expiresAt: '2026-10-29T14:00:00.000Z' })
const request = (id = 'use-a', activity: QaUseRequest['activity'] = 'report.generate'): QaUseRequest => ({ id, qaId: 'run-a', grantId: 'grant-a', activity, requestSha256: sha, accountRevision: 1, contractSha256: sha, request: { method: 'POST', origin: terms().origin, path: '/paid/report', queryKeys: [] } })
function ask(): void { askQaGrant(database, { id: 'grant-a', key: 'request-a', terms: terms() }, now) }
function approve(): void {
  ask(); bindQaGrantCard(database, 'grant-a', card)
  answerQaGrant(database, { id: 'grant-a', cardId: card.id, cardRevision: card.revision, cardSha256: card.sha256, approved: true, via: 'app', operationKey: 'owner-answer-a' }, now)
}
const audit = (alias = 'synthetic'): QaAuditEvent => ({ method: 'GET', origin: terms().origin, path: '/read/:id', queryKeys: ['page'], accountAlias: alias, classification: 'read', result: 'observed', grantId: null, useId: null, cardId: null, status: null })
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qa-grant-')); path = join(root, 'grant.sqlite'); database = new Sqlite(path); initializeDatabase(database, now)
  for (const id of ['caller', 'qa']) database.prepare(`INSERT INTO session(session_id,workspace_id,name,cwd,executable,argv_json,revision,created_at,position) VALUES(?,?,?,'/qa/run-a','/usr/bin/env','["--run","run-a"]',1,?,0)`).run(id, DEFAULT_WORKSPACE_ID, id, now)
  const run: QaRun = { id: 'run-a', callerSessionId: 'caller', workspaceId: DEFAULT_WORKSPACE_ID, key: 'run-key', inputSha256: sha, brief: {}, folder: '/qa/run-a', state: 'preparing', sessionId: null, incarnationId: null, createdAt: now, failure: null, connection: null, result: null }
  reserveQaRun(database, run); bindQaRun(database, run.id, 'qa', 'inc-a')
})
afterEach(() => { database.close(); rmSync(root, { recursive: true, force: true }) })
it('neither an unbound card nor a pending request is permission', () => {
  ask(); expect(reserveQaGrantUse(database, request(), now)).toMatchObject({ allowed: false, reason: 'not-approved' })
  expect(() => answerQaGrant(database, { id: 'grant-a', cardId: card.id, cardRevision: 1, cardSha256: card.sha256, approved: true, via: 'app', operationKey: 'fake' }, now)).toThrow('QA_GRANT_ANSWER_STALE')
  expect(database.prepare('SELECT COUNT(*) AS n FROM qa_grant_use').get()).toEqual({ n: 0 })
})
it('the exact approved count executes once per activity, with no refund after failure', () => {
  approve(); expect(reserveQaGrantUse(database, request(), now).allowed).toBe(true)
  expect(sendQaGrantUse(database, 'run-a', 'use-a', 1, now).allowed).toBe(true)
  settleQaGrantUse(database, 'run-a', 'use-a', 'failed', 503, later)
  expect(reserveQaGrantUse(database, request('extra'), later)).toMatchObject({ allowed: false, reason: 'exhausted' })
  expect(reserveQaGrantUse(database, request('brainstorm', 'brainstorm.start'), later).allowed).toBe(true)
  expect(sendQaGrantUse(database, 'run-a', 'brainstorm', 1, later).allowed).toBe(true)
  settleQaGrantUse(database, 'run-a', 'brainstorm', 'succeeded', 200, later)
  expect(reserveQaGrantUse(database, request('extra-brainstorm', 'brainstorm.start'), later)).toMatchObject({ allowed: false, reason: 'exhausted' })
  expect(database.prepare('SELECT COUNT(*) AS n FROM qa_grant_use').get()).toEqual({ n: 2 })
})
it('lost reserve replies and duplicate use IDs never create a second send permission', () => {
  approve(); reserveQaGrantUse(database, request(), now) // Response deliberately ignored.
  expect(reserveQaGrantUse(database, request(), now)).toMatchObject({ allowed: false, reason: 'already-reserved-or-used' })
  expect(() => reserveQaGrantUse(database, { ...request(), requestSha256: 'c'.repeat(64) }, now)).toThrow('QA_USE_KEY_CONFLICT')
  expect(sendQaGrantUse(database, 'run-a', 'use-a', 1, now).allowed).toBe(true)
  expect(sendQaGrantUse(database, 'run-a', 'use-a', 1, now)).toMatchObject({ allowed: false, reason: 'already-sent-or-uncertain' })
})
it('an unresolved outcome blocks another activity on the same account without spending it', () => {
  approve(); reserveQaGrantUse(database, request(), now)
  expect(reserveQaGrantUse(database, request('brainstorm', 'brainstorm.start'), later)).toMatchObject({ allowed: false, reason: 'account-outcome-pending' })
  expect(getQaGrantUse(database, 'brainstorm')).toBeNull()
})
it('revocation between reserve and send prevents dispatch and preserves spent allowance', () => {
  approve(); reserveQaGrantUse(database, request(), now); revokeQaGrant(database, 'grant-a')
  expect(sendQaGrantUse(database, 'run-a', 'use-a', 1, later)).toMatchObject({ allowed: false, reason: 'no-longer-permitted', use: { state: 'uncertain' } })
  const replay = answerQaGrant(database, { id: 'grant-a', cardId: card.id, cardRevision: 1, cardSha256: card.sha256, approved: true, via: 'app', operationKey: 'owner-answer-a' }, later)
  expect(replay.state).toBe('revoked'); expect(getQaGrantUse(database, 'use-a')?.state).toBe('uncertain')
})
it('expiry and a changed account revision deny the send commitment', () => {
  approve(); reserveQaGrantUse(database, request(), now)
  expect(sendQaGrantUse(database, 'run-a', 'use-a', 2, later)).toMatchObject({ allowed: false, use: { state: 'uncertain' } })
  expect(reserveQaGrantUse(database, request('expired', 'brainstorm.start'), expired)).toMatchObject({ allowed: false, reason: 'expired' })
})
it('a stale card ID, revision or content cannot approve; duplicate answers retain the same terms', () => {
  ask(); bindQaGrantCard(database, 'grant-a', card)
  const base = { id: 'grant-a', cardId: card.id, cardRevision: 1, cardSha256: card.sha256, approved: true, via: 'telegram' as const, operationKey: 'phone-a' }
  for (const change of [{ cardId: 'another' }, { cardRevision: 2 }, { cardSha256: 'c'.repeat(64) }]) expect(() => answerQaGrant(database, { ...base, ...change }, now)).toThrow('QA_GRANT_ANSWER_STALE')
  const approved = answerQaGrant(database, base, now)
  expect(answerQaGrant(database, base, later)).toEqual(approved)
  expect(() => answerQaGrant(database, { ...base, approved: false }, later)).toThrow('QA_GRANT_ANSWER_CONFLICT')
})
it('request keys preserve immutable terms and a denied card grants no activity', () => {
  ask(); expect(askQaGrant(database, { id: 'new-id', key: 'request-a', terms: terms() }, now).id).toBe('grant-a')
  expect(() => askQaGrant(database, { id: 'new-id', key: 'request-a', terms: { ...terms(), origin: 'http://127.0.0.1:4174' } }, now)).toThrow('QA_GRANT_KEY_CONFLICT')
  bindQaGrantCard(database, 'grant-a', card); answerQaGrant(database, { id: 'grant-a', cardId: card.id, cardRevision: 1, cardSha256: card.sha256, approved: false, via: 'app', operationKey: 'deny' }, now)
  expect(reserveQaGrantUse(database, request(), now)).toMatchObject({ allowed: false, reason: 'not-approved' })
})
it('a real database reopen keeps uncertainty, consumed limits and monotonic incomplete audit', () => {
  approve(); reserveQaGrantUse(database, request(), now); const before = qaAuditSummary(database, 'run-a').entries
  database.close(); database = new Sqlite(path); initializeDatabase(database, later); recoverQaGrantUses(database, later)
  expect(getQaGrantUse(database, 'use-a')).toMatchObject({ state: 'uncertain' })
  expect(qaAuditSummary(database, 'run-a')).toMatchObject({ complete: false, open: false, gaps: ['interrupted'] })
  appendQaAudit(database, 'run-a', audit('second-account'), later)
  expect(qaAuditSummary(database, 'run-a').entries).toBeGreaterThan(before)
  expect(qaAuditRecords(database, 'run-a').map(row => row.sequence)).toEqual([1, 2, 3])
  expect(reserveQaGrantUse(database, request('brainstorm', 'brainstorm.start'), later)).toMatchObject({ allowed: false, reason: 'account-outcome-pending' })
  expect(closeQaAudit(database, 'run-a').complete).toBe(false)
})
it('audits retain ordered account switches but reject headers, bodies and query values', () => {
  appendQaAudit(database, 'run-a', audit(), now); appendQaAudit(database, 'run-a', audit('another-synthetic'), later)
  expect(qaAuditRecords(database, 'run-a').map(row => [row.sequence, row.accountAlias])).toEqual([[1, 'synthetic'], [2, 'another-synthetic']])
  for (const forged of [{ ...audit(), headers: 'synthetic-private' }, { ...audit(), body: 'synthetic-private' }, { ...audit(), path: '/read?token=synthetic-private' }]) expect(() => appendQaAudit(database, 'run-a', forged, now)).toThrow('QA_AUDIT_METADATA_INVALID')
  expect(JSON.stringify(qaAuditRecords(database, 'run-a'))).not.toContain('synthetic-private')
})
it('audit overflow is durable, never silently short and never repaired by a clean close', () => {
  const insert = database.prepare('INSERT INTO qa_audit(qa_id,sequence,record_json) VALUES(?,?,?)')
  database.transaction(() => { for (let sequence = 1; sequence <= QA_AUDIT_LIMIT; sequence++) insert.run('run-a', sequence, '{}') })()
  writeQaRunAudit(database, 'run-a', { complete: true, open: true, nextSequence: QA_AUDIT_LIMIT + 1, gaps: [] })
  expect(appendQaAudit(database, 'run-a', audit(), now)).toEqual({ recorded: false, complete: false })
  expect(closeQaAudit(database, 'run-a')).toMatchObject({ complete: false, gaps: ['overflow'] })
  expect(qaAuditSummary(database, 'run-a').entries).toBe(QA_AUDIT_LIMIT)
})
it('outer scope, contract revisions and closed term shapes cannot be forged', () => {
  approve()
  for (const changed of [{ qaId: 'another-run' }, { accountRevision: 2 }, { contractSha256: 'c'.repeat(64) }, { request: { ...request().request, origin: 'http://127.0.0.1:4174' } }]) expect(reserveQaGrantUse(database, { ...request(), ...changed }, now).allowed).toBe(false)
  expect(() => askQaGrant(database, { id: 'forged', key: 'forged', terms: { ...terms(), permission: 'unlimited' } as QaGrantTerms }, now)).toThrow('QA_GRANT_INVALID')
  expect(getQaGrant(database, 'forged')).toBeNull()
})
