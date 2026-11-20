// MODULE: agents-check-routes.mjs - the dispatch check (Epic 60.3) behind agents-check.mjs: where a dispatch really goes: Claude Code and Codex routes and limits
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { CLAUDE_CONTEXT_KEY, CLAUDE_TEST_ARGUMENTS, CODEX_CONTEXT_KEYS, OWN_CONTEXT_SOURCE, checkContext, contextItems, contextTestFolder, provenControls, provenPrecedence, wholeNumber } from './agents-context.mjs'
import { optionalNames, optionalText } from './agents-check-base.mjs'
import { CODEX_ACCESS_KEYS, CODEX_NEUTRAL_KEYS, CODEX_ROUTE_KEYS, dispatchEnvironment, parseDispatch, readCodexConfig, tomlKeyPath, unquoteToml } from './agents-check-argv.mjs'
import { isObject, spellings } from './shared-helpers.mjs'

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
    } else if (parsed.askProfile === true && (entry.startsWith('default_permissions=') || keys[0] === 'permissions')) {
      // BMN's own built ask (102.7): the team-ask check compares its whole command, and the profile says what it reads, never where it goes.
      continue
    } else if (entry === 'features.plugins=false' || entry === 'features.apps=false') {
      // Fixed ask/research tool isolation switches; no other feature setting becomes neutral.
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
 * The other sources that would name a context size for a test of this app run from `folder`, each by
 * its identity and its size (60.9 AC2, 63.1 AC3). Only Claude Code reads a size from more than one place.
 */
export function contextTestSources(harness, environment, folder) {
  if (harness !== 'claude') return []
  const sizes = resolveClaudeRoute(parseDispatch(['claude', ...CLAUDE_TEST_ARGUMENTS]), environment, folder).context?.sizes ?? []
  return sizes.filter((entry) => !entry.id.startsWith(OWN_CONTEXT_SOURCE)).map((entry) => ({ source: entry.source, id: entry.id, value: entry.value }))
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
  const argv = agent.harness === 'codex' ? ['codex', 'exec', ...items.argv, '-'] : ['env', '-i', `HOME=${environment.HOME ?? homedir()}`, ...items.env, 'claude', '-p', ...items.argv]
  const parsed = parseDispatch(argv)
  const resolution = agent.harness === 'codex' ? resolveCodexRoute(parsed, environment, cwd) : resolveClaudeRoute(parsed, environment, cwd)
  const result = checkContext(agent, resolution.context, proven, provenPrecedence(agent.harness, version, tests))
  return result.refusal ? { state: 'refused', reason: result.refusal } : { state: 'applied' }
}
