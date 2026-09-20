// MODULE: session-activity.test.ts - the working/idle derivation, its start grace, and the title table
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_IDLE_AFTER_MS,
  ACTIVITY_MIN_PUBLISH_MS,
  ACTIVITY_START_GRACE_MS,
  TERMINAL_TITLE_MAX,
  capTitle,
  publishableActivities,
  sameActivities,
  sessionActivities,
  sessionActivity,
  titleWord,
  type ActivityObservation,
  type ActivityPublication,
  type SessionActivity
} from './session-activity'

const start = Date.parse('2026-09-20T12:00:00.000Z')

const observation = (overrides: Partial<ActivityObservation> = {}): ActivityObservation => ({
  incarnationId: 'i1',
  liveSince: start,
  lastOutputAt: start,
  title: null,
  ...overrides
})

describe('session activity', () => {
  it('works while output flows and rests after the hysteresis window', () => {
    const observed = observation({ lastOutputAt: start })
    expect(sessionActivity(observed, start)).toEqual({ word: 'Working', working: true, title: null })
    expect(sessionActivity(observed, start + 1_000)).toEqual({ word: 'Working', working: true, title: null })
    expect(sessionActivity(observed, start + ACTIVITY_IDLE_AFTER_MS - 1).word).toBe('Working')
    expect(sessionActivity(observed, start + ACTIVITY_IDLE_AFTER_MS)).toEqual({ word: 'Idle', working: false, title: null })
    expect(sessionActivity(observed, start + 2_500)).toEqual({ word: 'Idle', working: false, title: null })
  })

  it('reads a silent fresh incarnation as starting, then idle', () => {
    const silent = observation({ lastOutputAt: null })
    expect(sessionActivity(silent, start + 1_000)).toEqual({ word: 'Running', working: false, title: null })
    expect(sessionActivity(silent, start + ACTIVITY_START_GRACE_MS - 1).word).toBe('Running')
    expect(sessionActivity(silent, start + ACTIVITY_START_GRACE_MS)).toEqual({ word: 'Idle', working: false, title: null })
  })

  it('never returns to Running once the incarnation has printed', () => {
    const printed = observation({ liveSince: start, lastOutputAt: start + 1_000 })
    expect(sessionActivity(printed, start + 1_000).word).toBe('Working')
    // Still inside the 3 s start grace, but a byte was seen: the grace is over for this incarnation.
    expect(sessionActivity(printed, start + 2_900).word).toBe('Idle')
    expect(sessionActivity(printed, start + 10_000).word).toBe('Idle')
  })

  it('lets a known title name the resting word only', () => {
    expect(titleWord('✳ refactoring')).toBe('Idle')
    expect(titleWord('  ✳ refactoring  ')).toBe('Idle')
    expect(titleWord('codex - Action Required')).toBe('Action required')
    expect(titleWord('bash')).toBeNull()
    expect(titleWord('an ✳ in the middle')).toBeNull()
    expect(titleWord('')).toBeNull()
    expect(titleWord('   ')).toBeNull()
    expect(titleWord(null)).toBeNull()
    const resting = observation({ lastOutputAt: start, title: 'codex - Action Required' })
    expect(sessionActivity(resting, start + 2_500))
      .toEqual({ word: 'Action required', working: false, title: 'codex - Action Required' })
    // Output is authoritative: the same title changes nothing while bytes still arrive.
    expect(sessionActivity(resting, start + 500))
      .toEqual({ word: 'Working', working: true, title: 'codex - Action Required' })
    expect(sessionActivity(observation({ lastOutputAt: start, title: '✳ x' }), start + 2_500).word).toBe('Idle')
  })

  it('caps a title without rejecting it', () => {
    expect(capTitle('short')).toBe('short')
    expect(capTitle('x'.repeat(TERMINAL_TITLE_MAX + 40))).toHaveLength(TERMINAL_TITLE_MAX)
  })

  it('derives every observed session and recognizes an unchanged tick', () => {
    const observations = new Map([
      ['s1', observation({ lastOutputAt: start })],
      ['s2', observation({ incarnationId: 'i2', lastOutputAt: null })]
    ])
    const before = sessionActivities(observations, start + 1_000)
    expect(before).toEqual({
      s1: { word: 'Working', working: true, title: null },
      s2: { word: 'Running', working: false, title: null }
    })
    expect(sameActivities(before, sessionActivities(observations, start + 1_200))).toBe(true)
    expect(sameActivities(before, sessionActivities(observations, start + 2_500))).toBe(false)
    expect(sameActivities(before, {})).toBe(false)
    expect(sameActivities(before, {
      s1: { word: 'Working', working: true, title: null },
      s3: { word: 'Idle', working: false, title: null }
    })).toBe(false)
    // A new title alone is a change: the row tooltip shows it.
    expect(sameActivities(before, { ...before, s1: { word: 'Working', working: true, title: 'build' } })).toBe(false)
  })
})

describe('the two-updates-per-second cap', () => {
  const working: SessionActivity = { word: 'Working', working: true, title: null }
  const idle: SessionActivity = { word: 'Idle', working: false, title: null }
  const titled: SessionActivity = { word: 'Idle', working: false, title: 'build' }
  const at = (ordinary: number, work = -Infinity): ActivityPublication => ({ ordinary, working: work })

  it('holds a session back per session, so another session waking cannot carry its change through', () => {
    // s1 published 300 ms ago; s2 has published nothing, so its first word lands at once.
    const { activities } = publishableActivities(
      { s1: idle, s2: working },
      { s1: titled, s2: working },
      { s1: at(start) },
      start + 300
    )

    expect(activities.s1).toEqual(idle)
    expect(activities.s2).toEqual(working)
  })

  it('lets the held change through once its second is up', () => {
    const { activities } = publishableActivities(
      { s1: idle }, { s1: titled }, { s1: at(start) }, start + ACTIVITY_MIN_PUBLISH_MS
    )

    expect(activities.s1).toEqual(titled)
  })

  it('publishes a session never published before at once, so the first byte still reads Working', () => {
    const { activities } = publishableActivities({}, { s1: working }, {}, start)

    expect(activities.s1).toEqual(working)
  })

  it('never holds back the first byte, because AC1 says Working lands at once', () => {
    const running: SessionActivity = { word: 'Running', working: false, title: null }
    // An ordinary change 100 ms ago, well inside the cap, and the first byte has just arrived.
    const { activities } = publishableActivities(
      { s1: running }, { s1: working }, { s1: at(start) }, start + 100
    )

    expect(activities.s1).toEqual(working)
  })

  it('still holds back a change that is not the start of work', () => {
    const { activities } = publishableActivities(
      { s1: working }, { s1: idle }, { s1: at(start) }, start + 100
    )

    expect(activities.s1).toEqual(working)
  })

  it('makes a session that restarts inside a second wait its ordinary turn', () => {
    const running: SessionActivity = { word: 'Running', working: false, title: null }
    // Work started 300 ms ago; a crash loop may not redraw the row again straight away.
    const { activities } = publishableActivities(
      { s1: running }, { s1: working }, { s1: { ordinary: start, working: start } }, start + 300
    )

    expect(activities.s1).toEqual(running)
  })

  it('keeps every rolling second to two updates while titles storm and work starts and stops', () => {
    // The published sequence is replayed through the real function, 20 ms at a time, for twelve seconds.
    // Every 700 ms the title changes; output arrives in bursts, so the session also enters and leaves work.
    let shown: Record<string, SessionActivity> = {}
    let windows: Record<string, ActivityPublication> = {}
    const published: number[] = []
    for (let step = 0; step * 20 <= 12_000; step += 1) {
      const now = start + step * 20
      const since = (now - start) % 4_000
      // Output for 400 ms, then 3.6 s of silence: Working, then Idle once the idle window passes.
      const isWorking = since < 400
      const restingWord = since >= 400 + ACTIVITY_IDLE_AFTER_MS
      const derived: SessionActivity = isWorking
        ? { word: 'Working', working: true, title: `build ${Math.floor((now - start) / 700)}` }
        : {
            word: restingWord ? 'Idle' : 'Working',
            working: !restingWord,
            title: `build ${Math.floor((now - start) / 700)}`
          }
      const result = publishableActivities(shown, { s1: derived }, windows, now)
      const after = result.activities.s1
      const first = shown.s1
      if (!first || first.word !== after?.word || first.working !== after.working || first.title !== after.title) {
        published.push(now)
      }
      shown = result.activities
      windows = result.publishedAt
    }

    expect(published.length).toBeGreaterThan(4)
    for (const [index, moment] of published.entries()) {
      const inWindow = published.slice(index).filter((other) => other - moment < 1_000)
      expect(inWindow.length).toBeLessThanOrEqual(2)
    }
  })
})
