import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONSUMER_OUTPUT_QUEUE_BYTES,
  MAX_TERMINAL_CHUNK_BYTES,
  PTY_HOST_OUTPUT_QUEUE_BYTES,
  isTerminalAckMessage,
  isTerminalInputMessage,
  isTerminalOutputMessage
} from '@ai-terminal/protocol'
import { HostOutputQueue } from './transport'

describe('terminal MessagePort messages', () => {
  afterEach(() => vi.useRealTimers())
  it('accepts bounded input/output/ack messages and rejects oversized bytes', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(
      isTerminalInputMessage({
        kind: 'terminal-input',
        method: 'terminal.write',
        attachmentId: 'attachment',
        bytes
      })
    ).toBe(true)
    expect(
      isTerminalOutputMessage({
        kind: 'terminal-output',
        attachmentId: 'attachment',
        streamSeq: 0,
        bytes
      })
    ).toBe(true)
    expect(
      isTerminalAckMessage({ kind: 'terminal-ack', attachmentId: 'attachment', streamSeq: 0 })
    ).toBe(true)
    expect(
      isTerminalInputMessage({
        kind: 'terminal-input',
        method: 'terminal.write',
        attachmentId: 'attachment',
        bytes: new Uint8Array(MAX_TERMINAL_CHUNK_BYTES + 1)
      })
    ).toBe(false)
  })

  it('keeps the contract queue defaults explicit', () => {
    expect(CONSUMER_OUTPUT_QUEUE_BYTES).toBe(4 * 1024 * 1024)
    expect(PTY_HOST_OUTPUT_QUEUE_BYTES).toBe(16 * 1024 * 1024)
  })

  it('paces sends to consumer credit, resumes after acknowledgements, and bounds the host queue', () => {
    const send = vi.fn()
    const pause = vi.fn()
    const resume = vi.fn()
    const disconnect = vi.fn()
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 8,
      send,
      pause,
      resume,
      disconnect
    })

    queue.enqueue(new Uint8Array(8))
    expect(pause).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      attachmentId: 'attachment', streamSeq: 0, bytes: new Uint8Array(4)
    }))
    queue.acknowledge(0)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      attachmentId: 'attachment', streamSeq: 1, bytes: new Uint8Array(4)
    }))
    expect(resume).not.toHaveBeenCalled()
    queue.acknowledge(1)
    expect(resume).toHaveBeenCalledOnce()

    queue.enqueue(new Uint8Array(8))
    queue.enqueue(new Uint8Array(1))
    expect(disconnect).toHaveBeenCalledWith(
      'output-overflow',
      expect.objectContaining({
        discardedPartialFrameBytes: 4,
        unsentFrames: [new Uint8Array(1)]
      })
    )
  })

  it('revokes a paused consumer after the acknowledgement deadline and resumes the producer', () => {
    vi.useFakeTimers()
    const pause = vi.fn()
    const resume = vi.fn()
    const disconnect = vi.fn()
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 8,
      acknowledgementDeadlineMs: 25,
      send: vi.fn(),
      pause,
      resume,
      disconnect
    })

    queue.enqueue(new Uint8Array(4))
    expect(pause).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(24)
    expect(disconnect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(disconnect).toHaveBeenCalledWith(
      'acknowledgement-timeout',
      expect.objectContaining({ discardedPartialFrameBytes: 0 })
    )
    expect(resume).toHaveBeenCalledOnce()
  })

  it('does not postpone the acknowledgement deadline when more output arrives without ack progress', () => {
    vi.useFakeTimers()
    const disconnect = vi.fn()
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 32,
      acknowledgementDeadlineMs: 25,
      send: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      disconnect
    })

    queue.enqueue(new Uint8Array(4))
    vi.advanceTimersByTime(20)
    queue.enqueue(new Uint8Array(4))
    vi.advanceTimersByTime(5)

    expect(disconnect).toHaveBeenCalledWith(
      'acknowledgement-timeout',
      expect.objectContaining({ discardedPartialFrameBytes: 0 })
    )
  })

  it('reports publication only after paced pending chunks have been sent', async () => {
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 8,
      send: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      disconnect: vi.fn()
    })
    queue.enqueue(new Uint8Array(8))
    let published = false
    const publication = queue.whenPublished().then(() => (published = true))
    await Promise.resolve()
    expect(published).toBe(false)

    queue.acknowledge(0)
    await publication

    expect(published).toBe(true)
  })

  it('resumes a paused producer when the output queue closes', () => {
    const pause = vi.fn()
    let handoffAccepted = false
    const resume = vi.fn(() => {
      expect(handoffAccepted).toBe(true)
    })
    const disconnect = vi.fn()
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 8,
      send: vi.fn(),
      pause,
      resume,
      disconnect
    })

    queue.enqueue(new Uint8Array(4))
    expect(pause).toHaveBeenCalledOnce()

    queue.close([], () => {
      handoffAccepted = true
    })

    expect(resume).toHaveBeenCalledOnce()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('returns only whole never-sent frames and counts a partially sent frame tail', () => {
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 64,
      send: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      disconnect: vi.fn()
    })
    const partial = new TextEncoder().encode('abcdUNSENT')
    const whole = new TextEncoder().encode('WHOLE')

    queue.enqueue(partial)
    queue.enqueue(whole)
    const transition = queue.close()

    expect(transition).toEqual({
      unsentFrames: [whole],
      discardedPartialFrameBytes: new TextEncoder().encode('UNSENT').byteLength
    })
  })
})
