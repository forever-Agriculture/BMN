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
  runningAppPids,
  workerUnitArguments
} from '../install/update-desktop.mjs'
import { assertHomeUntouched, copyOwnerShellFiles, homeBmnFolders, isolatedEnvironment, selfTestError, stopSmokeLeftovers } from '../smoke/packaged.mjs'
import { temporaryRootContracts } from '../lib/temporary-root.mjs'
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
        prepareBrain: () => { throw new Error('reached brain delivery') }, refreshLauncher: () => { throw new Error('reached the launcher') },
        queued: () => false, start: () => { started.push(true); return { status: 0 } },
        print: (line) => printed.push(line), printError: (line) => printed.push(line)
      })
      expect(code).toBe(1)
      expect(printed.join('\n')).toMatch(new RegExp(`^BMN update not queued: .*${reason}`, 'u'))
      expect(started).toEqual([])
      expect(snapshot(directory)).toEqual(before)
    }))

    it('never writes latest.json, so a unit that would not start or an overlapping request leaves the status alone (review F9)', () => withState((directory) => {
      writeFileSync(join(directory, 'latest.json'), JSON.stringify({ phase: 'complete', commit: commitA }) + '\n')
      const before = snapshot(directory), printed = [], order = []
      const code = queueCommand({
        platform: 'linux', directory, state: () => ({ branch: 'main', head: commitB, originHead: commitB, status: '' }),
        prepareBrain: () => {}, queued: () => false, refreshLauncher: () => order.push('launcher'),
        start: () => { order.push('start'); return { status: 1, stderr: 'Unit already exists' } },
        print: (line) => printed.push(line), printError: (line) => printed.push(line)
      })
      expect(code).toBe(1)
      expect(printed.join('\n')).toContain('could not queue BMN update: Unit already exists')
      expect(snapshot(directory)).toEqual(before)
      expect(existsSync(join(directory, 'attempts'))).toBe(false)
      // The launcher made for the new worker's statuses is in place before that worker starts (review F7).
      expect(order).toEqual(['launcher', 'start'])

      // A winning worker's status survives a second request that finds the unit already running.
      writeFileSync(join(directory, 'latest.json'), JSON.stringify({ phase: 'waiting-for-exit', commit: commitB }) + '\n')
      const winning = snapshot(directory)
      expect(queueCommand({ platform: 'linux', directory, state: () => ({ branch: 'main', head: commitB, originHead: commitB, status: '' }),
        prepareBrain: () => {}, queued: () => true, refreshLauncher: () => { throw new Error('a queued update keeps its launcher') },
        start: () => { throw new Error('never started twice') }, print: () => {}, printError: (line) => printed.push(line) })).toBe(0)
      expect(snapshot(directory)).toEqual(winning)
    }))

    it('keeps a passed build that still waits out of the 20-log pruning, holding the cap at 20 (review F10)', () => withState((directory) => {
      const waiting = startAttempt({ stateDirectory: directory, commit: commitA, now: new Date(Date.UTC(2026, 10, 20, 9, 0)) })
      for (let minute = 0; minute < KEPT_ATTEMPTS + 5; minute += 1) {
        startAttempt({ stateDirectory: directory, commit: commitB, now: new Date(Date.UTC(2026, 10, 20, 10, minute)), protect: [waiting.path] })
      }
      const logs = attemptLogs(directory)
      expect(logs).toHaveLength(KEPT_ATTEMPTS)
      expect(logs[0]).toBe(waiting.path.split('/').at(-1))
      expect(readFileSync(waiting.path, 'utf8')).toContain(`ATTEMPT commit ${commitA}`)
    }))
  })

  describe('built and tested while BMN stays open (Story 134.2)', () => {
    it('hands the forced smoke failure to the worker only when it was set at queue time (AC3)', () => {
      const forced = workerUnitArguments({ PATH: '/usr/bin', BMN_SMOKE_FORCE_FAILURE: '1', BMN_TOKEN: 'never-forwarded' })
      expect(forced).toContain('--setenv=BMN_SMOKE_FORCE_FAILURE=1')
      expect(forced).toContain('--setenv=PATH=/usr/bin')
      expect(forced.join(' ')).not.toContain('BMN_TOKEN')
      expect(forced.at(-1)).toBe('--worker')
      expect(workerUnitArguments({ PATH: '/usr/bin' }).join(' ')).not.toContain('BMN_SMOKE_FORCE_FAILURE')
    })

    it('gives the smoke a HOME of its own, apart from its XDG roots, and none of the live session (D2)', () => {
      expect(temporaryRootContracts.packagedSmoke.directories).toContain('home')
      const roots = { home: '/t/home', config: '/t/config', data: '/t/data', state: '/t/state', cache: '/t/cache', runtime: '/t/runtime' }
      const environment = isolatedEnvironment(roots, { HOME: '/home/owner', PATH: '/usr/bin', BMN_SESSION_ID: 's', BMN_TOKEN: 't', BMN_CONTROL_SOCKET: '/run/bmn.sock', BMN_CLI_BIN_DIR: '/x' })
      const legacy = isolatedEnvironment(roots, { PATH: '/usr/bin', AITERM_CONTROL_SOCKET: '/run/aiterm.sock', AITERM_TOKEN: 't', AITERM_SESSION_ID: 's', BMN_SMOKE_FORCE_FAILURE: '1' })
      for (const name of ['AITERM_CONTROL_SOCKET', 'AITERM_TOKEN', 'AITERM_SESSION_ID']) expect(legacy).not.toHaveProperty(name)
      expect(legacy.BMN_SMOKE_FORCE_FAILURE).toBe('1')
      expect(environment).toMatchObject({ HOME: '/t/home', XDG_CONFIG_HOME: '/t/config', XDG_DATA_HOME: '/t/data', XDG_STATE_HOME: '/t/state', XDG_CACHE_HOME: '/t/cache', XDG_RUNTIME_DIR: '/t/runtime', PATH: '/usr/bin' })
      for (const name of ['BMN_SESSION_ID', 'BMN_TOKEN', 'BMN_CONTROL_SOCKET', 'BMN_CLI_BIN_DIR']) expect(environment).not.toHaveProperty(name)
      for (const xdg of [roots.config, roots.data, roots.state, roots.cache, roots.runtime]) expect(xdg.startsWith(roots.home)).toBe(false)
    })

    it('copies the owner shell files the own-shell self-test check needs into the smoke HOME, nothing else', () => {
      // 2026-11-20: with an empty HOME the self-test's owner-sixel shell found no .bashrc and its prompt went plain.
      const owner = mkdtempSync(join(tmpdir(), 'bmn-smoke-owner-')), home = mkdtempSync(join(tmpdir(), 'bmn-smoke-home-'))
      try {
        writeFileSync(join(owner, '.bashrc'), 'PS1=synthetic\n')
        writeFileSync(join(owner, '.profile'), '. ~/.bashrc\n')
        mkdirSync(join(owner, '.config/bmn'), { recursive: true })
        writeFileSync(join(owner, '.ssh-like-secret'), 'never copied\n')
        expect(copyOwnerShellFiles(home, owner)).toEqual(['.bashrc', '.profile'])
        expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('PS1=synthetic\n')
        expect(readdirSync(home).sort()).toEqual(['.bashrc', '.profile'])
        expect(() => assertHomeUntouched(home)).not.toThrow()
      } finally {
        rmSync(owner, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true })
      }
    })

    it('stops only the processes that carry this smoke root, never others or itself', () => {
      // 2026-11-20: a timed-out self-test left its GPU, network and audio helpers and its Xvfb running for 35 minutes.
      const proc = mkdtempSync(join(tmpdir(), 'bmn-smoke-proc-'))
      try {
        const own = '/tmp/bmn-packaged-smoke-abc/config'
        const environ = { 41: `HOME=/x\0XDG_CONFIG_HOME=${own}\0`, 42: `XDG_CONFIG_HOME=${own}\0PATH=/bin`, 43: `XDG_CONFIG_HOME=${own}-other\0`, 44: 'XDG_CONFIG_HOME=/home/owner/.config\0', 45: `XDG_CONFIG_HOME=${own}\0` }
        for (const [pid, text] of Object.entries(environ)) {
          mkdirSync(join(proc, pid)); writeFileSync(join(proc, pid, 'environ'), text)
          writeFileSync(join(proc, pid, 'stat'), `${pid} (bmn) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${1000 + Number(pid)} 0 0\n`)
        }
        mkdirSync(join(proc, 'self'))
        const killed = []
        expect(stopSmokeLeftovers(own, { procRoot: proc, self: 45, kill: (pid, name) => killed.push([pid, name]) })).toEqual([41, 42])
        expect(killed).toEqual(expect.arrayContaining([[41, 'SIGKILL'], [42, 'SIGKILL']]))
        expect(killed).toHaveLength(2)
      } finally {
        rmSync(proc, { recursive: true, force: true })
      }
    })

    it('names the self-test failure in its own words, not the display noise before it', () => {
      // 2026-11-20: the smoke kept only the last 1,000 characters, which held cleanup lines, never the failure.
      const stderr = "(bmn:1): dbind-WARNING **: Couldn't connect to accessibility bus: failed\nALSA lib pcm.c: [error.pcm] unable to open slave\n[BMN] session self-test failed: prompt, write and stop did not give a turn\n[BMN] self-test phase: exiting application\n"
      expect(selfTestError(stderr)).toBe('; [BMN] session self-test failed: prompt, write and stop did not give a turn')
      expect(selfTestError('[BMN] self-test phase: exiting application\n')).toBe('')
    })

    it("fails the smoke when the candidate wrote into its HOME's BMN folders instead of its XDG roots (D2)", () => {
      const home = mkdtempSync(join(tmpdir(), 'bmn-smoke-home-'))
      try {
        // Other tools may leave their own folders in HOME; only BMN's count.
        mkdirSync(join(home, '.claude'), { recursive: true })
        expect(() => assertHomeUntouched(home)).not.toThrow()
        for (const leak of homeBmnFolders(home)) {
          mkdirSync(leak, { recursive: true })
          expect(() => assertHomeUntouched(home)).toThrow(`the packaged build wrote into HOME instead of its XDG roots: ${leak}`)
          rmSync(leak, { recursive: true })
        }
        expect(homeBmnFolders(home)).toContain(join(home, '.local/state/bmn'))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  })
})
