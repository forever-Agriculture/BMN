import { describe, expect, it } from 'vitest'
import {
  VOICE_VOCABULARY_MAX_PROMPT_BYTES,
  VOICE_VOCABULARY_MAX_WORDS,
  addVocabularyWord,
  normalizeVocabularyWord,
  validateVocabulary,
  vocabularyPrompt,
  vocabularyPromptBytes
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

  it('validates a whole list: strings only, unique case-insensitively, at most 30 words and 223 bytes', () => {
    expect(validateVocabulary(['BMN', ' dev-auto '])).toEqual({ ok: true, words: ['BMN', 'dev-auto'] })
    expect(validateVocabulary([])).toEqual({ ok: true, words: [] })
    expect(validateVocabulary('BMN')).toMatchObject({ ok: false, reason: /list of words/ })
    expect(validateVocabulary(['BMN', 3])).toMatchObject({ ok: false, reason: /list of words/ })
    expect(validateVocabulary(['BMN', 'bmn'])).toMatchObject({ ok: false, reason: /in the list twice/ })
    expect(validateVocabulary(['Олександр', 'олександр'])).toMatchObject({ ok: false, reason: /twice/ })
    const thirty = Array.from({ length: VOICE_VOCABULARY_MAX_WORDS }, (_, index) => `w${index}`)
    expect(validateVocabulary(thirty)).toMatchObject({ ok: true })
    expect(validateVocabulary([...thirty, 'extra'])).toMatchObject({ ok: false, reason: /at most 30 words/ })
    // 223 ASCII bytes fit; one more byte, or the same letters in Cyrillic, do not.
    const fits = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40), 'f'.repeat(13)]
    expect(vocabularyPromptBytes(fits)).toBe(VOICE_VOCABULARY_MAX_PROMPT_BYTES)
    expect(validateVocabulary(fits)).toMatchObject({ ok: true })
    expect(validateVocabulary([...fits.slice(0, -1), 'f'.repeat(14)])).toMatchObject({ ok: false, reason: /223 bytes/ })
    const cyrillic = Array.from({ length: 5 }, (_, index) => 'абвгдежзий'.slice(index, index + 5).repeat(5))
    expect(vocabularyPrompt(cyrillic).length).toBeLessThan(VOICE_VOCABULARY_MAX_PROMPT_BYTES)
    expect(vocabularyPromptBytes(cyrillic)).toBeGreaterThan(VOICE_VOCABULARY_MAX_PROMPT_BYTES)
    expect(validateVocabulary(cyrillic)).toMatchObject({ ok: false, reason: /223 bytes/ })
  })

  it('never quotes a word in a refusal, so the vocabulary stays out of errors and logs', () => {
    const secret = 'PrivateProject'
    const nearFull = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40)]
    const refusals = [
      validateVocabulary([secret, secret.toLowerCase()]),
      validateVocabulary([...nearFull, `${secret}${'x'.repeat(20)}`]),
      validateVocabulary([...Array.from({ length: VOICE_VOCABULARY_MAX_WORDS }, (_, index) => `w${index}`), secret]),
      addVocabularyWord([secret], secret),
      addVocabularyWord(nearFull, `${secret}${'x'.repeat(20)}`),
      addVocabularyWord(Array.from({ length: VOICE_VOCABULARY_MAX_WORDS }, (_, index) => `w${index}`), secret),
      normalizeVocabularyWord(`${secret},x`),
      normalizeVocabularyWord(secret.repeat(3))
    ]
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false)
      if (!refusal.ok) expect(refusal.reason.toLowerCase()).not.toContain(secret.toLowerCase())
    }
  })

  it('joins the prompt with a comma and a space, exactly as shown and sent', () => {
    expect(vocabularyPrompt([])).toBe('')
    expect(vocabularyPrompt(['BMN'])).toBe('BMN')
    expect(vocabularyPrompt(['BMN', 'dev-auto', 'Олександр'])).toBe('BMN, dev-auto, Олександр')
  })

  it('adds one approved word under the same rules and refuses a full list instead of truncating', () => {
    expect(addVocabularyWord([], ' BMN ')).toEqual({ ok: true, words: ['BMN'] })
    expect(addVocabularyWord(['BMN'], 'bmn')).toMatchObject({ ok: false, reason: 'That word is already in the list.' })
    expect(addVocabularyWord(['BMN'], 'a,b')).toMatchObject({ ok: false, reason: /commas/ })
    const full = Array.from({ length: VOICE_VOCABULARY_MAX_WORDS }, (_, index) => `w${index}`)
    expect(addVocabularyWord(full, 'extra')).toMatchObject({ ok: false, reason: /full \(30 words\)/ })
    const nearLimit = Array.from({ length: 11 }, (_, index) => `identifier-name-${index}`)
    expect(vocabularyPromptBytes(nearLimit)).toBe(208)
    expect(addVocabularyWord(nearLimit, 'SessionMgr')).toMatchObject({ ok: true })
    expect(addVocabularyWord(nearLimit, 'SessionManager')).toMatchObject({ ok: false, reason: /vocabulary 224 bytes; Whisper takes at most 223/ })
    // A refusal leaves the caller's list alone.
    expect(nearLimit).toHaveLength(11)
  })
})
