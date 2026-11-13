// MODULE: test-host-writes.test.ts - Epic 125: the record of BMN's own terminal writes exists in a test host only and holds no text
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { testHostWrites } from './test-host-writes'

const bytes = new TextEncoder().encode('made-up line\r')
const at = new Date('2026-11-13T12:00:00.000Z')

describe('the record of what BMN itself writes into a terminal', () => {
  it('is absent outside a test host, without a file name, or with a relative one', () => {
    expect(testHostWrites(['bmn'], { BMN_TEST_HOST_WRITES: '/tmp/x.jsonl' })).toBeUndefined()
    expect(testHostWrites(['bmn', '--bmn-test-host'], {})).toBeUndefined()
    expect(testHostWrites(['bmn', '--bmn-test-host'], { BMN_TEST_HOST_WRITES: 'x.jsonl' })).toBeUndefined()
  })
  it('keeps one row per write with its time, session, run, byte count and digest, and never the bytes', () => {
    const lines: Array<{ path: string; line: string }> = []
    const record = testHostWrites(['bmn', '--bmn-test-host'], { BMN_TEST_HOST_WRITES: '/state/host-writes.jsonl' }, { now: () => at, append: (path, line) => lines.push({ path, line }) })!
    record({ sessionId: 's1', incarnationId: 'run-1', bytes })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.path).toBe('/state/host-writes.jsonl')
    expect(lines[0]!.line.endsWith('\n')).toBe(true)
    expect(JSON.parse(lines[0]!.line)).toEqual({ at: at.toISOString(), sessionId: 's1', incarnationId: 'run-1', bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
    expect(lines[0]!.line).not.toContain('made-up')
  })
  it('never lets a failed append reach the caller', () => {
    const record = testHostWrites(['--bmn-test-host'], { BMN_TEST_HOST_WRITES: '/state/x.jsonl' }, { append: () => { throw new Error('disk full') } })!
    expect(() => record({ sessionId: 's1', incarnationId: 'run-1', bytes })).not.toThrow()
  })
})
