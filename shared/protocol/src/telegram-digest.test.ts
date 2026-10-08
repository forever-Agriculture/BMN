import { describe, expect, it } from 'vitest'
import { DEFAULT_TELEGRAM_MORNING_DIGEST, isTelegramMorningDigest } from './telegram-digest'

describe('morning digest settings', () => {
  it('is off by default and accepts each local clock boundary', () => {
    expect(DEFAULT_TELEGRAM_MORNING_DIGEST.enabled).toBe(false)
    for (const time of ['00:00', '08:00', '23:59']) expect(isTelegramMorningDigest({ enabled: true, time })).toBe(true)
  })
  it.each(['8:00', '24:00', '12:60', '12:30:00', '', 'noon'])('rejects invalid local time %s', time => {
    expect(isTelegramMorningDigest({ enabled: false, time })).toBe(false)
  })
  it('rejects missing, unknown and mistyped fields', () => {
    for (const value of [null, [], {}, { enabled: 'yes', time: '08:00' }, { enabled: true, time: '08:00', extra: true }]) {
      expect(isTelegramMorningDigest(value)).toBe(false)
    }
  })
})
