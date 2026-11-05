// MODULE: plan-allow-ledger.test.mjs - 110.5 AC4 with dev-auto's real ledger: a moved plan keeps its uses frozen, a nested plan's stay its own
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePlan, rowToken } from '../../apps/desktop/bin/plan-board.mjs'
import { approvalText, recordGo } from '../../apps/desktop/bin/plan-cli.mjs'
import { readAllowances } from '../../apps/desktop/bin/plan-allowances.mjs'

// Needs dev-auto's scripts: DEV_AUTO_RUN_NEEDS names run_needs.py, as for plan-publish.test.mjs.
const RUN_NEEDS = process.env.DEV_AUTO_RUN_NEEDS
const BMN = join(import.meta.dirname, '../../apps/desktop/bin/bmn')
const OLD = '_bmad-output/implementation-artifacts/sprint-status.yaml'
const WORDS = '"give it what it needs" 2026-11-05T21:00'
const EPIC = '# Epic 7: Fixture\n\n## Run needs\n\n- **Extra repair rounds:** 4 per boundary.\n- **Money cap:** none.\n\n## Decisions\n\nSynthetic.\n\n## Stories\n\n### Story 7.1: Keep the original requirement\n'
const ALLOWANCES = 'schema: 1\nepic: 7\nlimits:\n  repair_rounds: {limit: 4, ceiling: 8, per: boundary}\n  rechecks: {limit: 2, ceiling: 4, per: boundary}\nmay: []\nstays_out:\n  - production\n'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() }
function file(root, path, text) { const p = join(root, path); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p }

function world() {
  const root = mkdtempSync(join(tmpdir(), 'plan-allow-ledger-')); roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'f@example.invalid')
  const bin = join(root, 'bin'); mkdirSync(bin); symlinkSync(BMN, join(bin, 'bmn'))
  const env = { ...process.env, XDG_STATE_HOME: join(root, 'state'), PATH: `${bin}:${process.env.PATH}`, BMN_SESSION_ID: '' }
  const ledger = (...args) => spawnSync('python3', [join(RUN_NEEDS, '../spend_ledger.py'), ...args], { encoding: 'utf8', cwd: repo, env })
  const identity = (planRoot) => spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import spend_ledger, hashlib; print(hashlib.sha256(spend_ledger.plan_identity(sys.argv[2]).encode()).hexdigest()[:16])', join(RUN_NEEDS, '..'), planRoot], { encoding: 'utf8', env }).stdout.trim()
  const allow = async (change, source = true) => {
    const plan = await resolvePlan(repo)
    const token = (await readAllowances(plan, 7)).token
    const done = spawnSync(process.execPath, [BMN, 'plan', 'allow', '7', change, '--reason', 'the fixture asks', '--expect', token, ...(source ? ['--source', WORDS] : []), '--project', repo, '--json'], { encoding: 'utf8', env })
    return JSON.parse(done.stdout || '{}')
  }
  return { root, repo, env, ledger, identity, allow }
}

/** A BMAD board with a go whose ledger takes a repair round, then the committed move to plan/ and a BMN go with an allowances file. */
async function movedAfterARound(w, source = OLD) {
  file(w.repo, OLD, 'development_status:\n  epic-7: ready # go 2026-11-02\n  7-1-keep-the-original-requirement: ready-for-dev\n')
  file(w.repo, '_bmad-output/planning-artifacts/epics.md', EPIC)
  git(w.repo, 'add', '-A'); git(w.repo, 'commit', '-qm', 'old plan')
  const opened = w.ledger('open', '--epic', '7', '--project', w.repo)
  expect(opened.status, opened.stdout + opened.stderr).toBe(0)
  const budget = /BUDGET\s+([0-9a-f]{16}-epic-7)/u.exec(opened.stdout)[1]
  const round = w.ledger('round', '--budget', budget, '--boundary', '7.1', '--use-id', 'r1')
  expect(round.stdout, round.stderr).toMatch(/TAKEN/u)
  const anchor = git(w.repo, 'rev-parse', 'HEAD')
  file(w.repo, 'plan/status.yaml', `format: bmn-plan\nschema_version: 1\nmoved_from: ${source}\nqueue: []\ndevelopment_status:\n  epic-7: backlog\n  7-1-keep-the-original-requirement: backlog\n`)
  file(w.repo, 'plan/migration.json', JSON.stringify({ version: 1, source_board: source, history_head: anchor }))
  file(w.repo, 'plan/epics/007-fixture.md', EPIC)
  file(w.repo, 'plan/allowances/007.yaml', ALLOWANCES)
  rmSync(join(w.repo, OLD))
  git(w.repo, 'add', '-A'); git(w.repo, 'commit', '-qm', 'plan: move to plan/')
  const plan = await resolvePlan(w.repo)
  await recordGo(plan, { epic: 7, source: WORDS, approved: `sha256:${approvalText(EPIC, ALLOWANCES)}`, expect: rowToken('epic-7', 'backlog', '') })
  return budget
}

describe.skipIf(!RUN_NEEDS)('which ledger is the plan\'s, with dev-auto\'s own scripts (110.5 AC4, D13)', () => {
  it('a moved plan finds the round taken before the move, before and after the ledger is opened again', async () => {
    const w = world()
    const budget = await movedAfterARound(w)
    // The ledger keeps the identity of the board it came from.
    expect(budget.slice(0, 16)).toBe(w.identity(join(w.repo, 'plan')))
    // Before any new open: the round is found by dev-auto's own id.
    expect((await w.allow('limits.repair_rounds=')).error?.code).toBe('USED')
    expect((await w.allow('limits.repair_rounds={limit: 4, ceiling: 8, per: epic}')).error?.code).toBe('USED')
    // Opened again after the move, and a use counted there: still frozen, with or without his words.
    const reopened = w.ledger('open', '--epic', '7', '--project', w.repo)
    expect(reopened.status, reopened.stdout + reopened.stderr).toBe(0)
    expect(reopened.stdout).toContain(budget)
    const use = w.ledger('use', '--budget', budget, '--limit', 'rechecks', '--boundary', '7.1', '--use-id', 'u1')
    expect(use.stdout, use.stderr).toMatch(/^TAKEN/u)
    expect((await w.allow('limits.rechecks.per=epic')).error?.code).toBe('USED')
    expect((await w.allow('limits.rechecks.unit=hours')).error?.code).toBe('USED')
    expect((await w.allow('limits.rechecks=')).error?.code).toBe('USED')
    expect((await w.allow('limits.rechecks.per=epic', false)).error?.code).toBe('USED')
    // A limit's value still changes.
    expect((await w.allow('limits.rechecks.limit=3', false)).ok).toBe(true)
  }, 120_000)

  it('a move recorded with a doubled slash in its source board reads as dev-auto reads it (second recheck)', async () => {
    const w = world()
    const budget = await movedAfterARound(w, '_bmad-output//implementation-artifacts/sprint-status.yaml')
    expect(budget.slice(0, 16)).toBe(w.identity(join(w.repo, 'plan')))
    expect((await w.allow('limits.repair_rounds=')).error?.code).toBe('USED')
  }, 120_000)

  it('a nested plan of the same repository with a used limit of the same epic leaves this plan free', async () => {
    const w = world()
    await movedAfterARound(w)
    // dev-auto's id for another plan folder in this repository, with a use of rechecks.
    const nested = join(w.repo, 'vendor/other/plan'); mkdirSync(nested, { recursive: true })
    const id = `${w.identity(nested)}-epic-7`
    mkdirSync(join(w.root, 'state/dev-auto/budgets'), { recursive: true })
    writeFileSync(join(w.root, 'state/dev-auto/budgets', `${id}.json`), JSON.stringify({ plan_root: nested, epic: 7, gos: [], jobs: {}, rounds: {}, uses: { n1: { answer: 'TAKEN', limit: 'rechecks', boundary: '7.1', amount: 1 } } }))
    expect(readdirSync(join(w.root, 'state/dev-auto/budgets')).filter((name) => name.endsWith('-epic-7.json'))).toHaveLength(2)
    expect((await w.allow('limits.rechecks.per=epic')).ok).toBe(true)
  }, 120_000)

  it('an alias dev-auto would refuse leaves nothing known to be unused', async () => {
    const w = world()
    await movedAfterARound(w)
    const folder = join(w.root, 'state/dev-auto/budgets')
    const location = spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import spend_ledger, hashlib; print(hashlib.sha256(spend_ledger.location_identity(sys.argv[2]).encode()).hexdigest()[:16])', join(RUN_NEEDS, '..'), join(w.repo, 'plan')], { encoding: 'utf8', env: w.env }).stdout.trim()
    writeFileSync(join(folder, `${location}-epic-7.alias.json`), JSON.stringify({ version: 2, canonical: 'ffffffffffffffff-epic-7' }))
    expect((await w.allow('limits.rechecks.per=epic')).error?.code).toBe('USED')
    expect(readFileSync(join(w.repo, 'plan/allowances/007.yaml'), 'utf8')).toBe(ALLOWANCES)
  }, 120_000)
})
