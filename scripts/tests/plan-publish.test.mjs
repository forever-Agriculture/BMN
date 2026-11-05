// MODULE: plan-publish.test.mjs - Epic 107 publication on real bare remotes with dirty indexes and original go ancestry
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePlan, rowToken } from '../../apps/desktop/bin/plan-board.mjs'
import { approvalText, recordGo, runPlanCommand } from '../../apps/desktop/bin/plan-cli.mjs'
import { publishPlan, publicationState } from '../../apps/desktop/bin/plan-publish.mjs'
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
async function allowed(f) {
  file(f.repo, 'plan/allowances/001.yaml', ALLOWANCES)
  await recordGo(f.plan, { epic: 1, source: '"Go" 2026-11-05T15:15', approved: `sha256:${approvalText(f.epic, ALLOWANCES)}`, expect: rowToken('epic-1', 'backlog', '') })
  git(f.repo, 'push', '-q', 'origin', 'main')
  const other = join(f.root, 'other'); git(f.repo, 'clone', f.remote, other)
  git(other, 'config', 'user.name', 'Fixture'); git(other, 'config', 'user.email', 'f@example.invalid')
  return other
}
const raise = async (f, value) => recordAllow(f.plan, 1, { changes: [`limits.rechecks.limit=${value}`], reason: 'a real finding needs one more', expect: (await readAllowances(f.plan, 1)).token })
const rejected = (f) => chmodSync(file(f.remote, 'hooks/pre-receive', '#!/bin/sh\nexit 1\n'), 0o755)

describe('a change of limits on a tracked plan (110.5 AC6, AC7)', () => {
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
