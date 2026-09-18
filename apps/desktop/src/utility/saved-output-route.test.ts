import {
  METHOD_REGISTRY,
  SAVED_OUTPUT_FORMAT_VERSION,
  TERMINAL_SAVED_OUTPUT_RETENTION,
  type SavedOutputCatalog,
  type SavedOutputSnapshot
} from '@bmn/protocol'
import { describe, expect, it, vi } from 'vitest'
import { routeTerminalSavedOutputGet } from './saved-output-route'

function snapshot(overrides: Partial<SavedOutputSnapshot> = {}): SavedOutputSnapshot {
  return {
    formatVersion: SAVED_OUTPUT_FORMAT_VERSION,
    sessionId: 'saved-session',
    incarnationId: 'saved-incarnation',
    viewEpoch: 'saved-view',
    capturedAt: '2026-09-12T08:00:00.000Z',
    captureStartedAt: '2026-09-12T07:30:00.000Z',
    content: 'saved output',
    retainedLines: 1,
    lineLimit: 10_000,
    snapshotLimitBytes: 1_048_576,
    snapshotTruncated: false,
    snapshotDroppedLines: 0,
    snapshotDroppedBytes: 0,
    transportDroppedBytes: 0,
    processState: 'exited',
    ...overrides
  }
}

describe(METHOD_REGISTRY.terminalSavedOutputGet, () => {
  it('returns the identity-first current capture and addressable prior captures', async () => {
    const identity = { sessionId: 'current-session', incarnationId: 'current-incarnation' }
    const viewEpoch = 'current-view'
    const catalog: SavedOutputCatalog = {
      view: { ...identity, viewEpoch },
      current: snapshot({ ...identity, viewEpoch, content: 'fresh prompt', processState: 'live' }),
      history: [snapshot({ content: 'valuable prior work', processState: 'interrupted' })],
      finalCaptureUnavailable: [],
      unreadable: [],
      retention: { limit: TERMINAL_SAVED_OUTPUT_RETENTION, pruned: 0 }
    }
    const savedOutputCatalog = vi.fn(async () => catalog)

    await expect(routeTerminalSavedOutputGet({ savedOutputCatalog }, identity, viewEpoch)).resolves.toEqual(catalog)
    expect(savedOutputCatalog).toHaveBeenCalledWith(identity, viewEpoch)
  })

  it('does not guess a global latest capture when the current identity has none', async () => {
    const identity = { sessionId: 'fresh-session', incarnationId: 'fresh-incarnation' }
    const viewEpoch = 'fresh-view'
    const prior = snapshot({ content: 'explicitly selectable prior capture' })
    const catalog: SavedOutputCatalog = {
      view: { ...identity, viewEpoch },
      history: [prior],
      finalCaptureUnavailable: [],
      unreadable: [],
      retention: { limit: TERMINAL_SAVED_OUTPUT_RETENTION, pruned: 0 }
    }

    await expect(
      routeTerminalSavedOutputGet({ savedOutputCatalog: async () => catalog }, identity, viewEpoch)
    ).resolves.toEqual(catalog)
  })

  it('loads the selected stopped session catalog without requiring a live incarnation', async () => {
    const catalog: SavedOutputCatalog = {
      view: { sessionId: 'stopped-session', incarnationId: '', viewEpoch: '' },
      history: [snapshot({ sessionId: 'stopped-session', processState: 'interrupted' })],
      finalCaptureUnavailable: [],
      unreadable: [],
      retention: { limit: TERMINAL_SAVED_OUTPUT_RETENTION, pruned: 0 }
    }
    const savedOutputCatalogForSession = vi.fn(async () => catalog)

    await expect(routeTerminalSavedOutputGet(
      { savedOutputCatalog: vi.fn(), savedOutputCatalogForSession },
      { sessionId: 'stopped-session' }
    )).resolves.toEqual(catalog)
    expect(savedOutputCatalogForSession).toHaveBeenCalledWith('stopped-session')
  })
})
