// MODULE: desktop-launcher.test.mjs - drives the generated launcher against a fake update unit
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** A launcher wired to a fake systemctl that reports the update unit active for `activeChecks` calls. */
function fixture({ phase, activeChecks, binary }) {
  const root = mkdtempSync(join(tmpdir(), 'bmn-launcher-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const checks = join(root, 'checks')
  executable(join(bin, 'systemctl'), `#!/bin/sh
echo check >> '${checks}'
[ "$(wc -l < '${checks}')" -le ${activeChecks} ]
`)
  executable(join(bin, 'notify-send'), `#!/bin/sh\necho "$@" >> '${join(root, 'notified')}'\n`)
  const statusPath = join(root, 'latest.json')
  writeFileSync(statusPath, `${JSON.stringify({ phase, commit: 'abc' }, null, 2)}\n`)
  const packaged = binary ?? join(root, 'bmn')
  if (!binary) executable(packaged, `#!/bin/sh\necho "started $* after $(wc -l < '${checks}') checks" > '${join(root, 'started')}'\n`)
  const launcher = join(root, 'launch-bmn')
  executable(launcher, launcherScript({ binary: packaged, statusPath }))
  return {
    root,
    launcher,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    read: (name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : null)
  }
}

describe('desktop launcher', () => {
  it('starts BMN at once when no update is queued', () => {
    const run = fixture({ phase: 'complete', activeChecks: 0 })
    const result = spawnSync(run.launcher, ['--flag'], { env: run.env, encoding: 'utf8', timeout: 5_000 })

    expect(result.status).toBe(0)
    expect(run.read('started')).toBe('started --flag after 1 checks\n')
    expect(run.read('notified')).toBeNull()
  })

  it.each(['waiting-for-exit', 'building'])('holds a start while the update is %s and BMN is closed', (phase) => {
    const run = fixture({ phase, activeChecks: 3 })
    const result = spawnSync(run.launcher, [], { env: run.env, encoding: 'utf8', timeout: 10_000 })

    expect(result.status).toBe(0)
    expect(run.read('started')).toBe('started  after 4 checks\n')
    expect(run.read('notified')).toMatch(/^BMN is updating/u)
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
      const run = fixture({ phase: 'waiting-for-exit', activeChecks: 1_000, binary })
      const result = spawnSync(run.launcher, ['0'], { env: run.env, encoding: 'utf8', timeout: 5_000 })

      expect(result.status).toBe(0)
      expect(run.read('notified')).toBeNull()
    } finally {
      running.kill()
    }
  })

  it('quotes paths that contain shell syntax', () => {
    const script = launcherScript({ binary: "/opt/it's $HOME/bmn", statusPath: '/state/latest.json' })
    expect(script).toContain(`binary='/opt/it'\\''s $HOME/bmn'`)
  })
})
