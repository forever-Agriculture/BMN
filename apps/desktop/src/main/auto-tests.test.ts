// MODULE: auto-tests.test.ts - Story 75.8: the one place BMN starts app tests by itself: tries on disk, their bound and spacing, one at a time, a failure or a stop told once
import { describe, expect, it } from 'vitest'
import { AUTO_TEST_RETRY_MS, autoTestId, autoTestNotice, createAutoTests, keptTries, signInMark, type AutoTestEntry, type AutoTestResult, type AutoTestTry } from './auto-tests'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const START = Date.parse('2026-10-16T12:00:00.000Z')
const entry = (over: Partial<AutoTestEntry> = {}): AutoTestEntry => ({ kind: 'tools', harness: 'codex', version: '0.162.1', key: '', reason: 'untested', ...over })

/** A machine with a clock, a disk BMN keeps its tries on, and apps whose tests answer as told. */
function machine(answers: Array<AutoTestResult['outcome'] | null>, plan: () => AutoTestEntry[] = () => [entry()]) {
  let disk: Record<string, AutoTestTry> = {}
  const clock = { now: START }
  const started: AutoTestEntry[] = []
  const told: { title: string; body: string }[] = []
  const timers: { run(): void; ms: number }[] = []
  const start = () => createAutoTests({
    plan,
    test: async (one) => {
      started.push(one)
      const outcome = answers.shift() ?? null
      return outcome === null ? null : { outcome, version: one.version, detail: 'synthetic' }
    },
    tell: (notice) => { told.push(notice) },
    read: () => disk,
    write: (tries) => { disk = JSON.parse(JSON.stringify(tries)) as Record<string, AutoTestTry> },
    now: () => clock.now,
    later: (run, ms) => { timers.push({ run, ms }) }
  })
  return { start, clock, started, told, timers, disk: () => disk }
}

describe('BMN runs its own app tests (Story 75.8)', () => {
  it('counts a try on disk before it starts, so a crash during it still counts', async () => {
    const written: Record<string, AutoTestTry>[] = []
    let seen: Record<string, AutoTestTry> | null = null
    const runner = createAutoTests({
      plan: () => [entry()],
      test: async () => { seen = written.at(-1) ?? null; return null },
      tell: () => {}, read: () => written.at(-1) ?? {}, write: (tries) => { written.push(tries) }, now: () => START, later: () => {}
    })
    await runner.trigger()
    expect(seen).toEqual({ [autoTestId(entry())]: { count: 1, at: new Date(START).toISOString(), outcome: null } })
    expect(written).toHaveLength(2)
  })

  it('tries a test that showed nothing at most three times, ten minutes apart, across restarts, and tells the stop once', async () => {
    const world = machine(['inconclusive', 'unavailable', null, 'pass'])
    const first = world.start()
    await first.trigger()
    expect(world.started).toHaveLength(1)
    expect(world.timers.map((timer) => timer.ms)).toEqual([AUTO_TEST_RETRY_MS])
    // A look before the ten minutes are up starts nothing, and arms nothing sooner.
    world.clock.now += AUTO_TEST_RETRY_MS - 1000
    await first.trigger()
    expect(world.started).toHaveLength(1)
    world.clock.now += 1000
    world.timers[0]!.run()
    await first.settled()
    expect([world.started.length, world.told]).toEqual([2, []])
    // BMN restarts: the count on disk stands; the third try, cut short, is the last.
    world.clock.now += AUTO_TEST_RETRY_MS
    const next = world.start()
    await next.trigger()
    expect(world.started).toHaveLength(3)
    expect(world.told).toEqual([{ title: 'Codex tools test stopped', body: 'BMN ran the tools test on Codex 0.162.1 3 times and it showed nothing, so it stopped trying. Rules › Tools has Test again.' }])
    expect(world.disk()[autoTestId(entry())]).toEqual({ count: 3, at: new Date(world.clock.now).toISOString(), outcome: null, told: true })
    expect(next.view({ codex: '0.162.1' })).toEqual({ running: null, stopped: [{ kind: 'tools', harness: 'codex', version: '0.162.1', tries: 3, at: new Date(world.clock.now).toISOString() }] })
    // No fourth try, however late; nothing more said.
    world.clock.now += 7 * 86_400_000
    await next.trigger()
    await world.start().trigger()
    expect([world.started.length, world.told.length]).toEqual([3, 1])
    // Another version is another test, with tries of its own; the stop of the old one is not shown for it.
    expect(next.view({ codex: '0.162.2' }).stopped).toEqual([])
  })

  it('settles on a pass or a failure: no retry, a failure told once, a pass told never', async () => {
    const passing = machine(['pass'])
    await passing.start().trigger()
    await passing.start().trigger()
    expect([passing.started.length, passing.told, passing.timers]).toEqual([1, [], []])

    const failing = machine(['fail'])
    await failing.start().trigger()
    failing.clock.now += AUTO_TEST_RETRY_MS * 2
    await failing.start().trigger()
    expect([failing.started.length, failing.timers]).toEqual([1, []])
    expect(failing.told).toEqual([{ title: 'Codex tools test failed', body: 'The tools test BMN ran by itself on Codex 0.162.1 failed. Rules › Tools has the details and Test again.' }])
    // A failure is not a stop: the row says what failed, and offers Test again from that.
    expect(failing.start().view({ codex: '0.162.1' }).stopped).toEqual([])
  })

  it('binds tries to the key: a change of rules, skills, sources or sign-in is a new test', async () => {
    let key = 'rendered-1 signed-in 1'
    const world = machine(['inconclusive', 'inconclusive', 'inconclusive', 'pass'], () => [entry({ kind: 'rules', key })])
    const runner = world.start()
    for (let i = 0; i < 3; i += 1) {
      await runner.trigger()
      world.clock.now += AUTO_TEST_RETRY_MS
    }
    await runner.trigger()
    expect(world.started).toHaveLength(3)
    key = 'rendered-1 signed-in 2'
    await runner.trigger()
    expect(world.started.map((one) => one.key)).toEqual(['rendered-1 signed-in 1', 'rendered-1 signed-in 1', 'rendered-1 signed-in 1', 'rendered-1 signed-in 2'])
    // The plan no longer names the stopped one: it is not shown as stopped any more.
    expect(runner.view({ codex: '0.162.1' }).stopped).toEqual([])
  })

  it('runs one test at a time, in the plan\'s order, and a trigger during a run makes BMN look once more', async () => {
    const releases: Array<() => void> = []
    let planned = [entry({ kind: 'tools' }), entry({ kind: 'skills' })]
    const started: string[] = []
    let disk: Record<string, AutoTestTry> = {}
    const runner = createAutoTests({
      plan: () => planned,
      test: (one) => new Promise((resolve) => {
        started.push(one.kind)
        releases.push(() => resolve({ outcome: 'pass', version: one.version, detail: '' }))
      }),
      tell: () => {}, read: () => disk, write: (tries) => { disk = tries }, now: () => START, later: () => {}
    })
    const first = runner.trigger()
    expect([started, runner.view({ codex: '0.162.1' }).running]).toEqual([['tools'], { kind: 'tools', harness: 'codex' }])
    const second = runner.trigger()
    planned = [...planned, entry({ kind: 'rules' })]
    releases.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['tools', 'skills'])
    releases.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The look owed by the second trigger finds the new test.
    expect(started).toEqual(['tools', 'skills', 'rules'])
    releases.shift()!()
    await Promise.all([first, second])
    expect(runner.view({ codex: '0.162.1' }).running).toBeNull()
  })

  it('never rejects: a plan or a test that throws counts as a try that showed nothing', async () => {
    let disk: Record<string, AutoTestTry> = {}
    const runner = createAutoTests({
      plan: () => [entry()], test: async () => { throw new Error('boom') }, tell: () => {}, read: () => disk, write: (tries) => { disk = tries }, now: () => START, later: () => {}
    })
    await expect(runner.trigger()).resolves.toBeUndefined()
    expect(disk[autoTestId(entry())]).toMatchObject({ count: 1, outcome: null })
    const broken = createAutoTests({ plan: () => { throw new Error('unreadable') }, test: async () => null, tell: () => {}, read: () => ({}), write: () => {}, now: () => START })
    await expect(broken.trigger()).resolves.toBeUndefined()
  })

  it('keeps at most 500 tries, none older than 180 days', () => {
    const now = START
    const tries = Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`t${i}`, { count: 1, at: new Date(now - i * 60_000).toISOString(), outcome: 'pass' as const }]))
    tries.old = { count: 1, at: new Date(now - 181 * 86_400_000).toISOString(), outcome: 'pass' }
    const kept = keptTries(tries, now)
    expect(Object.keys(kept)).toHaveLength(500)
    expect(kept.t0).toBeDefined()
    expect(kept.t519).toBeUndefined()
    expect(kept.old).toBeUndefined()
  })

  it('names the agents a context test holds up, and the page that has Test again', () => {
    expect(autoTestNotice({ kind: 'context', harness: 'claude', version: '2.1.296', agents: ['Opus', 'Haiku'] }, null, false)).toEqual({
      title: 'Claude Code context test failed',
      body: 'The own context limits of Opus and Haiku do not hold on Claude Code 2.1.296: the test BMN ran by itself failed. Rules › Health has the details and Test again.'
    })
    expect(autoTestNotice({ kind: 'fence', harness: 'opencode', version: '1.18.32' }, null, true).body).toBe('BMN ran the fence test on OpenCode 1.18.32 3 times and it showed nothing, so it stopped trying. Team › Models has Test again.')
    expect(autoTestNotice({ kind: 'skills-loading', harness: 'codex', version: '0.162.1' }, { version: '0.162.2' }, false).body).toBe('The skill loading test BMN ran by itself on Codex 0.162.2 failed. Rules › Skills has the details and Test again.')
  })

  it('marks a sign-in by its credential file\'s time alone, never its contents', () => {
    const home = mkdtempSync(join(tmpdir(), 'bmn-auto-tests-'))
    try {
      expect(signInMark('codex', { HOME: home })).toBe('none')
      mkdirSync(join(home, '.codex'))
      writeFileSync(join(home, '.codex/auth.json'), '{"synthetic":true}')
      utimesSync(join(home, '.codex/auth.json'), 1_700_000_000, 1_700_000_000)
      expect(signInMark('codex', { HOME: home })).toBe('signed-in 1700000000000')
      expect(signInMark('codex', { HOME: home, CODEX_HOME: join(home, 'elsewhere') })).toBe('none')
      mkdirSync(join(home, '.claude'))
      writeFileSync(join(home, '.claude/.credentials.json'), '{}')
      expect(signInMark('claude', { HOME: home })).toMatch(/^signed-in \d+$/)
      expect(signInMark('opencode', { HOME: home })).toBe('none')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
