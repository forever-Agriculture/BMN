// MODULE: companion-ipc.test.ts - desktop notifications skip the watched session and repeat only on a new revision
import { DEFAULT_APP_SETTINGS, METHOD_REGISTRY, type AttentionRecord } from '@ai-terminal/protocol'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))

const { createAppEventForwarder } = await import('./companion-ipc')

function request(requestId: string, sessionId: string, revision = 1): AttentionRecord {
  return {
    requestId,
    sessionId,
    incarnationId: null,
    requestKey: `claude:${requestId}`,
    kind: 'permission',
    title: `Allow ${requestId}`,
    body: null,
    state: 'open',
    resolution: null,
    openedAt: '2026-09-15T00:00:00.000Z',
    expiresAt: null,
    resolvedAt: null,
    seenAt: null,
    revision
  }
}

function forwarder(initiallyWatched: string | null): {
  events: ReturnType<typeof createAppEventForwarder>
  open: AttentionRecord[]
  shown: Array<{ title: string; body: string; sessionId: string }>
  seen: string[]
  watch(sessionId: string | null): void
} {
  const open: AttentionRecord[] = []
  const shown: Array<{ title: string; body: string; sessionId: string }> = []
  const seen: string[] = []
  let watched = initiallyWatched
  const events = createAppEventForwarder({
    client: () => ({
      request: async <Result,>(method: string, params: object) => {
        if (method === METHOD_REGISTRY.attentionSeen) {
          const { requestId } = params as { requestId: string }
          seen.push(requestId)
          const index = open.findIndex((candidate) => candidate.requestId === requestId)
          open[index] = { ...open[index]!, seenAt: '2026-09-15T00:00:01.000Z' }
          return open[index] as Result
        }
        return (method === METHOD_REGISTRY.attentionList ? [...open] : DEFAULT_APP_SETTINGS) as Result
      }
    }),
    targets: () => [],
    watching: (sessionId) => sessionId === watched,
    notify: (notification) => shown.push(notification),
    notificationsEnabled: () => true
  })
  return { events, open, shown, seen, watch: (sessionId) => { watched = sessionId } }
}

async function attentionEvent(events: ReturnType<typeof createAppEventForwarder>): Promise<void> {
  events.forward({ kind: 'app-event', topic: 'attention', sessionId: null })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('desktop notifications for attention requests', () => {
  it('notifies about a session the owner is not looking at even while a window is focused', async () => {
    const { events, open, shown } = forwarder('session-watched')
    await events.prime()
    open.push(request('other', 'session-other'))
    await attentionEvent(events)
    expect(shown).toEqual([{ title: 'A session needs you', body: 'Allow other', sessionId: 'session-other' }])
  })

  it('names the workspace and session a request comes from', async () => {
    const shown: Array<{ title: string; body: string; sessionId: string }> = []
    const open: AttentionRecord[] = []
    const events = createAppEventForwarder({
      client: () => ({
        request: async <Result,>(method: string) =>
          (method === METHOD_REGISTRY.attentionList ? [...open] : DEFAULT_APP_SETTINGS) as Result
      }),
      targets: () => [],
      watching: () => false,
      notify: (notification) => shown.push(notification),
      notificationsEnabled: () => true,
      place: async (sessionId) => (sessionId === 'session-a' ? 'Work / API' : null)
    })
    await events.prime()
    open.push(request('named', 'session-a'), { ...request('finished', 'session-b'), kind: 'notice', title: 'Claude finished its turn' })
    await attentionEvent(events)
    expect(shown).toEqual([
      { title: 'Work / API needs you', body: 'Allow named', sessionId: 'session-a' },
      { title: 'BMN', body: 'Claude finished its turn', sessionId: 'session-b' }
    ])
  })

  it('stays quiet for the session the owner is looking at and counts its request as seen', async () => {
    const { events, open, shown, seen } = forwarder('session-watched')
    await events.prime()
    open.push(request('here', 'session-watched'), request('elsewhere', 'session-other'))
    await attentionEvent(events)
    await attentionEvent(events)
    expect(shown.map((notification) => notification.sessionId)).toEqual(['session-other'])
    expect(seen).toEqual(['here'])
  })

  it('counts a waiting request as seen once the owner turns to its session', async () => {
    const { events, open, seen, watch } = forwarder(null)
    open.push(request('waiting', 'session-a'))
    await events.prime()
    expect(seen).toEqual([])
    watch('session-a')
    events.watchChanged()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual(['waiting'])
  })

  it('notifies once per revision and never for requests already open at startup', async () => {
    const { events, open, shown } = forwarder(null)
    open.push(request('before', 'session-a'))
    await events.prime()
    await attentionEvent(events)
    open.push(request('after', 'session-a'))
    await attentionEvent(events)
    await attentionEvent(events)
    open[1] = request('after', 'session-a', 2)
    await attentionEvent(events)
    expect(shown.map((notification) => notification.body)).toEqual(['Allow after', 'Allow after'])
  })
})
