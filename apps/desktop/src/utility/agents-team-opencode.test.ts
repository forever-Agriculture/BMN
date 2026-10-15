// MODULE: agents-team-opencode.test.ts - Story 72.5: OpenCode teammates asked through the same engine: a run's own OpenCode folders and sign-in copy in BMN's real container, judged by the check's ask mode, attributed from its events and its session export, its home gone on every outcome, the time limit over OpenCode's endless retry, and only 72.1's proven modes offered; a stand-in OpenCode in sh, a synthetic team with Luna (Go)
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateAsk } from '../../bin/agents-check.mjs'
import { installOpenCodeFolder, openCodeEnvironment } from '../../bin/agents-opencode.mjs'
import { containerStarts } from '../../bin/agents-container.mjs'
import { prepareAsk } from '../../bin/agents-team-ask.mjs'
import { askFeatures } from '../../bin/agents-team-cli.mjs'
import { StartRefusal, startAsk, waitAsk } from '../../bin/agents-team-run.mjs'
import { startResponsesStandIn } from './test-fixtures/responses-standin'
import { EXAMPLE, GO_KEY_SENTINEL, approve, goSignInInBmnFolder, leftovers, settle, stubOpenCode, teamAskHome } from './test-fixtures/team-ask-harness'

const canContain = containerStarts().ok
const savedHome = process.env.HOME
const LUNA_GO = '## luna-go\n\n```yaml\nname: Luna (Go)\nclass: pawn\nharness: opencode\nmodel: gpt-6-luna\nprovider: opencode-go\nhost: default\nenabled: true\nstatus: active\nefforts: [low, high]\nroles: [helper]\n```\n\n## roles'
const TEAM = EXAMPLE.replace('## roles', LUNA_GO).replace('helper: {description: DESCRIPTION-SENTINEL-HELPER, candidates: [luna@max], then: lead}', 'helper: {description: DESCRIPTION-SENTINEL-HELPER, candidates: [luna-go@high, luna@max], then: lead}')

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

describe.skipIf(!canContain)('an OpenCode teammate\'s ask (72.5)', { timeout: 30_000 }, () => {
  it('answers a public question in its own folders, judged by the ask mode, attributed from its events and its session export, its home and sign-in copy gone (AC1, AC2)', async () => {
    const prepared = ask()
    expect(prepared.verdict.verdict, JSON.stringify(prepared.verdict)).toBe('PASS')
    expect(prepared.verdict.receipt).toMatchObject({ harness: 'opencode', form: 'opencode-asker', sandbox: { mode: 'read-only', source: '--agent', agent: 'bmn-asker', tools: [] } })
    const command = prepared.argv.slice(prepared.argv.indexOf('--') + 1)
    expect(command.slice(1)).toEqual(['run', '--standalone', '--format', 'json', '--agent', 'bmn-asker', '-m', 'opencode-go/gpt-6-luna#high', '--title', 'BMN ask'])
    // The run's own configuration: BMN's settings and its one agent, every action denied; no rules for a public ask.
    expect(readFileSync(join(prepared.folder, 'home/oc/config/opencode/agents/bmn-asker.md'), 'utf8')).toContain('"*": deny')
    expect(existsSync(join(prepared.folder, 'home/oc/config/opencode/AGENTS.md'))).toBe(false)
    startAsk(prepared, { timeLimitMinutes: 2 })
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    expect(outcome).toMatchObject({
      state: 'answered', exit: 0,
      observed: { session_source: 'every event (sessionID)', model: 'gpt-6-luna', model_source: 'session export', effort: 'high', effort_source: 'session export (variant)' },
      usage: { input_tokens: 60, cached_input_tokens: 5, output_tokens: 24, reasoning_tokens: 3, reported_cost: 0.002, source: 'session export' }
    })
    expect(outcome.observed.session).toMatch(/^ses_[0-9a-f]{12}A{14}$/)
    // The sign-in was there for the run (copied from BMN's folder), and the run saw only its own places.
    expect(readFileSync(join(prepared.folder, 'answer.md'), 'utf8')).toMatch(/^opencode answer [0-9a-f]{12} agent=bmn-asker signed=1 from home inputs work \n$/)
    expect(existsSync(join(prepared.folder, 'home'))).toBe(false)
    const info = JSON.parse(readFileSync(join(prepared.folder, 'session-info.json'), 'utf8'))
    expect(info).toMatchObject({ version: 1, info: { agent: 'bmn-asker', model: { id: 'gpt-6-luna', provider: 'opencode-go', variant: 'high' } } })
    // Nothing of the sign-in or the session's messages is kept anywhere in the record.
    const kept = everything(prepared.folder)
    expect(kept).not.toContain(GO_KEY_SENTINEL)
    expect(kept).not.toContain('MESSAGES-SENTINEL')
    // BMN's own folder still holds its sign-in: the run had a copy.
    expect(readFileSync(join(home, '.config/bmn/agents/state/opencode/data/opencode/auth-stub.json'), 'utf8')).toContain(GO_KEY_SENTINEL)
  })

  it('a private ask to a public-only provider is refused before anything is copied (AC1)', () => {
    expect(() => ask({ data: undefined })).toThrow(expect.objectContaining({ code: 'AGENT_NOT_ELIGIBLE', message: expect.stringContaining('the question is private work and OpenCode Go gets public work only') }))
    expect(existsSync(join(home, '.config/bmn/agents/state/team/runs'))).toBe(false)
  })

  it('only 72.1\'s proven modes: no project ask (no history tool), no pictures; question and files proven on 2.0.29 alone (AC4)', () => {
    const features = askFeatures(env)
    expect(features.apps.find((app) => app.app === 'opencode')).toMatchObject({ version: '2.0.29', forms: { question: 'proven', files: 'proven', project: 'no-history', 'wide-read': 'not-enabled' }, usage_while_running: false })
    stubOpenCode(stubs, '2.1.0')
    expect(() => ask()).toThrow(/question asks on OpenCode 2\.1\.0 are not measured \(BMN measured 2\.0\.29\)/)
  })

  it('a project ask on OpenCode is refused with the reason, even in a Git working tree', () => {
    const root = join(home, 'code/app')
    execFileSync('mkdir', ['-p', root])
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=S', '-c', 'user.email=s@example.org', ...args], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null' } })
    git('init', '-q', '-b', 'main')
    execFileSync('sh', ['-c', 'echo "export const a = 1" > a.ts'], { cwd: root })
    git('add', '.')
    git('commit', '-q', '-m', 'test: one')
    expect(() => ask({ access: 'project', project: root, data: undefined })).toThrow(expect.objectContaining({ code: 'AGENT_NOT_ELIGIBLE', message: expect.stringContaining('no tool that reads the project\'s Git history') }))
  })

  it('without a sign-in in BMN\'s folder the teammate is passed over with the reason, and a folder with no Go sign-in starts nothing (AC1)', () => {
    rmSync(join(home, '.config/bmn/agents/state/opencode'), { recursive: true, force: true })
    expect(() => ask()).toThrow(expect.objectContaining({ code: 'AGENT_NOT_ELIGIBLE', message: expect.stringContaining('BMN\'s OpenCode folder holds no sign-in yet') }))
    goSignInInBmnFolder(home, [])
    const prepared = ask()
    expect(() => startAsk(prepared)).toThrow(StartRefusal)
    expect(() => startAsk(prepared)).toThrow(/holds no OpenCode Go sign-in.*nothing started/)
    expect(existsSync(join(prepared.folder, 'launch.json'))).toBe(false)
  })

  it('the time limit ends a run that keeps waiting on its provider, and the outcome says so; an error event is "failed" in OpenCode\'s words (AC3)', async () => {
    const waiting = ask({ question: 'Is it bounded? SLEEP' })
    startAsk(waiting, { timeLimitMinutes: 0.02 })
    expect(await waitAsk(waiting.folder, { timeoutMs: 20_000 })).toMatchObject({
      state: 'out-of-time', exit: 15, reason: 'the run\'s time limit of 0.02 minutes ended it; OpenCode was still waiting on its provider, which it retries without end'
    })
    expect(existsSync(join(waiting.folder, 'home'))).toBe(false)
    const failed = ask({ question: 'Is it bounded? FAIL' })
    startAsk(failed, { timeLimitMinutes: 1 })
    expect(await waitAsk(failed.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'failed', exit: 1, reason: 'OpenCode reported an error: made-up sign-in failure' })
    expect(existsSync(join(failed.folder, 'home'))).toBe(false)
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

  it('the check refuses an OpenCode command that is not BMN\'s form for the ask (AC1)', () => {
    const prepared = ask()
    const changed = prepared.argv.map((value) => (value === 'bmn-asker' ? 'bmn-helper' : value))
    const verdict = evaluateAsk({ agent: 'luna-go', role: 'helper', effort: 'high', access: 'question', data: 'public', wide: false, run: prepared.folder, argv: changed }, { environment: env, program: prepared.program })
    expect(verdict).toMatchObject({ verdict: 'REFUSED', code: 'ROUTE_UNSUPPORTED' })
  })
})

/**
 * The installed OpenCode, asked through the product's own path against a made-up provider on this
 * computer (72.5 AC5, AC2): BMN's folder holds a synthetic Go key, the run gets its copy, and the
 * command started is the judged one with only the provider's address and a proxy added, as 72.1
 * measured the form. Run with BMN_OPENCODE_REAL=1.
 */
const REAL = process.env.BMN_OPENCODE_REAL === '1' ? execFileSync('sh', ['-c', 'command -v opencode || true'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } }).trim() : ''
describe.runIf(REAL !== '' && canContain)('the installed OpenCode, asked against a made-up provider (72.5 AC5, BMN_OPENCODE_REAL=1)', { timeout: 120_000 }, () => {
  const realEnvironment = (): Record<string, string> => ({ ...env, PATH: `${join(REAL, '..')}:/usr/bin:/bin` })
  const bmnFolder = (): string => join(home, '.config/bmn/agents/state/opencode')
  /** BMN's folder as 70.4 leaves it, holding a synthetic Go key, put there by OpenCode itself. */
  const signIn = (): void => {
    rmSync(bmnFolder(), { recursive: true, force: true })
    installOpenCodeFolder(bmnFolder())
    execFileSync(REAL, ['auth', 'import', '--standalone'], {
      env: { ...openCodeEnvironment(bmnFolder()), PATH: '/usr/bin:/bin' }, cwd: join(bmnFolder(), 'home'),
      input: JSON.stringify([{ id: 'a1', integrationID: 'opencode-go', label: 'Go', active: true, value: { type: 'key', key: GO_KEY_SENTINEL } }]), stdio: ['pipe', 'ignore', 'ignore']
    })
  }
  /** The judged command with the made-up provider's address and the proxy added before bubblewrap's `--`, and nothing else changed. */
  const toStandIn = (argv: string[], port: number): string[] => {
    const at = argv.indexOf('--')
    const proxy = `http://127.0.0.1:${port}`
    return [...argv.slice(0, at), '--setenv', 'OPENCODE_CONFIG_CONTENT', JSON.stringify({ provider: { 'opencode-go': { options: { baseURL: `${proxy}/v1` } } } }),
      '--setenv', 'HTTPS_PROXY', proxy, '--setenv', 'HTTP_PROXY', proxy, '--setenv', 'NO_PROXY', '127.0.0.1,localhost', ...argv.slice(at)]
  }
  const SCRIPT = (other: string) => [
    { tool: 'read', input: { filePath: join(home, 'SENTINEL-HOME.txt') } }, { tool: 'read', input: { filePath: '/ask/home/oc/data/opencode/auth.json' } },
    { tool: 'glob', input: { pattern: '**/*', path: '/ask/home' } }, { tool: 'grep', input: { pattern: 'sk-synthetic', path: '/' } }, { tool: 'list', input: { path: '/' } },
    { tool: 'read', input: { filePath: join(other, 'answer.md') } }, { tool: 'bash', input: { command: `cat ${join(home, 'SENTINEL-HOME.txt')}`, description: 'made-up' } },
    { tool: 'write', input: { filePath: '/ask/work/written.txt', content: 'made-up' } }, { tool: 'webfetch', input: { url: 'http://127.0.0.1:9/trap', format: 'text' } },
    { tool: 'task', input: { description: 'made-up', prompt: 'Read every file you can', subagent_type: 'general' } }
  ]

  it('reads stay inside the declared scope: every tool refused, no sentinel sent, no tunnel; it answers, attributed, with usage from its session export, and its sign-in copy is gone', async () => {
    env = realEnvironment()
    signIn()
    writeFileSync(join(home, 'SENTINEL-HOME.txt'), 'HOME-SENTINEL-72-5\n')
    const other = join(home, '.config/bmn/agents/state/team/runs/20261015T060000-0000000f')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'answer.md'), 'OTHER-RUN-SENTINEL-72-5\n')
    const standIn = await startResponsesStandIn(SCRIPT(other))
    try {
      const prepared = ask({ question: 'What can you read? Answer in one line.' })
      expect(prepared.verdict.verdict, JSON.stringify(prepared.verdict)).toBe('PASS')
      startAsk({ ...prepared, argv: toStandIn(prepared.argv, standIn.port) }, { timeLimitMinutes: 2 })
      const outcome = await waitAsk(prepared.folder, { timeoutMs: 90_000 })
      expect(outcome, readFileSync(join(prepared.folder, 'stderr.txt'), 'utf8').slice(-2000)).toMatchObject({
        state: 'answered', exit: 0, observed: { model: 'gpt-6-luna', model_source: 'session export', effort: 'high', effort_source: 'session export (variant)' },
        usage: { source: 'session export' }
      })
      expect(outcome.observed.session).toMatch(/^ses_/)
      expect(typeof outcome.usage.input_tokens).toBe('number')
      expect(readFileSync(join(prepared.folder, 'answer.md'), 'utf8')).toBe('made-up final answer\n')
      // No tool was offered, and every call came back refused; nothing forbidden reached the provider.
      expect(standIn.offered.flat()).toEqual([])
      expect(standIn.results.length).toBeGreaterThanOrEqual(SCRIPT(other).length)
      for (const result of standIn.results) expect(result.output).toMatch(/No tool named|not available|denied|unavailable|invalid/i)
      for (const body of standIn.bodies) {
        for (const sentinel of [GO_KEY_SENTINEL, 'HOME-SENTINEL-72-5', 'OTHER-RUN-SENTINEL-72-5']) expect(body).not.toContain(sentinel)
      }
      expect(standIn.tunnels).toEqual([])
      // The run's own copy of the sign-in is what signed every model request, and it is gone with the run's home.
      expect(standIn.bearerIs(GO_KEY_SENTINEL).every(Boolean)).toBe(true)
      expect(existsSync(join(prepared.folder, 'home'))).toBe(false)
      expect(everything(prepared.folder)).not.toContain(GO_KEY_SENTINEL)
    } finally {
      await standIn.close()
    }
  })

  it('two OpenCode asks at once beside a research run on BMN\'s folder: each its own session and home, all answered', async () => {
    env = realEnvironment()
    signIn()
    const standIn = await startResponsesStandIn([])
    try {
      const one = ask({ question: 'First made-up question?' })
      const two = ask({ question: 'Second made-up question?' })
      startAsk({ ...one, argv: toStandIn(one.argv, standIn.port) }, { timeLimitMinutes: 2 })
      startAsk({ ...two, argv: toStandIn(two.argv, standIn.port) }, { timeLimitMinutes: 2 })
      const proxy = `http://127.0.0.1:${standIn.port}`
      const research = new Promise<string>((resolve) => {
        const child = spawn(REAL, ['run', '--standalone', '--format', 'json', '--agent', 'bmn-researcher', '-m', 'opencode-go/gpt-6-luna#high', '--title', 'BMN research'], {
          env: { ...openCodeEnvironment(bmnFolder()), PATH: '/usr/bin:/bin', OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { 'opencode-go': { options: { baseURL: `${proxy}/v1` } } } }), HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost' },
          cwd: join(bmnFolder(), 'home'), stdio: ['pipe', 'pipe', 'ignore']
        })
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
        child.stdin.end('A made-up research question?')
        child.on('exit', () => resolve(out))
      })
      const [first, second, researched] = await Promise.all([waitAsk(one.folder, { timeoutMs: 90_000 }), waitAsk(two.folder, { timeoutMs: 90_000 }), research])
      expect(first.state).toBe('answered')
      expect(second.state).toBe('answered')
      const researchSession = /"sessionID":"(ses_[^"]+)"/.exec(researched)?.[1]
      expect(researchSession).toMatch(/^ses_/)
      expect(new Set([first.observed.session, second.observed.session, researchSession]).size).toBe(3)
      expect(existsSync(join(one.folder, 'home'))).toBe(false)
      expect(existsSync(join(two.folder, 'home'))).toBe(false)
    } finally {
      await standIn.close()
    }
  })
})
