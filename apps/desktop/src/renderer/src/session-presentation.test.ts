// MODULE: session-presentation.test.ts - status, tags, progress staleness and needs-you navigation
import type { AttentionRecord, ProgressRecord } from '@ai-terminal/protocol'
import { describe, expect, it } from 'vitest'
import {
  agentTag,
  attentionActionWhenOpened,
  displayPath,
  inferHome,
  neighbor,
  splitCandidates,
  nextRequest,
  progressPresentation,
  relativeAge,
  requestsAnsweredByTyping,
  sessionStatus,
  windowTitle
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
  revision: 1
})

describe('session presentation', () => {
  it('ranks an open request above process state', () => {
    const session = { sessionId: 's1', lastProcess: null }
    expect(sessionStatus(session, true, [request('r1', 's1', '2026-09-14T11:00:00.000Z')])).toEqual({
      dot: 'needs-you',
      word: 'Waiting for your response'
    })
    expect(sessionStatus(session, true, [request('r1', 's1', '2026-09-14T11:00:00.000Z', 'answered')]).dot).toBe('running')
    expect(sessionStatus(session, false, []).dot).toBe('idle')
    expect(sessionStatus({
      sessionId: 's1',
      lastProcess: { incarnationId: 'i', state: 'exited', exitCode: 0, signal: null, detail: null }
    }, false, []).word).toBe('Process exited')
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
    expect(progressPresentation(records.slice(0, 1), 's1', now)).toMatchObject({ stale: true, age: '20 min ago' })
    expect(progressPresentation(records, 's2', now)).toBeNull()
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
})
