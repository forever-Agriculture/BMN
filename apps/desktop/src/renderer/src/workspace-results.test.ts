import { describe, expect, it } from 'vitest'
import type { ArtifactRecord, InputDraftRecord, ProgressRecord, SessionRecord, WorkspaceRecord } from '@bmn/protocol'
import { sameProgressRecord, workspaceResults } from './workspace-results'

const now = Date.parse('2026-09-24T12:00:00.000Z')
const workspaces = [
  { workspaceId: 'w-one', name: 'One', archivedAt: null },
  { workspaceId: 'w-two', name: 'Two', archivedAt: null }
] as WorkspaceRecord[]
const sessions = [
  { sessionId: 's-one', workspaceId: 'w-one', name: 'Alpha', archivedAt: null,
    lastProcess: { incarnationId: 'run-new' } },
  { sessionId: 's-two', workspaceId: 'w-two', name: 'Beta', archivedAt: null,
    lastProcess: { incarnationId: 'run-two' } },
  { sessionId: 's-archived', workspaceId: 'w-one', name: 'Archived', archivedAt: '2026-09-24',
    lastProcess: null }
] as SessionRecord[]
const report = (sessionId: string, source: string, at: string, incarnationId = 'run-new'): ProgressRecord => ({
  sessionId, source, incarnationId, state: 'claimed-done', label: `Result ${source}`,
  detail: null, evidence: [], observedAt: at, receivedAt: at
})
const handoff = (id: string, state: InputDraftRecord['state'], sourceSessionId = 's-one', sessionId = 's-two'): InputDraftRecord => ({
  draftId: id, origin: 'handoff', sourceSessionId, sessionId, preparedBy: 'agent', requestId: null,
  text: 'Synthetic result', artifactId: null, artifactIds: [], attemptedIncarnationId: null,
  state, detail: null, createdAt: '2026-09-24T11:00:00.000Z', updatedAt: '2026-09-24T11:01:00.000Z'
})

describe('workspace results selector', () => {
  it('keeps sessions and named sources scoped while identifying stale and previous-run claims', () => {
    const old = '2026-09-24T11:40:00.000Z'
    const fresh = '2026-09-24T11:59:00.000Z'
    const view = workspaceResults('w-one', sessions, workspaces, [
      report('s-one', 'agent', fresh),
      report('s-one', 'build', old, 'run-old'),
      report('s-two', 'other', fresh),
      report('s-archived', 'hidden', fresh)
    ], [], [], [], now)
    expect(view.sessions.map((row) => row.session.sessionId)).toEqual(['s-one'])
    expect(view.sessions[0]?.reports.map((row) => [row.record.source, row.run, row.presentation.stale])).toEqual([
      ['agent', 'Current run', false], ['build', 'Previous run', true]
    ])
    expect(view.sessions[0]?.reports[0]?.presentation.word).toBe('Agent reports done')
  })

  it('keeps absent and removed evidence named, and no report as an empty session group', () => {
    const withEvidence = { ...report('s-one', 'agent', '2026-09-24T11:59:00.000Z'), evidence: [
      { artifactId: 'gone', name: 'lost.md' }, { artifactId: 'bad', name: 'bad.png' }
    ] }
    const bad = { artifactId: 'bad', state: 'missing', originalName: 'bad.png' } as ArtifactRecord
    const view = workspaceResults('w-one', sessions.slice(0, 1), workspaces, [withEvidence], [], [bad], [], now)
    expect(view.sessions[0]?.reports[0]?.evidence.map((row) => [row.name, row.availability])).toEqual([
      ['lost.md', 'Removed from Files'], ['bad.png', 'Original unavailable']
    ])
    expect(workspaceResults('w-one', sessions.slice(0, 1), workspaces, [], [], [], [], now)
      .sessions[0]?.reports).toEqual([])
  })

  it('lists only pending or uncertain handoffs once in each addressed workspace', () => {
    const drafts = [
      handoff('draft', 'draft'), handoff('uncertain', 'uncertain'),
      handoff('accepted', 'accepted'), handoff('discarded', 'discarded'),
      handoff('other', 'draft', 's-two', 's-two')
    ]
    const one = workspaceResults('w-one', sessions, workspaces, [], drafts, [], [], now)
    const two = workspaceResults('w-two', sessions, workspaces, [], drafts, [], [], now)
    expect(one.handoffs.map((row) => row.draft.draftId)).toEqual(['draft', 'uncertain'])
    expect(two.handoffs.map((row) => row.draft.draftId)).toEqual(['draft', 'uncertain', 'other'])
    expect(one.handoffs[0]).toMatchObject({
      source: 'One › Alpha', destination: 'Two › Beta', preparation: 'Prepared by the agent in Alpha',
      destinationAvailable: true
    })
  })

  it('labels removed destinations unavailable without changing the addressed ID', () => {
    const view = workspaceResults('w-one', sessions.slice(0, 1), workspaces, [], [
      handoff('removed', 'draft')
    ], [], [], now)
    expect(view.handoffs[0]).toMatchObject({ destination: 'Removed session', destinationAvailable: false })
    expect(view.handoffs[0]?.draft.sessionId).toBe('s-two')
  })

  it('detects a replaced report even when its timestamps are unchanged', () => {
    const initial = report('s-one', 'agent', '2026-09-24T11:59:00.000Z')
    expect(sameProgressRecord(initial, { ...initial, label: 'Changed result' })).toBe(false)
    expect(sameProgressRecord(initial, { ...initial, evidence: [{ artifactId: 'new', name: 'new.md' }] })).toBe(false)
    expect(sameProgressRecord(initial, { ...initial })).toBe(true)
  })
})
