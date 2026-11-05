// MODULE: plan-bmad-copy.mjs - D10 guarded one-row BMAD copies with recoverable, ambiguity-aware journals
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { PlanError, ROW, rowToken } from './plan-board.mjs'
import { lockBoard, setRow } from './plan-cli.mjs'
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
  if (value.version !== 1 || value.source_board !== board || !value.rows || !value.excluded || !value.unresolved) throw new PlanError('COPY_UNREADABLE', 'invalid bmad-copy.json version, source or row maps')
  for (const name of ['rows', 'excluded', 'unresolved']) if (typeof value[name] !== 'object' || Array.isArray(value[name])) throw new PlanError('COPY_UNREADABLE', `invalid ${name} row map`)
  for (const [key, entry] of Object.entries(value.rows)) if (!/^[\w.-]+$/u.test(key) || !entry || !Object.hasOwn(FROM_BMAD, entry.last_copied?.status) || typeof entry.last_copied?.note !== 'string' || /[\r\n]/u.test(entry.last_copied.note) || !/^[0-9a-f]{16}$/u.test(entry.source_token)) throw new PlanError('COPY_UNREADABLE', `invalid copy baseline for ${key}`)
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
      const result = await setRow(loc.source, { key, ...state.source_after, expect: token(key, state.source_before), locked: true, environment })
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
  let target = rows(loc.target).get(key)
  if (state.phase === 'plan-written') {
    // A target changed by its owner is retained; only the canonical change completes.
    if (state.target_conflict || (token(key, target) !== token(key, state.target_before) && token(key, target) !== token(key, state.target_after))) {
      state.result = { ...(state.canonical_result ?? { outcome: 'changed', token: token(key, current) }), copy: { outcome: 'COPY_CONFLICT' } }
      await phase(loc, state, 'complete', seam); rmSync(path); return state.result
    }
    if (token(key, target) !== token(key, state.target_after)) {
      await phase(loc, state, 'target-writing', seam)
      const result = await setRow(loc.target, { key, ...state.target_after, expect: token(key, target), locked: true, environment })
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
  const state = { version: 1, id: randomBytes(12).toString('hex'), key, source: loc.source, target: loc.target, record: loc.record, source_before: sourceBefore, source_after: sourceAfter, target_before: target, target_after: after, record_before: previous, record_after: { ...previous, last_copied: after, source_token: token(key, sourceAfter) }, source_already_written: sourceAlreadyWritten, go_commit: goCommit, target_conflict: !explicit && !same(target, previous.last_copied) }
  await phase(loc, state, 'prepared', seam)
  return await finish(plan, loc, state, { environment, seam })
}
export async function setWithCopy(plan, { key, status, note, expect, environment = process.env, seam = async () => {} }) {
  return await locked(plan, async loc => {
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
    const key = `epic-${options.epic}`, meta = metadata(loc), pending = journal(loc, key)
    if (protectedRow(meta, key)) return await operation()
    if (pending && pending.phase !== 'go-waiting') await finish(plan, loc, pending)
    const request = Object.fromEntries(['epic', 'source', 'approved', 'expect', 'date', 'note'].map(name => [name, options[name] ?? null]))
    if (pending?.phase === 'go-waiting' && !same(pending.request, request)) failure('COPY_GO_PENDING', 'settle the recorded Go-copy request before a different Go', key)
    const before = rows(loc.source).get(key)
    atomic(journalPath(loc, key), { version: 1, key, phase: 'go-waiting', request })
    let result
    try { result = await operation() }
    catch (error) {
      if (['WITHDRAWN', 'FINISHED', 'CONFLICT', 'CHANGED_TERMS', 'NO_OWNER_GO', 'NO_APPROVED_TEXT', 'NEEDS_NORMALIZE', 'COMMIT_FAILED', 'NO_EPIC', 'NO_HISTORY', 'NO_DEFAULT_CHECKOUT'].includes(error.code)) rmSync(journalPath(loc, key), { force: true })
      throw error
    }
    if (result.pending || !result.row || result.row.status !== 'ready') return { ...result, copy: { outcome: 'COPY_GO_PENDING' } }
    const after = { status: result.row.status, note: result.row.note }
    const copied = await prepare(plan, loc, { key, sourceBefore: before, sourceAfter: after, sourceAlreadyWritten: true, goCommit: result.commit })
    return { ...result, copy: copied.copy }
  })
}
export async function copyToken(plan, key) { return await locked(plan, async loc => combinedToken(loc, key, metadata(loc))) }
export async function copyRow(plan, { key, expect, environment = process.env, seam = async () => {} }) {
  return await locked(plan, async loc => {
    const meta = metadata(loc)
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
