// MODULE: agents-context.mjs - Stories 60.9 and 63.1: context limits that reach the agent: each app's settings, the test that proves them for a version (run by the owner, or by BMN for a new version), the items a dispatch carries, and the default for the owner's own sessions
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { APP_NAMES, RosterError, agentState, agentsDirectory, appName, sha256 } from './agents-roster.mjs'
import { absoluteUncollapsed, jsonIndent, pathState, replaceFileSafely, resolvedPath } from './safe-config-write.mjs'
import { unifiedDiff } from './text-diff.mjs'

/**
 * An agent's `context_limit` is how large its conversation may grow; `compact_at` is where the app
 * starts summarising it. Each app has its own setting for that, and BMN uses one only on an app
 * version where the owner's test showed that the setting does what BMN thinks (60.9 AC1). Until
 * then the limit is "not supported yet" there: never written, never passed, never required.
 *
 * Codex: `model_context_window` and `model_auto_compact_token_limit`, as `-c` items on a dispatch
 * and as top-level keys of config.toml for the owner's own sessions.
 * Claude Code: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100 000 to 1 000 000), the size it keeps a
 * conversation within, in the dispatch environment and as an `env` entry of settings.json. Claude
 * Code 2.1.296 reads `CLAUDE_CODE_MAX_CONTEXT_TOKENS` only for a model it does not know or with
 * compaction off, so BMN does not use it. It has no separate setting for where summarising starts.
 */
export const CONTEXT_CONTROLS = {
  codex: {
    command: 'codex',
    limit: { form: 'argv', key: 'model_context_window' },
    compact: { form: 'argv', key: 'model_auto_compact_token_limit' }
  },
  claude: {
    command: 'claude',
    limit: { form: 'env', key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', min: 100_000, max: 1_000_000 },
    compact: null
  }
}
export const CONTEXT_APPS = Object.keys(CONTEXT_CONTROLS)
/** The Codex keys BMN reads and writes for a context limit, the window first. */
export const CODEX_CONTEXT_KEYS = [CONTEXT_CONTROLS.codex.limit.key, CONTEXT_CONTROLS.codex.compact.key]
export const CLAUDE_CONTEXT_KEY = CONTEXT_CONTROLS.claude.limit.key
/** What the owner-run test asks each app for: a size no default equals, so seeing it back proves the setting. */
export const CONTEXT_TEST_SIZE = { codex: 123_000, claude: 137_000 }
/** Claude Code's report rounds its window, so the test takes a size within one percent of the one asked for as that size. */
const reportedAs = (asked, size) => Math.abs(size - asked) <= asked * 0.01

export class ContextError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ContextError'
    this.code = code
  }
}

function thousands(value) {
  return String(value).replace(/\B(?=(\d{3})+$)/g, ' ')
}

/** A whole number of tokens as TOML or an environment value writes it, or null. */
export function wholeNumber(raw) {
  const text = String(raw).trim().replace(/^"(.*)"$|^'(.*)'$/, (_all, double, single) => double ?? single)
  if (!/^\+?\d[\d_]*$/.test(text)) return null
  const value = Number(text.replace(/[+_]/g, ''))
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

// ---------------------------------------------------------------------------------------------
// Which settings are proven for a version (60.9 AC1)

export function contextTestsPath() {
  return `${agentsDirectory()}/state/context-tests.jsonl`
}

/** Every recorded test, oldest first; a line BMN cannot read is skipped, never guessed. */
export function contextTests() {
  let text
  try {
    text = readFileSync(contextTestsPath(), 'utf8')
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

/** The last test of one app, whatever version it ran against, or null. */
export function lastContextTest(harness, tests = contextTests()) {
  let last = null
  for (const entry of tests) if (entry.harness === harness) last = entry
  return last
}

/** The latest test of exactly this version of an app, or null. */
function latestOf(harness, version, tests) {
  if (typeof version !== 'string') return null
  let last = null
  for (const entry of tests) if (entry.harness === harness && entry.version === version) last = entry
  return last
}

/**
 * Which of an app's settings a test proved on exactly this version. The latest test of that version
 * decides, so a later failure takes an earlier pass away. `standing` says how that version stands:
 * the latest test's outcome, `untested` with none, or `unknown` where the version could not be read.
 */
export function provenControls(harness, version, tests = contextTests()) {
  const controls = CONTEXT_CONTROLS[harness]
  if (controls === undefined || typeof version !== 'string') return { limit: false, compact: false, standing: 'unknown' }
  const last = latestOf(harness, version, tests)
  return { limit: last?.limit === 'pass', compact: controls.compact !== null && last?.compact === 'pass', standing: last?.limit ?? 'untested' }
}

/**
 * What the owner's test showed, on exactly this version, about two sources naming different sizes:
 * each other source the run's own environment value won over, by its identity, and whether that
 * source's size was above or below it (60.9 AC2). Only what was seen counts: another file, the same
 * file playing another part, or a smaller size where a larger one lost, is not shown. A test in
 * which any other source named a size the app's report could not tell from the one asked for shows
 * nothing at all, because that source may be the one the app obeyed; so does a record BMN cannot
 * read in full. The latest test of the version decides whether anything is shown: a test that did
 * not pass, or one that shows nothing, takes every earlier one away. Passing tests of that version
 * that follow one another without such a break each add what they saw, so a set of sources tested
 * once stays shown while the owner's files change and change back (63.1 AC3).
 */
export function provenPrecedence(harness, version, tests = contextTests()) {
  if (typeof version !== 'string') return []
  const proofs = []
  const all = tests.filter((entry) => entry.harness === harness && entry.version === version)
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const shown = shownBy(all[index])
    if (shown === null) break
    for (const proof of shown) if (!proofs.some((known) => known.id === proof.id && known.side === proof.side)) proofs.push(proof)
  }
  return proofs
}

/** What one test shows about the sources it met, or null where it shows nothing: it did not pass, or cannot be read in full, or a source's size could not be told from the one asked for. */
function shownBy(test) {
  if (test?.limit !== 'pass' || !Array.isArray(test.rivals) || !Number.isSafeInteger(test.asked)) return null
  if (!Number.isSafeInteger(test.observed) || !reportedAs(test.asked, test.observed)) return null
  const clear = (rival) => typeof rival?.id === 'string' && Number.isSafeInteger(rival?.value) && !reportedAs(test.asked, rival.value)
  if (!test.rivals.every(clear)) return null
  return test.rivals.map((rival) => ({ id: rival.id, side: rival.value > test.asked ? 'above' : 'below' }))
}

// ---------------------------------------------------------------------------------------------
// What a dispatch carries (60.9 AC2)

/**
 * Why an app's setting is not used on a version, said so that the reader knows who acts next (63.1 AC6):
 * BMN by itself, or the owner once its test failed (Story 75.8 took the switch that turned BMN's own testing off).
 */
function untestedReason(app, harness, standing) {
  const command = `bmn context test ${harness}`
  if (standing === 'fail') return `the context test failed on this ${app} version, so the setting is not used (${command} runs it again)`
  if (standing === 'inconclusive' || standing === 'unavailable') {
    return `the context test showed nothing on this ${app} version; BMN tries it again by itself, up to three times`
  }
  if (standing === 'unknown') return `the ${app} version cannot be read, so its context setting counts as not tested`
  return `the context setting is not tested on this ${app} version yet; BMN tests it by itself when it starts, when Rules > Health is read and after an update there`
}

/**
 * The items that apply an agent's context limit to one run: `-c key=value` pairs for Codex, or
 * `NAME=value` entries for the `env -i` in front of Claude Code. `state` says why there are none:
 * `app-default` (the agent has no limit), `not-supported-yet` (no proven setting on this version)
 * or `out-of-range` (the app does not take that size).
 */
export function contextItems(agent, proven) {
  if (agent.context_limit === undefined) return { state: 'app-default' }
  const controls = CONTEXT_CONTROLS[agent.harness]
  const app = appName(agent.harness)
  const base = { limit: agent.context_limit, ...(agent.compact_at === undefined ? {} : { compact_at: agent.compact_at }) }
  if (controls === undefined) return { state: 'not-supported-yet', ...base, reason: `BMN has no context setting for ${app}` }
  if (!proven.limit) return { state: 'not-supported-yet', ...base, reason: untestedReason(app, agent.harness, proven.standing) }
  const { min, max } = controls.limit
  if ((min !== undefined && agent.context_limit < min) || (max !== undefined && agent.context_limit > max)) {
    return { state: 'out-of-range', ...base, reason: `${app} takes ${thousands(min)} to ${thousands(max)} tokens` }
  }
  const pairs = [[controls.limit.key, agent.context_limit]]
  let compact
  if (agent.compact_at !== undefined) {
    compact = controls.compact !== null && proven.compact ? 'applied' : 'not-supported-yet'
    if (compact === 'applied') pairs.push([controls.compact.key, agent.compact_at])
  }
  return {
    state: 'applied', ...base, ...(compact === undefined ? {} : { compact }),
    argv: controls.limit.form === 'argv' ? pairs.flatMap(([key, value]) => ['-c', `${key}=${value}`]) : [],
    env: controls.limit.form === 'env' ? pairs.map(([key, value]) => `${key}=${value}`) : []
  }
}

/**
 * The size a run gets when its own environment names one and other sources name another: the
 * environment's, but only where the owner's test of this version saw it win over each of those very
 * sources, on the same side. Otherwise null: two sizes stay no answer.
 */
function settledByTest(resolved, precedence) {
  if (resolved?.limit?.conflict !== true || !Array.isArray(resolved.sizes)) return null
  const own = resolved.sizes.filter((entry) => entry.id === 'environment')
  if (own.length !== 1) return null
  const rivals = resolved.sizes.filter((entry) => entry.id !== 'environment' && entry.value !== own[0].value)
  const seen = (rival) => precedence.some((proof) => proof.id === rival.id && proof.side === (rival.value > own[0].value ? 'above' : 'below'))
  if (rivals.length === 0 || !rivals.every(seen)) return null
  return { value: own[0].value, source: `${own[0].source}, which the test of this version showed wins over ${rivals.map((rival) => `${rival.source} (${rival.value})`).join(' and ')}` }
}

/**
 * Compares what a dispatch would really run with (`resolved`, from the route resolvers) with the
 * agent's limit. Returns `{ applied, note }` or, for CONTEXT_MISMATCH, `{ refusal, why }`: `why` is
 * `out-of-range` (the app does not take that size), `conflict` (two sources name different sizes),
 * `unresolved` (BMN cannot read what the app would use), `missing` or `differs`. Nothing is required
 * where the limit is not supported yet. `precedence` is what the owner's test showed about sources
 * that disagree (provenPrecedence).
 */
export function checkContext(agent, resolved, proven, precedence = []) {
  const items = contextItems(agent, proven)
  if (items.state === 'app-default') return { applied: null, note: 'context limit: the app\'s default' }
  if (items.state === 'not-supported-yet') return { applied: null, note: `context limit ${items.limit}: not applied, ${items.reason}` }
  if (items.state === 'out-of-range') return { refusal: `${agent.id}'s context limit ${items.limit} cannot be applied: ${items.reason}`, why: 'out-of-range' }
  const app = APP_NAMES[agent.harness]
  const compare = (found, wanted, what) => {
    if (found?.unresolved) return { refusal: `the ${what} ${app} would use cannot be resolved: ${found.unresolved}`, why: found.conflict === true ? 'conflict' : 'unresolved' }
    if (found === null || found === undefined) return { refusal: `no ${what} reaches ${app}; ${agent.id}'s is ${wanted}`, why: 'missing' }
    return found.value === wanted ? null : { refusal: `${found.source} gives a ${what} of ${found.value}; ${agent.id}'s is ${wanted}`, why: 'differs' }
  }
  const limit = settledByTest(resolved, precedence) ?? resolved?.limit
  const refused = compare(limit, items.limit, 'context limit')
    ?? (items.compact === 'applied' ? compare(resolved?.compact, items.compact_at, 'compaction point') : null)
  if (refused !== null) return refused
  return { applied: items.limit, note: `context limit ${items.limit}${items.compact === 'applied' ? `, compacting at ${items.compact_at}` : ''}: ${limit.source}` }
}

// ---------------------------------------------------------------------------------------------
// Reading and editing the two files, every other byte left as it is (60.9 AC3)

/** The file that holds an app's default for the owner's own sessions. */
export function contextFile(harness, environment = process.env) {
  const home = environment.HOME || homedir()
  if (harness === 'codex') return `${absoluteUncollapsed(environment.CODEX_HOME || `${home}/.codex`)}/config.toml`
  if (harness === 'claude') return `${absoluteUncollapsed(environment.CLAUDE_CONFIG_DIR || `${home}/.claude`)}/settings.json`
  throw new ContextError('APP_UNSUPPORTED', `BMN has no context setting for ${appName(harness)}`)
}

function lineParts(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** Where an unquoted `#` starts a comment in the rest of a TOML line, or -1. */
function commentStart(text) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#') return index
  }
  return -1
}

function bracketDepth(text) {
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
  return depth
}

/**
 * The keys of a TOML file's top level, the part before its first table: each with its line, the
 * text before its value, the value and whatever follows it. A value that runs over several lines
 * is marked, because BMN replaces a value only where it can see all of it.
 */
function tomlTopLevel(text) {
  const lines = lineParts(text)
  const keys = []
  let until = null
  let depth = 0
  let end = lines.length
  let lastValueLine = -1
  for (let index = 0; index < lines.length; index += 1) {
    const body = lines[index].replace(/\r?\n$/, '')
    if (until !== null) {
      if (body.includes(until)) until = null
      lastValueLine = index
      continue
    }
    if (depth > 0) {
      depth = Math.max(0, depth + bracketDepth(body))
      lastValueLine = index
      continue
    }
    const trimmed = body.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('[')) {
      end = index
      break
    }
    const match = /^(\s*(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*)(.*)$/.exec(body)
    if (match === null) continue
    const rest = match[5]
    const hash = commentStart(rest)
    const value = (hash === -1 ? rest : rest.slice(0, hash)).trimEnd()
    let spans = false
    if (value.startsWith('"""') || value.startsWith("'''")) {
      const marker = value.slice(0, 3)
      if (value.length < 6 || !value.endsWith(marker)) {
        until = marker
        spans = true
      }
    } else if (value.startsWith('[') || value.startsWith('{')) {
      depth = Math.max(0, bracketDepth(value))
      spans = depth > 0
    }
    keys.push({ key: match[2] ?? match[3] ?? match[4], line: index, prefix: match[1], value, trailing: rest.slice(value.length), spans })
    lastValueLine = index
  }
  return { lines, keys, end, lastValueLine }
}

/** config.toml's top-level context keys as whole numbers; a value BMN cannot read is named, never guessed. */
export function readCodexContext(text) {
  const out = { limit: null, compact: null, unreadable: null }
  if (text === null) return out
  const { keys } = tomlTopLevel(text)
  for (const [name, key] of [['limit', CODEX_CONTEXT_KEYS[0]], ['compact', CODEX_CONTEXT_KEYS[1]]]) {
    const found = keys.filter((entry) => entry.key === key)
    if (found.length === 0) continue
    const value = found.length === 1 && !found[0].spans ? wholeNumber(found[0].value) : null
    if (value === null) out.unreadable ??= found.length > 1 ? `config.toml names ${key} more than once` : `config.toml ${key} is not a whole number`
    else out[name] = value
  }
  return out
}

/**
 * config.toml with its top-level `key` set to `value`, or removed when `value` is null. Only that
 * line changes: its indentation, spacing and comment stay, and a new key goes after the last
 * top-level one, before the first table.
 */
export function setTomlTopLevelKey(text, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const { lines, keys, lastValueLine } = tomlTopLevel(text)
  const found = keys.filter((entry) => entry.key === key)
  if (found.length > 1) throw new ContextError('UNREADABLE', `config.toml names ${key} more than once; BMN cannot tell which one Codex uses`)
  if (found.length === 1) {
    const entry = found[0]
    if (entry.spans) throw new ContextError('UNREADABLE', `config.toml ${key} runs over several lines; BMN does not replace a value it cannot see whole`)
    const ending = /\r?\n$/.exec(lines[entry.line])?.[0] ?? ''
    if (value === null) lines.splice(entry.line, 1)
    else lines[entry.line] = `${entry.prefix}${value}${entry.trailing}${ending}`
    return lines.join('')
  }
  if (value === null) return text
  const at = lastValueLine + 1
  if (at > 0 && !/\n$/.test(lines[at - 1])) lines[at - 1] += eol
  lines.splice(at, 0, `${key} = ${value}${eol}`)
  return lines.join('')
}

function skipSpace(text, index) {
  let at = index
  while (at < text.length && /\s/.test(text[at])) at += 1
  return at
}

/** The index just past the JSON value that starts at `index`. */
function jsonValueEnd(text, index) {
  const first = text[index]
  if (first === '"') {
    for (let at = index + 1; at < text.length; at += 1) {
      if (text[at] === '\\') at += 1
      else if (text[at] === '"') return at + 1
    }
    throw new ContextError('UNREADABLE', 'settings.json holds text that never ends')
  }
  if (first === '{' || first === '[') {
    let depth = 0
    for (let at = index; at < text.length; at += 1) {
      const char = text[at]
      if (char === '"') at = jsonValueEnd(text, at) - 1
      else if (char === '{' || char === '[') depth += 1
      else if (char === '}' || char === ']') {
        depth -= 1
        if (depth === 0) return at + 1
      }
    }
    throw new ContextError('UNREADABLE', 'settings.json holds a value that never ends')
  }
  let at = index
  while (at < text.length && !/[\s,}\]]/.test(text[at])) at += 1
  return at
}

/** The members of the JSON object that opens at `open`, each with where its key and value sit in the text. */
function jsonMembers(text, open) {
  const members = []
  let at = skipSpace(text, open + 1)
  if (text[at] === '}') return { members, close: at }
  for (;;) {
    if (text[at] !== '"') throw new ContextError('UNREADABLE', 'settings.json is not an object BMN can follow')
    const keyEnd = jsonValueEnd(text, at)
    const colon = skipSpace(text, keyEnd)
    if (text[colon] !== ':') throw new ContextError('UNREADABLE', 'settings.json is not an object BMN can follow')
    const valueStart = skipSpace(text, colon + 1)
    const valueEnd = jsonValueEnd(text, valueStart)
    members.push({ key: JSON.parse(text.slice(at, keyEnd)), keyStart: at, valueStart, valueEnd })
    const next = skipSpace(text, valueEnd)
    if (text[next] === '}') return { members, close: next }
    if (text[next] !== ',') throw new ContextError('UNREADABLE', 'settings.json is not an object BMN can follow')
    at = skipSpace(text, next + 1)
  }
}

/** The whitespace a member's line starts with, or null when it shares its line with something else. */
function memberIndent(text, keyStart) {
  const lineStart = text.lastIndexOf('\n', keyStart - 1) + 1
  const before = text.slice(lineStart, keyStart)
  return /^[ \t]*$/.test(before) ? before : null
}

function parsedSettings(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new ContextError('UNREADABLE', 'settings.json is not valid JSON')
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ContextError('UNREADABLE', 'settings.json is not a JSON object')
  if (data.env !== undefined && (data.env === null || typeof data.env !== 'object' || Array.isArray(data.env))) {
    throw new ContextError('UNREADABLE', 'settings.json env is not an object')
  }
  return data
}

/** settings.json's `env` entry for the context limit as a whole number. */
export function readClaudeContext(text) {
  const out = { limit: null, compact: null, unreadable: null }
  if (text === null) return out
  let data
  try {
    data = parsedSettings(text)
  } catch (error) {
    return { ...out, unreadable: error.message }
  }
  const raw = data.env?.[CLAUDE_CONTEXT_KEY]
  if (raw === undefined) return out
  const value = typeof raw === 'string' || typeof raw === 'number' ? wholeNumber(raw) : null
  return value === null ? { ...out, unreadable: `settings.json env ${CLAUDE_CONTEXT_KEY} is not a whole number` } : { ...out, limit: value }
}

/**
 * settings.json with `env[name]` set to the text `value`, or removed when `value` is null. Only
 * that member changes; an `env` object is added at the end when the file has none. The result is
 * parsed again and compared with what was meant before it is returned.
 */
export function setJsonEnvEntry(text, name, value) {
  const source = text.trim() === '' ? '{}\n' : text
  const data = parsedSettings(source)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const indent = jsonIndent(source)
  const unit = typeof indent === 'number' ? ' '.repeat(indent) : indent
  const oneLine = !source.trim().includes('\n')
  const rootOpen = skipSpace(source, source.charCodeAt(0) === 0xfeff ? 1 : 0)
  const root = jsonMembers(source, rootOpen)
  const splice = (from, to, insert) => source.slice(0, from) + insert + source.slice(to)
  const literal = value === null ? null : JSON.stringify(String(value))
  /** One more member at the end of an object, written the way its last member is. */
  const append = (object, open, write) => {
    if (object.members.length === 0) {
      if (oneLine) return splice(open + 1, object.close, write(null))
      const outer = memberIndent(source, open) ?? /^[ \t]*/.exec(source.slice(source.lastIndexOf('\n', open - 1) + 1))[0]
      return splice(open + 1, object.close, `${eol}${write(`${outer}${unit}`)}${eol}${outer}`)
    }
    const last = object.members.at(-1)
    const own = memberIndent(source, last.keyStart)
    return splice(last.valueEnd, last.valueEnd, own === null ? `, ${write(null)}` : `,${eol}${write(own)}`)
  }
  const remove = (object, open, index) => {
    const { members } = object
    if (members.length === 1) return splice(open + 1, object.close, '')
    if (index < members.length - 1) return splice(members[index].keyStart, members[index + 1].keyStart, '')
    return splice(members[index - 1].valueEnd, members[index].valueEnd, '')
  }
  const envs = root.members.filter((member) => member.key === 'env')
  if (envs.length > 1) throw new ContextError('UNREADABLE', 'settings.json names env more than once; BMN cannot tell which one Claude Code uses')
  let next
  if (envs.length === 0) {
    if (literal === null) return text
    next = append(root, rootOpen, (own) => own === null ? `"env": {${JSON.stringify(name)}: ${literal}}`
      : `${own}"env": {${eol}${own}${unit}${JSON.stringify(name)}: ${literal}${eol}${own}}`)
  } else {
    const open = envs[0].valueStart
    const env = jsonMembers(source, open)
    const found = env.members.flatMap((member, index) => member.key === name ? [index] : [])
    if (found.length > 1) throw new ContextError('UNREADABLE', `settings.json names env ${name} more than once; BMN cannot tell which one Claude Code uses`)
    if (found.length === 1) {
      const member = env.members[found[0]]
      next = literal === null ? remove(env, open, found[0]) : splice(member.valueStart, member.valueEnd, literal)
    } else {
      if (literal === null) return text
      next = append(env, open, (own) => `${own ?? ''}${JSON.stringify(name)}: ${literal}`)
    }
  }
  const meant = structuredClone(data)
  if (literal === null) delete meant.env[name]
  else meant.env = { ...(meant.env ?? {}), [name]: String(value) }
  let written
  try {
    written = JSON.parse(next)
  } catch {
    written = undefined
  }
  if (JSON.stringify(written) !== JSON.stringify(meant)) throw new ContextError('UNREADABLE', 'BMN could not change settings.json without touching anything else; nothing was written')
  return next
}

function fileText(path, state) {
  if (state.kind === 'missing') return null
  if (state.kind === 'file') return state.text
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The approved, enabled agents that run on an app: they share its one settings folder. */
export function sharingAgents(data, harness) {
  return (data?.agents ?? []).filter((agent) => agent.harness === harness && agentState(agent) === 'active').map((agent) => agent.name)
}

/**
 * One app's default for the owner's own sessions as its file holds it now, and whether BMN may
 * change it: only where the test proved the setting on the installed version.
 */
export function contextDefault(harness, { environment = process.env, version = null, tests = contextTests() } = {}) {
  const path = contextFile(harness, environment)
  const controls = CONTEXT_CONTROLS[harness]
  let state
  try {
    state = pathState(path)
  } catch (error) {
    return { harness, path, exists: true, limit: null, compact: null, unreadable: error.message, version, proven: provenControls(harness, version, tests), test: lastContextTest(harness, tests), compact_control: controls.compact !== null }
  }
  const text = fileText(path, state)
  const read = state.kind !== 'missing' && text === null ? { limit: null, compact: null, unreadable: `${path} cannot be read` }
    : harness === 'codex' ? readCodexContext(text) : readClaudeContext(text)
  return {
    harness, path, ...(state.kind === 'missing' ? {} : { resolved_path: resolvedPath(path, state) }), exists: state.kind !== 'missing',
    ...(state.kind === 'link' ? { link_target: state.target } : {}),
    limit: read.limit, compact: read.compact, ...(read.unreadable ? { unreadable: read.unreadable } : {}),
    version, proven: provenControls(harness, version, tests), test: lastContextTest(harness, tests),
    compact_control: controls.compact !== null, ...(controls.limit.min === undefined ? {} : { min: controls.limit.min, max: controls.limit.max })
  }
}

function validSize(value, what) {
  if (value === null) return
  if (!Number.isSafeInteger(value) || value <= 0) throw new ContextError('INVALID_VALUE', `${what} must be a positive whole number of tokens, or empty for the app's default`)
}

/**
 * What changing an app's default would write, before anything is written (R60-NFR2): the file,
 * where the write would really land, the diff and a hash that binds all of it. `limit` and
 * `compact` are a number of tokens or null for the app's own default.
 */
export function planContextDefault(harness, { limit, compact = null }, { environment = process.env, version = null, tests = contextTests() } = {}) {
  const controls = CONTEXT_CONTROLS[harness]
  if (controls === undefined) throw new ContextError('APP_UNSUPPORTED', `BMN has no context setting for ${appName(harness)}`)
  const app = APP_NAMES[harness]
  const proven = provenControls(harness, version, tests)
  if (!proven.limit) throw new ContextError('NOT_SUPPORTED_YET', `The context setting is not tested on ${app} ${version ?? '(version not read)'} yet; run its test first (bmn context test ${harness})`)
  validSize(limit, 'the context limit')
  validSize(compact, 'the compaction point')
  if (compact !== null && !proven.compact) throw new ContextError('NOT_SUPPORTED_YET', `Where ${app} starts summarising is not supported yet`)
  if (compact !== null && limit === null) throw new ContextError('INVALID_VALUE', 'a compaction point needs a context limit')
  if (compact !== null && compact >= limit) throw new ContextError('INVALID_VALUE', `the compaction point must be below the context limit (${limit})`)
  const { min, max } = controls.limit
  if (limit !== null && min !== undefined && (limit < min || limit > max)) throw new ContextError('INVALID_VALUE', `${app} takes ${thousands(min)} to ${thousands(max)} tokens`)
  const path = contextFile(harness, environment)
  const state = pathState(path)
  const before = fileText(path, state)
  if (state.kind !== 'missing' && before === null) throw new ContextError('UNREADABLE', `${path} cannot be read`)
  let next = before ?? ''
  if (harness === 'codex') {
    const held = readCodexContext(next)
    if (held.unreadable) throw new ContextError('UNREADABLE', held.unreadable)
    // A compaction point BMN has not proved it can set stays as the owner wrote it, unless it would sit at or above the new limit.
    if (!proven.compact && limit !== null && held.compact !== null && held.compact >= limit) {
      throw new ContextError('INVALID_VALUE', `config.toml starts summarising at ${thousands(held.compact)}, which is not below ${thousands(limit)}; BMN cannot change that key yet, so change it by hand first`)
    }
    next = setTomlTopLevelKey(next, CODEX_CONTEXT_KEYS[0], limit)
    // The compaction key is BMN's to write, or to take out with the limit, only where its test proved it (60.9 AC1:
    // an unverified control is never written). Until then a compaction point in the file stays exactly as it is.
    if (proven.compact) next = setTomlTopLevelKey(next, CODEX_CONTEXT_KEYS[1], limit === null ? null : compact)
  } else {
    next = setJsonEnvEntry(next, CLAUDE_CONTEXT_KEY, limit)
  }
  const resolved = resolvedPath(path, state)
  const diff = next === (before ?? '') ? '' : unifiedDiff(before ?? '', next, path)
  const body = { harness, path, resolved, state: state.kind, link: state.kind === 'link' ? state.target : null, directory: state.directory, before: before === null ? null : sha256(before), next: sha256(next), limit, compact }
  return {
    harness, path, ...(resolved === path ? {} : { resolved_path: resolved }), ...(state.kind === 'link' ? { link_target: state.target } : {}),
    change: state.kind === 'missing' ? 'new file' : diff === '' ? 'no change' : 'edit', diff, limit, compact, plan_hash: sha256(JSON.stringify(body)), state, next
  }
}

/**
 * Writes what the plan showed, and only that: refused when anything the plan was made from has
 * changed. The file's earlier bytes are kept beside it first, so the change can be put back by hand.
 */
export function applyContextDefault(harness, values, expectedPlanHash, options = {}) {
  const plan = planContextDefault(harness, values, options)
  if (plan.plan_hash !== expectedPlanHash) throw new ContextError('REVISION_CONFLICT', `${plan.path} or the request changed since it was shown; nothing was written`)
  if (plan.diff === '') return { harness, path: plan.path, written: false, backup: null }
  const now = options.now ?? new Date()
  let backup = null
  if (plan.state.kind !== 'missing') {
    backup = `${plan.path}.bmn-backup-${now.toISOString()}`
    copyFileSync(plan.path, backup)
    chmodSync(backup, 0o600)
  }
  try {
    replaceFileSafely(plan.path, plan.state, plan.next, { beforeCommit: options.beforeCommit })
  } catch (error) {
    if (backup !== null) rmSync(backup, { force: true })
    throw error
  }
  return { harness, path: plan.path, written: true, backup }
}

// ---------------------------------------------------------------------------------------------
// The owner-run test (60.9 AC1)

function tokensFigure(text) {
  const match = /^([\d.,]+)\s*([kKmM]?)$/.exec(text.trim())
  if (match === null) return null
  const number = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(number)) return null
  const unit = match[2].toLowerCase()
  return Math.round(number * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1))
}

/** The window Claude Code's own `/context` report names: the second figure of its Tokens line. */
export function claudeReportedWindow(output) {
  const match = /\*\*Tokens:\*\*\s*[\d.,]+\s*[kKmM]?\s*\/\s*([\d.,]+\s*[kKmM]?)/.exec(output)
  return match === null ? null : tokensFigure(match[1])
}

/** The window a Codex session record names for its turns: the last one it wrote. */
export function codexRecordedWindow(rollout) {
  let last = null
  for (const match of rollout.matchAll(/"model_context_window":\s*(\d+)/g)) last = Number(match[1])
  return last
}

/**
 * Where a test runs: a folder of its own directly under the home folder, named from this. BMN also
 * judges from here what a run would meet (63.1), so the home folder's own settings count once, as
 * the user's, and not a second time as a project's.
 */
export function contextTestFolder(environment = process.env) {
  return `${environment.HOME || homedir()}/.bmn-context-test-`
}

/** What the test passes Claude Code: one answer to `/context`, kept nowhere. */
export const CLAUDE_TEST_ARGUMENTS = ['-p', '--no-session-persistence', '--output-format', 'text']

/**
 * Starts the app once in an empty throwaway folder under the home folder, asks it for a context
 * size no default equals, and records whether the app's own report shows that size: `pass`,
 * `fail`, `inconclusive` or `unavailable`, against the app's version. The prompt is synthetic and
 * names nothing of the owner's. Where summarising starts is not tested yet, so it stays unproven.
 */
export async function testContext(harness, { environment = process.env, now = new Date(), timeoutMs = 180_000, by = undefined } = {}) {
  const controls = CONTEXT_CONTROLS[harness]
  if (controls === undefined) throw new ContextError('APP_UNSUPPORTED', `BMN has no context setting for ${appName(harness)}`)
  const asked = CONTEXT_TEST_SIZE[harness]
  const record = (limit, detail, version = null, observed = null, rivals = undefined) => {
    // `by` is set where BMN started the test by itself (63.1); the owner's own test carries none.
    const entry = { harness, at: now.toISOString(), version, limit, compact: 'untested', asked, observed, detail, ...(rivals === undefined ? {} : { rivals }), ...(by === undefined ? {} : { by }) }
    mkdirSync(dirname(contextTestsPath()), { recursive: true, mode: 0o700 })
    appendFileSync(contextTestsPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    return entry
  }
  const { harnessVersion, contextTestSources } = await import('./agents-check.mjs')
  const version = harnessVersion(controls.command, environment)
  if (version === null) return record('unavailable', `${controls.command} is not installed or did not answer --version`)
  const home = environment.HOME || homedir()
  const folder = mkdtempSync(contextTestFolder(environment))
  try {
    if (harness === 'codex') {
      const { findRollout } = await import('./agents-rules.mjs')
      const started = Date.now()
      const run = spawnSync(controls.command, ['exec', '--skip-git-repo-check', '-C', folder, '--sandbox', 'read-only', '-c', 'approval_policy="never"',
        '-c', `${controls.limit.key}=${asked}`, '-'], { cwd: folder, env: environment, input: 'Reply with the single word OK.', encoding: 'utf8', timeout: timeoutMs })
      if (run.error || run.status === null) return record('inconclusive', 'Codex did not finish', version)
      const rollout = findRollout(`${environment.CODEX_HOME || `${home}/.codex`}/sessions`, folder, started)
      if (rollout === null) return record('inconclusive', 'no session record of the test run was found', version)
      const observed = codexRecordedWindow(rollout)
      if (observed === null) return record('inconclusive', 'the session record names no context window', version)
      // Codex keeps part of the configured window back for its answer, so the record is a little under what was asked.
      return observed <= asked && observed >= asked * 0.9
        ? record('pass', `asked for ${asked}; the session record shows ${observed}`, version, observed)
        : record('fail', `asked for ${asked}, but the session record shows ${observed}`, version, observed)
    }
    const command = CLAUDE_TEST_ARGUMENTS
    const tested = { ...environment, [controls.limit.key]: String(asked) }
    // The owner's own files may name another size for this very run. Which ones do is kept with the
    // result: a pass then also shows that the run's own value wins over each of them on this version.
    const rivals = contextTestSources(harness, environment, folder)
    // One that names a size the report cannot tell from the one asked for would make the report show
    // nothing: whichever source the app obeyed, it would read the same. The app is not started for that.
    const unclear = rivals.filter((rival) => reportedAs(asked, rival.value))
    if (unclear.length > 0) {
      return record('inconclusive', `${unclear.map((rival) => `${rival.source} says ${rival.value}`).join(' and ')}, which the app's report could not tell from the ${asked} this test asks for; the test can show nothing while that is so`, version)
    }
    const others = rivals.length === 0 ? '' : ` while ${rivals.map((rival) => `${rival.source} says ${rival.value}`).join(' and ')}`
    const run = spawnSync(controls.command, command, { cwd: folder, env: tested, input: '/context', encoding: 'utf8', timeout: timeoutMs })
    if (run.error || run.status !== 0) return record('inconclusive', 'Claude Code did not answer (timeout or error)', version)
    const observed = claudeReportedWindow(run.stdout)
    if (observed === null) return record('inconclusive', 'Claude Code\'s context report names no window', version)
    return reportedAs(asked, observed)
      ? record('pass', `asked for ${asked}${others}; Claude Code reports a window of ${observed}${rivals.length === 0 ? '' : ', so the run\'s own value wins'}`, version, observed, rivals)
      : record('fail', `asked for ${asked}${others}, but Claude Code reports a window of ${observed}`, version, observed, rivals)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// BMN tests a new app version by itself (63.1)

/** The approved, enabled agents on an app that have a context limit of their own: the ones a test of that app is for. */
export function limitedAgents(data, harness) {
  return (data?.agents ?? []).filter((agent) => agent.harness === harness && agentState(agent) === 'active' && agent.context_limit !== undefined)
}

/** Which side of `size` a source's own size is on; `same` where the app's report could not tell the two apart. */
function sideOf(value, size) {
  return reportedAs(size, value) ? 'same' : value > size ? 'above' : 'below'
}

/**
 * Whether a version that passed should be tested once more (63.1 AC3): a run of one of these agents
 * would meet another source the recorded test did not see lose on that side, so the check answers
 * `conflict`, and a test started now would meet a set of sources (which one, and on which side of the
 * size the test asks for) that no recorded test of this version met. The record itself is the
 * memory: once a test of this set is on record the answer is no, so each set is tested once for a
 * version, whatever was tested in between. A source the report could not tell from the test's own
 * size would show nothing, so it starts no test. Returns that set, as the text that names it, or null.
 */
function newSourceSet(harness, agents, last, tests, today) {
  if (!Array.isArray(today) || today.length === 0) return null
  const asked = CONTEXT_TEST_SIZE[harness]
  if (today.some((rival) => sideOf(rival.value, asked) === 'same')) return null
  const precedence = provenPrecedence(harness, last.version, tests)
  const refused = agents.some((agent) => today.some((rival) => rival.value !== agent.context_limit
    && !precedence.some((proof) => proof.id === rival.id && proof.side === (rival.value > agent.context_limit ? 'above' : 'below'))))
  if (!refused) return null
  const set = (rivals, size) => rivals.map((rival) => `${rival.id} ${sideOf(rival.value, size)}`).sort().join('\n')
  const now = set(today, asked)
  const met = tests.some((test) => test.harness === harness && test.version === last.version && Array.isArray(test.rivals) && Number.isSafeInteger(test.asked)
    && test.rivals.every((rival) => typeof rival?.id === 'string' && Number.isSafeInteger(rival?.value)) && set(test.rivals, test.asked) === now)
  return met ? null : now
}

/**
 * Which apps BMN should test by itself now, and why: `untested` (no test of the installed version on
 * record), `retry` (the latest one showed nothing) or `sources` (see newSourceSet; the entry then
 * names that set, so the caller starts one test for each set and no second one for the same). An app no
 * agent has a limit for is never named, nor is one whose version cannot be read, nor a version whose
 * latest test failed: that one waits for the owner. `versions` holds each app's installed version and
 * `sources` what a test started now would meet besides its own size (contextTestSources). The caller
 * bounds the tries, across restarts of BMN (Story 75.8).
 */
export function contextAutoPlan({ data, versions, tests = contextTests(), sources = {} }) {
  const plan = []
  for (const harness of CONTEXT_APPS) {
    const agents = limitedAgents(data, harness)
    const version = versions?.[harness]
    if (agents.length === 0 || typeof version !== 'string') continue
    const last = latestOf(harness, version, tests)
    const set = last?.limit === 'pass' ? newSourceSet(harness, agents, last, tests, sources[harness]) : null
    const reason = last === null ? 'untested'
      : last.limit === 'inconclusive' || last.limit === 'unavailable' ? 'retry'
        : set !== null ? 'sources' : null
    if (reason !== null) plan.push({ harness, version, reason, agents: agents.map((agent) => agent.name), ...(reason === 'sources' ? { set } : {}) })
  }
  return plan
}

// ---------------------------------------------------------------------------------------------
// CLI

export const CONTEXT_USAGE = `Usage: bmn context check [--json]            Each app's default context limit for your own sessions, and whether
                                             BMN has tested the setting on the installed version
       bmn context set <app> [--limit N|default] [--compact-at N|default] [--plan] [--expect-plan <hash>] [--yes] [--json]
                                             Change that default: only the named keys of the app's file, shown
                                             as a diff and written after Yes
       bmn context test <app> [--json]       Start the app once in an empty folder and see whether it takes the
                                             setting; the result is kept for that version. BMN runs it by itself
                                             for a new version of an app an agent has a limit on (--auto marks
                                             such a run)

Apps: codex (config.toml: model_context_window, model_auto_compact_token_limit) and claude
(settings.json env: CLAUDE_CODE_AUTO_COMPACT_WINDOW). An agent's own limit is applied to a dispatch by the
items \`bmn roster role --json\` lists and checked by \`bmn roster check\`.`

function sizeOption(value, name) {
  if (value === undefined) return undefined
  if (value === 'default' || value === '') return null
  const number = wholeNumber(value)
  if (number === null) throw new ContextError('INVALID_VALUE', `--${name} takes a positive whole number of tokens, or default`)
  return number
}

function defaultLine(row) {
  const app = (appName(row.harness)).padEnd(12)
  const value = row.unreadable ? `cannot be read (${row.unreadable})`
    : row.limit === null ? 'app default' : `${row.limit} tokens${row.compact === null ? '' : `, compacts at ${row.compact}`}`
  const tested = row.proven.limit ? 'setting tested on this version' : `not supported yet: run bmn context test ${row.harness}`
  return `${app}${value}  ${row.path}  ${row.version ?? 'version not read'}: ${tested}`
}

export async function runContextCommand(argv) {
  const { AgentsUsageError, EXIT, out, readOptions, usage } = await import('./agents-cli.mjs')
  const [action, ...rest] = argv
  if (action === undefined || action === '--help' || action === '-h' || action === 'help') {
    out(CONTEXT_USAGE)
    return action === undefined ? 2 : 0
  }
  let asJson = false
  try {
    const { harnessVersion } = await import('./agents-check.mjs')
    const versionOf = (harness) => harnessVersion(CONTEXT_CONTROLS[harness].command, process.env)
    if (action === 'check') {
      const { options, positionals } = readOptions(rest, { flags: ['json'] })
      asJson = options.json === true
      if (positionals.length > 0) return usage('context check takes no arguments')
      const tests = contextTests()
      const rows = CONTEXT_APPS.map((harness) => contextDefault(harness, { version: versionOf(harness), tests }))
      out(asJson ? JSON.stringify({ ok: rows.every((row) => !row.unreadable), apps: rows }, null, 2) : rows.map(defaultLine).join('\n'))
      return rows.some((row) => row.unreadable) ? 1 : 0
    }
    if (action === 'set') {
      const { options, positionals } = readOptions(rest, { flags: ['json', 'plan', 'yes'], values: ['limit', 'compact-at', 'expect-plan'] })
      asJson = options.json === true
      if (positionals.length !== 1 || !CONTEXT_APPS.includes(positionals[0])) return usage(`context set expects one app: ${CONTEXT_APPS.join(', ')}`)
      const harness = positionals[0]
      const version = versionOf(harness)
      const current = contextDefault(harness, { version })
      const limit = sizeOption(options.limit, 'limit')
      const compact = sizeOption(options['compact-at'], 'compact-at')
      if (limit === undefined && compact === undefined) return usage('context set needs --limit or --compact-at')
      const values = { limit: limit === undefined ? current.limit : limit, compact: compact === undefined ? (limit === null ? null : current.proven.compact ? current.compact : null) : compact }
      const plan = planContextDefault(harness, values, { version })
      // What the plan would write is shown as its diff; the bytes themselves and the file's state stay out of the output.
      const shown = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'state' && key !== 'next'))
      if (options.plan) {
        out(asJson ? JSON.stringify({ code: 'OK', ...shown }, null, 2) : plan.diff === '' ? `${plan.path} already holds that.` : `${plan.path}${plan.resolved_path ? ` (written at ${plan.resolved_path})` : ''}\n${plan.diff}`)
        return 0
      }
      if (plan.diff === '') {
        out(asJson ? JSON.stringify({ code: 'OK', written: false, path: plan.path }, null, 2) : `${plan.path} already holds that.`)
        return 0
      }
      if (options['expect-plan'] !== undefined && options['expect-plan'] !== plan.plan_hash) {
        throw new ContextError('REVISION_CONFLICT', `${plan.path} or the request changed since it was shown; nothing was written`)
      }
      const { confirm } = await import('./agents-rules.mjs')
      const details = [`${APP_NAMES[harness]}: ${plan.path}${plan.resolved_path ? ` (written at ${plan.resolved_path})` : ''}`,
        ...(plan.link_target ? [`This is a link to ${plan.link_target}; it is replaced by a regular file here, and the file it points to stays as it is.`] : []), plan.diff].join('\n')
      if (!await confirm(`Change ${APP_NAMES[harness]}'s default context limit?`, details, { yes: options.yes === true, asJson })) {
        if (asJson) out(JSON.stringify({ code: 'NOT_CONFIRMED', message: 'nothing was written' }, null, 2))
        return asJson ? 2 : 1
      }
      const result = applyContextDefault(harness, values, plan.plan_hash, { version })
      out(asJson ? JSON.stringify({ code: 'OK', ...result, limit: values.limit, compact: values.compact }, null, 2)
        : `Wrote ${result.path}.${result.backup ? ` The file as it was: ${result.backup}` : ''}\nSessions started before this keep their old limit.`)
      return 0
    }
    if (action === 'test') {
      const { options, positionals } = readOptions(rest, { flags: ['json', 'auto'] })
      asJson = options.json === true
      if (positionals.length !== 1 || !CONTEXT_APPS.includes(positionals[0])) return usage(`context test expects one app: ${CONTEXT_APPS.join(', ')}`)
      const result = await testContext(positionals[0], options.auto === true ? { by: 'bmn' } : {})
      // `outcome` repeats the limit's result under the name the app's reader shares with the rules loading test.
      out(asJson ? JSON.stringify({ ...result, outcome: result.limit }, null, 2) : `${result.harness}: ${result.limit} - ${result.detail}${result.version ? ` (${result.version})` : ''}`)
      return result.limit === 'pass' ? 0 : 1
    }
    return usage(`context expects check, set or test, not ${action}`)
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    if (error instanceof ContextError || error?.code === 'REVISION_CONFLICT' || error?.code === 'READBACK_FAILED' || error?.code === 'NOT_A_FILE') {
      if (asJson) out(JSON.stringify({ code: error.code, message: error.message }, null, 2))
      else process.stderr.write(`bmn: ${error.code}: ${error.message}\n`)
      return error.code === 'REVISION_CONFLICT' ? EXIT.REVISION_CONFLICT : error.code === 'INVALID_VALUE' ? EXIT.usage : 1
    }
    if (error instanceof RosterError) {
      const { failWith } = await import('./agents-cli.mjs')
      return failWith(error, asJson)
    }
    throw error
  }
}
