// MODULE: doctor-locations.test.ts - Manual item resolution, source revision invalidation and absent identity text
import { DatabaseSync } from 'node:sqlite'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { qualificationProcess, runLeftoversDoctor, sandboxProcess } from '../../bin/doctor-adapters.mjs'
import { locateItem, locationRoots, resolveLocation, validateLocation } from '../../bin/doctor-locations.mjs'
import { selectedProfile } from '../../bin/doctor-profile.mjs'
import { readJsonItems } from '../../bin/agents-tool-files.mjs'

const roots: string[] = []
const fixture = (): string => { const path = mkdtempSync(join(tmpdir(), 'bmn-doctor-location-')); roots.push(path); return path }
const put = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

it('resolves distinct hard-linked entries and symlinks, then refuses renamed or replaced sources', () => {
  const home = fixture()
  const first = join(home, 'password')
  put(first, 'same bytes')
  linkSync(first, join(home, 'ordinary'))
  symlinkSync('missing', join(home, 'sk-SYNTHETIC-abcdef123456'))
  const map = locationRoots(selectedProfile({ HOME: home }))
  const items = ['password', 'ordinary', 'sk-SYNTHETIC-abcdef123456'].map((name) => locateItem(join(home, name), map))
  expect(items.map((item) => resolveLocation(item, map))).toEqual(['password', 'ordinary', 'sk-SYNTHETIC-abcdef123456'].map((name) => join(home, name)))
  expect(JSON.stringify(items)).not.toMatch(/password|ordinary|SYNTHETIC|abcdef/)
  expect(items[0]).not.toEqual(items[1])
  renameSync(first, join(home, 'replacement'))
  expect(items.map((item) => resolveLocation(item, map))).toEqual([null, null, null])
  const replacement = locateItem(join(home, 'replacement'), map)
  put(join(home, 'new'), 'same bytes')
  renameSync(join(home, 'new'), join(home, 'replacement'))
  expect(resolveLocation(replacement, map)).toBeNull()
  expect(validateLocation({ ...items[0], root: 'password' })).toBeNull()
})

it('uses parser-derived UTF-16 coordinates for nested objects and arrays, rejecting duplicate keys', () => {
  const text = '{"😀":"ignored", "projects":{"password":{"mcpServers":{"ordinary":{"command":"missing"}}}}, "plugin":["password","ordinary"]}'
  const entry = readJsonItems(text, ['projects', 'password', 'mcpServers'])[0]!
  const home = fixture()
  const path = join(home, '.claude.json')
  put(path, text)
  const map = locationRoots(selectedProfile({ HOME: home }))
  const locator = locateItem(path, map, { text, start: entry.start })
  expect(locator).toMatchObject({ line: 1, column: text.indexOf('"ordinary"') + 1 })
  expect(readJsonItems(text, ['plugin']).map((item) => text.slice(item.start, item.start + 1))).toEqual(['"', '"'])
  expect(() => readJsonItems('{"mcpServers":{"password":{},"password":{}}}', ['mcpServers'])).toThrow()
  expect(resolveLocation(locator, map)).toBe(path)
  put(path, text.replace('"😀":"ignored", ', ''))
  expect(resolveLocation(locator, map)).toBeNull()
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
  const result = await runLeftoversDoctor(home, { HOME: home, PATH: '/usr/bin:/bin' }, {})
  expect(result.state).toBe('passed')
  const rows = result.leftovers ?? []
  const map = locationRoots(selectedProfile({ HOME: home }))
  expect(new Set(rows.map((row) => row.kind))).toEqual(new Set(['skills', 'plugins', 'mcp', 'memory']))
  for (const row of rows) {
    expect(row.identity).toBe('withheld')
    expect(row.locator?.status).toBe('located')
    expect(resolveLocation(row.locator, map)).not.toBeNull()
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
  expect(resolveLocation(memory.locator, map)).toBeNull()
})

it('lists a plugin cache folder too large to observe without making the check partial', async () => {
  const home = fixture()
  const folder = join(home, '.codex/plugins/cache/market/ordinary/1')
  for (let index = 0; index < 300; index++) put(join(folder, `file-${index}`), 'bytes')
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
