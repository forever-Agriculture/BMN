import { describe, expect, it } from 'vitest'
import { DEFAULT_TELEGRAM_HEALTH_ALERTS, HEALTH_LIMITS, isTelegramHealthAlerts } from './telegram-health'

describe('health alerts settings', () => {
  it('is off by default with no switch-off time', () => {
    expect(DEFAULT_TELEGRAM_HEALTH_ALERTS).toEqual({ enabled: false, offAt: null })
    expect(isTelegramHealthAlerts(DEFAULT_TELEGRAM_HEALTH_ALERTS)).toBe(true)
  })
  it('accepts no time and each local clock boundary', () => {
    for (const offAt of [null, '00:00', '20:00', '23:59']) expect(isTelegramHealthAlerts({ enabled: true, offAt })).toBe(true)
  })
  it.each(['8:00', '24:00', '12:60', '12:30:00', '', 'noon'])('rejects invalid local time %s', offAt => {
    expect(isTelegramHealthAlerts({ enabled: true, offAt })).toBe(false)
  })
  it('rejects missing, unknown and mistyped fields', () => {
    for (const value of [null, [], {}, { enabled: true }, { enabled: 'yes', offAt: null }, { enabled: true, offAt: 2000 },
      { enabled: true, offAt: null, limit: 90 }]) {
      expect(isTelegramHealthAlerts(value)).toBe(false)
    }
  })
  it('keeps the limits the owner confirmed', () => {
    expect(HEALTH_LIMITS).toEqual({
      cpuCritical: 100, cpuHot: 95, cpuHotReadings: 3, nvidiaGpu: 87, integratedGpu: 95, drive: 80,
      cellVoltsMin: 3.0, cellVoltsMax: 4.45, checkEverySeconds: 60, repeatMinutes: 10
    })
  })
})
