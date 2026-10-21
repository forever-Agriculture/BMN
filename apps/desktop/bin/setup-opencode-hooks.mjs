// MODULE: setup-opencode-hooks.mjs - Paired setup plugin/registration publication and reverse-order Undo
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { assertDefaultsAdmission, withDefaultsAdmission } from './defaults-admission.mjs'
import { defaultsTargetKey, readDefaultsOwnership } from './defaults-ownership.mjs'
import { canonicalJson } from './agents-roster.mjs'
import { approvedIfAny } from './agents-state.mjs'
import { confirm, newTransaction, writePrivate } from './agents-rules.mjs'
import { OPENCODE_PLUGIN } from './bmn-opencode-plugin.mjs'
import { assertSetupFileParent, assertSetupHoldingRecovery, holdSetupFile, observeSetupFile, setupFileParent, setupPinnedPath } from './setup-file-defaults.mjs'
import { pathState, rewrittenNumbers } from './safe-config-write.mjs'
import { assertSetupConfigRecovery, replaceSetupConfig, setupConfigRecovery } from './setup-config-write.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const identity = stat => `${stat.dev}:${stat.ino}`
const same = (a, b) => canonicalJson(a) === canonicalJson(b)
const conflict = message => Object.assign(new Error(message), { code: 'REVISION_CONFLICT' })
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
function targets(environment) {
  const config = environment.OPENCODE_CONFIG_DIR || join(environment.XDG_CONFIG_HOME || join(environment.HOME, '.config'), 'opencode')
  const reference = join(config, 'bmn')
  return { reference, plugin: { kind: 'hooks', app: 'opencode', path: join(reference, 'tui.ts'), entry: 'plugin' },
    registration: { kind: 'hooks', app: 'opencode', path: join(config, 'cli.json'), entry: 'registration' } }
}
function registration(target, parent, reference) {
  assertSetupFileParent(parent)
  let stat
  try { stat = lstatSync(target.path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (stat && (!stat.isFile() || stat.size > 1024 * 1024)) throw conflict('OpenCode cli.json is not a bounded regular file')
  const state = pathState(target.path)
  if (!['file', 'missing'].includes(state.kind)) throw conflict('OpenCode cli.json became a link')
  const text = state.kind === 'file' ? state.text : ''
  let data
  try { data = text.trim() ? JSON.parse(text) : {} } catch { throw conflict('OpenCode cli.json is not valid JSON') }
  if (!data || typeof data !== 'object' || Array.isArray(data) || rewrittenNumbers(text).length ||
    (data.plugins !== undefined && (!Array.isArray(data.plugins) || data.plugins.some(value => typeof value !== 'string')))) throw conflict('OpenCode cli.json has a shape setup leaves as it is')
  const plugins = data.plugins ?? [], count = plugins.filter(value => value === reference).length
  if (count > 1) throw conflict('the OpenCode plugin registration is duplicated; it is left as it is')
  return { state, data, plugins, present: count === 1, fingerprint: { kind: count ? 'entry' : 'absent',
    hash: count ? sha(canonicalJson(reference)) : null, parent: parent.identity, object: null } }
}
function entries(journal, pair) {
  return { plugin: journal.snapshot().entries[defaultsTargetKey(pair.plugin)], registration: journal.snapshot().entries[defaultsTargetKey(pair.registration)] }
}
function parents(pair) {
  const pluginParent = setupFileParent(pair.plugin.path)
  try { return { pluginParent, configParent: setupFileParent(pair.registration.path) } }
  catch (error) { closeSync(pluginParent.fd); throw error }
}

export function installSetupOpenCodeHooks({ setupId, environment = process.env, now = new Date(), afterPlugin, beforeRegistration, afterRegistration } = {}) {
  return withDefaultsAdmission(() => {
    if (!approvedIfAny()) return { code: 'NOT_APPROVED', transaction: null, written: [] }
    const pair = targets(environment), journal = readDefaultsOwnership(setupId), owned = entries(journal, pair)
    if (owned.plugin?.optOut || owned.registration?.optOut) return { code: 'OK', state: 'opted-out', transaction: null, written: [] }
    if (owned.plugin || owned.registration) {
      if (!owned.plugin || !owned.registration || owned.plugin.stage !== 'installed' || owned.registration.stage !== 'installed' || owned.plugin.transaction !== owned.registration.transaction) {
        return { code: 'DEFAULTS_STATE_UNAVAILABLE', transaction: null, written: [], message: 'An interrupted OpenCode hook pair needs inspection; it is not adopted or retried automatically.' }
      }
    }
    // The app's own config folder must exist; only the absent plugin subfolder is created here.
    try { mkdirSync(pair.reference, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    if (!lstatSync(pair.reference).isDirectory() || lstatSync(pair.reference).isSymbolicLink()) throw conflict('the OpenCode plugin directory is not a regular directory')
    const { pluginParent, configParent } = parents(pair)
    let staged, manifest, folder
    const written = []
    try {
      const pluginBefore = observeSetupFile(pair.plugin.path, pluginParent), regBefore = registration(pair.registration, configParent, pair.reference)
      if (owned.plugin) {
        const pluginState = journal.inspect(pair.plugin, pluginBefore), regState = journal.inspect(pair.registration, regBefore.fingerprint)
        return { code: 'OK', state: [pluginState, regState].includes('opted-out') ? 'opted-out' : 'installed', transaction: null, written: [] }
      }
      if (pluginBefore.kind !== 'absent' || regBefore.present) return { code: 'FOREIGN_TARGET', transaction: null, written: [], message: 'An existing OpenCode plugin or registration is left as it is.' }
      const allocated = newTransaction(now); folder = allocated.folder
      const stageName = `.bmn-setup-${process.pid}-${randomBytes(8).toString('hex')}.tmp`
      staged = setupPinnedPath(pluginParent, stageName)
      const regAfter = { kind: 'entry', hash: sha(canonicalJson(pair.reference)), parent: configParent.identity, object: null }
      manifest = { id: allocated.id, created_at: now.toISOString(), kind: 'setup-opencode-hooks', reason: 'setup OpenCode hooks', state: 'started',
        targets: [{ harness: 'opencode', path: pair.plugin.path }, { harness: 'opencode', path: pair.registration.path }],
        setup: { setupId, pair, pluginBefore, regBefore: regBefore.fingerprint, regAfter,
          staging: { version: 1, kind: 'file', sourcePath: pair.plugin.path, path: join(pluginParent.real, stageName) } } }
      save(folder, manifest)
      const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      let pluginAfter
      try {
        writeFileSync(fd, OPENCODE_PLUGIN); fsyncSync(fd)
        pluginAfter = { kind: 'file', hash: sha(OPENCODE_PLUGIN), parent: pluginParent.identity, object: identity(fstatSync(fd)) }
      } finally { closeSync(fd) }
      manifest.setup.pluginAfter = pluginAfter
      save(folder, manifest)
      journal.beginInstall(pair.plugin, manifest.id, pluginBefore, pluginAfter)
      assertDefaultsAdmission(); assertSetupFileParent(pluginParent)
      linkSync(staged, setupPinnedPath(pluginParent, basename(pair.plugin.path)))
      written.push({ harness: 'opencode', path: pair.plugin.path, entry: 'plugin' })
      unlinkSync(staged); staged = undefined; fsyncSync(pluginParent.fd)
      journal.completeInstall(pair.plugin, manifest.id, observeSetupFile(pair.plugin.path, pluginParent))
      afterPlugin?.({ transaction: manifest.id, pair })
      beforeRegistration?.({ transaction: manifest.id, pair })
      const regCurrent = registration(pair.registration, configParent, pair.reference)
      if (!same(regCurrent.fingerprint, regBefore.fingerprint)) throw conflict('the OpenCode registration changed before publication')
      journal.beginInstall(pair.registration, manifest.id, regBefore.fingerprint, regAfter)
      replaceSetupConfig(pair.registration.path, regCurrent.state, JSON.stringify({ ...regCurrent.data, plugins: [...regCurrent.plugins, pair.reference] }, null, 2) + '\n', {
        manifest, folder, beforeCommit: () => { assertDefaultsAdmission(); assertSetupFileParent(configParent) },
        afterCommit: () => {
          written.push({ harness: 'opencode', path: pair.registration.path, entry: 'registration' })
          afterRegistration?.({ transaction: manifest.id, pair })
        }
      })
      syncFile(pair.registration.path); fsyncSync(configParent.fd)
      journal.completeInstall(pair.registration, manifest.id, registration(pair.registration, configParent, pair.reference).fingerprint)
      manifest.state = 'complete'; save(folder, manifest)
      return { code: 'OK', state: 'installed', transaction: manifest.id, written, ...setupConfigRecovery(manifest) }
    } catch (error) {
      if (manifest) { manifest.state = 'failed'; try { save(folder, manifest) } catch { /* Preserve the original failure. */ } }
      return { code: written.length ? 'INSTALL_FAILED' : error.code ?? 'IO_ERROR', transaction: manifest?.id ?? null, written,
        ...(error.recovery ? { recovery: error.recovery } : {}),
        message: `OpenCode hooks: ${error.message}; published ${written.map(row => row.entry).join(', ') || 'nothing'}; ${written.some(row => row.entry === 'registration') || ['reported', 'unknown'].includes(error.recovery?.physicalPublication) ? 'registration needs inspection' : 'registration not published'}` }
    } finally {
      if (staged) { try { unlinkSync(staged) } catch { /* An unpublished stage grants no ownership. */ } }
      closeSync(pluginParent.fd); closeSync(configParent.fd)
    }
  })
}

export async function restoreSetupOpenCodeHooks(manifest, folder, { yes = false, asJson = false, planOnly = false, expectedPlanHash, afterRegistrationRemoval, beforePluginRemoval } = {}) {
  const { setupId, pair, pluginBefore, pluginAfter, regBefore, regAfter } = manifest.setup ?? {}
  const removed = []
  try {
    if (!setupId || pair?.plugin?.entry !== 'plugin' || pair?.registration?.entry !== 'registration' || pair.plugin.app !== 'opencode' ||
      pair.registration.app !== 'opencode' || pair.plugin.kind !== 'hooks' || pair.registration.kind !== 'hooks' ||
      pair.reference !== join(pair.plugin.path, '..') || pluginBefore?.kind !== 'absent' || pluginAfter?.kind !== 'file' ||
      regBefore?.kind !== 'absent' || regAfter?.kind !== 'entry' || regAfter.hash !== sha(canonicalJson(pair.reference))) throw conflict('the setup OpenCode hook transaction is incomplete')
    assertSetupConfigRecovery(manifest, pair.registration.path)
    assertSetupHoldingRecovery(manifest, 'pluginRemoval', pair.plugin.path, pluginAfter)
    const plan = () => {
      const { pluginParent, configParent } = parents(pair)
      try {
        const journal = readDefaultsOwnership(setupId), owned = entries(journal, pair)
        for (const [entry, before, after] of [[owned.plugin, pluginBefore, pluginAfter], [owned.registration, regBefore, regAfter]]) {
          if (!entry && before === regBefore) continue // Registration may never have been published in a partial install.
          if (!entry || entry.transaction !== manifest.id || !same(entry.before, before) || !same(entry.after, after) ||
            !['installed', 'removing', 'opted-out'].includes(entry.stage)) throw conflict('this transaction has no completed setup ownership for the hook pair')
        }
        const pluginCurrent = observeSetupFile(pair.plugin.path, pluginParent), regCurrent = registration(pair.registration, configParent, pair.reference)
        if (!same(pluginCurrent, pluginAfter) && !(owned.plugin.optOut && same(pluginCurrent, pluginBefore))) throw conflict('the setup plugin changed; registration and plugin are left as they are')
        if (owned.registration ? !same(regCurrent.fingerprint, regAfter) && !(owned.registration.optOut && same(regCurrent.fingerprint, regBefore)) : regCurrent.present) {
          throw conflict('the plugin registration is changed or unowned; the plugin is retained')
        }
        return { journal, owned, pluginCurrent, regCurrent, hash: sha(JSON.stringify({ pair, pluginCurrent, registration: regCurrent.state, revision: journal.snapshot().revision })) }
      } finally { closeSync(pluginParent.fd); closeSync(configParent.fd) }
    }
    const shown = plan()
    const view = { targets: [
      ...(shown.owned.registration ? [{ harness: 'opencode', path: pair.registration.path, resolved_path: pair.registration.path, becomes: 'remove setup plugin registration', diff: '' }] : []),
      { harness: 'opencode', path: pair.plugin.path, resolved_path: pair.plugin.path, becomes: 'remove setup plugin after its registration', diff: '' }
    ] }
    if (planOnly) return { code: 'OK', plan_hash: shown.hash, ...view }
    if (expectedPlanHash !== undefined && expectedPlanHash !== shown.hash) throw conflict('the OpenCode hook removal changed since it was shown')
    if (!await confirm(`Undo setup transaction ${manifest.id}?`, 'Remove the setup registration first, then its unchanged plugin; these defaults stay removed.', { yes, asJson })) return { code: 'NOT_CONFIRMED' }
    return await withDefaultsAdmission(() => {
      const fresh = plan()
      if (fresh.hash !== shown.hash) throw conflict('the OpenCode hook removal changed while confirmation was open')
      const { pluginParent, configParent } = parents(pair)
      try {
        if (fresh.regCurrent.present) {
          fresh.journal.beginUndo(pair.registration, manifest.id, fresh.regCurrent.fingerprint)
          replaceSetupConfig(pair.registration.path, fresh.regCurrent.state, JSON.stringify({ ...fresh.regCurrent.data, plugins: fresh.regCurrent.plugins.filter(value => value !== pair.reference) }, null, 2) + '\n', {
            manifest, folder, key: 'configUndo', beforeCommit: () => { assertDefaultsAdmission(); assertSetupFileParent(configParent) },
            afterCommit: () => { removed.push('registration'); afterRegistrationRemoval?.({ pair, transaction: manifest.id }) }
          })
          syncFile(pair.registration.path); fsyncSync(configParent.fd)
        }
        if (fresh.journal.snapshot().entries[defaultsTargetKey(pair.registration)]?.stage === 'removing') fresh.journal.completeUndo(pair.registration, manifest.id, registration(pair.registration, configParent, pair.reference).fingerprint)
        if (registration(pair.registration, configParent, pair.reference).present) throw conflict('the plugin is still registered and is retained')
        if (fresh.pluginCurrent.kind !== 'absent') {
          fresh.journal.beginUndo(pair.plugin, manifest.id, fresh.pluginCurrent)
          beforePluginRemoval?.({ pair, transaction: manifest.id })
          assertDefaultsAdmission()
          if (registration(pair.registration, configParent, pair.reference).present) throw conflict('the plugin was registered again and is retained')
          if (!same(observeSetupFile(pair.plugin.path, pluginParent), fresh.pluginCurrent)) throw conflict('the plugin changed before removal and is retained')
          holdSetupFile(pair.plugin.path, fresh.pluginCurrent, pluginParent, { manifest, folder, key: 'pluginRemoval' })
          removed.push('plugin')
        }
        if (fresh.journal.snapshot().entries[defaultsTargetKey(pair.plugin)].stage === 'removing') fresh.journal.completeUndo(pair.plugin, manifest.id, observeSetupFile(pair.plugin.path, pluginParent))
        if (manifest.setup.pluginRemoval) manifest.setup.pluginRemoval.phase = 'complete'
        manifest.setup.undone = true; save(folder, manifest)
        return { code: 'OK', restored: ['opencode'], ...setupConfigRecovery(manifest), ...(manifest.setup.pluginRemoval ? {
          recovery: manifest.setup.pluginRemoval,
          recoveryPaths: [...(setupConfigRecovery(manifest).recoveryPaths ?? []), manifest.setup.pluginRemoval.holdingPath],
          message: `Previous OpenCode files preserved at ${[...(setupConfigRecovery(manifest).recoveryPaths ?? []), manifest.setup.pluginRemoval.holdingPath].join(', ')}`
        } : {}) }
      } finally { closeSync(pluginParent.fd); closeSync(configParent.fd) }
    })
  } catch (error) {
    return { code: error.code ?? 'IO_ERROR', restored: removed.length ? ['opencode'] : [],
      ...(error.recovery || manifest.setup?.pluginRemoval ? { recovery: error.recovery ?? manifest.setup.pluginRemoval } : {}),
      message: `OpenCode hooks: ${error.message}; removed ${removed.join(', ') || 'nothing'}${removed.length ? '; opt-out saved' : ''}` }
  }
}
