// MODULE: agents-team-tree.mjs - Epic 72 review R6: everything an ask's container binds from its run, as one manifest the check hashes and the start and the supervisor check again
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256 } from './agents-roster.mjs'

/**
 * The run's folders a container binds or reads (72.3 AC1): the app's own home, the inputs (prompt,
 * pictures, file copies, BMN's git), the frozen project with its history, and the snapshots (the
 * configuration, the program's identity, the environment once, the hosts file). The record's own
 * files (request, receipt, outcome, logs) are not bound and not part of it.
 */
export const TREE_ROOTS = Object.freeze(['home', 'inputs', 'project', 'snapshots'])

/**
 * What an app may add to its home after the check, by its harness: OpenCode's sign-in import at the
 * start writes its database and its log, and makes folders, in the run's own OpenCode folders
 * (measured on 2.0.29). Only additions: a file it names may appear or change, a folder may only
 * appear; every entry the check judged, folders and their permission bits included, stays as it was.
 */
const ALLOWANCES = Object.freeze({
  opencode: (path, entry) => (entry.type === 'dir' && path.startsWith('home/oc/'))
    || (entry.type === 'file' && /^home\/oc\/data\/opencode\/(opencode\.db(-wal|-shm|-journal)?|log\/[^/]+)$/u.test(path))
})

export class TreeUnreadable extends Error {}

/** One entry: its type, permission bits, and its bytes' hash or its link's target. Anything else is refused. */
function entryOf(path) {
  const stat = lstatSync(path)
  const mode = stat.mode & 0o777
  if (stat.isDirectory()) return { type: 'dir', mode }
  if (stat.isSymbolicLink()) return { type: 'link', target: readlinkSync(path) }
  if (stat.isFile()) return { type: 'file', mode, size: stat.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
  throw new TreeUnreadable(`${path} is neither a file, a folder nor a link`)
}

/**
 * The run's manifest: every entry under its bound roots, sorted, nothing followed through a link;
 * a root that is not there is recorded as absent. Throws TreeUnreadable on an entry it cannot read or type.
 */
export function runTree(folder) {
  const entries = []
  const walk = (relative) => {
    let entry
    try {
      entry = entryOf(join(folder, relative))
    } catch (error) {
      if (error instanceof TreeUnreadable) throw error
      if (error.code === 'ENOENT' && TREE_ROOTS.includes(relative)) return entries.push({ path: relative, type: 'absent' })
      throw new TreeUnreadable(`${relative} could not be read (${error.code ?? error.message})`)
    }
    entries.push({ path: relative, ...entry })
    if (entry.type !== 'dir') return
    let names
    try {
      names = readdirSync(join(folder, relative)).sort()
    } catch (error) {
      throw new TreeUnreadable(`${relative} could not be listed (${error.code ?? error.message})`)
    }
    for (const name of names) walk(`${relative}/${name}`)
  }
  for (const root of TREE_ROOTS) walk(root)
  return { entries, sha256: sha256(canonicalJson(entries)) }
}

/** What a receipt keeps of the run's files: the digest of the whole manifest at the check. */
export function treeDigests(folder) {
  return { tree: runTree(folder).sha256 }
}

/** The file beside the run's roots that keeps the judged manifest, pinned by the receipt's digest (not bound, not part of the tree). */
export const TREE_FILE = 'tree.json'

/**
 * Why the run's files are not the ones the check judged, or null. `phase` `check` allows no
 * difference; `started` (after the app's own start steps, and in the supervisor) allows only the
 * additions the app's form declares, read entry by entry against the judged manifest in `tree.json`,
 * which must be the very one the receipt's digest names.
 */
export function treeChange(folder, receipt, phase = 'check') {
  const expected = receipt.snapshots?.tree
  if (typeof expected !== 'string') return 'the receipt holds no manifest of the run'
  let now
  try {
    now = runTree(folder)
  } catch (error) {
    return `the run could not be read whole (${error.message})`
  }
  if (now.sha256 === expected) return null
  let judged = null
  try {
    const recorded = JSON.parse(readFileSync(join(folder, TREE_FILE), 'utf8'))
    if (sha256(canonicalJson(recorded)) === expected) judged = recorded
  } catch {
    judged = null
  }
  if (judged === null) return 'the run\'s files are not the ones the check judged, and its judged manifest is gone or changed'
  const allowed = phase === 'started' ? ALLOWANCES[receipt.harness] ?? null : null
  // A root recorded as absent is named as added when it appears, and as gone when it disappears.
  const present = (entry) => entry.type !== 'absent'
  const before = new Map(judged.filter(present).map((entry) => [entry.path, entry]))
  const after = new Map(now.entries.filter(present).map((entry) => [entry.path, entry]))
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(path)
    const is = after.get(path)
    if (was !== undefined && is !== undefined && canonicalJson(was) === canonicalJson(is)) continue
    if (allowed !== null && is !== undefined && allowed(path, is) && (was === undefined || (was.type === 'file' && is.type === 'file'))) continue
    return `the run's ${path} ${was === undefined ? 'was added after the check' : is === undefined ? 'is gone since the check' : 'is not the one the check judged'}`
  }
  return null
}
