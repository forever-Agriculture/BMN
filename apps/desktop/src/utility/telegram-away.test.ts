// MODULE: telegram-away.test.ts - what counts as the owner's /away or /back from Telegram, and the replies (Story 76.3 AC4)
import { describe, expect, it } from 'vitest'
import { awayTelegramWaiting, type AttentionRecord } from '@bmn/protocol'
import { phoneField } from './quiet-hours-delivery'
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
    expect(awayReplyText({ since, repeated: true, note: 'too-long', now })).toBe('Still away since Wed 22:10. Note not kept: longer than 200 characters. Send /away again with a shorter one.')
    expect(awayReplyText({ since, repeated: false, note: 'refused', now })).toBe('Away since Wed 22:10. Note not kept: it holds control or direction characters. Send /away again without them.')
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

  it('adds the cards that went on without him after what waits, cut first when the reply is too long (Epic 78)', () => {
    const since = at(14, 22, 10)
    const endedAt = at(15, 7, 40)
    expect(backReplyText({ since, endedAt, changed: true, waiting: [], wentOn: ['api: rmdir .. (Closed when the agent ended its turn)'], wentOnMore: 2, now }).split('\n')).toEqual([
      'Back. Away 9 h 30 min, Wed 22:10 – Thu 07:40. Nothing waits on you.', '', 'Went on without you',
      'api: rmdir .. (Closed when the agent ended its turn)', '2 more on the laptop.'])
    expect(backReplyText({ since, endedAt, changed: true, waiting: [], wentOn: [], now })).toBe('Back. Away 9 h 30 min, Wed 22:10 – Thu 07:40. Nothing waits on you.')
    expect(backReplyText({ since, endedAt, changed: true, waiting: [], wentOn: null, now })).toMatch(/Went on without you could not be read; see the laptop\.$/)
    const long = (name: string) => Array.from({ length: 10 }, (_, index) => `${name}${index}: ${'x'.repeat(80)}`)
    const reply = backReplyText({ since, endedAt, changed: true, waiting: long('w'), wentOn: long('g'), now, limit: 1_400 })
    expect(reply.length).toBeLessThanOrEqual(1_400)
    expect(reply.split('\n').filter((line) => line.startsWith('w')).length).toBe(10)
    expect(reply).toMatch(/\n\d+ more on the laptop\.$/)
  })

  it('masks a key and home paths in each field and keeps the whole reply within the digest bound (Story 76.6 AC4)', () => {
    const since = at(14, 22, 10)
    const endedAt = at(15, 7, 40)
    const home = '/home/someone'
    const attention = Array.from({ length: 10 }, (_, index) => ({
      requestId: `r${index}`, sessionId: 's1', state: 'open', openedAt: `2026-10-15T0${index}:00:00.000Z`, kind: 'permission', title: 't',
      prompt: { type: 'permission', command: `cat ${home}/x && echo sk-ant-api03-${'A'.repeat(40)} ${'y'.repeat(400)}` }
    })) as unknown as AttentionRecord[]
    const { lines, more } = awayTelegramWaiting(attention, () => `${home}/Builder`, (value, limit) => phoneField(value, home, limit))
    expect(lines[0]).toMatch(/^~\/Builder: cat ~\/x && echo /)
    expect(lines.join('\n')).not.toContain('sk-ant-api03-AAAA')
    expect(lines.every((line) => line.length <= 120 + 2 + 220)).toBe(true)
    const reply = backReplyText({ since, endedAt, changed: true, waiting: lines, more, now, limit: 1_000 })
    expect(reply.length).toBeLessThanOrEqual(1_000)
    expect(reply).toMatch(/\d+ more on the laptop\.$/)
  })
})
