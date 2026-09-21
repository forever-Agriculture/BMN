// MODULE: resume-interrupted-presentation.test.ts - what the resume-after-stop offer says and checks
import type { InterruptedSessionCohort, InterruptedSessionEntry } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import {
  applyResumeOutcomes,
  interruptedStopWords,
  resumeInterruptedButtonLabel,
  resumeInterruptedHeading,
  resumeInterruptedRows,
  resumeInterruptedSummary,
  resumeRowOutcomeWords,
  startableRows
} from './resume-interrupted-presentation'

function entry(overrides: Partial<InterruptedSessionEntry> & { sessionId: string }): InterruptedSessionEntry {
  return {
    incarnationId: `i-${overrides.sessionId}`,
    workspaceId: 'workspace-1',
    workspaceName: 'BMN',
    name: `Session ${overrides.sessionId}`,
    action: 'resume',
    command: '/usr/bin/codex resume 01999f0a',
    notCarried: '',
    detail: 'update restart · exit code 0',
    interruptedAt: '2026-09-21T10:00:00.000Z',
    relaunchReason: null,
    ...overrides
  }
}

function cohort(entries: InterruptedSessionEntry[], cause: 'update-restart' | 'application-quit' = 'update-restart'): InterruptedSessionCohort {
  return {
    cohortId: 'cohort-1',
    cause,
    stoppedAt: '2026-09-21T10:00:00.000Z',
    offeredAt: null,
    entries
  }
}

describe('the words the offer uses', () => {
  it('names the stop the owner caused, in each of its two forms', () => {
    expect(interruptedStopWords('update-restart')).toBe('a desktop update')
    expect(interruptedStopWords('application-quit')).toBe('quitting BMN')
    expect(resumeInterruptedHeading('update-restart')).toBe('Resume what the update stopped?')
    expect(resumeInterruptedHeading('application-quit')).toBe('Resume what the quit stopped?')
  })

  it('says what stopped them and that nothing has started since', () => {
    expect(resumeInterruptedSummary(cohort([entry({ sessionId: 'a' })])))
      .toBe('a desktop update stopped 1 session. Nothing has started since.')
    expect(resumeInterruptedSummary(cohort([entry({ sessionId: 'a' }), entry({ sessionId: 'b' })], 'application-quit')))
      .toBe('quitting BMN stopped 2 sessions. Nothing has started since.')
  })
})

describe('the rows the offer draws', () => {
  it('checks a Resume row and leaves a Start again row for the owner to decide', () => {
    const rows = resumeInterruptedRows(cohort([
      entry({ sessionId: 'bound' }),
      entry({
        sessionId: 'unbound',
        action: 'relaunch',
        command: '/bin/bash',
        relaunchReason: 'No conversation binding was captured for this session'
      })
    ]))
    expect(rows.map((row) => [row.action, row.checked])).toEqual([['resume', true], ['relaunch', false]])
    expect(rows[1]?.relaunchReason).toBe('No conversation binding was captured for this session')
    expect(rows.every((row) => row.outcome.kind === 'pending')).toBe(true)
  })

  it('carries the command and the arguments resume will not take, unchanged', () => {
    const rows = resumeInterruptedRows(cohort([
      entry({ sessionId: 'a', command: 'claude --resume 0199 --model opus', notCarried: 'a prompt argument' })
    ]))
    expect(rows[0]?.command).toBe('claude --resume 0199 --model opus')
    expect(rows[0]?.notCarried).toBe('a prompt argument')
  })

  it('counts only what the button would actually start', () => {
    const rows = resumeInterruptedRows(cohort([
      entry({ sessionId: 'a' }),
      entry({ sessionId: 'b' }),
      entry({ sessionId: 'c', action: 'relaunch' })
    ]))
    expect(resumeInterruptedButtonLabel(rows)).toBe('Resume 2 sessions')
    expect(resumeInterruptedButtonLabel([rows[0]!])).toBe('Resume 1 session')
    expect(resumeInterruptedButtonLabel(rows.map((row) => ({ ...row, checked: false })))).toBe('Resume 0 sessions')
  })
})

describe('what each row reads after the action', () => {
  const rows = resumeInterruptedRows(cohort([
    entry({ sessionId: 'a' }),
    entry({ sessionId: 'b' }),
    entry({ sessionId: 'c' })
  ]))

  it('states the failure in the host’s own words and leaves the rest not started', () => {
    const applied = applyResumeOutcomes(rows, [
      { sessionId: 'a', outcome: 'started' },
      { sessionId: 'b', outcome: 'failed', error: 'The session is already running' },
      { sessionId: 'c', outcome: 'not-started' }
    ])
    expect(applied.map((row) => resumeRowOutcomeWords(row.outcome))).toEqual([
      'Started',
      'Failed · The session is already running',
      'Not started'
    ])
    // A started row is running: the button must never count it again.
    expect(applied[0]?.checked).toBe(false)
    expect(resumeInterruptedButtonLabel(applied)).toBe('Resume 1 session')
  })

  it('keeps a row the action did not mention exactly as it was', () => {
    const applied = applyResumeOutcomes(rows, [{ sessionId: 'a', outcome: 'started' }])
    expect(applied[1]).toEqual(rows[1])
    expect(applied[2]).toEqual(rows[2])
  })

  it('says nothing for a row that has not been acted on', () => {
    expect(resumeRowOutcomeWords({ kind: 'pending' })).toBe('')
  })

  /** A second press is for what the first never reached; it never restarts or retries anything. */
  it('offers a second press only the rows that were not started', () => {
    const applied = applyResumeOutcomes(rows, [
      { sessionId: 'a', outcome: 'started' },
      { sessionId: 'b', outcome: 'failed', error: 'no pseudo-terminal was available' },
      { sessionId: 'c', outcome: 'not-started' }
    ])
    expect(startableRows(applied).map((row) => row.sessionId)).toEqual(['c'])
  })
})
