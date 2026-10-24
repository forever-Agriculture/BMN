// MODULE: doctor-acquisition.test.ts - Deterministic mutations at the actual scanner filesystem boundaries
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { matchContinuity } from '../../bin/doctor-continuity.mjs'
import type { ContinuityRow } from '../../bin/doctor-continuity.mjs'
import type { ProjectedDoctorResult } from '../../bin/doctor-results.mjs'
import { manualLocation } from './doctor-test-locations'

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
const keys = { item: 'a'.repeat(64), context: 'b'.repeat(64) }
const receipts = new WeakMap<object, ContinuityRow[]>(), sandboxed = new WeakSet<object>()
async function scan(): Promise<ProjectedDoctorResult> {
  const pair = await (await import('../../bin/doctor-leftovers.mjs')).inspectLeftovers({}, { keys, privateReceipts: true }) as { result: ProjectedDoctorResult; rows: ContinuityRow[] }
  receipts.set(pair.result, pair.rows); return pair.result
}
async function scanSandbox(): Promise<ProjectedDoctorResult> {
  const pair = await (await import('../../bin/doctor-adapters.mjs')).acquireLeftoversDoctor(home, { HOME: home, PATH: '/usr/bin:/bin' }, {}, keys)
  receipts.set(pair.result, pair.rows); sandboxed.add(pair.result); return pair.result
}

it('OpenCode 2 MCP: reads both layouts without metadata rows and returns private locations', async () => {
  const path = join(home, '.config/opencode/opencode.json')
  const config = (command: string): string => JSON.stringify({ mcp: { timeout: 123,
    legacy: { type: 'local', command: ['bmn-synthetic-missing-legacy'] }, servers: { native: { type: 'local', command: [command] } } } })
  put(path, config('bmn-synthetic-missing-native'))
  const first = await scan()
  expect(first.state).toBe('passed')
  expect(first.leftovers).toHaveLength(2)
  expect(first.leftovers?.every(row => row.kind === 'mcp' && row.app === 'opencode' && row.reason === 'missing-program' && row.locator?.status === 'located')).toBe(true)
  expect(JSON.stringify(first)).not.toMatch(/legacy|native|bmn-synthetic|opencode.json/)
})

it('Epic 86 MCP continuity: keeps an unchanged MCP item through a sibling entry change', async () => {
  const path = join(home, '.config/opencode/opencode.json')
  const config = (command: string): string => JSON.stringify({ mcp: { timeout: 123,
    legacy: { type: 'local', command: ['bmn-synthetic-missing-legacy'] }, servers: { native: { type: 'local', command: [command] } } } })
  put(path, config('bmn-synthetic-missing-native'))
  const first = await scan()
  expect(first.state).toBe('passed')
  expect(first.leftovers).toHaveLength(2)
  expect(first.leftovers?.every(row => row.kind === 'mcp' && row.app === 'opencode' && row.reason === 'missing-program' && row.locator?.status === 'located')).toBe(true)
  put(path, config('bmn-synthetic-missing-replacement'))
  const second = await scan(), matches = matchContinuity(receipts.get(first)!, receipts.get(second)!)
  expect(matches).toEqual([{ item: first.leftovers![0]!.item, current: second.leftovers![0]!.item }, { item: first.leftovers![1]!.item, current: null }])
  expect(JSON.stringify(first)).not.toMatch(/legacy|native|bmn-synthetic|opencode.json/)
})

it.each(['claude', 'codex', 'opencode-legacy', 'opencode-native'])('Epic 86 MCP continuity: %s keeps entries across sibling insertion and reordering with fresh coordinates', async app => {
  const path = join(home, app === 'claude' ? '.claude.json' : app === 'codex' ? '.codex/config.toml' : '.config/opencode/opencode.json')
  const entry = { command: app.startsWith('opencode') ? ['bmn-synthetic-missing'] : 'bmn-synthetic-missing', ...(app.startsWith('opencode') ? { type: 'local' } : {}) }
  const body = (names: string[]): string => app === 'codex' ? names.map(name => `[mcp_servers.${name}]\ncommand="bmn-synthetic-missing"\n`).join('\n') :
    JSON.stringify(app === 'claude' ? { mcpServers: Object.fromEntries(names.map(name => [name, entry])) } :
      { mcp: app === 'opencode-native' ? { servers: Object.fromEntries(names.map(name => [name, entry])) } : Object.fromEntries(names.map(name => [name, entry])) }, null, 2)
  put(path, body(['keep', 'sibling']))
  const first = await scan()
  expect(first.state).toBe('passed'); expect(receipts.get(first)).toHaveLength(2)
  put(path, body(['sibling', 'inserted', 'keep']))
  const fresh = await scan(), matches = matchContinuity(receipts.get(first)!, receipts.get(fresh)!)
  expect(fresh.state).toBe('passed'); expect(matches.map(row => row.current)).toEqual([3, 1])
  expect(fresh.leftovers![2]!.locator).not.toEqual(first.leftovers![0]!.locator)
  expect(JSON.stringify(fresh)).not.toMatch(/keep|sibling|inserted|bmn-synthetic/)
})

it.each(['value', 'key', 'layout', 'replacement', 'hardlink', 'symlink', 'ownership', 'program', 'witness'])('Epic 86 MCP continuity: refuses %s changes', async change => {
  const path = join(home, '.config/opencode/opencode.json'), target = join(home, 'target.json'), program = join(home, 'missing-program')
  const entry = { type: 'local', command: [program], extra: { ignored: 'before' } }
  const body = JSON.stringify({ mcp: { keep: entry } })
  if (change === 'symlink') { put(target, body); mkdirSync(join(path, '..'), { recursive: true }); symlinkSync(target, path) }
  else put(path, body)
  const first = await scan()
  expect(first.state).toBe('passed'); expect(receipts.get(first)).toHaveLength(1)
  if (change === 'value') put(path, JSON.stringify({ mcp: { keep: { ...entry, extra: { ignored: 'after' } } } }))
  if (change === 'key') put(path, JSON.stringify({ mcp: { renamed: entry } }))
  if (change === 'layout') put(path, JSON.stringify({ mcp: { servers: { keep: entry } } }))
  if (change === 'replacement') { put(path + '.new', body); renameSync(path + '.new', path) }
  if (change === 'hardlink') linkSync(path, path + '.link')
  if (change === 'symlink') { put(target + '.new', body); rmSync(path); symlinkSync(target + '.new', path) }
  if (change === 'ownership') put(join(home, '.config/bmn/agents/state/rules/tools-written.json'), '{"opencode|keep":{}}')
  if (change === 'program') { put(program, '#!/bin/sh\nexit 0\n'); chmodSync(program, 0o700) }
  if (change === 'witness') put(join(home, '.config/bmn/agents/state/rules/tools-written.json'), '{')
  const fresh = await scan()
  expect(matchContinuity(receipts.get(first)!, receipts.get(fresh)!)).toEqual([{ item: first.leftovers![0]!.item, current: null }])
  if (change === 'witness') {
    expect(fresh.state).toBe('partial')
    expect(fresh.problems).toContainEqual(expect.objectContaining({ code: 'leftover-unreadable', count: 1 }))
  }
})

it.each([
  ['json duplicate nested', '.config/opencode/opencode.json', '{"mcp":{"keep":{"type":"local","command":["bmn-synthetic-missing"],"extra":{"x":1,"x":2}}}}'],
  ['toml array section', '.codex/config.toml', '[mcp_servers.keep]\ncommand="bmn-synthetic-missing"\n[[mcp_servers.keep.extra]]\nx=1\n'],
  ['toml unknown header', '.codex/config.toml', '[mcp_servers.keep]\ncommand="bmn-synthetic-missing"\n[mcp_servers.keep.extra\nx=1\n'],
  ['toml duplicate assignment', '.codex/config.toml', '[mcp_servers.keep]\ncommand="bmn-synthetic-missing"\ncommand="bmn-synthetic-other"\n'],
  ['toml duplicate table', '.codex/config.toml', '[mcp_servers.keep]\ncommand="bmn-synthetic-missing"\n[mcp_servers.keep]\nx=1\n'],
  ['toml duplicate inline', '.codex/config.toml', '[mcp_servers.keep]\ncommand="bmn-synthetic-missing"\nextra={x=1,x=2}\n'],
  ['toml reopened inline', '.codex/config.toml', '[mcp_servers.keep]\ncommand="bmn-synthetic-missing"\nextra={x=1}\n[mcp_servers.keep.extra]\nx=2\n']
])('Epic 86 MCP continuity: incomplete %s has no receipt', async (_name, relative, body) => {
  put(join(home, relative), body)
  const result = await scan()
  expect(result.state).toBe('partial'); expect(receipts.get(result)).toEqual([])
  expect(result.problems).toContainEqual(expect.objectContaining({ code: 'leftover-unreadable', count: 1 }))
  expect(JSON.stringify(result)).not.toMatch(/keep|extra|bmn-synthetic/)
})

it('Epic 86 MCP continuity: non-MCP items retain their whole-file content guard', async () => {
  const path = join(home, '.config/opencode/opencode.json')
  put(path, '{"plugin":["synthetic-package"],"metadata":0}')
  const first = await scan()
  expect(first.state).toBe('passed'); expect(receipts.get(first)).toHaveLength(1)
  expect(first.leftovers![0]!.kind).toBe('plugins')
  put(path, '{"plugin":["synthetic-package"],"metadata":1}')
  const fresh = await scan()
  expect(fresh.state).toBe('passed'); expect(receipts.get(fresh)).toHaveLength(1)
  expect(matchContinuity(receipts.get(first)!, receipts.get(fresh)!)).toEqual([{ item: first.leftovers![0]!.item, current: null }])
})

it('Epic 86 MCP continuity: keeps plugin entries through sibling edits but refuses discovery scope and fallback changes', async () => {
  const install = join(home, '.claude/plugins/synthetic'), path = join(install, '.mcp.json')
  const registry = join(home, '.claude/plugins/installed_plugins.json')
  const entry = { command: 'bmn-synthetic-missing' }
  put(registry, JSON.stringify({ plugins: { synthetic: [{ installPath: install }] } }))
  put(path, JSON.stringify({ mcpServers: { keep: entry } }))
  const first = await scan(), original = receipts.get(first)!
  expect(original).toHaveLength(1)
  put(path, JSON.stringify({ mcpServers: { sibling: entry, keep: entry } }))
  expect(matchContinuity(original, receipts.get(await scan())!)[0]!.current).not.toBeNull()
  put(registry, JSON.stringify({ plugins: { renamed: [{ installPath: install }] } }))
  expect(matchContinuity(original, receipts.get(await scan())!)[0]!.current).toBeNull()
  put(registry, JSON.stringify({ plugins: { synthetic: [{ installPath: install }] } }))
  put(path, JSON.stringify({ keep: entry }))
  expect(matchContinuity(original, receipts.get(await scan())!)[0]!.current).toBeNull()
})

it('Epic 86 MCP continuity: accepts fully read TOML subtables and unrelated array tables', async () => {
  put(join(home, '.codex/config.toml'), '[mcp_servers.keep]\ncommand="bmn-synthetic-missing"\n[mcp_servers.keep.extra]\nx={nested=[1,2]}\n[[unrelated]]\nx=1\n')
  const result = await scan()
  expect(result.state).toBe('passed'); expect(receipts.get(result)).toHaveLength(1)
})

it('OpenCode 2 MCP: marks a decoded cross-layout collision as incomplete rather than inventing a server row', async () => {
  put(join(home, '.config/opencode/opencode.json'), '{"mcp":{"same":{"type":"local","command":["missing"]},"servers":{"same":{"type":"local","command":["missing"]}}}}')
  const result = await scan()
  expect(result.state).toBe('partial')
  expect(result.problems?.length).toBeGreaterThan(0)
  expect(result.leftovers?.filter(row => row.kind === 'mcp' && row.app === 'opencode')).toHaveLength(0)
})

it('retains second-pass coverage when a newly discovered item changes after its observation', async () => {
  const projects = join(home, '.claude/projects'), a = join(projects, '-tmp-a/memory/MEMORY.md'), b = join(projects, '-tmp-b/memory/MEMORY.md')
  const later = join(home, '.claude.json'); put(a, 'unchanged'); put(later, '{}')
  let passes = 0
  seam.hook = (operation, target) => {
    if (target === later && operation === 'readSync') {
      passes += 1
      if (passes === 1) put(b, 'new item')
      if (passes === 2) put(b, 'changed after observation')
    }
  }
  const result = await scan()
  expect(passes).toBe(2); expect(result.state).toBe('partial')
  expect(result.problems).toContainEqual(expect.objectContaining({ code: 'leftover-source-changed', count: 1 }))
  expect(result.leftovers).toHaveLength(1); expect(result.leftovers?.[0]?.locator?.status).toBe('located')
})

it('counts a changed plugin configuration once across metadata and file operations', async () => {
  const first = join(home, '.claude/plugins/first/.mcp.json'), later = join(home, '.claude/plugins/later/.mcp.json')
  put(first, '{"mcpServers":{"ordinary":{"command":"missing-a"}}}')
  put(later, '{"mcpServers":{}}')
  put(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: {
    first: [{ installPath: join(first, '..') }], later: [{ installPath: join(later, '..') }]
  } }))
  const fired = mutateOnce(later, ['readSync'], () => put(first, '{"mcpServers":{"ordinary":{"command":"missing-b"}}}'))
  const result = await scan()
  expect(fired()).toBe(true); expect(result.state).toBe('partial')
  expect(result.problems).toContainEqual(expect.objectContaining({ code: 'leftover-source-changed', count: 1 }))
})
async function verifiedPaths(original: ProjectedDoctorResult): Promise<(string | null)[]> {
  const fresh = await (sandboxed.has(original) ? scanSandbox() : scan()), { map } = await resolvers()
  const matches = new Map(matchContinuity(receipts.get(original)!, receipts.get(fresh)!).map(row => [row.item, row.current]))
  return (original.leftovers ?? []).map(row => { const item = matches.get(row.item); return item ? manualLocation(fresh.leftovers?.[item - 1]?.locator, map) : null })
}
async function resolvers() {
  const locations = await import('../../bin/doctor-locations.mjs')
  const { selectedProfile } = await import('../../bin/doctor-profile.mjs')
  const map = locations.locationRoots(selectedProfile(process.env))
  return { ...locations, map }
}

for (const kind of ['json', 'toml', 'mcp'] as const) it(`reacquires ${kind} after a same-size reorder without publishing first-read coordinates`, async () => {
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
  expect(result.problems).toContainEqual(expect.objectContaining({ code: 'leftover-source-changed', count: 1 }))
  const { map } = await resolvers()
  expect(result.leftovers).toHaveLength(2)
  expect(result.leftovers?.map(row => manualLocation(row.locator, map))).toEqual([path, path])
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
  const original = await scan()
  expect(receipts.get(original)!.length).toBeGreaterThan(0)
  const fired = mutateOnce(first, ['readFileSync', 'readSync'], () => put(first, 'otherbody'))
  const result = await scan()
  expect(fired()).toBe(true)
  expect(result.state).toBe('partial')
  expect(matchContinuity(receipts.get(original)!, receipts.get(result)!)).toEqual(receipts.get(original)!.map(row => ({ item: row.item, current: null })))
})

it('reconstructs a replaced broken link only after a fresh read and retains the changed-source gap', async () => {
  const path = join(home, '.claude/skills/ordinary')
  mkdirSync(join(path, '..'), { recursive: true }); symlinkSync('missing-a', path)
  const fired = mutateOnce(path, ['readlinkSync'], () => { rmSync(path); symlinkSync('missing-b', path) })
  const result = await scan()
  expect(fired()).toBe(true)
  expect(result.state).toBe('partial')
  expect(result.problems).toContainEqual(expect.objectContaining({ code: 'leftover-source-changed', count: 1 }))
  expect(result.leftovers).toHaveLength(1)
  expect(result.leftovers?.[0]?.reason).toBe('broken-link')
  expect(JSON.stringify(result)).not.toMatch(/missing-a|missing-b/)
})

it('refuses numeric-coordinate acquisition across an entry race, then retains an observed file through unrelated siblings', async () => {
  const path = join(home, 'ordinary'); put(path, 'bytes'); put(join(home, 'zzz'), 'bytes')
  const { observeFile, unchangedSince, map } = await resolvers()
  const fired = mutateOnce(home, ['readdirSync'], () => renameSync(join(home, 'zzz'), join(home, 'aaa')))
  expect(() => observeFile(path, map)).toThrow(); expect(fired()).toBe(true)
  seam.hook = null
  const stable = observeFile(path, map)
  expect(unchangedSince(stable)).toBe(true)
  renameSync(join(home, 'aaa'), join(home, 'zzz'))
  expect(unchangedSince(stable)).toBe(true)
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
  const { observeDatabases, map } = await resolvers()
  expect(() => observeDatabases([path, join(home, '.codex/state_5.sqlite')], map)).toThrow()
  expect(fired()).toBe(true)
})

it('revalidates an earlier configuration observation before publishing the scan', async () => {
  const path = join(home, '.config/opencode/opencode.json')
  put(path, '{"plugin":["./ordinary","./password"]}')
  const later = join(home, '.claude.json'); put(later, '{}')
  const fired = mutateOnce(later, ['readFileSync', 'readSync'], () => put(path, '{"plugin":["./password","./ordinary"]}'))
  const result = await scan()
  expect(fired()).toBe(true)
  expect(result.state).toBe('partial')
  expect(await verifiedPaths(result)).toEqual((result.leftovers ?? []).map(() => null))
})

it('retains unchanged, individually resolvable controls with no disclosed names', async () => {
  const path = join(home, '.config/opencode/opencode.json')
  put(path, '{"plugin":["./ordinary","./password"]}')
  const result = await scan()
  expect(result.state).toBe('passed')
  expect(result.leftovers).toHaveLength(2)
  expect(await verifiedPaths(result)).toEqual([path, path])
  expect(result.leftovers?.[0]?.locator).not.toEqual(result.leftovers?.[1]?.locator)
  expect(JSON.stringify(result)).not.toMatch(/ordinary|password/)
})

it('checks followed configuration targets after acquisition and keeps link identity', async () => {
  const target = join(home, 'target.json'), path = join(home, 'config.json')
  put(target, '{"plugin":["./ordinary","./password"]}'); symlinkSync('target.json', path)
  const { observeFile, unchangedSince, map } = await resolvers()
  const source = observeFile(path, map)
  expect(source.locator).toHaveProperty('target'); expect(unchangedSince(source)).toBe(true)
  put(target, '{"plugin":["./password","./ordinary"]}')
  expect(unchangedSince(source)).toBe(false)
})

it('resolves a selected symlink profile and refuses changes in its real parent enumeration', async () => {
  const target = join(home, 'target'); const selected = join(home, 'selected')
  put(join(target, 'config.toml'), '[mcp_servers.ordinary]\ncommand="missing"\n')
  put(join(target, 'zzz'), 'bytes'); symlinkSync('target', selected); vi.stubEnv('CODEX_HOME', selected)
  const result = await scan()
  const { observeFile, map } = await resolvers()
  expect(result.state).toBe('passed')
  expect(await verifiedPaths(result)).toEqual([join(selected, 'config.toml')])
  const fired = mutateOnce(selected, ['readdirSync'], () => renameSync(join(target, 'zzz'), join(target, 'aaa')))
  expect(() => observeFile(join(selected, 'config.toml'), map)).toThrow()
  expect(fired()).toBe(true)
})

it('rejects a previously captured skill location after only child bytes change', async () => {
  const path = join(home, '.codex/skills/ordinary')
  put(join(path, 'SKILL.md'), 'same body'); put(join(home, '.claude/skills/ordinary/SKILL.md'), 'same body')
  const result = await scan(), before = await verifiedPaths(result)
  expect(before).toContain(path)
  put(join(path, 'SKILL.md'), 'otherbody')
  expect((await verifiedPaths(result))[before.indexOf(path)]).toBeNull()
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
  const { observeDatabases, map } = await resolvers()
  expect(() => observeDatabases([path, join(home, '.codex/state_5.sqlite')], map)).toThrow()
  expect(fired()).toBe(true)
})

it('does not grandfather legacy coordinates as an acquired observation', async () => {
  put(join(home, 'ordinary'), 'bytes')
  const { observeFile, validateLocation, map } = await resolvers()
  const location = observeFile(join(home, 'ordinary'), map).locator
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
  const result = await scanSandbox()
  expect(result.state).toBe('passed')
  expect(result.leftovers).toHaveLength(2)
  expect(await verifiedPaths(result)).toEqual([path, path])
  expect(JSON.stringify(result)).not.toMatch(/ordinary|password|missing-a/)
  state.exec("update threads set cwd='/other'")
  expect(await verifiedPaths(result)).toEqual([null, null])
})

// Astra review 20261022T154230-1f24cfba: only a location lookup is exempt from partial, never an unreadable or changed source.
it.skipIf(process.getuid?.() === 0)('keeps a plugin cache folder BMN cannot read partial', async () => {
  const folder = join(home, '.codex/plugins/cache/market/ordinary/1')
  put(join(folder, 'file'), 'bytes')
  chmodSync(folder, 0)
  try {
    const result = await scan()
    expect(result.state).toBe('partial')
  } finally { chmodSync(folder, 0o700) }
})

it('keeps a plugin cache folder changed after observation and before publication partial', async () => {
  const folder = join(home, '.codex/plugins/cache/market/ordinary/1')
  put(join(folder, 'file'), 'bytes')
  const later = join(home, '.config/opencode/plugins'); mkdirSync(later, { recursive: true })
  const fired = mutateOnce(later, ['readdirSync'], () => put(join(folder, 'file'), 'other bytes'))
  const result = await scan()
  expect(fired()).toBe(true)
  expect(result.state).toBe('partial')
})

it('keeps a check passed when only a sibling of an unchanged source appears during the scan', async () => {
  const path = join(home, '.config/opencode/opencode.json')
  put(path, '{"plugin":["./ordinary","./password"]}')
  const later = join(home, '.config/opencode/plugins'); mkdirSync(later, { recursive: true })
  const fired = mutateOnce(later, ['readdirSync'], () => put(join(home, '.config/opencode/zzz'), 'bytes'))
  const result = await scan()
  expect(fired()).toBe(true)
  expect(result.state).toBe('passed')
  expect(result.leftovers).toHaveLength(2)
})

it('retains a database source witness which refuses a later write before publication', async () => {
  const path = join(home, '.codex/memories_1.sqlite'); mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path); databases.push(db)
  db.exec("create table stage1_outputs(thread_id text); insert into stage1_outputs values ('ordinary')")
  const state = new DatabaseSync(join(home, '.codex/state_5.sqlite')); databases.push(state)
  state.exec("create table threads(id text,cwd text)")
  const { observeDatabases, unchangedSince, map } = await resolvers()
  const source = observeDatabases([path, join(home, '.codex/state_5.sqlite')], map)[0]!
  const later = join(home, '.config/opencode/plugins'); mkdirSync(later, { recursive: true })
  const fired = mutateOnce(later, ['readdirSync'], () => db.exec("insert into stage1_outputs values ('added')"))
  readdirSync(later)
  expect(fired()).toBe(true); expect(unchangedSince(source)).toBe(false)
})
