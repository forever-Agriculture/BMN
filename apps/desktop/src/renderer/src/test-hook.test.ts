import { describe, expect, it } from 'vitest'
import { installTerminalTestHook } from './test-hook'

function fakeTerminal(cols = 101, rows = 37, lines = ['prompt', 'AITERM-1-1-OK']) {
  return {
    cols,
    rows,
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
      getRefitCount: () => 2
    })
    expect(Object.hasOwn(target, '__aitermTest')).toBe(false)
    dispose()
  })

  it('exposes buffer and terminal dimensions only in explicit test mode', () => {
    const target: Record<string, unknown> = {}
    const dispose = installTerminalTestHook({
      enabled: true,
      target,
      sessionId: 'session-a',
      terminal: fakeTerminal(),
      getPtyDimensions: () => ({ cols: 101, rows: 37 }),
      getRefitCount: () => 2
    })
    const hook = target.__aitermTest as { snapshot(sessionId?: string): unknown; snapshots(): unknown }
    expect(hook).toBeTypeOf('object')
    expect(hook.snapshot()).toEqual({
      bufferLines: ['prompt', 'AITERM-1-1-OK'],
      cols: 101,
      rows: 37,
      refits: 2,
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
      hiddenPaneSize: { shown: { cols: 80, rows: 24 }, hidden: { cols: 80, rows: 24 } }
    }
    const integration = async () => probe
    installTerminalTestHook({
      enabled: true,
      target,
      sessionId: 'session-a',
      terminal: fakeTerminal(),
      getPtyDimensions: () => undefined,
      getRefitCount: () => 2,
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
      getRefitCount: () => 2
    })
    const disposeB = installTerminalTestHook({
      enabled: true,
      target,
      sessionId: 'session-b',
      terminal: fakeTerminal(80, 24, ['foreign']),
      getPtyDimensions: () => ({ cols: 80, rows: 24 }),
      getRefitCount: () => 3
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
