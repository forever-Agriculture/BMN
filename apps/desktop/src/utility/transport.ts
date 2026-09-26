import {
  CONSUMER_OUTPUT_QUEUE_BYTES,
  MAX_TERMINAL_CHUNK_BYTES,
  PTY_HOST_OUTPUT_QUEUE_BYTES,
  TERMINAL_ACKNOWLEDGEMENT_DEADLINE_MS,
  terminalWriteCut,
  type TerminalOutputMessage
} from '@bmn/protocol'
import type { TerminalViewDisconnectReason } from '@bmn/protocol'
import type { TerminalFrame } from './terminal-byte-framer'

interface HostOutputQueueOptions {
  attachmentId: string
  consumerBytes?: number
  hostBytes?: number
  acknowledgementDeadlineMs?: number
  send: (message: TerminalOutputMessage) => void
  pause: () => void
  resume: () => void
  disconnect: (reason: TerminalViewDisconnectReason, transition: HostOutputQueueTransition) => void
}

interface PendingFrame {
  frame: TerminalFrame
  offset: number
}

export interface HostOutputQueueTransition {
  unsentFrames: TerminalFrame[]
  discardedPartialFrameBytes: number
}

export class HostOutputQueue {
  private readonly sizes = new Map<number, number>()
  private readonly consumerBytes: number
  private readonly hostBytes: number
  private readonly acknowledgementDeadlineMs: number
  private readonly pending: PendingFrame[] = []
  private pendingBytes = 0
  private inFlightBytes = 0
  private nextSequence = 0
  private nextAcknowledgement = 0
  private paused = false
  private disconnected = false
  private draining = false
  private stallTimer: ReturnType<typeof setTimeout> | undefined
  private readonly publicationWaiters = new Set<() => void>()
  /** False until this view's stream reaches a point a fresh terminal parser can start from. */
  private synchronized = false
  private skipped = 0

  constructor(private readonly options: HostOutputQueueOptions) {
    this.consumerBytes = options.consumerBytes ?? CONSUMER_OUTPUT_QUEUE_BYTES
    // Chunks end between characters, so a view's credit must hold the longest UTF-8 character.
    if (!Number.isInteger(this.consumerBytes) || this.consumerBytes < 4) {
      throw new RangeError('A terminal view needs at least 4 bytes of output credit')
    }
    this.hostBytes = options.hostBytes ?? PTY_HOST_OUTPUT_QUEUE_BYTES
    this.acknowledgementDeadlineMs =
      options.acknowledgementDeadlineMs ?? TERMINAL_ACKNOWLEDGEMENT_DEADLINE_MS
  }

  /** Bytes this view skipped before the first point where its fresh parser could start. */
  get skippedBytes(): number {
    return this.skipped
  }

  enqueue(output: TerminalFrame): void {
    if (this.disconnected) return
    const frame = this.synchronize(output)
    if (!frame) return
    if (this.inFlightBytes + this.pendingBytes + frame.bytes.byteLength > this.hostBytes) {
      this.disconnect('output-overflow', [frame])
      return
    }
    this.pending.push({ frame, offset: 0 })
    this.pendingBytes += frame.bytes.byteLength
    this.drain()
  }

  acknowledge(streamSeq: number): void {
    if (this.disconnected) return
    if (streamSeq !== this.nextAcknowledgement) {
      this.disconnect('sequence-gap')
      return
    }
    const size = this.sizes.get(streamSeq)
    if (size === undefined) {
      this.disconnect('sequence-gap')
      return
    }
    this.sizes.delete(streamSeq)
    this.nextAcknowledgement += 1
    this.inFlightBytes -= size
    this.clearStallDeadline()
    this.drain()
  }

  whenPublished(): Promise<void> {
    if (this.pending.length === 0 || this.disconnected) return Promise.resolve()
    return new Promise((resolve) => this.publicationWaiters.add(resolve))
  }

  close(
    additionalUnsentFrames: readonly TerminalFrame[] = [],
    accept: (transition: HostOutputQueueTransition) => void = () => undefined
  ): HostOutputQueueTransition {
    const transition: HostOutputQueueTransition = {
      unsentFrames: [],
      discardedPartialFrameBytes: 0
    }
    for (const pending of this.pending) {
      if (pending.offset === 0) transition.unsentFrames.push(pending.frame)
      else transition.discardedPartialFrameBytes += pending.frame.bytes.byteLength - pending.offset
    }
    transition.unsentFrames.push(...additionalUnsentFrames)
    this.clearStallDeadline()
    this.sizes.clear()
    this.pending.length = 0
    this.pendingBytes = 0
    this.inFlightBytes = 0
    this.resolvePublicationWaiters()
    this.disconnected = true
    try {
      accept(transition)
    } finally {
      if (this.paused) this.options.resume()
      this.paused = false
    }
    return transition
  }

  /**
   * A view's parser starts in its ground state, so the view starts where its frame says such
   * a parser reads the stream as a parser that read all of it does. Before that point, bytes
   * such as a string whose introducer the view never received would be misread. Once
   * synchronized, the view's frames are contiguous and pass unchanged.
   */
  private synchronize(frame: TerminalFrame): TerminalFrame | undefined {
    if (this.synchronized) return frame
    const start = frame.freshStart
    if (start === null) {
      this.skipped += frame.bytes.byteLength
      return undefined
    }
    this.synchronized = true
    this.skipped += start
    if (start === 0) return frame
    return start === frame.bytes.byteLength
      ? undefined
      : { bytes: frame.bytes.subarray(start), freshStart: 0 }
  }

  private drain(): void {
    if (this.draining || this.disconnected) return
    this.draining = true
    try {
      while (this.pending.length > 0) {
        const pending = this.pending[0]!
        const bytes = pending.frame.bytes
        const available = this.consumerBytes - this.inFlightBytes
        if (available <= 0) break
        const limit = pending.offset + Math.min(MAX_TERMINAL_CHUNK_BYTES, available)
        const end = terminalWriteCut(bytes, pending.offset, limit)
        // Too little credit for the next whole character: acknowledgements free more.
        if (end === pending.offset) break
        const chunkBytes = end - pending.offset
        const chunk = bytes.slice(pending.offset, pending.offset + chunkBytes)
        pending.offset += chunkBytes
        this.pendingBytes -= chunkBytes
        if (pending.offset === bytes.byteLength) this.pending.shift()
        const streamSeq = this.nextSequence++
        this.sizes.set(streamSeq, chunk.byteLength)
        this.inFlightBytes += chunk.byteLength
        this.options.send({
          kind: 'terminal-output',
          attachmentId: this.options.attachmentId,
          streamSeq,
          bytes: chunk
        })
      }
    } finally {
      this.draining = false
    }
    if (this.pending.length === 0) this.resolvePublicationWaiters()
    this.updateBackpressure()
  }

  private updateBackpressure(): void {
    const shouldPause =
      this.pending.length > 0 || this.inFlightBytes >= this.consumerBytes
    if (shouldPause && !this.paused) {
      this.paused = true
      this.options.pause()
    } else if (!shouldPause && this.paused) {
      this.paused = false
      this.options.resume()
    }
    if (this.paused && this.inFlightBytes > 0 && !this.stallTimer) {
      this.stallTimer = setTimeout(
        () => this.disconnect('acknowledgement-timeout'),
        this.acknowledgementDeadlineMs
      )
      this.stallTimer.unref()
    } else if (!this.paused) {
      this.clearStallDeadline()
    }
  }

  private clearStallDeadline(): void {
    if (!this.stallTimer) return
    clearTimeout(this.stallTimer)
    this.stallTimer = undefined
  }

  private resolvePublicationWaiters(): void {
    for (const resolve of this.publicationWaiters) resolve()
    this.publicationWaiters.clear()
  }

  private disconnect(
    reason: TerminalViewDisconnectReason = 'output-overflow',
    additionalUnsentFrames: readonly TerminalFrame[] = []
  ): void {
    this.close(additionalUnsentFrames, (transition) => {
      this.options.disconnect(reason, transition)
    })
  }
}
