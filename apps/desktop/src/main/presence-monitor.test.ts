// MODULE: presence-monitor.test.ts - away after a minute of desktop idle, back on the next input
import { describe, expect, it } from 'vitest'
import { createPresenceMonitor, parseMutterIdletime } from './presence-monitor'

function clock(): {
  schedule(callback: () => void, ms: number): () => void
  next(): Promise<number>
  pending(): number
} {
  const queue: Array<{ callback: () => void; ms: number; cancelled: boolean }> = []
  return {
    schedule: (callback, ms) => {
      const entry = { callback, ms, cancelled: false }
      queue.push(entry)
      return () => (entry.cancelled = true)
    },
    next: async () => {
      const entry = queue.shift()
      if (!entry || entry.cancelled) throw new Error('no scheduled check')
      entry.callback()
      await new Promise((resolve) => setTimeout(resolve, 0))
      return entry.ms
    },
    pending: () => queue.filter((entry) => !entry.cancelled).length
  }
}

describe('owner presence monitor', () => {
  it('marks the owner away once input has been idle for the threshold and present again on input', async () => {
    const idle = [5_000, 61_000, 64_000, 300]
    const changes: boolean[] = []
    const timers = clock()
    const monitor = createPresenceMonitor({
      readIdleMs: async () => idle.shift() ?? null,
      onChange: (presence) => changes.push(presence.away),
      schedule: timers.schedule,
      awayAfterMs: 60_000
    })
    monitor.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(monitor.current()).toEqual({ away: false })
    // Idle can only grow in real time, so nothing can change before the rest of the threshold passes.
    expect(await timers.next()).toBe(55_000)
    expect(monitor.current()).toEqual({ away: true })
    expect(await timers.next()).toBe(2_000)
    expect(await timers.next()).toBe(2_000)
    expect(monitor.current()).toEqual({ away: false })
    expect(changes).toEqual([true, false])
  })

  it('treats an unreadable idle time as present and keeps checking', async () => {
    const timers = clock()
    const changes: boolean[] = []
    const readings: Array<() => Promise<number | null>> = [
      async () => { throw new Error('bus unavailable') },
      async () => null,
      async () => 90_000
    ]
    const monitor = createPresenceMonitor({
      readIdleMs: () => readings.shift()!(),
      onChange: (presence) => changes.push(presence.away),
      schedule: timers.schedule,
      awayAfterMs: 60_000
    })
    monitor.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await timers.next()).toBe(15_000)
    expect(monitor.current()).toEqual({ away: false })
    expect(await timers.next()).toBe(15_000)
    expect(monitor.current()).toEqual({ away: true })
    expect(changes).toEqual([true])
  })

  it('stops scheduling checks once stopped', async () => {
    const timers = clock()
    const monitor = createPresenceMonitor({
      readIdleMs: async () => 0,
      onChange: () => undefined,
      schedule: timers.schedule,
      awayAfterMs: 60_000
    })
    monitor.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    monitor.stop()
    expect(timers.pending()).toBe(0)
  })

  it('reads the GNOME Mutter idle monitor reply', () => {
    expect(parseMutterIdletime('(uint64 123456,)\n')).toBe(123456)
    expect(parseMutterIdletime('Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown')).toBeNull()
  })
})
