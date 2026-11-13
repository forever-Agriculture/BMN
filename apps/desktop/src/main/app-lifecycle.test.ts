// MODULE: app-lifecycle.test.ts - closing the last window and Quit ask the window first when Quick look holds unsaved edits, even with no session running (Story 68.1 AC8)
import { describe, expect, it, vi } from 'vitest'
import { restartClock } from '../utility/update-restart-deadline'
import { createApplicationLifecycle, type RunningSessionTarget, type CloseDecision } from './app-lifecycle'

function lifecycle(options: { unsaved: boolean; close?: CloseDecision; quit?: 'quit' | 'cancel' }) {
  const actions = {
    runningTargets: () => [],
    unsavedEdits: () => options.unsaved,
    saveBackgroundChoice: vi.fn(),
    promptForClose: vi.fn(async () => options.close ?? ({ kind: 'cancel' } as const)),
    promptForQuit: vi.fn(async () => options.quit ?? ('cancel' as const)),
    flushSavedOutput: vi.fn(async () => ({ status: 'saved' as const })),
    stopTargets: vi.fn(async () => undefined),
    hideWindow: vi.fn(),
    quitApplication: vi.fn(),
    restartForUpdate: vi.fn(),
    reportFailure: vi.fn()
  }
  return { actions, lifecycle: createApplicationLifecycle(actions) }
}

const event = () => ({ preventDefault: vi.fn() })

describe('unsaved edits on the way out', () => {
  it('closes at once with nothing unsaved and nothing running', async () => {
    const run = lifecycle({ unsaved: false })
    run.lifecycle.closeLastWindow(event())
    await vi.waitFor(() => expect(run.actions.quitApplication).toHaveBeenCalledOnce())
    expect(run.actions.promptForClose).not.toHaveBeenCalled()
  })

  it('asks the window first; Keep editing keeps it open, and a later Save or Discard closes it', async () => {
    const kept = lifecycle({ unsaved: true })
    kept.lifecycle.closeLastWindow(event())
    await vi.waitFor(() => expect(kept.actions.promptForClose).toHaveBeenCalledOnce())
    expect(kept.actions.promptForClose.mock.calls[0]).toMatchObject([{ targets: [] }])
    await Promise.resolve()
    expect(kept.actions.quitApplication).not.toHaveBeenCalled()
    expect(kept.actions.saveBackgroundChoice).not.toHaveBeenCalled()

    const closed = lifecycle({ unsaved: true, close: { kind: 'proceed', choices: {}, remember: true } })
    closed.lifecycle.closeLastWindow(event())
    await vi.waitFor(() => expect(closed.actions.quitApplication).toHaveBeenCalledOnce())
    expect(closed.actions.saveBackgroundChoice).not.toHaveBeenCalled()
  })

  it('asks before Quit, and quits only on the window\'s answer', async () => {
    const kept = lifecycle({ unsaved: true, quit: 'cancel' })
    kept.lifecycle.beforeQuit(event())
    await vi.waitFor(() => expect(kept.actions.promptForQuit).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(kept.actions.quitApplication).not.toHaveBeenCalled()

    const quit = lifecycle({ unsaved: true, quit: 'quit' })
    quit.lifecycle.beforeQuit(event())
    await vi.waitFor(() => expect(quit.actions.quitApplication).toHaveBeenCalledOnce())
  })
})


describe('source update shutdown', () => {
  it.each([true, false])('stale preparation failure cannot release B, with allowed guard %s', async guarded => {
    const run = lifecycle({ unsaved: false }); let allowed = true, reject!: (error: Error) => void
    const prepare = vi.fn(() => new Promise<void>((_, no) => { reject = no }))
    run.lifecycle.beginSourceUpdate()
    const a = run.lifecycle.quitForSourceUpdate([], { deadline: restartClock() + 8000, ...(guarded ? { allowed: () => allowed } : {}), prepare, captured: async () => undefined, stop: async () => undefined })
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    allowed = false; run.lifecycle.cancelSourceUpdate(); run.lifecycle.beginSourceUpdate()
    reject(new Error('Synthetic old launcher failure'))
    await expect(a).rejects.toThrow('Synthetic old launcher failure')
    run.lifecycle.closeLastWindow(event()); run.lifecycle.beforeQuit(event()); run.lifecycle.updateDownloaded()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(run.actions.quitApplication).not.toHaveBeenCalled(); expect(run.actions.restartForUpdate).not.toHaveBeenCalled()
    expect(run.actions.stopTargets).not.toHaveBeenCalled(); expect(run.actions.reportFailure).not.toHaveBeenCalled()
    run.lifecycle.cancelSourceUpdate(); run.lifecycle.closeLastWindow(event())
    await vi.waitFor(() => expect(run.actions.quitApplication).toHaveBeenCalledOnce())
  })
  it.each(['capture', 'prepare', 'stop'])('a stale successful %s without an optional guard cannot finish B', async stage => {
    const run = lifecycle({ unsaved: false }); let release!: () => void
    const entered = vi.fn(), pending = new Promise<void>(resolve => { release = resolve })
    if (stage === 'capture') run.actions.flushSavedOutput.mockImplementation(async () => { entered(); await pending; return { status: 'saved' } })
    const prepare = async (): Promise<void> => { if (stage === 'prepare') { entered(); await pending } }
    const stop = vi.fn(async () => { if (stage === 'stop') { entered(); await pending } })
    const finish = vi.fn()
    run.lifecycle.beginSourceUpdate()
    const a = run.lifecycle.quitForSourceUpdate([{ sessionId: 's', incarnationId: 'i', executable: 'synthetic', processState: 'live' }], { deadline: restartClock() + 8000, prepare, stop, finish, captured: async () => undefined })
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
    run.lifecycle.cancelSourceUpdate(); run.lifecycle.beginSourceUpdate(); release(); await a
    run.lifecycle.closeLastWindow(event()); await Promise.resolve()
    expect(finish).not.toHaveBeenCalled(); expect(run.actions.quitApplication).not.toHaveBeenCalled()
    if (stage !== 'stop') expect(stop).not.toHaveBeenCalled()
  })
  it.each([true, false])('standalone shutdown preserves success/failure behavior: success %s', async success => {
    const run = lifecycle({ unsaved: false })
    const call = run.lifecycle.quitForSourceUpdate([], { deadline: restartClock() + 8000, captured: async () => undefined, stop: async () => undefined,
      prepare: async () => { if (!success) throw new Error('Synthetic current failure') } })
    if (success) { await call; expect(run.actions.quitApplication).toHaveBeenCalledOnce() }
    else { await expect(call).rejects.toThrow('Synthetic current failure'); expect(run.actions.reportFailure).toHaveBeenCalledOnce(); run.lifecycle.beginSourceUpdate() }
  })
  it('Cancel during an ordinary decision does not release its lock', async () => {
    const run = lifecycle({ unsaved: true }); let release!: () => void
    run.actions.promptForQuit.mockImplementation(() => new Promise<'cancel'>(resolve => { release = () => resolve('cancel') }))
    run.lifecycle.beforeQuit(event()); await vi.waitFor(() => expect(run.actions.promptForQuit).toHaveBeenCalledOnce())
    run.lifecycle.cancelSourceUpdate()
    expect(() => run.lifecycle.beginSourceUpdate()).toThrow('Finish the open close or quit question first')
    release(); await Promise.resolve(); await Promise.resolve()
    expect(run.actions.quitApplication).not.toHaveBeenCalled()
  })
  it.each(['capture', 'prepare', 'stop'])('a Cancel during %s invalidates every later destructive continuation', async stage => {
    const run = lifecycle({ unsaved: false }); let allowed = true
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const entered = vi.fn()
    if (stage === 'capture') run.actions.flushSavedOutput.mockImplementation(async () => { entered(); await pending; return { status: 'saved' } })
    const prepare = vi.fn(async () => { if (stage === 'prepare') { entered(); await pending } })
    const stop = vi.fn(async () => { if (stage === 'stop') { entered(); await pending } })
    const finish = vi.fn()
    const captured = vi.fn(async () => undefined)
    run.lifecycle.beginSourceUpdate()
    const completion = run.lifecycle.quitForSourceUpdate([{ sessionId: 's', incarnationId: 'i', executable: 'synthetic', processState: 'live' }], {
      deadline: restartClock() + 8000, allowed: () => allowed, finish, prepare, stop, captured
    })
    await vi.waitFor(() => expect(entered).toHaveBeenCalled())
    allowed = false; release(); await completion
    expect(finish).not.toHaveBeenCalled(); expect(run.actions.quitApplication).not.toHaveBeenCalled()
    if (stage !== 'stop') expect(stop).not.toHaveBeenCalled()
    if (stage === 'capture') expect(captured).not.toHaveBeenCalled()
  })
  it('holds lifecycle ownership while waiting, and cancellation releases it', async () => {
    const run = lifecycle({ unsaved: false })
    run.lifecycle.beginSourceUpdate()
    run.lifecycle.closeLastWindow(event())
    expect(run.actions.quitApplication).not.toHaveBeenCalled()
    run.lifecycle.cancelSourceUpdate()
    run.lifecycle.closeLastWindow(event())
    await vi.waitFor(() => expect(run.actions.quitApplication).toHaveBeenCalledOnce())
  })
  it('bounds a shared capture/stop budget across twelve hung sessions', async () => {
    vi.useFakeTimers()
    try {
      const run = lifecycle({ unsaved: false })
      run.actions.flushSavedOutput.mockImplementation(() => new Promise(() => {}))
      const targets: RunningSessionTarget[] = Array.from({ length: 12 }, (_, i) => ({ sessionId: `s${i}`, incarnationId: `i${i}`, executable: 'synthetic', processState: 'live' }))
      const captured = vi.fn(async () => undefined)
      const prepare = vi.fn(async () => { expect(captured).toHaveBeenCalledTimes(12) })
      const stop = vi.fn(() => new Promise(() => {}))
      run.lifecycle.beginSourceUpdate()
      const completion = run.lifecycle.quitForSourceUpdate(targets, { deadline: restartClock() + 8000, prepare, captured, stop })
      await vi.runAllTimersAsync(); await completion
      expect(stop).toHaveBeenCalledTimes(12)
      expect(captured.mock.calls.every((call: unknown[]) => (call[1] as { status: string }).status === 'unavailable')).toBe(true)
      expect(run.actions.quitApplication).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('never stops a session when the launcher cannot acknowledge its wait', async () => {
    const run = lifecycle({ unsaved: false })
    const stop = vi.fn(async () => undefined)
    run.lifecycle.beginSourceUpdate()
    await expect(run.lifecycle.quitForSourceUpdate([], { deadline: restartClock() + 8000,
      prepare: async () => { throw new Error('launcher failed') }, captured: async () => undefined, stop })).rejects.toThrow('launcher failed')
    expect(stop).not.toHaveBeenCalled(); expect(run.actions.quitApplication).not.toHaveBeenCalled()
    run.lifecycle.closeLastWindow(event())
    await vi.waitFor(() => expect(run.actions.quitApplication).toHaveBeenCalledOnce())
  })
})
