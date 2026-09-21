import type { FileReferenceFlowProbe } from './file-reference-probe'
import type { ProgressEvidenceProbe } from './progress-evidence-probe'
import type { VoiceFlowProbe } from './voice-probe'

export interface TerminalTestSnapshot {
  bufferLines: string[]
  cols: number
  rows: number
  refits: number
  /** Everything xterm would send to the PTY for this pane, counted since the terminal opened. */
  inputEvents: number
  /** The view's own belief about the modes the program set; what paste, focus and mouse read. */
  modes: { bracketedPasteMode: boolean; sendFocusMode: boolean; mouseTrackingMode: string }
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
  /** Epic 11: each pane's marker comes from its own workspace, and choosing one moves no geometry. */
  workspaceMarkers: {
    before: {
      localPane: string | null
      foreignPane: string | null
      grid: { cols: number; rows: number }
      localHeading: number
      foreignHeading: number
    }
    foreignPaneAfterLocalChoice: string | null
    localPane: string | null
    foreignPane: string | null
    localSidebar: string | null
    foreignSidebar: string | null
    foreignPaneLabel: string | null
    storedRevisions: { local: number; foreign: number }
    grid: { cols: number; rows: number }
    localHeading: number
    foreignHeading: number
  }
  /** Epic 12: the progress detail's words, its quiet behaviour and the two ways into it. */
  progressEvidenceSurface: ProgressEvidenceProbe
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
  voiceFlow: VoiceFlowProbe
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
  modes: { bracketedPasteMode: boolean; sendFocusMode: boolean; mouseTrackingMode: string }
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
  getInputCount(): number
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
        inputEvents: options.getInputCount(),
        modes: {
          bracketedPasteMode: options.terminal.modes.bracketedPasteMode,
          sendFocusMode: options.terminal.modes.sendFocusMode,
          mouseTrackingMode: options.terminal.modes.mouseTrackingMode
        },
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
