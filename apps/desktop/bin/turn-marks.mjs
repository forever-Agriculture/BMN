// MODULE: turn-marks.mjs - which hook events mark the start and the end of a turn, for the apps measured to wait for their prompt hook (Epic 69, docs/turn-changes.md)
//
// A mark carries where and which turn, never what was typed: the prompt's text is looked at here, for
// one fixed beginning only, and goes nowhere. Nothing in this file reads or names a file of the owner's.
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/**
 * The apps whose turns BMN records, the version each was measured on, the event that carries a prompt, and
 * when that event comes for a prompt typed while a turn runs. The window and the host read the same record
 * from the protocol package (`TURN_RECORDED_APPS` in shared/protocol/src/turn-changes.ts); a test holds the
 * two together. An app that is not here sends no mark.
 */
export const TURN_MARKS = {
  claude: { version: '2.1.296', promptEvent: 'UserPromptSubmit', promptArrives: 'typed' },
  codex: { version: '0.162.1', promptEvent: 'UserPromptSubmit', promptArrives: 'taken' }
}

/** How long everything a mark adds to a prompt may take, the answer and its confirmation included. */
export const TURN_MARK_LIMIT_MS = 300

/** The statuses after which the hook confirms that the answer arrived: a "before" that waits for that word. */
export const TURN_MARK_CONFIRMED = ['captured', 'incomplete']

const APP_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }
const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
/** The event field that names the turn, per app. */
const TURN_FIELD = { claude: 'prompt_id', codex: 'turn_id' }
/**
 * What ends a turn, per app, as it was measured. Claude Code sends nothing for an interrupt, and neither app
 * was seen to send an event of its own for an error: the kind `error` waits for one that is measured.
 */
const END_EVENTS = {
  claude: { Stop: 'finished' },
  codex: { Stop: 'finished', Interrupt: 'interrupted' }
}
/** How Claude Code begins the prompt it sends itself when work it left running has ended: the app going on, not the owner typing. */
const TASK_NOTIFICATION = '<task-notification>'

const nested = (event) => event.agent_id !== undefined && event.agent_id !== null

/**
 * What an event says of a turn, for the report every event already sends: the conversation, the turn's id
 * where the app gives one, and whether a sub-agent speaks. Empty for an app that is not recorded.
 */
export function turnFacts(agent, event) {
  if (!Object.hasOwn(TURN_MARKS, agent)) return {}
  const conversation = typeof event.session_id === 'string' && CONVERSATION.test(event.session_id) ? event.session_id.toLowerCase() : undefined
  if (conversation === undefined) return {}
  const turn = event[TURN_FIELD[agent]]
  return {
    conversation,
    ...(typeof turn === 'string' && TURN_ID.test(turn) ? { turn } : {}),
    ...(nested(event) ? { nested: true } : {})
  }
}

/**
 * The mark an event sends, or null: a prompt event starts a turn, an end event ends it. Only for a recorded
 * app and its main conversation; a sub-agent's event marks nothing. A stop the app continues from by itself
 * (Claude Code lists work in flight) is the end kind `continues`, and the prompt Claude Code sends itself
 * when that work ended is a start that says `continued`.
 */
export function turnMark(agent, event) {
  const measured = TURN_MARKS[agent]
  if (measured === undefined || nested(event)) return null
  const facts = turnFacts(agent, event)
  if (facts.conversation === undefined) return null
  const who = { app: agent, conversation: facts.conversation, ...(facts.turn === undefined ? {} : { turn: facts.turn }) }
  if (event.hook_event_name === measured.promptEvent) {
    const folder = typeof event.cwd === 'string' && isAbsolute(event.cwd) && event.cwd.length <= 4096 && !event.cwd.includes('\0') ? event.cwd : undefined
    const continued = agent === 'claude' && typeof event.prompt === 'string' && event.prompt.startsWith(TASK_NOTIFICATION)
    return { edge: 'start', ...who, ...(folder === undefined ? {} : { folder }), ...(continued ? { continued: true } : {}) }
  }
  const kind = END_EVENTS[agent]?.[event.hook_event_name]
  if (kind === undefined) return null
  const inFlight = agent === 'claude' && kind === 'finished' &&
    [event.background_tasks, event.session_crons].some((list) => Array.isArray(list) && list.length > 0)
  return { edge: 'end', kind: inFlight ? 'continues' : kind, ...who }
}

/**
 * Whether BMN records this session, as it wrote it down beside its control socket: every session of an
 * unarchived workspace since Story 75.4. Without the file the hook sends no mark at all. BMN decides again
 * when a mark arrives; this only spares a prompt the call.
 */
export function turnMarksWanted(socketPath, sessionId) {
  if (typeof socketPath !== 'string' || typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) return false
  return existsSync(turnSwitchFile(dirname(socketPath), sessionId))
}

/** The file whose presence says "recording is on for this session". */
export function turnSwitchFile(socketFolder, sessionId) {
  return join(socketFolder, 'turn-marks', sessionId)
}

/** One line for `bmn hooks check`: whether this app's turns are recorded, and on which version that was measured. */
export function turnStanding(agent) {
  const app = APP_NAMES[agent] ?? agent
  const measured = TURN_MARKS[agent]
  if (measured === undefined) return `turn changes: not recorded for ${app}; it was not measured to wait for its prompt hook`
  return `turn changes: recorded in every workspace that is not archived (waiting for the prompt hook measured on ${app} ${measured.version})`
}
