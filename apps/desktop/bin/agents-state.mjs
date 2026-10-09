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
    && isObject(data.data_labels) && Array.isArray(data.data_labels.paths) && Array.isArray(data.harness_routes)
    && data.agents.every((agent) => isObject(agent) && typeof agent.id === 'string' && Array.isArray(agent.efforts) && Array.isArray(agent.roles))
    && data.roles.every((role) => isObject(role) && typeof role.id === 'string' && Array.isArray(role.candidates))
}

/** One generation file, verified; null when it is missing, unreadable, malformed or its hash does not match. */
export function readGeneration(number) {
  let generation
  try {
    generation = JSON.parse(readFileSync(generationPath(number), 'utf8'))
  } catch {
    return null
  }
  if (!isObject(generation) || generation.number !== number || typeof generation.hash !== 'string'
    || generationHash(generation) !== generation.hash || !wellFormed(generation.data)) return null
  return generation
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
      throw new RosterError('NOT_APPROVED', 'nothing is approved yet: every agent is proposed until the owner approves the roster in BMN Preferences > Agents')
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
  const generation = readGeneration(pointer.generation)
  if (generation === null || generation.hash !== pointer.hash) {
    throw corrupt(`generation ${pointer.generation} is missing, unreadable or does not match its hash`)
  }
  return generation
}

function corrupt(message) {
  const lastGood = lastGoodGeneration()
  return new RosterError('STATE_CORRUPT',
    `${message}; approved state is corrupt${lastGood === null ? ' and no generation verifies' : `; the last good generation is ${lastGood}`}`,
    { lastGood })
}

/** Approval history, newest first: number, time, parent, kind and the roster hash each came from. */
export function listGenerations() {
  return generationNumbers().map((number) => {
    const generation = readGeneration(number)
    return generation === null
      ? { number, valid: false }
      : {
          number, valid: true, created_at: generation.created_at, parent: generation.parent, kind: generation.kind,
          roster_file_hash: generation.roster_file_hash, ...(generation.restored_from === undefined ? {} : { restored_from: generation.restored_from }),
          agents: generation.data.agents.length, hash: generation.hash
        }
  })
}

// ---------------------------------------------------------------------------------------------
// Differences between approved machine data and the file

function shown(field, value) {
  if (value === undefined) return { present: false }
  if (FREE_TEXT_FIELDS.includes(field)) return { present: true, hash: sha256(canonicalJson(value)).slice(0, 12) }
  return { present: true, value }
}

function sameValue(a, b) {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null) && (a === undefined) === (b === undefined)
}

/**
 * Every machine difference, approved → file. Free-text fields carry only a short hash on each side,
 * so `status` can say a note changed without printing it.
 */
export function machineDiff(approved, file) {
  const out = []
  const push = (scope, id, field, before, after) => {
    out.push({ scope, id, field, kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
      ...(FREE_TEXT_FIELDS.includes(field) ? { free_text: true } : {}), before: shown(field, before), after: shown(field, after) })
  }
  const keyed = (list, key) => new Map(list.map((item) => [item[key], item]))
  const approvedAgents = keyed(approved.agents, 'id')
  const fileAgents = keyed(file.agents, 'id')
  for (const id of new Set([...approvedAgents.keys(), ...fileAgents.keys()])) {
    const before = approvedAgents.get(id)
    const after = fileAgents.get(id)
    if (before === undefined || after === undefined) {
      // The whole entry rides along, so an approval shows every value it adds or removes; free text as a hash.
      const entry = before ?? after
      const value = Object.fromEntries(AGENT_FIELDS.filter((field) => Object.hasOwn(entry, field))
        .map((field) => [field, FREE_TEXT_FIELDS.includes(field) ? `text ${sha256(canonicalJson(entry[field])).slice(0, 8)}` : entry[field]]))
      out.push({ scope: 'agent', id, field: null, kind: before === undefined ? 'added' : 'removed',
        ...(after ? { after: { present: true, value } } : { before: { present: true, value } }) })
      continue
    }
    for (const field of AGENT_FIELDS) {
      if (!sameValue(before[field], after[field])) push('agent', id, field, before[field], after[field])
    }
  }
  const approvedRoles = keyed(approved.roles, 'id')
  const fileRoles = keyed(file.roles, 'id')
  for (const id of new Set([...approvedRoles.keys(), ...fileRoles.keys()])) {
    const before = approvedRoles.get(id)
    const after = fileRoles.get(id)
    if (before === undefined || after === undefined) {
      out.push({ scope: 'roles', id, field: null, kind: before === undefined ? 'added' : 'removed',
        ...(after ? { after: { present: true, value: after } } : { before: { present: true, value: before } }) })
      continue
    }
    for (const field of ['candidates', 'then', 'recheck', 'small_epic']) {
      if (!sameValue(before[field], after[field])) push('roles', id, field, before[field], after[field])
    }
  }
  if (approved.data_labels.default !== file.data_labels.default) {
    push('data-labels', 'default', 'label', approved.data_labels.default, file.data_labels.default)
  }
  const approvedPaths = new Map(approved.data_labels.paths.map((entry) => [entry.path, entry.label]))
  const filePaths = new Map(file.data_labels.paths.map((entry) => [entry.path, entry.label]))
  for (const path of new Set([...approvedPaths.keys(), ...filePaths.keys()])) {
    if (approvedPaths.get(path) !== filePaths.get(path)) push('data-labels', path, 'label', approvedPaths.get(path), filePaths.get(path))
  }
  const approvedRoutes = keyed(approved.harness_routes, 'harness')
  const fileRoutes = keyed(file.harness_routes, 'harness')
  for (const harness of new Set([...approvedRoutes.keys(), ...fileRoutes.keys()])) {
    const before = approvedRoutes.get(harness)
    const after = fileRoutes.get(harness)
    if (before === undefined || after === undefined) {
      out.push({ scope: 'harness-routes', id: harness, field: null, kind: before === undefined ? 'added' : 'removed',
        ...(after ? { after: { present: true, value: after } } : { before: { present: true, value: before } }) })
      continue
    }
    for (const field of ['provider', 'security', 'basis', 'accepted_versions']) {
      if (!sameValue(before[field], after[field])) push('harness-routes', harness, field, before[field], after[field])
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
