// MODULE: file-reference-ipc.test.ts - sender checks and argument bounds on the file-reference renderer channels
import { METHOD_REGISTRY } from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { installFileReferenceIpcHandlers, type FileReferenceIpcActions } from './file-reference-ipc'

type Handler = (event: IpcMainInvokeEvent, params?: unknown) => unknown

const allowed = { allowed: true, sender: { id: 1 } } as unknown as IpcMainInvokeEvent
const otherWindow = { allowed: true, sender: { id: 2 } } as unknown as IpcMainInvokeEvent
const stranger = { allowed: false, sender: { id: 3 } } as unknown as IpcMainInvokeEvent

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
        return { status: 'ready', canonicalPath: '/home/me/project/src/a.ts' } as Result
      }
    }),
    senderIsAllowed: (event) => (event as unknown as { allowed: boolean }).allowed,
    ownerFocused: () => true,
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

  it('reveals only a file this window was shown, given as an absolute normalized path', async () => {
    const { handlers, shown } = install()
    const show = handlers.get('aiterm:file-reference:show')!
    expect((await failure(() => show(allowed, { path: '/home/me/project/src/a.ts' }))).code).toBe('INVALID_ARGUMENT')
    await handlers.get('aiterm:file-reference:read')!(allowed, { sessionId: 's', reference: 'src/a.ts' })
    expect(await show(allowed, { path: '/home/me/project/src/a.ts' })).toEqual({ shown: true })
    expect((await failure(() => show(otherWindow, { path: '/home/me/project/src/a.ts' }))).code).toBe('INVALID_ARGUMENT')
    for (const path of ['src/a.ts', '/home/me/../etc/passwd', '/home/me/a\u0007.ts', '', 42]) {
      expect((await failure(() => show(allowed, { path }))).code).toBe('INVALID_ARGUMENT')
    }
    expect((await failure(() => show(stranger, { path: '/home/me/a.ts' }))).code).toBe('UNAUTHORIZED')
    expect(shown).toEqual(['/home/me/project/src/a.ts'])
  })

  it('pastes only from a focused owner window after that window previewed the exact file', async () => {
    const { handlers, requests } = install()
    const paste = handlers.get('aiterm:file-reference:paste')!
    const request = {
      requestId: 'one', sessionId: 'target', expectedIncarnationId: 'run-1',
      sourcePath: '/home/me/project/src/a.ts', line: 7, column: null
    }
    expect((await failure(() => paste(allowed, request))).code).toBe('INVALID_ARGUMENT')
    await handlers.get('aiterm:file-reference:read')!(allowed, { sessionId: 'source', reference: 'src/a.ts' })
    expect((await failure(() => paste(otherWindow, request))).code).toBe('INVALID_ARGUMENT')
    expect((await failure(() => paste(stranger, request))).code).toBe('UNAUTHORIZED')
    await paste(allowed, { ...request, extra: 'ignored' })
    expect(requests.at(-1)).toEqual({ method: METHOD_REGISTRY.fileReferencePaste, params: request })
    const blurred = install({ ownerFocused: () => false })
    await blurred.handlers.get('aiterm:file-reference:read')!(allowed, { sessionId: 'source', reference: 'src/a.ts' })
    expect((await failure(() => blurred.handlers.get('aiterm:file-reference:paste')!(allowed, request))).message)
      .toMatch(/lost focus/)
  })

  it('forwards one bounded search and its matching cancellation request', async () => {
    const { handlers, requests } = install()
    const search = {
      ownerId: 'palette', requestId: 'query-one', workspaceId: 'workspace',
      sessionId: 'session', query: 'parser'
    }
    await handlers.get('aiterm:file-reference:search')!(allowed, { ...search, extra: 'ignored' })
    await handlers.get('aiterm:file-reference:search-cancel')!(allowed, {
      ownerId: search.ownerId, requestId: search.requestId
    })
    expect(requests).toEqual([
      { method: METHOD_REGISTRY.fileReferenceSearch, params: search },
      { method: METHOD_REGISTRY.fileReferenceSearchCancel, params: { ownerId: 'palette', requestId: 'query-one' } }
    ])
    expect((await failure(() => handlers.get('aiterm:file-reference:search')!(allowed, { ...search, query: 'x'.repeat(257) }))).code)
      .toBe('INVALID_ARGUMENT')
    expect((await failure(() => handlers.get('aiterm:file-reference:search')!(stranger, search))).code)
      .toBe('UNAUTHORIZED')
  })
})
