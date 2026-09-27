// MODULE: remote-answer.ts - delivers an answer chosen away from the desk into the exact dialog that asked (Epic 30.2)
import type { AttentionEvidence, AttentionPrompt, AttentionRecord } from '@bmn/protocol'
import {
  claudePermissionOnScreen,
  claudeReviewOnScreen,
  questionOnScreen,
  type QuestionHarness
} from './screen-mirror'

/*
 * Only the utility process calls `answer`: it is reached from the Telegram tap handler and from nothing
 * on the control socket or in the `bmn` CLI, because the owner token is readable by the agents
 * themselves. The one socket route here, `take`, hands an OpenCode plugin an answer already decided;
 * it can neither create nor change one.
 */

/** One option index per question, or a permission decision. "Always allow" does not exist here. */
export type RemoteAnswer =
  | { type: 'choices'; choices: number[] }
  | { type: 'permission'; decision: 'allow' | 'deny' }

export type AnswerRefusal =
  /** The request closed, or the process that asked is gone. */
  | 'gone'
  /** The request or its dialog changed since the card was sent. */
  | 'changed'
  /** The mirrored screen does not show that dialog with that choice. */
  | 'not-on-screen'
  /** No verified way to answer this shape (docs/remote-answers.md), or an answer that does not fit it. */
  | 'unsupported'
  /** A permission, and the owner has not allowed answering permissions from the phone. */
  | 'permissions-off'
  /** Another answer for this request is already on its way. */
  | 'claimed'
  /** OpenCode's plugin did not collect the answer in time; nothing was sent. */
  | 'not-delivered'

export type AnswerOutcome =
  | { state: 'refused'; reason: AnswerRefusal }
  /** The harness itself reported exactly this answer. */
  | { state: 'confirmed'; sent: string[] }
  /** Sent, but nothing attributable came back; never retried and never shown as success. */
  | { state: 'sent-unconfirmed'; sent: string[] }
  /** Some questions were answered, then the dialog stopped matching; nothing more was written. */
  | { state: 'partial'; sent: string[]; total: number }

export interface AnswerRequest {
  requestId: string
  /** The request revision, dialog epoch and process the card was sent for. */
  revision: number
  epoch: number
  incarnationId: string
  answer: RemoteAnswer
}

export type AnswerRoute = 'claude-keys' | 'codex-keys' | 'opencode-api'

/** What an OpenCode plugin collects through `answer.take` and posts to its own server. */
export type PluginAnswer =
  | { requestRef: string; kind: 'question'; answers: string[][] }
  | { requestRef: string; kind: 'permission'; reply: 'once' | 'reject' }

export interface ScreenLike {
  lines(): string[]
  settled(): Promise<void>
  onChange(listener: () => void): () => void
}

export interface RemoteAnswerDependencies {
  getAttention(requestId: string): Promise<AttentionRecord | null>
  liveIncarnationId(sessionId: string): string | undefined
  /** The session's screen mirror, started if needed; undefined when that process is not live. */
  screen(sessionId: string, incarnationId: string): ScreenLike | undefined
  write(sessionId: string, bytes: Uint8Array): void
  answerPermissions(): Promise<boolean>
  timing?: Partial<AnswerTiming>
}

export interface AnswerTiming {
  /** How long a stepped dialog may take to show its next question after a key. */
  stepMs: number
  /** How long an attributable report may take before the answer is `sent-unconfirmed`. */
  confirmMs: number
  /** How long OpenCode's plugin may take to collect an answer. */
  pickupMs: number
  /** How long an unconfirmed answer can still be upgraded by a late report. */
  lateMs: number
}

const DEFAULT_TIMING: AnswerTiming = { stepMs: 3_000, confirmMs: 10_000, pickupMs: 5_000, lateMs: 10 * 60_000 }

/** Digits are single keys, and each harness numbers one extra entry after the agent's options. */
const MAX_KEY_OPTIONS = 8

/** Which verified route answers this prompt, or null for every shape the matrix leaves without buttons. */
export function answerRoute(prompt: AttentionPrompt | null): AnswerRoute | null {
  if (!prompt) return null
  if (prompt.type === 'questions') {
    if (prompt.shape !== 'choice' || prompt.questions.some((question) => question.multiSelect)) return null
    if (prompt.harness === 'opencode') return 'opencode-api'
    if (prompt.questions.some((question) => question.options.length > MAX_KEY_OPTIONS)) return null
    return prompt.harness === 'claude' ? 'claude-keys' : 'codex-keys'
  }
  // An allow needs the exact thing that would run; Codex permissions stay with Auto Review.
  if (prompt.shape !== 'permission' || prompt.command === null) return null
  if (prompt.harness === 'opencode') return 'opencode-api'
  return prompt.harness === 'claude' && prompt.tool === 'Bash' ? 'claude-keys' : null
}

/** Whether a report names this prompt's own harness id, which no successor dialog shares. */
function namesItself(prompt: AttentionPrompt, evidence: AttentionEvidence): boolean {
  return (prompt.requestRef !== null && evidence.requestRef === prompt.requestRef) ||
    (prompt.toolUseId !== null && evidence.toolUseId === prompt.toolUseId)
}

function sameIds(expected: string | null, reported: string | null): boolean {
  return expected === null || reported === null || expected === reported
}

/** Whether a harness report names exactly the answer that was sent (decision 4). */
export function evidenceConfirms(prompt: AttentionPrompt, answer: RemoteAnswer, evidence: AttentionEvidence): boolean {
  if (prompt.harness === 'opencode' && (prompt.requestRef === null || evidence.requestRef !== prompt.requestRef)) return false
  if (!sameIds(prompt.requestRef, evidence.requestRef) || !sameIds(prompt.toolUseId, evidence.toolUseId)) return false
  if (prompt.type === 'questions') {
    if (answer.type !== 'choices' || evidence.answers === null || evidence.answers.length !== prompt.questions.length) return false
    return prompt.questions.every((question, index) => {
      const labels = evidence.answers![index]!
      return labels.length === 1 && labels[0] === question.options[answer.choices[index]!]?.label
    })
  }
  if (answer.type !== 'permission') return false
  if (evidence.permission !== (answer.decision === 'allow' ? 'allowed' : 'denied')) return false
  if (prompt.harness === 'opencode') return true
  // Claude's permission prompt carries no tool call id, so the tool and its exact input stand in for it.
  return evidence.tool === prompt.tool && evidence.command === prompt.command
}

function answerFits(prompt: AttentionPrompt, answer: RemoteAnswer): boolean {
  if (prompt.type === 'permission') return answer.type === 'permission'
  return answer.type === 'choices' &&
    answer.choices.length === prompt.questions.length &&
    answer.choices.every((choice, index) =>
      Number.isSafeInteger(choice) && choice >= 0 && choice < prompt.questions[index]!.options.length)
}

function sentLabels(prompt: AttentionPrompt, answer: RemoteAnswer): string[] {
  if (answer.type === 'permission') return [answer.decision === 'allow' ? 'Allow once' : 'Deny']
  if (prompt.type !== 'questions') return []
  return answer.choices.map((choice, index) => prompt.questions[index]!.options[choice]!.label)
}

const key = (digit: number): Uint8Array => new TextEncoder().encode(String(digit))

interface Tracked {
  sessionId: string
  incarnationId: string | null
  prompt: AttentionPrompt
  epoch: number
  visible: boolean
}

interface Pending {
  record: AttentionRecord
  prompt: AttentionPrompt
  answer: RemoteAnswer
  sent: string[]
  settled: boolean
  settle(outcome: AnswerOutcome): void
  timers: NodeJS.Timeout[]
  /** The request closed before a report arrived; only a report naming its own id may still confirm it. */
  closed: boolean
}

/** What an OpenCode plugin says became of an answer it collected: its own server accepted or rejected the reply. */
export interface PluginReport {
  requestRef: string
  delivered: boolean
}

interface Delivery {
  requestId: string
  sessionId: string
  incarnationId: string
  payload: PluginAnswer
  taken: boolean
  onTaken(): void
  /** Whether it may still be handed out: a Deny must still answer this request alone. */
  valid(): boolean
  onDropped(): void
}

interface Watch {
  unsubscribe(): void
  check(): void
}

export class RemoteAnswers {
  private readonly timing: AnswerTiming
  private readonly tracked = new Map<string, Tracked>()
  private readonly claims = new Set<string>()
  private readonly pending = new Map<string, Pending>()
  private readonly deliveries = new Map<string, Delivery[]>()
  private readonly takers = new Map<string, Set<() => void>>()
  /** Plugin answers handed out and not yet reported on, by session and harness request id. */
  private readonly handedOut = new Map<string, { requestId: string; incarnationId: string }>()
  private readonly watches = new Map<string, Watch>()
  /** Sessions BMN is typing into right now; its own keys move the dialog through its steps. */
  private readonly typing = new Set<string>()
  /** OpenCode permission requests still waiting, per session: its `reject` answers all of them at once. */
  private readonly openCodePermissions = new Map<string, Set<string>>()
  private readonly lateListeners = new Set<(requestId: string, outcome: AnswerOutcome) => void>()

  constructor(private readonly deps: RemoteAnswerDependencies) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
  }

  /**
   * A hook in this session opened, resolved or withdrew a request. Called before the store is touched, so
   * a card sent for the dialog as it was cannot answer whatever the agent reported next (decision 3).
   */
  hookReported(sessionId: string): void {
    for (const entry of this.tracked.values()) {
      if (entry.sessionId === sessionId) entry.epoch += 1
    }
  }

  /** Starts following an open request that carries a prompt: its epoch, and for keys, its dialog on screen. */
  track(record: AttentionRecord): void {
    if (record.state !== 'open' || !record.prompt) return
    const prompt = record.prompt
    const current = this.tracked.get(record.requestId)
    if (current) {
      current.prompt = prompt
    } else {
      this.tracked.set(record.requestId, {
        sessionId: record.sessionId,
        incarnationId: record.incarnationId,
        prompt,
        epoch: 1,
        visible: false
      })
    }
    if (prompt.harness === 'opencode' && prompt.type === 'permission' && prompt.requestRef !== null) {
      const refs = this.openCodePermissions.get(record.sessionId) ?? new Set<string>()
      refs.add(prompt.requestRef)
      this.openCodePermissions.set(record.sessionId, refs)
    }
    const route = answerRoute(prompt)
    if ((route === 'claude-keys' || route === 'codex-keys') && record.incarnationId !== null) {
      this.watch(record.sessionId, record.incarnationId)
    }
  }

  /** The dialog epoch a card is sent for; null when the request is not followed. */
  epochOf(requestId: string): number | null {
    return this.tracked.get(requestId)?.epoch ?? null
  }

  /** Whether a Deny would answer only this OpenCode request: its `reject` also denies every other pending one. */
  canDeny(record: AttentionRecord): boolean {
    const prompt = record.prompt
    if (!prompt || prompt.type !== 'permission') return false
    if (prompt.harness !== 'opencode') return answerRoute(prompt) !== null
    const refs = this.openCodePermissions.get(record.sessionId)
    return prompt.requestRef !== null && refs !== undefined && refs.size === 1 && refs.has(prompt.requestRef)
  }

  /**
   * A hook's resolve or withdraw carried evidence. Returns the request it proves answered from the phone,
   * or null. Called before the store closes the request, so the close can say who answered.
   */
  evidence(sessionId: string, requestKey: string, evidence: AttentionEvidence): string | null {
    if (evidence.requestRef !== null) this.openCodePermissions.get(sessionId)?.delete(evidence.requestRef)
    for (const [requestId, pending] of this.pending) {
      if (pending.record.sessionId !== sessionId || pending.record.requestKey !== requestKey) continue
      // A report from a later process, or about a request that already closed, speaks for another dialog
      // unless it names this one's own id: an identical successor reports the same tool and command.
      if (this.deps.liveIncarnationId(sessionId) !== pending.record.incarnationId) continue
      if (pending.closed && !namesItself(pending.prompt, evidence)) continue
      if (!evidenceConfirms(pending.prompt, pending.answer, evidence)) continue
      const outcome: AnswerOutcome = { state: 'confirmed', sent: pending.sent }
      if (pending.settled) {
        for (const listener of this.lateListeners) listener(requestId, outcome)
      }
      pending.settle(outcome)
      this.finishPending(requestId)
      return requestId
    }
    return null
  }

  /** Called once a request is no longer open, by whatever closed it. */
  closed(record: AttentionRecord): void {
    const pending = this.pending.get(record.requestId)
    if (pending) pending.closed = true
    this.tracked.delete(record.requestId)
    this.claims.delete(record.requestId)
    this.dropDeliveries((delivery) => delivery.requestId === record.requestId)
    const prompt = record.prompt
    if (prompt?.harness === 'opencode' && prompt.type === 'permission' && prompt.requestRef !== null) {
      this.openCodePermissions.get(record.sessionId)?.delete(prompt.requestRef)
    }
    this.unwatchIdle(record.sessionId)
  }

  /** Forgets every request not in `open`, for requests that closed by expiry or a route that does not report. */
  retain(open: ReadonlySet<string>): void {
    for (const [requestId, entry] of this.tracked) {
      if (open.has(requestId)) continue
      this.tracked.delete(requestId)
      this.claims.delete(requestId)
      this.unwatchIdle(entry.sessionId)
    }
    this.dropDeliveries((delivery) => !open.has(delivery.requestId))
  }

  /** A confirmation that arrived after the answer was already reported `sent-unconfirmed`. */
  onLateOutcome(listener: (requestId: string, outcome: AnswerOutcome) => void): () => void {
    this.lateListeners.add(listener)
    return () => this.lateListeners.delete(listener)
  }

  /**
   * Answers one request, only through the dialog it was sent for. The claim is taken before any await,
   * so a second answer for the same request loses whatever happens to the first.
   */
  async answer(request: AnswerRequest): Promise<AnswerOutcome> {
    if (this.claims.has(request.requestId)) return { state: 'refused', reason: 'claimed' }
    this.claims.add(request.requestId)
    let wrote = false
    try {
      const outcome = await this.deliver(request, () => {
        wrote = true
      })
      // A refusal means nothing reached the agent, whatever was attempted: the owner may tap again.
      if (outcome.state === 'refused') wrote = false
      return outcome
    } catch {
      // A failed write may still have reached the program: say so, never "not sent".
      return wrote
        ? { state: 'sent-unconfirmed', sent: [] }
        : { state: 'refused', reason: 'gone' }
    } finally {
      // Once anything was sent the request stays claimed until it closes; a refusal frees it for a new tap.
      if (!wrote) this.claims.delete(request.requestId)
    }
  }

  /**
   * The answers waiting for this session's OpenCode plugin, consumed as they are returned. Waits up to
   * `waitMs` for one to arrive. Only the session's own live process can collect them.
   */
  async take(
    sessionId: string,
    incarnationId: string | null,
    waitMs: number,
    report?: PluginReport
  ): Promise<PluginAnswer[]> {
    if (incarnationId === null) return []
    if (report) this.pluginReported(sessionId, incarnationId, report)
    const collect = (): PluginAnswer[] => {
      const queue = this.deliveries.get(sessionId) ?? []
      const ready: Delivery[] = []
      for (const delivery of queue) {
        if (delivery.incarnationId !== incarnationId || delivery.taken) continue
        if (!delivery.valid()) {
          delivery.taken = true
          delivery.onDropped()
          continue
        }
        delivery.taken = true
        delivery.onTaken()
        this.handedOut.set(`${sessionId}\u0000${delivery.payload.requestRef}`, { requestId: delivery.requestId, incarnationId })
        ready.push(delivery)
      }
      const rest = queue.filter((delivery) => !delivery.taken)
      if (rest.length > 0) this.deliveries.set(sessionId, rest)
      else this.deliveries.delete(sessionId)
      return ready.map((delivery) => delivery.payload)
    }
    const now = collect()
    if (now.length > 0 || waitMs <= 0) return now
    await new Promise<void>((resolve) => {
      const takers = this.takers.get(sessionId) ?? new Set<() => void>()
      const wake = (): void => {
        clearTimeout(timer)
        takers.delete(wake)
        if (takers.size === 0) this.takers.delete(sessionId)
        resolve()
      }
      const timer = setTimeout(wake, waitMs)
      takers.add(wake)
      this.takers.set(sessionId, takers)
    })
    return collect()
  }

  /**
   * The plugin's own server accepted or rejected an answer it collected. Acceptance is OpenCode answering that
   * request by id (decision 4); a rejection means nothing was applied. Only the process that collected it may say.
   */
  private pluginReported(sessionId: string, incarnationId: string, report: PluginReport): void {
    const key = `${sessionId}\u0000${report.requestRef}`
    const handed = this.handedOut.get(key)
    if (!handed || handed.incarnationId !== incarnationId) return
    this.handedOut.delete(key)
    const pending = this.pending.get(handed.requestId)
    if (!pending) return
    if (report.delivered) {
      const outcome: AnswerOutcome = { state: 'confirmed', sent: pending.sent }
      if (pending.settled) for (const listener of this.lateListeners) listener(handed.requestId, outcome)
      pending.settle(outcome)
    } else {
      pending.settle({ state: 'refused', reason: 'gone' })
    }
    this.finishPending(handed.requestId)
  }

  dispose(): void {
    for (const watch of this.watches.values()) watch.unsubscribe()
    this.watches.clear()
    for (const requestId of [...this.pending.keys()]) this.finishPending(requestId)
    for (const takers of this.takers.values()) for (const wake of [...takers]) wake()
  }

  private async deliver(request: AnswerRequest, markWritten: () => void): Promise<AnswerOutcome> {
    const refused = (reason: AnswerRefusal): AnswerOutcome => ({ state: 'refused', reason })
    const record = await this.deps.getAttention(request.requestId)
    if (!record || record.state !== 'open') return refused('gone')
    if (record.incarnationId !== request.incarnationId ||
      this.deps.liveIncarnationId(record.sessionId) !== request.incarnationId) return refused('gone')
    if (record.revision !== request.revision || this.epochOf(record.requestId) !== request.epoch) return refused('changed')
    const prompt = record.prompt
    const route = answerRoute(prompt)
    if (!prompt || !route || !answerFits(prompt, request.answer)) return refused('unsupported')
    if (prompt.type === 'permission') {
      if (!(await this.deps.answerPermissions())) return refused('permissions-off')
      if (request.answer.type === 'permission' && request.answer.decision === 'deny' && !this.canDeny(record)) {
        return refused('unsupported')
      }
    }
    const current = (): boolean =>
      this.epochOf(record.requestId) === request.epoch &&
      this.deps.liveIncarnationId(record.sessionId) === request.incarnationId
    if (route === 'opencode-api') return this.deliverToPlugin(record, prompt, request, current, markWritten)
    // While BMN types, its own keys walk the dialog through its steps, and each step is verified on its own.
    this.typing.add(record.sessionId)
    try {
      return await this.deliverKeys(record, prompt, request, route === 'claude-keys' ? 'claude' : 'codex', current, markWritten)
    } finally {
      this.typing.delete(record.sessionId)
      this.watches.get(record.sessionId)?.check()
    }
  }

  private async deliverKeys(
    record: AttentionRecord,
    prompt: AttentionPrompt,
    request: AnswerRequest,
    harness: QuestionHarness,
    current: () => boolean,
    markWritten: () => void
  ): Promise<AnswerOutcome> {
    const screen = this.deps.screen(record.sessionId, request.incarnationId)
    if (!screen) return { state: 'refused', reason: 'gone' }
    await screen.settled()
    if (!current()) return { state: 'refused', reason: 'changed' }
    const sent = sentLabels(prompt, request.answer)
    const write = (digit: number): void => {
      markWritten()
      this.deps.write(record.sessionId, key(digit))
    }

    if (prompt.type === 'permission') {
      const dialog = claudePermissionOnScreen(screen.lines(), prompt.tool, prompt.command!, prompt.description ?? null)
      if (!dialog) return { state: 'refused', reason: 'not-on-screen' }
      if (request.answer.type !== 'permission') return { state: 'refused', reason: 'unsupported' }
      if (request.answer.decision === 'deny') {
        // Claude reports a deny through no hook at all, so it can only ever be sent, never confirmed.
        write(dialog.deny)
        return { state: 'sent-unconfirmed', sent }
      }
      const confirmation = this.expectConfirmation(record, prompt, request.answer, sent)
      write(dialog.allow)
      return confirmation
    }

    if (request.answer.type !== 'choices') return { state: 'refused', reason: 'unsupported' }
    const choices = request.answer.choices
    const count = prompt.questions.length
    const review = harness === 'claude' && count > 1
    let confirmation: Promise<AnswerOutcome> | undefined
    for (let index = 0; index < count; index += 1) {
      const question = prompt.questions[index]!
      const step = { index, count }
      const shown = (lines: string[]): boolean => questionOnScreen(lines, harness, question, step)
      if (index === 0) {
        if (!shown(screen.lines())) return { state: 'refused', reason: 'not-on-screen' }
      } else if (!(await this.waitForScreen(screen, (lines) => shown(lines) || null)) || !current()) {
        return { state: 'partial', sent: sent.slice(0, index), total: count }
      }
      // The last key submits the whole dialog, so the report it causes may arrive at once.
      if (index === count - 1 && !review) confirmation = this.expectConfirmation(record, prompt, request.answer, sent)
      write(choices[index]! + 1)
    }
    if (review) {
      const submit = await this.waitForScreen(screen, (lines) => claudeReviewOnScreen(lines, prompt.questions, sent))
      if (submit === null || !current()) return { state: 'partial', sent, total: count }
      confirmation = this.expectConfirmation(record, prompt, request.answer, sent)
      write(submit)
    }
    return confirmation!
  }

  private async deliverToPlugin(
    record: AttentionRecord,
    prompt: AttentionPrompt,
    request: AnswerRequest,
    current: () => boolean,
    markWritten: () => void
  ): Promise<AnswerOutcome> {
    if (prompt.requestRef === null) return { state: 'refused', reason: 'unsupported' }
    if (!current()) return { state: 'refused', reason: 'changed' }
    const answer = request.answer
    const payload: PluginAnswer = answer.type === 'permission'
      ? { requestRef: prompt.requestRef, kind: 'permission', reply: answer.decision === 'allow' ? 'once' : 'reject' }
      : { requestRef: prompt.requestRef, kind: 'question', answers: sentLabels(prompt, answer).map((label) => [label]) }
    const sent = sentLabels(prompt, answer)
    let taken!: () => void
    let dropped!: () => void
    const pickedUp = new Promise<'taken' | 'dropped' | 'late'>((resolve) => {
      taken = () => resolve('taken')
      dropped = () => resolve('dropped')
      setTimeout(() => resolve('late'), this.timing.pickupMs)
    })
    const delivery: Delivery = {
      requestId: record.requestId,
      sessionId: record.sessionId,
      incarnationId: request.incarnationId,
      payload,
      taken: false,
      onTaken: () => {
        // From here the answer may reach OpenCode; the claim holds until the request closes.
        markWritten()
        taken()
      },
      // OpenCode's reject denies every permission still waiting, so a Deny stays valid only while this
      // request is the session's one pending permission, up to the moment it is handed out.
      valid: () => this.tracked.has(record.requestId) &&
        (payload.kind !== 'permission' || payload.reply !== 'reject' || this.canDeny(record)),
      onDropped: () => dropped()
    }
    // The plugin's reply can reach the hook before `take` returns, so the report is awaited first.
    const confirmation = this.expectConfirmation(record, prompt, answer, sent)
    this.deliveries.set(record.sessionId, [...(this.deliveries.get(record.sessionId) ?? []), delivery])
    for (const wake of [...(this.takers.get(record.sessionId) ?? [])]) wake()
    const pickup = await pickedUp
    if (pickup !== 'taken') {
      this.dropDeliveries((candidate) => candidate === delivery)
      this.finishPending(record.requestId)
      return { state: 'refused', reason: pickup === 'dropped' ? 'changed' : 'not-delivered' }
    }
    return confirmation
  }

  /** Waits for an attributable report; `sent-unconfirmed` after `confirmMs`, upgradable for `lateMs`. */
  private expectConfirmation(
    record: AttentionRecord,
    prompt: AttentionPrompt,
    answer: RemoteAnswer,
    sent: string[]
  ): Promise<AnswerOutcome> {
    return new Promise((resolve) => {
      const pending: Pending = {
        record,
        prompt,
        answer,
        sent,
        settled: false,
        closed: false,
        settle: (outcome) => {
          if (pending.settled) return
          pending.settled = true
          resolve(outcome)
        },
        timers: []
      }
      pending.timers.push(setTimeout(() => pending.settle({ state: 'sent-unconfirmed', sent }), this.timing.confirmMs))
      pending.timers.push(setTimeout(() => this.finishPending(record.requestId), this.timing.lateMs))
      this.pending.set(record.requestId, pending)
    })
  }

  private finishPending(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    for (const timer of pending.timers) clearTimeout(timer)
    this.pending.delete(requestId)
    for (const [key, handed] of this.handedOut) if (handed.requestId === requestId) this.handedOut.delete(key)
    pending.settle({ state: 'sent-unconfirmed', sent: pending.sent })
  }

  /** Resolves with the predicate's value once the screen changes to show it, or null after `stepMs`. */
  private waitForScreen<T>(screen: ScreenLike, predicate: (lines: string[]) => T | null): Promise<T | null> {
    return new Promise((resolve) => {
      let done = false
      const finish = (value: T | null): void => {
        if (done) return
        done = true
        unsubscribe()
        clearTimeout(timer)
        resolve(value)
      }
      // Only a screen drawn after the key counts: the step before may read the same.
      const unsubscribe = screen.onChange(() => {
        void screen.settled().then(() => {
          const value = predicate(screen.lines())
          if (value !== null) finish(value)
        })
      })
      const timer = setTimeout(() => finish(null), this.timing.stepMs)
    })
  }

  private watch(sessionId: string, incarnationId: string): void {
    if (this.watches.has(sessionId)) return
    const screen = this.deps.screen(sessionId, incarnationId)
    if (!screen) return
    const watch: Watch = { unsubscribe: () => undefined, check: () => undefined }
    // Every change is read as it lands: a dialog that leaves and comes back between two samples is still over.
    const check = (): void => {
      if (this.typing.has(sessionId)) return
      const lines = screen.lines()
      for (const entry of this.tracked.values()) {
        if (entry.sessionId !== sessionId) continue
        const visible = dialogOnScreen(lines, entry.prompt)
        // A dialog that leaves the screen is over: whatever shows next is a different one.
        if (entry.visible && !visible) entry.epoch += 1
        entry.visible = visible
      }
    }
    watch.check = check
    watch.unsubscribe = screen.onChange(check)
    this.watches.set(sessionId, watch)
    void screen.settled().then(check)
  }

  private unwatchIdle(sessionId: string): void {
    for (const entry of this.tracked.values()) if (entry.sessionId === sessionId) return
    const watch = this.watches.get(sessionId)
    if (!watch) return
    watch.unsubscribe()
    this.watches.delete(sessionId)
  }

  private dropDeliveries(drop: (delivery: Delivery) => boolean): void {
    for (const [sessionId, queue] of this.deliveries) {
      const rest = queue.filter((delivery) => !drop(delivery))
      if (rest.length > 0) this.deliveries.set(sessionId, rest)
      else this.deliveries.delete(sessionId)
    }
  }
}

/** Whether the dialog of a keystroke-answered prompt is on screen, at any of its steps. */
export function dialogOnScreen(lines: readonly string[], prompt: AttentionPrompt): boolean {
  if (prompt.harness === 'opencode') return false
  if (prompt.type === 'permission') {
    return prompt.command !== null && claudePermissionOnScreen(lines, prompt.tool, prompt.command, prompt.description ?? null) !== null
  }
  const harness = prompt.harness
  if (prompt.questions.some((question) => questionOnScreen(lines, harness, question))) return true
  return harness === 'claude' && prompt.questions.length > 1 && claudeReviewOnScreen(lines, prompt.questions, null) !== null
}
