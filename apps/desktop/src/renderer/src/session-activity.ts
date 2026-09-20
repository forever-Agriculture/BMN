// MODULE: session-activity.ts - the observed working/idle word for a live session, from output activity and its title
//
// Two passive signals every session already emits: the bytes it prints, and the title its harness sets. Nothing here
// scrapes the screen, and nothing here acts: the result is a word and a mark for the sidebar, the pane heading and the
// palette. Output activity alone decides Working; the title may only refine the resting word.

/** The renderer re-derives every live session on this tick, which also caps presentation updates at two per second. */
export const ACTIVITY_TICK_MS = 500
/** Silence this long reads as idle; with the tick the word lands 1.5-2.0 s after the last byte. */
export const ACTIVITY_IDLE_AFTER_MS = 1_500
/** A fresh incarnation that has printed nothing yet reads as starting, not idle. */
export const ACTIVITY_START_GRACE_MS = 3_000
/** A title is a display string, never a key; a runaway title is cut, not rejected. */
export const TERMINAL_TITLE_MAX = 256

export type ActivityWord = 'Working' | 'Idle' | 'Running' | 'Action required'

export interface SessionActivity {
  word: ActivityWord
  /** The filled mark. Only Working fills it; Idle, Running and Action required keep the hollow one. */
  working: boolean
  /** The capped title this word was derived with, for the row tooltip; null when the harness has set none. */
  title: string | null
}

/** What the renderer has observed about one live incarnation. Times are epoch milliseconds. */
export interface ActivityObservation {
  /** The incarnation this observation belongs to; a new one starts a new observation. */
  incarnationId: string
  /** When the renderer first saw this incarnation live. */
  liveSince: number
  /** The last output event for this incarnation, or null when none has arrived. */
  lastOutputAt: number | null
  /** The newest terminal title, already capped, or null when the harness has set none. */
  title: string | null
}

/**
 * Titles known CLIs set while they wait. Prefix and substring rules only, no regular expressions, and no row may say
 * Working: output activity already says that. The table is allowed to be incomplete - an unknown title changes nothing.
 * Checked against Claude Code 2.1.278 and Codex 0.155.1 (2026-09-20).
 */
export const TITLE_WORDS = Object.freeze([
  Object.freeze({ cli: 'claude-code', rule: 'prefix', text: '✳', word: 'Idle' }),
  Object.freeze({ cli: 'codex', rule: 'contains', text: 'Action Required', word: 'Action required' })
] as const satisfies readonly { cli: string; rule: 'prefix' | 'contains'; text: string; word: ActivityWord }[])

/** Cuts a title to the stored length; xterm hands over whatever the process wrote. */
export function capTitle(title: string): string {
  return title.length > TERMINAL_TITLE_MAX ? title.slice(0, TERMINAL_TITLE_MAX) : title
}

/** The resting word a known title asks for, or null when the title says nothing this table knows. */
export function titleWord(title: string | null): ActivityWord | null {
  if (title === null) return null
  const trimmed = title.trim()
  if (trimmed === '') return null
  for (const row of TITLE_WORDS) {
    const matches = row.rule === 'prefix' ? trimmed.startsWith(row.text) : trimmed.includes(row.text)
    if (matches) return row.word
  }
  return null
}

/**
 * The word for one live session. Output within the idle window is Working, whatever the title says; a silent fresh
 * incarnation is Running until the grace ends; everything else rests, and only then may the title name the rest.
 */
export function sessionActivity(observation: ActivityObservation, now: number): SessionActivity {
  const title = observation.title
  if (observation.lastOutputAt !== null && now - observation.lastOutputAt < ACTIVITY_IDLE_AFTER_MS) {
    return { word: 'Working', working: true, title }
  }
  if (observation.lastOutputAt === null && now - observation.liveSince < ACTIVITY_START_GRACE_MS) {
    return { word: 'Running', working: false, title }
  }
  return { word: titleWord(title) ?? 'Idle', working: false, title }
}

/** One word per observed session, for the tick that refreshes them all. */
export function sessionActivities(
  observations: ReadonlyMap<string, ActivityObservation>,
  now: number
): Record<string, SessionActivity> {
  const activities: Record<string, SessionActivity> = {}
  for (const [sessionId, observation] of observations) activities[sessionId] = sessionActivity(observation, now)
  return activities
}

/** A session's presentation may change at most this often, which is AC4's two updates per second. */
export const ACTIVITY_MIN_PUBLISH_MS = 500

/**
 * Holds back a session whose presentation changed less than `ACTIVITY_MIN_PUBLISH_MS` ago, so one session's first
 * byte cannot carry another session's pending title change past the cap. The tick re-derives from the same
 * observations, so a held change lands at most one tick late - far inside the 1.5 s idle window.
 *
 * Entering Working is never held: AC1 says the first byte makes a session Working at once, and a session can
 * only enter Working again after the idle window has passed, so the exemption cannot itself breach the cap.
 */
export function publishableActivities(
  previous: Readonly<Record<string, SessionActivity>>,
  next: Readonly<Record<string, SessionActivity>>,
  publishedAt: Readonly<Record<string, number>>,
  now: number
): Record<string, SessionActivity> {
  const publishable: Record<string, SessionActivity> = {}
  for (const [sessionId, derived] of Object.entries(next)) {
    const before = previous[sessionId]
    const last = publishedAt[sessionId]
    const changed = !before ||
      before.word !== derived.word || before.working !== derived.working || before.title !== derived.title
    const tooSoon = last !== undefined && now - last < ACTIVITY_MIN_PUBLISH_MS
    const startedWorking = derived.working && (!before || !before.working)
    publishable[sessionId] = changed && before && tooSoon && !startedWorking ? before : derived
  }
  return publishable
}

/** True when two derivations would render the same, so the tick can skip the update entirely. */
export function sameActivities(
  left: Readonly<Record<string, SessionActivity>>,
  right: Readonly<Record<string, SessionActivity>>
): boolean {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => {
    const before = left[key]
    const after = right[key]
    return !!after && !!before &&
      before.word === after.word && before.working === after.working && before.title === after.title
  })
}
