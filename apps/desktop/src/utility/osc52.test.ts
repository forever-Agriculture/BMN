// MODULE: osc52.test.ts - OSC 52 writes read from live output: selections, terminators, limits (Story 42.1)
import { describe, expect, it } from 'vitest'
import { OSC52_MAX_TEXT_BYTES, Osc52Reader, osc52Targets, parseOsc52Body } from './osc52'

const b64 = (text: string | Buffer): string => Buffer.from(text).toString('base64')
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'))
const read = (...chunks: string[]) => {
  const reader = new Osc52Reader()
  return chunks.flatMap((chunk) => reader.push(bytes(chunk)))
}

describe('OSC 52 bodies (Story 42.1)', () => {
  it('names the clipboard for c or an empty selection, and the primary selection for p or s', () => {
    expect(osc52Targets('')).toEqual(['clipboard'])
    expect(osc52Targets('c')).toEqual(['clipboard'])
    expect(osc52Targets('p')).toEqual(['primary'])
    expect(osc52Targets('s')).toEqual(['primary'])
    expect(osc52Targets('cp')).toEqual(['clipboard', 'primary'])
    expect(osc52Targets('q0')).toEqual([])
    expect(parseOsc52Body(`q0;${b64('x')}`)).toBeNull()
  })

  it('never answers or acts on a read, and ignores an empty write', () => {
    expect(parseOsc52Body('c;?')).toBeNull()
    expect(parseOsc52Body(';?')).toBeNull()
    expect(parseOsc52Body('c;')).toBeNull()
  })

  it('ignores invalid base64, binary data and text that is not UTF-8', () => {
    for (const data of ['aGVsbG8*', 'a', 'aGVs bG8=', '====', 'aGVsbG8===']) expect(parseOsc52Body(`c;${data}`), data).toBeNull()
    expect(parseOsc52Body(`c;${b64(Buffer.from([0x68, 0x00, 0x69]))}`)).toBeNull()
    expect(parseOsc52Body(`c;${b64(Buffer.from([0xc3, 0x28]))}`)).toBeNull()
    // Unpadded base64, as some programs send it, is still base64.
    expect(parseOsc52Body('c;aGVsbG8')).toEqual({ targets: ['clipboard'], text: 'hello' })
  })

  it('accepts exactly 192 KiB of text and nothing larger', () => {
    const largest = 'é'.repeat(OSC52_MAX_TEXT_BYTES / 2)
    expect(parseOsc52Body(`c;${b64(largest)}`)?.text).toBe(largest)
    expect(parseOsc52Body(`c;${b64(`${largest}x`)}`)).toBeNull()
  })
})

describe('reading OSC 52 from a stream', () => {
  it('takes both terminators, several sequences per chunk, and leaves other escapes alone', () => {
    expect(read(`\x1b[32mgreen\x1b[0m\x1b]52;c;${b64('one')}\x07text\x1b]52;p;${b64('two')}\x1b\\\x1b]0;title\x07`)).toEqual([
      { targets: ['clipboard'], text: 'one' },
      { targets: ['primary'], text: 'two' }
    ])
  })

  it('joins a sequence split across chunks, even one byte at a time', () => {
    const sequence = `\x1b]52;c;${b64('split across chunks — ok')}\x1b\\`
    expect(read(...sequence.split(''))).toEqual([{ targets: ['clipboard'], text: 'split across chunks — ok' }])
  })

  it('drops a sequence an ESC interrupts, then reads the next one', () => {
    expect(read(`\x1b]52;c;${b64('lost')}\x1b[0m\x1b]52;c;${b64('kept')}\x07`)).toEqual([{ targets: ['clipboard'], text: 'kept' }])
  })

  it('skips an oversize sequence to its terminator without holding it, then reads the next one', () => {
    const oversize = `\x1b]52;c;${b64('x'.repeat(OSC52_MAX_TEXT_BYTES + 3))}\x07`
    expect(read(oversize.slice(0, 100_000), oversize.slice(100_000), `\x1b]52;c;${b64('after')}\x07`))
      .toEqual([{ targets: ['clipboard'], text: 'after' }])
  })

  it('does nothing for a read request', () => {
    expect(read('\x1b]52;c;?\x07', '\x1b]52;;?\x1b\\')).toEqual([])
  })
})
