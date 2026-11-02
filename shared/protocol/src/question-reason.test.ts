// MODULE: question-reason.test.ts - Story 103.6: the reason words a question starts with, the fixed hand-back, and its secret-free count
import { describe, expect, it } from 'vitest'
import {
  QUESTION_HAND_BACK,
  QUESTION_HAND_BACK_LIMIT,
  QUESTION_REASON_WORDS,
  appendQuestionHandBack,
  parseQuestionHandBacks,
  questionReasonWord,
  questionsNeedingReason
} from './question-reason'

describe('questionReasonWord (D6: the reason is the question\'s first word)', () => {
  it.each([...QUESTION_REASON_WORDS])('reads %s', (word) => {
    expect(questionReasonWord(`${word}: which one?`)).toBe(word)
  })

  it('reads it whatever its case and leading space', () => {
    expect(questionReasonWord('  scope: which one?')).toBe('Scope')
  })

  it.each([
    ['no word', 'Which one?'],
    ['another word', 'Design: which one?'],
    ['the word later on', 'Which one? Scope: all of it'],
    ['the word without its colon', 'Scope which one?'],
    ['the word and nothing else', 'Scope:'],
    ['a word inside another', 'Goal: which one?'],
    ['empty', '']
  ])('refuses %s', (_name, text) => {
    expect(questionReasonWord(text)).toBeNull()
  })

  it('needs the word on every question of a call', () => {
    expect(questionsNeedingReason(['Go: ship it?', 'Money: this much?'])).toBe(false)
    expect(questionsNeedingReason(['Go: ship it?', 'Which colour?'])).toBe(true)
    expect(questionsNeedingReason([])).toBe(false)
  })
})

describe('QUESTION_HAND_BACK (103.6 AC1)', () => {
  it('names every word, says how to go on, and authorizes nothing', () => {
    for (const word of QUESTION_REASON_WORDS) expect(QUESTION_HAND_BACK).toContain(`${word}:`)
    expect(QUESTION_HAND_BACK).toContain('if this is his to decide, start each question with one of these words and ask again')
    expect(QUESTION_HAND_BACK).toContain('otherwise decide on your recommendation within your existing authority and say so in one line')
    expect(QUESTION_HAND_BACK).toContain('this refusal authorizes nothing')
  })
})

describe('the count of hand-backs (103.6 AC7)', () => {
  const ENTRY = { at: '2026-11-03T00:00:00.000Z', sessionId: 's1', conversation: 'c1', agentCli: 'claude', outcome: 'handed-back' as const }

  it('reads a missing or malformed row as empty, and its own output back', () => {
    expect(parseQuestionHandBacks(undefined).entries).toEqual([])
    expect(parseQuestionHandBacks('not json').entries).toEqual([])
    expect(parseQuestionHandBacks('{"version":2,"entries":[]}').entries).toEqual([])
    const written = appendQuestionHandBack(parseQuestionHandBacks(undefined), ENTRY)
    expect(parseQuestionHandBacks(JSON.stringify(written))).toEqual(written)
  })

  it('keeps the newest within its limit and says how many it let go', () => {
    let record = parseQuestionHandBacks(undefined)
    for (let index = 0; index < QUESTION_HAND_BACK_LIMIT + 3; index += 1) record = appendQuestionHandBack(record, { ...ENTRY, sessionId: `s${index}` })
    expect(record.entries).toHaveLength(QUESTION_HAND_BACK_LIMIT)
    expect(record.entries.at(-1)!.sessionId).toBe(`s${QUESTION_HAND_BACK_LIMIT + 2}`)
    expect(record.dropped).toBe(3)
  })

  it('has no field for a question\'s text, and drops one offered', () => {
    const written = appendQuestionHandBack(parseQuestionHandBacks(undefined), { ...ENTRY, text: 'Which colour?' } as never)
    expect(JSON.stringify(written)).not.toContain('colour')
    expect(JSON.stringify(parseQuestionHandBacks(JSON.stringify({ version: 1, dropped: 0, entries: [{ ...ENTRY, text: 'Which colour?' }] })))).not.toContain('colour')
  })
})
