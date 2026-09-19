// MODULE: voice-suggestions.ts - candidate dictation words from the focused session's names and recent terminal text
import { findFileReferences, normalizeVocabularyWord } from '@bmn/protocol'

export const VOICE_SUGGESTION_ROWS = 120
export const VOICE_SUGGESTION_BYTES = 16 * 1024
export const VOICE_SUGGESTION_LIMIT = 30
const IDENTIFIER_MIN = 3
const IDENTIFIER_MAX = 32

export interface VoiceSuggestionSource {
  workspaceName: string
  sessionName: string
  cwd: string
  /** Logical lines, oldest first, already bounded by `readRecentLines`. */
  lines: readonly string[]
  approved: readonly string[]
}

const URL_RUN = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/giu
const URL = /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./iu
/** A token is letters, digits and the separators identifiers use; anything else ends it. */
const TOKEN_RUN = /[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu
const HEX_HASH = /^[0-9a-f]{7,}$/iu
const NUMERIC = /^[\p{N}._-]+$/u
const SECRET_PREFIX = /^(?:sk-|ghp_|gho_|ghs_|ghu_|github_pat_|AKIA|xox[abprs]-|glpat-|npm_)/u
/** Version tags such as v18 or v1.2.3 name a release, not something the owner says. */
const VERSION = /^v\d[\d.]*$/iu

function trimSeparators(token: string): string {
  return token.replace(/^[._-]+|[._-]+$/gu, '')
}

/** Long runs mixing upper case, lower case and digits with no separators look like keys, not names. */
function looksLikeSecret(token: string): boolean {
  if (SECRET_PREFIX.test(token)) return true
  const bare = token.replace(/[._-]/gu, '')
  if (bare.length < 16) return false
  const classes = [/\p{Lu}/u, /\p{Ll}/u, /\p{N}/u].filter((pattern) => pattern.test(bare)).length
  return classes >= 3 || (bare.length >= 24 && classes >= 2)
}

/**
 * Numbers, hashes, URLs and secret-looking text are never offered, whichever source they come from. A name with
 * spaces is judged word by word for secrets, so a long plain session name still counts as a name.
 */
function excluded(text: string): boolean {
  return NUMERIC.test(text) || HEX_HASH.test(text) || URL.test(text) || text.split(/\s+/u).some(looksLikeSecret)
}

/** CamelCase, snake_case, kebab-case, dotted names and words with digits; plain words are prose. */
function isIdentifier(token: string): boolean {
  const length = [...token].length
  if (length < IDENTIFIER_MIN || length > IDENTIFIER_MAX) return false
  if (excluded(token) || VERSION.test(token)) return false
  // Names start with a letter or underscore; timestamps and measures start with a digit (2026-09-18T20, 00.000Z, 120ms).
  if (!/^[\p{L}_]/u.test(token)) return false
  if (/[_-]/u.test(token)) return true
  if (token.includes('.')) return /\p{L}/u.test(token)
  if (/\p{N}/u.test(token)) return /\p{L}/u.test(token)
  return /\p{Ll}\p{Lu}/u.test(token)
}

function fileName(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  return segments.at(-1) ?? ''
}

/** The part of an xterm buffer the suggester reads. */
export interface RecentTextBuffer {
  readonly length: number
  getLine(index: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined
}

/**
 * The newest logical lines, oldest first, reading newest rows first and stopping at `maxRows` rows or `maxBytes` of
 * row text, whichever comes first. Wrapped rows are joined; a line whose start lies beyond the bound is left out.
 */
export function readRecentLines(buffer: RecentTextBuffer, maxRows: number, maxBytes: number): string[] {
  const encoder = new TextEncoder()
  const lines: string[] = []
  let partial = ''
  let bytes = 0
  const last = buffer.length - 1
  for (let index = last; index >= 0 && last - index < maxRows; index -= 1) {
    const row = buffer.getLine(index)
    if (!row) continue
    const continued = buffer.getLine(index + 1)?.isWrapped === true
    const text = row.translateToString(!continued)
    bytes += encoder.encode(text).length
    if (bytes > maxBytes) break
    partial = text + partial
    if (!row.isWrapped) {
      lines.unshift(partial.trimEnd())
      partial = ''
    }
  }
  return lines
}

/**
 * Candidates the owner may approve, most useful first: the workspace, session and directory names, then file names
 * printed in the terminal, then identifiers, both newest first. Nothing here is stored or sent until approved.
 */
export function suggestVocabulary(source: VoiceSuggestionSource): string[] {
  const seen = new Set(source.approved.map((word) => word.toLowerCase()))
  const suggestions: string[] = []
  const offer = (raw: string): void => {
    if (suggestions.length >= VOICE_SUGGESTION_LIMIT) return
    const normalized = normalizeVocabularyWord(raw)
    if (!normalized.ok) return
    const key = normalized.word.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    suggestions.push(normalized.word)
  }
  for (const name of [source.workspaceName, source.sessionName, fileName(source.cwd)]) {
    if (!excluded(name.trim())) offer(name)
  }
  const lines = [...source.lines].reverse()
  const references: string[] = []
  const identifiers: string[] = []
  for (const line of lines) {
    const withoutUrls = line.replace(URL_RUN, ' ')
    for (const match of findFileReferences(withoutUrls)) {
      const name = trimSeparators(fileName(match.reference.path))
      if (name.length > 0 && !excluded(name)) references.push(name)
    }
    for (const found of withoutUrls.matchAll(TOKEN_RUN)) {
      const token = trimSeparators(found[0])
      if (isIdentifier(token)) identifiers.push(token)
    }
  }
  for (const name of references) offer(name)
  for (const token of identifiers) offer(token)
  return suggestions
}
