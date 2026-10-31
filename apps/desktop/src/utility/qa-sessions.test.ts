// MODULE: qa-sessions.test.ts - authenticated ownership, no duplicate launch and named QA completion failures
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { DEFAULT_WORKSPACE_ID, type QaRun } from '@bmn/protocol'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { selectSession } from './database-workspace-store'
import { QA_OPERATIONS, connectQaRelay, bindQaAgent } from './database-qa-store'
import type { DatabaseWorkerClient } from './database-client'
import { QaSessions, shippedQaAccounts, testQaContractOrigin, type QaSessionsOptions } from './qa-sessions'

const require = createRequire(import.meta.url)
const Sqlite = require('better-sqlite3') as new (path: string) => DatabaseConnection
const cliPath = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
let db: DatabaseConnection, root: string, options: QaSessionsOptions, qa: QaSessions
const live = new Map<string, string>()
const scope = { kind: 'session', sessionId: 'caller', incarnationId: 'caller-inc' } as const
const now = '2026-10-29T10:44:00.000Z'
const brief = () => ({ version: 1, mode: 'session', revision: 'synthetic', target: 'http://127.0.0.1:4173', goal: 'Select a product', why: 'Keep the selection',
  scope: { included: ['Cart'], excluded: ['Payment'] }, decisions: [], designs: [], regression_checklist: [], starting_state: 'Empty', fixtures: ['Synthetic'], accounts: [], time_budget_minutes: 3,
  criteria: [{ id: 'AC1', description: 'Cart retains the selection', mandatory: true }] })
function session(id: string, cwd = root, argv: string[] = []): void {
  db.prepare(`INSERT INTO session(session_id,workspace_id,name,cwd,executable,argv_json,revision,created_at,position)
    VALUES(?,?,?,?,'/usr/bin/env',?,1,?,0)`).run(id, DEFAULT_WORKSPACE_ID, id, cwd, JSON.stringify(argv), now)
}
beforeEach(() => {
  db = new Sqlite(':memory:'); initializeDatabase(db, now)
  root = mkdtempSync(join(tmpdir(), 'bmn-qa-session-')); session('caller'); live.set('caller', 'caller-inc')
  const database = { companion: async (name: keyof typeof QA_OPERATIONS, ...args: unknown[]) => Reflect.apply(QA_OPERATIONS[name], undefined, [db, ...args]) } as unknown as DatabaseWorkerClient
  options = { database, data: root, cliPath, session: id => { try { return selectSession(db, id) } catch { return undefined } }, live: id => live.get(id), processId: () => undefined,
    launch: vi.fn(async request => { session('qa-pane', request.folder, ['--run', request.qaId]); live.set('qa-pane', 'qa-inc'); return { qa: { sessionId: 'qa-pane', incarnationId: 'qa-inc' } } }),
    stop: vi.fn(async id => { live.delete(id) }), now: () => now }
  qa = new QaSessions(options)
})
afterEach(() => { db.close(); live.clear(); rmSync(root, { recursive: true, force: true }) })
const start = () => qa.request(scope, 'qa.start', { key: 'key-a', brief: brief() }) as Promise<QaRun>
it('rejects owner-token starts, unknown callers and ended incarnations', async () => {
  await expect(qa.request({ kind: 'owner' }, 'qa.start', {})).rejects.toThrow('Only the QA caller')
  live.delete('caller'); await expect(start()).rejects.toThrow('QA_CALLER_INVALID')
  expect(options.launch).not.toHaveBeenCalled()
})
it('binds once; a repeated request after reconstructing the coordinator finds the same pane', async () => {
  const first = await start(); qa = new QaSessions(options)
  expect(await start()).toEqual(first)
  expect(options.launch).toHaveBeenCalledTimes(1)
  expect(first).toMatchObject({ state: 'running', sessionId: 'qa-pane', incarnationId: 'qa-inc' })
  await expect(qa.request(scope, 'qa.start', { key: 'key-a', brief: { ...brief(), revision: 'changed' } })).rejects.toThrow('QA_KEY_CONFLICT')
})
it('another session cannot read or stop the report; the owner can read it', async () => {
  const run = await start()
  const other = { kind: 'session', sessionId: 'other', incarnationId: 'other-inc' } as const
  await expect(qa.request(other, 'qa.status', { id: run.id })).rejects.toThrow('Only the QA caller')
  await expect(qa.request(other, 'qa.stop', { id: run.id })).rejects.toThrow('Only the QA caller')
  expect(await qa.request({ kind: 'owner' }, 'qa.status', { id: run.id })).toEqual(run)
})
it('ordinary sessions have no QA account policy; a forged process cannot attest a relay', async () => {
  await start()
  expect(await qa.request(scope, 'qa.policy', {})).toEqual({ qaId: null, accounts: false })
  await expect(qa.request({ kind: 'session', sessionId: 'qa-pane', incarnationId: 'qa-inc' }, 'qa.connect', { pid: process.pid, ticks: 'forged' })).rejects.toThrow('QA_RELAY_IDENTITY_INVALID')
})
it('stop targets the exact QA incarnation and keeps its local files', async () => {
  const run = await start(); mkdirSync(run.folder, { recursive: true }); writeFileSync(join(run.folder, 'retained.txt'), 'synthetic evidence')
  const stopped = await qa.request(scope, 'qa.stop', { id: run.id }) as QaRun
  expect(options.stop).toHaveBeenCalledWith('qa-pane', 'qa-inc')
  expect(stopped.state).toBe('stopped')
  expect((await import('node:fs')).readFileSync(join(run.folder, 'retained.txt'), 'utf8')).toBe('synthetic evidence')
})
it('an ended pane without a native relay has a named failure, never a verdict', async () => {
  const run = await start(); live.delete('qa-pane')
  expect(await qa.request(scope, 'qa.status', { id: run.id })).toMatchObject({ state: 'failed', failure: 'QA_RELAY_UNPROVEN', result: null })
})
it('an attested ended pane without a report names the missing report', async () => {
  const run = await start(); bindQaAgent(db, run.id, { pid: 1111, ticks: '2222', at: now }); connectQaRelay(db, run.id, { pid: 1234, ticks: '5678', at: now }); live.delete('qa-pane')
  expect(await qa.request(scope, 'qa.status', { id: run.id })).toMatchObject({ state: 'failed', failure: 'QA_REPORT_MISSING', result: null })
})
it('a provider/main refusal retains the keyed failure without retrying a launch', async () => {
  options.launch = vi.fn(async () => ({ qaFailure: 'QA_PROVIDER_REFUSED' })); qa = new QaSessions(options)
  expect(await start()).toMatchObject({ state: 'failed', failure: 'QA_PROVIDER_REFUSED' })
  await start(); expect(options.launch).toHaveBeenCalledTimes(1)
})

it('Linux process proof accepts the registered native parent and rejects stale identity or an unregistered agent', async () => {
  const run = await start(); const folder = run.folder, bin = join(root, 'bin')
  mkdirSync(folder, { recursive: true }); mkdirSync(bin)
  const relayFile = join(bin, 'qa-browser-relay.mjs'), agentFile = join(root, 'agent.mjs')
  writeFileSync(relayFile, "const timer=setTimeout(()=>process.exit(0),10000);process.stdin.resume();process.stdin.on('end',()=>clearTimeout(timer))")
  writeFileSync(agentFile, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:['pipe','ignore','inherit']});
const timer=setTimeout(()=>{child.stdin.end();process.stdin.destroy()},10000);
process.stdin.resume();process.stdin.on('end',()=>child.stdin.end());
child.on('exit',()=>{clearTimeout(timer);process.stdin.destroy()});
child.on('spawn',()=>console.log(JSON.stringify({relay:child.pid})));`)
  const command = [process.execPath, agentFile, relayFile, folder], node = statSync(process.execPath, { bigint: true })
  writeFileSync(join(folder, 'launch.json'), JSON.stringify({ built: { command }, identity: { launcher: { real: realpathSync(process.execPath) }, payload: { dev: String(node.dev), ino: String(node.ino) } } }))
  options.processId = () => process.pid; options.cliPath = join(bin, 'bmn')
  const child = spawn(command[0]!, command.slice(1), { cwd: folder, stdio: ['pipe', 'pipe', 'inherit'] })
  const exited = once(child, 'exit')
  const ticks = (pid: number): string => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19]!
  try {
    const [data] = await once(child.stdout!, 'data')
    const relay = (JSON.parse(String(data)) as { relay: number }).relay
    const qaScope = { kind: 'session', sessionId: 'qa-pane', incarnationId: 'qa-inc' } as const
    await expect(qa.request(qaScope, 'qa.connect', { pid: relay, ticks: ticks(relay) })).rejects.toThrow('QA_RELAY_IDENTITY_INVALID')
    await expect(qa.request(qaScope, 'qa.agent', { pid: child.pid!, ticks: 'stale' })).rejects.toThrow('QA_AGENT_IDENTITY_INVALID')
    expect(await qa.request(qaScope, 'qa.agent', { pid: child.pid!, ticks: ticks(child.pid!) })).toMatchObject({ qaId: run.id, accounts: false })
    expect(await qa.request(qaScope, 'qa.connect', { pid: relay, ticks: ticks(relay) })).toMatchObject({ qaId: run.id, accounts: false })
    await expect(qa.request(qaScope, 'qa.connect', { pid: relay, ticks: 'stale' })).rejects.toThrow('QA_RELAY_IDENTITY_INVALID')
  } finally { child.stdin!.end(); await exited }
}, 15_000)

it('no loopback site inherits the synthetic contract: only a test-mode host registers its one studio origin (Opus F2)', () => {
  const studio = 'http://127.0.0.1:4173'
  const production = shippedQaAccounts(cliPath, () => {})
  for (const origin of [studio, 'http://127.0.0.1:5173', 'https://example.com']) expect(production.contract(origin)).toBeNull()
  expect(production.contracts).toEqual([])
  const test = shippedQaAccounts(cliPath, () => {}, studio)
  expect(test.contract(studio)).toMatchObject({ origin: studio }); expect(test.contract('http://127.0.0.1:5173')).toBeNull(); expect(test.contracts).toEqual([studio])
  expect(testQaContractOrigin(['node', 'host', '--bmn-test-host'], { BMN_TEST_QA_CONTRACT_ORIGIN: studio })).toBe(studio)
  expect(testQaContractOrigin(['node', 'host'], { BMN_TEST_QA_CONTRACT_ORIGIN: studio })).toBeNull()
  for (const origin of ['http://localhost:4173', 'https://example.com', 'http://127.0.0.1:4173/app']) expect(testQaContractOrigin(['--bmn-test-host'], { BMN_TEST_QA_CONTRACT_ORIGIN: origin })).toBeNull()
})
