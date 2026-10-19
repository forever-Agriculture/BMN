// MODULE: self-refresh.ts - a view reads again by itself instead of offering a Refresh button (Story 75.7)
import { useEffect, useRef } from 'react'

/** How often a view shown on screen reads again what changes without BMN saying so, such as dev-auto's files or Telegram's polling. */
export const SELF_REFRESH_MS = 30_000

interface SelfRefreshOptions {
  /** BMN's change topics that make this view read again; an event about another session is ignored when `sessionId` is set. */
  topics?: readonly string[]
  sessionId?: string | null
  /** Read again this often while the view is shown and the window visible; null or absent for never on a timer. */
  everyMs?: number | null
  /** Whether the view is on screen; a view kept mounted but hidden reads nothing. Defaults to always. */
  shown?: () => boolean
}

export interface SelfRefreshEnvironment {
  onFocus(listener: () => void): () => void
  onAppEvent(listener: (message: { topic: string; sessionId: string | null }) => void): () => void
  /** Whether the window can be seen at all: a minimised or hidden window reads nothing on a timer. */
  visible(): boolean
  every(run: () => void, ms: number): () => void
}

/**
 * Reads again when the window gets the focus, when BMN says something this view shows changed, and on a timer while
 * shown, so the owner never presses Refresh. One read at a time: a reason that arrives during a read asks for exactly
 * one more read after it, however many arrive. Returns how to stop.
 */
export function startSelfRefresh(read: () => unknown, options: SelfRefreshOptions, environment: SelfRefreshEnvironment): () => void {
  let running = false
  let again = false
  let stopped = false
  const shown = options.shown ?? (() => true)
  const run = (): void => {
    if (stopped || !shown()) return
    if (running) {
      again = true
      return
    }
    running = true
    again = false
    void Promise.resolve().then(read).catch(() => undefined).finally(() => {
      running = false
      if (again && !stopped) run()
    })
  }
  const stops = [
    environment.onFocus(run),
    ...(options.topics && options.topics.length > 0 ? [environment.onAppEvent((message) => {
      if (!options.topics!.includes(message.topic)) return
      if (options.sessionId != null && message.sessionId !== null && message.sessionId !== options.sessionId) return
      run()
    })] : []),
    ...(options.everyMs != null && options.everyMs > 0 ? [environment.every(() => { if (environment.visible()) run() }, options.everyMs)] : [])
  ]
  return () => {
    stopped = true
    for (const stop of stops) stop()
  }
}

function browserEnvironment(): SelfRefreshEnvironment {
  return {
    onFocus: (listener) => {
      window.addEventListener('focus', listener)
      return () => window.removeEventListener('focus', listener)
    },
    onAppEvent: (listener) => window.aiTerminal.onAppEvent(listener),
    visible: () => document.visibilityState === 'visible',
    every: (run, ms) => {
      const timer = setInterval(run, ms)
      return () => clearInterval(timer)
    }
  }
}

/** The React form: the latest `read` is called, and the triggers are set up again only when the options change. */
export function useSelfRefresh(read: () => unknown, options: SelfRefreshOptions & { paused?: boolean } = {}): void {
  const latest = useRef(read)
  latest.current = read
  const shown = useRef(options.shown)
  shown.current = options.shown
  const topics = options.topics?.join(',') ?? ''
  useEffect(() => {
    if (options.paused) return
    return startSelfRefresh(() => latest.current(), {
      topics: topics === '' ? [] : topics.split(','),
      sessionId: options.sessionId ?? null,
      everyMs: options.everyMs ?? null,
      shown: () => shown.current?.() ?? true
    }, browserEnvironment())
  }, [topics, options.sessionId, options.everyMs, options.paused])
}
