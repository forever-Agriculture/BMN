// MODULE: agents-check-base.mjs - the dispatch check (Epic 60.3) behind agents-check.mjs: its refusals, tested versions and next steps, and its traced file reads
import { closeSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'

export { NEXT_STEP, Refusal, firstLine, listDirectory, namesWebTool, optionalNames, optionalText, reachedForWeb, readBytes, readText, refuse, traceRead }

/**
 * Harness versions whose destination precedence BMN's tests were written against (Epic 60 spike,
 * 2026-10-09; OpenCode 2.0.28 on 2026-10-14, whose `opencode debug config` read the model from the
 * same global file, and 2.0.29 the same day, on which the helper form was measured, Story 70.1). Any installed version is supported (owner decision 2026-10-10: the apps
 * update faster than BMN can test them); this list only decides the word a receipt and Integrations ›
 * Health carry beside the version. The destination itself is resolved and checked at every
 * dispatch, and for OpenCode at every inspection.
 */
export const TESTED_HARNESS_VERSIONS = { codex: ['0.161.0'], claude: ['2.1.295'], opencode: ['2.0.28', '2.0.29', '2.0.32'] }
/**
 * Codex versions on which a test showed that `exec resume` talks to the destination the current
 * configuration resolves, not one saved with the session (60.3 AC8). A resume on any other
 * version is ROUTE_UNSUPPORTED.
 */
export const RESUME_TESTED_VERSIONS = { codex: [] }
/**
 * App versions whose research fence is verified in BMN's own code (60.10 AC2): none. Claude Code's
 * research form runs without one for a provider that may see private work; a public-only researcher
 * runs only on a version listed here. Codex is not listed by version here at all: its fence is shown
 * by the owner's test of exactly the installed version, kept on record (63.3, `fenceStanding`).
 */
export const RESEARCH_FENCE_VERSIONS = { claude: [], codex: [], opencode: [] }
/** A visibility record older than this proves nothing (60.3 AC5). */
export const VISIBILITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** A session is bound to its receipt only this soon after the check (60.3 AC8). */
export const BINDING_WINDOW_MS = 10 * 60 * 1000

const NEXT_STEP = {
  UNKNOWN_AGENT: 'name an agent from `bmn team --all`',
  PROPOSED: 'the owner activates this agent in Preferences > Agents > Team first',
  DISABLED: 'pick the next candidate from `bmn roster role <role>`',
  CALLED_BY_BMN: 'ask it with `bmn judge ask` (see `bmn judge --help`); no dispatch goes to it',
  NOT_A_RESEARCHER: 'pick a researcher the team names (Preferences > Agents > Models); only the owner names one, on the agent\'s own page',
  ROLE_UNKNOWN: 'name a role from the roster\'s ## roles',
  ROLE_INELIGIBLE: 'pick a candidate that holds this role (`bmn roster role <role>`)',
  CLASS_CANNOT_LEAD: 'only a knight or a queen leads; pick one',
  CLASS_CANNOT_DESIGN: 'only a rook or a queen designs; pick one',
  ROUTE_UNSUPPORTED: 'use a dispatch form BMN checks (`codex exec … -` or `claude -p`), exactly as documented',
  MODEL_MISMATCH: 'pass the agent\'s own model or an approved alias',
  EFFORT_UNSUPPORTED: 'pass an effort the agent lists and its role names (`bmn roster role <role>`)',
  READ_ONLY_REQUIRED: 'start the run so that it cannot write, with the items `bmn roster role <role> --json` gives; only the owner changes which roles are read-only (Preferences > Agents > Roles)',
  CONTEXT_MISMATCH: 'pass the context limit `bmn roster role --json` gives for this agent',
  TOOL_MISMATCH: 'pass exactly the tools `bmn roster role --json` gives for this agent',
  HOST_UNKNOWN: 'make the destination knowable (no unresolved base URL) or record the host in the roster',
  HOST_MISMATCH: 'dispatch to the host the roster approved, or have the owner approve the new host',
  WORKSPACE_UNKNOWN: 'pass an existing workspace path without ..',
  WORKSPACE_MISMATCH: 'run from, and point -C/--add-dir and --stdin at, a place inside the workspace (or the packet)',
  RESUME_UNBOUND: 'resume only with --resume-of the receipt that started that session and was bound to it, or start a fresh checked dispatch',
  HARNESS_UNKNOWN: 'install the app, or put it on PATH, so that its --version can be read',
  DATA_FORBIDDEN: 'move to the next candidate in the role\'s chain (`bmn roster role <role>`); this provider gets public work only',
  PACKET_INVALID: 'build a packet of files the public repository already serves and dispatch it through env -i claude -p --safe-mode --tools \'\''
}

/** What an OpenCode command refused for its form does next (70.2); the words for Codex and Claude Code stay as they are. */
export const OPENCODE_NEXT_STEP = 'use the OpenCode form `bmn roster role <role> --json` gives (env -i with BMN\'s folders, then opencode run --standalone --format json --agent bmn-helper -m <model>#<effort> --title <title>, the prompt on standard input), exactly as documented'

/** The one checked way to the web (64.1), in the words every hint uses. */
const WEB_QUESTION_COMMAND = 'bmn research ask'
/** What a refusal says next when the command reached for the web in a way the check cannot pass (64.2 AC1). */
export const WEB_NEXT_STEP = `to search the web, ask with \`${WEB_QUESTION_COMMAND}\` (the question on standard input, or --question-file); for anything else ${NEXT_STEP.ROUTE_UNSUPPORTED}`
/** One more line on a PASS whose tool list names a web tool outside a research run (64.2 AC2). */
export const WEB_TOOLS_NOTE = `Note: the app may deny WebSearch and WebFetch in this form (nobody answers its permission prompt); the checked way to the web is \`${WEB_QUESTION_COMMAND}\`.`

/**
 * Whether a refused command reached for the web: Claude Code's `--allowedTools`, or a Codex argument
 * or setting that switches web search on. Read from the refusal's own words and the command, so it
 * never changes a verdict or a code, only the hint beside one.
 */
function reachedForWeb(argv, message) {
  if (/^claude --allowed-?[Tt]ools(?:[= ]|$)/.test(message)) return true
  if (/^-c \S*web_search\S* is not a key /.test(message)) return true
  if (/^codex exec --search(?:[= ]|$)/.test(message)) return true
  if (/^codex exec --enable(?:[= ]|$)/.test(message)) {
    return argv.some((argument, index) => (argument === '--enable' && /web_search/.test(argv[index + 1] ?? '')) || /^--enable=.*web_search/.test(argument))
  }
  return false
}

/** Whether a Claude Code tool list names WebSearch or WebFetch, with or without a pattern after it. */
function namesWebTool(tools) {
  return typeof tools === 'string' && tools.split(/[,\s]+/).some((tool) => /^(?:WebSearch|WebFetch)(?:\(|$)/.test(tool))
}

class Refusal extends Error {
  constructor(code, message, detail = undefined) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

/** `detail` names the reason within a code, for a caller that words it for the owner without reading the message. */
function refuse(code, message, detail = undefined) {
  throw new Refusal(code, message, detail)
}

// ---------------------------------------------------------------------------------------------
// Reading files: every read this module makes goes through here, so a test can prove the list.

let traceRead = null
/** Test seam: called with every path the check reads or lists. */
export function setReadTracer(tracer) {
  traceRead = tracer
}

function readText(path) {
  traceRead?.(path)
  return readFileSync(path, 'utf8')
}

function readBytes(path) {
  traceRead?.(path)
  return readFileSync(path)
}

function listDirectory(path) {
  traceRead?.(path)
  return readdirSync(path, { withFileTypes: true })
}

/** The names in a folder, or none when it does not exist. */
function optionalNames(path) {
  try {
    return listDirectory(path).map((entry) => entry.name).sort()
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw new Refusal('HOST_UNKNOWN', `cannot read ${path} (${error.code})`)
  }
}

function optionalText(path) {
  try {
    return readText(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw new Refusal('HOST_UNKNOWN', `cannot read ${path} (${error.code})`)
  }
}

/** Only the first line of a file, read in bounded chunks: a Codex session record's metadata. */
function firstLine(path, limit = 8 * 1024 * 1024) {
  traceRead?.(path)
  const handle = openSync(path, 'r')
  try {
    const chunks = []
    let total = 0
    const buffer = Buffer.alloc(64 * 1024)
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.length, null)
      if (count === 0) break
      const newline = buffer.subarray(0, count).indexOf(10)
      if (newline !== -1) {
        chunks.push(Buffer.from(buffer.subarray(0, newline)))
        break
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)))
      total += count
      if (total > limit) return null
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    closeSync(handle)
  }
}
