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
  /** Logical lines, oldest first; wrapped rows are already joined. */
  lines: readonly string[]
  approved: readonly string[]
}

const URL_RUN = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/giu
/** A token is letters, digits and the separators identifiers use; anything else ends it. */
const TOKEN_RUN = /[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu
const HEX_HASH = /^[0-9a-f]{7,}$/iu
const NUMERIC = /^[\p{N}._-]+$/u
const SECRET_PREFIX = /^(?:sk-|ghp_|gho_|ghs_|ghu_|github_pat_|AKIA|xox[abprs]-|glpat-|npm_)/u

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

/** CamelCase, snake_case, kebab-case, dotted names and words with digits; plain words are prose. */
function isIdentifier(token: string): boolean {
  const length = [...token].length
  if (length < IDENTIFIER_MIN || length > IDENTIFIER_MAX) return false
  if (NUMERIC.test(token) || HEX_HASH.test(token) || looksLikeSecret(token)) return false
  // Timestamps and versions carry a letter or two among digits (2026-09-18T20, 00.000Z): not names.
  if ((token.match(/\p{L}/gu)?.length ?? 0) < 2) return false
  if (/[_-]/u.test(token)) return true
  if (token.includes('.')) return /\p{L}/u.test(token)
  if (/\p{N}/u.test(token)) return /\p{L}/u.test(token)
  return /\p{Ll}\p{Lu}/u.test(token)
}

function fileName(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  return segments.at(-1) ?? ''
}

/** Keeps the last rows within the byte bound, oldest first. */
export function boundSuggestionLines(lines: readonly string[], maxBytes = VOICE_SUGGESTION_BYTES): string[] {
  const encoder = new TextEncoder()
  const kept: string[] = []
  let bytes = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    bytes += encoder.encode(line).length
    if (bytes > maxBytes) break
    kept.unshift(line)
  }
  return kept
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
  for (const name of [source.workspaceName, source.sessionName, fileName(source.cwd)]) offer(name)
  const lines = boundSuggestionLines(source.lines).reverse()
  const references: string[] = []
  const identifiers: string[] = []
  for (const line of lines) {
    const withoutUrls = line.replace(URL_RUN, ' ')
    for (const match of findFileReferences(withoutUrls)) {
      const name = trimSeparators(fileName(match.reference.path))
      if (name.length > 0 && !NUMERIC.test(name) && !HEX_HASH.test(name) && !looksLikeSecret(name)) references.push(name)
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
