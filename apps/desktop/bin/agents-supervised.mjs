// MODULE: agents-supervised.mjs - Epic 64: a checked command run under a supervisor of its own, which ends the command when BMN's process ends, at the deadline or on Stop. Run as a program, this file is that supervisor
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { constants } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A research run is an agent app that can run for minutes. The process that started it holds its
 * time limit and its Stop, so a process killed outright would leave the app running with neither
 * (R64-NFR3). So BMN never starts the app itself. It starts this supervisor, which starts nothing
 * until it is told to; BMN writes the supervisor's process into the research lock, and only then
 * says go. The supervisor holds one end of a pipe whose other end only BMN's process holds: when
 * that process ends, however it ends, the pipe closes and the supervisor ends the app's whole
 * process group before it ends itself. The lock counts as held for as long as BMN's process or a
 * supervisor it names lives, so nobody starts a second research beside an app that is still going.
 * A child of the app that leaves the app's process group is outside this, as it is outside Stop.
 */

const NAME = 'agents-supervised.mjs'
const SUPERVISE = '--supervise'
/** How long a command asked to end may take before it is made to. */
const KILL_AFTER_MS = 3000
/** The supervisor's code when it ended without starting the command: BMN ended, or the time had passed. */
export const NOTHING_STARTED = 125
const NOT_FOUND = 127

/** When a process started, in the kernel's own count, or null when there is no such process. A number that was given out again reads differently. */
export function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The program's name may hold spaces and brackets; the fields are counted after its closing one.
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    return /^\d+$/.test(start ?? '') ? start : null
  } catch {
    return null
  }
}

/** Whether the very process a record names still runs: its number and the start time it had then. */
export function processLives(identity) {
  return identity !== null && typeof identity === 'object' && Number.isInteger(identity.pid) && identity.pid > 1 && typeof identity.start === 'string' && processStart(identity.pid) === identity.start
}

/**
 * Where this file lies as a program: beside the module for the command line, in the packaged app's
 * `bin` folder, or in the app's `bin` folder beside its built files. Null when it is in none.
 */
export function supervisorScript() {
  const own = dirname(fileURLToPath(import.meta.url))
  const places = [join(own, NAME), ...(typeof process.resourcesPath === 'string' ? [join(process.resourcesPath, 'bin', NAME)] : []), join(own, '..', '..', 'bin', NAME)]
  return places.find((place) => existsSync(place)) ?? null
}

/**
 * Starts `argv` under a supervisor, in `cwd`, with an empty environment and the three standard
 * streams given in `stdio`. `deadline` is the moment the command is ended at the latest, also with
 * BMN gone. `register` gets the supervisor's process before anything is started and writes it where
 * the lock is; when it throws, nothing is started. Returns `{ child, stop, kill }`, the supervisor's
 * own process and the two ways to end the command (asked first, or at once), with `failed` and the
 * reason when the command was never started; or `{ failed }` alone when no supervisor could be made.
 */
export function startSupervised(argv, { cwd, stdio, deadline, register = () => {} }) {
  const script = supervisorScript()
  if (script === null) return { failed: 'BMN\'s own supervisor file is missing' }
  let child
  try {
    // The supervisor runs on BMN's own runtime; inside the desktop app that is the app's binary, run as plain Node for this one process.
    child = spawn(process.execPath, [script, SUPERVISE, String(deadline), ...argv], {
      cwd, env: process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }, stdio: [...stdio, 'pipe'], detached: true
    })
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) }
  }
  const control = child.stdio[3]
  // A supervisor that has ended takes no more words: that is no error of the caller's.
  control.on('error', () => {})
  const say = (word) => {
    try {
      if (!control.destroyed) control.write(`${word}\n`)
    } catch {
      // The supervisor is gone, and the command with it.
    }
  }
  const handle = { child, stop: () => say('stop'), kill: () => say('kill') }
  // No such program: the caller hears it from the process's own error.
  if (child.pid === undefined) return handle
  try {
    const start = processStart(child.pid)
    if (start === null) throw new Error('its process could not be read')
    register({ pid: child.pid, start })
  } catch (error) {
    // The pipe closes before go: the supervisor ends and starts nothing.
    control.destroy()
    return { ...handle, failed: `the run was not started, because BMN could not write down its process: ${error instanceof Error ? error.message : String(error)}` }
  }
  say('go')
  return handle
}

// ---------------------------------------------------------------------------------------------
// The supervisor

function supervise([deadlineText, ...command]) {
  const deadline = Number(deadlineText)
  let child = null
  let asked = false
  const group = (signal) => {
    try {
      process.kill(-child.pid, signal)
    } catch {
      // Already gone.
    }
  }
  /** Ends the command: asked first and then made to, or at once when nobody waits for a tidy end. */
  const end = (atOnce) => {
    if (child === null) process.exit(NOTHING_STARTED)
    if (atOnce) return group('SIGKILL')
    if (asked) return
    asked = true
    group('SIGTERM')
    setTimeout(() => group('SIGKILL'), KILL_AFTER_MS)
  }
  const launch = () => {
    if (child !== null) return
    if (Number.isNaN(deadline) || Date.now() >= deadline) process.exit(NOTHING_STARTED)
    try {
      // A process group of its own, so the command and everything it starts end together. The pipe to BMN is not passed on.
      child = spawn(command[0], command.slice(1), { env: {}, stdio: [0, 1, 2], detached: true })
    } catch {
      process.exit(NOT_FOUND)
    }
    child.on('error', () => process.exit(NOT_FOUND))
    child.on('exit', (code, signal) => {
      // What the command left running goes with it; only then does the supervisor end, and the lock with it.
      group('SIGKILL')
      process.exit(code ?? 128 + (constants.signals[signal] ?? 0))
    })
    if (Number.isFinite(deadline)) setTimeout(() => end(false), Math.min(Math.max(0, deadline - Date.now()), 2 ** 31 - 1))
  }
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, () => end(false))
  const control = new Socket({ fd: 3, readable: true, writable: false })
  let words = ''
  control.setEncoding('utf8')
  control.on('data', (chunk) => {
    words += chunk
    for (let at = words.indexOf('\n'); at !== -1; at = words.indexOf('\n')) {
      const word = words.slice(0, at)
      words = words.slice(at + 1)
      if (word === 'go') launch()
      else if (word === 'stop') end(false)
      else if (word === 'kill') end(true)
    }
  })
  // BMN's process has ended, however it ended: the command ends now.
  control.on('end', () => end(true))
  control.on('error', () => end(true))
}

if (basename(process.argv[1] ?? '') === NAME && process.argv[2] === SUPERVISE) supervise(process.argv.slice(3))
