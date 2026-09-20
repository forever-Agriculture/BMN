// MODULE: session-presentation.test.ts - status, tags, progress staleness and needs-you navigation
import type { AttentionRecord, ProgressRecord } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import {
  agentTag,
  attentionActionWhenOpened,
  displayPath,
  inferHome,
  openAttentionGroups,
  neighbor,
  splitCandidates,
  nextRequest,
  progressPresentation,
  relativeAge,
  requestsAnsweredByTyping,
  sessionAttention,
  sessionStatus,
  windowTitle,
  attentionProvenance
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
  resolvedBy: null
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
      label: 'Build', state: 'failed' as const, word: 'Failed', source: 'agent', age: '2 min ago', stale: false, detail: null
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
      label: 'Build', state: 'failed' as const, word: 'Failed', source: 'agent', age: '2 min ago', stale: false, detail: null
    }
    expect(sessionStatus(session, true, [], failed, working).dot).toBe('exited')
    // An agent's own claim is not merged into the observed word; a stale claim no longer outranks it.
    const claimed = {
      label: 'Epic 14', state: 'running' as const, word: 'Running', source: 'agent', age: '1 min ago', stale: false, detail: null
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
      sessionId: 's1', incarnationId: null, label: 'Story 2.2', detail: null, receivedAt: '2026-09-14T12:00:00.000Z'
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

  it('shows progress only for the requested process incarnation', () => {
    const records: ProgressRecord[] = [
      {
        sessionId: 's1', incarnationId: 'old', source: 'agent', state: 'failed', label: 'Old run', detail: null,
        observedAt: '2026-09-14T11:59:00.000Z', receivedAt: '2026-09-14T11:59:00.000Z'
      },
      {
        sessionId: 's1', incarnationId: 'current', source: 'agent', state: 'running', label: 'Current run', detail: null,
        observedAt: '2026-09-14T11:58:00.000Z', receivedAt: '2026-09-14T11:58:00.000Z'
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

  it('closes a session\'s open prompts and notices, but not a review, when the owner types into it', () => {
    const records = [
      { ...request('turn', 's1', '2026-09-14T11:20:00.000Z'), kind: 'notice' as const },
      request('question', 's1', '2026-09-14T11:10:00.000Z'),
      { ...request('review', 's1', '2026-09-14T11:00:00.000Z'), kind: 'review' as const },
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
