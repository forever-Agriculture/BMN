// MODULE: agents-team-run.mjs - Epic 72: an ask started exactly as it was judged, attributed from its own output with its sub-agents named and counted, finished into its record with credentials masked, and exported only as its allowlist says
import { spawnSync } from 'node:child_process'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256 } from './agents-roster.mjs'
import { readApproved } from './agents-state.mjs'
import { openCodeFolder, openCodeSessionInfo } from './agents-opencode.mjs'
import { ASK_RUN_FILES, sameProgram } from './agents-team-forms.mjs'
import { maskCredentials, maskedNames } from './agents-team-inputs.mjs'
import { browserRecord } from './agents-team-browser.mjs'
import { askSettings } from './agents-team-places.mjs'
import { RUN_FILES, requestStop, runState, startTeamSupervisor, writeWhole } from './agents-team-supervisor.mjs'

/**
 * An ask starts only as it was judged (R72-FR3, 72.3 AC1): the approved team, the app's program and
 * the run's inputs are checked again immediately before the start, and a change to any starts
 * nothing. Its supervisor owns the run from then on; the asking command only waits, and closing it
 * only detaches it (72.3 AC3). When the app has ended, the supervisor calls `finishAsk`, which reads
 * who answered from the app's own output and session records (72.3 AC2), naming the sub-agents the
 * teammate started and counting each usage record once (72.9 AC5), masks any credential in what came
 * back (R72-NFR5), and keeps the answer, the outcome, the usage and the project's state at the start
 * and the end in the run's record.
 */

/** The time limit of one ask, in minutes (the contract's "Limits"). */
export const TIME_LIMIT = Object.freeze({ default: 30, min: 1, max: 120 })
/** The app's raw output over which a run fails, and the answer kept. */
export const OUTPUT_LIMIT = 64 * 1024 * 1024
export const ANSWER_LIMIT = 1024 * 1024
/** What OpenCode recorded of an ask's sessions, read after the run (72.5): their info alone, never their messages. */
export const OPENCODE_SESSION_INFO = 'session-info.json'
/** Each final state and its exit code (the contract's "Exit codes"). */
export const OUTCOME_EXIT = Object.freeze({ answered: 0, failed: 1, interrupted: 1, refused: 10, 'out-of-time': 15, stopped: 16, 'not-attributed': 17 })
/** A run's own files the outcome no longer needs: deleted on every outcome and by recovery (Codex's last message, read into the record). */
export const TRANSIENT = Object.freeze([ASK_RUN_FILES.codexAnswer, RUN_FILES.status])

/** BMN's git, the one a form that reads history runs (72.1 AC1, 72.9 AC1). */
export const ASK_GIT = fileURLToPath(new URL('./ask-git.sh', import.meta.url))

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

/**
 * The project's commit and whether its tree is clean, as Git says it, read without taking Git's
 * optional locks so the reading writes nothing (R72-FR5, 72.9 AC6). Null fields where Git cannot say.
 */
export function projectState(root, { now = new Date() } = {}) {
  const git = (args) => spawnSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: homedir(), GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
  })
  const head = git(['rev-parse', '--verify', '-q', 'HEAD'])
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  const entries = status.status === 0 ? status.stdout.split('\0').filter((entry) => /^.. /u.test(entry)) : null
  return {
    commit: head.status === 0 ? head.stdout.trim() : null, clean: entries === null ? null : entries.length === 0, changed: entries === null ? null : entries.length,
    ...(status.status === 0 ? {} : { reason: `git status ended with ${status.status ?? status.signal ?? status.error?.code ?? 'an error'}` }), at: now.toISOString()
  }
}

/**
 * Why what is about to start is not what the check judged, or null when it is: the command whole,
 * its folder, the prompt and the message on standard input, the inputs' manifest and each picture it
 * names, and BMN's git where the form runs it, each against the receipt's hashes.
 */
export function judgedChange(prepared) {
  const receipt = prepared.verdict.receipt
  const folder = prepared.folder
  if (sha256(canonicalJson(prepared.argv)) !== receipt.argv_sha256) return 'the command is not the one the check judged'
  if (prepared.cwd !== receipt.cwd) return 'the folder the app starts in is not the one the check judged'
  try {
    if (!statSync(receipt.cwd).isDirectory()) return `${receipt.cwd} is not a folder`
  } catch {
    return `${receipt.cwd} is gone`
  }
  if (fileHash(join(folder, ASK_RUN_FILES.prompt)) !== receipt.snapshots?.prompt) return 'the prompt is not the one the check judged'
  if (receipt.snapshots?.message !== undefined && fileHash(join(folder, ASK_RUN_FILES.message)) !== receipt.snapshots.message) return 'the message on standard input is not the one the check judged'
  const manifest = readJsonOrNull(join(folder, ASK_RUN_FILES.manifest))
  if (manifest === null || sha256(canonicalJson(manifest)) !== receipt.inputs_sha256) return 'the inputs\' manifest is not the one the check judged'
  for (const picture of manifest.pictures ?? []) {
    if (fileHash(join(folder, ASK_RUN_FILES.inputs, picture.copy)) !== picture.sha256) return `the picture ${picture.label} is not the copy the check judged`
  }
  if (receipt.snapshots?.git !== undefined && fileHash(join(folder, ASK_RUN_FILES.bin, 'git')) !== receipt.snapshots.git) return 'BMN\'s git in the run is not the one the check judged'
  return null
}

/**
 * Why a judged ask may not start now, or null: the approved team and the app's program as the check
 * saw them, then everything `judgedChange` compares. The start calls it, and the supervisor again
 * immediately before the app (72.3 AC1).
 */
export function startChange(prepared) {
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
  return judgedChange(prepared)
}

/**
 * Why the launch is not one `startAsk` writes for this run, or null: everything in it the supervisor
 * acts on is held to the run's receipt or to BMN's fixed limits and the owner's, so no field of it,
 * present, changed or left out, starts more than the check judged.
 */
function launchChange(folder, launch, receipt, now) {
  const message = receipt.snapshots?.message !== undefined
  if (launch.argv_sha256 !== receipt.argv_sha256) return 'the launch\'s command is not the one the check judged'
  if (launch.cwd !== receipt.cwd) return 'the launch\'s folder is not the one the check judged'
  if (launch.stdin !== join(folder, message ? ASK_RUN_FILES.message : ASK_RUN_FILES.prompt) || launch.stdin_sha256 !== (message ? receipt.snapshots.message : receipt.snapshots?.prompt)) {
    return 'the launch\'s standard input is not the one the check judged'
  }
  if (!(Number.isFinite(launch.deadline) && launch.deadline <= now + TIME_LIMIT.max * 60_000)) return 'the launch\'s time limit is not within BMN\'s'
  if (!(Number.isFinite(launch.output_limit) && launch.output_limit <= OUTPUT_LIMIT)) return 'the launch\'s output limit is not within BMN\'s'
  // Claude Code's runs keep the owner's per-ask token ceiling as he has it set.
  const ceiling = receipt.harness === 'claude' ? askSettings(dirname(folder)).token_ceiling : null
  if (ceiling !== null && !(Number.isInteger(launch.token_ceiling) && launch.token_ceiling <= ceiling)) return 'the launch\'s token ceiling is not within the owner\'s'
  return null
}

/**
 * The supervisor's last check before the app, run for every launch: the run's receipt as the check
 * wrote it, the launch held to it (launchChange), the team read from the asker's home (the
 * supervisor's environment holds it, never the launch), and the program at the paths its identity
 * names. A project ask then notes the project's commit and state at the start. Returns why it may
 * not start, or null.
 */
export function launchCheck(folder, launch, { now = Date.now() } = {}) {
  const receipt = readJsonOrNull(join(folder, ASK_RUN_FILES.receipt))
  if (receipt === null) return 'the run holds no receipt of its check'
  const launched = launchChange(folder, launch, receipt, now)
  if (launched !== null) return launched
  const identity = readJsonOrNull(join(folder, ASK_RUN_FILES.snapshots, 'executable.json'))
  const program = typeof identity?.launcher?.path === 'string' && typeof identity?.payload?.path === 'string' ? { launcher: identity.launcher.path, payload: identity.payload.path } : null
  const changed = startChange({ folder, argv: launch.argv, cwd: launch.cwd, verdict: { receipt }, program })
  if (changed !== null) return changed
  if (typeof receipt.project === 'string') writeWhole(join(folder, ASK_RUN_FILES.projectStart), `${JSON.stringify({ version: 1, root: receipt.project, ...projectState(receipt.project) }, null, 2)}\n`)
  return null
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
  const stdin = join(folder, receipt.snapshots?.message === undefined ? ASK_RUN_FILES.prompt : ASK_RUN_FILES.message)
  const launch = {
    // The supervisor checks the command and standard input against these hashes again just before it starts them.
    version: 1, argv: prepared.argv, argv_sha256: receipt.argv_sha256, cwd: receipt.cwd, deadline: now.getTime() + timeLimitMinutes * 60_000, time_limit_minutes: timeLimitMinutes,
    // A picture ask on Claude Code reads the one message the check judged; any other ask its prompt.
    stdin, stdin_sha256: receipt.snapshots?.message ?? receipt.snapshots?.prompt, output_limit: OUTPUT_LIMIT,
    // The owner's per-ask token ceiling holds where the app reports usage while it runs: Claude Code alone (72.1); the supervisor watches it with watchAsk.
    ...(tokenCeiling !== null && receipt.harness === 'claude' ? { token_ceiling: tokenCeiling } : {})
  }
  writeWhole(join(folder, RUN_FILES.launch), `${JSON.stringify(launch, null, 2)}\n`)
  const started = start(folder)
  if (started.failed !== undefined) throw new StartRefusal('SCOPE_UNAVAILABLE', `the ask's supervisor could not start: ${started.failed}`)
  return started
}

// ---------------------------------------------------------------------------------------------
// Who answered, from the app's own output and session records

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

/** The environment the run's app was given (`env -i NAME=value …` in its launch), by name. */
function launchEnvironment(folder) {
  const argv = readJsonOrNull(join(folder, RUN_FILES.launch))?.argv ?? []
  const environment = {}
  if (argv[1] !== '-i') return environment
  for (const item of argv.slice(2)) {
    const equals = item.indexOf('=')
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(item)) break
    environment[item.slice(0, equals)] = item.slice(equals + 1)
  }
  return environment
}

/** A token count the app reported, added to a total: a field it left out makes the total unknown, never zero (R72-FR6). */
function addTokens(total, value) {
  return total === 'unknown' || typeof value !== 'number' || !Number.isFinite(value) ? 'unknown' : total + value
}

/** The first line of a file, read without reading the rest (a Codex rollout's first line is its session's meta). */
function firstLine(path, limit = 4 * 1024 * 1024) {
  const handle = openSync(path, 'r')
  try {
    const chunks = []
    const buffer = Buffer.alloc(256 * 1024)
    let size = 0
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null)
      if (read === 0) break
      const newline = buffer.subarray(0, read).indexOf(10)
      chunks.push(Buffer.from(buffer.subarray(0, newline === -1 ? read : newline)))
      size += read
      if (newline !== -1 || size >= limit) break
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    closeSync(handle)
  }
}

/**
 * The rollouts Codex wrote while the run went on, in the owner's Codex home (`sessions/YYYY/MM/DD`,
 * local days): each one's session, its parent session (a sub-agent's, `source.subagent.thread_spawn`)
 * and its file. Only files written since the run started are read, and only their first line.
 */
function codexRollouts(codexHome, from, to) {
  const found = new Map()
  const pad = (number) => String(number).padStart(2, '0')
  const days = new Set()
  for (let time = from - 86_400_000; time <= to + 86_400_000; time += 3_600_000) {
    const day = new Date(time)
    days.add(join(codexHome, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate())))
  }
  for (const day of days) {
    let names
    try {
      names = readdirSync(day)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      const path = join(day, name)
      try {
        if (statSync(path).mtimeMs < from - 60_000) continue
        const meta = JSON.parse(firstLine(path))
        if (meta?.type !== 'session_meta' || typeof meta.payload?.id !== 'string') continue
        const spawn = meta.payload.source?.subagent?.thread_spawn
        found.set(meta.payload.id, {
          path, parent: spawn?.parent_thread_id ?? meta.payload.parent_thread_id ?? null,
          name: spawn?.agent_nickname ?? meta.payload.agent_nickname ?? null, role: spawn?.agent_path ?? meta.payload.agent_path ?? null
        })
      } catch {
        // A file being written or not a rollout: not one of this run's.
      }
    }
  }
  return found
}

/** A sub-agent's own rollout: its model and effort, and its usage as Codex last counted it there (its own turns only, 72.9 AC2). */
function codexRolloutUsage(path) {
  let text
  try {
    if (statSync(path).size > 256 * 1024 * 1024) return { failed: 'its rollout is over 256 MiB' }
    text = readFileSync(path, 'utf8')
  } catch {
    return { failed: 'its rollout could not be read' }
  }
  let context = null
  let usage = null
  for (const line of text.split('\n')) {
    if (!line.includes('"turn_context"') && !line.includes('"token_count"')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type === 'turn_context') context ??= entry.payload
    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload.info?.total_token_usage) usage = entry.payload.info.total_token_usage
  }
  return { model: context?.model ?? null, effort: context?.effort ?? context?.reasoning_effort ?? null, usage }
}

const USAGE_BASIS = Object.freeze({
  codex: 'the teammate\'s own turns (turn.completed) plus each sub-agent\'s own rollout (its last token count), each counted once: a parent\'s figure does not include its sub-agents\' (72.9 AC2)',
  claude: 'Claude Code\'s own total for the whole run (result.modelUsage and total_cost_usd), sub-agents and web search included; each sub-agent\'s own count is shown, never added (72.9 AC2)',
  opencode: 'each session\'s own export, summed: the teammate\'s and each sub-agent\'s, each counted once; OpenCode keeps each session\'s own tokens (measured 2026-10-15)'
})

/**
 * What a run's own output says of it: the session, the model and effort with where each was read,
 * the answer, the usage with its source and aggregation basis, the sub-agents the teammate started,
 * and every problem with attribution. `request`: the run's `request.json` (requested model,
 * aliases, effort). Nothing the app does not report is made up: it is `unknown` or `incomplete`,
 * with the reason. A sub-agent is named and counted; a session BMN cannot identify is a problem.
 */
export function observeAsk(folder, harness, request, { startedAt = null, endedAt = null } = {}) {
  const { events } = eventsOf(folder)
  const problems = []
  const observed = { session: null, session_source: null, model: null, model_source: null, effort: null, effort_source: null }
  let answer = null
  let failure = null
  const usage = {
    input_tokens: 'unknown', cached_input_tokens: 'unknown', output_tokens: 'unknown', reasoning_tokens: 'unknown', reported_cost: 'unknown', billing: request.billing ?? 'unknown', source: 'unknown',
    aggregation: USAGE_BASIS[harness] ?? 'unknown', complete: false
  }
  let rateLimit = null
  const subagents = []
  if (harness === 'codex') {
    const first = events[0]
    if (first?.type === 'thread.started' && typeof first.thread_id === 'string') Object.assign(observed, { session: first.thread_id, session_source: 'thread.started' })
    const named = new Set()
    let totals = null
    for (const event of events) {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') named.add(event.thread_id)
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
    let stderr
    try {
      stderr = readFileSync(join(folder, RUN_FILES.stderr), 'utf8')
    } catch {
      stderr = ''
    }
    // Each thread's model and effort, from its own turn spans: the teammate's and each sub-agent's.
    const spans = new Map()
    for (const [, span] of stderr.matchAll(CODEX_TURN)) {
      const thread = spanField(span, 'thread.id')
      if (thread === undefined) continue
      named.add(thread)
      const entry = spans.get(thread) ?? { models: new Set(), efforts: new Set() }
      const model = spanField(span, 'model')
      const effort = spanField(span, 'codex.turn.reasoning_effort')
      if (model !== undefined) entry.models.add(model)
      if (effort !== undefined) entry.efforts.add(effort)
      spans.set(thread, entry)
    }
    const own = spans.get(observed.session) ?? { models: new Set(), efforts: new Set() }
    if (own.models.size === 1) Object.assign(observed, { model: [...own.models][0], model_source: 'turn span' })
    else if (own.models.size > 1) problems.push(`the teammate's turn spans name ${[...own.models].join(' and ')}`)
    else observed.model_source = 'unknown: no turn span of the teammate on standard error'
    if (own.efforts.size === 1) Object.assign(observed, { effort: [...own.efforts][0], effort_source: 'turn span' })
    else if (own.efforts.size > 1) problems.push(`the teammate's turn spans name the efforts ${[...own.efforts].join(' and ')}`)
    else observed.effort_source = 'unknown: no turn span of the teammate on standard error'
    // The sessions besides the teammate's: a sub-agent is one whose own rollout names the teammate (or one of its sub-agents) as its parent.
    let complete = totals !== null
    const others = [...named].filter((id) => id !== observed.session)
    const rollouts = observed.session === null ? new Map() : codexRollouts(launchEnvironment(folder).CODEX_HOME || join(launchEnvironment(folder).HOME || homedir(), '.codex'), startedAt ?? Date.now(), endedAt ?? Date.now())
    const known = new Set([observed.session])
    for (let grew = true; grew;) {
      grew = false
      for (const [id, rollout] of rollouts) {
        if (!known.has(id) && known.has(rollout.parent)) {
          known.add(id)
          grew = true
        }
      }
    }
    for (const id of [...known].filter((entry) => entry !== observed.session)) {
      const rollout = rollouts.get(id)
      const read = codexRolloutUsage(rollout.path)
      const span = spans.get(id)
      const tokens = read.usage === null || read.usage === undefined ? null : {
        input_tokens: read.usage.input_tokens ?? 'unknown', cached_input_tokens: read.usage.cached_input_tokens ?? 'unknown', output_tokens: read.usage.output_tokens ?? 'unknown', reasoning_tokens: read.usage.reasoning_output_tokens ?? 'unknown'
      }
      if (tokens === null) complete = false
      else if (totals !== null) for (const key of Object.keys(totals)) totals[key] = addTokens(totals[key], tokens[key])
      subagents.push({
        session: id, parent: rollout.parent, name: rollout.name, role: rollout.role, kind: 'Codex sub-agent',
        model: read.model ?? (span?.models.size === 1 ? [...span.models][0] : null), effort: read.effort ?? (span?.efforts.size === 1 ? [...span.efforts][0] : null),
        usage: tokens ?? 'incomplete', ...(tokens === null ? { usage_reason: read.failed ?? 'its rollout holds no token count' } : {}), record: rollout.path
      })
    }
    for (const id of others.filter((entry) => !known.has(entry))) problems.push(`the run named a session BMN cannot identify, ${id}: no rollout names it a sub-agent of the teammate`)
    if (totals !== null) Object.assign(usage, totals, { source: subagents.length === 0 ? 'turn.completed' : 'turn.completed and sub-agent rollouts' })
    usage.complete = complete
    if (!complete && subagents.some((entry) => entry.usage === 'incomplete')) usage.incomplete_reason = 'a sub-agent\'s usage could not be read from its rollout'
    // Codex also writes its last message with -o; it stands in only where the stream holds none.
    if (answer === null) {
      try {
        answer = readFileSync(join(folder, ASK_RUN_FILES.codexAnswer), 'utf8')
      } catch {
        answer = null
      }
    }
  } else if (harness === 'claude') {
    const first = events[0]
    if (first?.type === 'system' && first.subtype === 'init' && typeof first.session_id === 'string') {
      Object.assign(observed, { session: first.session_id, session_source: 'system init' })
      if (typeof first.model === 'string') Object.assign(observed, { model: first.model, model_source: 'system init' })
      if (first.apiKeySource === 'none' && usage.billing === 'unknown') usage.billing = 'subscription'
    }
    const sessions = new Set()
    const tasks = new Map()
    const taskModels = new Map()
    let result = null
    for (const event of events) {
      if (typeof event.session_id === 'string') sessions.add(event.session_id)
      const child = typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id !== ''
      if (event.type === 'assistant' && typeof event.message?.model === 'string') {
        if (child) taskModels.set(event.parent_tool_use_id, event.message.model)
        else if (observed.model !== null && event.message.model !== observed.model) problems.push(`an answer came from ${event.message.model}, not ${observed.model}`)
      }
      // A sub-agent Claude Code started (the Agent tool): named by its task, counted in the run's own total.
      if (event.type === 'system' && event.subtype === 'task_started' && typeof event.task_id === 'string') {
        tasks.set(event.task_id, { session: event.task_id, parent: observed.session, name: typeof event.description === 'string' ? event.description.slice(0, 200) : null, role: event.subagent_type ?? null,
          kind: 'Claude Code sub-agent', tool_use_id: event.tool_use_id ?? null, status: 'started', usage: 'counted in the run\'s total' })
      }
      if (event.type === 'system' && event.subtype === 'task_notification' && tasks.has(event.task_id)) {
        Object.assign(tasks.get(event.task_id), { status: event.status ?? 'ended', own_tokens: Number.isFinite(event.usage?.total_tokens) ? event.usage.total_tokens : 'unknown' })
      }
      if (event.type === 'rate_limit_event' && event.rate_limit_info !== null && typeof event.rate_limit_info === 'object') {
        const info = event.rate_limit_info
        rateLimit = { status: info.status ?? 'unknown', window: info.rateLimitType ?? 'unknown', utilization: info.utilization ?? 'unknown' }
      }
      if (event.type === 'result') result = event
    }
    if (result !== null) {
      if (result.subtype === 'success' && result.is_error === false && typeof result.result === 'string') answer = result.result
      else failure = typeof result.result === 'string' && result.result !== '' ? result.result : `the app ended with ${result.subtype ?? 'an error'}`
      const models = result.modelUsage !== null && typeof result.modelUsage === 'object' ? Object.values(result.modelUsage) : []
      if (models.length > 0) {
        const sum = (pick) => models.reduce((total, entry) => addTokens(total, pick(entry)), 0)
        Object.assign(usage, {
          input_tokens: addTokens(sum((entry) => entry.inputTokens), sum((entry) => entry.cacheCreationInputTokens)), cached_input_tokens: sum((entry) => entry.cacheReadInputTokens),
          output_tokens: sum((entry) => entry.outputTokens), reasoning_tokens: sum((entry) => entry.thinkingTokens), source: 'result.modelUsage', complete: true
        })
      } else if (result.usage !== null && typeof result.usage === 'object') {
        Object.assign(usage, {
          input_tokens: addTokens(addTokens(0, result.usage.input_tokens), result.usage.cache_creation_input_tokens), cached_input_tokens: addTokens(0, result.usage.cache_read_input_tokens),
          output_tokens: addTokens(0, result.usage.output_tokens), reasoning_tokens: addTokens(0, result.usage.output_tokens_details?.thinking_tokens),
          source: 'result.usage', aggregation: 'result.usage: the main conversation only', complete: tasks.size === 0
        })
        if (tasks.size > 0) usage.incomplete_reason = 'Claude Code reported no modelUsage, and result.usage leaves out the sub-agents'
      }
      if (typeof result.total_cost_usd === 'number') usage.reported_cost = result.total_cost_usd
    }
    for (const task of tasks.values()) {
      const model = task.tool_use_id === null ? null : taskModels.get(task.tool_use_id) ?? null
      delete task.tool_use_id
      subagents.push({ ...task, model, effort: null })
    }
    // Every event of a sub-agent names the teammate's session; another session is one BMN cannot identify.
    for (const id of [...sessions].filter((entry) => entry !== observed.session)) if (observed.session !== null) problems.push(`the run named a session BMN cannot identify, ${id}`)
    // Claude Code does not report its effort: it is the one the pinned command named.
    if (request.effort !== undefined) Object.assign(observed, { effort: request.effort, effort_source: 'pinned command (--effort)' })
  } else if (harness === 'opencode') {
    // Every event names the session (70.1); the model, its variant and the usage are in the sessions' own records, read after the run (finishAsk).
    if (typeof events[0]?.sessionID === 'string') Object.assign(observed, { session: events[0].sessionID, session_source: 'every event (sessionID)' })
    const sessions = new Set()
    const started = []
    for (const event of events) {
      if (typeof event.sessionID === 'string') sessions.add(event.sessionID)
      if (event.type === 'text' && typeof event.part?.text === 'string') answer = event.part.text
      if (event.type === 'error') failure = typeof event.error?.message === 'string' ? `OpenCode reported an error: ${event.error.message.slice(0, 200)}` : `OpenCode reported an error (${event.error?.type ?? 'unknown'})`
      if (event.type === 'tool_use' && ['subagent', 'task'].includes(event.part?.tool)) {
        const child = event.part.state?.metadata?.metadata?.sessionID ?? event.part.state?.metadata?.sessionId ?? null
        if (typeof child === 'string') started.push({ session: child, name: event.part.state?.input?.description ?? null, role: event.part.state?.input?.agent ?? null, status: event.part.state?.status ?? null })
      }
    }
    const record = readJsonOrNull(join(folder, OPENCODE_SESSION_INFO))
    const info = record?.info
    if (info !== undefined && info !== null && info.id === observed.session) {
      if (typeof info.model?.id === 'string') Object.assign(observed, { model: info.model.id, model_source: 'session export' })
      if (typeof info.model?.variant === 'string') Object.assign(observed, { effort: info.model.variant, effort_source: 'session export (variant)' })
      if (typeof info.model?.provider === 'string' && typeof request.provider === 'string' && info.model.provider !== request.provider) problems.push(`the session ran on ${info.model.provider}, not ${request.provider}`)
      const tokens = { input_tokens: info.tokens?.input ?? 'unknown', cached_input_tokens: info.tokens?.cache_read ?? 'unknown', output_tokens: info.tokens?.output ?? 'unknown', reasoning_tokens: info.tokens?.reasoning ?? 'unknown', reported_cost: info.reported_cost ?? 'unknown' }
      let complete = true
      for (const child of started) {
        const found = (record.subagents ?? []).find((entry) => entry.info?.id === child.session || entry.session === child.session)
        const own = found?.info
        if (own === undefined || own === null || own.parent !== observed.session) {
          complete = false
          subagents.push({ ...child, parent: own?.parent ?? null, kind: 'OpenCode sub-agent', model: own?.model?.id ?? null, effort: own?.model?.variant ?? null, usage: 'incomplete', usage_reason: found?.failed ?? 'its session export does not name the teammate as its parent' })
          continue
        }
        const childTokens = { input_tokens: own.tokens?.input ?? 'unknown', cached_input_tokens: own.tokens?.cache_read ?? 'unknown', output_tokens: own.tokens?.output ?? 'unknown', reasoning_tokens: own.tokens?.reasoning ?? 'unknown', reported_cost: own.reported_cost ?? 'unknown' }
        for (const key of Object.keys(tokens)) tokens[key] = addTokens(tokens[key], childTokens[key])
        subagents.push({ ...child, parent: own.parent, kind: 'OpenCode sub-agent', model: own.model?.id ?? null, effort: own.model?.variant ?? null, usage: childTokens })
      }
      Object.assign(usage, tokens, { source: started.length === 0 ? 'session export' : 'session exports', complete })
      if (!complete) usage.incomplete_reason = 'a sub-agent\'s session could not be read'
    } else {
      const why = record?.failed ?? 'no session export'
      Object.assign(observed, { model_source: `unknown: ${why}`, effort_source: `unknown: ${why}` })
      usage.source = `unknown: ${why}`
    }
    for (const id of [...sessions].filter((entry) => entry !== observed.session)) if (observed.session !== null) problems.push(`the run named a session BMN cannot identify, ${id}`)
  }
  if (observed.session === null) problems.push('the run named no session in its first event')
  const names = [request.model, ...(request.aliases ?? [])]
  // An answer is attributed to the model that gave it: a run whose model nothing names is not attributed (R72-NFR7).
  if (observed.model === null) problems.push(`nothing in the run names its model (${observed.model_source ?? 'unknown'})`)
  else if (!names.includes(observed.model)) problems.push(`the app ran ${observed.model}, not ${request.model}`)
  if (observed.effort !== null && observed.effort !== request.effort) problems.push(`the app ran at ${observed.effort}, not ${request.effort}`)
  // Usage is complete only where every usage record of the run (the teammate's and each sub-agent's) was read; a field the app left out stays unknown (R72-FR6).
  if (usage.complete !== true) usage.incomplete_reason ??= usage.source.startsWith('unknown') ? 'the app reported no usage' : 'not every usage record of the run could be read'
  return { observed, answer, failure, usage, rateLimit, problems, subagents }
}

// ---------------------------------------------------------------------------------------------
// The end of a run, called by its supervisor

/**
 * Reads an OpenCode ask's session records with OpenCode itself in BMN's folder, as 70.4 did for
 * research, and keeps only their info (`session-info.json`): the teammate's and each sub-agent's
 * model, variant, tokens and reported spend. The program is the one the run's snapshot names.
 */
function recordOpenCodeSessions(folder) {
  const { events } = eventsOf(folder)
  const session = events.find((event) => typeof event.sessionID === 'string')?.sessionID ?? null
  const children = events.filter((event) => event.type === 'tool_use' && ['subagent', 'task'].includes(event.part?.tool))
    .map((event) => event.part.state?.metadata?.metadata?.sessionID ?? event.part.state?.metadata?.sessionId ?? null).filter((id) => typeof id === 'string')
  const launcher = readJsonOrNull(join(folder, ASK_RUN_FILES.snapshots, 'executable.json'))?.launcher?.path
  const read = (id) => (typeof launcher === 'string' ? openCodeSessionInfo(id, openCodeFolder(), { launcher, environment: { PATH: launchEnvironment(folder).PATH ?? '/usr/bin:/bin' } }) : { failed: 'the run\'s program is not recorded' })
  writeWhole(join(folder, OPENCODE_SESSION_INFO), `${JSON.stringify({ version: 1, ...read(session), subagents: [...new Set(children)].map((id) => ({ session: id, ...read(id) })) }, null, 2)}\n`)
}

/** Masks any credential in the run's raw output in place, and says which patterns were masked (R72-NFR5). */
function maskOutput(folder) {
  const path = join(folder, RUN_FILES.events)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const masked = maskCredentials(text, { jsonLines: true })
  if (masked.masked.length > 0) writeWhole(path, masked.text)
  return masked.masked
}

/**
 * Finishes a run once its app has ended: the outcome and the answer into the record, then the run's
 * transient files deleted, whatever the outcome. An answer that cannot be attributed is kept only as
 * diagnostic evidence, never as the answer.
 */
export function finishAsk(folder) {
  try {
    finishRun(folder)
  } catch (error) {
    // A finish that fails still ends the run: an outcome that says so, and its transient files gone.
    if (!existsSync(join(folder, ASK_RUN_FILES.outcome))) {
      const request = readJsonOrNull(join(folder, ASK_RUN_FILES.request)) ?? {}
      writeWhole(join(folder, ASK_RUN_FILES.outcome), `${JSON.stringify({ version: 1, id: request.id ?? null, state: 'failed', exit: OUTCOME_EXIT.failed, reason: `BMN could not finish the run: ${error instanceof Error ? error.message : String(error)}`, ended_at: new Date().toISOString() }, null, 2)}\n`)
    }
    throw error
  } finally {
    for (const part of TRANSIENT) rmSync(join(folder, part), { recursive: true, force: true })
    // However the finish ended, no page snapshot or download of a browser ask stays (74.3 AC3).
    if (!existsSync(join(folder, ASK_RUN_FILES.browserRecord))) finishBrowser(folder)
    rmSync(join(folder, RUN_FILES.stop), { force: true })
    // Its capacity place is given back (agents-team-places.mjs placePath), once its outcome is written.
    rmSync(join(dirname(folder), '.places', `${basename(folder)}.json`), { force: true })
  }
}

/**
 * A browser ask's record (74.3 AC3): its pages and screenshots from the server's own session log,
 * written as `browser.json`; everything else the server left in `browser/` (page snapshots, downloads,
 * the log) is deleted. Nothing for any other ask.
 */
export function finishBrowser(folder) {
  const browser = readJsonOrNull(join(folder, ASK_RUN_FILES.manifest))?.browser
  if (browser === undefined || browser === null) return null
  const { record } = browserRecord(folder, browser)
  writeWhole(join(folder, ASK_RUN_FILES.browserRecord), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/** Finishes a run: from its supervisor's exit record, or, after a crash, from `interrupted` with its reason (recovery). */
export function finishRun(folder, { interrupted = null } = {}) {
  const request = readJsonOrNull(join(folder, ASK_RUN_FILES.request)) ?? {}
  const receipt = readJsonOrNull(join(folder, ASK_RUN_FILES.receipt)) ?? {}
  const exit = interrupted === null ? readJsonOrNull(join(folder, RUN_FILES.exit)) ?? { ended: 'failed' } : { ended: 'interrupted', reason: interrupted, at: new Date().toISOString() }
  const state = readJsonOrNull(join(folder, RUN_FILES.state)) ?? {}
  const harness = receipt.harness ?? null
  const started = exit.started !== false && existsSync(join(folder, RUN_FILES.events))
  // OpenCode keeps its usage in each session's own record: read in BMN's folder (72.5 AC2, 72.9 AC5).
  if (harness === 'opencode' && started) recordOpenCodeSessions(folder)
  const masked = { output: started ? maskOutput(folder) : [], answer: [] }
  // A browser ask's record, once the scope (and the browser's server in it) has ended: pages and screenshots kept, the rest gone (74.3 AC3).
  finishBrowser(folder)
  let seen
  try {
    seen = observeAsk(folder, harness, request, { startedAt: Date.parse(state.started_at ?? '') || null, endedAt: Date.parse(exit.at ?? '') || Date.now() })
  } catch (error) {
    seen = { observed: {}, answer: null, failure: `BMN could not read the run's output: ${error instanceof Error ? error.message : String(error)}`, usage: {}, rateLimit: null, problems: [], subagents: [] }
  }
  let outcome
  let reason = null
  let refusal = null
  if (exit.ended === 'interrupted') {
    outcome = 'interrupted'
    reason = exit.reason
  } else if (exit.ended === 'stopped') outcome = 'stopped'
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
  } else if (exit.ended === 'changed') {
    outcome = 'refused'
    reason = exit.reason ?? 'what was judged changed before the start; nothing started'
    refusal = { code: 'CHANGED', reason }
  } else if (exit.started === false) {
    outcome = 'failed'
    reason = exit.reason ?? 'the app could not be started'
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
    // A credential in the answer is masked before anything keeps or shows it (R72-NFR5, 72.9 AC6). The output was masked
    // first, so an answer read from it shows BMN's own mark where it held one; Codex's last-message file is masked here.
    const kept = maskCredentials(seen.answer)
    masked.answer = maskedNames(kept.text)
    const text = kept.text.endsWith('\n') ? kept.text : `${kept.text}\n`
    writeWhole(join(folder, outcome === 'answered' ? ASK_RUN_FILES.answer : 'diagnostic-answer.md'), text)
  }
  for (const part of TRANSIENT) rmSync(join(folder, part), { recursive: true, force: true })
  const projectStart = readJsonOrNull(join(folder, ASK_RUN_FILES.projectStart))
  const project = typeof receipt.project === 'string'
    ? { root: receipt.project, start: projectStart === null ? null : { commit: projectStart.commit, clean: projectStart.clean, changed: projectStart.changed, at: projectStart.at }, end: started ? projectState(receipt.project) : null }
    : null
  writeWhole(join(folder, ASK_RUN_FILES.outcome), `${JSON.stringify({
    version: 1, id: request.id ?? null, state: outcome, exit: OUTCOME_EXIT[outcome], ...(reason === null ? {} : { reason }), ...(refusal === null ? {} : { refusal }),
    requested: { agent: request.agent ?? null, model: request.model ?? null, effort: request.effort ?? null },
    observed: seen.observed, subagents: seen.subagents ?? [], usage: seen.usage, ...(seen.rateLimit === null ? {} : { rate_limit: seen.rateLimit }), problems: seen.problems,
    ...(masked.answer.length + masked.output.length > 0 ? { credentials_masked: { answer: masked.answer, output: masked.output } } : {}),
    ...(project === null ? {} : { project }),
    started_at: state.started_at ?? null, ended_at: exit.at ?? new Date().toISOString(), time_limit_minutes: readJsonOrNull(join(folder, RUN_FILES.launch))?.time_limit_minutes ?? null
  }, null, 2)}\n`)
}

/** What the token ceiling has seen of each run this process watches: where it read to, and each model call's tokens. */
const watched = new Map()

/**
 * The supervisor's watch step for a Claude Code run under the owner's token ceiling: reads the
 * output added since the last call, counts each model call's input, cache and output tokens as
 * Claude Code reports them while it runs (the last report of each message counts; a sub-agent's
 * calls too), and returns why the run must end once the total is over the ceiling, else null.
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

/** What an export carries (the contract's record table): never the app's raw error stream or a session record of the app's own. */
export const EXPORTED = Object.freeze(['request.json', 'question.md', 'inputs', 'snapshots', 'receipt.json', 'launch.json', 'state.json', 'exit.json', 'events.jsonl', 'session-info.json', 'project-start.json', 'browser.json', 'browser', 'answer.md', 'outcome.json'])

/** The launch with every environment value the app is given left out: names only. */
function launchWithoutValues(launch) {
  const argv = [...launch.argv]
  if (argv[1] === '-i') {
    for (let index = 2; index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[index]); index += 1) argv[index] = `${argv[index].slice(0, argv[index].indexOf('='))}=(not exported)`
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
    } else if (name === ASK_RUN_FILES.browser) {
      // Only the screenshots the record names: never a page snapshot or download of a run still going (74.3 AC3).
      const shots = readJsonOrNull(join(folder, ASK_RUN_FILES.browserRecord))?.screenshots ?? []
      if (shots.length > 0) mkdirSync(join(output, name), { mode: 0o700 })
      for (const shot of shots) {
        const path = join(source, basename(String(shot.name)))
        if (existsSync(path) && statSync(path).isFile()) cpSync(path, join(output, name, basename(String(shot.name))))
      }
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
