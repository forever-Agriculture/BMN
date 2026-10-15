// MODULE: agents-team-cli.mjs - Epic 72: `bmn team ask` and `bmn team asks`, one bounded question to one approved teammate, its run listed, waited on, stopped and exported
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { APP_NAMES, DESIGNER_ROLE, RosterError } from './agents-roster.mjs'
import { AgentsUsageError, EXIT, err, failWith, out, usage } from './agents-cli.mjs'
import { askerOf } from './agents-ask.mjs'
import { harnessVersion, teamRunsDirectory } from './agents-check.mjs'
import { ASK_APPS, ASK_FORMS_CHECKED, ASK_READS, ASK_RUN_FILES, ASK_UNSUPPORTED, appSearchPath, askFormName, askProgram } from './agents-team-forms.mjs'
import { InputRefusal, LIMITS, askProject } from './agents-team-inputs.mjs'
import { AskRefusal } from './agents-team-resolve.mjs'
import { ACCESS_GONE, AskUsageError, WIDE_READ_GONE, askRunId, prepareAsk } from './agents-team-ask.mjs'
import { OUTCOME_EXIT, StartRefusal, TIME_LIMIT, TRANSIENT, askOutcome, exportAsk, startAsk, stopAsk, waitAsk } from './agents-team-run.mjs'
import { scopeStarts, startTeamSupervisor, writeWhole } from './agents-team-supervisor.mjs'
import { nestedAsk } from './agents-team-nested.mjs'
import { BROWSER_LIMIT_WORDS, BROWSER_ROLE } from './agents-team-browser.mjs'
import { askSettings, keyDay, keyPath, keyScope, keyedRun, makeKey, recordInterrupted, releaseReservation, requestHash, reserveAsk } from './agents-team-places.mjs'

export const TEAM_ASK_USAGE = `Usage: bmn team ask --role R (--question TEXT | --question-file PATH|-) --key K [--agent A] [--effort E]
         [--small-work] [--recheck-of ID] [--project P] [--file PATH]... [--image PATH]...
         [--data public] [--time-limit MINUTES] [--background] [--json]
       bmn team ask [--role R] (--question TEXT | --question-file PATH|-) --key K
         --origin http://127.0.0.1:PORT --disposable [--interact] [other options as above]
       bmn team ask --features [--json]             What each installed app is asked with here, and what its mode reads
       bmn team asks [--json]                       Your asks, newest first
       bmn team asks show <id> [--json]             One ask: its state, who answered, the answer
       bmn team asks wait <id> [--timeout SECONDS] [--json]
       bmn team asks stop <id> [--json]
       bmn team asks export <id> --output PATH      The allowlisted record, never a sign-in, a home or raw logs

Asks one approved teammate in a role, in its own app's read-only mode with that mode's tools: Codex's
read-only sandbox, Claude Code's read tools, Git history, web search and sub-agents, OpenCode's
read-only agent (docs/agent-control.md, "Asking a teammate"). It works in the project (--project;
the default is your repository, else an empty folder of the run's own) and writes nothing; what its
mode can read is in the record. --file gives whole text files in the prompt; --image gives PNG, JPEG
or WebP pictures as images, their metadata taken out, to the designer unless --role names another
role. --origin gives the teammate (the browser role unless --role names another) a browser for your
web app at that loopback address: Playwright's tools in its own app, only that origin loading; it may
navigate, read, take screenshots and read the console and network requests, and with --interact also
click, type, fill in, select, press keys and hover; the pages it visited and its screenshots stay in
the record. Playwright's limit does not stop redirects or requests a page makes itself: --disposable
is your statement that the app and its services are disposable test instances with synthetic data
and no production backend or credentials; without it the ask is refused. Codex and Claude Code
teammates only. The run has a systemd user scope of its own: Stop and the time limit end everything it
started. --key is required in a session: today's UTC day and a name of yours (20261015-review-1);
a retry with the same key and request finds the first ask, never starts a second. The answer goes
to standard output, progress to standard error; closing the command only detaches it, and the run
goes on. Exit: 0 answered, 1 failed, 2 usage, 3-7 team state, 10 refused, 14 busy, 15 out of time,
16 stopped, 17 answer not attributed.`

const RUN_ID = /^\d{8}T\d{6}-[0-9a-f]{8}$/u
const VALUES = ['role', 'question', 'question-file', 'agent', 'effort', 'recheck-of', 'project', 'data', 'time-limit', 'key', 'origin']
const REPEATED = ['file', 'image']
const FLAGS = ['small-work', 'background', 'json', 'help', 'features', 'disposable', 'interact']
/** Options an ask no longer takes, each refused with the new spelling (72.9 AC4). */
const GONE = { access: ACCESS_GONE, 'wide-read': WIDE_READ_GONE }

/** The options of `team ask`: values once each, `--file` as often as needed, nothing positional. */
export function readAskOptions(argv) {
  const options = Object.create(null)
  for (const name of REPEATED) options[name] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new AgentsUsageError(`team ask takes no ${argument === '-' ? 'lone -; use --question-file -' : `argument ${argument}`}`)
    const equals = argument.indexOf('=')
    const name = argument.slice(2, equals === -1 ? undefined : equals)
    if (Object.hasOwn(GONE, name)) throw new AgentsUsageError(GONE[name])
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
    ...(outcome.refusal === undefined ? {} : { refusal: outcome.refusal }),
    role: request.role ?? null, chosen_by: request.chosen_by ?? null, project: request.project ?? null, data: request.data ?? null,
    teammate: {
      agent: request.agent ?? null, app: receipt.harness ?? null, app_version: receipt.harness_version?.version ?? request.app_version ?? null, form: receipt.form ?? request.form ?? null,
      // What the teammate's own mode could read (72.9 AC1, AC6).
      could_read: receipt.reads?.words ?? request.reads ?? null, works_in: receipt.cwd ?? null,
      requested: { model: request.model ?? null, effort: request.effort ?? null }, observed: outcome.observed ?? null
    },
    subagents: outcome.subagents ?? [], usage: outcome.usage ?? null, ...(outcome.project === undefined ? {} : { project_state: outcome.project }),
    ...(outcome.credentials_masked === undefined ? {} : { credentials_masked: outcome.credentials_masked }), answer, started_at: outcome.started_at ?? null, ended_at: outcome.ended_at ?? null,
    time_limit_minutes: outcome.time_limit_minutes ?? null, record: folder,
    ...(request.browser === undefined ? {} : { browser: browserJson(folder, request.browser, read(ASK_RUN_FILES.browserRecord)) })
  }
}

/**
 * A browser ask's part of its JSON (74.3 AC3): the app it checked and, once the run has ended, the
 * pages it visited and its screenshots with where each is kept. Addresses and titles are the app's own text.
 */
function browserJson(folder, browser, record) {
  return {
    origin: browser.origin ?? null, interact: browser.interact === true, statement: browser.statement ?? null, limit: BROWSER_LIMIT_WORDS, recorded: record !== null,
    calls: record?.calls ?? 0, pages: Array.isArray(record?.pages) ? record.pages : [],
    screenshots: (Array.isArray(record?.screenshots) ? record.screenshots : []).map((shot) => ({ ...shot, path: join(folder, ASK_RUN_FILES.browser, basename(String(shot.name))) }))
  }
}

/** A browser ask's lines in `team asks show`: the app, each page visited and each screenshot, one line each, the app's own text kept plain. */
function browserLines(browser) {
  if (browser === undefined) return []
  // eslint-disable-next-line no-control-regex -- the control characters are what is taken out
  const plain = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
  const mode = browser.interact ? 'look and interact' : 'look only'
  if (!browser.recorded) return [`Browser: ${browser.origin} (${mode}); its pages and screenshots are recorded when the run ends`, `  ${browser.limit}`]
  return [`Browser: ${browser.origin} (${mode}); ${browser.pages.length} page${browser.pages.length === 1 ? '' : 's'} and ${browser.screenshots.length} screenshot${browser.screenshots.length === 1 ? '' : 's'}; addresses and titles are the app's own text:`,
    ...browser.pages.map((page) => `  page ${plain(page.url)}${page.title ? `  ${plain(page.title)}` : ''}`),
    ...browser.screenshots.map((shot) => `  screenshot ${shot.path} (${shot.bytes} bytes)`), `  ${browser.limit}`]
}

/** A project's state in words: its commit and whether its tree was clean. */
function stateWords(state) {
  if (state === null || state === undefined) return 'not read'
  if (state.commit === null && state.clean === null) return 'not a Git working tree'
  return `${state.commit === null ? 'no commit' : state.commit.slice(0, 12)}, ${state.clean === null ? 'its tree unread' : state.clean ? 'clean' : `${state.changed} change${state.changed === 1 ? '' : 's'}`}`
}

/** `bmn team asks show` in words: the state, who answered and how they were chosen, what its mode could read, its sub-agents, the project's state, the usage and the answer. */
export function showWords(shown) {
  const usage = shown.usage
  const tokens = usage === null || usage === undefined ? 'unknown'
    : `${usage.input_tokens} in, ${usage.output_tokens} out${usage.reported_cost === 'unknown' || usage.reported_cost === undefined ? '' : `, reported $${usage.reported_cost}`}${usage.complete === false ? ` (incomplete: ${usage.incomplete_reason ?? 'not every usage record was read'})` : ''}`
  const project = shown.project_state
  return [
    `${shown.id}  ${shown.state}${shown.reason ? `: ${shown.reason}` : ''}`,
    `${shown.role} -> ${shown.teammate.agent} (${shown.teammate.app ?? '?'}${shown.teammate.app_version ? ` ${shown.teammate.app_version}` : ''} ${shown.teammate.requested.model ?? '?'}, ${shown.teammate.requested.effort ?? '?'}), chosen by ${shown.chosen_by}`,
    `Could read: ${shown.teammate.could_read ?? 'not recorded'}${shown.teammate.works_in ? `; worked in ${shown.teammate.works_in}` : ''}`,
    ...browserLines(shown.browser),
    ...(shown.subagents.length === 0 ? [] : [`Sub-agents: ${shown.subagents.map((entry) => `${entry.name ?? entry.session} (${entry.kind}${entry.model ? `, ${entry.model}` : ''})`).join('; ')}`]),
    ...(project === undefined ? [] : [`Project ${project.root}: at the start ${stateWords(project.start)}; at the end ${stateWords(project.end)}`]),
    ...(shown.credentials_masked === undefined ? [] : [`Credentials masked: ${[...new Set([...shown.credentials_masked.answer, ...shown.credentials_masked.output])].join(', ')}`]),
    `Usage: ${tokens}`,
    ...(shown.answer === null ? [] : ['', shown.answer.replace(/\n$/u, '')])
  ].join('\n')
}

/** Ends a run that the check refused: its record says so, and its transient state goes. */
function recordRefusal(prepared) {
  for (const part of TRANSIENT) rmSync(join(prepared.folder, part), { recursive: true, force: true })
  const { code, message } = prepared.verdict
  // An outcome already written (an interruption recorded meanwhile) stays the run's outcome.
  if (!existsSync(join(prepared.folder, ASK_RUN_FILES.outcome))) writeWhole(join(prepared.folder, ASK_RUN_FILES.outcome), `${JSON.stringify({ version: 1, id: prepared.id, state: 'refused', exit: OUTCOME_EXIT.refused, refusal: { code, reason: message }, ended_at: new Date().toISOString() }, null, 2)}\n`)
  return { code, message }
}

/** Exit 14: the capacity limit is reached and nothing is queued (the contract's "Exit codes"). */
export const BUSY_EXIT = 14

/**
 * What BMN's control service says of a session's token: `{ session }` it names, `{ invalid }` when
 * BMN does not know it, or `{ unreachable }` with why the service did not answer. The token goes only
 * to the service, as every BMN command sends it.
 */
export function verifySessionToken(socketPath, token, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let buffer = ''
    const socket = createConnection(socketPath)
    const done = (answer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(answer)
    }
    const timer = setTimeout(() => done({ unreachable: `no answer in ${timeoutMs / 1000} seconds` }), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth', params: { token } })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      let message
      try {
        message = JSON.parse(buffer.slice(0, newline))
      } catch {
        return done({ unreachable: 'its answer was not readable' })
      }
      if (message?.result?.scope === 'session' && typeof message.result.sessionId === 'string') return done({ session: message.result.sessionId })
      done({ invalid: true })
    })
    socket.on('error', (error) => done({ unreachable: error.code ?? error.message }))
    socket.on('close', () => done({ unreachable: 'it closed the connection without an answer' }))
  })
}

/**
 * BMN's own control socket, where BMN itself puts it: `control/control.sock` in its runtime folder,
 * found by the precedence src/utility/roots.ts uses (BMN_RUNTIME_HOME, then XDG_RUNTIME_DIR/bmn, then
 * the temporary folder's bmn-<uid>/bmn).
 */
export function bmnControlSocket(environment = process.env) {
  const runtime = environment.BMN_RUNTIME_HOME ?? environment.AITERM_RUNTIME_HOME ?? join(environment.XDG_RUNTIME_DIR ?? join(tmpdir(), `bmn-${process.getuid?.() ?? 'user'}`), 'bmn')
  return join(runtime, 'control', 'control.sock')
}

const samePath = (a, b) => {
  if (resolve(a) === resolve(b)) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/**
 * Who asks, as BMN's commands see it: a session, proven by the token BMN gave it, which BMN's own
 * control service must confirm names that very session; a plain shell; `forged` when the session id
 * comes with no token, or with one that names another session or that BMN does not know; or
 * `unproven` when BMN's control service cannot be reached to confirm it. The token is shown only to
 * BMN's own control socket (`bmnControlSocket`); a BMN_CONTROL_SOCKET naming another is refused before
 * any token is sent (epic review R1). Owner rights never come from here: only the app's owner action has them.
 */
export async function teamAsker(environment, { verify = verifySessionToken } = {}) {
  const asker = askerOf(environment)
  if (asker.kind !== 'session') return asker
  const token = environment.BMN_TOKEN ?? environment.AITERM_TOKEN
  if (typeof token !== 'string' || token === '') return { kind: 'forged', reason: `BMN_SESSION_ID names session ${asker.session}, but there is no BMN_TOKEN; BMN gives every session both` }
  const named = /^s1\.([A-Za-z0-9_:-]{1,128})\./u.exec(token)?.[1] ?? null
  if (named !== asker.session) return { kind: 'forged', reason: `BMN_SESSION_ID names session ${asker.session}, but the BMN_TOKEN BMN gave this session ${named === null ? 'names none' : `is session ${named}'s`}` }
  const socket = bmnControlSocket(environment)
  const supplied = environment.BMN_CONTROL_SOCKET ?? environment.AITERM_CONTROL_SOCKET
  if (typeof supplied === 'string' && supplied !== '' && !samePath(supplied, socket)) {
    return { kind: 'unproven', reason: `session ${asker.session} cannot be proven: BMN_CONTROL_SOCKET names ${supplied}, not BMN's own control socket ${socket}` }
  }
  const answer = await verify(socket, token)
  if (answer.session === asker.session) return asker
  if (answer.unreachable !== undefined) {
    const sandboxed = /^(EPERM|EACCES)$/u.test(answer.unreachable) ? '; a sandbox may be keeping this command from BMN: run it outside the sandbox' : ''
    return { kind: 'unproven', reason: `session ${asker.session} cannot be proven: BMN's control service did not answer (${answer.unreachable})${sandboxed}` }
  }
  return { kind: 'forged', reason: `BMN does not know the BMN_TOKEN given for session ${asker.session}` }
}

/** The refusal of an asker that is not proven to be who it says. */
function askerRefusal(asker, what) {
  return new AskRefusal(asker.kind === 'forged' ? 'NOT_YOURS' : 'SESSION_UNPROVEN', `${asker.reason}; ${what}`)
}

/** A file's bytes by their hash, for the request's hash; a file BMN will refuse later counts by what it is. */
function fileHash(path, limit = LIMITS.file) {
  try {
    const size = statSync(path).size
    if (size > limit) return `over-limit:${size}`
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return 'unreadable'
  }
}

/** What `bmn team ask --features` says: per app its version, the form it is asked with and what that form reads, the version the form was last checked on, and whether a scope starts here. */
export function askFeatures(environment = process.env) {
  const scope = scopeStarts({ environment })
  const apps = ASK_APPS.map((harness) => {
    const program = askProgram(harness, environment)
    const version = program === null ? null : harnessVersion(program.launcher, { PATH: appSearchPath(environment), HOME: environment.HOME ?? '' })
    const form = (project, label) => {
      const name = askFormName(harness, { project, label })
      return { form: name, reads: ASK_READS[name].words }
    }
    return {
      app: harness, installed: program !== null, version, form_checked_on: ASK_FORMS_CHECKED[harness],
      forms: { project: form('project', 'private'), 'no-project': form(null, 'private'), public: harness === 'opencode' ? form(null, 'public') : { form: null, reads: 'not offered: its tools read beyond your text, so its asks are private' } },
      pictures: ASK_UNSUPPORTED[harness]?.pictures === undefined ? 'offered' : `not offered: ${ASK_UNSUPPORTED[harness].pictures}`,
      browser: ASK_UNSUPPORTED[harness]?.browser === undefined ? 'offered' : `not offered: ${ASK_UNSUPPORTED[harness].browser}`, usage_while_running: harness === 'claude'
    }
  })
  return { version: 2, platform: process.platform, scope: scope.ok ? { ok: true } : { ok: false, reason: scope.reason }, apps }
}

function printFeatures(asJson, environment) {
  const shown = askFeatures(environment)
  if (asJson) {
    out(JSON.stringify(shown, null, 2))
    return EXIT.ok
  }
  out([`Teammates' asks on ${shown.platform}; a run's systemd user scope ${shown.scope.ok ? 'starts here' : `cannot start here: ${shown.scope.reason}`}.`,
    ...shown.apps.map((app) => !app.installed ? `${APP_NAMES[app.app]}: not installed where BMN looks`
      : `${APP_NAMES[app.app]} ${app.version ?? '(version unreadable)'} (form last checked on ${app.form_checked_on.version}, ${app.form_checked_on.on}): ${app.forms.project.reads}${app.forms.project.form === app.forms['no-project'].form ? '' : `; with no project, ${app.forms['no-project'].reads}`}; pictures ${app.pictures === 'offered' ? 'offered' : 'not offered'}; browser ${app.browser === 'offered' ? 'offered' : 'not offered'}; usage ${app.usage_while_running ? 'while it runs' : 'at the end only'}`)].join('\n'))
  return EXIT.ok
}

export async function runTeamAsk(argv, { environment = process.env, cwd = process.cwd(), now = () => new Date() } = {}) {
  let options
  try {
    options = readAskOptions(argv)
    if (options.help) {
      out(TEAM_ASK_USAGE)
      return EXIT.ok
    }
    if (options.features) {
      if (Object.keys(options).some((name) => !['features', 'json', ...REPEATED].includes(name)) || REPEATED.some((name) => options[name].length > 0)) throw new AgentsUsageError('--features takes only --json')
    } else {
      // A picture ask goes to the designer unless the asker names another role (72.8 AC1); a browser ask to the browser role (74.3).
      if (options.role === undefined && options.image.length === 0 && options.origin === undefined) throw new AgentsUsageError('team ask needs --role')
      for (const name of ['disposable', 'interact']) if (options[name] !== undefined && options.origin === undefined) throw new AgentsUsageError(`--${name} goes with --origin, the address of the app to check`)
      if ((options.question === undefined) === (options['question-file'] === undefined)) throw new AgentsUsageError('team ask takes exactly one of --question and --question-file')
      if (options['time-limit'] !== undefined && !/^\d{1,3}$/u.test(options['time-limit'])) throw new AgentsUsageError(`--time-limit takes minutes, ${TIME_LIMIT.min} to ${TIME_LIMIT.max}`)
    }
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const asJson = options.json === true
  const nested = nestedAsk()
  if (nested !== null) return refused(asJson, 'NESTED', `this runs inside teammate ask ${nested}; a teammate's run may not ask the team`)
  if (options.features) return printFeatures(asJson, environment)
  const minutes = options['time-limit'] === undefined ? TIME_LIMIT.default : Number(options['time-limit'])
  if (minutes < TIME_LIMIT.min || minutes > TIME_LIMIT.max) return usage(`--time-limit takes minutes, ${TIME_LIMIT.min} to ${TIME_LIMIT.max}`)
  if (options['recheck-of'] !== undefined && !RUN_ID.test(options['recheck-of'])) return refused(asJson, 'RECHECK_INVALID', `${options['recheck-of']} is not the id of an ask`)
  const asker = await teamAsker(environment)
  if (asker.kind === 'forged' || asker.kind === 'unproven') {
    const refusal = askerRefusal(asker, 'ask from your own session')
    return refused(asJson, refusal.code, refusal.message)
  }
  // A session must name its key, so that its retry finds this ask; a plain shell may leave it to BMN.
  if (options.key === undefined && asker.kind === 'session') return refused(asJson, 'KEY_REQUIRED', `an ask from a session needs --key: today's UTC day and a name of yours, as ${makeKey('review-1', now())}; keep it, and a retry with the same key and request finds this ask`)
  if (options.key !== undefined && keyDay(options.key) === null) return usage(`--key ${options.key} is not a key: today's UTC day and a name (letters, digits, . _ -), as ${makeKey('review-1', now())}`)
  let question
  try {
    question = options.question ?? readText(options['question-file'] === '-' ? '-' : resolve(cwd, options['question-file']), LIMITS.question)
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    return usage(`cannot read the question from ${options['question-file'] === '-' ? 'standard input' : options['question-file']}`)
  }
  const home = environment.HOME ?? homedir()
  const files = options.file.map((path) => (isAbsolute(path) ? path : resolve(cwd, path)))
  const images = options.image.map((path) => (isAbsolute(path) ? path : resolve(cwd, path)))
  let project
  try {
    project = askProject(options.project, { cwd, home })
  } catch (error) {
    if (error instanceof InputRefusal) return refused(asJson, error.code, error.message)
    throw error
  }
  const request = {
    role: options.role ?? (options.origin !== undefined ? BROWSER_ROLE : DESIGNER_ROLE), question, agent: options.agent, effort: options.effort, smallWork: options['small-work'] === true, recheckOf: options['recheck-of'],
    project: options.project, files, images, data: options.data,
    ...(options.origin === undefined ? {} : { browser: { origin: options.origin, disposable: options.disposable === true, interact: options.interact === true } })
  }
  const runs = teamRunsDirectory()
  const key = options.key ?? makeKey('shell', now())
  const scope = keyScope(asker)
  // Each input is hashed once: the request's hash names these bytes, and the ask refuses to send any other (INPUT_CHANGED).
  const inputHashes = { files: files.map((path) => fileHash(path)), images: images.map((path) => fileHash(path, LIMITS.picture)) }
  const hash = requestHash({ ...request, project, files: files.map((path, index) => ({ path, sha256: inputHashes.files[index] })), images: images.map((path, index) => ({ path, sha256: inputHashes.images[index] })), timeLimitMinutes: minutes })
  let reservation
  try {
    reservation = await reserveAsk(runs, { scope, key, hash, id: askRunId(now()) }, { now: now() })
  } catch (error) {
    if (error instanceof AskRefusal) {
      if (error.code === 'USAGE') return usage(error.message)
      return refused(asJson, error.code, error.message, undefined, error.code === 'BUSY' ? BUSY_EXIT : EXIT.refusal)
    }
    throw error
  }
  if (reservation.existing !== undefined) return followKeyed(runs, reservation.entry, { asJson, background: options.background === true })
  const id = reservation.reserved
  let started = null
  let prepared
  try {
    // Where the run's scope cannot start, nothing is read or written: the ask is refused saying why (R72-NFR3).
    const systemd = scopeStarts({ environment })
    if (!systemd.ok) return refused(asJson, 'SCOPE_UNAVAILABLE', `the ask's systemd user scope cannot start from here: ${systemd.reason}; ask from where it can (a terminal, or escalated as a sandboxed lead runs helpers)`)
    try {
      prepared = prepareAsk({ ...request, key, keyScope: scope, requestSha256: hash, askedBy: asker, inputHashes }, { environment, cwd, id, now: now() })
    } catch (error) {
      // Nothing was sent and the key is given back: whatever preparing had written (file copies, pictures) goes with it.
      rmSync(join(runs, id), { recursive: true, force: true })
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
    try {
      started = startAsk(prepared, { timeLimitMinutes: minutes, tokenCeiling: askSettings(runs).token_ceiling, start: (folder) => startTeamSupervisor(folder, { environment }) })
    } catch (error) {
      if (error instanceof StartRefusal) {
        recordRefusal({ ...prepared, verdict: { code: error.code, message: error.message } })
        return refused(asJson, error.code, error.message)
      }
      if (error instanceof RosterError) return failWith(error, asJson)
      throw error
    }
  } finally {
    // An ask refused before its start gives its key and place back: nothing ran, and the key may be used again.
    if (started === null) await releaseReservation(runs, { scope, key, id })
  }
  const receipt = prepared.verdict.receipt
  if (options.background) {
    if (asJson) out(JSON.stringify({ version: 1, id, state: 'accepted', exit: 0, key }))
    else out(id)
    return EXIT.ok
  }
  err(`bmn: asked ${receipt.agent} (${receipt.harness} ${receipt.model}, ${receipt.effort}; chosen by ${prepared.choice.rule}) in ${receipt.cwd}; it can read ${receipt.reads.words.replace(/^[^:]*: /u, '')}${request.browser === undefined ? '' : `; it has a browser for ${request.browser.origin}${request.browser.interact ? ', to look and interact' : ', to look only'}`}; run ${id}, key ${key}, supervisor ${started.pid}`)
  return followRun(prepared.folder, id, asJson)
}

/** Waits for a run in the foreground: closing this command only detaches it, and the run's supervisor goes on. */
async function followRun(folder, id, asJson) {
  const controller = new AbortController()
  const detach = () => controller.abort()
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, detach)
  let outcome
  try {
    outcome = await waitAsk(folder, { signal: controller.signal })
  } finally {
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(name, detach)
  }
  if (outcome.exit === null && outcome.state === 'interrupted') recordInterrupted(folder, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
  else if (outcome.exit === null) {
    err(`bmn: detached; the run goes on: bmn team asks wait ${id}`)
    return 130
  }
  return printOutcome(folder, asJson)
}

/**
 * A retry: the key and request found the first run, which is followed as the first command would
 * have followed it, whatever its state; nothing is started again.
 */
async function followKeyed(runs, entry, { asJson, background }) {
  let found = keyedRun(runs, entry)
  while (found.state === 'preparing') {
    await new Promise((resolve) => setTimeout(resolve, 200))
    let now
    try {
      now = JSON.parse(readFileSync(keyPath(runs, entry.scope, entry.key), 'utf8'))
    } catch {
      now = null
    }
    // The first ask was refused before it started and gave its key back (its own command said why): nothing ran.
    if (now === null || now.id !== entry.id) return refused(asJson, 'NOT_STARTED', `the ask with key ${entry.key} was refused before it started (its own command said why); nothing ran, and the key may be used again`)
    found = keyedRun(runs, now)
  }
  if (found.state === 'interrupted') {
    if (asJson) out(JSON.stringify({ version: 1, id: entry.id, state: 'interrupted', exit: 1, reason: found.reason }))
    else err(`bmn: interrupted: ${found.reason}; ask again with a new key`)
    return 1
  }
  if (background) {
    const shown = askJson(found.folder)
    if (asJson) out(JSON.stringify({ version: 1, id: entry.id, state: shown.state, exit: 0, key: entry.key, existing: true }))
    else out(entry.id)
    return EXIT.ok
  }
  err(`bmn: the key ${entry.key} found run ${entry.id}, asked before; nothing started again`)
  return followRun(found.folder, entry.id, asJson)
}

function printOutcome(folder, asJson) {
  const shown = askJson(folder)
  if (asJson) {
    out(JSON.stringify(shown, null, 2))
  } else {
    if (shown.answer !== null && shown.state === 'answered') out(shown.answer)
    const line = words.outcome(shown)
    if (line !== null) err(line)
    if (shown.browser?.recorded) err(`bmn: ${shown.browser.pages.length} page${shown.browser.pages.length === 1 ? '' : 's'} and ${shown.browser.screenshots.length} screenshot${shown.browser.screenshots.length === 1 ? '' : 's'} recorded: bmn team asks show ${shown.id}`)
  }
  return shown.exit ?? 1
}

/** The asks of whoever asks now: a proven session sees its own; a shell sees those asked from a shell. */
function ownAsks(asker) {
  if (asker.kind !== 'session' && asker.kind !== 'shell') return []
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

function runFolder(id, asker) {
  if (!RUN_ID.test(id ?? '')) throw new AgentsUsageError('name an ask by its id, as `bmn team asks` lists it')
  if (asker.kind === 'forged' || asker.kind === 'unproven') throw askerRefusal(asker, 'a session sees only its own asks')
  const folder = join(teamRunsDirectory(), id)
  if (!existsSync(folder)) throw new AskRefusal('GONE', `no ask ${id} on this computer`)
  if (!ownAsks(asker).includes(folder)) throw new AskRefusal('NOT_YOURS', `ask ${id} was asked by another session; the owner sees every ask in the app`)
  // A run whose supervisor died is recorded as interrupted when it is looked at, its transient state deleted.
  if (askOutcome(folder).state === 'interrupted') recordInterrupted(folder, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
  return folder
}

export async function runTeamAsks(argv, { environment = process.env, cwd = process.cwd() } = {}) {
  const [action, ...rest] = argv[0] !== undefined && !argv[0].startsWith('--') ? argv : [undefined, ...argv]
  const flags = rest.filter((entry) => entry.startsWith('--'))
  const asJson = flags.includes('--json')
  const nested = nestedAsk()
  if (nested !== null) return refused(asJson, 'NESTED', `this runs inside teammate ask ${nested}; a teammate's run may not see or control asks`)
  try {
    const asker = await teamAsker(environment)
    if (action === undefined) {
      if (flags.some((flag) => flag !== '--json')) throw new AgentsUsageError(`unknown option ${flags.find((flag) => flag !== '--json')}`)
      if (asker.kind === 'forged' || asker.kind === 'unproven') throw askerRefusal(asker, 'a session sees only its own asks')
      const asks = ownAsks(asker).map((folder) => {
        // A run whose supervisor died is recorded as interrupted when it is listed, as when it is looked at.
        if (askOutcome(folder).state === 'interrupted') recordInterrupted(folder, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
        const shown = askJson(folder)
        return { id: shown.id, state: shown.state, role: shown.role, agent: shown.teammate.agent, project: shown.project, started_at: shown.started_at, ended_at: shown.ended_at }
      })
      if (asJson) out(JSON.stringify({ version: 1, asks }))
      else out(asks.length === 0 ? 'No asks.' : asks.map((entry) => `${entry.id}  ${entry.state.padEnd(14)} ${entry.role} -> ${entry.agent}${entry.project ? `  ${entry.project}` : ''}`).join('\n'))
      return EXIT.ok
    }
    const id = rest.find((entry) => !entry.startsWith('--'))
    const folder = runFolder(id, asker)
    if (action === 'show') {
      const shown = askJson(folder)
      if (asJson) out(JSON.stringify(shown, null, 2))
      else out(showWords(shown))
      return EXIT.ok
    }
    if (action === 'wait') {
      const at = rest.indexOf('--timeout')
      const seconds = at === -1 ? null : Number(rest[at + 1])
      if (seconds !== null && !(seconds >= 0)) throw new AgentsUsageError('--timeout takes seconds')
      const outcome = await waitAsk(folder, { timeoutMs: seconds === null ? Number.POSITIVE_INFINITY : seconds * 1000 })
      if (outcome.state === 'interrupted' && outcome.exit === null) {
        recordInterrupted(folder, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
        return printOutcome(folder, asJson)
      }
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
