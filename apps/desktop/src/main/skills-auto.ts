// MODULE: skills-auto.ts - BMN runs an app's skills folders test by itself after an app update: one test at a time, each version at most twice, a failure told once
import { ROSTER_APP_NAMES, type RosterHarness } from '@bmn/protocol'
import type { SkillsAutoPlanEntry, SkillsOutcome } from '../../bin/agents-skills.mjs'

export interface SkillsAutoResult { outcome: SkillsOutcome; version: string | null; detail: string }

export interface SkillsAutoSeams {
  /** What to test now (skillsAutoPlan); `versions` are ones the caller has just read, so they are not read twice. */
  plan(versions?: Partial<Record<RosterHarness, string | null>>): SkillsAutoPlanEntry[]
  /** Starts one app's folders test and resolves to what it recorded, or null where it could not be run at all. */
  test(harness: RosterHarness): Promise<SkillsAutoResult | null>
  /** Says a result the owner has to hear of. */
  tell(notice: { title: string; body: string }): void
}

export interface SkillsAuto {
  /** Looks for an app version to test and tests it; resolves when nothing is under way any more. Never rejects. */
  trigger(versions?: Partial<Record<RosterHarness, string | null>>): Promise<void>
  /** Resolves when the test under way, if any, has ended. */
  settled(): Promise<void>
  view(): { running: RosterHarness | null }
}

/** What the owner is told when the test BMN ran after an update leaves an app without its skills. */
export function skillsAutoNotice(harness: RosterHarness, result: Pick<SkillsAutoResult, 'outcome' | 'version'>): { title: string; body: string } {
  const app = ROSTER_APP_NAMES[harness]
  const version = result.version === null ? '' : ` ${result.version}`
  return result.outcome === 'fail'
    ? { title: `${app} skills test failed`, body: `${app}${version} no longer reads skills from any folder BMN knows, so BMN installs no skills for it. Rules › Skills has the details.` }
    : { title: `${app} skills test showed nothing`, body: `The test BMN ran by itself on ${app}${version} showed nothing, twice, so BMN installs no skills for it until you run Test… in Rules › Skills.` }
}

/**
 * The one place BMN starts a skills test by itself. The plan names a version at most twice (a
 * first run, and one retry of a run that showed nothing), and an entry is started at most once
 * since BMN started; two triggers at once share one sweep, and the later one only makes BMN look
 * once more when it has ended. The owner hears of a failure, and of a retry that again showed
 * nothing; a pass needs no word, the page shows it.
 */
export function createSkillsAuto(seams: SkillsAutoSeams): SkillsAuto {
  const started = new Set<string>()
  let running: Promise<void> | null = null
  let owed: { versions?: Partial<Record<RosterHarness, string | null>> } | null = null
  let active: RosterHarness | null = null

  const sweep = async (versions?: Partial<Record<RosterHarness, string | null>>): Promise<void> => {
    let known = versions
    for (;;) {
      for (const entry of seams.plan(known)) {
        const id = `${entry.harness} ${entry.version} ${entry.reason}`
        if (started.has(id)) continue
        started.add(id)
        active = entry.harness
        let result: SkillsAutoResult | null
        try {
          result = await seams.test(entry.harness)
        } catch {
          result = null
        }
        active = null
        if (result !== null && (result.outcome === 'fail' || (entry.reason === 'retry' && result.outcome !== 'pass'))) seams.tell(skillsAutoNotice(entry.harness, result))
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
    view: () => ({ running: active })
  }
}
