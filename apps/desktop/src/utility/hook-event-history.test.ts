import { randomUUID } from 'node:crypto'
import { link, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HookEventRecord } from '@bmn/protocol'
import { ensurePrivateDirectories } from './private-directory'
import { windowsFixtureAllowsOnlyCurrentUser } from './windows-fixture-io.test-support'
import { boundedHookHistory, HookEventHistory, HOOK_HISTORY_FILE, HOOK_HISTORY_MAX_BYTES, retainedHookEvent } from './hook-event-history'

if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000 })

const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const sid = randomUUID(), incarnationId = randomUUID()
const row = (index = 0, sessionId = sid): HookEventRecord => ({ sessionId, incarnationId, agent: 'claude', event: 'PostToolUse',
  source: null, toolName: 'Bash', repeat: 1, effects: [], observedAt: new Date(Date.UTC(2026, 9, 1) + index).toISOString() })
async function fixture(options: { replace?: typeof rename; openFile?: typeof open } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'bmn-hook-history-')); roots.push(base)
  const root = process.platform === 'win32' ? join(base, 'private-state') : base
  if (process.platform === 'win32') ensurePrivateDirectories([root])
  const live: HookEventRecord[] = [], known = new Set<string>([sid])
  const history = new HookEventHistory({ root, sessionExists: id => known.has(id), live: () => live, ...options })
  const path = join(root, HOOK_HISTORY_FILE)
  return { root, live, known, history, path, saved: async () => JSON.parse(await readFile(path, 'utf8')) as { version: number; rows: HookEventRecord[] } }
}
describe('bounded retained hook metadata', () => {
  it('projects only allowlisted fields/categories and omits secret-shaped labels and payloads', () => {
    const event = { ...row(), event: 'secret-event-token', source: 'secret-api-host', toolName: 'mcp__secret_tool',
      model: 'secret-model', apiHost: 'secret-provider', payload: { body: 'secret-prompt' }, repeat: 900 }
    const retained = retainedHookEvent(event)
    expect(retained).toMatchObject({ event: 'other', source: 'other', toolName: 'other', repeat: 20 })
    expect(JSON.stringify(retained)).not.toContain('secret')
    expect(Object.keys(retained!)).toHaveLength(9)
    expect(retainedHookEvent({ ...row(), incarnationId: 'secret-incarnation' })).toBeNull()
    expect(retainedHookEvent({ ...row(), agent: 'codex', event: 'PreToolUse', toolName: 'functions.request_user_input_async' })?.toolName)
      .toBe('functions.request_user_input_async')
  })
  it('caps per session and globally, evicting oldest first with stable timestamp ties', () => {
    function* input() { for (let s = 0; s < 50; s++) { const id = randomUUID(); for (let i = 0; i < 40; i++) yield row(s * 40 + i, id) } }
    const rows = boundedHookHistory(input())
    expect(rows).toHaveLength(1024)
    for (const id of new Set(rows.map(row => row.sessionId))) expect(rows.filter(row => row.sessionId === id).length).toBeLessThanOrEqual(30)
    expect(rows.at(-1)?.observedAt).toBe(row(1999).observedAt)
    expect(rows.map(row => row.observedAt)).toEqual(rows.map(row => row.observedAt).sort())
    expect(Buffer.byteLength(JSON.stringify({ version: 1, rows }))).toBeLessThanOrEqual(HOOK_HISTORY_MAX_BYTES)
    const a = row(), b = { ...row(), event: 'Stop' }
    expect(boundedHookHistory([a, b])).toEqual([a, b])
  })
  it('writes 0700/0600 atomically and loads history separately without adding current rows', async () => {
    const f = await fixture(); await f.history.load(); f.live.push(row()); f.history.markDirty(); await f.history.flush()
    if (process.platform === 'win32') {
      expect(windowsFixtureAllowsOnlyCurrentUser(f.root, f.path)).toBe(true)
    } else {
      expect((await stat(f.root)).mode & 0o777).toBe(0o700); expect((await stat(f.path)).mode & 0o777).toBe(0o600)
    }
    expect(await readdir(f.root)).toEqual([HOOK_HISTORY_FILE])
    expect(f.history.history(sid)).toEqual([])
    const next = new HookEventHistory({ root: f.root, sessionExists: id => f.known.has(id), live: () => [row(1)] })
    await next.load(); expect(next.history(sid)).toEqual([row()]); await next.flush()
    expect(next.history(sid)).toEqual([row()]); expect((await f.saved()).rows).toEqual([row(), row(1)])
    await next.close(); await f.history.close()
  })
  it('filters deleted sessions at startup and rewrites the snapshot', async () => {
    const f = await fixture(); await writeFile(f.path, JSON.stringify({ version: 1, rows: [row(), row(1, randomUUID())] }))
    await f.history.load(); await f.history.flush()
    expect(f.history.history(sid)).toEqual([row()]); expect((await f.saved()).rows).toEqual([row()])
    f.known.clear(); f.history.sessionsChanged(); expect(f.history.history(sid)).toEqual([])
    await f.history.flush(); expect((await f.saved()).rows).toEqual([]); await f.history.close()
  })
  it.each(['{', JSON.stringify({ version: 1, rows: [{ ...row(), toolName: 'secret-tool' }] }),
    JSON.stringify({ version: 1, rows: [{ ...row(), payload: 'secret' }] }), JSON.stringify({ version: 2, rows: [] }),
    JSON.stringify({ version: 1, rows: [{ ...row(), effects: ['opened', 'opened'] }] }),
    JSON.stringify({ version: 1, rows: [{ ...row(), observedAt: '2026-02-30T00:00:00.000Z' }] })])('discards an invalid snapshot as a whole', async contents => {
    const f = await fixture(); await writeFile(f.path, contents); await f.history.load()
    expect(f.history.unavailable).toBe(true); expect(f.history.history(sid)).toEqual([])
    f.live.push(row()); f.history.markDirty(); await f.history.flush(); expect((await f.saved()).rows).toEqual([row()]); await f.history.close()
  })
  it('refuses oversize files and links before reading unbounded bytes', async () => {
    const f = await fixture(); await writeFile(f.path, ' '.repeat(HOOK_HISTORY_MAX_BYTES + 1)); await f.history.load()
    expect(f.history.unavailable).toBe(true); await f.history.close()
    const link = await fixture(); await symlink(f.path, link.path); await link.history.load()
    expect(link.history.unavailable).toBe(true); expect(link.history.history(sid)).toEqual([]); await link.history.close()
  })
  it('refuses a different ordinary file installed between pathname check and open', async () => {
    const f = await fixture({ openFile: async (path, flags, mode) => {
      const replacement = join(root, 'replacement.json')
      await writeFile(replacement, JSON.stringify({ version: 1, rows: [row(1)] }))
      if (process.platform === 'win32') {
        const { replaceWindowsFixtureFile } = await import('./windows-fixture-io.test-support')
        replaceWindowsFixtureFile(root, replacement, String(path))
      } else await rename(replacement, path)
      return open(path, flags, mode)
    } })
    const root = f.root
    await writeFile(f.path, JSON.stringify({ version: 1, rows: [row()] }))
    await f.history.load()
    expect(f.history.unavailable).toBe(true)
    expect(f.history.history(sid)).toEqual([])
    await f.history.close()
  })
  it('refuses hardlinked history without reading or changing its other name', async () => {
    const f = await fixture()
    const target = join(f.root, 'other.json')
    const original = JSON.stringify({ version: 1, rows: [row()] })
    await writeFile(target, original); await link(target, f.path)
    await f.history.load()
    expect(f.history.unavailable).toBe(true); expect(f.history.history(sid)).toEqual([])
    await f.history.close()
    expect(await readFile(target, 'utf8')).toBe(original)
  })
  it('evicts earlier-run rows without ever turning current events into history', async () => {
    const f = await fixture(); await writeFile(f.path, JSON.stringify({ version: 1, rows: Array.from({ length: 30 }, (_, i) => row(i)) }))
    await f.history.load(); f.live.push(...Array.from({ length: 30 }, (_, i) => row(i + 30)))
    f.history.markDirty(); await f.history.flush()
    expect(f.history.history(sid)).toEqual([]); expect((await f.saved()).rows).toEqual(f.live); await f.history.close()
  })
  it('coalesces a burst into one writer and follows a deletion racing replacement with a filtered write', async () => {
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(done => { release = done }), reached = new Promise<void>(done => { entered = done })
    let hold = false
    const replacement = vi.fn(async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      if (hold) { hold = false; entered(); await held }
      await rename(from, to)
    })
    const f = await fixture({ replace: replacement }); await f.history.load(); await f.history.flush(); replacement.mockClear()
    f.live.push(row()); hold = true
    for (let i = 0; i < 1000; i++) f.history.markDirty()
    const writing = f.history.flush(); await reached
    expect(replacement).toHaveBeenCalledTimes(1)
    f.known.clear(); f.live.splice(0); f.history.sessionsChanged(); f.history.markDirty()
    expect(f.history.history(sid)).toEqual([])
    release(); await writing
    expect(replacement).toHaveBeenCalledTimes(2); expect((await f.saved()).rows).toEqual([])
    await f.history.close()
  })
  it('retains the last complete snapshot on write failure and continues live processing', async () => {
    const replacement = vi.fn(rename), f = await fixture({ replace: replacement }); await f.history.load()
    f.live.push(row()); f.history.markDirty(); await f.history.flush()
    replacement.mockRejectedValueOnce(new Error('Synthetic failure'))
    f.live.push(row(1)); f.history.markDirty(); await f.history.flush()
    expect(f.history.unavailable).toBe(true); expect((await f.saved()).rows).toEqual([row()])
    expect(await readdir(f.root)).toEqual([HOOK_HISTORY_FILE])
    f.history.markDirty(); await f.history.flush(); expect((await f.saved()).rows).toEqual([row(), row(1)]); await f.history.close()
  })
  it('reschedules a dirty event arriving between loop completion and writer release', async () => {
    let inject = false
    const f = await fixture({ replace: async (from, to) => {
      await rename(from, to)
      if (inject) {
        inject = false
        void Promise.resolve().then(() => undefined).then(() => { live.push(row(1)); history.markDirty() })
      }
    } })
    const history = f.history
    const live = f.live
    await history.load(); await history.flush()
    live.push(row()); inject = true; history.markDirty(); await history.flush()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await f.saved()).rows).toEqual([row(), row(1)])
    await history.close()
  })
})
