// MODULE: quick-look-tree.test.ts - Quick look's tree rows and keys: order, joined chains, the cap line, folding and typed names (Story 67.1)
import { describe, expect, it } from 'vitest'
import type { QuickLookEntry } from '@bmn/protocol'
import { treeKey, treeRows, typedMatch, type TreeListing } from './quick-look-tree'
import { quickLookFooter } from './quick-look-keys'

const entry = (name: string, kind: QuickLookEntry['kind'] = 'file', joined: string[] = [], dimmed = false): QuickLookEntry => ({ name, kind, joined, dimmed })
const listing = (entries: QuickLookEntry[], more = 0): TreeListing => ({ entries, more, unavailable: null })

const listings = new Map<string, TreeListing>([
  ['/p', listing([entry('apps', 'folder', ['desktop']), entry('docs', 'folder'), entry('features.md'), entry('file.ts'), entry('notes.md')], 1240)],
  ['/p/apps/desktop', listing([entry('src', 'folder'), entry('package.json')])],
  ['/p/docs', listing([entry('guide.md')])]
])

describe('Quick look tree', () => {
  it('shows open folders depth first, a joined chain as one row, and the cap as a line', () => {
    const rows = treeRows('/p', listings, new Set(['/p/apps/desktop']))
    expect(rows.map((row) => `${row.depth}:${row.kind === 'more' || row.kind === 'note' ? row.label : row.path}`)).toEqual([
      '0:/p/apps/desktop', '1:/p/apps/desktop/src', '1:/p/apps/desktop/package.json', '0:/p/docs', '0:/p/features.md', '0:/p/file.ts', '0:/p/notes.md',
      '0:1,240 more not shown'
    ])
  })

  it('walks with the arrows, opens and closes folders, steps to a parent, and opens a file on Enter', () => {
    const closed = treeRows('/p', listings, new Set())
    expect(treeKey(closed, null, 'ArrowDown', '')).toEqual({ kind: 'select', path: '/p/apps/desktop' })
    expect(treeKey(closed, '/p/apps/desktop', 'ArrowRight', '')).toEqual({ kind: 'expand', path: '/p/apps/desktop' })
    const open = treeRows('/p', listings, new Set(['/p/apps/desktop']))
    expect(treeKey(open, '/p/apps/desktop', 'ArrowRight', '')).toEqual({ kind: 'select', path: '/p/apps/desktop/src' })
    expect(treeKey(open, '/p/apps/desktop/package.json', 'ArrowLeft', '')).toEqual({ kind: 'select', path: '/p/apps/desktop' })
    expect(treeKey(open, '/p/apps/desktop', 'ArrowLeft', '')).toEqual({ kind: 'collapse', path: '/p/apps/desktop' })
    expect(treeKey(open, '/p/file.ts', 'Enter', '')).toEqual({ kind: 'open', path: '/p/file.ts' })
    expect(treeKey(open, '/p/docs', 'Enter', '')).toEqual({ kind: 'expand', path: '/p/docs' })
    expect(treeKey(open, '/p/notes.md', 'ArrowDown', '')).toEqual({ kind: 'select', path: '/p\u0000more' })
    expect(treeKey(open, '/p/notes.md', 'ArrowLeft', '')).toEqual({ kind: 'none' })
  })

  it('jumps to the next name that starts with what was typed, keeping a row that still matches', () => {
    const rows = treeRows('/p', listings, new Set())
    expect(treeKey(rows, '/p/docs', 'f', '')).toEqual({ kind: 'typed', text: 'f', path: '/p/features.md' })
    expect(treeKey(rows, '/p/features.md', 'i', 'f')).toEqual({ kind: 'typed', text: 'fi', path: '/p/file.ts' })
    expect(typedMatch(rows, '/p/features.md', 'fe')).toBe('/p/features.md')
    expect(typedMatch(rows, '/p/notes.md', 'd')).toBe('/p/docs')
    expect(typedMatch(rows, null, 'zz')).toBeNull()
  })

  it('shows a folder that could not be read as one line', () => {
    const rows = treeRows('/p', new Map([['/p', { entries: [], more: 0, unavailable: 'This folder is unavailable' }]]), new Set())
    expect(rows).toEqual([{ kind: 'note', path: '/p\u0000note', label: 'This folder is unavailable', depth: 0, parent: '/p' }])
  })
})

describe('Quick look footer', () => {
  it('shows the keys of the state it is in, and what Esc does there', () => {
    expect(quickLookFooter({ focus: 'tree', fileOpen: false, typed: false, folded: false }).map((hint) => hint.label))
      .toEqual(['Move', 'Fold', 'Open', 'Jump to name', 'Hide tree', 'Close'])
    expect(quickLookFooter({ focus: 'tree', fileOpen: true, typed: true, folded: false }).at(-1)).toEqual({ keys: ['Esc'], label: 'Clear typed' })
    expect(quickLookFooter({ focus: 'file', fileOpen: true, typed: false, folded: true }).map((hint) => hint.label)).toEqual(['Move', 'Show tree', 'Close'])
  })
})
