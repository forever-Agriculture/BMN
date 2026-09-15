import { beforeAll, describe, expect, it, vi, type Mock } from 'vitest'

const electron = vi.hoisted(() => ({
  api: undefined as unknown,
  handlers: new Map<string, (event: { ports: unknown[] }, ...args: unknown[]) => void>(),
  invoke: undefined as unknown as Mock<(...args: unknown[]) => Promise<unknown>>
}))

vi.mock('electron', async () => {
  const { vi: mocks } = await import('vitest')
  electron.invoke = mocks.fn()
  return {
    contextBridge: {
      exposeInMainWorld: (_key: string, api: unknown) => {
        electron.api = api
      }
    },
    ipcRenderer: {
      on: (channel: string, handler: (event: { ports: unknown[] }, ...args: unknown[]) => void) => {
        electron.handlers.set(channel, handler)
      },
      invoke: (...args: unknown[]) => electron.invoke(...args),
      send: mocks.fn()
    }
  }
})

interface LiveStartup {
  ok: true
  sessionId: string
  incarnationId: string
  attachmentId: string
  workspaceId: string
}

interface ApplicationStartup {
  ok: true
  liveSessions: LiveStartup[]
  sessions: Array<{ sessionId: string; name: string }>
  workspaces: unknown[]
}

interface PreloadApi {
  onStartup(listener: (startup: ApplicationStartup) => void): () => void
  resumeConversation(sessionId: string): Promise<LiveStartup>
  createSession(params: object): Promise<{ session: { sessionId: string }; startup: LiveStartup }>
}

function live(sessionId: string, incarnation: string): LiveStartup {
  return {
    ok: true,
    sessionId,
    incarnationId: `incarnation-${sessionId}-${incarnation}`,
    attachmentId: `attachment-${sessionId}-${incarnation}`,
    workspaceId: 'workspace-personal'
  }
}

function lateSubscriberSnapshot(api: PreloadApi): Promise<ApplicationStartup> {
  return new Promise((resolve) => {
    const unsubscribe = api.onStartup((startup) => {
      unsubscribe()
      resolve(startup)
    })
  })
}

describe('preload startup replay for late subscribers', () => {
  let api: PreloadApi

  beforeAll(async () => {
    await import('./index')
    api = electron.api as PreloadApi
    electron.handlers.get('aiterm:startup')!({ ports: [] }, {
      ok: true,
      workspaces: [],
      sessions: [
        { sessionId: 'session-a', name: 'A' },
        { sessionId: 'session-b', name: 'B' }
      ],
      liveSessions: [live('session-a', '1'), live('session-b', '1')]
    } satisfies ApplicationStartup)
  })

  it('replays the resumed incarnation of that session only after a resume', async () => {
    const resumed = live('session-a', '2')
    electron.invoke.mockResolvedValueOnce({ ok: true, result: resumed })

    await expect(api.resumeConversation('session-a')).resolves.toEqual(resumed)

    expect(electron.invoke).toHaveBeenLastCalledWith('aiterm:session:resume', 'session-a')
    const replayed = await lateSubscriberSnapshot(api)
    expect(replayed.liveSessions).toEqual([live('session-b', '1'), resumed])
    expect(replayed.sessions.map((session) => session.sessionId)).toEqual(['session-a', 'session-b'])
  })

  it('replays a session created after startup with its record and live attachment', async () => {
    const created = { session: { sessionId: 'session-c', name: 'C' }, startup: live('session-c', '1') }
    electron.invoke.mockResolvedValueOnce({ ok: true, result: created })

    await expect(api.createSession({ workspaceId: 'workspace-personal' })).resolves.toEqual(created)

    const replayed = await lateSubscriberSnapshot(api)
    expect(replayed.liveSessions.map((entry) => entry.attachmentId)).toEqual([
      'attachment-session-b-1',
      'attachment-session-a-2',
      'attachment-session-c-1'
    ])
    expect(replayed.sessions).toContainEqual({ sessionId: 'session-c', name: 'C' })
  })
})
