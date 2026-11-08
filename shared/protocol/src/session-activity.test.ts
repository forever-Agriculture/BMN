// MODULE: session-activity.test.ts - common silence bound, metadata shape and late-read/incarnation races
import { describe, expect, it } from 'vitest'
import { isAppEventMessage } from './companion'
import { ACTIVITY_IDLE_AFTER_MS, ACTIVITY_START_GRACE_MS, isSessionActivityObservation, mergeSessionActivity, sessionActivityState } from './session-activity'

const fresh = { incarnationId: 'current', liveSince: 1000, lastOutputAt: null }
describe('one host activity observation', () => {
  it('expires a silent startup and output on the same bound for every consumer', () => {
    expect(sessionActivityState(fresh, 1000).word).toBe('Running')
    expect(sessionActivityState(fresh, 1000 + ACTIVITY_START_GRACE_MS).word).toBe('Idle')
    const output = { ...fresh, lastOutputAt: 2000 }
    expect(sessionActivityState(output, 2000 + ACTIVITY_IDLE_AFTER_MS - 1).working).toBe(true)
    expect(sessionActivityState(output, 2000 + ACTIVITY_IDLE_AFTER_MS).word).toBe('Idle')
    expect(sessionActivityState(null, 9000).working).toBe(false)
  })
  it('rejects malformed or foreign-shaped activity metadata', () => {
    expect(isSessionActivityObservation(fresh)).toBe(true)
    for (const value of [null, {}, { ...fresh, incarnationId: '' }, { ...fresh, liveSince: Infinity },
      { ...fresh, lastOutputAt: 999 }, { ...fresh, lastOutputAt: NaN }, { ...fresh, extra: true }]) {
      expect(isSessionActivityObservation(value)).toBe(false)
    }
    const event = { kind: 'app-event', topic: 'activity', sessionId: 'session', activity: fresh }
    expect(isAppEventMessage(event)).toBe(true)
    for (const value of [{ ...event, activity: undefined }, { ...event, sessionId: null },
      { ...event, activity: { ...fresh, lastOutputAt: 'recent' } }, { ...event, topic: 'catalogue' }]) {
      expect(isAppEventMessage(value)).toBe(false)
    }
  })
  it('never lets a delayed snapshot move output time back or a replaced incarnation contribute', () => {
    const recent = { ...fresh, lastOutputAt: 2000 }
    expect(mergeSessionActivity(recent, fresh, 'current')).toEqual(recent)
    expect(mergeSessionActivity(recent, { ...fresh, lastOutputAt: 2100 }, 'current')?.lastOutputAt).toBe(2100)
    expect(mergeSessionActivity(recent, { ...fresh, incarnationId: 'old', lastOutputAt: 3000 }, 'current')).toEqual(recent)
    const replacement = { incarnationId: 'next', liveSince: 4000, lastOutputAt: null }
    expect(mergeSessionActivity(recent, replacement, 'next')).toEqual(replacement)
    expect(mergeSessionActivity(null, recent, 'next')).toBeNull()
    expect(mergeSessionActivity(recent, { ...recent, liveSince: 999 }, 'current')).toEqual(recent)
  })
})
