// MODULE: close-prompt-ipc.ts - asks the window itself what to do with live sessions, instead of a native message box
import { randomUUID } from 'node:crypto'
import { isClosePromptDecision, type ClosePromptDecision, type ClosePromptMode, type ClosePromptSession } from '@bmn/protocol'
import type { IpcMainEvent, WebContents } from 'electron'

interface ClosePromptIpcRegistrar {
  on(
    channel: 'aiterm:lifecycle:close-decision',
    listener: (event: IpcMainEvent, requestId: unknown, decision: unknown) => void
  ): void
  on(channel: 'aiterm:lifecycle:unsaved-edits', listener: (event: IpcMainEvent, unsaved: unknown) => void): void
}

interface PendingPrompt {
  senderId: number
  resolve(decision: ClosePromptDecision | undefined): void
  release(): void
}

/**
 * A prompt the owner answers, so it has no timeout: a person thinking about their running agents
 * is not a stalled request. It resolves `undefined` only when the window cannot answer at all --
 * destroyed, reloading, or not an authorized sender -- and the caller then falls back to the
 * native dialog rather than deciding on the owner's behalf.
 */
export class ClosePromptCoordinator {
  private readonly pending = new Map<string, PendingPrompt>()
  /** Windows whose Quick look holds unsaved edits; only that they exist, never what they are (Story 68.1 AC8). */
  private readonly unsaved = new Set<number>()

  constructor(
    ipc: ClosePromptIpcRegistrar,
    private readonly senderIsAllowed: (sender: WebContents) => boolean
  ) {
    ipc.on('aiterm:lifecycle:close-decision', (event, requestId, rawDecision) => {
      if (typeof requestId !== 'string' || !this.senderIsAllowed(event.sender)) return
      const pending = this.pending.get(requestId)
      if (!pending || pending.senderId !== event.sender.id) return
      if (!isClosePromptDecision(rawDecision)) return
      this.pending.delete(requestId)
      pending.release()
      pending.resolve(rawDecision)
    })
    ipc.on('aiterm:lifecycle:unsaved-edits', (event, unsaved) => {
      if (typeof unsaved !== 'boolean' || !this.senderIsAllowed(event.sender)) return
      const sender = event.sender
      if (!unsaved) {
        this.unsaved.delete(sender.id)
        return
      }
      if (this.unsaved.has(sender.id)) return
      this.unsaved.add(sender.id)
      // A reload or a destroyed window takes its draft with it.
      const forget = (): void => {
        this.unsaved.delete(sender.id)
        sender.off('destroyed', forget)
        sender.off('did-start-loading', forget)
      }
      sender.once('destroyed', forget)
      sender.once('did-start-loading', forget)
    })
  }

  /** The window holds unsaved edits, so a close or a Quit asks it first even with no session running. */
  hasUnsavedEdits(sender: WebContents | undefined): boolean {
    return !!sender && !sender.isDestroyed() && this.unsaved.has(sender.id)
  }

  request(
    sender: WebContents | undefined,
    mode: ClosePromptMode,
    sessions: readonly ClosePromptSession[]
  ): Promise<ClosePromptDecision | undefined> {
    if (!sender || sender.isDestroyed() || !this.senderIsAllowed(sender)) {
      return Promise.resolve(undefined)
    }
    const requestId = randomUUID()
    return new Promise((resolve) => {
      // A reload or a destroyed window takes the question with it; the caller asks natively instead.
      const abandon = (): void => {
        if (!this.pending.delete(requestId)) return
        release()
        resolve(undefined)
      }
      const release = (): void => {
        sender.off('destroyed', abandon)
        sender.off('did-start-loading', abandon)
      }
      sender.once('destroyed', abandon)
      sender.once('did-start-loading', abandon)
      this.pending.set(requestId, { senderId: sender.id, resolve, release })
      try {
        sender.send('aiterm:lifecycle:close-prompt', { requestId, mode, sessions: [...sessions] })
      } catch {
        abandon()
      }
    })
  }
}

/** `/usr/bin/claude` is noise in a question about your work; `claude` is the answer to "which agent". */
export function agentName(executable: string): string {
  const name = executable.split('/').filter(Boolean).at(-1)
  return name && name.length > 0 ? name : executable
}
