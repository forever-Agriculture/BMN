// MODULE: telegram-card-keeper.ts - keeps each Telegram card true to its request: sends, edits in place, taps and outcomes (Story 30.3)
import { randomBytes } from 'node:crypto'
import type { AttentionQuestionsPrompt, AttentionRecord } from '@bmn/protocol'
import type { TelegramCardData, TelegramCardRecord, TelegramCardState } from './database-companion-store'
import {
  cleanTypedAnswer,
  shownChoice,
  typedAnswerable,
  type AnswerOutcome,
  type AnswerRequest,
  type QuestionChoice,
  type RemoteAnswer
} from './remote-answer'
import {
  endedCard,
  endingReply,
  exitCard,
  noticeCard,
  commandShownWhole,
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
import { TelegramConnectorError, type CardMessageOptions, type InboundReply, type InboundTap } from './telegram-connector'

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
  /** Waits before each retry of a card's final edit that Telegram did not take; about ten seconds to five minutes. */
  retryMs?: readonly number[]
  token?: () => string
}

type TapAction =
  | { type: 'choice' | 'toggle'; step: number; index: number }
  /** Send or Next on a multi-select question; Other…; ‹ Options back from a typed reply; ‹ Back a question. */
  | { type: 'submit' | 'other' | 'options' | 'back'; step: number }
  | { type: 'permission'; decision: 'allow' | 'deny' }

/** Where the owner is in a question card: nothing is sent before the last question is answered. */
interface Progress {
  step: number
  /** The answers of the questions before `step`. */
  choices: QuestionChoice[]
  /** Multi-select: the options toggled on at `step`. */
  toggled: number[]
  /** Single choice after Back: the option chosen before. */
  marked: number | null
  /** The card waits for a typed reply after Other…. */
  typing: boolean
}

const START: Readonly<Progress> = Object.freeze({ step: 0, choices: [], toggled: [], marked: null, typing: false })

/** What a set of buttons was drawn for, fixed when they are minted: a tap answers exactly this, never a later revision. */
interface Binding {
  readonly revision: number
  readonly epoch: number | null
  readonly incarnationId: string | null
}

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
  progress: Progress
  /** Whether the card as drawn offers Other…, so a reply to it is a typed answer or refused. */
  offersOther: boolean
  tokens: string[]
  /** An answer reported `sent-unconfirmed` that a late report may still confirm. */
  upgradable: boolean
  /** The ending still to be written after a failed edit, and the timer that retries it. */
  unwritten: { ending: CardEnding; timer: NodeJS.Timeout | null } | null
  /** Edits of one card run one after another, in the order they were decided. */
  queue: Promise<void>
}

interface Composed {
  rendered: RenderedCard
  state: 'buttons' | 'open'
  actions: TapAction[]
  offersOther: boolean
}

const DEFAULT_SETTLE_MS = 150
const DEFAULT_RETRY_MS = [10_000, 60_000, 300_000]

/**
 * Telegram will never take this edit (the message is gone or can no longer be edited, the chat blocked the
 * bot, or the text cannot fit); anything else may work later.
 */
function isPermanentEditFailure(error: unknown): boolean {
  return error instanceof TelegramConnectorError &&
    (error.status === 400 || error.status === 403 || error.kind === 'invalid-argument')
}

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
  private readonly tokens = new Map<string, { messageId: number; action: TapAction; binding: Binding }>()
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
    const incarnationId = this.deps.liveIncarnationId(record.sessionId) ?? null
    const binding: Binding = {
      revision: record.revision,
      epoch: this.deps.answerEpoch(record.requestId),
      incarnationId: record.incarnationId ?? incarnationId
    }
    const composed = await this.compose(record, START, null, binding.epoch)
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
      incarnationId: binding.incarnationId,
      revision: binding.revision,
      epoch: binding.epoch,
      state,
      format,
      base: composed.rendered.base,
      permission: record.prompt?.type === 'permission',
      progress: { ...START },
      offersOther: false,
      tokens: [],
      upgradable: false,
      unwritten: null,
      queue: Promise.resolve()
    }
    this.cards.set(messageId, card)
    this.byRequest.set(record.requestId, messageId)
    if (state === 'buttons') this.mint(card, composed, binding)
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
    const { action, binding } = entry
    if (action.type === 'permission') {
      const label = action.decision === 'allow' ? 'Allow once' : 'Deny'
      card.state = 'sending'
      await connector.answerCallbackQuery(tap.callbackId, `Sending ${label}…`).catch(() => undefined)
      await this.enqueue(card, () => this.showSending(card, [label]))
      void this.deliver(card, { type: 'permission', decision: action.decision }, [label], binding)
      return
    }
    const record = await this.deps.getAttention(card.requestId).catch(() => null)
    const prompt = record?.prompt
    if (!record || record.revision !== binding.revision || prompt?.type !== 'questions' || action.step !== card.progress.step) {
      await connector.answerCallbackQuery(tap.callbackId, 'This button is no longer active.').catch(() => undefined)
      await this.enqueue(card, () => this.refreshCard(card))
      return
    }
    const progress = card.progress
    const question = prompt.questions[progress.step]!
    let callback: string
    switch (action.type) {
      case 'choice':
        progress.choices = [...progress.choices, action.index]
        await this.advance(card, record, prompt, binding, tap.callbackId)
        return
      case 'submit':
        progress.choices = [...progress.choices, { set: [...progress.toggled].sort((a, b) => a - b) }]
        await this.advance(card, record, prompt, binding, tap.callbackId)
        return
      case 'toggle': {
        const on = !progress.toggled.includes(action.index)
        progress.toggled = on ? [...progress.toggled, action.index] : progress.toggled.filter((index) => index !== action.index)
        callback = `${on ? '●' : '○'} ${question.options[action.index]!.label}`
        break
      }
      case 'other':
        progress.typing = true
        callback = 'Reply to the card with your answer.'
        break
      case 'options':
        progress.typing = false
        callback = 'Options'
        break
      case 'back': {
        // The earlier answer comes back as it was chosen: its option marked, its toggles on.
        const earlier = progress.choices[progress.step - 1]!
        progress.step -= 1
        progress.choices = progress.choices.slice(0, progress.step)
        progress.marked = typeof earlier === 'number' ? earlier : null
        progress.toggled = typeof earlier === 'object' && 'set' in earlier ? [...earlier.set] : []
        progress.typing = false
        callback = `Question ${progress.step + 1} of ${prompt.questions.length}`
        break
      }
    }
    card.state = 'buttons'
    await connector.answerCallbackQuery(tap.callbackId, callback).catch(() => undefined)
    await this.redraw(card, record, binding)
  }

  /**
   * A reply to a card. On a card that offers Other… it is the typed answer once Other… was tapped, and refused
   * before; nothing else becomes of it (never a draft or a prompt). Any other reply is not the keeper's: false.
   */
  async typedReply(reply: InboundReply): Promise<boolean> {
    const connector = this.deps.connector()
    const card = reply.replyToMessageId === null ? undefined : this.cards.get(reply.replyToMessageId)
    if (!connector || this.disposed || !card || card.state !== 'buttons' || !card.offersOther) return false
    const answer = (text: string): Promise<unknown> =>
      connector.sendMessage(text, { replyToMessageId: reply.messageId }).catch(() => undefined)
    if (!card.progress.typing) {
      await answer('Tap Other… first, then reply with your answer.')
      return true
    }
    const typed = cleanTypedAnswer(reply.text ?? '')
    if (typed === '') {
      await answer('Reply with your answer as text.')
      return true
    }
    const binding: Binding = { revision: card.revision, epoch: card.epoch, incarnationId: card.incarnationId }
    const record = await this.deps.getAttention(card.requestId).catch(() => null)
    const prompt = record?.prompt
    if (!record || record.state !== 'open' || record.revision !== binding.revision || prompt?.type !== 'questions') {
      await answer(record?.state === 'open' ? REFUSAL_WORDS.changed : REFUSAL_WORDS.gone)
      await this.enqueue(card, () => this.refreshCard(card))
      return true
    }
    this.revoke(card)
    const progress = card.progress
    const question = prompt.questions[progress.step]!
    progress.choices = [...progress.choices, question.multiSelect
      ? { set: [...progress.toggled].sort((a, b) => a - b), typed }
      : { typed }]
    await this.advance(card, record, prompt, binding, null)
    return true
  }

  /** The question at `step` is answered: on to the next one on the card, or, after the last, send them all. */
  private async advance(
    card: LiveCard,
    record: AttentionRecord,
    prompt: AttentionQuestionsPrompt,
    binding: Binding,
    callbackId: string | null
  ): Promise<void> {
    const connector = this.deps.connector()
    const progress = card.progress
    const callback = (text: string): Promise<unknown> =>
      callbackId === null || !connector ? Promise.resolve() : connector.answerCallbackQuery(callbackId, text).catch(() => undefined)
    if (progress.step + 1 < prompt.questions.length) {
      progress.step += 1
      progress.toggled = []
      progress.marked = null
      progress.typing = false
      card.state = 'buttons'
      await callback(`Question ${progress.step + 1} of ${prompt.questions.length}`)
      await this.redraw(card, record, binding)
      return
    }
    const answer: RemoteAnswer = { type: 'choices', choices: progress.choices }
    const labels = progress.choices.map((choice, index) => shownChoice(prompt.questions[index]!, choice))
    card.state = 'sending'
    await callback(`Sending ${labels.join(' · ')}…`)
    await this.enqueue(card, () => this.showSending(card, labels))
    void this.deliver(card, answer, labels, binding)
  }

  private async redraw(card: LiveCard, record: AttentionRecord, binding: Binding): Promise<void> {
    await this.enqueue(card, async () => {
      const composed = await this.compose(record, card.progress, null, binding.epoch)
      await this.show(card, composed, binding)
    })
  }

  /**
   * A report that came after the card already said the answer was not confirmed: a confirmation, or OpenCode
   * refusing the reply (nothing applied, so fresh buttons while the request is open). Queued behind the card's
   * own settlement, which may still be on its way.
   */
  lateOutcome(requestId: string, outcome: AnswerOutcome): void {
    const card = this.cardFor(requestId)
    if (!card || (outcome.state !== 'confirmed' && outcome.state !== 'refused')) return
    void this.enqueue(card, async () => {
      if (!card.upgradable) return
      card.upgradable = false
      // The unconfirmed ending still waiting to be written must not overwrite what is true now.
      if (card.unwritten?.timer) clearTimeout(card.unwritten.timer)
      card.unwritten = null
      if (outcome.state === 'confirmed') await this.finish(card, { type: 'outcome', outcome, permission: card.permission })
      else await this.settle(card, outcome)
    })
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
    let unfinished = false
    for (const row of stale) {
      if (this.cards.has(row.messageId)) continue
      const ending: CardEnding = row.state === 'sending' ? { type: 'restarted-sending' } : { type: 'restarted' }
      const text = endedCard(row.card.base, ending)
      try {
        await connector.editMessageText(row.messageId, row.card.format === 'plain' ? plainText(text) : text,
          { html: row.card.format === 'html', keyboard: null })
      } catch (error) {
        // A card Telegram will never let BMN edit is finished here; any other failure is tried again later.
        if (!isPermanentEditFailure(error)) {
          unfinished = true
          continue
        }
      }
      await this.deps.store.update(row.messageId, row.revision, 'final', row.card).catch(() => undefined)
    }
    // The next connection, or the next start, tries the rest again.
    if (unfinished) this.swept = false
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
    for (const card of this.cards.values()) if (card.unwritten?.timer) clearTimeout(card.unwritten.timer)
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

  private mint(card: LiveCard, composed: Composed, binding: Binding): void {
    this.revoke(card)
    const keyboard = composed.rendered.keyboard
    if (!keyboard) return
    const buttons = keyboard.flat()
    buttons.forEach((button, index) => {
      this.tokens.set(button.callback_data, { messageId: card.messageId, action: composed.actions[index]!, binding })
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
    progress: Readonly<Progress>,
    note: string | null,
    epoch: number | null
  ): Promise<Composed> {
    const header = this.deps.header(record.sessionId, record)
    const prompt = record.prompt
    const none: Omit<Composed, 'rendered'> = { state: 'open', actions: [], offersOther: false }
    if (!prompt) {
      return { ...none, rendered: record.kind === 'notice' ? noticeCard(header, record) : requestCard(header, record) }
    }
    const answerability = await this.deps.answerability(record)
    const bound = (epoch ?? this.deps.answerEpoch(record.requestId)) !== null &&
      (record.incarnationId ?? this.deps.liveIncarnationId(record.sessionId)) !== undefined
    const answerable = answerability.answerable && bound
    if (prompt.type === 'permission') {
      // A command the card must clip is answered at the laptop, never approved unseen.
      if (!answerable || !commandShownWhole(prompt)) {
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
        offersOther: false,
        rendered: permissionCard({ header, prompt, tokens, closedBecause: null, home: this.deps.home, note })
      }
    }
    if (!answerable) {
      return { ...none, rendered: questionCard({ header, prompt, step: 0, chosen: [], tokens: null, note }) }
    }
    const step = progress.step
    const question = prompt.questions[step]!
    const chosen = progress.choices.map((choice, index) => shownChoice(prompt.questions[index]!, choice))
    const other = typedAnswerable(prompt, question)
    if (progress.typing && other) {
      const options = this.newToken()
      return {
        state: 'buttons',
        actions: [{ type: 'options', step }],
        offersOther: true,
        rendered: questionCard({ header, prompt, step, chosen, tokens: [], note, typing: options })
      }
    }
    const tokens = question.options.map(() => this.newToken())
    const multi = question.multiSelect
    const actions: TapAction[] = question.options.map((_, index) => ({ type: multi ? 'toggle' : 'choice', step, index }))
    // Tokens are minted in keyboard order: options, Other…, then the control row's ‹ Back and Send or Next.
    const otherToken = other ? this.newToken() : null
    if (otherToken) actions.push({ type: 'other', step })
    const back = step > 0 ? this.newToken() : null
    if (back) actions.push({ type: 'back', step })
    const submit = multi && progress.toggled.length > 0 ? this.newToken() : null
    if (submit) actions.push({ type: 'submit', step })
    return {
      state: 'buttons',
      actions,
      offersOther: other,
      rendered: questionCard({
        header, prompt, step, chosen, tokens, note,
        other: otherToken,
        back,
        toggled: multi ? progress.toggled : null,
        submit,
        marked: multi ? null : progress.marked
      })
    }
  }

  /** Writes a composed card onto its message, falling back once to plain words if Telegram refuses the HTML. */
  /**
   * Redraws the card for `binding`. The old buttons die before anything is sent, and the card takes the new
   * binding only once Telegram shows it, so no tap ever answers a revision its buttons were not drawn for.
   */
  private async show(card: LiveCard, composed: Composed, binding: Binding): Promise<void> {
    this.revoke(card)
    const connector = this.deps.connector()
    if (!connector) return
    const drawn = (): void => {
      card.revision = binding.revision
      card.epoch = binding.epoch
      card.base = composed.rendered.base
    }
    if (card.format === 'html') {
      try {
        await connector.editMessageText(card.messageId, composed.rendered.text, { html: true, keyboard: composed.rendered.keyboard })
        drawn()
        card.state = composed.state
        card.offersOther = composed.offersOther
        if (composed.state === 'buttons') this.mint(card, composed, binding)
        await this.save(card)
        return
      } catch (error) {
        if (!isFormattingRefusal(error)) throw error
        card.format = 'plain'
      }
    }
    card.state = 'open'
    card.offersOther = false
    await connector.editMessageText(card.messageId,
      `${plainText(composed.rendered.text)}${composed.state === 'buttons' ? '\n\nAnswer at the laptop.' : ''}`)
    drawn()
    await this.save(card)
  }

  private async showSending(card: LiveCard, labels: string[]): Promise<void> {
    await this.writeEnding(card, { type: 'sending', labels })
    await this.save(card)
  }

  /**
   * Ends the card. It is stored as final only once Telegram shows the ending; until then the stored card keeps
   * its buttons or Sending state, the edit is retried, and a restart's sweep still finds it.
   */
  private async finish(card: LiveCard, ending: CardEnding, attempt = 0): Promise<void> {
    this.revoke(card)
    card.state = 'final'
    if (card.unwritten?.timer) clearTimeout(card.unwritten.timer)
    card.unwritten = null
    if (await this.writeEnding(card, ending)) {
      await this.save(card)
      return
    }
    const delays = this.deps.retryMs ?? DEFAULT_RETRY_MS
    const delay = delays[attempt]
    const unwritten: NonNullable<LiveCard['unwritten']> = { ending, timer: null }
    card.unwritten = unwritten
    if (delay === undefined || this.disposed) return
    unwritten.timer = setTimeout(() => {
      unwritten.timer = null
      void this.enqueue(card, async () => {
        // A newer ending has taken over, or this one was written meanwhile.
        if (card.unwritten !== unwritten) return
        await this.finish(card, ending, attempt + 1)
      })
    }, delay)
    unwritten.timer.unref?.()
  }

  /** Whether Telegram now shows the ending, or never will; false when it may take it later. */
  private async writeEnding(card: LiveCard, ending: CardEnding): Promise<boolean> {
    const connector = this.deps.connector()
    if (!connector) return false
    const text = endedCard(card.base, ending)
    const keyboard: InlineKeyboard | null = null
    try {
      await connector.editMessageText(card.messageId, card.format === 'plain' ? plainText(text) : text,
        { html: card.format === 'html', keyboard })
      return true
    } catch (error) {
      return isPermanentEditFailure(error)
    }
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
    // The old buttons die now, before the new card is composed or sent.
    this.revoke(card)
    card.progress = { ...START }
    const binding = this.bindingFor(card, record)
    await this.show(card, await this.compose(record, START, null, binding.epoch), binding)
  }

  private bindingFor(card: LiveCard, record: AttentionRecord): Binding {
    return { revision: record.revision, epoch: this.deps.answerEpoch(record.requestId), incarnationId: card.incarnationId }
  }

  /** Runs detached from the poll loop: 30.2 may take seconds to confirm. */
  private async deliver(card: LiveCard, answer: RemoteAnswer, labels: string[], binding: Binding): Promise<void> {
    const outcome = await this.deps.answer({
      requestId: card.requestId,
      revision: binding.revision,
      epoch: binding.epoch ?? -1,
      incarnationId: binding.incarnationId ?? '',
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
        card.progress = { ...START }
        card.state = 'open'
        const binding = this.bindingFor(card, record)
        await this.show(card, await this.compose(record, START, REFUSAL_WORDS[outcome.reason], binding.epoch), binding)
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
