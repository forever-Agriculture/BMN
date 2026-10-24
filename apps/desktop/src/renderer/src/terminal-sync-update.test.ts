// MODULE: terminal-sync-update.test.ts - Story 91.2: a synchronized update's end asks for its own rows, not the whole screen
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { redrawOnlyWrittenRows } from './terminal-sync-update'

type RowRange = { start: number; end: number } | undefined

/** A headless xterm 6.0.0 with the browser terminal's refresh as a spy, and every redraw xterm's parser asks for. */
function harness(withHandler: boolean) {
  const terminal = new HeadlessTerminal({ cols: 40, rows: 10, allowProposedApi: true })
  const refresh = vi.fn()
  Object.assign(terminal, { refresh })
  const requested: RowRange[] = []
  ;(terminal as unknown as { _core: { _inputHandler: { onRequestRefreshRows(listener: (range: RowRange) => void): void } } })
    ._core._inputHandler.onRequestRefreshRows((range) => requested.push(range))
  if (withHandler) redrawOnlyWrittenRows(terminal as unknown as Terminal)
  const write = (data: string): Promise<void> => new Promise((done) => terminal.write(data, done))
  return { terminal, refresh, requested, write }
}

describe('the end of a synchronized update (Story 91.2)', () => {
  it('asks xterm 6.0.0 for every row when left to xterm, the redraw this handler removes', async () => {
    const { requested, write } = harness(false)
    await write('\x1b[?2026h\x1b[3;1Hrow three\x1b[?2026l')
    expect(requested).toContain(undefined)
  })

  it('ends the update and asks for the cursor row alone, so only the rows written during it are drawn', async () => {
    const { terminal, refresh, requested, write } = harness(true)
    await write('\x1b[?2026h')
    expect(terminal.modes.synchronizedOutputMode).toBe(true)
    await write('\x1b[3;1Hrow three\x1b[?2026l')
    expect(terminal.modes.synchronizedOutputMode).toBe(false)
    expect(refresh.mock.calls).toEqual([[2, 2]])
    expect(requested).not.toContain(undefined)
    expect(terminal.buffer.active.getLine(2)?.translateToString(true)).toBe('row three')
  })

  it('leaves a reset of other modes in the same sequence, and every other mode, to xterm', async () => {
    const { terminal, refresh, requested, write } = harness(true)
    await write('\x1b[?2004h\x1b[?2026h\x1b[?2004;2026l')
    expect(terminal.modes.bracketedPasteMode).toBe(false)
    expect(terminal.modes.synchronizedOutputMode).toBe(false)
    expect(requested).toContain(undefined)
    await write('\x1b[?2004h\x1b[?2004l')
    expect(terminal.modes.bracketedPasteMode).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })
})
