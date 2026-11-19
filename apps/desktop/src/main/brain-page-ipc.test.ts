// MODULE: brain-page-ipc.test.ts - The Brain page channel refuses other senders and frames, forwards only plain read requests, and the control socket gains nothing (Epic 128 D5)
import { METHOD_REGISTRY } from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BRAIN_PAGE_CHANNEL, installBrainPageIpc } from './brain-page-ipc'
import { BRAIN_PAGE_COMMANDS, brainPageRequest, type BrainPageReads } from '../utility/brain-page-route'

type Handler = (event: IpcMainInvokeEvent, request?: unknown) => unknown
interface FakeEvent { allowed: boolean; window: boolean; packaged: boolean }
const event = (overrides: Partial<FakeEvent> = {}): IpcMainInvokeEvent => ({ allowed: true, window: true, packaged: true, ...overrides }) as unknown as IpcMainInvokeEvent
const here = dirname(fileURLToPath(import.meta.url))

function install(): { handler: Handler; requests: Array<{ method: string; params: object }> } {
  const handlers = new Map<string, Handler>()
  const requests: Array<{ method: string; params: object }> = []
  installBrainPageIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, {
    senderIsAllowed: (e) => (e as unknown as FakeEvent).allowed,
    fromApplicationWindow: (e) => (e as unknown as FakeEvent).window,
    fromPackagedPage: (e) => (e as unknown as FakeEvent).packaged,
    request: async <Result,>(method: string, params: object) => { requests.push({ method, params }); return { ok: true } as Result }
  })
  return { handler: handlers.get(BRAIN_PAGE_CHANNEL)!, requests }
}

async function failure(call: () => unknown): Promise<{ code: string; message: string }> {
  try { await call() } catch (error) { return error as { code: string; message: string } }
  throw new Error('expected the handler to fail')
}

describe('Brain page window channel', () => {
  it('forwards a read from BMN’s own window to the private page method', async () => {
    const { handler, requests } = install()
    await expect(handler(event(), { command: 'search', query: 'backup decision', archived: false })).resolves.toEqual({ ok: true })
    expect(requests).toEqual([{ method: METHOD_REGISTRY.brainPage, params: { command: 'search', query: 'backup decision', archived: false } }])
  })

  it('refuses another sender, another window or another frame before any request', async () => {
    const { handler, requests } = install()
    for (const bad of [event({ allowed: false }), event({ window: false }), event({ packaged: false })]) {
      expect((await failure(() => handler(bad, { command: 'list' }))).code).toBe('UNAUTHORIZED')
    }
    expect(requests).toEqual([])
  })

  it('refuses unknown keys and non-plain values', async () => {
    const { handler, requests } = install()
    expect((await failure(() => handler(event(), { command: 'read', id: 'x', markdown: 'new text' }))).message).toMatch(/Unexpected/)
    expect((await failure(() => handler(event(), { command: 'read', id: { $ne: 1 } }))).message).toMatch(/Unexpected/)
    expect((await failure(() => handler(event(), ['list']))).message).toMatch(/object/)
    expect(requests).toEqual([])
  })
})

describe('Brain page route on the private parent port', () => {
  const calls: string[] = []
  const reads: BrainPageReads = {
    admission: async () => { calls.push('admission'); return { storeId: 's', committed: true, open: true, receipt: null } },
    pageList: async (options) => { calls.push('list ' + JSON.stringify(options)); return { notes: [], total: 0, withdrawn: 0, offset: 0 } },
    pageSearch: async (query, archived) => { calls.push(`search ${query} ${archived}`); return { notes: [], limited: false } },
    pageRead: async (id) => { calls.push('read ' + id); return {} as never },
    pageHistory: async (id) => { calls.push('history ' + id); return [] },
    pageGraph: async (id, options) => { calls.push('graph ' + id + ' ' + JSON.stringify(options)); return {} as never }
  }

  it('offers reads only: no write command exists, and unknown ones are refused', async () => {
    expect(Object.keys(BRAIN_PAGE_COMMANDS).sort()).toEqual(['graph', 'history', 'list', 'read', 'search', 'status'])
    for (const command of ['write', 'edit', 'withdraw', 'restore', 'delete', 'import', 'open-door', 'export', 'backup']) {
      await expect(brainPageRequest(reads, { command })).rejects.toThrow(/Unknown Brain page request/)
    }
    await expect(brainPageRequest(reads, { command: 'read', id: 'a', revision: 1 })).rejects.toThrow(/Unexpected/)
    await expect(brainPageRequest(reads, { command: 'graph', id: 'a', depth: 4 })).rejects.toThrow(/depth/)
    await expect(brainPageRequest(reads, { command: 'list', offset: -1 })).rejects.toThrow(/offset/)
    expect(calls).toEqual([])
  })

  it('answers status, list, search, read, history and graph from the worker reads', async () => {
    await expect(brainPageRequest(reads, { command: 'status' })).resolves.toEqual({ state: 'ready' })
    await brainPageRequest(reads, { command: 'list', archived: true })
    await brainPageRequest(reads, { command: 'search', query: 'QA backup' })
    await brainPageRequest(reads, { command: 'read', id: 'n1' })
    await brainPageRequest(reads, { command: 'history', id: 'n1' })
    await brainPageRequest(reads, { command: 'graph', id: 'n1', depth: 2, archived: true })
    expect(calls).toEqual(['admission', 'list {"archived":true,"withdrawn":false,"offset":0}', 'search QA backup false', 'read n1', 'history n1', 'graph n1 {"depth":2,"archived":true}'])
  })

  it('says the brain has not switched when the commit receipt is missing', async () => {
    const before: BrainPageReads = { ...reads, admission: async () => ({ storeId: 's', committed: false, open: false, receipt: null }) }
    await expect(brainPageRequest(before, { command: 'status' })).resolves.toEqual({ state: 'not-switched' })
  })

  it('adds no control-socket method: the socket server never names the page route', () => {
    const server = readFileSync(join(here, '../utility/control-server.ts'), 'utf8')
    expect(server).not.toMatch(/brainPage|app\.brainPage|page-read|brain-page/)
    const cli = readFileSync(join(here, '../../bin/brain-cli.mjs'), 'utf8')
    expect(cli).not.toMatch(/brainPage|brain-page/)
  })
})
