import { describe, expect, it, vi } from 'vitest'
import {
  clearTerminalAttachment,
  handleTerminalOutputOverflow,
  handleTerminalUnavailable,
  runIpcWithFeedback,
  sendTerminalInputIfAttached,
  type RendererIpcOperation
} from './stop-session'

describe('renderer IPC feedback', () => {
  it.each<[RendererIpcOperation, string, string]>([
    [
      'resize',
      'utility host request terminal.resize timed out',
      'Terminal resize failed: utility host request terminal.resize timed out. Fix: reopen the terminal view and try resizing again.'
    ],
    [
      'detach',
      'utility host request terminal.detach timed out',
      'Terminal detach failed: utility host request terminal.detach timed out. Fix: reopen the terminal view before sending more input.'
    ],
    [
      'stop',
      'utility host request session.stop timed out',
      'The shell stop failed: utility host request session.stop timed out. Fix: restart AI Terminal before starting another shell.'
    ],
    [
      'hide',
      'main process rejected hide',
      'Window hide failed: main process rejected hide. Fix: try Hide again or close AI Terminal from the desktop.'
    ]
  ])('surfaces a rejected %s call and consumes its rejection', async (operation, cause, notice) => {
    const setStatus = vi.fn()
    const setFailure = vi.fn()

    await expect(
      runIpcWithFeedback(operation, () => Promise.reject(new Error(cause)), {
        setStatus,
        setFailure
      })
    ).resolves.toBeUndefined()

    if (operation === 'stop') expect(setStatus).toHaveBeenCalledWith('Stop outcome unknown')
    else expect(setStatus).not.toHaveBeenCalled()
    expect(setFailure).toHaveBeenCalledWith(notice)
  })

  it('records a successful stop without leaving a failure notice', async () => {
    const setStatus = vi.fn()
    const setFailure = vi.fn()

    await runIpcWithFeedback(
      'stop',
      () => Promise.resolve({ stopped: true as const }),
      {
        setStatus,
        setFailure,
        onSuccess: () => {
          setStatus('Stopped')
          setFailure(undefined)
        }
      }
    )

    expect(setStatus).toHaveBeenCalledWith('Stopped')
    expect(setFailure).toHaveBeenCalledWith(undefined)
  })

  it('preserves observed exit feedback when an in-flight stop later rejects', async () => {
    const setStatus = vi.fn()
    const setFailure = vi.fn()
    let exitRecorded = false
    let rejectStop: (error: Error) => void = () => undefined
    const stop = new Promise<never>((_resolve, reject) => {
      rejectStop = reject
    })

    const settling = runIpcWithFeedback('stop', () => stop, {
      setStatus,
      setFailure,
      shouldSurfaceFailure: () => !exitRecorded
    })
    exitRecorded = true
    rejectStop(new Error('utility host request session.stop timed out'))

    await expect(settling).resolves.toBeUndefined()
    expect(setStatus).not.toHaveBeenCalled()
    expect(setFailure).not.toHaveBeenCalled()
  })

  it('makes terminal input a no-op after the active attachment is cleared', () => {
    const attachment = { current: { attachmentId: 'attachment-1' } }
    const send = vi.fn()
    const bytes = new TextEncoder().encode('echo')

    sendTerminalInputIfAttached(attachment, bytes, send)
    clearTerminalAttachment(attachment)
    sendTerminalInputIfAttached(attachment, bytes, send)

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('attachment-1', bytes)
    expect(attachment.current).toBeUndefined()
  })

  it.each([
    'The terminal host exited unexpectedly. Fix: restart AI Terminal to open a new shell.',
    'Terminal output exceeded the 4 MiB view queue. Fix: reopen the terminal view; the shell process was not stopped.'
  ])('clears the attachment when startup reports %j', (message) => {
    const attachment = { current: { attachmentId: 'attachment-1' } }
    const setStatus = vi.fn()
    const setFailure = vi.fn()
    const send = vi.fn()

    handleTerminalUnavailable(attachment, message, setStatus, setFailure)
    sendTerminalInputIfAttached(attachment, new Uint8Array([1]), send)

    expect(attachment.current).toBeUndefined()
    expect(send).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('Terminal unavailable')
    expect(setFailure).toHaveBeenCalledWith(message)
  })

  it('clears the attachment before a renderer overflow detach rejects', async () => {
    const attachment = { current: { attachmentId: 'attachment-1' } }
    const setStatus = vi.fn()
    const setFailure = vi.fn()

    await expect(
      handleTerminalOutputOverflow(
        attachment,
        () => Promise.reject(new Error('utility host request terminal.detach timed out')),
        setStatus,
        setFailure
      )
    ).resolves.toBeUndefined()

    expect(attachment.current).toBeUndefined()
    expect(setStatus).toHaveBeenCalledWith('Terminal view disconnected')
    expect(setFailure).toHaveBeenLastCalledWith(
      'Terminal detach failed: utility host request terminal.detach timed out. Fix: reopen the terminal view before sending more input.'
    )
  })
})
