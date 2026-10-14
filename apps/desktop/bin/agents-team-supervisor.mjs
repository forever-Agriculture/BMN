// MODULE: agents-team-supervisor.mjs - Epic 72: the supervisor of one teammate's ask. Started by the asking command inside its own restrictions, it outlives that command, holds the deadline and Stop, and ends the whole container with itself
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  launch: 'launch.json', state: 'state.json', stop: 'stop', events: 'events.jsonl', stderr: 'stderr.txt', exit: 'exit.json'
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
 * `{ argv, deadline, stdin, finish }` (`finish`: a module path and export name the supervisor calls
 * with the folder once the container has ended, or null). Returns `{ pid, start }` or `{ failed }`.
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
  if (processLives(state.supervisor)) return { state: state.state, exit }
  return { state: 'interrupted', exit, was: state.state }
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
  try {
    // A process group of its own; the container's own namespace holds everything the app starts.
    child = spawn(launch.argv[0], launch.argv.slice(1), { env: {}, stdio: [input, output, errors], detached: true })
  } finally {
    for (const handle of [input, output, errors]) if (typeof handle === 'number') closeSync(handle)
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
  }, STOP_POLL_MS)
  const timer = setTimeout(() => end('limit'), Math.min(Math.max(0, launch.deadline - Date.now()), 2 ** 31 - 1))
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, () => end('stopped'))
}

if (basename(process.argv[1] ?? '') === NAME && process.argv[2] === SUPERVISE) void supervise(process.argv[3])
