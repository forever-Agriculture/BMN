// MODULE: departure-wake.ts - ask a resting session once during getting ready, under the Away wake's complete idle proof
import { randomUUID } from 'node:crypto'
import { DEPARTURE_ANSWER_MS, DEPARTURE_LINE, DEPARTURE_QUIET_MS, type GrantPeriod, type GrantRead } from '@bmn/protocol'
import { typeIfIdle, type WakeAttention, type WakeProof } from './away-wake'

export interface DepartureWakeOptions extends WakeProof {
  period(): GrantPeriod | null
  epoch(): number
  handed(periodId: string, sessionId: string): boolean
  openAttention(): Promise<readonly WakeAttention[]>
  finishedTurn(sessionId: string, incarnationId: string): string | null
  delivery(input: { periodId: string; sessionId: string; kind: 'claim' | 'release' | 'told' | 'reason'; token: string; reason?: string }): Promise<{ claimed: boolean; read: GrantRead }>
  changed(read: GrantRead): void
  quietMs?: number
  transition?: { pending(): boolean; wait(): Promise<void> }
}

export class DepartureWake {
  private running = false
  constructor(private readonly options: DepartureWakeOptions) {}

  async sweep(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const period = this.options.period()
      if (period?.state !== 'leaving' || period.collection === undefined) return
      const epoch = this.options.epoch()
      // Capture every generation before the one shared asynchronous attention read.
      const candidates = period.collection.sessions.filter(session => session.selected && session.toldAt === null && session.claim === null &&
        this.options.now().getTime() - Date.parse(session.selectedAt) < DEPARTURE_ANSWER_MS)
        .map(session => ({ session, generation: this.options.generation(session.sessionId).generation }))
      if (candidates.length === 0) return
      const open = await this.options.openAttention()
      for (const { session, generation } of candidates) {
        const seen = this.options.observation(session.sessionId)
        const token = randomUUID()
        const input = { periodId: period.periodId, sessionId: session.sessionId, token }
        const delivery = async (kind: 'claim' | 'release' | 'told' | 'reason', reason?: string) => {
          const result = await this.options.delivery({ ...input, kind, ...(reason === undefined ? {} : { reason }) })
          this.options.changed(result.read)
          return result
        }
        if (seen === undefined || seen.incarnationId !== session.incarnationId) {
          await delivery('reason', 'no fresh idle proof')
          continue
        }
        let attempted = false
        let claimed = false
        const reason = await typeIfIdle({ ...this.options, write: (id, text) => {
          attempted = true
          this.options.write(id, text)
        } }, {
          seen, generation, open, ...(this.options.transition ? { transition: this.options.transition } : {}), quietMs: this.options.quietMs ?? DEPARTURE_QUIET_MS,
          quietWords: 'turn finished less than 20 seconds ago', line: DEPARTURE_LINE,
          finished: { at: this.options.finishedTurn(session.sessionId, seen.incarnationId), unknown: 'no fresh own finished turn; resumed or restarted' },
          holds: row => (row.kind === 'question' || row.kind === 'permission') && row.openedBy !== 'cli',
          stillAllowed: () => {
            const current = this.options.period()
            const target = current?.collection?.sessions.find(other => other.sessionId === session.sessionId)
            if (this.options.epoch() !== epoch || current?.periodId !== period.periodId || current.state !== 'leaving') return 'departure changed'
            if (!target?.selected || target.toldAt !== null || this.options.handed(period.periodId, session.sessionId)) return 'already told'
            if (this.options.now().getTime() - Date.parse(target.selectedAt) >= DEPARTURE_ANSWER_MS) return 'answer window ended'
            return target.claim !== null && (!claimed || target.claim !== token) ? 'delivery already reserved' : null
          },
          claim: async () => {
            const result = await delivery('claim')
            claimed = result.claimed
            return claimed ? null : 'delivery already reserved'
          },
          unclaim: async () => { if (!attempted && claimed) await delivery('release') }
        }).catch(() => 'idle proof unreadable')
        if (reason === null) await delivery('told')
        else if (!attempted) await delivery('reason', reason)
        // An attempted write, including one which threw, retains its durable claim. Never replay it.
      }
    } finally { this.running = false }
  }
}
