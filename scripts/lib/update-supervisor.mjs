// MODULE: update-supervisor.mjs - Story 134.2: the queued update builds and tests while BMN stays open; at exit only the newest passed build goes live

/** The source moved while a candidate was built: not a failure; the newest commit is built instead. */
export class SourceMoved extends Error {}

/** A step that failed, naming it, so the attempt's log and `latest.json` say where an update stopped. */
export function stepFailure(step, error) {
  const failure = error instanceof Error ? error : new Error(String(error))
  failure.step ??= step
  return failure
}

const short = (commit) => commit.slice(0, 7)

/**
 * Runs one queued update to its end (Story 134.2, D1). While BMN is open it packages and smoke-tests the newest
 * clean pushed `main`; only a build that passed is offered for restart (`waiting-for-exit`, which BMN reads as the
 * offer). A newer clean commit arriving before BMN exits withdraws the offer (`preparing`) until it passed too. When
 * BMN exits, the newest passed build goes live; a newer commit still building is stopped and built again after,
 * waiting for the next restart. A commit that failed keeps its attempt log and never goes live; a passed build that is
 * still waiting is offered again.
 *
 * Every effect comes from `io`, so tests can drive it against a throwaway repository:
 * - `source(known)` → `{ head, problem }`: the checkout's HEAD and why it is not a clean pushed main (null when it is).
 * - `build(commit, { attempt, signal })`: packages and smokes `commit`, rejects with `SourceMoved` when the source
 *   changed meanwhile and with a step failure otherwise. Must reject soon after `signal` aborts, its processes stopped.
 * - `keep(commit, attempt)`: makes the build that just passed the one that waits (`ready`). It is not called for a build
 *   that passed after BMN's exit was seen: the build already waiting goes live then.
 * - `install(commit, attempt)`: swaps the waiting build in (BMN is closed) and finishes the install; rejects on failure.
 * - `appOpen()`, `startAttempt(commit, { protect })` (Story 134.1; `protect` names logs pruning must keep), `status(value)` (latest.json), `notify(summary, body, urgency)`,
 *   `delay(ms)`, `quietMs` (how long BMN must stay closed before a swap), `pollMs`.
 * Resolves `{ installed }`; rejects with `failure.attempt` and `failure.step` when the update ends failed.
 */
export async function superviseUpdate(io) {
  const { quietMs = 3_000, pollMs = 1_000 } = io
  let ready = null
  let installed = null
  const failed = new Set()
  let lastStatus = ''
  const status = (value) => {
    const key = JSON.stringify(value)
    if (key === lastStatus) return
    lastStatus = key
    io.status({ ...value, updatedAt: new Date().toISOString() })
  }
  const known = () => new Set([ready?.commit, installed, ...failed].filter(Boolean))
  const closedQuietly = async () => {
    if (io.appOpen()) return false
    await io.delay(quietMs)
    return !io.appOpen()
  }
  /** Swaps the waiting build in; never while BMN runs: it may have been started again while a build was stopped. */
  const putLive = async () => {
    if (io.appOpen()) return false
    const { commit, attempt } = ready
    status({ phase: 'installing', commit, staged: commit, installed, logPath: attempt.path })
    try {
      await io.install(commit, attempt)
    } catch (error) {
      throw Object.assign(stepFailure('install', error), { attempt })
    }
    installed = commit
    ready = null
    lastStatus = ''
    return true
  }
  const newer = (now) => now.problem === null && !known().has(now.head)

  for (let first = true; ; first = false) {
    const now = io.source(known())
    if (newer(now)) {
      const commit = now.head, controller = new AbortController()
      // The waiting build's log is still written at its swap, so a new attempt never prunes it (Story 134.1).
      const attempt = io.startAttempt(commit, { protect: ready ? [ready.attempt.path] : [] })
      status({ phase: 'preparing', commit, staged: ready?.commit ?? null, installed, logPath: attempt.path })
      let exited = false, watching = Boolean(ready), passed = false
      // While a passed build waits, BMN's exit puts it live at once: the newer build is stopped for it. A quiet wait that
      // began before the build ended is finished (the build's end awaits it): an exit seen then still puts the waiting
      // build live, never the one that just passed (review F1), unless BMN came back within the quiet window.
      const watcher = watching ? (async () => {
        while (watching) {
          if (!io.appOpen()) {
            await io.delay(quietMs)
            if (!io.appOpen()) { exited = true; controller.abort(); return }
          }
          if (!watching) return
          await io.delay(pollMs)
        }
      })() : null
      try {
        await io.build(commit, { attempt, signal: controller.signal })
        passed = true
      } catch (error) {
        if (exited) attempt.log(`STOPPED BMN exited, so ${short(ready.commit)} goes live first; ${short(commit)} is built again after`)
        else if (error instanceof SourceMoved) attempt.log(`SUPERSEDED ${error.message}; the newest commit is built instead`)
        else {
          const failure = Object.assign(stepFailure('build', error), { attempt, logged: true })
          failed.add(commit)
          attempt.log(`FAILED at ${failure.step}: ${failure.message}`)
          const waiting = ready ? `${short(ready.commit)} still waits for your restart` : null
          // A newer clean push that arrived meanwhile is built rather than dropped with this failure.
          const later = waiting ? null : io.source(known())
          if (!waiting && !newer(later)) throw failure
          io.notify('BMN update failed', `${short(commit)} failed at ${failure.step}; ${waiting ?? `building ${short(later.head)} instead`}. Log: ${attempt.path}`, 'critical')
        }
      } finally {
        watching = false
        await watcher
      }
      if (passed && !exited) {
        io.keep(commit, attempt)
        ready = { commit, attempt }
        attempt.log(`PASSED ${commit}; it waits for BMN to exit`)
        // The offer is published before he is told of it.
        status({ phase: 'waiting-for-exit', commit, staged: commit, installed, logPath: attempt.path })
        io.notify('BMN update ready', `${short(commit)} passed its checks. Restart BMN to use it.`)
      } else if (passed) {
        // BMN's exit was seen before this build passed: the build that waited then goes live, and this one is built again.
        attempt.log(`PASSED ${commit} after BMN exited; ${short(ready.commit)} goes live first and ${short(commit)} is built again after`)
      }
      if (exited) await putLive()
      continue
    }
    if (ready) {
      status({ phase: 'waiting-for-exit', commit: ready.commit, staged: ready.commit, installed, logPath: ready.attempt.path })
      if (!(await closedQuietly()) || !(await putLive())) await io.delay(pollMs)
      continue
    }
    if (installed === null && now.problem !== null) {
      const message = first ? now.problem : `source changed during the build, so the old build stays live: ${now.problem}`
      throw Object.assign(new Error(message), { step: 'source check', attempt: io.startAttempt(now.head) })
    }
    return { installed }
  }
}
