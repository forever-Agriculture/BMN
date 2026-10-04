// MODULE: port-watch.test.ts - scan cadence, hint lines and the kept result (Story 41.1)
import type { ListeningPort } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { BUSY_SCAN_MS, HINT_SCAN_DELAY_MS, HINT_SCAN_SPACING_MS, PortWatch, QUIET_SCAN_MS, RECENT_OUTPUT_MS } from './port-watch'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))
const port = (portNumber: number, pid = 7): ListeningPort => ({ port: portNumber, address: '127.0.0.1', pid, command: 'node' })

/** A watch on a hand-driven clock: `advance` fires due timers in order and lets each scan settle. */
function harness(initial: { live?: string[]; known?: string[] } = {}) {
  let now = 1_000_000
  let nextId = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const state = {
    live: initial.live ?? ['session-a'],
    known: initial.known ?? ['session-a', 'session-b'],
    scans: [] as number[],
    changes: 0,
    answer: (): Map<string, ListeningPort[]> | Error => new Map()
  }
  const watch = new PortWatch({
    scan: async () => {
      state.scans.push(now)
      const answer = state.answer()
      if (answer instanceof Error) throw answer
      return answer
    },
    knownSessionIds: () => new Set(state.known),
    liveSessionIds: () => state.live,
    changed: () => { state.changes++ },
    now: () => now,
    setTimer: (run, ms) => {
      timers.set(++nextId, { at: now + ms, run })
      return nextId
    },
    clearTimer: (timer) => { timers.delete(timer as number) }
  })
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms
    for (;;) {
      await flush()
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = Math.max(now, due[1].at)
      due[1].run()
      await flush()
    }
    now = end
    await flush()
  }
  const at = (offset: number): number => 1_000_000 + offset
  return { watch, state, advance, at, output: (sessionId: string, text: string) => watch.output(sessionId, bytes(text)) }
}

describe('scan cadence (Story 41.1)', () => {
  it('scans at once, then every 30 s while quiet, every 5 s after output, and slows again after a quiet minute', async () => {
    const { watch, state, advance, at, output } = harness()
    watch.start()
    await advance(0)
    expect(state.scans).toEqual([at(0)])
    await advance(QUIET_SCAN_MS)
    expect(state.scans).toEqual([at(0), at(QUIET_SCAN_MS)])
    // Output 1 s later brings the next scan forward to the busy interval after the last scan.
    await advance(1_000)
    output('session-a', 'compiling\n')
    await advance(BUSY_SCAN_MS)
    expect(state.scans.at(-1)).toBe(at(QUIET_SCAN_MS + BUSY_SCAN_MS))
    await advance(BUSY_SCAN_MS)
    expect(state.scans.at(-1)).toBe(at(QUIET_SCAN_MS + 2 * BUSY_SCAN_MS))
    const busyScans = state.scans.length
    // A minute without output: back to the quiet interval.
    await advance(RECENT_OUTPUT_MS + QUIET_SCAN_MS)
    const gaps = state.scans.slice(busyScans).map((scan, index, all) => scan - (index === 0 ? state.scans[busyScans - 1]! : all[index - 1]!))
    expect(gaps.at(-1)).toBe(QUIET_SCAN_MS)
    watch.stop()
  })

  it('never scans while no session is live, and starts when one is', async () => {
    const { watch, state, advance } = harness({ live: [] })
    watch.start()
    await advance(5 * QUIET_SCAN_MS)
    expect(state.scans).toEqual([])
    state.live = ['session-a']
    watch.sessionsChanged()
    await advance(0)
    expect(state.scans).toHaveLength(1)
    watch.stop()
  })
})

describe('hint lines', () => {
  it('scans 500 ms after a listening line, once per burst, through colour codes and chunk splits', async () => {
    const { watch, state, advance, output } = harness()
    watch.start()
    await advance(0)
    let before = state.scans.length
    // Vite colours the word and the port, so only the line with its escapes removed reads as a hint.
    output('session-a', '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n')
    await advance(HINT_SCAN_DELAY_MS - 1)
    expect(state.scans).toHaveLength(before)
    await advance(1)
    expect(state.scans).toHaveLength(before + 1)
    // More listening lines in the same burst add nothing.
    output('session-a', 'listening on 0.0.0.0:5173\r\n')
    output('session-a', 'Server running at http://localhost:5173/\r\n')
    await advance(HINT_SCAN_DELAY_MS)
    expect(state.scans).toHaveLength(before + 1)
    // After the spacing a hint counts again, and a line split across two chunks is still one line.
    await advance(HINT_SCAN_SPACING_MS)
    before = state.scans.length
    output('session-b', 'Serving HTTP')
    output('session-b', ' on 0.0.0.0 port 8000 ...\n')
    await advance(HINT_SCAN_DELAY_MS)
    expect(state.scans).toHaveLength(before + 1)
    watch.stop()
  })

  it('scans for hints at most once per busy interval under a steady stream of URLs', async () => {
    const { watch, state, advance, output } = harness()
    watch.start()
    await advance(0)
    const start = state.scans.length
    // A request log: a matching URL every 100 ms for ten seconds.
    for (let tick = 0; tick < 100; tick++) {
      output('session-a', `GET http://localhost:3000/api/items/${tick} 200 4ms\r\n`)
      await advance(100)
    }
    // One hint scan per 5 s, and none when the busy scan falls due at the same moment: two scans, not twenty.
    expect(state.scans.length - start).toBeLessThanOrEqual(2)
    watch.stop()
  })

  it('does not scan for a hint when the session ends within the half second', async () => {
    const { watch, state, advance, output } = harness()
    watch.start()
    await advance(0)
    const before = state.scans.length
    output('session-a', 'Serving HTTP on 127.0.0.1 port 8000 (http://127.0.0.1:8000/) ...\r\n')
    state.live = []
    watch.sessionsChanged()
    await advance(HINT_SCAN_DELAY_MS + 2 * QUIET_SCAN_MS)
    expect(state.scans).toHaveLength(before)
    watch.stop()
  })

  it('ignores ssh banners, timestamps and other addresses', async () => {
    const { watch, state, advance, output } = harness()
    watch.start()
    await advance(0)
    const before = state.scans.length
    for (const line of ['SSH-2.0-OpenSSH_9.6p1 Ubuntu\n', '[12:30:45] build finished in 3.2s\n', 'fetching https://registry.npmjs.org:443/\n',
      'Connection to github.com port 22 [tcp/ssh] succeeded!\n', 'see http://example.com:8080/docs\n']) {
      output('session-a', line)
    }
    await advance(HINT_SCAN_DELAY_MS)
    expect(state.scans).toHaveLength(before)
    watch.stop()
  })
})

describe('the kept result', () => {
  it('keeps the previous result when a scan throws, and reports a change only when one happens', async () => {
    const { watch, state, advance } = harness()
    state.answer = () => new Map([['session-a', [port(5173)]]])
    watch.start()
    await advance(0)
    expect(state.changes).toBe(1)
    state.answer = () => new Error('EIO')
    await advance(QUIET_SCAN_MS)
    expect(watch.list()).toEqual([{ sessionId: 'session-a', stopped: false, ports: [port(5173)] }])
    state.answer = () => new Map([['session-a', [port(5173)]]])
    await advance(QUIET_SCAN_MS)
    expect(state.changes).toBe(1)
    watch.stop()
  })

  it("marks a stopped session's leftover server, and drops a deleted session at once", async () => {
    const { watch, state, advance } = harness({ live: ['session-a', 'session-b'] })
    state.answer = () => new Map([['session-a', [port(5173)]], ['session-b', [port(8000, 9)]]])
    watch.start()
    await advance(0)
    expect(state.changes).toBe(1)
    // The window keeps the last list it read, so a session that stops is announced even though no port changed.
    state.live = ['session-a']
    watch.sessionsChanged()
    expect(state.changes).toBe(2)
    watch.sessionsChanged()
    expect(state.changes).toBe(2)
    expect(watch.list()).toEqual([
      { sessionId: 'session-a', stopped: false, ports: [port(5173)] },
      { sessionId: 'session-b', stopped: true, ports: [port(8000, 9)] }
    ])
    state.known = ['session-a']
    const changes = state.changes
    watch.sessionsChanged()
    expect(state.changes).toBe(changes + 1)
    expect(watch.list().map((entry) => entry.sessionId)).toEqual(['session-a'])
    watch.stop()
  })

  it('keeps the session change going when the listener throws', async () => {
    let live = ['session-a']
    const watch = new PortWatch({
      scan: async () => new Map([['session-a', [port(5173)]]]),
      knownSessionIds: () => new Set(['session-a']),
      liveSessionIds: () => live,
      changed: () => { throw new Error('window gone') }
    })
    await watch.scanNow()
    // The session stops: its leftover server is announced as such, and that announcement fails.
    live = []
    expect(() => watch.sessionsChanged()).not.toThrow()
  })

  it.each([
    { live: ['session-a'], scans: 2 },
    // The last session ended during the scan: nothing live, so nothing more scans.
    { live: [], scans: 1 }
  ])('runs one more scan after the one in flight instead of two at once (live $live)', async ({ live, scans: expected }) => {
    let release: () => void = () => undefined
    let running = 0
    let most = 0
    let scans = 0
    const watch = new PortWatch({
      scan: async () => {
        scans++
        running++
        most = Math.max(most, running)
        await new Promise<void>((resolve) => { release = resolve })
        running--
        return new Map()
      },
      knownSessionIds: () => new Set(['session-a']),
      liveSessionIds: () => live,
      changed: () => undefined
    })
    const first = watch.scanNow()
    void watch.scanNow()
    void watch.scanNow()
    release()
    await first
    await flush()
    release()
    await flush()
    expect({ scans, most }).toEqual({ scans: expected, most: 1 })
  })
})


describe('native job port incarnations', () => {
  function ownedWatch() {
    const state = { incarnation: 'one' as string | undefined, live: ['a'], answer: async () => new Map([['a', [port(5173)]]]), changes: 0 }
    const watch = new PortWatch({ scan: () => state.answer(), knownSessionIds: () => new Set(['a']),
      liveSessionIds: () => state.live, currentIncarnation: () => state.incarnation, changed: () => { state.changes++ } })
    return { state, watch }
  }
  it('removes stopped native server links immediately even when no session remains to poll', async () => {
    const { state, watch } = ownedWatch()
    await watch.scanNow(); expect(watch.list()).toHaveLength(1)
    state.incarnation = undefined; state.live = []
    expect(watch.list()).toEqual([])
    watch.sessionsChanged(); expect(watch.list()).toEqual([]); expect(state.changes).toBe(2)
  })
  it('refuses an old incarnation and accepts a newly verified identical PID/port result', async () => {
    const { state, watch } = ownedWatch()
    await watch.scanNow(); state.incarnation = 'two'
    expect(watch.list()).toEqual([])
    await watch.scanNow()
    expect(watch.list()).toEqual([{ sessionId: 'a', stopped: false, ports: [port(5173)] }])
    expect(state.changes).toBe(2)
  })
  it('discards a result when the incarnation changes before the complete scan returns', async () => {
    const { state, watch } = ownedWatch()
    let finish!: (rows: Map<string, ListeningPort[]>) => void
    state.answer = () => new Promise(resolve => { finish = resolve })
    const pending = watch.scanNow(); state.incarnation = 'two'; finish(new Map([['a', [port(5173)]]]))
    await pending; expect(watch.list()).toEqual([])
  })
  it('clears native links on unknown scan ownership instead of retaining a previous reading', async () => {
    const { state, watch } = ownedWatch()
    await watch.scanNow()
    state.answer = async () => { throw Error('Unavailable') }
    await watch.scanNow(); expect(watch.list()).toEqual([])
  })
})
