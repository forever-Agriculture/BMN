export interface TerminalTestSnapshot {
  bufferLines: string[]
  cols: number
  rows: number
  ptyCols?: number
  ptyRows?: number
}

/** Result of the self-test probe that drives real preload methods through the contextBridge. */
export interface TerminalIntegrationProbe {
  workspaceCount: number
  sessionMethodSessionId: string
  /** The typed `BridgeError.code` each deliberate failure carried across the bridge, or `untyped`. */
  bridgeErrorCodes: { staleLayoutPut: string; unknownSessionSavedOutput: string }
  launchUnavailable: {
    sessionId: string
    notice: string
    resumeDisabled: boolean
    resumeTitle: string
  }
  unavailableTemplate: {
    name: string
    disabled: boolean
    title: string
  }
  templateCreatedSession: {
    sessionId: string
    name: string
    executable: string
    argv: string[]
    cwd: string
    backgroundChoice: 'hide' | 'stop' | null
  }
  treeSelection: {
    sessionId: string
    layoutSelectedSessionId: string | null
  }
}

export interface TerminalTestHook {
  snapshot(): TerminalTestSnapshot
  integration?(): Promise<TerminalIntegrationProbe>
}

interface TerminalLine {
  translateToString(trimRight?: boolean): string
}

interface TestableTerminal {
  cols: number
  rows: number
  buffer: {
    active: {
      length: number
      getLine(index: number): TerminalLine | undefined
    }
  }
}

interface HookTarget {
  __aitermTest?: TerminalTestHook
}

export function installTerminalTestHook(options: {
  enabled: boolean
  target: HookTarget
  terminal: TestableTerminal
  getPtyDimensions(): { cols: number; rows: number } | undefined
  integration?(): Promise<TerminalIntegrationProbe>
}): () => void {
  if (!options.enabled) return () => undefined

  const hook: TerminalTestHook = {
    snapshot: () => {
      const bufferLines: string[] = []
      const buffer = options.terminal.buffer.active
      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index)
        if (line) bufferLines.push(line.translateToString(true))
      }
      const ptyDimensions = options.getPtyDimensions()
      return {
        bufferLines,
        cols: options.terminal.cols,
        rows: options.terminal.rows,
        ...(ptyDimensions ? { ptyCols: ptyDimensions.cols, ptyRows: ptyDimensions.rows } : {})
      }
    },
    ...(options.integration ? { integration: options.integration } : {})
  }
  Object.defineProperty(options.target, '__aitermTest', {
    configurable: true,
    enumerable: false,
    value: hook
  })
  return () => {
    if (options.target.__aitermTest === hook) delete options.target.__aitermTest
  }
}
