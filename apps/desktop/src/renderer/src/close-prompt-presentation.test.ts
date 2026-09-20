import { describe, expect, it } from 'vitest'
import {
  closePromptDetail,
  closePromptHeading,
  closePromptRows,
  closePromptSummary
} from './close-prompt-presentation'

const LIVE = { sessionId: 'session-1', name: 'Same CLI chat B', agent: 'claude', processState: 'live' as const }

describe('close prompt presentation', () => {
  it('counts the running sessions in the owner’s terms', () => {
    expect(closePromptHeading('close')).toBe('Close BMN?')
    expect(closePromptHeading('quit')).toBe('Quit BMN?')
    expect(closePromptSummary('close', 1)).toBe('1 session is still running. Keep them running, or stop them.')
    expect(closePromptSummary('close', 3)).toBe('3 sessions are still running. Keep them running, or stop them.')
    expect(closePromptSummary('quit', 1)).toBe('1 session is still running. Quitting stops it.')
    expect(closePromptSummary('quit', 2)).toBe('2 sessions are still running. Quitting stops them all.')
  })

  it('says which agent it is and what it is doing', () => {
    expect(closePromptDetail(LIVE, 'Working')).toBe('claude · working')
    expect(closePromptDetail(LIVE, 'Action required')).toBe('claude · action required')
    expect(closePromptDetail(LIVE, undefined)).toBe('claude')
  })

  it('states an unconfirmed exit as a fact, without borrowing the activity word', () => {
    expect(closePromptDetail({ ...LIVE, processState: 'exit-unconfirmed' }, 'Working'))
      .toBe('claude · exit unconfirmed')
  })

  it('starts every row on keep running and preserves the order it was given', () => {
    const second = { sessionId: 'session-2', name: 'Scratch', agent: 'bash', processState: 'live' as const }
    const rows = closePromptRows([LIVE, second], (sessionId) =>
      sessionId === 'session-1'
        ? { workspace: 'Personal', activity: 'Working' }
        : { workspace: 'BMN', activity: undefined }
    )

    expect(rows.map((row) => row.sessionId)).toEqual(['session-1', 'session-2'])
    expect(rows.every((row) => row.choice === 'hide')).toBe(true)
    expect(rows[0]).toMatchObject({ name: 'Same CLI chat B', workspace: 'Personal', detail: 'claude · working' })
    expect(rows[1]).toMatchObject({ workspace: 'BMN', detail: 'bash' })
  })
})
