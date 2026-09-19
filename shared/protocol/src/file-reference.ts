// MODULE: file-reference.ts - the file-reference grammar shared by the palette entry, terminal links and the utility reader

/** The largest file shown; a larger or growing file is refused rather than cut. */
export const FILE_REFERENCE_MAX_BYTES = 1024 * 1024
/** Longer text is not a path anyone meant to open. */
export const FILE_REFERENCE_MAX_LENGTH = 4096
const MAX_POSITION = 10_000_000

/** A local file and an optional place in it. `path` is never expanded: absolute, or relative to a base directory. */
export interface FileReference {
  path: string
  line: number | null
  column: number | null
}

export type FileReferenceParse = { ok: true; reference: FileReference } | { ok: false; reason: string }

/**
 * `typed` is text the owner entered or pasted on purpose, so unquoted spaces belong to the path.
 * `terminal` is text found in output, where anything ambiguous stays plain text.
 */
export type FileReferenceMode = 'typed' | 'terminal'

export interface FileReferenceMatch {
  /** Offsets into the searched text; `end` is exclusive. */
  start: number
  end: number
  /** The matched text as printed, which opening parses again. */
  text: string
  reference: FileReference
}

export interface FileReferenceReadParams {
  sessionId: string
  /** The reference as entered or linked; the utility parses it again. */
  reference: string
  /** A folder the owner chose for this opening; the session's launch directory otherwise. */
  baseDirectory?: string | null
}

export type FileReferenceBaseKind = 'launch-directory' | 'chosen-directory'

export interface FileReferenceBase {
  kind: FileReferenceBaseKind
  path: string
}

export interface FileReferenceTarget {
  sessionId: string
  reference: string
  line: number | null
  column: number | null
  /** Null for an absolute reference, which needs no base. */
  base: FileReferenceBase | null
  /** The reference made absolute against the base, before any symlink is followed. */
  resolvedPath: string
}

export type FileReferenceUnavailableReason =
  | 'missing'
  | 'not-a-file'
  | 'too-large'
  | 'binary'
  | 'unreadable'
  | 'changed'

/** A read-only snapshot of a live file; it is never stored or published. */
export interface FileReferenceSnapshot extends FileReferenceTarget {
  status: 'ready'
  /** The file actually read, with every symlink resolved. */
  canonicalPath: string
  content: string
  byteLength: number
  lineCount: number
  modifiedAt: string
  readAt: string
}

export interface FileReferenceUnavailable extends FileReferenceTarget {
  status: 'unavailable'
  reason: FileReferenceUnavailableReason
  message: string
  canonicalPath: string | null
}

export type FileReferenceReadResult = FileReferenceSnapshot | FileReferenceUnavailable

/**
 * C0/C1 control characters and invisible format characters (such as a right-to-left override), which no typed
 * path or folder may carry: they could make the shown path read differently from the one opened.
 */
export function hasControlOrFormatCharacter(text: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(text)
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const SUFFIX = /^(.+?):(\d+)(?::(\d+))?$/s
/** A file name's last dot starts an extension that names a type, so it holds a letter. */
const EXTENSION = /^[^/]*[^/.][^/]*\.[\p{L}\p{N}_-]*\p{L}[\p{L}\p{N}_-]*$/u
const LETTER = /\p{L}/u

/** Parses a reference entered on purpose or found in output; nothing here reads the filesystem. */
export function parseFileReference(input: string, mode: FileReferenceMode = 'typed'): FileReferenceParse {
  const text = input.trim()
  if (text.length === 0) return failure('Enter a file reference.')
  if (text.length > FILE_REFERENCE_MAX_LENGTH) return failure('That reference is too long to be a file path.')
  if (hasControlOrFormatCharacter(text)) {
    return failure('Control characters and invisible formatting characters are not allowed in a file reference.')
  }
  const quote = text[0] === '"' || text[0] === "'" ? text[0] : null
  let body = text
  let outside: { line: number | null; column: number | null } = { line: null, column: null }
  if (quote) {
    const close = text.indexOf(quote, 1)
    if (close === -1) return failure('The quoted path has no closing quote.')
    body = text.slice(1, close)
    const rest = text.slice(close + 1)
    if (rest.length > 0) {
      const suffix = /^:(\d+)(?::(\d+))?$/.exec(rest)
      if (!suffix) return failure('Only a :line or :line:column may follow a quoted path.')
      const position = positions(suffix[1], suffix[2])
      if (!position.ok) return position
      outside = position.value
    }
  }
  let path = body
  let line = outside.line
  let column = outside.column
  const suffix = outside.line === null ? SUFFIX.exec(body) : null
  if (suffix) {
    const position = positions(suffix[2], suffix[3])
    if (!position.ok) return position
    path = suffix[1]!
    line = position.value.line
    column = position.value.column
  }
  const problem = pathProblem(path, mode, quote !== null)
  return problem ? failure(problem) : { ok: true, reference: { path, line, column } }
}

/** Why a path is not accepted as a reference, or null. */
function pathProblem(path: string, mode: FileReferenceMode, quoted: boolean): string | null {
  if (path.length === 0) return 'Enter a file path.'
  if (SCHEME.test(path)) return 'URLs and other schemes are not supported; enter a local path.'
  if (path.startsWith('~')) return '~ is not expanded; enter the full path.'
  if (path.includes('$')) return 'Shell variables are not expanded; enter the full path.'
  if (path.includes('`')) return 'Command substitution is not allowed in a file reference.'
  if (/[*?]/.test(path)) return 'Wildcards are not expanded; enter one file path.'
  if (path.includes('\\')) return 'Backslash escapes are not interpreted; put a path with spaces in quotes.'
  if (!quoted && path.includes(':')) return 'A colon is only accepted before a line number; quote a path that contains one.'
  if (path.endsWith('/') || path === '.' || path === '..' || path.endsWith('/.') || path.endsWith('/..')) {
    return 'That names a folder; enter a file.'
  }
  if (!LETTER.test(path) && !/\p{N}/u.test(path)) return 'Enter a file path.'
  const segments = path.split('/')
  const last = segments.at(-1) ?? ''
  const explicit = path.startsWith('/') || path.startsWith('./') || path.startsWith('../')
  if (mode === 'terminal') {
    if (/\s/.test(path) && !quoted) return 'Unquoted spaces are ambiguous.'
    if (!LETTER.test(path)) return 'No letters in the path.'
    // One slash between plain words ("and/or", "I/O") is prose more often than a path.
    if (!explicit && !EXTENSION.test(last) && segments.length < 3) return 'Ambiguous relative path.'
    if (!path.includes('/') && !simpleFileName(last)) return 'A bare word is not a file name.'
    return null
  }
  if (!explicit && !path.includes('/') && !EXTENSION.test(last)) {
    return 'Add ./ before a file name without an extension.'
  }
  return null
}

/** `name.ext` with a real extension; one-letter pairs like "e.g" are prose. */
function simpleFileName(name: string): boolean {
  if (!EXTENSION.test(name)) return false
  const dot = name.lastIndexOf('.')
  return dot >= 2 || name.length - dot - 1 >= 2
}

function positions(
  lineText: string | undefined,
  columnText: string | undefined
): { ok: true; value: { line: number; column: number | null } } | { ok: false; reason: string } {
  const line = Number(lineText)
  const column = columnText === undefined ? null : Number(columnText)
  if (!Number.isSafeInteger(line) || line < 1 || (column !== null && (!Number.isSafeInteger(column) || column < 1))) {
    return failure('Line and column numbers start at 1.')
  }
  if (line > MAX_POSITION || (column !== null && column > MAX_POSITION)) return failure('That line number is too large.')
  return { ok: true, value: { line, column } }
}

function failure(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

/** Characters a printed path is made of; anything else ends it. */
const PATH_RUN = /[\p{L}\p{M}\p{N}_./~@+:-]+/gu
const QUOTED_RUN = /(["'])([^"'\n]+?)\1(?::\d+(?::\d+)?)?/g
/** A path may follow these directly; after anything else ($HOME/x, a\b) the text is not a plain path. */
const OPENING = /[\s([{<"'`=,;]/u
const CLOSING = /[\s)\]}>"'`,;:.!?]/u
const TRAILING = /[.,;:!?]+$/

/**
 * Finds conservative file references in one logical line of terminal output. Candidates that could be
 * prose, a URL, an expansion or part of a longer token stay plain text; nothing is guessed.
 */
export function findFileReferences(text: string): FileReferenceMatch[] {
  const matches: FileReferenceMatch[] = []
  const taken: Array<[number, number]> = []
  const accept = (start: number, raw: string): void => {
    const end = start + raw.length
    const before = start === 0 ? ' ' : text[start - 1]!
    const after = end >= text.length ? ' ' : text[end]!
    if (!OPENING.test(before) || !CLOSING.test(after)) return
    const parsed = parseFileReference(raw, 'terminal')
    if (!parsed.ok) return
    taken.push([start, end])
    matches.push({ start, end, text: raw, reference: parsed.reference })
  }
  for (const found of text.matchAll(QUOTED_RUN)) accept(found.index, found[0])
  for (const found of text.matchAll(PATH_RUN)) {
    const trimmed = found[0].replace(TRAILING, '')
    const start = found.index
    if (trimmed.length === 0 || taken.some(([from, to]) => start < to && start + trimmed.length > from)) continue
    // A bare name right after a path fragment and a space may be the end of an unquoted spaced path: not guessed.
    if (!trimmed.includes('/') && /\/\S*\s$/u.test(text.slice(0, start))) continue
    accept(start, trimmed)
  }
  return matches.toSorted((left, right) => left.start - right.start)
}

/** Splits text into its lines; a final newline ends the last line rather than starting another. */
export function fileReferenceLines(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split(/\r\n|\r|\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** The reference text Copy reference writes: the displayed file plus its line and column. */
export function formatFileReference(path: string, line: number | null, column: number | null): string {
  const quoted = !/[\s"'`$\\:]/.test(path) ? path : path.includes('"') ? `'${path}'` : `"${path}"`
  return line === null ? quoted : column === null ? `${quoted}:${line}` : `${quoted}:${line}:${column}`
}
