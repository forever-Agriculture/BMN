import { TERMINAL_PARSER_ATOM_BYTES } from '@bmn/protocol'

type ParserState =
  | 'ground'
  | 'escape'
  | 'escape-intermediate'
  | 'csi'
  | 'osc'
  | 'osc-escape'
  | 'control-string'
  | 'control-string-escape'
  | 'utf8'

const ESC = 0x1b
const BEL = 0x07
const CAN = 0x18
const SUB = 0x1a

function utf8ContinuationCount(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 1
  if (byte >= 0xe0 && byte <= 0xef) return 2
  if (byte >= 0xf0 && byte <= 0xf4) return 3
  return 0
}

/**
 * Retains terminal parser atoms until they are complete while preserving their
 * original bytes. The returned frames are safe retention boundaries; no
 * UTF-8 code point or ECMA-48 CSI/OSC/DCS sequence is divided between frames.
 */
export class TerminalByteFramer {
  private state: ParserState = 'ground'
  private token: number[] = []
  private utf8ContinuationsRemaining = 0

  get pendingBytes(): number {
    return this.token.length
  }

  push(bytes: Uint8Array): Uint8Array[] {
    const ready: number[] = []
    for (const byte of bytes) this.consume(byte, ready)
    return ready.length === 0 ? [] : [Uint8Array.from(ready)]
  }

  flush(): Uint8Array[] {
    if (this.token.length === 0) return []
    const pending = Uint8Array.from(this.token)
    this.resetToken()
    return [pending]
  }

  private consume(byte: number, ready: number[]): void {
    switch (this.state) {
      case 'ground':
        this.consumeGround(byte, ready)
        return
      case 'utf8':
        if (byte >= 0x80 && byte <= 0xbf) {
          if (!this.retainTokenByte(byte, ready)) return
          this.utf8ContinuationsRemaining -= 1
          if (this.utf8ContinuationsRemaining === 0) this.completeToken(ready)
          return
        }
        ready.push(...this.token)
        this.resetToken()
        this.consumeGround(byte, ready)
        return
      case 'escape':
        if (!this.retainTokenByte(byte, ready)) return
        if (byte === ESC) return
        if (byte === 0x5b) this.state = 'csi'
        else if (byte === 0x5d) this.state = 'osc'
        else if (byte === 0x50 || byte === 0x58 || byte === 0x5e || byte === 0x5f) {
          this.state = 'control-string'
        } else if (byte >= 0x20 && byte <= 0x2f) this.state = 'escape-intermediate'
        else this.completeToken(ready)
        return
      case 'escape-intermediate':
        if (!this.retainTokenByte(byte, ready)) return
        if (byte === ESC) this.state = 'escape'
        else if (!(byte >= 0x20 && byte <= 0x2f)) this.completeToken(ready)
        return
      case 'csi':
        if (!this.retainTokenByte(byte, ready)) return
        if (byte >= 0x40 && byte <= 0x7e) this.completeToken(ready)
        else if (byte === CAN || byte === SUB) this.completeToken(ready)
        else if (byte === ESC) this.state = 'escape'
        return
      case 'osc':
        if (!this.retainTokenByte(byte, ready)) return
        if (byte === BEL || byte === CAN || byte === SUB) {
          this.completeToken(ready)
        } else if (byte === ESC) this.state = 'osc-escape'
        return
      case 'osc-escape':
        if (!this.retainTokenByte(byte, ready)) return
        if (byte === 0x5c) this.completeToken(ready)
        else if (byte !== ESC) this.state = 'osc'
        return
      case 'control-string':
        if (!this.retainTokenByte(byte, ready)) return
        if (byte === CAN || byte === SUB) this.completeToken(ready)
        else if (byte === ESC) this.state = 'control-string-escape'
        return
      case 'control-string-escape':
        if (!this.retainTokenByte(byte, ready)) return
        if (byte === 0x5c) this.completeToken(ready)
        else if (byte !== ESC) this.state = 'control-string'
    }
  }

  private consumeGround(byte: number, ready: number[]): void {
    if (byte === ESC) {
      this.token = [byte]
      this.state = 'escape'
      return
    }
    const continuationCount = utf8ContinuationCount(byte)
    if (continuationCount > 0) {
      this.token = [byte]
      this.utf8ContinuationsRemaining = continuationCount
      this.state = 'utf8'
      return
    }
    ready.push(byte)
  }

  private completeToken(ready: number[]): void {
    ready.push(...this.token)
    this.resetToken()
  }

  private retainTokenByte(byte: number, ready: number[]): boolean {
    this.token.push(byte)
    if (this.token.length <= TERMINAL_PARSER_ATOM_BYTES) return true
    this.completeToken(ready)
    return false
  }

  private resetToken(): void {
    this.token = []
    this.utf8ContinuationsRemaining = 0
    this.state = 'ground'
  }
}
