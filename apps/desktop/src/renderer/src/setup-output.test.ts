// MODULE: setup-output.test.ts - Real xterm parse/exit/padding composition with setup persistence disabled
import { Terminal } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import { startSavedOutputCapture } from './terminal-history'
import { TerminalOutputFlow } from './terminal-output-flow'
import { trackTerminalView } from './terminal-view-tracking'
import { FOLLOW_TAIL_VIEW } from './workspace-layout'
import { readSetupLastLines } from './setup-output'

describe('setup failure output', () => {
  it('keeps row/byte bounds and joins wrapped rows without reading unused screen padding', async () => {
    const terminal = new Terminal({ cols: 20, rows: 43, allowProposedApi: true })
    try {
      await new Promise<void>(resolve => terminal.write('wrapped_synthetic_' + 'x'.repeat(20) + '\r\n', resolve))
      expect((await readSetupLastLines(terminal))[0]).toBe('wrapped_synthetic_' + 'x'.repeat(20))
      await new Promise<void>(resolve => terminal.write(Array.from({ length: 20 }, (_, i) => `line-${i}\r\n`).join(''), resolve))
      const rows = await readSetupLastLines(terminal)
      expect(rows).toHaveLength(8); expect(rows[0]).toBe('line-13'); expect(rows).toContain('line-19')
      terminal.resize(10000, 43)
      await new Promise<void>(resolve => terminal.write('界'.repeat(2000), resolve))
      const bounded = await readSetupLastLines(terminal)
      expect(new TextEncoder().encode(bounded.join('\n')).length).toBeLessThanOrEqual(4096)
    } finally { terminal.dispose() }
  })

  for (const settledFirst of [false, true]) it(`reads the failed command through real parsing and43-row padding, settledFirst=${settledFirst}`, async () => {
    const terminal = new Terminal({ cols: 80, rows: 43, allowProposedApi: true })
    const save = vi.fn(async () => undefined)
    const capture = startSavedOutputCapture(terminal, save, message => { throw Error(message) }, () => 0, false)
    const tracking = trackTerminalView({ terminal, capture, view: () => FOLLOW_TAIL_VIEW,
      report: () => undefined, onFailure: message => { throw Error(message) } })
    const flow = new TerminalOutputFlow(); flow.attach('synthetic-setup')
    let parsed!: () => void
    const parsing = new Promise<void>(resolve => { parsed = resolve })
    try {
      expect(flow.accept({ attachmentId: 'synthetic-setup', streamSeq: 0,
        bytes: new TextEncoder().encode('synthetic install failure\r\n') }, {
        write: (bytes, callback) => tracking.write(bytes, () => { callback(); parsed() }),
        acknowledge: () => undefined, recover: reason => { throw Error(reason) }
      })).toBe(true)
      if (settledFirst) await parsing
      flow.detach('synthetic-setup'); capture.finish()
      expect(await readSetupLastLines(terminal)).toContain('synthetic install failure')
      await capture.captureNow(); capture.schedule(); capture.dispose()
      expect(save).not.toHaveBeenCalled()
    } finally { tracking.dispose(); capture.dispose(); terminal.dispose() }
  })
})
