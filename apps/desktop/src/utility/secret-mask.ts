// MODULE: secret-mask.ts - hides secret-shaped text on its way off the machine to Telegram (Story 34.2)
import { secretShapeRanges } from './secret-ranges'

/** What a hidden secret reads as on a card. */
export const SECRET_MASK = '[secret hidden]'

/** The one line a card ends with when masking hid something in it. */
export const SECRET_FOOTNOTE = 'Some text looked like a secret and was hidden. The full text is on the laptop.'

// The shapes themselves live in `secret-ranges.ts`, where the view of a file's difference finds them too. The
// terminal, saved output, the database, Needs you, Files and handoff drafts never see this: only text BMN
// sends to Telegram is masked.

/** Text with every secret shape replaced by SECRET_MASK; text without one comes back unchanged. */
export function maskSecrets(text: string): string {
  let masked = ''
  let at = 0
  for (const [start, end] of secretShapeRanges(text)) {
    masked += `${text.slice(at, start)}${SECRET_MASK}`
    at = end
  }
  return `${masked}${text.slice(at)}`
}

/**
 * `text` cut to at most `max` characters, moved back to the start of any secret the cut would split (Story 34.2).
 * A preview stored whole on the laptop is masked only later on its way to Telegram, and half a key no longer
 * has a key's shape. The prefix itself is never masked.
 */
export function clipOutsideSecrets(text: string, max: number): string {
  let cut = Math.min(max, text.length)
  // Merged stretches never touch, so moving to the start of one cannot land inside an earlier one.
  for (const [start, end] of secretShapeRanges(text)) {
    if (start < cut && end > cut) cut = start
  }
  return text.slice(0, cut)
}
