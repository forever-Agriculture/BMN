// MODULE: qa-account-modes.test.ts - the host decides each QA account pick and audits refused interaction (100.6, d68)
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_ID, type QaGrant, type QaRun } from '@bmn/protocol'
import { syntheticPaidContract } from '../../bin/qa-request-gate.mjs'
import { COMPANION_OPERATIONS as store } from './database-companion-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import type { DatabaseWorkerClient } from './database-client'
import { QaGrantBroker, type QaAccountMetadata } from './qa-grants'

const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-10-29T13:00:00.000Z', origin = 'http://127.0.0.1:4173', contract = syntheticPaidContract(origin)
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const report = { method: 'POST', origin, path: '/paid/report', queryKeys: [] }
let database: DatabaseConnection, broker: QaGrantBroker, run: QaRun, qualified = true
const accounts: Record<string, QaAccountMetadata> = {
  'Synthetic test': { id: 'account-test', name: 'Synthetic test', origins: [origin], test: true, qaRevision: 1 },
  'Synthetic look': { id: 'account-look', name: 'Synthetic look', origins: [origin], test: false, qaRevision: 1 },
  'Synthetic granted': { id: 'account-granted', name: 'Synthetic granted', origins: [origin], test: false, qaRevision: 1 },
  'Synthetic marked but look': { id: 'account-marked', name: 'Synthetic marked but look', origins: [origin], test: true, qaRevision: 1 },
  'Outside the brief': { id: 'account-outside', name: 'Outside the brief', origins: [origin], test: true, qaRevision: 1 }
}
const byIdOrName = (key: string): QaAccountMetadata => accounts[key] ?? Object.values(accounts).find(account => account.id === key) ?? (() => { throw new Error('ACCOUNT_MISSING') })()
const grantFor = async (key: string, accountId: string, count = 1): Promise<QaGrant> => {
  const grant = await broker.ask(run, { key, accountId, origin, limits: [{ activity: 'report.generate', count }], expiresAt: '2026-10-29T14:00:00.000Z' }, 'caller-inc')
  store.answerQaGrantCard(database, { requestId: grant.card!.id, revision: grant.card!.revision, approved: true, via: 'app', operationKey: `owner-${key}`, runIncarnationId: 'qa-inc' }, now)
  return grant
}
beforeEach(() => {
  database = new Sqlite(':memory:'); initializeDatabase(database, now)
  for (const [id, cwd, argv] of [['caller', '/synthetic', '[]'], ['qa', '/synthetic/qa', '["--run","run-a"]']] as const) {
    database.prepare('INSERT INTO session(session_id,workspace_id,name,cwd,executable,argv_json,revision,created_at,position) VALUES(?,?,?, ?,?, ?,1,?,0)')
      .run(id, DEFAULT_WORKSPACE_ID, id, cwd, '/bin/bash', argv, now)
  }
  store.reserveQaRun(database, { id: 'run-a', callerSessionId: 'caller', workspaceId: DEFAULT_WORKSPACE_ID, key: 'run-key', inputSha256: 'a'.repeat(64),
    brief: { version: 2, revision: 'synthetic', accounts: [{ alias: 'Synthetic test', intent: 'test-full' }, { alias: 'Synthetic look', intent: 'look-only' },
      { alias: 'Synthetic granted', intent: 'ordinary-granted' }, { alias: 'Synthetic marked but look', intent: 'look-only' }] },
    folder: '/synthetic/qa', state: 'preparing', sessionId: null, incarnationId: null, createdAt: now, failure: null, connection: null, result: null })
  store.bindQaRun(database, 'run-a', 'qa', 'qa-inc')
  store.bindQaAgent(database, 'run-a', { pid: 101, ticks: '100', at: now })
  store.connectQaRelay(database, 'run-a', { pid: 102, ticks: '101', at: now })
  run = store.getQaRun(database, 'run-a')!
  qualified = true
  const operations = store as unknown as Record<string, (...args: unknown[]) => unknown>
  const client = { companion: async (name: string, ...args: unknown[]) => operations[name]!(database, ...args) } as unknown as DatabaseWorkerClient
  broker = new QaGrantBroker({ database: client, account: byIdOrName, contract: () => contract, qualified: () => qualified, live: () => 'qa-inc', now: () => now, changed: () => {} })
})
afterEach(() => database.close())

it('a marked test account under a test-full alias is the only full-interaction pick', async () => {
  expect(await broker.pick(run, 'Synthetic test')).toEqual({ accountId: 'account-test', alias: 'Synthetic test', mode: 'test-full', origins: [origin] })
  expect((await broker.pick(run, 'Synthetic marked but look')).mode).toBe('look-only')
  expect((await broker.pick(run, 'Synthetic look')).mode).toBe('look-only')
})
it('an ordinary-granted alias stays look-only until an approved grant exists, then interacts', async () => {
  expect((await broker.pick(run, 'Synthetic granted')).mode).toBe('look-only')
  await grantFor('planning', 'Synthetic granted')
  expect((await broker.pick(run, 'Synthetic granted')).mode).toBe('ordinary-granted')
})
it('names outside the brief, and runs without their own qualification, are refused', async () => {
  await expect(broker.pick(run, 'Outside the brief')).rejects.toThrow('QA_ACCOUNT_OUT_OF_SCOPE')
  qualified = false
  await expect(broker.pick(run, 'Synthetic test')).rejects.toThrow('QA_NATIVE_QUALIFICATION_REQUIRED')
})
it('a version 1 run never opens an account, whatever its brief names', async () => {
  database.prepare('INSERT INTO session(session_id,workspace_id,name,cwd,executable,argv_json,revision,created_at,position) VALUES(?,?,?, ?,?, ?,1,?,0)')
    .run('qa-v1', DEFAULT_WORKSPACE_ID, 'qa-v1', '/synthetic/qa-v1', '/bin/bash', '["--run","run-v1"]', now)
  store.reserveQaRun(database, { id: 'run-v1', callerSessionId: 'caller', workspaceId: DEFAULT_WORKSPACE_ID, key: 'run-v1-key', inputSha256: 'b'.repeat(64),
    brief: { version: 1, revision: 'synthetic', accounts: [{ alias: 'Synthetic test', permission: 'test' }] },
    folder: '/synthetic/qa-v1', state: 'preparing', sessionId: null, incarnationId: null, createdAt: now, failure: null, connection: null, result: null })
  store.bindQaRun(database, 'run-v1', 'qa-v1', 'qa-inc')
  store.bindQaAgent(database, 'run-v1', { pid: 201, ticks: '200', at: now })
  store.connectQaRelay(database, 'run-v1', { pid: 202, ticks: '201', at: now })
  await expect(broker.pick(store.getQaRun(database, 'run-v1')!, 'Synthetic test')).rejects.toThrow('QA_ACCOUNTS_REQUIRE_V2')
})
it('a refused interaction is audited with the tool name and no page data', async () => {
  await broker.refuse(run, 'account-look', 'browser_click')
  expect(store.qaAuditRecords(database, 'run-a')).toMatchObject([{ method: 'TOOL', path: '/[tool]/browser_click', accountAlias: 'Synthetic look', result: 'held', classification: 'unknown' }])
  await expect(broker.refuse(run, 'account-look', 'browser_click; drop')).rejects.toThrow('QA_REQUEST_INVALID')
})
it('a reservation without a named grant uses the next approved grant and never one of another account', async () => {
  const first = await grantFor('one', 'Synthetic granted'), second = await grantFor('two', 'Synthetic granted')
  await grantFor('other', 'Synthetic test', 3)
  const reserve = (id: string) => broker.reserve(run, { id, grantId: null, accountId: 'account-granted', activity: 'report.generate', request: report, requestSha256: hash(report) })
  const used = []
  for (const id of ['use-a', 'use-b']) {
    const decision = await reserve(id)
    expect(decision.allowed).toBe(true)
    used.push(decision.use!.grantId)
    await broker.send(run, id); await broker.settle(run, id, 'succeeded', 200)
  }
  expect(used.sort()).toEqual([first.id, second.id].sort())
  expect(await reserve('use-c')).toMatchObject({ allowed: false, reason: 'exhausted' })
  expect(await broker.reserve(run, { id: 'use-d', grantId: null, accountId: 'account-look', activity: 'report.generate', request: report, requestSha256: hash(report) }))
    .toMatchObject({ allowed: false, reason: 'not-approved' })
})
it('a lead may ask by the brief alias; the grant binds the stored account identity', async () => {
  const grant = await broker.ask(run, { key: 'by-name', accountId: 'Synthetic granted', origin, limits: [{ activity: 'brainstorm.start', count: 1 }], expiresAt: '2026-10-29T14:00:00.000Z' }, 'caller-inc')
  expect(grant.terms.account).toEqual({ id: 'account-granted', alias: 'Synthetic granted', revision: 1 })
})
it('a look-only account reads its unreviewed site through audited GETs; writes and other sites never pass (d71)', async () => {
  const shop = 'https://shop.example', look = { ...accounts['Synthetic look']!, origins: [origin, shop] }
  const operations = store as unknown as Record<string, (...args: unknown[]) => unknown>
  const client = { companion: async (name: string, ...args: unknown[]) => operations[name]!(database, ...args) } as unknown as DatabaseWorkerClient
  const sites = new QaGrantBroker({ database: client, account: key => key === look.id || key === look.name ? look : byIdOrName(key),
    contract: site => site === origin ? contract : null, qualified: () => true, live: () => 'qa-inc', now: () => now, changed: () => {} })
  await sites.observe(run, look.id, { method: 'GET', origin: shop, path: '/[unreviewed]', queryKeys: ['page'] })
  for (const meta of [{ method: 'POST', origin: shop, path: '/[unclassified]', queryKeys: [] }, { method: 'GET', origin: 'https://tracker.example', path: '/[unreviewed]', queryKeys: [] },
    { method: 'GET', origin, path: '/[unreviewed]', queryKeys: [] }]) await expect(sites.observe(run, look.id, meta)).rejects.toThrow('QA_ACTIVITY_RESERVATION_REQUIRED')
  await sites.observe(run, look.id, { method: 'POST', origin: shop, path: '/[unclassified]', queryKeys: [] }, true)
  expect(store.qaAuditRecords(database, 'run-a')).toMatchObject([
    { method: 'GET', origin: shop, path: '/[unreviewed]', queryKeys: ['page'], classification: 'read', result: 'observed' },
    { method: 'POST', origin: shop, path: '/[unclassified]', classification: 'unknown', result: 'held' }])
})
