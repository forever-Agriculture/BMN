// MODULE: setup-tool-defaults.mjs - One approved, qualified MCP default per transaction with durable opt-out
import { createHash } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertDefaultsAdmission, withDefaultsAdmission } from './defaults-admission.mjs'
import { defaultsTargetKey, readDefaultsOwnership } from './defaults-ownership.mjs'
import { canonicalJson, HARNESSES, TOOL_PATTERN } from './agents-roster.mjs'
import { confirm, newTransaction, writePrivate } from './agents-rules.mjs'
import { changeSetupToolRecord, planToolsInstall, readAppTools, setupToolRecord, TOOL_APPS, writeSetupToolEntry } from './agents-tools.mjs'
import { assertSetupConfigRecovery, replaceSetupConfig, setupConfigRecovery } from './setup-config-write.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const identity = stat => `${stat.dev}:${stat.ino}`
const conflict = message => Object.assign(new Error(message), { code: 'REVISION_CONFLICT' })
const same = (a, b) => canonicalJson(a) === canonicalJson(b)

function parentOf(path) {
  const pathParent = dirname(path), real = realpathSync(pathParent)
  const fd = openSync(real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const parent = { fd, pathParent, real, identity: identity(fstatSync(fd)) }
  try { guardParent(parent); return parent } catch (error) { closeSync(fd); throw error }
}
function guardParent(parent) {
  if (realpathSync(parent.pathParent) !== parent.real || identity(lstatSync(parent.real)) !== parent.identity ||
    identity(fstatSync(parent.fd)) !== parent.identity) throw conflict('the tools configuration directory changed')
}
function observed(target, parent) {
  guardParent(parent)
  const file = readAppTools(target.app, undefined, { path: target.path })
  const entry = file.entries.get(target.entry)
  if (!file.readable || file.link !== undefined || entry?.unreadable !== undefined) throw conflict('the tools entry cannot be read safely; it is left as it is')
  return { file, entry, fingerprint: { kind: entry ? 'entry' : 'absent', hash: entry?.text_hash ?? null, parent: parent.identity, object: null } }
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
function expected(observation) {
  return { hash: observation.entry?.hash ?? null, text: observation.entry?.text_hash ?? null, directory: observation.file.directory }
}

/** Replans from the approved team under admission; callers supply neither a tool body nor a test result. */
export function installSetupTool(app, tool, { setupId, environment = process.env, versions, now = new Date(), beforePublish, afterPublish } = {}) {
  return withDefaultsAdmission(async () => {
    if (!HARNESSES.includes(app) || typeof tool !== 'string' || !TOOL_PATTERN.test(tool)) throw conflict('invalid setup tool')
    const target = { kind: 'tools', app, path: TOOL_APPS[app].file(environment), entry: tool }
    const parent = parentOf(target.path)
    let manifest, folder, published = false
    try {
      const journal = readDefaultsOwnership(setupId), before = observed(target, parent)
      const state = journal.inspect(target, before.fingerprint)
      const priorRecord = setupToolRecord(app, tool)
      if (state === 'installed' && priorRecord?.hash !== before.entry?.hash) throw conflict('the tool last-written binding changed')
      if (state !== 'new') return { code: 'OK', state, transaction: null, written: [] }
      if (before.entry) return { code: 'FOREIGN_TARGET', transaction: null, written: [], message: `${tool} in ${target.path} was not written by setup; it is left as it is` }
      const plan = await planToolsInstall([app], { environment, versions, absent: true })
      if (plan.code !== 'OK') return { code: plan.code, transaction: null, written: [], message: plan.message }
      const change = plan.targets.find(row => row.tool === tool)
      if (!change || change.action !== 'set' || change.prior_hash !== null) return { code: 'DEFAULT_NOT_APPROVED', transaction: null, written: [], message: `No approved, qualified absent ${tool} entry is eligible for ${app}` }
      const allocated = newTransaction(now); folder = allocated.folder
      manifest = { id: allocated.id, created_at: now.toISOString(), kind: 'setup-tool', reason: `setup tools ${tool}`, state: 'started',
        targets: [{ harness: app, path: target.path }], setup: { setupId, target, before: before.fingerprint, after: null, valueHash: change.wanted_hash, priorRecord } }
      save(folder, manifest)
      beforePublish?.({ target, transaction: manifest.id })
      let intended = null
      writeSetupToolEntry(app, target.path, tool, expected(before), change.entry, undefined, {
        durable: true,
        publish: (path, state, text, options) => replaceSetupConfig(path, state, text, { ...options, manifest, folder }),
        beforeCommit: () => { assertDefaultsAdmission(); guardParent(parent) },
        journal: hash => {
          guardParent(parent)
          const after = { kind: 'entry', hash, parent: parent.identity, object: null }
          if (intended === null) {
            manifest.setup.after = after; save(folder, manifest)
            journal.beginInstall(target, manifest.id, before.fingerprint, after); intended = hash
          } else if (intended !== hash) throw conflict('the intended tools entry changed during publication')
        },
        afterPublish: () => { published = true; afterPublish?.({ target, transaction: manifest.id }) }
      })
      syncFile(target.path); fsyncSync(parent.fd)
      const after = observed(target, parent)
      if (after.entry?.hash !== change.wanted_hash) throw conflict('the tools entry read-back did not match the approved entry')
      changeSetupToolRecord(app, tool, priorRecord, { harness: app, tool, hash: change.wanted_hash })
      journal.completeInstall(target, manifest.id, after.fingerprint)
      manifest.state = 'complete'; save(folder, manifest)
      return { code: 'OK', state: 'installed', transaction: manifest.id, written: [{ harness: app, path: target.path, tool }], ...setupConfigRecovery(manifest) }
    } catch (error) {
      if (manifest) { manifest.state = 'failed'; try { save(folder, manifest) } catch { /* Preserve the original failure. */ } }
      const uncertain = ['reported', 'unknown'].includes(error.recovery?.physicalPublication)
      return { code: published || uncertain ? 'INSTALL_FAILED' : error.code ?? 'IO_ERROR', transaction: manifest?.id ?? null,
        written: published ? [{ harness: app, path: target.path, tool }] : [],
        ...(error.recovery ? { recovery: error.recovery } : {}),
        message: `${tool} in ${target.path}: ${error.message}; ${published ? 'entry published; ownership needs inspection' : uncertain ? 'configuration publication needs inspection' : 'no entry published'}` }
    } finally { closeSync(parent.fd) }
  })
}

export async function restoreSetupToolTransaction(manifest, folder, { yes = false, asJson = false, planOnly = false, expectedPlanHash, beforeRemove, afterRemove } = {}) {
  const { setupId, target, before, after, valueHash, priorRecord } = manifest.setup ?? {}
  let removed = false
  try {
    if (!setupId || target?.kind !== 'tools' || !HARNESSES.includes(target.app) || !TOOL_PATTERN.test(target.entry) ||
      before?.kind !== 'absent' || after?.kind !== 'entry' || typeof valueHash !== 'string' || !/^[a-f0-9]{64}$/.test(valueHash)) throw conflict('the setup tools transaction is incomplete')
    assertSetupConfigRecovery(manifest, target.path)
    if (priorRecord !== null && (!priorRecord || priorRecord.harness !== target.app || priorRecord.tool !== target.entry ||
      typeof priorRecord.hash !== 'string' || !/^[a-f0-9]{64}$/.test(priorRecord.hash))) throw conflict('the setup tools transaction has no valid prior binding')
    const installedRecord = { harness: target.app, tool: target.entry, hash: valueHash }
    const plan = () => {
      const parent = parentOf(target.path)
      try {
        const journal = readDefaultsOwnership(setupId), current = observed(target, parent)
        const entry = journal.snapshot().entries[defaultsTargetKey(target)]
        if (!entry || entry.transaction !== manifest.id || !same(entry.before, before) || !same(entry.after, after) ||
          !['installed', 'removing', 'opted-out'].includes(entry.stage)) throw conflict('this transaction has no completed setup ownership')
        if (!same(current.fingerprint, after) && !(entry.optOut && same(current.fingerprint, before))) throw conflict('the setup tools entry changed; it is left as it is')
        const record = setupToolRecord(target.app, target.entry)
        if (!same(record, installedRecord) && !(entry.optOut && !current.entry && same(record, priorRecord))) throw conflict('the tool last-written binding changed')
        return { journal, current, hash: sha(JSON.stringify({ target, current: current.fingerprint, record, revision: journal.snapshot().revision })) }
      } finally { closeSync(parent.fd) }
    }
    const shown = plan()
    const view = { targets: [{ harness: target.app, path: target.path, resolved_path: target.path, tool: target.entry, becomes: 'removed (setup created it)', diff: '', note: 'This default stays removed after Undo.' }] }
    if (planOnly) return { code: 'OK', plan_hash: shown.hash, ...view }
    if (expectedPlanHash !== undefined && expectedPlanHash !== shown.hash) throw conflict('the setup tools removal changed since it was shown')
    if (!await confirm(`Undo setup transaction ${manifest.id}?`, `${target.entry} in ${target.path}: remove only this default; it stays removed`, { yes, asJson })) return { code: 'NOT_CONFIRMED' }
    return await withDefaultsAdmission(() => {
      const fresh = plan()
      if (fresh.hash !== shown.hash) throw conflict('the setup tools removal changed while confirmation was open')
      const parent = parentOf(target.path)
      try {
        if (fresh.current.entry) {
          fresh.journal.beginUndo(target, manifest.id, fresh.current.fingerprint)
          beforeRemove?.({ target, transaction: manifest.id })
          writeSetupToolEntry(target.app, target.path, target.entry, expected(fresh.current), undefined, undefined, {
            durable: true,
            publish: (path, state, text, options) => replaceSetupConfig(path, state, text, { ...options, manifest, folder, key: 'configUndo' }),
            beforeCommit: () => { assertDefaultsAdmission(); guardParent(parent) },
            afterPublish: () => { removed = true; afterRemove?.({ target, transaction: manifest.id }) }
          })
          syncFile(target.path); fsyncSync(parent.fd)
        }
        if (!same(setupToolRecord(target.app, target.entry), priorRecord)) changeSetupToolRecord(target.app, target.entry, installedRecord, priorRecord)
        if (fresh.journal.snapshot().entries[defaultsTargetKey(target)].stage === 'removing') fresh.journal.completeUndo(target, manifest.id, observed(target, parent).fingerprint)
        manifest.setup.undone = true; save(folder, manifest)
        return { code: 'OK', restored: [target.app], ...setupConfigRecovery(manifest) }
      } finally { closeSync(parent.fd) }
    })
  } catch (error) {
    return { code: error.code ?? 'IO_ERROR', restored: removed ? [target.app] : [],
      ...(error.recovery ? { recovery: error.recovery } : {}),
      message: `${target?.entry ?? 'Tool'} in ${target?.path ?? 'setup transaction'}: ${removed ? 'entry removed; opt-out saved; completion failed: ' : ''}${error.message}` }
  }
}
