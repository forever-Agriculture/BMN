// MODULE: agents-check-argv.mjs - the dispatch check (Epic 60.3) behind agents-check.mjs: dispatch argv for Codex, Claude Code and OpenCode, and the named Codex configuration keys
import { basename } from 'node:path'
import { retiredProgram, retiredWords } from './agents-roster.mjs'
import { CODEX_CONTEXT_KEYS, wholeNumber } from './agents-context.mjs'

export { CODEX_ACCESS_KEYS, CODEX_NEUTRAL_KEYS, CODEX_ROUTE_KEYS, dispatchEnvironment, harnessOf, parseOpenCode, tomlKeyPath, unquoteToml }

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
