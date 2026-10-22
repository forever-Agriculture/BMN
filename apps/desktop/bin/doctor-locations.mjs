// MODULE: doctor-locations.mjs - Bounded observation acquisition and credential-free revision-checked coordinates
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative } from 'node:path'

export const LOCATION_ROOTS = Object.freeze(['home', 'claude-profile', 'codex-profile', 'opencode-profile',
  'claude-skills', 'codex-skills', 'shared-skills', 'opencode-skills', 'opencode-skill',
  'claude-user-config', 'opencode-custom-config', 'opencode-xdg', 'filesystem'])
const fields = ['device', 'inode', 'size', 'modified', 'changed', 'mode']
const kinds = ['file', 'directory', 'link', 'other']
const numeric = (value) => typeof value === 'string' && /^\d{1,30}$/.test(value)
const integer = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 1000000000
const equal = (a, b) => a === null || b === null ? a === b : a.type === b.type && fields.every((field) => a[field] === b[field])
const record = (stat) => ({ device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), modified: String(stat.mtimeNs),
  changed: String(stat.ctimeNs), mode: String(stat.mode), type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'other' })
const metadata = (path, follow = false) => record((follow ? statSync : lstatSync)(path, { bigint: true }))
const absent = (error) => ['ENOENT', 'ENOTDIR'].includes(error.code)
const optional = (path, follow = false) => { try { return metadata(path, follow) } catch (error) { if (absent(error)) return null; throw error } }
const sorted = (path) => {
  const names = readdirSync(path, { encoding: 'buffer' })
  if (names.length > 10000) exceeded()
  return names.sort(Buffer.compare)
}
const fail = () => { throw new Error('observation unavailable') }
/** A size bound, told apart from an unreadable or changing source: only a location may be given up for it. */
const exceeded = () => { throw Object.assign(new Error('observation bound exceeded'), { code: 'BOUND_EXCEEDED' }) }
const LIMIT = 256

export function locationRoots(profile) {
  return { home: profile.home, 'claude-profile': profile.claude, 'codex-profile': profile.codex, 'opencode-profile': profile.opencode,
    'claude-skills': join(profile.claude, 'skills'), 'codex-skills': join(profile.codex, 'skills'), 'shared-skills': join(profile.home, '.agents/skills'),
    'opencode-skills': join(profile.opencode, 'skills'), 'opencode-skill': join(profile.opencode, 'skill'),
    'claude-user-config': profile.claudeJson, 'opencode-custom-config': profile.paths.OPENCODE_CONFIG ?? profile.opencode,
    'opencode-xdg': join(profile.paths.XDG_CONFIG_HOME, 'opencode'), filesystem: '/' }
}
export function unresolvedLocation() { return { status: 'unresolved' } }

function capture(path, roots) {
  const parentPath = dirname(path)
  const parent = metadata(parentPath, true)
  const object = metadata(path)
  const target = object.type === 'link' ? optional(path, true) : undefined
  const names = sorted(parentPath)
  const entry = names.findIndex((name) => name.equals(Buffer.from(basename(path)))) + 1
  if (!entry || !equal(parent, metadata(parentPath, true)) || !equal(object, metadata(path)) ||
    target !== undefined && !equal(target, optional(path, true))) fail()
  const root = Object.entries(roots).filter(([, folder]) => folder === path || !relative(folder, path).startsWith('..') && relative(folder, path) !== '')
    .sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? 'filesystem'
  return { root, parent, object, entry, ...(target !== undefined ? { target } : {}) }
}

function sameCurrent(path, value) {
  try {
    const parentPath = dirname(path)
    const parent = metadata(parentPath, true)
    if (!equal(parent, value.parent) || !equal(metadata(path), value.object)) return false
    const target = value.target === undefined ? undefined : optional(path, true)
    const wal = value.wal === undefined ? undefined : optional(`${path}-wal`)
    if (value.target !== undefined && !equal(target, value.target) || value.wal !== undefined && !equal(wal, value.wal) ||
      value.journalAbsent && optional(`${path}-journal`) !== null) return false
    const name = sorted(parentPath)[value.entry - 1]
    return name?.equals(Buffer.from(basename(path))) === true && equal(metadata(parentPath, true), parent) &&
      equal(metadata(path), value.object) && (target === undefined || equal(target, optional(path, true))) &&
      (wal === undefined || equal(wal, optional(`${path}-wal`))) && (!value.journalAbsent || optional(`${path}-journal`) === null)
  } catch { return false }
}
const publish = (value, witnesses = []) => ({ status: 'located', acquisition: 1, ...value, witnesses })

/** Read once through a verified descriptor. Every byte belongs to the revision captured before opening. */
export function observeFile(path, roots, { maxBytes = 1024 * 1024, expected = null, binary = false } = {}) {
  let descriptor
  const source = expected ?? capture(path, roots)
  try {
    if (!sameCurrent(path, source)) fail()
    const expectedFile = source.target ?? source.object
    if (expectedFile.type !== 'file') fail()
    if (Number(expectedFile.size) > maxBytes) exceeded()
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    if (!equal(record(fstatSync(descriptor, { bigint: true })), expectedFile)) fail()
    const bytes = Buffer.alloc(Number(expectedFile.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) fail()
      offset += count
    }
    if (!equal(record(fstatSync(descriptor, { bigint: true })), expectedFile) || !sameCurrent(path, source)) fail()
    const text = bytes.toString('utf8')
    if (!binary && !Buffer.from(text).equals(bytes)) fail()
    return { path, bytes, text, locator: publish(source), revisions: [{ path, snapshot: source }] }
  } finally { if (descriptor !== undefined) closeSync(descriptor) }
}

/** A link remains the item; followed bytes and every contributing child get separate flat numeric witnesses. */
export function observeTree(path, roots) {
  const source = capture(path, roots)
  const dependencies = []
  const files = new Map()
  const directories = new Map()
  const entries = []
  let total = 0
  let link = null
  if (source.object.type === 'link') link = readlinkSync(path)
  const body = source.object.type === 'link' && source.target !== null ? realpathSync(path) : path
  const walk = (current, name, depth) => {
    if (dependencies.length >= LIMIT - 1 || depth > 12) exceeded()
    const snapshot = capture(current, roots)
    dependencies.push({ path: current, snapshot })
    if (snapshot.object.type === 'file') {
      const observed = observeFile(current, roots, { expected: snapshot, binary: true })
      total += observed.bytes.length
      if (total > 16 * 1024 * 1024) exceeded()
      files.set(name, observed.bytes)
      entries.push([name, 'file', snapshot.object.mode, createHash('sha256').update(observed.bytes).digest('hex')])
    } else if (snapshot.object.type === 'directory') {
      const names = sorted(current).map((entry) => {
        const text = entry.toString('utf8')
        if (!Buffer.from(text).equals(entry)) fail()
        return text
      })
      if (!sameCurrent(current, snapshot)) fail()
      directories.set(name, names)
      entries.push([name, 'directory', snapshot.object.mode])
      for (const child of names) walk(join(current, child), name ? `${name}/${child}` : child, depth + 1)
    } else if (snapshot.object.type === 'link') {
      const target = readlinkSync(current)
      if (!sameCurrent(current, snapshot)) fail()
      entries.push([name, 'link', target])
    } else fail()
  }
  if (source.object.type !== 'link' || source.target !== null) walk(body, '', 0)
  if (!sameCurrent(path, source) || dependencies.some((item) => !sameCurrent(item.path, item.snapshot))) fail()
  return { path, body, link, kind: source.object.type, missingTarget: source.object.type === 'link' && source.target === null,
    files, directories, hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    locator: publish(source, dependencies.map((item) => item.snapshot)), revisions: [{ path, snapshot: source }, ...dependencies] }
}

/** Both DBs, WAL lifecycle and rollback-journal absence are one source vector, captured before any copy. */
export function observeDatabases(paths, roots) {
  const vector = paths.map((path) => {
    const source = optional(path)
    if (source === null) return { path, source: null, parent: metadata(dirname(path), true) }
    const snapshot = { ...capture(path, roots), wal: optional(`${path}-wal`), journalAbsent: true }
    if (optional(`${path}-journal`) !== null) fail()
    const wal = snapshot.wal === null ? null : capture(`${path}-wal`, roots)
    return { path, source: snapshot, wal }
  })
  const observations = vector.map((item) => {
    if (item.source === null) return null
    const database = observeFile(item.path, roots, { expected: item.source, maxBytes: 64 * 1024 * 1024, binary: true })
    if (database.bytes.subarray(0, 16).toString('hex') !== '53514c69746520666f726d6174203300' ||
      ![1, 2].includes(database.bytes[18]) || database.bytes[18] !== database.bytes[19]) fail()
    const wal = item.wal === null ? null : observeFile(`${item.path}-wal`, roots, { expected: item.wal, maxBytes: 64 * 1024 * 1024, binary: true })
    return { ...database, walBytes: wal?.bytes ?? null }
  })
  if (vector.some((item) => item.source === null ? optional(item.path) !== null || !equal(metadata(dirname(item.path), true), item.parent)
    : !sameCurrent(item.path, item.source) || item.wal !== null && !sameCurrent(`${item.path}-wal`, item.wal))) fail()
  const dependencies = vector.filter((item) => item.source !== null).map((item) => item.source)
  const revisions = vector.map((item) => ({ path: item.path, snapshot: item.source }))
  return observations.map((item) => item === null ? null : { ...item, locator: { ...item.locator, witnesses: dependencies }, revisions })
}

/** Never recapture a newer source to attach coordinates to old bytes. */
export function bindLocation(observation, roots, { start = null, rowid = null, dependencies = [] } = {}) {
  if (!observation?.locator || observation.locator.status !== 'located') return unresolvedLocation()
  const { witnesses, ...base } = observation.locator
  const all = [...witnesses]
  for (const dependency of dependencies) {
    if (!dependency?.locator || dependency.locator.status !== 'located') return unresolvedLocation()
    const value = validSource(dependency.locator)
    if (!value || !Array.isArray(dependency.locator.witnesses)) return unresolvedLocation()
    all.push(value, ...dependency.locator.witnesses)
  }
  const locator = { ...base, witnesses: [...new Map(all.map((value) => [JSON.stringify(value), value])).values()] }
  if (start !== null) {
    if (typeof observation.text !== 'string' || !Number.isSafeInteger(start) || start < 0 || start >= observation.text.length) return unresolvedLocation()
    locator.line = observation.text.slice(0, start).split('\n').length
    locator.column = start - observation.text.lastIndexOf('\n', start - 1)
  }
  if (rowid !== null) { if (!integer(rowid)) return unresolvedLocation(); locator.rowid = rowid }
  const clean = validateLocation(locator)
  return clean?.status === 'located' && resolveLocation(clean, roots) !== null ? clean : unresolvedLocation()
}

/** The object itself, its followed target and SQLite WAL and journal; a sibling's churn in the parent moves only the location. */
function sameObject(path, value) {
  try {
    return equal(metadata(path), value.object) && (value.target === undefined || equal(optional(path, true), value.target)) &&
      (value.wal === undefined || equal(optional(`${path}-wal`), value.wal)) && (!value.journalAbsent || optional(`${path}-journal`) === null)
  } catch { return false }
}

/** Whether every revision an observation was read from is still at its known path (an absent one still absent), without searching. */
export function unchangedSince(observation) {
  return Array.isArray(observation?.revisions) && observation.revisions.every(({ path, snapshot }) => {
    try { return snapshot === null ? optional(path) === null : sameObject(path, snapshot) } catch { return false }
  })
}

/** Coordinates with text acquire and compare that text; callers cannot attach stale parsed bytes. */
export function locateItem(path, roots, { text = null, start = null, rowid = null } = {}) {
  try {
    if (text !== null || start !== null) {
      const observed = observeFile(path, roots)
      if (observed.text !== text) return unresolvedLocation()
      return bindLocation(observed, roots, { start, rowid })
    }
    const value = capture(path, roots)
    if (rowid !== null) { if (!integer(rowid)) return unresolvedLocation(); value.rowid = rowid; value.wal = optional(`${path}-wal`); value.journalAbsent = true }
    return sameCurrent(path, value) ? publish(value) : unresolvedLocation()
  } catch { return unresolvedLocation() }
}

function validStat(value) {
  if (!value || !kinds.includes(value.type) || fields.some((field) => !numeric(value[field]))) return null
  return { ...Object.fromEntries(fields.map((field) => [field, value[field]])), type: value.type }
}
function validSource(value) {
  if (!value || !LOCATION_ROOTS.includes(value.root) || !integer(value.entry)) return null
  const parent = validStat(value.parent); const object = validStat(value.object)
  if (!parent || !object) return null
  const out = { root: value.root, parent, object, entry: value.entry }
  for (const key of ['target', 'wal']) if (value[key] !== undefined) {
    const stat = value[key] === null ? null : validStat(value[key])
    if (stat === null && value[key] !== null) return null
    out[key] = stat
  }
  if (value.journalAbsent !== undefined) { if (value.journalAbsent !== true) return null; out.journalAbsent = true }
  return out
}
export function validateLocation(value) {
  if (!value || !['located', 'stale', 'unresolved'].includes(value.status)) return null
  if (value.status === 'unresolved' || value.acquisition !== 1) return unresolvedLocation()
  const source = validSource(value)
  if (!source || !Array.isArray(value.witnesses) || value.witnesses.length > LIMIT) return null
  const witnesses = value.witnesses.map(validSource)
  if (witnesses.some((item) => item === null)) return null
  if ((value.line !== undefined || value.column !== undefined) && (!integer(value.line) || !integer(value.column))) return null
  if (value.rowid !== undefined && (!integer(value.rowid) || value.wal === undefined || value.journalAbsent !== true)) return null
  return { status: value.status, acquisition: 1, ...source, witnesses,
    ...(value.line !== undefined ? { line: value.line, column: value.column } : {}), ...(value.rowid !== undefined ? { rowid: value.rowid } : {}) }
}

function findSource(value, roots, budget) {
  const root = roots[value.root]
  if (!root) return null
  const visit = (path, depth) => {
    if (--budget.remaining < 0 || depth > 12) return null
    let stat
    try { stat = metadata(path) } catch { return null }
    if (stat.device === value.object.device && stat.inode === value.object.inode && sameCurrent(path, value)) return path
    if (path === root && stat.type === 'link') {
      try { stat = metadata(path, true) } catch { return null }
    }
    if (stat.device === value.parent.device && stat.inode === value.parent.inode) {
      try {
        const name = sorted(path)[value.entry - 1]
        if (!name || !Buffer.from(name.toString('utf8')).equals(name)) return null
        const found = join(path, name.toString('utf8'))
        return sameCurrent(found, value) ? found : null
      } catch { return null }
    }
    if (stat.type !== 'directory') return null
    try {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const found = visit(join(path, entry.name), depth + 1)
        if (found) return found
      }
    } catch { /* Metadata which cannot be verified is never a location. */ }
    return null
  }
  return visit(root, 0)
}

/** Bounded lookup checks every dependency and rechecks the selected item after witness traversal. */
export function resolveLocation(value, roots, budget = { remaining: 10000 }) {
  const locator = validateLocation(value)
  if (!locator || locator.status !== 'located') return null
  const path = findSource(locator, roots, budget)
  if (path === null) return null
  const dependencies = []
  for (const witness of locator.witnesses) {
    const target = findSource(witness, roots, budget)
    if (target === null) return null
    dependencies.push([target, witness])
  }
  return dependencies.every(([target, witness]) => sameCurrent(target, witness)) && sameCurrent(path, locator) ? path : null
}

export function locationText(value) {
  const locator = validateLocation(value)
  if (!locator || locator.status === 'unresolved') return 'Identity withheld · location unavailable'
  return `${locator.status === 'stale' ? 'Stale location' : 'Identity withheld'} · ${locator.root} · device ${locator.object.device}, inode ${locator.object.inode} · parent ${locator.parent.inode}, entry ${locator.entry}` +
    (locator.line ? ` · line ${locator.line}, column ${locator.column}` : '') + (locator.rowid ? ` · stage1_outputs rowid ${locator.rowid}` : '') +
    ` · object revision ${locator.object.size}/${locator.object.modified}/${locator.object.changed} · parent revision ${locator.parent.device}/${locator.parent.size}/${locator.parent.modified}/${locator.parent.changed}` +
    ` · ${locator.witnesses.length} dependency revisions`
}
export const LOCATION_HELP = 'Names are withheld, even ordinary names. Resolve the selected root from its app profile selectors. Find the parent by device and inode, then its one-based directory entry in raw UTF-8 byte order; verify inode, type, mode, size and nanosecond mtime/ctime before inspecting. Verify every dependency witness and any followed link target or SQLite WAL. Configuration entries use one-based line and UTF-16 column; Codex memory uses stage1_outputs numeric rowid in the verified database. Acquisition version 1 binds these coordinates to captured bytes. Changed, reordered, replaced, legacy or unverifiable observations become stale or unresolved; check again. BMN leaves every item.'
