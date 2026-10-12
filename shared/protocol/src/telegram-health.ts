/** Health alerts (Epic 62): a watch of the machine's temperatures, battery and mains, off by default. */
export interface TelegramHealthAlerts {
  enabled: boolean
  /** Local HH:MM at which the watch switches itself off, or null for none. */
  offAt: string | null
}
export const DEFAULT_TELEGRAM_HEALTH_ALERTS: Readonly<TelegramHealthAlerts> = Object.freeze({ enabled: false, offAt: null })
export function isTelegramHealthAlerts(value: unknown): value is TelegramHealthAlerts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 2 && Object.keys(record).every(key => key === 'enabled' || key === 'offAt') &&
    typeof record.enabled === 'boolean' &&
    (record.offAt === null || typeof record.offAt === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(record.offAt))
}

/** The fixed limits of the watch, shown in its help and used by its judge. Temperatures in whole °C. */
export const HEALTH_LIMITS = Object.freeze({
  cpuCritical: 100,
  cpuHot: 95,
  cpuHotReadings: 3,
  nvidiaGpu: 87,
  integratedGpu: 95,
  drive: 80,
  cellVoltsMin: 3.0,
  cellVoltsMax: 4.45,
  checkEverySeconds: 60,
  repeatMinutes: 10
})
