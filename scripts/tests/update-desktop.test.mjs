// MODULE: update-desktop.test.mjs - checks the queued desktop update guards and its package step
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  desktopEntryRunsLauncher,
  repositoryReadiness,
  runningExecutablePids
} from '../install/update-desktop.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

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

  it.each(['package', 'package:unpacked'])('%s rebuilds every workspace package the desktop imports', (command) => {
    // Workspace dist folders are gitignored, so a checkout that only ran the desktop build keeps a
    // stale @bmn/protocol and the queued update failed on a missing export (2026-09-28).
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    const desktop = JSON.parse(readFileSync(join(repoRoot, 'apps/desktop/package.json'), 'utf8'))
    const workspaceDeps = Object.entries({ ...desktop.dependencies, ...desktop.devDependencies })
      .filter(([, version]) => String(version).startsWith('workspace:'))
      .map(([name]) => name)
    const steps = root.scripts[command].split('&&').map((step) => step.trim())
    const packageStep = steps.indexOf('pnpm --filter @bmn/desktop run package')

    expect(workspaceDeps).toContain('@bmn/protocol')
    expect(packageStep).toBeGreaterThan(-1)
    for (const name of workspaceDeps) {
      const buildStep = steps.indexOf(`pnpm --filter ${name} run build`)
      expect(buildStep, `${name} is built before packaging`).toBeGreaterThan(-1)
      expect(buildStep).toBeLessThan(packageStep)
    }
  })

  it('hands the staging output option to electron-builder through both package scripts (Story 38.2)', () => {
    // pnpm appends `pnpm run package <args>` to the end of the script, so the option reaches only the
    // last command of each script: that must be the desktop package, and there electron-builder.
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    const desktop = JSON.parse(readFileSync(join(repoRoot, 'apps/desktop/package.json'), 'utf8'))

    expect(root.scripts.package.split('&&').at(-1).trim()).toBe('pnpm --filter @bmn/desktop run package')
    expect(desktop.scripts.package.split('&&').at(-1).trim()).toBe('electron-builder --dir')
    expect(root.scripts['smoke:packaged']).toBe('node scripts/smoke/packaged.mjs')
  })

  it('verifies the installed desktop entry starts BMN through the update-aware launcher', () => {
    const launcher = '/home/owner/.local/share/bmn/launch-bmn'
    expect(desktopEntryRunsLauncher(`[Desktop Entry]\nExec="${launcher}"\n`, launcher)).toBe(true)
    expect(desktopEntryRunsLauncher('[Desktop Entry]\nExec="/repo/apps/desktop/release/linux-unpacked/bmn"\n', launcher)).toBe(false)
  })
})
