import { Terminal } from '@xterm/headless'

interface ParserInternals {
  reset(): void
  currentState: number
  _collect: number
  _params: { toArray(): unknown[] }
  _transitions: { table: Uint8Array }
}

interface InputHandlerInternals {
  parse(data: Uint8Array): void
  _parser: ParserInternals
  _utf8Decoder: { interim: Uint8Array; clear(): void }
}

const GROUND = 0
const SOS_PM_APC_STRING = 7
const OSC_STRING = 8
const DCS_PASSTHROUGH = 13
const PARSE_BYTES = 65_536

/**
 * xterm 6.0's own UTF-8 decoder and escape sequence parser, driven synchronously through the
 * headless terminal's input handler: the reference for how a terminal view reads output.
 */
export class XtermParser {
  private readonly terminal: Terminal
  private readonly input: InputHandlerInternals

  constructor(size: { cols?: number; rows?: number; scrollback?: number } = {}) {
    this.terminal = new Terminal({ cols: 80, rows: 4, ...size, allowProposedApi: true, logLevel: 'off' })
    this.input = (this.terminal as unknown as { _core: { _inputHandler: InputHandlerInternals } })._core._inputHandler
  }

  /** Reads bytes as one xterm write does, cut wherever xterm itself cuts a long write. */
  write(bytes: Uint8Array): void {
    this.input.parse(bytes)
  }

  /** Every buffer line and the cursor: what the terminal shows after the bytes read so far. */
  get screen(): string {
    const buffer = this.terminal.buffer.active
    const lines = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true))
    return [...lines, `cursor ${buffer.cursorX},${buffer.cursorY}`].join('\n')
  }

  /**
   * xterm splits long writes at fixed offsets, and its decoder can misread a UTF-8 sequence
   * split there, so long input is split before an ASCII byte, where any split reads as the
   * unsplit bytes do.
   */
  parse(bytes: Uint8Array): void {
    let start = 0
    while (start < bytes.byteLength) {
      let end = Math.min(bytes.byteLength, start + PARSE_BYTES)
      if (end < bytes.byteLength) {
        let cut = end
        while (cut > start && bytes[cut]! >= 0x80) cut -= 1
        if (cut > start) end = cut
      }
      this.input.parse(bytes.subarray(start, end))
      start = end
    }
  }

  /** Returns to the state of a new parser: ground state, nothing collected, nothing decoded. */
  reset(): void {
    this.input._parser.reset()
    this.input._utf8Decoder.clear()
  }

  get state(): number {
    return this.input._parser.currentState
  }

  /** Whether the decoder holds the start of a UTF-8 sequence. */
  get decoding(): boolean {
    return this.input._utf8Decoder.interim[0] !== 0
  }

  /** Everything that decides how the parser reads the bytes that follow. */
  get snapshot(): string {
    const parser = this.input._parser
    const state = parser.currentState
    // These states read no intermediates or parameters, and every sequence that does clears them first.
    if ([GROUND, SOS_PM_APC_STRING, OSC_STRING, DCS_PASSTHROUGH].includes(state)) return String(state)
    return JSON.stringify([state, parser._collect, parser._params.toArray()])
  }

  get transitions(): Uint8Array {
    return this.input._parser._transitions.table
  }

  dispose(): void {
    this.terminal.dispose()
  }
}

interface Utf8Decoder {
  interim: Uint8Array
  decode(input: Uint8Array, target: Uint32Array): number
}

/**
 * A new instance of xterm 6.0's own UTF-8 decoder, the one a view's input handler uses: returns
 * the code points each call decodes, and keeps the bytes of a character left open.
 */
export function xtermUtf8Decoder(): { decode(bytes: Uint8Array): number[]; readonly interim: number[] } {
  const terminal = new Terminal({ allowProposedApi: true, logLevel: 'off' })
  const Decoder = (terminal as unknown as { _core: { _inputHandler: InputHandlerInternals } })
    ._core._inputHandler._utf8Decoder.constructor as new () => Utf8Decoder
  terminal.dispose()
  const decoder = new Decoder()
  return {
    decode: (bytes) => {
      const target = new Uint32Array(bytes.byteLength + 3)
      return [...target.subarray(0, decoder.decode(bytes, target))]
    },
    get interim() {
      return [...decoder.interim]
    }
  }
}

let groundSnapshot: string | undefined

function freshSnapshot(): string {
  if (groundSnapshot === undefined) {
    const fresh = new XtermParser()
    groundSnapshot = fresh.snapshot
    fresh.dispose()
  }
  return groundSnapshot
}

/**
 * Reads one stream with xterm and checks points where a view whose parser starts fresh, in
 * its ground state, begins reading it.
 */
export class XtermStream {
  readonly parser = new XtermParser()
  private readonly fresh = new XtermParser()
  private position = 0

  constructor(private readonly stream: Uint8Array) {}

  readTo(offset: number): void {
    if (offset < this.position) throw new Error(`already read past ${offset}`)
    this.parser.parse(this.stream.subarray(this.position, offset))
    this.position = offset
  }

  /**
   * Whether the decoder reads what follows `offset` as a new one does: it holds no bytes, or
   * holds the start of a sequence that the byte at `offset` cannot continue, so it drops them.
   */
  decoderNeutralAt(offset: number): boolean {
    this.readTo(offset)
    const byte = this.stream[offset]
    return !this.parser.decoding || byte === undefined || (byte & 0xc0) !== 0x80
  }

  /** Whether a fresh parser already reads what follows `offset` as this one does. */
  convergedAt(offset: number): boolean {
    return this.decoderNeutralAt(offset) && freshSnapshot() === this.parser.snapshot
  }

  /**
   * Why a fresh parser starting at `offset` would read the stream differently, if it would.
   * It must agree at `offset` or right after its first code point, and that code point must be
   * ESC or a C1 string or sequence introducer, which neither parser prints or executes.
   */
  freshStartProblem(offset: number): string | undefined {
    if (this.convergedAt(offset)) return undefined
    if (!this.decoderNeutralAt(offset)) return `offset ${offset} is inside a UTF-8 sequence`
    const byte = this.stream[offset]
    const next = this.stream[offset + 1] ?? 0
    const length = byte === 0x1b ? 1
      : byte === 0xc2 && [0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f].includes(next) ? 2
        : 0
    if (length === 0) {
      return `at offset ${offset} the stream's parser is in ${this.parser.snapshot} and byte ${byte} does not restart it`
    }
    this.fresh.reset()
    this.fresh.parse(this.stream.subarray(offset, offset + length))
    this.readTo(offset + length)
    return this.fresh.snapshot === this.parser.snapshot
      ? undefined
      : `after offset ${offset} the stream's parser is in ${this.parser.snapshot}, a fresh one in ${this.fresh.snapshot}`
  }

  dispose(): void {
    this.parser.dispose()
    this.fresh.dispose()
  }
}
