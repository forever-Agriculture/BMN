import type { AttentionRecord } from '@bmn/protocol'
import { describe, expect, it, vi } from 'vitest'
import { dismissAttentionReminder, noticesWhenNavigating, applyAttentionWithdrawal } from './attention-actions'

const notice: AttentionRecord = {
  requestId: 'notice-synthetic', sessionId: 'source', incarnationId: 'run-one', requestKey: 'notice',
  kind: 'notice', title: 'Finished', body: 'Build finished', state: 'open', resolution: null,
  openedAt: '2026-09-30T00:00:00.000Z', expiresAt: null, resolvedAt: null, seenAt: null,
  revision: 3, openedBy: 'osc:9', resolvedBy: null, prompt: null
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function bridge() {
  return { resolveAttention: vi.fn(async (): Promise<AttentionRecord> => ({ ...notice, state: 'withdrawn', revision: notice.revision + 1 })) }
}

describe('owner attention actions', () => {
  it('dismisses only the captured revision without answering or approving', async () => {
    const api = bridge()
    await dismissAttentionReminder(api, { ...notice, kind: 'permission' })
    expect(api.resolveAttention).toHaveBeenCalledExactlyOnceWith(notice.requestId, 'Dismissed in BMN',
      { kind: 'permission', revision: 3 }, 'owner', 'withdrawn')
  })
  it('captures only open notices in the addressed session', () => {
    expect(noticesWhenNavigating([notice, ...(['question', 'permission', 'review', 'handoff'] as const).map(kind => ({ ...notice, kind })),
      { ...notice, sessionId: 'other' }, { ...notice, state: 'answered' }], 'source')).toEqual([notice])
  })
  it('coalesces repeats before resolution and until the renderer refresh finishes', async () => {
    const api = bridge()
    const resolved = deferred<AttentionRecord>()
    const refreshed = deferred<void>()
    api.resolveAttention.mockReturnValue(resolved.promise)
    const refresh = vi.fn(() => refreshed.promise)
    const first = dismissAttentionReminder(api, notice, 'Opened in BMN; reminder cleared', refresh)
    const second = dismissAttentionReminder(api, notice, 'Opened in BMN; reminder cleared', refresh)
    expect(api.resolveAttention).toHaveBeenCalledOnce()
    resolved.resolve({ ...notice, state: 'withdrawn' })
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledOnce()
    const third = dismissAttentionReminder(api, notice, 'Opened in BMN; reminder cleared', refresh)
    expect(api.resolveAttention).toHaveBeenCalledOnce()
    refreshed.resolve()
    await Promise.all([first, second, third])
  })
  it.each(['NOT_FOUND', 'REVISION_CONFLICT'])('refreshes %s without attempting a newer revision', async code => {
    const api = bridge()
    api.resolveAttention.mockRejectedValue({ code })
    const refresh = vi.fn(async () => undefined)
    await expect(dismissAttentionReminder(api, notice, undefined, refresh)).resolves.toBeNull()
    expect(api.resolveAttention).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
  })
  it('keeps genuine failures visible and retryable', async () => {
    const api = bridge()
    api.resolveAttention.mockRejectedValueOnce({ code: 'IO_ERROR', message: 'disk unavailable' })
    const refresh = vi.fn(async () => undefined)
    await expect(dismissAttentionReminder(api, notice, undefined, refresh)).rejects.toMatchObject({ code: 'IO_ERROR' })
    await expect(dismissAttentionReminder(api, notice, undefined, refresh)).resolves.toMatchObject({ state: 'withdrawn' })
    expect(api.resolveAttention).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})

it('publishes the withdrawn revision before a failed refresh, including a later coalesced navigation', async () => {
  const api = bridge()
  const pendingRefresh = deferred<void>()
  const snapshots: AttentionRecord[] = []
  const refresh = () => pendingRefresh.promise.then(() => { throw new Error('list unavailable') })
  const first = dismissAttentionReminder(api, notice, undefined, refresh, row => snapshots.push(row))
  // Attach rejection handlers immediately; the failure must remain visible to each caller.
  const firstFailure = expect(first).rejects.toThrow('Reminder cleared. The request list could not refresh')
  await Promise.resolve()
  expect(snapshots).toHaveLength(1)
  const second = dismissAttentionReminder(api, notice, undefined, refresh, row => snapshots.push(row))
  const secondFailure = expect(second).rejects.toThrow('Reminder cleared. The request list could not refresh')
  expect(snapshots).toHaveLength(2)
  expect(snapshots.every(row => row.state === 'withdrawn' && row.revision === 4)).toBe(true)
  expect(api.resolveAttention).toHaveBeenCalledOnce()
  pendingRefresh.resolve()
  await Promise.all([firstFailure, secondFailure])
})

it('replaces the captured open revision with the incremented withdrawal while retaining newer arrivals', () => {
  const resolved = { ...notice, state: 'withdrawn' as const, revision: 4 }
  expect(applyAttentionWithdrawal([notice], notice, resolved)).toEqual([resolved])
  const newer = { ...notice, revision: 5, title: 'New notice' }
  expect(applyAttentionWithdrawal([newer], notice, resolved)).toEqual([newer])
})

it('preserves a genuine withdrawal failure when refreshing also fails', async () => {
  const api = bridge()
  api.resolveAttention.mockRejectedValue({ code: 'IO_ERROR', message: 'Could not withdraw' })
  await expect(dismissAttentionReminder(api, notice, undefined, async () => { throw new Error('Could not list') }))
    .rejects.toMatchObject({ code: 'IO_ERROR', message: 'Could not withdraw' })
})
