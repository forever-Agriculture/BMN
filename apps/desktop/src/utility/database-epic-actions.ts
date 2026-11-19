// MODULE: database-epic-actions.ts - owner choices, run bindings and counted uses, in worker transactions
import { createHash, randomUUID } from 'node:crypto'
import { grantStatus, openGrantPeriod, type EpicActionAnswer, type EpicActionAudit, type EpicActionCard, type EpicPlanContext,
  type EpicRunBinding, type GrantCommandTerm, type GrantRead, type GrantUseFile, type PlanAction } from '@bmn/protocol'
import type { DatabaseConnection } from './database-initialization'
import { planActionWords } from '../../bin/plan-actions.mjs'
import { getGrants, useGrantRecord, writeGrantRow } from './database-grant-store'

type StoredCard = Omit<EpicActionCard, 'binding'> & {
  approval: string
  actionsHash: string
  previousGo: string | null
  goAtAsk: string | null
  /** The one go this answer belongs to: the go in force when asked, or the first matching go recorded after a pre-go ask. */
  go: string | null
  /** Set once BMN saw the list change, the go withdrawn or another go recorded: he answers again (132.1 AC3). */
  void: boolean
}
interface EpicUse {
  id: string
  binding: string
  go: string
  action: string
  sessionId: string
  call: string | null
  targetHash: string
  at: string
}
export interface EpicActionRecord {
  version: 1
  planKey: string
  epic: number
  card: StoredCard | null
  priorCards: StoredCard[]
  binding: EpicRunBinding | null
  /** His Unbinds: the conversation, and (owner 2026-11-19T18:00Z) the agent process it ran in, by pid and start time. */
  revoked: { agent: string; conversation: string; go: string; foreground?: string }[]
  uses: EpicUse[]
  audit: EpicActionAudit[]
}

const PREFIX = 'epic-actions-v1:'
const key = (planKey: string, epic: number) => PREFIX + createHash('sha256').update(planKey).digest('hex') + ':' + epic
const empty = (planKey: string, epic: number): EpicActionRecord => ({
  version: 1, planKey, epic, card: null, priorCards: [], binding: null, revoked: [], uses: [], audit: []
})

function readRecord(raw: string): EpicActionRecord {
  const record = JSON.parse(raw) as EpicActionRecord
  if (record.version !== 1 || typeof record.planKey !== 'string' || !Number.isSafeInteger(record.epic) ||
    !Array.isArray(record.uses) || !Array.isArray(record.revoked) || !Array.isArray(record.priorCards) ||
    !Array.isArray(record.audit) || record.card &&
    (!Array.isArray(record.card.actions) || !record.card.answers || typeof record.card.actionsHash !== 'string' ||
      typeof record.card.void !== 'boolean' || record.card.go !== null && typeof record.card.go !== 'string')) {
    throw new Error('Epic actions could not be read')
  }
  return record
}

function load(database: DatabaseConnection, planKey: string, epic: number): EpicActionRecord {
  const row = database.prepare('SELECT value_json FROM app_setting WHERE key = ?')
    .get(key(planKey, epic)) as { value_json: string } | undefined
  if (!row) return empty(planKey, epic)
  const record = readRecord(row.value_json)
  if (record.planKey !== planKey || record.epic !== epic) throw new Error('Epic actions belong to a different plan')
  return record
}

function save(database: DatabaseConnection, record: EpicActionRecord, now: string): void {
  database.prepare(`INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .run(key(record.planKey, record.epic), JSON.stringify(record), now)
}

export function epicActionRecord(database: DatabaseConnection, context: Pick<EpicPlanContext, 'planKey' | 'epic'>) {
  return load(database, context.planKey, context.epic)
}

export function listEpicActionRecords(database: DatabaseConnection): EpicActionRecord[] {
  return (database.prepare('SELECT value_json FROM app_setting WHERE key LIKE ? ORDER BY updated_at DESC')
    .all(PREFIX + '%') as { value_json: string }[]).map(row => readRecord(row.value_json))
}

/**
 * D6's lifetime, kept in the record: an answer belongs to one go. Asked under a go, it is that go's. Asked before a go, it
 * attaches once to the first go recorded after it, and only if that go names the same approval text and list. A changed
 * list, a withdrawn or later go, or changed text before the go voids it for good; restoring the old state does not bring
 * the old Yes back. True when the record changed and must be saved.
 */
export function settleEpicCard(record: EpicActionRecord, plan: EpicPlanContext): boolean {
  const card = record.card
  if (!card || card.void) return false
  const end = () => { card.void = true; return true }
  if (card.actionsHash !== plan.actionsHash) return end()
  if (card.go !== null) return plan.previousGo !== card.go || plan.withdrawn ? end() : false
  if (plan.previousGo === card.previousGo) return plan.approval !== card.approval ? end() : false
  if (plan.previousGo !== null && !plan.withdrawn && plan.precedingGo === card.previousGo &&
    plan.goApproval === card.approval && plan.goActionsHash === card.actionsHash) {
    card.go = plan.previousGo
    return true
  }
  return end()
}

/** The card whose answers count now (its go is in force), or the open card of an epic that has no go yet. */
export function matchingEpicCard(record: EpicActionRecord, plan: EpicPlanContext): StoredCard | null {
  const card = record.card
  if (!card || card.void || card.actionsHash !== plan.actionsHash) return null
  if (card.go !== null) return plan.go === card.go && plan.activeApproval !== null ? card : null
  return plan.go === null && plan.previousGo === card.previousGo && plan.approval === card.approval ? card : null
}

/** The record as it stands for this plan now, with any ended or attached answer saved first. */
export function settledEpicActionRecord(database: DatabaseConnection, plan: EpicPlanContext, now: string): EpicActionRecord {
  const record = load(database, plan.planKey, plan.epic)
  if (settleEpicCard(record, plan)) save(database, record, now)
  return record
}

export function askEpicActionCard(database: DatabaseConnection, plan: EpicPlanContext, now: string): StoredCard {
  const record = settledEpicActionRecord(database, plan, now)
  const existing = matchingEpicCard(record, plan)
  if (existing) return existing
  const card: StoredCard = {
    id: randomUUID(), epic: plan.epic, project: plan.project, requestedAt: now, revision: 1,
    approval: plan.approval, actionsHash: plan.actionsHash, previousGo: plan.previousGo, goAtAsk: plan.go, go: plan.go, void: false,
    actions: plan.actions.map(action => ({ id: action.id, words: planActionWords(action) })), answers: {}
  }
  if (record.card) record.priorCards.push(record.card)
  record.card = card
  save(database, record, now)
  return card
}

export function answerEpicActionCard(database: DatabaseConnection, plan: EpicPlanContext, answer: EpicActionAnswer,
  via: 'app' | 'telegram', now: string, rule: string | null = null): StoredCard {
  const record = settledEpicActionRecord(database, plan, now)
  const card = matchingEpicCard(record, plan)
  if (!card || card.id !== answer.card || !card.actions.some(action => action.id === answer.action)) throw new Error('The actions changed. Open the current card.')
  const before = card.answers[answer.action]
  if (before?.choice === answer.choice && (answer.choice === 'no' || (before.rule ?? null) === rule)) return card
  if (card.revision !== answer.revision) throw new Error('The actions changed. Open the current card.')
  // A Yes keeps the deploy rule he saw with it (D3): under another rule it is not his answer any more.
  card.answers[answer.action] = { choice: answer.choice, at: now, via, ...(answer.choice === 'yes' && rule !== null ? { rule } : {}) }
  card.revision += 1
  save(database, record, now)
  return card
}

function processIsLive(database: DatabaseConnection, binding: Pick<EpicRunBinding, 'sessionId' | 'incarnationId'>): boolean {
  return database.prepare('SELECT 1 FROM process_incarnation WHERE session_id = ? AND incarnation_id = ? AND state = ?')
    .get(binding.sessionId, binding.incarnationId, 'running') !== undefined
}

export function bindEpicRun(database: DatabaseConnection, plan: EpicPlanContext, binding: EpicRunBinding,
  observedHolder: string | null, holderCurrent: boolean): EpicRunBinding {
  const record = load(database, plan.planKey, plan.epic)
  if (!plan.go || plan.go !== binding.go || !processIsLive(database, binding)) throw new Error('The go or the running process could not be confirmed')
  // The unbound conversation stays out of this go in any process, and (owner 2026-11-19T18:00Z) so does every conversation
  // of the agent process it ran in: BMN cannot tell a real /clear from a made-up report inside that process.
  if (record.revoked.some(item => item.go === binding.go && item.agent === binding.agent && item.conversation === binding.conversation)) {
    throw new Error('The owner unbound this conversation from this go')
  }
  if (record.revoked.some(item => item.go === binding.go && item.foreground !== undefined && item.foreground === binding.foreground)) {
    throw new Error('The owner unbound this agent from this go; close the agent and start it again to bind')
  }
  const before = record.binding
  if (before && before.sessionId === binding.sessionId && before.generation === binding.generation && before.go === binding.go) return before
  if (before && before.go === plan.go && processIsLive(database, before) && (observedHolder !== before.id || holderCurrent)) {
    throw new Error('This epic already has a live bound session')
  }
  record.binding = binding
  save(database, record, binding.at)
  return binding
}

export function revokeEpicRun(database: DatabaseConnection, plan: EpicPlanContext, bindingId: string, now: string): boolean {
  const record = load(database, plan.planKey, plan.epic)
  const binding = record.binding
  if (!binding || binding.id !== bindingId) return false
  record.revoked.push({ agent: binding.agent, conversation: binding.conversation, go: binding.go, foreground: binding.foreground })
  record.binding = null
  save(database, record, now)
  return true
}

export function epicActionRemaining(record: EpicActionRecord, go: string, action: PlanAction): number {
  return Math.max(0, action.count - record.uses.filter(use => use.go === go && use.action === action.id).length)
}

export function reserveEpicAction(database: DatabaseConnection, plan: EpicPlanContext, binding: EpicRunBinding,
  input: { action: string; id: string; targetHash: string; commandHash?: string; call: string | null; mayReserve: boolean; receipt?: string; rule?: string | null }, now: string) {
  const record = settledEpicActionRecord(database, plan, now)
  if (record.binding?.id !== binding.id || binding.go !== plan.go || !processIsLive(database, binding)) throw new Error('No current bound run')
  const card = matchingEpicCard(record, plan)
  const action = plan.actions.find(action => action.id === input.action)
  if (!plan.activeApproval || !action || card?.go !== binding.go || card.answers[action.id]?.choice !== 'yes' ||
    (card.answers[action.id]?.rule ?? null) !== (input.rule ?? null)) {
    throw new Error('This exact action has no current owner approval')
  }
  if (input.receipt !== undefined && input.receipt !== input.id) throw new Error('No matching action reservation')
  if (input.call !== null && record.audit.some(row => row.bindingId === binding.id && row.call === input.call && row.source !== 'file')) {
    throw new Error('The tool call already belongs to another operation')
  }
  const own = record.uses.filter(use => use.binding === binding.id)
  const called = input.call === null ? undefined : own.find(use => use.call === input.call)
  const previous = called ?? own.find(use => use.id === input.id &&
    (input.call === null || use.call !== null || input.receipt === undefined))
  if (previous) {
    if (previous.action !== action.id || previous.targetHash !== input.targetHash ||
      input.call !== null && previous.call !== input.call) throw new Error('The operation is already bound to another use')
    return { ...previous, repeated: true as const }
  }
  if (input.call !== null) {
    const pending = own.filter(use => use.action === action.id && use.targetHash === input.targetHash && use.call === null &&
      (input.receipt === undefined || use.id === input.receipt))
    if (pending.length > 1) throw new Error('The action has ambiguous reservations')
    if (pending.length === 1) {
      const use = pending[0]!
      use.call = input.call
      if (input.commandHash) {
        const row = fileAudit(record, binding, use.id)
        if (row) {
          row.at = now
          row.outcome = 'unreported'
          row.call = input.call
        } else record.audit.push({ ...audit(plan, binding, action.id, now, input.commandHash, 'file'),
          receipt: use.id, bindingId: binding.id, outcome: 'unreported', call: input.call })
      }
      save(database, record, now)
      return use
    }
  }
  if (!input.mayReserve) throw new Error('No matching action reservation')
  if (epicActionRemaining(record, binding.go, action) < 1) throw new Error('The action has no uses left')
  const use = { id: input.id, binding: binding.id, go: binding.go, action: action.id, sessionId: binding.sessionId,
    call: input.call, targetHash: input.targetHash, at: now }
  record.uses.push(use)
  if (input.commandHash) {
    record.audit.push({ ...audit(plan, binding, action.id, now, input.commandHash, 'file'),
      receipt: use.id, bindingId: binding.id, outcome: input.call === null ? 'reserved' : 'unreported',
      ...(input.call === null ? {} : { call: input.call }) })
  }
  save(database, record, now)
  return use
}

/**
 * The decision already made for one tool call of this binding, from either source (D9): a retry of the same event gets it
 * back whatever the night or the file say now, and never a second use. A call first seen for another command is refused.
 */
export function epicCallDecision(database: DatabaseConnection, plan: EpicPlanContext, binding: EpicRunBinding,
  call: string, commandHash: string): EpicActionAudit['source'] | null {
  const record = load(database, plan.planKey, plan.epic)
  const row = record.audit.find(row => row.bindingId === binding.id && row.call === call)
  if (!row) return null
  if (row.commandHash !== commandHash) throw new Error('The tool call already belongs to another operation')
  if (row.outcome === 'withheld') throw new Error('BMN withheld this tool call at its last check; the use stays spent')
  return row.source
}

/** Where the authority behind one use comes from: his Yes on the file's action, or a night term of this period. */
export type EpicAuthority = { kind: 'file'; action: string; rule: string | null } | { kind: 'night'; runId: string; item: string; targetHash: string }

/**
 * D4/D9 at the decision's edge: the bound run, its go and his answer, or the night period and its exact term, still stand.
 * Null when they do; otherwise why not. Read right before BMN answers `allowed`, after the use was taken.
 */
export function epicAuthorityProblem(database: DatabaseConnection, plan: EpicPlanContext, binding: EpicRunBinding,
  source: EpicAuthority, now: string): string | null {
  const record = settledEpicActionRecord(database, plan, now)
  if (record.binding?.id !== binding.id || binding.go !== plan.go || !processIsLive(database, binding)) return 'The bound run ended before the action'
  if (source.kind === 'file') {
    const card = matchingEpicCard(record, plan)
    const answer = card?.answers[source.action]
    return !plan.activeApproval || card?.go !== binding.go || answer?.choice !== 'yes' || (answer.rule ?? null) !== source.rule
      ? 'His approval of this action ended before the action' : null
  }
  const { read, away } = getGrants(database)
  if (read.state !== 'read') return 'The night grant could not be read'
  const status = grantStatus(read, away, source.runId)
  const period = openGrantPeriod(read.record)
  if (!status.active || !period || period.runs.find(run => run.runId === source.runId)?.card.sessionId !== binding.sessionId) {
    return 'The night grant ended before the action'
  }
  const term = status.grant.items.find(item => item.term.id === source.item)?.term
  return term?.kind !== 'command' || nightCommandHash(term) !== source.targetHash || !nightBoundTo(term, plan, binding)
    ? 'The night action changed before the action' : null
}

function fileAudit(record: EpicActionRecord, binding: EpicRunBinding, receipt: string): EpicActionAudit | undefined {
  return record.audit.find(row => row.source === 'file' && row.bindingId === binding.id && row.receipt === receipt)
}

export function recordEpicActionOutcome(database: DatabaseConnection, plan: EpicPlanContext, binding: EpicRunBinding,
  call: string, outcome: 'returned' | 'failed' | 'withheld', now: string): boolean {
  const record = load(database, plan.planKey, plan.epic)
  const row = record.audit.find(row => row.bindingId === binding.id && row.call === call)
  // A result replaces "unreported" once. BMN's own refusal at the last check also replaces a bare reservation.
  if (!row || row.outcome !== 'unreported' && !(outcome === 'withheld' && row.outcome === 'reserved')) return row?.outcome === outcome
  row.outcome = outcome
  save(database, record, now)
  return true
}

function audit(plan: EpicPlanContext, binding: EpicRunBinding, action: string, at: string,
  commandHash: string, source: EpicActionAudit['source']): EpicActionAudit {
  return { epic: plan.epic, action, sessionId: binding.sessionId, go: binding.go, at, commandHash, source }
}

export function epicActionsDuring(database: DatabaseConnection, since: string, until: string): EpicActionAudit[] {
  return listEpicActionRecords(database).flatMap(record => record.audit.filter(row => row.at >= since && row.at <= until))
    .sort((a, b) => a.at.localeCompare(b.at))
}

function assertStoredBinding(database: DatabaseConnection, plan: EpicPlanContext, binding: EpicRunBinding): void {
  const record = load(database, plan.planKey, plan.epic)
  if (record.binding?.id !== binding.id || plan.go !== binding.go || !processIsLive(database, binding)) {
    throw new Error('No current bound run')
  }
}

export function nightCommandHash(term: GrantCommandTerm): string {
  return createHash('sha256').update(JSON.stringify([term.command, term.folder, term.repository, term.ref, term.script,
    term.bound?.plan ?? null, term.bound?.epic ?? null, term.bound?.go ?? null, term.bound?.session ?? null])).digest('hex')
}

/** A held night command belongs to the plan, epic, go and session of the bound run that asked for it, as he answered it. */
export function nightBoundTo(term: GrantCommandTerm, plan: Pick<EpicPlanContext, 'planKey' | 'epic'>, binding: Pick<EpicRunBinding, 'go' | 'sessionId'>): boolean {
  return term.bound !== undefined && term.bound.plan === plan.planKey && term.bound.epic === plan.epic && term.bound.go === binding.go &&
    term.bound.session === binding.sessionId
}

export function reserveNightEpicCommand(database: DatabaseConnection, plan: EpicPlanContext, binding: EpicRunBinding,
  input: { runId: string; item: string; id: string; targetHash: string; file?: GrantUseFile }, now: string) {
  assertStoredBinding(database, plan, binding)
  const { read, away } = getGrants(database)
  const status = grantStatus(read, away, input.runId)
  const period = read.state === 'read' ? openGrantPeriod(read.record) : null
  if (!status.active || !period || period.runs.find(run => run.runId === input.runId)?.card.sessionId !== binding.sessionId) {
    throw new Error('The night grant expired or belongs to another session')
  }
  const term = status.grant.items.find(item => item.term.id === input.item)?.term
  if (term?.kind !== 'command' || !term.repository || nightCommandHash(term) !== input.targetHash) {
    throw new Error('The night action changed before reservation')
  }
  if (!nightBoundTo(term, plan, binding)) throw new Error('The night command was approved for another epic or go')
  const prior = period.uses.find(use => use.runId === input.runId && use.id === input.id)
  if (prior && (prior.dispatch?.binding !== binding.id || prior.dispatch?.targetHash !== input.targetHash)) {
    throw new Error('The use id belongs to another reservation')
  }
  const outcome = useGrantRecord(database, {
    kind: 'action', runId: input.runId, item: input.item, id: input.id, sessionId: binding.sessionId,
    ...(input.file ? { file: input.file } : {})
  }, now)
  if (outcome.outcome !== 'recorded') return outcome
  const use = openGrantPeriod(outcome.record)?.uses.find(use => use.runId === input.runId && use.id === input.id)
  if (!use) throw new Error('The reservation could not be read back')
  use.dispatch = { binding: binding.id, targetHash: input.targetHash, call: null }
  return { ...outcome, read: writeGrantRow(database, outcome.record, now) }
}

type NightCall = { command: string; folder: string; call: string }
type NightEntry = { runId: string; item: string; targetHash: string; term: GrantCommandTerm }
type NightChoice =
  | { kind: 'none' }
  | { kind: 'repeat' | 'one'; entry: NightEntry; use: NonNullable<ReturnType<typeof openGrantPeriod>>['uses'][number] }

/**
 * Which night receipt this tool call would spend, read from the grant record itself (S7): every approved night term of the
 * bound session naming the exact command and folder is a candidate, whatever the service saw. No receipt waiting leaves the
 * call to a file reservation; one waiting is the choice; two waiting hold it, whichever pins match the file now.
 */
function nightChoice(database: DatabaseConnection, plan: EpicPlanContext, binding: EpicRunBinding, input: NightCall): NightChoice & { read: GrantRead } {
  const { read, away } = getGrants(database)
  if (read.state !== 'read') throw new Error('The night grant could not be read')
  const period = openGrantPeriod(read.record)
  if (!period) return { kind: 'none', read }
  const entries = period.runs.flatMap(run => {
    if (run.card.sessionId !== binding.sessionId) return []
    const status = grantStatus(read, away, run.runId)
    if (!status.active) return []
    return status.grant.items.flatMap(({ term }) => term.kind === 'command' && term.repository !== undefined &&
      term.command === input.command && term.folder === input.folder && nightBoundTo(term, plan, binding)
      ? [{ entry: { runId: run.runId, item: term.id, targetHash: nightCommandHash(term), term }, revision: status.grant.cardRevision }] : [])
  })
  const uses = entries.flatMap(({ entry, revision }) => period.uses.filter(use => use.runId === entry.runId && use.item === entry.item &&
    use.cardRevision === revision && use.dispatch?.binding === binding.id && use.dispatch.targetHash === entry.targetHash).map(use => ({ entry, use })))
  // One decision per call (D9): what this call was first given, a night receipt of this period or a file use, is all it gets.
  const record = load(database, plan.planKey, plan.epic)
  const decided = record.audit.find(row => row.bindingId === binding.id && row.call === input.call)
  const repeated = uses.find(({ use }) => use.dispatch?.call === input.call)
  if (decided && (decided.source !== 'night' || repeated?.use.id !== decided.receipt)) {
    throw new Error(decided.source === 'night' ? 'The night approval this tool call used is no longer in force' : 'The tool call already belongs to another operation')
  }
  if (repeated) return { kind: 'repeat', ...repeated, read }
  if (period.uses.some(use => use.dispatch?.binding === binding.id && use.dispatch.call === input.call)) {
    throw new Error('The tool call already belongs to another operation')
  }
  const pending = uses.filter(({ use }) => use.dispatch?.call === null)
  if (pending.length === 0) return { kind: 'none', read }
  if (pending.length !== 1) throw new Error('More than one night reservation waits for this exact command')
  return { kind: 'one', ...pending[0]!, read }
}

/** Read only: the night receipt a held tool call would spend, so the service checks that approval's own target and pin. */
export function selectNightEpicCommand(database: DatabaseConnection, plan: EpicPlanContext, binding: EpicRunBinding, input: NightCall) {
  assertStoredBinding(database, plan, binding)
  const choice = nightChoice(database, plan, binding, input)
  return choice.kind === 'none' ? null : { kind: choice.kind, ...choice.entry, useId: choice.use.id }
}

/**
 * Claims the night receipt that pays for one held tool call. `expect` is the receipt the service selected and checked: the
 * call is attached only while that receipt is still the sole one waiting for it (S7), so a receipt added or swapped between
 * the check and this transaction holds the call instead.
 */
export function claimNightEpicCommand(database: DatabaseConnection, plan: EpicPlanContext, binding: EpicRunBinding,
  input: NightCall & { expect?: { useId: string; runId: string; item: string; targetHash: string } }, now: string) {
  assertStoredBinding(database, plan, binding)
  const choice = nightChoice(database, plan, binding, input)
  if (choice.kind === 'none') {
    if (input.expect) throw new Error('The night reservation changed before the claim')
    return null
  }
  const { entry, use } = choice
  const expect = input.expect
  if (expect && (expect.useId !== use.id || expect.runId !== entry.runId || expect.item !== entry.item || expect.targetHash !== entry.targetHash)) {
    throw new Error('The night reservation changed before the claim')
  }
  if (choice.kind === 'repeat') return { use, read: null, runId: entry.runId, item: entry.item, targetHash: entry.targetHash, term: entry.term }
  const record = load(database, plan.planKey, plan.epic)
  const fileAction = plan.actions.find(action => action.kind === 'command' && action.command === entry.term.command && action.folder === entry.term.folder)
  if (fileAction && record.uses.some(use => use.binding === binding.id && use.action === fileAction.id && use.call === null)) {
    throw new Error('Both sources have a pending reservation')
  }
  use.dispatch!.call = input.call
  if (choice.read.state !== 'read') throw new Error('The night grant could not be read')
  // The written row goes back to the caller, so the window's night view shows the call, as a reservation's does.
  const written = writeGrantRow(database, choice.read.record, now)
  record.audit.push({ ...audit(plan, binding, entry.item, now, createHash('sha256').update(entry.term.command).digest('hex'), 'night'),
    receipt: use.id, bindingId: binding.id, call: input.call, outcome: 'unreported' })
  save(database, record, now)
  return { use, read: written, runId: entry.runId, item: entry.item, targetHash: entry.targetHash, term: entry.term }
}

export const EPIC_ACTION_OPERATIONS = Object.freeze({
  epicActionRecord, listEpicActionRecords, askEpicActionCard, answerEpicActionCard, bindEpicRun, revokeEpicRun, reserveEpicAction,
  reserveNightEpicCommand, selectNightEpicCommand, claimNightEpicCommand, epicActionsDuring, recordEpicActionOutcome, epicCallDecision,
  settledEpicActionRecord, epicAuthorityProblem
})
