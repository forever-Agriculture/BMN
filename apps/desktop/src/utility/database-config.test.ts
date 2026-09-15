import { describe, expect, it, vi } from 'vitest'
import { DATABASE_BUSY_TIMEOUT_MS, configureDatabase } from './database-config'

describe('database connection configuration', () => {
  it('enables WAL, foreign keys, and a bounded SQLite busy timeout', () => {
    const pragma = vi.fn()
    configureDatabase({ pragma })
    expect(pragma.mock.calls.map((call) => call[0])).toEqual([
      'journal_mode = WAL',
      'foreign_keys = ON',
      `busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`
    ])
    expect(DATABASE_BUSY_TIMEOUT_MS).toBe(5_000)
  })
})
