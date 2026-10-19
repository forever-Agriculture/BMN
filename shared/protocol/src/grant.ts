// MODULE: grant.ts - the Away grant: one versioned record of each departure's cards, the owner's answers and their uses, and its change rules (Epic 84)
import { awayMomentWords, type AwayRecord, type AwaySource } from './away'
import { pushPolicyRepository } from './push-policy'

/**
 * The raw setting that holds every grant (Epic 84, Decisions "schema"): its own `app_setting` row beside `owner-away-v1`,
 * which keeps its shape. A missing row is no grant; a row that cannot be read is no grant, with the reason.
 */
export const GRANT_RECORD_KEY = 'night-grant-v1'

/** Bounds: text is refused past them, never cut; lists keep their newest entries. */
export const GRANT_LIMITS = Object.freeze({
  runId: 120, title: 120, scope: 300, reason: 300, terms: 8, itemId: 40, runs: 32, told: 64, uses: 500, operations: 500,
  boundary: 120, useId: 120, count: 10, periods: 2, reports: 500, carried: 200
})

/** The extra repair rounds a card may offer per boundary (owner 2026-10-18: "2-4 by default"); 0 is No. */
export const GRANT_ROUND_CHOICES: readonly number[] = Object.freeze([0, 2, 3, 4])

/**
 * The fixed list of actions a card may name (R84-FR8). Anything else is never on a card: what Epic 83's guard holds
 * (force pushes, deletions, releases, publishes, killing BMN), credentials and acceptance changes wait always.
 */
export type GrantActionKind = 'merge' | 'push-default' | 'pr-elsewhere'
export const GRANT_ACTION_KINDS: readonly GrantActionKind[] = Object.freeze(['merge', 'push-default', 'pr-elsewhere'])
export const GRANT_NEVER_ON_A_CARD = 'force pushes, deletions, releases, publishes, killing BMN, credentials and acceptance changes'

export interface GrantRoundsTerm { id: 'rounds'; kind: 'rounds'; proposed: number; reason: string }
export interface GrantMergeTerm {
  id: string; kind: 'merge'; repository: string; pr: number
  /** "this PR at head SHA X" is offered only with a SHA; "up to N of this run's PRs when green" only with upTo. */
  headSha: string | null; upTo: number | null
  proposed: 'no' | 'pr' | 'green'; reason: string
}
export interface GrantPushTerm { id: string; kind: 'push-default'; repository: string; branch: string; count: number; proposed: 'no' | 'yes'; reason: string }
/** Its target is the PR's branch, the PR, or both (R84-FR8: "repository and PR or branch"). */
export interface GrantPrTerm { id: string; kind: 'pr-elsewhere'; repository: string; branch: string | null; pr: number | null; count: number; proposed: 'no' | 'yes'; reason: string }
export type GrantTerm = GrantRoundsTerm | GrantMergeTerm | GrantPushTerm | GrantPrTerm
export type GrantActionTerm = Exclude<GrantTerm, GrantRoundsTerm>

/** What the owner picked for one term: a round count, or a merge's 'no' | 'pr' | 'green', or 'no' | 'yes'. */
export type GrantChoice = number | 'no' | 'pr' | 'green' | 'yes'

export type GrantCardState = 'open' | 'answered' | 'nothing' | 'withdrawn'
export type GrantAnswerSource = 'app' | 'telegram'

export interface GrantCard {
  /** Per run, from 1; a second ask for the same run is a new revision. */
  revision: number
  askedAt: string
  /** The session that asked, bound by BMN, never the caller's word; null for the owner's own CLI. */
  sessionId: string | null
  agentCli: string | null
  scope: string
  /** "Nothing needed" (owner card, the notes' question 2): the run says so instead of asking. */
  nothing: boolean
  terms: GrantTerm[]
  state: GrantCardState
  /** For a revision after the first: what changed, in the notes' words ("rounds 3 → 4", "merge PR 12 added"). */
  change: string | null
  withdrawnFor: 'back' | 'not-leaving' | null
}

export interface GrantAnswer {
  cardRevision: number
  /** The terms as he saw them: the answer is bound to them, so a newer revision cannot change what it granted. */
  terms: GrantTerm[]
  choices: Record<string, GrantChoice>
  at: string
  via: GrantAnswerSource
  operationKey: string
}

export interface GrantRun {
  runId: string
  title: string
  /** The latest card; an earlier revision's answer stays in force until he answers this one (the notes' question 3). */
  card: GrantCard
  answer: GrantAnswer | null
  /** The phone message drawing this run's card, once sent. */
  phone: { messageId: number; cardRevision: number } | null
}

/** One use of a grant, recorded before the step it pays for; idempotent by its id (Decisions "schema"). */
export interface GrantUse {
  id: string
  runId: string
  sessionId: string
  kind: 'round' | 'action'
  boundary: string | null
  item: string | null
  at: string
}

/** A refusal BMN made, kept for the morning (R84-FR6, "what was refused"). */
export interface GrantRefusal {
  runId: string
  kind: 'round' | 'action' | 'answer'
  boundary: string | null
  item: string | null
  reason: string
  at: string
}

/** What an agent may report of a round (passed, failed, parked BLOCKED, uncertain) or of an action (done, uncertain, refused). */
export type GrantReportResult = 'passed' | 'failed' | 'blocked' | 'done' | 'uncertain' | 'refused'
export const GRANT_ROUND_RESULTS: readonly GrantReportResult[] = Object.freeze(['passed', 'failed', 'blocked', 'uncertain'])
export const GRANT_ACTION_RESULTS: readonly GrantReportResult[] = Object.freeze(['done', 'uncertain', 'refused'])

/**
 * What an agent told BMN about the world, kept apart from BMN's own record (Story 84.7, the notes §4 "the agent's report"):
 * the outcome of a recorded use, the step-back consult's option before a boundary's last round, or a step GitHub, Epic 83's
 * guard or a rule refused before any use.
 */
export interface GrantReport {
  runId: string
  sessionId: string
  kind: 'outcome' | 'step-back' | 'refused'
  useId: string | null
  boundary: string | null
  item: string | null
  result: GrantReportResult | null
  text: string | null
  at: string
}

export type GrantPeriodState = 'leaving' | 'away' | 'ended' | 'cancelled'

export interface GrantPeriod {
  periodId: string
  state: GrantPeriodState
  startedAt: string
  startedBy: AwaySource
  /** The agent's session that forwarded his departure words. */
  agentSessionId: string | null
  awayAt: string | null
  endedAt: string | null
  endedBy: AwaySource | null
  /** Sessions handed the departure notice, for "told Builder and Night". */
  told: string[]
  runs: GrantRun[]
  uses: GrantUse[]
  refusals: GrantRefusal[]
  reports: GrantReport[]
}

/** A boundary's rounds from periods no longer kept, so they still count (R84-FR3: across Away periods). */
export interface GrantCarried { runId: string; boundary: string; rounds: number }

export interface GrantRecord {
  version: 1
  revision: number
  /** The current period last; at most the current and the previous one are kept. */
  periods: GrantPeriod[]
  /** Rounds per run and boundary from the periods dropped before these, newest last. */
  carried: GrantCarried[]
  operations: Array<{ key: string; revision: number; unchanged?: true }>
}

export const EMPTY_GRANT_RECORD: GrantRecord = Object.freeze({ version: 1, revision: 0, periods: [], carried: [], operations: [] }) as GrantRecord

export type GrantRead = { state: 'read'; record: GrantRecord } | { state: 'unknown'; reason: string }

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const SHA = /^[0-9a-f]{7,40}$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/
const isText = (value: unknown): value is string => typeof value === 'string'
const isIso = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value))
const isCount = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max

/** A run id, use id, boundary or item id: a plain identifier within its limit, or null. */
export function grantIdentifier(value: unknown, limit: number): string | null {
  return isText(value) && value.length <= limit && IDENTIFIER.test(value) && !value.includes('..') ? value : null
}

/** One line of the agent's words: plain text within its limit, controls refused; null when it is not. */
function grantWords(value: unknown, limit: number, empty = false): string | null {
  if (!isText(value)) return null
  const text = value.trim()
  if ((!empty && text === '') || [...text].length > limit || CONTROLS.test(text)) return null
  return text
}

export interface GrantCardInput {
  title: string
  scope: string
  nothing?: boolean
  terms?: unknown[]
}

/** The terms an agent proposed, checked against the fixed list, or why not. Never-on-a-card kinds are refused by name. */
export function parseGrantTerms(raw: unknown): { terms: GrantTerm[] } | { problem: string } {
  if (!Array.isArray(raw)) return { problem: 'terms must be a list' }
  if (raw.length > GRANT_LIMITS.terms) return { problem: `a card holds at most ${GRANT_LIMITS.terms} terms` }
  const terms: GrantTerm[] = []
  for (const [index, item] of raw.entries()) {
    const where = `term ${index + 1}`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { problem: `${where} must be an object` }
    const term = item as Record<string, unknown>
    const reason = grantWords(term.reason, GRANT_LIMITS.reason)
    if (reason === null) return { problem: `${where} needs a reason of at most ${GRANT_LIMITS.reason} characters, plain text` }
    if (term.kind === 'rounds') {
      if (terms.some((other) => other.kind === 'rounds')) return { problem: 'a card asks for rounds once' }
      if (!GRANT_ROUND_CHOICES.includes(term.proposed as number) || term.proposed === 0) return { problem: `${where}: rounds proposes 2, 3 or 4` }
      terms.push({ id: 'rounds', kind: 'rounds', proposed: term.proposed as number, reason })
      continue
    }
    if (!GRANT_ACTION_KINDS.includes(term.kind as GrantActionKind)) {
      return { problem: `${where}: "${String(term.kind).slice(0, 40)}" is not a kind a card may name (${GRANT_ACTION_KINDS.join(', ')}); ${GRANT_NEVER_ON_A_CARD} are never on a card` }
    }
    const id = term.id === undefined ? `item-${terms.filter((other) => other.kind !== 'rounds').length + 1}` : grantIdentifier(term.id, GRANT_LIMITS.itemId)
    if (id === null || id === 'rounds' || terms.some((other) => other.id === id)) return { problem: `${where}: id must be a unique identifier of at most ${GRANT_LIMITS.itemId} characters` }
    const repository = pushPolicyRepository(term.repository)
    if (repository === null) return { problem: `${where}: repository must be OWNER/NAME on GitHub` }
    if (term.kind === 'merge') {
      if (!Number.isSafeInteger(term.pr) || (term.pr as number) < 1) return { problem: `${where}: pr must be the pull request's number` }
      const headSha = term.headSha === undefined || term.headSha === null ? null : isText(term.headSha) && SHA.test(term.headSha.toLowerCase()) ? term.headSha.toLowerCase() : undefined
      if (headSha === undefined) return { problem: `${where}: headSha must be 7 to 40 hexadecimal characters` }
      const upTo = term.upTo === undefined || term.upTo === null ? null : isCount(term.upTo, GRANT_LIMITS.count) ? term.upTo : undefined
      if (upTo === undefined) return { problem: `${where}: upTo must be 1 to ${GRANT_LIMITS.count}` }
      if (headSha === null && upTo === null) return { problem: `${where}: a merge offers "this PR at headSha" or "up to N when green", or both` }
      const proposed = term.proposed
      if (proposed !== 'no' && !(proposed === 'pr' && headSha !== null) && !(proposed === 'green' && upTo !== null)) {
        return { problem: `${where}: proposed must be one of the choices the term offers (no${headSha === null ? '' : ', pr'}${upTo === null ? '' : ', green'})` }
      }
      terms.push({ id, kind: 'merge', repository, pr: term.pr as number, headSha, upTo, proposed, reason })
      continue
    }
    const count = term.count === undefined ? 1 : isCount(term.count, GRANT_LIMITS.count) ? term.count : null
    if (count === null) return { problem: `${where}: count must be 1 to ${GRANT_LIMITS.count}` }
    if (term.proposed !== 'no' && term.proposed !== 'yes') return { problem: `${where}: proposed must be no or yes` }
    const isBranch = (value: unknown): value is string => isText(value) && BRANCH.test(value) && !value.includes('..')
    if (term.kind === 'push-default') {
      if (!isBranch(term.branch)) return { problem: `${where}: branch must be the branch to push` }
      terms.push({ id, kind: 'push-default', repository, branch: term.branch, count, proposed: term.proposed, reason })
    } else {
      const branch = term.branch === undefined || term.branch === null ? null : isBranch(term.branch) ? term.branch : undefined
      if (branch === undefined) return { problem: `${where}: branch must be the PR's branch` }
      const pr = term.pr === undefined || term.pr === null ? null : Number.isSafeInteger(term.pr) && (term.pr as number) >= 1 ? term.pr as number : undefined
      if (pr === undefined) return { problem: `${where}: pr must be the pull request's number` }
      if (branch === null && pr === null) return { problem: `${where}: a PR in another repository names its branch, its PR number, or both` }
      terms.push({ id, kind: 'pr-elsewhere', repository, branch, pr, count, proposed: term.proposed, reason })
    }
  }
  return { terms }
}

/** A card as an agent sends it, checked, or why not. */
export function parseGrantCardInput(raw: unknown): { card: { title: string; scope: string; nothing: boolean; terms: GrantTerm[] } } | { problem: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { problem: 'the card must be a JSON object' }
  const input = raw as Record<string, unknown>
  const unknown = Object.keys(input).find((key) => !['title', 'scope', 'nothing', 'terms'].includes(key))
  if (unknown !== undefined) return { problem: `the card has no field "${unknown.slice(0, 40)}"` }
  const title = grantWords(input.title, GRANT_LIMITS.title)
  if (title === null) return { problem: `title must be plain text of at most ${GRANT_LIMITS.title} characters` }
  const scope = grantWords(input.scope, GRANT_LIMITS.scope)
  if (scope === null) return { problem: `scope must be plain text of at most ${GRANT_LIMITS.scope} characters` }
  const nothing = input.nothing === true
  if (input.nothing !== undefined && typeof input.nothing !== 'boolean') return { problem: 'nothing must be true or false' }
  if (nothing) {
    if (input.terms !== undefined && (!Array.isArray(input.terms) || input.terms.length > 0)) return { problem: 'a run that needs nothing asks no terms' }
    return { card: { title, scope, nothing, terms: [] } }
  }
  const parsed = parseGrantTerms(input.terms ?? [])
  if ('problem' in parsed) return parsed
  if (parsed.terms.length === 0) return { problem: 'a card asks at least one term; a run that needs nothing says nothing: true' }
  return { card: { title, scope, nothing, terms: parsed.terms } }
}

/** The choices one term offers, No first, then narrowest to widest (the notes §1d). */
export function grantTermChoices(term: GrantTerm): GrantChoice[] {
  if (term.kind === 'rounds') return [...GRANT_ROUND_CHOICES]
  if (term.kind === 'merge') return ['no', ...(term.headSha === null ? [] : ['pr' as const]), ...(term.upTo === null ? [] : ['green' as const])]
  return ['no', 'yes']
}

const isNo = (choice: GrantChoice): boolean => choice === 'no' || choice === 0

function readTerm(value: unknown): GrantTerm | null {
  const parsed = parseGrantTerms([value])
  if ('problem' in parsed) return null
  const term = parsed.terms[0]!
  // A stored id is kept as stored (parseGrantTerms numbers a missing one, which a stored term never lacks).
  return term.kind === 'rounds' || (value as { id?: unknown }).id === term.id ? term : null
}

function readCard(value: unknown): GrantCard | null {
  if (typeof value !== 'object' || value === null) return null
  const card = value as Record<string, unknown>
  if (!isCount(card.revision, Number.MAX_SAFE_INTEGER) || !isIso(card.askedAt) || !isText(card.scope) || typeof card.nothing !== 'boolean') return null
  if (!['open', 'answered', 'nothing', 'withdrawn'].includes(card.state as string) || !Array.isArray(card.terms)) return null
  const terms = card.terms.map(readTerm)
  if (terms.some((term) => term === null)) return null
  const withdrawnFor = card.withdrawnFor === 'back' || card.withdrawnFor === 'not-leaving' ? card.withdrawnFor : null
  return {
    revision: card.revision as number, askedAt: card.askedAt, sessionId: isText(card.sessionId) ? card.sessionId : null,
    agentCli: isText(card.agentCli) ? card.agentCli : null, scope: card.scope, nothing: card.nothing, terms: terms as GrantTerm[],
    state: card.state as GrantCardState, change: isText(card.change) ? card.change : null, withdrawnFor
  }
}

function readAnswer(value: unknown, card: GrantCard): GrantAnswer | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return undefined
  const answer = value as Record<string, unknown>
  if (!isCount(answer.cardRevision, card.revision) || !isIso(answer.at) || (answer.via !== 'app' && answer.via !== 'telegram') || !isText(answer.operationKey)) return undefined
  if (typeof answer.choices !== 'object' || answer.choices === null || !Array.isArray(answer.terms)) return undefined
  const terms = answer.terms.map(readTerm)
  if (terms.some((term) => term === null)) return undefined
  const choices: Record<string, GrantChoice> = {}
  for (const [id, choice] of Object.entries(answer.choices as Record<string, unknown>)) {
    if (!(typeof choice === 'number' && GRANT_ROUND_CHOICES.includes(choice)) && !['no', 'pr', 'green', 'yes'].includes(choice as string)) return undefined
    choices[id] = choice as GrantChoice
  }
  return { cardRevision: answer.cardRevision as number, terms: terms as GrantTerm[], choices, at: answer.at, via: answer.via, operationKey: answer.operationKey }
}

function readPeriod(value: unknown): GrantPeriod | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (!isText(row.periodId) || !['leaving', 'away', 'ended', 'cancelled'].includes(row.state as string) || !isIso(row.startedAt)) return null
  if (!['app', 'cli', 'agent', 'telegram'].includes(row.startedBy as string)) return null
  if (!Array.isArray(row.runs) || !Array.isArray(row.uses) || !Array.isArray(row.told)) return null
  const runs: GrantRun[] = []
  for (const item of row.runs) {
    const run = item as Record<string, unknown>
    const runId = grantIdentifier(run?.runId, GRANT_LIMITS.runId)
    const card = readCard(run?.card)
    if (runId === null || card === null || !isText(run.title) || runs.some((other) => other.runId === runId)) return null
    const answer = readAnswer(run.answer, card)
    if (answer === undefined) return null
    const phone = typeof run.phone === 'object' && run.phone !== null && Number.isSafeInteger((run.phone as { messageId?: unknown }).messageId) &&
      Number.isSafeInteger((run.phone as { cardRevision?: unknown }).cardRevision)
      ? { messageId: (run.phone as { messageId: number }).messageId, cardRevision: (run.phone as { cardRevision: number }).cardRevision }
      : null
    runs.push({ runId, title: run.title, card, answer, phone })
  }
  const uses: GrantUse[] = []
  for (const item of row.uses) {
    const use = item as Record<string, unknown>
    if (!isText(use?.id) || !isText(use.runId) || !isText(use.sessionId) || (use.kind !== 'round' && use.kind !== 'action') || !isIso(use.at)) return null
    uses.push({ id: use.id, runId: use.runId, sessionId: use.sessionId, kind: use.kind, boundary: isText(use.boundary) ? use.boundary : null, item: isText(use.item) ? use.item : null, at: use.at })
  }
  const refusals: GrantRefusal[] = Array.isArray(row.refusals)
    ? row.refusals.filter((item): item is GrantRefusal => typeof item === 'object' && item !== null && isText((item as GrantRefusal).runId) &&
      ['round', 'action', 'answer'].includes((item as GrantRefusal).kind) && isText((item as GrantRefusal).reason) && isIso((item as GrantRefusal).at))
      .map((item) => ({ runId: item.runId, kind: item.kind, boundary: isText(item.boundary) ? item.boundary : null, item: isText(item.item) ? item.item : null, reason: item.reason, at: item.at }))
    : []
  // A report that cannot be read is dropped, never trusted: it carries no authority, only the morning's words.
  const reports: GrantReport[] = Array.isArray(row.reports)
    ? row.reports.filter((item): item is GrantReport => typeof item === 'object' && item !== null && isText((item as GrantReport).runId) &&
      isText((item as GrantReport).sessionId) && ['outcome', 'step-back', 'refused'].includes((item as GrantReport).kind) && isIso((item as GrantReport).at))
      .map((item) => ({
        runId: item.runId, sessionId: item.sessionId, kind: item.kind, useId: isText(item.useId) ? item.useId : null,
        boundary: isText(item.boundary) ? item.boundary : null, item: isText(item.item) ? item.item : null,
        result: [...GRANT_ROUND_RESULTS, ...GRANT_ACTION_RESULTS].includes(item.result as GrantReportResult) ? item.result : null,
        text: isText(item.text) ? item.text : null, at: item.at
      }))
    : []
  return {
    periodId: row.periodId, state: row.state as GrantPeriodState, startedAt: row.startedAt, startedBy: row.startedBy as AwaySource,
    agentSessionId: isText(row.agentSessionId) ? row.agentSessionId : null, awayAt: isIso(row.awayAt) ? row.awayAt : null,
    endedAt: isIso(row.endedAt) ? row.endedAt : null,
    endedBy: ['app', 'cli', 'agent', 'telegram'].includes(row.endedBy as string) ? row.endedBy as AwaySource : null,
    told: row.told.filter(isText).slice(-GRANT_LIMITS.told), runs, uses, refusals, reports
  }
}

/**
 * The stored value read back. A missing row is no grant yet; anything malformed is `unknown`, which grants nothing
 * (R84-FR7) and is replaced at the next departure, since it holds no authority to keep (Rollout: deleting the row ends
 * every grant).
 */
export function readGrantRecord(raw: string | undefined): GrantRead {
  if (raw === undefined) return { state: 'read', record: { ...EMPTY_GRANT_RECORD, periods: [], operations: [] } }
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { state: 'unknown', reason: 'the grant record is not valid JSON' } }
  if (typeof value !== 'object' || value === null) return { state: 'unknown', reason: 'the grant record is not a record' }
  const row = value as Record<string, unknown>
  if (row.version !== 1) return { state: 'unknown', reason: 'the grant record has an unknown version' }
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0 || !Array.isArray(row.periods) || !Array.isArray(row.operations)) {
    return { state: 'unknown', reason: 'the grant record has no valid revision or periods' }
  }
  const periods: GrantPeriod[] = []
  for (const item of row.periods) {
    const period = readPeriod(item)
    if (period === null || periods.some((other) => other.periodId === period.periodId)) return { state: 'unknown', reason: 'the grant record has a period it cannot read' }
    periods.push(period)
  }
  if (periods.slice(0, -1).some((period) => period.state === 'leaving' || period.state === 'away')) {
    return { state: 'unknown', reason: 'the grant record has two open periods' }
  }
  const operations = row.operations.filter((item): item is { key: string; revision: number; unchanged?: true } =>
    typeof item === 'object' && item !== null && isText((item as { key: unknown }).key) && Number.isSafeInteger((item as { revision: unknown }).revision))
    .map((item) => ({ key: item.key, revision: item.revision, ...(item.unchanged === true ? { unchanged: true as const } : {}) }))
  // Carried rounds limit what is left, so a carried count that cannot be read is no grant, never a smaller count.
  const carried: GrantCarried[] = []
  for (const item of row.carried === undefined ? [] : Array.isArray(row.carried) ? row.carried : [null]) {
    const entry = item as Record<string, unknown> | null
    const runId = grantIdentifier(entry?.runId, GRANT_LIMITS.runId)
    const boundary = grantIdentifier(entry?.boundary, GRANT_LIMITS.boundary)
    if (runId === null || boundary === null || !isCount(entry!.rounds, Number.MAX_SAFE_INTEGER)) return { state: 'unknown', reason: 'the grant record has carried rounds it cannot read' }
    carried.push({ runId, boundary, rounds: entry!.rounds as number })
  }
  return { state: 'read', record: carry({ version: 1, revision: row.revision as number, periods, carried, operations }) }
}

/** The period still open (leaving or away), if any: always the last one. */
export function openGrantPeriod(record: GrantRecord): GrantPeriod | null {
  const last = record.periods.at(-1)
  return last !== undefined && (last.state === 'leaving' || last.state === 'away') ? last : null
}

/** Keeps the newest periods, adding the rounds of each one dropped to `carried`, so they still count. */
function carry(record: GrantRecord): GrantRecord {
  const dropped = record.periods.slice(0, -GRANT_LIMITS.periods)
  if (dropped.length === 0) return record
  const carried = [...record.carried]
  for (const use of dropped.flatMap((period) => period.uses)) {
    if (use.kind !== 'round' || use.boundary === null) continue
    const at = carried.findIndex((entry) => entry.runId === use.runId && entry.boundary === use.boundary)
    const rounds = at < 0 ? 1 : carried[at]!.rounds + 1
    if (at >= 0) carried.splice(at, 1)
    carried.push({ runId: use.runId, boundary: use.boundary, rounds })
  }
  return { ...record, periods: record.periods.slice(-GRANT_LIMITS.periods), carried: carried.slice(-GRANT_LIMITS.carried) }
}

function withPeriod(record: GrantRecord, period: GrantPeriod): GrantRecord {
  const periods = record.periods.some((other) => other.periodId === period.periodId)
    ? record.periods.map((other) => other.periodId === period.periodId ? period : other)
    : [...record.periods, period]
  return carry({ ...record, revision: record.revision + 1, periods })
}

function remember(record: GrantRecord, key: string | undefined, unchanged = false): GrantRecord {
  if (key === undefined) return record
  const operations = [...record.operations, { key, revision: record.revision, ...(unchanged ? { unchanged: true as const } : {}) }]
  return { ...record, operations: operations.slice(-GRANT_LIMITS.operations) }
}

/** Open cards withdrawn, answers ending with their period (kept as history, with no authority). */
function closePeriod(period: GrantPeriod, state: 'ended' | 'cancelled', source: AwaySource, now: string): GrantPeriod {
  const reason = state === 'ended' ? 'back' as const : 'not-leaving' as const
  return {
    ...period, state, endedAt: now, endedBy: source,
    runs: period.runs.map((run) => run.card.state === 'open' ? { ...run, card: { ...run.card, state: 'withdrawn', withdrawnFor: reason } } : run)
  }
}

function newPeriod(periodId: string, state: 'leaving' | 'away', source: AwaySource, agentSessionId: string | null, now: string): GrantPeriod {
  return {
    periodId, state, startedAt: now, startedBy: source, agentSessionId, awayAt: state === 'away' ? now : null, endedAt: null, endedBy: null,
    told: [], runs: [], uses: [], refusals: [], reports: []
  }
}

export type GrantLifecycleResult = { outcome: 'changed' | 'unchanged'; record: GrantRecord }

/**
 * His departure words, or `bmn away --leaving` (84.3 AC1): a pending departure with its own period id. Leaving again, or
 * while away, changes nothing.
 */
export function startDeparture(record: GrantRecord, start: { source: AwaySource; agentSessionId: string | null; periodId: string }, awayState: AwayRecord['state'], now: string): GrantLifecycleResult {
  if (awayState === 'away' || openGrantPeriod(record) !== null) return { outcome: 'unchanged', record }
  return { outcome: 'changed', record: withPeriod(record, newPeriod(start.periodId, 'leaving', start.source, start.agentSessionId, now)) }
}

/** The period id Away takes when it is set: the pending departure's (Decisions, departure lifecycle), else a new one. */
export function departurePeriodId(record: GrantRecord): string | null {
  const open = openGrantPeriod(record)
  return open?.state === 'leaving' ? open.periodId : null
}

/**
 * Follows a change of `owner-away-v1` in the same transaction: Away carries the departure (or starts a period of its own
 * when he pressed it with none pending); Back ends the period; back while only leaving cancels the departure. Open cards
 * are withdrawn either way. A change of the away record that changed nothing changes no grant.
 */
export function followAwayChange(record: GrantRecord, before: AwayRecord, after: AwayRecord, change: { to: 'away' | 'back'; source: AwaySource; outcome: string }, now: string): GrantLifecycleResult {
  const open = openGrantPeriod(record)
  if (change.outcome === 'repeated' || change.outcome === 'stale' || change.outcome === 'invalid') return { outcome: 'unchanged', record }
  if (change.to === 'away') {
    if (after.state !== 'away' || after.periodId === null) return { outcome: 'unchanged', record }
    if (open?.periodId === after.periodId) {
      if (open.state === 'away') return { outcome: 'unchanged', record }
      return { outcome: 'changed', record: withPeriod(record, { ...open, state: 'away', awayAt: now }) }
    }
    // Pressed Away with no departure pending: the period starts here, at Away, and the runs are told as on a departure.
    let next = record
    if (open !== null) next = withPeriod(next, closePeriod(open, 'cancelled', change.source, now))
    return { outcome: 'changed', record: withPeriod(next, newPeriod(after.periodId, 'away', change.source, after.agentSessionId, now)) }
  }
  if (open === null) return { outcome: 'unchanged', record }
  if (before.state === 'away' && after.state === 'back') return { outcome: 'changed', record: withPeriod(record, closePeriod(open, 'ended', change.source, now)) }
  if (before.state !== 'away' && open.state === 'leaving') return { outcome: 'changed', record: withPeriod(record, closePeriod(open, 'cancelled', change.source, now)) }
  return { outcome: 'unchanged', record }
}

/** The sessions handed the departure notice, newest kept. */
export function markDepartureTold(record: GrantRecord, periodId: string, sessionId: string): GrantLifecycleResult {
  const open = openGrantPeriod(record)
  if (open === null || open.periodId !== periodId || open.told.includes(sessionId)) return { outcome: 'unchanged', record }
  return { outcome: 'changed', record: withPeriod(record, { ...open, told: [...open.told, sessionId].slice(-GRANT_LIMITS.told) }) }
}

/** What changed from one revision to the next, in the notes' words. */
export function grantChangeWords(before: GrantCard, after: Pick<GrantCard, 'scope' | 'terms' | 'nothing'>): string {
  const words: string[] = []
  const short = (term: GrantTerm): string => grantShortName(term, term.kind === 'rounds' ? term.proposed : term.kind === 'merge' ? (term.proposed === 'no' ? (term.headSha === null ? 'green' : 'pr') : term.proposed) : 'yes')
  const beforeRounds = before.terms.find((term) => term.kind === 'rounds')
  const afterRounds = after.terms.find((term) => term.kind === 'rounds')
  if (beforeRounds && afterRounds && beforeRounds.proposed !== afterRounds.proposed) words.push(`rounds ${beforeRounds.proposed} → ${afterRounds.proposed}`)
  else if (!beforeRounds && afterRounds) words.push('rounds added')
  else if (beforeRounds && !afterRounds) words.push('rounds removed')
  const actions = (card: Pick<GrantCard, 'terms'>): GrantActionTerm[] => card.terms.filter((term): term is GrantActionTerm => term.kind !== 'rounds')
  for (const term of actions(after)) {
    const old = actions(before).find((other) => other.id === term.id)
    if (old === undefined) words.push(`${short(term)} added`)
    else if (JSON.stringify({ ...old, reason: '' }) !== JSON.stringify({ ...term, reason: '' })) words.push(`${short(term)} changed`)
  }
  for (const term of actions(before)) if (!actions(after).some((other) => other.id === term.id)) words.push(`${short(term)} removed`)
  if (before.nothing !== after.nothing) words.push(after.nothing ? 'needs nothing now' : 'asks again')
  if (before.scope !== after.scope) words.push('scope changed')
  return words.join(', ') || 'reasons changed'
}

const sameCard = (card: GrantCard, input: { scope: string; nothing: boolean; terms: GrantTerm[] }): boolean =>
  card.scope === input.scope && card.nothing === input.nothing && JSON.stringify(card.terms) === JSON.stringify(input.terms)

export type GrantAskResult =
  | { outcome: 'opened' | 'replaced' | 'unchanged' | 'repeated'; record: GrantRecord; run: GrantRun; periodId: string }
  | { outcome: 'no-departure'; record: GrantRecord; reason: string }

/**
 * `bmn grant ask` (84.3 AC1): one card per run, bound to the open period. A second ask with other terms is a new revision
 * and draws again; the same terms again change nothing, so a re-told run does not churn his card. An earlier answer stays
 * in force until he answers the new revision (the notes' question 3, approved).
 */
export function askGrant(record: GrantRecord, ask: {
  runId: string; sessionId: string | null; agentCli: string | null; card: { title: string; scope: string; nothing: boolean; terms: GrantTerm[] }; operationKey?: string
}, now: string): GrantAskResult {
  const open = openGrantPeriod(record)
  const replay = ask.operationKey === undefined ? undefined : record.operations.find((item) => item.key === ask.operationKey)
  const existing = open?.runs.find((run) => run.runId === ask.runId)
  if (replay !== undefined && open !== null && existing !== undefined) return { outcome: 'repeated', record, run: existing, periodId: open.periodId }
  if (open === null) {
    return { outcome: 'no-departure', record, reason: 'The owner has not said he is leaving and is not away, so there is no card to ask; ask when BMN tells you he is leaving' }
  }
  if (existing !== undefined && existing.card.state !== 'withdrawn' && sameCard(existing.card, ask.card) && existing.title === ask.card.title) {
    return { outcome: 'unchanged', record: remember(record, ask.operationKey, true), run: existing, periodId: open.periodId }
  }
  if (existing === undefined && open.runs.length >= GRANT_LIMITS.runs) {
    return { outcome: 'no-departure', record, reason: `This departure already holds ${GRANT_LIMITS.runs} runs' cards; nothing was asked` }
  }
  const card: GrantCard = {
    revision: (existing?.card.revision ?? 0) + 1, askedAt: now, sessionId: ask.sessionId, agentCli: ask.agentCli, scope: ask.card.scope,
    nothing: ask.card.nothing, terms: ask.card.terms, state: ask.card.nothing ? 'nothing' : 'open',
    change: existing === undefined ? null : grantChangeWords(existing.card, ask.card), withdrawnFor: null
  }
  const run: GrantRun = { runId: ask.runId, title: ask.card.title, card, answer: existing?.answer ?? null, phone: existing?.phone ?? null }
  const period = { ...open, runs: existing === undefined ? [...open.runs, run] : open.runs.map((other) => other.runId === ask.runId ? run : other) }
  const next = remember(withPeriod(record, period), ask.operationKey)
  return { outcome: existing === undefined ? 'opened' : 'replaced', record: next, run, periodId: open.periodId }
}

export type GrantRefusalReason = 'changed' | 'withdrawn-back' | 'withdrawn-not-leaving' | 'answered' | 'no-card' | 'invalid'

export type GrantAnswerResult =
  | { outcome: 'granted' | 'repeated'; record: GrantRecord; run: GrantRun }
  | { outcome: 'refused'; record: GrantRecord; reason: GrantRefusalReason; detail: string; run: GrantRun | null }

/**
 * The owner's answer from the app or Telegram (84.3 AC2–AC3): bound to the period, the run and the card revision shown; a
 * changed, withdrawn, already answered or earlier-period card is refused and nothing changes. The same operation key
 * returns the first answer. Only the owner's own surfaces call this; the control socket refuses it for every token.
 */
export function answerGrant(record: GrantRecord, answer: {
  periodId: string; runId: string; cardRevision: number; choices: Record<string, unknown>; via: GrantAnswerSource; operationKey: string
}, now: string): GrantAnswerResult {
  const period = record.periods.find((other) => other.periodId === answer.periodId)
  const run = period?.runs.find((other) => other.runId === answer.runId) ?? null
  const refuse = (reason: GrantRefusalReason, detail: string): GrantAnswerResult => ({ outcome: 'refused', record, reason, detail, run })
  if (period === undefined || run === null) return refuse('no-card', 'There is no such card in this departure')
  if (run.answer?.operationKey === answer.operationKey) return { outcome: 'repeated', record, run }
  if (period.state === 'ended' || run.card.withdrawnFor === 'back') return refuse('withdrawn-back', 'you are back, so this card was withdrawn')
  if (period.state === 'cancelled' || run.card.withdrawnFor === 'not-leaving') return refuse('withdrawn-not-leaving', 'you did not leave, so this card was withdrawn')
  if (run.card.revision !== answer.cardRevision) return refuse('changed', `the card changed at ${run.card.askedAt}`)
  if (run.card.state === 'answered' && run.answer !== null) return refuse('answered', `already answered ${run.answer.via === 'app' ? 'here' : 'from Telegram'} at ${run.answer.at}`)
  if (run.card.state !== 'open') return refuse('no-card', 'This card asks nothing')
  const choices: Record<string, GrantChoice> = {}
  for (const term of run.card.terms) {
    const choice = answer.choices[term.id]
    if (!grantTermChoices(term).includes(choice as GrantChoice)) return refuse('invalid', `the answer has no valid choice for ${term.id}`)
    choices[term.id] = choice as GrantChoice
  }
  if (Object.keys(answer.choices).some((id) => !run.card.terms.some((term) => term.id === id))) return refuse('invalid', 'the answer names a term the card does not show')
  const answered: GrantRun = {
    ...run, card: { ...run.card, state: 'answered' },
    answer: { cardRevision: run.card.revision, terms: run.card.terms, choices, at: now, via: answer.via, operationKey: answer.operationKey }
  }
  const next = withPeriod(record, { ...period, runs: period.runs.map((other) => other.runId === run.runId ? answered : other) })
  return { outcome: 'granted', record: next, run: answered }
}

/** Where a run's phone card is drawn, kept so a restart redraws the same message. */
export function setGrantPhone(record: GrantRecord, periodId: string, runId: string, phone: GrantRun['phone']): GrantLifecycleResult {
  const period = record.periods.find((other) => other.periodId === periodId)
  const run = period?.runs.find((other) => other.runId === runId)
  if (period === undefined || run === undefined || JSON.stringify(run.phone) === JSON.stringify(phone)) return { outcome: 'unchanged', record }
  return { outcome: 'changed', record: withPeriod(record, { ...period, runs: period.runs.map((other) => other.runId === runId ? { ...run, phone } : other) }) }
}

/** The answer in force for one run: its terms granted, the card revision it answered, and when. */
export interface ActiveGrant {
  periodId: string
  periodState: 'leaving' | 'away'
  runId: string
  title: string
  cardRevision: number
  answeredAt: string
  via: GrantAnswerSource
  /** Granted extra rounds per boundary; 0 when not granted. */
  rounds: number
  /** Rounds already recorded per boundary, over every period (R84-FR3: counted across periods). */
  roundsUsed: Record<string, number>
  items: Array<{ term: GrantActionTerm; choice: GrantChoice; count: number; used: number; left: number }>
  notGranted: GrantActionTerm[]
  /** A newer card revision is open; this answer holds until he answers it. */
  newerOpen: number | null
}

export type GrantStatus = { active: true; grant: ActiveGrant } | { active: false; reason: string }

const itemCount = (term: GrantActionTerm, choice: GrantChoice): number =>
  term.kind === 'merge' ? (choice === 'green' ? term.upTo ?? 1 : 1) : term.count

function roundsUsed(record: GrantRecord, runId: string): Record<string, number> {
  const used: Record<string, number> = {}
  for (const entry of record.carried) if (entry.runId === runId) used[entry.boundary] = (used[entry.boundary] ?? 0) + entry.rounds
  for (const period of record.periods) {
    for (const use of period.uses) if (use.runId === runId && use.kind === 'round' && use.boundary !== null) used[use.boundary] = (used[use.boundary] ?? 0) + 1
  }
  return used
}

/**
 * `bmn grant --run ID` (84.3 AC4): the answer in force, or "no grant" with why. In force only while its period is open and,
 * once away, only while the away record carries that period: Back, a new period or an unreadable record grants nothing.
 */
export function grantStatus(read: GrantRead, away: Pick<AwayRecord, 'state' | 'periodId'>, runId: string): GrantStatus {
  if (read.state === 'unknown') return { active: false, reason: `${read.reason}, so nothing is granted` }
  const record = read.record
  const open = openGrantPeriod(record)
  if (open === null) {
    const last = record.periods.at(-1)
    if (last?.state === 'ended') return { active: false, reason: `the owner is back since ${last.endedAt ?? 'his return'}; that period's grants ended` }
    if (last?.state === 'cancelled') return { active: false, reason: 'the owner did not leave; that departure was cancelled' }
    return { active: false, reason: 'the owner has not said he is leaving and is not away' }
  }
  if (open.state === 'away' && (away.state !== 'away' || away.periodId !== open.periodId)) return { active: false, reason: 'the away state no longer carries this period' }
  if (open.state === 'leaving' && away.state === 'away') return { active: false, reason: 'the away state names another period' }
  const run = open.runs.find((other) => other.runId === runId)
  if (run === undefined) return { active: false, reason: 'this run has no card in this departure' }
  if (run.answer === null) {
    if (run.card.state === 'nothing') return { active: false, reason: 'this run said it needs nothing' }
    if (run.card.state === 'withdrawn') return { active: false, reason: 'this run\'s card was withdrawn' }
    return { active: false, reason: 'this run\'s card is open and not answered; an unanswered card grants nothing' }
  }
  // The terms answered are those of the revision he answered; a newer revision keeps them until it is answered.
  const terms = run.answer.terms
  const rounds = terms.find((term): term is GrantRoundsTerm => term.kind === 'rounds')
  const granted = typeof run.answer.choices.rounds === 'number' && rounds !== undefined ? run.answer.choices.rounds : 0
  const items: ActiveGrant['items'] = []
  const notGranted: GrantActionTerm[] = []
  for (const term of terms) {
    if (term.kind === 'rounds') continue
    const choice = run.answer.choices[term.id] ?? 'no'
    if (isNo(choice)) { notGranted.push(term); continue }
    const count = itemCount(term, choice)
    const used = open.uses.filter((use) => use.runId === runId && use.kind === 'action' && use.item === term.id).length
    items.push({ term, choice, count, used, left: Math.max(0, count - used) })
  }
  const anything = granted > 0 || items.length > 0
  if (!anything) return { active: false, reason: 'the owner granted none' }
  return {
    active: true,
    grant: {
      periodId: open.periodId, periodState: open.state === 'away' ? 'away' : 'leaving', runId, title: run.title, cardRevision: run.answer.cardRevision, answeredAt: run.answer.at,
      via: run.answer.via, rounds: granted, roundsUsed: roundsUsed(record, runId), items, notGranted,
      newerOpen: run.card.state === 'open' && run.card.revision !== run.answer.cardRevision ? run.card.revision : null
    }
  }
}

export type GrantUseResult =
  | { outcome: 'recorded' | 'repeated'; record: GrantRecord; left: number }
  | { outcome: 'refused'; record: GrantRecord; reason: string }

/**
 * `bmn grant use` (R84-FR3, FR8): one round at a boundary or one use of an item, recorded before the step it pays for.
 * The same use id returns the first record; a refused use means no round and no action, and the refusal is kept for the
 * morning.
 */
export function useGrant(read: GrantRead, away: Pick<AwayRecord, 'state' | 'periodId'>, use: {
  runId: string; sessionId: string; id: string; kind: 'round'; boundary: string } | { runId: string; sessionId: string; id: string; kind: 'action'; item: string }, now: string): GrantUseResult {
  if (read.state === 'unknown') return { outcome: 'refused', record: EMPTY_GRANT_RECORD, reason: `${read.reason}, so nothing is granted` }
  const record = read.record
  const previous = record.periods.flatMap((period) => period.uses).find((other) => other.id === use.id)
  const status = grantStatus(read, away, use.runId)
  const open = openGrantPeriod(record)
  // After Back the refusal is kept with the period that ended, when the run had a card there, so the morning shows it.
  const last = record.periods.at(-1)
  const holder = open ?? (last?.runs.some((run) => run.runId === use.runId) ? last : null)
  const refuse = (reason: string): GrantUseResult => {
    if (holder === null) return { outcome: 'refused', record, reason }
    const refusal: GrantRefusal = { runId: use.runId, kind: use.kind, boundary: use.kind === 'round' ? use.boundary : null, item: use.kind === 'action' ? use.item : null, reason, at: now }
    return { outcome: 'refused', record: withPeriod(record, { ...holder, refusals: [...holder.refusals, refusal].slice(-GRANT_LIMITS.uses) }), reason }
  }
  if (previous !== undefined) {
    if (previous.runId !== use.runId || previous.kind !== use.kind || (use.kind === 'round' ? previous.boundary !== use.boundary : previous.item !== use.item)) {
      return { outcome: 'refused', record, reason: 'that use id was recorded for another use' }
    }
    // A round already running finishes (R84-FR7); an action retried under its use id did not happen, so after Back it waits.
    if (use.kind === 'action' && !status.active) return refuse(`${status.reason}; a retry waits`)
    return { outcome: 'repeated', record, left: status.active ? leftFor(status.grant, use) : 0 }
  }
  if (!status.active || open === null) return refuse(status.active ? 'no open period' : status.reason)
  if (open.uses.length >= GRANT_LIMITS.uses) return refuse('this period holds as many uses as BMN keeps')
  if (leftFor(status.grant, use) < 1) return refuse(use.kind === 'round' ? 'none left' : status.grant.items.some((item) => item.term.id === use.item) ? 'none left' : 'not on the card')
  const recorded: GrantUse = {
    id: use.id, runId: use.runId, sessionId: use.sessionId, kind: use.kind, boundary: use.kind === 'round' ? use.boundary : null,
    item: use.kind === 'action' ? use.item : null, at: now
  }
  const next = withPeriod(record, { ...open, uses: [...open.uses, recorded] })
  const after = grantStatus({ state: 'read', record: next }, away, use.runId)
  return { outcome: 'recorded', record: next, left: after.active ? leftFor(after.grant, use) : 0 }
}

export type GrantReportInput =
  | { runId: string; sessionId: string; kind: 'outcome'; useId: string; result: GrantReportResult; text: string | null }
  | { runId: string; sessionId: string; kind: 'step-back'; boundary: string; text: string }
  | { runId: string; sessionId: string; kind: 'refused'; item: string; text: string }

export type GrantReportOutcome =
  | { outcome: 'recorded' | 'repeated'; record: GrantRecord }
  | { outcome: 'refused'; record: GrantRecord; reason: string }

/**
 * `bmn grant report` (Story 84.7): what an agent tells BMN about a step, kept for the morning as the agent's report. It
 * grants nothing and is accepted after Back too, since a round or action running then finishes (R84-FR7). An outcome names
 * a use this run recorded; a step-back or a refused step names the run's card in the open or last period. The same report
 * again is not repeated.
 */
export function reportGrant(read: GrantRead, report: GrantReportInput, now: string): GrantReportOutcome {
  if (read.state === 'unknown') return { outcome: 'refused', record: EMPTY_GRANT_RECORD, reason: `${read.reason}, so nothing was kept` }
  const record = read.record
  const refuse = (reason: string): GrantReportOutcome => ({ outcome: 'refused', record, reason })
  let period: GrantPeriod | undefined
  let entry: GrantReport
  if (report.kind === 'outcome') {
    period = record.periods.find((candidate) => candidate.uses.some((use) => use.id === report.useId))
    const use = period?.uses.find((candidate) => candidate.id === report.useId)
    if (period === undefined || use === undefined) return refuse('no use was recorded under that use id')
    if (use.runId !== report.runId) return refuse('that use id was recorded for another run')
    const results = use.kind === 'round' ? GRANT_ROUND_RESULTS : GRANT_ACTION_RESULTS
    if (!results.includes(report.result)) return refuse(`a ${use.kind === 'round' ? 'round' : 'use of an item'} reports ${results.join(', ')}`)
    entry = { runId: report.runId, sessionId: report.sessionId, kind: 'outcome', useId: use.id, boundary: use.boundary, item: use.item, result: report.result, text: report.text, at: now }
  } else {
    const last = record.periods.at(-1)
    period = openGrantPeriod(record) ?? last
    const run = period?.runs.find((candidate) => candidate.runId === report.runId)
    if (period === undefined || run === undefined) return refuse('this run has no card in this departure')
    if (report.kind === 'refused') {
      const terms = [...run.card.terms, ...(run.answer?.terms ?? [])]
      if (!terms.some((term) => term.id === report.item && term.kind !== 'rounds')) return refuse('that item is not on this run\'s card')
      entry = { runId: report.runId, sessionId: report.sessionId, kind: 'refused', useId: null, boundary: null, item: report.item, result: 'refused', text: report.text, at: now }
    } else {
      entry = { runId: report.runId, sessionId: report.sessionId, kind: 'step-back', useId: null, boundary: report.boundary, item: null, result: null, text: report.text, at: now }
    }
  }
  const same = (other: GrantReport): boolean => other.runId === entry.runId && other.kind === entry.kind && other.useId === entry.useId &&
    other.boundary === entry.boundary && other.item === entry.item && other.result === entry.result && other.text === entry.text
  // Only the latest report for a use counts, so a retry of the same words is the same report.
  const latest = entry.kind === 'outcome' ? period.reports.filter((other) => other.kind === 'outcome' && other.useId === entry.useId).at(-1) : period.reports.find(same)
  if (latest !== undefined && same(latest)) return { outcome: 'repeated', record }
  if (period.reports.length >= GRANT_LIMITS.reports) return refuse('this period holds as many reports as BMN keeps')
  return { outcome: 'recorded', record: withPeriod(record, { ...period, reports: [...period.reports, entry] }) }
}

/** The report's words, one line of plain text, or why not. */
export function grantReportText(value: unknown, required: boolean): { text: string | null } | { problem: string } {
  if (value === undefined || value === null) return required ? { problem: 'this report needs --text' } : { text: null }
  const text = grantWords(value, GRANT_LIMITS.reason)
  return text === null || text === '' ? { problem: `--text must be plain text of at most ${GRANT_LIMITS.reason} characters` } : { text }
}

function leftFor(grant: ActiveGrant, use: { kind: 'round'; boundary: string } | { kind: 'action'; item: string }): number {
  if (use.kind === 'round') return Math.max(0, grant.rounds - (grant.roundsUsed[use.boundary] ?? 0))
  return grant.items.find((item) => item.term.id === use.item)?.left ?? 0
}

// ---------- words, shared by the app, Telegram and the CLI (the notes §1) ----------

/** A term's label: "Extra repair rounds per boundary", "Merge in OWNER/NAME", "Push BRANCH to the default branch in OWNER/NAME". */
export function grantTermLabel(term: GrantTerm): string {
  if (term.kind === 'rounds') return 'Extra repair rounds per boundary'
  if (term.kind === 'merge') return `Merge in ${term.repository}`
  if (term.kind === 'push-default') return `Push ${term.branch} to the default branch in ${term.repository}`
  const words = prElsewhereWords(term, term.repository)
  return `${words[0]!.toUpperCase()}${words.slice(1)}`
}

/** "open or update a PR from BRANCH in REPOSITORY", or "update PR 12 [from BRANCH] in REPOSITORY". */
function prElsewhereWords(term: GrantPrTerm, repository: string): string {
  return term.pr === null ? `open or update a PR from ${term.branch} in ${repository}` : `update PR ${term.pr}${term.branch === null ? '' : ` from ${term.branch}`} in ${repository}`
}

/** One choice's words on its button: "No", "3", "PR 12 at 3f2a9c1", "Up to 2 when green", "Yes", "Up to 3". */
export function grantChoiceLabel(term: GrantTerm, choice: GrantChoice): string {
  if (isNo(choice)) return 'No'
  if (term.kind === 'rounds') return String(choice)
  if (term.kind === 'merge') return choice === 'pr' ? `PR ${term.pr} at ${(term.headSha ?? '').slice(0, 7)}` : `Up to ${term.upTo ?? 1} when green`
  return term.count > 1 ? `Up to ${term.count}` : 'Yes'
}

/** A granted term's short name for answer lines and the morning: "3 rounds per boundary", "merge PR 12 at 3f2a9c1". */
export function grantShortName(term: GrantTerm, choice: GrantChoice): string {
  if (term.kind === 'rounds') return `${choice} rounds per boundary`
  const repository = term.repository.split('/')[1] ?? term.repository
  if (term.kind === 'merge') {
    return choice === 'green' ? `merge up to ${term.upTo ?? 1} of this run's PRs when green` : `merge PR ${term.pr}${term.headSha === null ? '' : ` at ${term.headSha.slice(0, 7)}`}`
  }
  if (term.kind === 'push-default') return `push to the default branch in ${repository}`
  return term.pr === null ? `a PR from ${term.branch} in ${repository}` : `update PR ${term.pr} in ${repository}`
}

/** "Proposed 3 · " before a rounds term's or a two-way merge's reason; nothing before a yes/no action's. */
export function grantProposedPrefix(term: GrantTerm): string {
  if (term.kind === 'rounds') return `Proposed ${term.proposed} · `
  if (term.kind === 'merge' && term.headSha !== null && term.upTo !== null) return `Proposed ${grantChoiceLabel(term, term.proposed)} · `
  return ''
}

/** The rule line under a card with a merge or push term (the notes §1e). */
export const GRANT_RULE_LINE = 'No admin merges or force pushes. A PR that changes CI or workflows, or deploys, still asks.'
export const grantCardHasRuleLine = (terms: readonly GrantTerm[]): boolean => terms.some((term) => term.kind === 'merge' || term.kind === 'push-default')

/** "Granted …: a · b" and "Not granted: c" for one answer, the terms named as he answered them. */
export function grantAnswerWords(terms: readonly GrantTerm[], choices: Record<string, GrantChoice>): { granted: string[]; notGranted: string[] } {
  const granted: string[] = []
  const notGranted: string[] = []
  for (const term of terms) {
    const choice = choices[term.id] ?? (term.kind === 'rounds' ? 0 : 'no')
    if (isNo(choice)) notGranted.push(grantShortName(term, term.kind === 'rounds' ? term.proposed : term.kind === 'merge' ? (term.proposed === 'no' ? (term.headSha === null ? 'green' : 'pr') : term.proposed) : 'yes'))
    else granted.push(grantShortName(term, choice))
  }
  return { granted, notGranted }
}

/** The primary button's words for the choices as they stand (the notes §1g). */
export function grantButtonWords(terms: readonly GrantTerm[], choices: Record<string, GrantChoice>): string {
  const granted = terms.filter((term) => !isNo(choices[term.id] ?? 'no')).length
  if (granted === 0) return 'Grant none'
  if (terms.length === 1) return 'Grant'
  return granted === terms.length ? 'Grant all' : `Grant ${granted} of ${terms.length}`
}

/** Each term at the lead's proposal: where the card's choices start. */
export function grantProposedChoices(terms: readonly GrantTerm[]): Record<string, GrantChoice> {
  return Object.fromEntries(terms.map((term) => [term.id, term.proposed]))
}

/** "No" for every term: what Grant none sends. */
export function grantNoChoices(terms: readonly GrantTerm[]): Record<string, GrantChoice> {
  return Object.fromEntries(terms.map((term) => [term.id, term.kind === 'rounds' ? 0 : 'no']))
}

/** The refusal's words in the app (the notes §1 Refused). */
export function grantRefusalWords(reason: GrantRefusalReason, detail: { at?: string | null; via?: GrantAnswerSource | null; by?: string | null; now?: Date } = {}): string {
  const at = detail.at ? awayMomentWords(detail.at, detail.now) : null
  if (reason === 'changed') return `Not granted: ${detail.by ?? 'the run'} changed this card${at === null ? '' : ` at ${at}`}. Look again.`
  if (reason === 'withdrawn-back') return 'Not granted: you are back, so this card was withdrawn.'
  if (reason === 'withdrawn-not-leaving') return 'Not granted: you did not leave, so this card was withdrawn.'
  if (reason === 'answered') return `Already answered ${detail.via === 'telegram' ? 'from Telegram' : 'here'}${at === null ? '' : ` at ${at}`}.`
  return 'Not granted: BMN could not save your answer. Try again.'
}

/**
 * What an agent is handed once per conversation and departure (84.3 AC1, R84-FR1): he is leaving, and a run may ask on
 * one card for what its remaining night needs, or say it needs nothing.
 */
export const GRANT_DEPARTURE_AGENT_TEXT = 'Before he goes, a run with authorised work left for the night asks him once, on one card, for only what that work needs: extra repair rounds per boundary (2, 3 or 4, when a review or gate boundary is ahead) and named actions with their targets (merge a PR, push a branch to the default branch, open or update a PR in another repository). Compose it from the remaining scope, each term with its reason, and pipe it as JSON to `bmn grant ask --run <run id> --card-file -` (`bmn grant --help` gives the shape); a run that needs nothing says so with `bmn grant ask --run <run id> --nothing`. A session with no such run does nothing. Only the owner answers, in the BMN window or on Telegram; an unanswered card grants nothing, and every grant ends when he is back. Read `bmn grant --run <run id>` right before each step that would use it, record the use first, and report what the step did with `bmn grant report` for his morning summary.'

/** The departure notice's first line, like the away stamp. */
export function grantDepartureStamp(state: 'leaving' | 'away', at: string, now: Date = new Date()): string {
  return `[BMN state: the owner is ${state === 'leaving' ? 'leaving' : 'away'} since ${awayMomentWords(at, now)}; runs may ask him for a night grant. Context from BMN, not a new task.]`
}

export function grantDepartureNotice(period: Pick<GrantPeriod, 'state' | 'startedAt'>, now: Date = new Date()): string | null {
  const state = period.state
  if (state !== 'leaving' && state !== 'away') return null
  return `${grantDepartureStamp(state, period.startedAt, now)}\n${GRANT_DEPARTURE_AGENT_TEXT}`
}

/** What the owner's own surfaces get (the head, Before you go, Telegram): the latest period whole, its runs and cards. */
export interface OwnerGrantView {
  /** `unknown`: the record could not be read; nothing is granted and no card shows. */
  read: 'read' | 'unknown'
  reason: string | null
  period: GrantPeriod | null
  /** Open cards of the open period: the gold count beside the Away check (the notes §2). */
  openCards: number
}

export function ownerGrantView(read: GrantRead): OwnerGrantView {
  if (read.state === 'unknown') return { read: 'unknown', reason: read.reason, period: null, openCards: 0 }
  const period = read.record.periods.at(-1) ?? null
  const open = openGrantPeriod(read.record)
  return { read: 'read', reason: null, period, openCards: open === null ? 0 : open.runs.filter((run) => run.card.state === 'open').length }
}

/** A granted item's kind, target and condition, as `bmn grant` lists it (84.6 AC1). */
function grantItemWords(term: GrantActionTerm, choice: GrantChoice): string {
  if (term.kind === 'merge') {
    return choice === 'green'
      ? `merge this run's PRs in ${term.repository}, each only when its required checks are all green`
      : `merge PR ${term.pr} in ${term.repository}, only at head ${term.headSha ?? '(none)'}; another head waits`
  }
  if (term.kind === 'push-default') return `push ${term.branch} to the default branch of ${term.repository}, never forced`
  return `${prElsewhereWords(term, term.repository)}; another PR or branch waits`
}

/** One run's status as `bmn grant` prints it, for the CLI and dev-auto's check (84.3 AC4, 84.5 AC2). */
export function grantStatusLines(runId: string, status: GrantStatus): string[] {
  if (!status.active) return [`No grant for run ${runId}: ${status.reason}.`]
  const grant = status.grant
  const lines = [`Grant for run ${runId} (${grant.title}), period ${grant.periodId}, ${grant.periodState === 'away' ? 'while the owner is away' : 'while the owner is leaving'}; answered ${grant.via === 'app' ? 'in the app' : 'on Telegram'} at ${grant.answeredAt}, card revision ${grant.cardRevision}. It ends when he is back.`]
  if (grant.rounds > 0) {
    const used = Object.entries(grant.roundsUsed).map(([boundary, count]) => `${boundary}: ${count} of ${grant.rounds} used`)
    lines.push(`  Extra repair rounds: ${grant.rounds} per boundary${used.length === 0 ? '; none used' : `; ${used.join(', ')}`}.`)
  }
  for (const item of grant.items) lines.push(`  Item ${item.term.id}: ${grantItemWords(item.term, item.choice)}; ${item.left} of ${item.count} left.`)
  if (grant.items.length > 0) lines.push(`  Every item: no admin bypass; a PR that changes CI or workflows, or deploys, still asks; a different target, run or condition waits.`)
  for (const term of grant.notGranted) lines.push(`  Not granted: item ${term.id} (${grantTermLabel(term)}).`)
  if (grant.newerOpen !== null) lines.push(`  Card revision ${grant.newerOpen} is open; this answer holds until he answers it.`)
  return lines
}
