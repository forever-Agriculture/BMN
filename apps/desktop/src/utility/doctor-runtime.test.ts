// MODULE: doctor-runtime.test.ts - Real sandbox write refusal, process bounds and cross-process local doctor execution
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { boundedProcess, doctorEnvironment, runLeftoversDoctor, sandboxProcess } from '../../bin/doctor-adapters.mjs'
import { doctorPaths, doctorWorker, loadDoctorState, readDoctorView, runDoctorCommand, saveDoctorState } from '../../bin/doctor.mjs'
import { CHECKS } from '../../bin/doctor-results.mjs'
import { DAY, emptyDoctorState } from '../../bin/doctor-state.mjs'

const exec = promisify(execFile)
const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const roots: string[] = []
const fixture = (): string => { const root = mkdtempSync(join(tmpdir(), 'bmn-doctor-test-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('doctor runtime boundaries', () => {
  it('does not inherit credentials or control sockets into any doctor', () => {
    const env = doctorEnvironment({ HOME: '/real', PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'SYNTHETIC', BMN_CONTROL_SOCKET: 'private' })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.BMN_CONTROL_SOCKET).toBeUndefined()
    expect(env.HOME).toBe('/real')
    expect(env.DISABLE_AUTOUPDATER).toBe('1')
  })

  it('uses a BMN session terminal, retaining a supplied Sixel terminal, rather than creating a dumb-terminal warning', () => {
    expect(doctorEnvironment({ HOME: '/real', PATH: '/usr/bin:/bin', TERM: 'dumb' }).TERM).toBe('xterm-256color')
    expect(doctorEnvironment({ HOME: '/real', PATH: '/usr/bin:/bin', TERM: 'xterm-sixel-256color', TERMINFO_DIRS: '/real/terminfo:' })).toMatchObject({ TERM: 'xterm-sixel-256color', TERMINFO_DIRS: '/real/terminfo:' })
  })

  it('refuses home writes and outside-home symlink writes in the actual bwrap route', async () => {
    const root = fixture()
    const home = join(root, 'home')
    mkdirSync(home)
    // Keep the target outside the sandbox's private /tmp, so this proves EROFS rather than a hidden target.
    const evidence = fileURLToPath(new URL('../../../../.dev-auto/evidence/81-3/', import.meta.url))
    mkdirSync(evidence, { recursive: true })
    const external = mkdtempSync(join(evidence, 'write-probe-'))
    roots.push(external)
    const outside = join(external, 'outside')
    writeFileSync(outside, 'preserve')
    symlinkSync(outside, join(home, 'link'))
    const code = `const fs=require('fs'); const failures=[]; for(const p of [process.env.HOME+'/write',process.env.HOME+'/link']) {try {fs.writeFileSync(p,'changed'); failures.push('WRITTEN')}catch(e){failures.push(e.code)}}; fs.writeFileSync('scratch','private'); console.log(JSON.stringify(failures))`
    const run = await sandboxProcess(home, process.execPath, ['-e', code], process.env)
    expect(run.failure).toBeNull()
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual(['EROFS', 'EROFS'])
    expect(readFileSync(outside, 'utf8')).toBe('preserve')
    expect(existsSync(join(home, 'write'))).toBe(false)
  })

  it('kills output overflow while streaming and returns no partial or masked child output', async () => {
    const run = await boundedProcess(process.execPath, ['-e', 'setInterval(()=>process.stdout.write("sk-SYNTHETIC-SECRET".repeat(1024)),0)'],
      { environment: process.env, outputBytes: 1024, timeoutMs: 5000 })
    expect(run.failure).toBe('overflow')
    expect(run.stdout).toBe('')
  })

  it('finds planted leftovers through the actual sandbox and merges aliases of a shared skills root', async () => {
    const home = fixture()
    mkdirSync(join(home, '.claude/skills'), { recursive: true })
    mkdirSync(join(home, '.agents'), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    symlinkSync('../.claude/skills', join(home, '.agents/skills'))
    symlinkSync('missing-target', join(home, '.claude/skills/sk-SYNTHETIC-NAME-abcdef123456'))
    const config = '[mcp_servers.fake]\ncommand="bmn-doctor-missing-program"\n'
    writeFileSync(join(home, '.codex/config.toml'), config)
    const result = await runLeftoversDoctor(home, { PATH: '/usr/bin:/bin' }, {})
    expect(result.state).toBe('passed')
    expect(result.leftovers?.filter((row) => row.kind === 'skills' && row.reason === 'broken-link')).toHaveLength(1)
    expect(result.leftovers?.some((row) => row.kind === 'mcp' && row.reason === 'missing-program')).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|abcdef|missing-program"\n/)
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe(config)
  })

  it('terminates descendants on timeout before publishing completion', async () => {
    const root = fixture()
    const marker = join(root, 'descendant-wrote')
    const childCode = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'escaped'),500);setTimeout(()=>{},30000)`
    const code = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setTimeout(()=>{},30000)`
    const run = await boundedProcess(process.execPath, ['-e', code], { environment: process.env, timeoutMs: 100 })
    expect(run.failure).toBe('timeout')
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(existsSync(marker)).toBe(false)
  })

  it('marks malformed plugin configuration as incomplete instead of an empty successful inventory', async () => {
    const home = fixture()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude/settings.json'), '{ invalid configuration')
    const result = await runLeftoversDoctor(home, { PATH: '/usr/bin:/bin' }, {})
    expect(result.state).toBe('partial')
    expect(result.problems).toContainEqual({ code: 'leftover-unreadable', item: 1, count: 1 })
  })

  it('keeps an unreadable skills root incomplete instead of silently omitting it', async () => {
    const home = fixture()
    const root = join(home, '.claude/skills')
    mkdirSync(root, { recursive: true })
    chmodSync(root, 0o000)
    try {
      const result = await runLeftoversDoctor(home, { PATH: '/usr/bin:/bin' }, {})
      expect(result.state).toBe('partial')
    } finally { chmodSync(root, 0o700) }
  })

  it('journals a cycle before execution, keeps completed results on interruption, and consumes one startup retry', async () => {
    const home = fixture()
    const environment = { HOME: home, PATH: '/usr/bin:/bin' }
    let clock = 10000
    const identity = 'a'.repeat(64)
    const calls: string[] = []
    const dependencies = {
      environment, now: () => clock++, versions: async () => ({ identity, apps: {
        claude: { executable: null, version: null, identity }, codex: { executable: null, version: null, identity }, opencode: { executable: null, version: null, identity }
      } }),
      qualify: async () => 'unsupported' as const,
      leftoversCheck: async () => ({ state: 'passed' as const, problems: [], leftovers: [] }),
      bmnCheck: async (check: string) => {
        const state = loadDoctorState(environment)
        expect(state.attempt?.finishedAt).toBeNull()
        expect(state.cycleStartedAt).toBeGreaterThan(0)
        calls.push(check)
        return { state: check === 'tools' ? 'failed' as const : 'passed' as const, problems: [] }
      }
    }
    const startupId = randomUUID()
    await doctorWorker({ ...dependencies, startupId })
    const first = loadDoctorState(environment)
    expect(calls).toEqual(['hooks', 'skills', 'tools', 'rules'])
    expect(first.attempt?.completed).toEqual(CHECKS)
    const observedId = first.attempt!.id
    await doctorWorker({ ...dependencies, observedId }) // CLI read never retries
    expect(calls).toHaveLength(4)
    await doctorWorker({ ...dependencies, startupId: randomUUID(), observedId })
    expect(calls).toEqual(['hooks', 'skills', 'tools', 'rules', 'tools'])
    expect(loadDoctorState(environment).retryUsed).toBe(true)
    await doctorWorker({ ...dependencies, startupId: randomUUID(), observedId: loadDoctorState(environment).attempt!.id })
    expect(calls).toHaveLength(5)
    clock += DAY + 1
    await doctorWorker({ ...dependencies, observedId: loadDoctorState(environment).attempt!.id })
    expect(calls).toHaveLength(9)
  })

  it('rejects state symlinks and never overwrites their target or prints its contents', async () => {
    const home = fixture()
    const environment = { HOME: home }
    const paths = doctorPaths(environment)
    mkdirSync(paths.directory, { recursive: true })
    const outside = join(home, 'secret')
    writeFileSync(outside, 'sk-SYNTHETIC-PRIVATE')
    symlinkSync(outside, paths.state)
    expect(() => saveDoctorState(emptyDoctorState(), environment)).toThrow()
    const view = await readDoctorView({ environment })
    expect(view.error).toBe('state-unavailable')
    expect(JSON.stringify(view)).not.toContain('SYNTHETIC')
    expect(readFileSync(outside, 'utf8')).toBe('sk-SYNTHETIC-PRIVATE')
  })

  it('keeps doctor state private and refuses unsafe permissions or hard links', () => {
    const home = fixture(), environment = { HOME: home }, paths = doctorPaths(environment)
    saveDoctorState(emptyDoctorState(), environment)
    expect(statSync(paths.directory).mode & 0o777).toBe(0o700)
    expect(statSync(paths.state).mode & 0o777).toBe(0o600)
    chmodSync(paths.state, 0o644)
    expect(() => loadDoctorState(environment)).toThrow()
    expect(() => saveDoctorState(emptyDoctorState(), environment)).toThrow()
    chmodSync(paths.state, 0o600)
    linkSync(paths.state, join(home, 'alias'))
    expect(() => loadDoctorState(environment)).toThrow()
    expect(() => saveDoctorState(emptyDoctorState(), environment)).toThrow()
  })

  it('refuses an oversized next state before replacing the previous valid state', () => {
    const home = fixture(), environment = { HOME: home }, paths = doctorPaths(environment)
    const state = emptyDoctorState()
    saveDoctorState(state, environment)
    const before = readFileSync(paths.state, 'utf8')
    state.results.leftovers = { state: 'partial', checkedAt: 1, version: 'a'.repeat(64), problems: [],
      leftovers: Array.from({ length: 10000 }, (_, i) => ({ kind: 'memory', app: 'claude', reason: 'missing-project', item: i + 1, identity: 'withheld', locator: { status: 'unresolved' } })) }
    expect(() => saveDoctorState(state, environment)).toThrow()
    expect(readFileSync(paths.state, 'utf8') === before).toBe(true)
    expect(loadDoctorState(environment)).toEqual(emptyDoctorState())
  })

  it('runs concurrent local CLI callers against one synthetic profile with no BMN socket', async () => {
    const home = fixture()
    const env = { HOME: home, PATH: '/usr/bin:/bin' }
    const invoke = async (): Promise<Record<string, unknown>> => {
      try { return JSON.parse((await exec(process.execPath, [CLI, 'doctor', '--json'], { env, timeout: 30000 })).stdout) }
      catch (error) { return JSON.parse((error as { stdout: string }).stdout) }
    }
    const views = await Promise.all([invoke(), invoke()])
    const first = loadDoctorState(env)
    expect(first.attempt?.completed).toEqual(CHECKS)
    expect(first.retryUsed).toBe(false)
    for (const view of views) expect(view.cycleStartedAt).toBe(first.cycleStartedAt)
    const again = await invoke()
    expect(again.cycleStartedAt).toBe(first.cycleStartedAt)
    expect(loadDoctorState(env).attempt!.id).toBe(first.attempt!.id)
  }, 40000)

  it('rejects cleanup, unknown and duplicate options without starting any check', async () => {
    for (const args of [['clean'], ['--yes'], ['--json', '--json'], ['--startup', 'not-an-id']]) {
      const lines: string[] = []
      expect(await runDoctorCommand(args, { out: (text) => lines.push(text) })).toBe(2)
      expect(lines.join('')).toContain('Usage: bmn doctor')
    }
  })
})
