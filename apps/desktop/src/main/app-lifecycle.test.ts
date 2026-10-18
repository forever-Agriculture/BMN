// MODULE: app-lifecycle.test.ts - closing the last window and Quit ask the window first when Quick look holds unsaved edits, even with no session running (Story 68.1 AC8)
import { describe, expect, it, vi } from 'vitest'
import { createApplicationLifecycle, type CloseDecision } from './app-lifecycle'

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
