import { spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { effectiveTerminalGraphics, type TerminalGraphicsChoice } from '@bmn/protocol'
import { replaceFileSync } from './file-replace'

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
    replaceFileSync(temporary, target)
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
export function sixelTerminfoReady(asset: TerminfoAsset, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const target = join(asset.directory, 'x', SIXEL_TERM)
    const entry = readFileSync(target)
    if (!entry.equals(readFileSync(asset.source))) return false
    if (platform === 'win32') {
      // Native Windows programs do not use the Linux ncurses search path. Check
      // the packaged compiled identity; WSL must resolve its own installed entry.
      if (entry.length < 12 || ![0x011a, 0x021e].includes(entry.readUInt16LE(0))) return false
      const namesLength = entry.readUInt16LE(2)
      if (namesLength < 2 || 12 + namesLength > entry.length || entry[11 + namesLength] !== 0) return false
      return entry.subarray(12, 11 + namesLength).toString('utf8').split('|').includes(SIXEL_TERM)
    }
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
  environment: Readonly<Record<string, string | undefined>>,
  asset?: TerminfoAsset,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  if (effectiveTerminalGraphics(choice) !== 'sixel' || !asset || !sixelTerminfoReady(asset, platform)) {
    return { TERM: STANDARD_TERM }
  }
  if (platform === 'win32') return { TERM: SIXEL_TERM }
  return {
    TERM: SIXEL_TERM,
    TERMINFO_DIRS: terminfoDirectories(asset.directory, environment)
  }
}
