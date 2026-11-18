// MODULE: telegram-departure-head.ts - one durable Telegram head for the same departure list and revision-bound Go/cancel/repeat actions
import { randomBytes } from 'node:crypto'
import { awayMomentWords, departureCounts, departureSessionState, grantAnswerWords, grantChoice, type DepartureCollection, type OwnerDepartureInput, type OwnerDepartureReply, type OwnerGrantView } from '@bmn/protocol'
import { escapeHtml, said, type InlineKeyboard } from './telegram-cards'
import { TelegramConnectorError, type InboundTap, type TelegramConnector } from './telegram-connector'

type Connector = Pick<TelegramConnector, 'sendMessage' | 'editMessageText' | 'answerCallbackQuery'>
export const DEPARTURE_TOKEN_PREFIX = 'g:d:'
const headField = (text: string, limit = 70): string => {
  const points = [...said(text)]
  while (escapeHtml(points.join('')).length > limit) points.pop()
  return escapeHtml(points.join(''))
}
export function departureHeadText(view: OwnerGrantView, now: Date): string {
  const period = view.period
  if (period?.collection === undefined) return ''
  const counts = departureCounts(period, now)
  const stamp = awayMomentWords(period.awayAt ?? period.startedAt, now)
  const head = period.state === 'leaving' ? `Before you go · getting ready since ${stamp}`
    : period.state === 'away' ? `Away ${period.collection.autoStartedAt ? 'started by itself at' : 'since'} ${stamp}` : 'Not leaving. Open lines withdrawn.'
  const lineWords = (count: number): string => `${count} ${count === 1 ? 'line' : 'lines'}`
  const rows = period.collection.sessions.map(session => {
    const row = departureSessionState(period, session, now)
    const state = row.state === 'nothing' ? 'needs nothing' : row.state === 'list' ? lineWords(row.runs.reduce((sum, run) => sum + run.card.terms.length, 0))
      : row.state === 'no-answer' ? 'no answer' : row.state === 'not-told' ? 'not told' : row.state === 'not-selected' ? 'not asked' : 'asking'
    const prior = row.runs.filter(run => run.card.nothing && run.answer !== null && (period.state === 'leaving' || period.state === 'away'))
      .flatMap(run => grantAnswerWords(run.answer!.terms, run.answer!.choices).granted)
    const detail = [prior.length > 0 ? `Earlier answer still holds: ${prior.join(' · ')}` : null, row.reason].filter(Boolean).join(' · ')
    return `${headField(session.name)}: ${state}${detail ? ` · ${headField(detail)}` : ''}`
  })
  const history = view.notAskedAgain.map(run => `${headField(run.title, 35)}: ${headField(run.granted.join(' · '), 60)} granted ${awayMomentWords(run.at, now)}; has not asked again; nothing granted.`)
  const shown = [...rows, ...history]
  const same = view.offers.reduce((sum, offer) => sum + Object.keys(offer.choices).filter(id => {
    const run = period.runs.find(other => other.runId === offer.runId)
    return run?.answer?.cardRevision !== run?.card.revision || grantChoice(run?.answer?.choices, id) === undefined
  }).length, 0)
  return [head, `Asked ${counts.asked} ${counts.asked === 1 ? 'session' : 'sessions'}. ${counts.asking} still answering. ${lineWords(counts.lines)} to answer.`, '', ...shown.slice(0, 20),
    ...(shown.length > 20 ? [`${shown.length - 20} more on the laptop.`] : []),
    ...(same > 0 && period.state === 'leaving' ? ['', `${same} lines are the same as you granted earlier. Nothing is granted before your tap.`] : []),
    '', period.state === 'leaving' ? `Away starts on Go, or by itself at ${awayMomentWords(period.collection.autoAwayAt, now)}. A line you leave unanswered grants nothing.`
      : period.state === 'away' ? 'Send /back when you return.' : 'Nothing more is granted.'].join('\n')
}

const definiteRejection = (error: unknown): boolean => error instanceof TelegramConnectorError && error.status !== null && error.status >= 400 && error.status < 500

export class TelegramDepartureHead {
  private chain = Promise.resolve()
  private stopped = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly tokens = new Map<string, { periodId: string; revision: number; generation?: number; action: 'go' | 'cancel' | 'same'; messageId: number }>()
  private readonly signatures = new Map<string, string>()
  constructor(private readonly deps: {
    connector(): Connector | undefined
    view(): OwnerGrantView
    now(): Date
    action(input: OwnerDepartureInput): Promise<OwnerDepartureReply>
    keep(periodId: string, phone: DepartureCollection['phone']): Promise<void>
  }) {}
  reconcile(): Promise<void> {
    const next = this.chain.then(() => this.reconcileNow()).catch(() => undefined)
    this.chain = next
    return next
  }
  dispose(): void { this.stopped = true; this.tokens.clear(); if (this.retryTimer !== null) clearTimeout(this.retryTimer); this.retryTimer = null }
  private retryRejected(): void {
    if (this.stopped || this.retryTimer !== null) return
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.reconcile() }, 5_000)
    this.retryTimer.unref?.()
  }
  owns(messageId: number): boolean { return this.deps.view().period?.collection?.phone.messageId === messageId }
  async tap(tap: InboundTap): Promise<void> {
    const connector = this.deps.connector()
    if (!connector || this.stopped) return
    const entry = this.tokens.get(tap.data)
    if (entry === undefined || entry.messageId !== tap.messageId) {
      await connector.answerCallbackQuery(tap.callbackId, 'This button is no longer active.').catch(() => undefined)
      return
    }
    const reply = await this.deps.action({ action: entry.action, periodId: entry.periodId, expectedRevision: entry.revision, ...(entry.generation === undefined ? {} : { expectedGeneration: entry.generation }), operationKey: `telegram:${tap.callbackId}` })
    await connector.answerCallbackQuery(tap.callbackId, reply.detail ?? (reply.outcome === 'changed' ? entry.action === 'go' ? 'Away.' : entry.action === 'cancel' ? 'Not leaving.' : 'The same lines granted.' : 'Already recorded.')).catch(() => undefined)
    await this.reconcile()
  }
  private async reconcileNow(): Promise<void> {
    if (this.stopped || this.retryTimer !== null) return
    let view = this.deps.view()
    const period = view.period
    if (period?.collection === undefined || !period.collection.sessions.some(session => session.selected)) return
    let phone = period.collection.phone
    const connector = this.deps.connector()
    if (!connector) {
      if (phone.messageId === null && phone.state !== 'unreachable') await this.deps.keep(period.periodId, { ...phone, state: 'unreachable' })
      return
    }
    if (phone.messageId === null) {
      if (period.state !== 'leaving' && period.state !== 'away' || phone.state === 'uncertain') return
      // A crash or uncertain send never creates a second head message.
      await this.deps.keep(period.periodId, { ...phone, state: 'uncertain' })
      let sent: { messageId: number }
      try { sent = await connector.sendMessage(departureHeadText(this.deps.view(), this.deps.now()), { html: true }) }
      catch (error) {
        if (definiteRejection(error)) {
          this.retryRejected()
          await this.deps.keep(period.periodId, { ...phone, state: 'unreachable' })
        }
        return
      }
      phone = { ...phone, state: 'sent', messageId: sent.messageId }
      await this.deps.keep(period.periodId, phone)
      view = this.deps.view()
    }
    const current = view.period
    if (current?.periodId !== period.periodId || current.collection === undefined || phone.messageId === null) return
    const counts = departureCounts(current, this.deps.now())
    const text = departureHeadText(view, this.deps.now())
    const signature = `${view.revision}:${text}`
    if (this.signatures.get(period.periodId) !== signature) {
      const keyboard: InlineKeyboard = []
      if (current.state === 'leaving') {
        const button = (label: string, action: 'go' | 'cancel' | 'same') => {
          const token = `${DEPARTURE_TOKEN_PREFIX}${randomBytes(12).toString('base64url')}`
          this.tokens.set(token, { periodId: period.periodId, revision: view.revision, ...(view.generation == null ? {} : { generation: view.generation }), action, messageId: phone.messageId! })
          return { text: label, callback_data: token }
        }
        keyboard.push([button(counts.asking > 0 ? 'Go now' : 'Go', 'go'), button('Not leaving', 'cancel')])
        const same = view.offers.reduce((sum, offer) => sum + Object.keys(offer.choices).filter(id => {
          const run = current.runs.find(other => other.runId === offer.runId)
          return run?.answer?.cardRevision !== run?.card.revision || grantChoice(run?.answer?.choices, id) === undefined
        }).length, 0)
        if (same > 0) keyboard.push([button(`Grant the same ${same}`, 'same')])
      }
      while (this.tokens.size > 500) this.tokens.delete(this.tokens.keys().next().value!)
      await connector.editMessageText(phone.messageId, text, { html: true, keyboard: keyboard.length ? keyboard : null })
      this.signatures.set(period.periodId, signature)
    }
    if (current.collection.autoStartedAt !== null && !phone.autoAnnounced) {
      await this.deps.keep(period.periodId, { ...phone, autoAnnounced: true })
      try { await connector.sendMessage(`Away started by itself at ${awayMomentWords(current.collection.autoStartedAt, this.deps.now())}. ${counts.lines} lines still open.`) }
      catch (error) {
        if (definiteRejection(error)) {
          this.retryRejected()
          await this.deps.keep(period.periodId, { ...phone, autoAnnounced: false })
        }
      }
    }
  }
}
