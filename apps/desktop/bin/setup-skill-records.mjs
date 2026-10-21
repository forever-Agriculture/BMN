// MODULE: setup-skill-records.mjs - Strict, witnessed legacy metadata for setup-owned skill operations
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { agentsDirectory } from './agents-roster.mjs'
import { assertDefaultsAdmission } from './defaults-admission.mjs'
import { replaceSetupConfig, setupConfigRecovery } from './setup-config-write.mjs'
import { linkTarget } from './safe-config-write.mjs'

const kinds = ['own-skills', 'skills-written']
const failure = message => Object.assign(new Error(message), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
const sha = text => createHash('sha256').update(text).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const name = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
const pathValid = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && isAbsolute(value) && resolve(value) === value
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

export function setupSkillRecordPath(kind) {
  if (!kinds.includes(kind)) throw failure('unknown skill metadata kind')
  return kind === 'own-skills' ? join(agentsDirectory(), 'state/own-skills.json') : join(agentsDirectory(), 'state/rules/skills-written.json')
}

/** Accept only shapes the existing writers emit; permissive legacy readers cannot prove absence. */
export function validateSetupSkillRecords(kind, value) {
  let valid = false
  if (kind === 'own-skills') {
    valid = exact(value, ['version', 'skills', 'removed']) && value.version === 1 && object(value.skills) && object(value.removed) &&
      Object.keys(value.skills).length + Object.keys(value.removed).length <= 4096 &&
      Object.entries(value.skills).every(([skill, row]) => name(skill) && (exact(row, ['path', 'copy', 'at']) || exact(row, ['path', 'copy', 'at', 'took_over'])) &&
        pathValid(row.path) && basename(row.path) === skill && pathValid(row.copy) && basename(row.copy) === skill && timestamp(row.at) &&
        (!Object.hasOwn(row, 'took_over') || pathValid(row.took_over)) && !Object.hasOwn(value.removed, skill)) &&
      Object.entries(value.removed).every(([skill, at]) => name(skill) && timestamp(at))
  } else if (kind === 'skills-written') {
    valid = object(value) && Object.keys(value).length <= 4096 && Object.entries(value).every(([path, row]) => pathValid(path) &&
      object(row) && ['claude', 'codex', 'opencode'].includes(row.harness) && name(row.skill) && basename(path) === row.skill &&
      (row.kind === 'link' ? exact(row, ['harness', 'skill', 'kind', 'target']) && pathValid(row.target) :
        row.kind === 'copy' && exact(row, ['harness', 'skill', 'kind', 'hash', 'source_hash']) && hash(row.hash) && hash(row.source_hash)))
  }
  if (!valid) throw failure('skill compatibility metadata is invalid or corrupt; automatic writes are blocked')
  return value
}

function observe(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw failure('skill metadata is not a bounded regular file')
    const text = readFileSync(fd, 'utf8'), after = fstatSync(fd), leaf = lstatSync(path)
    if (stat.dev !== leaf.dev || stat.ino !== leaf.ino || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs ||
      stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw failure('skill metadata changed while it was read')
    return { hash: sha(text), text, state: { kind: 'file', text, mode: stat.mode & 0o777, directory: linkTarget(dirname(path)) } }
  } catch (error) {
    if (error.code === 'ENOENT') return { hash: null, text: null, state: { kind: 'missing', directory: linkTarget(dirname(path)) } }
    if (error.code === 'DEFAULTS_STATE_UNAVAILABLE') throw error
    throw failure('skill metadata cannot be read safely')
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function readSetupSkillRecords(journal, kind, { initialize = false } = {}) {
  const path = setupSkillRecordPath(kind), observed = observe(path)
  let value
  try { value = observed.text === null ? kind === 'own-skills' ? { version: 1, skills: {}, removed: {} } : {} : JSON.parse(observed.text) }
  catch { throw failure('skill metadata is corrupt JSON') }
  validateSetupSkillRecords(kind, value)
  let witness = journal.snapshot().compatibility[kind]
  if (!witness) {
    if (!initialize) throw failure('skill metadata has no durable provenance; automatic writes are blocked')
    assertDefaultsAdmission(); journal.bindCompatibility(kind, path, observed.hash)
    witness = journal.snapshot().compatibility[kind]
  }
  if (witness.pending !== null) throw failure('an interrupted skill metadata publication needs inspection')
  if (witness.path !== path || witness.hash !== observed.hash) throw failure('skill metadata changed or disappeared; automatic writes are blocked')
  return { path, value, ...observed }
}

/** Each physical metadata write has its own retained recovery manifest inside its owning transaction. */
export function writeSetupSkillRecords(journal, kind, prior, value, { folder, beforeCommit, afterCommit } = {}) {
  assertDefaultsAdmission(); validateSetupSkillRecords(kind, value)
  const current = readSetupSkillRecords(journal, kind)
  if (current.path !== prior?.path || current.hash !== prior.hash) throw failure('skill metadata changed since it was planned')
  const text = `${JSON.stringify(value, null, 2)}\n`, nextHash = sha(text)
  if (Buffer.byteLength(text) > 1024 * 1024) throw failure('skill metadata is too large')
  const operation = `metadata-${randomBytes(12).toString('hex')}`
  const recoveryFolder = join(folder, operation), manifest = { id: operation, kind: 'setup-skill-metadata', state: 'started', setup: {} }
  journal.beginCompatibilityWrite(kind, operation, prior.hash, nextHash)
  mkdirSync(recoveryFolder, { mode: 0o700 }); mkdirSync(dirname(current.path), { recursive: true, mode: 0o700 })
  replaceSetupConfig(current.path, current.state, text, { manifest, folder: recoveryFolder, beforeCommit, afterCommit })
  const observed = observe(current.path)
  if (observed.hash !== nextHash) throw failure('skill metadata read-back failed; its intent remains unresolved')
  journal.completeCompatibilityWrite(kind, operation, observed.hash)
  return { path: current.path, value: JSON.parse(text), ...observed, recoveryPaths: setupConfigRecovery(manifest).recoveryPaths ?? [], recoveryFolder }
}
