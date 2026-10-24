// MODULE: bmn-hook-runtime.mjs - the bmn command line behind bin/bmn: `bmn hook <agent>` on every hook event: the guards, messages, the away lock, phone decisions, observation
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isObject } from './shared-helpers.mjs'
import { CONVERSATION_REFERENCE, HOOK_TIMEOUT_MS, TIMEOUT_MS } from './bmn-words.mjs'
import { callEach } from './bmn-commands.mjs'
import { HOOK_AGENTS } from './bmn-opencode-plugin.mjs'
import { HOOK_WRAPPERS, PERMISSION_WAIT_MS, asyncUserInputTool, claudeConfigDir, hookEventName, hookRequests, openCodeSubagent, phoneAnswerable, retiredOr, userInputTool } from './bmn-hooks.mjs'

export { runHook }

/**
 * An agent passes the session's environment to everything it starts, including agents it runs from a tool call
 * (`claude -p`), so the environment alone cannot tell the owner's agent from a nested one. The agent is the nearest
 * ancestor that is not a shell, and the owner's is the foreground job of a terminal; tool calls run without one.
 * Returns the owner's agent pid, 0 when the process table cannot tell, or null for a nested agent.
 */
function interactiveAgentPid(procRoot) {
  if (!existsSync(procRoot)) return 0
  let pid = process.ppid
  for (let depth = 0; depth < 16 && pid > 1; depth += 1) {
    let stat
    try {
      stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
    } catch {
      return 0
    }
    const close = stat.lastIndexOf(')')
    const comm = stat.slice(stat.indexOf('(') + 1, close)
    const [, parent, group, , tty, foreground] = stat.slice(close + 2).split(' ')
    if (!HOOK_WRAPPERS.has(comm)) return Number(tty) !== 0 && Number(group) === Number(foreground) ? pid : null
    pid = Number(parent)
  }
  return 0
}

/**
 * Claude Code records each running session under its pid, with bridgeSessionId while Remote Control is connected.
 * The Claude app then notifies the owner's phone itself, so BMN does not page Telegram as well.
 */
function claudeRemoteControlled(agentPid, sessionId) {
  if (!agentPid || typeof sessionId !== 'string') return false
  const configDirectory = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  try {
    const session = JSON.parse(readFileSync(join(configDirectory, 'sessions', `${agentPid}.json`), 'utf8'))
    return isObject(session) && session.sessionId === sessionId &&
      typeof session.bridgeSessionId === 'string' && session.bridgeSessionId !== ''
  } catch {
    return false
  }
}

/**
 * The prompt guard (Story 60.8, docs/agent-control.md): decided here, from the approved team on
 * disk, before anything is sent anywhere, so it holds whether or not BMN is running. Only the
 * event's folder and session reference go into the decision; the prompt text never does. Returns
 * null when this event carries no prompt or the guard's own files are not installed.
 */
async function promptVerdict(agent, event, agentPid, procRoot) {
  let guard
  try {
    guard = await import('./agents-guard.mjs')
  } catch {
    return null
  }
  if (guard.GUARD_APPS[agent]?.event !== event.hook_event_name) return null
  const input = {
    agent, pid: agentPid, procRoot,
    event: { cwd: event.cwd, session_id: event.session_id, transcript_path: event.transcript_path }
  }
  let verdict
  try {
    verdict = await guard.decideWithin(input)
  } catch {
    verdict = {
      agent, app: HOOK_AGENTS[agent], pid: agentPid || null, start: null, folder: null, workspace: null, provider: null, host: null, name: null, outcome: 'stop', cause: 'state', allow: false,
      line: 'BMN stopped this prompt: its check failed. Open BMN Preferences › Agents; if the team shows no problem, start the session again.'
    }
  }
  return { verdict, answer: verdict.outcome === 'stop' ? guard.stopAnswer(agent, verdict.line) : null }
}

/** What BMN is told about a prompt decision: who and where, never what was typed. */
function guardReport(agent, event, verdict) {
  const outcome = verdict.outcome === 'pass' ? 'pass' : 'stop'
  if (outcome === 'pass') return { method: 'guard.report', params: { agent, outcome } }
  return {
    method: 'guard.report',
    params: {
      agent, outcome, cause: verdict.cause, line: verdict.line, allow: verdict.allow === true,
      ...(verdict.workspace === null ? {} : { workspace: verdict.workspace }),
      ...(verdict.provider === null ? {} : { providerId: verdict.provider.id, providerName: verdict.provider.name }),
      ...(verdict.name === null ? {} : { agentName: verdict.name }),
      ...(verdict.host === null ? {} : { host: verdict.host }),
      ...(verdict.pid === null || verdict.start === null ? {} : { pid: verdict.pid, start: verdict.start }),
      ...(verdict.folder === null ? {} : { folder: verdict.folder }),
      ...(verdict.processFolder === null || verdict.processFolder === undefined ? {} : { processFolder: verdict.processFolder }),
      ...(typeof event.session_id === 'string' && CONVERSATION_REFERENCE.test(event.session_id) ? { conversation: event.session_id.toLowerCase() } : {})
    }
  }
}

/**
 * Epic 66.4: hands the agent one message a peer session left for it. Only for the agent the owner typed into
 * the session (`agentPid` is its process), on an event of its main conversation, in an app whose answer after a
 * tool call was measured to reach the agent (docs/session-messages.md), and only when BMN said, in its answer
 * to this event's report, that something waits. The hook resolves where its agent sends work with the prompt
 * guard's own resolver and sends that whole destination with one `message.take`; BMN decides, with the folder
 * the message came from, whether that provider may read it. What comes back is printed in the app's measured
 * answer form and then reported as printed, which never means read. BMN's word that something waits, resolving,
 * taking and reporting share one limit, counted from `reported`, the moment the event's report was sent; past it
 * nothing is printed, and a claim BMN made anyway stays "taken, not confirmed". A brief BMN handed for this
 * event (Story 75.6) and the away state (Story 76.4) go first in the same answer; `said.printed` tells the caller that the
 * answer went out.
 */
async function handMessage(agent, event, agentPid, procRoot, socketPath, token, reported, before, said) {
  if (!agentPid || (event.agent_id !== undefined && event.agent_id !== null)) return
  let guard
  try {
    guard = await import('./agents-guard.mjs')
  } catch {
    return
  }
  const measured = guard.MESSAGE_HANDOVER[agent]
  if (measured === undefined || measured.event !== event.hook_event_name) return
  const left = () => guard.MESSAGE_LIMIT_MS - (Date.now() - reported)
  if (left() <= 0) return
  const destination = await guard.messageDestinationWithin({
    agent, pid: agentPid, procRoot,
    event: { cwd: event.cwd, session_id: event.session_id, transcript_path: event.transcript_path }
  }, left()).catch(() => null)
  if (destination === null || left() <= 0) return
  const take = { method: 'message.take', params: { agent, pid: agentPid, destination } }
  const report = (outcomes) => {
    const message = outcomes[0]?.result?.message
    if (!isObject(message) || typeof message.stamp !== 'string' || typeof message.text !== 'string') return undefined
    writeSync(1, contextAnswer(event, [...before, `${message.stamp}\n${message.text}`]))
    said.printed = true
    return { method: 'message.report', params: { messageId: message.messageId, claimId: message.claimId, pid: agentPid } }
  }
  await callEach(socketPath, token, [take, report], Math.max(1, left())).catch(() => undefined)
}

/** The one answer that puts text in front of the agent: BMN's brief, the away state, the departure and a message, in that order. */
function contextAnswer(event, parts) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: parts.filter((part) => part !== null).join('\n\n') }
  })
}

/**
 * Epic 69: marks where a turn starts, on a connection of its own. BMN scans the work tree and answers one status
 * word; when that word says it holds a "before", the hook confirms that the answer arrived, before it lets the
 * app go on, and only then does the scan count. The mark, its answer and the confirmation share one limit,
 * `until`, which the mark carries; past it the hook goes on. Nothing is printed, whatever comes back.
 */
async function markTurnStart(marks, mark, socketPath, token) {
  const requestId = randomUUID()
  const start = { method: 'turn.mark', params: { requestId, until: Date.now() + marks.TURN_MARK_LIMIT_MS, ...mark } }
  const confirm = (outcomes) => (marks.TURN_MARK_CONFIRMED.includes(outcomes[0]?.result?.status)
    ? { method: 'turn.mark', params: { requestId, edge: 'confirm', app: mark.app, conversation: mark.conversation, ...(mark.turn === undefined ? {} : { turn: mark.turn }) } }
    : undefined)
  await callEach(socketPath, token, [start, confirm], marks.TURN_MARK_LIMIT_MS).catch(() => undefined)
}

/**
 * Hooks must never disturb the agent: exit 0 whatever happens, and nothing on stdout, with these
 * exceptions: the answer that stops a prompt the guard refused, the refusal of a blocking question while the
 * owner said away (Story 76.4), and BMN's start brief, the away state and a message for its own agent, which
 * share one answer.
 */
async function runHook(args) {
  const [agent] = args
  if (args.length !== 1 || !Object.hasOwn(HOOK_AGENTS, agent)) {
    process.stderr.write(`bmn: ${await retiredOr(agent, `hook expects one agent: ${Object.keys(HOOK_AGENTS).join('|')}`)}\n`)
    return 0
  }
  if (process.stdin.isTTY) return 0
  let event
  try {
    event = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return 0
  }
  // Defence in depth: every branch below keys on `hook_event_name`, so nothing that is not an
  // object reaches one. No test can tell this line from its neighbours; it is not claimed as fenced.
  if (!isObject(event)) return 0
  // Story 83.4: the command guard decides first, from the command text alone, for every agent this entry runs for (a
  // dispatched one too), before any process, file or socket is read. It only ever holds; a command it does not hold goes on.
  if (event.hook_event_name === 'PreToolUse' && event.tool_name === 'Bash') {
    const answer = (await import('./command-guard.mjs').catch(() => null))?.guardAnswer(agent, event) ?? null
    if (answer !== null) {
      writeSync(1, answer)
      return 0
    }
    // Claude's Bash reaches this hook only for the guard (its matcher), so nothing else is delivered for it.
    if (agent === 'claude') return 0
  }
  const socketPath = process.env.BMN_CONTROL_SOCKET ?? process.env.AITERM_CONTROL_SOCKET
  const token = process.env.BMN_TOKEN ?? process.env.AITERM_TOKEN
  const procRoot = process.env.BMN_PROC_ROOT ?? process.env.AITERM_PROC_ROOT ?? '/proc'
  // An agent another agent started is a dispatch: `bmn roster check` answers for it, not this hook.
  const agentPid = interactiveAgentPid(procRoot)
  if (agentPid === null) return 0
  // Cursor can also run Claude Code's hook files for its own agent (Epic 71: retired, its support kept at the tag
  // cursor-support-final); such a payload speaks for a Cursor chat, never for a Claude conversation, and BMN takes none.
  if (agent === 'claude' && Object.hasOwn(event, 'cursor_version')) return 0
  const guarded = await promptVerdict(agent, event, agentPid, procRoot)
  const stopped = guarded !== null && guarded.answer !== null
  // The answer goes out before any socket call: a BMN that is closed or slow never delays the stop.
  if (stopped) writeSync(1, guarded.answer)
  if (!socketPath || !token) return 0
  const report = guarded === null || guarded.verdict.cause === 'inactive' ? [] : [guardReport(agent, event, guarded.verdict)]
  if (stopped) {
    // The prompt went nowhere, so nothing about the turn changed; BMN only learns why.
    await callEach(socketPath, token, report, HOOK_TIMEOUT_MS).catch(() => undefined)
    return 0
  }
  // Epic 69: a turn's start and end, only for the agent typed into this session (`agentPid` is its process), its
  // main conversation, an app measured to wait for its prompt hook, and a workspace whose switch BMN wrote down
  // as on. Everywhere else nothing below adds a call or a parameter.
  const marks = agentPid ? await import('./turn-marks.mjs').catch(() => null) : null
  const turns = marks !== null && marks.turnMarksWanted(socketPath, process.env.BMN_SESSION_ID ?? process.env.AITERM_SESSION_ID)
  const mark = turns ? marks.turnMark(agent, event) : null
  const marked = Date.now()
  if (mark?.edge === 'start') await markTurnStart(marks, mark, socketPath, token)
  // The end goes first among this event's calls: BMN answers "queued" at once and scans after the hook has gone.
  const ended = mark?.edge === 'end' ? [{ method: 'turn.mark', params: { requestId: randomUUID(), ...mark } }] : []
  // Epic 78: a permission the phone may answer gets its own single-use ref, and this hook waits for that answer.
  const permissionRef = phoneAnswerable(agent, event, { pid: agentPid, procRoot }) ? randomUUID() : null
  const requests = [...ended, ...report, ...hookRequests(agent, event, permissionRef)]
  const opens = requests.filter((request) => request.method === 'attention.open')
  // Story 76.4 AC3: the typed agent's own blocking question, in its main conversation, can still be refused here, before its
  // native request opens; BMN says whether it is (only while the owner said away).
  const refusable = awayRefusableQuestion(agent, event) ? opens.find((request) => request.params.kind === 'question') : undefined
  if (refusable !== undefined) refusable.params.awayRefusable = true
  // Remote Control shows the Claude app's own notice, so BMN does not page a question too; a permission it still pages,
  // since the phone answers it from the card (owner card 2026-10-17: "Always send"; Story 78.5).
  if (agent === 'claude' && opens.some((request) => request.params.kind !== 'permission') && claudeRemoteControlled(agentPid, event.session_id)) {
    for (const request of opens) if (request.params.kind !== 'permission') request.params.phoneNotified = true
  }
  // One observation per event, whether or not it changed anything: an event that opened nothing is
  // exactly what the owner needs to see when a request they expected never arrived. It goes last, on the
  // same connection and timeout, so it can report what the calls before it actually did.
  const apiHost = hookApiHost(agent)
  const model = hookModel(agent, event)
  const observable = hookEventName(event.hook_event_name) !== undefined
  if (requests.length === 0 && !observable) return 0
  const configDir = agent === 'claude' ? claudeConfigDir() : undefined
  // What a message may add to an event is counted from the sending of this report, whose answer carries BMN's
  // word on whether one waits.
  let reported = Date.now()
  // Story 76.4 AC2 (the consultant's fence): BMN hands the away state only to a hook holding its conversation's lock, taken
  // before it asks and held until this process ends, so an older revision can never be printed after a newer one.
  const awayFacts = marks !== null && ['SessionStart', 'PostToolUse'].includes(event.hook_event_name) ? marks.turnFacts(agent, event) : {}
  const awayLock = awayFacts.conversation !== undefined && awayFacts.nested !== true && await holdAwayLock(agent, awayFacts.conversation)
  const calls = [...requests, (outcomes) => {
    reported = Date.now()
    // Story 75.6: a conversation's start names the conversation whatever turn changes do, so BMN can brief it once.
    // Story 76.4: and a tool call names it too, so the away state can follow the conversation it was handed to.
    const facts = marks !== null && (turns || ['SessionStart', 'PostToolUse'].includes(event.hook_event_name)) ? marks.turnFacts(agent, event) : {}
    return hookObservation(agent, event, requests, outcomes, apiHost, model, configDir, awayLock && facts.conversation !== undefined ? { ...facts, awayLock: true } : facts)
  }]
  const outcomes = await callEach(socketPath, token, calls, HOOK_TIMEOUT_MS).catch(() => [])
  // BMN's answer to the report of this event says when a message waits for this session and carries its start
  // brief when one is due; without either the hook adds nothing to the event.
  const refusal = refusable === undefined ? undefined : outcomes[requests.indexOf(refusable)]?.result
  if (refusal?.refused === true && typeof refusal.reason === 'string') {
    // The measured refusal (Story 76.2): both forms, each app reads the one it knows. Nothing else is printed for this event.
    writeSync(1, refusalAnswer(event, refusal.reason))
    return 0
  }
  const answer = outcomes[requests.length]?.result
  const brief = typeof answer?.brief === 'string' && answer.brief !== '' ? answer.brief : null
  const notice = awayLock && typeof answer?.awayNotice === 'string' && answer.awayNotice !== '' && Number.isSafeInteger(answer.awayRevision) &&
    typeof answer.awayClaim === 'string' ? answer.awayNotice : null
  // Story 84.3: he is leaving or away, and a run may ask him on one card; once per conversation and departure.
  const departure = typeof answer?.grantNotice === 'string' && answer.grantNotice !== '' ? answer.grantNotice : null
  const said = { printed: false }
  if (answer?.messageWaiting === true) {
    // Should one event ever carry both a turn's start and a message, they share the one allowance (R69-NFR5).
    await handMessage(agent, event, agentPid, procRoot, socketPath, token, mark?.edge === 'start' ? marked : reported, [brief, notice, departure], said)
      .catch(() => undefined)
  }
  if (!said.printed && (brief !== null || notice !== null || departure !== null)) {
    writeSync(1, contextAnswer(event, [brief, notice, departure]))
    said.printed = true
  }
  if (notice !== null && said.printed) {
    // Printed, never read: BMN keeps that this claim went out (Story 76.4 AC2); a lost report leaves it "claimed", and the
    // next hook to hold the lock is handed the current state again.
    await callEach(socketPath, token, [{ method: 'away.printed', params: { agent, conversation: awayFacts.conversation, revision: answer.awayRevision, claimId: answer.awayClaim } }], HOOK_TIMEOUT_MS)
      .catch(() => undefined)
  }
  const opened = permissionRef === null ? undefined : requests.findIndex((request) => request.params?.prompt?.requestRef === permissionRef)
  if (!said.printed && opened !== undefined && opened >= 0 && outcomes[opened]?.result !== undefined) {
    const decision = await phoneDecision(socketPath, token, permissionRef)
    if (decision !== null) writeSync(1, permissionAnswer(decision))
  }
  return 0
}

/**
 * Epic 78: waits for the phone's answer to this one permission request, asking BMN again every 25 s. Ends with
 * no decision the moment BMN says the request is over (answered at the desk, replaced, its process gone), the
 * phone cannot answer it, BMN cannot be reached, or the wait is spent; Claude's dialog then stays as it was.
 */
async function phoneDecision(socketPath, token, requestRef) {
  const until = Date.now() + PERMISSION_WAIT_MS
  while (Date.now() < until) {
    const wait = Math.max(0, Math.min(25, Math.floor((until - Date.now()) / 1000)))
    const call = { method: 'answer.take', params: { wait, requestRef } }
    const outcome = (await callEach(socketPath, token, [call], TIMEOUT_MS + wait * 1000).catch(() => []))[0]
    const result = outcome?.result
    if (!isObject(result) || !Array.isArray(result.answers)) return null
    const mine = result.answers.find((answer) => isObject(answer) && answer.requestRef === requestRef && answer.kind === 'permission')
    if (mine !== undefined) return mine.reply === 'once' ? 'allow' : mine.reply === 'reject' ? 'deny' : null
    if (result.waiting !== true) return null
  }
  return null
}

/** The hook's decision, and nothing more: never updated input, permissions or a mode (R78-NFR1). */
function permissionAnswer(decision) {
  const verdict = decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from the phone (BMN).' }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: verdict } })
}

/**
 * One hook at a time per conversation may be handed the away state (Story 76.4 AC2, the consultant's method): an abstract
 * socket name held by this process, which the kernel lets go when the process ends, whatever BMN does meanwhile, and which
 * is never taken from a living holder. A hook that cannot take it within about 100 ms asks for nothing; the state waits for
 * the next tool call. Elsewhere than Linux there is no such name and nothing is handed.
 */
async function holdAwayLock(agent, conversation) {
  if (process.platform !== 'linux') return false
  const name = `\0bmn-away-${createHash('sha256').update(`${agent}\0${conversation}`).digest('hex').slice(0, 40)}`
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const held = await new Promise((done) => {
      const server = createServer()
      server.once('error', () => done(false))
      server.listen({ path: name, exclusive: true }, () => { server.unref(); done(true) })
    })
    if (held) return true
    await new Promise((done) => setTimeout(done, 25))
  }
  return false
}

/** The typed agent's blocking question tool in its main conversation: never Codex's asynchronous one, never a permission. */
function awayRefusableQuestion(agent, event) {
  if (event.hook_event_name !== 'PreToolUse' || (event.agent_id !== undefined && event.agent_id !== null)) return false
  if (agent === 'claude') return event.tool_name === 'AskUserQuestion'
  return agent === 'codex' && userInputTool(event.tool_name) && !asyncUserInputTool(event.tool_name)
}

/** A PreToolUse refusal in the hook-specific form and the older decision form (measured in Story 76.2 for both apps). */
function refusalAnswer(event, reason) {
  return JSON.stringify({
    decision: 'block', reason,
    hookSpecificOutput: { hookEventName: event.hook_event_name, permissionDecision: 'deny', permissionDecisionReason: reason }
  })
}

/**
 * The hostname of the agent's own API base URL, so the utility can flag the model's maker. Only the
 * parsed host ever leaves this process: no scheme, path, query or credentials ride along, and an
 * unset or unparsable URL reports nothing rather than a guess.
 */
function hookApiHost(agent) {
  const variable = agent === 'claude' ? 'ANTHROPIC_BASE_URL' : agent === 'codex' ? 'OPENAI_BASE_URL' : null
  const value = variable === null ? undefined : process.env[variable]
  if (typeof value !== 'string' || value.trim() === '') return null
  let hostname
  try {
    hostname = new URL(value.trim()).hostname
  } catch {
    return null
  }
  // Only a host the utility accepts is sent: an odd one would make it refuse the whole observation.
  return hostname.length <= 255 && /^(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:.]+\])$/.test(hostname) ? hostname : null
}

/**
 * The model name the payload carried, trimmed and bounded to 128 printable UTF-16 units. Claude Code
 * puts it at `model`; BMN's OpenCode plugin sends `message.updated` with `{ info: { modelID } }`,
 * OpenCode 1's own shape (@opencode-ai/sdk EventMessageUpdated), which its OpenCode 2 plugin builds
 * from the model a step started with. Both are read here.
 */
function hookModel(agent, event) {
  const raw = typeof event.model === 'string' ? event.model
    : agent === 'opencode' && isObject(event.info) && typeof event.info.modelID === 'string'
      ? event.info.modelID
      : undefined
  if (raw === undefined) return undefined
  const printable = [...raw.trim()].filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
  // The utility counts UTF-16 units and refuses the whole observation above 128, so the cut is in
  // those units, and only between code points, never through a surrogate pair.
  let model = ''
  for (const ch of printable) {
    if (model.length + ch.length > 128) break
    model += ch
  }
  return model === '' ? undefined : model
}

/** JSON with object keys sorted at every depth and no whitespace; absent reads as `null`. */
function canonicalHookPart(value) {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalHookPart).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalHookPart(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Tool content never leaves this short-lived CLI process; the utility receives only a hash prefix. */
function toolFingerprint(event, agent) {
  const result = Object.hasOwn(event, 'tool_response') ? event.tool_response
    : Object.hasOwn(event, 'error') ? event.error : null
  // Claude writes a free-text `description` label, not part of the call, so retries with new labels still match.
  let input = event.tool_input
  if (agent === 'claude' && isObject(input) && Object.hasOwn(input, 'description')) {
    input = { ...input }
    delete input.description
  }
  const text = `${typeof event.tool_name === 'string' ? event.tool_name : ''}\0${canonicalHookPart(input)}\0${canonicalHookPart(result)}`
  return createHash('sha256').update(text.slice(0, 1_000_000)).digest('hex').slice(0, 16)
}

/**
 * One `hook.observe` call describing this event and what it changed. An effect is recorded only for a call
 * the host accepted: a Stop that found nothing to withdraw, or an open the host refused, leaves the list
 * empty, which is what the owner needs to see when a request they expected never arrived.
 */
function hookObservation(agent, event, requests, outcomes, apiHost = null, model = undefined, configDir = undefined, turn = {}) {
  const eventName = hookEventName(event.hook_event_name)
  if (eventName === undefined) return undefined
  const byMethod = { 'attention.open': 'opened', 'attention.withdraw': 'withdrew', 'attention.resolve': 'answered' }
  const effects = []
  requests.forEach((request, index) => {
    const outcome = outcomes[index]
    if (outcome === undefined || outcome.error !== undefined) return
    // Repeating an identical request changes nothing; the host says so and the log must not claim otherwise.
    if (isObject(outcome.result) && outcome.result.changed === false) return
    const effect = byMethod[request.method]
    if (effect !== undefined && !effects.includes(effect)) effects.push(effect)
  })
  // `source` and `toolName` take the same `RULES.source` shape as the event name: a tool called "Éditeur"
  // belongs in the log as much as one called "Bash".
  // Codex names what caused a compaction `trigger` (manual or auto), and a subagent's OpenCode
  // compaction is logged as the subagent's, so neither is counted as the owner's (Story 36.1). A subagent's OpenCode
  // run starting is not the owner's next message either, so it never resets the repeat watch (Story 92.2).
  const source = hookEventName(event.source) ??
    (agent === 'codex' && ['PreCompact', 'PostCompact'].includes(eventName) ? hookEventName(event.trigger)
      : agent === 'opencode' && ['session.compacted', 'session.status'].includes(eventName) && openCodeSubagent(event) ? 'subagent' : undefined)
  const toolName = hookEventName(event.tool_name)
  const fingerprint = (agent === 'claude' && ['PostToolUse', 'PostToolUseFailure'].includes(eventName)) ||
    (agent === 'codex' && eventName === 'PostToolUse') || (agent === 'opencode' && eventName === 'tool.execute.after')
    ? toolFingerprint(event, agent) : undefined
  return {
    method: 'hook.observe',
    params: {
      agent,
      event: eventName,
      effects,
      ...(source === undefined ? {} : { source }),
      ...(toolName === undefined ? {} : { toolName }),
      ...(fingerprint === undefined ? {} : { fingerprint }),
      ...(apiHost === null ? {} : { apiHost }),
      ...(model === undefined ? {} : { model }),
      ...(configDir === undefined ? {} : { claudeConfigDir: configDir }),
      // Epic 69: which conversation and turn this event belongs to, and whether a sub-agent speaks.
      ...turn
    }
  }
}
