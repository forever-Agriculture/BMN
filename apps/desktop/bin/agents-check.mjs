// MODULE: agents-check.mjs - Epic 60.3: `bmn roster check|explain|route`, the fail-closed check before work leaves for another agent
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, relative, sep } from 'node:path'
import { RosterError, agentState, canonicalJson, rosterPath, sha256 } from './agents-roster.mjs'
import { readApproved } from './agents-state.mjs'
import { AgentsUsageError, EXIT, failWith, out, readOptions, usage } from './agents-cli.mjs'
import { restrictedRendering } from './agents-rules.mjs'

/**
 * The check answers one question immediately before a dispatch: may this exact command, run from
 * this directory with this input, send this work to this agent? It reads the approved roster
 * generation only, resolves where the command would really go from a fixed list of configuration
 * keys, and refuses unless every answer is known and allowed. It governs only dispatches that call
 * it, and the window between the check and the exec stays open (docs/agent-control.md).
 */

/** Refusals, checked in this order; the first one found is reported (shared contract). */
export const REFUSALS = ['UNKNOWN_AGENT', 'PROPOSED', 'DISABLED', 'ROLE_UNKNOWN', 'ROLE_INELIGIBLE', 'SQUIRE_CANNOT_LEAD',
  'ROUTE_UNSUPPORTED', 'MODEL_MISMATCH', 'EFFORT_UNSUPPORTED', 'HOST_UNKNOWN', 'HOST_MISMATCH', 'WORKSPACE_UNKNOWN',
  'WORKSPACE_MISMATCH', 'RESUME_UNBOUND', 'HARNESS_UNTESTED', 'DATA_FORBIDDEN', 'PACKET_INVALID']

/** Harness versions whose destination precedence BMN's tests were written against (Epic 60 spike, 2026-10-09). */
export const TESTED_HARNESS_VERSIONS = { codex: ['0.161.0'], claude: ['2.1.295'] }

const NEXT_STEP = {
  UNKNOWN_AGENT: 'name an agent from `bmn team --all`',
  PROPOSED: 'the owner activates this agent in Preferences > Agents first',
  DISABLED: 'pick the next candidate from `bmn roster role <role>`',
  ROLE_UNKNOWN: 'name a role from the roster\'s ## roles',
  ROLE_INELIGIBLE: 'pick a candidate that holds this role (`bmn roster role <role>`)',
  SQUIRE_CANNOT_LEAD: 'a squire never leads; pick a knight',
  ROUTE_UNSUPPORTED: 'use a dispatch form dev-auto documents, exactly as written',
  MODEL_MISMATCH: 'pass the agent\'s own model or an approved alias',
  EFFORT_UNSUPPORTED: 'pass an effort the agent lists',
  HOST_UNKNOWN: 'make the destination knowable (no unresolved base URL) or record the host in the roster',
  HOST_MISMATCH: 'dispatch to the host the roster approved, or have the owner approve the new host',
  WORKSPACE_UNKNOWN: 'pass an existing workspace path without ..',
  WORKSPACE_MISMATCH: 'run from, and point -C/--add-dir at, a directory inside the workspace (or the packet)',
  RESUME_UNBOUND: 'resume only with --resume-of the receipt that started that session, or start a fresh checked dispatch',
  HARNESS_UNTESTED: 'use a tested harness version, or have the owner accept this one in Preferences > Agents',
  DATA_FORBIDDEN: 'private work never goes to a Low route; choose a High agent',
  PACKET_INVALID: 'build a packet of public tracked files and dispatch it through env -i claude -p --safe-mode --tools \'\''
}

class Refusal extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function refuse(code, message) {
  throw new Refusal(code, message)
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
const CODEX_FLAGS = { '--skip-git-repo-check': 'skipGit', '--json': 'json' }
const CLAUDE_VALUE_FLAGS = { '--model': 'model', '--effort': 'effort', '--output-format': 'outputFormat', '--tools': 'tools',
  '--permission-mode': 'permissionMode', '--mcp-config': 'mcpConfig', '--settings': 'settings', '--add-dir': 'addDir',
  '--append-system-prompt': 'appendSystemPrompt' }
const CLAUDE_FLAGS = { '-p': 'print', '--print': 'print', '--safe-mode': 'safeMode', '--no-session-persistence': 'noPersistence',
  '--strict-mcp-config': 'strictMcp' }
/** `-c` keys that cannot change destination, model or effort; anything else unlisted is refused. */
const CODEX_NEUTRAL_KEYS = ['approval_policy', 'mcp_servers', 'model_reasoning_summary', 'model_verbosity', 'hide_agent_reasoning',
  'show_raw_agent_reasoning', 'sandbox_mode']
const CODEX_ROUTE_KEYS = ['model', 'model_provider', 'model_reasoning_effort', 'profile', 'openai_base_url', 'chatgpt_base_url']

function harnessOf(command) {
  const name = basename(command)
  if (name === 'codex') return 'codex'
  if (name === 'claude') return 'claude'
  return null
}

/**
 * Parses exactly the dispatch forms dev-auto documents and nothing else: `codex exec [resume <id>]`
 * and `claude -p`, each optionally behind `env -i NAME=value …`. Returns null for anything else.
 */
export function parseDispatch(argv) {
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
  if (harness === null) return { unsupported: `${command ?? 'nothing'} is not a supported dispatch command (codex exec or claude -p)` }
  const rest = argv.slice(index + 1)
  const base = { harness, command, envMode, assignments }
  return harness === 'codex' ? parseCodex(rest, base) : parseClaude(rest, base)
}

function parseCodex(args, base) {
  if (args[0] !== 'exec') return { unsupported: 'only `codex exec` is a supported Codex dispatch' }
  const parsed = { ...base, config: [], stdin: false, resume: null }
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
    if (Object.hasOwn(CODEX_FLAGS, flag) && equals === -1) {
      parsed[CODEX_FLAGS[flag]] = true
      continue
    }
    if (Object.hasOwn(CODEX_VALUE_FLAGS, flag)) {
      const value = equals !== -1 ? argument.slice(equals + 1) : args[index + 1]
      if (value === undefined) return { unsupported: `${flag} needs a value` }
      if (equals === -1) index += 1
      const key = CODEX_VALUE_FLAGS[flag]
      if (key === 'config') {
        parsed.config.push(value)
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
  const out = { top: {}, profiles: {}, providers: {}, unreadable: [] }
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
      depth += (line.match(/[[{]/g) ?? []).length - (line.match(/[\]}]/g) ?? []).length
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
      depth = (value.match(/[[{]/g) ?? []).length - (value.match(/[\]}]/g) ?? []).length
      if (depth < 0) depth = 0
    }
    if (keys === null) continue
    const path = [...table, ...keys]
    const record = (target, key) => {
      const text = value === null ? undefined : unquoteToml(value)
      if (text === undefined) out.unreadable.push(path.join('.'))
      else target[key] = text
    }
    if (path.length === 1 && CODEX_ROUTE_KEYS.includes(path[0])) record(out.top, path[0])
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

/**
 * Where a `codex exec` goes, with the names of the sources that decided it: `-c` overrides, then
 * the selected profile, then config.toml, then OPENAI_BASE_URL in the dispatch environment.
 */
export function resolveCodexRoute(parsed, environment) {
  const env = dispatchEnvironment(parsed, environment)
  const codexHome = env.CODEX_HOME || (env.HOME ? `${env.HOME}/.codex` : null)
  const sources = []
  const configPath = codexHome === null ? null : `${codexHome}/config.toml`
  const config = readCodexConfig(configPath === null ? null : optionalText(configPath))
  const overrides = {}
  const providerOverrides = {}
  let unresolvable = config.unreadable.length > 0 ? `config.toml ${config.unreadable[0]} cannot be read` : null
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
    } else if (keys.length === 1 && CODEX_NEUTRAL_KEYS.includes(keys[0])) {
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
  return { route: { ...route, sources: [...new Set(sources)] }, model, effort, configHome: codexHome }
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
    for (const key of ['ANTHROPIC_BASE_URL', ...CLAUDE_PROVIDER_SWITCHES]) if (typeof env[key] === 'string') out[key] = env[key]
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
 */
export function resolveClaudeRoute(parsed, environment, cwd) {
  const env = dispatchEnvironment(parsed, environment)
  const configDir = env.CLAUDE_CONFIG_DIR || (env.HOME ? `${env.HOME}/.claude` : null)
  const files = [['managed settings', '/etc/claude-code/managed-settings.json']]
  if (configDir !== null) files.push(['user settings', `${configDir}/settings.json`])
  files.push(['project settings', `${cwd}/.claude/settings.json`], ['local settings', `${cwd}/.claude/settings.local.json`])
  const values = []
  let reason = null
  const take = (source, vars) => {
    if (vars.ANTHROPIC_BASE_URL !== undefined && vars.ANTHROPIC_BASE_URL !== '') values.push({ source, url: vars.ANTHROPIC_BASE_URL })
    for (const key of CLAUDE_PROVIDER_SWITCHES) if (truthy(vars[key])) reason ??= `${key} is set in ${source}`
  }
  take(parsed.envMode === 'clean' ? 'env -i ANTHROPIC_BASE_URL' : 'ANTHROPIC_BASE_URL', env)
  for (const [name, path] of files) {
    const read = settingsEnv(optionalText(path), name)
    if (read.unreadable) reason ??= read.unreadable
    else take(name, read.env)
  }
  if (parsed.settings !== undefined) {
    const inline = parsed.settings.trimStart().startsWith('{')
    const read = settingsEnv(inline ? parsed.settings : optionalText(isAbsolute(parsed.settings) ? parsed.settings : `${cwd}/${parsed.settings}`), '--settings')
    if (read.unreadable || (!inline && read.env === undefined)) reason ??= read.unreadable ?? '--settings cannot be read'
    else take('--settings', read.env)
  }
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
    configHome: configDir
  }
}

/** OpenCode's configured model and provider prefix, for inspection only. */
function inspectOpenCode(environment) {
  const folder = environment.OPENCODE_CONFIG_DIR || `${environment.XDG_CONFIG_HOME || `${environment.HOME ?? homedir()}/.config`}/opencode`
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const text = optionalText(`${folder}/${name}`)
    if (text === null) continue
    const stripped = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? '').replace(/,(\s*[}\]])/g, '$1')
    try {
      const model = JSON.parse(stripped).model
      if (typeof model !== 'string') return { basis: 'unknown', provider: null, host: null, reason: `${name} names no model`, sources: [name] }
      const provider = model.includes('/') ? model.slice(0, model.indexOf('/')) : null
      return { basis: provider === null ? 'unknown' : 'default', provider, host: provider === null ? null : `default:${provider}`, model, sources: [`${name} model`], inspection_only: true }
    } catch {
      return { basis: 'unknown', provider: null, host: null, reason: `${name} cannot be read`, sources: [name] }
    }
  }
  return { basis: 'unknown', provider: null, host: null, reason: 'no OpenCode configuration names a model', sources: [] }
}

const versionCache = new Map()

/** The executable PATH would run, with its change time, so a reinstall is never served from cache. */
function executableIdentity(command, environment) {
  for (const directory of (environment.PATH ?? '').split(':')) {
    if (!directory.startsWith('/')) continue
    try {
      const stat = statSync(`${directory}/${command}`)
      if (stat.isFile()) return `${directory}/${command}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`
    } catch {
      // Not in this directory.
    }
  }
  return null
}

/** `<harness> --version`, the only thing BMN runs; remembered per executable until it changes. */
export function harnessVersion(command, environment) {
  const identity = executableIdentity(command, environment)
  if (identity !== null && versionCache.has(identity)) return versionCache.get(identity)
  let version
  try {
    const text = execFileSync(command, ['--version'], { env: environment, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
    version = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(text)?.[0] ?? null
  } catch {
    version = null
  }
  if (identity !== null && version !== null) versionCache.set(identity, version)
  return version
}

// ---------------------------------------------------------------------------------------------
// Workspaces and labels

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

/** Longest label path matching on a directory boundary, else the roster default, else private. */
export function labelFor(workspace, labels) {
  let best = null
  for (const entry of labels.paths) {
    let canonical = entry.path
    try {
      traceRead?.(entry.path)
      canonical = realpathSync(entry.path)
    } catch {
      // A label for a folder that does not exist yet still matches by its text.
    }
    if (inside(workspace, canonical) && (best === null || canonical.length > best.canonical.length)) best = { canonical, ...entry }
  }
  if (best !== null) return { label: best.label, source: best.canonical === workspace ? 'explicit' : 'inherited', path: best.canonical }
  return { label: labels.default ?? 'private', source: 'default' }
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

/** The tracked blob at HEAD for `name`, or null when it is untracked, ignored or missing. */
function headBlob(workspace, name) {
  try {
    const type = execFileSync('git', ['-C', workspace, 'cat-file', '-t', `HEAD:${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim()
    if (type !== 'blob') return null
    return execFileSync('git', ['-C', workspace, 'cat-file', 'blob', `HEAD:${name}`], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 * 1024 * 1024 })
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

/** Finds `<sessions>/YYYY/MM/DD/rollout-*-<id>.jsonl` and returns its first-line metadata. */
function sessionRecord(codexHome, id) {
  if (!/^[0-9a-f-]{8,64}$/i.test(id) || codexHome === null) return null
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
  if (found.length !== 1) return null
  const line = firstLine(found[0])
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

/**
 * Why an agent's effective security is Low (empty when it is High): the agent itself, or its
 * harness route missing, Low or owner-declared (60.3 AC4). `explain` and the Agents panel's
 * consequence wording read the same reasons.
 */
export function lowSecurityReasons(agent, data) {
  const reasons = []
  const route = data.harness_routes.find((entry) => entry.harness === agent.harness)
  if (agent.security === 'low') reasons.push(`${agent.id} is Low`)
  if (route === undefined) reasons.push(`no approved ${agent.harness} route in ## harness-routes`)
  else if (route.security === 'low') reasons.push(`the ${agent.harness} route is Low`)
  else if (route.basis === 'owner-declared') reasons.push(`the ${agent.harness} route is owner-declared`)
  return reasons
}

/** What an approved generation lets each agent do, in the terms the check enforces. */
function capabilities(data) {
  const out = new Map()
  for (const agent of data.agents) {
    const active = agentState(agent) === 'active'
    const checkable = agent.harness === 'claude' || agent.harness === 'codex'
    out.set(agent.id, {
      name: agent.name, active,
      lead: active && agent.title === 'knight' && agent.authority === 'lead' && agent.roles.includes('lead'),
      private: active && checkable && agent.host !== null && lowSecurityReasons(agent, data).length === 0,
      roles: new Set(active ? agent.roles : [])
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

/**
 * The consequences of moving from `before` to `after` approved data, in words: who could start or
 * stop leading, receiving private work, or taking a role; which chain starts elsewhere; which
 * workspaces change label; which harness versions become trusted. `before` may be null (first approval).
 */
export function consequences(before, after) {
  const empty = { agents: [], roles: [], harness_routes: [], data_labels: { default: 'private', paths: [] } }
  const old = capabilities(before ?? empty)
  const next = capabilities(after)
  const out = []
  const name = (id) => next.get(id)?.name ?? old.get(id)?.name ?? id
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(id) ?? { active: false, lead: false, private: false, roles: new Set() }
    const b = next.get(id) ?? { active: false, lead: false, private: false, roles: new Set() }
    if (!a.active && b.active) out.push(`${name(id)} could be dispatched`)
    if (a.active && !b.active) out.push(`${name(id)} could no longer be dispatched`)
    if (!a.lead && b.lead) out.push(`${name(id)} could lead`)
    if (a.lead && !b.lead) out.push(`${name(id)} could no longer lead`)
    if (!a.private && b.private) out.push(`${name(id)} could receive private work`)
    if (a.private && !b.private) out.push(`${name(id)} could no longer receive private work`)
    if (a.active && b.active) {
      for (const role of b.roles) if (!a.roles.has(role)) out.push(`${name(id)} could take the ${role} role`)
      for (const role of a.roles) if (!b.roles.has(role)) out.push(`${name(id)} could no longer take the ${role} role`)
    }
  }
  const oldRoles = new Map((before?.roles ?? []).map((role) => [role.id, role]))
  for (const role of after.roles) {
    const previous = oldRoles.get(role.id)
    const first = firstEligible(after, role)
    const was = previous === undefined ? null : firstEligible(before, previous)
    if (first !== was) {
      out.push(first === null ? `${role.id} would have no eligible candidate (then ${role.then})` : `${role.id} would start with ${name(first)}${was === null ? '' : ` instead of ${name(was)}`}`)
    }
    if (previous !== undefined && previous.then !== role.then) out.push(`when every ${role.id} candidate fails: ${role.then} instead of ${previous.then}`)
  }
  for (const role of before?.roles ?? []) if (!after.roles.some((entry) => entry.id === role.id)) out.push(`the ${role.id} role would be removed`)
  const oldLabels = new Map((before?.data_labels.paths ?? []).map((entry) => [entry.path, entry.label]))
  for (const entry of after.data_labels.paths) {
    if (oldLabels.get(entry.path) !== entry.label) {
      out.push(entry.label === 'public' ? `${entry.path} becomes public: Low routes could receive its tracked files in packets` : `${entry.path} becomes private: only High routes could receive its work`)
    }
  }
  if ((before?.data_labels.default ?? 'private') !== after.data_labels.default) out.push(`unlabelled workspaces become ${after.data_labels.default}`)
  const oldRoutes = new Map((before?.harness_routes ?? []).map((route) => [route.harness, route]))
  for (const route of after.harness_routes) {
    const added = (route.accepted_versions ?? []).filter((version) => !(oldRoutes.get(route.harness)?.accepted_versions ?? []).includes(version))
    for (const version of added) out.push(`${route.harness} ${version} could carry private work (owner-accepted, untested by BMN)`)
    const revoked = (oldRoutes.get(route.harness)?.accepted_versions ?? []).filter((version) => !(route.accepted_versions ?? []).includes(version))
    for (const version of revoked) out.push(`${route.harness} ${version} could no longer carry private work (acceptance revoked)`)
  }
  return [...new Set(out)]
}

/**
 * Evaluates one dispatch against the approved generation. Returns `{ verdict: 'PASS', receipt, steps }`
 * or `{ verdict: 'REFUSED', code, message, next, steps }`; `steps` is what `explain` prints.
 */
export function evaluate(inputs, { environment = process.env, cwd: processCwd = process.cwd(), restrictedRules = null, now = new Date() } = {}) {
  const steps = []
  const note = (text) => steps.push(text)
  try {
    const generation = readApproved()
    const data = generation.data
    note(`approved generation ${generation.number}`)
    const agent = data.agents.find((candidate) => candidate.id === inputs.agent)
    if (agent === undefined) refuse('UNKNOWN_AGENT', `no agent ${inputs.agent} in approved generation ${generation.number}`)
    const state = agentState(agent)
    if (state === 'proposed') refuse('PROPOSED', `${agent.id} is proposed, not approved as active`)
    if (state === 'disabled') refuse('DISABLED', `${agent.id} is disabled`)
    note(`agent ${agent.id}: ${agent.title}, ${agent.harness} ${agent.model}, security ${agent.security}`)
    const role = data.roles.find((candidate) => candidate.id === inputs.role)
    if (role === undefined) refuse('ROLE_UNKNOWN', `no role ${inputs.role} in the approved ## roles`)
    if (!agent.roles.includes(role.id)) refuse('ROLE_INELIGIBLE', `${agent.id} does not hold role ${role.id}`)
    if (role.id === 'lead' && agent.title === 'squire') refuse('SQUIRE_CANNOT_LEAD', `${agent.id} is a squire`)
    if (role.id === 'lead' && agent.authority !== 'lead') refuse('ROLE_INELIGIBLE', `${agent.id} has authority ${agent.authority}; only authority lead may lead`)
    note(`role ${role.id}: held`)

    const parsed = parseDispatch(inputs.argv)
    if (parsed.unsupported) refuse('ROUTE_UNSUPPORTED', parsed.unsupported)
    if (agent.harness !== parsed.harness) {
      refuse('ROUTE_UNSUPPORTED', agent.harness === 'opencode' || agent.harness === 'cursor'
        ? `BMN does not check ${agent.harness} dispatches` : `${agent.id} runs on ${agent.harness}, the command is ${parsed.harness}`)
    }
    const cwd = canonicalDirectory(inputs.cwd ?? processCwd, processCwd)
    const resolution = parsed.harness === 'codex'
      ? resolveCodexRoute(parsed, environment)
      : resolveClaudeRoute(parsed, environment, cwd ?? processCwd)
    if (resolution.unsupported) refuse('ROUTE_UNSUPPORTED', resolution.unsupported)
    note(`dispatch form: ${parsed.envMode === 'clean' ? 'env -i ' : ''}${parsed.harness === 'codex' ? `codex exec${parsed.resume ? ' resume' : ''}` : 'claude -p'}`)

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

    const route = resolution.route
    if (route.basis === 'unknown') refuse('HOST_UNKNOWN', `the destination cannot be resolved: ${route.reason}`)
    if (agent.host === null) refuse('HOST_UNKNOWN', `${agent.id}'s approved host is unknown (null)`)
    if (agent.host === 'default') {
      if (route.host !== `default:${agent.provider}`) refuse('HOST_MISMATCH', `the command reaches ${route.host}, the roster approved default:${agent.provider}`)
    } else if (route.host !== agent.host.toLowerCase()) {
      refuse('HOST_MISMATCH', `the command reaches ${route.host}, the roster approved ${agent.host}`)
    }
    note(`route ${route.host} (${route.basis}${route.sources.length ? `; decided by ${route.sources.join(', ')}` : ''})`)

    if (typeof inputs.workspace !== 'string' || inputs.workspace.split('/').includes('..')) refuse('WORKSPACE_UNKNOWN', 'the workspace path contains ..')
    const workspace = canonicalDirectory(inputs.workspace, processCwd)
    if (workspace === null) refuse('WORKSPACE_UNKNOWN', `${inputs.workspace} is not an existing directory`)
    if (cwd === null) refuse('WORKSPACE_MISMATCH', `--cwd ${inputs.cwd} is not an existing directory without ..`)
    // An unreadable packet is a packet refusal, reported in its place in the order, after every earlier one.
    const packet = inputs.packet === undefined ? null : canonicalDirectory(inputs.packet, processCwd)
    const packetMissing = inputs.packet !== undefined && packet === null
    const within = (dir) => inside(dir, workspace) || (packet !== null && inside(dir, packet))
    if (!within(cwd)) refuse('WORKSPACE_MISMATCH', `cwd ${cwd} is outside the workspace${packet ? ' and the packet' : ''}`)
    if (parsed.cd !== undefined) {
      const target = canonicalDirectory(parsed.cd, cwd)
      if (target === null || !within(target)) refuse('WORKSPACE_MISMATCH', `-C ${parsed.cd} is outside the workspace${packet ? ' and the packet' : ''}`)
    }
    for (const dir of parsed.addDir ?? []) {
      const target = canonicalDirectory(dir, cwd)
      if (target === null || !inside(target, workspace)) refuse('WORKSPACE_MISMATCH', `--add-dir ${dir} is outside the workspace`)
    }
    const label = labelFor(workspace, data.data_labels)
    const dataLabel = stricter(label.label, inputs.data)
    note(`workspace ${workspace}: ${label.label} (${label.source}); data ${dataLabel}`)

    let resume = null
    if (parsed.resume) {
      if (packet !== null) refuse('RESUME_UNBOUND', 'a resume never passes in packet mode')
      if (inputs.resumeOf === undefined) refuse('RESUME_UNBOUND', 'codex exec resume needs --resume-of <receipt of the dispatch that started it>')
      const original = readReceiptFile(inputs.resumeOf)
      if (original === null) refuse('RESUME_UNBOUND', `${inputs.resumeOf} is not an intact version-1 receipt`)
      const same = original.agent === agent.id && original.model === model.value && original.harness === parsed.harness
        && original.workspace === workspace && original.label?.value === label.label
        && canonicalJson(original.route) === canonicalJson({ provider: route.provider, host: route.host, basis: route.basis, sources: route.sources })
      if (!same) refuse('RESUME_UNBOUND', 'the original receipt\'s agent, model, workspace, label or route differs from this dispatch')
      const record = sessionRecord(resolution.configHome, parsed.resume.id)
      if (record === null) refuse('RESUME_UNBOUND', `no single readable Codex session record for ${parsed.resume.id}`)
      let recordCwd = null
      try {
        recordCwd = typeof record.cwd === 'string' ? realpathSync(record.cwd) : null
      } catch {
        recordCwd = null
      }
      if (record.id !== parsed.resume.id || recordCwd === null || !inside(recordCwd, workspace) || record.provider !== route.provider) {
        refuse('RESUME_UNBOUND', 'the session record\'s id, cwd or provider does not match this dispatch')
      }
      resume = { session_id: parsed.resume.id, original_receipt_hash: original.receipt_hash, original_receipt: inputs.resumeOf, data: original.data }
      note(`resume bound to receipt ${original.receipt_hash.slice(0, 12)} and session ${parsed.resume.id}`)
    }
    const effectiveData = resume === null ? dataLabel : stricter(dataLabel, resume.data)

    const version = harnessVersion(parsed.command, dispatchEnvironment(parsed, environment))
    const harnessRoute = data.harness_routes.find((entry) => entry.harness === parsed.harness)
    const tested = version !== null && (TESTED_HARNESS_VERSIONS[parsed.harness] ?? []).includes(version)
    const accepted = !tested && version !== null && (harnessRoute?.accepted_versions ?? []).includes(version)
    const versionState = tested ? 'tested' : accepted ? 'owner-accepted, untested' : 'untested'
    if (effectiveData === 'private' && !tested && !accepted) {
      refuse('HARNESS_UNTESTED', `${parsed.harness} ${version ?? '(version unreadable)'}: BMN has not tested how this version picks its destination`)
    }
    note(`${parsed.harness} ${version ?? '(version unreadable)'}: ${versionState}`)

    const lowReasons = lowSecurityReasons(agent, data)
    const security = lowReasons.length === 0 ? 'high' : 'low'
    note(`effective security ${security}${lowReasons.length ? ` (${lowReasons.join('; ')})` : ''}`)

    let stdin = null
    if (inputs.stdin !== undefined) {
      const path = isAbsolute(inputs.stdin) ? inputs.stdin : `${cwd}/${inputs.stdin}`
      try {
        stdin = { path: realpathSync(path), sha256: hashFile(realpathSync(path)) }
      } catch {
        refuse(inputs.packet !== undefined ? 'PACKET_INVALID' : 'WORKSPACE_MISMATCH', `--stdin ${inputs.stdin} cannot be read`)
      }
    }
    let manifest = null
    if (security === 'low') {
      if (parsed.harness !== 'claude') refuse('ROUTE_UNSUPPORTED', `a Low dispatch goes only through a packet to claude -p, not ${parsed.harness}`)
      if (effectiveData === 'private') refuse('DATA_FORBIDDEN', `private work never goes to a Low route (${lowReasons.join('; ')})`)
      if (packetMissing) refuse('PACKET_INVALID', `--packet ${inputs.packet} is not an existing directory`)
      if (packet === null) refuse('PACKET_INVALID', 'a Low route receives public work only in packet mode (--packet)')
      if (parsed.envMode !== 'clean') refuse('PACKET_INVALID', 'packet mode needs env -i')
      if (!parsed.safeMode) refuse('PACKET_INVALID', 'packet mode needs --safe-mode')
      if (parsed.tools !== '') refuse('PACKET_INVALID', "packet mode needs --tools ''")
      if (parsed.addDir.length > 0) refuse('PACKET_INVALID', 'packet mode allows no --add-dir')
      if (parsed.settings !== undefined) refuse('PACKET_INVALID', 'packet mode allows no --settings')
      if (parsed.mcpConfig !== undefined) {
        let servers = null
        try {
          servers = JSON.parse(parsed.mcpConfig)?.mcpServers
        } catch {
          servers = null
        }
        if (servers === null || typeof servers !== 'object' || Object.keys(servers).length > 0) refuse('PACKET_INVALID', 'packet mode allows only an empty --mcp-config')
      }
      if (!inside(cwd, packet)) refuse('PACKET_INVALID', 'packet mode runs from inside the packet')
      if (stdin === null || !inside(stdin.path, packet)) refuse('PACKET_INVALID', '--stdin must name the prompt file inside the packet')
      if (parsed.appendSystemPrompt !== undefined && parsed.appendSystemPrompt !== (typeof restrictedRules === 'function' ? restrictedRules() : restrictedRules)) {
        refuse('PACKET_INVALID', '--append-system-prompt must be the restricted rules rendering or absent')
      }
      if (label.label !== 'public') refuse('PACKET_INVALID', 'the workspace whose files the packet carries must be labelled public')
      manifest = packetManifest(packet)
      const prompt = relative(packet, stdin.path).split(sep).join('/')
      for (const file of manifest) {
        if (file.name === prompt) continue
        const blob = headBlob(workspace, file.name)
        if (blob === null || sha256(blob) !== file.sha256) {
          refuse('PACKET_INVALID', `${file.name} is not byte-identical to a tracked file at HEAD of ${workspace}`)
        }
      }
      note(`packet ${packet}: ${manifest.length} file(s); the prompt is lead-authored, not verified`)
    } else if (packetMissing) {
      refuse('PACKET_INVALID', `--packet ${inputs.packet} is not an existing directory`)
    } else if (packet !== null) {
      manifest = packetManifest(packet)
    }

    let rosterFileHash = null
    try {
      rosterFileHash = sha256(readText(rosterPath()))
    } catch {
      rosterFileHash = null
    }
    const body = {
      version: 1, verdict: 'PASS', agent: agent.id, harness: parsed.harness, model: model.value, role: role.id, effort: effort.value,
      workspace, cwd, label: { value: label.label, source: label.source }, data: effectiveData, security,
      argv_sha256: sha256(canonicalJson(inputs.argv)),
      harness_version: { version, state: versionState },
      route: { provider: route.provider, host: route.host, basis: route.basis, sources: route.sources },
      generation: { number: generation.number, hash: generation.hash },
      roster_file_hash: rosterFileHash,
      ...(resume ? { resume: { session_id: resume.session_id, original_receipt_hash: resume.original_receipt_hash, original_receipt: resume.original_receipt } } : {}),
      ...(packet !== null ? { packet: { path: packet, manifest, prompt: 'lead-authored, not verified' } } : {}),
      ...(stdin !== null ? { stdin } : {}),
      issued_at: now.toISOString()
    }
    return { verdict: 'PASS', receipt: { ...body, receipt_hash: receiptHash(body) }, steps }
  } catch (error) {
    if (error instanceof Refusal) {
      return { verdict: 'REFUSED', code: error.code, message: error.message, next: NEXT_STEP[error.code], steps }
    }
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

function evaluateReceipt(receipt, argv, options) {
  return evaluate({
    agent: receipt.agent, role: receipt.role, workspace: receipt.workspace, data: receipt.data, cwd: receipt.cwd, argv,
    ...(receipt.stdin ? { stdin: receipt.stdin.path } : {}),
    ...(receipt.packet ? { packet: receipt.packet.path } : {}),
    ...(receipt.resume ? { resumeOf: receipt.resume.original_receipt } : {})
  }, { ...options, now: new Date(receipt.issued_at) })
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

export function inspectRoute(agent, argv, environment, processCwd) {
  if (agent.harness === 'opencode') return { ...inspectOpenCode(environment), harness: 'opencode', inspection_only: true }
  if (agent.harness === 'cursor') return { harness: 'cursor', basis: 'unknown', provider: null, host: null, reason: 'Cursor reports no destination BMN can read', sources: [], inspection_only: true }
  const parsed = argv === null
    ? (agent.harness === 'codex' ? { harness: 'codex', command: 'codex', envMode: 'inherit', assignments: {}, config: [] } : { harness: 'claude', command: 'claude', envMode: 'inherit', assignments: {}, addDir: [] })
    : parseDispatch(argv)
  if (parsed.unsupported) return { harness: agent.harness, unsupported: parsed.unsupported }
  const resolution = parsed.harness === 'codex' ? resolveCodexRoute(parsed, environment) : resolveClaudeRoute(parsed, environment, processCwd)
  if (resolution.unsupported) return { harness: parsed.harness, unsupported: resolution.unsupported }
  const version = harnessVersion(parsed.command, dispatchEnvironment(parsed, environment))
  return {
    harness: parsed.harness, ...resolution.route,
    model: resolution.model?.value ?? null, effort: resolution.effort?.value ?? null,
    version, version_tested: version !== null && (TESTED_HARNESS_VERSIONS[parsed.harness] ?? []).includes(version)
  }
}

// ---------------------------------------------------------------------------------------------
// CLI

const CHECK_VALUES = ['agent', 'role', 'workspace', 'data', 'cwd', 'stdin', 'packet', 'resume-of', 'verify']

/** Read only when a packet dispatch carries --append-system-prompt, so other checks never open the master. */
function restrictedClaudeRules() {
  try {
    return restrictedRendering('claude')
  } catch {
    return null
  }
}

export async function runCheckCommand(action, argv) {
  let parsed
  try {
    parsed = readOptions(argv, action === 'route' ? { flags: ['json'], values: ['agent'] } : { flags: ['json'], values: CHECK_VALUES })
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
      const result = verifyReceipt(options.verify, parsed.rest, { restrictedRules: restrictedClaudeRules })
      if (asJson) out(JSON.stringify({ ok: result.ok, ...(result.ok ? {} : { code: 'RECEIPT_INVALID', reason: result.reason }) }, null, 2))
      else out(result.ok ? 'Receipt verified: the same check passes with the same inputs.' : `bmn: RECEIPT_INVALID: ${result.reason}`)
      return result.ok ? 0 : EXIT.RECEIPT_INVALID
    }
    for (const name of ['agent', 'role', 'workspace', 'data']) {
      if (options[name] === undefined) throw new AgentsUsageError(`roster ${action} requires --${name}`)
    }
    if (!['private', 'public'].includes(options.data)) throw new AgentsUsageError('--data must be private or public')
    if (parsed.rest === null || parsed.rest.length === 0) throw new AgentsUsageError(`roster ${action} requires -- <dispatch argv>`)
    const result = evaluate({
      agent: options.agent, role: options.role, workspace: options.workspace, data: options.data, argv: parsed.rest,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.packet !== undefined ? { packet: options.packet } : {}), ...(options['resume-of'] !== undefined ? { resumeOf: options['resume-of'] } : {})
    }, { restrictedRules: restrictedClaudeRules })
    if (action === 'explain') {
      const lines = result.steps.map((step) => `  ${step}`)
      lines.push(result.verdict === 'PASS' ? 'PASS: this dispatch may proceed.' : `REFUSED ${result.code}: ${result.message}\nNext: ${result.next}`)
      if (asJson) out(JSON.stringify({ verdict: result.verdict, steps: result.steps, ...(result.verdict === 'PASS' ? {} : { code: result.code, message: result.message, next: result.next }) }, null, 2))
      else out(lines.join('\n'))
      return result.verdict === 'PASS' ? 0 : EXIT.refusal
    }
    if (result.verdict === 'PASS') {
      out(asJson ? JSON.stringify(result.receipt, null, 2) : `PASS ${result.receipt.agent} ${result.receipt.role} -> ${result.receipt.route.host} (${result.receipt.data}, ${result.receipt.security}); receipt ${result.receipt.receipt_hash.slice(0, 12)}`)
      return 0
    }
    if (asJson) out(JSON.stringify({ verdict: 'REFUSED', code: result.code, message: result.message, next: result.next }, null, 2))
    else out(`REFUSED ${result.code}: ${result.message}\nNext: ${result.next}`)
    return EXIT.refusal
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    return failWith(error, asJson)
  }
}

function routeCommand(options, rest, asJson) {
  if (options.agent === undefined) throw new AgentsUsageError('roster route requires --agent')
  const generation = readApproved()
  const agent = generation.data.agents.find((candidate) => candidate.id === options.agent)
  if (agent === undefined) throw new RosterError('UNKNOWN_AGENT', `no agent ${options.agent} in approved generation ${generation.number}`)
  const result = inspectRoute(agent, rest, process.env, process.cwd())
  if (asJson) {
    out(JSON.stringify({ agent: agent.id, inspection_only: true, ...result }, null, 2))
  } else {
    const lines = [`${agent.id} (${result.harness}); inspection only, never an authorization`]
    if (result.unsupported) lines.push(`  unsupported: ${result.unsupported}`)
    else {
      lines.push(`  destination: ${result.host ?? 'unknown'} (${result.basis}${result.reason ? `: ${result.reason}` : ''})`)
      lines.push(`  decided by: ${result.sources?.length ? result.sources.join(', ') : 'defaults only'}`)
      if (result.model) lines.push(`  model: ${result.model}`)
      if (result.version !== undefined) lines.push(`  ${result.harness} ${result.version ?? '(version unreadable)'}: ${result.version_tested ? 'tested' : 'BMN has not tested how this version picks its destination'}`)
    }
    out(lines.join('\n'))
  }
  return result.unsupported ? EXIT.refusal : 0
}

