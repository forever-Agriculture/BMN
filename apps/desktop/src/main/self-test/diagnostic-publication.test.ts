import { afterEach, describe, expect, it, vi } from 'vitest'
import { diagnosticObservationPublisher, diagnosticObservationRecord, type DiagnosticPublicationState } from './diagnostic-publication'
const state = (): DiagnosticPublicationState => ({ arm: 'control', anchors: { appStartedAtMs: 1, prefixStartedAtMs: 2 },
  initialScrolledWithinBudget: false, lateMembers: 0, passiveObservation: { failure: 'original SCROLLED failure',
    failureAtMs: 11000, scrollTypedAtMs: 0, controllerPokes: [], samples: [{ atMs: 11000, outputBytes: 42 }], observationErrors: [] } })
afterEach(() => vi.useRealTimers())
describe('diagnostic provisional evidence', () => {
  it.each(['throw', 'stall', 'ungraceful'])('publishes exactly once before a synthetic %s release outcome', async outcome => {
    vi.useFakeTimers(); const events: string[] = [], writes: string[] = []
    const publish = diagnosticObservationPublisher(state, (line, callback) => { writes.push(line); events.push('published'); callback() })
    await publish(); await publish()
    events.push('release')
    const release = outcome === 'throw' ? Promise.reject(new Error('synthetic release failure')) : outcome === 'stall'
      ? new Promise(resolve => setTimeout(() => resolve({ graceful: false }), 2000)) : Promise.resolve({ graceful: false })
    const finished = release.catch(() => ({ graceful: false })); await vi.advanceTimersByTimeAsync(2000)
    expect(await finished).toEqual({ graceful: false }); expect(events).toEqual(['published', 'release'])
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!)).toMatchObject({ selfTest: 'scrolled-diagnostic-observation', diagnosticOnly: true,
      passiveObservation: { failure: 'original SCROLLED failure' } })
  })
  it('never labels an unset verdict as passing in a catch-path publication', async () => {
    const value = state(); delete value.initialScrolledWithinBudget
    let line = ''
    await diagnosticObservationPublisher(() => value, (text, callback) => { line = text; callback() })()
    expect(JSON.parse(line).initialScrolledWithinBudget).toBeUndefined()
  })
  it('caps samples and failures, omits raw lines and stays under 64 KiB', () => {
    const value = state()
    value.passiveObservation = { ...value.passiveObservation, failure: 'x'.repeat(100000),
      samples: Array.from({ length: 10000 }, (_, index) => ({ atMs: index, outputBytes: index })),
      viewAtEnd: { lines: ['private fixture text', 'SCROLLED'] } }
    const record = diagnosticObservationRecord(value), text = JSON.stringify(record)
    expect(Buffer.byteLength(text)).toBeLessThan(65536); expect(text).not.toContain('private fixture text')
    expect(record.passiveObservation).toMatchObject({ failure: 'x'.repeat(500), samplesDropped: 9984,
      viewAtEnd: { lineCount: 2, scrolledVisible: true } })
  })
  it('waits for the write callback but bounds an unresponsive output pipe', async () => {
    vi.useFakeTimers()
    let settled = false
    const publish = diagnosticObservationPublisher(state, () => {}, 2000)
    const result = publish().then(value => { settled = true; return value })
    await vi.advanceTimersByTimeAsync(1999); expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1); expect(await result).toBe(false); expect(vi.getTimerCount()).toBe(0)
  })
  it('makes a write error secondary and does not attempt a duplicate publication', async () => {
    const write = vi.fn(() => { throw new Error('synthetic pipe failure') }), publish = diagnosticObservationPublisher(state, write)
    expect(await publish()).toBe(false); expect(await publish()).toBe(false); expect(write).toHaveBeenCalledOnce()
  })
})
