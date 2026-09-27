// MODULE: telegram-card-keeper.ts - keeps each Telegram card true to its request: sends, edits in place, taps and outcomes (Story 30.3)
import { randomBytes } from 'node:crypto'
import type { AttentionRecord } from '@bmn/protocol'
import type { TelegramCardData, TelegramCardRecord, TelegramCardState } from './database-companion-store'
import type { AnswerOutcome, AnswerRequest, RemoteAnswer } from './remote-answer'
import {
  endedCard,
  endingReply,
  exitCard,
  noticeCard,
  permissionCard,
  plainText,
  questionCard,
  REFUSAL_WORDS,
  requestCard,
  type CardEnding,
  type CardHeader,
  type InlineKeyboard,
  type RenderedCard
} from './telegram-cards'
import { TelegramConnectorError, type CardMessageOptions, type InboundTap } from './telegram-connector'

export interface CardConnector {
  sendMessage(text: string, options?: CardMessageOptions): Promise<{ messageId: number }>
  editMessageText(messageId: number, text: string, options?: Omit<CardMessageOptions, 'replyToMessageId'>): Promise<void>
  answerCallbackQuery(callbackId: string, text: string): Promise<void>
}

export type Answerability =
  | { answerable: true; deny: boolean }
  | { answerable: false; reason: 'unsupported' | 'permissions-off' }

export interface CardKeeperDependencies {
  /** The polling connector, or undefined while Telegram is off or not connected. */
  connector(): CardConnector | undefined
  getAttention(requestId: string): Promise<AttentionRecord | null>
  header(sessionId: string, record: AttentionRecord | null): CardHeader
  answerability(record: AttentionRecord): Promise<Answerability>
  answerEpoch(requestId: string): number | null
  liveIncarnationId(sessionId: string): string | undefined
  answer(request: AnswerRequest): Promise<AnswerOutcome>
  store: {
    put(card: TelegramCardRecord): Promise<void>
    update(messageId: number, revision: number | null, state: TelegramCardState, card: TelegramCardData): Promise<void>
    list(states: TelegramCardState[]): Promise<TelegramCardRecord[]>
    /** Records a plain message (a reply, an exit notice) so a reply to it still reaches its session. */
    message(messageId: number, sessionId: string, requestId: string | null, incarnationId: string | null): Promise<void>
  }
  home: string | null
  /** Quiet time before a burst of request changes is read back; at most a few hundred milliseconds. */
  settleMs?: number
  token?: () => string
}

type TapAction = { type: 'choice'; step: number; index: number } | { type: 'permission'; decision: 'allow' | 'deny' }

interface LiveCard {
  messageId: number
  sessionId: string
  requestId: string
  /** The process the card's buttons answer; null when it has none. */
  incarnationId: string | null
  revision: number
  epoch: number | null
  state: TelegramCardState
  format: TelegramCardData['format']
  base: string
  permission: boolean
  step: number
  chosen: number[]
  labels: string[]
  tokens: string[]
  /** An answer reported `sent-unconfirmed` that a late report may still confirm. */
  upgradable: boolean
  /** Edits of one card run one after another, in the order they were decided. */
  queue: Promise<void>
}

interface Composed {
  rendered: RenderedCard
  state: 'buttons' | 'open'
  actions: TapAction[]
}

const DEFAULT_SETTLE_MS = 150

/** Telegram refused the HTML, or the card cannot fit at all: either way the words go out plain. */
function isFormattingRefusal(error: unknown): boolean {
  return error instanceof TelegramConnectorError && (error.status === 400 || error.kind === 'invalid-argument')
}

/**
 * One card per request. A card with buttons carries random single-use tokens bound to its message and the
 * request revision, dialog epoch and process it was drawn for; any tap revokes them all. Whatever happens to
 * the request afterwards is written back onto the same message, so the phone never shows a stale choice.
 */
export class TelegramCardKeeper {
  private readonly cards = new Map<number, LiveCard>()
  private readonly byRequest = new Map<string, number>()
  private readonly tokens = new Map<string, { messageId: number; action: TapAction }>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private swept = false
  private disposed = false

  constructor(private readonly deps: CardKeeperDependencies) {}

  /** Sends the page for a request, or brings its existing card to this revision instead of sending another. */
  async page(record: AttentionRecord): Promise<void> {
    const connector = this.deps.connector()
    if (!connector || this.disposed) return
    const existing = this.cardFor(record.requestId)
    if (existing) {
      if (existing.state === 'buttons' || existing.state === 'open') {
        await this.enqueue(existing, () => this.refreshCard(existing))
      }
      return
    }
    const composed = await this.compose(record, { step: 0, chosen: [] }, null, null)
    const incarnationId = this.deps.liveIncarnationId(record.sessionId) ?? null
    let format: TelegramCardData['format'] = 'html'
    let messageId: number
    try {
      messageId = (await connector.sendMessage(composed.rendered.text, {
        html: true,
        keyboard: composed.rendered.keyboard
      })).messageId
    } catch (error) {
      if (!isFormattingRefusal(error)) return
      // Telegram refused the formatting: the owner still gets the words, answered at the laptop.
      format = 'plain'
      const fallback = `${plainText(composed.rendered.text)}${composed.state === 'buttons' ? '\n\nAnswer at the laptop.' : ''}`
      try {
        messageId = (await connector.sendMessage(fallback)).messageId
      } catch {
        return
      }
    }
    const state = format === 'plain' ? 'open' : composed.state
    const card: LiveCard = {
      messageId,
      sessionId: record.sessionId,
      requestId: record.requestId,
      incarnationId: record.incarnationId ?? incarnationId,
      revision: record.revision,
      epoch: this.deps.answerEpoch(record.requestId),
      state,
      format,
      base: composed.rendered.base,
      permission: record.prompt?.type === 'permission',
      step: 0,
      chosen: [],
      labels: [],
      tokens: [],
      upgradable: false,
      queue: Promise.resolve()
    }
    this.cards.set(messageId, card)
    this.byRequest.set(record.requestId, messageId)
    if (state === 'buttons') this.mint(card, composed)
    await this.deps.store.put({
      messageId,
      sessionId: record.sessionId,
      requestId: record.requestId,
      incarnationId,
      revision: record.revision,
      state,
      card: { base: card.base, format }
    }).catch(() => undefined)
    // The request may have closed while the card was on its way.
    await this.enqueue(card, () => this.refreshCard(card))
  }

  /** A session's requests changed; its cards are read back once the burst settles. Null means every session. */
  changed(sessionId: string | null): void {
    if (this.disposed) return
    const key = sessionId ?? '*'
    if (this.timers.has(key)) return
    const timer = setTimeout(() => {
      this.timers.delete(key)
      for (const card of this.cards.values()) {
        if (sessionId !== null && card.sessionId !== sessionId) continue
        if (card.state !== 'buttons' && card.state !== 'open') continue
        void this.enqueue(card, () => this.refreshCard(card))
      }
    }, this.deps.settleMs ?? DEFAULT_SETTLE_MS)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  /** A tap from the allowed chat. Claims first, then answers the tap, then starts delivery without waiting for it. */
  async tap(tap: InboundTap): Promise<void> {
    const connector = this.deps.connector()
    if (!connector || this.disposed) return
    const entry = this.tokens.get(tap.data)
    const card = entry ? this.cards.get(entry.messageId) : undefined
    if (!entry || !card || entry.messageId !== tap.messageId || card.state !== 'buttons') {
      await connector.answerCallbackQuery(tap.callbackId, 'This button is no longer active.').catch(() => undefined)
      const shown = this.cards.get(tap.messageId)
      if (shown && (shown.state === 'buttons' || shown.state === 'open')) await this.enqueue(shown, () => this.refreshCard(shown))
      return
    }
    this.revoke(card)
    const action = entry.action
    if (action.type === 'permission') {
      const label = action.decision === 'allow' ? 'Allow once' : 'Deny'
      card.state = 'sending'
      await connector.answerCallbackQuery(tap.callbackId, `Sending ${label}…`).catch(() => undefined)
      await this.enqueue(card, () => this.showSending(card, [label]))
      void this.deliver(card, { type: 'permission', decision: action.decision }, [label])
      return
    }
    const record = await this.deps.getAttention(card.requestId).catch(() => null)
    const prompt = record?.prompt
    if (!record || prompt?.type !== 'questions' || action.step !== card.step) {
      await connector.answerCallbackQuery(tap.callbackId, 'This button is no longer active.').catch(() => undefined)
      await this.enqueue(card, () => this.refreshCard(card))
      return
    }
    card.chosen = [...card.chosen, action.index]
    card.labels = [...card.labels, prompt.questions[action.step]!.options[action.index]!.label]
    if (card.step + 1 < prompt.questions.length) {
      card.step += 1
      card.state = 'buttons'
      await connector.answerCallbackQuery(tap.callbackId, `Question ${card.step + 1} of ${prompt.questions.length}`)
        .catch(() => undefined)
      await this.enqueue(card, async () => {
        const composed = await this.compose(record, { step: card.step, chosen: card.chosen }, null, card.epoch)
        await this.show(card, composed)
      })
      return
    }
    card.state = 'sending'
    await connector.answerCallbackQuery(tap.callbackId, `Sending ${card.labels.join(' · ')}…`).catch(() => undefined)
    await this.enqueue(card, () => this.showSending(card, card.labels))
    void this.deliver(card, { type: 'choices', choices: card.chosen }, card.labels)
  }

  /** A report that confirmed an answer after the card already said it was not confirmed. */
  lateOutcome(requestId: string, outcome: AnswerOutcome): void {
    const card = this.cardFor(requestId)
    if (!card || !card.upgradable || outcome.state !== 'confirmed') return
    card.upgradable = false
    void this.enqueue(card, () => this.finish(card, { type: 'outcome', outcome, permission: card.permission }))
  }

  /**
   * Once per BMN start: a card left with buttons can no longer be answered, and one left sending never learned
   * its outcome. Cards this process already keeps are live and left alone.
   */
  async sweep(): Promise<void> {
    const connector = this.deps.connector()
    if (!connector || this.swept || this.disposed) return
    this.swept = true
    const stale = await this.deps.store.list(['buttons', 'sending']).catch(() => [])
    for (const row of stale) {
      if (this.cards.has(row.messageId)) continue
      const ending: CardEnding = row.state === 'sending' ? { type: 'restarted-sending' } : { type: 'restarted' }
      const text = endedCard(row.card.base, ending)
      try {
        await connector.editMessageText(row.messageId, row.card.format === 'plain' ? plainText(text) : text,
          { html: row.card.format === 'html', keyboard: null })
      } catch {
        // A card Telegram no longer lets BMN edit is still finished here, so it is not retried every start.
      }
      await this.deps.store.update(row.messageId, row.revision, 'final', row.card).catch(() => undefined)
    }
  }

  /** The session's process ended; says so in the same header style as the cards. */
  async exited(sessionId: string): Promise<void> {
    const connector = this.deps.connector()
    if (!connector || this.disposed) return
    const incarnationId = this.deps.liveIncarnationId(sessionId) ?? null
    try {
      const sent = await connector.sendMessage(exitCard(this.deps.header(sessionId, null)), { html: true })
      await this.deps.store.message(sent.messageId, sessionId, null, incarnationId)
    } catch {
      // Connector health carries the redacted failure.
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.tokens.clear()
  }

  private cardFor(requestId: string): LiveCard | undefined {
    const messageId = this.byRequest.get(requestId)
    return messageId === undefined ? undefined : this.cards.get(messageId)
  }

  private enqueue(card: LiveCard, work: () => Promise<void>): Promise<void> {
    const next = card.queue.then(() => (this.disposed ? undefined : work())).catch(() => undefined)
    card.queue = next
    return next
  }

  private newToken(): string {
    return this.deps.token?.() ?? randomBytes(16).toString('base64url')
  }

  private mint(card: LiveCard, composed: Composed): void {
    this.revoke(card)
    const keyboard = composed.rendered.keyboard
    if (!keyboard) return
    const buttons = keyboard.flat()
    buttons.forEach((button, index) => {
      this.tokens.set(button.callback_data, { messageId: card.messageId, action: composed.actions[index]! })
      card.tokens.push(button.callback_data)
    })
  }

  private revoke(card: LiveCard): void {
    for (const token of card.tokens) this.tokens.delete(token)
    card.tokens = []
  }

  /**
   * Draws the card for the request as it is now. Buttons appear only where 30.2 has a verified route, the
   * dialog has an epoch to bind to and the process that asked is known.
   */
  private async compose(
    record: AttentionRecord,
    progress: { step: number; chosen: number[] },
    note: string | null,
    epoch: number | null
  ): Promise<Composed> {
    const header = this.deps.header(record.sessionId, record)
    const prompt = record.prompt
    const none: Omit<Composed, 'rendered'> = { state: 'open', actions: [] }
    if (!prompt) {
      return { ...none, rendered: record.kind === 'notice' ? noticeCard(header, record) : requestCard(header, record) }
    }
    const answerability = await this.deps.answerability(record)
    const bound = (epoch ?? this.deps.answerEpoch(record.requestId)) !== null &&
      (record.incarnationId ?? this.deps.liveIncarnationId(record.sessionId)) !== undefined
    const answerable = answerability.answerable && bound
    if (prompt.type === 'permission') {
      if (!answerable) {
        const closedBecause = answerability.answerable ? 'unsupported' : answerability.reason
        return { ...none, rendered: permissionCard({ header, prompt, tokens: null, closedBecause, home: this.deps.home, note }) }
      }
      const deny = answerability.answerable && answerability.deny
      const tokens = { allow: this.newToken(), deny: deny ? this.newToken() : null }
      const actions: TapAction[] = [{ type: 'permission', decision: 'allow' }]
      if (deny) actions.push({ type: 'permission', decision: 'deny' })
      return {
        state: 'buttons',
        actions,
        rendered: permissionCard({ header, prompt, tokens, closedBecause: null, home: this.deps.home, note })
      }
    }
    const chosen = progress.chosen.map((index, step) => prompt.questions[step]?.options[index]?.label ?? '')
    if (!answerable) {
      return { ...none, rendered: questionCard({ header, prompt, step: 0, chosen: [], tokens: null, note }) }
    }
    const options = prompt.questions[progress.step]!.options
    const tokens = options.map(() => this.newToken())
    return {
      state: 'buttons',
      actions: options.map((_, index) => ({ type: 'choice', step: progress.step, index })),
      rendered: questionCard({ header, prompt, step: progress.step, chosen, tokens, note })
    }
  }

  /** Writes a composed card onto its message, falling back once to plain words if Telegram refuses the HTML. */
  private async show(card: LiveCard, composed: Composed): Promise<void> {
    const connector = this.deps.connector()
    if (!connector) return
    if (card.format === 'html') {
      try {
        await connector.editMessageText(card.messageId, composed.rendered.text, { html: true, keyboard: composed.rendered.keyboard })
        card.base = composed.rendered.base
        card.state = composed.state
        if (composed.state === 'buttons') this.mint(card, composed)
        else this.revoke(card)
        await this.save(card)
        return
      } catch (error) {
        if (!isFormattingRefusal(error)) throw error
        card.format = 'plain'
      }
    }
    this.revoke(card)
    card.state = 'open'
    await connector.editMessageText(card.messageId,
      `${plainText(composed.rendered.text)}${composed.state === 'buttons' ? '\n\nAnswer at the laptop.' : ''}`)
    card.base = composed.rendered.base
    await this.save(card)
  }

  private async showSending(card: LiveCard, labels: string[]): Promise<void> {
    await this.writeEnding(card, { type: 'sending', labels })
    await this.save(card)
  }

  private async finish(card: LiveCard, ending: CardEnding): Promise<void> {
    this.revoke(card)
    card.state = 'final'
    await this.writeEnding(card, ending)
    await this.save(card)
  }

  private async writeEnding(card: LiveCard, ending: CardEnding): Promise<void> {
    const connector = this.deps.connector()
    if (!connector) return
    const text = endedCard(card.base, ending)
    const keyboard: InlineKeyboard | null = null
    await connector.editMessageText(card.messageId, card.format === 'plain' ? plainText(text) : text,
      { html: card.format === 'html', keyboard }).catch(() => undefined)
  }

  private async save(card: LiveCard): Promise<void> {
    await this.deps.store.update(card.messageId, card.revision, card.state, { base: card.base, format: card.format })
      .catch(() => undefined)
  }

  /** Reads the request back and makes the card say what is true now. A card that is sending is left to its outcome. */
  private async refreshCard(card: LiveCard): Promise<void> {
    if (card.state !== 'buttons' && card.state !== 'open') return
    const record = await this.deps.getAttention(card.requestId).catch(() => null)
    if (card.state !== 'buttons' && card.state !== 'open') return
    if (!record || record.state !== 'open') {
      const ending: CardEnding = record?.state === 'answered'
        ? record.resolvedBy === 'telegram' ? { type: 'telegram' } : { type: 'laptop' }
        : { type: 'closed' }
      await this.finish(card, ending)
      return
    }
    if (record.revision === card.revision) return
    card.revision = record.revision
    card.epoch = this.deps.answerEpoch(record.requestId)
    card.step = 0
    card.chosen = []
    card.labels = []
    await this.show(card, await this.compose(record, { step: 0, chosen: [] }, null, card.epoch))
  }

  /** Runs detached from the poll loop: 30.2 may take seconds to confirm. */
  private async deliver(card: LiveCard, answer: RemoteAnswer, labels: string[]): Promise<void> {
    const outcome = await this.deps.answer({
      requestId: card.requestId,
      revision: card.revision,
      epoch: card.epoch ?? -1,
      incarnationId: card.incarnationId ?? '',
      answer
    }).catch((): AnswerOutcome => ({ state: 'sent-unconfirmed', sent: labels }))
    await this.enqueue(card, () => this.settle(card, outcome))
  }

  private async settle(card: LiveCard, outcome: AnswerOutcome): Promise<void> {
    const reply = endingReply(outcome)
    if (outcome.state === 'refused') {
      // Nothing was sent. While the request is still open, the owner gets fresh buttons and can try again.
      const record = await this.deps.getAttention(card.requestId).catch(() => null)
      if (record?.state === 'open') {
        card.revision = record.revision
        card.epoch = this.deps.answerEpoch(record.requestId)
        card.step = 0
        card.chosen = []
        card.labels = []
        card.state = 'open'
        await this.show(card, await this.compose(record, { step: 0, chosen: [] }, REFUSAL_WORDS[outcome.reason], card.epoch))
      } else {
        await this.finish(card, { type: 'outcome', outcome, permission: card.permission })
      }
    } else {
      card.upgradable = outcome.state === 'sent-unconfirmed'
      await this.finish(card, { type: 'outcome', outcome, permission: card.permission })
    }
    if (reply) await this.reply(card, reply)
  }

  private async reply(card: LiveCard, text: string): Promise<void> {
    const connector = this.deps.connector()
    if (!connector) return
    try {
      const sent = await connector.sendMessage(text, { replyToMessageId: card.messageId })
      await this.deps.store.message(sent.messageId, card.sessionId, card.requestId, card.incarnationId)
    } catch {
      // The card itself already says what happened.
    }
  }
}
