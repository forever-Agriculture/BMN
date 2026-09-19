// MODULE: file-reference-presentation.ts - words and line windows for the read-only file-reference preview
import {
  fileReferenceLines,
  type FileReferenceBase,
  type FileReferenceSnapshot
} from '@bmn/protocol'

/** What a relative reference is resolved against; never called the current directory. */
export function baseDescription(base: FileReferenceBase | null): { label: string; path: string | null } {
  if (!base) return { label: 'Absolute path', path: null }
  return base.kind === 'launch-directory'
    ? { label: 'Launch directory', path: base.path }
    : { label: 'Chosen folder, this opening only', path: base.path }
}

export interface PreviewLines {
  /** Line numbers for the gutter, one per line. */
  gutter: string
  before: string
  /** The referenced line, or null when there is none or it is past the end. */
  target: string | null
  after: string
  lineCount: number
  /** Where the preview stands: the line shown, or why no line is marked. */
  position: string
}

/** Splits a snapshot around its referenced line so only that line is marked. */
export function previewLines(snapshot: Pick<FileReferenceSnapshot, 'content' | 'line' | 'column'>): PreviewLines {
  const lines = fileReferenceLines(snapshot.content)
  const gutter = lines.map((_, index) => String(index + 1)).join('\n')
  const count = `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`
  if (snapshot.line === null) {
    return { gutter, before: lines.join('\n'), target: null, after: '', lineCount: lines.length, position: count }
  }
  if (snapshot.line > lines.length) {
    return {
      gutter,
      before: lines.join('\n'),
      target: null,
      after: '',
      lineCount: lines.length,
      position: `Line ${snapshot.line} is past the end of the file (${count}).`
    }
  }
  const index = snapshot.line - 1
  return {
    gutter,
    before: lines.slice(0, index).join('\n'),
    target: lines[index] ?? '',
    after: lines.slice(index + 1).join('\n'),
    lineCount: lines.length,
    position: `Line ${snapshot.line}${snapshot.column === null ? '' : `, column ${snapshot.column}`} of ${count}`
  }
}

export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
