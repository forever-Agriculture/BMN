// MODULE: plan-allowances.test.ts - Stories 110.4, 110.5, 110.8: an epic's allowances file: its check, the go's hash, the recorded version, `bmn plan allow`, the size limit
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareVersions, fieldsFrom, parseAllowances } from '../../bin/plan-allowances.mjs'
import { approvalText } from '../../bin/plan-cli.mjs'
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const BMN = resolve(__dirname, '../../bin/bmn')
const TEMPLATES = resolve(__dirname, '../../../../skills/plan/templates')
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
const SOURCE = "card 2026-11-05T09:30Z: owner answered 'Go' to 'Record the go for Epic 7?'"
const WORDS = "his words 2026-11-05T10:00Z: 'give it more'"
const FILE = `schema: 1
epic: 7
limits:              # any name; the ledger counts each one
  repair_rounds: {limit: 4, ceiling: 8, per: boundary}
  full_reviews:  {limit: 1, ceiling: 2, per: boundary}
  rechecks:      {limit: 2, ceiling: 4, per: boundary}
  consults:      {limit: 3, ceiling: 6, per: epic}
  test_hours:    {limit: 4, ceiling: 8, per: epic, unit: hours}
  money_usd:     {limit: 0, per: epic, unit: usd}   # no ceiling means the lead cannot raise it
may:
  - one read-only run of test-runtime-report.yml on TEST
stays_out:
  - production
  - customer data
deferrable: [{what: 7.1, when: its stop rule}]
messages: [{person: Denys, destination: PR comments, purpose: asks for a review}]
prepared:
  - {kind: account, target: gh, check: gh api, checked: 2026-11-05}
`
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })) })

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim()
}
function file(root: string, path: string, text: string): string {
  const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, text); return target
}
function bmn(cwd: string, home: string, args: string[]): { code: number; out: string; err: string; json: ReturnType<typeof JSON.parse> } {
  const result = spawnSync(process.execPath, [BMN, 'plan', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, 'state'), LC_ALL: 'C', ...IDENTITY } })
  let json: ReturnType<typeof JSON.parse> = null
  try { json = JSON.parse(result.stdout) } catch { /* text output */ }
  return { code: result.status ?? -1, out: result.stdout, err: result.stderr, json }
}
const NEEDS = '- **Extra repair rounds:** 1 per boundary.\n- **Deferrable:** none.\n- **Money cap:** none; no paid launches.\n- **Named actions for an Away card:** none.\n- **Prepared:** none, because a fixture.\n'
const POINTER = 'What this epic may use is in `plan/allowances/007.yaml`.\n'
function epicText(needs = NEEDS, decisions = 'None.\n', stories = 1): string {
  const list = Array.from({ length: stories }, (_, index) => `### Story 7.${index + 1}: Fixture\n\nAs the owner.\n\n**Owner:** none.\n\n**Acceptance criteria:**\n1. **Given** it, **then** it works.\n\n**Verification:** a test.\n\n`).join('')
  return `# Epic 7: Fixture\n\n**Suggested lead:** Opus — fixture.\n\n## Outcome\n\nIt works.\n\n## Why\n\nThe owner, 2026-10-26: "make it".\n\n## Boundary and dependencies\n\nNone.\n\n## Truth impact\n\nnone: a fixture.\n\n## Run needs\n\n${needs}\n## Challenges\n\n- **Scale:** small.\n- **Origin:** a fixture.\n- **Verified:** a fixture.\n- **Exists:** nothing.\n- **People:** nobody.\n\n## Decisions\n\n${decisions}\n## Stories\n\n${list}`
}
function board(stories = 1, extra = ''): string {
  const rows = Array.from({ length: stories }, (_, index) => `  7-${index + 1}-fixture: backlog\n`).join('')
  return `format: bmn-plan\nschema_version: 1\nrules_from_run_needs: 90\nrules_from_prepared: 103\nrules_from_prepared_items: 104\nrules_from_challenges: 107\n${extra}# The order of unfinished epics; every ready epic is here.\nqueue: []\ndevelopment_status:\n  epic-7: backlog # Suggested lead: Opus\n${rows}`
}
function project(options: { allowances?: string | null; epic?: string; board?: string } = {}): { main: string; plan: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'bmn-plan-allowances-')); roots.push(root)
  const main = join(root, 'main')
  mkdirSync(main, { recursive: true }); git(main, 'init', '-qb', 'main')
  file(main, '.gitignore', '/plan/\n'); git(main, 'add', '.gitignore'); git(main, 'commit', '-qm', 'chore: ignore plan')
  file(main, 'plan/VISION.md', readFileSync(join(TEMPLATES, 'VISION.md'), 'utf8'))
  file(main, 'plan/PLAN.md', readFileSync(join(TEMPLATES, 'PLAN.md'), 'utf8'))
  file(main, 'plan/status.yaml', options.board ?? board())
  file(main, 'plan/epics/007-fixture.md', options.epic ?? epicText(options.allowances === null ? NEEDS : POINTER))
  if (options.allowances !== null) file(main, 'plan/allowances/007.yaml', options.allowances ?? FILE)
  const plan = join(main, 'plan')
  git(plan, 'init', '-qb', 'main'); git(plan, 'add', '-A'); git(plan, 'commit', '-qm', 'docs: plan epic 7')
  const home = join(root, 'home'); mkdirSync(home)
  return { main, plan, home }
}
function rowToken(main: string, home: string): string {
  return bmn(main, home, ['status', '--json', '--epic', '7']).json.rows.find((row: { key: string }) => row.key === 'epic-7').token
}
function approved(main: string, home: string): string {
  return `sha256:${bmn(main, home, ['status', '--json', '--epic', '7']).json.approval_texts[0].sha256}`
}
function go(main: string, home: string): ReturnType<typeof bmn> {
  const result = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', rowToken(main, home), '--json'])
  expect(result.code, result.err + result.out).toBe(0)
  return result
}
function goFor(allowances?: string): { main: string; plan: string; home: string; commit: string } {
  const made = project({ allowances })
  return { ...made, commit: go(made.main, made.home).json.commit }
}
function read(main: string, home: string, ...args: string[]): ReturnType<typeof JSON.parse> {
  const result = bmn(main, home, ['allowances', '7', '--json', ...args])
  expect(result.code, result.err + result.out).toBe(0)
  return result.json
}
function allow(main: string, home: string, change: string | string[], extra: string[] = ['--reason', 'the suite needs one more'], token = read(main, home).token): ReturnType<typeof bmn> {
  return bmn(main, home, ['allow', '7', ...[change].flat(), '--expect', token, ...extra, '--json'])
}
function state(plan: string): { head: string; file: string; status: string } {
  return { head: git(plan, 'rev-parse', 'HEAD'), file: readFileSync(join(plan, 'allowances/007.yaml'), 'utf8'), status: git(plan, 'status', '--porcelain') }
}
function checkFindings(main: string, home: string): Array<{ where: string; reason: string }> {
  return bmn(main, home, ['check', '--json']).json.findings
}

describe('the file is checked with its line (110.4 AC1)', () => {
  const cases: Array<[string, string, RegExp, number]> = [
    ['a bad schema', FILE.replace('schema: 1', 'schema: 2'), /schema 2 is not one BMN reads/u, 1],
    ['a ceiling under its limit', FILE.replace('{limit: 4, ceiling: 8, per: boundary}', '{limit: 9, ceiling: 8, per: boundary}'), /ceiling 8 is under its limit 9/u, 4],
    ['a missing unit', FILE.replace('per: epic, unit: hours}', 'per: epic}'), /limit test_hours has no unit: hours/u, 8],
    ['a decimal count', FILE.replace('{limit: 3, ceiling: 6, per: epic}', '{limit: 2.5, ceiling: 6, per: epic}'), /2\.5 is not a whole count/u, 7],
    ['a Prepared need without a check', FILE.replace('check: gh api, ', ''), /has no check/u, 18],
    ['a Prepared need without a date', FILE.replace(', checked: 2026-11-05', ''), /has no date/u, 18],
    ['a Prepared date that is none', FILE.replace('checked: 2026-11-05', 'checked: 2026-13-45'), /is not a date/u, 18],
    ['an epic number that disagrees', FILE.replace('epic: 7', 'epic: 8'), /epic 8 disagrees with the file's number 7/u, 2],
    ['an unknown top-level field', `${FILE}spare: 1\n`, /unknown field spare/u, 19],
    ['an unknown limit field', FILE.replace('{limit: 1, ceiling: 2, per: boundary}', '{limit: 1, ceiling: 2, per: boundary, burst: 3}'), /unknown field burst/u, 5],
    ['an unknown item field', FILE.replace('{what: 7.1,', '{what: 7.1, why: no,'), /deferrable: unknown field why/u, 15]
  ]
  it.each(cases)('reports %s', (_name, text, reason, line) => {
    const { main, home } = project({ allowances: text })
    const findings = checkFindings(main, home)
    expect(findings).toContainEqual({ where: `plan/allowances/007.yaml:${line}`, reason: expect.stringMatching(reason) })
    expect(bmn(main, home, ['check']).code).toBe(1)
  })
  it('passes D5\'s shape, comments and all, with Run needs one line pointing to it', () => {
    const { main, home } = project()
    expect(checkFindings(main, home)).toEqual([])
    const parsed = parseAllowances(FILE, 7)
    expect(parsed.problems).toEqual([])
    expect(parsed.data.limits.money_usd).toEqual({ limit: 0, per: 'epic', unit: 'usd' })
    expect(parsed.data.limits.rechecks).toEqual({ limit: 2, ceiling: 4, per: 'boundary', unit: 'count' })
    expect(parsed.data.may).toEqual(['one read-only run of test-runtime-report.yml on TEST'])
  })
  it('keeps a value with a # inside and an apostrophe in plain text', () => {
    const { data, problems } = parseAllowances("schema: 1\nepic: 7\nmay:\n  - the owner's run#4 of the report # a comment\n  - \"a, quoted: value # kept\"\n", 7)
    expect(problems).toEqual([])
    expect(data.may).toEqual(["the owner's run#4 of the report", 'a, quoted: value # kept'])
  })
  it('reports a Run needs without its Prepared line only for an epic with no file', () => {
    const rules = board().replace('rules_from_prepared: 103', 'rules_from_prepared: 7').replace('rules_from_prepared_items: 104', 'rules_from_prepared_items: 7')
    const none = project({ allowances: null, epic: epicText(POINTER), board: rules })
    expect(checkFindings(none.main, none.home).map((one) => one.reason).join('\n')).toMatch(/no \*\*Prepared:\*\* line/u)
    const { main, home } = project({ epic: epicText(POINTER), board: rules })
    expect(checkFindings(main, home)).toEqual([])
  })
})

describe('the go approves the file (110.4 AC2-AC3)', () => {
  it('hashes Run needs, Decisions and the file\'s text, in status and in the go', () => {
    const { main, plan, home } = project()
    const epic = readFileSync(join(plan, 'epics/007-fixture.md'), 'utf8')
    const sha = approved(main, home)
    expect(sha).toBe(`sha256:${approvalText(epic, FILE)}`)
    expect(sha).not.toBe(`sha256:${approvalText(epic)}`)
    expect(bmn(main, home, ['status', '--json', '--epic', '7']).json.approval_texts[0].allowances_file).toBe('allowances/007.yaml')
    const result = go(main, home)
    expect(result.json.approved_text).toBe(sha)
    expect(git(plan, 'log', '-1', '--format=%B')).toContain(`Approved-Text: ${sha}`)
  })
  it('hashes an epic with no file exactly as before', () => {
    const { main, plan, home } = project({ allowances: null })
    const epic = readFileSync(join(plan, 'epics/007-fixture.md'), 'utf8')
    expect(approved(main, home)).toBe(`sha256:${approvalText(epic)}`)
    expect(approvalText(epic, null)).toBe(approvalText(epic))
    expect(read(main, home)).toMatchObject({ state: 'none' })
    const result = go(main, home)
    expect(read(main, home, '--at', result.json.commit)).toMatchObject({ state: 'none', go_commit: result.json.commit })
  })
  it('commits a file he approved that is not committed yet, with the epic', () => {
    const { main, plan, home } = project({ allowances: null })
    file(plan, 'allowances/007.yaml', FILE)
    file(plan, 'epics/007-fixture.md', epicText(POINTER))
    const result = go(main, home)
    expect(result.json.epic_file_committed).toBe(true)
    expect(git(plan, 'show', `${result.json.commit}:allowances/007.yaml`)).toBe(FILE.trim())
    expect(git(plan, 'status', '--porcelain')).toBe('')
    expect(read(main, home)).toMatchObject({ state: 'recorded', go_commit: result.json.commit })
  })
  it('refuses a go on a changed file or one that does not read, writing nothing', () => {
    const { main, plan, home } = project()
    const token = rowToken(main, home)
    const before = git(plan, 'rev-parse', 'HEAD')
    // What he approved is in neither the commit nor the working file.
    file(plan, 'allowances/007.yaml', FILE.replace('limit: 2,', 'limit: 3,'))
    const sha = approved(main, home)
    file(plan, 'allowances/007.yaml', FILE.replace('limit: 2,', 'limit: 4,'))
    const changed = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', sha, '--expect', token, '--json'])
    expect(changed.json.error.code).toBe('CHANGED_TERMS')
    file(plan, 'allowances/007.yaml', FILE.replace('schema: 1', 'schema: 2'))
    const bad = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', approved(main, home), '--expect', token, '--json'])
    expect(bad.json.error.code).toBe('BAD_ALLOWANCES')
    expect(git(plan, 'rev-parse', 'HEAD')).toBe(before)
  })
  it('a go on a commit names that commit\'s file too', () => {
    const { main, plan, home } = project()
    const planned = git(plan, 'rev-parse', 'HEAD')
    const result = bmn(main, home, ['go', '7', '--source', SOURCE, '--approved', planned, '--expect', rowToken(main, home), '--json'])
    expect(result.code, result.err + result.out).toBe(0)
    expect(result.json.approved_text).toBe(`sha256:${approvalText(readFileSync(join(plan, 'epics/007-fixture.md'), 'utf8'), FILE)}`)
  })
  it('a removed file leaves the go\'s commit, which then returns the epic to its Run needs (D13)', () => {
    const { main, plan, home } = project()
    rmSync(join(plan, 'allowances/007.yaml'))
    file(plan, 'epics/007-fixture.md', epicText())
    const result = go(main, home)
    expect(git(plan, 'ls-tree', '--name-only', result.json.commit, 'allowances/')).toBe('')
    expect(read(main, home)).toMatchObject({ state: 'none', go_commit: result.json.commit })
  })
})

describe('bmn plan allowances (110.4 AC4)', () => {
  it('gives the fields parse_needs gives plus limits, may and stays_out, at the go and now', () => {
    const { main, home, commit } = goFor()
    const shown = read(main, home, '--at', commit)
    expect(shown.state).toBe('recorded')
    expect(shown.go_commit).toBe(commit)
    expect(shown.at_go.fields).toMatchObject({
      rounds: 4, money_cap: 0, named_actions: 'one read-only run of test-runtime-report.yml on TEST', deferrable: ['7.1: its stop rule'],
      messages: [{ people: ['Denys'], destination: 'PR comments', purpose: 'asks for a review' }],
      prepared: [{ kind: 'account', target: 'gh', check: 'gh api', checked: '2026-11-05', none_because: null }],
      may: ['one read-only run of test-runtime-report.yml on TEST'], stays_out: ['production', 'customer data']
    })
    expect(Object.keys(shown.at_go.fields.limits)).toContain('full_reviews')
    expect(shown.current).toMatchObject({ commit, source: 'go' })
    allow(main, home, 'limits.rechecks.limit=3')
    const later = read(main, home, '--at', commit)
    expect(later.at_go.fields.limits.rechecks.limit).toBe(2)
    expect(later.current.fields.limits.rechecks.limit).toBe(3)
    expect(later.current.source).toBe('allow')
  })
  it('names 4 rounds and no cap for a file that gives neither (D13)', () => {
    const { main, home } = goFor('schema: 1\nepic: 7\n')
    expect(read(main, home).current.fields).toMatchObject({ rounds: 4, money_cap: null, deferrable: [], messages: [], prepared: [], may: [], stays_out: [] })
  })
  it('a planned file is a draft: it reads, and grants nothing', () => {
    const { main, home } = project()
    expect(read(main, home)).toMatchObject({ state: 'draft', draft: { rounds: 4 } })
  })
  it('refuses a commit that is no go, and an unknown one', () => {
    const { main, plan, home } = goFor()
    expect(read(main, home, '--at', git(plan, 'rev-parse', 'HEAD~1'))).toMatchObject({ state: 'not_recorded' })
    expect(bmn(main, home, ['allowances', '7', '--at', 'deadbeef', '--json']).json.error.code).toBe('NO_COMMIT')
  })
})

describe('rules_from_allowances and rules_from_size opt a plan in (110.4 AC5, 110.8)', () => {
  it('reports an epic from that number on without a file; a plan without the line reports nothing', () => {
    const opted = project({ allowances: null, board: board(1, 'rules_from_allowances: 7\n') })
    expect(checkFindings(opted.main, opted.home)).toContainEqual({ where: 'plan/allowances', reason: expect.stringMatching(/epic 7 has no allowances file/u) })
    const later = project({ allowances: null, board: board(1, 'rules_from_allowances: 8\n') })
    expect(checkFindings(later.main, later.home)).toEqual([])
    const without = project({ allowances: null })
    expect(checkFindings(without.main, without.home)).toEqual([])
  })
  const big = { epic: epicText(NEEDS, 'None.\n', 11), allowances: null }
  it('reports an unfinished epic over 10 stories with its counts', () => {
    const { main, home } = project({ ...big, board: board(11, 'rules_from_size: 7\n') })
    expect(checkFindings(main, home)).toContainEqual({ where: 'plan/epics/007-fixture.md', reason: expect.stringMatching(/11 stories and 11 criteria/u) })
  })
  it('reports over 50 criteria though the stories fit', () => {
    const many = Array.from({ length: 51 }, (_, index) => `${index + 1}. **Given** it, **then** it works.\n`).join('')
    const epic = epicText(NEEDS).replace('1. **Given** it, **then** it works.\n', many)
    const { main, home } = project({ epic, allowances: null, board: board(1, 'rules_from_size: 7\n') })
    expect(checkFindings(main, home)).toContainEqual({ where: 'plan/epics/007-fixture.md', reason: expect.stringMatching(/1 stories and 51 criteria/u) })
  })
  it('lets his quoted word for that size stand, and only his', () => {
    const quoted = project({ epic: epicText(NEEDS, '- **D1 (owner, 2026-11-05, card):** "Keep all 11 stories in one epic."\n', 11), allowances: null, board: board(11, 'rules_from_size: 7\n') })
    expect(checkFindings(quoted.main, quoted.home)).toEqual([])
    const lead = project({ epic: epicText(NEEDS, '- **D1 (lead, 2026-11-05):** the stories belong together.\n', 11), allowances: null, board: board(11, 'rules_from_size: 7\n') })
    expect(checkFindings(lead.main, lead.home).map((one) => one.reason).join('\n')).toMatch(/11 stories/u)
  })
  it('a finished epic, an earlier number or a plan without the line report nothing', () => {
    const done = project({ ...big, board: board(11, 'rules_from_size: 7\n').replace('epic-7: backlog # Suggested lead: Opus', 'epic-7: done').replaceAll(/7-(\d+)-fixture: backlog/gu, '7-$1-fixture: done') })
    expect(checkFindings(done.main, done.home)).toEqual([])
    const earlier = project({ ...big, board: board(11, 'rules_from_size: 8\n') })
    expect(checkFindings(earlier.main, earlier.home)).toEqual([])
    const without = project({ ...big, board: board(11) })
    expect(checkFindings(without.main, without.home)).toEqual([])
  })
})

describe('bmn plan allow: a raise under the ceiling (110.5 AC1)', () => {
  it('one commit changes only that value, naming who, why and before and after', () => {
    const { main, plan, home } = goFor()
    const before = state(plan)
    const result = allow(main, home, 'limits.rechecks.limit=3', ['--reason', 'the suite needs one more'])
    expect(result.code, result.err + result.out).toBe(0)
    expect(result.json.changes).toEqual([{ field: 'limits.rechecks.limit', before: '2', after: '3' }])
    expect(git(plan, 'rev-parse', 'HEAD')).toBe(result.json.commit)
    expect(git(plan, 'rev-parse', 'HEAD~1')).toBe(before.head)
    expect(git(plan, 'show', '--format=', '--name-only', 'HEAD')).toBe('allowances/007.yaml')
    const diff = git(plan, 'show', '--format=', '--unified=0', 'HEAD').split('\n').filter((line) => /^[-+] /u.test(line))
    expect(diff).toEqual(['-  rechecks:      {limit: 2, ceiling: 4, per: boundary}', '+  rechecks:      {limit: 3, ceiling: 4, per: boundary}'])
    const message = git(plan, 'log', '-1', '--format=%B')
    expect(message).toContain('Allow-Epic: 7\n')
    expect(message).toContain('Allow-Change: limits.rechecks.limit 2 -> 3\n')
    expect(message).toContain('Allow-Who: the lead (session unknown)\n')
    expect(message).toContain('Allow-Reason: the suite needs one more')
    expect(git(plan, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(plan, 'allowances/007.yaml'), 'utf8')).toContain('rechecks:      {limit: 3, ceiling: 4, per: boundary}')
    expect(read(main, home).changes[0]).toMatchObject({ change: ['limits.rechecks.limit 2 -> 3'], reason: 'the suite needs one more' })
  })
  it('keeps a comment on the changed line', () => {
    const { main, plan, home } = goFor()
    expect(allow(main, home, 'limits.money_usd.limit=5', ['--reason', 'r', '--source', WORDS]).code).toBe(0)
    expect(readFileSync(join(plan, 'allowances/007.yaml'), 'utf8')).toContain('money_usd:     {limit: 5, per: epic, unit: usd}   # no ceiling means the lead cannot raise it')
  })
  it('the token binds the last recorded version and the go: two calls with one token, one wins', async () => {
    const { main, home, plan } = goFor()
    const token = read(main, home).token
    const start = (limit: string): Promise<number> => new Promise((done) => {
      spawn(process.execPath, [BMN, 'plan', 'allow', '7', `limits.rechecks.limit=${limit}`, '--reason', 'r', '--expect', token, '--json'], {
        cwd: main, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, 'state'), LC_ALL: 'C', ...IDENTITY }
      }).on('close', (code) => done(code ?? -1))
    })
    const codes = await Promise.all([start('3'), start('4')])
    expect(codes.filter((code) => code === 0)).toHaveLength(1)
    expect(git(plan, 'log', '--format=%s', '--grep=Allow-Epic').split('\n')).toHaveLength(1)
    const stale = bmn(main, home, ['allow', '7', 'limits.consults.limit=4', '--reason', 'r', '--expect', token, '--json'])
    expect(stale.json.error.code).toBe('CONFLICT')
  })
  it('a new go resets the chain and changes the token', () => {
    const { main, plan, home } = goFor()
    const first = read(main, home)
    allow(main, home, 'limits.rechecks.limit=3')
    file(plan, 'epics/007-fixture.md', epicText(POINTER, 'New terms.\n'))
    go(main, home)
    const second = read(main, home)
    expect(second.go_commit).not.toBe(first.go_commit)
    expect(second.changes).toEqual([])
    expect(second.current.fields.limits.rechecks.limit).toBe(3)
    expect(second.token).not.toBe(first.token)
  })
})

describe('D7\'s list, each field alone (110.5 AC2-AC3)', () => {
  const allowed: Array<[string, string | string[]]> = [
    ['a raise at its ceiling', 'limits.rechecks.limit=4'],
    ['a lower limit', 'limits.rechecks.limit=1'],
    ['a lower limit with no ceiling', 'limits.money_usd.limit=0.0'],
    ['an addition to stays_out', 'stays_out+=the billing database'],
    ['a Prepared date', 'prepared.gh.checked=2026-11-06']
  ]
  it.each(allowed)('with no source: %s', (_name, change) => {
    const { main, home, plan } = goFor()
    if (_name === 'a lower limit with no ceiling') {
      // 0 to 0.0 changes no value: lowering is shown on a limit above zero, raised first on his words.
      expect(allow(main, home, 'limits.money_usd.limit=5', ['--reason', 'r', '--source', WORDS]).code).toBe(0)
      const lowered = allow(main, home, 'limits.money_usd.limit=2')
      expect(lowered.code, lowered.out).toBe(0)
      return
    }
    const result = allow(main, home, change)
    expect(result.code, result.err + result.out).toBe(0)
    expect(git(plan, 'log', '-1', '--format=%B')).not.toContain('Approval-Source')
  })
  const needsWords: Array<[string, string | string[], RegExp]> = [
    ['a limit over its ceiling', 'limits.rechecks.limit=5', /needs his words/u],
    ['a raise with no ceiling', 'limits.money_usd.limit=1', /no ceiling/u],
    ['a new limit', 'limits.pages={limit: 1, per: epic}', /a new limit, pages/u],
    ['a changed ceiling', 'limits.rechecks.ceiling=9', /changed ceiling on rechecks/u],
    ['a changed per', 'limits.rechecks.per=epic', /changed per on rechecks/u],
    ['a changed unit', 'limits.rechecks.unit=hours', /changed unit on rechecks/u],
    ['removing a limit', 'limits.rechecks=', /removing limit rechecks/u],
    ['an addition to may', 'may+=deploy', /a change to may/u],
    ['a removal from may', 'may-=one read-only run of test-runtime-report.yml on TEST', /a change to may/u],
    ['a removal from stays_out', 'stays_out-=production', /removal from stays_out \(production\)/u],
    ['a message', 'messages+={person: Ann, destination: chat, purpose: asks}', /a change to messages/u],
    ['a deferral', 'deferrable+={what: 7.2, when: late}', /a change to deferrable/u],
    ['another Prepared change', 'prepared.gh.check=gh auth status', /Prepared change other than its checked date/u],
    ['a new Prepared need', 'prepared+={kind: service, target: x, check: y, checked: 2026-11-05}', /Prepared change/u]
  ]
  it.each(needsWords)('%s needs his words, naming what is missing, and changes nothing', (_name, change, reason) => {
    const { main, home, plan } = goFor()
    const before = state(plan)
    const refused = allow(main, home, change)
    expect(refused.code).toBe(1)
    expect(refused.json.error.code).toBe('NEEDS_HIS_WORDS')
    expect(refused.json.error.message).toMatch(reason)
    expect(state(plan)).toEqual(before)
  })
  it.each(needsWords)('with his words: %s is recorded', (_name, change) => {
    const { main, home, plan } = goFor()
    // Going over a ceiling takes the ceiling with it; the file stays valid.
    const changes = change === 'limits.rechecks.limit=5' ? ['limits.rechecks.limit=5', 'limits.rechecks.ceiling=5'] : change
    const result = allow(main, home, changes, ['--reason', 'he said so', '--source', WORDS])
    expect(result.code, result.err + result.out).toBe(0)
    const message = git(plan, 'log', '-1', '--format=%B')
    expect(message).toContain(`Approval-Source: ${WORDS}`)
    expect(message).toContain('Allow-Who: the owner')
    expect(message).toMatch(/^Allow-Change: /mu)
    expect(read(main, home).current.source).toBe('allow')
  })
  it('one commit names each field\'s before and after', () => {
    const { main, home, plan } = goFor()
    const result = allow(main, home, ['limits.rechecks.ceiling=9', 'limits.rechecks.limit=9', 'stays_out+=the billing database'], ['--reason', 'he said so', '--source', WORDS])
    expect(result.code, result.out).toBe(0)
    const message = git(plan, 'log', '-1', '--format=%B')
    expect(message).toContain('Allow-Change: limits.rechecks.limit 2 -> 9')
    expect(message).toContain('Allow-Change: limits.rechecks.ceiling 4 -> 9')
    expect(message).toContain('Allow-Change: stays_out ')
    expect(git(plan, 'rev-parse', 'HEAD~1')).not.toBe(git(plan, 'rev-parse', 'HEAD'))
  })
  it('a source that is not his words, or a decision record, is refused', () => {
    const { main, home } = goFor()
    expect(allow(main, home, 'may+=deploy', ['--reason', 'r', '--source', 'because I think so']).json.error.code).toBe('NO_OWNER_WORDS')
    expect(allow(main, home, 'may+=deploy', ['--reason', 'r', '--source', "bmn:01234567-89ab-cdef-0123-456789abcdef/dev-auto:run:d1 2026-10-26T09:30Z 'go'"]).json.error.code).toBe('NO_OWNER_WORDS')
  })
  it('a reason is required, and a change that would break the file or change nothing is refused', () => {
    const { main, home } = goFor()
    expect(bmn(main, home, ['allow', '7', 'limits.rechecks.limit=3', '--expect', read(main, home).token, '--json']).json.error.code).toBe('NO_REASON')
    expect(allow(main, home, 'limits.rechecks.limit=2').json.error.code).toBe('NOTHING_CHANGES')
    expect(allow(main, home, 'limits.rechecks.limit=lots').json.error.code).toBe('BAD_ALLOWANCES')
    expect(allow(main, home, 'schema=2').json.error.code).toBe('BAD_CHANGE')
    expect(allow(main, home, 'limits.none.limit=2').json.error.code).toBe('NO_SUCH_FIELD')
  })
  it('compares against the recorded version, whatever the words said', () => {
    const before = parseAllowances(FILE, 7).data
    expect(compareVersions(before, before).changes).toEqual([])
    const after = parseAllowances(FILE.replace('{limit: 2, ceiling: 4, per: boundary}', '{limit: 4, ceiling: 4, per: boundary}'), 7).data
    expect(compareVersions(before, after)).toMatchObject({ words: [], frozen: [], changes: [{ field: 'limits.rechecks.limit', before: '2', after: '4' }] })
  })
})

describe('a limit with uses keeps its meaning (110.5 AC4)', () => {
  function withUses(f: { main: string; home: string; plan: string }, data: object): void {
    const folder = join(f.home, 'state/dev-auto/budgets')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, '0123456789abcdef-epic-7.json'), JSON.stringify({ plan_root: f.plan, epic: 7, gos: [], jobs: {}, rounds: {}, ...data }))
  }
  const rechecks = { uses: { u1: { answer: 'TAKEN', limit: 'rechecks', boundary: '7.1', amount: 1 } } }
  it.each(['limits.rechecks=', 'limits.rechecks.per=epic', 'limits.rechecks.unit=hours'])('%s is refused, with or without his words', (change) => {
    const f = goFor()
    withUses(f, rechecks)
    const before = state(f.plan)
    expect(allow(f.main, f.home, change).json.error.code).toBe('USED')
    expect(allow(f.main, f.home, change, ['--reason', 'r', '--source', WORDS]).json.error.code).toBe('USED')
    expect(state(f.plan)).toEqual(before)
  })
  it('a limit still changes, and another limit is free', () => {
    const f = goFor()
    withUses(f, rechecks)
    expect(allow(f.main, f.home, 'limits.rechecks.limit=3').code).toBe(0)
    expect(allow(f.main, f.home, 'limits.consults.per=boundary', ['--reason', 'r', '--source', WORDS]).code).toBe(0)
  })
  it('a repair round is a use of repair_rounds, a job of money_usd', () => {
    const f = goFor()
    withUses(f, { rounds: { r1: { answer: 'TAKEN', boundary: '7.1' } }, jobs: { j1: { answer: 'STARTED', state: 'settled', max: 1 } } })
    expect(allow(f.main, f.home, 'limits.repair_rounds=', ['--reason', 'r', '--source', WORDS]).json.error.code).toBe('USED')
    expect(allow(f.main, f.home, 'limits.money_usd=', ['--reason', 'r', '--source', WORDS]).json.error.code).toBe('USED')
  })
  it('another plan\'s ledger counts nothing; a ledger of this epic that cannot be read freezes', () => {
    const f = goFor()
    withUses(f, { ...rechecks, plan_root: join(f.home, 'elsewhere') })
    expect(allow(f.main, f.home, 'limits.rechecks.per=epic', ['--reason', 'r', '--source', WORDS]).code).toBe(0)
    const g = goFor()
    const folder = join(g.home, 'state/dev-auto/budgets')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'fedcba9876543210-epic-7.json'), '{not json')
    expect(allow(g.main, g.home, 'limits.rechecks.per=epic', ['--reason', 'r', '--source', WORDS]).json.error.code).toBe('USED')
  })
})

describe('a hand edit counts for nothing (110.5 AC5)', () => {
  const edited = FILE.replace('limit: 2,', 'limit: 4,')
  it('uncommitted: the reader keeps the recorded version, check reports it, allow refuses until it matches', () => {
    const { main, plan, home } = goFor()
    file(plan, 'allowances/007.yaml', edited)
    const shown = read(main, home)
    expect(shown.current.fields.limits.rechecks.limit).toBe(2)
    expect(shown.hand_edit).toMatch(/differs from the last recorded version/u)
    expect(checkFindings(main, home).map((one) => one.reason).join('\n')).toMatch(/differs from the last recorded version/u)
    expect(allow(main, home, 'limits.rechecks.limit=3').json.error.code).toBe('HAND_EDIT')
    file(plan, 'allowances/007.yaml', FILE)
    expect(allow(main, home, 'limits.rechecks.limit=3').code).toBe(0)
  })
  it('committed by hand: the same, and a hand commit with made-up trailers is not a recorded change', () => {
    const { main, plan, home } = goFor()
    const go_ = read(main, home).go_commit
    file(plan, 'allowances/007.yaml', edited)
    git(plan, 'add', '-A')
    git(plan, 'commit', '-qm', `plan: raise\n\nAllow-Epic: 7\nAllow-Go: ${go_}\nAllow-Before: sha256:${'0'.repeat(64)}\nAllow-After: sha256:${'1'.repeat(64)}\n`)
    const shown = read(main, home)
    expect(shown.current.commit).toBe(go_)
    expect(shown.current.fields.limits.rechecks.limit).toBe(2)
    expect(shown.hand_edit).toMatch(/differs from the last recorded version/u)
    expect(allow(main, home, 'limits.rechecks.limit=3').json.error.code).toBe('HAND_EDIT')
    file(plan, 'allowances/007.yaml', FILE)
    git(plan, 'add', '-A'); git(plan, 'commit', '-qm', 'plan: back')
    expect(allow(main, home, 'limits.rechecks.limit=3').code).toBe(0)
  })
  it('a deleted file keeps the last recorded version, and check reports it (D13)', () => {
    const { main, plan, home } = goFor()
    rmSync(join(plan, 'allowances/007.yaml'))
    const shown = read(main, home)
    expect(shown).toMatchObject({ state: 'recorded', hand_edit: expect.stringMatching(/deleted on disk/u) })
    expect(shown.current.fields.limits.rechecks.limit).toBe(2)
    expect(checkFindings(main, home).map((one) => one.reason).join('\n')).toMatch(/deleted on disk/u)
    git(plan, 'add', '-A'); git(plan, 'commit', '-qm', 'plan: delete')
    expect(checkFindings(main, home).map((one) => one.reason).join('\n')).toMatch(/deleted on disk/u)
  })
  it('a file the go\'s commit does not hold grants nothing, and check says so', () => {
    const { main, plan, home } = project({ allowances: null })
    go(main, home)
    file(plan, 'allowances/007.yaml', FILE)
    expect(read(main, home)).toMatchObject({ state: 'none', hand_edit: expect.stringMatching(/grants nothing/u) })
    expect(checkFindings(main, home).map((one) => one.reason).join('\n')).toMatch(/grants nothing/u)
    const refused = bmn(main, home, ['allow', '7', 'limits.rechecks.limit=3', '--reason', 'r', '--expect', 'x', '--json'])
    expect(refused.json.error.code).toBe('NOT_RECORDED')
  })
})

describe('a withdrawn go grants nothing (110.5 AC7)', () => {
  it('the reader says so and allow refuses, on the board now and once committed', () => {
    const { main, plan, home } = goFor()
    const token = read(main, home).token
    const row = rowToken(main, home)
    expect(bmn(main, home, ['set', 'epic-7', 'backlog', '--expect', row, '--note', 'taken back']).code).toBe(0)
    expect(read(main, home)).toMatchObject({ state: 'withdrawn' })
    expect(bmn(main, home, ['allow', '7', 'limits.rechecks.limit=3', '--reason', 'r', '--expect', token, '--json']).json.error.code).toBe('WITHDRAWN')
    git(plan, 'add', '-A'); git(plan, 'commit', '-qm', 'plan: back')
    expect(read(main, home)).toMatchObject({ state: 'withdrawn' })
  })
})

describe('the plan skill gives a new epic the file (110.6 AC5, 110.8 AC3)', () => {
  const root = join(import.meta.dirname, '../../../..')
  const read = (path: string) => readFileSync(join(root, path), 'utf8')
  it('its template reads clean once the epic is named, with 4 repair rounds', () => {
    const { data, problems } = parseAllowances(read('skills/plan/templates/allowances.yaml').replace('<N>', '7'), 7)
    expect(problems).toEqual([])
    const fields = fieldsFrom(data)
    expect(fields.rounds).toBe(4)
    expect(Object.keys(fields.limits)).toEqual(['repair_rounds', 'full_reviews', 'rechecks', 'consults', 'qa_passes', 'test_hours', 'money_usd'])
    expect(fields.limits.money_usd!.ceiling ?? null).toBeNull()
  })
  it('the epic template, the skill and readiness say so', () => {
    expect(read('skills/plan/templates/epic.md')).toContain('plan/allowances/NNN.yaml')
    expect(read('skills/plan/SKILL.md')).toMatch(/plan\/allowances\/NNN\.yaml[^\n]*4 repair rounds[^\n]*never one more slice[^\n]*split before he sees it/u)
    const readiness = read('skills/plan/methods/readiness.md')
    expect(readiness).toMatch(/Walk each limit/u)
    expect(readiness).toMatch(/split the epic before he sees it/u)
  })
})
