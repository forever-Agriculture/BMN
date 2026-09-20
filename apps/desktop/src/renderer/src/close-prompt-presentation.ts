// MODULE: close-prompt-presentation.ts - the words the close prompt uses for the sessions still running
import type { BackgroundChoice, ClosePromptMode, ClosePromptSession } from '@bmn/protocol'
import type { ActivityWord } from './session-activity'

export interface ClosePromptRow {
  sessionId: string
  /** What the owner called it, with its workspace; the window knows both, the main process does not. */
  name: string
  workspace: string
  /** `claude · working`: which agent, and what it is doing right now. */
  detail: string
  choice: BackgroundChoice
}

export function closePromptHeading(mode: ClosePromptMode): string {
  return mode === 'close' ? 'Close BMN?' : 'Quit BMN?'
}

/** States the count first: the owner decides about work, not about a window. */
export function closePromptSummary(mode: ClosePromptMode, count: number): string {
  const running = count === 1 ? '1 session is still running' : `${count} sessions are still running`
  return mode === 'close'
    ? `${running}. Keep them running, or stop them.`
    : `${running}. Quitting stops ${count === 1 ? 'it' : 'them all'}.`
}

/**
 * `exit unconfirmed` is stated plainly rather than dressed as an error: BMN does not know how that
 * process ended, and saying so is more useful than a warning colour.
 */
export function closePromptDetail(session: ClosePromptSession, activity: ActivityWord | undefined): string {
  if (session.processState === 'exit-unconfirmed') return `${session.agent} · exit unconfirmed`
  if (!activity) return session.agent
  return `${session.agent} · ${activity.toLowerCase()}`
}

/** Sessions arrive in main-process order; the rows keep it so the list does not reshuffle under a click. */
export function closePromptRows(
  sessions: readonly ClosePromptSession[],
  describe: (sessionId: string) => { workspace: string; activity: ActivityWord | undefined }
): ClosePromptRow[] {
  return sessions.map((session) => {
    const described = describe(session.sessionId)
    return {
      sessionId: session.sessionId,
      name: session.name,
      workspace: described.workspace,
      detail: closePromptDetail(session, described.activity),
      // Nothing is stopped unless the owner says so, so every row starts on keep.
      choice: 'hide'
    }
  })
}
