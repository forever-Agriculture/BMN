// MODULE: turn-changes.ts - the fixed words of turn changes (Epic 69): which apps are recorded and on which version that was measured, what a hook's mark may say, every wording and label a turn can carry
//
// Nothing here can hold a file's name: a wording takes a bound, a fixed reason, an app, a version or a
// count, and a label takes the work tree's root, times and commits.

/** The switch's words in a workspace's menu. */
export const TURN_CHANGES_SWITCH = 'Record what each turn changes'

/** What the switch's help says, wherever the switch is shown (Story 69.4, criterion 1). */
export const TURN_CHANGES_HELP = [
  'BMN keeps a copy of the files in the Git work tree the agent runs in, every tracked file and every untracked file Git does not ignore, secrets in them included, on this computer for as long as you keep agent history.',
  'Removal runs when BMN starts and every hour; one that failed shows as pending.',
  'BMN shows what differs between two scans of that work tree, not who changed it.'
] as const

/**
 * The apps whose turns are recorded: those measured to wait for their prompt hook before they act, with the
 * version that was measured on and the event that carries a prompt (docs/turn-changes.md). `promptArrives`
 * says when that event comes for a prompt typed while a turn runs: when it is `typed`, or when it is `taken`
 * into the turn. `bin/turn-marks.mjs` `TURN_MARKS` holds the same record for the hook; a test holds the two
 * together. An app that is not here sends no mark and has no turn recorded.
 */
export const TURN_RECORDED_APPS: Readonly<Record<string, { version: string; promptEvent: string; promptArrives: 'typed' | 'taken' } | undefined>> = Object.freeze({
  claude: { version: '2.1.296', promptEvent: 'UserPromptSubmit', promptArrives: 'typed' },
  codex: { version: '0.162.1', promptEvent: 'UserPromptSubmit', promptArrives: 'taken' }
})

/** How an app is named in a wording or a label. */
export const TURN_APP_NAMES: Readonly<Record<string, string | undefined>> = Object.freeze({ claude: 'Claude Code', codex: 'Codex' })

/**
 * The folder beside the control socket in which an empty file named after a session says, to that session's
 * hook, that its workspace's switch is on. The hook holds the same name (`bin/turn-marks.mjs` `turnSwitchFile`).
 */
export const TURN_SWITCH_FOLDER = 'turn-marks'

/** How long everything a mark adds to a prompt may take: waiting for an earlier capture, listing, reading, the answer and its confirmation (R69-NFR5). */
export const TURN_MARK_LIMIT_MS = 300
/** How long a capture nobody waits for may take, and a comparison (R69-NFR5). */
export const TURN_CAPTURE_LIMIT_MS = 2_000

export const TURN_MARK_EDGES = ['start', 'confirm', 'end'] as const
export type TurnMarkEdge = (typeof TURN_MARK_EDGES)[number]

/** How a turn's end event names it. `continues` is a stop the app goes on from by itself: the turn stays open. */
export const TURN_END_KINDS = ['finished', 'error', 'interrupted', 'continues'] as const
export type TurnEndKind = (typeof TURN_END_KINDS)[number]

/**
 * The one word the host answers a mark with; never more. `captured` and `incomplete` are a "before" that
 * waits for the hook's confirmation.
 */
export const TURN_MARK_STATUSES = [
  'captured', 'incomplete', 'unavailable', 'not-supported', 'busy', 'late', 'off', 'paused', 'continued', 'overlapped', 'confirmed', 'queued', 'stale', 'repeated'
] as const
export type TurnMarkStatus = (typeof TURN_MARK_STATUSES)[number]
/** The statuses after which the hook sends its confirmation. */
export const TURN_MARK_CONFIRMED_STATUSES: readonly TurnMarkStatus[] = Object.freeze(['captured', 'incomplete'])

/** The word for how a turn ended, as its record keeps it. */
export const TURN_ENDS = ['finished', 'error', 'interrupted', 'not-observed', 'switched-off'] as const
export type TurnEnd = (typeof TURN_ENDS)[number]

export const TURN_END_WORDS: Readonly<Record<TurnEnd, string>> = Object.freeze({
  finished: 'finished',
  error: 'error',
  interrupted: 'interrupted',
  'not-observed': 'End not observed',
  'switched-off': 'Recording was switched off'
})

/**
 * Why a turn has no complete totals: exactly one of these nine, and no other (Story 69.4, criterion 9). When
 * more than one applies the first in this order is said.
 */
export const TURN_WORDINGS = Object.freeze({
  switchedOff: (): string => 'Recording was switched off',
  overlapped: (): string => 'Comparison unavailable: prompts overlapped',
  beforeUnavailable: (): string => 'Before snapshot unavailable',
  notSupported: (reason: string): string => `Not supported here: ${reason}`,
  finalScanUnavailable: (): string => 'End not observed; final scan unavailable',
  incomplete: (bound: string): string => `Incomplete: ${bound}`,
  limitReached: (): string => 'Difference unavailable: limit reached',
  orderingUnverified: (app: string, version: string): string => `Ordering unverified on ${app} ${version}; early writes may be missed`,
  partial: (files: number): string => `Partial: ${files} files`
})

/** The labels a closed turn carries (Story 69.4, criterion 8). The first three always; the others when they apply. */
export const TURN_LABELS = Object.freeze({
  scans: (root: string, first: readonly [string, string], second: readonly [string, string]): string =>
    `Two scans of ${root}, the first from ${first[0]} to ${first[1]}, the second from ${second[0]} to ${second[1]}. ` +
    'Files in a scan were read at different moments, and other programs\' changes may be included',
  covered: (): string =>
    'Covered: every tracked file and every untracked file Git does not ignore. Not covered: other ignored files, anything outside this work tree, ' +
    'and the contents of submodules and nested repositories, of which only the recorded commit is compared',
  after: (): string => 'Anything written after the second scan ended is not included',
  endNotObserved: (): string => 'End not observed: compared through BMN\'s next scan; whatever changed in between is included',
  sharedWorkTree: (): string => 'Another BMN session was started in this work tree; whether it worked here is not known',
  head: (a: string, b: string, c: string, d: string): string =>
    `HEAD was ${a} when the first scan began and ${b} when it ended, ${c} and ${d} for the second; what Git brought in may be included, and moves in between may be missed`,
  version: (app: string, version: string, measured: string): string => `This turn ran on ${app} ${version}; waiting for the prompt hook was measured on ${measured}`,
  partial: (files: number): string => `Partial: ${files} files were not read or entered or left what is covered`
})

/** Why recording is paused for a session's work tree: a fixed list, never a file's name (Story 69.4, criterion 10). */
export const TURN_PAUSE_REASONS = Object.freeze({
  incomplete: 'Three scans in a row were incomplete and read nothing new',
  failed: 'Three scans in a row failed',
  mixed: 'Three scans in a row failed, or were incomplete and read nothing new'
})
export type TurnPauseReason = keyof typeof TURN_PAUSE_REASONS
/** How many captures in a row may fail, or be incomplete without reading anything new, before recording pauses. */
export const TURN_PAUSE_AFTER = 3

/** Where recording stands for one session, as the window shows it beside a turn's numbers. Window only: it reaches no snapshot, token or phone. */
export interface TurnRecordingState {
  sessionId: string
  /** `off`: the workspace's switch is off. `not-supported`: the app now running is not a recorded one. */
  state: 'recording' | 'off' | 'paused' | 'not-supported'
  /** The app now in the terminal's foreground, when BMN knows it. */
  app: string | null
  /** While paused: the work tree's root and the reason. */
  pausedRoot: string | null
  pauseReason: TurnPauseReason | null
}

export function isTurnRecordingState(value: unknown): value is TurnRecordingState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return typeof state.sessionId === 'string' &&
    ['recording', 'off', 'paused', 'not-supported'].includes(state.state as string) &&
    (state.app === null || typeof state.app === 'string') &&
    (state.pausedRoot === null || typeof state.pausedRoot === 'string') &&
    (state.pauseReason === null || Object.hasOwn(TURN_PAUSE_REASONS, state.pauseReason as string))
}

// ---- what the window reads (Story 69.5) -------------------------------------------------------------
//
// These reach the window through its own channels only. No token reads them: the control socket has no
// method that returns a turn, a file's name or a difference.

/** How much of one file's difference is shown: at most this many lines or bytes, and a line cut at this many characters. */
export const TURN_SHOWN_LIMITS = Object.freeze({ lines: 5_000, bytes: 256 * 1024, lineCharacters: 2_000 })
/** How many turns the dialog lists, newest first. */
export const TURN_LIST_LIMIT = 50
/** How many files of one turn are listed; the rest is a count. */
export const TURN_FILES_LIMIT = 2_000
/** What stands in a shown line where a secret value is: one plate, the same whatever the value's length. */
export const TURN_SECRET_PLATE = '••••••••••'

export type TurnTotalsWord = 'complete' | 'partial' | 'not-complete' | 'none'

/** One kept turn as the list shows it. Nothing here can hold a file's name or content. */
export interface TurnSummary {
  turnId: string
  number: number
  app: string
  appVersion: string | null
  startedAt: string
  endedAt: string | null
  /** How it ended, one of `TURN_ENDS`; null while it runs. */
  end: string | null
  state: 'open' | 'provisional' | 'closed'
  totalsState: TurnTotalsWord
  totals: { files: number; added: number; removed: number } | null
  /** Why the totals are not complete, in one of the nine wordings. */
  wording: string | null
}

/** Where recording stands for a session, with its latest kept turn: what the header's plate and the dialog's state line read. */
export interface TurnSessionView extends TurnRecordingState {
  latest: TurnSummary | null
  /** A removal of this session's stored bytes waits for its next try. */
  removalPending: boolean
}

/** One file of an opened turn. `note` says what a state alone does not: why it was not read, what changed kind, a binary file's sizes. */
export interface TurnFileView {
  path: string
  state: string
  added: number | null
  removed: number | null
  note: string | null
  /** Whether a difference can be opened for it. */
  opens: boolean
}

export interface TurnDetail {
  turn: TurnSummary
  workTree: string | null
  labels: string[]
  files: TurnFileView[]
  /** Files beyond `TURN_FILES_LIMIT`. */
  moreFiles: number
  /** Why no files are listed, when the two scans could not be compared now. */
  unavailable: string | null
}
/** `kept: false`: the turn is no longer kept. */
export type TurnDetailAnswer = { kept: true; detail: TurnDetail } | { kept: false }

/** One shown line. `text` is what may be read, copied and found: every secret value in it is already the plate, at `masks`. */
export interface TurnShownLine {
  kind: ' ' | '-' | '+'
  /** The line's number in the earlier and the later text, as the original texts count them. */
  a: number | null
  b: number | null
  text: string
  masks: Array<[start: number, end: number]>
  /** The line was longer than `TURN_SHOWN_LIMITS.lineCharacters`. */
  cut: boolean
}
/** The mark after a last line that has no line ending. */
export interface TurnShownMark { kind: '\\' }

export interface TurnShownHunk {
  aStart: number
  aLines: number
  bStart: number
  bLines: number
  /** The only thing that differs in this hunk is inside masked values. */
  secret: boolean
  lines: Array<TurnShownLine | TurnShownMark>
}

export type TurnShownDifference =
  /** `more`: lines not shown; 0 when all are, null when there are more and their number is not known. */
  | { state: 'text'; added: number; removed: number; hunks: TurnShownHunk[]; more: number | null }
  | { state: 'binary'; sizeBefore: number | null; sizeAfter: number | null }
export type TurnDifferenceAnswer =
  | { kept: true; difference: TurnShownDifference }
  | { kept: true; unavailable: string }
  | { kept: false }
