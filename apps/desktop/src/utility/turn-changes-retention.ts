// MODULE: turn-changes-retention.ts - removes what turn changes may no longer keep, at start and every hour: the rows first, in one transaction with a job, the bytes after it (Story 69.3)
//
// A turn is kept as long as the owner's confirmed Keep agent history limit says; a capture stays while
// a kept turn refers to it. Rows are deleted together with a job that names their bytes, the bytes
// are removed after that commit, and the job is cleared when they are gone: a crash in between, or a
// removal that fails, leaves the job, and the next sweep tries again. Nothing outside
// `<data root>/turn-changes/` is touched, and nothing is removed to make room.
import type { TurnRemovalJob, TurnSweepResult } from './database-turn-store'
import type { TurnStoreKeeper } from './turn-changes-engine'
import { workTreeKey } from './turn-changes-store'

const DAY_MS = 86_400_000
export const TURN_SWEEP_INTERVAL_MS = 60 * 60_000

/** The rows of turn changes, as the sweep needs them. Each call is one transaction. */
export interface TurnRetentionDatabase {
  /** The owner's confirmed Keep agent history limit: days, `null` for Never, `undefined` while nothing is confirmed. */
  keepDays: () => Promise<number | null | undefined>
  sweep: (p: { now: string; keepDays: number | null | undefined }) => Promise<TurnSweepResult>
  jobs: () => Promise<TurnRemovalJob[]>
  finish: (jobId: number) => Promise<void>
  fail: (p: { jobId: number; now: string }) => Promise<void>
  named: () => Promise<Array<{ sessionId: string; captureId: string }>>
}

export interface TurnRetentionOptions {
  database: TurnRetentionDatabase
  keeper: TurnStoreKeeper
  /** Whether `<data root>/turn-changes/` exists at all. While it does not, nothing is asked of the keeper. */
  storePresent: () => boolean
  now?: () => Date
  /** One line per sweep that did something: counts only, never a name. */
  log?: (line: string) => void
  /** Told after a sweep that did something: a turn went, or a removal now waits or no longer does. */
  changed?: () => void
  setTimer?: (callback: () => void, ms: number) => { cancel: () => void }
}

export interface TurnSweepReport {
  /** Turns whose time had passed. */
  turns: number
  /** Captures no kept turn referred to. */
  captures: number
  /** Removal jobs whose bytes are gone. */
  removed: number
  /** Removal jobs that failed and wait for the next sweep. */
  waiting: number
  /** Published captures no row named, removed because their own time had passed. */
  unnamed: number
}

export class TurnRetention {
  private readonly options: TurnRetentionOptions
  private running: Promise<TurnSweepReport> | null = null
  private timer: { cancel: () => void } | null = null
  private stopped = false

  constructor(options: TurnRetentionOptions) {
    this.options = options
  }

  /** The sweep at start, which also clears what a crash left staged, then one every hour. Nothing awaits it. */
  start(): void {
    const schedule = this.options.setTimer ?? ((callback: () => void, ms: number) => {
      const handle = setTimeout(callback, ms)
      handle.unref?.()
      return { cancel: () => clearTimeout(handle) }
    })
    const tick = (): void => {
      this.timer = schedule(() => {
        if (this.stopped) return
        void this.sweep().catch(() => undefined)
        tick()
      }, TURN_SWEEP_INTERVAL_MS)
    }
    void this.sweep({ start: true }).catch(() => undefined)
    tick()
  }

  stop(): void {
    this.stopped = true
    this.timer?.cancel()
  }

  /** One sweep. A second call while one runs joins it. */
  sweep(p: { start?: boolean } = {}): Promise<TurnSweepReport> {
    if (this.running) return this.running
    const run = this.sweepOnce(p.start === true).finally(() => {
      this.running = null
    })
    this.running = run
    return run
  }

  private async sweepOnce(start: boolean): Promise<TurnSweepReport> {
    const { database, keeper } = this.options
    const at = (this.options.now ?? (() => new Date()))()
    const now = at.toISOString()
    const keepDays = await database.keepDays()
    const present = this.options.storePresent()
    // Staging leftovers were never published: at a start they are nobody's.
    if (start && present) await keeper.clearLeftovers().catch(() => undefined)

    // 1. The rows, with their jobs, in one transaction.
    const swept = await database.sweep({ now, keepDays })

    // 2. The bytes, after that commit. A session's folder first: it covers every capture in it.
    let removed = 0
    let waiting = 0
    const settle = async (jobs: readonly TurnRemovalJob[], remove: () => Promise<void>): Promise<void> => {
      try {
        // With no store folder at all the bytes are gone already.
        if (present) await remove()
        for (const job of jobs) await database.finish(job.jobId)
        removed += jobs.length
      } catch {
        for (const job of jobs) await database.fail({ jobId: job.jobId, now }).catch(() => undefined)
        waiting += jobs.length
      }
    }
    const jobs = await database.jobs()
    const stores = new Map<string, { session: string; key: string; jobs: TurnRemovalJob[] }>()
    for (const job of jobs) {
      if (job.captureId === null || job.workTree === null) {
        await settle([job], () => keeper.removeSession(job.sessionId))
        continue
      }
      const key = workTreeKey(job.workTree)
      const store = stores.get(`${job.sessionId}\n${key}`) ?? { session: job.sessionId, key, jobs: [] }
      store.jobs.push(job)
      stores.set(`${job.sessionId}\n${key}`, store)
    }
    for (const store of stores.values()) {
      await settle(store.jobs, () => keeper.removeCaptures({
        session: store.session, key: store.key, captures: store.jobs.map((job) => job.captureId as string)
      }))
    }

    // 3. A published capture no row names, as after a database restore: left until it is older than the
    // keep limit by the time written in its own store, then removed. With Never, or nothing confirmed, it stays.
    let unnamed = 0
    if (present && typeof keepDays === 'number') {
      const named = new Set((await database.named()).map((row) => `${row.sessionId}\n${row.captureId}`))
      const cutoff = at.getTime() - keepDays * DAY_MS
      for (const store of await keeper.inventory()) {
        const old = store.captures.filter((capture) => !named.has(`${store.session}\n${capture.id}`) && capture.endedAt <= cutoff).map((capture) => capture.id)
        if (old.length === 0) continue
        try {
          await keeper.removeCaptures({ session: store.session, key: store.key, captures: old })
          unnamed += old.length
        } catch {
          // Still there, still unnamed: the next sweep finds it again.
        }
      }
    }

    const report = { turns: swept.turns, captures: swept.captures, removed, waiting, unnamed }
    if (report.turns + report.captures + report.removed + report.waiting + report.unnamed > 0) {
      this.options.log?.(`[BMN] turn changes: ${report.turns} turn(s) and ${report.captures} capture(s) past their time, ` +
        `${report.removed + report.unnamed} removal(s) done${report.waiting > 0 ? `, ${report.waiting} waiting` : ''}\n`)
      this.options.changed?.()
    }
    return report
  }
}
