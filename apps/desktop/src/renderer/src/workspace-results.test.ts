import { describe, expect, it } from 'vitest'
import type { ArtifactRecord, ProgressRecord, SessionRecord } from '@bmn/protocol'
import { sameProgressRecord, workspaceResults, WorkspaceResultsDialog } from './workspace-results'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkspaceRecord } from '@bmn/protocol'

const now = Date.parse('2026-09-24T12:00:00.000Z')
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
describe('workspace results selector', () => {
  it('keeps sessions and named sources scoped while identifying stale and previous-run claims', () => {
    const old = '2026-09-24T11:40:00.000Z'
    const fresh = '2026-09-24T11:59:00.000Z'
    const view = workspaceResults('w-one', sessions, [
      report('s-one', 'agent', fresh),
      report('s-one', 'build', old, 'run-old'),
      report('s-two', 'other', fresh),
      report('s-archived', 'hidden', fresh)
    ], [], now)
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
    const view = workspaceResults('w-one', sessions.slice(0, 1), [withEvidence], [bad], now)
    expect(view.sessions[0]?.reports[0]?.evidence.map((row) => [row.name, row.availability])).toEqual([
      ['lost.md', 'Removed from Files'], ['bad.png', 'Original unavailable']
    ])
    expect(workspaceResults('w-one', sessions.slice(0, 1), [], [], now)
      .sessions[0]?.reports).toEqual([])
  })

  it('detects a replaced report even when its timestamps are unchanged', () => {
    const initial = report('s-one', 'agent', '2026-09-24T11:59:00.000Z')
    expect(sameProgressRecord(initial, { ...initial, label: 'Changed result' })).toBe(false)
    expect(sameProgressRecord(initial, { ...initial, evidence: [{ artifactId: 'new', name: 'new.md' }] })).toBe(false)
    expect(sameProgressRecord(initial, { ...initial })).toBe(true)
  })
})

describe('QA: results provenance', () => {
  it('labels the agent claim without pointing to an absent History control', () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceResultsDialog, { workspace: { workspaceId: 'w-one', name: 'QA' } as WorkspaceRecord, now,
      onOpenRuns: () => undefined, onClose: () => undefined, onOpenReport: () => undefined }))
    expect(markup).toContain('<p class="dialog-note">Reported by the agent, not verified by BMN.</p>')
    expect(markup).not.toContain('use History')
    expect(markup).toContain('dev-auto runs…')
  })
})
