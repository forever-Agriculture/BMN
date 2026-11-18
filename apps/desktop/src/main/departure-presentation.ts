// MODULE: departure-presentation.ts - one automatic presenter and sender-bound receipts for actual modal shows
import { randomUUID } from 'node:crypto'
import { compareGrantOrder, type DeparturePresentationInput, type DeparturePresentationReply, type OwnerDepartureReply, type OwnerGrantView } from '@bmn/protocol'

type Ticket = { sender: number; token: string }
type Receipt = { operationKey: string; retryAt: number; retryDelayMs: number; timer?: ReturnType<typeof setTimeout> }
type PeriodPresentation = {
  generation: number
  automatic: Ticket | null
  manual: Map<number, Ticket>
  shown: boolean
  receipt?: Receipt
}
const RECEIPT_RETRY_MS = 2_000

export class DeparturePresentation {
  private readonly periods = new Map<string, PeriodPresentation>()
  private current: string | null = null
  private order = { generation: 0, revision: -1 }

  constructor(private readonly deps: {
    view(): Promise<OwnerGrantView>
    focused(sender: number): boolean
    available?(sender: number): boolean
    released?(): void
    save(periodId: string, operationKey: string, generation: number): Promise<OwnerDepartureReply>
  }) {}

  private prune(periodId: string, presentation: PeriodPresentation): void {
    if (periodId !== this.current && presentation.automatic === null && presentation.manual.size === 0 && presentation.receipt === undefined) this.periods.delete(periodId)
  }

  private clearReceipt(periodId: string, presentation: PeriodPresentation): void {
    clearTimeout(presentation.receipt?.timer)
    delete presentation.receipt
    this.prune(periodId, presentation)
  }

  observe(view: OwnerGrantView): boolean {
    if (view.read !== 'read' || compareGrantOrder(view, this.order) < 0) return false
    const generation = view.generation ?? 0
    if (generation !== this.order.generation) {
      for (const presentation of this.periods.values()) clearTimeout(presentation.receipt?.timer)
      this.periods.clear()
    }
    this.order = { generation, revision: view.revision }
    const period = view.period
    this.current = period?.state === 'leaving' ? period.periodId : null
    for (const [periodId, presentation] of this.periods) {
      if (period?.periodId === periodId && period.collection?.presentedAt != null) this.clearReceipt(periodId, presentation)
      else if (presentation.receipt !== undefined && Date.now() >= presentation.receipt.retryAt) void this.save(periodId, presentation)
      else this.prune(periodId, presentation)
    }
    return true
  }

  private async save(periodId: string, presentation: PeriodPresentation): Promise<OwnerDepartureReply | null> {
    const receipt = presentation.receipt
    if (receipt === undefined || this.periods.get(periodId) !== presentation) return null
    receipt.retryAt = Infinity
    clearTimeout(receipt.timer)
    try {
      const reply = await this.deps.save(periodId, receipt.operationKey, presentation.generation)
      if (reply.outcome !== 'unknown') {
        this.observe(reply.view)
        const canRetry = reply.outcome === 'stale' && (reply.view.generation ?? 0) === presentation.generation &&
          reply.view.period?.periodId === periodId && reply.view.period.state === 'leaving' && reply.view.period.collection?.presentedAt == null
        if (!canRetry) {
          if (this.periods.get(periodId) === presentation) this.clearReceipt(periodId, presentation)
          return reply
        }
      }
    } catch {
      const view = await this.deps.view().catch(() => null)
      if (view !== null) this.observe(view)
    }
    if (this.periods.get(periodId) === presentation && presentation.receipt === receipt) {
      const delay = receipt.retryDelayMs
      receipt.retryAt = Date.now() + delay
      receipt.retryDelayMs = Math.min(delay * 2, 30_000)
      receipt.timer = setTimeout(() => { void this.save(periodId, presentation) }, delay)
      receipt.timer.unref?.()
    }
    return null
  }

  close(sender: number): void {
    let released = false
    for (const [periodId, presentation] of this.periods) {
      presentation.manual.delete(sender)
      if (presentation.automatic?.sender === sender) {
        presentation.automatic = null
        released ||= periodId === this.current && !presentation.shown
      }
      this.prune(periodId, presentation)
    }
    if (released) this.deps.released?.()
  }

  async act(sender: number, input: DeparturePresentationInput): Promise<DeparturePresentationReply> {
    const empty = { token: null, reply: null }
    if (!('token' in input)) {
      const view = await this.deps.view()
      if (!this.observe(view) || (input.expectedGeneration ?? 0) !== this.order.generation) return empty
      const period = view.period
      if (period?.periodId !== input.periodId || period.state !== 'leaving' || this.deps.available?.(sender) === false) return empty
      if (period.collection?.presentedAt != null) return empty
      const presentation = this.periods.get(input.periodId) ?? {
        generation: this.order.generation, automatic: null, manual: new Map<number, Ticket>(), shown: false
      }
      if (input.action === 'reserve' && (!this.deps.focused(sender) || presentation.shown || presentation.automatic !== null)) return empty
      if (input.action === 'manual' && presentation.manual.has(sender)) return empty

      const ticket = { sender, token: randomUUID() }
      this.periods.set(input.periodId, presentation)
      if (input.action === 'manual') presentation.manual.set(sender, ticket)
      else presentation.automatic = ticket
      return { token: ticket.token, reply: null }
    }

    const presentation = this.periods.get(input.periodId)
    if (presentation === undefined) return empty
    const automatic = presentation.automatic?.sender === sender && presentation.automatic.token === input.token
    const manual = presentation.manual.get(sender)
    if (!automatic && (manual === undefined || manual.token !== input.token)) return empty

    if (automatic) presentation.automatic = null
    else presentation.manual.delete(sender)
    if (input.action === 'decline') {
      this.prune(input.periodId, presentation)
      if (automatic && this.current === input.periodId && !presentation.shown) this.deps.released?.()
      return empty
    }

    if (presentation.shown) return empty
    // The real show owns one receipt, including when its save has an ambiguous result.
    presentation.shown = true
    presentation.receipt = { operationKey: 'desktop-presented:' + input.token, retryAt: Infinity, retryDelayMs: RECEIPT_RETRY_MS }
    return { token: input.token, reply: await this.save(input.periodId, presentation) }
  }
}
