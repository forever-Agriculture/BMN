// MODULE: app-program.ts - Epic 60.6: which program PATH selects for an agent app, past BMN's own commands, so Health can show it and its update command
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** The entry PATH selects, and where it leads when it is a link. */
interface AppProgram { path: string; target?: string }

/**
 * The first executable file named `command` on `pathVariable`, the way a shell would find it, with
 * two differences that keep the answer the same from anywhere: an entry that is not an absolute
 * folder is skipped (it would depend on where BMN was started), and so is `skip`, the folder of
 * BMN's own commands, in any spelling (its `codex` only hands over to the next one on PATH).
 */
export function findAppProgram(command: string, pathVariable: string | undefined, skip: string | null): AppProgram | null {
  let own: string | null = null
  if (skip !== null) {
    try {
      own = realpathSync(skip)
    } catch {
      own = null
    }
  }
  for (const entry of (pathVariable ?? '').split(':')) {
    if (!isAbsolute(entry)) continue
    const candidate = join(entry, command)
    try {
      if (own !== null && realpathSync(entry) === own) continue
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      const real = realpathSync(candidate)
      return real === candidate ? { path: candidate } : { path: candidate, target: real }
    } catch {
      continue
    }
  }
  return null
}
