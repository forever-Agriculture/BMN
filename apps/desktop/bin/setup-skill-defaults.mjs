// MODULE: setup-skill-defaults.mjs - Setup-owned skill transactions, checked refresh and original Undo
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { agentsDirectory } from './agents-roster.mjs'
import { confirm, newTransaction } from './agents-rules.mjs'
import { assertDefaultsAdmission, withDefaultsAdmission } from './defaults-admission.mjs'
import { defaultsTargetKey, readDefaultsOwnership } from './defaults-ownership.mjs'
import { publishSetupEntry } from './defaults-publish.mjs'
import { assertSetupFileParent, saveSetupManifest, setupFileParent } from './setup-file-defaults.mjs'
import { holdSetupSkill, observeSetupSkill, plannedSetupSkillHash, stageSetupSkill } from './setup-skill-fs.mjs'
import { readSetupSkillRecords, validateSetupSkillRecords, writeSetupSkillRecords } from './setup-skill-records.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
const same = (a, b) => a?.kind === b?.kind && a?.hash === b?.hash && a?.parent === b?.parent && a?.object === b?.object
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const failure = (message, code = 'REVISION_CONFLICT') => Object.assign(new Error(message), { code })
const app = target => ['claude', 'codex', 'opencode'].includes(target.app)
const inside = (path, root) => path === root || path.startsWith(`${root}/`)
const originalFolder = transaction => join(agentsDirectory(), 'state/rules/transactions', transaction)
const records = (journal, initialize = false) => Object.fromEntries(['own-skills', 'skills-written'].map(kind => [kind, readSetupSkillRecords(journal, kind, { initialize })]))

function targetValid(target, desired) {
  defaultsTargetKey(target)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(target.entry) || basename(target.path) !== target.entry ||
    !(target.kind === 'own-skills' && target.app === 'source' && desired.kind === 'tree' ||
      target.kind === 'skills' && (app(target) || target.app === 'source' && desired.kind === 'link'))) throw failure('unsupported setup skill target')
}

function metadataFor(target, desired, fingerprint) {
  if (target.kind === 'own-skills') return null
  if (target.app === 'source') return { kind: 'own-skills', key: target.entry,
    record: { path: target.path, copy: desired.text, at: new Date().toISOString() } }
  const record = desired.kind === 'link' ? { harness: target.app, skill: target.entry, kind: 'link', target: desired.text } :
    { harness: target.app, skill: target.entry, kind: 'copy', hash: fingerprint.hash, source_hash: desired.header?.sourceHash }
  return { kind: 'skills-written', key: target.path, record }
}
const recordAt = (all, metadata) => metadata === null ? null : metadata.kind === 'own-skills' ? all[metadata.kind].value.skills[metadata.key] ?? null : all[metadata.kind].value[metadata.key] ?? null
function nextRecords(all, metadata, record, undo = false) {
  const next = structuredClone(all[metadata.kind].value)
  if (metadata.kind === 'own-skills') {
    if (record === null) { delete next.skills[metadata.key]; if (undo) next.removed[metadata.key] = new Date().toISOString() }
    else { next.skills[metadata.key] = record; delete next.removed[metadata.key] }
  } else if (record === null) delete next[metadata.key]
  else next[metadata.key] = record
  return next
}

/** Record lexical source ancestry before publication, including an app link that may later dangle. */
function dependencies(journal, target, staged, desired) {
  const entries = Object.values(journal.snapshot().entries), links = desired.kind === 'link' ? [{ path: '', text: desired.text, fingerprint: staged.fingerprint }] : staged.links
  const result = []
  for (const link of links) {
    const destinationPath = link.path ? join(target.path, link.path) : target.path
    const points = resolve(dirname(destinationPath), link.text)
    if (link.path && inside(points, target.path)) continue
    const backing = entries.find(row => row.target.kind === 'own-skills' && inside(points, row.target.path))
    const source = entries.find(row => row.target.kind === 'skills' && row.target.app === 'source' && inside(points, row.target.path))
    const references = backing ? [{ backingInstallId: backing.transaction, backingPath: backing.target.path }] : source?.dependencies ?? []
    if (!references.length) throw failure('a setup skill link has an unresolved backing; its stage is retained')
    for (const reference of references) result.push({ backingInstallId: reference.backingInstallId, backingPath: reference.backingPath,
      viaSourceInstallId: source?.transaction ?? null, destinationPath, linkText: link.text, destinationFingerprint: link.fingerprint, status: 'pending' })
  }
  return result
}

function loadManifest(folder) {
  const fd = openSync(join(folder, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw failure('the setup skill manifest is unsafe'); return JSON.parse(readFileSync(fd, 'utf8')) }
  finally { closeSync(fd) }
}

function checkMetadataBinding(target, setup) {
  const metadata = setup.metadata
  if (target.kind === 'own-skills') {
    if (metadata !== null || setup.current.record !== null) throw failure('the backing manifest has unexpected compatibility metadata')
    return
  }
  const kind = target.app === 'source' ? 'own-skills' : 'skills-written', key = target.app === 'source' ? target.entry : target.path
  if (!metadata || Object.keys(metadata).length !== 4 || !['kind', 'key', 'record', 'prior'].every(key => Object.hasOwn(metadata, key)) ||
    metadata.kind !== kind || metadata.key !== key || metadata.prior !== null) throw failure('the setup skill metadata identity is corrupt')
  const bound = (record, fingerprint) => {
    validateSetupSkillRecords(kind, kind === 'own-skills' ? { version: 1, skills: { [key]: record }, removed: {} } : { [key]: record })
    return kind === 'own-skills' ? record.path === target.path && fingerprint.kind === 'link' && sha(record.copy) === fingerprint.hash :
      record.harness === target.app && record.skill === target.entry && (fingerprint.kind === 'link' ? record.kind === 'link' && sha(record.target) === fingerprint.hash :
        fingerprint.kind === 'tree' && record.kind === 'copy' && record.hash === fingerprint.hash)
  }
  if (!bound(metadata.record, setup.after) || !bound(setup.current.record, setup.current.fingerprint)) throw failure('the setup skill record does not bind to its original and current revision')
}

function checked(manifest, folder, journal, current) {
  const setup = manifest.setup, target = setup?.target, entry = target && journal.snapshot().entries[defaultsTargetKey(target)]
  if (!setup || manifest.kind !== 'setup-skill' || !entry || entry.transaction !== manifest.id || folder !== originalFolder(manifest.id) ||
    !equal(entry.target, target) || !same(entry.before, setup.before) || !same(entry.after, setup.after) ||
    !['installed', 'removing', 'retained', 'opted-out'].includes(entry.stage) || setup.current?.revision !== entry.current.revision ||
    !same(setup.current?.fingerprint, entry.current.fingerprint) || !equal(setup.compatibility, entry.compatibility) ||
    !(same(current, entry.current.fingerprint) || entry.stage === 'opted-out' && same(current, entry.before))) throw failure('the original setup skill transaction has no checked current binding')
  checkMetadataBinding(target, setup)
  const all = records(journal)
  if (setup.metadata !== null && (!setup.metadata || !entry.compatibility.includes(setup.metadata.kind) ||
    !equal(recordAt(all, setup.metadata), entry.stage === 'opted-out' ? setup.metadata.prior : setup.current.record))) throw failure('the setup skill compatibility binding changed')
  return { entry, all }
}

/** Unknown legacy destinations retain backing; matching legacy bytes never grant setup ownership. */
function legacyReferences(journal, all, target) {
  const entries = Object.values(journal.snapshot().entries), held = []
  // An unchanged app link can resolve through a source that was retargeted outside BMN.
  // Check every recorded source/backing, including absent tombstones, before trusting that ancestry.
  for (const entry of entries.filter(entry => entry.target.app === 'source' && entry.target.path !== target.path)) {
    const parent = setupFileParent(entry.target.path)
    try {
      const expected = entry.stage === 'opted-out' ? entry.before : entry.current.fingerprint
      if (!['installed', 'retained', 'opted-out'].includes(entry.stage) || !same(observeSetupSkill(entry.target.path, parent), expected)) held.push(entry.target.path)
    } finally { closeSync(parent.fd) }
  }
  for (const row of Object.values(all['own-skills'].value.skills)) {
    if (inside(resolve(row.copy), target.path) && !entries.some(entry => entry.target.path === row.path && entry.dependencies.length > 0)) held.push(row.path)
  }
  for (const [path, row] of Object.entries(all['skills-written'].value)) {
    const owned = entries.find(entry => entry.target.path === path)
    const parent = setupFileParent(path)
    try {
      const current = observeSetupSkill(path, parent)
      if (owned && same(current, owned.current.fingerprint) && owned.stage === 'installed') continue
      if (row.kind !== 'link' || current.kind !== 'link' || current.hash !== sha(row.target)) { held.push(path); continue }
      const points = resolve(dirname(path), row.target), source = entries.find(entry => inside(points, entry.target.path))
      if (inside(points, target.path) || source?.dependencies.some(dep => dep.backingPath === target.path) || !source) held.push(path)
    } finally { closeSync(parent.fd) }
  }
  return held
}

function resultError(error, { manifest, folder, staged, published = false } = {}) {
  if (manifest && folder) { try { manifest.state = 'failed'; saveSetupManifest(folder, manifest) } catch { /* Intent already blocks adoption. */ } }
  const recovery = error.recovery?.holdingPath ? error.recovery : manifest?.setup?.removal
  const stagedPath = staged?.path ?? error.recovery?.stagedPath
  return { code: error.code ?? 'INSTALL_FAILED', transaction: manifest?.id ?? null, written: published ? [{ path: manifest.setup.target?.path }] : [],
    publication: published ? 'reported' : error.publicationUnknown ? 'unknown' : 'none',
    message: `${error.message}; ${published ? 'publication occurred; completion needs inspection' : 'automatic continuation refused'}`,
    ...(recovery ? { recovery } : {}), ...(stagedPath ? { stagedPath } : {}),
    recoveryPaths: [recovery?.holdingPath, stagedPath, folder].filter(Boolean) }
}

export function installSetupSkill(target, desired, { setupId, now = new Date(), beforePublish, afterPublish } = {}) {
  return withDefaultsAdmission(() => {
    let parent, manifest, folder, staged, published = false
    try {
      targetValid(target, desired); parent = setupFileParent(target.path)
      const journal = readDefaultsOwnership(setupId), all = records(journal, true)
      const before = observeSetupSkill(target.path, parent), state = journal.inspect(target, before)
      if (state !== 'new') return { code: 'OK', transaction: null, written: [], state }
      if (before.kind !== 'absent') return { code: 'FOREIGN_TARGET', transaction: null, written: [], message: `${target.path} is not setup-owned; left as it is` }
      const allocated = newTransaction(now); folder = allocated.folder
      manifest = { id: allocated.id, created_at: now.toISOString(), kind: 'setup-skill', reason: `setup skill ${target.entry}`, state: 'started',
        targets: app(target) ? [{ harness: target.app, skill: target.entry, path: target.path }] : [], setup: { setupId, target, before } }
      staged = stageSetupSkill(parent, desired, allocated.id, { beforeCreate: path => {
        manifest.setup.staging = { version: 1, kind: 'skill', sourcePath: target.path, path }; saveSetupManifest(folder, manifest)
      } })
      const metadata = metadataFor(target, desired, staged.fingerprint), prior = recordAt(all, metadata)
      if (prior !== null || metadata?.kind === 'own-skills' && Object.hasOwn(all['own-skills'].value.removed, metadata.key)) throw failure('a prior skill record or opt-out prevents reinstallation')
      const value = metadata ? nextRecords(all, metadata, metadata.record) : null
      if (metadata) validateSetupSkillRecords(metadata.kind, value)
      const refs = dependencies(journal, target, staged, desired), compatibility = metadata ? [metadata.kind] : []
      Object.assign(manifest.setup, { after: staged.fingerprint, current: { revision: 1, fingerprint: staged.fingerprint, record: metadata?.record ?? null },
        compatibility, metadata: metadata ? { ...metadata, prior } : null })
      saveSetupManifest(folder, manifest)
      journal.beginInstall(target, manifest.id, before, staged.fingerprint, { dependencies: refs, compatibility })
      beforePublish?.({ transaction: manifest.id, target }); assertDefaultsAdmission(); assertSetupFileParent(parent)
      publishSetupEntry(parent.fd, staged.name, basename(target.path), staged.fingerprint); published = true
      afterPublish?.({ transaction: manifest.id, target })
      if (!same(observeSetupSkill(target.path, parent), staged.fingerprint)) throw failure('the published setup skill changed')
      if (metadata) writeSetupSkillRecords(journal, metadata.kind, all[metadata.kind], value, { folder })
      journal.completeInstall(target, manifest.id, observeSetupSkill(target.path, parent))
      manifest.state = 'complete'; saveSetupManifest(folder, manifest)
      return { code: 'OK', transaction: manifest.id, written: [{ harness: target.app, path: target.path }], state: 'installed' }
    } catch (error) { return resultError(error, { manifest, folder, staged, published: published || error.published }) }
    finally { if (parent) closeSync(parent.fd) }
  })
}

export function refreshSetupSkill(target, desired, { setupId, beforeHold, afterHold, afterPublish, afterBinding, afterMetadata } = {}) {
  return withDefaultsAdmission(() => {
    let parent, manifest, folder, staged, published = false
    try {
      targetValid(target, desired); parent = setupFileParent(target.path)
      const journal = readDefaultsOwnership(setupId), entry = journal.snapshot().entries[defaultsTargetKey(target)]
      if (!entry) throw failure('refresh has no original setup installation')
      const originalPath = originalFolder(entry.transaction), original = loadManifest(originalPath), current = observeSetupSkill(target.path, parent)
      const old = checked(original, originalPath, journal, current)
      if (entry.optOut) return { code: 'OK', transaction: null, written: [], state: 'opted-out' }
      if (desired.kind === current.kind && plannedSetupSkillHash(desired) === current.hash) return { code: 'OK', transaction: null, written: [], state: 'current' }
      if (target.app === 'source' && target.kind === 'skills') throw failure('a setup source keeps its original backing identity; changed source bindings need inspection')
      const id = `refresh-${randomBytes(12).toString('hex')}`; folder = join(originalPath, id); mkdirSync(folder, { mode: 0o700 })
      manifest = { id, kind: 'setup-skill-refresh', state: 'started', targets: [], setup: { target, originalTransaction: entry.transaction } }
      staged = stageSetupSkill(parent, desired, id, { beforeCreate: path => {
        manifest.setup.staging = { version: 1, kind: 'skill', sourcePath: target.path, path }; saveSetupManifest(folder, manifest)
      } })
      if (staged.fingerprint.hash === current.hash && staged.fingerprint.kind === current.kind) return { code: 'OK', transaction: null, written: [], state: 'current', stagedPath: staged.path }
      const refs = dependencies(journal, target, staged, desired)
      const metadata = metadataFor(target, desired, staged.fingerprint), nextRecord = metadata?.record ?? null
      const value = metadata ? nextRecords(old.all, metadata, nextRecord) : null
      if (metadata) validateSetupSkillRecords(metadata.kind, value)
      const recordDigests = metadata ? { [metadata.kind]: { old: old.all[metadata.kind].hash, next: sha(`${JSON.stringify(value, null, 2)}\n`) } } : {}
      const holdingName = `.bmn-hold-${id}-${randomBytes(8).toString('hex')}`
      saveSetupManifest(folder, manifest)
      journal.beginRefresh(target, entry.transaction, { id, expectedRevision: entry.current.revision, old: current, next: staged.fingerprint,
        staging: staged.path, holding: join(parent.real, holdingName), recordDigests, dependencies: refs })
      beforeHold?.({ target }); assertDefaultsAdmission()
      holdSetupSkill(target.path, current, parent, { manifest, folder, holdingName })
      journal.advanceRefresh(target, entry.transaction, id, 'held'); afterHold?.({ target })
      publishSetupEntry(parent.fd, staged.name, basename(target.path), staged.fingerprint); published = true
      if (!same(observeSetupSkill(target.path, parent), staged.fingerprint)) throw failure('the refreshed setup skill changed after publication')
      journal.advanceRefresh(target, entry.transaction, id, 'published'); afterPublish?.({ target })
      original.setup.current = { revision: entry.current.revision + 1, fingerprint: staged.fingerprint, record: nextRecord }
      saveSetupManifest(originalPath, original); afterBinding?.({ target })
      if (metadata) writeSetupSkillRecords(journal, metadata.kind, old.all[metadata.kind], value, { folder })
      afterMetadata?.({ target }); journal.advanceRefresh(target, entry.transaction, id, 'metadata')
      journal.completeRefresh(target, entry.transaction, id, observeSetupSkill(target.path, parent))
      manifest.state = 'complete'; manifest.setup.removal.phase = 'complete'; saveSetupManifest(folder, manifest)
      return { code: 'OK', transaction: entry.transaction, written: [{ path: target.path }], state: 'updated', recovery: manifest.setup.removal }
    } catch (error) { return resultError(error, { manifest, folder, staged, published: published || error.published }) }
    finally { if (parent) closeSync(parent.fd) }
  })
}

function planSkillUndo(manifest, folder) {
    const target = manifest.setup?.target, journal = readDefaultsOwnership(manifest.setup?.setupId), parent = setupFileParent(target.path)
    try {
      const current = observeSetupSkill(target.path, parent), { entry, all } = checked(manifest, folder, journal, current)
      if (manifest.setup.removal && manifest.setup.removal.phase !== 'complete') throw failure('an interrupted skill removal needs inspection')
      const held = target.kind === 'own-skills' ? legacyReferences(journal, all, target) : []
      const hash = sha(JSON.stringify({ id: manifest.id, current, revision: entry.current.revision, dependencies: journal.dependenciesFor(target, manifest.id),
        compatibility: journal.snapshot().compatibility, held }))
      return { journal, entry, all, current, held, hash, targets: [{ harness: target.app, skill: target.entry, path: target.path,
        resolved_path: join(parent.real, basename(target.path)), becomes: 'removed (setup created it)', diff: '', note: 'This default stays removed. Backing is retained while destinations depend on it.' }] }
    } finally { closeSync(parent.fd) }
}

function applySkillUndo(manifest, folder, shown, { beforeRemove, afterMove, effects = {} } = {}) {
  const fresh = planSkillUndo(manifest, folder), target = manifest.setup.target
  if (fresh.hash !== shown.hash) throw failure('the setup skill removal changed during confirmation')
  if (fresh.entry.stage === 'opted-out') return { code: 'OK', restored: [], state: 'opted-out' }
  fresh.journal.beginUndo(target, manifest.id, fresh.current)
  if (fresh.held.length) { fresh.journal.retainUndo(target, manifest.id); throw failure(`backing retained for unresolved legacy destinations: ${fresh.held.join(', ')}`, 'DEFAULTS_DEPENDENCIES') }
  const parent = setupFileParent(target.path)
  try {
    beforeRemove?.({ target }); assertDefaultsAdmission()
    holdSetupSkill(target.path, fresh.current, parent, { manifest, folder, afterMove }); effects.removed = true
    if (manifest.setup.metadata) {
      const metadata = manifest.setup.metadata
      writeSetupSkillRecords(fresh.journal, metadata.kind, fresh.all[metadata.kind], nextRecords(fresh.all, metadata, metadata.prior, true), { folder })
    }
    fresh.journal.completeUndo(target, manifest.id, observeSetupSkill(target.path, parent))
    manifest.setup.removal.phase = 'complete'; manifest.setup.undone = true; saveSetupManifest(folder, manifest)
    return { code: 'OK', restored: app(target) ? [target.app] : [], recovery: manifest.setup.removal,
      message: `Setup skill removed; preserved at ${manifest.setup.removal.holdingPath}` }
  } finally { closeSync(parent.fd) }
}

/** Automatic retirement uses the same checked removal as Earlier installs, inside the existing admission. */
export function retireSetupSkill(target, { setupId } = {}) {
  return withDefaultsAdmission(() => {
    try {
      const journal = readDefaultsOwnership(setupId), entry = journal.snapshot().entries[defaultsTargetKey(target)]
      if (!entry) throw failure('retirement has no setup installation')
      const folder = originalFolder(entry.transaction), manifest = loadManifest(folder), shown = planSkillUndo(manifest, folder)
      return applySkillUndo(manifest, folder, shown)
    } catch (error) { return resultError(error, {}) }
  })
}

export async function restoreSetupSkillTransaction(manifest, folder, { yes = false, asJson = false, planOnly = false, expectedPlanHash, beforeRemove, afterMove } = {}) {
  const effects = {}
  try {
    const shown = planSkillUndo(manifest, folder)
    if (planOnly) return { code: 'OK', plan_hash: shown.hash, targets: shown.targets }
    if (expectedPlanHash !== undefined && expectedPlanHash !== shown.hash) throw failure('the setup skill removal changed since it was shown')
    if (!await confirm(`Undo setup skill ${manifest.id}?`, `${manifest.setup.target.path}: remove the checked current setup revision; preserve its content`, { yes, asJson })) return { code: 'NOT_CONFIRMED' }
    return withDefaultsAdmission(() => applySkillUndo(manifest, folder, shown, { beforeRemove, afterMove, effects }))
  } catch (error) { return { ...resultError(error, {}), restored: effects.removed && app(manifest.setup.target) ? [manifest.setup.target.app] : [],
    ...(manifest.setup?.removal ? { recovery: manifest.setup.removal } : {}) } }
}
