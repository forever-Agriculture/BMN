// MODULE: setup-output.ts - Bounded in-memory failure excerpts, independent of saved output
import { readRecentLines, type RecentTextBuffer } from './voice-suggestions'

interface SetupOutputTerminal {
  write(data: string | Uint8Array, callback?: () => void): void
  readonly buffer: { readonly active: RecentTextBuffer & { readonly baseY: number; readonly cursorY: number } }
}

export function readSetupLastLines(terminal: SetupOutputTerminal): Promise<string[]> {
  // xterm's callback follows every preceding parse, regardless of saved-output policy.
  return new Promise(resolve => terminal.write('', () => {
    const buffer = terminal.buffer.active
    const end = Math.min(buffer.length, buffer.baseY + buffer.cursorY + 1)
    resolve(readRecentLines({ length: end, getLine: index => index < end ? buffer.getLine(index) : undefined }, 8, 4096))
  }))
}
