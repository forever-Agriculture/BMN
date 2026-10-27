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

describe('direct browser redraws during a synchronized update (Story 87.2)', () => {
  function browserHarness() {
    const { terminal, refresh, write } = harness(false)
    const renderer = { renderRows: vi.fn(), clear: vi.fn() }
    const service = {
      _renderer: { value: renderer },
      setRenderer(next: typeof renderer): void { this._renderer.value = next }
    }
    Object.assign((terminal as unknown as { _core: object })._core, { _renderService: service })
    return { terminal, refresh, write, renderer, service }
  }

  it('queues a direct redraw for the commit and preserves the original renderer receiver', async () => {
    const { terminal, refresh, write, renderer } = browserHarness()
    const original = renderer.renderRows
    const synchronization = redrawOnlyWrittenRows(terminal as unknown as Terminal)
    await write('\x1b[?2026h')
    renderer.renderRows(2, 5)
    expect(original).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledWith(2, 5)
    await write('\x1b[?2026l')
    renderer.renderRows(2, 5)
    expect(original).toHaveBeenCalledExactlyOnceWith(2, 5)
    expect(original.mock.contexts[0]).toBe(renderer)
    synchronization.dispose()
    terminal.dispose()
  })

  it('protects a replacement renderer and restores the wrappers it owns on teardown', async () => {
    const { terminal, write, renderer, service } = browserHarness()
    const original = renderer.renderRows
    const originalSetRenderer = service.setRenderer
    const replacement = { renderRows: vi.fn(), clear: vi.fn() }
    const replacementOriginal = replacement.renderRows
    const synchronization = redrawOnlyWrittenRows(terminal as unknown as Terminal)
    service.setRenderer(replacement)
    expect(renderer.renderRows).toBe(original)
    await write('\x1b[?2026h')
    replacement.renderRows(1, 3)
    expect(replacementOriginal).not.toHaveBeenCalled()
    synchronization.dispose()
    expect(replacement.renderRows).toBe(replacementOriginal)
    expect(service.setRenderer).toBe(originalSetRenderer)
    terminal.dispose()
  })

  it('does not overwrite a later renderer owner during teardown', () => {
    const { terminal, renderer, service } = browserHarness()
    const synchronization = redrawOnlyWrittenRows(terminal as unknown as Terminal)
    const otherRender = vi.fn()
    const otherSetRenderer = vi.fn()
    renderer.renderRows = otherRender
    service.setRenderer = otherSetRenderer
    synchronization.dispose()
    expect(renderer.renderRows).toBe(otherRender)
    expect(service.setRenderer).toBe(otherSetRenderer)
    terminal.dispose()
  })

  it('queues a destructive clear as a full refresh and forwards ordinary clears unchanged', async () => {
    const { terminal, refresh, write, renderer } = browserHarness()
    const original = renderer.clear
    const synchronization = redrawOnlyWrittenRows(terminal as unknown as Terminal)
    await write('\x1b[?2026h')
    renderer.clear()
    expect(original).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledWith(0, terminal.rows - 1)
    await write('\x1b[?2026l')
    renderer.clear()
    expect(original).toHaveBeenCalledExactlyOnceWith()
    expect(original.mock.contexts[0]).toBe(renderer)
    synchronization.dispose()
    expect(renderer.clear).toBe(original)
    terminal.dispose()
  })

  it('restores both methods when a renderer is replaced', () => {
    const { terminal, renderer, service } = browserHarness()
    const original = { clear: renderer.clear, renderRows: renderer.renderRows }
    const replacement = { renderRows: vi.fn(), clear: vi.fn() }
    const replacementClear = replacement.clear
    const synchronization = redrawOnlyWrittenRows(terminal as unknown as Terminal)
    service.setRenderer(replacement)
    expect(renderer.clear).toBe(original.clear)
    expect(renderer.renderRows).toBe(original.renderRows)
    synchronization.dispose()
    expect(replacement.clear).toBe(replacementClear)
    terminal.dispose()
  })

  it('leaves restored guards passive when a later owner unwraps after synchronization disposal', async () => {
    const { terminal, refresh, write, renderer } = browserHarness()
    const original = { clear: renderer.clear, renderRows: renderer.renderRows }
    const synchronization = redrawOnlyWrittenRows(terminal as unknown as Terminal)
    const captured = { clear: renderer.clear, renderRows: renderer.renderRows }
    renderer.clear = vi.fn(() => captured.clear.call(renderer))
    renderer.renderRows = vi.fn((start, end) => captured.renderRows.call(renderer, start, end))
    await write('\x1b[?2026h')
    synchronization.dispose()
    renderer.clear = captured.clear
    renderer.renderRows = captured.renderRows
    refresh.mockClear()
    renderer.clear()
    renderer.renderRows(1, 3)
    expect(original.clear).toHaveBeenCalledExactlyOnceWith()
    expect(original.renderRows).toHaveBeenCalledExactlyOnceWith(1, 3)
    expect(refresh).not.toHaveBeenCalled()
    terminal.dispose()
  })

  it('restores an earlier renderer owner without bypassing it', async () => {
    const { terminal, write, renderer } = browserHarness()
    const original = renderer.clear
    const earlier = vi.fn(() => original.call(renderer))
    renderer.clear = earlier
    const synchronization = redrawOnlyWrittenRows(terminal as unknown as Terminal)
    await write('\x1b[?2026h')
    renderer.clear()
    expect(earlier).not.toHaveBeenCalled()
    synchronization.dispose()
    expect(renderer.clear).toBe(earlier)
    renderer.clear()
    expect(original).toHaveBeenCalledExactlyOnceWith()
    terminal.dispose()
  })
})
