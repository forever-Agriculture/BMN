// MODULE: reset-input-baseline.ts - Require exact raw palette focus drainage before the reset command is released.
const PALETTE_FOCUS = Buffer.from('\x1b[O\x1b[I')

/** Null means a proper prefix is still draining. Unexpected bytes fail; a complete result is the actual raw buffer. */
export function paletteInputBaseline(beforePalette: Buffer, current: Buffer): Buffer | null {
  const expected = Buffer.concat([beforePalette, PALETTE_FOCUS])
  if (current.length > expected.length || !current.equals(expected.subarray(0, current.length))) {
    throw new Error(`Unexpected PTY input before reset: expected ${expected.toString('hex')}, received ${current.toString('hex')}`)
  }
  return current.length === expected.length ? Buffer.from(current) : null
}
