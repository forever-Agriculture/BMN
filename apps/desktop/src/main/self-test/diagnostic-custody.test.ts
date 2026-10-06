import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
const jobQuery = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ queryApplicationLifetimeProcesses: jobQuery }))
import { countDiagnosticLateMembers, diagnosticLateMembers, DIAGNOSTIC_CUSTODY_ACK, waitForDiagnosticCustodyAck } from './diagnostic-custody'

afterEach(() => vi.useRealTimers())
describe('diagnostic custody barrier', () => {
  it('accepts one exact acknowledgement under fragmentation and removes listeners', async () => {
    const input = new PassThrough(), waiting = waitForDiagnosticCustodyAck(input)
    input.write(DIAGNOSTIC_CUSTODY_ACK.slice(0, 7)); input.write(DIAGNOSTIC_CUSTODY_ACK.slice(7))
    await waiting
    expect(input.listenerCount('data')).toBe(0)
    input.destroy()
  })
  it.each(['go\n', DIAGNOSTIC_CUSTODY_ACK + 'extra'])('refuses an invalid acknowledgement (%s)', async value => {
    const input = new PassThrough(), waiting = waitForDiagnosticCustodyAck(input)
    const rejected = expect(waiting).rejects.toThrow('invalid')
    input.write(value)
    await rejected
    input.destroy()
  })
  it('refuses EOF before custody acknowledgement', async () => {
    const input = new PassThrough(), waiting = waitForDiagnosticCustodyAck(input)
    const rejected = expect(waiting).rejects.toThrow('ended before custody')
    input.end()
    await rejected
    input.destroy()
  })
  it('bounds a silent controller without proceeding', async () => {
    vi.useFakeTimers()
    const input = new PassThrough(), waiting = waitForDiagnosticCustodyAck(input, 20_000)
    const rejected = expect(waiting).rejects.toThrow('deadline')
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
    expect(input.listenerCount('data')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    input.destroy()
  })

  it('records the input boundary without recording acknowledgement content', async () => {
    const input = new PassThrough(), observations: unknown[] = []
    const waiting = waitForDiagnosticCustodyAck(input, 20_000, observation => observations.push(observation))
    input.write(DIAGNOSTIC_CUSTODY_ACK)
    await waiting
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'before-resume', readableEnded: false }),
      expect.objectContaining({ event: 'data' }),
      expect.objectContaining({ event: 'acknowledged' })
    ]))
    expect(JSON.stringify(observations)).not.toContain(DIAGNOSTIC_CUSTODY_ACK.trim())
    input.destroy()
  })

  it('records observed EOF and keeps tracing failures from changing the barrier', async () => {
    const input = new PassThrough(), events: string[] = []
    const rejected = expect(waitForDiagnosticCustodyAck(input, 20_000, observation => {
      events.push(observation.event)
      throw new Error('synthetic receipt sink failure')
    })).rejects.toThrow('ended before custody')
    input.end(); await rejected
    expect(events).toContain('end')
    input.destroy()
  })
})

const member = (pid: number, creationFileTime = String(pid)) => ({ pid, creationFileTime, creationTimeMs: pid })
const snapshot = (...entries: ReturnType<typeof member>[]) => ({ listed: entries.length, identified: entries.length, entries })
describe('existing-job late members', () => {
  it('allows departed held identities and reports new members without exporting them', () => {
    expect(countDiagnosticLateMembers(snapshot(member(1), member(2)), snapshot(member(1)))).toBe(0)
    expect(countDiagnosticLateMembers(snapshot(member(1)), snapshot(member(1), member(3)))).toBe(1)
    expect(countDiagnosticLateMembers(snapshot(member(1)), snapshot(member(1, '99')))).toBe(1)
  })
  it('refuses incomplete or duplicate snapshots', () => {
    expect(countDiagnosticLateMembers(snapshot(member(1)), { ...snapshot(member(1)), identified: 0 })).toBeNull()
    expect(countDiagnosticLateMembers(snapshot(member(1)), snapshot(member(1), member(1)))).toBeNull()
  })
  it('does not lazily create a Windows job when no snapshot was armed', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try { expect(diagnosticLateMembers(undefined)).toBeNull() }
    finally { Object.defineProperty(process, 'platform', original) }
  })
})

it('reports a rejected job requery as unknown without replacing the original failure', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  jobQuery.mockImplementationOnce(() => { throw new Error('synthetic query failure') })
  try { expect(diagnosticLateMembers(snapshot(member(1)))).toBeNull() }
  finally { Object.defineProperty(process, 'platform', original) }
})
