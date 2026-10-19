// MODULE: turn-changes-presentation.ts - the words the window shows for turn changes (Story 69.5): a turn's time, end and totals, the state of recording, the header plate in both its widths, a file's sizes and a hunk's range
import { RETIRED_APP_NAMES, TURN_APP_NAMES, TURN_PAUSE_REASONS, TURN_PAUSE_WORDS, type TurnSessionView, type TurnShownHunk, type TurnSummary } from '@bmn/protocol'
import { shortDate } from './history-rows'

/** The sign of a removed line and of a count of removed lines: a real minus, as wide as the plus. */
export const MINUS = '−'

const APP_NAMES: Readonly<Record<string, string | undefined>> = Object.freeze({ opencode: 'OpenCode', ...RETIRED_APP_NAMES, gemini: 'Gemini', aider: 'Aider' })

/** How an app is named beside a turn; one BMN has no name for keeps its own. */
export function turnAppName(app: string): string {
  return TURN_APP_NAMES[app] ?? APP_NAMES[app] ?? app
}

const count = (value: number): string => value.toLocaleString('en-US')
const pad = (value: number): string => String(value).padStart(2, '0')

/** `14:32` for a turn of today, `12 Oct 18:04` for an earlier one, in the owner's local time. */
export function turnWhen(iso: string, now: number): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '--:--'
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const today = new Date(now)
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  return sameDay ? clock : `${shortDate(iso)} ${clock}`
}

const END_WORDS: Readonly<Record<string, string | undefined>> = Object.freeze({
  finished: 'Finished', error: 'Error', interrupted: 'Interrupted', 'not-observed': 'End not observed',
  // Its wording says the same thing in the place of its totals.
  'switched-off': ''
})

/** The word for how a turn ended; `Running` until it has. */
export function turnEndWord(turn: Pick<TurnSummary, 'state' | 'end'>): string {
  if (turn.state === 'open' || turn.end === null) return 'Running'
  return END_WORDS[turn.end] ?? turn.end
}

interface TurnTotalsWords { files: string; added: string; removed: string }

/** `4 files`, `+120`, `−33`: the three parts of a turn's totals, each in its own tone. */
function turnTotalsWords(totals: { files: number; added: number; removed: number }): TurnTotalsWords {
  return { files: `${count(totals.files)} ${totals.files === 1 ? 'file' : 'files'}`, added: `+${count(totals.added)}`, removed: `${MINUS}${count(totals.removed)}` }
}

/** The totals as one run of text, for a tooltip and an accessible name. */
export function turnTotalsText(totals: { files: number; added: number; removed: number }): string {
  const words = turnTotalsWords(totals)
  return `${words.files} ${words.added} ${words.removed}`
}

/**
 * What a turn's place for totals holds: its totals with the mark that they are partial or not complete, or the
 * wording that says why there are none. A turn still running has neither yet.
 */
export function turnResult(turn: TurnSummary): { totals: TurnTotalsWords | null; mark: 'partial' | 'not complete' | null; wording: string | null } {
  if (turn.totals === null) return { totals: null, mark: null, wording: turn.wording }
  return {
    totals: turnTotalsWords(turn.totals),
    mark: turn.totalsState === 'partial' ? 'partial' : turn.totalsState === 'not-complete' ? 'not complete' : null,
    wording: turn.wording
  }
}

/**
 * When a paused recording scans one turn again by itself (Story 75.4): at its time, or with the next turn once that
 * time has passed.
 */
export function turnRetryWords(retryAt: number | null, now: number): string {
  if (retryAt === null || retryAt <= now) return 'tries again with the next turn'
  return `tries again at ${turnWhen(new Date(retryAt).toISOString(), now)}`
}

/** The dialog's state line: while paused, why and when BMN tries again; otherwise where recording stands. */
export function turnStateLine(view: Pick<TurnSessionView, 'state' | 'app' | 'pauseReason' | 'retryAt'> | null, now: number): string {
  if (view?.state !== 'paused' || view.pauseReason === null) return turnRecordingWords(view)
  return `${TURN_PAUSE_WORDS[view.pauseReason]} · ${turnRetryWords(view.retryAt, now)}`
}

/** Where recording stands, in a word or two. */
export function turnRecordingWords(view: Pick<TurnSessionView, 'state' | 'app'> | null): string {
  if (view === null || view.state === 'off') return 'Recording off'
  if (view.state === 'paused') return 'Paused'
  if (view.state === 'not-supported') return view.app === null ? 'Not supported' : `Not supported for ${turnAppName(view.app)}`
  return 'Recording on'
}

export interface TurnPlatePart { text: string; tone: 'text' | 'muted' | 'caveat' }

/** The one quiet button of a pane's header: its words in a pane over 880 px, its words in a narrower one, and its tooltip. */
interface TurnPlateWords {
  full: TurnPlatePart[]
  short: TurnPlatePart
  title: string
}

/** A wording up to its first `;` or `:`: what a wide pane has room for. */
function wordingHead(wording: string): string {
  return wording.split(/[;:]/, 1)[0] ?? wording
}

/**
 * The header plate of a session. Null when there is nothing to say: no kept turn, and recording neither paused
 * nor anything else the owner has to know of. While recording is off, paused or not supported for the app now
 * running, the state stands first and the earlier turn shrinks to its file count, so that an old number is never
 * read as the latest turn's. Gold (`caveat`) is only ever a turn without complete totals.
 */
export function turnPlate(view: TurnSessionView, now: number): TurnPlateWords | null {
  const turn = view.latest
  if (view.state !== 'recording') {
    if (turn === null && view.state !== 'paused') return null
    const words = turnRecordingWords(view)
    const earlier = turn?.totals ? turnTotalsWords(turn.totals).files : null
    // After its card, the plate is where a pause still says why.
    const standing = view.state === 'paused' && view.pauseReason !== null ? `${words}: ${TURN_PAUSE_REASONS[view.pauseReason]}` : words
    return {
      full: [{ text: words, tone: 'text' }, ...(earlier === null ? [] : [{ text: ` · ${earlier}`, tone: 'muted' } as const])],
      short: { text: view.state === 'not-supported' ? 'Not supported' : words, tone: 'text' },
      title: turn === null ? `Turn changes: ${standing}` : `Turn changes: ${standing}. The latest kept turn, ${turnWhen(turn.startedAt, now)}: ${turnSentence(turn)}`
    }
  }
  if (turn === null) return null
  const title = `Turn changes: the latest turn, ${turnWhen(turn.startedAt, now)}. ${turnSentence(turn)}`
  if (turn.state === 'open') return { full: [{ text: 'Turn running', tone: 'muted' }], short: { text: 'Running', tone: 'muted' }, title }
  const result = turnResult(turn)
  if (result.totals === null) {
    return { full: [{ text: wordingHead(result.wording ?? 'No totals'), tone: 'caveat' }], short: { text: 'No totals', tone: 'caveat' }, title }
  }
  const totals: TurnPlatePart[] = [
    { text: `${result.totals.files} ${result.totals.added}`, tone: 'text' }, { text: ` ${result.totals.removed}`, tone: 'muted' }
  ]
  if (result.mark === null) return { full: totals, short: { text: result.totals.files, tone: 'text' }, title }
  return {
    full: [...totals, { text: ` ${result.mark}`, tone: 'caveat' }],
    short: { text: result.mark === 'partial' ? 'Partial' : 'Not complete', tone: 'caveat' },
    title
  }
}

/** A turn in one sentence: its totals and, when they are not complete, the wording that says why. */
export function turnSentence(turn: TurnSummary): string {
  if (turn.state === 'open') return 'Running'
  const totals = turn.totals === null ? null : turnTotalsText(turn.totals)
  return [totals, turn.wording].filter((part) => part !== null && part !== '').join('. ') || 'No totals'
}

/** `14:05 · Codex 0.162.1 · Finished`: the heading of an opened turn. */
export function turnHeading(turn: TurnSummary, now: number): string {
  const app = turn.appVersion === null ? turnAppName(turn.app) : `${turnAppName(turn.app)} ${turn.appVersion}`
  return [turnWhen(turn.startedAt, now), app, turnEndWord(turn)].filter((part) => part !== '').join(' · ')
}

/** `18.2 KiB`: a size in the units the wordings use. */
export function turnSize(bytes: number): string {
  if (bytes < 1024) return `${count(bytes)} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** `18.2 KiB before, 21.7 KiB after`; a side on which the file was not there says so. */
export function turnBinarySizes(before: number | null, after: number | null): string {
  const side = (bytes: number | null): string => bytes === null ? 'not there' : turnSize(bytes)
  return `${side(before)} before, ${side(after)} after`
}

/** `@@ −12,7 +12,8 @@`: a hunk's place in both texts, counted on the original lines. */
export function turnHunkRange(hunk: Pick<TurnShownHunk, 'aStart' | 'aLines' | 'bStart' | 'bLines'>): string {
  return `@@ ${MINUS}${hunk.aStart},${hunk.aLines} +${hunk.bStart},${hunk.bLines} @@`
}

/** What stands under a difference that was not shown whole. */
export function turnMoreWords(more: number | null): string | null {
  if (more === 0) return null
  return more === null ? 'More lines not shown' : `${count(more)} more ${more === 1 ? 'line' : 'lines'} not shown`
}

/** Which of a turn's files are listed, when one page does not hold them all: "Files 2,001–4,000 of 4,321", "File 4,001 of 4,001". */
export function turnFilesShown(from: number, listed: number, total: number): string | null {
  if (listed === 0 || listed >= total) return null
  if (listed === 1) return `File ${count(from + 1)} of ${count(total)}`
  return `Files ${count(from + 1)}–${count(from + listed)} of ${count(total)}`
}

/** A line number as a difference shows it. */
export function turnLineNumber(value: number | null): string {
  return value === null ? '' : count(value)
}

const SCANS_LABEL = 'Two scans of '
const LABEL_MOMENT = /\b(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\b/g

/**
 * A turn's label as the dialog shows it. The one that names the two scans is kept with the work tree's full
 * path and its moments with their day; here the work tree reads as the sentence above it names it, and moments
 * that all fall on one day read as times, since the turn's heading gives the day.
 */
export function turnLabelShown(label: string, workTree: string | null, shownRoot: string | null): string {
  if (!label.startsWith(SCANS_LABEL)) return label
  const named = workTree !== null && shownRoot !== null && label.startsWith(`${SCANS_LABEL}${workTree},`)
    ? `${SCANS_LABEL}${shownRoot}${label.slice(SCANS_LABEL.length + workTree.length)}`
    : label
  const days = new Set([...named.matchAll(LABEL_MOMENT)].map((moment) => moment[1]))
  return days.size === 1 ? named.replace(LABEL_MOMENT, '$2') : named
}

/** How many lines a file gained and lost; nothing where there is nothing to count. */
export function turnFileLines(file: { added: number | null; removed: number | null }): { added: string; removed: string } | null {
  if (file.added === null && file.removed === null) return null
  return { added: file.added ? `+${count(file.added)}` : '', removed: file.removed ? `${MINUS}${count(file.removed)}` : '' }
}
