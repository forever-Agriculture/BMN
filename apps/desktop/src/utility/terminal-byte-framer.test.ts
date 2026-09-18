import { describe, expect, it } from 'vitest'
import { TERMINAL_PARSER_ATOM_BYTES } from '@bmn/protocol'
import { TerminalByteFramer } from './terminal-byte-framer'

const encoder = new TextEncoder()

describe('terminal byte retention framing', () => {
  it.each([
    ['UTF-8', encoder.encode('Ї')],
    ['CSI', encoder.encode('\u001b[31m')],
    ['OSC with BEL', encoder.encode('\u001b]0;BMN\u0007')],
    ['OSC with ST', encoder.encode('\u001b]0;BMN\u001b\\')],
    ['DCS', encoder.encode('\u001bP1;2|payload\u001b\\')]
  ])('retains a complete %s sequence as one frame across every byte split', (_name, sequence) => {
    const framer = new TerminalByteFramer()
    const emitted: Uint8Array[] = []

    for (const [index, byte] of sequence.entries()) {
      emitted.push(...framer.push(Uint8Array.of(byte)))
      if (index < sequence.byteLength - 1) expect(emitted).toEqual([])
    }

    expect(emitted).toEqual([sequence])
    expect(framer.pendingBytes).toBe(0)
  })

  it('emits safe text while retaining a split CSI prefix for its continuation', () => {
    const framer = new TerminalByteFramer()

    expect(framer.push(encoder.encode('before\u001b[31'))).toEqual([encoder.encode('before')])
    expect(framer.pendingBytes).toBe(4)
    expect(framer.push(encoder.encode('mX'))).toEqual([encoder.encode('\u001b[31mX')])
  })

  it.each([
    ['repeated ESC', Uint8Array.of(0x1b), 0x1b],
    ['CSI', Uint8Array.of(0x1b, 0x5b), 0x30],
    ['OSC', Uint8Array.of(0x1b, 0x5d), 0x61],
    ['DCS', Uint8Array.of(0x1b, 0x50), 0x61]
  ])('emits an overlong %s atom without byte loss and returns to ground', (_name, prefix, fill) => {
    const framer = new TerminalByteFramer()
    const atom = new Uint8Array(TERMINAL_PARSER_ATOM_BYTES + 1)
    atom.fill(fill)
    atom.set(prefix)

    expect(framer.push(atom)).toEqual([atom])
    expect(framer.pendingBytes).toBe(0)
    expect(framer.push(encoder.encode('ok'))).toEqual([encoder.encode('ok')])
  })

  it.each([
    ['OSC', encoder.encode('\u001b]0;Модуль'), Uint8Array.of(0x07)],
    ['DCS', encoder.encode('\u001bP1;2|Модуль'), Uint8Array.of(0x1b, 0x5c)]
  ])('does not treat a UTF-8 0x9c byte as the end of %s', (_name, body, terminator) => {
    const framer = new TerminalByteFramer()
    expect([...body]).toContain(0x9c)
    expect(framer.push(body)).toEqual([])

    expect(framer.push(terminator)).toEqual([new Uint8Array([...body, ...terminator])])
  })

  it('passes ambiguous raw C1 bytes through while preserving 7-bit control handling', () => {
    const framer = new TerminalByteFramer()
    const c1Bytes = Uint8Array.of(0x90, 0x9b, 0x9c, 0x9d)

    expect(framer.push(c1Bytes)).toEqual([c1Bytes])
    expect(framer.pendingBytes).toBe(0)
  })

  it('flushes an incomplete atom byte-for-byte and resets the parser', () => {
    const framer = new TerminalByteFramer()
    const incomplete = encoder.encode('\u001b]0;unfinished М')

    expect(framer.push(incomplete)).toEqual([])
    expect(framer.flush()).toEqual([incomplete])
    expect(framer.pendingBytes).toBe(0)
    expect(framer.push(encoder.encode('next'))).toEqual([encoder.encode('next')])
  })
})
