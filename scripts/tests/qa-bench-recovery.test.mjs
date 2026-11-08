// MODULE: qa-bench-recovery.test.mjs - exercise the real recovery phase with a synthetic kernel and clock
import { afterEach, describe, expect, it, vi } from 'vitest'

const kernel = vi.hoisted(() => ({ state: null, releaseAt: Infinity, killed: false, records: [], removed: [], deleted: false }))
vi.mock('../qa/bench-lib.mjs', () => ({
  atomicJson: (_path, value) => kernel.records.push(value), isLiveProcess: () => true
}))
vi.mock('../qa/bench-state.mjs', async importOriginal => {
  const original = await importOriginal()
  return {
    ...original,
    allTraces: () => kernel.state.tracers,
    validateStateRoot: vi.fn(),
    groupState: config => ({ populated: config.group.path === '/owned/launch' && !kernel.killed && Date.now() < kernel.releaseAt }),
    killGroup: vi.fn(config => { expect(config.group.path).toBe('/owned/launch'); kernel.killed = true }),
    traceOutstanding: () => !kernel.killed && Date.now() < kernel.releaseAt,
    traceCompleted: () => !kernel.killed,
    removeGroup: config => kernel.removed.push(config.group.path),
    deleteRoot: () => { kernel.deleted = true },
    transition: (_run, _statuses, update) => { kernel.state = update(kernel.state); return kernel.state }
  }
})
import { recoverOwnedBench } from '../qa/bench-recover.mjs'
import { killGroup } from '../qa/bench-state.mjs'

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

function recover({ now = 0, releaseAt = Infinity } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(now)
  Object.assign(kernel, { releaseAt, killed: false, records: [], removed: [], deleted: false,
    state: { status: 'stopping', runId: 'synthetic', stopRequestedAt: new Date(0).toISOString(), cleanupDeadlineAt: 30000,
      stopClaim: { token: 'claim' }, watchdog: { key: 'recovery' }, tracers: [{ key: 'workload', group: { path: '/owned/launch' } }] } })
  return recoverOwnedBench({ config: { run: '/owned/evidence', group: { path: '/owned/workload' } }, runId: 'synthetic', key: 'recovery',
    self: { pid: 11, start_ticks: '1' }, token: 'claim', ownTracer: { pid: 12, start_ticks: '2' }, claimed: () => kernel.state })
}

describe('QA recovery sealing and shared deadline', () => {
  it('preserves a healthy recorder that seals after three seconds', async () => {
    const completion = recover({ releaseAt: 3000 })
    await vi.advanceTimersByTimeAsync(2999)
    expect(kernel.deleted).toBe(false); expect(killGroup).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await completion
    expect(killGroup).not.toHaveBeenCalled()
    expect(kernel.state.status).toBe('stopped')
    expect(kernel.state.traceEvidence).toEqual([{ key: 'workload', complete: true }])
    expect(kernel.removed).toEqual(['/owned/launch', '/owned/workload'])
  })

  it('uses only the original deadline remainder for a successor', async () => {
    const completion = recover({ now: 20000 })
    await vi.advanceTimersByTimeAsync(9999)
    expect(killGroup).not.toHaveBeenCalled(); expect(kernel.deleted).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await completion
    expect(killGroup).toHaveBeenCalledTimes(1)
    expect(Date.now()).toBe(30000)
    expect(kernel.state.status).toBe('stopped')
    expect(kernel.state.traceEvidence).toEqual([{ key: 'workload', complete: false }])
  })
})
