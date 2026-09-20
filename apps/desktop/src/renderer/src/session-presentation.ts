// MODULE: session-presentation.ts - status dots, agent tags, progress freshness and needs-you ordering for the shell
import type { SessionActivity } from './session-activity'
import {
  PROGRESS_STALE_AFTER_MS,
  type AttentionRecord,
  type ProgressEvidence,
  type ProgressRecord,
  type ProgressState,
  type SessionRecord
} from '@bmn/protocol'

export type SessionDot = 'running' | 'running-idle' | 'needs-you' | 'exited' | 'idle'

export type SessionAttention = 'response' | 'update' | null

export interface SessionStatusPresentation {
  dot: SessionDot
  word: string
}

/**
 * The row/heading status: an open request outranks process state, and a fresh failed or blocked report outranks
 * observed activity; idle is a ring only. `activity` is the observed word for a live session, and is used nowhere else.
 */
/**
 * A pane outlives its process on purpose: when a command ends, the view stays so the owner can read
 * what it printed. Liveness therefore is not "a view is attached" but "the attached incarnation has
 * not ended" -- without this the row keeps calling a finished session Running.
 */
export function sessionProcessLive(
  session: Pick<SessionRecord, 'lastProcess'>,
  liveIncarnationId: string | undefined
): boolean {
  if (!liveIncarnationId) return false
  const last = session.lastProcess
  return !(last?.incarnationId === liveIncarnationId && last.state !== 'live')
}

export function sessionStatus(
  session: Pick<SessionRecord, 'sessionId' | 'lastProcess'>,
  live: boolean,
  openRequests: readonly Pick<AttentionRecord, 'sessionId' | 'state' | 'kind'>[],
  progress: ProgressPresentation | null = null,
  activity: SessionActivity | null = null
): SessionStatusPresentation {
  const attention = sessionAttention(openRequests, session.sessionId)
  if (attention === 'response') {
    return { dot: 'needs-you', word: 'Waiting for your response' }
  }
  if (progress && !progress.stale && (progress.state === 'failed' || progress.state === 'blocked')) {
    return { dot: 'exited', word: `${progress.word} · ${progress.source}, ${progress.age}` }
  }
  if (attention === 'update') return { dot: 'needs-you', word: 'Update available' }
  if (live) {
    if (!activity) return { dot: 'running', word: 'Running' }
    return { dot: activity.working ? 'running' : 'running-idle', word: activity.word }
  }
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

const ORIGIN_AGENT_NAMES: Readonly<Record<string, string>> = Object.freeze({ claude: 'Claude', codex: 'Codex' })

/** The plain name of whatever acted on a request, or null when the row predates provenance. */
function originName(origin: string | null, action: 'opened' | 'closed'): string | null {
  if (origin === null) return null
  if (origin.startsWith('hook:')) {
    // Only the agent is split off: an event name may contain a colon, and the owner should see all of it.
    const rest = origin.slice('hook:'.length)
    const separator = rest.indexOf(':')
    const agent = separator < 0 ? rest : rest.slice(0, separator)
    const event = separator < 0 ? '' : rest.slice(separator + 1)
    return `${ORIGIN_AGENT_NAMES[agent] ?? agent} ${event}`.trim()
  }
  switch (origin) {
    case 'cli': return action === 'opened' ? 'bmn ask' : 'the bmn CLI'
    case 'owner': return 'BMN'
    case 'input': return 'typing'
    case 'telegram': return 'Telegram'
    case 'expiry': return 'expiry'
    default: return origin
  }
}

/**
 * Says in plain words what opened a request, or what closed it: "from Claude Notification",
 * "resolved by typing", "withdrawn by Claude Stop", "expired". A row with no provenance says so.
 */
export function attentionProvenance(
  request: Pick<AttentionRecord, 'state' | 'openedBy' | 'resolvedBy'>
): string {
  if (request.state === 'open') {
    const name = originName(request.openedBy, 'opened')
    return name === null ? 'from unknown' : `from ${name}`
  }
  if (request.state === 'expired') return 'expired'
  const verb = request.state === 'withdrawn' ? 'withdrawn' : 'resolved'
  if (request.resolvedBy === 'telegram') return 'answered from Telegram'
  const name = originName(request.resolvedBy, 'closed')
  return name === null ? `${verb} by unknown` : `${verb} by ${name}`
}

/**
 * `verified` is the reporter's word, never BMN's verdict, so the strip says who said it. The wire
 * vocabulary keeps `verified` for compatibility; only the display changes.
 */
const PROGRESS_WORDS: Readonly<Record<ProgressState, string>> = Object.freeze({
  running: 'Running',
  waiting: 'Waiting',
  blocked: 'Blocked',
  'claimed-done': 'Agent reports done',
  verified: 'Reported verified',
  failed: 'Failed',
  unknown: 'Unknown'
})

/**
 * Stale normally reads "Last observed running". The two states that are a report rather than an
 * observation need their own past tense, because lowercasing their word would give the unreadable
 * "Last observed reported verified".
 */
const PROGRESS_STALE_WORDS: Readonly<Partial<Record<ProgressState, string>>> = Object.freeze({
  verified: 'Last reported verified',
  'claimed-done': 'Last reported done'
})

export interface ProgressPresentation {
  label: string
  state: ProgressState
  word: string
  source: string
  age: string
  stale: boolean
  detail: string | null
  /** The files the reporter attached, in the order it named them; never a judgement about them. */
  evidence: readonly ProgressEvidence[]
  /** "Evidence attached (2)" or "No evidence attached", shown for every state at every strip site. */
  evidenceWord: string
  /** Identifies this exact observation, so an open detail can tell when a newer one replaced it. */
  observedAt: string
  /** When BMN stored it. Two reports can share an `observedAt`; they cannot share this. */
  receivedAt: string
}

/**
 * The same observation read at a later moment. A detail opened minutes ago must not keep saying
 * "0 s ago": its words are frozen deliberately, its age is not.
 */
export function agedProgress(progress: ProgressPresentation, now: number): ProgressPresentation {
  const stale = now - Date.parse(progress.observedAt) > PROGRESS_STALE_AFTER_MS
  return {
    ...progress,
    stale,
    word: progressWord(progress.state, stale),
    age: relativeAge(progress.observedAt, now)
  }
}

function progressWord(state: ProgressState, stale: boolean): string {
  if (!stale) return PROGRESS_WORDS[state]
  return PROGRESS_STALE_WORDS[state] ?? `Last observed ${PROGRESS_WORDS[state].toLocaleLowerCase()}`
}

/** The newest observation for a session, with age and a stale word after the freshness window. */
export function progressPresentation(
  records: readonly ProgressRecord[],
  sessionId: string,
  now: number,
  incarnationId?: string | null
): ProgressPresentation | null {
  const newest = records
    .filter((record) => record.sessionId === sessionId &&
      (incarnationId === undefined || record.incarnationId === incarnationId))
    .toSorted((left, right) => right.observedAt.localeCompare(left.observedAt))[0]
  if (!newest) return null
  const stale = now - Date.parse(newest.observedAt) > PROGRESS_STALE_AFTER_MS
  const evidence = newest.evidence ?? []
  return {
    label: newest.label,
    state: newest.state,
    word: progressWord(newest.state, stale),
    source: newest.source,
    age: relativeAge(newest.observedAt, now),
    stale,
    detail: newest.detail,
    evidence,
    evidenceWord: evidence.length === 0 ? 'No evidence attached' : `Evidence attached (${evidence.length})`,
    observedAt: newest.observedAt,
    receivedAt: newest.receivedAt
  }
}

export function isActionableAttention(
  request: Pick<AttentionRecord, 'kind'>
): boolean {
  return request.kind !== 'notice'
}

export function openRequests(records: readonly AttentionRecord[]): AttentionRecord[] {
  return records
    .filter((record) => record.state === 'open')
    .toSorted((left, right) => left.openedAt.localeCompare(right.openedAt) || left.requestId.localeCompare(right.requestId))
}

export function openAttentionGroups(records: readonly AttentionRecord[]): {
  responses: AttentionRecord[]
  updates: AttentionRecord[]
} {
  const open = openRequests(records)
  return {
    responses: open.filter(isActionableAttention),
    updates: open.filter((request) => !isActionableAttention(request))
  }
}

export function sessionAttention(
  records: readonly Pick<AttentionRecord, 'sessionId' | 'state' | 'kind'>[],
  sessionId: string
): SessionAttention {
  const open = records.filter((request) => request.sessionId === sessionId && request.state === 'open')
  if (open.some(isActionableAttention)) return 'response'
  return open.some((request) => request.kind === 'notice') ? 'update' : null
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
  const groups = openAttentionGroups(records)
  const open = groups.responses.length > 0 ? groups.responses : groups.updates
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
