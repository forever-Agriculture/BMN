// MODULE: now.ts - Story 110.9: the Now sheet's rows and its standup text, one builder for the owner's sheet and `bmn now`
//
// The owner's sheet (renderer) and an agent's `bmn now` (host) hand this module what each of them knows about the sessions
// and the dev-auto runs; it decides every row, section, word and the standup text, so the clipboard and the CLI cannot drift.
// Design: .dev-auto/evidence/110/now-design/index.html (approved "as drawn", 2026-11-06), its `standupLine`/`standupText`.
import type { DevAutoFinishedStory, DevAutoRun } from './dev-auto'

/** BMN's own status marks (`.status-dot.*`), as the sidebar draws them. */
export type NowDot = 'running' | 'running-idle' | 'needs-you' | 'idle' | 'exited'
/** D10: the owner sees every workspace and card titles; an agent its own workspace, states and labels only. */
export type NowAudience = 'owner' | 'agent'

export interface NowSessionInput {
  sessionId: string
  workspaceId: string
  name: string
  /** The sidebar's mark for this session. */
  dot: NowDot
  live: boolean
  /** Started at all: a session never started reads "Not started", not "Stopped". */
  started: boolean
  /** An agent is in front of the terminal (its hooks or its launch say so); a live session without one is a plain shell. */
  agent: boolean
  /** The terminal printed lately (Working), as the sidebar's filled mark says. */
  working: boolean
  /** The newest `bmn progress` label of this run, if any. */
  progressLabel: string | null
  /** The terminal title the agent set, if any. */
  title: string | null
  /** The open card that waits on the owner; its title is dropped for an agent's view. */
  card: { requestId: string; title: string } | null
}

export interface NowInput {
  now: Date
  audience: NowAudience
  /** In sidebar order; only these are covered. */
  workspaces: ReadonlyArray<{ workspaceId: string; name: string }>
  /** In sidebar order within each workspace, archived ones left out. */
  sessions: readonly NowSessionInput[]
  /** null while the first read of the runs has not returned. */
  runs: readonly DevAutoRun[] | null
  /** For folders shown as `~/…`. */
  home?: string | null
}

export interface NowFoldRow {
  label: string
  value: string
  /** A card's title is a button that opens its session; a path is set in the mono face. */
  kind?: 'card' | 'path'
}

export type NowSectionId = 'you' | 'project' | 'not-running'

export interface NowRow {
  /** `s:<sessionId>` for a session, `r:<checkout>` for a run with no session row. */
  key: string
  sessionId: string | null
  workspaceId: string | null
  section: NowSectionId
  name: string
  dot: NowDot
  /** The Doing column's words, without the count. */
  doing: string
  /** The run's current story, `110.3 time-left range`; null without a run or a readable board. */
  story: string | null
  /** `2 of 3` stories done. */
  of: string | null
  /** A session without a run: the words its standup line says; null leaves it out. */
  say: string | null
  stopped: boolean
  done: boolean
  stale: boolean
  noSession: boolean
  /** Waits on: `you: <card>` for the owner, `the owner` for an agent, the handoff's words, `unknown`, or blank. */
  who: string
  you: boolean
  unknown: boolean
  /** `about 2-4 h`, `about 1-2 days`, `done`, or null for no estimate. */
  left: string | null
  /** Waits on is not blank, so the range is work only. */
  plus: boolean
  cardRequestId: string | null
  /** The row's explanation, label and value rows; empty for an agent's view and for a row with nothing to explain. */
  fold: NowFoldRow[]
}

export interface NowSection {
  id: string
  kind: NowSectionId
  title: string
  workspaceId: string | null
  keys: string[]
}

export interface NowView {
  now: Date
  audience: NowAudience
  rows: NowRow[]
  sections: NowSection[]
  /** Sessions outside Not running. */
  sessions: number
  waiting: number
  agentRunning: boolean
  loading: boolean
  /** Per workspace: the story ids finished since the start of the previous working day, oldest first. */
  doneSince: Record<string, string[]>
  /** The previous working day's short name, `Wed`. */
  sinceDay: string
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const HOUR = 3_600_000
const DAY = 24 * HOUR
const pad2 = (value: number): string => String(value).padStart(2, '0')

/** `09:40`, local time. */
export function nowClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** `Thu 5 Nov, 09:40`, local time. */
export function nowStamp(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}, ${nowClock(date)}`
}

/** `2 Nov`, local time. */
function dayMonth(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

/** The start (local midnight) of the previous working day: Monday looks back to Friday, the weekend to Friday too. */
export function previousWorkingDay(now: Date): Date {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const back = { 0: 2, 1: 3, 6: 1 }[day.getDay()] ?? 1
  day.setDate(day.getDate() - back)
  return day
}

/** `40 min`, `1 h`, `1 h 20`. */
export function durationWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest}`
}

/** The finished stories' durations that are real (FINISHED after STARTED), in milliseconds. */
export function storyDurations(stories: readonly DevAutoFinishedStory[]): number[] {
  return stories.flatMap((story) => {
    const took = Date.parse(story.finishedAt) - Date.parse(story.startedAt)
    return Number.isFinite(took) && took > 0 ? [took] : []
  })
}

/**
 * Rule 5 of the brief: low = fastest × stories left, high = slowest × stories left; whole hours under a day, days at
 * 24 h and over, never one number. null when it cannot be said (fewer than two finished stories, nothing left).
 */
export function leftRange(durations: readonly number[], storiesLeft: number): string | null {
  if (durations.length < 2 || !Number.isInteger(storiesLeft) || storiesLeft < 1) return null
  const low = Math.min(...durations) * storiesLeft
  const high = Math.max(...durations) * storiesLeft
  if (high >= DAY) {
    const from = Math.max(1, Math.floor(low / DAY))
    return `about ${from}-${Math.max(from + 1, Math.ceil(high / DAY))} days`
  }
  const from = Math.max(1, Math.floor(low / HOUR))
  return `about ${from}-${Math.max(from + 1, Math.ceil(high / HOUR))} h`
}

interface StoryRow { id: string; title: string; status: string; epic: number; number: number }
interface StoryBoard { rows: StoryRow[]; current: StoryRow | null; done: number; total: number }

const STORY_KEY = /^(\d{1,6})-(\d{1,4})-([a-z0-9][a-z0-9-]*)$/iu
const NOT_STORIES = new Set(['dropped', 'optional'])
const IN_PROGRESS = new Set(['in-progress', 'review'])

/** The board's story rows of the run's epics: key `110-9-now-where-every-session-is` reads as story `110.9`. */
function storyBoard(run: DevAutoRun): StoryBoard {
  const rows = run.board.rows.flatMap((row): StoryRow[] => {
    const match = STORY_KEY.exec(row.key)
    if (!match || NOT_STORIES.has(row.status) || /retrospective$/u.test(row.key)) return []
    return [{ id: `${Number(match[1])}.${Number(match[2])}`, title: match[3]!.replace(/-+/gu, ' ').trim(), status: row.status,
      epic: Number(match[1]), number: Number(match[2]) }]
  }).toSorted((left, right) => left.epic - right.epic || left.number - right.number)
  const open = rows.filter((row) => row.status !== 'done')
  return { rows, current: open.find((row) => IN_PROGRESS.has(row.status)) ?? open[0] ?? null,
    done: rows.length - open.length, total: rows.length }
}

const statusWord = (status: string): string => status === 'in-progress' ? 'in progress' : status === 'review' ? 'in review'
  : ['backlog', 'ready', 'ready-for-dev', 'drafted', 'contexted'].includes(status) ? 'not started' : status

/** `40.1 to 40.4`, `41.1 and 41.2`, `40.5`, or a count once there are more than two that do not run on. */
function storyList(rows: readonly StoryRow[]): string {
  if (rows.length === 1) return rows[0]!.id
  if (rows.length === 2) return `${rows[0]!.id} and ${rows[1]!.id}`
  const runOn = rows.every((row, index) => index === 0 || row.epic === rows[0]!.epic && row.number === rows[index - 1]!.number + 1)
  return runOn ? `${rows[0]!.id} to ${rows.at(-1)!.id}` : String(rows.length)
}

/** "40.1 to 40.4 done, 40.5 in progress, 40.6 and 40.7 not started." */
function storiesWords(board: StoryBoard): string {
  const groups: Array<{ word: string; rows: StoryRow[] }> = []
  for (const row of board.rows) {
    const word = row.status === 'done' ? 'done' : statusWord(row.status)
    const last = groups.at(-1)
    if (last && last.word === word) last.rows.push(row)
    else groups.push({ word, rows: [row] })
  }
  return `${groups.map((group) => `${storyList(group.rows)} ${group.word}`).join(', ')}.`
}

/** A decision as the owner reads it: without its `[dN]` entry id and its `(bmn: …)` record. */
function decisionWords(text: string): string {
  return text.replace(/^\[d\d{1,4}\]\s*/u, '').replace(/\s*\(bmn: [^)]*\)\s*$/u, '').trim()
}

function folder(path: string, home: string | null | undefined): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`
  return path
}

function lastFinished(run: DevAutoRun): Date | null {
  const times = (run.finishedStories ?? []).map((story) => Date.parse(story.finishedAt)).filter(Number.isFinite)
  if (times.length > 0) return new Date(Math.max(...times))
  const updated = run.updatedAt ? Date.parse(run.updatedAt) : Number.NaN
  return Number.isFinite(updated) ? new Date(updated) : null
}

interface RowContext { audience: NowAudience; home: string | null | undefined }

/** The words of the card a session waits on, for this audience. */
function youWho(card: NonNullable<NowSessionInput['card']>, audience: NowAudience): string {
  return audience === 'agent' ? 'the owner' : `you: ${card.title}`
}

function timeLeftWords(p: { left: string | null; durations: number[]; storiesLeft: number; stopped: boolean; live: boolean;
  noSession: boolean; who: string; you: boolean; audience: NowAudience; boardUnavailable: boolean }): string {
  if (p.left) {
    const fastest = durationWords(Math.min(...p.durations))
    const slowest = durationWords(Math.max(...p.durations))
    const took = p.durations.length === 2 ? `${fastest} and ${slowest}` : `${fastest} to ${slowest} each`
    const range = p.left.replace(/^about /u, 'About ')
    const wait = p.who ? ` The wait for ${p.you ? p.audience === 'agent' ? 'the owner' : 'you' : p.who} is not counted.` : ''
    return `${range} of work. ${p.storiesLeft} ${p.storiesLeft === 1 ? 'story' : 'stories'} left; its ${p.durations.length} finished stories took ${took}.${wait}`
  }
  if (p.noSession) return 'No estimate without a live session.'
  if (p.stopped || !p.live) return 'No estimate while it is stopped.'
  if (p.boardUnavailable) return 'No estimate. The board could not be read.'
  if (p.durations.length < 2) return `No estimate. It takes 2 finished stories and this run has ${p.durations.length}.`
  return 'No estimate. No story is left on the board.'
}

function runRow(run: DevAutoRun, session: NowSessionInput | null, context: RowContext, base: { key: string; name: string; workspaceId: string | null }): NowRow {
  const card = session?.card ?? null
  const you = card !== null
  const live = session?.live ?? false
  const noSession = session === null
  const owner = context.audience === 'owner'
  const where = { label: 'Folder', value: `${folder(run.checkout, context.home)}${run.branch ? ` on ${run.branch}` : ''}`, kind: 'path' as const }
  const cardRow = card && owner ? [{ label: 'Card', value: card.title, kind: 'card' as const }] : []
  const nameRow = base.name.length > 24 ? [{ label: 'Session', value: base.name }] : []
  const row: NowRow = {
    ...base, sessionId: session?.sessionId ?? null, section: 'project', dot: session?.dot ?? 'exited', doing: '', story: null, of: null,
    say: null, stopped: !live, done: false, stale: false, noSession, who: '', you, unknown: false, left: null, plus: false,
    cardRequestId: card?.requestId ?? null, fold: []
  }
  if (run.unavailable) {
    const last = run.updatedAt ? Date.parse(run.updatedAt) : Number.NaN
    return {
      ...row, doing: 'Handoff unreadable', stale: true, who: card ? youWho(card, context.audience) : 'unknown', unknown: !card,
      section: you ? 'you' : noSession ? 'not-running' : 'project', plus: false,
      fold: owner ? [...nameRow, { label: 'Why', value: `File read failed: ${run.unavailable}.` },
        ...(Number.isFinite(last) ? [{ label: 'Last read', value: `Handoff changed ${nowStamp(new Date(last))}.` }] : []),
        ...cardRow, where] : []
    }
  }
  const board = storyBoard(run)
  const boardUnavailable = run.board.unavailable !== null
  const story = board.current ? `${board.current.id} ${board.current.title}` : null
  const of = board.total > 0 ? `${board.done} of ${board.total}` : null
  const decisions = run.decisions.map(decisionWords).filter(Boolean)
  const decided = decisions.length > 0
    ? [{ label: 'Decided', value: `${decisions.length} ${decisions.length === 1 ? 'decision' : 'decisions'} made for you: ${decisions.join('; ')}.` }]
    : []
  const storiesRow = board.total > 0 ? [{ label: 'Stories', value: storiesWords(board) }] : []
  if (run.finished) {
    const finished = lastFinished(run)
    const words = finished ? `Finished ${dayMonth(finished)}` : 'Finished'
    return {
      ...row, doing: words, story, of, done: true, left: 'done', section: you ? 'you' : 'not-running',
      who: card ? youWho(card, context.audience) : '',
      fold: owner ? [...nameRow, { label: 'Status', value: run.status ?? 'Finished' }, ...cardRow,
        { label: 'Time left', value: `${words}.` }, ...storiesRow, ...decided, where] : []
    }
  }
  const who = card ? youWho(card, context.audience) : run.waitingOn ?? ''
  const durations = storyDurations(run.finishedStories ?? [])
  const storiesLeft = board.total - board.done
  const stopped = !live
  const left = !noSession && live ? leftRange(durations, storiesLeft) : null
  const idle = live && session!.dot === 'running-idle' && !who
  const doing = noSession ? board.current ? `No session, stopped at ${board.current.id}` : 'No session'
    : stopped ? story ? `Stopped at ${story}` : 'Stopped'
      : idle ? board.current ? `Idle at ${board.current.id}` : 'Idle'
        : story ?? (boardUnavailable ? 'Board unavailable' : 'No story on the board')
  const timeLeft = timeLeftWords({ left, durations, storiesLeft, stopped, live, noSession, who, you, audience: context.audience, boardUnavailable })
  return {
    ...row, doing, story, of, who, left, plus: who !== '', stopped,
    say: story ? null : boardUnavailable ? 'dev-auto run, board unavailable' : null,
    section: you ? 'you' : noSession ? 'not-running' : 'project',
    fold: owner ? [...nameRow, { label: 'Status', value: run.status ?? 'Not recorded' },
      ...(run.nextAction ? [{ label: 'Next step', value: run.nextAction }] : []), ...cardRow,
      { label: 'Time left', value: timeLeft }, ...storiesRow, ...decided, where] : []
  }
}

function sessionRow(session: NowSessionInput, context: RowContext): NowRow {
  const card = session.card
  const you = card !== null
  const owner = context.audience === 'owner'
  const base: NowRow = {
    key: `s:${session.sessionId}`, sessionId: session.sessionId, workspaceId: session.workspaceId, section: you ? 'you' : 'project',
    name: session.name, dot: session.dot, doing: '', story: null, of: null, say: null, stopped: !session.live, done: false,
    stale: false, noSession: false, who: card ? youWho(card, context.audience) : '', you, unknown: false, left: null,
    plus: false, cardRequestId: card?.requestId ?? null,
    fold: card && owner ? [{ label: 'Card', value: card.title, kind: 'card' }] : []
  }
  if (!session.live) return { ...base, doing: session.started ? 'Stopped' : 'Not started', section: you ? 'you' : 'not-running' }
  if (!session.agent) return { ...base, doing: 'Shell, no agent' }
  const word = session.working ? 'Working' : 'Idle'
  const doing = session.progressLabel ? `${word}: ${session.progressLabel}` : session.title ?? word
  // The agent's own progress label always speaks for it; a title only while it works. An idle session says nothing.
  return { ...base, doing, say: session.progressLabel ?? (session.working ? session.title : null) }
}

/** Which run, if any, a session's row shows: its unfinished run, or the finished one of a session that no longer runs. */
function attachRuns(sessions: readonly NowSessionInput[], runs: readonly DevAutoRun[]): { attached: Map<string, DevAutoRun>; rest: DevAutoRun[] } {
  const known = new Map(sessions.map((session) => [session.sessionId, session]))
  const bySession = new Map<string, DevAutoRun[]>()
  const rest: DevAutoRun[] = []
  for (const run of runs) {
    const id = run.sessionId ?? null
    if (id !== null && known.has(id)) bySession.set(id, [...(bySession.get(id) ?? []), run])
    else rest.push(run)
  }
  const attached = new Map<string, DevAutoRun>()
  for (const [id, linked] of bySession) {
    const ordered = linked.toSorted((left, right) => Number(left.finished) - Number(right.finished) ||
      (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
    const first = ordered[0]!
    if (!first.finished || !known.get(id)!.live) {
      attached.set(id, first)
      rest.push(...ordered.slice(1))
    } else rest.push(...ordered)
  }
  return { attached, rest }
}

/** Every row, section and count of the Now sheet, for one audience. */
export function buildNow(input: NowInput): NowView {
  const context: RowContext = { audience: input.audience, home: input.home ?? null }
  const covered = new Set(input.workspaces.map((workspace) => workspace.workspaceId))
  const sessions = input.sessions.filter((session) => covered.has(session.workspaceId))
  const runs = (input.runs ?? []).filter((run) => run.ownership !== 'copy')
  const { attached, rest } = attachRuns(sessions, runs)
  const rows: NowRow[] = []
  const runWorkspace = new Map<DevAutoRun, string | null>()
  for (const session of sessions) {
    const run = attached.get(session.sessionId)
    if (run) runWorkspace.set(run, session.workspaceId)
    rows.push(run ? runRow(run, session, context, { key: `s:${session.sessionId}`, name: session.name, workspaceId: session.workspaceId })
      : sessionRow(session, context))
  }
  const order = input.workspaces.map((workspace) => workspace.workspaceId)
  for (const run of rest) {
    const workspaceId = order.find((id) => run.workspaceIds.includes(id)) ?? null
    runWorkspace.set(run, workspaceId)
    // A dev-auto branch names the run (`dev-auto/epic-36`); a default branch says nothing, so the folder does.
    const folderName = run.checkout.split('/').filter(Boolean).at(-1) ?? run.checkout
    const name = run.branch && !['main', 'master', 'trunk'].includes(run.branch) ? run.branch : folderName
    const row = runRow(run, null, context, { key: `r:${run.checkout}`, name, workspaceId })
    rows.push({ ...row, section: 'not-running' })
  }
  const sections: NowSection[] = []
  const you = rows.filter((row) => row.section === 'you')
  if (you.length > 0) sections.push({ id: 'you', kind: 'you', title: input.audience === 'agent' ? 'Waits on the owner' : 'Waits on you', workspaceId: null, keys: you.map((row) => row.key) })
  for (const workspace of input.workspaces) {
    const keys = rows.filter((row) => row.section === 'project' && row.workspaceId === workspace.workspaceId).map((row) => row.key)
    if (keys.length > 0) sections.push({ id: `w:${workspace.workspaceId}`, kind: 'project', title: workspace.name, workspaceId: workspace.workspaceId, keys })
  }
  const resting = rows.filter((row) => row.section === 'not-running')
  if (resting.length > 0) sections.push({ id: 'not-running', kind: 'not-running', title: 'Not running', workspaceId: null, keys: resting.map((row) => row.key) })
  const since = previousWorkingDay(input.now).getTime()
  const doneSince: Record<string, string[]> = {}
  const finished = [...runWorkspace].flatMap(([run, workspaceId]) => workspaceId === null ? []
    : (run.finishedStories ?? []).flatMap((story) => {
      const at = Date.parse(story.finishedAt)
      return Number.isFinite(at) && at >= since && at <= input.now.getTime() ? [{ workspaceId, story: story.story, at }] : []
    })).toSorted((left, right) => left.at - right.at)
  for (const item of finished) {
    const list = doneSince[item.workspaceId] ??= []
    if (!list.includes(item.story)) list.push(item.story)
  }
  return {
    now: input.now, audience: input.audience, rows, sections,
    sessions: rows.filter((row) => row.sessionId !== null && row.section !== 'not-running').length,
    waiting: you.length, agentRunning: sessions.some((session) => session.live && session.agent),
    loading: input.runs === null, doneSince, sinceDay: WEEKDAYS[new Date(since).getDay()]!
  }
}

/** One session's standup line, exactly the approved design's grammar; null leaves the row out. */
export function standupLine(row: NowRow, audience: NowAudience = 'owner'): string | null {
  if (row.stale) return `${row.name}: handoff unreadable, status unknown.`
  if (row.stopped && row.of) return `${row.name}: stopped at ${row.story ?? 'its last story'}, ${row.of} stories.`
  if (!row.of) {
    const waits = row.you ? audience === 'agent' ? ' Waits on the owner.' : ` Waits on me: ${row.who.replace(/^you: /u, '')}.` : ''
    if (row.say) return `${row.name}: ${row.say}.${waits}`
    return waits ? `${row.name}:${waits}` : null
  }
  let line = `${row.name}: ${row.story ?? 'no current story'}, ${row.of} stories.`
  if (row.you) line += audience === 'agent' ? ' Waits on the owner.' : ` Waits on me: ${row.who.replace(/^you: /u, '')}.`
  else if (row.who) line += ` Waits on ${row.who}.`
  if (!row.left) return `${line} No estimate.`
  const range = row.left.replace(/^about /u, 'About ')
  return `${line} ${range} ${row.plus ? 'after that' : 'left'}.`
}

/** The standup text: one session per line, by workspace, then what finished since the previous working day. */
export function standupText(view: NowView, workspaces: ReadonlyArray<{ workspaceId: string; name: string }>): string {
  const who = view.audience === 'agent' ? 'the owner' : 'me'
  const head = !view.agentRunning ? `${nowStamp(view.now)}. No agent running.`
    : `${nowStamp(view.now)}. ${view.sessions} ${view.sessions === 1 ? 'session' : 'sessions'}, ${view.waiting === 0 ? `nothing waits on ${who}` : `${view.waiting} ${view.waiting === 1 ? 'waits' : 'wait'} on ${who}`}.`
  const byKey = new Map(view.rows.map((row) => [row.key, row]))
  const parts = workspaces.flatMap((workspace) => {
    const keys = view.sections.filter((section) => section.kind !== 'not-running').flatMap((section) => section.keys)
    const rows = view.rows.filter((row) => row.workspaceId === workspace.workspaceId && keys.includes(row.key))
    const lines = rows.map((row) => standupLine(byKey.get(row.key)!, view.audience)).filter((line): line is string => line !== null)
    const done = view.doneSince[workspace.workspaceId] ?? []
    if (lines.length === 0 && done.length === 0) return []
    return [[workspace.name, ...lines, ...(done.length > 0 ? [`Done since ${view.sinceDay}: ${done.join(', ')}.`] : [])].join('\n')]
  })
  return [head, ...parts].join('\n\n')
}

/** What `bmn now --json` prints: the same rows, as data, with the explanation only for the owner. */
export interface NowReport {
  at: string
  audience: NowAudience
  text: string
  sessions: number
  waiting: number
  agentRunning: boolean
  sections: Array<{ title: string; rows: Array<Omit<NowRow, 'fold' | 'cardRequestId'> & Partial<Pick<NowRow, 'fold' | 'cardRequestId'>>> }>
}

export function nowReport(view: NowView, workspaces: ReadonlyArray<{ workspaceId: string; name: string }>): NowReport {
  const byKey = new Map(view.rows.map((row) => [row.key, row]))
  return {
    at: view.now.toISOString(), audience: view.audience, text: standupText(view, workspaces), sessions: view.sessions,
    waiting: view.waiting, agentRunning: view.agentRunning,
    sections: view.sections.map((section) => ({
      title: section.title,
      rows: section.keys.map((key) => {
        const row = byKey.get(key)!
        if (view.audience === 'owner') return row
        // D10: an agent reads states and labels: no explanation (handoff and card text) and no card id.
        return Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'fold' && name !== 'cardRequestId')) as Omit<NowRow, 'fold' | 'cardRequestId'>
      })
    }))
  }
}
