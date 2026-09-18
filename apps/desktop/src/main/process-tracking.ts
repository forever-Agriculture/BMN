// MODULE: process-tracking.ts - which session processes Quit and Close must still account for
import type { SessionProcessState, SessionStopCause } from '@bmn/protocol'
import { isMissingStopTargetError, runningTargetForRuntime, type RunningSessionTarget } from './app-lifecycle'

export interface TrackedRuntime {
  session: { sessionId: string; incarnationId: string }
  executable: string
  processState: SessionProcessState
  backgroundChoice?: RunningSessionTarget['backgroundChoice']
}

export interface ProcessTracking<R extends TrackedRuntime> {
  /** Sessions with a terminal view, by session id, whatever their process state. */
  readonly runtimes: Map<string, R>
  /** Unconfirmed exits whose terminal view is gone, by incarnation id; listed until the host reports the exit. */
  readonly unconfirmedExits: Map<string, RunningSessionTarget>
}

export function createProcessTracking<R extends TrackedRuntime>(): ProcessTracking<R> {
  return { runtimes: new Map(), unconfirmedExits: new Map() }
}

function targetFor(runtime: TrackedRuntime): RunningSessionTarget | undefined {
  return runningTargetForRuntime({
    ...runtime.session,
    executable: runtime.executable,
    processState: runtime.processState,
    ...(runtime.backgroundChoice ? { backgroundChoice: runtime.backgroundChoice } : {})
  })
}

export function runningTargets<R extends TrackedRuntime>(tracking: ProcessTracking<R>): RunningSessionTarget[] {
  const targets = [...tracking.runtimes.values()].flatMap((runtime) => {
    const target = targetFor(runtime)
    return target ? [target] : []
  })
  const listed = new Set(targets.map((target) => target.incarnationId))
  return [...targets, ...[...tracking.unconfirmedExits.values()].filter((target) => !listed.has(target.incarnationId))]
}

/** Removes a session's terminal view; a process whose exit is unconfirmed stays listed for Quit and Close. */
export function dropRuntimeView<R extends TrackedRuntime>(tracking: ProcessTracking<R>, runtime: R): void {
  if (tracking.runtimes.get(runtime.session.sessionId) !== runtime) return
  tracking.runtimes.delete(runtime.session.sessionId)
  const target = targetFor(runtime)
  if (target?.processState === 'exit-unconfirmed') tracking.unconfirmedExits.set(target.incarnationId, target)
}

export function applyProcessState<R extends TrackedRuntime>(
  tracking: ProcessTracking<R>,
  message: { sessionId: string; incarnationId: string; state: SessionProcessState }
): void {
  const current = tracking.runtimes.get(message.sessionId)
  if (current?.session.incarnationId === message.incarnationId) current.processState = message.state
  const unconfirmed = tracking.unconfirmedExits.get(message.incarnationId)
  if (unconfirmed?.sessionId === message.sessionId && message.state === 'exited') {
    tracking.unconfirmedExits.delete(message.incarnationId)
  }
}

/**
 * Stops each target that still has its view. A stop that succeeded, or found the process already gone, ends tracking.
 * Any other failure leaves the outcome unknown: the target stays listed as exit unconfirmed and the failure is
 * reported. The host can never confirm such a stop before a restart, so once the owner has seen the target listed as
 * exit unconfirmed, Quit and Close go ahead instead of failing again.
 */
export async function stopTrackedTargets<R extends TrackedRuntime>(
  tracking: ProcessTracking<R>,
  targets: readonly RunningSessionTarget[],
  cause: SessionStopCause,
  requestStop: (runtime: R, cause: SessionStopCause) => Promise<unknown>
): Promise<void> {
  for (const target of targets) {
    const current = tracking.runtimes.get(target.sessionId)
    if (!current || current.session.incarnationId !== target.incarnationId) continue
    const alreadyUnconfirmed = target.processState === 'exit-unconfirmed'
    try {
      await requestStop(current, cause)
    } catch (error) {
      if (!isMissingStopTargetError(error)) {
        if (current.processState === 'live') current.processState = 'exit-unconfirmed'
        if (alreadyUnconfirmed && cause !== 'explicit') continue
        throw error
      }
    }
    if (tracking.runtimes.get(target.sessionId) === current) tracking.runtimes.delete(target.sessionId)
  }
}
