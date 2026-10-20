// MODULE: doctor-acquisition.test.ts - Deterministic mutations at the actual scanner filesystem boundaries
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({ hook: null as null | ((operation: string, path: unknown) => void), descriptors: new Map<number, string>() }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const wrapped: Record<string, unknown> = { ...fs }
  for (const name of ['openSync', 'readFileSync', 'readSync', 'copyFileSync', 'readdirSync', 'readlinkSync'] as const) {
    wrapped[name] = (...args: unknown[]) => {
      const result = Reflect.apply(fs[name], fs, args)
      if (name === 'openSync') seam.descriptors.set(result as number, String(args[0]))
      seam.hook?.(name, typeof args[0] === 'number' ? seam.descriptors.get(args[0]) : args[0])
      return result
    }
  }
  return wrapped
})

const roots: string[] = []
const databases: DatabaseSync[] = []
const put = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
let home: string
beforeEach(() => {
  vi.resetModules()
  home = mkdtempSync(join(tmpdir(), 'bmn-doctor-acquisition-')); roots.push(home)
  vi.stubEnv('HOME', home); vi.stubEnv('PATH', '/usr/bin:/bin')
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) vi.stubEnv(key, undefined)
  seam.hook = null; seam.descriptors.clear()
})
afterEach(() => {
  seam.hook = null
  for (const db of databases.splice(0)) db.close()
  vi.unstubAllEnvs()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
function mutateOnce(path: string, operation: string[], change: () => void): () => boolean {
  let fired = false
  seam.hook = (name, target) => { if (!fired && target === path && operation.includes(name)) { fired = true; change() } }
  return () => fired
}
async function scan() { return (await import('../../bin/doctor-leftovers.mjs')).inspectLeftovers({}) }
async function resolvers() {
  const locations = await import('../../bin/doctor-locations.mjs')
  const { selectedProfile } = await import('../../bin/doctor-profile.mjs')
  const map = locations.locationRoots(selectedProfile(process.env))
  return { ...locations, map }
}

for (const kind of ['json', 'toml', 'mcp'] as const) it(`refuses ${kind} coordinates acquired across a same-size reorder`, async () => {
  const path = join(home, kind === 'json' ? '.config/opencode/opencode.json' : '.codex/config.toml')
  const before = kind === 'json' ? '{"plugin":["./ordinary","./password"]}'
    : kind === 'toml' ? '[plugins.ordinary]\nenabled=false\n[plugins.password]\nenabled=false\n'
      : '[mcp_servers.ordinary]\ncommand="missing-a"\n[mcp_servers.password]\ncommand="missing-b"\n'
  const after = before.replaceAll('ordinary', 'TEMPWORD').replaceAll('password', 'ordinary').replaceAll('TEMPWORD', 'password')
  put(path, before)
  const fired = mutateOnce(path, ['readFileSync', 'readSync'], () => put(path, after))
  const result = await scan()
  expect(fired()).toBe(true)
  expect(result.state).toBe('partial')
  expect(result.leftovers?.every((row) => row.locator?.status !== 'located')).toBe(true)
  expect(JSON.stringify(result)).not.toMatch(/ordinary|password|missing-a|missing-b/)
})

it('acquires a nested registry exactly once for all arrays and plugin MCP scopes', async () => {
  const path = join(home, '.claude/plugins/installed_plugins.json')
  put(path, '{"plugins":{"ordinary":[{"installPath":"/missing-a"},{"installPath":"/missing-b"}]}}')
  let reads = 0
  seam.hook = (operation, target) => { if (target === path && ['readFileSync', 'readSync'].includes(operation)) reads += 1 }
  const result = await scan()
  expect(result.leftovers).toHaveLength(2)
  expect(reads).toBe(1)
})

it('invalidates child-content witnesses even when the containing directory is unchanged', async () => {
  const first = join(home, '.claude/skills/ordinary/SKILL.md')
  put(first, 'same body'); put(join(home, '.codex/skills/ordinary/SKILL.md'), 'same body')
  const fired = mutateOnce(first, ['readFileSync', 'readSync'], () => put(first, 'otherbody'))
  const result = await scan()
  expect(fired()).toBe(true)
  expect(result.state).toBe('partial')
  const { resolveLocation, map } = await resolvers()
  expect(result.leftovers?.every((row) => resolveLocation(row.locator, map) !== join(home, '.claude/skills/ordinary'))).toBe(true)
})

it('does not bind an observed broken link to its replacement', async () => {
  const path = join(home, '.claude/skills/ordinary')
  mkdirSync(join(path, '..'), { recursive: true }); symlinkSync('missing-a', path)
  const fired = mutateOnce(path, ['readlinkSync'], () => { rmSync(path); symlinkSync('missing-b', path) })
  const result = await scan()
  expect(fired()).toBe(true)
  expect(result.state).toBe('partial')
  expect(result.leftovers?.every((row) => row.locator?.status !== 'located')).toBe(true)
})

it('brackets directory-entry enumeration during acquisition and resolution', async () => {
  const path = join(home, 'ordinary'); put(path, 'bytes'); put(join(home, 'zzz'), 'bytes')
  const { locateItem, resolveLocation, map } = await resolvers()
  let fired = mutateOnce(home, ['readdirSync'], () => renameSync(join(home, 'zzz'), join(home, 'aaa')))
  const acquired = locateItem(path, map)
  expect(fired()).toBe(true)
  expect(acquired.status).not.toBe('located')
  seam.hook = null
  const stable = locateItem(path, map)
  expect(resolveLocation(stable, map)).toBe(path)
  fired = mutateOnce(home, ['readdirSync'], () => renameSync(join(home, 'aaa'), join(home, 'zzz')))
  expect(resolveLocation(stable, map)).toBeNull()
  expect(fired()).toBe(true)
})

for (const mutation of ['rowid', 'wal-create', 'state'] as const) it(`rejects a SQLite source vector changed during copying: ${mutation}`, async () => {
  const path = join(home, '.codex/memories_1.sqlite')
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path); databases.push(db)
  db.exec("create table stage1_outputs(thread_id text, usage_count integer, selected_for_phase2 integer); insert into stage1_outputs values ('ordinary',0,0),('password',0,0)")
  const state = new DatabaseSync(join(home, '.codex/state_5.sqlite')); databases.push(state)
  state.exec("create table threads(id text,cwd text); insert into threads values ('ordinary','/missing-a'),('password','/missing-b')")
  const fired = mutateOnce(path, ['copyFileSync', 'readFileSync', 'readSync'], () => {
    if (mutation === 'wal-create') db.exec("pragma journal_mode=WAL; update stage1_outputs set thread_id='changed'")
    else if (mutation === 'state') state.exec("update threads set cwd='/different'")
    else db.exec("delete from stage1_outputs; insert into stage1_outputs values ('password',0,0),('ordinary',0,0)")
  })
  const result = await scan()
  expect(fired()).toBe(true)
  expect(result.state).toBe('partial')
  expect(result.leftovers?.every((row) => row.locator?.status !== 'located')).toBe(true)
})

it('revalidates an earlier configuration observation before publishing the scan', async () => {
  const path = join(home, '.config/opencode/opencode.json')
  put(path, '{"plugin":["./ordinary","./password"]}')
  const later = join(home, '.claude.json'); put(later, '{}')
  const fired = mutateOnce(later, ['readFileSync', 'readSync'], () => put(path, '{"plugin":["./password","./ordinary"]}'))
  const result = await scan()
  const { resolveLocation, map } = await resolvers()
  expect(fired()).toBe(true)
  expect(result.state).toBe('partial')
  expect(result.leftovers?.filter((row) => row.app === 'opencode').every((row) => resolveLocation(row.locator, map) === null)).toBe(true)
})

it('retains unchanged, individually resolvable controls with no disclosed names', async () => {
  const path = join(home, '.config/opencode/opencode.json')
  put(path, '{"plugin":["./ordinary","./password"]}')
  const result = await scan()
  const { resolveLocation, map } = await resolvers()
  expect(result.state).toBe('passed')
  expect(result.leftovers).toHaveLength(2)
  expect(result.leftovers?.map((row) => resolveLocation(row.locator, map))).toEqual([path, path])
  expect(result.leftovers?.[0]?.locator).not.toEqual(result.leftovers?.[1]?.locator)
  expect(JSON.stringify(result)).not.toMatch(/ordinary|password/)
})

it('checks followed configuration targets after acquisition and keeps link identity', async () => {
  const target = join(home, 'target.json'); const path = join(home, 'config.json')
  const text = '{"plugin":["./ordinary","./password"]}'
  put(target, text); symlinkSync('target.json', path)
  const { locateItem, resolveLocation, map } = await resolvers()
  const location = locateItem(path, map, { text, start: text.indexOf('"./ordinary"') })
  expect(resolveLocation(location, map)).toBe(path)
  put(target, '{"plugin":["./password","./ordinary"]}')
  expect(resolveLocation(location, map)).toBeNull()
})

it('resolves a selected symlink profile and refuses changes in its real parent enumeration', async () => {
  const target = join(home, 'target'); const selected = join(home, 'selected')
  put(join(target, 'config.toml'), '[mcp_servers.ordinary]\ncommand="missing"\n')
  put(join(target, 'zzz'), 'bytes'); symlinkSync('target', selected); vi.stubEnv('CODEX_HOME', selected)
  const result = await scan()
  const { locateItem, resolveLocation, map } = await resolvers()
  expect(result.state).toBe('passed')
  expect(result.leftovers?.map((row) => resolveLocation(row.locator, map))).toEqual([join(selected, 'config.toml')])
  const fired = mutateOnce(selected, ['readdirSync'], () => renameSync(join(target, 'zzz'), join(target, 'aaa')))
  expect(locateItem(join(selected, 'config.toml'), map).status).not.toBe('located')
  expect(fired()).toBe(true)
})

it('rejects a previously captured skill location after only child bytes change', async () => {
  const path = join(home, '.codex/skills/ordinary')
  put(join(path, 'SKILL.md'), 'same body'); put(join(home, '.claude/skills/ordinary/SKILL.md'), 'same body')
  const result = await scan(); const { resolveLocation, map } = await resolvers()
  const row = result.leftovers?.find((item) => resolveLocation(item.locator, map) === path)
  expect(row).toBeDefined()
  put(join(path, 'SKILL.md'), 'otherbody')
  expect(resolveLocation(row!.locator, map)).toBeNull()
})

for (const mutation of ['checkpoint', 'wal-remove', 'journal'] as const) it(`refuses SQLite checkpoint or journal races: ${mutation}`, async () => {
  const path = join(home, '.codex/memories_1.sqlite'); mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path); databases.push(db)
  db.exec("create table stage1_outputs(thread_id text, usage_count integer, selected_for_phase2 integer); insert into stage1_outputs values ('ordinary',0,0),('password',0,0)")
  const state = new DatabaseSync(join(home, '.codex/state_5.sqlite')); databases.push(state)
  state.exec("create table threads(id text,cwd text); insert into threads values ('ordinary','/missing-a'),('password','/missing-b')")
  if (mutation === 'journal') put(`${path}-journal`, 'active')
  else db.exec("pragma journal_mode=WAL; delete from stage1_outputs; insert into stage1_outputs values ('password',0,0),('ordinary',0,0)")
  const fired = mutation === 'journal' ? () => true : mutateOnce(path, ['readSync', 'readFileSync', 'copyFileSync'], () => {
    if (mutation === 'checkpoint') db.exec('pragma wal_checkpoint(TRUNCATE)')
    else { db.close(); databases.splice(databases.indexOf(db), 1) }
  })
  const result = await scan()
  expect(fired()).toBe(true); expect(result.state).toBe('partial')
  expect(result.leftovers?.every((row) => row.locator?.status !== 'located')).toBe(true)
})

it('does not grandfather legacy coordinates as an acquired observation', async () => {
  put(join(home, 'ordinary'), 'bytes')
  const { locateItem, validateLocation, map } = await resolvers()
  const location = locateItem(join(home, 'ordinary'), map)
  expect(location.status).toBe('located')
  const legacy = { ...location, acquisition: undefined, witnesses: undefined }
  expect(validateLocation(legacy)).toEqual({ status: 'unresolved' })
})

it('resolves unchanged numeric memory rows with both databases actively using WAL', async () => {
  const path = join(home, '.codex/memories_1.sqlite'); mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path); databases.push(db)
  db.exec("pragma journal_mode=WAL; create table stage1_outputs(thread_id text, usage_count integer, selected_for_phase2 integer); insert into stage1_outputs values ('ordinary',0,0),('password',0,0)")
  const state = new DatabaseSync(join(home, '.codex/state_5.sqlite')); databases.push(state)
  state.exec("pragma journal_mode=WAL; create table threads(id text,cwd text); insert into threads values ('ordinary','/missing-a'),('password','/missing-b')")
  const result = await scan(); const { resolveLocation, map } = await resolvers()
  expect(result.state).toBe('passed')
  expect(result.leftovers).toHaveLength(2)
  expect(result.leftovers?.map((row) => resolveLocation(row.locator, map))).toEqual([path, path])
  expect(JSON.stringify(result)).not.toMatch(/ordinary|password|missing-a/)
  state.exec("update threads set cwd='/other'")
  expect(result.leftovers?.every((row) => resolveLocation(row.locator, map) === null)).toBe(true)
})
