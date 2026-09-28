// MODULE: osc52.ts - clipboard writes a program sends with OSC 52, read from live PTY output (Story 42.1)
import { PROGRAM_COPY_MAX_BYTES, type ProgramCopyTarget } from '@bmn/protocol'

/** herdr's cap: the decoded text of one write, at most 192 KiB. */
export const OSC52_MAX_TEXT_BYTES = PROGRAM_COPY_MAX_BYTES
/** The longest encoded body kept while a sequence is open: a selection, ';' and the base64 of the largest text. */
const MAX_BODY_BYTES = 16 + Math.ceil(OSC52_MAX_TEXT_BYTES / 3) * 4
const ESC = 0x1b
const BEL = 0x07
const BACKSLASH = 0x5c
const PREFIX = [0x5d, 0x35, 0x32, 0x3b] // "]52;" after ESC

export type Osc52Target = ProgramCopyTarget

/** A write BMN may carry out; reads (`?`) and anything malformed produce nothing. */
export interface Osc52Write {
  targets: Osc52Target[]
  text: string
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * The targets a selection parameter names: `c` is the clipboard and an empty one means it too; `p` and `s` are the
 * primary selection. Cut buffers (`0`-`7`) and `q` are not written.
 */
export function osc52Targets(selection: string): Osc52Target[] {
  if (selection === '') return ['clipboard']
  const targets = new Set<Osc52Target>()
  for (const letter of selection) {
    if (letter === 'c') targets.add('clipboard')
    else if (letter === 'p' || letter === 's') targets.add('primary')
  }
  return [...targets]
}

/** One OSC 52 body (`<selection>;<data>`) as a write, or null for a read, an empty write or anything invalid. */
export function parseOsc52Body(body: string): Osc52Write | null {
  const separator = body.indexOf(';')
  if (separator < 0) return null
  const selection = body.slice(0, separator)
  const data = body.slice(separator + 1)
  // A read request is answered with nothing at all: no program learns what the clipboard holds.
  if (data === '?' || data === '') return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) return null
  const bytes = Buffer.from(data, 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength > OSC52_MAX_TEXT_BYTES) return null
  let text: string
  try {
    text = utf8.decode(bytes)
  } catch {
    return null
  }
  // Text only: a NUL means binary data, which no clipboard of text should receive.
  if (text.includes('\0')) return null
  const targets = osc52Targets(selection)
  return targets.length === 0 ? null : { targets, text }
}

type State = 'ground' | 'escape' | 'prefix' | 'body' | 'body-escape' | 'skip' | 'skip-escape'

/**
 * Reads OSC 52 sequences out of one session's output stream, across chunk boundaries. It keeps at most one open
 * sequence, bounded by the largest write it would accept; a longer one is skipped to its terminator. It never
 * changes the bytes, which still reach the view unaltered.
 */
export class Osc52Reader {
  private state: State = 'ground'
  private matched = 0
  private body: number[] = []

  push(bytes: Uint8Array): Osc52Write[] {
    const writes: Osc52Write[] = []
    let index = 0
    while (index < bytes.byteLength) {
      if (this.state === 'ground') {
        // Most output holds no ESC at all, or only colour codes: jump straight to the next one.
        const next = bytes.indexOf(ESC, index)
        if (next < 0) break
        index = next + 1
        this.state = 'escape'
        this.matched = 0
        continue
      }
      const byte = bytes[index]!
      index += 1
      switch (this.state) {
        case 'escape':
        case 'prefix':
          if (byte === PREFIX[this.matched]) {
            this.matched += 1
            this.state = 'prefix'
            if (this.matched === PREFIX.length) {
              this.state = 'body'
              this.body = []
            }
          } else {
            this.state = byte === ESC ? 'escape' : 'ground'
            this.matched = 0
          }
          break
        case 'body':
          if (byte === BEL) this.finish(writes)
          else if (byte === ESC) this.state = 'body-escape'
          else if (this.body.length >= MAX_BODY_BYTES) {
            this.body = []
            this.state = 'skip'
          } else this.body.push(byte)
          break
        case 'body-escape':
          // ST is ESC \; any other ESC ends the sequence unfinished, as a terminal parser does, and may start another.
          if (byte === BACKSLASH) this.finish(writes)
          else {
            this.body = []
            this.state = 'escape'
            this.matched = 0
            index -= 1
          }
          break
        case 'skip':
          if (byte === BEL) this.state = 'ground'
          else if (byte === ESC) this.state = 'skip-escape'
          break
        case 'skip-escape':
          if (byte === BACKSLASH) this.state = 'ground'
          else {
            this.state = 'escape'
            this.matched = 0
            index -= 1
          }
          break
      }
    }
    return writes
  }

  private finish(writes: Osc52Write[]): void {
    const write = parseOsc52Body(Buffer.from(this.body).toString('latin1'))
    if (write) writes.push(write)
    this.body = []
    this.state = 'ground'
  }
}
