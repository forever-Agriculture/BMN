// MODULE: process-tracking.test.ts - Quit and Close keep listing a process until its exit is confirmed
import { ERROR_CODES, type SessionStopCause } from '@bmn/protocol'
import { describe, expect, it } from 'vitest'
import {
  applyProcessState,
  createProcessTracking,
  dropRuntimeView,
  runningTargets,
  stopTrackedTargets,
  type TrackedRuntime
} from './process-tracking'

const runtime = (sessionId: string, processState: TrackedRuntime['processState'] = 'live'): TrackedRuntime => ({
  session: { sessionId, incarnationId: `${sessionId}-i1` },
  executable: '/usr/bin/claude',
  processState
})

const remote = (code: string) => Object.assign(new Error(`host error ${code}`), { protocolError: { data: { code } } })
const unknownOutcome = remote(ERROR_CODES.ioError)

function tracking(...items: TrackedRuntime[]) {
  const state = createProcessTracking<TrackedRuntime>()
  for (const item of items) state.runtimes.set(item.session.sessionId, item)
  return state
}

const stop = (state: ReturnType<typeof tracking>, cause: SessionStopCause, outcome: (sessionId: string) => unknown) =>
  stopTrackedTargets(state, runningTargets(state), cause, async (current) => {
    const error = outcome(current.session.sessionId)
    if (error) throw error
  })

describe('stopping tracked sessions', () => {
  it('stops tracking a session whose stop succeeded or whose process was already gone', async () => {
    const state = tracking(runtime('a'), runtime('b'))
    await stop(state, 'application-quit', (sessionId) => sessionId === 'b' ? remote(ERROR_CODES.notFound) : undefined)
    expect(runningTargets(state)).toEqual([])
    expect(state.runtimes.size).toBe(0)
  })

  it('keeps listing a session whose stop outcome is unknown, marked exit unconfirmed', async () => {
    const state = tracking(runtime('a'))
    await expect(stop(state, 'explicit', () => unknownOutcome)).rejects.toBe(unknownOutcome)
    expect(runningTargets(state)).toEqual([
      { sessionId: 'a', incarnationId: 'a-i1', executable: '/usr/bin/claude', processState: 'exit-unconfirmed' }
    ])
  })

  it('lets Quit and Close finish once an unconfirmed exit was already shown, without forgetting the process', async () => {
    for (const cause of ['application-quit', 'close-last-window'] as const) {
      const state = tracking(runtime('a', 'exit-unconfirmed'))
      await expect(stop(state, cause, () => unknownOutcome)).resolves.toBeUndefined()
      expect(runningTargets(state).map((target) => target.processState)).toEqual(['exit-unconfirmed'])
    }
  })

  it('still reports a repeated explicit stop of an unconfirmed exit', async () => {
    const state = tracking(runtime('a', 'exit-unconfirmed'))
    await expect(stop(state, 'explicit', () => unknownOutcome)).rejects.toBe(unknownOutcome)
    expect(runningTargets(state)).toHaveLength(1)
  })

  it('reports a first unknown outcome during Quit so the owner sees it before quitting', async () => {
    const state = tracking(runtime('a'))
    await expect(stop(state, 'application-quit', () => unknownOutcome)).rejects.toBe(unknownOutcome)
    expect(runningTargets(state)).toHaveLength(1)
  })
})

describe('terminal views and process tracking', () => {
  it('keeps an unconfirmed exit listed after its terminal view is dropped', () => {
    const state = tracking(runtime('a', 'exit-unconfirmed'), runtime('b', 'exited'))
    dropRuntimeView(state, state.runtimes.get('a')!)
    dropRuntimeView(state, state.runtimes.get('b')!)
    expect(state.runtimes.size).toBe(0)
    expect(runningTargets(state)).toEqual([
      { sessionId: 'a', incarnationId: 'a-i1', executable: '/usr/bin/claude', processState: 'exit-unconfirmed' }
    ])
  })

  it('does not drop a newer runtime that replaced the view', () => {
    const state = tracking(runtime('a'))
    const stale = { ...runtime('a', 'exit-unconfirmed'), session: { sessionId: 'a', incarnationId: 'old' } }
    dropRuntimeView(state, stale)
    expect(state.runtimes.get('a')?.session.incarnationId).toBe('a-i1')
    expect(runningTargets(state)).toHaveLength(1)
  })

  it('forgets an unconfirmed exit when the host confirms it, and ignores other incarnations', () => {
    const state = tracking(runtime('a', 'exit-unconfirmed'))
    dropRuntimeView(state, state.runtimes.get('a')!)
    applyProcessState(state, { sessionId: 'a', incarnationId: 'other', state: 'exited' })
    expect(runningTargets(state)).toHaveLength(1)
    applyProcessState(state, { sessionId: 'a', incarnationId: 'a-i1', state: 'exited' })
    expect(runningTargets(state)).toEqual([])
  })

  it('follows host state reports for tracked runtimes', () => {
    const state = tracking(runtime('a'))
    applyProcessState(state, { sessionId: 'a', incarnationId: 'a-i1', state: 'exit-unconfirmed' })
    expect(runningTargets(state).map((target) => target.processState)).toEqual(['exit-unconfirmed'])
    applyProcessState(state, { sessionId: 'a', incarnationId: 'a-i1', state: 'exited' })
    expect(runningTargets(state)).toEqual([])
  })

  it('lets Quit pass over a process that only remains as an unconfirmed exit', async () => {
    const state = tracking(runtime('a', 'exit-unconfirmed'))
    dropRuntimeView(state, state.runtimes.get('a')!)
    const requested: string[] = []
    await stopTrackedTargets(state, runningTargets(state), 'application-quit', async (current) => {
      requested.push(current.session.sessionId)
    })
    expect(requested).toEqual([])
    expect(runningTargets(state)).toHaveLength(1)
  })
})
