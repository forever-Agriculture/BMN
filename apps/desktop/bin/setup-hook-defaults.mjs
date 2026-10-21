// MODULE: setup-hook-defaults.mjs - Absent hook-group contributions with setup ownership and entry-only Undo
import { createHash } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertDefaultsAdmission, withDefaultsAdmission } from './defaults-admission.mjs'
import { defaultsTargetKey, readDefaultsOwnership } from './defaults-ownership.mjs'
import { agentsDirectory, canonicalJson } from './agents-roster.mjs'
import { approvedIfAny } from './agents-state.mjs'
import { confirm, newTransaction, writePrivate } from './agents-rules.mjs'
import { setupHookGroups } from './bmn-hooks.mjs'
import { pathState } from './safe-config-write.mjs'
import { assertSetupConfigRecovery, replaceSetupConfig, setupConfigRecovery } from './setup-config-write.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const identity = stat => `${stat.dev}:${stat.ino}`
const conflict = message => Object.assign(new Error(message), { code: 'REVISION_CONFLICT' })
const same = (a, b) => canonicalJson(a) === canonicalJson(b)
const transactionFolder = id => join(agentsDirectory(), 'state/rules/transactions', id)

export function setupHookPath(app, environment = process.env) {
  if (app === 'claude') return join(environment.CLAUDE_CONFIG_DIR || join(environment.HOME, '.claude'), 'settings.json')
  if (app === 'codex') return join(environment.CODEX_HOME || join(environment.HOME, '.codex'), 'hooks.json')
  throw conflict('setup hook groups require Claude Code or Codex')
}
function parentOf(path) {
  const directory = dirname(path), real = realpathSync(directory)
  const fd = openSync(real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const parent = { fd, directory, real, identity: identity(fstatSync(fd)) }
  try { guardParent(parent); return parent } catch (error) { closeSync(fd); throw error }
}
function guardParent(parent) {
  if (realpathSync(parent.directory) !== parent.real || identity(lstatSync(parent.real)) !== parent.identity ||
    identity(fstatSync(parent.fd)) !== parent.identity) throw conflict('the hooks configuration directory changed')
}
function read(target, parent) {
  guardParent(parent)
  let stat
  try { stat = lstatSync(target.path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (stat && (!stat.isFile() || stat.size > 1024 * 1024)) throw conflict('the hooks file is not a bounded regular file')
  const state = pathState(target.path)
  if (!['file', 'missing'].includes(state.kind)) throw conflict('the hooks file became a link')
  const plan = setupHookGroups(target.app, state.kind === 'file' ? state.text : '')
  return { state, plan }
}
function observed(target, parent, fragment, allowMissing = false, beforeGroups = []) {
  const current = read(target, parent), groups = current.plan.data.hooks?.[target.entry] ?? []
  const matches = groups.flatMap((group, index) => same(group, fragment) ? [index] : [])
  const originalNeighbors = same(groups.map(group => sha(canonicalJson(group))), beforeGroups)
  if (matches.length > 1 || (!matches.length && !allowMissing && !originalNeighbors)) throw conflict('the setup hook group is changed or ambiguous; existing groups are left as they are')
  return { ...current, index: matches[0] ?? -1, fingerprint: { kind: matches.length ? 'entry' : 'absent',
    hash: matches.length ? sha(canonicalJson(fragment)) : null, parent: parent.identity, object: null } }
}
function syncFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try { if (!fstatSync(fd).isFile()) throw conflict('a setup record is no longer a regular file'); fsyncSync(fd) } finally { closeSync(fd) }
}
function save(folder, manifest) {
  writePrivate(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2), { guard: assertDefaultsAdmission })
  syncFile(join(folder, 'manifest.json'))
  const fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function storedFragment(entry, setupId) {
  if (!/^[0-9TZ-]+-\d+$/.test(entry.transaction)) throw conflict('the owned hook transaction has an invalid identity')
  const path = join(transactionFolder(entry.transaction), 'manifest.json')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > 1024 * 1024) throw conflict('the owned hook transaction is unavailable')
  const manifest = JSON.parse(readFileSync(path, 'utf8')), kept = manifest.setup
  if (manifest.id !== entry.transaction || manifest.kind !== 'setup-hook' || kept?.setupId !== setupId ||
    !same(kept.target, entry.target) || !same(kept.after, entry.after) || sha(canonicalJson(kept.fragment)) !== entry.after.hash) throw conflict('the owned hook transaction is inconsistent')
  if (!Array.isArray(kept.beforeGroups) || kept.beforeGroups.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw conflict('the owned hook transaction has no valid surrounding record')
  return { fragment: kept.fragment, beforeGroups: kept.beforeGroups }
}

export function installSetupHook(app, event, { setupId, environment = process.env, now = new Date(), beforePublish, afterPublish } = {}) {
  return withDefaultsAdmission(() => {
    const target = { kind: 'hooks', app, path: setupHookPath(app, environment), entry: event }
    const parent = parentOf(target.path)
    let manifest, folder, published = false
    try {
      if (!approvedIfAny()) return { code: 'NOT_APPROVED', transaction: null, written: [] }
      const journal = readDefaultsOwnership(setupId), owned = journal.snapshot().entries[defaultsTargetKey(target)]
      if (owned?.optOut) return { code: 'OK', state: 'opted-out', transaction: null, written: [] }
      if (owned && owned.stage !== 'installed') throw Object.assign(new Error('an interrupted hook publication needs inspection'), { code: 'DEFAULTS_STATE_UNAVAILABLE' })
      const current = read(target, parent), kept = owned ? storedFragment(owned, setupId) : null
      const fragment = kept?.fragment ?? current.plan.groups[event]
      if (!fragment) throw conflict('this event is not a required setup hook')
      if (!owned && !current.plan.absent.includes(event)) return { code: 'FOREIGN_TARGET', transaction: null, written: [], message: `${event} in ${target.path} already has a hook setup leaves as it is` }
      const before = observed(target, parent, fragment, !owned, kept?.beforeGroups), state = journal.inspect(target, before.fingerprint)
      if (state !== 'new') return { code: 'OK', state, transaction: null, written: [] }
      const allocated = newTransaction(now); folder = allocated.folder
      const after = { kind: 'entry', hash: sha(canonicalJson(fragment)), parent: parent.identity, object: null }
      manifest = { id: allocated.id, created_at: now.toISOString(), kind: 'setup-hook', reason: `setup hooks ${event}`, state: 'started',
        targets: [{ harness: app, path: target.path }], setup: { setupId, target, fragment,
          beforeGroups: (before.plan.data.hooks?.[event] ?? []).map(group => sha(canonicalJson(group))), before: before.fingerprint, after } }
      save(folder, manifest); journal.beginInstall(target, manifest.id, before.fingerprint, after)
      beforePublish?.({ target, transaction: manifest.id })
      const data = before.plan.data
      const next = { ...data, hooks: { ...data.hooks, [event]: [...(data.hooks?.[event] ?? []), fragment] } }
      replaceSetupConfig(target.path, before.state, JSON.stringify(next, null, 2) + '\n', {
        manifest, folder, beforeCommit: () => { assertDefaultsAdmission(); guardParent(parent) },
        afterCommit: () => { published = true; afterPublish?.({ target, transaction: manifest.id }) }
      })
      syncFile(target.path); fsyncSync(parent.fd)
      journal.completeInstall(target, manifest.id, observed(target, parent, fragment).fingerprint)
      manifest.state = 'complete'; save(folder, manifest)
      return { code: 'OK', state: 'installed', transaction: manifest.id, written: [{ harness: app, path: target.path, event }], ...setupConfigRecovery(manifest) }
    } catch (error) {
      if (manifest) { manifest.state = 'failed'; try { save(folder, manifest) } catch { /* Preserve the original failure. */ } }
      const uncertain = ['reported', 'unknown'].includes(error.recovery?.physicalPublication)
      return { code: published || uncertain ? 'INSTALL_FAILED' : error.code ?? 'IO_ERROR', transaction: manifest?.id ?? null,
        written: published ? [{ harness: app, path: target.path, event }] : [],
        ...(error.recovery ? { recovery: error.recovery } : {}),
        message: `${event} in ${target.path}: ${error.message}; ${published ? 'hook group published; ownership needs inspection' : uncertain ? 'configuration publication needs inspection' : 'no hook group published'}` }
    } finally { closeSync(parent.fd) }
  })
}

export async function restoreSetupHookTransaction(manifest, folder, { yes = false, asJson = false, planOnly = false, expectedPlanHash, beforeRemove, afterRemove } = {}) {
  const { setupId, target, fragment, before, after } = manifest.setup ?? {}
  let removed = false
  try {
    if (!setupId || target?.kind !== 'hooks' || !['claude', 'codex'].includes(target.app) || before?.kind !== 'absent' ||
      after?.kind !== 'entry' || sha(canonicalJson(fragment)) !== after.hash) throw conflict('the setup hook transaction is incomplete')
    assertSetupConfigRecovery(manifest, target.path)
    const plan = () => {
      const parent = parentOf(target.path)
      try {
        const journal = readDefaultsOwnership(setupId), owned = journal.snapshot().entries[defaultsTargetKey(target)]
        if (!owned || owned.transaction !== manifest.id || !same(owned.before, before) || !same(owned.after, after) ||
          !['installed', 'removing', 'opted-out'].includes(owned.stage)) throw conflict('this transaction has no completed setup ownership')
        const current = observed(target, parent, fragment, owned.optOut)
        if (!same(current.fingerprint, after) && !(owned.optOut && same(current.fingerprint, before))) throw conflict('the setup hook group changed; it is left as it is')
        return { journal, current, hash: sha(JSON.stringify({ target, text: current.state, revision: journal.snapshot().revision })) }
      } finally { closeSync(parent.fd) }
    }
    const shown = plan()
    const view = { targets: [{ harness: target.app, path: target.path, resolved_path: target.path, becomes: `remove setup's ${target.entry} hook group`, diff: '', note: 'This default stays removed after Undo.' }] }
    if (planOnly) return { code: 'OK', plan_hash: shown.hash, ...view }
    if (expectedPlanHash !== undefined && expectedPlanHash !== shown.hash) throw conflict('the hook removal changed since it was shown')
    if (!await confirm(`Undo setup transaction ${manifest.id}?`, `${target.entry} in ${target.path}: remove only setup's hook group; it stays removed`, { yes, asJson })) return { code: 'NOT_CONFIRMED' }
    return await withDefaultsAdmission(() => {
      const fresh = plan()
      if (fresh.hash !== shown.hash) throw conflict('the hook removal changed while confirmation was open')
      const parent = parentOf(target.path)
      try {
        if (fresh.current.index >= 0) {
          fresh.journal.beginUndo(target, manifest.id, fresh.current.fingerprint)
          beforeRemove?.({ target, transaction: manifest.id })
          const data = fresh.current.plan.data, groups = data.hooks[target.entry].filter((_, index) => index !== fresh.current.index)
          const hooks = { ...data.hooks }; if (groups.length) hooks[target.entry] = groups; else delete hooks[target.entry]
          replaceSetupConfig(target.path, fresh.current.state, JSON.stringify({ ...data, hooks }, null, 2) + '\n', {
            manifest, folder, key: 'configUndo', beforeCommit: () => { assertDefaultsAdmission(); guardParent(parent) },
            afterCommit: () => { removed = true; afterRemove?.({ target, transaction: manifest.id }) }
          })
          syncFile(target.path); fsyncSync(parent.fd)
        }
        if (fresh.journal.snapshot().entries[defaultsTargetKey(target)].stage === 'removing') fresh.journal.completeUndo(target, manifest.id, observed(target, parent, fragment, true).fingerprint)
        manifest.setup.undone = true; save(folder, manifest)
        return { code: 'OK', restored: [target.app], ...setupConfigRecovery(manifest) }
      } finally { closeSync(parent.fd) }
    })
  } catch (error) {
    return { code: error.code ?? 'IO_ERROR', restored: removed ? [target.app] : [],
      ...(error.recovery ? { recovery: error.recovery } : {}),
      message: `${target?.entry ?? 'Hook'} in ${target?.path ?? 'setup transaction'}: ${removed ? 'hook group removed; opt-out saved; completion failed: ' : ''}${error.message}` }
  }
}
