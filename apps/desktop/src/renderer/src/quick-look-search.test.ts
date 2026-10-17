// MODULE: quick-look-search.test.ts - the words of Quick look's search results on made-up results: what was covered, what cut it short, the match list and a row cut to fit (Story 67.5)
import { describe, expect, it } from 'vitest'
import { SECRET_MASK, type QuickLookContentsResult } from '@bmn/protocol'
import { contentsHeader, filesHeader, flatMatches, matchInText, matchLabel, resultFolder, rowPieces, searchable, stepSearchMatch } from './quick-look-search'

const result = (over: Partial<QuickLookContentsResult> = {}): QuickLookContentsResult => ({
  mode: 'contents', root: '/p', scope: 'git', matchCount: 8, filesRead: 619, unreadable: 0, limit: null, cancelled: false, unavailable: null, elapsedMs: 240,
  files: [
    { path: '/p/src/a.tsx', lines: [{ line: 18, column: 1, length: 6, text: 'needle,', matchStart: 0, matchEnd: 6, cutBefore: false, cutAfter: false }] },
    { path: '/p/b.ts', lines: [{ line: 3, column: 5, length: 6, text: 'x = needle', matchStart: 4, matchEnd: 10, cutBefore: false, cutAfter: false },
      { line: 9, column: 1, length: 6, text: 'needle', matchStart: 0, matchEnd: 6, cutBefore: false, cutAfter: false }] }
  ],
  ...over
})

describe('what a contents search says it covered', () => {
  it('counts matches, files and files read, and says inside a repository that ignored files were skipped', () => {
    expect(contentsHeader(result())).toEqual({ count: '8 matches in 2 files', read: '619 files read · 0.2 s', notes: ['Files Git ignores were skipped.'] })
    expect(contentsHeader(result({ scope: 'walk', matchCount: 1, files: result().files.slice(0, 1), filesRead: 1 }))).toEqual({ count: '1 match in 1 file', read: '1 file read · 0.2 s', notes: [] })
    expect(contentsHeader(result({ matchCount: 0, files: [] })).count).toBe('No matches')
  })

  it('names the limit that cut it short, a stop and files it could not read, and never says all or complete', () => {
    expect(contentsHeader(result({ limit: 'files' })).notes[0]).toBe('Partial results · limit reached: 20,000 files searched')
    expect(contentsHeader(result({ limit: 'lines' })).notes[0]).toBe('Partial results · limit reached: 2,000 matching lines')
    expect(contentsHeader(result({ cancelled: true })).notes[0]).toBe('Partial results · search stopped')
    expect(contentsHeader(result({ unreadable: 3 })).notes).toContain('3 files could not be read')
    for (const over of [{}, { limit: 'files' as const }, { limit: 'lines' as const }, { cancelled: true }]) {
      expect(JSON.stringify(contentsHeader(result(over)))).not.toMatch(/\ball\b|complete/iu)
    }
  })

  it('words the name search as the palette does', () => {
    const files = { mode: 'files' as const, root: '/p', files: [{ name: 'a.ts', directory: '/p', path: '/p/a.ts' }], scanned: 20_000, capped: true, unavailable: false, cancelled: false }
    expect(filesHeader(files)).toBe('Showing first 1 matches; search capped after 20000 entries.')
    expect(filesHeader({ ...files, capped: false })).toBe('1 file')
    expect(filesHeader({ ...files, files: [], capped: false })).toBe('No matches')
  })
})

describe('the match list', () => {
  it('lists matches by file and line, steps with wrap, and labels the open one', () => {
    expect(flatMatches(result()).map((match) => `${match.path}:${match.line}`)).toEqual(['/p/src/a.tsx:18', '/p/b.ts:3', '/p/b.ts:9'])
    expect(stepSearchMatch(2, 3, 1)).toBe(0)
    expect(stepSearchMatch(0, 3, -1)).toBe(2)
    expect(stepSearchMatch(-1, 3, -1)).toBe(2)
    expect(stepSearchMatch(0, 0, 1)).toBe(-1)
    expect(matchLabel(1, 8)).toBe('Match 2 of 8')
  })

  it('searches names from one visible character and contents from two', () => {
    expect(searchable('files', ' ')).toBe(false)
    expect(searchable('files', 'a')).toBe(true)
    expect(searchable('contents', 'a')).toBe(false)
    expect(searchable('contents', 'ab')).toBe(true)
  })

  it('finds a match in the view\'s text by line and column, and nothing past the line', () => {
    const text = 'one\ntwo needle\nthree'
    expect(matchInText(text, { line: 2, column: 5, length: 6 })).toEqual({ from: 8, to: 14 })
    expect(matchInText(text, { line: 2, column: 9, length: 6 })).toBeNull()
    expect(matchInText(text, { line: 9, column: 1, length: 1 })).toBeNull()
  })
})

describe('a row', () => {
  it('keeps a few characters before the match, marks a cut with "…" and drops indentation', () => {
    expect(rowPieces({ line: 1, column: 1, length: 6, text: '    needle,', matchStart: 4, matchEnd: 10, cutBefore: false, cutAfter: false })).toEqual({ before: '', match: 'needle', after: ',' })
    expect(rowPieces({ line: 1, column: 1, length: 6, text: `${'x'.repeat(40)}needle tail`, matchStart: 40, matchEnd: 46, cutBefore: false, cutAfter: true }))
      .toEqual({ before: `…${'x'.repeat(16)}`, match: 'needle', after: ' tail…' })
  })

  it('keeps a whole "[secret hidden]" rather than cutting into it', () => {
    const text = `Key: ${SECRET_MASK} and made-up words.`
    const start = text.indexOf('made-up')
    expect(rowPieces({ line: 1, column: 1, length: 13, text, matchStart: start, matchEnd: start + 13, cutBefore: false, cutAfter: false }).before).toBe(`…${SECRET_MASK} and `)
  })

  it('names a result\'s folder under the root', () => {
    expect(resultFolder('/p/src/a.ts', '/p')).toBe('src')
    expect(resultFolder('/p/a.ts', '/p')).toBe('')
    expect(resultFolder('/elsewhere/a.ts', '/p')).toBe('/elsewhere')
  })
})
