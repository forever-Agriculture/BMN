// MODULE: telegram-cue.test.ts - when the gear, Preferences and one desktop notice say Telegram is not delivering
import { describe, expect, it } from 'vitest'
import { telegramNeedsOwner, telegramOwnerCue, type TelegramConnectorState } from './companion'

const now = Date.parse('2026-09-28T12:00:00.000Z')
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16)
const status = (state: TelegramConnectorState, failingSince: string | null = null) =>
  ({ state, detail: state === 'conflict' ? 'Another client is polling this bot token' : 'Telegram rejected the bot token', failingSince })

describe('telegram owner cue', () => {
  it('names a stopped channel at once with the connector\'s own words', () => {
    expect(telegramOwnerCue(true, status('conflict'), now, clock)).toBe('Telegram is not delivering: Another client is polling this bot token')
    expect(telegramOwnerCue(true, status('unauthorized'), now, clock)).toBe('Telegram is not delivering: Telegram rejected the bot token')
    expect(telegramNeedsOwner('conflict')).toBe(true)
    expect(telegramNeedsOwner('unauthorized')).toBe(true)
  })

  it('speaks about a retrying outage only after five minutes without reaching the server', () => {
    const since = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()
    expect(telegramOwnerCue(true, status('backoff', since(4.99)), now, clock)).toBeNull()
    expect(telegramOwnerCue(true, status('backoff', since(5)), now, clock)).toBe('Telegram cannot reach the server since 11:55 · retrying')
    expect(telegramOwnerCue(true, status('backoff', since(90)), now, clock)).toBe('Telegram cannot reach the server since 10:30 · retrying')
    expect(telegramOwnerCue(true, status('backoff', null), now, clock)).toBeNull()
    expect(telegramNeedsOwner('backoff')).toBe(false)
  })

  it('clears once Telegram answers, and says nothing when off, unconfigured or stopped', () => {
    for (const state of ['polling', 'starting', 'disabled', 'unconfigured', 'stopped'] as const) {
      expect(telegramOwnerCue(true, status(state, '2026-09-28T10:00:00.000Z'), now, clock), state).toBeNull()
      expect(telegramNeedsOwner(state)).toBe(false)
    }
    expect(telegramOwnerCue(false, status('conflict'), now, clock)).toBeNull()
    expect(telegramOwnerCue(true, null, now, clock)).toBeNull()
  })

  it('words the time as local HH:MM by default', () => {
    expect(telegramOwnerCue(true, status('backoff', '2026-09-28T11:00:00.000Z'), now)).toMatch(/since \d\d:\d\d · retrying$/)
  })
})
