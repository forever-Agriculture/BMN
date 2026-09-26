import { describe, expect, it } from 'vitest'
import { installTerminalTestHook } from './test-hook'

function fakeTerminal(
  cols = 101,
  rows = 37,
  lines = ['prompt', 'AITERM-1-1-OK'],
  modes = { bracketedPasteMode: false, sendFocusMode: false, mouseTrackingMode: 'none', wraparoundMode: true }
) {
  return {
    cols,
    rows,
    modes,
    buffer: {
      active: {
        length: lines.length,
        getLine(index: number) {
          const line = lines[index]
          return line === undefined ? undefined : { translateToString: () => line }
        }
      }
    }
  }
}

describe('renderer acceptance hook', () => {
  it('is absent in normal mode', () => {
    const target: Record<string, unknown> = {}
    const dispose = installTerminalTestHook({
      enabled: false,
      target,
      sessionId: 'session-a',
      terminal: fakeTerminal(),
      getPtyDimensions: () => ({ cols: 101, rows: 37 }),
      getRefitCount: () => 2,
      getInputCount: () => 5
    })
    expect(Object.hasOwn(target, '__aitermTest')).toBe(false)
    dispose()
  })

  it('exposes buffer, dimensions and the view’s modes only in explicit test mode', () => {
    const target: Record<string, unknown> = {}
    const dispose = installTerminalTestHook({
      enabled: true,
      target,
      sessionId: 'session-a',
      terminal: fakeTerminal(),
      getPtyDimensions: () => ({ cols: 101, rows: 37 }),
      getRefitCount: () => 2,
      getInputCount: () => 5
    })
    const hook = target.__aitermTest as { snapshot(sessionId?: string): unknown; snapshots(): unknown }
    expect(hook).toBeTypeOf('object')
    expect(hook.snapshot()).toEqual({
      bufferLines: ['prompt', 'AITERM-1-1-OK'],
      cols: 101,
      rows: 37,
      refits: 2,
      inputEvents: 5,
      // The modes a rebuilt view must come back with, read from the view itself.
      modes: { bracketedPasteMode: false, sendFocusMode: false, mouseTrackingMode: 'none', wraparoundMode: true },
      ptyCols: 101,
      ptyRows: 37
    })
    expect(hook.snapshot('session-a')).toEqual(hook.snapshot())
    expect(hook.snapshots()).toEqual({ 'session-a': hook.snapshot() })
    dispose()
    expect(Object.hasOwn(target, '__aitermTest')).toBe(false)
  })

  it('drives an optional real-preload integration probe from test mode', async () => {
    const target: Record<string, unknown> = {}
    const probe = {
      workspaceCount: 2,
      sessionMethodSessionId: 'session-a',
      bridgeErrorCodes: { staleLayoutPut: 'REVISION_CONFLICT', unknownSessionSavedOutput: 'NOT_FOUND' },
      launchUnavailable: {
        sessionId: 'session-a',
        notice: 'Launch unavailable: stored arguments are invalid',
        resumeDisabled: true,
        resumeTitle: 'stored arguments are invalid'
      },
      unavailableTemplate: {
        name: 'Broken template — unavailable',
        disabled: true,
        title: 'stored arguments are invalid'
      },
      templateCreatedSession: {
        sessionId: 'session-template',
        name: 'Template session',
        executable: '/bin/bash',
        argv: ['--noprofile'],
        cwd: '/workspace',
        backgroundChoice: 'stop' as const
      },
      treeSelection: {
        sessionId: 'session-a',
        layoutSelectedSessionId: 'session-a'
      },
      crossWorkspaceSplit: {
        layoutWorkspaceId: 'workspace-a',
        sourceWorkspaceId: 'workspace-b',
        paneSessionIds: ['session-a', 'session-b'],
        selectedAfterFocus: 'session-a',
        sourceWorkspaceArchived: true,
        foreignPaneRemovedAfterArchive: true
      },
      workspaceMarkers: {
        before: {
          localPane: null,
          foreignPane: null,
          grid: { cols: 80, rows: 24 },
          localHeading: 42,
          foreignHeading: 42
        },
        foreignPaneAfterLocalChoice: null,
        localPane: 'teal',
        foreignPane: 'rose',
        localSidebar: 'teal',
        foreignSidebar: 'rose',
        foreignPaneLabel: 'Workspace B workspace · Rose marker',
        storedRevisions: { local: 1, foreign: 1 },
        grid: { cols: 80, rows: 24 },
        localHeading: 42,
        foreignHeading: 42
      },
      progressEvidenceSurface: {
        reportedStrip: 'Checks Reported verified Evidence attached (1) evidence · just now',
        bareStrip: 'Task Last observed failed No evidence attached stale self-test · 1 h ago',
        dialog: {
          title: 'Progress — Session A',
          note: 'What evidence reported. BMN keeps the files it attached; it does not check the work.',
          provenance: 'Reported verified · from evidence · just now',
          rowName: 'checks.log',
          rowAvailability: 'text/plain · 26 B',
          previewText: 'self-test: 3 checks passed'
        },
        quiet: {
          inputEventsBefore: 0,
          inputEventsAfter: 0,
          surfaceHeightBefore: 320,
          surfaceHeightWhileOpen: 320,
          surfaceHeightAfter: 320,
          gridBefore: { cols: 80, rows: 24 },
          gridAfter: { cols: 80, rows: 24 }
        },
        colours: {
          verifiedInk: 'rgb(126, 200, 135)',
          verifiedToken: 'rgb(126, 200, 135)',
          failedInk: 'rgb(224, 108, 117)',
          errorToken: 'rgb(224, 108, 117)',
          evidenceInk: 'rgb(163, 163, 163)',
          mutedToken: 'rgb(163, 163, 163)',
          verifiedContrast: 8.1,
          evidenceContrast: 7.6
        },
        focusReturnedToStrip: true,
        focusReturnedToMenuButton: true,
        openedFromPaneMenu: true,
        bareDialog: { title: 'Progress — Session B', body: 'No evidence attached to this report.' }
      },
      hiddenPaneSize: { shown: { cols: 80, rows: 24 }, hidden: { cols: 80, rows: 24 } },
      attentionTriage: {
        responseTitles: ['Question'],
        responseTitlesAfterUpdate: ['Question'],
        remainingResponseTitles: ['Question'],
        updateTitles: ['Update'],
        updatedUpdateTitles: ['Revised update'],
        totalCount: 2,
        progressText: 'Task Failed self-test',
        detailsProgressText: 'Task Failed self-test',
        keyboardTargetSessionId: 'session-b',
        noticeResolved: true,
        focusReturned: true,
        focusStableAfterIncomingUpdate: true
      },
      handoffFlow: {
        draftId: 'handoff-1',
        targetSessionId: 'session-b',
        editedText: 'Edited handoff',
        fileName: 'result.txt',
        acceptedState: 'accepted',
        existingInputPreserved: true,
        payloadOccurrences: 1,
        attentionResponsesPreserved: true,
        discardedDraftHidden: true
      },
      voiceFlow: {
        suggested: ['SessionManager'],
        editedApproved: 'pty-host',
        chipsShareLine: true,
        addWordRejected: { message: 'commas', inputPreserved: true, listUnchanged: true },
        duplicateRejected: { message: 'already', candidateKept: true },
        approvedAfterRemove: ['SessionManager', 'BMN'],
        promptShown: 'SessionManager, BMN',
        persistedInSettings: true,
        fallback: { modelChosenBefore: 'small', modelAfter: 'base', vocabularyKept: true, modelAfterApproval: 'base' },
        recording: { pastedOnce: true, commandNotRun: true, announced: 'Transcript pasted' },
        editDuringRecording: { savedWhileRecording: true, secondPastedOnce: true },
        restarted: { notice: 'restarted', pastedIntoNewIncarnation: false },
        noLiveSessionMessage: 'Select a running session first',
        download: {
          firstStarted: true,
          duplicateRefused: true,
          progressShown: true,
          cancelledReleased: true,
          failureText: 'connection reset',
          retryRefusedWhileErrorVisible: true,
          dismissVisible: true,
          dismissed: true,
          dismissStayedDismissed: true,
          modelRestored: true
        }
      },
      fileReferenceFlow: {
        launchDirectory: '/work',
        palette: {
          focusedInput: true,
          base: '/work',
          file: '/work/refs/src/parser.ts',
          marked: 'target',
          position: 'Line 42, column 7 of 60 lines',
          copied: '/work/refs/src/parser.ts:42:7',
          shownFeedback: 'Shown in the file manager.',
          focusReturned: true
        },
        shellDirectoryIgnored: { base: '/work', file: '/work/src/parser.ts', message: 'No file exists at this path.' },
        chosenFolder: { pickerMessage: 'File dialogs are unavailable in this run', kind: 'chosen-directory', canonicalPath: '/work/refs/src/parser.ts' },
        rejected: { message: 'Shell variables are not expanded; enter the full path.', inputPreserved: true },
        link: {
          reference: 'refs/src/parser.ts:42:7',
          session: 'Shell · Work',
          marked: 'target',
          selectedElsewhere: true,
          underlinedWithCtrl: true,
          focusReturned: true
        },
        contextMenuClick: { reference: 'refs/src/parser.ts:42:7', focusReturned: true },
        plainClick: { underlined: false, opened: false },
        ctrlDrag: { selected: 'refs/src/', copiedSelection: true, opened: false },
        missingSessionCode: 'NOT_FOUND',
        mouseMode: { underlined: false, opened: false, reportsToProgram: 2, dragReportsToProgram: 2, copiedSelection: true, rightClickPasted: true },
        ptyInputEvents: 0,
        crossWorkspace: {
          session: 'Archived running chat · Self-test archived workspace',
          base: '/tmp/self-test',
          file: '/tmp/self-test/refs/src/parser.ts',
          marked: 'FILE-REFERENCE-TARGET line 42'
        },
        redraw: {
          underlinedBefore: true,
          staleOpened: false,
          staleUnderlined: false,
          reference: 'refs/src/parser.ts:7',
          marked: 'line 7',
          ptyInputEvents: 0
        },
        terminalUnchanged: true,
        terminalGeometry: { before: '80x24 refits 2', after: '80x24 refits 2', sameElement: true },
        attentionUnchanged: true,
        epic27: null
      }
    }
    const integration = async () => probe
    installTerminalTestHook({
      enabled: true,
      target,
      sessionId: 'session-a',
      terminal: fakeTerminal(),
      getPtyDimensions: () => undefined,
      getRefitCount: () => 2,
      getInputCount: () => 5,
      integration
    })
    await expect((target.__aitermTest as { integration(): Promise<unknown> }).integration())
      .resolves.toEqual(probe)
  })

  it('registers every test terminal and removes the facade after the last pane unmounts', () => {
    const target: Record<string, unknown> = {}
    const disposeA = installTerminalTestHook({
      enabled: true,
      target,
      sessionId: 'session-a',
      terminal: fakeTerminal(),
      getPtyDimensions: () => ({ cols: 101, rows: 37 }),
      getRefitCount: () => 2,
      getInputCount: () => 5
    })
    const disposeB = installTerminalTestHook({
      enabled: true,
      target,
      sessionId: 'session-b',
      terminal: fakeTerminal(80, 24, ['foreign']),
      getPtyDimensions: () => ({ cols: 80, rows: 24 }),
      getRefitCount: () => 3,
      getInputCount: () => 7
    })
    const hook = target.__aitermTest as {
      snapshot(sessionId?: string): { cols: number; rows: number; refits: number }
      snapshots(): Record<string, { cols: number; rows: number; refits: number }>
    }
    expect(hook.snapshot('session-b')).toMatchObject({ cols: 80, rows: 24, refits: 3 })
    expect(Object.keys(hook.snapshots())).toEqual(['session-a', 'session-b'])
    disposeA()
    expect(Object.keys(hook.snapshots())).toEqual(['session-b'])
    disposeB()
    expect(Object.hasOwn(target, '__aitermTest')).toBe(false)
  })
})
