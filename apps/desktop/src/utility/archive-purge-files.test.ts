// MODULE: archive-purge-files.test.ts - the host cleans saved output and files apart and logs what it removed
import { describe, expect, it } from 'vitest'
import { archivePurgeMessage, removePurgedFiles } from './archive-purge-files'

const purged = {
  sessionIds: ['a', 'b'],
  workspaceIds: ['w'],
  originals: [{ artifactId: 'one', sha256: 'a'.repeat(64) }, { artifactId: 'two', sha256: 'b'.repeat(64) }]
}

describe('files removed after an archive purge', () => {
  it('logs how many files were removed and names failures only when there are some', () => {
    expect(archivePurgeMessage(purged, { removed: 3, failed: 0 }))
      .toBe('[BMN] deleted 2 archived session(s), 1 archived workspace(s) and 3 file(s)')
    expect(archivePurgeMessage(purged, { removed: 1, failed: 2 }))
      .toBe('[BMN] deleted 2 archived session(s), 1 archived workspace(s) and 1 file(s); 2 file(s) could not be removed')
  })

  it('still removes the files when the saved output cannot be removed', async () => {
    const asked: unknown[] = []
    const lines = await removePurgedFiles(purged, {
      savedOutput: () => Promise.reject(new Error('Synthetic saved-output failure')),
      originals: async (originals) => { asked.push(originals); return { removed: 2, failed: 0 } }
    })
    expect(asked).toEqual([purged.originals])
    expect(lines).toEqual([
      '[BMN] deleted 2 archived session(s), 1 archived workspace(s) and 2 file(s)',
      '[BMN] archive cleanup failed for saved output: Synthetic saved-output failure'
    ])
  })

  it('still removes the saved output when the files cannot be removed, and counts them as failed', async () => {
    const asked: unknown[] = []
    const lines = await removePurgedFiles(purged, {
      savedOutput: async (sessionIds) => { asked.push(sessionIds) },
      originals: () => Promise.reject(new Error('Synthetic file failure'))
    })
    expect(asked).toEqual([purged.sessionIds])
    expect(lines).toEqual([
      '[BMN] deleted 2 archived session(s), 1 archived workspace(s) and 0 file(s); 2 file(s) could not be removed',
      '[BMN] archive cleanup failed for files: Synthetic file failure'
    ])
  })
})
