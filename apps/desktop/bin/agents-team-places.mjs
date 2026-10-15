// MODULE: agents-team-places.mjs - Epic 72: many asks, safely: a key, the request's hash and a capacity place reserved together before an ask starts, runs recovered after a crash (their scope ended, their record finished) and never started again, and records kept for their retention
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { takeLock } from './agents-research.mjs'
import { processLives, processStart } from './agents-supervised.mjs'
import { ASK_RUN_FILES } from './agents-team-forms.mjs'
import { AskRefusal } from './agents-team-resolve.mjs'
import { TRANSIENT, finishRun } from './agents-team-run.mjs'
import { RUN_FILES, endScope, runState, scopeUnit, writeWhole } from './agents-team-supervisor.mjs'

/**
 * An asker may retry: its command, tool call or session can end at any moment, and a retry must
 * neither pay twice nor lose the first ask (R72-FR4, 72.4 AC2). So every ask has a key, chosen by
 * the asker (an agent session must) or made by BMN, and before anything is copied BMN reserves the
 * key, the request's hash and one of the capacity places together, under one short lock that
 * separate commands and the app share. The same key with the same request finds the first run, in
 * whatever state it is; with another request it is refused. A key carries the day it was issued, so
 * it expires after the key window even once its record is gone. A place is held from the
 * reservation until the run's outcome is written; a run whose asking command ended before the start
 * is recorded as interrupted, and its supervisor, should it still come, starts nothing.
 */

/** Asks running at once across BMN; the owner sets 1 to 10 in Preferences. */
export const CAPACITY = Object.freeze({ default: 4, min: 1, max: 10 })
/** How long a key finds its run, from the day it names; then it is expired. */
export const KEY_WINDOW_DAYS = 7
/** How long a run's record is kept after it ends. */
export const RETENTION_DAYS = 30
/** A key: the UTC day it was issued and a name of the asker's own. */
export const KEY_PATTERN = /^(\d{4})(\d{2})(\d{2})-[A-Za-z0-9._-]{1,64}$/u
/** A run whose asking command ended this long after writing its launch, with no supervisor seen, never started. */
const START_GRACE_MS = 10_000
const DAY_MS = 86_400_000
const RUN_ID = /^\d{8}T\d{6}-[0-9a-f]{8}$/u
const LOCK_WAIT_MS = 10_000

const readJsonOrNull = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const ownIdentity = () => ({ pid: process.pid, start: processStart(process.pid) })

// ---------------------------------------------------------------------------------------------
// Keys

/** The UTC day a key names, as a time, or null when it names none. */
export function keyDay(key) {
  const match = KEY_PATTERN.exec(key ?? '')
  if (match === null) return null
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const day = new Date(time)
  return day.getUTCFullYear() === Number(match[1]) && day.getUTCMonth() === Number(match[2]) - 1 && day.getUTCDate() === Number(match[3]) ? time : null
}

/**
 * Whether a key is still in its window: until the end of the second day after the day it names
 * plus the window, so a key first used on that day or the next, in any time zone, finds its run for
 * at least the window's seven days.
 */
export function keyExpired(key, now = new Date()) {
  const day = keyDay(key)
  return day === null || now.getTime() >= day + (KEY_WINDOW_DAYS + 2) * DAY_MS
}

/** Whether a key may be used for the first time now: it names today, yesterday or tomorrow (UTC), so a local date counts. */
export function keyFresh(key, now = new Date()) {
  const day = keyDay(key)
  if (day === null) return false
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.abs(day - today) <= DAY_MS
}

/** A key BMN makes for an asker that gave none: today's UTC day, who made it and eight random hex digits. */
export function makeKey(by, now = new Date()) {
  return `${now.toISOString().slice(0, 10).replaceAll('-', '')}-${by}-${randomBytes(4).toString('hex')}`
}

/** Whose key it is: the asking session, a plain shell, or the owner in the app. */
export function keyScope(asker) {
  if (asker.kind === 'session') return `session:${asker.session}`
  return asker.kind === 'owner' ? 'owner' : 'shell'
}

/**
 * The request's hash: everything the asker gave that decides what is asked and of whom, with each
 * file's bytes and the question by their own hashes, never their text. A retry is the same request
 * when this is the same.
 */
export function requestHash(request) {
  const canonical = {
    version: 2, role: request.role, question_sha256: sha256(request.question ?? ''), agent: request.agent ?? null, effort: request.effort ?? null,
    small_work: request.smallWork === true, recheck_of: request.recheckOf ?? null, project: request.project ?? null,
    files: (request.files ?? []).map((file) => ({ path: file.path, sha256: file.sha256 })), images: (request.images ?? []).map((image) => ({ path: image.path, sha256: image.sha256 })),
    data: request.data === 'public' ? 'public' : 'private', time_limit_minutes: request.timeLimitMinutes
  }
  return sha256(JSON.stringify(canonical))
}

const keysDirectory = (runs) => join(runs, '.keys')
const placesDirectory = (runs) => join(runs, '.places')
/** A key's record is named by the hash of its scope and the key, so a file name holds neither. */
export const keyPath = (runs, scope, key) => join(keysDirectory(runs), `${sha256(`${scope}\0${key}`)}.json`)
export const placePath = (runs, id) => join(placesDirectory(runs), `${id}.json`)

// ---------------------------------------------------------------------------------------------
// The owner's limits

/** The owner's settings for asks (Preferences): the capacity and Claude Code's per-ask token ceiling. Anything invalid counts as unset. */
export function askSettings(runs) {
  const saved = readJsonOrNull(join(dirname(runs), 'asks-settings.json')) ?? {}
  const capacity = Number.isInteger(saved.capacity) && saved.capacity >= CAPACITY.min && saved.capacity <= CAPACITY.max ? saved.capacity : CAPACITY.default
  const ceiling = Number.isInteger(saved.token_ceiling) && saved.token_ceiling > 0 ? saved.token_ceiling : null
  return { capacity, token_ceiling: ceiling }
}

// ---------------------------------------------------------------------------------------------
// A run's state, recovered

/**
 * Ends the scope a dead supervisor left: the wrapper's parent-death signal ends it as the supervisor
 * dies, and this ends it again, by the cgroup the supervisor recorded or, where it died before it
 * recorded one, where the owner's systemd puts a scope of that name. Only this very run's scope is
 * ever killed (agents-team-supervisor.mjs endScope).
 */
function endLeftScope(folder) {
  const id = basename(folder)
  const recorded = readJsonOrNull(join(folder, RUN_FILES.state))?.scope?.cgroup
  if (endScope(recorded, id)) return
  const uid = process.getuid?.()
  if (uid !== undefined) endScope(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${scopeUnit(id)}.scope`, id)
}

/**
 * Records a run that ended without its supervisor's finish (a crash, or BMN or the computer
 * restarting): whatever its scope still holds is ended, and its record is finished as `interrupted`
 * with why, keeping what its output shows of its sessions and usage, and its transient files go, as on
 * every other outcome. A supervisor that comes later finds the outcome and starts nothing.
 */
export function recordInterrupted(folder, reason) {
  if (existsSync(join(folder, ASK_RUN_FILES.outcome))) return
  endLeftScope(folder)
  try {
    finishRun(folder, { interrupted: reason })
  } catch {
    // What could not be read is no reason to leave the run without an outcome.
    if (!existsSync(join(folder, ASK_RUN_FILES.outcome))) {
      const request = readJsonOrNull(join(folder, ASK_RUN_FILES.request)) ?? {}
      writeWhole(join(folder, ASK_RUN_FILES.outcome), `${JSON.stringify({ version: 1, id: request.id ?? null, state: 'interrupted', exit: 1, reason, ended_at: new Date().toISOString() }, null, 2)}\n`)
    }
  }
  for (const part of TRANSIENT) rmSync(join(folder, part), { recursive: true, force: true })
}

/**
 * Whether the run a place or key names still holds its place: it has no outcome, and either its
 * supervisor lives, or before the supervisor the command that reserved it lives. A run left by a
 * command that ended before its start, or by a supervisor that died, is recorded as interrupted here.
 */
export function runHolds(runs, id, holder, now = Date.now()) {
  const folder = join(runs, id)
  if (existsSync(join(folder, ASK_RUN_FILES.outcome))) return false
  const state = runState(folder)
  if (state.state === 'ended') {
    // Its supervisor ended, but its finish step wrote no outcome: interrupted, its transient state deleted.
    if (existsSync(folder)) recordInterrupted(folder, 'its supervisor ended without recording the run\'s outcome; BMN never starts it again')
    return false
  }
  if (state.state === 'interrupted') {
    if (existsSync(folder)) recordInterrupted(folder, `its supervisor ended with no record of the run's end (it was ${state.was ?? 'running'}); BMN never starts it again`)
    return false
  }
  if (state.state !== 'unknown') return true
  // Before the supervisor: the reserving command is preparing it, or has just started the supervisor.
  if (processLives(holder)) return true
  let launched = null
  try {
    launched = statSync(join(folder, RUN_FILES.launch)).mtimeMs
  } catch {
    // Never launched.
  }
  if (launched !== null && now - launched < START_GRACE_MS) return true
  if (existsSync(folder)) recordInterrupted(folder, 'the asking command ended before the run started; nothing started, and BMN never starts it again')
  return false
}

/** The places held now, the stale ones given back. Called under the reservation lock. */
function heldPlaces(runs, now) {
  let names
  try {
    names = readdirSync(placesDirectory(runs)).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const held = []
  for (const name of names) {
    const place = readJsonOrNull(join(placesDirectory(runs), name))
    const id = name.slice(0, -'.json'.length)
    if (place !== null && RUN_ID.test(id) && runHolds(runs, id, place.holder, now)) held.push(id)
    else rmSync(join(placesDirectory(runs), name), { force: true })
  }
  return held
}

/** Gives a run's place back; its finish and a refusal before the start call this. */
export function releasePlace(runs, id) {
  rmSync(placePath(runs, id), { force: true })
}

// ---------------------------------------------------------------------------------------------
// The reservation

async function underLock(runs, work) {
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  const until = Date.now() + LOCK_WAIT_MS
  for (;;) {
    const lock = takeLock(join(runs, '.reserve'), { kind: 'team-ask-reservation' })
    if (lock.release !== undefined) {
      try {
        return work()
      } finally {
        lock.release()
      }
    }
    if (Date.now() >= until) throw new AskRefusal('BUSY', 'another ask is being reserved and did not finish in 10 seconds; nothing started')
    await new Promise((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 20)))
  }
}

/**
 * Reserves an ask, or finds the run its key already names. `request`: `{ scope, key, hash, id }`.
 * Returns `{ reserved: id }`, or `{ existing: id, entry }` for the same key and request. Refuses a
 * different request under a used key (KEY_CONFLICT), a removed run's or expired key (GONE), a key
 * that names no recent day at its first use (USAGE), and a full capacity (BUSY).
 */
export async function reserveAsk(runs, { scope, key, hash, id }, { now = new Date(), capacity = askSettings(runs).capacity, holder = ownIdentity() } = {}) {
  return underLock(runs, () => {
    sweepRuns(runs, now)
    if (keyExpired(key, now)) {
      if (keyDay(key) === null) throw new AskRefusal('USAGE', `--key ${key} names no day: a key is the UTC day it was issued and a name, as ${makeKey('name', now)}`)
      throw new AskRefusal('GONE', `the key ${key} is expired: a key finds its ask for ${KEY_WINDOW_DAYS} days; ask again with a new key`)
    }
    const path = keyPath(runs, scope, key)
    const entry = readJsonOrNull(path)
    if (entry !== null) {
      if (entry.state === 'gone') throw new AskRefusal('GONE', `the ask with key ${key} was removed (${entry.outcome ?? 'its outcome unknown'}); ask again with a new key`)
      if (entry.request_sha256 !== hash) throw new AskRefusal('KEY_CONFLICT', `the key ${key} was used for a different request (run ${entry.id}); use a new key for a new request`)
      return { existing: entry.id, entry }
    }
    if (!keyFresh(key, now)) throw new AskRefusal('USAGE', `--key ${key} names a day that is not today: a new key is today's UTC day and a name, as ${makeKey('name', now)}`)
    const held = heldPlaces(runs, now.getTime())
    if (held.length >= capacity) throw new AskRefusal('BUSY', `${held.length} asks are running, the limit of ${capacity}; nothing is queued: ask again when one ends (bmn team asks)`)
    mkdirSync(keysDirectory(runs), { recursive: true, mode: 0o700 })
    mkdirSync(placesDirectory(runs), { recursive: true, mode: 0o700 })
    // Key, hash and place together, under the lock: no other reservation sees one without the others.
    writeWhole(path, `${JSON.stringify({ version: 1, key, scope, request_sha256: hash, id, first_used_at: now.toISOString(), holder })}\n`)
    writeWhole(placePath(runs, id), `${JSON.stringify({ version: 1, id, holder, reserved_at: now.toISOString() })}\n`)
    return { reserved: id }
  })
}

/** Gives back a reservation whose ask was refused before anything started: its key may be used again, for any request. */
export async function releaseReservation(runs, { scope, key, id }) {
  return underLock(runs, () => {
    const path = keyPath(runs, scope, key)
    if (readJsonOrNull(path)?.id === id) rmSync(path, { force: true })
    releasePlace(runs, id)
  })
}

/**
 * The run a key found, as its asker sees it now: `{ state: 'preparing' }` while the command that
 * reserved it prepares it, `{ state: 'interrupted', reason }` when that command ended before the
 * start, else `{ state: 'run' }` with its folder.
 */
export function keyedRun(runs, entry, now = Date.now()) {
  const folder = join(runs, entry.id)
  if (existsSync(join(folder, ASK_RUN_FILES.outcome))) return { state: 'run', folder }
  if (runHolds(runs, entry.id, entry.holder, now)) return runState(folder).state === 'unknown' && !existsSync(join(folder, RUN_FILES.launch)) ? { state: 'preparing', folder } : { state: 'run', folder }
  return existsSync(folder) ? { state: 'run', folder } : { state: 'interrupted', reason: 'the asking command ended before the run was made; nothing started' }
}

// ---------------------------------------------------------------------------------------------
// Retention

/** When a run ended, from its outcome, or null while it has none. */
function endedAt(folder) {
  const outcome = readJsonOrNull(join(folder, ASK_RUN_FILES.outcome))
  const time = Date.parse(outcome?.ended_at ?? '')
  return Number.isFinite(time) ? time : null
}

/**
 * Removes one run's record whole: its inputs, pictures, raw logs and answer. Its key keeps a
 * content-free entry (the key, the request's hash, the outcome) for the key window, so a retry is
 * told GONE and never starts it again.
 */
export function removeRun(runs, id, now = new Date()) {
  if (!RUN_ID.test(id)) return false
  const folder = join(runs, id)
  const request = readJsonOrNull(join(folder, ASK_RUN_FILES.request))
  const outcome = readJsonOrNull(join(folder, ASK_RUN_FILES.outcome))
  if (request?.key !== undefined && request?.key_scope !== undefined && !keyExpired(request.key, now)) {
    const path = keyPath(runs, request.key_scope, request.key)
    const entry = readJsonOrNull(path)
    if (entry !== null && entry.id === id) {
      mkdirSync(keysDirectory(runs), { recursive: true, mode: 0o700 })
      writeWhole(path, `${JSON.stringify({ version: 1, key: entry.key, scope: entry.scope, request_sha256: entry.request_sha256, id, state: 'gone', outcome: outcome?.state ?? null, removed_at: now.toISOString() })}\n`)
    }
  }
  rmSync(folder, { recursive: true, force: true })
  releasePlace(runs, id)
  return true
}

/**
 * The retention sweep: records ended more than the retention ago are removed, and key entries past
 * their window are deleted; nothing of an expired key is left, and the key itself says it is expired.
 */
export function sweepRuns(runs, now = new Date()) {
  let names
  try {
    names = readdirSync(runs).filter((name) => RUN_ID.test(name))
  } catch {
    return
  }
  for (const id of names) {
    const folder = join(runs, id)
    const ended = endedAt(folder)
    if (ended !== null && now.getTime() - ended > RETENTION_DAYS * DAY_MS) removeRun(runs, id, now)
    // A run with an outcome holds no transient files: what a crash between its outcome and that deletion left goes now.
    else if (ended !== null) for (const part of TRANSIENT) if (existsSync(join(folder, part))) rmSync(join(folder, part), { recursive: true, force: true })
  }
  let keys
  try {
    keys = readdirSync(keysDirectory(runs)).filter((name) => name.endsWith('.json'))
  } catch {
    return
  }
  for (const name of keys) {
    const entry = readJsonOrNull(join(keysDirectory(runs), name))
    if (entry === null || keyExpired(entry.key, now)) rmSync(join(keysDirectory(runs), name), { force: true })
  }
}
