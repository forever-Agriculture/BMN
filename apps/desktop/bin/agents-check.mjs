// MODULE: agents-check.mjs - Epic 60.3: `bmn roster check|explain|route|visibility|bind`, the fail-closed check before work leaves for another agent
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_NAMES, DESIGNER_ROLE, HARNESSES, LEAD_ROLE, RosterError, agentState, appName, canonicalJson, classRefusal, harnessPrivateWork, isCalled, isRetired, namedResearchers, parseYaml, projectChoiceCollisions, projectChoiceFor, projectChoiceProblem, publicOnlyReasons, resolvedDirectory, retiredProgram, retiredWords, roleEfforts, sha256 } from './agents-roster.mjs'
import { canonicalProject } from './agents-team-inputs.mjs'
import { readApproved, readApprovedWithFile, readValidRoster, stateDirectory } from './agents-state.mjs'
import { AgentsUsageError, EXIT, err, failWith, out, readOptions, usage } from './agents-cli.mjs'
import { publicRendering } from './agents-rules.mjs'
import { CLAUDE_CONTEXT_KEY, CLAUDE_TEST_ARGUMENTS, CODEX_CONTEXT_KEYS, CONTEXT_TEST_SIZE, checkContext, contextItems, contextTestFolder, provenControls, provenPrecedence, wholeNumber } from './agents-context.mjs'
import { RUN_TEST_APPS, appTools, checkRunTools } from './agents-tools.mjs'
import { ASK_APPS, ASK_FORMS_CHECKED, ASK_READS, ASK_RUN_FILES, ASK_UNSUPPORTED, appSearchPath, askCommand, askFormName, askProgram, claudePictureMessage, sameProgram } from './agents-team-forms.mjs'
import { BROWSER_STATEMENT, browserOrigin } from './agents-team-browser.mjs'
import { OPENCODE_ASK_AGENTS, OPENCODE_FOLDER_SHA256, OPENCODE_FORM_TESTED, OPENCODE_HELPER_AGENT, OPENCODE_HELPER_AGENT_SHA256, OPENCODE_RESEARCH_AGENT, OPENCODE_SESSION_ID, installOpenCodeFolder, openCodeAskConfig, openCodeEnvironment, openCodeFolder, openCodeFolderProblem, openCodeFolders } from './agents-opencode.mjs'

export { publicOnlyReasons }

/**
 * The check answers one question immediately before a dispatch: may this exact command, run from
 * this directory with this input, send this work to this agent? It reads the approved roster
 * generation only, resolves where the command would really go from a fixed list of configuration
 * keys, and refuses unless every answer is known and allowed. Everything is private unless a
 * visibility record proves it public, and a provider sees private work only when the owner's
 * approved answer, or an exception for that one workspace, says so. It governs only dispatches
 * that call it, and the window between the check and the exec stays open (docs/agent-control.md).
 */

/** Refusals, checked in this order; the first one found is reported (shared contract). */
export const REFUSALS = ['UNKNOWN_AGENT', 'APP_RETIRED', 'PROPOSED', 'DISABLED', 'NOT_A_RESEARCHER', 'ROLE_UNKNOWN', 'ROLE_INELIGIBLE', 'CLASS_CANNOT_LEAD', 'CLASS_CANNOT_DESIGN',
  'ROUTE_UNSUPPORTED', 'MODEL_MISMATCH', 'EFFORT_UNSUPPORTED', 'READ_ONLY_REQUIRED', 'CONTEXT_MISMATCH', 'TOOL_MISMATCH', 'HOST_UNKNOWN', 'HOST_MISMATCH',
  'WORKSPACE_UNKNOWN', 'WORKSPACE_MISMATCH', 'RESUME_UNBOUND', 'HARNESS_UNKNOWN', 'DATA_FORBIDDEN', 'PACKET_INVALID']

/**
 * Harness versions whose destination precedence BMN's tests were written against (Epic 60 spike,
 * 2026-10-09; OpenCode 2.0.28 on 2026-10-14, whose `opencode debug config` read the model from the
 * same global file, and 2.0.29 the same day, on which the helper form was measured, Story 70.1). Any installed version is supported (owner decision 2026-10-10: the apps
 * update faster than BMN can test them); this list only decides the word a receipt and Rules ›
 * Health carry beside the version. The destination itself is resolved and checked at every
 * dispatch, and for OpenCode at every inspection.
 */
export const TESTED_HARNESS_VERSIONS = { codex: ['0.161.0'], claude: ['2.1.295'], opencode: ['2.0.28', '2.0.29'] }
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
  PROPOSED: 'the owner activates this agent in Preferences > Team first',
  DISABLED: 'pick the next candidate from `bmn roster role <role>`',
  CALLED_BY_BMN: 'ask it with `bmn judge ask` (see `bmn judge --help`); no dispatch goes to it',
  NOT_A_RESEARCHER: 'pick a researcher the team names (Preferences > Team > Models); only the owner names one, on the agent\'s own page',
  ROLE_UNKNOWN: 'name a role from the roster\'s ## roles',
  ROLE_INELIGIBLE: 'pick a candidate that holds this role (`bmn roster role <role>`)',
  CLASS_CANNOT_LEAD: 'only a knight or a queen leads; pick one',
  CLASS_CANNOT_DESIGN: 'only a rook or a queen designs; pick one',
  ROUTE_UNSUPPORTED: 'use a dispatch form BMN checks (`codex exec … -` or `claude -p`), exactly as documented',
  MODEL_MISMATCH: 'pass the agent\'s own model or an approved alias',
  EFFORT_UNSUPPORTED: 'pass an effort the agent lists and its role names (`bmn roster role <role>`)',
  READ_ONLY_REQUIRED: 'start the run so that it cannot write, with the items `bmn roster role <role> --json` gives; only the owner changes which roles are read-only (Preferences > Team > Roles)',
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
export const WEB_QUESTION_COMMAND = 'bmn research ask'
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

// ---------------------------------------------------------------------------------------------
// Dispatch argv

const CODEX_VALUE_FLAGS = { '-C': 'cd', '--cd': 'cd', '-m': 'model', '--model': 'model', '-c': 'config', '--config': 'config',
  '-p': 'profile', '--profile': 'profile', '-s': 'sandbox', '--sandbox': 'sandbox', '-o': 'output', '--output-last-message': 'output' }
const CODEX_FLAGS = { '--skip-git-repo-check': 'skipGit', '--json': 'json', '--ephemeral': 'ephemeral' }
/** Arguments only a research run carries (63.3); any other dispatch that names one is refused, as before. */
const CODEX_RESEARCH_FLAGS = { '--strict-config': 'strictConfig' }
const CODEX_RESEARCH_VALUE_FLAGS = { '--disable': 'disable' }
const CLAUDE_VALUE_FLAGS = { '--model': 'model', '--effort': 'effort', '--output-format': 'outputFormat', '--tools': 'tools',
  '--permission-mode': 'permissionMode', '--mcp-config': 'mcpConfig', '--settings': 'settings', '--add-dir': 'addDir',
  '--append-system-prompt': 'appendSystemPrompt' }
const CLAUDE_FLAGS = { '-p': 'print', '--print': 'print', '--safe-mode': 'safeMode', '--no-session-persistence': 'noPersistence',
  '--strict-mcp-config': 'strictMcp' }
/** `-c` keys that cannot change destination, model or effort; anything else unlisted is refused. */
const CODEX_NEUTRAL_KEYS = ['approval_policy', 'mcp_servers', 'model_reasoning_summary', 'model_verbosity', 'hide_agent_reasoning',
  'show_raw_agent_reasoning', 'sandbox_mode']
const CODEX_ROUTE_KEYS = ['model', 'model_provider', 'model_reasoning_effort', 'profile', 'openai_base_url', 'chatgpt_base_url']
/** The settings that say how much a Codex run may do on the machine: its sandbox, and whether it may ask for more (63.2). */
const CODEX_ACCESS_KEYS = ['sandbox_mode', 'approval_policy']

function harnessOf(command) {
  const name = basename(command)
  if (name === 'codex') return 'codex'
  if (name === 'claude') return 'claude'
  if (name === 'opencode') return 'opencode'
  return null
}

/**
 * Parses exactly the dispatch forms dev-auto documents and nothing else: `codex exec [resume <id>]`,
 * `claude -p` and `opencode run`, each optionally behind `env -i NAME=value …`. Returns null for anything else.
 * `research` also admits the arguments only a research run carries.
 */
export function parseDispatch(argv, { research = false } = {}) {
  let index = 0
  let envMode = 'inherit'
  const assignments = {}
  if (argv.length > 0 && basename(argv[0]) === 'env') {
    if (argv[1] !== '-i') return { unsupported: 'env is accepted only as `env -i NAME=value … command`' }
    envMode = 'clean'
    index = 2
    while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index])) {
      const equals = argv[index].indexOf('=')
      assignments[argv[index].slice(0, equals)] = argv[index].slice(equals + 1)
      index += 1
    }
  }
  const command = argv[index]
  const harness = command === undefined ? null : harnessOf(command)
  if (harness === null) {
    const retired = command === undefined ? null : retiredProgram(command)
    return { unsupported: retired === null ? `${command ?? 'nothing'} is not a supported dispatch command (codex exec or claude -p)` : retiredWords(retired) }
  }
  const rest = argv.slice(index + 1)
  const base = { harness, command, envMode, assignments }
  if (harness === 'opencode') return parseOpenCode(rest, base)
  return harness === 'codex' ? parseCodex(rest, base, research) : parseClaude(rest, base)
}

const OPENCODE_VALUE_FLAGS = { '--format': 'format', '--agent': 'agent', '-m': 'model', '--model': 'model', '--title': 'title' }
/** Arguments of `opencode run` the form refuses, each with what it would do (70.1). */
const OPENCODE_REFUSED = {
  '--auto': 'it approves every permission not denied',
  '--session': 'it continues or creates a session other than the run\'s own', '-s': 'it continues or creates a session other than the run\'s own',
  '--continue': 'it continues your last session', '-c': 'it continues your last session',
  '--fork': 'it forks an earlier session into the run',
  '--server': 'it sends the run to a server BMN does not start',
  '--file': 'it attaches a file the check does not read', '-f': 'it attaches a file the check does not read'
}

/**
 * `opencode run` in the one form 70.1 measured: `--standalone` (a private server, never the background
 * service that serves the owner's terminals), `--format json` (it names the session the receipt binds),
 * `--agent`, `-m`/`--model` and `--title`, each once, and the prompt on standard input.
 */
function parseOpenCode(args, base) {
  if (args[0] !== 'run') return { unsupported: 'only `opencode run` is a supported OpenCode dispatch' }
  const parsed = { ...base, standalone: false }
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('-')) return { unsupported: `opencode run ${argument} is not a supported argument (the prompt goes through standard input, the checked --stdin file)` }
    const equals = argument.startsWith('--') ? argument.indexOf('=') : -1
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    if (flag === '--standalone' && equals === -1) {
      if (parsed.standalone) return { unsupported: '--standalone given twice' }
      parsed.standalone = true
      continue
    }
    if (Object.hasOwn(OPENCODE_REFUSED, flag)) return { unsupported: `opencode run ${flag} is not a supported argument: ${OPENCODE_REFUSED[flag]}` }
    if (Object.hasOwn(OPENCODE_VALUE_FLAGS, flag)) {
      const value = equals !== -1 ? argument.slice(equals + 1) : args[index + 1]
      if (value === undefined) return { unsupported: `${flag} needs a value` }
      if (equals === -1) index += 1
      const key = OPENCODE_VALUE_FLAGS[flag]
      if (parsed[key] !== undefined) return { unsupported: `${flag} given twice` }
      parsed[key] = value
      continue
    }
    return { unsupported: `opencode run ${argument} is not a supported argument` }
  }
  if (!parsed.standalone) return { unsupported: 'opencode run must carry --standalone: without it the run goes to the background service that serves your terminals' }
  if (parsed.format !== 'json') return { unsupported: 'opencode run must carry --format json, which names the session a receipt is bound to' }
  return parsed
}

function parseCodex(args, base, research = false) {
  if (args[0] !== 'exec') return { unsupported: 'only `codex exec` is a supported Codex dispatch' }
  const parsed = { ...base, config: [], disable: [], stdin: false, resume: null }
  const flags = research ? { ...CODEX_FLAGS, ...CODEX_RESEARCH_FLAGS } : CODEX_FLAGS
  const valueFlags = research ? { ...CODEX_VALUE_FLAGS, ...CODEX_RESEARCH_VALUE_FLAGS } : CODEX_VALUE_FLAGS
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === 'resume' && parsed.resume === null && !parsed.stdin) {
      const id = args[index + 1]
      if (id === undefined || id.startsWith('-')) return { unsupported: 'codex exec resume needs a session id' }
      parsed.resume = { id }
      index += 1
      continue
    }
    if (argument === '-') {
      if (parsed.stdin) return { unsupported: '- given twice' }
      parsed.stdin = true
      continue
    }
    const equals = argument.startsWith('--') ? argument.indexOf('=') : -1
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    if (Object.hasOwn(flags, flag) && equals === -1) {
      parsed[flags[flag]] = true
      continue
    }
    if (Object.hasOwn(valueFlags, flag)) {
      const value = equals !== -1 ? argument.slice(equals + 1) : args[index + 1]
      if (value === undefined) return { unsupported: `${flag} needs a value` }
      if (equals === -1) index += 1
      const key = valueFlags[flag]
      if (key === 'config' || key === 'disable') {
        parsed[key].push(value)
      } else {
        if (parsed[key] !== undefined) return { unsupported: `${flag} given twice` }
        parsed[key] = value
      }
      continue
    }
    return { unsupported: `codex exec ${argument} is not a supported argument (a prompt goes through - and --stdin)` }
  }
  if (!parsed.stdin) return { unsupported: 'codex exec must read its prompt from - (the checked --stdin file)' }
  return parsed
}

function parseClaude(args, base) {
  const parsed = { ...base, addDir: [] }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const equals = argument.startsWith('--') ? argument.indexOf('=') : -1
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    if (Object.hasOwn(CLAUDE_FLAGS, flag) && equals === -1) {
      parsed[CLAUDE_FLAGS[flag]] = true
      continue
    }
    if (Object.hasOwn(CLAUDE_VALUE_FLAGS, flag)) {
      const value = equals !== -1 ? argument.slice(equals + 1) : args[index + 1]
      if (value === undefined) return { unsupported: `${flag} needs a value` }
      if (equals === -1) index += 1
      const key = CLAUDE_VALUE_FLAGS[flag]
      if (key === 'addDir') {
        parsed.addDir.push(value)
      } else {
        if (parsed[key] !== undefined) return { unsupported: `${flag} given twice` }
        parsed[key] = value
      }
      continue
    }
    return { unsupported: `claude ${argument} is not a supported argument (the prompt goes through stdin)` }
  }
  if (!parsed.print) return { unsupported: 'only `claude -p` is a supported Claude dispatch' }
  return parsed
}

/** The environment the dispatched command will see: `env -i` starts empty. */
function dispatchEnvironment(parsed, environment) {
  return parsed.envMode === 'clean' ? { ...parsed.assignments } : { ...environment, ...parsed.assignments }
}

// ---------------------------------------------------------------------------------------------
// Configuration readers (named, non-secret keys only)

function unquoteToml(raw) {
  const text = raw.trim()
  if (/^"([^"\\]|\\.)*"$/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
  if (/^'[^']*'$/.test(text)) return text.slice(1, -1)
  return undefined
}

/**
 * How many more brackets a piece of TOML opens than it closes, counting none inside a quoted
 * string or a comment. `open` says a string was still open at its end: a value BMN cannot follow.
 */
function bracketBalance(text) {
  let depth = 0
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#') break
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
  }
  return { depth, open: quote !== null }
}

function tomlKeyPath(raw) {
  const parts = []
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y
  let index = 0
  while (index < raw.length) {
    pattern.lastIndex = index
    const match = pattern.exec(raw)
    if (!match) return null
    parts.push(match[1] !== undefined ? JSON.parse(`"${match[1]}"`) : match[2] ?? match[3])
    index = pattern.lastIndex
    if (match[4] === '') break
  }
  return parts
}

/**
 * Codex's config.toml, reduced to the keys that decide model, effort and destination. A named key
 * whose value this reader cannot understand is recorded as unreadable, which makes the route
 * unknown rather than guessed. Everything else in the file is skipped unread.
 */
export function readCodexConfig(text) {
  const out = { top: {}, profiles: {}, providers: {}, unreadable: [], context: { top: {}, profiles: {}, unreadable: null }, access: { top: {}, profiles: {}, unreadable: null } }
  if (text === null) return out
  let table = []
  let skipUntil = null
  let depth = 0
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s+|\s+$/g, '')
    if (skipUntil !== null) {
      if (line.includes(skipUntil)) skipUntil = null
      continue
    }
    if (depth > 0) {
      const balance = bracketBalance(line)
      if (balance.open) out.unreadable.push('a value that spans lines')
      depth = Math.max(0, depth + balance.depth)
      continue
    }
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      const header = /^\[\[?\s*(.*?)\s*\]\]?\s*(#.*)?$/.exec(line)
      table = header ? tomlKeyPath(header[1]) ?? ['?'] : ['?']
      continue
    }
    const equals = line.indexOf('=')
    if (equals === -1) continue
    const keys = tomlKeyPath(line.slice(0, equals).trim())
    let value = line.slice(equals + 1).trim().replace(/\s+#[^"']*$/, '')
    if (value.startsWith('"""') || value.startsWith("'''")) {
      const marker = value.slice(0, 3)
      if (value.length < 6 || !value.endsWith(marker)) skipUntil = marker
      value = null
    } else if (value.startsWith('[') || value.startsWith('{')) {
      const balance = bracketBalance(value)
      if (balance.open) out.unreadable.push('a value that spans lines')
      depth = Math.max(0, balance.depth)
    }
    if (keys === null) continue
    const path = [...table, ...keys]
    const record = (target, key) => {
      const text = value === null ? undefined : unquoteToml(value)
      if (text === undefined) out.unreadable.push(path.join('.'))
      else target[key] = text
    }
    // A context limit is a number; one BMN cannot read never makes the destination unknown, only the limit.
    const size = (target, key) => {
      const number = value === null ? null : wholeNumber(value)
      if (number === null) out.context.unreadable ??= `config.toml ${path.join('.')} is not a whole number`
      else target[key] = number
    }
    // What a run may do is a word; one BMN cannot read, such as a table of its own, leaves it unresolved for a read-only role and nothing else.
    const access = (target, key) => {
      const word = value === null ? undefined : unquoteToml(value)
      if (word === undefined) out.access.unreadable ??= `config.toml ${path.join('.')} has a value BMN cannot read`
      else target[key] = word
    }
    if (path.length === 1 && CODEX_ACCESS_KEYS.includes(path[0])) access(out.access.top, path[0])
    else if (path.length === 2 && CODEX_ACCESS_KEYS.includes(path[0])) out.access.unreadable ??= `config.toml ${path[0]} is a table BMN cannot read`
    else if (path[0] === 'profiles' && path.length === 3 && CODEX_ACCESS_KEYS.includes(path[2])) {
      // Kept apart from the profiles the destination is read from: a profile that says only what a run may do is as little known there as before (R63-NFR1).
      out.access.profiles[path[1]] ??= {}
      access(out.access.profiles[path[1]], path[2])
    } else if (path[0] === 'profiles' && path.length === 4 && CODEX_ACCESS_KEYS.includes(path[2])) {
      out.access.unreadable ??= `config.toml profiles.${path[1]}.${path[2]} is a table BMN cannot read`
    } else if (path.length === 1 && CODEX_CONTEXT_KEYS.includes(path[0])) size(out.context.top, path[0])
    else if (path[0] === 'profiles' && path.length === 3 && CODEX_CONTEXT_KEYS.includes(path[2])) {
      // The profile exists, whatever else it holds.
      out.profiles[path[1]] ??= {}
      out.context.profiles[path[1]] ??= {}
      size(out.context.profiles[path[1]], path[2])
    } else if (path.length === 1 && CODEX_ROUTE_KEYS.includes(path[0])) record(out.top, path[0])
    else if (path[0] === 'profiles' && path.length === 3 && CODEX_ROUTE_KEYS.includes(path[2])) {
      out.profiles[path[1]] ??= {}
      record(out.profiles[path[1]], path[2])
    } else if (path[0] === 'model_providers' && path.length === 3 && path[2] === 'base_url') {
      out.providers[path[1]] ??= {}
      record(out.providers[path[1]], 'base_url')
    } else if (path[0] === 'model_providers' && path.length === 2) {
      out.providers[path[1]] ??= {}
      out.providers[path[1]].declared = true
      if (keys.length === 1 && table.length === 1) out.unreadable.push(path.join('.'))
    } else if (path[0] === 'profiles' && path.length === 2) {
      // `profiles.work = { … }`: a whole profile on one line, whose keys this reader does not open.
      out.unreadable.push(path.join('.'))
    } else if ((path[0] === 'model_providers' || path[0] === 'profiles') && path.length < 2) {
      out.unreadable.push(path.join('.'))
    }
  }
  return out
}

function hostOf(url) {
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol) || parsed.host === '') return null
    return parsed.host.toLowerCase()
  } catch {
    return null
  }
}

function truthy(value) {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase?.() !== 'false'
}

/** Without HOME an app looks for its settings in the account's home folder, which BMN would not have read: the command must say where. */
const NO_HOME = 'the command runs without HOME, so BMN cannot tell which settings the app would read; name it, as in env -i HOME="$HOME"'

/** The config.toml keys that say where Codex sends data. */
const CODEX_DESTINATION_KEYS = ['model_provider', 'profile', 'openai_base_url', 'chatgpt_base_url']

/** A folder as it was written and, when a link leads elsewhere, as it really is: an app may walk up from either. */
function spellings(folder) {
  try {
    const real = realpathSync(folder)
    return real === folder ? [folder] : [folder, real]
  } catch {
    return [folder]
  }
}

/** Each folder from `start` up to the root. */
function foldersAbove(start) {
  const folders = []
  for (let dir = start; ; dir = dirname(dir)) {
    folders.push(dir)
    if (dirname(dir) === dir) return folders
  }
}

/**
 * Config files Codex may load besides the user's config.toml: the machine's own, and a
 * `.codex/config.toml` in a working folder or any folder above it. BMN does not model how these
 * combine, so one that names a destination makes the destination unknown.
 */
function otherCodexConfig(folders, userConfig) {
  const same = (path) => {
    if (userConfig === null) return false
    try {
      return realpathSync(path) === realpathSync(userConfig)
    } catch {
      return path === userConfig
    }
  }
  const paths = ['/etc/codex/config.toml', '/etc/codex/managed_config.toml', ...folders.flatMap(foldersAbove).map((dir) => join(dir, '.codex/config.toml'))]
  const found = { destination: null, context: null, access: null }
  for (const path of new Set(paths)) {
    const text = optionalText(path)
    if (text === null || same(path)) continue
    const config = readCodexConfig(text)
    const decides = config.unreadable.length > 0 || CODEX_DESTINATION_KEYS.some((key) => config.top[key] !== undefined) || Object.keys(config.providers).length > 0
      || Object.values(config.profiles).some((profile) => CODEX_DESTINATION_KEYS.some((key) => profile[key] !== undefined))
    if (decides) found.destination ??= path
    const sizes = config.context.unreadable !== null || Object.keys(config.context.top).length > 0 || Object.values(config.context.profiles).some((profile) => Object.keys(profile).length > 0)
    if (sizes) found.context ??= path
    const does = config.access.unreadable !== null || Object.keys(config.access.top).length > 0 || Object.values(config.access.profiles).some((profile) => Object.keys(profile).length > 0)
    if (does) found.access ??= path
  }
  return found
}

/**
 * Where a `codex exec` goes, with the names of the sources that decided it: `-c` overrides, then
 * the selected profile, then config.toml, then OPENAI_BASE_URL in the dispatch environment. `cwd`
 * is the folder the dispatch starts in; with `-C` Codex works in another, and both are searched.
 */
export function resolveCodexRoute(parsed, environment, cwd = null) {
  const env = dispatchEnvironment(parsed, environment)
  if (!env.HOME) return { unsupported: NO_HOME }
  const codexHome = env.CODEX_HOME || `${env.HOME}/.codex`
  const sources = []
  const configPath = `${codexHome}/config.toml`
  const config = readCodexConfig(optionalText(configPath))
  const overrides = {}
  const providerOverrides = {}
  let unresolvable = config.unreadable.length > 0 ? `config.toml ${config.unreadable[0]} cannot be read` : null
  const starts = cwd === null ? [] : [cwd, ...(parsed.cd === undefined ? [] : [isAbsolute(parsed.cd) ? parsed.cd : join(cwd, parsed.cd)])]
  const others = otherCodexConfig(starts.flatMap(spellings), configPath)
  const other = others.destination
  if (other !== null) {
    unresolvable ??= `${other} also says where Codex sends data, and BMN cannot tell which file wins`
    sources.push(other)
  }
  const sizeOverrides = {}
  let sizeUnreadable = null
  const accessOverrides = {}
  const accessUnreadable = {}
  for (const entry of parsed.config) {
    const equals = entry.indexOf('=')
    if (equals === -1) return { unsupported: `-c ${entry} is not key=value` }
    const keys = tomlKeyPath(entry.slice(0, equals).trim())
    const raw = entry.slice(equals + 1)
    if (keys === null) return { unsupported: `-c ${entry.slice(0, equals)} is not a key` }
    const value = unquoteToml(raw) ?? (/^[A-Za-z0-9_.:/@-]+$/.test(raw.trim()) ? raw.trim() : undefined)
    if (keys.length === 1 && CODEX_ROUTE_KEYS.includes(keys[0])) {
      if (value === undefined) unresolvable = `-c ${keys[0]} has a value BMN cannot read`
      else overrides[keys[0]] = value
    } else if (keys[0] === 'model_providers') {
      if (keys.length === 3 && keys[2] === 'base_url' && value !== undefined) providerOverrides[keys[1]] = value
      else if (keys.length >= 3) continue
      else unresolvable = `-c ${keys.join('.')} cannot be resolved`
    } else if (keys.length === 1 && CODEX_CONTEXT_KEYS.includes(keys[0])) {
      const number = wholeNumber(raw)
      if (number === null) sizeUnreadable ??= `-c ${keys[0]} is not a whole number`
      else sizeOverrides[keys[0]] = number
    } else if (keys.length === 1 && CODEX_ACCESS_KEYS.includes(keys[0])) {
      // Neutral for where the run goes; read for what it may do, which only a read-only role asks about (63.2).
      if (value === undefined) accessUnreadable[keys[0]] = `-c ${keys[0]} has a value BMN cannot read`
      else {
        delete accessUnreadable[keys[0]]
        accessOverrides[keys[0]] = value
      }
    } else if (keys.length === 1 && CODEX_NEUTRAL_KEYS.includes(keys[0])) {
      continue
    } else if (keys[0] === 'mcp_servers') {
      // A tool given to this one run: what it may be is the tools check's question (60.12 AC5), not the destination's.
      continue
    } else {
      return { unsupported: `-c ${keys.join('.')} is not a key BMN knows to be neutral or can resolve` }
    }
  }
  const profileName = parsed.profile ?? overrides.profile ?? config.top.profile
  let profile = {}
  if (profileName !== undefined) {
    if (!Object.hasOwn(config.profiles, profileName)) unresolvable ??= `profile ${profileName} is not in config.toml`
    else profile = config.profiles[profileName]
    sources.push(parsed.profile !== undefined ? '--profile' : overrides.profile !== undefined ? '-c profile' : 'config.toml profile')
  }
  const pick = (key) => {
    if (overrides[key] !== undefined) return { value: overrides[key], source: `-c ${key}` }
    if (profile[key] !== undefined) return { value: profile[key], source: `config.toml profiles.${profileName}.${key}` }
    if (config.top[key] !== undefined) return { value: config.top[key], source: `config.toml ${key}` }
    return null
  }
  const model = parsed.model !== undefined ? { value: parsed.model, source: '-m' } : pick('model')
  const effort = pick('model_reasoning_effort')
  const providerPick = pick('model_provider')
  const provider = providerPick?.value ?? 'openai'
  if (providerPick) sources.push(providerPick.source)
  let route
  if (unresolvable !== null) {
    route = { basis: 'unknown', provider, host: null, reason: unresolvable }
  } else {
    const baseUrl = providerOverrides[provider] !== undefined
      ? { value: providerOverrides[provider], source: `-c model_providers.${provider}.base_url` }
      : config.providers[provider]?.base_url !== undefined
        ? { value: config.providers[provider].base_url, source: `config.toml model_providers.${provider}.base_url` }
        : null
    const builtInOverride = pick('openai_base_url') ?? pick('chatgpt_base_url')
    if (baseUrl !== null) {
      sources.push(baseUrl.source)
      const host = hostOf(baseUrl.value)
      route = host === null ? { basis: 'unknown', provider, host: null, reason: `${baseUrl.source} is not an http(s) URL` } : { basis: 'explicit', provider, host }
    } else if (provider !== 'openai') {
      route = { basis: 'unknown', provider, host: null, reason: `provider ${provider} has no base_url BMN can read` }
    } else if (builtInOverride !== null) {
      sources.push(builtInOverride.source)
      const host = hostOf(builtInOverride.value)
      route = host === null ? { basis: 'unknown', provider, host: null, reason: `${builtInOverride.source} is not an http(s) URL` } : { basis: 'explicit', provider, host }
    } else if (env.OPENAI_BASE_URL !== undefined && env.OPENAI_BASE_URL !== '') {
      sources.push('OPENAI_BASE_URL')
      const host = hostOf(env.OPENAI_BASE_URL)
      route = host === null ? { basis: 'unknown', provider, host: null, reason: 'OPENAI_BASE_URL is not an http(s) URL' } : { basis: 'explicit', provider, host }
    } else {
      route = { basis: 'default', provider, host: `default:${provider}` }
    }
  }
  // A `-c` item wins over every file. Without one, the profile and config.toml decide, unless another file BMN does not rank names a size too.
  const size = (key) => {
    if (sizeUnreadable !== null) return { unresolved: sizeUnreadable }
    if (sizeOverrides[key] !== undefined) return { value: sizeOverrides[key], source: `-c ${key}` }
    if (config.context.unreadable !== null) return { unresolved: config.context.unreadable }
    if (others.context !== null) return { unresolved: `${others.context} also sets a context size, and BMN cannot tell which file wins` }
    const inProfile = profileName === undefined ? undefined : config.context.profiles[profileName]?.[key]
    if (inProfile !== undefined) return { value: inProfile, source: `config.toml profiles.${profileName}.${key}` }
    if (config.context.top[key] !== undefined) return { value: config.context.top[key], source: `config.toml ${key}` }
    return null
  }
  const context = { limit: size(CODEX_CONTEXT_KEYS[0]), compact: size(CODEX_CONTEXT_KEYS[1]) }
  // What the run may do: the command's own flag or item wins over every file; without one the selected profile and
  // config.toml decide, unless another file BMN does not rank names it too. Null where nothing names it.
  const may = (key) => {
    if (key === 'sandbox_mode' && parsed.sandbox !== undefined) {
      if (accessUnreadable[key] !== undefined || (accessOverrides[key] !== undefined && accessOverrides[key] !== parsed.sandbox)) {
        return { unresolved: `--sandbox ${parsed.sandbox} and a -c sandbox_mode item name the sandbox twice` }
      }
      return { value: parsed.sandbox, source: '--sandbox' }
    }
    if (accessUnreadable[key] !== undefined) return { unresolved: accessUnreadable[key] }
    if (accessOverrides[key] !== undefined) return { value: accessOverrides[key], source: `-c ${key}` }
    if (config.access.unreadable !== null) return { unresolved: config.access.unreadable }
    if (others.access !== null) return { unresolved: `${others.access} also says what a run may do, and BMN cannot tell which file wins` }
    if (profileName !== undefined && !Object.hasOwn(config.profiles, profileName)) return { unresolved: `profile ${profileName} is not in config.toml` }
    const inProfile = profileName === undefined ? undefined : config.access.profiles[profileName]?.[key]
    if (inProfile !== undefined) return { value: inProfile, source: `config.toml profiles.${profileName}.${key}` }
    if (config.access.top[key] !== undefined) return { value: config.access.top[key], source: `config.toml ${key}` }
    return null
  }
  const access = { sandbox: may(CODEX_ACCESS_KEYS[0]), approvals: may(CODEX_ACCESS_KEYS[1]) }
  return { route: { ...route, sources: [...new Set(sources)] }, model, effort, configHome: codexHome, context, access, profile: profileName ?? null }
}

const CLAUDE_PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']

function settingsEnv(text, name) {
  if (text === null) return { env: {} }
  try {
    const data = JSON.parse(text)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { unreadable: `${name} is not a JSON object` }
    const env = data.env
    if (env === undefined) return { env: {} }
    if (env === null || typeof env !== 'object' || Array.isArray(env)) return { unreadable: `${name} env is not an object` }
    const out = {}
    for (const key of ['ANTHROPIC_BASE_URL', ...CLAUDE_PROVIDER_SWITCHES]) {
      if (env[key] === undefined) continue
      // A number or true where text belongs: the app may still act on it, so it is never read as absent.
      if (typeof env[key] !== 'string') return { unreadable: `${name} env ${key} is not text` }
      out[key] = env[key]
    }
    return { env: out }
  } catch {
    return { unreadable: `${name} is not valid JSON` }
  }
}

/**
 * Where a `claude -p` goes. ANTHROPIC_BASE_URL may come from the dispatch environment or any
 * settings file Claude Code loads (managed, user, the cwd's project and local files, --settings).
 * --safe-mode does not skip a file's `env`: Claude Code 2.1.295 under --safe-mode still sent requests to
 * a user settings ANTHROPIC_BASE_URL (loopback probe, 2026-10-09). BMN cannot prove which source wins
 * in every version, so it reads them all: one value everywhere is that host, disagreeing values are unknown.
 * The same goes for files it cannot prove are skipped: settings in the folders above the working one,
 * and the machine's managed-settings.d.
 */
export function resolveClaudeRoute(parsed, environment, cwd) {
  const env = dispatchEnvironment(parsed, environment)
  if (!env.HOME) return { unsupported: NO_HOME }
  const configDir = env.CLAUDE_CONFIG_DIR || `${env.HOME}/.claude`
  const files = [['managed settings', '/etc/claude-code/managed-settings.json']]
  files.push(['user settings', `${configDir}/settings.json`])
  if (cwd !== null) files.push(['project settings', `${cwd}/.claude/settings.json`], ['local settings', `${cwd}/.claude/settings.local.json`])
  for (const dir of cwd === null ? [] : [...new Set(spellings(cwd).flatMap((folder) => foldersAbove(folder).slice(1)))]) {
    for (const [label, name] of [['settings', 'settings.json'], ['local settings', 'settings.local.json']]) {
      // The user settings were read above; every other file here is one more source.
      if (join(dir, '.claude', name) !== join(configDir, 'settings.json')) files.push([`${label} in ${dir}`, `${dir}/.claude/${name}`])
    }
  }
  for (const name of optionalNames('/etc/claude-code/managed-settings.d')) {
    if (name.endsWith('.json')) files.push([`managed settings ${name}`, `/etc/claude-code/managed-settings.d/${name}`])
  }
  const values = []
  const sizes = []
  let sizeUnreadable = null
  let reason = null
  /**
   * The context size one source names, in its `env` or, for a settings file, as its own autoCompactWindow.
   * `id` says which very source it is: the run's environment, or a file by the part it plays for this run
   * (the user's, the working folder's, one above it, the machine's, `--settings`), its path and the key.
   * The owner's test of one version can then say which sources the run's own environment wins over, and
   * the same file playing another part is another source.
   */
  const takeSize = (source, raw, id) => {
    if (raw === undefined || raw === '' || raw === 'auto') return
    const number = typeof raw === 'string' || typeof raw === 'number' ? wholeNumber(raw) : null
    if (number === null) sizeUnreadable ??= `${source} is not a whole number`
    else sizes.push({ source, value: number, id })
  }
  const takeFileSize = (name, text, path) => {
    if (text === null) return
    const part = name.replace(/ in .*$/u, ' above').replace(/^managed settings .+$/u, 'managed settings')
    try {
      const data = JSON.parse(text)
      if (isObject(data?.env)) takeSize(`${name} env ${CLAUDE_CONTEXT_KEY}`, data.env[CLAUDE_CONTEXT_KEY], `${part} at ${path}: env`)
      takeSize(`${name} autoCompactWindow`, data?.autoCompactWindow, `${part} at ${path}: autoCompactWindow`)
    } catch {
      // The destination reading already reports a settings file that is not JSON.
    }
  }
  const take = (source, vars) => {
    if (vars.ANTHROPIC_BASE_URL !== undefined && vars.ANTHROPIC_BASE_URL !== '') values.push({ source, url: vars.ANTHROPIC_BASE_URL })
    for (const key of CLAUDE_PROVIDER_SWITCHES) if (truthy(vars[key])) reason ??= `${key} is set in ${source}`
  }
  take(parsed.envMode === 'clean' ? 'env -i ANTHROPIC_BASE_URL' : 'ANTHROPIC_BASE_URL', env)
  takeSize(parsed.envMode === 'clean' ? `env -i ${CLAUDE_CONTEXT_KEY}` : CLAUDE_CONTEXT_KEY, env[CLAUDE_CONTEXT_KEY], 'environment')
  for (const [name, path] of files) {
    const text = optionalText(path)
    const read = settingsEnv(text, name)
    if (read.unreadable) reason ??= read.unreadable
    else take(name, read.env)
    takeFileSize(name, text, path)
  }
  if (parsed.settings !== undefined) {
    const inline = parsed.settings.trimStart().startsWith('{')
    // A file that is not there is not an empty one: what the app would do with it is not BMN's to guess.
    const file = inline ? null : isAbsolute(parsed.settings) ? parsed.settings : `${cwd}/${parsed.settings}`
    const text = file === null ? parsed.settings : optionalText(file)
    const read = text === null ? { unreadable: '--settings cannot be read' } : settingsEnv(text, '--settings')
    if (read.unreadable) reason ??= read.unreadable
    else take('--settings', read.env)
    takeFileSize('--settings', text, file ?? 'the command line')
  }
  // BMN cannot tell from the files which source Claude Code lets win, so one size everywhere is that size and
  // two sizes are no answer here. `sizes` goes along: the owner's test of a version may have shown that the
  // run's own environment wins over that very source, and checkContext settles it from that (60.9 AC2).
  const distinct = [...new Set(sizes.map((entry) => entry.value))]
  const limit = sizeUnreadable !== null ? { unresolved: sizeUnreadable }
    : distinct.length === 0 ? null
      : distinct.length === 1 ? { value: distinct[0], source: sizes[0].source }
        : { unresolved: `${sizes[0].source} says ${sizes[0].value} and ${sizes.find((entry) => entry.value !== sizes[0].value).source} says ${sizes.find((entry) => entry.value !== sizes[0].value).value}`, conflict: true }
  const sources = values.map((value) => value.source)
  let route
  if (reason !== null) {
    route = { basis: 'unknown', provider: 'anthropic', host: null, reason }
  } else if (values.length === 0) {
    route = { basis: 'default', provider: 'anthropic', host: 'default:anthropic' }
  } else {
    const hosts = [...new Set(values.map((value) => hostOf(value.url)))]
    route = hosts.length === 1 && hosts[0] !== null
      ? { basis: 'explicit', provider: 'anthropic', host: hosts[0] }
      : { basis: 'unknown', provider: 'anthropic', host: null, reason: hosts.includes(null) ? 'ANTHROPIC_BASE_URL is not an http(s) URL' : 'ANTHROPIC_BASE_URL differs between sources' }
  }
  return {
    route: { ...route, sources },
    model: parsed.model === undefined ? null : { value: parsed.model, source: '--model' },
    effort: parsed.effort === undefined ? null : { value: parsed.effort, source: '--effort' },
    configHome: configDir,
    context: { limit, compact: null, sizes }
  }
}

/**
 * Where an `opencode run` in the checked form sends the conversation (70.2). It must run behind `env -i`
 * with exactly BMN's folders and switches (agents-opencode.mjs) and BMN's own agent; BMN's folder holds its
 * own files only, so no provider, model or agent of anyone else's can change the address, and the model,
 * its provider and the effort are what `-m <provider>/<model>#<effort>` names. Without `--title` OpenCode
 * names the session with one more request to a title model the form does not name, so the destination
 * is unknown.
 */
export function resolveOpenCodeRoute(parsed, { agent: wantedAgent = OPENCODE_HELPER_AGENT, folder = true, base = openCodeFolder(), inline = null } = {}) {
  const wanted = openCodeEnvironment(base)
  const form = 'the folders and switches `bmn roster role <role> --json` gives'
  if (parsed.envMode !== 'clean') return { unsupported: `an OpenCode run is checked only behind env -i, with ${form}` }
  for (const name of Object.keys(parsed.assignments)) {
    if (name === 'PATH' || Object.hasOwn(wanted, name)) continue
    // A teammate's ask gives its agents inline (72.9): exactly BMN's text for that ask, which names no provider, model or address.
    if (name === 'OPENCODE_CONFIG_CONTENT' && inline !== null && parsed.assignments[name] === inline) continue
    return { unsupported: /^OPENCODE_CONFIG/.test(name) ? `env -i ${name} names another OpenCode configuration` : `env -i ${name} is not part of the OpenCode form` }
  }
  if (!parsed.assignments.PATH) return { unsupported: 'env -i must carry PATH, so the check and the run find the same opencode' }
  for (const [name, value] of Object.entries(wanted)) {
    if (parsed.assignments[name] === value) continue
    if (name === 'OPENCODE_DISABLE_PROJECT_CONFIG') {
      return { unsupported: 'without OPENCODE_DISABLE_PROJECT_CONFIG=1 a repository\'s own opencode.json or .opencode folder replaces BMN\'s agent and the address requests go to, and runs its own plugin' }
    }
    if (name === 'OPENCODE_DISABLE_AUTOUPDATE') return { unsupported: 'env -i must carry OPENCODE_DISABLE_AUTOUPDATE=1, so the run does not update OpenCode' }
    if (name === 'OPENCODE_DISABLE_MODELS_FETCH') return { unsupported: 'env -i must carry OPENCODE_DISABLE_MODELS_FETCH=1, so the run takes the model list built into OpenCode instead of fetching one' }
    return { unsupported: `env -i ${name} must be ${value}, a folder of BMN's own for OpenCode runs` }
  }
  // A dry research question is asked before BMN puts its folder in order for the run; the run's own check reads the folder.
  const problem = folder ? openCodeFolderProblem(base) : null
  if (problem !== null) return { unsupported: `${problem}; \`bmn roster role <role> --json\` puts BMN's folder back` }
  if (parsed.agent !== wantedAgent) {
    const which = wantedAgent === OPENCODE_HELPER_AGENT ? 'read-only' : Object.values(OPENCODE_ASK_AGENTS).includes(wantedAgent) ? 'asked-teammate' : 'research'
    return { unsupported: parsed.agent === undefined ? `opencode run must carry --agent ${wantedAgent}, BMN's ${which} agent` : `--agent ${parsed.agent} is not BMN's agent; the form runs --agent ${wantedAgent}` }
  }
  const folders = openCodeFolders(base)
  const common = { configHome: `${folders.config}/opencode`, context: { limit: null, compact: null, sizes: [] } }
  if (parsed.model === undefined) return { ...common, route: { basis: 'unknown', provider: null, host: null, reason: 'the command names no model', sources: [] }, model: null, effort: null }
  const reference = openCodeReference(parsed.model)
  if (reference === null) return { unsupported: `-m ${parsed.model} is not <provider>/<model>#<effort> as OpenCode reads it` }
  const hash = parsed.model.indexOf('#', reference.length)
  const variant = hash === -1 ? null : parsed.model.slice(hash + 1)
  const provider = reference.slice(0, reference.indexOf('/'))
  // BMN's folder names no provider and is checked byte for byte, and the run takes the model list built into OpenCode:
  // the provider in -m is the one the run reaches, at its own servers. Where the owner's own OpenCode sends data, which
  // `## harness-routes` records, plays no part in it (70.4: his team records none, and his own folder may read as unknown).
  const route = parsed.title === undefined
    ? { basis: 'unknown', provider, host: null, reason: 'without --title OpenCode names the session with a title model the form does not name' }
    : { basis: 'folder', provider, host: `default:${provider}` }
  return {
    ...common, route: { ...route, sources: ['-m'] },
    model: { value: reference, source: '-m' },
    effort: variant === null ? null : { value: variant, source: '-m #variant' }
  }
}

/**
 * The other sources that would name a context size for a test of this app run from `folder`, each by
 * its identity and its size (60.9 AC2, 63.1 AC3). Only Claude Code reads a size from more than one place.
 */
export function contextTestSources(harness, environment, folder) {
  if (harness !== 'claude') return []
  const tested = { ...environment, [CLAUDE_CONTEXT_KEY]: String(CONTEXT_TEST_SIZE.claude) }
  const sizes = resolveClaudeRoute(parseDispatch(['claude', ...CLAUDE_TEST_ARGUMENTS]), tested, folder).context?.sizes ?? []
  return sizes.filter((entry) => entry.id !== 'environment').map((entry) => ({ source: entry.source, id: entry.id, value: entry.value }))
}

/**
 * How an agent's own context limit fares for a run started now with exactly the items `bmn roster
 * role --json` gives for it (63.1 AC4): `applied`, `not-applied` (no proven setting on this version,
 * so the run gets the app's own default) or `refused` (the check would stop the run), each but the
 * first with its reason in the check's words. Null for an agent without a limit. Judged from where
 * the test runs, a folder of its own under the home folder: a run from a project that has settings
 * of its own may fare differently, and the check says so then.
 */
export function limitStanding(agent, version, { environment = process.env, cwd = contextTestFolder(environment), tests = undefined, auto = undefined } = {}) {
  const proven = { ...provenControls(agent.harness, version, tests), ...(auto === undefined ? {} : { auto }) }
  const items = contextItems(agent, proven)
  if (items.state === 'app-default') return null
  if (items.state !== 'applied') return { state: items.state === 'out-of-range' ? 'refused' : 'not-applied', reason: items.reason }
  const argv = agent.harness === 'codex' ? ['codex', 'exec', ...items.argv, '-'] : ['env', '-i', `HOME=${environment.HOME ?? homedir()}`, ...items.env, 'claude', '-p']
  const parsed = parseDispatch(argv)
  const resolution = agent.harness === 'codex' ? resolveCodexRoute(parsed, environment, cwd) : resolveClaudeRoute(parsed, environment, cwd)
  const result = checkContext(agent, resolution.context, proven, provenPrecedence(agent.harness, version, tests))
  return result.refusal ? { state: 'refused', reason: result.refusal } : { state: 'applied' }
}

// The `settings` (OpenCode 2) and `options` (OpenCode 1) BMN knows cannot move where a request goes, with the
// values each takes; a settings field is package-specific (Azure's `resourceName`, a region, `baseURL`), so any
// other field, or a known one with another value, counts as an address of its own. Timeouts apply provider-wide.
// OpenCode 2 turns an OpenCode 1 `options.reasoningEffort` into `settings.reasoningEffort`, a word for how hard
// the model thinks.
const timeoutValue = (value) => value === false || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
const compactionValue = (value) => isObject(value) && Object.keys(value).length === 1 && (value.type === 'summary' || value.type === 'native')
const effortValue = (value) => typeof value === 'string' && /^[a-z]+$/.test(value)
const KNOWN_SETTINGS = {
  provider: {
    settings: {
      compaction: compactionValue, transport: (value) => value === 'http' || value === 'websocket',
      encoding: (value) => value === 'none' || value === 'gzip' || value === 'zstd',
      timeout: timeoutValue, headerTimeout: timeoutValue, chunkTimeout: timeoutValue, reasoningEffort: effortValue
    },
    options: { apiKey: (value) => typeof value === 'string', timeout: timeoutValue, reasoningEffort: effortValue }
  },
  model: { settings: { compaction: compactionValue, reasoningEffort: effortValue }, options: { reasoningEffort: effortValue } }
}

// Whether a provider (`level` 'provider'), model or variant ('model') entry can send data somewhere its
// provider's prefix does not say. Anything but a map there, settings BMN does not know, or `variants` that are
// not a map of maps cannot be read and count as such an entry.
function ownAddress(entry, level) {
  if (!isObject(entry)) return true
  if (['api', 'npm', 'package', 'canonical'].some((field) => entry[field] !== undefined)) return true
  for (const [field, known] of Object.entries(KNOWN_SETTINGS[level])) {
    const value = entry[field]
    if (value === undefined) continue
    if (!isObject(value) || Object.entries(value).some(([key, setting]) => !Object.hasOwn(known, key) || !known[key](setting))) return true
  }
  if (entry.variants === undefined) return false
  return !isObject(entry.variants) || Object.values(entry.variants).some((variant) => ownAddress(variant, 'model'))
}

// `<provider>/<model>` without its `#variant`, read as OpenCode reads it (the provider before the first `/`, the
// model up to the first `#` after it, a variant neither empty nor holding `#`), from text or from a map naming
// `providerID` and exactly one of `model` and `id`; null for anything else, and for any space in either part.
function openCodeReference(named) {
  let text = null
  if (typeof named === 'string') text = named
  else if (isObject(named) && typeof named.providerID === 'string' && (named.model === undefined) !== (named.id === undefined)) {
    const id = named.model ?? named.id
    if (typeof id === 'string' && !id.includes('#')) text = `${named.providerID}/${id}`
  }
  if (text === null) return null
  const slash = text.indexOf('/')
  if (slash <= 0) return null
  const hash = text.indexOf('#', slash + 1)
  const provider = text.slice(0, slash)
  const variant = hash === -1 ? undefined : text.slice(hash + 1)
  if (provider.includes('#') || (variant !== undefined && (variant === '' || variant.includes('#')))) return null
  const reference = hash === -1 ? text : text.slice(0, hash)
  return /^[^\s/]+\/\S+$/.test(reference) ? reference : null
}

/**
 * OpenCode's JSONC as a value: JSON plus comments and trailing commas, both only outside strings. Anything
 * else, a key twice in one map (OpenCode's own reader would keep one of them) and a `__proto__` key throw.
 */
function parseJsonc(text) {
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const fail = (what) => { throw new SyntaxError(`${what} at character ${index}`) }
  // eslint-disable-next-line no-control-regex -- JSON refuses a raw control character inside a string
  const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y
  const LITERAL = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
  const skip = () => {
    for (;;) {
      const char = text[index]
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') index += 1
      else if (char === '/' && text[index + 1] === '/') {
        // OpenCode's reader ends a line comment at a carriage return as well as a line feed.
        while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1
      } else if (char === '/' && text[index + 1] === '*') {
        const end = text.indexOf('*/', index + 2)
        if (end === -1) fail('an unclosed comment')
        index = end + 2
      } else return
    }
  }
  const token = (pattern, what) => {
    pattern.lastIndex = index
    const match = pattern.exec(text)
    if (match === null) fail(what)
    index = pattern.lastIndex
    return JSON.parse(match[0])
  }
  const value = (depth) => {
    if (depth > 64) fail('nesting deeper than BMN reads')
    skip()
    const char = text[index]
    if (char === '{' || char === '[') {
      const map = char === '{'
      const out = map ? {} : []
      index += 1
      for (;;) {
        skip()
        if (text[index] === (map ? '}' : ']')) {
          index += 1
          return out
        }
        if (map) {
          if (text[index] !== '"') fail('a key that is not a string')
          const key = token(STRING, 'a malformed key')
          if (Object.hasOwn(out, key)) fail(`the key ${JSON.stringify(key)} twice`)
          // OpenCode's reader assigns keys, so this one would replace the map's prototype rather than name a field.
          if (key === '__proto__') fail('the key "__proto__"')
          skip()
          if (text[index] !== ':') fail('a missing ":"')
          index += 1
          Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true })
        } else {
          out.push(value(depth + 1))
        }
        skip()
        if (text[index] === ',') index += 1
        else if (text[index] !== (map ? '}' : ']')) fail(`a missing "," or "${map ? '}' : ']'}"`)
      }
    }
    return char === '"' ? token(STRING, 'a malformed string') : token(LITERAL, 'text that is not JSON')
  }
  const result = value(0)
  skip()
  if (index !== text.length) fail('text after the configuration')
  return result
}

// OpenCode 2 reads agent and command files from these folders beside the configuration, at any depth: its own
// agents/ and commands/ and OpenCode 1's agent/, mode/, modes/ and command/.
const OPENCODE_FILE_FOLDERS = ['agent', 'agents', 'mode', 'modes', 'command', 'commands']
const OPENCODE_FILE_LIMIT = 2000
const OPENCODE_FILE_DEPTH = 16
// The openings of a front matter BMN reads as YAML; OpenCode also takes others (JSON, JavaScript).
const FRONT_MATTER_OPENERS = ['---', '---yaml', '---yml']

/**
 * What an agent or command file's front matter says about its model: `{ model: null }` when there is no
 * front matter or it names no model, `{ model: <text> }`, or `{ unreadable: <why> }`. OpenCode reads the
 * front matter as YAML, or as JSON or JavaScript after another opening. BMN reads only `---`, `---yaml` and
 * `---yml`, with the team file's YAML subset (agents-roster.mjs `parseYaml`), which refuses anchors,
 * aliases, tags, block scalars, complex keys, directives, duplicate keys and escapes other than \" \\ \n \t
 * \/; before it, a carriage return alone, a space character YAML does not count as one, and a line OpenCode
 * would rewrite on a second reading are refused. A front matter it cannot read whole is unreadable: not finding a
 * key does not prove OpenCode finds none.
 */
function openCodeFrontMatter(text) {
  const lines = text.replace(/^\uFEFF/, '').split('\n').map((line) => line.replace(/\r$/, ''))
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start += 1
  if (start === lines.length || !lines[start].startsWith('---')) return { model: null }
  if (!FRONT_MATTER_OPENERS.includes(lines[start].trimEnd())) return { unreadable: `its front matter opens with ${JSON.stringify(lines[start].slice(0, 24))}` }
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('---')) end += 1
  if (end === lines.length) return { unreadable: 'its front matter does not close' }
  if (lines[end].trimEnd() !== '---') return { unreadable: `its front matter closes with ${JSON.stringify(lines[end].slice(0, 24))}` }
  const region = lines.slice(start, end + 1)
  // OpenCode's YAML reader also ends a line at a carriage return alone; BMN splits only at line feeds, so such
  // a line could hold a key BMN reads as part of a comment or a value.
  if (region.some((line) => line.includes('\r'))) return { unreadable: 'its front matter ends a line with a carriage return alone' }
  // JavaScript counts more characters as space than YAML does (a no-break space, a byte order mark, a form feed):
  // BMN's reading would trim them where OpenCode keeps them, so the front matter must hold none.
  if (region.some((line) => /[^\S \t\n\r]/.test(line))) return { unreadable: 'its front matter holds a space character YAML does not treat as one' }
  if (lines.slice(start + 1, end).some(rewrittenOnRetry)) {
    return { unreadable: 'its front matter has an unquoted value holding ":", which OpenCode may read again with its comment (quote the value)' }
  }
  let value
  try {
    ;({ value } = parseYaml(lines.slice(start + 1, end).join('\n')))
  } catch (error) {
    return { unreadable: `its front matter is not YAML BMN reads (${error.message})` }
  }
  // A model below the top, a merge key or a map whose prototype a key replaced may still reach OpenCode.
  const hidden = (node, depth) => Array.isArray(node) ? node.some((item) => hidden(item, depth + 1))
    : isObject(node) && (Object.getPrototypeOf(node) !== Object.prototype ||
      Object.entries(node).some(([key, child]) => key === '<<' || (key === 'model' && depth > 0) || hidden(child, depth + 1)))
  if (hidden(value, 0)) return { unreadable: 'it names a model below the top of its front matter, or merges a map into it' }
  if (!Object.hasOwn(value, 'model')) return { model: null }
  return typeof value.model === 'string' ? { model: value.model } : { unreadable: 'its model is not text' }
}

/**
 * Whether OpenCode would rewrite this front-matter line when it reads the front matter again after a first reading
 * failed: a top-level `key: value` whose unquoted value holds a `:` becomes a block of the raw text, its comment
 * included. BMN does not follow that second reading, so a front matter holding such a line is not read.
 */
function rewrittenOnRetry(line) {
  const text = line.trim()
  if (text === '' || text.startsWith('#') || /^\s/.test(line)) return false
  const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line)
  if (match === null) return false
  const value = match[2].trim()
  return value !== '' && value !== '>' && value !== '|' && !value.startsWith('"') && !value.startsWith("'") && value.includes(':')
}

/** Each agent or command file's model, or why the file cannot be read for one. */
function openCodeAgentFiles(folder) {
  const found = []
  let files = 0
  const walk = (directory, source, depth) => {
    if (depth > OPENCODE_FILE_DEPTH) throw new Refusal('HOST_UNKNOWN', `${directory} is nested deeper than BMN reads`)
    let entries
    try {
      traceRead?.(directory)
      entries = readdirSync(directory)
    } catch (error) {
      if (depth === 0 && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return
      throw new Refusal('HOST_UNKNOWN', `cannot read ${directory} (${error.code})`)
    }
    for (const name of entries.sort()) {
      const path = `${directory}/${name}`
      let stats
      try {
        stats = statSync(path)
      } catch (error) {
        // A link to nothing is skipped, as OpenCode skips it.
        if (error.code === 'ENOENT') continue
        throw new Refusal('HOST_UNKNOWN', `cannot read ${path} (${error.code})`)
      }
      if (stats.isDirectory()) {
        walk(path, `${source}/${name}`, depth + 1)
        continue
      }
      if (!name.endsWith('.md') || !stats.isFile()) continue
      files += 1
      if (files > OPENCODE_FILE_LIMIT) throw new Refusal('HOST_UNKNOWN', `more than ${OPENCODE_FILE_LIMIT} agent and command files beside the OpenCode configuration`)
      const front = openCodeFrontMatter(optionalText(path) ?? '')
      if (front.unreadable !== undefined) found.push({ reference: null, unreadable: front.unreadable, source: `${source}/${name}` })
      else if (front.model !== null) found.push({ reference: openCodeReference(front.model), source: `${source}/${name}` })
    }
  }
  for (const directory of OPENCODE_FILE_FOLDERS) walk(`${folder}/${directory}`, directory, 0)
  return found
}

/**
 * OpenCode's configured model and provider prefix. Every model the configuration names gets the
 * conversation, not only `model`: the title model (`small_model`) and each agent's, mode's or command's
 * (the `agent`, `agents`, `mode`, `command` and `commands` maps, and the agent and command files beside
 * the configuration), so all of them must name one provider. A configuration named by the environment,
 * both opencode.json and opencode.jsonc (OpenCode reads both), a file or a map BMN cannot read whole, or a
 * provider, model or variant entry that carries its own address or runtime (OpenCode 1's `api`, `npm` and
 * `options.baseURL`; OpenCode 2's `package`, `canonical` and `settings.baseURL`, under `provider` or
 * `providers`) reads as unknown. OpenCode 2 writes `model` as `<provider>/<model>`, a variant after `#`;
 * a map naming `providerID` is read too. A project's own opencode.json and agent files are not read.
 */
function inspectOpenCode(environment) {
  const unknown = (reason, sources) => ({ basis: 'unknown', provider: null, host: null, reason, sources })
  for (const name of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT']) {
    if (environment[name]) return unknown(`${name} names another OpenCode configuration`, [name])
  }
  const folder = environment.OPENCODE_CONFIG_DIR || `${environment.XDG_CONFIG_HOME || `${environment.HOME ?? homedir()}/.config`}/opencode`
  const present = ['opencode.json', 'opencode.jsonc'].map((name) => ({ name, text: optionalText(`${folder}/${name}`) })).filter((file) => file.text !== null)
  if (present.length === 0) return unknown('no OpenCode configuration names a model', [])
  if (present.length > 1) return unknown('opencode.json and opencode.jsonc are both there, and OpenCode reads both', ['opencode.json', 'opencode.jsonc'])
  const { name, text } = present[0]
  let config
  try {
    config = parseJsonc(text)
  } catch (error) {
    return unknown(`${name} cannot be read (${error.message})`, [name])
  }
  if (!isObject(config)) return unknown(`${name} does not hold a map`, [name])
  for (const key of ['provider', 'providers', 'agent', 'agents', 'mode', 'command', 'commands']) {
    if (config[key] === undefined) continue
    if (!isObject(config[key])) return unknown(`${name} ${key} is not a map`, [`${name} ${key}`])
    for (const [entryName, entry] of Object.entries(config[key])) {
      if (!isObject(entry)) return unknown(`${name} ${key}.${entryName} is not a map`, [`${name} ${key}.${entryName}`])
    }
  }
  const model = openCodeReference(config.model)
  if (model === null) return unknown(`${name} names no model`, [name])
  const named = [{ reference: model, source: `${name} model` }]
  if (config.small_model !== undefined) named.push({ reference: openCodeReference(config.small_model), source: `${name} small_model` })
  for (const key of ['agent', 'agents', 'mode', 'command', 'commands']) {
    for (const [entryName, entry] of Object.entries(config[key] ?? {})) {
      if (entry.model !== undefined) named.push({ reference: openCodeReference(entry.model), source: `${name} ${key}.${entryName}.model` })
    }
  }
  named.push(...openCodeAgentFiles(folder))
  const providers = []
  for (const { reference, source, unreadable } of named) {
    if (unreadable !== undefined) return unknown(`${source}: ${unreadable}`, [source])
    if (reference === null) return unknown(`${source} names no model BMN reads as <provider>/<model>`, [source])
    const provider = reference.slice(0, reference.indexOf('/'))
    if (!providers.includes(provider)) providers.push(provider)
    const modelID = reference.slice(provider.length + 1)
    for (const key of ['provider', 'providers']) {
      if (config[key] === undefined || !Object.hasOwn(config[key], provider)) continue
      const entry = config[key][provider]
      if (ownAddress(entry, 'provider')) return { ...unknown(`${name} gives ${provider} its own address`, [`${name} ${key}.${provider}`]), provider }
      if (entry.models === undefined) continue
      if (!isObject(entry.models)) return { ...unknown(`${name} ${key}.${provider}.models is not a map`, [`${name} ${key}.${provider}.models`]), provider }
      const modelEntry = Object.hasOwn(entry.models, modelID) ? entry.models[modelID] : undefined
      if (modelEntry !== undefined && ownAddress(modelEntry, 'model')) {
        return { ...unknown(`${name} gives ${reference} its own address`, [`${name} ${key}.${provider}.models.${modelID}`]), provider }
      }
    }
  }
  if (providers.length > 1) return unknown(`${name} sends the conversation to more than one provider (${providers.join(', ')})`, named.map((item) => item.source))
  return { basis: 'default', provider: providers[0], host: `default:${providers[0]}`, model, sources: [`${name} model`] }
}

/**
 * `<harness> --version`, the only thing BMN runs. It is asked afresh for every decision and
 * resolved through PATH by the same exec the dispatch uses, so the version always belongs to the
 * program that would run: nothing is remembered, because no file identity can tell that a stable
 * launcher now starts another program. A failure reads as no version (null).
 */
export function harnessVersion(command, environment) {
  try {
    const text = execFileSync(command, ['--version'], { env: environment, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(text)?.[0] ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Workspaces and their public status

function canonicalDirectory(path, from) {
  if (path.split('/').includes('..')) return null
  const absolute = isAbsolute(path) ? path : `${from}/${path}`
  try {
    traceRead?.(absolute)
    const real = realpathSync(absolute)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function inside(child, parent) {
  if (child === parent) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Whether `marker` is what Git leaves at a top-level: a `.git` folder that holds a HEAD, or the
 * `.git` file a linked worktree or a submodule has. A stray empty `.git` folder is neither, and
 * Git itself reads past it.
 */
function repositoryMarker(marker) {
  traceRead?.(marker)
  try {
    if (!statSync(marker).isDirectory()) return true
    const head = join(marker, 'HEAD')
    traceRead?.(head)
    statSync(head)
    return true
  } catch {
    return false
  }
}

/**
 * The workspace a directory belongs to: its Git top-level (the nearest folder holding a
 * repository's `.git`), or the directory itself outside Git. A nested repository has its own
 * top-level, so an exception for the outer one never covers it (60.8 AC6). `directory` is
 * canonical already.
 */
export function workspaceRoot(directory) {
  let current = directory
  for (;;) {
    if (repositoryMarker(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return directory
    current = parent
  }
}

export function visibilityDirectory() {
  return `${stateDirectory()}/visibility`
}

export function visibilityPath(workspace) {
  return `${visibilityDirectory()}/${sha256(workspace)}.json`
}

/** `github.com/<owner>/<name>` for a GitHub remote URL in any of Git's spellings, else null. */
export function normalizedGithubOrigin(url) {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|git:\/\/github\.com\/|(?:[^@/]+@)?github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') return null
  return `github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}`
}

/**
 * Git, asked about this workspace's own repository and nothing else: no `GIT_*` variable may point
 * it at another repository, object store or configuration, and replacement refs are off, so an
 * object name always reads the object with that hash (60.3 AC6).
 */
function git(workspace, args, options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  return execFileSync('git', ['--no-replace-objects', '-C', workspace, ...args],
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 * 1024 * 1024, ...options, env: { ...env, GIT_NO_REPLACE_OBJECTS: '1' } })
}

/** The workspace's `origin` as git would use it: `{ origin }`, or `{ reason }` when there is none or it is not GitHub. */
export function workspaceOrigin(workspace) {
  let url
  try {
    url = git(workspace, ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  } catch {
    return { reason: 'no origin' }
  }
  const origin = normalizedGithubOrigin(url)
  return origin === null ? { reason: 'not GitHub' } : { origin }
}

const PRIVATE_REASONS = ['no origin', 'not GitHub', 'private repository', 'check failed']

/**
 * Whether a workspace is proven public (60.3 AC5): only by a visibility record that is well
 * formed, younger than 7 days, not dated in the future, names this canonical path and the
 * workspace's current origin, and says GitHub reports that repository public. Anything else is
 * private, with the reason in words. No network call: `bmn roster visibility --refresh` writes
 * the record.
 */
export function workspaceVisibility(workspace, now = new Date()) {
  let text
  try {
    text = readText(visibilityPath(workspace))
  } catch (error) {
    return { public: false, reason: error.code === 'ENOENT' ? 'no record' : 'malformed' }
  }
  let record
  try {
    record = JSON.parse(text)
  } catch {
    return { public: false, reason: 'malformed' }
  }
  const checkedAt = isObject(record) && typeof record.checked_at === 'string' ? Date.parse(record.checked_at) : Number.NaN
  if (!isObject(record) || record.version !== 1 || record.workspace !== workspace || Number.isNaN(checkedAt) || checkedAt > now.getTime()
    || !['public', 'private'].includes(record.visibility)) return { public: false, reason: 'malformed' }
  if (now.getTime() - checkedAt >= VISIBILITY_MAX_AGE_MS) return { public: false, reason: 'stale', record }
  if (record.visibility === 'private') {
    return { public: false, reason: PRIVATE_REASONS.includes(record.reason) ? record.reason : 'private repository', record }
  }
  if (typeof record.origin !== 'string' || !/^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(record.origin) || !Number.isSafeInteger(record.repository_id)
    || record.repository_id <= 0 || !isString(record.default_branch) || typeof record.commit !== 'string' || !/^[0-9a-f]{40}$/.test(record.commit)) {
    return { public: false, reason: 'malformed' }
  }
  const current = workspaceOrigin(workspace)
  if (current.origin === undefined) return { public: false, reason: current.reason, record }
  if (current.origin !== record.origin) return { public: false, reason: 'origin changed', record }
  return { public: true, reason: `GitHub reports ${record.origin} public`, record }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isString(value) {
  return typeof value === 'string' && value !== ''
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

/** BMN-managed state, written whole and private: temp, fsync, rename, read back (R60-NFR2). */
function writeState(path, text) {
  ensurePrivateDirectory(dirname(path))
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = openSync(temporary, 'wx', 0o600)
  try {
    writeSync(handle, text)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, path)
  if (readFileSync(path, 'utf8') !== text) throw new RosterError('STATE_CORRUPT', `${path} did not read back`)
}

/**
 * Asks GitHub, without credentials, whether the workspace's origin is public and which commit its
 * default branch is at, and writes one record (60.3 AC10). A missing origin, another host, a
 * private or missing repository, an error or a timeout records private. The only network call in
 * the roster commands; `api` and `request` are the tests' stub seam.
 */
export async function refreshVisibility(workspacePath, { now = new Date(), api = 'https://api.github.com', request = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const workspace = canonicalDirectory(workspacePath, process.cwd())
  if (workspace === null) throw new RosterError('WORKSPACE_UNKNOWN', `${workspacePath} is not an existing directory without ..`)
  const base = { version: 1, workspace, checked_at: now.toISOString() }
  const origin = workspaceOrigin(workspace)
  let record
  if (origin.origin === undefined) {
    record = { ...base, origin: null, visibility: 'private', reason: origin.reason }
  } else {
    const [, owner, name] = origin.origin.split('/')
    const ask = async (path, accept) => {
      const response = await request(`${api}/repos/${owner}/${name}${path}`, {
        headers: { accept, 'user-agent': 'bmn-roster-visibility' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), credentials: 'omit'
      })
      return response
    }
    try {
      const repository = await ask('', 'application/vnd.github+json')
      if (repository.status === 404) {
        record = { ...base, origin: origin.origin, visibility: 'private', reason: 'private repository' }
      } else if (!repository.ok) {
        record = { ...base, origin: origin.origin, visibility: 'private', reason: 'check failed' }
      } else {
        const body = await repository.json()
        const isPublic = isObject(body) && body.private === false && (body.visibility === undefined || body.visibility === 'public')
        if (!isPublic) {
          record = { ...base, origin: origin.origin, visibility: 'private', reason: 'private repository' }
        } else if (!Number.isSafeInteger(body.id) || !isString(body.default_branch) || !/^[A-Za-z0-9._/-]{1,255}$/.test(body.default_branch)) {
          record = { ...base, origin: origin.origin, visibility: 'private', reason: 'check failed' }
        } else {
          const commit = await ask(`/commits/${encodeURIComponent(body.default_branch)}`, 'application/vnd.github.sha')
          const sha = commit.ok ? (await commit.text()).trim() : ''
          record = /^[0-9a-f]{40}$/.test(sha)
            ? { ...base, origin: origin.origin, repository_id: body.id, visibility: 'public', default_branch: body.default_branch, commit: sha }
            : { ...base, origin: origin.origin, visibility: 'private', reason: 'check failed' }
        }
      }
    } catch {
      record = { ...base, origin: origin.origin, visibility: 'private', reason: 'check failed' }
    }
  }
  writeState(visibilityPath(workspace), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

// ---------------------------------------------------------------------------------------------
// Destinations and private work

/**
 * Which roster provider a resolved route reaches, and how BMN knows (60.3 AC4). A harness's own
 * default names the provider approved in `## harness-routes` (an `observed-default` entry holds
 * only while the harness's default provider is still that one); an explicit host names the
 * provider whose `hosts` list it. `harness_provider` is the provider id the harness itself uses.
 */
export function destinationOf(data, harness, route) {
  if (route.basis === 'unknown') return { known: false, reason: route.reason }
  // An OpenCode run in BMN's own folder: its -m alone decides, and BMN wrote and checked everything else it reads.
  if (route.basis === 'folder') return { known: true, default: true, provider: route.provider, host: `default:${route.provider}`, basis: 'observed-default', harness_provider: route.provider }
  if (route.basis === 'default') {
    const approved = data.harness_routes.find((entry) => entry.harness === harness)
    if (approved === undefined) return { known: false, reason: `no approved destination for ${harness} in ## harness-routes` }
    if (approved.basis === 'observed-default' && approved.provider !== route.provider) {
      return { known: true, default: true, provider: route.provider, host: `default:${route.provider}`, basis: 'observed-default', harness_provider: route.provider, unapproved: approved.provider }
    }
    return { known: true, default: true, provider: approved.provider, host: `default:${approved.provider}`, basis: approved.basis, harness_provider: route.provider }
  }
  const owner = data.providers.find((provider) => provider.hosts.some((host) => host.toLowerCase() === route.host))
  return { known: true, default: false, provider: owner?.id ?? null, host: route.host, basis: 'explicit', harness_provider: route.provider }
}

/**
 * Whether a destination may receive private work (60.3 AC4): its provider answers `allowed` and
 * the destination is evidenced (an observed default, or an explicit listed host); or it is
 * evidenced that way and an exception names that provider and this workspace's root. An
 * owner-declared destination is public work only and no exception applies to it. `root` is the
 * canonical root every directory of the dispatch belongs to, or null when they do not share one.
 * An exception's folder is compared as approved, text against that real path, and no link in it
 * is followed: wherever a link points later, the approval never comes to mean another folder.
 */
export function privateWorkAnswer(data, destination, root) {
  const provider = data.providers.find((entry) => entry.id === destination.provider)
  const answer = provider?.private_work ?? 'public_only'
  const name = provider?.name ?? destination.provider
  if (destination.basis === 'owner-declared') return { allowed: false, answer, reason: `the destination is owner-declared, not inspected, so ${name} gets public work only` }
  if (answer === 'allowed') return { allowed: true, answer, reason: `${name} may see private work` }
  const exception = root === null ? undefined
    : data.exceptions.find((entry) => entry.provider === destination.provider && entry.folder === root)
  if (exception !== undefined) return { allowed: true, answer, exception: { id: exception.id, scope: 'this workspace' }, reason: `${name} is allowed in this workspace (exception ${exception.id})` }
  const linked = root === null ? undefined
    : data.exceptions.find((entry) => entry.provider === destination.provider && resolvedDirectory(entry.folder) === root)
  return { allowed: false, answer, reason: `${name} gets public work only${linked === undefined ? '' : ` (exception ${linked.id} names this workspace through a link, not by its real path, and counts for nothing)`}` }
}

// ---------------------------------------------------------------------------------------------
// The evaluation

function stricter(a, b) {
  return a === 'private' || b === 'private' ? 'private' : 'public'
}

function hashFile(path) {
  return sha256(readBytes(path))
}

/** Every regular file under the packet, relative paths sorted; a link or special file is invalid. */
function packetManifest(packet) {
  const files = []
  const walk = (directory, prefix) => {
    for (const entry of listDirectory(directory)) {
      const path = `${directory}/${entry.name}`
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path, name)
      else if (entry.isFile()) files.push({ name, sha256: hashFile(path) })
      else refuse('PACKET_INVALID', `${name} in the packet is not a regular file`)
    }
  }
  walk(packet, '')
  return files.sort((a, b) => (a.name < b.name ? -1 : 1))
}

/**
 * The blob `name` holds in the tree of `commit`, read from the workspace's local object store, or
 * null when that object is missing (never fetched), is not a file, or the name is not in the tree.
 */
function committedBlob(workspace, commit, name) {
  try {
    if (git(workspace, ['cat-file', '-t', `${commit}:${name}`], { encoding: 'utf8' }).trim() !== 'blob') return null
    return git(workspace, ['cat-file', 'blob', `${commit}:${name}`])
  } catch {
    return null
  }
}

function readReceiptFile(path) {
  let receipt
  try {
    receipt = JSON.parse(readText(path))
  } catch {
    return null
  }
  if (receipt === null || typeof receipt !== 'object' || receipt.version !== 1 || typeof receipt.receipt_hash !== 'string') return null
  const rest = { ...receipt }
  delete rest.receipt_hash
  return receiptHash(rest) === receipt.receipt_hash ? receipt : null
}

export function receiptHash(body) {
  return sha256(canonicalJson(body))
}

/** Every `<sessions>/YYYY/MM/DD/rollout-*-<id>.jsonl` under a Codex home: none when the session was never saved there, more than one when the id is not one session's. */
export function sessionRecordFiles(codexHome, id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id) || codexHome === null) return []
  const root = `${codexHome}/sessions`
  const found = []
  const walk = (directory, depth) => {
    let entries
    try {
      entries = listDirectory(directory)
    } catch {
      return
    }
    for (const entry of entries) {
      if (depth < 3 && entry.isDirectory() && /^\d+$/.test(entry.name)) walk(`${directory}/${entry.name}`, depth + 1)
      else if (depth === 3 && entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`${id}.jsonl`)) found.push(`${directory}/${entry.name}`)
    }
  }
  walk(root, 0)
  return found
}

/** Finds `<sessions>/YYYY/MM/DD/rollout-*-<id>.jsonl` and returns its first-line metadata. */
export function sessionRecord(codexHome, id) {
  const found = sessionRecordFiles(codexHome, id)
  return found.length === 1 ? sessionRecordAt(found[0]) : null
}

/** The first-line metadata of one Codex session record file; null when it cannot be read as one. */
export function sessionRecordAt(path) {
  let line
  try {
    line = firstLine(path)
  } catch {
    return null
  }
  if (line === null) return null
  try {
    const record = JSON.parse(line)
    const payload = record?.type === 'session_meta' ? record.payload : null
    if (payload === null || typeof payload !== 'object') return null
    return { id: payload.id, cwd: payload.cwd, provider: payload.model_provider, cli_version: payload.cli_version }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Session bindings (60.3 AC8): which receipt started which Codex session

const SESSION_ID = /^[0-9a-f-]{8,64}$/i

export function bindingPath(receiptHashValue) {
  return `${stateDirectory()}/bindings/${receiptHashValue}.json`
}

/**
 * Records that the dispatch a receipt checked started `sessionId`. Accepted once per receipt and
 * only within 10 minutes of the receipt's `issued_at`; a later resume passes only for that session.
 * An OpenCode research run binds its session as well, so its usage is read by the session its check passed (70.4 AC4).
 */
export function bindSession(receiptFile, sessionId, { now = new Date() } = {}) {
  const receipt = readReceiptFile(receiptFile)
  if (receipt === null) throw new RosterError('RECEIPT_INVALID', `${receiptFile} is not an intact version-1 receipt`)
  if (receipt.harness === 'opencode') {
    if (receipt.mode !== 'dispatch' && receipt.mode !== 'research') throw new RosterError('RECEIPT_INVALID', 'only the receipt of an OpenCode dispatch or research run can be bound to a session')
    if (!OPENCODE_SESSION_ID.test(sessionId)) throw new RosterError('RECEIPT_INVALID', `${sessionId} is not an OpenCode session id`)
  } else {
    if (receipt.mode !== 'dispatch' || receipt.harness !== 'codex') throw new RosterError('RECEIPT_INVALID', 'only the receipt of a Codex dispatch can be bound to a session')
    if (!SESSION_ID.test(sessionId)) throw new RosterError('RECEIPT_INVALID', `${sessionId} is not a Codex session id`)
  }
  const age = now.getTime() - Date.parse(receipt.issued_at)
  if (!(age >= 0 && age <= BINDING_WINDOW_MS)) throw new RosterError('RECEIPT_INVALID', 'a session is bound within 10 minutes of the check that preceded it; start a fresh checked dispatch')
  const path = bindingPath(receipt.receipt_hash)
  ensurePrivateDirectory(dirname(path))
  const text = `${JSON.stringify({ version: 1, receipt_hash: receipt.receipt_hash, session_id: sessionId, bound_at: now.toISOString() })}\n`
  let handle
  try {
    handle = openSync(path, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') throw new RosterError('RECEIPT_INVALID', 'this receipt is already bound to a session; a binding is accepted once')
    throw error
  }
  try {
    writeSync(handle, text)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  return { receipt_hash: receipt.receipt_hash, session_id: sessionId }
}

function boundSession(receiptHashValue) {
  try {
    const binding = JSON.parse(readText(bindingPath(receiptHashValue)))
    return isObject(binding) && binding.receipt_hash === receiptHashValue && typeof binding.session_id === 'string' ? binding.session_id : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Consequences of an approval, in words (60.5 AC7; shared with `roster status` and `roster explain`)

/** What approved data lets each agent do, in the terms the check enforces. */
function capabilities(data) {
  const out = new Map()
  for (const agent of data.agents) {
    const active = agentState(agent) === 'active'
    out.set(agent.id, {
      name: agent.name, active, provider: agent.provider, called: isCalled(agent),
      lead: active && agent.roles.includes(LEAD_ROLE) && classRefusal(agent.class, LEAD_ROLE) === null,
      design: active && agent.roles.includes(DESIGNER_ROLE) && classRefusal(agent.class, DESIGNER_ROLE) === null,
      private: active && publicOnlyReasons(agent, data).length === 0,
      roles: new Set(active ? agent.roles : []),
      limit: agent.context_limit
    })
  }
  return out
}

function firstEligible(data, role) {
  const states = new Map(data.agents.map((agent) => [agent.id, agentState(agent)]))
  for (const text of role.candidates) {
    const agent = /^([a-z0-9-]+)@/.exec(text)?.[1]
    if (agent !== undefined && states.get(agent) === 'active') return agent
  }
  return null
}

function listed(names) {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function thousands(value) {
  return String(value).replace(/\B(?=(\d{3})+$)/g, ' ')
}

/**
 * The consequences of moving from `before` to `after` approved data, in words: who could start or
 * stop leading, receiving private work, or taking a role; what a provider's answer changes for its
 * agents; which chain starts elsewhere; which workspaces gain or lose an exception; which app
 * versions the owner accepts. `before` may be null (first approval). Folders are never named here.
 */
export function consequences(before, after) {
  const empty = { agents: [], roles: [], providers: [], exceptions: [], harness_routes: [] }
  const prior = before ?? empty
  const old = capabilities(prior)
  const next = capabilities(after)
  const out = []
  const name = (id) => next.get(id)?.name ?? old.get(id)?.name ?? id
  const none = { active: false, lead: false, design: false, private: false, roles: new Set(), limit: undefined }
  // A provider's changed answer is said once, naming the agents it changes, not once per agent.
  const explained = new Set()
  const oldProviders = new Map(prior.providers.map((provider) => [provider.id, provider]))
  for (const provider of after.providers) {
    const was = oldProviders.get(provider.id)
    if (was === undefined || was.private_work === provider.private_work) continue
    const gains = provider.private_work === 'allowed'
    const affected = [...next.entries()].filter(([id, now]) => now.provider === provider.id && (old.get(id) ?? none).private !== now.private && now.private === gains)
    for (const [id] of affected) explained.add(id)
    const who = listed(affected.map(([id]) => name(id)))
    out.push(gains
      ? `Changing ${provider.name} to Allowed ${who === '' ? 'changes no active agent yet' : `lets ${who} receive private work`}`
      : `Changing ${provider.name} to Public work only ${who === '' ? 'changes no active agent yet' : `stops ${who} receiving private work`}`)
  }
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(id) ?? none
    const b = next.get(id) ?? none
    // An agent BMN itself calls is given no work: it is asked, and it is sent text.
    const called = (next.get(id) ?? old.get(id))?.called === true
    if (!a.active && b.active) out.push(called ? `${name(id)} could be asked as the judge` : `${name(id)} could be given work`)
    if (a.active && !b.active) out.push(called ? `${name(id)} could no longer be asked as the judge` : `${name(id)} could no longer be given work`)
    if (!a.lead && b.lead) out.push(`${name(id)} could lead`)
    if (a.lead && !b.lead) out.push(`${name(id)} could no longer lead`)
    if (!a.design && b.design) out.push(`${name(id)} could design`)
    if (a.design && !b.design) out.push(`${name(id)} could no longer design`)
    if (!explained.has(id)) {
      if (!a.private && b.private) out.push(called ? `${name(id)} could be sent private text` : `${name(id)} could receive private work`)
      if (a.private && !b.private) out.push(called ? `${name(id)} could no longer be sent private text` : `${name(id)} could no longer receive private work`)
    }
    if (a.active && b.active) {
      for (const role of b.roles) if (!a.roles.has(role)) out.push(`${name(id)} could take the ${role} role`)
      for (const role of a.roles) if (!b.roles.has(role)) out.push(`${name(id)} could no longer take the ${role} role`)
    }
    if (old.has(id) && next.has(id) && a.limit !== b.limit) {
      out.push(`${name(id)}: context limit ${a.limit === undefined ? 'app default' : thousands(a.limit)} → ${b.limit === undefined ? 'app default' : thousands(b.limit)}`)
    }
  }
  const oldRoles = new Map(prior.roles.map((role) => [role.id, role]))
  for (const role of after.roles) {
    const previous = oldRoles.get(role.id)
    const first = firstEligible(after, role)
    const was = previous === undefined ? null : firstEligible(prior, previous)
    if (first !== was) {
      out.push(first === null ? `${role.id} would have no agent to start with (then ${role.then})` : `${role.id} would start with ${name(first)}${was === null ? '' : ` instead of ${name(was)}`}`)
    }
    if (previous !== undefined && previous.then !== role.then) out.push(`when every ${role.id} candidate fails: ${role.then} instead of ${previous.then}`)
    // What the check asks of a run for the role (63.2): a role new to read-only refuses more, one freed of it refuses less.
    const heldBefore = previous?.read_only === true
    if (role.read_only === true && !heldBefore) out.push(`${role.id} runs would be refused unless they are started so that they cannot write`)
    if (role.read_only !== true && heldBefore) out.push(`${role.id} runs could be started with write access again`)
  }
  for (const role of prior.roles) if (!after.roles.some((entry) => entry.id === role.id)) out.push(`the ${role.id} role would be removed`)
  // A project choice (73.2): who a role's asks in that project would reach, before and after. The folder is named only in BMN's own review.
  const chosen = (choice) => `${name(choice.agent)}${choice.effort === undefined ? '' : ` at ${choice.effort}`}`
  const chain = (data, roleId) => {
    const role = data.roles.find((entry) => entry.id === roleId)
    const first = role === undefined ? null : firstEligible(data, role)
    return first === null ? "the role's chain, which has no agent to start with" : `the role's chain (${name(first)} first)`
  }
  const oldChoices = new Map((prior.project_choices ?? []).map((choice) => [choice.id, choice]))
  const newChoices = new Map((after.project_choices ?? []).map((choice) => [choice.id, choice]))
  // Two choices that still apply for one role in one project decide nothing: that role's asks there are refused (epic recheck 2).
  // A change that ends or starts such a pair is said as that, for the pair, instead of choice by choice.
  const said = new Set()
  const today = new Date()
  // What a role's asks in one project get under `data`: the choice that applies, the role's chain, or a refusal and why. Every
  // line below says this, never a choice's agent by itself, so a choice whose agent cannot be asked is never said to be reached (AC2, AC4).
  const outcome = (data, project, roleId) => {
    const found = projectChoiceFor(data, project, roleId, canonicalProject, today)
    if (found === null || found.ended) return { reach: chain(data, roleId) }
    if (found.collision !== undefined) return { refused: ' for two choices there' }
    const problem = projectChoiceProblem(data, found.choice)
    return problem === null ? { reach: chosen(found.choice) } : { refused: `: the choice ${found.choice.id} names ${chosen(found.choice)}, who cannot be asked now (${problem})` }
  }
  const was = (group) => (group.reach !== undefined ? group.reach : `being refused${group.refused}`)
  const change = (roleId, before, now) => {
    if (now.refused !== undefined) return now.refused === before.refused ? null : `${roleId} asks in one project would be refused${now.refused}, instead of ${before.reach === undefined ? `being refused${before.refused}` : `reaching ${before.reach}`}`
    return now.reach === before.reach ? null : `${roleId} asks in one project would reach ${now.reach} instead of ${was(before)}`
  }
  const push = (line) => {
    if (line !== null && !out.includes(line)) out.push(line)
  }
  if (oldChoices.size + newChoices.size > 0) {
    const pairKey = (group) => `${group.project}\n${group.role}`
    const pairsBefore = new Map(projectChoiceCollisions(prior.project_choices, canonicalProject, today).map((group) => [pairKey(group), group]))
    const pairsAfter = new Map(projectChoiceCollisions(after.project_choices, canonicalProject, today).map((group) => [pairKey(group), group]))
    // A pair that ends: the choice left decides, or its asks stay refused because its agent cannot be asked (AC4).
    for (const [key, group] of pairsBefore) {
      if (pairsAfter.has(key)) continue
      const left = outcome(after, group.project, group.role)
      out.push(left.refused === undefined ? `${group.role} asks in one project would reach ${left.reach} instead of being refused for two choices there`
        : `${group.role} asks in one project would stay refused${left.refused.replace(/^: the choice (\S+) names/u, ': the choice left, $1, names')}, instead of being refused for two choices there`)
      for (const choice of group.choices) said.add(choice.id)
    }
    for (const [key, group] of pairsAfter) {
      if (pairsBefore.has(key)) continue
      const before = outcome(prior, group.project, group.role)
      out.push(`${group.role} asks in one project would be refused for two choices there instead of ${before.reach === undefined ? `being refused${before.refused}` : `reaching ${before.reach}`}`)
      for (const choice of group.choices) said.add(choice.id)
    }
  }
  for (const id of new Set([...oldChoices.keys(), ...newChoices.keys()])) {
    if (said.has(id)) continue
    const then = oldChoices.get(id)
    const now = newChoices.get(id)
    const moved = then === undefined || now === undefined || then.project !== now.project || then.role !== now.role
    if (moved) {
      if (then !== undefined) push(change(then.role, outcome(prior, canonicalProject(then.project), then.role), outcome(after, canonicalProject(then.project), then.role)))
      // A choice for a role the team did not have was compared with that role's chain as it will be.
      if (now !== undefined) {
        const project = canonicalProject(now.project)
        push(change(now.role, prior.roles.some((role) => role.id === now.role) ? outcome(prior, project, now.role) : { reach: chain(after, now.role) }, outcome(after, project, now.role)))
      }
      continue
    }
    // An unchanged choice is said too when what its asks get changes: its agent turned off, or back on (AC4).
    const project = canonicalProject(now.project)
    const before = outcome(prior, project, now.role)
    const current = outcome(after, project, now.role)
    const ends = (choice) => (choice.ends === undefined ? 'with no end date' : `until ${choice.ends}`)
    // The end date is said with the choice it belongs to when that choice decides before and after.
    if (then.ends !== now.ends && current.reach === chosen(now) && before.reach === chosen(then)) {
      push(`${now.role} asks in one project would reach ${chosen(now)} ${ends(now)} instead of ${chosen(then) === chosen(now) ? '' : `${chosen(then)} `}${ends(then)}`)
    } else push(change(now.role, before, current))
  }
  // Who researches (63.3): naming the first researcher closes the offer to every other agent; after that only the named ones change.
  const researched = namedResearchers(prior)
  const researching = namedResearchers(after)
  const nobody = 'no agent would be offered as a researcher; every research would be refused'
  if (researched === null && researching !== null) out.push(researching.length === 0 ? nobody : `only ${listed(researching.map(name))} would be offered as researchers; a research with any other agent would be refused`)
  else if (researched !== null && researching === null) out.push('every agent that can research would be offered as a researcher again')
  else if (researched !== null && researching !== null) {
    for (const id of researching) if (!researched.includes(id)) out.push(`${name(id)} would be offered as a researcher`)
    for (const id of researched) if (!researching.includes(id)) out.push(`${name(id)} would no longer be offered as a researcher`)
    if (researching.length === 0 && researched.length > 0) out.push(nobody)
  }
  const providerName = (id) => after.providers.find((provider) => provider.id === id)?.name ?? oldProviders.get(id)?.name ?? id
  const exceptionKey = (entry) => `${entry.provider}\n${entry.folder}`
  const oldExceptions = new Set(prior.exceptions.map(exceptionKey))
  const newExceptions = new Set(after.exceptions.map(exceptionKey))
  const count = (entries, others) => {
    const perProvider = new Map()
    for (const entry of entries) if (!others.has(exceptionKey(entry))) perProvider.set(entry.provider, (perProvider.get(entry.provider) ?? 0) + 1)
    return perProvider
  }
  for (const [provider, added] of count(after.exceptions, oldExceptions)) {
    out.push(`${providerName(provider)} could receive private work in ${added === 1 ? 'one more workspace' : `${added} more workspaces`}`)
  }
  for (const [provider, removed] of count(prior.exceptions, newExceptions)) {
    out.push(`${providerName(provider)} could no longer receive private work in ${removed === 1 ? 'one workspace' : `${removed} workspaces`}`)
  }
  const oldRoutes = new Map(prior.harness_routes.map((route) => [route.harness, route]))
  for (const route of after.harness_routes) {
    const app = appName(route.harness)
    const previous = oldRoutes.get(route.harness)
    if (previous !== undefined && (previous.provider !== route.provider || previous.basis !== route.basis)) {
      out.push(route.basis === 'owner-declared'
        ? `${app} would count as sending data to ${providerName(route.provider)} on your word, so it gets public work only`
        : `${app} would count as sending data to ${providerName(route.provider)}, as inspected`)
    }
  }
  // A skill's marks: which apps would start or stop being meant to have it (60.11 AC5). The folder is never named here.
  const marks = (data) => new Map((data.skills ?? []).map((entry) => [entry.id, entry]))
  const oldMarks = marks(prior)
  const newMarks = marks(after)
  const mayHave = (mark, harness) => (mark?.only === undefined || mark.only.includes(harness)) && (harnessPrivateWork(after, harness).allowed || mark?.public === true)
  for (const id of [...new Set([...oldMarks.keys(), ...newMarks.keys()])].sort()) {
    const was = oldMarks.get(id)
    const now = newMarks.get(id)
    if (canonicalJson(was ?? null) === canonicalJson(now ?? null)) continue
    const gains = HARNESSES.filter((harness) => !mayHave(was, harness) && mayHave(now, harness)).map((harness) => APP_NAMES[harness])
    const loses = HARNESSES.filter((harness) => mayHave(was, harness) && !mayHave(now, harness)).map((harness) => APP_NAMES[harness])
    if (gains.length > 0) out.push(`Skill ${id} would reach ${listed(gains)}`)
    if (loses.length > 0) out.push(`Skill ${id} would no longer reach ${listed(loses)}`)
    if (gains.length === 0 && loses.length === 0) out.push(`Skill ${id}: no app gains or loses it`)
  }
  if ((prior.skills_source ?? null) !== (after.skills_source ?? null)) out.push('Skills would come from another folder')
  // A tool: which apps' settings would gain it, lose it or hold it changed at the next install, and whose runs would carry it (60.12 AC6).
  const toolsOf = (data) => new Map((data.tools ?? []).map((tool) => [tool.id, tool]))
  const oldTools = toolsOf(prior)
  const newTools = toolsOf(after)
  const inApp = (data, tool, harness) => tool !== undefined && tool.agents === undefined && (tool.apps === undefined || tool.apps.includes(harness))
    && (harnessPrivateWork(data, harness).allowed || tool.public === true)
  const what = (tool) => canonicalJson([tool.command ?? null, tool.args ?? [], tool.url ?? null, tool.env ?? {}, tool.headers ?? {}])
  for (const id of [...new Set([...oldTools.keys(), ...newTools.keys()])].sort()) {
    const was = oldTools.get(id)
    const now = newTools.get(id)
    if (canonicalJson(was ?? null) === canonicalJson(now ?? null)) continue
    const gains = HARNESSES.filter((harness) => !inApp(prior, was, harness) && inApp(after, now, harness)).map((harness) => APP_NAMES[harness])
    const loses = HARNESSES.filter((harness) => inApp(prior, was, harness) && !inApp(after, now, harness)).map((harness) => APP_NAMES[harness])
    const changes = was !== undefined && now !== undefined && what(was) !== what(now)
      ? HARNESSES.filter((harness) => inApp(prior, was, harness) && inApp(after, now, harness)).map((harness) => APP_NAMES[harness]) : []
    const gained = (now?.agents ?? []).filter((agent) => !(was?.agents ?? []).includes(agent))
    // A run gets a tool of its own only in an app BMN can keep to its tools; elsewhere the tool is listed and waits.
    const appOf = (agent) => after.agents.find((entry) => entry.id === agent)?.harness
    const given = gained.filter((agent) => RUN_TEST_APPS.includes(appOf(agent))).map(name)
    const waiting = gained.filter((agent) => !RUN_TEST_APPS.includes(appOf(agent)))
    const taken = (was?.agents ?? []).filter((agent) => !(now?.agents ?? []).includes(agent)).map(name)
    // The owner knows a tool by its name, as its row shows it.
    const title = (now ?? was).name
    const said = out.length
    if (gains.length > 0) out.push(`Tool ${title} would reach ${listed(gains)}`)
    if (loses.length > 0) out.push(`Tool ${title} would no longer reach ${listed(loses)}`)
    if (changes.length > 0) out.push(`Tool ${title} would change in ${listed(changes)}`)
    if (given.length > 0) out.push(`Tool ${title} would be given to the runs of ${listed(given)}`)
    for (const agent of waiting) out.push(`Tool ${title} is for the runs of ${name(agent)}, and BMN cannot give a ${appName(appOf(agent))} run a tool yet`)
    if (taken.length > 0) out.push(`Tool ${title} would no longer be given to the runs of ${listed(taken)}`)
    if (out.length === said) out.push(`Tool ${title}: no app gains or loses it`)
  }
  // The first tool on the list changes what the check asks of every run, also of an agent that has none.
  if (oldTools.size === 0 && newTools.size > 0) out.push('With a tool on the list, the check keeps every Claude Code run to exactly its own tools, once its tools test passed there; it does not judge the tools of a Codex run')
  if (oldTools.size > 0 && newTools.size === 0) out.push('With no tool on the list, the check no longer looks at which tools a run has')
  return [...new Set(out)]
}

// ---------------------------------------------------------------------------------------------
// Evaluating a dispatch

/** The approved agent a check is about, or the first refusal that applies to it. */
function activeAgent(generation, id) {
  const agent = generation.data.agents.find((candidate) => candidate.id === id)
  if (agent === undefined) refuse('UNKNOWN_AGENT', `no agent ${id} in approved version ${generation.number}`)
  // An agent BMN itself calls runs in no agent app: there is no command of it to check (65.1 AC4).
  if (isCalled(agent)) refuse('CALLED_BY_BMN', `${agent.id} is called by BMN itself and runs in no agent app, so no dispatch command is checked for it`)
  const state = agentState(agent)
  if (state === 'retired') refuse('APP_RETIRED', `${agent.id} runs in ${retiredWords(agent.harness)}`)
  if (state === 'proposed') refuse('PROPOSED', `${agent.id} is proposed, not approved as active`)
  if (state === 'disabled') refuse('DISABLED', `${agent.id} is disabled`)
  return agent
}

function checkModelAndEffort(agent, resolution, note) {
  const model = resolution.model
  if (model === null) refuse('MODEL_MISMATCH', `the command names no model; ${agent.id} is ${agent.model}`)
  if (model.value !== agent.model && !(agent.aliases ?? []).includes(model.value)) {
    refuse('MODEL_MISMATCH', `${model.source} ${model.value} is not ${agent.model}${agent.aliases?.length ? ` or ${agent.aliases.join(', ')}` : ''}`)
  }
  note(`model ${model.value} (${model.source})`)
  const effort = resolution.effort
  if (effort === null) refuse('EFFORT_UNSUPPORTED', 'the command names no effort')
  if (!agent.efforts.includes(effort.value)) refuse('EFFORT_UNSUPPORTED', `${effort.source} ${effort.value} is not among ${agent.id}'s efforts (${agent.efforts.join(', ')})`)
  note(`effort ${effort.value} (${effort.source})`)
  return { model, effort }
}

/** A role that names efforts for the agent allows no other, also where the agent itself lists it (63.2 AC1). */
function checkRoleEffort(role, agent, effort, note) {
  const named = roleEfforts(role, agent.id)
  if (named.length === 0) return
  if (!named.includes(effort.value)) {
    refuse('EFFORT_UNSUPPORTED', `${effort.source} ${effort.value} is not an effort the role ${role.id} names for ${agent.id} (${named.join(', ')})`, `role ${role.id} allows ${named.join(', ')}`)
  }
  note(`role ${role.id} names ${named.join(', ')} for ${agent.id}`)
}

/** The Claude Code tools that cannot change a file: the only ones a run for a read-only role may be given (63.2 AC3). */
export const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']
/**
 * The owner-authorized write-attempt test behind the Claude Code form (2026-10-11, Haiku, empty
 * throwaway folders; `scripts/test/claude-write-attempt.sh`, results in docs/agent-control.md). With a
 * tool list of Read, Grep and Glob and no MCP server the run is offered exactly those three tools,
 * with or without --safe-mode. The tool list alone is not enough: the owner's MCP tools stay offered.
 * `--permission-mode plan` is not accepted: the app refused the Write tool, but no shell command was
 * attempted under it, and with the owner's settings his MCP tools stay offered there too.
 */
export const CLAUDE_READ_ONLY_TESTED = { version: '2.1.296', on: '2026-10-11' }
/** What a command for a read-only role must carry, per app, as `bmn roster role --json` hands it out. */
export const READ_ONLY_ITEMS = {
  codex: ['--sandbox', 'read-only', '-c', 'approval_policy="never"'],
  claude: ['--tools', CLAUDE_READ_ONLY_TOOLS.join(','), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
}

/**
 * A run for a role the approved team marks read-only must not be able to write (63.2 AC2, AC3).
 * Codex: the sandbox resolves to read-only and approvals to never, from the command, the selected
 * profile or the owner's own file. Claude Code: the one form the write-attempt test showed. Returns
 * what the receipt records, or refuses with READ_ONLY_REQUIRED and says what the command must carry.
 */
function checkReadOnly(role, parsed, resolution, version, note) {
  const stop = (why, must) => refuse('READ_ONLY_REQUIRED', `${role.id} is a read-only role and ${why}; the command must carry ${must}`)
  if (parsed.harness === 'opencode') {
    // The only OpenCode form the check reads runs BMN's own agent from BMN's own folder, both checked whole above.
    note(`read-only role: BMN's agent ${OPENCODE_HELPER_AGENT} (only reading inside the project; the form shown on OpenCode ${OPENCODE_FORM_TESTED.version}${version === OPENCODE_FORM_TESTED.version ? '' : `; this is ${version ?? 'a version BMN cannot read'}`})`)
    return { mode: 'read-only', source: `--agent ${OPENCODE_HELPER_AGENT}`, agent_sha256: OPENCODE_HELPER_AGENT_SHA256, form_tested_on: OPENCODE_FORM_TESTED.version }
  }
  if (parsed.harness === 'codex') {
    const must = '--sandbox read-only and -c approval_policy="never"'
    const { sandbox, approvals } = resolution.access
    if (sandbox === null) stop('the command names no sandbox', must)
    if (sandbox.unresolved) stop(`its sandbox cannot be resolved: ${sandbox.unresolved}`, must)
    if (sandbox.value !== 'read-only') stop(`${sandbox.source} gives the run the ${sandbox.value} sandbox`, must)
    if (approvals === null) stop('nothing says the run may never ask for more access', must)
    if (approvals.unresolved) stop(`whether it may ask for more access cannot be resolved: ${approvals.unresolved}`, must)
    if (approvals.value !== 'never') stop(`${approvals.source} lets the run ask for more access (${approvals.value})`, must)
    note(`read-only role: sandbox read-only (${sandbox.source}), approvals never (${approvals.source})`)
    return { mode: 'read-only', source: sandbox.source, approval_policy: 'never', approval_source: approvals.source }
  }
  const must = `--tools naming only ${CLAUDE_READ_ONLY_TOOLS.join(', ')} (or '' for none), --strict-mcp-config and --mcp-config '{"mcpServers":{}}'`
  if (parsed.tools === undefined) stop('the command names no tool list, so the run gets the tools that write', must)
  const names = parsed.tools.split(/[,\s]+/).filter((name) => name !== '')
  const writing = names.filter((name) => !CLAUDE_READ_ONLY_TOOLS.includes(name))
  if (writing.length > 0) stop(`--tools gives the run ${writing.join(', ')}`, must)
  if (!parsed.strictMcp) stop('without --strict-mcp-config the run is offered your MCP tools, which BMN cannot hold to reading', must)
  // The form the write-attempt test showed names an empty server list; the same command without one was not tried, so it is not accepted.
  if (parsed.mcpConfig === undefined) stop('the command names no empty MCP server list, which is part of the form the write test showed', must)
  if (!emptyMcpConfig(parsed.mcpConfig)) stop('--mcp-config gives the run an MCP server, which BMN cannot hold to reading', must)
  if (parsed.permissionMode === 'bypassPermissions') stop('--permission-mode bypassPermissions switches every permission check off', must)
  note(`read-only role: tools ${names.join(', ') || 'none'}, no MCP server (the form shown on Claude Code ${CLAUDE_READ_ONLY_TESTED.version}${version === CLAUDE_READ_ONLY_TESTED.version ? '' : `; this is ${version ?? 'a version BMN cannot read'}`})`)
  return { mode: 'read-only', source: '--tools', tools: names, form_tested_on: CLAUDE_READ_ONLY_TESTED.version }
}

/** The destination the command reaches, matched against the agent's approved host (60.3 AC4). */
function matchedDestination(data, agent, harness, route, note) {
  const destination = destinationOf(data, harness, route)
  if (!destination.known) refuse('HOST_UNKNOWN', `the destination cannot be resolved: ${destination.reason}`)
  if (agent.host === null) refuse('HOST_UNKNOWN', `${agent.id}'s approved host is unknown (null)`)
  if (agent.host === 'default') {
    if (!destination.default || destination.unapproved !== undefined || destination.provider !== agent.provider) {
      refuse('HOST_MISMATCH', `the command reaches ${destination.host}, the roster approved default:${agent.provider}`)
    }
  } else if (destination.default || destination.host !== agent.host.toLowerCase()) {
    refuse('HOST_MISMATCH', `the command reaches ${destination.host}, the roster approved ${agent.host}`)
  } else if (destination.provider !== agent.provider) {
    refuse('HOST_UNKNOWN', `no provider in the approved roster lists ${destination.host} as ${agent.provider}'s host`)
  }
  note(`destination ${destination.host}, provider ${destination.provider} (${destination.basis}${route.sources.length ? `; decided by ${route.sources.join(', ')}` : ''})`)
  return destination
}

/** Whether dotted version `a` is later than `b`; false when either does not read as numbers. */
function laterVersion(a, b) {
  const parts = (text) => text.split(/[-+]/)[0].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : NaN))
  const [left, right] = [parts(a), parts(b)]
  if ([...left, ...right].some(Number.isNaN)) return false
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

/**
 * The word beside an app's version: `tested`, `newer than BMN tested`, `not a version BMN tested`
 * or `version unreadable`. It refuses nothing; BMN reads where an app sends data the same way on
 * every version.
 */
export function versionStanding(harness, version, tested = TESTED_HARNESS_VERSIONS) {
  if (version === null) return { tested: false, state: 'version unreadable' }
  const known = tested[harness] ?? []
  if (known.includes(version)) return { tested: true, state: 'tested' }
  const newer = known.length > 0 && known.every((entry) => laterVersion(version, entry))
  return { tested: false, state: newer ? 'newer than BMN tested' : 'not a version BMN tested' }
}

function receiptRoute(destination, route) {
  return { provider: destination.provider, host: destination.host, basis: destination.basis, sources: route.sources, harness_provider: destination.harness_provider }
}

function receiptAnswer(answer) {
  return { answer: answer.answer, allowed: answer.allowed, ...(answer.exception ? { exception: answer.exception } : {}) }
}

/**
 * Evaluates one dispatch against the approved generation. Returns `{ verdict: 'PASS', receipt, steps }`
 * or `{ verdict: 'REFUSED', code, message, next, steps }`; `steps` is what `explain` prints.
 * `publicRules` is the public rules rendering a packet's --append-system-prompt must equal;
 * `testedVersions` and `resumeVersions` are the tests' seams for the version lists.
 */
export function evaluate(inputs, {
  environment = process.env, cwd: processCwd = process.cwd(), publicRules = null, now = new Date(),
  testedVersions = TESTED_HARNESS_VERSIONS, resumeVersions = RESUME_TESTED_VERSIONS, contextTestLog = undefined, toolsTestLog = undefined, toolsPolicyRoot = undefined
} = {}) {
  const steps = []
  const note = (text) => steps.push(text)
  try {
    // A missing or invalid team file stops here (R60-NFR1); a valid one that differs from the approved version is a pending edit.
    const file = readValidRoster()
    const generation = readApproved()
    const data = generation.data
    note(`approved version ${generation.number}`)
    const agent = activeAgent(generation, inputs.agent)
    note(`agent ${agent.id}: ${agent.class}, ${agent.harness} ${agent.model}, provider ${agent.provider}`)
    const role = data.roles.find((candidate) => candidate.id === inputs.role)
    if (role === undefined) refuse('ROLE_UNKNOWN', `no role ${inputs.role} in the approved ## roles`)
    if (!agent.roles.includes(role.id)) refuse('ROLE_INELIGIBLE', `${agent.id} does not hold role ${role.id}`)
    const classRule = classRefusal(agent.class, role.id)
    if (classRule !== null) refuse(classRule.code, `${agent.id} is a ${agent.class}; ${classRule.rule}`)
    note(`role ${role.id}: held`)

    const parsed = parseDispatch(inputs.argv)
    if (parsed.unsupported) refuse('ROUTE_UNSUPPORTED', parsed.unsupported)
    if (parsed.ephemeral) refuse('ROUTE_UNSUPPORTED', 'codex exec --ephemeral belongs to a research run (bmn roster check --research)')
    if (agent.harness !== parsed.harness) {
      refuse('ROUTE_UNSUPPORTED', `${agent.id} runs on ${agent.harness}, the command is ${parsed.harness}`)
    }
    const cwd = canonicalDirectory(inputs.cwd ?? processCwd, processCwd)
    const resolution = parsed.harness === 'codex'
      ? resolveCodexRoute(parsed, environment, cwd ?? processCwd)
      : parsed.harness === 'opencode' ? resolveOpenCodeRoute(parsed) : resolveClaudeRoute(parsed, environment, cwd ?? processCwd)
    if (resolution.unsupported) refuse('ROUTE_UNSUPPORTED', resolution.unsupported)
    const version = harnessVersion(parsed.command, dispatchEnvironment(parsed, environment))
    if (parsed.resume && !(version !== null && (resumeVersions[parsed.harness] ?? []).includes(version))) {
      refuse('ROUTE_UNSUPPORTED', `resume is not checked on ${parsed.harness} ${version ?? '(version unreadable)'}: BMN has not tested that a resume on this version talks to the current configuration's destination; start a fresh checked dispatch`)
    }
    note(`dispatch form: ${parsed.envMode === 'clean' ? 'env -i ' : ''}${parsed.harness === 'codex' ? `codex exec${parsed.resume ? ' resume' : ''}` : parsed.harness === 'opencode' ? 'opencode run' : 'claude -p'}`)
    // The tools of this run (60.12 AC5): once the team lists any, the run is kept to exactly its agent's set and
    // shut off from everything else, judged with the run's own environment and the folder it works in (Codex's
    // `-C` where it gives one). The test log is read only then. A version without a run seen kept to its tools,
    // or a place its test did not cover, is refused here; a wrong set further down, each in its place in the order.
    const packetRun = inputs.packet !== undefined
    const runFolder = cwd ?? processCwd
    const tools = checkRunTools(agent, data, parsed,
      (data.tools ?? []).length > 0 ? appTools(parsed.harness, { version, tests: toolsTestLog }) : { isolation: false, variable: false },
      { packet: packetRun, profile: typeof resolution.profile === 'string', environment: dispatchEnvironment(parsed, environment),
        cwd: parsed.cd === undefined ? runFolder : (canonicalDirectory(parsed.cd, runFolder) ?? null), ...(toolsPolicyRoot === undefined ? {} : { policyRoot: toolsPolicyRoot }) })
    if (tools.refusal?.code === 'ROUTE_UNSUPPORTED') refuse('ROUTE_UNSUPPORTED', tools.refusal.message)

    // OpenCode names a model with its provider; an agent that names the model alone is read with its provider.
    const named = parsed.harness === 'opencode' && !agent.model.includes('/') ? { ...agent, model: `${agent.provider}/${agent.model}` } : agent
    const { model, effort } = checkModelAndEffort(named, resolution, note)
    checkRoleEffort(role, agent, effort, note)
    // A role that may write is judged as before and its receipt carries nothing more (63.2 AC5).
    const readOnly = role.read_only === true ? checkReadOnly(role, parsed, resolution, version, note) : null
    // Required only where the owner's test proved the setting on this version (60.9 AC1, AC2).
    // The test log is read only for an agent that has a limit.
    const context = checkContext(agent, resolution.context, agent.context_limit === undefined ? { limit: false, compact: false } : provenControls(parsed.harness, version, contextTestLog),
      agent.context_limit === undefined ? [] : provenPrecedence(parsed.harness, version, contextTestLog))
    if (context.refusal) refuse('CONTEXT_MISMATCH', context.refusal, context.why)
    note(context.note)
    if (tools.refusal) refuse(tools.refusal.code, tools.refusal.message)
    note(tools.note)
    const route = resolution.route
    const destination = matchedDestination(data, agent, parsed.harness, route, note)

    if (typeof inputs.workspace !== 'string' || inputs.workspace.split('/').includes('..')) refuse('WORKSPACE_UNKNOWN', 'the workspace path contains ..')
    const workspace = canonicalDirectory(inputs.workspace, processCwd)
    if (workspace === null) refuse('WORKSPACE_UNKNOWN', `${inputs.workspace} is not an existing directory`)
    // The home folder and / hold every project, sign-in and configuration: never one workspace (R72-FR9).
    const homes = [environment.HOME, homedir()].filter((path) => typeof path === 'string' && isAbsolute(path)).flatMap((path) => {
      // Only where the home folder really is: no file in it is opened.
      try {
        return [realpathSync(path)]
      } catch {
        return [path]
      }
    })
    if (workspace === '/' || homes.includes(workspace)) refuse('WORKSPACE_UNKNOWN', `${workspace === '/' ? '/ is the whole file system' : `${workspace} is the home folder`}, never a workspace: name the project folder the dispatch works in`)
    if (cwd === null) refuse('WORKSPACE_MISMATCH', `--cwd ${inputs.cwd} is not an existing directory without ..`)
    // An unreadable packet is a packet refusal, reported in its place in the order, after every earlier one.
    const packet = inputs.packet === undefined ? null : canonicalDirectory(inputs.packet, processCwd)
    const packetMissing = inputs.packet !== undefined && packet === null
    const within = (dir) => inside(dir, workspace) || (packet !== null && inside(dir, packet))
    if (!within(cwd)) refuse('WORKSPACE_MISMATCH', `cwd ${cwd} is outside the workspace${packet ? ' and the packet' : ''}`)
    // Every directory the agent would work in.
    const reached = [cwd]
    if (parsed.cd !== undefined) {
      const target = canonicalDirectory(parsed.cd, cwd)
      if (target === null || !within(target)) refuse('WORKSPACE_MISMATCH', `-C ${parsed.cd} is outside the workspace${packet ? ' and the packet' : ''}`)
      reached.push(target)
    }
    for (const dir of parsed.addDir ?? []) {
      const target = canonicalDirectory(dir, cwd)
      if (target === null || !inside(target, workspace)) refuse('WORKSPACE_MISMATCH', `--add-dir ${dir} is outside the workspace`)
      reached.push(target)
    }
    // An exception and a public record belong to one workspace root. A directory with another root
    // (a repository nested in the workspace, a subfolder of a workspace outside Git) or in a packet
    // outside it is another workspace (60.8 AC6): the exception does not cover the dispatch, and
    // work in a nested workspace is private.
    const root = workspaceRoot(workspace)
    const nested = reached.find((dir) => inside(dir, workspace) && workspaceRoot(dir) !== root)
    const answer = privateWorkAnswer(data, destination, nested === undefined && reached.every((dir) => inside(dir, workspace)) ? root : null)
    note(`private work: ${answer.reason}`)
    const visibility = workspaceVisibility(workspace, now)
    const dataLabel = stricter(stricter(visibility.public ? 'public' : 'private', inputs.data), nested === undefined ? 'public' : 'private')
    note(`workspace ${workspace}: ${visibility.public ? `public (${visibility.reason})` : `private (${visibility.reason})`}; data ${dataLabel}${nested === undefined ? '' : ` (${nested} is another workspace inside this one)`}`)
    let stdin = null
    let stdinProblem = null
    if (inputs.stdin !== undefined) {
      const path = isAbsolute(inputs.stdin) ? inputs.stdin : `${cwd}/${inputs.stdin}`
      try {
        stdin = { path: realpathSync(path), sha256: hashFile(realpathSync(path)) }
      } catch {
        stdinProblem = `--stdin ${inputs.stdin} cannot be read`
      }
    }
    // For a destination that may receive private work an unreadable prompt is a workspace problem,
    // reported here; for a public-only one it is a packet problem, reported last.
    if (stdinProblem !== null && answer.allowed && inputs.packet === undefined) refuse('WORKSPACE_MISMATCH', stdinProblem)

    let resume = null
    if (parsed.resume) {
      if (packet !== null) refuse('RESUME_UNBOUND', 'a resume never passes in packet mode')
      if (inputs.resumeOf === undefined) refuse('RESUME_UNBOUND', 'codex exec resume needs --resume-of <receipt of the dispatch that started it>')
      const original = readReceiptFile(inputs.resumeOf)
      if (original === null) refuse('RESUME_UNBOUND', `${inputs.resumeOf} is not an intact version-1 receipt`)
      if (boundSession(original.receipt_hash) !== parsed.resume.id) {
        refuse('RESUME_UNBOUND', `BMN holds no binding of that receipt to session ${parsed.resume.id} (bmn roster bind, when the session starts)`)
      }
      const same = original.mode === 'dispatch' && original.agent === agent.id && original.model === model.value && original.harness === parsed.harness
        && original.workspace === workspace && original.public_status?.public === visibility.public
        && canonicalJson(original.route) === canonicalJson(receiptRoute(destination, route))
      if (!same) refuse('RESUME_UNBOUND', 'the original receipt\'s agent, model, workspace, public status or destination differs from this dispatch')
      const record = sessionRecord(resolution.configHome, parsed.resume.id)
      if (record === null) refuse('RESUME_UNBOUND', `no single readable Codex session record for ${parsed.resume.id}`)
      let recordCwd = null
      try {
        recordCwd = typeof record.cwd === 'string' ? realpathSync(record.cwd) : null
      } catch {
        recordCwd = null
      }
      if (record.id !== parsed.resume.id || recordCwd === null || !inside(recordCwd, workspace) || record.provider !== original.route.harness_provider) {
        refuse('RESUME_UNBOUND', 'the session record\'s id, cwd or provider does not match this dispatch')
      }
      resume = { session_id: parsed.resume.id, original_receipt_hash: original.receipt_hash, original_receipt: inputs.resumeOf, data: original.data }
      note(`resume bound to receipt ${original.receipt_hash.slice(0, 12)} and session ${parsed.resume.id}`)
    }
    const effectiveData = resume === null ? dataLabel : stricter(dataLabel, resume.data)

    if (effectiveData === 'private' && version === null) {
      refuse('HARNESS_UNKNOWN', `${parsed.harness}: BMN cannot read this app's version, so it cannot tell which program would run`)
    }
    const standing = versionStanding(parsed.harness, version, testedVersions)
    note(`${parsed.harness} ${version ?? '(version unreadable)'}: ${standing.state}`)

    let manifest = null
    if (!answer.allowed) {
      if (effectiveData === 'private') refuse('DATA_FORBIDDEN', `private work never goes there: ${answer.reason}`)
      if (parsed.harness !== 'claude') refuse('PACKET_INVALID', `public work reaches a public-only destination only as a packet through claude -p, not ${parsed.harness}`)
      if (packetMissing) refuse('PACKET_INVALID', `--packet ${inputs.packet} is not an existing directory`)
      if (packet === null) refuse('PACKET_INVALID', 'a public-only destination receives public work only in packet mode (--packet)')
      if (parsed.envMode !== 'clean') refuse('PACKET_INVALID', 'packet mode needs env -i')
      if (!parsed.safeMode) refuse('PACKET_INVALID', 'packet mode needs --safe-mode')
      if (parsed.tools !== '') refuse('PACKET_INVALID', "packet mode needs --tools ''")
      if (parsed.addDir.length > 0) refuse('PACKET_INVALID', 'packet mode allows no --add-dir')
      if (parsed.settings !== undefined) refuse('PACKET_INVALID', 'packet mode allows no --settings')
      if (parsed.mcpConfig !== undefined && !emptyMcpConfig(parsed.mcpConfig)) refuse('PACKET_INVALID', 'packet mode allows only an empty --mcp-config')
      if (!inside(cwd, packet)) refuse('PACKET_INVALID', 'packet mode runs from inside the packet')
      if (stdinProblem !== null) refuse('PACKET_INVALID', stdinProblem)
      if (stdin === null || !inside(stdin.path, packet)) refuse('PACKET_INVALID', '--stdin must name the prompt file inside the packet')
      if (parsed.appendSystemPrompt !== undefined && parsed.appendSystemPrompt !== (typeof publicRules === 'function' ? publicRules() : publicRules)) {
        refuse('PACKET_INVALID', '--append-system-prompt must be the public rules rendering or absent')
      }
      if (!visibility.public) refuse('PACKET_INVALID', `the workspace whose files the packet carries is not proven public (${visibility.reason}); run bmn roster visibility --refresh`)
      manifest = packetManifest(packet)
      const prompt = relative(packet, stdin.path).split(sep).join('/')
      for (const file of manifest) {
        if (file.name === prompt) continue
        const blob = committedBlob(workspace, visibility.record.commit, file.name)
        if (blob === null || sha256(blob) !== file.sha256) {
          refuse('PACKET_INVALID', `${file.name} is not byte-identical to a file in commit ${visibility.record.commit.slice(0, 12)}, the one GitHub serves for ${visibility.record.origin}`)
        }
      }
      note(`packet ${packet}: ${manifest.length} file(s); the prompt is lead-authored, not verified`)
    } else if (packetMissing) {
      refuse('PACKET_INVALID', `--packet ${inputs.packet} is not an existing directory`)
    } else if (stdinProblem !== null) {
      refuse('PACKET_INVALID', stdinProblem)
    } else if (packet !== null) {
      manifest = packetManifest(packet)
    }

    const body = {
      version: 1, mode: 'dispatch', verdict: 'PASS', agent: agent.id, class: agent.class, harness: parsed.harness, model: model.value,
      role: role.id, effort: effort.value, context_limit_applied: context.applied,
      // A limit of the agent's own that this run does not get, with the reason: whether BMN will test the version by itself or its own testing is switched off (63.1).
      ...(agent.context_limit !== undefined && context.applied === null ? { context_limit_note: context.note } : {}),
      // What the check saw of a read-only role's run: its sandbox and approvals (Codex) or its tool list (Claude Code).
      ...(readOnly === null ? {} : { sandbox: readOnly }),
      // The tools this run was given and a hash of their definitions: variable names, never a value.
      // Bound whenever the run was kept to a set, an empty one too; a run of a team without tools carries no such entry.
      // A run whose tools BMN could not judge (Codex) says so, so no receipt reads as kept to a set that was not checked.
      ...(tools.hash !== undefined ? { tools: { applied: tools.applied, sha256: tools.hash } } : tools.unchecked ? { tools: { checked: false } } : {}),
      workspace, cwd,
      public_status: { public: visibility.public, reason: visibility.reason, ...(visibility.public ? { commit: visibility.record.commit } : {}) },
      data: effectiveData,
      argv_sha256: sha256(canonicalJson(inputs.argv)),
      harness_version: { version, state: standing.state },
      route: receiptRoute(destination, route),
      private_work: receiptAnswer(answer),
      generation: { number: generation.number, hash: generation.hash },
      roster_file_hash: file.hash,
      ...(resume ? { resume: { session_id: resume.session_id, original_receipt_hash: resume.original_receipt_hash, original_receipt: resume.original_receipt } } : {}),
      ...(packet !== null ? { packet: { path: packet, manifest, prompt: 'lead-authored, not verified' } } : {}),
      ...(stdin !== null ? { stdin } : {}),
      issued_at: now.toISOString()
    }
    // Said beside the PASS, never inside the receipt: what passed and its receipt stay what they were.
    const webNote = parsed.harness === 'claude' && namesWebTool(parsed.tools)
    if (webNote) note(WEB_TOOLS_NOTE)
    return { verdict: 'PASS', receipt: { ...body, receipt_hash: receiptHash(body) }, steps, ...(webNote ? { note: WEB_TOOLS_NOTE } : {}) }
  } catch (error) {
    if (error instanceof Refusal) {
      const next = error.code === 'ROUTE_UNSUPPORTED' && Array.isArray(inputs.argv) && reachedForWeb(inputs.argv, error.message) ? WEB_NEXT_STEP
        : error.code === 'ROUTE_UNSUPPORTED' && openCodeCommand(inputs.argv) ? OPENCODE_NEXT_STEP : NEXT_STEP[error.code]
      return { verdict: 'REFUSED', code: error.code, message: error.message, next, steps, ...(error.detail === undefined ? {} : { detail: error.detail }) }
    }
    throw error
  }
}

/** Whether a refused command is an OpenCode one, so its next step names the OpenCode form. */
function openCodeCommand(argv) {
  if (!Array.isArray(argv)) return false
  const index = argv.length > 0 && basename(argv[0]) === 'env' ? argv.findIndex((argument, position) => position > 0 && argument !== '-i' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) : 0
  return index >= 0 && typeof argv[index] === 'string' && harnessOf(argv[index]) === 'opencode'
}

function emptyMcpConfig(text) {
  try {
    const servers = JSON.parse(text)?.mcpServers
    return isObject(servers) && Object.keys(servers).length === 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// Research runs (60.3 AC11)

export const RESEARCH_TOOLS = 'WebSearch,WebFetch'
/** What a research run's `env -i` may carry: where the app lives, how to find it, its destination and the agent's context limit. */
const RESEARCH_ENVIRONMENT = {
  claude: ['HOME', 'PATH', 'ANTHROPIC_BASE_URL', CLAUDE_CONTEXT_KEY], codex: ['HOME', 'PATH', 'CODEX_HOME'],
  // OpenCode's are BMN's folder and switches, each with its one value, which the route reader holds the run to.
  opencode: ['PATH', ...Object.keys(openCodeEnvironment('/'))]
}
/**
 * The `-c` items every Codex research run carries: no MCP server, live web search, none of the
 * tools that run a command, start another agent or reach a connected app, and none of the texts
 * Codex adds by itself (skills, connected apps, how to work with other agents, the machine and
 * folder it runs in, a project's rules file). Codex has no list of allowed tools, so its research
 * form is these switches, the features below switched off by name, a read-only sandbox and a Codex
 * folder of the run's own: no setting keeps Codex from sending the rules file of the folder it is
 * signed in from (63.3, the fence test of 2026-10-11).
 */
export const CODEX_RESEARCH_CONFIG = ['mcp_servers={}', 'web_search="live"', 'features.shell_tool=false', 'features.unified_exec=false',
  'features.multi_agent=false', 'features.apps=false', 'features.plugins=false', 'skills.include_instructions=false', 'skills.bundled.enabled=false',
  'include_apps_instructions=false', 'include_collaboration_mode_instructions=false', 'include_environment_context=false', 'project_doc_max_bytes=0']
/** The features a Codex research run switches off by name: reading a picture, goals, drawing, sleeping and hooks. */
/** The settings a research command names for itself beside the fixed ones: the agent's effort and its context limit. */
const CODEX_RESEARCH_OWN_KEYS = ['model_reasoning_effort', 'model_context_window', 'model_auto_compact_token_limit']
export const CODEX_RESEARCH_DISABLED = ['view_image', 'goals', 'image_generation', 'sleep_tool', 'hooks']
/** The file a Codex research run writes its answer to, beside the prompt and outside the empty folder. */
export const CODEX_RESEARCH_ANSWER = 'answer.md'
/** The Codex folder of one research run, inside the run's own folder, and the one thing in it: a link to the owner's sign-in file. */
export const CODEX_RESEARCH_HOME = 'codex'
export const CODEX_SIGN_IN = 'auth.json'
/**
 * The tools Codex keeps offering under the research form, each looked at on Codex 0.162.1
 * (2026-10-11) with the fence test: none reads or writes a file of the owner's. `exec` runs a
 * script that reaches only the `exec:` tools below it (a patch is refused by the read-only sandbox,
 * the MCP listings have no server, `web__run` asks the provider's own search service); `wait`
 * waits for such a script; the two `request_user_input` tools ask a question no one answers in a
 * run without a person; the `collaboration` tools find no other agent, and starting one fails in a
 * run that keeps no session. A tool that is not here fails the fence test, so the offer of a Codex
 * version that adds one stays closed until that tool is looked at and added here.
 */
export const CODEX_RESEARCH_TOOLS_SEEN = ['custom:functions.exec', 'exec:apply_patch', 'exec:clock__curr_time', 'exec:list_mcp_resource_templates',
  'exec:list_mcp_resources', 'exec:read_mcp_resource', 'exec:web__run', 'function:collaboration.followup_task', 'function:collaboration.interrupt_agent',
  'function:collaboration.list_agents', 'function:collaboration.send_message', 'function:collaboration.spawn_agent', 'function:collaboration.wait_agent',
  'function:functions.request_user_input', 'function:functions.request_user_input_async', 'function:functions.wait']

/**
 * The tools OpenCode offers a research run, looked at on OpenCode 2.0.29 (2026-10-14): only its web
 * search, which sends the search text to the search service its folder names. A tool that is not
 * here fails the fence test (70.3), as for Codex.
 */
export const OPENCODE_RESEARCH_TOOLS_SEEN = ['function:websearch']
const RESEARCH_TOOLS_SEEN = { codex: CODEX_RESEARCH_TOOLS_SEEN, opencode: OPENCODE_RESEARCH_TOOLS_SEEN }

/** Names the research form of an app as it is built now: a fence test counts only for the form it tested. */
export function researchFormHash(harness) {
  if (harness === 'opencode') return sha256(canonicalJson({ environment: RESEARCH_ENVIRONMENT.opencode, agent: OPENCODE_RESEARCH_AGENT, folder: OPENCODE_FOLDER_SHA256, titled: true })).slice(0, 16)
  return sha256(canonicalJson(harness === 'codex'
    ? { environment: RESEARCH_ENVIRONMENT.codex, config: CODEX_RESEARCH_CONFIG, disabled: CODEX_RESEARCH_DISABLED, sandbox: 'read-only', strict: true }
    : { environment: RESEARCH_ENVIRONMENT[harness] ?? [], tools: RESEARCH_TOOLS })).slice(0, 16)
}

export function researchRunsDirectory() {
  return `${stateDirectory()}/research/runs`
}

/** The owner's own Codex sign-in file as a research run links to it. BMN names it and never reads it. */
export function codexSignInFile(environment = process.env) {
  return `${environment.HOME ?? ''}/.codex/${CODEX_SIGN_IN}`
}

/** Removes the Codex folder of every research run: the one a run just ended with, and any a crash left behind. */
export function removeResearchCodexFolders(only = null) {
  let names
  try {
    names = only === null ? readdirSync(researchRunsDirectory()) : [basename(only.folder)]
  } catch {
    return
  }
  // A link is removed as a link; what it points at is never touched.
  for (const name of names) rmSync(`${researchRunsDirectory()}/${name}/${CODEX_RESEARCH_HOME}`, { recursive: true, force: true })
}

/**
 * The folder BMN makes for one research run: the prompt it wrote, its hash, and an empty folder
 * the app runs in. The check passes a research dispatch only from here with exactly this prompt.
 * For Codex (`harness`) it also holds the run's own Codex folder with one link in it, to the
 * owner's sign-in file. A Codex folder an earlier run left behind is removed first, whatever app this run uses.
 */
export function prepareResearchRun(prompt, { now = new Date(), id = `${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${sha256(`${prompt}\n${process.pid}\n${now.getTime()}`).slice(0, 8)}`, harness = undefined, environment = process.env } = {}) {
  const folder = `${researchRunsDirectory()}/${id}`
  // One research runs at a time, so a Codex folder that is still there was left by a run that never ended.
  removeResearchCodexFolders()
  ensurePrivateDirectory(`${folder}/cwd`)
  writeState(`${folder}/prompt.md`, prompt)
  writeState(`${folder}/run.json`, `${JSON.stringify({ version: 1, id, prompt_sha256: sha256(prompt), created_at: now.toISOString() })}\n`)
  const run = { id, folder, prompt: `${folder}/prompt.md`, cwd: `${folder}/cwd` }
  // An OpenCode run starts from BMN's own OpenCode folder, put in order here as `roster role` does.
  if (harness === 'opencode') installOpenCodeFolder()
  if (harness !== 'codex') return run
  ensurePrivateDirectory(`${folder}/${CODEX_RESEARCH_HOME}`)
  symlinkSync(codexSignInFile(environment), `${folder}/${CODEX_RESEARCH_HOME}/${CODEX_SIGN_IN}`)
  return { ...run, codex: `${folder}/${CODEX_RESEARCH_HOME}` }
}

/**
 * Why a run's Codex folder is not the one BMN makes, or null: a real folder that holds one thing,
 * a link to the owner's sign-in file. Only names are read; the sign-in file never is.
 */
function codexFolderProblem(folder, signIn) {
  const only = `a Codex research run's own Codex folder holds only a link to the owner's sign-in file (${signIn})`
  let names
  try {
    if (!lstatSync(folder).isDirectory()) return only
    names = listDirectory(folder).map((entry) => entry.name)
  } catch {
    return `${only}, and ${folder} is not there`
  }
  if (names.length !== 1 || names[0] !== CODEX_SIGN_IN) return `${only}; ${folder} holds ${names.length === 0 ? 'nothing' : names.join(', ')}`
  try {
    const link = `${folder}/${CODEX_SIGN_IN}`
    if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== signIn) return `${only}; ${link} is not that link`
  } catch {
    return only
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// The fence test's record (63.3)

export function fenceTestsPath() {
  return `${stateDirectory()}/fence-tests.jsonl`
}

/** Every recorded fence test, oldest first; a line BMN cannot read is skipped, never guessed. */
export function fenceTests() {
  let text
  try {
    text = readText(fenceTestsPath())
  } catch {
    return []
  }
  const entries = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const entry = JSON.parse(line)
      if (isObject(entry) && isString(entry.harness) && Array.isArray(entry.models)) entries.push(entry)
    } catch {
      // A torn line proves nothing.
    }
  }
  return entries
}

/**
 * How an app version stands for research with one model: `passed` only where the latest fence test
 * of exactly this version and of the research form as it is built now passed for that model, named
 * no tool BMN has not looked at, and no later comparison under the provider's own model list
 * found another tool list. `why` is `untested`, `failed` or `live` otherwise; `tools` is what the
 * test saw offered. `live` is the last comparison under the provider's model list, or null.
 */
export function fenceStanding(harness, version, model, tests = fenceTests()) {
  const form = researchFormHash(harness)
  const last = (catalog) => {
    let found = null
    for (const entry of tests) {
      if (entry.harness !== harness || entry.version !== version || entry.form !== form || (entry.catalog ?? 'bundled') !== catalog) continue
      // A comparison that showed nothing neither opens nor closes anything.
      if (catalog === 'live' && entry.verdict !== 'pass' && entry.verdict !== 'fail') continue
      const one = entry.models.find((candidate) => isObject(candidate) && candidate.model === model)
      if (one !== undefined) found = { entry, model: one }
    }
    return found
  }
  if (typeof version !== 'string') return { passed: false, why: 'untested', tools: [], live: null }
  const test = last('bundled')
  if (test === null) return { passed: false, why: 'untested', tools: [], live: null }
  const tools = Array.isArray(test.model.tools) ? test.model.tools.filter(isString) : []
  const unseen = tools.filter((tool) => !(RESEARCH_TOOLS_SEEN[harness] ?? []).includes(tool))
  if (test.entry.verdict !== 'pass' || test.model.verdict !== 'pass' || unseen.length > 0) {
    const reasons = [...(Array.isArray(test.model.reasons) ? test.model.reasons : []), ...(Array.isArray(test.entry.reasons) ? test.entry.reasons : []), ...unseen.map((tool) => `a tool BMN has not looked at: ${tool}`)]
    return { passed: false, why: 'failed', tools, live: null, at: test.entry.at, reasons: reasons.filter(isString) }
  }
  const compared = last('live')
  const live = compared === null ? null : { at: compared.entry.at, same: compared.entry.verdict === 'pass' && compared.model.verdict === 'pass', entry: compared.model.catalog_entry ?? null }
  if (live !== null && !live.same) {
    return { passed: false, why: 'live', tools, live, at: test.entry.at, reasons: (Array.isArray(compared.model.reasons) ? compared.model.reasons : []).filter(isString) }
  }
  return { passed: true, tools, live, at: test.entry.at }
}

/** Why `argv` is not exactly the research form, or null when it is. */
export function researchFormProblem(parsed) {
  if (parsed.envMode !== 'clean') return 'a research run needs env -i'
  const carried = RESEARCH_ENVIRONMENT[parsed.harness]
  const extra = Object.keys(parsed.assignments).filter((key) => !carried.includes(key))
  if (extra.length > 0) return `a research run's env -i carries only ${carried.join(', ')}, not ${extra.join(', ')}`
  if (parsed.harness === 'codex') {
    if (parsed.resume !== null) return 'a research run never resumes a session'
    if (parsed.sandbox !== 'read-only') return 'a research run needs --sandbox read-only'
    if (!parsed.skipGit || !parsed.ephemeral) return 'a research run needs --skip-git-repo-check and --ephemeral'
    if (parsed.json || parsed.cd !== undefined || parsed.profile !== undefined) return 'a research run takes no --json, --cd or --profile'
    if (parsed.output === undefined) return 'a research run writes its answer with -o'
    const fixed = parsed.config.filter((entry) => CODEX_RESEARCH_CONFIG.includes(entry))
    if (fixed.length !== CODEX_RESEARCH_CONFIG.length || new Set(fixed).size !== fixed.length) {
      return `a research run carries exactly ${CODEX_RESEARCH_CONFIG.map((entry) => `-c ${entry}`).join(' ')}`
    }
    // Beside the fixed settings a research command names its effort and, where the agent has one, its context limit: nothing else, each once.
    const own = parsed.config.filter((entry) => !CODEX_RESEARCH_CONFIG.includes(entry)).map((entry) => entry.split('=')[0])
    const stray = own.find((key) => !CODEX_RESEARCH_OWN_KEYS.includes(key))
    if (stray !== undefined) return `a research run carries no setting beside its fixed ones, its effort and its context limit, not -c ${stray}`
    if (new Set(own).size !== own.length) return 'a research run names its effort and its context limit once each'
    if (parsed.strictConfig !== true) return 'a research run needs --strict-config, so that a setting Codex does not know stops the run'
    if (parsed.disable.length !== CODEX_RESEARCH_DISABLED.length || !CODEX_RESEARCH_DISABLED.every((feature) => parsed.disable.includes(feature))) {
      return `a research run carries exactly ${CODEX_RESEARCH_DISABLED.map((feature) => `--disable ${feature}`).join(' ')}`
    }
    const home = parsed.assignments.CODEX_HOME
    if (home === undefined || !isAbsolute(home) || home.split('/').includes('..') || basename(home) !== CODEX_RESEARCH_HOME) {
      return 'a research run names the Codex folder BMN made for it (CODEX_HOME), so that Codex reads nothing from the owner\'s own'
    }
    return null
  }
  if (parsed.harness === 'opencode') {
    // BMN's folder and switches with their one value each; the parser holds --standalone, --format json and no prompt on the line.
    const off = Object.entries(openCodeEnvironment()).find(([name, value]) => parsed.assignments[name] !== value)
    if (off !== undefined) return `a research run carries ${off[0]}=${off[1]}, BMN's own folder and switches for OpenCode runs`
    if (parsed.agent !== OPENCODE_RESEARCH_AGENT) return `a research run runs BMN's research agent (--agent ${OPENCODE_RESEARCH_AGENT})`
    if (parsed.title === undefined) return 'a research run names its title (--title), so OpenCode makes no request of its own to name the session'
    return null
  }
  if (!parsed.safeMode) return 'a research run needs --safe-mode'
  if (parsed.tools !== RESEARCH_TOOLS) return `a research run needs --tools '${RESEARCH_TOOLS}'`
  if (!parsed.strictMcp || parsed.mcpConfig === undefined || !emptyMcpConfig(parsed.mcpConfig)) return 'a research run needs --strict-mcp-config and an empty --mcp-config'
  if (!parsed.noPersistence) return 'a research run needs --no-session-persistence'
  if (parsed.outputFormat !== 'json') return 'a research run needs --output-format json'
  if (parsed.settings !== undefined || parsed.addDir.length > 0 || parsed.appendSystemPrompt !== undefined || parsed.permissionMode !== undefined) {
    return 'a research run takes no --settings, --add-dir, --append-system-prompt or --permission-mode'
  }
  return null
}

/**
 * Evaluates a research run: an approved, active agent the team names a researcher, on a known
 * destination and a tested or accepted app version, the exact fenced argv, run from the empty
 * folder BMN made, fed the prompt BMN wrote. A Codex run passes only on a version whose fence test
 * is on record as passed (`fenceTestLog`, read from the record by default); a public-only
 * destination passes only on an app version whose fence was verified.
 * `inputs.dry` asks only whether this agent could research with this argv: everything but the
 * folder and the prompt, and no receipt. `inputs.settled` is a receipt checked again after its run,
 * whose Codex folder is gone by then.
 */
export function evaluateResearch(inputs, {
  environment = process.env, cwd: processCwd = process.cwd(), now = new Date(),
  testedVersions = TESTED_HARNESS_VERSIONS, fenceVersions = RESEARCH_FENCE_VERSIONS, contextTestLog = undefined, fenceTestLog = undefined
} = {}) {
  const steps = []
  const note = (text) => steps.push(text)
  try {
    // A missing or invalid team file stops here (R60-NFR1); a valid one that differs from the approved version is a pending edit.
    const file = readValidRoster()
    const generation = readApproved()
    const data = generation.data
    note(`approved version ${generation.number}`)
    const agent = activeAgent(generation, inputs.agent)
    note(`agent ${agent.id}: ${agent.class}, ${agent.harness} ${agent.model}, provider ${agent.provider}`)
    // Who researches is part of the approved team (63.3). A team that names no one is one from before the mark.
    const named = namedResearchers(data)
    if (named !== null && !named.includes(agent.id)) {
      refuse('NOT_A_RESEARCHER', `${agent.id} is not one of the team's researchers (${named.length === 0 ? 'the team names none' : named.join(', ')})`)
    }
    const parsed = parseDispatch(inputs.argv, { research: true })
    if (parsed.unsupported) refuse('ROUTE_UNSUPPORTED', parsed.unsupported)
    if (agent.harness !== parsed.harness) refuse('ROUTE_UNSUPPORTED', `${agent.id} runs on ${agent.harness}, the command is ${parsed.harness}`)
    const form = researchFormProblem(parsed)
    if (form !== null) refuse('ROUTE_UNSUPPORTED', form)
    // A dry question may name a folder that is not there yet, shaped like a run's own: it is read as named.
    const cwd = canonicalDirectory(inputs.cwd ?? processCwd, processCwd)
      ?? (inputs.dry === true && typeof inputs.cwd === 'string' && isAbsolute(inputs.cwd) && !inputs.cwd.split('/').includes('..') ? inputs.cwd : null)
    // The fixed research switches are not part of where Codex sends data; the route reader sees the rest.
    const resolution = parsed.harness === 'codex'
      ? resolveCodexRoute({ ...parsed, config: parsed.config.filter((entry) => !CODEX_RESEARCH_CONFIG.includes(entry)) }, environment, cwd ?? processCwd)
      : parsed.harness === 'opencode' ? resolveOpenCodeRoute(parsed, { agent: OPENCODE_RESEARCH_AGENT, folder: inputs.dry !== true }) : resolveClaudeRoute(parsed, environment, cwd ?? processCwd)
    if (resolution.unsupported) refuse('ROUTE_UNSUPPORTED', resolution.unsupported)
    const versionEnvironment = dispatchEnvironment(parsed, environment)
    // Like appVersion and the fence test, query the executable with bare HOME/PATH. Native Codex
    // creates startup aliases even for --version; probing in the run's auth-only folder dirties it.
    // The research command retains its own CODEX_HOME and every folder/form restriction below.
    if (parsed.harness === 'codex') delete versionEnvironment.CODEX_HOME
    const version = harnessVersion(parsed.command, versionEnvironment)
    note(parsed.harness === 'codex' ? 'dispatch form: env -i codex exec from a Codex folder of its own, read-only, web search, no command or app tools'
      : parsed.harness === 'opencode' ? 'dispatch form: env -i opencode run from BMN\'s OpenCode folder, its research agent, web search only' : 'dispatch form: env -i claude -p, web tools only')
    // An OpenCode agent's model is named with its provider, as `-m` names it.
    const { model, effort } = checkModelAndEffort(parsed.harness === 'opencode' && !agent.model.includes('/') ? { ...agent, model: `${agent.provider}/${agent.model}` } : agent, resolution, note)
    const context = checkContext(agent, resolution.context, agent.context_limit === undefined ? { limit: false, compact: false } : provenControls(parsed.harness, version, contextTestLog),
      agent.context_limit === undefined ? [] : provenPrecedence(parsed.harness, version, contextTestLog))
    if (context.refusal) refuse('CONTEXT_MISMATCH', context.refusal, context.why)
    note(context.note)
    const route = resolution.route
    const destination = matchedDestination(data, agent, parsed.harness, route, note)

    // The run's Codex folder lies beside the empty folder it starts in; a dry question names both as they will be.
    if (parsed.harness === 'codex' && cwd !== null && parsed.assignments.CODEX_HOME !== `${dirname(cwd)}/${CODEX_RESEARCH_HOME}` && (inputs.dry !== true || basename(cwd) === 'cwd')) {
      refuse('WORKSPACE_MISMATCH', `a Codex research run uses the Codex folder BMN made for it, ${dirname(cwd)}/${CODEX_RESEARCH_HOME}`)
    }
    let stdin = null
    if (inputs.dry !== true) {
      const runs = canonicalDirectory(researchRunsDirectory(), processCwd)
      const run = cwd === null ? null : dirname(cwd)
      if (cwd === null || runs === null || dirname(run) !== runs || basename(cwd) !== 'cwd') {
        refuse('WORKSPACE_MISMATCH', 'a research run starts in the empty folder BMN made for it')
      }
      if (listDirectory(cwd).length > 0) refuse('WORKSPACE_MISMATCH', `${cwd} is not empty`)
      let record = null
      try {
        record = JSON.parse(readText(`${run}/run.json`))
      } catch {
        record = null
      }
      try {
        const path = realpathSync(isAbsolute(inputs.stdin) ? inputs.stdin : `${cwd}/${inputs.stdin}`)
        stdin = { path, sha256: hashFile(path) }
      } catch {
        stdin = null
      }
      if (!isObject(record) || stdin === null || stdin.path !== `${run}/prompt.md` || stdin.sha256 !== record.prompt_sha256) {
        refuse('WORKSPACE_MISMATCH', '--stdin must be the research prompt BMN wrote for this run, unchanged')
      }
      if (parsed.harness === 'codex' && (isAbsolute(parsed.output) ? parsed.output : `${cwd}/${parsed.output}`) !== `${run}/${CODEX_RESEARCH_ANSWER}`) {
        refuse('WORKSPACE_MISMATCH', `a research run writes its answer to ${CODEX_RESEARCH_ANSWER} beside BMN's prompt`)
      }
      if (parsed.harness === 'codex' && inputs.settled !== true) {
        const problem = codexFolderProblem(`${run}/${CODEX_RESEARCH_HOME}`, codexSignInFile(parsed.assignments))
        if (problem !== null) refuse('WORKSPACE_MISMATCH', problem)
      }
      note(`research run ${basename(run)}: BMN's prompt, an empty folder`)
    }

    if (version === null) {
      refuse('HARNESS_UNKNOWN', `${parsed.harness}: BMN cannot read this app's version, so it cannot tell which program would run`)
    }
    const tested = versionStanding(parsed.harness, version, testedVersions)
    note(`${parsed.harness} ${version}: ${tested.state}`)
    const answer = privateWorkAnswer(data, destination, null)
    note(`private work: ${answer.reason}`)
    // Claude Code's research form is the one 60.10 names; Codex researches only on a version whose fence the owner's
    // test showed, for this model and for the form as it is built now (63.3). That its provider may see private work
    // is another question: research must send only what BMN wrote, and only that test shows it.
    const standing = parsed.harness === 'claude' ? null : fenceStanding(parsed.harness, version, model.value, fenceTestLog)
    const fenced = standing === null ? (fenceVersions[parsed.harness] ?? []).includes(version) : standing.passed
    if (standing !== null) note(`fence test of ${parsed.harness} ${version} with ${model.value}: ${standing.passed ? `passed${standing.live === null && parsed.harness === 'codex' ? ', not yet compared under the provider\'s own model list' : ''}` : standing.why}`)
    if (parsed.harness !== 'claude' && !fenced) {
      const app = APP_NAMES[parsed.harness]
      const reason = standing?.reasons?.[0]
      if (standing?.why === 'failed') refuse('ROUTE_UNSUPPORTED', `the fence test of ${parsed.harness} ${version} with ${model.value} did not pass${reason === undefined ? '' : ` (${reason})`}, so no research runs there: pick another researcher`, 'fence-failed')
      if (standing?.why === 'live') refuse('ROUTE_UNSUPPORTED', `under the provider's own model list ${app} ${version} offers ${model.value} other tools than the fence test saw${reason === undefined ? '' : ` (${reason})`}, so no research runs there until that is looked at`, 'fence-live')
      refuse('ROUTE_UNSUPPORTED', `research runs in ${app} only on a version whose fence test passed, and none is on record for ${parsed.harness} ${version} with ${model.value}: the owner runs \`bmn roster fence\`, or picks a researcher on Claude Code`, 'fence-untested')
    }
    if (!answer.allowed && !fenced) {
      refuse('PACKET_INVALID', `a public-only researcher runs only on an app version whose fence BMN verified; ${parsed.harness} ${version} is not one`)
    }
    if (inputs.dry === true) return { verdict: 'PASS', dry: true, version, steps, ...(standing === null ? {} : { fence: { tools: standing.tools, compared: standing.live !== null } }) }
    const body = {
      version: 1, mode: 'research', verdict: 'PASS', agent: agent.id, class: agent.class, harness: parsed.harness, model: model.value,
      effort: effort.value, context_limit_applied: context.applied,
      ...(agent.context_limit !== undefined && context.applied === null ? { context_limit_note: context.note } : {}),
      cwd,
      argv_sha256: sha256(canonicalJson(inputs.argv)),
      harness_version: { version, state: tested.state },
      ...(standing === null ? {} : { fence: { form: researchFormHash(parsed.harness), tested_at: standing.at, tools: standing.tools } }),
      route: receiptRoute(destination, route),
      private_work: receiptAnswer(answer),
      generation: { number: generation.number, hash: generation.hash },
      roster_file_hash: file.hash,
      stdin,
      issued_at: now.toISOString()
    }
    return { verdict: 'PASS', receipt: { ...body, receipt_hash: receiptHash(body) }, steps }
  } catch (error) {
    if (error instanceof Refusal) {
      return { verdict: 'REFUSED', code: error.code, message: error.message, next: error.code === 'WORKSPACE_MISMATCH' ? 'start the research from BMN (Team, Models), which writes the prompt and the folder' : NEXT_STEP[error.code], steps, ...(error.detail === undefined ? {} : { detail: error.detail }) }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------------------------
// A teammate's ask (Epic 72)

/** Where BMN keeps one folder per ask: its inputs and record. */
export function teamRunsDirectory() {
  return `${stateDirectory()}/team/runs`
}

/** BMN's git, the one a form that reads history runs first on its PATH (72.1 AC1). */
const ASK_GIT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ask-git.sh')

/**
 * Whether each input of an ask may go to this destination (R72-NFR5, NFR6), decided before anything
 * leaves. A private ask: the destination's private-work answer, a folder exception counting only for
 * an input inside its canonical root; an input whose root BMN cannot establish needs the provider's
 * own permission. A public ask: the asker's declaration, verified: a question carries no project
 * read; a file or picture is byte-identical to a file of the verified public commit of its project.
 * A project is never public: a teammate that works in one reads with its app's own tools, beyond
 * what the asker hands over (72.9). Returns each input with its basis.
 */
export function askConsent(data, destination, inputs, label, now = new Date(), note = () => {}) {
  const decided = []
  for (const input of inputs) {
    if (label === 'private') {
      const answer = privateWorkAnswer(data, destination, input.root ?? null)
      if (!answer.allowed) refuse('PRIVATE_NOT_ALLOWED', `${input.label} is private work and ${answer.reason}${input.root === null || input.root === undefined ? ' (BMN cannot tell which folder it comes from, so no folder exception covers it)' : ''}`)
      decided.push({ kind: input.kind, label: input.label, root: input.root ?? null, basis: answer.exception ? `exception ${answer.exception.id}` : 'the provider may see private work' })
      continue
    }
    if (input.kind === 'question') {
      decided.push({ kind: 'question', label: input.label, root: input.root ?? null, basis: 'declared public by the asker' })
      continue
    }
    if (input.kind === 'project' || input.kind === 'mode' || input.kind === 'browser') refuse('PUBLIC_NOT_VERIFIED', `${input.label} is read with the app's own tools, beyond what you hand over, so the ask is private`)
    if (input.root === null || input.root === undefined) refuse('PUBLIC_NOT_VERIFIED', `${input.label} is in no project BMN knows to be public`)
    const visibility = workspaceVisibility(input.root, now)
    if (!visibility.public) refuse('PUBLIC_NOT_VERIFIED', `${input.label} is in ${input.root}, which is not proven public (${visibility.reason}); run bmn roster visibility --refresh`)
    const commit = visibility.record.commit
    const blob = committedBlob(input.root, commit, input.relative)
    if (blob === null || sha256(blob) !== input.sha256) refuse('PUBLIC_NOT_VERIFIED', `${input.label} is not byte-identical to ${input.relative} in commit ${commit.slice(0, 12)}, the one GitHub serves for ${visibility.record.origin}`)
    decided.push({ kind: input.kind, label: input.label, root: input.root, basis: `byte-identical to ${input.relative} in the public commit ${commit.slice(0, 12)}` })
  }
  note(`data ${label}: ${decided.map((entry) => `${entry.label} (${entry.basis})`).join('; ')}`)
  return decided
}

/**
 * What one ask's command is built from: its form, the agent's model, the chosen effort, the folder it
 * works in, the pictures' paths, the owner's rules where the form carries them, and the agent's context
 * limit where the owner's test proved its setting on this app version (60.9), as `evaluate` applies it.
 */
export function askRequest(agent, version, { form, effort, cwd, folder, rules = null, pictures = [], browser = null, environment = process.env, contextTestLog = undefined }) {
  const proven = agent.context_limit === undefined ? { limit: false, compact: false } : provenControls(agent.harness, version, contextTestLog)
  const items = contextItems(agent, proven)
  return { form, model: agent.model, provider: agent.provider, effort, cwd, folder, rules, pictures, browser, environment, context: items.state === 'applied' ? { argv: items.argv, env: items.env } : { argv: [], env: [] } }
}

/**
 * What a form's own mode reads beyond the asker's text, as an input whose consent is decided like
 * any other (R72-NFR6): a mode that reads the whole computer needs the provider's own permission, one
 * kept in its working folder that folder's, and one that reads only the asker's text nothing more.
 */
export function modeInput(form, appWords, project) {
  const reads = ASK_READS[form]
  if (reads.scope === 'computer') return { kind: 'mode', label: `what ${appWords}'s read-only mode can read (${reads.reach})`, root: null }
  if (reads.scope === 'folder' && project !== null) return { kind: 'mode', label: `what ${appWords}'s read-only mode can read (the project ${project})`, root: project }
  return null
}

/**
 * The destination an agent's ask reaches when the check passes it: its approved host, or the app's
 * approved default. Used to decide consent before anything is copied (R72-NFR6); the check itself
 * then reads the run's real destination and refuses any other.
 */
export function expectedDestination(data, agent) {
  if (agent.host !== 'default') return { provider: agent.provider, basis: 'explicit' }
  const approved = data.harness_routes.find((entry) => entry.harness === agent.harness)
  return approved === undefined ? { provider: agent.provider, basis: 'owner-declared' } : { provider: approved.provider, basis: approved.basis }
}

/**
 * Evaluates one teammate's ask (R72-NFR1): the same approved team, agent, role, destination,
 * private-work and context answers as `evaluate`, judged for the command BMN built for the ask: the
 * app's own read-only form (72.9), recomputed here from the run's folder and compared whole, so the
 * receipt is for exactly what will start. Consent covers what the form's mode can read, not only the
 * inputs named (R72-NFR6). `inputs`: `{ agent, role, effort, data, run, argv, cwd }`, `run` the
 * folder BMN made for the ask. The existing entry points are not changed by it; a dispatch command is
 * not an ask and an ask's command is not a dispatch.
 */
export function evaluateAsk(inputs, { environment = process.env, now = new Date(), testedVersions = TESTED_HARNESS_VERSIONS, contextTestLog = undefined, program: givenProgram = undefined, version: givenVersion = undefined } = {}) {
  const steps = []
  const note = (text) => steps.push(text)
  try {
    const file = readValidRoster()
    const generation = readApproved()
    const data = generation.data
    note(`approved version ${generation.number}`)
    const agent = activeAgent(generation, inputs.agent)
    note(`agent ${agent.id}: ${agent.class}, ${agent.harness} ${agent.model}, provider ${agent.provider}`)
    const role = data.roles.find((candidate) => candidate.id === inputs.role)
    if (role === undefined) refuse('ROLE_UNKNOWN', `no role ${inputs.role} in the approved ## roles`)
    if (!agent.roles.includes(role.id)) refuse('ROLE_INELIGIBLE', `${agent.id} does not hold role ${role.id}`)
    const classRule = classRefusal(agent.class, role.id)
    if (classRule !== null) refuse(classRule.code, `${agent.id} is a ${agent.class}; ${classRule.rule}`)
    note(`role ${role.id}: held`)
    if (!ASK_APPS.includes(agent.harness)) refuse('ACCESS_UNAVAILABLE', `${appName(agent.harness)} teammates are not asked through BMN yet`)

    // The run's own folder, as BMN made it, and the inputs it holds.
    const runs = canonicalDirectory(teamRunsDirectory(), '/')
    const folder = typeof inputs.run === 'string' ? canonicalDirectory(inputs.run, '/') : null
    if (folder === null || runs === null || dirname(folder) !== runs) refuse('WORKSPACE_MISMATCH', 'an ask runs from the folder BMN made for it')
    let manifest
    try {
      manifest = JSON.parse(readText(`${folder}/${ASK_RUN_FILES.manifest}`))
    } catch {
      manifest = null
    }
    if (!isObject(manifest) || manifest.version !== 2 || typeof manifest.form !== 'string' || !Object.hasOwn(ASK_READS, manifest.form) || !Array.isArray(manifest.inputs) || !Array.isArray(manifest.pictures)) {
      refuse('WORKSPACE_MISMATCH', `${folder} holds no intact ask manifest`)
    }
    const project = typeof manifest.project?.root === 'string' ? manifest.project.root : null
    const label = inputs.data === 'public' ? 'public' : 'private'
    if (manifest.data !== label) refuse('WORKSPACE_MISMATCH', `the ask's manifest is for a ${manifest.data} ask, not a ${label} one`)
    const prompt = `${folder}/${ASK_RUN_FILES.prompt}`
    let promptHash = null
    try {
      promptHash = hashFile(prompt)
    } catch {
      promptHash = null
    }
    if (promptHash === null || promptHash !== manifest.prompt_sha256) refuse('WORKSPACE_MISMATCH', 'the prompt is not the one BMN wrote for this ask')
    // Each picture is the treated copy BMN made, in its own place under the run's inputs (72.8 AC2).
    for (const picture of manifest.pictures) {
      let hash = null
      try {
        if (!isObject(picture) || typeof picture.copy !== 'string' || !/^pictures\/\d+\.(png|jpg|webp)$/u.test(picture.copy)) throw new Error('not a picture place')
        hash = hashFile(`${folder}/${ASK_RUN_FILES.inputs}/${picture.copy}`)
      } catch {
        hash = null
      }
      if (hash === null || hash !== picture.sha256) refuse('WORKSPACE_MISMATCH', `the picture ${picture.label} is not the copy BMN made for this ask`)
    }

    // The app as installed: its version is recorded and shown, never a gate (R72-NFR10).
    const program = givenProgram ?? askProgram(agent.harness, environment)
    if (program === null) refuse('HARNESS_UNKNOWN', `${appName(agent.harness)} is not on PATH (BMN's own folder left out), so BMN cannot tell which program would run`)
    const version = givenVersion !== undefined ? givenVersion : harnessVersion(program.launcher, { PATH: appSearchPath(environment), HOME: environment.HOME ?? '' })
    if (version === null) refuse('HARNESS_UNKNOWN', `${agent.harness}: BMN cannot read this app's version, so it cannot tell which program would run`)
    const tested = versionStanding(agent.harness, version, testedVersions)
    const checked = ASK_FORMS_CHECKED[agent.harness]
    note(`${agent.harness} ${version}: ${tested.state}; its ask form was last checked on ${checked.version} (${checked.on})`)
    if (manifest.pictures.length > 0 && ASK_UNSUPPORTED[agent.harness]?.pictures !== undefined) refuse('ACCESS_UNAVAILABLE', ASK_UNSUPPORTED[agent.harness].pictures)
    // A browser ask (74.3): the asker's loopback origin, stated disposable, on an app that takes the browser's server.
    const browser = manifest.browser ?? null
    if (browser !== null) {
      if (ASK_UNSUPPORTED[agent.harness]?.browser !== undefined) refuse('ACCESS_UNAVAILABLE', ASK_UNSUPPORTED[agent.harness].browser)
      if (browserOrigin(browser.origin).origin !== browser.origin || typeof browser.interact !== 'boolean') refuse('WORKSPACE_MISMATCH', 'the ask\'s browser is not a loopback origin BMN wrote')
      if (browser.statement !== BROWSER_STATEMENT) refuse('WORKSPACE_MISMATCH', 'a browser ask needs the asker\'s statement that the app is a disposable test instance')
    }

    // The form: the app's one read-only form, OpenCode's asker where it may read nothing but the asker's text.
    const form = askFormName(agent.harness, { project, label, textOnly: publicOnlyReasons(agent, data).length > 0 })
    if (manifest.form !== form) refuse('WORKSPACE_MISMATCH', `the ask's manifest names the form ${manifest.form}, not ${form}`)
    // A public ask goes only through a form that reads nothing beyond the asker's text (R72-NFR5).
    if (label === 'public' && ASK_READS[form].scope !== 'text') refuse('PUBLIC_NOT_VERIFIED', `${agent.id} works with ${appName(agent.harness)}'s own tools, which read beyond what you hand over, so its asks are private (R72-NFR5)`)
    const cwd = project ?? `${folder}/${ASK_RUN_FILES.work}`
    if (inputs.cwd !== cwd) refuse('WORKSPACE_MISMATCH', `the ask runs in ${cwd}, not ${inputs.cwd}`)

    // The command BMN builds for this ask, recomputed; the one given must be it, whole.
    const proven = agent.context_limit === undefined ? { limit: false, compact: false } : provenControls(agent.harness, version, contextTestLog)
    let rules = null
    try {
      rules = readText(`${folder}/${ASK_RUN_FILES.rules}`)
    } catch (error) {
      if (error.code !== 'ENOENT') refuse('WORKSPACE_MISMATCH', 'the instruction snapshot of this ask cannot be read')
    }
    if (rules !== null && (agent.harness !== 'opencode' || label !== 'private')) refuse('WORKSPACE_MISMATCH', 'only a private OpenCode ask carries the owner\'s rules: Codex and Claude Code read their own')
    const request = askRequest(agent, version, { form, effort: inputs.effort, cwd, folder, rules, pictures: manifest.pictures.map((picture) => `${folder}/${ASK_RUN_FILES.inputs}/${picture.copy}`), browser: browser === null ? null : { origin: browser.origin, interact: browser.interact }, environment, contextTestLog })
    const built = askCommand(agent.harness, program, request)
    if (!Array.isArray(inputs.argv) || canonicalJson(inputs.argv) !== canonicalJson(built.argv)) {
      const at = Array.isArray(inputs.argv) ? built.argv.findIndex((value, index) => inputs.argv[index] !== value) : 0
      refuse('ROUTE_UNSUPPORTED', `the command is not the ask BMN builds for ${agent.id}${at === -1 ? ' (it carries more)' : ` (it differs at argument ${at})`}`)
    }
    note(`the command is BMN's ${form} form for ${appName(agent.harness)}, in ${cwd}`)
    if (browser !== null) note(`with the browser for ${browser.origin}${browser.interact ? ', looking and interacting' : ', looking only'}`)
    // Claude Code reads its pictures from one message on standard input: that message must be the pictures and the prompt, whole.
    let message = null
    if (built.stdin === 'stream-json') {
      let expected = null
      try {
        const pictures = manifest.pictures.map((picture) => ({ media_type: picture.media_type, bytes: readFileSync(`${folder}/${ASK_RUN_FILES.inputs}/${picture.copy}`) }))
        expected = sha256(claudePictureMessage(pictures, readText(prompt)))
        message = hashFile(`${folder}/${ASK_RUN_FILES.message}`)
      } catch {
        message = null
      }
      if (message === null || message !== expected) refuse('WORKSPACE_MISMATCH', 'the picture message on standard input is not the pictures and the prompt BMN wrote for this ask')
      note(`standard input: one message, ${manifest.pictures.length} picture(s) and the prompt`)
    }
    // The forms that read history run BMN's own git, first on their PATH: it must be BMN's, byte for byte.
    let git = null
    if (built.environment.PATH.startsWith(`${folder}/${ASK_RUN_FILES.bin}:`)) {
      try {
        git = hashFile(`${folder}/${ASK_RUN_FILES.bin}/git`)
      } catch {
        git = null
      }
      if (git === null || git !== hashFile(ASK_GIT_SCRIPT)) refuse('WORKSPACE_MISMATCH', 'the run\'s git is not BMN\'s own (bin/ask-git.sh)')
    }

    // The snapshots this check judges are the ones the start uses (72.3 AC1): the app's program as it is now, and the environment the command carries.
    const snapshots = `${folder}/${ASK_RUN_FILES.snapshots}`
    let identity = null
    let environmentSnapshot = null
    try {
      identity = JSON.parse(readText(`${snapshots}/executable.json`))
      environmentSnapshot = JSON.parse(readText(`${snapshots}/environment.json`))
    } catch {
      identity = null
    }
    if (!isObject(identity) || !isObject(identity.launcher) || !isObject(identity.payload) || !sameProgram(identity, program)) refuse('HARNESS_UNKNOWN', `${appName(agent.harness)}'s program is not the one BMN recorded for this ask`)
    if (!isObject(environmentSnapshot) || environmentSnapshot.sha256 !== sha256(JSON.stringify(built.environment))) refuse('WORKSPACE_MISMATCH', 'the environment of this ask is not the one BMN recorded')
    note(`snapshots: program ${identity.payload.sha256.slice(0, 12)}, environment ${environmentSnapshot.names.join(', ')}`)

    // Where it goes, read as `roster check` reads the same app's dispatch from the same folder: the same answers evaluate gives.
    const parsed = agent.harness === 'codex'
      ? { harness: 'codex', command: program.launcher, envMode: 'clean', assignments: built.environment, config: [...request.context.argv.filter((_, index) => index % 2 === 1), `model_reasoning_effort=${inputs.effort}`, 'mcp_servers={}', 'approval_policy="never"'], disable: [], model: agent.model, sandbox: 'read-only', resume: null, cd: cwd }
      : agent.harness === 'claude'
        ? { harness: 'claude', command: program.launcher, envMode: 'clean', assignments: built.environment, addDir: [], model: agent.model, effort: inputs.effort }
        // OpenCode's command read by the same parser as every OpenCode dispatch.
        : parseOpenCode(built.command.slice(1), { harness: 'opencode', command: program.launcher, envMode: 'clean', assignments: built.environment })
    if (parsed.unsupported) refuse('ROUTE_UNSUPPORTED', parsed.unsupported)
    const own = agent.harness === 'opencode' ? openCodeAskConfig(form === 'opencode-reader' ? 'reader' : 'asker', rules) : null
    const resolution = agent.harness === 'codex' ? resolveCodexRoute(parsed, {}, cwd)
      : agent.harness === 'claude' ? resolveClaudeRoute(parsed, {}, cwd)
        : resolveOpenCodeRoute(parsed, { agent: own.agent, folder: true, inline: own.content })
    if (resolution.unsupported) refuse('ROUTE_UNSUPPORTED', resolution.unsupported)
    // OpenCode names a model with its provider (`-m opencode-go/gpt-6-luna`), as research's check reads it.
    const { model, effort } = checkModelAndEffort(agent.harness === 'opencode' && !agent.model.includes('/') ? { ...agent, model: `${agent.provider}/${agent.model}` } : agent, resolution, note)
    checkRoleEffort(role, agent, effort, note)
    const context = checkContext(agent, resolution.context, proven, agent.context_limit === undefined ? [] : provenPrecedence(agent.harness, version, contextTestLog))
    if (context.refusal) refuse('CONTEXT_MISMATCH', context.refusal, context.why)
    note(context.note)
    const destination = matchedDestination(data, agent, agent.harness, resolution.route, note)

    // Consent covers the inputs named and what the form's own mode can read (R72-NFR6).
    const reading = modeInput(form, appName(agent.harness), project)
    const consent = askConsent(data, destination, [...manifest.inputs, ...(reading === null ? [] : [reading])], label, now, note)
    const answer = privateWorkAnswer(data, destination, null)
    note(`private work: ${answer.reason}`)

    const body = {
      version: 1, mode: 'ask', verdict: 'PASS', agent: agent.id, class: agent.class, harness: agent.harness, model: model.value,
      role: role.id, effort: effort.value, context_limit_applied: context.applied,
      ...(agent.context_limit !== undefined && context.applied === null ? { context_limit_note: context.note } : {}),
      form, reads: { scope: ASK_READS[form].scope, words: ASK_READS[form].words, folder: cwd }, project, cwd, ...(manifest.pictures.length > 0 ? { pictures: manifest.pictures.length } : {}),
      sandbox: agent.harness === 'codex' ? { mode: 'read-only', source: '--sandbox read-only', approval_policy: 'never', tools: 'Codex\'s own: shell, Git, web search, sub-agents' }
        : agent.harness === 'claude' ? { mode: 'read-only', source: '--permission-mode dontAsk --restricted', tools: ['Read', 'Grep', 'Glob', 'git log', 'git show', 'git diff', 'git blame', 'WebSearch', 'Agent'] }
          : { mode: 'read-only', source: '--agent', agent: own.agent, tools: form === 'opencode-reader' ? ['read', 'glob', 'grep', 'list', 'git log', 'git show', 'git diff', 'git blame', 'websearch', `subagent ${OPENCODE_ASK_AGENTS.subagent}`] : [] },
      run: basename(folder), data: label, consent,
      inputs_sha256: sha256(canonicalJson(manifest)),
      snapshots: {
        executable: { launcher: identity.launcher.sha256, payload: identity.payload.sha256 },
        environment: environmentSnapshot.sha256, rules: rules === null ? null : sha256(rules), prompt: promptHash, ...(message === null ? {} : { message }), ...(git === null ? {} : { git })
      },
      argv_sha256: sha256(canonicalJson(built.argv)),
      harness_version: { version, state: tested.state, form_checked_on: checked },
      route: receiptRoute(destination, resolution.route),
      private_work: receiptAnswer(answer),
      generation: { number: generation.number, hash: generation.hash },
      roster_file_hash: file.hash,
      issued_at: now.toISOString()
    }
    return { verdict: 'PASS', receipt: { ...body, receipt_hash: receiptHash(body) }, steps, argv: built.argv, form: built }
  } catch (error) {
    if (error instanceof Refusal) return { verdict: 'REFUSED', code: error.code, message: error.message, next: NEXT_STEP[error.code], steps, ...(error.detail === undefined ? {} : { detail: error.detail }) }
    throw error
  }
}

/** `--verify`: recomputes everything but `issued_at` from the receipt's stored inputs. */
export function verifyReceipt(path, argv, options = {}) {
  const receipt = readReceiptFile(path)
  if (receipt === null) return { ok: false, reason: `${path} is not an intact version-1 receipt` }
  let result
  try {
    result = evaluateReceipt(receipt, argv, options)
  } catch (error) {
    // Approved state that is missing or corrupt now means the receipt cannot be reproduced.
    if (error instanceof RosterError) return { ok: false, reason: `the receipt cannot be checked again: ${error.code}: ${error.message}` }
    throw error
  }
  if (result.verdict !== 'PASS') return { ok: false, reason: `the dispatch no longer passes: ${result.code}: ${result.message}` }
  return sameReceipt(receipt, result.receipt)
}

/** The receipt's dispatch, evaluated as of now: a public record that went stale since issuance no longer reproduces it. */
function evaluateReceipt(receipt, argv, options) {
  if (receipt.mode === 'research') return evaluateResearch({ agent: receipt.agent, cwd: receipt.cwd, stdin: receipt.stdin?.path, argv, settled: true }, options)
  return evaluate({
    agent: receipt.agent, role: receipt.role, workspace: receipt.workspace, data: receipt.data, cwd: receipt.cwd, argv,
    ...(receipt.stdin ? { stdin: receipt.stdin.path } : {}),
    ...(receipt.packet ? { packet: receipt.packet.path } : {}),
    ...(receipt.resume ? { resumeOf: receipt.resume.original_receipt } : {})
  }, options)
}

function sameReceipt(receipt, recomputed) {
  const strip = (value) => {
    const rest = { ...value }
    delete rest.receipt_hash
    delete rest.issued_at
    return rest
  }
  const before = strip(receipt)
  const after = strip(recomputed)
  if (canonicalJson(before) !== canonicalJson(after)) {
    const changed = Object.keys({ ...before, ...after }).filter((key) => canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null))
    return { ok: false, reason: `the receipt no longer matches: ${changed.join(', ')} changed` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------
// The route inspection

/**
 * Where an app's command would send data, as BMN can read it: the harness's own provider and host
 * with the deciding sources. With `data`, also the roster provider that names and whether it may
 * see private work. Inspection only: it never authorizes anything.
 */
export function inspectRoute(agent, argv, environment, processCwd, data = null) {
  let result
  if (agent.harness === 'opencode') {
    const version = harnessVersion('opencode', environment)
    result = { ...inspectOpenCode(environment), harness: 'opencode', version, version_state: versionStanding('opencode', version).state }
  } else if (isRetired(agent.harness)) {
    result = { harness: agent.harness, basis: 'unknown', provider: null, host: null, reason: retiredWords(agent.harness), sources: [], inspection_only: true }
  } else {
    const parsed = argv === null
      ? (agent.harness === 'codex' ? { harness: 'codex', command: 'codex', envMode: 'inherit', assignments: {}, config: [] } : { harness: 'claude', command: 'claude', envMode: 'inherit', assignments: {}, addDir: [] })
      : parseDispatch(argv)
    if (parsed.unsupported) return { harness: agent.harness, unsupported: parsed.unsupported }
    const resolution = parsed.harness === 'codex' ? resolveCodexRoute(parsed, environment, processCwd) : resolveClaudeRoute(parsed, environment, processCwd)
    if (resolution.unsupported) return { harness: parsed.harness, unsupported: resolution.unsupported }
    const version = harnessVersion(parsed.command, dispatchEnvironment(parsed, environment))
    result = {
      harness: parsed.harness, ...resolution.route,
      model: resolution.model?.value ?? null, effort: resolution.effort?.value ?? null,
      version, version_state: versionStanding(parsed.harness, version).state
    }
  }
  if (data !== null && result.basis !== undefined) {
    const destination = destinationOf(data, result.harness, result)
    if (destination.known && destination.provider !== null) {
      result.roster_provider = destination.provider
      result.private_work = result.inspection_only || destination.unapproved !== undefined ? 'public_only' : privateWorkAnswer(data, destination, null).allowed ? 'allowed' : 'public_only'
    }
  }
  return result
}

// ---------------------------------------------------------------------------------------------
// CLI

const CHECK_VALUES = ['agent', 'role', 'workspace', 'data', 'cwd', 'stdin', 'packet', 'resume-of', 'verify']

/** Read only when a packet dispatch carries --append-system-prompt, so other checks never open the master. */
function publicClaudeRules() {
  try {
    return publicRendering('claude')
  } catch {
    return null
  }
}

export async function runCheckCommand(action, argv) {
  if (action === 'visibility') return visibilityCommand(argv)
  if (action === 'bind') return bindCommand(argv)
  let parsed
  try {
    parsed = readOptions(argv, action === 'route' ? { flags: ['json'], values: ['agent'] } : { flags: ['json', ...(action === 'check' ? ['research'] : [])], values: CHECK_VALUES })
    if (parsed.positionals.length > 0) throw new AgentsUsageError(`roster ${action} takes no positional arguments; the dispatch goes after --`)
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const options = parsed.options
  const asJson = options.json === true
  try {
    if (action === 'route') return routeCommand(options, parsed.rest, asJson)
    if (options.verify !== undefined) {
      if (action !== 'check') throw new AgentsUsageError('--verify is only for roster check')
      const others = Object.keys(options).filter((name) => !['verify', 'json'].includes(name))
      if (others.length > 0 || parsed.rest === null) throw new AgentsUsageError('roster check --verify <receipt> -- <dispatch argv> takes no other options')
      const result = verifyReceipt(options.verify, parsed.rest, { publicRules: publicClaudeRules })
      if (asJson) out(JSON.stringify({ ok: result.ok, ...(result.ok ? {} : { code: 'RECEIPT_INVALID', reason: result.reason }) }, null, 2))
      else out(result.ok ? 'Receipt verified: the same check passes with the same inputs.' : `bmn: RECEIPT_INVALID: ${result.reason}`)
      return result.ok ? 0 : EXIT.RECEIPT_INVALID
    }
    if (parsed.rest === null || parsed.rest.length === 0) throw new AgentsUsageError(`roster ${action} requires -- <dispatch argv>`)
    let result
    if (options.research === true) {
      const others = Object.keys(options).filter((name) => !['research', 'agent', 'stdin', 'cwd', 'json'].includes(name))
      if (others.length > 0) throw new AgentsUsageError('roster check --research takes --agent and --stdin (and --cwd) in place of --role, --workspace and --data')
      for (const name of ['agent', 'stdin']) if (options[name] === undefined) throw new AgentsUsageError(`roster check --research requires --${name}`)
      result = evaluateResearch({ agent: options.agent, stdin: options.stdin, argv: parsed.rest, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) })
    } else {
      for (const name of ['agent', 'role', 'workspace', 'data']) {
        if (options[name] === undefined) throw new AgentsUsageError(`roster ${action} requires --${name}`)
      }
      if (!['private', 'public'].includes(options.data)) throw new AgentsUsageError('--data must be private or public')
      result = evaluate({
        agent: options.agent, role: options.role, workspace: options.workspace, data: options.data, argv: parsed.rest,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.packet !== undefined ? { packet: options.packet } : {}), ...(options['resume-of'] !== undefined ? { resumeOf: options['resume-of'] } : {})
      }, { publicRules: publicClaudeRules })
    }
    if (action === 'explain') {
      const lines = result.steps.map((step) => `  ${step}`)
      lines.push(result.verdict === 'PASS' ? 'PASS: this dispatch may proceed.' : `REFUSED ${result.code}: ${result.message}\nNext: ${result.next}`)
      if (asJson) out(JSON.stringify({ verdict: result.verdict, steps: result.steps, ...(result.verdict === 'PASS' ? {} : { code: result.code, message: result.message, next: result.next }) }, null, 2))
      else out(lines.join('\n'))
      return result.verdict === 'PASS' ? 0 : EXIT.refusal
    }
    if (result.verdict === 'PASS') {
      const receipt = result.receipt
      out(asJson ? JSON.stringify(receipt, null, 2)
        : `PASS ${receipt.agent} ${receipt.role ?? 'research'} -> ${receipt.route.host} (${receipt.data ?? 'research'}, private work ${receipt.private_work.allowed ? 'allowed' : 'not allowed'}); receipt ${receipt.receipt_hash.slice(0, 12)}; BMN judged this command and does not run it${receipt.context_limit_note === undefined ? '' : `\n${receipt.context_limit_note}`}${result.note === undefined ? '' : `\n${result.note}`}`)
      // With --json standard output is the receipt alone, as a caller saves it; the line goes beside it.
      if (asJson && result.note !== undefined) err(`bmn: ${result.note}`)
      return 0
    }
    if (asJson) out(JSON.stringify({ verdict: 'REFUSED', code: result.code, message: result.message, next: result.next, ...(result.detail === undefined ? {} : { detail: result.detail }) }, null, 2))
    else out(`REFUSED ${result.code}: ${result.message}\nNext: ${result.next}`)
    return EXIT.refusal
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    return failWith(error, asJson)
  }
}

function routeCommand(options, rest, asJson) {
  if (options.agent === undefined) throw new AgentsUsageError('roster route requires --agent')
  const generation = readApprovedWithFile()
  const agent = generation.data.agents.find((candidate) => candidate.id === options.agent)
  if (agent === undefined) throw new RosterError('UNKNOWN_AGENT', `no agent ${options.agent} in approved version ${generation.number}`)
  const result = inspectRoute(agent, rest, process.env, process.cwd(), generation.data)
  if (asJson) {
    out(JSON.stringify({ agent: agent.id, inspection_only: true, ...result }, null, 2))
  } else {
    const lines = [`${agent.id} (${result.harness}); inspection only, never an authorization`]
    if (result.unsupported) lines.push(`  unsupported: ${result.unsupported}`)
    else {
      lines.push(`  destination: ${result.host ?? 'unknown'} (${result.basis}${result.reason ? `: ${result.reason}` : ''})`)
      lines.push(`  decided by: ${result.sources?.length ? result.sources.join(', ') : 'defaults only'}`)
      if (result.roster_provider) lines.push(`  provider: ${result.roster_provider} (${result.private_work === 'allowed' ? 'may see private work' : 'public work only'})`)
      if (result.model) lines.push(`  model: ${result.model}`)
      if (result.version !== undefined) lines.push(`  ${result.harness} ${result.version ?? '(version unreadable)'}: ${result.version_state}`)
    }
    out(lines.join('\n'))
  }
  return result.unsupported ? EXIT.refusal : 0
}

async function visibilityCommand(argv) {
  let parsed
  try {
    parsed = readOptions(argv, { flags: ['json', 'refresh'] })
    if (parsed.positionals.length !== 1 || parsed.rest !== null) throw new AgentsUsageError('roster visibility expects exactly one workspace path')
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const asJson = parsed.options.json === true
  try {
    const workspace = canonicalDirectory(parsed.positionals[0], process.cwd())
    if (workspace === null) throw new RosterError('WORKSPACE_UNKNOWN', `${parsed.positionals[0]} is not an existing directory without ..`)
    if (parsed.options.refresh === true) await refreshVisibility(workspace)
    const status = workspaceVisibility(workspace)
    const record = status.record ?? null
    if (asJson) {
      out(JSON.stringify({ workspace, public: status.public, reason: status.reason, record }, null, 2))
    } else {
      const lines = [`${workspace}: ${status.public ? 'public' : 'private'} (${status.reason})`]
      if (record !== null) {
        lines.push(`  checked ${record.checked_at}${record.origin ? `, origin ${record.origin}` : ''}`)
        if (record.visibility === 'public') lines.push(`  default branch ${record.default_branch} at ${record.commit}`)
      } else if (!parsed.options.refresh) {
        lines.push('  run with --refresh to ask GitHub once')
      }
      out(lines.join('\n'))
    }
    return 0
  } catch (error) {
    if (error instanceof RosterError && error.code === 'WORKSPACE_UNKNOWN') {
      if (asJson) out(JSON.stringify({ ok: false, code: error.code, message: error.message }, null, 2))
      else out(`bmn: ${error.code}: ${error.message}`)
      return EXIT.refusal
    }
    return failWith(error, asJson)
  }
}

function bindCommand(argv) {
  let parsed
  try {
    parsed = readOptions(argv, { flags: ['json'], values: ['receipt', 'session'] })
    if (parsed.positionals.length > 0 || parsed.rest !== null) throw new AgentsUsageError('roster bind takes --receipt <file> --session <id>')
    for (const name of ['receipt', 'session']) if (parsed.options[name] === undefined) throw new AgentsUsageError(`roster bind requires --${name}`)
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  const asJson = parsed.options.json === true
  try {
    const bound = bindSession(parsed.options.receipt, parsed.options.session)
    out(asJson ? JSON.stringify({ ok: true, ...bound }, null, 2) : `Bound session ${bound.session_id} to receipt ${bound.receipt_hash.slice(0, 12)}.`)
    return 0
  } catch (error) {
    return failWith(error, asJson)
  }
}
