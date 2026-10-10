// MODULE: agents-tools.mjs - Story 60.12: one list of MCP tools for every agent app: each app's own settings entry, one state per app and tool, install and undo as one transaction, import of what the apps already hold, and the tools of one agent's run
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { APP_NAMES, HARNESSES, RosterError, TOOL_PATTERN, agentsDirectory, canonicalJson, harnessPrivateWork, sha256 } from './agents-roster.mjs'
import { readApproved } from './agents-state.mjs'
import { ToolFileError, editJsonEntry, editTomlEntry, readJsonEntries, readTomlEntries, renderTomlEntry } from './agents-tool-files.mjs'
import { ConfigWriteError, pathState, replaceFileSafely } from './safe-config-write.mjs'

/**
 * The owner keeps one list of MCP tools in the team file (`## tools`). A tool reaches every app
 * unless it is kept to some apps, or to the runs of some agents, in which case no app's settings
 * hold it and a checked run carries it in its own command.
 *
 * An app's settings entry is BMN's only where BMN wrote it. Nothing is written for an app until
 * the owner's test showed, on exactly the installed version, that the app reads tools from the
 * file BMN would change (60.12 AC1); until then its tools are "not supported yet".
 *
 * A tool names environment variables, it never holds their values, and BMN keeps none: an entry
 * that holds a value inline is never replaced, since putting it back would need the value. What
 * BMN prints of an entry it did not write has every such value masked.
 */

export class ToolsError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function home(environment) {
  return environment.HOME || homedir()
}

/**
 * Per app: its program, the settings file that holds its user-level tools and where in it, how an
 * entry there names an environment variable, the command that lists the tools the app sees, and
 * the app's own commands for adding and removing one. These are what BMN asks; what an app
 * answers is recorded by the owner's test, per version.
 */
export const TOOL_APPS = {
  claude: {
    command: 'claude', format: 'json', path: ['mcpServers'], reference: (name) => `\${${name}}`, referencePattern: /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/,
    file: (environment) => `${environment.CLAUDE_CONFIG_DIR || home(environment)}/.claude.json`,
    list: ['mcp', 'list'], add: (id, program) => ['mcp', 'add', '--scope', 'user', id, '--', program], remove: (id) => ['mcp', 'remove', '--scope', 'user', id]
  },
  codex: {
    command: 'codex', format: 'toml', path: ['mcp_servers'], reference: null, referencePattern: null,
    file: (environment) => `${environment.CODEX_HOME || `${home(environment)}/.codex`}/config.toml`,
    list: ['mcp', 'list'], add: (id, program) => ['mcp', 'add', id, '--', program], remove: (id) => ['mcp', 'remove', id]
  },
  opencode: {
    command: 'opencode', format: 'json', path: ['mcp'], reference: (name) => `{env:${name}}`, referencePattern: /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/,
    file: (environment) => `${environment.XDG_CONFIG_HOME || `${home(environment)}/.config`}/opencode/opencode.jsonc`,
    list: ['mcp', 'list'], add: null, remove: null
  },
  cursor: {
    command: 'cursor-agent', format: 'json', path: ['mcpServers'], reference: (name) => `\${env:${name}}`, referencePattern: /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/,
    file: (environment) => `${home(environment)}/.cursor/mcp.json`,
    list: ['mcp', 'list'], add: null, remove: null
  }
}

/** States that need nothing done: the tool is where it should be, or is rightly absent. */
export const SETTLED_STATES = ['current', 'excluded']

export function toolsTestsPath() {
  return `${agentsDirectory()}/state/tools-tests.jsonl`
}

function writtenPath() {
  return `${agentsDirectory()}/state/rules/tools-written.json`
}

function approvedOrNull() {
  try {
    return readApproved()
  } catch (error) {
    if (error instanceof RosterError && (error.code === 'NOT_APPROVED' || error.code === 'STATE_CORRUPT')) return null
    throw error
  }
}

// ---------------------------------------------------------------------------------------------
// What the owner's test proved, per app version (60.12 AC1)

/** Every recorded test, oldest first; a line BMN cannot read is skipped, never guessed. */
export function toolsTests() {
  let text
  try {
    text = readFileSync(toolsTestsPath(), 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const entry = JSON.parse(line)
      if (entry !== null && typeof entry === 'object' && typeof entry.harness === 'string') entries.push(entry)
    } catch {
      // A torn line proves nothing.
    }
  }
  return entries
}

function record(entry) {
  mkdirSync(dirname(toolsTestsPath()), { recursive: true, mode: 0o700 })
  appendFileSync(toolsTestsPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  return entry
}

/** The last test of one app, whatever version it ran against, or null. */
export function lastToolsTest(harness, tests = toolsTests()) {
  let last = null
  for (const entry of tests) if (entry.harness === harness) last = entry
  return last
}

/**
 * What the owner's test showed about an app's tools on exactly this version; the latest test of
 * that version decides. `variable` is whether the app was seen passing a named environment
 * variable to a tool, `isolation` whether a run was seen with only the tools its command names.
 */
export function appTools(harness, { version, tests = toolsTests() }) {
  const base = { harness, version: version ?? null, supported: false, variable: false, isolation: false, own_command: null }
  if (TOOL_APPS[harness] === undefined) return { ...base, reason: 'BMN does not know this app' }
  if (typeof version !== 'string') return { ...base, reason: `${APP_NAMES[harness]} is not installed, or its version cannot be read` }
  let last = null
  for (const entry of tests) if (entry.harness === harness && entry.version === version) last = entry
  if (last === null) return { ...base, reason: `no test has run on ${APP_NAMES[harness]} ${version}` }
  if (last.outcome !== 'pass') return { ...base, reason: `the test on ${APP_NAMES[harness]} ${version} did not pass: ${last.detail ?? last.outcome}` }
  return { ...base, supported: true, variable: last.variable === 'pass', isolation: last.isolation === 'pass', own_command: last.own_command ?? null }
}

// ---------------------------------------------------------------------------------------------
// A tool as each app writes it, and an app's entry read back

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** What a tool is, apart from who gets it: the program or the address, and the variables it names. */
export function definitionOf(tool) {
  return tool.url !== undefined
    ? { url: tool.url, ...(tool.headers && Object.keys(tool.headers).length > 0 ? { headers: tool.headers } : {}) }
    : { command: tool.command, ...(tool.args?.length ? { args: tool.args } : {}), ...(tool.env && Object.keys(tool.env).length > 0 ? { env: tool.env } : {}) }
}

/**
 * The settings entry an app takes for a tool, or why that app cannot take it. `variable` is
 * whether the app was seen passing a named variable on its installed version: without it a tool
 * that names one is not written, since the tool would start without what it needs.
 */
export function renderTool(tool, harness, { variable = false } = {}) {
  const spec = TOOL_APPS[harness]
  const app = APP_NAMES[harness]
  const definition = definitionOf(tool)
  const bound = Object.keys(definition.env ?? {}).length + Object.keys(definition.headers ?? {}).length + (definition.args ?? []).filter(isMap).length
  if (bound > 0 && !variable) return { blocked: `BMN has not seen ${app} pass an environment variable to a tool on this version` }
  if (harness === 'codex') {
    if ((definition.args ?? []).some(isMap)) return { blocked: 'Codex has no way to pass an environment variable as an argument' }
    const renamed = Object.entries(definition.env ?? {}).find(([name, from]) => name !== from)
    if (renamed !== undefined) return { blocked: `Codex passes a variable only under its own name: ${renamed[0]} cannot come from ${renamed[1]}` }
    return {
      entry: definition.url !== undefined
        ? { url: definition.url, ...(definition.headers ? { env_http_headers: definition.headers } : {}) }
        : { command: definition.command, ...(definition.args ? { args: definition.args } : {}), ...(definition.env ? { env_vars: Object.keys(definition.env) } : {}) }
    }
  }
  const references = (map) => Object.fromEntries(Object.entries(map).map(([name, from]) => [name, spec.reference(from)]))
  const args = (definition.args ?? []).map((arg) => (isMap(arg) ? spec.reference(arg.env) : arg))
  if (harness === 'opencode') {
    return {
      entry: definition.url !== undefined
        ? { type: 'remote', url: definition.url, ...(definition.headers ? { headers: references(definition.headers) } : {}), enabled: true }
        : { type: 'local', command: [definition.command, ...args], ...(definition.env ? { environment: references(definition.env) } : {}), enabled: true }
    }
  }
  const typed = harness === 'claude'
  return {
    entry: definition.url !== undefined
      ? { ...(typed ? { type: 'http' } : {}), url: definition.url, ...(definition.headers ? { headers: references(definition.headers) } : {}) }
      : { ...(typed ? { type: 'stdio' } : {}), command: definition.command, args, ...(definition.env ? { env: references(definition.env) } : {}) }
  }
}

const SECRET_NAME = /(?:key|token|secret|passw|credential|auth|bearer|session)/i

/** Whether a text of an argument or an address looks as if it held a secret: BMN then never prints or keeps it. */
export function looksSecret(text) {
  if (typeof text !== 'string') return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/.test(text)) return true
  if (/[?&][^=&#\s]*(?:key|token|secret|passw|sig|auth)[^=&#\s]*=[^&#\s]+/i.test(text)) return true
  if (/(?:key|token|secret|passw|credential|bearer)[A-Za-z0-9_-]*[=:]\s*\S+/i.test(text)) return true
  if (/\b(?:sk|pk|ghp|gho|ghu|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}/.test(text)) return true
  return /^[A-Za-z0-9+_=-]{32,}$/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text)
}

/**
 * An app's entry as a tool definition, with what it holds that a tool cannot: `secrets` are the
 * fields that hold a value inline (their names only), `extras` the settings BMN does not write.
 * Null when the entry is not an MCP entry BMN recognises.
 */
export function neutralOf(value, harness) {
  if (!isMap(value)) return null
  const spec = TOOL_APPS[harness]
  const secrets = []
  const extras = []
  const reference = (text) => (typeof text === 'string' && spec.referencePattern ? spec.referencePattern.exec(text)?.[1] ?? null : null)
  const bindings = (map, field) => {
    const out = {}
    if (map === undefined) return out
    if (!isMap(map)) {
      extras.push(field)
      return out
    }
    for (const [name, text] of Object.entries(map)) {
      const from = reference(text)
      if (from !== null) out[name] = from
      // Text around a variable is not a value of its own, but a tool cannot say it either.
      else if (typeof text === 'string' && /\$\{|\{env:/.test(text)) extras.push(`${field}.${name}`)
      else secrets.push(`${field}.${name}`)
    }
    return out
  }
  const literalArgs = (list, field) => {
    if (list === undefined) return []
    if (!Array.isArray(list) || list.some((arg) => typeof arg !== 'string')) {
      extras.push(field)
      return []
    }
    return list.map((arg, index) => {
      const from = reference(arg)
      if (from !== null) return { env: from }
      if (looksSecret(arg) || (index > 0 && /^--?[A-Za-z0-9-]*$/.test(list[index - 1]) && SECRET_NAME.test(list[index - 1]) && !arg.startsWith('-'))) secrets.push(`${field}[${index}]`)
      return arg
    })
  }
  let known
  let definition
  if (harness === 'codex') {
    known = ['command', 'args', 'env_vars', 'env', 'url', 'env_http_headers', 'http_headers']
    if (typeof value.url === 'string') {
      const headers = isMap(value.env_http_headers) && Object.values(value.env_http_headers).every((name) => typeof name === 'string') ? value.env_http_headers : {}
      if (value.env_http_headers !== undefined && headers !== value.env_http_headers) extras.push('env_http_headers')
      for (const name of Object.keys(isMap(value.http_headers) ? value.http_headers : {})) secrets.push(`headers.${name}`)
      definition = { url: value.url, headers }
    } else if (typeof value.command === 'string') {
      const forwarded = Array.isArray(value.env_vars) && value.env_vars.every((name) => typeof name === 'string') ? value.env_vars : []
      if (value.env_vars !== undefined && forwarded !== value.env_vars) extras.push('env_vars')
      for (const name of Object.keys(isMap(value.env) ? value.env : {})) secrets.push(`env.${name}`)
      definition = { command: value.command, args: literalArgs(value.args, 'args'), env: Object.fromEntries(forwarded.map((name) => [name, name])) }
    } else return null
  } else if (harness === 'opencode') {
    known = ['type', 'command', 'environment', 'url', 'headers', 'enabled']
    if (value.enabled === false) extras.push('enabled')
    if (typeof value.url === 'string' && value.type !== 'local') definition = { url: value.url, headers: bindings(value.headers, 'headers') }
    else if (Array.isArray(value.command) && value.command.length > 0 && value.command.every((part) => typeof part === 'string')) {
      definition = { command: value.command[0], args: literalArgs(value.command.slice(1), 'command'), env: bindings(value.environment, 'environment') }
    } else return null
  } else {
    known = ['type', 'command', 'args', 'env', 'url', 'headers']
    if (typeof value.url === 'string') definition = { url: value.url, headers: bindings(value.headers, 'headers') }
    else if (typeof value.command === 'string') definition = { command: value.command, args: literalArgs(value.args, 'args'), env: bindings(value.env, 'env') }
    else return null
  }
  if (definition.url !== undefined && looksSecret(definition.url)) secrets.push('url')
  for (const key of Object.keys(value)) if (!known.includes(key)) extras.push(key)
  const sorted = (map) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)))
  const clean = definition.url !== undefined
    ? { url: definition.url, ...(Object.keys(definition.headers).length > 0 ? { headers: sorted(definition.headers) } : {}) }
    : { command: definition.command, ...(definition.args.length > 0 ? { args: definition.args } : {}), ...(Object.keys(definition.env).length > 0 ? { env: sorted(definition.env) } : {}) }
  return { definition: clean, secrets, extras }
}

const MASK = '•••'

/** An entry BMN did not write, for showing: every inline value and anything that looks like a secret masked, nothing else changed. */
export function maskedEntry(value, harness) {
  const neutral = neutralOf(value, harness)
  const hidden = new Set(neutral?.secrets ?? [])
  const walk = (item, path) => {
    if (hidden.has(path)) return MASK
    if (Array.isArray(item)) return item.map((entry, index) => walk(entry, `${path}[${index}]`))
    if (isMap(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry, path === '' ? key : `${path}.${key}`)]))
    // An inline value under another name than the definition's (Codex http_headers, OpenCode command) is masked by its look.
    return typeof item === 'string' && looksSecret(item) ? MASK : item
  }
  const masked = walk(value, '')
  if (isMap(masked) && harness === 'codex') {
    for (const key of ['env', 'http_headers']) if (isMap(masked[key])) masked[key] = Object.fromEntries(Object.keys(masked[key]).map((name) => [name, MASK]))
  }
  if (isMap(masked) && harness === 'opencode' && Array.isArray(masked.command)) masked.command = masked.command.map((part, index) => (hidden.has(`command[${index - 1}]`) ? MASK : part))
  return masked
}

function entryText(harness, id, value) {
  return TOOL_APPS[harness].format === 'toml' ? renderTomlEntry(id, value) : `${JSON.stringify(id)}: ${JSON.stringify(value, null, 2)}`
}

// ---------------------------------------------------------------------------------------------
// An app's settings file

/**
 * The tools an app's settings file holds now. `link` is set when the file is a link: BMN reads
 * through it and never writes there. An unreadable file reports why and holds no entries.
 */
export function readAppTools(harness, environment = process.env, { path = TOOL_APPS[harness].file(environment) } = {}) {
  const spec = TOOL_APPS[harness]
  let state
  try {
    state = pathState(path)
  } catch (error) {
    return { harness, path, readable: false, detail: error.message, entries: new Map(), state: null }
  }
  let text = ''
  if (state.kind === 'file') text = state.text
  else if (state.kind === 'link') {
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      return { harness, path, readable: false, detail: `the link cannot be followed (${error.code ?? 'error'})`, entries: new Map(), state }
    }
  }
  try {
    const raw = spec.format === 'toml' ? readTomlEntries(text) : readJsonEntries(text, spec.path)
    const entries = new Map()
    for (const [id, entry] of raw) {
      if (entry.unreadable !== undefined) entries.set(id, { unreadable: entry.unreadable })
      else {
        const neutral = neutralOf(entry.value, harness)
        entries.set(id, neutral === null ? { unreadable: 'it is not a tool entry BMN recognises' } : { value: entry.value, raw: entry.raw, hash: sha256(canonicalJson(entry.value)), ...neutral })
      }
    }
    return { harness, path, readable: true, entries, state, text, ...(state.kind === 'link' ? { link: state.target } : {}) }
  } catch (error) {
    if (!(error instanceof ToolFileError)) throw error
    return { harness, path, readable: false, detail: error.message, entries: new Map(), state }
  }
}

function edited(harness, text, id, value, raw) {
  const spec = TOOL_APPS[harness]
  return spec.format === 'toml' ? editTomlEntry(text, id, value, spec.path[0], { raw }) : editJsonEntry(text, spec.path, id, value, { raw })
}

// ---------------------------------------------------------------------------------------------
// Check

function written() {
  try {
    const value = JSON.parse(readFileSync(writtenPath(), 'utf8'))
    return isMap(value) ? value : {}
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new RosterError('STATE_CORRUPT', `${writtenPath()} cannot be read`)
  }
}

const recordKey = (harness, id) => `${harness}|${id}`

/** Whether an app may have a tool installed: the tool's own scope, and Public on a destination that gets public work only. */
export function eligible(tool, harness, kind) {
  if (tool.agents !== undefined) return false
  if (tool.apps !== undefined && !tool.apps.includes(harness)) return false
  return kind === 'full' || tool.public === true
}

/** A tool's program or address in a few words, never an argument: an argument may be long or private. */
export function transportWords(tool) {
  if (tool.url !== undefined) {
    try {
      return new URL(tool.url).host
    } catch {
      return 'an address'
    }
  }
  const first = (tool.args ?? []).find((arg) => typeof arg === 'string' && !arg.startsWith('-'))
  return first !== undefined && !looksSecret(first) && first.length <= 60 ? `${tool.command} ${first}` : tool.command
}

/** One state for one tool in one app (60.12 AC4, by the precedence of 60.11 AC2). */
function toolState(app, file, tool, records, wanted) {
  const found = file.entries.get(tool.id)
  const known = records[recordKey(app.harness, tool.id)]
  if (found?.unreadable !== undefined) return { state: 'unreadable', detail: `BMN cannot read the entry there: ${found.unreadable}` }
  if (!wanted) {
    if (found === undefined) return { state: 'excluded' }
    return { state: 'exposed', managed: known !== undefined && known.hash === found.hash, ...(found.secrets.length > 0 ? { secret: true } : {}) }
  }
  const rendered = renderTool(tool, app.harness, { variable: app.variable })
  if (rendered.blocked !== undefined) return { state: 'blocked', detail: rendered.blocked }
  if (found === undefined) return { state: 'missing' }
  const secret = found.secrets.length > 0 ? { secret: true, detail: `it holds a value inline (${found.secrets.join(', ')}): move it into an environment variable, then name the variable in the tool` } : {}
  if (known === undefined) return { state: 'unmanaged', ...secret }
  if (known.hash !== found.hash) return { state: 'edited-outside', ...secret }
  return { state: found.hash === sha256(canonicalJson(rendered.entry)) ? 'current' : 'stale' }
}

/**
 * One row per app and per tool (60.12 AC4). `versions` maps each app to its installed version;
 * `generation` is the approved team, which alone decides the tools and each app's destination.
 * An app without a passed test is `supported: false` and none of its tools is judged. Entries an
 * app holds that are not on the list are `unlisted`: BMN did not write them and leaves them, and
 * on a destination that gets public work only they count as exposed.
 */
export function checkTools({ environment = process.env, tests = toolsTests(), versions, generation = approvedOrNull() } = {}) {
  const data = generation?.data ?? null
  const tools = data?.tools ?? []
  const records = written()
  const apps = HARNESSES.map((harness) => {
    const answer = harnessPrivateWork(data, harness)
    const kind = answer.allowed ? 'full' : 'public'
    const file = readAppTools(harness, environment)
    const app = { ...appTools(harness, { version: versions?.[harness] ?? null, tests }), kind, kind_reason: answer.reason, path: file.path, readable: file.readable, ...(file.detail ? { detail: file.detail } : {}), ...(file.link ? { link: file.link } : {}) }
    if (!app.supported) return { ...app, tools: [], unlisted: [] }
    if (!file.readable) return { ...app, tools: tools.map((tool) => ({ id: tool.id, state: 'unreadable', detail: file.detail })), unlisted: [] }
    const listed = new Set(tools.map((tool) => tool.id))
    return {
      ...app,
      tools: tools.map((tool) => ({ id: tool.id, ...toolState(app, file, tool, records, eligible(tool, harness, kind)) })),
      unlisted: [...file.entries.entries()].filter(([id]) => !listed.has(id)).map(([id, entry]) => ({
        id, state: kind === 'full' ? 'unmanaged' : 'exposed', managed: records[recordKey(harness, id)] !== undefined && entry.hash !== undefined && records[recordKey(harness, id)].hash === entry.hash,
        ...(entry.secrets?.length ? { secret: true } : {})
      }))
    }
  })
  return {
    tools: tools.map((tool) => ({ id: tool.id, name: tool.name, transport: transportWords(tool), public: tool.public === true, apps: tool.apps ?? null, agents: tool.agents ?? null })),
    apps
  }
}

/** 0 only when some app is supported and, in every supported app, each tool is settled and nothing is exposed. */
export function checkExit(result) {
  const supported = result.apps.filter((app) => app.supported)
  if (supported.length === 0) return 1
  return supported.every((app) => app.readable && app.tools.every((tool) => SETTLED_STATES.includes(tool.state)) && app.unlisted.every((entry) => entry.state !== 'exposed' && entry.managed !== true)) ? 0 : 1
}

/** How many entries an install would add, replace or remove, and how many stay exposed or blocked whatever is installed. */
export function pendingCounts(result) {
  let pending = 0
  let exposed = 0
  let blocked = 0
  for (const app of result.apps) {
    for (const row of app.tools) {
      if (row.state === 'blocked' || row.secret === true) blocked += 1
      else if (row.state === 'exposed') {
        if (row.managed === true) pending += 1
        else exposed += 1
      } else if (!SETTLED_STATES.includes(row.state) && row.state !== 'unreadable') pending += 1
    }
    for (const row of app.unlisted) {
      if (row.managed === true) pending += 1
      else if (row.state === 'exposed') exposed += 1
    }
  }
  return { pending, exposed, blocked }
}

/** An app's tools in a few words, for Health and for the check's summary line. */
export function appStateWord(app) {
  if (!app.supported) return 'Not supported yet'
  if (!app.readable) return 'Differs'
  const states = new Set(app.tools.map((tool) => tool.state))
  if (states.has('exposed') || app.unlisted.some((entry) => entry.state === 'exposed')) return 'Exposed'
  if ([...states].some((state) => !SETTLED_STATES.includes(state) && state !== 'missing')) return 'Differs'
  if (states.has('missing')) return 'Missing'
  return app.tools.some((tool) => tool.state === 'current') ? 'Set up' : 'None'
}

// ---------------------------------------------------------------------------------------------
// Install and undo

const CHANGE_WORDS = {
  missing: 'adds the tool',
  unmanaged: 'takes over an entry BMN did not write (unmanaged)',
  'edited-outside': 'replaces an entry changed outside BMN',
  stale: 'updates BMN\'s entry'
}

function planHash(targets) {
  return sha256(canonicalJson(targets.map((target) => ({ harness: target.harness, tool: target.tool, path: target.path, action: target.action, prior: target.prior_hash, wanted: target.wanted_hash, unlisted: target.unlisted === true }))))
}

/**
 * What an install would do, without doing it: per app, the entries to set or remove, each with
 * what the file holds there now (masked) and what it would hold, plus what stays exposed or
 * blocked whatever is installed, and one hash a confirmed install must match. `harnesses` empty
 * means every supported app. `removeUnlisted` also removes entries that are not on the list.
 */
export async function planToolsInstall(harnesses = [], { environment = process.env, versions, tests = toolsTests(), removeUnlisted = false } = {}) {
  const generation = approvedOrNull()
  const { routeFor, routeStillMatches } = await import('./agents-rules.mjs')
  const stop = (code, message) => ({ code, message, targets: [], exposed: [], blocked: [], planHash: null })
  const check = checkTools({ environment, tests, versions, generation })
  const named = harnesses.length > 0 ? harnesses : check.apps.filter((app) => app.supported).map((app) => app.harness)
  if (named.length === 0) return stop('TOOLS_UNSUPPORTED', 'tools are not supported yet in any app: run the test first (Preferences > Rules > Health, or bmn tools test <app>); nothing was written')
  const tools = new Map((generation?.data.tools ?? []).map((tool) => [tool.id, tool]))
  const targets = []
  const exposed = []
  const blocked = []
  for (const harness of named) {
    const app = check.apps.find((entry) => entry.harness === harness)
    const name = APP_NAMES[harness]
    if (!app.supported) return stop('TOOLS_UNSUPPORTED', `${name}: tools not supported yet (${app.reason}); nothing was written`)
    if (!app.readable) return stop('TOOL_FILE_UNREADABLE', `${app.path}: ${app.detail}; nothing was written`)
    // Like the rules: before a tool that is not public reaches an app, the app must still send its data where the approved team says.
    const route = await routeStillMatches(harness, routeFor(harness, generation), environment)
    if (!route.ok) return stop('ROUTE_CHANGED', `${name} cannot get its tools: ${route.reason}; ${route.remedy}`)
    const file = readAppTools(harness, environment)
    const changes = []
    for (const row of app.tools) {
      const found = file.entries.get(row.id)
      const base = { harness, tool: row.id, path: app.path }
      if (row.state === 'blocked') {
        blocked.push({ ...base, fix: row.detail })
      } else if (row.secret === true) {
        blocked.push({ ...base, fix: row.detail ?? `${name}'s entry holds a value inline: move it into an environment variable first` })
      } else if (row.state === 'exposed') {
        if (row.managed === true) changes.push({ ...base, action: 'remove', change: 'exposed', words: `removes BMN's entry: ${name} may no longer have this tool`, found })
        else exposed.push({ ...base, fix: `BMN did not write this entry in ${app.path}: remove it there, or let ${name} have the tool` })
      } else if (!SETTLED_STATES.includes(row.state) && row.state !== 'unreadable') {
        changes.push({ ...base, action: 'set', change: row.state, words: CHANGE_WORDS[row.state], found, entry: renderTool(tools.get(row.id), harness, { variable: app.variable }).entry })
      }
    }
    for (const row of app.unlisted) {
      const found = file.entries.get(row.id)
      const base = { harness, tool: row.id, path: app.path, unlisted: true }
      if (row.managed === true) changes.push({ ...base, action: 'remove', change: 'stale', words: 'removes BMN\'s entry: the tool left your list', found })
      else if (removeUnlisted && row.secret !== true && found?.unreadable === undefined) changes.push({ ...base, action: 'remove', change: 'unmanaged', words: 'removes an entry that is not on your list (BMN did not write it)', found })
      else if (removeUnlisted) blocked.push({ ...base, fix: 'BMN cannot put this entry back if you undo, so it leaves it: remove it by hand' })
      else if (row.state === 'exposed') exposed.push({ ...base, fix: `${name} gets public work only and holds an entry that is not on your list: remove it there, or add it to the list and mark it Public` })
    }
    if (changes.length > 0 && app.link !== undefined) return stop('TOOL_FILE_LINK', `${app.path} is a link to ${app.link}: BMN does not write through a link or replace it; make it a file, or change the entry there by hand. Nothing was written`)
    for (const change of changes) {
      const { found, entry, ...rest } = change
      targets.push({
        ...rest, ...(entry === undefined ? {} : { entry }),
        before: found === undefined ? null : entryText(harness, change.tool, maskedEntry(found.value, harness)),
        after: entry === undefined ? null : entryText(harness, change.tool, entry),
        prior: found === undefined ? null : found.raw, prior_hash: found === undefined ? null : found.hash, wanted_hash: entry === undefined ? null : sha256(canonicalJson(entry))
      })
    }
  }
  return { code: 'OK', targets, exposed, blocked, planHash: planHash(targets) }
}

/** The plan as the panel and `--plan --json` show it: never an inline value, never a whole file. */
export function toolsPlanView(result) {
  return {
    code: result.code, ...(result.message ? { message: result.message } : {}), plan_hash: result.planHash,
    targets: result.targets.map((target) => ({ harness: target.harness, tool: target.tool, path: target.path, action: target.action, change: target.change, words: target.words, before: target.before, after: target.after })),
    exposed: result.exposed, blocked: result.blocked
  }
}

function planDetails(planned) {
  const lines = planned.targets.map((target) => [
    `${target.harness}: ${target.tool} in ${target.path}`,
    `  ${target.words}`,
    ...(target.before === null ? [] : target.before.split('\n').map((line) => `  - ${line}`)),
    ...(target.after === null ? [] : target.after.split('\n').map((line) => `  + ${line}`))
  ].join('\n'))
  return [...lines, ...planned.exposed.map((entry) => `still exposed: ${entry.harness} ${entry.tool} - ${entry.fix}`), ...planned.blocked.map((entry) => `not changed: ${entry.harness} ${entry.tool} - ${entry.fix}`)].join('\n')
}

/**
 * Changes one entry in the file as it is at this moment: refused when the entry is no longer what
 * the plan showed, or the file became a link. An app rewrites its own settings file at any time;
 * when it does so in the instant of the write, the file is read again and the write is made only
 * if this entry is still what was shown, so nothing the app wrote is lost. `raw` puts back an
 * entry's earlier text.
 */
function writeEntry(harness, path, id, expectedHash, value, raw, { beforeCommit } = {}) {
  const read = () => readAppTools(harness, undefined, { path })
  for (let attempt = 0; ; attempt += 1) {
    const file = read()
    if (!file.readable) throw new ToolsError('TOOL_FILE_UNREADABLE', `${path}: ${file.detail}`)
    if (file.link !== undefined) throw new ToolsError('TOOL_FILE_LINK', `${path} became a link; nothing was written there`)
    const found = file.entries.get(id)
    if ((found?.hash ?? null) !== expectedHash) throw new ToolsError('REVISION_CONFLICT', `${id} in ${path} changed while BMN was reading it; nothing was written there`)
    try {
      replaceFileSafely(path, file.state, edited(harness, file.text ?? '', id, value, raw), attempt === 0 ? { beforeCommit } : {})
      break
    } catch (error) {
      if (!(error instanceof ConfigWriteError) || error.code !== 'REVISION_CONFLICT' || attempt >= 2) throw error
    }
  }
  const after = read().entries.get(id)
  const good = value === undefined && raw === undefined ? after === undefined : after !== undefined && after.unreadable === undefined && (raw !== undefined || after.hash === sha256(canonicalJson(value)))
  if (!good) throw new ToolsError('READBACK_FAILED', `${path} does not hold what BMN wrote for ${id}; check it by hand`)
  return after?.hash ?? null
}

/**
 * One install transaction (60.12 AC4): show every entry, ask (default No), plan again and write
 * only what was confirmed. Only the named entries change in each file as it is at that moment;
 * what an entry held is kept as its own text, never the file. A failure part-way stops and keeps
 * the manifest, so `bmn rules restore --transaction` can undo what changed.
 */
export async function installTools(harnesses = [], { yes = false, asJson = false, environment = process.env, versions, now = new Date(), expectedPlanHash, removeUnlisted = false, afterConfirm, beforeTarget, beforeCommit } = {}) {
  const { confirm } = await import('./agents-rules.mjs')
  const options = { environment, versions, removeUnlisted }
  const planned = await planToolsInstall(harnesses, options)
  const open = { exposed: planned.exposed, blocked: planned.blocked }
  if (planned.code !== 'OK') return { code: planned.code, message: planned.message, transaction: null, written: [], exposed: [], blocked: [] }
  if (expectedPlanHash !== undefined && expectedPlanHash !== planned.planHash) {
    return { code: 'REVISION_CONFLICT', message: 'the tools or the apps\' settings changed since the plan was shown; review it again', transaction: null, written: [], ...open }
  }
  if (planned.targets.length === 0) {
    const waits = planned.exposed.length > 0 || planned.blocked.length > 0
    return { code: 'OK', transaction: null, written: [], ...open, message: waits ? 'Nothing to install; some tools stay exposed or cannot be written.' : 'Every app already has its tools.' }
  }
  if (!await confirm('Change these tool entries?', planDetails(planned), { yes, asJson })) return { code: 'NOT_CONFIRMED', transaction: null, written: [], ...open }
  // The answer may come long after the list: plan again and write only what was confirmed.
  afterConfirm?.()
  const confirmed = await planToolsInstall(harnesses, options)
  if (confirmed.code !== 'OK') return { code: confirmed.code, message: confirmed.message, transaction: null, written: [], exposed: [], blocked: [] }
  if (confirmed.planHash !== planned.planHash) {
    return { code: 'REVISION_CONFLICT', message: 'the tools or the apps\' settings changed while the confirmation was open; nothing was written', transaction: null, written: [], exposed: confirmed.exposed, blocked: confirmed.blocked }
  }
  const { newTransaction, writePrivate } = await import('./agents-rules.mjs')
  const { id, folder } = newTransaction(now)
  const records = written()
  const manifest = {
    id, created_at: now.toISOString(), kind: 'tools', reason: 'tools install', state: 'started',
    targets: confirmed.targets.map((target) => ({
      harness: target.harness, tool: target.tool, path: target.path, action: target.action,
      // What the entry held, as its own text: the plan refuses to touch one that holds a value inline, so none is kept here.
      prior: target.prior, prior_hash: target.prior_hash, prior_record: records[recordKey(target.harness, target.tool)] ?? null, written_hash: target.wanted_hash, done: false
    }))
  }
  const save = () => writePrivate(`${folder}/manifest.json`, JSON.stringify(manifest, null, 2))
  save()
  const done = []
  for (const [index, target] of confirmed.targets.entries()) {
    try {
      beforeTarget?.(target, index)
      writeEntry(target.harness, target.path, target.tool, target.prior_hash, target.entry, undefined, { beforeCommit: beforeCommit === undefined ? undefined : () => beforeCommit(target, index) })
    } catch (error) {
      manifest.state = 'failed'
      save()
      return { code: 'INSTALL_FAILED', transaction: id, written: done, exposed: confirmed.exposed, blocked: confirmed.blocked,
        message: `${target.path}: ${error.code ?? 'write failed'}: ${error.message}; ${done.length} entr${done.length === 1 ? 'y' : 'ies'} changed; undo with bmn rules restore --transaction ${id}` }
    }
    const next = written()
    if (target.action === 'remove') delete next[recordKey(target.harness, target.tool)]
    else next[recordKey(target.harness, target.tool)] = { harness: target.harness, tool: target.tool, hash: target.wanted_hash }
    writePrivate(writtenPath(), JSON.stringify(next, null, 2))
    manifest.targets[index].done = true
    save()
    done.push({ harness: target.harness, tool: target.tool, path: target.path, action: target.action })
  }
  manifest.state = 'complete'
  save()
  return { code: 'OK', transaction: id, written: done, exposed: confirmed.exposed, blocked: confirmed.blocked }
}

/**
 * Undoes one tools transaction (called by `bmn rules restore --transaction`): each entry it
 * changed goes back to the text it had, or is removed where there was none, in the file as it is
 * now. Shown and confirmed like the install, and refused for an entry that changed meanwhile.
 */
export async function restoreToolsTransaction(manifest, _folder, { yes = false, asJson = false, planOnly = false, expectedPlanHash } = {}) {
  const { confirm, writePrivate } = await import('./agents-rules.mjs')
  // Each entry is looked for in the file the install changed, wherever the apps' settings are now.
  const plans = manifest.targets.filter((target) => target.done === true).reverse().map((target) => {
    const found = readAppTools(target.harness, undefined, { path: target.path }).entries.get(target.tool)
    return { ...target, current_hash: found?.hash ?? null }
  })
  const targets = plans.map((plan) => ({
    harness: plan.harness, tool: plan.tool, path: plan.path, resolved_path: plan.path, change: plan.prior === null ? 'missing' : 'entry',
    becomes: plan.prior === null ? 'removed (it was not there)' : 'the entry as it was', diff: '', note: 'Only this entry changes; the rest of the file stays as it is now.'
  }))
  const hash = sha256(canonicalJson(plans.map((plan) => ({ harness: plan.harness, tool: plan.tool, current: plan.current_hash, prior: plan.prior_hash }))))
  if (planOnly) return { code: 'OK', plan_hash: hash, targets }
  if (expectedPlanHash !== undefined && expectedPlanHash !== hash) return { code: 'REVISION_CONFLICT', message: 'the entries changed since the restore was shown; review it again' }
  const details = targets.map((target) => `${target.harness}: ${target.tool} in ${target.path} -> ${target.becomes}`).join('\n')
  if (!await confirm(`Restore transaction ${manifest.id}?`, details, { yes, asJson })) return { code: 'NOT_CONFIRMED' }
  const restored = []
  for (const plan of plans) {
    // What BMN wrote must still be there: an entry changed since is the owner's, and stays.
    if (plan.current_hash !== plan.written_hash) {
      return { code: 'REVISION_CONFLICT', message: `${plan.tool} in ${plan.path} changed since BMN wrote it; ${restored.length} entr${restored.length === 1 ? 'y' : 'ies'} restored`, restored }
    }
    try {
      writeEntry(plan.harness, plan.path, plan.tool, plan.current_hash, undefined, plan.prior ?? undefined)
    } catch (error) {
      if (!(error instanceof ToolsError) && !(error instanceof ConfigWriteError) && !(error instanceof ToolFileError)) throw error
      return { code: error.code, message: `${error.message}; ${restored.length} entr${restored.length === 1 ? 'y' : 'ies'} restored`, restored }
    }
    const records = written()
    if (plan.prior_record === null) delete records[recordKey(plan.harness, plan.tool)]
    else records[recordKey(plan.harness, plan.tool)] = plan.prior_record
    writePrivate(writtenPath(), JSON.stringify(records, null, 2))
    restored.push(plan.harness)
  }
  return { code: 'OK', kind: 'tools', restored: [...new Set(restored)] }
}

// ---------------------------------------------------------------------------------------------
// Import: what the apps already hold, proposed as tools (60.12 AC3)

const titled = (id) => id.split(/[-_]/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || id

/**
 * Every entry the apps' settings hold, proposed as a tool. Entries under one id are one proposal
 * only when what they run and the variables they name are the same in each app; otherwise each
 * stays its own, blocked, proposal for the owner to settle. A value held inline is left out of the
 * proposal and named, never shown: such a tool cannot be installed until the value moves into an
 * environment variable. `state`: `ready`, `secret` (ready, with a value left out), `known` (already
 * on the list), `conflict` or `unreadable`.
 */
export function proposeTools({ environment = process.env, generation = approvedOrNull() } = {}) {
  const listed = new Set((generation?.data.tools ?? []).map((tool) => tool.id))
  const found = new Map()
  const files = []
  for (const harness of HARNESSES) {
    const file = readAppTools(harness, environment)
    files.push({ harness, path: file.path, readable: file.readable, ...(file.detail ? { detail: file.detail } : {}) })
    for (const [id, entry] of file.entries) found.set(id, [...(found.get(id) ?? []), { harness, entry }])
  }
  const proposals = []
  for (const [id, holders] of [...found.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const apps = holders.map((holder) => holder.harness)
    if (listed.has(id)) {
      proposals.push({ id, state: 'known', apps, notes: ['already on your list'] })
      continue
    }
    const unreadable = holders.find((holder) => holder.entry.unreadable !== undefined)
    if (!TOOL_PATTERN.test(id) || unreadable !== undefined) {
      proposals.push({ id, state: 'unreadable', apps, notes: [unreadable !== undefined ? `${APP_NAMES[unreadable.harness]}: ${unreadable.entry.unreadable}` : 'its name has characters a tool id cannot have (lowercase letters, digits, - and _)'] })
      continue
    }
    const groups = new Map()
    for (const holder of holders) {
      const key = canonicalJson(holder.entry.definition)
      groups.set(key, [...(groups.get(key) ?? []), holder])
    }
    for (const group of groups.values()) {
      const secrets = group.flatMap((holder) => holder.entry.secrets.map((field) => `${APP_NAMES[holder.harness]} ${field}`))
      const extras = group.flatMap((holder) => holder.entry.extras.map((field) => `${APP_NAMES[holder.harness]} ${field}`))
      const definition = group[0].entry.definition
      // An argument or an address that looks like a secret is left out too: the proposal never carries it.
      const clean = definition.url !== undefined
        ? (looksSecret(definition.url) ? null : definition)
        : { ...definition, ...(definition.args ? { args: definition.args.filter((arg, index) => !group.some((holder) => holder.entry.secrets.some((field) => field.endsWith(`[${index}]`)))) } : {}) }
      const notes = [
        ...(secrets.length > 0 ? [`holds a value inline (${secrets.join(', ')}): move this value into an environment variable; it was left out and the tool cannot be installed until then`] : []),
        ...(extras.length > 0 ? [`settings BMN does not write and an install would drop: ${extras.join(', ')}`] : [])
      ]
      const tool = clean === null ? null : { id, name: titled(id), ...clean, apps: HARNESSES.filter((harness) => group.some((holder) => holder.harness === harness)) }
      if (tool?.args?.length === 0) delete tool.args
      if (groups.size > 1) {
        proposals.push({ id, state: 'conflict', apps: group.map((holder) => holder.harness), ...(tool ? { tool } : {}), notes: [`the apps define ${id} differently: keep one, or give each its own id`, ...notes] })
      } else if (tool === null) {
        proposals.push({ id, state: 'unreadable', apps, notes })
      } else {
        proposals.push({ id, state: secrets.length > 0 ? 'secret' : 'ready', apps: tool.apps, tool, notes })
      }
    }
  }
  return { files, proposals }
}

// ---------------------------------------------------------------------------------------------
// The tools of one agent's run (60.12 AC5)

/** The tools kept to this agent: the only ones a run BMN checks may carry. */
export function agentTools(data, agentId) {
  return (data?.tools ?? []).filter((tool) => tool.agents?.includes(agentId))
}

const tomlInline = (value) => renderTomlEntry('x', { v: value }).split('\n')[1].slice('v = '.length)

/**
 * The items that give one run exactly its agent's tools, and nothing the app's own settings hold:
 * for Codex an emptied `mcp_servers` followed by one `-c` per setting, for Claude Code
 * `--strict-mcp-config` with the tools as `--mcp-config`. `state` says why there are none:
 * `none` (the agent has no tools of its own), `not-supported-yet` (no test on this app version
 * showed a run with only its own tools) or `blocked` (a tool the app cannot take).
 */
export function toolItems(agent, data, proven) {
  const tools = agentTools(data, agent.id)
  if (tools.length === 0) return { state: 'none' }
  const app = APP_NAMES[agent.harness] ?? agent.harness
  if (agent.harness !== 'codex' && agent.harness !== 'claude') return { state: 'not-supported-yet', tools: tools.map((tool) => tool.id), reason: `BMN has no way to give a run of ${app} its own tools` }
  if (!proven.isolation) return { state: 'not-supported-yet', tools: tools.map((tool) => tool.id), reason: `no test on this ${app} version showed a run with only its own tools (bmn tools test ${agent.harness})` }
  const entries = {}
  for (const tool of tools) {
    const rendered = renderTool(tool, agent.harness, { variable: proven.variable })
    if (rendered.blocked !== undefined) return { state: 'blocked', tools: tools.map((entry) => entry.id), reason: `${tool.id}: ${rendered.blocked}` }
    entries[tool.id] = rendered.entry
  }
  const argv = agent.harness === 'codex'
    ? ['-c', 'mcp_servers={}', ...Object.entries(entries).flatMap(([id, entry]) => Object.entries(entry).flatMap(([key, value]) => ['-c', `mcp_servers.${id}.${key}=${tomlInline(value)}`]))]
    : ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: entries })]
  return { state: 'applied', tools: tools.map((tool) => tool.id), argv, hash: sha256(canonicalJson(entries)) }
}

/**
 * The MCP entries a Codex command defines with `-c`: null when it names none, `reset` when it first
 * replaces the inherited ones, either with nothing (`mcp_servers={}`, then one item per setting) or
 * with the whole set written inline.
 */
function codexArgvTools(config) {
  const mentions = config.filter((entry) => /^mcp_servers(?:[.=\s]|$)/.test(entry))
  if (mentions.length === 0) return null
  const whole = /^mcp_servers\s*=([\s\S]*)$/.exec(mentions[0])
  const reset = whole !== null
  const entries = {}
  if (whole !== null) {
    const parsed = readTomlEntries(`[mcp_servers.x]\nv = ${whole[1]}\n`).get('x')
    const set = parsed?.unreadable === undefined ? parsed?.value?.v : undefined
    if (!isMap(set) || !Object.values(set).every(isMap)) return { reset, unresolved: 'BMN cannot read the tools written after mcp_servers=' }
    Object.assign(entries, set)
  }
  for (const entry of reset ? mentions.slice(1) : mentions) {
    const match = /^mcp_servers\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)=([\s\S]*)$/.exec(entry)
    if (match === null) return { reset, unresolved: `BMN cannot read "${entry.length > 60 ? `${entry.slice(0, 60)}…` : entry}"` }
    const parsed = readTomlEntries(`[mcp_servers.x]\nv = ${match[3]}\n`).get('x')
    if (parsed === undefined || parsed.unreadable !== undefined) return { reset, unresolved: `BMN cannot read the value of mcp_servers.${match[1]}.${match[2]}` }
    entries[match[1]] ??= {}
    if (Object.hasOwn(entries[match[1]], match[2])) return { reset, unresolved: `mcp_servers.${match[1]}.${match[2]} is given twice` }
    entries[match[1]][match[2]] = parsed.value.v
  }
  return { reset, entries }
}

function claudeArgvTools(parsed) {
  if (parsed.mcpConfig === undefined) return parsed.strictMcp ? { reset: true, entries: {} } : null
  try {
    const servers = JSON.parse(parsed.mcpConfig)?.mcpServers
    if (!isMap(servers)) return { reset: parsed.strictMcp === true, unresolved: '--mcp-config is not a list of tools BMN can read (a file path is not followed)' }
    return { reset: parsed.strictMcp === true, entries: servers }
  } catch {
    return { reset: parsed.strictMcp === true, unresolved: '--mcp-config is not a list of tools BMN can read (a file path is not followed)' }
  }
}

/**
 * Whether a run's command carries exactly its agent's tools (60.12 AC5). While the approved team
 * lists no tools at all the owner has not taken them up, and a command's own tools pass unjudged as
 * they did before this check existed. Once it lists any: a run of an agent with no tools of its
 * own, whose command names none, is as it always was, and a command that names any for such an
 * agent is refused. Otherwise the app version must have shown a run with only its
 * own tools, the command must shut out the app's own settings, and the tools it names must be the
 * agent's, each exactly as approved. A packet run carries no tools at all (`packet`); `profile`
 * says the run takes a Codex profile, from wherever. Returns `{ applied, note }` or
 * `{ refusal: { code, message } }`.
 */
export function checkRunTools(agent, data, parsed, proven, { packet = false, profile = false } = {}) {
  if ((data?.tools ?? []).length === 0) return { applied: [], note: 'tools: not checked (your team lists no tools)' }
  const wanted = packet ? [] : agentTools(data, agent.id)
  const given = parsed.harness === 'codex' ? codexArgvTools(parsed.config ?? []) : claudeArgvTools(parsed)
  const names = given?.entries ? Object.keys(given.entries) : []
  const refuse = (code, message) => ({ refusal: { code, message } })
  const app = APP_NAMES[parsed.harness]
  if (wanted.length === 0) {
    if (given === null || (given.unresolved === undefined && names.length === 0)) return { applied: [], note: packet ? 'tools: none in a packet run' : 'tools: none of its own' }
    if (given.unresolved !== undefined) return refuse('TOOL_MISMATCH', `the tools this command gives cannot be resolved: ${given.unresolved}`)
    return refuse('TOOL_MISMATCH', `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not among ${agent.id}'s tools: ${packet ? 'a packet run carries none' : 'it has none of its own'}`)
  }
  if (parsed.resume) return refuse('ROUTE_UNSUPPORTED', `a resumed ${app} run with tools of its own is not something BMN has seen keep to them`)
  if (profile || parsed.profile !== undefined) return refuse('ROUTE_UNSUPPORTED', `a ${app} profile may add tools of its own; a run of an agent with tools takes none`)
  if (!proven.isolation) return refuse('ROUTE_UNSUPPORTED', `no test on this ${app} version showed a run with only its own tools (bmn tools test ${parsed.harness})`)
  if (given === null) return refuse('TOOL_MISMATCH', `${agent.id}'s tools are missing from the command: ${wanted.map((tool) => tool.id).join(', ')}`)
  if (given.unresolved !== undefined) return refuse('TOOL_MISMATCH', `the tools this command gives cannot be resolved: ${given.unresolved}`)
  if (!given.reset) return refuse('TOOL_MISMATCH', `the command does not shut out the tools in ${app}'s own settings (${parsed.harness === 'codex' ? "-c 'mcp_servers={}' first" : '--strict-mcp-config'})`)
  const expected = new Map()
  for (const tool of wanted) {
    const rendered = renderTool(tool, parsed.harness, { variable: proven.variable })
    if (rendered.blocked !== undefined) return refuse('TOOL_MISMATCH', `${tool.id} cannot be given to ${app}: ${rendered.blocked}`)
    expected.set(tool.id, rendered.entry)
  }
  const missing = [...expected.keys()].filter((id) => !names.includes(id))
  if (missing.length > 0) return refuse('TOOL_MISMATCH', `${agent.id}'s tools are missing from the command: ${missing.join(', ')}`)
  const extra = names.filter((id) => !expected.has(id))
  if (extra.length > 0) return refuse('TOOL_MISMATCH', `${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not among ${agent.id}'s tools`)
  const altered = names.filter((id) => canonicalJson(given.entries[id]) !== canonicalJson(expected.get(id)))
  if (altered.length > 0) return refuse('TOOL_MISMATCH', `${altered.join(', ')} ${altered.length === 1 ? 'differs' : 'differ'} from the approved tool`)
  return { applied: names.sort(), hash: sha256(canonicalJson(Object.fromEntries([...expected.entries()].sort(([a], [b]) => (a < b ? -1 : 1))))), note: `tools: ${names.sort().join(', ')}, and none from ${app}'s own settings` }
}

// ---------------------------------------------------------------------------------------------
// The owner's test (60.12 AC1)

function run(command, argv, { cwd, env, input = '', timeoutMs }) {
  const result = spawnSync(command, argv, { cwd, env, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  return { finished: !result.error && result.status !== null, ok: !result.error && result.status === 0, text: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}

/**
 * Where an app reads its tools, and what it does with them (60.12 AC1). In a throwaway home
 * folder that holds nothing of the owner's, BMN writes one stand-in tool into the app's settings
 * file the way it would for a real one, asks the app which tools it sees, and records whether the
 * app named it, whether the stand-in was started with the value of the variable its entry names,
 * whether a run told to take only its own tools left that entry out, and whether the app's own
 * add and remove commands change the same file. No sign-in is there, so nothing can be sent to a
 * provider; an app that needs one to answer is recorded as inconclusive.
 */
export async function testTools(harness, { environment = process.env, now = new Date(), timeoutMs = 120_000 } = {}) {
  const spec = TOOL_APPS[harness]
  const { harnessVersion } = await import('./agents-check.mjs')
  const version = harnessVersion(spec.command, environment)
  const done = (outcome, detail, extra = {}) => record({ harness, kind: 'capability', at: now.toISOString(), version, outcome, variable: 'unproven', isolation: 'unproven', own_command: 'none', ...extra, detail })
  if (version === null) return done('unavailable', `${spec.command} is not installed or did not answer --version`)
  const folder = mkdtempSync(`${home(environment)}/.bmn-tools-test-`)
  try {
    const testHome = `${folder}/home`
    const work = `${folder}/work`
    mkdirSync(testHome, { recursive: true })
    mkdirSync(work, { recursive: true })
    const tag = randomBytes(4).toString('hex')
    const id = `bmn-test-${tag}`
    const nonce = randomBytes(12).toString('hex')
    const program = `${folder}/tool.sh`
    // The stand-in tool notes that it was started and what it was given, then ends; it speaks to no one.
    writeFileSync(program, `#!/bin/sh\nprintf '%s\\n' "started $BMN_TOOL_TEST_GIVEN" >> '${folder}/started'\nexit 0\n`)
    chmodSync(program, 0o755)
    const testEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(XDG_|CLAUDE_|CODEX_|OPENCODE_|CURSOR_|ANTHROPIC_|OPENAI_)/.test(key)))
    testEnvironment.HOME = testHome
    // Codex passes a variable only under its own name; the other apps are asked to pass it under another.
    const from = harness === 'codex' ? 'BMN_TOOL_TEST_GIVEN' : 'BMN_TOOL_TEST_VALUE'
    testEnvironment[from] = nonce
    const tool = { id, name: 'BMN test', command: program, env: { BMN_TOOL_TEST_GIVEN: from } }
    const path = spec.file(testEnvironment)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, edited(harness, '', id, renderTool(tool, harness, { variable: true }).entry))
    const listed = run(spec.command, spec.list, { cwd: work, env: testEnvironment, timeoutMs })
    if (!listed.text.includes(id)) {
      if (!listed.finished) return done('inconclusive', `${spec.command} did not finish`)
      if (!listed.ok) return done('inconclusive', `${spec.command} did not answer in a home folder without its sign-in`)
      return done('fail', `${APP_NAMES[harness]} did not name a tool written to ${path.replace(testHome, '~')}, so it reads its tools somewhere BMN does not know`)
    }
    let started = ''
    try {
      started = readFileSync(`${folder}/started`, 'utf8')
    } catch {
      // The app listed the tool without starting it.
    }
    // Seen for certain when the stand-in was started with the value; an app that lists a tool without
    // starting it shows only that this version reads the entry's variable name, which its listing repeats.
    const basis = started.includes(nonce) ? 'started' : listed.text.includes(from) ? 'listed' : null
    const variable = basis === null ? 'unproven' : 'pass'
    // A run told to take only its own tools: the entry in the settings file must not be among them.
    let isolation = 'unproven'
    const own = `bmn-run-${tag}`
    const only = harness === 'codex' ? { argv: ['-c', 'mcp_servers={}', '-c', `mcp_servers.${own}.command=${JSON.stringify(program)}`, 'mcp', 'list'], input: '' }
      : harness === 'claude' ? { argv: ['-p', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { [own]: { type: 'stdio', command: program, args: [] } } }), '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], input: '/context\n' }
        : null
    if (only !== null) {
      const alone = run(spec.command, only.argv, { cwd: work, env: testEnvironment, input: only.input, timeoutMs })
      if (alone.text.includes(own)) isolation = alone.text.includes(id) ? 'fail' : 'pass'
    }
    // The app's own commands: whether they change the same file.
    let ownCommand = 'none'
    if (spec.add !== null) {
      const added = `bmn-own-${tag}`
      run(spec.command, spec.add(added, program), { cwd: work, env: testEnvironment, timeoutMs })
      const holds = () => readAppTools(harness, testEnvironment).entries.has(added)
      const wasAdded = holds()
      run(spec.command, spec.remove(added), { cwd: work, env: testEnvironment, timeoutMs })
      ownCommand = wasAdded && !holds() ? 'pass' : 'fail'
    }
    const words = [
      `${APP_NAMES[harness]} reads its tools from ${path.replace(testHome, '~')}`,
      basis === 'started' ? 'it passes a named environment variable to a tool' : basis === 'listed' ? 'its own list names the environment variable a tool is given' : 'BMN did not see it pass an environment variable to a tool',
      ...(only === null ? [] : [isolation === 'pass' ? 'a run can be given only its own tools' : isolation === 'fail' ? 'a run told to take only its own tools still had the one in its settings' : 'BMN could not see which tools a run gets'])
    ]
    return done('pass', words.join('; '), { file: path.replace(testHome, '~'), variable, ...(basis === null ? {} : { variable_basis: basis }), isolation, own_command: ownCommand })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// CLI

export const TOOLS_USAGE = `Usage: bmn tools check [--json]                              One state per app and per tool; exit 0 only when every supported app has its tools and nothing is exposed
       bmn tools install [app…] [--plan] [--remove-unlisted] [--yes]   Set each app's entries, and remove what an app may no longer have, as one transaction
       bmn tools import [--json] [--yes]                       Propose the entries the apps already hold as tools in the team file; you approve them in BMN
       bmn tools test <app> [--json]                           Owner-run: find where the app reads its tools, in an empty home folder

Apps: ${HARNESSES.join(', ')}. The tools are the ## tools section of the approved team.
A tool names environment variables and never holds their values; BMN keeps and prints none.
Undo an install with: bmn rules restore --transaction <id>`

async function installedVersions(environment = process.env) {
  const { harnessVersion } = await import('./agents-check.mjs')
  return Object.fromEntries(HARNESSES.map((harness) => [harness, harnessVersion(TOOL_APPS[harness].command, environment)]))
}

function checkLines(result) {
  const lines = [`Tools: ${result.tools.length === 0 ? 'none on your list' : result.tools.map((tool) => tool.id).join(', ')}`]
  for (const app of result.apps) {
    const name = `${APP_NAMES[app.harness]}${app.version ? ` ${app.version}` : ''}`
    if (!app.supported) {
      lines.push(`${name}: tools not supported yet (${app.reason})`)
      continue
    }
    lines.push(`${name}: ${appStateWord(app)} - ${app.path}; ${app.kind === 'full' ? 'every tool it may have' : 'public tools only'}${app.readable ? '' : ` (${app.detail})`}`)
    const groups = new Map()
    for (const tool of app.tools) groups.set(tool.state, [...(groups.get(tool.state) ?? []), tool.id])
    for (const [state, names] of groups) lines.push(SETTLED_STATES.includes(state) ? `  ${state}: ${names.length}` : `  ${state}: ${names.join(', ')}`)
    if (app.unlisted.length > 0) lines.push(`  not on your list: ${app.unlisted.map((entry) => `${entry.id}${entry.state === 'exposed' ? ' (exposed)' : ''}`).join(', ')}`)
  }
  return lines.join('\n')
}

function proposalLines(result) {
  const lines = []
  for (const proposal of result.proposals) {
    const apps = proposal.apps.map((harness) => APP_NAMES[harness]).join(', ')
    const what = proposal.tool ? (proposal.tool.url !== undefined ? transportWords(proposal.tool) : transportWords(proposal.tool)) : ''
    lines.push(`${proposal.id} (${apps}): ${proposal.state}${what ? ` - ${what}` : ''}`)
    for (const note of proposal.notes) lines.push(`  ${note}`)
  }
  return lines.length > 0 ? lines.join('\n') : 'The apps hold no tool entries.'
}

/** Adds the proposals that can be added to the team file, as an edit the owner approves in BMN. */
async function writeProposals(result, { yes, asJson }) {
  const { confirm } = await import('./agents-rules.mjs')
  const { parseRoster, rewriteRoster, rosterPath } = await import('./agents-roster.mjs')
  const adding = result.proposals.filter((proposal) => proposal.state === 'ready' || proposal.state === 'secret')
  if (adding.length === 0) return { code: 'OK', added: [], message: 'Nothing to add.' }
  const state = pathState(rosterPath())
  if (state.kind !== 'file') return { code: 'ROSTER_MISSING', added: [], message: `${rosterPath()} is not a file; nothing was written` }
  const parsed = parseRoster(state.text)
  if (parsed.data === null) return { code: 'ROSTER_INVALID', added: [], message: 'the team file does not read; fix it first (bmn roster validate). Nothing was written' }
  const have = new Set((parsed.data.tools ?? []).map((tool) => tool.id))
  const fresh = adding.filter((proposal) => !have.has(proposal.id))
  if (fresh.length === 0) return { code: 'OK', added: [], message: 'The team file already holds these tools; approve them in BMN.' }
  if (!await confirm(`Add ${fresh.length} tool${fresh.length === 1 ? '' : 's'} to the team file?`, proposalLines({ proposals: fresh }), { yes, asJson })) return { code: 'NOT_CONFIRMED', added: [] }
  const tools = [...(parsed.data.tools ?? []), ...fresh.map((proposal) => proposal.tool)].sort((a, b) => (a.id < b.id ? -1 : 1))
  const next = rewriteRoster(state.text, { ...parsed.data, tools })
  if (parseRoster(next).data === null) return { code: 'ROSTER_INVALID', added: [], message: 'the tools would not read back from the team file; nothing was written' }
  replaceFileSafely(rosterPath(), state, next)
  return { code: 'OK', added: fresh.map((proposal) => proposal.id), message: `Added ${fresh.map((proposal) => proposal.id).join(', ')} to the team file. Nothing reaches an app until you approve them in BMN (Preferences > Team) and install.` }
}

export async function runToolsCommand(argv) {
  const { AgentsUsageError, EXIT, failWith, out, readOptions, usage } = await import('./agents-cli.mjs')
  const [action, ...rest] = argv
  if (action === undefined || action === '--help' || action === '-h' || action === 'help') {
    out(TOOLS_USAGE)
    return action === undefined ? 2 : 0
  }
  let asJson = false
  try {
    if (action === 'check') {
      const { options, positionals } = readOptions(rest, { flags: ['json'] })
      asJson = options.json === true
      if (positionals.length > 0) return usage('tools check takes no arguments')
      const result = checkTools({ versions: await installedVersions() })
      const code = checkExit(result)
      out(asJson ? JSON.stringify({ ok: code === 0, ...result }, null, 2) : checkLines(result))
      return code
    }
    if (action === 'install') {
      const { options, positionals } = readOptions(rest, { flags: ['json', 'plan', 'yes', 'remove-unlisted'], values: ['expect-plan'] })
      asJson = options.json === true
      const unknown = positionals.filter((name) => !HARNESSES.includes(name))
      if (unknown.length > 0) return usage(`tools install expects apps from ${HARNESSES.join(', ')}, not ${unknown.join(', ')}`)
      const versions = await installedVersions()
      const removeUnlisted = options['remove-unlisted'] === true
      if (options.plan) {
        const planned = await planToolsInstall(positionals, { versions, removeUnlisted })
        out(asJson ? JSON.stringify(toolsPlanView(planned), null, 2) : planned.code !== 'OK' ? `${planned.code}: ${planned.message}` : planDetails(planned) || 'Every app already has its tools.')
        return planned.code === 'OK' ? 0 : EXIT.refusal
      }
      const result = await installTools(positionals, { yes: options.yes === true, asJson, versions, removeUnlisted, expectedPlanHash: options['expect-plan'] })
      if (asJson) out(JSON.stringify(result, null, 2))
      else if (result.code === 'OK') {
        out([result.message ?? `Changed ${result.written.length} entr${result.written.length === 1 ? 'y' : 'ies'} (transaction ${result.transaction}).`,
          ...result.exposed.map((entry) => `still exposed: ${entry.harness} ${entry.tool} - ${entry.fix}`),
          ...result.blocked.map((entry) => `not changed: ${entry.harness} ${entry.tool} - ${entry.fix}`),
          ...(result.transaction ? ['Sessions started before this keep the tools they had.'] : [])].join('\n'))
      } else if (result.code !== 'NOT_CONFIRMED') process.stderr.write(`bmn: ${result.code}: ${result.message}\n`)
      if (result.code === 'REVISION_CONFLICT') return EXIT.REVISION_CONFLICT
      if (result.code === 'NOT_CONFIRMED') return asJson ? 2 : 1
      if (result.code !== 'OK') return result.code === 'INSTALL_FAILED' ? 1 : EXIT.refusal
      // An install never reports success while a tool is exposed or could not be written.
      return result.exposed.length > 0 || result.blocked.length > 0 ? 1 : 0
    }
    if (action === 'import') {
      const { options, positionals } = readOptions(rest, { flags: ['json', 'yes'] })
      asJson = options.json === true
      if (positionals.length > 0) return usage('tools import takes no arguments')
      const result = proposeTools()
      if (asJson && options.yes !== true) {
        out(JSON.stringify(result, null, 2))
        return 0
      }
      if (!asJson) out(proposalLines(result))
      const wrote = await writeProposals(result, { yes: options.yes === true, asJson })
      if (asJson) out(JSON.stringify({ ...result, ...wrote }, null, 2))
      else if (wrote.message) out(wrote.message)
      return wrote.code === 'OK' ? 0 : wrote.code === 'NOT_CONFIRMED' ? 1 : EXIT.refusal
    }
    if (action === 'test') {
      const { options, positionals } = readOptions(rest, { flags: ['json'] })
      asJson = options.json === true
      if (positionals.length !== 1 || !HARNESSES.includes(positionals[0])) return usage(`tools test expects one app: ${HARNESSES.join(', ')}`)
      const result = await testTools(positionals[0])
      out(asJson ? JSON.stringify(result, null, 2) : `${result.harness}: ${result.outcome} - ${result.detail}${result.version ? ` (${result.version})` : ''}`)
      return result.outcome === 'pass' ? 0 : 1
    }
    return usage(`tools expects check, install, import or test, not ${action}`)
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    if (error instanceof ToolsError || error instanceof ToolFileError) {
      if (asJson) out(JSON.stringify({ code: error.code, message: error.message }, null, 2))
      else process.stderr.write(`bmn: ${error.code}: ${error.message}\n`)
      return error.code === 'REVISION_CONFLICT' ? EXIT.REVISION_CONFLICT : 1
    }
    if (error instanceof RosterError) return failWith(error, asJson)
    throw error
  }
}
