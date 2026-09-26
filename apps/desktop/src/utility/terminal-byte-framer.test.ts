import { afterAll, describe, expect, it } from 'vitest'
import { TERMINAL_PARSER_ATOM_BYTES } from '@bmn/protocol'
import {
  TERMINAL_PARSER_TRANSITIONS,
  TerminalByteFramer,
  type TerminalFrame
} from './terminal-byte-framer'
import { generatedTerminalOutput, pick, seeded } from './test-fixtures/terminal-output'
import { XtermParser, XtermStream } from './test-fixtures/xterm-parser'

const encoder = new TextEncoder()
const bytesOf = (frames: TerminalFrame[]) => frames.map((frame) => frame.bytes)
const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? [...encoder.encode(part)] : part)))

/** Prefixes that bring xterm's parser into each of its 14 states, in state order. */
const STATE_PREFIXES = [
  '', '\u001b', '\u001b(', '\u001b[', '\u001b[1', '\u001b[!', '\u001b[1?', '\u001b_', '\u001b]',
  '\u001bP', '\u001bP1', '\u001bP1?', '\u001bP!', '\u001bPq'
]
const EXECUTABLE_C0 = [...Array.from({ length: 0x18 }, (_, code) => code), 0x19, 0x1c, 0x1d, 0x1e, 0x1f]

/** Pushes `stream` in the given reads and returns every frame with its offset in the stream. */
function frame(stream: Uint8Array, reads: number[]): { frames: { offset: number; frame: TerminalFrame }[]; pending: number[] } {
  const framer = new TerminalByteFramer()
  const frames: { offset: number; frame: TerminalFrame }[] = []
  const pending: number[] = []
  let offset = 0
  let read = 0
  const collect = (emitted: TerminalFrame[]) => {
    for (const emittedFrame of emitted) {
      frames.push({ offset, frame: emittedFrame })
      offset += emittedFrame.bytes.byteLength
    }
  }
  for (const length of reads) {
    collect(framer.push(stream.subarray(read, read + length)))
    pending.push(framer.pendingBytes)
    read += length
  }
  collect(framer.flush())
  return { frames, pending }
}

function randomReads(random: () => number, total: number, largest: number): number[] {
  const reads: number[] = []
  for (let remaining = total; remaining > 0;) {
    const length = Math.min(remaining, random() < 0.3 ? 1 + Math.floor(random() * 8) : 1 + Math.floor(random() * largest))
    reads.push(length)
    remaining -= length
  }
  return reads
}

describe('terminal byte framing against xterm 6.0', () => {
  const parsers: XtermParser[] = []
  const parser = () => {
    const created = new XtermParser()
    parsers.push(created)
    return created
  }
  afterAll(() => {
    for (const created of parsers) created.dispose()
  })

  it('follows the transition table xterm parses with', () => {
    const table = parser().transitions
    const ESCAPE = 1
    const OSC_END = 6
    const DCS_UNHOOK = 14
    for (let state = 0; state < 14; state += 1) {
      for (let code = 0; code <= 0xa0; code += 1) {
        const transition = table[(state << 8) | code]!
        // xterm enters ESCAPE after an OSC or DCS string that ESC ends, whatever the table's next state.
        const expected = code === 0x1b && [OSC_END, DCS_UNHOOK].includes(transition >> 4) ? ESCAPE : transition & 15
        expect(TERMINAL_PARSER_TRANSITIONS[state * 0xa1 + code], `state ${state} code ${code}`).toBe(expected)
      }
    }
  })

  it('reaches the state xterm reaches for every code point class from every state', () => {
    const expected = parser()
    for (const [state, prefix] of STATE_PREFIXES.entries()) {
      expected.reset()
      expected.parse(encoder.encode(prefix))
      expect(expected.state, `prefix for state ${state}`).toBe(state)
      for (let code = 0; code <= 0xa0; code += 1) {
        const input = bytes(prefix, code < 0x80 ? [code] : code < 0xa0 ? [0xc2, code] : 'é')
        expected.reset()
        expected.parse(input)
        const framer = new TerminalByteFramer()
        framer.push(input)
        expect(framer.parserState, `state ${state} then code ${code}`).toBe(expected.state)
      }
    }
  })

  it('decodes UTF-8 as xterm does across every read split, malformed input included', () => {
    const alphabet = [
      [0x1b], [0x5b], [0x50], [0x5d], [0x5c], [0x5f], [0x31], [0x3b], [0x3f], [0x20], [0x71], [0x6d],
      [0x7e], [0x07], [0x0a], [0x18], [0x1a], [0x7f], [0xc2, 0x90], [0xc2, 0x9b], [0xc2, 0x9c], [0xc2, 0x9d],
      [0xc2, 0x9f], [0xd0, 0x9c], [0xe2, 0x80, 0x94], [0xe2, 0x80, 0x80], [0xf0, 0x9f, 0x98, 0x80],
      [0xef, 0xbb, 0xbf], [0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0x80], [0x9c], [0xc2], [0xe2],
      [0xe2, 0x80], [0xf0, 0x9f], [0xf5], [0xff]
    ]
    const random = seeded(2809)
    const expected = parser()
    for (let run = 0; run < 3_000; run += 1) {
      const input = Uint8Array.from(Array.from({ length: 1 + Math.floor(random() * 24) }, () => pick(random, alphabet)).flat())
      const framer = new TerminalByteFramer()
      let read = 0
      while (read < input.byteLength) {
        const end = Math.min(input.byteLength, read + 1 + Math.floor(random() * 5))
        framer.push(input.subarray(read, end))
        read = end
        // A fresh reference reads the prefix in one write, as a stream that was never split.
        expected.reset()
        expected.parse(input.subarray(0, read))
        expect(framer.parserState, `run ${run}: ${JSON.stringify([...input.subarray(0, read)])}`).toBe(expected.state)
      }
    }
  })

  it.each(Array.from({ length: 24 }, (_, index) => index + 1))(
    'frames random output losslessly, with every recorded fresh start where a fresh xterm agrees (seed %i)',
    (seed) => {
      const random = seeded(seed)
      const stream = generatedTerminalOutput(random, { segments: 60, largestString: 200_000 })
      const { frames, pending } = frame(stream, randomReads(random, stream.byteLength, pick(random, [64, 4_096, 70_000])))
      expect(Buffer.concat(frames.map(({ frame: emitted }) => emitted.bytes)).equals(stream), 'frames rebuild the stream').toBe(true)
      expect(Math.max(...pending)).toBeLessThanOrEqual(TERMINAL_PARSER_ATOM_BYTES)
      const reference = new XtermStream(stream)
      try {
        for (const [index, { offset, frame: emitted }] of frames.entries()) {
          const label = `seed ${seed}, frame at ${offset}`
          const length = emitted.bytes.byteLength
          if (reference.convergedAt(offset)) expect(emitted.freshStart, label).toBe(0)
          expect(reference.decoderNeutralAt(offset), `${label} starts inside a UTF-8 sequence`).toBe(true)
          if (emitted.freshStart === null) {
            reference.readTo(offset + length)
            expect(reference.parser.state, `${label} has no fresh start but ends in ground`).not.toBe(0)
          } else if (emitted.freshStart === length && index < frames.length - 1) {
            // The next frame then starts where a fresh parser may start, and its own check covers that point.
            expect(frames[index + 1]!.frame.freshStart, label).toBe(0)
          } else {
            expect(emitted.freshStart, label).toBeLessThanOrEqual(length)
            expect(reference.freshStartProblem(offset + emitted.freshStart), label).toBeUndefined()
          }
        }
      } finally {
        reference.dispose()
      }
    }
  )

  it.each([
    ['UTF-8', encoder.encode('Ї')],
    ['CSI', encoder.encode('\u001b[31m')],
    ['OSC with BEL', encoder.encode('\u001b]0;BMN\u0007')],
    ['C1 CSI', bytes([0xc2, 0x9b], '31m')]
  ])('retains a complete %s sequence as one frame across every byte split', (_name, sequence) => {
    const framer = new TerminalByteFramer()
    const emitted: TerminalFrame[] = []

    for (const [index, byte] of sequence.entries()) {
      emitted.push(...framer.push(Uint8Array.of(byte)))
      if (index < sequence.byteLength - 1) expect(emitted).toEqual([])
    }

    expect(emitted).toEqual([{ bytes: sequence, freshStart: 0 }])
    expect(framer.pendingBytes).toBe(0)
  })

  it.each([
    ['OSC', '\u001b]0;BMN'],
    ['DCS', '\u001bP1;2|payload']
  ])('retains a %s until the ESC that ends it, which starts the next frame', (_name, body) => {
    const framer = new TerminalByteFramer()
    const emitted: TerminalFrame[] = []
    for (const byte of bytes(body, '\u001b\\')) emitted.push(...framer.push(Uint8Array.of(byte)))

    expect(emitted).toEqual([
      { bytes: encoder.encode(body), freshStart: 0 },
      { bytes: encoder.encode('\u001b\\'), freshStart: 0 }
    ])
  })

  it('emits safe text while retaining a split CSI prefix for its continuation', () => {
    const framer = new TerminalByteFramer()

    expect(framer.push(encoder.encode('before\u001b[31'))).toEqual([{ bytes: encoder.encode('before'), freshStart: 0 }])
    expect(framer.pendingBytes).toBe(4)
    expect(framer.push(encoder.encode('mX'))).toEqual([{ bytes: encoder.encode('\u001b[31mX'), freshStart: 0 }])
  })

  it('splits an overlong CSI at the parser atom and starts the next view after its final byte', () => {
    const framer = new TerminalByteFramer()
    const atom = new Uint8Array(TERMINAL_PARSER_ATOM_BYTES + 1)
    atom.fill(0x30)
    atom.set([0x1b, 0x5b])

    expect(framer.push(atom)).toEqual([{ bytes: atom.subarray(0, TERMINAL_PARSER_ATOM_BYTES), freshStart: 0 }])
    expect(framer.pendingBytes).toBe(1)
    // The CSI is still open: `m` ends it, and only `ok` is text.
    expect(framer.push(encoder.encode('mok'))).toEqual([{ bytes: encoder.encode('0mok'), freshStart: 2 }])
  })

  it('keeps only the latest of repeated ESC bytes pending, as each restarts the sequence', () => {
    const framer = new TerminalByteFramer()
    const escapes = new Uint8Array(TERMINAL_PARSER_ATOM_BYTES + 1).fill(0x1b)

    expect(framer.push(escapes)).toEqual([{ bytes: escapes.subarray(1), freshStart: 0 }])
    expect(framer.pendingBytes).toBe(1)
    expect(framer.push(encoder.encode('[1mok'))).toEqual([{ bytes: encoder.encode('\u001b[1mok'), freshStart: 0 }])
  })

  it.each([
    ['CAN', '\u0018'],
    ['SUB', '\u001a'],
    ['a CSI', '[0m'],
    ['a new DCS', 'Pq~\u001b\\'],
    ['a repeated ESC', '\u001b[0m']
  ])('ends a string at ESC followed by %s and keeps what follows', (_name, after) => {
    const framer = new TerminalByteFramer()
    const string = encoder.encode('\u001bPq~~')
    const rest = encoder.encode(`\u001b${after}text`)

    expect(framer.push(string)).toEqual([])
    expect(framer.push(rest)).toEqual([{ bytes: Uint8Array.of(...string, ...rest), freshStart: 0 }])
    expect(framer.pendingBytes).toBe(0)
  })

  it.each([
    ['OSC', '\u001b]', 0x61, Uint8Array.of(0x07), 6],
    ['DCS', '\u001bPq', 0x7e, Uint8Array.of(0x1b, 0x5c), 5]
  ] as const)('streams an overlong %s and records where it ends', (_name, header, fill, end, freshStart) => {
    const framer = new TerminalByteFramer()
    const atom = new Uint8Array(TERMINAL_PARSER_ATOM_BYTES + 1).fill(fill)
    atom.set(encoder.encode(header))

    expect(framer.push(atom)).toEqual([{ bytes: atom.subarray(0, TERMINAL_PARSER_ATOM_BYTES), freshStart: 0 }])
    expect(framer.push(encoder.encode('body'))).toEqual([])
    expect(framer.push(end)).toEqual([{ bytes: Uint8Array.of(fill, ...encoder.encode('body'), ...end), freshStart }])
    expect(framer.push(encoder.encode('ok'))).toEqual([{ bytes: encoder.encode('ok'), freshStart: 0 }])
  })

  it.each([
    ['OSC', encoder.encode('\u001b]0;Модуль'), Uint8Array.of(0x07)],
    ['DCS', encoder.encode('\u001bP1;2|Модуль'), Uint8Array.of(0x1b, 0x5c)]
  ])('does not treat the 0x9c byte of a UTF-8 code point as the end of %s', (_name, body, terminator) => {
    const framer = new TerminalByteFramer()
    expect([...body]).toContain(0x9c)
    expect(framer.push(body)).toEqual([])

    expect(bytesOf(framer.push(terminator))).toEqual([new Uint8Array([...body, ...terminator])])
  })

  it('ends a string at a UTF-8 encoded ST, as xterm does', () => {
    const framer = new TerminalByteFramer()

    expect(framer.push(bytes('\u001bPq~~', [0xc2, 0x9c], 'text'))).toEqual([
      { bytes: bytes('\u001bPq~~', [0xc2, 0x9c], 'text'), freshStart: 0 }
    ])
    expect(framer.parserState).toBe(0)
  })

  it('passes raw C1 bytes, which xterm drops as malformed UTF-8, as text', () => {
    const framer = new TerminalByteFramer()
    const c1Bytes = Uint8Array.of(0x90, 0x9b, 0x9c, 0x9d)

    expect(framer.push(c1Bytes)).toEqual([{ bytes: c1Bytes, freshStart: 0 }])
    expect(framer.pendingBytes).toBe(0)
  })

  it('flushes retained bytes with their fresh start and keeps the parser state', () => {
    const framer = new TerminalByteFramer()
    const incomplete = encoder.encode('\u001b]0;unfinished М')

    expect(framer.push(incomplete)).toEqual([])
    expect(framer.flush()).toEqual([{ bytes: incomplete, freshStart: 0 }])
    expect(framer.pendingBytes).toBe(0)
    // The OSC is still open for anything that reads on: BEL ends it.
    expect(framer.push(encoder.encode('next\u0007ok'))).toEqual([{ bytes: encoder.encode('next\u0007ok'), freshStart: 5 }])
  })

  it('retains every byte of a Sixel frame larger than the parser atom across PTY reads', () => {
    const image = encoder.encode(`\u001bP9;1;0q"1;1;60;75#1;2;100;0;0#1${'!60~'.repeat(18_000)}\u001b\\`)
    expect(image.byteLength).toBeGreaterThan(TERMINAL_PARSER_ATOM_BYTES)
    const framer = new TerminalByteFramer()
    const emitted: Uint8Array[] = []
    for (let offset = 0; offset < image.byteLength; offset += 4096) {
      emitted.push(...bytesOf(framer.push(image.subarray(offset, offset + 4096))))
      expect(framer.pendingBytes).toBeLessThanOrEqual(TERMINAL_PARSER_ATOM_BYTES)
    }
    emitted.push(...bytesOf(framer.push(encoder.encode('text after image'))))
    expect(Buffer.concat(emitted)).toEqual(Buffer.concat([image, encoder.encode('text after image')]))
    expect(framer.pendingBytes).toBe(0)
  })

  it('never splits a UTF-8 code point to hold the parser atom', () => {
    const framer = new TerminalByteFramer()
    const header = encoder.encode('\u001b]0;')
    const body = new Uint8Array(TERMINAL_PARSER_ATOM_BYTES - header.byteLength - 1).fill(0x61)
    const frames = framer.push(bytes([...header], [...body], 'Ї'))

    expect(frames).toEqual([{ bytes: bytes([...header], [...body]), freshStart: 0 }])
    expect(framer.pendingBytes).toBe(2)
  })

  // Contexts where xterm executes C0 controls and ignores DEL without leaving the sequence.
  it.each([
    ['ESC', '\u001b'],
    ['an ESC intermediate', '\u001b('],
    ['a CSI', '\u001b[1']
  ])('keeps a string that ESC starts after %s and a C0 control or DEL out of a fresh view', (_name, opener) => {
    for (const control of [...EXECUTABLE_C0, 0x7f]) {
      for (const edge of [false, true]) {
        const image = encoder.encode(`\u001bPq${'~'.repeat(edge ? TERMINAL_PARSER_ATOM_BYTES - 3 : 100)}`)
        const tail = bytes(opener, [control], 'PqLEAK\u001b\\after')
        const stream = bytes([...image], [...tail])
        // The read after the image ends right after the control, where a frame would end if the
        // control ended the sequence.
        const { frames } = frame(stream, [image.byteLength, opener.length + 1, tail.byteLength - opener.length - 1])
        const reference = new XtermStream(stream)
        try {
          for (const { offset, frame: emitted } of frames) {
            if (emitted.freshStart === null) continue
            const label = `${opener} ${control} edge ${edge} frame at ${offset}`
            expect(reference.freshStartProblem(offset + emitted.freshStart), label).toBeUndefined()
          }
        } finally {
          reference.dispose()
        }
      }
    }
  })
})
