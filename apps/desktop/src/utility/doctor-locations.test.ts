// MODULE: doctor-locations.test.ts - Manual item resolution, source revision invalidation and absent identity text
import { DatabaseSync } from 'node:sqlite'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { acquireLeftoversDoctor, qualificationProcess, revalidateLeftoversDoctor, runLeftoversDoctor, sandboxProcess } from '../../bin/doctor-adapters.mjs'
import { locationRoots, validateLocation } from '../../bin/doctor-locations.mjs'
import { selectedProfile } from '../../bin/doctor-profile.mjs'
import { readJsonItems } from '../../bin/agents-tool-files.mjs'
import { manualLocation } from './doctor-test-locations'

const roots: string[] = []
const fixture = (): string => { const path = mkdtempSync(join(tmpdir(), 'bmn-doctor-location-')); roots.push(path); return path }
const put = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

const keys = { item: 'a'.repeat(64), context: 'b'.repeat(64) }
it('refuses ambiguous hard-linked configuration coordinates and changes in entry identity', async () => {
  const home = fixture(), environment = { HOME: home, PATH: '/usr/bin:/bin' }, path = join(home, '.codex/config.toml')
  put(path, '[mcp_servers.ordinary]\ncommand="bmn-missing-program"\n')
  linkSync(path, join(home, 'alias'))
  const ambiguous = await acquireLeftoversDoctor(home, environment, {}, keys)
  expect(ambiguous.result.leftovers?.[0]?.locator?.status).toBe('unresolved'); expect(ambiguous.rows).toEqual([])
  rmSync(join(home, 'alias'))
  const first = await acquireLeftoversDoctor(home, environment, {}, keys)
  expect(first.rows).toHaveLength(1)
  const map = locationRoots(selectedProfile(environment)), row = first.result.leftovers![0]!
  expect(manualLocation(row.locator, map)).toBe(path)
  expect(validateLocation({ ...row.locator, root: 'password' })).toBeNull()
  renameSync(path, join(home, 'renamed'))
  put(path, '[mcp_servers.ordinary]\ncommand="bmn-missing-program"\n')
  const changed = await revalidateLeftoversDoctor(home, environment, {}, keys, first.rows)
  expect(changed?.matches).toEqual([{ item: 1, current: null }])
})

it('uses parser-derived UTF-16 coordinates for nested objects and arrays, rejecting duplicate keys', async () => {
  const text = '{"😀":"ignored", "projects":{"password":{"mcpServers":{"ordinary":{"command":"bmn-missing-program"}}}}, "plugin":["password","ordinary"]}'
  const entry = readJsonItems(text, ['projects', 'password', 'mcpServers'])[0]!, home = fixture(), path = join(home, '.claude.json')
  put(path, text)
  const environment = { HOME: home, PATH: '/usr/bin:/bin' }, first = await acquireLeftoversDoctor(home, environment, {}, keys)
  const row = (first.result.leftovers ?? []).find(row => row.kind === 'mcp')!
  expect(row.locator).toMatchObject({ line: 1, column: entry.start + 1 })
  expect(readJsonItems(text, ['plugin']).map(item => text.slice(item.start, item.start + 1))).toEqual(['"', '"'])
  expect(() => readJsonItems('{"mcpServers":{"password":{},"password":{}}}', ['mcpServers'])).toThrow()
  const verified = await revalidateLeftoversDoctor(home, environment, {}, keys, first.rows)
  expect(verified?.matches).toEqual([{ item: 1, current: 1 }])
  expect(manualLocation(row.locator, locationRoots(selectedProfile(environment)))).toBe(path)
  const shifted = text.replace('"😀":"ignored", ', '')
  put(path, shifted)
  const current = await revalidateLeftoversDoctor(home, environment, {}, keys, first.rows)
  expect(current?.matches).toEqual([{ item: 1, current: 1 }])
  const shiftedEntry = readJsonItems(shifted, ['projects', 'password', 'mcpServers'])[0]!
  expect(shiftedEntry.start).toBe(entry.start - 16)
  expect(current?.result.leftovers?.find(row => row.kind === 'mcp')?.locator).toMatchObject({
    status: 'located', line: 1, column: shiftedEntry.start + 1
  })
  put(path, shifted.replace('bmn-missing-program', 'bmn-other-missing-program'))
  expect((await revalidateLeftoversDoctor(home, environment, {}, keys, first.rows))?.matches).toEqual([{ item: 1, current: null }])
})

it('individually resolves every retained kind, plugin install/cache and numeric memory row without publishing names', async () => {
  const home = fixture()
  const names = ['ordinary', 'password', 'sk-SYNTHETIC-abcdef123456', 'cGFzc3dvcmQ=']
  mkdirSync(join(home, '.claude/skills'), { recursive: true })
  const plugins: Record<string, unknown> = {}
  const enabled: Record<string, boolean> = {}
  for (const name of names) {
    symlinkSync('missing', join(home, '.claude/skills', name))
    put(join(home, '.claude/projects', `-tmp-${name}`, 'memory/MEMORY.md'), '# Memory')
    plugins[name] = [{ installPath: join(home, 'missing', name) }, { installPath: join(home, 'also-missing', name) }]
    enabled[name] = false
    mkdirSync(join(home, '.claude/plugins/cache', 'market', name, '1'), { recursive: true })
    mkdirSync(join(home, '.codex/plugins/cache', 'market', name, '1'), { recursive: true })
  }
  put(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: enabled }))
  put(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins }))
  put(join(home, '.claude.json'), JSON.stringify({ projects: Object.fromEntries(names.map((name) => [join(home, 'gone', name), { mcpServers: { [name]: { command: 'bmn-missing-program' } } }])) }))
  put(join(home, '.codex/config.toml'), names.map((name) => `[mcp_servers."${name}"]\ncommand="bmn-missing-program"\n[plugins."${name}"]\nenabled=false\n`).join(''))
  put(join(home, '.config/opencode/opencode.jsonc'), JSON.stringify({ plugin: names.map((name) => `./${name}`), mcp: Object.fromEntries(names.map((name) => [name, { type: 'local', command: ['bmn-missing-program'], enabled: true }])) }))
  const db = new DatabaseSync(join(home, '.codex/memories_1.sqlite'))
  db.exec('create table stage1_outputs(thread_id text, usage_count integer, selected_for_phase2 integer)')
  for (const name of names) db.prepare('insert into stage1_outputs values (?,0,0)').run(name)
  db.close()
  const state = new DatabaseSync(join(home, '.codex/state_5.sqlite'))
  state.exec('create table threads(id text,cwd text)')
  for (const name of names) state.prepare('insert into threads values (?,?)').run(name, join(home, 'gone', name))
  state.close()
  const environment = { HOME: home, PATH: '/usr/bin:/bin' }, first = await acquireLeftoversDoctor(home, environment, {}, keys), result = first.result
  expect(result.state).toBe('passed')
  const rows = result.leftovers ?? []
  const map = locationRoots(selectedProfile({ HOME: home }))
  expect(new Set(rows.map((row) => row.kind))).toEqual(new Set(['skills', 'plugins', 'mcp', 'memory']))
  const fresh = await revalidateLeftoversDoctor(home, environment, {}, keys, first.rows)
  expect(fresh?.matches.every(match => match.current !== null)).toBe(true)
  expect(fresh?.matches).toHaveLength(rows.length)
  for (const row of rows) {
    expect(row.identity).toBe('withheld')
    expect(row.locator?.status).toBe('located')
    expect(manualLocation(row.locator, map)).not.toBeNull()
  }
  expect(rows.filter((row) => row.kind === 'memory' && row.app === 'codex')).toHaveLength(4)
  expect(rows.filter((row) => row.kind === 'plugins' && row.app === 'claude' && row.reason === 'disabled')).toHaveLength(8)
  expect(rows.filter((row) => row.kind === 'plugins' && row.reason === 'app-managed')).toHaveLength(8)
  expect(rows.filter((row) => row.kind === 'mcp' && row.app === 'claude')).toHaveLength(4)
  for (const name of names) expect(JSON.stringify(result)).not.toContain(name)
  const memory = rows.find((row) => row.kind === 'memory' && row.app === 'codex')!
  const changed = new DatabaseSync(join(home, '.codex/memories_1.sqlite'))
  changed.exec('delete from stage1_outputs where rowid=1')
  changed.close()
  expect((await revalidateLeftoversDoctor(home, environment, {}, keys, first.rows))?.matches.find(row => row.item === memory.item)?.current).toBeNull()
})

it('lists a plugin cache folder too large to observe without making the check partial', async () => {
  const home = fixture()
  const folder = join(home, '.codex/plugins/cache/market/ordinary/1')
  for (let index = 0; index < 1100; index++) put(join(folder, `file-${index}`), 'bytes')
  const result = await runLeftoversDoctor(home, { HOME: home, PATH: '/usr/bin:/bin' }, {})
  expect(result.state).toBe('passed')
  expect(result.leftovers?.map((row) => [row.reason, row.locator?.status])).toEqual([['app-managed', 'unresolved']])
})

it('keeps selected temporary symlink roots at their actual absolute paths and refuses writes', async () => {
  const home = fixture()
  const outside = fixture()
  put(join(outside, 'config.toml'), 'selected data')
  symlinkSync(outside, join(home, 'selected'))
  const code = "const fs=require('fs'); const p=process.env.CODEX_HOME+'/config.toml'; const before=fs.readFileSync(p,'utf8'); let write; try{fs.writeFileSync(p,'changed');write='WRITTEN'}catch(e){write=e.code};console.log(JSON.stringify({before,write,path:process.env.CODEX_HOME}))"
  const run = await sandboxProcess(home, process.execPath, ['-e', code], { HOME: home, CODEX_HOME: join(home, 'selected'), PATH: '/usr/bin:/bin' })
  expect(run.code).toBe(0)
  expect(JSON.parse(run.stdout)).toEqual({ before: 'selected data', write: 'EROFS', path: join(home, 'selected') })
  expect(readFileSync(join(outside, 'config.toml'), 'utf8')).toBe('selected data')
})

it('masks synthetic owner/default selectors and absolute/symlink read routes during qualification', async () => {
  const owner = fixture()
  const disposable = fixture()
  put(join(owner, '.codex/auth.json'), 'password')
  symlinkSync(join(owner, '.codex/auth.json'), join(disposable, 'alias'))
  const code = `const fs=require('fs'); const paths=[${JSON.stringify(join(owner, '.codex/auth.json'))},'/tmp/profile/alias'];console.log(JSON.stringify({home:process.env.HOME,read:paths.map(p=>{try{fs.readFileSync(p);return true}catch{return false}})}))`
  const result = await qualificationProcess(disposable, process.execPath, ['-e', code], { HOME: owner, CODEX_HOME: join(owner, '.codex'), PATH: '/usr/bin:/bin' })
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ home: '/tmp/profile', read: [false, false] })
  expect(result.stdout).not.toContain('password')
})
