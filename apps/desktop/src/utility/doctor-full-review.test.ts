// MODULE: doctor-full-review.test.ts - Real sandbox regressions for the full epic review
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { acquireLeftoversDoctor, boundedProcess, doctorVersions } from '../../bin/doctor-adapters.mjs'
import { matchContinuity } from '../../bin/doctor-continuity.mjs'
import { doctorWorker, readDoctorView, runDoctorCommand } from '../../bin/doctor.mjs'

const homes: string[] = [], keys = { item: 'c'.repeat(64), context: 'd'.repeat(64) }
const home = (): string => { const value = mkdtempSync(join(tmpdir(), 'bmn-full-review-')); homes.push(value); return value }
const put = (path: string, body: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body) }
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }) })

it.each(['rowid', '_rowid_', 'oid', 'bmn_rowid'])('refuses generated %s columns before publishing SQLite coordinates', async alias => {
  const root = home(), path = join(root, '.codex/memories_1.sqlite')
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec(`create table stage1_outputs(thread_id text, ${alias} integer generated always as (99) virtual); insert into stage1_outputs(thread_id) values('synthetic')`)
    const result = await acquireLeftoversDoctor(root, { HOME: root, PATH: '/usr/bin:/bin' }, {}, keys)
    expect(result.result.state).toBe('partial'); expect(result.rows).toHaveLength(0)
    expect(result.result.leftovers).toHaveLength(0)
  } finally { db.close() }
})

it('keeps an unreferenced cache through unrelated registry changes and refuses a newly relevant reference', async () => {
  const root = home(), cache = join(root, '.claude/plugins/cache/market/ordinary/1'), registry = join(root, '.claude/plugins/installed_plugins.json')
  put(join(cache, 'body'), 'synthetic cache'); put(registry, '{"plugins":{}}')
  const scan = async () => await acquireLeftoversDoctor(root, { HOME: root, PATH: '/usr/bin:/bin' }, {}, keys)
  const first = await scan(); expect(first.result.state).toBe('passed'); expect(first.rows).toHaveLength(1)
  const unrelated = join(root, '.claude/plugins/cache/market/unrelated/1')
  put(join(unrelated, 'body'), 'other cache')
  put(registry, JSON.stringify({ plugins: { unrelated: [{ installPath: unrelated }] } }))
  const second = await scan(); expect(second.result.state).toBe('passed')
  expect(matchContinuity(first.rows, second.rows)).toEqual([{ item: 1, current: 1 }])
  put(registry, JSON.stringify({ plugins: { unrelated: [{ installPath: unrelated }], ordinary: [{ installPath: cache }] } }))
  expect(matchContinuity(first.rows, (await scan()).rows)).toEqual([{ item: 1, current: null }])
})

it('bounds the final expanded JSON command and explicitly marks omitted inventory', async () => {
  const root = home()
  put(join(root, '.codex/config.toml'), Array.from({ length: 1800 }, (_, i) => `[plugins.p${i}]\nenabled=false\n`).join(''))
  const environment = { HOME: root, PATH: '/usr/bin:/bin' }
  await doctorWorker({ environment, versions: async () => await doctorVersions(environment), bmnCheck: async () => ({ state: 'passed', problems: [] }) })
  let output = ''
  await runDoctorCommand(['--json'], { environment, out: value => { output = value } })
  expect(Buffer.byteLength(output) + 1).toBeLessThanOrEqual(1024 * 1024)
  const view = JSON.parse(output), row = view.rows.find((r: { check: string }) => r.check === 'leftovers')
  expect(row.state).toBe('partial')
  expect(row.problems).toContainEqual(expect.objectContaining({ code: 'leftover-step', count: 1 }))
  expect(view.allWell).toBe(false); expect(view.exitCode).toBe(3)
}, 30000)

it('resolves a saved acquisition from a relocated Health bundle using the installed CLI worker coordinate', async () => {
  const root = home(), environment = { HOME: root, PATH: '/usr/bin:/bin' }
  put(join(root, '.claude/projects/-tmp-synthetic/memory/MEMORY.md'), 'synthetic')
  await doctorWorker({ environment, versions: async () => await doctorVersions(environment), bmnCheck: async () => ({ state: 'passed', problems: [] }) })
  expect((await readDoctorView({ environment })).rows.find(r => r.check === 'leftovers')?.leftovers[0]?.currentLocator?.status).toBe('located')
  const out = join(root, 'relocated-main')
  await build({ configFile: false, logLevel: 'silent', build: { target: 'node24', outDir: out, emptyOutDir: false,
    lib: { entry: fileURLToPath(new URL('../../bin/doctor.mjs', import.meta.url)), formats: ['es'], fileName: () => 'health-reader.mjs' },
    rollupOptions: { external: id => id.startsWith('node:') } } })
  const program = 'import(process.argv[1]).then(m=>m.readDoctorView({environment:process.env,workerPath:process.argv[2]})).then(v=>process.stdout.write(JSON.stringify(v)))'
  const unconfigured = await boundedProcess(process.execPath, ['--input-type=module', '--eval', program, new URL(`file://${out}/health-reader.mjs`).href], { environment })
  expect(unconfigured.code).toBe(0)
  const missing = JSON.parse(unconfigured.stdout)
  expect(missing.error === 'state-unavailable' || missing.rows.find((r: { check: string }) => r.check === 'leftovers').leftovers.every((r: { currentLocator?: { status: string } }) => r.currentLocator?.status !== 'located')).toBe(true)
  const run = await boundedProcess(process.execPath, ['--input-type=module', '--eval', program, new URL(`file://${out}/health-reader.mjs`).href,
    fileURLToPath(new URL('../../bin/doctor-inspection-worker.mjs', import.meta.url))], { environment })
  expect(run.code).toBe(0); expect(run.failure).toBeNull()
  const view = JSON.parse(run.stdout), row = view.rows.find((r: { check: string }) => r.check === 'leftovers')
  expect(view.error).toBeNull()
  expect(row.leftovers).toHaveLength(1); expect(row.leftovers[0].currentLocator?.status).toBe('located')
}, 30000)
