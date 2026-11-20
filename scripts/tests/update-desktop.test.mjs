// MODULE: update-desktop.test.mjs - checks the queued desktop update guards and its package step
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  desktopEntryRunsLauncher,
  queueCommand,
  recordWorkerFailure,
  repositoryReadiness,
  runningAppPids
} from '../install/update-desktop.mjs'
import { KEPT_ATTEMPTS, attemptLogs, startAttempt } from '../lib/update-attempts.mjs'

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

      expect(runningAppPids(binary, root)).toEqual([19])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not count BMN helpers that run the packaged binary as Node as an open BMN', () => {
    // 2026-10-31: team-ask supervisors outlived the closed window, so the queued update kept waiting
    // and the launcher started the old build again.
    const root = mkdtempSync(join(tmpdir(), 'bmn-update-helpers-'))
    try {
      const binary = join(root, 'bmn')
      writeFileSync(binary, '')
      const processes = { 30: 'HOME=/home/o\0LANG=C', 31: 'HOME=/home/o\0ELECTRON_RUN_AS_NODE=1\0LANG=C', 32: 'ELECTRON_RUN_AS_NODE=\0HOME=/home/o', 33: null }
      for (const [pid, environ] of Object.entries(processes)) {
        mkdirSync(join(root, pid))
        symlinkSync(binary, join(root, pid, 'exe'))
        if (environ !== null) writeFileSync(join(root, pid, 'environ'), environ)
      }

      // 31 is a helper; an empty value does not make Node of it (32); an unreadable environment counts as the app (33).
      expect(runningAppPids(binary, root)).toEqual([30, 32, 33])
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

  it('packages only after rebuilding every workspace package the desktop imports', () => {
    // Workspace dist folders are gitignored, so a checkout that only ran the desktop build keeps a
    // stale @bmn/protocol and the queued update failed on a missing export (2026-09-28).
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    const desktop = JSON.parse(readFileSync(join(repoRoot, 'apps/desktop/package.json'), 'utf8'))
    const workspaceDeps = Object.entries({ ...desktop.dependencies, ...desktop.devDependencies })
      .filter(([, version]) => String(version).startsWith('workspace:'))
      .map(([name]) => name)
    const steps = root.scripts.package.split('&&').map((step) => step.trim())
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
    expect(desktop.scripts.package.split('&&').at(-1).trim()).toMatch(/^electron-builder --linux dir$/u)
    expect(root.scripts['smoke:packaged']).toBe('node scripts/smoke/packaged.mjs')
  })

  it('verifies the installed desktop entry starts BMN through the update-aware launcher', () => {
    const launcher = '/home/owner/.local/share/bmn/launch-bmn'
    expect(desktopEntryRunsLauncher(`[Desktop Entry]\nExec="${launcher}"\n`, launcher)).toBe(true)
    expect(desktopEntryRunsLauncher('[Desktop Entry]\nExec="/repo/apps/desktop/release/linux-unpacked/bmn"\n', launcher)).toBe(false)
  })

  describe('every attempt keeps its log (Story 134.1)', () => {
    const commitA = 'a'.repeat(40), commitB = 'b'.repeat(40)
    const withState = (run) => {
      const directory = mkdtempSync(join(tmpdir(), 'bmn-update-attempts-'))
      try { return run(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
    }
    // A folder's every file and its bytes, so "unchanged" means byte for byte.
    const snapshot = (directory) => {
      const files = {}
      const visit = (path, name) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const full = join(path, entry.name), key = name ? `${name}/${entry.name}` : entry.name
          if (entry.isDirectory()) visit(full, key)
          else files[key] = entry.isSymbolicLink() ? `-> ${readlinkSync(full)}` : readFileSync(full, 'hex')
        }
      }
      visit(directory, '')
      return files
    }

    it('keeps both failed attempts with their commit and failing step; latest.log points at the newest (AC1)', () => withState((directory) => {
      const first = startAttempt({ stateDirectory: directory, commit: commitA, now: new Date('2026-11-20T15:24:00.000Z') })
      first.log('START package: pnpm run package')
      recordWorkerFailure({ directory, attempt: first, step: 'package', error: new Error('package failed with exit 1'), liveBuild: 'previous' })
      const second = startAttempt({ stateDirectory: directory, commit: commitB, now: new Date('2026-11-20T15:31:00.000Z') })
      second.log('START packaged smoke test: pnpm run smoke:packaged')
      recordWorkerFailure({ directory, attempt: second, step: 'packaged smoke test', error: new Error('packaged self-test exited 1'), liveBuild: 'previous' })

      const logs = attemptLogs(directory)
      expect(logs).toHaveLength(2)
      const [older, newer] = logs.map((name) => readFileSync(join(directory, 'attempts', name), 'utf8'))
      expect(older).toContain(`ATTEMPT commit ${commitA}`)
      expect(older).toMatch(/FAILED at package: package failed with exit 1/u)
      expect(newer).toContain(`ATTEMPT commit ${commitB}`)
      expect(newer).toMatch(/FAILED at packaged smoke test: packaged self-test exited 1/u)
      expect(readlinkSync(join(directory, 'latest.log'))).toBe(join('attempts', logs[1]))
      expect(readFileSync(join(directory, 'latest.log'), 'utf8')).toBe(newer)
      const status = JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8'))
      expect(status).toMatchObject({ phase: 'failed', commit: commitB, failedStep: 'packaged smoke test', liveBuild: 'previous', logPath: second.path })
    }))

    it(`keeps at most ${KEPT_ATTEMPTS} attempt logs, removing the oldest`, () => withState((directory) => {
      for (let minute = 0; minute < KEPT_ATTEMPTS + 3; minute += 1) {
        startAttempt({ stateDirectory: directory, commit: commitA, now: new Date(Date.UTC(2026, 10, 20, 10, minute)) })
      }
      const logs = attemptLogs(directory)
      expect(logs).toHaveLength(KEPT_ATTEMPTS)
      expect(logs[0]).toMatch(/^20261120T100300000Z-/u)
      expect(readlinkSync(join(directory, 'latest.log'))).toBe(join('attempts', logs.at(-1)))
    }))

    it('replaces a latest.log left as a plain file by an older updater with the link', () => withState((directory) => {
      writeFileSync(join(directory, 'latest.log'), 'old single log\n')
      const started = startAttempt({ stateDirectory: directory, commit: commitA })
      expect(readlinkSync(join(directory, 'latest.log'))).toBe(join('attempts', attemptLogs(directory)[0]))
      expect(readFileSync(started.path, 'utf8')).toContain(`ATTEMPT commit ${commitA}`)
    }))

    it.each([
      ['a dirty tree', { status: ' M scripts/install/update-desktop.mjs' }, 'working tree is not clean'],
      ['unpushed main', { originHead: 'c'.repeat(40) }, 'push the commit first']
    ])('leaves latest.json and the installed record byte-identical when it refuses %s (AC2)', (_name, change, reason) => withState((directory) => {
      writeFileSync(join(directory, 'latest.json'), JSON.stringify({ phase: 'complete', commit: commitA }) + '\n')
      mkdirSync(join(directory, 'completed'))
      writeFileSync(join(directory, 'completed', `${commitA}.json`), '{"phase":"complete"}\n')
      startAttempt({ stateDirectory: directory, commit: commitA })
      const before = snapshot(directory)
      const printed = [], started = []
      const code = queueCommand({
        platform: 'linux', directory,
        state: () => ({ branch: 'main', head: commitB, originHead: commitB, status: '', ...change }),
        prepareBrain: () => { throw new Error('reached brain delivery') },
        queued: () => false, start: () => { started.push(true); return { status: 0 } },
        print: (line) => printed.push(line), printError: (line) => printed.push(line)
      })
      expect(code).toBe(1)
      expect(printed.join('\n')).toMatch(new RegExp(`^BMN update not queued: .*${reason}`, 'u'))
      expect(started).toEqual([])
      expect(snapshot(directory)).toEqual(before)
    }))

    it('puts latest.json back when the unit would not start', () => withState((directory) => {
      writeFileSync(join(directory, 'latest.json'), JSON.stringify({ phase: 'complete', commit: commitA }) + '\n')
      const before = snapshot(directory), printed = []
      const code = queueCommand({
        platform: 'linux', directory, state: () => ({ branch: 'main', head: commitB, originHead: commitB, status: '' }),
        prepareBrain: () => {}, queued: () => false, start: () => ({ status: 1, stderr: 'Unit already exists' }),
        print: (line) => printed.push(line), printError: (line) => printed.push(line)
      })
      expect(code).toBe(1)
      expect(printed.join('\n')).toContain('could not queue BMN update: Unit already exists')
      expect(snapshot(directory)).toEqual(before)
      expect(existsSync(join(directory, 'attempts'))).toBe(false)
    }))
  })
})
