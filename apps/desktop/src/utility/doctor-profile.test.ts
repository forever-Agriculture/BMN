// MODULE: doctor-profile.test.ts - Selected-profile and individually locatable Doctor regression evidence
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { doctorEnvironment, doctorVersions, runLeftoversDoctor, sandboxArguments, sandboxProcess } from '../../bin/doctor-adapters.mjs'
import { doctorPaths, doctorWorker, loadDoctorState, readDoctorView, runDoctorCommand } from '../../bin/doctor.mjs'
import { observeFile, locationRoots } from '../../bin/doctor-locations.mjs'
import { selectedProfile } from '../../bin/doctor-profile.mjs'

for (const firstObserver of ['cli', 'startup'] as const) it(`invalidates cached success when ${firstObserver} observes lost access, then gives one later-start retry`, async () => {
  const home = fixture(); const codex = fixture()
  const environment = { HOME: home, CODEX_HOME: codex, PATH: '/usr/bin:/bin' }
  const identity = 'c'.repeat(64); let qualifications = 0; let checks = 0
  const dependencies = {
    environment,
    versions: async () => ({ identity, apps: Object.fromEntries(['claude', 'codex', 'opencode'].map((app) => [app, { identity, executable: null, version: '1.0.0' }])) as Awaited<ReturnType<typeof doctorVersions>>['apps'] }),
    qualify: async () => { qualifications += 1; return 'qualified' as const },
    appCheck: async () => ({ state: 'passed' as const, problems: [] }),
    bmnCheck: async () => { checks += 1; return { state: 'passed' as const, problems: [] } },
    leftoversCheck: async () => ({ state: 'passed' as const, problems: [], leftovers: [] })
  }
  const start = '00000000-0000-4000-8000-000000000001'
  const later = '00000000-0000-4000-8000-000000000002'
  await doctorWorker({ ...dependencies, startupId: start })
  const initial = loadDoctorState(environment); const inode = lstatSync(codex).ino
  chmodSync(codex, 0)
  try {
    const view = await readDoctorView({ environment })
    expect(lstatSync(codex).ino).toBe(inode)
    expect(view.error).toBe('profile-unavailable')
    expect(view.allWell).toBe(false); expect(view.exitCode).toBe(3)
    expect(view.rows.map((row) => row.checkedAt)).toEqual(Object.values(initial.results).map((row) => row!.checkedAt))
    expect(loadDoctorState(environment).attempt!.id).toBe(initial.attempt!.id)
    await doctorWorker({ ...dependencies, observedId: initial.attempt!.id, startupId: firstObserver === 'cli' ? null : later })
    const failure = loadDoctorState(environment)
    expect(failure.cycleStartedAt).toBe(initial.cycleStartedAt)
    expect(failure.retryUsed).toBe(false); expect(checks).toBe(4)
    expect(Object.values(failure.results).every((row) => row!.state === 'failed')).toBe(true)
    await doctorWorker({ ...dependencies, observedId: failure.attempt!.id })
    expect(loadDoctorState(environment).attempt!.id).toBe(failure.attempt!.id)
  } finally { chmodSync(codex, 0o700) }
  let state = loadDoctorState(environment)
  expect((await readDoctorView({ environment })).allWell).toBe(false)
  await doctorWorker({ ...dependencies, observedId: state.attempt!.id, startupId: firstObserver === 'cli' ? start : later })
  expect(checks).toBe(4)
  await doctorWorker({ ...dependencies, observedId: state.attempt!.id })
  expect(checks).toBe(4)
  await doctorWorker({ ...dependencies, observedId: state.attempt!.id, startupId: '00000000-0000-4000-8000-000000000003' })
  state = loadDoctorState(environment)
  expect(state.retryUsed).toBe(true); expect(state.cycleStartedAt).toBe(initial.cycleStartedAt)
  expect((await readDoctorView({ environment })).allWell).toBe(true)
  expect(qualifications).toBe(2); expect(checks).toBe(8)
  await doctorWorker({ ...dependencies, observedId: state.attempt!.id, startupId: '00000000-0000-4000-8000-000000000004' })
  expect(checks).toBe(8)
  chmodSync(codex, 0)
  try { await doctorWorker({ ...dependencies, observedId: state.attempt!.id, startupId: '00000000-0000-4000-8000-000000000004' }) }
  finally { chmodSync(codex, 0o700) }
  state = loadDoctorState(environment)
  expect(state.retryUsed).toBe(true)
  await doctorWorker({ ...dependencies, observedId: state.attempt!.id, startupId: '00000000-0000-4000-8000-000000000005' })
  expect(checks).toBe(8); expect(qualifications).toBe(2)
  expect(loadDoctorState(environment).cycleStartedAt).toBe(initial.cycleStartedAt)
  expect((await readDoctorView({ environment })).allWell).toBe(false)
})

it('refuses publication if profile access is lost during an awaited check', async () => {
  const home = fixture(); const codex = fixture()
  const environment = { HOME: home, CODEX_HOME: codex, PATH: '/usr/bin:/bin' }
  try {
    await doctorWorker({ environment, qualify: async () => 'unsupported',
      bmnCheck: async () => { await Promise.resolve(); chmodSync(codex, 0); return { state: 'passed', problems: [] } },
      leftoversCheck: async () => ({ state: 'passed', problems: [], leftovers: [] }) })
  } finally { chmodSync(codex, 0o700) }
  expect((await readDoctorView({ environment })).allWell).toBe(false)
  expect(Object.values(loadDoctorState(environment).results).every((row) => row!.state === 'failed')).toBe(true)
})

const roots: string[] = []
const fixture = (): string => { const path = mkdtempSync(join(tmpdir(), 'bmn-doctor-profile-')); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

it('retains the selected custom profile selectors without credentials or inline config values', () => {
  const environment = { HOME: '/selected/home', CODEX_HOME: '/selected/codex', CLAUDE_CONFIG_DIR: '/selected/claude',
    XDG_CONFIG_HOME: '/selected/config', XDG_DATA_HOME: '/selected/data', OPENCODE_CONFIG_DIR: '/selected/opencode',
    OPENCODE_CONFIG: '/selected/file.json', OPENCODE_CONFIG_CONTENT: 'password', OPENAI_API_KEY: 'password' }
  const result = doctorEnvironment(environment, environment.HOME)
  for (const name of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG']) {
    expect(result[name]).toBe(environment[name as keyof typeof environment])
  }
  expect(result.OPENAI_API_KEY).toBeUndefined()
  expect(result.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  expect(doctorEnvironment({ HOME: '/selected/home' }).CLAUDE_CONFIG_DIR).toBeUndefined()
})

it('does not reuse another selected profile after restart or a joined run, and retains independent qualification', async () => {
  const home = fixture()
  const first = fixture()
  const second = fixture()
  const a = { HOME: home, CODEX_HOME: first, PATH: '/usr/bin:/bin' }
  const b = { ...a, CODEX_HOME: second }
  let qualified = 0
  let checks = 0
  const identity = 'a'.repeat(64)
  const dependencies = {
    versions: async () => ({ identity, apps: Object.fromEntries(['claude', 'codex', 'opencode'].map((app) => [app, { identity, executable: null, version: '1.0.0' }])) as Awaited<ReturnType<typeof doctorVersions>>['apps'] }),
    qualify: async () => { qualified += 1; return 'qualified' as const },
    appCheck: async () => ({ state: 'passed' as const, problems: [] }),
    bmnCheck: async () => { checks += 1; return { state: 'passed' as const, problems: [] } },
    leftoversCheck: async () => ({ state: 'passed' as const, problems: [], leftovers: [] })
  }
  await doctorWorker({ ...dependencies, environment: a })
  const observedId = loadDoctorState(a).attempt!.id
  expect((await readDoctorView({ environment: a })).allWell).toBe(true)
  expect((await readDoctorView({ environment: b })).error).toBe('profile-changed')
  // A caller which observed the older attempt joins, then gets an explicit profile mismatch.
  await doctorWorker({ ...dependencies, environment: b, observedId: null })
  expect(checks).toBe(4)
  expect((await readDoctorView({ environment: b })).allWell).toBe(false)
  await doctorWorker({ ...dependencies, environment: b, observedId })
  expect(checks).toBe(8)
  expect(qualified).toBe(2)
  expect((await readDoctorView({ environment: b })).allWell).toBe(true)
  expect((await readDoctorView({ environment: a })).rows.every((row) => row.stale)).toBe(true)
  const state = JSON.stringify(loadDoctorState(a))
  expect(state).not.toContain(first)
  expect(state).not.toContain(second)
})

it('prints show-only items in the actual text command as well as JSON without their names', async () => {
  const home = fixture()
  const environment = { HOME: home, PATH: '/usr/bin:/bin' }
  const item = join(home, 'password')
  writeFileSync(item, 'synthetic')
  await doctorWorker({ environment, qualify: async () => 'unsupported',
    bmnCheck: async () => ({ state: 'passed', problems: [] }),
    leftoversCheck: async () => ({ state: 'passed', problems: [], leftovers: [{ kind: 'plugins', app: 'claude', reason: 'disabled', item: 1, identity: 'withheld',
      locator: observeFile(item, locationRoots(selectedProfile(environment))).locator }] }) })
  const output: string[] = []
  await runDoctorCommand([], { environment, out: (line) => output.push(line) })
  expect(output.join('\n')).toContain('Show-only: Stale location')
  expect(output.join('\n')).toContain('The plugin is disabled')
  expect(output.join('\n')).not.toContain('password')
})

it('checks broken selected roots under private tmp instead of the healthy defaults', async () => {
  const home = fixture()
  const codex = fixture()
  writeFileSync(join(codex, 'config.toml'), '[mcp_servers.secretword]\ncommand="bmn-missing-selected-program"\n')
  const result = await runLeftoversDoctor(home, { HOME: home, CODEX_HOME: codex, PATH: '/usr/bin:/bin' }, {})
  expect(result.leftovers?.some((row) => row.kind === 'mcp' && row.app === 'codex' && row.reason === 'missing-program')).toBe(true)
  expect(JSON.stringify(result)).not.toContain('secretword')
})

it('refuses an empty explicit home instead of reading the owner cache', async () => {
  expect(() => doctorPaths({ HOME: '' })).toThrow()
  expect((await readDoctorView({ environment: { HOME: '' } })).error).toBe('state-unavailable')
})

it('reports a missing explicit profile as unavailable instead of a successful empty scan', async () => {
  const home = fixture()
  const result = await runLeftoversDoctor(home, { HOME: home, CODEX_HOME: join(home, 'absent'), PATH: '/usr/bin:/bin' }, {})
  expect(result.state).not.toBe('passed')
  expect(result.problems).toEqual([{ code: 'leftover-step', item: 1, count: 1 }])
})

it('refuses a selected whole private temporary root rather than checking an empty replacement', () => {
  const home = fixture()
  expect(() => sandboxArguments(home, process.execPath, ['--version'], { HOME: home, XDG_CACHE_HOME: '/var/tmp' })).toThrow()
})

it('lets OpenCode write its log into a throwaway folder while the selected profile stays read-only', async () => {
  const home = fixture()
  const log = join(home, '.local/share/opencode/log')
  mkdirSync(log, { recursive: true })
  const run = await sandboxProcess(home, '/bin/sh', ['-c', 'echo synthetic > "$1/opencode.log" && ! (echo blocked > "$2/blocked") 2>/dev/null', 'sh', log, home],
    { HOME: home, PATH: '/usr/bin:/bin' })
  expect(run).toMatchObject({ code: 0, failure: null })
  expect(readdirSync(log)).toEqual([])
  expect(existsSync(join(home, 'blocked'))).toBe(false)
})

it('keeps a changed show-only item locatable as stale without creating a check problem or attention', async () => {
  const home = fixture()
  mkdirSync(join(home, 'objects'))
  const item = join(home, 'objects/password')
  writeFileSync(item, 'synthetic')
  const environment = { HOME: home, PATH: '/usr/bin:/bin' }
  const identity = 'b'.repeat(64)
  await doctorWorker({ environment,
    versions: async () => ({ identity, apps: Object.fromEntries(['claude', 'codex', 'opencode'].map((app) => [app, { identity, executable: null, version: '1.0.0' }])) as Awaited<ReturnType<typeof doctorVersions>>['apps'] }),
    qualify: async () => 'qualified', appCheck: async () => ({ state: 'passed', problems: [] }),
    bmnCheck: async () => ({ state: 'passed', problems: [] }),
    leftoversCheck: async () => ({ state: 'passed', problems: [], leftovers: [{ kind: 'plugins', app: 'claude', reason: 'disabled', item: 1, identity: 'withheld', locator: observeFile(item, locationRoots(selectedProfile(environment))).locator }] }) })
  expect((await readDoctorView({ environment })).allWell).toBe(true)
  rmSync(item)
  const view = await readDoctorView({ environment })
  expect(view.rows.find((row) => row.check === 'leftovers')?.leftovers[0]?.locator?.status).toBe('stale')
  expect(view.rows.find((row) => row.check === 'leftovers')?.stale).toBe(false)
  expect(view.allWell).toBe(true)
  expect(view.exitCode).toBe(0)
})

it('retains duplicates after a version changes and gives each withheld item a distinct structural locator', async () => {
  const home = fixture()
  for (const root of ['.claude/skills', '.codex/skills']) {
    mkdirSync(join(home, root, 'password'), { recursive: true })
    writeFileSync(join(home, root, 'password/SKILL.md'), 'same skill body')
  }
  const state = join(home, '.config/bmn/agents/state')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'skills-tests.jsonl'), JSON.stringify({ harness: 'codex', kind: 'capability', version: '1.0.0', outcome: 'pass',
    roots: [{ root: '.claude/skills', folder: true }, { root: '.codex/skills', folder: true }] }) + '\n')
  symlinkSync('missing', join(home, '.claude/skills/ordinary'))
  symlinkSync('missing', join(home, '.claude/skills/sk-SYNTHETIC-abcdef123456'))
  const result = await runLeftoversDoctor(home, { HOME: home, PATH: '/usr/bin:/bin' }, { codex: '2.0.0' })
  const skills = result.leftovers?.filter((row) => row.kind === 'skills') ?? []
  expect(skills.some((row) => row.reason === 'unverified')).toBe(true)
  const broken = skills.filter((row) => row.reason === 'broken-link')
  expect(broken).toHaveLength(2)
  expect(broken[0]).toHaveProperty('locator')
  expect(broken[0]).not.toEqual({ ...broken[1], item: broken[0]!.item })
  expect(JSON.stringify(result)).not.toMatch(/ordinary|SYNTHETIC|abcdef|password/)
})
