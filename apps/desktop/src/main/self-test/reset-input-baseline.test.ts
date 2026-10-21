// MODULE: reset-input-baseline.test.ts - Captured raw failure, exact focus drainage, and post-release byte rejection.
import { describe, expect, it } from 'vitest'
import { paletteInputBaseline } from './reset-input-baseline'
const before = Buffer.from('1b5b3c36343b34313b31334d1b5b4f1b5b49', 'hex')
const complete = Buffer.concat([before, Buffer.from('\x1b[O\x1b[I')])

describe('reset fixture input measurement', () => {
  it('replays the captured old boundary failure and accepts the drained actual baseline', () => {
    expect(Buffer.compare(before, complete)).not.toBe(0)
    const baseline = paletteInputBaseline(before, complete)
    expect(baseline).not.toBe(complete)
    expect(Buffer.compare(baseline!, complete)).toBe(0)
  })
  it('cannot release for delayed or split focus input', () => {
    for (let length = before.length; length < complete.length; length++) {
      expect(paletteInputBaseline(before, complete.subarray(0, length))).toBeNull()
    }
  })
  it('rejects missing, changed, duplicate and extra focus input', () => {
    for (const extra of ['\x1b[I', '\x1b[O\x1b[O', '\x1b[O\x1b[I\x1b[I', 'x']) {
      expect(() => paletteInputBaseline(before, Buffer.concat([before, Buffer.from(extra)]))).toThrow('Unexpected PTY input')
    }
  })
  it('the unchanged final raw comparison rejects every byte after release, even focus-shaped input or wheel leakage', () => {
    const baseline = paletteInputBaseline(before, complete)!
    for (const extra of ['x', '\x1b[O', '\x1b[I', '\x1b[<64;41;13M']) {
      expect(Buffer.compare(baseline, Buffer.concat([complete, Buffer.from(extra)]))).not.toBe(0)
    }
  })
})
