import { describe, expect, it } from 'vitest'
import { DEFAULT_TELEGRAM_QUIET_HOURS, isTelegramQuietHours, quietHoursAllow, telegramQuietWindow,
  type TelegramQuietHours } from './telegram-quiet'

const config = (start = '22:00', end = '07:00'): TelegramQuietHours => ({
  ...DEFAULT_TELEGRAM_QUIET_HOURS, enabled: true, start, end, allowKinds: [], allowSessions: []
})

describe('Telegram quiet settings', () => {
  it('defaults off and requires strict unequal HH:MM times and bounded allow-through', () => {
    expect(DEFAULT_TELEGRAM_QUIET_HOURS.enabled).toBe(false)
    expect(isTelegramQuietHours(config())).toBe(true)
    for (const value of [config('7:00'), config('24:00'), config('22:60'), config('07:00', '07:00'),
      { ...config(), extra: true }, { ...config(), enabled: 'yes' },
      { ...config(), allowKinds: ['permission', 'permission'] }, { ...config(), allowKinds: ['unknown'] },
      { ...config(), allowSessions: ['same', 'same'] }, { ...config(), allowSessions: ['bad\n'] },
      { ...config(), allowSessions: Array.from({ length: 21 }, (_, i) => String(i)) }]) {
      expect(isTelegramQuietHours(value)).toBe(false)
    }
    expect(isTelegramQuietHours({ ...config(), allowSessions: Array.from({ length: 20 }, (_, i) => String(i)) })).toBe(true)
    expect(() => telegramQuietWindow(new Date(), config('07:00', '07:00'), 'UTC')).toThrow('different HH:MM')
  })

  it('allows only the selected kinds or sessions', () => {
    const value = { ...config(), allowKinds: ['permission' as const], allowSessions: ['chosen'] }
    expect(quietHoursAllow(value, 'permission', 'other')).toBe(true)
    expect(quietHoursAllow(value, 'question', 'chosen')).toBe(true)
    expect(quietHoursAllow(value, 'question', 'other')).toBe(false)
  })
})

describe('Telegram local wall-clock window', () => {
  it('handles overnight boundaries and keeps the same key across midnight', () => {
    const before = telegramQuietWindow(new Date('2026-10-07T21:59:00Z'), config(), 'UTC')
    const start = telegramQuietWindow(new Date('2026-10-07T22:00:00Z'), config(), 'UTC')
    const middle = telegramQuietWindow(new Date('2026-10-08T06:59:59Z'), config(), 'UTC')
    expect(before.active).toBe(false)
    expect(start.active).toBe(true)
    expect(middle.key).toBe(start.key)
    expect(middle.endsAt).toBe(Date.parse('2026-10-08T07:00:00Z'))
    expect(telegramQuietWindow(new Date('2026-10-08T07:00:00Z'), config(), 'UTC').active).toBe(false)
  })

  it('handles same-day windows, disabled state and a backwards clock change', () => {
    expect(telegramQuietWindow(new Date('2026-10-07T13:00:00Z'), config('12:00', '14:00'), 'UTC').active).toBe(true)
    expect(telegramQuietWindow(new Date('2026-10-07T14:00:00Z'), config('12:00', '14:00'), 'UTC').active).toBe(false)
    expect(telegramQuietWindow(new Date('2026-10-07T23:00:00Z'), { ...config(), enabled: false }, 'UTC').active).toBe(false)
    const later = telegramQuietWindow(new Date('2026-10-07T13:45:00Z'), config('12:00', '14:00'), 'UTC')
    const earlier = telegramQuietWindow(new Date('2026-10-07T12:15:00Z'), config('12:00', '14:00'), 'UTC')
    expect(earlier.endsAt).toBe(later.endsAt)
  })

  it('follows the spring gap and ends at the first real minute beyond a skipped end time', () => {
    const value = telegramQuietWindow(new Date('2026-03-08T06:45:00Z'), config('01:00', '02:30'), 'America/New_York')
    expect(value.active).toBe(true)
    expect(value.endsAt).toBe(Date.parse('2026-03-08T07:00:00Z'))
    expect(telegramQuietWindow(new Date('2026-03-08T07:00:00Z'), config('01:00', '02:30'), 'America/New_York').active).toBe(false)
  })

  it('gives both repeated hours the same window key but their correct next end', () => {
    const first = telegramQuietWindow(new Date('2026-11-01T05:15:00Z'), config('01:00', '01:30'), 'America/New_York')
    const second = telegramQuietWindow(new Date('2026-11-01T06:15:00Z'), config('01:00', '01:30'), 'America/New_York')
    expect(first.key).toBe(second.key)
    expect(first.endsAt).toBe(Date.parse('2026-11-01T05:30:00Z'))
    expect(second.endsAt).toBe(Date.parse('2026-11-01T06:30:00Z'))
    expect(telegramQuietWindow(new Date('2026-11-01T05:20:00Z'), config('01:00', '01:30'), 'America/New_York').endsAt).toBe(first.endsAt)
  })
})
