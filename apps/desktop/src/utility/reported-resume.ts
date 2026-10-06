// MODULE: reported-resume.ts - where a program's reported resume command runs from (Epic 43)
import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { findWindowsExecutable } from './windows-launch'

/**
 * The file a plain command name runs from on `path`: the first absolute directory holding an executable regular file
 * by that name, or null. A relative entry would resolve against whatever folder BMN happens to be in, so it is never
 * searched; nor is a directory that happens to carry the name.
 */
export function findProgramOnPath(name: string, path: string): string | null {
  if (process.platform === 'win32') return findWindowsExecutable(name, process.cwd(), { ...process.env, PATH: path })
  for (const directory of path.split(':')) {
    if (!directory.startsWith('/')) continue
    const candidate = join(directory, name)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here.
    }
  }
  return null
}

/** The named reason a reported command cannot run any more; Resume offers Start again with it. */
export function missingProgramReason(name: string): string {
  return `"${name}" is no longer on this session's PATH, so the command it reported cannot run. Start again runs the ` +
    `session's saved command instead.`
}
