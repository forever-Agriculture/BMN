import type { TerminalExitMessage } from '@bmn/protocol'
import { describe, expect, it, vi } from 'vitest'
import { sessionProcessLabel } from './session-status'
import { applyTerminalExit, terminalExitFeedback } from './terminal-exit'

const incarnationId = 'any-incarnation'

describe('terminal exit feedback', () => {
  it('labels an observed exit code with the stored process wording and no failure', () => {
    const feedback = terminalExitFeedback({ state: 'exited', exitCode: 23 })
    expect(feedback).toEqual({ status: 'Process exited · code 23' })
    expect(feedback.status).toBe(sessionProcessLabel({
      incarnationId, state: 'exited', exitCode: 23, signal: null, detail: null
    }))
  })

  it('labels an observed signal stop with the stored process wording and no failure', () => {
    const feedback = terminalExitFeedback({ state: 'exited', exitCode: 0, signal: 9 })
    expect(feedback).toEqual({ status: 'Process stopped · signal 9' })
    expect(feedback.status).toBe(sessionProcessLabel({
      incarnationId, state: 'exited', exitCode: 0, signal: 9, detail: null
    }))
  })

  it('labels an observed signal stop that also reported an exit code', () => {
    const feedback = terminalExitFeedback({ state: 'exited', exitCode: 2, signal: 15 })
    expect(feedback).toEqual({ status: 'Process stopped · signal 15 · code 2' })
    expect(feedback.status).toBe(sessionProcessLabel({
      incarnationId, state: 'exited', exitCode: 2, signal: 15, detail: null
    }))
  })

  it.each([
    ['application-quit', 'application quit'],
    ['close-last-window', 'last window close'],
    ['update-restart', 'update restart']
  ] as const)('labels an observed %s lifecycle stop with the stored process wording and no failure', (cause, source) => {
    const feedback = terminalExitFeedback({ state: 'interrupted', cause, exitCode: 0, signal: 15 })
    expect(feedback).toEqual({ status: `Interrupted · ${source} · signal 15` })
    expect(feedback.status).toBe(sessionProcessLabel({
      incarnationId, state: 'interrupted', exitCode: null, signal: null, detail: `${source} · signal 15`
    }))
  })

  it('reserves the failure for an unobserved loss', () => {
    const feedback = terminalExitFeedback({
      state: 'interrupted',
      cause: 'unobserved-loss',
      reason: 'SIGKILL was sent but a PTY exit event was not observed'
    })
    expect(feedback).toEqual({
      status: 'Interrupted',
      failure:
        'The shell stop outcome is unknown: SIGKILL was sent but a PTY exit event was not observed. Fix: restart BMN before starting another shell.'
    })
    expect(feedback.status).toBe(sessionProcessLabel({
      incarnationId, state: 'interrupted', exitCode: null, signal: null, detail: null
    }))
  })

  it('never presents Epic-1 exit wording or start-again guidance for any exit variant', () => {
    const presented = JSON.stringify([
      terminalExitFeedback({ state: 'exited', exitCode: 23 }),
      terminalExitFeedback({ state: 'exited', exitCode: 0, signal: 9 }),
      terminalExitFeedback({ state: 'interrupted', cause: 'application-quit', exitCode: 0, signal: 15 }),
      terminalExitFeedback({ state: 'interrupted', cause: 'unobserved-loss', reason: 'no exit event' })
    ])
    expect(presented).not.toMatch(/Exited · |start BMN again/)
  })
})

describe('live pane exit reaction', () => {
  const pane = () => ({ detach: vi.fn(), setStatus: vi.fn(), onFailure: vi.fn() })

  it('detaches, shows Interrupted, and forwards the unobserved-loss failure text exactly once', () => {
    const reaction = pane()
    applyTerminalExit({
      kind: 'terminal-exit',
      state: 'interrupted',
      attachmentId: 'attachment-lost',
      cause: 'unobserved-loss',
      reason: 'SIGKILL was sent but a PTY exit event was not observed'
    }, reaction)
    expect(reaction.detach).toHaveBeenCalledExactlyOnceWith('attachment-lost')
    expect(reaction.setStatus).toHaveBeenCalledExactlyOnceWith('Interrupted')
    expect(reaction.onFailure).toHaveBeenCalledExactlyOnceWith(
      'The shell stop outcome is unknown: SIGKILL was sent but a PTY exit event was not observed. Fix: restart BMN before starting another shell.'
    )
  })

  it.each([
    [
      'an observed exit',
      { kind: 'terminal-exit', state: 'exited', attachmentId: 'attachment-exit', exitCode: 23 },
      'Process exited · code 23'
    ],
    [
      'an observed lifecycle stop',
      { kind: 'terminal-exit', state: 'interrupted', attachmentId: 'attachment-exit', cause: 'application-quit', exitCode: 0, signal: 15 },
      'Interrupted · application quit · signal 15'
    ]
  ] satisfies Array<[string, TerminalExitMessage, string]>)(
    'detaches and shows the status for %s without forwarding a failure',
    (_variant, message, status) => {
      const reaction = pane()
      applyTerminalExit(message, reaction)
      expect(reaction.detach).toHaveBeenCalledExactlyOnceWith('attachment-exit')
      expect(reaction.setStatus).toHaveBeenCalledExactlyOnceWith(status)
      expect(reaction.onFailure).not.toHaveBeenCalled()
    }
  )
})
