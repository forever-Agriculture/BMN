// MODULE: doctor-hooks-contract.test.ts - Actual hooks producer semantics at the Doctor projection boundary
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBmnDoctor } from '../../bin/doctor-results.mjs'
import { OPENCODE_PLUGIN } from '../../bin/bmn-opencode-plugin.mjs'
import { doctorVersions } from '../../bin/doctor-adapters.mjs'
import { doctorWorker, loadDoctorState, readDoctorView } from '../../bin/doctor.mjs'

const REQUIRED = {
  claude: ['Notification', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'],
  codex: ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Interrupt'],
  opencode: ['plugin', 'cli.json']
}
const report = () => ({ ok: true, agents: Object.entries(REQUIRED).map(([agent, events]) => ({ agent, state: 'read',
  events: [...events.map(event => ({ event, optional: false, state: 'wired' })),
    ...(agent === 'codex' ? ['PermissionRequest', 'PostCompact'].map(event => ({ event, optional: true, state: 'missing' })) : [])], missing: [] })) })
const parse = (value: ReturnType<typeof report>, exit = 0) => parseBmnDoctor('hooks', JSON.stringify(value), exit)

describe('Doctor hooks producer contract', () => {
  it('accepts current wiring and the two specifically optional Codex absences', () => {
    expect(parse(report())).toEqual({ state: 'passed', problems: [] })
  })

  it('removes exactly the fourteen false findings in the installed contract', () => {
    const input = report()
    for (const app of input.agents.filter(app => app.agent !== 'opencode')) {
      for (const row of app.events.slice(0, 6)) row.state = 'wired (older wording)'
    }
    expect(parse(input)).toEqual({ state: 'passed', problems: [] })
  })

  it('retains every required missing event and OpenCode’s older plugin finding', () => {
    for (const [app, events] of Object.entries(REQUIRED)) for (const event of events) {
      const input = report(), row = input.agents.find(row => row.agent === app)!.events.find(row => row.event === event)!
      row.state = 'missing'; input.ok = false
      expect(parse(input, 1)).toEqual({ state: 'problems', problems: [{ code: 'hook-check', item: 1, app }] })
    }
    const input = report()
    input.agents[2]!.events[0]!.state = 'wired (older wording)'; input.ok = false
    expect(parse(input, 1)).toEqual({ state: 'problems', problems: [{ code: 'hook-check', item: 1, app: 'opencode' }] })
  })

  it('keeps unknown, malformed, duplicated and incomplete contracts partial without child text', () => {
    const cases = [
      (v: ReturnType<typeof report>) => { v.agents[0]!.events[0]!.state = 'sk-SYNTHETIC-SECRET' },
      (v: ReturnType<typeof report>) => { v.agents[0]!.events[0]!.event = 'sk-SYNTHETIC-SECRET' },
      (v: ReturnType<typeof report>) => { v.agents[0]!.events[0]!.optional = true },
      (v: ReturnType<typeof report>) => { v.agents[1]!.events.at(-1)!.optional = false },
      (v: ReturnType<typeof report>) => { v.agents[0]!.events.pop() },
      (v: ReturnType<typeof report>) => { v.agents[0]!.events.push({ ...v.agents[0]!.events[0]! }) },
      (v: ReturnType<typeof report>) => { v.agents[2] = v.agents[0]! },
      (v: ReturnType<typeof report>) => { v.ok = false }
    ]
    for (const mutate of cases) {
      const value = report(); mutate(value)
      expect(parse(value).state).toBe('partial')
      expect(JSON.stringify(parse(value))).not.toContain('SYNTHETIC')
    }
    expect(parse(report(), 1).state).toBe('partial')
  })

  it('retains known failures before and after malformed JSON app identities without coercion', () => {
    const identities: unknown[] = [null, false, true, 1, [], {}, { toString: null }, 'toString', '__proto__', 'sk-SYNTHETIC-SECRET']
    for (const agent of identities) for (const first of [true, false]) {
      const input = report(); input.ok = false; input.agents[0]!.events[0]!.state = 'missing'
      const malformed = { agent, events: [{ event: 'Stop', optional: false, state: 'missing' }] }
      const agents = first ? [malformed, ...input.agents] : [...input.agents, malformed]
      const output = parseBmnDoctor('hooks', JSON.stringify({ ...input, agents }), 1)
      expect(output.state).toBe('partial')
      expect(output.problems.filter(problem => problem.code === 'hook-check')).toEqual([{ code: 'hook-check', item: 1, app: 'claude' }])
      expect(JSON.stringify(output)).not.toContain('SYNTHETIC')
    }
  })

  it('qualifies older wording and malformed states for each exact producer event', () => {
    for (const [app, events] of Object.entries(REQUIRED)) for (const event of events) {
      for (const state of ['wired', 'missing', 'wired (older wording)', 'sk-SYNTHETIC-SECRET', null, false, 1, {}, []]) {
        const input = report(); const row = input.agents.find(row => row.agent === app)!.events.find(row => row.event === event)!
        const value = { ...input, agents: input.agents.map(agent => ({ ...agent, events: agent.events.map(item => item === row ? { ...item, state } : item) })) }
        const knownFailure = state === 'missing' || state === 'wired (older wording)' && app === 'opencode' && event === 'plugin'
        const knownSuccess = state === 'wired' || state === 'wired (older wording)' && app !== 'opencode'
        const output = parseBmnDoctor('hooks', JSON.stringify(value), knownFailure ? 1 : 0)
        expect(output.state, `${app}/${event}/${JSON.stringify(state)}`).toBe(knownFailure ? 'problems' : knownSuccess ? 'passed' : 'partial')
        expect(output.problems.filter(problem => problem.code === 'hook-check')).toEqual(knownFailure ? [{ code: 'hook-check', item: 1, app }] : [])
        expect(JSON.stringify(output)).not.toContain('SYNTHETIC')
      }
    }
  })

  it('projects the real producer against isolated synthetic files with older hooks and optional absences', () => {
    const home = mkdtempSync(join(tmpdir(), 'bmn-doctor-hooks-contract-'))
    try {
      for (const app of ['claude', 'codex'] as const) {
        const path = join(home, `.${app}`, app === 'claude' ? 'settings.json' : 'hooks.json')
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify({ hooks: Object.fromEntries(REQUIRED[app].map(event => [event,
          [{ hooks: [{ type: 'command', command: `bmn hook ${app}`, timeout: 3600 }] }]])) }))
      }
      const plugin = join(home, '.config/opencode/bmn/tui.ts')
      mkdirSync(dirname(plugin), { recursive: true }); writeFileSync(plugin, OPENCODE_PLUGIN)
      writeFileSync(join(home, '.config/opencode/cli.json'), JSON.stringify({ plugins: [dirname(plugin)] }))
      const cli = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
      const text = execFileSync(process.execPath, [cli, 'hooks', 'check', '--json'], { encoding: 'utf8', timeout: 10000,
        env: { HOME: home, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
          XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache') } })
      const actual = JSON.parse(text)
      expect(actual.ok).toBe(true)
      expect(actual.agents.map((row: { events: unknown[] }) => row.events.length)).toEqual([9, 9, 2])
      expect(parseBmnDoctor('hooks', text, 0)).toEqual({ state: 'passed', problems: [] })
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('invalidates the old parser identity even when all three app programs are missing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bmn-doctor-parser-identity-'))
    try {
      const versions = await doctorVersions({ HOME: home, PATH: join(home, 'empty') })
      expect(Object.values(versions.apps).every(entry => entry.executable === null)).toBe(true)
      const legacy = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(versions.apps).map(([app, entry]) => [app, entry.identity])))).digest('hex')
      expect(versions.identity).not.toBe(legacy)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('replaces persisted false findings through the existing version-change cycle, preserving other failures', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bmn-doctor-hook-cycle-'))
    try {
      let identity = 'a'.repeat(64), clock = Date.now(), legacy = true
      let currentReport: unknown = report()
      const legacyProblems: ReturnType<typeof parseBmnDoctor>['problems'] = Array.from({ length: 14 }, (_, index) => ({ code: 'hook-check', item: index + 1, app: index < 6 ? 'claude' : 'codex' }))
      const dependencies = {
        environment: { HOME: home, PATH: '/usr/bin:/bin' }, now: () => clock,
        versions: async () => ({ identity, apps: Object.fromEntries(['claude', 'codex', 'opencode'].map(app => [app, { executable: null, identity, version: '1.0.0' }])) as Awaited<ReturnType<typeof doctorVersions>>['apps'] }),
        qualify: async () => 'qualified' as const,
        appCheck: async () => ({ state: 'passed' as const, problems: [] }),
        bmnCheck: async (check: string): Promise<ReturnType<typeof parseBmnDoctor>> => check === 'hooks' ? legacy ? { state: 'problems' as const, problems: legacyProblems } : parseBmnDoctor('hooks', JSON.stringify(currentReport), 0)
          : check === 'tools' ? { state: 'problems' as const, problems: [{ code: 'tool-check', item: 1, app: 'codex' }] } : { state: 'passed' as const, problems: [] },
        leftoversCheck: async () => ({ state: 'passed' as const, problems: [], leftovers: [] })
      }
      await doctorWorker(dependencies)
      const before = loadDoctorState(dependencies.environment)
      expect(before.results.hooks!.problems).toHaveLength(14)
      clock += 1000; identity = 'b'.repeat(64); legacy = false
      await doctorWorker({ ...dependencies, observedId: before.attempt!.id })
      const after = loadDoctorState(dependencies.environment)
      expect(after.cycleStartedAt).toBe(clock)
      expect(after.retryUsed).toBe(false)
      expect(after.results.hooks!.problems).toEqual([])
      expect(after.results.tools!.problems).toEqual(before.results.tools!.problems)
      const view = await readDoctorView({ environment: dependencies.environment, now: clock })
      expect(view.rows.flatMap(row => row.problems).some(problem => problem.code === 'hook-check')).toBe(false)
      expect(view.rows.flatMap(row => row.problems).some(problem => problem.code === 'tool-check')).toBe(true)
      const mixed = report(); mixed.ok = false; mixed.agents[0]!.events[0]!.state = 'missing'
      currentReport = { ...mixed, agents: [...mixed.agents, { agent: { toString: null }, events: [{ event: 'Stop', state: 'wired' }] }] }
      clock += 1000; identity = 'c'.repeat(64)
      await doctorWorker({ ...dependencies, observedId: after.attempt!.id })
      const mixedView = await readDoctorView({ environment: dependencies.environment, now: clock })
      expect(mixedView.rows.find(row => row.check === 'hooks')!.state).toBe('partial')
      expect(mixedView.rows.find(row => row.check === 'hooks')!.problems.filter(problem => problem.code === 'hook-check')).toEqual([
        { code: 'hook-check', item: 1, app: 'claude', reason: 'Hook is not wired', fix: 'Review Hooks in Health.' }
      ])
      expect(mixedView.rows.flatMap(row => row.problems).some(problem => problem.code === 'tool-check')).toBe(true)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})
