import { failureDetail } from './bridge-error'
import {
  CONSUMER_OUTPUT_QUEUE_BYTES,
  type TerminalOutputMessage,
  type TerminalViewDisconnectReason
} from '@ai-terminal/protocol'

interface TerminalOutputActions {
  write(bytes: Uint8Array, settled: () => void): void
  acknowledge(attachmentId: string, streamSeq: number): void
  recover(reason: TerminalViewDisconnectReason): void
}

interface TerminalRecoveryActions {
  clearAttachment(): void
  setStatus(status: string): void
  setFailure(message: string): void
  recover(reason: TerminalViewDisconnectReason): Promise<unknown>
}

export async function handleTerminalViewFailure(
  reason: TerminalViewDisconnectReason,
  actions: TerminalRecoveryActions
): Promise<void> {
  actions.clearAttachment()
  actions.setStatus('Terminal view recovering')
  actions.setFailure(terminalViewDisconnectNotice(reason))
  try {
    await actions.recover(reason)
  } catch (error) {
    const detail = failureDetail(error, 'the recovery request failed')
    actions.setStatus('Terminal view disconnected')
    actions.setFailure(
      `Terminal view recovery failed: ${detail.slice(0, 240)}. Fix: reopen BMN; the shell process was not stopped.`
    )
  }
}

type OutputChunk = Pick<TerminalOutputMessage, 'attachmentId' | 'streamSeq' | 'bytes'>

export function terminalViewDisconnectNotice(reason: TerminalViewDisconnectReason): string {
  if (reason === 'sequence-gap') {
    return 'Terminal output sequence was invalid. Rebuilding this view; the shell process was not stopped.'
  }
  if (reason === 'acknowledgement-timeout') {
    return 'Terminal output acknowledgements stalled. Rebuilding this view; the shell process was not stopped.'
  }
  return `Terminal output exceeded the ${CONSUMER_OUTPUT_QUEUE_BYTES / (1024 * 1024)} MiB view queue. Rebuilding this view; the shell process was not stopped.`
}

export function undeliveredOutputLossNotice(droppedBytes: number): string {
  return `${droppedBytes.toLocaleString('en-US')} bytes of terminal output produced without a view were dropped. Earlier output remains available only in Saved Output.`
}

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
    actions.write(message.bytes, () => {
      if (generation !== this.generation || message.attachmentId !== this.attachmentId) return
      this.queuedBytes -= message.bytes.byteLength
      actions.acknowledge(message.attachmentId, message.streamSeq)
    })
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
