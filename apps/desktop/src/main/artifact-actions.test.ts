// MODULE: artifact-actions.test.ts - Show in Folder checks original integrity without requiring a decodable preview.
import { METHOD_REGISTRY, type ArtifactRecord, type ProtocolMethod } from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { installCompanionIpcHandlers, type CompanionIpcActions } from './companion-ipc'

const os = vi.hoisted(() => ({ showItemInFolder: vi.fn() }))
vi.mock('electron', () => ({ shell: os, clipboard: {}, dialog: {}, BrowserWindow: {} }))

function install(preview: unknown, failure?: Error) {
  const artifact = { artifactId: 'synthetic', storedPath: '/synthetic/original' } as ArtifactRecord
  const handlers = new Map<string, (event: IpcMainInvokeEvent, params?: unknown) => unknown>()
  const actions: CompanionIpcActions = {
    senderIsAllowed: () => true,
    dialogsEnabled: () => false,
    client: () => ({ request: async <Result>(method: ProtocolMethod): Promise<Result> => {
      if (method === METHOD_REGISTRY.artifactList) return [artifact] as Result
      if (failure) throw failure
      return preview as Result
    } })
  }
  installCompanionIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } }, actions)
  return () => handlers.get('aiterm:artifact:show')!({} as IpcMainInvokeEvent, { artifactId: 'synthetic' })
}

describe('Show in Folder original checks', () => {
  it.each([
    { kind: 'unsupported', content: null },
    { kind: 'image', content: 'undecodable synthetic bytes' }
  ])('reveals an available original even when its preview is $kind', async (preview) => {
    os.showItemInFolder.mockClear()
    await expect(install(preview)()).resolves.toEqual({ shown: true })
    expect(os.showItemInFolder).toHaveBeenCalledOnce()
    expect(os.showItemInFolder).toHaveBeenCalledWith('/synthetic/original')
  })

  it('refuses a missing/corrupt original visibly before calling the OS', async () => {
    os.showItemInFolder.mockClear()
    await expect(install(null, new Error('The stored original is missing'))()).rejects.toThrow(/missing/)
    expect(os.showItemInFolder).not.toHaveBeenCalled()
  })
})
