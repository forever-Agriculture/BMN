// MODULE: agents-team-nested.mjs - Epic 72: whether a process runs inside a teammate's ask, told from its PID namespace, which no child can clear or forge
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * A teammate's run may not launch, control or read asks, research or the judge (R72-NFR4, 72.4
 * AC4). Its container already holds no BMN command, state folder or app socket; this is the second
 * wall. Each ask's supervisor writes its container's PID namespace into BMN's state while the run
 * goes on, and every BMN command looks up its own: a process inside an ask's namespace is refused,
 * however it clears its environment or labels itself, because the namespace is the kernel's, not a
 * marker the process carries. This module stays small: every `bmn` command loads it first.
 */

/** BMN's runs folder as agents-check.mjs's teamRunsDirectory() names it, without loading the check. */
export function defaultRunsDirectory() {
  return join(homedir(), '.config/bmn/agents/state/team/runs')
}

/** Where running asks' namespaces are written: one file per namespace, holding the run's id. */
export function namespaceIndex(runs = defaultRunsDirectory()) {
  return join(runs, '.namespaces')
}

/** The number of a namespace link (`pid:[4026533077]`), or null. */
export function namespaceNumber(link) {
  return /^pid:\[(\d+)\]$/u.exec(link ?? '')?.[1] ?? null
}

/**
 * The PID namespace of a running ask's container, as its supervisor finds it: bubblewrap's child
 * runs in the namespace the container made. Null when it cannot be read (yet).
 */
export function childNamespace(pid) {
  let children
  try {
    children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/u).filter(Boolean)
  } catch {
    return null
  }
  for (const child of children) {
    try {
      return readlinkSync(`/proc/${child}/ns/pid`)
    } catch {
      // Gone already; the next one.
    }
  }
  return null
}

/** The supervisor names its run's namespace while the run goes on, and takes the name back at its end. */
export function nameNamespace(runs, link, id) {
  const number = namespaceNumber(link)
  if (number === null) return null
  mkdirSync(namespaceIndex(runs), { recursive: true, mode: 0o700 })
  writeFileSync(join(namespaceIndex(runs), number), `${id}\n`, { mode: 0o600 })
  return number
}

export function forgetNamespace(runs, link) {
  const number = namespaceNumber(link)
  if (number !== null) rmSync(join(namespaceIndex(runs), number), { force: true })
}

/**
 * Where to look: BMN's runs folder under HOME; and where HOME holds no BMN folder (a child that set
 * HOME elsewhere, or cleared it), under the account's own home from the system's user database, which
 * a child cannot change.
 */
function runsDirectories() {
  const places = [defaultRunsDirectory()]
  if (!existsSync(join(homedir(), '.config/bmn/agents'))) {
    try {
      places.push(join(userInfo().homedir, '.config/bmn/agents/state/team/runs'))
    } catch {
      // No user database entry: HOME's alone.
    }
  }
  return [...new Set(places)]
}

/** The id of the ask this process runs inside, or null. `runs` names one runs folder to look in instead of both homes'. */
export function nestedAsk(runs = undefined, self = '/proc/self/ns/pid') {
  let number
  try {
    number = namespaceNumber(readlinkSync(self))
  } catch {
    return null
  }
  if (number === null) return null
  for (const folder of runs === undefined ? runsDirectories() : [runs]) {
    const path = join(namespaceIndex(folder), number)
    if (!existsSync(path)) continue
    try {
      return readFileSync(path, 'utf8').trim() || 'unknown'
    } catch {
      return 'unknown'
    }
  }
  return null
}

/** The refusal every BMN command gives inside an ask. */
export function nestedWords(id) {
  return `bmn: NESTED: this runs inside teammate ask ${id}; a teammate's run may not launch, control or read asks, research, the judge or BMN's app`
}
