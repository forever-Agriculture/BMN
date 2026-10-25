// MODULE: terminal-sync-update.ts - Exercise synchronized DOM rendering through the real browser terminal
import type { IDisposable, Terminal } from '@xterm/xterm'

/** Uses the same terminal and synchronization handler as a session, without writing to its PTY. */
export async function runSynchronizedRenderingProbe(
  createTerminal: () => Terminal,
  synchronize: (terminal: Terminal) => IDisposable
): Promise<string[]> {
  const focused = document.activeElement
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:250px;top:100px;width:650px;height:400px;z-index:1000;background:#111'
  document.body.append(host)
  const terminal = createTerminal()
  terminal.open(host)
  const synchronization = synchronize(terminal)
  const write = (data: string): Promise<void> => new Promise((resolve) => terminal.write(data, resolve))
  const frames = async (): Promise<void> => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }
  const rows = (): string[] => [...host.querySelectorAll('.xterm-rows > div')].map(row => row.textContent?.trimEnd() ?? '')
  const check = (condition: boolean, detail: string): void => {
    if (!condition) throw new Error(`synchronized DOM rendering: ${detail}`)
  }
  const passed: string[] = []
  const actions: [string, () => void][] = [
    ['selection', () => terminal.clearSelection()],
    ['focus', () => terminal.focus()],
    ['blur', () => terminal.blur()],
    ['scroll', () => terminal.scrollToTop()],
    ['rows resize', () => terminal.resize(40, 8)],
    ['columns resize', () => terminal.resize(32, 10)]
  ]
  try {
    for (const [name, action] of actions) {
      terminal.resize(40, 10)
      if (name === 'scroll') {
        await write('history\r\n'.repeat(20))
        check(terminal.buffer.active.baseY > 0, 'scroll: real scrollback exists')
      }
      terminal.scrollToBottom()
      await write('\x1b[?2026l\x1b[2J\x1b[Hanchor one\r\nanchor two')
      terminal.select(0, 0, 6)
      if (name === 'blur') terminal.focus()
      else terminal.blur()
      await frames()
      check(rows()[0] === 'anchor one' && rows()[1] === 'anchor two', `${name}: populated baseline`)
      await write('\x1b[?2026h\x1b[2J\x1b[H')
      action()
      await frames()
      check(rows()[0] === 'anchor one' && rows()[1] === 'anchor two', `${name}: exposed an unfinished synchronized buffer`)
      await write('\x1b[Hupdated one\r\nupdated two\x1b[?2026l')
      await frames()
      const actual = rows()
      check(actual.length === terminal.rows, `${name}: row count`)
      for (let row = 0; row < terminal.rows; row++) {
        check(actual[row] === terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString(true).trimEnd(), `${name}: exact committed row ${row}`)
      }
      passed.push(name)
    }
    terminal.scrollToBottom()
    await write('\x1b[?2026l\x1b[2J\x1b[Hanchor one\r\nanchor two')
    terminal.select(0, 0, 6)
    await frames()
    await write('\x1b[?2026h\x1b[2J\x1b[Hstage one\x1b[?2026l\x1b[?2026h\x1b[2J')
    terminal.clearSelection()
    await frames()
    check(rows()[0] === 'anchor one', 'back-to-back updates exposed an unfinished frame')
    await write('\x1b[Hcommitted\x1b[?2026l')
    await frames()
    check(rows()[0] === 'committed', 'back-to-back updates did not commit')
    passed.push('back-to-back updates')

    terminal.select(0, 0, 6)
    await write('\x1b[?2004h\x1b[?2026h\x1b[2J')
    terminal.clearSelection()
    await frames()
    check(rows()[0] === 'committed', 'combined-mode update exposed an unfinished frame')
    await write('\x1b[Hcombined\x1b[?2004;2026l')
    await frames()
    check(!terminal.modes.synchronizedOutputMode && !terminal.modes.bracketedPasteMode && rows()[0] === 'combined', 'combined-mode fallback did not commit')
    passed.push('combined modes')

    terminal.select(0, 0, 6)
    await write('\x1b[?2026h\x1b[2J')
    terminal.clearSelection()
    await frames()
    check(rows()[0] === 'combined', 'watchdog flushed before the unfinished update could be buffered')
    const deadline = performance.now() + 3000
    while (terminal.modes.synchronizedOutputMode && performance.now() < deadline) await frames()
    await frames()
    check(!terminal.modes.synchronizedOutputMode && rows().every(row => row === ''), 'existing synchronized-output watchdog no longer flushes')
    passed.push('watchdog')
    return passed
  } finally {
    synchronization.dispose()
    terminal.dispose()
    host.remove()
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus()
  }
}
