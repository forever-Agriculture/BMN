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

  it('holds a session back per session, so another session waking cannot carry its change through', () => {
    // s1 published at `start`; s2 wakes 300 ms later and publishes at once, which is its first word.
    const published = publishableActivities(
      { s1: idle, s2: working },
      { s1: titled, s2: working },
      { s1: start, s2: start - ACTIVITY_MIN_PUBLISH_MS },
      start + 300
    )

    expect(published.s1).toEqual(idle)
    expect(published.s2).toEqual(working)
  })

  it('lets the held change through on the next tick', () => {
    const published = publishableActivities({ s1: idle }, { s1: titled }, { s1: start }, start + ACTIVITY_MIN_PUBLISH_MS)

    expect(published.s1).toEqual(titled)
  })

  it('publishes a session never published before at once, so the first byte still reads Working', () => {
    const published = publishableActivities({}, { s1: working }, {}, start)

    expect(published.s1).toEqual(working)
  })

  it('never holds back the first byte, because AC1 says Working lands at once', () => {
    const running: SessionActivity = { word: 'Running', working: false, title: null }
    // Published 100 ms ago, well inside the cap, and the first byte has just arrived.
    const published = publishableActivities({ s1: running }, { s1: working }, { s1: start }, start + 100)

    expect(published.s1).toEqual(working)
  })

  it('still holds back a change that is not the start of work', () => {
    const published = publishableActivities({ s1: working }, { s1: idle }, { s1: start }, start + 100)

    expect(published.s1).toEqual(working)
  })

  it('keeps at most two updates per second per session under a title storm', () => {
    const publishedAt: Record<string, number> = {}
    let shown: Record<string, SessionActivity> = {}
    const changes: number[] = []
    // A storm: every 50 ms one session changes title and the other prints, for four seconds.
    for (let step = 0; step < 80; step += 1) {
      const now = start + step * 50
      const next = {
        s1: { word: 'Idle', working: false, title: `build ${step}` } as SessionActivity,
        s2: working
      }
      const published = publishableActivities(shown, next, publishedAt, now)
      for (const [sessionId, activity] of Object.entries(published)) {
        if (sameActivities({ [sessionId]: activity }, { [sessionId]: shown[sessionId] ?? activity }) &&
          shown[sessionId] !== undefined) continue
        publishedAt[sessionId] = now
        if (sessionId === 's1') changes.push(now)
      }
      shown = published
    }

    expect(changes.length).toBeGreaterThan(0)
    for (const [index, at] of changes.entries()) {
      const previous = changes[index - 1]
      if (previous !== undefined) expect(at - previous).toBeGreaterThanOrEqual(ACTIVITY_MIN_PUBLISH_MS)
    }
    // Four seconds of storm, at most two updates a second.
    expect(changes.length).toBeLessThanOrEqual(8)
  })
})
