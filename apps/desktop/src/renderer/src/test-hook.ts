import type { FileReferenceFlowProbe } from './file-reference-probe'

export interface TerminalTestSnapshot {
  bufferLines: string[]
  cols: number
  rows: number
  refits: number
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
  crossWorkspaceSplit: {
    layoutWorkspaceId: string
    sourceWorkspaceId: string
    paneSessionIds: string[]
    selectedAfterFocus: string | null
    sourceWorkspaceArchived: boolean
    foreignPaneRemovedAfterArchive: boolean
  }
  /** The probing pane's terminal grid while shown, and after another session took its pane and hid it. */
  hiddenPaneSize: {
    shown: { cols: number; rows: number }
    hidden: { cols: number; rows: number }
  }
  attentionTriage: {
    responseTitles: string[]
    responseTitlesAfterUpdate: string[]
    remainingResponseTitles: string[]
    updateTitles: string[]
    updatedUpdateTitles: string[]
    totalCount: number
    progressText: string
    detailsProgressText: string
    keyboardTargetSessionId: string
    noticeResolved: boolean
    focusReturned: boolean
    focusStableAfterIncomingUpdate: boolean
  }
  handoffFlow: {
    draftId: string
    targetSessionId: string
    editedText: string
    fileName: string
    acceptedState: string
    existingInputPreserved: boolean
    payloadOccurrences: number
    attentionResponsesPreserved: boolean
    discardedDraftHidden: boolean
  }
  fileReferenceFlow: FileReferenceFlowProbe
}

export interface TerminalTestHook {
  snapshot(sessionId?: string): TerminalTestSnapshot
  snapshots(): Record<string, TerminalTestSnapshot>
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

interface RegisteredTerminalHook {
  snapshot(): TerminalTestSnapshot
  integration?(): Promise<TerminalIntegrationProbe>
}

const terminalHooks = new WeakMap<HookTarget, Map<string, RegisteredTerminalHook>>()
const terminalFacades = new WeakMap<HookTarget, TerminalTestHook>()

export function installTerminalTestHook(options: {
  enabled: boolean
  target: HookTarget
  sessionId: string
  terminal: TestableTerminal
  getPtyDimensions(): { cols: number; rows: number } | undefined
  getRefitCount(): number
  integration?(): Promise<TerminalIntegrationProbe>
}): () => void {
  if (!options.enabled) return () => undefined

  const entry: RegisteredTerminalHook = {
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
        refits: options.getRefitCount(),
        ...(ptyDimensions ? { ptyCols: ptyDimensions.cols, ptyRows: ptyDimensions.rows } : {})
      }
    },
    ...(options.integration ? { integration: options.integration } : {})
  }
  const registry = terminalHooks.get(options.target) ?? new Map<string, RegisteredTerminalHook>()
  terminalHooks.set(options.target, registry)
  registry.set(options.sessionId, entry)

  let facade = terminalFacades.get(options.target)
  if (!facade) {
    facade = {
      snapshot: (sessionId) => {
        const current = terminalHooks.get(options.target)
        const selected = sessionId
          ? current?.get(sessionId)
          : [...(current?.values() ?? [])].find((candidate) => candidate.integration) ?? current?.values().next().value
        if (!selected) throw new Error(`terminal test snapshot unavailable${sessionId ? ` for ${sessionId}` : ''}`)
        return selected.snapshot()
      },
      snapshots: () => Object.fromEntries(
        [...(terminalHooks.get(options.target)?.entries() ?? [])]
          .map(([sessionId, registered]) => [sessionId, registered.snapshot()])
      )
    }
    Object.defineProperty(facade, 'integration', {
      configurable: true,
      enumerable: true,
      get: () => [...(terminalHooks.get(options.target)?.values() ?? [])]
        .find((candidate) => candidate.integration)?.integration
    })
    terminalFacades.set(options.target, facade)
    Object.defineProperty(options.target, '__aitermTest', {
      configurable: true,
      enumerable: false,
      value: facade
    })
  }
  return () => {
    if (registry.get(options.sessionId) === entry) registry.delete(options.sessionId)
    if (registry.size > 0) return
    terminalHooks.delete(options.target)
    terminalFacades.delete(options.target)
    if (options.target.__aitermTest === facade) delete options.target.__aitermTest
  }
}
