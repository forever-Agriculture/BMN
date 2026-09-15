import { describe, expect, it } from 'vitest'
import type { SavedOutputPresentation } from './terminal-history'
import {
  savedOutputContent,
  searchStatusText,
  terminalSurfaceClass
} from './terminal-view'

const presentation: SavedOutputPresentation = {
  key: 'session-1\u0000incarnation-1\u0000view-1',
  capturedAt: '2026-09-12T08:00:00.000Z',
  sessionId: 'session-1',
  incarnationId: 'incarnation-1',
  viewEpoch: 'view-1',
  content: 'saved output',
  disclosure: 'captured metadata',
  processLabel: 'Process exited · saved output is not live',
  sessionLabel: 'Session: session-1 · incarnation: incarnation-1'
}

describe('terminal renderer decisions', () => {
  it('uses the active result or a fallback derived from the scrollback bound', () => {
    expect(searchStatusText('Match found in retained history', 12_345)).toBe(
      'Match found in retained history'
    )
    expect(searchStatusText('', 12_345)).toBe(
      'Search covers retained history (12,345 lines)'
    )
  })

  it('hides the live surface exactly while saved output is open', () => {
    expect(terminalSurfaceClass(false)).toBe('terminal-surface')
    expect(terminalSurfaceClass(true)).toBe('terminal-surface terminal-surface-hidden')
  })

  it('separates populated saved output from the never-captured state', () => {
    expect(savedOutputContent(presentation)).toEqual({ kind: 'captured', presentation })
    expect(savedOutputContent(undefined)).toEqual({
      kind: 'never-captured',
      message: 'No saved output has been captured for this session.'
    })
    expect(savedOutputContent(undefined, true)).toEqual({
      kind: 'never-captured',
      message: 'Select a prior saved-output capture.'
    })
  })
})
