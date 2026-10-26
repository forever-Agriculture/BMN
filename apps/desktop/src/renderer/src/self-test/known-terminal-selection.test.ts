// MODULE: known-terminal-selection.test.ts - Fixture targets require exact physical cells and real wrapping
import { describe, expect, it, vi } from 'vitest'
import { knownTerminalTextRange, selectKnownTerminalText } from './known-terminal-selection'

const prefix = 'EXISTING-HANDOFF-PREFIX'
const cell = (chars: string, width = 1) => ({ getChars: () => chars, getWidth: () => width })
const line = (text: string, wrapped = false) => ({ isWrapped: wrapped,
  getCell: (column: number) => cell(text[column] ?? '') })
const buffer = (lines: Array<ReturnType<typeof line> | undefined>) => ({ length: lines.length, getLine: (row: number) => lines[row] })

describe('known terminal fixture selection', () => {
  it('finds its literal after blank row zero', () => {
    expect(knownTerminalTextRange(buffer([line(''), line('prompt '+prefix)]), 40, prefix, 12))
      .toEqual({ column: 7, row: 1, length: 12 })
  })
  it.each(['', 'EXISTING-HAN', 'unrelated text'])('rejects a blank, short or missing target: %s', text => {
    expect(knownTerminalTextRange(buffer([line(text)]), 40, prefix, 12)).toBeUndefined()
  })
  it('joins only a proven soft wrap', () => {
    const first = '12345678'+prefix.slice(0, 8)
    const rest = prefix.slice(8)
    expect(knownTerminalTextRange(buffer([line(first), line(rest, true)]), 16, prefix, 12))
      .toEqual({ column: 8, row: 0, length: 12 })
    expect(knownTerminalTextRange(buffer([line(first), line(rest)]), 16, prefix, 12)).toBeUndefined()
  })
  it('rejects a wrapped continuation without its preceding retained row', () => {
    expect(knownTerminalTextRange(buffer([line(prefix, true)]), 40, prefix, 12)).toBeUndefined()
    expect(knownTerminalTextRange(buffer([undefined, line(prefix, true)]), 40, prefix, 12)).toBeUndefined()
  })
  it('uses columns rather than string offsets after a wide glyph', () => {
    const cells = [cell('界', 2), cell('', 0), ...[...prefix].map(c => cell(c))]
    const wide = { isWrapped: false, getCell: (column: number) => cells[column] ?? cell('') }
    expect(knownTerminalTextRange(buffer([wide]), 40, prefix, 12)).toEqual({ column: 2, row: 0, length: 12 })
  })
  it('rejects a substring inside a combined cell', () => {
    const combined = { isWrapped: false, getCell: (column: number) => column ? cell('') : cell('X'+prefix) }
    expect(knownTerminalTextRange(buffer([combined]), 40, prefix, 12)).toBeUndefined()
  })
  it('chooses the latest literal occurrence, with a bounded cross-row suffix', () => {
    expect(knownTerminalTextRange(buffer([line(prefix), line('again '+prefix)]), 40, prefix, 12))
      .toEqual({ column: 6, row: 1, length: 12 })
  })
  it('selects the verified range and requires exact text', () => {
    const select = vi.fn()
    const terminal = { cols: 40, buffer: { active: buffer([line(''), line(prefix)]) }, select,
      getSelection: () => 'EXISTING-HAN' }
    expect(selectKnownTerminalText(terminal, prefix, 12)).toBe('EXISTING-HAN')
    expect(select).toHaveBeenCalledExactlyOnceWith(0, 1, 12)
    for (const value of ['', 'different']) {
      expect(() => selectKnownTerminalText({ ...terminal, getSelection: () => value }, prefix, 12)).toThrow('did not match')
    }
  })
  it('never selects an arbitrary nonempty row when the prefix is absent', () => {
    const select = vi.fn()
    expect(() => selectKnownTerminalText({ cols: 40, buffer: { active: buffer([line('other')]) }, select,
      getSelection: () => 'other' }, prefix, 12)).toThrow('absent')
    expect(select).not.toHaveBeenCalled()
  })
  it('rejects invalid target contracts', () => {
    for (const length of [0, -1, 1.5, 100]) expect(() => knownTerminalTextRange(buffer([]), 40, prefix, length)).toThrow()
    expect(() => knownTerminalTextRange(buffer([]), 40, '界', 1)).toThrow()
  })
})
