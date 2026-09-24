import { describe, expect, it } from 'vitest'
import type { LaunchSetStartEntryResult, SessionRecord } from '@bmn/protocol'
import { shouldAdoptLaunchSetRuntime } from './launch-set-runtime'

const entry: LaunchSetStartEntryResult = {
  entryId: 'entry-1', name: 'Command', outcome: 'started', sessionId: 'session-1',
  incarnationId: 'run-1', attachment: {
    attachmentId: 'attachment-1', streamSeq: 0, captureStartedAt: '2026-09-24T10:00:00.000Z', modes: []
  }
}
const record = {
  sessionId: 'session-1', lastProcess: {
    incarnationId: 'run-1', state: 'live', exitCode: null, signal: null, detail: null
  }
} as SessionRecord

describe('batch-created runtime adoption', () => {
  it('rejects an entry that exited before main registered its runtime', () => {
    expect(shouldAdoptLaunchSetRuntime(entry, record, 'live')).toBe(true)
    expect(shouldAdoptLaunchSetRuntime(entry, record, 'exited')).toBe(false)
    expect(shouldAdoptLaunchSetRuntime(entry, { ...record, lastProcess: {
      ...record.lastProcess!, state: 'exited', exitCode: 1
    } }, undefined)).toBe(false)
  })
})
