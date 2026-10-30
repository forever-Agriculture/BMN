// MODULE: database-qa-store.test.ts - persisted QA keys and exact pane binding survive uncertainty and restart
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEFAULT_WORKSPACE_ID, type QaRun } from '@bmn/protocol'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { reserveQaRun, bindQaRun, getQaRun, recoverQaRuns, connectQaRelay, qaRunForSession, finishQaRun, isQaSession, bindQaAgent } from './database-qa-store'

const require = createRequire(import.meta.url)
const Sqlite = require('better-sqlite3') as new (path: string) => DatabaseConnection
let db: DatabaseConnection
const now = '2026-10-29T10:44:00.000Z'
function session(id: string, cwd = '/qa/run-a', argv = ['--run', 'run-a']): void {
  db.prepare(`INSERT INTO session(session_id,workspace_id,name,cwd,executable,argv_json,revision,created_at,position)
    VALUES(?,?,?,?,'/usr/bin/env',?,1,?,0)`).run(id, DEFAULT_WORKSPACE_ID, id, cwd, JSON.stringify(argv), now)
}
const run = (over: Partial<QaRun> = {}): QaRun => ({ id: 'run-a', callerSessionId: 'caller', workspaceId: DEFAULT_WORKSPACE_ID,
  key: 'qa-key', inputSha256: 'input-a', brief: {}, folder: '/qa/run-a', state: 'preparing', sessionId: null, incarnationId: null,
  createdAt: now, failure: null, connection: null, result: null, ...over })
beforeEach(() => { db = new Sqlite(':memory:'); initializeDatabase(db, now); session('caller', '/product', []) })
afterEach(() => db.close())
describe('durable QA lifecycle', () => {
  it('a repeated key returns the original identity; different bytes refuse', () => {
    expect(reserveQaRun(db, run()).created).toBe(true)
    expect(reserveQaRun(db, run({ id: 'ignored-new-id' }))).toMatchObject({ created: false, run: { id: 'run-a' } })
    expect(() => reserveQaRun(db, run({ inputSha256: 'different' }))).toThrow('QA_KEY_CONFLICT')
  })
  it('requires an existing caller in the same workspace', () => {
    expect(() => reserveQaRun(db, run({ callerSessionId: 'unknown' }))).toThrow()
    expect(() => reserveQaRun(db, run({ workspaceId: 'other' }))).toThrow('QA_CALLER_INVALID')
  })
  it('only binds the matching run folder and launch identity; a different second binding refuses', () => {
    reserveQaRun(db, run()); session('wrong', '/product', [])
    expect(() => bindQaRun(db, 'run-a', 'wrong', 'inc-a')).toThrow('QA_BINDING_INVALID')
    session('qa'); expect(bindQaRun(db, 'run-a', 'qa', 'inc-a').state).toBe('running')
    expect(bindQaRun(db, 'run-a', 'qa', 'inc-a').sessionId).toBe('qa')
    expect(() => bindQaRun(db, 'run-a', 'wrong', 'inc-b')).toThrow('QA_BINDING_CONFLICT')
  })
  it('scope and incarnation bind the relay; attestation survives reads', () => {
    reserveQaRun(db, run()); session('qa'); bindQaRun(db, 'run-a', 'qa', 'inc-a')
    expect(qaRunForSession(db, 'caller', 'inc-a')).toBeNull()
    expect(qaRunForSession(db, 'qa', 'old-incarnation')).toBeNull()
    connectQaRelay(db, 'run-a', { pid: 1234, ticks: '5678', at: now })
    expect(qaRunForSession(db, 'qa', 'inc-a')?.connection).toEqual({ pid: 1234, ticks: '5678', at: now })
  })
  it('the first relay identity is retained; a second process cannot overwrite its proof', () => {
    reserveQaRun(db, run()); session('qa'); bindQaRun(db, 'run-a', 'qa', 'inc-a')
    const first = { pid: 1234, ticks: '5678', at: now }
    connectQaRelay(db, 'run-a', first)
    expect(() => connectQaRelay(db, 'run-a', { ...first, pid: 9876 })).toThrow('QA_RELAY_ALREADY_CONNECTED')
    expect(getQaRun(db, 'run-a')?.connection).toEqual(first)
    expect(getQaRun(db, 'run-a')?.relayConnectAttempts).toBe(2)
  })
  it('QA socket restrictions cover preparing and terminal panes, and leave an ordinary session alone', () => {
    reserveQaRun(db, run()); session('qa'); session('ordinary', '/qa/run-a', [])
    expect(isQaSession(db, 'qa')).toBe(true)
    expect(isQaSession(db, 'ordinary')).toBe(false)
    expect(isQaSession(db, 'caller')).toBe(false)
    bindQaRun(db, 'run-a', 'qa', 'inc-a')
    finishQaRun(db, 'run-a', { state: 'stopped', failure: 'QA_STOPPED', result: null })
    expect(isQaSession(db, 'qa')).toBe(true)
  })
  it('the native-agent slot is first-writer-wins and cannot be rebound after a lost reply', () => {
    reserveQaRun(db, run()); session('qa'); bindQaRun(db, 'run-a', 'qa', 'inc-a')
    const agent = { pid: 1001, ticks: '2002', at: now }
    expect(bindQaAgent(db, 'run-a', agent).agent).toEqual(agent)
    expect(bindQaAgent(db, 'run-a', agent).agent).toEqual(agent)
    expect(() => bindQaAgent(db, 'run-a', { ...agent, ticks: 'different' })).toThrow('QA_AGENT_BINDING_CONFLICT')
    expect(getQaRun(db, 'run-a')?.agent).toEqual(agent)
  })
  it('recovery without a unique pane retains failure and the same key; never creates a second run', () => {
    reserveQaRun(db, run())
    expect(recoverQaRuns(db)[0]).toMatchObject({ state: 'failed', sessionId: null })
    expect(reserveQaRun(db, run({ id: 'second' })).run.id).toBe('run-a')
    expect(db.prepare('SELECT qa_id FROM qa_run').all()).toHaveLength(1)
  })
  it('recovery finds a pane created before main could answer', () => {
    reserveQaRun(db, run()); session('qa')
    db.prepare(`INSERT INTO process_incarnation(incarnation_id,session_id,process_start_identity,state,started_at)
      VALUES('inc-a','qa','1234:5678','interrupted',?)`).run(now)
    expect(recoverQaRuns(db)[0]).toMatchObject({ state: 'running', sessionId: 'qa', incarnationId: 'inc-a' })
  })
  it('terminal states retain their outcome and refuse further relay activity', () => {
    reserveQaRun(db, run()); session('qa'); bindQaRun(db, 'run-a', 'qa', 'inc-a')
    finishQaRun(db, 'run-a', { state: 'stopped', failure: 'QA_STOPPED', result: null })
    expect(finishQaRun(db, 'run-a', { state: 'finished', failure: null, result: null }).state).toBe('stopped')
    expect(qaRunForSession(db, 'qa', 'inc-a')).toBeNull()
    expect(() => connectQaRelay(db, 'run-a', { pid: 1234, ticks: '5678', at: now })).toThrow('QA_NOT_RUNNING')
    expect(getQaRun(db, 'unknown')).toBeNull()
  })
})
