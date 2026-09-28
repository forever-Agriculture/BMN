// MODULE: terminal-modes.test.ts - the sequences that bring a rebuilt view up to the program's modes
import { describe, expect, it } from 'vitest'
import { DEFAULT_ON_DECSET_MODES, TRACKED_DECSET_MODES, decsetResetSequence, decsetRestoreSequence } from './terminal'

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

describe('resetting a view’s private modes (Story 32.3)', () => {
  it('returns every tracked mode to a fresh terminal’s state, leaving the cursor where it is', () => {
    expect(decsetResetSequence([])).toBe(
      '\u001b[?1l\u001b[?7h\u001b[?25h\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1004l\u001b[?1006l\u001b[?2004l'
    )
  })

  it('leaves origin mode and the alternate screen only when the program armed them, since both move the cursor', () => {
    const sequence = decsetResetSequence([6, 1000, 1049])
    expect(sequence).toContain('\u001b[?6l')
    expect(sequence).toContain('\u001b[?1049l')
    expect(decsetResetSequence([1000])).not.toContain('\u001b[?6l')
    expect(decsetResetSequence([1000])).not.toContain('\u001b[?1049l')
  })

  it('turns on only what a fresh terminal has on, and is never a full reset', () => {
    const sequence = decsetResetSequence(TRACKED_DECSET_MODES)
    for (const mode of TRACKED_DECSET_MODES) {
      expect(sequence).toContain(`\u001b[?${mode}${DEFAULT_ON_DECSET_MODES.includes(mode) ? 'h' : 'l'}`)
    }
    expect(sequence).not.toContain('\u001bc')
  })
})
