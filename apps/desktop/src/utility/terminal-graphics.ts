import { spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { effectiveTerminalGraphics, type TerminalGraphicsChoice } from '@bmn/protocol'

export const SIXEL_TERM = 'xterm-sixel-256color'
export const STANDARD_TERM = 'xterm-256color'

export interface TerminfoAsset {
  directory: string
  source: string
}

/** Install into the profile's stable data root, outside an app package replaced by updates. */
export function installBundledTerminfo(dataRoot: string, source: string): TerminfoAsset {
  const directory = join(dataRoot, 'terminfo')
  const entryDirectory = join(directory, 'x')
  mkdirSync(entryDirectory, { recursive: true, mode: 0o700 })
  const target = join(entryDirectory, SIXEL_TERM)
  const bundled = readFileSync(source)
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, bundled, { mode: 0o600 })
    renameSync(temporary, target)
    if (!readFileSync(target).equals(bundled)) throw new Error('Bundled terminfo copy did not verify')
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* no partial entry to retain */ }
    throw error
  }
  return { directory, source }
}

export function terminfoDirectories(
  directory: string,
  environment: Readonly<Record<string, string | undefined>>
): string {
  // Empty components retain the ncurses system defaults; an explicit HOME path preserves that lookup too.
  return [directory, environment.TERMINFO_DIRS ?? '', join(environment.HOME ?? homedir(), '.terminfo'), ''].join(':')
}

/** A missing, altered or unresolvable entry never permits a Sixel TERM claim. */
export function sixelTerminfoReady(asset: TerminfoAsset): boolean {
  try {
    const target = join(asset.directory, 'x', SIXEL_TERM)
    if (!readFileSync(target).equals(readFileSync(asset.source))) return false
    const probe = spawnSync('infocmp', ['-A', asset.directory, SIXEL_TERM], {
      encoding: 'utf8', timeout: 1500, maxBuffer: 128 * 1024,
      env: { ...process.env, TERMINFO: undefined, TERMINFO_DIRS: `${asset.directory}:` }
    })
    return probe.status === 0 && probe.stdout.includes(SIXEL_TERM)
  } catch {
    return false
  }
}

export function terminalGraphicsEnvironment(
  choice: TerminalGraphicsChoice,
  executable: string,
  environment: Readonly<Record<string, string | undefined>>,
  asset?: TerminfoAsset
): Record<string, string> {
  if (effectiveTerminalGraphics(choice, executable) !== 'sixel' || !asset || !sixelTerminfoReady(asset)) {
    return { TERM: STANDARD_TERM }
  }
  return {
    TERM: SIXEL_TERM,
    TERMINFO_DIRS: terminfoDirectories(asset.directory, environment)
  }
}
