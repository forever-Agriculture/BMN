import { describe, expect, it } from 'vitest'
import {
  VOICE_VOCABULARY_MAX_PROMPT_LENGTH,
  VOICE_VOCABULARY_MAX_WORDS,
  addVocabularyWord,
  normalizeVocabularyWord,
  validateVocabulary,
  vocabularyPrompt
} from './voice-vocabulary'

describe('voice vocabulary rules', () => {
  it('normalizes a word to NFC, trims it and bounds it to 40 code points', () => {
    expect(normalizeVocabularyWord('  dev-auto ')).toEqual({ ok: true, word: 'dev-auto' })
    // A decomposed é becomes the composed form, so the same word cannot be stored twice in two spellings.
    expect(normalizeVocabularyWord('café')).toEqual({ ok: true, word: 'café' })
    expect(normalizeVocabularyWord('й'.repeat(40))).toMatchObject({ ok: true })
    expect(normalizeVocabularyWord('й'.repeat(41))).toMatchObject({ ok: false, reason: /at most 40/ })
    expect(normalizeVocabularyWord('   ')).toMatchObject({ ok: false, reason: /Enter a word/ })
    for (const bad of ['a,b', 'line\nbreak', 'tab\there', 'zero​width', 'para graph']) {
      expect(normalizeVocabularyWord(bad), bad).toMatchObject({ ok: false, reason: /commas, line breaks or control/ })
    }
  })

  it('validates a whole list: strings only, unique case-insensitively, at most 30 words and 400 characters', () => {
    expect(validateVocabulary(['BMN', ' dev-auto '])).toEqual({ ok: true, words: ['BMN', 'dev-auto'] })
    expect(validateVocabulary([])).toEqual({ ok: true, words: [] })
    expect(validateVocabulary('BMN')).toMatchObject({ ok: false, reason: /list of words/ })
    expect(validateVocabulary(['BMN', 3])).toMatchObject({ ok: false, reason: /list of words/ })
    expect(validateVocabulary(['BMN', 'bmn'])).toMatchObject({ ok: false, reason: /already in the list/ })
    expect(validateVocabulary(['Олександр', 'олександр'])).toMatchObject({ ok: false, reason: /already/ })
    const thirty = Array.from({ length: VOICE_VOCABULARY_MAX_WORDS }, (_, index) => `w${index}`)
    expect(validateVocabulary(thirty)).toMatchObject({ ok: true })
    expect(validateVocabulary([...thirty, 'extra'])).toMatchObject({ ok: false, reason: /at most 30 words/ })
    const long = Array.from({ length: 20 }, (_, index) => `identifier-number-${index}`)
    expect(vocabularyPrompt(long).length).toBeGreaterThan(VOICE_VOCABULARY_MAX_PROMPT_LENGTH)
    expect(validateVocabulary(long)).toMatchObject({ ok: false, reason: /400 characters/ })
  })

  it('joins the prompt with a comma and a space, exactly as shown and sent', () => {
    expect(vocabularyPrompt([])).toBe('')
    expect(vocabularyPrompt(['BMN'])).toBe('BMN')
    expect(vocabularyPrompt(['BMN', 'dev-auto', 'Олександр'])).toBe('BMN, dev-auto, Олександр')
  })

  it('adds one approved word under the same rules and refuses a full list instead of truncating', () => {
    expect(addVocabularyWord([], ' BMN ')).toEqual({ ok: true, words: ['BMN'] })
    expect(addVocabularyWord(['BMN'], 'bmn')).toMatchObject({ ok: false, reason: /already in the list/ })
    expect(addVocabularyWord(['BMN'], 'a,b')).toMatchObject({ ok: false, reason: /commas/ })
    const full = Array.from({ length: VOICE_VOCABULARY_MAX_WORDS }, (_, index) => `w${index}`)
    expect(addVocabularyWord(full, 'extra')).toMatchObject({ ok: false, reason: /full \(30 words\)/ })
    const nearLimit = Array.from({ length: 19 }, (_, index) => `identifier-name-${index}`)
    expect(vocabularyPrompt(nearLimit).length).toBeLessThanOrEqual(VOICE_VOCABULARY_MAX_PROMPT_LENGTH)
    expect(addVocabularyWord(nearLimit, 'ok')).toMatchObject({ ok: true })
    expect(addVocabularyWord(nearLimit, 'another-identifier-that-is-long')).toMatchObject({ ok: false, reason: /exceed 400 characters/ })
    // A refusal leaves the caller's list alone.
    expect(nearLimit).toHaveLength(19)
  })
})
