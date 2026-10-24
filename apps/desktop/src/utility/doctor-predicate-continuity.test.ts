// MODULE: doctor-predicate-continuity.test.ts - Actual isolated worker proofs for discovery, ownership and reason dependencies
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { acquireLeftoversDoctor } from '../../bin/doctor-adapters.mjs'
import { matchContinuity } from '../../bin/doctor-continuity.mjs'
import type { ContinuityRow } from '../../bin/doctor-continuity.mjs'
import { canonicalJson, sha256 } from '../../bin/agents-roster.mjs'

const folders: string[] = [], keys = { item: 'c'.repeat(64), context: 'd'.repeat(64) }
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bmn-predicate-proof-')); folders.push(home) })
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }) })
const put = (path: string, body: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body) }
const env = (): NodeJS.ProcessEnv => ({ HOME: home, PATH: join(home, 'bin') + ':/usr/bin:/bin' })
const scan = async (versions = {}) => await acquireLeftoversDoctor(home, env(), versions, keys)
const match = (old: ContinuityRow[], fresh: ContinuityRow[]): boolean => matchContinuity(old, fresh).every(row => row.current !== null)

it('keeps a same-name duplicate group through unrelated discovery, and refuses group/body/capability/ownership changes', async () => {
  for (const root of ['.claude/skills', '.codex/skills']) put(join(home, root, 'ordinary/SKILL.md'), 'same synthetic skill')
  const first = await scan()
  expect(first.result.state).toBe('passed'); expect(first.rows).toHaveLength(1)
  put(join(home, '.codex/skills/unrelated/SKILL.md'), 'unrelated skill')
  expect(match(first.rows, (await scan()).rows)).toBe(true)
  put(join(home, '.agents/skills/ordinary/SKILL.md'), 'different body')
  expect(match(first.rows, (await scan()).rows)).toBe(false)
  rmSync(join(home, '.agents'), { recursive: true })
  put(join(home, '.claude/skills/ordinary/SKILL.md'), 'changed same-name body')
  expect(match(first.rows, (await scan()).rows)).toBe(false)
  put(join(home, '.claude/skills/ordinary/SKILL.md'), 'same synthetic skill')
  const beforeCapability = await scan()
  put(join(home, '.config/bmn/agents/state/skills-tests.jsonl'), JSON.stringify({ kind: 'capability', harness: 'codex', version: 'fixture', outcome: 'pass', roots: [{ root: '.codex/skills', folder: true }] }) + '\n')
  expect(match(beforeCapability.rows, (await scan({ codex: 'fixture' })).rows)).toBe(false)
  rmSync(join(home, '.config/bmn/agents/state/skills-tests.jsonl'))
  const beforeOwner = await scan()
  put(join(home, '.config/bmn/agents/state/own-skills.json'), '{"skills":{"ordinary":{}}}')
  expect(match(beforeOwner.rows, (await scan()).rows)).toBe(false)
})

it('treats a directory called SKILL.md as uncovered rather than passing an empty inventory', async () => {
  mkdirSync(join(home, '.codex/skills/ordinary/SKILL.md'), { recursive: true })
  const result = await scan()
  expect(result.result.state).toBe('partial')
  expect(result.result.problems).toContainEqual(expect.objectContaining({ code: 'leftover-unreadable', count: 1 }))
})

it('keeps cache items through unrelated entries and refuses reference or project-predicate changes', async () => {
  const cache = join(home, '.claude/plugins/cache/market/ordinary/1')
  put(join(cache, 'file'), 'cache body')
  const registry = join(home, '.claude/plugins/installed_plugins.json')
  put(registry, '{"plugins":{}}')
  const first = await scan()
  expect(first.result.state).toBe('passed'); expect(first.rows).toHaveLength(1)
  put(join(home, '.claude/plugins/cache/market/unrelated/1/file'), 'unrelated')
  expect(match(first.rows, (await scan()).rows)).toBe(true)
  put(registry, JSON.stringify({ plugins: { 'ordinary@market': [{ installPath: cache, projectPath: join(home, 'missing') }] } }))
  expect(match(first.rows, (await scan()).rows)).toBe(false)
  const missing = await scan()
  expect(missing.result.leftovers?.some(row => row.reason === 'plugin-missing')).toBe(true)
  mkdirSync(join(home, 'missing'))
  expect(match(missing.rows, (await scan()).rows)).toBe(false)
})

it('refuses a missing local plugin after its target appears without changing the configuration', async () => {
  put(join(home, '.config/opencode/opencode.json'), '{"plugin":["./ordinary.js"]}')
  const first = await scan()
  expect(first.rows).toHaveLength(1)
  put(join(home, '.config/opencode/ordinary.js'), 'export default {}')
  expect(match(first.rows, (await scan()).rows)).toBe(false)
})

it('witnesses PATH execution access and absolute script existence without launching the tool', async () => {
  put(join(home, 'bin/synthetic'), '#!/bin/sh\ntouch SHOULD-NOT-RUN\n')
  put(join(home, '.codex/config.toml'), `[mcp_servers.ordinary]\ncommand="synthetic"\nargs=[${JSON.stringify(join(home, 'missing.js'))}]\n`)
  const missingProgram = await scan()
  expect(missingProgram.result.leftovers?.[0]?.reason).toBe('missing-program')
  chmodSync(join(home, 'bin/synthetic'), 0o700)
  const missingScript = await scan()
  expect(match(missingProgram.rows, missingScript.rows)).toBe(false)
  expect(missingScript.result.leftovers?.[0]?.reason).toBe('missing-program')
  put(join(home, 'missing.js'), 'ordinary script')
  const present = await scan()
  expect(present.result.leftovers).toHaveLength(0)
  expect(match(missingScript.rows, present.rows)).toBe(false)
})

it('does not certify never-approved membership when generation or history evidence appears', async () => {
  put(join(home, '.codex/config.toml'), '[mcp_servers.ordinary]\ncommand="bmn-missing-fixture"\n')
  const first = await scan()
  expect(first.result.state).toBe('passed'); expect(first.rows).toHaveLength(1)
  put(join(home, '.config/bmn/agents/state/history.jsonl'), '{}\n')
  const history = await scan()
  expect(history.result.state).toBe('partial'); expect(match(first.rows, history.rows)).toBe(false)
  rmSync(join(home, '.config/bmn/agents/state/history.jsonl'))
  put(join(home, '.config/bmn/agents/state/generations/000001.json'), '{}')
  const generation = await scan()
  expect(generation.result.state).toBe('partial'); expect(match(first.rows, generation.rows)).toBe(false)
})

it('uses verified approved-generation membership and keeps unrelated team updates independent', async () => {
  const approved = (ids: string[]): void => {
    const generation = { number: 1, data: { schema_version: 3, agents: [], roles: [], providers: [], exceptions: [], harness_routes: [], tools: ids.map(id => ({ id })) } }
    const hash = sha256(canonicalJson(generation))
    put(join(home, '.config/bmn/agents/state/generations/000001.json'), JSON.stringify({ ...generation, hash }))
    put(join(home, '.config/bmn/agents/state/current'), JSON.stringify({ generation: 1, hash }))
  }
  put(join(home, '.codex/config.toml'), '[mcp_servers.ordinary]\ncommand="bmn-missing-fixture"\n')
  approved([])
  const first = await scan()
  expect(first.result.state).toBe('passed'); expect(first.rows).toHaveLength(1)
  approved(['unrelated'])
  const unrelated = await scan()
  expect(unrelated.result.state).toBe('passed'); expect(match(first.rows, unrelated.rows)).toBe(true)
  approved(['unrelated', 'ordinary'])
  const member = await scan()
  expect(member.result.state).toBe('passed'); expect(member.result.leftovers).toHaveLength(0)
  expect(match(first.rows, member.rows)).toBe(false)
})

it('refuses public row coordinates when the underlying configuration is already hard-linked', async () => {
  const path = join(home, '.codex/config.toml')
  put(path, '[mcp_servers.ordinary]\ncommand="bmn-missing-fixture"\n')
  linkSync(path, join(home, 'alias.toml'))
  const result = await scan()
  expect(result.result.leftovers).toHaveLength(1)
  expect(result.result.leftovers?.[0]?.locator?.status).not.toBe('located')
  expect(result.rows).toHaveLength(0)
})

it('rejects a selected-row alias collision and duplicate project relations', async () => {
  const path = join(home, '.codex/memories_1.sqlite'); mkdirSync(join(path, '..'), { recursive: true })
  const memory = new DatabaseSync(path), state = new DatabaseSync(join(home, '.codex/state_5.sqlite'))
  try {
    memory.exec("create table stage1_outputs(thread_id text,bmn_rowid integer); insert into stage1_outputs values('ordinary',99)")
    state.exec("create table threads(id text,cwd text); insert into threads values('ordinary','/missing')")
    const collision = await scan()
    expect(collision.result.state).toBe('partial'); expect(collision.rows).toHaveLength(0)
    memory.exec("drop table stage1_outputs; create table stage1_outputs(thread_id text); insert into stage1_outputs values('ordinary')")
    state.exec("insert into threads values('ordinary','/also-missing')")
    const duplicate = await scan()
    expect(duplicate.result.state).toBe('partial'); expect(duplicate.rows).toHaveLength(0)
  } finally { memory.close(); state.close() }
})

it('counts two over-bound databases as two inputs, without reading their sparse payload', async () => {
  for (const name of ['memories_1.sqlite', 'state_5.sqlite']) {
    const path = join(home, '.codex', name); put(path, ''); truncateSync(path, 512 * 1024 * 1024 + 1)
  }
  const result = await scan()
  expect(result.result.state).toBe('partial')
  expect(result.result.problems).toContainEqual(expect.objectContaining({ code: 'leftover-database-bound', count: 2 }))
  expect(result.rows).toHaveLength(0)
})
