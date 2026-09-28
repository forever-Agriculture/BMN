// MODULE: companion-ipc.test.ts - desktop notifications skip the watched session and repeat only on a new revision
import { DEFAULT_APP_SETTINGS, METHOD_REGISTRY, type AttentionRecord, type TelegramStatus } from '@bmn/protocol'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))

const { activateAttentionNotification, createAppEventForwarder, noticeResolution } = await import('./companion-ipc')

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
    revision,
    openedBy: null,
    resolvedBy: null,
    prompt: null
  }
}

function forwarder(initiallyWatched: string | null): {
  events: ReturnType<typeof createAppEventForwarder>
  open: AttentionRecord[]
  shown: Array<{ title: string; body: string; sessionId: string; requestId: string; kind: string; revision: number }>
  seen: string[]
  watch(sessionId: string | null): void
} {
  const open: AttentionRecord[] = []
  const shown: Array<{ title: string; body: string; sessionId: string; requestId: string; kind: string; revision: number }> = []
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
    expect(shown).toEqual([{
      title: 'A session needs you', body: 'Allow other', sessionId: 'session-other', requestId: 'other', kind: 'permission', revision: 1
    }])
  })

  it('names the workspace and session a request comes from', async () => {
    const shown: Array<{ title: string; body: string; sessionId: string; requestId: string; kind: string; revision: number }> = []
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
      { title: 'Work / API needs you', body: 'Allow named', sessionId: 'session-a', requestId: 'named', kind: 'permission', revision: 1 },
      { title: 'BMN', body: 'Claude finished its turn', sessionId: 'session-b', requestId: 'finished', kind: 'notice', revision: 1 }
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

  it('closes every clicked desktop bubble but resolves only informational notices', async () => {
    const close = vi.fn()
    const openSession = vi.fn()
    const resolveNotice = vi.fn(async () => undefined)

    await activateAttentionNotification(
      { sessionId: 'session-a', requestId: 'permission', kind: 'permission', revision: 4 },
      { close, openSession, resolveNotice }
    )
    await activateAttentionNotification(
      { sessionId: 'session-b', requestId: 'finished', kind: 'notice', revision: 7 },
      { close, openSession, resolveNotice }
    )

    expect(close).toHaveBeenCalledTimes(2)
    expect(openSession.mock.calls).toEqual([['session-a'], ['session-b']])
    expect(resolveNotice).toHaveBeenCalledExactlyOnceWith('finished', 7)
  })

  it('records the owner as what resolved a clicked notice, and keeps the revision guard', () => {
    expect(noticeResolution('finished', 7)).toEqual({
      requestId: 'finished',
      resolution: 'Opened in BMN',
      expectedKind: 'notice',
      expectedRevision: 7,
      origin: 'owner'
    })
  })
})

describe('desktop notice when Telegram stops delivering', () => {
  function telegramForwarder(desktop = true): {
    events: ReturnType<typeof createAppEventForwarder>
    set(state: TelegramStatus['state'], enabled?: boolean): void
    shown: Array<{ title: string; body: string }>
    hold(on: boolean): void
  } {
    let status: TelegramStatus = {
      state: 'polling', detail: 'Waiting for Telegram replies', tokenMask: null, lastPollAt: null, lastError: null,
      rejectedUpdates: 0, failingSince: null, stateEntry: 1
    }
    let settings = { ...DEFAULT_APP_SETTINGS, notifications: { ...DEFAULT_APP_SETTINGS.notifications, desktop },
      telegram: { ...DEFAULT_APP_SETTINGS.telegram, enabled: true } }
    const shown: Array<{ title: string; body: string }> = []
    const held: Array<() => void> = []
    let holdSettings = false
    const events = createAppEventForwarder({
      client: () => ({
        request: async <Result,>(method: string) => {
          if (method === METHOD_REGISTRY.telegramStatus) return status as Result
          if (method === METHOD_REGISTRY.attentionList) return [] as Result
          if (holdSettings) await new Promise<void>((resolve) => held.push(resolve))
          return settings as Result
        }
      }),
      targets: () => [],
      watching: () => false,
      notify: () => undefined,
      notificationsEnabled: () => false,
      notifyApp: (notice) => shown.push(notice),
      appNotificationsEnabled: () => true
    })
    const set = (state: TelegramStatus['state'], enabled = true): void => {
      const detail = state === 'conflict' ? 'Another client is polling this bot token'
        : state === 'unauthorized' ? 'Telegram rejected the bot token' : 'Telegram is unreachable; retrying in 60s'
      status = { ...status, state, detail, failingSince: state === 'backoff' ? '2026-09-28T10:00:00.000Z' : null,
        stateEntry: status.state === state ? status.stateEntry : status.stateEntry + 1 }
      settings = { ...settings, telegram: { ...settings.telegram, enabled } }
    }
    const hold = (on: boolean): void => {
      holdSettings = on
      if (!on) for (const release of held.splice(0)) release()
    }
    return { events, set, shown, hold }
  }
  const telegramEvent = async (events: ReturnType<typeof createAppEventForwarder>): Promise<void> => {
    events.forward({ kind: 'app-event', topic: 'telegram', sessionId: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('notifies once per entry into conflict or unauthorized, and never for a retrying outage', async () => {
    const { events, set, shown } = telegramForwarder()
    set('backoff')
    await telegramEvent(events)
    await telegramEvent(events)
    set('conflict')
    await telegramEvent(events)
    await telegramEvent(events)
    set('unauthorized')
    await telegramEvent(events)
    set('polling')
    await telegramEvent(events)
    set('unauthorized')
    await telegramEvent(events)
    expect(shown).toEqual([
      { title: 'BMN', body: 'Telegram is not delivering: Another client is polling this bot token' },
      { title: 'BMN', body: 'Telegram is not delivering: Telegram rejected the bot token' },
      { title: 'BMN', body: 'Telegram is not delivering: Telegram rejected the bot token' }
    ])
  })

  it('still notifies a quick re-entry into the same state while an earlier check waits for its answer', async () => {
    const { events, set, shown, hold } = telegramForwarder()
    hold(true)
    set('conflict')
    await telegramEvent(events)
    set('starting')
    await telegramEvent(events)
    set('conflict')
    await telegramEvent(events)
    hold(false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(shown.map((notice) => notice.body)).toEqual([
      'Telegram is not delivering: Another client is polling this bot token',
      'Telegram is not delivering: Another client is polling this bot token'
    ])
  })

  it('stays quiet when desktop notifications or Telegram are off', async () => {
    const quiet = telegramForwarder(false)
    quiet.set('conflict')
    await telegramEvent(quiet.events)
    expect(quiet.shown).toEqual([])
    const off = telegramForwarder()
    off.set('conflict', false)
    await telegramEvent(off.events)
    expect(off.shown).toEqual([])
  })
})
