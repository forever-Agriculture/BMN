// MODULE: epic-actions-night-claim.test.ts - the hook's night claim checks the very approval whose receipt it spends (Epic 132 S7)
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_GRANT_RECORD, answerGrant, askGrant, openGrantPeriod, startDeparture, type EpicPlanContext, type EpicRunBinding,
  type GrantCommandTerm, type PlanAction } from '@bmn/protocol'
import { planActionsHash } from '../../bin/plan-actions.mjs'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { EPIC_ACTION_OPERATIONS, bindEpicRun, epicActionRecord, nightCommandHash, reserveNightEpicCommand } from './database-epic-actions'
import { readGrantRow, writeGrantRow } from './database-grant-store'
import { EpicActionsService } from './epic-actions-service'

const DB = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const AT = '2026-11-19T19:00:00.000Z'
const GO = 'a'.repeat(40)
const REGISTRY = 'https://registry.example.test/'
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-night-claim-'))
  const repo = realpathSync(root)
  expect(spawnSync('git', ['init', '--quiet', repo]).status).toBe(0)
  expect(spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/fixture/repo.git']).status).toBe(0)
  const database = new DB(':memory:')
  cleanups.push(() => { database.close(); rmSync(root, { recursive: true, force: true }) })
  initializeDatabase(database, AT)
  database.prepare(`INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
    SELECT 'one', workspace_id, 'one', ?, '/bin/bash', '[]', 1, ?, 0 FROM workspace LIMIT 1`).run(repo, AT)
  database.prepare(`INSERT INTO process_incarnation(incarnation_id, session_id, process_start_identity, state, started_at)
    VALUES ('incarnation-one', 'one', 'synthetic', 'running', ?)`).run(AT)
  const command = `npm publish pkg.tgz --registry ${REGISTRY}`
  const filler: PlanAction = { kind: 'command', id: 'force', repository: '/fixture/remote.git', count: 1,
    command: 'git push --force-with-lease origin feature/x', folder: '/fixture/other', ref: 'feature/x', script: null }
  const plan: EpicPlanContext = {
    planKey: join(repo, 'plan'), project: repo, epic: 7, actions: [filler], actionsHash: planActionsHash([filler]),
    approval: 'sha256:' + 'b'.repeat(64), go: GO, activeApproval: 'sha256:' + 'b'.repeat(64), previousGo: GO, precedingGo: null,
    goApproval: 'sha256:' + 'b'.repeat(64), goActionsHash: planActionsHash([filler]), withdrawn: false
  }
  const binding: EpicRunBinding = { id: 'binding-one', sessionId: 'one', incarnationId: 'incarnation-one', agent: 'claude',
    conversation: 'conversation-one', foreground: 'synthetic', generation: 'generation-one', go: GO, at: AT }
  bindEpicRun(database, plan, binding, null, false)
  // Two approvals of one publish command and folder that differ only in the bytes they pin: A first, then B.
  const term = (id: string, bytes: string): GrantCommandTerm => ({ kind: 'command', id, command, folder: repo, repository: 'fixture/repo',
    ref: REGISTRY, count: 1, script: { path: 'pkg.tgz', sha256: sha(bytes) }, proposed: 'yes', reason: 'Synthetic publish',
    bound: { plan: plan.planKey, epic: plan.epic, go: GO, session: 'one' } })
  const a = term('night-a', 'bytes A'), b = term('night-b', 'bytes B')
  const first = startDeparture(EMPTY_GRANT_RECORD, { periodId: 'night', source: 'app', agentSessionId: null }, 'back', AT)
  const asked = askGrant(first.record, { runId: 'run', sessionId: 'one', agentCli: 'claude',
    card: { title: 'Synthetic night', scope: 'One publish, two pins', terms: [a, b], nothing: false } }, AT)
  expect(asked.outcome).toBe('opened')
  writeGrantRow(database, answerGrant(asked.record, { periodId: 'night', runId: 'run', cardRevision: 1, via: 'app',
    choices: { 'night-a': 'yes', 'night-b': 'yes' }, operationKey: 'owner' }, AT).record, AT)

  let between: ((name: string) => void) | null = null
  const companion = async (name: string, ...args: unknown[]) => {
    const operation = (EPIC_ACTION_OPERATIONS as unknown as Record<string, (db: DatabaseConnection, ...rest: unknown[]) => unknown>)[name]
    if (!operation) throw new Error(`unexpected operation ${name}`)
    const result = database.transaction(() => operation(database, ...args))()
    between?.(name)
    return result
  }
  const service = new EpicActionsService({ database: { companion } as never, liveIncarnation: () => 'incarnation-one',
    foreground: () => 'synthetic', now: () => AT, changed: () => undefined, grantChanged: () => undefined })
  // The plan is reread from disk in the product; here it is the fixture's own, unchanged.
  ;(service as unknown as { dispatchPlan: () => Promise<EpicPlanContext> }).dispatchPlan = async () => plan
  const claim = (call: string) => (service as unknown as { claimNight: (...args: unknown[]) => Promise<unknown> })
    .claimNight({ plan, binding, record: epicActionRecord(database, plan) }, command, repo, call)
  // As `bmn grant use` does: the pinned file is hashed right before the use, so a receipt is reserved while it matches.
  const reserve = (night: GrantCommandTerm, id: string) => {
    writeFileSync(join(repo, 'pkg.tgz'), night === a ? 'bytes A' : 'bytes B')
    const file = { periodId: 'night', cardRevision: 1, folder: repo, path: 'pkg.tgz', sha256: night.script!.sha256 }
    expect(database.transaction(() => reserveNightEpicCommand(database, plan, binding,
      { runId: 'run', item: night.id, targetHash: nightCommandHash(night), id, file }, AT))()).toMatchObject({ outcome: 'recorded' })
  }
  const bytes = (text: string) => writeFileSync(join(repo, 'pkg.tgz'), text)
  const calls = () => { const read = readGrantRow(database); return read.state === 'read' ? openGrantPeriod(read.record)!.uses.map(use => [use.id, use.dispatch?.call]) : [] }
  const audit = () => epicActionRecord(database, plan).audit.map(row => [row.receipt, row.call, row.outcome])
  return { a, b, claim, reserve, bytes, calls, audit, set: (hook: typeof between) => { between = hook } }
}

describe('The hook\'s night claim (Epic 132 S7, through EpicActionsService)', () => {
  it('holds when the file matches another approval than the waiting receipt, and leaves that receipt unclaimed', async () => {
    const f = fixture()
    f.reserve(f.b, 'use-b')
    f.bytes('bytes A')
    await expect(f.claim('tool-1')).rejects.toThrow(/pinned file hash differs/u)
    expect(f.calls()).toEqual([['use-b', null]])
    expect(f.audit()).toEqual([])
  })

  it('claims the waiting receipt whose own pin matches, despite a stale first approval, and charges once', async () => {
    const f = fixture()
    f.reserve(f.b, 'use-b')
    f.bytes('bytes B')
    expect(await f.claim('tool-1')).toMatchObject({ answer: { allowed: true, action: 'night-b', useId: 'use-b' } })
    expect(f.calls()).toEqual([['use-b', 'tool-1']])
    // A retry of the same call gets the same receipt; another call finds none waiting and leaves it to a file receipt.
    expect(await f.claim('tool-1')).toMatchObject({ answer: { useId: 'use-b' } })
    expect(await f.claim('tool-2')).toBeNull()
    expect(f.audit()).toEqual([['use-b', 'tool-1', 'unreported']])
  })

  it('leaves the call to a file receipt when no night receipt waits, even with a stale first pin', async () => {
    const f = fixture()
    f.bytes('bytes B')
    expect(await f.claim('tool-1')).toBeNull()
  })

  it('holds with two waiting receipts even when only one pin is current, claiming neither', async () => {
    const f = fixture()
    f.reserve(f.a, 'use-a')
    f.reserve(f.b, 'use-b')
    f.bytes('bytes A')
    await expect(f.claim('tool-1')).rejects.toThrow(/More than one night reservation waits/u)
    expect(f.calls()).toEqual([['use-a', null], ['use-b', null]])
  })

  it('holds when a second receipt arrives between the check and the claim, attaching neither', async () => {
    const f = fixture()
    f.reserve(f.b, 'use-b')
    f.bytes('bytes B')
    f.set(name => { if (name === 'selectNightEpicCommand') { f.set(null); f.reserve(f.a, 'use-a'); f.bytes('bytes B') } })
    await expect(f.claim('tool-1')).rejects.toThrow(/More than one night reservation waits/u)
    expect(f.calls()).toEqual([['use-b', null], ['use-a', null]])
  })

  it('withholds when the pin changes after the claim, keeps the use spent, and a retry stays on the night receipt', async () => {
    const f = fixture()
    f.reserve(f.b, 'use-b')
    f.bytes('bytes B')
    f.set(name => { if (name === 'claimNightEpicCommand') { f.set(null); f.bytes('bytes A') } })
    await expect(f.claim('tool-1')).rejects.toThrow(/pinned file hash differs.*the use stays spent/u)
    expect(f.calls()).toEqual([['use-b', 'tool-1']])
    expect(f.audit()).toEqual([['use-b', 'tool-1', 'withheld']])
    await expect(f.claim('tool-1')).rejects.toThrow(/the use stays spent|no longer in force/u)
    expect(f.audit()).toHaveLength(1)
  })
})
