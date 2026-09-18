import { SearchAddon } from '@xterm/addon-search'
import { failureDetail } from './bridge-error'
import type { Terminal as BrowserTerminal, ITerminalOptions } from '@xterm/xterm'
import {
  TERMINAL_SCROLLBACK_LINES,
  type SavedOutputCapture,
  type SavedOutputCatalog,
  type SavedOutputSnapshot
} from '@bmn/protocol'

interface BufferLine {
  translateToString(trimRight?: boolean): string
}

interface SnapshotTerminal {
  readonly buffer: {
    readonly active: {
      readonly length: number
      getLine(index: number): BufferLine | undefined
    }
  }
}

interface CaptureTerminal extends SnapshotTerminal {
  write(data: string | Uint8Array, callback?: () => void): void
}

interface SearchTerminal extends SnapshotTerminal {
  clearSelection(): void
}

export interface SavedOutputPresentation {
  key: string
  capturedAt: string
  sessionId: string
  incarnationId: string
  viewEpoch: string
  content: string
  disclosure: string
  processLabel: string
  sessionLabel: string
}

export interface SavedOutputCatalogPresentation {
  current?: SavedOutputPresentation
  history: SavedOutputPresentation[]
  notices: string[]
}

export const SAVED_OUTPUT_CAPTURE_INTERVAL_MS = 30_000

export function isLiveSearchShortcut(event: {
  ctrlKey: boolean
  shiftKey: boolean
  key: string
}): boolean {
  return event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f'
}

export function liveTerminalOptions(): Pick<ITerminalOptions, 'scrollback'> {
  return { scrollback: TERMINAL_SCROLLBACK_LINES }
}

export function installLiveTerminalSearch(terminal: SearchTerminal): {
  findNext(term: string): boolean
  findPrevious(term: string): boolean
  clear(): void
  dispose(): void
} {
  const addon = new SearchAddon()
  addon.activate(terminal as unknown as BrowserTerminal)
  const options = { caseSensitive: false, incremental: false, regex: false, wholeWord: false }
  return {
    findNext: (term) => addon.findNext(term, options),
    findPrevious: (term) => addon.findPrevious(term, options),
    clear: () => {
      addon.clearDecorations()
      terminal.clearSelection()
    },
    dispose: () => addon.dispose()
  }
}

export function captureLiveTerminalSnapshot(
  terminal: SnapshotTerminal,
  now: () => Date = () => new Date(),
  transportDroppedBytes = 0
): SavedOutputCapture {
  const buffer = terminal.buffer.active
  const retainedLines = Math.min(buffer.length, TERMINAL_SCROLLBACK_LINES)
  const firstLine = buffer.length - retainedLines
  const lines = Array.from(
    { length: retainedLines },
    (_, index) => buffer.getLine(firstLine + index)?.translateToString(true) ?? ''
  )
  return {
    capturedAt: now().toISOString(),
    content: lines.join('\n'),
    retainedLines,
    snapshotTruncated: firstLine > 0,
    snapshotDroppedLines: firstLine,
    snapshotDroppedBytes: firstLine > 0 ? null : 0,
    transportDroppedBytes
  }
}

export function startSavedOutputCapture(
  terminal: CaptureTerminal,
  save: (capture: SavedOutputCapture) => Promise<unknown>,
  onFailure: (message: string) => void,
  transportDroppedBytes: () => number = () => 0
): {
  write(bytes: Uint8Array, settled: () => void): void
  captureNow(): Promise<void>
  schedule(): void
  dispose(): void
} {
  let scheduled: ReturnType<typeof setTimeout> | undefined
  let acceptedWrites = 0
  let completedWrites = 0
  let captureTail = Promise.resolve()
  const writeWaiters = new Set<{ boundary: number; resolve(): void }>()
  const settleWriteWaiters = (): void => {
    for (const waiter of writeWaiters) {
      if (completedWrites < waiter.boundary) continue
      writeWaiters.delete(waiter)
      waiter.resolve()
    }
  }
  const waitForWritesThrough = (boundary: number): Promise<void> =>
    completedWrites >= boundary
      ? Promise.resolve()
      : new Promise((resolve) => writeWaiters.add({ boundary, resolve }))
  const captureNow = (): Promise<void> => {
    if (scheduled) {
      clearTimeout(scheduled)
      scheduled = undefined
    }
    const boundary = acceptedWrites
    const capture = captureTail.then(async () => {
      await waitForWritesThrough(boundary)
      try {
        await save(captureLiveTerminalSnapshot(terminal, () => new Date(), transportDroppedBytes()))
      } catch (error) {
        const detail = failureDetail(error, 'unknown persistence error')
        onFailure(`Saved output could not be captured: ${detail.slice(0, 240)}`)
        throw error
      }
    })
    captureTail = capture.catch(() => undefined)
    return capture
  }
  const timer = setInterval(
    () => void captureNow().catch(() => undefined),
    SAVED_OUTPUT_CAPTURE_INTERVAL_MS
  )
  const schedule = (): void => {
    if (scheduled) clearTimeout(scheduled)
    scheduled = setTimeout(() => void captureNow().catch(() => undefined), 250)
  }
  return {
    write: (bytes, settled) => {
      acceptedWrites += 1
      terminal.write(bytes, () => {
        completedWrites += 1
        settled()
        settleWriteWaiters()
      })
    },
    captureNow,
    schedule,
    dispose: () => {
      clearInterval(timer)
      if (scheduled) clearTimeout(scheduled)
    }
  }
}

function bytesLabel(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`
  return `${bytes.toLocaleString('en-US')} bytes`
}

export function savedOutputPresentation(
  snapshot: SavedOutputSnapshot,
  capturedBeforeRestoredView = false
): SavedOutputPresentation {
  const processLabel = snapshot.processState === 'live'
    ? 'Process live at open time'
    : snapshot.processState === 'exited'
      ? 'Process exited · saved output is not live'
      : 'Process interrupted · saved output is not live'
  const retainedLineUnit = snapshot.retainedLines === 1 ? 'line' : 'lines'
  return {
    key: `${snapshot.sessionId}\u0000${snapshot.incarnationId}\u0000${snapshot.viewEpoch}`,
    capturedAt: snapshot.capturedAt,
    sessionId: snapshot.sessionId,
    incarnationId: snapshot.incarnationId,
    viewEpoch: snapshot.viewEpoch,
    content: snapshot.content,
    disclosure: [
      `Captured: ${snapshot.capturedAt}`,
      `Capture began: ${snapshot.captureStartedAt}`,
      `Limits: ${snapshot.lineLimit.toLocaleString('en-US')} lines · ${bytesLabel(snapshot.snapshotLimitBytes)} saved output`,
      `Retained: ${snapshot.retainedLines.toLocaleString('en-US')} ${retainedLineUnit}`,
      snapshot.snapshotTruncated === null
        ? 'Snapshot truncation: unknown · this legacy capture did not record snapshot measurements'
        : snapshot.snapshotTruncated
        ? `Snapshot truncated: yes · at least ${(snapshot.snapshotDroppedLines ?? 0).toLocaleString('en-US')} lines omitted · dropped byte count unknown`
        : 'Snapshot truncated: no',
      snapshot.transportDroppedBytes === null
        ? 'Transport loss before this view: unknown · this legacy capture did not record it'
        : snapshot.transportDroppedBytes > 0
        ? `Transport loss before this view: ${snapshot.transportDroppedBytes.toLocaleString('en-US')} bytes dropped`
        : 'Transport loss before this view: none',
      'Output newer than this saved capture may be unavailable.'
    ].join('\n'),
    processLabel,
    sessionLabel: capturedBeforeRestoredView
      ? `Session: ${snapshot.sessionId} · incarnation: ${snapshot.incarnationId} · captured before this view was restored at ${snapshot.capturedAt}`
      : `Session: ${snapshot.sessionId} · incarnation: ${snapshot.incarnationId}`
  }
}

function unavailableReasonLabel(reason: SavedOutputCatalog['finalCaptureUnavailable'][number]['reason']): string {
  if (reason === 'no-renderer') return 'no renderer'
  if (reason === 'renderer-destroyed') return 'renderer destroyed'
  if (reason === 'not-acknowledged-in-time') return 'not acknowledged in time'
  return 'capture or persistence failure'
}

export async function loadSavedOutputPresentation(
  load: () => Promise<SavedOutputCatalog>
): Promise<SavedOutputCatalogPresentation> {
  const catalog = await load()
  const notices = [
    ...catalog.finalCaptureUnavailable.map((failure) =>
      `Final capture unavailable at ${failure.unavailableAt} (${unavailableReasonLabel(failure.reason)}); output after ${failure.lastCaptureAt ?? 'no capture'} was not saved.`
    ),
    ...catalog.unreadable.map((entry) => {
      const identity = entry.sessionId
        ? ` for session ${entry.sessionId}${entry.incarnationId ? `, incarnation ${entry.incarnationId}` : ''}${entry.viewEpoch ? `, view ${entry.viewEpoch}` : ''}`
        : ''
      return `Unreadable saved-output entry${identity}: ${entry.reason === 'unsupported-format' ? 'unsupported format' : 'invalid data'} (${entry.source}).`
    }),
    ...(catalog.retention.pruned > 0
      ? [`Saved-output retention keeps ${catalog.retention.limit.toLocaleString('en-US')} records; ${catalog.retention.pruned.toLocaleString('en-US')} oldest records were pruned.`]
      : [])
  ]
  return {
    ...(catalog.current ? { current: savedOutputPresentation(catalog.current) } : {}),
    history: catalog.history.map((snapshot) =>
      savedOutputPresentation(
        snapshot,
        snapshot.sessionId === catalog.view.sessionId &&
          snapshot.incarnationId === catalog.view.incarnationId &&
          snapshot.viewEpoch !== catalog.view.viewEpoch
      )
    ),
    notices
  }
}

export async function openSavedOutput(
  load: () => Promise<SavedOutputCatalog>,
  show: (presentation: SavedOutputCatalogPresentation) => void
): Promise<void> {
  show(await loadSavedOutputPresentation(load))
}
