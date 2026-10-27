// MODULE: plan-cli.mjs - Epic 77: `bmn plan status|check|set`, the project's planning board from the shell; works with BMN closed; Epic 96.1: `bmn plan go`, the owner's go as one commit of the plan's history
import { spawnSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import {
  BMAD_STATUSES, EXIT, FORMAT, NOTE_LIMIT, PlanError, ROW, STATUSES, boardBytes, boardProblems, checkPlan, readBoard, resolvePlan, rowToken
} from './plan-board.mjs'

const PLAN_USAGE = `Usage: bmn plan status [--json] [--project P] [--epic N]...
       bmn plan check [--json] [--project P]
       bmn plan set <row> <status> --expect TOKEN [--expect-default TOKEN] [--note TEXT] [--project P] [--json]
       bmn plan go <epic> --source TEXT --approved sha256:HEX|COMMIT --expect TOKEN [--date YYYY-MM-DD] [--note TEXT] [--project P] [--json]

The project's planning: its plan and its board, in BMN's own format (plan/PLAN.md, plan/status.yaml,
plan/epics/NNN-slug.md; docs/planning.md) or in BMAD's (_bmad-output/.../sprint-status.yaml). This is
not the subscription's Plan use. It needs no BMN running.

status  prints the board's rows, every one of them, with the resolved paths: product root, default and
        run checkout, plan root, board, format and history. --epic narrows to those epics (repeatable).
        --json gives every selected row with its line and row token, and errors as codes; with --epic,
        also each selected epic's approval text: the SHA-256 of its Run needs and Decisions, as a go names it.
check   structural validation, one finding per line: duplicate keys, malformed rows, unknown statuses,
        notes over ${NOTE_LIMIT} characters, stories without rows and rows without stories, duplicate
        identifiers, missing sections, stories without criteria or Verification, queue problems, a done
        epic with unfinished stories, blocked/paused/dropped rows without a reason, files over their
        ceiling, and from Epic 90 on a missing Run needs section or Owner line, or an owner step
        between unattended stories. A BMAD board is checked for duplicate keys and row grammar only. Whether the plan says
        the right thing is the readiness method's and review's, not this command's.
set     changes one row's status (and note with --note; without it the note is kept) after checking that
        the row still matches TOKEN, the row token status --json printed. It locks the board, rereads it,
        changes that one line, keeps every other byte and the file's mode, and writes atomically; the
        version before is kept in ~/.local/state/bmn/plan-versions (the last 20). A board tracked by the
        product repository and read from a linked worktree is changed in both copies, the default
        checkout's too; when that copy's row differs, --expect-default gives its token. An epic row of a
        plan with Git history is not set to ready this way: its go is recorded with go.
go      records the owner's go on one epic of a BMN-format plan with Git history, before its run starts: the
        row becomes ready with go DATE in its note and joins the queue, in one commit of the plan's history
        that holds only that change (and the approved epic file, when its approved text is not yet
        committed) and names in its message the owner's act (--source: his quoted words with their time;
        a BMN decision record is an agent's own choice, never his act) and what he approved (--approved: the approval text's
        sha256:HEX from status --json, or the plan commit he approved). It refuses changed terms, a stale
        TOKEN, a finished epic, an unreadable history and a failed commit, writing nothing; other changed
        or staged files stay as they were and out of the commit. The same request again finds its commit
        and only completes what a crash left undone; dev-auto reads the go back with run_needs.py.

Statuses (BMN's format): ${STATUSES.join(', ')}. BMAD boards take BMAD's: ${BMAD_STATUSES.join(', ')}.
Exit status: 0 done or no findings, 1 findings (check) or a refused or conflicting change (set, go),
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

function failure(error, json, written = []) {
  const code = error instanceof PlanError ? error.code : 'UNREADABLE'
  const message = error instanceof PlanError ? error.message : `the plan could not be read: ${error.message}`
  if (json) out(JSON.stringify({ ok: false, error: { code, message }, ...(written.length ? { written } : {}) }, null, 2))
  else err(`bmn: ${code}: ${message}${writtenNote(written)}`)
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
  if (plan.format === FORMAT) {
    const problems = boardProblems(board, relative(plan.productRoot, plan.boardPath) || plan.boardPath)
    if (problems.length > 0) return failure(new PlanError('MALFORMED', `the board cannot be read unambiguously: ${problems.map((problem) => `${problem.where}: ${problem.reason}`).join('; ')} (bmn plan check lists every finding)`), json)
  }
  const missing = epics.filter((epic) => !board.rows.some((row) => row.epic === epic))
  if (json) {
    const approvals = plan.format === FORMAT && epics.length > 0 ? { approval_texts: epics.flatMap((epic) => {
      const name = epicFileName(plan.planRoot, epic)
      return name === null ? [] : [{ epic, file: `epics/${name}`, sha256: approvalText(readFileSync(join(plan.planRoot, 'epics', name), 'utf8')) }]
    }) } : {}
    out(JSON.stringify({
      ok: true, ...resolvedFields(plan), schema_version: board.schemaVersion, queue: board.queue,
      epics, rows: board.rows.map(({ key, status, note, line, epic, story, token }) => ({ key, status, note, line, epic, story, token })),
      ...approvals, total_rows: board.totalRows, errors: missing.map((epic) => ({ code: 'NO_ROWS', epic, message: `no rows for epic ${epic}` }))
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
const SET_RETRIES = 5
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

/**
 * A go whose commit exists but whose working board does not show it yet (96 Astra review and recheck): only such a go
 * may be completed by a retry, and only over the row it was asked on (`from`, that row's token). Kept beside the
 * board's versions, outside the project, until the working board shows the go or a later act supersedes it: a
 * `bmn plan set` that changes the row, or a later commit of the row. While the board is being written it says `writing`.
 */
function pendingGoPath(boardPath, key, environment = process.env) {
  return join(versionsDirectory(boardPath, environment), `pending-go-${key}.json`)
}

function readPendingGo(boardPath, key) {
  try { return JSON.parse(readFileSync(pendingGoPath(boardPath, key), 'utf8')) } catch { return null }
}

function writePendingGo(boardPath, key, commit, from, writing = false) {
  const path = pendingGoPath(boardPath, key)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}-${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ commit, from, writing, at: new Date().toISOString() })}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Write the go's row to the working board, its pending record saying `writing` meanwhile (96 Astra recheck 2): a retry
 * that finds `writing` beside the row the go was asked on cannot tell a board never written from one written and put
 * back by hand, so it refuses instead of guessing. A compare-and-write that lost wrote nothing and says so again.
 */
function publishGo(boardPath, key, record, working, text, seam) {
  writePendingGo(boardPath, key, record.commit, record.from, true)
  seam('writing', record.commit)
  if (!commit(boardPath, working, text)) {
    writePendingGo(boardPath, key, record.commit, record.from)
    return false
  }
  seam('published', record.commit)
  clearPendingGo(boardPath, key)
  return true
}

function clearPendingGo(boardPath, key, environment = process.env) {
  rmSync(pendingGoPath(boardPath, key, environment), { force: true })
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

/** Create `path` holding `data` in one step (a link of a written temporary file), or false when it exists. */
function createLock(path, data) {
  const temporary = `${path}.${process.pid}-${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 })
  try { linkSync(temporary, path); return true } catch (error) { if (error.code === 'EEXIST') return false; throw error } finally { rmSync(temporary, { force: true }) }
}

function readHolder(path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch { return null }
  try { return { text, data: JSON.parse(text) } } catch { return { text, data: null } }
}

/**
 * Clear a dead holder's lock whose text is `observed`. One reclaimer at a time holds `<lock>.reclaim`, made
 * exclusively, and removes the lock only if it still holds that text: no writer can replace an existing lock and
 * no other reclaimer can act meanwhile, so a lock taken since is never removed. Only the guard's maker removes the
 * guard. One left by a reclaimer that died is never cleared automatically (that check-then-remove would race);
 * it only stops further clearing, and `set` says which files to remove once no writer runs.
 */
function reclaim(path, observed) {
  const guard = `${path}.reclaim`
  if (!createLock(guard, { pid: process.pid, at: new Date().toISOString() })) return false
  try {
    if (readHolder(path)?.text === observed) rmSync(path, { force: true })
    return true
  } finally { rmSync(guard, { force: true }) }
}

/**
 * A stable sibling lock, `.<board>.lock`, present only while a writer changes the board. It names its writer's
 * process and a nonce: a dead holder's lock is reclaimed, and a writer releases only the lock with its own nonce.
 */
export async function lockBoard(boardPath, { waitMs = LOCK_WAIT_MS } = {}) {
  const path = join(dirname(boardPath), `.${basename(boardPath)}.lock`)
  const nonce = randomBytes(8).toString('hex')
  const until = Date.now() + waitMs
  for (;;) {
    if (createLock(path, { pid: process.pid, at: new Date().toISOString(), nonce })) {
      return () => { if (readHolder(path)?.data?.nonce === nonce) rmSync(path, { force: true }) }
    }
    const holder = readHolder(path)
    const dead = holder?.data && Number.isSafeInteger(holder.data.pid) && !processAlive(holder.data.pid)
    if (dead && reclaim(path, holder.text)) continue
    if (Date.now() >= until) {
      const guard = `${path}.reclaim`
      const stuck = readHolder(guard)?.data
      if (dead && stuck && Number.isSafeInteger(stuck.pid) && !processAlive(stuck.pid)) {
        throw new PlanError('LOCKED', `${path} is held by process ${holder.data.pid}, which is gone, and ${guard}, left by process ${stuck.pid}, which is gone too, stops clearing it: stop every bmn plan set and let none start, then remove ${guard} and ${path} and try again`)
      }
      throw new PlanError('LOCKED', `${path} is held${holder?.data?.pid ? ` by process ${holder.data.pid}` : ''}; try again`)
    }
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
export async function setRow(boardPath, { key, status, note, expect, environment = process.env, seam = () => {}, locked = false }) {
  const release = locked ? () => {} : await lockBoard(boardPath)
  try {
    for (let attempt = 0; attempt <= SET_RETRIES; attempt++) {
      const before = readFileSync(boardPath, 'utf8')
      const changed = replaceRow(before, key, status, note)
      if (changed === null) throw new PlanError('UNKNOWN_ROW', `no row ${key} in ${boardPath}`)
      if (changed.token !== expect) return { outcome: 'conflict', current: { key, ...changed.before, token: changed.token } }
      if (changed.text === before) return { outcome: 'unchanged', token: changed.token }
      seam('read', attempt)
      const kept = keepVersion(boardPath, before, environment)
      if (commit(boardPath, before, changed.text)) {
        // A change of the row is a later act than a go the working board does not show yet: that go is not completed over it.
        clearPendingGo(boardPath, key, environment)
        return { outcome: 'changed', kept, token: rowToken(key, status, note ?? changed.before.note), attempts: attempt + 1 }
      }
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
  // An epic's ready is his go (96.1): set it here and nothing commits it, so the run finds no go.
  if (own && status === 'ready' && /^epic-\d+$/u.test(key) && plan.history !== 'none') {
    return refuse(json, 'GO_NEEDS_RECORD', `${key} becomes ready only with the owner's go recorded in the plan's history: bmn plan go ${key.slice(5)} --source TEXT --approved sha256:HEX --expect TOKEN`)
  }
  const noteLimit = own ? NOTE_LIMIT : 1000
  if (options.note !== undefined && [...options.note].length > noteLimit) throw new PlanUsageError(`--note is ${[...options.note].length} characters, over ${noteLimit}`)
  const copies = [{ path: plan.boardPath, expect: options.expect, name: plan.boardCheckout === plan.runCheckout ? 'run checkout' : 'default checkout' }]
  if (plan.tracked && plan.runCheckout !== plan.defaultCheckout) {
    const other = join(plan.defaultCheckout, plan.boardPath.slice(plan.runCheckout.length + 1))
    copies.push({ path: other, expect: options['expect-default'] ?? options.expect, name: 'default checkout' })
  }
  // Both copies are locked (in one order, so two writers never wait on each other) and checked before either is
  // written, so a cooperating writer's change refuses the whole set and changes nothing.
  const releases = []
  try {
    for (const copy of [...copies].sort((one, two) => one.path.localeCompare(two.path))) releases.push(await lockBoard(copy.path))
  } catch (error) { releases.forEach((release) => release()); return failure(error, json) }
  try {
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
      if (found.token !== copy.expect) return conflict(json, copy, key, found, [])
    }
    // Only a writer that ignores the lock can still change a copy now; whatever was written before is reported.
    const results = []
    for (const copy of copies) {
      let result
      try { result = await setRow(copy.path, { key, status, note: options.note, expect: copy.expect, locked: true }) } catch (error) { return failure(error, json, results) }
      if (result.outcome === 'conflict') return conflict(json, copy, key, { before: result.current, token: result.current.token }, results)
      if (result.outcome === 'busy') {
        if (json) out(JSON.stringify({ ok: false, error: { code: 'BUSY', message: `${copy.path} kept changing; nothing written there` }, written: results }, null, 2))
        else err(`bmn: BUSY: ${copy.path} kept changing while it was written; nothing written there${writtenNote(results)}`)
        return EXIT.findings
      }
      results.push({ board: copy.path, outcome: result.outcome, token: result.token, kept: result.kept ?? null })
    }
    if (json) out(JSON.stringify({ ok: true, key, status, written: results }, null, 2))
    else out(results.map((one) => `${one.outcome === 'unchanged' ? 'unchanged' : 'set'} ${key}: ${status} in ${one.board} (token ${one.token})`).join('\n'))
    return EXIT.ok
  } finally { releases.forEach((release) => release()) }
}

// ---------------------------------------------------------------------------------------------
// His go, recorded once (96.1)

/** A go that was not recorded: its code names the missing fact, and nothing was written. */
class GoRefusal extends PlanError {}

function refuse(json, code, message, extra = {}) {
  if (json) out(JSON.stringify({ ok: false, error: { code, message }, ...extra }, null, 2))
  else err(`bmn: ${code}: ${message}`)
  return EXIT.findings
}

const GO_DATE = /\bgo (\d{4}-\d{2}-\d{2})\b/u
const SOURCE_TIME = /\b(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/u
const SOURCE_QUOTE = /["'“‘«][^"'”’»]+["'”’»]/u
const DECISION_REFERENCE = /\bbmn: ?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\S+/u
const FINISHED_STATUSES = ['done', 'dropped']

/**
 * The text a go approves: the epic's Run needs and Decisions, each section's body (to the next heading of
 * levels 1-4) without surrounding blank space, hashed with SHA-256. run_needs.py reads the same sections the
 * same way, so one text gives one identity in both.
 */
export function approvalText(text) {
  const normal = (text ?? '').replace(/\r\n?/gu, '\n')
  const body = (name) => new RegExp(`(?:^|(?<=\\n))#{2,4} ${name}[ \\t]*\\n([\\s\\S]*?)(?=(?:^|(?<=\\n))#{1,4} |$)`, 'u')
    .exec(normal)?.[1].replace(/^[ \t\n]+|[ \t\n]+$/gu, '') ?? ''
  return createHash('sha256').update(`Run needs\n${body('Run needs')}\nDecisions\n${body('Decisions')}\n`).digest('hex')
}

function epicFileName(planRoot, epic) {
  let names
  try { names = readdirSync(join(planRoot, 'epics')) } catch { return null }
  const matching = names.filter((name) => new RegExp(`^0*${epic}-[\\w.-]+\\.md$`, 'u').test(name))
  return matching.length === 1 ? matching[0] : null
}

/** The board with `epic` last in its `queue:` (unchanged when already there); null for a queue written in another form. */
export function addToQueue(text, epic) {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => /^queue:/u.test(line))
  if (at === -1) return null
  const ending = lines[at].endsWith('\r') ? '\r' : ''
  const head = lines[at].slice(0, lines[at].length - ending.length)
  let last = null
  const items = []
  for (let index = at + 1; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/u, '')
    if (/^[ \t]*(?:#.*)?$/u.test(line)) continue
    const item = /^[ \t]+-[ \t]+['"]?(?:epic-)?(\d+)['"]?[ \t]*(?:#.*)?$/u.exec(line)
    if (!item) break
    items.push(Number(item[1]))
    last = index
  }
  if (items.includes(epic)) return text
  if (last !== null) {
    if (!/^queue:[ \t]*(?:#.*)?$/u.test(head)) return null
    lines.splice(last + 1, 0, `${/^([ \t]+)-/u.exec(lines[last])[1]}- ${epic}${ending}`)
    return lines.join('\n')
  }
  const empty = /^queue:[ \t]*(?:\[[ \t]*\])?[ \t]*(#.*)?$/u.exec(head)
  if (!empty) return null
  lines.splice(at, 1, `queue:${empty[1] ? ` ${empty[1]}` : ''}${ending}`, `  - ${epic}${ending}`)
  return lines.join('\n')
}

function goNote(date, note) {
  const head = `go ${date}`
  if (note === '') return head
  const room = NOTE_LIMIT - head.length - 3
  const kept = [...note]
  return `${head} · ${kept.length > room ? `${kept.slice(0, room - 1).join('')}…` : note}`
}

function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Git in the plan's history, never in a repository or index an outer process pointed the environment at. */
function gitSync(repo, args, { input, env = {} } = {}) {
  const inherited = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete inherited[name]
  const done = spawnSync('git', ['-C', repo, ...args], {
    input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000, env: { ...inherited, LC_ALL: 'C', ...env }
  })
  if (done.error || done.status !== 0) {
    const reason = (done.stderr || done.error?.message || '').trim().split('\n')[0].slice(0, 200)
    throw Object.assign(new Error(`git ${args[0]} failed${reason ? `: ${reason}` : ''}`), { git: true })
  }
  return done.stdout
}

function treeEntry(repo, commit, path) {
  const match = /^(\d+) blob ([0-9a-f]+)\t/u.exec(gitSync(repo, ['ls-tree', '-z', commit, '--', path]))
  return match ? { mode: match[1], blob: match[2] } : null
}

function indexEntry(repo, path) {
  const match = /^(\d+) ([0-9a-f]+) (\d)\t/u.exec(gitSync(repo, ['ls-files', '-s', '-z', '--', path]))
  return match ? { mode: match[1], blob: match[2], stage: match[3] } : null
}

function showAt(repo, commit, path) {
  try { return gitSync(repo, ['show', `${commit}:${path}`]) } catch { return null }
}

/** Trailers of a go commit's message, as run_needs.py reads them. */
function goTrailers(message) {
  const field = (name) => new RegExp(`^${name}: (.+)$`, 'mu').exec(message)?.[1].trim() ?? null
  return { epic: field('Go-Epic'), date: field('Go-Date'), source: field('Approval-Source'), approved: field('Approved-Text'), file: field('Approved-File') }
}

/** The newest commit of the board's history recording this same go: the same epic, owner's act and approved text. */
function recordedGo(repo, boardRel, epic, source, approvedSha) {
  const log = gitSync(repo, ['log', '--all-match', '-F', `--grep=Go-Epic: ${epic}`, `--grep=Approved-Text: sha256:${approvedSha}`, '--format=%H%x1f%B%x1e', '--', boardRel])
  for (const record of log.split('\x1e')) {
    const [commit, message = ''] = record.replace(/^\n/u, '').split('\x1f')
    const trailers = goTrailers(message)
    if (/^[0-9a-f]{40,64}$/u.test(commit) && trailers.epic === String(epic) && trailers.source === source && trailers.approved === `sha256:${approvedSha}`) return { commit, trailers }
  }
  return null
}

/**
 * Point the index's entry for `path` at its blob in `commit` when it held the parent's (it was not staged), so the
 * commit leaves the owner's staging as it was; a staged board gets the same row change; any other staged entry is his.
 */
function followIndex(repo, path, parentEntry, entry, transform) {
  const current = indexEntry(repo, path)
  if (current !== null && current.stage !== '0') return
  if ((current?.blob ?? null) === (parentEntry?.blob ?? null)) {
    gitSync(repo, ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.blob},${path}`])
    return
  }
  if (current === null || current.blob === entry.blob || transform === undefined) return
  const staged = transform(gitSync(repo, ['cat-file', 'blob', current.blob]))
  if (staged === null) return
  const blob = gitSync(repo, ['hash-object', '-w', '--stdin'], { input: staged }).trim()
  gitSync(repo, ['update-index', '--cacheinfo', `${current.mode},${blob},${path}`])
}

/**
 * Record the owner's go on one epic (96.1): check the source, the approved text, the row token and the history;
 * write one commit holding only the row's change to ready (with the queue) and, when the approved text is not yet
 * committed, the epic file; move the branch only if it did not move meanwhile; then the index entries that were
 * not staged and the working board. The same request again finds its commit and only completes what a crash left
 * undone, so one act never records two gos.
 */
export async function recordGo(plan, { epic, source: given, approved, expect, date, note, now = new Date(), seam = () => {} }) {
  if (plan.format !== FORMAT) throw new GoRefusal('BMAD', 'a BMAD board records its go as the dated go comment the product repository commits; bmn plan go records a BMN-format plan\'s go')
  if (plan.history === 'none') throw new GoRefusal('NO_HISTORY', `${plan.planRoot} keeps no Git history, so no go can be recorded there; give it one (git -C plan init) and commit the plan`)
  if (plan.history === 'product-repository' && plan.runCheckout !== plan.defaultCheckout) throw new GoRefusal('NOT_DEFAULT_CHECKOUT', `the plan is tracked by the product repository; record the go from its default checkout ${plan.defaultCheckout}`)
  const source = typeof given === 'string' ? given.trim() : ''
  if (source === '') throw new GoRefusal('NO_OWNER_GO', 'no owner go named: --source gives his act, his quoted words with their time')
  if (/[\r\n]/u.test(source) || [...source].length > 500) throw new GoRefusal('NO_OWNER_GO', '--source is one line of at most 500 characters')
  // A bmn:SESSION/KEY reference names a decision record an agent made for itself (docs/dev-auto.md), never his act (96 review).
  if (DECISION_REFERENCE.test(source)) throw new GoRefusal('NO_OWNER_GO', '--source names a BMN decision record, an agent\'s own choice; give his quoted words with their time')
  if (!(SOURCE_QUOTE.test(source) && SOURCE_TIME.test(source))) {
    throw new GoRefusal('NO_OWNER_GO', `--source does not name an owner's act: give his quoted words with their time (YYYY-MM-DDTHH:MM); "${source.slice(0, 80)}" is not that`)
  }
  const goDate = date ?? SOURCE_TIME.exec(source)?.[1] ?? localDate(now)
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(goDate) || Number.isNaN(Date.parse(`${goDate}T00:00:00Z`))) throw new PlanUsageError(`--date takes YYYY-MM-DD, not ${goDate}`)
  if (note !== undefined && GO_DATE.exec(note)?.[1] !== goDate) throw new GoRefusal('NOTE_WITHOUT_GO', `--note must carry the go as "go ${goDate}"`)
  if (note !== undefined && [...note].length > NOTE_LIMIT) throw new PlanUsageError(`--note is ${[...note].length} characters, over ${NOTE_LIMIT}`)
  const name = epicFileName(plan.planRoot, epic)
  if (name === null) throw new GoRefusal('NO_EPIC', `no single epic file for epic ${epic} in ${join(plan.planRoot, 'epics')}`)
  const repo = plan.history === 'plan-repository' ? plan.planRoot : plan.boardCheckout
  const prefix = relative(repo, plan.planRoot).split(sep).filter(Boolean).join('/')
  const boardRel = relative(repo, plan.boardPath).split(sep).join('/')
  const epicRel = `${prefix === '' ? '' : `${prefix}/`}epics/${name}`
  const key = `epic-${epic}`
  // Every Git failure before the branch moves is a refusal: nothing was recorded.
  const readHistory = (read) => {
    try { return read() } catch (error) {
      if (error?.git) throw new GoRefusal('UNREADABLE_HISTORY', `the plan's history at ${repo} cannot be read (${error.message}); nothing was recorded`)
      throw error
    }
  }

  let approvedSha
  let approvedFrom = null
  if (typeof approved === 'string' && /^sha256:[0-9a-f]{64}$/u.test(approved)) approvedSha = approved.slice(7)
  else if (typeof approved === 'string' && /^[0-9a-f]{7,64}$/u.test(approved)) {
    try { approvedFrom = gitSync(repo, ['rev-parse', '--verify', '--quiet', `${approved}^{commit}`]).trim() } catch { throw new GoRefusal('NO_APPROVED_TEXT', `--approved ${approved} is no commit of the plan's history at ${repo}`) }
    const then = showAt(repo, approvedFrom, epicRel)
    if (then === null) throw new GoRefusal('NO_APPROVED_TEXT', `commit ${approved} holds no ${epicRel}, so it names no approved text for epic ${epic}`)
    approvedSha = approvalText(then)
  } else throw new GoRefusal('NO_APPROVED_TEXT', 'no approved text named: --approved gives what he approved, sha256:HEX from bmn plan status --epic N --json or the plan commit he approved')

  const release = await lockBoard(plan.boardPath)
  try {
    const before = readHistory(() => recordedGo(repo, boardRel, epic, source, approvedSha))
    if (before !== null) return completeRecordedGo(plan, { repo, boardRel, key, epic, expect, before, name, seam })

    const working = readFileSync(plan.boardPath, 'utf8')
    const current = rowIn(working, key)
    if (current === null) throw new PlanError('UNKNOWN_ROW', `no row ${key} in ${plan.boardPath}`)
    if (current.token !== expect) throw new GoRefusal('CONFLICT', `${key} is now "${current.status}${current.note ? ` # ${current.note}` : ''}" (token ${current.token}), not the row the go was asked on; read it again and ask again if it changed`)
    if (FINISHED_STATUSES.includes(current.status)) throw new GoRefusal('FINISHED', `${key} is ${current.status}; a go approves work still to do`)
    const nextNote = note ?? goNote(goDate, current.note)

    const head = readHistory(() => gitSync(repo, ['rev-parse', '--verify', 'HEAD^{commit}']).trim())
    let branch
    try { branch = gitSync(repo, ['symbolic-ref', '-q', 'HEAD']).trim() } catch { throw new GoRefusal('DETACHED', `the plan's history at ${repo} is not on a branch; check out its branch first`) }
    const committedBoard = readHistory(() => showAt(repo, head, boardRel))
    const committedRow = committedBoard === null ? null : replaceRow(committedBoard, key, 'ready', nextNote)
    if (committedRow === null) throw new GoRefusal('NOT_COMMITTED', `${key} is not in the board ${boardRel} of commit ${head.slice(0, 12)}; commit the planned epic (the planning checkpoint) before its go`)
    const boardText = addToQueue(committedRow.text, epic)
    const workingText = addToQueue(replaceRow(working, key, 'ready', nextNote).text, epic)
    if (boardText === null || workingText === null) throw new GoRefusal('QUEUE_FORM', 'the board\'s queue: is not a block list (queue: [] or "  - N" lines); write it as one first')

    // What he approved must be what the go commit holds: the committed text, or the working copy committed with it.
    const workingEpic = readFileSync(join(plan.planRoot, 'epics', name))
    const committedEpic = readHistory(() => showAt(repo, head, epicRel))
    const committedSha = committedEpic === null ? null : approvalText(committedEpic)
    const workingSha = approvalText(workingEpic.toString('utf8'))
    const epicIncluded = committedSha !== approvedSha
    if (epicIncluded && workingSha !== approvedSha) {
      throw new GoRefusal('CHANGED_TERMS', `epic ${epic}'s Run needs and Decisions are not the approved text sha256:${approvedSha.slice(0, 12)}… (working copy ${workingSha.slice(0, 12)}…, committed ${committedSha === null ? 'none' : `${committedSha.slice(0, 12)}…`}); ask for the go on the current text`)
    }

    const message = [
      `plan: go for Epic ${epic} (go ${goDate})`, '',
      `Recorded by bmn plan go: the owner's go on ${key} and the Run needs and Decisions it approved.`, '',
      `Go-Epic: ${epic}`, `Go-Date: ${goDate}`, `Approval-Source: ${source}`, `Approved-Text: sha256:${approvedSha}`, `Approved-File: ${epicRel}`,
      ...(approvedFrom ? [`Approved-From: ${approvedFrom}`] : []), ''
    ].join('\n')
    const parentBoard = readHistory(() => treeEntry(repo, head, boardRel))
    const parentEpic = readHistory(() => treeEntry(repo, head, epicRel))
    const temporaryIndex = join(readHistory(() => gitSync(repo, ['rev-parse', '--absolute-git-dir']).trim()), `bmn-plan-go-${process.pid}-${randomBytes(3).toString('hex')}.index`)
    let created
    try {
      const own = { env: { GIT_INDEX_FILE: temporaryIndex } }
      gitSync(repo, ['read-tree', head], own)
      const boardBlob = gitSync(repo, ['hash-object', '-w', '--stdin'], { input: boardText }).trim()
      gitSync(repo, ['update-index', '--add', '--cacheinfo', `${parentBoard?.mode ?? '100644'},${boardBlob},${boardRel}`], own)
      if (epicIncluded) {
        const epicBlob = gitSync(repo, ['hash-object', '-w', '--stdin'], { input: workingEpic }).trim()
        gitSync(repo, ['update-index', '--add', '--cacheinfo', `${parentEpic?.mode ?? '100644'},${epicBlob},${epicRel}`], own)
      }
      const tree = gitSync(repo, ['write-tree'], own).trim()
      created = gitSync(repo, ['commit-tree', tree, '-p', head, '-F', '-'], { input: message }).trim()
      writePendingGo(plan.boardPath, key, created, current.token)
      seam('created', created)
      gitSync(repo, ['update-ref', '-m', `bmn plan go: epic ${epic}`, branch, created, head])
    } catch (error) {
      if (error?.git || ['EACCES', 'ENOSPC', 'EROFS', 'EPERM'].includes(error?.code)) throw new GoRefusal('COMMIT_FAILED', `the go could not be committed in ${repo} (${error.message}); nothing was recorded and the board is unchanged`)
      throw error
    } finally { rmSync(temporaryIndex, { force: true }) }
    seam('committed', created)

    // The commit holds the go; the index entries that were not staged and the working board follow it.
    const transform = (text) => { const row = replaceRow(text, key, 'ready', nextNote); return row === null ? null : addToQueue(row.text, epic) }
    try {
      followIndex(repo, boardRel, parentBoard, treeEntry(repo, created, boardRel), transform)
      if (epicIncluded) followIndex(repo, epicRel, parentEpic, treeEntry(repo, created, epicRel), undefined)
    } catch { /* the go stands; an index entry left behind only shows as a staged change */ }
    keepVersion(plan.boardPath, working)
    publishGo(plan.boardPath, key, { commit: created, from: current.token }, working, workingText, seam)

    // Read back what the commit holds: the row, the approved text and the trailers.
    const recordedRow = rowIn(showAt(repo, created, boardRel) ?? '', key)
    const trailers = goTrailers(gitSync(repo, ['log', '-1', '--format=%B', created]))
    if (recordedRow?.status !== 'ready' || GO_DATE.exec(recordedRow.note)?.[1] !== goDate || approvalText(showAt(repo, created, epicRel) ?? '') !== approvedSha || trailers.source !== source) {
      throw new PlanError('READBACK', `commit ${created} does not read back as the go it was written to be; see git -C ${repo} show ${created.slice(0, 12)}`)
    }
    const row = rowIn(readFileSync(plan.boardPath, 'utf8'), key)
    return { outcome: 'recorded', commit: created, date: goDate, source, approvedSha, file: `epics/${name}`, repo, epicIncluded, row, pending: row?.token !== recordedRow.token }
  } finally { release() }
}

/**
 * The go this request asked for is already a commit (a retry, a duplicate call, or a crash after the branch moved).
 * Only a go the working board does not show yet (its pending record names this commit) is completed, and only by the
 * same request over the row it was asked on, while the plan's history still holds the go's row: the unstaged index
 * entry and the working row follow it. A go published before is never written again, so a row put back since,
 * committed or not, stays withdrawn; one act never records two gos. A retry that writes nothing (another token, or a
 * board that changed while it was written) leaves the go pending for the right retry (96 Astra recheck).
 */
function completeRecordedGo(plan, { repo, boardRel, key, epic, expect, before, name, seam }) {
  const recordedRow = rowIn(showAt(repo, before.commit, boardRel) ?? '', key)
  const headRow = rowIn(showAt(repo, 'HEAD', boardRel) ?? '', key)
  const record = readPendingGo(plan.boardPath, key)
  let unfinished = record?.commit === before.commit && typeof record.from === 'string'
  const withdrawn = (where, row) => new GoRefusal('WITHDRAWN', `this go was recorded at ${before.commit.slice(0, 12)} and later withdrawn: ${key} is ${row.status} ${where}; a new go needs a new act of his`)
  // A later commit of the row is a later act: the go is not completed over it.
  if (unfinished && (recordedRow === null || headRow?.token !== recordedRow.token)) {
    clearPendingGo(plan.boardPath, key)
    unfinished = false
  }
  if (headRow !== null && ['backlog', 'dropped'].includes(headRow.status)) throw withdrawn('in the plan\'s history', headRow)
  const workingRow = rowIn(readFileSync(plan.boardPath, 'utf8'), key)
  const shown = (row) => row !== null && recordedRow !== null && row.token === recordedRow.token
  const asked = unfinished && workingRow?.token === record.from
  if (asked && record.writing === true && !shown(workingRow)) {
    throw new GoRefusal('UNCERTAIN', `this go was recorded at ${before.commit.slice(0, 12)} and was being written to the board when it stopped; ${key} shows the row it was asked on, which may be a withdrawal put back by hand, so nothing is written; a new go needs a new act of his`)
  }
  if (!shown(workingRow) && !asked && workingRow !== null && ['backlog', 'dropped'].includes(workingRow.status)) {
    throw withdrawn(unfinished ? 'on the board, changed after the go was recorded' : 'on the board, put back after the go was published', workingRow)
  }
  if (asked && expect === record.from) {
    try { followIndex(repo, boardRel, treeEntry(repo, `${before.commit}^`, boardRel), treeEntry(repo, before.commit, boardRel), undefined) } catch { /* the go stands */ }
    const working = readFileSync(plan.boardPath, 'utf8')
    seam('completing', before.commit)
    const changed = replaceRow(working, key, 'ready', recordedRow.note)
    if (changed !== null && changed.token === expect) {
      keepVersion(plan.boardPath, working)
      publishGo(plan.boardPath, key, record, working, addToQueue(changed.text, epic) ?? changed.text, seam)
    }
  }
  const row = rowIn(readFileSync(plan.boardPath, 'utf8'), key)
  // Pending until the working board shows the go's row; the record goes only then.
  const pending = unfinished && !shown(row)
  if (unfinished && !pending) clearPendingGo(plan.boardPath, key)
  return { outcome: 'recorded-before', commit: before.commit, date: before.trailers.date, source: before.trailers.source, approvedSha: before.trailers.approved.slice(7), file: `epics/${name}`, repo, epicIncluded: false, row, pending }
}

/** One row of a board's text with its token, or null. */
function rowIn(text, key) {
  for (const raw of text.split('\n')) {
    const row = ROW.exec(raw.replace(/\r$/u, ''))
    if (row && row[1] === key) return { status: row[2], note: row[3] ?? '', token: rowToken(key, row[2], row[3] ?? '') }
  }
  return null
}

async function go(argv) {
  const { positionals, options } = parse(argv, { flags: ['json'], values: ['project', 'expect', 'source', 'approved', 'date', 'note'] })
  const json = options.json === true
  if (positionals.length !== 1 || !/^\d{1,6}$/u.test(positionals[0])) throw new PlanUsageError('plan go takes one epic number: bmn plan go <epic> --source TEXT --approved sha256:HEX --expect TOKEN')
  if (options.expect === undefined) throw new PlanUsageError('plan go needs --expect TOKEN, the epic row\'s token bmn plan status --json printed')
  if (options.note !== undefined && /[\r\n]/u.test(options.note)) throw new PlanUsageError('--note is one line')
  const epic = Number(positionals[0])
  let plan
  try { plan = await resolvePlan(options.project ?? process.cwd()) } catch (error) { return failure(error, json) }
  let result
  try {
    result = await recordGo(plan, { epic, source: options.source, approved: options.approved, expect: options.expect, date: options.date, note: options.note })
  } catch (error) {
    if (error instanceof GoRefusal) return refuse(json, error.code, error.message)
    if (error instanceof PlanUsageError) throw error
    return failure(error, json)
  }
  const { row } = result
  if (json) {
    out(JSON.stringify({
      ok: true, epic, outcome: result.outcome, go_date: result.date, commit: result.commit, history_repo: result.repo, approval_source: result.source,
      approved_text: `sha256:${result.approvedSha}`, approved_file: result.file, epic_file_committed: result.epicIncluded, row, board: plan.boardPath,
      board_pending: result.pending
    }, null, 2))
  } else {
    out([
      `${result.outcome === 'recorded' ? 'recorded' : 'already recorded'}: the go on epic ${epic}, go ${result.date}, commit ${result.commit.slice(0, 12)} in ${result.repo}`,
      `approved text sha256:${result.approvedSha} (Run needs and Decisions of ${result.file}); source: ${result.source}`,
      `board: epic-${epic}: ${row?.status ?? 'missing'}${row?.note ? ` # ${row.note}` : ''}${row ? ` (token ${row.token})` : ''}`,
      ...(result.pending ? ['the working board does not show the go yet (it changed while it was written, or the retry named another row token); run the same command again with the token the go was asked on'] : []),
      `dev-auto reads it with run_needs.py ${epic} --project ${plan.productRoot}`
    ].join('\n'))
  }
  return result.pending ? EXIT.findings : EXIT.ok
}

function writtenNote(results) {
  return results.length ? ` (already written: ${results.map((one) => `${one.board}, token ${one.token}`).join('; ')})` : ''
}

function conflict(json, copy, key, found, written) {
  const current = { key, status: found.before.status, note: found.before.note, token: found.token }
  if (json) out(JSON.stringify({ ok: false, error: { code: 'CONFLICT', message: `${key} changed in the ${copy.name}'s board since its token was read`, board: copy.path, current }, written }, null, 2))
  else err(`bmn: CONFLICT: ${key} in the ${copy.name}'s board ${copy.path} is now "${current.status}${current.note ? ` # ${current.note}` : ''}" (token ${current.token}); read it again before changing it${writtenNote(written)}`)
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
    if (action === 'go') return await go(rest)
    throw new PlanUsageError(`plan expects status, check, set or go, not ${action}`)
  } catch (error) {
    if (error instanceof PlanUsageError) { err(`bmn: ${error.message}\nRun "bmn plan --help" for usage.`); return EXIT.unable }
    throw error
  }
}
