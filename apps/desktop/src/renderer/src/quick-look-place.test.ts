// MODULE: quick-look-place.test.ts - find, go to line, the trail, the place kept per root and Esc's order (Story 67.2)
import { afterEach, describe, expect, it } from 'vitest'
import { findCountLabel, findMatches, matchAt, stepMatch } from './quick-look-find'
import {
  EMPTY_TRAIL,
  TRAIL_MAX,
  canGoBack,
  canGoForward,
  escapeStep,
  forgetPlaces,
  parseGoToLine,
  recalledPlace,
  rememberPlace,
  trailStep,
  trailVisit,
  type Trail
} from './quick-look-place'

describe('find in the file', () => {
  it('finds literal text in either case unless the case switch is on, with offsets of the text itself', () => {
    const text = 'const Value = value + VALUE // value.*'
    expect(findMatches(text, 'value', false).map((match) => text.slice(match.from, match.to))).toEqual(['Value', 'value', 'VALUE', 'value'])
    expect(findMatches(text, 'value', true)).toEqual([{ from: 14, to: 19 }, { from: 31, to: 36 }])
    expect(findMatches(text, '.*', false)).toEqual([{ from: 36, to: 38 }])
    expect(findMatches(text, '', false)).toEqual([])
    expect(findMatches('aaaa', 'aa', false)).toHaveLength(2)
  })

  it('counts as "3 of 12" and wraps around both ends', () => {
    const matches = findMatches('x x x', 'x', false)
    expect(findCountLabel(matches, 0, 'x')).toBe('1 of 3')
    expect(findCountLabel([], -1, 'x')).toBe('No matches')
    expect(findCountLabel([], -1, '')).toBe('')
    expect(stepMatch(matches, 2, 1)).toBe(0)
    expect(stepMatch(matches, 0, -1)).toBe(2)
    expect(stepMatch(matches, -1, -1)).toBe(2)
    expect(stepMatch([], 0, 1)).toBe(-1)
    expect(matchAt(matches, 3)).toBe(2)
    expect(matchAt(matches, 5)).toBe(0)
    expect(findCountLabel(findMatches('xxxx', 'x', false, 3), 0, 'x', 3)).toBe('1 of 3+')
  })
})

describe('go to line', () => {
  it('takes a line or a line and a column, clamped to the file', () => {
    expect(parseGoToLine('44', 100)).toEqual({ line: 44, column: null })
    expect(parseGoToLine(' 44:7 ', 100)).toEqual({ line: 44, column: 7 })
    expect(parseGoToLine('400', 100)).toEqual({ line: 100, column: null })
    expect(parseGoToLine('0', 100)).toBeNull()
    expect(parseGoToLine('abc', 100)).toBeNull()
    expect(parseGoToLine('4:', 100)).toBeNull()
    expect(parseGoToLine('', 100)).toBeNull()
  })
})

describe('the trail back and forward', () => {
  const visit = (trail: Trail, path: string, line: number | null = null, here: number | null = null): Trail =>
    trailVisit(trail, { path, line, column: null }, here)

  it('returns to the previous file at the top line he left it, keeps the line he came for, and goes forward again', () => {
    let trail = visit(EMPTY_TRAIL, '/p/a.ts')
    expect(canGoBack(trail)).toBe(false)
    trail = visit(trail, '/p/b.ts', 42, 17)
    expect(canGoBack(trail)).toBe(true)
    const back = trailStep(trail, -1, 50)!
    expect(back.entry).toEqual({ path: '/p/a.ts', line: null, column: null, topLine: 17 })
    expect(canGoForward(back.trail)).toBe(true)
    const forward = trailStep(back.trail, 1, 18)!
    expect(forward.entry).toEqual({ path: '/p/b.ts', line: 42, column: null, topLine: 50 })
    expect(trailStep(forward.trail, 1, null)).toBeNull()
    expect(trailStep(EMPTY_TRAIL, -1, null)).toBeNull()
  })

  it('drops what was forward when a new file is opened, adds nothing for the same place, and keeps the newest files', () => {
    let trail = visit(visit(visit(EMPTY_TRAIL, '/a'), '/b'), '/c')
    trail = trailStep(trailStep(trail, -1, null)!.trail, -1, null)!.trail
    trail = visit(trail, '/d')
    expect(trail.entries.map((entry) => entry.path)).toEqual(['/a', '/d'])
    expect(visit(trail, '/d')).toBe(trail)
    for (let index = 0; index < TRAIL_MAX + 5; index += 1) trail = visit(trail, `/f${index}`)
    expect(trail.entries).toHaveLength(TRAIL_MAX)
    expect(trail.index).toBe(TRAIL_MAX - 1)
  })
})

describe('the place kept per root', () => {
  afterEach(forgetPlaces)

  it('keeps the last file, its top line, the open folders and the last search per root, in memory only', () => {
    expect(recalledPlace('/p')).toBeNull()
    rememberPlace('/p', { file: { path: '/p/a.ts', topLine: 120 }, expanded: ['/p/src'], find: { query: 'needle', matchCase: true } })
    rememberPlace('/q', { file: null, expanded: [], find: null })
    expect(recalledPlace('/p')).toEqual({ file: { path: '/p/a.ts', topLine: 120 }, expanded: ['/p/src'], find: { query: 'needle', matchCase: true } })
    expect(recalledPlace('/q')?.file).toBeNull()
  })
})

describe('Esc order', () => {
  it('closes the innermost open thing first and the sheet last', () => {
    expect(escapeStep({ focus: 'file', typed: false, goTo: true, find: true })).toBe('close-goto')
    expect(escapeStep({ focus: 'file', typed: false, goTo: false, find: true })).toBe('close-find')
    expect(escapeStep({ focus: 'tree', typed: true, goTo: false, find: true })).toBe('clear-typed')
    expect(escapeStep({ focus: 'file', typed: true, goTo: false, find: false })).toBe('clear-typed')
    expect(escapeStep({ focus: 'field', typed: false, goTo: false, find: false })).toBe('close-sheet')
  })

  it('stops a running search, then goes from a file opened from results back to them, then to the tree (Story 67.5)', () => {
    expect(escapeStep({ focus: 'field', typed: false, goTo: false, find: false, search: 'searching' })).toBe('stop-search')
    expect(escapeStep({ focus: 'field', typed: false, goTo: false, find: false, search: 'results' })).toBe('clear-search')
    expect(escapeStep({ focus: 'file', typed: false, goTo: false, find: false, search: 'results', fromResults: true })).toBe('back-to-results')
    expect(escapeStep({ focus: 'file', typed: false, goTo: false, find: true, search: 'results', fromResults: true })).toBe('close-find')
    expect(escapeStep({ focus: 'file', typed: false, revealed: true, goTo: false, find: false, search: 'results', fromResults: true })).toBe('hide-secret')
    expect(escapeStep({ focus: 'file', typed: false, goTo: false, find: false, search: null, fromResults: true })).toBe('close-sheet')
  })
})
