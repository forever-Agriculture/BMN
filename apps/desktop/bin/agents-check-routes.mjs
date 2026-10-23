// MODULE: agents-check-routes.mjs - the dispatch check (Epic 60.3) behind agents-check.mjs: where a dispatch really goes: Claude Code, Codex and OpenCode routes, limits and OpenCode files
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { parseYaml } from './agents-roster.mjs'
import { CLAUDE_CONTEXT_KEY, CLAUDE_TEST_ARGUMENTS, CODEX_CONTEXT_KEYS, CONTEXT_TEST_SIZE, checkContext, contextItems, contextTestFolder, provenControls, provenPrecedence, wholeNumber } from './agents-context.mjs'
import { OPENCODE_ASK_AGENTS, OPENCODE_HELPER_AGENT, openCodeEnvironment, openCodeFolder, openCodeFolderProblem, openCodeFolders, openCodeManagedProblem } from './agents-opencode.mjs'
import { Refusal, optionalNames, optionalText, traceRead } from './agents-check-base.mjs'
import { CODEX_ACCESS_KEYS, CODEX_NEUTRAL_KEYS, CODEX_ROUTE_KEYS, dispatchEnvironment, parseDispatch, readCodexConfig, tomlKeyPath, unquoteToml } from './agents-check-argv.mjs'
import { isObject, spellings } from './shared-helpers.mjs'

export { inspectOpenCode }

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
  const managed = openCodeManagedProblem()
  if (managed !== null) return { unsupported: managed }
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
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    try {
      statSync(`/etc/opencode/${name}`)
      return unknown('OpenCode also reads managed configuration; its effective model is unknown', ['managed configuration'])
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return unknown('OpenCode managed configuration could not be inspected', ['managed configuration'])
    }
  }
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
