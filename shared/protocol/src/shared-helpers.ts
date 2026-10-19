// MODULE: shared-helpers.ts - the one copy of each small helper the protocol, main, utility and renderer code share: value checks, a clock's two digits and count words (Story 80.15)
// The index re-exports the five used outside the package; isTextOrEmpty and isIso stay internal to it.

/** A plain object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Any string, "" included. */
export const isTextOrEmpty = (value: unknown): value is string => typeof value === 'string'

/** A string that `Date.parse` reads as a time. */
export const isIso = (value: unknown): value is string => isTextOrEmpty(value) && Number.isFinite(Date.parse(value))

/** Two digits, as a clock shows hours and minutes. */
export const pad = (value: number): string => String(value).padStart(2, '0')

/** "1 ask", "2 asks". */
export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** 272000 reads "272,000" (en-US commas; bin's `thousands` and the renderer's roster-staging copy use a space). */
export const thousandsWithCommas = (count: number): string => count.toLocaleString('en-US')

/** "Opus, Fable and Sonnet" (the same as bin's `listed`, which the renderer cannot load). */
export function named(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`
}
