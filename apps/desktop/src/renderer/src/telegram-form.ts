// MODULE: telegram-form.ts - pure parsing and validation of the Telegram preferences form
import type { TelegramSettings } from '@bmn/protocol'

/** Raw field values as the Telegram form in PreferencesDialog holds them. */
export interface TelegramFormFields {
  enabled: boolean
  /** Blank means "no chat chosen"; otherwise must parse as a safe integer (may be negative). */
  allowedChatId: string
  /** Blank means "no user chosen"; otherwise must parse as a safe integer (may be negative). */
  allowedUserId: string
  notifyOn: 'attention' | 'attention-and-exit'
  autoSubmitReplies: boolean
}

export type TelegramFormResult = { ok: true; value: TelegramSettings } | { ok: false; message: string }

type OptionalIntegerResult = { ok: true; value: number | null } | { ok: false; message: string }

const INTEGER_PATTERN = /^-?\d+$/

function parseOptionalInteger(raw: string, name: string): OptionalIntegerResult {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: true, value: null }
  if (!INTEGER_PATTERN.test(trimmed)) return { ok: false, message: `${name} must be an integer or empty` }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value)) return { ok: false, message: `${name} must be an integer or empty` }
  return { ok: true, value }
}

/**
 * Validates the Telegram form the same way the main-process store does (see
 * `validateSettingsSection` in database-companion-store.ts), so a rejection never surprises the
 * owner after they already saw an inline "looks fine" state.
 */
export function parseTelegramForm(fields: TelegramFormFields): TelegramFormResult {
  const chat = parseOptionalInteger(fields.allowedChatId, 'Allowed chat id')
  if (!chat.ok) return { ok: false, message: chat.message }
  const user = parseOptionalInteger(fields.allowedUserId, 'Allowed user id')
  if (!user.ok) return { ok: false, message: user.message }
  if (fields.enabled && chat.value === null) {
    return { ok: false, message: 'Choose the allowed chat before enabling Telegram' }
  }
  return {
    ok: true,
    value: {
      enabled: fields.enabled,
      allowedChatId: chat.value,
      allowedUserId: user.value,
      notifyOn: fields.notifyOn,
      autoSubmitReplies: fields.autoSubmitReplies
    }
  }
}
