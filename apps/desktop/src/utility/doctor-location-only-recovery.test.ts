// MODULE: doctor-location-only-recovery.test.ts - Real-scanner recovery when cache identity is out of bounds
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const keys = { item: 'a'.repeat(64), context: 'b'.repeat(64) }
const listed = '[plugins."p@m"]\nenabled = true\n'
const unlisted = '[plugins]\n'
let home: string
const put = (path: string, body: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body) }

beforeEach(() => {
  vi.resetModules(); home = mkdtempSync(join(tmpdir(), 'bmn-location-only-recovery-'))
  vi.stubEnv('HOME', home); vi.stubEnv('PATH', '/usr/bin:/bin')
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'BMN_TEST_DOCTOR_BASELINE']) vi.stubEnv(key, undefined)
  seam.hook = null; seam.descriptors.clear()
})
afterEach(() => { seam.hook = null; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

it.each([
  { name: 'changed reason', before: unlisted, after: listed, unrelated: false, seeded: false, partial: true, count: 1 },
  { name: 'new reason', before: listed, after: unlisted, unrelated: false, seeded: false, partial: true, count: 0 },
  { name: 'acquisition-window sibling', before: unlisted, after: '{}', unrelated: true, seeded: false, partial: true, count: 1 },
  { name: 'unrelated churn', before: unlisted, after: '{"unrelated":true}', unrelated: true, seeded: true, partial: false, count: 1 },
  { name: 'unchanged reason', before: unlisted, after: `${unlisted}# unrelated comment changes the bytes\n`, unrelated: false, seeded: false, partial: false, count: 1 }
])('reconciles a location-only cache through $name', async ({ before, after, unrelated, seeded, partial, count }) => {
  const { OBSERVATION_LIMITS } = await import('../../bin/doctor-locations.mjs')
  const cache = join(home, '.codex/plugins/cache/m/p/v'), config = join(home, '.codex/config.toml')
  mkdirSync(cache, { recursive: true })
  for (let i = 0; i <= OBSERVATION_LIMITS.entries; i += 1) writeFileSync(join(cache, `entry-${i}`), '')
  put(config, before); put(join(home, '.claude.json'), '{}')
  if (seeded) put(join(home, '.claude/settings.json'), '{}')
  let changed = false, reads = 0
  seam.hook = path => {
    if (path === config) reads += 1
    if (path === join(home, '.claude.json') && !changed) {
      changed = true
      put(unrelated ? join(home, '.claude/settings.json') : config, after)
    }
  }
  const { inspectLeftovers } = await import('../../bin/doctor-leftovers.mjs')
  const pair = await inspectLeftovers({}, { keys, privateReceipts: true })
  expect(changed, 'the later-file trigger must run').toBe(true)
  expect(reads, 'the actual scanner must perform its bounded recovery').toBe(2)
  expect(pair.result.problems.some((problem: { code: string }) => problem.code === 'leftover-unreadable')).toBe(false)
  expect(JSON.stringify(pair)).not.toMatch(/p@m|m\/p\/v|config\.toml|entry-\d|bmn-location-only-recovery/)
  expect(pair.rows).toEqual([])
  expect(pair.result.state).toBe(partial ? 'partial' : 'passed')
  expect(pair.result.problems).toEqual(partial ? [{ code: 'leftover-source-changed', item: 1, count: 1 }] : [])
  expect(pair.result.leftovers).toHaveLength(count)
  if (count) {
    expect(pair.result.leftovers?.[0]).toMatchObject({ app: 'codex', kind: 'plugins', reason: 'app-managed', locator: { status: 'unresolved' } })
  }
}, 60000)

it.each([
  { name: 'a unlisted remains unlisted', before: unlisted, after: `${unlisted}# recovered\n`, count: 1, persistent: false },
  { name: 'b unlisted becomes listed', before: unlisted, after: listed, count: 0, persistent: false },
  { name: 'c listed becomes unlisted', before: listed, after: unlisted, count: 1, persistent: false },
  { name: 'd persistent acquisition churn', before: unlisted, after: unlisted, count: 2, persistent: true }
])('post-review recovery: $name', async ({ before, after, count, persistent }) => {
  const { OBSERVATION_LIMITS } = await import('../../bin/doctor-locations.mjs')
  const cache = join(home, '.codex/plugins/cache/m/p/v'), config = join(home, '.codex/config.toml')
  mkdirSync(cache, { recursive: true })
  for (let i = 0; i <= OBSERVATION_LIMITS.entries; i += 1) writeFileSync(join(cache, `entry-${i}`), '')
  put(config, before)
  let reads = 0
  seam.hook = path => {
    if (path !== config) return
    reads += 1
    if (reads === 1 || persistent) put(config, `${after}${persistent ? `#${'x'.repeat(reads)}\n` : ''}`)
  }
  const { inspectLeftovers } = await import('../../bin/doctor-leftovers.mjs')
  const pair = await inspectLeftovers({}, { keys, privateReceipts: true })
  expect(reads, 'one recovery must follow the first-read acquisition race').toBe(2)
  expect(pair.result.state).toBe('partial')
  expect(pair.result.problems).toEqual([{ code: 'leftover-source-changed', item: 1, count: 1 }])
  expect(pair.result.leftovers).toHaveLength(count)
  expect(pair.rows).toEqual([])
  expect(pair.result.leftovers?.every(row => row.locator?.status === 'unresolved')).toBe(true)
  if (persistent) expect(pair.result.leftovers?.map(({ kind, app, reason }) => ({ kind, app, reason }))).toEqual(expect.arrayContaining([
    { kind: 'plugins', app: 'codex', reason: 'app-managed' }, { kind: 'mcp', app: 'codex', reason: 'unreadable' }
  ]))
  expect(JSON.stringify(pair)).not.toMatch(/p@m|m\/p\/v|config\.toml|entry-\d|bmn-location-only-recovery/)
}, 60000)

it.each([
  { name: 'N1 oversized cache', oversized: true },
  { name: 'N2 small cache', oversized: false }
])('post-review recovery: retains inventory through unreadable second discovery ($name)', async ({ oversized }) => {
  expect(process.getuid?.(), 'EACCES fixture requires a non-root user').not.toBe(0)
  const { OBSERVATION_LIMITS } = await import('../../bin/doctor-locations.mjs')
  const plugin = join(home, '.codex/plugins/cache/m/p'), cache = join(plugin, 'v'), config = join(home, '.codex/config.toml')
  mkdirSync(cache, { recursive: true })
  for (let i = 0; i < (oversized ? OBSERVATION_LIMITS.entries + 1 : 1); i += 1) writeFileSync(join(cache, `entry-${i}`), '')
  put(config, unlisted)
  let reads = 0
  seam.hook = path => {
    if (path !== config) return
    reads += 1
    if (reads === 1) put(config, `${unlisted}# recovered\n`)
    if (reads === 2) chmodSync(plugin, 0o000)
  }
  const { inspectLeftovers } = await import('../../bin/doctor-leftovers.mjs')
  try {
    const pair = await inspectLeftovers({}, { keys, privateReceipts: true })
    expect(reads).toBe(2)
    expect(pair.result.state).toBe('partial')
    expect(pair.result.problems.some(problem => problem.code === 'leftover-unreadable')).toBe(true)
    expect(pair.result.leftovers).toHaveLength(1)
    expect(pair.rows).toEqual([])
    expect(pair.result.leftovers?.[0]?.locator?.status).toBe('unresolved')
    expect(JSON.stringify(pair)).not.toMatch(/p@m|m\/p\/v|config\.toml|entry-\d|bmn-location-only-recovery/)
  } finally { chmodSync(plugin, 0o755) }
}, 60000)
