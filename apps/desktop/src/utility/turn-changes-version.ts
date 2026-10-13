// MODULE: turn-changes-version.ts - reads which version of an app a session's foreground process runs, by asking that very program, away from a prompt's path (Epic 69, docs/turn-changes.md)
import { execFile } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { TURN_CAPTURE_LIMIT_MS } from '@bmn/protocol'
import { foregroundProcessFolder } from './foreground-process'

/** How each recorded app answers `--version`: `2.1.296 (Claude Code)`, `codex-cli 0.162.1`. An answer of another shape is another program's. */
const ANSWERS: Readonly<Record<string, RegExp | undefined>> = Object.freeze({
  claude: /^(\d+\.\d+\.\d+[0-9A-Za-z.+-]*) \(Claude Code\)\s*$/,
  codex: /^codex-cli (\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\s*$/
})

/** How many programs a foreground process started may be asked. An app's launcher starts one. */
const STARTED_LIMIT = 8

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
 * The processes a foreground process started itself that still share the terminal's foreground with it, each
 * named the way a foreground process is. An app installed as a launcher runs its real program as one of them:
 * Codex from npm is a Node script whose one child is the native `codex`. What those children start in turn (an
 * agent's commands) is not looked at.
 */
export function startedPrograms(identity: string, procRoot: string = '/proc'): string[] {
  const [tty, pidText] = identity.split(':')
  const pid = Number(pidText)
  if (!tty || !Number.isSafeInteger(pid) || pid <= 0) return []
  try {
    const children = new Set<number>()
    for (const task of readdirSync(`${procRoot}/${pid}/task`)) {
      try {
        for (const child of readFileSync(`${procRoot}/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/)) {
          if (/^[1-9]\d*$/.test(child)) children.add(Number(child))
        }
      } catch {
        // A thread that ended meanwhile started nothing that is still its own.
      }
    }
    const named: string[] = []
    for (const child of [...children].sort((a, b) => a - b).slice(0, STARTED_LIMIT)) {
      try {
        const text = readFileSync(`${procRoot}/${child}/stat`, 'utf8')
        // comm can contain spaces and parentheses. The fields following its final ')' are fixed.
        const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
        const start = fields[19]
        // Its parent's own child, still in the terminal's foreground with it, neither stopped nor ended.
        if (Number(fields[1]) !== pid || Number(fields[2]) !== pid || fields[4] !== tty || !start || !/^\d+$/.test(start) ||
          !fields[0] || ['T', 't', 'Z', 'X'].includes(fields[0])) continue
        const program = statSync(`${procRoot}/${child}/exe`, { bigint: true })
        named.push(`${tty}:${child}:${start}:${program.dev}:${program.ino}`)
      } catch {
        // Gone by now.
      }
    }
    return named
  } catch {
    return []
  }
}

/**
 * Runs the program one process is (`/proc/<pid>/exe`) with `--version` and gives its answer. Null when BMN may
 * not run it or cannot read it, when it does not answer in time, or when the process is gone or another one by
 * now. The program is opened first, the open file is compared with the one the identity names, and that same
 * open file is what runs: a process that becomes another program in between, or another process that took its
 * id, cannot have its program run in place of the one that was compared.
 */
function askProgram(identity: string, limitMs: number): Promise<string | null> {
  const [, pidText, , device, inode] = identity.split(':')
  const pid = Number(pidText)
  if (!mayAskProgram(identity)) return Promise.resolve(null)
  return new Promise((resolve) => {
    let held: number | null = null
    const answer = (text: string | null): void => {
      if (held !== null) {
        try {
          closeSync(held)
        } catch {
          // Already closed.
        }
        held = null
      }
      resolve(text)
    }
    try {
      held = openSync(`/proc/${pid}/exe`, constants.O_RDONLY)
      const program = fstatSync(held, { bigint: true })
      if (String(program.dev) !== device || String(program.ino) !== inode) {
        answer(null)
        return
      }
      execFile(`/proc/${process.pid}/fd/${held}`, ['--version'], { timeout: limitMs, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', HOME: homedir() } }, (error, stdout) => {
        // The process must still be the one the identity names: a reused process id would lend another program's answer.
        answer(error || foregroundProcessFolder(identity) === null ? null : String(stdout))
      })
    } catch {
      answer(null)
    }
  })
}

/** What a test puts in place of the question and of the list of started programs. */
export interface VersionSeams {
  ask?: (identity: string, limitMs: number) => Promise<string | null>
  started?: (identity: string) => string[]
}

/**
 * Reads the app's version from the answer of the program a foreground process is. When that answer is another
 * program's (a launcher's), the programs that process started itself are asked the same way, one after another
 * inside the same time, and one of them counts only while it is still that process's own. Null when no answer is
 * the app's: a turn then reads "Ordering unverified".
 */
export async function readAppVersion(identity: string, app: string, limitMs: number = TURN_CAPTURE_LIMIT_MS, seams: VersionSeams = {}): Promise<string | null> {
  if (process.platform !== 'linux' || ANSWERS[app] === undefined) return null
  const ask = seams.ask ?? askProgram
  const started = seams.started ?? startedPrograms
  const end = Date.now() + limitMs
  const own = turnAppVersion(app, await ask(identity, limitMs) ?? '')
  if (own !== null) return own
  for (const candidate of started(identity)) {
    const left = end - Date.now()
    if (left <= 0) break
    const version = turnAppVersion(app, await ask(candidate, left) ?? '')
    if (version !== null) return started(identity).includes(candidate) ? version : null
  }
  return null
}
