import { describe, expect, it } from 'vitest'
import { nativeLoadFailureMessage } from './native-load-error'

describe('nativeLoadFailureMessage', () => {
  it.each(['node-pty', 'better-sqlite3'] as const)(
    'names %s in its actionable rebuild command',
    (moduleName) => {
      const message = nativeLoadFailureMessage(
        moduleName,
        new Error('ABI mismatch\nhttps://secret:token@example.test/module'),
        '/repo'
      )

      expect(message).toContain(`native module "${moduleName}" failed to load: ABI mismatch`)
      expect(message).toContain(`"pnpm rebuild ${moduleName}" + the pinned @electron/rebuild step`)
      expect(message).toContain('in /repo')
      expect(message).toContain('No sessions were started.')
      expect(message).not.toContain('secret:token')
      expect(message).not.toContain('\n')
    }
  )
})
