import type { AttentionKind } from './companion'

export interface TelegramQuietHours {
  enabled: boolean
  start: string
  end: string
  allowKinds: AttentionKind[]
  allowSessions: string[]
}

export const DEFAULT_TELEGRAM_QUIET_HOURS: Readonly<TelegramQuietHours> = Object.freeze({
  enabled: false, start: '22:00', end: '07:00', allowKinds: [], allowSessions: []
})

const kinds: readonly string[] = ['permission', 'question', 'handoff', 'review', 'notice']
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const keys = ['enabled', 'start', 'end', 'allowKinds', 'allowSessions']

/** The form and durable settings share one strict shape and the same bounds. */
export function isTelegramQuietHours(value: unknown): value is TelegramQuietHours {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).length === keys.length && Object.keys(v).every(key => keys.includes(key)) &&
    typeof v.enabled === 'boolean' && typeof v.start === 'string' && clock.test(v.start) &&
    typeof v.end === 'string' && clock.test(v.end) && v.start !== v.end &&
    Array.isArray(v.allowKinds) && v.allowKinds.length <= kinds.length &&
    v.allowKinds.every(kind => typeof kind === 'string' && kinds.includes(kind)) &&
    new Set(v.allowKinds).size === v.allowKinds.length &&
    Array.isArray(v.allowSessions) && v.allowSessions.length <= 20 &&
    v.allowSessions.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200 &&
      !/[\p{Cc}\p{Cf}]/u.test(id)) && new Set(v.allowSessions).size === v.allowSessions.length
}

export function quietHoursAllow(quiet: TelegramQuietHours, kind: AttentionKind, sessionId: string): boolean {
  return quiet.allowKinds.includes(kind) || quiet.allowSessions.includes(sessionId)
}

export interface QuietWindow {
  active: boolean
  /** Local start date, zone and configured times; the repeated DST hour is the same window. */
  key: string | null
  endsAt: number | null
  end: string
}

let formatter: Intl.DateTimeFormat | undefined
let formatterZone: string | undefined
const ends = new Map<string, number>()

/** Wall-clock membership, recalculated from the current machine zone unless a test supplies one. */
export function telegramQuietWindow(now: Date, quiet: TelegramQuietHours, timeZone?: string): QuietWindow {
  if (!clock.test(quiet.start) || !clock.test(quiet.end) || quiet.start === quiet.end) throw new Error('Quiet hours require different HH:MM times')
  const off = { active: false, key: null, endsAt: null, end: quiet.end }
  if (!quiet.enabled) return off
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!formatter || formatterZone !== zone) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    formatterZone = zone
  }
  const parts = (at: Date): Record<string, string> => Object.fromEntries(formatter!.formatToParts(at).map(p => [p.type, p.value]))
  const inside = (time: string): boolean => quiet.start < quiet.end
    ? time >= quiet.start && time < quiet.end : time >= quiet.start || time < quiet.end
  const local = parts(now), time = `${local.hour}:${local.minute}`
  if (!inside(time)) return off
  const startDate = new Date(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day)))
  if (quiet.start > quiet.end && time < quiet.end) startDate.setUTCDate(startDate.getUTCDate() - 1)
  const key = `${zone}:${startDate.toISOString().slice(0, 10)}:${quiet.start}-${quiet.end}`
  const offset = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute)) -
    Math.floor(now.getTime() / 60_000) * 60_000
  const cacheKey = `${key}:${offset}`
  let endsAt = ends.get(cacheKey)
  if (endsAt === undefined || endsAt <= now.getTime()) {
    // Find the first real minute outside the window. Skipped/repeated local minutes need no offset guesses.
    let candidate = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000
    const limit = candidate + 48 * 60 * 60_000
    for (; candidate < limit; candidate += 60_000) {
      const next = parts(new Date(candidate))
      if (!inside(`${next.hour}:${next.minute}`)) break
    }
    if (candidate >= limit) throw new Error('Quiet window end is unavailable')
    endsAt = candidate
    if (ends.size >= 8) ends.delete(ends.keys().next().value!)
    ends.set(cacheKey, endsAt)
  }
  return { active: true, key, endsAt, end: quiet.end }
}
