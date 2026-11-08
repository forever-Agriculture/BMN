// MODULE: plan-publish.test.mjs - Epic 107 publication on real bare remotes with dirty indexes and original go ancestry
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBoard, resolvePlan, rowToken } from '../../apps/desktop/bin/plan-board.mjs'
import { approvalText, recordGo, runPlanCommand } from '../../apps/desktop/bin/plan-cli.mjs'
import { publishPlan, publicationState } from '../../apps/desktop/bin/plan-publish.mjs'
import { planWorkingDigest } from '../../apps/desktop/bin/plan-reconciliation.mjs'
import { readAllowances, recordAllow } from '../../apps/desktop/bin/plan-allowances.mjs'
import { BMAD_PARSER_PATHS, BMAD_PARSER_ORIGINAL, BMAD_PARSER_PREPARED } from '../../apps/desktop/bin/plan-bmad-parser.mjs'
import { compatibleParser } from '../plan/bmad-parser-patch.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() }
function file(root, path, text) { const p = join(root, path); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p }
function readGo(f, epic = 1) {
  if (!process.env.DEV_AUTO_RUN_NEEDS) return null
  const bin = join(f.root, 'bin'); mkdirSync(bin, { recursive: true })
  try { symlinkSync(join(import.meta.dirname, '../../apps/desktop/bin/bmn'), join(bin, 'bmn')) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const result = spawnSync('python3', [process.env.DEV_AUTO_RUN_NEEDS, String(epic), '--project', f.repo, '--json'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
  expect(result.status, result.stderr).toBe(0)
  const { state, go_commit, approved_text, parsed } = JSON.parse(result.stdout)
  return { state, go_commit, approved_text, parsed }
}
function ledger(f, ...args) {
  return spawnSync('python3', [join(process.env.DEV_AUTO_RUN_NEEDS, '../spend_ledger.py'), ...args], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(f.root, 'state'), PATH: `${join(f.root, 'bin')}:${process.env.PATH}` } })
}
function budgetSnapshot(f) {
  const folder = join(f.root, 'state/dev-auto/budgets')
  return Object.fromEntries(readdirSync(folder).map(name => [name, readFileSync(join(folder, name)).toString('base64')]))
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plan-publish-')); roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'f@example.invalid')
  file(repo, 'product.txt', 'base product\n')
  file(repo, 'plan/status.yaml', 'format: bmn-plan\nschema_version: 1\nqueue: []\ndevelopment_status:\n  epic-1: backlog\n  1-1-probe: backlog\n  epic-2: backlog\n')
  const epic = '# Epic 1: Probe\n## Run needs\n- **Extra repair rounds:** 4.\n- **Money cap:** none.\n## Decisions\nSynthetic.\n## Stories\n### Story 1.1: Probe\n'
  file(repo, 'plan/epics/001-probe.md', epic)
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  const remote = join(root, 'remote.git'); git(repo, 'clone', '--bare', repo, remote)
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'fetch', '-q', 'origin'); git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const plan = await resolvePlan(repo)
  let policyReads = 0
  const readPolicy = async () => { policyReads++; return { repository: { authorizes: true, level: 'merge-and-push-main' } } }
  return { root, repo, remote, plan, epic, readPolicy, reads: () => policyReads }
}

const ALLOWANCES = 'schema: 1\nepic: 1\nlimits:\n  rechecks: {limit: 2, ceiling: 4, per: boundary}\n  repair_rounds: {limit: 4, ceiling: 8, per: boundary}\nmay: []\nstays_out:\n  - production\n'
/** A published go on an epic with a file, and a second clone that can change the default branch. */
async function allowed(f, text = ALLOWANCES, { replicatedGo = false } = {}) {
  file(f.repo, 'plan/allowances/001.yaml', text)
  await recordGo(f.plan, { epic: 1, source: '"Go" 2026-11-05T15:15', approved: `sha256:${approvalText(f.epic, text)}`, expect: rowToken('epic-1', 'backlog', '') })
  if (!replicatedGo) git(f.repo, 'push', '-q', 'origin', 'main')
  const other = join(f.root, 'other'); git(f.repo, 'clone', f.remote, other)
  git(other, 'config', 'user.name', 'Fixture'); git(other, 'config', 'user.email', 'f@example.invalid')
  if (replicatedGo) {
    file(other, 'plan/status.yaml', readFileSync(f.plan.boardPath))
    file(other, 'plan/allowances/001.yaml', text)
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'publish plan bytes without local approval ancestry'); git(other, 'push', '-q', 'origin', 'main')
  }
  return other
}
const raise = async (f, value) => recordAllow(f.plan, 1, { changes: [`limits.rechecks.limit=${value}`], reason: 'a real finding needs one more', expect: (await readAllowances(f.plan, 1)).token })
const rejected = (f) => chmodSync(file(f.remote, 'hooks/pre-receive', '#!/bin/sh\nexit 1\n'), 0o755)

/** A plan PR is merged, then another epic changes upstream while our approved local work advances. */
async function advancedPublication({ mismatch = false, restriction = false, withdrawal = false } = {}) {
  const f = await fixture()
  file(f.repo, 'plan/allowances/002.yaml', ALLOWANCES.replace('epic: 1', 'epic: 2'))
  const other = await allowed(f)
  if (mismatch) {
    file(other, 'plan/incoming-note.md', 'included by projection, absent from the local checkpoint\n')
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'upstream note'); git(other, 'push', '-q', 'origin', 'main')
  }
  await raise(f, 3)
  file(f.repo, 'plan/status.yaml', readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8').replace('1-1-probe: backlog', '1-1-probe: in-progress # first publication'))
  expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, pullRequest: async () => 'https://example.invalid/plan/1' })).toMatchObject({ outcome: 'unpublished', conflicts: [] })
  git(other, 'fetch', '-q', 'origin', 'bmn/plan')
  git(other, 'merge', '--no-ff', '-qm', 'merge plan PR', 'FETCH_HEAD')
  file(other, 'plan/allowances/002.yaml', readFileSync(join(other, 'plan/allowances/002.yaml'), 'utf8').replace('stays_out:', 'stays_out:\n  - customer data'))
  if (restriction) file(other, 'plan/allowances/001.yaml', readFileSync(join(other, 'plan/allowances/001.yaml'), 'utf8').replace('limit: 3, ceiling: 4', 'limit: 2, ceiling: 4'))
  if (withdrawal) file(other, 'plan/status.yaml', readFileSync(join(other, 'plan/status.yaml'), 'utf8').replace(/^ {2}epic-1:.*$/mu, '  epic-1: backlog'))
  git(other, 'add', '-A'); git(other, 'commit', '-qm', 'later upstream changes'); git(other, 'push', '-q', 'origin', 'main')
  await raise(f, 4)
  file(f.repo, 'plan/status.yaml', readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8').replace('1-1-probe: in-progress # first publication', '1-1-probe: review # newer local work'))
  return f
}

describe('a merged publication followed by later upstream work (113, Q39)', () => {
  it('uses the equivalent published checkpoint as baseline and preserves the other epic hold and ledger', async () => {
    const f = await advancedPublication()
    const before = await readAllowances(f.plan, 1)
    let budgetBefore
    if (process.env.DEV_AUTO_RUN_NEEDS) {
      expect(readGo(f).state).toBe('GO')
      const opened = ledger(f, 'open', '--epic', '1', '--project', f.repo)
      expect(opened.status, opened.stderr).toBe(0)
      const budget = /BUDGET ([\w-]+):/u.exec(opened.stdout)[1]
      expect(ledger(f, 'use', '--budget', budget, '--limit', 'rechecks', '--boundary', '1.1', '--use-id', 'before-merged-reconcile').stdout).toMatch(/^TAKEN/u)
      budgetBefore = budgetSnapshot(f)
    }
    const reads = f.reads()
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [2] })
    expect(f.reads()).toBe(reads)
    expect(await readAllowances(f.plan, 1)).toMatchObject({ state: 'recorded', hand_edit: null, token: before.token, go_commit: before.go_commit, current: before.current })
    expect(readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8')).toContain('review # newer local work')
    if (process.env.DEV_AUTO_RUN_NEEDS) {
      expect(readGo(f).state).toBe('GO')
      expect(budgetSnapshot(f)).toEqual(budgetBefore)
    }
  }, 30_000)
  it.each([
    ['mismatched checkpoint/publication snapshots', { mismatch: true }],
    ['a genuine post-merge restriction', { restriction: true }],
    ['a genuine post-merge withdrawal', { withdrawal: true }]
  ])('keeps the epic held on %s', async (_name, options) => {
    const f = await advancedPublication(options)
    expect((await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).conflicts).toContain(1)
    if (process.env.DEV_AUTO_RUN_NEEDS) expect(readGo(f).state).toBe('PLAN_CONFLICT')
  }, 30_000)
  it('does not move a newer acknowledged checkpoint backward', async () => {
    const f = await advancedPublication()
    const path = join(f.repo, '.git/bmn-plan-publish/state.json')
    const state = JSON.parse(readFileSync(path, 'utf8'))
    const newer = git(f.repo, 'rev-parse', 'HEAD')
    expect(git(f.repo, 'merge-base', '--is-ancestor', state.publishedCheckpoint, newer)).toBe('')
    state.acknowledged = newer
    writeFileSync(path, JSON.stringify(state))
    await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })
    expect(JSON.parse(readFileSync(path, 'utf8')).acknowledged).toBe(newer)
  }, 30_000)
})

describe('a change of limits on a tracked plan (110.5 AC6, AC7)', () => {
  it('holds a newly added upstream allowance file without a recorded local allowance', async () => {
    const f = await fixture()
    await recordGo(f.plan, { epic: 1, source: '"Go" 2026-11-05T15:15', approved: `sha256:${approvalText(f.epic)}`, expect: rowToken('epic-1', 'backlog', '') })
    git(f.repo, 'push', '-q', 'origin', 'main')
    const other = join(f.root, 'other'); git(f.repo, 'clone', f.remote, other)
    git(other, 'config', 'user.name', 'Fixture'); git(other, 'config', 'user.email', 'f@example.invalid')
    file(other, 'plan/allowances/001.yaml', ALLOWANCES)
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'new upstream authority file'); git(other, 'push', '-q', 'origin', 'main')
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [1] })
    if (process.env.DEV_AUTO_RUN_NEEDS) expect(readGo(f).state).toBe('PLAN_CONFLICT')
  })
  it('holds malformed UTF-8 instead of equating its replacement character with valid local text', async () => {
    const f = await fixture()
    const initial = ALLOWANCES.replace('production', 'fixture \uFFFD')
    const other = await allowed(f, initial)
    const bytes = Buffer.from(initial), at = bytes.indexOf(Buffer.from('\uFFFD'))
    const malformed = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 3)])
    file(other, 'plan/allowances/001.yaml', malformed)
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'malformed upstream UTF-8'); git(other, 'push', '-q', 'origin', 'main')
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [1] })
    expect((await readAllowances(f.plan, 1)).state).toBe('conflict')
  })
  it.each([
    ['optional quotes', text => text.replace('  - production', "  - 'production'")],
    ['comments and spacing', text => text.replace('may: []', 'may: [] # formatting only').replace('stays_out:', '\nstays_out:')],
    ['flow-map field order', text => text.replace('{limit: 2, ceiling: 4, per: boundary}', '{per: boundary, ceiling: 4, limit: 2}')]
  ])('preserves the recorded bytes on upstream %s', async (_name, format) => {
    const f = await fixture()
    const other = await allowed(f)
    const before = await readAllowances(f.plan, 1)
    file(other, 'plan/allowances/001.yaml', format(ALLOWANCES))
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'format only'); git(other, 'push', '-q', 'origin', 'main')
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'published', conflicts: [] })
    expect(await readAllowances(f.plan, 1)).toMatchObject({ state: 'recorded', hand_edit: null, token: before.token, current: before.current })
    expect(readFileSync(join(f.repo, 'plan/allowances/001.yaml'), 'utf8')).toBe(ALLOWANCES)
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'published', conflicts: [], unpublished: 0 })
  })
  it('reconciles quote-only upstream differences after an approved Prepared update, preserving its record and ledger', async () => {
    const f = await fixture()
    const secondEpic = f.epic.replaceAll('Epic 1', 'Epic 2').replaceAll('1.1', '2.1')
    file(f.repo, 'plan/epics/002-other.md', secondEpic)
    await recordGo(f.plan, { epic: 2, source: '"Go" 2026-11-05T15:15', approved: `sha256:${approvalText(secondEpic)}`, expect: rowToken('epic-2', 'backlog', '') })
    const otherGo = readGo(f, 2)
    const initial = `${ALLOWANCES}prepared:\n  - {kind: owner step, target: "Q on TEST", check: "pending decision"}\n`
    const other = await allowed(f, initial)
    const go = (await readAllowances(f.plan, 1)).go_commit
    let budgetBefore
    if (process.env.DEV_AUTO_RUN_NEEDS) {
      expect(readGo(f).state).toBe('GO')
      const opened = ledger(f, 'open', '--epic', '1', '--project', f.repo)
      expect(opened.status, opened.stderr).toBe(0)
      const budget = /BUDGET ([\w-]+):/u.exec(opened.stdout)[1]
      expect(ledger(f, 'use', '--budget', budget, '--limit', 'rechecks', '--boundary', '1.1', '--use-id', 'before-format-reconcile').stdout).toMatch(/^TAKEN/u)
      budgetBefore = budgetSnapshot(f)
    }
    await recordAllow(f.plan, 1, {
      changes: ['prepared.Q on TEST.check=owner chose A'], reason: 'record the existing decision',
      source: '"record my choice A" 2026-11-08T09:30', expect: (await readAllowances(f.plan, 1)).token
    })
    const before = await readAllowances(f.plan, 1)
    const recorded = before.current.text
    expect(recorded).toContain('target: Q on TEST')
    file(other, 'plan/allowances/001.yaml', recorded.replace('target: Q on TEST', 'target: "Q on TEST"'))
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'same decision, optional YAML quotes'); git(other, 'push', '-q', 'origin', 'main')
    // Reproduce a hold saved by the old publisher; recovery must use publish, not erase its journal.
    file(f.repo, '.git/bmn-plan-publish/state.json', JSON.stringify({ conflicts: [1] }))
    expect((await readAllowances(f.plan, 1)).state).toBe('conflict')
    file(f.repo, 'plan/local-note.md', 'preserve current planning notes\n')
    file(f.repo, 'product.txt', 'unrelated unstaged product\n')
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'published', conflicts: [] })
    const after = await readAllowances(f.plan, 1)
    expect(after).toMatchObject({ state: 'recorded', hand_edit: null, token: before.token, go_commit: go, at_go: before.at_go, current: before.current, changes: before.changes })
    expect(readFileSync(join(f.repo, 'plan/allowances/001.yaml'), 'utf8')).toBe(recorded)
    expect(readFileSync(join(f.repo, 'plan/local-note.md'), 'utf8')).toBe('preserve current planning notes\n')
    expect(readFileSync(join(f.repo, 'product.txt'), 'utf8')).toBe('unrelated unstaged product\n')
    expect(git(f.remote, 'show', 'main:product.txt')).toBe('base product')
    if (process.env.DEV_AUTO_RUN_NEEDS) {
      expect(readGo(f)).toMatchObject({ state: 'GO', go_commit: go })
      expect(readGo(f, 2)).toEqual(otherGo)
      expect(budgetSnapshot(f)).toEqual(budgetBefore)
    }
  }, 30_000)
  it('keeps a reconciled allowance usable after its next recorded amendment while another epic stays held', async () => {
    const f = await fixture()
    file(f.repo, 'plan/allowances/002.yaml', ALLOWANCES.replace('epic: 1', 'epic: 2'))
    const initial = `${ALLOWANCES}prepared:\n  - {kind: owner step, target: "Q on TEST", check: "pending decision"}\n`
    const other = await allowed(f, initial)
    const go = (await readAllowances(f.plan, 1)).go_commit
    if (process.env.DEV_AUTO_RUN_NEEDS) {
      expect(readGo(f).state).toBe('GO')
      const opened = ledger(f, 'open', '--epic', '1', '--project', f.repo)
      expect(opened.status, opened.stderr).toBe(0)
      const budget = /BUDGET ([\w-]+):/u.exec(opened.stdout)[1]
      expect(ledger(f, 'use', '--budget', budget, '--limit', 'rechecks', '--boundary', '1.1', '--use-id', 'before-next-amendment').stdout).toMatch(/^TAKEN/u)
    }
    await recordAllow(f.plan, 1, {
      changes: ['prepared.Q on TEST.check=owner chose A'], reason: 'record the existing decision',
      source: '"record my choice A" 2026-11-08T09:30', expect: (await readAllowances(f.plan, 1)).token
    })
    const reconciled = (await readAllowances(f.plan, 1)).current.text
    file(other, 'plan/allowances/001.yaml', reconciled.replace('target: Q on TEST', 'target: "Q on TEST"'))
    file(other, 'plan/allowances/002.yaml', ALLOWANCES.replace('epic: 1', 'epic: 2').replace('production', 'production\n  - TEST'))
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'same prerequisite; separate epic restriction'); git(other, 'push', '-q', 'origin', 'main')
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [2] })
    await raise(f, 3)
    const before = await readAllowances(f.plan, 1), budget = process.env.DEV_AUTO_RUN_NEEDS ? budgetSnapshot(f) : null
    file(f.repo, 'plan/current-notes.md', 'keep current planning notes\n')
    file(f.repo, 'product.txt', 'keep unstaged product\n')
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [2] })
    expect(await readAllowances(f.plan, 1)).toMatchObject({ state: 'recorded', hand_edit: null, go_commit: go, token: before.token, current: before.current, changes: before.changes })
    expect(readFileSync(join(f.repo, 'plan/allowances/001.yaml'), 'utf8')).toBe(before.current.text)
    expect(readFileSync(join(f.repo, 'plan/current-notes.md'), 'utf8')).toBe('keep current planning notes\n')
    expect(readFileSync(join(f.repo, 'product.txt'), 'utf8')).toBe('keep unstaged product\n')
    if (process.env.DEV_AUTO_RUN_NEEDS) {
      expect(readGo(f)).toMatchObject({ state: 'GO', go_commit: go })
      expect(budgetSnapshot(f)).toEqual(budget)
    }
  }, 30_000)
  /** Epic 1 reconciles quote-only YAML after a recorded amendment while epic 2 stays genuinely held. */
  async function reconcilingWithOtherHold({ otherRestriction = true } = {}) {
    const f = await fixture()
    file(f.repo, 'plan/allowances/002.yaml', ALLOWANCES.replace('epic: 1', 'epic: 2'))
    const other = await allowed(f, `${ALLOWANCES}prepared:\n  - {kind: owner step, target: "Q on TEST", check: "pending decision"}\n`)
    await recordAllow(f.plan, 1, {
      changes: ['prepared.Q on TEST.check=owner chose A'], reason: 'record the existing decision',
      source: '"record my choice A" 2026-11-08T09:30', expect: (await readAllowances(f.plan, 1)).token
    })
    const reconciled = (await readAllowances(f.plan, 1)).current.text
    file(other, 'plan/allowances/001.yaml', reconciled.replace('target: Q on TEST', 'target: "Q on TEST"'))
    if (otherRestriction) file(other, 'plan/allowances/002.yaml', ALLOWANCES.replace('epic: 1', 'epic: 2').replace('production', 'production\n  - TEST'))
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'same prerequisite; separate epic restriction'); git(other, 'push', '-q', 'origin', 'main')
    // Grafting the root commit changes no history, but Git now reports the checkout as shallow.
    const shallow = () => writeFileSync(join(f.repo, '.git/shallow'), `${git(f.repo, 'rev-list', '--max-parents=0', 'HEAD')}\n`)
    return { f, shallow }
  }
  it('keeps the hold of a reconciliation it cannot prove instead of releasing it unremembered (Luna 130626 F1)', async () => {
    const { f, shallow } = await reconcilingWithOtherHold()
    shallow()
    const state = await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })
    expect(state).toMatchObject({ outcome: 'PLAN_CONFLICT' })
    expect([...state.conflicts].sort()).toEqual([1, 2])
    expect(JSON.parse(readFileSync(join(f.repo, '.git/bmn-plan-publish/state.json'), 'utf8')).allowanceBaselines).toBeUndefined()
    expect(f.reads()).toBe(0)
  }, 30_000)
  it('neither integrates nor publishes an unprovable reconciliation when only a non-publication hold stands (Luna 132744)', async () => {
    const { f, shallow } = await reconcilingWithOtherHold({ otherRestriction: false })
    file(f.repo, 'plan/migration.json', JSON.stringify({ approval_conflicts: [2] }))
    shallow()
    const head = git(f.repo, 'rev-parse', 'HEAD'), remote = git(f.remote, 'rev-parse', 'main')
    const state = await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })
    expect(state).toMatchObject({ outcome: 'PLAN_CONFLICT' })
    expect(state.conflicts).toContain(1)
    expect(git(f.remote, 'rev-parse', 'main')).toBe(remote)
    expect(spawnSync('git', ['-C', f.repo, 'merge-base', '--is-ancestor', remote, 'HEAD']).status).not.toBe(0)
    expect(git(f.repo, 'rev-list', '--merges', `${head}..HEAD`)).toBe('')
    expect(f.reads()).toBe(0)
  }, 30_000)
  it('refuses a remembered baseline in a shallow checkout, whose history could hide a transient restriction (Luna 130626 F2)', async () => {
    const { f, shallow } = await reconcilingWithOtherHold()
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [2] })
    expect(JSON.parse(readFileSync(join(f.repo, '.git/bmn-plan-publish/state.json'), 'utf8')).allowanceBaselines.files['plan/allowances/001.yaml']).toBeDefined()
    await raise(f, 3)
    shallow()
    const state = await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })
    expect([...state.conflicts].sort()).toEqual([1, 2])
    expect(f.reads()).toBe(0)
  }, 30_000)
  it('holds a restriction arriving between publication and integration without acknowledging or overwriting it', async () => {
    const f = await fixture()
    await allowed(f)
    await raise(f, 3)
    const before = await readAllowances(f.plan, 1)
    // A real remote hook advances main after receiving the publication and before its fetch.
    chmodSync(file(f.remote, 'hooks/post-receive', `#!${process.execPath}
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const [, tip, ref] = readFileSync(0, 'utf8').trim().split(' ')
if (ref !== 'refs/heads/main') process.exit(0)
const env = { ...process.env, GIT_INDEX_FILE: resolve('race.index'), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' }
const git = (args, input) => execFileSync('git', args, { env, input, encoding: 'utf8' }).trim()
git(['read-tree', tip])
const text = git(['show', tip + ':plan/allowances/001.yaml']).replace('stays_out:', 'stays_out:\\n  - newly restricted TEST') + '\\n'
const blob = git(['hash-object', '-w', '--stdin'], text)
git(['update-index', '--cacheinfo', '100644,' + blob + ',plan/allowances/001.yaml'])
const tree = git(['write-tree'])
const next = git(['commit-tree', tree, '-p', tip, '-m', 'concurrent restriction'])
git(['update-ref', ref, next, tip])
`), 0o755)
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', error: 'UPSTREAM_CHANGED', conflicts: [1] })
    expect(git(f.remote, 'show', 'main:plan/allowances/001.yaml')).toContain('newly restricted TEST')
    expect(readFileSync(join(f.repo, 'plan/allowances/001.yaml'), 'utf8')).toBe(before.current.text)
    expect((await readAllowances(f.plan, 1)).state).toBe('conflict')
    expect(JSON.parse(readFileSync(join(f.repo, '.git/bmn-plan-publish/state.json'), 'utf8')).acknowledged).toBeUndefined()
    if (process.env.DEV_AUTO_RUN_NEEDS) expect(readGo(f).state).toBe('PLAN_CONFLICT')
  })
  it('refuses a non-plan merge conflict while reconciling equivalent YAML', async () => {
    const f = await fixture()
    const other = await allowed(f)
    file(f.repo, 'product.txt', 'local committed product\n')
    git(f.repo, 'add', 'product.txt'); git(f.repo, 'commit', '-qm', 'local product')
    file(other, 'product.txt', 'incoming product\n')
    file(other, 'plan/allowances/001.yaml', ALLOWANCES.replace('production', '"production"'))
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'incoming product and formatting'); git(other, 'push', '-q', 'origin', 'main')
    const head = git(f.repo, 'rev-parse', 'HEAD')
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'unpublished', error: 'GIT_FAILED' })
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(f.repo, 'product.txt'), 'utf8')).toBe('local committed product\n')
    expect(readFileSync(join(f.repo, 'plan/allowances/001.yaml'), 'utf8')).toBe(ALLOWANCES)
  })
  it('stands locally at once when the publish is rejected, says unpublished, and the run keeps the new value', async () => {
    const f = await fixture()
    await allowed(f)
    rejected(f)
    const token = (await readAllowances(f.plan, 1)).token
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '../../apps/desktop/bin/bmn'), 'plan', 'allow', '1', 'limits.rechecks.limit=3', '--reason', 'a real finding needs one more', '--expect', token, '--project', f.repo],
      { encoding: 'utf8', env: { ...process.env, BMN_SESSION_ID: '' } })
    expect(`${result.stdout}${result.stderr}`).toMatch(/^unpublished|\nunpublished/mu)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('limits.rechecks.limit: 2 -> 3')
    const read = await readAllowances(f.plan, 1)
    expect(read.state).toBe('recorded')
    expect(read.current.fields.limits.rechecks.limit).toBe(3)
    expect(git(f.repo, 'log', '-1', '--format=%B')).toMatch(/^Allow-Change: limits\.rechecks\.limit/mu)
    expect(git(f.remote, 'log', '-1', '--format=%H', 'main')).not.toBe(read.current.commit)
  })
  it('publishes a change nobody else touched, and only then is nothing unpublished', async () => {
    const f = await fixture()
    await allowed(f)
    await raise(f, 3)
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'published', conflicts: [] })
    expect(git(f.remote, 'show', 'main:plan/allowances/001.yaml')).toContain('limit: 3')
    expect((await readAllowances(f.plan, 1)).state).toBe('recorded')
  })
  it.each([
    ['a different raise upstream', (text) => text.replace('limit: 2, ceiling: 4', 'limit: 3, ceiling: 4')],
    ['a restriction upstream', (text) => text.replace('stays_out:\n', 'stays_out:\n  - customer data\n')],
    ['a new permission upstream', (text) => text.replace('may: []', 'may: [write TEST]')],
    ['a changed boundary upstream', (text) => text.replace('per: boundary', 'per: epic')],
    ['an invalid schema upstream', (text) => text.replace('schema: 1', 'schema: 2')],
    ['a duplicate key upstream', (text) => `${text}may: []\n`],
    ['a deletion upstream', () => null]
  ])('holds the epic on %s: it names the epic, keeps ours, and grants nothing until it is read again', async (_name, change) => {
    const f = await fixture()
    const other = await allowed(f)
    const path = join(other, 'plan/allowances/001.yaml')
    const incoming = change(readFileSync(path, 'utf8'))
    if (incoming === null) git(other, 'rm', '-q', 'plan/allowances/001.yaml'); else writeFileSync(path, incoming)
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'upstream terms'); git(other, 'push', '-q', 'origin', 'main')
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [1] })
    expect(f.reads()).toBe(0)
    expect(readFileSync(join(f.repo, 'plan/allowances/001.yaml'), 'utf8')).toBe(ALLOWANCES)
    const read = await readAllowances(f.plan, 1)
    expect(read.state).toBe('conflict')
    await expect(raise(f, 3)).rejects.toMatchObject({ code: 'CONFLICT' })
    if (process.env.DEV_AUTO_RUN_NEEDS) expect(readGo(f).state).toBe('PLAN_CONFLICT')
  })
  it('names the epic for a real conflict in its file: both sides raised', async () => {
    const f = await fixture()
    const other = await allowed(f)
    const path = join(other, 'plan/allowances/001.yaml')
    writeFileSync(path, readFileSync(path, 'utf8').replace('limit: 2, ceiling: 4', 'limit: 4, ceiling: 4'))
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'upstream raise'); git(other, 'push', '-q', 'origin', 'main')
    await raise(f, 3)
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [1] })
    expect(readFileSync(join(f.repo, '.git/bmn-plan-publish/conflicts/plan/allowances/001.yaml.upstream'), 'utf8')).toContain('limit: 4')
    expect((await readAllowances(f.plan, 1)).state).toBe('conflict')
  })
  it('grants nothing on a withdrawn go, and another epic stands', async () => {
    const f = await fixture()
    await allowed(f)
    const board = join(f.repo, 'plan/status.yaml')
    writeFileSync(board, readFileSync(board, 'utf8').replace(/^ {2}epic-1:.*$/mu, '  epic-1: dropped'))
    const read = await readAllowances(f.plan, 1)
    expect(read.state).toBe('withdrawn')
    await expect(raise(f, 3)).rejects.toMatchObject({ code: 'WITHDRAWN' })
  })
})

const hash = value => createHash('sha256').update(value).digest('hex')
async function partialReconciliation({ replicatedGo = false } = {}) {
  const f = await fixture()
  file(f.repo, 'plan/allowances/002.yaml', ALLOWANCES.replace('epic: 1', 'epic: 2'))
  const initial = `${ALLOWANCES}prepared:\n  - {kind: owner step, target: "Q on TEST", check: "pending decision"}\n`
  const other = await allowed(f, initial, { replicatedGo })
  await recordAllow(f.plan, 1, {
    changes: ['prepared.Q on TEST.check=owner chose A'], reason: 'record the existing decision',
    source: '"record my choice A" 2026-11-08T09:30', expect: (await readAllowances(f.plan, 1)).token
  })
  const reconciled = (await readAllowances(f.plan, 1)).current.text
  file(other, 'plan/allowances/001.yaml', reconciled.replace('target: Q on TEST', 'target: "Q on TEST"'))
  file(other, 'plan/allowances/002.yaml', ALLOWANCES.replace('epic: 1', 'epic: 2').replace('production', 'production\n  - TEST'))
  git(other, 'add', '-A'); git(other, 'commit', '-qm', 'equivalent prerequisite with separate epic hold'); git(other, 'push', '-q', 'origin', 'main')
  expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [2] })
  const journal = join(f.repo, '.git/bmn-plan-publish/state.json')
  const state = JSON.parse(readFileSync(journal, 'utf8')), anchor = state.allowanceBaselines.files['plan/allowances/001.yaml']
  const recorded = await readAllowances(f.plan, 1), sha = hash(Buffer.from(recorded.current.text))
  const authority = { 1: { go: recorded.go_commit, token: recorded.token, fingerprint: 'unchanged-authority' } }
  const before = { head: anchor.checkpoint, authority, planFiles: { 'plan/allowances/001.yaml': sha } }
  const receipt = { verdict: 'PASS', checks: ['authority unchanged', 'budgets unchanged', 'planFiles unchanged', 'authorityHistory unchanged', 'no external publication path reached'].map(name => ({ name, result: 'PASS' })), before, after: before, ordinaryReaders: { epic1: { state: 'recorded', hand_edit: null, token: recorded.token } } }
  await raise(f, 3)
  return { ...f, other, initial, reconciled, journal, anchor, receipt }
}
function remoteChange(f, change, message = 'incoming change') {
  change()
  git(f.other, 'add', '-A'); git(f.other, 'commit', '-qm', message); git(f.other, 'push', '-q', 'origin', 'main')
}
function legacyMigration(f) {
  const state = JSON.parse(readFileSync(f.journal, 'utf8'))
  delete state.allowanceBaselines
  writeFileSync(f.journal, JSON.stringify({ ...state, conflicts: [1, 2] }))
  const receiptPath = file(f.root, 'reconciliation.json', JSON.stringify(f.receipt))
  return {
    reconciliationMigration: { receiptPath, receiptSha256: hash(readFileSync(receiptPath)), files: [{ file: 'plan/allowances/001.yaml', ...f.anchor }] },
    reconciliationExpect: { head: git(f.repo, 'rev-parse', 'HEAD'), workingPlanSha256: planWorkingDigest(f.plan), upstream: git(f.repo, 'rev-parse', 'origin/main'), prTip: null, journalSha256: hash(readFileSync(f.journal)) }
  }
}

describe('per-allowance reconciliation proofs', () => {
  it('proves local Go continuity when upstream holds published bytes without that Go ancestry', async () => {
    const f = await partialReconciliation({ replicatedGo: true })
    expect(git(f.other, 'log', '--format=%B')).not.toContain('Go-Epic:')
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [2] })
    expect((await readAllowances(f.plan, 1)).state).toBe('recorded')
  }, 30_000)
  it.each(['rollback', 'restriction', 'deletion', 'invalid YAML', 'invalid UTF-8', 'restriction then revert', 'withdrawal then restore', 'hand edit', 'missing anchor', 'nonancestor anchor', 'different Go', 'PR restriction'])('retains a hold for %s', async kind => {
    const f = await partialReconciliation(), target = join(f.other, 'plan/allowances/001.yaml')
    const original = readFileSync(target)
    if (kind === 'rollback') remoteChange(f, () => writeFileSync(target, f.initial))
    if (kind === 'restriction') remoteChange(f, () => writeFileSync(target, original.toString().replace('production', 'production\n  - TEST')))
    if (kind === 'deletion') remoteChange(f, () => rmSync(target))
    if (kind === 'invalid YAML') remoteChange(f, () => writeFileSync(target, 'schema: 1\nschema: 1\nepic: 1\n'))
    if (kind === 'invalid UTF-8') remoteChange(f, () => writeFileSync(target, Buffer.concat([original, Buffer.from([0xff])])))
    if (kind === 'restriction then revert') {
      remoteChange(f, () => writeFileSync(target, original.toString().replace('production', 'production\n  - TEST')))
      remoteChange(f, () => writeFileSync(target, original), 'revert incoming restriction')
    }
    if (kind === 'withdrawal then restore') {
      const board = join(f.other, 'plan/status.yaml'), originalBoard = readFileSync(board)
      remoteChange(f, () => writeFileSync(board, originalBoard.toString().replace(/^ {2}epic-1:.*$/mu, '  epic-1: dropped')))
      remoteChange(f, () => writeFileSync(board, originalBoard), 'restore incoming row')
    }
    if (kind === 'hand edit') file(f.repo, 'plan/allowances/001.yaml', readFileSync(join(f.repo, 'plan/allowances/001.yaml'), 'utf8').replace('limit: 3', 'limit: 4'))
    if (['missing anchor', 'nonancestor anchor'].includes(kind)) {
      const state = JSON.parse(readFileSync(f.journal, 'utf8'))
      state.allowanceBaselines.files['plan/allowances/001.yaml'].checkpoint = kind === 'missing anchor' ? '0'.repeat(40) : git(f.repo, 'commit-tree', git(f.repo, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated history')
      writeFileSync(f.journal, JSON.stringify(state))
    }
    if (kind === 'different Go') {
      const row = (await readBoard(f.plan.boardPath)).rows.find(row => row.key === 'epic-1')
      await recordGo(f.plan, { epic: 1, source: '"Go again" 2026-11-08T10:30', approved: `sha256:${approvalText(f.epic, readFileSync(join(f.repo, 'plan/allowances/001.yaml'), 'utf8'))}`, expect: row.token })
    }
    if (kind === 'PR restriction') {
      git(f.other, 'checkout', '-qb', 'bmn/plan')
      writeFileSync(target, original.toString().replace('production', 'production\n  - TEST'))
      git(f.other, 'add', '-A'); git(f.other, 'commit', '-qm', 'competing plan PR restriction'); git(f.other, 'push', '-q', 'origin', 'bmn/plan')
    }
    const result = await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })
    expect(result, kind).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: expect.arrayContaining([1, 2]) })
    expect((await readAllowances(f.plan, 1)).state).toBe('conflict')
    if (process.env.DEV_AUTO_RUN_NEEDS) expect(readGo(f).state).toBe('PLAN_CONFLICT')
  }, 30_000)
  it.each([true, false])('retires baselines after all holds resolve before publication (direct=%s)', async direct => {
    const f = await partialReconciliation()
    file(f.repo, 'plan/allowances/002.yaml', readFileSync(join(f.other, 'plan/allowances/002.yaml')))
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct, pullRequest: async () => 'https://example.invalid/plan/1' })).toMatchObject({ conflicts: [], outcome: direct ? 'published' : 'unpublished' })
      expect((await readAllowances(f.plan, 1)).state).toBe('recorded')
      expect(JSON.parse(readFileSync(f.journal, 'utf8')).allowanceBaselines).toBeUndefined()
    }
  }, 30_000)
  it('migrates a pinned completed reconciliation receipt without new authority or external writes', async () => {
    const f = await partialReconciliation(), before = await readAllowances(f.plan, 1)
    const options = legacyMigration(f)
    let policyCalls = 0
    const readPolicy = async () => { policyCalls++; throw new Error('external writes forbidden') }
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await publishPlan(f.plan, { readPolicy, ...(attempt ? {} : options) })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [2] })
      expect(await readAllowances(f.plan, 1)).toMatchObject({ state: 'recorded', hand_edit: null, go_commit: before.go_commit, token: before.token, current: before.current, changes: before.changes })
    }
    expect(policyCalls).toBe(0)
  }, 30_000)
  it.each(['receipt hash', 'receipt token', 'receipt incomplete', 'local pin', 'working pin', 'upstream pin', 'PR pin'])('refuses invalid migration: %s', async kind => {
    const f = await partialReconciliation(), options = legacyMigration(f)
    if (kind === 'receipt hash') options.reconciliationMigration.receiptSha256 = '0'.repeat(64)
    if (kind === 'receipt token' || kind === 'receipt incomplete') {
      if (kind === 'receipt token') f.receipt.ordinaryReaders.epic1.token = 'wrong'
      else f.receipt.checks = []
      writeFileSync(options.reconciliationMigration.receiptPath, JSON.stringify(f.receipt))
      options.reconciliationMigration.receiptSha256 = hash(readFileSync(options.reconciliationMigration.receiptPath))
    }
    if (kind === 'local pin') options.reconciliationExpect.head = '0'.repeat(40)
    if (kind === 'working pin') file(f.repo, 'plan/current-notes.md', 'a concurrent note must be preserved\n')
    if (kind === 'upstream pin') options.reconciliationExpect.upstream = '0'.repeat(40)
    if (kind === 'PR pin') options.reconciliationExpect.prTip = '0'.repeat(40)
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, ...options })).toMatchObject({ outcome: 'unpublished', error: expect.stringMatching(/RECONCILIATION/u), conflicts: [1, 2] })
    expect((await readAllowances(f.plan, 1)).state).toBe('conflict')
  }, 30_000)
})

describe('D11 publication', () => {
  it('holds an upstream-deleted approved epic before a rejected publication and leaves another Go standing', async () => {
    const f = await fixture()
    file(f.repo, 'plan/epics/002-other.md', f.epic.replaceAll('Epic 1', 'Epic 2').replaceAll('1.1', '2.1'))
    await recordGo(f.plan, { epic: 1, source: '"Go" 2026-11-04T20:00', approved: `sha256:${approvalText(f.epic)}`, expect: rowToken('epic-1', 'backlog', '') })
    await recordGo(f.plan, { epic: 2, source: '"Go" 2026-11-04T20:00', approved: `sha256:${approvalText(readFileSync(join(f.repo, 'plan/epics/002-other.md'), 'utf8'))}`, expect: rowToken('epic-2', 'backlog', '') })
    git(f.repo, 'push', '-q', 'origin', 'main')
    const other = join(f.root, 'other'); git(f.repo, 'clone', f.remote, other)
    git(other, 'config', 'user.name', 'Fixture'); git(other, 'config', 'user.email', 'f@example.invalid')
    file(other, 'plan/status.yaml', readFileSync(join(other, 'plan/status.yaml'), 'utf8').replace(/^ {2}epic-1:.*\n/mu, ''))
    git(other, 'add', '.'); git(other, 'commit', '-qm', 'withdraw by deletion'); git(other, 'push', '-q', 'origin', 'main')
    chmodSync(file(f.remote, 'hooks/pre-receive', '#!/bin/sh\nexit 1\n'), 0o755)
    file(f.repo, 'plan/note.md', 'unrelated local planning edit\n')
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [1] })
    expect(publicationState(f.plan).conflict_values).toContainEqual(expect.objectContaining({ key: 'epic-1', upstream: null }))
    expect(f.reads()).toBe(0)
    if (process.env.DEV_AUTO_RUN_NEEDS) {
      expect(readGo(f).state).toBe('PLAN_CONFLICT')
      expect(readGo(f, 2).state).toBe('GO')
      console.log('PASS F2 integration: deleted epic held; unrelated epic GO; companion reader executed')
    }
  })
  it('keeps known holds when publication statistics fail and marks an unreadable journal unconfirmed', async () => {
    const f = await fixture()
    await recordGo(f.plan, { epic: 1, source: '"Go" 2026-11-04T20:00', approved: `sha256:${approvalText(f.epic)}`, expect: rowToken('epic-1', 'backlog', '') })
    let budget, before
    if (process.env.DEV_AUTO_RUN_NEEDS) {
      expect(readGo(f).state).toBe('GO')
      const opened = ledger(f, 'open', '--epic', '1', '--project', f.repo)
      expect(opened.status, opened.stderr).toBe(0)
      budget = /BUDGET ([\w-]+):/u.exec(opened.stdout)[1]; before = budgetSnapshot(f)
    }
    file(f.repo, '.git/bmn-plan-publish/state.json', JSON.stringify({ conflicts: [1], acknowledged: 'not-a-commit' }))
    expect(publicationState(f.plan)).toMatchObject({ conflicts: [1], publication_unavailable: true })
    if (process.env.DEV_AUTO_RUN_NEEDS) expect(readGo(f).state).toBe('PLAN_CONFLICT')
    // Also invalidate an actual prepared parser after a readable conflict journal was saved.
    file(f.repo, '.git/bmn-plan-publish/state.json', JSON.stringify({ conflicts: [1] }))
    const prepared = compatibleParser(readFileSync(new URL('./fixtures/bmad-sprint-plan.py', import.meta.url)))
    for (const path of BMAD_PARSER_PATHS) file(f.repo, path, prepared)
    file(f.repo, 'plan/status.yaml', readFileSync(join(f.repo, 'plan/status.yaml'), 'utf8').replace('format: bmn-plan', 'format: bmn-plan\nbmad_copy: true\nbmad_board: _bmad-output/implementation-artifacts/sprint-status.yaml'))
    file(f.repo, '_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n')
    file(f.repo, 'plan/bmad-copy.json', JSON.stringify({ version: 1, source_board: '_bmad-output/implementation-artifacts/sprint-status.yaml', rows: {}, excluded: {}, unresolved: {}, parser_preparation: { version: 1, paths: BMAD_PARSER_PATHS, original_sha256: BMAD_PARSER_ORIGINAL, prepared_sha256: BMAD_PARSER_PREPARED } }))
    file(f.repo, BMAD_PARSER_PATHS[0], Buffer.concat([prepared, Buffer.from('\n# later edit\n')]))
    expect(publicationState(f.plan)).toMatchObject({ conflicts: [1], publication_unavailable: true })
    if (process.env.DEV_AUTO_RUN_NEEDS) {
      expect(readGo(f).state).toBe('PLAN_CONFLICT')
      expect(ledger(f, 'round', '--budget', budget, '--boundary', 'epic', '--use-id', 'parser-hold').status).not.toBe(0)
      expect(budgetSnapshot(f)).toEqual(before)
    }
    file(f.repo, '.git/bmn-plan-publish/state.json', '{broken')
    expect(publicationState(f.plan)).toMatchObject({ authority_unconfirmed: true })
    if (process.env.DEV_AUTO_RUN_NEEDS) {
      expect(readGo(f).state).toBe('NO_GO_RECORD')
      expect(ledger(f, 'round', '--budget', budget, '--boundary', 'epic', '--use-id', 'journal-hold').status).not.toBe(0)
      expect(budgetSnapshot(f)).toEqual(before)
      console.log('PASS F3 integration: parser/journal holds; reader and round refusal; budget bytes unchanged')
    }
  })
  it('exposes publish as a no-op for an ignored plan', async () => {
    const { repo } = await fixture()
    git(repo, 'rm', '-qr', '--cached', 'plan')
    file(repo, '.gitignore', '/plan/\n'); git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'ignored plan')
    expect(await runPlanCommand(['publish', '--project', repo, '--json'])).toBe(0)
  })
  it('pushes only plan differences and retains go ancestry and unrelated dirty files', async () => {
    const f = await fixture()
    file(f.repo, 'product.txt', 'local-only commit\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'unrelated local commit')
    const go = await recordGo(f.plan, { epic: 1, source: '"Go" 2026-11-04T20:00', approved: `sha256:${approvalText(f.epic)}`, expect: rowToken('epic-1', 'backlog', '') })
    file(f.repo, 'product.txt', 'staged product\n'); git(f.repo, 'add', 'product.txt'); file(f.repo, 'product.txt', 'unstaged product\n')
    const index = git(f.repo, 'ls-files', '-s', 'product.txt')
    file(f.repo, 'plan/note.md', '# plan edit\n')
    const result = await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })
    expect(result).toMatchObject({ outcome: 'published', unpublished: 0 })
    expect(f.reads()).toBe(1)
    expect(git(f.remote, 'show', 'main:product.txt')).toBe('base product')
    expect(git(f.remote, 'show', 'main:plan/note.md')).toBe('# plan edit')
    expect(git(f.repo, 'merge-base', '--is-ancestor', go.commit, 'HEAD')).toBe('')
    expect(git(f.repo, 'ls-files', '-s', 'product.txt')).toBe(index)
    expect(readFileSync(join(f.repo, 'product.txt'), 'utf8')).toBe('unstaged product\n')
  })
  it('extends one plan PR and acknowledges a later merge without losing the original go', async () => {
    const f = await fixture()
    const go = await recordGo(f.plan, { epic: 1, source: '"Go" 2026-11-04T20:00', approved: `sha256:${approvalText(f.epic)}`, expect: rowToken('epic-1', 'backlog', '') })
    const before = readGo(f)
    let creates = 0
    const pullRequest = async () => { if (!creates) creates++; return 'https://fixture.invalid/pr/1' }
    const first = await publishPlan(f.plan, { readPolicy: f.readPolicy, pullRequest })
    expect(first).toMatchObject({ outcome: 'unpublished', publication: 'https://fixture.invalid/pr/1' })
    const old = git(f.remote, 'rev-parse', 'bmn/plan')
    file(f.repo, 'plan/later.md', 'second checkpoint\n')
    const second = await publishPlan(f.plan, { readPolicy: f.readPolicy, pullRequest })
    expect(second.unpublished).toBeGreaterThan(0)
    expect(creates).toBe(1)
    git(f.remote, 'merge-base', '--is-ancestor', old, 'bmn/plan')
    git(f.remote, 'update-ref', 'refs/heads/main', git(f.remote, 'rev-parse', 'bmn/plan'))
    expect(await publishPlan(f.plan, { readPolicy: f.readPolicy, pullRequest })).toMatchObject({ outcome: 'published', unpublished: 0 })
    git(f.repo, 'merge-base', '--is-ancestor', go.commit, 'HEAD')
    expect(readGo(f)).toEqual(before)
  })
  it('does not add commits or push again when the existing PR already has the projected tree', async () => {
    const f = await fixture(), pullRequest = async () => 'https://fixture.invalid/pr/1'
    file(f.repo, 'plan/note.md', 'one checkpoint\n')
    await publishPlan(f.plan, { readPolicy: f.readPolicy, pullRequest })
    const tip = git(f.remote, 'rev-parse', 'bmn/plan'), reads = f.reads()
    expect((await publishPlan(f.plan, { readPolicy: f.readPolicy, pullRequest })).outcome).toBe('unpublished')
    expect(git(f.remote, 'rev-parse', 'bmn/plan')).toBe(tip)
    expect(f.reads()).toBe(reads)
  })
  it('keeps a rejected push local and reports unpublished without asking', async () => {
    const f = await fixture()
    const hook = file(f.remote, 'hooks/pre-receive', '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755)
    file(f.repo, 'plan/later.md', 'local checkpoint\n')
    const result = await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })
    expect(result).toMatchObject({ outcome: 'unpublished', error: 'GIT_FAILED' })
    expect(result.unpublished).toBeGreaterThan(0)
    expect(git(f.repo, 'show', 'HEAD:plan/later.md')).toBe('local checkpoint')
    expect(publicationState(f.plan).unpublished).toBe(result.unpublished)
  })
  it('keeps both same-row values and treats an upstream withdrawal as an epic-local conflict', async () => {
    const f = await fixture()
    await recordGo(f.plan, { epic: 1, source: '"Go" 2026-11-04T20:00', approved: `sha256:${approvalText(f.epic)}`, expect: rowToken('epic-1', 'backlog', '') })
    const board = join(f.repo, 'plan/status.yaml'), base = readFileSync(board, 'utf8')
    // The approved row is already on the default branch before the two sides diverge.
    git(f.repo, 'push', '-q', 'origin', 'main')
    const other = join(f.root, 'other'); git(f.repo, 'clone', f.remote, other)
    git(other, 'config', 'user.name', 'Fixture'); git(other, 'config', 'user.email', 'f@example.invalid')
    const incoming = base.replace(/^ {2}epic-1:.*$/mu, '  epic-1: dropped # withdrawn upstream')
    file(other, 'plan/status.yaml', incoming)
    git(other, 'add', '.'); git(other, 'commit', '-qm', 'withdraw'); git(other, 'push', '-q', 'origin', 'main')
    file(f.repo, 'plan/status.yaml', base.replace(/^ {2}epic-1:.*$/mu, '  epic-1: review # local'))
    const result = await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })
    expect(result).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [1] })
    expect(f.reads()).toBe(0)
    expect(readFileSync(board, 'utf8')).toContain('epic-1: review # local')
    expect(readFileSync(join(f.repo, '.git/bmn-plan-publish/conflicts/plan/status.yaml.upstream'), 'utf8')).toContain('withdrawn upstream')
    expect(publicationState(f.plan).conflict_values).toContainEqual(expect.objectContaining({ key: 'epic-1', local: '  epic-1: review # local', upstream: '  epic-1: dropped # withdrawn upstream' }))
    // Accepting the kept incoming row resolves the temporary hold without an owner card or a new go.
    file(f.repo, 'plan/status.yaml', incoming)
    const resolved = await publishPlan(f.plan, { readPolicy: f.readPolicy, direct: true })
    expect(resolved).toMatchObject({ outcome: 'published', conflicts: [], unpublished: 0 })
  })
  it('keeps a concurrent same-row edit on the open plan PR as a conflict', async () => {
    const f = await fixture(), pullRequest = async () => 'https://fixture.invalid/pr/1'
    const path = join(f.repo, 'plan/status.yaml'), base = readFileSync(path, 'utf8')
    file(f.repo, 'plan/note.md', 'first publish\n')
    await publishPlan(f.plan, { readPolicy: f.readPolicy, pullRequest })
    const other = join(f.root, 'other'); git(f.repo, 'clone', '-b', 'bmn/plan', f.remote, other)
    git(other, 'config', 'user.name', 'Fixture'); git(other, 'config', 'user.email', 'f@example.invalid')
    file(other, 'plan/status.yaml', base.replace('1-1-probe: backlog', '1-1-probe: review # concurrent PR'))
    git(other, 'add', '.'); git(other, 'commit', '-qm', 'concurrent row'); git(other, 'push', '-q', 'origin', 'bmn/plan')
    const concurrent = git(f.remote, 'rev-parse', 'bmn/plan')
    file(f.repo, 'plan/status.yaml', base.replace('1-1-probe: backlog', '1-1-probe: in-progress # local'))
    const result = await publishPlan(f.plan, { readPolicy: f.readPolicy, pullRequest })
    expect(result).toMatchObject({ outcome: 'PLAN_CONFLICT', conflicts: [1] })
    expect(git(f.remote, 'rev-parse', 'bmn/plan')).toBe(concurrent)
  })
  it('merges independent adjacent rows from the open PR without losing either edit', async () => {
    const f = await fixture(), pullRequest = async () => 'https://fixture.invalid/pr/1'
    const path = join(f.repo, 'plan/status.yaml'), base = readFileSync(path, 'utf8')
    file(f.repo, 'plan/note.md', 'first publish\n')
    await publishPlan(f.plan, { readPolicy: f.readPolicy, pullRequest })
    const other = join(f.root, 'other'); git(f.repo, 'clone', '-b', 'bmn/plan', f.remote, other)
    git(other, 'config', 'user.name', 'Fixture'); git(other, 'config', 'user.email', 'f@example.invalid')
    file(other, 'plan/status.yaml', base.replace('epic-2: backlog', 'epic-2: in-progress # concurrent'))
    git(other, 'add', '.'); git(other, 'commit', '-qm', 'independent row'); git(other, 'push', '-q', 'origin', 'bmn/plan')
    file(f.repo, 'plan/status.yaml', base.replace('1-1-probe: backlog', '1-1-probe: review # local'))
    const result = await publishPlan(f.plan, { readPolicy: f.readPolicy, pullRequest })
    expect(result.outcome).toBe('unpublished')
    expect(result.conflicts).toEqual([])
    const published = git(f.remote, 'show', 'bmn/plan:plan/status.yaml')
    expect(published).toContain('epic-2: in-progress # concurrent')
    expect(published).toContain('1-1-probe: review # local')
  })
})
