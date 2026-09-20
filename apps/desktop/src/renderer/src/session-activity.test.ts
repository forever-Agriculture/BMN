// MODULE: session-activity.test.ts - the working/idle derivation, its start grace, and the title table
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_IDLE_AFTER_MS,
  ACTIVITY_START_GRACE_MS,
  TERMINAL_TITLE_MAX,
  capTitle,
  sameActivities,
  sessionActivities,
  sessionActivity,
  titleWord,
  type ActivityObservation
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
