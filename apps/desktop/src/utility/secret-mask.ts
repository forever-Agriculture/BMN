// MODULE: secret-mask.ts - hides secret-shaped text on its way off the machine to Telegram (Story 34.2)
import { SECRET_MASK, secretShapeRanges } from '@bmn/protocol'

/** What a hidden secret reads as on a card. */
export { SECRET_MASK }

/** The one line a card ends with when masking hid something in it. */
export const SECRET_FOOTNOTE = 'Some text looked like a secret and was hidden. The full text is on the laptop.'

// The shapes themselves live in `@bmn/protocol` (`secret-ranges.ts`), where the view of a file's difference and
// Quick look find them too. The terminal, saved output, the database, Needs you, Files and handoff drafts never
// see this: only text BMN sends to Telegram is replaced.

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
