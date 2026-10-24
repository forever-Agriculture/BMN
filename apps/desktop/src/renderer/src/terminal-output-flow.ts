import {
  CONSUMER_OUTPUT_QUEUE_BYTES,
  TERMINAL_WRITE_BYTES,
  terminalWriteCut,
  type TerminalOutputMessage,
  type TerminalViewDisconnectReason
} from '@bmn/protocol'

interface TerminalOutputActions {
  write(bytes: Uint8Array, settled: () => void): void
  acknowledge(attachmentId: string, streamSeq: number): void
  recover(reason: TerminalViewDisconnectReason): void
}

type OutputChunk = Pick<TerminalOutputMessage, 'attachmentId' | 'streamSeq' | 'bytes'>

export class TerminalOutputFlow {
  private attachmentId: string | undefined
  private expectedSequence = 0
  private queuedBytes = 0
  private generation = 0

  constructor(private readonly limitBytes = CONSUMER_OUTPUT_QUEUE_BYTES) {}

  attach(attachmentId: string): void {
    this.generation += 1
    this.attachmentId = attachmentId
    this.expectedSequence = 0
    this.queuedBytes = 0
  }

  detach(attachmentId: string): void {
    if (this.attachmentId !== attachmentId) return
    this.invalidate()
  }

  accept(message: OutputChunk, actions: TerminalOutputActions): boolean {
    if (message.attachmentId !== this.attachmentId) return false
    if (message.streamSeq !== this.expectedSequence) {
      this.fail('sequence-gap', actions)
      return false
    }
    if (this.queuedBytes + message.bytes.byteLength > this.limitBytes) {
      this.fail('output-overflow', actions)
      return false
    }

    this.expectedSequence += 1
    this.queuedBytes += message.bytes.byteLength
    const generation = this.generation
    // Writes no longer than xterm's parse piece, cut between characters, so xterm never cuts one.
    const bytes = message.bytes
    let start = 0
    do {
      let end = terminalWriteCut(bytes, start, start + TERMINAL_WRITE_BYTES)
      if (end === start) end = start + TERMINAL_WRITE_BYTES
      const last = end >= bytes.byteLength
      actions.write(bytes.subarray(start, end), () => {
        if (!last || generation !== this.generation || message.attachmentId !== this.attachmentId) return
        this.queuedBytes -= bytes.byteLength
        actions.acknowledge(message.attachmentId, message.streamSeq)
      })
      start = end
    } while (start < bytes.byteLength)
    return true
  }

  disconnect(
    attachmentId: string,
    reason: TerminalViewDisconnectReason,
    actions: Pick<TerminalOutputActions, 'recover'>
  ): boolean {
    if (attachmentId !== this.attachmentId) return false
    this.fail(reason, actions)
    return true
  }

  private fail(
    reason: TerminalViewDisconnectReason,
    actions: Pick<TerminalOutputActions, 'recover'>
  ): void {
    this.invalidate()
    actions.recover(reason)
  }

  private invalidate(): void {
    this.generation += 1
    this.attachmentId = undefined
    this.queuedBytes = 0
  }
}
