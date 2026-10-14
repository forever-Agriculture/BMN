// MODULE: turn-changes-version.ts - which version of an app a session's foreground process runs, read from where its program lies: nothing is run and no file is opened (Epic 69, docs/turn-changes.md)
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A version as an installer names it: `2.1.296`, `2.2.0-beta.1`. Nothing else: no space, no slash. */
const VERSION = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/

/**
 * Where an app's own installer puts the program a session runs, below the home folder, with the version as
 * that file's name. Story 69.1 recorded it for Claude Code: `~/.local/share/claude/versions/2.1.296`. An app
 * that is not listed keeps its version to itself: Codex's program lies where no name says it, and BMN runs
 * no program to ask. Its turns read "Ordering unverified".
 */
const INSTALLED: Readonly<Record<string, string | undefined>> = Object.freeze({ claude: '.local/share/claude/versions' })

/** What a test puts in place of `/proc` and of the home folder. */
export interface VersionPlaces {
  procRoot?: string
  home?: string
}

/**
 * The version of the app a foreground process runs, or null where the place of its program does not say it
 * for certain: a turn then reads "Ordering unverified". BMN runs nothing for this and opens no file. It looks
 * (`readlink`, `stat`) and no more, and a name counts only when all of this holds:
 * - the process lives in BMN's own view of the file system and under BMN's own root folder: in another view
 *   (a container, a sandbox) the same path names another file;
 * - its program is still the very file the identity names;
 * - the link to its program reads `<home>/<the installer's folder>/<version>` and nothing more (a program
 *   that was removed or replaced reads "… (deleted)");
 * - that path, looked at from BMN, is a plain file and that very file: not a link put there since, and not
 *   another file of that name.
 */
export function readAppVersion(identity: string, app: string, places: VersionPlaces = {}): string | null {
  const folder = INSTALLED[app]
  if (process.platform !== 'linux' || folder === undefined) return null
  const [, pidText, , device, inode] = identity.split(':')
  const pid = Number(pidText)
  if (!Number.isSafeInteger(pid) || pid <= 0 || !device || !inode) return null
  const proc = places.procRoot ?? '/proc'
  const named = (file: { dev: bigint; ino: bigint }): boolean => String(file.dev) === device && String(file.ino) === inode
  try {
    if (readlinkSync(`${proc}/${pid}/ns/mnt`) !== readlinkSync(`${proc}/self/ns/mnt`)) return null
    const root = statSync(`${proc}/${pid}/root`, { bigint: true })
    const own = statSync(`${proc}/self/root`, { bigint: true })
    if (root.dev !== own.dev || root.ino !== own.ino) return null
    if (!named(statSync(`${proc}/${pid}/exe`, { bigint: true }))) return null
    const target = readlinkSync(`${proc}/${pid}/exe`)
    // The link reads the program's real path, so the home folder is taken by its real path too.
    const prefix = `${join(realpathSync(places.home ?? homedir()), folder)}/`
    if (!target.startsWith(prefix)) return null
    const version = target.slice(prefix.length)
    if (!VERSION.test(version)) return null
    const file = lstatSync(target, { bigint: true })
    return file.isFile() && named(file) ? version : null
  } catch {
    return null
  }
}
