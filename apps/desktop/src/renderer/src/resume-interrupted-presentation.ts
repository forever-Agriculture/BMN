// MODULE: resume-interrupted-presentation.ts - the words the resume-after-stop offer uses
import type {
  InterruptedSessionCohort,
  InterruptedSessionEntry,
  ResumableStopCause
} from '@bmn/protocol'

export type ResumeRowOutcome =
  | { kind: 'pending' }
  | { kind: 'started' }
  | { kind: 'failed'; error: string }
  | { kind: 'not-started' }

export interface ResumeInterruptedRow {
  sessionId: string
  name: string
  workspace: string
  action: 'resume' | 'relaunch'
  /** Exactly what pressing the button will run for this row. */
  command: string
  notCarried: string
  /** Why this row can only be started again; empty for a Resume row. */
  relaunchReason: string
  checked: boolean
  outcome: ResumeRowOutcome
}

export function interruptedStopWords(cause: ResumableStopCause): string {
  return cause === 'update-restart' ? 'a desktop update' : 'quitting BMN'
}

export function resumeInterruptedHeading(cause: ResumableStopCause): string {
  return cause === 'update-restart' ? 'Resume what the update stopped?' : 'Resume what the quit stopped?'
}

/**
 * States what ended the sessions and what this dialog would do about it. It never promises the
 * conversations come back: each row shows the command, and the command is the promise.
 */
export function resumeInterruptedSummary(cohort: InterruptedSessionCohort): string {
  const count = cohort.entries.length
  const sessions = count === 1 ? '1 session' : `${count} sessions`
  return `${interruptedStopWords(cohort.cause)} stopped ${sessions}. Nothing has started since.`
}

/**
 * Resume rows are checked: reopening a conversation is what the owner was doing by hand anyway.
 * Start again rows are not, because rerunning a stored command is not the same as resuming
 * a conversation, and BMN cannot tell what that command would do a second time.
 */
export function resumeInterruptedRows(
  cohort: InterruptedSessionCohort
): ResumeInterruptedRow[] {
  return cohort.entries.map((entry: InterruptedSessionEntry) => ({
    sessionId: entry.sessionId,
    name: entry.name,
    workspace: entry.workspaceName,
    action: entry.action,
    command: entry.command,
    notCarried: entry.notCarried,
    relaunchReason: entry.relaunchReason ?? '',
    checked: entry.action === 'resume',
    outcome: { kind: 'pending' }
  }))
}

/**
 * A row the last action reached is settled: a started process is running and a failure is recorded,
 * and neither is touched again here. *Not started* is not a result but an absence, so those rows
 * stay available: the owner can press again for exactly the ones the first press never reached.
 */
export function startableRows(rows: readonly ResumeInterruptedRow[]): ResumeInterruptedRow[] {
  return rows.filter((row) =>
    row.checked && row.outcome.kind !== 'started' && row.outcome.kind !== 'failed')
}

/** The button counts what it would start, so the number and the rows can never disagree. */
export function resumeInterruptedButtonLabel(rows: readonly ResumeInterruptedRow[]): string {
  const count = startableRows(rows).length
  return count === 1 ? 'Resume 1 session' : `Resume ${count} sessions`
}

export function resumeRowOutcomeWords(outcome: ResumeRowOutcome): string {
  switch (outcome.kind) {
    case 'started':
      return 'Started'
    case 'failed':
      return `Failed · ${outcome.error}`
    case 'not-started':
      return 'Not started'
    case 'pending':
      return ''
  }
}

/** Applies one action's outcomes to the rows in place of their pending state; order is untouched. */
export function applyResumeOutcomes(
  rows: readonly ResumeInterruptedRow[],
  outcomes: ReadonlyArray<{ sessionId: string; outcome: 'started' | 'failed' | 'not-started'; error?: string }>
): ResumeInterruptedRow[] {
  const byId = new Map(outcomes.map((entry) => [entry.sessionId, entry]))
  return rows.map((row) => {
    const result = byId.get(row.sessionId)
    if (!result) return row
    if (result.outcome === 'failed') {
      return { ...row, outcome: { kind: 'failed', error: result.error ?? 'The session could not be started' } }
    }
    // A started row keeps its running process whatever the rows after it did, so it is never re-offered.
    return {
      ...row,
      checked: result.outcome === 'started' ? false : row.checked,
      outcome: { kind: result.outcome }
    }
  })
}
