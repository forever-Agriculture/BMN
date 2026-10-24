// MODULE: auto-test-words.test.ts - a row BMN stopped testing says why, in the last try's own words (Story 90.9)
import { describe, expect, it } from 'vitest'
import { stoppedWords } from './auto-test-words'

describe('a test BMN stopped trying', () => {
  it('names why, as the last try that answered said, and only how often where none did', () => {
    expect(stoppedWords({ tries: 3, version: '2.0.29', detail: 'opencode did not answer in a home folder without its sign-in' }))
      .toBe('BMN stopped after 3 tries on 2.0.29: opencode did not answer in a home folder without its sign-in')
    expect(stoppedWords({ tries: 3, version: '2.0.29' })).toBe('BMN stopped after 3 tries on 2.0.29')
  })
})
