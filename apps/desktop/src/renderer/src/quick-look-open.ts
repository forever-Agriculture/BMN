// MODULE: quick-look-open.ts - the ways into Quick look as data: the plate's folder name, whose folder it opens, a reference or a path, the paths a session's terminal printed, a selection that reads as one reference, and the words for a missing file (Story 67.6)
import { findFileReferences, formatFileReference, type FileReferenceBase, type QuickLookSource } from '@bmn/protocol'

/** A folder's own name, as the project plate shows it (Fable, 2026-10-18): "/home/o/code/BMN/" reads "BMN"; the root stays "/". */
export function folderName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? (path || '/')
}

/** What an opening asks to show: a path the app already knows, or a reference resolved as a Ctrl+click is. */
export type QuickLookAsk = { path: string; line: number | null; column: number | null } | { reference: string }

/**
 * Whose folder Quick look opens: the session named (a terminal, the palette for the selected session), else the
 * active workspace (a pin, the palette with no session); null when neither is open.
 */
export function quickLookSourceFor(session: { sessionId: string; archivedAt: string | null } | undefined,
  workspace: { workspaceId: string; archivedAt: string | null } | undefined): QuickLookSource | null {
  if (session && session.archivedAt === null) return { sessionId: session.sessionId }
  if (workspace && workspace.archivedAt === null) return { workspaceId: workspace.workspaceId }
  return null
}

/** The "…" menu's Copy reference: the file read and the place he came for, as today's dialog copies it. */
export function copiedReference(canonicalPath: string, line: number | null, column: number | null): string {
  return formatFileReference(canonicalPath, line, column)
}

export interface MissingWords {
  title: string
  /** Where a relative reference was resolved from, or that the path was absolute. */
  from: string
  /** A folder may be chosen for this one opening only when the reference is relative. */
  chooseFolder: boolean
}

/** What Quick look says for a reference whose file is missing (AC3). */
export function missingWords(base: FileReferenceBase | null): MissingWords {
  if (!base) return { title: 'No file at this path', from: 'The path is absolute.', chooseFolder: false }
  return {
    title: 'No file at this path',
    from: `Resolved from ${base.path}${base.kind === 'chosen-directory' ? ', the folder chosen for this opening' : ', the session\'s launch folder'}.`,
    chooseFolder: true
  }
}

/** At most this many printed paths are listed (AC7). */
export const RECENT_PATHS_MAX = 20
/** How much of the scrollback is read for them: rows and bytes of text, newest first. */
export const RECENT_SCROLLBACK_ROWS = 5_000
export const RECENT_SCROLLBACK_BYTES = 512 * 1024

export interface PrintedReference {
  /** The reference as printed, which opening resolves as a Ctrl+click would. */
  text: string
  path: string
  line: number | null
  column: number | null
}

/**
 * The file references in the terminal's newest lines (given oldest first), newest first: the last one printed
 * leads, each text listed once, at most twenty. A path that is gone is listed too; it opens as missing.
 */
export function printedReferences(lines: readonly string[], max = RECENT_PATHS_MAX): PrintedReference[] {
  const seen = new Set<string>()
  const found: PrintedReference[] = []
  for (let index = lines.length - 1; index >= 0 && found.length < max; index -= 1) {
    const matches = findFileReferences(lines[index]!)
    for (let each = matches.length - 1; each >= 0 && found.length < max; each -= 1) {
      const match = matches[each]!
      if (seen.has(match.text)) continue
      seen.add(match.text)
      found.push({ text: match.text, path: match.reference.path, line: match.reference.line, column: match.reference.column })
    }
  }
  return found
}

/** A terminal selection that is exactly one file reference, as its text; null for anything else. */
export function selectedReference(selection: string): string | null {
  const text = selection.trim()
  if (!text || text.includes('\n')) return null
  const matches = findFileReferences(text)
  return matches.length === 1 && matches[0]!.start === 0 && matches[0]!.end === text.length ? matches[0]!.text : null
}
