import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  desktopEntryRunsLauncher,
  repositoryReadiness,
  runningExecutablePids
} from '../install/update-desktop.mjs'

describe('desktop source update', () => {
  it('finds only processes whose executable resolves to the packaged binary', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-update-proc-'))
    try {
      const binary = join(root, 'bmn')
      const other = join(root, 'other')
      writeFileSync(binary, '')
      writeFileSync(other, '')
      for (const pid of ['19', '7', 'not-a-pid']) mkdirSync(join(root, pid), { recursive: true })
      symlinkSync(binary, join(root, '19', 'exe'))
      symlinkSync(other, join(root, '7', 'exe'))

      expect(runningExecutablePids(binary, root)).toEqual([19])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires a clean pushed main commit before queuing', () => {
    const ready = { branch: 'main', head: 'abc', originHead: 'abc', status: '' }
    expect(repositoryReadiness(ready)).toBeNull()
    expect(repositoryReadiness({ ...ready, branch: 'feature' })).toMatch(/expected branch main/u)
    expect(repositoryReadiness({ ...ready, status: ' M package.json' })).toBe('working tree is not clean')
    expect(repositoryReadiness({ ...ready, originHead: 'def' })).toMatch(/push the commit first/u)
  })

  it('verifies the installed desktop entry starts BMN through the update-aware launcher', () => {
    const launcher = '/home/owner/.local/share/bmn/launch-bmn'
    expect(desktopEntryRunsLauncher(`[Desktop Entry]\nExec="${launcher}"\n`, launcher)).toBe(true)
    expect(desktopEntryRunsLauncher('[Desktop Entry]\nExec="/repo/apps/desktop/release/linux-unpacked/bmn"\n', launcher)).toBe(false)
  })
})
