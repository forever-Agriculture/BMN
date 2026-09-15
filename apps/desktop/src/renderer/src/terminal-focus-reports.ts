// MODULE: terminal-focus-reports.ts - DECSET 1004 focus reports that also say when the owner has stepped away
/** Focus-in and focus-out reports a process receives after enabling mode 1004. */
export const FOCUS_IN = '\x1b[I'
export const FOCUS_OUT = '\x1b[O'

export interface OwnerPresence {
  away: boolean
}

export interface FocusReports {
  /** True for a report xterm wrote itself; the caller drops it so only these reports reach the process. */
  isFocusReport(data: string): boolean
  paneFocus(focused: boolean): void
  presence(presence: OwnerPresence): void
  dispose(): void
}

/**
 * A focused pane in a focused window still reads as "owner watching" after the owner walks away, so agents such
 * as Claude Code hold back mobile pushes. The process is told it has focus only while the pane is focused and the
 * owner is present.
 */
export function createFocusReports(options: { reportsEnabled(): boolean; send(report: string): void }): FocusReports {
  let paneFocused = false
  let away = false
  let focused = false
  let disposed = false
  const update = (): void => {
    const next = !disposed && paneFocused && !away
    if (next === focused) return
    focused = next
    if (options.reportsEnabled()) options.send(next ? FOCUS_IN : FOCUS_OUT)
  }
  return {
    isFocusReport: (data) => data === FOCUS_IN || data === FOCUS_OUT,
    paneFocus: (value) => {
      paneFocused = value
      update()
    },
    presence: (value) => {
      away = value.away
      update()
    },
    dispose: () => {
      disposed = true
      update()
    }
  }
}
