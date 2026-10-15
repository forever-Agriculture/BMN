// MODULE: agents-team-nested.mjs - Epic 72: whether a process runs inside a teammate's ask, told from the ask's systemd user scope, a cgroup no process of the run can leave or rename
import { readFileSync } from 'node:fs'

/**
 * A teammate's run may not launch, control or read asks, research or the judge (R72-NFR4, 72.4
 * AC4). The teammate's own read-only mode already keeps it from writing BMN's state; this is the
 * second wall. Every ask runs in a systemd user scope of its own, `bmn-ask-<run id>.scope` (72.9),
 * and everything the app starts stays in that cgroup: setsid, double forks and nohup do not leave
 * it, and Codex's own sandbox keeps the cgroup in view (measured 2026-10-15). So every BMN command
 * reads its own cgroup, and a process inside an ask's scope is refused, however it clears its
 * environment or labels itself. This module stays small: every `bmn` command loads it first.
 */

/** The name of an ask's scope unit: this, the run's id, then `.scope`. */
export const ASK_SCOPE_PREFIX = 'bmn-ask-'

const SCOPE = /\/bmn-ask-([^/]+)\.scope(?:\/|$)/u

/** The ask a cgroup path lies in (`.../bmn-ask-<id>.scope[/...]`), or null. */
export function scopeAsk(path) {
  return SCOPE.exec(path ?? '')?.[1] ?? null
}

/** The id of the ask this process runs inside, or null. `self` is the process's cgroup file. */
export function nestedAsk(self = '/proc/self/cgroup') {
  let text
  try {
    text = readFileSync(self, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    // `hierarchy:controllers:path`; cgroup v2's one line is `0::<path>`.
    const path = line.split(':').slice(2).join(':')
    const id = scopeAsk(path)
    if (id !== null) return id
  }
  return null
}

/** The refusal every BMN command gives inside an ask. */
export function nestedWords(id) {
  return `bmn: NESTED: this runs inside teammate ask ${id}; a teammate's run may not launch, control or read asks, research, the judge or BMN's app`
}
