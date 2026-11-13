// MODULE: update-restart-dialog.test.ts - Epic 125 (125.4 AC1, AC2, AC5, AC7; 125.5 AC2): the restart dialog's words in each state, never a guessed one
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { updateRestartWords, type UpdateRestartMember, type UpdateRestartRecord, type UpdateRestartSnapshot } from '@bmn/protocol'
import { UpdateRestartDialog, updateRestartTitle } from './update-restart-dialog'

const member = (name: string, over: Partial<UpdateRestartMember> = {}): UpdateRestartMember => ({
  sessionId: name, incarnationId: `${name}-run`, name, workspace: 'BMN', agent: 'claude', conversation: `conversation-${name}`, atPress: 'working', ready: false,
  notice: 'queued', claim: `claim-${name}`, printedAt: null, atClose: null, stop: 'pending', capture: 'pending', resume: 'pending', resumedIncarnation: null,
  tell: 'unnecessary', tellUntil: null, reason: null, ...over
})
const closesAt = new Date(2026, 10, 13, 14, 37, 20).getTime()
const record = (phase: UpdateRestartRecord['phase'], members: UpdateRestartMember[], over: Partial<UpdateRestartRecord> = {}): UpdateRestartRecord =>
  ({ version: 2, revision: 1, id: 'run', build: '02c0120aaaa', startedAt: '2026-11-13T12:32:00.000Z', closesAt, phase, openedBuild: null, members, ...over })
const draw = (snapshot: Partial<UpdateRestartSnapshot>): string => renderToStaticMarkup(createElement(UpdateRestartDialog, {
  snapshot: { run: null, waitingBuild: '02c0120aaaa', sessions: [], show: true, reportedCohort: null, ...snapshot },
  action: async () => undefined, close: () => undefined, resumeReported: async () => ({ cohortId: 'c', entries: [] })
}))

describe('before the press (125.4 AC1)', () => {
  it('names the waiting build and each running session with what BMN knows of it', () => {
    const html = draw({ sessions: [member('Epic 114'), member('Epic 118', { agent: 'codex', atPress: 'unknown' }), member('Pet-128', { atPress: 'ended', workspace: 'b2buster' })] })
    expect(html).toContain('Restart for the update?')
    expect(html).toContain('Update 02c0120 is waiting. 3 sessions are running.')
    expect(html).toContain('claude · working'); expect(html).toContain('codex · state not known'); expect(html).toContain('claude · idle')
    expect(updateRestartWords(member('a', { agent: 'other', atPress: 'working' }), 'offer')).toBe('shell · working')
    expect(html).toContain('>Cancel</button>'); expect(html).toContain('>Restart</button>')
  })
  it.each(['cancelled', 'complete'] as const)('offers the next update after a dismissed %s result', phase => {
    const html = draw({ run: record(phase, [], { dismissed: true, openedBuild: '1111111' }), waitingBuild: '2222222', show: false })
    expect(html).toContain('Restart for the update?'); expect(html).toContain('Update 2222222 is waiting.')
  })
})

describe('waiting to close (125.4 AC2, AC3, AC4, AC7)', () => {
  it('shows the closing time as a clock time, never a countdown', () => {
    const run = record('waiting', [member('Epic 114')])
    expect(updateRestartTitle(run, 'waiting')).toBe('Restarting · closes by 14:37')
    const html = draw({ run })
    expect(html).not.toMatch(/\d+ ?(?:s|sec|seconds|min|minutes) (?:left|remaining)|in \d+ (?:s|seconds|minutes)/iu)
    expect(html).toContain('>Cancel</button>'); expect(html).toContain('>Restart now</button>')
  })
  it('each word follows one observed event', () => {
    expect(updateRestartWords(member('a', { atPress: 'ended', ready: true, notice: 'none' }), 'waiting')).toBe('Ready')
    expect(updateRestartWords(member('a', { notice: 'queued' }), 'waiting')).toBe('Not told yet')
    expect(updateRestartWords(member('a', { notice: 'handed' }), 'waiting')).toBe('Not told yet')
    expect(updateRestartWords(member('a', { notice: 'printed' }), 'waiting')).toBe('Reaching a safe point')
    expect(updateRestartWords(member('a', { notice: 'printed', ready: true }), 'waiting')).toBe('Ready')
  })
  it('never shows a state BMN does not know as Ready or as Reaching a safe point', () => {
    for (const agent of ['claude', 'codex', 'opencode', 'bash']) {
      for (const notice of ['none', 'queued', 'handed', 'withdrawn'] as const) {
        const words = updateRestartWords(member('a', { agent, atPress: 'unknown', notice }), 'waiting')
        expect(words).toBe('Not told yet')
      }
    }
    const html = draw({ run: record('waiting', [member('Epic 118', { agent: 'codex', atPress: 'unknown' })]) })
    expect(html).toContain('Not told yet'); expect(html).not.toContain('Ready'); expect(html).not.toContain('Reaching a safe point')
  })
})

describe('the Cancel result (125.4 AC5, D4)', () => {
  it('lists only the sessions BMN could not tell, under the two rows', () => {
    const run = record('cancelled', [
      member('Epic 114', { notice: 'printed', tell: 'told' }),
      member('Epic 118', { agent: 'codex', notice: 'printed', ready: true, tell: 'not-told' }),
      member('Pet-128', { agent: 'codex', notice: 'handed', tell: 'not-told' }),
      member('Quiet', { atPress: 'ended', ready: true, notice: 'none' }),
      member('Working', { notice: 'printed', tell: 'pending' })
    ])
    expect(updateRestartTitle(run, 'cancelled')).toBe('Cancelled · 2 not told to carry on')
    const html = draw({ run })
    expect(html).toContain('Stopped for the restart · type continue'); expect(html).toContain('Not told to carry on')
    expect(html).toContain('Epic 118'); expect(html).toContain('Pet-128')
    for (const hidden of ['Epic 114', 'Quiet', 'Working']) expect(html).not.toContain(hidden)
    expect(html).toContain('>Close</button>'); expect(html).not.toContain('Restart now')
  })
  it('says a stop was observed only where the turn ended after the printed notice', () => {
    expect(updateRestartWords(member('a', { notice: 'printed', ready: true, tell: 'not-told' }), 'cancelled')).toBe('Stopped for the restart · type continue')
    expect(updateRestartWords(member('a', { notice: 'printed', carryFinishedAt: 1, tell: 'not-told' }), 'cancelled')).toBe('Stopped for the restart · type continue')
    expect(updateRestartWords(member('a', { notice: 'printed', tell: 'not-told' }), 'cancelled')).toBe('Not told to carry on')
    expect(updateRestartWords(member('a', { notice: 'handed', tell: 'not-told' }), 'cancelled')).toBe('Not told to carry on')
  })
})

describe('after reopening (125.5 AC2 to AC6, D7)', () => {
  const resumed = (over: Partial<UpdateRestartMember>): UpdateRestartMember => member('a', { resume: 'resumed', resumedIncarnation: 'new', stop: 'confirmed', ...over })
  it('gives every row its result in the design\'s words', () => {
    expect(updateRestartWords(resumed({ atClose: 'ready', tell: 'told' }), 'after')).toBe('Resumed · told to continue')
    expect(updateRestartWords(resumed({ atClose: 'not-ready', tell: 'told' }), 'after')).toBe('Resumed · told to check its work')
    expect(updateRestartWords(resumed({ atClose: 'ready', tell: 'not-told' }), 'after')).toBe('Resumed · not told, type continue')
    expect(updateRestartWords(resumed({ atPress: 'ended', atClose: 'ready', tell: 'unnecessary' }), 'after')).toBe('Resumed')
    expect(updateRestartWords(member('a', { resume: 'failed', reason: 'tick to run its command' }), 'after')).toBe('Not resumed · tick to run its command')
    expect(updateRestartWords(member('a', { resume: 'failed', reason: 'the conversation binding changed or is unavailable' }), 'after')).toContain('Not resumed · the conversation binding changed')
  })
  it('a Codex row follows one order and is never called told', () => {
    const codex = (over: Partial<UpdateRestartMember>): string => updateRestartWords(resumed({ agent: 'codex', ...over }), 'after')
    expect(codex({ atPress: 'ended', atClose: 'ready', tell: 'unnecessary' })).toBe('Resumed')
    expect(codex({ atClose: 'not-ready', tell: 'not-told' })).toBe('Resumed · not told, not ready at close')
    expect(codex({ atClose: 'ready', notice: 'printed', ready: true, tell: 'not-told' })).toBe('Resumed · not told, type continue')
    for (const atClose of ['ready', 'not-ready'] as const) expect(codex({ atClose, tell: 'not-told' })).not.toContain('told to')
  })
  it('keeps every row within 40 characters', () => {
    const rows = [
      updateRestartWords(member('a', { notice: 'printed' }), 'waiting'), updateRestartWords(member('a'), 'waiting'),
      updateRestartWords(member('a', { notice: 'printed', ready: true, tell: 'not-told' }), 'cancelled'), updateRestartWords(member('a', { tell: 'not-told' }), 'cancelled'),
      updateRestartWords(resumed({ agent: 'codex', atClose: 'not-ready', tell: 'not-told' }), 'after'), updateRestartWords(resumed({ atClose: 'not-ready', tell: 'told' }), 'after'),
      updateRestartWords(resumed({ atClose: 'ready', tell: 'not-told' }), 'after'), updateRestartWords(member('a', { resume: 'failed', reason: 'tick to run its command' }), 'after'),
      updateRestartTitle(record('cancelled', [member('a', { tell: 'not-told' }), member('b', { tell: 'not-told' })]), 'cancelled'), updateRestartTitle(record('waiting', []), 'waiting')
    ]
    for (const row of rows) expect(row.length, row).toBeLessThanOrEqual(40)
  })
  it('heads the dialog with the build that opened, or with the failed update', () => {
    expect(updateRestartTitle(record('complete', [], { openedBuild: '02c0120aaaa' }), 'after')).toBe('Restarted on 02c0120')
    expect(updateRestartTitle(record('complete', [], { openedBuild: 'Update failed · previous build opened' }), 'after')).toBe('Update failed · previous build opened')
    const html = draw({ run: record('complete', [resumed({ atClose: 'ready', tell: 'told' })], { openedBuild: '02c0120aaaa' }) })
    expect(html).toContain('Restarted on 02c0120'); expect(html).toContain('Resumed · told to continue'); expect(html).toContain('>Close</button>')
  })
})
