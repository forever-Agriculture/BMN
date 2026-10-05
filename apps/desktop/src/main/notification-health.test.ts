// MODULE: notification-health.test.ts - a refused desktop notification is reported, with where to turn it back on
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createNotificationHealth, notificationHealthCue } from './notification-health'

describe('desktop notification health (Story 53.9 AC1)', () => {
  it('reports nothing until a notification is raised, and nothing while they are shown', () => {
    const health = createNotificationHealth()
    expect(notificationHealthCue(health.current(), 'win32')).toBeNull()
    const shown = new EventEmitter()
    health.watch(shown)
    shown.emit('show')
    expect(health.current()).toEqual({ state: 'shown', reason: null })
    expect(notificationHealthCue(health.current(), 'win32')).toBeNull()
  })

  it('says where to turn notifications back on when Windows refuses one, and keeps the system reason bounded', () => {
    const health = createNotificationHealth()
    const refused = new EventEmitter()
    health.watch(refused)
    refused.emit('failed', {}, `Notifications are disabled ${'x'.repeat(400)}`)
    expect(health.current().state).toBe('failed')
    expect(health.current().reason).toHaveLength(200)
    expect(notificationHealthCue(health.current(), 'win32'))
      .toBe('Windows did not show BMN\'s last notification. Turn on notifications for BMN in Settings › System › Notifications.')
    expect(notificationHealthCue(health.current(), 'linux')).toBe('The system did not show BMN\'s last notification. Check that notifications are allowed for BMN.')
  })

  it('follows the latest notification: a later one shown clears the cue, a late event from an earlier one does not', () => {
    const health = createNotificationHealth()
    const first = new EventEmitter(), second = new EventEmitter()
    health.watch(first)
    first.emit('failed', {}, 'disabled')
    health.watch(second)
    second.emit('show')
    first.emit('failed', {}, 'disabled again')
    expect(health.current().state).toBe('shown')
    second.emit('failed', {}, 'disabled')
    expect(health.current().state).toBe('failed')
  })

  it('says honestly when the system has no notifications at all', () => {
    const health = createNotificationHealth()
    health.unsupported()
    expect(notificationHealthCue(health.current(), 'win32')).toBe(
      'This system cannot show desktop notifications. Requests still appear in BMN, and on your phone when Telegram is on.')
  })
})
