// MODULE: session-presentation.test.ts - status, tags, progress staleness and needs-you navigation
import { usageClock, usageWindowName, type AttentionRecord, type HookOriginRecord, type InputDraftRecord, type ProgressRecord, type SessionRecord, type UsageReading } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NeedsYouPopover } from './needs-you-popover'
import { PlanWindows } from './plan-use-view'
import {
  activeHookOrigin,
  agentTag,
  handoffDraftForAttention,
  handoffPreparedBy,
  attentionActionWhenOpened,
  displayPath,
  inferHome,
  modelOriginFlag,
  modelOriginLabel,
  observedAgentName,
  openAttentionGroups,
  neighbor,
  splitCandidates,
  nextRequest,
  agedProgress,
  progressPresentation,
  relativeAge,
  compactionWords,
  contextUseWords,
  planSourceWords,
  planUseMissingWords,
  planUseWords,
  requestsAnsweredByTyping,
  sessionAttention,
  sessionProcessLive,
  sessionStatus,
  windowTitle,
  workspaceAttention,
  attentionProvenance,
  compareAttention,
  expiryText,
  openRequests,
  preferencesGearCue
} from './session-presentation'

const now = Date.parse('2026-09-14T12:00:00.000Z')

const request = (requestId: string, sessionId: string, openedAt: string, state: AttentionRecord['state'] = 'open'): AttentionRecord => ({
  requestId,
  sessionId,
  incarnationId: null,
  requestKey: requestId,
  kind: 'question',
  title: requestId,
  body: null,
  state,
  resolution: null,
  openedAt,
  expiresAt: null,
  resolvedAt: null,
  seenAt: null,
  revision: 1,
  openedBy: null,
  resolvedBy: null,
  prompt: null
})

describe('workspace attention', () => {
  const sessions = [
    { sessionId: 's1', workspaceId: 'w1', lastProcess: null, archivedAt: null },
    { sessionId: 's2', workspaceId: 'w1', lastProcess: null, archivedAt: '2026-09-14T11:00:00.000Z' },
    { sessionId: 's3', workspaceId: 'w2', lastProcess: null, archivedAt: null }
  ]
  const question = (id: string) => request(`question-${id}`, id, '2026-09-14T11:00:00.000Z')
  const notice = (id: string): AttentionRecord => ({ ...question(id), requestId: `notice-${id}`, kind: 'notice' })

  it('returns zero counts for an empty workspace', () => {
    expect(workspaceAttention([], 'w1', [question('s1')], {})).toEqual({ waiting: 0, updates: 0, live: 0 })
  })

  it('counts a waiting session once even with multiple questions and an update', () => {
    expect(workspaceAttention(sessions, 'w1', [question('s1'), question('s1'), notice('s1')], {}))
      .toEqual({ waiting: 1, updates: 0, live: 0 })
  })

  it('counts a session with only an update', () => {
    expect(workspaceAttention(sessions, 'w1', [notice('s1')], {})).toEqual({ waiting: 0, updates: 1, live: 0 })
  })

  it('separates waiting sessions from sessions with updates', () => {
    expect(workspaceAttention(sessions, 'w1', [question('s1'), notice('s2')], {}))
      .toEqual({ waiting: 1, updates: 1, live: 0 })
  })

  it('includes an archived session hidden from the normal tree', () => {
    expect(workspaceAttention(sessions, 'w1', [question('s2')], {})).toEqual({ waiting: 1, updates: 0, live: 0 })
  })

  it('excludes attention and live sessions in another workspace and closed requests', () => {
    expect(workspaceAttention(sessions, 'w1', [notice('s3'), { ...question('s1'), state: 'answered' }], {
      s3: { incarnationId: 'i3' }
    })).toEqual({ waiting: 0, updates: 0, live: 0 })
  })

  it('counts live processes, excluding retained panes whose incarnation ended', () => {
    const ended = {
      incarnationId: 'old', state: 'exited' as const, exitCode: 0, signal: null, detail: null
    }
    const records = sessions.map((session) => ({ ...session, lastProcess: ended }))
    expect(workspaceAttention(records, 'w1', [], {
      s1: { incarnationId: 'old' }, s2: { incarnationId: 'new' }, s3: { incarnationId: 'new' }
    })).toEqual({ waiting: 0, updates: 0, live: 1 })
  })
})

describe('a view that outlives its process', () => {
  const session = (lastProcess: { incarnationId: string; state: 'live' | 'exited' | 'interrupted' } | null) => ({
    sessionId: 'session-1',
    lastProcess: lastProcess
      ? { ...lastProcess, exitCode: lastProcess.state === 'exited' ? 23 : null, signal: null, detail: null }
      : null
  })

  it('stops calling a session live once its attached incarnation has ended', () => {
    // The pane stays mounted so its output can still be read; the row must not read Running.
    expect(sessionProcessLive(session({ incarnationId: 'incarnation-1', state: 'exited' }), 'incarnation-1')).toBe(false)
    expect(sessionProcessLive(session({ incarnationId: 'incarnation-1', state: 'interrupted' }), 'incarnation-1')).toBe(false)
    expect(sessionStatus(session({ incarnationId: 'incarnation-1', state: 'exited' }), false, [])).toEqual({
      dot: 'exited',
      word: 'Process exited'
    })
  })

  it('keeps a running session live, including one whose record still describes an older incarnation', () => {
    expect(sessionProcessLive(session({ incarnationId: 'incarnation-1', state: 'live' }), 'incarnation-1')).toBe(true)
    expect(sessionProcessLive(session({ incarnationId: 'incarnation-0', state: 'exited' }), 'incarnation-1')).toBe(true)
    expect(sessionProcessLive(session(null), 'incarnation-1')).toBe(true)
  })

  it('is not live when no view is attached at all', () => {
    expect(sessionProcessLive(session(null), undefined)).toBe(false)
    expect(sessionProcessLive(session({ incarnationId: 'incarnation-1', state: 'live' }), undefined)).toBe(false)
  })
})

describe('session presentation', () => {
  it('ranks actionable requests above updates, observed failures, and process state', () => {
    const session = { sessionId: 's1', lastProcess: null }
    expect(sessionStatus(session, true, [request('r1', 's1', '2026-09-14T11:00:00.000Z')])).toEqual({
      dot: 'needs-you',
      word: 'Waiting for your response'
    })
    const update = { ...request('turn', 's1', '2026-09-14T11:00:00.000Z'), kind: 'notice' as const }
    expect(sessionStatus(session, true, [update])).toEqual({ dot: 'needs-you', word: 'Update available' })
    const failed = {
      label: 'Build', state: 'failed' as const, word: 'Failed', source: 'agent', age: '2 min ago', stale: false,
      detail: null, evidence: [], evidenceWord: 'No evidence attached',
      observedAt: '2026-09-14T11:58:00.000Z', receivedAt: '2026-09-14T11:58:00.000Z'
    }
    expect(sessionStatus(session, true, [update], failed)).toEqual({
      dot: 'exited', word: 'Failed · agent, 2 min ago'
    })
    expect(sessionStatus(session, true, [request('r1', 's1', '2026-09-14T11:00:00.000Z'), update], failed).word)
      .toBe('Waiting for your response')
    expect(sessionStatus(session, true, [request('r1', 's1', '2026-09-14T11:00:00.000Z', 'answered')]).dot).toBe('running')
    expect(sessionStatus(session, false, []).dot).toBe('idle')
    expect(sessionStatus({
      sessionId: 's1',
      lastProcess: { incarnationId: 'i', state: 'exited', exitCode: 0, signal: null, detail: null }
    }, false, []).word).toBe('Process exited')
  })

  it('shows observed activity only inside the live branch, under every existing rank', () => {
    const session = { sessionId: 's1', lastProcess: null }
    const working = { word: 'Working' as const, working: true, title: null }
    const resting = { word: 'Idle' as const, working: false, title: null }
    expect(sessionStatus(session, true, [], null, working)).toEqual({ dot: 'running', word: 'Working' })
    expect(sessionStatus(session, true, [], null, resting)).toEqual({ dot: 'running-idle', word: 'Idle' })
    expect(sessionStatus(session, true, [], null, { word: 'Running', working: false, title: null }))
      .toEqual({ dot: 'running-idle', word: 'Running' })
    expect(sessionStatus(session, true, [], null, { word: 'Action required', working: false, title: null }))
      .toEqual({ dot: 'running-idle', word: 'Action required' })
    // No observation yet: the word the shell showed before this epic.
    expect(sessionStatus(session, true, [], null, null)).toEqual({ dot: 'running', word: 'Running' })
    const update = { ...request('turn', 's1', '2026-09-14T11:00:00.000Z'), kind: 'notice' as const }
    expect(sessionStatus(session, true, [request('r1', 's1', '2026-09-14T11:00:00.000Z')], null, resting).word)
      .toBe('Waiting for your response')
    expect(sessionStatus(session, true, [update], null, working).word).toBe('Update available')
    const failed = {
      label: 'Build', state: 'failed' as const, word: 'Failed', source: 'agent', age: '2 min ago', stale: false,
      detail: null, evidence: [], evidenceWord: 'No evidence attached',
      observedAt: '2026-09-14T11:58:00.000Z', receivedAt: '2026-09-14T11:58:00.000Z'
    }
    expect(sessionStatus(session, true, [], failed, working).dot).toBe('exited')
    // An agent's own claim is not merged into the observed word; a stale claim no longer outranks it.
    const claimed = {
      label: 'Epic 14', state: 'running' as const, word: 'Running', source: 'agent', age: '1 min ago', stale: false,
      detail: null, evidence: [], evidenceWord: 'No evidence attached',
      observedAt: '2026-09-14T11:59:00.000Z', receivedAt: '2026-09-14T11:59:00.000Z'
    }
    expect(sessionStatus(session, true, [], claimed, resting)).toEqual({ dot: 'running-idle', word: 'Idle' })
    // Activity never reaches a session that is not live.
    expect(sessionStatus(session, false, [], null, working)).toEqual({ dot: 'idle', word: 'Not started' })
    expect(sessionStatus({
      sessionId: 's1',
      lastProcess: { incarnationId: 'i', state: 'exited', exitCode: 0, signal: null, detail: null }
    }, false, [], null, working).word).toBe('Process exited')
  })

  it('names agents from the executable', () => {
    expect(agentTag('/home/me/.local/bin/claude')).toBe('Claude')
    expect(agentTag('/bin/bash')).toBe('Shell')
    expect(agentTag('/usr/bin/htop')).toBe('htop')
    expect(agentTag('/bin/bash', ['-ic', 'claude; exec bash -i'])).toBe('Claude')
    expect(agentTag('/bin/bash', ['-ic', 'codex; exec bash -i'])).toBe('Codex')
    expect(agentTag('/bin/bash', ['-ic', 'htop; exec bash -i'])).toBe('Shell')
    expect(agentTag('/bin/bash', ['-l'])).toBe('Shell')
    expect(agentTag('/usr/bin/codex', ['-c', 'claude'])).toBe('Codex')
  })

  it('titles the window with the selected session, like agterm', () => {
    expect(windowTitle('PICHE', 'Q-Automations')).toBe('Q-Automations')
    expect(windowTitle('PICHE', null)).toBe('PICHE')
    expect(windowTitle(null, null)).toBe('BMN')
    expect(windowTitle('  ', '  ')).toBe('BMN')
  })

  it('shortens home paths for display only', () => {
    const home = inferHome(['/tmp', '/home/me/code/app'])
    expect(home).toBe('/home/me')
    expect(displayPath('/home/me/code/app', home)).toBe('~/code/app')
    expect(displayPath('/home/me', home)).toBe('~')
    expect(displayPath('/home/meow', home)).toBe('/home/meow')
  })

  it('marks progress stale after ten minutes and uses the newest observation', () => {
    const base: Omit<ProgressRecord, 'observedAt' | 'state' | 'source'> = {
      sessionId: 's1', incarnationId: null, label: 'Story 2.2', detail: null, evidence: [],
      receivedAt: '2026-09-14T12:00:00.000Z'
    }
    const records: ProgressRecord[] = [
      { ...base, source: 'journal', state: 'running', observedAt: '2026-09-14T11:40:00.000Z' },
      { ...base, source: 'agent', state: 'claimed-done', observedAt: '2026-09-14T11:55:00.000Z' }
    ]
    expect(progressPresentation(records, 's1', now)).toMatchObject({
      source: 'agent', word: 'Agent reports done', age: '5 min ago', stale: false
    })
    expect(progressPresentation(records.slice(0, 1), 's1', now)).toMatchObject({
      stale: true, age: '20 min ago', word: 'Last observed running'
    })
    expect(progressPresentation(records, 's2', now)).toBeNull()
  })

  it('reports a claim in the reporter\'s voice and says whether anything backs it', () => {
    const base: Omit<ProgressRecord, 'observedAt' | 'state'> = {
      sessionId: 's1', incarnationId: null, source: 'agent', label: 'Story 12.1 checks', detail: null,
      evidence: [], receivedAt: '2026-09-14T12:00:00.000Z'
    }
    const at = (state: ProgressRecord['state'], observedAt: string, evidence: ProgressRecord['evidence'] = []) =>
      progressPresentation([{ ...base, state, observedAt, evidence }], 's1', now)

    // `verified` stays the wire word; the display says who claimed it.
    expect(at('verified', '2026-09-14T11:55:00.000Z')).toMatchObject({
      word: 'Reported verified', evidenceWord: 'No evidence attached'
    })
    expect(at('verified', '2026-09-14T11:55:00.000Z', [
      { artifactId: 'a1', name: 'checks.log' }, { artifactId: 'a2', name: 'shot.png' }
    ])).toMatchObject({
      word: 'Reported verified',
      evidenceWord: 'Evidence attached (2)',
      evidence: [{ artifactId: 'a1', name: 'checks.log' }, { artifactId: 'a2', name: 'shot.png' }],
      observedAt: '2026-09-14T11:55:00.000Z'
    })
    // Attaching files never changes the state, and never stops a report going stale.
    expect(at('verified', '2026-09-14T11:40:00.000Z', [{ artifactId: 'a1', name: 'checks.log' }]))
      .toMatchObject({ state: 'verified', stale: true, word: 'Last reported verified' })
    expect(at('claimed-done', '2026-09-14T11:40:00.000Z')).toMatchObject({ word: 'Last reported done' })
    // Only the two report states change their stale prefix; an observation keeps the old wording.
    expect(at('failed', '2026-09-14T11:40:00.000Z')).toMatchObject({ word: 'Last observed failed' })
    expect(at('waiting', '2026-09-14T11:40:00.000Z')).toMatchObject({ word: 'Last observed waiting' })
    // Every state carries the evidence word, not only the ones that claim success.
    expect(at('running', '2026-09-14T11:55:00.000Z', [{ artifactId: 'a1', name: 'partial.log' }]))
      .toMatchObject({ word: 'Running', evidenceWord: 'Evidence attached (1)' })
  })

  it('re-ages an open detail without changing the words it was opened with', () => {
    const opened = progressPresentation([{
      sessionId: 's1', incarnationId: null, source: 'agent', state: 'verified', label: 'Checks',
      detail: null, evidence: [{ artifactId: 'a1', name: 'checks.log' }],
      observedAt: '2026-09-14T11:58:00.000Z', receivedAt: '2026-09-14T11:58:00.000Z'
    }], 's1', now)!

    expect(opened).toMatchObject({ word: 'Reported verified', age: '2 min ago', stale: false })

    // Twenty minutes later the same observation is older, and says so, in the same honest voice.
    const later = agedProgress(opened, Date.parse('2026-09-14T12:20:00.000Z'))
    expect(later).toMatchObject({ word: 'Last reported verified', age: '22 min ago', stale: true })
    // Everything that is a record of what was said stays exactly as it was.
    expect(later.label).toBe(opened.label)
    expect(later.state).toBe(opened.state)
    expect(later.evidence).toEqual(opened.evidence)
    expect(later.evidenceWord).toBe(opened.evidenceWord)
    expect(later.observedAt).toBe(opened.observedAt)
    expect(later.receivedAt).toBe(opened.receivedAt)
  })

  it('carries the stored time, so two reports at the same observed time are still distinguishable', () => {
    const at = (receivedAt: string) => progressPresentation([{
      sessionId: 's1', incarnationId: null, source: 'agent', state: 'running', label: 'Replayed',
      detail: null, evidence: [], observedAt: '2026-09-14T11:58:00.000Z', receivedAt
    }], 's1', now)!

    expect(at('2026-09-14T11:58:00.000Z').receivedAt).not.toBe(at('2026-09-14T11:59:00.000Z').receivedAt)
  })

  it('shows progress only for the requested process incarnation', () => {
    const records: ProgressRecord[] = [
      {
        sessionId: 's1', incarnationId: 'old', source: 'agent', state: 'failed', label: 'Old run', detail: null,
        evidence: [], observedAt: '2026-09-14T11:59:00.000Z', receivedAt: '2026-09-14T11:59:00.000Z'
      },
      {
        sessionId: 's1', incarnationId: 'current', source: 'agent', state: 'running', label: 'Current run', detail: null,
        evidence: [], observedAt: '2026-09-14T11:58:00.000Z', receivedAt: '2026-09-14T11:58:00.000Z'
      }
    ]
    expect(progressPresentation(records, 's1', now, 'current')?.label).toBe('Current run')
    expect(progressPresentation(records, 's1', now, 'missing')).toBeNull()
  })

  it('formats relative ages', () => {
    expect(relativeAge('2026-09-14T11:59:50.000Z', now)).toBe('10 s ago')
    expect(relativeAge('2026-09-14T09:00:00.000Z', now)).toBe('3 h ago')
  })

  it('walks unresolved requests across other sessions, oldest first', () => {
    const records = [
      request('r2', 's2', '2026-09-14T11:10:00.000Z'),
      request('r1', 's1', '2026-09-14T11:00:00.000Z'),
      request('r3', 's3', '2026-09-14T11:20:00.000Z', 'withdrawn')
    ]
    expect(nextRequest(records, null)?.requestId).toBe('r1')
    expect(nextRequest(records, 's1')?.requestId).toBe('r2')
    expect(nextRequest(records, 's2')?.requestId).toBe('r1')
    expect(nextRequest([records[1]!], 's1')?.requestId).toBe('r1')
    expect(nextRequest([], 's1')).toBeNull()
  })

  it('cycles actionable requests before informational updates with stable ordering', () => {
    const records = [
      { ...request('notice-old', 'updates', '2026-09-14T10:00:00.000Z'), kind: 'notice' as const },
      { ...request('permission', 'permissions', '2026-09-14T11:00:00.000Z'), kind: 'permission' as const },
      request('question', 'questions', '2026-09-14T11:00:00.000Z'),
      { ...request('notice-new', 'updates-2', '2026-09-14T12:00:00.000Z'), kind: 'notice' as const }
    ]
    const groups = openAttentionGroups(records)
    expect(groups.responses.map((item) => item.requestId)).toEqual(['permission', 'question'])
    expect(groups.updates.map((item) => item.requestId)).toEqual(['notice-old', 'notice-new'])
    expect(nextRequest(records, null)?.requestId).toBe('permission')
    expect(nextRequest(records, 'permissions')?.requestId).toBe('question')
    expect(nextRequest(records.filter((item) => item.kind === 'notice'), null)?.requestId).toBe('notice-old')
    expect(sessionAttention(records, 'permissions')).toBe('response')
    expect(sessionAttention(records, 'updates')).toBe('update')
    expect(sessionAttention(records, 'missing')).toBeNull()
  })

  it('orders open requests by what blocks an agent, then oldest first, then by id', () => {
    const kinds: AttentionRecord['kind'][] = ['permission', 'question', 'review', 'handoff', 'notice']
    const tier = { permission: 0, question: 1, review: 2, handoff: 2, notice: 3 }
    for (const left of kinds) {
      for (const right of kinds) {
        const older = { ...request('a', 's1', '2026-09-14T11:00:00.000Z'), kind: left }
        const newer = { ...request('b', 's2', '2026-09-14T11:30:00.000Z'), kind: right }
        const expected = Math.sign(tier[left] - tier[right]) || -1
        expect(Math.sign(compareAttention(older, newer)), `${left} vs ${right}`).toBe(expected)
      }
    }
    const sameTime = '2026-09-14T11:00:00.000Z'
    expect(compareAttention({ ...request('b', 's1', sameTime), kind: 'review' }, { ...request('a', 's2', sameTime), kind: 'handoff' })).toBeGreaterThan(0)
    const records = [
      { ...request('review-1', 's1', '2026-09-14T10:00:00.000Z'), kind: 'review' as const },
      { ...request('review-2', 's2', '2026-09-14T10:05:00.000Z'), kind: 'review' as const },
      { ...request('permission', 's3', '2026-09-14T11:00:00.000Z'), kind: 'permission' as const },
      { ...request('handoff', 's4', '2026-09-14T09:00:00.000Z'), kind: 'handoff' as const },
      request('question', 's5', '2026-09-14T11:30:00.000Z'),
      { ...request('notice-new', 's6', '2026-09-14T11:40:00.000Z'), kind: 'notice' as const },
      { ...request('notice-old', 's7', '2026-09-14T08:00:00.000Z'), kind: 'notice' as const }
    ]
    const groups = openAttentionGroups(records)
    expect(groups.responses.map((item) => item.requestId)).toEqual(['permission', 'question', 'handoff', 'review-1', 'review-2'])
    expect(groups.updates.map((item) => item.requestId)).toEqual(['notice-old', 'notice-new'])
    expect(openRequests(records).map((item) => item.requestId).at(-1)).toBe('notice-new')
  })

  it('goes to the highest waiting tier and cycles within it, never back to the current session while another waits', () => {
    const reviews = [
      { ...request('review-1', 's1', '2026-09-14T10:00:00.000Z'), kind: 'review' as const },
      { ...request('review-2', 's2', '2026-09-14T10:05:00.000Z'), kind: 'review' as const }
    ]
    const permission = { ...request('permission', 's3', '2026-09-14T11:00:00.000Z'), kind: 'permission' as const }
    const question = request('question', 's4', '2026-09-14T10:30:00.000Z')
    const notice = { ...request('notice', 's5', '2026-09-14T09:00:00.000Z'), kind: 'notice' as const }
    expect(nextRequest([...reviews, permission, notice], null)?.requestId).toBe('permission')
    expect(nextRequest([...reviews, permission, notice], 's1')?.requestId).toBe('permission')
    expect(nextRequest([...reviews, permission, notice], 's3')?.requestId).toBe('permission')
    expect(nextRequest([...reviews, permission, question], 's3')?.requestId).toBe('question')
    expect(nextRequest([...reviews, permission, question], 's4')?.requestId).toBe('permission')
    expect(nextRequest([...reviews, notice], null)?.requestId).toBe('review-1')
    expect(nextRequest([...reviews, notice], 's1')?.requestId).toBe('review-2')
    expect(nextRequest([...reviews, notice], 's2')?.requestId).toBe('review-1')
    expect(nextRequest([{ ...reviews[0]!, kind: 'handoff' as const }, reviews[1]!], 's1')?.requestId).toBe('review-2')
    expect(nextRequest([notice], 's5')?.requestId).toBe('notice')
  })

  it('words a deadline only in its last hour', () => {
    const at = (minutes: number): string => new Date(now + minutes * 60_000).toISOString()
    expect(expiryText(at(61), now)).toBeNull()
    expect(expiryText(at(60), now)).toBe('expires in 60 min')
    expect(expiryText(at(59), now)).toBe('expires in 59 min')
    expect(expiryText(at(59.2), now)).toBe('expires in 60 min')
    expect(expiryText(at(1), now)).toBe('expires in 1 min')
    expect(expiryText(at(0.5), now)).toBe('expires in under a minute')
    expect(expiryText(at(0), now)).toBe('expiring')
    expect(expiryText(at(-2), now)).toBe('expiring')
    expect(expiryText(null, now)).toBeNull()
  })

  it('names history cleanup, a Telegram outage, or both on the one gear dot', () => {
    const telegram = 'Telegram is not delivering: Telegram rejected the bot token'
    expect(preferencesGearCue(false, null)).toEqual({ dot: false, title: 'Preferences', description: undefined })
    expect(preferencesGearCue(false, telegram)).toEqual({ dot: true, title: `Preferences · ${telegram}`, description: telegram })
    expect(preferencesGearCue(true, telegram)).toEqual({
      dot: true,
      title: `Preferences · History: Start cleanup waits for you · ${telegram}`,
      description: `Agent history cleanup waits for you. ${telegram}`
    })
    expect(preferencesGearCue(true, null).title).toBe('Preferences · History: Start cleanup waits for you')
  })

  it('shows the deadline after the age and in the row name, and nothing without one', () => {
    const popover = (requests: AttentionRecord[]): string => renderToStaticMarkup(createElement(NeedsYouPopover, {
      requests, unread: [], now, anchor: null,
      place: () => ({ workspace: 'Work', session: 'Builder' }),
      onOpenSession: () => undefined, onAcknowledge: () => undefined,
      onMarkAnswered: () => undefined, onClose: () => undefined
    }))
    const soon = { ...request('soon', 's1', '2026-09-14T11:55:00.000Z'), expiresAt: '2026-09-14T12:10:00.000Z' }
    const markup = popover([soon])
    expect(markup).toContain('<span class="age">5 min ago · expires in 10 min</span>')
    expect(markup).toContain('aria-label="Question · soon · Work › Builder · 5 min ago · expires in 10 min"')
    const later = popover([{ ...soon, expiresAt: '2026-09-14T13:10:00.000Z' }])
    expect(later).toContain('<span class="age">5 min ago</span>')
    expect(later).not.toContain('expires')
    expect(popover([{ ...soon, expiresAt: null }])).not.toContain('expires')
  })

  it('gives every card one primary and plates for the rest, and says the source on the seen line (Story 40.1)', () => {
    const markup = renderToStaticMarkup(createElement(NeedsYouPopover, {
      requests: [
        { ...request('asked', 's1', '2026-09-14T11:55:00.000Z'), openedBy: 'cli' },
        { ...request('allow', 's1', '2026-09-14T11:50:00.000Z'), kind: 'permission' as const, openedBy: 'hook:claude:PermissionRequest' },
        { ...request('built', 's1', '2026-09-14T11:45:00.000Z'), kind: 'notice' as const, openedBy: 'osc:9' }
      ],
      unread: [], now, anchor: null,
      place: () => ({ workspace: 'Work', session: 'Builder' }),
      onOpenSession: () => undefined, onAcknowledge: () => undefined,
      onMarkAnswered: () => undefined, onClose: () => undefined
    }))
    const actions = [...markup.matchAll(/<div class="actions">(.*?)<\/div>/gu)].map((match) => match[1]!)
    expect(actions).toHaveLength(3)
    for (const row of actions) {
      expect(row.match(/class="primary"/gu)).toHaveLength(1)
      expect(row).not.toContain('ghost')
    }
    expect(markup).toContain('<p class="seen">Not seen yet · needs your response · <span class="provenance">from bmn ask</span></p>')
    expect(markup).toContain('needs your response · <span class="provenance">from Claude PermissionRequest</span>')
    expect(markup).toContain('informational update · <span class="provenance">from the terminal (OSC 9)</span>')
    // The top line keeps workspace › session · kind · age, with no source squeezed into it.
    expect([...markup.matchAll(/<div class="where">(.*?)<\/div>/gu)].every((match) => !match[1]!.includes('provenance'))).toBe(true)
  })

  it('closes a session\'s open prompts and notices, but not a review or handoff, when the owner types into it', () => {
    const records = [
      { ...request('turn', 's1', '2026-09-14T11:20:00.000Z'), kind: 'notice' as const },
      request('question', 's1', '2026-09-14T11:10:00.000Z'),
      { ...request('review', 's1', '2026-09-14T11:00:00.000Z'), kind: 'review' as const },
      { ...request('petition', 's1', '2026-09-14T11:00:00.000Z'), kind: 'handoff' as const },
      request('other', 's2', '2026-09-14T11:00:00.000Z'),
      request('closed', 's1', '2026-09-14T11:00:00.000Z', 'answered')
    ]
    expect(requestsAnsweredByTyping(records, 's1').map((record) => record.requestId)).toEqual(['question', 'turn'])
    expect(requestsAnsweredByTyping(records, 's3')).toEqual([])
  })

  it('resolves an opened notice but only marks unanswered prompts as seen', () => {
    const prompt = request('prompt', 's1', '2026-09-14T11:00:00.000Z')
    expect(attentionActionWhenOpened(prompt)).toBe('mark-seen')
    expect(attentionActionWhenOpened({ ...prompt, seenAt: now.toString() })).toBeNull()
    expect(attentionActionWhenOpened({ ...prompt, kind: 'permission' })).toBe('mark-seen')
    expect(attentionActionWhenOpened({ ...prompt, kind: 'notice' })).toBe('resolve-notice')
    expect(attentionActionWhenOpened({ ...prompt, kind: 'notice', state: 'answered' })).toBeNull()
  })

  it('wraps neighbors', () => {
    expect(neighbor(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(neighbor(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(neighbor(['a'], null, 1)).toBe('a')
    expect(neighbor([], null, 1)).toBeNull()
  })

  it('offers split partners after the current session, skipping shown ones', () => {
    expect(splitCandidates(['a', 'b', 'c', 'd'], new Set(['b']), 'b')).toEqual(['c', 'd', 'a'])
    expect(splitCandidates(['a', 'b', 'c', 'd'], new Set(['d']), 'd')).toEqual(['a', 'b', 'c'])
    expect(splitCandidates(['a', 'b', 'c'], new Set(['x']), null)).toEqual(['a', 'b', 'c'])
    expect(splitCandidates(['a', 'b', 'c'], new Set(['x']), 'x')).toEqual(['a', 'b', 'c'])
    expect(splitCandidates(['a'], new Set(['a']), 'a')).toEqual([])
  })

  it.each([
    [{ state: 'open', openedBy: 'hook:claude:Notification', resolvedBy: null }, 'from Claude Notification'],
    [{ state: 'open', openedBy: 'hook:codex:PreToolUse', resolvedBy: null }, 'from Codex PreToolUse'],
    [{ state: 'open', openedBy: 'cli', resolvedBy: null }, 'from bmn ask'],
    [{ state: 'open', openedBy: 'watch:repeat', resolvedBy: null }, "from BMN's repeat watch"],
    [{ state: 'open', openedBy: null, resolvedBy: null }, 'from unknown'],
    [{ state: 'answered', openedBy: 'cli', resolvedBy: 'input' }, 'resolved by typing'],
    [{ state: 'answered', openedBy: 'cli', resolvedBy: 'telegram' }, 'answered from Telegram'],
    [{ state: 'answered', openedBy: 'cli', resolvedBy: 'owner' }, 'resolved by BMN'],
    [{ state: 'answered', openedBy: 'cli', resolvedBy: 'hook:claude:PostToolUse' }, 'resolved by Claude PostToolUse'],
    [{ state: 'withdrawn', openedBy: 'cli', resolvedBy: 'hook:claude:Stop' }, 'withdrawn by Claude Stop'],
    [{ state: 'withdrawn', openedBy: 'cli', resolvedBy: null }, 'withdrawn by unknown'],
    [{ state: 'expired', openedBy: 'cli', resolvedBy: 'expiry' }, 'expired'],
    // An event name may hold a colon or a space; the owner reads all of it, not the first segment.
    [{ state: 'open', openedBy: 'hook:claude:Custom:Event', resolvedBy: null }, 'from Claude Custom:Event'],
    [{ state: 'open', openedBy: 'hook:codex:Custom Event', resolvedBy: null }, 'from Codex Custom Event']
  ] as const)('says %o in plain words', (request, words) => {
    expect(attentionProvenance(request)).toBe(words)
  })
})


describe('agent handoff entry and provenance', () => {
  const petition: AttentionRecord = {
    ...request('petition', 'source', '2026-09-14T11:00:00.000Z'),
    kind: 'handoff', requestKey: 'handoff:draft-1', incarnationId: 'process-1', openedBy: 'cli'
  }
  const draft: InputDraftRecord = {
    draftId: 'draft-1', sessionId: 'destination', sourceSessionId: 'source', origin: 'handoff',
    preparedBy: 'agent', requestId: null, text: 'Result for you', artifactId: null, artifactIds: ['file-1'],
    attemptedIncarnationId: null, state: 'draft', detail: null,
    createdAt: '2026-09-14T11:00:00.000Z', updatedAt: '2026-09-14T11:00:00.000Z'
  }
  const source = {
    name: 'Builder',
    lastProcess: { incarnationId: 'process-1', state: 'live' as const, exitCode: null, signal: null, detail: null }
  }

  it('opens the petition’s addressed editable draft and keeps it actionable without typing resolution', () => {
    expect(handoffDraftForAttention(petition, [draft])).toBe(draft)
    expect(draft.sessionId).toBe('destination')
    expect(draft.text).toBe('Result for you')
    expect(draft.artifactIds).toEqual(['file-1'])
    expect(openAttentionGroups([petition]).responses).toEqual([petition])
    expect(attentionActionWhenOpened(petition)).toBe('mark-seen')
    expect(requestsAnsweredByTyping([petition], 'source')).toEqual([])
    expect(attentionProvenance(petition)).toBe('from bmn handoff')
  })

  it('offers Open handoff and acknowledgement without a terminal-answer action', () => {
    const markup = renderToStaticMarkup(createElement(NeedsYouPopover, {
      requests: [petition], unread: [], now, anchor: null,
      place: () => ({ workspace: 'Work', session: 'Builder' }),
      onOpenSession: () => undefined, onAcknowledge: () => undefined,
      onMarkAnswered: () => undefined, onClose: () => undefined
    }))
    expect(markup).toContain('Open handoff')
    expect(markup).toContain('from bmn handoff')
    expect(markup).toContain('Acknowledge')
    expect(markup).not.toContain('Mark answered')
  })

  it('does not open another source’s draft, a completed draft, or a closed petition', () => {
    expect(handoffDraftForAttention(petition, [{ ...draft, sourceSessionId: 'other' }])).toBeNull()
    expect(handoffDraftForAttention(petition, [{ ...draft, state: 'accepted' }])).toBeNull()
    expect(handoffDraftForAttention({ ...petition, state: 'withdrawn' }, [draft])).toBeNull()
    expect(handoffDraftForAttention({ ...petition, requestKey: 'handoff:other' }, [draft])).toBeNull()
  })

  it('attributes agent preparation and detects only that draft’s earlier source process', () => {
    expect(handoffPreparedBy(draft, source, [petition])).toEqual({
      byline: 'Prepared by the agent in Builder', stale: false
    })
    const restarted = { ...source, lastProcess: { ...source.lastProcess, incarnationId: 'process-2' } }
    expect(handoffPreparedBy(draft, restarted, [petition])?.stale).toBe(true)
    expect(handoffPreparedBy(draft, restarted, [{ ...petition, requestKey: 'handoff:other' }])?.stale).toBe(false)
    expect(handoffPreparedBy({ ...draft, preparedBy: null }, source, [petition])).toBeNull()
  })
})

describe('model origin presentation', () => {
  const origin = (over: Partial<HookOriginRecord> = {}): HookOriginRecord => ({
    state: 'observed',
    sessionId: 's1',
    incarnationId: 'incarnation-1',
    agent: 'claude',
    country: 'CN',
    model: 'GLM-5.3',
    apiHost: 'api.z.ai',
    observedAt: '2026-09-27T12:00:00.000Z',
    ...over
  })

  it('finds the record of the live run only', () => {
    const records = [origin(), origin({ sessionId: 's2', incarnationId: 'incarnation-2', agent: 'codex' })]
    const session = (sessionId: string, state: 'live' | 'exited' | 'interrupted' = 'live') =>
      ({ sessionId, lastProcess: { incarnationId: 'incarnation-1', state } }) as Pick<SessionRecord, 'sessionId' | 'lastProcess'>
    expect(activeHookOrigin(records, session('s1'), 'incarnation-1')).toMatchObject({ sessionId: 's1', agent: 'claude' })
    expect(activeHookOrigin(records, session('s1'), 'incarnation-9')).toBeNull()
    expect(activeHookOrigin(records, session('s1'), undefined)).toBeNull()
    expect(activeHookOrigin(records, session('s9'), 'incarnation-1')).toBeNull()
    // The window keeps an exited run's pane and incarnation; its flag still goes with the process.
    expect(activeHookOrigin(records, session('s1', 'exited'), 'incarnation-1')).toBeNull()
    expect(activeHookOrigin(records, session('s1', 'interrupted'), 'incarnation-1')).toBeNull()
  })

  it('flags a classified origin and names its country, model and host in one label', () => {
    expect(modelOriginFlag(origin())).toBe('🇨🇳')
    expect(modelOriginLabel(origin())).toBe('Model origin: China · GLM-5.3 via api.z.ai')
    expect(modelOriginLabel(origin({ country: 'US', model: null, apiHost: null })))
      .toBe('Model origin: the United States')
    expect(modelOriginLabel(origin({ country: 'FR', model: null, apiHost: 'api.mistral.ai' })))
      .toBe('Model origin: France via api.mistral.ai')
  })

  it('shows no flag and no placeholder for an unclassified origin', () => {
    const unknown = origin({ country: null, model: null, apiHost: 'llm.internal.example' })
    expect(modelOriginFlag(unknown)).toBeNull()
    expect(modelOriginLabel(unknown)).toBeNull()
  })

  it('names the agent the run itself reported, in place of the executable word', () => {
    expect(observedAgentName('claude')).toBe('Claude')
    expect(observedAgentName('codex')).toBe('Codex')
    expect(observedAgentName('opencode')).toBe('OpenCode')
    expect(observedAgentName('cursor')).toBe('Cursor')
    // cursor-agent launched directly, or typed into a shell the launcher started.
    expect(agentTag('/home/owner/.local/bin/cursor-agent')).toBe('Cursor')
    expect(agentTag('/bin/bash', ['-ic', 'cursor-agent; exec bash -i'])).toBe('Cursor')
  })
})

describe('compaction words (Story 36.1)', () => {
  it('names the last compaction in local HH:MM with this run\'s count, and says observed when there is none', () => {
    const at = new Date(2026, 8, 28, 9, 5).toISOString()
    expect(compactionWords({ lastAt: at, count: 1 })).toBe('Compacted: 09:05 (1 time this run)')
    expect(compactionWords({ lastAt: at, count: 3 })).toBe('Compacted: 09:05 (3 times this run)')
    expect(compactionWords(null)).toBe('No compaction observed in this run')
  })
})

describe('plan use wording (Story 37.2)', () => {
  // Local times, so the words are the same in every timezone the suite runs in.
  const now = new Date(2026, 8, 25, 14, 0).getTime()
  const reading = (windows: UsageReading['windows'], contextUsedPercent: number | null = 37): UsageReading => ({
    sessionId: 's1', incarnationId: 'i1', agent: 'claude', windows, contextUsedPercent,
    readAt: new Date(now - 120_000).toISOString()
  })
  const today = new Date(2026, 8, 25, 16, 10).toISOString()
  const friday = new Date(2026, 8, 26, 9, 0).toISOString()

  it('names windows and reset times the way a reader says them', () => {
    expect([300, 10_080, 1_440, 2_880, 90].map((minutes) => usageWindowName(minutes, 'row'))).toEqual(['5-hour', 'week', 'day', '2-day', '90-minute'])
    expect(usageWindowName(10_080, 'limit')).toBe('weekly')
    expect(usageClock(today, new Date(now))).toBe('16:10')
    expect(usageClock(friday, new Date(now))).toBe('Sat 09:00')
    expect(usageClock(new Date(2026, 9, 3, 9, 0).toISOString(), new Date(now))).toBe('Oct 3 09:00')
    expect(usageClock('not a time', new Date(now))).toBe('--:--')
  })

  it('reads one reading as one line, with context use on its own', () => {
    const claude = reading([{ minutes: 300, usedPercent: 42, resetsAt: today }, { minutes: 10_080, usedPercent: 18.4, resetsAt: friday }])
    expect(planUseWords(claude, now)).toBe("5-hour 42% · resets 16:10 · week 18% · resets Sat 09:00 · from Claude's status line · read 2 min ago")
    expect(planSourceWords({ ...claude, agent: 'codex' }, now)).toBe("from Codex's session file · read 2 min ago")
    expect(contextUseWords(claude)).toBe('Context window 37% used')
    expect(contextUseWords(reading([], null))).toBeNull()
    expect(planUseWords(reading([]), now)).toBeNull()
  })

  it('marks a window past its reset as stale with the reading\'s time, and one at 90% or more as high', () => {
    const past = new Date(2026, 8, 25, 13, 0).toISOString()
    const markup = renderToStaticMarkup(createElement(PlanWindows, {
      reading: reading([{ minutes: 300, usedPercent: 95, resetsAt: past }, { minutes: 10_080, usedPercent: 89.6, resetsAt: friday }]), now
    }))
    expect(markup).toContain('<li class="stale"><span class="name">5-hour</span>')
    expect(markup).toContain('stale · read 13:58')
    expect(markup).toContain('<li class="high"><span class="name">Week</span>')
    expect(markup).toContain('>90%<')
    expect(markup).toContain('aria-label="5-hour 95% · stale · read 13:58 · week 90% · resets Sat 09:00')
  })

  it('puts the context share in the windows\' share column in Session details, and leaves it out of the dialog', () => {
    const claude = reading([{ minutes: 300, usedPercent: 42, resetsAt: today }])
    const details = renderToStaticMarkup(createElement(PlanWindows, { reading: claude, now, context: true }))
    expect(details).toContain('<li class="plan-use-context" title="Context window 37% used" aria-label="Context window 37% used">' +
      '<span class="name">Context window</span><span aria-hidden="true"></span><span class="value">37%</span></li></ul>')
    expect(renderToStaticMarkup(createElement(PlanWindows, { reading: claude, now }))).not.toContain('Context window')
  })

  it('says whose report is missing when a run has no plan reading', () => {
    expect(planUseMissingWords({ agent: 'opencode', reading: null })).toBe('Not reported by OpenCode')
    expect(planUseMissingWords({ agent: 'cursor', reading: null })).toBe('Not reported by Cursor')
    expect(planUseMissingWords({ agent: 'claude', reading: null })).toContain('bmn statusline install')
    expect(planUseMissingWords({ agent: null, reading: null })).toBe('No reading yet')
    expect(planUseMissingWords({ agent: 'claude', reading: reading([], 12) })).toBe("No plan limits in Claude's last status line")
  })
})
