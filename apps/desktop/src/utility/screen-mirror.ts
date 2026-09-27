// MODULE: screen-mirror.ts - a headless copy of one session's screen, so a remote answer can check what is on it
import { Terminal } from '@xterm/headless'

/** How much recent output a session keeps so a mirror started late still sees the dialog being drawn. */
export const SCREEN_TAIL_BYTES = 64 * 1024

/**
 * The last bytes a session printed, kept cheaply for every live session. Parsing every byte of every
 * session into a second terminal costs far more than the rest of the output path (Epic 30 measurement),
 * so a mirror is only started for a session running an agent, seeded from this tail.
 */
export class OutputTail {
  private readonly chunks: Uint8Array[] = []
  private bytes = 0

  constructor(private readonly limit = SCREEN_TAIL_BYTES) {}

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    const kept = chunk.byteLength > this.limit ? chunk.slice(chunk.byteLength - this.limit) : chunk.slice()
    this.chunks.push(kept)
    this.bytes += kept.byteLength
    while (this.bytes - (this.chunks[0]?.byteLength ?? 0) >= this.limit) {
      this.bytes -= this.chunks.shift()!.byteLength
    }
  }

  /** The kept bytes, oldest first. */
  read(): Uint8Array {
    const out = new Uint8Array(this.bytes)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }
}

export class ScreenMirror {
  private readonly terminal: Terminal
  private readonly listeners = new Set<() => void>()
  private disposed = false

  constructor(cols: number, rows: number, seed?: Uint8Array) {
    this.terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
    // A seed cut mid-stream may start inside an escape sequence; the parser resynchronises within bytes,
    // and the dialogs BMN looks for are redrawn after it anyway.
    if (seed && seed.byteLength > 0) this.write(seed)
  }

  write(bytes: Uint8Array): void {
    if (this.disposed) return
    this.terminal.write(bytes, () => this.changed())
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || (cols === this.terminal.cols && rows === this.terminal.rows)) return
    this.terminal.resize(cols, rows)
    this.changed()
  }

  /** Resolves once every byte written so far has been parsed into the screen. */
  settled(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return new Promise((resolve) => this.terminal.write('', resolve))
  }

  /**
   * The visible screen, one string per line; a row the terminal soft-wrapped is joined to the row before
   * with the cells it wrapped at, so a space at the wrap point survives.
   */
  lines(): string[] {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    let open = false
    for (let row = 0; row < this.terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row)
      if (!line) continue
      const next = buffer.getLine(buffer.viewportY + row + 1)
      const continues = row + 1 < this.terminal.rows && next?.isWrapped === true
      const text = line.translateToString(!continues)
      if (line.isWrapped && open) lines[lines.length - 1] += text
      else lines.push(text)
      open = continues
    }
    return lines.map((line) => line.trimEnd())
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.terminal.dispose()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

/*
 * Dialog recognition (docs/remote-answers.md, "Keys"). Every rule is anchored on the dialog's own
 * structure - the option list in order, ended by the harness's own extra entry, with the question text
 * directly above it - because the question text alone also appears in the owner's echoed prompt.
 */

/** Frame, cursor and checkbox glyphs the harnesses draw around dialog text. */
const DECORATION = /[│┃❯›●☐☒✔]/g

/** Text as a rule compares it: decoration removed, runs of whitespace collapsed, trimmed. */
export function normalizeScreenText(value: string): string {
  return value.replace(DECORATION, ' ').replace(/\s+/g, ' ').trim()
}

/** `N. Label`, optionally after a cursor; a description on the same row sits two or more spaces away (Codex). */
const OPTION_LINE = /^(\s*(?:[❯›]\s*)?)(\d{1,2})\.\s+(.*?)(?:\s{2,}\S.*)?$/

interface OptionLine {
  column: number
  digit: number
  label: string
}

function optionAt(lines: readonly string[], row: number): OptionLine | null {
  const match = OPTION_LINE.exec(lines[row] ?? '')
  if (!match) return null
  return { column: match[1]!.length, digit: Number(match[2]), label: normalizeScreenText(match[3]!) }
}

export type QuestionHarness = 'claude' | 'codex'

/** The entry each harness adds after the agent's own options. */
const OPTION_TRAILERS: Record<QuestionHarness, string> = {
  claude: 'Type something.',
  codex: 'None of the above'
}

/** Whether `first` starts exactly these options, in order, followed by the harness's own extra entry. */
function optionsFrom(lines: readonly string[], first: number, labels: readonly string[], trailer: string): boolean {
  const head = optionAt(lines, first)
  if (!head || head.digit !== 1 || head.label !== normalizeScreenText(labels[0] ?? '')) return false
  let expected = 2
  for (let row = first + 1; row < lines.length; row += 1) {
    const option = optionAt(lines, row)
    // Descriptions and wrapped text sit in other columns; only rows at the list's own column are entries.
    if (!option || option.column !== head.column) continue
    if (option.digit !== expected) return false
    if (expected <= labels.length) {
      if (option.label !== normalizeScreenText(labels[expected - 1]!)) return false
      expected += 1
      continue
    }
    return option.label === trailer
  }
  return false
}

/** The row where `text` starts when it ends on the row just above `row` (blank rows skipped), else null. */
function textEndingAbove(lines: readonly string[], row: number, text: string): number | null {
  const target = normalizeScreenText(text)
  let collected = ''
  for (let current = row - 1; current >= 0; current -= 1) {
    const piece = normalizeScreenText(lines[current]!)
    if (piece === '') continue
    collected = collected === '' ? piece : `${piece} ${collected}`
    if (collected === target) return current
    if (collected.length >= target.length) return null
  }
  return null
}

function nearestTextAbove(lines: readonly string[], row: number): string {
  for (let current = row - 1; current >= 0; current -= 1) {
    const piece = normalizeScreenText(lines[current]!)
    if (piece !== '') return piece
  }
  return ''
}

export interface ScreenQuestion {
  text: string
  options: ReadonlyArray<{ label: string }>
}

/**
 * Whether the screen shows this question as the live dialog: its text directly above its options, every
 * option in order, then the harness's extra entry. For Codex a step also checks `Question i/N` above it.
 */
export function questionOnScreen(
  lines: readonly string[],
  harness: QuestionHarness,
  question: ScreenQuestion,
  step?: { index: number; count: number }
): boolean {
  const labels = question.options.map((option) => option.label)
  for (let row = lines.length - 1; row >= 0; row -= 1) {
    if (!optionsFrom(lines, row, labels, OPTION_TRAILERS[harness])) continue
    const top = textEndingAbove(lines, row, question.text)
    if (top === null) continue
    if (harness === 'codex' && step && !nearestTextAbove(lines, top).startsWith(`Question ${step.index + 1}/${step.count} `)) continue
    return true
  }
  return false
}

/**
 * Claude's "Review your answers" screen after several questions. With `labels`, it must list exactly
 * those answers; returns the digit of "Submit answers", or null when the screen is not that review.
 */
export function claudeReviewOnScreen(
  lines: readonly string[],
  questions: readonly ScreenQuestion[],
  labels: readonly string[] | null
): number | null {
  let start = -1
  for (let row = lines.length - 1; row >= 0; row -= 1) {
    if (normalizeScreenText(lines[row]!) === 'Review your answers') {
      start = row
      break
    }
  }
  if (start < 0) return null
  let end = -1
  for (let row = start + 1; row < lines.length; row += 1) {
    if (normalizeScreenText(lines[row]!) === 'Ready to submit your answers?') {
      end = row
      break
    }
  }
  if (end < 0) return null
  const body = lines.slice(start + 1, end).map(normalizeScreenText).filter((piece) => piece !== '').join(' ')
  if (labels) {
    const expected = questions
      .map((question, index) => `${normalizeScreenText(question.text)} → ${normalizeScreenText(labels[index] ?? '')}`)
      .join(' ')
    if (body !== expected) return null
  } else if (!questions.every((question) => body.includes(normalizeScreenText(question.text)))) {
    return null
  }
  for (let row = end + 1; row < lines.length; row += 1) {
    const option = optionAt(lines, row)
    if (option) return option.label === 'Submit answers' ? option.digit : null
  }
  return null
}

/** The title Claude draws over each permission dialog BMN has driven; other tools are not recognised. */
const CLAUDE_PERMISSION_TITLES: Readonly<Record<string, string>> = { Bash: 'Bash command' }

/**
 * Claude's permission dialog for exactly this tool and command, with the digits of its plain "Yes"
 * (allow once) and "No" (deny); never the "always" entries. Null when the screen shows anything else.
 */
export function claudePermissionOnScreen(
  lines: readonly string[],
  tool: string,
  command: string
): { allow: number; deny: number } | null {
  const title = CLAUDE_PERMISSION_TITLES[tool]
  if (!title) return null
  let ask = -1
  for (let row = lines.length - 1; row >= 0; row -= 1) {
    if (normalizeScreenText(lines[row]!) === 'Do you want to proceed?') {
      ask = row
      break
    }
  }
  if (ask < 0) return null
  let top = -1
  for (let row = ask - 1; row >= 0; row -= 1) {
    if (normalizeScreenText(lines[row]!) === title) {
      top = row
      break
    }
  }
  if (top < 0) return null
  // The command must end on a row boundary: "touch a" never matches a dialog for "touch a b".
  const target = normalizeScreenText(command)
  let collected = ''
  let shown = false
  for (let row = top + 1; row < ask && collected.length < target.length; row += 1) {
    const piece = normalizeScreenText(lines[row]!)
    if (piece === '') continue
    collected = collected === '' ? piece : `${collected} ${piece}`
    shown = collected === target
  }
  if (!shown) return null
  let column: number | null = null
  let expected = 1
  const found: { allow?: number; deny?: number } = {}
  for (let row = ask + 1; row < lines.length; row += 1) {
    const option = optionAt(lines, row)
    if (!option || (column !== null && option.column !== column)) continue
    if (option.digit !== expected) break
    column = option.column
    expected += 1
    if (option.label === 'Yes') found.allow = option.digit
    if (option.label === 'No') found.deny = option.digit
  }
  return found.allow !== undefined && found.deny !== undefined ? { allow: found.allow, deny: found.deny } : null
}
