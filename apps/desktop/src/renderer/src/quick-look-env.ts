// MODULE: quick-look-env.ts - a `.env` file as rows and a draft written back byte for byte: only changed values and added lines differ (Story 68.1)

/** A line of a `.env` file as Quick look shows it; offsets are into the file's text as read. */
export type EnvRow =
  | { kind: 'comment'; line: number; text: string }
  | { kind: 'blank'; line: number }
  | {
      kind: 'key'
      line: number
      name: string
      /** The value as the program reading the file takes it: inside its quotes, if any. */
      value: string
      quote: EnvQuote
      /** Where the value's text stands in the file, its quotes included. */
      valueFrom: number
      valueTo: number
    }

export type EnvQuote = 'none' | 'single' | 'double'

export type EnvModel =
  | { status: 'rows'; rows: EnvRow[]; keys: number; lineEnding: '\n' | '\r\n'; finalNewline: boolean }
  /** Shown as masked text, with the reason where Edit would be. */
  | { status: 'read-only'; reason: string }

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ASSIGNMENT = /^([ \t]*)(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/
const BARE_SAFE = /^[A-Za-z0-9_\-./:=+@%]*$/

interface Line {
  from: number
  /** Where its text ends, before the line ending. */
  to: number
}

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf('\n', from)
    if (at === -1) {
      if (from < text.length) lines.push({ from, to: text.length })
      return lines
    }
    lines.push({ from, to: at > from && text[at - 1] === '\r' ? at - 1 : at })
    from = at + 1
  }
}

/** Where the quote opening at `start` closes on its line: a double quote after a backslash does not close it. */
function closingQuote(body: string, start: number): number {
  const quote = body[start]
  for (let at = start + 1; at < body.length; at += 1) {
    if (quote === '"' && body[at] === '\\') at += 1
    else if (body[at] === quote) return at
  }
  return -1
}

/** After a value only blanks and a `#` comment may stand on its line. */
function restIsComment(rest: string): boolean {
  return /^(?:[ \t]*|[ \t]+#.*)$/.test(rest)
}

/**
 * Reads a `.env` file as rows: comments, blank lines and `NAME=value` (with `export`, bare, single- or
 * double-quoted). A multi-line value, a name given twice or a line that is neither makes the file read-only,
 * with the reason; nothing here guesses.
 */
export function readEnvFile(text: string): EnvModel {
  const rows: EnvRow[] = []
  const names = new Set<string>()
  const lines = linesOf(text)
  for (const [index, { from, to }] of lines.entries()) {
    const line = index + 1
    const body = text.slice(from, to)
    if (/^[ \t]*$/.test(body)) {
      rows.push({ kind: 'blank', line })
      continue
    }
    if (/^[ \t]*#/.test(body)) {
      rows.push({ kind: 'comment', line, text: body })
      continue
    }
    const head = ASSIGNMENT.exec(body)
    if (!head) return { status: 'read-only', reason: `Read-only · line ${line} is not NAME=value` }
    const name = head[3] as string
    if (names.has(name)) return { status: 'read-only', reason: 'Read-only · this file names a key twice' }
    names.add(name)
    const start = head[0].length
    const opening = body[start]
    if (opening === '"' || opening === "'") {
      const close = closingQuote(body, start)
      if (close === -1) return { status: 'read-only', reason: 'Read-only · this file has a multi-line value' }
      // Shown as it stands between the quotes; a new value replaces it whole, so its escapes are never read.
      const value = body.slice(start + 1, close)
      if (!restIsComment(body.slice(close + 1))) return { status: 'read-only', reason: `Read-only · line ${line} is not NAME=value` }
      rows.push({ kind: 'key', line, name, value, quote: opening === '"' ? 'double' : 'single', valueFrom: from + start, valueTo: from + close + 1 })
      continue
    }
    // A bare value runs to a blank before `#` or to the line's end, trailing blanks left out.
    const comment = /[ \t]#/.exec(body.slice(start))
    const end = comment ? start + comment.index : body.length
    const value = body.slice(start, end).replace(/[ \t]+$/, '')
    rows.push({ kind: 'key', line, name, value, quote: 'none', valueFrom: from + start, valueTo: from + start + value.length })
  }
  const crlf = /\r\n/.test(text)
  return {
    status: 'rows', rows, keys: names.size, lineEnding: crlf ? '\r\n' : '\n',
    finalNewline: text.length === 0 || text.endsWith('\n')
  }
}

export type EnvWritten = { status: 'written'; text: string } | { status: 'refused'; message: string }

export const ENV_UNSAFE_VALUE = 'BMN cannot write this value safely; edit it in the terminal'

/**
 * A new value as it is written (Story 68.1 AC4): in the old value's quoting when it fits; otherwise bare when it
 * holds only letters, digits and `_ - . / : = + @ %`, in single quotes when it holds no single quote, and refused
 * in any other case. A line break never fits.
 */
export function writtenValue(value: string, old: EnvQuote): EnvWritten {
  if (/[\r\n]/.test(value)) return { status: 'refused', message: ENV_UNSAFE_VALUE }
  const bare = BARE_SAFE.test(value)
  // Double quotes are kept only for text no reader escapes or expands there.
  const fits = old === 'none' ? bare : old === 'single' ? !value.includes("'") : !/["\\$`]/.test(value)
  if (fits) return { status: 'written', text: old === 'none' ? value : old === 'single' ? `'${value}'` : `"${value}"` }
  if (bare) return { status: 'written', text: value }
  if (!value.includes("'")) return { status: 'written', text: `'${value}'` }
  return { status: 'refused', message: ENV_UNSAFE_VALUE }
}

/** Whether a name may be added: letters, digits and underscore, not starting with a digit, and not one the file has. */
export function envNameProblem(name: string, taken: readonly string[]): string | null {
  if (!NAME.test(name)) return 'Letters, digits and _ only, not starting with a digit'
  if (taken.includes(name)) return 'This file already has that name'
  return null
}

export interface EnvDraft {
  /** New values by the line of the key they replace. */
  changed: ReadonlyMap<number, string>
  added: ReadonlyArray<{ name: string; value: string }>
}

export type EnvSaved = { status: 'ready'; text: string } | { status: 'refused'; message: string; line: number | null }

/**
 * The file's new text: the read text with each changed value's span replaced and each added key appended in the
 * file's line ending; every other byte as read, a final newline or its absence kept.
 */
export function envFileText(text: string, model: Extract<EnvModel, { status: 'rows' }>, draft: EnvDraft): EnvSaved {
  let out = ''
  let at = 0
  for (const row of model.rows) {
    if (row.kind !== 'key' || !draft.changed.has(row.line)) continue
    const written = writtenValue(draft.changed.get(row.line) as string, row.quote)
    if (written.status === 'refused') return { status: 'refused', message: written.message, line: row.line }
    out += text.slice(at, row.valueFrom) + written.text
    at = row.valueTo
  }
  out += text.slice(at)
  if (draft.added.length === 0) return { status: 'ready', text: out }
  const added: string[] = []
  for (const key of draft.added) {
    const written = writtenValue(key.value, 'none')
    if (written.status === 'refused') return { status: 'refused', message: written.message, line: null }
    added.push(`${key.name}=${written.text}`)
  }
  const ending = model.lineEnding
  const joined = added.join(ending)
  if (out.length === 0) return { status: 'ready', text: joined + ending }
  // An added line keeps the file's habit: after the last line ends, and ending itself only if the file's last line did.
  return { status: 'ready', text: model.finalNewline ? out + joined + ending : out + ending + joined }
}

/** Who may read a file, in words, from its mode. */
export function readersOf(mode: number): string {
  if ((mode & 0o004) !== 0) return 'everyone on this computer'
  if ((mode & 0o040) !== 0) return 'owner and group'
  return 'owner only'
}
