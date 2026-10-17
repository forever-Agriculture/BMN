// MODULE: plan-cli.mjs - Epic 77: `bmn plan status|check|set`, the project's planning board from the shell; works with BMN closed
import { randomBytes, createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  BMAD_STATUSES, EXIT, FORMAT, NOTE_LIMIT, PlanError, ROW, STATUSES, boardBytes, checkPlan, readBoard, resolvePlan, rowToken
} from './plan-board.mjs'

export const PLAN_USAGE = `Usage: bmn plan status [--json] [--project P] [--epic N]...
       bmn plan check [--json] [--project P]
       bmn plan set <row> <status> --expect TOKEN [--expect-default TOKEN] [--note TEXT] [--project P] [--json]

The project's planning: its plan and its board, in BMN's own format (plan/PLAN.md, plan/status.yaml,
plan/epics/NNN-slug.md; docs/planning.md) or in BMAD's (_bmad-output/.../sprint-status.yaml). This is
not the subscription's Plan use. It needs no BMN running.

status  prints the board's rows, every one of them, with the resolved paths: product root, default and
        run checkout, plan root, board, format and history. --epic narrows to those epics (repeatable).
        --json gives every selected row with its line and row token, and errors as codes.
check   structural validation, one finding per line: duplicate keys, malformed rows, unknown statuses,
        notes over ${NOTE_LIMIT} characters, stories without rows and rows without stories, duplicate
        identifiers, missing sections, stories without criteria or Verification, queue problems, a done
        epic with unfinished stories, blocked/paused/dropped rows without a reason, files over their
        ceiling. A BMAD board is checked for duplicate keys and row grammar only. Whether the plan says
        the right thing is the readiness method's and review's, not this command's.
set     changes one row's status (and note with --note; without it the note is kept) after checking that
        the row still matches TOKEN, the row token status --json printed. It locks the board, rereads it,
        changes that one line, keeps every other byte and the file's mode, and writes atomically; the
        version before is kept in ~/.local/state/bmn/plan-versions (the last 20). A board tracked by the
        product repository and read from a linked worktree is changed in both copies, the default
        checkout's too; when that copy's row differs, --expect-default gives its token.

Statuses (BMN's format): ${STATUSES.join(', ')}. BMAD boards take BMAD's: ${BMAD_STATUSES.join(', ')}.
Exit status: 0 done or no findings, 1 findings (check) or a refused or conflicting change (set),
             2 usage error, unknown row or status, or a plan that cannot be resolved or read`

/** Written synchronously and whole: a full board as JSON is more than a pipe takes in one write. */
function write(descriptor, text) {
  const bytes = Buffer.from(text.endsWith('\n') ? text : `${text}\n`)
  for (let offset = 0; offset < bytes.length;) {
    try { offset += writeSync(descriptor, bytes, offset) } catch (error) {
      if (error.code !== 'EAGAIN') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
}
function out(text) { write(1, text) }
function err(text) { write(2, text) }

class PlanUsageError extends Error {}

function parse(argv, { flags, values, repeated = [] }) {
  const positionals = []
  const options = Object.create(null)
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--') { positionals.push(...argv.slice(index + 1)); break }
    if (!argument.startsWith('--')) {
      if (argument.startsWith('-') && argument !== '-') throw new PlanUsageError(`unknown option ${argument}`)
      positionals.push(argument)
      continue
    }
    const equals = argument.indexOf('=')
    const name = argument.slice(2, equals === -1 ? undefined : equals)
    if (flags.includes(name)) {
      if (equals !== -1) throw new PlanUsageError(`--${name} does not take a value`)
      if (options[name] !== undefined) throw new PlanUsageError(`--${name} given more than once`)
      options[name] = true
      continue
    }
    if (!values.includes(name) && !repeated.includes(name)) throw new PlanUsageError(`unknown option --${name}`)
    const value = equals !== -1 ? argument.slice(equals + 1) : argv[index + 1]
    if (value === undefined) throw new PlanUsageError(`--${name} requires a value`)
    if (equals === -1) index++
    if (repeated.includes(name)) (options[name] ??= []).push(value)
    else if (options[name] !== undefined) throw new PlanUsageError(`--${name} given more than once`)
    else options[name] = value
  }
  return { positionals, options }
}

function failure(error, json) {
  const code = error instanceof PlanError ? error.code : 'UNREADABLE'
  const message = error instanceof PlanError ? error.message : `the plan could not be read: ${error.message}`
  if (json) out(JSON.stringify({ ok: false, error: { code, message } }, null, 2))
  else err(`bmn: ${code}: ${message}`)
  return EXIT.unable
}

function resolvedFields(plan) {
  return {
    product_root: plan.productRoot, default_checkout: plan.defaultCheckout, run_checkout: plan.runCheckout, plan_root: plan.planRoot,
    board: plan.boardPath, board_checkout: plan.boardCheckout, format: plan.format, tracked: plan.tracked, history: plan.history
  }
}

function headerLines(plan) {
  const bytes = boardBytes(plan.boardPath)
  return [
    `product root     ${plan.productRoot}`,
    `default checkout ${plan.defaultCheckout}`,
    `run checkout     ${plan.runCheckout}`,
    `plan root        ${plan.planRoot}`,
    `board            ${plan.boardPath}${bytes === null ? '' : ` (${bytes} bytes)`}`,
    `format           ${plan.format === FORMAT ? `${FORMAT} (BMN)` : 'bmad'}; ${plan.tracked ? 'tracked by the product repository' : 'not tracked: read from the default checkout'}; history ${plan.history}`
  ]
}

/** A row on one terminal line: the note is clipped for display only, marked with an ellipsis; no row is dropped. */
function rowLine(row, width) {
  const head = `${row.key}: ${row.status}`
  if (row.note === '') return head
  const room = Math.max(20, width - head.length - 3)
  const note = [...row.note]
  return `${head} # ${note.length > room ? `${note.slice(0, room - 1).join('')}…` : row.note}`
}

function epicNumbers(values) {
  const numbers = []
  for (const value of values ?? []) {
    for (const part of String(value).split(',')) {
      if (!/^\d{1,6}$/u.test(part.trim())) throw new PlanUsageError(`--epic takes epic numbers, not ${part}`)
      numbers.push(Number(part.trim()))
    }
  }
  return numbers
}

async function status(argv) {
  const { positionals, options } = parse(argv, { flags: ['json'], values: ['project'], repeated: ['epic'] })
  if (positionals.length > 0) throw new PlanUsageError('plan status takes no arguments')
  const epics = epicNumbers(options.epic)
  const json = options.json === true
  let plan, board
  try {
    plan = await resolvePlan(options.project ?? process.cwd())
    board = await readBoard(plan.boardPath, { epics })
  } catch (error) { return failure(error, json) }
  const missing = epics.filter((epic) => !board.rows.some((row) => row.epic === epic))
  if (json) {
    out(JSON.stringify({
      ok: true, ...resolvedFields(plan), schema_version: board.schemaVersion, queue: board.queue,
      epics, rows: board.rows.map(({ key, status, note, line, epic, story, token }) => ({ key, status, note, line, epic, story, token })),
      total_rows: board.totalRows, errors: missing.map((epic) => ({ code: 'NO_ROWS', epic, message: `no rows for epic ${epic}` }))
    }, null, 2))
    return EXIT.ok
  }
  const width = Math.max(60, process.stdout.columns ?? 160)
  const lines = headerLines(plan)
  if (plan.format === FORMAT) lines.push(`queue            ${board.queue.length === 0 ? '(empty)' : board.queue.join(' → ')}`)
  lines.push('')
  for (const row of board.rows) lines.push(rowLine(row, width))
  lines.push('', `${board.rows.length} row${board.rows.length === 1 ? '' : 's'}${epics.length > 0 ? ` of ${board.totalRows}` : ''}; notes clipped for display (… marks one), --json gives them whole`)
  for (const epic of missing) lines.push(`no rows for epic ${epic}`)
  out(lines.join('\n'))
  return EXIT.ok
}

async function check(argv) {
  const { positionals, options } = parse(argv, { flags: ['json'], values: ['project'] })
  if (positionals.length > 0) throw new PlanUsageError('plan check takes no arguments')
  const json = options.json === true
  let plan, result
  try {
    plan = await resolvePlan(options.project ?? process.cwd())
    result = await checkPlan(plan)
  } catch (error) { return failure(error, json) }
  if (json) out(JSON.stringify({ ok: result.findings.length === 0, ...resolvedFields(plan), findings: result.findings }, null, 2))
  else if (result.findings.length === 0) out(`PASS: ${plan.format === FORMAT ? 'plan' : 'BMAD board'} ${plan.boardPath} (${result.board.totalRows} rows; structure only)`)
  else out(result.findings.map((finding) => `${finding.where}: ${finding.reason}`).join('\n'))
  return result.findings.length === 0 ? EXIT.ok : EXIT.findings
}

// ---------------------------------------------------------------------------------------------
// One row, safely (77.2)

export const KEPT_VERSIONS = 20
export const SET_RETRIES = 5
const LOCK_WAIT_MS = 5_000

export function versionsDirectory(boardPath, environment = process.env) {
  const state = environment.XDG_STATE_HOME || join(environment.HOME || homedir(), '.local', 'state')
  let physical = boardPath
  try { physical = realpathSync(boardPath) } catch { /* named as given */ }
  return join(state, 'bmn', 'plan-versions', createHash('sha256').update(physical).digest('hex').slice(0, 16))
}

/** Keep the version before a change, outside the project; the last KEPT_VERSIONS stay. */
export function keepVersion(boardPath, text, environment = process.env) {
  const directory = versionsDirectory(boardPath, environment)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, 'board-path.txt'), `${boardPath}\n`, { mode: 0o600 })
  const name = `${new Date().toISOString().replaceAll(':', '-')}-${String(process.hrtime.bigint() % 10n ** 15n).padStart(15, '0')}-${randomBytes(2).toString('hex')}.yaml`
  writeFileSync(join(directory, name), text, { mode: 0o600 })
  const versions = readdirSync(directory).filter((entry) => entry.endsWith('.yaml')).sort()
  for (const old of versions.slice(0, Math.max(0, versions.length - KEPT_VERSIONS))) rmSync(join(directory, old), { force: true })
  return join(directory, name)
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

/** A stable sibling lock, `.<board>.lock`, present only while a writer changes the board; a dead holder's lock is cleared. */
export async function lockBoard(boardPath, { waitMs = LOCK_WAIT_MS } = {}) {
  const path = join(dirname(boardPath), `.${basename(boardPath)}.lock`)
  const until = Date.now() + waitMs
  for (;;) {
    try {
      const descriptor = openSync(path, 'wx', 0o600)
      writeSync(descriptor, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`)
      closeSync(descriptor)
      return () => { try { unlinkSync(path) } catch { /* already gone */ } }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    let holder = null
    try { holder = JSON.parse(readFileSync(path, 'utf8')) } catch { /* being written, or not ours */ }
    if (holder && Number.isSafeInteger(holder.pid) && !processAlive(holder.pid)) { rmSync(path, { force: true }); continue }
    if (Date.now() >= until) throw new PlanError('LOCKED', `${path} is held${holder?.pid ? ` by process ${holder.pid}` : ''}; try again`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

/** The text with one row's line replaced; every other byte, line endings included, kept. */
export function replaceRow(text, key, status, note) {
  const lines = text.split('\n')
  let section = false
  let found = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index]
    if (/^\S/u.test(line) && !line.startsWith('#')) section = /^development_status:/u.test(line)
    if (!section) continue
    const row = ROW.exec(line)
    if (!row || row[1] !== key) continue
    if (found !== null) throw new PlanError('DUPLICATE', `${key} appears twice; fix the board first (bmn plan check)`)
    found = { index, status: row[2], note: row[3] ?? '' }
  }
  if (found === null) return null
  const nextNote = note ?? found.note
  const ending = lines[found.index].endsWith('\r') ? '\r' : ''
  lines[found.index] = `  ${key}: ${status}${nextNote === '' ? '' : ` # ${nextNote}`}${ending}`
  return { text: lines.join('\n'), before: { status: found.status, note: found.note }, token: rowToken(key, found.status, found.note) }
}

/** Write text over path atomically, keeping its mode, unless the file changed since `expected` was read. */
function commit(path, expected, text) {
  const temporary = join(dirname(path), `.${basename(path)}.bmn-${process.pid}-${randomBytes(3).toString('hex')}.tmp`)
  const mode = statSync(path).mode & 0o777
  writeFileSync(temporary, text, { mode })
  try {
    chmodSync(temporary, mode)
    if (readFileSync(path, 'utf8') !== expected) { rmSync(temporary, { force: true }); return false }
    renameSync(temporary, path)
    return true
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Change one row in one copy of a board: lock, reread, check the token, replace the line, keep the version
 * before, write atomically. A change elsewhere in the file between the read and the write makes it read
 * again, up to SET_RETRIES times; a change of this row is a conflict.
 */
export async function setRow(boardPath, { key, status, note, expect, environment = process.env, seam = () => {} }) {
  const release = await lockBoard(boardPath)
  try {
    for (let attempt = 0; attempt <= SET_RETRIES; attempt++) {
      const before = readFileSync(boardPath, 'utf8')
      const changed = replaceRow(before, key, status, note)
      if (changed === null) throw new PlanError('UNKNOWN_ROW', `no row ${key} in ${boardPath}`)
      if (changed.token !== expect) return { outcome: 'conflict', current: { key, ...changed.before, token: changed.token } }
      if (changed.text === before) return { outcome: 'unchanged', token: changed.token }
      seam('read', attempt)
      const kept = keepVersion(boardPath, before, environment)
      if (commit(boardPath, before, changed.text)) return { outcome: 'changed', kept, token: rowToken(key, status, note ?? changed.before.note), attempts: attempt + 1 }
    }
    return { outcome: 'busy' }
  } finally { release() }
}

async function set(argv) {
  const { positionals, options } = parse(argv, { flags: ['json'], values: ['project', 'expect', 'expect-default', 'note'] })
  const json = options.json === true
  if (positionals.length !== 2) throw new PlanUsageError('plan set takes a row and a status: bmn plan set <row> <status> --expect TOKEN')
  const [key, status] = positionals
  if (options.expect === undefined) throw new PlanUsageError('plan set needs --expect TOKEN, the row token bmn plan status --json printed')
  if (options.note !== undefined && /[\r\n]/u.test(options.note)) throw new PlanUsageError('--note is one line')
  let plan
  try { plan = await resolvePlan(options.project ?? process.cwd()) } catch (error) { return failure(error, json) }
  const own = plan.format === FORMAT
  if (!(own ? STATUSES : BMAD_STATUSES).includes(status)) throw new PlanUsageError(`unknown status ${status}; one of ${(own ? STATUSES : BMAD_STATUSES).join(', ')}`)
  const noteLimit = own ? NOTE_LIMIT : 1000
  if (options.note !== undefined && [...options.note].length > noteLimit) throw new PlanUsageError(`--note is ${[...options.note].length} characters, over ${noteLimit}`)
  const copies = [{ path: plan.boardPath, expect: options.expect, name: plan.boardCheckout === plan.runCheckout ? 'run checkout' : 'default checkout' }]
  if (plan.tracked && plan.runCheckout !== plan.defaultCheckout) {
    const other = join(plan.defaultCheckout, plan.boardPath.slice(plan.runCheckout.length + 1))
    copies.push({ path: other, expect: options['expect-default'] ?? options.expect, name: 'default checkout' })
  }
  // Every copy is checked before any is written, so a refusal changes nothing.
  for (const copy of copies) {
    let text
    try { text = readFileSync(copy.path, 'utf8') } catch { return failure(new PlanError('UNREADABLE', `${copy.path} cannot be read`), json) }
    let found
    try { found = replaceRow(text, key, status, options.note) } catch (error) { return failure(error, json) }
    if (found === null) {
      if (json) out(JSON.stringify({ ok: false, error: { code: 'UNKNOWN_ROW', message: `no row ${key} in the ${copy.name}'s board ${copy.path}` } }, null, 2))
      else err(`bmn: UNKNOWN_ROW: no row ${key} in the ${copy.name}'s board ${copy.path}`)
      return EXIT.unable
    }
    if (found.token !== copy.expect) return conflict(json, copy, key, found)
  }
  const results = []
  for (const copy of copies) {
    let result
    try { result = await setRow(copy.path, { key, status, note: options.note, expect: copy.expect }) } catch (error) { return failure(error, json) }
    if (result.outcome === 'conflict') return conflict(json, copy, key, { before: result.current, token: result.current.token })
    if (result.outcome === 'busy') {
      if (json) out(JSON.stringify({ ok: false, error: { code: 'BUSY', message: `${copy.path} kept changing; nothing written there` }, written: results }, null, 2))
      else err(`bmn: BUSY: ${copy.path} kept changing while it was written; nothing written there${results.length ? ` (written: ${results.map((one) => one.board).join(', ')})` : ''}`)
      return EXIT.findings
    }
    results.push({ board: copy.path, outcome: result.outcome, token: result.token, kept: result.kept ?? null })
  }
  if (json) out(JSON.stringify({ ok: true, key, status, written: results }, null, 2))
  else out(results.map((one) => `${one.outcome === 'unchanged' ? 'unchanged' : 'set'} ${key}: ${status} in ${one.board} (token ${one.token})`).join('\n'))
  return EXIT.ok
}

function conflict(json, copy, key, found) {
  const current = { key, status: found.before.status, note: found.before.note, token: found.token }
  if (json) out(JSON.stringify({ ok: false, error: { code: 'CONFLICT', message: `${key} changed in the ${copy.name}'s board since its token was read`, board: copy.path, current } }, null, 2))
  else err(`bmn: CONFLICT: ${key} in the ${copy.name}'s board ${copy.path} is now "${current.status}${current.note ? ` # ${current.note}` : ''}" (token ${current.token}); read it again before changing it`)
  return EXIT.findings
}

export async function runPlanCommand(argv) {
  const [action, ...rest] = argv
  if (action === undefined || action === '--help' || action === '-h' || action === 'help') {
    out(PLAN_USAGE)
    return action === undefined ? EXIT.unable : EXIT.ok
  }
  if (rest.includes('--help') || rest.includes('-h')) { out(PLAN_USAGE); return EXIT.ok }
  try {
    if (action === 'status') return await status(rest)
    if (action === 'check') return await check(rest)
    if (action === 'set') return await set(rest)
    throw new PlanUsageError(`plan expects status, check or set, not ${action}`)
  } catch (error) {
    if (error instanceof PlanUsageError) { err(`bmn: ${error.message}\nRun "bmn plan --help" for usage.`); return EXIT.unable }
    throw error
  }
}
