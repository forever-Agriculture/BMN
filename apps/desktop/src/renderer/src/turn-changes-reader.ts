// MODULE: turn-changes-reader.ts - what the "Turn changes…" dialog has read and what it still waits for: the list, the opened turn a page of files at a time, the files opened under their rows; an answer that comes late changes nothing
import type { TurnDetail, TurnDetailAnswer, TurnDifferenceAnswer, TurnShownDifference, TurnSummary } from '@bmn/protocol'

/** What stands under an opened file's row. */
export type TurnFileBody =
  | { state: 'reading' }
  | { state: 'shown'; difference: TurnShownDifference }
  | { state: 'unavailable'; words: string }

/** The place of the opened turn: still being read, read, or no longer kept. */
export type TurnOpened =
  | { state: 'reading'; turnId: string }
  | { state: 'read'; turnId: string; detail: TurnDetail }
  | { state: 'gone'; turnId: string }

/** The window's own reads, as the dialog asks them. */
export interface TurnReads {
  listTurns(sessionId: string): Promise<TurnSummary[]>
  readTurn(sessionId: string, turnId: string, from?: number): Promise<TurnDetailAnswer>
  readTurnDifference(sessionId: string, turnId: string, path: string): Promise<TurnDifferenceAnswer>
}

interface TurnReaderState {
  /** Null until the first read has answered. */
  turns: readonly TurnSummary[] | null
  opened: TurnOpened | null
  /** The opened files of the opened turn, by path. */
  bodies: ReadonlyMap<string, TurnFileBody>
}

interface TurnReaderOptions {
  /** Something of the state changed: the dialog draws again. */
  changed(): void
  failed(error: unknown, words: string): void
  /** Whether the latest turn opens with the dialog: only where the list stands beside it. */
  opensLatest(): boolean
}

/** What of a turn's row its detail depends on: when it changes, the detail is read again. */
const stamp = (turn: TurnSummary): string => JSON.stringify([turn.state, turn.end, turn.endedAt, turn.totalsState, turn.totals, turn.wording])

/**
 * The reads of one open dialog. Every read of a turn's detail has a number, and only the answer to the latest one
 * is taken: once a turn's place says "No longer kept", once another turn was opened or the detail was closed, an
 * answer that was still on its way changes nothing, whatever it says.
 */
export class TurnReader {
  state: TurnReaderState = { turns: null, opened: null, bodies: new Map() }
  /** The number of the latest read of a detail, and of the list. */
  private asked = 0
  private listed = 0
  /** What the opened turn's detail was read for. */
  private readFor: string | null = null
  private first = true
  /** Rises when the dialog closes: a difference asked for before then is answered to nobody. */
  private closed = 0

  constructor(private readonly reads: TurnReads, readonly sessionId: string, private readonly options: TurnReaderOptions) {}

  private set(change: Partial<TurnReaderState>): void {
    this.state = { ...this.state, ...change }
    this.options.changed()
  }

  /** The turn's place says "No longer kept", and no read asked until now may say otherwise. */
  private gone(turnId: string, more: Partial<TurnReaderState> = {}): void {
    this.asked += 1
    this.set({ ...more, opened: { state: 'gone', turnId }, bodies: new Map() })
  }

  /** Reads the list: when the dialog opens, and whenever turns change anywhere. */
  list(): void {
    this.listed += 1
    const request = this.listed
    void this.reads.listTurns(this.sessionId).then((turns) => {
      if (request !== this.listed) return
      const now = this.state.opened
      if (this.first) {
        this.first = false
        this.set({ turns })
        const latest = turns.find((turn) => turn.state !== 'open')
        if (latest && this.options.opensLatest()) this.read(latest.turnId, latest, false, 0)
        return
      }
      if (now === null || now.state === 'gone') {
        this.set({ turns })
        return
      }
      const row = turns.find((turn) => turn.turnId === now.turnId)
      if (!row) {
        // Removed while it was open: its row is gone and its place says so.
        this.gone(now.turnId, { turns })
        return
      }
      this.set({ turns })
      if (now.state === 'read' && this.readFor !== stamp(row)) this.read(row.turnId, row, true, now.detail.from)
    }).catch((error: unknown) => {
      if (request === this.listed) this.options.failed(error, 'The turns could not be read')
    })
  }

  /** `quiet`: what is shown stays until the answer is here (the same turn compared again, or another page of it). */
  private read(turnId: string, turn: TurnSummary | null, quiet: boolean, from: number): void {
    this.readFor = turn === null ? null : stamp(turn)
    this.asked += 1
    const request = this.asked
    if (!quiet) this.set({ opened: { state: 'reading', turnId }, bodies: new Map() })
    void this.reads.readTurn(this.sessionId, turnId, from).then((answer) => {
      if (request !== this.asked) return
      if (!answer.kept) {
        this.gone(turnId)
        return
      }
      // A turn that was compared again, and another page of it, list other files: what was open under the old ones goes.
      this.set({ opened: { state: 'read', turnId, detail: answer.detail }, ...(quiet ? { bodies: new Map() } : {}) })
    }).catch((error: unknown) => {
      if (request === this.asked && !quiet) this.set({ opened: null })
      this.options.failed(error, 'The turn could not be read')
    })
  }

  /** A row of the list is chosen. */
  open(turnId: string): void {
    const now = this.state.opened
    if (now?.turnId === turnId && now.state !== 'gone') return
    this.read(turnId, this.state.turns?.find((turn) => turn.turnId === turnId) ?? null, false, 0)
  }

  /** Another page of the opened turn's files: the one that `from` files stand before. */
  page(from: number): void {
    const now = this.state.opened
    if (now?.state !== 'read' || now.detail.from === from) return
    this.read(now.turnId, this.state.turns?.find((turn) => turn.turnId === now.turnId) ?? null, true, from)
  }

  /** Back to the list: nothing is opened, and no answer still on its way opens anything. */
  back(): void {
    this.asked += 1
    this.set({ opened: null, bodies: new Map() })
  }

  /** The dialog closed: no answer changes anything any more. */
  leave(): void {
    this.asked += 1
    this.listed += 1
    this.closed += 1
  }

  /** A file's row is chosen: its difference opens under it, or closes. */
  toggle(path: string): void {
    const turn = this.state.opened
    if (turn?.state !== 'read') return
    const without = (): ReadonlyMap<string, TurnFileBody> => new Map([...this.state.bodies].filter(([key]) => key !== path))
    if (this.state.bodies.has(path)) {
      this.set({ bodies: without() })
      return
    }
    const turnId = turn.turnId
    const page = turn.detail
    /** Whether the page this file was opened on is still the one shown. */
    const shown = (): boolean => this.state.opened?.state === 'read' && this.state.opened.detail === page
    const put = (body: TurnFileBody): void => {
      // An answer for a file the owner closed again, of another turn or of another page, is dropped.
      if (!shown() || (body.state !== 'reading' && !this.state.bodies.has(path))) return
      this.set({ bodies: new Map(this.state.bodies).set(path, body) })
    }
    put({ state: 'reading' })
    const closed = this.closed
    void this.reads.readTurnDifference(this.sessionId, turnId, path).then((answer) => {
      if (closed !== this.closed) return
      if (!answer.kept) {
        const now = this.state.opened
        if (now?.turnId === turnId && now.state !== 'gone') this.gone(turnId)
      } else if ('difference' in answer) put({ state: 'shown', difference: answer.difference })
      else put({ state: 'unavailable', words: answer.unavailable })
    }).catch((error: unknown) => {
      if (closed !== this.closed) return
      if (shown() && this.state.bodies.has(path)) this.set({ bodies: without() })
      this.options.failed(error, 'The difference could not be read')
    })
  }
}
