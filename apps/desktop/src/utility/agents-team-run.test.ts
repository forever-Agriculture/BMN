// MODULE: agents-team-run.test.ts - Story 72.3: an ask started exactly as judged in BMN's real bubblewrap container, attributed from its own output, finished into its record and exported by its allowlist; stand-in apps written in sh, a synthetic team, made-up sign-in files; no provider is reached
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { containerStarts } from '../../bin/agents-container.mjs'
import { ASK_RUN_FILES } from '../../bin/agents-team-forms.mjs'
import { prepareAsk } from '../../bin/agents-team-ask.mjs'
import { StartRefusal, askOutcome, exportAsk, observeAsk, startAsk, stopAsk, waitAsk } from '../../bin/agents-team-run.mjs'
import { runState } from '../../bin/agents-team-supervisor.mjs'
import { readValidRoster } from '../../bin/agents-state.mjs'
import { approveRoster } from '../main/agents-approval'

const EXAMPLE = readFileSync(fileURLToPath(new URL('./test-fixtures/agents/roster-example.md', import.meta.url)), 'utf8')
const CLI = fileURLToPath(new URL('../../bin/agents-team-cli.mjs', import.meta.url))
const SIGN_IN_SENTINEL = 'SIGN-IN-SENTINEL-not-a-real-token'
const ENV_SENTINEL = 'ENVIRONMENT-SENTINEL-value'
const RULES = '# Global rules\n\nRULES-SENTINEL: answer plainly and cite files.\n'
const canContain = containerStarts().ok

let home: string
let stubs: string
let env: Record<string, string>
const savedHome = process.env.HOME

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

/**
 * Stand-in apps that run inside the container with nothing but /usr: they read the prompt, take the
 * model and effort from their own arguments and answer as each app does. Words in the question
 * steer them: SLEEP, MISMATCH, SECOND, NOSESSION, FAIL.
 */
const STEER = `question=$(cat)
id=$(printf %s "$question" | md5sum | cut -c1-8)
case $question in *SLEEP*) sleep 60;; esac
case $question in *NAP*) sleep 2;; esac
case $question in *FAIL*) echo 'provider error' >&2; exit 3;; esac
`
function stubCodex(): void {
  writeFileSync(join(stubs, 'codex'), `#!/bin/sh
[ "$1" = --version ] && echo "codex-cli 0.162.1" && exit 0
model=; effort=; prev=
for a in "$@"; do
  [ "$prev" = -m ] && model=$a
  case $a in model_reasoning_effort=*) effort=$(printf %s "$a" | sed 's/.*="\\(.*\\)"/\\1/');; esac
  prev=$a
done
${STEER}thread=$id-0000-7000-8000-000000000000
case $question in *MISMATCH*) model=gpt-6-other;; esac
case $question in *NOSESSION*) ;; *) printf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread";; esac
printf '{"type":"turn.started"}\\n'
printf 'INFO turn{otel.name="session_task.turn" thread.id=%s turn.id=t-1 model=%s codex.turn.reasoning_effort=%s}: started\\n' "$thread" "$model" "$effort" >&2
case $question in *SECOND*) printf '{"type":"thread.started","thread_id":"ffffffff-0000-7000-8000-000000000000"}\\n';; esac
printf '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"codex answer %s from %s"}}\\n' "$id" "$(ls /ask | tr '\\n' ' ')"
printf '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":5,"reasoning_output_tokens":2}}\\n'
`)
  chmodSync(join(stubs, 'codex'), 0o755)
}
function stubClaude(): void {
  writeFileSync(join(stubs, 'claude'), `#!/bin/sh
[ "$1" = --version ] && echo "2.1.300 (Claude Code)" && exit 0
model=; effort=; prev=
for a in "$@"; do [ "$prev" = --model ] && model=$a; [ "$prev" = --effort ] && effort=$a; prev=$a; done
rules=no
for a in "$@"; do case $a in *RULES-SENTINEL*) rules=yes;; esac; done
${STEER}sid=$id-0000-4000-8000-000000000000
printf '{"type":"system","subtype":"init","session_id":"%s","model":"%s","apiKeySource":"none","tools":[]}\\n' "$sid" "$model"
printf '{"type":"assistant","session_id":"%s","message":{"model":"%s","usage":{"input_tokens":3,"output_tokens":4}}}\\n' "$sid" "$model"
printf '{"type":"result","subtype":"success","is_error":false,"result":"claude answer %s rules=%s","session_id":"%s","total_cost_usd":0.0123,"usage":{"input_tokens":3,"cache_creation_input_tokens":7,"cache_read_input_tokens":11,"output_tokens":4}}\\n' "$id" "$rules" "$sid"
`)
  chmodSync(join(stubs, 'claude'), 0o755)
}

const ask = (request: Partial<Parameters<typeof prepareAsk>[0]>) => prepareAsk({ role: 'epic-reviewer', question: 'Is the loop bounded?', ...request }, { environment: env, cwd: home, home })
/** Every process whose command line names this test's home: none may outlive a run. */
const leftovers = (): string[] => {
  const found: string[] = []
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const line = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
      if (line.includes(home) && !line.includes('vitest')) found.push(`${pid} ${line.slice(0, 160)}`)
    } catch {
      // Gone already.
    }
  }
  return found
}
const settle = async (check: () => boolean, ms = 8000): Promise<void> => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-team-run-')))
  process.env.HOME = home
  stubs = join(home, 'stubs')
  mkdirSync(stubs)
  stubCodex()
  stubClaude()
  env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, SECRET_LOOKING_VARIABLE: ENV_SENTINEL }
  for (const path of ['.codex/auth.json', '.claude/.credentials.json']) {
    mkdirSync(join(home, path, '..'), { recursive: true })
    writeFileSync(join(home, path), `{"token": "${SIGN_IN_SENTINEL}"}\n`)
  }
  approve(EXAMPLE)
})

afterEach(async () => {
  await settle(() => leftovers().length === 0, 5000)
  process.env.HOME = savedHome
  if (process.env.BMN_TEST_KEEP_HOME === undefined) rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!canContain)('an ask run in BMN\'s container (72.3)', () => {
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
    expect(readdirSync(prepared.folder).sort()).toEqual(['answer.md', 'events.jsonl', 'exit.json', 'inputs', 'launch.json', 'outcome.json', 'receipt.json', 'request.json', 'snapshots', 'state.json', 'stderr.txt'])
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
    await settle(() => leftovers().length === 0)
    expect(leftovers()).toEqual([])
    expect(askOutcome(prepared.folder)).toMatchObject({ state: 'interrupted', exit: null })
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

describe.skipIf(!canContain)('bmn team ask and bmn team asks (72.3 AC3)', () => {
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
    expect(asked.stderr).toMatch(/^bmn: asked astra \(codex gpt-6-astra, medium; chosen by chain\), question access; run (\d{8}T\d{6}-[0-9a-f]{8}), supervisor \d+\n$/)
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

describe('reading who answered (72.3 AC2)', () => {
  it('what the app does not report is unknown with the reason, never zero', () => {
    const folder = join(home, 'run')
    mkdirSync(folder)
    writeFileSync(join(folder, 'events.jsonl'), '{"type":"thread.started","thread_id":"t-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n')
    const seen = observeAsk(folder, 'codex', { model: 'gpt-6-astra', effort: 'medium' })
    expect(seen).toMatchObject({ answer: 'done', observed: { session: 't-1', model: null, model_source: 'unknown: no turn span on standard error' }, usage: { input_tokens: 'unknown', source: 'unknown' }, problems: [] })
  })
})
