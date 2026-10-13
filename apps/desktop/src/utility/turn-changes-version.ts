// MODULE: turn-changes-version.ts - reads which version of an app a session's foreground process runs, by asking that very program, away from a prompt's path (Epic 69, docs/turn-changes.md)
import { execFile } from 'node:child_process'
import { readFileSync, readlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { TURN_CAPTURE_LIMIT_MS } from '@bmn/protocol'
import { foregroundProcessFolder } from './foreground-process'

/** How each recorded app answers `--version`: `2.1.296 (Claude Code)`, `codex-cli 0.162.1`. An answer of another shape is another program's. */
const ANSWERS: Readonly<Record<string, RegExp | undefined>> = Object.freeze({
  claude: /^(\d+\.\d+\.\d+[0-9A-Za-z.+-]*) \(Claude Code\)\s*$/,
  codex: /^codex-cli (\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\s*$/
})

/** The version in an app's own answer, or null when the answer is not that app's. */
export function turnAppVersion(app: string, answer: string): string | null {
  return ANSWERS[app]?.exec(answer.slice(0, 256))?.[1] ?? null
}

/** What Linux says confines a process: the view of the file system it lives in, whether it gave up new privileges, and whether a system-call filter is on it. */
function confinement(procRoot: string, pid: number | 'self'): string | null {
  try {
    const status = readFileSync(`${procRoot}/${pid}/status`, 'utf8')
    const flag = (name: string): string | null => new RegExp(`^${name}:\\s*(\\d+)$`, 'm').exec(status)?.[1] ?? null
    const privileges = flag('NoNewPrivs')
    const filter = flag('Seccomp')
    if (privileges === null || filter === null) return null
    return `${readlinkSync(`${procRoot}/${pid}/ns/mnt`)} ${privileges} ${filter}`
  } catch {
    return null
  }
}

/**
 * Whether BMN may run the program a foreground process is. Only for a process as free as BMN itself: one that
 * lives in another view of the file system (a container, a sandbox), that gave up new privileges (Landlock asks
 * for that) or that has a system-call filter on it may be a sandboxed agent's own, and a program BMN starts runs
 * outside that sandbox. The program must also still be the very file the identity names.
 */
export function mayAskProgram(identity: string, procRoot: string = '/proc'): boolean {
  const [, pidText, , device, inode] = identity.split(':')
  const pid = Number(pidText)
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    const own = confinement(procRoot, 'self')
    if (own === null || confinement(procRoot, pid) !== own) return false
    const program = statSync(`${procRoot}/${pid}/exe`, { bigint: true })
    return String(program.dev) === device && String(program.ino) === inode
  } catch {
    return false
  }
}

/**
 * Runs the program a foreground process is (`/proc/<pid>/exe`) with `--version` and reads the app's version from
 * its answer. Null when BMN may not run it, when the process is gone or another one by now, when it does not
 * answer in time, or when the answer is not that app's: a turn then reads "Ordering unverified".
 */
export function readAppVersion(identity: string, app: string, limitMs: number = TURN_CAPTURE_LIMIT_MS): Promise<string | null> {
  const [, pidText] = identity.split(':')
  const pid = Number(pidText)
  if (process.platform !== 'linux' || ANSWERS[app] === undefined) return Promise.resolve(null)
  if (!mayAskProgram(identity)) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      execFile(`/proc/${pid}/exe`, ['--version'], { timeout: limitMs, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', HOME: homedir() } }, (error, stdout) => {
        // The process must still be the one the identity names: a reused process id would lend another program's answer.
        resolve(error || foregroundProcessFolder(identity) === null ? null : turnAppVersion(app, String(stdout)))
      })
    } catch {
      resolve(null)
    }
  })
}
