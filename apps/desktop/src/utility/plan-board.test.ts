import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPlan, readBoard, readEpicFile, resolvePlan, rowToken } from '../../bin/plan-board.mjs'
import { KEPT_VERSIONS, keepVersion, lockBoard, replaceRow, setRow, versionsDirectory } from '../../bin/plan-cli.mjs'

const BMN = resolve(__dirname, '../../bin/bmn')
const TEMPLATES = resolve(__dirname, '../../../../skills/plan/templates')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'bmn-plan-')); roots.push(root); return root
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim()
}
function repo(root: string): string {
  mkdirSync(root, { recursive: true }); git(root, 'init', '-qb', 'main'); git(root, 'commit', '--allow-empty', '-qm', 'base'); return root
}
function file(root: string, path: string, text: string): string {
  const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, text); return target
}
function bmn(cwd: string, home: string, ...args: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [BMN, 'plan', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, 'state'), LC_ALL: 'C' }
  })
  return { code: result.status ?? -1, out: result.stdout, err: result.stderr }
}

const BOARD = `format: bmn-plan
schema_version: 1
queue:
  - 2
development_status:
  epic-1: done # accepted on dev-auto/epic-1; delivered main abc1234
  1-1-first: done
  epic-2: ready # go 2026-10-17
  2-1-second: backlog
`
function epicText(number: number, stories: number[], extra = ''): string {
  return `# Epic ${number}: Fixture ${number}\n\n**Suggested lead:** Opus — fixture.\n\n## Outcome\n\nIt works.\n\n## Why\n\nThe owner, 2026-10-17: "make it".\n\n## Boundary and dependencies\n\nNone.\n\n## Truth impact\n\nnone: a fixture.\n\n## Stories\n\n${stories.map((story) => `### Story ${number}.${story}: Part ${story}\n\nAs the owner, I want it.\n\n**Acceptance criteria:**\n1. **Given** a, **then** b.\n2. **Given** c, **then** d.\n\n**Verification:** unit tests.\n`).join('\n')}${extra}`
}
function planText(): string {
  return readFileSync(join(TEMPLATES, 'PLAN.md'), 'utf8')
}
/** A product repository whose plan is ignored and keeps its own history, as BMN's does. */
function ownProject(root: string): string {
  const main = repo(join(root, 'main'))
  file(main, '.gitignore', '/plan/\n'); git(main, 'add', '.gitignore'); git(main, 'commit', '-qm', 'ignore plan')
  file(main, 'plan/PLAN.md', planText())
  file(main, 'plan/status.yaml', BOARD)
  file(main, 'plan/epics/001-first.md', epicText(1, [1]))
  file(main, 'plan/epics/002-second.md', epicText(2, [1]))
  git(join(main, 'plan'), 'init', '-qb', 'main')
  return main
}

describe('the plan format, its reader and its check (Story 77.1)', () => {
  it('resolves our own plan from the product root, a linked worktree and inside plan/.git, reading it from the default checkout', async () => {
    const main = ownProject(fixture())
    const child = join(main, '..', 'child'); git(main, 'worktree', 'add', '-qb', 'child', child)
    for (const start of [main, child, join(main, 'plan'), join(main, 'plan', 'epics')]) {
      const plan = await resolvePlan(start)
      expect(plan).toMatchObject({ format: 'bmn-plan', planRoot: join(main, 'plan'), boardPath: join(main, 'plan/status.yaml'), boardCheckout: main, defaultCheckout: main, tracked: false, history: 'plan-repository' })
      expect(plan.productRoot).toBe(start === child ? child : main)
    }
    const json = JSON.parse(bmn(child, fixture(), 'status', '--json').out)
    expect(json).toMatchObject({ ok: true, product_root: child, default_checkout: main, run_checkout: child, plan_root: join(main, 'plan'), format: 'bmn-plan', history: 'plan-repository', queue: [2] })
    expect(json.rows.map((row: { key: string }) => row.key)).toEqual(['epic-1', '1-1-first', 'epic-2', '2-1-second'])
  })

  it('refuses both plans, an unknown schema and a malformed own plan instead of falling back to BMAD', async () => {
    const main = ownProject(fixture())
    file(main, '_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n  epic-1: done\n')
    await expect(resolvePlan(main)).rejects.toMatchObject({ code: 'BOTH_PLANS' })
    expect(bmn(main, fixture(), 'status').code).toBe(2)
    rmSync(join(main, '_bmad-output'), { recursive: true })
    file(main, 'plan/status.yaml', BOARD.replace('schema_version: 1', 'schema_version: 2'))
    await expect(resolvePlan(main)).rejects.toMatchObject({ code: 'UNKNOWN_SCHEMA' })
    file(main, 'plan/status.yaml', BOARD.replace('format: bmn-plan\n', ''))
    await expect(resolvePlan(main)).rejects.toMatchObject({ code: 'MALFORMED' })
    const json = JSON.parse(bmn(main, fixture(), 'status', '--json').out)
    expect(json).toMatchObject({ ok: false, error: { code: 'MALFORMED' } })
  })

  it('reads a 2 MB BMAD board with CRLF and comments as a stream, every selected row kept', async () => {
    const main = repo(join(fixture(), 'main'))
    const filler = Array.from({ length: 12_000 }, (_, index) => `  ${index + 100}-1-filler: done # ${'y'.repeat(160)}\r`).join('\n')
    const path = file(main, '_bmad-output/implementation-artifacts/sprint-status.yaml', `# header comment\r\ngenerated: 2026-10-17\r\ndevelopment_status:\r\n  # a comment row\r\n${filler}\n  epic-7: in-progress # last # with hash\r\n  7-1-a: review\r\n`)
    expect(statSync(path).size).toBeGreaterThan(2_000_000)
    const plan = await resolvePlan(main)
    expect(plan).toMatchObject({ format: 'bmad', boardPath: path })
    const board = await readBoard(plan.boardPath, { epics: [7] })
    expect(board.rows).toEqual([
      { key: 'epic-7', status: 'in-progress', note: 'last # with hash', line: 12_005, epic: 7, story: null, token: rowToken('epic-7', 'in-progress', 'last # with hash') },
      { key: '7-1-a', status: 'review', note: '', line: 12_006, epic: 7, story: '7.1', token: rowToken('7-1-a', 'review', '') }
    ])
    expect(board.totalRows).toBe(12_002)
    const text = bmn(main, fixture(), 'status', '--epic', '7')
    expect(text.code).toBe(0)
    expect(text.out).toContain('epic-7: in-progress # last # with hash')
    expect(text.out).toContain('2 rows of 12002')
    const all = JSON.parse(bmn(main, fixture(), 'status', '--json').out)
    expect(all.rows).toHaveLength(12_002)
    expect(bmn(main, fixture(), 'check')).toMatchObject({ code: 0 })
  })

  it('uses BMAD\'s configured path and checks a BMAD board for duplicate keys and row grammar only', async () => {
    const main = repo(join(fixture(), 'main'))
    file(main, '_bmad/bmm/config.yaml', 'implementation_artifacts: "{project-root}/planning"\n')
    file(main, 'planning/sprint-status.yaml', `development_status:\n  epic-1: ready-for-dev # ${'z'.repeat(400)}\n  1-1-a: weird\n  epic-1: done\n  not a row\n`)
    const plan = await resolvePlan(main)
    expect(plan.boardPath).toBe(join(main, 'planning/sprint-status.yaml'))
    const { findings } = await checkPlan(plan)
    expect(findings.map((finding) => finding.reason)).toEqual(['duplicate key epic-1 (first at line 2)', 'malformed row: not a row'])
    expect(bmn(main, fixture(), 'check').code).toBe(1)
  })

  it('passes a project made from the templates', async () => {
    const main = repo(join(fixture(), 'main'))
    const fill = (text: string): string => text.replaceAll('<N>', '1').replaceAll('<slug>', 'first')
    file(main, 'plan/PLAN.md', planText())
    file(main, 'plan/status.yaml', fill(readFileSync(join(TEMPLATES, 'status.yaml'), 'utf8')))
    file(main, 'plan/epics/001-first.md', fill(readFileSync(join(TEMPLATES, 'epic.md'), 'utf8')))
    const result = bmn(main, fixture(), 'check')
    expect(result.out).toContain('PASS')
    expect(result.code).toBe(0)
  })

  it('reports each structural finding on its own line', async () => {
    const main = ownProject(fixture())
    file(main, 'plan/PLAN.md', planText().replace('## Non-goals', '## Not goals'))
    file(main, 'plan/status.yaml', `format: bmn-plan
schema_version: 1
queue:
  - 1
  - 3
  - 3
  - 9
development_status:
  epic-1: done
  1-1-first: in-progress
  1-9-orphan: done
  epic-2: ready
  2-1-second: blocked
  2-1-second: backlog
  2-2-third: shiny
  epic-3: paused # parked by the owner
  epic-4: dropped
  4-1-x: done # ${'n'.repeat(161)}
  epic-5: backlog
 bad row
`)
    file(main, 'plan/epics/002-second.md', epicText(2, [1, 1, 2]).replace('## Why', '## Reason').replace('2. **Given** c', '1. **Given** c'))
    file(main, 'plan/epics/003-third.md', epicText(3, []).replace('**Verification:**', ''))
    file(main, 'plan/epics/004-dup.md', epicText(3, []))
    const big = file(main, 'plan/epics/005-big.md', epicText(5, [1]).replace('It works.', 'w'.repeat(61 * 1024)).replace('**Verification:** unit tests.', ''))
    const { findings } = await checkPlan(await resolvePlan(main))
    const reasons = findings.map((finding) => `${finding.where.replace(/:\d+$/u, '')}: ${finding.reason}`)
    const expected = [
      'plan/status.yaml: duplicate key 2-1-second (first at line 13)',
      'plan/status.yaml: malformed row: bad row',
      'plan/status.yaml: unknown status shiny for 2-2-third (one of backlog, ready, in-progress, review, blocked, paused, done, dropped)',
      'plan/status.yaml: note of 4-1-x is 161 characters, over 160',
      'plan/status.yaml: 2-1-second is blocked without a reason in its note',
      'plan/status.yaml: epic-4 is dropped without a reason in its note',
      'plan/status.yaml: queue names epic 1, which is done',
      'plan/status.yaml: queue names epic 3 twice',
      'plan/status.yaml: queue names epic 9, which has no epic-9 row',
      'plan/status.yaml: epic 2 is ready but not in queue',
      'plan/status.yaml: epic 1 is done but 1-1-first is in-progress',
      'plan/PLAN.md: missing section ## Non-goals',
      'plan/epics/002-second.md: missing section ## Why',
      'plan/epics/002-second.md: duplicate criterion 2.1 AC1',
      'plan/epics/002-second.md: duplicate story 2.1',
      'plan/epics/002-second.md: duplicate criterion 2.1 AC1',
      'plan/epics/004-dup.md: file number 4 differs from its heading\'s Epic 3',
      'plan/epics/004-dup.md: duplicate epic 3 (also plan/epics/003-third.md)',
      `plan/epics/005-big.md: ${statSync(big).size} bytes, over the 61440-byte ceiling`,
      'plan/epics/005-big.md: Story 5.1 has no board row',
      'plan/epics/005-big.md: Story 5.1 has no **Verification:**',
      'plan/status.yaml: epic-4 has no epic file under plan/epics/',
      'plan/status.yaml: 1-9-orphan has no "### Story 1.9" heading'
    ]
    for (const reason of expected) expect(reasons).toContain(reason)
    const result = bmn(main, fixture(), 'check')
    expect(result.code).toBe(1)
    expect(result.out.trim().split('\n')).toHaveLength(findings.length)
  })

  it('checks a legacy epic for its heading, identifiers and rows only', async () => {
    const main = ownProject(fixture())
    file(main, 'plan/status.yaml', `${BOARD}  epic-53: paused # parked 2026-10-16\n  53-1-old: done\n`)
    const legacy = `<!-- bmn-plan: bmad-legacy; contracts: docs/epic-53-windows-support.md -->\n## Epic 53: Windows\n\nOld prose, ${'x'.repeat(70 * 1024)}\n\n### Story 53.1: Old\n\nNo criteria in the new shape.\n`
    file(main, 'plan/epics/053-windows.md', legacy)
    expect(readEpicFile(join(main, 'plan/epics/053-windows.md'))).toMatchObject({ legacy: true, epic: 53, legacyNote: '; contracts: docs/epic-53-windows-support.md' })
    expect((await checkPlan(await resolvePlan(main))).findings).toEqual([])
    file(main, 'plan/epics/053-windows.md', legacy.replace('### Story 53.1: Old', '### Story 53.1: Old\n\n### Story 53.1: Again'))
    expect((await checkPlan(await resolvePlan(main))).findings.map((finding) => finding.reason)).toEqual(['duplicate story 53.1'])
  })
})

describe('agents change one row of the board (Story 77.2)', () => {
  const token = (text: string, key: string): string => replaceRow(text, key, 'x', undefined)!.token

  it('changes one line and keeps every other byte, the mode and the version before', async () => {
    const home = fixture()
    const main = ownProject(fixture())
    const path = join(main, 'plan/status.yaml')
    const original = `${BOARD.replace('  2-1-second: backlog\n', '  2-1-second: backlog\r\n')}# trailing comment, no newline`
    writeFileSync(path, original); chmodSync(path, 0o640)
    const before = token(original, '2-1-second')
    const result = bmn(main, home, 'set', '2-1-second', 'in-progress', '--expect', before, '--json')
    expect(result.code).toBe(0)
    const after = readFileSync(path, 'utf8')
    expect(after).toBe(original.replace('  2-1-second: backlog\r\n', '  2-1-second: in-progress\r\n'))
    expect(statSync(path).mode & 0o777).toBe(0o640)
    expect(JSON.parse(result.out).written[0]).toMatchObject({ outcome: 'changed', token: rowToken('2-1-second', 'in-progress', '') })
    const versions = versionsDirectory(path, { HOME: home, XDG_STATE_HOME: join(home, 'state') })
    const kept = readdirSync(versions).filter((name) => name.endsWith('.yaml'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(versions, kept[0]!), 'utf8')).toBe(original)
    expect(existsSync(join(main, 'plan/.status.yaml.lock'))).toBe(false)
  })

  it('a token covers the note; a stale token, unknown row or status, long note or missing token is refused', async () => {
    const home = fixture()
    const main = ownProject(fixture())
    const path = join(main, 'plan/status.yaml')
    const stale = token(BOARD, 'epic-2')
    writeFileSync(path, BOARD.replace('epic-2: ready # go 2026-10-17', 'epic-2: ready # go 2026-10-17, owner edit'))
    const conflict = bmn(main, home, 'set', 'epic-2', 'in-progress', '--expect', stale)
    expect(conflict.code).toBe(1)
    expect(conflict.err).toContain('CONFLICT')
    expect(conflict.err).toContain('owner edit')
    expect(readFileSync(path, 'utf8')).toContain('owner edit')
    expect(bmn(main, home, 'set', 'epic-2', 'in-progress').code).toBe(2)
    expect(bmn(main, home, 'set', 'epic-9', 'done', '--expect', stale).code).toBe(2)
    expect(bmn(main, home, 'set', 'epic-2', 'finished', '--expect', stale).code).toBe(2)
    expect(bmn(main, home, 'set', 'epic-2', 'blocked', '--expect', stale, '--note', 'n'.repeat(161)).code).toBe(2)
    const fresh = token(readFileSync(path, 'utf8'), 'epic-2')
    expect(bmn(main, home, 'set', 'epic-2', 'blocked', '--expect', fresh, '--note', 'waits for the owner\'s card').code).toBe(0)
    expect(readFileSync(path, 'utf8')).toContain('  epic-2: blocked # waits for the owner\'s card\n')
  })

  it('different rows from two writers both land; the same row is a conflict', async () => {
    const main = ownProject(fixture())
    const path = join(main, 'plan/status.yaml')
    const results = await Promise.all([
      setRow(path, { key: '2-1-second', status: 'in-progress', expect: token(BOARD, '2-1-second'), environment: { HOME: fixture() } }),
      setRow(path, { key: 'epic-2', status: 'in-progress', expect: token(BOARD, 'epic-2'), environment: { HOME: fixture() } })
    ])
    expect(results.map((result) => result.outcome)).toEqual(['changed', 'changed'])
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('  2-1-second: in-progress\n')
    expect(text).toContain('  epic-2: in-progress # go 2026-10-17\n')
    const again = await setRow(path, { key: 'epic-2', status: 'review', expect: token(BOARD, 'epic-2'), environment: { HOME: fixture() } })
    expect(again).toMatchObject({ outcome: 'conflict', current: { status: 'in-progress' } })
  })

  it('an owner save between the read and the rename makes it read again: another row is kept, his row is a conflict', async () => {
    const main = ownProject(fixture())
    const path = join(main, 'plan/status.yaml')
    let saved = false
    const other = await setRow(path, {
      key: '2-1-second', status: 'review', expect: token(BOARD, '2-1-second'), environment: { HOME: fixture() },
      seam: () => { if (!saved) { saved = true; writeFileSync(path, readFileSync(path, 'utf8').replace('# go 2026-10-17', '# go 2026-10-17 (his)')) } }
    })
    expect(other).toMatchObject({ outcome: 'changed', attempts: 2 })
    expect(readFileSync(path, 'utf8')).toContain('epic-2: ready # go 2026-10-17 (his)')
    expect(readFileSync(path, 'utf8')).toContain('2-1-second: review')
    const current = readFileSync(path, 'utf8')
    let touched = false
    const same = await setRow(path, {
      key: 'epic-2', status: 'in-progress', expect: token(current, 'epic-2'), environment: { HOME: fixture() },
      seam: () => { if (!touched) { touched = true; writeFileSync(path, readFileSync(path, 'utf8').replace('epic-2: ready', 'epic-2: paused')) } }
    })
    expect(same).toMatchObject({ outcome: 'conflict', current: { status: 'paused' } })
    let endless = 0
    const busy = await setRow(path, {
      key: '2-1-second', status: 'done', expect: token(readFileSync(path, 'utf8'), '2-1-second'), environment: { HOME: fixture() },
      seam: () => writeFileSync(path, `${readFileSync(path, 'utf8')}# save ${endless++}\n`)
    })
    expect(busy).toEqual({ outcome: 'busy' })
  })

  it('keeps the last 20 versions and clears a dead writer\'s lock', async () => {
    const home = fixture()
    const main = ownProject(fixture())
    const path = join(main, 'plan/status.yaml')
    for (let index = 0; index < KEPT_VERSIONS + 3; index++) keepVersion(path, `version ${index}\n`, { HOME: home })
    const directory = versionsDirectory(path, { HOME: home })
    const kept = readdirSync(directory).filter((name) => name.endsWith('.yaml')).sort()
    expect(kept).toHaveLength(KEPT_VERSIONS)
    expect(readFileSync(join(directory, kept[0]!), 'utf8')).toBe('version 3\n')
    expect(readFileSync(join(directory, 'board-path.txt'), 'utf8')).toBe(`${path}\n`)
    writeFileSync(join(main, 'plan/.status.yaml.lock'), JSON.stringify({ pid: 2 ** 22 + 12345 }))
    const release = await lockBoard(path, { waitMs: 200 })
    await expect(lockBoard(path, { waitMs: 100 })).rejects.toMatchObject({ code: 'LOCKED' })
    release()
    expect(existsSync(join(main, 'plan/.status.yaml.lock'))).toBe(false)
  })

  it('changes a BMAD board with BMAD\'s statuses', async () => {
    const main = repo(join(fixture(), 'main'))
    const text = 'development_status:\n  epic-3: in-progress # a long BMAD comment that stays as it is\n  3-1-a: ready-for-dev\n'
    const path = file(main, '_bmad-output/implementation-artifacts/sprint-status.yaml', text)
    expect(bmn(main, fixture(), 'set', '3-1-a', 'ready', '--expect', token(text, '3-1-a')).code).toBe(2)
    expect(bmn(main, fixture(), 'set', '3-1-a', 'review', '--expect', token(text, '3-1-a')).code).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(text.replace('3-1-a: ready-for-dev', '3-1-a: review'))
  })

  it('board paths with real Git: an ignored plan is changed in the default checkout, a tracked board in both copies, his edit on another row kept', async () => {
    const root = fixture()
    const main = ownProject(root)
    const child = join(root, 'child'); git(main, 'worktree', 'add', '-qb', 'child', child)
    const path = join(main, 'plan/status.yaml')
    const status = JSON.parse(bmn(child, fixture(), 'status', '--json', '--epic', '2').out)
    writeFileSync(path, readFileSync(path, 'utf8').replace('epic-1: done # accepted', 'epic-1: done # (owner) accepted'))
    const row = status.rows.find((one: { key: string }) => one.key === '2-1-second')
    expect(bmn(child, fixture(), 'set', '2-1-second', 'in-progress', '--expect', row.token).code).toBe(0)
    expect(readFileSync(path, 'utf8')).toContain('2-1-second: in-progress')
    expect(readFileSync(path, 'utf8')).toContain('epic-1: done # (owner) accepted')
    expect(existsSync(join(child, 'plan'))).toBe(false)

    const tracked = repo(join(root, 'tracked'))
    const board = 'development_status:\n  epic-4: in-progress\n  4-1-a: in-progress\n  4-2-b: backlog\n'
    file(tracked, '_bmad-output/implementation-artifacts/sprint-status.yaml', board)
    git(tracked, 'add', '_bmad-output'); git(tracked, 'commit', '-qm', 'board')
    const run = join(root, 'run'); git(tracked, 'worktree', 'add', '-qb', 'run', run)
    const mainBoard = join(tracked, '_bmad-output/implementation-artifacts/sprint-status.yaml')
    const runBoard = join(run, '_bmad-output/implementation-artifacts/sprint-status.yaml')
    writeFileSync(mainBoard, board.replace('4-2-b: backlog', '4-2-b: backlog # owner note'))
    const plan = await resolvePlan(run)
    expect(plan).toMatchObject({ tracked: true, boardCheckout: run, boardPath: runBoard })
    expect(bmn(run, fixture(), 'set', '4-1-a', 'review', '--expect', token(board, '4-1-a')).code).toBe(0)
    expect(readFileSync(runBoard, 'utf8')).toBe(board.replace('4-1-a: in-progress', '4-1-a: review'))
    expect(readFileSync(mainBoard, 'utf8')).toBe(board.replace('4-1-a: in-progress', '4-1-a: review').replace('4-2-b: backlog', '4-2-b: backlog # owner note'))
    // A differing row in the default checkout's copy refuses both copies until its own token is given.
    const runText = readFileSync(runBoard, 'utf8')
    const refused = bmn(run, fixture(), 'set', '4-2-b', 'in-progress', '--expect', token(runText, '4-2-b'))
    expect(refused.code).toBe(1)
    expect(readFileSync(runBoard, 'utf8')).toBe(runText)
    const both = bmn(run, fixture(), 'set', '4-2-b', 'in-progress', '--expect', token(runText, '4-2-b'), '--expect-default', token(readFileSync(mainBoard, 'utf8'), '4-2-b'))
    expect(both.code).toBe(0)
    expect(readFileSync(mainBoard, 'utf8')).toContain('4-2-b: in-progress # owner note')
    expect(readFileSync(runBoard, 'utf8')).toContain('4-2-b: in-progress\n')
  })
})
