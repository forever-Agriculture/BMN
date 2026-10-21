// MODULE: setup-skill-fs.mjs - Pinned, no-follow skill observations, synced staging and retained quarantine
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { canonicalJson } from './agents-roster.mjs'
import { withHeader } from './agents-skills.mjs'
import { assertDefaultsAdmission } from './defaults-admission.mjs'
import { publishSetupEntry } from './defaults-publish.mjs'
import { assertSetupFileParent, saveSetupManifest, setupPinnedPath } from './setup-file-defaults.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
const inode = stat => `${stat.dev}:${stat.ino}`
const same = (a, b) => a.kind === b.kind && a.hash === b.hash && a.parent === b.parent && a.object === b.object
const conflict = message => Object.assign(new Error(message), { code: 'REVISION_CONFLICT' })
const stable = (a, b) => inode(a) === inode(b) && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const pinned = (fd, name = '') => `/proc/self/fd/${fd}${name ? `/${name}` : ''}`

/** Walk through directory descriptors; no descendant link is followed, including during a concurrent replacement. */
function tree(path, { to, header } = {}) {
  const entries = [], links = []
  let bytes = 0
  const walk = (path, relative, parentIdentity, destination) => {
    if (entries.length >= 4000) throw conflict('the skill has too many entries for a safe setup copy')
    const before = lstatSync(path), mode = before.mode & 0o777
    if (before.isSymbolicLink()) {
      const text = readlinkSync(path)
      if (!stable(before, lstatSync(path))) throw conflict('a skill link changed while it was read')
      entries.push({ path: relative, kind: 'link', target: text })
      links.push({ path: relative, text, fingerprint: { kind: 'link', hash: sha(text), parent: parentIdentity, object: inode(before) } })
      if (destination) symlinkSync(text, destination)
      return
    }
    let fd
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (before.isDirectory() ? constants.O_DIRECTORY : 0))
      const opened = fstatSync(fd)
      if (!stable(before, opened)) throw conflict('a skill entry changed before it was opened')
      if (opened.isDirectory()) {
        entries.push({ path: relative, kind: 'folder', mode })
        if (destination) mkdirSync(destination, { mode: 0o700 })
        for (const name of readdirSync(pinned(fd)).sort()) walk(pinned(fd, name), relative ? `${relative}/${name}` : name, inode(opened), destination ? join(destination, name) : undefined)
        if (destination) {
          chmodSync(destination, mode)
          const output = openSync(destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          try { fsyncSync(output) } finally { closeSync(output) }
        }
      } else if (opened.isFile() && opened.size <= 1024 * 1024) {
        let content = readFileSync(fd); bytes += content.length
        if (bytes > 32 * 1024 * 1024) throw conflict('the skill is too large for a safe setup copy')
        if (header && relative === 'SKILL.md') content = Buffer.from(withHeader(content.toString('utf8'), header.name, header.sourceHash))
        entries.push({ path: relative, kind: 'file', mode, hash: sha(content) })
        if (destination) {
          const output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
          try { writeFileSync(output, content); fchmodSync(output, mode); fsyncSync(output) } finally { closeSync(output) }
        }
      } else throw conflict('the skill contains an unsupported or unbounded file')
      if (!stable(opened, fstatSync(fd)) || !stable(before, lstatSync(path))) throw conflict('a skill entry changed while it was read')
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  if (!lstatSync(path).isDirectory()) throw conflict('a setup skill copy needs a real source directory')
  walk(path, '', null, to)
  if (header && !entries.some(entry => entry.path === 'SKILL.md' && entry.kind === 'file')) {
    throw conflict('a generated skill copy requires a regular SKILL.md for its provenance header')
  }
  return { hash: sha(canonicalJson(entries)), links }
}

export function observeSetupSkill(path, parent) {
  assertSetupFileParent(parent)
  const leaf = setupPinnedPath(parent, basename(path))
  let stat
  try { stat = lstatSync(leaf) } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'absent', hash: null, parent: parent.identity, object: null }
    throw error
  }
  let kind, hash
  if (stat.isSymbolicLink()) { kind = 'link'; hash = sha(readlinkSync(leaf)) }
  else if (stat.isDirectory()) { kind = 'tree'; hash = tree(leaf).hash }
  else if (stat.isFile() && stat.size <= 1024 * 1024) {
    kind = 'file'
    const fd = openSync(leaf, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!stable(stat, fstatSync(fd))) throw conflict('the skill file changed before it was opened')
      hash = sha(readFileSync(fd))
      if (!stable(stat, fstatSync(fd))) throw conflict('the skill file changed while it was read')
    } finally { closeSync(fd) }
  } else throw conflict('the setup skill target is not a supported filesystem entry')
  if (!stable(stat, lstatSync(leaf))) throw conflict('the setup skill changed during observation')
  assertSetupFileParent(parent)
  return { kind, hash, parent: parent.identity, object: inode(stat) }
}

export function plannedSetupSkillHash(desired) {
  if (desired?.kind === 'link' && typeof desired.text === 'string') return sha(desired.text)
  if (desired?.kind === 'tree' && typeof desired.source === 'string') return tree(desired.source, { header: desired.header }).hash
  throw conflict('invalid planned setup skill')
}

export function stageSetupSkill(parent, desired, transaction, { beforeCreate } = {}) {
  assertDefaultsAdmission(); assertSetupFileParent(parent)
  const name = `.bmn-stage-${transaction}-${randomBytes(8).toString('hex')}`, path = setupPinnedPath(parent, name)
  try {
    beforeCreate?.(join(parent.real, name))
    if (desired?.kind === 'link' && typeof desired.text === 'string' && desired.text.length > 0 && desired.text.length <= 4096 && !desired.text.includes('\0')) symlinkSync(desired.text, path)
    else if (desired?.kind === 'tree' && typeof desired.source === 'string') {
      const sourceHash = tree(desired.source).hash
      if (desired.expectedHash !== undefined && sourceHash !== desired.expectedHash) throw conflict('the skill source changed since it was planned')
      const copied = tree(desired.source, { to: path, header: desired.header })
      if (tree(desired.source).hash !== sourceHash || tree(path).hash !== copied.hash) throw conflict('the skill source or stage changed during copying')
    } else throw conflict('invalid staged setup skill')
    fsyncSync(parent.fd); assertSetupFileParent(parent)
    const fingerprint = observeSetupSkill(join(parent.real, name), parent)
    return { name, path: join(parent.real, name), fingerprint, links: fingerprint.kind === 'tree' ? tree(path).links : [] }
  } catch (error) {
    error.recovery = { stagedPath: join(parent.real, name) }
    error.message += `; inspect staged path ${join(parent.real, name)}`
    throw error
  }
}

/** Same no-replace preservation contract as shared files, with complete tree/mode/link validation. */
export function holdSetupSkill(path, expected, parent, { manifest, folder, key = 'removal', afterMove, holdingName = `.bmn-hold-${manifest.id}-${randomBytes(8).toString('hex')}` } = {}) {
  assertDefaultsAdmission(); assertSetupFileParent(parent)
  if (manifest.setup[key]) throw conflict('an earlier skill holding operation needs inspection')
  if (!same(observeSetupSkill(path, parent), expected)) throw conflict('the setup skill changed before preservation')
  const prefix = `.bmn-hold-${manifest.id}-`
  if (!holdingName.startsWith(prefix) || !/^[a-f0-9]{16}$/.test(holdingName.slice(prefix.length))) throw conflict('invalid skill holding path')
  const operation = { version: 1, phase: 'intent', sourcePath: path, holdingPath: join(parent.real, holdingName), expected }
  manifest.setup[key] = operation; saveSetupManifest(folder, manifest)
  try {
    publishSetupEntry(parent.fd, basename(path), holdingName, expected)
    afterMove?.({ path, holdingPath: operation.holdingPath })
    if (!same(observeSetupSkill(operation.holdingPath, parent), expected)) throw conflict('the held skill is a concurrent replacement or edit')
    operation.phase = 'verified'; saveSetupManifest(folder, manifest)
    return operation
  } catch (error) {
    operation.phase = 'unresolved'
    try {
      const held = observeSetupSkill(operation.holdingPath, parent)
      if (held.kind !== 'absent' && !same(held, expected)) {
        try { publishSetupEntry(parent.fd, holdingName, basename(path), held); operation.phase = 'foreign-returned' }
        catch { /* Preserve both names; an occupied original name is never overwritten. */ }
      }
    } catch { /* Changed parent or unreadable holding: retain the intent and every object. */ }
    try { saveSetupManifest(folder, manifest) } catch { /* Pre-mutation intent remains durable. */ }
    error.recovery = operation
    error.message += `; recovery path ${operation.holdingPath}; phase ${operation.phase}`
    throw error
  }
}
