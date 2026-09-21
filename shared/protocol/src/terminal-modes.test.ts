// MODULE: terminal-modes.test.ts - the sequences that bring a rebuilt view up to the program's modes
import { describe, expect, it } from 'vitest'
import { DEFAULT_ON_DECSET_MODES, TRACKED_DECSET_MODES, decsetRestoreSequence } from './terminal'

describe('restoring a view’s private modes', () => {
  it('writes nothing for a program a fresh view already matches', () => {
    expect(decsetRestoreSequence([])).toBe('')
  })

  it('sets each mode the program turned on, in the tracked order', () => {
    expect(decsetRestoreSequence([2004, 1049, 1006])).toBe('\u001b[?1006h\u001b[?1049h\u001b[?2004h')
  })

  /** Autowrap and the cursor are on in a fresh view, so following the program means turning them off. */
  it('resets the two modes a fresh view has on', () => {
    expect(DEFAULT_ON_DECSET_MODES).toEqual([7, 25])
    expect(decsetRestoreSequence([7, 25])).toBe('\u001b[?7l\u001b[?25l')
    expect(decsetRestoreSequence([25, 2004])).toBe('\u001b[?25l\u001b[?2004h')
  })

  it('writes one sequence per named mode and no more', () => {
    expect(decsetRestoreSequence(TRACKED_DECSET_MODES).split('\u001b').length - 1)
      .toBe(TRACKED_DECSET_MODES.length)
  })

  it('ignores a mode outside the tracked set, and repeats none', () => {
    expect(decsetRestoreSequence([47, 2004, 2004])).toBe('\u001b[?2004h')
  })
})
