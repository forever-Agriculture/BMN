// MODULE: interrupted-cohort.ts - which sessions one lifecycle stop interrupted, decided from records only
import {
  INTERRUPTION_COHORT_WINDOW_MS,
  RESUMABLE_STOP_CAUSES,
  lifecycleStopSource,
  type ResumableStopCause
} from '@bmn/protocol'

/** One unarchived session whose latest process incarnation is recorded interrupted. */
export interface InterruptedIncarnationRow {
  sessionId: string
  incarnationId: string
  workspaceId: string
  workspaceName: string
  name: string
  cwd: string
  executable: string
  argv: readonly string[]
  /** The recorded interruption detail, for example `update restart · exit code 0`. */
  detail: string
  /** `process_incarnation.exited_at`, stamped when the stop marked the incarnation interrupted. */
  interruptedAt: string
  offeredAt: string | null
}

export interface InterruptionCohortSelection {
  cohortId: string
  cause: ResumableStopCause
  stoppedAt: string
  offeredAt: string | null
  members: InterruptedIncarnationRow[]
}

/**
 * The stop wording is the only thing that says a session ended because the owner updated or quit.
 * A crash, a window close and a single Stop all record something else and are never offered.
 */
export function resumableStopCause(detail: string | null): ResumableStopCause | null {
  if (detail === null) return null
  for (const cause of RESUMABLE_STOP_CAUSES) {
    if (detail.startsWith(lifecycleStopSource(cause))) return cause
  }
  return null
}

function stopTime(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * The newest cohort: every interruption that shares the newest one's wording and fell within
 * `INTERRUPTION_COHORT_WINDOW_MS` of it. A stop that took longer than the window is deliberately
 * split rather than widened, so the offer never reaches back into an earlier stop's sessions.
 */
export function newestInterruptionCohort(
  rows: readonly InterruptedIncarnationRow[]
): InterruptionCohortSelection | null {
  const qualifying = rows.flatMap((row) => {
    const cause = resumableStopCause(row.detail)
    const at = stopTime(row.interruptedAt)
    return cause && at !== null ? [{ row, cause, at }] : []
  })
  if (qualifying.length === 0) return null
  // Ties are broken by incarnation id so the anchor, and with it the cohort identity, is stable.
  const anchor = qualifying.reduce((newest, candidate) =>
    candidate.at > newest.at ||
    (candidate.at === newest.at && candidate.row.incarnationId > newest.row.incarnationId)
      ? candidate
      : newest)
  const members = qualifying
    .filter((candidate) =>
      candidate.cause === anchor.cause && anchor.at - candidate.at <= INTERRUPTION_COHORT_WINDOW_MS)
    .map((candidate) => candidate.row)
  return {
    cohortId: anchor.row.incarnationId,
    cause: anchor.cause,
    stoppedAt: anchor.row.interruptedAt,
    offeredAt: anchor.row.offeredAt,
    members
  }
}
