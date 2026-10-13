// MODULE: turn-changes-view.ts - a stored turn and a comparison's rows as the window lists them (Story 69.5): fixed words, a file's path and line counts, never a file's content
import type { TurnFileView, TurnSummary } from '@bmn/protocol'
import type { TurnRow } from './database-turn-store'
import type { TurnFileRow } from './turn-changes-compare'

export function turnSummary(row: TurnRow): TurnSummary {
  return {
    turnId: row.turnId, number: row.number, app: row.app, appVersion: row.appVersion, startedAt: row.startedAt, endedAt: row.endedAt,
    end: row.endKind, state: row.state, totalsState: row.totalsState,
    totals: row.totals === null ? null : { files: row.totals.files, added: row.totals.added, removed: row.totals.removed },
    wording: row.wording
  }
}

const SHORT_COMMIT = 12

/** What a row's state alone does not say, in fixed words. */
function note(row: TurnFileRow): string | null {
  if (row.state === 'not read') return row.why ?? null
  if (row.state === 'changed kind') return `${row.from ?? 'nothing'} to ${row.to ?? 'nothing'}`
  if (row.state === 'mode only') return row.executable === true ? 'now executable' : 'no longer executable'
  // A submodule or nested repository is one entry: only its recorded commit is compared.
  if (row.state === 'changed' && row.added === undefined && typeof row.from === 'string' && typeof row.to === 'string') {
    return `commit ${row.from.slice(0, SHORT_COMMIT)} to ${row.to.slice(0, SHORT_COMMIT)}`
  }
  if (row.kind === 'submodule') return 'submodule'
  if (row.kind === 'link') return 'link'
  return null
}

export function turnFileView(row: TurnFileRow): TurnFileView {
  return {
    path: row.path, state: row.state, added: row.added ?? null, removed: row.removed ?? null, note: note(row),
    // Lines were counted, or it is a binary file with its sizes: there is a difference to open.
    opens: row.added !== undefined || row.sizeBefore !== undefined || row.sizeAfter !== undefined
  }
}

const LIMIT_REACHED = 'Difference unavailable: limit reached'

/** Why a turn's files or one file's difference cannot be shown now: one of four fixed sentences. */
export function turnUnavailable(reason: string): string {
  if (reason === LIMIT_REACHED) return LIMIT_REACHED
  if (reason === 'not read') return 'This file was not read'
  // A read gives way to a prompt's scan each time one comes; after three it stops asking.
  if (reason === 'cancelled') return 'BMN was scanning for a prompt; open it again'
  return 'The stored scans of this turn cannot be read'
}
