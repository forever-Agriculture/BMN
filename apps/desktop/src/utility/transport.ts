import {
  CONSUMER_OUTPUT_QUEUE_BYTES,
  MAX_TERMINAL_CHUNK_BYTES,
  PTY_HOST_OUTPUT_QUEUE_BYTES,
  TERMINAL_ACKNOWLEDGEMENT_DEADLINE_MS,
  type TerminalOutputMessage
} from '@bmn/protocol'
import type { TerminalViewDisconnectReason } from '@bmn/protocol'

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
  bytes: Uint8Array
  offset: number
}

export interface HostOutputQueueTransition {
  unsentFrames: Uint8Array[]
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

  constructor(private readonly options: HostOutputQueueOptions) {
    this.consumerBytes = options.consumerBytes ?? CONSUMER_OUTPUT_QUEUE_BYTES
    this.hostBytes = options.hostBytes ?? PTY_HOST_OUTPUT_QUEUE_BYTES
    this.acknowledgementDeadlineMs =
      options.acknowledgementDeadlineMs ?? TERMINAL_ACKNOWLEDGEMENT_DEADLINE_MS
  }

  enqueue(bytes: Uint8Array): void {
    if (this.disconnected) return
    if (this.inFlightBytes + this.pendingBytes + bytes.byteLength > this.hostBytes) {
      this.disconnect('output-overflow', [bytes])
      return
    }
    this.pending.push({ bytes, offset: 0 })
    this.pendingBytes += bytes.byteLength
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
    additionalUnsentFrames: readonly Uint8Array[] = [],
    accept: (transition: HostOutputQueueTransition) => void = () => undefined
  ): HostOutputQueueTransition {
    const transition: HostOutputQueueTransition = {
      unsentFrames: [],
      discardedPartialFrameBytes: 0
    }
    for (const frame of this.pending) {
      if (frame.offset === 0) transition.unsentFrames.push(frame.bytes)
      else transition.discardedPartialFrameBytes += frame.bytes.byteLength - frame.offset
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

  private drain(): void {
    if (this.draining || this.disconnected) return
    this.draining = true
    try {
      while (this.pending.length > 0) {
        const frame = this.pending[0]!
        const available = this.consumerBytes - this.inFlightBytes
        if (available <= 0) break
        const chunkBytes = Math.min(
          MAX_TERMINAL_CHUNK_BYTES,
          available,
          frame.bytes.byteLength - frame.offset
        )
        const chunk = frame.bytes.slice(frame.offset, frame.offset + chunkBytes)
        frame.offset += chunkBytes
        this.pendingBytes -= chunkBytes
        if (frame.offset === frame.bytes.byteLength) this.pending.shift()
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
    additionalUnsentFrames: readonly Uint8Array[] = []
  ): void {
    this.close(additionalUnsentFrames, (transition) => {
      this.options.disconnect(reason, transition)
    })
  }
}
