// MODULE: plan-default.test.mjs - Epic 107 canonical default checkout and per-plan validation rules
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPlan, resolvePlan, rowToken } from '../../apps/desktop/bin/plan-board.mjs'
import { approvalText, recordGo, runPlanCommand } from '../../apps/desktop/bin/plan-cli.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })))
function git(root, ...args) { return execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', ...args], { encoding: 'utf8' }).trim() }
function file(root, path, text) { const p = join(root, path); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p }
const board = 'format: bmn-plan\nschema_version: 1\nbmad_board: _bmad-output/implementation-artifacts/sprint-status.yaml\nqueue: []\ndevelopment_status:\n  epic-1: backlog\n  1-1-probe: backlog\n'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-default-')); roots.push(root)
  const first = join(root, 'first'); mkdirSync(first)
  git(first, 'init', '-qb', 'main')
  file(first, 'plan/status.yaml', board)
  file(first, '_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n  epic-1: backlog\n')
  git(first, 'add', '.'); git(first, 'commit', '-qm', 'base')
  const remote = join(root, 'remote.git'); git(first, 'clone', '--bare', first, remote)
  git(first, 'remote', 'add', 'origin', remote); git(first, 'fetch', '-q', 'origin')
  git(first, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git(first, 'switch', '-qc', 'legacy')
  const main = join(root, 'main'); git(first, 'worktree', 'add', '-q', main, 'main')
  return { root, first, main }
}

describe('D13 canonical plan', () => {
  it('uses origin/HEAD, and the default BMN plan wins over old BMAD worktrees', async () => {
    const { first, main } = fixture()
    file(first, 'plan/status.yaml', board.replace('1-1-probe: backlog', '1-1-probe: done'))
    const resolved = await resolvePlan(first)
    expect(resolved.defaultCheckout).toBe(main)
    expect(resolved.boardCheckout).toBe(main)
    expect(resolved.format).toBe('bmn-plan')
    expect(resolved.tracked).toBe(true)
  })
  it.each(['absent', 'stale'])('asks the remote for an %s symbolic default', async (kind) => {
    const { first, main } = fixture()
    if (kind === 'absent') git(first, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
    else git(first, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone')
    expect((await resolvePlan(first)).defaultCheckout).toBe(main)
  })
  it('reads locally but refuses writes when no checkout holds the default branch', async () => {
    const { first, main } = fixture()
    git(first, 'worktree', 'remove', main)
    const plan = await resolvePlan(first)
    expect(plan.defaultAvailable).toBe(false)
    expect(plan.boardCheckout).toBe(first)
    const before = readFileSync(join(first, 'plan/status.yaml'), 'utf8')
    expect(await runPlanCommand(['set', '1-1-probe', 'review', '--expect', rowToken('1-1-probe', 'backlog', ''), '--project', first, '--json'])).toBe(1)
    expect(readFileSync(join(first, 'plan/status.yaml'), 'utf8')).toBe(before)
  })
  it('writes a declared bmad_board only through the two-way sync: set from any worktree leaves it as it was (108.6 AC3)', async () => {
    const { first, main } = fixture()
    const retained = '_bmad-output/implementation-artifacts/sprint-status.yaml'
    const before = [readFileSync(join(main, retained), 'utf8'), readFileSync(join(first, retained), 'utf8')]
    for (const from of [first, main]) {
      const status = (from === first ? 'in-progress' : 'review')
      const current = readFileSync(join(main, 'plan/status.yaml'), 'utf8').match(/1-1-probe: (\S+)/u)[1]
      expect(await runPlanCommand(['set', '1-1-probe', status, '--expect', rowToken('1-1-probe', current, ''), '--project', from, '--json'])).toBe(0)
    }
    expect(readFileSync(join(main, 'plan/status.yaml'), 'utf8')).toContain('1-1-probe: review')
    expect([readFileSync(join(main, retained), 'utf8'), readFileSync(join(first, retained), 'utf8')]).toEqual(before)
  })
  it('keeps BOTH_PLANS when the BMAD board has not been declared', async () => {
    const { first, main } = fixture()
    file(main, 'plan/status.yaml', board.replace(/^bmad_board:.*\n/mu, ''))
    await expect(resolvePlan(first)).rejects.toMatchObject({ code: 'BOTH_PLANS' })
  })
  it('uses the default config when checking whether its BMN plan declares coexistence', async () => {
    const { first, main } = fixture()
    file(first, '_bmad/bmm/config.yaml', 'implementation_artifacts: obsolete\n')
    file(main, '_bmad/bmm/config.yaml', 'implementation_artifacts: canonical\n')
    git(main, 'rm', '-q', '_bmad-output/implementation-artifacts/sprint-status.yaml')
    file(main, 'canonical/sprint-status.yaml', 'development_status:\n  epic-1: backlog\n')
    git(main, 'add', 'canonical'); git(main, 'commit', '-qm', 'canonical BMAD location')
    file(main, 'plan/status.yaml', board.replace(/^bmad_board:.*\n/mu, ''))
    await expect(resolvePlan(first)).rejects.toMatchObject({ code: 'BOTH_PLANS' })
  })
  it('records a go in canonical history, preserves a dirty index, and Python reads it from the old worktree', async () => {
    const { root, first, main } = fixture()
    const epic = '# Epic 1: Probe\n## Run needs\n- **Extra repair rounds:** 4.\n- **Money cap:** none.\n## Decisions\nSynthetic.\n## Stories\n### Story 1.1: Probe\n'
    file(main, 'plan/epics/001-probe.md', epic)
    file(main, 'product.txt', 'base\n')
    git(main, 'add', '.'); git(main, 'commit', '-qm', 'plan checkpoint')
    file(main, 'product.txt', 'staged product\n'); git(main, 'add', 'product.txt')
    file(main, 'product.txt', 'unstaged product\n')
    const index = git(main, 'ls-files', '-s', 'product.txt')
    // Git identity is local to this synthetic repository.
    git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'f@example.invalid')
    const result = await recordGo(await resolvePlan(first), { epic: 1, source: '"Go" 2026-11-04T20:00', approved: `sha256:${approvalText(epic)}`, expect: rowToken('epic-1', 'backlog', '') })
    expect(git(main, 'show', '--format=', '--name-only', result.commit)).toBe('plan/status.yaml')
    expect(git(main, 'ls-files', '-s', 'product.txt')).toBe(index)
    expect(readFileSync(join(main, 'product.txt'), 'utf8')).toBe('unstaged product\n')
    const bin = join(root, 'bin'); mkdirSync(bin)
    symlinkSync(join(import.meta.dirname, '../../apps/desktop/bin/bmn'), join(bin, 'bmn'))
    // Companion integration is enabled by the run; BMN's standalone CI has no dev-auto checkout.
    const reader = process.env.DEV_AUTO_RUN_NEEDS
    if (reader) {
      const python = spawnSync('python3', [reader, '1', '--project', first, '--json'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
      expect(python.status, python.stderr).toBe(0)
      expect(JSON.parse(python.stdout)).toMatchObject({ state: 'GO', go_commit: result.commit, approved_text: `sha256:${approvalText(epic)}` })
    }
  })
  it('applies missing thresholds from epic one and each supplied threshold independently', async () => {
    const { first, main } = fixture()
    const sections = ['Purpose', 'Users', 'Goals', 'Non-goals', 'Success signals', 'Standing constraints', 'Architecture', 'Decisions', 'Truth documents']
    file(main, 'plan/PLAN.md', sections.map((s) => `## ${s}\nFixture.\n`).join('\n'))
    file(main, 'plan/VISION.md', '## Vision\nFixture.\n## Principles\n1. Fixture.\n')
    file(main, 'plan/epics/001-probe.md', '# Epic 1: Probe\n## Outcome\nX\n## Why\nX\n## Boundary and dependencies\nX\n## Truth impact\nnone\n## Stories\n### Story 1.1: Probe\n**Acceptance criteria:**\n1. passes\n**Verification:** fixture\n')
    let findings = (await checkPlan(await resolvePlan(first))).findings.map((f) => f.reason)
    expect(findings.some((f) => f.includes('Run needs'))).toBe(true)
    expect(findings.some((f) => f.includes('Challenges'))).toBe(true)
    file(main, 'plan/status.yaml', board.replace('queue:', 'rules_from_run_needs: 9\nrules_from_prepared: 9\nrules_from_prepared_items: 9\nrules_from_challenges: 9\nqueue:'))
    findings = (await checkPlan(await resolvePlan(first))).findings
    expect(findings).toEqual([])
    for (const headers of [
      'rules_from_run_needs: 9\nrules_from_prepared: 1\nrules_from_prepared_items: 9\nrules_from_challenges: 9\n',
      'rules_from_run_needs: 9\nrules_from_prepared: 9\nrules_from_prepared_items: 1\nrules_from_challenges: 9\n'
    ]) {
      file(main, 'plan/status.yaml', board.replace('queue:', `${headers}queue:`))
      findings = (await checkPlan(await resolvePlan(first))).findings.map((f) => f.reason)
      expect(findings.some((f) => f.includes('Prepared'))).toBe(true)
    }
  })
})
