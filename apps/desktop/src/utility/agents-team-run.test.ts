// MODULE: agents-team-run.test.ts - Story 72.3: an ask started exactly as judged in BMN's real bubblewrap container, attributed from its own output, finished into its record and exported by its allowlist; stand-in apps written in sh, a synthetic team, made-up sign-in files; no provider is reached
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { containerStarts } from '../../bin/agents-container.mjs'
import { ASK_RUN_FILES } from '../../bin/agents-team-forms.mjs'
import { prepareAsk } from '../../bin/agents-team-ask.mjs'
import { StartRefusal, askOutcome, exportAsk, finishAsk, observeAsk, startAsk, stopAsk, waitAsk } from '../../bin/agents-team-run.mjs'
import { runState, startTeamSupervisor } from '../../bin/agents-team-supervisor.mjs'
import { askJson } from '../../bin/agents-team-cli.mjs'
import { mountIdentity, recordInterrupted } from '../../bin/agents-team-places.mjs'
import { processStart } from '../../bin/agents-supervised.mjs'
import { ENV_SENTINEL, EXAMPLE, SIGN_IN_SENTINEL, approve as harnessApprove, leftovers as harnessLeftovers, settle, stubCodex as harnessStubCodex, teamAskHome } from './test-fixtures/team-ask-harness'

const CLI = fileURLToPath(new URL('../../bin/agents-team-cli.mjs', import.meta.url))
const RULES = '# Global rules\n\nRULES-SENTINEL: answer plainly and cite files.\n'
const canContain = containerStarts().ok

let home: string
let stubs: string
let env: Record<string, string>
const savedHome = process.env.HOME
const approve = (text: string): void => harnessApprove(home, text)
const stubCodex = (): void => harnessStubCodex(stubs)
const leftovers = (): string[] => harnessLeftovers(home)


const ask = (request: Partial<Parameters<typeof prepareAsk>[0]>) => prepareAsk({ role: 'epic-reviewer', question: 'Is the loop bounded?', ...request }, { environment: env, cwd: home, home })
/** A small synthetic project with one commit, made once per test. */
const projectRoot = (): string => {
  const root = join(home, 'code/app')
  if (existsSync(join(root, '.git'))) return root
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=made-up', '-c', 'user.email=made-up@example.test', ...args], { cwd: root, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'test: one')
  return root
}
const projectAsk = () => ask({ access: 'project', project: projectRoot() })
beforeEach(() => {
  ({ home, stubs, env } = teamAskHome('bmn-team-run-'))
})

afterEach(async () => {
  await settle(() => leftovers().length === 0, 5000)
  process.env.HOME = savedHome
  if (process.env.BMN_TEST_KEEP_HOME === undefined) rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!canContain)('an ask run in BMN\'s container (72.3)', { timeout: 30_000 }, () => {
  it('answers, attributed from its own first event and turn span, with usage, and its transient state is gone (AC2, AC4)', async () => {
    const prepared = ask({})
    expect(prepared.verdict.verdict).toBe('PASS')
    const started = startAsk(prepared, { timeLimitMinutes: 2 })
    expect(started.pid).toBeGreaterThan(0)
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    expect(outcome).toMatchObject({
      state: 'answered', exit: 0,
      observed: { session_source: 'thread.started', model: 'gpt-6-astra', model_source: 'turn span', effort: 'medium', effort_source: 'turn span' },
      usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5, reasoning_tokens: 2, reported_cost: 'unknown', source: 'turn.completed' }
    })
    expect(outcome.observed.session).toMatch(/^[0-9a-f]{8}-0000-7000-8000-000000000000$/)
    // Inside, the container shows only the run's own places.
    expect(readFileSync(join(prepared.folder, ASK_RUN_FILES.answer), 'utf8')).toMatch(/^codex answer [0-9a-f]{8} from home inputs work \n$/)
    expect(existsSync(join(prepared.folder, ASK_RUN_FILES.home))).toBe(false)
    expect(readdirSync(prepared.folder).sort()).toEqual(['answer.md', 'events.jsonl', 'exit.json', 'inputs', 'launch.json', 'outcome.json', 'question.md', 'receipt.json', 'request.json', 'snapshots', 'state.json', 'stderr.txt', 'tree.json'])
    // bubblewrap took its arguments from a descriptor: no argument file is left, and the launch says so.
    expect(JSON.parse(readFileSync(join(prepared.folder, 'launch.json'), 'utf8'))).toMatchObject({ args_fd: true })
    expect(runState(prepared.folder).state).toBe('ended')
  })

  it('Claude Code: the session from system init, the effort from the pinned command, the reported cost, and the owner\'s rules for a private ask (AC1, AC2)', async () => {
    mkdirSync(join(home, '.config/bmn/agents'), { recursive: true })
    writeFileSync(join(home, '.config/bmn/agents/global-rules.md'), RULES)
    const prepared = ask({ role: 'designer' })
    expect(readFileSync(join(prepared.folder, ASK_RUN_FILES.rules), 'utf8')).toContain('RULES-SENTINEL')
    expect(prepared.argv).toContain('--append-system-prompt')
    expect(prepared.verdict.receipt?.snapshots.rules).toMatch(/^[0-9a-f]{64}$/)
    startAsk(prepared, { timeLimitMinutes: 2 })
    const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    expect(outcome).toMatchObject({
      state: 'answered', observed: { session_source: 'system init', model: 'claude-fable-5-1', effort: 'medium', effort_source: 'pinned command (--effort)' },
      usage: { input_tokens: 10, cached_input_tokens: 11, output_tokens: 4, reported_cost: 0.0123, billing: 'subscription', source: 'result' }
    })
    expect(readFileSync(join(prepared.folder, ASK_RUN_FILES.answer), 'utf8')).toContain('rules=yes')
    // A public ask carries no rules.
    const open = ask({ role: 'designer', data: 'public' })
    expect(existsSync(join(open.folder, ASK_RUN_FILES.rules))).toBe(false)
    expect(open.argv).not.toContain('--append-system-prompt')
    // Codex gets them as its own AGENTS.md in the run's home, snapshotted.
    const codex = ask({})
    expect(readFileSync(join(codex.folder, 'home/codex/AGENTS.md'), 'utf8')).toBe(readFileSync(join(codex.folder, ASK_RUN_FILES.rules), 'utf8'))
    expect(readFileSync(join(codex.folder, 'snapshots/config/codex/AGENTS.md'), 'utf8')).toContain('RULES-SENTINEL')
  })

  it('a model that contradicts the request, a second session or none is "answer not attributed", the answer kept only as evidence (AC2)', async () => {
    for (const [word, problem] of [['MISMATCH', 'the app ran gpt-6-other, not gpt-6-astra'], ['SECOND', 'the run named a second session'], ['NOSESSION', 'the run named no session in its first event']] as const) {
      const prepared = ask({ question: `Is the loop bounded? ${word}` })
      startAsk(prepared, { timeLimitMinutes: 2 })
      const outcome = await waitAsk(prepared.folder, { timeoutMs: 20_000 })
      expect(outcome).toMatchObject({ state: 'not-attributed', exit: 17 })
      expect(outcome.reason).toContain(problem)
      expect(existsSync(join(prepared.folder, ASK_RUN_FILES.answer))).toBe(false)
      expect(readFileSync(join(prepared.folder, 'diagnostic-answer.md'), 'utf8')).toContain('codex answer')
    }
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

  it('a failed app is "failed" with its words; Stop and the time limit end the run and leave no process (AC3, AC4)', async () => {
    const failed = ask({ question: 'Is it bounded? FAIL' })
    startAsk(failed, { timeLimitMinutes: 2 })
    expect(await waitAsk(failed.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'failed', exit: 1, reason: 'the app ended with code 3' })
    const stopped = ask({ question: 'Is it bounded? SLEEP' })
    startAsk(stopped, { timeLimitMinutes: 2 })
    await settle(() => askOutcome(stopped.folder).state === 'running')
    stopAsk(stopped.folder)
    expect(await waitAsk(stopped.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'stopped', exit: 16 })
    const late = ask({ question: 'Is it bounded? SLEEP' })
    startAsk(late, { timeLimitMinutes: 0.02 })
    expect(await waitAsk(late.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'out-of-time', exit: 15 })
    await settle(() => leftovers().length === 0)
    expect(leftovers()).toEqual([])
  })

  it('the supervisor\'s death ends the container and leaves the run interrupted, never started again (AC3)', async () => {
    const prepared = ask({ question: 'Is it bounded? SLEEP' })
    const started = startAsk(prepared, { timeLimitMinutes: 2 })
    await settle(() => askOutcome(prepared.folder).state === 'running')
    process.kill(started.pid, 'SIGKILL')
    await settle(() => askOutcome(prepared.folder).state === 'interrupted')
    expect(askOutcome(prepared.folder)).toMatchObject({ state: 'interrupted', exit: null })
    // Under load bubblewrap can miss its parent's death in its first instant (it sets --die-with-parent itself, after
    // it starts): whoever looks at the run next ends what it left, by the identity the supervisor recorded (epic acceptance).
    recordInterrupted(prepared.folder, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
    await settle(() => leftovers().length === 0)
    expect(leftovers()).toEqual([])
    expect(askOutcome(prepared.folder)).toMatchObject({ state: 'interrupted', exit: 1 })
    // The same with a container that certainly outlived its supervisor: a process group of its own, named as the run's child.
    const orphaned = ask({ question: 'Is it bounded? SLEEP' })
    const left = spawn('/bin/sh', ['-c', `exec /bin/sleep 30 # ${orphaned.folder}`], { detached: true, stdio: 'ignore' })
    left.unref()
    await settle(() => processStart(left.pid as number) !== null, 2000)
    writeFileSync(join(orphaned.folder, 'state.json'), JSON.stringify({ version: 1, state: 'running', supervisor: { pid: 999_999_999, start: '1' }, child: { pid: left.pid, start: processStart(left.pid as number) } }))
    expect(askOutcome(orphaned.folder).state).toBe('interrupted')
    recordInterrupted(orphaned.folder, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
    await settle(() => processStart(left.pid as number) === null, 3000)
    expect(processStart(left.pid as number)).toBeNull()
  })

  it('a container a dead supervisor left is found by this run\'s home exactly: a run of the same id in another BMN state is never touched (epic review recheck)', async () => {
    // A container bubblewrap made of a folder bound at the container's home, as BMN's own binds a run's home; nothing named as the run's child.
    const container = (from: string) => {
      const started = spawn('/usr/bin/bwrap', ['--tmpfs', '/', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
        '--dir', '/ask', '--bind', from, '/ask/home', '/usr/bin/sleep', '30'], { detached: true, stdio: 'ignore' })
      started.unref()
      return started
    }
    const inside = (pid: number) => {
      try {
        return readFileSync(`/proc/${pid}/mountinfo`, 'utf8').includes(' /ask/home ')
      } catch {
        return false
      }
    }
    const sleeping = (from: string) => readdirSync('/proc').filter((pid) => /^\d+$/u.test(pid) && inside(Number(pid))).filter((pid) => {
      const line = readFileSync(`/proc/${pid}/mountinfo`, 'utf8').split('\n').find((entry) => entry.split(' ')[4] === '/ask/home')
      const own = mountIdentity(from)
      return own !== null && line?.split(' ')[2] === own.device && line?.split(' ')[3] === own.folder
    })
    const orphaned = ask({ question: 'Is it bounded? SLEEP' })
    const id = orphaned.folder.split('/').pop() as string
    // Another BMN state holding a run of the very same id, its home elsewhere (a copied state, an isolated profile).
    const elsewhere = join(home, 'other-state/runs', id, 'home')
    mkdirSync(elsewhere, { recursive: true })
    const ours = container(join(orphaned.folder, 'home'))
    const theirs = container(elsewhere)
    try {
      await settle(() => sleeping(join(orphaned.folder, 'home')).length > 0 && sleeping(elsewhere).length > 0, 5000)
      expect(sleeping(elsewhere).length).toBeGreaterThan(0)
      writeFileSync(join(orphaned.folder, 'state.json'), JSON.stringify({ version: 1, state: 'running', supervisor: { pid: 999_999_999, start: '1' } }))
      expect(askOutcome(orphaned.folder).state).toBe('interrupted')
      recordInterrupted(orphaned.folder, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
      await settle(() => processStart(ours.pid as number) === null, 3000)
      expect(processStart(ours.pid as number)).toBeNull()
      // The other state's container goes on.
      expect(processStart(theirs.pid as number)).not.toBeNull()
      expect(sleeping(elsewhere).length).toBeGreaterThan(0)
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

  it('a team change or a replaced program between the check and the start starts nothing; the owner\'s own configuration changing does not reach the run (AC1)', async () => {
    const team = ask({})
    approve(EXAMPLE.replace('PROSE-SENTINEL-PREAMBLE', 'PROSE-SENTINEL-PREAMBLE, changed'))
    expect(() => startAsk(team)).toThrow(StartRefusal)
    expect(() => startAsk(team)).toThrow(/the approved team changed after the check/)
    expect(existsSync(join(team.folder, 'launch.json'))).toBe(false)
    const program = ask({})
    stubCodex()
    expect(() => startAsk(program)).toThrow(/the app's program changed after the check; nothing started/)
    expect(existsSync(join(program.folder, 'launch.json'))).toBe(false)
    // The owner's own Codex configuration after the check: the run reads its own, as judged.
    const own = ask({})
    writeFileSync(join(home, '.codex/config.toml'), 'model_provider = "elsewhere"\n[model_providers.elsewhere]\nbase_url = "https://elsewhere.example.org/v1"\n')
    startAsk(own, { timeLimitMinutes: 2 })
    expect(await waitAsk(own.folder, { timeoutMs: 20_000 })).toMatchObject({ state: 'answered' })
    expect(JSON.parse(readFileSync(join(own.folder, 'launch.json'), 'utf8')).argv).toEqual(own.argv)
    expect(readFileSync(join(own.folder, 'snapshots/config/codex/config.toml'), 'utf8')).toBe('')
  })

  it('a command, a prompt or a configuration changed after the check starts nothing, also when the launch is changed before the supervisor reads it (epic review)', async () => {
    const argv = ask({})
    argv.argv.push('--extra')
    expect(() => startAsk(argv)).toThrow(/the command is not the one the check judged; nothing started/)
    const prompt = ask({})
    writeFileSync(join(prompt.folder, ASK_RUN_FILES.prompt), 'Another question?\n')
    expect(() => startAsk(prompt)).toThrow(/the prompt is not the one the check judged; nothing started/)
    const config = ask({})
    writeFileSync(join(config.folder, 'home/codex/config.toml'), 'model_provider = "elsewhere"\n')
    expect(() => startAsk(config)).toThrow(/the run's codex\/config.toml is not the configuration the check judged; nothing started/)
    // A Claude Code ask's own /etc/hosts, which keeps its sign-in hosts out of reach, is judged too (epic review R13).
    const hosts = ask({ role: 'designer' })
    writeFileSync(join(hosts.folder, ASK_RUN_FILES.snapshots, 'hosts'), '127.0.0.1\tlocalhost\n')
    expect(() => startAsk(hosts)).toThrow(/the run's \/etc\/hosts is not the one the check judged; nothing started/)
    for (const prepared of [argv, prompt, config, hosts]) expect(existsSync(join(prepared.folder, 'launch.json'))).toBe(false)
    // Between the start and the supervisor: the supervisor checks the command and the prompt again.
    const late = ask({})
    startAsk(late, { timeLimitMinutes: 2, start: () => ({ pid: 1, start: '1' }) })
    const launch = JSON.parse(readFileSync(join(late.folder, 'launch.json'), 'utf8'))
    writeFileSync(join(late.folder, 'launch.json'), JSON.stringify({ ...launch, argv: [...launch.argv, '--extra'] }))
    expect(startTeamSupervisor(late.folder)).toMatchObject({ pid: expect.any(Number) })
    expect(await waitAsk(late.folder, { timeoutMs: 10_000 })).toMatchObject({ state: 'refused', exit: 10, reason: 'the command changed after the check; nothing started' })
    expect(existsSync(join(late.folder, 'events.jsonl'))).toBe(false)
    const latePrompt = ask({})
    startAsk(latePrompt, { timeLimitMinutes: 2, start: () => ({ pid: 1, start: '1' }) })
    writeFileSync(join(latePrompt.folder, ASK_RUN_FILES.prompt), 'Another question?\n')
    startTeamSupervisor(latePrompt.folder)
    expect(await waitAsk(latePrompt.folder, { timeoutMs: 10_000 })).toMatchObject({ state: 'refused', exit: 10, reason: 'the prompt changed after the check; nothing started' })
    expect(existsSync(join(latePrompt.folder, 'home'))).toBe(false)
  })

  it('a run whose storage grows over its limit is ended and fails: its home, its logs, a short run at its end, a folder over it before the start (epic review)', async () => {
    // A judged ask with a stand-in app that only writes, its launch given a small storage ceiling (the shipped one is 1 GiB).
    const run = async (body: string, before: (folder: string) => void = () => undefined): Promise<Record<string, unknown>> => {
      writeFileSync(join(stubs, 'codex'), `#!/bin/sh\n[ "$1" = --version ] && echo "codex-cli 0.162.1" && exit 0\ncat >/dev/null\n${body}\n`, { mode: 0o755 })
      const prepared = ask({})
      expect(prepared.verdict.verdict).toBe('PASS')
      startAsk(prepared, { timeLimitMinutes: 2, start: () => ({ pid: 1, start: '1' }) })
      const launch = JSON.parse(readFileSync(join(prepared.folder, 'launch.json'), 'utf8'))
      writeFileSync(join(prepared.folder, 'launch.json'), JSON.stringify({ ...launch, storage_limit: 1_000_000 }))
      before(prepared.folder)
      expect(startTeamSupervisor(prepared.folder)).toMatchObject({ pid: expect.any(Number) })
      await settle(() => runState(prepared.folder).state === 'ended', 20_000)
      expect(askOutcome(prepared.folder)).toMatchObject({ state: 'failed', exit: 1, reason: 'the run\'s storage went over 1 GiB' })
      return JSON.parse(readFileSync(join(prepared.folder, 'exit.json'), 'utf8'))
    }
    expect(await run('/usr/bin/head -c 3000000 /dev/zero > /ask/home/big; exec /bin/sleep 20')).toMatchObject({ ended: 'storage', started: true, reason: expect.stringContaining('over 1000000') })
    // The run's own logs count too: output under the output bound that takes the whole folder over its storage (epic review recheck).
    expect(await run('/usr/bin/head -c 1500000 /dev/zero; exec /bin/sleep 20')).toMatchObject({ ended: 'storage', started: true })
    // A short run that ends between two measurements is measured once more at its end.
    expect(await run('/usr/bin/head -c 1500000 /dev/zero')).toMatchObject({ ended: 'storage', started: true })
    // A folder over the limit before the start starts nothing.
    expect(await run('/usr/bin/touch /ask/home/ran', (folder) => writeFileSync(join(folder, 'big'), Buffer.alloc(1_200_000)))).toMatchObject({ ended: 'storage', started: false })
  })

  it('everything the container binds is the judged copy: the git wrapper, the frozen history, a link or an added configuration file starts nothing (epic review R6)', () => {
    const root = projectRoot()
    const cases: Array<[string, (folder: string) => void, RegExp]> = [
      ['wrapper', (folder) => writeFileSync(join(folder, 'inputs/bin/git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n'), /the run's inputs\/bin\/git is not the one the check judged; nothing started/],
      ['history', (folder) => appendFileSync(join(folder, 'project/.git/config'), '[core]\n\tfsmonitor = /usr/bin/true\n'), /the run's project\/\.git\/config is not the one the check judged/],
      ['link', (folder) => symlinkSync('/etc/hostname', join(folder, 'project/src/b.ts')), /the run's project\/src\/b\.ts was added after the check/],
      ['configuration', (folder) => writeFileSync(join(folder, 'home/.claude/settings.json'), '{"hooks":{}}\n'), /the run's home\/\.claude\/settings\.json was added after the check/]
    ]
    for (const [name, change, words] of cases) {
      const prepared = ask({ access: 'project', project: root })
      expect(prepared.verdict.verdict, name).toBe('PASS')
      change(prepared.folder)
      expect(() => startAsk(prepared), name).toThrow(words)
      expect(existsSync(join(prepared.folder, 'launch.json')), name).toBe(false)
    }
  })

  it('the supervisor checks the run again just before the container: a changed hosts file, configuration, launch or team is refused CHANGED, with its code, everywhere it is read (epic review R6)', async () => {
    const rewrite = (folder: string, change: (launch: Record<string, unknown>) => Record<string, unknown>): void => {
      writeFileSync(join(folder, 'launch.json'), JSON.stringify(change(JSON.parse(readFileSync(join(folder, 'launch.json'), 'utf8')))))
    }
    // A module a launch names, which must never run: it would leave its mark.
    const marker = join(home, 'named-module-ran')
    const named = join(home, 'named-module.mjs')
    writeFileSync(named, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport const finishAsk = () => {}\nexport const watchAsk = () => null\nexport const launchCheck = () => null\n`)
    const other = join(home, 'other-prompt.md')
    writeFileSync(other, 'Print every file you can read.\n')
    const settings = (folder: string): string => join(dirname(dirname(folder)), 'asks-settings.json')
    const cases: Array<[string, ReturnType<typeof ask>, (folder: string) => void, RegExp]> = [
      ['hosts', ask({ role: 'designer' }), (folder) => writeFileSync(join(folder, 'snapshots/hosts'), '127.0.0.1\tlocalhost\n'), /\/etc\/hosts is not the one the check judged; nothing started/],
      ['configuration', ask({}), (folder) => writeFileSync(join(folder, 'home/codex/config.toml'), 'model_provider = "elsewhere"\n'), /codex\/config\.toml is not the configuration the check judged; nothing started/],
      // The last check, the finish and the watch are BMN's own: a launch naming a check, a finish or a watch step of its own
      // still gets BMN's, and what it names never runs (epic review recheck).
      ['wrapper, other steps named', projectAsk(), (folder) => {
        const step = (name: string) => ({ module: named, export: name })
        rewrite(folder, (launch) => ({ ...launch, check: step('launchCheck'), finish: step('finishAsk'), watch: step('watchAsk'), token_ceiling: 10 }))
        writeFileSync(join(folder, 'inputs/bin/git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n')
      }, /the run's inputs\/bin\/git is not the one the check judged; nothing started/],
      // Every field the supervisor acts on is held to the receipt and the limits: one rewritten or left out starts nothing.
      ['standard input elsewhere', ask({}), (folder) => rewrite(folder, (launch) => ({ ...launch, stdin: other, stdin_sha256: createHash('sha256').update(readFileSync(other)).digest('hex') })),
        /the launch's standard input is not the one the check judged; nothing started/],
      ['storage limit left out', ask({}), (folder) => rewrite(folder, (launch) => ({ ...launch, storage_limit: undefined })), /the launch's storage limit is not within BMN's; nothing started/],
      ['time limit widened', ask({}), (folder) => rewrite(folder, (launch) => ({ ...launch, deadline: Date.now() + 24 * 60 * 60_000 })), /the launch's time limit is not within BMN's; nothing started/],
      ['options on the command line', ask({}), (folder) => rewrite(folder, (launch) => ({ ...launch, args_fd: false })), /bubblewrap's options on its command line; nothing started/],
      // The owner's token ceiling, set for Claude Code's asks, holds for a launch without it.
      ['token ceiling left out', ask({ role: 'designer' }), (folder) => writeFileSync(settings(folder), '{"token_ceiling": 2500}\n'), /the launch's token ceiling is not within the owner's; nothing started/],
      // Last: a new approval changes the team for every run prepared before it.
      ['team', ask({}), () => approve(EXAMPLE), /the approved team changed after the check/]
    ]
    try {
      for (const [name, prepared, change, words] of cases) {
        startAsk(prepared, { timeLimitMinutes: 2, start: () => ({ pid: 1, start: '1' }) })
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

  it('the export is the allowlist: no sign-in, home, raw error stream, frozen copy or environment value (AC4)', async () => {
    const root = join(home, 'code/app')
    mkdirSync(root, { recursive: true })
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=S', '-c', 'user.email=s@example.org', ...args], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null' } })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'test: one')
    const prepared = ask({ role: 'designer', access: 'project', project: realpathSync(root) })
    startAsk(prepared, { timeLimitMinutes: 2 })
    await waitAsk(prepared.folder, { timeoutMs: 20_000 })
    const output = join(home, 'export')
    const files = exportAsk(prepared.folder, output)
    expect(files).toEqual(expect.arrayContaining(['request.json', 'receipt.json', 'outcome.json', 'answer.md', 'events.jsonl', 'launch.json', 'inputs/prompt.md', 'inputs/manifest.json', 'project-manifest.json', 'snapshots/executable.json']))
    expect(files.some((file) => file.startsWith('home/') || file.startsWith('project/') || file === 'stderr.txt')).toBe(false)
    const everything = files.map((file) => readFileSync(join(output, file), 'utf8')).join('\n')
    expect(everything).not.toContain(SIGN_IN_SENTINEL)
    expect(everything).not.toContain(ENV_SENTINEL)
    const launch = JSON.parse(readFileSync(join(output, 'launch.json'), 'utf8'))
    expect(launch.argv[launch.argv.indexOf('--setenv') + 2]).toBe('(not exported)')
    expect(() => exportAsk(prepared.folder, output)).toThrow(/already exists/)
  })
})

describe.skipIf(!canContain)('bmn team ask and bmn team asks (72.3 AC3)', { timeout: 30_000 }, () => {
  const BMN = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
  const bmn = (args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((done) => {
    const child = spawn(process.execPath, [BMN, ...args], { env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin` }, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdin.end(input)
    child.on('exit', (code) => done({ code, stdout, stderr }))
  })

  it('the answer on standard output, progress on standard error, the run listed, shown and exported', async () => {
    const asked = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question-file', '-'], 'Is the loop bounded?\n')
    expect(asked.code, asked.stderr).toBe(0)
    expect(asked.stdout).toMatch(/^codex answer [0-9a-f]{8} from home inputs work \n$/)
    expect(asked.stderr).toMatch(/^bmn: asked astra \(codex gpt-6-astra, medium; chosen by chain\), question access; run (\d{8}T\d{6}-[0-9a-f]{8}), key \d{8}-shell-[0-9a-f]{8}, supervisor \d+\n$/)
    const id = /run (\S+),/.exec(asked.stderr)![1]!
    const json = await bmn(['team', 'ask', '--role', 'designer', '--question', 'And the other loop?', '--json'])
    expect(JSON.parse(json.stdout)).toMatchObject({ version: 1, state: 'answered', exit: 0, role: 'designer', chosen_by: 'chain', access: 'question', data: 'private',
      teammate: { agent: 'fable', app: 'claude', app_version: '2.1.300', form: 'claude-no-tools', requested: { model: 'claude-fable-5-1', effort: 'medium' }, observed: { session_source: 'system init' } },
      usage: { reported_cost: 0.0123, billing: 'subscription' } })
    const list = JSON.parse((await bmn(['team', 'asks', '--json'])).stdout)
    expect(list.asks.map((entry: { id: string }) => entry.id)).toContain(id)
    expect((await bmn(['team', 'asks', 'show', id])).stdout).toContain('epic-reviewer -> astra (codex gpt-6-astra, medium), chosen by chain')
    const exported = await bmn(['team', 'asks', 'export', id, '--output', join(home, 'bundle')])
    expect(exported.code).toBe(0)
    expect(existsSync(join(home, 'bundle/answer.md'))).toBe(true)
    // Usage problems and refusals keep their exit codes.
    expect((await bmn(['team', 'ask', '--role', 'epic-reviewer'])).code).toBe(2)
    expect((await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'x', '--agent', 'astra', '--small-work'])).code).toBe(2)
    const refused = await bmn(['team', 'ask', '--role', 'epic-reviewer', '--question', 'x', '--agent', 'luna', '--json'])
    expect(refused.code).toBe(10)
    expect(JSON.parse(refused.stdout)).toMatchObject({ version: 1, state: 'refused', exit: 10, refusal: { code: 'AGENT_NOT_ELIGIBLE', alternatives: ['astra@medium', 'fable@medium', 'astra@low'] } })
    // A bare `bmn team` is the team, as before.
    expect((await bmn(['team'])).stdout).toContain('astra')
  })
})

describe('the outcome of what a run said (epic review)', () => {
  const span = 'INFO turn{thread.id=t-1 model=gpt-6-astra codex.turn.reasoning_effort=medium}: started\n'
  const started = '{"type":"thread.started","thread_id":"t-1"}'
  const said = '{"type":"item.completed","item":{"type":"agent_message","text":"an answer"}}'
  const completed = '{"type":"turn.completed","usage":{}}'
  function run(name: string, events: string[], stderr = '', exit: Record<string, unknown> = { ended: 'done', code: 0 }): string {
    const folder = join(home, name)
    mkdirSync(join(folder, 'home'), { recursive: true })
    writeFileSync(join(folder, 'request.json'), JSON.stringify({ id: name, model: 'gpt-6-astra', effort: 'medium' }))
    writeFileSync(join(folder, 'receipt.json'), JSON.stringify({ harness: 'codex' }))
    writeFileSync(join(folder, 'exit.json'), JSON.stringify({ version: 1, ...exit }))
    writeFileSync(join(folder, 'events.jsonl'), `${events.join('\n')}\n`)
    writeFileSync(join(folder, 'stderr.txt'), stderr)
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
    for (const name of ['no-model', 'failed-after', 'exit-code', 'recovered']) expect(existsSync(join(home, name, 'home'))).toBe(false)
  })

  it('a finish that fails still writes an outcome and deletes the transient state; a run ended with no outcome is interrupted, so a wait ends', async () => {
    const folder = run('broken', [started, said, completed], span)
    // The answer cannot be written where it goes: the finish fails.
    mkdirSync(join(folder, 'answer.md'))
    writeFileSync(join(folder, 'answer.md/x'), 'x')
    expect(() => finishAsk(folder)).toThrow()
    expect(askOutcome(folder)).toMatchObject({ state: 'failed', exit: 1, reason: expect.stringContaining('BMN could not finish the run') })
    expect(existsSync(join(folder, 'home'))).toBe(false)
    const ended = join(home, 'ended')
    mkdirSync(ended)
    writeFileSync(join(ended, 'state.json'), JSON.stringify({ version: 1, state: 'ended' }))
    expect(askOutcome(ended)).toMatchObject({ state: 'interrupted', exit: null })
    expect(await waitAsk(ended, { timeoutMs: 60_000 })).toMatchObject({ state: 'interrupted' })
  })
})

describe('reading who answered (72.3 AC2)', () => {
  it('what the app does not report is unknown with the reason, never zero', () => {
    const folder = join(home, 'run')
    mkdirSync(folder)
    writeFileSync(join(folder, 'events.jsonl'), '{"type":"thread.started","thread_id":"t-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n')
    const seen = observeAsk(folder, 'codex', { model: 'gpt-6-astra', effort: 'medium' })
    // A model nothing names is unknown, and the answer is then not attributed (epic review): no model, no attribution.
    expect(seen).toMatchObject({ answer: 'done', observed: { session: 't-1', model: null, model_source: 'unknown: no turn span on standard error' }, usage: { input_tokens: 'unknown', source: 'unknown' }, problems: ['nothing in the run names its model (unknown: no turn span on standard error)'] })
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
    expect(observeAsk(claude, 'claude', { model: 'claude-opus-5-5', effort: 'medium' }).usage).toMatchObject({ input_tokens: 'unknown', cached_input_tokens: 3, output_tokens: 5, reasoning_tokens: 'unknown', source: 'result' })
  })
})
