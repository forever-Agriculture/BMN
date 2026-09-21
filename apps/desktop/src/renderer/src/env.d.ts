/// <reference types="vite/client" />

import '../../preload/bridge'

interface TerminalTestSnapshot {
  bufferLines: string[]
  cols: number
  rows: number
  refits: number
  /** Everything xterm would send to the PTY for this pane, counted since the terminal opened. */
  inputEvents: number
  modes: { bracketedPasteMode: boolean; sendFocusMode: boolean; mouseTrackingMode: string; wraparoundMode: boolean }
  ptyCols?: number
  ptyRows?: number
}

/** Test mode only: what the shell derived for each live session, and how often it published a change. */
interface ActivityTestHook {
  words(): Record<string, string>
  titles(): Record<string, string | null>
  updates(): Record<string, number>
}

interface TerminalTestHook {
  snapshot(sessionId?: string): TerminalTestSnapshot
  snapshots(): Record<string, TerminalTestSnapshot>
  integration?(): Promise<{
    workspaceCount: number
    sessionMethodSessionId: string
    bridgeErrorCodes: { staleLayoutPut: string; unknownSessionSavedOutput: string }
    launchUnavailable: {
      sessionId: string
      notice: string
      resumeDisabled: boolean
      resumeTitle: string
    }
    unavailableTemplate: { name: string; disabled: boolean; title: string }
  }>
}

declare global {
  interface Window {
    __aitermTest?: TerminalTestHook
    __bmnActivity?: ActivityTestHook
  }
}
