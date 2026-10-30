// MODULE: database-qa-grant-card.test.ts - synthetic SQLite owner-card binding, lifecycle and transaction proof
import { createRequire } from 'node:module'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_ID, type QaGrantTerms } from '@bmn/protocol'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { COMPANION_OPERATIONS as store } from './database-companion-store'

const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-10-29T13:00:00.000Z'
let database: DatabaseConnection
const terms = (): QaGrantTerms => ({ version: 1, qaId: 'run-a', account: { id: 'synthetic-account', alias: 'Synthetic only', revision: 1 },
  origin: 'http://127.0.0.1:4173', contract: { id: 'synthetic-paid@1', sha256: 'a'.repeat(64) },
  limits: [{ activity: 'report.generate', count: 1 }], expiresAt: '2026-10-29T14:00:00.000Z' })
const ask = () => store.openQaGrantRequest(database, { id: 'grant-a', key: 'plan-a', terms: terms(), incarnationId: 'caller-inc' }, now)
const answer = (card: ReturnType<typeof ask>['card']) => ({ requestId: card.requestId, revision: card.revision,
  approved: true, via: 'app' as const, operationKey: 'owner-a', runIncarnationId: null })
beforeEach(() => {
  database = new Sqlite(':memory:'); initializeDatabase(database, now)
  database.prepare(`INSERT INTO session(session_id,workspace_id,name,cwd,executable,argv_json,revision,created_at,position)
    VALUES('caller',?,'Caller','/synthetic','/bin/bash','[]',1,?,0)`).run(DEFAULT_WORKSPACE_ID, now)
  store.reserveQaRun(database, { id: 'run-a', callerSessionId: 'caller', workspaceId: DEFAULT_WORKSPACE_ID, key: 'run-key',
    inputSha256: 'a'.repeat(64), brief: {}, folder: '/synthetic/qa', state: 'preparing', sessionId: null, incarnationId: null,
    createdAt: now, failure: null, connection: null, result: null })
})
afterEach(() => database.close())
it('opens one immutable, DB-linked card through the real worker operation map', () => {
  const one = ask(), replay = ask()
  expect(replay).toEqual(one)
  expect(store.listAttention(database)).toHaveLength(1)
  expect(one.card).toMatchObject({ qaGrantId: 'grant-a', kind: 'permission', openedBy: 'cli' })
  expect(one.card.body).toContain('Report generation: at most 1')
  expect(one.card.body).not.toMatch(/QA run:|Site contract:|report\.generate/)
  expect(one.grant.state).toBe('pending')
})
it('concurrent held-request retries retain the first expiry while refusing any changed scope', () => {
  const request = { id: 'held-a', key: 'held-a', terms: terms(), incarnationId: 'caller-inc' }
  const first = store.openQaHeldGrantRequest(database, request, now)
  expect(store.openQaHeldGrantRequest(database, { ...request, id: 'ignored-new-id', terms: { ...terms(), expiresAt: '2026-10-29T14:01:00.000Z' } }, now)).toEqual(first)
  expect(() => store.openQaHeldGrantRequest(database, { ...request, terms: { ...terms(), limits: [{ activity: 'report.generate', count: 2 }] } }, now)).toThrow('QA_GRANT_KEY_CONFLICT')
  expect(store.listAttention(database)).toHaveLength(1)
})
it('answers card and grant atomically once; a second answer cannot reuse the card', () => {
  const { card } = ask()
  expect(store.answerQaGrantCard(database, answer(card), now)).toMatchObject({ state: 'answered', resolvedBy: 'owner' })
  expect(store.getQaGrant(database, 'grant-a')).toMatchObject({ state: 'approved', revision: 2, approval: { via: 'app' } })
  expect(() => store.answerQaGrantCard(database, answer(card), now)).toThrow('QA_GRANT_CARD_STALE')
  expect(store.listDrafts(database)).toEqual([])
})
it('rolls approval back if closing the actual card fails', () => {
  const { card } = ask()
  database.exec("CREATE TRIGGER fail_card_close BEFORE UPDATE ON attention_request WHEN NEW.state = 'answered' BEGIN SELECT RAISE(ABORT, 'synthetic card close failure'); END")
  expect(() => store.answerQaGrantCard(database, answer(card), now)).toThrow('synthetic card close failure')
  expect(store.getQaGrant(database, 'grant-a')?.state).toBe('pending')
  expect(store.getAttention(database, card.requestId).state).toBe('open')
})
it.each(['title', 'body', 'manual_choices_json', 'revision', 'expires_at'] as const)('rejects changed %s without any approval', field => {
  const { card } = ask()
  const value = field === 'revision' ? 99 : field === 'manual_choices_json' ? '{}' : 'changed'
  database.prepare(`UPDATE attention_request SET ${field} = ? WHERE request_id = ?`).run(value, card.requestId)
  expect(() => store.answerQaGrantCard(database, answer(card), now)).toThrow('QA_GRANT_CARD_STALE')
  expect(store.getQaGrant(database, 'grant-a')?.state).toBe('pending')
})
it.each(['answered', 'withdrawn'] as const)('Mark answered or Dismiss (%s) closes no permission', state => {
  const { card } = ask()
  store.closeAttention(database, { requestId: card.requestId }, state, 'Reminder cleared', now, 'owner')
  expect(() => store.answerQaGrantCard(database, answer(card), now)).toThrow('QA_GRANT_CARD_STALE')
  expect(store.getQaGrant(database, 'grant-a')?.state).toBe('pending')
})
it('refuses expired cards and stopped runs', () => {
  const { card } = ask()
  expect(() => store.answerQaGrantCard(database, answer(card), '2026-10-29T14:01:00.000Z')).toThrow('QA_GRANT_ANSWER_STALE')
  store.finishQaRun(database, 'run-a', { state: 'stopped', failure: null, result: null })
  expect(() => store.answerQaGrantCard(database, answer(card), now)).toThrow('QA_GRANT_CARD_STALE')
  expect(store.getQaGrant(database, 'grant-a')?.state).toBe('pending')
})
it('a look-alike key, origin and text never create a grant link', () => {
  const card = store.openAttention(database, { sessionId: 'caller', incarnationId: null, requestKey: 'qa-look-alike',
    origin: 'cli', kind: 'permission', title: 'Allow these QA activities?', body: 'Approved',
    manualChoices: { options: [{ label: 'Approve', description: null }, { label: 'Deny', description: null }], allowOther: true } }, 'fake-card', now)
  expect(card.qaGrantId).toBeUndefined()
  expect(() => store.answerQaGrantCard(database, answer(card), now)).toThrow('QA_GRANT_CARD_STALE')
  expect(database.prepare('SELECT COUNT(*) AS n FROM qa_grant').get()).toEqual({ n: 0 })
})
