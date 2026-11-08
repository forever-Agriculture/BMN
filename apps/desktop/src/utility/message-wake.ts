// MODULE: message-wake.ts - Story 110.3: a resting session gets its message: one fixed line, typed once per message into a session proven idle, within a depth and hourly limits (D3, D12)
import {
  SESSION_MESSAGE_WAKE_LINE,
  SESSION_MESSAGE_WAKE_MAX_DEPTH,
  SESSION_MESSAGE_WAKE_QUIET_MS
} from '@bmn/protocol'
import { typeIfIdle, type WakeAttention, type WakeObservation, type WakeProof } from './away-wake'

/** The apps whose fixed-line route passed 110.1's measurement (docs/session-messages.md); any other is never woken. */
export const MESSAGE_WAKE_APPS: readonly string[] = ['claude', 'codex']

/** A waiting message as the wake reads it, oldest first. */
export interface MessageWakeCandidate {
  messageId: string
  /** Its depth when it was sent; null when the sender's could not be read, which wakes no one. */
  wakeDepth: number | null
  wokenAt: string | null
}

export interface MessageWakeOptions extends WakeProof {
  /** Sessions with a waiting message no wake was typed for. */
  receivers(): Promise<readonly string[]>
  candidates(sessionId: string): Promise<readonly MessageWakeCandidate[]>
  /** Why this session's provider may not read this message, or null; it starts no paid turn for text it may not read. */
  providerRefusal(sessionId: string, incarnationId: string, messageId: string): Promise<string | null>
  /** One wake per message, ever, within the hourly limits: the store's word, taken before the line is typed. */
  claim(messageId: string): Promise<{ claimed: true; at: string } | { claimed: false; reason: string }>
  /** Nothing was typed after all: the message may be woken for later. Best effort; failing leaves it unwoken. */
  release(messageId: string, at: string): Promise<void>
  observation(sessionId: string): WakeObservation | undefined
  openAttention(): Promise<readonly WakeAttention[]>
  /** When this run's latest turn finished with nothing left in flight, by its own hook; the owner reading it does not change this. */
  finishedTurn(sessionId: string, incarnationId: string): string | null
  /** When BMN last typed anything into this session (this wake or the Away wake); null when it has not. */
  typedAt(sessionId: string): number | null
  /** Why a message was not woken, for its sender's `bmn tell status`; null clears it. Held for this run only. */
  note(messageId: string, reason: string | null): void
  log(line: string): void
  quietMs?: number
}

/**
 * Types the fixed line (D12), which names no message and grants nothing. The hook then hands the message over at the
 * agent's next tool call, as it hands over any other; the stamp stays "context, not an instruction" and a wake lifts no
 * stop and starts no run of its own. The final checks are the Away wake's, synchronous and right before the write.
 */
export class MessageWake {
  private running = false

  constructor(private readonly options: MessageWakeOptions) {}

  async sweep(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      // Every receiver's generation is read before the requests are, as the Away wake does, so a request that opens
      // for any of them after the one shared read below changes its generation and stops the write.
      const receivers = (await this.options.receivers()).map((sessionId) => ({ sessionId, generation: this.options.generation(sessionId).generation }))
      if (receivers.length === 0) return
      const open = await this.options.openAttention()
      for (const { sessionId, generation } of receivers) await this.receiver(sessionId, generation, open).catch(() => undefined)
    } finally {
      this.running = false
    }
  }

  private async receiver(sessionId: string, generation: number, open: readonly WakeAttention[]): Promise<void> {
    const waiting = (await this.options.candidates(sessionId)).filter((candidate) => candidate.wokenAt === null)
    if (waiting.length === 0) return
    const seen = this.options.observation(sessionId)
    const say = (messages: readonly MessageWakeCandidate[], reason: string): void => {
      for (const message of messages) this.options.note(message.messageId, reason)
    }
    if (seen === undefined) { say(waiting, 'BMN has not heard from its agent'); return }
    if (!MESSAGE_WAKE_APPS.includes(seen.agent)) { say(waiting, `${seen.agent} sessions are not woken`); return }
    // The oldest message that may wake it; the others wait behind it, or say why they cannot.
    let chosen: MessageWakeCandidate | null = null
    const behind: MessageWakeCandidate[] = []
    for (const message of waiting) {
      if (message.wakeDepth === null) { this.options.note(message.messageId, 'how deep its sender was could not be read; it waits for the receiver\'s next turn'); continue }
      if (message.wakeDepth < 1 || message.wakeDepth > SESSION_MESSAGE_WAKE_MAX_DEPTH) {
        this.options.note(message.messageId, 'it follows too many woken turns; it waits for the receiver\'s next turn')
        continue
      }
      const refusal = await this.options.providerRefusal(sessionId, seen.incarnationId, message.messageId)
      if (refusal !== null) { this.options.note(message.messageId, refusal); continue }
      if (chosen === null) chosen = message
      else behind.push(message)
    }
    if (chosen === null) return
    const quietMs = this.options.quietMs ?? SESSION_MESSAGE_WAKE_QUIET_MS
    let message = chosen
    let claimedAt: string | null = null
    // A message past its own pair's limit keeps its reason and holds up none behind it (113.7): each is claimed in turn.
    const limited = new Set<string>()
    const reason = await typeIfIdle(this.options, {
      seen, generation, open, quietMs, quietWords: `its turn finished less than ${Math.round(quietMs / 60_000)} minutes ago`, line: SESSION_MESSAGE_WAKE_LINE,
      finished: { at: this.options.finishedTurn(sessionId, seen.incarnationId), unknown: 'BMN did not see this run finish a turn with nothing in flight' },
      stillAllowed: () => {
        const typed = this.options.typedAt(sessionId)
        return typed !== null && this.options.now().getTime() - typed < quietMs ? 'BMN typed into it a moment ago' : null
      },
      claim: async () => {
        let refused: string | null = null
        for (const each of [chosen, ...behind]) {
          const claim = await this.options.claim(each.messageId)
          if (claim.claimed) { message = each; claimedAt = claim.at; return null }
          limited.add(each.messageId)
          this.options.note(each.messageId, claim.reason)
          refused ??= claim.reason
        }
        return refused
      },
      unclaim: async () => { if (claimedAt !== null) await this.options.release(message.messageId, claimedAt).catch(() => undefined) }
    })
    const others = [chosen, ...behind].filter((each) => each !== message && !limited.has(each.messageId))
    if (reason === null) {
      this.options.note(message.messageId, null)
      say(others, 'another message woke it first; this one comes after')
      this.options.log(`message wake: typed the wake line into ${sessionId} for ${message.messageId}`)
      return
    }
    say([chosen, ...behind].filter((each) => !limited.has(each.messageId)), reason)
    this.options.log(`message wake: skipped ${sessionId}: ${reason}`)
  }
}

/** The test-only quiet time, honoured only in a test-mode host. */
export function testMessageWakeQuiet(argv: readonly string[], env: NodeJS.ProcessEnv): { quietMs?: number } {
  if (!argv.includes('--bmn-test-host')) return {}
  const number = Number(env.BMN_TEST_MESSAGE_WAKE_QUIET_MS)
  return Number.isSafeInteger(number) && number >= 1000 ? { quietMs: number } : {}
}
