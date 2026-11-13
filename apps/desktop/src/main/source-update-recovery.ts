// MODULE: source-update-recovery.ts - adopt restart starts before main retires recovery polling
import type { SessionResumeResult, UpdateRestartRecord } from '@bmn/protocol'

interface RestartAdoptionActions<Result> {
  recordsReady(): boolean
  hasRecord(sessionId: string): boolean
  incarnation(sessionId: string): string | undefined
  attach(start: SessionResumeResult, scope: object): Promise<SessionResumeResult>
  adopt(start: SessionResumeResult): Result
}
export interface RestartAdoption<Result> { accepted: boolean; pending: boolean; recovered: Result[] }

/** The cached start may carry a revoked lease; reattach its existing process, never resume it. */
export function createSourceRestartAdopter<Result>(actions: RestartAdoptionActions<Result>) {
  const attaching = new Map<string, { scope: object; promise: Promise<SessionResumeResult> }>()
  return async (run: UpdateRestartRecord | null, starts: readonly SessionResumeResult[], scope: object,
    allowed: () => boolean): Promise<RestartAdoption<Result>> => {
    const result: RestartAdoption<Result> = { accepted: false, pending: false, recovered: [] }
    if (!allowed()) return result
    if (!actions.recordsReady()) return { ...result, accepted: true, pending: true }
    for (const start of starts) {
      if (!allowed()) return result
      const member = run?.members.find(m => m.sessionId === start.sessionId && m.resumedIncarnation === start.incarnationId)
      if (!member) continue
      if (!actions.hasRecord(start.sessionId)) { result.pending = true; continue }
      let incarnation = actions.incarnation(start.sessionId)
      if (incarnation && incarnation !== member.incarnationId && incarnation !== start.incarnationId) continue
      let attachment = start
      if (incarnation !== start.incarnationId) {
        const key = `${run!.id}:${start.sessionId}:${start.incarnationId}`
        let entry = attaching.get(key)
        if (!entry || entry.scope !== scope) {
          const promise = Promise.resolve().then(() => actions.attach(start, scope))
          entry = { scope, promise }; attaching.set(key, entry)
          const owned = entry
          // A stale polling response still owns this lease; a later caller must reuse it.
          void promise.catch(() => { if (attaching.get(key) === owned) attaching.delete(key) })
        }
        attachment = await entry.promise
        if (!allowed()) return result
        if (!actions.hasRecord(start.sessionId)) { result.pending = true; continue }
        incarnation = actions.incarnation(start.sessionId)
        if (incarnation && incarnation !== member.incarnationId && incarnation !== start.incarnationId) continue
      }
      // A renderer may have acquired a newer lease while attach was pending. The adopter keeps it.
      result.recovered.push(actions.adopt(attachment))
      attaching.delete(`${run!.id}:${start.sessionId}:${start.incarnationId}`)
    }
    result.accepted = allowed()
    return result
  }
}
