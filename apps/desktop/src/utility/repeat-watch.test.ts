import { describe, expect, it } from 'vitest'
import { observeRepeat, type RepeatEvent, type RepeatState } from './repeat-watch'

const base: RepeatEvent = { agent: 'claude', incarnationId: 'one', event: 'PostToolUse',
  source: null, toolName: 'Bash', fingerprint: 'aaaaaaaaaaaaaaaa' }
function counter() {
  let state: RepeatState | undefined
  return (event: Partial<RepeatEvent> = {}) => {
    const result = observeRepeat(state, { ...base, ...event })
    state = result.state
    return result
  }
}
describe('repeat watch', () => {
  it('counts a sliding window rather than consecutive runs and fires once', () => {
    const next = counter()
    expect([next().repeat, next().repeat, next().repeat]).toEqual([1, 2, 3])
    const mixed = counter()
    expect(['A', 'B', 'A', 'B'].map((fingerprint) => mixed({ fingerprint }).repeat)).toEqual([1, 1, 2, 2])
    const alternating = counter()
    const results = Array.from({ length: 20 }, (_, i) => alternating({ fingerprint: i % 2 ? 'B' : 'A' }))
    expect(results.filter((result) => result.fire)).toHaveLength(1)
    expect(results[14]).toMatchObject({ fire: true, repeat: 8 })
  })
  it.each(['UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Interrupt'])('resets on %s with calibration', (event) => {
    const next = counter()
    next(); next(); next()
    expect(next({ event, fingerprint: undefined })).toMatchObject({ repeat: null,
      closed: { maxRepeat: 3, toolEvents: 3, toolName: 'Bash', notified: false } })
    expect(next().repeat).toBe(1)
  })
  it('retains compaction, Stop and unfingerprinted events; resets incarnation', () => {
    const next = counter()
    next()
    next({ event: 'Stop', fingerprint: undefined })
    next({ event: 'SessionStart', source: 'compact', fingerprint: undefined })
    expect(next().repeat).toBe(2)
    expect(next({ incarnationId: 'two' }).repeat).toBe(1)
  })
  it('evicts fingerprints beyond twenty events and emits no small segment', () => {
    const next = counter()
    next()
    for (let i = 0; i < 20; i++) next({ fingerprint: String(i) })
    expect(next().repeat).toBe(1)
    expect(next({ event: 'Interrupt', fingerprint: undefined }).closed).toBeNull()
  })
  it('does not mutate previous state and resets the fired flag', () => {
    const next = counter()
    const first = next()
    for (let i = 1; i < 8; i++) next()
    expect(first.state.fingerprints).toHaveLength(1)
    next({ event: 'Interrupt', fingerprint: undefined })
    for (let i = 1; i < 8; i++) expect(next().fire).toBe(false)
    expect(next().fire).toBe(true)
  })
})
