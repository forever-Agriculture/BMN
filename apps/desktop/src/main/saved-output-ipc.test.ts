import {
  METHOD_REGISTRY,
  TERMINAL_SAVED_OUTPUT_RETENTION,
  type SavedOutputCatalog
} from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { installSavedOutputIpcHandler } from './saved-output-ipc'

describe('saved-output IPC', () => {
  it('forwards the current session identity to the host route', async () => {
    const calls: Array<{ method: string; params: object }> = []
    const session = { sessionId: 'current-session', incarnationId: 'current-incarnation' }
    const attachment = { attachmentId: 'current-view' }
    const catalog = {
      view: { ...session, viewEpoch: attachment.attachmentId },
      history: [],
      finalCaptureUnavailable: [],
      unreadable: [],
      retention: { limit: TERMINAL_SAVED_OUTPUT_RETENTION, pruned: 0 }
    } satisfies SavedOutputCatalog
    const client = {
      async request<Result>(
        method: typeof METHOD_REGISTRY.terminalSavedOutputGet,
        params: { sessionId: string }
      ): Promise<Result> {
        calls.push({ method, params })
        return catalog as Result
      }
    }
    let handler:
      | ((event: IpcMainInvokeEvent, sessionId: unknown) => Promise<SavedOutputCatalog>)
      | undefined
    const ipc = {
      handle(
        channel: 'aiterm:terminal:saved-output-get',
        listener: (event: IpcMainInvokeEvent, sessionId: unknown) => Promise<SavedOutputCatalog>
      ): void {
        expect(channel).toBe('aiterm:terminal:saved-output-get')
        handler = listener
      }
    }
    installSavedOutputIpcHandler(ipc, () => ({ client }))

    await expect(handler?.({} as IpcMainInvokeEvent, session.sessionId)).resolves.toBe(catalog)
    expect(calls).toEqual([{
      method: METHOD_REGISTRY.terminalSavedOutputGet,
      params: { sessionId: session.sessionId }
    }])
  })
})
