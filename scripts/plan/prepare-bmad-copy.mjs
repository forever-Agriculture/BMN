// MODULE: prepare-bmad-copy.mjs - internal, journaled compatibility preparation; staging never calls this
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PlanError, ROW } from '../../apps/desktop/bin/plan-board.mjs'
import { BMAD_PARSER_ORIGINAL, BMAD_PARSER_PATHS, BMAD_PARSER_PREPARED, parserFiles, verifyParserProof } from '../../apps/desktop/bin/plan-bmad-parser.mjs'
import { migrationPaths, withMigrationWriter } from '../../apps/desktop/bin/plan-migration-lock.mjs'
import { compatibleParser, digest } from './bmad-parser-patch.mjs'
import { sources } from './migrate-bmad-plan.mjs'

const proof = () => ({ version: 1, paths: [...BMAD_PARSER_PATHS], original_sha256: BMAD_PARSER_ORIGINAL, prepared_sha256: BMAD_PARSER_PREPARED })
const journalPath = repo => join(migrationPaths(repo).common, 'bmn-bmad-preparation', 'state.json')
const load = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
function atomic(path, bytes, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, bytes, { mode })
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
    if (!readFileSync(path).equals(Buffer.from(bytes))) throw new Error('BMAD_PREPARATION_UNREADABLE: replacement readback differs')
  } finally { rmSync(temporary, { force: true }) }
}
function save(path, state) { atomic(path, JSON.stringify(state, null, 2) + '\n'); load(path) }
function heldRows(repo) {
  const held = new Map()
  for (const file of sources(repo).files.filter(file => file.path.endsWith('/sprint-status.yaml'))) {
    const full = join(repo, file.path)
    if (realpathSync(full) !== full) throw new PlanError('BMAD_PREPARATION_UNREADABLE', 'board links require a separate verified handover')
    for (const line of readFileSync(full, 'utf8').split('\n')) {
      const row = ROW.exec(line.replace(/\r$/u, ''))
      if (row && ['blocked', 'deferred', 'withdrawn'].includes(row[2])) held.set(`${file.path}::${row[1]}`, digest(line))
    }
  }
  return [...held]
}
async function handover(repo, value) {
  const { validateHandover } = await import('./plan-cutover.mjs')
  validateHandover(repo, value)
}
function validate(state, repo) {
  if (state?.version !== 1 || state.repo !== repo || JSON.stringify(state.files?.map(file => file.path)) !== JSON.stringify(BMAD_PARSER_PATHS) || state.files.some(file => digest(Buffer.from(file.original, 'base64')) !== BMAD_PARSER_ORIGINAL || !Number.isInteger(file.mode))) throw new PlanError('BMAD_PREPARATION_UNREADABLE', 'preparation journal does not prove both exact original files')
}
export function preparedBmadProof(repo) {
  const files = parserFiles(repo), state = load(journalPath(repo))
  if (files.every(file => file.sha256 === null) && !state) return null
  validate(state, realpathSync(repo))
  if (state.phase !== 'complete') throw new PlanError('BMAD_PREPARATION_REQUIRED', 'BMAD preparation is incomplete; finish its journal before cutover')
  const value = proof(); verifyParserProof(repo, value); return value
}

/** Explicit internal preparation for Epic108. Only disposable copies are prepared in Epic107. */
export async function prepareBmadCopy({ repo: given, handover: inventory, seam = async () => {} }) {
  const repo = realpathSync(given)
  return await withMigrationWriter(repo, async () => {
    await handover(repo, inventory)
    const path = journalPath(repo); let state = load(path)
    if (!state) {
      const files = parserFiles(repo)
      if (files.some(file => file.sha256 !== BMAD_PARSER_ORIGINAL)) throw new PlanError('BMAD_VERSION_UNSUPPORTED', 'both repository-local BMAD clients must match the measured original version; nothing changed')
      state = { version: 1, repo, phase: 'prepared', original_held_rows: heldRows(repo), files: files.map(file => ({ path: file.path, original: readFileSync(join(repo, file.path)).toString('base64'), mode: lstatSync(join(repo, file.path)).mode & 0o777, phase: 'ready' })) }
      save(path, state); await seam('prepared', state)
    }
    validate(state, repo)
    if (state.phase.startsWith('rollback') || state.phase === 'rolled-back') throw new PlanError('BMAD_PREPARATION_ROLLED_BACK', 'this preparation was rolled back; retain its journal')
    for (const file of state.files) {
      const actual = parserFiles(repo).find(value => value.path === file.path).sha256
      if (actual === BMAD_PARSER_PREPARED) { file.phase = 'written'; save(path, state); continue }
      if (actual !== BMAD_PARSER_ORIGINAL) throw new PlanError('BMAD_PREPARATION_DIVERGED', `${file.path} changed; preserve it and its recorded original`)
      if (file.phase !== 'ready') throw new PlanError('BMAD_PREPARATION_UNCERTAIN', `${file.path} is original after an attempted replacement; no implicit overwrite`)
      file.phase = 'writing'; save(path, state); await seam('writing', { ...state, file: file.path })
      // Handover and a second hash check precede every actual replacement.
      await handover(repo, inventory)
      if (parserFiles(repo).find(value => value.path === file.path).sha256 !== actual) throw new PlanError('BMAD_PREPARATION_DIVERGED', `${file.path} changed during handover`)
      const bytes = compatibleParser(Buffer.from(file.original, 'base64'))
      if (digest(bytes) !== BMAD_PARSER_PREPARED) throw new Error('BMAD_PATCH_MISMATCH: prepared parser differs from runtime proof')
      atomic(join(repo, file.path), bytes, file.mode); await seam('replaced', { ...state, file: file.path })
      file.phase = 'written'; save(path, state); await seam('written', { ...state, file: file.path })
    }
    state.phase = 'complete'; save(path, state); await seam('complete', state)
    return preparedBmadProof(repo)
  })
}

export async function rollbackBmadPreparation({ repo: given, handover: inventory, seam = async () => {} }) {
  const repo = realpathSync(given)
  return await withMigrationWriter(repo, async () => {
    await handover(repo, inventory)
    const path = journalPath(repo), state = load(path); validate(state, repo)
    if (existsSync(join(repo, 'plan/bmad-copy.json')) && load(join(repo, 'plan/bmad-copy.json')).active !== false) throw new PlanError('BMAD_PREPARATION_IN_USE', 'an active copied plan still requires the prepared parser')
    const originalHeld = new Map(state.original_held_rows ?? [])
    if (heldRows(repo).some(([key, hash]) => originalHeld.get(key) !== hash)) throw new PlanError('BMAD_PREPARATION_IN_USE', 'held BMAD rows changed after preparation and still require the prepared parser')
    const current = parserFiles(repo)
    if (current.some(file => ![BMAD_PARSER_ORIGINAL, BMAD_PARSER_PREPARED].includes(file.sha256))) throw new PlanError('BMAD_PREPARATION_DIVERGED', 'a parser was edited after preparation; rollback preserves it')
    state.phase = 'rollback'; save(path, state); await seam('rollback', state)
    for (const file of state.files) {
      const actual = parserFiles(repo).find(value => value.path === file.path).sha256
      if (actual === BMAD_PARSER_ORIGINAL) continue
      if (actual !== BMAD_PARSER_PREPARED) throw new PlanError('BMAD_PREPARATION_DIVERGED', `${file.path} changed during rollback`)
      atomic(join(repo, file.path), Buffer.from(file.original, 'base64'), file.mode)
      await seam('rollback-replaced', { ...state, file: file.path })
      file.phase = 'restored'; save(path, state)
    }
    state.phase = 'rolled-back'; save(path, state); await seam('rolled-back', state)
    return { outcome: 'rolled-back', journal: path }
  })
}
