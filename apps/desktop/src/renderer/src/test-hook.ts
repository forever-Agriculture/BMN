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
  imageStorageMB: number
  imageLayerPresent: boolean
  /** The view's own belief about the modes the program set; what paste, focus, mouse and wrapping read. */
  modes: {
    bracketedPasteMode: boolean
    sendFocusMode: boolean
    mouseTrackingMode: string
    wraparoundMode: boolean
    /** Story 32.3: the rest of the tracked modes — 1, 6, 25, 1006 and 1049. */
    applicationCursorKeysMode: boolean
    originMode: boolean
    cursorHidden: boolean | null
    mouseEncoding: string | null
    alternateScreen: boolean
  }
  ptyCols?: number
  ptyRows?: number
}

/** Where a view's images sit: buffer lines holding an image cell, and the cells they are cut into. */
export interface TerminalImageCells {
  lines: number[]
  cssCellHeight: number
  deviceCellHeight: number
  devicePixelRatio: number
  fontSize: number
}

/** Test-only reads and actions a view offers beyond its snapshot. */
export interface TerminalViewProbe {
  imageCells(): TerminalImageCells
  /** Selects a buffer range as a user drag would and returns the selected text. */
  select(column: number, row: number, length: number): string
  selection(): string
  clearSelection(): void
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
    /** Story 32.1: the first response row's age text and accessible name. */
    firstResponseRow: { age: string; label: string }
  }
  handoffFlow: {
    draftId: string
    targetSessionId: string
    editedText: string
    /** Story 35.2: Insert outline offered on an empty box, off once it holds text, and the outline pasted whole. */
    outline: Record<'outlineOfferedEmpty' | 'outlineFilled' | 'outlineFocused' | 'outlineOfferedAgain' | 'outlineOffAfterTyping' |
      'outlineOffForWhitespace' | 'outlineOffForSavedText' | 'pastedWhole', boolean>
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
  sixelFixture(sessionId: string): Promise<{ storageMB: number; layer: boolean }>
  view(sessionId: string): TerminalViewProbe
  integration?(): Promise<TerminalIntegrationProbe>
}

interface TerminalLine {
  translateToString(trimRight?: boolean): string
}

interface TestableTerminal {
  cols: number
  rows: number
  modes: {
    bracketedPasteMode: boolean
    sendFocusMode: boolean
    mouseTrackingMode: string
    wraparoundMode: boolean
    applicationCursorKeysMode: boolean
    originMode: boolean
  }
  /** xterm's own services; the cursor's visibility and the mouse encoding have no public reader. Test mode only. */
  _core?: { coreService?: { isCursorHidden?: boolean }; coreMouseService?: { activeEncoding?: string } }
  buffer: {
    active: {
      type?: string
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
  sixelFixture(): Promise<{ storageMB: number; layer: boolean }>
  view?: TerminalViewProbe
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
  getImageStorageMB(): number
  imageLayerPresent(): boolean
  sixelFixture(): Promise<{ storageMB: number; layer: boolean }>
  view?: TerminalViewProbe
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
        imageStorageMB: options.getImageStorageMB(),
        imageLayerPresent: options.imageLayerPresent(),
        modes: {
          bracketedPasteMode: options.terminal.modes.bracketedPasteMode,
          sendFocusMode: options.terminal.modes.sendFocusMode,
          mouseTrackingMode: options.terminal.modes.mouseTrackingMode,
          wraparoundMode: options.terminal.modes.wraparoundMode,
          applicationCursorKeysMode: options.terminal.modes.applicationCursorKeysMode,
          originMode: options.terminal.modes.originMode,
          cursorHidden: options.terminal._core?.coreService?.isCursorHidden ?? null,
          mouseEncoding: options.terminal._core?.coreMouseService?.activeEncoding ?? null,
          alternateScreen: options.terminal.buffer.active.type === 'alternate'
        },
        ...(ptyDimensions ? { ptyCols: ptyDimensions.cols, ptyRows: ptyDimensions.rows } : {})
      }
    },
    sixelFixture: options.sixelFixture,
    ...(options.view ? { view: options.view } : {}),
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
      ),
      sixelFixture: (sessionId) => {
        const selected = terminalHooks.get(options.target)?.get(sessionId)
        if (!selected) throw new Error(`terminal test fixture unavailable for ${sessionId}`)
        return selected.sixelFixture()
      },
      view: (sessionId) => {
        const selected = terminalHooks.get(options.target)?.get(sessionId)?.view
        if (!selected) throw new Error(`terminal view probe unavailable for ${sessionId}`)
        return selected
      }
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
