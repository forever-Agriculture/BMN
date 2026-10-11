// MODULE: agents-guard.mjs - Epic 60.8: the decision a prompt hook takes, from the approved team on disk, before a prompt leaves a session the owner started
import { readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { APP_NAMES, RosterError } from './agents-roster.mjs'
import { everApproved, neverApproved, readApproved } from './agents-state.mjs'
import { destinationOf, privateWorkAnswer, resolveClaudeRoute, resolveCodexRoute, sessionRecordAt, sessionRecordFiles, workspaceRoot } from './agents-check.mjs'

/**
 * A lead the owner starts himself is not a dispatch, so `bmn roster check` never sees it. This is
 * the same question asked for that lead, at the moment a prompt is about to leave: where does this
 * session send work, and may that provider see private work in this workspace? It reads the
 * approved team, the agent process (`/proc/<pid>/cmdline`, `environ`, `cwd`) and the app's own
 * settings, and nothing else: no socket, no network, and never the prompt. Every folder is private
 * here, a public repository included, because a folder can hold files that were never pushed.
 * It is workflow protection (docs/agent-control.md): it stops a mistake, not a process that
 * removes the hook.
 */

/** The longest a decision may take before the prompt is stopped instead (60.8 AC2). */
export const GUARD_LIMIT_MS = 2000

/**
 * The event that carries a prompt in each app, and what BMN does with a "stop" there. Claude Code
 * and Codex document a prompt hook that answers `decision: block`; Cursor's terminal agent has no
 * measured way to stop a prompt, so the guard only warns in it. OpenCode has no prompt event.
 */
export const GUARD_APPS = {
  claude: { event: 'UserPromptSubmit', stops: true },
  codex: { event: 'UserPromptSubmit', stops: true },
  cursor: { event: 'beforeSubmitPrompt', stops: false }
}

/**
 * The app version on which a live test (a synthetic folder, the app pointed at a loopback address
 * that must receive nothing) showed the hook's answer stops the prompt. null: not measured yet.
 */
export const GUARD_MEASURED = { claude: null, codex: null }

/** Codex `-c` keys that can say where work goes; any other key is left to Codex and decides nothing here. */
const CODEX_DESTINATION_KEYS = ['model_provider', 'model_providers', 'profile', 'profiles', 'openai_base_url', 'chatgpt_base_url']

function tilde(path, home) {
  if (typeof home !== 'string' || home === '' || home === '/') return path
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * Whether the guard applies at all: `inactive` on an installation that never approved a team,
 * `active` with the approved data, or `broken` once something was approved and can no longer be
 * read, with the one step that mends it.
 */
export function guardState() {
  try {
    return { state: 'active', data: readApproved().data }
  } catch (error) {
    if (!(error instanceof RosterError)) return { state: 'broken', fix: 'BMN cannot read its approved team. Open BMN Preferences › Team and approve the team.' }
    if (error.code === 'NOT_APPROVED') {
      if (/earlier roster layout/.test(error.message)) {
        return { state: 'broken', fix: 'The approved team is from an earlier BMN. Open BMN Preferences › Team and approve it again.' }
      }
      if (!everApproved()) return { state: 'inactive' }
      return { state: 'broken', fix: 'The approved team is missing. Open BMN Preferences › Team and approve the team.' }
    }
    return { state: 'broken', fix: 'The approved team on disk is damaged. Open BMN Preferences › Team and approve the team.' }
  }
}

/** How the agent process was started and with what, as Linux reports it; null when any part cannot be read. */
export function readAgentProcess(procRoot, pid) {
  try {
    const argv = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').split('\0')
    while (argv.length > 0 && argv[argv.length - 1] === '') argv.pop()
    if (argv.length === 0) return null
    const env = {}
    for (const entry of readFileSync(`${procRoot}/${pid}/environ`, 'utf8').split('\0')) {
      const equals = entry.indexOf('=')
      if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1)
    }
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8')
    const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null
    let cwd = null
    try {
      cwd = readlinkSync(`${procRoot}/${pid}/cwd`)
    } catch {
      // The folder the app started in is one more place its settings may be; the event names another.
    }
    return { argv, env, cwd, start }
  } catch {
    return null
  }
}

/** The app's own arguments: a script run by node or bun is the program, not the interpreter. */
function programArguments(argv) {
  return /^(node|nodejs|bun)$/.test(basename(argv[0])) ? argv.slice(2) : argv.slice(1)
}

/**
 * What in an interactive start can say where work goes. For Claude Code that is `--settings`; for
 * Codex `-c` destination keys, `--profile`, `--cd` and the local-model switches. Everything else
 * (a model, a prompt) decides nothing here. `{ unknown }` when an override cannot be read.
 */
export function parseLaunch(agent, argv) {
  const args = programArguments(argv)
  const parsed = agent === 'codex'
    ? { harness: 'codex', command: 'codex', envMode: 'inherit', assignments: {}, config: [] }
    : { harness: 'claude', command: 'claude', envMode: 'inherit', assignments: {}, addDir: [] }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') break
    const equals = argument.startsWith('--') ? argument.indexOf('=') : -1
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    const key = agent === 'codex'
      ? { '-c': 'config', '--config': 'config', '-p': 'profile', '--profile': 'profile', '-C': 'cd', '--cd': 'cd' }[flag]
      : { '--settings': 'settings' }[flag]
    if (agent === 'codex' && (flag === '--oss' || flag === '--local-provider')) {
      return { unknown: `${flag} sends work to a local model server BMN does not read` }
    }
    if (key === undefined) continue
    const value = equals !== -1 ? argument.slice(equals + 1) : args[index + 1]
    if (value === undefined) return { unknown: `${flag} has no value` }
    if (equals === -1) index += 1
    if (key === 'config') {
      if (!value.includes('=')) return { unknown: `-c ${value} is not key=value` }
      const name = value.slice(0, value.indexOf('=')).trim().split('.')[0].replace(/^["']|["']$/g, '')
      if (CODEX_DESTINATION_KEYS.includes(name)) parsed.config.push(value)
    } else {
      if (parsed[key] !== undefined) return { unknown: `${flag} is given twice` }
      parsed[key] = value
    }
  }
  return parsed
}

function canonicalFolder(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return null
  try {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/**
 * The saved Codex session this prompt belongs to (60.8 AC1): `{ record }` when exactly one record
 * is found, reads, belongs to this session and names a provider; `{ unresolved }` with the reason
 * otherwise. Nothing here falls back to the current settings. A session with no record BMN can
 * read may be a new one or one that continues a saved one, and BMN cannot tell which from what it
 * sees, so it does not guess: the session may be sending work where it was saved to send it.
 *
 * The app must say which session the prompt belongs to, and the record must carry that same id:
 * a record the app names without an id, or a record that carries none, ties nothing to this
 * session. A record the app names is the only one looked at, and only when it really lies under
 * Codex's own sessions folder (links followed); a path anywhere else is never opened. Without a
 * named record the one that carries the session's id is taken. Of a record only its first line
 * is read.
 */
function codexSession(event, codexHome) {
  const id = event.session_id
  if (typeof id !== 'string' || id === '') return { unresolved: 'the app did not say which session this prompt belongs to' }
  const named = event.transcript_path
  let file
  if (named !== undefined && named !== null && named !== '') {
    if (typeof named !== 'string' || !isAbsolute(named)) return { unresolved: 'the saved record the app names for this session is not a place BMN can read' }
    let root
    let real
    try {
      root = realpathSync(`${codexHome}/sessions`)
      real = realpathSync(named)
    } catch {
      return { unresolved: 'the saved record the app names for this session is not there' }
    }
    if (!real.startsWith(`${root}/`)) return { unresolved: "the saved record the app names for this session is outside Codex's own sessions folder" }
    file = real
  } else {
    const files = sessionRecordFiles(codexHome, id)
    if (files.length === 0) return { unresolved: 'no saved record of this session was found' }
    if (files.length > 1) return { unresolved: 'more than one saved record carries this session\'s id' }
    file = files[0]
  }
  const record = sessionRecordAt(file)
  if (record === null || typeof record.provider !== 'string' || record.provider === '') return { unresolved: 'the saved record of this session cannot be read' }
  if (typeof record.id !== 'string' || record.id === '') return { unresolved: 'the saved record of this session does not say which session it is' }
  if (record.id !== id) return { unresolved: 'the saved record the app names belongs to another session' }
  return { record }
}

/** Where the session sends work: `{ destination }`, or `{ unknown }` with the reason in the owner's words. */
function sessionDestination(agent, data, event, agentProcess, folders) {
  if (agent === 'cursor') {
    // Cursor reports nothing BMN can read, so only what the owner said on Rules › Health counts.
    const said = data.harness_routes.find((entry) => entry.harness === 'cursor')
    if (said === undefined) return { unknown: 'Cursor does not report where it sends work, and nothing is recorded for it', fix: 'Say where Cursor sends work in BMN Preferences › Rules › Health.' }
    return { destination: { known: true, default: true, provider: said.provider, host: `default:${said.provider}`, basis: said.basis } }
  }
  if (!agentProcess.env.HOME) return { unknown: 'the session has no HOME, so BMN cannot tell which settings the app reads' }
  const parsed = parseLaunch(agent, agentProcess.argv)
  if (parsed.unknown !== undefined) return { unknown: parsed.unknown }
  let route = null
  let configHome = null
  for (const folder of folders) {
    const resolution = agent === 'codex' ? resolveCodexRoute(parsed, agentProcess.env, folder) : resolveClaudeRoute(parsed, agentProcess.env, folder)
    if (resolution.unsupported !== undefined) return { unknown: resolution.unsupported }
    if (resolution.route.basis === 'unknown') return { unknown: resolution.route.reason }
    if (route !== null && (route.basis !== resolution.route.basis || route.host !== resolution.route.host || route.provider !== resolution.route.provider)) {
      return { unknown: `the settings under ${folders[0]} and ${folder} name different destinations` }
    }
    route = resolution.route
    configHome = resolution.configHome
  }
  if (agent === 'codex') {
    const saved = codexSession(event, configHome)
    // No remedy is promised: whether a new session's first prompt already has a record is not something BMN has measured.
    if (saved.unresolved !== undefined) return { unknown: saved.unresolved, fix: 'BMN tells a Codex session\'s destination from the record Codex saves for it, and does not guess without one.' }
    if (saved.record.provider !== route.provider) {
      return { unknown: `this session was saved with the provider ${saved.record.provider} and the settings now name ${route.provider}` }
    }
  }
  const destination = destinationOf(data, agent, route)
  if (!destination.known) {
    return route.basis === 'default'
      ? { unknown: `nothing is recorded about where ${APP_NAMES[agent]} sends work`, fix: `Set it in BMN Preferences › Rules › Health.` }
      : { unknown: destination.reason }
  }
  if (destination.unapproved !== undefined) {
    return { unknown: `${APP_NAMES[agent]} now sends work to ${destination.provider}, and the team records ${destination.unapproved}`, fix: 'Set the destination again in BMN Preferences › Rules › Health.' }
  }
  if (destination.provider === null) {
    return { unknown: `no provider in the team lists the address ${destination.host}`, fix: 'Add that address to its provider in BMN Preferences › Team.', host: destination.host }
  }
  return { destination }
}

function stop(base, cause, line, more = {}) {
  return { ...base, outcome: 'stop', cause, line, allow: false, ...more }
}

/**
 * The decision for one prompt event. `input`: `{ agent, event, pid, procRoot }`, where `pid` is
 * the owner's agent process (0 when the process table could not tell). Returns `{ outcome:
 * 'pass' | 'stop', cause, … }`; a stop carries the one `line` the agent shows and, when the owner
 * could allow it, `allow: true` with the provider and workspace an exception would name.
 */
export function decide(input) {
  const { agent, event, pid, procRoot = '/proc' } = input
  const app = APP_NAMES[agent] ?? agent
  const base = { agent, app, pid: pid || null, start: null, folder: null, processFolder: null, workspace: null, provider: null, host: null, name: null }
  const state = guardState()
  if (state.state === 'inactive') return { ...base, outcome: 'pass', cause: 'inactive' }
  if (state.state === 'broken') return stop(base, 'state', `BMN stopped this prompt: ${state.fix}`)
  const data = state.data
  const agentProcess = pid ? readAgentProcess(procRoot, pid) : null
  if (agentProcess === null) {
    return stop(base, 'process', `BMN stopped this prompt: it cannot read how this ${app} session was started. Start ${app} again in a BMN session.`)
  }
  base.start = agentProcess.start
  const home = agentProcess.env.HOME
  const eventFolder = canonicalFolder(event.cwd)
  const startFolder = canonicalFolder(agentProcess.cwd)
  const folder = eventFolder ?? startFolder
  if (folder === null) return stop(base, 'process', `BMN stopped this prompt: it cannot read which folder this ${app} session works in. Start ${app} again in a BMN session.`)
  const workspace = workspaceRoot(folder)
  base.folder = folder
  // Where the process itself stands: Allow here compares it with where it stands at the press.
  base.processFolder = startFolder
  base.workspace = workspace
  const where = tilde(workspace, home)
  const found = sessionDestination(agent, data, event, agentProcess, [...new Set([startFolder, eventFolder].filter((entry) => entry !== null))])
  if (found.unknown !== undefined) {
    return stop(base, 'unknown', `BMN stopped this prompt: it cannot tell where this ${app} session sends work (${found.unknown}). ${found.fix ?? `Change that and start ${app} again.`}`,
      { host: found.host ?? null })
  }
  const destination = found.destination
  const provider = data.providers.find((entry) => entry.id === destination.provider)
  const providerName = provider?.name ?? destination.provider
  base.provider = { id: destination.provider, name: providerName }
  base.host = destination.host
  const candidates = data.agents.filter((entry) => entry.harness === agent && entry.provider === destination.provider)
  base.name = (candidates.find((entry) => (destination.default ? entry.host === 'default' : entry.host?.toLowerCase?.() === destination.host)) ?? candidates[0])?.name ?? null
  if (provider?.private_work === 'allowed') return { ...base, outcome: 'pass', cause: 'allowed' }
  if (destination.basis === 'owner-declared') {
    return stop(base, 'declared', `${providerName} can't see private work in ${where}: where ${app} sends work is your word, not something BMN inspected. Record it as inspected in BMN Preferences › Rules › Health.`)
  }
  const answer = privateWorkAnswer(data, destination, workspace)
  if (answer.allowed) return { ...base, outcome: 'pass', cause: 'exception', exception: answer.exception?.id ?? null }
  return stop(base, 'public-only', `${providerName} can't see private work in ${where}. Allow it in BMN.`, { allow: true })
}

function slow(input) {
  const app = APP_NAMES[input.agent] ?? input.agent
  return {
    agent: input.agent, app, pid: input.pid || null, start: null, folder: null, workspace: null, provider: null, host: null, name: null,
    outcome: 'stop', cause: 'slow', allow: false,
    line: `BMN stopped this prompt: it could not decide within ${GUARD_LIMIT_MS / 1000} seconds whether it may leave. Send it again.`
  }
}

/** The thread that decides could not start or ended without an answer: the prompt is stopped, never decided on this thread, whose reads the limit could not end. */
function unchecked(input) {
  const app = APP_NAMES[input.agent] ?? input.agent
  return {
    agent: input.agent, app, pid: input.pid || null, start: null, folder: null, workspace: null, provider: null, host: null, name: null,
    outcome: 'stop', cause: 'state', allow: false,
    line: 'BMN stopped this prompt: its check failed. Open BMN Preferences › Team; if the team shows no problem, start the session again.'
  }
}

const decidingThread = (data) => new Worker(new URL(import.meta.url), { workerData: data })

/**
 * `decide`, held to `limitMs` from its first read: the reads run on another thread so that one
 * which never returns (a folder on a dead network mount) ends as a stop, not as a hook the app
 * gives up on and a prompt that leaves unchecked. Nothing here reads on this thread, because a
 * read that held it would hold the limit too. An installation that never approved a team
 * answers without starting the thread. `startThread` is the seam for tests.
 */
export function decideWithin(input, limitMs = GUARD_LIMIT_MS, { startThread = decidingThread } = {}) {
  return new Promise((resolve) => {
    let worker = null
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker?.terminate()
      resolve(result)
    }
    const timer = setTimeout(() => finish(slow(input)), limitMs)
    const onThread = () => {
      if (settled) return
      try {
        worker = startThread({ bmnGuard: input })
        worker.once('message', finish)
        // Once a team was approved, a check that cannot run stops the prompt.
        worker.once('error', () => finish(unchecked(input)))
        worker.once('exit', () => finish(unchecked(input)))
      } catch {
        finish(unchecked(input))
      }
    }
    neverApproved().then((never) => {
      if (!never) return onThread()
      const app = APP_NAMES[input.agent] ?? input.agent
      return finish({ agent: input.agent, app, pid: input.pid || null, start: null, folder: null, processFolder: null, workspace: null, provider: null, host: null, name: null, outcome: 'pass', cause: 'inactive' })
    }, onThread)
  })
}

/** What the hook prints for the app to stop the prompt and show `line`; null where the app has no such answer. */
export function stopAnswer(agent, line) {
  return GUARD_APPS[agent]?.stops ? JSON.stringify({ decision: 'block', reason: line }) : null
}

/** One line for `bmn hooks check`: whether prompts are checked at all, and what the guard does in this app. */
export function guardStanding(agent) {
  const state = guardState()
  const app = APP_NAMES[agent] ?? agent
  if (GUARD_APPS[agent] === undefined) return `prompt guard: not available in ${app} (it has no prompt event BMN can answer)`
  if (state.state === 'inactive') return 'prompt guard: inactive (no team has been approved, so no prompt is checked)'
  const does = GUARD_APPS[agent].stops
    ? `stops a prompt that would send private work to a provider that may not see it${GUARD_MEASURED[agent] ? ` (measured on ${app} ${GUARD_MEASURED[agent]})` : ` (not yet measured on a live ${app})`}`
    : `only warns in ${app}`
  return state.state === 'broken' ? `prompt guard: stopping every prompt. ${state.fix}` : `prompt guard: active, ${does}`
}

if (!isMainThread && parentPort !== null && workerData !== null && typeof workerData === 'object' && workerData.bmnGuard !== undefined) {
  parentPort.postMessage(decide(workerData.bmnGuard))
}
