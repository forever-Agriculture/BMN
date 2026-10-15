// MODULE: agents-team-run.test.ts - Stories 72.3, 72.9: an ask started exactly as judged, in its app's own read-only mode and a systemd user scope of its own that Stop, the time limit and the supervisor's death end whole; attributed from its own output with its sub-agents named and counted once, any credential masked, the project's state at both ends, finished into its record and exported by its allowlist; stand-in apps written in sh, a synthetic team, made-up sign-in files; no provider is reached
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ASK_RUN_FILES } from '../../bin/agents-team-forms.mjs'
import { prepareAsk } from '../../bin/agents-team-ask.mjs'
import { StartRefusal, askOutcome, exportAsk, finishAsk, observeAsk, startAsk, stopAsk, waitAsk } from '../../bin/agents-team-run.mjs'
import { SCOPE_OPTIONS, SCOPE_WRAPPER, SYSTEMD_RUN, runState, startTeamSupervisor } from '../../bin/agents-team-supervisor.mjs'
import { appAskExport } from '../../bin/agents-team-app.mjs'
import { AskRefusal } from '../../bin/agents-team-resolve.mjs'
import { askJson } from '../../bin/agents-team-cli.mjs'
import { recordInterrupted } from '../../bin/agents-team-places.mjs'
import {
  ANSWER_KEY, CODEX_CHILD, CODEX_STRANGER, ENV_SENTINEL, EXAMPLE, SCOPES, SIGN_IN_SENTINEL, approve as harnessApprove, leftovers as harnessLeftovers, ownSystemd, scopeGone, settle,
  stubCodex as harnessStubCodex, teamAskHome
} from './test-fixtures/team-ask-harness'

const CLI = fileURLToPath(new URL('../../bin/agents-team-cli.mjs', import.meta.url))

let home: string
let stubs: string
let env: Record<string, string>
const savedHome = process.env.HOME
const approve = (text: string): void => harnessApprove(home, text)
const stubCodex = (): void => harnessStubCodex(stubs)
const leftovers = (): string[] => harnessLeftovers(home)

const ask = (request: Partial<Parameters<typeof prepareAsk>[0]>) => prepareAsk({ role: 'epic-reviewer', question: 'Is the loop bounded?', ...request }, { environment: env, cwd: home, home })
const git = (root: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=made-up', '-c', 'user.email=made-up@example.test', ...args], { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null' } })
/** A small synthetic project with one commit, made once per test. */
const projectRoot = (): string => {
  const root = join(home, 'code/app')
  if (existsSync(join(root, '.git'))) return root
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'test: one')
  return root
}
const projectAsk = (fields: Partial<Parameters<typeof prepareAsk>[0]> = {}) => ask({ project: projectRoot(), ...fields })
const stateOf = (folder: string): { scope?: { unit: string; cgroup: string }; [key: string]: unknown } => {
  try {
    return JSON.parse(readFileSync(join(folder, 'state.json'), 'utf8'))
  } catch {
    // Not written yet.
    return {}
  }
}
/** The cgroup a process is in now, or undefined once it is gone. */
const cgroupOf = (pid: number): string | undefined => {
  try {
    return `/sys/fs/cgroup${readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().replace(/^0::/u, '')}`
  } catch {
    return undefined
  }
}
const rewrite = (folder: string, change: (launch: Record<string, unknown>) => Record<string, unknown>): void => {
  writeFileSync(join(folder, 'launch.json'), JSON.stringify(change(JSON.parse(readFileSync(join(folder, 'launch.json'), 'utf8')))))
}
/** A start that only writes the launch: the test starts the supervisor itself, after changing what it reads. */
const noStart = () => ({ pid: 1, start: '1' })

beforeEach(() => {
  ({ home, stubs, env } = teamAskHome('bmn-team-run-'))
})

afterEach(async () => {
  await settle(() => leftovers().length === 0, 5000)
  process.env.HOME = savedHome
  if (process.env.BMN_TEST_KEEP_HOME === undefined) rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!SCOPES)('an ask run in its app\'s own read-only mode, in a systemd user scope of its own (72.3, 72.9)', { timeout: 30_000 }, () => {
  it('answers in an empty folder of the run\'s own when there is no project, attributed from its own output, usage counted by its stated basis, in a scope named for the run that is gone at the end (72.9 AC4, AC5)', async () => {
    const prepared = ask({})
    expect(prepared.verdict.verdict).toBe('PASS')
    expect(prepared.cwd).toBe(join(prepared.folder, 'work'))
    // Codex's own read-only sandbox in the owner's own home: no container, copy, home or sign-in of BMN's, and nothing of the asker's environment.
    expect(prepared.argv.slice(0, 2)).toEqual(['/usr/bin/env', '-i'])
    expect(prepared.argv).toContain(`HOME=${home}`)
    expect(prepared.argv).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only', '-C', prepared.cwd, '--json']))
    expect(prepared.argv.join(' ')).not.toContain(ENV_SENTINEL)
    const started = startAsk(prepared, { timeLimitMinutes: 2 })
    expect(started.pid).toBeGreaterThan(0)
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    expect(outcome).toMatchObject({
      state: 'answered', exit: 0, subagents: [],
      observed: { session_source: 'thread.started', model: 'gpt-6-astra', model_source: 'turn span', effort: 'medium', effort_source: 'turn span' },
      usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5, reasoning_tokens: 2, reported_cost: 'unknown', source: 'turn.completed', complete: true, aggregation: expect.stringContaining('each counted once') }
    })
    expect(outcome.observed.session).toMatch(/^[0-9a-f]{8}-0000-7000-8000-000000000000$/)
    expect(readFileSync(join(prepared.folder, ASK_RUN_FILES.answer), 'utf8')).toMatch(new RegExp(`^codex answer [0-9a-f]{8} in ${prepared.cwd}\\n$`, 'u'))
    const state = stateOf(prepared.folder)
    expect(state.scope).toEqual({ unit: `bmn-ask-${prepared.id}.scope`, cgroup: expect.stringMatching(new RegExp(`/bmn-ask-${prepared.id}\\.scope$`, 'u')) })
    await settle(() => scopeGone(state.scope?.cgroup))
    expect(scopeGone(state.scope?.cgroup)).toBe(true)
    // Codex's last message and the app's status file are transient: gone with the run.
    expect(readdirSync(prepared.folder).sort()).toEqual(['answer.md', 'events.jsonl', 'exit.json', 'inputs', 'launch.json', 'outcome.json', 'question.md', 'receipt.json', 'request.json', 'snapshots', 'state.json', 'stderr.txt', 'work'])
    expect(JSON.parse(readFileSync(join(prepared.folder, 'launch.json'), 'utf8'))).toMatchObject({ cwd: prepared.cwd, argv: prepared.argv })
    expect(runState(prepared.folder).state).toBe('ended')
  })

  it('Claude Code: its read tools from the project, BMN\'s git first on its PATH, the session from system init, the effort from the pinned command, usage from modelUsage; the owner\'s rules stay in his own home (72.9 AC1, AC2)', async () => {
    const root = projectRoot()
    const prepared = ask({ role: 'designer', project: root })
    expect(prepared.cwd).toBe(root)
    expect(prepared.argv).toEqual(expect.arrayContaining(['--restricted', '--tools', 'Read,Grep,Glob,Bash,WebSearch,Agent', '--permission-mode', 'dontAsk', '--strict-mcp-config']))
    expect(prepared.argv.find((part) => part.startsWith('PATH='))).toMatch(new RegExp(`^PATH=${prepared.folder}/bin:`, 'u'))
    expect(existsSync(join(prepared.folder, ASK_RUN_FILES.bin, 'git'))).toBe(true)
    expect(prepared.verdict.receipt?.snapshots.git).toMatch(/^[0-9a-f]{64}$/u)
    // Codex and Claude Code read the owner's own rules where they keep them: BMN adds none.
    expect(existsSync(join(prepared.folder, ASK_RUN_FILES.rules))).toBe(false)
    expect(prepared.argv).not.toContain('--append-system-prompt')
    startAsk(prepared, { timeLimitMinutes: 2 })
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    expect(outcome).toMatchObject({
      state: 'answered', observed: { session_source: 'system init', model: 'claude-fable-5-1', effort: 'medium', effort_source: 'pinned command (--effort)' },
      usage: { input_tokens: 10, cached_input_tokens: 11, output_tokens: 4, reported_cost: 0.0123, billing: 'subscription', source: 'result.modelUsage', complete: true }
    })
    expect(readFileSync(join(prepared.folder, ASK_RUN_FILES.answer), 'utf8')).toContain(`rules=no in ${root}`)
    const commit = git(root, 'rev-parse', 'HEAD').trim()
    expect(outcome.project).toEqual({ root, start: { commit, clean: true, changed: 0, at: expect.any(String) }, end: { commit, clean: true, changed: 0, at: expect.any(String) } })
  })

  it('a model that contradicts the request, a second session, a thread no rollout names or no session at all is "answer not attributed", the answer kept only as evidence (AC2, 72.9 AC5)', async () => {
    const cases = [
      ['epic-reviewer', 'MISMATCH', 'the app ran gpt-6-other, not gpt-6-astra'],
      ['epic-reviewer', 'SECOND', 'the run named a session BMN cannot identify, ffffffff-0000-7000-8000-000000000000'],
      ['epic-reviewer', 'STRANGER', `the run named a session BMN cannot identify, ${CODEX_STRANGER}: no rollout names it a sub-agent of the teammate`],
      ['epic-reviewer', 'NOSESSION', 'the run named no session in its first event'],
      ['designer', 'SECOND', 'the run named a session BMN cannot identify, ffffffff-0000-4000-8000-000000000000']
    ] as const
    for (const [role, word, problem] of cases) {
      const prepared = ask({ role, question: `Is the loop bounded? ${word}` })
      startAsk(prepared, { timeLimitMinutes: 2 })
      const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
      expect(outcome, `${role} ${word}`).toMatchObject({ state: 'not-attributed', exit: 17 })
      expect(outcome.reason, `${role} ${word}`).toContain(problem)
      expect(existsSync(join(prepared.folder, ASK_RUN_FILES.answer))).toBe(false)
      expect(readFileSync(join(prepared.folder, 'diagnostic-answer.md'), 'utf8')).toMatch(/^(codex|claude) answer/u)
    }
  })

  it('a sub-agent the teammate started is named in the record and counted once: Codex\'s by its own rollout, Claude Code\'s inside the run\'s own total (72.9 AC2, AC5)', async () => {
    const codex = ask({ question: 'Is the loop bounded? SUBAGENT' })
    startAsk(codex, { timeLimitMinutes: 2 })
    const counted = await waitAsk(codex.folder, { timeoutMs: 20_000 })
    expect(counted).toMatchObject({
      state: 'answered', exit: 0,
      usage: { input_tokens: 140, cached_input_tokens: 14, output_tokens: 8, reasoning_tokens: 3, source: 'turn.completed and sub-agent rollouts', complete: true },
      subagents: [{
        session: CODEX_CHILD, parent: counted.observed.session, name: 'Ada', role: 'explorer', kind: 'Codex sub-agent', model: 'gpt-6-astra', effort: 'low',
        usage: { input_tokens: 40, cached_input_tokens: 4, output_tokens: 3, reasoning_tokens: 1 }, record: expect.stringContaining(join(home, '.codex/sessions'))
      }]
    })
    const claude = ask({ role: 'designer', question: 'Is the loop bounded? SUBAGENT' })
    startAsk(claude, { timeLimitMinutes: 2 })
    const total = await waitAsk(claude.folder, { timeoutMs: 20_000 })
    expect(total).toMatchObject({
      state: 'answered', exit: 0, usage: { input_tokens: 60, cached_input_tokens: 11, output_tokens: 10, reported_cost: 0.0123, source: 'result.modelUsage', complete: true },
      subagents: [{ session: 'task-1', parent: total.observed.session, name: 'read the tests', role: 'Explore', kind: 'Claude Code sub-agent', model: 'claude-made-up-helper', status: 'completed', own_tokens: 56, usage: 'counted in the run\'s total' }]
    })
    // `bmn team asks show` names them too.
    expect(askJson(codex.folder)).toMatchObject({ subagents: [{ session: CODEX_CHILD, name: 'Ada' }] })
  })

  it('two asks started together keep their own sessions, never swapped (AC2)', async () => {
    const one = ask({ question: 'First question?' })
    const two = ask({ question: 'Second question?' })
    startAsk(one, { timeLimitMinutes: 2 })
    startAsk(two, { timeLimitMinutes: 2 })
    const [first, second] = await Promise.all([waitAsk(one.folder, { timeoutMs: 20_000 }), waitAsk(two.folder, { timeoutMs: 20_000 })])
    const hash = (text: string): string => execFileSync('md5sum', { input: text, encoding: 'utf8' }).slice(0, 8)
    expect(first.observed.session).toBe(`${hash('First question?')}-0000-7000-8000-000000000000`)
    expect(second.observed.session).toBe(`${hash('Second question?')}-0000-7000-8000-000000000000`)
  })

  it('a failed app is "failed" with its words; the app\'s end, Stop and the time limit end every process it started, also one that left its group and ignores TERM (72.9 AC3, AC6)', async () => {
    const failed = ask({ question: 'Is it bounded? FAIL' })
    startAsk(failed, { timeLimitMinutes: 2 })
    expect(await waitAsk(failed.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'failed', exit: 1, reason: 'the app ended with code 3' })
    const stray = ask({ question: 'Is it bounded? STRAY' })
    startAsk(stray, { timeLimitMinutes: 2 })
    expect(await waitAsk(stray.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'answered', exit: 0 })
    const stopped = ask({ question: 'Is it bounded? STRAY SLEEP' })
    startAsk(stopped, { timeLimitMinutes: 2 })
    await settle(() => askOutcome(stopped.folder).state === 'running' && leftovers().some((line) => line.includes('stray of')))
    stopAsk(stopped.folder)
    expect(await waitAsk(stopped.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'stopped', exit: 16 })
    const late = ask({ question: 'Is it bounded? STRAY SLEEP' })
    startAsk(late, { timeLimitMinutes: 0.02 })
    expect(await waitAsk(late.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'out-of-time', exit: 15 })
    await settle(() => leftovers().length === 0)
    expect(leftovers()).toEqual([])
    for (const prepared of [failed, stray, stopped, late]) expect(scopeGone(stateOf(prepared.folder).scope?.cgroup)).toBe(true)
  })

  it('the supervisor\'s death ends its scope at once, and whoever looks next finishes the record as interrupted, never started again (72.9 AC6)', async () => {
    const prepared = ask({ question: 'Is it bounded? STRAY SLEEP' })
    const started = startAsk(prepared, { timeLimitMinutes: 2 })
    await settle(() => stateOf(prepared.folder).scope !== undefined && leftovers().some((line) => line.includes('stray of')))
    const cgroup = stateOf(prepared.folder).scope?.cgroup
    process.kill(started.pid, 'SIGKILL')
    // The kernel signals the scope's first process when the supervisor dies; it ends the scope.
    await settle(() => scopeGone(cgroup) && leftovers().length === 0)
    expect(leftovers()).toEqual([])
    expect(scopeGone(cgroup)).toBe(true)
    expect(askOutcome(prepared.folder)).toMatchObject({ state: 'interrupted', exit: null })
    recordInterrupted(prepared.folder, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
    // The record is finished as any run's: what its output showed, its usage and its basis, and its transient files gone.
    expect(askOutcome(prepared.folder)).toMatchObject({ state: 'interrupted', exit: 1, reason: expect.stringContaining('its supervisor ended'), observed: expect.any(Object), usage: { complete: false }, subagents: [] })
    expect(existsSync(join(prepared.folder, 'app-status'))).toBe(false)
  })

  it('the scope\'s first process starts nothing when the supervisor that started it died before its parent-death signal was set (72.9 AC6, full review)', async () => {
    const marker = join(home, 'app-started')
    const status = join(home, 'app-status')
    // In a scope of its own, as a run's: the outer shell plays the supervisor; it ends before the wrapper starts, and the wrapper's parent is then another process.
    const inScope = (script: string) => spawnSync(SYSTEMD_RUN, [...SCOPE_OPTIONS, '--', '/bin/sh', '-c', script, 'supervisor', SCOPE_WRAPPER, status, marker],
      { env: { PATH: '/usr/bin:/bin', ...ownSystemd() }, encoding: 'utf8', timeout: 10_000 })
    inScope('( sleep 0.3; exec /bin/sh -c "$1" bmn-ask $$ "$2" /usr/bin/touch "$3" ) & exit 0')
    await new Promise((done) => setTimeout(done, 1500))
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(status)).toBe(false)
    // The same start with the supervisor alive runs the app.
    inScope('( exec /bin/sh -c "$1" bmn-ask $$ "$2" /usr/bin/touch "$3" ); wait')
    await settle(() => existsSync(status))
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(status, 'utf8').trim()).toBe('0')
  })

  it('the app\'s arguments reach it as the check judged them: systemd-run expands none of them (72.9 AC4, consolidated repair)', () => {
    const said = spawnSync(SYSTEMD_RUN, [...SCOPE_OPTIONS, '--', '/bin/echo', '${HOME}', '$HOME', 'a$HOME', '$$'], { env: { PATH: '/usr/bin:/bin', HOME: home, ...ownSystemd() }, encoding: 'utf8', timeout: 10_000 })
    expect(said.stdout).toBe('${HOME} $HOME a$HOME $$\n')
  })

  it('a running ask is not exported, by the command or the app: its output is masked only when it ends (72.9 AC6, full review)', async () => {
    const prepared = ask({ question: 'Is it bounded? SLEEP' })
    startAsk(prepared, { timeLimitMinutes: 2 })
    await settle(() => stateOf(prepared.folder).scope !== undefined)
    expect(() => exportAsk(prepared.folder, join(home, 'early'))).toThrow(expect.objectContaining({ code: 'RUNNING', message: 'the ask is still running; export it once it has ended' }))
    const id = prepared.folder.split('/').pop() as string
    expect(() => appAskExport(id, home)).toThrow(AskRefusal)
    expect(existsSync(join(home, 'early'))).toBe(false)
    expect(existsSync(join(home, `bmn-ask-${id}`))).toBe(false)
    stopAsk(prepared.folder)
    await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    expect(exportAsk(prepared.folder, join(home, 'late'))).toEqual(expect.arrayContaining(['events.jsonl', 'outcome.json']))
  })

  it('a scope a dead supervisor left is found by the run\'s own unit: whoever looks next ends it; another run\'s scope is never touched (72.9 AC6)', async () => {
    const scope = (id: string) => {
      const started = spawn('/usr/bin/systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=bmn-ask-${id}`, '--', '/bin/sh', '-c', `trap '' TERM; sleep 30 # left of ${home}`],
        { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: home, ...ownSystemd() } })
      started.unref()
      return started
    }
    const orphaned = ask({ question: 'Is it bounded? SLEEP' })
    const id = orphaned.folder.split('/').pop() as string
    const other = `${id.slice(0, -8)}ffffffff`
    const ours = scope(id)
    const theirs = scope(other)
    try {
      await settle(() => cgroupOf(ours.pid as number)?.endsWith(`/bmn-ask-${id}.scope`) === true && cgroupOf(theirs.pid as number)?.endsWith(`/bmn-ask-${other}.scope`) === true, 5000)
      const [left, kept] = [cgroupOf(ours.pid as number), cgroupOf(theirs.pid as number)]
      expect(left).toMatch(new RegExp(`/bmn-ask-${id}\\.scope$`, 'u'))
      // Its state names a supervisor that is gone and no scope: the run's own unit is where it would be.
      writeFileSync(join(orphaned.folder, 'state.json'), JSON.stringify({ version: 1, state: 'running', supervisor: { pid: 999_999_999, start: '1' } }))
      expect(askOutcome(orphaned.folder).state).toBe('interrupted')
      recordInterrupted(orphaned.folder, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
      await settle(() => scopeGone(left), 3000)
      expect(scopeGone(left)).toBe(true)
      expect(scopeGone(kept)).toBe(false)
    } finally {
      for (const started of [ours, theirs]) {
        try {
          process.kill(started.pid as number, 'SIGKILL')
        } catch {
          // Already ended.
        }
      }
    }
  })

  it('closing the asking command only detaches it: the run goes on to its answer (AC3)', async () => {
    const child = spawn(process.execPath, ['-e', `import(${JSON.stringify(CLI)}).then((m) => m.runTeamAsk(['--role', 'epic-reviewer', '--question', 'Detached? NAP'])).then((code) => process.exit(code))`], {
      env: { ...env, PATH: `${stubs}:/usr/bin:/bin` }, cwd: home, stdio: ['ignore', 'pipe', 'pipe']
    })
    let said = ''
    child.stderr.on('data', (chunk: Buffer) => { said += chunk.toString() })
    await settle(() => said.includes('run '), 15_000)
    child.kill('SIGHUP')
    await new Promise((resolve) => child.on('exit', resolve))
    const id = /run (\d{8}T\d{6}-[0-9a-f]{8})/.exec(said)?.[1]
    expect(id).toBeDefined()
    const outcome = await waitAsk(join(home, '.config/bmn/agents/state/team/runs', id!), { timeoutMs: 20_000 })
    expect(outcome.state).toBe('answered')
  })

  it('a team change or a replaced program between the check and the start starts nothing (AC1)', () => {
    const team = ask({})
    approve(EXAMPLE.replace('PROSE-SENTINEL-PREAMBLE', 'PROSE-SENTINEL-PREAMBLE, changed'))
    expect(() => startAsk(team)).toThrow(StartRefusal)
    expect(() => startAsk(team)).toThrow(/the approved team changed after the check/)
    expect(existsSync(join(team.folder, 'launch.json'))).toBe(false)
    const program = ask({})
    stubCodex()
    expect(() => startAsk(program)).toThrow(/the app's program changed after the check; nothing started/)
    expect(existsSync(join(program.folder, 'launch.json'))).toBe(false)
  })

  it('a command, a folder, a prompt or BMN\'s git changed after the check starts nothing, also when the launch is changed before the supervisor reads it (epic review)', async () => {
    const argv = ask({})
    argv.argv.push('--extra')
    expect(() => startAsk(argv)).toThrow(/the command is not the one the check judged; nothing started/)
    const folder = ask({})
    folder.cwd = home
    expect(() => startAsk(folder)).toThrow(/the folder the app starts in is not the one the check judged; nothing started/)
    const prompt = ask({})
    writeFileSync(join(prompt.folder, ASK_RUN_FILES.prompt), 'Another question?\n')
    expect(() => startAsk(prompt)).toThrow(/the prompt is not the one the check judged; nothing started/)
    const wrapper = projectAsk({ role: 'designer' })
    writeFileSync(join(wrapper.folder, ASK_RUN_FILES.bin, 'git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n')
    expect(() => startAsk(wrapper)).toThrow(/BMN's git in the run is not the one the check judged; nothing started/)
    for (const prepared of [argv, folder, prompt, wrapper]) expect(existsSync(join(prepared.folder, 'launch.json'))).toBe(false)
    // Between the start and the supervisor: the supervisor checks the command and the prompt again.
    const late = ask({})
    startAsk(late, { timeLimitMinutes: 2, start: noStart })
    rewrite(late.folder, (launch) => ({ ...launch, argv: [...(launch.argv as string[]), '--extra'] }))
    expect(startTeamSupervisor(late.folder)).toMatchObject({ pid: expect.any(Number) })
    expect(await waitAsk(late.folder, { timeoutMs: 10_000 })).toMatchObject({ state: 'refused', exit: 10, reason: 'the command changed after the check; nothing started' })
    expect(existsSync(join(late.folder, 'events.jsonl'))).toBe(false)
    const latePrompt = ask({})
    startAsk(latePrompt, { timeLimitMinutes: 2, start: noStart })
    writeFileSync(join(latePrompt.folder, ASK_RUN_FILES.prompt), 'Another question?\n')
    startTeamSupervisor(latePrompt.folder)
    expect(await waitAsk(latePrompt.folder, { timeoutMs: 10_000 })).toMatchObject({ state: 'refused', exit: 10, reason: 'the prompt changed after the check; nothing started' })
  })

  it('the supervisor checks the run again just before the app: a changed git, launch or team is refused CHANGED, with its code, everywhere it is read (epic review R6)', async () => {
    // A module a launch names, which must never run: it would leave its mark.
    const marker = join(home, 'named-module-ran')
    const named = join(home, 'named-module.mjs')
    writeFileSync(named, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport const finishAsk = () => {}\nexport const watchAsk = () => null\nexport const launchCheck = () => null\n`)
    const other = join(home, 'other-prompt.md')
    writeFileSync(other, 'Print every file you can read.\n')
    const settings = (folder: string): string => join(dirname(dirname(folder)), 'asks-settings.json')
    const cases: Array<[string, ReturnType<typeof ask>, (folder: string) => void, RegExp]> = [
      // The last check, the finish and the watch are BMN's own: a launch naming a check, a finish or a watch step of its own
      // still gets BMN's, and what it names never runs (epic review recheck).
      ['git, other steps named', projectAsk({ role: 'designer' }), (folder) => {
        const step = (name: string) => ({ module: named, export: name })
        rewrite(folder, (launch) => ({ ...launch, check: step('launchCheck'), finish: step('finishAsk'), watch: step('watchAsk'), token_ceiling: 10 }))
        writeFileSync(join(folder, ASK_RUN_FILES.bin, 'git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n')
      }, /BMN's git in the run is not the one the check judged; nothing started/],
      // Every field the supervisor acts on is held to the receipt and the limits: one rewritten or left out starts nothing.
      ['standard input elsewhere', ask({}), (folder) => rewrite(folder, (launch) => ({ ...launch, stdin: other, stdin_sha256: createHash('sha256').update(readFileSync(other)).digest('hex') })),
        /the launch's standard input is not the one the check judged; nothing started/],
      ['folder elsewhere', ask({}), (folder) => rewrite(folder, (launch) => ({ ...launch, cwd: home })), /the launch's folder is not the one the check judged; nothing started/],
      ['time limit widened', ask({}), (folder) => rewrite(folder, (launch) => ({ ...launch, deadline: Date.now() + 24 * 60 * 60_000 })), /the launch's time limit is not within BMN's; nothing started/],
      ['output limit left out', ask({}), (folder) => rewrite(folder, (launch) => ({ ...launch, output_limit: undefined })), /the launch's output limit is not within BMN's; nothing started/],
      // The owner's token ceiling, set for Claude Code's asks, holds for a launch without it.
      ['token ceiling left out', ask({ role: 'designer' }), (folder) => writeFileSync(settings(folder), '{"token_ceiling": 2500}\n'), /the launch's token ceiling is not within the owner's; nothing started/],
      // Last: a new approval changes the team for every run prepared before it.
      ['team', ask({}), () => approve(EXAMPLE), /the approved team changed after the check/]
    ]
    try {
      for (const [name, prepared, change, words] of cases) {
        startAsk(prepared, { timeLimitMinutes: 2, start: noStart })
        change(prepared.folder)
        startTeamSupervisor(prepared.folder)
        const outcome = await waitAsk(prepared.folder, { timeoutMs: 10_000 })
        expect(outcome, name).toMatchObject({ state: 'refused', exit: 10, refusal: { code: 'CHANGED', reason: expect.stringMatching(words) } })
        expect(askJson(prepared.folder), name).toMatchObject({ state: 'refused', exit: 10, refusal: { code: 'CHANGED', reason: expect.stringMatching(words) } })
        expect(existsSync(join(prepared.folder, 'events.jsonl')), name).toBe(false)
        expect(existsSync(marker), name).toBe(false)
        rmSync(settings(prepared.folder), { force: true })
      }
    } finally {
      for (const [, prepared] of cases) rmSync(settings(prepared.folder), { force: true })
    }
  })

  it('Stop and the time limit are read again immediately before the app: a run stopped or out of time by then starts nothing (72.9 AC4)', async () => {
    const stopped = ask({})
    startAsk(stopped, { timeLimitMinutes: 2, start: noStart })
    stopAsk(stopped.folder)
    startTeamSupervisor(stopped.folder)
    expect(await waitAsk(stopped.folder, { timeoutMs: 10_000 })).toMatchObject({ state: 'stopped', exit: 16 })
    const late = ask({})
    startAsk(late, { timeLimitMinutes: 2, start: noStart })
    rewrite(late.folder, (launch) => ({ ...launch, deadline: Date.now() - 1000 }))
    startTeamSupervisor(late.folder)
    expect(await waitAsk(late.folder, { timeoutMs: 10_000 })).toMatchObject({ state: 'out-of-time', exit: 15 })
    for (const prepared of [stopped, late]) {
      expect(existsSync(join(prepared.folder, 'events.jsonl'))).toBe(false)
      expect(JSON.parse(readFileSync(join(prepared.folder, 'exit.json'), 'utf8'))).toMatchObject({ started: false })
      expect(stateOf(prepared.folder).scope).toBeUndefined()
    }
  })

  it('a supervisor that cannot reach a systemd user manager starts nothing of the app and says why (72.9 AC4)', async () => {
    const prepared = ask({ question: 'Is it bounded? STRAY' })
    startAsk(prepared, { timeLimitMinutes: 2, start: (folder: string) => startTeamSupervisor(folder, { environment: { HOME: home, PATH: '/usr/bin:/bin' } }) })
    expect(await waitAsk(prepared.folder, { timeoutMs: 15_000 })).toMatchObject({ state: 'failed', exit: 1, reason: expect.stringContaining('systemd scope could not start') })
    expect(JSON.parse(readFileSync(join(prepared.folder, 'exit.json'), 'utf8'))).toMatchObject({ started: false })
    expect(leftovers()).toEqual([])
  })

  it('a project ask records the commit and whether the tree was clean at the start and at the end (72.9 AC6)', async () => {
    const root = projectRoot()
    writeFileSync(join(root, 'notes.txt'), 'made-up notes\n')
    const prepared = ask({ project: root, question: 'Is it bounded? NAP' })
    startAsk(prepared, { timeLimitMinutes: 2 })
    await settle(() => existsSync(join(prepared.folder, ASK_RUN_FILES.projectStart)))
    // The owner goes on working while the teammate reads.
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2\n')
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    const commit = git(root, 'rev-parse', 'HEAD').trim()
    expect(outcome).toMatchObject({ state: 'answered', project: { root, start: { commit, clean: false, changed: 1 }, end: { commit, clean: false, changed: 2 } } })
    expect(askJson(prepared.folder)).toMatchObject({ project_state: { root, start: { clean: false }, end: { changed: 2 } } })
  })

  it('a credential in the answer is masked in the answer, the app\'s output, the export and what is shown, and the record says so; the export is the allowlist (72.9 AC6, AC4)', async () => {
    const prepared = projectAsk({ role: 'designer', question: 'Is it bounded? CREDANSWER' })
    startAsk(prepared, { timeLimitMinutes: 2 })
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    expect(outcome).toMatchObject({ state: 'answered', credentials_masked: { answer: ['an OpenAI key'], output: ['an OpenAI key'] } })
    expect(readFileSync(join(prepared.folder, ASK_RUN_FILES.answer), 'utf8')).toContain('key [credential masked by BMN: an OpenAI key]')
    expect(readFileSync(join(prepared.folder, 'events.jsonl'), 'utf8')).toContain('[credential masked by BMN: an OpenAI key]')
    const output = join(home, 'export')
    const files = exportAsk(prepared.folder, output)
    expect(files).toEqual(expect.arrayContaining(['request.json', 'receipt.json', 'outcome.json', 'answer.md', 'events.jsonl', 'launch.json', 'inputs/prompt.md', 'inputs/manifest.json', 'project-start.json', 'snapshots/executable.json']))
    expect(files.some((file) => file.startsWith('bin/') || file === 'stderr.txt')).toBe(false)
    const everything = files.map((file) => readFileSync(join(output, file), 'utf8')).join('\n')
    for (const kept of [SIGN_IN_SENTINEL, ENV_SENTINEL, ANSWER_KEY]) expect(everything).not.toContain(kept)
    const launch = JSON.parse(readFileSync(join(output, 'launch.json'), 'utf8'))
    expect(launch.argv.find((part: string) => part.startsWith('HOME='))).toBe('HOME=(not exported)')
    expect(JSON.stringify(askJson(prepared.folder))).not.toContain(ANSWER_KEY)
    expect(askJson(prepared.folder)).toMatchObject({ credentials_masked: { answer: ['an OpenAI key'] } })
    expect(() => exportAsk(prepared.folder, output)).toThrow(/already exists/)
  })
})

describe.skipIf(!SCOPES)('bmn team ask and bmn team asks (72.3 AC3, 72.9 AC4)', { timeout: 30_000 }, () => {
  const BMN = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
  const bmn = (args: string[], input = '', environment: Record<string, string> = { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, ...ownSystemd() }): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((done) => {
    const child = spawn(process.execPath, [BMN, ...args], { env: environment, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdin.end(input)
    child.on('exit', (code) => done({ code, stdout, stderr }))
  })

  it('the answer on standard output, progress on standard error with what the teammate\'s mode can read, the run listed, shown and exported', async () => {
    const asked = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question-file', '-'], 'Is the loop bounded?\n')
    expect(asked.code, asked.stderr).toBe(0)
    expect(asked.stdout).toMatch(/^codex answer [0-9a-f]{8} in \S+\/work\n$/u)
    expect(asked.stderr).toMatch(/^bmn: asked astra \(codex gpt-6-astra, medium; chosen by chain\) in \S+\/work; it can read any file your user can read, .*; run (\d{8}T\d{6}-[0-9a-f]{8}), key \d{8}-shell-[0-9a-f]{8}, supervisor \d+\n$/u)
    const id = /run (\S+),/.exec(asked.stderr)![1]!
    const json = await bmn(['team', 'ask', '--role', 'designer', '--question', 'And the other loop?', '--json'])
    expect(JSON.parse(json.stdout)).toMatchObject({ version: 1, state: 'answered', exit: 0, role: 'designer', chosen_by: 'chain', data: 'private',
      teammate: { agent: 'fable', app: 'claude', app_version: '2.1.300', form: 'claude-read-tools', could_read: expect.stringContaining('its working folder only'), works_in: expect.stringMatching(/\/work$/u),
        requested: { model: 'claude-fable-5-1', effort: 'medium' }, observed: { session_source: 'system init' } },
      subagents: [], usage: { reported_cost: 0.0123, billing: 'subscription', complete: true } })
    const list = JSON.parse((await bmn(['team', 'asks', '--json'])).stdout)
    expect(list.asks.map((entry: { id: string }) => entry.id)).toContain(id)
    const shown = (await bmn(['team', 'asks', 'show', id])).stdout
    expect(shown).toContain('epic-reviewer -> astra (codex 0.162.1 gpt-6-astra, medium), chosen by chain')
    expect(shown).toMatch(/^Could read: Codex's read-only sandbox: any file your user can read, .*; worked in \S+\/work$/mu)
    const exported = await bmn(['team', 'asks', 'export', id, '--output', join(home, 'bundle')])
    expect(exported.code).toBe(0)
    expect(existsSync(join(home, 'bundle/answer.md'))).toBe(true)
    // Usage problems and refusals keep their exit codes; the old --access and --wide-read are refused with the new spelling.
    expect((await bmn(['team', 'ask', '--role', 'epic-reviewer'])).code).toBe(2)
    expect((await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'x', '--agent', 'astra', '--small-work'])).code).toBe(2)
    for (const [option, words] of [[['--access', 'files'], /--access is gone: .*--project.*--file/u], [['--wide-read'], /--wide-read is gone: .*--project/u]] as const) {
      const old = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'x', ...option])
      expect(old.code).toBe(2)
      expect(old.stderr).toMatch(words)
    }
    const refused = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'x', '--agent', 'luna', '--json'])
    expect(refused.code).toBe(10)
    expect(JSON.parse(refused.stdout)).toMatchObject({ version: 1, state: 'refused', exit: 10, refusal: { code: 'AGENT_NOT_ELIGIBLE', alternatives: ['astra@medium', 'fable@medium', 'astra@low'] } })
    // A bare `bmn team` is the team, as before.
    expect((await bmn(['team'])).stdout).toContain('astra')
  })

  it('with no systemd user manager to reach, an ask is refused saying so, and nothing starts (72.9 AC4)', async () => {
    const refused = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'Is it bounded?', '--json'], '', { HOME: home, PATH: `${stubs}:/usr/bin:/bin` })
    expect(refused.code).toBe(10)
    expect(JSON.parse(refused.stdout)).toMatchObject({ state: 'refused', refusal: { code: 'SCOPE_UNAVAILABLE', reason: expect.stringContaining('no systemd user manager answered') } })
    const features = JSON.parse((await bmn(['team', 'ask', '--features', '--json'], '', { HOME: home, PATH: `${stubs}:/usr/bin:/bin` })).stdout)
    expect(features).toMatchObject({ version: 2, scope: { ok: false, reason: expect.stringContaining('no systemd user manager answered') } })
  })
})

describe('the outcome of what a run said (epic review)', () => {
  const span = 'INFO turn{thread.id=t-1 model=gpt-6-astra codex.turn.reasoning_effort=medium}: started\n'
  const started = '{"type":"thread.started","thread_id":"t-1"}'
  const said = '{"type":"item.completed","item":{"type":"agent_message","text":"an answer"}}'
  const completed = '{"type":"turn.completed","usage":{}}'
  function run(name: string, events: string[], stderr = '', exit: Record<string, unknown> = { ended: 'done', code: 0 }): string {
    const folder = join(home, name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'request.json'), JSON.stringify({ id: name, model: 'gpt-6-astra', effort: 'medium' }))
    writeFileSync(join(folder, 'receipt.json'), JSON.stringify({ harness: 'codex' }))
    writeFileSync(join(folder, 'exit.json'), JSON.stringify({ version: 1, ...exit }))
    writeFileSync(join(folder, 'events.jsonl'), `${events.join('\n')}\n`)
    writeFileSync(join(folder, 'stderr.txt'), stderr)
    writeFileSync(join(folder, 'app-status'), '0\n')
    return folder
  }

  it('an answer whose model nothing names is not attributed; text before a failure or an error exit is no answer; a failure the app recovered from is', () => {
    finishAsk(run('no-model', [started, said, completed]))
    expect(askOutcome(join(home, 'no-model'))).toMatchObject({ state: 'not-attributed', exit: 17, reason: expect.stringContaining('nothing in the run names its model') })
    expect(existsSync(join(home, 'no-model/answer.md'))).toBe(false)
    expect(readFileSync(join(home, 'no-model/diagnostic-answer.md'), 'utf8')).toBe('an answer\n')
    finishAsk(run('failed-after', [started, said, '{"type":"turn.failed","error":{"message":"stream ended"}}'], span, { ended: 'failed', code: 1 }))
    expect(askOutcome(join(home, 'failed-after'))).toMatchObject({ state: 'failed', exit: 1, reason: 'stream ended' })
    finishAsk(run('exit-code', [started, said, completed], span, { ended: 'failed', code: 2 }))
    expect(askOutcome(join(home, 'exit-code'))).toMatchObject({ state: 'failed', exit: 1, reason: 'the app ended with code 2' })
    finishAsk(run('recovered', [started, '{"type":"error","message":"Reconnecting... 1/5"}', said, completed], span))
    expect(askOutcome(join(home, 'recovered'))).toMatchObject({ state: 'answered', exit: 0 })
    for (const name of ['no-model', 'failed-after', 'exit-code', 'recovered']) expect(existsSync(join(home, name, 'app-status'))).toBe(false)
  })

  it('a finish that fails still writes an outcome and deletes the transient state; a run ended with no outcome is interrupted, so a wait ends', async () => {
    const folder = run('broken', [started, said, completed], span)
    // The answer cannot be written where it goes: the finish fails.
    mkdirSync(join(folder, 'answer.md'))
    writeFileSync(join(folder, 'answer.md/x'), 'x')
    expect(() => finishAsk(folder)).toThrow()
    expect(askOutcome(folder)).toMatchObject({ state: 'failed', exit: 1, reason: expect.stringContaining('BMN could not finish the run') })
    expect(existsSync(join(folder, 'app-status'))).toBe(false)
    const ended = join(home, 'ended')
    mkdirSync(ended)
    writeFileSync(join(ended, 'state.json'), JSON.stringify({ version: 1, state: 'ended' }))
    expect(askOutcome(ended)).toMatchObject({ state: 'interrupted', exit: null })
    expect(await waitAsk(ended, { timeoutMs: 60_000 })).toMatchObject({ state: 'interrupted' })
  })
})

describe('reading who answered (72.3 AC2, 72.9 AC5)', () => {
  it('what the app does not report is unknown with the reason, never zero', () => {
    const folder = join(home, 'run')
    mkdirSync(folder)
    writeFileSync(join(folder, 'events.jsonl'), '{"type":"thread.started","thread_id":"t-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n')
    const seen = observeAsk(folder, 'codex', { model: 'gpt-6-astra', effort: 'medium' })
    // A model nothing names is unknown, and the answer is then not attributed (epic review): no model, no attribution.
    expect(seen).toMatchObject({
      answer: 'done', observed: { session: 't-1', model: null, model_source: 'unknown: no turn span of the teammate on standard error' },
      usage: { input_tokens: 'unknown', source: 'unknown', complete: false, incomplete_reason: 'the app reported no usage' },
      problems: ['nothing in the run names its model (unknown: no turn span of the teammate on standard error)']
    })
  })

  it('a usage field the app leaves out stays unknown, in one turn or summed over several (epic pre-review)', () => {
    const codex = join(home, 'partial-codex')
    mkdirSync(codex)
    writeFileSync(join(codex, 'events.jsonl'), [
      '{"type":"thread.started","thread_id":"t-2"}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}}',
      '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":3,"reasoning_output_tokens":2}}',
      ''
    ].join('\n'))
    expect(observeAsk(codex, 'codex', { model: 'gpt-6-astra', effort: 'medium' }).usage).toMatchObject({ input_tokens: 150, cached_input_tokens: 'unknown', output_tokens: 10, reasoning_tokens: 'unknown', source: 'turn.completed' })
    const claude = join(home, 'partial-claude')
    mkdirSync(claude)
    writeFileSync(join(claude, 'events.jsonl'), '{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":12,"output_tokens":5,"cache_read_input_tokens":3}}\n')
    expect(observeAsk(claude, 'claude', { model: 'claude-opus-5-5', effort: 'medium' }).usage).toMatchObject({ input_tokens: 'unknown', cached_input_tokens: 3, output_tokens: 5, reasoning_tokens: 'unknown', source: 'result.usage', complete: true })
  })

  it('a sub-agent whose own usage cannot be read is named, its usage "incomplete", and the run\'s usage says it is incomplete (72.9 AC5)', () => {
    const folder = join(home, 'child-unread')
    mkdirSync(folder)
    const day = new Date()
    const rollouts = join(home, '.codex/sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    mkdirSync(rollouts, { recursive: true })
    writeFileSync(join(rollouts, `rollout-made-up-${CODEX_CHILD}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: CODEX_CHILD, source: { subagent: { thread_spawn: { parent_thread_id: 't-3', agent_nickname: 'Ada' } } } } })}\n`)
    writeFileSync(join(folder, 'launch.json'), JSON.stringify({ argv: ['/usr/bin/env', '-i', `HOME=${home}`, 'codex'] }))
    writeFileSync(join(folder, 'events.jsonl'), '{"type":"thread.started","thread_id":"t-3"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\n')
    writeFileSync(join(folder, 'stderr.txt'), `INFO turn{thread.id=t-3 model=gpt-6-astra codex.turn.reasoning_effort=medium}: started\nINFO turn{thread.id=${CODEX_CHILD} model=gpt-6-astra codex.turn.reasoning_effort=low}: started\n`)
    const seen = observeAsk(folder, 'codex', { model: 'gpt-6-astra', effort: 'medium' }, { startedAt: Date.now() - 1000, endedAt: Date.now() })
    expect(seen.problems).toEqual([])
    expect(seen.subagents).toEqual([expect.objectContaining({ session: CODEX_CHILD, name: 'Ada', usage: 'incomplete', usage_reason: 'its rollout holds no token count' })])
    expect(seen.usage).toMatchObject({ input_tokens: 1, complete: false, incomplete_reason: 'a sub-agent\'s usage could not be read from its rollout' })
  })
})
