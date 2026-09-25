import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SAVED_OUTPUT_FORMAT_VERSION,
  TERMINAL_SAVED_OUTPUT_BYTES,
  TERMINAL_SAVED_OUTPUT_RETENTION,
  TERMINAL_SCROLLBACK_LINES,
  type SavedOutputSnapshot
} from '@bmn/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSavedOutputStore } from './saved-output-store'

const createdRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...createdRoots].map((root) => rm(root, { recursive: true, force: true })))
  createdRoots.clear()
})

async function storeFixture(): Promise<{ directory: string; store: FileSavedOutputStore }> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-saved-output-test-'))
  createdRoots.add(root)
  const directory = join(root, 'saved-output')
  return { directory, store: new FileSavedOutputStore(directory) }
}

function legacyPath(
  directory: string,
  identity: { sessionId: string; incarnationId: string }
): string {
  return join(
    directory,
    `${encodeURIComponent(identity.sessionId)}--${encodeURIComponent(identity.incarnationId)}.json`
  )
}

function snapshot(overrides: Partial<SavedOutputSnapshot> = {}): SavedOutputSnapshot {
  return {
    formatVersion: SAVED_OUTPUT_FORMAT_VERSION,
    sessionId: 'session-1',
    incarnationId: 'incarnation-1',
    viewEpoch: 'view-1',
    capturedAt: '2026-09-12T08:00:00.000Z',
    captureStartedAt: '2026-09-12T07:30:00.000Z',
    content: 'saved output',
    retainedLines: 1,
    lineLimit: TERMINAL_SCROLLBACK_LINES,
    snapshotLimitBytes: TERMINAL_SAVED_OUTPUT_BYTES,
    snapshotTruncated: false,
    snapshotDroppedLines: 0,
    snapshotDroppedBytes: 0,
    transportDroppedBytes: 0,
    processState: 'live',
    ...overrides
  }
}

describe('file saved-output store', () => {
  it('persists process-state transitions for every view record of the addressed incarnation', async () => {
    const { store } = await storeFixture()
    const first = snapshot()
    const second = snapshot({ viewEpoch: 'view-2', capturedAt: '2026-09-12T08:01:00.000Z' })
    await store.save(first)
    await store.save(second)

    await store.markProcessState(first, 'exited')

    await expect(store.load(first, first.viewEpoch)).resolves.toMatchObject({ processState: 'exited' })
    await expect(store.load(second, second.viewEpoch)).resolves.toMatchObject({ processState: 'exited' })
  })

  it('keeps separate captures for two view epochs of the same incarnation', async () => {
    const { store } = await storeFixture()
    const beforeRecovery = snapshot({ content: 'valuable pre-crash history' })
    const repaint = snapshot({
      viewEpoch: 'view-2',
      capturedAt: '2026-09-12T08:01:00.000Z',
      content: 'new repaint prompt'
    })

    await store.save(beforeRecovery)
    await store.save(repaint)

    await expect(store.loadCatalog()).resolves.toMatchObject({
      snapshots: [repaint, beforeRecovery]
    })
  })

  it('reads the round-1 format without inventing measurements it did not record', async () => {
    const { directory, store } = await storeFixture()
    const identity = { sessionId: 'legacy-session', incarnationId: 'legacy-incarnation' }
    await mkdir(directory, { recursive: true })
    await writeFile(legacyPath(directory, identity), JSON.stringify({
      ...identity,
      capturedAt: '2026-09-12T08:00:00.000Z',
      captureStartedAt: '2026-09-12T07:30:00.000Z',
      content: 'round-1 saved text',
      retainedLines: 2,
      lineLimit: TERMINAL_SCROLLBACK_LINES,
      snapshotLimitBytes: TERMINAL_SAVED_OUTPUT_BYTES,
      limitBytes: 16 * 1024 * 1024,
      retainedBytes: 123,
      droppedBytes: 0,
      truncated: false,
      processState: 'interrupted'
    }), 'utf8')

    await expect(store.load(identity)).resolves.toMatchObject({
      formatVersion: 1,
      viewEpoch: 'legacy',
      content: 'round-1 saved text',
      snapshotTruncated: null,
      snapshotDroppedLines: null,
      snapshotDroppedBytes: null,
      transportDroppedBytes: null
    })
  })

  it('surfaces corrupt, unsupported, and identity-mismatched records with known identities', async () => {
    const { directory, store } = await storeFixture()
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'corrupt--incarnation.json'), '{not valid json', 'utf8')
    await writeFile(join(directory, 'future--incarnation--view.snapshot.json'), JSON.stringify({
      formatVersion: 999,
      sessionId: 'future',
      incarnationId: 'incarnation',
      viewEpoch: 'view'
    }), 'utf8')
    await writeFile(legacyPath(directory, {
      sessionId: 'named-session',
      incarnationId: 'named-incarnation'
    }), JSON.stringify(snapshot({
      sessionId: 'other-session',
      incarnationId: 'other-incarnation'
    })), 'utf8')

    await expect(store.loadCatalog()).resolves.toMatchObject({
      snapshots: [],
      unreadable: expect.arrayContaining([
        expect.objectContaining({ source: 'corrupt--incarnation.json', reason: 'invalid', sessionId: 'corrupt' }),
        expect.objectContaining({ source: 'future--incarnation--view.snapshot.json', reason: 'unsupported-format', sessionId: 'future' }),
        expect.objectContaining({ source: 'named-session--named-incarnation.json', reason: 'invalid', sessionId: 'other-session' })
      ])
    })
  })

  it('persists final-capture unavailability with the last successful capture across view epochs', async () => {
    const { store } = await storeFixture()
    const saved = snapshot()
    await store.save(saved)

    await store.recordFinalCaptureUnavailable({
      sessionId: saved.sessionId,
      incarnationId: saved.incarnationId,
      viewEpoch: 'restored-view',
      unavailableAt: '2026-09-12T08:02:00.000Z',
      reason: 'not-acknowledged-in-time',
      detail: 'renderer did not acknowledge',
      processState: 'live'
    })

    await expect(store.loadCatalog()).resolves.toMatchObject({
      finalCaptureUnavailable: [{
        lastCaptureAt: saved.capturedAt,
        reason: 'not-acknowledged-in-time',
        viewEpoch: 'restored-view'
      }]
    })
  })

  // Both retention-bound tests write TERMINAL_SAVED_OUTPUT_RETENTION + 1 records one awaited
  // save at a time, and every save rescans the directory: ~850 ms alone, past the default 5 s
  // budget under a full gate's parallel workers. The budget is sized to the saves, not raised globally.
  const retentionBoundTimeout = (TERMINAL_SAVED_OUTPUT_RETENTION + 1) * 200

  it('prunes the oldest records at the named bound and discloses the durable count', async () => {
    const { directory, store } = await storeFixture()
    for (let index = 0; index <= TERMINAL_SAVED_OUTPUT_RETENTION; index += 1) {
      await store.save(snapshot({
        viewEpoch: `view-${index}`,
        capturedAt: new Date(Date.UTC(2026, 8, 12, 8, 0, index)).toISOString(),
        content: `capture ${index}`
      }))
    }

    const catalog = await store.loadCatalog()
    expect(catalog.snapshots).toHaveLength(TERMINAL_SAVED_OUTPUT_RETENTION)
    expect(catalog.snapshots.some(({ content }) => content === 'capture 0')).toBe(false)
    expect(catalog.pruned).toBe(1)
    await expect(readdir(directory)).resolves.toHaveLength(TERMINAL_SAVED_OUTPUT_RETENTION + 1)
  }, retentionBoundTimeout)

  it('removes every file of deleted sessions and nothing of other sessions', async () => {
    const { directory, store } = await storeFixture()
    await store.save(snapshot({ sessionId: 'gone/1' }))
    await store.save(snapshot({ sessionId: 'gone/1', incarnationId: 'incarnation-2' }))
    await store.save(snapshot({ sessionId: 'gone/10' }))
    await store.save(snapshot({ sessionId: 'kept' }))
    await writeFile(join(directory, `${encodeURIComponent('gone/1')}--broken.snapshot.json`), '{', 'utf8')

    await expect(store.removeSessions(['gone/1'])).resolves.toBe(3)

    expect((await readdir(directory)).toSorted()).toEqual([
      `${encodeURIComponent('gone/10')}--incarnation-1--view-1.snapshot.json`,
      'kept--incarnation-1--view-1.snapshot.json'
    ])
    await expect(store.removeSessions(['gone/1'])).resolves.toBe(0)
  })

  it('treats an ENOENT unlink race as an already-pruned record', async () => {
    const { directory } = await storeFixture()
    const store = new FileSavedOutputStore(directory, async (path) => {
      await unlink(path)
      throw Object.assign(new Error('already removed by another prune'), { code: 'ENOENT' })
    })
    for (let index = 0; index <= TERMINAL_SAVED_OUTPUT_RETENTION; index += 1) {
      await store.save(snapshot({
        viewEpoch: `enoent-view-${index}`,
        capturedAt: new Date(Date.UTC(2026, 8, 12, 9, 0, index)).toISOString()
      }))
    }

    await expect(store.loadCatalog()).resolves.toMatchObject({
      snapshots: expect.any(Array),
      pruned: 1
    })
    await expect(readdir(directory)).resolves.toHaveLength(TERMINAL_SAVED_OUTPUT_RETENTION + 1)
  }, retentionBoundTimeout)
})
