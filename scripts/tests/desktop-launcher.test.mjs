// MODULE: desktop-launcher.test.mjs - drives the generated launcher against a fake update unit
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launcherScript } from '../lib/desktop-launcher.mjs'

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
  for (const tool of ['sed', 'tail', 'sleep', 'readlink', 'cat', 'wc', 'printf']) {
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

describe('desktop launcher', () => {
  it('starts BMN at once when no update is queued', () => {
    const run = fixture({ phase: 'complete', activeChecks: 0, zenity: fakeZenity() })
    const result = spawnSync(run.launcher, ['--flag'], { env: run.env, encoding: 'utf8', timeout: 5_000 })

    expect(result.status).toBe(0)
    expect(run.read('started')).toBe('started --flag after 1 checks\n')
    expect(run.read('notified')).toBeNull()
    expect(run.read('zenity-args')).toBeNull()
  })

  it.each(['waiting-for-exit', 'building'])('holds a start while the update is %s and BMN is closed', (phase) => {
    const run = fixture({ phase, activeChecks: 3, zenity: fakeZenity() })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: 10_000 })

    expect(result.status).toBe(0)
    expect(run.read('started')).toMatch(/^started {2}after \d+ checks\n$/u)
    expect(run.read('zenity-args')).toContain('--progress')
    expect(run.read('zenity-args')).toContain('BMN is updating')
  }, 15_000)

  it('shows the build step the owner is waiting on, and closes the window when the update ends', () => {
    const run = fixture({
      phase: 'building',
      activeChecks: 3,
      zenity: fakeZenity(),
      log: '2026-09-20T14:00:00.000Z START package: pnpm run package\n2026-09-20T14:02:00.000Z PASS package\n2026-09-20T14:02:01.000Z START packaged smoke test: pnpm run smoke:packaged\n'
    })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: 10_000 })

    expect(result.status).toBe(0)
    expect(run.read('zenity-input')).toContain('#Checking the new build…')
    // The closing 100 is what ends an --auto-close window once the unit goes inactive.
    expect(run.read('zenity-input').trimEnd().split('\n').at(-1)).toBe('100')
    expect(run.read('started')).not.toBeNull()
  }, 15_000)

  it('does not start a half-replaced build when the owner dismisses the window', () => {
    const run = fixture({ phase: 'building', activeChecks: 1_000, zenity: fakeZenity({ exit: 1, drain: false }) })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: 10_000 })

    expect(result.status).toBe(0)
    expect(run.read('started')).toBeNull()
    expect(run.read('zenity-args')).toContain("Don't wait")
  }, 15_000)

  // Story 38.2: the words match what the launcher opens - the unchanged previous build, the new build
  // that passed its checks, or nothing when the swap stopped half way.
  it.each([
    [undefined, 'The update failed its checks. Your previous build is unchanged.'],
    ['previous', 'The update failed its checks. Your previous build is unchanged.'],
    ['new', 'The new build passed its checks, but the update did not finish. Open BMN starts the new build.']
  ])('after a failed update with liveBuild %s, says so and opens BMN, or opens the log instead when asked', (liveBuild, text) => {
    const accept = fixture({ phase: 'failed', activeChecks: 1, zenity: fakeZenity(), liveBuild })
    const accepted = spawnSync(accept.launcher, [], { env: accept.env, encoding: 'utf8', timeout: 10_000 })

    expect(accepted.status).toBe(0)
    const args = accept.read('zenity-args').split('\n')
    expect(args).toContain('BMN update failed')
    expect(args).toContain(text)
    expect(args).toContain('Open BMN')
    expect(args).toContain('Show log')
    expect(accept.read('zenity-args')).not.toContain('previous build\n--ok-label\nOpen previous build')
    expect(accept.read('started')).not.toBeNull()

    const showLog = fixture({ phase: 'failed', activeChecks: 1, zenity: fakeZenity({ exit: 1 }), liveBuild })
    const declined = spawnSync(showLog.launcher, [], { env: showLog.env, encoding: 'utf8', timeout: 10_000 })

    expect(declined.status).toBe(0)
    expect(showLog.read('opened')).toBe(`${join(showLog.root, 'latest.log')}\n`)
    expect(showLog.read('started')).toBeNull()
  }, 20_000)

  it('opens nothing when the failed update left no build in place, and says so', () => {
    const run = fixture({ phase: 'failed', activeChecks: 1, zenity: fakeZenity(), liveBuild: 'none' })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: 10_000 })

    expect(result.status).toBe(1)
    expect(run.read('zenity-args')).toContain('The update stopped while replacing the build, so there is no build to open. Nothing was started.')
    expect(run.read('zenity-args')).not.toContain('Open BMN')
    expect(run.read('started')).toBeNull()
    expect(run.read('opened')).toBe(`${join(run.root, 'latest.log')}\n`)
  }, 15_000)

  it('says the same in the notification when zenity is not installed', () => {
    const run = fixture({ phase: 'failed', activeChecks: 1, liveBuild: 'previous' })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: 10_000 })

    expect(result.status).toBe(0)
    expect(run.read('notified')).toContain('The update failed its checks. Your previous build is unchanged.')
    expect(run.read('started')).not.toBeNull()
  }, 15_000)

  it('opens nothing from the previous folder when an update stopped between its renames', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-launcher-half-'))
    roots.push(root)
    const binary = join(root, 'linux-unpacked', 'bmn')
    mkdirSync(join(root, 'linux-unpacked.prev'))
    executable(join(root, 'linux-unpacked.prev', 'bmn'), `#!/bin/sh\necho ran > '${join(root, 'prev-ran')}'\n`)
    const run = fixture({ phase: 'building', activeChecks: 0, binary, zenity: fakeZenity({ exit: 1 }) })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: 10_000 })

    expect(result.status).toBe(1)
    expect(run.read('zenity-args')).toContain(`An update stopped while replacing the build; the previous build is in ${join(root, 'linux-unpacked.prev')}. Nothing was started.`)
    expect(existsSync(join(root, 'prev-ran'))).toBe(false)
  }, 15_000)

  it('never reports an older failed update to a start that did not wait for one', () => {
    const run = fixture({ phase: 'failed', activeChecks: 0, zenity: fakeZenity() })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: 5_000 })

    expect(result.status).toBe(0)
    expect(run.read('zenity-args')).toBeNull()
    expect(run.read('started')).not.toBeNull()
  })

  it('falls back to a notification where zenity is not installed', () => {
    const run = fixture({ phase: 'building', activeChecks: 3 })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: 10_000 })

    expect(result.status).toBe(0)
    expect(run.read('notified')).toMatch(/^BMN is updating/u)
    expect(run.read('started')).not.toBeNull()
  }, 15_000)

  it('forwards a start to the running BMN while the update waits for it to exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-launcher-running-'))
    roots.push(root)
    // A real executable, so /proc/<pid>/exe resolves to the packaged path the launcher looks for.
    const binary = join(root, 'bmn')
    copyFileSync('/bin/sleep', binary)
    chmodSync(binary, 0o755)
    const running = spawn(binary, ['30'], { stdio: 'ignore' })
    try {
      const run = fixture({ phase: 'waiting-for-exit', activeChecks: 1_000, binary, zenity: fakeZenity() })
      const result = spawnSync(run.launcher, ['0'], { env: run.env, encoding: 'utf8', timeout: 5_000 })

      expect(result.status).toBe(0)
      expect(run.read('notified')).toBeNull()
      expect(run.read('zenity-args')).toBeNull()
    } finally {
      running.kill()
    }
  })

  it('quotes paths that contain shell syntax', () => {
    const script = launcherScript({ binary: "/opt/it's $HOME/bmn", statusPath: '/state/latest.json' })
    expect(script).toContain(`binary='/opt/it'\\''s $HOME/bmn'`)
  })
})
