// MODULE: plan-go.test.ts - Story 96.1: `bmn plan go` records the owner's go as one commit of the plan's history, refuses what it cannot record and never records one act twice
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePlan, rowToken } from '../../bin/plan-board.mjs'
import { addToQueue, approvalText, recordGo } from '../../bin/plan-cli.mjs'

const BMN = resolve(__dirname, '../../bin/bmn')
const TEMPLATES = resolve(__dirname, '../../../../skills/plan/templates')
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
const SOURCE = "card 2026-10-26T09:30Z: owner answered 'Go' to 'Record the go for Epic 7?'"
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs() })

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'bmn-plan-go-')); roots.push(root); return root
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim()
}
/** `git status --porcelain` with its leading columns kept. */
function porcelain(root: string): string {
  return execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).replace(/\n$/u, '')
}
function file(root: string, path: string, text: string): string {
  const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, text); return target
}
function bmn(cwd: string, home: string, args: string[], identity = true): { code: number; out: string; err: string; json: ReturnType<typeof JSON.parse> } {
  const result = spawnSync(process.execPath, [BMN, 'plan', ...args], {
    cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, 'state'), LC_ALL: 'C', ...(identity ? IDENTITY : {}) }
  })
  let json: ReturnType<typeof JSON.parse> = null
  try { json = JSON.parse(result.stdout) } catch { /* text output */ }
  return { code: result.status ?? -1, out: result.stdout, err: result.stderr, json }
}

const NEEDS = '- **Extra repair rounds:** 1 per boundary.\n- **Deferrable:** none.\n- **Money cap:** none; no paid launches.\n- **Named actions for an Away card:** none.\n'
function epicText(needs = NEEDS): string {
  return `# Epic 7: Fixture\n\n**Suggested lead:** Opus — fixture.\n\n## Outcome\n\nIt works.\n\n## Why\n\nThe owner, 2026-10-26: "make it".\n\n## Boundary and dependencies\n\nNone.\n\n## Truth impact\n\nnone: a fixture.\n\n## Run needs\n\n${needs}\n## Decisions\n\n- D1: synthetic.\n\n## Stories\n\n### Story 7.1: One\n\nAs the owner, I want it.\n\n**Owner:** none.\n\n**Acceptance criteria:**\n1. **Given** a, **then** b.\n\n**Verification:** unit tests.\n`
}
const BOARD = 'format: bmn-plan\nschema_version: 1\n# The order of unfinished epics; every ready epic is here.\nqueue: []\ndevelopment_status:\n  epic-6: done # finished\n  6-1-six: done\n\n  epic-7: backlog # Suggested lead: Opus · fixture\n  7-1-one: backlog\n'

/** A product repository whose ignored plan keeps its own history, as BMN's does; the plan committed once. */
function project(): { main: string; plan: string; home: string } {
  const root = fixture()
  const main = join(root, 'main')
  mkdirSync(main, { recursive: true }); git(main, 'init', '-qb', 'main')
  file(main, '.gitignore', '/plan/\n'); git(main, 'add', '.gitignore'); git(main, 'commit', '-qm', 'chore: ignore plan')
  file(main, 'plan/VISION.md', readFileSync(join(TEMPLATES, 'VISION.md'), 'utf8'))
  file(main, 'plan/PLAN.md', readFileSync(join(TEMPLATES, 'PLAN.md'), 'utf8'))
  file(main, 'plan/status.yaml', BOARD)
  file(main, 'plan/epics/006-six.md', epicText().replaceAll('Epic 7', 'Epic 6').replaceAll('Story 7.1', 'Story 6.1'))
  file(main, 'plan/epics/007-fixture.md', epicText())
  const plan = join(main, 'plan')
  git(plan, 'init', '-qb', 'main'); git(plan, 'add', '-A'); git(plan, 'commit', '-qm', 'docs: plan epic 7')
  const home = join(root, 'home'); mkdirSync(home)
  return { main, plan, home }
}
function token(main: string, home: string, key = 'epic-7'): string {
  return bmn(main, home, ['status', '--json', '--epic', '7']).json.rows.find((row: { key: string }) => row.key === key).token
}
function approved(main: string, home: string): string {
  return `sha256:${bmn(main, home, ['status', '--json', '--epic', '7']).json.approval_texts[0].sha256}`
}
/** Everything a refused go must leave as it was. */
function snapshot(plan: string): { head: string; board: string; index: string; status: string } {
  return { head: git(plan, 'rev-parse', 'HEAD'), board: readFileSync(join(plan, 'status.yaml'), 'utf8'), index: git(plan, 'ls-files', '-s'), status: porcelain(plan) }
}

describe('the owner\'s go becomes one commit of the plan\'s history (Story 96.1 AC1)', () => {
  it('commits the row\'s change to ready with the queue alone, naming his act and the approved text, and the working board follows', () => {
    const { main, plan, home } = project()
    const sha = approved(main, home)
    expect(sha).toBe(`sha256:${approvalText(epicText())}`)
    const result = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', sha, '--expect', token(main, home), '--json'])
    expect(result.code, result.err).toBe(0)
    expect(result.json).toMatchObject({ ok: true, outcome: 'recorded', go_date: '2026-10-26', approval_source: SOURCE, approved_text: sha, approved_file: 'epics/007-fixture.md', epic_file_committed: false, board_pending: false })
    expect(git(plan, 'rev-parse', 'HEAD')).toBe(result.json.commit)
    expect(git(plan, 'show', '--format=', '--name-only', 'HEAD')).toBe('status.yaml')
    const message = git(plan, 'log', '-1', '--format=%B')
    expect(message).toContain('Go-Epic: 7\nGo-Date: 2026-10-26\n')
    expect(message).toContain(`Approval-Source: ${SOURCE}\nApproved-Text: ${sha}\nApproved-File: epics/007-fixture.md`)
    const committed = git(plan, 'show', 'HEAD:status.yaml')
    expect(committed).toContain('queue:\n  - 7\ndevelopment_status:')
    expect(committed).toContain('  epic-7: ready # go 2026-10-26 · Suggested lead: Opus · fixture\n')
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toBe(`${committed}\n`)
    expect(porcelain(plan)).toBe('')
    expect(bmn(main, home, ['check']).code).toBe(0)
  })

  it('keeps unrelated changed and staged files as they were and out of the commit (AC3)', () => {
    const { main, plan, home } = project()
    expect(bmn(main, home, ['set', '7-1-one', 'blocked', '--note', 'a run edit', '--expect', token(main, home, '7-1-one')]).code).toBe(0)
    file(plan, 'PLAN.md', `${readFileSync(join(plan, 'PLAN.md'), 'utf8')}\nStaged line.\n`); git(plan, 'add', 'PLAN.md')
    file(plan, 'epics/006-six.md', `${readFileSync(join(plan, 'epics/006-six.md'), 'utf8')}\nUnstaged edit.\n`)
    expect(bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token(main, home)]).code).toBe(0)
    expect(git(plan, 'show', '--format=', '--name-only', 'HEAD')).toBe('status.yaml')
    expect(git(plan, 'show', 'HEAD:status.yaml')).toMatch(/^ {2}7-1-one: backlog$/mu)
    expect(porcelain(plan).split('\n').sort()).toEqual([' M epics/006-six.md', ' M status.yaml', 'M  PLAN.md'])
    expect(git(plan, 'diff', '--', 'status.yaml')).toMatch(/- {2}7-1-one: backlog\n\+ {2}7-1-one: blocked # a run edit/u)
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toContain('  epic-7: ready # go 2026-10-26')
  })

  it('a board staged with other rows keeps them staged and gets the go too', () => {
    const { main, plan, home } = project()
    expect(bmn(main, home, ['set', '7-1-one', 'blocked', '--note', 'staged edit', '--expect', token(main, home, '7-1-one')]).code).toBe(0)
    git(plan, 'add', 'status.yaml')
    expect(bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token(main, home)]).code).toBe(0)
    expect(git(plan, 'show', 'HEAD:status.yaml')).toMatch(/^ {2}7-1-one: backlog$/mu)
    const staged = git(plan, 'diff', '--cached', '--', 'status.yaml')
    expect(staged).toMatch(/- {2}7-1-one: backlog\n\+ {2}7-1-one: blocked # staged edit/u)
    expect(staged).not.toMatch(/^[-+] {2}epic-7/mu)
  })

  it('commits the approved epic file with the go when its approved text is not yet committed, and never a later edit', () => {
    const { main, plan, home } = project()
    file(plan, 'epics/007-fixture.md', epicText(NEEDS.replace('1 per boundary', '2 per boundary')))
    const working = approved(main, home)
    expect(bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', working, '--expect', token(main, home)]).code).toBe(0)
    expect(git(plan, 'show', '--format=', '--name-only', 'HEAD').split('\n').sort()).toEqual(['epics/007-fixture.md', 'status.yaml'])
    expect(git(plan, 'show', 'HEAD:epics/007-fixture.md')).toContain('2 per boundary')

    const second = project()
    const committed = approved(second.main, second.home)
    file(second.plan, 'epics/007-fixture.md', epicText(NEEDS.replace('1 per boundary', '3 per boundary')))
    expect(bmn(second.main, second.home, ['go', '7', '--source', SOURCE, '--approved', committed, '--expect', token(second.main, second.home)]).code).toBe(0)
    expect(git(second.plan, 'show', '--format=', '--name-only', 'HEAD')).toBe('status.yaml')
    expect(git(second.plan, 'show', 'HEAD:epics/007-fixture.md')).toContain('1 per boundary')
    expect(porcelain(second.plan)).toBe(' M epics/007-fixture.md')
  })

  it('takes the approved text from the plan commit he approved, and never a BMN decision record as his act', () => {
    const { main, plan, home } = project()
    const approvedCommit = git(plan, 'rev-parse', 'HEAD')
    // A decision record is the lead's own choice (docs/dev-auto.md), alone or beside words that are not his quoted go.
    for (const decision of ['bmn:2733d5fe-b81c-478a-95de-e99416aed1eb/plan:epic-7:go', "card 2026-10-26T09:30Z: 'Go' bmn:2733d5fe-b81c-478a-95de-e99416aed1eb/dev-auto:run:d1"]) {
      const refused = bmn(main, home, ['go', '7', '--source', decision, '--approved', approvedCommit.slice(0, 12), '--expect', token(main, home), '--json'])
      expect([refused.code, refused.json?.error?.code]).toEqual([1, 'NO_OWNER_GO'])
    }
    expect(porcelain(plan)).toBe('')
    const result = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', approvedCommit.slice(0, 12), '--date', '2026-10-27', '--expect', token(main, home), '--json'])
    expect(result.code, result.err).toBe(0)
    expect(result.json).toMatchObject({ go_date: '2026-10-27', approval_source: SOURCE, approved_text: `sha256:${approvalText(epicText())}` })
    expect(git(plan, 'log', '-1', '--format=%B')).toContain(`Approved-From: ${approvedCommit}`)
  })

  it('records the go of a plan the product repository tracks in that repository, from its default checkout only', () => {
    const root = fixture()
    const main = join(root, 'main')
    mkdirSync(main, { recursive: true }); git(main, 'init', '-qb', 'main')
    file(main, 'plan/VISION.md', readFileSync(join(TEMPLATES, 'VISION.md'), 'utf8'))
    file(main, 'plan/PLAN.md', readFileSync(join(TEMPLATES, 'PLAN.md'), 'utf8'))
    file(main, 'plan/status.yaml', BOARD)
    file(main, 'plan/epics/006-six.md', epicText().replaceAll('Epic 7', 'Epic 6').replaceAll('Story 7.1', 'Story 6.1'))
    file(main, 'plan/epics/007-fixture.md', epicText())
    file(main, 'src/app.txt', 'product\n')
    git(main, 'add', '-A'); git(main, 'commit', '-qm', 'feat: product and plan')
    file(main, 'src/app.txt', 'product changed\n')
    const home = join(root, 'home'); mkdirSync(home)
    git(main, 'worktree', 'add', '-q', '-b', 'run', join(root, 'run'))
    const refused = bmn(join(root, 'run'), home, ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token(main, home)])
    expect([refused.code, refused.err]).toEqual([1, expect.stringContaining('NOT_DEFAULT_CHECKOUT')])
    const result = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token(main, home), '--json'])
    expect(result.code, result.err).toBe(0)
    expect(git(main, 'show', '--format=', '--name-only', 'HEAD')).toBe('plan/status.yaml')
    expect(git(main, 'log', '-1', '--format=%B')).toContain('Approved-File: plan/epics/007-fixture.md')
    expect(porcelain(main)).toBe(' M src/app.txt')
  })
})

describe('what cannot be recorded is refused and leaves everything as it was (Story 96.1 AC2)', () => {
  it('no owner act, no approved text, changed terms, a stale token, a finished or unknown epic: each names the missing fact', () => {
    const { main, plan, home } = project()
    const sha = approved(main, home)
    const row = token(main, home)
    const before = snapshot(plan)
    const cases: Array<[string[], string]> = [
      [['go', '7', '--approved', sha, '--expect', row], 'NO_OWNER_GO'],
      [['go', '7', '--source', 'the owner said go', '--approved', sha, '--expect', row], 'NO_OWNER_GO'],
      [['go', '7', '--source', '"Go" with no time', '--approved', sha, '--expect', row], 'NO_OWNER_GO'],
      [['go', '7', '--source', SOURCE, '--expect', row], 'NO_APPROVED_TEXT'],
      [['go', '7', '--source', SOURCE, '--approved', 'sha256:' + '0'.repeat(64), '--expect', row], 'CHANGED_TERMS'],
      [['go', '7', '--source', SOURCE, '--approved', 'deadbeef', '--expect', row], 'NO_APPROVED_TEXT'],
      [['go', '7', '--source', SOURCE, '--approved', sha, '--expect', '0123456789abcdef'], 'CONFLICT'],
      [['go', '8', '--source', SOURCE, '--approved', sha, '--expect', row], 'NO_EPIC'],
      [['go', '7', '--source', SOURCE, '--approved', sha, '--expect', row, '--note', 'no go date here'], 'NOTE_WITHOUT_GO']
    ]
    for (const [args, code] of cases) {
      const result = bmn(main, home, [...args, '--json'])
      expect([args.join(' '), result.code, result.json?.error?.code]).toEqual([args.join(' '), 1, code])
      expect(snapshot(plan)).toEqual(before)
    }
    const done = bmn(main, home, ['go', '6', '--source', SOURCE, '--approved', `sha256:${approvalText(readFileSync(join(plan, 'epics/006-six.md'), 'utf8'))}`, '--expect', rowToken('epic-6', 'done', 'finished'), '--json'])
    expect([done.code, done.json.error.code]).toEqual([1, 'FINISHED'])
    expect(snapshot(plan)).toEqual(before)
  })

  it('changed Run needs or Decisions after the approval are refused, committed or not', () => {
    const { main, plan, home } = project()
    const sha = approved(main, home)
    file(plan, 'epics/007-fixture.md', epicText().replace('- D1: synthetic.', '- D1: changed after he approved.'))
    git(plan, 'commit', '-qam', 'docs: change a decision')
    const before = snapshot(plan)
    const result = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', sha, '--expect', token(main, home), '--json'])
    expect([result.code, result.json.error.code]).toEqual([1, 'CHANGED_TERMS'])
    expect(snapshot(plan)).toEqual(before)
  })

  it('a failed commit, an unreadable history, a plan without history and a BMAD board record nothing', () => {
    const { main, plan, home } = project()
    const before = snapshot(plan)
    writeFileSync(join(plan, '.git', 'refs', 'heads', 'main.lock'), '')
    const failed = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token(main, home), '--json'])
    expect([failed.code, failed.json.error.code]).toEqual([1, 'COMMIT_FAILED'])
    expect(snapshot(plan)).toEqual(before)
    rmSync(join(plan, '.git', 'refs', 'heads', 'main.lock'))
    expect(bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token(main, home)]).code).toBe(0)

    const broken = project()
    const brokenSha = approved(broken.main, broken.home)
    const brokenRow = token(broken.main, broken.home)
    git(broken.plan, 'update-ref', '-d', 'HEAD')
    const unreadable = bmn(broken.main, broken.home, ['go', '7', '--source', SOURCE, '--approved', brokenSha, '--expect', brokenRow, '--json'])
    expect([unreadable.code, unreadable.json.error.code]).toEqual([1, 'UNREADABLE_HISTORY'])
    expect(readFileSync(join(broken.plan, 'status.yaml'), 'utf8')).toBe(BOARD)

    const none = project()
    rmSync(join(none.plan, '.git'), { recursive: true, force: true })
    const noHistory = bmn(none.main, none.home, ['go', '7', '--source', SOURCE, '--approved', approved(none.main, none.home), '--expect', token(none.main, none.home), '--json'])
    expect([noHistory.code, noHistory.json.error.code]).toEqual([1, 'NO_HISTORY'])

    const root = fixture()
    git(root, 'init', '-qb', 'main')
    file(root, '_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n  epic-7: backlog\n')
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'docs: bmad')
    const bmad = bmn(root, none.home, ['go', '7', '--source', SOURCE, '--approved', 'sha256:' + '0'.repeat(64), '--expect', rowToken('epic-7', 'backlog', ''), '--json'])
    expect([bmad.code, bmad.json.error.code]).toEqual([1, 'BMAD'])
  })

  it('an epic row is not set to ready by hand through bmn plan set; story rows and other statuses still are', () => {
    const { main, plan, home } = project()
    const result = bmn(main, home, ['set', 'epic-7', 'ready', '--note', 'go 2026-10-26', '--expect', token(main, home)])
    expect([result.code, result.err]).toEqual([1, expect.stringContaining('GO_NEEDS_RECORD')])
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toBe(BOARD)
    expect(bmn(main, home, ['set', 'epic-7', 'in-progress', '--expect', token(main, home)]).code).toBe(0)
    expect(bmn(main, home, ['set', '7-1-one', 'review', '--expect', token(main, home, '7-1-one')]).code).toBe(0)
  })
})

describe('one act records one go, whatever was interrupted (Story 96.1 AC3)', () => {
  beforeEach(() => { for (const [name, value] of Object.entries(IDENTITY)) vi.stubEnv(name, value) })

  it('the same request again finds its commit and writes no second go', () => {
    const { main, plan, home } = project()
    const args = ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token(main, home), '--json']
    const first = bmn(main, home, args)
    const again = bmn(main, home, args)
    expect([again.code, again.json.outcome, again.json.commit]).toEqual([0, 'recorded-before', first.json.commit])
    expect(git(plan, 'log', '--format=%s').split('\n')).toEqual(['plan: go for Epic 7 (go 2026-10-26)', 'docs: plan epic 7'])
    // A retry that read the board again holds the row's token after the go: the go is complete, nothing is pending (96.7 journey).
    const fresh = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token(main, home), '--json'])
    expect([fresh.code, fresh.json.outcome, fresh.json.commit, fresh.json.row.status, fresh.json.board_pending]).toEqual([0, 'recorded-before', first.json.commit, 'ready', false])
  })

  it('a crash after the branch moved is completed by the retry: the working row and index follow, one go', async () => {
    const { main, plan, home } = project()
    const sha = approved(main, home)
    const row = token(main, home)
    vi.stubEnv('HOME', home); vi.stubEnv('XDG_STATE_HOME', join(home, 'state')) // the go's records stay in the fixture's home
    const resolved = await resolvePlan(main)
    await expect(recordGo(resolved, { epic: 7, source: SOURCE, approved: sha, expect: row, seam: (step: string) => { if (step === 'committed') throw new Error('crashed') } })).rejects.toThrow('crashed')
    expect(git(plan, 'log', '-1', '--format=%s')).toBe('plan: go for Epic 7 (go 2026-10-26)')
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toBe(BOARD)
    expect(porcelain(plan)).toBe('M  status.yaml')
    const retry = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', sha, '--expect', row, '--json'])
    expect([retry.code, retry.json.outcome, retry.json.board_pending]).toEqual([0, 'recorded-before', false])
    expect(porcelain(plan)).toBe('')
    expect(git(plan, 'log', '--format=%s').split('\n')).toHaveLength(2)
  })

  it('a crash before the branch moved recorded nothing; the retry records the go once', async () => {
    const { main, plan, home } = project()
    const sha = approved(main, home)
    const row = token(main, home)
    const before = snapshot(plan)
    vi.stubEnv('HOME', home); vi.stubEnv('XDG_STATE_HOME', join(home, 'state')) // the go's records stay in the fixture's home
    const resolved = await resolvePlan(main)
    await expect(recordGo(resolved, { epic: 7, source: SOURCE, approved: sha, expect: row, seam: (step: string) => { if (step === 'created') throw new Error('crashed') } })).rejects.toThrow('crashed')
    expect(snapshot(plan)).toEqual(before)
    const retry = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', sha, '--expect', row, '--json'])
    expect([retry.code, retry.json.outcome]).toEqual([0, 'recorded'])
    expect(git(plan, 'log', '--format=%s').split('\n')).toHaveLength(2)
  })

  it('a retry after the go was withdrawn is refused and changes nothing; after the run moved the row on, it changes nothing', () => {
    const { main, plan, home } = project()
    const args = ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token(main, home), '--json']
    expect(bmn(main, home, args).code).toBe(0)
    file(plan, 'status.yaml', BOARD)
    git(plan, 'commit', '-qam', 'docs: owner withdrew the go on epic 7')
    const retry = bmn(main, home, args)
    expect([retry.code, retry.json.error.code]).toEqual([1, 'WITHDRAWN'])
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toBe(BOARD)
    expect(git(plan, 'log', '-1', '--format=%s')).toBe('docs: owner withdrew the go on epic 7')

    const moved = project()
    const movedArgs = ['go', '7', '--source', SOURCE, '--approved', approved(moved.main, moved.home), '--expect', token(moved.main, moved.home), '--json']
    expect(bmn(moved.main, moved.home, movedArgs).code).toBe(0)
    const started = readFileSync(join(moved.plan, 'status.yaml'), 'utf8').replace('epic-7: ready # go 2026-10-26', 'epic-7: in-progress # go 2026-10-26')
    file(moved.plan, 'status.yaml', started)
    const again = bmn(moved.main, moved.home, movedArgs)
    expect([again.code, again.json.outcome, again.json.row.status, again.json.board_pending]).toEqual([0, 'recorded-before', 'in-progress', false])
    expect(readFileSync(join(moved.plan, 'status.yaml'), 'utf8')).toBe(started)
  })

  it('a retry after a withdrawal not yet committed is refused and never makes the row ready again (96 Astra review)', () => {
    const { main, plan, home } = project()
    const args = ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token(main, home), '--json']
    expect(bmn(main, home, args).code).toBe(0)
    // Put back with bmn plan set, then retried with the token of the row as it now is.
    expect(bmn(main, home, ['set', 'epic-7', 'backlog', '--expect', token(main, home), '--note', 'owner withdrew the go', '--json']).code).toBe(0)
    const withdrawn = readFileSync(join(plan, 'status.yaml'), 'utf8')
    const retry = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token(main, home), '--json'])
    expect([retry.code, retry.json.error?.code]).toEqual([1, 'WITHDRAWN'])
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toBe(withdrawn)
    // The original row restored byte for byte: the first request's token matches again, and still nothing is made ready.
    file(plan, 'status.yaml', BOARD)
    const original = bmn(main, home, args)
    expect([original.code, original.json.error?.code]).toEqual([1, 'WITHDRAWN'])
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toBe(BOARD)
    expect(git(plan, 'log', '--format=%s').split('\n')).toHaveLength(2)
  })

  it('a crash after the branch moved survives a wrong-token retry and a failed board write: the right retry completes it (96 Astra recheck)', async () => {
    const { main, plan, home } = project()
    const sha = approved(main, home)
    const row = token(main, home)
    vi.stubEnv('HOME', home); vi.stubEnv('XDG_STATE_HOME', join(home, 'state')) // the go's records stay in the fixture's home
    const resolved = await resolvePlan(main)
    await expect(recordGo(resolved, { epic: 7, source: SOURCE, approved: sha, expect: row, seam: (step: string) => { if (step === 'committed') throw new Error('crashed') } })).rejects.toThrow('crashed')
    // A retry holding another token completes nothing and leaves the go pending.
    const wrong = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', sha, '--expect', token(main, home, '7-1-one'), '--json'])
    expect([wrong.code, wrong.json.outcome, wrong.json.board_pending]).toEqual([1, 'recorded-before', true])
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toBe(BOARD)
    // A writer that ignores the lock changes the board between the retry's read and its write: nothing is written, still pending.
    const changed = BOARD.replace('  7-1-one: backlog', '  7-1-one: backlog # touched')
    const raced = await recordGo(resolved, { epic: 7, source: SOURCE, approved: sha, expect: row, seam: (step: string) => { if (step === 'completing') file(plan, 'status.yaml', changed) } })
    expect([raced.outcome, raced.pending]).toEqual(['recorded-before', true])
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toBe(changed)
    // A set that changes nothing and a set refused for its token are no later act: the go stays pending.
    expect(bmn(main, home, ['set', 'epic-7', 'backlog', '--expect', row, '--note', 'Suggested lead: Opus · fixture', '--json']).json.written[0].outcome).toBe('unchanged')
    expect(bmn(main, home, ['set', 'epic-7', 'dropped', '--expect', token(main, home, '7-1-one'), '--json']).code).toBe(1)
    const right = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', sha, '--expect', row, '--json'])
    expect([right.code, right.json.outcome, right.json.row?.status, right.json.board_pending]).toEqual([0, 'recorded-before', 'ready', false])
    expect(git(plan, 'log', '--format=%s').split('\n')).toHaveLength(2)
  })

  it('a crash after the board showed the go, before its record was cleared: the retry clears it, a later withdrawal holds (96 Astra recheck)', async () => {
    const { main, plan, home } = project()
    const sha = approved(main, home)
    const row = token(main, home)
    vi.stubEnv('HOME', home); vi.stubEnv('XDG_STATE_HOME', join(home, 'state')) // the go's records stay in the fixture's home
    const resolved = await resolvePlan(main)
    await expect(recordGo(resolved, { epic: 7, source: SOURCE, approved: sha, expect: row, seam: (step: string) => { if (step === 'published') throw new Error('crashed') } })).rejects.toThrow('crashed')
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toMatch(/^ {2}epic-7: ready # go 2026-10-26/mu)
    const retry = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', sha, '--expect', row, '--json'])
    expect([retry.code, retry.json.outcome, retry.json.board_pending]).toEqual([0, 'recorded-before', false])
    expect(bmn(main, home, ['set', 'epic-7', 'backlog', '--expect', token(main, home), '--note', 'owner withdrew the go', '--json']).code).toBe(0)
    file(plan, 'status.yaml', BOARD) // even the row the go was asked on, restored by hand
    const again = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', sha, '--expect', row, '--json'])
    expect([again.code, again.json.error?.code]).toEqual([1, 'WITHDRAWN'])
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toBe(BOARD)
  })

  it('a crash after the branch moved, then the row withdrawn by hand: no retry completes the go over it (96 Astra recheck)', async () => {
    const { main, plan, home } = project()
    const sha = approved(main, home)
    const row = token(main, home)
    vi.stubEnv('HOME', home); vi.stubEnv('XDG_STATE_HOME', join(home, 'state')) // the go's records stay in the fixture's home
    const resolved = await resolvePlan(main)
    await expect(recordGo(resolved, { epic: 7, source: SOURCE, approved: sha, expect: row, seam: (step: string) => { if (step === 'committed') throw new Error('crashed') } })).rejects.toThrow('crashed')
    const withdrawn = BOARD.replace('  epic-7: backlog # Suggested lead: Opus · fixture', '  epic-7: backlog # owner withdrew the go')
    file(plan, 'status.yaml', withdrawn)
    for (const expectToken of [row, token(main, home)]) {
      const retry = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', sha, '--expect', expectToken, '--json'])
      expect([retry.code, retry.json.error?.code]).toEqual([1, 'WITHDRAWN'])
      expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toBe(withdrawn)
    }
  })

  it('a crash after the branch moved, then a withdrawal before the retry: the retry completes nothing (96 Astra review)', async () => {
    const { main, plan, home } = project()
    const sha = approved(main, home)
    const row = token(main, home)
    vi.stubEnv('HOME', home); vi.stubEnv('XDG_STATE_HOME', join(home, 'state')) // the go's records stay in the fixture's home
    const resolved = await resolvePlan(main)
    await expect(recordGo(resolved, { epic: 7, source: SOURCE, approved: sha, expect: row, seam: (step: string) => { if (step === 'committed') throw new Error('crashed') } })).rejects.toThrow('crashed')
    // He puts the row back (the board still holds the row the go was asked on, rewritten); the retry must not publish the go over it.
    expect(bmn(main, home, ['set', 'epic-7', 'backlog', '--expect', row, '--note', 'owner withdrew the go', '--json']).code).toBe(0)
    const retry = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', sha, '--expect', row, '--json'])
    expect([retry.code, retry.json.error?.code]).toEqual([1, 'WITHDRAWN'])
    expect(readFileSync(join(plan, 'status.yaml'), 'utf8')).toMatch(/^ {2}epic-7: backlog # owner withdrew the go$/mu)
  })
})

describe('the approved text and the queue', () => {
  it('hashes Run needs and Decisions as run_needs.py does: the same vector in both suites, line endings and outer blank space aside', () => {
    const text = '# Epic 7: X\n\n## Run needs\n\n- **Money cap:** none.\n\n## Decisions\n\n- D1: yes.\n\n## Stories\n'
    expect(approvalText(text)).toBe('99de4dc862fd74d97adc69107ab01cbb87ab8bfc454f560e6aa7d517e2c107bb')
    expect(approvalText(text)).toBe(approvalText(text.replaceAll('\n', '\r\n')))
    expect(approvalText(text)).toBe(approvalText(text.replace('- **Money cap:** none.\n', '\n\n- **Money cap:** none.\n\n\n')))
    expect(approvalText(text)).not.toBe(approvalText(text.replace('D1: yes', 'D1: no')))
    expect(approvalText('# Epic 7: X\n')).toBe(approvalText('# Epic 7: X\n\n## Run needs\n\n## Decisions\n'))
  })

  it('adds the epic last to a block-list queue, once; an inline list it does not rewrite', () => {
    expect(addToQueue('queue: []\ndevelopment_status:\n', 7)).toBe('queue:\n  - 7\ndevelopment_status:\n')
    expect(addToQueue('queue:\ndevelopment_status:\n', 7)).toBe('queue:\n  - 7\ndevelopment_status:\n')
    expect(addToQueue('queue: [] # none\r\ndevelopment_status:\r\n', 7)).toBe('queue: # none\r\n  - 7\r\ndevelopment_status:\r\n')
    expect(addToQueue('queue:\n  - 3\n  - 5 # next\ndevelopment_status:\n', 7)).toBe('queue:\n  - 3\n  - 5 # next\n  - 7\ndevelopment_status:\n')
    expect(addToQueue('queue:\n  - 7\ndevelopment_status:\n', 7)).toBe('queue:\n  - 7\ndevelopment_status:\n')
    expect(addToQueue('queue: [3]\ndevelopment_status:\n', 7)).toBeNull()
  })
})
