// MODULE: setup-recovery.mjs - Bounded read-only recovery history; recorded paths never grant restoration authority
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { agentsDirectory, canonicalJson } from './agents-roster.mjs'
import { withDefaultsAdmission } from './defaults-admission.mjs'
import { defaultsTargetKey, optionalDefaultsOwnership } from './defaults-ownership.mjs'
import { setupSkillRecordPath } from './setup-skill-records.mjs'

const originalId = value => /^[0-9TZ-]+-\d+$/.test(value)
const refreshId = value => /^refresh-[a-f0-9]{24}$/.test(value)
const metadataId = value => /^metadata-[a-f0-9]{24}$/.test(value)
const pathValid = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && isAbsolute(value) && resolve(value) === value
const pinned = (fd, name) => `/proc/self/fd/${fd}${name ? `/${name}` : ''}`
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const invalid = () => { throw new Error('recovery history needs inspection') }

/** Never reads a target, holding or staging payload. Missing locations remain recorded, not silently forgotten. */
export function readSetupRecovery(setupId, { maxEntries = 8192, maxBytes = 32 * 1024 * 1024, maxPaths = 4096, maxOutputBytes = 1024 * 1024 } = {}) {
  try { return withDefaultsAdmission(() => {
    let incomplete = false, entries = 0, bytes = 0, outputBytes = 0, pathCount = 0
    const rows = [], known = new Set(), seenOriginals = new Set()
    const attempt = work => { try { return work() } catch { incomplete = true; return undefined } }
    const directory = (parent, name, work) => {
      const path = pinned(parent, name), fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const before = fstatSync(fd)
        if (!before.isDirectory() || !same(before, lstatSync(path))) invalid()
        const result = work(fd)
        // Directory contents may change during our own enumeration; inode replacement may not.
        const after = lstatSync(path)
        if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory()) invalid()
        return result
      } finally { closeSync(fd) }
    }
    const names = fd => {
      const list = [], stream = opendirSync(pinned(fd))
      try { for (let entry; (entry = stream.readSync()) !== null;) {
        if (++entries > maxEntries) { incomplete = true; break }
        list.push(entry.name)
      } }
      finally { stream.closeSync() }
      return list.sort()
    }
    const manifest = fd => {
      const path = pinned(fd, 'manifest.json'), file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const before = fstatSync(file)
        if (!before.isFile() || before.nlink !== 1 || before.size > 2 * 1024 * 1024 || (bytes += before.size) > maxBytes) invalid()
        const text = readFileSync(file, 'utf8')
        if (!same(before, fstatSync(file)) || !same(before, lstatSync(path))) invalid()
        return JSON.parse(text)
      } finally { closeSync(file) }
    }
    const validTarget = target => { defaultsTargetKey(target); return target }
    const add = (row, path) => {
      if (!pathValid(path)) invalid()
      if (known.has(path)) return
      if (pathCount >= maxPaths || outputBytes + Buffer.byteLength(path) + 300 > maxOutputBytes) { incomplete = true; return }
      known.add(path); pathCount++; outputBytes += Buffer.byteLength(path) + 300; row.recoveryPaths.push(path)
    }
    const location = (row, path, prefix, directory) => {
      if (!pathValid(path) || !pathValid(directory) || dirname(path) !== directory ||
        !basename(path).startsWith(prefix) || !/^[a-f0-9]{16}$/.test(basename(path).slice(prefix.length))) invalid()
      add(row, path)
    }
    const parents = path => {
      const result = [dirname(path)]
      try { result.push(realpathSync(dirname(path))) } catch { /* Recorded lexical paths still require no payload reads. */ }
      return result
    }
    const extract = (value, row, targets, metadata = false) => {
      const setup = value.setup
      if (!setup || typeof setup !== 'object' || Array.isArray(setup)) invalid()
      const paths = targets.map(target => target.path)
      if (metadata) paths.push(setupSkillRecordPath('own-skills'), setupSkillRecordPath('skills-written'))
      for (const key of ['configInstall', 'configUndo']) {
        const operation = setup[key], holding = setup[`${key}Holding`]
        if (operation === undefined) { if (holding !== undefined) invalid(); continue }
        if (operation.version !== 1 || !paths.includes(operation.path) || !parents(operation.path).includes(operation.directory)) invalid()
        // Completed stages have been consumed by publication; incomplete stages are recorded even if currently missing.
        if (operation.phase !== 'complete') location(row, operation.stagedPath, `.bmn-stage-${value.id}-`, operation.directory)
        if (holding !== undefined) {
          if (holding.version !== 1 || holding.sourcePath !== operation.path) invalid()
          location(row, holding.holdingPath, `.bmn-hold-${value.id}-`, operation.directory)
        }
      }
      for (const key of ['removal', 'pluginRemoval']) {
        const holding = setup[key]
        if (holding === undefined) continue
        if (holding.version !== 1 || !paths.includes(holding.sourcePath) || !parents(holding.sourcePath).includes(dirname(holding.holdingPath))) invalid()
        location(row, holding.holdingPath, `.bmn-hold-${value.id}-`, dirname(holding.holdingPath))
      }
      if (setup.staging !== undefined && value.state !== 'complete') {
        const stage = setup.staging
        if (stage.version !== 1 || !paths.includes(stage.sourcePath) || !parents(stage.sourcePath).includes(dirname(stage.path))) invalid()
        if (stage.kind === 'skill') location(row, stage.path, `.bmn-stage-${value.id}-`, dirname(stage.path))
        else if (stage.kind === 'file' && /^\.bmn-setup-\d+-[a-f0-9]{16}\.tmp$/.test(basename(stage.path))) add(row, stage.path)
        else invalid()
      }
    }
    let journal
    attempt(() => {
      const ownership = optionalDefaultsOwnership()
      if (ownership && ownership.snapshot().setupId !== setupId) invalid()
      journal = ownership?.snapshot()
    })
    const metadata = (fd, row, targets) => {
      for (const name of names(fd).filter(metadataId)) attempt(() => directory(fd, name, child => {
        const value = manifest(child)
        if (value.id !== name || value.kind !== 'setup-skill-metadata') invalid()
        extract(value, row, targets, true)
      }))
    }
    const original = (fd, name) => {
      const value = manifest(fd), setup = value.setup
      if (setup?.setupId !== setupId) return
      if (value.id !== name || !['setup-file', 'setup-skill', 'setup-hook', 'setup-tool', 'setup-opencode-hooks'].includes(value.kind)) invalid()
      const targets = value.kind === 'setup-opencode-hooks' ? [setup.pair?.plugin, setup.pair?.registration].map(validTarget) : [validTarget(setup.target)]
      for (const target of targets) {
        if (!({ 'setup-file': ['master', 'rules', 'hooks'], 'setup-skill': ['skills', 'own-skills'], 'setup-hook': ['hooks'],
          'setup-tool': ['tools'], 'setup-opencode-hooks': ['hooks'] })[value.kind].includes(target.kind)) invalid()
        const entry = journal?.entries[defaultsTargetKey(target)]
        if (entry && entry.transaction !== name) invalid()
        const before = value.kind === 'setup-opencode-hooks' ? target.entry === 'plugin' ? setup.pluginBefore : setup.regBefore : setup.before
        const after = value.kind === 'setup-opencode-hooks' ? target.entry === 'plugin' ? setup.pluginAfter : setup.regAfter : setup.after
        if (entry && (canonicalJson(entry.before) !== canonicalJson(before) || canonicalJson(entry.after) !== canonicalJson(after))) invalid()
      }
      if (rows.length >= 2048) invalid()
      seenOriginals.add(name)
      const target = targets[0], row = { kind: target.kind, app: ['claude', 'codex', 'opencode'].includes(target.app) ? target.app : null,
        code: 'OK', state: 'recovery', transaction: name, paths: [], recoveryPaths: [] }
      rows.push(row)
      attempt(() => extract(value, row, targets))
      metadata(fd, row, targets)
      for (const childName of names(fd).filter(refreshId)) attempt(() => directory(fd, childName, child => {
        const next = manifest(child)
        if (value.kind !== 'setup-skill' || next.id !== childName || next.kind !== 'setup-skill-refresh' ||
          next.setup?.originalTransaction !== name || canonicalJson(next.setup?.target) !== canonicalJson(target)) invalid()
        attempt(() => extract(next, row, targets))
        metadata(child, row, targets)
      }))
    }
    const root = join(agentsDirectory(), 'state/rules/transactions')
    // Open every component relative to a pinned descriptor: no ancestor symlink can redirect traversal.
    const descend = (fd, parts) => parts.length ? directory(fd, parts[0], child => descend(child, parts.slice(1))) :
      names(fd).filter(originalId).forEach(name => attempt(() => directory(fd, name, child => original(child, name))))
    const slash = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      try { descend(slash, root.split('/').filter(Boolean)) }
      catch (error) { if (error.code !== 'ENOENT' || Object.keys(journal?.entries ?? {}).length > 0) incomplete = true }
    } finally { closeSync(slash) }
    for (const entry of Object.values(journal?.entries ?? {})) {
      if (!seenOriginals.has(entry.transaction)) incomplete = true
      if (entry.operation) {
        const row = rows.find(row => row.transaction === entry.transaction)
        if (!row) continue
        attempt(() => {
          const operation = entry.operation, parent = dirname(operation.staging)
          if (!parents(entry.target.path).includes(parent)) invalid()
          location(row, operation.staging, `.bmn-stage-${operation.id}-`, parent)
          location(row, operation.holding, `.bmn-hold-${operation.id}-`, parent)
        })
      }
    }
    const result = rows.filter(row => row.recoveryPaths.length).map(row => ({ ...row, recoveryPaths: row.recoveryPaths.sort() }))
    if (incomplete) result.push({ kind: 'master', app: null, code: 'RECOVERY_INCOMPLETE', state: 'recovery', transaction: null, paths: [], recoveryPaths: [] })
    return { code: incomplete ? 'RECOVERY_INCOMPLETE' : 'OK', rows: result }
  }) } catch {
    return { code: 'RECOVERY_INCOMPLETE', rows: [{ kind: 'master', app: null, code: 'RECOVERY_INCOMPLETE', state: 'recovery', transaction: null, paths: [], recoveryPaths: [] }] }
  }
}
