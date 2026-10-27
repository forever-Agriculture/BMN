// MODULE: terminal-presentation-digest.ts - Fixed-scratch streaming digest for image presentation state

/** SHA-256 with constant working storage; no text, cell arrays or frame history are retained. */
export class TerminalPresentationDigest {
  private readonly state = new Uint32Array(8)
  private readonly block = new Uint8Array(64)
  private readonly words = new Uint32Array(64)
  private used = 0
  private length = 0

  constructor() { this.reset() }

  reset(): void {
    if (this.block.byteLength === 0) throw new Error('Terminal presentation digest disposed')
    this.state.set([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
    this.used = this.length = 0
  }

  byte(value: number): void {
    // This limits work, not allocation: the input is streamed through the same 352 bytes.
    if (++this.length > 64 * 1024 * 1024) throw new Error('Terminal presentation exceeds the semantic scan limit')
    this.block[this.used++] = value
    if (this.used === 64) {
      this.compress()
      this.used = 0
    }
  }

  word(value: number): void {
    this.byte(value >>> 24)
    this.byte(value >>> 16)
    this.byte(value >>> 8)
    this.byte(value)
  }

  text(value: string): void {
    // Length-prefixed UTF-16 preserves combined characters without an encoding allocation.
    this.word(value.length)
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      this.byte(code >>> 8)
      this.byte(code)
    }
  }

  finish(): string {
    const length = this.length
    this.block[this.used++] = 128
    if (this.used > 56) {
      this.block.fill(0, this.used)
      this.compress()
      this.used = 0
    }
    this.block.fill(0, this.used, 56)
    const high = Math.floor(length / 0x20000000)
    const low = (length * 8) >>> 0
    for (let i = 0; i < 4; i++) {
      this.block[56 + i] = high >>> (24 - i * 8)
      this.block[60 + i] = low >>> (24 - i * 8)
    }
    this.compress()
    let result = ''
    for (const word of this.state) result += word.toString(16).padStart(8, '0')
    return result
  }

  dispose(): void {
    // Retire the owned payload before the view returns its reservation, even if a
    // caller retains the disposed bridge. Electron's pinned Chromium supports transfer.
    for (const view of [this.state, this.block, this.words]) {
      if (view.byteLength) (view.buffer as ArrayBuffer).transfer(0)
    }
  }

  private compress(): void {
    const w = this.words
    const h = this.state
    for (let i = 0; i < 16; i++) {
      const p = i * 4
      w[i] = (this.block[p]! << 24) | (this.block[p + 1]! << 16) | (this.block[p + 2]! << 8) | this.block[p + 3]!
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!
      w[i] = (w[i - 16]! + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, z = h[7]!
    for (let i = 0; i < 64; i++) {
      const first = (z + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + ROUND[i]! + w[i]!) >>> 0
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      z = g; g = f; f = e; e = (d + first) >>> 0
      d = c; c = b; b = a; a = (first + second) >>> 0
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0
    h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0
    h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + z) >>> 0
  }
}

const rotate = (value: number, shift: number): number => (value >>> shift) | (value << (32 - shift))
const ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])
