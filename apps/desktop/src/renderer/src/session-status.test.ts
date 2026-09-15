// MODULE: session-status.test.ts - the stopped-panel label follows the recorded incarnation outcome
import { describe, expect, it } from 'vitest'
import { isSessionProcessStatus, type SessionProcessStatus } from '@ai-terminal/protocol'
import { sessionProcessLabel } from './session-status'

const status = (change: Partial<SessionProcessStatus>): SessionProcessStatus => {
  const value = { incarnationId: 'incarnation-1', state: 'exited', exitCode: 0, signal: null, detail: null, ...change } as SessionProcessStatus
  expect(isSessionProcessStatus(value)).toBe(true)
  return value
}

describe('session process label', () => {
  it('distinguishes interrupted, exited with its code, and stopped by a signal', () => {
    expect(sessionProcessLabel(status({ state: 'interrupted', exitCode: null, detail: 'AI Terminal restarted before this process exited' })))
      .toBe('Interrupted · AI Terminal restarted before this process exited')
    expect(sessionProcessLabel(status({ state: 'interrupted', exitCode: null, detail: 'application quit · signal 15' })))
      .toBe('Interrupted · application quit · signal 15')
    expect(sessionProcessLabel(status({ state: 'interrupted', exitCode: null }))).toBe('Interrupted')
    expect(sessionProcessLabel(status({ exitCode: 0 }))).toBe('Process exited · code 0')
    expect(sessionProcessLabel(status({ exitCode: 3 }))).toBe('Process exited · code 3')
    expect(sessionProcessLabel(status({ exitCode: 0, signal: 1 }))).toBe('Process stopped · signal 1')
    expect(sessionProcessLabel(status({ exitCode: 137, signal: 9 }))).toBe('Process stopped · signal 9 · code 137')
    expect(sessionProcessLabel(status({ exitCode: 2, signal: 0 }))).toBe('Process exited · code 2')
  })

  it('never labels a process from missing evidence', () => {
    expect(sessionProcessLabel(null)).toBe('Not started')
    expect(sessionProcessLabel(status({ exitCode: null }))).toBe('Process exited · exit code not recorded')
    expect(sessionProcessLabel(status({ state: 'live', exitCode: null }))).toBe('Process live')
  })
})
