// MODULE: qa-grants.test.ts - real SQLite broker checks; injected native proof is not qualification evidence
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_ID, type QaGrant, type QaRun, type QaUseRequest } from '@bmn/protocol'
import { syntheticPaidContract } from '../../bin/qa-request-gate.mjs'
import { COMPANION_OPERATIONS as store } from './database-companion-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import type { DatabaseWorkerClient } from './database-client'
import { QaGrantBroker, type QaAccountMetadata } from './qa-grants'

const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-10-29T13:00:00.000Z', origin = 'http://127.0.0.1:4173', contract = syntheticPaidContract(origin)
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
let database: DatabaseConnection, broker: QaGrantBroker, run: QaRun, account: QaAccountMetadata
let qualified = true, incarnation: string | undefined = 'qa-inc', supported = true, clock = now
const changed = vi.fn()
const ask = (): Promise<QaGrant> => broker.ask(run, { key: 'planning-1', accountId: account.id, origin,
  limits: [{ activity: 'report.generate', count: 1 }, { activity: 'brainstorm.start', count: 1 }], expiresAt: '2026-10-29T14:00:00.000Z' }, 'caller-inc')
function approve(grant: QaGrant): void {
  store.answerQaGrantCard(database, { requestId: grant.card!.id, revision: grant.card!.revision, approved: true,
    via: 'app', operationKey: 'owner-1', runIncarnationId: 'qa-inc' }, now)
}
const use = (grant: QaGrant, id = 'use-1'): Omit<QaUseRequest, 'qaId' | 'accountRevision' | 'contractSha256'> => {
  const request = { method: 'POST', origin, path: '/paid/report', queryKeys: [] }
  return { id, grantId: grant.id, activity: 'report.generate', request, requestSha256: hash(request) }
}
beforeEach(() => {
  database = new Sqlite(':memory:'); initializeDatabase(database, now)
  for (const [id, cwd, argv] of [['caller', '/synthetic', '[]'], ['qa', '/synthetic/qa', '["--run","run-a"]']] as const) {
    database.prepare('INSERT INTO session(session_id,workspace_id,name,cwd,executable,argv_json,revision,created_at,position) VALUES(?,?,?, ?,?, ?,1,?,0)')
      .run(id, DEFAULT_WORKSPACE_ID, id, cwd, '/bin/bash', argv, now)
  }
  store.reserveQaRun(database, { id: 'run-a', callerSessionId: 'caller', workspaceId: DEFAULT_WORKSPACE_ID, key: 'run-key', inputSha256: 'a'.repeat(64),
    brief: { accounts: [{ alias: 'Synthetic only', permission: 'look-only' }] }, folder: '/synthetic/qa', state: 'preparing', sessionId: null, incarnationId: null,
    createdAt: now, failure: null, connection: null, result: null })
  store.bindQaRun(database, 'run-a', 'qa', 'qa-inc')
  store.bindQaAgent(database, 'run-a', { pid: 101, ticks: '100', at: now })
  store.connectQaRelay(database, 'run-a', { pid: 102, ticks: '101', at: now })
  run = store.getQaRun(database, 'run-a')!
  account = { id: 'synthetic-account', name: 'Synthetic only', origins: [origin], test: false, qaRevision: 1 }
  const operations = store as unknown as Record<string, (...args: unknown[]) => unknown>
  const client = { companion: async (name: string, ...args: unknown[]) => operations[name]!(database, ...args) } as unknown as DatabaseWorkerClient
  qualified = true; incarnation = 'qa-inc'; supported = true; clock = now; changed.mockClear()
  broker = new QaGrantBroker({ database: client, account: () => account, contract: () => supported ? contract : null,
    qualified: () => qualified, live: () => incarnation, now: () => clock, changed })
})
afterEach(() => database.close())

it('creates an immutable actual owner card from authoritative metadata, without granting an activity', async () => {
  const grant = await ask()
  expect(grant.terms).toMatchObject({ account: { id: account.id, alias: account.name, revision: 1 }, contract: { id: contract.id, sha256: contract.sha256 } })
  expect(store.getAttention(database, grant.card!.id)).toMatchObject({ state: 'open', qaGrantId: grant.id })
  expect(await broker.reserve(run, use(grant))).toMatchObject({ allowed: false, reason: 'not-approved' })
  expect(changed).toHaveBeenCalledWith('caller')
})
it('permits one exact approved activity and never refills it after settlement', async () => {
  const grant = await ask(); approve(grant)
  expect((await broker.reserve(run, use(grant))).allowed).toBe(true)
  expect((await broker.send(run, 'use-1')).allowed).toBe(true)
  await broker.settle(run, 'use-1', 'succeeded', 200)
  expect(await broker.reserve(run, use(grant, 'extra'))).toMatchObject({ allowed: false, reason: 'exhausted' })
})
it('refuses a native qualification gap or stopped incarnation before reserving or sending', async () => {
  const grant = await ask(); approve(grant)
  qualified = false
  await expect(broker.reserve(run, use(grant))).rejects.toThrow('QA_NATIVE_QUALIFICATION_REQUIRED')
  qualified = true; incarnation = undefined
  await expect(broker.reserve(run, use(grant))).rejects.toThrow('QA_RUN_UNAVAILABLE')
  expect(store.getQaGrantUse(database, 'use-1')).toBeNull()
})
it('requires the current host contract and account site before opening a card', async () => {
  supported = false; await expect(ask()).rejects.toThrow('QA_SITE_UNSUPPORTED')
  supported = true; account.origins = []
  await expect(ask()).rejects.toThrow('QA_ACCOUNT_SITE_MISMATCH')
  expect(store.listAttention(database)).toEqual([])
})
it('cannot select an account absent from the curated scope', async () => {
  account.name = 'Outside the brief'
  await expect(ask()).rejects.toThrow('QA_ACCOUNT_OUT_OF_SCOPE')
})
it('rejects a grant belonging to another run', async () => {
  const grant = await ask(); approve(grant)
  await expect(broker.reserve({ ...run, id: 'run-other' }, use(grant))).rejects.toThrow('QA_GRANT_NOT_FOUND')
})
it('binds the activity to the reviewed endpoint instead of trusting the relay activity label', async () => {
  const grant = await ask(); approve(grant)
  await expect(broker.reserve(run, { ...use(grant), activity: 'brainstorm.start' })).rejects.toThrow('QA_ACTIVITY_CONTRACT_MISMATCH')
  const request = { method: 'POST', origin, path: '/unreviewed', queryKeys: [] }
  await expect(broker.reserve(run, { ...use(grant), request, requestSha256: hash(request) })).rejects.toThrow('QA_ACTIVITY_CONTRACT_MISMATCH')
})
it('never sends a reservation after the trusted metadata revision changes', async () => {
  const grant = await ask(); approve(grant); await broker.reserve(run, use(grant))
  account.qaRevision++
  await expect(broker.send(run, 'use-1')).rejects.toThrow('QA_GRANT_SCOPE_CHANGED')
  expect(store.getQaGrantUse(database, 'use-1')?.state).toBe('reserved')
  store.recoverQaGrantUses(database, now)
  expect(store.getQaGrantUse(database, 'use-1')?.state).toBe('uncertain')
})
it('expiry between reserve and send preserves the spent reservation', async () => {
  const grant = await ask(); approve(grant); await broker.reserve(run, use(grant))
  clock = '2026-10-29T14:01:00.000Z'
  expect(await broker.send(run, 'use-1')).toMatchObject({ allowed: false, use: { state: 'uncertain' } })
})
it('refuses to audit an activity as a read and redacts unsupported paths', async () => {
  await expect(broker.observe(run, account.id, use({ id: 'unused' } as QaGrant).request)).rejects.toThrow('QA_ACTIVITY_RESERVATION_REQUIRED')
  await broker.observe(run, account.id, { method: 'POST', origin, path: '/secret-path-value', queryKeys: [] }, true)
  const records = store.qaAuditRecords(database, run.id)
  expect(records).toHaveLength(1); expect(records[0]!.path).toBe('/[unclassified]')
  expect(JSON.stringify(records)).not.toContain('secret-path-value')
})
it('an exhausted activity opens one pending request card, with stable terms on retries', async () => {
  const grant = await ask(); approve(grant)
  const first = await broker.hold(run, account.id, use(grant).request, 'exhausted')
  clock = '2026-10-29T13:01:00.000Z'
  expect(await broker.hold(run, account.id, use(grant).request, 'exhausted')).toEqual(first)
  expect(first).toMatchObject({ state: 'pending', terms: { limits: [{ activity: 'report.generate', count: 1 }] } })
  expect(store.listAttention(database)).toHaveLength(2)
})
it('unsupported activity paths are held without offering an unsupported exception card', async () => {
  expect(await broker.hold(run, account.id, { method: 'POST', origin, path: '/unsupported', queryKeys: [] }, 'unsupported-request')).toBeNull()
  expect(store.listAttention(database)).toHaveLength(0)
  expect(store.qaAuditRecords(database, run.id)[0]).toMatchObject({ path: '/[unclassified]', result: 'held', cardId: null })
})
