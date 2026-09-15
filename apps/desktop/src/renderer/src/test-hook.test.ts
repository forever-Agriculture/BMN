import { describe, expect, it } from 'vitest'
import { installTerminalTestHook } from './test-hook'

function fakeTerminal() {
  const lines = ['prompt', 'AITERM-1-1-OK']
  return {
    cols: 101,
    rows: 37,
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
      terminal: fakeTerminal(),
      getPtyDimensions: () => ({ cols: 101, rows: 37 })
    })
    expect(Object.hasOwn(target, '__aitermTest')).toBe(false)
    dispose()
  })

  it('exposes buffer and terminal dimensions only in explicit test mode', () => {
    const target: Record<string, unknown> = {}
    const dispose = installTerminalTestHook({
      enabled: true,
      target,
      terminal: fakeTerminal(),
      getPtyDimensions: () => ({ cols: 101, rows: 37 })
    })
    const hook = target.__aitermTest as { snapshot(): unknown }
    expect(hook).toBeTypeOf('object')
    expect(hook.snapshot()).toEqual({
      bufferLines: ['prompt', 'AITERM-1-1-OK'],
      cols: 101,
      rows: 37,
      ptyCols: 101,
      ptyRows: 37
    })
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
      }
    }
    const integration = async () => probe
    installTerminalTestHook({
      enabled: true,
      target,
      terminal: fakeTerminal(),
      getPtyDimensions: () => undefined,
      integration
    })
    await expect((target.__aitermTest as { integration(): Promise<unknown> }).integration())
      .resolves.toEqual(probe)
  })
})
