// MODULE: skills-auto.test.ts - BMN tests an app's skills by itself after an update: one test at a time, each entry once, a failure told
import { describe, expect, it } from 'vitest'
import type { RosterHarness } from '@bmn/protocol'
import type { SkillsAutoPlanEntry } from '../../bin/agents-skills.mjs'
import { createSkillsAuto, skillsAutoNotice, type SkillsAutoResult } from './skills-auto'

/** A plan that names what `pending` holds, and a test that records each start and waits for `release`. */
function harness(pending: SkillsAutoPlanEntry[], results: Partial<Record<RosterHarness, SkillsAutoResult | null>>) {
  const started: RosterHarness[] = []
  const notices: { title: string; body: string }[] = []
  let release: () => void = () => {}
  const auto = createSkillsAuto({
    plan: () => pending,
    test: (app) => {
      started.push(app)
      return new Promise((resolve) => { release = () => resolve(results[app] ?? null) })
    },
    tell: (notice) => { notices.push(notice) }
  })
  return { auto, started, notices, release: () => release() }
}

describe('BMN\'s own skills testing after an app update', () => {
  it('tests each planned version once, one at a time, and says which app it is testing meanwhile', async () => {
    const plan: SkillsAutoPlanEntry[] = [{ harness: 'codex', version: '0.162.0', reason: 'untested' }, { harness: 'claude', version: '2.1.301', reason: 'untested' }]
    const run = harness(plan, { codex: { outcome: 'pass', version: '0.162.0', detail: '' }, claude: { outcome: 'pass', version: '2.1.301', detail: '' } })
    const first = run.auto.trigger()
    expect(run.auto.view()).toEqual({ running: 'codex' })
    // A second trigger while one runs shares it.
    const second = run.auto.trigger()
    run.release()
    await Promise.resolve()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(run.auto.view()).toEqual({ running: 'claude' })
    run.release()
    await Promise.all([first, second])
    expect(run.auto.view()).toEqual({ running: null })
    // The owed look found the same entries already started: nothing ran twice.
    expect(run.started).toEqual(['codex', 'claude'])
    await run.auto.trigger()
    expect([run.started, run.notices]).toEqual([['codex', 'claude'], []])
  })

  it('tells the owner of a failure, and of a retry that again showed nothing, never of a first run that showed nothing', async () => {
    const failing = harness([{ harness: 'codex', version: '0.163.0', reason: 'untested' }], { codex: { outcome: 'fail', version: '0.163.0', detail: '' } })
    const failed = failing.auto.trigger()
    failing.release()
    await failed
    expect(failing.notices).toEqual([{ title: 'Codex skills test failed', body: 'Codex 0.163.0 no longer reads skills from any folder BMN knows, so BMN installs no skills for it. Rules › Skills has the details.' }])

    const quiet = harness([{ harness: 'opencode', version: '2.0.30', reason: 'untested' }], { opencode: { outcome: 'inconclusive', version: '2.0.30', detail: '' } })
    const once = quiet.auto.trigger()
    quiet.release()
    await once
    expect(quiet.notices).toEqual([])

    const again = harness([{ harness: 'opencode', version: '2.0.30', reason: 'retry' }], { opencode: { outcome: 'inconclusive', version: '2.0.30', detail: '' } })
    const twice = again.auto.trigger()
    again.release()
    await twice
    expect(again.notices).toEqual([skillsAutoNotice('opencode', { outcome: 'inconclusive', version: '2.0.30' })])
    expect(again.notices[0]?.body).toBe('The test BMN ran by itself on OpenCode 2.0.30 showed nothing, twice, so BMN installs no skills for it until you run Test… in Rules › Skills.')
  })

  it('never rejects, and counts a test that could not run as nothing to say', async () => {
    const auto = createSkillsAuto({
      plan: () => [{ harness: 'codex', version: '0.162.0', reason: 'untested' }],
      test: () => Promise.reject(new Error('the CLI could not start')),
      tell: () => { throw new Error('nothing to tell') }
    })
    await expect(auto.trigger()).resolves.toBeUndefined()
    await expect(auto.settled()).resolves.toBeUndefined()
    expect(auto.view()).toEqual({ running: null })
  })
})
