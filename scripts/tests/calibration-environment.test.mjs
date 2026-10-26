// MODULE: calibration-environment.test.mjs - Story 96.4 (paused 94.1 AC2): the calibration child's home and roots are disposable, the caller's environment is unchanged, agentsDirectory() resolves as before, and the trace and fingerprints the probe reads
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentsDirectory } from '../../apps/desktop/bin/agents-roster.mjs'
import { approvedIfAny } from '../../apps/desktop/bin/agents-state.mjs'
import { CALIBRATION_FLAGS, approvedTeam, assertDisposable, calibrationEnvironment, fingerprint, launchCalibration, tracedAccess, watchedHomes } from '../measure/calibration-environment.mjs'

const ROOT = '/synthetic/bmn-development-x'
const roots = Object.fromEntries(['config', 'data', 'state', 'runtime', 'cache'].map((name) => [name, `${ROOT}/${name}`]))
const CALLER = Object.freeze({
  HOME: '/synthetic/owner-home', PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-0',
  BMN_CONTROL_SOCKET: '/synthetic/socket', AITERM_SESSION_ID: 'synthetic', PROMPT_COMMAND: 'history -a', LANG: 'C.UTF-8'
})
let made = []
afterEach(() => { for (const folder of made) rmSync(folder, { recursive: true, force: true }); made = [] })

describe('the calibration child\'s environment (Story 96.4)', () => {
  it('puts the child\'s home and every mutable root inside the disposable folder and leaves the caller\'s environment as it was', () => {
    const caller = { ...CALLER }
    const env = calibrationEnvironment(caller, { root: ROOT, roots })
    expect(caller).toEqual(CALLER)
    expect(env.HOME).toBe(`${ROOT}/home`)
    expect(env).toMatchObject({ XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache,
      XDG_RUNTIME_DIR: roots.runtime, CLAUDE_CONFIG_DIR: `${roots.config}/claude`, CODEX_HOME: `${roots.config}/codex`, OPENCODE_CONFIG_DIR: `${roots.config}/opencode`,
      BMN_CONFIG_HOME: `${roots.config}/bmn`, BMN_LAUNCH_CWD: ROOT, WAYLAND_DISPLAY: '/run/user/1000/wayland-0', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', SHELL: '/bin/bash' })
    // Nothing of the caller's BMN session rides along.
    expect(Object.keys(env).filter((name) => name.startsWith('AITERM_') || name === 'PROMPT_COMMAND' || name === 'BMN_CONTROL_SOCKET')).toEqual([])
    expect(() => assertDisposable(env, caller, ROOT)).not.toThrow()
  })

  it('refuses the old launcher\'s environment, which kept the caller\'s home', () => {
    const env = { ...calibrationEnvironment(CALLER, { root: ROOT, roots }), HOME: CALLER.HOME }
    expect(() => assertDisposable(env, CALLER, ROOT)).toThrow(/leaves HOME outside its disposable folder; nothing was started/u)
    expect(() => assertDisposable({ ...env, HOME: `${ROOT}/home`, CODEX_HOME: '/synthetic/owner-home/.codex' }, CALLER, ROOT)).toThrow(/CODEX_HOME/u)
  })

  it('leaves agentsDirectory() resolving from the home as it always did: only the child\'s home changes', () => {
    const saved = process.env.HOME
    try {
      process.env.HOME = CALLER.HOME
      expect(agentsDirectory()).toBe('/synthetic/owner-home/.config/bmn/agents')
      process.env.HOME = calibrationEnvironment(CALLER, { root: ROOT, roots }).HOME
      expect(agentsDirectory()).toBe(`${ROOT}/home/.config/bmn/agents`)
    } finally {
      process.env.HOME = saved
    }
  })

  it('is what the real calibration launcher starts BMN with, through the same launch path the probe traces', () => {
    const source = readFileSync(new URL('../measure/calibration-load.mjs', import.meta.url), 'utf8')
    expect(source).toContain('const environment = calibrationEnvironment(process.env, { root, roots })')
    expect(source).toContain('assertDisposable(environment, process.env, root)')
    expect(source).toContain('const child = launchCalibration({ electronPath, flags, cwd: root, env: environment })')
    // No live calibration starts unless the probe passed for this builder and build.
    expect(source.indexOf('await proveIsolation()')).toBeLessThan(source.indexOf('launchCalibration({'))
    expect(source).not.toMatch(/spawn\(electronPath/u)
    // It stops the whole tree it started, on Ctrl-C too (96 review).
    expect(source).toContain('const release = stopOnInterrupt(async () => { await stopTree(child, root); cleanup() })')
    expect(source).toContain('const leftovers = await stopTree(child, root)')
  })

  it('on Ctrl-C stops the detached tree it launched and removes its folder before it ends (96 review)', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'bmn-calibration-interrupt-'))
    made.push(folder)
    const root = join(folder, 'root')
    mkdirSync(root)
    const electron = join(folder, 'electron')
    writeFileSync(electron, `#!/bin/sh\nsleep 300 &\necho $! > '${folder}/grandchild'\nwait\n`)
    chmodSync(electron, 0o755)
    const module = new URL('../measure/calibration-environment.mjs', import.meta.url).href
    const runner = spawn(process.execPath, ['--input-type=module', '-e', [
      `import { rmSync } from 'node:fs'`,
      `import { launchCalibration, stopOnInterrupt, stopTree } from ${JSON.stringify(module)}`,
      `const child = launchCalibration({ electronPath: ${JSON.stringify(electron)}, cwd: ${JSON.stringify(root)}, env: { PATH: '/usr/bin:/bin', HOME: ${JSON.stringify(join(root, 'home'))} }, appPath: '/synthetic/app' })`,
      `stopOnInterrupt(async () => { await stopTree(child, ${JSON.stringify(root)}); rmSync(${JSON.stringify(root)}, { recursive: true, force: true }) })`,
      `console.log(child.pid)`,
      `setInterval(() => {}, 1000)`
    ].join('\n')], { stdio: ['ignore', 'pipe', 'inherit'] })
    const leader = Number(await new Promise((done) => runner.stdout.once('data', (chunk) => done(String(chunk).trim()))))
    for (let waited = 0; !existsSync(join(folder, 'grandchild')) && waited < 5_000; waited += 50) await new Promise((done) => setTimeout(done, 50))
    const grandchild = Number(readFileSync(join(folder, 'grandchild'), 'utf8').trim())
    expect(existsSync(`/proc/${grandchild}`)).toBe(true)
    runner.kill('SIGINT')
    const code = await new Promise((done) => runner.once('exit', (exit) => done(exit)))
    const gone = (pid) => !existsSync(`/proc/${pid}`) || readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z')
    for (let waited = 0; !(gone(leader) && gone(grandchild)) && waited < 5_000; waited += 50) await new Promise((done) => setTimeout(done, 50))
    expect([code, gone(leader), gone(grandchild), existsSync(root)]).toEqual([130, true, true, false])
  })

  it('starts the child in its own process group with the environment it was given, the keyring left alone, and the app last', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'bmn-calibration-launch-'))
    made.push(folder)
    const electron = join(folder, 'electron')
    writeFileSync(electron, `#!/bin/sh\nprintf '%s\\n' "$@" > '${folder}/args'\nprintf '%s' "$HOME" > '${folder}/home'\nps -o pgid= -p $$ | tr -d ' ' > '${folder}/group'\n`)
    chmodSync(electron, 0o755)
    const env = { PATH: '/usr/bin:/bin', HOME: join(folder, 'home-of-the-child') }
    const child = launchCalibration({ electronPath: electron, flags: ['--ozone-platform=headless'], cwd: folder, env, appPath: '/synthetic/app' })
    await new Promise((done) => child.on('exit', done))
    expect(readFileSync(join(folder, 'args'), 'utf8').trim().split('\n')).toEqual([...CALIBRATION_FLAGS, '--ozone-platform=headless', '/synthetic/app'])
    expect(CALIBRATION_FLAGS).toContain('--password-store=basic')
    expect(readFileSync(join(folder, 'home'), 'utf8')).toBe(env.HOME)
    expect(readFileSync(join(folder, 'group'), 'utf8').trim()).toBe(String(child.pid))
  })
})

describe('what the probe reads (Story 96.4)', () => {
  it('names every strace line that touches the outside home, and no other', () => {
    const trace = [
      '101 openat(AT_FDCWD, "/synthetic/work/outside-home/.config/bmn/agents/roster.md", O_RDONLY|O_CLOEXEC) = 3',
      '102 statx(AT_FDCWD, "/synthetic/work/outside-home", AT_STATX_SYNC_AS_STAT, STATX_ALL, 0x7ffd) = 0',
      '103 openat(AT_FDCWD, "/synthetic/work/outside-home-2/x", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '104 openat(AT_FDCWD, "/synthetic/bmn-development-x/home/.config/bmn/agents/state/auto-tests.json", O_WRONLY|O_CREAT, 0600) = 7',
      '105 rename("/synthetic/bmn-development-x/home/a.tmp", "/synthetic/work/outside-home/.config/bmn/agents/state/auto-tests.json") = 0',
      '106 +++ exited with 0 +++'
    ].join('\n')
    expect(tracedAccess(trace, ['/synthetic/work/outside-home']).map((line) => line.split(' ')[0])).toEqual(['101', '102', '105'])
    // A real home is watched but for the folders the probe names as its own: this checkout, its disposable roots.
    const real = [
      '201 openat(AT_FDCWD, "/synthetic/real-home/.config/bmn/agents/roster.md", O_RDONLY) = 3',
      '202 openat(AT_FDCWD, "/synthetic/real-home/code/BMN/apps/desktop/out/main/index.js", O_RDONLY) = 3',
      '203 statx(AT_FDCWD, "/synthetic/real-home/.claude", AT_STATX_SYNC_AS_STAT, STATX_ALL, 0x7ffd) = -1 ENOENT (No such file or directory)',
      '204 openat(AT_FDCWD, "/synthetic/real-home/code/BMN-other/x", O_RDONLY) = 3'
    ].join('\n')
    expect(tracedAccess(real, ['/synthetic/real-home'], ['/synthetic/real-home/code/BMN']).map((line) => line.split(' ')[0])).toEqual(['201', '203', '204'])
  })

  it('watches the caller\'s home and the account\'s own home from the password file, each once (96 review)', () => {
    expect(watchedHomes({ HOME: '/synthetic/owner-home' }, '/synthetic/account-home')).toEqual(['/synthetic/owner-home', '/synthetic/account-home'])
    expect(watchedHomes({ HOME: '/synthetic/owner-home/' }, '/synthetic/owner-home')).toEqual(['/synthetic/owner-home'])
    expect(watchedHomes({})).toEqual([userInfo().homedir])
  })

  it('seeds a synthetic team BMN\'s own reader takes as approved, so BMN plans its tests and writes their tries', () => {
    const home = mkdtempSync(join(tmpdir(), 'bmn-calibration-team-'))
    made.push(home)
    const text = readFileSync(new URL('../../apps/desktop/src/utility/test-fixtures/agents/roster-example.md', import.meta.url), 'utf8')
    const saved = process.env.HOME
    try {
      process.env.HOME = home
      expect(approvedIfAny()).toBeNull()
      approvedTeam(join(home, '.config/bmn/agents'), text)
      expect(approvedIfAny()?.number).toBe(1)
      expect(approvedIfAny()?.data.agents.length).toBeGreaterThan(0)
    } finally {
      process.env.HOME = saved
    }
  })

  it('tells a changed file, a new one and a touched time apart from an untouched folder', () => {
    const folder = mkdtempSync(join(tmpdir(), 'bmn-calibration-fingerprint-'))
    made.push(folder)
    mkdirSync(join(folder, 'state'))
    writeFileSync(join(folder, 'roster.md'), 'synthetic team\n')
    utimesSync(join(folder, 'roster.md'), 1_000, 1_000)
    const before = fingerprint(folder)
    expect(fingerprint(folder)).toEqual(before)
    expect(before.map((row) => [row.path, row.kind])).toEqual([['roster.md', 'file'], ['state', 'folder']])
    writeFileSync(join(folder, 'state/auto-tests.json'), '{}\n')
    expect(fingerprint(folder)).not.toEqual(before)
    rmSync(join(folder, 'state/auto-tests.json'))
    utimesSync(join(folder, 'roster.md'), 2_000, 2_000)
    expect(fingerprint(folder).find((row) => row.path === 'roster.md')?.mtimeMs).not.toBe(before.find((row) => row.path === 'roster.md')?.mtimeMs)
  })
})
