// MODULE: agents-team-cli.mjs - Epic 72: `bmn team ask` and `bmn team asks`, one bounded question to one approved teammate, its run listed, waited on, stopped and exported
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { RosterError } from './agents-roster.mjs'
import { AgentsUsageError, EXIT, err, failWith, out, usage } from './agents-cli.mjs'
import { askerOf } from './agents-ask.mjs'
import { teamRunsDirectory } from './agents-check.mjs'
import { containerStarts } from './agents-container.mjs'
import { ASK_RUN_FILES } from './agents-team-forms.mjs'
import { InputRefusal, LIMITS } from './agents-team-inputs.mjs'
import { AskRefusal } from './agents-team-resolve.mjs'
import { AskUsageError, prepareAsk } from './agents-team-ask.mjs'
import { OUTCOME_EXIT, StartRefusal, TIME_LIMIT, askOutcome, exportAsk, startAsk, stopAsk, waitAsk } from './agents-team-run.mjs'
import { writeWhole } from './agents-team-supervisor.mjs'

export const TEAM_ASK_USAGE = `Usage: bmn team ask --role R (--question TEXT | --question-file PATH|-) [--agent A] [--effort E] [--small-work]
         [--recheck-of ID] [--project P] [--access question|files|project] [--file PATH]...
         [--data public] [--time-limit MINUTES] [--background] [--json]
       bmn team asks [--json]                       Your asks, newest first
       bmn team asks show <id> [--json]             One ask: its state, who answered, the answer
       bmn team asks wait <id> [--timeout SECONDS] [--json]
       bmn team asks stop <id> [--json]
       bmn team asks export <id> --output PATH      The allowlisted record, never a sign-in, a home or raw logs

Asks one approved teammate in a role, read-only, in a container BMN builds for that one run
(docs/agent-control.md, "Asking a teammate"). --access says what it may read: the question only
(default), the --file texts, or one project's frozen copy with its Git history. The answer goes to
standard output, progress to standard error; closing the command only detaches it, and the run goes
on. Exit: 0 answered, 1 failed, 2 usage, 3-7 team state, 10 refused, 15 out of time, 16 stopped,
17 answer not attributed.`

const RUN_ID = /^\d{8}T\d{6}-[0-9a-f]{8}$/u
const VALUES = ['role', 'question', 'question-file', 'agent', 'effort', 'recheck-of', 'project', 'access', 'data', 'time-limit']
const REPEATED = ['file']
const FLAGS = ['small-work', 'background', 'json', 'help', 'wide-read']

/** The options of `team ask`: values once each, `--file` as often as needed, nothing positional. */
export function readAskOptions(argv) {
  const options = Object.create(null)
  for (const name of REPEATED) options[name] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new AgentsUsageError(`team ask takes no ${argument === '-' ? 'lone -; use --question-file -' : `argument ${argument}`}`)
    const equals = argument.indexOf('=')
    const name = argument.slice(2, equals === -1 ? undefined : equals)
    if (FLAGS.includes(name)) {
      if (equals !== -1) throw new AgentsUsageError(`--${name} does not take a value`)
      if (options[name] !== undefined) throw new AgentsUsageError(`--${name} given more than once`)
      options[name] = true
      continue
    }
    if (!VALUES.includes(name) && !REPEATED.includes(name)) throw new AgentsUsageError(`unknown option --${name}`)
    const value = equals !== -1 ? argument.slice(equals + 1) : argv[index + 1]
    if (value === undefined) throw new AgentsUsageError(`--${name} requires a value`)
    if (equals === -1) index += 1
    if (REPEATED.includes(name)) {
      options[name].push(value)
      continue
    }
    if (options[name] !== undefined) throw new AgentsUsageError(`--${name} given more than once`)
    options[name] = value
  }
  return options
}

/** A long text option's value: a file, or standard input for `-` (one trailing newline dropped, a terminal refused). */
function readText(source, limit) {
  if (source === '-' && process.stdin.isTTY) throw new AgentsUsageError('--question-file - reads standard input; pipe the question or use a heredoc')
  const handle = source === '-' ? 0 : openSync(source, 'r')
  try {
    const chunks = []
    let size = 0
    const buffer = Buffer.alloc(64 * 1024)
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null)
      if (read === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, read)))
      size += read
      // One byte over the limit is enough to say it is too long; the rest is never read.
      if (size > limit) break
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\n$/u, '')
  } finally {
    if (handle !== 0) closeSync(handle)
  }
}

const words = {
  refusal: (code, message, alternatives) => `bmn: ${code}: ${message}${alternatives?.length ? `\n  could answer: ${alternatives.join(', ')}` : ''}`,
  outcome: (outcome) => outcome.state === 'answered' ? null : `bmn: ${outcome.state}${outcome.reason ? `: ${outcome.reason}` : ''}`
}

function refused(asJson, code, message, alternatives = undefined, exit = EXIT.refusal) {
  if (asJson) out(JSON.stringify({ version: 1, state: 'refused', exit, refusal: { code, reason: message, ...(alternatives === undefined ? {} : { alternatives }) } }))
  else err(words.refusal(code, message, alternatives))
  return exit
}

/** The JSON of one ask, as the contract shows it. */
export function askJson(folder) {
  const read = (name) => {
    try {
      return JSON.parse(readFileSync(join(folder, name), 'utf8'))
    } catch {
      return null
    }
  }
  const request = read(ASK_RUN_FILES.request) ?? {}
  const receipt = read(ASK_RUN_FILES.receipt) ?? {}
  const outcome = askOutcome(folder)
  let answer
  try {
    answer = readFileSync(join(folder, ASK_RUN_FILES.answer), 'utf8')
  } catch {
    answer = null
  }
  return {
    version: 1, id: request.id ?? null, state: outcome.state, exit: outcome.exit ?? null, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    role: request.role ?? null, chosen_by: request.chosen_by ?? null, access: request.access ?? null, project: request.project ?? null, data: request.data ?? null,
    teammate: {
      agent: request.agent ?? null, app: receipt.harness ?? null, app_version: receipt.harness_version?.version ?? null, form: receipt.form ?? null,
      requested: { model: request.model ?? null, effort: request.effort ?? null }, observed: outcome.observed ?? null
    },
    usage: outcome.usage ?? null, answer, started_at: outcome.started_at ?? null, ended_at: outcome.ended_at ?? null,
    time_limit_minutes: outcome.time_limit_minutes ?? null, record: folder
  }
}

/** Ends a run that the check refused: its record says so, and its transient state goes. */
function recordRefusal(prepared) {
  for (const part of [ASK_RUN_FILES.home, ASK_RUN_FILES.project]) rmSync(join(prepared.folder, part), { recursive: true, force: true })
  const { code, message } = prepared.verdict
  writeWhole(join(prepared.folder, ASK_RUN_FILES.outcome), `${JSON.stringify({ version: 1, id: prepared.id, state: 'refused', exit: OUTCOME_EXIT.refused, refusal: { code, reason: message }, ended_at: new Date().toISOString() }, null, 2)}\n`)
  return { code, message }
}

export async function runTeamAsk(argv, { environment = process.env, cwd = process.cwd() } = {}) {
  let options
  try {
    options = readAskOptions(argv)
    if (options.help) {
      out(TEAM_ASK_USAGE)
      return EXIT.ok
    }
    if (options.role === undefined) throw new AgentsUsageError('team ask needs --role')
    if ((options.question === undefined) === (options['question-file'] === undefined)) throw new AgentsUsageError('team ask takes exactly one of --question and --question-file')
    if (options['time-limit'] !== undefined && !/^\d{1,3}$/u.test(options['time-limit'])) throw new AgentsUsageError(`--time-limit takes minutes, ${TIME_LIMIT.min} to ${TIME_LIMIT.max}`)
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const asJson = options.json === true
  const minutes = options['time-limit'] === undefined ? TIME_LIMIT.default : Number(options['time-limit'])
  if (minutes < TIME_LIMIT.min || minutes > TIME_LIMIT.max) return usage(`--time-limit takes minutes, ${TIME_LIMIT.min} to ${TIME_LIMIT.max}`)
  if (options['recheck-of'] !== undefined && !RUN_ID.test(options['recheck-of'])) return refused(asJson, 'RECHECK_INVALID', `${options['recheck-of']} is not the id of an ask`)
  let question
  try {
    question = options.question ?? readText(options['question-file'] === '-' ? '-' : resolve(cwd, options['question-file']), LIMITS.question)
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    return usage(`cannot read the question from ${options['question-file'] === '-' ? 'standard input' : options['question-file']}`)
  }
  // Where the container cannot start, nothing is read or copied: the ask is refused in bubblewrap's own words.
  const container = containerStarts()
  if (!container.ok) return refused(asJson, 'CONTAINER_UNAVAILABLE', `BMN's container cannot start from here: ${container.reason}; ask from where it can (a terminal, or escalated as a sandboxed lead runs helpers)`)
  let prepared
  try {
    prepared = prepareAsk({
      role: options.role, question, agent: options.agent, effort: options.effort, smallWork: options['small-work'] === true, recheckOf: options['recheck-of'],
      project: options.project, access: options.access, files: options.file.map((path) => (isAbsolute(path) ? path : resolve(cwd, path))), data: options.data, wide: options['wide-read'] === true
    }, { environment, cwd })
  } catch (error) {
    if (error instanceof AskUsageError) return usage(error.message)
    if (error instanceof AskRefusal) return error.code === 'USAGE' ? usage(error.message) : refused(asJson, error.code, error.message, error.alternatives)
    if (error instanceof InputRefusal) return refused(asJson, error.code, error.message)
    if (error instanceof RosterError) return failWith(error, asJson)
    throw error
  }
  if (prepared.verdict.verdict !== 'PASS') {
    const { code, message } = recordRefusal(prepared)
    return refused(asJson, code, message)
  }
  let started
  try {
    started = startAsk(prepared, { timeLimitMinutes: minutes })
  } catch (error) {
    if (error instanceof StartRefusal) return refused(asJson, error.code, error.message)
    if (error instanceof RosterError) return failWith(error, asJson)
    throw error
  }
  const receipt = prepared.verdict.receipt
  if (options.background) {
    if (asJson) out(JSON.stringify({ version: 1, id: prepared.id, state: 'accepted', exit: 0 }))
    else out(prepared.id)
    return EXIT.ok
  }
  err(`bmn: asked ${receipt.agent} (${receipt.harness} ${receipt.model}, ${receipt.effort}; chosen by ${prepared.choice.rule}), ${receipt.access} access; run ${prepared.id}, supervisor ${started.pid}`)
  // Closing this command only detaches it: the run's supervisor owns the run.
  const controller = new AbortController()
  const detach = () => controller.abort()
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, detach)
  let outcome
  try {
    outcome = await waitAsk(prepared.folder, { signal: controller.signal })
  } finally {
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(name, detach)
  }
  if (outcome.exit === null) {
    err(`bmn: detached; the run goes on: bmn team asks wait ${prepared.id}`)
    return outcome.state === 'interrupted' ? 1 : 130
  }
  return printOutcome(prepared.folder, asJson)
}

function printOutcome(folder, asJson) {
  const shown = askJson(folder)
  if (asJson) {
    out(JSON.stringify(shown, null, 2))
  } else {
    if (shown.answer !== null && shown.state === 'answered') out(shown.answer)
    const line = words.outcome(shown)
    if (line !== null) err(line)
  }
  return shown.exit ?? 1
}

/** The asks of whoever asks now: a session sees its own; a shell sees those asked from a shell. */
function ownAsks(environment) {
  const asker = askerOf(environment)
  let names
  try {
    names = readdirSync(teamRunsDirectory()).filter((name) => RUN_ID.test(name)).sort().reverse()
  } catch {
    names = []
  }
  return names.map((name) => join(teamRunsDirectory(), name)).filter((folder) => {
    try {
      const by = JSON.parse(readFileSync(join(folder, ASK_RUN_FILES.request), 'utf8')).asked_by ?? {}
      return by.kind === asker.kind && (asker.kind !== 'session' || by.session === asker.session)
    } catch {
      return false
    }
  })
}

function runFolder(id, environment) {
  if (!RUN_ID.test(id ?? '')) throw new AgentsUsageError('name an ask by its id, as `bmn team asks` lists it')
  const folder = join(teamRunsDirectory(), id)
  if (!existsSync(folder)) throw new AskRefusal('GONE', `no ask ${id} on this computer`)
  if (!ownAsks(environment).includes(folder)) throw new AskRefusal('NOT_YOURS', `ask ${id} was asked by another session; the owner sees every ask in the app`)
  return folder
}

export async function runTeamAsks(argv, { environment = process.env, cwd = process.cwd() } = {}) {
  const [action, ...rest] = argv[0] !== undefined && !argv[0].startsWith('--') ? argv : [undefined, ...argv]
  const flags = rest.filter((entry) => entry.startsWith('--'))
  const asJson = flags.includes('--json')
  try {
    if (action === undefined) {
      if (flags.some((flag) => flag !== '--json')) throw new AgentsUsageError(`unknown option ${flags.find((flag) => flag !== '--json')}`)
      const asks = ownAsks(environment).map((folder) => {
        const shown = askJson(folder)
        return { id: shown.id, state: shown.state, role: shown.role, agent: shown.teammate.agent, project: shown.project, started_at: shown.started_at, ended_at: shown.ended_at }
      })
      if (asJson) out(JSON.stringify({ version: 1, asks }))
      else out(asks.length === 0 ? 'No asks.' : asks.map((entry) => `${entry.id}  ${entry.state.padEnd(14)} ${entry.role} -> ${entry.agent}${entry.project ? `  ${entry.project}` : ''}`).join('\n'))
      return EXIT.ok
    }
    const id = rest.find((entry) => !entry.startsWith('--'))
    const folder = runFolder(id, environment)
    if (action === 'show') {
      const shown = askJson(folder)
      if (asJson) out(JSON.stringify(shown, null, 2))
      else out([`${shown.id}  ${shown.state}${shown.reason ? `: ${shown.reason}` : ''}`, `${shown.role} -> ${shown.teammate.agent} (${shown.teammate.app ?? '?'} ${shown.teammate.requested.model ?? '?'}, ${shown.teammate.requested.effort ?? '?'}), chosen by ${shown.chosen_by}`,
        ...(shown.answer === null ? [] : ['', shown.answer.replace(/\n$/u, '')])].join('\n'))
      return EXIT.ok
    }
    if (action === 'wait') {
      const at = rest.indexOf('--timeout')
      const seconds = at === -1 ? null : Number(rest[at + 1])
      if (seconds !== null && !(seconds >= 0)) throw new AgentsUsageError('--timeout takes seconds')
      const outcome = await waitAsk(folder, { timeoutMs: seconds === null ? Number.POSITIVE_INFINITY : seconds * 1000 })
      if (outcome.exit === null) {
        if (asJson) out(JSON.stringify({ version: 1, id, state: outcome.state, exit: null }))
        else err(`bmn: ask ${id} is ${outcome.state}`)
        return outcome.state === 'interrupted' ? 1 : 0
      }
      return printOutcome(folder, asJson)
    }
    if (action === 'stop') {
      stopAsk(folder)
      if (asJson) out(JSON.stringify({ version: 1, id, state: 'stopping' }))
      else err(`bmn: ask ${id} is stopping`)
      return EXIT.ok
    }
    if (action === 'export') {
      const at = rest.indexOf('--output')
      if (at === -1 || rest[at + 1] === undefined) throw new AgentsUsageError('asks export needs --output PATH')
      const output = resolve(cwd, rest[at + 1])
      const files = exportAsk(folder, output)
      if (asJson) out(JSON.stringify({ version: 1, id, output, files }))
      else out(`${files.length} files in ${output}`)
      return EXIT.ok
    }
    throw new AgentsUsageError(`team asks expects show, wait, stop or export, not ${action}`)
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    if (error instanceof AskRefusal || error instanceof StartRefusal) return refused(asJson, error.code, error.message)
    throw error
  }
}

export { OUTCOME_EXIT }
