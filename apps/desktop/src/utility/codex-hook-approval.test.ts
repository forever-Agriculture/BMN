// MODULE: codex-hook-approval.test.ts - Story 102.4: a report says what real Codex says about BMN's entries, never "holds" from the entry's text alone
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approvalFrom, approvalWords, askCodexHooks, claimWithApproval, codexHookKey, guardWithApproval } from '../../bin/codex-hook-approval.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../bin/bmn')
/** Answers as `codex app-server` does: line by line, and at the end of its input it exits with no answer (measured, Codex 0.166.0). */
const FAKE_CODEX = `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*) printf '%s\\n' '{"id":1,"result":{"userAgent":"fake"}}' ;;
    *'hooks/list'*) cat "$HOME/answer"; printf '\\n' ;;
  esac
done
`
let root = ''
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-approval-'))) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const program = (body: string): string => {
  const path = join(root, 'codex-program')
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

// Each case starts a real process; a machine as busy as his can take seconds over that (102.1).
describe('asking Codex (102.4)', { timeout: 60_000 }, () => {
  const env = (): NodeJS.ProcessEnv => ({ HOME: root, PATH: '/usr/bin:/bin' })

  it('keeps its input open until the answer, then reads the hooks and the counts', async () => {
    writeFileSync(join(root, 'answer'), JSON.stringify({ id: 2, result: { data: [{ cwd: root, hooks: [{ key: 'k' }], warnings: [{ message: 'w' }], errors: [] }] } }))
    await expect(askCodexHooks(program(FAKE_CODEX), { env: env(), cwd: root })).resolves.toEqual({ state: 'read', hooks: [{ key: 'k' }], warnings: 1, errors: 0 })
  })

  it.each([
    ['a Codex with no such method', JSON.stringify({ id: 2, error: { code: -32601, message: 'method not found' } }), 'this Codex cannot list its hooks'],
    ['a shape it cannot read', JSON.stringify({ id: 2, result: { data: 'x' } }), 'an answer BMN cannot read'],
    ['text that is not JSON', 'not json', 'an answer BMN cannot read'],
    ['JSON that is no message', 'null', 'an answer BMN cannot read']
  ])('says it could not read %s', async (_name, answer, reason) => {
    writeFileSync(join(root, 'answer'), answer)
    await expect(askCodexHooks(program(FAKE_CODEX), { env: env(), cwd: root })).resolves.toEqual({ state: 'unread', reason })
  })

  it('says so when Codex ends without answering, cannot start, or takes too long', async () => {
    await expect(askCodexHooks(program('#!/bin/sh\nexit 3\n'), { env: env(), cwd: root })).resolves.toEqual({ state: 'unread', reason: 'Codex ended without answering' })
    await expect(askCodexHooks(join(root, 'absent'), { env: env(), cwd: root })).resolves.toEqual({ state: 'unread', reason: 'ENOENT' })
    await expect(askCodexHooks(program('#!/bin/sh\nexec sleep 60\n'), { env: env(), cwd: root, limitMs: 100 })).resolves.toEqual({ state: 'unread', reason: 'no answer in 0.1 s' })
  })
})

describe('reading its answer (102.4)', () => {
  const entries = [{ event: 'PreToolUse', key: 'pre', command: 'c' }, { event: 'Stop', key: 'stop', command: 'c' }]
  const hook = (key: string, trustStatus: string, enabled: unknown = true, command = 'c') => ({ key, trustStatus, enabled, command })
  const read = (hooks: unknown[], extra = {}) => ({ state: 'read' as const, hooks, warnings: 0, errors: 0, ...extra })

  it('names its keys as Codex does', () => {
    expect(codexHookKey('/h/.codex/hooks.json', 'UserPromptSubmit', 1, 0)).toBe('/h/.codex/hooks.json:user_prompt_submit:1:0')
    expect(codexHookKey('/h/.codex/hooks.json', 'Stop', 0, 2)).toBe('/h/.codex/hooks.json:stop:0:2')
  })

  it('counts trusted and managed as running, and ignores hooks that are not BMN\'s', () => {
    expect(approvalFrom(read([hook('pre', 'trusted'), hook('stop', 'managed'), hook('his', 'modified')]), entries)).toEqual({ state: 'approved' })
  })

  it.each([['modified', true], ['untrusted', true], ['trusted', false], ['managed', false]])('counts %s with enabled %s as not running', (status, enabled) => {
    expect(approvalFrom(read([hook('pre', status as string, enabled), hook('stop', 'trusted')]), entries)).toEqual({ state: 'not-approved', entries: 1, events: ['PreToolUse'] })
  })

  it('names an event once, however many of its entries are off', () => {
    const two = [{ event: 'PreToolUse', key: 'a', command: 'c' }, { event: 'PreToolUse', key: 'b', command: 'c' }]
    expect(approvalFrom(read([hook('a', 'modified'), hook('b', 'modified')]), two)).toEqual({ state: 'not-approved', entries: 2, events: ['PreToolUse'] })
  })

  it.each([
    ['an entry it does not list', read([hook('pre', 'trusted')]), 'Codex does not list BMN\'s Stop entry'],
    ['an unlisted entry with a warning', read([hook('pre', 'trusted')], { warnings: 1 }), 'Codex does not list BMN\'s Stop entry, and warns about its hooks'],
    ['another command at that place', read([hook('pre', 'trusted'), hook('stop', 'trusted', true, 'other')]), 'Codex lists another command for BMN\'s Stop entry'],
    ['a status it does not know', read([hook('pre', 'trusted'), hook('stop', 'someday')]), 'Codex said something BMN does not know about its Stop entry'],
    ['enabled it cannot read', read([hook('pre', 'trusted'), hook('stop', 'trusted', 'yes')]), 'Codex said something BMN does not know about its Stop entry'],
    ['a settings error', read([], { errors: 1 }), 'Codex could not load its settings'],
    ['no answer', { state: 'unread' as const, reason: 'no answer in 10 s' }, 'no answer in 10 s']
  ])('says unverified, never approved, for %s', (_name, answer, reason) => {
    expect(approvalFrom(answer, entries)).toEqual({ state: 'unverified', reason })
  })

  it('takes "holds" from the guard only when Codex runs its entry, and leaves another problem as it is', () => {
    const holds = { state: 'holds' as const }
    expect(guardWithApproval(holds, { state: 'approved' })).toEqual(holds)
    expect(guardWithApproval(holds, null)).toEqual(holds)
    expect(guardWithApproval(holds, { state: 'not-approved', entries: 1, events: ['Stop'] })).toEqual(holds)
    expect(guardWithApproval(holds, { state: 'not-approved', entries: 1, events: ['PreToolUse'] })).toEqual({ state: 'not-approved' })
    expect(guardWithApproval(holds, { state: 'unverified', reason: 'r' })).toEqual({ state: 'unverified', reason: 'r' })
    expect(guardWithApproval(holds, { state: 'no-codex' })).toEqual({ state: 'no-codex' })
    const broken = { state: 'does-not-answer' as const, reason: 'r' }
    expect(guardWithApproval(broken, { state: 'not-approved', entries: 1, events: ['PreToolUse'] })).toEqual(broken)
  })

  it('lets a line claim a feature only while Codex runs the entry it needs', () => {
    const line = 'prompt guard: active, stops a prompt'
    expect(claimWithApproval(line, { state: 'approved' }, 'UserPromptSubmit')).toBe(line)
    expect(claimWithApproval(line, null, 'UserPromptSubmit')).toBe(line)
    expect(claimWithApproval(line, { state: 'not-approved', entries: 1, events: ['Stop'] }, 'UserPromptSubmit')).toBe(line)
    expect(claimWithApproval(line, { state: 'not-approved', entries: 1, events: ['UserPromptSubmit'] }, 'UserPromptSubmit')).toBe('prompt guard: off, Codex has not approved its entry')
    expect(claimWithApproval(line, { state: 'unverified', reason: 'r' }, 'UserPromptSubmit')).toBe('prompt guard: not verified, BMN could not ask Codex whether it runs its entry')
    expect(approvalWords({ state: 'not-approved', entries: 8, events: ['PreToolUse', 'Stop'] })).toBe('Codex does not run 8 of these entries (PreToolUse, Stop) until you approve them: run /hooks in Codex')
  })
})

describe('the reports, through the real command (102.4)', () => {
  /** A home as a session outside BMN has it: the guard answers, and `codex` is the fake unless `codex` is false. */
  const home = (codex = true): { env: NodeJS.ProcessEnv; hooks: string } => {
    mkdirSync(join(root, '.local/bin'), { recursive: true })
    mkdirSync(join(root, '.codex'), { recursive: true })
    mkdirSync(join(root, 'tools'), { recursive: true })
    writeFileSync(join(root, '.local/bin/bmn'), `#!/bin/sh\ncat >/dev/null; printf '%s' '{"hookSpecificOutput":{"permissionDecision":"deny"}}'\n`)
    chmodSync(join(root, '.local/bin/bmn'), 0o755)
    if (codex) {
      writeFileSync(join(root, 'tools/codex'), FAKE_CODEX)
      chmodSync(join(root, 'tools/codex'), 0o755)
    }
    return { env: { HOME: root, PATH: `${join(root, 'tools')}:/usr/bin:/bin`, ELECTRON_RUN_AS_NODE: '1' }, hooks: join(root, '.codex/hooks.json') }
  }
  const cli = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60_000 })
  /** The answer real Codex gives for the file on disk, each entry at the status `statusOf` says. */
  const answerFor = (hooks: string, statusOf: (event: string) => string): void => {
    const data = JSON.parse(readFileSync(hooks, 'utf8')).hooks as Record<string, { hooks: { command: string }[] }[]>
    const rows = Object.entries(data).flatMap(([event, groups]) => groups.flatMap((group, at) => group.hooks.map((entry, entryAt) => ({
      key: codexHookKey(hooks, event, at, entryAt), eventName: event, command: entry.command, enabled: true, trustStatus: statusOf(event)
    }))))
    writeFileSync(join(root, 'answer'), JSON.stringify({ id: 2, result: { data: [{ cwd: root, hooks: rows, warnings: [], errors: [] }] } }))
  }
  const install = ({ env, hooks }: { env: NodeJS.ProcessEnv; hooks: string }): void => {
    expect(cli(['hooks', 'install', 'codex', '--yes', '--json'], env).status).toBe(0)
    expect(readFileSync(hooks, 'utf8')).toContain('bmn hook codex')
  }
  const row = (stdout: string) => JSON.parse(stdout).agents[0]

  it('with every entry changed, says the guard does not run, exits 1 and claims nothing that needs an entry', () => {
    const place = home()
    install(place)
    answerFor(place.hooks, () => 'modified')
    const asJson = cli(['hooks', 'check', 'codex', '--json'], place.env)
    expect(asJson.status).toBe(1)
    expect(row(asJson.stdout)).toMatchObject({ commandGuard: { state: 'not-approved' }, approval: { state: 'not-approved', entries: 7 } })
    const text = cli(['hooks', 'check', 'codex'], place.env).stdout
    expect(text).toContain('command guard does not run: Codex has not approved its entry')
    expect(text).toContain('Codex does not run 7 of these entries')
    expect(text).toContain('run /hooks in Codex, then `bmn hooks check`')
    expect(text).not.toContain('command guard holds')
    expect(text).not.toMatch(/prompt guard: active/u)
    expect(text).toMatch(/messages: off, Codex has not approved its entry/u)
    expect(text).toMatch(/turn changes: off, Codex has not approved its entry/u)
  }, 90_000)

  it('with every entry approved, says the guard holds and exits 0', () => {
    const place = home()
    install(place)
    answerFor(place.hooks, () => 'trusted')
    const asJson = cli(['hooks', 'check', 'codex', '--json'], place.env)
    expect(asJson.status, asJson.stderr).toBe(0)
    expect(row(asJson.stdout)).toMatchObject({ commandGuard: { state: 'holds' }, approval: { state: 'approved' } })
    const text = cli(['hooks', 'check', 'codex'], place.env).stdout
    expect(text).toContain('command guard holds')
    expect(text).toContain('Codex says it runs these entries; that does not prove one fired')
    expect(text).not.toContain('run only once trusted')
  }, 90_000)

  it('with one other entry changed, keeps the guard and still needs him', () => {
    const place = home()
    install(place)
    answerFor(place.hooks, (event) => event === 'Stop' ? 'untrusted' : 'trusted')
    const asJson = cli(['hooks', 'check', 'codex', '--json'], place.env)
    expect(asJson.status).toBe(1)
    expect(row(asJson.stdout)).toMatchObject({ commandGuard: { state: 'holds' }, approval: { state: 'not-approved', entries: 1, events: ['Stop'] } })
  }, 90_000)

  it('with an answer it cannot read, never says holds and needs him', () => {
    const place = home()
    install(place)
    writeFileSync(join(root, 'answer'), 'not json')
    const asJson = cli(['hooks', 'check', 'codex', '--json'], place.env)
    expect(asJson.status).toBe(1)
    expect(row(asJson.stdout)).toMatchObject({ commandGuard: { state: 'unverified', reason: 'an answer BMN cannot read' }, approval: { state: 'unverified' } })
    expect(cli(['hooks', 'check', 'codex'], place.env).stdout).toContain('run only once trusted')
  }, 90_000)

  it('with no Codex to ask, never says holds and needs him: its file holds BMN\'s entries, so that may be a PATH problem', () => {
    const place = home(false)
    install(place)
    const asJson = cli(['hooks', 'check', 'codex', '--json'], place.env)
    expect(asJson.status).toBe(1)
    expect(row(asJson.stdout)).toMatchObject({ commandGuard: { state: 'no-codex' }, approval: { state: 'no-codex' } })
    const text = cli(['hooks', 'check', 'codex'], place.env).stdout
    expect(text).toContain('command guard not verified: BMN cannot find Codex')
    expect(text).not.toContain('command guard holds')
    expect(text).not.toMatch(/prompt guard: active/u)
  }, 90_000)

  it('at BMN\'s start, reports it on the app\'s row after the install, whose own exit stays about the install', () => {
    const place = home()
    install(place)
    answerFor(place.hooks, () => 'modified')
    const start = cli(['hooks', 'install', '--absent', '--yes', '--json'], place.env)
    expect(start.status, start.stderr).toBe(0)
    const codex = JSON.parse(start.stdout).agents.find((entry: { agent: string }) => entry.agent === 'codex')
    expect(codex).toMatchObject({ commandGuard: { state: 'not-approved' }, approval: { state: 'not-approved', entries: 7 } })
  }, 90_000)

  it('asks nothing about a file Codex does not read', () => {
    const place = home()
    install(place)
    const other = join(root, 'elsewhere.json')
    writeFileSync(other, readFileSync(place.hooks))
    answerFor(place.hooks, () => 'modified')
    const report = row(cli(['hooks', 'check', 'codex', '--file', other, '--json'], place.env).stdout)
    expect(report.commandGuard).toEqual({ state: 'holds' })
    expect(report).not.toHaveProperty('approval')
  }, 90_000)

  // Codex keeps its approval against a hash of the event, matcher, command and timeout (`codex-rs/hooks/src/engine/discovery.rs`,
  // `hook_hash`). Changing any of these turns that entry OFF in every Codex on his machine until he approves it again, as Story
  // 102.4's rewording did on 2026-11-02. If this test fails, that is the decision to make: keep the text, or change it and say so.
  it('pins each Codex entry as written, so that a change to one is a decision', () => {
    const place = home()
    install(place)
    const SOCKET = '[ -n "$BMN_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook codex; exit 0'
    const entry = (command: string, timeout: number) => [{ hooks: [{ type: 'command', timeout, command }] }]
    expect(JSON.parse(readFileSync(place.hooks, 'utf8')).hooks).toEqual({
      PreToolUse: entry('PATH="$PATH:$HOME/.local/bin"; command -v bmn >/dev/null && bmn hook codex; exit 0', 5),
      PostToolUse: entry(SOCKET, 5),
      UserPromptSubmit: entry(SOCKET, 5),
      Stop: entry(SOCKET, 5),
      SessionStart: entry(SOCKET, 5),
      SessionEnd: entry(SOCKET, 3),
      Interrupt: entry(SOCKET, 3)
    })
  }, 90_000)
})
