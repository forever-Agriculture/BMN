// MODULE: doctor-item-continuity.test.ts - Synthetic original/fresh item identity and complete reason-context controls
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { acquireLeftoversDoctor } from '../../bin/doctor-adapters.mjs'
import { matchContinuity } from '../../bin/doctor-continuity.mjs'
import type { ContinuityRow } from '../../bin/doctor-continuity.mjs'
import type { ProjectedDoctorResult } from '../../bin/doctor-results.mjs'

const folders: string[] = [], keys = { item: 'a'.repeat(64), context: 'b'.repeat(64) }
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bmn-item-proof-')); folders.push(home)
  vi.stubEnv('HOME', home); vi.stubEnv('PATH', '/usr/bin:/bin')
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) vi.stubEnv(key, undefined)
})
afterEach(() => { vi.unstubAllEnvs(); for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }) })
const put = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
const scan = async (): Promise<{ result: ProjectedDoctorResult; rows: ContinuityRow[] }> =>
  await acquireLeftoversDoctor(home, { ...process.env, HOME: home, PATH: '/usr/bin:/bin' }, {}, keys)

it('keeps a serialized nonempty memory tree through sibling insertion/reordering, then refuses changed child, hardlink and rename', async () => {
  const memory = join(home, '.claude/projects/-tmp-synthetic/memory')
  put(join(memory, 'MEMORY.md'), 'synthetic memory')
  const first = await scan(), original = JSON.parse(JSON.stringify(first.rows))
  expect(first.result.state).toBe('passed'); expect(original).toHaveLength(1)
  put(join(memory, '../000-new-sibling'), 'unrelated')
  const unchanged = await scan()
  expect(unchanged.result.state).toBe('passed')
  expect(matchContinuity(original, unchanged.rows)).toEqual([{ item: 1, current: 1 }])
  writeFileSync(join(memory, 'MEMORY.md'), 'changed content')
  expect(matchContinuity(original, (await scan()).rows)).toEqual([{ item: 1, current: null }])
  const changed = await scan()
  linkSync(join(memory, 'MEMORY.md'), join(memory, 'another-link'))
  expect(matchContinuity(changed.rows, (await scan()).rows)).toEqual([{ item: 1, current: null }])
  renameSync(memory, join(memory, '../renamed'))
  expect(matchContinuity(original, (await scan()).rows)).toEqual([{ item: 1, current: null }])
})

it('rejects changed ownership and selected configuration replacement without affecting an unrelated memory item', async () => {
  const memory = join(home, '.claude/projects/-tmp-synthetic/memory/MEMORY.md'), config = join(home, '.codex/config.toml')
  put(memory, 'synthetic memory'); put(config, '[mcp_servers.synthetic]\ncommand="bmn-missing-program"\n')
  const first = await scan()
  expect(first.rows).toHaveLength(2)
  const original = first.rows.find(r => first.result.leftovers?.find(v => v.item === r.item)?.kind === 'mcp')!
  put(join(home, '.config/bmn/agents/state/rules/tools-written.json'), JSON.stringify({ 'codex|synthetic': {} }))
  const ownership = await scan()
  expect(matchContinuity([original], ownership.rows)[0]?.current).toBeNull()
  expect(matchContinuity([first.rows[0]!], ownership.rows)[0]?.current).not.toBeNull()
  rmSync(join(home, '.config/bmn/agents/state/rules/tools-written.json'))
  put(config + '.new', '[mcp_servers.synthetic]\ncommand="bmn-missing-program"\n'); renameSync(config + '.new', config)
  expect(matchContinuity([original], (await scan()).rows)[0]?.current).toBeNull()
})

it('keeps full selected SQLite rows through unrelated writes to both WAL databases and refuses changed content, relation and rowid reuse', async () => {
  mkdirSync(join(home, '.codex'))
  const memory = new DatabaseSync(join(home, '.codex/memories_1.sqlite')), state = new DatabaseSync(join(home, '.codex/state_5.sqlite'))
  try {
    memory.exec('pragma journal_mode=WAL; create table stage1_outputs(thread_id text, usage_count integer, selected_for_phase2 integer, raw_memory text, rollup_summary text)')
    state.exec('pragma journal_mode=WAL; create table threads(id text, cwd text)')
    memory.prepare('insert into stage1_outputs values (?,0,0,?,?)').run('selected', 'ordinary private memory', 'summary')
    state.prepare('insert into threads values (?,?)').run('selected', join(home, 'gone'))
    const first = await scan()
    expect(first.result.state).toBe('passed'); expect(first.rows).toHaveLength(1)
    memory.prepare('insert into stage1_outputs values (?,0,0,?,?)').run('unrelated', 'other memory', 'other summary')
    state.prepare('insert into threads values (?,?)').run('unrelated', join(home, 'elsewhere'))
    const fresh = await scan()
    expect(fresh.result.state).toBe('passed'); expect(matchContinuity(first.rows, fresh.rows)[0]?.current).not.toBeNull()
    memory.exec("update stage1_outputs set rollup_summary='changed beyond the old four-column query' where rowid=1")
    expect(matchContinuity(first.rows, (await scan()).rows)[0]?.current).toBeNull()
    const beforeRelation = await scan(); state.prepare('update threads set cwd=? where id=?').run(join(home, 'different-missing-project'), 'selected')
    expect(matchContinuity([beforeRelation.rows[0]!], (await scan()).rows)[0]?.current).toBeNull()
    const beforeReuse = await scan(); memory.exec("delete from stage1_outputs where rowid=1; insert into stage1_outputs(rowid,thread_id,usage_count,selected_for_phase2,raw_memory,rollup_summary) values(1,'different',0,0,'new memory','new summary')")
    expect(matchContinuity([beforeReuse.rows[0]!], (await scan()).rows)[0]?.current).toBeNull()
    const publicAndPrivate = JSON.stringify([first.result, first.rows])
    for (const secret of ['ordinary private memory', 'selected', 'summary', home, createHash('sha256').update('ordinary private memory').digest('hex')]) expect(publicAndPrivate.includes(secret)).toBe(false)
  } finally { memory.close(); state.close() }
})
