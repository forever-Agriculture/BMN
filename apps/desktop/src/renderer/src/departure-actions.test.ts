// MODULE: departure-actions.test.ts - stale presentation/activity may be refreshed; authority actions never silently repeat
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_AWAY_RECORD, EMPTY_GRANT_RECORD, newDepartureCollection, ownerAwayView, ownerGrantView, startDeparture, type DesktopDepartureInput, type OwnerDepartureReply, type OwnerGrantView } from '@bmn/protocol'
import { adoptGrantView, INITIAL_GRANT_VIEW, performDepartureAction, readDepartureGrant } from './departure-actions'
const AT = '2026-11-17T19:00:00.000Z'
function reply(outcome: OwnerDepartureReply['outcome'], revision: number, periodId = 'one', state: 'leaving' | 'away' = 'leaving'): OwnerDepartureReply {
  const record = startDeparture({ ...EMPTY_GRANT_RECORD, periods: [], operations: [] }, { source: 'app', agentSessionId: null, periodId, collection: newDepartureCollection([], AT) }, 'back', AT).record
  record.revision = revision; record.periods[0]!.state = state
  return { outcome, view: ownerGrantView({ state: 'read', record }), away: ownerAwayView(EMPTY_AWAY_RECORD), detail: null }
}
const input = (action: DesktopDepartureInput['action']): DesktopDepartureInput => ({ action, periodId: 'one', expectedRevision: 10, operationKey: 'same-owner-action' })
describe('one owner departure action', () => {
  it('refreshes stale list activity only in the same still-leaving period', async () => {
    const send = vi.fn().mockResolvedValueOnce(reply('stale', 11)).mockResolvedValueOnce(reply('changed', 12))
    expect((await performDepartureAction(input('open'), send)).outcome).toBe('changed')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0]).toEqual({ ...input('open'), expectedRevision: 11 })
  })
  it.each(['start', 'go', 'cancel', 'same'] as const)('never retries a stale authority or state action %s', async action => {
    const send = vi.fn(async () => reply('stale', 11))
    expect((await performDepartureAction(input(action), send)).outcome).toBe('stale')
    expect(send).toHaveBeenCalledOnce()
  })
  it.each([reply('stale', 11, 'another'), reply('stale', 11, 'one', 'away'), reply('unknown', 11)])('stops on a different/closed period or unreadable state', async result => {
    const send = vi.fn(async () => result)
    await performDepartureAction(input('open'), send)
    expect(send).toHaveBeenCalledOnce()
  })
  it('bounds activity contention to three fenced attempts', async () => {
    let revision = 10
    const send = vi.fn(async () => reply('stale', ++revision))
    expect((await performDepartureAction(input('open'), send)).outcome).toBe('stale')
    expect(send).toHaveBeenCalledTimes(3)
  })
})

describe('grant view ordering and unreadable recovery', () => {
  const unknown = ownerGrantView({ state: 'unknown', reason: 'Unreadable synthetic record' })
  const old = reply('changed', 12).view
  const current = reply('changed', 22, 'two').view

  it('applies revisions to every readable source and drops an older unreadable reply', () => {
    const latest = adoptGrantView(INITIAL_GRANT_VIEW, current, 2, 2, true)
    expect(adoptGrantView(latest, old, 3, 3, true)).toBe(latest)
    expect(adoptGrantView(latest, unknown, 1, 3, false)).toBe(latest)
  })

  it('retains the last view across loss and ignores in-flight earlier reads and mutations', () => {
    const latest = adoptGrantView(INITIAL_GRANT_VIEW, current, 2, 2, true)
    const lost = adoptGrantView(latest, unknown, 3, 5, false)
    expect(lost).toMatchObject({ view: current, unreadable: true })
    expect(adoptGrantView(lost, old, 5, 6, true)).toBe(lost)
    expect(adoptGrantView(lost, current, 6, 6, false)).toBe(lost)
    const recovered = adoptGrantView(lost, current, 7, 7, true)
    expect(recovered).toMatchObject({ view: current, unreadable: false })
    expect(adoptGrantView(recovered, reply('changed', 30).view, 4, 7, false)).toBe(recovered)
  })

  it.each([true, false])('retains the new generation when a pending read arrives first: %s', readFirst => {
    const latest = adoptGrantView(INITIAL_GRANT_VIEW, current, 1, 1, true)
    const next = { ...reply('changed', 1, 'fresh').view, generation: 1 }
    const recovered = adoptGrantView(latest, next, 4, 4, true)
    const stale = { ...current, generation: 0, revision: current.revision + 1 }
    const first = adoptGrantView(recovered, stale, readFirst ? 2 : 3, 4, readFirst)
    const second = adoptGrantView(first, stale, readFirst ? 3 : 2, 4, !readFirst)
    expect(second).toBe(recovered)
  })

  it('keeps a new-generation reply when a later old-generation transport request fails', async () => {
    const failure = Promise.withResolvers<OwnerGrantView>()
    const pending = readDepartureGrant(0, () => failure.promise)
    const fresh = { ...current, generation: 1, revision: 1 }
    const state = adoptGrantView(INITIAL_GRANT_VIEW, fresh, 1, 2, true)
    failure.reject(new Error('synthetic transport loss'))
    const lost = await pending
    expect(lost).toMatchObject({ read: 'unknown', generation: 0 })
    expect(adoptGrantView(state, lost, 2, 2, true)).toBe(state)
    expect(adoptGrantView(state, { ...lost, generation: 1 }, 3, 3, true).unreadable).toBe(true)
  })

  it('takes a fresh authoritative no-period read after the store resets', () => {
    const latest = adoptGrantView(INITIAL_GRANT_VIEW, current, 1, 1, true)
    const lost = adoptGrantView(latest, unknown, 2, 2, true)
    const empty = ownerGrantView({ state: 'read', record: EMPTY_GRANT_RECORD, generation: 1 })
    const recovered = adoptGrantView(lost, empty, 3, 3, true)
    expect(recovered).toMatchObject({ view: empty, unreadable: false })
    expect(adoptGrantView(latest, empty, 3, 3, true)).toMatchObject({ view: empty, unreadable: false })
    expect(adoptGrantView(recovered, current, 4, 4, true)).toBe(recovered)
    expect(adoptGrantView(recovered, { ...unknown, generation: 0 }, 5, 5, false)).toBe(recovered)
    expect(recovered.view?.period).toBeNull()
    expect(adoptGrantView(recovered, old, 1, 3, true)).toBe(recovered)
  })
})
