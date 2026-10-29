// MODULE: doctor-inspection.mjs - Bounded per-input acquisition and private per-row reconstruction evidence
import { randomBytes } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { observeAbsent, observeAccess, observeDatabases, observeDirectory, observeFile, observeTree,
  absenceUnchanged, accessUnchanged, unchangedSince, locationRoots } from './doctor-locations.mjs'
import { privateTag, validWorkerKeys } from './doctor-continuity.mjs'
import { validateLocation } from './doctor-locations.mjs'

const identity = (value) => value === null ? null : Object.fromEntries(['device', 'inode', 'mode', 'owner', 'group', 'type'].map((k) => [k, value[k] ?? null]))
// Only the real inspection worker supplies this view. Host callers retain every inode.
export function privateTmpfsView() {
  try {
    if (process.cwd() !== '/tmp/bmn-doctor-work') return null
    const mounts = readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line => {
      const [before, after] = line.split(' - '), fields = before.split(' ')
      return { path: fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))),
        options: fields[5].split(','), type: after.split(' ')[0] }
    })
    const mountAt = path => mounts.findLast(mount => mount.path === path)
    if (!mountAt('/')?.options.includes('ro')) return null
    return ['/tmp', '/var/tmp'].map(path => {
      const object = lstatSync(path)
      if (!object.isDirectory() || mountAt(path)?.type !== 'tmpfs' || object.dev === lstatSync(dirname(path)).dev) throw new Error('not private')
      return { path, device: String(object.dev) }
    })
  } catch { return null }
}

const routeValue = (route, leaf = 'identity', privateTmpfs = null) => route ? [route.nodes.map((node, i) => [node.name,
  // Namespace scaffolding is stable policy; restored bind roots keep their real devices.
  node.object.type === 'directory' && privateTmpfs?.some(root => node.object.device === root.device &&
    (node.path === root.path || node.path.startsWith(root.path + '/'))) ? ['private-tmpfs', node.path] :
    node.object.type === 'link' || leaf === 'full' && i === route.nodes.length - 1 ? node.object : identity(node.object),
  node.link ?? null, node.target === undefined ? null : identity(node.target)]), route.missing ? [route.missing.path, route.missing.code] : null] : null
const ordered = (values) => [...values].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
const treeValue = (value, privateTmpfs) => [routeValue(value.routes?.[0], 'identity', privateTmpfs), value.revisions.map(({ path, snapshot }) =>
  [path, snapshot?.object ?? null, snapshot?.target ?? null]), ordered(value.files.keys()).map((name) => [name, value.files.get(name)]),
  ordered(value.directories.keys()).map((name) => [name, value.directories.get(name)]), value.link]

export function createInspectionSession(profile, suppliedKeys, deadline, privateTmpfs = null) {
  const keys = suppliedKeys ?? { item: randomBytes(32).toString('hex'), context: randomBytes(32).toString('hex') }
  if (!validWorkerKeys(keys)) throw new Error('continuity unavailable')
  const roots = locationRoots(profile), inputs = new Map(), gaps = new Map(), rows = [], acquisitionChanged = new Set()
  const guard = () => { if (Date.now() >= deadline) throw Object.assign(new Error('inspection bound'), { code: 'TIME_BOUND' }) }
  const gap = (input, kind, error, phase = 'acquire') => {
    if (Array.isArray(error?.observationFailures)) {
      return error.observationFailures.flatMap((failure) => gap(input, kind, failure, phase) ?? [])
    }
    const cause = error?.code ?? 'UNSUPPORTED'
    if (kind === 'cache-tree' && cause === 'BOUND_EXCEEDED') return
    const category = cause === 'BOUND_EXCEEDED' ? kind === 'database' ? 'database-bound' : kind === 'tree' ? 'folder-bound'
      : kind === 'file' && error?.bound === 'file' ? 'file-bound' : 'step'
      : cause === 'SOURCE_CHANGED' ? 'source-changed' : cause === 'TIME_BOUND' || kind === 'step' ? 'step' : 'unreadable'
    // Reading and inspecting the same entry are operations on one input, rather than two gaps.
    const target = cause === 'TIME_BOUND' ? 'inspection-deadline' : error?.observationPath ?? String(input).replace(/^(?:meta|file|directory|tree|cache-tree|access|database):/, '')
    const targets = error?.observationPaths ?? [kind === 'database' ? target.replace(/-(?:wal|journal)$/, '') : target]
    for (const input of targets) gaps.set(`${category}:${input}`, { input, category, phase,
      cause: ['BOUND_EXCEEDED', 'SOURCE_CHANGED', 'TIME_BOUND', 'EACCES', 'EPERM', 'INVALID_ENCODING', 'INVALID_FORMAT', 'JOURNAL_PRESENT',
        'UNSUPPORTED_TYPE', 'UNSUPPORTED_ROUTE', 'MALFORMED', 'UNSUPPORTED'].includes(cause) ? cause : 'UNSUPPORTED' })
    return targets.map((input) => `${category}:${input}`)
  }
  const probe = (kind, path, acquire, stable) => {
    guard()
    const key = `${kind}:${path}`
    if (inputs.has(key)) return inputs.get(key)
    if (inputs.size >= 10000) { gap('input-budget', 'step', { code: 'BOUND_EXCEEDED' }); return { key, known: false, value: null, stable: () => false } }
    let source
    try { const value = acquire(); source = { key, path, kind, known: true, value, stable: () => stable(value, source) } }
    catch (error) {
      const failureGaps = gap(key, kind, error) ?? []
      if (failureGaps.some((key) => gaps.get(key)?.cause === 'SOURCE_CHANGED')) acquisitionChanged.add(key)
      source = { key, path, kind, known: false, value: null, failureGaps,
        bound: kind === 'cache-tree' && error?.code === 'BOUND_EXCEEDED' && failureGaps.length === 0, stable: () => false }
    }
    inputs.set(key, source)
    return source
  }
  const meta = (path) => probe('meta', path, () => observeAbsent(path), absenceUnchanged)
  const file = (path) => probe('file', path, () => {
    const frontier = observeAbsent(path)
    return frontier.outcome === 'present' ? { observation: observeFile(path, roots), frontier } : { observation: null, frontier }
  }, (value) => absenceUnchanged(value.frontier) && (value.observation === null || unchangedSince(value.observation)))
  const directory = (path) => probe('directory', path, () => {
    const frontier = observeAbsent(path)
    return frontier.outcome === 'present' ? { observation: observeDirectory(path), frontier } : { observation: null, frontier }
  }, (value) => absenceUnchanged(value.frontier) && (value.observation === null || unchangedSince(value.observation)))
  const tree = (path, { locationOnly = false } = {}) => probe(locationOnly ? 'cache-tree' : 'tree', path, () => observeTree(path, roots), unchangedSince)
  const access = (path) => probe('access', path, () => observeAccess(path), accessUnchanged)
  const databases = (paths) => {
    const source = probe('database', paths.join('\0'), () => observeDatabases(paths, roots), (values, source) => {
    const parts = values.parts
    const complete = Array.isArray(parts) && parts.length === paths.length && parts.every((part, i) =>
      part?.path === paths[i] && Array.isArray(part.revisions) && part.revisions.length > 0 && Array.isArray(part.routes))
    source.changedPaths = complete ? parts.filter((part) => !unchangedSince(part)).map((part) => part.path) : [...paths]
    return source.changedPaths.length === 0
    })
    source.physicalPaths = paths
    return source
  }
  const dir = (source) => source?.known && source.value?.outcome === 'present' && source.value.route.nodes.at(-1)?.object.type === 'directory'
  const exists = (source) => source?.known && source.value?.outcome === 'present'
  const names = (source) => source?.known ? source.value.observation?.names ?? [] : []
  const text = (source) => source?.known ? source.value.observation?.text ?? null : null
  // Some inputs witness a collective membership predicate without contributing their unrelated identities.
  const dep = (source, projection = null, { witnessOnly = false } = {}) => ({ source, projection, witnessOnly })
  const json = (source) => {
    const body = text(source)
    if (body === null) return source?.known ? {} : null
    try {
      const value = JSON.parse(body)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      return value
    } catch { gap(source.key, 'file', { code: 'MALFORMED' }); return null }
  }
  const tuple = (source, mode = 'semantic') => {
    if (!source?.known) return null
    if (source.kind === 'tree' || source.kind === 'cache-tree') return treeValue(source.value, privateTmpfs)
    if (source.kind === 'file') return source.value.observation ? [routeValue(source.value.observation.routes?.[0], mode === 'item' ? 'full' : 'identity', privateTmpfs),
      mode === 'item' ? source.value.observation.bytes : null] : routeValue(source.value.frontier.route, 'identity', privateTmpfs)
    if (source.kind === 'directory') return routeValue(source.value.frontier.route, 'identity', privateTmpfs)
    if (source.kind === 'database') return source.value.map((value) => value === null ? null : [value.path, identity(value.locator.object),
      value.locator.target ? identity(value.locator.target) : null, routeValue(value.routes?.find((r) => r.nodes.some((n) => n.path === value.path)), 'identity', privateTmpfs)])
    return [routeValue(source.value.route, 'identity', privateTmpfs), source.kind === 'access' ? [source.value.outcome, source.value.uid, source.value.gid, source.value.groups] : source.value.outcome]
  }
  const locator = (source, { start = null, rowid = null, databaseIndex = 0 } = {}) => {
    const observation = ['tree', 'cache-tree'].includes(source?.kind) ? source.value : source?.kind === 'database' ? source.value?.[databaseIndex] : source?.value?.observation
    const value = observation?.locator
    if (!value || value.status !== 'located' || value.route === null) return { status: 'unresolved' }
    const out = { status: 'located', acquisition: 4, root: value.root,
      parent: { device: value.parent.device, inode: value.parent.inode }, object: { device: value.object.device, inode: value.object.inode },
      entry: value.entry, ...(value.route !== undefined ? { route: value.route } : {}) }
    if (start !== null) {
      if (!Number.isSafeInteger(start) || start < 0 || typeof observation.text !== 'string' || start >= observation.text.length) return { status: 'unresolved' }
      out.line = observation.text.slice(0, start).split('\n').length; out.column = start - observation.text.lastIndexOf('\n', start - 1)
    }
    if (rowid !== null) out.rowid = rowid
    return validateLocation(out) ?? { status: 'unresolved' }
  }
  const row = (kind, app, reason, itemSource, itemValue, dependencies = [], coordinates = {}) => {
    guard()
    const entryIdentity = coordinates.identity === 'mcp-entry'
    if (entryIdentity && (kind !== 'mcp' || itemSource?.kind !== 'file' || !itemSource.known || !itemSource.value.observation)) throw new Error('invalid entry identity')
    if (rows.length >= 10000) { gap('row-budget', 'step', { code: 'BOUND_EXCEEDED' }); return }
    const sources = [...new Set([itemSource, ...dependencies.map((d) => d.source)].filter(Boolean))]
    const snapshots = itemSource?.kind === 'database' ? itemSource.value?.map((v) => v?.locator).filter(Boolean) :
      itemSource?.value?.revisions?.map((v) => v.snapshot) ?? [itemSource?.value?.observation?.locator].filter(Boolean)
    const unambiguous = snapshots?.every((v) => [v?.object, v?.target].every((stat) => !stat || stat.type !== 'file' || stat.links === '1'))
    // A fully observed reason may have no unique coordinate. That is a location-only refusal,
    // not missing reason coverage (owner's R86-FR3 exception).
    const complete = itemSource?.known && sources.every((s) => s.known) && dependencies.every((d) => d.source?.known && d.projection !== undefined)
    for (const dependency of dependencies.filter((d) => !d.source || d.source.known && d.projection === undefined)) {
      const input = dependency.source?.path ?? 'reason-witness'
      if (![...gaps.values()].some((gap) => gap.input === input)) gap(input, 'step', { code: 'UNSUPPORTED' }, 'scan')
    }
    const item = rows.length + 1
    const managed = app === 'opencode' && ['plugins', 'mcp'].includes(kind) && profile.opencodeManagedFiles.includes(itemSource?.path)
    const value = { kind, app, reason, item, identity: 'withheld', ...(managed ? { source: 'managed' } : {}), locator: complete && unambiguous ? locator(itemSource, coordinates) : { status: 'unresolved' } }
    // Parsed MCP entries carry their complete value separately; unrelated file bytes are not that item.
    const receipt = complete ? { item, itemTag: privateTag(keys.item, 'item', [kind, app, tuple(itemSource, entryIdentity ? 'semantic' : 'item'), itemValue]),
      contextTag: privateTag(keys.context, 'context', [kind, app, reason, dependencies.filter((d) => !d.witnessOnly).map((d) => [tuple(d.source), d.projection])]) } : null
    const reasonTag = !complete && itemSource?.bound && sources.every((source) => source === itemSource || source.known) &&
      dependencies.every((dependency) => dependency.source?.known && dependency.projection !== undefined)
      ? privateTag(keys.context, 'location-only-reason', [kind, app, reason, itemSource.path, itemValue,
        dependencies.filter((dependency) => !dependency.witnessOnly).map((dependency) => [tuple(dependency.source), dependency.projection])]) : null
    rows.push({ value, receipt, reasonTag, sources, itemPath: itemSource?.kind === 'database' ? itemSource.value?.[coordinates.databaseIndex ?? 0]?.path : itemSource?.path })
  }
  const finish = () => {
    const unstable = new Set(), unverified = new Set()
    let timedOut = Date.now() >= deadline || [...gaps.values()].some((gap) => gap.cause === 'TIME_BOUND')
    for (const source of inputs.values()) if (source.known) {
      if (timedOut || Date.now() >= deadline) { timedOut = true; unstable.add(source.key); unverified.add(source.key) }
      else if (!source.stable()) unstable.add(source.key)
    }
    if (timedOut) gap('inspection-deadline', 'step', { code: 'TIME_BOUND' }, 'revalidate')
    for (const row of rows) if (!row.receipt || row.sources.some((s) => !s.known || unstable.has(s.key))) row.value.locator = { status: 'unresolved' }
    return { rows, gaps, unstable, unverified, acquisitionChanged, inputs, gap, timedOut }
  }
  return { roots, keys, guard, gap, probe, meta, file, directory, tree, access, databases, dir, exists, names, text, json, dep, tuple, locator, row, finish }
}

/** Fixed projections only. Distinct-input union counts do not multiply by affected rows. */
export function inspectionResult(rows, gaps) {
  const categories = new Map()
  for (const gap of gaps.values()) {
    const set = categories.get(gap.category) ?? new Set(); set.add(gap.input); categories.set(gap.category, set)
  }
  const codes = { 'file-bound': 'leftover-file-bound', 'folder-bound': 'leftover-folder-bound', 'database-bound': 'leftover-database-bound', 'source-changed': 'leftover-source-changed', unreadable: 'leftover-unreadable', step: 'leftover-step' }
  const problems = [...categories].map(([category, inputs], i) => ({ code: codes[category], item: i + 1, count: Math.min(10000, inputs.size) }))
  const result = { state: problems.length ? 'partial' : 'passed', problems, leftovers: rows.map((r) => r.value) }
  if (Buffer.byteLength(JSON.stringify(result)) > 896 * 1024) {
    const existing = problems.find((p) => p.code === 'leftover-step')
    if (existing) existing.count = Math.min(10000, existing.count + 1)
    else problems.push({ code: 'leftover-step', item: problems.length + 1, count: 1 })
    return { state: 'partial', problems, leftovers: [] }
  }
  return result
}
