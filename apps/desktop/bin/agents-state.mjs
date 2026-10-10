// MODULE: agents-state.mjs - Epic 60.2: read-only access to the owner-approved roster generations; nothing here writes
import { readdirSync, readFileSync } from 'node:fs'
import {
  AGENT_FIELDS, FREE_TEXT_FIELDS, RosterError, SCHEMA_VERSION, agentsDirectory, canonicalJson, parseRoster, rosterPath, sha256
} from './agents-roster.mjs'

/**
 * Approved state lives in `~/.config/bmn/agents/state/`: one JSON file per generation under
 * `generations/`, and `current`, a pointer naming one generation and its hash. Only the app writes
 * them (src/main/agents-approval.ts); the CLI and agents only read, through this module, and a reader
 * never falls back to the roster file: no approval, no team.
 */

export function stateDirectory() {
  return `${agentsDirectory()}/state`
}

export function generationsDirectory() {
  return `${stateDirectory()}/generations`
}

export function currentPointerPath() {
  return `${stateDirectory()}/current`
}

export function generationPath(number) {
  return `${generationsDirectory()}/${String(number).padStart(6, '0')}.json`
}

export function approvalLockPath() {
  return `${stateDirectory()}/approve.lock`
}

export function historyLogPath() {
  return `${stateDirectory()}/history.jsonl`
}

/** The hash a generation carries: SHA-256 of its canonical JSON without the `hash` field. */
export function generationHash(generation) {
  const rest = { ...generation }
  delete rest.hash
  return sha256(canonicalJson(rest))
}

/** The roster file's bytes and hash, or ROSTER_MISSING (exit 3). */
export function readRosterFile(path = rosterPath()) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new RosterError('ROSTER_MISSING', `no roster at ${path}; nothing is approved from a missing file`)
    throw new RosterError('ROSTER_MISSING', `cannot read ${path} (${error.code ?? 'read failed'})`)
  }
  return { path, text, hash: sha256(text) }
}

/** Parses and validates the file; an invalid one is ROSTER_INVALID (exit 4) with every error and its line. */
export function readValidRoster(path = rosterPath()) {
  const file = readRosterFile(path)
  const parsed = parseRoster(file.text)
  if (parsed.data === null) {
    throw new RosterError('ROSTER_INVALID', `${path} is not a valid roster (${parsed.errors.length} error${parsed.errors.length === 1 ? '' : 's'})`,
      { errors: parsed.errors, warnings: parsed.warnings })
  }
  return { ...file, ...parsed }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Shape check of approved data: hashes guard against corruption, this against a reader crashing on garbage. */
function wellFormed(data) {
  return isObject(data) && data.schema_version === SCHEMA_VERSION && Array.isArray(data.agents) && Array.isArray(data.roles)
    && Array.isArray(data.providers) && Array.isArray(data.exceptions) && Array.isArray(data.harness_routes)
    && data.agents.every((agent) => isObject(agent) && typeof agent.id === 'string' && Array.isArray(agent.efforts) && Array.isArray(agent.roles))
    && data.roles.every((role) => isObject(role) && typeof role.id === 'string' && Array.isArray(role.candidates))
    && data.providers.every((provider) => isObject(provider) && typeof provider.id === 'string' && Array.isArray(provider.hosts))
    && data.exceptions.every((exception) => isObject(exception) && typeof exception.id === 'string' && typeof exception.folder === 'string')
    && data.harness_routes.every((route) => isObject(route) && typeof route.harness === 'string')
}

/** A generation file whose hash verifies, whatever its schema; null when missing, unreadable or altered. */
function readVerified(number) {
  let generation
  try {
    generation = JSON.parse(readFileSync(generationPath(number), 'utf8'))
  } catch {
    return null
  }
  if (!isObject(generation) || generation.number !== number || typeof generation.hash !== 'string'
    || generationHash(generation) !== generation.hash || !isObject(generation.data)) return null
  return generation
}

/**
 * Whether a verified generation was approved under an earlier schema. Such a generation is
 * history only (60.2 AC7): never in force, never restored, and nothing is derived from it.
 */
function isEarlierSchema(generation) {
  return Number.isSafeInteger(generation.data.schema_version) && generation.data.schema_version < SCHEMA_VERSION
}

/** One generation file of the current schema, verified; null when it is missing, unreadable, malformed, altered or of an earlier schema. */
export function readGeneration(number) {
  const generation = readVerified(number)
  return generation === null || !wellFormed(generation.data) ? null : generation
}

/** Every generation number on disk, newest first. */
export function generationNumbers() {
  let names
  try {
    names = readdirSync(generationsDirectory())
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw new RosterError('STATE_CORRUPT', `cannot read ${generationsDirectory()} (${error.code})`)
  }
  return names.map((name) => /^(\d{6})\.json$/.exec(name)).filter(Boolean).map((match) => Number(match[1])).sort((a, b) => b - a)
}

export function lastGoodGeneration() {
  for (const number of generationNumbers()) {
    if (readGeneration(number) !== null) return number
  }
  return null
}

/**
 * The approved generation `current` points at, verified. No pointer: NOT_APPROVED (exit 5). A
 * pointer that cannot be read, names a missing or altered generation, or disagrees with its hash:
 * STATE_CORRUPT (exit 6), naming the newest generation that still verifies.
 */
export function readApproved() {
  let pointerText
  try {
    pointerText = readFileSync(currentPointerPath(), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new RosterError('NOT_APPROVED', 'nothing is approved yet: every agent is proposed until the owner approves the team in BMN Preferences > Team')
    }
    throw corrupt(`cannot read ${currentPointerPath()} (${error.code})`)
  }
  let pointer
  try {
    pointer = JSON.parse(pointerText)
  } catch {
    throw corrupt(`${currentPointerPath()} is not valid JSON`)
  }
  if (!isObject(pointer) || !Number.isSafeInteger(pointer.generation) || typeof pointer.hash !== 'string') {
    throw corrupt(`${currentPointerPath()} does not name a generation and hash`)
  }
  const verified = readVerified(pointer.generation)
  if (verified !== null && verified.hash === pointer.hash && isEarlierSchema(verified)) {
    throw new RosterError('NOT_APPROVED', `the approved team is from an earlier roster layout (schema ${verified.data.schema_version}); approve the roster again on the Team pages in BMN Preferences`)
  }
  const generation = readGeneration(pointer.generation)
  if (generation === null || generation.hash !== pointer.hash) {
    throw corrupt(`generation ${pointer.generation} is missing, unreadable or does not match its hash`)
  }
  return generation
}

/**
 * Approved state for an answer that must not outlive the team file (R60-NFR1, 60.1 AC4): a missing
 * file is ROSTER_MISSING and, with `valid`, an invalid one ROSTER_INVALID, before any state is
 * read. A valid file that differs from the approved version is a pending edit and changes nothing.
 */
export function readApprovedWithFile({ valid = false } = {}) {
  if (valid) readValidRoster()
  else readRosterFile()
  return readApproved()
}

function corrupt(message) {
  const lastGood = lastGoodGeneration()
  return new RosterError('STATE_CORRUPT',
    `${message}; approved state is corrupt${lastGood === null ? ' and no generation verifies' : `; the last good generation is ${lastGood}`}`,
    { lastGood })
}

/** The generation `current` names: a number, null when there is no pointer, undefined when it cannot be read. */
function pointedGeneration() {
  try {
    const pointer = JSON.parse(readFileSync(currentPointerPath(), 'utf8'))
    return isObject(pointer) && Number.isSafeInteger(pointer.generation) ? pointer.generation : undefined
  } catch (error) {
    return error.code === 'ENOENT' ? null : undefined
  }
}

/** The generations the history log says were put into effect; null when there is no log. */
function loggedGenerations() {
  let text
  try {
    text = readFileSync(historyLogPath(), 'utf8')
  } catch {
    return null
  }
  const logged = new Set()
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line)
      if (isObject(entry) && (entry.event === 'approval' || entry.event === 'restore') && Number.isSafeInteger(entry.generation)) logged.add(entry.generation)
    } catch { /* not a line BMN wrote */ }
  }
  return logged
}

/**
 * Marks the generations that were written and never pointed to (a stop between the two writes of
 * an approval). One that took effect is `current`, or has its line in the history log, written
 * once `current` moved, or is recorded by a later generation as the one in effect before it.
 * With an unreadable pointer, or a pointer and no log, BMN cannot tell and marks nothing.
 */
function markUnfinished(entries) {
  const pointed = pointedGeneration()
  const logged = loggedGenerations()
  if (pointed === undefined || (logged === null && pointed !== null)) return entries
  const parents = new Set(entries.filter((entry) => entry.valid && Number.isSafeInteger(entry.parent)).map((entry) => entry.parent))
  const tookEffect = (number) => number === pointed || parents.has(number) || (logged !== null && logged.has(number))
  return entries.map((entry) => (entry.valid && entry.earlier_schema === undefined && !tookEffect(entry.number) ? { ...entry, unfinished: true } : entry))
}

/**
 * Approval history, newest first: number, time, parent, kind and the roster hash each came from.
 * A generation of an earlier schema is listed with `earlier_schema` and can only be looked at; one
 * that never took effect is listed with `unfinished`.
 */
export function listGenerations() {
  return markUnfinished(generationNumbers().map((number) => {
    const verified = readVerified(number)
    if (verified === null) return { number, valid: false }
    const earlier = isEarlierSchema(verified)
    if (!earlier && !wellFormed(verified.data)) return { number, valid: false }
    return {
      number, valid: true, created_at: verified.created_at, parent: verified.parent, kind: verified.kind,
      roster_file_hash: verified.roster_file_hash, ...(verified.restored_from === undefined ? {} : { restored_from: verified.restored_from }),
      agents: Array.isArray(verified.data.agents) ? verified.data.agents.length : 0, hash: verified.hash,
      ...(earlier ? { earlier_schema: verified.data.schema_version } : {})
    }
  }))
}

/** Why a generation cannot be restored, or null when it can: missing, altered, or approved under an earlier schema. */
export function restoreProblem(number) {
  const verified = readVerified(number)
  if (verified === null) return `version ${number} is missing or does not verify`
  if (isEarlierSchema(verified)) return `version ${number} was approved under an earlier roster layout and can only be viewed`
  return wellFormed(verified.data) ? null : `version ${number} is missing or does not verify`
}

// ---------------------------------------------------------------------------------------------
// Differences between approved machine data and the file

/** Fields status shows only as changed, with a short hash: the owner's free text and exception folders. */
const HASHED_FIELDS = [...FREE_TEXT_FIELDS, 'folder']

function shown(field, value, hashed = HASHED_FIELDS.includes(field)) {
  if (value === undefined) return { present: false }
  if (hashed) return { present: true, hash: sha256(canonicalJson(value)).slice(0, 12) }
  return { present: true, value }
}

function sameValue(a, b) {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null) && (a === undefined) === (b === undefined)
}

/** The keyed lists machine data is made of: the scope a difference names, the key and the fields compared. */
const DIFF_SCOPES = [
  { scope: 'agent', list: 'agents', key: 'id', fields: AGENT_FIELDS },
  { scope: 'roles', list: 'roles', key: 'id', fields: ['description', 'candidates', 'then', 'recheck', 'small_work'] },
  { scope: 'providers', list: 'providers', key: 'id', fields: ['name', 'hosts', 'sites', 'private_work'] },
  { scope: 'exceptions', list: 'exceptions', key: 'id', fields: ['provider', 'folder'] },
  { scope: 'harness-routes', list: 'harness_routes', key: 'harness', fields: ['provider', 'basis', 'accepted_versions'] }
]

/**
 * Every machine difference, approved → file. Free-text fields and exception folders carry only a
 * short hash on each side, so `status` can say one changed without printing it. `folders` is for
 * the owner's own review in BMN, which must show the exact folder an exception would allow.
 */
export function machineDiff(approved, file, { folders = false } = {}) {
  const hashed = (field) => HASHED_FIELDS.includes(field) && !(folders && field === 'folder')
  const out = []
  for (const { scope, list, key, fields } of DIFF_SCOPES) {
    const before = new Map(approved[list].map((item) => [item[key], item]))
    const after = new Map(file[list].map((item) => [item[key], item]))
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const was = before.get(id)
      const now = after.get(id)
      if (was === undefined || now === undefined) {
        // The whole entry rides along, so an approval shows every value it adds or removes; hashed fields as a hash.
        const entry = was ?? now
        const value = Object.fromEntries(fields.filter((field) => Object.hasOwn(entry, field))
          .map((field) => [field, hashed(field) ? `text ${sha256(canonicalJson(entry[field])).slice(0, 8)}` : entry[field]]))
        out.push({ scope, id, field: null, kind: was === undefined ? 'added' : 'removed',
          ...(now ? { after: { present: true, value } } : { before: { present: true, value } }) })
        continue
      }
      for (const field of fields) {
        if (sameValue(was[field], now[field])) continue
        out.push({ scope, id, field, kind: was[field] === undefined ? 'added' : now[field] === undefined ? 'removed' : 'changed',
          ...(hashed(field) ? { free_text: true } : {}), before: shown(field, was[field], hashed(field)), after: shown(field, now[field], hashed(field)) })
      }
    }
  }
  return out
}

function valueText(side) {
  if (!side || !side.present) return '(none)'
  if (side.hash !== undefined) return `#${side.hash}`
  return typeof side.value === 'string' ? side.value : JSON.stringify(side.value)
}

export function diffLine(entry) {
  const where = `${entry.scope === 'agent' ? 'agent' : `## ${entry.scope}`} ${entry.id}${entry.field ? `.${entry.field}` : ''}`
  if (entry.field === null) return `${where}: ${entry.kind === 'added' ? 'in the file, not approved' : 'approved, no longer in the file'}`
  if (entry.free_text) return `${where}: changed (${valueText(entry.before)} -> ${valueText(entry.after)})`
  return `${where}: ${valueText(entry.before)} -> ${valueText(entry.after)}`
}

/** A complete generation object with its hash; pure, so the app's writer and the tests build the same bytes. */
export function buildGeneration({ number, parent, data, rosterFileHash, kind = 'approval', restoredFrom, now = new Date() }) {
  const generation = {
    schema: 1, number, parent, created_at: now.toISOString(), kind, roster_file_hash: rosterFileHash, data,
    ...(restoredFrom === undefined ? {} : { restored_from: restoredFrom })
  }
  return { ...generation, hash: generationHash(generation) }
}
