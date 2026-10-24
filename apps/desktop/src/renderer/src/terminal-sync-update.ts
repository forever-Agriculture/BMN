// MODULE: terminal-sync-update.ts - Story 91.2: the end of a synchronized update redraws only the rows written during it
import type { IDisposable, Terminal } from '@xterm/xterm'

/** The one xterm 6.0.0 internal this needs: the private mode flag its renderer reads before drawing. */
interface SyncModeInternals {
  _core?: { coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } } }
}

type SyncTerminal = Pick<Terminal, 'parser' | 'buffer' | 'refresh'>

/**
 * xterm 6.0.0 ends a synchronized update (DECRST 2026) by asking for every row of the screen to be redrawn
 * (InputHandler.ts:2203-2205), although its renderer kept the range of rows written while the update was open and
 * draws that range at the end anyway (RenderService.ts:148-163). An app that wraps each frame in one, as Codex does
 * about 15 times a second, made the window rebuild and lay out all of a pane's rows for every frame. This ends the
 * update as xterm does but asks for the cursor's row alone, so the kept range and that row are drawn. A sequence
 * that resets other modes too, or an xterm without the flag, is left to xterm.
 */
export function redrawOnlyWrittenRows(terminal: SyncTerminal): IDisposable {
  return terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    const modes = (terminal as SyncModeInternals)._core?.coreService?.decPrivateModes
    if (params.length !== 1 || params[0] !== 2026 || typeof modes?.synchronizedOutput !== 'boolean') return false
    modes.synchronizedOutput = false
    const row = terminal.buffer.active.cursorY
    terminal.refresh(row, row)
    return true
  })
}
