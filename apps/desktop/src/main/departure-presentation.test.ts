// MODULE: departure-presentation.test.ts - cross-window reservation, actual-show acknowledgment and retained-period receipt
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_GRANT_RECORD, newDepartureCollection, ownerGrantView, startDeparture, type OwnerDepartureReply } from '@bmn/protocol'
import { DeparturePresentation } from './departure-presentation'
const AT = '2026-11-17T19:00:00.000Z'
function fixture() {
  const record = startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'app', agentSessionId: null, periodId: 'p', collection: newDepartureCollection([], AT) }, 'back', AT).record
  let view = ownerGrantView({ state: 'read', record }), focus = 1
  const saved: string[] = [], delayed = Promise.withResolvers<void>()
  let hold = false
  const host = new DeparturePresentation({ view: async () => view, focused: sender => sender === focus,
    save: async period => { saved.push(period); if (hold) await delayed.promise; return { view, outcome: 'changed' } as OwnerDepartureReply } })
  return { host, saved, delayed, set focus(value: number) { focus = value }, set view(value: typeof view) { view = value }, get view() { return view }, set hold(value: boolean) { hold = value } }
}
describe('desktop departure presentation', () => {
  it('holds the one opening through a delayed acknowledgment and a focus handoff', async () => {
    const f = fixture()
    const permit = await f.host.act(1, { action: 'reserve', periodId: 'p' })
    expect(permit.token).not.toBeNull(); expect(f.saved).toEqual([])
    f.hold = true
    const ack = f.host.act(1, { action: 'ack', periodId: 'p', token: permit.token! })
    f.focus = 2
    expect((await f.host.act(2, { action: 'reserve', periodId: 'p' })).token).toBeNull()
    await f.host.act(1, { action: 'decline', periodId: 'p', token: permit.token! })
    expect((await f.host.act(2, { action: 'reserve', periodId: 'p' })).token).toBeNull()
    f.delayed.resolve(); await ack; expect(f.saved).toEqual(['p'])
  })
  it('frees a confirmed pre-show decline and fences another sender or token', async () => {
    const f = fixture(), permit = await f.host.act(1, { action: 'reserve', periodId: 'p' })
    await f.host.act(2, { action: 'ack', periodId: 'p', token: permit.token! })
    expect(f.saved).toEqual([])
    await f.host.act(1, { action: 'decline', periodId: 'p', token: permit.token! })
    f.focus = 2
    expect((await f.host.act(2, { action: 'reserve', periodId: 'p' })).token).not.toBeNull()
  })
  it('wakes a focused contender after a confirmed pre-show decline', async () => {
    const f = fixture()
    let focused = 1, secondToken: string | null = null
    const host = new DeparturePresentation({ view: async () => f.view, focused: sender => sender === focused,
      save: async () => ({ view: f.view } as OwnerDepartureReply),
      released: () => { void host.act(2, { action: 'reserve', periodId: 'p' }).then(result => { secondToken = result.token }) }
    })
    const first = await host.act(1, { action: 'reserve', periodId: 'p' })
    focused = 2
    expect((await host.act(2, { action: 'reserve', periodId: 'p' })).token).toBeNull()
    await host.act(1, { action: 'decline', periodId: 'p', token: first.token! })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(secondToken).not.toBeNull()
  })
  it('keeps a new automatic reservation when an older manual show is acknowledged', async () => {
    const f = fixture()
    const manual = await f.host.act(1, { action: 'manual', periodId: 'p' })
    expect(manual.token).not.toBeNull()
    f.view = { ...f.view, revision: f.view.revision + 1, period: { ...f.view.period!, periodId: 'next' } }
    f.focus = 2
    const next = await f.host.act(2, { action: 'reserve', periodId: 'next' })
    expect(next.token).not.toBeNull()
    expect((await f.host.act(1, { action: 'manual', periodId: 'p' })).token).toBeNull()
    await f.host.act(1, { action: 'ack', periodId: 'p', token: manual.token! })
    await f.host.act(2, { action: 'ack', periodId: 'next', token: next.token! })
    expect(f.saved).toEqual(['p', 'next'])
    f.focus = 3
    expect((await f.host.act(3, { action: 'reserve', periodId: 'next' })).token).toBeNull()
  })
  it('treats an old mixed openedAt as unknown and a verified receipt as already shown', async () => {
    const f = fixture()
    f.view = { ...f.view, period: { ...f.view.period!, collection: { ...f.view.period!.collection!, openedAt: AT } } }
    const permit = await f.host.act(1, { action: 'reserve', periodId: 'p' })
    expect(permit.token).not.toBeNull()
    await f.host.act(1, { action: 'decline', periodId: 'p', token: permit.token! })
    f.view = { ...f.view, revision: f.view.revision + 1, period: { ...f.view.period!, collection: { ...f.view.period!.collection!, presentedAt: AT } } }
    expect((await f.host.act(1, { action: 'reserve', periodId: 'p' })).token).toBeNull()
  })
  it('allows an explicit manual opening to acknowledge and never auto-opens an unfocused window', async () => {
    const f = fixture(); f.focus = 2
    expect((await f.host.act(1, { action: 'reserve', periodId: 'p' })).token).toBeNull()
    const manual = await f.host.act(1, { action: 'manual', periodId: 'p' })
    expect(manual.token).not.toBeNull()
    await f.host.act(2, { action: 'ack', periodId: 'p', token: manual.token! })
    expect(f.saved).toEqual([])
    await f.host.act(1, { action: 'ack', periodId: 'p', token: manual.token! })
    await f.host.act(1, { action: 'ack', periodId: 'p', token: manual.token! })
    expect(f.saved).toEqual(['p'])
    expect((await f.host.act(2, { action: 'reserve', periodId: 'p' })).token).toBeNull()
  })
  it('fences held reservations and acknowledgments when a reset lowers the revision', async () => {
    const f = fixture()
    const heldView = Promise.withResolvers<typeof f.view>()
    let hold = true
    const saved: number[] = []
    const broker = new DeparturePresentation({
      view: async () => hold ? heldView.promise : f.view,
      focused: () => true,
      save: async (_periodId, _key, generation) => { saved.push(generation); return { view: f.view, outcome: 'changed' } as OwnerDepartureReply }
    })
    hold = false
    const old = await broker.act(1, { action: 'manual', periodId: 'p' })
    const previous = { ...f.view, revision: 100 }
    hold = true
    const reservation = broker.act(1, { action: 'reserve', periodId: 'p' })
    hold = false
    f.view = { ...f.view, generation: 1, period: { ...f.view.period!, periodId: 'new' } }
    broker.observe(f.view)
    heldView.resolve(previous)
    expect((await reservation).token).toBeNull()
    expect((await broker.act(1, { action: 'ack', periodId: 'p', token: old.token! })).token).toBeNull()
    const active = await broker.act(2, { action: 'reserve', periodId: 'new', expectedGeneration: 1 })
    expect(active.token).not.toBeNull()
    await broker.act(2, { action: 'ack', periodId: 'new', token: active.token! })
    expect(saved).toEqual([1])
  })
  it('after restart requires a real new show when there is no persisted receipt', async () => {
    const f = fixture()
    expect((await f.host.act(1, { action: 'reserve', periodId: 'p' })).token).not.toBeNull()
    expect(f.saved).toEqual([])
    const restarted = fixture()
    const ticket = await restarted.host.act(1, { action: 'reserve', periodId: 'p' })
    expect(ticket.token).not.toBeNull()
    expect(restarted.saved).toEqual([])
    await restarted.host.act(1, { action: 'ack', periodId: 'p', token: ticket.token! })
    expect(restarted.saved).toEqual(['p'])
  })
  it('keeps reconciling a real show after two failed saves in a quiet app', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const attempts: Array<{ key: string; generation: number }> = []
      const broker = new DeparturePresentation({
        view: async () => f.view, focused: () => true,
        save: async (_period, key, generation) => {
          attempts.push({ key, generation })
          if (attempts.length < 3) throw new Error('synthetic worker outage')
          return { view: f.view, outcome: 'changed' } as OwnerDepartureReply
        }
      })
      const ticket = await broker.act(1, { action: 'reserve', periodId: 'p' })
      expect(ticket.token).not.toBeNull()
      await broker.act(1, { action: 'ack', periodId: 'p', token: ticket.token! })
      expect((await broker.act(2, { action: 'reserve', periodId: 'p' })).token).toBeNull()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(attempts).toHaveLength(3)
      expect(attempts.every(input => input.key === attempts[0]?.key && input.generation === 0)).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('releases an unshown ticket when its window closes', async () => {
    const f = fixture()
    const first = await f.host.act(1, { action: 'reserve', periodId: 'p' })
    expect(first.token).not.toBeNull()
    f.host.close(1)
    await f.host.act(1, { action: 'ack', periodId: 'p', token: first.token! })
    expect(f.saved).toEqual([])
    f.focus = 2
    expect((await f.host.act(2, { action: 'reserve', periodId: 'p' })).token).not.toBeNull()
  })
})
