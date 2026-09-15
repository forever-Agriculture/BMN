// MODULE: terminal-view-tracking.ts - separates user viewport scrolls from output growth for layout persistence
import { failureDetail } from './bridge-error'
import { userScrollUpdate, type SessionView, type SessionViewUpdate } from './workspace-layout'

export interface TrackedTerminal {
  readonly buffer: { readonly active: { readonly viewportY: number; readonly baseY: number } }
  onScroll(listener: (line: number) => void): { dispose(): void }
  scrollToLine(line: number): void
}

export interface TrackedCapture {
  write(bytes: Uint8Array, settled: () => void): void
  schedule(): void
}

export interface TerminalViewTracking {
  /** Writes one output chunk. Output never reports a view change; settle and capture always run. */
  write(bytes: Uint8Array, settled: () => void): void
  /** Runs a programmatic viewport change (restore, fit, scroll to bottom) without reporting it. */
  quietly<Result>(action: () => Result): Result
  dispose(): void
}

/**
 * xterm fires `onScroll` for output growth as well as for user scrolling. Every output write opens a
 * window that ends in its parse callback; scroll events inside a window belong to output and are
 * never reported. When the last window closes, a following session whose viewport is no longer at
 * the tail was scrolled away by the user during the window, and that is reported then.
 */
export function trackTerminalView(options: {
  terminal: TrackedTerminal
  capture: TrackedCapture
  view(): SessionView
  report(update: SessionViewUpdate): void
  onFailure(message: string): void
}): TerminalViewTracking {
  const { terminal, capture } = options
  let outputWindows = 0
  let quietDepth = 0
  let disposed = false

  const report = (update: SessionViewUpdate | null): void => {
    if (!update || disposed) return
    try {
      options.report(update)
    } catch (error) {
      options.onFailure(failureDetail(error, 'Terminal view could not be recorded'))
    }
  }

  const userLine = (line: number): void => {
    let view: SessionView
    try {
      view = options.view()
    } catch (error) {
      options.onFailure(failureDetail(error, 'Terminal view is unavailable'))
      return
    }
    report(userScrollUpdate(view, line, terminal.buffer.active.baseY))
  }

  const reconcile = (): void => {
    if (outputWindows > 0 || quietDepth > 0 || disposed) return
    let view: SessionView
    try {
      view = options.view()
    } catch (error) {
      options.onFailure(failureDetail(error, 'Terminal view is unavailable'))
      return
    }
    if (!view.followTail) return
    const { viewportY, baseY } = terminal.buffer.active
    report(userScrollUpdate(view, viewportY, baseY))
  }

  const subscription = terminal.onScroll((line) => {
    if (outputWindows > 0 || quietDepth > 0) return
    userLine(line)
  })

  return {
    write: (bytes, settled) => {
      let pinnedLine: number | null = null
      try {
        if (!options.view().followTail) pinnedLine = terminal.buffer.active.viewportY
      } catch (error) {
        options.onFailure(failureDetail(error, 'Terminal view is unavailable'))
      }
      outputWindows += 1
      let closed = false
      const close = (): void => {
        if (closed) return
        closed = true
        outputWindows -= 1
      }
      try {
        capture.write(bytes, () => {
          try {
            if (pinnedLine !== null && !disposed) terminal.scrollToLine(pinnedLine)
          } catch (error) {
            options.onFailure(failureDetail(error, 'Terminal viewport could not be kept'))
          }
          close()
          try {
            settled()
          } catch (error) {
            options.onFailure(failureDetail(error, 'Terminal output could not be acknowledged'))
          }
          try {
            capture.schedule()
          } catch (error) {
            options.onFailure(failureDetail(error, 'Saved output capture could not be scheduled'))
          }
          reconcile()
        })
      } catch (error) {
        close()
        throw error
      }
    },
    quietly: (action) => {
      quietDepth += 1
      try {
        return action()
      } finally {
        quietDepth -= 1
      }
    },
    dispose: () => {
      disposed = true
      subscription.dispose()
    }
  }
}
