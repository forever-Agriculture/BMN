// MODULE: telegram-away.test.ts - what counts as the owner's /away or /back from Telegram, and the replies (Story 76.3 AC4)
import { describe, expect, it } from 'vitest'
import { awayReplyText, backReplyText, telegramAwayCommand } from './telegram-away'

const text = (value: string, over: Partial<{ textSource: 'text' | 'caption' | null; file: unknown }> = {}) =>
  ({ text: value, textSource: 'text' as const, file: null, ...over }) as Parameters<typeof telegramAwayCommand>[0]

describe('telegramAwayCommand', () => {
  it('reads /away, /away with a note and /back, alone or with this bot suffix', () => {
    expect(telegramAwayCommand(text('/away'), () => 'BmnBot')).toEqual({ to: 'away', note: null })
    expect(telegramAwayCommand(text('  /away   train to Kyiv  '), () => 'BmnBot')).toEqual({ to: 'away', note: 'train to Kyiv' })
    expect(telegramAwayCommand(text('/away@bmnbot dentist'), () => 'BmnBot')).toEqual({ to: 'away', note: 'dentist' })
    expect(telegramAwayCommand(text('/back'), () => 'BmnBot')).toEqual({ to: 'back' })
    expect(telegramAwayCommand(text('/back@BmnBot'), () => 'BmnBot')).toEqual({ to: 'back' })
  })

  it('leaves everything else to its own routing', () => {
    for (const value of ['/away@OtherBot', '/back@OtherBot', '/awayx', '/back now', 'away', 'I am /away', '/Away']) {
      expect(telegramAwayCommand(text(value), () => 'BmnBot')).toBeNull()
    }
    expect(telegramAwayCommand(text('/away@BmnBot'), () => null)).toBeNull()
    expect(telegramAwayCommand(text('/away', { textSource: 'caption' }), () => 'BmnBot')).toBeNull()
    expect(telegramAwayCommand(text('/away', { file: { kind: 'photo' } }), () => 'BmnBot')).toBeNull()
    expect(telegramAwayCommand(text('/away', { textSource: null }), () => 'BmnBot')).toBeNull()
  })

  it('passes a long note on whole, for the store to refuse', () => {
    const note = 'x'.repeat(250)
    expect(telegramAwayCommand(text(`/away ${note}`), () => 'BmnBot')).toEqual({ to: 'away', note })
  })
})

describe('replies', () => {
  const now = new Date(2026, 9, 15, 9, 0)
  const at = (day: number, hour: number, minute: number): string => new Date(2026, 9, day, hour, minute).toISOString()

  it('never echoes the note', () => {
    const since = at(14, 22, 10)
    expect(awayReplyText({ since, repeated: false, note: 'none', now })).toBe(
      'Away since Wed 22:10. Agents go on and leave what is yours as cards. Send /back when you return.')
    expect(awayReplyText({ since, repeated: false, note: 'kept', now })).toBe(
      'Away since Wed 22:10. Note kept on the laptop. Agents go on and leave what is yours as cards. Send /back when you return.')
    expect(awayReplyText({ since, repeated: false, note: 'too-long', now })).toContain('Note not kept: longer than 200 characters.')
    expect(awayReplyText({ since, repeated: true, note: 'none', now })).toBe('Still away since Wed 22:10.')
    expect(awayReplyText({ since, repeated: true, note: 'replaced', now })).toBe('Still away since Wed 22:10. Note replaced.')
  })

  it('says back with the period, then what waits, cut with a count', () => {
    const since = at(14, 22, 10)
    const endedAt = at(15, 7, 40)
    expect(backReplyText({ since, endedAt, changed: true, now })).toBe('Back. Away 9 h 30 min, Wed 22:10 – Thu 07:40.')
    expect(backReplyText({ since, endedAt, changed: false, now })).toBe('Not away; nothing changed.')
    expect(backReplyText({ since, endedAt, changed: true, waiting: [], now })).toMatch(/Nothing waits on you\.$/)
    expect(backReplyText({ since, endedAt, changed: true, waiting: null, now })).toMatch(/could not be read; see the laptop\.$/)
    expect(backReplyText({ since, endedAt, changed: true, waiting: ['api: Push to origin?'], more: 3, now }).split('\n')).toEqual([
      'Back. Away 9 h 30 min, Wed 22:10 – Thu 07:40.', 'Waiting on you', 'api: Push to origin?', '3 more on the laptop.'])
  })
})
