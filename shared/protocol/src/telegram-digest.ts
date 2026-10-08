export interface TelegramMorningDigest { enabled: boolean; time: string }
export const DEFAULT_TELEGRAM_MORNING_DIGEST: Readonly<TelegramMorningDigest> = Object.freeze({ enabled: false, time: '08:00' })
export function isTelegramMorningDigest(value: unknown): value is TelegramMorningDigest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 2 && Object.keys(record).every(key => key === 'enabled' || key === 'time') &&
    typeof record.enabled === 'boolean' && typeof record.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(record.time)
}
