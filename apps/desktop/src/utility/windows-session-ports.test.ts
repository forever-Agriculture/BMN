import { expect, it, vi } from 'vitest'
import type { ListeningPort } from '@bmn/protocol'
import { scanOwnedWindowsSessionPorts, WINDOWS_PORT_SCAN_MS, type WindowsPortSession } from './windows-session-ports'

const port: ListeningPort = { port: 5173, address: '127.0.0.1', pid: 100, command: 'node.exe' }
const owned = (query: () => Promise<readonly ListeningPort[]>): WindowsPortSession => ({
  incarnationId: 'one', exited: false, pty: { processOwnership: 'windows-job', queryListeningPorts: query }
})

it('attributes only owned jobs and applies the existing address and port preferences', async () => {
  const a = owned(async () => [port, { ...port, address: '0.0.0.0' }, { ...port, port: 22 }])
  const b = owned(async () => [{ ...port, port: 3000, pid: 200 }])
  const unrelated = { ...owned(async () => { throw Error('must not query') }), pty: {} }
  const sessions = new Map([['a', a], ['b', b], ['unowned', unrelated]])
  expect(await scanOwnedWindowsSessionPorts(new Set(sessions.keys()), id => sessions.get(id)))
    .toEqual(new Map([['a', [port]], ['b', [{ ...port, port: 3000, pid: 200 }]]]))
})

it('discards a scan when the session is replaced or stops while the native worker runs', async () => {
  let finish!: (ports: ListeningPort[]) => void
  const first = owned(() => new Promise(resolve => { finish = resolve }))
  let current = first
  const pending = scanOwnedWindowsSessionPorts(new Set(['a']), () => current)
  await Promise.resolve() // The native query has started before replacing its session.
  current = owned(async () => [port]); finish([port])
  expect(await pending).toEqual(new Map())
  const stopped = owned(async () => { stopped.exited = true; return [port] })
  expect(await scanOwnedWindowsSessionPorts(new Set(['a']), () => stopped)).toEqual(new Map())
})

it('clears unknown ownership, malformed results and closed listener lists', async () => {
  for (const query of [async () => { throw Error('denied') }, async () => [],
    async () => [{ ...port, pid: 0 }], async () => [{ ...port, address: 'invalid' }],
    async () => Array.from({ length: 513 }, () => port)]) {
    const session = owned(query)
    expect(await scanOwnedWindowsSessionPorts(new Set(['a']), () => session)).toEqual(new Map())
  }
})


it('bounds the whole scan when a native query stalls and does not enqueue later sessions', async () => {
  vi.useFakeTimers()
  try {
    const never = owned(() => new Promise(() => {}))
    const later = owned(vi.fn(async () => [port]))
    const sessions = new Map([['a', never], ['b', later]])
    const pending = scanOwnedWindowsSessionPorts(new Set(sessions.keys()), id => sessions.get(id))
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(WINDOWS_PORT_SCAN_MS)
    expect(settled).toBe(true)
    expect(await pending).toEqual(new Map())
    expect(later.pty.queryListeningPorts).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})


it('does not retry a timed-out PTY until its native request settles, leaving other jobs available', async () => {
  vi.useFakeTimers()
  try {
    const stalledQuery = vi.fn(() => new Promise<readonly ListeningPort[]>(() => {}))
    const stalled = owned(stalledQuery), later = owned(vi.fn(async () => [port]))
    const sessions = new Map([['a', stalled], ['b', later]])
    const first = scanOwnedWindowsSessionPorts(new Set(sessions.keys()), id => sessions.get(id))
    await vi.advanceTimersByTimeAsync(WINDOWS_PORT_SCAN_MS); expect(await first).toEqual(new Map())
    const second = scanOwnedWindowsSessionPorts(new Set(sessions.keys()), id => sessions.get(id))
    await vi.advanceTimersByTimeAsync(0)
    expect(stalledQuery).toHaveBeenCalledTimes(1)
    expect(await second).toEqual(new Map([['b', [port]]]))
  } finally { vi.useRealTimers() }
})

it('releases the per-PTY query latch on failure so a later current scan can recover', async () => {
  let attempts = 0
  const session = owned(async () => { if (++attempts === 1) throw Error('Denied'); return [port] })
  expect(await scanOwnedWindowsSessionPorts(new Set(['a']), () => session)).toEqual(new Map())
  expect(await scanOwnedWindowsSessionPorts(new Set(['a']), () => session)).toEqual(new Map([['a', [port]]]))
})
