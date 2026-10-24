// MODULE: auto-tests.ts - Story 75.8: BMN runs every app test by itself when it is needed: one at a time, at most three tries per version on disk, a failure or a stop told once
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { AUTO_TEST_TRIES, ROSTER_APP_NAMES, named, type AutoTestKind, type AutoTestsView, type RosterHarness } from '@bmn/protocol'

/** How long after a try that settled nothing BMN tries the same test again. */
export const AUTO_TEST_RETRY_MS = 10 * 60_000
/** Tries kept on disk; the oldest go first, and none older than this many days. */
const AUTO_TEST_KEPT = 500
const AUTO_TEST_KEPT_DAYS = 180

export type AutoTestOutcome = 'pass' | 'fail' | 'inconclusive' | 'unavailable'

/**
 * One test BMN should run now: `key` names what the result is bound to besides the version (the rules rendering,
 * the skills, the sources, the research form, the sign-in), so a change there is a new test with tries of its own.
 */
export interface AutoTestEntry {
  kind: AutoTestKind
  harness: RosterHarness
  version: string
  key: string
  reason: string
  /** The agents whose own context limit waits for a context test. */
  agents?: string[]
}

export interface AutoTestResult { outcome: AutoTestOutcome; version: string | null; detail: string }

/**
 * One test's tries as kept on disk: how many were started, when the last began, what it found, and whether the owner
 * heard. `detail` is what the last try that answered said, so a test BMN stopped trying names why (Story 90.9).
 */
export interface AutoTestTry { count: number; at: string; outcome: AutoTestOutcome | null; told?: boolean; detail?: string }

export interface AutoTestsSeams {
  /** Every test needed now, in the order to run them; `versions` are ones the caller has just read. */
  plan(versions?: Partial<Record<RosterHarness, string | null>>): AutoTestEntry[]
  /** Runs one test and resolves to what it recorded, or null where it could not be run at all. */
  test(entry: AutoTestEntry): Promise<AutoTestResult | null>
  /** Says a result the owner has to hear of. */
  tell(notice: { title: string; body: string }): void
  read(): Record<string, AutoTestTry>
  write(tries: Record<string, AutoTestTry>): void
  now?(): number
  /** Runs `run` after `ms`; a later timer replaces an earlier one. */
  later?(run: () => void, ms: number): void
}

export interface AutoTests {
  /** Looks for tests to run and runs them; resolves when nothing is under way any more. Never rejects. */
  trigger(versions?: Partial<Record<RosterHarness, string | null>>): Promise<void>
  /** Resolves when the run under way, if any, has ended. */
  settled(): Promise<void>
  /** What runs now, and which tests of the given installed versions BMN stopped trying. */
  view(versions: Partial<Record<RosterHarness, string | null>>): AutoTestsView
}

/** The identity of one test's tries. */
export function autoTestId(entry: Pick<AutoTestEntry, 'kind' | 'harness' | 'version' | 'key'>): string {
  return `${entry.kind} ${entry.harness} ${entry.version}\n${entry.key}`
}

const TEST_NAMES: Readonly<Record<AutoTestKind, string>> = {
  rules: 'loading test', skills: 'skills test', 'skills-loading': 'skill loading test', tools: 'tools test', context: 'context test', fence: 'fence test'
}
const WHERE: Readonly<Record<AutoTestKind, string>> = {
  rules: 'Integrations › Health', skills: 'Integrations › Skills', 'skills-loading': 'Integrations › Skills', tools: 'Integrations › Tools', context: 'Integrations › Health', fence: 'Agents › Models'
}

/** What the owner is told when a test BMN ran by itself failed, or when BMN stopped trying one; a context test names the agents whose limit waits for it. */
export function autoTestNotice(entry: Pick<AutoTestEntry, 'kind' | 'harness' | 'version' | 'agents'>, result: Pick<AutoTestResult, 'version'> | null, stopped: boolean): { title: string; body: string } {
  const app = ROSTER_APP_NAMES[entry.harness]
  const name = TEST_NAMES[entry.kind]
  const version = result?.version ?? entry.version
  const agents = entry.agents ?? []
  const whose = agents.length === 0 ? ''
    : `${agents.length === 1 ? `${agents[0] as string}'s own context limit does` : `The own context limits of ${named(agents)} do`} not hold on ${app} ${version}: `
  if (stopped) {
    const said = whose === '' ? `BMN ran the ${name} on ${app} ${version} ${AUTO_TEST_TRIES} times and it showed nothing, so it stopped trying.`
      : `${whose}the test BMN ran by itself showed nothing, ${AUTO_TEST_TRIES} times, so it stopped trying.`
    return { title: `${app} ${name} stopped`, body: `${said} ${WHERE[entry.kind]} has Test again.` }
  }
  const said = whose === '' ? `The ${name} BMN ran by itself on ${app} ${version} failed.` : `${whose}the test BMN ran by itself failed.`
  return { title: `${app} ${name} failed`, body: `${said} ${WHERE[entry.kind]} has the details and Test again.` }
}

/** The tries kept, the oldest gone first, none older than AUTO_TEST_KEPT_DAYS. */
export function keptTries(tries: Record<string, AutoTestTry>, now: number): Record<string, AutoTestTry> {
  const fresh = Object.entries(tries).filter(([, entry]) => now - Date.parse(entry.at) < AUTO_TEST_KEPT_DAYS * 86_400_000)
  fresh.sort(([, a], [, b]) => Date.parse(a.at) - Date.parse(b.at))
  return Object.fromEntries(fresh.slice(-AUTO_TEST_KEPT))
}

/**
 * The one place BMN starts an app test by itself. Each test, bound to its version and key, is started at most
 * AUTO_TEST_TRIES times, counted on disk before it starts, so a restart or a crash does not start it again and
 * again; a try that settled nothing is followed by the next no sooner than AUTO_TEST_RETRY_MS later. A pass or a
 * failure settles the test. The owner hears of a failure and of a test BMN stopped trying, once each; a pass needs
 * no word, the page shows it. Two triggers at once share one run, and the later only makes BMN look once more.
 * A test BMN stopped trying shows as stopped until a plan no longer names it.
 */
export function createAutoTests(seams: AutoTestsSeams): AutoTests {
  let running: Promise<void> | null = null
  let owed: { versions?: Partial<Record<RosterHarness, string | null>> } | null = null
  let active: AutoTestEntry | null = null
  const now = seams.now ?? Date.now
  const later = seams.later ?? ((run, ms) => { setTimeout(run, ms).unref?.() })
  let retryAt: number | null = null
  // The tests the last plan named: a test BMN stopped trying that the plan no longer names has been settled since, by the owner's Test again or a change.
  let needed: Set<string> | null = null

  const keep = (id: string, entry: AutoTestTry): void => {
    seams.write(keptTries({ ...seams.read(), [id]: entry }, now()))
  }
  const armRetry = (ms: number): void => {
    const at = now() + ms
    if (retryAt !== null && retryAt <= at && retryAt > now()) return
    retryAt = at
    later(() => {
      retryAt = null
      void trigger()
    }, ms)
  }

  const sweep = async (versions?: Partial<Record<RosterHarness, string | null>>): Promise<void> => {
    let known = versions
    for (;;) {
      let entries: AutoTestEntry[]
      try {
        entries = seams.plan(known)
        needed = new Set(entries.map(autoTestId))
      } catch {
        entries = []
      }
      for (const entry of entries) {
        const id = autoTestId(entry)
        const tries = seams.read()[id]
        // Settled or tried enough: a plan that names it again starts nothing, so no test can repeat without bound.
        if (tries !== undefined && (tries.count >= AUTO_TEST_TRIES || tries.outcome === 'pass' || tries.outcome === 'fail')) continue
        if (tries !== undefined) {
          const wait = Date.parse(tries.at) + AUTO_TEST_RETRY_MS - now()
          if (wait > 0) {
            armRetry(wait)
            continue
          }
        }
        const count = (tries?.count ?? 0) + 1
        keep(id, { count, at: new Date(now()).toISOString(), outcome: null, ...(tries?.detail === undefined ? {} : { detail: tries.detail }) })
        active = entry
        let result: AutoTestResult | null
        try {
          result = await seams.test(entry)
        } catch {
          result = null
        }
        active = null
        const settled = result !== null && (result.outcome === 'pass' || result.outcome === 'fail')
        const stopped = !settled && count >= AUTO_TEST_TRIES
        const told = result?.outcome === 'fail' || stopped
        keep(id, { ...(seams.read()[id] ?? { count, at: new Date(now()).toISOString() }), outcome: result?.outcome ?? null, ...(result?.detail ? { detail: result.detail } : {}), ...(told ? { told: true } : {}) })
        if (told) seams.tell(autoTestNotice(entry, result, stopped))
        else if (!settled) armRetry(AUTO_TEST_RETRY_MS)
      }
      if (owed === null) return
      known = owed.versions
      owed = null
    }
  }

  function trigger(versions?: Partial<Record<RosterHarness, string | null>>): Promise<void> {
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
    view: (versions) => {
      const stopped: AutoTestsView['stopped'] = []
      for (const [id, tries] of Object.entries(seams.read())) {
        if (tries.count < AUTO_TEST_TRIES || tries.outcome === 'pass' || tries.outcome === 'fail' || (needed !== null && !needed.has(id))) continue
        const [kind, harness, version] = id.slice(0, id.indexOf('\n')).split(' ') as [AutoTestKind, RosterHarness, string]
        if (versions[harness] !== version || stopped.some((entry) => entry.kind === kind && entry.harness === harness)) continue
        stopped.push({ kind, harness, version, tries: tries.count, at: tries.at, ...(tries.detail === undefined ? {} : { detail: tries.detail }) })
      }
      return { running: active === null ? null : { kind: active.kind, harness: active.harness }, stopped }
    }
  }
}

/**
 * When the app's sign-in last changed, as its own credential file's time, or `none`; never its contents. A test that
 * sends a prompt binds its tries to it, so signing in again gives a test that showed nothing new tries.
 */
export function signInMark(harness: RosterHarness, environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME ?? ''
  const file = harness === 'codex' ? join(environment.CODEX_HOME || join(home, '.codex'), 'auth.json')
    : harness === 'claude' ? join(environment.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json')
      : join(environment.XDG_DATA_HOME || join(home, '.local/share'), 'opencode/auth.json')
  try {
    return `signed-in ${Math.trunc(statSync(file).mtimeMs)}`
  } catch {
    return 'none'
  }
}
