// MODULE: terminal-presentation-digest.test.ts - Check the streaming presentation digest against independent Web Crypto SHA-256
import { describe, expect, it } from 'vitest'
import { TerminalPresentationDigest } from './terminal-presentation-digest'

describe('terminal presentation digest', () => {
  const independentDigest = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')

  it('matches SHA-256 across empty input, padding boundaries and multiple blocks', async () => {
    const hash = new TerminalPresentationDigest()
    for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1024]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 19) & 255)
      hash.reset()
      for (const byte of bytes) hash.byte(byte)
      expect(hash.finish()).toBe(await independentDigest(bytes))
    }
  })

  it('length-prefixes UTF-16 and writes integers in an unambiguous order', async () => {
    const hash = new TerminalPresentationDigest()
    hash.word(0x98765432)
    hash.text('a\u0301\ud83d\ude00')
    const bytes = new Uint8Array(4 + 4 + 8)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, 0x98765432)
    view.setUint32(4, 4)
    for (const [i, code] of [0x61, 0x301, 0xd83d, 0xde00].entries()) view.setUint16(8 + i * 2, code)
    expect(hash.finish()).toBe(await independentDigest(bytes))
  })

  it('retires its scratch before returning the view reservation', () => {
    const hash = new TerminalPresentationDigest()
    hash.text('retire')
    hash.dispose()
    hash.dispose()
    expect(() => hash.reset()).toThrow('disposed')
  })
})
