// MODULE: agents-team-opencode.test.ts - Stories 72.5, 72.9: OpenCode teammates asked through the same engine, in BMN's own OpenCode folder with its sign-in and the agents given inline: every action denied for a public question or a private one with no project, BMN's read-only agent for a private project ask; judged by the check's ask mode, attributed from its events and each session's export with its sub-agents counted once, the time limit over OpenCode's endless retry; a stand-in OpenCode in sh run in BMN's real systemd scope, a synthetic team with Luna (Go)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateAsk } from '../../bin/agents-check.mjs'
import { prepareAsk } from '../../bin/agents-team-ask.mjs'
import { startAsk, waitAsk } from '../../bin/agents-team-run.mjs'
import { EXAMPLE, GO_KEY_SENTINEL, SCOPES, approve, goSignInInBmnFolder, leftovers, settle, stubOpenCode, teamAskHome } from './test-fixtures/team-ask-harness'

const savedHome = process.env.HOME
const LUNA_GO = '## luna-go\n\n```yaml\nname: Luna (Go)\nclass: pawn\nharness: opencode\nmodel: gpt-6-luna\nprovider: opencode-go\nhost: default\nenabled: true\nstatus: active\nefforts: [low, high]\nroles: [helper]\n```\n\n## roles'
const TEAM = EXAMPLE.replace('## roles', LUNA_GO).replace('helper: {description: DESCRIPTION-SENTINEL-HELPER, candidates: [luna@max], then: lead}', 'helper: {description: DESCRIPTION-SENTINEL-HELPER, candidates: [luna-go@high, luna@max], then: lead}')
/** The same team with OpenCode Go allowed private work, so a project may be asked about. */
const PRIVATE_TEAM = TEAM.replace('opencode-go: {name: OpenCode Go, hosts: [], private_work: public_only}', 'opencode-go: {name: OpenCode Go, hosts: [], private_work: allowed}')
/** The owner's rules: OpenCode is given only the part he marked public, whatever its provider (Epic 60). */
const RULES = '# Global rules\n\n<!-- bmn:public -->\nRULES-SENTINEL: answer plainly and cite files.\n<!-- /bmn:public -->\n\nPRIVATE-RULES-SENTINEL: for the apps BMN checks.\n'

let home: string
let stubs: string
let env: Record<string, string>
type Asked = Parameters<typeof prepareAsk>[0]
/** A public question to Luna (Go) unless the test says otherwise; `data: undefined` makes it private. */
const ask = (request: Omit<Partial<Asked>, 'data'> & { data?: string | undefined } = {}) =>
  prepareAsk({ role: 'helper', agent: 'luna-go', effort: 'high', data: 'public', question: 'Is the loop bounded?', ...request } as Asked, { environment: env, cwd: home, home })
/** Every file of a run's record, read whole, to search for what must not be kept. */
const everything = (folder: string): string => {
  const parts: string[] = []
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (statSync(path).size < 8 * 1024 * 1024) parts.push(readFileSync(path, 'latin1'))
    }
  }
  walk(folder)
  return parts.join('\n')
}
/** The command after `env -i` and its variables, and the variables by name. */
const split = (argv: string[]) => {
  const variables = new Map<string, string>()
  let at = 2
  for (; at < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[at]!); at += 1) variables.set(argv[at]!.slice(0, argv[at]!.indexOf('=')), argv[at]!.slice(argv[at]!.indexOf('=') + 1))
  return { variables, command: argv.slice(at) }
}
/** A small synthetic project with one commit. */
const projectRoot = (): string => {
  const root = join(home, 'code/app')
  if (existsSync(join(root, '.git'))) return root
  mkdirSync(root, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=S', '-c', 'user.email=s@example.org', ...args], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null' } })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'test: one')
  return root
}

beforeEach(() => {
  ({ home, stubs, env } = teamAskHome('bmn-team-opencode-'))
  stubOpenCode(stubs)
  goSignInInBmnFolder(home)
  approve(home, TEAM)
})

afterEach(async () => {
  await settle(() => leftovers(home).length === 0, 5000)
  process.env.HOME = savedHome
  if (process.env.BMN_TEST_KEEP_HOME === undefined) rmSync(home, { recursive: true, force: true })
})

describe('an OpenCode teammate\'s ask, before it starts (72.5, 72.9)', () => {
  it('a public question goes to the agent with every action denied, in BMN\'s own OpenCode folder, given inline; no rules, no git, nothing of the asker\'s environment (72.9 AC1)', () => {
    const prepared = ask()
    expect(prepared.verdict.verdict, JSON.stringify(prepared.verdict)).toBe('PASS')
    expect(prepared.verdict.receipt).toMatchObject({ harness: 'opencode', form: 'opencode-asker', reads: { scope: 'text' }, cwd: join(prepared.folder, 'work') })
    const { variables, command } = split(prepared.argv)
    expect(command.slice(1)).toEqual(['run', '--standalone', '--format', 'json', '--agent', 'bmn-ask-asker', '-m', 'opencode-go/gpt-6-luna#high', '--title', 'BMN ask'])
    const folder = join(home, '.config/bmn/agents/state/opencode')
    expect(variables.get('HOME')).toBe(join(folder, 'home'))
    expect(variables.get('XDG_DATA_HOME')).toBe(join(folder, 'data'))
    const agents = JSON.parse(variables.get('OPENCODE_CONFIG_CONTENT')!).agent
    expect(Object.keys(agents)).toEqual(['bmn-ask-asker'])
    expect(agents['bmn-ask-asker'].permission).toEqual({ '*': 'deny' })
    expect(variables.get('PATH')).not.toContain(join(prepared.folder, 'bin'))
    expect(existsSync(join(prepared.folder, 'inputs/rules.md'))).toBe(false)
    expect(existsSync(join(prepared.folder, 'bin/git'))).toBe(false)
    expect(prepared.argv.join(' ')).not.toContain('SECRET_LOOKING_VARIABLE')
  })

  it('a private project ask goes to BMN\'s read-only agent in the project, with the owner\'s rules in it and BMN\'s git first on its PATH (72.9 AC1)', () => {
    approve(home, PRIVATE_TEAM)
    mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
    writeFileSync(join(home, '.config/bmn/agents/global-rules.md'), RULES)
    const root = projectRoot()
    const prepared = ask({ data: undefined, project: root })
    expect(prepared.verdict.verdict, JSON.stringify(prepared.verdict)).toBe('PASS')
    expect(prepared.verdict.receipt).toMatchObject({ form: 'opencode-reader', reads: { scope: 'computer' }, cwd: root, project: root })
    const { variables, command } = split(prepared.argv)
    expect(command).toEqual(expect.arrayContaining(['--agent', 'bmn-ask-reader']))
    expect(variables.get('PATH')).toMatch(new RegExp(`^${prepared.folder}/bin:`, 'u'))
    const agents = JSON.parse(variables.get('OPENCODE_CONFIG_CONTENT')!).agent
    expect(Object.keys(agents).sort()).toEqual(['bmn-ask-reader', 'bmn-reader'])
    expect(agents['bmn-ask-reader'].prompt).toContain('RULES-SENTINEL')
    expect(agents['bmn-ask-reader'].prompt).not.toContain('PRIVATE-RULES-SENTINEL')
    // OpenCode matches a command's whole text, and splits chains but not redirections: every redirection is denied (72.9 AC1).
    expect(agents['bmn-ask-reader'].permission).toMatchObject({ '*': 'deny', read: 'allow', edit: 'deny', webfetch: 'deny', bash: { '*': 'deny', 'git log*': 'allow', '*>*': 'deny' }, task: { '*': 'deny', 'bmn-reader': 'allow' } })
    expect(agents['bmn-reader'].permission).toMatchObject({ task: 'deny' })
    expect(readFileSync(join(prepared.folder, 'inputs/rules.md'), 'utf8')).toContain('RULES-SENTINEL')
    // A private ask with no project gets the rules, and every action denied.
    const plain = ask({ data: undefined })
    expect(plain.verdict.receipt).toMatchObject({ form: 'opencode-asker', cwd: join(plain.folder, 'work') })
    expect(JSON.parse(split(plain.argv).variables.get('OPENCODE_CONFIG_CONTENT')!).agent['bmn-ask-asker'].prompt).toContain('RULES-SENTINEL')
  })

  it('a private ask to a public-only provider is refused before anything is written (AC1)', () => {
    expect(() => ask({ data: undefined })).toThrow(expect.objectContaining({ code: 'AGENT_NOT_ELIGIBLE', message: expect.stringContaining('the question is private work and OpenCode Go gets public work only') }))
    expect(existsSync(join(home, '.config/bmn/agents/state/team/runs'))).toBe(false)
  })

  it('a newer OpenCode is asked as it is: no version gate (72.9 AC4)', () => {
    stubOpenCode(stubs, '2.1.0')
    const prepared = ask()
    expect(prepared.verdict.verdict).toBe('PASS')
    expect(prepared.verdict.receipt).toMatchObject({ harness_version: { version: '2.1.0', form_checked_on: { version: '2.0.29' } } })
  })

  it('without a sign-in in BMN\'s folder the teammate is passed over with the reason (AC1)', () => {
    rmSync(join(home, '.config/bmn/agents/state/opencode'), { recursive: true, force: true })
    expect(() => ask()).toThrow(expect.objectContaining({ code: 'AGENT_NOT_ELIGIBLE', message: expect.stringContaining('BMN\'s OpenCode folder holds no sign-in yet') }))
  })

  it('the check refuses an OpenCode command that is not BMN\'s form for the ask: another agent, or other agents given inline (AC1)', () => {
    const prepared = ask()
    const judge = (argv: string[]) => evaluateAsk({ agent: 'luna-go', role: 'helper', effort: 'high', data: 'public', run: prepared.folder, argv, cwd: prepared.cwd }, { environment: env, program: prepared.program })
    expect(judge(prepared.argv.map((value) => (value === 'bmn-ask-asker' ? 'bmn-helper' : value)))).toMatchObject({ verdict: 'REFUSED' })
    const wider = prepared.argv.map((value) => (value.startsWith('OPENCODE_CONFIG_CONTENT=') ? `OPENCODE_CONFIG_CONTENT=${JSON.stringify({ agent: { 'bmn-ask-asker': { permission: { '*': 'allow' } } } })}` : value))
    expect(judge(wider)).toMatchObject({ verdict: 'REFUSED' })
  })
})

describe.skipIf(!SCOPES)('an OpenCode teammate\'s ask, run (72.5, 72.9)', { timeout: 30_000 }, () => {
  it('answers a public question in the run\'s own empty folder, attributed from its events and its session export; nothing of the sign-in or the session\'s messages is kept (AC1, AC2)', async () => {
    const prepared = ask()
    startAsk(prepared, { timeLimitMinutes: 2 })
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    expect(outcome).toMatchObject({
      state: 'answered', exit: 0, subagents: [],
      observed: { session_source: 'every event (sessionID)', model: 'gpt-6-luna', model_source: 'session export', effort: 'high', effort_source: 'session export (variant)' },
      usage: { input_tokens: 60, cached_input_tokens: 5, output_tokens: 24, reasoning_tokens: 3, reported_cost: 0.002, source: 'session export', complete: true }
    })
    expect(outcome.observed.session).toMatch(/^ses_[0-9a-f]{12}A{14}$/u)
    // The sign-in was BMN's folder's own, and the run worked in its own empty folder.
    expect(readFileSync(join(prepared.folder, 'answer.md'), 'utf8')).toBe(`opencode answer ${outcome.observed.session!.slice(4, 16)} agent=bmn-ask-asker signed=1 rules=no in ${join(prepared.folder, 'work')}\n`)
    const info = JSON.parse(readFileSync(join(prepared.folder, 'session-info.json'), 'utf8'))
    expect(info).toMatchObject({ version: 1, info: { agent: 'bmn-ask-asker', parent: null, model: { id: 'gpt-6-luna', provider: 'opencode-go', variant: 'high' } }, subagents: [] })
    const kept = everything(prepared.folder)
    expect(kept).not.toContain(GO_KEY_SENTINEL)
    expect(kept).not.toContain('MESSAGES-SENTINEL')
    // BMN's own folder keeps its sign-in.
    expect(readFileSync(join(home, '.config/bmn/agents/state/opencode/data/opencode/opencode.db'), 'utf8')).toContain(GO_KEY_SENTINEL)
  })

  it('a private project ask works in the project with the owner\'s rules; a sub-agent is named and its own export counted once; one whose export names no parent leaves the usage incomplete (72.9 AC2, AC5)', async () => {
    approve(home, PRIVATE_TEAM)
    mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
    writeFileSync(join(home, '.config/bmn/agents/global-rules.md'), RULES)
    const root = projectRoot()
    const prepared = ask({ data: undefined, project: root, question: 'Is the loop bounded? SUBAGENT' })
    startAsk(prepared, { timeLimitMinutes: 2 })
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    expect(outcome).toMatchObject({
      state: 'answered', exit: 0,
      usage: { input_tokens: 90, cached_input_tokens: 7, output_tokens: 28, reasoning_tokens: 4, source: 'session exports', complete: true },
      subagents: [{ session: expect.stringMatching(/^ses_[0-9a-f]{12}C{14}$/u), parent: outcome.observed.session, name: 'read the tests', role: 'bmn-reader', kind: 'OpenCode sub-agent', model: 'gpt-6-luna', effort: 'low',
        usage: { input_tokens: 30, cached_input_tokens: 2, output_tokens: 4, reasoning_tokens: 1, reported_cost: 0.001 } }],
      project: { root, start: { clean: true }, end: { clean: true } }
    })
    expect(outcome.usage.reported_cost).toBeCloseTo(0.003, 10)
    expect(readFileSync(join(prepared.folder, 'answer.md'), 'utf8')).toContain(`agent=bmn-ask-reader signed=1 rules=yes in ${root}`)
    // Two events naming one child: one sub-agent, counted once (full review).
    const twice = ask({ data: undefined, project: root, question: 'Is the loop bounded? TWICE' })
    startAsk(twice, { timeLimitMinutes: 2 })
    const counted = await waitAsk(twice.folder, { timeoutMs: 20_000 })
    expect(counted).toMatchObject({ state: 'answered', usage: { input_tokens: 90, output_tokens: 28, complete: true }, subagents: [{ status: 'completed', usage: { input_tokens: 30 } }] })
    expect(counted.subagents).toHaveLength(1)
    expect(counted.usage.reported_cost).toBeCloseTo(0.003, 10)
    // A child whose export cannot be read stands, its usage incomplete; one whose export names no parent is a session BMN cannot identify (exit 17).
    const unread = ask({ data: undefined, project: root, question: 'Is the loop bounded? NOEXPORT' })
    startAsk(unread, { timeLimitMinutes: 2 })
    expect(await waitAsk(unread.folder, { timeoutMs: 20_000 })).toMatchObject({
      state: 'answered', exit: 0, usage: { input_tokens: 60, complete: false, incomplete_reason: 'a sub-agent\'s session could not be read' },
      subagents: [{ kind: 'OpenCode sub-agent', parent: null, usage: 'incomplete', usage_reason: expect.any(String) }]
    })
    const orphan = ask({ data: undefined, project: root, question: 'Is the loop bounded? ORPHAN' })
    startAsk(orphan, { timeLimitMinutes: 2 })
    expect(await waitAsk(orphan.folder, { timeoutMs: 20_000 })).toMatchObject({
      state: 'not-attributed', exit: 17, reason: expect.stringContaining('the run named a sub-agent session whose export names no parent'),
      subagents: [{ kind: 'OpenCode sub-agent', parent: null, usage: 'incomplete', usage_reason: 'its session export does not name the teammate as its parent' }]
    })
  })

  it('the time limit ends a run that keeps waiting on its provider, and the outcome says so; an error event is "failed" in OpenCode\'s words (AC3)', async () => {
    const waiting = ask({ question: 'Is it bounded? SLEEP' })
    startAsk(waiting, { timeLimitMinutes: 0.02 })
    expect(await waitAsk(waiting.folder, { timeoutMs: 20_000 })).toMatchObject({
      state: 'out-of-time', exit: 15, reason: 'the run\'s time limit of 0.02 minutes ended it; OpenCode was still waiting on its provider, which it retries without end'
    })
    const failed = ask({ question: 'Is it bounded? FAIL' })
    startAsk(failed, { timeLimitMinutes: 1 })
    expect(await waitAsk(failed.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'failed', exit: 1, reason: 'OpenCode reported an error: made-up sign-in failure' })
  })

  it('a session that ran another model is "answer not attributed"; two asks at once keep their own sessions', async () => {
    const other = ask({ question: 'Is it bounded? OTHERMODEL' })
    startAsk(other, { timeLimitMinutes: 1 })
    expect(await waitAsk(other.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'not-attributed', exit: 17, reason: 'the app ran gpt-6-other, not gpt-6-luna' })
    const one = ask({ question: 'First?' })
    const two = ask({ question: 'Second?' })
    startAsk(one, { timeLimitMinutes: 1 })
    startAsk(two, { timeLimitMinutes: 1 })
    const [first, second] = await Promise.all([waitAsk(one.folder, { timeoutMs: 20_000 }), waitAsk(two.folder, { timeoutMs: 20_000 })])
    const hash = (text: string): string => execFileSync('md5sum', { input: text, encoding: 'utf8' }).slice(0, 12)
    expect(first.observed.session).toBe(`ses_${hash('First?')}AAAAAAAAAAAAAA`)
    expect(second.observed.session).toBe(`ses_${hash('Second?')}AAAAAAAAAAAAAA`)
  })
})
