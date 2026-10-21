// MODULE: setup-file-defaults.mjs - Absent-only whole-file setup defaults and existing Earlier installs Undo
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { assertDefaultsAdmission, withDefaultsAdmission } from './defaults-admission.mjs'
import { defaultsTargetKey, readDefaultsOwnership } from './defaults-ownership.mjs'
import { publishSetupEntry } from './defaults-publish.mjs'
import { changeRulesRecord, confirm, newTransaction, rememberSetupMaster, rulesRecord, writePrivate } from './agents-rules.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
const inode = stat => `${stat.dev}:${stat.ino}`
const conflict = message => Object.assign(new Error(message), { code: 'REVISION_CONFLICT' })
const same = (a, b) => a.kind === b.kind && a.hash === b.hash && a.parent === b.parent && a.object === b.object

function parentOf(path) {
  if (resolve(path) !== path) throw conflict('setup target must have one canonical absolute path')
  const directory = dirname(path), real = realpathSync(directory)
  const fd = openSync(real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const parent = { fd, directory, real, identity: inode(fstatSync(fd)) }
  try { checkParent(parent); return parent } catch (error) { closeSync(fd); throw error }
}

function checkParent(parent) {
  if (realpathSync(parent.directory) !== parent.real || inode(lstatSync(parent.real)) !== parent.identity ||
    inode(fstatSync(parent.fd)) !== parent.identity) throw conflict('the setup target directory changed; nothing more was written')
}

/** Pin the directory used by publication/removal; never follow a replacement parent into another folder. */
const pinned = (parent, name) => `/proc/self/fd/${parent.fd}/${name}`

// Paired OpenCode hook publications use the same pinned-directory and whole-file observations.
export { parentOf as setupFileParent, checkParent as assertSetupFileParent, pinned as setupPinnedPath, observe as observeSetupFile }
export { saveManifest as saveSetupManifest }

/** Completed holdings retain exact provenance; malformed or unfinished records never authorize recovery. */
export function assertSetupHoldingRecovery(manifest, key, path, expected) {
  const record = manifest.setup?.[key]
  if (record === undefined) return
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
  const fingerprint = value => exact(value, ['kind', 'hash', 'parent', 'object']) && value.kind === 'file' &&
    typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) &&
    typeof value.parent === 'string' && /^\d+:\d+$/.test(value.parent) && typeof value.object === 'string' && /^\d+:\d+$/.test(value.object)
  const prefix = `.bmn-hold-${manifest.id}-`
  if (!exact(record, ['version', 'phase', 'sourcePath', 'holdingPath', 'expected']) || record.version !== 1 || record.phase !== 'complete' ||
    record.sourcePath !== path || typeof record.holdingPath !== 'string' || dirname(record.holdingPath) !== realpathSync(dirname(path)) ||
    !basename(record.holdingPath).startsWith(prefix) || !/^[a-f0-9]{16}$/.test(basename(record.holdingPath).slice(prefix.length)) ||
    !fingerprint(record.expected) || !fingerprint(expected) || !same(record.expected, expected)) {
    throw conflict('an interrupted or corrupt holding operation needs inspection; automatic restoration is blocked')
  }
}

function observe(path, parent) {
  checkParent(parent)
  const entry = pinned(parent, basename(path))
  let stat
  try { stat = lstatSync(entry) } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'absent', hash: null, parent: parent.identity, object: null }
    throw error
  }
  if (stat.isSymbolicLink()) return { kind: 'link', hash: sha(readlinkSync(entry)), parent: parent.identity, object: inode(stat) }
  if (!stat.isFile() || stat.size > 1024 * 1024) throw conflict('the setup target is not a bounded regular file; it is left as it is')
  const fd = openSync(entry, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const current = fstatSync(fd)
    if (!current.isFile() || inode(current) !== inode(stat) || current.size > 1024 * 1024) throw conflict('the setup target changed while it was read')
    return { kind: 'file', hash: sha(readFileSync(fd)), parent: parent.identity, object: inode(current) }
  } finally { closeSync(fd) }
}

function saveManifest(folder, manifest) {
  writePrivate(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2), { guard: assertDefaultsAdmission })
  const fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/**
 * Namespace removal without destructive unlink. The qualified helper is no-replace, not inode CAS:
 * a foreign replacement can move, so validate the holding and return it only to an absent name.
 * Holdings survive both success and uncertainty. No cleanup or restart infers ownership from bytes.
 */
export function holdSetupFile(path, expected, parent, { manifest, folder, key = 'removal', afterMove } = {}) {
  assertDefaultsAdmission(); checkParent(parent)
  if (manifest.setup[key]) throw Object.assign(conflict('an earlier holding operation needs inspection'), {
    recovery: manifest.setup[key], message: `An earlier holding operation needs inspection: ${manifest.setup[key].holdingPath}`
  })
  const holdingName = `.bmn-hold-${manifest.id}-${randomBytes(8).toString('hex')}`
  const operation = { version: 1, phase: 'intent', sourcePath: path,
    holdingPath: join(parent.real, holdingName), expected }
  manifest.setup[key] = operation
  saveManifest(folder, manifest)
  try {
    publishSetupEntry(parent.fd, basename(path), holdingName, expected)
    afterMove?.({ path, holdingPath: operation.holdingPath })
    const held = observe(operation.holdingPath, parent)
    if (!same(held, expected)) throw conflict('the held file is a concurrent replacement')
    operation.phase = 'verified'
    saveManifest(folder, manifest)
    checkParent(parent)
    return operation
  } catch (error) {
    operation.phase = 'unresolved'
    try {
      const held = observe(operation.holdingPath, parent)
      // Never return a known owned file after an interruption: the opt-out remains in force.
      // A foreign held object is preserved, with no-replace restoration of its original name.
      if (held.kind !== 'absent' && !same(held, expected)) {
        try {
          publishSetupEntry(parent.fd, holdingName, basename(path), held)
          operation.phase = 'foreign-returned'
        } catch { /* Both names remain preserved; report the unresolved holding, never overwrite. */ }
      }
    } catch { /* A changed parent or unreadable holding needs inspection, never deletion. */ }
    try { saveManifest(folder, manifest) } catch { /* The pre-mutation intent remains durable. */ }
    error.recovery = operation
    error.message += `; target and holding require inspection; recovery path ${operation.holdingPath}; phase ${operation.phase}`
    throw error
  }
}

/** This adapter handles an entire absent rules/master/plugin file, never a shared config file. */
export function installSetupFile(target, text, { setupId, now = new Date(), beforePublish, afterPublish } = {}) {
  return withDefaultsAdmission(() => {
    if (!['master', 'rules'].includes(target.kind) && !(target.kind === 'hooks' && target.entry === 'plugin')) {
      throw conflict('this setup adapter cannot replace a shared configuration file')
    }
    if ((target.kind === 'master' && (target.app !== 'master' || target.entry !== 'master')) ||
      (target.kind === 'rules' && (!['claude', 'codex', 'opencode'].includes(target.app) || target.entry !== 'rules')) ||
      (target.kind === 'hooks' && target.app !== 'opencode')) throw conflict('this file is not a supported setup target')
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || text.includes('\0')) throw conflict('invalid setup file text')
    defaultsTargetKey(target)
    const parent = parentOf(target.path)
    let staged, manifest, folder, published = false
    try {
      const journal = readDefaultsOwnership(setupId)
      const before = observe(target.path, parent), state = journal.inspect(target, before)
      const priorRecord = target.kind === 'rules' ? rulesRecord(target.path) : null
      if (state === 'installed' && target.kind === 'rules' && priorRecord !== before.hash) throw conflict('the rules last-written record changed; the file is left as it is')
      if (state !== 'new') return { code: 'OK', transaction: null, written: [], state }
      if (before.kind !== 'absent') return { code: 'FOREIGN_TARGET', transaction: null, written: [], message: `${target.path} was not written by setup; it is left as it is` }
      const allocated = newTransaction(now), id = allocated.id
      folder = allocated.folder
      const name = `.bmn-setup-${process.pid}-${randomBytes(8).toString('hex')}.tmp`
      staged = pinned(parent, name)
      manifest = { id, created_at: now.toISOString(), kind: 'setup-file', reason: `setup ${target.kind}`, state: 'started',
        targets: ['claude', 'codex', 'opencode'].includes(target.app) ? [{ harness: target.app, path: target.path }] : [],
        ...(target.kind === 'master' ? { master: { path: target.path } } : {}),
        setup: { setupId, target, before, staging: { version: 1, kind: 'file', sourcePath: target.path, path: join(parent.real, name) },
          ...(target.kind === 'rules' ? { priorRecord } : {}) } }
      saveManifest(folder, manifest)
      const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      let after
      try { writeFileSync(fd, text); fsyncSync(fd); after = { kind: 'file', hash: sha(text), parent: parent.identity, object: inode(fstatSync(fd)) } }
      finally { closeSync(fd) }
      manifest.setup.after = after
      saveManifest(folder, manifest)
      journal.beginInstall(target, id, before, after)
      beforePublish?.({ transaction: id, target })
      assertDefaultsAdmission(); checkParent(parent)
      // Unlike rename, link refuses a leaf that appeared after the last read.
      linkSync(staged, pinned(parent, basename(target.path)))
      published = true
      unlinkSync(staged); staged = undefined; fsyncSync(parent.fd)
      afterPublish?.({ transaction: id, target })
      if (target.kind === 'rules') changeRulesRecord(target.path, priorRecord, after.hash)
      if (target.kind === 'master') rememberSetupMaster(target.path, after.hash, `setup master ${id}`, now)
      journal.completeInstall(target, id, observe(target.path, parent))
      manifest.state = 'complete'; saveManifest(folder, manifest)
      return { code: 'OK', transaction: id, written: [{ harness: target.app, path: target.path }], state: 'installed' }
    } catch (error) {
      if (manifest) {
        manifest.state = 'failed'
        try { saveManifest(folder, manifest) } catch { /* Preserve the failure and the last durable intent. */ }
      }
      return { code: published ? 'INSTALL_FAILED' : error.code ?? 'IO_ERROR', transaction: manifest?.id ?? null,
        written: published ? [{ harness: target.app, path: target.path }] : [],
        message: `${target.path}: ${error.message}; ${published ? 'one file published; ownership needs inspection' : 'no file published'}` }
    } finally {
      if (staged) { try { unlinkSync(staged) } catch { /* An unpublished stage is never reused. */ } }
      closeSync(parent.fd)
    }
  })
}

export async function restoreSetupFileTransaction(manifest, folder, { yes = false, asJson = false, planOnly = false, expectedPlanHash, beforeRemove, afterRemove, afterMove } = {}) {
  const removal = { removed: false }
  try {
    return await restoreSetupFileAdmitted(manifest, folder, { yes, asJson, planOnly, expectedPlanHash, beforeRemove, afterRemove, afterMove, removal })
  } catch (error) {
    const target = manifest.setup?.target
    return { code: error.code ?? 'IO_ERROR', message: `${target?.path ?? 'Setup transaction'}: ${removal.removed ? 'file removed; opt-out saved; completion failed: ' : ''}${error.message}`,
      restored: removal.removed && target?.kind !== 'master' ? [target.app] : [],
      ...(error.recovery || manifest.setup?.removal ? { recovery: error.recovery ?? manifest.setup.removal } : {}),
      ...(removal.removed && target?.kind === 'master' ? { master: true } : {}) }
  }
}

async function restoreSetupFileAdmitted(manifest, folder, { yes, asJson, planOnly, expectedPlanHash, beforeRemove, afterRemove, afterMove, removal }) {
  const { setupId, target, before, after } = manifest.setup ?? {}
  if (!setupId || !target || before?.kind !== 'absent' || after?.kind !== 'file') throw conflict('the setup transaction is incomplete; automatic restoration is blocked')
  assertSetupHoldingRecovery(manifest, 'removal', target.path, after)
  const priorRecord = manifest.setup.priorRecord
  if (target.kind === 'rules' && priorRecord !== null && (typeof priorRecord !== 'string' || !/^[a-f0-9]{64}$/.test(priorRecord))) throw conflict('the setup rules transaction has no valid prior binding')
  const plan = () => {
    const parent = parentOf(target.path)
    try {
      const journal = readDefaultsOwnership(setupId), current = observe(target.path, parent)
      const entry = journal.snapshot().entries[defaultsTargetKey(target)]
      if (!entry || entry.transaction !== manifest.id || !same(entry.before, before) || !same(entry.after, after) ||
        !['installed', 'removing', 'opted-out'].includes(entry.stage)) throw conflict('this transaction has no completed setup ownership; its file is left as it is')
      if (!same(current, after) && !(entry.optOut && same(current, before))) throw conflict('the setup file changed since BMN wrote it; it is left as it is')
      const record = target.kind === 'rules' ? rulesRecord(target.path) : null
      if (target.kind === 'rules' && record !== after.hash && !(entry.optOut && current.kind === 'absent' && record === priorRecord)) throw conflict('the rules last-written record changed; the file is left as it is')
      const hash = sha(JSON.stringify({ id: manifest.id, target, current, record, revision: journal.snapshot().revision }))
      const row = { harness: target.app, path: target.path, resolved_path: target.path, becomes: 'removed (setup created it)', diff: '', note: 'This default stays removed after Undo.' }
      const view = target.kind === 'master' ? { targets: [], master: row } : { targets: [row] }
      return { journal, current, hash, view }
    } finally { closeSync(parent.fd) }
  }
  const shown = plan()
  if (planOnly) return { code: 'OK', plan_hash: shown.hash, ...shown.view }
  if (expectedPlanHash !== undefined && expectedPlanHash !== shown.hash) return { code: 'REVISION_CONFLICT', message: 'the setup removal changed since it was shown' }
  if (!await confirm(`Undo setup transaction ${manifest.id}?`, `${target.path}: remove this setup-created default; it stays removed`, { yes, asJson })) return { code: 'NOT_CONFIRMED' }
  return withDefaultsAdmission(() => {
    const fresh = plan()
    if (fresh.hash !== shown.hash) return { code: 'REVISION_CONFLICT', message: 'the setup removal changed while confirmation was open' }
    const parent = parentOf(target.path)
    try {
      if (fresh.current.kind !== 'absent') {
        fresh.journal.beginUndo(target, manifest.id, fresh.current)
        beforeRemove?.({ target, transaction: manifest.id })
        assertDefaultsAdmission()
        if (!same(observe(target.path, parent), fresh.current)) throw conflict('the setup file changed before removal; it is left as it is')
        holdSetupFile(target.path, fresh.current, parent, { manifest, folder, afterMove })
        removal.removed = true
        afterRemove?.({ target, transaction: manifest.id })
      }
      if (target.kind === 'rules' && rulesRecord(target.path) !== priorRecord) changeRulesRecord(target.path, after.hash, priorRecord)
      const entry = fresh.journal.snapshot().entries[defaultsTargetKey(target)]
      if (entry.stage === 'removing') fresh.journal.completeUndo(target, manifest.id, observe(target.path, parent))
      if (manifest.setup.removal) manifest.setup.removal.phase = 'complete'
      manifest.setup.undone = true; saveManifest(folder, manifest)
      return { code: 'OK', restored: target.kind === 'master' ? [] : [target.app],
        ...(manifest.setup.removal ? { recovery: manifest.setup.removal,
          message: `Setup default removed; content preserved at ${manifest.setup.removal.holdingPath}` } : {}),
        ...(target.kind === 'master' ? { master: true } : {}) }
    } finally { closeSync(parent.fd) }
  })
}
