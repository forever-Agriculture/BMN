// MODULE: departure-wake.test.ts - departure injection refuses every changing proof and never repeats a possibly completed write
import { describe, expect, it } from 'vitest'
import { DEPARTURE_LINE, EMPTY_GRANT_RECORD, newDepartureCollection, openGrantPeriod, selectDepartureSessions, setDepartureCollection, startDeparture, type GrantRead } from '@bmn/protocol'
import { DepartureWake } from './departure-wake'
import type { WakeObservation, WakeAttention, WakeScreen } from './away-wake'

const AT = '2026-11-17T19:00:00.000Z'
const RULE = '─'.repeat(60)
function fixture(agent = 'claude') {
  let now = new Date(Date.parse(AT) + 30_000)
  let record = startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'app', agentSessionId: null, periodId: 'period',
    collection: newDepartureCollection(selectDepartureSessions([{ sessionId: 's', incarnationId: 'i', name: 'Synthetic', agent, lastEventAt: AT }], AT), AT)
  }, 'back', AT).record
  let seen: WakeObservation | undefined = { sessionId: 's', incarnationId: 'i', agent, event: 'Stop', source: null, plugin: null, observedAt: AT, foreground: 'front' }
  let epoch = 0, generation = 0, pending = 0, handed = false, finished: string | null = AT, front: string | null = 'front', live = 'i'
  let attention: WakeAttention[] = []
  let screen: WakeScreen | null = { lines: agent === 'codex' ? ['• ok', '', '›', '', '  GPT-6.1-Sol · synthetic', '  ? for shortcuts'] : ['● ok', RULE, '❯ ', RULE, 'Synthetic'], cursor: { x: 0, y: 0 } }
  let beforeScreen: (() => void) | null = null, beforeClaim: (() => void) | null = null, throws = false
  const writes: string[] = []
  const period = () => openGrantPeriod(record)
  const make = () => new DepartureWake({
    now: () => now, period, epoch: () => epoch, handed: () => handed,
    observation: () => seen, liveIncarnation: () => live, foreground: () => front,
    generation: () => ({ generation, pending }), openAttention: async () => attention, finishedTurn: () => finished,
    screen: async () => { beforeScreen?.(); return screen },
    write: (_id, text) => { writes.push(text); generation++; if (throws) throw Error('written then lost acknowledgement') },
    changed: (read: GrantRead) => { if (read.state === 'read') record = read.record },
    delivery: async input => {
      const current = period()!, collection = current.collection!, session = collection.sessions[0]!
      let claimed = false
      if (input.kind === 'claim') {
        beforeClaim?.()
        if (session.claim !== null || session.toldAt !== null || handed) return { claimed: false, read: { state: 'read' as const, record } }
        session.claim = input.token; claimed = true
      } else if (input.kind === 'release' && session.claim === input.token) session.claim = null
      else if (input.kind === 'told' && session.claim === input.token) { session.toldAt = now.toISOString(); session.via = 'typed' }
      else if (input.kind === 'reason') session.reason = input.reason ?? null
      record = setDepartureCollection(record, current.periodId, { ...collection, sessions: [{ ...session }] })
      return { claimed, read: { state: 'read' as const, record } }
    }
  })
  return { make, writes, period,
    set screen(value: WakeScreen | null) { screen = value }, set beforeScreen(value: (() => void) | null) { beforeScreen = value },
    set beforeClaim(value: (() => void) | null) { beforeClaim = value },
    set throws(value: boolean) { throws = value }, set finished(value: string | null) { finished = value },
    set attention(value: WakeAttention[]) { attention = value },
    draft: () => { screen = { lines: ['● ok', RULE, '❯ my draft', RULE], cursor: { x: 10, y: 2 } } },
    type: () => { generation++ }, pending: () => { pending++ }, cancel: () => { epoch++ }, handed: () => { handed = true },
    replace: () => { live = 'new' }, foreground: () => { front = 'shell' }, report: () => { seen = { ...seen!, observedAt: now.toISOString(), event: 'PreToolUse' } },
    endWindow: () => { now = new Date(Date.parse(AT) + 180_000) }
  }
}

describe('departure idle proof (130.2 AC2,AC5)', () => {
  it.each(['claude', 'codex'])('submits the exact line once to a proven idle %s', async agent => {
    const f = fixture(agent), wake = f.make()
    await Promise.all([wake.sweep(), wake.sweep()])
    await wake.sweep()
    expect(f.writes).toEqual([DEPARTURE_LINE])
    expect(f.period()?.collection?.sessions[0]?.via).toBe('typed')
  })
  it('never releases or repeats a terminal write which succeeded and then threw, even after scheduler restart', async () => {
    const f = fixture(); f.throws = true
    await f.make().sweep(); await f.make().sweep()
    expect(f.writes).toEqual([DEPARTURE_LINE])
    expect(f.period()?.collection?.sessions[0]?.claim).not.toBeNull()
    expect(f.period()?.collection?.sessions[0]?.toldAt).toBeNull()
  })
  it.each(['draft', 'type', 'pending', 'cancel', 'handed', 'replace', 'foreground', 'report', 'endWindow'] as const)(
    'refuses %s arriving during screen inspection and releases the unused reservation', async change => {
      const f = fixture()
      f.beforeScreen = () => f[change]()
      await f.make().sweep()
      expect(f.writes).toEqual([])
      expect(f.period()?.collection?.sessions[0]?.claim).toBeNull()
    })
  it('refuses hook handover while claiming without a terminal write', async () => {
    const f = fixture(); f.beforeClaim = f.handed
    await f.make().sweep()
    expect(f.writes).toEqual([])
  })
  it.each(['claude', 'codex'])('a resumed or restarted %s without a fresh own turn is never typed into', async agent => {
    const f = fixture(agent); f.finished = null
    await f.make().sweep()
    expect(f.writes).toEqual([])
    expect(f.period()?.collection?.sessions[0]?.reason).toContain('no fresh own finished turn')
  })
  it('holds for an app permission and a missing mirror', async () => {
    const f = fixture()
    f.attention = [{ sessionId: 's', requestKey: 'permission', kind: 'permission', openedBy: 'hook', openedAt: AT, state: 'open' }]
    await f.make().sweep()
    f.attention = []; f.screen = null
    await f.make().sweep()
    expect(f.writes).toEqual([])
  })
})
