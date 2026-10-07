import { DEFAULT_TELEGRAM_QUIET_HOURS, DEFAULT_TELEGRAM_MORNING_DIGEST } from '@bmn/protocol'
// MODULE: telegram-form.test.ts - parseTelegramForm validation parity with the main-process store
import { describe, expect, it } from 'vitest'
import { parseTelegramForm, type TelegramFormFields } from './telegram-form'

const fields = (change: Partial<TelegramFormFields>): TelegramFormFields => ({
  enabled: false,
  allowedChatId: '',
  allowedUserId: '',
  notifyOn: 'attention',
  autoSubmitReplies: false,
  answerPermissions: false,
  ...change
})

describe('parseTelegramForm', () => {
  it('uses the store validator for quiet hours', () => {
    const quiet = { ...DEFAULT_TELEGRAM_QUIET_HOURS, enabled: true }
    expect(parseTelegramForm(fields({ quietHours: quiet })).ok).toBe(true)
    for (const bad of [{ ...quiet, start: '7:00' }, { ...quiet, end: '22:00' },
      { ...quiet, allowSessions: Array.from({ length: 21 }, (_, i) => String(i)) }]) {
      expect(parseTelegramForm(fields({ quietHours: bad }))).toEqual({ ok: false,
        message: 'Quiet hours require different HH:MM times and valid allow-through choices' })
    }
  })
  it('treats blank ids as null when disabled', () => {
    const result = parseTelegramForm(fields({}))
    expect(result).toEqual({
      ok: true,
      value: {
        enabled: false,
        allowedChatId: null,
        allowedUserId: null,
        notifyOn: 'attention',
        autoSubmitReplies: false,
        answerPermissions: false,
        quietHours: DEFAULT_TELEGRAM_QUIET_HOURS,
        morningDigest: DEFAULT_TELEGRAM_MORNING_DIGEST
      }
    })
  })

  it('parses negative integer ids', () => {
    const result = parseTelegramForm(fields({ allowedChatId: '-100123', allowedUserId: '-7' }))
    expect(result).toEqual({
      ok: true,
      value: {
        enabled: false,
        allowedChatId: -100123,
        allowedUserId: -7,
        notifyOn: 'attention',
        autoSubmitReplies: false,
        answerPermissions: false,
        quietHours: DEFAULT_TELEGRAM_QUIET_HOURS,
        morningDigest: DEFAULT_TELEGRAM_MORNING_DIGEST
      }
    })
  })

  it('trims surrounding whitespace on a valid integer', () => {
    const result = parseTelegramForm(fields({ allowedChatId: '  42  ' }))
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ allowedChatId: 42 }) })
  })

  it('rejects a non-integer chat id', () => {
    const result = parseTelegramForm(fields({ allowedChatId: 'abc' }))
    expect(result).toEqual({ ok: false, message: 'Allowed chat id must be an integer or empty' })
  })

  it('rejects a decimal user id', () => {
    const result = parseTelegramForm(fields({ allowedUserId: '1.5' }))
    expect(result).toEqual({ ok: false, message: 'Allowed user id must be an integer or empty' })
  })

  it('rejects an unsafe integer', () => {
    const result = parseTelegramForm(fields({ allowedChatId: '99999999999999999999' }))
    expect(result).toEqual({ ok: false, message: 'Allowed chat id must be an integer or empty' })
  })

  it('requires an allowed chat before enabling', () => {
    const result = parseTelegramForm(fields({ enabled: true }))
    expect(result).toEqual({ ok: false, message: 'Choose the allowed chat before enabling Telegram' })
  })

  it('allows enabling once a chat id is set', () => {
    const result = parseTelegramForm(fields({ enabled: true, allowedChatId: '12345' }))
    expect(result).toEqual({
      ok: true,
      value: {
        enabled: true,
        allowedChatId: 12345,
        allowedUserId: null,
        notifyOn: 'attention',
        autoSubmitReplies: false,
        answerPermissions: false,
        quietHours: DEFAULT_TELEGRAM_QUIET_HOURS,
        morningDigest: DEFAULT_TELEGRAM_MORNING_DIGEST
      }
    })
  })

  it('carries notifyOn and autoSubmitReplies through unchanged', () => {
    const result = parseTelegramForm(
      fields({ enabled: true, allowedChatId: '1', notifyOn: 'attention-and-exit', autoSubmitReplies: true })
    )
    expect(result).toEqual({
      ok: true,
      value: {
        enabled: true,
        allowedChatId: 1,
        allowedUserId: null,
        notifyOn: 'attention-and-exit',
        autoSubmitReplies: true,
        answerPermissions: false,
        quietHours: DEFAULT_TELEGRAM_QUIET_HOURS,
        morningDigest: DEFAULT_TELEGRAM_MORNING_DIGEST
      }
    })
  })
})


describe('morning digest form', () => {
  it('keeps the explicit opt-in while Telegram is off, and validates its local time', () => {
    expect(parseTelegramForm(fields({ morningDigest: { enabled: true, time: '09:15' } }))).toMatchObject({ ok: true,
      value: { enabled: false, morningDigest: { enabled: true, time: '09:15' } } })
    for (const time of ['9:15', '24:00', '', '12:60']) expect(parseTelegramForm(fields({ morningDigest: { enabled: true, time } })).ok).toBe(false)
  })
})
