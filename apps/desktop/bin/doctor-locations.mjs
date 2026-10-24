// MODULE: doctor-locations.mjs - Bounded observation acquisition and credential-free revision-checked coordinates
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative } from 'node:path'

export const LOCATION_ROOTS = Object.freeze(['home', 'claude-profile', 'codex-profile', 'opencode-profile',
  'claude-skills', 'codex-skills', 'shared-skills', 'opencode-skills', 'opencode-skill',
  'claude-user-config', 'opencode-custom-config', 'opencode-xdg', 'opencode-managed', 'filesystem'])
const fields = ['device', 'inode', 'size', 'modified', 'changed', 'mode']
const kinds = ['file', 'directory', 'link', 'other']
const numeric = (value) => typeof value === 'string' && /^\d{1,30}$/.test(value)
const integer = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 1000000000
const equal = (a, b) => a === null || b === null ? a === b : a.type === b.type && fields.every((field) => a[field] === b[field])
const record = (stat) => ({ device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), modified: String(stat.mtimeNs),
  changed: String(stat.ctimeNs), mode: String(stat.mode), owner: String(stat.uid), group: String(stat.gid), links: String(stat.nlink),
  type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'other' })
const metadata = (path, follow = false) => record((follow ? statSync : lstatSync)(path, { bigint: true }))
const absent = (error) => ['ENOENT', 'ENOTDIR'].includes(error.code)
const optional = (path, follow = false) => { try { return metadata(path, follow) } catch (error) { if (absent(error)) return null; throw error } }
const sorted = (path, cache = null) => {
  const before = cache ? metadata(path, true) : null
  const hit = cache?.get(path)
  if (hit && equal(hit.revision, before)) return hit.names
  const names = readdirSync(path, { encoding: 'buffer' })
  if (names.length > 10000) exceeded()
  names.sort(Buffer.compare)
  if (cache) {
    if (!equal(before, metadata(path, true))) fail()
    cache.set(path, { revision: before, names })
  }
  return names
}
const fail = (code = 'SOURCE_CHANGED') => { throw Object.assign(new Error('observation unavailable'), { code }) }
/** A size bound, told apart from an unreadable or changing source: only a location may be given up for it. */
const exceeded = (bound = null) => { throw Object.assign(new Error('observation bound exceeded'), { code: 'BOUND_EXCEEDED', ...(bound === null ? {} : { bound }) }) }
export const OBSERVATION_LIMITS = Object.freeze({ entries: 1024, treeBytes: 16 * 1024 * 1024, depth: 12, databaseBytes: 512 * 1024 * 1024 })
const LIMIT = OBSERVATION_LIMITS.entries
const ROUTE_LIMIT = 64

export function locationRoots(profile) {
  return { home: profile.home, 'claude-profile': profile.claude, 'codex-profile': profile.codex, 'opencode-profile': profile.opencode,
    'claude-skills': join(profile.claude, 'skills'), 'codex-skills': join(profile.codex, 'skills'), 'shared-skills': join(profile.home, '.agents/skills'),
    'opencode-skills': join(profile.opencode, 'skills'), 'opencode-skill': join(profile.opencode, 'skill'),
    'claude-user-config': profile.claudeJson, 'opencode-custom-config': profile.paths.OPENCODE_CONFIG ?? profile.opencode,
    'opencode-xdg': join(profile.paths.XDG_CONFIG_HOME, 'opencode'), 'opencode-managed': '/etc/opencode', filesystem: '/' }
}
export function unresolvedLocation() { return { status: 'unresolved' } }

/** Private acquisition evidence; names and link bytes never belong to a projected locator. */
export function observeRoute(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) fail('UNSUPPORTED_ROUTE')
  const nodes = []
  let current = '/'
  const remaining = path.split('/').filter(Boolean)
  nodes.push({ path: '/', name: Buffer.from(''), object: metadata('/') })
  let traversed = 0
  let missing = null
  while (remaining.length) {
    if (++traversed > ROUTE_LIMIT) exceeded()
    const name = remaining.shift()
    if (name === '.') continue
    if (name === '..') { current = dirname(current); continue }
    const next = join(current, name)
    let object
    try { object = metadata(next) } catch (error) {
      if (!absent(error)) throw error
      missing = { path: next, code: error.code }
      break
    }
    const node = { path: next, name: Buffer.from(name), object }
    if (object.type === 'link') {
      node.link = readlinkSync(next, { encoding: 'buffer' })
      const target = node.link.toString('utf8')
      if (!Buffer.from(target).equals(node.link)) fail('INVALID_ENCODING')
      node.target = optional(next, true)
      if (target.startsWith('/')) current = '/'
      remaining.unshift(...target.split('/').filter(Boolean))
    } else {
      current = next
      if (remaining.length && object.type !== 'directory') {
        missing = { path: join(next, remaining[0]), code: 'ENOTDIR' }
      }
    }
    nodes.push(node)
    if (missing) break
  }
  const observation = { nodes, ...(missing ? { missing } : {}) }
  if (!routeUnchanged(observation)) fail()
  return observation
}

/** Parent directories may gain siblings; each traversed relationship and each link stays the same. */
export function routeUnchanged(observation) {
  try {
    if (!Array.isArray(observation?.nodes) || !observation.nodes.every((node) => {
      const current = metadata(node.path)
      const directory = node.object.type === 'directory'
      if (directory ? current.type !== 'directory' || ['device', 'inode', 'mode', 'owner', 'group'].some((key) => current[key] !== node.object[key]) : !equal(current, node.object)) return false
      if (node.object.type !== 'link') return true
      if (!readlinkSync(node.path, { encoding: 'buffer' }).equals(node.link)) return false
      const target = optional(node.path, true)
      return node.target === null ? target === null : target !== null && ['device', 'inode', 'mode', 'type'].every((key) => target[key] === node.target[key])
    })) return false
    if (observation.missing) {
      try { metadata(observation.missing.path); return false } catch (error) { return error.code === observation.missing.code }
    }
    return true
  } catch { return false }
}

/** Absence retains the complete traversed frontier; access denial never establishes absence. */
export function observeAbsent(path) {
  const route = observeRoute(path)
  const observation = { path, route, outcome: route.missing?.code === 'ENOENT' ? 'absent' : route.missing?.code === 'ENOTDIR' ? 'blocked' : 'present' }
  if (!absenceUnchanged(observation)) fail()
  return observation
}
export function absenceUnchanged(observation) {
  return routeUnchanged(observation?.route) && observation.outcome ===
    (observation.route.missing?.code === 'ENOENT' ? 'absent' : observation.route.missing?.code === 'ENOTDIR' ? 'blocked' : 'present')
}

/** Never runs the program: record the execution identity and an actual access check. */
export function observeAccess(path) {
  const route = observeRoute(path)
  let outcome = false
  try { accessSync(path, constants.X_OK); outcome = metadata(path, true).type === 'file' } catch (error) {
    if (!absent(error) && !['EACCES', 'EPERM'].includes(error.code)) throw error
  }
  const observation = { path, route, outcome, uid: process.getuid(), gid: process.getgid(), groups: process.getgroups() }
  if (!accessUnchanged(observation)) fail()
  return observation
}
export function accessUnchanged(observation) {
  if (!routeUnchanged(observation?.route) || observation.uid !== process.getuid() || observation.gid !== process.getgid() ||
    JSON.stringify(observation.groups) !== JSON.stringify(process.getgroups())) return false
  try { accessSync(observation.path, constants.X_OK); return observation.outcome === (metadata(observation.path, true).type === 'file') } catch (error) {
    return observation.outcome === false && (absent(error) || ['EACCES', 'EPERM'].includes(error.code))
  }
}

/** A bracketed discovery/absence frontier; content is not read from its children. */
export function observeDirectory(path) {
  const route = observeRoute(path)
  // Discovery consumes this directory's entries, not its position among unrelated siblings.
  const object = metadata(path)
  const source = { object, ...(object.type === 'link' ? { target: optional(path, true) } : {}) }
  if ((source.target ?? source.object)?.type !== 'directory') fail('UNSUPPORTED_TYPE')
  const names = sorted(path).map((name) => {
    const text = name.toString('utf8')
    if (!Buffer.from(text).equals(name)) fail('INVALID_ENCODING')
    return text
  })
  if (!sameObject(path, source) || !routeUnchanged(route)) fail()
  return { path, names, locator: unresolvedLocation(), revisions: [{ path, snapshot: source }], routes: [route] }
}

function capture(path, roots, cache = null) {
  const parentPath = dirname(path)
  const parent = metadata(parentPath, true)
  const object = metadata(path)
  const target = object.type === 'link' ? optional(path, true) : undefined
  const names = sorted(parentPath, cache)
  const entry = names.findIndex((name) => name.equals(Buffer.from(basename(path)))) + 1
  if (!entry || !equal(parent, metadata(parentPath, true)) || !equal(object, metadata(path)) ||
    target !== undefined && !equal(target, optional(path, true))) fail()
  const root = Object.entries(roots).filter(([, folder]) => folder === path || !relative(folder, path).startsWith('..') && relative(folder, path) !== '')
    .sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? 'filesystem'
  const folder = roots[root] ?? '/'
  return { root, parent, object, entry, ...(target !== undefined ? { target } : {}), ...(path === folder ? {} : { route: route(folder, parentPath, cache) }) }
}

/** Folder identities guide bounded lookup; names and paths never leave acquisition. */
function route(root, parentPath, cache = null) {
  const steps = []
  let folder = root
  for (const name of relative(root, parentPath).split('/').filter(Boolean)) {
    const child = join(folder, name)
    const stat = metadata(child)
    if (stat.type !== 'directory' || steps.length >= ROUTE_LIMIT) return null
    const entry = sorted(folder, cache).findIndex((value) => value.equals(Buffer.from(name))) + 1
    if (!entry) fail()
    steps.push({ device: stat.device, inode: stat.inode, entry })
    folder = child
  }
  return steps
}

function sameCurrent(path, value, cache = null) {
  try {
    const parentPath = dirname(path)
    const parent = metadata(parentPath, true)
    if (!equal(parent, value.parent) || !equal(metadata(path), value.object)) return false
    const target = value.target === undefined ? undefined : optional(path, true)
    const wal = value.wal === undefined ? undefined : optional(`${path}-wal`)
    if (value.target !== undefined && !equal(target, value.target) || value.wal !== undefined && !equal(wal, value.wal) ||
      value.journalAbsent && optional(`${path}-journal`) !== null) return false
    const name = sorted(parentPath, cache)[value.entry - 1]
    return name?.equals(Buffer.from(basename(path))) === true && equal(metadata(parentPath, true), parent) &&
      equal(metadata(path), value.object) && (target === undefined || equal(target, optional(path, true))) &&
      (wal === undefined || equal(wal, optional(`${path}-wal`))) && (!value.journalAbsent || optional(`${path}-journal`) === null)
  } catch { return false }
}
const publish = (value, witnesses = []) => ({ status: 'located', acquisition: 2, ...value, witnesses })

/** Read once through a verified descriptor. Every byte belongs to the revision captured before opening. */
export function observeFile(path, roots, { maxBytes = 1024 * 1024, expected = null, binary = false, routeObservation = null, directoryCache = null } = {}) {
  let descriptor
  // A complete tree already observes every intervening directory and brackets its root route.
  const route = routeObservation ?? observeRoute(path)
  const source = expected ?? capture(path, roots, directoryCache)
  try {
    if (!sameCurrent(path, source, directoryCache)) fail()
    const expectedFile = source.target ?? source.object
    if (expectedFile.type !== 'file') fail('UNSUPPORTED_TYPE')
    if (Number(expectedFile.size) > maxBytes) exceeded('file')
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    if (!equal(record(fstatSync(descriptor, { bigint: true })), expectedFile)) fail()
    const bytes = Buffer.alloc(Number(expectedFile.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) fail()
      offset += count
    }
    if (!equal(record(fstatSync(descriptor, { bigint: true })), expectedFile) || !sameCurrent(path, source, directoryCache)) fail()
    const text = bytes.toString('utf8')
    if (!binary && !Buffer.from(text).equals(bytes)) fail('INVALID_ENCODING')
    if (!routeUnchanged(route)) fail()
    return { path, bytes, text, locator: publish(source), revisions: [{ path, snapshot: source }], routes: [route] }
  } finally { if (descriptor !== undefined) closeSync(descriptor) }
}

/** A link remains the item; followed bytes and every contributing child get separate flat numeric witnesses. */
export function observeTree(path, roots) {
  const routes = [observeRoute(path)]
  const cache = new Map()
  const source = capture(path, roots, cache)
  const dependencies = []
  const files = new Map()
  const directories = new Map()
  const entries = []
  let total = 0
  let link = null
  if (source.object.type === 'link') link = readlinkSync(path)
  const body = source.object.type === 'link' && source.target !== null ? realpathSync(path) : path
  const walk = (current, name, depth) => {
    if (dependencies.length >= LIMIT || depth > OBSERVATION_LIMITS.depth) exceeded()
    const snapshot = capture(current, roots, cache)
    dependencies.push({ path: current, snapshot })
    if (snapshot.object.type === 'file') {
      const observed = observeFile(current, roots, { expected: snapshot, binary: true, maxBytes: OBSERVATION_LIMITS.treeBytes - total,
        routeObservation: routes[0], directoryCache: cache })
      total += observed.bytes.length
      if (total > OBSERVATION_LIMITS.treeBytes) exceeded()
      files.set(name, observed.bytes)
      entries.push([name, 'file', snapshot.object.mode, createHash('sha256').update(observed.bytes).digest('hex')])
    } else if (snapshot.object.type === 'directory') {
      const names = sorted(current, cache).map((entry) => {
        const text = entry.toString('utf8')
        if (!Buffer.from(text).equals(entry)) fail('INVALID_ENCODING')
        return text
      })
      if (!sameCurrent(current, snapshot, cache)) fail()
      directories.set(name, names)
      entries.push([name, 'directory', snapshot.object.mode])
      for (const child of names) walk(join(current, child), name ? `${name}/${child}` : child, depth + 1)
    } else if (snapshot.object.type === 'link') {
      const target = readlinkSync(current)
      if (!sameCurrent(current, snapshot, cache)) fail()
      entries.push([name, 'link', target])
    } else fail('UNSUPPORTED_TYPE')
  }
  if (source.object.type !== 'link' || source.target !== null) walk(body, '', 0)
  if (!sameCurrent(path, source, cache) || dependencies.some((item) => !sameCurrent(item.path, item.snapshot, cache)) || routes.some((route) => !routeUnchanged(route))) fail()
  return { path, body, link, kind: source.object.type, missingTarget: source.object.type === 'link' && source.target === null,
    files, directories, hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    locator: publish(source, dependencies.map((item) => item.snapshot)), revisions: [{ path, snapshot: source }, ...dependencies], routes }
}

/** Both DBs, WAL lifecycle and rollback-journal absence are one source vector, captured before any copy. */
export function observeDatabases(paths, roots) {
  const failures = []
  const attempt = (path, read) => {
    try { return read() } catch (error) { failures.push({ observationPath: path, code: error.code ?? 'UNSUPPORTED' }); return null }
  }
  const reject = () => { if (failures.length) throw Object.assign(new Error('database observation unavailable'), { observationFailures: failures }) }
  const vector = paths.map((path) => attempt(path, () => {
    const source = optional(path)
    if (source === null) return { path, source: null, parent: metadata(dirname(path), true) }
    const snapshot = { ...capture(path, roots), wal: optional(`${path}-wal`), journalAbsent: true }
    if (optional(`${path}-journal`) !== null) fail('JOURNAL_PRESENT')
    const wal = snapshot.wal === null ? null : capture(`${path}-wal`, roots)
    // Inspect every component's bound before allocating a copy. One DB and its WAL are one input.
    if ([snapshot, wal].some((value) => value && Number((value.target ?? value.object).size) > OBSERVATION_LIMITS.databaseBytes)) exceeded()
    return { path, source: snapshot, wal }
  }))
  reject()
  const observations = vector.map((item) => attempt(item.path, () => {
    if (item.source === null) return null
    const database = observeFile(item.path, roots, { expected: item.source, maxBytes: OBSERVATION_LIMITS.databaseBytes, binary: true })
    if (database.bytes.subarray(0, 16).toString('hex') !== '53514c69746520666f726d6174203300' ||
      ![1, 2].includes(database.bytes[18]) || database.bytes[18] !== database.bytes[19]) fail('INVALID_FORMAT')
    const wal = item.wal === null ? null : observeFile(`${item.path}-wal`, roots, { expected: item.wal, maxBytes: OBSERVATION_LIMITS.databaseBytes, binary: true })
    return { ...database, walBytes: wal?.bytes ?? null, routes: [...database.routes, ...(wal?.routes ?? [])] }
  }))
  reject()
  for (const item of vector) attempt(item.path, () => {
    if (item.source === null ? optional(item.path) !== null || !equal(metadata(dirname(item.path), true), item.parent)
      : !sameCurrent(item.path, item.source) || item.wal !== null && !sameCurrent(`${item.path}-wal`, item.wal)) fail()
  })
  reject()
  const dependencies = vector.filter((item) => item.source !== null).map((item) => item.source)
  const parts = vector.map((item, i) => ({ path: item.path,
    revisions: [{ path: item.path, snapshot: item.source }, ...(item.wal ? [{ path: `${item.path}-wal`, snapshot: item.wal }] : [])],
    routes: observations[i]?.routes ?? [] }))
  const revisions = parts.flatMap((part) => part.revisions), routes = parts.flatMap((part) => part.routes)
  return Object.assign(observations.map((item) => item === null ? null : { ...item,
    locator: { ...item.locator, witnesses: dependencies }, revisions, routes }), { parts })
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
  return Array.isArray(observation?.revisions) && (observation.routes ?? []).every(routeUnchanged) && observation.revisions.every(({ path, snapshot }) => {
    try { return snapshot === null ? optional(path) === null : sameObject(path, snapshot) } catch { return false }
  })
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
  if (value.route !== undefined) {
    if (!Array.isArray(value.route) || value.route.length > ROUTE_LIMIT ||
      value.route.some((step) => !step || !numeric(step.device) || !numeric(step.inode) || !integer(step.entry))) return null
    out.route = value.route.map((step) => ({ device: step.device, inode: step.inode, entry: step.entry }))
  }
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
  if (value.status === 'unresolved') return unresolvedLocation()
  if (value.acquisition === 4) {
    const identity = (v) => v && numeric(v.device) && numeric(v.inode) ? { device: v.device, inode: v.inode } : null
    const parent = identity(value.parent), object = identity(value.object)
    if (!LOCATION_ROOTS.includes(value.root) || !parent || !object || !integer(value.entry) ||
      value.route !== undefined && (!Array.isArray(value.route) || value.route.length > ROUTE_LIMIT || value.route.some((step) => !identity(step) || !integer(step.entry))) ||
      (value.line !== undefined || value.column !== undefined) && (!integer(value.line) || !integer(value.column)) ||
      value.rowid !== undefined && !integer(value.rowid)) return null
    return { status: value.status, acquisition: 4, root: value.root, parent, object, entry: value.entry,
      ...(value.route !== undefined ? { route: value.route.map((step) => ({ ...identity(step), entry: step.entry })) } : {}),
      ...(value.line !== undefined ? { line: value.line, column: value.column } : {}), ...(value.rowid !== undefined ? { rowid: value.rowid } : {}) }
  }
  if (value.acquisition !== 2) return unresolvedLocation()
  const source = validSource(value)
  if (!source || !Array.isArray(value.witnesses) || value.witnesses.length > LIMIT) return null
  const witnesses = value.witnesses.map(validSource)
  if (witnesses.some((item) => item === null)) return null
  if ((value.line !== undefined || value.column !== undefined) && (!integer(value.line) || !integer(value.column))) return null
  if (value.rowid !== undefined && (!integer(value.rowid) || value.wal === undefined || value.journalAbsent !== true)) return null
  return { status: value.status, acquisition: 2, ...source, witnesses,
    ...(value.line !== undefined ? { line: value.line, column: value.column } : {}), ...(value.rowid !== undefined ? { rowid: value.rowid } : {}) }
}

export function locationText(value) {
  const locator = validateLocation(value)
  if (!locator || locator.status === 'unresolved') return 'Identity withheld · location unavailable'
  if (locator.acquisition === 4) return `${locator.status === 'stale' ? 'Stale location' : 'Identity withheld'} · ${locator.root}` +
    ` · device ${locator.object.device}, inode ${locator.object.inode} · parent ${locator.parent.inode}, entry ${locator.entry}` +
    (locator.line ? ` · line ${locator.line}, column ${locator.column}` : '') + (locator.rowid ? ` · stage1_outputs rowid ${locator.rowid}` : '') +
    ` · route ${JSON.stringify(locator.route ?? [])}`
  return `${locator.status === 'stale' ? 'Stale location' : 'Identity withheld'} · ${locator.root} · device ${locator.object.device}, inode ${locator.object.inode} · parent ${locator.parent.inode}, entry ${locator.entry}` +
    (locator.line ? ` · line ${locator.line}, column ${locator.column}` : '') + (locator.rowid ? ` · stage1_outputs rowid ${locator.rowid}` : '') +
    ` · object revision ${locator.object.size}/${locator.object.modified}/${locator.object.changed} · parent revision ${locator.parent.device}/${locator.parent.size}/${locator.parent.modified}/${locator.parent.changed}` +
    ` · route ${JSON.stringify(locator.route ?? [])} · ${locator.witnesses.length} dependency revisions`
}
export const LOCATION_HELP = 'Names are withheld, even ordinary names. Resolve the selected root from its app profile selectors. Follow the numeric route by folder device and inode, then match the parent and item device/inode. Entry numbers are one-based hints in raw UTF-8 byte order; unrelated siblings may move them. Configuration entries use one-based line and UTF-16 column; Codex memory uses stage1_outputs numeric rowid. BMN checks the item and its reason again before showing a current location. Changed, replaced, ambiguous or unverifiable items have stale or unavailable locations; check again. Older saved locations need a new check. BMN leaves every item.'
