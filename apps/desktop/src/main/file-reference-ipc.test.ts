// MODULE: file-reference-ipc.test.ts - sender checks and argument bounds on the file-reference renderer channels
import { METHOD_REGISTRY } from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { installFileReferenceIpcHandlers, type FileReferenceIpcActions } from './file-reference-ipc'

type Handler = (event: IpcMainInvokeEvent, params?: unknown) => unknown

const allowed = { allowed: true } as unknown as IpcMainInvokeEvent
const stranger = { allowed: false } as unknown as IpcMainInvokeEvent

function install(overrides: Partial<FileReferenceIpcActions> = {}): {
  handlers: Map<string, Handler>
  requests: Array<{ method: string; params: object }>
  shown: string[]
} {
  const handlers = new Map<string, Handler>()
  const requests: Array<{ method: string; params: object }> = []
  const shown: string[] = []
  installFileReferenceIpcHandlers({ handle: (channel, listener) => handlers.set(channel, listener) }, {
    client: () => ({
      request: async <Result,>(method: string, params: object) => {
        requests.push({ method, params })
        return { status: 'ready' } as Result
      }
    }),
    senderIsAllowed: (event) => (event as unknown as { allowed: boolean }).allowed,
    chooseFolder: async () => '/home/me/project',
    showInFolder: (path) => shown.push(path),
    ...overrides
  })
  return { handlers, requests, shown }
}

/** Handlers may throw before returning a promise, as ipcMain.handle allows. */
async function failure(call: () => unknown): Promise<{ code: string; message: string }> {
  try {
    await call()
  } catch (error) {
    return error as { code: string; message: string }
  }
  throw new Error('expected the handler to fail')
}

describe('file-reference IPC', () => {
  it('forwards only the addressed session, reference and chosen folder to the utility', async () => {
    const { handlers, requests } = install()
    await handlers.get('aiterm:file-reference:read')!(allowed, {
      sessionId: 'session-1',
      reference: 'src/a.ts:4',
      baseDirectory: '/home/me/other',
      extra: 'ignored'
    })
    await handlers.get('aiterm:file-reference:read')!(allowed, { sessionId: 'session-1', reference: 'a.md' })
    expect(requests).toEqual([
      {
        method: METHOD_REGISTRY.fileReferenceRead,
        params: { sessionId: 'session-1', reference: 'src/a.ts:4', baseDirectory: '/home/me/other' }
      },
      { method: METHOD_REGISTRY.fileReferenceRead, params: { sessionId: 'session-1', reference: 'a.md', baseDirectory: null } }
    ])
  })

  it('rejects other senders and malformed reads before reaching the utility', async () => {
    const { handlers, requests } = install()
    const read = handlers.get('aiterm:file-reference:read')!
    expect((await failure(() => read(stranger, { sessionId: 's', reference: 'a.md' }))).code).toBe('UNAUTHORIZED')
    expect((await failure(() => read(allowed, null))).code).toBe('INVALID_ARGUMENT')
    expect((await failure(() => read(allowed, { sessionId: 's', reference: 'x'.repeat(5000) }))).code).toBe('INVALID_ARGUMENT')
    expect((await failure(() => read(allowed, { sessionId: '', reference: 'a.md' }))).code).toBe('INVALID_ARGUMENT')
    expect((await failure(() => read(allowed, { sessionId: 's', reference: 'a.md', baseDirectory: 7 }))).code).toBe('INVALID_ARGUMENT')
    expect(requests).toEqual([])
  })

  it('returns the chosen folder or null when the picker is cancelled', async () => {
    expect(await install().handlers.get('aiterm:file-reference:choose-base')!(allowed)).toBe('/home/me/project')
    const cancelled = install({ chooseFolder: async () => null })
    expect(await cancelled.handlers.get('aiterm:file-reference:choose-base')!(allowed)).toBeNull()
    expect((await failure(() => cancelled.handlers.get('aiterm:file-reference:choose-base')!(stranger))).code).toBe('UNAUTHORIZED')
  })

  it('shows only an absolute normalized file path', async () => {
    const { handlers, shown } = install()
    const show = handlers.get('aiterm:file-reference:show')!
    expect(await show(allowed, { path: '/home/me/project/src/a.ts' })).toEqual({ shown: true })
    for (const path of ['src/a.ts', '/home/me/../etc/passwd', '/home/me/a\u0007.ts', '', 42]) {
      expect((await failure(() => show(allowed, { path }))).code).toBe('INVALID_ARGUMENT')
    }
    expect((await failure(() => show(stranger, { path: '/home/me/a.ts' }))).code).toBe('UNAUTHORIZED')
    expect(shown).toEqual(['/home/me/project/src/a.ts'])
  })
})
