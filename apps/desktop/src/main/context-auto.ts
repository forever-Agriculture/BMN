// MODULE: context-auto.ts - Story 63.1: BMN runs an app's context test by itself for a new version: one test at a time, one look owed, one later retry, a failure told once
import { ROSTER_APP_NAMES, type ContextLimitApp } from '@bmn/protocol'
import type { ContextAutoPlanEntry, ContextAutoState, ContextTestOutcome } from '../../bin/agents-context.mjs'

/** How long after a test that showed nothing BMN tries that version once more. */
export const CONTEXT_RETRY_AFTER_MS = 10 * 60_000

export interface ContextAutoResult { outcome: ContextTestOutcome; version: string | null; detail: string }

export interface ContextAutoSeams {
  /** What to test now (contextAutoPlan); `versions` are ones the caller has just read, so they are not read twice. */
  plan(versions?: Partial<Record<ContextLimitApp, string | null>>): ContextAutoPlanEntry[]
  /** Starts one app's test and resolves to what it recorded, or null where it could not be run at all. */
  test(harness: ContextLimitApp): Promise<ContextAutoResult | null>
  /** Says a result the owner has to hear of. */
  tell(notice: { title: string; body: string }): void
  /** BMN's own testing as kept on disk: the switch, and what the owner was told. */
  read(): ContextAutoState
  write(change: Partial<ContextAutoState>): void
  /** Runs `run` after `ms`; tests replace the timer. */
  later?(run: () => void, ms: number): void
}

export interface ContextAuto {
  /** Looks for an app version to test and tests it; resolves when nothing is under way any more. Never rejects. */
  trigger(versions?: Partial<Record<ContextLimitApp, string | null>>): Promise<void>
  /** Resolves when the test under way, if any, has ended. */
  settled(): Promise<void>
  view(): { enabled: boolean; running: ContextLimitApp | null }
}

/** "Haiku", "Haiku and Sol", "Haiku, Sol and Opus". */
function named(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`
}

/** What the owner is told when a test BMN ran leaves agents without their own limit. */
export function contextAutoNotice(entry: Pick<ContextAutoPlanEntry, 'harness' | 'agents'>, result: Pick<ContextAutoResult, 'outcome' | 'version'>): { title: string; body: string } {
  const app = ROSTER_APP_NAMES[entry.harness]
  const failed = result.outcome === 'fail'
  const whose = entry.agents.length === 1 ? `${entry.agents[0] as string}'s own context limit does` : `The own context limits of ${named(entry.agents)} do`
  return {
    title: `${app} context test ${failed ? 'failed' : 'showed nothing'}`,
    body: `${whose} not hold on ${app}${result.version === null ? '' : ` ${result.version}`}: the test BMN ran by itself ${failed ? 'failed' : 'showed nothing, twice'}. Rules › Health has the details.`
  }
}

/**
 * The one place BMN starts a context test by itself. A version is started at most once per reason
 * since BMN started, so a test that records nothing, or keeps showing nothing, is not run again and
 * again; two triggers at once share one test, and the later one only makes BMN look once more
 * when that test has ended.
 */
export function createContextAuto(seams: ContextAutoSeams): ContextAuto {
  const started = new Set<string>()
  let running: Promise<void> | null = null
  let owed: { versions?: Partial<Record<ContextLimitApp, string | null>> } | null = null
  let active: ContextLimitApp | null = null
  let retryArmed = false
  const later = seams.later ?? ((run, ms) => { setTimeout(run, ms).unref?.() })

  const heard = (entry: ContextAutoPlanEntry, result: ContextAutoResult): void => {
    const nothing = result.outcome === 'inconclusive' || result.outcome === 'unavailable'
    if (nothing && entry.reason !== 'retry') {
      // Tried once more later, whether or not anything else makes BMN look before then.
      if (!retryArmed) {
        retryArmed = true
        later(() => { void trigger() }, CONTEXT_RETRY_AFTER_MS)
      }
      return
    }
    if (result.outcome === 'pass') return
    const mark = `${result.version ?? entry.version} ${result.outcome}`
    if (seams.read().told[entry.harness] === mark) return
    seams.write({ told: { ...seams.read().told, [entry.harness]: mark } })
    seams.tell(contextAutoNotice(entry, result))
  }

  const sweep = async (versions?: Partial<Record<ContextLimitApp, string | null>>): Promise<void> => {
    let known = versions
    for (;;) {
      for (const entry of seams.plan(known)) {
        const id = `${entry.harness} ${entry.version} ${entry.reason}`
        if (started.has(id)) continue
        started.add(id)
        active = entry.harness
        let result: ContextAutoResult | null
        try {
          result = await seams.test(entry.harness)
        } catch {
          result = null
        }
        active = null
        if (result !== null) heard(entry, result)
      }
      if (owed === null) return
      known = owed.versions
      owed = null
    }
  }

  function trigger(versions?: Partial<Record<ContextLimitApp, string | null>>): Promise<void> {
    if (running !== null) {
      owed = versions === undefined ? {} : { versions }
      return running
    }
    const run = sweep(versions).catch(() => undefined).finally(() => {
      active = null
      if (running === run) running = null
    })
    running = run
    return run
  }

  return {
    trigger,
    settled: () => running ?? Promise.resolve(),
    view: () => ({ enabled: seams.read().enabled, running: active })
  }
}
