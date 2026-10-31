// MODULE: qa-piche-host.test.ts - Epic 101.2 host side: the broker re-checks Piche reads from closed metadata on a real SQLite audit
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_ID, type QaRequestMeta, type QaRun } from '@bmn/protocol'
import { PICHE_TEST_ORIGINS, picheReadContract } from '../../bin/qa-request-gate.mjs'
import { COMPANION_OPERATIONS as store } from './database-companion-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import type { DatabaseWorkerClient } from './database-client'
import { QaGrantBroker, type QaAccountMetadata } from './qa-grants'
import { shippedQaAccounts, testQaPicheOrigins } from './qa-sessions'

const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-10-31T21:00:00.000Z', contract = picheReadContract(), { page, api, signIn } = PICHE_TEST_ORIGINS
const sha = 'c'.repeat(64)
let database: DatabaseConnection, broker: QaGrantBroker, run: QaRun, account: QaAccountMetadata
const read = (name = 'AutomationRun'): QaRequestMeta => ({ method: 'POST', origin: api, path: '/graphql', queryKeys: [], body: { kind: 'graphql', operation: 'query', name, sha256: sha } })
const renewal: QaRequestMeta = { method: 'POST', origin: signIn, path: '/realms/piche/protocol/openid-connect/token', queryKeys: [], body: { kind: 'form', grant: 'refresh_token' } }
const records = () => store.qaAuditRecords(database, 'run-a')
beforeEach(() => {
  database = new Sqlite(':memory:'); initializeDatabase(database, now)
  for (const [id, cwd, argv] of [['caller', '/synthetic', '[]'], ['qa', '/synthetic/qa', '["--run","run-a"]']] as const) {
    database.prepare('INSERT INTO session(session_id,workspace_id,name,cwd,executable,argv_json,revision,created_at,position) VALUES(?,?,?, ?,?, ?,1,?,0)')
      .run(id, DEFAULT_WORKSPACE_ID, id, cwd, '/bin/bash', argv, now)
  }
  store.reserveQaRun(database, { id: 'run-a', callerSessionId: 'caller', workspaceId: DEFAULT_WORKSPACE_ID, key: 'run-key', inputSha256: 'a'.repeat(64),
    brief: { version: 2, accounts: [{ alias: 'Synthetic Piche', intent: 'look-only' }, { alias: 'Synthetic Piche test', intent: 'test-full' }] }, folder: '/synthetic/qa', state: 'preparing',
    sessionId: null, incarnationId: null, createdAt: now, failure: null, connection: null, result: null })
  store.bindQaRun(database, 'run-a', 'qa', 'qa-inc')
  store.bindQaAgent(database, 'run-a', { pid: 101, ticks: '100', at: now })
  store.connectQaRelay(database, 'run-a', { pid: 102, ticks: '101', at: now })
  run = store.getQaRun(database, 'run-a')!
  account = { id: 'synthetic-piche', name: 'Synthetic Piche', origins: [page, signIn], test: false, qaRevision: 1 }
  const operations = store as unknown as Record<string, (...args: unknown[]) => unknown>
  const client = { companion: async (name: string, ...args: unknown[]) => operations[name]!(database, ...args) } as unknown as DatabaseWorkerClient
  broker = new QaGrantBroker({ database: client, account: () => account, contract: origin => Object.values(contract.origins).includes(origin) ? contract : null,
    qualified: () => true, live: () => 'qa-inc', now: () => now, changed: () => {} })
})
afterEach(() => database.close())

it('records a reviewed read on the derived API origin with its closed detail only', async () => {
  await broker.observe(run, account.id, read())
  expect(records()).toMatchObject([{ origin: api, path: '/graphql', classification: 'read', result: 'observed', status: null, body: read().body }])
})
it('refuses an unreviewed or mutating detail, and any read for an account not bound to the page origin', async () => {
  await expect(broker.observe(run, account.id, read('ChatList'))).rejects.toThrow('QA_ACTIVITY_RESERVATION_REQUIRED')
  await expect(broker.observe(run, account.id, { ...read(), body: { kind: 'graphql', operation: 'mutation', name: null, sha256: sha } })).rejects.toThrow('QA_ACTIVITY_RESERVATION_REQUIRED')
  account = { ...account, origins: [signIn] }
  await expect(broker.observe(run, account.id, read())).rejects.toThrow('QA_ACTIVITY_RESERVATION_REQUIRED')
  expect(records()).toEqual([])
})
it('records the renewal and its reply status, and status nowhere else', async () => {
  await broker.observe(run, account.id, renewal)
  await broker.observe(run, account.id, renewal, false, 200)
  expect(records().map(row => [row.path, row.result, row.status, row.body])).toEqual([
    [renewal.path, 'observed', null, { kind: 'form', grant: 'refresh_token' }], [renewal.path, 'succeeded', 200, { kind: 'form', grant: 'refresh_token' }]])
  await expect(broker.observe(run, account.id, read(), false, 200)).rejects.toThrow('QA_REQUEST_INVALID')
  await expect(broker.observe(run, account.id, renewal, true, 200)).rejects.toThrow('QA_REQUEST_INVALID')
})
it('holds a Piche mutation as an audited request without a name or an owner card', async () => {
  const held: QaRequestMeta = { ...read(), body: { kind: 'graphql', operation: 'mutation', name: null, sha256: sha } }
  expect(await broker.hold(run, account.id, held, 'unsupported-request')).toBeNull()
  await broker.observe(run, account.id, held, true)
  expect(records().map(row => [row.classification, row.result, row.cardId, row.body])).toEqual([['unknown', 'held', null, held.body], ['unknown', 'held', null, held.body]])
})
it('a test account bound to the page origin owns the API origin', async () => {
  account = { ...account, id: 'synthetic-piche-test', name: 'Synthetic Piche test', test: true }
  await broker.observe(run, account.id, { method: 'POST', origin: api, path: '/graphql', queryKeys: [], body: { kind: 'graphql', operation: 'mutation', name: null, sha256: sha } })
  expect(records()).toMatchObject([{ origin: api, classification: 'test-full', result: 'observed' }])
  await expect(broker.observe(run, account.id, { method: 'GET', origin: 'https://attachments-epic5.gpark.lv', path: '/[unclassified]', queryKeys: [] })).rejects.toThrow('QA_ACCOUNT_SITE_MISMATCH')
})
it('seals records that carry body details', async () => {
  await broker.observe(run, account.id, read()); await broker.observe(run, account.id, renewal, false, 200)
  const summary = await broker.summary(run)
  expect(summary.audit.entries).toBe(2)
  expect(summary.audit.observedTraffic).toEqual(expect.arrayContaining([expect.objectContaining({ origin: api, classification: 'read', result: 'observed', count: 1 }),
    expect.objectContaining({ origin: signIn, classification: 'read', result: 'succeeded', count: 1 })]))
})
it('the host always registers the Piche contract and adds a loopback twin only in a test host', () => {
  const shipped = shippedQaAccounts('/synthetic/cli/bmn.mjs', () => {})
  expect(shipped.reviewed).toEqual([{ id: 'piche-test-read@1', origins: { ...PICHE_TEST_ORIGINS } }])
  expect(shipped.contract(api)).toMatchObject({ id: 'piche-test-read@1' }); expect(shipped.contract('https://epic5.piche.it')).toBeNull()
  const twin = { page: 'http://127.0.0.1:5101', api: 'http://127.0.0.1:5102', signIn: 'http://127.0.0.1:5103' }
  const env = { BMN_TEST_QA_PICHE_ORIGINS: Object.values(twin).join(',') }
  expect(testQaPicheOrigins(['--bmn-test-host'], env)).toEqual(twin)
  expect(testQaPicheOrigins([], env)).toBeNull()
  expect(testQaPicheOrigins(['--bmn-test-host'], { BMN_TEST_QA_PICHE_ORIGINS: 'https://epic5web.gpark.lv,http://127.0.0.1:5102,http://127.0.0.1:5103' })).toBeNull()
  expect(shippedQaAccounts('/synthetic/cli/bmn.mjs', () => {}, null, twin).reviewed).toHaveLength(2)
})
