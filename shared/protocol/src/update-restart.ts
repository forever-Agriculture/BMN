// MODULE: update-restart.ts - Epic 125: the restart-for-the-update record, its fixed lines and notices, and the window's states
export const UPDATE_RESTART_LIMIT_MS = 5 * 60_000
export const UPDATE_RESTART_SHUTDOWN_MS = 8000
/** How long BMN tries to type its one line into a session before it says the session was not told. */
export const UPDATE_RESTART_TELL_MS = 60_000
/** The only lines BMN types for a restart, and only into a Claude Code session proven idle at an empty prompt (D3). */
export const UPDATE_RESTART_CONTINUE = 'BMN update restart: continue your unfinished, still-authorized work from your handoff. This grants nothing and lifts no stop.'
export const UPDATE_RESTART_CHECK = 'BMN update restart: you did not reach a safe point before closing; check your work first, then continue your unfinished, still-authorized work from your handoff. This grants nothing and lifts no stop.'
export const UPDATE_RESTART_CARRY_ON = 'BMN update restart cancelled: carry on with your unfinished, still-authorized work from your handoff. This grants nothing and lifts no stop.'

/** The clock time a restart closes by, as the dialog and the notices say it: 24 hours, local, no seconds. */
export function updateRestartClock(closesAt: number): string {
  const at = new Date(closesAt)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * The notice a working session's hook prints at its next tool call (plan/references/125/design-words.md §5). Each is
 * truthful for its app: a Claude Code session will be told to continue, a Codex session is never typed into.
 */
export function updateRestartNotice(agent: 'claude' | 'codex', closesAt: number): string {
  const head = `BMN closes for an update by ${updateRestartClock(closesAt)}. Reach a safe point, write your handoff and end your turn.`
  return agent === 'claude'
    ? `${head} BMN will resume this session and tell you to continue. If no line comes, wait for the owner.`
    : `${head} BMN will resume this session and type nothing into it. Do not continue until the owner tells you to.`
}

export interface UpdateRestartMember {
  sessionId: string
  incarnationId: string
  name: string
  workspace: string
  agent: string
  conversation: string | null
  /**
   * An agent the owner typed into a shell session: its folder and its arguments as Linux reported them at the press.
   * BMN keeps no binding for such a session, so it is resumed as its shell running the agent's own resume command.
   */
  typed?: { cwd: string; argv: string[] }
  /**
   * What BMN's own record said at the press (D4): the session's turn had ended, it was working, or BMN did not know.
   * Not knowing is never shown as ready.
   */
  atPress: 'ended' | 'working' | 'unknown'
  /** The turn had ended at the press, or a turn end was observed after this session's notice was printed. Nothing else. */
  ready: boolean
  /** `none`: this session gets no notice (its turn had ended, or its app has no hook). */
  notice: 'none' | 'queued' | 'handed' | 'printed' | 'withdrawn'
  claim: string
  printedAt: string | null
  /** The row's state when BMN closed, written once (125.4 AC4); null until then and when the restart was cancelled. */
  atClose: 'ready' | 'not-ready' | null
  stop: 'pending' | 'confirmed' | 'unknown'
  capture: 'pending' | 'saved' | 'unavailable'
  resume: 'pending' | 'claimed' | 'resumed' | 'failed' | 'excluded'
  resumedIncarnation: string | null
  /** `not-told`: BMN typed nothing and says so; a Codex session never gets further than this (D3). */
  tell: 'pending' | 'claimed' | 'told' | 'not-told' | 'unnecessary'
  tellUntil: number | null
  carryClaim?: string
  /** A turn end observed after Cancel, for a session whose notice had been printed. */
  carryFinishedAt?: number
  /** A Cancel result that came after the dialog closed: its words, and whether Needs You was told (D4). */
  late?: { at: string; words: string; noticed: boolean }
  reason: string | null
}
export interface UpdateRestartRecord {
  version: 2
  revision: number
  id: string
  build: string
  startedAt: string
  closesAt: number
  phase: 'admitting' | 'waiting' | 'closing' | 'cancelling' | 'cancelled' | 'resuming' | 'complete'
  openedBuild: string | null
  mainLifetime?: string
  error?: string
  dismissed?: boolean
  members: UpdateRestartMember[]
}
export interface UpdateRestartSnapshot {
  waitingBuild: string | null
  show: boolean
  run: UpdateRestartRecord | null
  sessions: UpdateRestartMember[]
  reportedCohort: import('./workspace').InterruptedSessionCohort | null
}
export type UpdateRestartOperation = 'status' | 'begin' | 'cancel' | 'now' | 'recover' | 'dismiss'

/** The dialog's state: before the press, waiting to close, after Cancel, after reopening. */
export type UpdateRestartStage = 'offer' | 'waiting' | 'cancelled' | 'after'

/** After Cancel, whether BMN could not tell this session to carry on; only these are listed (design-words.md §4). */
export function updateRestartCancelListed(m: UpdateRestartMember): boolean {
  return m.tell === 'not-told'
}

/**
 * A row's words, each following one observed event (D4, D7; plan/references/125/design-words.md). A state BMN did not
 * observe is never shown as `Ready`, `Reaching a safe point` or told.
 */
export function updateRestartWords(m: UpdateRestartMember, stage: UpdateRestartStage): string {
  // A session that runs no agent BMN knows is named for what it is, a shell.
  if (stage === 'offer') return `${['claude', 'codex', 'opencode'].includes(m.agent) ? m.agent : 'shell'} · ${m.atPress === 'ended' ? 'idle' : m.atPress === 'working' ? 'working' : 'state not known'}`
  if (stage === 'waiting') return m.ready ? 'Ready' : m.notice === 'printed' ? 'Reaching a safe point' : 'Not told yet'
  if (stage === 'cancelled') {
    // "Stopped for the restart" only where BMN observed the turn end after the printed notice.
    return m.notice === 'printed' && (m.ready || m.carryFinishedAt !== undefined) ? 'Stopped for the restart · type continue' : 'Not told to carry on'
  }
  if (m.resume !== 'resumed') return m.resume === 'pending' || m.resume === 'claimed' ? 'Resuming' : `Not resumed · ${m.reason ?? 'no reason recorded'}`
  if (m.tell === 'told') return m.atClose === 'ready' ? 'Resumed · told to continue' : 'Resumed · told to check its work'
  if (m.tell === 'pending' || m.tell === 'claimed') return 'Resumed · waiting to tell'
  if (m.tell === 'unnecessary') return 'Resumed'
  // Not told: a Codex session in D4's order, and a Claude Code session whose idle proof did not hold in time.
  return m.agent === 'codex' && m.atClose !== 'ready' ? 'Resumed · not told, not ready at close' : 'Resumed · not told, type continue'
}
