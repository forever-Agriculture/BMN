// MODULE: turn-changes-engine.ts - runs captures and comparisons for the host: one capture per work tree at a time, a session's captures in order, staged until confirmed
//
// The engine lives in a worker thread (`turn-changes-worker.ts`), apart from the work that keeps
// terminals flowing. A capture is answered while still staged: the caller publishes it once the hook
// confirmed the answer, or discards it, and a staged capture nobody settles is discarded by itself.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { TURN_LIMITS, capture, isRefusal, refusal, type CaptureSeams, type PublishedCapture, type StagedCapture, type TurnLimits, type TurnRefusal, type TurnRootIdentity } from './turn-changes-capture'
import type { TurnShownDifference } from '@bmn/protocol'
import { compareCaptures, shownFileDifference, type TurnComparison } from './turn-changes-compare'
import type { TurnGitCall } from './turn-changes-git'
import { TURN_STORE_FOLDER, TurnStore, isStoreSegment, listTurnStores, workTreeKey, type TurnCaptureRecord } from './turn-changes-store'

export interface TurnEngineOptions {
  dataRoot: string
  home: string
  git?: string | null
  limits?: Partial<TurnLimits>
  /** How long a staged capture waits to be published before it is discarded. */
  holdMs?: number
  observeGit?: (call: TurnGitCall) => void
}

export interface TurnCaptureRequest {
  /** The caller's name for this piece of work, to cancel it by. */
  job: string
  session: string
  /** The folder Linux reports for the foreground process of the session's terminal. */
  folder: string
  /** A folder a hook names; it must lie in the root BMN establishes. */
  named?: string | null
  base?: string | null
  /** The root this capture must find again, or it reads nothing: for a turn's second scan. */
  expect?: TurnRootIdentity | null
  /** Publish at once, for a capture nobody has to confirm. */
  publish: boolean
}

export type TurnCaptureAnswer =
  | TurnRefusal
  /** `adds`: for a published capture, how many bytes the store grew by (files and lists moved in, the record, the new cache less the old one); for a staged one, the most its publication needs. */
  | { state: 'whole' | 'incomplete'; record: TurnCaptureRecord; published: boolean; tookMs: number; adds: number }

export interface TurnPairRequest {
  session: string
  root: string
  a: string
  b: string
}

/** What the host may ask of the engine, whether it runs in a worker or, in a test, in the same thread. */
export interface TurnChangesPort {
  capture: (request: TurnCaptureRequest, signal?: AbortSignal) => Promise<TurnCaptureAnswer>
  /**
   * Makes a staged capture real. Null when it is no longer staged (discarded, cancelled or never there) and when
   * it was stopped: by `signal`, or by `until`, a time of `Date.now()`. Both are heard where the capture is
   * published, at every step of it and last just before its record appears, whatever the caller's thread is doing.
   */
  publish: (capture: string, until?: number, signal?: AbortSignal) => Promise<TurnCaptureRecord | null>
  discard: (capture: string) => Promise<void>
  compare: (request: TurnPairRequest, signal?: AbortSignal) => Promise<TurnComparison | TurnRefusal>
  difference: (request: TurnPairRequest & { path: string }, signal?: AbortSignal) => Promise<TurnShownDifference | TurnRefusal>
}

/** One store on disk, by its two folder names, with its published captures: an id and the time its scan ended. Never a file's name. */
export interface TurnStoreInventory {
  session: string
  key: string
  captures: Array<{ id: string; endedAt: number }>
}

/** Bytes the stores hold on disk (files, lists, records of captures, caches, and anything a failure left there), per session and in all. */
export interface TurnStoreUsage {
  sessions: Record<string, number>
  all: number
}

/** What keeping the store in order may ask of the engine: removal and counts, never a name or a byte of a captured file. */
export interface TurnStoreKeeper {
  /** Removes published captures of one store and every byte no remaining capture needs. */
  removeCaptures: (request: { session: string; key: string; captures: string[] }) => Promise<void>
  /** Removes a session's whole store folder. */
  removeSession: (session: string) => Promise<void>
  /** Removes what a crash left staged or half removed. For a start, before any capture. */
  clearLeftovers: () => Promise<void>
  inventory: () => Promise<TurnStoreInventory[]>
  usage: () => Promise<TurnStoreUsage>
}

/** What holds a publication besides the engine's own words: a time of `Date.now()` past which it stops, and its caller's stop. */
export interface PublishHold {
  until?: number | undefined
  stopped?: (() => boolean) | undefined
}

interface Held {
  staged: StagedCapture
  session: string
  job: string
  timer: NodeJS.Timeout
  done: () => void
}

/** Bytes that are on disk, or may come to be, for one session without being kept yet. */
interface Reserved {
  session: string
  bytes: number
}

const DEFAULT_HOLD_MS = 1_000
const STORES_KEPT = 16
/** A folder's list takes at most about this much per entry; with the bytes a capture may read it bounds what one capture can store. */
const LIST_BYTES_PER_ENTRY = 4_096

export class TurnChangesEngine {
  private readonly options: TurnEngineOptions
  private readonly running = new Map<string, AbortController>()
  private readonly held = new Map<string, Held>()
  private readonly heldByJob = new Map<string, string>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly stores = new Map<string, TurnStore>()
  /**
   * Bytes on disk per session and store folder: counted from the whole folder once, then kept by what each
   * publication really added (which can be less than nothing, when a cache shrank) and counted from the disk
   * again after every removal and clearing.
   */
  private counted: Map<string, Map<string, number>> | null = null
  /** The room each running capture was given: it is held for that capture until its bytes are kept or on their way out. */
  private readonly granted = new Map<string, Reserved>()
  /** Bytes that left `staging/` without being kept and are not yet gone from the disk. */
  private readonly leaving = new Set<Reserved>()
  /** Per session: resolves when everything of it that was on its way out is settled. */
  private readonly going = new Map<string, Promise<void>>()
  /** Staged captures that are being published now, each with the word that stops it. */
  private readonly publishing = new Map<string, { stopped: boolean }>()

  constructor(options: TurnEngineOptions) {
    this.options = options
  }

  private bytes(): Map<string, Map<string, number>> {
    if (this.counted) return this.counted
    const counted = new Map<string, Map<string, number>>()
    for (const { session, key } of listTurnStores(this.options.dataRoot)) {
      const stores = counted.get(session) ?? new Map<string, number>()
      stores.set(key, this.onDisk(new TurnStore(this.options.dataRoot, session, '', key)) ?? 0)
      counted.set(session, stores)
    }
    this.counted = counted
    return counted
  }

  /**
   * Every byte under one store's folder; null when the folder is gone. A store that cannot be counted (one of
   * its folders cannot be listed) counts as full: a number that passed bytes over would let the bound be passed.
   */
  private onDisk(store: TurnStore): number | null {
    if (!store.exists()) return null
    try {
      return store.diskBytes()
    } catch {
      return { ...TURN_LIMITS, ...this.options.limits }.storeBytes
    }
  }

  private count(session: string, key: string, change: (before: number) => number | null): void {
    const counted = this.bytes()
    const stores = counted.get(session) ?? new Map<string, number>()
    const next = change(stores.get(key) ?? 0)
    if (next === null) stores.delete(key)
    else stores.set(key, next)
    if (stores.size === 0) counted.delete(session)
    else counted.set(session, stores)
  }

  /**
   * How many more bytes a capture of this session may put on disk: what is left of the session's bound
   * and of the bound of all stores. Counted are what the stores keep on disk, what is staged, what is on
   * its way out and not yet gone, and the room held for every capture that runs now, so that two sessions
   * capturing at once cannot both take the same last bytes. No capture is given more than one capture can
   * store. Nothing kept is removed to make room (R69-NFR5).
   */
  private room(session: string): number {
    const limits: TurnLimits = { ...TURN_LIMITS, ...this.options.limits }
    let own = 0
    let all = 0
    const add = (name: string, bytes: number): void => {
      all += bytes
      if (name === session) own += bytes
    }
    for (const [name, stores] of this.bytes()) for (const size of stores.values()) add(name, size)
    for (const held of this.held.values()) add(held.session, held.staged.adds)
    for (const reserved of this.granted.values()) add(reserved.session, reserved.bytes)
    for (const reserved of this.leaving) add(reserved.session, reserved.bytes)
    const most = limits.readBytes + limits.entries * LIST_BYTES_PER_ENTRY
    return Math.max(0, Math.min(limits.storeBytes - own, limits.allStoresBytes - all, most))
  }

  /** Publishes a staged capture and counts what the store really grew by. Null when `stop` said so meanwhile: nothing of it is kept. */
  private async published(session: string, staged: StagedCapture, stop: () => boolean): Promise<PublishedCapture | null> {
    const done = await staged.publish(stop)
    if (done) {
      const key = workTreeKey(done.record.root)
      // Something failed after the record appeared: what the store holds is read from the disk, not worked out.
      if (done.recount) this.count(session, key, () => this.onDisk(this.store(session, done.record.root)))
      else this.count(session, key, (before) => before + done.added)
    }
    return done
  }

  /**
   * Bytes that left `staging/` without being kept are on disk until their removal is done: they count until
   * then. A removal that failed leaves them there, so they are counted with the store from then on, until
   * the store is counted from the disk again.
   */
  private goes(session: string, key: string, bytes: number, gone: Promise<boolean>): void {
    if (bytes <= 0) return
    const reserved = { session, bytes }
    this.leaving.add(reserved)
    const settled = gone.then((removed) => {
      this.leaving.delete(reserved)
      if (!removed) this.count(session, key, (before) => before + bytes)
    })
    const all = Promise.all([this.going.get(session), settled]).then(() => undefined)
    this.going.set(session, all)
    void all.then(() => {
      if (this.going.get(session) === all) this.going.delete(session)
    })
  }

  /** A place in the session's line: `earlier` resolves when everything asked before is settled, `done` lets the next one go. */
  private enter(session: string): { earlier: Promise<void>; done: () => void } {
    const earlier = this.tails.get(session) ?? Promise.resolve()
    let done = (): void => undefined
    const mine = new Promise<void>((resolve) => {
      done = resolve
    })
    const tail = earlier.then(() => mine)
    this.tails.set(session, tail)
    void tail.then(() => {
      if (this.tails.get(session) === tail) this.tails.delete(session)
    })
    return { earlier, done }
  }

  /** The store of one session's work tree, with what it holds in memory; the oldest is let go past a few. */
  store(session: string, root: string): TurnStore {
    const key = `${session}\n${root}`
    let store = this.stores.get(key)
    if (store) this.stores.delete(key)
    else store = new TurnStore(this.options.dataRoot, session, root)
    this.stores.set(key, store)
    if (this.stores.size > STORES_KEPT) this.stores.delete(this.stores.keys().next().value as string)
    return store
  }

  /** Something under a session's stores was removed: what is held in memory of them no longer counts. */
  forget(session: string): void {
    for (const [key, store] of this.stores) {
      if (key.startsWith(`${session}\n`)) {
        store.forget()
        this.stores.delete(key)
      }
    }
  }

  async capture(request: TurnCaptureRequest, seams?: CaptureSeams): Promise<TurnCaptureAnswer> {
    const controller = new AbortController()
    this.running.set(request.job, controller)
    // A session's captures run in the order they were asked for: a later one starts only when the
    // earlier one was published, discarded, refused or cancelled.
    const { earlier, done } = this.enter(request.session)
    let settledHere = true
    let key = ''
    try {
      await earlier
      if (controller.signal.aborted) return refusal('cancelled', 'cancelled')
      const room = this.room(request.session)
      this.granted.set(request.job, { session: request.session, bytes: room })
      const outcome = await capture(request.folder, {
        git: this.options.git, home: this.options.home, dataRoot: this.options.dataRoot, session: request.session,
        named: request.named ?? null, base: request.base ?? null, expect: request.expect ?? null, signal: controller.signal, room,
        ...(this.options.limits ? { limits: this.options.limits } : {}),
        ...(seams ? { seams } : {}),
        ...(this.options.observeGit ? { observeGit: this.options.observeGit } : {}),
        // The root is known only once the capture established it.
        storeFor: (root) => {
          key = workTreeKey(root)
          return this.store(request.session, root)
        },
        // Whatever the capture drops from `staging/` counts, to the byte, until it is gone from the disk.
        dropped: (bytes, gone) => this.goes(request.session, key, bytes, gone)
      })
      if (isRefusal(outcome)) return outcome
      if (controller.signal.aborted) {
        outcome.discard()
        return refusal('cancelled', 'cancelled')
      }
      if (request.publish) {
        // The room stays held and the job can be cancelled until the publication is done one way or the other.
        const made = await this.published(request.session, outcome, () => controller.signal.aborted)
        if (made === null) return refusal('cancelled', 'cancelled')
        return { state: made.record.state, record: made.record, published: true, tookMs: made.tookMs, adds: made.added }
      }
      const id = outcome.record.id
      const timer = setTimeout(() => void this.settle(id, false), this.options.holdMs ?? DEFAULT_HOLD_MS)
      // From here its bytes are counted as staged, no longer as room held for it.
      this.held.set(id, { staged: outcome, session: request.session, job: request.job, timer, done })
      this.granted.delete(request.job)
      this.heldByJob.set(request.job, id)
      settledHere = false
      return { state: outcome.state, record: outcome.record, published: false, tookMs: outcome.tookMs, adds: outcome.adds }
    } finally {
      this.running.delete(request.job)
      if (settledHere) done()
      // What it dropped on the way is counted by itself; the room it was given is free again.
      this.granted.delete(request.job)
    }
  }

  /**
   * Publishes or discards a staged capture. While it is being published it still counts as staged and can
   * still be stopped: by its job's cancel, by a discard, by the worker's end, and by the caller's own word
   * (`hold`), which it reads at every step itself. A stopped publication keeps nothing.
   */
  private async settle(capture: string, publish: boolean, hold: PublishHold = {}): Promise<TurnCaptureRecord | null> {
    const stopping = this.publishing.get(capture)
    if (stopping) {
      if (!publish) stopping.stopped = true
      return null
    }
    const held = this.held.get(capture)
    if (!held) return null
    clearTimeout(held.timer)
    const word = { stopped: false }
    try {
      if (!publish) {
        held.staged.discard()
        return null
      }
      this.publishing.set(capture, word)
      const { until, stopped } = hold
      // A message is heard only between steps; the caller's word and the clock are read at each of them.
      const stop = (): boolean => word.stopped || stopped?.() === true || (until !== undefined && Date.now() > until)
      return (await this.published(held.session, held.staged, stop))?.record ?? null
    } finally {
      this.publishing.delete(capture)
      this.held.delete(capture)
      this.heldByJob.delete(held.job)
      held.done()
    }
  }

  publish(capture: string, hold: PublishHold = {}): Promise<TurnCaptureRecord | null> {
    return this.settle(capture, true, hold)
  }

  async discard(capture: string): Promise<void> {
    await this.settle(capture, false)
  }

  /** Stops a capture that is waiting, running or being published, and discards it when it is staged. */
  cancel(job: string): void {
    this.running.get(job)?.abort()
    const staged = this.heldByJob.get(job)
    if (staged) void this.settle(staged, false)
  }

  compare(request: TurnPairRequest, cancelled?: () => boolean): TurnComparison | TurnRefusal {
    return compareCaptures(this.pairStore(request), request.a, request.b, {
      ...(this.options.limits?.compareMs === undefined ? {} : { limitMs: this.options.limits.compareMs }),
      ...(cancelled ? { cancelled } : {})
    })
  }

  /** One file's difference as the window may read it: bounded, every secret value masked. The texts never leave this thread. */
  difference(request: TurnPairRequest & { path: string }, cancelled?: () => boolean): TurnShownDifference | TurnRefusal {
    return shownFileDifference(this.pairStore(request), request.a, request.b, request.path, {
      ...(this.options.limits?.compareMs === undefined ? {} : { limitMs: this.options.limits.compareMs }),
      ...(cancelled ? { cancelled } : {})
    })
  }

  /** A comparison reads a store without keeping it in memory: it must not push out a store captures use. */
  private pairStore(request: TurnPairRequest): TurnStore {
    return this.stores.get(`${request.session}\n${request.root}`) ?? new TurnStore(this.options.dataRoot, request.session, request.root)
  }

  /**
   * Removes published captures of one store, and every stored byte no remaining capture needs. It
   * waits its turn in the session's line, so nothing of that session is being captured or staged
   * while bytes are taken away.
   */
  async removeCaptures(request: { session: string; key: string; captures: string[] }): Promise<void> {
    const { earlier, done } = this.enter(request.session)
    try {
      await earlier
      // What this session dropped is gone or known to have stayed before the disk is counted, so nothing is counted twice.
      await this.going.get(request.session)
      this.forget(request.session)
      const store = new TurnStore(this.options.dataRoot, request.session, '', request.key)
      try {
        store.removeCaptures(request.captures)
      } finally {
        this.count(request.session, request.key, () => this.onDisk(store))
      }
    } finally {
      done()
    }
  }

  /** Removes a session's whole store folder, every work tree in it. */
  async removeSession(session: string): Promise<void> {
    if (!isStoreSegment(session)) throw new Error('a session id that cannot name a folder')
    const { earlier, done } = this.enter(session)
    try {
      await earlier
      this.forget(session)
      try {
        rmSync(join(this.options.dataRoot, TURN_STORE_FOLDER, session), { recursive: true, force: true })
        this.counted?.delete(session)
      } catch (error) {
        // Part of it may be gone: everything is counted from the disk again.
        this.counted = null
        throw error
      }
    } finally {
      done()
    }
  }

  /**
   * What a crash left behind in every store whose session is not capturing: staged captures, never published,
   * cancelled ones, and the bytes of a publication that was interrupted before its record appeared.
   */
  clearLeftovers(): void {
    for (const { session, key } of listTurnStores(this.options.dataRoot)) {
      if (this.tails.has(session)) continue
      this.forget(session)
      const store = new TurnStore(this.options.dataRoot, session, '', key)
      try {
        store.clearLeftovers()
      } finally {
        // Bytes may have gone, and what could not be removed is still there: this store is counted from the disk again.
        this.count(session, key, () => this.onDisk(store))
      }
    }
  }

  inventory(): TurnStoreInventory[] {
    return listTurnStores(this.options.dataRoot).map(({ session, key }) => {
      const store = new TurnStore(this.options.dataRoot, session, '', key)
      return { session, key, captures: store.captures().map((id) => ({ id, endedAt: store.captureTime(id) })) }
    })
  }

  usage(): TurnStoreUsage {
    const sessions: Record<string, number> = {}
    let all = 0
    for (const [session, stores] of this.bytes()) {
      const size = [...stores.values()].reduce((sum, bytes) => sum + bytes, 0)
      sessions[session] = size
      all += size
    }
    return { sessions, all }
  }

  /** Discards everything staged; for the worker's end. */
  close(): void {
    for (const controller of this.running.values()) controller.abort()
    for (const capture of [...this.held.keys()]) void this.settle(capture, false)
  }
}

/** The engine in the caller's own thread, as the keeper the host uses. For tests and for nothing else. */
export function inProcessKeeper(engine: TurnChangesEngine): TurnStoreKeeper {
  return {
    removeCaptures: (request) => engine.removeCaptures(request),
    removeSession: (session) => engine.removeSession(session),
    clearLeftovers: () => Promise.resolve(engine.clearLeftovers()),
    inventory: () => Promise.resolve(engine.inventory()),
    usage: () => Promise.resolve(engine.usage())
  }
}

/** The engine in the caller's own thread, as the port the host uses. For tests and for nothing else. */
export function inProcessPort(engine: TurnChangesEngine): TurnChangesPort {
  return {
    capture: (request, signal) => {
      const cancel = (): void => engine.cancel(request.job)
      if (signal?.aborted) return Promise.resolve(refusal('cancelled', 'cancelled'))
      signal?.addEventListener('abort', cancel, { once: true })
      return engine.capture(request).finally(() => signal?.removeEventListener('abort', cancel))
    },
    publish: (capture, until, signal) => engine.publish(capture, { until, stopped: () => signal?.aborted === true }),
    discard: (capture) => engine.discard(capture),
    compare: (request, signal) => Promise.resolve(signal?.aborted ? refusal('cancelled', 'cancelled') : engine.compare(request, () => signal?.aborted === true)),
    difference: (request, signal) => Promise.resolve(signal?.aborted ? refusal('cancelled', 'cancelled') : engine.difference(request, () => signal?.aborted === true))
  }
}
