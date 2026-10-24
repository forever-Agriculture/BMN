import { describe, expect, it } from 'vitest'
import { searchStatusText } from './terminal-view'

describe('terminal renderer decisions', () => {
  it('uses the active result or a fallback derived from the scrollback bound', () => {
    expect(searchStatusText('Match found in retained history', 12_345)).toBe(
      'Match found in retained history'
    )
    expect(searchStatusText('', 12_345)).toBe(
      'Search covers retained history (12,345 lines)'
    )
  })
})
