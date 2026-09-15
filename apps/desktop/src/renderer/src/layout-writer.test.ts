// MODULE: layout-writer.test.ts - serialization, coalescing and conflict recovery of the single layout write path
import { describe, expect, it, vi } from 'vitest'
import {
  ERROR_CODES,
  emptyWorkspaceLayout,
  type LayoutPutParams,
  type WorkspaceLayoutState
} from '@ai-terminal/protocol'
import { createLayoutWriter, LAYOUT_CONFLICT_RETRY_LIMIT, type LayoutWriterPort } from './layout-writer'
import { routeSessionView, selectLayoutSession, splitLayoutSession } from './workspace-layout'

const ids = ['session-a', 'session-b']
const sessions = ids.map((sessionId, position) => ({
  sessionId,
  workspaceId: 'workspace-1',
  name: sessionId,
  cwd: '/workspace',
  executable: '/bin/bash',
  argv: [],
  position,
  backgroundChoice: null,
  revision: 1,
  createdAt: '2026-09-13T00:00:00.000Z',
  lastProcess: null
}))

interface Deferred {
  params: LayoutPutParams
  settle(): void
}

/** A host that applies the real layout.put revision rule, optionally holding each put until released. */
function host(initial: WorkspaceLayoutState, options: { hold?: boolean } = {}) {
  let stored = initial
  const puts: LayoutPutParams[] = []
  const held: Deferred[] = []
  const apply = (params: LayoutPutParams): WorkspaceLayoutState => {
    if (params.expectedRevision !== stored.revision || params.state.revision !== params.expectedRevision) {
      throw {
        name: 'BridgeError',
        code: ERROR_CODES.revisionConflict,
        message: `Workspace layout ${params.workspaceId} has revision ${stored.revision}`
      }
    }
    stored = { ...params.state, revision: stored.revision + 1 }
    return stored
  }
  const port = {
    put: vi.fn((params: LayoutPutParams) => {
      puts.push(structuredClone(params))
      if (!options.hold) return Promise.resolve().then(() => apply(params))
      return new Promise<WorkspaceLayoutState>((resolve, reject) => {
        held.push({
          params,
          settle: () => {
            try {
              resolve(apply(params))
            } catch (error) {
              reject(error)
            }
          }
        })
      })
    }),
    get: vi.fn(async () => ({ layout: stored, notice: null })),
    publish: vi.fn(),
    notice: vi.fn(),
    failure: vi.fn()
  } satisfies LayoutWriterPort
  return {
    port,
    puts,
    held,
    stored: () => stored,
    replace: (next: WorkspaceLayoutState) => {
      stored = next
    }
  }
}

describe('layout writer', () => {
  it('serializes two rapid writes: the second put carries the first result revision', async () => {
    const fake = host(emptyWorkspaceLayout('workspace-1'), { hold: true })
    const writer = createLayoutWriter(fake.port)
    writer.reset([emptyWorkspaceLayout('workspace-1')])

    expect(writer.apply('workspace-1', (state) => selectLayoutSession(state, 'session-a', ids))).toBe(true)
    expect(writer.apply('workspace-1', (state) => splitLayoutSession(state, 'session-b', ids))).toBe(true)
    expect(fake.puts).toHaveLength(1)
    expect(fake.puts[0]).toMatchObject({ expectedRevision: 1, state: { revision: 1, selectedSessionId: 'session-a' } })
    expect(writer.layout('workspace-1')?.split.panes).toHaveLength(2)

    fake.held[0]!.settle()
    await vi.waitFor(() => expect(fake.puts).toHaveLength(2))
    expect(fake.puts[1]).toMatchObject({
      expectedRevision: 2,
      state: { revision: 2, selectedSessionId: 'session-b' }
    })
    fake.held[1]!.settle()
    await writer.idle('workspace-1')
    expect(fake.stored()).toMatchObject({ revision: 3, selectedSessionId: 'session-b' })
    expect(writer.layout('workspace-1')).toEqual(fake.stored())
    expect(fake.port.failure).not.toHaveBeenCalled()
  })

  it('coalesces every change made while a put is in flight into one follow-up put', async () => {
    const fake = host(emptyWorkspaceLayout('workspace-1'), { hold: true })
    const writer = createLayoutWriter(fake.port)
    writer.reset([emptyWorkspaceLayout('workspace-1')])
    writer.apply('workspace-1', (state) => selectLayoutSession(state, 'session-a', ids))
    for (const line of [10, 11, 12, 13]) {
      const route = routeSessionView(sessions, 'session-a', { kind: 'scrolled-away', scrollLine: line })!
      writer.apply(route.workspaceId, route.change)
    }
    expect(fake.puts).toHaveLength(1)
    fake.held[0]!.settle()
    await vi.waitFor(() => expect(fake.puts).toHaveLength(2))
    expect(fake.puts[1]!.state.sessionView['session-a']).toEqual({ scrollLine: 13, followTail: false })
    fake.held[1]!.settle()
    await writer.idle('workspace-1')
    expect(fake.puts).toHaveLength(2)
  })

  it('does not write when a change leaves the desired state unchanged', async () => {
    const fake = host(emptyWorkspaceLayout('workspace-1'))
    const writer = createLayoutWriter(fake.port)
    writer.reset([selectLayoutSession(emptyWorkspaceLayout('workspace-1'), 'session-a', ids)])
    const route = routeSessionView(sessions, 'session-a', { kind: 'follow-tail' })!
    expect(writer.apply(route.workspaceId, route.change)).toBe(false)
    await writer.idle('workspace-1')
    expect(fake.puts).toHaveLength(0)
  })

  it('re-fetches on a typed REVISION_CONFLICT and re-applies pending changes on the authoritative revision', async () => {
    const initial = selectLayoutSession(emptyWorkspaceLayout('workspace-1'), 'session-a', ids)
    const fake = host(initial)
    const writer = createLayoutWriter(fake.port)
    writer.reset([initial])
    const authoritative = { ...splitLayoutSession(initial, 'session-b', ids), revision: 4 }
    fake.replace(authoritative)

    const route = routeSessionView(sessions, 'session-a', { kind: 'scrolled-away', scrollLine: 7 })!
    writer.apply(route.workspaceId, route.change)
    await writer.idle('workspace-1')

    expect(fake.port.get).toHaveBeenCalledOnce()
    expect(fake.puts.map((put) => put.expectedRevision)).toEqual([1, 4])
    expect(fake.stored()).toMatchObject({
      revision: 5,
      selectedSessionId: 'session-b',
      sessionView: { 'session-a': { scrollLine: 7, followTail: false } }
    })
    expect(writer.layout('workspace-1')).toEqual(fake.stored())
    expect(fake.port.failure).not.toHaveBeenCalled()
  })

  it('treats only the typed code as a conflict and reverts to authoritative state on other failures', async () => {
    const initial = selectLayoutSession(emptyWorkspaceLayout('workspace-1'), 'session-a', ids)
    const fake = host(initial)
    fake.port.put.mockImplementationOnce(async () => {
      throw new Error('REVISION_CONFLICT: message text is not a code')
    })
    const writer = createLayoutWriter(fake.port)
    writer.reset([initial])
    const route = routeSessionView(sessions, 'session-a', { kind: 'scrolled-away', scrollLine: 3 })!
    writer.apply(route.workspaceId, route.change)
    await writer.idle('workspace-1')

    expect(fake.port.get).not.toHaveBeenCalled()
    expect(fake.port.failure).toHaveBeenCalledWith('REVISION_CONFLICT: message text is not a code')
    expect(writer.layout('workspace-1')).toBe(initial)
    expect(fake.port.publish).toHaveBeenLastCalledWith(initial)
  })

  it('gives up after bounded consecutive conflicts instead of looping', async () => {
    const initial = selectLayoutSession(emptyWorkspaceLayout('workspace-1'), 'session-a', ids)
    const fake = host(initial)
    fake.port.put.mockImplementation(async () => {
      throw { name: 'BridgeError', code: ERROR_CODES.revisionConflict, message: 'always stale' }
    })
    const writer = createLayoutWriter(fake.port)
    writer.reset([initial])
    const route = routeSessionView(sessions, 'session-a', { kind: 'scrolled-away', scrollLine: 3 })!
    writer.apply(route.workspaceId, route.change)
    await writer.idle('workspace-1')
    expect(fake.port.put).toHaveBeenCalledTimes(LAYOUT_CONFLICT_RETRY_LIMIT + 1)
    expect(fake.port.failure).toHaveBeenCalledOnce()
    expect(writer.layout('workspace-1')).toBe(initial)
  })

  it('never throws from apply: a rejected transition reports failure and writes nothing', async () => {
    const fake = host(emptyWorkspaceLayout('workspace-1'))
    const writer = createLayoutWriter(fake.port)
    writer.reset([emptyWorkspaceLayout('workspace-1')])
    expect(writer.apply('workspace-1', (state) => selectLayoutSession(state, 'session-unknown', ids))).toBe(false)
    expect(writer.apply('workspace-missing', (state) => state)).toBe(false)
    await writer.idle('workspace-1')
    expect(fake.puts).toHaveLength(0)
    expect(fake.port.failure).toHaveBeenCalledWith('Workspace layout transition produced an invalid state')
  })

  it('discards a result that lands after reset replaced the lane', async () => {
    const fake = host(emptyWorkspaceLayout('workspace-1'), { hold: true })
    const writer = createLayoutWriter(fake.port)
    writer.reset([emptyWorkspaceLayout('workspace-1')])
    writer.apply('workspace-1', (state) => selectLayoutSession(state, 'session-a', ids))
    const replacement = { ...emptyWorkspaceLayout('workspace-1'), revision: 9 }
    writer.reset([replacement])
    fake.held[0]!.settle()
    await Promise.resolve()
    await Promise.resolve()
    expect(writer.layout('workspace-1')).toBe(replacement)
  })
})
