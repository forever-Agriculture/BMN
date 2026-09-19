import { describe, expect, it } from 'vitest'
import { emptyWorkspaceLayout, type SessionRecord } from '@bmn/protocol'
import {
  FOLLOW_TAIL_VIEW,
  captureLayoutScroll,
  closeLayoutPane,
  resizeLayoutSplit,
  resumeLayoutFollowTail,
  setLayoutOrientation,
  routeSessionView,
  selectLayoutSession,
  sessionLayoutView,
  splitLayoutSession,
  userScrollUpdate
} from './workspace-layout'

const sessions = ['session-a', 'session-b', 'session-c']

const record = (sessionId: string, workspaceId: string): SessionRecord => ({
  sessionId,
  workspaceId,
  name: sessionId,
  cwd: '/workspace',
  executable: '/bin/bash',
  argv: [],
  position: 0,
  backgroundChoice: null,
  revision: 1,
  createdAt: '2026-09-13T00:00:00.000Z',
  archivedAt: null,
  lastProcess: null
})

describe('workspace layout transitions', () => {
  it('selects and splits no more than two unique workspace sessions', () => {
    const selected = selectLayoutSession(emptyWorkspaceLayout('workspace-1'), 'session-a', sessions)
    const split = splitLayoutSession(selected, 'session-b', sessions, 'stacked')
    expect(split).toMatchObject({
      selectedSessionId: 'session-b',
      split: {
        orientation: 'stacked',
        panes: [
          { sessionId: 'session-a', ratio: 0.5 },
          { sessionId: 'session-b', ratio: 0.5 }
        ]
      }
    })
    expect(() => splitLayoutSession(split, 'session-c', sessions)).toThrow(/at most two/)
  })

  it('keeps the active workspace while selecting a pane from another workspace', () => {
    const allIds = ['home', 'foreign']
    const home = selectLayoutSession(emptyWorkspaceLayout('workspace-home'), 'home', allIds)
    const split = splitLayoutSession(home, 'foreign', allIds)

    expect(split.workspaceId).toBe('workspace-home')
    expect(split.selectedSessionId).toBe('foreign')
    expect(split.split.panes.map((pane) => pane.sessionId)).toEqual(['home', 'foreign'])
    const focusedHome = selectLayoutSession(split, 'home', allIds)
    expect(focusedHome.workspaceId).toBe('workspace-home')
    expect(focusedHome.split.panes).toEqual(split.split.panes)
  })

  it('rejects an invalid transition through the shared protocol predicate', () => {
    const invalid = {
      ...emptyWorkspaceLayout('workspace-1'),
      selectedSessionId: 'session-a',
      split: {
        orientation: 'side-by-side' as const,
        panes: [
          { sessionId: 'session-a', ratio: 0.5 },
          { sessionId: 'session-a', ratio: 0.5 }
        ]
      }
    }
    expect(() => captureLayoutScroll(invalid, 'session-a', 4, sessions)).toThrow(/invalid state/)
  })

  it('keeps the viewport on output while follow-tail is false', () => {
    const selected = selectLayoutSession(emptyWorkspaceLayout('workspace-1'), 'session-a', sessions)
    const reading = captureLayoutScroll(selected, 'session-a', 42, sessions)
    expect(reading.sessionView['session-a']).toEqual({ scrollLine: 42, followTail: false })
    expect(captureLayoutScroll(reading, 'session-a', 42, sessions)).toBe(reading)
    const layouts = { 'workspace-1': reading }
    const records = sessions.map((sessionId) => record(sessionId, 'workspace-1'))
    expect(sessionLayoutView(layouts, records, 'session-a')).toEqual({ scrollLine: 42, followTail: false })
  })

  it('resumes follow-tail only through the explicit New-output transition', () => {
    const selected = selectLayoutSession(emptyWorkspaceLayout('workspace-1'), 'session-a', sessions)
    const reading = captureLayoutScroll(selected, 'session-a', 42, sessions)
    expect(userScrollUpdate(reading.sessionView['session-a']!, 91, 91))
      .toEqual({ kind: 'scrolled-away', scrollLine: 91 })
    const resumed = resumeLayoutFollowTail(reading, 'session-a', sessions)
    expect(resumed).toMatchObject({
      scrollToBottom: true,
      state: { sessionView: { 'session-a': { scrollLine: null, followTail: true } } }
    })
    expect(resumeLayoutFollowTail(resumed.state, 'session-a', sessions).state).toBe(resumed.state)
  })
})

describe('session view scroll rule', () => {
  it('never changes a following view while output keeps the viewport at the tail', () => {
    expect(userScrollUpdate(FOLLOW_TAIL_VIEW, 120, 120)).toBeNull()
    expect(userScrollUpdate(FOLLOW_TAIL_VIEW, 121, 120)).toBeNull()
  })

  it('records only a scroll away from the tail or a new line while reading history', () => {
    expect(userScrollUpdate(FOLLOW_TAIL_VIEW, 80, 120)).toEqual({ kind: 'scrolled-away', scrollLine: 80 })
    expect(userScrollUpdate({ scrollLine: 80, followTail: false }, 80, 130)).toBeNull()
    expect(userScrollUpdate({ scrollLine: 80, followTail: false }, 70, 130))
      .toEqual({ kind: 'scrolled-away', scrollLine: 70 })
  })
})

describe('session view router', () => {
  const records = [
    record('active-a', 'workspace-active'),
    record('active-b', 'workspace-active'),
    record('inactive-a', 'workspace-inactive')
  ]
  const activeLayout = selectLayoutSession(emptyWorkspaceLayout('workspace-active'), 'active-a', ['active-a', 'active-b'])
  const inactiveLayout = selectLayoutSession(emptyWorkspaceLayout('workspace-inactive'), 'inactive-a', ['inactive-a'])

  it('routes a session of an inactive workspace to its OWN workspace layout', () => {
    const route = routeSessionView(records, 'inactive-a', { kind: 'scrolled-away', scrollLine: 12 })
    expect(route?.workspaceId).toBe('workspace-inactive')
    const next = route!.change(inactiveLayout)
    expect(next.sessionView['inactive-a']).toEqual({ scrollLine: 12, followTail: false })
    expect(() => route!.change(activeLayout)).toThrow(/does not belong to workspace workspace-active/)
  })

  it('updates a session when its home layout retains a cross-workspace pane', () => {
    const allIds = records.map((session) => session.sessionId)
    const mixedLayout = splitLayoutSession(inactiveLayout, 'active-a', allIds)
    const route = routeSessionView(records, 'inactive-a', { kind: 'scrolled-away', scrollLine: 12 })!
    const next = route.change(mixedLayout)

    expect(next.sessionView['inactive-a']).toEqual({ scrollLine: 12, followTail: false })
    expect(next.split.panes).toEqual(mixedLayout.split.panes)
  })

  it('resumes follow-tail when the home layout retains a cross-workspace pane', () => {
    const allIds = records.map((session) => session.sessionId)
    const mixedLayout = splitLayoutSession(inactiveLayout, 'active-a', allIds)
    const reading = captureLayoutScroll(mixedLayout, 'inactive-a', 9, allIds)
    const route = routeSessionView(records, 'inactive-a', { kind: 'follow-tail' })!
    const next = route.change(reading)

    expect(next.sessionView['inactive-a']).toEqual(FOLLOW_TAIL_VIEW)
    expect(next.split.panes).toEqual(mixedLayout.split.panes)
  })

  it('reads a session view from its own workspace, never the active one', () => {
    const route = routeSessionView(records, 'inactive-a', { kind: 'scrolled-away', scrollLine: 5 })!
    const layouts = { 'workspace-active': activeLayout, 'workspace-inactive': route.change(inactiveLayout) }
    expect(sessionLayoutView(layouts, records, 'inactive-a')).toEqual({ scrollLine: 5, followTail: false })
    expect(sessionLayoutView(layouts, records, 'active-a')).toEqual(FOLLOW_TAIL_VIEW)
    expect(sessionLayoutView(layouts, records, 'unknown')).toEqual(FOLLOW_TAIL_VIEW)
    expect(routeSessionView(records, 'unknown', { kind: 'follow-tail' })).toBeNull()
  })

  it('makes follow-tail the constant persisted view', () => {
    const reading = captureLayoutScroll(inactiveLayout, 'inactive-a', 9, ['inactive-a'])
    const route = routeSessionView(records, 'inactive-a', { kind: 'follow-tail' })!
    const following = route.change(reading)
    expect(following.sessionView['inactive-a']).toEqual({ scrollLine: null, followTail: true })
    expect(route.change(following)).toBe(following)
  })
})

describe('split pane transitions', () => {
  const twoPanes = () => splitLayoutSession(
    selectLayoutSession(emptyWorkspaceLayout('workspace-1'), 'session-a', sessions),
    'session-b',
    sessions,
    'stacked'
  )

  it('closes a pane and gives the remaining pane the whole area', () => {
    const closed = closeLayoutPane(twoPanes(), 'session-b', sessions)
    expect(closed.split.panes).toEqual([{ sessionId: 'session-a', ratio: 1 }])
    expect(closed.selectedSessionId).toBe('session-a')
    expect(closeLayoutPane(closed, 'session-c', sessions)).toBe(closed)
  })

  it('clamps the split ratio and keeps the total at one', () => {
    const resized = resizeLayoutSplit(twoPanes(), 0.6, sessions)
    expect(resized.split.panes.map((pane) => pane.ratio)).toEqual([0.6, 0.4])
    expect(resizeLayoutSplit(twoPanes(), 0.99, sessions).split.panes.map((pane) => pane.ratio)).toEqual([0.85, 0.15])
    const single = selectLayoutSession(emptyWorkspaceLayout('workspace-1'), 'session-a', sessions)
    expect(resizeLayoutSplit(single, 0.3, sessions)).toBe(single)
  })

  it('switches orientation without touching panes', () => {
    const turned = setLayoutOrientation(twoPanes(), 'side-by-side', sessions)
    expect(turned.split.orientation).toBe('side-by-side')
    expect(turned.split.panes).toEqual(twoPanes().split.panes)
  })
})
