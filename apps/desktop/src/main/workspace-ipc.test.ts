import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { ERROR_CODES, METHOD_REGISTRY } from '@bmn/protocol'
import {
  installWorkspaceIpcHandlers,
  requireSessionRuntime
} from './workspace-ipc'

describe('workspace IPC', () => {
  it('sender-validates a workspace method and forwards it to the utility host', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, params?: unknown) => unknown>()
    const request = vi.fn(async () => [{ workspaceId: 'workspace-1' }])
    installWorkspaceIpcHandlers(
      { handle: (channel, listener) => handlers.set(channel, listener) },
      (event) => (event as unknown as { allowed: boolean }).allowed,
      { client: () => ({ request: request as never }), createSession: vi.fn() }
    )
    const allowed = { allowed: true } as unknown as IpcMainInvokeEvent
    await expect(handlers.get('aiterm:workspace:list')?.(allowed, { includeArchived: true }))
      .resolves.toEqual([{ workspaceId: 'workspace-1' }])
    expect(request).toHaveBeenCalledWith(METHOD_REGISTRY.workspaceList, { includeArchived: true })
    const denied = { allowed: false } as unknown as IpcMainInvokeEvent
    expect(() => handlers.get('aiterm:workspace:list')?.(denied, {}))
      .toThrowError(expect.objectContaining({ code: ERROR_CODES.unauthorized }))
  })

  it('returns NOT_FOUND for an unknown explicit session and never substitutes focus', () => {
    const focused = { sessionId: 'focused' }
    const runtimes = new Map([['focused', focused]])
    const event = {} as IpcMainInvokeEvent
    expect(() => requireSessionRuntime(event, 'missing', () => true, runtimes))
      .toThrowError(expect.objectContaining({ code: ERROR_CODES.notFound }))
    expect(() => requireSessionRuntime(event, undefined, () => true, runtimes))
      .toThrowError(expect.objectContaining({ code: ERROR_CODES.invalidArgument }))
    expect(requireSessionRuntime(event, 'focused', () => true, runtimes)).toBe(focused)
  })
})
