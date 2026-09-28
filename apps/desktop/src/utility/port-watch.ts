// MODULE: port-watch.ts - when to scan for session ports, and the last good result (Story 41.1)
import type { ListeningPort, SessionPorts } from '@bmn/protocol'

/** While any live session printed in the last minute: at most one scan per this interval. */
export const BUSY_SCAN_MS = 5_000
/** Otherwise, with at least one live session. */
export const QUIET_SCAN_MS = 30_000
/** How recent output must be for the busy interval. */
export const RECENT_OUTPUT_MS = 60_000
/** A server's own "listening" line is printed just before or after it binds; scan shortly after. */
export const HINT_SCAN_DELAY_MS = 500
/** At most one hint scan per busy interval: a request log full of URLs is one burst, not a scan every half second. */
export const HINT_SCAN_SPACING_MS = BUSY_SCAN_MS

/**
 * Lines a dev server prints when it starts listening. They stay narrow on purpose: looser ones matched ssh banners
 * and timestamps in Superset's scanner. Matched against the output with escape sequences removed.
 */
export const HINT_PATTERNS: readonly RegExp[] = [
  /\blistening on\b/i,
  /\bLocal:\s+https?:\/\//,
  /\bServing HTTP on\b/,
  /\bserver running at https?:\/\//i,
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}\b/
]
/** Only a chunk's tail is read for hints, and a short carry keeps a line split across chunks whole. */
const HINT_READ_BYTES = 4096
const HINT_CARRY_CHARS = 160
// CSI and OSC sequences, and any other single escape: colours split words like "Local" from their colon.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g

export interface PortWatchOptions {
  /** One pass over /proc for these sessions; throws when the socket tables cannot be read. */
  scan(sessionIds: ReadonlySet<string>): Promise<Map<string, ListeningPort[]>>
  /** Every session BMN knows, live or stopped: a stopped session's leftover server stays under it. */
  knownSessionIds(): ReadonlySet<string>
  liveSessionIds(): readonly string[]
  /** Called after a scan or a session change alters what any session lists. */
  changed(): void
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export class PortWatch {
  private result = new Map<string, ListeningPort[]>()
  private readonly lastOutputAt = new Map<string, number>()
  private readonly carry = new Map<string, string>()
  /** Whether each listed session was live when the window was last told, so a stop alone is announced too. */
  private readonly announcedLive = new Map<string, boolean>()
  private timer: unknown = null
  private timerDueAt = 0
  private hintTimer: unknown = null
  private lastHintAt = Number.NEGATIVE_INFINITY
  private lastScanAt = Number.NEGATIVE_INFINITY
  private scanning: Promise<void> | null = null
  private rescanAfterCurrent = false
  private stopped = true
  private readonly now: () => number
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void

  constructor(private readonly options: PortWatchOptions) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((run, ms) => {
      const timer = setTimeout(run, ms)
      timer.unref()
      return timer
    })
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
  }

  start(): void {
    this.stopped = false
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.clearTimer(this.timer)
    if (this.hintTimer !== null) this.clearTimer(this.hintTimer)
    this.timer = null
    this.hintTimer = null
  }

  /** Every session's ports, with a stopped session's leftovers marked; deleted sessions list nothing. */
  list(): SessionPorts[] {
    const known = this.options.knownSessionIds()
    const live = new Set(this.options.liveSessionIds())
    return [...this.result]
      .filter(([sessionId]) => known.has(sessionId))
      .map(([sessionId, ports]) => ({ sessionId, stopped: !live.has(sessionId), ports }))
  }

  /** A session's output: it keeps the busy cadence, and a listening line brings the next scan forward. */
  output(sessionId: string, bytes: Uint8Array): void {
    this.lastOutputAt.set(sessionId, this.now())
    if (this.stopped) return
    // Output after a quiet spell: the next scan comes at the busy interval, not up to 30 s later.
    const busyDue = Math.max(this.now(), this.lastScanAt + BUSY_SCAN_MS)
    if (this.timer !== null && this.timerDueAt > busyDue) this.arm(busyDue - this.now())
    if (this.hintTimer !== null || this.now() - this.lastHintAt < HINT_SCAN_SPACING_MS) return
    const tail = bytes.byteLength > HINT_READ_BYTES ? bytes.subarray(bytes.byteLength - HINT_READ_BYTES) : bytes
    const text = (this.carry.get(sessionId) ?? '') + Buffer.from(tail.buffer, tail.byteOffset, tail.byteLength).toString('latin1')
    const plain = text.replace(ESCAPES, '')
    this.carry.set(sessionId, plain.slice(-HINT_CARRY_CHARS))
    if (!HINT_PATTERNS.some((pattern) => pattern.test(plain))) return
    // One scan per burst: further matching lines before it runs add nothing.
    this.carry.set(sessionId, '')
    this.lastHintAt = this.now()
    this.hintTimer = this.setTimer(() => {
      this.hintTimer = null
      // The session may have ended within the half second; with none live, nothing scans.
      if (this.options.liveSessionIds().length > 0) void this.scanNow()
    }, HINT_SCAN_DELAY_MS)
  }

  /** Sessions were created, stopped or deleted: drop deleted ones at once and restart the cadence if needed. */
  sessionsChanged(): void {
    const known = this.options.knownSessionIds()
    let removed = false
    for (const map of [this.result, this.lastOutputAt, this.carry] as Map<string, unknown>[]) {
      for (const sessionId of map.keys()) {
        if (known.has(sessionId)) continue
        map.delete(sessionId)
        if (map === this.result) removed = true
      }
    }
    if (this.liveChanged() || removed) this.options.changed()
    // Re-plan even with a timer armed: output may have brought it forward for a session that has just ended.
    if (!this.stopped && this.scanning === null) this.schedule()
  }

  /** Runs one scan now, or once more right after the one in flight. */
  async scanNow(): Promise<void> {
    if (this.scanning) {
      this.rescanAfterCurrent = true
      return this.scanning
    }
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    // A listener that throws must not become an unhandled rejection in the process that owns every terminal.
    this.scanning = this.runScan().catch(() => undefined).finally(() => {
      this.scanning = null
      const again = this.rescanAfterCurrent && this.options.liveSessionIds().length > 0
      this.rescanAfterCurrent = false
      if (again) void this.scanNow()
      else this.schedule()
    })
    return this.scanning
  }

  private async runScan(): Promise<void> {
    this.lastScanAt = this.now()
    const known = this.options.knownSessionIds()
    let next: Map<string, ListeningPort[]>
    try {
      next = await this.options.scan(known)
    } catch {
      // An unreadable table says nothing about the ports: the previous result stands.
      return
    }
    if (sameResult(this.result, next)) return
    this.result = next
    this.liveChanged()
    this.options.changed()
  }

  /** Records each listed session's liveness; true when one differs from what was last announced. */
  private liveChanged(): boolean {
    const live = new Set(this.options.liveSessionIds())
    let changed = false
    for (const sessionId of this.result.keys()) {
      if (this.announcedLive.get(sessionId) === live.has(sessionId)) continue
      this.announcedLive.set(sessionId, live.has(sessionId))
      changed = true
    }
    for (const sessionId of this.announcedLive.keys()) {
      if (!this.result.has(sessionId)) this.announcedLive.delete(sessionId)
    }
    return changed
  }

  private schedule(): void {
    if (this.stopped) return
    const live = this.options.liveSessionIds()
    // No live session: nothing new can start listening under BMN, so nothing scans until one starts.
    if (live.length === 0) {
      if (this.timer !== null) this.clearTimer(this.timer)
      this.timer = null
      return
    }
    const now = this.now()
    const busy = live.some((sessionId) => now - (this.lastOutputAt.get(sessionId) ?? Number.NEGATIVE_INFINITY) < RECENT_OUTPUT_MS)
    this.arm(Math.max(0, this.lastScanAt + (busy ? BUSY_SCAN_MS : QUIET_SCAN_MS) - now))
  }

  private arm(delayMs: number): void {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timerDueAt = this.now() + delayMs
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.scanNow()
    }, delayMs)
  }
}

function sameResult(left: ReadonlyMap<string, ListeningPort[]>, right: ReadonlyMap<string, ListeningPort[]>): boolean {
  if (left.size !== right.size) return false
  for (const [sessionId, ports] of left) {
    const other = right.get(sessionId)
    if (!other || other.length !== ports.length) return false
    if (ports.some((port, index) => {
      const next = other[index]!
      return port.port !== next.port || port.address !== next.address || port.pid !== next.pid || port.command !== next.command
    })) return false
  }
  return true
}
