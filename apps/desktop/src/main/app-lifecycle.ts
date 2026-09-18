import {
  ERROR_CODES,
  type SavedOutputCaptureOutcome,
  type SessionProcessState,
  type SessionStopCause
} from '@bmn/protocol'

export type BackgroundChoice = 'hide' | 'stop'

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
}

export interface QuitChoicePrompt {
  message: string
  detail: string
  buttons: readonly ['Quit', 'Cancel']
  defaultId: 1
  cancelId: 1
}

interface PreventableEvent {
  preventDefault(): void
}

interface ApplicationLifecycleActions {
  runningTargets(): readonly RunningSessionTarget[]
  saveBackgroundChoice(
    targets: readonly RunningSessionTarget[],
    choice: BackgroundChoice
  ): void | Promise<void>
  promptForClose(choice: CloseChoicePrompt): Promise<0 | 1 | 2>
  promptForQuit(choice: QuitChoicePrompt): Promise<0 | 1>
  flushSavedOutput(): Promise<SavedOutputCaptureOutcome>
  stopTargets(
    targets: readonly RunningSessionTarget[],
    cause: SessionStopCause
  ): Promise<void>
  hideWindow(): void
  quitApplication(): void
  restartForUpdate(): void
  reportFailure(error: unknown): void
}

export interface ApplicationLifecycle {
  closeLastWindow(event: PreventableEvent): void
  beforeQuit(event: PreventableEvent): void
  updateDownloaded(): void
  stopCurrentTarget(target?: RunningSessionTarget): Promise<SavedOutputCaptureOutcome>
}

interface StopCurrentTargetActions {
  requestStop(): Promise<unknown>
  dispose(): Promise<unknown>
  clearCurrent(): void
  setStopInProgress(inProgress: boolean): void
}

export function isMissingStopTargetError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { protocolError?: { data?: { code?: unknown } } }).protocolError?.data?.code ===
      ERROR_CODES.notFound
  )
}

export async function stopAndDisposeCurrentTarget(
  actions: StopCurrentTargetActions
): Promise<void> {
  actions.setStopInProgress(true)
  try {
    try {
      await actions.requestStop()
    } catch (error) {
      if (!isMissingStopTargetError(error)) throw error
    }
  } finally {
    try {
      await actions.dispose()
    } finally {
      try {
        actions.clearCurrent()
      } finally {
        actions.setStopInProgress(false)
      }
    }
  }
}

export function runningTargetDetails(targets: readonly RunningSessionTarget[]): string {
  return targets
    .map(
      (target) =>
        `Session: ${target.sessionId}\nProcess: ${target.executable}\nIncarnation: ${target.incarnationId}\nState: ${
          target.processState === 'live' ? 'live' : 'exit unconfirmed (process outcome uncertain)'
        }`
    )
    .join('\n\n')
}

export function createApplicationLifecycle(
  actions: ApplicationLifecycleActions
): ApplicationLifecycle {
  let decisionInProgress = false
  let quitApproved = false

  const fail = (error: unknown): void => {
    decisionInProgress = false
    actions.reportFailure(error)
  }

  const captureThen = async (
    complete: () => void | Promise<void>
  ): Promise<SavedOutputCaptureOutcome> => {
    const outcome = await actions.flushSavedOutput()
    await complete()
    return outcome
  }

  const stopThenQuit = async (targets: readonly RunningSessionTarget[]): Promise<void> => {
    await captureThen(async () => {
      await actions.stopTargets(targets, 'application-quit')
      decisionInProgress = false
      quitApproved = true
      actions.quitApplication()
    })
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
    closeLastWindow(event): void {
      if (quitApproved) return
      const targets = actions.runningTargets()
      event.preventDefault()
      if (decisionInProgress) return
      decisionInProgress = true
      if (targets.length === 0) {
        void finishWithoutRunningTargets('close-last-window').catch(fail)
        return
      }

      const unsetTargets = targets.filter((target) => target.backgroundChoice === undefined)
      const decide = async (): Promise<void> => {
        let unsetChoice: BackgroundChoice | undefined
        if (unsetTargets.length > 0) {
          const response = await actions.promptForClose({
            message: 'Close the last window?',
            detail: `Choose what to do with these running targets:\n\n${runningTargetDetails(unsetTargets)}`,
            buttons: ['Minimize (keep running)', 'Stop', 'Cancel'],
            defaultId: 0,
            cancelId: 2
          })
          if (response === 2) {
            decisionInProgress = false
            return
          }
          unsetChoice = response === 0 ? 'hide' : 'stop'
          await actions.saveBackgroundChoice(unsetTargets, unsetChoice)
        }

        const stopTargets = targets.filter(
          (target) => (target.backgroundChoice ?? unsetChoice) === 'stop'
        )
        const keepTargets = targets.filter(
          (target) => (target.backgroundChoice ?? unsetChoice) === 'hide'
        )
        await captureThen(async () => {
          if (stopTargets.length > 0) {
            await actions.stopTargets(stopTargets, 'close-last-window')
          }
          decisionInProgress = false
          if (keepTargets.length > 0) {
            actions.hideWindow()
            return
          }
          quitApproved = true
          actions.quitApplication()
        })
      }
      void decide().catch(fail)
    },

    beforeQuit(event): void {
      if (quitApproved) return
      const targets = actions.runningTargets()
      event.preventDefault()
      if (decisionInProgress) return
      decisionInProgress = true
      if (targets.length === 0) {
        void finishWithoutRunningTargets('application-quit').catch(fail)
        return
      }
      void actions
        .promptForQuit({
          message: 'Quit BMN and stop the running sessions?',
          detail: `Quit applies to these running targets:\n\n${runningTargetDetails(targets)}`,
          buttons: ['Quit', 'Cancel'],
          defaultId: 1,
          cancelId: 1
        })
        .then((response) => {
          if (response === 1) {
            decisionInProgress = false
            return
          }
          return stopThenQuit(targets)
        })
        .catch(fail)
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
      return captureThen(() => actions.stopTargets(targets, 'explicit'))
    }
  }
}
