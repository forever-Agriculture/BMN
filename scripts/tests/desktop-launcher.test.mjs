// MODULE: desktop-launcher.test.mjs - drives the generated launcher against a fake update unit
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commandLinkIsOurs, commandLinkPath, commandLinkScript, launcherScript } from '../lib/desktop-launcher.mjs'

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function executable(path, content) {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

/**
 * The launcher runs with PATH pointing at this directory alone, so a tool the fixture does not
 * provide is genuinely absent -- that is how the no-zenity fallback is exercised honestly.
 */
function linkSystemTools(bin) {
  for (const tool of ['sed', 'tail', 'sleep', 'readlink', 'cat', 'wc', 'printf', 'awk']) {
    for (const directory of ['/usr/bin', '/bin']) {
      const source = join(directory, tool)
      if (existsSync(source)) {
        symlinkSync(source, join(bin, tool))
        break
      }
    }
  }
}

/** A launcher wired to a fake systemctl that reports the update unit active for `activeChecks` calls. */
function fixture({ phase, activeChecks, binary, zenity, log, liveBuild }) {
  const root = mkdtempSync(join(tmpdir(), 'bmn-launcher-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  linkSystemTools(bin)
  const checks = join(root, 'checks')
  executable(join(bin, 'systemctl'), `#!/bin/sh
echo check >> '${checks}'
[ "$(wc -l < '${checks}')" -le ${activeChecks} ]
`)
  executable(join(bin, 'notify-send'), `#!/bin/sh\necho "$@" >> '${join(root, 'notified')}'\n`)
  executable(join(bin, 'xdg-open'), `#!/bin/sh\necho "$@" >> '${join(root, 'opened')}'\n`)
  if (zenity) executable(join(bin, 'zenity'), zenity.replaceAll('{root}', root))
  const statusPath = join(root, 'latest.json')
  writeFileSync(statusPath, `${JSON.stringify({ phase, commit: 'abc', ...(liveBuild ? { liveBuild } : {}) }, null, 2)}\n`)
  if (log !== undefined) writeFileSync(join(root, 'latest.log'), log)
  const packaged = binary ?? join(root, 'bmn')
  if (!binary) executable(packaged, `#!/bin/sh\necho "started $* after $(wc -l < '${checks}') checks" > '${join(root, 'started')}'\n`)
  const launcher = join(root, 'launch-bmn')
  executable(launcher, launcherScript({ binary: packaged, statusPath }))
  return {
    root,
    launcher,
    env: { ...process.env, PATH: bin },
    read: (name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : null)
  }
}

/** A zenity that records the flags and text it was given, then reports the chosen outcome. */
function fakeZenity({ exit = 0, drain = true } = {}) {
  return `#!/bin/sh
for argument in "$@"; do printf '%s\\n' "$argument" >> '{root}/zenity-args'; done
printf -- '--\\n' >> '{root}/zenity-args'
${drain ? `while IFS= read -r line; do printf '%s\\n' "$line" >> '{root}/zenity-input'; done` : ''}
exit ${exit}
`
}

// The launcher ends by itself; these limits only stop a hung one. Its `running()` forks a `readlink` for each process
// on the machine, about 800 on his laptop, so on a loaded machine each of its checks takes seconds.
const LAUNCHER_LIMIT = 60_000

describe('desktop launcher', { timeout: 2 * LAUNCHER_LIMIT + 10_000 }, () => {
  it.each(['pending', 'revoked'])('never activates an abandoned %s restart on a later ordinary exit', async state => {
    const old = spawn('/bin/sleep', ['0.2'], { stdio: 'ignore' })
    const ticks = readFileSync(`/proc/${old.pid}/stat`, 'utf8').split(') ').at(-1).trim().split(/\s+/u)[19]
    const run = fixture({ phase: 'complete', activeChecks: 0 })
    const authorization = join(run.root, 'authorization'); writeFileSync(authorization, `attempt ${state}\n`)
    const launched = spawn(run.launcher, [], { env: { ...run.env, BMN_RESTART_WAIT_PID: String(old.pid), BMN_RESTART_WAIT_TICKS: ticks,
      BMN_RESTART_AUTH_PATH: authorization, BMN_RESTART_AUTH_ID: 'attempt' }, stdio: 'ignore' })
    expect(await new Promise(resolve => launched.once('exit', resolve))).toBe(0)
    expect(run.read('started')).toBe(null)
  })
  it('restart waits for the exact old process before checking the update or opening the build', async () => {
    const old = spawn('/bin/sleep', ['0.8'], { stdio: 'ignore' })
    const ticks = readFileSync(`/proc/${old.pid}/stat`, 'utf8').split(') ').at(-1).trim().split(/\s+/u)[19]
    const run = fixture({ phase: 'complete', activeChecks: 0 })
    const launched = spawn(run.launcher, [], { env: { ...run.env, BMN_RESTART_WAIT_PID: String(old.pid), BMN_RESTART_WAIT_TICKS: ticks }, stdio: 'ignore' })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(run.read('checks')).toBeNull()
    expect(run.read('started')).toBeNull()
    await new Promise(resolve => launched.on('exit', resolve))
    expect(run.read('started')).not.toBeNull()
  })

  it('starts BMN at once when no update is queued', () => {
    const run = fixture({ phase: 'complete', activeChecks: 0, zenity: fakeZenity() })
    const result = spawnSync(run.launcher, ['--flag'], { env: run.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

    expect(result.status).toBe(0)
    expect(run.read('started')).toBe('started --flag after 1 checks\n')
    expect(run.read('notified')).toBeNull()
    expect(run.read('zenity-args')).toBeNull()
  })

  it.each(['waiting-for-exit', 'building'])('holds a start while the update is %s and BMN is closed', (phase) => {
    const run = fixture({ phase, activeChecks: 3, zenity: fakeZenity() })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

    expect(result.status).toBe(0)
    expect(run.read('started')).toMatch(/^started {2}after \d+ checks\n$/u)
    expect(run.read('zenity-args')).toContain('--progress')
    expect(run.read('zenity-args')).toContain('BMN is updating')
  })

  it('shows the build step the owner is waiting on, and closes the window when the update ends', () => {
    const run = fixture({
      phase: 'building',
      activeChecks: 3,
      zenity: fakeZenity(),
      log: '2026-09-20T14:00:00.000Z START package: pnpm run package\n2026-09-20T14:02:00.000Z PASS package\n2026-09-20T14:02:01.000Z START packaged smoke test: pnpm run smoke:packaged\n'
    })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

    expect(result.status).toBe(0)
    expect(run.read('zenity-input')).toContain('#Checking the new build…')
    // The closing 100 is what ends an --auto-close window once the unit goes inactive.
    expect(run.read('zenity-input').trimEnd().split('\n').at(-1)).toBe('100')
    expect(run.read('started')).not.toBeNull()
  })

  it('does not start a half-replaced build when the owner dismisses the window', () => {
    const run = fixture({ phase: 'building', activeChecks: 1_000, zenity: fakeZenity({ exit: 1, drain: false }) })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

    expect(result.status).toBe(0)
    expect(run.read('started')).toBeNull()
    expect(run.read('zenity-args')).toContain("Don't wait")
  })

  // Story 38.2: the words match what the launcher opens - the unchanged previous build, the new build
  // that passed its checks, or nothing when the swap stopped half way.
  it.each([
    [undefined, 'The update failed its checks. Your previous build is unchanged.'],
    ['previous', 'The update failed its checks. Your previous build is unchanged.'],
    ['new', 'The new build passed its checks, but the update did not finish. Open BMN starts the new build.']
  ])('after a failed update with liveBuild %s, says so and opens BMN, or opens the log instead when asked', (liveBuild, text) => {
    const accept = fixture({ phase: 'failed', activeChecks: 1, zenity: fakeZenity(), liveBuild })
    const accepted = spawnSync(accept.launcher, [], { env: accept.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

    expect(accepted.status).toBe(0)
    const args = accept.read('zenity-args').split('\n')
    expect(args).toContain('BMN update failed')
    expect(args).toContain(text)
    expect(args).toContain('Open BMN')
    expect(args).toContain('Show log')
    expect(accept.read('zenity-args')).not.toContain('previous build\n--ok-label\nOpen previous build')
    expect(accept.read('started')).not.toBeNull()

    const showLog = fixture({ phase: 'failed', activeChecks: 1, zenity: fakeZenity({ exit: 1 }), liveBuild })
    const declined = spawnSync(showLog.launcher, [], { env: showLog.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

    expect(declined.status).toBe(0)
    expect(showLog.read('opened')).toBe(`${join(showLog.root, 'latest.log')}\n`)
    expect(showLog.read('started')).toBeNull()
  })

  it('opens nothing when the failed update left no build in place, and says so', () => {
    const run = fixture({ phase: 'failed', activeChecks: 1, zenity: fakeZenity(), liveBuild: 'none' })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

    expect(result.status).toBe(1)
    expect(run.read('zenity-args')).toContain('The update stopped while replacing the build, so there is no build to open. Nothing was started.')
    expect(run.read('zenity-args')).not.toContain('Open BMN')
    expect(run.read('started')).toBeNull()
    expect(run.read('opened')).toBe(`${join(run.root, 'latest.log')}\n`)
  })

  it('says the same in the notification when zenity is not installed', () => {
    const run = fixture({ phase: 'failed', activeChecks: 1, liveBuild: 'previous' })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

    expect(result.status).toBe(0)
    expect(run.read('notified')).toContain('The update failed its checks. Your previous build is unchanged.')
    expect(run.read('started')).not.toBeNull()
  })

  it('opens nothing from the previous folder when an update stopped between its renames', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-launcher-half-'))
    roots.push(root)
    const binary = join(root, 'linux-unpacked', 'bmn')
    mkdirSync(join(root, 'linux-unpacked.prev'))
    executable(join(root, 'linux-unpacked.prev', 'bmn'), `#!/bin/sh\necho ran > '${join(root, 'prev-ran')}'\n`)
    const run = fixture({ phase: 'building', activeChecks: 0, binary, zenity: fakeZenity({ exit: 1 }) })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

    expect(result.status).toBe(1)
    expect(run.read('zenity-args')).toContain(`An update stopped while replacing the build; the previous build is in ${join(root, 'linux-unpacked.prev')}. Nothing was started.`)
    expect(existsSync(join(root, 'prev-ran'))).toBe(false)
  })

  it('never reports an older failed update to a start that did not wait for one', () => {
    const run = fixture({ phase: 'failed', activeChecks: 0, zenity: fakeZenity() })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

    expect(result.status).toBe(0)
    expect(run.read('zenity-args')).toBeNull()
    expect(run.read('started')).not.toBeNull()
  })

  it('falls back to a notification where zenity is not installed', () => {
    const run = fixture({ phase: 'building', activeChecks: 3 })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

    expect(result.status).toBe(0)
    expect(run.read('notified')).toMatch(/^BMN is updating/u)
    expect(run.read('started')).not.toBeNull()
  })

  it('forwards a start to the running BMN while the update waits for it to exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-launcher-running-'))
    roots.push(root)
    // A real executable, so /proc/<pid>/exe resolves to the packaged path the launcher looks for.
    const binary = join(root, 'bmn')
    // /bin/sleep can be a multicall coreutils binary that exits when renamed to bmn.
    copyFileSync(process.execPath, binary)
    chmodSync(binary, 0o755)
    const running = spawn(binary, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      const run = fixture({ phase: 'waiting-for-exit', activeChecks: 1_000, binary, zenity: fakeZenity() })
      const result = spawnSync(run.launcher, ['-e', ''], { env: run.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

      expect(result.status).toBe(0)
      expect(run.read('notified')).toBeNull()
      expect(run.read('zenity-args')).toBeNull()
    } finally {
      running.kill()
    }
  })

  it('waits for the update instead of starting the old build when only BMN helpers run the binary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-launcher-helper-'))
    roots.push(root)
    const binary = join(root, 'bmn')
    copyFileSync(process.execPath, binary)
    chmodSync(binary, 0o755)
    // A team-ask supervisor or the CLI: the packaged binary run as Node, alive after the window closed.
    const helper = spawn(binary, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    try {
      const run = fixture({ phase: 'waiting-for-exit', activeChecks: 3, binary, zenity: fakeZenity() })
      const result = spawnSync(run.launcher, ['-e', ''], { env: run.env, encoding: 'utf8', timeout: LAUNCHER_LIMIT })

      expect(result.status).toBe(0)
      expect(run.read('zenity-args')).toContain('BMN is updating')
    } finally {
      helper.kill()
    }
  })

  it('quotes paths that contain shell syntax', () => {
    const script = launcherScript({ binary: "/opt/it's $HOME/bmn", statusPath: '/state/latest.json' })
    expect(script).toContain(`binary='/opt/it'\\''s $HOME/bmn'`)
  })
})

describe('the bmn command for a session outside BMN (102.4)', () => {
  it('runs the packaged launcher and never takes the place of a command of his', () => {
    expect(commandLinkPath({ HOME: '/home/someone' })).toBe('/home/someone/.local/bin/bmn')
    const script = commandLinkScript('/opt/a b/bmn')
    expect(script).toContain(`exec '/opt/a b/resources/bin/bmn' "$@"`)
    expect(commandLinkIsOurs(null)).toBe(true)
    expect(commandLinkIsOurs(script)).toBe(true)
    expect(commandLinkIsOurs('#!/bin/sh\necho his own\n')).toBe(false)
  })
})

describe('restart child handover regression', () => {
 it('waits for the update despite a same-binary child outliving the parent', async () => {
  const root=mkdtempSync(join(tmpdir(),'bmn-restart-child-')); roots.push(root)
  const binary=join(root,'sleep'); copyFileSync('/bin/sleep',binary); chmodSync(binary,0o700)
  const old=spawn(binary,['0.1'],{stdio:'ignore'}), sibling=spawn(binary,['10'],{stdio:'ignore'})
  const ticks=readFileSync(`/proc/${old.pid}/stat`,'utf8').split(') ').at(-1).trim().split(/\s+/u)[19]
  const run=fixture({phase:'waiting-for-exit',activeChecks:3,binary})
  const launched=spawn(run.launcher,['0'],{env:{...run.env,BMN_RESTART_WAIT_PID:String(old.pid),BMN_RESTART_WAIT_TICKS:ticks},stdio:['ignore','pipe','pipe']})
  let diagnostic='';launched.stderr.on('data',b=>{diagnostic+=b.toString()})
  expect(await new Promise(resolve=>launched.once('exit',resolve)),diagnostic).toBe(0)
  const checks=run.read('checks').trim().split('\n').length
  if(sibling.exitCode===null) await new Promise(resolve=>sibling.once('exit',resolve))
  expect(checks).toBeGreaterThan(3)
 },60000)
})
