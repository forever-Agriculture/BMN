// MODULE: plan-allowances.mjs - Epic 110 Stories 110.4-110.5: plan/allowances/NNN.yaml, what a run may use: the one parser, the recorded version, `bmn plan allow`
// The file is a strict small part of YAML, read here and nowhere else (D6): dev-auto asks `bmn plan allowances`. It is trusted as a go is (D7):
// only a commit written by `bmn plan go` or `bmn plan allow` counts; a hand edit is reported and ignored. An epic with no file reads as before.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

/** What a run has with a file that names no repair_rounds (D13). */
export const DEFAULT_ROUNDS = 4
export const SOURCE_TIME = /\b(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/u
export const SOURCE_QUOTE = /["'“‘«][^"'”’»]+["'”’»]/u
export const DECISION_REFERENCE = /\bbmn: ?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\S+/u

const TOP_KEYS = ['schema', 'epic', 'limits', 'may', 'stays_out', 'deferrable', 'messages', 'prepared']
const LIST_KEYS = ['may', 'stays_out', 'deferrable', 'messages', 'prepared']
const LIMIT_FIELDS = ['limit', 'ceiling', 'per', 'unit']
const PERS = ['boundary', 'epic']
const UNITS = ['count', 'hours', 'usd']
const ITEM_FIELDS = {
  deferrable: { required: ['what', 'when'], optional: [] },
  messages: { required: ['person', 'destination', 'purpose'], optional: [] },
  prepared: { required: ['kind'], optional: ['target', 'check', 'checked', 'because'] }
}
const PREPARED_KINDS = ['account', 'credential', 'service', 'command', 'message', 'person', 'owner step']
const LIMIT_NAME = /^[a-z][a-z0-9_]*$/u

export class AllowRefusal extends Error {
  constructor(code, message) { super(message); this.code = code }
}

// ---------------------------------------------------------------------------------------------
// The file's grammar

/** A line without its comment: `#` at the start or after a space, outside a quoted value that opens where a value can open. */
function withoutComment(line) {
  let quote = null
  let previous = ''
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at]
    if (quote) {
      if (char === '\\' && quote === '"') { at += 1; continue }
      if (char === quote) quote = null
    } else if ((char === '"' || char === "'") && (previous === '' || /[{[,:-]/u.test(previous))) quote = char
    else if (char === '#' && (at === 0 || /\s/u.test(line[at - 1]))) return line.slice(0, at).trimEnd()
    if (!quote && !/\s/u.test(char)) previous = char
  }
  return line.trimEnd()
}

function quoted(text, start) {
  const mark = text[start]
  for (let at = start + 1; at < text.length; at += 1) {
    if (mark === '"' && text[at] === '\\') { at += 1; continue }
    if (text[at] === mark) {
      if (mark === "'" && text[at + 1] === "'") { at += 1; continue }
      const raw = text.slice(start, at + 1)
      try { return { value: mark === '"' ? JSON.parse(raw) : raw.slice(1, -1).replaceAll("''", "'"), end: at + 1 } } catch { throw new Error(`bad quoted value ${raw.slice(0, 40)}`) }
    }
  }
  throw new Error('an unclosed quote')
}

/** One flow value: `{a: b}`, `[a, b]`, a quoted or a plain value; a plain one ends at a comma or a closing bracket. */
function flowValue(text, start) {
  let at = start
  while (text[at] === ' ') at += 1
  if (text[at] === '{') {
    const value = {}
    at += 1
    for (;;) {
      while (text[at] === ' ') at += 1
      if (text[at] === '}') return { value, end: at + 1 }
      const colon = text.indexOf(':', at)
      if (colon === -1) throw new Error('a key with no value in { }')
      const key = text.slice(at, colon).trim()
      if (!/^[\w-]+$/u.test(key)) throw new Error(`"${key.slice(0, 30)}" is not a key`)
      if (Object.hasOwn(value, key)) throw new Error(`${key} twice in one { }`)
      const read = flowValue(text, colon + 1)
      value[key] = read.value
      at = read.end
      while (text[at] === ' ') at += 1
      if (text[at] === ',') at += 1
      else if (text[at] !== '}') throw new Error('an unclosed { }')
    }
  }
  if (text[at] === '[') {
    const value = []
    at += 1
    for (;;) {
      while (text[at] === ' ') at += 1
      if (text[at] === ']') return { value, end: at + 1 }
      const read = flowValue(text, at)
      value.push(read.value)
      at = read.end
      while (text[at] === ' ') at += 1
      if (text[at] === ',') at += 1
      else if (text[at] !== ']') throw new Error('an unclosed [ ]')
    }
  }
  if (text[at] === '"' || text[at] === "'") return quoted(text, at)
  let end = at
  while (end < text.length && !',}]'.includes(text[end])) end += 1
  return { value: text.slice(at, end).trim(), end }
}

function wholeFlow(text) {
  const read = flowValue(text, 0)
  if (text.slice(read.end).trim() !== '') throw new Error(`"${text.slice(read.end).trim().slice(0, 30)}" after the value`)
  return read.value
}

/** A block list's item: a flow map or list, a quoted value, or plain text to the end of the line (a comma is part of it). */
function itemValue(text) {
  return /^[{["']/u.test(text) ? wholeFlow(text) : text.trim()
}

function realDate(text) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text)
}

/** The file read strictly: its values, each problem with its line, and where each part stands so an edit changes only that part. */
export function parseAllowances(text, expectedEpic = null) {
  const problems = []
  const add = (line, reason) => problems.push({ line, reason })
  const data = { schema: null, epic: null, limits: {}, may: [], stays_out: [], deferrable: [], messages: [], prepared: [] }
  const where = { top: {}, limits: {}, items: {} }
  const lines = String(text).replace(/\r\n?/gu, '\n').split('\n')
  const seen = new Set()
  let at = 0
  while (at < lines.length) {
    const lineNumber = at + 1
    const line = withoutComment(lines[at])
    if (line.trim() === '') { at += 1; continue }
    const top = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/u.exec(line)
    if (!top) { add(lineNumber, /^\s/u.test(line) ? 'indented where no section is open' : 'not "key: value"'); at += 1; continue }
    const [, key, inline = ''] = top
    if (!TOP_KEYS.includes(key)) add(lineNumber, `unknown field ${key}`)
    if (seen.has(key)) add(lineNumber, `${key} is given twice`)
    seen.add(key)
    // The block under this key: its indented lines, with their numbers.
    const block = []
    let next = at + 1
    while (next < lines.length) {
      const inner = withoutComment(lines[next])
      if (inner.trim() !== '' && !/^\s/u.test(inner)) break
      if (inner.trim() !== '') block.push({ text: inner, line: next + 1 })
      next += 1
    }
    let end = next
    while (end > at + 1 && withoutComment(lines[end - 1]).trim() === '') end -= 1
    where.top[key] = { start: at, end }
    if (key === 'schema' || key === 'epic') {
      if (block.length > 0) add(block[0].line, `${key} takes one value`)
      if (key === 'schema') data.schema = inline
      else if (/^\d{1,6}$/u.test(inline)) data.epic = Number(inline)
      else add(lineNumber, `epic is a number, not "${inline}"`)
    } else if (key === 'limits') {
      if (inline !== '' && inline !== '{}') add(lineNumber, 'limits holds one limit per line, each as name: {limit: N, per: boundary}')
      for (const one of block) readLimit(one, data, where, add)
    } else if (LIST_KEYS.includes(key)) {
      readList(key, inline, block, lineNumber, data, where, add)
    }
    at = next
  }
  if (data.schema === null) add(1, 'no schema: the first line says schema: 1')
  else if (data.schema !== '1') add(where.top.schema.start + 1, `schema ${data.schema} is not one BMN reads (schema: 1)`)
  if (!seen.has('epic')) add(1, 'no epic: say which epic this file belongs to')
  else if (expectedEpic !== null && data.epic !== null && data.epic !== expectedEpic) add(where.top.epic.start + 1, `epic ${data.epic} disagrees with the file's number ${expectedEpic}`)
  return { data, problems: problems.sort((a, b) => a.line - b.line), where, lines }
}

function readLimit({ text: raw, line }, data, where, add) {
  const entry = /^ {2}([^\s:]+):[ \t]*(.*)$/u.exec(raw)
  if (!entry) { add(line, 'a limit is "  name: {limit: N, per: boundary}", on one line'); return }
  const [, name, body] = entry
  if (!LIMIT_NAME.test(name)) add(line, `"${name}" is not a limit's name (small letters, digits, _)`)
  if (Object.hasOwn(data.limits, name)) { add(line, `limit ${name} is given twice`); return }
  let map
  try { map = wholeFlow(body) } catch (error) { add(line, `limit ${name}: ${error.message}`); return }
  if (!map || typeof map !== 'object' || Array.isArray(map)) { add(line, `limit ${name} is {limit: N, per: boundary}`); return }
  for (const field of Object.keys(map)) if (!LIMIT_FIELDS.includes(field)) add(line, `limit ${name}: unknown field ${field}`)
  const limit = { limit: readNumber(map.limit), per: map.per ?? null }
  if (map.limit === undefined) add(line, `limit ${name} has no limit`)
  else if (limit.limit === null) add(line, `limit ${name}: limit is a number of 0 or more, not "${map.limit}"`)
  if (map.ceiling !== undefined) {
    limit.ceiling = readNumber(map.ceiling)
    if (limit.ceiling === null) add(line, `limit ${name}: ceiling is a number of 0 or more, not "${map.ceiling}"`)
    else if (limit.limit !== null && limit.ceiling < limit.limit) add(line, `limit ${name}: ceiling ${limit.ceiling} is under its limit ${limit.limit}`)
  }
  if (map.per === undefined) add(line, `limit ${name} has no per (boundary or epic)`)
  else if (!PERS.includes(map.per)) add(line, `limit ${name}: per is boundary or epic, not "${map.per}"`)
  if (map.unit !== undefined && !UNITS.includes(map.unit)) add(line, `limit ${name}: unit is count, hours or usd, not "${map.unit}"`)
  limit.unit = map.unit ?? 'count'
  const named = /_(hours|usd)$/u.exec(name)?.[1]
  if (named && map.unit !== named) add(line, `limit ${name} has no unit: ${named}`)
  if (limit.unit === 'count') {
    for (const field of ['limit', 'ceiling']) if (limit[field] != null && !Number.isInteger(limit[field])) add(line, `limit ${name}: ${limit[field]} is not a whole count; a decimal needs a unit`)
  }
  if (name === 'repair_rounds' && limit.per !== 'boundary') add(line, 'limit repair_rounds is per: boundary')
  if (name === 'money_usd' && (limit.per !== 'epic' || limit.unit !== 'usd')) add(line, 'limit money_usd is per: epic, unit: usd')
  data.limits[name] = limit
  where.limits[name] = line - 1
}

function readNumber(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/u.test(value)) return null
  return Number(value)
}

function readList(key, inline, block, lineNumber, data, where, add) {
  const items = []
  if (inline !== '') {
    if (block.length > 0) add(block[0].line, `${key} is either [ ] on its line or a list under it`)
    try {
      const value = wholeFlow(inline)
      if (!Array.isArray(value)) throw new Error('not a list')
      for (const item of value) items.push({ value: item, line: lineNumber })
    } catch (error) { add(lineNumber, `${key}: ${error.message}`) }
  } else {
    for (const one of block) {
      const entry = /^ {2}- (.+)$/u.exec(one.text)
      if (!entry) { add(one.line, `${key} is a list: each line "  - item"`); continue }
      try { items.push({ value: itemValue(entry[1]), line: one.line }) } catch (error) { add(one.line, `${key}: ${error.message}`) }
    }
  }
  where.items[key] = items.map((item) => item.line - 1)
  const fields = ITEM_FIELDS[key]
  for (const { value, line } of items) {
    if (!fields) {
      if (typeof value !== 'string' || value === '') add(line, `${key} holds plain text items`)
      else data[key].push(value)
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { add(line, `${key} holds {${fields.required.join(', ')}} items`); continue }
    for (const field of Object.keys(value)) if (![...fields.required, ...fields.optional].includes(field)) add(line, `${key}: unknown field ${field}`)
    for (const field of fields.required) if (typeof value[field] !== 'string' || value[field] === '') add(line, `${key} item has no ${field}`)
    if (key === 'prepared') preparedProblems(value, line, add)
    data[key].push(value)
  }
}

function preparedProblems(need, line, add) {
  if (need.kind !== undefined && !PREPARED_KINDS.includes(need.kind)) add(line, `prepared kind "${need.kind}" is none of ${PREPARED_KINDS.join(', ')}`)
  if (need.because) return
  if (!need.target) add(line, `prepared ${need.kind ?? 'need'} names no target`)
  if (need.kind === 'owner step') return
  if (!need.check) add(line, `prepared ${need.target ?? need.kind ?? 'need'} has no check: how the run checks it`)
  if (!need.checked) add(line, `prepared ${need.target ?? need.kind ?? 'need'} has no date: checked: YYYY-MM-DD`)
  else if (!realDate(need.checked)) add(line, `prepared ${need.target ?? need.kind ?? 'need'}: checked "${need.checked}" is not a date`)
}

/** The fields run_needs.py's parse_needs gives for Run needs, plus what only the file says. */
export function fieldsFrom(data) {
  const money = data.limits.money_usd
  return {
    rounds: data.limits.repair_rounds?.limit ?? DEFAULT_ROUNDS,
    deferrable: data.deferrable.map((one) => `${one.what}: ${one.when}`),
    money_cap: money ? money.limit : null,
    named_actions: data.may.length > 0 ? data.may.join('; ') : null,
    prepared: data.prepared.map((one) => ({ kind: one.kind ?? null, target: one.target ?? null, check: one.check ?? null, checked: one.checked ?? null, none_because: one.because ?? null })),
    messages: data.messages.map((one) => ({ people: [one.person], destination: one.destination, purpose: one.purpose })),
    limits: data.limits,
    may: data.may,
    stays_out: data.stays_out
  }
}

// ---------------------------------------------------------------------------------------------
// The file, on disk and in the plan's history

export function allowanceName(epic) { return `${String(epic).padStart(3, '0')}.yaml` }

function namesFor(names, epic) {
  return names.filter((name) => new RegExp(`^0*${epic}\\.yaml$`, 'u').test(name))
}

/** The file's name in `plan/allowances/`, or null; more than one is a problem `check` reports and a go refuses. */
export function allowanceFileName(planRoot, epic) {
  let names
  try { names = readdirSync(join(planRoot, 'allowances')) } catch { return null }
  const matching = namesFor(names, epic)
  return matching.length === 1 ? matching[0] : null
}

/** The text of an epic's file in the working plan, or null. */
export function allowanceText(planRoot, epic) {
  const name = allowanceFileName(planRoot, epic)
  return name === null ? null : readFileSync(join(planRoot, 'allowances', name), 'utf8')
}

function gitRun(repo, args, { input, env = {} } = {}) {
  const inherited = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete inherited[name]
  const done = spawnSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000, env: { ...inherited, LC_ALL: 'C', ...env } })
  if (done.error || done.status !== 0) {
    const reason = (done.stderr || done.error?.message || '').trim().split('\n')[0].slice(0, 200)
    throw Object.assign(new Error(`git ${args[0]} failed${reason ? `: ${reason}` : ''}`), { git: true })
  }
  return done.stdout
}

function showFile(repo, commit, path) {
  try { return gitRun(repo, ['show', `${commit}:${path}`]) } catch { return null }
}

/** Where the plan's history is, and the allowances folder inside it, as `bmn plan go` reads them. */
function historyOf(plan) {
  const repo = plan.history === 'plan-repository' ? plan.planRoot : plan.boardCheckout
  const prefix = relative(repo, plan.planRoot).split(sep).filter(Boolean).join('/')
  return { repo, folder: `${prefix === '' ? '' : `${prefix}/`}allowances`, boardRel: relative(repo, plan.boardPath).split(sep).join('/') }
}

/** The path of an epic's file in a commit's tree, or null. */
function pathAt(repo, folder, commit, epic) {
  let names
  try { names = gitRun(repo, ['ls-tree', '--name-only', `${commit}:${folder}`]).split('\n').filter(Boolean) } catch { return null }
  const matching = namesFor(names, epic)
  return matching.length === 1 ? `${folder}/${matching[0]}` : null
}

/** The text of an epic's file as a commit holds it (the go's hash), or null. */
export function allowanceTextAt(plan, commit, epic) {
  const { repo, folder } = historyOf(plan)
  const path = pathAt(repo, folder, commit, epic)
  return path === null ? null : showFile(repo, commit, path)
}

export function allowancePathAt(plan, commit, epic) {
  const { repo, folder } = historyOf(plan)
  return pathAt(repo, folder, commit, epic)
}

const textSha = (text) => createHash('sha256').update(String(text).replace(/\r\n?/gu, '\n')).digest('hex')

function rowStatus(text, epic) {
  return new RegExp(`^ {2}epic-${epic}:[ \\t]*([\\w-]+)`, 'mu').exec(text ?? '')?.[1] ?? null
}

function trailer(message, name) { return new RegExp(`^${name}: (.+)$`, 'mu').exec(message)?.[1].trim() ?? null }

/**
 * What the plan's history records for an epic (D13): the go's commit decides; if it holds the file the run has that
 * version, then the last recorded `allow` after that go, whether or not the file is on disk now. A go whose commit holds
 * none returns the epic to its Run needs. `at` names the go's commit; without it the latest recorded go.
 */
export async function readAllowances(plan, epic, { at = null } = {}) {
  const base = { epic, file: `allowances/${allowanceFileName(plan.planRoot, epic) ?? allowanceName(epic)}` }
  const working = allowanceFileName(plan.planRoot, epic) === null ? null : allowanceText(plan.planRoot, epic)
  const draft = () => {
    if (working === null) return { ...base, state: 'none', reason: 'this epic has no allowances file; its Run needs hold' }
    const parsed = parseAllowances(working, epic)
    return { ...base, state: 'draft', reason: 'no go records this file yet; it grants nothing', problems: parsed.problems, draft: parsed.problems.length === 0 ? fieldsFrom(parsed.data) : null }
  }
  if (plan.format !== 'bmn-plan' || plan.history === 'none') return draft()
  const { repo, folder, boardRel } = historyOf(plan)
  let go = at
  if (go !== null) {
    try { go = gitRun(repo, ['rev-parse', '--verify', '--quiet', `${at}^{commit}`]).trim() } catch { throw new AllowRefusal('NO_COMMIT', `--at ${at} is no commit of the plan's history`) }
  } else {
    go = gitRun(repo, ['log', '-1', '--format=%H', '-E', `--grep=^Go-Epic: 0*${epic}[[:space:]]*$`, 'HEAD']).trim() || null
  }
  if (go === null) return draft()
  const goMessage = gitRun(repo, ['log', '-1', '--format=%B', go])
  if (trailer(goMessage, 'Go-Epic') !== String(epic)) return { ...base, state: 'not_recorded', go_commit: go, reason: `commit ${go.slice(0, 12)} is no go bmn plan go recorded for epic ${epic}; it grants nothing` }
  const goPath = pathAt(repo, folder, go, epic)
  const headPath = pathAt(repo, folder, 'HEAD', epic)
  if (goPath === null) {
    const stray = working !== null || headPath !== null
    return { ...base, state: 'none', go_commit: go, reason: 'the go\'s commit holds no allowances file; its Run needs hold', hand_edit: stray ? 'a file exists that the go\'s commit does not hold: it grants nothing until a new go records it' : null }
  }
  const goText = showFile(repo, go, goPath)
  const goParsed = parseAllowances(goText, epic)
  if (goParsed.problems.length > 0) return { ...base, state: 'invalid', go_commit: go, reason: `the go's file does not read: line ${goParsed.problems[0].line}: ${goParsed.problems[0].reason}; it grants nothing`, problems: goParsed.problems }

  let text = goText
  let commit = go
  const changes = []
  const log = gitRun(repo, ['log', '--reverse', '--topo-order', '--format=%H%x1f%B%x1e', '-E', `--grep=^Allow-Epic: 0*${epic}[[:space:]]*$`, `${go}..HEAD`])
  for (const record of log.split('\x1e')) {
    const [hash, message = ''] = record.replace(/^\n/u, '').split('\x1f')
    if (!/^[0-9a-f]{40,64}$/u.test(hash)) continue
    const path = pathAt(repo, folder, hash, epic)
    const then = path === null ? null : showFile(repo, hash, path)
    // Each recorded change names the version it changed: anything else is not one of them.
    if (then === null || trailer(message, 'Allow-Go') !== go || trailer(message, 'Allow-Before') !== `sha256:${textSha(text)}` || trailer(message, 'Allow-After') !== `sha256:${textSha(then)}`) continue
    if (parseAllowances(then, epic).problems.length > 0) continue
    text = then
    commit = hash
    changes.push({ commit: hash, change: [...message.matchAll(/^Allow-Change: (.+)$/gmu)].map((one) => one[1]), who: trailer(message, 'Allow-Who'), reason: trailer(message, 'Allow-Reason'), source: trailer(message, 'Approval-Source') })
  }
  const parsed = parseAllowances(text, epic)
  const recordedName = goPath.slice(goPath.lastIndexOf('/') + 1)
  const result = {
    ...base, file: `allowances/${recordedName}`, state: 'recorded', go_commit: go,
    token: createHash('sha256').update(`${go}\n${textSha(text)}`).digest('hex').slice(0, 16),
    at_go: { commit: go, sha256: textSha(goText), text: goText, fields: fieldsFrom(goParsed.data) },
    current: { commit, source: commit === go ? 'go' : 'allow', sha256: textSha(text), text, fields: fieldsFrom(parsed.data) },
    changes, hand_edit: null
  }
  const headText = headPath === null ? null : showFile(repo, 'HEAD', headPath)
  if (working === null) result.hand_edit = 'the file is deleted on disk; the last recorded version stands'
  else if (textSha(working) !== textSha(text)) result.hand_edit = 'the working file differs from the last recorded version; the recorded one stands'
  else if (headText === null || textSha(headText) !== textSha(text)) result.hand_edit = 'the plan\'s history holds another text than the last recorded version; the recorded one stands'

  // A withdrawn go or a held conflict grants nothing (110.5 AC7), as run_needs.py reads them.
  const withdrawn = (status) => status === null || status === 'backlog' || status === 'dropped'
  let boardNow = null
  try { boardNow = readFileSync(plan.boardPath, 'utf8') } catch { /* no board: nothing confirms the go */ }
  if (withdrawn(rowStatus(showFile(repo, 'HEAD', boardRel), epic)) || withdrawn(rowStatus(boardNow, epic))) return { ...result, state: 'withdrawn', reason: 'the epic\'s row was put back after its go; this grants nothing until his next go' }
  if (plan.tracked) {
    const { publicationState } = await import('./plan-publish.mjs')
    const publication = publicationState(plan)
    if (publication.authority_unconfirmed) return { ...result, state: 'conflict', reason: 'the plan\'s publication journal cannot be confirmed; this grants nothing until it reads' }
    if (publication.conflicts?.includes(epic)) return { ...result, state: 'conflict', reason: 'local and upstream plan values conflict for this epic; this grants nothing until it is settled' }
  }
  return result
}

/** What `bmn plan check` reports about the files (110.4 AC1, AC5; a missing file from rules_from_allowances on). */
export async function allowanceFindings(plan, board, epicNumbers) {
  const findings = []
  const add = (where, reason) => findings.push({ where, reason })
  let names = []
  try { names = readdirSync(join(plan.planRoot, 'allowances')) } catch { /* no folder */ }
  const seen = new Map()
  for (const name of names) {
    const at = `plan/allowances/${name}`
    const number = /^(\d+)\.yaml$/u.exec(name)
    if (!number) { add(at, 'not NNN.yaml, an epic\'s number'); continue }
    const epic = Number(number[1])
    if (seen.has(epic)) add(at, `a second file for epic ${epic} (also plan/allowances/${seen.get(epic)})`)
    seen.set(epic, name)
    if (!epicNumbers.has(epic)) add(at, `epic ${epic} has no epic file`)
    let parsed
    try { parsed = parseAllowances(readFileSync(join(plan.planRoot, 'allowances', name), 'utf8'), epic) } catch { add(at, 'unreadable'); continue }
    for (const problem of parsed.problems) add(`${at}:${problem.line}`, problem.reason)
  }
  if (board.rules?.allowances !== undefined) {
    for (const epic of epicNumbers) if (epic >= board.rules.allowances && !seen.has(epic)) add('plan/allowances', `epic ${epic} has no allowances file (epics from ${board.rules.allowances} on)`)
  }
  // A plan with no history of its own on record (none, or a staged copy such as the cutover's) has no recorded version to compare.
  if (plan.format !== 'bmn-plan' || plan.history === undefined || plan.history === 'none') return findings
  // A version on record and a file that says otherwise: reported, and the reader keeps the recorded one.
  for (const epic of epicNumbers) {
    const { repo, folder } = historyOf(plan)
    if (!seen.has(epic) && pathAt(repo, folder, 'HEAD', epic) === null) {
      let touched = ''
      try { touched = gitRun(repo, ['log', '-1', '--format=%H', 'HEAD', '--', `${folder}/${allowanceName(epic)}`]).trim() } catch { /* an unborn history */ }
      if (touched === '') continue
    }
    let read
    try { read = await readAllowances(plan, epic) } catch { continue }
    if (read.hand_edit) add(`plan/allowances/${allowanceName(epic)}`, read.hand_edit)
  }
  return findings
}

// ---------------------------------------------------------------------------------------------
// `bmn plan allow`: one change, against the last recorded version

const needsQuotes = (text) => text === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]/u.test(text) || /[,{}[\]]|: | #|\s$/u.test(text)
function renderScalar(value) {
  const text = String(value)
  return needsQuotes(text) ? JSON.stringify(text) : text
}
function renderMap(map) {
  return `{${Object.entries(map).map(([key, value]) => `${key}: ${renderScalar(value)}`).join(', ')}}`
}
const renderItem = (item) => (typeof item === 'string' ? renderScalar(item) : renderMap(item))

/** A limit's map as the file should hold it: its given fields, in the order they had. */
function limitMapFromLine(line) {
  const body = withoutComment(line)
  return wholeFlow(body.slice(body.indexOf(':') + 1).trim())
}

function replaceLimitLine(line, map) {
  const comment = line.slice(withoutComment(line).length)
  const body = withoutComment(line)
  const colon = body.indexOf(':')
  const gap = /^:[ \t]*/u.exec(body.slice(colon))[0]
  return `${body.slice(0, colon)}${gap}${renderMap(map)}${comment}`
}

const CHANGE = /^(?:limits\.([a-z][a-z0-9_]*)(?:\.(limit|ceiling|per|unit))?|(may|stays_out|deferrable|messages|prepared)|prepared\.(.+?)\.(kind|target|check|checked))(\+=|-=|=)(.*)$/su

/** The changes a command line names, read; a wrong form is a usage refusal, before anything is looked at. */
export function parseChanges(words) {
  return words.map((word) => {
    const match = CHANGE.exec(word)
    if (!match) throw new AllowRefusal('BAD_CHANGE', `"${word}" is no change: limits.NAME.limit=N, limits.NAME={...}, may+=TEXT, stays_out+=TEXT, prepared.TARGET.checked=DATE`)
    const [, limit, field, list, target, needField, op, value] = match
    if ((limit || target) && op !== '=') throw new AllowRefusal('BAD_CHANGE', `"${word}": a limit or a prepared field takes =; += and -= are for may, stays_out, deferrable, messages and prepared`)
    if (list && op === '=') throw new AllowRefusal('BAD_CHANGE', `"${word}": ${list} takes += or -=`)
    return { limit, field, list, target, needField, op, value, word }
  })
}

function rewriteList(parsed, key, items) {
  const rendered = items.length === 0 ? [`${key}: []`] : [`${key}:`, ...items.map((item) => `  - ${renderItem(item)}`)]
  const lines = [...parsed.lines]
  const place = parsed.where.top[key]
  if (place) lines.splice(place.start, place.end - place.start, ...rendered)
  else {
    while (lines.length > 0 && lines.at(-1) === '') lines.pop()
    lines.push(...rendered, '')
  }
  return lines.join('\n')
}

function applyChange(text, change) {
  const parsed = parseAllowances(text)
  const lines = [...parsed.lines]
  if (change.limit) {
    const name = change.limit
    const at = parsed.where.limits[name]
    if (change.field) {
      if (at === undefined) throw new AllowRefusal('NO_SUCH_FIELD', `limits.${name} is not in the recorded file`)
      const map = limitMapFromLine(lines[at])
      if (change.value === '') delete map[change.field]
      else map[change.field] = change.value
      lines[at] = replaceLimitLine(lines[at], map)
      return lines.join('\n')
    }
    if (change.value === '') {
      if (at === undefined) throw new AllowRefusal('NO_SUCH_FIELD', `limits.${name} is not in the recorded file`)
      lines.splice(at, 1)
      return lines.join('\n')
    }
    let map
    try { map = wholeFlow(change.value) } catch (error) { throw new AllowRefusal('BAD_CHANGE', `limits.${name}: ${error.message}`) }
    if (at !== undefined) { lines[at] = replaceLimitLine(lines[at], map); return lines.join('\n') }
    const rendered = `  ${name}: ${renderMap(map)}`
    const section = parsed.where.top.limits
    if (!section) {
      while (lines.length > 0 && lines.at(-1) === '') lines.pop()
      lines.push('limits:', rendered, '')
    } else {
      lines[section.start] = 'limits:'
      lines.splice(section.end, 0, rendered)
    }
    return lines.join('\n')
  }
  if (change.target) {
    const items = parsed.data.prepared.map((one) => ({ ...one }))
    const need = items.find((one) => one.target === change.target)
    if (!need) throw new AllowRefusal('NO_SUCH_FIELD', `no prepared need targets "${change.target}"`)
    need[change.needField] = change.value
    return rewriteList(parsed, 'prepared', items)
  }
  const key = change.list
  let item = change.value
  if (ITEM_FIELDS[key]) {
    try { item = wholeFlow(change.value) } catch (error) { throw new AllowRefusal('BAD_CHANGE', `${key}: ${error.message}`) }
  }
  const items = [...parsed.data[key]]
  const same = (one) => JSON.stringify(one) === JSON.stringify(item)
  if (change.op === '+=') {
    if (items.some(same)) throw new AllowRefusal('NOTHING_CHANGES', `${key} already holds ${renderItem(item)}`)
    items.push(item)
  } else {
    if (!items.some(same)) throw new AllowRefusal('NO_SUCH_FIELD', `${key} holds no ${renderItem(item)}`)
    items.splice(items.findIndex(same), 1)
  }
  return rewriteList(parsed, key, items)
}

const shown = (value) => (value === undefined ? '(none)' : typeof value === 'object' ? JSON.stringify(value) : String(value))

/** Each field's before and after, and what of it D7 leaves to his words, against the last recorded version. */
export function compareVersions(before, after, uses = () => false) {
  const changes = []
  const words = []
  const frozen = []
  const change = (field, was, now) => changes.push({ field, before: shown(was), after: shown(now) })
  for (const name of new Set([...Object.keys(before.limits), ...Object.keys(after.limits)])) {
    const was = before.limits[name]
    const now = after.limits[name]
    if (!was) { change(`limits.${name}`, undefined, now); words.push(`a new limit, ${name}`); continue }
    if (!now) {
      change(`limits.${name}`, was, undefined)
      if (uses(name)) frozen.push(`limit ${name} has uses in the ledger and cannot be removed or renamed; a different measure is a new limit`)
      else words.push(`removing limit ${name}`)
      continue
    }
    for (const field of LIMIT_FIELDS) {
      if (was[field] === now[field]) continue
      change(`limits.${name}.${field}`, was[field], now[field])
      if ((field === 'per' || field === 'unit') && uses(name)) frozen.push(`limit ${name} has uses in the ledger, so its ${field} cannot change; a different measure is a new limit`)
      else if (field !== 'limit') words.push(`a changed ${field} on ${name}`)
      else if (now.limit > was.limit && (was.ceiling === undefined || now.limit > was.ceiling)) {
        words.push(was.ceiling === undefined ? `raising ${name}, which has no ceiling` : `${name} ${now.limit} is over its ceiling ${was.ceiling}`)
      }
    }
  }
  const listDiffers = (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])
  for (const key of ['may', 'messages', 'deferrable']) {
    if (listDiffers(key)) { change(key, before[key], after[key]); words.push(`a change to ${key}`) }
  }
  if (listDiffers('stays_out')) {
    change('stays_out', before.stays_out, after.stays_out)
    const removed = before.stays_out.filter((one) => !after.stays_out.includes(one))
    if (removed.length > 0) words.push(`a removal from stays_out (${removed.join(', ')})`)
  }
  if (listDiffers('prepared')) {
    change('prepared', before.prepared, after.prepared)
    const without = (list) => JSON.stringify(list.map((need) => ({ ...need, checked: null })))
    if (without(before.prepared) !== without(after.prepared)) words.push('a Prepared change other than its checked date')
  }
  return { changes, words, frozen }
}

/**
 * What the ledger counted for each limit (110.5 AC4): the budgets dev-auto keeps for this plan and epic, found by its own
 * ids. One of them that cannot be read, or ids that cannot be confirmed, count as uses of every limit, so a frozen field
 * stays frozen.
 */
export function ledgerUses(plan, epic, environment = process.env) {
  const folder = ledgerFolder(environment)
  const counted = new Set()
  let unreadable = false
  let names
  // No folder: dev-auto never counted anything here. A folder that cannot be listed may hold uses, so everything freezes.
  try { names = readdirSync(folder) } catch (error) { return error?.code === 'ENOENT' ? () => false : () => true }
  // Dev-auto's own ids for this plan; when they cannot be confirmed, nothing is known to be unused.
  let ids
  try { ids = ledgerIds(plan, epic, folder) } catch { return () => true }
  const root = realPath(plan.planRoot)
  for (const name of names) {
    if (!ledgerName(epic).test(name)) continue
    const id = name.slice(0, -'.json'.length)
    let data
    try { data = JSON.parse(readFileSync(join(folder, name), 'utf8')) } catch { if (ids.has(id)) unreadable = true; continue }
    // Its id, or the folder recorded in it exactly (a ledger opened by an older dev-auto).
    if (!data || typeof data !== 'object' || !(ids.has(id) || (typeof data.plan_root === 'string' && realPath(data.plan_root) === root))) continue
    for (const use of Object.values(data.uses ?? {})) if (use?.answer === 'TAKEN' && typeof use.limit === 'string') counted.add(use.limit)
    if (Object.values(data.rounds ?? {}).some((use) => use?.answer === 'TAKEN')) counted.add('repair_rounds')
    if (Object.values(data.jobs ?? {}).some((job) => job && !['refused', 'released'].includes(job.state))) counted.add('money_usd')
  }
  return (limit) => unreadable || counted.has(limit)
}

// ---------------------------------------------------------------------------------------------
// Which ledgers are this plan's: the ids dev-auto's spend_ledger.py gives them (`plan_identity`, `location_identity`,
// `resolve_budget`), computed the same way, so a moved plan keeps its ledger and another plan's never counts.

class LedgerOwnerUnconfirmed extends Error {}
const unconfirmed = (why) => new LedgerOwnerUnconfirmed(why)
const realPath = (path) => { try { return realpathSync(path) } catch { return resolve(path) } }
const posixRelative = (from, to) => relative(from, to).split(sep).join('/') || '.'
const sha16 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
const MOVED_FROM = /^moved_from:\s*([^\s#]+)/mu
const BUDGET_ID = /^[0-9a-f]{16}-epic-\d+$/u

function repositoryOf(root) {
  const [top, common] = gitRun(root, ['rev-parse', '--show-toplevel', '--git-common-dir']).split('\n')
  return { top: realPath(top), common: realPath(isAbsolute(common) ? common : join(root, common)) }
}

/** spend_ledger.py `location_identity`: the plan as every linked worktree sees it, or the folder itself outside Git. */
export function locationIdentity(planRoot) {
  const root = realPath(planRoot)
  try { const { top, common } = repositoryOf(root); return `${common}::${posixRelative(top, root)}` } catch { return root }
}

/** run_needs.py `migration_origin`, as far as identity needs it: the first committed move's source board, or null. */
function migrationSource(repo, root) {
  const boardRel = posixRelative(repo, join(root, 'status.yaml'))
  const metaRel = posixRelative(repo, join(root, 'migration.json'))
  let header = ''
  try { header = readFileSync(join(root, 'status.yaml'), 'utf8') } catch { /* no board */ }
  const moved = MOVED_FROM.exec(header)
  let origin = null
  let commits = []
  try { commits = gitRun(repo, ['log', '--reverse', '--topo-order', '--full-history', '--diff-filter=A', '--format=%H', 'HEAD', '--', metaRel]).split(/\s+/u).filter(Boolean) } catch { /* an unborn history */ }
  for (const commit of commits) {
    try {
      const recorded = JSON.parse(gitRun(repo, ['show', `${commit}:${metaRel}`]))
      const source = recorded.source_board
      const anchor = recorded.history_head
      if (source === undefined || anchor === undefined) continue
      const committed = MOVED_FROM.exec(gitRun(repo, ['show', `${commit}:${boardRel}`]))
      if (recorded.version !== 1 || !committed || committed[1] !== source) continue
      if (typeof anchor !== 'string' || !/^[0-9a-f]{40,64}$/u.test(anchor) || gitRun(repo, ['rev-parse', `${commit}^1`]).trim() !== anchor) continue
      if (typeof source !== 'string' || posix.isAbsolute(source) || source.split('/').some((part) => part === '.' || part === '..') || posix.basename(source) !== 'sprint-status.yaml') continue
      origin = { source, anchor }
      const local = JSON.parse(gitRun(repo, ['show', `HEAD:${metaRel}`])).local_history_head
      if (local !== undefined && local !== null) {
        const named = gitRun(repo, ['log', '--reverse', '--first-parent', '--format=%H', '-G', 'local_history_head', 'HEAD', '--', metaRel]).split(/\s+/u).filter(Boolean)
        if (!/^[0-9a-f]{40,64}$/u.test(String(local)) || named.length === 0 || gitRun(repo, ['rev-parse', `${named[0]}^1`]).trim() !== local || !gitRun(repo, ['log', '-1', '--format=%B', named[0]]).includes('Plan-Cutover: yes')) {
          throw unconfirmed("the migration's local history cannot be confirmed")
        }
      }
      break
    } catch (error) {
      if (error instanceof LedgerOwnerUnconfirmed) throw error
    }
  }
  if (origin === null) {
    if (moved || existsSync(join(root, 'migration.json'))) throw unconfirmed('the migration has no confirmed committed cutover boundary')
    return null
  }
  let metadata = null
  try { metadata = JSON.parse(readFileSync(join(root, 'migration.json'), 'utf8')) } catch { /* checked below */ }
  if (!metadata || typeof metadata !== 'object' || !moved || moved[1] !== origin.source || metadata.version !== 1 || metadata.source_board !== origin.source || metadata.history_head !== origin.anchor) {
    throw unconfirmed('working migration declarations differ from the original committed move')
  }
  return origin.source
}

/** Python's `PurePosixPath(path).parent` taken `times` times, as text: empty and `.` parts dropped, `.` for none left. */
export function pythonParent(path, times) {
  const parts = path.split('/').filter((part) => part !== '' && part !== '.')
  return parts.slice(0, Math.max(0, parts.length - times)).join('/') || '.'
}

/** spend_ledger.py `plan_identity`: a moved plan keeps the identity of the board it came from. Throws when unconfirmed. */
export function planIdentity(planRoot) {
  const root = realPath(planRoot)
  let repository
  try { repository = repositoryOf(root) } catch (error) {
    if (!/not a git repository/iu.test(error.message)) throw unconfirmed('the product repository cannot be read')
    let header = ''
    try { header = readFileSync(join(root, 'status.yaml'), 'utf8') } catch { /* no board */ }
    if (MOVED_FROM.test(header) || existsSync(join(root, 'migration.json'))) throw unconfirmed('the original product repository cannot be established')
    return root
  }
  const source = migrationSource(repository.top, root)
  if (source === null) return `${repository.common}::${posixRelative(repository.top, root)}`
  if (repository.top === root) throw unconfirmed('the original product repository cannot be established')
  return `${repository.common}::${pythonParent(source, 2)}`
}

/** The ledger ids dev-auto would use for this plan's epic: the canonical one and what the location's alias names. */
export function ledgerIds(plan, epic, folder) {
  const number = String(Number(epic))
  const ids = new Set([`${sha16(planIdentity(plan.planRoot))}-epic-${number}`])
  const location = `${sha16(locationIdentity(plan.planRoot))}-epic-${number}`
  const aliasPath = join(folder, `${location}.alias.json`)
  if (!existsSync(aliasPath)) { ids.add(location); return ids }
  let value
  try { value = JSON.parse(readFileSync(aliasPath, 'utf8')) } catch { throw unconfirmed(`the alias ${location} cannot be read`) }
  const canonical = value?.canonical
  if (value?.version !== 1 || typeof canonical !== 'string' || !BUDGET_ID.test(canonical) || canonical === location || canonical.split('-epic-')[1] !== number) throw unconfirmed(`the alias ${location} is not a direct alias for this epic`)
  if (existsSync(join(folder, `${canonical}.alias.json`))) throw unconfirmed('alias chains are refused')
  if (existsSync(join(folder, `${location}.json`))) throw unconfirmed('an alias and a second data file coexist')
  ids.add(canonical)
  return ids
}

const ledgerFolder = (environment) => join(environment.XDG_STATE_HOME || join(environment.HOME || homedir(), '.local', 'state'), 'dev-auto', 'budgets')
const ledgerName = (epic) => new RegExp(`^[0-9a-f]{16}-epic-${epic}\\.json$`, 'u')

/** One budget's lock, held by a child `flock` until released: the flock(2) lock spend_ledger.py takes while it counts a use. */
function holdFlock(path, waitMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['-x', '-w', String(Math.max(1, Math.ceil(waitMs / 1000))), path, 'sh', '-c', 'echo held; exec cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdin.on('error', () => { /* the lock ends with the child either way */ })
    child.on('error', (error) => reject(new AllowRefusal('LEDGER_LOCK', `cannot take the ledger lock ${path} (${error.message}); nothing changed`)))
    child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('held\n')) resolve(() => { child.stdin.end() }) })
    child.on('exit', () => { if (!out.includes('held\n')) reject(new AllowRefusal('LEDGER_LOCKED', `${path} stays held by a use being counted; try again; nothing changed`)) })
  })
}

/**
 * Every ledger lock of this epic, held from the scan of its uses until the change is committed (D13), so a use cannot be
 * counted under a limit's old meaning in between. Taken after the board lock; a use never takes the board lock.
 */
export async function holdLedgers(epic, environment = process.env, waitMs = 10_000) {
  const folder = ledgerFolder(environment)
  let names
  try { names = readdirSync(folder) } catch (error) { if (error?.code === 'ENOENT') return () => {}; names = [] }
  const releases = []
  try {
    for (const name of names.filter((one) => ledgerName(epic).test(one)).sort()) releases.push(await holdFlock(join(folder, name.replace(/\.json$/u, '.lock')), waitMs))
  } catch (error) { for (const release of releases) release(); throw error }
  return () => { for (const release of releases) release() }
}

function ownerWordsProblem(source) {
  if (/[\r\n]/u.test(source) || [...source].length > 500) return '--source is one line of at most 500 characters'
  if (DECISION_REFERENCE.test(source)) return '--source names a BMN decision record, an agent\'s own choice; give his quoted words with their time'
  if (!(SOURCE_QUOTE.test(source) && SOURCE_TIME.test(source))) return `--source does not name an owner's act: give his quoted words with their time (YYYY-MM-DDTHH:MM); "${source.slice(0, 80)}" is not that`
  return null
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(temporary, text, { mode: 0o644 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

/** Record one or more changes as one commit of the plan's history (110.5). Everything it refuses leaves everything as it was. */
export async function recordAllow(plan, epic, { changes: words, reason, source, expect, seam = () => {} }) {
  const { lockBoard } = await import('./plan-cli.mjs')
  if (plan.defaultAvailable === false) throw new AllowRefusal('NO_DEFAULT_CHECKOUT', `no checkout holds origin/${plan.defaultBranch ?? '<default>'}; add one with git worktree add`)
  if (plan.format !== 'bmn-plan') throw new AllowRefusal('NEEDS_MOVE', 'an allowances file belongs to a BMN-format plan; move this BMAD plan first (docs/planning.md, "Moving a BMAD plan safely")')
  if (plan.history === 'none') throw new AllowRefusal('NO_HISTORY', `${plan.planRoot} keeps no Git history, so no change can be recorded there`)
  const why = typeof reason === 'string' ? reason.trim() : ''
  if (why === '' || /[\r\n]/u.test(why) || [...why].length > 500) throw new AllowRefusal('NO_REASON', '--reason is one line of at most 500 characters: why the limit changes')
  const words_ = typeof source === 'string' ? source.trim() : ''
  if (words_ !== '') {
    const problem = ownerWordsProblem(words_)
    if (problem) throw new AllowRefusal('NO_OWNER_WORDS', problem)
  }
  const changes = parseChanges(words)
  if (changes.length === 0) throw new AllowRefusal('BAD_CHANGE', 'name a change: limits.NAME.limit=N')
  const release = await lockBoard(plan.boardPath)
  let releaseLedgers = () => {}
  try {
    releaseLedgers = await holdLedgers(epic)
    const read = await readAllowances(plan, epic)
    if (read.state === 'withdrawn' || read.state === 'conflict') throw new AllowRefusal(read.state.toUpperCase(), read.reason)
    if (read.state !== 'recorded') throw new AllowRefusal('NOT_RECORDED', `epic ${epic}'s go records no allowances file: ${read.reason}`)
    if (read.hand_edit) throw new AllowRefusal('HAND_EDIT', `${read.hand_edit}; put the file back to the last recorded version (sha256:${read.current.sha256.slice(0, 12)}…) first, so an edit cannot ride on a real change`)
    if (expect !== read.token) throw new AllowRefusal('CONFLICT', `the last recorded version or the go changed (token ${read.token}, not ${expect}); read bmn plan allowances ${epic} --json again`)
    let text = read.current.text
    for (const change of changes) text = applyChange(text, change)
    const after = parseAllowances(text, epic)
    const before = parseAllowances(read.current.text, epic)
    const compared = compareVersions(before.data, after.data, ledgerUses(plan, epic))
    if (compared.changes.length === 0) throw new AllowRefusal('NOTHING_CHANGES', 'that changes nothing in the last recorded version')
    if (compared.frozen.length > 0) throw new AllowRefusal('USED', compared.frozen.join('; '))
    if (compared.words.length > 0 && words_ === '') throw new AllowRefusal('NEEDS_HIS_WORDS', `${compared.words.join('; ')} needs his words: --source gives his quoted words with their time; nothing changed`)
    if (after.problems.length > 0) throw new AllowRefusal('BAD_ALLOWANCES', `that would make line ${after.problems[0].line} wrong: ${after.problems[0].reason}`)
    const { repo, folder } = historyOf(plan)
    const relFile = `${folder}/${read.file.slice(read.file.lastIndexOf('/') + 1)}`
    const head = gitRun(repo, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
    const branch = gitRun(repo, ['symbolic-ref', '-q', 'HEAD']).trim()
    const summary = compared.changes.map((one) => `${one.field} ${one.before} -> ${one.after}`)
    const who = words_ !== '' ? 'the owner' : `the lead (session ${process.env.BMN_SESSION_ID ?? 'unknown'})`
    const firstLine = `plan: allow on Epic ${epic}: ${summary[0]}`
    const message = [
      [...firstLine].length > 100 ? `plan: allow on Epic ${epic}: ${compared.changes.length} changes` : firstLine, '',
      `Recorded by bmn plan allow: ${who} changed what a run of Epic ${epic} may use.`, '',
      `Allow-Epic: ${epic}`, `Allow-Go: ${read.go_commit}`, `Allow-Before: sha256:${read.current.sha256}`, `Allow-After: sha256:${textSha(text)}`,
      ...summary.map((one) => `Allow-Change: ${one}`), `Allow-Who: ${who}`, `Allow-Reason: ${why}`,
      ...(words_ !== '' ? [`Approval-Source: ${words_}`] : []), ''
    ].join('\n')
    const temporaryIndex = join(gitRun(repo, ['rev-parse', '--absolute-git-dir']).trim(), `bmn-plan-allow-${process.pid}-${randomBytes(3).toString('hex')}.index`)
    let created
    const parentIndex = gitRun(repo, ['ls-files', '-s', '--', relFile]).trim()
    const parentEntry = gitRun(repo, ['ls-tree', head, '--', relFile]).trim()
    try {
      const own = { env: { GIT_INDEX_FILE: temporaryIndex } }
      gitRun(repo, ['read-tree', head], own)
      const blob = gitRun(repo, ['hash-object', '-w', '--stdin'], { input: text }).trim()
      gitRun(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${relFile}`], own)
      const tree = gitRun(repo, ['write-tree'], own).trim()
      created = gitRun(repo, ['commit-tree', tree, '-p', head, '-F', '-'], { input: message }).trim()
      seam('created', created)
      gitRun(repo, ['update-ref', '-m', `bmn plan allow: epic ${epic}`, branch, created, head])
    } catch (error) {
      if (error?.git) throw new AllowRefusal('COMMIT_FAILED', `the change could not be committed in ${repo} (${error.message}); nothing changed`)
      throw error
    } finally { rmSync(temporaryIndex, { force: true }) }
    // The working file and an unstaged index entry follow the commit; a staged change of it would have been refused above.
    atomicWrite(join(repo, relFile), text)
    try {
      const entry = /^(\d+) ([0-9a-f]+)\t/u.exec(parentEntry.replace(/^(\d+) blob /u, '$1 '))
      if (parentIndex === '' || (entry && parentIndex.startsWith(`${entry[1]} ${entry[2]} 0`))) {
        const blob = gitRun(repo, ['rev-parse', `${created}:${relFile}`]).trim()
        gitRun(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${relFile}`])
      }
    } catch { /* the change stands; an index entry left behind only shows as a staged change */ }
    const back = await readAllowances(plan, epic)
    if (back.state !== 'recorded' || back.current.commit !== created) throw new AllowRefusal('READBACK', `commit ${created} does not read back as the recorded version; see git -C ${repo} show ${created.slice(0, 12)}`)
    return { commit: created, changes: compared.changes, token: back.token, repo, needed_words: compared.words, fields: back.current.fields }
  } finally { releaseLedgers(); release() }
}

/** Rules a plan opts into: stories and criteria of an unfinished epic (110.8, D11). */
export const SIZE_LIMIT = { stories: 10, criteria: 50 }

/** Whether the epic's Decisions quote his word for its size: a decision of his, quoted, about the size. */
export function ownerApprovedSize(decisions) {
  return (decisions ?? '').split('\n').some((line) => /\bowner\b/iu.test(line) && SOURCE_QUOTE.test(line) && /\b(?:size|stories|criteria)\b/iu.test(line))
}

