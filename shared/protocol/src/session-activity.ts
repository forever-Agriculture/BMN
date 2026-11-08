// MODULE: session-activity.ts - one host observation and silence bound for every session presentation
import { hasExactKeys } from './closed-shape'

export const ACTIVITY_TICK_MS = 500
/** With the presentation tick, silence becomes idle within 1.5–2.0 seconds. */
export const ACTIVITY_IDLE_AFTER_MS = 1_500
export const ACTIVITY_START_GRACE_MS = 3_000

export interface SessionActivityObservation {
  incarnationId: string
  liveSince: number
  lastOutputAt: number | null
}

export function isSessionActivityObservation(value: unknown): value is SessionActivityObservation {
  if (!value || typeof value !== 'object' || !hasExactKeys(value, ['incarnationId', 'liveSince', 'lastOutputAt'])) return false
  const row = value as SessionActivityObservation
  return typeof row.incarnationId === 'string' && row.incarnationId.trim().length > 0 && row.incarnationId.length <= 256 &&
    Number.isFinite(row.liveSince) && row.liveSince >= 0 &&
    (row.lastOutputAt === null || Number.isFinite(row.lastOutputAt) && row.lastOutputAt >= row.liveSince)
}

/** Titles, hooks, notifications and the time metadata arrives cannot manufacture output. */
export function sessionActivityState(observation: SessionActivityObservation | null, now: number): {
  word: 'Working' | 'Running' | 'Idle'; working: boolean
} {
  if (observation !== null && observation.lastOutputAt !== null && now - observation.lastOutputAt < ACTIVITY_IDLE_AFTER_MS) {
    return { word: 'Working', working: true }
  }
  if (observation !== null && observation.lastOutputAt === null && now - observation.liveSince < ACTIVITY_START_GRACE_MS) {
    return { word: 'Running', working: false }
  }
  return { word: 'Idle', working: false }
}

/** Reads may finish after newer metadata. Only the confirmed incarnation can contribute timestamps. */
export function mergeSessionActivity(
  current: SessionActivityObservation | null, incoming: SessionActivityObservation, incarnationId: string
): SessionActivityObservation | null {
  const previous = current?.incarnationId === incarnationId ? current : null
  if (incoming.incarnationId !== incarnationId) return previous
  if (!previous) return incoming
  if (previous.liveSince !== incoming.liveSince) return previous
  if (incoming.lastOutputAt === null || previous.lastOutputAt !== null && incoming.lastOutputAt <= previous.lastOutputAt) return previous
  return incoming
}
