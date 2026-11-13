// MODULE: update-restart.ts - Epic 125 (125.4, 125.5): the restart for an update: who is told, what BMN observed, who is resumed, and the one line it types, never into Codex
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { UPDATE_RESTART_SHUTDOWN_MS, UPDATE_RESTART_LIMIT_MS, UPDATE_RESTART_TELL_MS, UPDATE_RESTART_CONTINUE, UPDATE_RESTART_CHECK, UPDATE_RESTART_CARRY_ON,
  updateRestartNotice, updateRestartWords, type UpdateRestartMember, type UpdateRestartRecord, type SessionResumeResult } from '@bmn/protocol'
import { restartClock } from './update-restart-deadline'
import { typeIfIdle, type WakeAttention, type WakeObservation, type WakeProof } from './away-wake'

export type RestartTarget = Pick<UpdateRestartMember, 'sessionId' | 'incarnationId' | 'name' | 'workspace' | 'agent' | 'conversation' | 'atPress' | 'typed' | 'twoConversations'>
interface Hook { sessionId: string; incarnationId: string | null; agent: string; event: string; source: string | null; turn?: { conversation: string; nested: boolean } | undefined }
interface Options {
  path: string
  mainLifetime?: string | undefined
  now(): Date
  monotonic?(): number
  freeze?(): Promise<void>
  thaw?(): void
  targets(): Promise<RestartTarget[]>
  proof: WakeProof
  openAttention(): Promise<readonly WakeAttention[]>
  /** Checks exact persisted interruption and unchanged binding, then uses the existing Resume path. */
  resume(member: UpdateRestartMember): Promise<SessionResumeResult>
  binding(sessionId: string): Promise<string | null>
  currentBinding(sessionId: string): string | null
  /** One informational notice in Needs You, for a Cancel result that came after the dialog closed (D4). */
  notify?(member: UpdateRestartMember, words: string): Promise<void>
}

/** The apps whose hook can print BMN's notice at a tool call. */
const hooked = (agent: string): agent is 'claude' | 'codex' => agent === 'claude' || agent === 'codex'
const CANCEL: readonly string[] = ['cancelled', 'cancelling']
const TELLING: readonly string[] = ['cancelled', 'cancelling', 'resuming']
/** A turn end of the session itself: never a child's, never the owner's interruption. */
const ownTurnEnd = (p: Hook): boolean => (p.event === 'Stop' || p.agent === 'claude' && ['StopFailure', 'Notification'].includes(p.event)) && p.source !== 'subagent' && p.source !== 'interrupted' && p.source !== 'continues'
/**
 * 125.5 AC3: the event the idle proof starts from in a resumed Claude Code run, which has no finished turn yet: its own
 * start by resuming, with nothing reported since. Every other check of the existing proof (the same run, the agent in
 * front, no open request, an empty prompt on a settled screen) is unchanged.
 */
export const resumedStart = (seen: WakeObservation): string | null =>
  seen.agent !== 'claude' ? 'BMN types nothing into this app after a restart'
    : seen.event === 'SessionStart' && seen.source === 'resume' ? null : `its latest event is ${seen.event}, not the start of its resumed run`

/**
 * D4, 125.4 AC2: what BMN's own record says of a session at the press, never a guess. An agent session is at rest
 * (`ended`) when the latest hook event of its live run is a finished turn of its own, or its start with no turn begun
 * since, and none of its requests waits on the owner; any other event means it works; with no event of that run BMN
 * does not know. A session without an agent has no turns: its terminal's activity decides.
 */
export function restartStateAtPress(
  agent: string, seen: Pick<WakeObservation, 'event' | 'source'> | undefined, terminalWorking: () => boolean, requestOpen = false
): UpdateRestartMember['atPress'] {
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'opencode') return terminalWorking() ? 'working' : 'ended'
  if (!seen) return 'unknown'
  // A stop with work in flight (`continues`) is the app going on by itself, never a resting point.
  if (seen.source === 'subagent' || seen.source === 'continues' || requestOpen) return 'working'
  const finished = agent === 'claude' ? ['Stop', 'StopFailure', 'Notification'] : agent === 'codex' ? ['Stop'] : ['session.idle']
  return finished.includes(seen.event) || seen.event === 'SessionStart' ? 'ended' : 'working'
}

export class UpdateRestart {
  private record: UpdateRestartRecord | null = null
  private closingAt = Infinity
  private queue: Promise<unknown> = Promise.resolve()
  private readonly stopping = new Set<Promise<void>>()
  private readonly mainLifetime: string
  private readonly recoverableId: string | null
  private admission: Promise<void> | null = null
  private recovery: Promise<SessionResumeResult[]> | null = null
  private recoveredRun: UpdateRestartRecord | null = null
  private telling = false
  private preview: UpdateRestartMember[] = []
  private refreshing = false
  private readonly started = new Map<string, SessionResumeResult>()

  constructor(private readonly options: Options) {
    this.mainLifetime = options.mainLifetime ?? randomUUID()
    this.recoverableId = null
    if (!existsSync(options.path)) return
    const raw: unknown = JSON.parse(readFileSync(options.path, 'utf8'))
    if (!isRestartRecord(raw)) throw new Error('The update restart receipt is invalid; no sessions were resumed')
    this.record = raw
    if (['closing', 'resuming'].includes(raw.phase) && raw.mainLifetime && raw.mainLifetime !== this.mainLifetime) this.recoverableId = raw.id
    if (raw.phase === 'waiting' || raw.phase === 'admitting') {
      raw.phase = 'cancelled'
      // Only a session that may have been told to stop is listed as not told to carry on.
      for (const m of raw.members) {
        if (m.notice === 'queued') m.notice = 'withdrawn'
        if (m.notice === 'handed' || m.notice === 'printed') { m.tell = 'not-told'; m.reason = 'BMN stopped before the restart closed it; tell it to carry on' } else m.tell = 'unnecessary'
      }
    }
    // An unconfirmed start/write is never replayed after recovery.
    for (const member of raw.members) {
      if (member.resume === 'claimed') { member.resume = 'failed'; member.tell = 'not-told'; member.reason = 'resume outcome unconfirmed' }
      if (member.tell === 'claimed') { member.tell = 'not-told'; member.reason = 'delivery unconfirmed' }
    }
    this.save()
  }
  serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action)
    this.queue = next.catch(() => undefined)
    return next
  }
  snapshot(): UpdateRestartRecord | null { return this.record ? structuredClone(this.record) : null }
  dismiss(): void {
    if (!this.record || !['cancelled', 'complete'].includes(this.record.phase)) return
    this.record.dismissed = true; this.save()
  }
  active(): boolean { return this.record?.phase === 'admitting' || this.record?.phase === 'waiting' || this.record?.phase === 'closing' || this.record?.phase === 'cancelling' }
  async targets(): Promise<UpdateRestartMember[]> {
    // D4: ready only where BMN's record says the turn had ended; a working session and one whose state is not known wait for the notice.
    return (await this.options.targets()).map(target => ({ ...target, ready: target.atPress === 'ended', notice: hooked(target.agent) && target.atPress !== 'ended' ? 'queued' : 'none',
      claim: randomUUID(), printedAt: null, atClose: null, stop: 'pending', capture: 'pending', resume: 'pending', resumedIncarnation: null, tell: 'unnecessary', tellUntil: null, reason: null }))
  }
  /** Short, replayable snapshots never wait behind native launches, hook proofs or target discovery. */
  starts(): SessionResumeResult[] {
    const run = this.record
    return [...this.started.values()].filter(start => run?.members.some(m => m.sessionId === start.sessionId && m.resumedIncarnation === start.incarnationId) && this.options.proof.liveIncarnation(start.sessionId) === start.incarnationId)
  }
  sessions(): UpdateRestartMember[] { return structuredClone(this.active() ? this.record!.members : this.preview) }
  matches(id: string): boolean { return this.record?.id === id }
  /**
   * D3, 125.5 AC4: true for a Codex session this restart resumed, until that resumed run finishes a turn of its own. Every
   * route that types a line (this restart's, the Away wake's, a message's wake) asks here last and types nothing while true.
   */
  typesNothingInto(sessionId: string): boolean {
    const m = this.record?.members.find(one => one.sessionId === sessionId)
    if (!m || m.agent !== 'codex' || m.resume !== 'resumed' || m.resumedIncarnation === null) return false
    if (this.options.proof.liveIncarnation(sessionId) !== m.resumedIncarnation) return false
    const seen = this.options.proof.observation(sessionId)
    return !(seen && seen.incarnationId === m.resumedIncarnation && seen.event === 'Stop' && seen.source !== 'subagent' && seen.source !== 'interrupted' && seen.source !== 'continues')
  }
  refreshTargets(): void {
    if (this.refreshing || this.active()) return
    this.refreshing = true
    const run = this.record
    void this.targets().then(rows => { if (this.record === run && !this.active()) this.preview = rows }).catch(() => undefined).finally(() => { this.refreshing = false })
  }
  begin(build: string, id: string = randomUUID(), deadline = (this.options.monotonic?.() ?? restartClock()) + UPDATE_RESTART_LIMIT_MS): Promise<void> {
    if (this.record?.id === id && this.admission) return this.admission
    if (this.active() || this.record?.phase === 'resuming' || this.admission || this.recovery) throw new Error('A restart is already in progress')
    const run: UpdateRestartRecord = { version: 2, revision: 0, id, build, mainLifetime: this.mainLifetime, startedAt: this.options.now().toISOString(),
      closesAt: this.options.now().getTime() + Math.max(0, deadline - (this.options.monotonic?.() ?? restartClock())), phase: 'admitting', openedBuild: null, members: structuredClone(this.preview) }
    this.record = run; this.started.clear(); this.recoveredRun = null; this.closingAt = deadline - UPDATE_RESTART_SHUTDOWN_MS; this.save()
    const admission = (async (): Promise<void> => {
      try {
        await this.options.freeze?.()
        if (this.record !== run || run.phase !== 'admitting') return
        const members = await this.targets()
        if (this.record !== run || run.phase !== 'admitting') return
        run.members = members; run.phase = 'waiting'; this.save()
      } catch (error) {
        if (this.record === run && run.phase === 'admitting') {
          run.phase = 'cancelled'; run.error = error instanceof Error ? error.message : 'Restart admission failed'
          // Admission cannot print a notice: cached preview rows need no carry-on delivery.
          for (const member of run.members) { if (member.notice !== 'none') member.notice = 'withdrawn'; member.tell = 'unnecessary' }
          this.save()
        }
        throw error
      } finally {
        if (this.record === run && run.phase === 'cancelled') this.options.thaw?.()
      }
    })()
    this.admission = admission
    void admission.finally(() => { if (this.admission === admission) this.admission = null }).catch(() => undefined)
    return admission
  }
  advance(): void {
    this.expire()
    this.tick()
    if (this.record?.phase === 'cancelling') this.startRecovery()
    if (!this.telling) {
      this.telling = true
      void this.tell().catch(() => undefined).finally(() => { this.telling = false })
    }
  }
  startRecovery(openedBuild?: string): void {
    const run = this.record
    if (!run) return
    const action = run.phase === 'cancelling' ? this.recoverCancelled()
      : run.id === this.recoverableId && ['closing', 'resuming'].includes(run.phase) ? this.recover(openedBuild ?? 'unknown build') : null
    void action?.catch(() => undefined)
  }
  private runRecovery(run: UpdateRestartRecord, action: () => Promise<SessionResumeResult[]>): Promise<SessionResumeResult[]> {
    if (this.recovery) return this.recovery
    if (this.recoveredRun === run) return Promise.resolve(this.starts())
    this.recoveredRun = null
    // Register the shared operation before executing any member's asynchronous resume.
    const operation = Promise.resolve().then(action).then(result => {
      if (this.record === run) this.recoveredRun = run
      return result
    }).catch(error => {
      if (this.record === run) { run.error = String(error); this.save() }
      throw error
    }).finally(() => {
      if (this.recovery !== operation) return
      this.recovery = null
      try { this.finishRecovery(run) } catch (error) { this.recoveredRun = null; throw error }
    })
    this.recovery = operation
    return operation
  }
  private finishRecovery(run: UpdateRestartRecord): void {
    if (this.record !== run || this.recovery || this.recoveredRun !== run) return
    if (run.members.some(m => m.resume === 'pending' || m.resume === 'claimed')) return
    const phase = run.phase
    if (phase === 'cancelling') run.phase = 'cancelled'
    if (phase === 'resuming' && run.members.every(m => !['pending', 'claimed'].includes(m.tell))) run.phase = 'complete'
    if (run.phase !== phase) {
      try { this.save() } catch (error) { run.phase = phase; throw error }
    }
  }
  /**
   * BMN says a session was not told. After Cancel, once the dialog has closed, that result is stored on the row and told
   * once in Needs You, in the row's own words (D4).
   */
  private notTold(m: UpdateRestartMember, reason: string): void {
    const run = this.record
    m.tell = 'not-told'; m.reason = reason
    if (run && CANCEL.includes(run.phase) && run.dismissed && !m.late) {
      const words = updateRestartWords(m, 'cancelled')
      const late = { at: this.options.now().toISOString(), words, noticed: false }
      m.late = late
      void this.options.notify?.(structuredClone(m), words).then(() => { if (this.record === run && m.late === late) { late.noticed = true; this.save() } }).catch(() => undefined)
    }
    this.save()
  }
  /**
   * A Codex process that reported a second conversation, at the press or after it: which one the owner was in is not
   * in its hooks, so neither is resumed without him. Kept in the record, so it holds across the close and the reopening.
   */
  secondConversation(sessionId: string, incarnationId: string): void {
    const m = this.record?.members.find(m => m.sessionId === sessionId && m.incarnationId === incarnationId)
    if (!m || m.agent !== 'codex' || m.twoConversations || m.resume !== 'pending') return
    m.twoConversations = true; this.save()
  }
  /** Before either resume route starts anything. */
  private ambiguous(m: UpdateRestartMember): boolean {
    if (!m.twoConversations) return false
    m.resume = 'failed'; m.tell = 'not-told'; m.reason = 'this session reported two conversations'; this.save()
    return true
  }
  async hook(p: Hook): Promise<{ text: string; claim: string } | null> {
    const run = this.record
    if (!run || p.turn?.nested || !p.turn) return null
    const m = run.members.find(m => m.sessionId === p.sessionId && m.incarnationId === p.incarnationId && m.agent === p.agent && m.conversation === p.turn!.conversation)
    if (!m) return null
    // The hook's word that it printed the notice can come after the turn end it caused. That turn end is kept, and
    // dropped again if the session goes on before the word comes.
    if (m.notice === 'handed' && m.stop === 'pending') {
      const ended = ownTurnEnd(p) && p.event === 'Stop'
      if (ended && m.endedHanded === undefined) { m.endedHanded = this.options.now().getTime(); this.save() } else if (!ended && m.endedHanded !== undefined && p.event !== 'SessionEnd') { delete m.endedHanded; this.save() }
    }
    if (run.phase === 'waiting') {
      // D4: a row is ready only on a turn end observed after its notice was printed; without the printed notice it does not change.
      if (ownTurnEnd(p) && p.event === 'Stop' && m.notice === 'printed' && !m.ready) { m.ready = true; this.save() }
      if (p.event === 'PostToolUse' && m.notice === 'queued' && hooked(m.agent)) {
        m.notice = 'handed'; this.save()
        return { text: updateRestartNotice(m.agent, run.closesAt), claim: m.claim }
      }
      return null
    }
    if (!CANCEL.includes(run.phase) || m.stop !== 'pending' || m.notice !== 'printed') return null
    // After Cancel a session that was told to stop and still works is told to carry on at its next tool call.
    if (p.event === 'PostToolUse' && m.tell === 'pending' && m.carryFinishedAt === undefined && !m.ready) {
      m.tell = 'claimed'; m.carryClaim = randomUUID(); m.tellUntil = this.options.now().getTime() + UPDATE_RESTART_TELL_MS; this.save()
      return { text: UPDATE_RESTART_CARRY_ON, claim: m.carryClaim }
    }
    // It ended its turn first: a Claude Code session gets the line typed under the idle proof; a Codex session is never typed into.
    if (ownTurnEnd(p) && m.tell === 'pending' && m.carryFinishedAt === undefined && !m.ready) {
      m.carryFinishedAt = this.options.now().getTime()
      if (m.agent === 'claude') { m.tellUntil = m.carryFinishedAt + UPDATE_RESTART_TELL_MS; this.save() }
      else this.notTold(m, 'BMN types nothing into Codex')
    }
    return null
  }
  printed(sessionId: string, incarnationId: string | null, claim: string): boolean {
    const run = this.record
    const m = run?.members.find(m => m.sessionId === sessionId && m.incarnationId === incarnationId && (m.claim === claim || m.carryClaim === claim))
    if (!m || !run) return false
    if (claim === m.claim && m.notice === 'handed') {
      m.notice = 'printed'; m.printedAt = this.options.now().toISOString()
      const ended = m.endedHanded; delete m.endedHanded
      // An acknowledgement that came after Cancel: the session was told to stop after all.
      if (CANCEL.includes(run.phase) && m.stop === 'pending' && (m.tell === 'pending' || m.tell === 'not-told' && m.reason === 'notice delivery unconfirmed')) {
        m.tell = 'pending'; m.reason = null
        if (ended === undefined) m.tellUntil = null // still working: it waits for its next tool call
        else {
          // It has already ended its turn, so no tool call will come: Claude Code gets the line under the idle proof, Codex is listed.
          m.carryFinishedAt = ended
          if (m.agent === 'claude') m.tellUntil = this.options.now().getTime() + UPDATE_RESTART_TELL_MS
          else { this.notTold(m, 'BMN types nothing into Codex'); return true }
        }
      }
      this.save(); return true
    }
    if (claim === m.carryClaim && CANCEL.includes(run.phase) && (m.tell === 'claimed' || m.tell === 'told' || m.tell === 'not-told' && m.reason === 'delivery unconfirmed')) { m.tell = 'told'; m.reason = null; this.save(); return true }
    return false
  }
  cancel(): void {
    const run = this.record
    if (!run || !['admitting', 'waiting', 'closing'].includes(run.phase)) throw new Error('There is no restart to cancel')
    run.phase = run.members.some(m => m.stop !== 'pending') ? 'cancelling' : 'cancelled'
    if (run.phase === 'cancelled' && !this.admission) this.options.thaw?.()
    const now = this.options.now().getTime()
    for (const m of run.members) {
      m.atClose = null
      if (run.phase === 'cancelled' && m.resume === 'pending') m.resume = 'excluded'
      if (m.stop !== 'pending') continue // already stopped: it is resumed first, and its row is decided then
      if (m.notice === 'queued') m.notice = 'withdrawn'
      if (m.notice === 'none' || m.notice === 'withdrawn') { m.tell = 'unnecessary'; continue }
      if (m.notice === 'handed') { m.tell = 'pending'; m.tellUntil = now + UPDATE_RESTART_TELL_MS; m.reason = 'notice delivery unconfirmed'; continue }
      // Its notice was printed. Still working: told to carry on at its next tool call, however long that takes.
      if (!m.ready) { m.tell = 'pending'; m.tellUntil = null; continue }
      // Its turn ended after the notice: a Claude Code session gets the line under the idle proof, a Codex session is listed.
      if (m.agent === 'claude') { m.tell = 'pending'; m.tellUntil = now + UPDATE_RESTART_TELL_MS } else { m.tell = 'not-told'; m.reason = 'BMN types nothing into Codex' }
    }
    this.save()
  }
  recoverCancelled(): Promise<SessionResumeResult[]> {
    if (this.recovery) return this.recovery
    const run = this.record
    if (!run || run.phase !== 'cancelling') return Promise.resolve([])
    return this.runRecovery(run, () => this.resumeCancelledMembers(run))
  }
  /** After a resume: whose line BMN will type (a Claude Code session that was working or was told to stop), and who is not told. */
  private afterResume(m: UpdateRestartMember): void {
    const interrupted = m.atPress === 'working' || m.notice === 'printed'
    m.tell = m.agent === 'claude' && interrupted ? 'pending' : hooked(m.agent) && m.atPress !== 'ended' ? 'not-told' : 'unnecessary'
    m.tellUntil = m.tell === 'pending' ? this.options.now().getTime() + UPDATE_RESTART_TELL_MS : null
    m.reason = m.tell === 'not-told' ? m.agent === 'codex' ? 'BMN types nothing into Codex' : 'BMN did not know this session was working' : null
  }
  private async resumeCancelledMembers(run: UpdateRestartRecord): Promise<SessionResumeResult[]> {
    await Promise.allSettled([...this.stopping])
    // All stop authorizations have settled. Host admission remains fenced by phase while
    // exact confirmed interruptions are recovered through the normal resume checks.
    this.options.thaw?.()
    const started: SessionResumeResult[] = []
    for (const m of run.members) {
      if (m.stop === 'pending') { m.resume = 'excluded'; continue }
      if (m.resume !== 'pending') continue
      if (m.stop !== 'confirmed') {
        m.resume = 'failed'; m.tell = 'not-told'; m.reason = 'stop outcome unconfirmed; resume by hand'; this.save(); continue
      }
      if (this.ambiguous(m)) continue
      m.resume = 'claimed'; this.save()
      try {
        const result = await this.options.resume(m)
        this.started.set(m.sessionId, result); started.push(result); m.resume = 'resumed'; m.resumedIncarnation = result.incarnationId
        this.afterResume(m)
      } catch (error) {
        m.resume = 'failed'; m.tell = 'not-told'; m.reason = error instanceof Error ? error.message : 'resume failed'
      }
      this.save()
    }
    return started
  }
  tick(now = false, id = this.record?.id): void {
    const run = this.record
    if (run?.id !== id) return
    if ((run?.phase === 'waiting' || now && run?.phase === 'admitting') && (now || run.members.every(m => m.ready) || (this.options.monotonic?.() ?? restartClock()) >= this.closingAt)) {
      if (run.phase === 'admitting') run.error = 'Session discovery did not finish; resume any missing sessions by hand'
      // 125.4 AC4: each row's state at close, as it was, whether every row was ready, the limit passed or he pressed Restart now.
      for (const m of run.members) m.atClose = m.ready ? 'ready' : 'not-ready'
      run.phase = 'closing'; this.save()
    }
  }
  capture(sessionId: string, incarnationId: string, outcome: 'saved' | 'unavailable'): void {
    const m = this.record?.members.find(m => m.sessionId === sessionId && m.incarnationId === incarnationId)
    if (!m || this.record?.phase !== 'closing') return
    m.capture = outcome; this.save()
  }
  abort(reason: string): void {
    if (!this.record || this.record.members.some(m => m.stop !== 'pending')) throw new Error('Stopping has begun; finish shutdown and recover')
    this.record.phase = 'waiting'; this.cancel()
    this.record.error = reason
    this.save()
  }
  async stop(sessionId: string, incarnationId: string, action: () => Promise<'confirmed' | 'unknown'>): Promise<void> {
    const run = this.record
    const m = run?.members.find(m => m.sessionId === sessionId && m.incarnationId === incarnationId)
    if (!run || run.phase !== 'closing' || !m || m.stop !== 'pending') throw new Error('This process is not an unstopped restart member')
    m.stop = 'unknown'; this.save()
    const completion = (async () => {
      const outcome = await action().catch(() => 'unknown' as const)
      if (this.record === run) { m.stop = outcome; this.save() }
    })()
    this.stopping.add(completion)
    try { await completion } finally { this.stopping.delete(completion) }
  }
  recover(openedBuild: string): Promise<SessionResumeResult[]> {
    if (this.recovery) return this.recovery
    const run = this.record
    if (!run || run.id !== this.recoverableId) return Promise.resolve([])
    if (!['closing', 'resuming'].includes(run.phase)) return Promise.resolve(this.starts())
    return this.runRecovery(run, () => this.resumeMembers(run, openedBuild))
  }
  /** 125.5 AC2: the sessions the restart stopped are resumed without a press, one at a time. */
  private async resumeMembers(run: UpdateRestartRecord, openedBuild: string): Promise<SessionResumeResult[]> {
    run.phase = 'resuming'; run.openedBuild = openedBuild; this.save()
    for (const m of run.members) {
      if (m.resume !== 'pending') continue
      if (m.stop !== 'confirmed') { m.resume = 'failed'; m.tell = 'not-told'; m.reason = 'old process exit or interruption persistence unconfirmed; resume by hand'; this.save(); continue }
      if (this.ambiguous(m)) continue
      m.resume = 'claimed'; this.save()
      try {
        const result = await this.options.resume(m)
        this.started.set(m.sessionId, result); m.resume = 'resumed'; m.resumedIncarnation = result.incarnationId
        this.afterResume(m)
      } catch (error) {
        m.resume = 'failed'; m.tell = 'not-told'; m.reason = error instanceof Error ? error.message : 'resume failed'
      }
      this.save()
    }
    return this.starts()
  }
  /** After Cancel: a session told to stop that still works, in its own run and conversation; it waits for its next tool call. */
  private survivor(m: UpdateRestartMember): boolean {
    return this.record !== null && CANCEL.includes(this.record.phase) && m.stop === 'pending' && !m.ready && m.carryFinishedAt === undefined && m.notice === 'printed' && this.options.proof.liveIncarnation(m.sessionId) === m.incarnationId && this.options.currentBinding(m.sessionId) === m.conversation
  }
  private expire(): void {
    const run = this.record
    if (!run || !TELLING.includes(run.phase)) return
    const now = this.options.now().getTime()
    for (const m of run.members) {
      if (m.tell === 'claimed' && m.tellUntil !== null && now >= m.tellUntil) this.notTold(m, 'delivery unconfirmed')
      else if (m.tell === 'pending' && !this.survivor(m) && (m.tellUntil === null || now >= m.tellUntil)) this.notTold(m, m.reason ?? 'the idle proof did not hold within its time')
    }
  }
  /**
   * The one line BMN types (125.5 AC3, D4): only into a Claude Code session, only once, only when the existing idle proof
   * holds. A Codex session never reaches a write here (D3).
   */
  async tell(): Promise<void> {
    const run = this.record
    if (!run || !TELLING.includes(run.phase)) return
    this.expire()
    for (const m of run.members) {
      if (m.tell !== 'pending') continue
      const cancellation = CANCEL.includes(run.phase)
      const resumed = m.resume === 'resumed' && m.resumedIncarnation !== null
      // A session still working after Cancel waits for its hook, and one whose notice may not have been printed for its time.
      if (!resumed && (!cancellation || m.stop !== 'pending' || m.notice !== 'printed' || !(m.ready || m.carryFinishedAt !== undefined))) continue
      if (m.agent !== 'claude' || this.typesNothingInto(m.sessionId)) { this.notTold(m, 'BMN types nothing into this app'); continue }
      const incarnation = resumed ? m.resumedIncarnation! : m.incarnationId
      const line = cancellation ? UPDATE_RESTART_CARRY_ON : m.atClose === 'ready' ? UPDATE_RESTART_CONTINUE : UPDATE_RESTART_CHECK
      const seen = this.options.proof.observation(m.sessionId)
      let reason = resumed ? 'the resumed session has not reported its start' : 'no finished-turn observation for the session'
      if (seen && seen.incarnationId !== incarnation) reason = 'the session run changed'
      else if (seen && await this.options.binding(m.sessionId) === m.conversation) {
        const generation = this.options.proof.generation(m.sessionId).generation
        const open = await this.options.openAttention()
        let attempted = false
        const allowed = (): string | null => this.record !== run || !TELLING.includes(run.phase) || !['pending', 'claimed'].includes(m.tell) || this.options.currentBinding(m.sessionId) !== m.conversation ? 'restart or conversation changed'
          : m.tellUntil !== null && this.options.now().getTime() >= m.tellUntil ? 'delivery window expired' : null
        reason = await typeIfIdle({ ...this.options.proof, write: (id, text) => { attempted = true; this.options.proof.write(id, text) } }, {
          seen: { ...seen }, generation, open, line,
          // A resumed run draws its screen after it reports its start: two quiet seconds first, then the unchanged last checks.
          quietMs: resumed ? 2000 : 0, quietWords: resumed ? 'its resumed run just started' : 'turn just ended',
          finished: { at: seen.observedAt, unknown: 'turn end unknown' },
          ...(resumed ? { antecedent: resumedStart } : {}),
          // As for the Away wake: only the app's own question or permission holds the line back. A notice left open by the
          // run that was closed (a finished turn, a repeated call) is not something the resumed run waits on.
          holds: row => (row.kind === 'question' || row.kind === 'permission') && row.openedBy !== 'cli',
          stillAllowed: allowed,
          claim: async () => { m.tell = 'claimed'; this.save(); return null },
          // A write that was attempted is never tried again, whatever it came to.
          unclaim: async () => { if (!attempted && this.record === run && m.tell === 'claimed' && (m.tellUntil === null || this.options.now().getTime() < m.tellUntil)) { m.tell = 'pending'; this.save() } }
        }) ?? ''
        if ((m as UpdateRestartMember).tell === 'claimed') {
          if (reason === '') { m.tell = 'told'; m.reason = null; this.save() } else this.notTold(m, reason)
          continue
        }
      }
      if (m.tell === 'pending' && m.reason !== reason) { m.reason = reason; this.save() }
    }
    this.expire()
    this.finishRecovery(run)
  }
  private save(): void {
    if (!this.record) return
    this.record.revision += 1
    const { path } = this.options
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomUUID()}.tmp`
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(this.record) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, path)
    const dir = openSync(dirname(path), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
    if (!isRestartRecord(JSON.parse(readFileSync(path, 'utf8')))) throw new Error('Restart receipt readback failed')
  }
}
function isRestartRecord(raw: unknown): raw is UpdateRestartRecord {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as UpdateRestartRecord
  return r.version === 2 && Number.isSafeInteger(r.revision) && typeof r.id === 'string' && typeof r.build === 'string' &&
    typeof r.startedAt === 'string' && (r.mainLifetime === undefined || typeof r.mainLifetime === 'string') && (r.error === undefined || typeof r.error === 'string') && Number.isFinite(r.closesAt) && (r.dismissed === undefined || typeof r.dismissed === 'boolean') && ['admitting', 'waiting', 'closing', 'cancelling', 'cancelled', 'resuming', 'complete'].includes(r.phase) &&
    Array.isArray(r.members) && r.members.length <= 2000 && new Set(r.members.map(m => m.sessionId)).size === r.members.length && r.members.every(m =>
      typeof m.sessionId === 'string' && typeof m.incarnationId === 'string' && typeof m.name === 'string' && typeof m.workspace === 'string' && typeof m.agent === 'string' &&
      (m.typed === undefined || (typeof m.typed === 'object' && m.typed !== null && typeof m.typed.cwd === 'string' && Array.isArray(m.typed.argv) && m.typed.argv.every(a => typeof a === 'string'))) &&
      (m.twoConversations === undefined || typeof m.twoConversations === 'boolean') &&
      (m.conversation === null || typeof m.conversation === 'string') && ['ended', 'working', 'unknown'].includes(m.atPress) && typeof m.ready === 'boolean' &&
      // The one rule the record itself keeps (D4): a session is ready only if its turn had ended at the press or its notice was printed.
      (!m.ready || m.atPress === 'ended' || m.notice === 'printed') &&
      ['none', 'queued', 'handed', 'printed', 'withdrawn'].includes(m.notice) && typeof m.claim === 'string' && (m.printedAt === null || typeof m.printedAt === 'string') &&
      (m.atClose === null || m.atClose === 'ready' || m.atClose === 'not-ready') &&
      (m.endedHanded === undefined || Number.isFinite(m.endedHanded)) &&
      (m.carryClaim === undefined || typeof m.carryClaim === 'string') && (m.carryFinishedAt === undefined || Number.isFinite(m.carryFinishedAt)) &&
      (m.late === undefined || m.late !== null && typeof m.late === 'object' && typeof m.late.at === 'string' && typeof m.late.words === 'string' && typeof m.late.noticed === 'boolean') &&
      (m.tellUntil === null || Number.isFinite(m.tellUntil)) && (m.resumedIncarnation === null || typeof m.resumedIncarnation === 'string') && (m.reason === null || typeof m.reason === 'string') &&
      ['pending', 'confirmed', 'unknown'].includes(m.stop) && ['pending', 'saved', 'unavailable'].includes(m.capture) &&
      ['pending', 'claimed', 'resumed', 'failed', 'excluded'].includes(m.resume) && ['pending', 'claimed', 'told', 'not-told', 'unnecessary'].includes(m.tell))
}
