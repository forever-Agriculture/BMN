// MODULE: setup-tool-defaults.mjs - One approved, qualified MCP default per transaction with durable opt-out
import { createHash } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertDefaultsAdmission, withDefaultsAdmission } from './defaults-admission.mjs'
import { defaultsTargetKey, readDefaultsOwnership } from './defaults-ownership.mjs'
import { canonicalJson, HARNESSES, TOOL_PATTERN } from './agents-roster.mjs'
import { confirm, newTransaction, writePrivate } from './agents-rules.mjs'
import { changeSetupToolRecord, planToolsInstall, readAppTools, setupToolRecord, TOOL_APPS, validToolRemovalWitness, writeSetupToolEntry } from './agents-tools.mjs'
import { assertSetupConfigRecovery, assertSetupConfigUndoAfter, replaceSetupConfig, setupConfigRecovery } from './setup-config-write.mjs'

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
  const legacy = target.app === 'opencode' && setupToolRecord(target.app, target.entry)?.at === undefined &&
    target.path.endsWith('/opencode.jsonc') && same(entry?.at, ['mcp'])
  return { file, entry, fingerprint: { kind: entry ? 'entry' : 'absent',
    hash: entry && target.app === 'opencode' && !legacy ? sha(canonicalJson({ text: entry.text_hash, at: entry.at })) : entry?.text_hash ?? null,
    parent: parent.identity, object: null } }
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
  return { hash: observation.entry?.hash ?? null, text: observation.entry?.text_hash ?? null, directory: observation.file.directory,
    ...(observation.entry?.at ? { at: observation.entry.at } : {}) }
}

function setupInverse(manifest) {
  const { inverseVersion, inverse, target, at, after, valueHash, configInstall } = manifest.setup
  if (inverseVersion === undefined && inverse === undefined) return undefined
  const fields = ['version', 'harness', 'path', 'at', 'entry', 'file_kind', 'prior_hash', 'prior_text', 'written_hash', 'written_text', 'edit']
  if (inverseVersion !== 1 || target.app !== 'opencode' || !configInstall?.before || !configInstall?.after || !inverse || Object.keys(inverse).sort().join(',') !== fields.sort().join(',') ||
    inverse.version !== 1 || inverse.harness !== 'opencode' || inverse.path !== join(configInstall.directory, basename(target.path)) ||
    inverse.entry !== target.entry || !same(inverse.at, at) || inverse.prior_hash !== null || inverse.prior_text !== null ||
    inverse.written_hash !== valueHash || typeof inverse.written_text !== 'string' ||
    after.hash !== sha(canonicalJson({ text: inverse.written_text, at })) ||
    inverse.file_kind !== (configInstall.before.kind === 'absent' ? 'missing' : 'file') ||
    inverse.edit?.before !== (configInstall.before.hash ?? sha('')) || inverse.edit?.after !== configInstall.after.hash) {
    throw conflict('the setup OpenCode inverse has no valid install binding')
  }
  return inverse
}

function setupUndoReadback(manifest, current) {
  if (manifest.setup.inverseVersion !== 1) return
  const { undo, configUndo } = manifest.setup
  if (undo === undefined && configUndo === undefined) return
  const inverse = setupInverse(manifest)
  const fields = ['version', 'path', 'at', 'before', 'after', 'file_missing', 'file_witness']
  if (!undo || Object.keys(undo).sort().join(',') !== fields.sort().join(',') || undo.version !== 1 ||
    undo.path !== inverse.path || !same(undo.at, inverse.at) || !configUndo || undo.before !== configUndo.before.hash ||
    undo.after !== (configUndo.after.kind === 'absent' ? sha('') : configUndo.after.hash) ||
    typeof undo.file_missing !== 'boolean' || undo.file_missing !== (configUndo.after.kind === 'absent') ||
    (undo.file_missing ? inverse.file_kind !== 'missing' || undo.before !== inverse.edit.after || undo.after !== inverse.edit.before ||
      !validToolRemovalWitness(undo.file_witness, inverse.path, undo.before) ||
      `${undo.file_witness.file.dev}:${undo.file_witness.file.ino}` !== configUndo.before.object ||
      `${undo.file_witness.parent.dev}:${undo.file_witness.parent.ino}` !== configUndo.before.parent
      : undo.file_witness !== null) || current.entry !== undefined) {
    throw conflict('the setup OpenCode undo has no completed matching read-back')
  }
  assertSetupConfigUndoAfter(manifest, manifest.setup.target.path)
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
      if (!change || change.path !== target.path || change.action !== 'set' || change.prior_hash !== null) return { code: 'DEFAULT_NOT_APPROVED', transaction: null, written: [], message: `No approved, qualified absent ${tool} entry is eligible for ${app}` }
      const allocated = newTransaction(now); folder = allocated.folder
      manifest = { id: allocated.id, created_at: now.toISOString(), kind: 'setup-tool', reason: `setup tools ${tool}`, state: 'started',
        targets: [{ harness: app, path: target.path }], setup: { setupId, target, at: change.at, before: before.fingerprint, after: null, valueHash: change.wanted_hash, priorRecord,
          ...(app === 'opencode' ? { inverseVersion: 1 } : {}) } }
      save(folder, manifest)
      beforePublish?.({ target, transaction: manifest.id })
      let intended = null
      writeSetupToolEntry(app, target.path, tool, expected(before), change.entry, undefined, {
        at: change.at,
        durable: true,
        publish: (path, state, text, options) => replaceSetupConfig(path, state, text, { ...options, manifest, folder }),
        beforeCommit: () => { assertDefaultsAdmission(); guardParent(parent) },
        journal: (hash, inverse) => {
          guardParent(parent)
          const after = { kind: 'entry', hash: app === 'opencode' ? sha(canonicalJson({ text: hash, at: change.at })) : hash, parent: parent.identity, object: null }
          if (intended === null) {
            manifest.setup.after = after
            if (app === 'opencode') {
              if (!inverse || inverse.written_text !== hash || inverse.written_hash !== change.wanted_hash || inverse.prior_hash !== null || inverse.prior_text !== null ||
                inverse.file_kind !== before.file.state.kind || inverse.edit?.before !== sha(before.file.text ?? '')) throw conflict('the setup OpenCode inverse did not match the observed file')
              manifest.setup.inverse = inverse
            }
            save(folder, manifest)
            const kept = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')).setup
            if (!same(kept.after, after) || app === 'opencode' && !same(kept, manifest.setup)) throw conflict('the setup install inverse could not be kept')
            journal.beginInstall(target, manifest.id, before.fingerprint, after); intended = hash
          } else if (intended !== hash) throw conflict('the intended tools entry changed during publication')
        },
        afterPublish: () => { published = true; afterPublish?.({ target, transaction: manifest.id }) }
      })
      syncFile(target.path); fsyncSync(parent.fd)
      const after = observed(target, parent)
      if (after.entry?.hash !== change.wanted_hash) throw conflict('the tools entry read-back did not match the approved entry')
      if (app === 'opencode') setupInverse(manifest)
      changeSetupToolRecord(app, tool, priorRecord, { harness: app, tool, hash: change.wanted_hash,
        ...(app === 'opencode' ? { path: target.path, at: after.entry.at } : {}) })
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

export async function restoreSetupToolTransaction(manifest, folder, { yes = false, asJson = false, planOnly = false, expectedPlanHash, beforeRemove, afterRemove, afterPhysical } = {}) {
  const { setupId, target, at, before, after, valueHash, priorRecord } = manifest.setup ?? {}
  let removed = false
  try {
    if (!setupId || target?.kind !== 'tools' || !HARNESSES.includes(target.app) || !TOOL_PATTERN.test(target.entry) ||
      before?.kind !== 'absent' || after?.kind !== 'entry' || typeof valueHash !== 'string' || !/^[a-f0-9]{64}$/.test(valueHash)) throw conflict('the setup tools transaction is incomplete')
    assertSetupConfigRecovery(manifest, target.path)
    const inverse = target.app === 'opencode' ? setupInverse(manifest) : undefined
    if (priorRecord !== null && (!priorRecord || priorRecord.harness !== target.app || priorRecord.tool !== target.entry ||
      typeof priorRecord.hash !== 'string' || !/^[a-f0-9]{64}$/.test(priorRecord.hash))) throw conflict('the setup tools transaction has no valid prior binding')
    const installedRecord = { harness: target.app, tool: target.entry, hash: valueHash,
      ...(target.app === 'opencode' && at !== undefined ? { path: target.path, at } : {}) }
    const plan = () => {
      const parent = parentOf(target.path)
      try {
        const journal = readDefaultsOwnership(setupId), current = observed(target, parent)
        setupUndoReadback(manifest, current)
        const entry = journal.snapshot().entries[defaultsTargetKey(target)]
        if (!entry || entry.transaction !== manifest.id || !same(entry.before, before) || !same(entry.after, after) ||
          !['installed', 'removing', 'opted-out'].includes(entry.stage)) throw conflict('this transaction has no completed setup ownership')
        if (!same(current.fingerprint, after) && !(entry.optOut && same(current.fingerprint, before))) throw conflict('the setup tools entry changed; it is left as it is')
        const record = setupToolRecord(target.app, target.entry)
        if (!same(record, installedRecord) && !(entry.optOut && !current.entry && same(record, priorRecord))) throw conflict('the tool last-written binding changed')
        return { journal, current, hash: sha(JSON.stringify({ target, current: current.fingerprint, record, revision: journal.snapshot().revision,
          inverse, undo: manifest.setup.undo })) }
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
            at, inverse, priorHash: null, priorText: null, undoing: true,
            durable: true,
            publish: (path, state, text, options) => replaceSetupConfig(path, state, text, { ...options, manifest, folder, key: 'configUndo' }),
            publishMissing: (path, state, options) => replaceSetupConfig(path, state, null, { ...options, manifest, folder, key: 'configUndo' }),
            journal: (_hash, undo) => {
              if (manifest.setup.inverseVersion !== 1) return
              manifest.setup.undo = undo; save(folder, manifest)
              const kept = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')).setup.undo
              if (!same(kept, undo)) throw conflict('the setup undo publication note could not be kept')
            },
            beforeCommit: () => { assertDefaultsAdmission(); guardParent(parent) },
            afterPublish: () => { removed = true; afterRemove?.({ target, transaction: manifest.id }) }
          })
          setupUndoReadback(manifest, observed(target, parent))
          if (manifest.setup.undo?.file_missing !== true) syncFile(target.path)
          fsyncSync(parent.fd)
          afterPhysical?.({ target, transaction: manifest.id })
        }
        setupUndoReadback(manifest, observed(target, parent))
        if (!same(setupToolRecord(target.app, target.entry), priorRecord)) changeSetupToolRecord(target.app, target.entry, installedRecord, priorRecord)
        setupUndoReadback(manifest, observed(target, parent))
        if (fresh.journal.snapshot().entries[defaultsTargetKey(target)].stage === 'removing') fresh.journal.completeUndo(target, manifest.id, observed(target, parent).fingerprint)
        manifest.setup.undone = true; save(folder, manifest)
        return { code: 'OK', restored: [target.app], ...setupConfigRecovery(manifest) }
      } finally { closeSync(parent.fd) }
    })
  } catch (error) {
    if (error.recovery?.version === 2 && error.recovery.physicalPublication === 'reported') removed = true
    return { code: error.code ?? 'IO_ERROR', restored: removed ? [target.app] : [],
      ...(error.recovery ? { recovery: error.recovery } : {}),
      message: `${target?.entry ?? 'Tool'} in ${target?.path ?? 'setup transaction'}: ${removed ? 'entry removed; opt-out saved; completion failed: ' : ''}${error.message}` }
  }
}
