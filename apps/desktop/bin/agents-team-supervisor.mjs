// MODULE: agents-team-supervisor.mjs - Epic 72: the supervisor of one teammate's ask. Started by the asking command inside its own restrictions, it outlives that command, holds the deadline and Stop, and runs the app in a systemd user scope of its own that ends with it
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processLives, processStart } from './agents-supervised.mjs'
import { ASK_SCOPE_PREFIX, scopeAsk } from './agents-team-nested.mjs'
import { readJson, sha256 } from './shared-helpers.mjs'

/**
 * An ask can run for many minutes, and the command, tool call or window that asked may close long
 * before (R72-FR4, 72.3 AC3). So the asking command never runs the app itself: it writes the run's
 * launch into the run's folder and starts this supervisor, detached, in a session of its own. The
 * supervisor is a child of the asking process, so it has exactly the asker's restrictions: a
 * sandboxed asker's supervisor cannot do more than the asker could (R72-NFR4). It runs the app in a
 * systemd user scope of its own (72.9 AC3), `bmn-ask-<run id>.scope`: a cgroup everything the app
 * starts stays in, whether it leaves its process group, double forks or ignores TERM. The scope's
 * first process is a small wrapper with a parent-death signal: when the app ends it ends what the
 * app left in the scope, and when the supervisor dies, however it dies, the kernel signals the
 * wrapper and it ends the scope. Stop and the time limit end the scope the same way. When the app has
 * ended the supervisor calls the run's finish step and ends itself. A supervisor that died leaves its
 * state saying so; nobody starts the run again (72.4 AC2).
 */

const NAME = 'agents-team-supervisor.mjs'
/** BMN's own run module: its `launchCheck` every run passes immediately before the app, its `finishAsk` and `watchAsk` the only finish and watch steps. */
const RUN_MODULE = fileURLToPath(new URL('./agents-team-run.mjs', import.meta.url))
const SUPERVISE = '--supervise-ask'
/** How long a run asked to end may take before its scope is killed. */
const KILL_AFTER_MS = 3000
/** How often the supervisor looks for the run's Stop file. */
const STOP_POLL_MS = 250
/** How often it calls the run's watch step (a token ceiling), in Stop polls. */
const WATCH_EVERY = 4
/** How long the run's scope may take to appear once systemd-run is started. */
const SCOPE_WAIT_MS = 5000

export const RUN_FILES = Object.freeze({
  launch: 'launch.json', state: 'state.json', stop: 'stop', events: 'events.jsonl', stderr: 'stderr.txt', exit: 'exit.json', status: 'app-status'
})

export const SYSTEMD_RUN = '/usr/bin/systemd-run'
const SETPRIV = '/usr/bin/setpriv'
/**
 * systemd-run's options for a run's scope. It would otherwise expand `${NAME}` anywhere and a lone
 * `$NAME` in the app's arguments (systemd 259, measured 2026-10-15), so the app would not run the
 * command the check judged.
 */
export const SCOPE_OPTIONS = Object.freeze(['--user', '--scope', '--quiet', '--collect', '--expand-environment=no'])

/**
 * The run's first process in its scope (72.9 AC3): the app in the background with the prompt on its
 * standard input (dash gives a background job /dev/null unless it is handed the input on another
 * descriptor), its exit status written, and the whole scope ended when the app ends or when the
 * wrapper is signalled: by Stop, the time limit, or the supervisor's death through its parent-death
 * signal. It starts nothing when its parent is no longer the supervisor that started it: one that died
 * before setpriv set that signal would never send it.
 */
export const SCOPE_WRAPPER = `supervisor=$1 status=$2
shift 2
[ "$PPID" = "$supervisor" ] || exit 70
cg=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)
end() { echo 1 > "$cg/cgroup.kill"; }
trap end TERM HUP INT
exec 3<&0
"$@" <&3 3<&- &
wait $!
printf '%s\\n' "$?" > "$status"
end
`

/** Writes a file whole: a reader sees the old text or the new one, never a part. */
export function writeWhole(path, text) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, path)
}

/** The environment systemd-run needs to reach the owner's own systemd: his runtime folder and session bus, nothing else of the asker's. */
function scopeEnvironment(environment = process.env) {
  return {
    PATH: '/usr/bin:/bin', HOME: environment.HOME ?? homedir(),
    ...(environment.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: environment.XDG_RUNTIME_DIR } : {}),
    ...(environment.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS } : {})
  }
}

/** The scope unit of one run. */
export function scopeUnit(id) {
  return `${ASK_SCOPE_PREFIX}${id}`
}

/**
 * Whether an ask's scope starts from this process, as it is restricted now: without a systemd user
 * manager (or, in a sandbox, without its bus) the ask is refused saying why (R72-NFR3). Returns
 * `{ ok }` or `{ ok: false, reason }` with systemd-run's own words.
 */
export function scopeStarts({ environment = process.env, timeoutMs = 10_000, systemdRun = SYSTEMD_RUN } = {}) {
  if (!existsSync(systemdRun)) return { ok: false, reason: `${systemdRun} is not installed, so BMN cannot give the ask a systemd user scope` }
  if (!existsSync(SETPRIV)) return { ok: false, reason: `${SETPRIV} is not installed` }
  const result = spawnSync(systemdRun, [...SCOPE_OPTIONS, '--', '/bin/true'], { encoding: 'utf8', timeout: timeoutMs, env: scopeEnvironment(environment) })
  if (result.status === 0) return { ok: true }
  const said = `${result.stderr ?? ''}`.trim().split('\n').pop() || (result.error ? result.error.message : `systemd-run ended with code ${result.status}`)
  return { ok: false, reason: `no systemd user manager answered (${said})` }
}

/** The cgroup folder a process is in, or null once it is gone. */
function cgroupOf(pid) {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((entry) => entry.startsWith('0::'))
    return line === undefined ? null : `/sys/fs/cgroup${line.slice(3)}`
  } catch {
    return null
  }
}

/**
 * Ends every process of a run's scope: its cgroup.kill, which the owner's user may write in his own
 * systemd's tree. Only a scope of this very run is ever killed. Returns whether a scope was there.
 */
export function endScope(cgroup, id) {
  if (typeof cgroup !== 'string' || !cgroup.startsWith('/sys/fs/cgroup/') || scopeAsk(cgroup) !== id || cgroup.includes('/..')) return false
  try {
    writeFileSync(join(cgroup, 'cgroup.kill'), '1')
    return true
  } catch {
    return false
  }
}

/** The processes in a run's scope now. */
function scopeProcesses(cgroup) {
  try {
    return readFileSync(join(cgroup, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

/** Where this file lies as a program, as agents-supervised.mjs finds its own. */
function teamSupervisorScript() {
  const own = dirname(fileURLToPath(import.meta.url))
  const places = [join(own, NAME), ...(typeof process.resourcesPath === 'string' ? [join(process.resourcesPath, 'bin', NAME)] : []), join(own, '..', '..', 'bin', NAME)]
  return places.find((place) => existsSync(place)) ?? null
}

/**
 * Starts the supervisor of the run in `folder`, whose `launch.json` says what to run:
 * `{ argv, argv_sha256, cwd, deadline, stdin, stdin_sha256, output_limit, token_ceiling? }`
 * (`*_sha256`: what the check judged, compared just before the start, a difference starting nothing; every run
 * also passes agents-team-run.mjs's `launchCheck` immediately before the app, which holds each of these to the
 * run's receipt and to BMN's and the owner's limits, its reason starting nothing; `output_limit`: the bytes of raw
 * output over which the run fails; `token_ceiling`: the owner's, watched by the run module's `watchAsk`). Once the
 * app has ended the supervisor calls the run module's `finishAsk` with the folder; nothing the launch names is ever
 * loaded. Its environment holds only the asker's HOME, where the last check reads the team, and what systemd-run
 * needs to reach the owner's systemd. Returns `{ pid, start }` or `{ failed }`.
 * The supervisor is detached and in a session of its own: closing the asking command leaves it running.
 */
export function startTeamSupervisor(folder, { execPath = process.execPath, environment = process.env } = {}) {
  const script = teamSupervisorScript()
  if (script === null) return { failed: 'BMN\'s ask supervisor file is missing' }
  let child
  try {
    child = spawn(execPath, [script, SUPERVISE, folder], {
      cwd: folder, detached: true, stdio: 'ignore',
      env: { ...scopeEnvironment(environment), HOME: homedir(), ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }) }
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
function supervisorLives(identity) {
  if (!processLives(identity)) return false
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
  } catch {
    return false
  }
}

/** The app's own exit, from the status its wrapper wrote: a code, or the signal that ended it (the shell's 128 + n). */
function appExit(folder) {
  let text
  try {
    text = readFileSync(join(folder, RUN_FILES.status), 'utf8').trim()
  } catch {
    return null
  }
  if (!/^\d+$/u.test(text)) return null
  const status = Number(text)
  if (status <= 128) return { code: status, signal: null, signal_number: null }
  const number = status - 128
  const name = Object.entries(constants.signals).find(([, value]) => value === number)?.[0] ?? null
  return { code: null, signal: name, signal_number: number }
}

// ---------------------------------------------------------------------------------------------
// The supervisor

async function supervise(folder) {
  const launch = readJson(join(folder, RUN_FILES.launch))
  // A run already given its outcome (recorded as interrupted after its asking command ended) is never started.
  if (existsSync(join(folder, 'outcome.json'))) process.exit(0)
  const id = basename(folder)
  const state = { version: 1, state: 'starting', supervisor: { pid: process.pid, start: processStart(process.pid) }, started_at: new Date().toISOString() }
  const save = () => writeWhole(join(folder, RUN_FILES.state), `${JSON.stringify(state)}\n`)
  save()
  let ended = null
  let endedReason = null
  let finishing = false
  const finish = async (exit) => {
    if (finishing) return
    finishing = true
    writeWhole(join(folder, RUN_FILES.exit), `${JSON.stringify({ version: 1, ...exit, ended: ended ?? (exit.code === 0 ? 'done' : 'failed'), ...(endedReason === null ? {} : { reason: endedReason }), at: new Date().toISOString() })}\n`)
    state.state = 'finishing'
    save()
    try {
      await (await import(RUN_MODULE)).finishAsk(folder)
    } catch (error) {
      state.finish_error = error instanceof Error ? error.message : String(error)
    }
    state.state = 'ended'
    state.ended_at = new Date().toISOString()
    save()
    process.exit(0)
  }
  const notStarted = (why, reason = null) => {
    ended = why
    endedReason = reason
    return finish({ code: null, signal: null, started: false })
  }
  // Stop and the time limit: before anything, and once more immediately before the app (72.9 AC4).
  const stopOrLimit = () => (existsSync(join(folder, RUN_FILES.stop)) ? 'stopped' : !(launch.deadline > Date.now()) ? 'limit' : null)
  if (stopOrLimit() !== null) return notStarted(stopOrLimit())
  // The command and standard input are the ones the check judged, read now, just before the start (72.3 AC1).
  if (typeof launch.argv_sha256 === 'string' && sha256(JSON.stringify(launch.argv)) !== launch.argv_sha256) return notStarted('changed', 'the command changed after the check; nothing started')
  let stdinBytes = null
  if (launch.stdin) {
    try {
      stdinBytes = readFileSync(launch.stdin)
    } catch {
      stdinBytes = null
    }
    if (stdinBytes === null || (typeof launch.stdin_sha256 === 'string' && sha256(stdinBytes) !== launch.stdin_sha256)) return notStarted('changed', 'the prompt changed after the check; nothing started')
  }
  // The run's last check, immediately before the app: the run's receipt, the team, the program and the inputs as the check
  // judged them (72.3 AC1). It is BMN's own, beside this file, for every run, never one the launch names; a check that
  // cannot run starts nothing either. It also notes the project's commit and state at the start (72.9 AC6).
  let reason
  try {
    reason = await (await import(RUN_MODULE)).launchCheck(folder, launch)
  } catch (error) {
    reason = `BMN could not check the run before its start (${error instanceof Error ? error.message : String(error)})`
  }
  if (reason !== null) return notStarted('changed', `${reason}; nothing started`)
  // BMN's own watch step under the owner's token ceiling, loaded once before the start: it reads the run's output and says when to end it.
  const watcher = Number.isInteger(launch.token_ceiling) ? await import(RUN_MODULE).then((module) => module.watchAsk).catch(() => null) : null
  if (stopOrLimit() !== null) return notStarted(stopOrLimit())
  const input = stdinBytes === null ? 'ignore' : 'pipe'
  const output = openSync(join(folder, RUN_FILES.events), 'a', 0o600)
  const errors = openSync(join(folder, RUN_FILES.stderr), 'a', 0o600)
  let child
  try {
    // The app runs in its own scope; systemd-run --scope runs it as this process's own child, inside this process's restrictions.
    child = spawn(SYSTEMD_RUN, [...SCOPE_OPTIONS, `--unit=${scopeUnit(id)}`, '--', SETPRIV, '--pdeathsig', 'TERM', '--',
      '/bin/sh', '-c', SCOPE_WRAPPER, 'bmn-ask', String(process.pid), join(folder, RUN_FILES.status), ...launch.argv],
    { cwd: launch.cwd, env: scopeEnvironment(process.env), stdio: [input, output, errors], detached: true })
  } finally {
    closeSync(output)
    closeSync(errors)
  }
  if (stdinBytes !== null && child.stdin) {
    child.stdin.on('error', () => undefined)
    child.stdin.end(stdinBytes)
  }
  let scope = null
  let asked = false
  const end = (why, reason = null) => {
    if (ended === null && reason !== null) endedReason = reason
    ended ??= why
    if (asked) return
    asked = true
    // TERM to every process of the scope (the wrapper's own trap ends the scope at once), then the scope's kill after a grace.
    if (scope !== null) for (const pid of scopeProcesses(scope)) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Gone already.
      }
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Gone already.
      }
    }
    setTimeout(() => {
      if (scope !== null) endScope(scope, id)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Gone already.
      }
    }, KILL_AFTER_MS).unref()
  }
  child.on('error', (error) => {
    ended ??= 'failed'
    endedReason ??= `the run's scope could not start: ${error.message}`
    state.launch_error = error.message
    void finish({ code: null, signal: null, started: false })
  })
  child.on('exit', (code, signal) => {
    clearInterval(watch)
    clearTimeout(timer)
    // Whatever the app left in its scope goes with it: the wrapper ends the scope, and the supervisor once more.
    if (scope !== null) endScope(scope, id)
    const app = appExit(folder)
    if (scope === null && app === null) {
      // systemd-run never gave the run a scope: nothing of the app ran.
      ended ??= 'failed'
      endedReason ??= 'the run\'s systemd scope could not start (systemd-run\'s words are in the run\'s stderr.txt)'
      return void finish({ code, signal: signal ?? null, started: false })
    }
    void finish({ ...(app ?? { code: null, signal: signal ?? null, signal_number: signal ? constants.signals[signal] ?? null : null }), started: true })
  })
  state.state = 'running'
  state.child = { pid: child.pid, start: processStart(child.pid) }
  save()
  // The run's scope, named in its state: Stop, the time limit and crash recovery end exactly it.
  const until = Date.now() + SCOPE_WAIT_MS
  const findScope = () => {
    if (scope !== null || finishing) return
    const found = cgroupOf(child.pid)
    if (found !== null && scopeAsk(found) === id) {
      scope = found
      state.scope = { unit: `${scopeUnit(id)}.scope`, cgroup: found }
      save()
      if (asked) endScope(scope, id)
      return
    }
    if (Date.now() < until) setTimeout(findScope, 20).unref()
  }
  findScope()
  let polls = 0
  const watch = setInterval(() => {
    polls += 1
    if (existsSync(join(folder, RUN_FILES.stop))) end('stopped')
    if (watcher !== null && polls % WATCH_EVERY === 0) {
      let reason = null
      try {
        reason = watcher(folder, launch)
      } catch {
        // A watch step that fails ends nothing.
      }
      if (typeof reason === 'string') end('ceiling', reason)
    }
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
