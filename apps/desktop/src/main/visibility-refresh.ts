// MODULE: visibility-refresh.ts - Epic 60.3 AC10: the app refreshes the visibility record of a workspace it opens a session in, at most once a day
import { existsSync, realpathSync } from 'node:fs'
import { refreshVisibility, workspaceRoot, workspaceVisibility } from '../../bin/agents-check.mjs'
import { rosterPath } from '../../bin/agents-roster.mjs'

export const VISIBILITY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

export type VisibilityRefreshOutcome = 'refreshed' | 'fresh' | 'skipped'

export interface VisibilityRefreshOptions {
  now?: Date
  request?: typeof fetch
  api?: string
  timeoutMs?: number
}

/** When this process last asked about a workspace: holds the daily limit even if the record cannot be written. */
const asked = new Map<string, number>()
const running = new Map<string, Promise<VisibilityRefreshOutcome>>()

const within = (then: number, now: number): boolean => then <= now && now - then < VISIBILITY_REFRESH_INTERVAL_MS

/**
 * Called, without awaiting, when a session opens in `directory`. Nothing is asked when no team
 * file exists (an install that never uses Team makes no network call), when the workspace's record
 * is under a day old, or when this process already asked today. Never throws.
 */
export function refreshVisibilityOnOpen(directory: string, options: VisibilityRefreshOptions = {}): Promise<VisibilityRefreshOutcome> {
  const now = options.now ?? new Date()
  let root: string
  try {
    if (!existsSync(rosterPath())) return Promise.resolve('skipped')
    root = workspaceRoot(realpathSync(directory))
  } catch {
    return Promise.resolve('skipped')
  }
  const active = running.get(root)
  if (active) return active
  const last = asked.get(root)
  if (last !== undefined && within(last, now.getTime())) return Promise.resolve('fresh')
  try {
    const checkedAt = Date.parse(workspaceVisibility(root, now).record?.checked_at ?? '')
    if (within(checkedAt, now.getTime())) return Promise.resolve('fresh')
  } catch {
    // An unreadable record is refreshed like a missing one.
  }
  asked.set(root, now.getTime())
  const run = refreshVisibility(root, { ...options, now })
    .then((): VisibilityRefreshOutcome => 'refreshed', (): VisibilityRefreshOutcome => 'skipped')
    .finally(() => running.delete(root))
  running.set(root, run)
  return run
}

/** Tests only: forget what this process asked. */
export function resetVisibilityRefresh(): void {
  asked.clear()
  running.clear()
}
