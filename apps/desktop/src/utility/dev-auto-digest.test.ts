import { describe, expect, it, vi } from 'vitest'
import type { DevAutoRun } from '@bmn/protocol'
import { buildMorningDigest, DevAutoMorningDigest, type DigestSnapshot } from './dev-auto-digest'
import { TelegramConnectorError } from './telegram-connector'

function run(overrides: Partial<DevAutoRun> = {}): DevAutoRun {
  return { workspaceIds: ['w'], checkout: '/home/owner/project', branch: 'epic-57', project: 'Epics 57', status: 'ACTIVE',
    nextAction: 'Implement', decisions: [], omittedDecisions: 0, finished: false, ownership: 'own', ownerCheckout: '/home/owner/project',
    ownerBranch: 'epic-57', unavailable: null, board: { checkout: '/home/owner/project', rows: [], unavailable: null }, ownerItems: [], ...overrides }
}
function snapshot(runs: DevAutoRun[] = []): DigestSnapshot {
  return { result: { runs, skipped: 0, issues: [], observedAt: '2026-10-07T08:00:00Z' }, workspaceNames: { w: 'Work /home/owner/work' } }
}
function fixture() {
  let now = new Date(2026, 9, 7, 8, 0), monotonic = 0, stored: unknown, ready = true, quiet = false
  const settings = { enabled: true, time: '08:00' }
  const read = vi.fn(async () => stored)
  const write = vi.fn(async (value: unknown) => { stored = structuredClone(value) })
  const fetch = vi.fn(async () => snapshot([run({ decisions: ['Keep scope small'] })]))
  const send = vi.fn(async (...args: [string]) => { void args; return undefined })
  const make = (): DevAutoMorningDigest => new DevAutoMorningDigest({ read, write, settings: () => settings, ready: () => ready,
    quiet: () => quiet, now: () => now, monotonic: () => monotonic, home: '/home/owner', snapshot: fetch, send })
  let digest = make()
  return { get digest() { return digest }, read, write, fetch, send, settings, stored: () => stored,
    restart: () => { digest = make() }, time: (day: number, hour = 8, minute = 0) => { now = new Date(2026, 9, day, hour, minute); monotonic += 600_000 },
    quiet: (value: boolean) => { quiet = value }, ready: (value: boolean) => { ready = value } }
}

describe('morning digest content', () => {
  it('assigns four sections, detects later changes and omits removed decisions', () => {
    const first = buildMorningDigest(snapshot([run({ decisions: ['First', 'Removed'] })]), [], '/home/owner')
    const next = buildMorningDigest(snapshot([
      run({ status: 'COMPLETE', finished: true, decisions: ['First', 'Second'] }),
      run({ checkout: '/paused', branch: 'paused', status: 'PAUSED — owner stop', ownerItems: [{ sessionId: 's', requestId: 'r', title: 'Choose a database' }] }),
      run({ checkout: '/blocked', branch: 'blocked', status: 'BLOCKED — missing test access' }),
      run({ checkout: '/copied', ownership: 'copy', status: 'BLOCKED — must be ignored' })
    ]), first.runs, '/home/owner')
    for (const heading of ['Done', 'Decided for you', 'Waiting on you', 'Blocked']) expect(next.text).toContain(heading)
    expect(next.text).toContain('Second'); expect(next.text).not.toContain('First'); expect(next.text).not.toContain('Removed')
    expect(next.text).toContain('Choose a database'); expect(next.text).not.toContain('must be ignored')
    const unchanged = buildMorningDigest(snapshot([run({ status: 'COMPLETE', finished: true, decisions: ['First', 'Second'] })]), next.runs, '/home/owner')
    expect(unchanged.text).toBe('No dev-auto changes.')
  })

  it('reports incomplete sources instead of claiming no change', () => {
    const data = snapshot([run({ unavailable: 'File unreadable' }), run({ checkout: '/missing', status: null }), run({ checkout: '/clipped', truncatedFields: 1 })])
    data.result.skipped = 2
    const result = buildMorningDigest(data, [], '/home/owner')
    expect(result.text).toContain('Incomplete:'); expect(result.text).not.toBe('No dev-auto changes.')
  })

  it('retains known fingerprints across incomplete discovery instead of reporting a second completion', () => {
    const complete = snapshot([run({ status: 'COMPLETE', finished: true, decisions: ['Retained'] })])
    const first = buildMorningDigest(complete, [], '/home/owner')
    const unavailable = snapshot(); unavailable.result.skipped = 1
    const missing = buildMorningDigest(unavailable, first.runs, '/home/owner')
    expect(missing.text).toContain('Incomplete:')
    expect(buildMorningDigest(complete, missing.runs, '/home/owner').text).toBe('No dev-auto changes.')
  })

  it('masks all phone fields and normalizes home paths before clipping', () => {
    const key = `sk-ant-${'A'.repeat(95)}`
    const result = buildMorningDigest(snapshot([run({ status: `BLOCKED — /home/owner/status ${key}`, decisions: [`/home/owner/choice ${key}`],
      branch: '/home/owner/branch', project: '/home/owner/epics', ownerItems: [{ sessionId: 's', requestId: 'r', title: `/home/owner/title ${key}` }] })]), [], '/home/owner')
    expect(result.text).not.toContain(key); expect(result.text).not.toContain('/home/owner')
    for (const field of ['~/status', '~/choice', '~/branch', '~/epics', '~/title', '~/work']) expect(result.text).toContain(field)
    expect(JSON.stringify(result.runs)).not.toContain('owner'); expect(JSON.stringify(result.runs)).not.toContain(key)
  })

  it('keeps the message bounded and names the items left on the laptop', () => {
    const result = buildMorningDigest(snapshot(Array.from({ length: 2049 }, (_, n) => run({ checkout: `/work/${n}`, decisions: ['Long choice '.repeat(100)] }))), [], '/home/owner')
    expect(result.text.length).toBeLessThanOrEqual(4096)
    expect(result.text).toContain('more on the laptop'); expect(result.text).toContain('Incomplete:')
    expect(result.runs).toHaveLength(2048)
  })
})

describe('morning digest durable daily claim', () => {
  it('sends once on concurrent sweeps and restart, skips missed days and clock rollback', async () => {
    const f = fixture()
    await Promise.all([f.digest.sweep(), f.digest.sweep()]); expect(f.send).toHaveBeenCalledTimes(1)
    f.restart(); await f.digest.sweep(); expect(f.send).toHaveBeenCalledTimes(1)
    f.time(10); await f.digest.sweep(); expect(f.send).toHaveBeenCalledTimes(2)
    f.time(9); await f.digest.sweep(); expect(f.send).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(f.stored())).not.toContain('Keep scope small')
  })

  it('does not read or send when disabled, disconnected, before the time or during quiet hours', async () => {
    const f = fixture(); f.settings.enabled = false; await f.digest.sweep()
    f.settings.enabled = true; f.ready(false); await f.digest.sweep()
    f.ready(true); f.time(7, 7); await f.digest.sweep()
    f.time(7, 8); f.quiet(true); await f.digest.sweep()
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
    f.quiet(false); await f.digest.sweep(); expect(f.send).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('retries only definitely unsent failures and throttles reads (definite=%s)', async definite => {
    const f = fixture(); f.send.mockRejectedValueOnce(definite ? new TelegramConnectorError('http', 'synthetic refusal', 429) : new Error('synthetic lost response'))
    await f.digest.sweep(); await f.digest.sweep(); expect(f.fetch).toHaveBeenCalledTimes(1)
    f.time(7, 8, 10); await f.digest.sweep()
    expect(f.send).toHaveBeenCalledTimes(definite ? 2 : 1)
    f.restart(); await f.digest.sweep(); expect(f.send).toHaveBeenCalledTimes(definite ? 2 : 1)
  })

  it('never sends before durable claim success or after settings change during persistence', async () => {
    const f = fixture(); f.write.mockRejectedValueOnce(new Error('disk failed'))
    await expect(f.digest.sweep()).rejects.toThrow('disk failed'); expect(f.send).not.toHaveBeenCalled()
    f.time(7, 8, 10); f.write.mockImplementationOnce(async () => { f.settings.enabled = false })
    await f.digest.sweep(); expect(f.send).not.toHaveBeenCalled()
  })

  it('keeps a claim consumed if the process is replaced after persistence but before send', async () => {
    const f = fixture()
    f.send.mockImplementationOnce(async () => { throw new Error('process disappeared') })
    await f.digest.sweep(); f.restart(); await f.digest.sweep()
    expect(f.send).toHaveBeenCalledTimes(1)
  })
})
