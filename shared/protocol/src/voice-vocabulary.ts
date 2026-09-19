// MODULE: voice-vocabulary.ts - owner-approved dictation hints: one validator shared by storage, the panel and transcription

/** Whisper keeps at most n_text_ctx/2 = 224 prompt tokens; these caps were measured against the bundled Small model. */
export const VOICE_VOCABULARY_MAX_WORDS = 30
export const VOICE_VOCABULARY_MAX_WORD_LENGTH = 40
export const VOICE_VOCABULARY_MAX_PROMPT_LENGTH = 400

export type VocabularyWordResult = { ok: true; word: string } | { ok: false; reason: string }
export type VocabularyResult = { ok: true; words: string[] } | { ok: false; reason: string }

const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp},]/u

/** The exact string passed to whisper-cli as `--prompt` and shown in Preferences → Voice. */
export function vocabularyPrompt(words: readonly string[]): string {
  return words.join(', ')
}

/** NFC, trimmed, 1–40 code points, without control or format characters, line breaks or commas. */
export function normalizeVocabularyWord(raw: string): VocabularyWordResult {
  const word = raw.normalize('NFC').trim()
  if (word.length === 0) return { ok: false, reason: 'Enter a word.' }
  if (FORBIDDEN.test(word)) return { ok: false, reason: 'A word cannot contain commas, line breaks or control characters.' }
  if ([...word].length > VOICE_VOCABULARY_MAX_WORD_LENGTH) {
    return { ok: false, reason: `A word is at most ${VOICE_VOCABULARY_MAX_WORD_LENGTH} characters.` }
  }
  return { ok: true, word }
}

function sameWord(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/** Validates a whole list the way storage and transcription accept it; the order is kept. */
export function validateVocabulary(candidate: unknown): VocabularyResult {
  if (!Array.isArray(candidate)) return { ok: false, reason: 'Vocabulary must be a list of words.' }
  const words: string[] = []
  for (const item of candidate) {
    if (typeof item !== 'string') return { ok: false, reason: 'Vocabulary must be a list of words.' }
    const normalized = normalizeVocabularyWord(item)
    if (!normalized.ok) return normalized
    if (words.some((word) => sameWord(word, normalized.word))) {
      return { ok: false, reason: `${normalized.word} is already in the list.` }
    }
    words.push(normalized.word)
  }
  if (words.length > VOICE_VOCABULARY_MAX_WORDS) {
    return { ok: false, reason: `The vocabulary holds at most ${VOICE_VOCABULARY_MAX_WORDS} words.` }
  }
  if (vocabularyPrompt(words).length > VOICE_VOCABULARY_MAX_PROMPT_LENGTH) {
    return { ok: false, reason: `The vocabulary is at most ${VOICE_VOCABULARY_MAX_PROMPT_LENGTH} characters in total.` }
  }
  return { ok: true, words }
}

/**
 * The list with one more approved word, or the reason it was refused: the same rules storage applies, checked
 * before saving so a rejected word stays in its field. A full list refuses instead of truncating.
 */
export function addVocabularyWord(words: readonly string[], raw: string): VocabularyResult {
  const normalized = normalizeVocabularyWord(raw)
  if (!normalized.ok) return normalized
  if (words.some((word) => sameWord(word, normalized.word))) {
    return { ok: false, reason: `${normalized.word} is already in the list.` }
  }
  if (words.length >= VOICE_VOCABULARY_MAX_WORDS) {
    return { ok: false, reason: `The vocabulary is full (${VOICE_VOCABULARY_MAX_WORDS} words). Remove a word first.` }
  }
  const next = [...words, normalized.word]
  const prompt = vocabularyPrompt(next)
  if (prompt.length > VOICE_VOCABULARY_MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      reason: `Adding ${normalized.word} would exceed ${VOICE_VOCABULARY_MAX_PROMPT_LENGTH} characters in total (${prompt.length}). Remove a word first.`
    }
  }
  return { ok: true, words: next }
}
