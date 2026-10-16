// MODULE: self-refresh.test.ts - each reason a view reads again by itself, and the bounds on it (Story 75.7)
import { describe, expect, it, vi } from 'vitest'
import { startSelfRefresh, type SelfRefreshEnvironment } from './self-refresh'

function environment() {
  const focus = new Set<() => void>()
  const events = new Set<(message: { topic: string; sessionId: string | null }) => void>()
  const timers: Array<{ run: () => void; ms: number; stopped: boolean }> = []
  let visible = true
  const env: SelfRefreshEnvironment = {
    onFocus: (listener) => { focus.add(listener); return () => focus.delete(listener) },
    onAppEvent: (listener) => { events.add(listener); return () => events.delete(listener) },
    visible: () => visible,
    every: (run, ms) => { const timer = { run, ms, stopped: false }; timers.push(timer); return () => { timer.stopped = true } }
  }
  return {
    env, timers,
    focus: () => { for (const listener of [...focus]) listener() },
    event: (topic: string, sessionId: string | null = null) => { for (const listener of [...events]) listener({ topic, sessionId }) },
    tick: () => { for (const timer of timers) if (!timer.stopped) timer.run() },
    hide: (hidden: boolean) => { visible = !hidden },
    listeners: () => focus.size + events.size + timers.filter((timer) => !timer.stopped).length
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a view reads again by itself (Story 75.7)', () => {
  it('reads on window focus, on its own topics and its own session, and nothing else', async () => {
    const world = environment()
    const read = vi.fn(async () => undefined)
    startSelfRefresh(read, { topics: ['progress', 'artifacts'], sessionId: 'session-1' }, world.env)

    world.focus(); await settle()
    world.event('progress', 'session-1'); await settle()
    world.event('artifacts', null); await settle()
    world.event('progress', 'session-2'); await settle()
    world.event('telegram'); await settle()
    world.tick(); await settle()

    expect(read).toHaveBeenCalledTimes(3)
    expect(world.timers).toEqual([])
  })

  it('reads on its timer only while the window is visible and the view is shown', async () => {
    const world = environment()
    const read = vi.fn(async () => undefined)
    let shown = true
    startSelfRefresh(read, { everyMs: 30_000, shown: () => shown }, world.env)

    expect(world.timers.map((timer) => timer.ms)).toEqual([30_000])
    world.tick(); await settle()
    world.hide(true); world.tick(); await settle()
    world.hide(false); shown = false; world.tick(); world.focus(); await settle()
    shown = true; world.tick(); await settle()

    expect(read).toHaveBeenCalledTimes(2)
  })

  it('runs one read at a time and asks for exactly one more when reasons arrive during it', async () => {
    const world = environment()
    let finish: () => void = () => {}
    const read = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    startSelfRefresh(read, { topics: ['messages'] }, world.env)

    world.focus(); await settle()
    world.event('messages'); world.event('messages'); world.focus(); await settle()
    expect(read).toHaveBeenCalledTimes(1)
    finish(); await settle(); await settle()
    expect(read).toHaveBeenCalledTimes(2)
    finish(); await settle(); await settle()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('goes on after a read that failed, and stops every trigger when stopped', async () => {
    const world = environment()
    const read = vi.fn(async () => { throw new Error('unreadable') })
    const stop = startSelfRefresh(read, { topics: ['hooks'], everyMs: 15_000 }, world.env)

    world.focus(); await settle(); await settle()
    world.event('hooks'); await settle(); await settle()
    expect(read).toHaveBeenCalledTimes(2)
    expect(world.listeners()).toBe(3)
    stop()
    expect(world.listeners()).toBe(0)
    world.focus(); world.event('hooks'); world.tick(); await settle()
    expect(read).toHaveBeenCalledTimes(2)
  })
})
