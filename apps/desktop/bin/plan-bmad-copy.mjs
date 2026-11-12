// MODULE: plan-bmad-copy.mjs - guarded BMAD copies and D25 two-way sync with recoverable journals
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { PlanError, ROW, rowToken } from './plan-board.mjs'
import { addToQueue, lockBoard, setRow } from './plan-cli.mjs'
import { migrationPaths } from './plan-migration-lock.mjs'
import { FROM_BMAD, TO_BMAD } from './plan-statuses.mjs'
import { verifyParserProof } from './plan-bmad-parser.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const same = (one, two) => JSON.stringify(one) === JSON.stringify(two)
const own = (map, key) => Object.hasOwn(map, key) ? map[key] : null
const load = path => JSON.parse(readFileSync(path, 'utf8'))
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
    load(path)
  } finally { rmSync(temporary, { force: true }) }
}
export function isCopiedPlan(plan) { return plan.format === 'bmn-plan' && /^bmad_copy:[ \t]*true[ \t]*(?:#.*)?$/mu.test(readFileSync(plan.boardPath, 'utf8')) }
function sourceBoard(plan) {
  const header = readFileSync(plan.boardPath, 'utf8'), board = /^bmad_board:[ \t]*['"]?([^\s'"#]+)['"]?[ \t]*(?:#.*)?$/mu.exec(header)?.[1]
  if (!board) throw new PlanError('COPY_UNREADABLE', 'bmad_copy requires bmad_board')
  return board
}
function locations(plan) {
  const board = sourceBoard(plan)
  const target = resolve(plan.boardCheckout, board), rel = relative(realpathSync(plan.boardCheckout), realpathSync(target))
  if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep)) throw new PlanError('COPY_OUTSIDE', 'the copy target leaves the project')
  const record = join(plan.planRoot, 'bmad-copy.json'), folder = join(migrationPaths(plan.boardCheckout).common, 'bmn-plan-copy', hash(realpathSync(plan.boardPath)).slice(0, 20))
  return { repo: plan.boardCheckout, source: plan.boardPath, target, record, folder, sourceBoard: board }
}
function readMetadata(record, board) {
  let value
  try { value = load(record) } catch { throw new PlanError('COPY_UNREADABLE', 'the tracked bmad-copy.json cannot be read') }
  if (![1, 2].includes(value.version) || value.source_board !== board || !value.rows || !value.excluded || !value.unresolved) throw new PlanError('COPY_UNREADABLE', 'invalid bmad-copy.json version, source or row maps')
  for (const name of ['rows', 'excluded', 'unresolved']) if (typeof value[name] !== 'object' || Array.isArray(value[name])) throw new PlanError('COPY_UNREADABLE', `invalid ${name} row map`)
  for (const [key, entry] of Object.entries(value.rows)) {
    const absent = value.version === 2 && entry?.last_copied === null && entry?.source_value === null && entry?.source_token === null
    if (!/^[\w.-]+$/u.test(key) || !entry || (!absent && (!Object.hasOwn(FROM_BMAD, entry.last_copied?.status) || typeof entry.last_copied?.note !== 'string' || /[\r\n]/u.test(entry.last_copied.note) || !/^[0-9a-f]{16}$/u.test(entry.source_token)))) throw new PlanError('COPY_UNREADABLE', `invalid copy baseline for ${key}`)
    if (value.version === 2 && !absent && (!Object.hasOwn(TO_BMAD, entry.source_value?.status) || typeof entry.source_value?.note !== 'string' || [...entry.source_value.note].length > 160 || /[\r\n]/u.test(entry.source_value.note) || entry.source_token !== token(key, entry.source_value))) throw new PlanError('COPY_UNREADABLE', `invalid sync projection for ${key}`)
    if (entry.note_projection && (typeof entry.note_projection.raw !== 'string' || typeof entry.note_projection.visible !== 'string' || /[\r\n]/u.test(entry.note_projection.raw + entry.note_projection.visible) || [...entry.note_projection.visible].length > 160)) throw new PlanError('COPY_UNREADABLE', `invalid note projection for ${key}`)
  }
  if (value.version === 2 && (!value.holds || typeof value.holds !== 'object' || Array.isArray(value.holds) || Object.keys(value.excluded).length || Object.keys(value.unresolved).length)) throw new PlanError('COPY_UNREADABLE', 'two-way sync requires all rows and a hold map')
  return value
}
function metadata(loc) {
  const value = readMetadata(loc.record, loc.sourceBoard)
  if (value.active !== false) verifyParserProof(loc.repo, value.parser_preparation)
  return value
}
function rows(path) {
  const result = new Map(); let section = false
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/u, '')
    if (/^\S/u.test(line) && !line.startsWith('#')) section = /^development_status:/u.test(line)
    const row = section && ROW.exec(line)
    if (!row) continue
    if (result.has(row[1])) throw new PlanError('COPY_DUPLICATE', `duplicate copied row ${row[1]} in ${path}`)
    result.set(row[1], { status: row[2], note: row[3] ?? '' })
  }
  return result
}
const token = (key, value) => value ? rowToken(key, value.status, value.note) : null
const epicOf = key => /^(?:epic-)?(\d+)(?:[-.]|$)/u.exec(key)?.[1] ?? key
const goTokens = row => JSON.stringify([...new Set(row?.note.match(/\bgo \d{4}-\d{2}-\d{2}\b/gu) ?? [])].sort())
const withdrawn = row => !row || ['backlog', 'dropped', 'withdrawn', 'superseded', 'skipped'].includes(row.status)
const progress = new Map([['backlog', 0], ['ready', 1], ['in-progress', 2], ['review', 3], ['done', 4], ['paused', 5], ['blocked', 6], ['dropped', 7]])
const projected = row => row ? { status: FROM_BMAD[row.status], note: [...row.note].slice(0, 160).join('') } : null
export const fullCopyNote = (entry, row) => !row ? undefined : row.note === entry?.note_projection?.visible ? entry.note_projection.raw : row.note === entry?.source_value?.note ? entry.last_copied?.note ?? row.note : row.note

/** Read-only authority preflight, also used by status/run_needs before a sync has persisted its holds. */
function syncHolds(loc, meta) {
  const holds = { ...meta.holds }, source = rows(loc.source), target = rows(loc.target)
  for (const key of new Set([...source.keys(), ...target.keys(), ...Object.keys(meta.rows)])) {
    const before = meta.rows[key], plan = source.get(key) ?? null, bmad = target.get(key) ?? null
    const fullPlan = plan ? { ...plan, note: fullCopyNote(before, plan) } : null
    const missing = before?.last_copied && (!plan || !bmad)
    const approval = /^epic-\d+$/u.test(key) && (
      goTokens(fullPlan) !== goTokens(bmad) ||
      (goTokens(before?.last_copied) !== '[]' && !withdrawn(before.last_copied) && (withdrawn(plan) || withdrawn(bmad))) ||
      (goTokens(fullPlan) !== '[]' && withdrawn(plan) !== withdrawn(bmad)))
    if (missing || approval) {
      const id = epicOf(key)
      holds[id] ??= { code: approval ? 'COPY_APPROVAL_HOLD' : 'COPY_ROW_MISSING', key, plan, bmad, baseline: before ?? null, reason: approval ? 'go or withdrawal differs; resolve this epic explicitly before syncing either board' : 'a baselined row was deleted; preserve both boards until its deletion is resolved' }
    }
  }
  return holds
}
export function copyAuthorityState(plan) {
  if (!isCopiedPlan(plan)) return { conflicts: [], conflict_values: [] }
  const loc = locations(plan), meta = readMetadata(loc.record, loc.sourceBoard)
  if (meta.version !== 2 || meta.active === false) return { conflicts: [], conflict_values: [] }
  const holds = syncHolds(loc, meta)
  return { conflicts: Object.keys(holds).filter(key => /^\d+$/u.test(key)).map(Number), conflict_values: Object.values(holds) }
}

/** Appends are journalled as an absent row, with the same row token fence as replacements. */
async function writeSyncRow(path, key, value, before, environment) {
  if (before) return await setRow(path, { key, ...value, expect: token(key, before), locked: true, environment })
  const text = readFileSync(path, 'utf8')
  if (rows(path).has(key)) failure('COPY_SOURCE_CHANGED', `${key} appeared before its append`, key)
  const lines = text.split('\n'), start = lines.findIndex(line => /^development_status:/u.test(line))
  if (start < 0) failure('COPY_UNREADABLE', 'no development_status section for append', key)
  let end = start + 1
  while (end < lines.length && (!/^\S/u.test(lines[end]) || lines[end].startsWith('#'))) end++
  while (end > start + 1 && lines[end - 1] === '') end--
  const cr = lines[start].endsWith('\r') ? '\r' : ''
  lines.splice(end, 0, `  ${key}: ${value.status}${value.note ? ` # ${value.note}` : ''}${cr}`)
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, lines.join('\n'), { mode: statSync(path).mode & 0o777 })
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
    if (readFileSync(path, 'utf8') !== text) failure('COPY_SOURCE_CHANGED', `board changed before appending ${key}`, key)
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
  return { outcome: 'changed', token: token(key, value) }
}
// The row journal remains pending until its queue invariant is restored. Recovery
// recomputes this idempotently from the current row, retaining unrelated queue order.
function syncQueue(path, key, row) {
  if (!/^epic-\d+$/u.test(key) || !row || !['ready', 'done', 'dropped'].includes(row.status)) return
  const before = readFileSync(path, 'utf8'), epic = Number(key.slice(5))
  let after
  if (row.status === 'ready') {
    after = addToQueue(before, epic)
    if (after === null) failure('COPY_QUEUE_FORM', 'the canonical queue must be a block list', key)
  } else {
    const lines = before.split('\n'), at = lines.findIndex(line => /^queue:/u.test(line))
    if (at < 0) failure('COPY_QUEUE_FORM', 'the canonical queue is missing', key)
    for (let index = at + 1; index < lines.length; index++) {
      if (/^\S/u.test(lines[index]) && !lines[index].startsWith('#')) break
      const item = /^[ \t]+-[ \t]+['"]?(?:epic-)?(\d+)['"]?[ \t]*(?:#.*)?\r?$/u.exec(lines[index])
      if (item && Number(item[1]) === epic) { lines.splice(index, 1); index-- }
    }
    after = lines.join('\n')
  }
  if (after === before) return
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, after, { mode: statSync(path).mode & 0o777 })
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
    if (readFileSync(path, 'utf8') !== before) failure('COPY_SOURCE_CHANGED', 'canonical board changed before queue maintenance', key)
    renameSync(temporary, path)
    if (readFileSync(path, 'utf8') !== after) failure('COPY_SOURCE_CHANGED', 'canonical queue changed after replacement', key)
  } finally { rmSync(temporary, { force: true }) }
}
const journalPath = (loc, key) => join(loc.folder, hash(key) + '.json')
const journal = (loc, key) => existsSync(journalPath(loc, key)) ? load(journalPath(loc, key)) : null
function combinedToken(loc, key, meta) {
  return hash(JSON.stringify([realpathSync(loc.source), realpathSync(loc.target), key, rows(loc.source).get(key) ?? null, rows(loc.target).get(key) ?? null, own(meta.rows, key), own(meta.excluded, key), own(meta.unresolved, key), journal(loc, key)])).slice(0, 24)
}
async function locked(plan, operation) {
  const loc = locations(plan), releases = []
  try {
    for (const path of [loc.source, loc.target, loc.record].sort()) releases.push(await lockBoard(path))
    return await operation(loc)
  } finally { for (const release of releases.reverse()) release() }
}
function protectedRow(meta, key) {
  if (meta.active === false) throw new PlanError('COPY_NOT_ACTIVE', 'this is a staged copy record; complete verified cutover before writing a copy')
  if (Object.hasOwn(meta.unresolved, key)) throw new PlanError('COPY_PROVENANCE_REQUIRED', `${key} has unresolved move-time writer provenance; the copy cannot be activated`)
  return Object.hasOwn(meta.excluded, key) || !Object.hasOwn(meta.rows, key)
}
function failure(code, message, key) { throw Object.assign(new PlanError(code, message), { key }) }
async function phase(loc, state, name, seam) { state.phase = name; atomic(journalPath(loc, state.key), state); await seam(name, state) }
function authority(plan, state) {
  if (state.go_commit && spawnSync('git', ['-C', plan.boardCheckout, 'merge-base', '--is-ancestor', state.go_commit, 'HEAD']).status !== 0) failure('COPY_GO_PENDING', 'the Go has not reached the authoritative branch', state.key)
}
async function finish(plan, loc, state, { environment = process.env, seam = async () => {} } = {}) {
  const key = state.key, path = journalPath(loc, key)
  if (state.phase === 'complete') { rmSync(path); return state.result }
  if (state.phase === 'go-waiting') failure('COPY_GO_PENDING', `retry the original Go for ${key}; copy recovery never creates or completes a Go`, key)
  authority(plan, state)
  let current = rows(loc.source).get(key)
  if (state.phase === 'prepared') {
    if (state.source_already_written) {
      if (token(key, current) !== token(key, state.source_after)) failure('COPY_SOURCE_CHANGED', `the canonical ${key} changed after its Go`, key)
    } else if (token(key, current) === token(key, state.source_before)) {
      await phase(loc, state, 'plan-writing', seam)
      const result = await writeSyncRow(loc.source, key, state.source_after, state.source_before, environment)
      if (!['changed', 'unchanged'].includes(result.outcome)) failure('COPY_SOURCE_CHANGED', `canonical ${key} changed before its replacement`, key)
      state.canonical_result = result
      await seam('plan-replaced', state)
    } else if (token(key, current) !== token(key, state.source_after)) failure('COPY_SOURCE_CHANGED', `canonical ${key} changed since the transaction`, key)
    await phase(loc, state, 'plan-written', seam)
  } else if (state.phase === 'plan-writing') {
    if (token(key, current) === token(key, state.source_before)) failure('COPY_UNCERTAIN', `canonical write of ${key} may have been reverted; no intent is replayed`, key)
    if (token(key, current) !== token(key, state.source_after)) failure('COPY_SOURCE_CHANGED', `canonical ${key} differs from both recorded values`, key)
    await phase(loc, state, 'plan-written', seam)
  }
  current = rows(loc.source).get(key)
  if (token(key, current) !== token(key, state.source_after)) failure('COPY_SOURCE_CHANGED', `canonical ${key} changed before the target copy`, key)
  syncQueue(loc.source, key, current)
  let target = rows(loc.target).get(key)
  if (state.phase === 'plan-written') {
    // A target changed by its owner is retained; only the canonical change completes.
    if (state.target_conflict || (token(key, target) !== token(key, state.target_before) && token(key, target) !== token(key, state.target_after))) {
      state.result = { ...(state.canonical_result ?? { outcome: 'changed', token: token(key, current) }), copy: { outcome: 'COPY_CONFLICT' } }
      await phase(loc, state, 'complete', seam); rmSync(path); return state.result
    }
    if (token(key, target) !== token(key, state.target_after)) {
      await phase(loc, state, 'target-writing', seam)
      const result = await writeSyncRow(loc.target, key, state.target_after, target, environment)
      if (!['changed', 'unchanged'].includes(result.outcome)) failure('COPY_CONFLICT', `target ${key} changed before replacement`, key)
      await seam('target-replaced', state)
    }
    await phase(loc, state, 'target-written', seam)
  } else if (state.phase === 'target-writing') {
    if (token(key, target) === token(key, state.target_before)) failure('COPY_UNCERTAIN', `target write of ${key} may have been reverted; nothing is overwritten`, key)
    if (token(key, target) !== token(key, state.target_after)) failure('COPY_CONFLICT', `target ${key} differs from both recorded values`, key)
    await phase(loc, state, 'target-written', seam)
  }
  target = rows(loc.target).get(key)
  if (token(key, target) !== token(key, state.target_after)) failure('COPY_CONFLICT', `target ${key} changed before its copy record`, key)
  const meta = metadata(loc), entry = meta.rows[key]
  if (!same(entry, state.record_before) && !same(entry, state.record_after)) failure('COPY_RECORD_CHANGED', `copy record for ${key} changed`, key)
  if (state.phase === 'record-writing' && same(entry, state.record_before)) failure('COPY_UNCERTAIN', `record replacement of ${key} is uncertain; its journal is retained`, key)
  if (!same(entry, state.record_after)) {
    await phase(loc, state, 'record-writing', seam)
    meta.rows[key] = state.record_after; atomic(loc.record, meta)
    await seam('record-replaced', state)
  }
  state.result = { ...(state.canonical_result ?? { outcome: 'changed', token: token(key, current) }), copy: { outcome: 'copied', token: token(key, target) } }
  await phase(loc, state, 'complete', seam); rmSync(path)
  return state.result
}
async function prepare(plan, loc, { key, sourceBefore, sourceAfter, explicit = false, sourceAlreadyWritten = false, goCommit = null, environment = process.env, seam = async () => {} }) {
  const meta = metadata(loc), previous = meta.rows[key], target = rows(loc.target).get(key)
  if (!target) failure('COPY_CONFLICT', `copied target ${key} is missing; no line is recreated`, key)
  const mapped = TO_BMAD[sourceAfter.status]
  if (!mapped) failure('COPY_STATUS', `no BMAD mapping for ${sourceAfter.status}`, key)
  const after = { status: mapped, note: [...sourceAfter.note].slice(0, 1000).join('') }
  const state = { version: 1, id: randomBytes(12).toString('hex'), key, source: loc.source, target: loc.target, record: loc.record, source_before: sourceBefore, source_after: sourceAfter, target_before: target, target_after: after, record_before: previous, record_after: { ...previous, last_copied: after, source_token: token(key, sourceAfter), ...(meta.version === 2 ? { source_value: sourceAfter, note_projection: { raw: after.note, visible: sourceAfter.note }, ...(target.note !== after.note ? { previous_notes: [...new Set([...(previous.previous_notes ?? []), target.note])] } : {}) } : {}) }, source_already_written: sourceAlreadyWritten, go_commit: goCommit, target_conflict: !explicit && !same(target, previous.last_copied) }
  await phase(loc, state, 'prepared', seam)
  return await finish(plan, loc, state, { environment, seam })
}

async function syncOne(plan, loc, key, requested, target, { environment = process.env, seam = async () => {}, explicitNote = false } = {}) {
  const meta = metadata(loc), previous = meta.rows[key], source = rows(loc.source).get(key) ?? null
  const mine = requested ?? null, theirs = target ?? null
  if (mine && (!Object.hasOwn(TO_BMAD, mine.status) || [...mine.note].length > 160 || /[\r\n]/u.test(mine.note))) failure('COPY_STATUS', `invalid plan row ${key}`, key)
  if (theirs && (!Object.hasOwn(FROM_BMAD, theirs.status) || ([...theirs.note].length > 1000 && theirs.note !== previous?.last_copied?.note && theirs.note !== previous?.note_projection?.raw))) failure('COPY_STATUS', `invalid BMAD row ${key}`, key)
  const planChanged = token(key, mine) !== (previous?.source_token ?? null), bmadChanged = !same(theirs, previous?.last_copied ?? null)
  if (!planChanged && !bmadChanged) return { outcome: 'unchanged', token: token(key, source), copy: { outcome: 'unchanged' } }
  const imported = projected(theirs)
  const takeBmad = !mine || (bmadChanged && (!planChanged || progress.get(imported.status) > progress.get(mine.status)))
  const after = takeBmad ? imported : mine
  let targetAfter = theirs
  if (!takeBmad) {
    targetAfter = { status: theirs && after.status === imported.status ? theirs.status : TO_BMAD[after.status], note: explicitNote ? after.note : fullCopyNote(previous, after) }
  }
  const recordAfter = { ...previous, last_copied: targetAfter, source_value: after, source_token: token(key, after), note_projection: { raw: targetAfter.note, visible: after.note } }
  if (planChanged && bmadChanged && !same(mine, imported)) {
    const values = { plan: mine, bmad: theirs, winner: takeBmad ? 'bmad' : 'plan' }, id = hash(JSON.stringify(values))
    const conflicts = previous?.conflicts ?? []
    if (!conflicts.some(value => value.id === id)) recordAfter.conflicts = [...conflicts, { id, ...values }]
  }
  if (theirs && !same(theirs, targetAfter) && theirs.note !== targetAfter.note) {
    recordAfter.previous_notes = [...new Set([...(previous?.previous_notes ?? []), theirs.note])]
  }
  const state = { version: 2, id: randomBytes(12).toString('hex'), key, direction: takeBmad ? 'from-bmad' : 'to-bmad', source: loc.source, target: loc.target, record: loc.record, source_before: source, source_after: after, target_before: theirs, target_after: targetAfter, record_before: previous ?? null, record_after: recordAfter, source_already_written: same(source, after), canonical_result: { outcome: same(source, after) ? 'unchanged' : 'changed', token: token(key, after) }, target_conflict: false }
  // Missing records compare as null too, including after JSON recovery.
  if (!previous) state.record_before = undefined
  await phase(loc, state, 'prepared', seam)
  return await finish(plan, loc, state, { environment, seam })
}
const holdFindings = loc => (meta => Object.values(meta.holds ?? {}).map(hold => ({ code: hold.code, key: hold.key, where: loc.record, reason: hold.reason })))(metadata(loc))
async function syncLocked(plan, loc, { environment = process.env, seam = async () => {} } = {}) {
  let meta = metadata(loc)
  if (meta.version !== 2) failure('COPY_SYNC_UNAVAILABLE', 'this version-1 copy needs a D25 recut before two-way sync', '')
  if (meta.active === false) failure('COPY_NOT_ACTIVE', 'finish verified cutover before synchronizing a staged copy', '')
  const holds = syncHolds(loc, meta)
  if (!same(holds, meta.holds)) { meta.holds = holds; atomic(loc.record, meta) }
  const findings = holdFindings(loc), blocked = new Set(Object.keys(holds))
  const files = existsSync(loc.folder) ? readdirSync(loc.folder).filter(name => /^[0-9a-f]{64}\.json$/u.test(name)) : []
  for (const file of files) {
    const state = load(join(loc.folder, file))
    if (blocked.has(epicOf(state.key))) continue
    try { await finish(plan, loc, state, { environment, seam }) }
    catch (error) { findings.push({ code: error.code ?? 'COPY_UNREADABLE', key: state.key, where: loc.record, reason: error.message }); blocked.add(epicOf(state.key)) }
  }
  meta = metadata(loc)
  const source = rows(loc.source), targets = rows(loc.target), results = []
  for (const key of [...new Set([...source.keys(), ...targets.keys(), ...Object.keys(meta.rows)])].sort()) {
    if (blocked.has(epicOf(key))) continue
    try { results.push({ key, ...await syncOne(plan, loc, key, source.get(key), targets.get(key), { environment, seam }) }) }
    catch (error) { findings.push({ code: error.code ?? 'COPY_UNREADABLE', key, where: loc.record, reason: error.message }); blocked.add(epicOf(key)) }
  }
  return { outcome: findings.length ? 'held' : 'synced', rows: results, findings }
}
export async function syncPlan(plan, options = {}) {
  if (!isCopiedPlan(plan)) return { outcome: 'not-copied', rows: [], findings: [] }
  return await locked(plan, loc => syncLocked(plan, loc, options))
}
export async function setWithCopy(plan, { key, status, note, expect, environment = process.env, seam = async () => {} }) {
  return await locked(plan, async loc => {
    if (metadata(loc).version === 2) {
      const sync = await syncLocked(plan, loc, { environment, seam })
      const blocked = sync.findings.find(finding => epicOf(finding.key) === epicOf(key))
      if (blocked) failure(blocked.code, blocked.reason, key)
      const source = rows(loc.source).get(key)
      if (!source) failure('UNKNOWN_ROW', `no canonical row ${key}`, key)
      if (token(key, source) !== expect) return { outcome: 'conflict', current: { key, ...source, token: token(key, source) } }
      const next = { status, note: note ?? source.note }
      if (same(source, next)) return { outcome: 'unchanged', token: expect, copy: { outcome: 'unchanged' } }
      return await syncOne(plan, loc, key, next, rows(loc.target).get(key), { environment, seam, explicitNote: note !== undefined })
    }
    const pending = journal(loc, key)
    if (pending?.phase === 'go-waiting') rmSync(journalPath(loc, key)) // a new explicit set supersedes stale Go-copy intent
    else if (pending) await finish(plan, loc, pending, { environment })
    const meta = metadata(loc), source = rows(loc.source).get(key)
    if (!source) failure('UNKNOWN_ROW', `no canonical row ${key}`, key)
    if (token(key, source) !== expect) return { outcome: 'conflict', current: { key, ...source, token: token(key, source) } }
    if (protectedRow(meta, key)) return { ...await setRow(loc.source, { key, status, note, expect, environment, locked: true }), copy: { outcome: 'protected' } }
    const next = { status, note: note ?? source.note }
    if (same(source, next)) return { outcome: 'unchanged', token: expect, copy: { outcome: same(rows(loc.target).get(key), meta.rows[key].last_copied) ? 'unchanged' : 'COPY_CONFLICT' } }
    return await prepare(plan, loc, { key, sourceBefore: source, sourceAfter: next, environment, seam })
  })
}
export async function withGoCopy(plan, options, operation) {
  return await locked(plan, async loc => {
    const key = `epic-${options.epic}`
    let meta = metadata(loc), pending = journal(loc, key)
    if (meta.version === 2) {
      if (pending?.go_commit) {
        const source = rows(loc.source).get(key), target = rows(loc.target).get(key), held = meta.holds[String(options.epic)]
        if (!same(source, pending.source_after) || (!same(target, pending.target_before) && !same(target, pending.target_after))) failure('COPY_APPROVAL_HOLD', 'recorded Go copy differs from the current boards; preserve both values', key)
        if (held && (held.key !== key || !same(held.plan, pending.source_after) || (!same(held.bmad, pending.target_before) && !same(held.bmad, pending.target_after)))) failure(held.code, held.reason, key)
        authority(plan, pending)
        await finish(plan, loc, pending)
        meta = metadata(loc)
        if (held) { delete meta.holds[String(options.epic)]; atomic(loc.record, meta) }
        pending = null
      }
      // An interrupted recorded Go is retried by its original operation, never by ordinary sync.
      if (pending?.phase !== 'go-waiting') {
        const sync = await syncLocked(plan, loc)
        const hold = sync.findings.find(finding => epicOf(finding.key) === String(options.epic))
        if (hold) failure(hold.code, hold.reason, key)
        meta = metadata(loc); pending = journal(loc, key)
      } else if (!same(rows(loc.target).get(key), meta.rows[key]?.last_copied)) failure('COPY_APPROVAL_HOLD', 'BMAD changed while this Go was pending; preserve both boards', key)
    }
    if (protectedRow(meta, key)) return await operation()
    if (pending && pending.phase !== 'go-waiting') await finish(plan, loc, pending)
    const request = Object.fromEntries(['epic', 'source', 'approved', 'expect', 'date', 'note'].map(name => [name, options[name] ?? null]))
    if (pending?.phase === 'go-waiting' && !same(pending.request, request)) failure('COPY_GO_PENDING', 'settle the recorded Go-copy request before a different Go', key)
    const before = rows(loc.source).get(key)
    atomic(journalPath(loc, key), { version: 1, key, phase: 'go-waiting', request })
    let result
    try { result = await operation() }
    catch (error) {
      if (['WITHDRAWN', 'FINISHED', 'CONFLICT', 'CHANGED_TERMS', 'NO_OWNER_GO', 'NO_APPROVED_TEXT', 'NOTE_WITHOUT_GO', 'NEEDS_NORMALIZE', 'COMMIT_FAILED', 'NO_EPIC', 'NO_HISTORY', 'NO_DEFAULT_CHECKOUT'].includes(error.code)) rmSync(journalPath(loc, key), { force: true })
      throw error
    }
    if (result.pending || !result.row || result.row.status !== 'ready') return { ...result, copy: { outcome: 'COPY_GO_PENDING' } }
    const after = { status: result.row.status, note: result.row.note }
    const copied = await prepare(plan, loc, { key, sourceBefore: before, sourceAfter: after, sourceAlreadyWritten: true, goCommit: result.commit, seam: options.copySeam })
    if (meta.version === 2) {
      const completed = metadata(loc)
      const held = completed.holds[String(options.epic)]
      if (held?.key === key && same(held.plan, after) && same(held.bmad, meta.rows[key].last_copied) && same(rows(loc.target).get(key), completed.rows[key].last_copied)) {
        delete completed.holds[String(options.epic)]; atomic(loc.record, completed)
      }
    }
    return { ...result, copy: copied.copy }
  })
}
export async function copyToken(plan, key) { return await locked(plan, async loc => combinedToken(loc, key, metadata(loc))) }
export async function copyRow(plan, { key, expect, environment = process.env, seam = async () => {} }) {
  return await locked(plan, async loc => {
    const meta = metadata(loc)
    if (meta.version === 2) failure('COPY_USE_SYNC', 'two-way boards use plan sync; an explicit copy cannot bypass an approval hold', key)
    if (protectedRow(meta, key)) failure('COPY_PROTECTED', `${key} is not an eligible copied row`, key)
    if (combinedToken(loc, key, meta) !== expect) failure('COPY_STALE', `${key}'s canonical row, target or baseline changed; read check again`, key)
    if (journal(loc, key)?.phase === 'go-waiting') failure('COPY_GO_PENDING', 'settle the original Go before copying readiness', key)
    const source = rows(loc.source).get(key)
    if (!source) failure('UNKNOWN_ROW', `no canonical row ${key}`, key)
    rmSync(journalPath(loc, key), { force: true })
    return await prepare(plan, loc, { key, sourceBefore: source, sourceAfter: source, sourceAlreadyWritten: true, explicit: true, environment, seam })
  })
}
export async function copyFindings(plan, { recover = false, environment = process.env } = {}) {
  if (!isCopiedPlan(plan)) return []
  // A staged plan is structurally checkable before the original target is installed beside it.
  if (readMetadata(join(plan.planRoot, 'bmad-copy.json'), sourceBoard(plan)).active === false) return []
  return await locked(plan, async loc => {
    if (metadata(loc).version === 2) {
      if (recover) return (await syncLocked(plan, loc, { environment })).findings
      return Object.values(syncHolds(loc, metadata(loc))).map(hold => ({ code: hold.code, key: hold.key, where: loc.record, reason: hold.reason }))
    }
    const findings = []
    for (const file of existsSync(loc.folder) ? readdirSync(loc.folder).filter(name => /^[0-9a-f]{64}\.json$/u.test(name)) : []) {
      const state = load(join(loc.folder, file))
      try {
        if (recover) await finish(plan, loc, state, { environment })
        else failure(state.phase === 'go-waiting' ? 'COPY_GO_PENDING' : 'COPY_PENDING', `copy journal for ${state.key} awaits recovery`, state.key)
      } catch (error) { findings.push({ code: error.code ?? 'COPY_UNREADABLE', key: state.key, where: loc.source, reason: error.message }) }
    }
    const meta = metadata(loc), targets = rows(loc.target), source = rows(loc.source)
    if (meta.active === false) return findings
    for (const [key, entry] of Object.entries(meta.rows)) if (!same(targets.get(key), entry.last_copied)) findings.push({ code: 'COPY_CONFLICT', key, where: loc.target, reason: `COPY_CONFLICT ${key}: canonical ${JSON.stringify(source.get(key) ?? null)}, target ${JSON.stringify(targets.get(key) ?? null)}; explicit copy requires its fresh token`, canonical: source.get(key) ?? null, target: targets.get(key) ?? null, token: combinedToken(loc, key, meta) })
    for (const key of Object.keys(meta.unresolved)) findings.push({ code: 'COPY_PROVENANCE_REQUIRED', key, where: loc.record, reason: `${key} has unresolved move-time writer provenance` })
    return findings
  })
}
