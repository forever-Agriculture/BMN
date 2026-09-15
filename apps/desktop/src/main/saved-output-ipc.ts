import {
  METHOD_REGISTRY,
  type SavedOutputCatalog
} from '@ai-terminal/protocol'
import type { IpcMainInvokeEvent } from 'electron'

interface SavedOutputSource {
  client: {
    request<Result>(
      method: typeof METHOD_REGISTRY.terminalSavedOutputGet,
      params: { sessionId: string }
    ): Promise<Result>
  }
}

interface IpcHandlerRegistrar {
  handle(
    channel: 'aiterm:terminal:saved-output-get',
    listener: (event: IpcMainInvokeEvent, sessionId: unknown) => Promise<SavedOutputCatalog>
  ): void
}

export function installSavedOutputIpcHandler(
  ipc: IpcHandlerRegistrar,
  requireSource: (event: IpcMainInvokeEvent, sessionId: unknown) => SavedOutputSource
): void {
  ipc.handle('aiterm:terminal:saved-output-get', async (event, sessionId) => {
    const current = requireSource(event, sessionId)
    return current.client.request<SavedOutputCatalog>(
      METHOD_REGISTRY.terminalSavedOutputGet,
      { sessionId: sessionId as string }
    )
  })
}
