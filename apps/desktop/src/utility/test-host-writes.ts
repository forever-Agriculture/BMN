// MODULE: test-host-writes.ts - Epic 125 (125.3 AC1, 125.5 AC4): in a test host only, each line BMN itself writes into a session's terminal leaves one text-free row, so a test can prove that nothing was typed
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** One write BMN made into a session's live process by its own decision (a wake, a typed line, a pasted draft). */
export interface HostWrite {
  sessionId: string
  incarnationId: string
  bytes: Uint8Array
}

/**
 * The recorder, or undefined outside a test host. `BMN_TEST_HOST_WRITES` names the file; each row holds the time, the
 * session, its run, the byte count and the bytes' SHA-256, never the bytes. What the owner types through an attached
 * view is not a host write and is not recorded. The caller records before it writes, and a failed append throws: in a
 * test host a write that left no row is refused, so an empty interval in the record proves that nothing was written.
 */
export function testHostWrites(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  { now = () => new Date(), append = (path: string, line: string): void => appendFileSync(path, line, { mode: 0o600 }) } = {}
): ((write: HostWrite) => void) | undefined {
  const path = env.BMN_TEST_HOST_WRITES
  if (!argv.includes('--bmn-test-host') || path === undefined || !isAbsolute(path)) return undefined
  return ({ sessionId, incarnationId, bytes }) => {
    const row = { at: now().toISOString(), sessionId, incarnationId, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
    try { append(path, `${JSON.stringify(row)}\n`) } catch (error) {
      throw new Error(`The test host could not record its terminal write, so the write was not made: ${error instanceof Error ? error.message : 'unknown error'}`, { cause: error })
    }
  }
}
