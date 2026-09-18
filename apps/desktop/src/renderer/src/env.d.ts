/// <reference types="vite/client" />

import '../../preload/bridge'

interface TerminalTestSnapshot {
  bufferLines: string[]
  cols: number
  rows: number
  refits: number
  ptyCols?: number
  ptyRows?: number
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
  }
}
