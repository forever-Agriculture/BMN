// MODULE: hooks-floor.test.ts - Story 102.4: the probe runs the entry as a session outside BMN would, so whatever `bmn` that session finds first is what it judges
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guardWords, probeCommandGuard } from '../../bin/hooks-floor.mjs'

const ENTRY = 'PATH="$PATH:$HOME/.local/bin"; command -v bmn >/dev/null && bmn hook claude; exit 0'
let root = ''
const bmn = (folder: string, body: string): void => {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'bmn'), `#!/bin/sh\n${body}\n`)
  chmodSync(join(folder, 'bmn'), 0o755)
}
const HOLDS = `cat >/dev/null; printf '%s' '{"hookSpecificOutput":{"permissionDecision":"ask"}}'`
const env = (first: string | null): NodeJS.ProcessEnv => ({ HOME: root, PATH: [...(first === null ? [] : [first]), '/usr/bin', '/bin'].join(':') })
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bmn-floor-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('a guard the entry cannot reach (102.4 AC2)', () => {
  it('holds through the launcher a session outside BMN finds', () => {
    bmn(join(root, '.local/bin'), HOLDS)
    expect(probeCommandGuard('claude', ENTRY, { env: env(null) })).toEqual({ state: 'holds' })
  })

  it('says it does not answer when an earlier, stale bmn shadows the guard, with the guard installed behind it', () => {
    bmn(join(root, '.local/bin'), HOLDS)
    bmn(join(root, 'stale'), 'cat >/dev/null; exit 0')
    const standing = probeCommandGuard('claude', ENTRY, { env: env(join(root, 'stale')) })
    expect(standing).toEqual({ state: 'does-not-answer', reason: 'the entry printed nothing' })
    expect(guardWords(standing)).toBe('command guard does not answer: the entry printed nothing')
  })

  // The race seen on a busy machine: the entry ended before the event was written to it, and the probe reported "EPIPE".
  it.each([
    ['says bmn cannot be found', '', { state: 'does-not-answer', reason: 'bmn is not on the PATH of a session outside BMN' }],
    ['still reads an answer printed without reading the event', '{"hookSpecificOutput":{"permissionDecision":"ask"}}', { state: 'holds' }]
  ])('%s when the entry ended before the event reached it', (_name, stdout, expected) => {
    let calls = 0
    const spawn = ((...args: Parameters<typeof spawnSync>) => {
      calls += 1
      return calls === 1 ? { error: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), stdout, stderr: '', status: 0 } : spawnSync(...args)
    }) as typeof spawnSync
    expect(probeCommandGuard('claude', ENTRY, { env: env(null), spawn })).toEqual(expected)
  })

  it('says bmn cannot be found', () => {
    expect(probeCommandGuard('claude', ENTRY, { env: env(null) })).toEqual({ state: 'does-not-answer', reason: 'bmn is not on the PATH of a session outside BMN' })
  })
})
