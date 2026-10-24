// MODULE: doctor-continuity-pipeline.test.ts - Actual worker→private state→fresh-process reader and tamper/privacy controls
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { boundedProcess } from '../../bin/doctor-adapters.mjs'
import type { DoctorVersions } from '../../bin/doctor-adapters.mjs'
import { doctorPaths, doctorWorker, loadDoctorState } from '../../bin/doctor.mjs'
import type { DoctorView } from '../../../../shared/protocol/src/doctor'

const roots: string[] = []
const fixture = (): string => { const home = mkdtempSync(join(tmpdir(), 'bmn-continuity-pipeline-')); roots.push(home); return home }
afterEach(() => { for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true }) })
const put = (path: string, body: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body) }
const versions = async (): Promise<DoctorVersions> => ({ identity: 'a'.repeat(64), apps: Object.fromEntries(['claude', 'codex', 'opencode'].map(app => [app, { executable: null, version: null, identity: 'b'.repeat(64) }])) as DoctorVersions['apps'] })
const freshView = async (environment: NodeJS.ProcessEnv): Promise<DoctorView> => {
  const program = 'import(process.argv[1]).then(m=>m.readDoctorView({environment:process.env})).then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>{process.exitCode=1})'
  const run = await boundedProcess(process.execPath, ['--input-type=module', '--eval', program, new URL('../../bin/doctor.mjs', import.meta.url).href], { environment, timeoutMs: 15000 })
  expect(run.failure).toBeNull(); expect(run.code).toBe(0)
  return JSON.parse(run.stdout)
}

it('persists original private receipts once, resolves after sibling activity in a fresh process, and never publishes keys or item tags', async () => {
  const home = fixture(), environment = { HOME: home, PATH: '/usr/bin:/bin' }
  const memory = join(home, '.claude/projects/-tmp-password/memory')
  put(join(memory, 'MEMORY.md'), 'sk-SYNTHETIC-private-memory-1234567890')
  await doctorWorker({ environment, versions, qualify: async () => 'unsupported', bmnCheck: async () => ({ state: 'passed', problems: [] }) })
  const before = readFileSync(doctorPaths(environment).state, 'utf8'), saved = loadDoctorState(environment)
  expect(saved.continuity?.rows).toHaveLength(1)
  const original = saved.results.leftovers?.leftovers?.[0]?.locator
  let view = await freshView(environment)
  const row = view.rows.find(r => r.check === 'leftovers')!
  expect(row.state).toBe('passed'); expect(row.leftovers[0]?.locator?.status).toBe('located'); expect(row.leftovers[0]?.currentLocator?.status).toBe('located')
  put(join(memory, '../000-sibling'), 'unrelated activity')
  view = await freshView(environment)
  const current = view.rows.find(r => r.check === 'leftovers')!.leftovers[0]!
  expect(current.locator).toEqual(original); expect(current.currentLocator?.status).toBe('located')
  expect(readFileSync(doctorPaths(environment).state, 'utf8') === before).toBe(true)
  const published = JSON.stringify(view)
  for (const withheld of [home, 'password', 'SYNTHETIC', saved.profileKey!, saved.continuity!.rows[0]!.itemTag, saved.continuity!.rows[0]!.contextTag]) expect(published.includes(withheld)).toBe(false)
  expect(before.includes('SYNTHETIC')).toBe(false)
  writeFileSync(join(memory, 'MEMORY.md'), 'changed after scan')
  expect((await freshView(environment)).rows.find(r => r.check === 'leftovers')!.leftovers[0]!.locator?.status).toBe('stale')
}, 30000)

it('refuses missing, tampered and replayed receipts, unsafe state, and cross-profile resolution', async () => {
  const home = fixture(), environment = { HOME: home, PATH: '/usr/bin:/bin' }
  put(join(home, '.codex/config.toml'), '[mcp_servers.synthetic]\ncommand="bmn-not-present"\n')
  await doctorWorker({ environment, versions, qualify: async () => 'unsupported', bmnCheck: async () => ({ state: 'passed', problems: [] }) })
  const path = doctorPaths(environment).state, original = readFileSync(path, 'utf8')
  const noReceipt = JSON.parse(original); noReceipt.continuity = null; writeFileSync(path, JSON.stringify(noReceipt))
  expect((await freshView(environment)).rows.find(r => r.check === 'leftovers')?.leftovers[0]?.locator?.status).toBe('stale')
  const tampered = JSON.parse(original); tampered.continuity.rows[0].contextTag = 'f'.repeat(64); writeFileSync(path, JSON.stringify(tampered))
  expect((await freshView(environment)).error).toBe('state-unavailable')
  const replay = JSON.parse(original); replay.results.leftovers.acquisitionId = '00000000-0000-0000-0000-000000000000'; writeFileSync(path, JSON.stringify(replay))
  expect((await freshView(environment)).error).toBe('state-unavailable')
  writeFileSync(path, original); chmodSync(path, 0o644)
  expect((await freshView(environment)).error).toBe('state-unavailable')
  chmodSync(path, 0o600)
  chmodSync(doctorPaths(environment).directory, 0o755)
  expect((await freshView(environment)).error).toBe('state-unavailable')
  chmodSync(doctorPaths(environment).directory, 0o700)
  const other = fixture(); mkdirSync(join(other, 'codex'))
  const redirected = await freshView({ ...environment, CODEX_HOME: join(other, 'codex') })
  expect(redirected.error).toBe('profile-changed')
  expect(redirected.rows.find(r => r.check === 'leftovers')?.leftovers[0]?.locator?.status).toBe('stale')
}, 30000)

it('counts the authenticated receipts within the whole private-state bound and publishes an explicit coverage gap', async () => {
  const home = fixture(), environment = { HOME: home, PATH: '/usr/bin:/bin' }
  const leftovers = Array.from({ length: 4000 }, (_, i) => ({ kind: 'memory' as const, app: 'claude' as const,
    reason: 'missing-project' as const, item: i + 1, identity: 'withheld' as const, locator: { status: 'unresolved' as const } }))
  const rows = leftovers.map(row => ({ item: row.item, itemTag: 'a'.repeat(64), contextTag: 'b'.repeat(64) }))
  expect(Buffer.byteLength(JSON.stringify(leftovers))).toBeLessThan(896 * 1024)
  await doctorWorker({ environment, versions, qualify: async () => 'unsupported', bmnCheck: async () => ({ state: 'passed', problems: [] }),
    leftoversCheck: async () => ({ result: { state: 'partial', problems: [{ code: 'leftover-step', item: 1, count: 2 },
      { code: 'leftover-unreadable', item: 2, count: 3 }], leftovers }, rows }) })
  const saved = loadDoctorState(environment), text = readFileSync(doctorPaths(environment).state, 'utf8')
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024)
  expect(saved.continuity?.rows).toEqual([])
  expect(saved.results.leftovers?.state).toBe('partial')
  expect(saved.results.leftovers?.problems).toEqual([{ code: 'leftover-unreadable', item: 1, count: 3 }, { code: 'leftover-step', item: 2, count: 3 }])
})
