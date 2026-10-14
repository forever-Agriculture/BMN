// MODULE: turn-changes-recorder.ts - brackets a turn: a scan when a prompt starts, a scan when the turn ends, one record per turn with its end, totals, wording and labels (Epic 69, Story 69.4)
//
// A turn belongs to one foreground agent (the host's own reading of the terminal), one conversation and one
// root. Everything of one session happens in the order it arrived; a scan or a comparison is waited for
// outside that order, so a slow one never holds the next prompt. Nothing here holds a file's name: a status
// is one word, a wording takes a bound, a fixed reason, an app, a version or a count.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TURN_APP_NAMES, TURN_LABELS, TURN_MARK_LIMIT_MS, TURN_PAUSE_AFTER, TURN_RECORDED_APPS, TURN_WORDINGS,
  type TurnEndKind, type TurnMarkStatus, type TurnPauseReason, type TurnRecordingState
} from '@bmn/protocol'
import type { TurnCaptureRow, TurnRow, TurnTotalsState } from './database-turn-store'
import { refusal, type TurnRefusal, type TurnRootIdentity } from './turn-changes-capture'
import type { TurnComparison } from './turn-changes-compare'
import type { TurnCaptureAnswer, TurnChangesPort, TurnStoreKeeper } from './turn-changes-engine'
import { captureSessionWorkTree, type SessionForeground } from './turn-changes-service'
import { workTreeKey, type TurnCaptureRecord } from './turn-changes-store'

/** One `turn.mark` of a session's own hook, already checked by the control socket. */
export interface TurnMarkCall {
  sessionId: string
  incarnationId: string
  requestId: string
  edge: 'start' | 'confirm' | 'end'
  app: string
  conversation: string
  /** The turn's id where the app gives one. */
  turn: string | null
  /** The folder the event names. It says where to look and is never permission to read. */
  folder: string | null
  /** Until when the hook waits, in milliseconds since 1970. */
  until: number | null
  kind: TurnEndKind | null
  /** The app goes on by itself from a stop that listed work in flight: no new turn. */
  continued: boolean
}

/** What an ordinary hook event says of a turn. */
export interface TurnObservation {
  sessionId: string
  app: string
  event: string
  source: string | null
  conversation: string
  turn: string | null
  /** A sub-agent speaks. */
  nested: boolean
}

export interface TurnRecorderDatabase {
  putTurn: (input: { turn: TurnRow; captures?: TurnCaptureRow[] }) => Promise<unknown>
  nextTurnNumber: (sessionId: string) => Promise<number>
  listUnclosedTurns: () => Promise<TurnRow[]>
}

export interface TurnRecorderOptions {
  port: TurnChangesPort
  /** Removes a scan that was dropped before any row named it. */
  keeper?: Pick<TurnStoreKeeper, 'removeCaptures'>
  foreground: SessionForeground
  database: TurnRecorderDatabase
  /** The version of the app a foreground process runs; null when it cannot be read. The recorder asks once per process, and never while a prompt is on its way through BMN. */
  version: (identity: string, app: string) => string | null | Promise<string | null>
  /** Runs work later, off the call that asked for it. A test puts its own in place. */
  defer?: (work: () => void) => void
  /** Whether another BMN session was started in this work tree. */
  shared: (sessionId: string, root: string) => boolean
  /** The folder in which a file named after a session says "recording is on" to that session's hook. */
  hintFolder: string
  /** Something the window shows of a session changed. */
  changed: (sessionId: string | null) => void
  now?: () => number
  markLimitMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

interface LiveTurn {
  row: TurnRow
  root: TurnRootIdentity | null
  before: TurnCaptureRecord | null
  after: TurnCaptureRecord | null
  /** Why a scan was refused, when it is "not supported here". */
  unsupported: string | null
  overlapped: boolean
  switchedOff: boolean
  /** The end was not observed: the second scan is a later one. */
  through: boolean
  shared: boolean
  /** The second scan while it runs. */
  scan: { job: string; stop: AbortController } | null
  /** Captures whose rows are written. */
  recorded: Set<string>
  compared: { a: string; b: string; result: TurnComparison | TurnRefusal } | null
  /** Raised whenever the turn's facts change: an answer worked out for older facts is dropped. */
  token: number
  /** Prompts typed into this turn: each has a record of its own and ends with it. */
  joined: TurnRow[]
}

interface Pending {
  requestId: string
  turn: LiveTurn
  record: TurnCaptureRecord
  /** Turns that ended without an event: they are compared through this "before". */
  waiting: LiveTurn[]
  deadline: number
  timer: unknown
}

interface SessionTurns {
  sessionId: string
  queue: Promise<unknown>
  number: number | null
  live: LiveTurn[]
  pending: Pending | null
  /** A confirmed "before" that is being published now: its call's time and its connection still hold it. */
  confirming: { requestId: string; capture: string } | null
  /** Marks already answered, by edge and request id. */
  requests: Map<string, TurnMarkStatus>
  failures: Map<string, { failed: number; incomplete: number }>
  paused: Map<string, TurnPauseReason>
  app: string | null
  /** The foreground process that app was seen as; another one in its place is no longer that app. */
  appIdentity: string | null
}

const TOOL_EVENTS: readonly string[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']
const REQUESTS_KEPT = 128
const VERSIONS_KEPT = 32
const refused = (answer: TurnCaptureAnswer): answer is TurnRefusal => !('record' in answer)
const sameTurn = (a: string | null, b: string | null): boolean => a === null || b === null || a === b
const two = (value: number): string => String(value).padStart(2, '0')
const shortCommit = (commit: string | null): string => (commit === null ? 'no commit' : commit.slice(0, 12))

/** A moment as a label says it: this computer's own date and time. */
/**
 * An incomplete capture that read new bytes and kept what it read: the next scan of that root starts further on.
 * One whose time passed keeps the files it read without a list of them, so it is told by the bytes it put
 * in the store; one that kept nothing put none there.
 */
const readOn = (record: TurnCaptureRecord): boolean =>
  record.state === 'incomplete' && record.bytesRead > 0 && (record.tree !== null || record.bytesStored > 0)

export function turnLabelTime(ms: number): string {
  const at = new Date(ms)
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}

export class TurnRecorder {
  private readonly options: TurnRecorderOptions
  private readonly on = new Set<string>()
  private readonly sessions = new Map<string, SessionTurns>()
  private readonly versions = new Map<string, Promise<string | null>>()
  /** Start marks and confirmations that are being answered right now. */
  private answering = 0
  /** Version reads that wait until no prompt is on its way through BMN. */
  private readonly waiting: Array<() => void> = []
  private readonly defer: (work: () => void) => void
  private readonly work = new Set<Promise<unknown>>()
  private readonly now: () => number
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  /** Events that named no open or provisional turn of their agent and conversation. They change nothing. */
  staleEvents = 0

  constructor(options: TurnRecorderOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((run, ms) => {
      const timer = setTimeout(run, ms)
      timer.unref()
      return timer
    })
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
    this.defer = options.defer ?? ((work) => void setImmediate(work))
  }

  // ---- what the host tells it ---------------------------------------------------------------------

  /** At a start: a turn stored as open has nobody left to end it. */
  async start(): Promise<void> {
    const rows = await this.options.database.listUnclosedTurns().catch(() => [])
    for (const row of rows) {
      const unsettled = row.state === 'open' || (row.totalsState === 'none' && row.wording === null)
      await this.options.database.putTurn({
        turn: {
          ...row, state: 'closed',
          ...(row.state === 'open' ? { endKind: 'not-observed' } : {}),
          ...(unsettled ? { totalsState: 'none' as const, totals: null, wording: TURN_WORDINGS.finalScanUnavailable() } : {})
        }
      }).catch(() => undefined)
    }
  }

  /**
   * The sessions whose workspace has the switch on, as they are now. A session that left the set (the switch
   * was turned off, or the session moved to a workspace without it) has its running scan cancelled and its
   * open turn closed as "Recording was switched off".
   */
  setSwitches(sessions: ReadonlySet<string>): void {
    const before = [...this.on]
    const same = before.length === sessions.size && before.every((sessionId) => sessions.has(sessionId))
    this.on.clear()
    for (const sessionId of sessions) this.on.add(sessionId)
    this.writeHints()
    for (const sessionId of before) {
      const state = this.sessions.get(sessionId)
      if (state && !this.on.has(sessionId)) this.track(this.enqueue(state, () => this.switchedOff(state)))
    }
    if (!same) this.options.changed(null)
  }

  /** The session's process ended: an open turn has no end to wait for. */
  sessionEnded(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    this.track(this.enqueue(state, async () => {
      await this.dropPending(state)
      for (const turn of [...state.live]) {
        if (turn.row.state === 'provisional') this.close(state, turn)
        else this.closeNotObserved(state, turn, null)
      }
    }))
  }

  /** The session was deleted: its rows went with it. */
  forget(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    if (state.pending) this.clearTimer(state.pending.timer)
    for (const turn of state.live) turn.scan?.stop.abort()
    this.sessions.delete(sessionId)
  }

  /** Resume in the workspace's menu: the count of failed scans goes back to zero. */
  resume(sessionId: string): boolean {
    const state = this.sessions.get(sessionId)
    if (!state || (state.paused.size === 0 && state.failures.size === 0)) return false
    state.paused.clear()
    state.failures.clear()
    this.options.changed(sessionId)
    return true
  }

  /** Where recording stands, for the window only. */
  states(): TurnRecordingState[] {
    const states: TurnRecordingState[] = []
    for (const sessionId of new Set([...this.on, ...this.sessions.keys()])) {
      const state = this.sessions.get(sessionId)
      const paused = state ? [...state.paused][0] : undefined
      if (!this.on.has(sessionId)) continue
      states.push({
        sessionId, state: state ? this.standing(state) : 'recording', app: state ? this.appNow(state) : null,
        pausedRoot: paused?.[0] ?? null, pauseReason: paused?.[1] ?? null
      })
    }
    return states
  }

  /** The app seen in the session's terminal, while the process it was seen as still holds the foreground. */
  private appNow(state: SessionTurns): string | null {
    if (state.app === null || state.appIdentity === null) return null
    return this.options.foreground.identity(state.sessionId) === state.appIdentity ? state.app : null
  }

  private standing(state: SessionTurns): TurnRecordingState['state'] {
    if (state.paused.size > 0) return 'paused'
    const app = this.appNow(state)
    return app !== null && TURN_RECORDED_APPS[app] === undefined ? 'not-supported' : 'recording'
  }

  /** Resolves when nothing of any session is waited for. For tests and for the host's end. */
  async idle(): Promise<void> {
    for (;;) {
      const queues = [...this.sessions.values()].map((state) => state.queue)
      await Promise.allSettled([...this.work, ...queues])
      if (this.work.size === 0 && [...this.sessions.values()].every((state, index) => state.queue === queues[index])) return
    }
  }

  // ---- marks ----------------------------------------------------------------------------------------

  /** One mark of a session's own hook. The answer is one word. */
  mark(call: TurnMarkCall): Promise<TurnMarkStatus> {
    const state = this.session(call.sessionId)
    const key = `${call.edge}:${call.requestId}`
    if (call.edge === 'end') {
      // Answered at once: the hook does not wait for the scan.
      if (state.requests.has(key)) return Promise.resolve('repeated')
      if (!this.on.has(call.sessionId)) return Promise.resolve('off')
      if (TURN_RECORDED_APPS[call.app] === undefined) return Promise.resolve('not-supported')
      this.remember(state, key, 'queued')
      this.track(this.enqueue(state, () => this.end(state, call)))
      return Promise.resolve('queued')
    }
    this.answering += 1
    return this.enqueue(state, async () => {
      if (state.requests.has(key)) return 'repeated'
      const status = call.edge === 'start' ? await this.begin(state, call) : await this.confirm(state, call)
      this.remember(state, key, status)
      return status
    }).finally(() => {
      this.answering -= 1
      this.wake()
    })
  }

  /** The connection a start mark came on closed: a "before" nobody confirmed goes at once. */
  dropped(sessionId: string, requestId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    // A "before" that is being published is stopped here and now: its confirmation is answered in this session's line, behind which this would wait.
    if (state.confirming?.requestId === requestId) void this.options.port.discard(state.confirming.capture).catch(() => undefined)
    this.track(this.enqueue(state, async () => {
      if (state.pending?.requestId === requestId) await this.dropPending(state)
    }))
  }

  /**
   * Any hook event of any app in a recording session says which app runs there now, so that the window can say
   * "Not supported for <app>" beside the earlier numbers of an app BMN does not record.
   */
  seen(sessionId: string, app: string): void {
    if (!this.on.has(sessionId)) return
    const state = this.session(sessionId)
    const identity = this.options.foreground.identity(sessionId)
    // Without a process to tie it to, a name says nothing about what runs there a moment later.
    if (identity === null || (state.app === app && state.appIdentity === identity)) return
    const before = this.standing(state)
    state.app = app
    state.appIdentity = identity
    if (this.standing(state) !== before) this.options.changed(sessionId)
  }

  /** An ordinary hook event of a recorded app: a tool ran, a conversation started or ended. */
  observe(observation: TurnObservation): void {
    if (!this.on.has(observation.sessionId) || TURN_RECORDED_APPS[observation.app] === undefined) return
    const state = this.session(observation.sessionId)
    const identity = this.options.foreground.identity(observation.sessionId)
    state.app = observation.app
    state.appIdentity = identity
    if (identity !== null) void this.version(identity, observation.app)
    if (state.live.length === 0 && state.pending === null) return
    this.track(this.enqueue(state, () => this.observed(state, observation)))
  }

  private async begin(state: SessionTurns, call: TurnMarkCall): Promise<TurnMarkStatus> {
    if (!this.on.has(call.sessionId)) return 'off'
    const measured = TURN_RECORDED_APPS[call.app]
    if (measured === undefined) return 'not-supported'
    const identity = this.options.foreground.identity(call.sessionId)
    if (identity === null) return 'unavailable'
    state.app = call.app
    state.appIdentity = identity
    // An earlier "before" that nobody confirmed, and turns of another agent or conversation.
    await this.dropPending(state)
    this.leave(state, identity, call.conversation)
    if (call.continued) {
      const going = this.match(state, call.conversation, null)
      if (going) {
        if (going.row.state === 'provisional') this.reopen(going)
        going.row.appTurnId = call.turn ?? going.row.appTurnId
        await this.store(going)
        this.settle(state, going)
        return 'continued'
      }
    }
    const waiting: LiveTurn[] = []
    for (const turn of [...state.live]) {
      if (turn.row.state === 'provisional') {
        // The next prompt of that agent and conversation starts to run: the ended turn is final.
        this.close(state, turn)
      } else if (measured.promptArrives === 'typed' && sameTurn(call.turn, turn.row.appTurnId)) {
        // Typed into a running turn: BMN cannot say where one ends and the next begins.
        turn.overlapped = true
        turn.token += 1
        const joined = await this.record(state, call, identity)
        joined.wording = TURN_WORDINGS.overlapped()
        turn.joined.push(joined)
        await this.store(turn)
        this.settle(state, turn)
        return 'overlapped'
      } else {
        // The earlier turn ended without an event; it is compared through this prompt's "before".
        state.live.splice(state.live.indexOf(turn), 1)
        waiting.push(turn)
      }
    }
    const folder = this.options.foreground.folder(identity)
    if (folder !== null && this.pausedAt(state, folder)) {
      // Paused: nothing is scanned and nothing is recorded until Resume.
      for (const earlier of waiting) this.closeNotObserved(state, earlier, null)
      return 'paused'
    }
    const turn = this.fresh(await this.record(state, call, identity))
    const left = Math.min(this.options.markLimitMs ?? TURN_MARK_LIMIT_MS, (call.until ?? 0) - this.now())
    if (left <= 0) {
      await this.open(state, turn, waiting, null)
      return 'late'
    }
    const deadline = this.now() + left
    const stop = new AbortController()
    // A turn that ended unseen is compared through this scan, so the scan looks at what became of that turn's paths.
    const base = waiting.map((earlier) => earlier.before?.id).find((id) => id !== undefined) ?? null
    const asked: Promise<TurnCaptureAnswer & { foreground?: string }> = captureSessionWorkTree(this.options.port, this.options.foreground,
      { job: randomUUID(), session: call.sessionId, named: call.folder, base, publish: false }, stop.signal)
      .catch(() => refusal('unavailable', 'not read'))
    // The time of the call passes: the capture is cancelled, and whatever it still staged goes at once.
    let timer: unknown
    const passed = new Promise<null>((resolve) => {
      timer = this.setTimer(() => {
        stop.abort()
        resolve(null)
      }, left)
    })
    const first = await Promise.race([asked, passed])
    this.clearTimer(timer)
    const late = first === null
    let answer = first ?? refusal('cancelled', 'cancelled')
    // The terminal's foreground as it is now, after the scan: a capture during which another process took the
    // agent's place is the old agent's, and is never published.
    const current = this.options.foreground.identity(call.sessionId)
    const replaced = current !== identity
    if (late) {
      void asked.then((done) => (refused(done) ? undefined : this.options.port.discard(done.record.id).catch(() => undefined)))
    } else if (!refused(answer) && (replaced || answer.foreground !== identity)) {
      await this.options.port.discard(answer.record.id).catch(() => undefined)
      answer = refusal('unavailable', 'the terminal has no foreground process')
    }
    if (refused(answer)) {
      // An agent that left is no scan that failed.
      if (!replaced) this.count(state, folder ?? identity, 'failed')
      if (answer.state === 'not-supported') turn.unsupported = answer.reason
      await this.open(state, turn, waiting, null)
      if (replaced) this.leave(state, current, null)
      return late ? 'late' : answer.state === 'not-supported' ? 'not-supported' : answer.state === 'busy' ? 'busy' : 'unavailable'
    }
    // Tentative until the hook says, before it lets the app go on, that this answer arrived.
    state.pending = {
      requestId: call.requestId, turn, record: answer.record, waiting, deadline,
      timer: this.setTimer(() => this.track(this.enqueue(state, async () => {
        if (state.pending?.turn === turn) await this.dropPending(state)
      })), Math.max(0, deadline - this.now()))
    }
    return answer.state === 'whole' ? 'captured' : 'incomplete'
  }

  private async confirm(state: SessionTurns, call: TurnMarkCall): Promise<TurnMarkStatus> {
    const pending = state.pending
    if (!pending || pending.requestId !== call.requestId) return 'late'
    if (this.now() > pending.deadline) {
      await this.dropPending(state)
      return 'late'
    }
    // Read here and now, not at the last event: another process in the agent's place means the "before" is the
    // old agent's. It goes, and that agent's turns have no end to wait for.
    const identity = this.options.foreground.identity(call.sessionId)
    if (identity !== pending.turn.row.foreground) {
      await this.dropPending(state)
      this.leave(state, identity, null)
      return 'late'
    }
    state.pending = null
    this.clearTimer(pending.timer)
    // The call's time and its connection hold the "before" until it is published (69.4 criterion 3): past the
    // one, or without the other, the publication is stopped, and a stopped publication keeps nothing.
    const capture = pending.record.id
    state.confirming = { requestId: call.requestId, capture }
    const timer = this.setTimer(() => void this.options.port.discard(capture).catch(() => undefined), Math.max(0, pending.deadline - this.now()))
    const record = await this.options.port.publish(capture).catch(() => null)
    this.clearTimer(timer)
    state.confirming = null
    if (record === null) {
      await this.open(state, pending.turn, pending.waiting, null)
      return 'late'
    }
    this.count(state, record.root, record.state, readOn(record))
    await this.open(state, pending.turn, pending.waiting, record)
    return 'confirmed'
  }

  private async end(state: SessionTurns, call: TurnMarkCall): Promise<void> {
    if (!this.on.has(call.sessionId)) return
    const identity = this.options.foreground.identity(call.sessionId)
    const pending = state.pending
    // An end of the very prompt whose "before" still waits: the app went on without the confirmation.
    if (pending && (pending.turn.row.foreground !== identity ||
      (pending.turn.row.conversation === call.conversation && sameTurn(pending.turn.row.appTurnId, call.turn)))) await this.dropPending(state)
    this.leave(state, identity, null)
    const turn = this.match(state, call.conversation, call.turn)
    if (!turn) {
      this.staleEvents += 1
      return
    }
    // A stop the app continues from by itself leaves the turn open.
    if (call.kind === null || call.kind === 'continues') return
    // A later end takes the place of an earlier one.
    this.dropScan(turn)
    turn.row.state = 'provisional'
    turn.row.endKind = call.kind
    turn.row.endedAt = this.iso()
    await this.store(turn)
    if (turn.overlapped) this.settle(state, turn)
    else this.scan(state, turn)
  }

  private async observed(state: SessionTurns, observation: TurnObservation): Promise<void> {
    const identity = this.options.foreground.identity(observation.sessionId)
    if (state.pending && state.pending.turn.row.foreground !== identity) await this.dropPending(state)
    this.leave(state, identity, null)
    if (TOOL_EVENTS.includes(observation.event)) {
      const pending = state.pending
      if (pending && pending.turn.row.conversation === observation.conversation &&
        (observation.nested || sameTurn(pending.turn.row.appTurnId, observation.turn))) {
        // The app did not wait for the hook: the "before" is no boundary.
        await this.dropPending(state)
        return
      }
      const turn = this.match(state, observation.conversation, observation.nested ? null : observation.turn)
      if (!turn) this.staleEvents += 1
      else if (turn.row.state === 'provisional') {
        this.reopen(turn)
        await this.store(turn)
        this.settle(state, turn)
      }
      return
    }
    if (observation.event === 'SessionStart' && observation.source !== 'compact') {
      // `/clear`, `/resume` or a new start: another conversation.
      if (state.pending && state.pending.turn.row.conversation !== observation.conversation) await this.dropPending(state)
      this.leave(state, identity, observation.conversation)
      return
    }
    if (observation.event === 'SessionEnd') {
      if (state.pending?.turn.row.conversation === observation.conversation) await this.dropPending(state)
      for (const turn of [...state.live]) {
        if (turn.row.conversation !== observation.conversation) continue
        if (turn.row.state === 'provisional') this.close(state, turn)
        else this.closeNotObserved(state, turn, null)
      }
    }
    // A compaction, and every other event, changes nothing.
  }

  // ---- a turn's moves -------------------------------------------------------------------------------

  private async record(state: SessionTurns, call: TurnMarkCall, identity: string): Promise<TurnRow> {
    state.number ??= await this.options.database.nextTurnNumber(call.sessionId).catch(() => 1)
    const number = state.number
    state.number += 1
    return {
      turnId: randomUUID(), number, sessionId: call.sessionId, incarnationId: call.incarnationId, foreground: identity, app: call.app,
      appVersion: null, conversation: call.conversation, appTurnId: call.turn, namedFolder: call.folder, workTree: null, state: 'open',
      endKind: null, startedAt: this.iso(), endedAt: null, totalsState: 'none', totals: null, wording: null, labels: [], before: null, after: null
    }
  }

  private fresh(row: TurnRow): LiveTurn {
    return {
      row, root: null, before: null, after: null, unsupported: null, overlapped: false, switchedOff: false, through: false, shared: false,
      scan: null, recorded: new Set(), compared: null, token: 0, joined: []
    }
  }

  /** The turn starts to run, with its "before" or without one. Turns that waited for this scan are closed through it. */
  private async open(state: SessionTurns, turn: LiveTurn, waiting: LiveTurn[], before: TurnCaptureRecord | null): Promise<void> {
    turn.before = before
    if (before) {
      turn.root = { root: before.root, device: before.rootDevice, inode: before.rootInode }
      turn.shared = this.options.shared(turn.row.sessionId, before.root)
    }
    state.live.push(turn)
    this.describe(turn, null, undefined)
    await this.store(turn)
    this.settle(state, turn)
    for (const earlier of waiting) this.closeNotObserved(state, earlier, before)
  }

  private async dropPending(state: SessionTurns): Promise<void> {
    const pending = state.pending
    if (!pending) return
    state.pending = null
    this.clearTimer(pending.timer)
    await this.options.port.discard(pending.record.id).catch(() => undefined)
    await this.open(state, pending.turn, pending.waiting, null)
  }

  /** Turns of another foreground agent, or of another conversation, have no end to wait for. */
  private leave(state: SessionTurns, identity: string | null, conversation: string | null): void {
    for (const turn of [...state.live]) {
      if (turn.row.foreground === identity && (conversation === null || turn.row.conversation === conversation)) continue
      if (turn.row.state === 'provisional') this.close(state, turn)
      else this.closeNotObserved(state, turn, null)
    }
  }

  /** The newest open or provisional turn of a conversation, and of a turn id where both sides give one. */
  private match(state: SessionTurns, conversation: string, turnId: string | null): LiveTurn | null {
    for (let index = state.live.length - 1; index >= 0; index -= 1) {
      const turn = state.live[index] as LiveTurn
      if (turn.row.conversation === conversation && sameTurn(turn.row.appTurnId, turnId)) return turn
    }
    return null
  }

  /** A tool event after the end: the same turn runs again, and its "after" is dropped. */
  private reopen(turn: LiveTurn): void {
    this.dropScan(turn)
    turn.row.state = 'open'
    turn.row.endKind = null
    turn.row.endedAt = null
  }

  /** An ended turn becomes final: its end, its scans and its totals stay as they are or as they arrive. */
  private close(state: SessionTurns, turn: LiveTurn): void {
    const index = state.live.indexOf(turn)
    if (index >= 0) state.live.splice(index, 1)
    turn.row.state = 'closed'
    if (turn.scan) return
    this.track(this.store(turn))
    this.settle(state, turn)
  }

  /**
   * A turn whose end no event told. It is compared through a later scan: the next prompt's "before" for the
   * same root, or one last scan of that root, taken only while the folder is still the one BMN established.
   */
  private closeNotObserved(state: SessionTurns, turn: LiveTurn, through: TurnCaptureRecord | null): void {
    const index = state.live.indexOf(turn)
    if (index >= 0) state.live.splice(index, 1)
    this.dropScan(turn)
    turn.row.state = 'closed'
    turn.row.endKind = 'not-observed'
    turn.row.endedAt = this.iso()
    turn.through = true
    const root = turn.root
    if (root && turn.before && !turn.overlapped && through && through.root === root.root &&
      through.rootDevice === root.device && through.rootInode === root.inode) {
      turn.after = through
    } else if (root && turn.before && !turn.overlapped) {
      this.scan(state, turn)
      return
    }
    this.track(this.store(turn))
    this.settle(state, turn)
  }

  private async switchedOff(state: SessionTurns): Promise<void> {
    await this.dropPending(state)
    for (const turn of [...state.live]) {
      state.live.splice(state.live.indexOf(turn), 1)
      if (turn.row.state === 'provisional' && turn.scan === null) {
        // Its end and its second scan were observed while recording was on.
        turn.row.state = 'closed'
      } else {
        this.dropScan(turn)
        turn.switchedOff = true
        turn.row.state = 'closed'
        turn.row.endKind = 'switched-off'
        turn.row.endedAt = this.iso()
      }
      await this.store(turn)
      this.settle(state, turn)
    }
  }

  // ---- the second scan ------------------------------------------------------------------------------

  /** Takes the turn's second scan away from this session's order of events; its result comes back into that order. */
  private scan(state: SessionTurns, turn: LiveTurn): void {
    const sessionId = turn.row.sessionId
    const root = turn.root
    if (!this.on.has(sessionId) || (root !== null && state.paused.has(root.root))) {
      this.track(this.store(turn))
      this.settle(state, turn)
      return
    }
    const job = randomUUID()
    const stop = new AbortController()
    turn.scan = { job, stop }
    turn.token += 1
    const request = { job, session: sessionId, base: turn.before?.id ?? null, publish: true }
    let asked: Promise<TurnCaptureAnswer>
    if (root) asked = this.options.port.capture({ ...request, folder: root.root, expect: root }, stop.signal)
    else if (this.options.foreground.identity(sessionId) === turn.row.foreground) {
      asked = captureSessionWorkTree(this.options.port, this.options.foreground, { ...request, named: turn.row.namedFolder }, stop.signal)
    } else asked = Promise.resolve(refusal('unavailable', 'the terminal has no foreground process'))
    this.track(asked.catch((): TurnCaptureAnswer => refusal('unavailable', 'not read'))
      .then((answer) => this.enqueue(state, () => this.scanned(state, turn, job, answer))))
  }

  private async scanned(state: SessionTurns, turn: LiveTurn, job: string, answer: TurnCaptureAnswer): Promise<void> {
    if (turn.scan?.job !== job) {
      // Dropped meanwhile: the turn ran on, ended again or was switched off. The scan is nobody's.
      if (!refused(answer)) this.remove(turn.row.sessionId, answer.record)
      return
    }
    turn.scan = null
    if (refused(answer)) {
      if (answer.state !== 'cancelled') this.count(state, turn.root?.root ?? this.folderOf(turn) ?? turn.row.foreground, 'failed')
      if (answer.state === 'not-supported') turn.unsupported = answer.reason
    } else {
      this.count(state, answer.record.root, answer.record.state, readOn(answer.record))
      turn.after = answer.record
      if (!turn.root) {
        turn.root = { root: answer.record.root, device: answer.record.rootDevice, inode: answer.record.rootInode }
        turn.shared = this.options.shared(turn.row.sessionId, answer.record.root)
      }
    }
    await this.store(turn)
    this.settle(state, turn)
  }

  /** Lets go of the turn's second scan: one that runs is cancelled, one that is done is no longer the turn's. */
  private dropScan(turn: LiveTurn): void {
    turn.scan?.stop.abort()
    turn.scan = null
    const after = turn.after
    turn.after = null
    turn.compared = null
    turn.token += 1
    turn.row.totalsState = 'none'
    turn.row.totals = null
    // A recorded scan goes with the sweep, which removes every capture no kept turn refers to.
    if (after && !turn.recorded.has(after.id)) this.remove(turn.row.sessionId, after)
  }

  private remove(sessionId: string, record: TurnCaptureRecord): void {
    const removal = this.options.keeper?.removeCaptures({ session: sessionId, key: workTreeKey(record.root), captures: [record.id] })
    if (removal) this.track(removal.catch(() => undefined))
  }

  private folderOf(turn: LiveTurn): string | null {
    return this.options.foreground.folder(turn.row.foreground)
  }

  // ---- totals, wording, labels ----------------------------------------------------------------------

  /** Works out what the turn says from its two scans, away from this session's order of events. */
  private settle(state: SessionTurns, turn: LiveTurn): void {
    turn.token += 1
    const token = turn.token
    const { before, after, root } = turn
    const pair = !turn.switchedOff && !turn.overlapped && root && before?.state === 'whole' && after?.state === 'whole'
      ? { a: before.id, b: after.id } : null
    const known = turn.compared
    const comparison: Promise<TurnComparison | TurnRefusal | null> = pair === null || root === null ? Promise.resolve(null)
      : known?.a === pair.a && known.b === pair.b ? Promise.resolve(known.result)
        : this.options.port.compare({ session: turn.row.sessionId, root: root.root, ...pair })
          .catch((): TurnRefusal => refusal('unavailable', 'a stored capture cannot be read'))
    this.track(Promise.all([comparison, this.version(turn.row.foreground, turn.row.app)]).then(([compared, version]) => this.enqueue(state, async () => {
      if (token !== turn.token) return
      if (pair && compared) turn.compared = { ...pair, result: compared }
      this.describe(turn, compared, version)
      await this.store(turn)
    })))
  }

  /**
   * Totals, the one wording and the labels, from what the turn holds now. `version` undefined means "not asked
   * yet": nothing is said of the version until it was read or could not be.
   */
  private describe(turn: LiveTurn, compared: TurnComparison | TurnRefusal | null, version: string | null | undefined): void {
    const row = turn.row
    const measured = TURN_RECORDED_APPS[row.app]
    const app = TURN_APP_NAMES[row.app] ?? row.app
    if (version !== undefined) row.appVersion = version
    const shown = version ?? '(version not read)'
    const unverified = version !== undefined && (measured === undefined || version !== measured.version)
    const ended = row.state !== 'open'
    let wording: string | null = null
    let totals: TurnRow['totals'] = null
    let totalsState: TurnTotalsState = 'none'
    if (turn.switchedOff) wording = TURN_WORDINGS.switchedOff()
    else if (turn.overlapped) wording = TURN_WORDINGS.overlapped()
    else if (turn.before === null) wording = turn.unsupported === null ? TURN_WORDINGS.beforeUnavailable() : TURN_WORDINGS.notSupported(turn.unsupported)
    else if (ended && turn.scan === null && turn.after === null) {
      wording = turn.unsupported === null ? TURN_WORDINGS.finalScanUnavailable() : TURN_WORDINGS.notSupported(turn.unsupported)
    } else if (turn.before.state === 'incomplete') wording = TURN_WORDINGS.incomplete(turn.before.bound ?? 'a limit')
    else if (turn.after?.state === 'incomplete') wording = TURN_WORDINGS.incomplete(turn.after.bound ?? 'a limit')
    else if (compared && compared.state !== 'compared') {
      wording = compared.state === 'cancelled' || compared.reason === 'Difference unavailable: limit reached' ? TURN_WORDINGS.limitReached()
        : compared.reason === 'a capture is incomplete' ? TURN_WORDINGS.incomplete(compared.bound ?? 'a limit')
          : TURN_WORDINGS.notSupported(compared.reason)
    } else if (compared) {
      totals = { files: compared.totals.files, added: compared.totals.added, removed: compared.totals.removed }
      if (unverified) {
        wording = TURN_WORDINGS.orderingUnverified(app, shown)
        totalsState = 'not-complete'
      } else if (compared.totals.partial) {
        wording = TURN_WORDINGS.partial(compared.totals.notCounted)
        totalsState = 'partial'
      } else totalsState = 'complete'
    } else if (unverified) wording = TURN_WORDINGS.orderingUnverified(app, shown)
    row.wording = wording
    row.totals = totals
    row.totalsState = totalsState

    const labels: string[] = []
    const { before, after } = turn
    if (before && after) {
      labels.push(
        TURN_LABELS.scans(before.root, [turnLabelTime(before.startedAt), turnLabelTime(before.endedAt)], [turnLabelTime(after.startedAt), turnLabelTime(after.endedAt)]),
        TURN_LABELS.covered(), TURN_LABELS.after())
      if (turn.through) labels.push(TURN_LABELS.endNotObserved())
    } else if (turn.root) labels.push(TURN_LABELS.covered())
    if (turn.root && (turn.shared || this.options.shared(row.sessionId, turn.root.root))) {
      turn.shared = true
      labels.push(TURN_LABELS.sharedWorkTree())
    }
    if (before && after && new Set([before.headStart, before.headEnd, after.headStart, after.headEnd]).size > 1) {
      labels.push(TURN_LABELS.head(shortCommit(before.headStart), shortCommit(before.headEnd), shortCommit(after.headStart), shortCommit(after.headEnd)))
    }
    if (unverified && measured) labels.push(TURN_LABELS.version(app, shown, measured.version))
    if (compared?.state === 'compared' && compared.totals.partial) labels.push(TURN_LABELS.partial(compared.totals.notCounted))
    row.labels = labels
  }

  private async store(turn: LiveTurn): Promise<void> {
    const row = turn.row
    row.before = turn.before?.id ?? null
    row.after = turn.after?.id ?? null
    row.workTree = turn.root?.root ?? null
    const captures = [turn.before, turn.after].flatMap((record): TurnCaptureRow[] => record === null || turn.recorded.has(record.id) ? [] : [{
      captureId: record.id, sessionId: row.sessionId, workTree: record.root, scanStartedMs: record.startedAt, scanEndedMs: record.endedAt,
      headStart: record.headStart, headEnd: record.headEnd, state: record.state, bound: record.bound, size: record.bytesStored
    }])
    try {
      await this.options.database.putTurn({ turn: { ...row, labels: [...row.labels] }, captures })
      for (const capture of captures) turn.recorded.add(capture.captureId)
      for (const joined of turn.joined) {
        // A prompt typed into this turn ends with it.
        Object.assign(joined, { state: row.state, endKind: row.endKind, endedAt: row.endedAt, appVersion: row.appVersion, workTree: row.workTree })
        await this.options.database.putTurn({ turn: { ...joined } })
      }
    } catch {
      // The session's rows went, or the database is closing: there is nobody to show this turn to.
    }
    this.options.changed(row.sessionId)
  }

  // ---- the pause ------------------------------------------------------------------------------------

  /**
   * Three scans in a row that failed, or were incomplete and read nothing new, for one root of this session,
   * pause recording for it. An incomplete scan that read on is not one of the three and leaves the count as
   * it is (the owner's pick on the design card, 2026-10-13): a big work tree is whole after a few scans with
   * nothing pressed, and one that never gets further still pauses.
   */
  private count(state: SessionTurns, key: string, outcome: 'whole' | 'incomplete' | 'failed', further = false): void {
    if (outcome === 'whole') {
      state.failures.delete(key)
      return
    }
    if (outcome === 'incomplete' && further) return
    const tally = state.failures.get(key) ?? { failed: 0, incomplete: 0 }
    tally[outcome] += 1
    state.failures.set(key, tally)
    if (tally.failed + tally.incomplete < TURN_PAUSE_AFTER || state.paused.has(key)) return
    state.paused.set(key, tally.failed === 0 ? 'incomplete' : tally.incomplete === 0 ? 'failed' : 'mixed')
    this.options.changed(state.sessionId)
  }

  private pausedAt(state: SessionTurns, folder: string): boolean {
    for (const key of state.paused.keys()) if (folder === key || folder.startsWith(key.endsWith('/') ? key : `${key}/`)) return true
    return false
  }

  // ---- plumbing -------------------------------------------------------------------------------------

  private session(sessionId: string): SessionTurns {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = { sessionId, queue: Promise.resolve(), number: null, live: [], pending: null, confirming: null, requests: new Map(), failures: new Map(), paused: new Map(), app: null, appIdentity: null }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private enqueue<Result>(state: SessionTurns, run: () => Promise<Result>): Promise<Result> {
    const result = state.queue.then(run)
    // Every step may have let go of a "before" that waited for its confirmation.
    const done = (): void => this.wake()
    state.queue = result.then(done, done)
    return result
  }

  /** Whether a prompt is on its way through BMN: a start mark or a confirmation is being answered, or a "before" waits for its confirmation. */
  private prompted(): boolean {
    if (this.answering > 0) return true
    for (const state of this.sessions.values()) if (state.pending !== null) return true
    return false
  }

  /** Lets the version reads that waited for a prompt go on, once none is on its way. */
  private wake(): void {
    if (this.waiting.length === 0 || this.prompted()) return
    for (const read of this.waiting.splice(0)) this.defer(read)
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.then(() => undefined, () => undefined).finally(() => this.work.delete(tracked))
    this.work.add(tracked)
  }

  private remember(state: SessionTurns, key: string, status: TurnMarkStatus): void {
    state.requests.set(key, status)
    if (state.requests.size > REQUESTS_KEPT) state.requests.delete(state.requests.keys().next().value as string)
  }

  /**
   * The app's version, read once per foreground process and away from a prompt's path (69.4 criterion 4): never
   * in the call that asks for it, and not while a prompt is on its way through BMN. A read asked for meanwhile
   * waits until the prompt is through.
   */
  private version(identity: string, app: string): Promise<string | null> {
    let reading = this.versions.get(identity)
    if (!reading) {
      reading = new Promise<string | null>((resolve) => {
        const read = (): void => {
          if (this.prompted()) this.waiting.push(read)
          else resolve(Promise.resolve().then(() => this.options.version(identity, app)).catch(() => null))
        }
        this.defer(read)
      })
      this.versions.set(identity, reading)
      if (this.versions.size > VERSIONS_KEPT) this.versions.delete(this.versions.keys().next().value as string)
    }
    return reading
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /** One empty file per session whose switch is on: the hook sends no mark without it. */
  private writeHints(): void {
    try {
      mkdirSync(this.options.hintFolder, { recursive: true, mode: 0o700 })
      const present = new Set(readdirSync(this.options.hintFolder))
      for (const sessionId of this.on) if (!present.has(sessionId)) writeFileSync(join(this.options.hintFolder, sessionId), '', { mode: 0o600 })
      for (const name of present) if (!this.on.has(name)) rmSync(join(this.options.hintFolder, name), { force: true })
    } catch {
      // Without the folder no hook sends a mark: recording is off, never wrong.
    }
  }
}
