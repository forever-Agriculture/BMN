import { Terminal } from '@xterm/headless'
import {
  SAVED_OUTPUT_FORMAT_VERSION,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_SAVED_OUTPUT_RETENTION,
  TERMINAL_UNDELIVERED_OUTPUT_BYTES,
  type SavedOutputCapture,
  type SavedOutputSnapshot
} from '@ai-terminal/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  captureLiveTerminalSnapshot,
  installLiveTerminalSearch,
  liveTerminalOptions,
  openSavedOutput,
  savedOutputPresentation,
  startSavedOutputCapture
} from './terminal-history'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('live terminal history and saved output', () => {
  it('waits for every previously accepted real xterm write before persisting a final capture', async () => {
    const terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    const saved: SavedOutputCapture[] = []
    const settled = vi.fn()
    const capture = startSavedOutputCapture(
      terminal,
      async (snapshot) => {
        saved.push(snapshot)
      },
      vi.fn()
    )
    try {
      capture.write(new TextEncoder().encode('pending output'), settled)

      await capture.captureNow()

      expect(saved.at(-1)?.content).toContain('pending output')
      expect(settled).toHaveBeenCalledOnce()
    } finally {
      capture.dispose()
      terminal.dispose()
    }
  })
  it('finds output beyond the visible screen inside the named scrollback bound', async () => {
    const terminal = new Terminal({
      cols: 24,
      rows: 3,
      allowProposedApi: true,
      ...liveTerminalOptions()
    })
    try {
      await write(
        terminal,
        Array.from({ length: 30 }, (_, index) =>
          index === 4 ? 'hidden needle\r\n' : `line ${index}\r\n`
        ).join('')
      )
      expect(terminal.buffer.active.baseY).toBeGreaterThan(0)
      expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)

      let selection:
        | { start: { x: number; y: number }; end: { x: number; y: number } }
        | undefined
      let selectedText = ''
      const searchable = terminal as unknown as Terminal & {
        getSelectionPosition(): typeof selection
        clearSelection(): void
        select(column: number, row: number, length: number): void
      }
      searchable.getSelectionPosition = () => selection
      searchable.clearSelection = () => {
        selection = undefined
        selectedText = ''
      }
      searchable.select = (column, row, length) => {
        selection = {
          start: { x: column, y: row },
          end: { x: column + length, y: row }
        }
        selectedText =
          terminal.buffer.active.getLine(row)?.translateToString().slice(column, column + length) ?? ''
      }

      const search = installLiveTerminalSearch(searchable)
      expect(search.findNext('needle')).toBe(true)
      expect(selectedText).toBe('needle')
      expect(terminal.buffer.active.viewportY).toBeLessThan(terminal.buffer.active.baseY)
      expect(liveTerminalOptions().scrollback).toBe(TERMINAL_SCROLLBACK_LINES)
      search.dispose()
    } finally {
      terminal.dispose()
    }
  })

  it('captures text and presents full saved-output disclosure in a separate model', async () => {
    const terminal = new Terminal({
      cols: 20,
      rows: 3,
      allowProposedApi: true,
      ...liveTerminalOptions()
    })
    try {
      await write(terminal, 'older\r\ncurrent prompt')
      const capture = captureLiveTerminalSnapshot(
        terminal,
        () => new Date('2026-09-12T08:00:00.000Z')
      )
      const snapshot: SavedOutputSnapshot = {
        formatVersion: SAVED_OUTPUT_FORMAT_VERSION,
        sessionId: 'session-1',
        incarnationId: 'incarnation-1',
        viewEpoch: 'view-1',
        ...capture,
        captureStartedAt: '2026-09-12T07:30:00.000Z',
        lineLimit: TERMINAL_SCROLLBACK_LINES,
        snapshotLimitBytes: 64 * 1024 * 1024,
        snapshotTruncated: true,
        snapshotDroppedLines: 2,
        snapshotDroppedBytes: null,
        transportDroppedBytes: 32,
        processState: 'interrupted'
      }
      const presentation = savedOutputPresentation(snapshot)

      expect(capture).toMatchObject({ retainedLines: 3 })
      expect(presentation.content).toContain('current prompt')
      expect(presentation.disclosure).toContain('Captured: 2026-09-12T08:00:00.000Z')
      expect(presentation.disclosure).toContain('Capture began: 2026-09-12T07:30:00.000Z')
      expect(presentation.disclosure).toContain('10,000 lines')
      expect(presentation.disclosure).toContain('64 MiB saved output')
      expect(presentation.disclosure).toContain('Snapshot truncated: yes · at least 2 lines omitted')
      expect(presentation.disclosure).toContain('dropped byte count unknown')
      expect(presentation.disclosure).toContain('Transport loss before this view: 32 bytes dropped')
      expect(presentation.processLabel).toBe('Process interrupted · saved output is not live')
      expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('current prompt')

      const show = vi.fn()
      await openSavedOutput(async () => ({
        view: {
          sessionId: snapshot.sessionId,
          incarnationId: snapshot.incarnationId,
          viewEpoch: snapshot.viewEpoch
        },
        current: snapshot,
        history: [],
        finalCaptureUnavailable: [],
        unreadable: [],
        retention: { limit: TERMINAL_SAVED_OUTPUT_RETENTION, pruned: 0 }
      }), show)
      expect(show).toHaveBeenCalledWith({ current: presentation, history: [], notices: [] })
    } finally {
      terminal.dispose()
    }
  })

  it('discloses real xterm scrollback truncation beyond 10,000 short lines', async () => {
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
      ...liveTerminalOptions()
    })
    const terminalWithLines = (length: number) => ({
      buffer: {
        active: {
          length,
          getLine: (index: number) => ({
            translateToString: () => `line ${index}`
          })
        }
      }
    })

    try {
      await write(
        terminal,
        Array.from(
          { length: TERMINAL_SCROLLBACK_LINES + 50 },
          (_, index) => `line ${index}\r\n`
        ).join('')
      )
      const longCapture = captureLiveTerminalSnapshot(terminal)
      const shortCapture = captureLiveTerminalSnapshot(terminalWithLines(2))

      expect(terminal.buffer.active.baseY).toBe(TERMINAL_SCROLLBACK_LINES)
      expect(longCapture.retainedLines).toBe(TERMINAL_SCROLLBACK_LINES)
      expect(longCapture).toMatchObject({
        snapshotTruncated: true,
        snapshotDroppedBytes: null
      })
      expect(longCapture.snapshotDroppedLines).toBeGreaterThan(0)
      expect(longCapture.content.split('\n')).toHaveLength(TERMINAL_SCROLLBACK_LINES)
      expect(new TextEncoder().encode(longCapture.content).byteLength).toBeLessThan(
        TERMINAL_UNDELIVERED_OUTPUT_BYTES
      )
      expect(shortCapture).toMatchObject({ retainedLines: 2, content: 'line 0\nline 1' })
    } finally {
      terminal.dispose()
    }
  })

  it('labels the source session and uses singular retained-line grammar', async () => {
    const snapshot: SavedOutputSnapshot = {
      formatVersion: SAVED_OUTPUT_FORMAT_VERSION,
      sessionId: 'another-session',
      incarnationId: 'another-incarnation',
      viewEpoch: 'another-view',
      capturedAt: '2026-09-12T08:00:00.000Z',
      captureStartedAt: '2026-09-12T07:30:00.000Z',
      content: 'other session output',
      retainedLines: 1,
      lineLimit: TERMINAL_SCROLLBACK_LINES,
      snapshotLimitBytes: 64 * 1024 * 1024,
      snapshotTruncated: false,
      snapshotDroppedLines: 0,
      snapshotDroppedBytes: 0,
      transportDroppedBytes: 0,
      processState: 'exited'
    }
    const show = vi.fn()

    await openSavedOutput(async () => ({
      view: {
        sessionId: 'current-session',
        incarnationId: 'current-incarnation',
        viewEpoch: 'current-view'
      },
      history: [snapshot],
      finalCaptureUnavailable: [],
      unreadable: [],
      retention: { limit: TERMINAL_SAVED_OUTPUT_RETENTION, pruned: 0 }
    }), show)

    expect(show).toHaveBeenCalledWith({
      history: [expect.objectContaining({
        sessionLabel: 'Session: another-session · incarnation: another-incarnation',
        disclosure: expect.stringContaining('Retained: 1 line')
      })],
      notices: []
    })
  })

  it('labels a same-incarnation prior view and presents loss, unreadable, and pruning disclosures', async () => {
    const prior: SavedOutputSnapshot = {
      formatVersion: SAVED_OUTPUT_FORMAT_VERSION,
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
      viewEpoch: 'view-before-crash',
      capturedAt: '2026-09-13T10:00:00.000Z',
      captureStartedAt: '2026-09-13T09:00:00.000Z',
      content: 'pre-crash output',
      retainedLines: 1,
      lineLimit: TERMINAL_SCROLLBACK_LINES,
      snapshotLimitBytes: 64 * 1024 * 1024,
      snapshotTruncated: false,
      snapshotDroppedLines: 0,
      snapshotDroppedBytes: 0,
      transportDroppedBytes: 0,
      processState: 'live'
    }

    const show = vi.fn()
    await openSavedOutput(async () => ({
      view: {
        sessionId: prior.sessionId,
        incarnationId: prior.incarnationId,
        viewEpoch: 'restored-view'
      },
      history: [prior],
      finalCaptureUnavailable: [{
        formatVersion: SAVED_OUTPUT_FORMAT_VERSION,
        sessionId: prior.sessionId,
        incarnationId: prior.incarnationId,
        viewEpoch: 'restored-view',
        unavailableAt: '2026-09-13T10:05:00.000Z',
        reason: 'no-renderer',
        detail: 'renderer unavailable',
        lastCaptureAt: prior.capturedAt,
        processState: 'interrupted'
      }],
      unreadable: [{
        source: 'future.json',
        reason: 'unsupported-format',
        sessionId: prior.sessionId,
        incarnationId: prior.incarnationId
      }],
      retention: { limit: TERMINAL_SAVED_OUTPUT_RETENTION, pruned: 2 }
    }), show)

    expect(show).toHaveBeenCalledWith({
      history: [expect.objectContaining({
        sessionLabel: expect.stringContaining(
          'captured before this view was restored at 2026-09-13T10:00:00.000Z'
        )
      })],
      notices: expect.arrayContaining([
        expect.stringContaining(
          'Final capture unavailable at 2026-09-13T10:05:00.000Z (no renderer); output after 2026-09-13T10:00:00.000Z was not saved.'
        ),
        expect.stringContaining('Unreadable saved-output entry for session session-1, incarnation incarnation-1'),
        expect.stringContaining('2 oldest records were pruned')
      ])
    })
  })
})
