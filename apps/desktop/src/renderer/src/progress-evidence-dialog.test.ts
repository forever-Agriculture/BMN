// MODULE: progress-evidence-dialog.test.ts - how referenced files read when they are there and when they are not
import type { ArtifactRecord } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import { evidenceRows, progressProvenance } from './progress-evidence-dialog'
import type { ProgressPresentation } from './session-presentation'

function artifact(artifactId: string, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactId,
    sessionId: 's1',
    incarnationId: null,
    direction: 'output',
    source: 'agent',
    originalName: `${artifactId}.log`,
    mediaType: 'text/plain',
    byteLength: 12_288,
    sha256: 'a'.repeat(64),
    storedPath: `/store/${artifactId}`,
    sourcePath: null,
    state: 'ready',
    createdAt: '2026-09-14T12:00:00.000Z',
    ...overrides
  }
}

const link = (artifactId: string, name: string): ProgressPresentation['evidence'][number] => ({ artifactId, name })

describe('evidence rows', () => {
  it('shows type and size for a file that is there, and offers it for preview', () => {
    const rows = evidenceRows([link('a1', 'checks.log')], [artifact('a1')])

    expect(rows).toEqual([
      expect.objectContaining({ artifactId: 'a1', name: 'checks.log', ready: true, availability: 'text/plain · 12 KB' })
    ])
  })

  it('names every way a file can be unavailable without calling the report a failure', () => {
    const rows = evidenceRows(
      [link('gone', 'gone.log'), link('bad', 'bad.png'), link('dropped', 'dropped.pdf')],
      [artifact('gone', { state: 'missing' }), artifact('bad', { state: 'corrupt' })]
    )

    expect(rows.map((row) => row.availability)).toEqual([
      'Original unavailable',
      'Integrity check failed',
      // No artifact row at all: the report still names the file it claimed to rest on.
      'Removed from Files'
    ])
    expect(rows.map((row) => row.ready)).toEqual([false, false, false])
    expect(rows.map((row) => row.name)).toEqual(['gone.log', 'bad.png', 'dropped.pdf'])
  })

  it('keeps the name the report recorded, not a later one, and the order it was given in', () => {
    const rows = evidenceRows(
      [link('a2', 'second.log'), link('a1', 'as-reported.log')],
      [artifact('a1', { originalName: 'renamed-since.log' }), artifact('a2')]
    )

    expect(rows.map((row) => row.name)).toEqual(['second.log', 'as-reported.log'])
  })

  it('has no rows and needs no list when nothing was attached', () => {
    expect(evidenceRows([], [artifact('a1')])).toEqual([])
  })
})

describe('progress provenance', () => {
  const base: ProgressPresentation = {
    label: 'Story 12.1 checks',
    state: 'verified',
    word: 'Reported verified',
    source: 'agent',
    age: '5 min ago',
    stale: false,
    detail: null,
    evidence: [],
    evidenceWord: 'No evidence attached',
    observedAt: '2026-09-14T11:55:00.000Z',
    receivedAt: '2026-09-14T11:55:00.000Z'
  }

  it('says what was reported, by whom and how long ago', () => {
    expect(progressProvenance(base)).toBe('Reported verified · from agent · 5 min ago')
    expect(progressProvenance({ ...base, word: 'Last reported verified', age: '25 min ago', stale: true }))
      .toBe('Last reported verified · from agent · 25 min ago')
  })
})
