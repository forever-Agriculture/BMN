// MODULE: doctor-recovery-round.test.ts - Tiny physical-input and final-inventory controls for the bounded recovery round
import { DatabaseSync } from 'node:sqlite'
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({ hook: null as null | ((path: string) => void), descriptors: new Map<number, string>() }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    const descriptor = fs.openSync(...args); seam.descriptors.set(descriptor, String(args[0])); return descriptor
  }, readSync: (...args: Parameters<typeof fs.readSync>) => {
    const count = fs.readSync(...args); seam.hook?.(seam.descriptors.get(args[0]) ?? ''); return count
  } }
})

const moduleRoot = fileURLToPath(new URL(process.env.BMN_TEST_DOCTOR_BASELINE ?? '../../bin/', import.meta.url))
const modules = async () => ({
  scanner: await import(`${moduleRoot}/doctor-leftovers.mjs`),
  session: await import(`${moduleRoot}/doctor-inspection.mjs`),
  profile: await import(`${moduleRoot}/doctor-profile.mjs`)
})
const keys = { item: 'a'.repeat(64), context: 'b'.repeat(64) }
let home: string
const databases: DatabaseSync[] = []
const put = (path: string, body: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body) }
beforeEach(() => {
  vi.resetModules(); home = mkdtempSync(join(tmpdir(), 'bmn-recovery-round-'))
  vi.stubEnv('HOME', home); vi.stubEnv('PATH', '/usr/bin:/bin')
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) vi.stubEnv(key, undefined)
  seam.hook = null; seam.descriptors.clear()
})
afterEach(() => {
  seam.hook = null; vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const db of databases.splice(0)) db.close()
  rmSync(home, { recursive: true, force: true })
})

it('recovery round: separates a fully checked hard-linked item from incomplete reason coverage', async () => {
  const path = join(home, '.codex/config.toml')
  put(path, '[mcp_servers.ordinary]\ncommand="bmn-missing-synthetic"\n'); linkSync(path, join(home, 'alias'))
  const { scanner } = await modules()
  const pair = await scanner.inspectLeftovers({}, { keys, privateReceipts: true })
  expect(pair.result.state).toBe('passed'); expect(pair.result.problems).toEqual([])
  expect(pair.result.leftovers).toHaveLength(1); expect(pair.result.leftovers[0].locator.status).toBe('unresolved')
  expect(pair.rows).toEqual([])
  put(path, '[mcp_servers.ordinary]\ncommand = [invalid\n')
  expect((await scanner.inspectLeftovers()).state).toBe('partial')
})

it('recovery round: adopts a whole configuration recovered after a during-read reorder and keeps the changed-input count', async () => {
  const path = join(home, '.codex/config.toml')
  const before = '[plugins.first]\nenabled=false\n[plugins.other]\nenabled=false\n'
  put(path, before)
  let changed = false, reads = 0
  seam.hook = target => {
    if (target !== path) return
    reads += 1
    if (!changed) { changed = true; put(path, before.replaceAll('first', 'TEMPX').replaceAll('other', 'first').replaceAll('TEMPX', 'other')) }
  }
  const { scanner } = await modules()
  const pair = await scanner.inspectLeftovers({}, { keys, privateReceipts: true })
  expect(reads).toBe(2); expect(pair.result.state).toBe('partial')
  expect(pair.result.problems).toEqual([{ code: 'leftover-source-changed', item: 1, count: 1 }])
  expect(pair.result.leftovers).toHaveLength(2); expect(pair.rows).toHaveLength(2)
  expect(pair.result.leftovers.every((row: { locator: { status: string } }) => row.locator.status === 'located')).toBe(true)
  expect(JSON.stringify(pair)).not.toMatch(/first|other|TEMPX|config.toml/)
})

it('recovery round: shares one recovery budget for a physical WAL acquisition race and publishes recovered SQLite rows', async () => {
  const paths = ['memories_1.sqlite', 'state_5.sqlite'].map(name => join(home, '.codex', name))
  mkdirSync(join(home, '.codex'))
  const memory = new DatabaseSync(paths[0]!); databases.push(memory)
  memory.exec("pragma journal_mode=WAL; pragma wal_autocheckpoint=0; create table stage1_outputs(thread_id text, body text); insert into stage1_outputs values('synthetic','private body')")
  const state = new DatabaseSync(paths[1]!); databases.push(state); state.exec('create table threads(id text,cwd text)')
  let changed = false, passes = 0
  seam.hook = target => { if (!changed && target === paths[0]) { changed = true; memory.exec("insert into stage1_outputs values('second','second private body')") } }
  const { scanner, session, profile } = await modules()
  const scan = async (_versions: unknown, suppliedKeys: typeof keys, deadline: number) => {
    passes += 1
    const s = session.createInspectionSession(profile.selectedProfile(process.env), suppliedKeys, deadline)
    const source = s.databases(paths)
    if (source.known) for (const row of memory.prepare('select rowid,* from stage1_outputs').all()) {
      s.row('memory', 'codex', 'unused-memory', source, row, [s.dep(source, ['synthetic schema', row])], { rowid: Number(row.rowid) })
    }
    return s.finish()
  }
  const pair = await scanner.inspectLeftovers({}, { keys, privateReceipts: true, scan })
  expect(changed).toBe(true); expect(passes).toBe(2)
  expect(pair.result.state).toBe('partial'); expect(pair.result.problems).toEqual([{ code: 'leftover-source-changed', item: 1, count: 1 }])
  expect(pair.result.leftovers).toHaveLength(2); expect(pair.rows).toHaveLength(2)
  expect(JSON.stringify(pair)).not.toMatch(/private body|memories_1|synthetic|second/)
})

it('recovery round: persistent acquisition churn stops after two observations and counts the input once', async () => {
  const path = join(home, '.codex/config.toml')
  const bodies = ['[plugins.first]\nenabled=false\n', '[plugins.other]\nenabled=false\n']
  put(path, bodies[0]!)
  let reads = 0
  seam.hook = target => { if (target === path) { reads += 1; put(path, bodies[reads % 2]!) } }
  const { scanner } = await modules()
  const pair = await scanner.inspectLeftovers({}, { keys, privateReceipts: true })
  expect(reads).toBe(2); expect(pair.result.state).toBe('partial'); expect(pair.rows).toEqual([])
  expect(pair.result.problems).toEqual([{ code: 'leftover-source-changed', item: 1, count: 1 }])
})

it('recovery round: preserves first-pass facts and withholds uncertified locations if recovery exhausts its deadline', async () => {
  const path = join(home, '.codex/config.toml'); put(path, 'first')
  const { scanner, session, profile } = await modules()
  let passes = 0
  const scan = async (_versions: unknown, suppliedKeys: typeof keys, deadline: number) => {
    if (++passes === 2) throw Object.assign(new Error('synthetic deadline'), { code: 'TIME_BOUND' })
    const s = session.createInspectionSession(profile.selectedProfile(process.env), suppliedKeys, deadline)
    const source = s.file(path); s.row('mcp', 'codex', 'missing-program', source, ['synthetic'], [])
    put(path, 'other'); return s.finish()
  }
  const pair = await scanner.inspectLeftovers({}, { keys, privateReceipts: true, scan })
  expect(passes).toBe(2); expect(pair.result.state).toBe('partial')
  expect(pair.result.problems).toEqual([{ code: 'leftover-step', item: 1, count: 1 }, { code: 'leftover-source-changed', item: 2, count: 1 }])
  expect(pair.result.leftovers).toHaveLength(1); expect(pair.result.leftovers[0].locator.status).toBe('unresolved'); expect(pair.rows).toEqual([])
})

it('recovery round: finish itself keeps inventory when its stability deadline expires', async () => {
  const path = join(home, '.codex/config.toml'); put(path, 'synthetic')
  const { session, profile } = await modules()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10)
  const s = session.createInspectionSession(profile.selectedProfile(process.env), keys, 20)
  const source = s.file(path); s.row('mcp', 'codex', 'missing-program', source, ['synthetic'], [])
  clock.mockReturnValue(21)
  const result = s.finish()
  expect(result.rows).toHaveLength(1); expect(result.rows[0].value.locator.status).toBe('unresolved')
  expect(session.inspectionResult(result.rows, result.gaps)).toMatchObject({ state: 'partial', problems: [{ code: 'leftover-step', count: 1 }] })
})

it('recovery round: missing reason witnesses cannot use the location-only exception', async () => {
  const path = join(home, '.codex/config.toml'); put(path, 'synthetic')
  const { session, profile } = await modules()
  const s = session.createInspectionSession(profile.selectedProfile(process.env), keys, Date.now() + 10000)
  const source = s.file(path); s.row('mcp', 'codex', 'unverified', source, ['synthetic'], [s.dep(null, undefined)])
  const result = s.finish()
  expect(result.rows[0].receipt).toBeNull()
  expect(result.rows[0].reasonTag ?? null).toBeNull()
  expect(session.inspectionResult(result.rows, result.gaps)).toMatchObject({ state: 'partial', problems: [{ code: 'leftover-step', count: 1 }] })
})

it('post-review recovery: retains provisional bound inventory when recovery lacks a reason witness', async () => {
  const path = join(home, '.codex/config.toml'), cache = join(home, '.codex/plugins/cache/m/p/v')
  const { OBSERVATION_LIMITS } = await import(`${moduleRoot}/doctor-locations.mjs`)
  mkdirSync(cache, { recursive: true })
  for (let i = 0; i <= OBSERVATION_LIMITS.entries; i += 1) writeFileSync(join(cache, `entry-${i}`), '')
  put(path, 'first')
  let reads = 0, passes = 0
  seam.hook = target => { if (target === path && ++reads === 1) put(path, 'recovered') }
  const { scanner, session, profile } = await modules()
  const known: boolean[] = []
  const scan = async (_versions: unknown, suppliedKeys: typeof keys, deadline: number) => {
    passes += 1
    const s = session.createInspectionSession(profile.selectedProfile(process.env), suppliedKeys, deadline)
    const config = s.file(path), source = s.tree(cache, { locationOnly: true })
    known.push(config.known)
    const deps = [s.dep(config, ['membership', false])]
    if (passes === 2) deps.push(s.dep(null, undefined))
    s.row('plugins', 'codex', 'app-managed', source, ['synthetic cache'], deps)
    return s.finish()
  }
  const pair = await scanner.inspectLeftovers({}, { keys, privateReceipts: true, scan })
  expect(passes).toBe(2); expect(reads).toBe(2); expect(known).toEqual([false, true])
  expect(pair.result.state).toBe('partial'); expect(pair.result.leftovers).toHaveLength(1)
  expect(pair.result.leftovers[0].locator.status).toBe('unresolved'); expect(pair.rows).toEqual([])
})
