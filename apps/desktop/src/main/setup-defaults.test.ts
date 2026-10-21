// MODULE: setup-defaults.test.ts - Existing-profile exclusion, claim serialization and state-only child results
import { expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FirstRunSetupRecord, SetupAppsSnapshot, SetupDefaultsReport } from '@bmn/protocol'
import { SetupDefaultsCoordinator, parseSetupDefaultsReport, runSetupDefaults, setupDefaultsEnvironment } from './setup-defaults'

const snapshot: SetupAppsSnapshot = { platform: 'linux', checkedAt: '2026-10-20T22:00:00.000Z', curlAvailable: true, apps: [
  { app: 'codex', program: '/synthetic/codex', onPath: true, version: '0.163.0', signIn: 'ready', method: 'chatgpt', qualification: 'measured' },
  { app: 'claude', program: '/synthetic/claude', onPath: true, version: '2.1.303', signIn: 'signed-out', method: null, qualification: 'measured' },
  { app: 'opencode', program: '/synthetic/opencode', onPath: true, version: '2.0.32', signIn: 'confirmed', method: null, qualification: 'failed' }
] }
const report = (code = 'OK'): SetupDefaultsReport => ({ code, source: '/synthetic/bmn/agents/skills', names: ['plan'], rows: [] })
function fixture(state: FirstRunSetupRecord['state'] = 'active') {
  let claims = 0
  const seams = {
    profile: vi.fn(async (): Promise<FirstRunSetupRecord> => ({ state, workspaceId: 'synthetic-workspace', revision: 1, updatedAt: snapshot.checkedAt })),
    claim: vi.fn(async () => ({ setupId: 'synthetic-claim', initialize: claims++ === 0 })),
    apps: vi.fn(async () => structuredClone(snapshot)), run: vi.fn<(request: unknown) => Promise<SetupDefaultsReport>>(async () => report())
  }
  return { seams, coordinator: new SetupDefaultsCoordinator(seams) }
}

it('leaves existing profiles completely outside setup claims, status reads and child writes', async () => {
  const f = fixture('existing')
  expect((await f.coordinator.prepare()).code).toBe('EXISTING_PROFILE')
  expect((await f.coordinator.refresh()).code).toBe('EXISTING_PROFILE')
  expect(f.seams.claim).not.toHaveBeenCalled(); expect(f.seams.apps).not.toHaveBeenCalled(); expect(f.seams.run).not.toHaveBeenCalled()
})

it('coalesces simultaneous startup/approval/Health reads into one durable claim and apply', async () => {
  const f = fixture()
  let finish!: () => void
  const barrier = new Promise<void>(resolve => { finish = resolve })
  f.seams.run.mockImplementationOnce(async () => { await barrier; return report() })
  const one = f.coordinator.refresh(), two = f.coordinator.refresh(snapshot)
  expect(one).toBe(two); finish(); await Promise.all([one, two])
  expect(f.seams.claim).toHaveBeenCalledOnce()
  expect(f.seams.run.mock.calls.map(([request]) => request)).toEqual([
    { mode: 'prepare', claim: { setupId: 'synthetic-claim', initialize: true }, ready: [] },
    { mode: 'apply', claim: { setupId: 'synthetic-claim', initialize: false }, ready: [{ app: 'codex', version: '0.163.0' }, { app: 'opencode', version: '2.0.32' }] }
  ])
})

it('serializes preparing a draft before applying, consuming first creation authority only once', async () => {
  const f = fixture()
  await Promise.all([f.coordinator.prepare(), f.coordinator.refresh()])
  expect(f.seams.run.mock.calls.map(([request]) => (request as { claim: { initialize: boolean } }).claim.initialize)).toEqual([true, false, false])
})

it('does not apply or silently reinitialize when a previously claimed journal is missing or corrupt', async () => {
  const f = fixture(); await f.coordinator.prepare()
  f.seams.run.mockResolvedValueOnce(report('DEFAULTS_STATE_UNAVAILABLE'))
  const result = await f.coordinator.refresh()
  expect(result.code).toBe('DEFAULTS_STATE_UNAVAILABLE'); expect(f.seams.run).toHaveBeenCalledTimes(2)
  expect(f.seams.run.mock.calls[1]?.[0]).toMatchObject({ mode: 'prepare', claim: { initialize: false } })
})

it('uses a supplied later-read readiness snapshot and never includes signed-out or missing-version apps', async () => {
  const f = fixture('finished'), apps = structuredClone(snapshot)
  apps.apps[0]!.version = null
  await f.coordinator.refresh(apps)
  expect(f.seams.apps).not.toHaveBeenCalled()
  expect(f.seams.run.mock.calls[1]?.[0]).toMatchObject({ mode: 'apply', ready: [{ app: 'opencode', version: '2.0.32' }] })
})

it('projects failure to fixed state and starts no child for an unsupported platform', async () => {
  const f = fixture(); f.seams.apps.mockResolvedValueOnce({ ...snapshot, platform: 'darwin' })
  expect((await f.coordinator.refresh()).code).toBe('UNSUPPORTED_PLATFORM'); expect(f.seams.claim).not.toHaveBeenCalled()
  f.seams.claim.mockRejectedValueOnce(new Error('synthetic-secret-canary'))
  expect(JSON.stringify(await f.coordinator.refresh())).not.toContain('synthetic-secret-canary')
})

it('passes profile roots and routing selectors without credential values to the child', () => {
  expect(setupDefaultsEnvironment({ HOME: '/synthetic', PATH: '/usr/bin', OPENAI_API_KEY: 'synthetic-secret',
    OPENCODE_CONFIG_CONTENT: '{"apiKey":"synthetic-secret"}', BMN_CONTROL_TOKEN: 'synthetic-secret' })).toEqual({
    HOME: '/synthetic', PATH: '/usr/bin', OPENCODE_CONFIG_CONTENT: 'set', ELECTRON_RUN_AS_NODE: '1'
  })
})

it('accepts only the fixed report vocabulary and rejects additional raw fields at either depth', () => {
  const value: SetupDefaultsReport = { ...report(), rows: [{ kind: 'hooks', app: 'codex', code: 'OK', state: 'installed',
    transaction: 'synthetic-transaction', paths: ['/synthetic/hooks.json'], recoveryPaths: ['/synthetic/.holding'] }] }
  expect(parseSetupDefaultsReport(value)).toEqual(value)
  for (const bad of [{ ...value, raw: 'synthetic-secret-canary' },
    { ...value, rows: [{ ...value.rows[0], raw: 'synthetic-secret-canary' }] },
    { ...value, rows: [{ ...value.rows[0], recoveryPaths: ['relative-path'] }] }]) expect(parseSetupDefaultsReport(bad)).toBeNull()
})

it('runs the actual defaults child with isolated roots and no approval assets or credential output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-setup-child-'))
  try {
    const shipped = join(root, 'shipped'); mkdirSync(shipped); writeFileSync(join(shipped, 'manifest.json'), '{"skills":[]}')
    const script = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
    const claim = { setupId: 'synthetic-child-79', initialize: true }
    const result = await runSetupDefaults(script, { mode: 'prepare', claim, ready: [] }, {
      HOME: root, PATH: '/usr/bin:/bin', BMN_SHIPPED_SKILLS: shipped, OPENAI_API_KEY: 'synthetic-secret-canary'
    })
    expect(result).toEqual({ code: 'OK', source: join(root, '.config/bmn/agents/skills'), names: [], rows: [] })
    expect(existsSync(join(root, '.config/bmn/agents/global-rules.md'))).toBe(false)
    expect(readFileSync(join(root, '.config/bmn/agents/state/setup-defaults.json'), 'utf8')).not.toContain('synthetic-secret-canary')
    const unapproved = await runSetupDefaults(script, { mode: 'apply', claim: { ...claim, initialize: false }, ready: [] }, {
      HOME: root, PATH: '/usr/bin:/bin', BMN_SHIPPED_SKILLS: shipped
    })
    expect(unapproved.code).toBe('NOT_APPROVED')
    const coordinator = new SetupDefaultsCoordinator({
      profile: async () => ({ state: 'active', revision: 1, updatedAt: snapshot.checkedAt, workspaceId: null }),
      claim: async () => ({ ...claim, initialize: false }), apps: async () => snapshot,
      run: request => runSetupDefaults(script, request, { HOME: root, PATH: '/usr/bin:/bin', BMN_SHIPPED_SKILLS: shipped })
    })
    const waiting = await coordinator.refresh()
    expect(waiting).toEqual({ ...result, code: 'NOT_APPROVED' })
    expect(existsSync(join(root, '.config/bmn/agents/global-rules.md'))).toBe(false)
    expect(existsSync(join(root, '.config/bmn/agents/roster.md'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('rejects extra raw fields from a child instead of relaying them into UI state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-setup-child-contract-'))
  try {
    const script = join(root, 'synthetic-child.mjs')
    writeFileSync(script, `process.stdout.write(JSON.stringify(${JSON.stringify({ ...report(), raw: 'synthetic-secret-canary' })}))`)
    const result = await runSetupDefaults(script, { mode: 'prepare', claim: { setupId: 'synthetic-child', initialize: false }, ready: [] }, { HOME: root })
    expect(result.code).toBe('DEFAULTS_STATE_UNAVAILABLE'); expect(JSON.stringify(result)).not.toContain('synthetic-secret-canary')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
