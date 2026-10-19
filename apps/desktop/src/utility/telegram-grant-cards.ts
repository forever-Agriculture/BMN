// MODULE: telegram-grant-cards.ts - the Away grant's departure cards on Telegram: drawn, walked, answered and ended on one message per run (Story 84.3, the notes 84.2 §1)
import { randomBytes } from 'node:crypto'
import {
  awayMomentWords,
  GRANT_RULE_LINE,
  grantAnswerWords,
  grantButtonWords,
  grantCardHasRuleLine,
  grantChoiceLabel,
  grantNoChoices,
  grantProposedChoices,
  grantTermChoices,
  grantTermLabel,
  quietHoursAllow,
  telegramQuietWindow,
  type GrantAnswerResult,
  type GrantChoice,
  type GrantPeriod,
  type GrantRead,
  type GrantRun,
  type GrantTerm,
  type TelegramQuietHours
} from '@bmn/protocol'
import { clip, escapeHtml, headerLine, said, TELEGRAM_TEXT_LIMIT, type CardHeader, type InlineKeyboard } from './telegram-cards'
import type { InboundTap, TelegramConnector } from './telegram-connector'

/** Departure-card buttons start with this, so a tap reaches this keeper and never the request cards' one. */
export const GRANT_TOKEN_PREFIX = 'g:'
/** A card asked within this long after Away is set goes at once, quiet hours or not (owner card, the notes' question 1). */
export const GRANT_SEND_AFTER_AWAY_MS = 30 * 60_000
const BUTTON_CHARS = 28
const ONE_ROW_CHARS = 30
const STALE_TOKENS = 500
const REASON_CUT = 80
export const GRANT_TYPED_REPLY = 'Answer this card with its buttons.'

type View = { step: null } | { step: number; picks: Record<string, GrantChoice> }
type Action =
  | { type: 'grant'; choices: Record<string, GrantChoice> }
  | { type: 'choose' }
  | { type: 'pick'; step: number; choice: GrantChoice }
  | { type: 'back'; step: number }

interface Drawn {
  periodId: string
  runId: string
  messageId: number
  /** The card revision this message draws. */
  revision: number
  view: View
  tokens: string[]
  /** The warning line on top: the card changed, or BMN could not save. */
  note: string | null
  /** The ending last written, so each is written once. */
  ended: string | null
}

type Connector = Pick<TelegramConnector, 'sendMessage' | 'editMessageText' | 'answerCallbackQuery'>

export interface GrantCardDependencies {
  /** The connector while Telegram is polling, else undefined. */
  connector(): Connector | undefined
  /** The grant record as BMN last saved it. */
  read(): GrantRead
  header(run: GrantRun): CardHeader
  /** false: he is at the desk (said or measured); a leaving card waits there, in the window. */
  ownerAway(): boolean | null
  quiet(): TelegramQuietHours
  now(): Date
  answer(answer: { periodId: string; runId: string; cardRevision: number; choices: Record<string, GrantChoice>; via: 'telegram'; operationKey: string }): Promise<GrantAnswerResult>
  /** Keeps the message with the run, so a restart redraws the same message. */
  keep(periodId: string, runId: string, phone: { messageId: number; cardRevision: number }): Promise<unknown>
  token?: () => string
}

const key = (periodId: string, runId: string): string => `${periodId}\u0000${runId}`
const isOpenPeriod = (period: GrantPeriod): boolean => period.state === 'leaving' || period.state === 'away'
const isNo = (choice: GrantChoice | undefined): boolean => choice === undefined || choice === 0 || choice === 'no'

/** Agent text on its way to the phone: cleaned, masked, clipped and escaped. */
const words = (text: string, max: number): string => escapeHtml(clip(said(text), max))

/** "Extra repair rounds per boundary: 3", the term at its proposal, for the overview. */
function overviewLine(term: GrantTerm, index: number): string {
  return `${index + 1}. ${escapeHtml(grantTermLabel(term))}: ${escapeHtml(grantChoiceLabel(term, term.proposed))}`
}

/**
 * One run's card as the phone shows it (the notes §1 On Telegram). Reasons are cut first, then the scope, so the term
 * lines, the rule line and the buttons always fit.
 */
export function grantCardText(input: {
  header: CardHeader; run: GrantRun; view: View; note: string | null; now: Date; ending?: string
}): string {
  const { run, view, now } = input
  const card = run.card
  const terms = card.terms
  const draw = (reasonChars: number | null, scopeChars: number): string => {
    const lines: string[] = []
    if (input.note !== null && input.ending === undefined) lines.push(escapeHtml(input.note), '')
    lines.push(headerLine('❓', input.header))
    const chip = view.step === null || input.ending !== undefined ? `asked ${awayMomentWords(card.askedAt, now)}` : `${view.step + 1} of ${terms.length}`
    lines.push(`<i>Before you go · ${chip}</i>`, '', `<b>${words(run.title, 120)}</b>`)
    if (scopeChars > 0) lines.push(`Scope: ${words(card.scope, scopeChars)}`)
    if (view.step !== null && input.ending === undefined) {
      const step = view.step
      for (const [index, term] of terms.slice(0, step).entries()) {
        lines.push(`${index + 1}. ${escapeHtml(grantTermLabel(term))}: ${escapeHtml(grantChoiceLabel(term, view.picks[term.id] ?? term.proposed))}`)
      }
      const term = terms[step]!
      lines.push('', `<b>${step + 1}. ${escapeHtml(grantTermLabel(term))}</b>`)
      if (reasonChars !== null) lines.push(words(term.reason, reasonChars))
      if (term.kind === 'merge' || term.kind === 'push-default') lines.push(`<i>${GRANT_RULE_LINE}</i>`)
      if (step === terms.length - 1) lines.push('', '<i>Nothing is granted until this answer.</i>')
    } else {
      for (const [index, term] of terms.entries()) {
        lines.push('', overviewLine(term, index))
        if (reasonChars !== null) lines.push(words(term.reason, reasonChars))
      }
      if (grantCardHasRuleLine(terms)) lines.push('', `<i>${GRANT_RULE_LINE}</i>`)
      if (input.ending !== undefined) lines.push('', escapeHtml(input.ending))
      else if (terms.length === 1) lines.push('', '<i>One tap answers.</i>')
    }
    return lines.join('\n')
  }
  for (const [reasons, scope] of [[300, 300], [REASON_CUT, 300], [null, 300], [null, 80], [null, 0]] as const) {
    const text = draw(reasons, scope)
    if (text.length <= TELEGRAM_TEXT_LIMIT) return text
  }
  return draw(null, 0)
}

function rows(buttons: Array<{ text: string; callback_data: string }>, oneRow: boolean): InlineKeyboard {
  const total = buttons.reduce((sum, button) => sum + [...button.text].length, 0)
  return oneRow || total <= ONE_ROW_CHARS ? [buttons] : buttons.map((button) => [button])
}

/** What a run's card says once it asks nothing more of him (the notes §1 After answering). */
export function grantEnding(period: GrantPeriod, run: GrantRun, now: Date): string | null {
  const card = run.card
  if (card.state === 'withdrawn') return card.withdrawnFor === 'back' ? 'Withdrawn: you are back.' : 'Withdrawn: you did not leave.'
  if (card.state === 'nothing') return 'The run now needs nothing; nothing to answer.'
  if (card.state !== 'answered' || run.answer === null || run.answer.cardRevision !== card.revision) return null
  const { granted, notGranted } = grantAnswerWords(run.answer.terms, run.answer.choices)
  let line: string
  if (run.answer.via === 'app') line = `Answered at the laptop: granted ${granted.length === 0 ? 'none' : granted.join(' · ')}.`
  else if (granted.length === 0) line = '✓ Granted none.'
  else line = `✓ Granted until you are back: ${granted.join(' · ')}.${notGranted.length === 0 ? '' : ` Not granted: ${notGranted.join(', ')}.`}`
  if (period.state === 'ended' && period.endedAt !== null) line += `\nEnded ${awayMomentWords(period.endedAt, now)}: you are back.`
  return line
}

/**
 * The departure cards on the phone. One message per run, bound to its card revision: a re-ask edits it silently, a tap
 * on a button drawn for an earlier revision grants nothing and says so, and any tap revokes all of a card's buttons.
 * After a restart an open card is redrawn on the same message with fresh buttons, since an answer is checked against
 * the stored card rather than a live dialog. Delivery: held while he is at the desk and only leaving; sent at once when
 * he is away or the card came within 30 minutes of Away; later in the night it follows quiet hours.
 */
export class TelegramGrantCards {
  private readonly drawn = new Map<string, Drawn>()
  private readonly tokens = new Map<string, { at: string; revision: number; action: Action }>()
  private readonly stale = new Map<string, { at: string; revision: number; action: Action }>()
  private chain: Promise<void> = Promise.resolve()
  private wake: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly deps: GrantCardDependencies) {}

  /** Whether a typed reply addresses a departure card. */
  owns(messageId: number): boolean {
    for (const card of this.drawn.values()) if (card.messageId === messageId) return true
    const read = this.deps.read()
    return read.state === 'read' && read.record.periods.some((period) => period.runs.some((run) => run.phone?.messageId === messageId))
  }

  /** Brings every departure card on the phone to the record's truth: sends, re-asks, endings and the restart redraw. */
  reconcile(): Promise<void> {
    return this.serial(() => this.reconcileNow())
  }

  dispose(): void {
    this.disposed = true
    if (this.wake !== null) clearTimeout(this.wake)
    this.wake = null
    this.tokens.clear()
    this.stale.clear()
    this.drawn.clear()
  }

  async tap(tap: InboundTap): Promise<void> {
    await this.serial(() => this.tapNow(tap))
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work, work).catch(() => undefined)
    this.chain = next
    return next
  }

  private newToken(): string {
    return `${GRANT_TOKEN_PREFIX}${this.deps.token?.() ?? randomBytes(16).toString('base64url')}`
  }

  private current(at: string): { period: GrantPeriod; run: GrantRun } | null {
    const read = this.deps.read()
    if (read.state !== 'read') return null
    for (const period of read.record.periods) {
      for (const run of period.runs) if (key(period.periodId, run.runId) === at) return { period, run }
    }
    return null
  }

  private async reconcileNow(): Promise<void> {
    const connector = this.deps.connector()
    const read = this.deps.read()
    if (connector === undefined || this.disposed || read.state !== 'read') return
    const latest = read.record.periods.at(-1)
    for (const period of read.record.periods) {
      for (const run of period.runs) {
        const at = key(period.periodId, run.runId)
        let card = this.drawn.get(at)
        // After a restart the message is known from the record; only the latest period's cards are redrawn.
        if (card === undefined && run.phone !== null && period === latest) {
          card = { periodId: period.periodId, runId: run.runId, messageId: run.phone.messageId, revision: run.phone.cardRevision, view: { step: null }, tokens: [], note: null, ended: null }
          this.drawn.set(at, card)
        }
        if (run.card.state === 'open' && isOpenPeriod(period)) {
          if (card === undefined) {
            if (this.maySend(period, run)) await this.send(connector, period, run)
          } else if (card.revision !== run.card.revision) {
            card.note = this.changedNote(run, false)
            card.revision = run.card.revision
            card.view = { step: null }
            this.retire(card)
            await this.draw(connector, card, run)
            await this.deps.keep(period.periodId, run.runId, { messageId: card.messageId, cardRevision: card.revision }).catch(() => undefined)
          } else if (card.tokens.length === 0) {
            await this.draw(connector, card, run)
          }
        } else if (card !== undefined) {
          await this.end(connector, card, period, run)
        }
      }
    }
  }

  private maySend(period: GrantPeriod, run: GrantRun): boolean {
    if (period.state === 'leaving') return this.deps.ownerAway() !== false
    const awayAt = Date.parse(period.awayAt ?? period.startedAt)
    if (Date.parse(run.card.askedAt) <= awayAt + GRANT_SEND_AFTER_AWAY_MS) return true
    const quiet = this.deps.quiet()
    let window: ReturnType<typeof telegramQuietWindow>
    try { window = telegramQuietWindow(this.deps.now(), quiet) } catch { return true }
    if (!window.active || quietHoursAllow(quiet, 'question', run.card.sessionId ?? '')) return true
    this.wakeAt(window.endsAt)
    return false
  }

  /** Quiet hours held a card: look again when they end. */
  private wakeAt(endsAt: number | null): void {
    if (endsAt === null || this.wake !== null) return
    this.wake = setTimeout(() => {
      this.wake = null
      void this.reconcile()
    }, Math.max(1_000, endsAt - this.deps.now().getTime() + 1_000))
    this.wake.unref?.()
  }

  private changedNote(run: GrantRun, nothingGranted: boolean): string {
    const change = run.card.change === null ? 'the run asked again' : run.card.change
    const holds = run.answer !== null && run.answer.cardRevision !== run.card.revision ? ' Your earlier answer holds until you answer this card.' : ''
    return `⚠ Changed at ${awayMomentWords(run.card.askedAt, this.deps.now())}: ${change}.${nothingGranted ? ' Nothing was granted.' : holds}`
  }

  private compose(card: Drawn, run: GrantRun): { text: string; keyboard: InlineKeyboard } {
    this.retire(card, false)
    const terms = run.card.terms
    const at = key(card.periodId, card.runId)
    const button = (text: string, action: Action): { text: string; callback_data: string } => {
      const token = this.newToken()
      this.tokens.set(token, { at, revision: card.revision, action })
      card.tokens.push(token)
      return { text: clip(text, BUTTON_CHARS), callback_data: token }
    }
    const choices = (term: GrantTerm, marked: GrantChoice, act: (choice: GrantChoice) => Action): InlineKeyboard => {
      const list = grantTermChoices(term).map((choice) => button(`${choice === marked ? '● ' : ''}${grantChoiceLabel(term, choice)}`, act(choice)))
      return term.kind === 'merge' && list.length > 2 ? list.map((one) => [one]) : rows(list, true)
    }
    let keyboard: InlineKeyboard
    if (card.view.step === null && terms.length === 1) {
      const term = terms[0]!
      keyboard = choices(term, term.proposed, (choice) => ({ type: 'grant', choices: { [term.id]: choice } }))
    } else if (card.view.step === null) {
      const proposed = grantProposedChoices(terms)
      keyboard = rows([
        button(grantButtonWords(terms, proposed), { type: 'grant', choices: proposed }),
        button('Choose…', { type: 'choose' }),
        button('Grant none', { type: 'grant', choices: grantNoChoices(terms) })
      ], false)
    } else {
      const step = card.view.step
      const term = terms[step]!
      keyboard = [...choices(term, card.view.picks[term.id] ?? term.proposed, (choice) => ({ type: 'pick', step, choice })), [button('‹ Back', { type: 'back', step })]]
    }
    const text = grantCardText({ header: this.deps.header(run), run, view: card.view, note: card.note, now: this.deps.now() })
    return { text, keyboard }
  }

  private async send(connector: Connector, period: GrantPeriod, run: GrantRun): Promise<void> {
    const card: Drawn = { periodId: period.periodId, runId: run.runId, messageId: 0, revision: run.card.revision, view: { step: null }, tokens: [], note: null, ended: null }
    const { text, keyboard } = this.compose(card, run)
    try {
      const sent = await connector.sendMessage(text, { html: true, keyboard })
      card.messageId = sent.messageId
    } catch {
      this.retire(card, false)
      return
    }
    this.drawn.set(key(period.periodId, run.runId), card)
    await this.deps.keep(period.periodId, run.runId, { messageId: card.messageId, cardRevision: card.revision }).catch(() => undefined)
  }

  private async draw(connector: Connector, card: Drawn, run: GrantRun): Promise<void> {
    const { text, keyboard } = this.compose(card, run)
    await connector.editMessageText(card.messageId, text, { html: true, keyboard }).catch(() => undefined)
  }

  private async end(connector: Connector, card: Drawn, period: GrantPeriod, run: GrantRun): Promise<void> {
    const ending = grantEnding(period, run, this.deps.now())
    if (ending === null || card.ended === ending) return
    this.retire(card, false)
    card.ended = ending
    const text = grantCardText({ header: this.deps.header(run), run, view: { step: null }, note: null, now: this.deps.now(), ending })
    await connector.editMessageText(card.messageId, text, { html: true, keyboard: null }).catch(() => undefined)
  }

  /** Revokes a card's buttons; a re-ask keeps them as stale, so a late tap on one says the card changed. */
  private retire(card: Drawn, keepStale = true): void {
    for (const token of card.tokens) {
      const entry = this.tokens.get(token)
      this.tokens.delete(token)
      if (keepStale && entry !== undefined) this.stale.set(token, { at: entry.at, revision: entry.revision, action: entry.action })
    }
    card.tokens = []
    for (const token of this.stale.keys()) {
      if (this.stale.size <= STALE_TOKENS) break
      this.stale.delete(token)
    }
  }

  private async tapNow(tap: InboundTap): Promise<void> {
    const connector = this.deps.connector()
    if (connector === undefined || this.disposed) return
    const toast = (text: string): Promise<void> => connector.answerCallbackQuery(tap.callbackId, text).catch(() => undefined)
    const entry = this.tokens.get(tap.data)
    const old = entry === undefined ? this.stale.get(tap.data) : undefined
    const card = this.drawn.get(entry?.at ?? old?.at ?? '')
    const found = card === undefined ? null : this.current(key(card.periodId, card.runId))
    if (card === undefined || found === null || card.messageId !== tap.messageId) {
      await toast('This button is no longer active.')
      const shown = [...this.drawn.values()].find((other) => other.messageId === tap.messageId)
      if (shown !== undefined) {
        this.retire(shown, false)
        await this.reconcileNow()
      }
      return
    }
    const { period, run } = found
    this.retire(card, false)
    // A grant or a choice tapped on a card that changed or closed was his answer: BMN refuses it and keeps the refusal
    // for the morning (the notes §4); a tap that only moves through the card is not an answer.
    const tapped = entry ?? old
    const refused = async (): Promise<void> => {
      if (tapped?.action === undefined || (tapped.action.type !== 'grant' && tapped.action.type !== 'pick')) return
      const choices = tapped.action.type === 'grant' ? tapped.action.choices : {}
      await this.deps.answer({ periodId: period.periodId, runId: run.runId, cardRevision: tapped.revision, choices, via: 'telegram', operationKey: `telegram:${tap.callbackId}` }).catch(() => undefined)
    }
    if (!isOpenPeriod(period) || run.card.state !== 'open') {
      await refused()
      await toast('This button is no longer active.')
      await this.end(connector, card, period, run)
      return
    }
    if (entry === undefined || entry.revision !== run.card.revision) {
      await refused()
      await this.changed(connector, card, run, tap)
      return
    }
    const action = entry.action
    const terms = run.card.terms
    if (action.type === 'choose' || action.type === 'back') {
      if (action.type === 'choose') card.view = { step: 0, picks: {} }
      else card.view = action.step === 0 ? { step: null } : { step: action.step - 1, picks: card.view.step === null ? {} : card.view.picks }
      await toast(card.view.step === null ? '' : `${card.view.step + 1} of ${terms.length}`)
      await this.draw(connector, card, run)
      return
    }
    if (action.type === 'pick') {
      const picks = { ...(card.view.step === null ? {} : card.view.picks), [terms[action.step]!.id]: action.choice }
      if (action.step + 1 < terms.length) {
        card.view = { step: action.step + 1, picks }
        await toast(`${action.step + 2} of ${terms.length}`)
        await this.draw(connector, card, run)
        return
      }
      await this.grant(connector, card, period, run, picks, tap, toast)
      return
    }
    await this.grant(connector, card, period, run, action.choices, tap, toast)
  }

  private async grant(connector: Connector, card: Drawn, period: GrantPeriod, run: GrantRun, choices: Record<string, GrantChoice>,
    tap: InboundTap, toast: (text: string) => Promise<void>): Promise<void> {
    let result: GrantAnswerResult | null = null
    try {
      result = await this.deps.answer({ periodId: period.periodId, runId: run.runId, cardRevision: run.card.revision, choices, via: 'telegram', operationKey: `telegram:${tap.callbackId}` })
    } catch { /* said below as could not save */ }
    if (result !== null && (result.outcome === 'granted' || result.outcome === 'repeated')) {
      await toast(run.card.terms.every((term) => isNo(choices[term.id])) ? 'Granted none.' : 'Granted.')
      const now = this.current(key(card.periodId, card.runId))
      if (now !== null) await this.end(connector, card, now.period, now.run)
      return
    }
    const fresh = this.current(key(card.periodId, card.runId))
    if (result !== null && result.outcome === 'refused' && result.reason === 'changed' && fresh !== null) {
      await this.changed(connector, card, fresh.run, tap)
      return
    }
    if (result !== null && result.outcome === 'refused' && result.reason !== 'invalid' && fresh !== null) {
      await toast('This button is no longer active.')
      await this.end(connector, card, fresh.period, fresh.run)
      return
    }
    await toast('Nothing was granted.')
    card.note = '⚠ Nothing was granted: BMN could not save your answer. Try again.'
    card.view = { step: null }
    await this.draw(connector, card, run)
    await connector.sendMessage('Nothing was granted: BMN could not save your answer. Try again.', { replyToMessageId: card.messageId }).catch(() => undefined)
  }

  /** A tap on a card drawn for an earlier revision (the notes §1 Stale or changed): nothing granted, fresh buttons, a reply that sounds. */
  private async changed(connector: Connector, card: Drawn, run: GrantRun, tap: InboundTap): Promise<void> {
    await connector.answerCallbackQuery(tap.callbackId, 'This card changed. Look again.').catch(() => undefined)
    card.note = this.changedNote(run, true)
    card.revision = run.card.revision
    card.view = { step: null }
    await this.draw(connector, card, run)
    await connector.sendMessage('Nothing was granted: the card changed. Look again.', { replyToMessageId: card.messageId }).catch(() => undefined)
  }
}
