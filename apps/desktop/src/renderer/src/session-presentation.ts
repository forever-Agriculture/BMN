// MODULE: session-presentation.ts - status dots, agent tags, progress freshness and needs-you ordering for the shell
import {
  PROGRESS_STALE_AFTER_MS,
  type AttentionRecord,
  type ProgressRecord,
  type ProgressState,
  type SessionRecord
} from '@bmn/protocol'

export type SessionDot = 'running' | 'needs-you' | 'exited' | 'idle'

export interface SessionStatusPresentation {
  dot: SessionDot
  word: string
}

/** The row/heading status: an open request outranks process state; idle is a ring only. */
export function sessionStatus(
  session: Pick<SessionRecord, 'sessionId' | 'lastProcess'>,
  live: boolean,
  openRequests: readonly Pick<AttentionRecord, 'sessionId' | 'state'>[]
): SessionStatusPresentation {
  if (openRequests.some((request) => request.sessionId === session.sessionId && request.state === 'open')) {
    return { dot: 'needs-you', word: 'Waiting for your response' }
  }
  if (live) return { dot: 'running', word: 'Running' }
  if (session.lastProcess?.state === 'interrupted') return { dot: 'exited', word: 'Interrupted' }
  if (session.lastProcess) return { dot: 'exited', word: 'Process exited' }
  return { dot: 'idle', word: 'Not started' }
}

const AGENT_TAGS: Readonly<Record<string, string>> = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  aider: 'Aider',
  bash: 'Shell',
  zsh: 'Shell',
  fish: 'Shell',
  sh: 'Shell',
  dash: 'Shell',
  nu: 'Shell'
})

export function agentTag(executable: string): string {
  const base = executable.split('/').pop() ?? executable
  return AGENT_TAGS[base] ?? base
}

/** Shortens a path under the home directory to `~` for display only. */
export function displayPath(path: string, home: string | null): string {
  if (!home) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Guesses the home directory from absolute session paths (`/home/<user>` or `/root`). */
export function inferHome(paths: readonly string[]): string | null {
  for (const path of paths) {
    const match = /^(\/home\/[^/]+|\/root)(\/|$)/.exec(path)
    if (match?.[1]) return match[1]
  }
  return null
}

export function relativeAge(fromIso: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(fromIso))
  if (!Number.isFinite(elapsed)) return 'unknown time'
  const seconds = Math.round(elapsed / 1000)
  if (seconds < 45) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

const PROGRESS_WORDS: Readonly<Record<ProgressState, string>> = Object.freeze({
  running: 'Running',
  waiting: 'Waiting',
  blocked: 'Blocked',
  'claimed-done': 'Agent reports done',
  verified: 'Verified',
  failed: 'Failed',
  unknown: 'Unknown'
})

export interface ProgressPresentation {
  label: string
  state: ProgressState
  word: string
  source: string
  age: string
  stale: boolean
  detail: string | null
}

/** The newest observation for a session, with age and a stale word after the freshness window. */
export function progressPresentation(
  records: readonly ProgressRecord[],
  sessionId: string,
  now: number
): ProgressPresentation | null {
  const newest = records
    .filter((record) => record.sessionId === sessionId)
    .toSorted((left, right) => right.observedAt.localeCompare(left.observedAt))[0]
  if (!newest) return null
  return {
    label: newest.label,
    state: newest.state,
    word: PROGRESS_WORDS[newest.state],
    source: newest.source,
    age: relativeAge(newest.observedAt, now),
    stale: now - Date.parse(newest.observedAt) > PROGRESS_STALE_AFTER_MS,
    detail: newest.detail
  }
}

export function openRequests(records: readonly AttentionRecord[]): AttentionRecord[] {
  return records
    .filter((record) => record.state === 'open')
    .toSorted((left, right) => left.openedAt.localeCompare(right.openedAt) || left.requestId.localeCompare(right.requestId))
}

/**
 * The open requests the owner answers by typing, pasting or dictating into their session, the way agterm clears a
 * session's status on a keystroke. A review waits for its own verdict.
 */
export function requestsAnsweredByTyping(records: readonly AttentionRecord[], sessionId: string): AttentionRecord[] {
  return openRequests(records).filter((record) => record.sessionId === sessionId && record.kind !== 'review')
}

export type OpenAttentionAction = 'mark-seen' | 'resolve-notice' | null

/** Opening an informational notice completes it; opening a prompt only records that it was seen. */
export function attentionActionWhenOpened(
  request: Pick<AttentionRecord, 'kind' | 'state' | 'seenAt'>
): OpenAttentionAction {
  if (request.state !== 'open') return null
  if (request.kind === 'notice') return 'resolve-notice'
  return request.seenAt === null ? 'mark-seen' : null
}

/** The next unresolved request after the current session's, wrapping; null when none wait. */
export function nextRequest(
  records: readonly AttentionRecord[],
  currentSessionId: string | null
): AttentionRecord | null {
  const open = openRequests(records)
  if (open.length === 0) return null
  const currentIndex = open.findIndex((request) => request.sessionId === currentSessionId)
  if (currentIndex === -1) return open[0] ?? null
  for (let step = 1; step <= open.length; step += 1) {
    const candidate = open[(currentIndex + step) % open.length]
    if (candidate && candidate.sessionId !== currentSessionId) return candidate
  }
  return open[currentIndex] ?? null
}

/** The window title names what you are working on, as agterm does: the selected session, else its workspace. */
export function windowTitle(workspaceName: string | null, sessionName: string | null): string {
  return sessionName?.trim() || workspaceName?.trim() || 'BMN'
}

/** What can fill a second pane: everything not already shown, starting after the current item and wrapping. */
export function splitCandidates<T>(items: readonly T[], shown: ReadonlySet<T>, current: T | null): T[] {
  const index = current === null ? -1 : items.indexOf(current)
  return [...items.slice(index + 1), ...items.slice(0, index + 1)].filter((item) => !shown.has(item))
}

/** Moves to the neighbor in a list, wrapping; returns the first item when the current one is absent. */
export function neighbor<T>(items: readonly T[], current: T | null, direction: -1 | 1): T | null {
  if (items.length === 0) return null
  const index = current === null ? -1 : items.indexOf(current)
  if (index === -1) return items[0] ?? null
  return items[(index + direction + items.length) % items.length] ?? null
}
