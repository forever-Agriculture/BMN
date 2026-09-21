// MODULE: decset-modes.ts - which private terminal modes the program has turned on, read from its own output
import { DEFAULT_ON_DECSET_MODES, TRACKED_DECSET_MODES } from '@bmn/protocol'

const TRACKED = new Set(TRACKED_DECSET_MODES)
/**
 * A terminal runs one mouse protocol and one mouse encoding at a time, so these are slots rather
 * than flags: setting one replaces the others, and resetting any of them turns the whole slot off.
 * Keeping them as independent flags would restore a protocol the program had switched away from.
 */
const MOUSE_PROTOCOLS = [1000, 1002, 1003]
const MOUSE_ENCODINGS = [1005, 1006]
/** A private-mode parameter list longer than this is not one a terminal would send. */
const MAX_PARAMETERS = 64

type ParseState = 'text' | 'escape' | 'csi' | 'private' | 'other-csi'

/**
 * Reads the modes out of the bytes the host already streams to the view. It is a reader, never a
 * writer: nothing here reaches the process, and an unknown or malformed sequence is skipped rather
 * than guessed at.
 */
export class DecsetModeTracker {
  private state: ParseState = 'text'
  private parameters = ''
  /** The program's current state for every tracked mode, starting from what a fresh terminal does. */
  private readonly on = new Set<number>(DEFAULT_ON_DECSET_MODES)

  /** Feeds one chunk of the program's output. Chunks may split a sequence anywhere. */
  read(bytes: Uint8Array): void {
    for (const byte of bytes) {
      switch (this.state) {
        case 'text':
          if (byte === 0x1b) this.state = 'escape'
          break
        case 'escape':
          // A second escape restarts: the first one was not the start of a sequence after all.
          if (byte === 0x1b) break
          this.state = byte === 0x5b ? 'csi' : 'text'
          break
        case 'csi':
          if (byte === 0x3f) {
            this.state = 'private'
            this.parameters = ''
            break
          }
          this.state = byte === 0x1b ? 'escape' : 'other-csi'
          break
        case 'private':
          if ((byte >= 0x30 && byte <= 0x39) || byte === 0x3b) {
            if (this.parameters.length < MAX_PARAMETERS) {
              this.parameters += String.fromCharCode(byte)
            } else {
              this.state = 'other-csi'
            }
            break
          }
          if (byte === 0x68 || byte === 0x6c) this.apply(byte === 0x68)
          this.state = byte === 0x1b ? 'escape' : 'text'
          break
        case 'other-csi':
          // Skip to the sequence's final byte; only then can text resume safely.
          if (byte === 0x1b) this.state = 'escape'
          else if (byte >= 0x40 && byte <= 0x7e) this.state = 'text'
          break
      }
    }
  }

  private apply(set: boolean): void {
    for (const parameter of this.parameters.split(';')) {
      if (parameter === '') continue
      const mode = Number(parameter)
      if (!TRACKED.has(mode)) continue
      const slot = MOUSE_PROTOCOLS.includes(mode)
        ? MOUSE_PROTOCOLS
        : MOUSE_ENCODINGS.includes(mode) ? MOUSE_ENCODINGS : undefined
      if (slot) {
        for (const other of slot) this.on.delete(other)
        if (set) this.on.add(mode)
        continue
      }
      if (set) this.on.add(mode)
      else this.on.delete(mode)
    }
    this.parameters = ''
  }

  /**
   * The tracked modes whose state a new view would get wrong, always in the same order: what the
   * program turned on that a fresh view has off, and what it turned off that a fresh view has on.
   */
  modes(): number[] {
    return TRACKED_DECSET_MODES.filter((mode) => this.on.has(mode) !== DEFAULT_ON_DECSET_MODES.includes(mode))
  }

  /** A process that ended has no modes: nothing of its state may reach a later view. */
  clear(): void {
    this.state = 'text'
    this.parameters = ''
    this.on.clear()
    for (const mode of DEFAULT_ON_DECSET_MODES) this.on.add(mode)
  }
}
