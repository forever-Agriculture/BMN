/** A small seeded generator, so a failing case can be replayed from its seed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

const encoder = new TextEncoder()
const ESC = 0x1b
const EXECUTABLES = [...Array.from({ length: 0x18 }, (_, index) => index), 0x19, 0x1c, 0x1d, 0x1e, 0x1f]
/** UTF-8 that xterm decodes, including code points with 0x9c and 0x80 continuation bytes. */
const TEXT = ['М', 'Ї', '—', '…', 'é', '😀', ' '].map((text) => encoder.encode(text))
/** Byte runs xterm's decoder drops or splits differently from a strict decoder. */
const MALFORMED = [
  [0x80], [0x9c], [0xbf], [0xc0, 0x80], [0xc1, 0x9b], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80],
  [0xef, 0xbb, 0xbf], [0xf5, 0x80, 0x80, 0x80], [0xf8], [0xff], [0xe2, 0x80], [0xe2], [0xc2],
  [0xf0, 0x9f, 0x98], [0xd0]
]
/** The seven-bit and UTF-8 forms of each string introducer and terminator. */
const INTRODUCERS = {
  csi: [[ESC, 0x5b], [0xc2, 0x9b]],
  dcs: [[ESC, 0x50], [0xc2, 0x90]],
  osc: [[ESC, 0x5d], [0xc2, 0x9d]],
  sos: [[ESC, 0x58], [ESC, 0x5e], [ESC, 0x5f], [0xc2, 0x98], [0xc2, 0x9e], [0xc2, 0x9f]]
} as const

/**
 * Random PTY output across everything that moves xterm's parser: text, C0 and C1 controls,
 * malformed UTF-8, escape sequences with controls inside, and CSI, DCS, OSC and SOS/PM/APC
 * strings of sizes around the 64 KiB parser atom, ended every way xterm ends them or left
 * open. String payloads are random, so a lost or repeated run of bytes cannot go unnoticed.
 */
export function generatedTerminalOutput(
  random: () => number,
  options: { segments: number; largestString: number }
): Uint8Array {
  const parts: ArrayLike<number>[] = []
  let total = 0
  const add = (bytes: ArrayLike<number>): void => {
    parts.push(bytes)
    total += bytes.length
  }
  const randomByte = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1))
  const control = (): number[] => {
    const roll = random()
    if (roll < 0.5) return [pick(random, EXECUTABLES)]
    if (roll < 0.65) return [0x7f]
    if (roll < 0.8) return [0xc2, randomByte(0x80, 0x9f)]
    return [...pick(random, MALFORMED)]
  }
  const stringSize = (): number => {
    const roll = random()
    if (roll < 0.5) return 1 + Math.floor(random() * 200)
    if (roll < 0.7) return 65_500 + Math.floor(random() * 80)
    if (roll < 0.85) return Math.floor(random() * options.largestString)
    return 1_000 + Math.floor(random() * 20_000)
  }
  const payload = (size: number, extra: () => number[] | undefined): Uint8Array => {
    const bytes = new Uint8Array(size)
    for (let index = 0; index < size; index += 1) bytes[index] = randomByte(0x3f, 0x7e)
    // A few controls, DEL or non-ASCII inside the payload, placed rarely so long strings stay long.
    for (let count = Math.floor(random() * 4); count > 0 && size > 0; count -= 1) {
      const bytesToPlace = extra()
      if (!bytesToPlace) continue
      const at = Math.floor(random() * Math.max(1, size - bytesToPlace.length))
      bytes.set(bytesToPlace.slice(0, size - at), at)
    }
    return bytes
  }
  const terminator = (osc: boolean): number[] => {
    const roll = random()
    if (roll < 0.35) return [ESC, 0x5c]
    if (roll < 0.45) return [0xc2, 0x9c]
    if (roll < 0.52) return [pick(random, [0x18, 0x1a])]
    if (roll < 0.6 && osc) return [0x07]
    // An ESC that starts something else, after which a control may follow before its final byte.
    if (roll < 0.85) return [ESC, ...(random() < 0.5 ? control() : []), pick(random, [0x5b, 0x50, 0x5d, 0x28, 0x5c, 0x37])]
    return []
  }
  const sequence = (): void => {
    const roll = random()
    if (roll < 0.25) {
      // ESC, perhaps intermediates, perhaps controls, then any byte as its final.
      const bytes: number[] = [ESC]
      while (random() < 0.3) bytes.push(random() < 0.5 ? randomByte(0x20, 0x2f) : control()[0]!)
      bytes.push(randomByte(0x20, 0x7f))
      add(bytes)
    } else if (roll < 0.5) {
      const bytes: number[] = [...pick(random, INTRODUCERS.csi)]
      const long = random() < 0.05
      const count = long ? 65_530 + Math.floor(random() * 60) : Math.floor(random() * 8)
      for (let index = 0; index < count; index += 1) {
        const inner = random()
        if (!long && inner < 0.1) bytes.push(...control())
        else bytes.push(inner < 0.2 ? randomByte(0x20, 0x2f) : randomByte(0x30, 0x3f))
      }
      if (random() < 0.9) bytes.push(randomByte(0x40, 0x7e))
      add(bytes)
    } else if (roll < 0.75) {
      add(pick(random, INTRODUCERS.dcs))
      const header: number[] = []
      for (let count = Math.floor(random() * 6); count > 0; count -= 1) {
        header.push(random() < 0.1 ? control()[0]! : randomByte(0x20, 0x3f))
      }
      header.push(random() < 0.8 ? 0x71 : randomByte(0x40, 0x7e))
      add(header)
      add(payload(stringSize(), () => (random() < 0.5 ? [pick(random, EXECUTABLES)] : [...pick(random, TEXT)])))
      add(terminator(false))
    } else if (roll < 0.9) {
      add(pick(random, INTRODUCERS.osc))
      add(payload(stringSize(), () => (random() < 0.5 ? [...pick(random, TEXT)] : [0x7f])))
      add(terminator(true))
    } else {
      add(pick(random, INTRODUCERS.sos))
      add(payload(stringSize(), () => (random() < 0.7 ? [pick(random, EXECUTABLES)] : [...pick(random, TEXT)])))
      add(terminator(false))
    }
  }
  for (let segment = 0; segment < options.segments; segment += 1) {
    const roll = random()
    if (roll < 0.35) {
      const text: number[] = []
      for (let count = 1 + Math.floor(random() * 24); count > 0; count -= 1) {
        const inner = random()
        text.push(...(inner < 0.8 ? [randomByte(0x20, 0x7e)] : inner < 0.9 ? [...pick(random, TEXT)] : [0x0d, 0x0a]))
      }
      add(text)
    } else if (roll < 0.45) add(control())
    else sequence()
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
