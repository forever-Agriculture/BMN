// MODULE: app-lifecycle.ts - close/quit choices and bounded, cancellable source-update shutdown
import { beforeRestartDeadline, restartClock } from '../utility/update-restart-deadline'
import {
  ERROR_CODES,
  type BackgroundChoice,
  type SavedOutputCaptureOutcome,
  type SessionProcessState,
  type SessionStopCause
} from '@bmn/protocol'

export type { BackgroundChoice }

export interface RunningSessionTarget {
  sessionId: string
  incarnationId: string
  executable: string
  processState: Exclude<SessionProcessState, 'exited'>
  backgroundChoice?: BackgroundChoice
}

export function runningTargetForRuntime(
  runtime: Omit<RunningSessionTarget, 'processState'> & { processState: SessionProcessState }
): RunningSessionTarget | undefined {
  if (runtime.processState === 'exited') return undefined
  return { ...runtime, processState: runtime.processState }
}

export interface CloseChoicePrompt {
  message: string
  detail: string
  buttons: readonly ['Minimize (keep running)', 'Stop', 'Cancel']
  defaultId: 0
  cancelId: 2
  /** The same targets the detail text lists, for a prompt that can name them itself. */
  targets: readonly RunningSessionTarget[]
}

export interface QuitChoicePrompt {
  message: string
  detail: string
  buttons: readonly ['Quit', 'Cancel']
  defaultId: 1
  cancelId: 1
  targets: readonly RunningSessionTarget[]
}

/**
 * One answer per session, so a close can keep one agent working and stop another. A session the
 * answer does not mention keeps running: nothing is stopped by omission.
 */
export type CloseDecision =
  | { kind: 'cancel' }
  | { kind: 'proceed'; choices: Readonly<Record<string, BackgroundChoice>>; remember: boolean }

export interface BackgroundChoiceDecision {
  target: RunningSessionTarget
  choice: BackgroundChoice
}

interface PreventableEvent {
  preventDefault(): void
}

interface ApplicationLifecycleActions {
  sourceUpdatePending?(): boolean
  showSourceUpdate?(): void
  runningTargets(): readonly RunningSessionTarget[]
  /** The window holds unsaved edits in Quick look; the window's own prompt asks about them first (Story 68.1 AC8). */
  unsavedEdits?(): boolean
  saveBackgroundChoice(decisions: readonly BackgroundChoiceDecision[]): void | Promise<void>
  promptForClose(choice: CloseChoicePrompt): Promise<CloseDecision>
  promptForQuit(choice: QuitChoicePrompt): Promise<'quit' | 'cancel'>
  flushSavedOutput(targets?: readonly RunningSessionTarget[]): Promise<SavedOutputCaptureOutcome>
  stopTargets(
    targets: readonly RunningSessionTarget[],
    cause: SessionStopCause
  ): Promise<void>
  hideWindow(): void
  quitApplication(): void
  restartForUpdate(): void
  reportFailure(error: unknown): void
}

export interface SourceUpdateShutdown {
  deadline: number
  allowed?(): boolean
  finish?(): void
  prepare(): Promise<void>
  captured(target: RunningSessionTarget, outcome: SavedOutputCaptureOutcome): Promise<void>
  stop(target: RunningSessionTarget, deadline: number): Promise<unknown>
}
export interface ApplicationLifecycle {
  beginSourceUpdate(): void
  cancelSourceUpdate(): void
  closeLastWindow(event: PreventableEvent): void
  beforeQuit(event: PreventableEvent): void
  quitForSourceUpdate(targets: readonly RunningSessionTarget[], shutdown: SourceUpdateShutdown): Promise<void>
  updateDownloaded(): void
  stopCurrentTarget(target?: RunningSessionTarget): Promise<SavedOutputCaptureOutcome>
}

export function isMissingStopTargetError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { protocolError?: { data?: { code?: unknown } } }).protocolError?.data?.code ===
      ERROR_CODES.notFound
  )
}

function runningTargetDetails(targets: readonly RunningSessionTarget[]): string {
  return targets
    .map(
      (target) =>
        `Session: ${target.sessionId}\nProcess: ${target.executable}\nIncarnation: ${target.incarnationId}\nState: ${
          target.processState === 'live' ? 'live' : 'exit unconfirmed (process outcome uncertain)'
        }`
    )
    .join('\n\n')
}

/** A session's own saved choice wins; an unanswered session keeps running rather than being stopped. */
function chosenFor(
  target: RunningSessionTarget,
  answered: Readonly<Record<string, BackgroundChoice>>
): BackgroundChoice {
  return target.backgroundChoice ?? answered[target.sessionId] ?? 'hide'
}

export function createApplicationLifecycle(
  actions: ApplicationLifecycleActions
): ApplicationLifecycle {
  let decisionInProgress = false
  let quitApproved = false
  let sourceOwner: object | null = null

  const fail = (error: unknown): void => {
    decisionInProgress = false
    actions.reportFailure(error)
  }

  const captureThen = async (
    complete: () => void | Promise<void>,
    targets?: readonly RunningSessionTarget[]
  ): Promise<SavedOutputCaptureOutcome> => {
    const outcome = await actions.flushSavedOutput(targets)
    await complete()
    return outcome
  }

  const stopThenQuit = async (targets: readonly RunningSessionTarget[]): Promise<void> => {
    await captureThen(async () => {
      await actions.stopTargets(targets, 'application-quit')
      decisionInProgress = false
      quitApproved = true
      actions.quitApplication()
    }, targets)
  }

  const finishWithoutRunningTargets = async (cause: SessionStopCause): Promise<void> => {
    await captureThen(async () => {
      await actions.stopTargets([], cause)
      decisionInProgress = false
      quitApproved = true
      actions.quitApplication()
    })
  }

  return {
    beginSourceUpdate(): void {
      if (decisionInProgress) throw new Error('Finish the open close or quit question first')
      decisionInProgress = true; sourceOwner = {}
    },
    cancelSourceUpdate(): void { if (sourceOwner) { sourceOwner = null; decisionInProgress = false } },
    closeLastWindow(event): void {
      if (quitApproved) return
      if (sourceOwner) { event.preventDefault(); actions.showSourceUpdate?.(); return }
      const targets = actions.runningTargets()
      event.preventDefault()
      if (decisionInProgress) return
      decisionInProgress = true
      const unsaved = actions.unsavedEdits?.() === true
      if (targets.length === 0 && !unsaved) {
        void finishWithoutRunningTargets('close-last-window').catch(fail)
        return
      }

      const unsetTargets = targets.filter((target) => target.backgroundChoice === undefined)
      const decide = async (): Promise<void> => {
        let answered: Readonly<Record<string, BackgroundChoice>> = {}
        if (unsetTargets.length > 0 || unsaved) {
          const decision = await actions.promptForClose({
            message: 'Close the last window?',
            detail: `Choose what to do with these running targets:\n\n${runningTargetDetails(unsetTargets)}`,
            buttons: ['Minimize (keep running)', 'Stop', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
            targets: unsetTargets
          })
          if (decision.kind === 'cancel') {
            decisionInProgress = false
            return
          }
          answered = decision.choices
          if (decision.remember && unsetTargets.length > 0) {
            await actions.saveBackgroundChoice(
              unsetTargets.map((target) => ({ target, choice: chosenFor(target, answered) }))
            )
          }
        }

        const stopTargets = targets.filter((target) => chosenFor(target, answered) === 'stop')
        const keepTargets = targets.filter((target) => chosenFor(target, answered) !== 'stop')
        if (stopTargets.length > 0) {
          await captureThen(async () => {
            await actions.stopTargets(stopTargets, 'close-last-window')
          }, stopTargets)
        }
        if (targets.length === 0) {
          await finishWithoutRunningTargets('close-last-window')
          return
        }
        decisionInProgress = false
        if (keepTargets.length > 0) {
          actions.hideWindow()
          return
        }
        quitApproved = true
        actions.quitApplication()
      }
      void decide().catch(fail)
    },

    beforeQuit(event): void {
      if (quitApproved) return
      if (actions.sourceUpdatePending?.()) { event.preventDefault(); actions.showSourceUpdate?.(); return }
      const targets = actions.runningTargets()
      event.preventDefault()
      if (decisionInProgress) return
      decisionInProgress = true
      if (targets.length === 0 && actions.unsavedEdits?.() !== true) {
        void finishWithoutRunningTargets('application-quit').catch(fail)
        return
      }
      void actions
        .promptForQuit({
          message: 'Quit BMN and stop the running sessions?',
          detail: `Quit applies to these running targets:\n\n${runningTargetDetails(targets)}`,
          buttons: ['Quit', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          targets
        })
        .then((response) => {
          if (response === 'cancel') {
            decisionInProgress = false
            return
          }
          return targets.length === 0 ? finishWithoutRunningTargets('application-quit') : stopThenQuit(targets)
        })
        .catch(fail)
    },

    async quitForSourceUpdate(targets, shutdown): Promise<void> {
      if (decisionInProgress && !sourceOwner) throw new Error('A lifecycle decision is already in progress')
      const owner = sourceOwner ?? {}
      decisionInProgress = true; sourceOwner = owner
      const allowed = (): boolean => sourceOwner === owner && shutdown.allowed?.() !== false
      try {
        const captureDeadline = Math.min(shutdown.deadline - 6000, restartClock() + 2000)
        await Promise.all(targets.map(async target => {
          const timeout: SavedOutputCaptureOutcome = { status: 'unavailable', reason: 'capture-persist-failure', detail: 'final capture did not settle within the update shutdown budget' }
          const outcome = await beforeRestartDeadline(actions.flushSavedOutput([target]).catch(() => timeout), captureDeadline, timeout)
          if (!allowed()) return
          await beforeRestartDeadline(shutdown.captured(target, outcome), Math.min(shutdown.deadline - 5500, restartClock() + 250), undefined)
        }))
        if (!allowed()) return
        await shutdown.prepare()
        if (!allowed()) return
        const stopDeadline = Math.min(shutdown.deadline - 500, restartClock() + 4000)
        await Promise.allSettled(targets.map(target => !allowed() ? Promise.resolve() : beforeRestartDeadline(shutdown.stop(target, stopDeadline), stopDeadline, undefined)))
        if (!allowed()) return
        decisionInProgress = false; sourceOwner = null; quitApproved = true
        if (shutdown.finish) shutdown.finish(); else actions.quitApplication()
      } catch (error) {
        if (sourceOwner === owner) { sourceOwner = null; fail(error) }
        throw error
      }
    },

    updateDownloaded(): void {
      if (actions.runningTargets().length > 0) return
      if (decisionInProgress) return
      decisionInProgress = true
      void captureThen(() => actions.stopTargets([], 'update-restart'))
        .then(() => {
          decisionInProgress = false
          quitApproved = true
          actions.restartForUpdate()
        })
        .catch(fail)
    },

    stopCurrentTarget(target?: RunningSessionTarget): Promise<SavedOutputCaptureOutcome> {
      const targets = target ? [target] : actions.runningTargets()
      return captureThen(() => actions.stopTargets(targets, 'explicit'), targets)
    }
  }
}
