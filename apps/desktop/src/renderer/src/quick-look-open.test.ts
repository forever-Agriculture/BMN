// MODULE: quick-look-open.test.ts - the ways into Quick look on made-up data: session or workspace, the menu's reference, a missing file's words, printed paths from a scrollback and a selected reference (Story 67.6)
import { describe, expect, it } from 'vitest'
import { RECENT_PATHS_MAX, copiedReference, missingWords, printedReferences, quickLookSourceFor, selectedReference } from './quick-look-open'

describe('whose folder an opening shows', () => {
  it('opens for the session named, else the active workspace, else nothing', () => {
    const session = { sessionId: 's1', archivedAt: null }
    const workspace = { workspaceId: 'w1', archivedAt: null }
    expect(quickLookSourceFor(session, workspace)).toEqual({ sessionId: 's1' })
    expect(quickLookSourceFor(undefined, workspace)).toEqual({ workspaceId: 'w1' })
    expect(quickLookSourceFor({ sessionId: 's1', archivedAt: '2026-10-18T00:00:00Z' }, workspace)).toEqual({ workspaceId: 'w1' })
    expect(quickLookSourceFor(undefined, { workspaceId: 'w1', archivedAt: '2026-10-18T00:00:00Z' })).toBeNull()
  })

  it('copies the reference as today\'s dialog does, quoting a path that needs it', () => {
    expect(copiedReference('/p/src/parser.ts', 42, 7)).toBe('/p/src/parser.ts:42:7')
    expect(copiedReference('/p/my notes.md', 3, null)).toBe('"/p/my notes.md":3')
    expect(copiedReference('/p/a.ts', null, null)).toBe('/p/a.ts')
  })

  it('says a file is missing, where a relative reference resolved from, and offers a folder only then', () => {
    expect(missingWords({ kind: 'launch-directory', path: '/p' })).toEqual({ title: 'No file at this path', from: "Resolved from /p, the session's launch folder.", chooseFolder: true })
    expect(missingWords({ kind: 'chosen-directory', path: '/q' }).from).toBe('Resolved from /q, the folder chosen for this opening.')
    expect(missingWords(null)).toEqual({ title: 'No file at this path', from: 'The path is absolute.', chooseFolder: false })
  })
})

describe('the paths a terminal printed', () => {
  it('lists them newest first, each once, with its line and column', () => {
    const lines = ['$ make', 'src/parser.ts:42:7: error: made-up', 'see docs/guide.md and src/parser.ts:42:7', 'warning in src/lexer.ts:3']
    expect(printedReferences(lines)).toEqual([
      { text: 'src/lexer.ts:3', path: 'src/lexer.ts', line: 3, column: null },
      { text: 'src/parser.ts:42:7', path: 'src/parser.ts', line: 42, column: 7 },
      { text: 'docs/guide.md', path: 'docs/guide.md', line: null, column: null }
    ])
  })

  it('stops at twenty, keeping the newest', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `made-up/file${index}.ts:${index + 1}`)
    const found = printedReferences(lines)
    expect(found).toHaveLength(RECENT_PATHS_MAX)
    expect(found[0]!.text).toBe('made-up/file29.ts:30')
    expect(found.at(-1)!.text).toBe('made-up/file10.ts:11')
  })

  it('lists a path whatever is on disk, and nothing from plain words', () => {
    expect(printedReferences(['/made-up/gone/away.ts:9 was removed'])).toEqual([{ text: '/made-up/gone/away.ts:9', path: '/made-up/gone/away.ts', line: 9, column: null }])
    expect(printedReferences(['nothing to see here', ''])).toEqual([])
  })
})

describe('a selected reference', () => {
  it('opens a selection that is exactly one reference, and nothing else', () => {
    expect(selectedReference('  src/parser.ts:42:7 ')).toBe('src/parser.ts:42:7')
    expect(selectedReference('src/parser.ts:42 and src/lexer.ts:3')).toBeNull()
    expect(selectedReference('error in src/parser.ts:42')).toBeNull()
    expect(selectedReference('src/parser.ts:42\nmore')).toBeNull()
    expect(selectedReference('')).toBeNull()
  })
})
