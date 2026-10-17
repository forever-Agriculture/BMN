// MODULE: quick-look-tree.ts - Quick look's project tree as rows, and what each tree key does to them (Story 67.1)
import { quickLookCount, type QuickLookEntry, type QuickLookEntryKind } from '@bmn/protocol'

/** One folder as the host listed it; null entries while its listing is on the way. */
export interface TreeListing {
  entries: QuickLookEntry[] | null
  more: number
  unavailable: string | null
}

export type TreeRow =
  | {
      kind: QuickLookEntryKind
      /** The entry's own path; for a joined row, the deepest folder of the chain, whose entries it shows. */
      path: string
      /** The first name, and the joined names after it (`apps` + `desktop`). */
      name: string
      joined: string[]
      depth: number
      dimmed: boolean
      expanded: boolean
      parent: string
    }
  | { kind: 'more'; path: string; label: string; depth: number; parent: string }
  | { kind: 'note'; path: string; label: string; depth: number; parent: string }

function child(folder: string, name: string): string {
  return folder.endsWith('/') ? `${folder}${name}` : `${folder}/${name}`
}

/** The rows the tree shows, depth first, for the folders that are open. */
export function treeRows(root: string, listings: ReadonlyMap<string, TreeListing>, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (folder: string, depth: number): void => {
    const listing = listings.get(folder)
    if (!listing || listing.entries === null) return
    if (listing.unavailable) {
      rows.push({ kind: 'note', path: `${folder}\u0000note`, label: listing.unavailable, depth, parent: folder })
      return
    }
    for (const entry of listing.entries) {
      const path = entry.joined.reduce(child, child(folder, entry.name))
      const open = entry.kind === 'folder' && expanded.has(path)
      rows.push({ kind: entry.kind, path, name: entry.name, joined: entry.joined, depth, dimmed: entry.dimmed, expanded: open, parent: folder })
      if (open) walk(path, depth + 1)
    }
    if (listing.more > 0) rows.push({ kind: 'more', path: `${folder}\u0000more`, label: `${quickLookCount(listing.more)} more not shown`, depth, parent: folder })
  }
  walk(root, 0)
  return rows
}

/** What a key in the tree asks the sheet to do. */
export type TreeAction =
  | { kind: 'select'; path: string }
  | { kind: 'expand'; path: string }
  | { kind: 'collapse'; path: string }
  | { kind: 'open'; path: string }
  | { kind: 'typed'; text: string; path: string | null }
  | { kind: 'none' }

const selectable = (row: TreeRow): boolean => row.kind !== 'note'

function step(rows: readonly TreeRow[], from: number, by: 1 | -1): TreeRow | null {
  for (let index = from + by; index >= 0 && index < rows.length; index += by) {
    if (selectable(rows[index]!)) return rows[index]!
  }
  return null
}

/**
 * The next row after the selection whose name starts with `text`, wrapping round; case is ignored. A longer text
 * keeps the selected row when it still matches, so "f" then "fe" stays on `features.md`.
 */
export function typedMatch(rows: readonly TreeRow[], selected: string | null, text: string): string | null {
  if (!text) return null
  const wanted = text.toLocaleLowerCase()
  const start = Math.max(-1, rows.findIndex((row) => row.path === selected))
  for (let offset = text.length > 1 && start >= 0 ? 0 : 1; offset <= rows.length; offset += 1) {
    const row = rows[(start + offset) % rows.length]!
    if (row.kind !== 'more' && row.kind !== 'note' && row.name.toLocaleLowerCase().startsWith(wanted)) return row.path
  }
  return null
}

/**
 * ↑ ↓ move; → opens a folder or steps into it; ← closes it or goes to its parent; Enter opens a file or toggles a
 * folder; a letter adds to what was typed and jumps to the next name that starts with it.
 */
export function treeKey(rows: readonly TreeRow[], selected: string | null, key: string, typed: string): TreeAction {
  const index = rows.findIndex((row) => row.path === selected)
  const row = index >= 0 ? rows[index]! : null
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const next = row ? step(rows, index, key === 'ArrowDown' ? 1 : -1) : rows.find(selectable) ?? null
    return next ? { kind: 'select', path: next.path } : { kind: 'none' }
  }
  if (key === 'Home' || key === 'End') {
    const next = key === 'Home' ? rows.find(selectable) : [...rows].reverse().find(selectable)
    return next ? { kind: 'select', path: next.path } : { kind: 'none' }
  }
  if (!row) return { kind: 'none' }
  if (key === 'ArrowRight') {
    if (row.kind !== 'folder') return { kind: 'none' }
    if (!row.expanded) return { kind: 'expand', path: row.path }
    const first = rows[index + 1]
    return first && first.depth > row.depth && selectable(first) ? { kind: 'select', path: first.path } : { kind: 'none' }
  }
  if (key === 'ArrowLeft') {
    if (row.kind === 'folder' && row.expanded) return { kind: 'collapse', path: row.path }
    const parent = rows.find((each) => each.kind === 'folder' && each.path === row.parent)
    return parent ? { kind: 'select', path: parent.path } : { kind: 'none' }
  }
  if (key === 'Enter') {
    if (row.kind === 'file' || row.kind === 'link') return { kind: 'open', path: row.path }
    if (row.kind === 'folder') return row.expanded ? { kind: 'collapse', path: row.path } : { kind: 'expand', path: row.path }
    return { kind: 'none' }
  }
  if (key.length === 1 && key !== ' ' && /\S/u.test(key)) {
    const text = `${typed}${key}`
    return { kind: 'typed', text, path: typedMatch(rows, selected, text) }
  }
  return { kind: 'none' }
}
