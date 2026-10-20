// MODULE: away-summary.ts - "While you were away": one period's summary in Fable's words and bounds, from what each source holds (Story 76.6)
import { ROSTER_APP_NAMES, type RosterHarness, type TeamAskLine } from './agents-roster'
import { awayDurationWords, awayMomentWords, awayPeriodWords, type DecisionRecord, type OwnerAwayView } from './away'
import type { AttentionKind, AttentionRecord } from './companion'
import type { DevAutoRunsResult } from './dev-auto'
import { awayGrantSection, type AwayGrantSection } from './away-grant-summary'
import type { GrantCarried, GrantPeriod } from './grant'
import { pad } from './shared-helpers'

/** Fable's bounds (Story 76.1 §4–5). */
export const AWAY_SUMMARY_LIMITS = Object.freeze({
  waiting: 40, wentOn: 500, decisions: 30, sessions: 20, lines: 8, published: 3, runs: 20, telegramWaiting: 10, telegramWentOn: 10,
  telegramSession: 120, telegramTitle: 220,
  /** Story 84.8 [d29]: a request he answered himself shows in Waited for you when it waited this long; a short wait is the system working. */
  longWaitMinutes: 30, answeredWaits: 20
})

/** The sources the summary reads; each says on its own whether it was read in full. */
export type AwaySourceName = 'requests' | 'went-on' | 'answered-waits' | 'decisions' | 'turns' | 'changes' | 'files' | 'messages' | 'asks' | 'exits' | 'dev-auto' | 'grants'
const SOURCE_WORDS: Readonly<Record<AwaySourceName, string>> = Object.freeze({
  requests: 'requests', 'went-on': 'requests closed without you', 'answered-waits': 'long waits you answered', decisions: 'decision records', turns: 'turn endings', changes: 'turn changes', files: 'published files', messages: 'messages',
  asks: 'teammate asks', exits: 'session exits', 'dev-auto': 'dev-auto runs', grants: 'grant records'
})
const SOURCE_ORDER: readonly AwaySourceName[] = Object.freeze(['requests', 'went-on', 'answered-waits', 'decisions', 'turns', 'changes', 'files', 'messages', 'asks', 'exits', 'dev-auto', 'grants'])

/** Why a source was not read in full: missing, unreadable, partial, truncated or no longer retained are told apart. */
export type AwaySourceGap =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'partial'; read: number; skipped: number }
  | { kind: 'truncated'; at: number }
  | { kind: 'expired' }

/** A gap in Fable's reason words. */
function awayGapWords(gap: AwaySourceGap): string {
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
  // Agents › Asks keeps a record its own number of days: a period that began before that may have lost some.
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
  /**
   * The period's questions, permissions and reviews that closed without his answer, oldest first (Epic 78, owner
   * 2026-10-17: "If the work continues and I'm away I want to receive all cards in the end when I'm back"); null when
   * they could not be read.
   */
  wentOn: { records: AttentionRecord[]; complete: boolean; total: number } | null
  /**
   * The period's questions, permissions and reviews he answered himself after a long wait, oldest first (Story 84.8 [d29]);
   * null when they could not be read. Absent from a host that predates it, which reads as none.
   */
  answeredWaits?: { records: AttentionRecord[]; complete: boolean; total: number } | null
  activity: AwayPeriodActivity | null
  /** Names of the published files that decision references point at and BMN found. */
  artifactNames: Record<string, string>
  /**
   * The kept grant periods up to this one, oldest first, and the rounds carried from periods no longer kept (Story 84.7);
   * null when the grant record could not be read. Absent from a host that predates Epic 84, which reads as no grant.
   */
  grants?: { periods: GrantPeriod[]; carried?: GrantCarried[] } | null
}

export interface AwaySummaryInput extends AwaySummaryPayload {
  now: Date
  /** BMN's requests as the app holds them now; null when they could not be read. */
  attention: readonly AttentionRecord[] | null
  devAuto: { result: DevAutoRunsResult; workspaceNames: Record<string, string> } | null
}

interface AwayWaitingRow {
  requestId: string
  sessionId: string
  age: string
  kind: string
  title: string
  /** A command an agent could not run: shown in mono, one line. */
  command: boolean
  before: boolean
}
interface AwayWentOnRow {
  requestId: string
  sessionId: string
  /** When it closed. */
  time: string
  kind: string
  title: string
  command: boolean
  /** How it closed without him. */
  how: string
}
interface AwayWaitedRow {
  requestId: string
  sessionId: string
  kind: string
  title: string
  command: boolean
  /** How long it waited: "8 h 4 min". */
  waited: string
  /** Which of his routes answered it and when: "answered at the terminal 05:42". */
  how: string
}
/** A link opens a session, a published file or a dev-auto run BMN validated; anything else stays words. */
export interface AwayDecisionRow { label: string; text: string; muted?: boolean; links?: Array<{ kind: 'session' | 'artifact' | 'workflow'; id: string; text: string }> }
interface AwayDecisionView { key: string; sessionId: string; time: string; choice: string; rows: AwayDecisionRow[] }
/** One dev-auto run, once: a short title, its state and one line; the rest opens in place (Fable's redesign 2026-10-18). */
interface AwayRunRow { key: string; title: string; state: 'blocked' | 'finished'; text: string; full: string; rows: AwayDecisionRow[] }
/** One session's activity as one line; every count it holds is in `lines`. */
interface AwayActivityRow { sessionId: string; where: string; text: string; lines: string[] }

export interface AwaySummaryView {
  label: 'While you were away' | 'While you are away'
  head: string
  note: string | null
  couldNotRead: string | null
  /** Each unread source with its reason, for the tooltip. */
  couldNotReadWhy: string | null
  waiting: { open: number; groups: Array<{ sessionId: string; where: string; rows: AwayWaitingRow[] }>; more: string | null; empty: string | null }
  wentOn: { count: number; incomplete: boolean; groups: Array<{ sessionId: string; where: string; rows: AwayWentOnRow[] }>; more: string | null; empty: string | null }
  /** Requests that waited long and that he answered himself; hidden when none (Story 84.8 [d29]). */
  waitedForYou: { count: number; groups: Array<{ sessionId: string; where: string; rows: AwayWaitedRow[] }>; more: string | null }
  decided: { incomplete: boolean; groups: Array<{ sessionId: string; where: string; records: AwayDecisionView[] }>; more: string | null; empty: string | null; tail: string }
  /** Runs blocked now, whenever they stopped: each waits on someone. */
  stuck: { rows: AwayRunRow[]; more: string | null; empty: string | null }
  /** Runs that finished in this period; older finished runs are not news. */
  finished: { rows: AwayRunRow[]; more: string | null; empty: string | null }
  /** What each run's card granted and what the night used of it; null in a period with no grant (Story 84.7 AC2). */
  granted: AwayGrantSection | null
  activity: { rows: AwayActivityRow[]; more: string | null; empty: string | null }
}

/** The request card's own kind words (session-request-card.tsx). */
const KIND_WORDS: Readonly<Record<AttentionKind, string>> = Object.freeze({
  question: 'Question', permission: 'Permission', review: 'Review', notice: 'Update', handoff: 'Handoff'
})
const kindWords = (record: AttentionRecord): string => record.manualChoices
  ? record.kind === 'permission' ? 'Manual decision' : 'Manual question'
  : KIND_WORDS[record.kind] ?? record.kind
const clockWords = (iso: string): string => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '--:--' : `${pad(at.getHours())}:${pad(at.getMinutes())}`
}
const pluralWithMany = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`
const oneLine = (text: string, limit: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** What a request shows as its subject: the exact command of a permission, else its title. */
const requestSubject = (record: AttentionRecord): { text: string; command: boolean } => {
  const command = record.prompt?.type === 'permission' && record.prompt.command !== null ? record.prompt.command : null
  return command !== null ? { text: command, command: true } : { text: record.title, command: false }
}

/** The origins that are the owner himself: what one of them closed was answered, not gone on without him. */
export const AWAY_OWNER_ORIGINS = Object.freeze(['owner', 'input', 'telegram'] as const)

/** What the store says of a dialog the agent's next one replaced in its slot (Epic 78). */
export const AWAY_REPLACED_RESOLUTION = 'Replaced by the agent\'s next prompt'

/** How a request closed without his answer, from what closed it. */
export function awayWentOnWords(record: Pick<AttentionRecord, 'state' | 'resolvedBy' | 'resolution'>): string {
  if (record.state === 'expired') return 'Expired unanswered'
  if (record.resolution === AWAY_REPLACED_RESOLUTION) return AWAY_REPLACED_RESOLUTION
  const by = record.resolvedBy ?? ''
  if (by === 'cli') return 'Withdrawn by the agent'
  const event = /^hook:[^:]+:(.+)$/.exec(by)?.[1]
  switch (event) {
    case 'Stop': return 'Closed when the agent ended its turn'
    case 'SessionEnd': return 'Closed when the session ended'
    case 'UserPromptSubmit': return 'Closed by a new message to the agent'
    case undefined: return 'Closed without your answer'
    default: return 'Closed when the agent went on'
  }
}

/** Which of his own routes answered a request (AWAY_OWNER_ORIGINS). */
const ANSWERED_WORDS: Readonly<Record<(typeof AWAY_OWNER_ORIGINS)[number], string>> = Object.freeze({
  owner: 'answered in BMN', input: 'answered at the terminal', telegram: 'answered from your phone'
})

/** An app's name from its harness id; another id stands as itself. */
function awayAppName(app: string | null): string | null {
  if (app === null) return null
  return (ROSTER_APP_NAMES as Record<string, string>)[app as RosterHarness] ?? app
}

/** How long a request has waited: "now", "5 min", "3 h", "2 d". */
function awayAgeWords(openedAt: string, now: Date): string {
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
function awayHeadWords(away: Pick<OwnerAwayView, 'state' | 'since' | 'endedAt' | 'source' | 'endedBy' | 'agentSessionId'>, now: Date, sessionName: (sessionId: string) => string | null): string {
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

/**
 * A run's short title: its epics and a name, "Epic 9 · recognise and hold", never the run brief. The name is the branch's
 * last part without its epic number or date, else the words after the first epic in the brief, else the checkout folder.
 */
export function devAutoTitle(run: Pick<DevAutoRunsResult['runs'][number], 'project' | 'branch' | 'checkout'>): string {
  const brief = (run.project ?? '').split(/\.\s/u)[0] ?? ''
  const epics = [...new Set([...brief.matchAll(/\bEpics?\s+(\d+(?:\s*[-–]\s*\d+)?)/giu)].map((match) => match[1]!.replace(/\s+/gu, '')))].slice(0, 4)
  const tail = (run.branch ?? '').split('/').pop() ?? ''
  let name = tail.replace(/(?:^|-)\d{4}-\d{2}-\d{2}$/u, '')
  for (let previous = ''; previous !== name;) { previous = name; name = name.replace(/^(?:qa-)?(?:epic-?|e)?\d+(?:-|$)/iu, '').replace(/^epic$/iu, '') }
  name = name.replace(/[-_]+/gu, ' ').trim()
  if (name === '') {
    const words = /\bEpic\s+\d+(?!\d)\s*(?:\(([^)]{1,48})\)|([^();,.\n\d][^();,.\n]{0,47}))/iu.exec(brief)
    name = (words?.[1] ?? words?.[2] ?? '').trim().replace(/\s+(?:then|and|then\s+Epic)$/iu, '')
  }
  const head = epics.length === 0 ? '' : `${epics.length === 1 ? 'Epic' : 'Epics'} ${epics.join(', ')}`
  const title = [head, name].filter(Boolean).join(' · ')
  return oneLine(title || (run.checkout.split('/').filter(Boolean).pop() ?? run.checkout), 80)
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
  if (input.wentOn === null) gaps['went-on'] = { kind: 'unreadable' }
  else if (!input.wentOn.complete) gaps['went-on'] = { kind: 'truncated', at: input.wentOn.records.length }
  const wentOnTotal = input.wentOn === null ? 0 : Math.max(input.wentOn.total, input.wentOn.records.length)
  if (input.answeredWaits === null) gaps['answered-waits'] = { kind: 'unreadable' }
  else if (input.answeredWaits !== undefined && !input.answeredWaits.complete) gaps['answered-waits'] = { kind: 'truncated', at: input.answeredWaits.records.length }
  if (input.decisions === null) gaps.decisions = { kind: 'unreadable' }
  else if (!input.decisions.complete) gaps.decisions = { kind: 'truncated', at: input.decisions.decisions.length }
  if (input.activity === null) for (const source of ['turns', 'files', 'messages', 'exits'] as const) gaps[source] = { kind: 'unreadable' }
  if (input.grants === null) gaps.grants = { kind: 'unreadable' }
  if (input.devAuto === null) gaps['dev-auto'] = { kind: 'unreadable' }
  else {
    // A folder that is not a Git repository holds no run, and a run whose board cannot be read is still read whole (the
    // summary shows no board), so neither is a gap in this list.
    const skipped = input.devAuto.result.skipped - input.devAuto.result.issues.filter((issue) => issue.endsWith(': Not a repository') || issue.includes(': Board unavailable')).length
    if (skipped > 0) gaps['dev-auto'] = { kind: 'partial', read: input.devAuto.result.runs.length, skipped }
  }
  const gapList = SOURCE_ORDER.filter((source) => gaps[source] !== undefined)
  // One plain line; each source's reason stays in the tooltip.
  const couldNotRead = gapList.length === 0 ? null
    : `Not fully read: ${gapList.map((source) => SOURCE_WORDS[source]).join(', ')} · counts there may be low.`
  const couldNotReadWhy = gapList.length === 0 ? null : gapList.map((source) => `${SOURCE_WORDS[source]}: ${awayGapWords(gaps[source]!)}`).join('\n')

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
    more: open.length > AWAY_SUMMARY_LIMITS.waiting ? `${open.length - AWAY_SUMMARY_LIMITS.waiting} more · Go to next request needing you reaches each one.` : null,
    empty: input.attention !== null && open.length === 0 ? 'Nothing waits on you.' : null
  }

  // Went on without you: every card of the period that closed without his answer, so none is lost while he was away;
  // the host reads up to the bound, all of it shown, and counts the rest exactly.
  const closed = input.wentOn?.records ?? []
  const wentOnRows: AwayWentOnRow[] = closed.map((record) => {
    const subject = requestSubject(record)
    return {
      requestId: record.requestId, sessionId: record.sessionId, time: clockWords(record.resolvedAt ?? record.openedAt), kind: kindWords(record),
      title: oneLine(subject.text, 200), command: subject.command, how: awayWentOnWords(record)
    }
  })
  const wentOn: AwaySummaryView['wentOn'] = {
    count: wentOnTotal,
    incomplete: gaps['went-on'] !== undefined,
    groups: bySession(wentOnRows, input.order).map(([sessionId, rows]) => ({ sessionId, where: where(sessionId), rows })),
    more: wentOnTotal > closed.length ? `${wentOnTotal - closed.length} more closed than this list holds; the oldest ${closed.length} are shown.` : null,
    empty: input.wentOn !== null && closed.length === 0 ? 'No card closed without you.' : null
  }

  // Waited for you: a request that waited long and that he answered himself, often just before Back, so a run's stall
  // shows even when nothing needs him now (Story 84.8 [d29]).
  const answered = input.answeredWaits?.records ?? []
  const answeredTotal = Math.max(input.answeredWaits?.total ?? 0, answered.length)
  const waitedRows: AwayWaitedRow[] = answered.map((record) => {
    const subject = requestSubject(record)
    const route = ANSWERED_WORDS[record.resolvedBy as keyof typeof ANSWERED_WORDS] ?? 'answered'
    return {
      requestId: record.requestId, sessionId: record.sessionId, kind: kindWords(record), title: oneLine(subject.text, 200), command: subject.command,
      waited: awayDurationWords(record.openedAt, record.resolvedAt ?? record.openedAt), how: `${route} ${clockWords(record.resolvedAt ?? record.openedAt)}`
    }
  })
  const waitedForYou: AwaySummaryView['waitedForYou'] = {
    count: answeredTotal,
    groups: bySession(waitedRows, input.order).map(([sessionId, rows]) => ({ sessionId, where: where(sessionId), rows })),
    more: answeredTotal > answered.length ? `${answeredTotal - answered.length} more waited; the oldest ${answered.length} are shown.` : null
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
    return run === undefined ? null : `${devAutoTitle(run)} [${entry}]`
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
    more: records.length > AWAY_SUMMARY_LIMITS.decisions ? `${records.length - AWAY_SUMMARY_LIMITS.decisions} more · list cut at ${AWAY_SUMMARY_LIMITS.decisions}` : null,
    empty: input.decisions !== null && input.decisions.complete && records.length === 0 ? 'No BMN decision records for this period.' : null,
    tail: 'Decisions kept only in a workflow\'s own log, and any an agent did not report, are outside this list.'
  }

  // Activity: one line per session, counts only; a count past a gap is "≥".
  const atLeast = (source: AwaySourceName): string => gaps[source] !== undefined ? '≥' : ''
  const activityRows = (input.activity?.sessions ?? []).map((activity): AwayActivityRow => {
    const lines: string[] = []
    if (activity.turnsEnded > 0) {
      const changed = activity.turnsWithChanges > 0 ? `, ${activity.changesAtLeast ? '≥' : ''}${activity.turnsWithChanges} changed files` : ''
      lines.push(`${atLeast('turns')}${pluralWithMany(activity.turnsEnded, 'turn')}${changed}`)
    }
    if (activity.publishedCount > 0) {
      const names = activity.published.slice(0, AWAY_SUMMARY_LIMITS.published)
      lines.push(`published ${names.join(', ')}${activity.publishedCount > names.length ? ` +${atLeast('files')}${activity.publishedCount - names.length}` : ''}`)
    }
    if (activity.asksCompleted.length > 0) {
      const roles = [...new Set(activity.asksCompleted)].slice(0, 3)
      lines.push(`${atLeast('asks')}${pluralWithMany(activity.asksCompleted.length, 'ask')} answered (${roles.join(', ')})`)
    }
    const counts = (['printed', 'queued', 'uncertain', 'expired'] as const).filter((state) => activity.messages[state] > 0).map((state) => `${activity.messages[state]} ${state}`)
    if (counts.length > 0) lines.push(`${atLeast('messages')}messages ${counts.join(', ')}`)
    for (const handoff of activity.handoffs) lines.push(`handoff to ${handoff.receiver} ${handoff.state}`)
    for (const exit of activity.exits) {
      lines.push(`exited ${clockWords(exit.at)}${exit.code !== null ? ` (code ${exit.code})` : exit.signal !== null ? ` (signal ${exit.signal})` : ''}`)
    }
    const app = awayAppName(activity.app)
    const shown = lines.length > AWAY_SUMMARY_LIMITS.lines ? [...lines.slice(0, AWAY_SUMMARY_LIMITS.lines - 1), `${lines.length - AWAY_SUMMARY_LIMITS.lines + 1} more`] : lines
    return { sessionId: activity.sessionId, where: `${where(activity.sessionId)}${app ? ` · ${app}` : ''}`, text: shown.join(' · '), lines }
  }).filter((row) => row.lines.length > 0)
  const rank = new Map(input.order.map((id, index) => [id, index]))
  activityRows.sort((a, b) => (rank.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER))
  const activityView: AwaySummaryView['activity'] = {
    rows: activityRows.slice(0, AWAY_SUMMARY_LIMITS.sessions),
    more: activityRows.length > AWAY_SUMMARY_LIMITS.sessions ? `${activityRows.length - AWAY_SUMMARY_LIMITS.sessions} more sessions` : null,
    empty: activityRows.length > 0 ? null : 'No session activity recorded.'
  }

  // Dev-auto runs, one row each: blocked now, or finished in this period. Their own decisions open with the row.
  const periodStart = away.since ?? now.toISOString()
  const periodEnd = away.state === 'away' || away.endedAt === null ? now.toISOString() : away.endedAt
  const runs = (input.devAuto?.result.runs ?? []).filter((run) => run.ownership !== 'copy' && !run.unavailable)
  const spansWorkspaces = new Set(runs.flatMap((run) => run.workspaceIds)).size > 1
  const runRow = (run: DevAutoRunsResult['runs'][number], state: AwayRunRow['state']): AwayRunRow => {
    const workspace = run.workspaceIds.map((id) => input.devAuto!.workspaceNames[id] ?? 'Workspace unavailable').join(', ')
    const title = `${spansWorkspaces ? `${workspace} · ` : ''}${devAutoTitle(run)}`
    const note = (run.status ?? '').replace(/^(?:BLOCKED|COMPLETE)\b\s*[—–:;.,-]*\s*/iu, '')
    const text = note !== '' ? oneLine(note, 200) : run.decisions.length > 0 ? pluralWithMany(run.decisions.length, 'decision') + ' recorded' : ''
    const rows: AwayDecisionRow[] = [
      { label: 'Run', text: run.project ?? 'Epics not recorded' },
      { label: 'Status', text: run.status ?? 'Not recorded' },
      ...(run.nextAction !== null && state === 'blocked' ? [{ label: 'Next', text: run.nextAction }] : []),
      ...(run.decisions.length > 0 ? [{ label: 'Decided', text: run.decisions.join('\n') }] : []),
      { label: 'Where', text: `${run.branch ?? 'no branch'} · ${run.checkout}${run.updatedAt ? ` · changed ${awayMomentWords(run.updatedAt, now)}` : ''}`, muted: true,
        links: [{ kind: 'workflow', id: run.runId ?? run.checkout, text: 'Open in dev-auto runs' }] }
    ]
    return { key: `${run.runId ?? ''}\u0000${run.checkout}`, title, state, text, full: run.project ?? title, rows }
  }
  const inPeriod = (run: DevAutoRunsResult['runs'][number]): boolean => typeof run.updatedAt === 'string' && run.updatedAt >= periodStart && run.updatedAt <= periodEnd
  const stuckRows = runs.filter((run) => !run.finished && /^BLOCKED\b/iu.test(run.status ?? '')).map((run) => runRow(run, 'blocked'))
  const finishedRows = runs.filter((run) => run.finished && inPeriod(run)).map((run) => runRow(run, 'finished'))
  const runsUnread = input.devAuto === null
  const stuck: AwaySummaryView['stuck'] = {
    rows: stuckRows.slice(0, AWAY_SUMMARY_LIMITS.runs),
    more: stuckRows.length > AWAY_SUMMARY_LIMITS.runs ? `${stuckRows.length - AWAY_SUMMARY_LIMITS.runs} more · dev-auto runs…` : null,
    empty: stuckRows.length > 0 ? null : runsUnread ? 'Dev-auto runs could not be read.' : 'No run is stuck.'
  }
  const finished: AwaySummaryView['finished'] = {
    rows: finishedRows.slice(0, AWAY_SUMMARY_LIMITS.runs),
    more: finishedRows.length > AWAY_SUMMARY_LIMITS.runs ? `${finishedRows.length - AWAY_SUMMARY_LIMITS.runs} more · dev-auto runs…` : null,
    empty: finishedRows.length > 0 ? null : runsUnread ? 'Dev-auto runs could not be read.' : 'No run finished while you were away.'
  }

  return {
    label: away.state === 'away' ? 'While you are away' : 'While you were away',
    head: awayHeadWords(away, now, name),
    note: away.note,
    couldNotRead,
    couldNotReadWhy,
    waiting,
    waitedForYou,
    stuck,
    finished,
    granted: awayGrantSection(input.grants === undefined ? [] : input.grants === null ? null : input.grants.periods, away.periodId, now, input.grants?.carried ?? []),
    wentOn,
    decided,
    activity: activityView
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

/**
 * The `/back` reply's Went on without you (Epic 78, owner 2026-10-17): up to ten "Session: subject (how)" lines of the
 * period's cards that closed without his answer, oldest first, each part through the phone's masking and bound.
 */
export function awayTelegramWentOn(
  records: readonly AttentionRecord[],
  sessionName: (sessionId: string) => string | null,
  field: (text: string, limit: number) => string
): { lines: string[]; more: number } {
  const lines = records.slice(0, AWAY_SUMMARY_LIMITS.telegramWentOn).map((record) =>
    `${field(sessionName(record.sessionId) ?? 'A session', AWAY_SUMMARY_LIMITS.telegramSession)}: ${field(requestSubject(record).text, AWAY_SUMMARY_LIMITS.telegramTitle)} (${awayWentOnWords(record)})`)
  return { lines, more: records.length - lines.length }
}
