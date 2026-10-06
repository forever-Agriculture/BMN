import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeDiagnosticFailure } from './diagnostic-observation'

afterEach(() => vi.useRealTimers())
const failure = 'the animation pane never printed SCROLLED: original snapshot'
describe('SCROLLED failure survives diagnostic observations', () => {
  it('retains the original failure alongside a successful observation', async () => {
    expect(await observeDiagnosticFailure(failure, 'host', () => ({ active: true })))
      .toEqual({ failure, observation: { active: true } })
  })
  it('retains the original failure when an observation rejects, without exposing the secondary error message', async () => {
    const answer = await observeDiagnosticFailure(failure, 'host', () => Promise.reject(new Error('private secondary message')))
    expect(answer.failure).toBe(failure)
    expect(answer.observationError).toEqual({ label: 'host', kind: 'rejected' })
    expect(JSON.stringify(answer)).not.toContain('private secondary message')
  })
  it.each([null, undefined, [], 'wrong state'])('retains the original failure when state is unavailable (%s)', async state => {
    const answer = await observeDiagnosticFailure(failure, 'host', () => state)
    expect(answer.failure).toBe(failure)
    expect(answer.observationError).toEqual({ label: 'host', kind: 'unavailable' })
  })
  it('bounds a stalled observation and clears its timer after completion', async () => {
    vi.useFakeTimers()
    const answer = observeDiagnosticFailure(failure, 'renderer', () => new Promise(() => {}), 2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    const result = await Promise.race([answer, Promise.resolve(null)])
    expect(result?.failure).toBe(failure)
    expect(result?.observationError).toEqual({ label: 'renderer', kind: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

it('treats a present but malformed host state as unavailable', async () => {
  const answer = await observeDiagnosticFailure(failure, 'host', () => ({ outputBytes: null }),
    2000, state => typeof state.outputBytes === 'number')
  expect(answer).toMatchObject({ failure, observationError: { label: 'host', kind: 'unavailable' } })
})
