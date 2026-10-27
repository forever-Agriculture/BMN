// MODULE: terminal-sync-update.ts - Story 91.2: the end of a synchronized update redraws only the rows written during it
import type { IDisposable, Terminal } from '@xterm/xterm'

interface SyncRenderer {
  renderRows(start: number, end: number): void
  clear(): void
}

interface SyncRenderService {
  _renderer: { value?: SyncRenderer }
  setRenderer(renderer: SyncRenderer): void
}

/** Version-pinned xterm 6.0.0 internals: its mode flag and the active browser renderer. */
interface SyncModeInternals {
  _core?: {
    coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
    _renderService?: SyncRenderService
  }
}

type SyncTerminal = Pick<Terminal, 'parser' | 'buffer' | 'refresh' | 'rows'>

/**
 * xterm 6.0.0 ends a synchronized update (DECRST 2026) by asking for every row of the screen to be redrawn
 * (InputHandler.ts:2203-2205), although its renderer kept the range of rows written while the update was open and
 * draws that range at the end anyway (RenderService.ts:148-163). An app that wraps each frame in one, as Codex does
 * about 15 times a second, made the window rebuild and lay out all of a pane's rows for every frame. This ends the
 * update as xterm does but asks for the cursor's row alone, so the kept range and that row are drawn. A sequence
 * that resets other modes too, or an xterm without the flag, is left to xterm.
 */
export function redrawOnlyWrittenRows(terminal: SyncTerminal): IDisposable {
  const guardedRendering = guardDirectRedraws(terminal)
  const endUpdate = terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    const modes = (terminal as SyncModeInternals)._core?.coreService?.decPrivateModes
    if (params.length !== 1 || params[0] !== 2026 || typeof modes?.synchronizedOutput !== 'boolean') return false
    modes.synchronizedOutput = false
    const row = terminal.buffer.active.cursorY
    terminal.refresh(row, row)
    return true
  })
  return {
    dispose(): void {
      endUpdate.dispose()
      guardedRendering.dispose()
    }
  }
}

/**
 * Direct redraws and buffer activation bypass RenderService's 2026 check. Queue their rows
 * instead: clearing the DOM now would expose a blank until the synchronized update commits.
 */
function guardDirectRedraws(terminal: SyncTerminal): IDisposable {
  const core = (terminal as SyncModeInternals)._core
  const service = core?._renderService
  if (!service) return { dispose(): void {} }
  let disposed = false
  let restoreRenderer = (): void => undefined
  const attach = (): void => {
    restoreRenderer()
    const renderer = service._renderer.value
    if (!renderer) return
    const original = renderer.renderRows
    const originalClear = renderer.clear
    const guarded = (start: number, end: number): void => {
      if (!disposed && core?.coreService?.decPrivateModes?.synchronizedOutput) {
        terminal.refresh(start, end)
        return
      }
      original.call(renderer, start, end)
    }
    const guardedClear = (): void => {
      if (!disposed && core?.coreService?.decPrivateModes?.synchronizedOutput) {
        terminal.refresh(0, terminal.rows - 1)
        return
      }
      originalClear.call(renderer)
    }
    renderer.renderRows = guarded
    renderer.clear = guardedClear
    restoreRenderer = (): void => {
      if (renderer.renderRows === guarded) renderer.renderRows = original
      if (renderer.clear === guardedClear) renderer.clear = originalClear
    }
  }
  const originalSetRenderer = service.setRenderer
  function setRenderer(this: SyncRenderService, renderer: SyncRenderer): void {
    originalSetRenderer.call(this, renderer)
    if (!disposed) attach()
  }
  attach()
  service.setRenderer = setRenderer
  return {
    dispose(): void {
      // A later image wrapper may restore our captured methods after this disposal.
      disposed = true
      restoreRenderer()
      if (service.setRenderer === setRenderer) service.setRenderer = originalSetRenderer
    }
  }
}
