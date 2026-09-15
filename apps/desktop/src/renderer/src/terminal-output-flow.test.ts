import { describe, expect, it, vi } from 'vitest'
import {
  handleTerminalViewFailure,
  TerminalOutputFlow,
  undeliveredOutputLossNotice
} from './terminal-output-flow'

describe('renderer terminal output flow', () => {
  it('turns typed no-view loss into an explicit Saved Output notice', () => {
    expect(undeliveredOutputLossNotice(12_345)).toBe(
      '12,345 bytes of terminal output produced without a view were dropped. Earlier output remains available only in Saved Output.'
    )
  })
  it('disconnects slow and sequence-invalid flows and ignores callbacks from the abandoned view', () => {
    const recover = vi.fn()
    const writes: Array<() => void> = []
    const acknowledgements: number[] = []
    const flow = new TerminalOutputFlow(4)
    flow.attach('attachment-1')
    const actions = {
      write: (_bytes: Uint8Array, settled: () => void) => writes.push(settled),
      acknowledge: (_attachmentId: string, sequence: number) => acknowledgements.push(sequence),
      recover
    }

    expect(flow.accept({ attachmentId: 'attachment-1', streamSeq: 0, bytes: new Uint8Array(4) }, actions)).toBe(true)
    expect(flow.accept({ attachmentId: 'attachment-1', streamSeq: 1, bytes: new Uint8Array(1) }, actions)).toBe(false)
    expect(recover).toHaveBeenCalledWith('output-overflow')
    writes[0]?.()
    expect(acknowledgements).toEqual([])

    recover.mockClear()
    flow.attach('attachment-2')
    expect(flow.accept({ attachmentId: 'attachment-2', streamSeq: 1, bytes: new Uint8Array(1) }, actions)).toBe(false)
    expect(recover).toHaveBeenCalledWith('sequence-gap')
  })

  it('shows the acknowledgement-stall notice and requests fresh-renderer recovery', async () => {
    const clearAttachment = vi.fn()
    const setStatus = vi.fn()
    const setFailure = vi.fn()
    const recover = vi.fn(async () => ({ recovering: true }))

    await handleTerminalViewFailure('acknowledgement-timeout', {
      clearAttachment,
      setStatus,
      setFailure,
      recover
    })

    expect(clearAttachment).toHaveBeenCalledOnce()
    expect(setStatus).toHaveBeenCalledWith('Terminal view recovering')
    expect(setFailure).toHaveBeenCalledWith(expect.stringContaining('acknowledgements stalled'))
    expect(setFailure).toHaveBeenCalledWith(expect.stringContaining('shell process was not stopped'))
    expect(recover).toHaveBeenCalledWith('acknowledgement-timeout')
  })
})
