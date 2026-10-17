// MODULE: telegram-away.ts - the owner's /away and /back from Telegram: what counts as one, and the replies (Story 76.3)
import { awayDurationWords, awayMomentWords, awayPeriodWords } from '@bmn/protocol'
import { TELEGRAM_TEXT_LIMIT } from './telegram-cards'
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

/**
 * Story 78.6: any other command in the message's own text. `help` for `/help` (or `/help@ThisBot`), `unknown` for another
 * command addressed to this bot (no suffix, or its own), `elsewhere` for one addressed to another bot (ignored), and null
 * for text that is not a command, which keeps its own routing. `/away` and `/back` are read before this.
 */
export function telegramOtherCommand(reply: Pick<InboundReply, 'text' | 'textSource' | 'file'>, botUsername: () => string | null): 'help' | 'unknown' | 'elsewhere' | null {
  if (reply.textSource !== 'text' || reply.file !== null || typeof reply.text !== 'string') return null
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s|$)/.exec(reply.text.trim())
  if (!match) return null
  const [, word, suffix] = match
  if (suffix !== undefined && suffix.toLowerCase() !== botUsername()?.toLowerCase()) return 'elsewhere'
  return word!.toLowerCase() === 'help' ? 'help' : 'unknown'
}

/** Story 78.6: the whole of what the owner can do here, in one short message. */
export const TELEGRAM_HELP_TEXT = [
  'What you can do here:',
  '• Reply to a card to answer it; the reply goes to that card\'s session.',
  '• Tap a card\'s buttons: an option for a question, Allow once or Deny for a permission. Each answers once.',
  '• /away: say you are away. Agents go on and leave what is yours as cards.',
  '• /back: say you are back and see what waits for you.',
  '• /help: this message.'
].join('\n')

/** The `/away` reply (Fable, Story 76.1): the note is never echoed, only whether it was kept. */
export function awayReplyText(p: { since: string; repeated: boolean; note: 'none' | 'kept' | 'replaced' | 'too-long' | 'refused'; now?: Date }): string {
  const since = awayMomentWords(p.since, p.now)
  if (p.repeated) {
    return `Still away since ${since}.${p.note === 'replaced' ? ' Note replaced.' : p.note === 'too-long' ? ' Note not kept: longer than 200 characters. Send /away again with a shorter one.'
      : p.note === 'refused' ? ' Note not kept: it holds control or direction characters.' : ''}`
  }
  if (p.note === 'too-long') return `Away since ${since}. Note not kept: longer than 200 characters. Send /away again with a shorter one.`
  if (p.note === 'refused') return `Away since ${since}. Note not kept: it holds control or direction characters. Send /away again without them.`
  return `Away since ${since}.${p.note === 'kept' ? ' Note kept on the laptop.' : ''} Agents go on and leave what is yours as cards. Send /back when you return.`
}

/**
 * The `/back` reply (Story 76.6 AC4): back and the period, then Waiting on you as "Session: title" lines already masked and
 * clipped, then "N more on the laptop." when cut; then the period's cards that went on without him (Epic 78, owner
 * 2026-10-17), the same way. Within the digest's size bound, lines are dropped from the end of each list to keep it.
 * No note, no decisions.
 */
export function backReplyText(p: {
  since: string | null; endedAt: string | null; changed: boolean; waiting?: string[] | null; more?: number
  wentOn?: string[] | null; wentOnMore?: number; now?: Date; limit?: number
}): string {
  if (!p.changed || p.since === null || p.endedAt === null) return 'Not away; nothing changed.'
  const head = `Back. Away ${awayDurationWords(p.since, p.endedAt)}, ${awayPeriodWords(p.since, p.endedAt, p.now)}.`
  if (p.waiting === undefined) return head
  const limit = p.limit ?? TELEGRAM_TEXT_LIMIT - 160
  const waiting = p.waiting === null ? null : [...p.waiting]
  let more = p.more ?? 0
  const wentOn = p.wentOn === undefined ? undefined : p.wentOn === null ? null : [...p.wentOn]
  let wentOnMore = p.wentOnMore ?? 0
  const moreWords = (count: number): string[] => count > 0 ? [`${count} more on the laptop.`] : []
  const text = (): string => {
    const parts = [
      waiting === null ? `${head} Waiting on you could not be read; see the laptop.`
        : waiting.length === 0 ? `${head} Nothing waits on you.`
          : [head, 'Waiting on you', ...waiting, ...moreWords(more)].join('\n')
    ]
    if (wentOn === null) parts.push('Went on without you could not be read; see the laptop.')
    else if (wentOn !== undefined && (wentOn.length > 0 || wentOnMore > 0)) parts.push(['Went on without you', ...wentOn, ...moreWords(wentOnMore)].join('\n'))
    return parts.join('\n\n')
  }
  while (text().length > limit) {
    if (wentOn && wentOn.length > 1) { wentOn.pop(); wentOnMore += 1 } else if (waiting && waiting.length > 1) { waiting.pop(); more += 1 } else break
  }
  return text()
}
