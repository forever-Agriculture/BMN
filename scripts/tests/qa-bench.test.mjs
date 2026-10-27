// MODULE: qa-bench.test.mjs - reject ambiguous commands and non-local ports; inherit no owner state
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { benchArguments, disposableEnvironment, loopbackEndpoint, validateAction } from '../qa/bench-lib.mjs'
import { deleteRoot, terminalTraceEvidence, validateRoot, validateStateRoot, withLifecycleLock } from '../qa/bench-state.mjs'

describe('QA bench shell contract', () => {
  it('accepts pnpm separators, actions, stop, and ephemeral or explicit ports', () => {
    expect(benchArguments(['--', 'do', 'type', '#name', 'QA name']).action).toEqual(['type', '#name', 'QA name'])
    expect(benchArguments(['--stop']).stop).toBe(true)
    expect(benchArguments([]).port).toBe(0)
    expect(benchArguments(['--port', '65535']).port).toBe(65535)
    expect(loopbackEndpoint(9222)).toBe('http://127.0.0.1:9222')
  })

  it.each([['--port', '-1'], ['--port', '65536'], ['--port', '1.5'], ['--port', '0.0.0.0:9222'],
    ['--stop', 'do', 'snapshot'], ['--electron', '/electron', '--binary', '/bmn'], ['do', 'click'],
    ['do', 'snapshot', 'extra'], ['other'], ['do', 'evaluate', 'process.exit()']])('refuses invalid arguments %j', (...args) => {
    expect(() => benchArguments(args)).toThrow()
  })

  it.each(['../outside', '/tmp/outside', '..', 'nested/file.png', '.hidden'])('keeps screenshot %s inside the bench folder', name => {
    expect(() => validateAction(['screenshot', name])).toThrow()
  })

  it('validates action payloads and real listening ports too', () => {
    expect(validateAction(['screenshot', 'health-dark.png'])).toEqual(['screenshot', 'health-dark.png'])
    for (const port of [0, -1, 65536, NaN, '9222']) expect(() => loopbackEndpoint(port)).toThrow()
    for (const action of [null, {}, ['click', 1], ['press', 'a'.repeat(65537)]]) expect(() => validateAction(action)).toThrow()
  })

  it('constructs a fresh environment with every mutable root inside the fixture', () => {
    const env = disposableEnvironment('/tmp/bmn-qa-test')
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
      'BMN_CONFIG_HOME', 'BMN_DATA_HOME', 'BMN_STATE_HOME', 'BMN_RUNTIME_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENCODE_CONFIG_DIR', 'TMPDIR']) {
      expect(env[key].startsWith('/tmp/bmn-qa-test/')).toBe(true)
    }
    for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'BMN_SESSION_ID', 'BMN_SESSION_TOKEN', 'CODEX_THREAD_ID', 'DISPLAY', 'WAYLAND_DISPLAY', 'PROMPT_COMMAND']) {
      expect(Object.hasOwn(env, key)).toBe(false)
    }
    expect(env.PATH).toBe('/tmp/bmn-qa-test/bin:/usr/bin:/bin')
  })
})

function fixture(action) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'bmn-qa-ownership-test-')))
  const root = join(parent, 'bmn-qa-owned'), run = join(parent, 'evidence')
  mkdirSync(root); mkdirSync(run)
  const identity = path => { const s = statSync(path); return { device: s.dev, inode: s.ino } }
  const config = { runId: 'fixture-run', root, run, tempParent: parent, tempParentIdentity: identity(parent), rootIdentity: identity(root), group: { path: join(parent, 'owned-group') } }
  writeFileSync(join(root, '.bmn-qa-run'), config.runId)
  try { return action(config) } finally { rmSync(parent, { recursive: true, force: true }) }
}

describe('QA creation ownership and lifecycle lock', () => {
  it('validates the creation identity independently of the stopping shell temporary directory', () => fixture(config => {
    const previous = process.env.TMPDIR
    process.env.TMPDIR = join(config.tempParent, 'another-shell')
    try { expect(validateRoot(config)).toBe(true) }
    finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous }
  }))

  it('rejects forged state and symlink replacement before deleting anything', () => fixture(config => {
    const outside = join(config.tempParent, 'outside')
    mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'unrelated synthetic data')
    expect(() => validateStateRoot({ ...config, root: outside }, config)).toThrow('substituted')
    renameSync(config.root, config.root + '-original')
    symlinkSync(outside, config.root)
    expect(() => deleteRoot(config)).toThrow('creation identity')
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('unrelated synthetic data')
    expect(existsSync(config.root + '-original')).toBe(true)
  }))

  it('retries a crash after recorded deletion without accepting a replacement directory', () => fixture(config => {
    deleteRoot(config)
    expect(validateRoot(config)).toBe(false)
    expect(() => deleteRoot(config)).not.toThrow()
    mkdirSync(config.root)
    writeFileSync(join(config.root, 'keep'), 'replacement')
    expect(() => deleteRoot(config)).toThrow()
    expect(readFileSync(join(config.root, 'keep'), 'utf8')).toBe('replacement')
  }))

  it('holds the kernel lock across a callback and releases it even on a callback failure', () => fixture(config => {
    const lock = join(config.run, 'lifecycle.lock')
    const contender = () => spawnSync('/usr/bin/flock', ['-n', lock, '/bin/true'], { env: {}, stdio: 'ignore' }).status
    expect(() => withLifecycleLock(() => { expect(contender()).toBe(1); throw new Error('synthetic callback failure') }, lock)).toThrow('synthetic callback failure')
    expect(contender()).toBe(0)
  }))

  it('does not pass its held lock descriptor to workload children', () => fixture(config => {
    const lock = join(config.run, 'lifecycle.lock')
    withLifecycleLock(() => {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { readdirSync, readlinkSync } from 'node:fs'
        const paths = readdirSync('/proc/self/fd').flatMap(fd => { try { return [readlinkSync('/proc/self/fd/' + fd)] } catch { return [] } })
        if (paths.includes(process.argv[1])) process.exit(9)
      `, lock], { env: {}, encoding: 'utf8' })
      expect(child.status).toBe(0)
    }, lock)
  }))

  it('bounds a blocked lock acquisition without executing the callback, then recovers', () => fixture(config => {
    const lock = join(config.run, 'lifecycle.lock')
    withLifecycleLock(() => {
      const started = Date.now()
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { withLifecycleLock } from ${JSON.stringify(new URL('../qa/bench-state.mjs', import.meta.url).href)}
        try { withLifecycleLock(() => { process.exit(9) }, process.argv[1]); process.exit(8) }
        catch (error) { if (!error.message.includes('lock unavailable')) process.exit(7) }
      `, lock], { env: {}, encoding: 'utf8', timeout: 7000 })
      expect(child.status, child.stderr).toBe(0)
      expect(Date.now() - started).toBeGreaterThanOrEqual(4800)
    }, lock)
    expect(withLifecycleLock(() => 'recovered', lock)).toBe('recovered')
  }), 10000)

  it('rejects an async transition before its callback can change state', () => fixture(config => {
    let changed = false
    expect(() => withLifecycleLock(async () => { changed = true }, join(config.run, 'lifecycle.lock'))).toThrow('synchronous')
    expect(changed).toBe(false)
  }))
})


describe('QA whole-life terminal evidence', () => {
  it('does not mistake the actor exit for completion of an orphaned child', () => {
    const trace = '11 clone(child_stack=NULL, flags=SIGCHLD) = 12\n11 +++ exited with 0 +++\n12 openat(AT_FDCWD, "/synthetic", O_RDONLY) = 3\n'
    expect(terminalTraceEvidence(trace).complete).toBe(false)
    expect(terminalTraceEvidence(trace + '12 +++ exited with 0 +++\n').complete).toBe(true)
  })

  it('requires a terminal record even when a forked child has not yet made a file call', () => {
    expect(terminalTraceEvidence('11 fork() = 12\n11 +++ exited with 0 +++\n').complete).toBe(false)
  })

  it('accounts for resumed clone calls and thread exits', () => {
    const trace = '11 clone(child_stack=0x12, flags=CLONE_THREAD <unfinished ...>\n11 <... clone resumed>, parent_tid=[12]) = 12\n12 +++ exited with 0 +++\n11 +++ exited with 0 +++\n'
    expect(terminalTraceEvidence(trace).complete).toBe(true)
  })

  it('matches namespace-local clone results to strace host PID annotations', () => {
    const trace = "110 clone(child_stack=NULL, flags=SIGCHLD) = 2 /* 120 in strace's PID NS */\n110 +++ exited with 0 +++\n"
    expect(terminalTraceEvidence(trace).complete).toBe(false)
    expect(terminalTraceEvidence(trace + '120 +++ exited with 0 +++\n').complete).toBe(true)
    const resumed = "110 <... clone resumed>, parent_tid=[2]) = 2 /* 120 in strace's PID NS */\n110 +++ exited with 0 +++\n120 +++ exited with 0 +++\n"
    expect(terminalTraceEvidence(resumed).complete).toBe(true)
    // An exit for another namespace's local ID cannot discharge the host child.
    expect(terminalTraceEvidence(trace + '2 +++ exited with 0 +++\n').complete).toBe(false)
  })

  it('rejects detached or missing trace evidence', () => {
    expect(terminalTraceEvidence('').complete).toBe(false)
    expect(terminalTraceEvidence('11 +++ exited with 0 +++\nstrace: Process 12 detached\n').complete).toBe(false)
  })
})
