// MODULE: agents-team-run.mjs - Epic 72: an ask started exactly as it was judged, attributed from its own output, finished into its record, and exported only as its allowlist says
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readApproved } from './agents-state.mjs'
import { copyGoSignInToRun, openCodeSessionInfo } from './agents-opencode.mjs'
import { ASK_RUN_FILES, sameProgram } from './agents-team-forms.mjs'
import { RUN_FILES, requestStop, runState, startTeamSupervisor, writeWhole } from './agents-team-supervisor.mjs'

/**
 * An ask starts only as it was judged (R72-FR3, 72.3 AC1): the approved team and the app's program
 * are checked again immediately before the start, and a change to either starts nothing. Its
 * supervisor owns the run from then on; the asking command only waits, and closing it only detaches
 * it (72.3 AC3). When the container ends, the supervisor calls `finishAsk`, which reads who answered
 * from the app's own output (72.3 AC2), keeps the answer, the outcome and the usage in the run's
 * record, and deletes the run's transient state: its app home and its frozen project (72.3 AC4).
 */

/** The time limit of one ask, in minutes (the contract's "Limits"). */
export const TIME_LIMIT = Object.freeze({ default: 30, min: 1, max: 120 })
/** The app's raw output over which a run fails, and the answer kept. */
export const OUTPUT_LIMIT = 64 * 1024 * 1024
export const ANSWER_LIMIT = 1024 * 1024
/** Each final state and its exit code (the contract's "Exit codes"). */
/** What OpenCode recorded of an ask's session, read after the run (72.5): its info alone, never its messages. */
export const OPENCODE_SESSION_INFO = 'session-info.json'
export const OUTCOME_EXIT = Object.freeze({ answered: 0, failed: 1, interrupted: 1, refused: 10, 'out-of-time': 15, stopped: 16, 'not-attributed': 17 })

export class StartRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const readJsonOrNull = (path) => {
  try {
    return readJson(path)
  } catch {
    return null
  }
}

/**
 * Starts a judged ask. `prepared`: what `prepareAsk` returned with a PASS. The approved team and the
 * app's program must still be the ones the check saw; otherwise nothing starts (CHANGED). Returns
 * `{ pid, start }` of the supervisor; the run goes on whatever happens to the caller.
 */
export function startAsk(prepared, { now = new Date(), timeLimitMinutes = TIME_LIMIT.default, start = startTeamSupervisor, tokenCeiling = null } = {}) {
  const receipt = prepared.verdict.receipt
  const folder = prepared.folder
  const generation = readApproved()
  if (generation.number !== receipt.generation.number || generation.hash !== receipt.generation.hash) {
    throw new StartRefusal('CHANGED', `the approved team changed after the check (version ${receipt.generation.number} then, ${generation.number} now); nothing started`)
  }
  const identity = readJsonOrNull(join(folder, ASK_RUN_FILES.snapshots, 'executable.json'))
  if (identity === null || !sameProgram(identity, prepared.program)) {
    throw new StartRefusal('CHANGED', 'the app\'s program changed after the check; nothing started')
  }
  // An OpenCode run gets its own copy of BMN's OpenCode Go sign-in, for this run alone; its home goes on every outcome (72.5 AC1, AC2).
  if (receipt.harness === 'opencode') {
    const copied = copyGoSignInToRun(join(folder, ASK_RUN_FILES.home, 'oc'), { launcher: prepared.program.launcher, environment: { PATH: '/usr/bin:/bin' } })
    if (!copied.ok) throw new StartRefusal('SIGN_IN_UNAVAILABLE', `${copied.reason}; nothing started`)
  }
  const launch = {
    version: 1, argv: prepared.argv, deadline: now.getTime() + timeLimitMinutes * 60_000, time_limit_minutes: timeLimitMinutes,
    stdin: join(folder, ASK_RUN_FILES.prompt), finish: { module: fileURLToPath(import.meta.url), export: 'finishAsk' }, args_fd: true, output_limit: OUTPUT_LIMIT,
    // The owner's per-ask token ceiling holds where the app reports usage while it runs: Claude Code alone (72.1).
    ...(tokenCeiling !== null && receipt.harness === 'claude' ? { token_ceiling: tokenCeiling, watch: { module: fileURLToPath(import.meta.url), export: 'watchAsk', ends: 'ceiling' } } : {})
  }
  writeWhole(join(folder, RUN_FILES.launch), `${JSON.stringify(launch, null, 2)}\n`)
  const started = start(folder)
  if (started.failed !== undefined) throw new StartRefusal('CONTAINER_UNAVAILABLE', `the ask's supervisor could not start: ${started.failed}`)
  return started
}

// ---------------------------------------------------------------------------------------------
// Who answered, from the app's own output

const CODEX_TURN = /turn\{([^}]*)\}/gu
const spanField = (span, name) => new RegExp(`(?:^|\\s)${name.replace(/\./gu, '\\.')}=("[^"]*"|[^\\s]+)`, 'u').exec(span)?.[1]?.replace(/^"|"$/gu, '')

function eventsOf(folder) {
  let text
  try {
    text = readFileSync(join(folder, RUN_FILES.events), 'utf8')
  } catch {
    return { events: [], unreadable: 0 }
  }
  const events = []
  let unreadable = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      unreadable += 1
    }
  }
  return { events, unreadable }
}

/**
 * What a run's own output says of it: the session, the model and effort with where each was read,
 * the answer, the usage and its source, and every problem with attribution. `request`: the run's
 * `request.json` (requested model, aliases, effort). Nothing the app does not report is made up:
 * it is `unknown`, with the reason.
 */
export function observeAsk(folder, harness, request) {
  const { events } = eventsOf(folder)
  const problems = []
  const observed = { session: null, session_source: null, model: null, model_source: null, effort: null, effort_source: null }
  let answer = null
  let failure = null
  const usage = { input_tokens: 'unknown', cached_input_tokens: 'unknown', output_tokens: 'unknown', reasoning_tokens: 'unknown', reported_cost: 'unknown', billing: request.billing ?? 'unknown', source: 'unknown' }
  let rateLimit = null
  const sessions = new Set()
  if (harness === 'codex') {
    const first = events[0]
    if (first?.type === 'thread.started' && typeof first.thread_id === 'string') {
      observed.session = first.thread_id
      observed.session_source = 'thread.started'
    }
    let totals = null
    for (const event of events) {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessions.add(event.thread_id)
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') answer = event.item.text
      if (event.type === 'turn.failed' || event.type === 'error') failure = event.error?.message ?? event.message ?? 'the app reported an error'
      if (event.type === 'turn.completed' && event.usage !== null && typeof event.usage === 'object') {
        totals ??= { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 }
        totals.input_tokens += Number(event.usage.input_tokens ?? 0)
        totals.cached_input_tokens += Number(event.usage.cached_input_tokens ?? 0)
        totals.output_tokens += Number(event.usage.output_tokens ?? 0)
        totals.reasoning_tokens += Number(event.usage.reasoning_output_tokens ?? 0)
      }
    }
    if (totals !== null) Object.assign(usage, totals, { source: 'turn.completed' })
    let stderr
    try {
      stderr = readFileSync(join(folder, RUN_FILES.stderr), 'utf8')
    } catch {
      stderr = ''
    }
    const models = new Set()
    const efforts = new Set()
    for (const [, span] of stderr.matchAll(CODEX_TURN)) {
      const thread = spanField(span, 'thread.id')
      const model = spanField(span, 'model')
      const effort = spanField(span, 'codex.turn.reasoning_effort')
      if (thread !== undefined) sessions.add(thread)
      if (model !== undefined) models.add(model)
      if (effort !== undefined) efforts.add(effort)
    }
    if (models.size === 1) Object.assign(observed, { model: [...models][0], model_source: 'turn span' })
    else if (models.size > 1) problems.push(`the turn spans name ${[...models].join(' and ')}`)
    else observed.model_source = 'unknown: no turn span on standard error'
    if (efforts.size === 1) Object.assign(observed, { effort: [...efforts][0], effort_source: 'turn span' })
    else if (efforts.size > 1) problems.push(`the turn spans name the efforts ${[...efforts].join(' and ')}`)
    else observed.effort_source = 'unknown: no turn span on standard error'
    // Codex also writes its last message with -o; it stands in only where the stream holds none.
    if (answer === null) {
      try {
        answer = readFileSync(join(folder, ASK_RUN_FILES.home, 'answer.md'), 'utf8')
      } catch {
        answer = null
      }
    }
  } else if (harness === 'claude') {
    const first = events[0]
    if (first?.type === 'system' && first.subtype === 'init' && typeof first.session_id === 'string') {
      observed.session = first.session_id
      observed.session_source = 'system init'
      if (typeof first.model === 'string') Object.assign(observed, { model: first.model, model_source: 'system init' })
      if (first.apiKeySource === 'none' && usage.billing === 'unknown') usage.billing = 'subscription'
    }
    for (const event of events) {
      if (typeof event.session_id === 'string') sessions.add(event.session_id)
      if (event.type === 'assistant' && typeof event.message?.model === 'string' && observed.model !== null && event.message.model !== observed.model) {
        problems.push(`an answer came from ${event.message.model}, not ${observed.model}`)
      }
      if (event.type === 'rate_limit_event' && event.rate_limit_info !== null && typeof event.rate_limit_info === 'object') {
        const info = event.rate_limit_info
        rateLimit = { status: info.status ?? 'unknown', window: info.rateLimitType ?? 'unknown', utilization: info.utilization ?? 'unknown' }
      }
      if (event.type === 'result') {
        if (event.subtype === 'success' && event.is_error === false && typeof event.result === 'string') answer = event.result
        else failure = typeof event.result === 'string' && event.result !== '' ? event.result : `the app ended with ${event.subtype ?? 'an error'}`
        if (event.usage !== null && typeof event.usage === 'object') {
          Object.assign(usage, {
            input_tokens: Number(event.usage.input_tokens ?? 0) + Number(event.usage.cache_creation_input_tokens ?? 0),
            cached_input_tokens: Number(event.usage.cache_read_input_tokens ?? 0),
            output_tokens: Number(event.usage.output_tokens ?? 0),
            reasoning_tokens: event.usage.output_tokens_details?.thinking_tokens ?? 'unknown',
            source: 'result'
          })
        }
        if (typeof event.total_cost_usd === 'number') usage.reported_cost = event.total_cost_usd
      }
    }
    // Claude Code does not report its effort: it is the one the pinned command named.
    if (request.effort !== undefined) Object.assign(observed, { effort: request.effort, effort_source: 'pinned command (--effort)' })
  } else if (harness === 'opencode') {
    // Every event names the session (70.1); the model, its variant and the usage are in the session's own record, read after the run (finishAsk).
    if (typeof events[0]?.sessionID === 'string') Object.assign(observed, { session: events[0].sessionID, session_source: 'every event (sessionID)' })
    for (const event of events) {
      if (typeof event.sessionID === 'string') sessions.add(event.sessionID)
      if (event.type === 'text' && typeof event.part?.text === 'string') answer = event.part.text
      if (event.type === 'error') failure = typeof event.error?.message === 'string' ? `OpenCode reported an error: ${event.error.message.slice(0, 200)}` : `OpenCode reported an error (${event.error?.type ?? 'unknown'})`
    }
    const record = readJsonOrNull(join(folder, OPENCODE_SESSION_INFO))
    const info = record?.info
    if (info !== undefined && info !== null && info.id === observed.session) {
      if (typeof info.model?.id === 'string') Object.assign(observed, { model: info.model.id, model_source: 'session export' })
      if (typeof info.model?.variant === 'string') Object.assign(observed, { effort: info.model.variant, effort_source: 'session export (variant)' })
      if (typeof info.model?.provider === 'string' && typeof request.provider === 'string' && info.model.provider !== request.provider) problems.push(`the session ran on ${info.model.provider}, not ${request.provider}`)
      Object.assign(usage, {
        input_tokens: info.tokens?.input ?? 'unknown', cached_input_tokens: info.tokens?.cache_read ?? 'unknown', output_tokens: info.tokens?.output ?? 'unknown',
        reasoning_tokens: info.tokens?.reasoning ?? 'unknown', reported_cost: info.reported_cost ?? 'unknown', source: 'session export'
      })
    } else {
      const why = record?.failed ?? 'no session export'
      Object.assign(observed, { model_source: `unknown: ${why}`, effort_source: `unknown: ${why}` })
      usage.source = `unknown: ${why}`
    }
  }
  if (observed.session === null) problems.push('the run named no session in its first event')
  const others = [...sessions].filter((id) => id !== observed.session)
  if (observed.session !== null && others.length > 0) problems.push(`the run named a second session, ${others[0]}`)
  const names = [request.model, ...(request.aliases ?? [])]
  if (observed.model !== null && !names.includes(observed.model)) problems.push(`the app ran ${observed.model}, not ${request.model}`)
  if (observed.effort !== null && observed.effort !== request.effort) problems.push(`the app ran at ${observed.effort}, not ${request.effort}`)
  return { observed, answer, failure, usage, rateLimit, problems }
}

// ---------------------------------------------------------------------------------------------
// The end of a run, called by its supervisor

/**
 * Reads an OpenCode ask's session record with OpenCode itself in the run's own folders, as 70.4 did
 * for research, and keeps only its info (`session-info.json`): model, variant, tokens, reported spend. The
 * program is the one the run's snapshot names.
 */
function recordOpenCodeSession(folder) {
  const session = eventsOf(folder).events.find((event) => typeof event.sessionID === 'string')?.sessionID ?? null
  const launcher = readJsonOrNull(join(folder, ASK_RUN_FILES.snapshots, 'executable.json'))?.launcher?.path
  const found = typeof launcher === 'string' ? openCodeSessionInfo(session, join(folder, ASK_RUN_FILES.home, 'oc'), { launcher, environment: { PATH: '/usr/bin:/bin' } }) : { failed: 'the run\'s program is not recorded' }
  writeWhole(join(folder, OPENCODE_SESSION_INFO), `${JSON.stringify({ version: 1, ...found }, null, 2)}\n`)
}

/**
 * Finishes a run once its container has ended: the outcome and the answer into the record, then the
 * run's app home and frozen project deleted, whatever the outcome. An answer that cannot be
 * attributed is kept only as diagnostic evidence, never as the answer.
 */
export function finishAsk(folder) {
  const request = readJsonOrNull(join(folder, ASK_RUN_FILES.request)) ?? {}
  const receipt = readJsonOrNull(join(folder, ASK_RUN_FILES.receipt)) ?? {}
  const exit = readJsonOrNull(join(folder, RUN_FILES.exit)) ?? { ended: 'failed' }
  const state = readJsonOrNull(join(folder, RUN_FILES.state)) ?? {}
  const harness = receipt.harness ?? null
  // OpenCode keeps its usage in the session's own record: read in the run's own folders before they are deleted (72.5 AC2).
  if (harness === 'opencode') recordOpenCodeSession(folder)
  let seen
  try {
    seen = observeAsk(folder, harness, request)
  } catch (error) {
    seen = { observed: {}, answer: null, failure: `BMN could not read the run's output: ${error instanceof Error ? error.message : String(error)}`, usage: {}, rateLimit: null, problems: [] }
  }
  let outcome
  let reason = null
  if (exit.ended === 'stopped') outcome = 'stopped'
  else if (exit.ended === 'ceiling') {
    outcome = 'stopped'
    reason = exit.reason ?? 'the run reached the owner\'s token ceiling'
  } else if (exit.ended === 'limit') {
    outcome = 'out-of-time'
    const minutes = readJsonOrNull(join(folder, RUN_FILES.launch))?.time_limit_minutes
    reason = `the run's time limit${minutes ? ` of ${minutes} minute${minutes === 1 ? '' : 's'}` : ''} ended it`
    // OpenCode retries a provider error without end and says nothing (70.1): a run that started steps and answered nothing was still waiting on its provider.
    if (harness === 'opencode' && seen.answer === null && seen.failure === null && eventsOf(folder).events.some((event) => event.type === 'step_start')) reason += '; OpenCode was still waiting on its provider, which it retries without end'
  } else if (exit.ended === 'output') {
    outcome = 'failed'
    reason = `the app's output went over ${OUTPUT_LIMIT / 1024 / 1024} MiB`
  } else if (seen.answer === null || seen.answer.trim() === '') {
    outcome = 'failed'
    reason = seen.failure ?? (exit.code === 0 ? 'the app ended without an answer' : `the app ended with code ${exit.code ?? exit.signal ?? 'unknown'}`)
  } else if (seen.problems.length > 0) {
    outcome = 'not-attributed'
    reason = seen.problems.join('; ')
  } else if (Buffer.byteLength(seen.answer) > ANSWER_LIMIT) {
    outcome = 'failed'
    reason = `the answer is over ${ANSWER_LIMIT / 1024 / 1024} MiB`
  } else {
    outcome = 'answered'
  }
  if (seen.answer !== null) {
    const text = seen.answer.endsWith('\n') ? seen.answer : `${seen.answer}\n`
    writeWhole(join(folder, outcome === 'answered' ? ASK_RUN_FILES.answer : 'diagnostic-answer.md'), text)
  }
  writeWhole(join(folder, ASK_RUN_FILES.outcome), `${JSON.stringify({
    version: 1, id: request.id ?? null, state: outcome, exit: OUTCOME_EXIT[outcome], ...(reason === null ? {} : { reason }),
    requested: { agent: request.agent ?? null, model: request.model ?? null, effort: request.effort ?? null },
    observed: seen.observed, usage: seen.usage, ...(seen.rateLimit === null ? {} : { rate_limit: seen.rateLimit }), problems: seen.problems,
    started_at: state.started_at ?? null, ended_at: exit.at ?? new Date().toISOString(), time_limit_minutes: readJsonOrNull(join(folder, RUN_FILES.launch))?.time_limit_minutes ?? null
  }, null, 2)}\n`)
  // The transient state goes on every outcome: the run's app home (its sign-in's mount point, sessions, bookkeeping) and its frozen project.
  for (const part of [ASK_RUN_FILES.home, ASK_RUN_FILES.project]) rmSync(join(folder, part), { recursive: true, force: true })
  rmSync(join(folder, RUN_FILES.stop), { force: true })
  // Its capacity place is given back (agents-team-places.mjs placePath), once its outcome is written.
  rmSync(join(dirname(folder), '.places', `${basename(folder)}.json`), { force: true })
}

/** What the token ceiling has seen of each run this process watches: where it read to, and each model call's tokens. */
const watched = new Map()

/**
 * The supervisor's watch step for a Claude Code run under the owner's token ceiling: reads the
 * output added since the last call, counts each model call's input, cache and output tokens as
 * Claude Code reports them while it runs (the last report of each message counts), and returns why
 * the run must end once the total is over the ceiling, else null.
 */
export function watchAsk(folder, launch) {
  const limit = launch?.token_ceiling
  if (!Number.isInteger(limit)) return null
  const seen = watched.get(folder) ?? { offset: 0, rest: '', calls: new Map(), unnamed: 0 }
  watched.set(folder, seen)
  let text
  try {
    const buffer = readFileSync(join(folder, RUN_FILES.events))
    text = seen.rest + buffer.subarray(seen.offset).toString('utf8')
    seen.offset = buffer.length
  } catch {
    return null
  }
  const lines = text.split('\n')
  seen.rest = lines.pop() ?? ''
  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const usage = event?.type === 'assistant' ? event.message?.usage : null
    if (usage === null || typeof usage !== 'object') continue
    const tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((sum, name) => sum + (Number.isFinite(usage[name]) ? usage[name] : 0), 0)
    seen.calls.set(typeof event.message.id === 'string' ? event.message.id : `unnamed-${(seen.unnamed += 1)}`, tokens)
  }
  const total = [...seen.calls.values()].reduce((sum, tokens) => sum + tokens, 0)
  return total > limit ? `the run reached the owner's token ceiling: ${total} tokens, over ${limit}` : null
}

/** The outcome of a run once it has one; otherwise its state now (running, interrupted, …). */
export function askOutcome(folder) {
  const outcome = readJsonOrNull(join(folder, ASK_RUN_FILES.outcome))
  if (outcome !== null) return outcome
  const now = runState(folder)
  return { version: 1, state: now.state === 'unknown' ? 'accepted' : now.state, exit: null }
}

/** Waits for a run's outcome, up to `timeoutMs`; returns what is known then. */
export async function waitAsk(folder, { timeoutMs = Number.POSITIVE_INFINITY, pollMs = 200, signal = undefined } = {}) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const outcome = askOutcome(folder)
    if (outcome.exit !== null || outcome.state === 'interrupted') return outcome
    if (Date.now() >= until || signal?.aborted) return outcome
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, until - Date.now()))))
  }
}

export function stopAsk(folder) {
  requestStop(folder)
}

// ---------------------------------------------------------------------------------------------
// The export

/** What an export carries (the contract's record table): never the app's home, its raw error stream or the frozen copy. */
export const EXPORTED = Object.freeze(['request.json', 'inputs', 'project-manifest.json', 'snapshots', 'receipt.json', 'launch.json', 'state.json', 'exit.json', 'events.jsonl', 'session-info.json', 'answer.md', 'outcome.json'])

/** The launch with every environment value the container is given left out: names only. */
function launchWithoutValues(launch) {
  const argv = [...launch.argv]
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--setenv' && index + 2 < argv.length) {
      argv[index + 2] = '(not exported)'
      index += 2
    }
  }
  return { ...launch, argv }
}

/** Copies the allowlisted record of a run into `output`, a folder that must not exist yet. Returns the files written. */
export function exportAsk(folder, output) {
  if (existsSync(output)) throw new StartRefusal('INPUT_INVALID', `${output} already exists; name a new folder`)
  mkdirSync(dirname(output), { recursive: true })
  mkdirSync(output, { mode: 0o700 })
  const files = []
  for (const name of EXPORTED) {
    const source = join(folder, name)
    if (!existsSync(source)) continue
    if (name === 'launch.json') {
      writeFileSync(join(output, name), `${JSON.stringify(launchWithoutValues(readJson(source)), null, 2)}\n`, { mode: 0o600 })
    } else if (statSync(source).isDirectory()) {
      cpSync(source, join(output, name), { recursive: true, verbatimSymlinks: true })
    } else {
      cpSync(source, join(output, name))
    }
  }
  const walk = (base, prefix) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(base, entry.name), path)
      else files.push(path)
    }
  }
  walk(output, '')
  return files.sort()
}
