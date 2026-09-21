// MODULE: terminal-modes.test.ts - the sequences that bring a rebuilt view up to the program's modes
import { describe, expect, it } from 'vitest'
import { TRACKED_DECSET_MODES, decsetRestoreSequence } from './terminal'

describe('restoring a view’s private modes', () => {
  it('writes nothing for a program that set no modes', () => {
    expect(decsetRestoreSequence([])).toBe('')
  })

  it('sets each mode the program had on, in the tracked order', () => {
    expect(decsetRestoreSequence([2004, 1049, 1006])).toBe('\u001b[?1006h\u001b[?1049h\u001b[?2004h')
  })

  it('never turns a mode off: a fresh view has them all off already', () => {
    expect(decsetRestoreSequence(TRACKED_DECSET_MODES)).not.toContain('l')
    expect(decsetRestoreSequence(TRACKED_DECSET_MODES).split('\u001b').length - 1)
      .toBe(TRACKED_DECSET_MODES.length)
  })

  it('ignores a mode outside the tracked set, and repeats none', () => {
    expect(decsetRestoreSequence([47, 2004, 2004])).toBe('\u001b[?2004h')
  })
})
