import { TERMINAL_PARSER_ATOM_BYTES } from '@bmn/protocol'

/**
 * Output bytes and the first offset from which a terminal parser that starts in its ground
 * state reads them, and all later output, as a parser that read every earlier byte does.
 * `freshStart` equals `bytes.byteLength` when that point is the end of the frame, and is null
 * when no such point is in the frame.
 */
export interface TerminalFrame {
  bytes: Uint8Array
  freshStart: number | null
}

// xterm 6.0 parser states (common/parser/Constants.ts).
const GROUND = 0
const ESCAPE = 1
const ESCAPE_INTERMEDIATE = 2
const CSI_ENTRY = 3
const CSI_PARAM = 4
const CSI_INTERMEDIATE = 5
const CSI_IGNORE = 6
const SOS_PM_APC_STRING = 7
const OSC_STRING = 8
const DCS_ENTRY = 9
const DCS_PARAM = 10
const DCS_IGNORE = 11
const DCS_INTERMEDIATE = 12
const DCS_PASSTHROUGH = 13
const STATES = 14
/** xterm reads every code point from U+00A0 up as this one column. */
const NON_ASCII = 0xa0
const COLUMNS = NON_ASCII + 1

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, index) => start + index)
}

/**
 * Next states of xterm 6.0's VT500 transition table (common/parser/EscapeSequenceParser.ts),
 * built by the same rules in the same order. ESC leads to ESCAPE from every state: where the
 * table ends an OSC or DCS string at ESC, the parser then enters ESCAPE anyway.
 */
export const TERMINAL_PARSER_TRANSITIONS = (() => {
  const table = new Uint8Array(STATES * COLUMNS).fill(GROUND)
  const add = (codes: readonly number[], state: number, next: number): void => {
    for (const code of codes) table[state * COLUMNS + code] = next
  }
  const printables = range(0x20, 0x7f)
  const executables = [...range(0x00, 0x18), 0x19, ...range(0x1c, 0x20)]
  add(printables, GROUND, GROUND)
  for (let state = 0; state < STATES; state += 1) {
    add([0x18, 0x1a, 0x99, 0x9a, ...range(0x80, 0x90), ...range(0x90, 0x98), 0x9c], state, GROUND)
    add([0x1b], state, ESCAPE)
    add([0x9d], state, OSC_STRING)
    add([0x98, 0x9e, 0x9f], state, SOS_PM_APC_STRING)
    add([0x9b], state, CSI_ENTRY)
    add([0x90], state, DCS_ENTRY)
  }
  add(executables, GROUND, GROUND)
  for (const state of [ESCAPE, CSI_ENTRY, CSI_PARAM, CSI_INTERMEDIATE, ESCAPE_INTERMEDIATE]) {
    add(executables, state, state)
    add([0x7f], state, state)
  }
  add(executables, CSI_IGNORE, CSI_IGNORE)
  add(executables, OSC_STRING, OSC_STRING)
  add([0x5d], ESCAPE, OSC_STRING)
  add([...printables, 0x7f, ...range(0x1c, 0x20)], OSC_STRING, OSC_STRING)
  add([0x9c, 0x18, 0x1a, 0x07], OSC_STRING, GROUND)
  add([0x58, 0x5e, 0x5f], ESCAPE, SOS_PM_APC_STRING)
  add([...printables, ...executables, 0x7f], SOS_PM_APC_STRING, SOS_PM_APC_STRING)
  add([0x9c], SOS_PM_APC_STRING, GROUND)
  add([0x5b], ESCAPE, CSI_ENTRY)
  add(range(0x40, 0x7f), CSI_ENTRY, GROUND)
  add(range(0x30, 0x40), CSI_ENTRY, CSI_PARAM)
  add(range(0x30, 0x3c), CSI_PARAM, CSI_PARAM)
  add(range(0x40, 0x7f), CSI_PARAM, GROUND)
  add([0x3c, 0x3d, 0x3e, 0x3f], CSI_PARAM, CSI_IGNORE)
  add([...range(0x20, 0x40), 0x7f], CSI_IGNORE, CSI_IGNORE)
  add(range(0x40, 0x7f), CSI_IGNORE, GROUND)
  add(range(0x20, 0x30), CSI_ENTRY, CSI_INTERMEDIATE)
  add(range(0x20, 0x30), CSI_INTERMEDIATE, CSI_INTERMEDIATE)
  add(range(0x30, 0x40), CSI_INTERMEDIATE, CSI_IGNORE)
  add(range(0x40, 0x7f), CSI_INTERMEDIATE, GROUND)
  add(range(0x20, 0x30), CSI_PARAM, CSI_INTERMEDIATE)
  add(range(0x20, 0x30), ESCAPE, ESCAPE_INTERMEDIATE)
  add(range(0x20, 0x30), ESCAPE_INTERMEDIATE, ESCAPE_INTERMEDIATE)
  add(range(0x30, 0x7f), ESCAPE_INTERMEDIATE, GROUND)
  add([...range(0x30, 0x50), ...range(0x51, 0x58), 0x59, 0x5a, 0x5c, ...range(0x60, 0x7f)], ESCAPE, GROUND)
  add([0x50], ESCAPE, DCS_ENTRY)
  add([...executables, 0x7f], DCS_ENTRY, DCS_ENTRY)
  add(range(0x20, 0x30), DCS_ENTRY, DCS_INTERMEDIATE)
  add(range(0x30, 0x40), DCS_ENTRY, DCS_PARAM)
  add([...executables, ...range(0x20, 0x80)], DCS_IGNORE, DCS_IGNORE)
  add([...executables, 0x7f, ...range(0x30, 0x3c)], DCS_PARAM, DCS_PARAM)
  add([0x3c, 0x3d, 0x3e, 0x3f], DCS_PARAM, DCS_IGNORE)
  add(range(0x20, 0x30), DCS_PARAM, DCS_INTERMEDIATE)
  add([...executables, 0x7f, ...range(0x20, 0x30)], DCS_INTERMEDIATE, DCS_INTERMEDIATE)
  add(range(0x30, 0x40), DCS_INTERMEDIATE, DCS_IGNORE)
  add(range(0x40, 0x7f), DCS_INTERMEDIATE, DCS_PASSTHROUGH)
  add(range(0x40, 0x7f), DCS_PARAM, DCS_PASSTHROUGH)
  add(range(0x40, 0x7f), DCS_ENTRY, DCS_PASSTHROUGH)
  add([...executables, ...printables, 0x7f], DCS_PASSTHROUGH, DCS_PASSTHROUGH)
  add([0x9c, 0x18, 0x1a], DCS_PASSTHROUGH, GROUND)
  for (const state of [GROUND, OSC_STRING, CSI_IGNORE, DCS_IGNORE, DCS_PASSTHROUGH]) add([NON_ASCII], state, state)
  return table
})()

/**
 * ESC and the C1 introducers lead every parser state to the same freshly cleared state, so a
 * ground-state parser that starts just before one agrees from there on with the stream's parser.
 */
function restartsParser(codePoint: number): boolean {
  return codePoint === 0x1b || codePoint === 0x90 || codePoint === 0x9b || codePoint === 0x9d ||
    codePoint === 0x98 || codePoint === 0x9e || codePoint === 0x9f
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.byteLength + second.byteLength)
  joined.set(first)
  joined.set(second, first.byteLength)
  return joined
}

/**
 * Follows the PTY stream as xterm's parser reads it: bytes decoded as xterm decodes UTF-8,
 * code points through xterm's transition table. Frames end only between code points; an
 * escape sequence or string is retained until it ends, up to one parser atom, so it usually
 * reaches a view whole. A longer one continues in later frames, and each frame records where
 * a view that starts with it can begin reading.
 */
export class TerminalByteFramer {
  private state = GROUND
  /** Bytes after the end of the last frame. */
  private held: Uint8Array = new Uint8Array()
  /** First offset in the bytes after the last frame where a ground-state parser may start. */
  private fresh: number | null = 0
  /** Where the next frame may end, and whether a ground-state parser may start there. */
  private frameEnd = 0
  private frameEndFresh = true
  /** A UTF-8 sequence being decoded: its start offset, length, bytes read and value so far. */
  private sequenceStart = 0
  private sequenceLength = 0
  private sequenceRead = 0
  private sequenceValue = 0

  get pendingBytes(): number {
    return this.held.byteLength
  }

  /** xterm's parser state after every code point read so far. */
  get parserState(): number {
    return this.state
  }

  push(bytes: Uint8Array): TerminalFrame[] {
    const work = this.held.byteLength === 0 ? bytes : concat(this.held, bytes)
    this.frameEnd = 0
    this.frameEndFresh = this.fresh === 0
    for (let index = this.held.byteLength; index < work.byteLength; index += 1) {
      const byte = work[index]!
      if (this.sequenceLength === 0) {
        if (byte < 0x80) {
          this.codePoint(index, index + 1, byte)
          continue
        }
        const length = (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 0
        if (length === 0) {
          this.codePoint(index, index + 1, -1)
          continue
        }
        this.sequenceStart = index
        this.sequenceLength = length
        this.sequenceRead = 1
        this.sequenceValue = byte & (length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07)
        continue
      }
      if ((byte & 0xc0) !== 0x80) {
        // As in xterm, a byte that cannot continue the sequence drops it and is read afresh.
        this.sequenceLength = 0
        this.codePoint(this.sequenceStart, index, -1)
        index -= 1
        continue
      }
      this.sequenceValue = (this.sequenceValue << 6) | (byte & 0x3f)
      this.sequenceRead += 1
      if (this.sequenceRead < this.sequenceLength) continue
      const value = this.sequenceValue
      const length = this.sequenceLength
      this.sequenceLength = 0
      const valid = length === 2 ? value >= 0x80
        : length === 3 ? value >= 0x800 && (value < 0xd800 || value > 0xdfff) && value !== 0xfeff
          : value >= 0x10000 && value <= 0x10ffff
      this.codePoint(this.sequenceStart, index + 1, valid ? value : -1)
    }
    if (this.sequenceLength > 0 && work.byteLength - this.frameEnd > TERMINAL_PARSER_ATOM_BYTES) {
      this.split(this.sequenceStart)
    }
    return this.emit(work)
  }

  /** Emits every retained byte, for a stream that has ended. */
  flush(): TerminalFrame[] {
    this.frameEnd = this.held.byteLength
    this.frameEndFresh = false
    this.sequenceLength = 0
    return this.emit(this.held)
  }

  /** Reads one decoded code point, or bytes xterm's decoder drops when `codePoint` is -1. */
  private codePoint(start: number, end: number, codePoint: number): void {
    if (end - this.frameEnd > TERMINAL_PARSER_ATOM_BYTES) this.split(start)
    if (codePoint >= 0) {
      if (restartsParser(codePoint)) this.freshAt(start)
      this.state = TERMINAL_PARSER_TRANSITIONS[this.state * COLUMNS + Math.min(codePoint, NON_ASCII)]!
    }
    if (this.state === GROUND) this.freshAt(end)
  }

  private freshAt(offset: number): void {
    this.frameEnd = offset
    this.frameEndFresh = true
    this.fresh ??= offset
  }

  /** Ends a frame inside a sequence, so no more than one parser atom is retained. */
  private split(offset: number): void {
    this.frameEnd = offset
    this.frameEndFresh = false
  }

  private emit(work: Uint8Array): TerminalFrame[] {
    const end = this.frameEnd
    this.held = work.slice(end)
    this.sequenceStart -= end
    if (end === 0) return []
    const frame = { bytes: work.slice(0, end), freshStart: this.fresh }
    this.fresh = this.frameEndFresh ? 0 : null
    return [frame]
  }
}
