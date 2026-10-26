// MODULE: known-terminal-selection.ts - Select known fixture text using real buffer-cell coordinates
interface Cell { getChars(): string; getWidth(): number }
interface Line { readonly isWrapped: boolean; getCell(column: number): Cell | undefined }
interface Buffer { readonly length: number; getLine(row: number): Line | undefined }
interface Point { column: number; row: number; chars: string; width: number; offset: number }
interface Range { column: number; row: number; length: number }

/** Find the latest exact ASCII fixture text, joining only xterm's actual soft-wrapped rows. */
export function knownTerminalTextRange(buffer: Buffer, columns: number, text: string, length: number): Range | undefined {
  if (!/^[\x20-\x7e]+$/.test(text) || !Number.isInteger(length) || length < 1 || length > text.length) {
    throw new Error('Known terminal selection requires ASCII text and a valid length')
  }
  let carry = ''
  let points: Point[] = []
  let previousLineAvailable = false
  let found: Range | undefined
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (!line || (line.isWrapped && !previousLineAvailable)) {
      carry = ''; points = []; previousLineAvailable = false
      continue
    }
    if (!line.isWrapped) { carry = ''; points = [] }
    let complete = true
    for (let column = 0; column < columns; column++) {
      const cell = line.getCell(column)
      if (!cell) { complete = false; break }
      if (cell.getWidth() === 0) continue
      const chars = cell.getChars()
      carry += chars || ' '
      for (let offset = 0; offset < (chars.length || 1); offset++) {
        points.push({ column, row, chars, width: cell.getWidth(), offset })
      }
    }
    if (!complete) { carry = ''; points = []; previousLineAvailable = false; continue }
    let start = carry.indexOf(text)
    while (start !== -1) {
      const match = points.slice(start, start + text.length)
      const first = match[0]
      if (first && match.length === text.length && match.every((point, index) =>
        point.width === 1 && point.offset === 0 && point.chars === text[index])) {
        found = { column: first.column, row: first.row, length }
      }
      start = carry.indexOf(text, start + 1)
    }
    // Only a possible cross-row prefix needs retaining; this is test-only, once per fixture.
    const keep = text.length - 1
    carry = keep ? carry.slice(-keep) : ''
    points = keep ? points.slice(-keep) : []
    previousLineAvailable = true
  }
  return found
}

export function selectKnownTerminalText(terminal: {
  readonly cols: number
  readonly buffer: { readonly active: Buffer }
  select(column: number, row: number, length: number): void
  getSelection(): string
}, text: string, length: number): string {
  const range = knownTerminalTextRange(terminal.buffer.active, terminal.cols, text, length)
  if (!range) throw new Error(`Known terminal text was absent: ${text}`)
  terminal.select(range.column, range.row, range.length)
  const selected = terminal.getSelection()
  if (selected !== text.slice(0, length)) throw new Error('Known terminal selection did not match its buffer cells')
  return selected
}
