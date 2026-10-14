// MODULE: agents-team-supervisor.mjs - Epic 72: the supervisor of one teammate's ask. Started by the asking command inside its own restrictions, it outlives that command, holds the deadline and Stop, and ends the whole container with itself
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processLives, processStart } from './agents-supervised.mjs'

/**
 * An ask can run for many minutes, and the command, tool call or window that asked may close long
 * before (R72-FR4, 72.3 AC3). So the asking command never runs the app itself: it writes the run's
 * launch into the run's folder and starts this supervisor, detached, in a session of its own. The
 * supervisor is a child of the asking process, so it has exactly the asker's restrictions: a
 * sandboxed asker's supervisor cannot do more than the asker could (R72-NFR4). It starts the
 * container, holds the deadline and Stop, keeps the run's output in the run's folder, and when the
 * container ends it calls the run's finish step and ends itself. The container's first process lives
 * in a PID namespace of its own and dies with its parent (bwrap --die-with-parent), so the end of the
 * supervisor, however it ends, ends every process of the run, also one that left the process group.
 * A supervisor that died leaves its state saying so; nobody starts the run again (72.4 AC2).
 */

const NAME = 'agents-team-supervisor.mjs'
const SUPERVISE = '--supervise-ask'
/** How long a container asked to end may take before it is made to. */
export const KILL_AFTER_MS = 3000
/** How often the supervisor looks for the run's Stop file. */
const STOP_POLL_MS = 250

export const RUN_FILES = Object.freeze({
  launch: 'launch.json', state: 'state.json', stop: 'stop', events: 'events.jsonl', stderr: 'stderr.txt', exit: 'exit.json', args: 'bwrap-args'
})

/** Writes a file whole: a reader sees the old text or the new one, never a part. */
export function writeWhole(path, text) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Where this file lies as a program, as agents-supervised.mjs finds its own. */
export function teamSupervisorScript() {
  const own = dirname(fileURLToPath(import.meta.url))
  const places = [join(own, NAME), ...(typeof process.resourcesPath === 'string' ? [join(process.resourcesPath, 'bin', NAME)] : []), join(own, '..', '..', 'bin', NAME)]
  return places.find((place) => existsSync(place)) ?? null
}

/**
 * Starts the supervisor of the run in `folder`, whose `launch.json` says what to run:
 * `{ argv, deadline, stdin, finish, args_fd, output_limit }` (`finish`: a module path and export name the
 * supervisor calls with the folder once the container has ended, or null; `args_fd`: give bubblewrap its
 * arguments on a file descriptor; `output_limit`: the bytes of raw output over which the run fails).
 * Returns `{ pid, start }` or `{ failed }`.
 * The supervisor is detached and in a session of its own: closing the asking command leaves it running.
 */
export function startTeamSupervisor(folder, { execPath = process.execPath } = {}) {
  const script = teamSupervisorScript()
  if (script === null) return { failed: 'BMN\'s ask supervisor file is missing' }
  let child
  try {
    child = spawn(execPath, [script, SUPERVISE, folder], {
      cwd: folder, detached: true, stdio: 'ignore', env: process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }
    })
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) }
  }
  if (child.pid === undefined) return { failed: 'the supervisor could not be started' }
  child.unref()
  const start = processStart(child.pid)
  return start === null ? { failed: 'the supervisor ended at once' } : { pid: child.pid, start }
}

/** Asks the run's supervisor to stop the run: the Stop file, which it looks for every quarter second. */
export function requestStop(folder) {
  writeWhole(join(folder, RUN_FILES.stop), `${new Date().toISOString()}\n`)
}

/**
 * What a run's folder says of it now: `ended` with the supervisor's exit record, `running` (or
 * `starting`, `finishing`) while the supervisor it names lives, or `interrupted` when that
 * supervisor is gone without a record. An interrupted run is only ever reported, never started again.
 */
export function runState(folder) {
  const read = (name) => {
    try {
      return readJson(join(folder, name))
    } catch {
      return null
    }
  }
  const exit = read(RUN_FILES.exit)
  const state = read(RUN_FILES.state)
  if (state?.state === 'ended') return { state: 'ended', exit }
  if (state === null) return { state: exit === null ? 'unknown' : 'interrupted', exit }
  if (supervisorLives(state.supervisor)) return { state: state.state, exit }
  return { state: 'interrupted', exit, was: state.state }
}

/** Whether a run's supervisor still runs: the very process its state names, and not one that has died but not yet been reaped. */
export function supervisorLives(identity) {
  if (!processLives(identity)) return false
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// The supervisor

async function supervise(folder) {
  const launch = readJson(join(folder, RUN_FILES.launch))
  const state = { version: 1, state: 'starting', supervisor: { pid: process.pid, start: processStart(process.pid) }, started_at: new Date().toISOString() }
  const save = () => writeWhole(join(folder, RUN_FILES.state), `${JSON.stringify(state)}\n`)
  save()
  let ended = null
  let child = null
  const finish = async (exit) => {
    writeWhole(join(folder, RUN_FILES.exit), `${JSON.stringify({ version: 1, ...exit, ended: ended ?? (exit.code === 0 ? 'done' : 'failed'), at: new Date().toISOString() })}\n`)
    state.state = 'finishing'
    save()
    if (launch.finish) {
      try {
        const module = await import(launch.finish.module)
        await module[launch.finish.export](folder)
      } catch (error) {
        state.finish_error = error instanceof Error ? error.message : String(error)
      }
    }
    state.state = 'ended'
    state.ended_at = new Date().toISOString()
    save()
    process.exit(0)
  }
  if (existsSync(join(folder, RUN_FILES.stop))) {
    ended = 'stopped'
    return finish({ code: null, signal: null, started: false })
  }
  if (!(launch.deadline > Date.now())) {
    ended = 'limit'
    return finish({ code: null, signal: null, started: false })
  }
  const input = launch.stdin ? openSync(launch.stdin, 'r') : 'ignore'
  const output = openSync(join(folder, RUN_FILES.events), 'a', 0o600)
  const errors = openSync(join(folder, RUN_FILES.stderr), 'a', 0o600)
  // bubblewrap reads its own options (what the container shows, its environment) from a file descriptor
  // (--args), so none of them is on its command line; the app's command after `--` stays there, as the app's own.
  let args = null
  let argv = launch.argv.slice(1)
  const dashes = argv.indexOf('--')
  if (launch.args_fd === true && dashes !== -1) {
    const path = join(folder, RUN_FILES.args)
    writeFileSync(path, argv.slice(0, dashes).map((argument) => `${argument}\0`).join(''), { mode: 0o600 })
    args = openSync(path, 'r')
    unlinkSync(path)
    argv = ['--args', '3', ...argv.slice(dashes)]
  }
  try {
    // A process group of its own; the container's own namespace holds everything the app starts.
    child = spawn(launch.argv[0], argv, { env: {}, stdio: args === null ? [input, output, errors] : [input, output, errors, args], detached: true })
  } finally {
    for (const handle of [input, output, errors, args]) if (typeof handle === 'number') closeSync(handle)
  }
  let asked = false
  const group = (signal) => {
    try {
      process.kill(-child.pid, signal)
    } catch {
      // Already gone.
    }
  }
  const end = (why) => {
    ended ??= why
    if (asked) return
    asked = true
    group('SIGTERM')
    setTimeout(() => group('SIGKILL'), KILL_AFTER_MS).unref()
  }
  child.on('error', (error) => {
    ended ??= 'failed'
    state.launch_error = error.message
    void finish({ code: null, signal: null, started: false })
  })
  child.on('exit', (code, signal) => {
    clearInterval(watch)
    clearTimeout(timer)
    // What the container left goes with it: its namespace ends with its first process, and the group is killed besides.
    group('SIGKILL')
    void finish({ code, signal: signal ?? null, signal_number: signal ? constants.signals[signal] ?? null : null, started: true })
  })
  state.state = 'running'
  state.child = { pid: child.pid, start: processStart(child.pid) }
  save()
  const watch = setInterval(() => {
    if (existsSync(join(folder, RUN_FILES.stop))) end('stopped')
    // The app's raw output is bounded: over the bound the run fails, its output kept as it was.
    if (typeof launch.output_limit === 'number') {
      const size = [RUN_FILES.events, RUN_FILES.stderr].reduce((sum, name) => {
        try {
          return sum + statSync(join(folder, name)).size
        } catch {
          return sum
        }
      }, 0)
      if (size > launch.output_limit) end('output')
    }
  }, STOP_POLL_MS)
  const timer = setTimeout(() => end('limit'), Math.min(Math.max(0, launch.deadline - Date.now()), 2 ** 31 - 1))
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, () => end('stopped'))
}

if (basename(process.argv[1] ?? '') === NAME && process.argv[2] === SUPERVISE) void supervise(process.argv[3])
