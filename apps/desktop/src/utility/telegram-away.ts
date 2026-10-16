// MODULE: telegram-away.ts - the owner's /away and /back from Telegram: what counts as one, and the replies (Story 76.3)
import { awayDurationWords, awayMomentWords, awayPeriodWords } from '@bmn/protocol'
import type { InboundReply } from './telegram-connector'

export type TelegramAwayCommand = { to: 'away'; note: string | null } | { to: 'back' }

/**
 * Only the message's own text, exactly `/away`, `/away <note>` or `/back`, alone or with this bot's own suffix
 * (`/away@ThisBot`), whether or not it replies to a card. A caption, a message with a file, another bot's suffix or any
 * other text keeps its own routing; the bot's name is read only for a suffix. The note is the rest of the text, trimmed;
 * the store refuses one over 200 characters.
 */
export function telegramAwayCommand(reply: Pick<InboundReply, 'text' | 'textSource' | 'file'>, botUsername: () => string | null): TelegramAwayCommand | null {
  if (reply.textSource !== 'text' || reply.file !== null || typeof reply.text !== 'string') return null
  const match = /^\/(away|back)(?:@([A-Za-z0-9_]{1,64}))?(?:[ \t]+([\s\S]*))?$/.exec(reply.text.trim())
  if (!match) return null
  const [, word, suffix, rest] = match
  if (suffix !== undefined && suffix.toLowerCase() !== botUsername()?.toLowerCase()) return null
  const note = rest?.trim() ?? ''
  if (word === 'back') return note === '' ? { to: 'back' } : null
  return { to: 'away', note: note === '' ? null : note }
}

/** The `/away` reply (Fable, Story 76.1): the note is never echoed, only whether it was kept. */
export function awayReplyText(p: { since: string; repeated: boolean; note: 'none' | 'kept' | 'replaced' | 'too-long'; now?: Date }): string {
  const since = awayMomentWords(p.since, p.now)
  if (p.repeated) {
    return `Still away since ${since}.${p.note === 'replaced' ? ' Note replaced.' : p.note === 'too-long' ? ' Note not kept: longer than 200 characters.' : ''}`
  }
  if (p.note === 'too-long') return `Away since ${since}. Note not kept: longer than 200 characters. Send /away again with a shorter one.`
  return `Away since ${since}.${p.note === 'kept' ? ' Note kept on the laptop.' : ''} Agents go on and leave what is yours as cards. Send /back when you return.`
}

/**
 * The `/back` reply: back and the period, then Waiting on you (Story 76.6 AC4 fills the list; until then none is passed and
 * the reply ends with the period).
 */
export function backReplyText(p: { since: string | null; endedAt: string | null; changed: boolean; waiting?: string[] | null; more?: number; now?: Date }): string {
  if (!p.changed || p.since === null || p.endedAt === null) return 'Not away; nothing changed.'
  const head = `Back. Away ${awayDurationWords(p.since, p.endedAt)}, ${awayPeriodWords(p.since, p.endedAt, p.now)}.`
  if (p.waiting === undefined) return head
  if (p.waiting === null) return `${head} Waiting on you could not be read; see the laptop.`
  if (p.waiting.length === 0) return `${head} Nothing waits on you.`
  return [head, 'Waiting on you', ...p.waiting, ...(p.more ? [`${p.more} more on the laptop.`] : [])].join('\n')
}
