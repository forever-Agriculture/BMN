// MODULE: agents-own-skills.mjs - Story 77.4: BMN's own skills (plan, team-ask, team-page, web-question, jev-judge) install themselves into the skills folder as BMN's entries, pointing at a copy that stays readable with BMN closed
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentsDirectory } from './agents-roster.mjs'
import { copyTree, entryOf, treeHash } from './agents-skills.mjs'

/**
 * BMN ships a few skills of its own, listed in `skills/manifest.json` beside them (in the repository, and in a
 * packaged build under resources/skills). At start BMN puts each one the skills folder lacks there as a link to
 * its own copy under `~/.local/share/bmn/skills/<name>`, which an update refreshes and which stays readable while
 * BMN is closed or being rebuilt; the existing skills install then carries it into Codex and OpenCode with the
 * same ownership, route and eligibility checks as any other skill.
 *
 * Whose entry is it: a link to BMN's copy is BMN's; a link into a BMN checkout or install (how the owner linked
 * web-question and jev-judge by hand) is taken over; anything else of that name is the owner's and is left as it
 * is, listed under Integrations › Skills. An entry BMN made that is gone was removed by the owner: BMN records
 * that and never adds it back. A copy that cannot be read is put back, never taken for a removal.
 */
export const OWN_SKILLS_RECORD_VERSION = 1

export function ownSkillsRecordPath() {
  return `${agentsDirectory()}/state/own-skills.json`
}

/** Where BMN's shipped skills are: the packaged resources/skills, or the repository's skills/ in development. */
export function shippedSkillsRoot(environment = process.env) {
  if (environment.BMN_SHIPPED_SKILLS) return environment.BMN_SHIPPED_SKILLS
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [resolve(here, '../skills'), resolve(here, '../../../skills')]) {
    if (existsSync(join(candidate, 'manifest.json'))) return candidate
  }
  return null
}

/** The folder BMN keeps its copies in; outside every install, so a rebuild never takes it away. */
export function ownCopiesRoot(environment = process.env) {
  const data = environment.XDG_DATA_HOME || join(environment.HOME || homedir(), '.local', 'share')
  return join(data, 'bmn', 'skills')
}

export function shippedNames(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  if (!Array.isArray(manifest?.skills)) throw new Error('skills/manifest.json has no skills list')
  return manifest.skills.filter((name) => typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(name))
}

function readRecord() {
  try {
    const record = JSON.parse(readFileSync(ownSkillsRecordPath(), 'utf8'))
    if (record?.version === OWN_SKILLS_RECORD_VERSION) return { skills: record.skills ?? {}, removed: record.removed ?? {} }
  } catch { /* none yet, or unreadable: nothing is known to be BMN's */ }
  return { skills: {}, removed: {} }
}

function writeRecord(record) {
  const path = ownSkillsRecordPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}-${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: OWN_SKILLS_RECORD_VERSION, ...record }, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

function realOrNull(path) {
  try { return realpathSync(path) } catch { return null }
}

/** A link's target that lies in a BMN checkout (`<repo>/skills/<name>` beside `apps/desktop/bin/bmn`) or a BMN install (`resources/skills/<name>` beside `bin/bmn.mjs`). */
export function pointsIntoBmn(target, name) {
  const skills = dirname(target)
  if (target.split('/').at(-1) !== name || skills.split('/').at(-1) !== 'skills') return false
  const base = dirname(skills)
  return existsSync(join(base, 'apps', 'desktop', 'bin', 'bmn')) || existsSync(join(base, 'bin', 'bmn.mjs'))
}

/** Put the shipped skill's current tree in BMN's copy, replacing an older or unreadable one whole. */
function refreshCopy(from, copy) {
  mkdirSync(dirname(copy), { recursive: true, mode: 0o700 })
  const staged = `${copy}.new-${process.pid}-${randomBytes(3).toString('hex')}`
  copyTree(from, staged)
  const old = `${copy}.old-${process.pid}-${randomBytes(3).toString('hex')}`
  let moved = false
  try {
    if (existsSync(copy) || lstatOrNull(copy)) { renameSync(copy, old); moved = true }
    renameSync(staged, copy)
  } catch (error) {
    rmSync(staged, { recursive: true, force: true })
    if (moved) renameSync(old, copy)
    throw error
  }
  if (moved) rmSync(old, { recursive: true, force: true })
}

function lstatOrNull(path) {
  try { return lstatSync(path) } catch { return null }
}

/** A link at `path` to `target`, made beside it and renamed over whatever link was there. */
function placeLink(path, target) {
  const temporary = `${path}.bmn-${process.pid}-${randomBytes(3).toString('hex')}`
  symlinkSync(target, temporary)
  try { renameSync(temporary, path) } catch (error) { rmSync(temporary, { force: true }); throw error }
}

function copyCurrent(from, copy) {
  try { return treeHash(copy) === treeHash(from) } catch { return false }
}

/**
 * Bring BMN's own skills into the skills folder. `apply: false` only says what it would do. Returns one row per
 * shipped skill: installed, current, updated, repaired, taken-over, foreign (left), removed (by the owner, not
 * added back) or unavailable (the shipped skill or the skills folder cannot be read).
 */
export function installOwnSkills({ source, environment = process.env, apply = true, now = new Date() } = {}) {
  const root = shippedSkillsRoot(environment)
  if (root === null) return { ok: false, code: 'NO_SHIPPED_SKILLS', message: 'BMN\'s own skills were not found beside this bmn', rows: [] }
  let names
  try { names = shippedNames(root) } catch (error) { return { ok: false, code: 'NO_SHIPPED_SKILLS', message: error.message, rows: [] } }
  if (!existsSync(source)) {
    if (!existsSync(dirname(source))) return { ok: false, code: 'NO_SKILLS_FOLDER', message: `${dirname(source)} does not exist`, rows: [] }
    if (apply) mkdirSync(source, { recursive: true, mode: 0o755 })
  }
  const record = readRecord()
  const copies = ownCopiesRoot(environment)
  const rows = []
  let changed = false
  for (const name of names) {
    const shipped = join(root, name)
    const path = join(source, name)
    const copy = join(copies, name)
    if (!existsSync(join(shipped, 'SKILL.md'))) { rows.push({ name, state: 'unavailable', path, detail: `${shipped} has no SKILL.md` }); continue }
    let entry
    try { entry = entryOf(path) } catch (error) { rows.push({ name, state: 'unavailable', path, detail: `${path} cannot be read (${error.code ?? 'error'})` }); continue }
    const at = now.toISOString()
    if (entry.kind === 'missing') {
      if (record.skills[name] !== undefined || record.removed[name] !== undefined) {
        // BMN made it and it is gone: the owner removed it, and it stays removed.
        if (record.skills[name] !== undefined) { record.removed[name] = at; delete record.skills[name]; changed = true }
        rows.push({ name, state: 'removed', path, detail: `removed by the owner${record.removed[name] ? ` (noticed ${record.removed[name]})` : ''}; BMN does not add it back` })
        continue
      }
      if (apply) { refreshCopy(shipped, copy); placeLink(path, copy); record.skills[name] = { path, copy, at }; changed = true }
      rows.push({ name, state: 'installed', path, copy })
      continue
    }
    if (entry.kind === 'link') {
      const target = resolve(dirname(path), entry.target)
      const ours = target === copy || (realOrNull(target) !== null && realOrNull(target) === realOrNull(copy))
      if (ours) {
        const readable = existsSync(join(copy, 'SKILL.md'))
        const current = readable && copyCurrent(shipped, copy)
        if (!current && apply) { refreshCopy(shipped, copy); changed = true }
        if (record.skills[name] === undefined && apply) { record.skills[name] = { path, copy, at }; delete record.removed[name]; changed = true }
        rows.push({ name, state: current ? 'current' : readable ? 'updated' : 'repaired', path, copy })
        continue
      }
      if (pointsIntoBmn(target, name)) {
        if (apply) { refreshCopy(shipped, copy); placeLink(path, copy); record.skills[name] = { path, copy, at, took_over: target }; delete record.removed[name]; changed = true }
        rows.push({ name, state: 'taken-over', path, copy, detail: `was a link to ${target}` })
        continue
      }
      rows.push({ name, state: 'foreign', path, detail: `a link to ${target} that BMN did not make; left as it is` })
      continue
    }
    rows.push({ name, state: 'foreign', path, detail: `a ${entry.folder ? 'folder' : 'file'} BMN did not make; left as it is` })
  }
  if (apply && changed) writeRecord(record)
  return { ok: true, code: 'OK', source, shipped: root, copies, rows }
}

/**
 * The shipped names whose entry in the skills folder `source` is BMN's own, for eligibility: its own skills are
 * public, as its repository is. Only a link to BMN's copy counts; a foreign folder or link of a shipped name is
 * the owner's and gets no mark from BMN.
 */
export function ownSkillNames(source, environment = process.env) {
  const root = shippedSkillsRoot(environment)
  if (root === null || !source) return []
  let names
  try { names = shippedNames(root) } catch { return [] }
  const copies = ownCopiesRoot(environment)
  return names.filter((name) => {
    let entry
    try { entry = entryOf(join(source, name)) } catch { return false }
    if (entry.kind !== 'link') return false
    const target = resolve(source, entry.target)
    const copy = join(copies, name)
    return target === copy || (realOrNull(target) !== null && realOrNull(target) === realOrNull(copy))
  })
}
