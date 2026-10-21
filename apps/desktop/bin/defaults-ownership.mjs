// MODULE: defaults-ownership.mjs - Durable setup ownership, unresolved intents and monotonic removal opt-outs
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { agentsDirectory } from './agents-roster.mjs'
import { assertDefaultsAdmission, defaultsAdmissionToken } from './defaults-admission.mjs'

const kinds = ['master', 'rules', 'skills', 'tools', 'hooks', 'own-skills']
const apps = ['master', 'source', 'claude', 'codex', 'opencode']
const stages = ['publishing', 'installed', 'refreshing', 'removing', 'retained', 'opted-out']
const recordKinds = ['own-skills', 'skills-written']
const refreshPhases = ['intent', 'held', 'published', 'metadata']
const sha = text => createHash('sha256').update(text).digest('hex')
const failure = (message, code = 'DEFAULTS_STATE_UNAVAILABLE') => Object.assign(new Error(message), { code })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const inode = stat => `${stat.dev}:${stat.ino}`
const copy = value => JSON.parse(JSON.stringify(value))
const same = (a, b) => a.kind === b.kind && a.hash === b.hash && a.parent === b.parent && a.object === b.object
const absolute = value => typeof value === 'string' && isAbsolute(value) && value.length <= 4096 && !value.includes('\0')
const nullableHash = value => value === null || hash(value)

export function defaultsOwnershipPath() { return join(agentsDirectory(), 'state', 'setup-defaults.json') }

function targetValid(target) {
  return exact(target, ['kind', 'app', 'path', 'entry']) && kinds.includes(target.kind) && apps.includes(target.app) &&
    typeof target.path === 'string' && isAbsolute(target.path) && target.path.length <= 4096 && !target.path.includes('\0') &&
    typeof target.entry === 'string' && target.entry.length <= 256 && !target.entry.includes('\0')
}

/** Hashes identify contents; they never establish authorship after an interrupted publication. */
function fingerprintValid(value) {
  return exact(value, ['kind', 'hash', 'parent', 'object']) && ['absent', 'file', 'link', 'tree', 'entry'].includes(value.kind) &&
    (value.kind === 'absent' ? value.hash === null : hash(value.hash)) &&
    (['absent', 'entry'].includes(value.kind) ? value.object === null : typeof value.object === 'string' && /^\d+:\d+$/.test(value.object)) &&
    typeof value.parent === 'string' && /^\d+:\d+$/.test(value.parent)
}

function dependencyValid(value, entry) {
  return exact(value, ['backingInstallId', 'backingPath', 'viaSourceInstallId', 'destinationPath', 'linkText', 'destinationFingerprint', 'status']) &&
    id(value.backingInstallId) && absolute(value.backingPath) && (value.viaSourceInstallId === null || id(value.viaSourceInstallId)) &&
    absolute(value.destinationPath) && typeof value.linkText === 'string' && value.linkText.length > 0 && value.linkText.length <= 4096 && !value.linkText.includes('\0') &&
    fingerprintValid(value.destinationFingerprint) && value.destinationFingerprint.kind === 'link' && value.destinationFingerprint.hash === sha(value.linkText) &&
    (value.destinationPath === entry.target.path ? same(value.destinationFingerprint, entry.current.fingerprint) :
      entry.current.fingerprint.kind === 'tree' && value.destinationPath.startsWith(`${entry.target.path}/`)) &&
    value.status === ({ publishing: 'pending', installed: 'active', refreshing: 'active', removing: 'removing', retained: 'removing', 'opted-out': 'released' })[entry.stage]
}

function operationValid(value, entry, compatibility) {
  return exact(value, ['id', 'kind', 'phase', 'revision', 'old', 'next', 'staging', 'holding', 'recordDigests', 'nextDependencies']) && id(value.id) &&
    value.kind === 'refresh' && refreshPhases.includes(value.phase) && value.revision === entry.current.revision &&
    fingerprintValid(value.old) && same(value.old, entry.current.fingerprint) && fingerprintValid(value.next) &&
    (value.next.kind === value.old.kind || entry.target.kind === 'skills' && entry.target.app !== 'source' && ['link', 'tree'].includes(value.next.kind) && ['link', 'tree'].includes(value.old.kind)) &&
    value.next.parent === value.old.parent && absolute(value.staging) && absolute(value.holding) &&
    value.staging !== value.holding && dirname(value.staging) === dirname(value.holding) && object(value.recordDigests) &&
    Object.entries(value.recordDigests).every(([kind, digest]) => recordKinds.includes(kind) && compatibility[kind] &&
      exact(digest, ['old', 'next']) && nullableHash(digest.old) && nullableHash(digest.next) &&
      [digest.old, digest.next].includes(compatibility[kind].hash)) &&
    Array.isArray(value.nextDependencies) && value.nextDependencies.length <= 64 &&
    value.nextDependencies.every(dep => dependencyValid(dep, { ...entry, stage: 'publishing', current: { fingerprint: value.next } })) &&
    new Set(value.nextDependencies.map(dep => dep.destinationPath)).size === value.nextDependencies.length
}

export function defaultsTargetKey(target) {
  if (!targetValid(target)) throw failure('invalid defaults target')
  return sha(JSON.stringify([target.kind, target.app, target.path, target.entry]))
}

function validate(state, setupId) {
  if (!exact(state, ['version', 'setupId', 'revision', 'entries', 'compatibility']) || state.version !== 2 || state.setupId !== setupId ||
    !id(state.setupId) || !Number.isSafeInteger(state.revision) || state.revision < 1 || !object(state.entries) ||
    Object.keys(state.entries).length > 4096 || !object(state.compatibility)) throw failure('defaults ownership is corrupt or belongs to another setup; automatic writes are blocked')
  for (const [kind, record] of Object.entries(state.compatibility)) {
    if (!recordKinds.includes(kind) || !exact(record, ['path', 'hash', 'pending']) || !absolute(record.path) || !nullableHash(record.hash) ||
      (record.pending !== null && (!exact(record.pending, ['id', 'old', 'next']) || !id(record.pending.id) ||
        record.pending.old !== record.hash || !nullableHash(record.pending.next)))) throw failure('defaults compatibility ownership is ambiguous')
  }
  for (const [key, entry] of Object.entries(state.entries)) {
    if (!exact(entry, ['target', 'stage', 'transaction', 'before', 'after', 'current', 'optOut', 'operation', 'dependencies', 'compatibility']) || !targetValid(entry.target) ||
      key !== defaultsTargetKey(entry.target) || !stages.includes(entry.stage) || !id(entry.transaction) ||
      !fingerprintValid(entry.before) || !fingerprintValid(entry.after) || typeof entry.optOut !== 'boolean' ||
      entry.before.kind !== 'absent' || entry.after.kind === 'absent' || entry.before.parent !== entry.after.parent ||
      !exact(entry.current, ['revision', 'fingerprint']) || !Number.isSafeInteger(entry.current.revision) || entry.current.revision < 1 ||
      !fingerprintValid(entry.current.fingerprint) || entry.current.fingerprint.parent !== entry.after.parent ||
      (entry.current.fingerprint.kind !== entry.after.kind && !(entry.target.kind === 'skills' && entry.target.app !== 'source' &&
        ['link', 'tree'].includes(entry.current.fingerprint.kind) && ['link', 'tree'].includes(entry.after.kind))) ||
      (entry.current.revision === 1 ? !same(entry.current.fingerprint, entry.after) : !['skills', 'own-skills'].includes(entry.target.kind)) ||
      (['removing', 'retained', 'opted-out'].includes(entry.stage) !== entry.optOut) ||
      (entry.stage === 'refreshing' ? !['skills', 'own-skills'].includes(entry.target.kind) || !operationValid(entry.operation, entry, state.compatibility) : entry.operation !== null) ||
      !Array.isArray(entry.compatibility) || new Set(entry.compatibility).size !== entry.compatibility.length ||
      entry.compatibility.some(kind => !recordKinds.includes(kind) || !Object.hasOwn(state.compatibility, kind)) ||
      !Array.isArray(entry.dependencies) || entry.dependencies.length > 64 || entry.dependencies.some(dep => !dependencyValid(dep, entry)) ||
      new Set(entry.dependencies.map(dep => dep.destinationPath)).size !== entry.dependencies.length ||
      (entry.dependencies.length > 0 && !['skills', 'own-skills'].includes(entry.target.kind))) {
      throw failure('defaults ownership has an ambiguous entry; automatic writes are blocked')
    }
  }
  for (const entry of Object.values(state.entries)) for (const dependency of [...entry.dependencies, ...(entry.operation?.nextDependencies ?? [])]) {
    const backing = Object.values(state.entries).find(candidate => candidate.transaction === dependency.backingInstallId && candidate.target.path === dependency.backingPath)
    const source = dependency.viaSourceInstallId === null ? null : Object.values(state.entries).find(candidate => candidate.transaction === dependency.viaSourceInstallId && candidate.target.app === 'source')
    if (!backing || backing === entry || !['skills', 'own-skills'].includes(backing.target.kind) ||
      (dependency.status !== 'released' && ['publishing', 'opted-out'].includes(backing.stage)) ||
      (dependency.viaSourceInstallId !== null && (!source || !source.dependencies.some(dep => dep.backingInstallId === dependency.backingInstallId && dep.backingPath === dependency.backingPath)))) {
      throw failure('defaults ownership has an unresolved backing dependency')
    }
  }
  return state
}

function readRegular(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw failure('defaults ownership is not a bounded regular file')
    return { text: readFileSync(fd, 'utf8'), identity: inode(stat) }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw failure('defaults ownership cannot be read safely; automatic writes are blocked')
  } finally { if (fd !== undefined) closeSync(fd) }
}

/** Sync data before its publication, and its directory before proceeding to a target write. */
function publish(path, text, expected) {
  assertDefaultsAdmission()
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw failure('defaults ownership is too large; nothing more was written')
  const directory = dirname(path), parentPath = realpathSync(directory), parent = inode(lstatSync(parentPath))
  const temporary = join(directory, `.setup-defaults-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  let fd
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined
    assertDefaultsAdmission()
    const current = readRegular(path)
    if (realpathSync(directory) !== parentPath || inode(lstatSync(parentPath)) !== parent ||
      (current?.text ?? null) !== (expected?.text ?? null) || (current?.identity ?? null) !== (expected?.identity ?? null)) {
      throw failure('defaults ownership changed while it was read; nothing more was written', 'REVISION_CONFLICT')
    }
    if (expected === null) {
      // A first journal never replaces an entry that appeared after the last check.
      linkSync(temporary, path); unlinkSync(temporary)
    } else renameSync(temporary, path)
    const parentFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
    const observed = readRegular(path)
    if (observed?.text !== text) throw failure('defaults ownership read-back failed; automatic writes are blocked')
    return observed
  } finally {
    if (fd !== undefined) closeSync(fd)
    // Preserve the publication error. A leftover staged file grants no ownership and is never reused.
    try { unlinkSync(temporary) } catch { /* Already published, absent, or cleanup unavailable. */ }
  }
}

/** Only the fresh-setup coordinator may initialize, once; normal reads never create a journal. */
export function initializeDefaultsOwnership(setupId, { path = defaultsOwnershipPath() } = {}) {
  assertDefaultsAdmission()
  if (!id(setupId)) throw failure('invalid setup ownership identity')
  if (readRegular(path) !== null) throw failure('defaults ownership already exists; it is never reinitialized')
  publish(path, JSON.stringify({ version: 2, setupId, revision: 1, entries: {}, compatibility: {} }) + '\n', null)
  return readDefaultsOwnership(setupId, { path })
}

/** Legacy paths remain unchanged without a setup journal; an existing ambiguous journal never means legacy. */
export function optionalDefaultsOwnership({ path = defaultsOwnershipPath() } = {}) {
  const observed = readRegular(path)
  if (observed === null) return null
  let setupId
  try { setupId = JSON.parse(observed.text)?.setupId } catch { throw failure('defaults ownership is corrupt; legacy writes are blocked') }
  return readDefaultsOwnership(setupId, { path })
}

/** Missing, corrupt or unresolved state is a blocker, never an empty ownership fallback. */
export function readDefaultsOwnership(setupId, { path = defaultsOwnershipPath() } = {}) {
  const initial = readRegular(path)
  if (initial === null) throw failure('defaults ownership is missing; automatic writes are blocked')
  let state
  try { state = validate(JSON.parse(initial.text), setupId) } catch (error) {
    if (error.code === 'DEFAULTS_STATE_UNAVAILABLE') throw error
    throw failure('defaults ownership is not valid JSON; automatic writes are blocked')
  }
  let receipt = initial
  const livePublications = new Map()
  const liveRefreshes = new Map()
  const liveCompatibility = new Map()
  const commit = next => {
    assertDefaultsAdmission()
    next.revision = state.revision + 1
    validate(next, setupId)
    receipt = publish(path, JSON.stringify(next) + '\n', receipt)
    state = next
  }
  const entryFor = target => state.entries[defaultsTargetKey(target)]
  const save = (target, entry) => { const next = copy(state); next.entries[defaultsTargetKey(target)] = entry; commit(next) }
  const inbound = (target, transaction) => Object.values(state.entries).flatMap(entry => [...entry.dependencies, ...(entry.operation?.nextDependencies ?? [])].filter(dep =>
    dep.status !== 'released' && dep.backingInstallId === transaction && dep.backingPath === target.path).map(dep =>
    ({ ...copy(dep), ownerTarget: copy(entry.target), ownerInstallId: entry.transaction })))
  const metadataPending = entry => entry.compatibility.some(kind => state.compatibility[kind].pending !== null)
  const dependenciesReady = entry => entry.dependencies.every(dep => {
    const backing = Object.values(state.entries).find(row => row.transaction === dep.backingInstallId && row.target.path === dep.backingPath)
    const source = dep.viaSourceInstallId === null ? null : Object.values(state.entries).find(row => row.transaction === dep.viaSourceInstallId && row.target.app === 'source')
    return backing?.stage === 'installed' && !backing.optOut && (dep.viaSourceInstallId === null || source?.stage === 'installed' && !source.optOut)
  })
  return {
    snapshot: () => copy(state),
    inspect(target, current) {
      if (!fingerprintValid(current)) throw failure('invalid defaults observation')
      const entry = entryFor(target)
      if (!entry) return 'new'
      if (entry.optOut) return 'opted-out'
      if (entry.stage !== 'installed') throw failure('an interrupted defaults publication needs inspection; matching bytes do not establish ownership')
      if (same(entry.current.fingerprint, current)) return 'installed'
      if (current.kind === 'absent' && current.parent === entry.current.fingerprint.parent) {
        if (inbound(target, entry.transaction).length) throw failure('the backing is missing while recorded destinations still depend on it', 'REVISION_CONFLICT')
        save(target, { ...entry, stage: 'opted-out', optOut: true, dependencies: entry.dependencies.map(dep => ({ ...dep, status: 'released' })) })
        return 'opted-out'
      }
      throw failure('a defaults target changed outside BMN; it is left as it is', 'REVISION_CONFLICT')
    },
    beginInstall(target, transaction, before, after, { dependencies = [], compatibility = [] } = {}) {
      if (!id(transaction) || !fingerprintValid(before) || !fingerprintValid(after) || before.kind !== 'absent' || after.kind === 'absent' || before.parent !== after.parent) {
        throw failure('a default install must start with an absent target and a valid transaction')
      }
      if (entryFor(target)) throw failure('defaults ownership already records this target; automatic reinstallation is refused')
      const entry = { target: copy(target), transaction, before: copy(before), after: copy(after), current: { revision: 1, fingerprint: copy(after) },
        stage: 'publishing', optOut: false, operation: null, dependencies: copy(dependencies), compatibility: copy(compatibility) }
      if (!Array.isArray(dependencies) || !Array.isArray(compatibility) || !dependenciesReady(entry) ||
        compatibility.some(kind => !state.compatibility[kind] || state.compatibility[kind].pending !== null)) throw failure('an install has unresolved backing or metadata')
      save(target, entry)
      livePublications.set(defaultsTargetKey(target), defaultsAdmissionToken())
    },
    completeInstall(target, transaction, observed) {
      const entry = entryFor(target)
      if (!entry || livePublications.get(defaultsTargetKey(target)) !== defaultsAdmissionToken() || entry.transaction !== transaction || entry.stage !== 'publishing' ||
        !fingerprintValid(observed) || !same(entry.after, observed) || !dependenciesReady(entry) || metadataPending(entry)) {
        throw failure('defaults publication could not be verified; its intent remains unresolved')
      }
      save(target, { ...entry, stage: 'installed', dependencies: entry.dependencies.map(dep => ({ ...dep, status: 'active' })) })
      livePublications.delete(defaultsTargetKey(target))
    },
    beginUndo(target, transaction, current) {
      const entry = entryFor(target)
      if (!entry || entry.transaction !== transaction || !fingerprintValid(current) ||
        !['installed', 'removing', 'retained'].includes(entry.stage) || entry.operation !== null || !same(entry.current.fingerprint, current)) {
        throw failure('Undo cannot prove this target still holds its completed setup write; it is left as it is', 'REVISION_CONFLICT')
      }
      const retained = inbound(target, transaction).length > 0 || metadataPending(entry)
      save(target, { ...entry, stage: retained ? 'retained' : 'removing', optOut: true,
        dependencies: entry.dependencies.map(dep => ({ ...dep, status: 'removing' })) })
      if (retained) throw failure('the default is opted out but retained for recorded or unresolved dependencies', 'DEFAULTS_DEPENDENCIES')
    },
    completeUndo(target, transaction, current) {
      const entry = entryFor(target)
      if (!entry || entry.transaction !== transaction || entry.stage !== 'removing' || !fingerprintValid(current) || !same(entry.before, current) ||
        inbound(target, transaction).length > 0 || metadataPending(entry)) {
        throw failure('Undo removal could not be verified; the opt-out remains in force')
      }
      save(target, { ...entry, stage: 'opted-out', optOut: true, dependencies: entry.dependencies.map(dep => ({ ...dep, status: 'released' })) })
    },
    dependenciesFor(target, transaction) {
      if (entryFor(target)?.transaction !== transaction) throw failure('the backing installation is unknown')
      return inbound(target, transaction)
    },
    retainUndo(target, transaction) {
      const entry = entryFor(target)
      if (!entry || entry.transaction !== transaction || !['removing', 'retained'].includes(entry.stage)) throw failure('only an admitted Undo may retain its backing')
      save(target, { ...entry, stage: 'retained' })
    },
    beginRefresh(target, transaction, operation) {
      const entry = entryFor(target)
      if (!entry || entry.transaction !== transaction || entry.stage !== 'installed' || entry.optOut || !['skills', 'own-skills'].includes(target.kind) ||
        entry.current.revision !== operation?.expectedRevision || entry.current.revision === Number.MAX_SAFE_INTEGER || metadataPending(entry)) throw failure('refresh cannot prove a completed current revision')
      const next = { id: operation.id, kind: 'refresh', phase: 'intent', revision: entry.current.revision, old: copy(operation.old), next: copy(operation.next),
        staging: operation.staging, holding: operation.holding, recordDigests: copy(operation.recordDigests), nextDependencies: copy(operation.dependencies ?? []) }
      if (!operationValid(next, entry, state.compatibility) || Object.entries(next.recordDigests).some(([kind, digest]) =>
        state.compatibility[kind].pending !== null || state.compatibility[kind].hash !== digest.old) ||
        !dependenciesReady({ dependencies: next.nextDependencies })) throw failure('refresh metadata, dependencies or fingerprints are ambiguous')
      save(target, { ...entry, stage: 'refreshing', operation: next })
      liveRefreshes.set(defaultsTargetKey(target), defaultsAdmissionToken())
    },
    advanceRefresh(target, transaction, operationId, phase) {
      const entry = entryFor(target), operation = entry?.operation
      if (!operation || entry.transaction !== transaction || entry.stage !== 'refreshing' || operation.id !== operationId ||
        liveRefreshes.get(defaultsTargetKey(target)) !== defaultsAdmissionToken() || refreshPhases.indexOf(phase) !== refreshPhases.indexOf(operation.phase) + 1 ||
        (phase === 'metadata' && Object.entries(operation.recordDigests).some(([kind, digest]) =>
          state.compatibility[kind].pending !== null || state.compatibility[kind].hash !== digest.next))) throw failure('refresh transition is unavailable or its metadata is unresolved')
      save(target, { ...entry, operation: { ...operation, phase } })
    },
    completeRefresh(target, transaction, operationId, observed) {
      const entry = entryFor(target), operation = entry?.operation
      if (!operation || entry.transaction !== transaction || entry.stage !== 'refreshing' || operation.id !== operationId || operation.phase !== 'metadata' ||
        liveRefreshes.get(defaultsTargetKey(target)) !== defaultsAdmissionToken() || !fingerprintValid(observed) || !same(operation.next, observed) || metadataPending(entry) ||
        !dependenciesReady({ dependencies: operation.nextDependencies })) {
        throw failure('refresh completion is unverified; its intent stays unresolved')
      }
      save(target, { ...entry, stage: 'installed', operation: null, current: { revision: entry.current.revision + 1, fingerprint: copy(observed) },
        dependencies: operation.nextDependencies.map(dep => ({ ...dep, status: 'active' })) })
      liveRefreshes.delete(defaultsTargetKey(target))
    },
    bindCompatibility(kind, path, observedHash) {
      if (!recordKinds.includes(kind) || !absolute(path) || !nullableHash(observedHash) || Object.hasOwn(state.compatibility, kind)) throw failure('compatibility provenance cannot be initialized or replaced')
      const next = copy(state); next.compatibility[kind] = { path, hash: observedHash, pending: null }; commit(next)
    },
    beginCompatibilityWrite(kind, operationId, expectedHash, nextHash) {
      const record = state.compatibility[kind]
      if (!recordKinds.includes(kind) || !record || record.pending !== null || !id(operationId) || !nullableHash(nextHash)) throw failure('compatibility metadata has an unresolved operation')
      if (record.hash !== expectedHash) throw failure('compatibility metadata changed since it was planned', 'REVISION_CONFLICT')
      const next = copy(state); next.compatibility[kind].pending = { id: operationId, old: expectedHash, next: nextHash }; commit(next)
      liveCompatibility.set(kind, defaultsAdmissionToken())
    },
    completeCompatibilityWrite(kind, operationId, observedHash) {
      const record = state.compatibility[kind]
      if (!recordKinds.includes(kind) || !record?.pending || record.pending.id !== operationId || record.pending.next !== observedHash ||
        liveCompatibility.get(kind) !== defaultsAdmissionToken()) throw failure('compatibility metadata completion cannot be inferred after interruption')
      const next = copy(state); next.compatibility[kind] = { path: record.path, hash: observedHash, pending: null }; commit(next)
      liveCompatibility.delete(kind)
    }
  }
}
