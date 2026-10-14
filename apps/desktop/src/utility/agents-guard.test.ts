// MODULE: agents-guard.test.ts - Epic 60.8: the prompt guard's decision over synthetic teams, process tables, settings and workspaces
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GUARD_MEASURED as PROTOCOL_GUARD_MEASURED, SESSION_MESSAGE_HANDOVER } from '@bmn/protocol'
import { GUARD_APPS, GUARD_MEASURED, MESSAGE_HANDOVER, MESSAGE_LIMIT_MS, decide, decideWithin, guardStanding, guardState, messageDestination, messageDestinationWithin, messageStanding, parseLaunch, stopAnswer } from '../../bin/agents-guard.mjs'
import type { MessageDestination } from '@bmn/protocol'
import { messageTeamAnswer } from '../main/agents-ipc'
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
const SESSION = '0a0a0a0a-1b1b-2c2c-3d3d-4e4e4e4e4e4e'
/** The record Codex saves for a session, written the way Codex writes its first line; returns what the prompt event says of it. */
function codexRecord(provider = 'openai', id = SESSION): { session_id: string } {
  const record = join(home, `.codex/sessions/2026/10/10/rollout-2026-10-10T09-00-00-${id}.jsonl`)
  mkdirSync(dirname(record), { recursive: true })
  writeFileSync(record, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: workspace, model_provider: provider, cli_version: '0.162.0' } })}\n`)
  return { session_id: id }
}
/** One prompt event. A Codex session comes with its saved record unless the event says which session it is. */
const prompt = (agent: string, pid: number, event: Record<string, unknown> = {}) => decide({ agent, pid, procRoot: proc,
  event: { cwd: workspace, ...(agent === 'codex' && !('session_id' in event) && !('transcript_path' in event) ? codexRecord() : {}), ...event } })
const exception = (folder: string) => (text: string) => edit(text, 'zai-synthetic: {provider: zai, folder: /synthetic/EXCEPTION-SENTINEL-FOLDER}',
  `zai-synthetic: {provider: zai, folder: /synthetic/EXCEPTION-SENTINEL-FOLDER}\nkimi-here: {provider: moonshot, folder: ${folder}}`)

/** A folder Git would call a repository's top-level: `.git` holds a HEAD. */
function repository(folder: string): void {
  mkdirSync(join(folder, '.git'), { recursive: true })
  writeFileSync(join(folder, '.git/HEAD'), 'ref: refs/heads/main\n')
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-guard-')))
  process.env.HOME = home
  proc = join(home, 'proc')
  workspace = join(home, 'code/app')
  repository(workspace)
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
    for (const argv of [['codex'], ['node', '/synthetic/lib/codex.js', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=xhigh', '-c', 'tui.theme="dark"']]) {
      expect(prompt('codex', session(argv)), argv.join(' ')).toMatchObject({ outcome: 'pass', cause: 'allowed', provider: { id: 'openai', name: 'OpenAI' } })
    }
    // A resumed Codex session is the one its saved record says it is.
    const id = '01a0b657-21a8-7f00-addd-b73646828f5b'
    const record = join(home, `.codex/sessions/2026/10/10/rollout-2026-10-10T10-00-00-${id}.jsonl`)
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: workspace, model_provider: 'openai', cli_version: '0.162.0' } })}\n`)
    expect(prompt('codex', session(['codex', 'resume', '--last']), { session_id: id })).toMatchObject({ outcome: 'pass', cause: 'allowed', provider: { id: 'openai', name: 'OpenAI' } })
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
    repository(sibling)
    repository(nested)
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
    const verdict = prompt('codex', session(['codex', '-c', 'model_provider="moonshot"', '-c', 'model_providers.moonshot.base_url="https://api.moonshot.ai/v1"']), codexRecord('moonshot'))

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
    // The same saved session picked from inside a Codex that was started plainly.
    expect(prompt('codex', session(['codex']), { session_id: id })).toMatchObject({ outcome: 'stop', cause: 'unknown', allow: false })
  })

  it('stops every Codex session whose saved record it cannot resolve, however it was started, and offers no Allow (60.8 AC1)', () => {
    const id = '01a0b657-21a8-7f00-addd-b73646828f5b'
    const missing = '11111111-2222-3333-4444-555555555555'
    const folder = join(home, '.codex/sessions/2026/10/10')
    const record = join(folder, `rollout-2026-10-10T10-00-00-${id}.jsonl`)
    mkdirSync(folder, { recursive: true })
    const meta = (payload: Record<string, unknown>): string => `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: workspace, cli_version: '0.162.0', ...payload } })}\n`
    const unknown = { outcome: 'stop', cause: 'unknown', allow: false, provider: null }
    const line = (reason: string): string => `BMN stopped this prompt: it cannot tell where this Codex session sends work (${reason}). BMN tells a Codex session's destination from the record Codex saves for it, and does not guess without one.`
    const starts = [['codex'], ['codex', 'resume', missing], ['codex', 'resume', '--last'], ['codex', 'fork', missing], ['codex', '-m', 'gpt-6-astra', 'resume']]
    // No record carries the session's id, or the event names no session at all: a new session and one that
    // continues a saved one look the same from here, so neither is taken on the current settings.
    for (const argv of starts) {
      const verdict = prompt('codex', session(argv), { session_id: missing })
      expect(verdict, argv.join(' ')).toMatchObject(unknown)
      expect(verdict.line).toBe(line('no saved record of this session was found'))
      expect(prompt('codex', session(argv), { session_id: undefined }), argv.join(' ')).toMatchObject(unknown)
    }
    // The record the app names is the only one looked at: missing, it is not searched for elsewhere.
    writeFileSync(record, meta({ model_provider: 'openai' }))
    for (const argv of starts) {
      const verdict = prompt('codex', session(argv), { session_id: id, transcript_path: join(folder, `rollout-2026-10-10T11-00-00-${id}.jsonl`) })
      expect(verdict, argv.join(' ')).toMatchObject(unknown)
      expect(verdict.line).toBe(line('the saved record the app names for this session is not there'))
    }
    // A record anywhere but under Codex's own sessions folder is never opened: by its path, or through a link.
    const outside = join(home, 'elsewhere/rollout.jsonl')
    mkdirSync(dirname(outside), { recursive: true })
    writeFileSync(outside, meta({ model_provider: 'openai' }))
    const escaped = join(folder, `rollout-2026-10-10T13-00-00-${id}.jsonl`)
    symlinkSync(outside, escaped)
    for (const named of [outside, escaped]) {
      expect(prompt('codex', session(['codex']), { session_id: id, transcript_path: named }).line).toBe(line("the saved record the app names for this session is outside Codex's own sessions folder"))
    }
    rmSync(escaped)
    for (const named of ['sessions/rollout.jsonl', 7, {}]) {
      expect(prompt('codex', session(['codex']), { session_id: id, transcript_path: named }).line).toBe(line('the saved record the app names for this session is not a place BMN can read'))
    }
    // A record that is there and cannot be read, names no provider, or is another session's.
    for (const text of ['', 'not json\n', `${JSON.stringify({ type: 'event' })}\n`, meta({}), meta({ model_provider: '' }), meta({ model_provider: 7 })]) {
      writeFileSync(record, text)
      for (const argv of [['codex', 'resume', id], ['codex']]) {
        expect(prompt('codex', session(argv), { session_id: id }), `${JSON.stringify(text)} ${argv.join(' ')}`).toMatchObject(unknown)
        expect(prompt('codex', session(argv), { session_id: id, transcript_path: record }).line).toBe(line('the saved record of this session cannot be read'))
      }
    }
    writeFileSync(record, meta({ model_provider: 'openai' }))
    expect(prompt('codex', session(['codex']), { session_id: missing, transcript_path: record }).line).toBe(line('the saved record the app names belongs to another session'))
    // A good record the app names, and no word from the app on which session this is: nothing ties the record to it.
    for (const said of [undefined, null, '', 7, {}, [id]]) {
      for (const argv of [['codex'], ['codex', 'resume', id]]) {
        const verdict = prompt('codex', session(argv), { session_id: said, transcript_path: record })
        expect(verdict, `${JSON.stringify(said)} ${argv.join(' ')}`).toMatchObject(unknown)
        expect(verdict.line).toBe(line('the app did not say which session this prompt belongs to'))
      }
    }
    // A record that does not say which session it is ties nothing either, named or found by its file name.
    for (const own of [undefined, null, '', 7]) {
      writeFileSync(record, meta({ model_provider: 'openai', id: own }))
      for (const event of [{ session_id: id }, { session_id: id, transcript_path: record }]) {
        const verdict = prompt('codex', session(['codex']), event)
        expect(verdict, JSON.stringify(own)).toMatchObject(unknown)
        expect(verdict.line).toBe(line('the saved record of this session does not say which session it is'))
      }
    }
    writeFileSync(record, meta({ model_provider: 'openai' }))
    // Two records under one id are not one session's.
    writeFileSync(join(folder, `rollout-2026-10-10T12-00-00-${id}.jsonl`), meta({ model_provider: 'openai' }))
    expect(prompt('codex', session(['codex', 'resume', id]), { session_id: id }).line).toBe(line("more than one saved record carries this session's id"))
    rmSync(join(folder, `rollout-2026-10-10T12-00-00-${id}.jsonl`))
    // Resolved, and saved with the provider the settings name: the prompt goes on, by its id or by the record the app names.
    for (const argv of [['codex'], ['codex', 'resume', id]]) {
      expect(prompt('codex', session(argv), { session_id: id })).toMatchObject({ outcome: 'pass' })
      expect(prompt('codex', session(argv), { session_id: id, transcript_path: record })).toMatchObject({ outcome: 'pass' })
    }
    // Only the record's first line is read: what follows it, however much, decides nothing.
    writeFileSync(record, `${meta({ model_provider: 'openai' })}${JSON.stringify({ type: 'session_meta', payload: { id, model_provider: 'moonshot' } })}\n${'x'.repeat(200_000)}\n`)
    expect(prompt('codex', session(['codex']), { session_id: id })).toMatchObject({ outcome: 'pass', provider: { id: 'openai' } })
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

  it('stands for nothing in Cursor, which was retired, and says so (Epic 71)', () => {
    approve(team())
    expect(Object.keys(GUARD_APPS)).toEqual(['claude', 'codex'])
    expect(stopAnswer('cursor', 'anything')).toBeNull()
    expect(guardStanding('cursor')).toBe("prompt guard: Cursor was retired on 2026-10-14; BMN's support for it is kept at the git tag cursor-support-final")
    // The live stop test of 2026-10-11; the card reads the same record from the protocol package.
    expect(guardStanding('claude')).toBe('prompt guard: active, stops a prompt that would send private work to a provider that may not see it (measured on Claude Code 2.1.296)')
    expect(guardStanding('codex')).toBe('prompt guard: active, stops a prompt that would send private work to a provider that may not see it (measured on Codex 0.162.1)')
    expect(GUARD_MEASURED).toEqual(PROTOCOL_GUARD_MEASURED)
    expect(guardStanding('opencode')).toMatch(/not available in OpenCode/)
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

  it('stops the prompt when the thread that decides cannot start, fails or ends without an answer, and never decides on the hook\'s own thread', async () => {
    approve(team())
    const input = { agent: 'claude', pid: session(['claude']), procRoot: proc, event: { cwd: workspace } }
    // On this thread the same prompt would pass: the provider may see private work.
    expect(decide(input)).toMatchObject({ outcome: 'pass' })
    const failed = { outcome: 'stop', cause: 'state', allow: false, line: 'BMN stopped this prompt: its check failed. Open BMN Preferences › Team; if the team shows no problem, start the session again.' }
    const thread = (fire: (emitter: EventEmitter) => void) => () => {
      const emitter = new EventEmitter()
      queueMicrotask(() => fire(emitter))
      return Object.assign(emitter, { terminate: () => {} })
    }
    expect(await decideWithin(input, 2000, { startThread: () => { throw new Error('synthetic: no thread') } })).toMatchObject(failed)
    expect(await decideWithin(input, 2000, { startThread: thread((emitter) => emitter.emit('error', new Error('synthetic'))) })).toMatchObject(failed)
    expect(await decideWithin(input, 2000, { startThread: thread((emitter) => emitter.emit('exit', 1)) })).toMatchObject(failed)
    // A thread that never answers ends at the limit.
    expect(await decideWithin(input, 30, { startThread: thread(() => {}) })).toMatchObject({ outcome: 'stop', cause: 'slow' })
  })

  it('answers an installation that never approved a team without starting the thread', async () => {
    const input = { agent: 'claude', pid: session(['claude'], { env: MOONSHOT_ENV }), procRoot: proc, event: { cwd: workspace } }
    let started = 0
    const verdict = await decideWithin(input, 2000, { startThread: () => { started += 1; throw new Error('synthetic: no thread') } })
    expect(verdict).toEqual(decide(input))
    expect(verdict).toMatchObject({ outcome: 'pass', cause: 'inactive' })
    expect(started).toBe(0)
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

describe('where a receiving agent sends work, for a message (Epic 66.4)', () => {
  /** The record Claude Code keeps of a conversation, under the folder of the app that runs it; returns what its events say of it. */
  const claudeRecord = (configDir = join(home, '.claude')): { session_id: string; transcript_path: string } => {
    const record = join(configDir, `projects/-synthetic-code-app/${SESSION}.jsonl`)
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, '{"type":"user"}\n')
    return { session_id: SESSION, transcript_path: record }
  }
  const afterTool = (agent: string, pid: number, event: Record<string, unknown> = {}) => messageDestination({ agent, pid, procRoot: proc,
    event: {
      cwd: workspace, ...(agent === 'codex' && !('session_id' in event) ? codexRecord() : {}),
      ...(agent === 'claude' && !('transcript_path' in event) ? claudeRecord() : {}), ...event
    } })

  it('holds the hook\'s record of measured apps and the window\'s to one', () => {
    expect(MESSAGE_HANDOVER).toEqual(SESSION_MESSAGE_HANDOVER)
    // The two apps docs/session-messages.md holds a PASS for, each on the event after a tool call.
    expect(MESSAGE_HANDOVER).toEqual({ claude: { event: 'PostToolUse', version: '2.1.296' }, codex: { event: 'PostToolUse', version: '0.162.1' } })
    expect(MESSAGE_LIMIT_MS).toBe(300)
  })

  it('gives the whole destination the resolver found when the guard would let this event pass', () => {
    approve(team())
    expect(afterTool('codex', session(['codex']))).toEqual({ provider: 'openai', host: 'default:openai', basis: 'observed-default', default: true })
    expect(afterTool('claude', session(['claude']))).toEqual({ provider: 'anthropic', host: 'default:anthropic', basis: 'observed-default', default: true })
  })

  it('gives an explicit address as it was resolved, when the owner allowed that provider in the receiver\'s own folder', () => {
    approve(team(exception(workspace)))
    expect(afterTool('claude', session(['claude'], { env: MOONSHOT_ENV })))
      .toEqual({ provider: 'moonshot', host: 'api.moonshot.ai', basis: 'explicit', default: false })
  })

  it('gives nothing when the guard would stop the event, whatever the reason', () => {
    approve(team())
    // A provider that may not see the receiver's own folder.
    expect(afterTool('claude', session(['claude'], { env: MOONSHOT_ENV }))).toBeNull()
    // A Codex conversation with no saved record: an unknown destination.
    expect(afterTool('codex', session(['codex']), { session_id: '9f9f9f9f-1b1b-2c2c-3d3d-4e4e4e4e4e4e' })).toBeNull()
    // A process the table cannot show.
    expect(afterTool('codex', 0)).toBeNull()
    expect(afterTool('codex', 9999)).toBeNull()
  })

  it('gives nothing for a Claude Code event that does not name that process\'s own record: another app\'s hook entry may have run this hook', () => {
    approve(team())
    const anthropic = { provider: 'anthropic', host: 'default:anthropic', basis: 'observed-default', default: true }
    // A Codex agent whose hook entry runs `bmn hook claude` by mistake: its event names Codex's own record.
    const codex = session(['codex'])
    const rollout = join(home, `.codex/sessions/2026/10/10/rollout-2026-10-10T09-00-00-${SESSION}.jsonl`)
    expect(afterTool('claude', codex, { ...codexRecord(), transcript_path: rollout })).toBeNull()
    const claude = session(['claude'])
    expect(afterTool('claude', claude, { transcript_path: undefined })).toBeNull()
    expect(afterTool('claude', claude, { transcript_path: 'projects/relative.jsonl' })).toBeNull()
    expect(afterTool('claude', claude, { transcript_path: join(home, '.claude/projects/-synthetic-code-app/never-written.jsonl') })).toBeNull()
    // A folder is no record, and neither is a file beside the projects folder.
    mkdirSync(join(home, '.claude/projects/-synthetic-code-app/folder.jsonl'), { recursive: true })
    expect(afterTool('claude', claude, { transcript_path: join(home, '.claude/projects/-synthetic-code-app/folder.jsonl') })).toBeNull()
    writeFileSync(join(home, '.claude/beside.jsonl'), '{}\n')
    expect(afterTool('claude', claude, { transcript_path: join(home, '.claude/beside.jsonl') })).toBeNull()
    // A link out of the projects folder is followed before the place is judged.
    symlinkSync(rollout, join(home, '.claude/projects/-synthetic-code-app/linked.jsonl'))
    expect(afterTool('claude', claude, { transcript_path: join(home, '.claude/projects/-synthetic-code-app/linked.jsonl') })).toBeNull()
    // The process's own Claude Code folder decides, wherever it was told to keep it.
    const elsewhere = join(home, 'claude-elsewhere')
    const moved = session(['claude'], { env: { CLAUDE_CONFIG_DIR: elsewhere } })
    expect(afterTool('claude', moved, claudeRecord())).toBeNull()
    expect(afterTool('claude', moved, claudeRecord(elsewhere))).toEqual(anthropic)
    // None of this is asked of a prompt: the guard's decision for the same event is unchanged.
    expect(decide({ agent: 'claude', pid: claude, procRoot: proc, event: { cwd: workspace } })).toMatchObject({ outcome: 'pass', cause: 'allowed' })
  })

  it('gives nothing on an installation that never approved a team: no resolver, no hand-over', () => {
    expect(guardState().state).toBe('inactive')
    expect(afterTool('codex', session(['codex']))).toBeNull()
  })

  it('answers through its thread like the direct call, and with nothing when the thread fails or is too slow', async () => {
    approve(team())
    const input = { agent: 'codex', pid: session(['codex']), procRoot: proc, event: { cwd: workspace, ...codexRecord() } }
    expect(await messageDestinationWithin(input, 2000)).toEqual(messageDestination(input))
    const failing = () => { throw new Error('synthetic: no thread') }
    expect(await messageDestinationWithin(input, 2000, { startThread: failing })).toBeNull()
    const silent = () => Object.assign(new EventEmitter(), { terminate: () => undefined })
    const from = Date.now()
    expect(await messageDestinationWithin(input, 40, { startThread: silent })).toBeNull()
    expect(Date.now() - from).toBeLessThan(1000)
  })

  it('says per app, for `bmn hooks check`, whether its hook hands messages over and on which version that was measured', () => {
    expect(messageStanding('codex')).toBe('messages: not handed over until a team is approved (measured on Codex 0.162.1)')
    expect(messageStanding('claude')).toBe('messages: not handed over until a team is approved (measured on Claude Code 2.1.296)')
    approve(team())
    expect(messageStanding('codex')).toBe('messages: handed to a working agent by this hook after a tool call (measured on Codex 0.162.1)')
    expect(messageStanding('claude')).toBe('messages: handed to a working agent by this hook after a tool call (measured on Claude Code 2.1.296)')
    expect(messageStanding('opencode')).toBe('messages: not handed over by a hook in OpenCode; your Paste in Messages delivers them')
  })
})


/** The host's two questions about a message, as the app's entry point answers them (Epic 66). */
const messageSourceRoot = (folder: string): string => (messageTeamAnswer({ kind: 'source-root', folder }) as { root: string }).root
const messageProviderAnswer = (destination: MessageDestination, senderRoot: string): { allowed: boolean; reason: string } =>
  messageTeamAnswer({ kind: 'provider', destination, senderRoot }) as { allowed: boolean; reason: string }

describe('whether a receiving agent\'s provider may see the sender\'s work (Epic 66.4 AC2)', () => {
  const OPENAI = { provider: 'openai', host: 'default:openai', basis: 'observed-default', default: true }
  const MOONSHOT = { provider: 'moonshot', host: 'api.moonshot.ai', basis: 'explicit', default: false }

  it('takes the Git root of a folder, or the folder itself outside Git, as the sender\'s root', () => {
    expect(messageSourceRoot(join(workspace, 'src'))).toBe(workspace)
    expect(messageSourceRoot(home)).toBe(home)
  })

  it('allows a provider that may see private work, for any sender\'s root', () => {
    approve(team())
    expect(messageProviderAnswer(OPENAI, workspace)).toMatchObject({ allowed: true })
    expect(messageProviderAnswer(OPENAI, '/synthetic/another/root')).toMatchObject({ allowed: true })
  })

  it('refuses a provider that may see public work only, until "Allow here" names the root the message came from', () => {
    const other = join(home, 'code/other')
    repository(other)
    approve(team())
    expect(messageProviderAnswer(MOONSHOT, workspace)).toEqual({ allowed: false, reason: 'Moonshot AI gets public work only' })

    approve(team(exception(workspace)))

    // The exception is read at the call: it counts for the root it names and for no other.
    expect(messageProviderAnswer(MOONSHOT, workspace)).toMatchObject({ allowed: true })
    expect(messageProviderAnswer(MOONSHOT, other)).toEqual({ allowed: false, reason: 'Moonshot AI gets public work only' })
  })

  it('gives nothing to a destination that is only the owner\'s word, or to a provider the team does not name', () => {
    approve(team())
    expect(messageProviderAnswer({ provider: 'opencode-go', host: 'default:opencode', basis: 'owner-declared', default: true }, workspace))
      .toMatchObject({ allowed: false })
    expect(messageProviderAnswer({ ...OPENAI, basis: 'owner-declared' }, workspace)).toMatchObject({ allowed: false })
    expect(messageProviderAnswer({ provider: 'nobody', host: 'api.nobody.example', basis: 'explicit', default: false }, workspace))
      .toEqual({ allowed: false, reason: 'the approved team names no such provider' })
  })

  it('throws when no team is approved, which the host treats as a refusal', () => {
    expect(() => messageProviderAnswer(OPENAI, workspace)).toThrow()
  })
})
