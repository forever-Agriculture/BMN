// MODULE: agents-check.mjs - Epic 60.3: `bmn roster check|explain|route|visibility|bind`, the fail-closed check before work leaves for another agent
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { APP_NAMES, DESIGNER_ROLE, LEAD_ROLE, RosterError, agentState, canonicalJson, classRefusal, resolvedDirectory, rosterPath, sha256 } from './agents-roster.mjs'
import { readApproved, stateDirectory } from './agents-state.mjs'
import { AgentsUsageError, EXIT, failWith, out, readOptions, usage } from './agents-cli.mjs'
import { publicRendering } from './agents-rules.mjs'

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
export const REFUSALS = ['UNKNOWN_AGENT', 'PROPOSED', 'DISABLED', 'ROLE_UNKNOWN', 'ROLE_INELIGIBLE', 'CLASS_CANNOT_LEAD', 'CLASS_CANNOT_DESIGN',
  'ROUTE_UNSUPPORTED', 'MODEL_MISMATCH', 'EFFORT_UNSUPPORTED', 'CONTEXT_MISMATCH', 'TOOL_MISMATCH', 'HOST_UNKNOWN', 'HOST_MISMATCH',
  'WORKSPACE_UNKNOWN', 'WORKSPACE_MISMATCH', 'RESUME_UNBOUND', 'HARNESS_UNTESTED', 'DATA_FORBIDDEN', 'PACKET_INVALID']

/** Harness versions whose destination precedence BMN's tests were written against (Epic 60 spike, 2026-10-09). */
export const TESTED_HARNESS_VERSIONS = { codex: ['0.161.0'], claude: ['2.1.295'] }
/**
 * Codex versions on which a test showed that `exec resume` talks to the destination the current
 * configuration resolves, not one saved with the session (60.3 AC8). A resume on any other
 * version is ROUTE_UNSUPPORTED.
 */
export const RESUME_TESTED_VERSIONS = { codex: [] }
/** Claude Code versions whose research fence an owner-authorized test verified (60.10 AC2): none yet. */
export const RESEARCH_FENCE_VERSIONS = { claude: [] }
/** A visibility record older than this proves nothing (60.3 AC5). */
export const VISIBILITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** A session is bound to its receipt only this soon after the check (60.3 AC8). */
export const BINDING_WINDOW_MS = 10 * 60 * 1000

const NEXT_STEP = {
  UNKNOWN_AGENT: 'name an agent from `bmn team --all`',
  PROPOSED: 'the owner activates this agent in Preferences > Team first',
  DISABLED: 'pick the next candidate from `bmn roster role <role>`',
  ROLE_UNKNOWN: 'name a role from the roster\'s ## roles',
  ROLE_INELIGIBLE: 'pick a candidate that holds this role (`bmn roster role <role>`)',
  CLASS_CANNOT_LEAD: 'only a knight leads; pick one',
  CLASS_CANNOT_DESIGN: 'only a queen designs; pick one',
  ROUTE_UNSUPPORTED: 'use a dispatch form BMN checks (`codex exec … -` or `claude -p`), exactly as documented',
  MODEL_MISMATCH: 'pass the agent\'s own model or an approved alias',
  EFFORT_UNSUPPORTED: 'pass an effort the agent lists',
  CONTEXT_MISMATCH: 'pass the context limit `bmn roster role --json` gives for this agent',
  TOOL_MISMATCH: 'pass exactly the tools `bmn roster role --json` gives for this agent',
  HOST_UNKNOWN: 'make the destination knowable (no unresolved base URL) or record the host in the roster',
  HOST_MISMATCH: 'dispatch to the host the roster approved, or have the owner approve the new host',
  WORKSPACE_UNKNOWN: 'pass an existing workspace path without ..',
  WORKSPACE_MISMATCH: 'run from, and point -C/--add-dir and --stdin at, a place inside the workspace (or the packet)',
  RESUME_UNBOUND: 'resume only with --resume-of the receipt that started that session and was bound to it, or start a fresh checked dispatch',
  HARNESS_UNTESTED: 'use a tested app version, or have the owner accept this one in Preferences > Rules > Health',
  DATA_FORBIDDEN: 'move to the next candidate in the role\'s chain (`bmn roster role <role>`); this provider gets public work only',
  PACKET_INVALID: 'build a packet of files the public repository already serves and dispatch it through env -i claude -p --safe-mode --tools \'\''
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
 * The workspace a directory belongs to: its Git top-level (the nearest folder holding `.git`), or
 * the directory itself outside Git. A nested repository has its own top-level, so an exception for
 * the outer one never covers it (60.8 AC6). `directory` is canonical already.
 */
export function workspaceRoot(directory) {
  let current = directory
  for (;;) {
    const marker = join(current, '.git')
    traceRead?.(marker)
    try {
      lstatSync(marker)
      return current
    } catch {
      // Not a repository top-level; look one folder up.
    }
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

function git(workspace, args, options = {}) {
  return execFileSync('git', ['-C', workspace, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 * 1024 * 1024, ...options })
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
 * owner-declared destination is public work only and no exception applies to it.
 */
export function privateWorkAnswer(data, destination, root) {
  const provider = data.providers.find((entry) => entry.id === destination.provider)
  const answer = provider?.private_work ?? 'public_only'
  const name = provider?.name ?? destination.provider
  if (destination.basis === 'owner-declared') return { allowed: false, answer, reason: `the destination is owner-declared, not inspected, so ${name} gets public work only` }
  if (answer === 'allowed') return { allowed: true, answer, reason: `${name} may see private work` }
  const exception = root === null ? undefined
    : data.exceptions.find((entry) => entry.provider === destination.provider && resolvedDirectory(entry.folder) === root)
  if (exception !== undefined) return { allowed: true, answer, exception: { id: exception.id, scope: 'this workspace' }, reason: `${name} is allowed in this workspace (exception ${exception.id})` }
  return { allowed: false, answer, reason: `${name} gets public work only` }
}

/** Why an agent could not receive private work in a workspace without an exception (empty when it could). */
export function publicOnlyReasons(agent, data) {
  const reasons = []
  const provider = data.providers.find((entry) => entry.id === agent.provider)
  const route = data.harness_routes.find((entry) => entry.harness === agent.harness)
  if (agent.harness !== 'claude' && agent.harness !== 'codex') reasons.push(`BMN cannot check ${APP_NAMES[agent.harness] ?? agent.harness} dispatches`)
  if (agent.host === null) reasons.push(`${agent.id}'s host is unknown`)
  if (agent.host === 'default' && route === undefined) reasons.push(`no approved destination for ${APP_NAMES[agent.harness] ?? agent.harness}`)
  if (agent.host === 'default' && route?.basis === 'owner-declared') reasons.push(`the ${APP_NAMES[agent.harness] ?? agent.harness} destination is owner-declared`)
  if (provider?.private_work !== 'allowed') reasons.push(`${provider?.name ?? agent.provider} gets public work only`)
  return reasons
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

/** Finds `<sessions>/YYYY/MM/DD/rollout-*-<id>.jsonl` and returns its first-line metadata. */
function sessionRecord(codexHome, id) {
  if (!SESSION_ID.test(id) || codexHome === null) return null
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

// ---------------------------------------------------------------------------------------------
// Session bindings (60.3 AC8): which receipt started which Codex session

const SESSION_ID = /^[0-9a-f-]{8,64}$/i

export function bindingPath(receiptHashValue) {
  return `${stateDirectory()}/bindings/${receiptHashValue}.json`
}

/**
 * Records that the dispatch a receipt checked started `sessionId`. Accepted once per receipt and
 * only within 10 minutes of the receipt's `issued_at`; a later resume passes only for that session.
 */
export function bindSession(receiptFile, sessionId, { now = new Date() } = {}) {
  const receipt = readReceiptFile(receiptFile)
  if (receipt === null) throw new RosterError('RECEIPT_INVALID', `${receiptFile} is not an intact version-1 receipt`)
  if (receipt.mode !== 'dispatch' || receipt.harness !== 'codex') throw new RosterError('RECEIPT_INVALID', 'only the receipt of a Codex dispatch can be bound to a session')
  if (!SESSION_ID.test(sessionId)) throw new RosterError('RECEIPT_INVALID', `${sessionId} is not a Codex session id`)
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
      name: agent.name, active, provider: agent.provider,
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
    if (!a.active && b.active) out.push(`${name(id)} could be given work`)
    if (a.active && !b.active) out.push(`${name(id)} could no longer be given work`)
    if (!a.lead && b.lead) out.push(`${name(id)} could lead`)
    if (a.lead && !b.lead) out.push(`${name(id)} could no longer lead`)
    if (!a.design && b.design) out.push(`${name(id)} could design`)
    if (a.design && !b.design) out.push(`${name(id)} could no longer design`)
    if (!explained.has(id)) {
      if (!a.private && b.private) out.push(`${name(id)} could receive private work`)
      if (a.private && !b.private) out.push(`${name(id)} could no longer receive private work`)
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
  }
  for (const role of prior.roles) if (!after.roles.some((entry) => entry.id === role.id)) out.push(`the ${role.id} role would be removed`)
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
    const app = APP_NAMES[route.harness] ?? route.harness
    const previous = oldRoutes.get(route.harness)
    if (previous !== undefined && (previous.provider !== route.provider || previous.basis !== route.basis)) {
      out.push(route.basis === 'owner-declared'
        ? `${app} would count as sending data to ${providerName(route.provider)} on your word, so it gets public work only`
        : `${app} would count as sending data to ${providerName(route.provider)}, as inspected`)
    }
    const added = (route.accepted_versions ?? []).filter((version) => !(previous?.accepted_versions ?? []).includes(version))
    for (const version of added) out.push(`${app} ${version} could carry private work (accepted by you; BMN has not tested how this version picks its destination)`)
    const revoked = (previous?.accepted_versions ?? []).filter((version) => !(route.accepted_versions ?? []).includes(version))
    for (const version of revoked) out.push(`${app} ${version} could no longer carry private work (acceptance removed)`)
  }
  return [...new Set(out)]
}

// ---------------------------------------------------------------------------------------------
// Evaluating a dispatch

/** The approved agent a check is about, or the first refusal that applies to it. */
function activeAgent(generation, id) {
  const agent = generation.data.agents.find((candidate) => candidate.id === id)
  if (agent === undefined) refuse('UNKNOWN_AGENT', `no agent ${id} in approved version ${generation.number}`)
  const state = agentState(agent)
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

function versionStanding(data, harness, version, tested = TESTED_HARNESS_VERSIONS) {
  const approved = data.harness_routes.find((entry) => entry.harness === harness)
  const isTested = version !== null && (tested[harness] ?? []).includes(version)
  const accepted = !isTested && version !== null && (approved?.accepted_versions ?? []).includes(version)
  return { tested: isTested, accepted, state: isTested ? 'tested' : accepted ? 'owner-accepted, untested' : 'untested' }
}

function rosterFileHash() {
  try {
    return sha256(readText(rosterPath()))
  } catch {
    return null
  }
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
  testedVersions = TESTED_HARNESS_VERSIONS, resumeVersions = RESUME_TESTED_VERSIONS
} = {}) {
  const steps = []
  const note = (text) => steps.push(text)
  try {
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
    if (agent.harness !== parsed.harness) {
      refuse('ROUTE_UNSUPPORTED', agent.harness === 'opencode' || agent.harness === 'cursor'
        ? `BMN does not check ${APP_NAMES[agent.harness]} dispatches` : `${agent.id} runs on ${agent.harness}, the command is ${parsed.harness}`)
    }
    const cwd = canonicalDirectory(inputs.cwd ?? processCwd, processCwd)
    const resolution = parsed.harness === 'codex'
      ? resolveCodexRoute(parsed, environment)
      : resolveClaudeRoute(parsed, environment, cwd ?? processCwd)
    if (resolution.unsupported) refuse('ROUTE_UNSUPPORTED', resolution.unsupported)
    const version = harnessVersion(parsed.command, dispatchEnvironment(parsed, environment))
    if (parsed.resume && !(version !== null && (resumeVersions[parsed.harness] ?? []).includes(version))) {
      refuse('ROUTE_UNSUPPORTED', `resume is not checked on ${parsed.harness} ${version ?? '(version unreadable)'}: BMN has not tested that a resume on this version talks to the current configuration's destination; start a fresh checked dispatch`)
    }
    note(`dispatch form: ${parsed.envMode === 'clean' ? 'env -i ' : ''}${parsed.harness === 'codex' ? `codex exec${parsed.resume ? ' resume' : ''}` : 'claude -p'}`)

    const { model, effort } = checkModelAndEffort(agent, resolution, note)
    const route = resolution.route
    const destination = matchedDestination(data, agent, parsed.harness, route, note)

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
    const answer = privateWorkAnswer(data, destination, workspaceRoot(workspace))
    note(`private work: ${answer.reason}`)
    const visibility = workspaceVisibility(workspace, now)
    const dataLabel = stricter(visibility.public ? 'public' : 'private', inputs.data)
    note(`workspace ${workspace}: ${visibility.public ? `public (${visibility.reason})` : `private (${visibility.reason})`}; data ${dataLabel}`)
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

    const standing = versionStanding(data, parsed.harness, version, testedVersions)
    if (effectiveData === 'private' && !standing.tested && !standing.accepted) {
      refuse('HARNESS_UNTESTED', `${parsed.harness} ${version ?? '(version unreadable)'}: BMN has not tested how this version picks its destination`)
    }
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
      role: role.id, effort: effort.value, context_limit_applied: null,
      workspace, cwd,
      public_status: { public: visibility.public, reason: visibility.reason, ...(visibility.public ? { commit: visibility.record.commit } : {}) },
      data: effectiveData,
      argv_sha256: sha256(canonicalJson(inputs.argv)),
      harness_version: { version, state: standing.state },
      route: receiptRoute(destination, route),
      private_work: receiptAnswer(answer),
      generation: { number: generation.number, hash: generation.hash },
      roster_file_hash: rosterFileHash(),
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
/** What a research run's `env -i` may carry: where the app lives, how to find it, and its destination. */
const RESEARCH_ENVIRONMENT = ['HOME', 'PATH', 'ANTHROPIC_BASE_URL']

export function researchRunsDirectory() {
  return `${stateDirectory()}/research/runs`
}

/**
 * The folder BMN makes for one research run: the prompt it wrote, its hash, and an empty folder
 * the app runs in. The check passes a research dispatch only from here with exactly this prompt.
 */
export function prepareResearchRun(prompt, { now = new Date(), id = `${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${sha256(`${prompt}\n${process.pid}\n${now.getTime()}`).slice(0, 8)}` } = {}) {
  const folder = `${researchRunsDirectory()}/${id}`
  ensurePrivateDirectory(`${folder}/cwd`)
  writeState(`${folder}/prompt.md`, prompt)
  writeState(`${folder}/run.json`, `${JSON.stringify({ version: 1, id, prompt_sha256: sha256(prompt), created_at: now.toISOString() })}\n`)
  return { id, folder, prompt: `${folder}/prompt.md`, cwd: `${folder}/cwd` }
}

/** Why `argv` is not exactly the research form, or null when it is. */
function researchFormProblem(parsed) {
  if (parsed.harness !== 'claude') return 'a research run goes only through claude -p'
  if (parsed.envMode !== 'clean') return 'a research run needs env -i'
  const extra = Object.keys(parsed.assignments).filter((key) => !RESEARCH_ENVIRONMENT.includes(key))
  if (extra.length > 0) return `a research run's env -i carries only ${RESEARCH_ENVIRONMENT.join(', ')}, not ${extra.join(', ')}`
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
 * Evaluates a research run: an approved, active agent on a known destination and a tested or
 * accepted app version, the exact fenced argv, run from the empty folder BMN made, fed the prompt
 * BMN wrote. A public-only destination passes only on an app version whose fence was verified.
 */
export function evaluateResearch(inputs, {
  environment = process.env, cwd: processCwd = process.cwd(), now = new Date(),
  testedVersions = TESTED_HARNESS_VERSIONS, fenceVersions = RESEARCH_FENCE_VERSIONS
} = {}) {
  const steps = []
  const note = (text) => steps.push(text)
  try {
    const generation = readApproved()
    const data = generation.data
    note(`approved version ${generation.number}`)
    const agent = activeAgent(generation, inputs.agent)
    note(`agent ${agent.id}: ${agent.class}, ${agent.harness} ${agent.model}, provider ${agent.provider}`)
    const parsed = parseDispatch(inputs.argv)
    if (parsed.unsupported) refuse('ROUTE_UNSUPPORTED', parsed.unsupported)
    if (agent.harness !== parsed.harness) refuse('ROUTE_UNSUPPORTED', `${agent.id} runs on ${agent.harness}, the command is ${parsed.harness}`)
    const form = researchFormProblem(parsed)
    if (form !== null) refuse('ROUTE_UNSUPPORTED', form)
    const cwd = canonicalDirectory(inputs.cwd ?? processCwd, processCwd)
    const resolution = resolveClaudeRoute(parsed, environment, cwd ?? processCwd)
    if (resolution.unsupported) refuse('ROUTE_UNSUPPORTED', resolution.unsupported)
    const version = harnessVersion(parsed.command, dispatchEnvironment(parsed, environment))
    note('dispatch form: env -i claude -p, web tools only')
    const { model, effort } = checkModelAndEffort(agent, resolution, note)
    const route = resolution.route
    const destination = matchedDestination(data, agent, parsed.harness, route, note)

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
    let stdin = null
    try {
      const path = realpathSync(isAbsolute(inputs.stdin) ? inputs.stdin : `${cwd}/${inputs.stdin}`)
      stdin = { path, sha256: hashFile(path) }
    } catch {
      stdin = null
    }
    if (!isObject(record) || stdin === null || stdin.path !== `${run}/prompt.md` || stdin.sha256 !== record.prompt_sha256) {
      refuse('WORKSPACE_MISMATCH', '--stdin must be the research prompt BMN wrote for this run, unchanged')
    }
    note(`research run ${basename(run)}: BMN's prompt, an empty folder`)

    const standing = versionStanding(data, parsed.harness, version, testedVersions)
    if (!standing.tested && !standing.accepted) {
      refuse('HARNESS_UNTESTED', `${parsed.harness} ${version ?? '(version unreadable)'}: BMN has not tested how this version picks its destination`)
    }
    note(`${parsed.harness} ${version}: ${standing.state}`)
    const answer = privateWorkAnswer(data, destination, null)
    note(`private work: ${answer.reason}`)
    if (!answer.allowed && !(fenceVersions[parsed.harness] ?? []).includes(version)) {
      refuse('PACKET_INVALID', `a public-only researcher runs only on an app version whose fence BMN verified; ${parsed.harness} ${version} is not one`)
    }
    const body = {
      version: 1, mode: 'research', verdict: 'PASS', agent: agent.id, class: agent.class, harness: parsed.harness, model: model.value,
      effort: effort.value, context_limit_applied: null, cwd,
      argv_sha256: sha256(canonicalJson(inputs.argv)),
      harness_version: { version, state: standing.state },
      route: receiptRoute(destination, route),
      private_work: receiptAnswer(answer),
      generation: { number: generation.number, hash: generation.hash },
      roster_file_hash: rosterFileHash(),
      stdin,
      issued_at: now.toISOString()
    }
    return { verdict: 'PASS', receipt: { ...body, receipt_hash: receiptHash(body) }, steps }
  } catch (error) {
    if (error instanceof Refusal) {
      return { verdict: 'REFUSED', code: error.code, message: error.message, next: error.code === 'WORKSPACE_MISMATCH' ? 'start the research from BMN (Team, Models), which writes the prompt and the folder' : NEXT_STEP[error.code], steps }
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
  const at = { ...options, now: new Date(receipt.issued_at) }
  if (receipt.mode === 'research') return evaluateResearch({ agent: receipt.agent, cwd: receipt.cwd, stdin: receipt.stdin?.path, argv }, at)
  return evaluate({
    agent: receipt.agent, role: receipt.role, workspace: receipt.workspace, data: receipt.data, cwd: receipt.cwd, argv,
    ...(receipt.stdin ? { stdin: receipt.stdin.path } : {}),
    ...(receipt.packet ? { packet: receipt.packet.path } : {}),
    ...(receipt.resume ? { resumeOf: receipt.resume.original_receipt } : {})
  }, at)
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
    result = { ...inspectOpenCode(environment), harness: 'opencode', inspection_only: true }
  } else if (agent.harness === 'cursor') {
    result = { harness: 'cursor', basis: 'unknown', provider: null, host: null, reason: 'Cursor reports no destination BMN can read', sources: [], inspection_only: true }
  } else {
    const parsed = argv === null
      ? (agent.harness === 'codex' ? { harness: 'codex', command: 'codex', envMode: 'inherit', assignments: {}, config: [] } : { harness: 'claude', command: 'claude', envMode: 'inherit', assignments: {}, addDir: [] })
      : parseDispatch(argv)
    if (parsed.unsupported) return { harness: agent.harness, unsupported: parsed.unsupported }
    const resolution = parsed.harness === 'codex' ? resolveCodexRoute(parsed, environment) : resolveClaudeRoute(parsed, environment, processCwd)
    if (resolution.unsupported) return { harness: parsed.harness, unsupported: resolution.unsupported }
    const version = harnessVersion(parsed.command, dispatchEnvironment(parsed, environment))
    result = {
      harness: parsed.harness, ...resolution.route,
      model: resolution.model?.value ?? null, effort: resolution.effort?.value ?? null,
      version, version_tested: version !== null && (TESTED_HARNESS_VERSIONS[parsed.harness] ?? []).includes(version)
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
        : `PASS ${receipt.agent} ${receipt.role ?? 'research'} -> ${receipt.route.host} (${receipt.data ?? 'research'}, private work ${receipt.private_work.allowed ? 'allowed' : 'not allowed'}); receipt ${receipt.receipt_hash.slice(0, 12)}`)
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
      if (result.version !== undefined) lines.push(`  ${result.harness} ${result.version ?? '(version unreadable)'}: ${result.version_tested ? 'tested' : 'BMN has not tested how this version picks its destination'}`)
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
