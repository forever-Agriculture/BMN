// MODULE: agents-context.test.ts - Story 60.9: context limits over synthetic teams, config files and stub apps; no real app is started
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONTEXT_TEST_SIZE, applyContextDefault, claudeReportedWindow, codexRecordedWindow, contextDefault, contextItems, contextTests, contextTestsPath,
  planContextDefault, provenControls, provenPrecedence, readClaudeContext, readCodexContext, setJsonEnvEntry, setTomlTopLevelKey, testContext, type ContextTestEntry
} from '../../bin/agents-context.mjs'
import { evaluate } from '../../bin/agents-check.mjs'
import { readValidRoster } from '../../bin/agents-state.mjs'
import { approveRoster } from '../main/agents-approval'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const NOW = new Date('2026-10-10T12:00:00.000Z')

let home: string
let stubs: string
let workspace: string
let env: Record<string, string>
const savedHome = process.env.HOME

function edit(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`fixture edit expected one "${from}"`)
  return text.replace(from, to)
}

/** The example team: Sol (Codex, lead) with a limit of 272 000; `opus` adds a limit to Opus (Claude Code, lead). */
function roster({ opus, solCompact }: { opus?: number; solCompact?: number } = {}): string {
  let text = EXAMPLE
  if (opus !== undefined) text = edit(text, 'model: claude-opus-5-5', `model: claude-opus-5-5\ncontext_limit: ${opus}`)
  if (solCompact !== undefined) text = edit(text, 'context_limit: 272000', `context_limit: 272000\ncompact_at: ${solCompact}`)
  return text
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

function stub(name: string, body: string): void {
  writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(stubs, name), 0o755)
}

function tested(harness: string, version: string, limit: ContextTestEntry['limit'] = 'pass', compact: ContextTestEntry['compact'] = 'untested'): ContextTestEntry {
  return { harness, at: NOW.toISOString(), version, limit, compact, asked: 1, observed: 1, detail: 'synthetic' }
}

const CODEX = '0.161.0'
const CLAUDE = '2.1.295'

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-context-')))
  process.env.HOME = home
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  stub('codex', `echo "codex-cli ${CODEX}"`)
  stub('claude', `echo "${CLAUDE} (Claude Code)"`)
  workspace = join(home, 'work')
  mkdirSync(workspace, { recursive: true })
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }
  approve(roster())
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const SOL = (...extra: string[]) => ['codex', 'exec', '--skip-git-repo-check', '-C', workspace, '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh', ...extra, '-']
const OPUS = (...entries: string[]) => ['env', '-i', `HOME=${home}`, `PATH=${env.PATH}`, ...entries, 'claude', '-p', '--model', 'claude-opus-5-5', '--effort', 'xhigh']

type Inputs = Parameters<typeof evaluate>[0]

function check(agent: string, argv: string[], log: ContextTestEntry[], environment = env) {
  return evaluate({ agent, role: 'lead', workspace, data: 'private', cwd: workspace, argv } as Inputs, { environment, cwd: workspace, now: NOW, contextTestLog: log })
}

describe('which settings are proven for a version (60.9 AC1)', () => {
  it('counts a setting only where the latest test of exactly that version passed', () => {
    expect(provenControls('codex', CODEX, [])).toEqual({ limit: false, compact: false })
    expect(provenControls('codex', CODEX, [tested('codex', CODEX)])).toEqual({ limit: true, compact: false })
    expect(provenControls('codex', '0.162.0', [tested('codex', CODEX)])).toEqual({ limit: false, compact: false })
    expect(provenControls('codex', CODEX, [tested('codex', CODEX), tested('codex', CODEX, 'fail')])).toEqual({ limit: false, compact: false })
    expect(provenControls('codex', CODEX, [tested('codex', CODEX, 'pass', 'pass')])).toEqual({ limit: true, compact: true })
    expect(provenControls('codex', CODEX, [tested('codex', CODEX, 'inconclusive')]).limit).toBe(false)
    expect(provenControls('codex', null, [tested('codex', CODEX)]).limit).toBe(false)
    // Claude Code has no setting for where summarising starts, whatever a record says.
    expect(provenControls('claude', CLAUDE, [tested('claude', CLAUDE, 'pass', 'pass')])).toEqual({ limit: true, compact: false })
    expect(provenControls('opencode', '1.0.0', [tested('opencode', '1.0.0')])).toEqual({ limit: false, compact: false })
  })

  it('keeps what a test saw about sources that disagree: the very source and the side, for that version only', () => {
    const source = 'user settings autoCompactWindow'
    const id = 'user settings at /home/synthetic/.claude/settings.json: autoCompactWindow'
    const other = 'managed settings at /etc/claude-code/managed-settings.d/a.json: autoCompactWindow'
    const seen: ContextTestEntry = { ...tested('claude', CLAUDE), asked: 137_000, observed: 137_000, rivals: [{ source, id, value: 450_000 }] }
    expect(provenPrecedence('claude', CLAUDE, [seen])).toEqual([{ id, side: 'above' }])
    expect(provenPrecedence('claude', CLAUDE, [{ ...seen, rivals: [{ source, id, value: 100_000 }] }])).toEqual([{ id, side: 'below' }])
    expect(provenPrecedence('claude', CLAUDE, [{ ...seen, rivals: [{ source, id, value: 138_371 }] }])).toEqual([{ id, side: 'above' }])
    // A source that named the size asked for, or one the app's rounded report cannot tell from it, may be the one the app
    // obeyed. So the whole test shows nothing, also about a second source that named a clearly different size.
    expect(provenPrecedence('claude', CLAUDE, [{ ...seen, rivals: [{ source, id, value: 137_000 }] }])).toEqual([])
    expect(provenPrecedence('claude', CLAUDE, [{ ...seen, rivals: [{ source, id: other, value: 138_000 }, { source, id, value: 450_000 }] }])).toEqual([])
    expect(provenPrecedence('claude', CLAUDE, [{ ...seen, rivals: [{ source, id: other, value: 136_000 }, { source, id, value: 450_000 }] }])).toEqual([])
    // A record BMN cannot read in full proves nothing: no size asked for, a report that is not that size, a source without
    // its identity (the first form of this record named only a kind of source).
    expect(provenPrecedence('claude', CLAUDE, [{ ...seen, asked: undefined as unknown as number }])).toEqual([])
    expect(provenPrecedence('claude', CLAUDE, [{ ...seen, observed: 450_000 }])).toEqual([])
    expect(provenPrecedence('claude', CLAUDE, [{ ...seen, observed: null }])).toEqual([])
    expect(provenPrecedence('claude', CLAUDE, [{ ...seen, rivals: [{ kind: 'user settings autoCompactWindow', value: 450_000 }] as unknown as NonNullable<ContextTestEntry['rivals']> }])).toEqual([])
    expect(provenPrecedence('claude', CLAUDE, [{ ...seen, rivals: [{ source, id, value: 450_000 }, { source, value: 300_000 }] as unknown as NonNullable<ContextTestEntry['rivals']> }])).toEqual([])
    expect(provenPrecedence('claude', '2.1.300', [seen])).toEqual([])
    expect(provenPrecedence('claude', null, [seen])).toEqual([])
    expect(provenPrecedence('claude', CLAUDE, [{ ...seen, limit: 'fail' }])).toEqual([])
    // The latest test of the version decides: one that met no other source takes the earlier proof away.
    expect(provenPrecedence('claude', CLAUDE, [seen, tested('claude', CLAUDE)])).toEqual([])
    expect(provenPrecedence('claude', CLAUDE, [])).toEqual([])
  })

  it('gives a dispatch no items for a setting that is not proven, and never both an argv and an env form', () => {
    const sol = { id: 'sol', harness: 'codex', context_limit: 272_000, compact_at: 200_000 }
    expect(contextItems({ id: 'astra', harness: 'codex' }, { limit: true, compact: true })).toEqual({ state: 'app-default' })
    const unproven = contextItems(sol, { limit: false, compact: false })
    expect(unproven).toMatchObject({ state: 'not-supported-yet', limit: 272_000 })
    expect(unproven).not.toHaveProperty('argv')
    expect(contextItems(sol, { limit: true, compact: false })).toEqual({ state: 'applied', limit: 272_000, compact_at: 200_000, compact: 'not-supported-yet',
      argv: ['-c', 'model_context_window=272000'], env: [] })
    expect(contextItems(sol, { limit: true, compact: true })).toMatchObject({ compact: 'applied',
      argv: ['-c', 'model_context_window=272000', '-c', 'model_auto_compact_token_limit=200000'] })
    expect(contextItems({ id: 'opus', harness: 'claude', context_limit: 200_000 }, { limit: true, compact: false }))
      .toEqual({ state: 'applied', limit: 200_000, argv: [], env: ['CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000'] })
    expect(contextItems({ id: 'haiku', harness: 'claude', context_limit: 90_000 }, { limit: true, compact: false }))
      .toMatchObject({ state: 'out-of-range', reason: 'Claude Code takes 100 000 to 1 000 000 tokens' })
    expect(contextItems({ id: 'kimi', harness: 'opencode', context_limit: 90_000 }, { limit: true, compact: true })).toMatchObject({ state: 'not-supported-yet' })
  })
})

describe('the check compares what a run would really use with the agent\'s limit (60.9 AC2)', () => {
  it('requires nothing while the setting is not proven on the installed version', () => {
    const result = check('sol', SOL(), [])
    expect(result.verdict, JSON.stringify(result)).toBe('PASS')
    expect(result.receipt?.context_limit_applied).toBeNull()
    expect(result.steps.join('\n')).toMatch(/context limit 272000: not applied, the context setting is not tested on this Codex version/)
    // A test of another version proves nothing about this one.
    expect(check('sol', SOL(), [tested('codex', '0.150.0')]).verdict).toBe('PASS')
  })

  it('refuses a Codex run with a missing or wrong limit and passes the right one, recording it', () => {
    const log = [tested('codex', CODEX)]
    expect(check('sol', SOL(), log)).toMatchObject({ verdict: 'REFUSED', code: 'CONTEXT_MISMATCH', message: 'no context limit reaches Codex; sol\'s is 272000' })
    expect(check('sol', SOL('-c', 'model_context_window=400000'), log)).toMatchObject({ verdict: 'REFUSED', code: 'CONTEXT_MISMATCH',
      message: '-c model_context_window gives a context limit of 400000; sol\'s is 272000' })
    expect(check('sol', SOL('-c', 'model_context_window=lots'), log)).toMatchObject({ code: 'CONTEXT_MISMATCH', message: expect.stringContaining('cannot be resolved: -c model_context_window is not a whole number') })
    const right = check('sol', SOL('-c', 'model_context_window=272000'), log)
    expect(right.verdict, JSON.stringify(right)).toBe('PASS')
    expect(right.receipt?.context_limit_applied).toBe(272_000)
    // An agent without a limit of its own is never asked for one.
    const astra = evaluate({ agent: 'astra', role: 'epic-reviewer', workspace, data: 'private', cwd: workspace,
      argv: ['codex', 'exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=medium', '-'] } as Inputs, { environment: env, cwd: workspace, now: NOW, contextTestLog: log })
    expect(astra.verdict, JSON.stringify(astra)).toBe('PASS')
  })

  it('resolves a Codex limit from the item, then the profile, then config.toml', () => {
    const log = [tested('codex', CODEX)]
    mkdirSync(join(home, '.codex'))
    const config = (text: string) => writeFileSync(join(home, '.codex/config.toml'), text)
    config('model_context_window = 272_000 # mine\n')
    expect(check('sol', SOL(), log).verdict).toBe('PASS')
    config('model_context_window = 380000\n')
    expect(check('sol', SOL(), log)).toMatchObject({ code: 'CONTEXT_MISMATCH', message: 'config.toml model_context_window gives a context limit of 380000; sol\'s is 272000' })
    // The dispatch's own item wins over the file.
    expect(check('sol', SOL('-c', 'model_context_window=272000'), log).verdict).toBe('PASS')
    config('model_context_window = 272000\n\n[profiles.big]\nmodel_context_window = 900000\n')
    expect(check('sol', SOL('--profile', 'big'), log)).toMatchObject({ code: 'CONTEXT_MISMATCH', message: 'config.toml profiles.big.model_context_window gives a context limit of 900000; sol\'s is 272000' })
    expect(check('sol', SOL('--profile', 'big', '-c', 'model_context_window=272000'), log)).toMatchObject({ verdict: 'PASS' })
    config('model_context_window = "plenty"\n')
    expect(check('sol', SOL(), log)).toMatchObject({ code: 'CONTEXT_MISMATCH', message: expect.stringContaining('config.toml model_context_window is not a whole number') })
    // A file BMN does not rank against config.toml: only the dispatch's own item settles it.
    config('model_context_window = 272000\n')
    mkdirSync(join(workspace, '.codex'))
    writeFileSync(join(workspace, '.codex/config.toml'), 'model_context_window = 100000\n')
    expect(check('sol', SOL(), log)).toMatchObject({ code: 'CONTEXT_MISMATCH', message: expect.stringContaining('also sets a context size, and BMN cannot tell which file wins') })
    expect(check('sol', SOL('-c', 'model_context_window=272000'), log).verdict).toBe('PASS')
  })

  it('asks for the compaction point only where that setting is proven too', () => {
    approve(roster({ solCompact: 200_000 }))
    const limitOnly = [tested('codex', CODEX)]
    expect(check('sol', SOL('-c', 'model_context_window=272000'), limitOnly).verdict).toBe('PASS')
    const both = [tested('codex', CODEX, 'pass', 'pass')]
    expect(check('sol', SOL('-c', 'model_context_window=272000'), both)).toMatchObject({ code: 'CONTEXT_MISMATCH', message: 'no compaction point reaches Codex; sol\'s is 200000' })
    expect(check('sol', SOL('-c', 'model_context_window=272000', '-c', 'model_auto_compact_token_limit=250000'), both)).toMatchObject({ code: 'CONTEXT_MISMATCH' })
    const right = check('sol', SOL('-c', 'model_context_window=272000', '-c', 'model_auto_compact_token_limit=200000'), both)
    expect(right.verdict, JSON.stringify(right)).toBe('PASS')
    expect(right.steps.join('\n')).toMatch(/context limit 272000, compacting at 200000/)
  })

  it('refuses a Claude Code run unless one size reaches it from every source that names one', () => {
    approve(roster({ opus: 200_000 }))
    const log = [tested('claude', CLAUDE)]
    expect(check('opus', OPUS(), [])).toMatchObject({ verdict: 'PASS' })
    expect(check('opus', OPUS(), log)).toMatchObject({ code: 'CONTEXT_MISMATCH', message: 'no context limit reaches Claude Code; opus\'s is 200000' })
    expect(check('opus', OPUS('CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000'), log)).toMatchObject({ code: 'CONTEXT_MISMATCH',
      message: 'env -i CLAUDE_CODE_AUTO_COMPACT_WINDOW gives a context limit of 300000; opus\'s is 200000' })
    const right = check('opus', OPUS('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000'), log)
    expect(right.verdict, JSON.stringify(right)).toBe('PASS')
    expect(right.receipt?.context_limit_applied).toBe(200_000)
    // The owner's default for his own sessions reaches a dispatch too: a different size there is no answer BMN can give.
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } }))
    expect(check('opus', OPUS('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000'), log)).toMatchObject({ code: 'CONTEXT_MISMATCH',
      message: expect.stringContaining('cannot be resolved: env -i CLAUDE_CODE_AUTO_COMPACT_WINDOW says 200000 and user settings env CLAUDE_CODE_AUTO_COMPACT_WINDOW says 300000') })
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' } }))
    expect(check('opus', OPUS(), log).verdict).toBe('PASS')
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ autoCompactWindow: 150000 }))
    expect(check('opus', OPUS('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000'), log)).toMatchObject({ code: 'CONTEXT_MISMATCH' })
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ autoCompactWindow: 'auto', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 200000 } }))
    expect(check('opus', OPUS(), log).verdict).toBe('PASS')
  })

  it('lets the run\'s own size win over another source only where the test of this version saw exactly that', () => {
    approve(roster({ opus: 200_000 }))
    const settings = join(home, '.claude/settings.json')
    const source = 'user settings autoCompactWindow'
    const id = `user settings at ${settings}: autoCompactWindow`
    const argv = OPUS('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000')
    const seen = (version = CLAUDE, rival = id): ContextTestEntry[] => [{ ...tested('claude', version), asked: 137_000, observed: 137_000, rivals: [{ source, id: rival, value: 450_000 }] }]
    mkdirSync(join(home, '.claude'))
    writeFileSync(settings, JSON.stringify({ autoCompactWindow: 450000 }))
    // Without that proof two sizes stay no answer.
    expect(check('opus', argv, [tested('claude', CLAUDE)])).toMatchObject({ code: 'CONTEXT_MISMATCH',
      message: expect.stringContaining('cannot be resolved: env -i CLAUDE_CODE_AUTO_COMPACT_WINDOW says 200000 and user settings autoCompactWindow says 450000') })
    // Nor does a proof from another version settle them here.
    expect(check('opus', argv, [...seen('2.1.300'), tested('claude', CLAUDE)])).toMatchObject({ code: 'CONTEXT_MISMATCH', message: expect.stringContaining('cannot be resolved') })
    const right = check('opus', argv, seen())
    expect(right.verdict, JSON.stringify(right)).toBe('PASS')
    expect(right.receipt?.context_limit_applied).toBe(200_000)
    expect(right.steps.join('\n')).toMatch(/context limit 200000: env -i CLAUDE_CODE_AUTO_COMPACT_WINDOW, which the test of this version showed wins over user settings autoCompactWindow \(450000\)/)
    // The run must still carry the agent's own size: the owner's default alone is not it.
    expect(check('opus', OPUS(), seen())).toMatchObject({ code: 'CONTEXT_MISMATCH', message: 'user settings autoCompactWindow gives a context limit of 450000; opus\'s is 200000' })
    expect(check('opus', OPUS('CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000'), seen())).toMatchObject({ code: 'CONTEXT_MISMATCH', message: expect.stringContaining('gives a context limit of 300000; opus\'s is 200000') })
    // The test saw a larger size lose. A smaller one in the same file is another case.
    writeFileSync(settings, JSON.stringify({ autoCompactWindow: 150000 }))
    expect(check('opus', argv, seen())).toMatchObject({ code: 'CONTEXT_MISMATCH', message: expect.stringContaining('cannot be resolved') })
    // So is another source: the same file's env entry, or another file, also one that plays the same part.
    writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '450000' } }))
    expect(check('opus', argv, seen())).toMatchObject({ code: 'CONTEXT_MISMATCH', detail: 'conflict', message: expect.stringContaining('cannot be resolved') })
    writeFileSync(settings, JSON.stringify({ autoCompactWindow: 450000 }))
    mkdirSync(join(workspace, '.claude'))
    writeFileSync(join(workspace, '.claude/settings.json'), JSON.stringify({ autoCompactWindow: 450000 }))
    expect(check('opus', argv, seen())).toMatchObject({ code: 'CONTEXT_MISMATCH', message: expect.stringContaining('cannot be resolved') })
    rmSync(join(workspace, '.claude'), { recursive: true })
    expect(check('opus', argv, seen(CLAUDE, `user settings at ${join(home, 'elsewhere/settings.json')}: autoCompactWindow`))).toMatchObject({ code: 'CONTEXT_MISMATCH', message: expect.stringContaining('cannot be resolved') })
    // And the same file playing another part: started in the home folder, a run reads the owner's settings a second time
    // as the folder's own, which no test saw.
    const fromHome = evaluate({ agent: 'opus', role: 'lead', workspace, data: 'private', cwd: home, argv } as Inputs, { environment: env, cwd: home, now: NOW, contextTestLog: seen() })
    expect(fromHome).toMatchObject({ code: 'CONTEXT_MISMATCH', detail: 'conflict' })
    // A test in which another source named a size the report could not tell from the one asked for settles nothing,
    // although the larger size was seen beside it: that other source may be the one the app obeyed.
    const blurred: ContextTestEntry[] = [{ ...seen()[0]!, rivals: [...seen()[0]!.rivals!, { source: 'settings above', id: 'settings above at /x/.claude/settings.json: autoCompactWindow', value: 138_000 }] }]
    expect(check('opus', argv, blurred)).toMatchObject({ code: 'CONTEXT_MISMATCH', detail: 'conflict' })
    // A size that is not a number is never settled by a test, and the refusal says it is that, not two sizes.
    writeFileSync(settings, JSON.stringify({ autoCompactWindow: 'lots' }))
    expect(check('opus', argv, seen())).toMatchObject({ code: 'CONTEXT_MISMATCH', detail: 'unresolved', message: expect.stringContaining('is not a whole number') })
    // The other reasons a limit is refused carry their own word too.
    rmSync(settings)
    expect(check('opus', OPUS(), seen())).toMatchObject({ code: 'CONTEXT_MISMATCH', detail: 'missing' })
    expect(check('opus', OPUS('CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000'), seen())).toMatchObject({ code: 'CONTEXT_MISMATCH', detail: 'differs' })
  })

  it('refuses a limit the app does not take, and keeps the refusal order', () => {
    approve(roster({ opus: 90_000 }))
    expect(check('opus', OPUS('CLAUDE_CODE_AUTO_COMPACT_WINDOW=90000'), [tested('claude', CLAUDE)])).toMatchObject({ code: 'CONTEXT_MISMATCH',
      message: 'opus\'s context limit 90000 cannot be applied: Claude Code takes 100 000 to 1 000 000 tokens' })
    const log = [tested('codex', CODEX)]
    // After the effort, before the destination.
    expect(check('sol', ['codex', 'exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=nope', '-'], log)).toMatchObject({ code: 'EFFORT_UNSUPPORTED' })
    expect(check('sol', SOL(), log, { ...env, OPENAI_BASE_URL: 'https://elsewhere.example.test/v1' })).toMatchObject({ code: 'CONTEXT_MISMATCH' })
    expect(check('sol', SOL('-c', 'model_context_window=272000'), log, { ...env, OPENAI_BASE_URL: 'https://elsewhere.example.test/v1' }).code).toMatch(/^HOST_/)
  })
})

function runCli(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : null, stdout, stderr })
    })
  })
}

function record(...entries: ContextTestEntry[]): void {
  mkdirSync(join(home, '.config/bmn/agents/state'), { recursive: true })
  writeFileSync(contextTestsPath(), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
}

describe('bmn roster role lists the items per candidate (60.9 AC2)', () => {
  it('gives no items before the test and the exact items after it', async () => {
    approve(roster({ opus: 200_000 }))
    const before = JSON.parse((await runCli(['roster', 'role', 'lead', '--json'])).stdout)
    expect(before.candidates.map((candidate: { agent: string; context: unknown }) => [candidate.agent, candidate.context])).toEqual([
      ['sol', { state: 'not-supported-yet', limit: 272_000, reason: 'the context setting is not tested on this Codex version (bmn context test codex)' }],
      ['opus', { state: 'not-supported-yet', limit: 200_000, reason: 'the context setting is not tested on this Claude Code version (bmn context test claude)' }]
    ])
    record(tested('codex', CODEX), tested('claude', CLAUDE))
    const after = JSON.parse((await runCli(['roster', 'role', 'lead', '--json'])).stdout)
    expect(after.candidates[0].context).toEqual({ state: 'applied', limit: 272_000, argv: ['-c', 'model_context_window=272000'], env: [] })
    expect(after.candidates[1].context).toEqual({ state: 'applied', limit: 200_000, argv: [], env: ['CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000'] })
    const text = (await runCli(['roster', 'role', 'lead'])).stdout
    expect(text).toMatch(/1\. sol@xhigh .* context-limit=272000\n/)
    const reviewers = JSON.parse((await runCli(['roster', 'role', 'epic-reviewer', '--json'])).stdout)
    expect(reviewers.candidates[0].context).toEqual({ state: 'app-default' })
    expect(reviewers.small_work.context).toEqual({ state: 'app-default' })
  })
})

/** The lines two texts do not share, so a test can say "only this line changed". */
function changed(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split('\n')
  const b = after.split('\n')
  return { removed: a.filter((line) => !b.includes(line)), added: b.filter((line) => !a.includes(line)) }
}

describe('config.toml edits leave every other byte alone (60.9 AC3)', () => {
  const FILE = [
    '# my settings', 'model = "gpt-6.1-sol"   # the default', '  model_context_window   =  380000   # big', 'notify = [', '  "a", # one', '  "b"', ']', 'note = """', 'model_context_window = 1', '"""', '',
    '# tables below', '[projects."/home/x"]', 'trust_level = "trusted"', 'model_context_window = 5', ''
  ].join('\n')

  it('replaces only the value of an existing key, keeping its indentation, spacing and comment', () => {
    const next = setTomlTopLevelKey(FILE, 'model_context_window', 272_000)
    expect(changed(FILE, next)).toEqual({ removed: ['  model_context_window   =  380000   # big'], added: ['  model_context_window   =  272000   # big'] })
    expect(readCodexContext(next)).toEqual({ limit: 272_000, compact: null, unreadable: null })
  })

  it('adds a missing key after the last top-level value and before the first table', () => {
    const next = setTomlTopLevelKey(FILE, 'model_auto_compact_token_limit', 300_000)
    expect(changed(FILE, next)).toEqual({ removed: [], added: ['model_auto_compact_token_limit = 300000'] })
    expect(next.indexOf('model_auto_compact_token_limit')).toBeGreaterThan(next.indexOf('"""\n'))
    expect(next.indexOf('model_auto_compact_token_limit')).toBeLessThan(next.indexOf('# tables below'))
    expect(readCodexContext(next)).toEqual({ limit: 380_000, compact: 300_000, unreadable: null })
    expect(setTomlTopLevelKey('', 'model_context_window', 1000)).toBe('model_context_window = 1000\n')
    expect(setTomlTopLevelKey('[a]\nb = 1\n', 'model_context_window', 1000)).toBe('model_context_window = 1000\n[a]\nb = 1\n')
    expect(setTomlTopLevelKey('model = "x"', 'model_context_window', 1000)).toBe('model = "x"\nmodel_context_window = 1000\n')
    expect(setTomlTopLevelKey('model = "x"\r\n', 'model_context_window', 1000)).toBe('model = "x"\r\nmodel_context_window = 1000\r\n')
  })

  it('removes only the key\'s own line, and nothing when the key is not there', () => {
    const next = setTomlTopLevelKey(FILE, 'model_context_window', null)
    expect(changed(FILE, next)).toEqual({ removed: ['  model_context_window   =  380000   # big'], added: [] })
    expect(next).toContain('[projects."/home/x"]\ntrust_level = "trusted"\nmodel_context_window = 5\n')
    expect(setTomlTopLevelKey(FILE, 'model_auto_compact_token_limit', null)).toBe(FILE)
  })

  it('refuses a key written twice or over several lines, and names a value it cannot read', () => {
    expect(() => setTomlTopLevelKey('model_context_window = 1\nmodel_context_window = 2\n', 'model_context_window', 3)).toThrow(/more than once/)
    expect(() => setTomlTopLevelKey('model_context_window = [\n 1\n]\n', 'model_context_window', 3)).toThrow(/several lines/)
    expect(readCodexContext('model_context_window = "many"\n')).toMatchObject({ limit: null, unreadable: 'config.toml model_context_window is not a whole number' })
    expect(readCodexContext('model_context_window = 1\nmodel_context_window = 2\n').unreadable).toMatch(/more than once/)
    expect(readCodexContext(null)).toEqual({ limit: null, compact: null, unreadable: null })
  })
})

describe('settings.json edits leave every other byte alone (60.9 AC3)', () => {
  const FILE = '{\n    "model": "opus",\n    "env": {\n        "A_FIRST": "1",\n        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "300000",\n        "Z_LAST": "{not, json}"\n    },\n    "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo \\"}\\""}]}]},\n    "big": 18446744073709551615\n}\n'
  const KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

  it('replaces only the entry\'s value', () => {
    const next = setJsonEnvEntry(FILE, KEY, 200_000)
    expect(changed(FILE, next)).toEqual({ removed: ['        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "300000",'], added: ['        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000",'] })
    expect(next).toContain('"big": 18446744073709551615')
    expect(readClaudeContext(next)).toEqual({ limit: 200_000, compact: null, unreadable: null })
  })

  it('adds the entry at the end of env in the file\'s own indentation, or an env object when there is none', () => {
    const without = FILE.replace('        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "300000",\n', '')
    const added = setJsonEnvEntry(without, KEY, 200_000)
    expect(changed(without, added)).toEqual({ removed: ['        "Z_LAST": "{not, json}"'], added: ['        "Z_LAST": "{not, json}",', '        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"'] })
    const bare = '{\n\t"model": "opus"\n}\n'
    expect(setJsonEnvEntry(bare, KEY, 200_000)).toBe('{\n\t"model": "opus",\n\t"env": {\n\t\t"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"\n\t}\n}\n')
    expect(setJsonEnvEntry('{"model":"opus"}', KEY, 200_000)).toBe('{"model":"opus", "env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"}}')
    expect(setJsonEnvEntry('{\n  "env": {}\n}\n', KEY, 200_000)).toBe('{\n  "env": {\n    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"\n  }\n}\n')
    expect(setJsonEnvEntry('{}', KEY, 200_000)).toBe('{"env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"}}')
    expect(JSON.parse(setJsonEnvEntry('', KEY, 200_000))).toEqual({ env: { [KEY]: '200000' } })
  })

  it('removes only the entry, wherever it sits', () => {
    const middle = setJsonEnvEntry(FILE, KEY, null)
    expect(changed(FILE, middle)).toEqual({ removed: ['        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "300000",'], added: [] })
    const last = '{\n  "env": {\n    "A": "1",\n    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1"\n  },\n  "x": 1\n}\n'
    expect(setJsonEnvEntry(last, KEY, null)).toBe('{\n  "env": {\n    "A": "1"\n  },\n  "x": 1\n}\n')
    const first = '{\n  "env": {\n    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1",\n    "A": "1"\n  }\n}\n'
    expect(setJsonEnvEntry(first, KEY, null)).toBe('{\n  "env": {\n    "A": "1"\n  }\n}\n')
    expect(setJsonEnvEntry('{"env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1"}, "x": 1}', KEY, null)).toBe('{"env": {}, "x": 1}')
    expect(setJsonEnvEntry('{"x": 1}', KEY, null)).toBe('{"x": 1}')
  })

  it('refuses a file it cannot follow rather than rewrite it', () => {
    expect(() => setJsonEnvEntry('{ nope', KEY, 1)).toThrow(/not valid JSON/)
    expect(() => setJsonEnvEntry('[]', KEY, 1)).toThrow(/not a JSON object/)
    expect(() => setJsonEnvEntry('{"env": []}', KEY, 1)).toThrow(/env is not an object/)
    expect(() => setJsonEnvEntry('{"env": {}, "env": {}}', KEY, 1)).toThrow(/more than once/)
    expect(readClaudeContext('{"env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "lots"}}').unreadable).toMatch(/not a whole number/)
  })
})

describe('changing the default for the owner\'s own sessions (60.9 AC3)', () => {
  const options = (harness: string, version: string) => ({ environment: env, version, tests: [tested(harness, version)], now: NOW })

  it('writes nothing for an app whose setting is not proven on the installed version', () => {
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex/config.toml'), 'model = "x"\n')
    expect(() => planContextDefault('codex', { limit: 272_000 }, { environment: env, version: CODEX, tests: [] })).toThrow(/not tested on Codex 0\.161\.0 yet/)
    expect(() => planContextDefault('codex', { limit: 272_000 }, { environment: env, version: '0.162.0', tests: [tested('codex', CODEX)] })).toThrow(/not tested on Codex 0\.162\.0 yet/)
    expect(() => planContextDefault('codex', { limit: 272_000, compact: 200_000 }, options('codex', CODEX))).toThrow(/not supported yet/)
    expect(() => planContextDefault('opencode', { limit: 1 }, { environment: env })).toThrow(/no context setting for OpenCode/)
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe('model = "x"\n')
    expect(contextDefault('codex', { environment: env, version: CODEX, tests: [] })).toMatchObject({ limit: null, proven: { limit: false, compact: false }, exists: true })
  })

  it('shows the diff first, then writes exactly that, keeping the earlier bytes and the file\'s mode', () => {
    mkdirSync(join(home, '.codex'))
    const path = join(home, '.codex/config.toml')
    writeFileSync(path, '# mine\nmodel_context_window = 380000\n\n[projects."/x"]\ntrust_level = "trusted"\n', { mode: 0o640 })
    const plan = planContextDefault('codex', { limit: 272_000 }, options('codex', CODEX))
    expect(plan).toMatchObject({ path, change: 'edit', limit: 272_000 })
    expect(plan.diff).toContain('-model_context_window = 380000\n+model_context_window = 272000')
    expect(readFileSync(path, 'utf8')).toContain('380000')
    const done = applyContextDefault('codex', { limit: 272_000 }, plan.plan_hash, options('codex', CODEX))
    expect(done).toMatchObject({ written: true, backup: `${path}.bmn-backup-${NOW.toISOString()}` })
    expect(readFileSync(path, 'utf8')).toBe('# mine\nmodel_context_window = 272000\n\n[projects."/x"]\ntrust_level = "trusted"\n')
    expect(statSync(path).mode & 0o777).toBe(0o640)
    expect(readFileSync(done.backup as string, 'utf8')).toContain('380000')
    expect(contextDefault('codex', options('codex', CODEX))).toMatchObject({ limit: 272_000, compact: null, proven: { limit: true } })
    // Back to Codex's own default: the key goes, nothing else.
    const off = planContextDefault('codex', { limit: null }, options('codex', CODEX))
    applyContextDefault('codex', { limit: null }, off.plan_hash, { ...options('codex', CODEX), now: new Date(NOW.getTime() + 1000) })
    expect(readFileSync(path, 'utf8')).toBe('# mine\n\n[projects."/x"]\ntrust_level = "trusted"\n')
  })

  it('never writes or removes the compaction key while compaction is unproven, even when the limit is cleared (60.9 AC1)', () => {
    mkdirSync(join(home, '.codex'))
    const path = join(home, '.codex/config.toml')
    writeFileSync(path, '# mine\nmodel_context_window = 380000\nmodel_auto_compact_token_limit = 200000\n')
    // The limit is proven on this version; where Codex starts summarising is not.
    const off = planContextDefault('codex', { limit: null }, options('codex', CODEX))
    expect(off.diff).toContain('-model_context_window = 380000')
    expect(off.diff).not.toContain('-model_auto_compact_token_limit')
    applyContextDefault('codex', { limit: null }, off.plan_hash, options('codex', CODEX))
    expect(readFileSync(path, 'utf8')).toBe('# mine\nmodel_auto_compact_token_limit = 200000\n')
    // A new limit leaves it too.
    const on = planContextDefault('codex', { limit: 272_000 }, options('codex', CODEX))
    applyContextDefault('codex', { limit: 272_000 }, on.plan_hash, { ...options('codex', CODEX), now: new Date(NOW.getTime() + 1000) })
    expect(readFileSync(path, 'utf8')).toContain('model_auto_compact_token_limit = 200000\n')
    expect(readFileSync(path, 'utf8')).toContain('model_context_window = 272000')
    // Once its own test passed, the key is BMN's to write and to take out with the limit.
    const both = { environment: env, version: CODEX, tests: [{ ...tested('codex', CODEX), compact: 'pass' as const }], now: new Date(NOW.getTime() + 2000) }
    const cleared = planContextDefault('codex', { limit: null }, both)
    applyContextDefault('codex', { limit: null }, cleared.plan_hash, both)
    expect(readFileSync(path, 'utf8')).toBe('# mine\n')
  })

  it('refuses when the file changed after the diff was shown, or the request is not the one shown', () => {
    mkdirSync(join(home, '.claude'))
    const path = join(home, '.claude/settings.json')
    writeFileSync(path, '{\n  "model": "opus"\n}\n')
    const plan = planContextDefault('claude', { limit: 200_000 }, options('claude', CLAUDE))
    expect(plan.diff).toContain('+    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"')
    expect(() => applyContextDefault('claude', { limit: 300_000 }, plan.plan_hash, options('claude', CLAUDE))).toThrow(/changed since it was shown/)
    writeFileSync(path, '{\n  "model": "sonnet"\n}\n')
    expect(() => applyContextDefault('claude', { limit: 200_000 }, plan.plan_hash, options('claude', CLAUDE))).toThrow(/changed since it was shown/)
    expect(readFileSync(path, 'utf8')).toBe('{\n  "model": "sonnet"\n}\n')
    // Changed between the last look and the write itself.
    const again = planContextDefault('claude', { limit: 200_000 }, options('claude', CLAUDE))
    expect(() => applyContextDefault('claude', { limit: 200_000 }, again.plan_hash, { ...options('claude', CLAUDE), beforeCommit: () => writeFileSync(path, '{}\n') })).toThrow(/changed while BMN was reading it/)
    expect(readFileSync(path, 'utf8')).toBe('{}\n')
    expect(readdirSync(join(home, '.claude')).filter((name) => name.includes('bmn-backup'))).toEqual([])
  })

  it('creates a missing file, replaces a link by a regular file and never writes through it', () => {
    const created = planContextDefault('claude', { limit: 200_000 }, options('claude', CLAUDE))
    expect(created.change).toBe('new file')
    applyContextDefault('claude', { limit: 200_000 }, created.plan_hash, options('claude', CLAUDE))
    expect(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))).toEqual({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' } })
    mkdirSync(join(home, 'dotfiles'))
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, 'dotfiles/config.toml'), 'model = "x"\n')
    symlinkSync(join(home, 'dotfiles/config.toml'), join(home, '.codex/config.toml'))
    const linked = planContextDefault('codex', { limit: 272_000 }, options('codex', CODEX))
    expect(linked.link_target).toBe(join(home, 'dotfiles/config.toml'))
    applyContextDefault('codex', { limit: 272_000 }, linked.plan_hash, options('codex', CODEX))
    expect(() => readlinkSync(join(home, '.codex/config.toml'))).toThrow()
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe('model = "x"\nmodel_context_window = 272000\n')
    expect(readFileSync(join(home, 'dotfiles/config.toml'), 'utf8')).toBe('model = "x"\n')
  })

  it('refuses sizes the app does not take and a compaction point it cannot move out of the way', () => {
    expect(() => planContextDefault('claude', { limit: 50_000 }, options('claude', CLAUDE))).toThrow(/Claude Code takes 100 000 to 1 000 000 tokens/)
    expect(() => planContextDefault('claude', { limit: 200_000, compact: 150_000 }, options('claude', CLAUDE))).toThrow(/not supported yet/)
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex/config.toml'), 'model_context_window = 380000\nmodel_auto_compact_token_limit = 342000\n')
    expect(() => planContextDefault('codex', { limit: 300_000 }, options('codex', CODEX))).toThrow(/starts summarising at 342 000, which is not below 300 000/)
    // With the compaction setting proven, BMN moves both.
    const both = { environment: env, version: CODEX, tests: [tested('codex', CODEX, 'pass', 'pass')], now: NOW }
    const plan = planContextDefault('codex', { limit: 300_000, compact: 250_000 }, both)
    applyContextDefault('codex', { limit: 300_000, compact: 250_000 }, plan.plan_hash, both)
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe('model_context_window = 300000\nmodel_auto_compact_token_limit = 250000\n')
    expect(() => planContextDefault('codex', { limit: 300_000, compact: 300_000 }, both)).toThrow(/must be below the context limit/)
  })

  it('answers bmn context check and set from the command line', async () => {
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex/config.toml'), 'model_context_window = 380000\n')
    const check = JSON.parse((await runCli(['context', 'check', '--json'])).stdout)
    expect(check.apps.map((row: { harness: string; limit: number | null; version: string; proven: { limit: boolean } }) => [row.harness, row.limit, row.version, row.proven.limit]))
      .toEqual([['codex', 380_000, CODEX, false], ['claude', null, CLAUDE, false]])
    const refused = await runCli(['context', 'set', 'codex', '--limit', '272000', '--yes'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toMatch(/NOT_SUPPORTED_YET/)
    record(tested('codex', CODEX))
    const plan = JSON.parse((await runCli(['context', 'set', 'codex', '--limit', '272000', '--plan', '--json'])).stdout)
    expect(plan).toMatchObject({ code: 'OK', change: 'edit' })
    expect(plan).not.toHaveProperty('next')
    // Without a terminal and without --yes nothing is written.
    const unconfirmed = await runCli(['context', 'set', 'codex', '--limit', '272000'])
    expect(unconfirmed.code).toBe(1)
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe('model_context_window = 380000\n')
    const stale = await runCli(['context', 'set', 'codex', '--limit', '272000', '--expect-plan', 'f'.repeat(64), '--yes', '--json'])
    expect(stale.code).toBe(7)
    const written = await runCli(['context', 'set', 'codex', '--limit', '272000', '--expect-plan', plan.plan_hash, '--yes', '--json'])
    expect(written.code, written.stderr).toBe(0)
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe('model_context_window = 272000\n')
  })
})

describe('the owner-run test, against stub apps (60.9 AC1)', () => {
  const codexStub = (window: number | null) => [
    'if [ "$1" = "--version" ]; then echo "codex-cli 0.161.0"; exit 0; fi',
    'dir=""; prev=""', 'for a in "$@"; do [ "$prev" = "-C" ] && dir="$a"; prev="$a"; done',
    'printf "%s\\n" "$@" > "$HOME/codex-args"', 'cat > "$HOME/codex-stdin"', 'ls -A "$dir" > "$HOME/codex-folder"',
    ...(window === null ? [] : ['mkdir -p "$HOME/.codex/sessions/2026/10/10"',
      `printf '{"payload":{"cwd":"%s"}}\\n{"type":"event_msg","payload":{"type":"task_started","model_context_window":${window}}}\\n' "$dir" > "$HOME/.codex/sessions/2026/10/10/rollout-test.jsonl"`])
  ].join('\n')

  it('records pass when Codex\'s session record shows the size that was asked for, less what Codex keeps back', async () => {
    stub('codex', codexStub(Math.floor(CONTEXT_TEST_SIZE.codex * 0.95)))
    const result = await testContext('codex', { environment: env, now: NOW })
    expect(result).toMatchObject({ harness: 'codex', version: CODEX, limit: 'pass', compact: 'untested', asked: 123_000, observed: 116_850 })
    // Which other source named a size is kept for Claude Code only: Codex's order is known from its own rules.
    expect(result).not.toHaveProperty('rivals')
    const args = readFileSync(join(home, 'codex-args'), 'utf8').split('\n')
    expect(args).toContain('model_context_window=123000')
    expect(args).toContain('read-only')
    expect(readFileSync(join(home, 'codex-stdin'), 'utf8')).toBe('Reply with the single word OK.')
    // An empty folder under the home folder, gone afterwards.
    expect(readFileSync(join(home, 'codex-folder'), 'utf8')).toBe('')
    const folder = args[args.indexOf('-C') + 1] as string
    expect(folder.startsWith(`${home}/.bmn-context-test-`)).toBe(true)
    expect(existsSync(folder)).toBe(false)
    expect(contextTests()).toEqual([result])
    expect(statSync(contextTestsPath()).mode & 0o777).toBe(0o600)
    expect(provenControls('codex', CODEX)).toEqual({ limit: true, compact: false })
  })

  it('records fail, inconclusive or unavailable when the proof is not there', async () => {
    stub('codex', codexStub(258_400))
    expect(await testContext('codex', { environment: env, now: NOW })).toMatchObject({ limit: 'fail', observed: 258_400 })
    expect(provenControls('codex', CODEX).limit).toBe(false)
    rmSync(join(home, '.codex'), { recursive: true })
    stub('codex', codexStub(null))
    expect(await testContext('codex', { environment: env, now: NOW })).toMatchObject({ limit: 'inconclusive', detail: 'no session record of the test run was found' })
    stub('codex', 'if [ "$1" = "--version" ]; then echo "codex-cli 0.161.0"; exit 0; fi\nexit 3')
    expect(await testContext('codex', { environment: env, now: NOW })).toMatchObject({ limit: 'inconclusive' })
    rmSync(join(stubs, 'codex'))
    expect(await testContext('codex', { environment: env, now: NOW })).toMatchObject({ limit: 'unavailable', version: null })
    expect(contextTests()).toHaveLength(4)
  })

  it('reads Claude Code\'s own context report for the size', async () => {
    const claudeStub = (line: string) => `if [ "$1" = "--version" ]; then echo "2.1.295 (Claude Code)"; exit 0; fi\ncat > "$HOME/claude-stdin"\necho "$CLAUDE_CODE_AUTO_COMPACT_WINDOW" > "$HOME/claude-env"\nprintf '%s\\n' '## Context Usage' '' '${line}'`
    stub('claude', claudeStub('**Tokens:** 12.4k / 137k (9%)'))
    expect(await testContext('claude', { environment: env, now: NOW })).toMatchObject({ harness: 'claude', version: CLAUDE, limit: 'pass', asked: 137_000, observed: 137_000 })
    expect(readFileSync(join(home, 'claude-stdin'), 'utf8')).toBe('/context')
    expect(readFileSync(join(home, 'claude-env'), 'utf8').trim()).toBe('137000')
    stub('claude', claudeStub('**Tokens:** 12.4k / 200k (6%)'))
    expect(await testContext('claude', { environment: env, now: NOW })).toMatchObject({ limit: 'fail', observed: 200_000 })
    stub('claude', claudeStub('nothing to see'))
    expect(await testContext('claude', { environment: env, now: NOW })).toMatchObject({ limit: 'inconclusive' })
    expect(provenControls('claude', CLAUDE).limit).toBe(false)
  })

  it('keeps which of the owner\'s files named another size for the test run, so a pass shows the run\'s own value wins', async () => {
    const claudeStub = (line: string) => `if [ "$1" = "--version" ]; then echo "2.1.295 (Claude Code)"; exit 0; fi\ncat > /dev/null\nprintf '%s\\n' '${line}'`
    stub('claude', claudeStub('**Tokens:** 12.4k / 137k (9%)'))
    // No file names a size: nothing to win over.
    expect(await testContext('claude', { environment: env, now: NOW })).toMatchObject({ limit: 'pass', rivals: [], detail: 'asked for 137000; Claude Code reports a window of 137000' })
    expect(provenPrecedence('claude', CLAUDE)).toEqual([])
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ autoCompactWindow: 450000, env: { OTHER: 'kept' } }))
    const seen = await testContext('claude', { environment: env, now: NOW })
    const id = `user settings at ${join(home, '.claude/settings.json')}: autoCompactWindow`
    expect(seen).toMatchObject({ limit: 'pass', observed: 137_000, rivals: [{ source: 'user settings autoCompactWindow', id, value: 450_000 }],
      detail: 'asked for 137000 while user settings autoCompactWindow says 450000; Claude Code reports a window of 137000, so the run\'s own value wins' })
    expect(provenPrecedence('claude', CLAUDE)).toEqual([{ id, side: 'above' }])
    expect(provenControls('claude', CLAUDE)).toEqual({ limit: true, compact: false })
    // The app took the file's size instead: a fail, and no proof.
    stub('claude', claudeStub('**Tokens:** 12.4k / 450k (3%)'))
    expect(await testContext('claude', { environment: env, now: NOW })).toMatchObject({ limit: 'fail', observed: 450_000, rivals: [{ source: 'user settings autoCompactWindow', id, value: 450_000 }],
      detail: 'asked for 137000 while user settings autoCompactWindow says 450000, but Claude Code reports a window of 450000' })
    expect(provenPrecedence('claude', CLAUDE)).toEqual([])
    // A file that names the size asked for, or one the rounded report cannot tell from it, would make the report read
    // the same whichever source the app obeyed. The test says so and does not start the app.
    const started = join(home, 'claude-started')
    stub('claude', `if [ "$1" = "--version" ]; then echo "2.1.295 (Claude Code)"; exit 0; fi\ntouch '${started}'\ncat > /dev/null\nprintf '%s\\n' '**Tokens:** 12.4k / 138k (9%)'`)
    for (const size of [137_000, 138_000, 136_000]) {
      writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ autoCompactWindow: size }))
      const unclear = await testContext('claude', { environment: env, now: NOW })
      expect(unclear).toMatchObject({ limit: 'inconclusive', observed: null,
        detail: `user settings autoCompactWindow says ${size}, which the app's report could not tell from the 137000 this test asks for; the test can show nothing while that is so` })
      expect(unclear).not.toHaveProperty('rivals')
    }
    expect(existsSync(started)).toBe(false)
    expect(provenPrecedence('claude', CLAUDE)).toEqual([])
    expect(provenControls('claude', CLAUDE).limit).toBe(false)
    // So with a second, clearly different source beside it: nothing is shown about either.
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ autoCompactWindow: 450000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '138000' } }))
    expect(await testContext('claude', { environment: env, now: NOW })).toMatchObject({ limit: 'inconclusive' })
    expect(existsSync(started)).toBe(false)
  })

  it('reads the two reports it relies on', () => {
    expect(claudeReportedWindow('**Model:** opus\n**Tokens:** 1,204 / 137,000 (1%)')).toBe(137_000)
    expect(claudeReportedWindow('**Tokens:** 0.9k / 1M (0%)')).toBe(1_000_000)
    expect(claudeReportedWindow('Tokens: 1 / 2')).toBeNull()
    expect(codexRecordedWindow('{"model_context_window":100}\n{"a":{"model_context_window": 116850}}')).toBe(116_850)
    expect(codexRecordedWindow('{}')).toBeNull()
  })
})
