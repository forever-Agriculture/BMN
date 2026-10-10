// MODULE: agents-guard.test.ts - Epic 60.8: the prompt guard's decision over synthetic teams, process tables, settings and workspaces
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GUARD_APPS, decide, decideWithin, guardStanding, guardState, parseLaunch, stopAnswer } from '../../bin/agents-guard.mjs'
import { visibilityPath } from '../../bin/agents-check.mjs'
import { buildGeneration, currentPointerPath, generationPath, readValidRoster } from '../../bin/agents-state.mjs'
import { approveRoster } from '../main/agents-approval'

const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const PID = 7001
const savedHome = process.env.HOME

let home: string
let proc: string
let workspace: string

function edit(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`fixture edit expected one "${from}"`)
  return text.replace(from, to)
}

const MOONSHOT = 'moonshot: {name: Moonshot AI, hosts: [api.moonshot.ai], private_work: public_only}\n'
const KIMI = '## kimi\n\n```yaml\nname: Kimi\nclass: pawn\nharness: claude\nmodel: kimi-k3\nprovider: moonshot\nhost: api.moonshot.ai\nenabled: true\nstatus: active\nefforts: [low]\nroles: [helper]\n```\n\n## roles'

/** The example team plus Kimi: Claude Code pointed at Moonshot AI, a provider that may see public work only. */
function team(extra: (text: string) => string = (text) => text): string {
  let text = edit(EXAMPLE, 'zai: {name: Z.ai', `${MOONSHOT}zai: {name: Z.ai`)
  text = edit(text, '## roles', KIMI)
  return extra(text)
}

function approve(text: string): void {
  mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
  writeFileSync(join(home, '.config/bmn/agents/roster.md'), text)
  let generation: number | null
  try {
    generation = JSON.parse(readFileSync(join(home, '.config/bmn/agents/state/current'), 'utf8')).generation
  } catch {
    generation = null
  }
  approveRoster({ generation, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
}

/** One agent process as Linux would report it: its command line, environment, folder and start time. */
function session(argv: string[], options: { env?: Record<string, string>; cwd?: string; pid?: number; start?: string } = {}): number {
  const pid = options.pid ?? PID
  const folder = join(proc, String(pid))
  mkdirSync(folder, { recursive: true })
  const env = { HOME: home, PATH: '/usr/bin:/bin', ...options.env }
  writeFileSync(join(folder, 'cmdline'), `${argv.join('\0')}\0`)
  writeFileSync(join(folder, 'environ'), `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\0')}\0`)
  writeFileSync(join(folder, 'stat'), `${pid} (${argv[0]}) S ${[1, pid, pid, 34817, pid, ...Array(13).fill(0), options.start ?? '777'].join(' ')}\n`)
  rmSync(join(folder, 'cwd'), { force: true })
  symlinkSync(options.cwd ?? workspace, join(folder, 'cwd'))
  return pid
}

const MOONSHOT_ENV = { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' }
const prompt = (agent: string, pid: number, event: Record<string, unknown> = {}) => decide({ agent, pid, procRoot: proc, event: { cwd: workspace, ...event } })
const exception = (folder: string) => (text: string) => edit(text, 'zai-synthetic: {provider: zai, folder: /synthetic/EXCEPTION-SENTINEL-FOLDER}',
  `zai-synthetic: {provider: zai, folder: /synthetic/EXCEPTION-SENTINEL-FOLDER}\nkimi-here: {provider: moonshot, folder: ${folder}}`)

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-guard-')))
  process.env.HOME = home
  proc = join(home, 'proc')
  workspace = join(home, 'code/app')
  mkdirSync(join(workspace, '.git'), { recursive: true })
  mkdirSync(join(workspace, 'src'), { recursive: true })
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe('whether the guard applies at all (60.8 AC2)', () => {
  it('is inactive on an installation that never approved a team, whatever the session looks like', () => {
    expect(guardState()).toEqual({ state: 'inactive' })
    expect(prompt('claude', 0)).toMatchObject({ outcome: 'pass', cause: 'inactive' })
    expect(prompt('claude', session(['claude'], { env: MOONSHOT_ENV }))).toMatchObject({ outcome: 'pass', cause: 'inactive' })
    expect(guardStanding('claude')).toBe('prompt guard: inactive (no team has been approved, so no prompt is checked)')
  })

  it('stops every prompt once something was approved and the approved state is damaged, missing or from an earlier layout', () => {
    approve(team())
    const pid = session(['claude'])
    const state = join(home, '.config/bmn/agents/state')
    const pointer = readFileSync(join(state, 'current'), 'utf8')

    writeFileSync(join(state, 'current'), '{ not json')
    expect(prompt('claude', pid)).toMatchObject({ outcome: 'stop', cause: 'state', allow: false })
    expect(prompt('claude', pid).line).toBe('BMN stopped this prompt: The approved team on disk is damaged. Open BMN Preferences › Team and approve the team.')

    rmSync(join(state, 'current'))
    expect(prompt('claude', pid).line).toBe('BMN stopped this prompt: The approved team is missing. Open BMN Preferences › Team and approve the team.')
    expect(guardStanding('claude')).toMatch(/^prompt guard: stopping every prompt\. The approved team is missing\./)

    writeFileSync(join(state, 'current'), pointer)
    const file = join(state, 'generations/000001.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('"hash": "', '"hash": "0'))
    expect(prompt('claude', pid)).toMatchObject({ outcome: 'stop', cause: 'state' })
  })

  it('stops every prompt while the approved team is still the one from the earlier layout', () => {
    const earlier = buildGeneration({ number: 1, parent: null, rosterFileHash: 'f'.repeat(64),
      data: { schema_version: 1, agents: [], roles: [], data_labels: { default: 'private', paths: [] }, harness_routes: [] } as never })
    mkdirSync(join(home, '.config/bmn/agents/state/generations'), { recursive: true })
    writeFileSync(generationPath(1), JSON.stringify(earlier))
    writeFileSync(currentPointerPath(), JSON.stringify({ generation: 1, hash: earlier.hash }))

    expect(guardState()).toEqual({ state: 'broken', fix: 'The approved team is from an earlier BMN. Open BMN Preferences › Team and approve it again.' })
    expect(prompt('claude', session(['claude']))).toMatchObject({ outcome: 'stop', cause: 'state', allow: false })
  })

  it('stops a prompt whose agent process cannot be read, naming the fix', () => {
    approve(team())
    expect(prompt('claude', 0)).toMatchObject({ outcome: 'stop', cause: 'process', allow: false })
    expect(prompt('codex', 4242).line).toBe('BMN stopped this prompt: it cannot read how this Codex session was started. Start Codex again in a BMN session.')
  })
})

describe('a provider that may or may not see private work (60.8 AC2, AC3)', () => {
  beforeEach(() => approve(team()))

  it('lets Claude Code and Codex on their own servers through, on a fresh start, a resume and a continued session', () => {
    for (const argv of [['claude'], ['claude', '--continue'], ['claude', '--resume', '01a0b657-21a8-7f00-addd-b73646828f5b'], ['claude', '--model', 'opus', 'fix the tests']]) {
      expect(prompt('claude', session(argv)), argv.join(' ')).toMatchObject({ outcome: 'pass', cause: 'allowed', provider: { id: 'anthropic', name: 'Anthropic' } })
    }
    for (const argv of [['codex'], ['codex', 'resume', '--last'], ['node', '/synthetic/lib/codex.js', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=xhigh', '-c', 'tui.theme="dark"']]) {
      expect(prompt('codex', session(argv)), argv.join(' ')).toMatchObject({ outcome: 'pass', cause: 'allowed', provider: { id: 'openai', name: 'OpenAI' } })
    }
  })

  it('stops a Moonshot AI lead in a private workspace with one line and offers to allow that workspace', () => {
    const verdict = prompt('claude', session(['claude', '--resume'], { env: MOONSHOT_ENV }), { cwd: join(workspace, 'src') })

    expect(verdict).toMatchObject({
      outcome: 'stop', cause: 'public-only', allow: true, workspace, folder: join(workspace, 'src'), host: 'api.moonshot.ai',
      provider: { id: 'moonshot', name: 'Moonshot AI' }, name: 'Kimi', pid: PID, start: '777'
    })
    expect(verdict.line).toBe("Moonshot AI can't see private work in ~/code/app. Allow it in BMN.")
    expect(JSON.parse(stopAnswer('claude', verdict.line!)!)).toEqual({ decision: 'block', reason: verdict.line })
  })

  it('stops it in a public GitHub repository too: a folder can hold files that were never pushed', () => {
    mkdirSync(dirname(visibilityPath(workspace)), { recursive: true })
    writeFileSync(visibilityPath(workspace), JSON.stringify({ version: 1, workspace, checked_at: new Date().toISOString(), origin: 'github.com/synthetic-owner/synthetic-repo',
      repository_id: 4242, visibility: 'public', default_branch: 'main', commit: 'a'.repeat(40) }))

    expect(prompt('claude', session(['claude'], { env: MOONSHOT_ENV }))).toMatchObject({ outcome: 'stop', cause: 'public-only', allow: true })
  })

  it('reads the destination from the settings files as well as the environment', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: MOONSHOT_ENV }))
    expect(prompt('claude', session(['claude']))).toMatchObject({ outcome: 'stop', cause: 'public-only', provider: { id: 'moonshot' } })

    rmSync(join(home, '.claude/settings.json'))
    const settings = join(home, 'kimi-settings.json')
    writeFileSync(settings, JSON.stringify({ env: MOONSHOT_ENV }))
    expect(prompt('claude', session(['claude', '--settings', settings]))).toMatchObject({ outcome: 'stop', cause: 'public-only', provider: { id: 'moonshot' } })
    expect(prompt('claude', session(['claude', `--settings=${JSON.stringify({ env: MOONSHOT_ENV })}`]))).toMatchObject({ outcome: 'stop', provider: { id: 'moonshot' } })
  })
})

describe('an allowed workspace (60.8 AC2, AC6)', () => {
  it('passes for exactly that workspace, from any folder inside it', () => {
    approve(team(exception(workspace)))
    const pid = session(['claude'], { env: MOONSHOT_ENV })

    expect(prompt('claude', pid)).toMatchObject({ outcome: 'pass', cause: 'exception', exception: 'kimi-here' })
    expect(prompt('claude', pid, { cwd: join(workspace, 'src') })).toMatchObject({ outcome: 'pass', cause: 'exception' })
  })

  it('does not pass for a sibling workspace, nor for a repository nested inside the allowed one', () => {
    const sibling = join(home, 'code/other')
    const nested = join(workspace, 'vendor/inner')
    mkdirSync(join(sibling, '.git'), { recursive: true })
    mkdirSync(join(nested, '.git'), { recursive: true })
    approve(team(exception(workspace)))
    const pid = session(['claude'], { env: MOONSHOT_ENV })

    expect(prompt('claude', pid, { cwd: sibling })).toMatchObject({ outcome: 'stop', cause: 'public-only', workspace: sibling })
    expect(prompt('claude', pid, { cwd: nested })).toMatchObject({ outcome: 'stop', cause: 'public-only', workspace: nested, allow: true })
  })

  it('names the workspace by its real path when the session reached it through a link', () => {
    const link = join(home, 'app-link')
    symlinkSync(workspace, link)
    approve(team(exception(workspace)))

    expect(prompt('claude', session(['claude'], { env: MOONSHOT_ENV, cwd: link }), { cwd: link })).toMatchObject({ outcome: 'pass', workspace })
  })

  it('treats a folder outside Git as its own workspace', () => {
    const loose = join(home, 'notes')
    mkdirSync(loose)
    approve(team())

    expect(prompt('claude', session(['claude'], { env: MOONSHOT_ENV, cwd: loose }), { cwd: loose })).toMatchObject({ outcome: 'stop', workspace: loose })
  })
})

describe('a destination BMN cannot tell (60.8 AC1, AC3)', () => {
  beforeEach(() => approve(team()))

  it.each([
    ['an address no provider in the team lists', ['claude'], { ANTHROPIC_BASE_URL: 'https://unlisted.example/v1' }, /no provider in the team lists the address unlisted\.example/],
    ['an address that is not a web address', ['claude'], { ANTHROPIC_BASE_URL: 'not a url' }, /ANTHROPIC_BASE_URL is not an http\(s\) URL/],
    ['a cloud switch', ['claude'], { CLAUDE_CODE_USE_BEDROCK: '1' }, /CLAUDE_CODE_USE_BEDROCK is set/],
    ['--settings without a value', ['claude', '--settings'], {}, /--settings has no value/],
    ['--settings naming a file that is not there', ['claude', '--settings', '/synthetic/missing.json'], {}, /--settings cannot be read/]
  ])('stops a Claude Code session with %s, and offers no Allow', (_label, argv, env, reason) => {
    const verdict = prompt('claude', session(argv, { env }))

    expect(verdict).toMatchObject({ outcome: 'stop', cause: 'unknown', allow: false })
    expect(verdict.line).toMatch(/^BMN stopped this prompt: it cannot tell where this Claude Code session sends work \(/)
    expect(verdict.line).toMatch(reason)
  })

  it.each([
    ['a profile that is not in its settings', ['codex', '--profile', 'kimi'], /profile kimi is not in config\.toml/],
    ['a provider without an address BMN can read', ['codex', '-c', 'model_provider=moonshot'], /provider moonshot has no base_url BMN can read/],
    ['the local-model switch', ['codex', '--oss'], /--oss sends work to a local model server BMN does not read/],
    ['a profile override BMN cannot resolve', ['codex', '-c', 'profiles.kimi.model_provider="moonshot"'], /profiles\.kimi\.model_provider/],
    ['an override that is not key=value', ['codex', '-c', 'model_provider'], /-c model_provider is not key=value/]
  ])('stops a Codex session started with %s', (_label, argv, reason) => {
    const verdict = prompt('codex', session(argv))

    expect(verdict).toMatchObject({ outcome: 'stop', cause: 'unknown', allow: false })
    expect(verdict.line).toMatch(reason)
  })

  it('resolves a Codex provider override whose address a provider lists, and stops it as public-only', () => {
    const verdict = prompt('codex', session(['codex', '-c', 'model_provider="moonshot"', '-c', 'model_providers.moonshot.base_url="https://api.moonshot.ai/v1"']))

    expect(verdict).toMatchObject({ outcome: 'stop', cause: 'public-only', allow: true, provider: { id: 'moonshot' }, host: 'api.moonshot.ai' })
  })

  it('stops a resumed Codex session that was saved with another provider than the settings now name', () => {
    const id = '01a0b657-21a8-7f00-addd-b73646828f5b'
    const record = join(home, `.codex/sessions/2026/10/10/rollout-2026-10-10T10-00-00-${id}.jsonl`)
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: workspace, model_provider: 'moonshot', cli_version: '0.162.0' } })}\n`)
    const pid = session(['codex', 'resume', id])

    expect(prompt('codex', pid, { session_id: id }).line).toMatch(/this session was saved with the provider moonshot and the settings now name openai/)
    expect(prompt('codex', pid, { transcript_path: record })).toMatchObject({ outcome: 'stop', cause: 'unknown' })
    expect(prompt('codex', pid, { session_id: '11111111-2222-3333-4444-555555555555' })).toMatchObject({ outcome: 'pass' })
  })

  it('stops when the folder the app started in and the folder it works in name different destinations', () => {
    const other = join(home, 'code/other')
    mkdirSync(join(other, '.claude'), { recursive: true })
    writeFileSync(join(other, '.claude/settings.json'), JSON.stringify({ env: MOONSHOT_ENV }))

    expect(prompt('claude', session(['claude'], { cwd: other })).line).toMatch(/name different destinations/)
  })

  it('stops when nothing is recorded about where the app sends work', () => {
    approve(team((text) => edit(text, 'codex: {provider: openai, basis: observed-default}\n', '')))

    expect(prompt('codex', session(['codex'])).line).toBe('BMN stopped this prompt: it cannot tell where this Codex session sends work (nothing is recorded about where Codex sends work). Set it in BMN Preferences › Rules › Health.')
  })
})

describe('a destination that is only the owner\'s word (60.8 AC2)', () => {
  it('lets a provider that may see private work through', () => {
    approve(team((text) => edit(text, 'claude: {provider: anthropic, basis: observed-default}', 'claude: {provider: anthropic, basis: owner-declared}')))

    expect(prompt('claude', session(['claude']))).toMatchObject({ outcome: 'pass', cause: 'allowed' })
  })

  it('decides Cursor from what the owner recorded for it, offers no Allow, and only warns there', () => {
    approve(team())
    const pid = session(['cursor-agent'])

    const verdict = prompt('cursor', pid)
    expect(verdict).toMatchObject({ outcome: 'stop', cause: 'declared', allow: false, provider: { id: 'cursor', name: 'Cursor' } })
    expect(verdict.line).toBe("Cursor can't see private work in ~/code/app: where Cursor sends work is your word, not something BMN inspected. Record it as inspected in BMN Preferences › Rules › Health.")
    expect(GUARD_APPS.cursor).toEqual({ event: 'beforeSubmitPrompt', stops: false })
    expect(stopAnswer('cursor', 'anything')).toBeNull()
    expect(guardStanding('cursor')).toBe('prompt guard: active, only warns in Cursor')
    expect(guardStanding('opencode')).toMatch(/not available in OpenCode/)

    approve(team((text) => edit(text, 'cursor: {name: Cursor, hosts: [], private_work: public_only}', 'cursor: {name: Cursor, hosts: [], private_work: allowed}')))
    expect(prompt('cursor', pid)).toMatchObject({ outcome: 'pass', cause: 'allowed' })

    approve(team((text) => edit(text, 'cursor: {provider: cursor, basis: owner-declared}\n', '')))
    expect(prompt('cursor', pid).line).toMatch(/Cursor does not report where it sends work, and nothing is recorded for it\)\. Say where Cursor sends work in BMN Preferences › Rules › Health\./)
  })
})

describe('how a session was started', () => {
  it('reads only what can say where work goes', () => {
    expect(parseLaunch('claude', ['claude', '--model', 'opus', '--continue', 'a prompt with --settings in it'])).toMatchObject({ harness: 'claude' })
    expect(parseLaunch('claude', ['claude', '--settings', 'a.json']).settings).toBe('a.json')
    expect(parseLaunch('claude', ['claude', '--settings', 'a.json', '--settings=b.json'])).toEqual({ unknown: '--settings is given twice' })
    expect(parseLaunch('claude', ['claude', '--', '--settings'])).not.toHaveProperty('settings')
    expect(parseLaunch('codex', ['codex', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=high', '--config=model_provider="x"', '-p', 'work', '-C', '/synthetic'])).toMatchObject({
      config: ['model_provider="x"'], profile: 'work', cd: '/synthetic'
    })
    expect(parseLaunch('codex', ['bun', '/synthetic/codex.js', '--local-provider', 'ollama'])).toHaveProperty('unknown')
  })
})

describe('a decision that takes too long (60.8 AC2)', () => {
  it('ends as a stop with the fix, and an ordinary one gives the same answer as deciding directly', async () => {
    approve(team())
    const input = { agent: 'claude', pid: session(['claude'], { env: MOONSHOT_ENV }), procRoot: proc, event: { cwd: workspace } }

    const slow = await decideWithin(input, 0)
    expect(slow).toMatchObject({ outcome: 'stop', cause: 'slow', allow: false })
    expect(slow.line).toBe('BMN stopped this prompt: it could not decide within 2 seconds whether it may leave. Send it again.')
    expect(await decideWithin(input)).toEqual(decide(input))
  })
})

describe('the decision reads nothing it was not given (60.8 AC1)', () => {
  it('never takes the prompt: the same answer with and without it, and no file under the home folder gains it', () => {
    approve(team())
    const pid = session(['claude'], { env: MOONSHOT_ENV })
    const sentinel = 'PROMPT-SENTINEL-60-8'
    const before = execFileSync('find', [home, '-type', 'f'], { encoding: 'utf8' })

    const verdict = decide({ agent: 'claude', pid, procRoot: proc, event: { cwd: workspace, prompt: sentinel } as never })

    expect(JSON.stringify(verdict)).not.toContain(sentinel)
    expect(execFileSync('find', [home, '-type', 'f'], { encoding: 'utf8' })).toBe(before)
    let holding = ''
    try {
      holding = execFileSync('grep', ['-rl', sentinel, home], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      // grep exits 1 when no file holds the text.
    }
    expect(holding).toBe('')
  })
})
