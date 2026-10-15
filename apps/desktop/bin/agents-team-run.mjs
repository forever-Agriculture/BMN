// MODULE: agents-team-run.mjs - Epic 72: an ask started exactly as it was judged, attributed from its own output, finished into its record, and exported only as its allowlist says
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { canonicalJson, sha256 } from './agents-roster.mjs'
import { readApproved } from './agents-state.mjs'
import { copyGoSignInToRun, openCodeSessionInfo } from './agents-opencode.mjs'
import { ASK_RUN_FILES, sameProgram } from './agents-team-forms.mjs'
import { askSettings } from './agents-team-places.mjs'
import { RUN_FILES, requestStop, runState, startTeamSupervisor, writeWhole } from './agents-team-supervisor.mjs'
import { treeChange } from './agents-team-tree.mjs'

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
/** A run's storage, its record and transient state together, over which it fails (the contract's "Limits"). */
export const STORAGE_LIMIT = 1024 * 1024 * 1024
/** Each final state and its exit code (the contract's "Exit codes"). */
/** What OpenCode recorded of an ask's session, read after the run (72.5): its info alone, never its messages. */
export const OPENCODE_SESSION_INFO = 'session-info.json'
export const OUTCOME_EXIT = Object.freeze({ answered: 0, failed: 1, interrupted: 1, refused: 10, 'out-of-time': 15, stopped: 16, 'not-attributed': 17 })
/** A run's own folders and files the outcome no longer needs: deleted on every outcome and by recovery. */
export const TRANSIENT = Object.freeze([ASK_RUN_FILES.home, ASK_RUN_FILES.project])

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
const fileHash = (path) => {
  try {
    return sha256(readFileSync(path))
  } catch {
    return null
  }
}

/** Every file under a folder, by its path inside it. */
function filesUnder(folder, base = folder) {
  let entries
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => entry.isDirectory() ? filesUnder(join(folder, entry.name), base) : [relative(base, join(folder, entry.name))])
}

/**
 * Why what is about to start is not what the check judged, or null when it is: the command whole,
 * the prompt and the message on standard input, the inputs' manifest and each picture and project
 * file it names, the app's configuration in the run's home, each against the receipt's hashes, and
 * last every entry the container binds from the run (agents-team-tree.mjs). `phase` `started` is
 * after the app's own start steps (OpenCode's sign-in import), which add only what its form allows.
 */
export function judgedChange(prepared, phase = 'check') {
  const receipt = prepared.verdict.receipt
  const folder = prepared.folder
  if (sha256(canonicalJson(prepared.argv)) !== receipt.argv_sha256) return 'the command is not the one the check judged'
  if (fileHash(join(folder, ASK_RUN_FILES.prompt)) !== receipt.snapshots?.prompt) return 'the prompt is not the one the check judged'
  if (receipt.snapshots?.message !== undefined && fileHash(join(folder, ASK_RUN_FILES.message)) !== receipt.snapshots.message) return 'the message on standard input is not the one the check judged'
  const manifest = readJsonOrNull(join(folder, ASK_RUN_FILES.manifest))
  if (manifest === null || sha256(canonicalJson(manifest)) !== receipt.inputs_sha256) return 'the inputs\' manifest is not the one the check judged'
  for (const picture of manifest.pictures ?? []) {
    if (fileHash(join(folder, ASK_RUN_FILES.inputs, picture.copy)) !== picture.sha256) return `the picture ${picture.label} is not the copy the check judged`
  }
  if (manifest.project !== undefined && manifest.project !== null) {
    const frozen = readJsonOrNull(join(folder, ASK_RUN_FILES.projectManifest))
    if (frozen === null || sha256(Buffer.from(JSON.stringify(frozen.files))) !== manifest.project.files_sha256) return 'the project\'s manifest is not the one the check judged'
    for (const file of frozen.files) {
      if (file.kind === 'file' && fileHash(join(folder, ASK_RUN_FILES.project, file.path)) !== file.sha256) return `the project's ${file.path} is not the copy the check judged`
    }
  }
  const snapshot = join(folder, ASK_RUN_FILES.snapshots, 'config')
  const hashes = {}
  for (const path of filesUnder(snapshot)) {
    const live = fileHash(join(folder, ASK_RUN_FILES.home, path))
    if (live === null || live !== fileHash(join(snapshot, path))) return `the run's ${path} is not the configuration the check judged`
    hashes[path] = live
  }
  if (sha256(canonicalJson(hashes)) !== receipt.snapshots?.config) return 'the run\'s configuration is not the one the check judged'
  if (receipt.snapshots?.hosts !== undefined && fileHash(join(folder, ASK_RUN_FILES.snapshots, 'hosts')) !== receipt.snapshots.hosts) return 'the run\'s /etc/hosts is not the one the check judged'
  return treeChange(folder, receipt, phase)
}

/**
 * Why a judged ask may not start now, or null: the approved team and the app's program as the check
 * saw them, then everything `judgedChange` compares. The start calls it, and the supervisor again
 * immediately before the container (72.3 AC1).
 */
export function startChange(prepared, phase = 'check') {
  const receipt = prepared.verdict.receipt
  let generation
  try {
    generation = readApproved()
  } catch (error) {
    return `the approved team could not be read (${error.message})`
  }
  if (generation.number !== receipt.generation?.number || generation.hash !== receipt.generation?.hash) {
    return `the approved team changed after the check (version ${receipt.generation?.number} then, ${generation.number} now)`
  }
  const identity = readJsonOrNull(join(prepared.folder, ASK_RUN_FILES.snapshots, 'executable.json'))
  if (identity === null || !prepared.program || !sameProgram(identity, prepared.program)) return 'the app\'s program changed after the check'
  return judgedChange(prepared, phase)
}

/**
 * Why the launch is not one `startAsk` writes for this run, or null: everything in it the supervisor
 * acts on is held to the run's receipt or to BMN's fixed limits and the owner's, so no field of it,
 * present, changed or left out, starts more than the check judged.
 */
function launchChange(folder, launch, receipt, now) {
  const message = receipt.snapshots?.message !== undefined
  if (launch.argv_sha256 !== receipt.argv_sha256) return 'the launch\'s command is not the one the check judged'
  if (launch.stdin !== join(folder, message ? ASK_RUN_FILES.message : ASK_RUN_FILES.prompt) || launch.stdin_sha256 !== (message ? receipt.snapshots.message : receipt.snapshots?.prompt)) {
    return 'the launch\'s standard input is not the one the check judged'
  }
  if (launch.args_fd !== true) return 'the launch puts bubblewrap\'s options on its command line'
  if (!(Number.isFinite(launch.deadline) && launch.deadline <= now + TIME_LIMIT.max * 60_000)) return 'the launch\'s time limit is not within BMN\'s'
  if (!(Number.isFinite(launch.output_limit) && launch.output_limit <= OUTPUT_LIMIT)) return 'the launch\'s output limit is not within BMN\'s'
  if (!(Number.isFinite(launch.storage_limit) && launch.storage_limit <= STORAGE_LIMIT)) return 'the launch\'s storage limit is not within BMN\'s'
  // Claude Code's runs keep the owner's per-ask token ceiling as he has it set.
  const ceiling = receipt.harness === 'claude' ? askSettings(dirname(folder)).token_ceiling : null
  if (ceiling !== null && !(Number.isInteger(launch.token_ceiling) && launch.token_ceiling <= ceiling)) return 'the launch\'s token ceiling is not within the owner\'s'
  return null
}

/**
 * The supervisor's last check before the container, run for every launch: the run's receipt as
 * the check wrote it, the launch held to it (launchChange), the team read from the asker's home
 * (the supervisor's environment holds it, never the launch), and the program at the paths its
 * identity names. Returns why it may not start, or null.
 */
export function launchCheck(folder, launch, { now = Date.now() } = {}) {
  const receipt = readJsonOrNull(join(folder, ASK_RUN_FILES.receipt))
  if (receipt === null) return 'the run holds no receipt of its check'
  const launched = launchChange(folder, launch, receipt, now)
  if (launched !== null) return launched
  const identity = readJsonOrNull(join(folder, ASK_RUN_FILES.snapshots, 'executable.json'))
  const program = typeof identity?.launcher?.path === 'string' && typeof identity?.payload?.path === 'string' ? { launcher: identity.launcher.path, payload: identity.payload.path } : null
  return startChange({ folder, argv: launch.argv, verdict: { receipt }, program }, 'started')
}

/**
 * Starts a judged ask. `prepared`: what `prepareAsk` returned with a PASS. The approved team and the
 * app's program must still be the ones the check saw; otherwise nothing starts (CHANGED). Returns
 * `{ pid, start }` of the supervisor; the run goes on whatever happens to the caller.
 */
export function startAsk(prepared, { now = new Date(), timeLimitMinutes = TIME_LIMIT.default, start = startTeamSupervisor, tokenCeiling = null } = {}) {
  const receipt = prepared.verdict.receipt
  const folder = prepared.folder
  // A run already given its outcome (recorded interrupted while it was prepared) is never started.
  const ended = readJsonOrNull(join(folder, ASK_RUN_FILES.outcome))
  if (ended !== null) throw new StartRefusal('CHANGED', `the run already ended (${ended.state}); nothing started`)
  const changed = startChange(prepared)
  if (changed !== null) throw new StartRefusal('CHANGED', `${changed}; nothing started`)
  const identity = readJsonOrNull(join(folder, ASK_RUN_FILES.snapshots, 'executable.json'))
  // An OpenCode run gets its own copy of BMN's OpenCode Go sign-in, for this run alone; its home goes on every outcome (72.5 AC1, AC2).
  if (receipt.harness === 'opencode') {
    const copied = copyGoSignInToRun(join(folder, ASK_RUN_FILES.home, 'oc'), { launcher: prepared.program.launcher, environment: { PATH: '/usr/bin:/bin' } })
    if (!copied.ok) throw new StartRefusal('SIGN_IN_UNAVAILABLE', `${copied.reason}; nothing started`)
    // The copy ran OpenCode's own program: it must still be the one the check judged.
    if (!sameProgram(identity, prepared.program)) throw new StartRefusal('CHANGED', 'the app\'s program changed while its sign-in was copied; nothing started')
    // The import adds only what OpenCode's form allows; everything the check judged is still there as it was.
    const imported = treeChange(folder, receipt, 'started')
    if (imported !== null) throw new StartRefusal('CHANGED', `${imported}; nothing started`)
  }
  const stdin = join(folder, receipt.snapshots?.message === undefined ? ASK_RUN_FILES.prompt : ASK_RUN_FILES.message)
  const launch = {
    // The supervisor checks the command and standard input against these hashes again just before it starts them.
    version: 1, argv: prepared.argv, argv_sha256: receipt.argv_sha256, deadline: now.getTime() + timeLimitMinutes * 60_000, time_limit_minutes: timeLimitMinutes,
    // A picture ask on Claude Code reads the one message the check judged; any other ask its prompt.
    stdin, stdin_sha256: receipt.snapshots?.message ?? receipt.snapshots?.prompt, args_fd: true, output_limit: OUTPUT_LIMIT,
    // The run's storage, all of its folder; the supervisor's last check (launchCheck, always run) holds every field here to the receipt and the limits.
    storage_limit: STORAGE_LIMIT,
    // The owner's per-ask token ceiling holds where the app reports usage while it runs: Claude Code alone (72.1); the supervisor watches it with watchAsk.
    ...(tokenCeiling !== null && receipt.harness === 'claude' ? { token_ceiling: tokenCeiling } : {})
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
/** A token count the app reported, added to a total: a field it left out makes the total unknown, never zero (R72-FR6). */
function addTokens(total, value) {
  return total === 'unknown' || typeof value !== 'number' || !Number.isFinite(value) ? 'unknown' : total + value
}

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
      // An error Codex recovers from (a stream it reconnects) is followed by a completed turn; one it does not ends the run.
      if (event.type === 'turn.completed') failure = null
      if (event.type === 'turn.completed' && event.usage !== null && typeof event.usage === 'object') {
        totals ??= { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 }
        totals.input_tokens = addTokens(totals.input_tokens, event.usage.input_tokens)
        totals.cached_input_tokens = addTokens(totals.cached_input_tokens, event.usage.cached_input_tokens)
        totals.output_tokens = addTokens(totals.output_tokens, event.usage.output_tokens)
        totals.reasoning_tokens = addTokens(totals.reasoning_tokens, event.usage.reasoning_output_tokens)
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
            input_tokens: addTokens(addTokens(0, event.usage.input_tokens), event.usage.cache_creation_input_tokens),
            cached_input_tokens: addTokens(0, event.usage.cache_read_input_tokens),
            output_tokens: addTokens(0, event.usage.output_tokens),
            reasoning_tokens: addTokens(0, event.usage.output_tokens_details?.thinking_tokens),
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
  // An answer is attributed to the model that gave it: a run whose model nothing names is not attributed (R72-NFR7).
  if (observed.model === null) problems.push(`nothing in the run names its model (${observed.model_source ?? 'unknown'})`)
  else if (!names.includes(observed.model)) problems.push(`the app ran ${observed.model}, not ${request.model}`)
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
  try {
    finishRun(folder)
  } catch (error) {
    // A finish that fails still ends the run: an outcome that says so, and its transient state gone.
    if (!existsSync(join(folder, ASK_RUN_FILES.outcome))) {
      const request = readJsonOrNull(join(folder, ASK_RUN_FILES.request)) ?? {}
      writeWhole(join(folder, ASK_RUN_FILES.outcome), `${JSON.stringify({ version: 1, id: request.id ?? null, state: 'failed', exit: OUTCOME_EXIT.failed, reason: `BMN could not finish the run: ${error instanceof Error ? error.message : String(error)}`, ended_at: new Date().toISOString() }, null, 2)}\n`)
    }
    throw error
  } finally {
    for (const part of TRANSIENT) rmSync(join(folder, part), { recursive: true, force: true })
    rmSync(join(folder, RUN_FILES.stop), { force: true })
    // Its capacity place is given back (agents-team-places.mjs placePath), once its outcome is written.
    rmSync(join(dirname(folder), '.places', `${basename(folder)}.json`), { force: true })
  }
}

function finishRun(folder) {
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
  let refusal = null
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
  } else if (exit.ended === 'storage') {
    outcome = 'failed'
    reason = `the run's storage went over ${STORAGE_LIMIT / 1024 / 1024 / 1024} GiB`
  } else if (exit.ended === 'changed') {
    outcome = 'refused'
    reason = exit.reason ?? 'what was judged changed before the start; nothing started'
    refusal = { code: 'CHANGED', reason }
  } else if (seen.answer === null || seen.answer.trim() === '') {
    outcome = 'failed'
    reason = seen.failure ?? (exit.code === 0 ? 'the app ended without an answer' : `the app ended with code ${exit.code ?? exit.signal ?? 'unknown'}`)
  } else if (seen.failure !== null || exit.code !== 0) {
    // Text before a failure is no answer: the app said it failed, or ended with an error code.
    outcome = 'failed'
    reason = seen.failure ?? `the app ended with code ${exit.code ?? exit.signal ?? 'unknown'}`
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
  // The transient state goes before the outcome is written: a crash between the two leaves a run recovery finishes, never a sign-in behind an outcome.
  for (const part of TRANSIENT) rmSync(join(folder, part), { recursive: true, force: true })
  writeWhole(join(folder, ASK_RUN_FILES.outcome), `${JSON.stringify({
    version: 1, id: request.id ?? null, state: outcome, exit: OUTCOME_EXIT[outcome], ...(reason === null ? {} : { reason }), ...(refusal === null ? {} : { refusal }),
    requested: { agent: request.agent ?? null, model: request.model ?? null, effort: request.effort ?? null },
    observed: seen.observed, usage: seen.usage, ...(seen.rateLimit === null ? {} : { rate_limit: seen.rateLimit }), problems: seen.problems,
    started_at: state.started_at ?? null, ended_at: exit.at ?? new Date().toISOString(), time_limit_minutes: readJsonOrNull(join(folder, RUN_FILES.launch))?.time_limit_minutes ?? null
  }, null, 2)}\n`)
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
  // A supervisor that ended with no outcome written (its finish step failed) leaves an interrupted run, never one still going.
  return { version: 1, state: now.state === 'unknown' ? 'accepted' : now.state === 'ended' ? 'interrupted' : now.state, exit: null }
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
