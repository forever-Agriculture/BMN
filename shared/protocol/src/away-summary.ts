// MODULE: away-summary.ts - "While you were away": one period's summary in Fable's words and bounds, from what each source holds (Story 76.6)
import { ROSTER_APP_NAMES, type RosterHarness, type TeamAskLine } from './agents-roster'
import { awayDurationWords, awayMomentWords, awayPeriodWords, type DecisionRecord, type OwnerAwayView } from './away'
import type { AttentionKind, AttentionRecord } from './companion'
import type { DevAutoRunsResult } from './dev-auto'

/** Fable's bounds (Story 76.1 §4–5). */
export const AWAY_SUMMARY_LIMITS = Object.freeze({
  waiting: 40, decisions: 30, sessions: 20, lines: 8, published: 3, now: 20, telegramWaiting: 10, telegramSession: 120, telegramTitle: 220
})

/** The sources the summary reads; each says on its own whether it was read in full. */
export type AwaySourceName = 'requests' | 'decisions' | 'turns' | 'changes' | 'files' | 'messages' | 'asks' | 'exits' | 'dev-auto'
const SOURCE_WORDS: Readonly<Record<AwaySourceName, string>> = Object.freeze({
  requests: 'requests', decisions: 'decision records', turns: 'turn endings', changes: 'turn changes', files: 'published files', messages: 'messages',
  asks: 'teammate asks', exits: 'session exits', 'dev-auto': 'dev-auto runs'
})
const SOURCE_ORDER: readonly AwaySourceName[] = Object.freeze(['requests', 'decisions', 'turns', 'changes', 'files', 'messages', 'asks', 'exits', 'dev-auto'])

/** Why a source was not read in full: missing, unreadable, partial, truncated or no longer retained are told apart. */
export type AwaySourceGap =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'partial'; read: number; skipped: number }
  | { kind: 'truncated'; at: number }
  | { kind: 'expired' }

/** A gap in Fable's reason words. */
export function awayGapWords(gap: AwaySourceGap): string {
  switch (gap.kind) {
    case 'missing': return 'not recorded'
    case 'unreadable': return 'unreadable'
    case 'partial': return `partial: ${gap.read} read, ${gap.skipped} skipped`
    case 'truncated': return `cut at ${gap.at} listings`
    case 'expired': return 'no longer retained'
  }
}

/** A session as the summary names it; one BMN no longer holds is absent from the map. */
export interface AwaySummarySession {
  sessionId: string
  name: string
  workspace: string
  archivedAt: string | null
}

/** One session's retained activity in the period: counts, published names, states; never file lists. */
export interface AwaySessionActivity {
  sessionId: string
  /** The app its turns name (`claude`, `codex`, …), when a turn says. */
  app: string | null
  turnsEnded: number
  turnsWithChanges: number
  /** Some ended turns have no complete totals, so the count with changes is a lower bound. */
  changesAtLeast: boolean
  /** Published file names, oldest first, at most a few; the count says how many. */
  published: string[]
  publishedCount: number
  /** Completed teammate asks, by role. */
  asksCompleted: string[]
  messages: { printed: number; queued: number; uncertain: number; expired: number }
  handoffs: Array<{ receiver: string; state: 'queued' | 'uncertain' | 'printed' | 'expired' }>
  /** Exits proven by a timestamped record. */
  exits: Array<{ at: string; code: number | null; signal: number | null }>
}

export interface AwayPeriodActivity {
  sessions: AwaySessionActivity[]
  gaps: Partial<Record<AwaySourceName, AwaySourceGap>>
}

const emptyActivity = (sessionId: string): AwaySessionActivity => ({
  sessionId, app: null, turnsEnded: 0, turnsWithChanges: 0, changesAtLeast: false, published: [], publishedCount: 0, asksCompleted: [],
  messages: { printed: 0, queued: 0, uncertain: 0, expired: 0 }, handoffs: [], exits: []
})

/**
 * The period's completed teammate asks, by the session that asked, added to the host's activity; asks that could not be
 * read are named as a gap. An ask answered after the period ended or by the owner's own shell is not an agent's activity.
 */
export function withCompletedAsks(activity: AwayPeriodActivity, asks: readonly TeamAskLine[] | null, since: string, until: string | null,
  retention?: { keptDays: number; now: Date }): AwayPeriodActivity {
  if (asks === null) return { ...activity, gaps: { ...activity.gaps, asks: { kind: 'unreadable' } } }
  // Team › Asks keeps a record its own number of days: a period that began before that may have lost some.
  const expired = retention !== undefined && Date.parse(since) < retention.now.getTime() - retention.keptDays * 86_400_000
  if (expired) activity = { ...activity, gaps: { ...activity.gaps, asks: { kind: 'expired' } } }
  const sessions = new Map(activity.sessions.map((session) => [session.sessionId, { ...session, asksCompleted: [...session.asksCompleted] }]))
  for (const ask of asks) {
    if (ask.state !== 'answered' || ask.by.kind !== 'session' || ask.endedAt === null) continue
    if (ask.endedAt < since || (until !== null && ask.endedAt >= until)) continue
    const session = sessions.get(ask.by.session) ?? emptyActivity(ask.by.session)
    session.asksCompleted.push(ask.role ?? 'ask')
    sessions.set(ask.by.session, session)
  }
  return { ...activity, sessions: [...sessions.values()] }
}

/** What the host returns for one period (`away.summary`); the renderer adds the live requests, asks and dev-auto runs. */
export interface AwaySummaryPayload {
  away: OwnerAwayView
  /** Every session the summary may name, archived ones included. */
  sessions: AwaySummarySession[]
  /** Session ids in sidebar order. */
  order: string[]
  decisions: { decisions: DecisionRecord[]; complete: boolean } | null
  activity: AwayPeriodActivity | null
  /** Names of the published files that decision references point at and BMN found. */
  artifactNames: Record<string, string>
}

export interface AwaySummaryInput extends AwaySummaryPayload {
  now: Date
  /** BMN's requests as the app holds them now; null when they could not be read. */
  attention: readonly AttentionRecord[] | null
  devAuto: { result: DevAutoRunsResult; workspaceNames: Record<string, string> } | null
}

export interface AwayWaitingRow {
  requestId: string
  sessionId: string
  age: string
  kind: string
  title: string
  /** A command an agent could not run: shown in mono, one line. */
  command: boolean
  before: boolean
}
/** A link opens a session, a published file or a dev-auto run BMN validated; anything else stays words. */
export interface AwayDecisionRow { label: string; text: string; muted?: boolean; links?: Array<{ kind: 'session' | 'artifact' | 'workflow'; id: string; text: string }> }
export interface AwayDecisionView { key: string; sessionId: string; time: string; choice: string; rows: AwayDecisionRow[] }

export interface AwaySummaryView {
  label: 'While you were away' | 'While you are away'
  head: string
  note: string | null
  couldNotRead: string | null
  waiting: { open: number; groups: Array<{ sessionId: string; where: string; rows: AwayWaitingRow[] }>; more: string | null; empty: string | null }
  decided: { incomplete: boolean; groups: Array<{ sessionId: string; where: string; records: AwayDecisionView[] }>; more: string | null; empty: string | null; tail: string }
  happened: { incomplete: boolean; blocks: Array<{ sessionId: string; head: string; lines: string[] }>; more: string | null; empty: string | null }
  now: { lines: string[]; legacy: string | null; more: string | null; empty: string | null; incomplete: boolean }
}

/** The request card's own kind words (session-request-card.tsx). */
const KIND_WORDS: Readonly<Record<AttentionKind, string>> = Object.freeze({
  question: 'Question', permission: 'Permission', review: 'Review', notice: 'Update', handoff: 'Handoff'
})
const kindWords = (record: AttentionRecord): string => record.manualChoices
  ? record.kind === 'permission' ? 'Manual decision' : 'Manual question'
  : KIND_WORDS[record.kind] ?? record.kind
const pad = (value: number): string => String(value).padStart(2, '0')
const clockWords = (iso: string): string => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '--:--' : `${pad(at.getHours())}:${pad(at.getMinutes())}`
}
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`
const oneLine = (text: string, limit: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** An app's name from its harness id; another id stands as itself. */
export function awayAppName(app: string | null): string | null {
  if (app === null) return null
  return (ROSTER_APP_NAMES as Record<string, string>)[app as RosterHarness] ?? app
}

/** How long a request has waited: "now", "5 min", "3 h", "2 d". */
export function awayAgeWords(openedAt: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(openedAt)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`
  return `${Math.floor(minutes / (24 * 60))} d`
}

/** Who started or ended the period, as the head line says it. */
function sourceWords(source: OwnerAwayView['source'], verb: 'set' | 'ended', agentName: string | null): string {
  switch (source) {
    case 'app': return `${verb} here`
    case 'cli': return verb === 'set' ? 'set with bmn away' : 'ended with bmn back'
    case 'telegram': return `${verb} from Telegram`
    case 'agent': return `${verb} by ${agentName ?? 'an agent'} on your words`
    default: return verb
  }
}

/** The head line: duration, period, source; while away "so far" and since. */
export function awayHeadWords(away: Pick<OwnerAwayView, 'state' | 'since' | 'endedAt' | 'source' | 'endedBy' | 'agentSessionId'>, now: Date, sessionName: (sessionId: string) => string | null): string {
  if (away.since === null) return 'Not away'
  const agent = away.agentSessionId === null ? null : sessionName(away.agentSessionId)
  const set = sourceWords(away.source, 'set', agent)
  if (away.state === 'away' || away.endedAt === null) {
    return `Away ${awayDurationWords(away.since, now.toISOString())} so far · since ${awayMomentWords(away.since, now)} · ${set}`
  }
  // The record names the agent that set away; one that ended it on his words is named only when it is the same.
  const ended = sourceWords(away.endedBy, 'ended', away.endedBy === 'agent' && away.source === 'agent' ? agent : null)
  return `Away ${awayDurationWords(away.since, away.endedAt)} · ${awayPeriodWords(away.since, away.endedAt, now)} · ${set}, ${ended}`
}

/** "Personal › Builder"; a session BMN archived "Builder (archived Thu 05:00)"; one it no longer holds says so. */
function whereWords(session: AwaySummarySession | undefined, now: Date): string {
  if (session === undefined) return 'A session BMN no longer holds'
  const where = `${session.workspace} › ${session.name}`
  return session.archivedAt === null ? where : `${where} (archived ${awayMomentWords(session.archivedAt, now)})`
}

/** Groups items by session in sidebar order; sessions outside the order follow in first-seen order. */
function bySession<T extends { sessionId: string }>(items: readonly T[], order: readonly string[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(item.sessionId, [...(groups.get(item.sessionId) ?? []), item])
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...groups.entries()].sort(([a], [b]) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER))
}

/** The dev-auto line label, as the morning digest reads a run. */
function devAutoLabel(run: DevAutoRunsResult['runs'][number], workspaceNames: Record<string, string>): string {
  const workspace = run.workspaceIds.map((id) => workspaceNames[id] ?? 'Workspace unavailable').join(', ')
  const folder = run.checkout.split('/').filter(Boolean).pop() ?? run.checkout
  return `${workspace} · ${run.branch ?? folder} · ${run.project ?? 'Epics not recorded'}`
}

/**
 * Story 76.6 AC1–AC2: the summary of one period in Fable's order and words. Every row only navigates; nothing answers,
 * dismisses or undoes. Each source keeps its completeness: an incomplete one is named with its reason, a partial count is
 * "at least", and an empty list says only what the sources hold.
 */
export function buildAwaySummary(input: AwaySummaryInput): AwaySummaryView {
  const { away, now } = input
  const sessions = new Map(input.sessions.map((session) => [session.sessionId, session]))
  const name = (sessionId: string): string | null => sessions.get(sessionId)?.name ?? null
  const where = (sessionId: string): string => whereWords(sessions.get(sessionId), now)
  const gaps: Partial<Record<AwaySourceName, AwaySourceGap>> = { ...(input.activity?.gaps ?? {}) }
  if (input.attention === null) gaps.requests = { kind: 'unreadable' }
  if (input.decisions === null) gaps.decisions = { kind: 'unreadable' }
  else if (!input.decisions.complete) gaps.decisions = { kind: 'truncated', at: input.decisions.decisions.length }
  if (input.activity === null) for (const source of ['turns', 'files', 'messages', 'exits'] as const) gaps[source] = { kind: 'unreadable' }
  if (input.devAuto === null) gaps['dev-auto'] = { kind: 'unreadable' }
  else {
    // A folder that is not a Git repository holds no run, so it is not a gap in this list.
    const skipped = input.devAuto.result.skipped - input.devAuto.result.issues.filter((issue) => issue.endsWith(': Not a repository')).length
    if (skipped > 0) gaps['dev-auto'] = { kind: 'partial', read: input.devAuto.result.runs.length, skipped }
  }
  const gapList = SOURCE_ORDER.filter((source) => gaps[source] !== undefined)
  const couldNotRead = gapList.length === 0 ? null
    : `Could not read in full: ${gapList.map((source) => `${SOURCE_WORDS[source]} (${awayGapWords(gaps[source]!)})`).join(', ')}.`

  // Waiting on you: every unresolved request now, those opened before he left marked so.
  const open = input.attention === null ? [] : input.attention.filter((record) => record.state === 'open').toSorted((a, b) => a.openedAt.localeCompare(b.openedAt))
  const since = away.since === null ? Number.NaN : Date.parse(away.since)
  const waitingRows: AwayWaitingRow[] = open.slice(0, AWAY_SUMMARY_LIMITS.waiting).map((record) => {
    const command = record.prompt?.type === 'permission' && record.prompt.command !== null ? record.prompt.command : null
    return {
      requestId: record.requestId, sessionId: record.sessionId, age: awayAgeWords(record.openedAt, now), kind: kindWords(record),
      title: oneLine(command ?? record.title, 200), command: command !== null, before: Date.parse(record.openedAt) < since
    }
  })
  const waiting: AwaySummaryView['waiting'] = {
    open: open.length,
    groups: bySession(waitingRows, input.order).map(([sessionId, rows]) => ({ sessionId, where: where(sessionId), rows })),
    more: open.length > AWAY_SUMMARY_LIMITS.waiting ? `${open.length - AWAY_SUMMARY_LIMITS.waiting} more · Go to next request needing you walks them.` : null,
    empty: input.attention !== null && open.length === 0 ? 'Nothing waits on you.' : null
  }

  // Decided for you: the period's records; a dev-auto entry joined to its record by their recorded identity shows here once.
  const records = (input.decisions?.decisions ?? []).toSorted((a, b) => a.recordedAt.localeCompare(b.recordedAt))
  const keys = new Set(records.map((record) => record.key))
  const shown = records.slice(0, AWAY_SUMMARY_LIMITS.decisions)
  const recordId = (sessionId: string, key: string): string => `${sessionId}\u0000${key}`
  // A record is identified by its session and key, which BMN returns when it records and dev-auto keeps with the entry
  // (`(bmn: SESSION/KEY)`, the consultant's method). An entry joins only that record, only when its key is the one the run's
  // own id and entry id make (dev-auto:<run id>:<entry>), the record names no other workflow entry, and the record is
  // shown; an entry that kept only a key proves nothing and stays apart (Astra's review, finding 4).
  const shownIds = new Map(shown.map((record) => [recordId(record.sessionId, record.key), record]))
  const identity = (run: DevAutoRunsResult['runs'][number], entry: DevAutoRunsResult['runs'][number]['decisionEntries'][number]): string | null => {
    if (run.runId === null || entry.entry === null || entry.bmnSession === null || entry.bmnKey !== `dev-auto:${run.runId}:${entry.entry}`) return null
    const id = recordId(entry.bmnSession, entry.bmnKey)
    const record = shownIds.get(id)
    if (record === undefined || record.references.some((reference) => reference.kind === 'workflow' && reference.id !== entry.bmnKey)) return null
    return id
  }
  const joined = new Set<string>()
  for (const run of input.devAuto?.result.runs ?? []) {
    if (run.ownership === 'copy' || run.unavailable) continue
    for (const entry of run.decisionEntries ?? []) { const id = identity(run, entry); if (id !== null) joined.add(id) }
  }
  // A workflow entry is identified as dev-auto names it (dev-auto:<run id>:<entry>, Story 76.7) and found in a run BMN can read
  // that owns its checkout; the store cannot check it when the record is written, so the summary checks it when it reads.
  const workflowEntry = (id: string): string | null => {
    const [tool, runId, entry] = id.split(':')
    if (tool !== 'dev-auto' || !runId || !entry || id.split(':').length !== 3) return null
    const run = input.devAuto?.result.runs.find((item) => item.runId === runId && item.ownership !== 'copy' && !item.unavailable &&
      (item.decisionEntries ?? []).some((candidate) => candidate.entry === entry))
    return run === undefined ? null : `${devAutoLabel(run, input.devAuto!.workspaceNames)} [${entry}]`
  }
  const decisionView = (record: DecisionRecord): AwayDecisionView => {
    const linked = (reference: DecisionRecord['references'][number]): boolean => reference.kind === 'workflow' ? workflowEntry(reference.id) !== null
      : reference.valid && (reference.kind === 'session' || reference.kind === 'artifact' && input.artifactNames[reference.id] !== undefined)
    const links = record.references.filter(linked).map((reference) => reference.kind === 'session'
      ? { kind: 'session' as const, id: reference.id, text: where(reference.id) }
      : reference.kind === 'workflow' ? { kind: 'workflow' as const, id: reference.id, text: workflowEntry(reference.id)! }
        : { kind: 'artifact' as const, id: reference.id, text: input.artifactNames[reference.id]! })
    const named = record.references.filter((reference) => !linked(reference)).map((reference) => reference.id)
    const last = record.outcomes.at(-1)
    const app = awayAppName(record.agentCli)
    const rows: AwayDecisionRow[] = [
      { label: 'Choice', text: record.choice },
      { label: 'Reason', text: record.reason },
      { label: 'Affects', text: [record.affects, ...named].join(' · '), ...(links.length > 0 ? { links } : {}) },
      ...(record.depends.length > 0 ? [{ label: 'Depends on', text: record.depends.map((key) => `${key} (${keys.has(key) ? 'above' : 'not in this list'})`).join(' · ') }] : []),
      { label: 'To reverse', text: record.reverse },
      last === undefined ? { label: 'Outcome', text: 'Outcome unknown', muted: true }
        : { label: 'Outcome', text: `Agent reported ${last.result} ${clockWords(last.at)}${last.result === 'failed' ? ` · ${last.evidence[0] ?? last.op}` : ''}` },
      { label: 'Recorded', text: `${awayMomentWords(record.recordedAt, now)} by ${name(record.sessionId) ?? 'a session BMN no longer holds'}${app ? ` (${app})` : ''}${joined.has(recordId(record.sessionId, record.key)) ? ' · also in dev-auto\'s handoff' : ''}` }
    ]
    return { key: record.key, sessionId: record.sessionId, time: clockWords(record.recordedAt), choice: oneLine(record.choice.split('\n')[0] ?? '', 160), rows }
  }
  const decided: AwaySummaryView['decided'] = {
    incomplete: gaps.decisions !== undefined,
    groups: bySession(shown.map(decisionView), input.order).map(([sessionId, items]) => ({ sessionId, where: where(sessionId), records: items })),
    more: records.length > AWAY_SUMMARY_LIMITS.decisions ? `${records.length - AWAY_SUMMARY_LIMITS.decisions} more recorded; the list is cut at ${AWAY_SUMMARY_LIMITS.decisions}.` : null,
    empty: input.decisions !== null && input.decisions.complete && records.length === 0 ? 'No BMN decision records for this period.' : null,
    tail: 'Decisions kept only in a workflow\'s own log, and any an agent did not report, are outside this list.'
  }

  // What happened: counts per session, at most eight word lines.
  const atLeast = (source: AwaySourceName): string => gaps[source] !== undefined ? 'at least ' : ''
  const activityBlocks = (input.activity?.sessions ?? []).map((activity) => {
    const lines: string[] = []
    if (activity.turnsEnded > 0) {
      const changed = activity.turnsWithChanges > 0 ? `, ${activity.changesAtLeast ? 'at least ' : ''}${activity.turnsWithChanges} with changed files`
        : activity.changesAtLeast ? ', changed files not all recorded' : ''
      lines.push(`${atLeast('turns')}${plural(activity.turnsEnded, 'turn')} ended${changed}`)
    }
    if (activity.publishedCount > 0) {
      const names = activity.published.slice(0, AWAY_SUMMARY_LIMITS.published)
      lines.push(`Published ${names.join(', ')}${activity.publishedCount > names.length ? ` +${atLeast('files')}${activity.publishedCount - names.length}` : gaps.files !== undefined ? ' and perhaps more' : ''}`)
    }
    if (activity.asksCompleted.length > 0) {
      const roles = [...new Set(activity.asksCompleted)].slice(0, 3)
      lines.push(`${atLeast('asks')}${plural(activity.asksCompleted.length, 'teammate ask')} completed · ${roles.join(', ')}`)
    }
    const counts = (['printed', 'queued', 'uncertain', 'expired'] as const).filter((state) => activity.messages[state] > 0).map((state) => `${activity.messages[state]} ${state}`)
    const handoffs = activity.handoffs.map((handoff) => `Handoff to ${handoff.receiver} ${handoff.state}`)
    if (counts.length > 0 || handoffs.length > 0) lines.push([...(counts.length > 0 ? [`Messages: ${atLeast('messages')}${counts.join(', ')}`] : []), ...handoffs].join(' · '))
    for (const exit of activity.exits) {
      lines.push(`Exited ${clockWords(exit.at)}${exit.code !== null ? ` (exit ${exit.code})` : exit.signal !== null ? ` (signal ${exit.signal})` : ''}`)
    }
    const cut = lines.length > AWAY_SUMMARY_LIMITS.lines
      ? [...lines.slice(0, AWAY_SUMMARY_LIMITS.lines - 1), `${lines.length - AWAY_SUMMARY_LIMITS.lines + 1} more · open its Turn changes, Hook events and Messages`]
      : lines
    const app = awayAppName(activity.app)
    return { sessionId: activity.sessionId, head: `${where(activity.sessionId)}${app ? ` · ${app}` : ''}`, lines: cut }
  }).filter((block) => block.lines.length > 0)
  const rank = new Map(input.order.map((id, index) => [id, index]))
  activityBlocks.sort((a, b) => (rank.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER))
  const activityGaps = (['turns', 'changes', 'files', 'messages', 'asks', 'exits'] as const).some((source) => gaps[source] !== undefined)
  const happened: AwaySummaryView['happened'] = {
    incomplete: activityGaps,
    blocks: activityBlocks.slice(0, AWAY_SUMMARY_LIMITS.sessions),
    more: activityBlocks.length > AWAY_SUMMARY_LIMITS.sessions ? `${activityBlocks.length - AWAY_SUMMARY_LIMITS.sessions} more sessions · not shown` : null,
    empty: activityBlocks.length > 0 ? null
      : activityGaps ? 'No retained activity found for this period; some sources could not be read.' : 'No retained activity found for this period.'
  }

  // Now: dev-auto's current Finished, Blocked and Decided for you, undated; joined entries show above, not here.
  const nowLines: string[] = []
  let legacy = false
  for (const run of input.devAuto?.result.runs ?? []) {
    if (run.ownership === 'copy' || run.unavailable) continue
    const label = devAutoLabel(run, input.devAuto!.workspaceNames)
    if (run.finished) nowLines.push(`${label}: Finished`)
    if (/^BLOCKED\b/i.test(run.status ?? '')) nowLines.push(`${label}: ${oneLine(run.status ?? '', 220)}`)
    run.decisions.forEach((decision, index) => {
      const entry = run.decisionEntries?.[index]
      if (entry !== undefined && identity(run, entry) !== null) return
      if (!entry || entry.entry === null || (entry.bmnKey !== null && entry.bmnSession === null)) legacy = true
      nowLines.push(`${label}: ${oneLine(decision, 220)}`)
    })
  }
  const nowView: AwaySummaryView['now'] = {
    lines: nowLines.slice(0, AWAY_SUMMARY_LIMITS.now),
    legacy: legacy ? 'Entries without an identity may repeat a record above.' : null,
    more: nowLines.length > AWAY_SUMMARY_LIMITS.now ? `${nowLines.length - AWAY_SUMMARY_LIMITS.now} more · dev-auto runs…` : null,
    empty: nowLines.length === 0 ? 'No dev-auto run that BMN could read reports anything now.' : null,
    incomplete: gaps['dev-auto'] !== undefined
  }

  return {
    label: away.state === 'away' ? 'While you are away' : 'While you were away',
    head: awayHeadWords(away, now, name),
    note: away.note,
    couldNotRead,
    waiting,
    decided,
    happened,
    now: nowView
  }
}

/**
 * Story 76.6 AC4: Waiting on you for the `/back` reply: up to ten "Session: title" lines, each part through the phone's own
 * masking and bound (`field`), oldest first; the rest is said as a count.
 */
export function awayTelegramWaiting(
  attention: readonly AttentionRecord[],
  sessionName: (sessionId: string) => string | null,
  field: (text: string, limit: number) => string
): { lines: string[]; more: number } {
  const open = attention.filter((record) => record.state === 'open').toSorted((a, b) => a.openedAt.localeCompare(b.openedAt))
  const lines = open.slice(0, AWAY_SUMMARY_LIMITS.telegramWaiting).map((record) => {
    const command = record.prompt?.type === 'permission' && record.prompt.command !== null ? record.prompt.command : null
    return `${field(sessionName(record.sessionId) ?? 'A session', AWAY_SUMMARY_LIMITS.telegramSession)}: ${field(command ?? record.title, AWAY_SUMMARY_LIMITS.telegramTitle)}`
  })
  return { lines, more: open.length - lines.length }
}
