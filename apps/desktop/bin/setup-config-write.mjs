// MODULE: setup-config-write.mjs - Journaled preservation and no-replace publication for setup-owned shared-config edits
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertDefaultsAdmission } from './defaults-admission.mjs'
import { publishSetupEntry } from './defaults-publish.mjs'
import { assertSetupFileParent, assertSetupHoldingRecovery, holdSetupFile, observeSetupFile, saveSetupManifest, setupFileParent, setupPinnedPath } from './setup-file-defaults.mjs'
import { pathState } from './safe-config-write.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
const conflict = message => Object.assign(new Error(message), { code: 'REVISION_CONFLICT' })
const same = (a, b) => a.kind === b.kind && a.hash === b.hash && a.parent === b.parent && a.object === b.object
const keys = ['configInstall', 'configUndo']
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const fingerprint = value => exact(value, ['kind', 'hash', 'parent', 'object']) &&
  typeof value.parent === 'string' && /^\d+:\d+$/.test(value.parent) &&
  (value.kind === 'absent' ? value.hash === null && value.object === null : value.kind === 'file' &&
    typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) && typeof value.object === 'string' && /^\d+:\d+$/.test(value.object))

/** No restart adopts bytes from an unfinished or corrupt physical publication. */
export function assertSetupConfigRecovery(manifest, path) {
  for (const key of keys) {
    const operation = manifest.setup?.[key]
    if (operation === undefined) continue
    const holding = manifest.setup[`${key}Holding`]
    const valid = exact(operation, ['version', 'phase', 'path', 'directory', 'stagedPath', 'before', 'after']) && operation.version === 1 &&
      operation.path === path && operation.directory === realpathSync(dirname(path)) &&
      typeof operation.stagedPath === 'string' && dirname(operation.stagedPath) === operation.directory &&
      basename(operation.stagedPath).startsWith('.bmn-stage-') && fingerprint(operation.before) && fingerprint(operation.after) &&
      operation.after.kind === 'file' && operation.before.parent === operation.after.parent &&
      (operation.before.kind === 'absent' ? holding === undefined : holding !== undefined)
    if (!valid || operation.phase !== 'complete') throw conflict('an interrupted or corrupt setup config publication needs inspection; no automatic recovery is attempted')
    if (holding !== undefined) assertSetupHoldingRecovery(manifest, `${key}Holding`, path, operation.before)
  }
}

export function setupConfigRecovery(manifest) {
  const paths = keys.map(key => manifest.setup?.[`${key}Holding`]?.holdingPath).filter(path => typeof path === 'string')
  return paths.length ? { recoveryPaths: paths, message: `Previous configuration preserved at ${paths.join(', ')}` } : {}
}

/** Existing shared files are preserved whole; the replacement is published only into an absent name. */
export function replaceSetupConfig(path, expected, text, { manifest, folder, key = 'configInstall', beforeCommit, afterCommit, mode = 0o600, afterHold } = {}) {
  assertDefaultsAdmission()
  if (!keys.includes(key) || !manifest?.setup || !['file', 'missing'].includes(expected?.kind) || typeof text !== 'string' ||
    Buffer.byteLength(text) > 1024 * 1024 || text.includes('\0')) throw conflict('invalid setup config publication')
  assertSetupConfigRecovery(manifest, path)
  if (manifest.setup[key] !== undefined) throw conflict('this setup config publication has already been used')
  const parent = setupFileParent(path)
  let operation
  try {
    const before = observeSetupFile(path, parent)
    if (expected.directory !== parent.real || before.kind !== (expected.kind === 'missing' ? 'absent' : 'file') ||
      before.kind === 'file' && before.hash !== sha(expected.text)) throw conflict('the shared setup config changed before publication')
    const stage = `.bmn-stage-${manifest.id}-${randomBytes(8).toString('hex')}`
    operation = { version: 1, phase: 'preparing', path, directory: parent.real, stagedPath: join(parent.real, stage), before,
      after: { kind: 'file', hash: sha(text), parent: parent.identity, object: null } }
    manifest.setup[key] = operation; saveSetupManifest(folder, manifest)
    const fd = openSync(setupPinnedPath(parent, stage), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      expected.kind === 'file' ? expected.mode : mode)
    let after
    try {
      if (expected.kind === 'file') fchmodSync(fd, expected.mode)
      writeFileSync(fd, text); fsyncSync(fd)
      const stat = fstatSync(fd)
      after = { kind: 'file', hash: sha(text), parent: parent.identity, object: `${stat.dev}:${stat.ino}` }
    } finally { closeSync(fd) }
    operation.after = after; operation.phase = 'intent'; saveSetupManifest(folder, manifest)
    beforeCommit?.(); assertDefaultsAdmission(); assertSetupFileParent(parent)
    if (!same(observeSetupFile(path, parent), before)) throw conflict('the shared setup config changed before preservation')
    if (before.kind === 'file') {
      holdSetupFile(path, before, parent, { manifest, folder, key: `${key}Holding` })
      operation.phase = 'held'; saveSetupManifest(folder, manifest)
      afterHold?.()
    }
    publishSetupEntry(parent.fd, stage, basename(path), after)
    operation.phase = 'published'
    afterCommit?.()
    if (!same(observeSetupFile(path, parent), after)) throw conflict('the shared setup config changed during publication')
    operation.phase = 'complete'
    if (manifest.setup[`${key}Holding`]) manifest.setup[`${key}Holding`].phase = 'complete'
    saveSetupManifest(folder, manifest)
    return pathState(path)
  } catch (error) {
    if (operation) {
      const physicalPublication = operation.phase === 'published' || error.published ? 'reported' : error.publicationUnknown ? 'unknown' : 'none'
      operation.phase = 'unresolved'
      try { saveSetupManifest(folder, manifest) } catch { /* The durable intent still blocks automatic adoption. */ }
      error.recovery = { ...operation, physicalPublication, ...setupConfigRecovery(manifest) }
      error.message += `; inspect target ${path}, stage ${operation.stagedPath}${manifest.setup[`${key}Holding`] ? `, holding ${manifest.setup[`${key}Holding`].holdingPath}` : ''}`
    }
    throw error
  } finally { closeSync(parent.fd) }
}
