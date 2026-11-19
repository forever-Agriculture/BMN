// MODULE: database-epic-actions.test.ts - synthetic exercises of the owner answer, live binding and reservation fences
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_GRANT_RECORD, askGrant, answerGrant, startDeparture, openGrantPeriod,
  type EpicPlanContext, type EpicRunBinding, type GrantCommandTerm, type PlanAction } from '@bmn/protocol'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { answerEpicActionCard, askEpicActionCard, bindEpicRun, epicActionRecord, epicActionRemaining,
  matchingEpicCard, reserveEpicAction, revokeEpicRun, claimNightEpicCommand, nightCommandHash, reserveNightEpicCommand, epicAuthorityProblem,
  recordEpicActionOutcome, epicCallDecision, settledEpicActionRecord } from './database-epic-actions'
import { readGrantRow, writeGrantRow } from './database-grant-store'
import { heldMergeProblem, parsePlanAction, planActionsHash, planPolicyTarget } from '../../bin/plan-actions.mjs'
import { bashExit, callOwnListener } from '../../bin/shared-helpers.mjs'
import { epicCommandTarget } from '../../bin/grant-command.mjs'
import { actionEvents, receiverProblem } from './epic-actions-service'
import { nightTermHold } from '@bmn/protocol'

const DB = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
const AT = '2026-11-19T14:00:00.000Z'
const GO = 'a'.repeat(40)
const ACTION: PlanAction = {
  kind: 'command', id: 'force', repository: '/fixture/remote.git', count: 1,
  command: 'git push --force-with-lease origin feature/x', folder: '/fixture/repo', ref: 'feature/x', script: null
}
const PLAN: EpicPlanContext = {
  planKey: '/fixture/repo/plan', project: '/fixture/repo', epic: 7, actions: [ACTION],
  actionsHash: planActionsHash([ACTION]), approval: 'sha256:' + 'b'.repeat(64), go: GO,
  activeApproval: 'sha256:' + 'b'.repeat(64), previousGo: GO, precedingGo: null,
  goApproval: 'sha256:' + 'b'.repeat(64), goActionsHash: planActionsHash([ACTION]), withdrawn: false
}
const draft: EpicPlanContext = { ...PLAN, go: null, activeApproval: null, previousGo: null, goApproval: null, goActionsHash: null }
const identity = (sessionId: string): EpicRunBinding => ({
  id: `binding-${sessionId}`, sessionId, incarnationId: `incarnation-${sessionId}`, agent: 'claude',
  conversation: `conversation-${sessionId}`, foreground: 'synthetic', generation: `generation-${sessionId}`, go: GO, at: AT
})
const databases: DatabaseConnection[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))

function setup(withAnswer = true) {
  const database = new DB(':memory:')
  databases.push(database)
  initializeDatabase(database, AT)
  for (const name of ['one', 'two']) {
    database.prepare(`INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
      SELECT ?, workspace_id, ?, ?, '/bin/bash', '[]', 1, ?, 0 FROM workspace LIMIT 1`).run(name, name, PLAN.project, AT)
    database.prepare(`INSERT INTO process_incarnation(incarnation_id, session_id, process_start_identity, state, started_at)
      VALUES (?, ?, 'synthetic', 'running', ?)`).run(identity(name).incarnationId, name, AT)
  }
  const card = askEpicActionCard(database, draft, AT)
  if (withAnswer) answerEpicActionCard(database, draft, { card: card.id, action: ACTION.id, choice: 'yes', revision: 1 }, 'app', AT)
  return { database, card, binding: identity('one') }
}

describe('Epic action authorization', () => {
  it('rejects wrappers, alternate refs, broad pushes and the protected categories in the file', () => {
    expect(parsePlanAction({ ...ACTION, script: undefined })).toEqual({ action: ACTION })
    for (const command of [
      ACTION.command + ' && echo next', ACTION.command + ' | cat', ACTION.command + ' > target',
      'git push --force-with-lease origin $BRANCH', 'git push --force-with-lease origin feature/*',
      'env git push --force-with-lease origin feature/x', 'git push --force-with-lease origin feature/y',
      'git push --force origin feature/x feature/y', 'git push --mirror origin feature/x',
      'docker system prune -a', 'docker volume rm demo', 'prime-select nvidia',
      'gh repo delete fixtures/repo', 'gh secret set TEST', 'gcloud run deploy demo'
    ]) expect(parsePlanAction({ ...ACTION, command, script: undefined })).toHaveProperty('problem')
    for (const kind of ['deploy', 'repository-settings', 'repository-visibility', 'repository-delete', 'repository-transfer',
      'credential', 'secret', 'acceptance']) expect(parsePlanAction({ kind })).toHaveProperty('problem')
  })

  it('requires a held GitHub write to name the approved repository with its host', () => {
    const command = 'gh release delete v1 --repo github.com/fixture/repo'
    const release = { ...ACTION, repository: 'fixture/repo', ref: 'v1', script: undefined, command }
    expect(parsePlanAction(release)).toHaveProperty('action.kind', 'command')
    for (const short of ['gh release delete v1', 'gh release delete v1 --repo fixture/repo',
      'gh release delete v1 --repo other.invalid/fixture/repo']) {
      expect(parsePlanAction({ ...release, command: short })).toHaveProperty('problem')
    }
  })

  const seen = (database: DatabaseConnection, plan: EpicPlanContext) =>
    matchingEpicCard(settledEpicActionRecord(database, plan, AT), plan)?.answers[ACTION.id]?.choice ?? 'not asked'
  const NEXT = 'c'.repeat(40)
  const successor: EpicPlanContext = { ...PLAN, go: NEXT, previousGo: NEXT, precedingGo: GO }

  it('uses the owner’s pre-go answer only for the next matching go and action digest', () => {
    const { database, card } = setup()
    expect(seen(database, draft)).toBe('yes')
    expect(seen(database, PLAN)).toBe('yes')
    expect(epicActionRecord(database, PLAN).card).toMatchObject({ go: GO, void: false })
    // Not in force while the row is paused; in force again after, with no new answer.
    expect(seen(database, { ...PLAN, go: null, activeApproval: null })).toBe('not asked')
    expect(seen(database, PLAN)).toBe('yes')
    expect(() => answerEpicActionCard(database, PLAN, { card: card.id, action: ACTION.id, choice: 'no', revision: 1 }, 'telegram', AT))
      .toThrow(/changed/u)
    // The go's successor on the very same text and list does not inherit the Yes, and going back does not revive it.
    expect(seen(database, successor)).toBe('not asked')
    expect(seen(database, PLAN)).toBe('not asked')
  })

  it('ends an answer for good when the list changes, the go is withdrawn or a go is recorded on other text', () => {
    for (const change of [
      { ...PLAN, actionsHash: 'changed' },                                   // one character of the list, seen without a re-ask
      { ...PLAN, go: null, activeApproval: null, withdrawn: true },          // the row was put back after its go
      { ...draft, approval: 'sha256:' + 'e'.repeat(64) }                     // the text changed before any go
    ]) {
      const { database } = setup()
      if (change.previousGo !== null) expect(seen(database, PLAN)).toBe('yes')
      expect(seen(database, change)).toBe('not asked')
      expect(seen(database, change.previousGo === null ? draft : PLAN)).toBe('not asked')
      expect(epicActionRecord(database, PLAN).card?.void).toBe(true)
    }
    // A go on other approval text, or on another list, or not the first go after the ask, never takes the pre-go answer.
    for (const other of [{ ...PLAN, goApproval: 'sha256:' + 'e'.repeat(64) }, { ...PLAN, goActionsHash: 'other' }, { ...PLAN, precedingGo: 'f'.repeat(40) }]) {
      const { database } = setup()
      expect(seen(database, other)).toBe('not asked')
      expect(seen(database, PLAN)).toBe('not asked')
    }
  })

  it('keeps an answer given under a go with that go only', () => {
    const database = setup(false).database
    const asked = askEpicActionCard(database, { ...PLAN, actionsHash: 'amended' }, AT)
    expect(asked).toMatchObject({ go: GO, goAtAsk: GO })
    const amended = { ...PLAN, actionsHash: 'amended' }
    answerEpicActionCard(database, amended, { card: asked.id, action: ACTION.id, choice: 'yes', revision: 1 }, 'app', AT)
    // A limit amendment changes the working approval text and keeps the answer; the next go does not.
    expect(seen(database, { ...amended, approval: 'sha256:' + 'e'.repeat(64) })).toBe('yes')
    expect(seen(database, { ...amended, go: NEXT, previousGo: NEXT, precedingGo: GO })).toBe('not asked')
  })

  it('keeps one live binding, and remembers owner unbind across process and binding identities', () => {
    const { database, binding } = setup()
    expect(bindEpicRun(database, PLAN, binding, null, false)).toEqual(binding)
    expect(() => bindEpicRun(database, PLAN, identity('two'), binding.id, true)).toThrow(/already.*live/u)
    expect(revokeEpicRun(database, PLAN, binding.id, AT)).toBe(true)
    expect(revokeEpicRun(database, PLAN, binding.id, AT)).toBe(false)
    expect(() => bindEpicRun(database, PLAN, { ...identity('two'), conversation: binding.conversation }, null, false)).toThrow(/unbound/u)
    // The same conversation stays out after a process restart (a new incarnation and generation of that session).
    expect(() => bindEpicRun(database, PLAN, { ...binding, generation: 'restarted', id: 'another-binding' }, null, false)).toThrow(/unbound/u)
    // Owner 2026-11-19T18:00Z: no new conversation of that same agent process binds again (a /clear or a made-up report);
    // a new agent process, or another session, may bind the go nobody holds.
    const cleared = { ...binding, conversation: 'conversation-after-clear', generation: 'changed', id: 'cleared-binding' }
    expect(() => bindEpicRun(database, PLAN, cleared, null, false)).toThrow(/unbound this agent/u)
    const restarted = { ...cleared, foreground: 'synthetic-restarted', id: 'restarted-binding' }
    expect(bindEpicRun(database, PLAN, restarted, null, false)).toEqual(restarted)
  })

  it('uses one count for reservation plus hook claim and protects the retry and exhausted paths', () => {
    const { database, binding } = setup()
    bindEpicRun(database, PLAN, binding, null, false)
    const request = { id: 'use', action: ACTION.id, targetHash: 'exact', call: null, mayReserve: true }
    const spend = (input: Parameters<typeof reserveEpicAction>[3]) => database.transaction(() =>
      reserveEpicAction(database, PLAN, binding, input, AT))()
    expect(spend(request).call).toBeNull()
    const claim = { ...request, id: 'hook:call-1', call: 'call-1' }
    expect(spend(claim)).toMatchObject({ id: 'use', call: 'call-1' })
    expect(spend(claim)).toMatchObject({ id: 'use', call: 'call-1' })
    expect(() => spend({ ...claim, targetHash: 'different' })).toThrow(/another use/u)
    expect(() => spend({ ...claim, id: 'hook:call-2', call: 'call-2' })).toThrow(/no uses left/u)
    expect(epicActionRemaining(epicActionRecord(database, PLAN), GO, ACTION)).toBe(0)
  })

  it('keeps an unanswered card closed to tool dispatch', () => {
    const { database, binding } = setup(false)
    bindEpicRun(database, PLAN, binding, null, false)
    expect(() => reserveEpicAction(database, PLAN, binding, {
      id: 'use', action: ACTION.id, targetHash: 'exact', call: 'call', mayReserve: true
    }, AT)).toThrow(/no current owner approval/u)
  })

  it('claims only the named policy receipt and returns a repeat without a second launch', () => {
    const { database, binding } = setup(false)
    const action = { id: 'push-main', kind: 'push-default', repository: 'test/fixture', count: 1, branch: 'main' } as const
    const plan = { ...PLAN, actions: [action], actionsHash: planActionsHash([action]), goActionsHash: planActionsHash([action]) }
    const proposal = { ...draft, actions: plan.actions, actionsHash: plan.actionsHash }
    const card = askEpicActionCard(database, proposal, AT)
    answerEpicActionCard(database, proposal, { card: card.id, action: action.id, choice: 'yes', revision: 1 }, 'app', AT)
    bindEpicRun(database, plan, binding, null, false)
    const spend = (input: Parameters<typeof reserveEpicAction>[3]) => database.transaction(() =>
      reserveEpicAction(database, plan, binding, input, AT))()
    const reserve = { id: 'receipt-1', action: action.id, targetHash: 'exact-policy-write', call: null, mayReserve: true, commandHash: 'hash' }
    const dispatch = { ...reserve, call: 'policy:receipt-1', receipt: 'receipt-1', commandHash: 'hash', mayReserve: false }
    expect(() => spend(dispatch)).toThrow(/no matching/iu)
    expect(spend(reserve).call).toBeNull()
    expect(epicActionRecord(database, plan).audit).toMatchObject([{ receipt: reserve.id, outcome: 'reserved' }])
    expect(() => spend({ ...dispatch, receipt: 'another' })).toThrow(/no matching/iu)
    expect(spend(dispatch)).not.toHaveProperty('repeated')
    expect(spend(dispatch)).toMatchObject({ id: reserve.id, repeated: true })
    expect(epicActionRecord(database, plan).audit).toMatchObject([{ receipt: reserve.id, outcome: 'unreported' }])
    expect(recordEpicActionOutcome(database, plan, binding, 'wrong-call', 'failed', AT)).toBe(false)
    expect(recordEpicActionOutcome(database, plan, binding, dispatch.call, 'failed', AT)).toBe(true)
    expect(recordEpicActionOutcome(database, plan, binding, dispatch.call, 'returned', AT)).toBe(false)
    const final = epicActionRecord(database, plan)
    expect(final.uses).toHaveLength(1)
    expect(final.audit).toMatchObject([{ receipt: reserve.id, outcome: 'failed' }])
    expect(epicActionRemaining(final, binding.go, action)).toBe(0)
  })

  it('claims the existing night use, refuses another tool call and keeps one audit entry', () => {
    const { database, binding } = setup(false)
    bindEpicRun(database, PLAN, binding, null, false)
    const term: GrantCommandTerm = { ...ACTION, proposed: 'yes', reason: 'Synthetic exact push',
      bound: { plan: PLAN.planKey, epic: PLAN.epic, go: GO, session: 'one' } }
    const periodId = 'night-fixture'
    const runId = 'run-seven'
    const first = startDeparture(EMPTY_GRANT_RECORD, { periodId, source: 'app', agentSessionId: null }, 'back', AT)
    const asked = askGrant(first.record, { runId, sessionId: binding.sessionId, agentCli: binding.agent,
      card: { title: 'Synthetic night', scope: 'One exact command', terms: [term], nothing: false } }, AT)
    const answer = answerGrant(asked.record, { periodId, runId, cardRevision: 1, via: 'app',
      choices: { [term.id]: 'yes' }, operationKey: 'owner-fixture' }, AT)
    expect(answer.outcome).toBe('granted')
    writeGrantRow(database, answer.record, AT)
    const target = { runId, item: term.id, targetHash: nightCommandHash(term) }
    const claim = (call: string) => database.transaction(() => claimNightEpicCommand(database, PLAN, binding, { command: ACTION.command, folder: ACTION.folder, call }, AT))()?.use ?? null
    // S7: with no night receipt waiting the night decides nothing; the call is the file's to decide.
    expect(claim('pre-use')).toBeNull()
    const reserve = database.transaction(() => reserveNightEpicCommand(database, PLAN, binding, { ...target, id: 'night-use' }, AT))()
    expect(reserve).toMatchObject({ outcome: 'recorded', left: 0 })
    const claimed = database.transaction(() => claimNightEpicCommand(database, PLAN, binding, { command: ACTION.command, folder: ACTION.folder, call: 'tool-one' }, AT))()!
    expect(claimed.use).toMatchObject({ id: 'night-use', dispatch: { call: 'tool-one' } })
    // The written row is handed back for the window; it already holds the call.
    expect(claimed.read?.state === 'read' && openGrantPeriod(claimed.read.record)?.uses[0]?.dispatch?.call).toBe('tool-one')
    // D4/D9 at the edge: the night term in force passes; after Back it no longer does.
    expect(epicAuthorityProblem(database, PLAN, binding, { kind: 'night', ...target }, AT)).toBeNull()
    expect(epicAuthorityProblem(database, PLAN, binding, { kind: 'night', ...target, targetHash: 'other' }, AT)).toMatch(/changed/u)
    const repeat = database.transaction(() => claimNightEpicCommand(database, PLAN, binding, { command: ACTION.command, folder: ACTION.folder, call: 'tool-one' }, AT))()!
    expect(repeat.use.id).toBe('night-use')
    expect(repeat.read).toBeNull()
    expect(claim('tool-two')).toBeNull()
    const read = readGrantRow(database)
    expect(read.state === 'read' && openGrantPeriod(read.record)?.uses).toHaveLength(1)
    expect(epicActionRecord(database, PLAN).audit).toEqual([expect.objectContaining({
      source: 'night', sessionId: binding.sessionId, receipt: 'night-use', call: 'tool-one', outcome: 'unreported' })])
    // The native result reaches the night row too, once.
    expect(recordEpicActionOutcome(database, PLAN, binding, 'tool-one', 'failed', AT)).toBe(true)
    expect(recordEpicActionOutcome(database, PLAN, binding, 'tool-one', 'returned', AT)).toBe(false)
    expect(epicActionRecord(database, PLAN).audit[0]).toMatchObject({ outcome: 'failed' })
    // D9: the same tool call delivered again gets the night's decision back, even where the file could now pay.
    const hash = epicActionRecord(database, PLAN).audit[0]!.commandHash
    expect(epicCallDecision(database, PLAN, binding, 'tool-one', hash)).toBe('night')
    expect(epicCallDecision(database, PLAN, binding, 'tool-two', hash)).toBeNull()
    expect(() => epicCallDecision(database, PLAN, binding, 'tool-one', 'c'.repeat(64))).toThrow(/another operation/iu)
    // A call BMN withheld at its last check is never answered allowed on a retry.
    const record = epicActionRecord(database, PLAN)
    record.audit[0]!.outcome = 'unreported'
    database.prepare('UPDATE app_setting SET value_json = ? WHERE key LIKE ?').run(JSON.stringify(record), 'epic-actions-v1:%')
    expect(recordEpicActionOutcome(database, PLAN, binding, 'tool-one', 'withheld', AT)).toBe(true)
    expect(() => epicCallDecision(database, PLAN, binding, 'tool-one', hash)).toThrow(/withheld/iu)
    // The file writer itself refuses a call the night already decided, whatever the caller looked up first.
    const card = askEpicActionCard(database, PLAN, AT)
    answerEpicActionCard(database, PLAN, { card: card.id, action: ACTION.id, choice: 'yes', revision: 1 }, 'app', AT)
    expect(() => database.transaction(() => reserveEpicAction(database, PLAN, binding,
      { id: 'hook:tool-one', action: ACTION.id, targetHash: 'exact', call: 'tool-one', mayReserve: true, commandHash: hash }, AT))())
      .toThrow(/another operation/iu)
    expect(epicActionRecord(database, PLAN).uses).toHaveLength(0)
    // And the night writer refuses a call the file decided first.
    const filed = database.transaction(() => reserveEpicAction(database, PLAN, binding,
      { id: 'hook:tool-file', action: ACTION.id, targetHash: 'exact', call: 'tool-file', mayReserve: true, commandHash: hash }, AT))()
    expect(filed.call).toBe('tool-file')
    expect(() => claim('tool-file')).toThrow(/another operation/iu)
  })

  it('refuses a night command approved under another epic or go', () => {
    const { database, binding } = setup(false)
    bindEpicRun(database, PLAN, binding, null, false)
    const periodId = 'night-fixture'
    const runId = 'run-seven'
    for (const bound of [undefined, { plan: PLAN.planKey, epic: 8, go: GO, session: 'one' },
      { plan: PLAN.planKey, epic: PLAN.epic, go: 'd'.repeat(40), session: 'one' }, { plan: '/other/plan', epic: PLAN.epic, go: GO, session: 'one' },
      { plan: PLAN.planKey, epic: PLAN.epic, go: GO, session: 'two' }]) {
      const term: GrantCommandTerm = { ...ACTION, proposed: 'yes', reason: 'Synthetic exact push', ...(bound ? { bound } : {}) }
      const first = startDeparture(EMPTY_GRANT_RECORD, { periodId, source: 'app', agentSessionId: null }, 'back', AT)
      const asked = askGrant(first.record, { runId, sessionId: binding.sessionId, agentCli: binding.agent,
        card: { title: 'Synthetic night', scope: 'One exact command', terms: [term], nothing: false } }, AT)
      const answer = answerGrant(asked.record, { periodId, runId, cardRevision: 1, via: 'app',
        choices: { [term.id]: 'yes' }, operationKey: 'owner-fixture' }, AT)
      writeGrantRow(database, answer.record, AT)
      const target = { runId, item: term.id, targetHash: nightCommandHash(term) }
      expect(() => database.transaction(() => reserveNightEpicCommand(database, PLAN, binding, { ...target, id: 'night-use' }, AT))())
        .toThrow(/another epic or go/iu)
      // Approved for another epic, go, plan or session, it is no candidate: the night pays nothing for this call.
      expect(database.transaction(() => claimNightEpicCommand(database, PLAN, binding, { command: ACTION.command, folder: ACTION.folder, call: 'tool-one' }, AT))())
        .toBeNull()
    }
    const read = readGrantRow(database)
    expect(read.state === 'read' && openGrantPeriod(read.record)?.uses).toHaveLength(0)
  })
})

describe('The exact target of a typed or held write (S2)', () => {
  it('takes a default-branch push only with its full destination and a gh write only with the GitHub host', async () => {
    const push = parsePlanAction({ kind: 'push-default', id: 'main', repository: 'sample/fixture', branch: 'main', count: 1 })
    const pr = parsePlanAction({ kind: 'pr-elsewhere', id: 'pr', repository: 'sample/fixture', branch: 'feature/x', count: 1 })
    if ('problem' in push || 'problem' in pr) throw Error('fixture')
    const target = (action: typeof push.action, command: string) => planPolicyTarget(action as never, command, '/fixture/repo')
    // A bare name can resolve to a same-named local tag.
    expect(await target(push.action, 'git push origin main')).toMatchObject({ problem: expect.stringMatching(/HEAD:refs\/heads\/main/u) })
    expect(await target(push.action, 'git push origin HEAD:refs/heads/main')).toEqual({ remote: 'origin' })
    const create = (repo: string) => `gh pr create --repo ${repo} --head feature/x --title T`
    expect(await target(pr.action, create('sample/fixture'))).toMatchObject({ problem: expect.stringMatching(/github\.com\/OWNER\/NAME/u) })
    expect(await target(pr.action, create('github.com/sample/fixture'))).toEqual({ remote: null })
  })

  it('holds a guarded PR merge whose current files change CI, as a typed merge without CI approval is held', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-held-merge-'))
    try {
      const files = (paths: string[]) => writeFileSync(join(root, 'gh'), `#!/bin/sh\nprintf '%s' '${JSON.stringify({ files: paths.map(path => ({ path })) })}'\n`)
      files(['README.md']); chmodSync(join(root, 'gh'), 0o755)
      vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
      expect(await heldMergeProblem(root, 'sample/fixture', '12')).toBeNull()
      files(['.github/workflows/ci.yml'])
      expect(await heldMergeProblem(root, 'sample/fixture', '12')).toMatch(/changes CI/u)
      writeFileSync(join(root, 'gh'), '#!/bin/sh\nexit 1\n')
      expect(await heldMergeProblem(root, 'sample/fixture', '12')).toMatch(/could not confirm/u)
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) }
  })
})

describe('The deploy rule on an epic action (D3)', () => {
  it('keeps the rule he saw with a Yes and refuses the use under another rule', () => {
    const { database, binding } = setup(false)
    const card = askEpicActionCard(database, draft, AT)
    answerEpicActionCard(database, draft, { card: card.id, action: ACTION.id, choice: 'yes', revision: 1 }, 'app', AT, 'nothing deploys')
    expect(epicActionRecord(database, PLAN).card?.answers[ACTION.id]).toMatchObject({ choice: 'yes', rule: 'nothing deploys' })
    bindEpicRun(database, PLAN, binding, null, false)
    const use = (rule: string | null) => database.transaction(() => reserveEpicAction(database, PLAN, binding,
      { id: `hook:${rule}`, action: ACTION.id, targetHash: 'exact', call: `call-${rule}`, mayReserve: true, commandHash: 'hash', rule }, AT))()
    expect(() => use('deploys on: tags')).toThrow(/no current owner approval/u)
    expect(() => use(null)).toThrow(/no current owner approval/u)
    expect(epicActionRecord(database, PLAN).uses).toHaveLength(0)
    expect(use('nothing deploys').call).toBe('call-nothing deploys')
    // The same Yes under a new rule is a new answer, written with that rule.
    const again = answerEpicActionCard(database, PLAN, { card: card.id, action: ACTION.id, choice: 'yes', revision: 2 }, 'telegram', AT, 'deploys on: tags')
    expect(again.answers[ACTION.id]).toMatchObject({ rule: 'deploys on: tags', via: 'telegram' })
  })

  it('reads the authority behind a taken use once more at the edge: his answer under the same rule, the bound run (S3)', () => {
    const { database, card, binding } = setup(false)
    answerEpicActionCard(database, draft, { card: card.id, action: ACTION.id, choice: 'yes', revision: 1 }, 'app', AT, 'nothing deploys')
    bindEpicRun(database, PLAN, binding, null, false)
    const file = (rule: string | null) => epicAuthorityProblem(database, PLAN, binding, { kind: 'file', action: ACTION.id, rule }, AT)
    expect(file('nothing deploys')).toBeNull()
    expect(file('deploys on: tags')).toMatch(/approval of this action ended/u)
    answerEpicActionCard(database, PLAN, { card: card.id, action: ACTION.id, choice: 'no', revision: 2 }, 'app', AT)
    expect(file('nothing deploys')).toMatch(/approval of this action ended/u)
    expect(revokeEpicRun(database, PLAN, binding.id, AT)).toBe(true)
    expect(file('nothing deploys')).toMatch(/bound run ended/u)
    expect(epicAuthorityProblem(database, { ...PLAN, go: 'd'.repeat(40) }, binding, { kind: 'file', action: ACTION.id, rule: null }, AT)).toMatch(/bound run ended/u)
  })

  it('leaves a call to the sole pending file receipt when an approved night term holds no reservation (S7)', () => {
    const { database, binding } = setup()
    bindEpicRun(database, PLAN, binding, null, false)
    const term: GrantCommandTerm = { ...ACTION, proposed: 'yes', reason: 'Synthetic exact push',
      bound: { plan: PLAN.planKey, epic: PLAN.epic, go: GO, session: 'one' } }
    const first = startDeparture(EMPTY_GRANT_RECORD, { periodId: 'night-s7', source: 'app', agentSessionId: null }, 'back', AT)
    const asked = askGrant(first.record, { runId: 'run-s7', sessionId: binding.sessionId, agentCli: binding.agent,
      card: { title: 'Synthetic night', scope: 'One exact command', terms: [term], nothing: false } }, AT)
    writeGrantRow(database, answerGrant(asked.record, { periodId: 'night-s7', runId: 'run-s7', cardRevision: 1, via: 'app',
      choices: { [term.id]: 'yes' }, operationKey: 'owner-s7' }, AT).record, AT)
    const reserved = database.transaction(() => reserveEpicAction(database, PLAN, binding,
      { id: 'file-receipt', action: ACTION.id, targetHash: 'exact', call: null, mayReserve: true, commandHash: 'hash' }, AT))()
    expect(reserved.call).toBeNull()
    expect(database.transaction(() => claimNightEpicCommand(database, PLAN, binding, { command: ACTION.command, folder: ACTION.folder, call: 'tool-s7' }, AT))()).toBeNull()
    const claimed = database.transaction(() => reserveEpicAction(database, PLAN, binding,
      { id: 'hook:tool-s7', action: ACTION.id, targetHash: 'exact', call: 'tool-s7', mayReserve: true, commandHash: 'hash' }, AT))()
    expect(claimed).toMatchObject({ id: 'file-receipt', call: 'tool-s7' })
  })

  it('decides between two approved night terms for one command from their receipts, not their count (S7 recheck)', () => {
    const { database, binding } = setup()
    bindEpicRun(database, PLAN, binding, null, false)
    const one: GrantCommandTerm = { ...ACTION, proposed: 'yes', reason: 'Synthetic exact push',
      bound: { plan: PLAN.planKey, epic: PLAN.epic, go: GO, session: 'one' } }
    const two: GrantCommandTerm = { ...one, id: 'second-night-push' }
    const first = startDeparture(EMPTY_GRANT_RECORD, { periodId: 'night-s7b', source: 'app', agentSessionId: null }, 'back', AT)
    const asked = askGrant(first.record, { runId: 'run-s7b', sessionId: binding.sessionId, agentCli: binding.agent,
      card: { title: 'Synthetic night', scope: 'One exact command, twice', terms: [one, two], nothing: false } }, AT)
    expect(asked.outcome).toBe('opened')
    writeGrantRow(database, answerGrant(asked.record, { periodId: 'night-s7b', runId: 'run-s7b', cardRevision: 1, via: 'app',
      choices: { [one.id]: 'yes', [two.id]: 'yes' }, operationKey: 'owner-s7b' }, AT).record, AT)
    const candidates = [one, two].map(term => ({ runId: 'run-s7b', item: term.id, targetHash: nightCommandHash(term) }))
    const claim = (call: string) => database.transaction(() => claimNightEpicCommand(database, PLAN, binding, { command: ACTION.command, folder: ACTION.folder, call }, AT))()
    // Two approvals, no night receipt: the sole file receipt decides.
    database.transaction(() => reserveEpicAction(database, PLAN, binding,
      { id: 'file-receipt', action: ACTION.id, targetHash: 'exact', call: null, mayReserve: true, commandHash: 'hash' }, AT))()
    expect(claim('tool-file')).toBeNull()
    expect(database.transaction(() => reserveEpicAction(database, PLAN, binding,
      { id: 'hook:tool-file', action: ACTION.id, targetHash: 'exact', call: 'tool-file', mayReserve: true, commandHash: 'hash' }, AT))())
      .toMatchObject({ id: 'file-receipt', call: 'tool-file' })
    // Two night receipts waiting for one call: it stays held, and neither is claimed.
    for (const [index, id] of ['night-one', 'night-two'].entries()) {
      expect(database.transaction(() => reserveNightEpicCommand(database, PLAN, binding, { ...candidates[index]!, id }, AT))()).toMatchObject({ outcome: 'recorded' })
    }
    expect(() => claim('tool-night')).toThrow(/More than one night reservation waits/u)
    const read = readGrantRow(database)
    expect(read.state === 'read' && openGrantPeriod(read.record)!.uses.map(use => use.dispatch?.call)).toEqual([null, null])
  })

  it('places each action among the events a rule names, and a local receiver by its hooks', () => {
    const push = { id: 'p', kind: 'push-default', repository: 'fixture/repo', count: 1, branch: 'main' } as const
    expect(actionEvents(push, null)).toEqual(['default-branch'])
    expect(actionEvents({ id: 'm', kind: 'merge', repository: 'fixture/repo', count: 1, pr: 4, headSha: 'a'.repeat(40), whenGreen: true, changesCI: false }, null))
      .toEqual(['default-branch', 'branches', 'pull-requests'])
    // A bare ref may be a branch or a tag; which branch needs the default branch's name.
    expect(actionEvents(ACTION, 'main')).toEqual(['branches', 'tags'])
    expect(actionEvents(ACTION, 'feature/x')).toEqual(['default-branch', 'tags'])
    expect(actionEvents(ACTION, null)).toBeNull()
    const release = parsePlanAction({ ...ACTION, repository: 'fixture/repo', ref: 'v1', script: undefined, command: 'gh release delete v1 --repo github.com/fixture/repo' })
    expect('action' in release && actionEvents(release.action, null)).toEqual(['releases', 'tags'])
    // S2 recheck: what a command does is read from its parsed words; a quoted subcommand is still a release or a merge.
    for (const command of ["gh 'release' delete v1 --repo github.com/fixture/repo", 'gh release "delete" v1 --repo github.com/fixture/repo']) {
      const quoted = parsePlanAction({ ...ACTION, repository: 'fixture/repo', ref: 'v1', script: undefined, command })
      expect('action' in quoted && actionEvents(quoted.action, null)).toEqual(['releases', 'tags'])
    }
    for (const command of ["gh pr 'merge' 12 --repo github.com/fixture/repo --admin --merge", "gh 'pr' merge 12 --repo github.com/fixture/repo --admin"]) {
      const quoted = parsePlanAction({ ...ACTION, repository: 'fixture/repo', ref: '12', script: undefined, command })
      expect('action' in quoted && epicCommandTarget(quoted.action as never)).toMatchObject({ action: 'merge' })
      expect('action' in quoted && actionEvents(quoted.action, null)).toEqual(['default-branch', 'branches', 'pull-requests'])
    }

    const root = mkdtempSync(join(tmpdir(), 'bmn-receiver-'))
    try {
      expect(spawnSync('/usr/bin/git', ['init', '--bare', '--quiet', root]).status).toBe(0)
      expect(receiverProblem(root)).toBeNull()
      writeFileSync(join(root, 'hooks', 'post-receive'), '#!/bin/sh\n', { mode: 0o755 })
      expect(receiverProblem(root)).toMatch(/runs a hook on a push/u)
      expect(receiverProblem(join(root, 'absent'))).toMatch(/could not be inspected/u)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('holds a typed night merge, push or PR write as the epic action of that kind (S1, owner 2026-11-19)', () => {
    const policy = (deploys: { repository: string; events: string[] }[]) => ({ state: 'read' as const,
      record: { version: 1 as const, revision: 1, owners: [], levels: [], deploys: deploys.map(rule => ({ ...rule, changedAt: '2026-11-19T00:00:00.000Z' })) } }) as never
    const merge = { id: 'm', kind: 'merge', repository: 'fixture/repo', pr: 4, headSha: null, upTo: null, proposed: 'green', reason: 'r' } as never
    const push = { id: 'p', kind: 'push-default', repository: 'fixture/repo', branch: 'epic/1', count: 1, proposed: 'yes', reason: 'r' } as never
    const pr = { id: 'q', kind: 'pr-elsewhere', repository: 'fixture/repo', branch: 'fix/x', pr: null, count: 1, proposed: 'yes', reason: 'r' } as never
    // No rule: all three wait for him; a rule that nothing deploys lets them through.
    for (const term of [merge, push, pr]) {
      expect(nightTermHold(policy([]), term)).toMatch(/no deploy rule for fixture\/repo/u)
      expect(nightTermHold(policy([{ repository: 'fixture/repo', events: [] }]), term)).toBeNull()
      expect(nightTermHold({ state: 'unknown', reason: 'x' } as never, term)).toMatch(/could not be read/u)
    }
    // A default-branch deploy holds the merge and the push, not a PR write on another branch.
    const main = policy([{ repository: 'fixture/repo', events: ['default-branch'] }])
    expect(nightTermHold(main, merge)).toMatch(/deploys/u)
    expect(nightTermHold(main, push)).toMatch(/deploys/u)
    expect(nightTermHold(main, pr)).toBeNull()
    expect(nightTermHold(policy([{ repository: 'fixture/repo', events: ['pull-requests'] }]), pr)).toMatch(/deploys/u)
    expect(nightTermHold(policy([]), { id: 'r', kind: 'rounds', rounds: 1, proposed: 1, reason: 'r' } as never)).toBeNull()
  })
})

describe('A native Bash result as an action outcome', () => {
  it('reads ok or failed only from a named exit code and calls the rest unknown', () => {
    expect(bashExit({ exit_code: 1 })).toBe('failed')
    expect(bashExit(JSON.stringify({ output: 'synthetic', metadata: { exit_code: 128 } }))).toBe('failed')
    expect(bashExit({ metadata: { exit_code: 0 } })).toBe('ok')
    expect(bashExit(JSON.stringify({ output: 'synthetic' }))).toBe('unknown')
    expect(bashExit('not json')).toBe('unknown')
    expect(bashExit(undefined)).toBe('unknown')
  })
})

describe('Who the hook asks to lift a hold (F5, S5)', () => {
  it.runIf(process.platform === 'linux')('sends the token only on the connection whose listener the kernel names as its ancestor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-listener-'))
    const seen: string[] = []
    // BMN's side: answers auth, then the claim, on one connection.
    const own = createServer(socket => {
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk.toString()
        for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
          const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1)
          seen.push(message.method)
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'auth' ? { ok: true } : { allowed: true } }) + '\n')
        }
      })
    })
    // Stands in for any other local process that opened a socket and put its path in the environment; it logs what arrives.
    const other = spawn(process.execPath, ['-e', `require('node:net').createServer(s => s.on('data', d => process.stderr.write(d))).listen(${JSON.stringify(join(root, 'other.sock'))}, () => console.log('up')); setTimeout(() => {}, 30000)`],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    let leaked = ''
    other.stderr.on('data', chunk => { leaked += chunk.toString() })
    try {
      await new Promise<void>(resolve => own.listen(join(root, 'own.sock'), resolve))
      await new Promise<void>(resolve => other.stdout.once('data', () => resolve()))
      expect(await callOwnListener(join(root, 'own.sock'), 'synthetic-token', 'epic.guard.claim', { callId: 'c1' })).toEqual({ result: { allowed: true } })
      expect(seen).toEqual(['auth', 'epic.guard.claim'])
      expect(await callOwnListener(join(root, 'other.sock'), 'synthetic-token', 'epic.guard.claim', { callId: 'c2' })).toBeNull()
      expect(await callOwnListener(join(root, 'absent.sock'), 'synthetic-token', 'epic.guard.claim', { callId: 'c3' })).toBeNull()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(leaked).not.toContain('synthetic-token')
    } finally {
      other.kill()
      await new Promise<void>(resolve => own.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  })
})
