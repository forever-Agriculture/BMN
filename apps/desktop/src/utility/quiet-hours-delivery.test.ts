import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TELEGRAM_QUIET_HOURS, type AttentionRecord } from '@bmn/protocol'
import { QuietHoursDelivery, phoneField, type QuietChanges } from './quiet-hours-delivery'
import { TelegramConnectorError } from './telegram-connector'

function fixture() {
  let now = new Date('2026-10-07T23:00:00Z')
  let away = true
  let ready = true
  let stored: unknown
  const rows: AttentionRecord[] = []
  const mapped = new Set<string>()
  const markers = new Map<string, { heldAt: number; eligible: boolean }>()
  const attempts = new Map<string, number>()
  let pageBarrier: Promise<void> | undefined
  let failSettlement = false
  const retired: string[] = []
  let outcome: 'mapped' | 'unsent' | 'uncertain' | 'crash' = 'mapped'
  const summaries: string[] = []
  const sent: string[] = []
  let coordinator: QuietHoursDelivery
  const settings = { ...DEFAULT_TELEGRAM_QUIET_HOURS, enabled: true, allowKinds: [] as AttentionRecord['kind'][], allowSessions: [] as string[] }
  const summary = vi.fn(async (text: string) => { summaries.push(text) })
  const write = vi.fn(async (value: unknown, changes?: QuietChanges) => {
    if (changes?.hold) {
      const hold = changes.hold
      if (!rows.some(row => row.requestId === hold.requestId && row.revision === hold.revision && row.state === 'open' && !row.seenAt)) return false
      if (attempts.get(hold.requestId) === hold.revision) return false
      if (!markers.has(hold.requestId) || attempts.has(hold.requestId)) markers.set(hold.requestId, { heldAt: hold.heldAt, eligible: false })
      attempts.delete(hold.requestId)
    }
    if (changes?.claim) {
      const claim = changes.claim
      if (!rows.some(row => row.requestId === claim.requestId && row.revision === claim.revision && row.state === 'open' && !row.seenAt) ||
        !markers.has(claim.requestId) || attempts.has(claim.requestId)) return false
      attempts.set(claim.requestId, claim.revision)
    }
    if (changes?.unclaim && attempts.get(changes.unclaim.requestId) === changes.unclaim.revision) attempts.delete(changes.unclaim.requestId)
    if (changes?.release) for (const marker of markers.values()) marker.eligible = true
    for (const item of changes?.clear ?? []) if (rows.some(row => row.requestId === item.requestId && row.revision === item.revision)) markers.delete(item.requestId)
    stored = structuredClone(value)
    return true
  })
  const read = vi.fn(async () => stored)
  const current = vi.fn(async (id: string) => rows.find(row => row.requestId === id) ?? null)
  const make = (): QuietHoursDelivery => new QuietHoursDelivery({
    read, write, settings: () => settings, now: () => now, timeZone: 'UTC', ownerAway: () => away,
    ready: () => ready, requests: async () => rows.filter(row => markers.has(row.requestId) && !attempts.has(row.requestId)).map(record => ({ record, ...markers.get(record.requestId)! })), current,
    retire: record => { retired.push(record.requestId) },
    mapped: async (id, revision) => mapped.has(`${id}:${revision}`) || attempts.get(id) === revision, sessionName: () => 'Work /home/owner/repo', home: '/home/owner',
    sendSummary: summary, changed: () => undefined,
    page: async record => {
      const decision = await coordinator.before(record)
      if (decision.action !== 'send') return decision.action === 'consumed'
      sent.push(record.requestId)
      await pageBarrier
      if (failSettlement) write.mockRejectedValueOnce(new Error('synthetic settlement failure'))
      if (outcome === 'mapped') mapped.add(`${record.requestId}:${record.revision}`)
      if (outcome !== 'crash') await coordinator.settle(decision.claim, outcome)
      return true
    }
  })
  coordinator = make()
  const add = (n: number): AttentionRecord => {
    const row = { requestId: `r${String(n).padStart(3, '0')}`, sessionId: 's1', incarnationId: null, revision: 1,
      kind: 'question', state: 'open', seenAt: null, openedAt: new Date(now.getTime() + n).toISOString(),
      title: `Question ${n} /home/owner/private`, body: null, expiresAt: null } as AttentionRecord
    rows.push(row); return row
  }
  return { get coordinator() { return coordinator }, add, rows, summaries, sent, retired, markers, attempts, write, read, current, settings, summary,
    outcome: (value: typeof outcome) => { outcome = value },
    barrier: (value: Promise<void>) => { pageBarrier = value },
    failSettlement: () => { failSettlement = true },
    seed: (value: unknown) => {
      stored = structuredClone(value)
      const entries = (value as { entries?: Array<{ requestId?: string }> }).entries ?? []
      for (const entry of entries) if (entry.requestId) markers.set(entry.requestId, { heldAt: 1, eligible: true })
      coordinator = make()
    },
    stored: () => stored, restart: () => { coordinator = make() },
    time: (value: string) => { now = new Date(value) }, away: (value: boolean) => { away = value }, ready: (value: boolean) => { ready = value } }
}

describe('quiet delivery authority', () => {
  it('counts a navigation-withdrawn held notice as closed and releases the unanswered question', async () => {
    const f = fixture(), notice = f.add(1), question = f.add(2)
    notice.kind = 'notice'
    await f.coordinator.hold(notice); await f.coordinator.hold(question)
    notice.state = 'withdrawn'; notice.resolvedBy = 'owner'; notice.resolution = 'Opened in BMN; reminder cleared'
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    expect(f.sent).toEqual([question.requestId])
    expect(f.summaries[0]).toContain('1 answered, seen or closed')
  })

  it('prunes closed uncertainty tombstones so 200 historical failures cannot block a new request', async () => {
    const f = fixture(); f.settings.enabled = false
    const entries = Array.from({ length: 200 }, (_, n) => {
      const row = f.add(n); row.state = 'answered'; row.revision = 2
      return { requestId: row.requestId, revision: 1, kind: 'question', heldAt: 1, phase: 'uncertain' }
    })
    f.seed({ version: 1, window: null, summaryHighWater: 0, entries })
    await f.coordinator.status()
    expect((await f.coordinator.before(f.add(200))).action).toBe('send')
    expect((f.stored() as { entries: unknown[] }).entries.length).toBeLessThan(200)
  })

  it('reports unreadable history explicitly instead of omitting quiet delivery status', async () => {
    const f = fixture(); f.read.mockRejectedValueOnce(new Error('Synthetic disk read failed'))
    expect(await f.coordinator.status()).toMatchObject({ problem: 'history-unavailable' })
    expect(f.write).not.toHaveBeenCalled()
    f.seed({ version: 'corrupt' })
    expect(await f.coordinator.status()).toMatchObject({ problem: 'history-unavailable' })
    expect(f.write).not.toHaveBeenCalled()
  })

  it('never prunes an uncertain claim merely because the request read rejects', async () => {
    const f = fixture(), row = f.add(1); f.settings.enabled = false
    f.seed({ version: 1, window: null, summaryHighWater: 0, entries: [
      { requestId: row.requestId, revision: 1, kind: 'question', heldAt: 1, phase: 'uncertain' }
    ] })
    f.current.mockRejectedValueOnce(new Error('Synthetic request read failed'))
    await f.coordinator.status()
    expect(await f.coordinator.before(row)).toEqual({ action: 'consumed' })
    expect((f.stored() as { entries: unknown[] }).entries).toHaveLength(1)
  })
  it('does not adopt an old unrelated request that had already exhausted desktop paging', async () => {
    const f = fixture(), old = f.add(0), held = f.add(1)
    old.openedAt = '2026-10-01T12:00:00Z'
    await f.coordinator.hold(held)
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    expect(f.sent).toEqual([held.requestId])
  })
  it('honors kind and session allow-through without granting exits a request kind', async () => {
    const f = fixture(), row = f.add(1)
    f.settings.allowKinds = ['question']
    expect(await f.coordinator.hold(row)).toBe(false)
    expect(await f.coordinator.holdExit('s1', 'i1')).toBe(true)
    f.settings.allowKinds = []; f.settings.allowSessions = ['s1']
    expect(await f.coordinator.hold(row)).toBe(false)
    expect(await f.coordinator.holdExit('s1', 'i2')).toBe(false)
  })

  it('counts overflow exits without storing their text or losing pending requests', async () => {
    const f = fixture()
    for (let n = 0; n < 201; n += 1) await f.coordinator.hold(f.add(n))
    expect(await f.coordinator.holdExit('exited', 'incarnation')).toBe(true)
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    expect(f.summaries[0]).toContain('1 more session exits')
    expect(f.sent).toHaveLength(10)
  })

  it.each([false, true])('keeps uncertain summaries consumed, but retries definite refusal (refused=%s)', async refused => {
    const f = fixture(); await f.coordinator.hold(f.add(1))
    f.summary.mockRejectedValueOnce(refused ? new TelegramConnectorError('http', 'refused', 429) : new Error('connection lost'))
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    expect(f.summary).toHaveBeenCalledTimes(1)
    f.restart(); f.time('2026-10-08T07:00:30Z'); await f.coordinator.sweep(true)
    expect(f.summary).toHaveBeenCalledTimes(refused ? 2 : 1)
    expect(f.sent).toHaveLength(1)
  })

  it('expires desktop departure eligibility after ten minutes without changing the request', async () => {
    const f = fixture(), row = f.add(1); await f.coordinator.hold(row)
    f.away(false); f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.away(true); f.time('2026-10-08T07:11:00Z'); await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(0); expect(f.summaries).toHaveLength(0); expect(row.state).toBe('open')
  })

  it('does not send a request that expires at the final boundary', async () => {
    const f = fixture(), row = f.add(1); f.settings.enabled = false
    row.expiresAt = '2026-10-07T23:00:00Z'
    expect(await f.coordinator.before(row)).toEqual({ action: 'consumed' })
    expect(f.coordinator.maySend(row)).toBe(false)
  })
  it('holds 201 unchanged requests, stores no text, and releases one summary then groups of ten', async () => {
    const f = fixture()
    for (let n = 0; n < 201; n += 1) { const row = f.add(n); const copy = structuredClone(row); expect(await f.coordinator.hold(row)).toBe(true); expect(row).toEqual(copy) }
    const ledger = f.stored() as { entries: unknown[] }
    expect(ledger.entries).toHaveLength(200)
    expect(JSON.stringify(ledger)).not.toContain('private')
    expect((await f.coordinator.status()).waiting).toBe(201)
    f.restart()
    f.time('2026-10-08T07:00:00Z')
    await Promise.all([f.coordinator.sweep(true), f.coordinator.flush()])
    expect(f.summaries).toHaveLength(1)
    expect(f.summaries[0]).toContain('~/private')
    expect(f.summaries[0]).not.toContain('/home/owner')
    expect(f.summaries[0]!.length).toBeLessThanOrEqual(4096)
    expect(f.sent).toHaveLength(10)
    f.time('2026-10-08T07:00:30Z'); await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(20)
    f.restart()
    for (let i = 0; i < 19; i += 1) { f.time(new Date(Date.parse('2026-10-08T07:01:00Z') + i * 30_000).toISOString()); await f.coordinator.sweep(true) }
    expect(f.sent).toHaveLength(201)
    expect(new Set(f.sent).size).toBe(201)
    expect(f.summaries).toHaveLength(1)
  })

  it('never replays a claim after a crash, and leaves a later revision outside quiet hours ordinary', async () => {
    const f = fixture(), row = f.add(1)
    await f.coordinator.hold(row); f.outcome('crash')
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(1)
    f.restart(); await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(1)
    expect((await f.coordinator.status()).requests[row.requestId]).toBe('uncertain')
    row.revision += 1
    expect(await f.coordinator.before(row)).toEqual({ action: 'send', claim: null })
    expect((await f.coordinator.status()).uncertainRevisions[row.requestId]).toEqual([1])
  })

  it('retains all 201 requests when 200 sends are uncertain, without blocking ordinary cards', async () => {
    const f = fixture(); f.outcome('uncertain')
    for (let n = 0; n < 201; n += 1) await f.coordinator.hold(f.add(n))
    f.time('2026-10-08T07:00:00Z')
    for (let n = 0; n < 21; n += 1) await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(200)
    expect(f.markers.size).toBe(1); expect(f.attempts.size).toBe(200)
    expect((await f.coordinator.status()).capacityBlocked).toBe(true)
    const ordinary = f.add(202)
    expect(await f.coordinator.before(ordinary)).toEqual({ action: 'send', claim: null })
    f.rows[0]!.state = 'answered'; await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(201)
  })

  it('returns a definitely unsent managed card to pending and stops on failed persistence', async () => {
    const f = fixture(), row = f.add(1); await f.coordinator.hold(row)
    f.outcome('unsent'); f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(1)
    f.write.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(f.coordinator.sweep(true)).rejects.toThrow('disk unavailable')
    expect(f.sent).toHaveLength(1)
    f.outcome('mapped'); await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(2); expect(f.markers.size).toBe(0)
  })

  it('keeps ordinary paging independent of corrupt history, ledger capacity and restart readiness', async () => {
    const f = fixture(); f.settings.enabled = false; f.ready(false)
    f.seed({ version: 'corrupt' })
    const row = f.add(1)
    expect(await f.coordinator.before(row)).toEqual({ action: 'send', claim: null })
    expect(f.coordinator.maySend(row, false)).toBe(true)
    expect(f.write).not.toHaveBeenCalled()
  })

  it('never adopts a retired reminder next night or another request with the same opening time', async () => {
    const f = fixture(), old = f.add(1), unrelated = f.add(2)
    unrelated.openedAt = old.openedAt
    await f.coordinator.hold(old)
    f.away(false); f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-08T07:11:00Z'); await f.coordinator.sweep(true)
    expect(f.markers.size).toBe(0)
    f.restart(); f.away(true); f.time('2026-10-08T23:00:00Z')
    const fresh = f.add(3); await f.coordinator.hold(fresh)
    f.time('2026-10-09T07:00:00Z'); await f.coordinator.sweep(true)
    expect(f.sent).toEqual([fresh.requestId])
    expect(f.retired).toEqual([old.requestId])
    expect(old.state).toBe('open'); expect(old.revision).toBe(1); expect(old.seenAt).toBeNull()
  })

  it('preserves an eligible outage backlog across restart and a later desktop quiet-window end', async () => {
    const f = fixture(), old = f.add(1); await f.coordinator.hold(old)
    f.ready(false); f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.restart(); f.time('2026-10-08T23:00:00Z'); const recent = f.add(2); await f.coordinator.hold(recent)
    f.away(false); f.time('2026-10-09T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-09T07:11:00Z'); await f.coordinator.sweep(true)
    f.away(true); f.ready(true); await f.coordinator.sweep(true)
    expect(f.sent).toEqual([old.requestId]); expect(f.retired).toEqual([recent.requestId])
  })

  it('allows only later timer sweeps to release more groups, even when the clock goes backwards', async () => {
    const f = fixture()
    for (let n = 0; n < 25; n += 1) await f.coordinator.hold(f.add(n))
    f.time('2026-10-08T08:00:00Z'); await f.coordinator.sweep()
    expect(f.sent).toHaveLength(10)
    await f.coordinator.sweep(); await f.coordinator.flush(); expect(f.sent).toHaveLength(10)
    f.time('2026-10-08T07:30:00Z'); await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(20)
    f.restart(); await f.coordinator.sweep(); expect(f.sent).toHaveLength(20)
    await f.coordinator.sweep(true); expect(f.sent).toHaveLength(25)
  })

  it('counts desktop departure from the window end and excludes seen/closed requests', async () => {
    const f = fixture(), one = f.add(1), two = f.add(2), three = f.add(3)
    for (const row of f.rows) await f.coordinator.hold(row)
    two.seenAt = '2026-10-08T06:00:00Z'; three.state = 'answered'
    f.away(false); f.time('2026-10-08T07:00:00Z')
    await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(0)
    f.time('2026-10-08T07:09:00Z'); f.away(true)
    await f.coordinator.sweep(true)
    expect(f.sent).toEqual([one.requestId])
    expect(f.summaries[0]).toContain('2 answered, seen or closed')
  })

  it('requires restart cleanup readiness and recovers the current revision after a missed end', async () => {
    const f = fixture(), row = f.add(1)
    await f.coordinator.hold(row)
    row.revision = 2
    f.restart(); f.time('2026-10-08T08:00:00Z'); f.ready(false)
    await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(0)
    f.ready(true); await f.coordinator.sweep(true)
    expect(f.sent).toEqual([row.requestId])
    expect(f.summaries).toHaveLength(1)
  })

  it('allows an already held request through after the owner adds a kind exception', async () => {
    const f = fixture(), row = f.add(1); await f.coordinator.hold(row)
    f.settings.allowKinds = ['question']
    const decision = await f.coordinator.before(row)
    expect(decision.action).toBe('send')
    if (decision.action !== 'send') throw new Error('Allowed request held')
    expect(decision.claim).not.toBeNull()
    await f.coordinator.settle(decision.claim, 'mapped')
    expect(f.markers.size).toBe(0)
  })

  it('retires an empty consumed window without rewriting history on every later sweep', async () => {
    const f = fixture(); await f.coordinator.hold(f.add(1))
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true); await f.coordinator.sweep(true)
    const writes = f.write.mock.calls.length
    await f.coordinator.sweep(true); await f.coordinator.sweep(true)
    expect(f.write).toHaveBeenCalledTimes(writes)
    expect((f.stored() as { window: unknown }).window).toBeNull()
  })

  it('cleans consumed summary exits after a restart between summary claim and settlement', async () => {
    const f = fixture()
    f.seed({ version: 1, entries: [{ sessionId: 'gone', incarnationId: null, heldAt: 1, phase: 'held' }], summaryHighWater: 1,
      window: { key: 'past', beganAt: 1, endsAt: 2, summary: 'claimed', eligible: true, overflowExits: 1 } })
    f.settings.enabled = false; await f.coordinator.sweep(true)
    expect((await f.coordinator.status()).waiting).toBe(0)
    expect(f.summaries).toEqual([])
  })

  it.each([false, true])('retires the next desktop night despite an older uncertain marker (revised=%s)', async revised => {
    const f = fixture(), row = f.add(1)
    await f.coordinator.hold(row); f.outcome('uncertain')
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-08T23:00:00Z'); await f.coordinator.holdExit('s2', 'i2')
    if (revised) { row.revision++; await f.coordinator.hold(row) }
    f.away(false); f.time('2026-10-09T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-09T07:11:00Z'); await f.coordinator.sweep(true)
    f.restart(); f.away(true); f.time('2026-10-09T15:00:00Z'); await f.coordinator.sweep(true)
    expect(f.summaries).toHaveLength(1)
    expect(f.sent).toEqual([row.requestId])
  })

  it('retains an allow-through uncertain claim after desk retirement and restart', async () => {
    const f = fixture(), row = f.add(1); await f.coordinator.hold(row)
    f.settings.allowKinds = ['question']
    const claim = await f.coordinator.before(row)
    if (claim.action !== 'send' || !claim.claim) throw new Error('Expected a managed allow-through send')
    await f.coordinator.settle(claim.claim, 'uncertain')
    f.away(false); f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-08T07:11:00Z'); await f.coordinator.sweep(true)
    f.restart(); f.away(true)
    expect(await f.coordinator.before(row)).toEqual({ action: 'consumed' })
  })

  it('pages a later revision ordinarily outside quiet hours even with corrupt history and readiness false', async () => {
    const f = fixture(), row = f.add(1); await f.coordinator.hold(row); f.outcome('uncertain')
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    row.revision++; f.ready(false); f.seed({ version: 'corrupt' })
    const writes = f.write.mock.calls.length
    expect(await f.coordinator.before(row)).toEqual({ action: 'send', claim: null })
    expect(f.write).toHaveBeenCalledTimes(writes)
  })

  it('never re-holds an already attempted exact revision the next night', async () => {
    const f = fixture(), row = f.add(1); await f.coordinator.hold(row); f.outcome('uncertain')
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-08T23:00:00Z')
    expect(await f.coordinator.hold(row)).toBe(false)
    f.markers.delete(row.requestId); f.seed({ version: 'corrupt' })
    expect(await f.coordinator.before(row)).toEqual({ action: 'consumed' })
  })

  it('does not name new-night exits in a carried outage summary after desktop expiry', async () => {
    const f = fixture(), row = f.add(1); await f.coordinator.hold(row); f.ready(false)
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-08T23:00:00Z'); await f.coordinator.holdExit('s2', 'i2')
    f.away(false); f.time('2026-10-09T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-09T07:11:00Z'); await f.coordinator.sweep(true)
    f.away(true); f.ready(true); await f.coordinator.sweep(true)
    expect(f.summaries).toHaveLength(1); expect(f.summaries[0]).not.toContain('Exited:')
    expect(f.sent).toEqual([row.requestId])
  })

  it('holds a new revision afresh and sends it once at an away end', async () => {
    const f = fixture(), row = f.add(1); await f.coordinator.hold(row); f.outcome('uncertain')
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-08T23:00:00Z'); row.revision++; await f.coordinator.hold(row)
    expect(f.markers.get(row.requestId)?.eligible).toBe(false)
    f.time('2026-10-09T07:00:00Z'); f.outcome('mapped'); await f.coordinator.sweep(true)
    f.restart(); await f.coordinator.sweep(true)
    expect(f.sent).toEqual([row.requestId, row.requestId])
  })

  it('keeps a never-attempted eligible revision owed when revised during a later night', async () => {
    const f = fixture(), row = f.add(1); await f.coordinator.hold(row); f.ready(false)
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-08T23:00:00Z'); row.revision++; await f.coordinator.hold(row)
    expect(f.markers.get(row.requestId)?.eligible).toBe(true)
    f.away(false); f.time('2026-10-09T07:11:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-09T07:22:00Z'); await f.coordinator.sweep(true)
    f.away(true); f.ready(true); await f.coordinator.sweep(true)
    expect(f.sent).toEqual([row.requestId]); expect(f.attempts.get(row.requestId)).toBe(2)
  })

  it('keeps a failed unclaim uncertain across restart', async () => {
    const f = fixture(), row = f.add(1); await f.coordinator.hold(row); f.outcome('unsent'); f.failSettlement()
    f.time('2026-10-08T07:00:00Z'); await expect(f.coordinator.sweep(true)).rejects.toThrow('synthetic settlement failure')
    f.restart(); await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(1)
    expect((await f.coordinator.status()).requests[row.requestId]).toBe('uncertain')
  })

  it('keeps an in-flight claim window until a definitely unsent result restores membership', async () => {
    const f = fixture(), row = f.add(1); await f.coordinator.hold(row); f.outcome('unsent')
    let release!: () => void; f.barrier(new Promise<void>(resolve => { release = resolve }))
    f.time('2026-10-08T07:00:00Z'); const first = f.coordinator.sweep(true)
    await vi.waitFor(() => expect(f.sent).toHaveLength(1))
    const overlapping = f.coordinator.sweep(true)
    release(); await Promise.all([first, overlapping])
    f.outcome('mapped'); await f.coordinator.sweep(true)
    expect(f.sent).toHaveLength(2)
  })

  it('releases a newly held request when a backward clock change re-enters an already observed window', async () => {
    const f = fixture(), first = f.add(1); await f.coordinator.hold(first)
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-08T06:59:00Z'); const second = f.add(2); await f.coordinator.hold(second)
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    expect(f.sent).toEqual([first.requestId, second.requestId])
    expect(f.summaries).toHaveLength(1)
  })

  it('retires an expired prior night when the first cold-start observation is a later-night hold', async () => {
    const f = fixture(); await f.coordinator.hold(f.add(1)); await f.coordinator.holdExit('s2', 'i2')
    f.restart(); f.away(false); f.time('2026-10-08T23:00:00Z'); await f.coordinator.hold(f.add(2))
    f.time('2026-10-09T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-09T07:11:00Z'); await f.coordinator.sweep(true)
    f.away(true); f.time('2026-10-09T15:00:00Z'); await f.coordinator.sweep(true)
    expect(f.summaries).toEqual([]); expect(f.sent).toEqual([])
  })

  it.each(['2026-10-08T06:59:00Z', '2026-10-07T22:30:00Z'])('separates carried exit history from a re-entered desktop night at %s', async rewind => {
    const f = fixture(), old = f.add(1); await f.coordinator.hold(old)
    await f.coordinator.holdExit('old-exit', 'i1'); f.ready(false)
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time(rewind); const recent = f.add(2); await f.coordinator.hold(recent)
    await f.coordinator.holdExit('new-exit', 'i2')
    f.restart(); f.away(false); f.time('2026-10-08T07:11:00Z'); await f.coordinator.sweep(true)
    f.away(true); f.ready(true); await f.coordinator.sweep(true)
    expect(f.sent).toEqual([old.requestId]); expect(f.retired).toEqual([recent.requestId])
    expect(f.summaries).toHaveLength(1)
    // Both synthetic sessions share a label: exactly one retained exit must be named.
    expect(f.summaries[0]!.split('Exited: ')[1]).toBe('Work ~/repo')
  })

  it('does not revive a cold-start expired night when the new night ends away', async () => {
    const f = fixture(), old = f.add(1); await f.coordinator.hold(old)
    f.restart(); f.away(false); f.time('2026-10-08T23:00:00Z')
    const recent = f.add(2); await f.coordinator.hold(recent)
    f.away(true); f.time('2026-10-09T07:00:00Z'); await f.coordinator.sweep(true)
    expect(f.sent).toEqual([recent.requestId]); expect(f.retired).toEqual([old.requestId])
  })

  it.each([true, false])('does not carry desktop-grace history through clock reentry (exit=%s)', async exit => {
    const f = fixture(), one = f.add(1); await f.coordinator.hold(one)
    if (exit) await f.coordinator.holdExit('s2', 'i2')
    f.away(false); f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-08T06:58:00Z'); const two = f.add(2); await f.coordinator.hold(two)
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-08T07:11:00Z'); await f.coordinator.sweep(true)
    f.restart(); f.away(true); f.time('2026-10-08T15:00:00Z'); await f.coordinator.sweep(true)
    expect(f.summaries).toEqual([]); expect(f.sent).toEqual([])
    expect(f.retired).toEqual([one.requestId, two.requestId])
  })

  it('does not carry desktop history after quiet hours are disabled then re-enabled', async () => {
    const f = fixture(); await f.coordinator.hold(f.add(1)); await f.coordinator.holdExit('s2', 'i2')
    f.away(false); f.settings.enabled = false; await f.coordinator.sweep(true)
    f.settings.enabled = true; await f.coordinator.hold(f.add(2))
    f.time('2026-10-08T07:11:00Z'); await f.coordinator.sweep(true)
    f.away(true); f.time('2026-10-08T15:00:00Z'); await f.coordinator.sweep(true)
    expect(f.summaries).toEqual([]); expect(f.sent).toEqual([])
  })

  it('preserves older owed exits but retires current overflow during desk-grace reentry', async () => {
    const f = fixture(); await f.coordinator.holdExit('old-exit', 'old'); f.ready(false)
    f.time('2026-10-08T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-08T23:00:00Z')
    for (let n = 0; n < 200; n++) await f.coordinator.holdExit(`recent-${n}`, `i${n}`)
    f.away(false); f.time('2026-10-09T07:00:00Z'); await f.coordinator.sweep(true)
    f.time('2026-10-09T06:58:00Z'); await f.coordinator.hold(f.add(1))
    f.time('2026-10-09T07:11:00Z'); await f.coordinator.sweep(true)
    f.away(true); f.ready(true); await f.coordinator.sweep(true)
    expect(f.summaries).toHaveLength(1)
    expect(f.summaries[0]!.split('Exited: ')[1]).toBe('Work ~/repo')
    expect(f.summaries[0]).not.toContain('more session exits')
    expect(f.sent).toEqual([])
  })

  it('masks secrets and normalizes embedded paths before clipping', () => {
    expect(phoneField('See /home/owner/project and /home/owner/file', '/home/owner')).toBe('See ~/project and ~/file')
  })
})
