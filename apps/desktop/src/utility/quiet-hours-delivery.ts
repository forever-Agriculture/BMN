// Bounded claim/history ledger plus private request-row delivery markers. No request-state or PTY capability.
import { randomUUID } from 'node:crypto'
import { quietHoursAllow, telegramQuietWindow, type AttentionRecord, type TelegramQuietHours } from '@bmn/protocol'
import { LEFT_WITHIN_MS } from './attention-pager'
import { said, TELEGRAM_TEXT_LIMIT } from './telegram-cards'
import { telegramSendDefinitelyUnsent } from './telegram-delivery'

export const QUIET_LEDGER_KEY = 'telegram-quiet-delivery-v1'
export const QUIET_LEDGER_LIMIT = 200
type Phase = 'held' | 'claimed' | 'uncertain'
type Entry = {
  requestId: string; revision: number; kind: AttentionRecord['kind']; heldAt: number
  phase: Phase; claim?: string
} | { sessionId: string; incarnationId: string | null; heldAt: number; phase: 'held'; carried?: boolean }
interface WindowState {
  key: string; beganAt: number; endsAt: number
  carriedSummary?: boolean
  nightOverflowExits?: number
  summary: 'pending' | 'claimed' | 'consumed'
  /** Null until the boundary is observed; false expires only desktop departure eligibility. */
  eligible: boolean | null
  overflowExits: number
}
interface Ledger {
  version: 1
  window: WindowState | null
  summaryHighWater: number
  lastBatchAt?: number
  entries: Entry[]
}
export interface QuietDeliveryStatus {
  active: boolean; until: string; waiting: number; capacityBlocked: boolean
  requests: Record<string, 'held-quiet' | 'uncertain'>
  uncertainRevisions: Record<string, number[]>
  problem?: 'history-unavailable'
}
export type NewDeliveryDecision = { action: 'send'; claim: string | null } | { action: 'consumed' } |
  { action: 'hold'; reason?: 'held-quiet' | 'held-at-desk' | 'quiet-backlog' | 'quiet-capacity' | 'quiet-restarting' }
export interface QuietRequest { record: AttentionRecord; heldAt: number; eligible: boolean }
export interface QuietChanges {
  hold?: { requestId: string; revision: number; heldAt: number }
  claim?: { requestId: string; revision: number }
  unclaim?: { requestId: string; revision: number }
  release?: boolean
  clear?: Array<{ requestId: string; revision: number }>
}
export interface QuietDeliveryDependencies {
  read(): Promise<unknown>
  write(value: unknown, changes?: QuietChanges): Promise<boolean>
  settings(): TelegramQuietHours
  now(): Date
  timeZone?: string
  ownerAway(): boolean | null
  ready(): boolean
  /** Exactly the marked cohort, including closed/seen rows for summary counts. */
  requests(): Promise<QuietRequest[]>
  retire(record: AttentionRecord): void
  current(requestId: string): Promise<AttentionRecord | null>
  mapped(requestId: string, revision: number): Promise<boolean>
  sessionName(sessionId: string): string
  home: string
  sendSummary(text: string): Promise<void>
  page(record: AttentionRecord): Promise<boolean>
  changed(): void
}

/** Mask and normalize before clipping. Handles a home path embedded within a title or label. */
export function phoneField(value: string, home: string, limit = 350): string {
  const masked = said(value)
  const normalized = home && home !== '/' ? masked.split(`${home}/`).join('~/') : masked
  return normalized.replace(/[\r\n]+/g, ' ').slice(0, limit)
}

/** Serialized persistence prevents two overlapping routes claiming the same request. */
export class QuietHoursDelivery {
  private ledger: Ledger | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private flushing: Promise<void> | undefined
  private permits = new Set<string>()

  constructor(private readonly deps: QuietDeliveryDependencies) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(work)
    this.queue = next
    return next
  }

  private async load(): Promise<Ledger> {
    if (this.ledger) return this.ledger
    const raw = await this.deps.read()
    if (raw === undefined || raw === null) {
      this.ledger = { version: 1, window: null, summaryHighWater: 0, entries: [] }
    } else {
      // Corrupt claim history must fail closed, never silently reset into duplicate sends.
      const value = raw as Ledger
      if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > QUIET_LEDGER_LIMIT ||
        Object.keys(value).some(key => !['version', 'window', 'summaryHighWater', 'lastBatchAt', 'entries'].includes(key)) ||
        !Number.isFinite(value.summaryHighWater) || !value.entries.every(entry =>
          Number.isFinite(entry.heldAt) && ('requestId' in entry
            ? Object.keys(entry).every(key => ['requestId', 'revision', 'kind', 'heldAt', 'phase', 'claim'].includes(key)) &&
              typeof entry.requestId === 'string' && entry.requestId.length <= 200 && Number.isSafeInteger(entry.revision) &&
              ['permission', 'question', 'handoff', 'review', 'notice'].includes(entry.kind) &&
              ['held', 'claimed', 'uncertain'].includes(entry.phase) && (entry.claim === undefined || typeof entry.claim === 'string')
            : Object.keys(entry).every(key => ['sessionId', 'incarnationId', 'heldAt', 'phase', 'carried'].includes(key)) &&
              typeof entry.sessionId === 'string' && entry.sessionId.length <= 200 && entry.phase === 'held' &&
              (entry.carried === undefined || typeof entry.carried === 'boolean'))) ||
        (value.window !== null && (!value.window || typeof value.window.key !== 'string' ||
          Object.keys(value.window).some(key => !['key', 'beganAt', 'endsAt', 'carriedSummary', 'nightOverflowExits', 'summary', 'eligible', 'overflowExits'].includes(key)) ||
          !Number.isFinite(value.window.beganAt) || !Number.isFinite(value.window.endsAt) ||
          (value.window.carriedSummary !== undefined && typeof value.window.carriedSummary !== 'boolean') ||
          (value.window.nightOverflowExits !== undefined && (!Number.isSafeInteger(value.window.nightOverflowExits) || value.window.nightOverflowExits < 0)) ||
          !Number.isSafeInteger(value.window.overflowExits) || value.window.overflowExits < 0 ||
          ![null, false, true].includes(value.window.eligible) ||
          !['pending', 'claimed', 'consumed'].includes(value.window.summary)))) throw new Error('Quiet delivery history is unavailable')
      this.ledger = structuredClone(value)
      for (const entry of this.ledger.entries) if ('requestId' in entry && entry.phase === 'claimed') entry.phase = 'uncertain'
      if (this.ledger.window?.summary === 'claimed') {
        this.ledger.window.summary = 'consumed'
        this.ledger.window.overflowExits = 0
        this.ledger.entries = this.ledger.entries.filter(entry => 'requestId' in entry)
      }
    }
    await this.pruneClosedClaims(this.ledger)
    return this.ledger!
  }

  private async pruneClosedClaims(state: Ledger): Promise<void> {
    const keep = await Promise.all(state.entries.map(async entry => {
      if (!('requestId' in entry) || entry.phase === 'held') return true
      // A rejected read is not evidence that the request disappeared.
      try { return (await this.deps.current(entry.requestId))?.state === 'open' }
      catch { return true }
    }))
    if (keep.every(Boolean)) return
    state.entries = state.entries.filter((_entry, index) => keep[index])
    await this.save()
  }

  private async save(changes?: QuietChanges): Promise<boolean> {
    try {
      const written = await this.deps.write(structuredClone(this.ledger!), changes)
      if (!written) this.ledger = undefined
      this.deps.changed()
      return written
    } catch (error) { this.ledger = undefined; throw error }
  }

  private windowNow(): ReturnType<typeof telegramQuietWindow> {
    return telegramQuietWindow(this.deps.now(), this.deps.settings(), this.deps.timeZone)
  }

  private ensureWindow(state: Ledger): void {
    const current = this.windowNow()
    if (!current.active) return
    const prior = state.window
    if (prior?.key === current.key && prior.eligible === null) {
      prior.endsAt = Math.max(prior.endsAt, current.endsAt!)
      return
    }
    // An observed window may become active again after a backward clock change.
    // Re-observe its end for fresh holds, preserving prior eligibility and the summary claim.
    const sameWindow = prior?.key === current.key
    const released = prior?.eligible === true
    const carriedSummary = prior?.summary !== 'consumed' && (released || prior?.carriedSummary === true)
    if (released) for (const entry of state.entries) if ('sessionId' in entry) entry.carried = carriedSummary
    state.window = { key: current.key!, beganAt: prior?.summary === 'pending' ? prior.beganAt : this.deps.now().getTime(), endsAt: current.endsAt!,
      summary: sameWindow ? prior!.summary : current.endsAt! <= state.summaryHighWater ? 'consumed' : 'pending', eligible: null,
      overflowExits: prior?.overflowExits ?? 0, carriedSummary, nightOverflowExits: released ? 0 : prior?.nightOverflowExits ?? 0 }
    if (!sameWindow) delete state.lastBatchAt
  }

  private held(record: AttentionRecord): boolean {
    return this.windowNow().active && !quietHoursAllow(this.deps.settings(), record.kind, record.sessionId)
  }

  private pendingRecord(record: AttentionRecord): boolean {
    return record.state === 'open' && record.seenAt === null &&
      (record.expiresAt === null || Date.parse(record.expiresAt) > this.deps.now().getTime())
  }

  private async recordHold(state: Ledger, record: AttentionRecord): Promise<void> {
    await this.observeBoundary(state)
    this.ensureWindow(state)
    const heldAt = this.deps.now().getTime()
    if (!state.entries.some(entry => 'requestId' in entry && entry.requestId === record.requestId && entry.revision === record.revision) && state.entries.length < QUIET_LEDGER_LIMIT) {
      state.entries.push({ requestId: record.requestId, revision: record.revision, kind: record.kind, heldAt, phase: 'held' })
    }
    await this.save({ hold: { requestId: record.requestId, revision: record.revision, heldAt } })
  }

  /** Called by every pager route, before desktop presence can discard overnight eligibility. */
  hold(record: AttentionRecord): Promise<boolean> {
    return this.serial(async () => {
      if (!this.held(record) || await this.deps.mapped(record.requestId, record.revision)) return false
      const state = await this.load()
      await this.recordHold(state, record)
      return true
    })
  }

  holdExit(sessionId: string, incarnationId: string | null): Promise<boolean> {
    return this.serial(async () => {
      if (!this.windowNow().active || this.deps.settings().allowSessions.includes(sessionId)) return false
      const state = await this.load()
      await this.observeBoundary(state)
      this.ensureWindow(state)
      if (!state.entries.some(entry => 'sessionId' in entry && entry.sessionId === sessionId && entry.incarnationId === incarnationId)) {
        if (state.entries.length < QUIET_LEDGER_LIMIT) state.entries.push({ sessionId, incarnationId, heldAt: this.deps.now().getTime(), phase: 'held' })
        else {
          state.window!.overflowExits += 1
          state.window!.nightOverflowExits = (state.window!.nightOverflowExits ?? 0) + 1
        }
      }
      await this.save()
      return true
    })
  }

  /** Immediately before a new card. Holding or failed persistence cannot consume a pager attempt. */
  before(record: AttentionRecord): Promise<NewDeliveryDecision> {
    return this.serial(async () => {
      const current = await this.deps.current(record.requestId)
      if (!current || !this.pendingRecord(current) || current.revision !== record.revision) return { action: 'consumed' }
      if (await this.deps.mapped(record.requestId, record.revision)) return { action: 'consumed' }
      const marker = (await this.deps.requests()).find(item => item.record.requestId === record.requestId)
      // Even unavailable quiet history must not gate unrelated ordinary paging.
      if (!marker && !this.held(record)) return { action: 'send', claim: null }
      const state = await this.load()
      if (state.entries.length >= QUIET_LEDGER_LIMIT) await this.pruneClosedClaims(state)
      const prior = state.entries.find(entry => 'requestId' in entry && entry.requestId === record.requestId && entry.revision === record.revision)
      if (prior && prior.phase !== 'held') return { action: 'consumed' }
      if (this.held(record)) {
        await this.recordHold(state, record)
        return { action: 'hold', reason: 'held-quiet' }
      }
      if (!this.deps.ready()) return { action: 'hold', reason: 'quiet-restarting' }
      if (this.deps.ownerAway() === false) return { action: 'hold', reason: 'held-at-desk' }
      const allowed = this.windowNow().active && quietHoursAllow(this.deps.settings(), record.kind, record.sessionId)
      if (!allowed && (!marker?.eligible || !this.permits.has(record.requestId))) return { action: 'hold', reason: 'quiet-backlog' }
      if (!prior && state.entries.length >= QUIET_LEDGER_LIMIT) {
        const reusable = state.entries.findIndex(entry => 'requestId' in entry && entry.phase === 'held')
        if (reusable < 0) return { action: 'hold', reason: 'quiet-capacity' }
        state.entries.splice(reusable, 1)
      }
      if (prior) state.entries.splice(state.entries.indexOf(prior), 1)
      const claim = randomUUID()
      state.entries.push({ requestId: record.requestId, revision: record.revision, kind: record.kind,
        heldAt: prior?.heldAt ?? this.deps.now().getTime(), phase: 'claimed', claim })
      if (!await this.save({ claim: { requestId: record.requestId, revision: record.revision } })) return { action: 'consumed' }
      return { action: 'send', claim }
    })
  }

  /** Synchronous last check after persistence awaits, and before a formatting fallback. */
  maySend(record: AttentionRecord, managed = true): boolean {
    return (!managed || this.deps.ready()) && this.deps.ownerAway() !== false && !this.held(record) && this.pendingRecord(record)
  }

  settle(claim: string | null, outcome: 'mapped' | 'unsent' | 'uncertain'): Promise<void> {
    if (!claim) return Promise.resolve()
    return this.serial(async () => {
      const state = await this.load()
      const index = state.entries.findIndex(entry => 'claim' in entry && entry.claim === claim)
      if (index < 0) return
      const entry = state.entries[index]!
      if (outcome === 'mapped') state.entries.splice(index, 1)
      else if ('requestId' in entry) { entry.phase = outcome === 'unsent' ? 'held' : 'uncertain'; delete entry.claim }
      await this.save('requestId' in entry ? outcome === 'unsent' ? { unclaim: entry } : { clear: [entry] } : undefined)
    })
  }

  private async pending(state: Ledger): Promise<{ pending: AttentionRecord[]; closed: number; current: AttentionRecord[] }> {
    const rows = await this.deps.requests()
    const pending: AttentionRecord[] = []
    let closed = 0
    for (const { record } of rows) {
      const entry = state.entries.find(value => 'requestId' in value && value.requestId === record.requestId && value.revision === record.revision)
      if (entry?.phase === 'claimed' || entry?.phase === 'uncertain' || await this.deps.mapped(record.requestId, record.revision)) continue
      if (this.pendingRecord(record)) pending.push(record)
      else closed += 1
    }
    pending.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || a.requestId.localeCompare(b.requestId))
    return { pending, closed, current: rows.map(item => item.record) }
  }

  status(): Promise<QuietDeliveryStatus> {
    return this.serial(async () => {
      const state = await this.load()
      const window = this.windowNow()
      const { pending, current } = await this.pending(state)
      const requests: QuietDeliveryStatus['requests'] = {}
      const uncertainRevisions: Record<string, number[]> = {}
      for (const entry of state.entries) if ('requestId' in entry && entry.phase !== 'held') {
        const revisions = uncertainRevisions[entry.requestId] ?? []
        revisions.push(entry.revision); uncertainRevisions[entry.requestId] = revisions
        const row = current.find(row => row.requestId === entry.requestId) ?? await this.deps.current(entry.requestId)
        if (row?.revision === entry.revision) requests[entry.requestId] = 'uncertain'
      }
      for (const record of pending) if (!requests[record.requestId]) requests[record.requestId] = 'held-quiet'
      return { active: window.active, until: window.end, waiting: pending.length + state.entries.filter(entry => 'sessionId' in entry).length + (state.window?.overflowExits ?? 0),
        capacityBlocked: state.entries.length >= QUIET_LEDGER_LIMIT && !state.entries.some(entry => 'requestId' in entry && entry.phase === 'held'),
        requests, uncertainRevisions }
    }).catch(() => ({ active: false, until: this.deps.settings().end, waiting: 0, capacityBlocked: false,
      requests: {}, uncertainRevisions: {}, problem: 'history-unavailable' as const }))
  }

  /** Existing sweep/recovery/departure routes share a single release operation. */
  flush(nextSweep = false): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = this.flushCurrent(nextSweep).finally(() => { this.flushing = undefined })
    return this.flushing
  }

  private async flushCurrent(nextSweep: boolean): Promise<void> {
    const batch = await this.serial(async () => {
      const state = await this.load()
      const window = state.window
      if (!window || this.windowNow().active) return null
      await this.observeBoundary(state)
      if (!this.deps.ready() || this.deps.ownerAway() === false) return null
      const members = await this.deps.requests()
      const eligible: string[] = []
      for (const item of members) if (item.eligible && this.pendingRecord(item.record) &&
        !await this.deps.mapped(item.record.requestId, item.record.revision)) eligible.push(item.record.requestId)
      if (!window.eligible && !eligible.length && window.summary !== 'pending') return null
      // Only the existing 30-second sweep grants another group. Recovery/departure cannot burst,
      // and civil-clock adjustments cannot stall an already eligible backlog.
      if (state.lastBatchAt !== undefined && !nextSweep) return null
      const cohort = await this.pending(state)
      const pending = cohort.pending.filter(record => eligible.includes(record.requestId))
      const closed = cohort.closed
      if (!pending.length && window.summary !== 'pending') return null
      let summary: string | null = null
      if (window.summary === 'pending') {
        const exits = state.entries.filter((entry): entry is Extract<Entry, { sessionId: string }> => 'sessionId' in entry)
        const lines = ['Quiet hours ended', `${closed} answered, seen or closed while waiting.`]
        for (let i = 0; i < pending.length; i += 1) {
          const record = pending[i]!
          const line = `${phoneField(this.deps.sessionName(record.sessionId), this.deps.home)} · ${record.kind}: ${phoneField(record.title, this.deps.home)}`
          if ([...lines, line].join('\n').length > TELEGRAM_TEXT_LIMIT - 600) { lines.push(`and ${pending.length - i} more in Needs you`); break }
          lines.push(line)
        }
        const exitNames = exits.map(entry => phoneField(this.deps.sessionName(entry.sessionId), this.deps.home, 120))
        const shown: string[] = []
        for (const name of exitNames) { if ([...shown, name].join(', ').length > 400) break; shown.push(name) }
        if (shown.length) lines.push(`Exited: ${shown.join(', ')}`)
        const omitted = window.overflowExits + exitNames.length - shown.length
        if (omitted) lines.push(`${omitted} more session exits.`)
        summary = lines.join('\n')
        window.summary = 'claimed'
        state.summaryHighWater = Math.max(state.summaryHighWater, window.endsAt)
      }
      state.lastBatchAt = this.deps.now().getTime()
      await this.save()
      return { summary, ids: pending.slice(0, 10).map(record => record.requestId), key: window.key,
        closed: cohort.current.filter(record => !this.pendingRecord(record)), overflowExits: window.overflowExits,
        nightOverflowExits: window.nightOverflowExits ?? 0,
        exits: state.entries.filter(entry => 'sessionId' in entry).map(entry => structuredClone(entry)) }
    })
    if (!batch) return
    if (batch.summary) {
      if (!this.deps.ready() || this.deps.ownerAway() === false || this.windowNow().active) {
        await this.serial(async () => { const state = await this.load(); if (state.window?.key === batch.key) state.window.summary = 'pending'; await this.save() })
        return
      }
      let unsent = false
      await this.deps.sendSummary(batch.summary).catch(error => { unsent = telegramSendDefinitelyUnsent(error) })
      await this.serial(async () => {
        const state = await this.load()
        if (state.window?.key === batch.key) {
          state.window.summary = unsent ? 'pending' : 'consumed'
          if (!unsent) state.window.nightOverflowExits = Math.max(0, (state.window.nightOverflowExits ?? 0) - batch.nightOverflowExits)
        }
        if (!unsent) {
          if (state.window) state.window.overflowExits = Math.max(0, state.window.overflowExits - batch.overflowExits)
          state.entries = state.entries.filter(entry => !('sessionId' in entry) || !batch.exits.some(sent =>
            sent.sessionId === entry.sessionId && sent.incarnationId === entry.incarnationId && sent.heldAt === entry.heldAt))
        }
        const clear = unsent ? [] : batch.closed
        await this.save({ clear })
      })
      if (unsent) return
    }
    for (const id of batch.ids) {
      if (!this.deps.ready() || this.deps.ownerAway() === false || this.windowNow().active) break
      const record = await this.deps.current(id)
      if (!record || record.state !== 'open' || record.seenAt !== null) continue
      this.permits.add(id)
      try { await this.deps.page(record) } finally { this.permits.delete(id) }
    }
  }

  /** Observe and retire exact unreleased markers; an eligible outage backlog never expires. */
  private async observeBoundary(state: Ledger): Promise<void> {
    const window = state.window
    if (!window || this.deps.now().getTime() < window.endsAt && this.windowNow().active) return
    if (window.eligible === null) {
      window.eligible = this.deps.ownerAway() !== false
      await this.save(window.eligible ? { release: true } : undefined)
    }
    if (window.eligible === false) {
      if (this.deps.now().getTime() - window.endsAt > LEFT_WITHIN_MS) {
        const markers = await this.deps.requests()
        const retired = markers.filter(item => !item.eligible).map(item => item.record)
        for (const record of retired) this.deps.retire(record)
        const carried = window.carriedSummary === true
        const retained = state.entries.filter(entry => 'requestId' in entry
          ? entry.phase !== 'held' || !retired.some(record => record.requestId === entry.requestId)
          : carried && entry.carried === true)
        const changed = retired.length || retained.length !== state.entries.length ||
          !carried && window.summary !== 'consumed' || (window.nightOverflowExits ?? 0) > 0
        state.entries = retained
        window.overflowExits = carried ? Math.max(0, window.overflowExits - (window.nightOverflowExits ?? 0)) : 0
        window.nightOverflowExits = 0
        if (!carried) window.summary = 'consumed'
        if (changed) await this.save({ clear: retired })
      } else if (this.deps.ownerAway() !== false) {
        window.eligible = true
        await this.save({ release: true })
      }
    }
  }

  /** Only calls from the existing timer pass nextSweep; recovery/departure share the initial group. */
  async sweep(nextSweep = false): Promise<void> {
    await this.serial(async () => {
      const state = await this.load()
      await this.pruneClosedClaims(state)
      await this.observeBoundary(state)
      const rows = await this.deps.requests()
      const mapped: AttentionRecord[] = []
      for (const { record } of rows) if (await this.deps.mapped(record.requestId, record.revision) ||
        state.window?.summary === 'consumed' && !this.pendingRecord(record)) mapped.push(record)
      const retained = state.entries.filter(entry => !('requestId' in entry) || entry.phase !== 'held' ||
        rows.some(item => item.record.requestId === entry.requestId && item.record.revision === entry.revision && !mapped.includes(item.record)))
      let changed = retained.length !== state.entries.length
      state.entries = retained
      if (state.window?.summary === 'consumed' && rows.length === mapped.length && !this.windowNow().active &&
        !state.entries.some(entry => 'requestId' in entry && entry.phase === 'claimed')) {
        state.window = null; delete state.lastBatchAt; changed = true
      }
      if (changed || mapped.length) await this.save({ clear: mapped })
    })
    await this.flush(nextSweep)
  }

}
