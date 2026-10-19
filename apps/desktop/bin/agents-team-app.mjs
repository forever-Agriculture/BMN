// MODULE: agents-team-app.mjs - Story 73.1: Agents › Asks: every ask on this computer listed for the owner (his agents' and any made from a shell), one opened with its answer as the teammate's words, stopped, removed or exported
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { APP_NAMES } from './agents-roster.mjs'
import { readApproved } from './agents-state.mjs'
import { teamRunsDirectory } from './agents-check.mjs'
import { ASK_READS, ASK_RUN_FILES } from './agents-team-forms.mjs'
import { LIMITS } from './agents-team-inputs.mjs'
import { AskRefusal } from './agents-team-resolve.mjs'
import { RETENTION_DAYS, askSettings, placePath, recordInterrupted, removeRun, runHolds, sweepRuns } from './agents-team-places.mjs'
import { ANSWER_LIMIT, StartRefusal, askOutcome, exportAsk, stopAsk } from './agents-team-run.mjs'
import { RUN_FILES } from './agents-team-supervisor.mjs'
import { BROWSER_LIMITS, BROWSER_LIMIT_WORDS } from './agents-team-browser.mjs'
import { readJsonOrNull } from './shared-helpers.mjs'

/**
 * The app reads the same run folders `bmn team ask` writes, and the owner sees them all: an ask
 * from any session or shell, as BMN recorded who asked. Asking is the agents' (and the command's);
 * the app only reads, stops, removes and exports. Nothing here reads a sign-in.
 */

const RUN_ID = /^\d{8}T\d{6}-[0-9a-f]{8}$/u
const DAY_MS = 24 * 60 * 60 * 1000
/** How much of a question a list line carries: its first line, cut here. */
const QUESTION_LINE = 300
/** The states of a run that has not ended yet, whatever its supervisor calls them. */
const GOING = new Set(['accepted', 'starting', 'running', 'finishing'])

/** A file's text when it is there, a file, and at most `limit` bytes; else null. */
function readText(path, limit) {
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size <= limit ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

const text = (value, limit = 256) => (typeof value === 'string' ? value.slice(0, limit) : null)
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/** Who asked, as the run's request recorded it; anything else is a shell. */
function askerView(value) {
  if (value !== null && typeof value === 'object') {
    if (value.kind === 'owner') return { kind: 'owner' }
    if (value.kind === 'session' && typeof value.session === 'string') {
      return { kind: 'session', session: value.session.slice(0, 64), ...(typeof value.app === 'string' ? { app: value.app.slice(0, 32) } : {}) }
    }
  }
  return { kind: 'shell' }
}

/** The question as the asker wrote it: its own record, else (a run made before 73.1) the prompt, which begins with it. */
function questionOf(folder) {
  const own = readText(join(folder, ASK_RUN_FILES.question), LIMITS.question)
  if (own !== null) return { text: own, whole: true }
  const prompt = readText(join(folder, ASK_RUN_FILES.prompt), LIMITS.prompt * 2)
  return prompt === null ? null : { text: prompt.split('\n')[0], whole: false }
}

/** A run's usage as the page shows it: tokens, the cost the app reported or null for unknown, the billing basis, and whether every usage record was read. */
function usageView(usage, billing) {
  if (usage === null || typeof usage !== 'object') return null
  const reportedCost = typeof usage.reported_cost === 'number' && Number.isFinite(usage.reported_cost) ? usage.reported_cost : null
  return {
    input: count(usage.input_tokens), cached: count(usage.cached_input_tokens), output: count(usage.output_tokens), reasoning: count(usage.reasoning_tokens),
    reportedCost, billing: text(usage.billing, 32) ?? text(billing, 32) ?? 'unknown',
    complete: typeof usage.complete === 'boolean' ? usage.complete : null, incompleteReason: text(usage.incomplete_reason, 400), basis: text(usage.aggregation, 400)
  }
}

/** A run made before 72.9 read the question and its files, or a copy of the project (`request.access`). */
const BEFORE_FORMS = Object.freeze({ project: { scope: 'folder', reach: 'a copy of the project as it was' } })

/** What a run's teammate could read: its app's mode with its reach and words, the folder it worked in, and how many files and pictures went with the question (72.9 AC6). */
function readsView(request, manifest) {
  const files = Array.isArray(manifest?.files) ? manifest.files.length : 0
  const pictures = Array.isArray(manifest?.pictures) ? manifest.pictures.length : 0
  const origin = text(request.browser?.origin, 64)
  const browser = origin === null ? {} : { browser: { origin, interact: request.browser.interact === true } }
  const form = typeof manifest?.form === 'string' && Object.hasOwn(ASK_READS, manifest.form) ? manifest.form : null
  if (form === null) {
    const before = BEFORE_FORMS[request.access]
    return { form: null, scope: before?.scope ?? 'text', reach: before?.reach ?? null, words: null, folder: before === undefined ? null : text(manifest?.project?.root, 4096), files, pictures, ...browser }
  }
  const reads = ASK_READS[form]
  return {
    form, scope: reads.scope, reach: reads.scope === 'text' ? null : reads.reach, words: text(manifest.reads?.words, 1000) ?? reads.words,
    folder: reads.scope === 'text' ? null : text(manifest.reads?.folder, 4096), files, pictures, ...browser
  }
}

/** A project's state at one end of a run, as the outcome recorded it (72.9 AC6). */
function projectStateView(state) {
  if (state === null || typeof state !== 'object') return null
  return { commit: text(state.commit, 64), clean: typeof state.clean === 'boolean' ? state.clean : null, changed: count(state.changed), reason: text(state.reason, 400) }
}

/** The project a run worked in, with its state at the start and the end; a run made before 72.9 gives the revision it copied. */
function projectView(outcome, manifest) {
  if (outcome.project !== null && typeof outcome.project === 'object') {
    return { root: text(outcome.project.root, 4096), start: projectStateView(outcome.project.start), end: projectStateView(outcome.project.end) }
  }
  const project = manifest.project
  if (project === null || typeof project !== 'object') return null
  const revision = text(project.revision, 64)
  return { root: text(project.root, 4096), start: revision === null ? null : { commit: revision, clean: null, changed: null, reason: null }, end: null }
}

/** A sub-agent the teammate started, as the outcome named it: its own counts where they were added, else why not (72.9 AC5). */
function subagentView(entry, billing) {
  const counted = entry.usage !== null && typeof entry.usage === 'object'
  return {
    session: text(entry.session, 128) ?? '', name: text(entry.name, 200), role: text(entry.role, 64), kind: text(entry.kind, 64) ?? 'sub-agent', model: text(entry.model, 128), effort: text(entry.effort, 16),
    usage: counted ? usageView({ ...entry.usage, complete: true }, billing) : null,
    usageNote: counted ? null : entry.usage === 'incomplete' ? `usage incomplete: ${text(entry.usage_reason, 400) ?? 'it could not be read'}` : text(entry.usage, 200),
    ownTokens: count(entry.own_tokens)
  }
}

const reasonOf = (outcome) => text(outcome.reason, 2000) ?? text(outcome.refusal?.reason, 2000)

/**
 * One run as the Asks page lists it. `names`: the approved team's names by agent id. A run whose
 * supervisor died, or whose asking command ended before its supervisor started, is recorded as
 * interrupted when it is looked at, as the next ask would record it.
 */
function askLine(folder, names = new Map(), now = new Date()) {
  const before = askOutcome(folder)
  if (before.state === 'interrupted' && !existsSync(join(folder, ASK_RUN_FILES.outcome))) {
    recordInterrupted(folder, 'its supervisor ended with no record of the run\'s end; BMN never starts it again')
  } else if (before.state === 'accepted' && !existsSync(join(folder, ASK_RUN_FILES.outcome))) {
    // Before its supervisor, the command that reserved the run holds it while it lives (agents-team-places.mjs runHolds).
    const place = readJsonOrNull(placePath(dirname(folder), basename(folder)))
    if (place !== null) runHolds(dirname(folder), basename(folder), place.holder, now.getTime())
  }
  const request = readJsonOrNull(join(folder, ASK_RUN_FILES.request)) ?? {}
  const manifest = readJsonOrNull(join(folder, ASK_RUN_FILES.manifest))
  const outcome = askOutcome(folder)
  const state = readJsonOrNull(join(folder, RUN_FILES.state)) ?? {}
  const launch = readJsonOrNull(join(folder, RUN_FILES.launch))
  const question = questionOf(folder)
  const agent = text(request.agent, 64)
  const ended = text(outcome.ended_at, 40)
  const endedMs = ended === null ? Number.NaN : Date.parse(ended)
  const going = GOING.has(outcome.state)
  return {
    id: folder.split('/').pop(),
    question: question === null ? null : question.text.split('\n')[0].slice(0, QUESTION_LINE),
    by: askerView(request.asked_by),
    agent, agentName: agent === null ? null : names.get(agent) ?? agent,
    effort: text(request.effort, 16), role: text(request.role, 64), project: text(request.project, 4096), data: request.data === 'public' ? 'public' : 'private',
    reads: readsView(request, manifest),
    askedAt: text(request.asked_at, 40), startedAt: text(outcome.started_at, 40) ?? text(state.started_at, 40), endedAt: ended,
    timeLimitMinutes: count(outcome.time_limit_minutes) ?? count(launch?.time_limit_minutes),
    state: going ? 'running' : text(outcome.state, 32) ?? 'failed',
    // A refusal keeps its words under its code; any other end under its reason.
    ...(reasonOf(outcome) === null ? {} : { reason: reasonOf(outcome) }),
    ...(text(outcome.refusal?.code, 40) === null ? {} : { refusalCode: text(outcome.refusal.code, 40) }),
    usage: usageView(outcome.usage, request.billing),
    keptUntil: Number.isFinite(endedMs) ? new Date(endedMs + RETENTION_DAYS * DAY_MS).toISOString() : null,
    ...(going ? { now: now.toISOString() } : {})
  }
}

/** The places in use now: the reservations whose run has not ended. */
function placesInUse(runs) {
  let names
  try {
    names = readdirSync(join(runs, '.places')).filter((name) => name.endsWith('.json'))
  } catch {
    return 0
  }
  return names.filter((name) => {
    const id = name.slice(0, -'.json'.length)
    if (!RUN_ID.test(id) || !existsSync(join(runs, id))) return existsSync(placePath(runs, id))
    return askOutcome(join(runs, id)).exit === null
  }).length
}

/** The team's names by agent id; a team that cannot be read names nobody, and the ids stand. */
function teamNames() {
  try {
    return new Map(readApproved().data.agents.map((agent) => [agent.id, agent.name]))
  } catch {
    return new Map()
  }
}

/**
 * Agents › Asks: every ask on this computer, newest first, his and his agents'; records past their
 * days are removed first, as every ask's reservation does.
 */
export function appAsks({ runs = teamRunsDirectory(), now = new Date() } = {}) {
  sweepRuns(runs, now)
  let ids
  try {
    ids = readdirSync(runs).filter((name) => RUN_ID.test(name)).sort().reverse()
  } catch {
    ids = []
  }
  const names = teamNames()
  const settings = askSettings(runs)
  // Newest first by when each was asked: two asks of one second have ids that sort by their random part.
  const asks = ids.map((id) => askLine(join(runs, id), names, now))
  const at = (line) => line.askedAt ?? line.startedAt ?? ''
  asks.sort((a, b) => (at(a) === at(b) ? (a.id < b.id ? 1 : -1) : at(a) < at(b) ? 1 : -1))
  return { asks, places: { used: placesInUse(runs), capacity: settings.capacity }, keptDays: RETENTION_DAYS }
}

function runFolder(runs, id) {
  if (typeof id !== 'string' || !RUN_ID.test(id)) throw new AskRefusal('USAGE', 'name an ask by its id')
  const folder = join(runs, id)
  if (!existsSync(folder)) throw new AskRefusal('GONE', `no ask ${id} on this computer`)
  return folder
}

/** One ask opened: the whole question, what it read, who answered, and the answer as the teammate's own words. */
export function appAskDetail(id, { runs = teamRunsDirectory(), now = new Date() } = {}) {
  const folder = runFolder(runs, id)
  const line = askLine(folder, teamNames(), now)
  const request = readJsonOrNull(join(folder, ASK_RUN_FILES.request)) ?? {}
  const manifest = readJsonOrNull(join(folder, ASK_RUN_FILES.manifest)) ?? {}
  const receipt = readJsonOrNull(join(folder, ASK_RUN_FILES.receipt)) ?? {}
  const outcome = askOutcome(folder)
  const question = questionOf(folder)
  const observed = outcome.observed !== null && typeof outcome.observed === 'object' ? outcome.observed : {}
  return {
    line,
    question: question?.text ?? null, questionWhole: question?.whole ?? false,
    // An answer whose run was not attributed stays in the record as evidence only: it cannot be shown as the teammate's words.
    answer: line.state === 'answered' ? readText(join(folder, ASK_RUN_FILES.answer), ANSWER_LIMIT) : null,
    files: (Array.isArray(manifest.files) ? manifest.files : []).map((file) => ({ path: text(file.path, 4096) ?? '', bytes: count(file.bytes) ?? 0 })),
    pictures: (Array.isArray(manifest.pictures) ? manifest.pictures : []).map((picture) => ({
      label: text(picture.label, 4096) ?? text(picture.path, 4096) ?? '', bytes: count(picture.bytes) ?? 0, mediaType: text(picture.media_type, 32) ?? '',
      width: count(picture.width), height: count(picture.height), removed: Array.isArray(picture.removed) ? picture.removed.filter((name) => typeof name === 'string').slice(0, 40) : []
    })),
    project: projectView(outcome, manifest),
    browser: browserView(folder, request),
    teammate: {
      app: text(receipt.harness, 32), appName: APP_NAMES[receipt.harness] ?? null, appVersion: text(receipt.harness_version?.version, 64), model: text(observed.model, 128) ?? text(request.model, 128),
      session: text(observed.session, 128), sessionSource: text(observed.session_source, 64)
    },
    subagents: (Array.isArray(outcome.subagents) ? outcome.subagents : []).filter((entry) => entry !== null && typeof entry === 'object').slice(0, 100).map((entry) => subagentView(entry, request.billing)),
    masked: [...new Set([outcome.credentials_masked?.answer, outcome.credentials_masked?.output].flatMap((names) => (Array.isArray(names) ? names : [])).filter((name) => typeof name === 'string').map((name) => name.slice(0, 64)))]
  }
}

/** A browser ask's record as the page lists it (74.3 AC3): its pages and screenshots, everything in them the app's own text. */
function browserView(folder, request) {
  const origin = text(request.browser?.origin, 64)
  if (origin === null) return null
  const record = readJsonOrNull(join(folder, ASK_RUN_FILES.browserRecord)) ?? {}
  const list = (value, limit) => (Array.isArray(value) ? value.slice(0, limit) : [])
  const pageView = (page) => {
    const url = text(page?.url, BROWSER_LIMITS.url)
    const title = text(page?.title, BROWSER_LIMITS.pageTitle)
    return url === null ? [] : [{ url, title }]
  }
  return {
    origin, interact: request.browser.interact === true, limit: BROWSER_LIMIT_WORDS,
    pages: list(record.pages, BROWSER_LIMITS.pages).flatMap(pageView),
    screenshots: list(record.screenshots, BROWSER_LIMITS.screenshots).flatMap((shot) => (text(shot?.name, 255) === null ? [] : [{ name: text(shot.name, 255), bytes: count(shot.bytes) ?? 0 }]))
  }
}

/** Stops a running ask: its supervisor ends every process of its scope and records it stopped. */
export function appAskStop(id, { runs = teamRunsDirectory() } = {}) {
  const folder = runFolder(runs, id)
  if (askOutcome(folder).exit === null) stopAsk(folder)
}

/** Removes one ended ask, or with null every ended one; a running ask is stopped first, never removed under its supervisor. */
export function appAskRemove(id, { runs = teamRunsDirectory(), now = new Date() } = {}) {
  let ids
  if (id === null) {
    try {
      ids = readdirSync(runs).filter((name) => RUN_ID.test(name))
    } catch {
      ids = []
    }
  } else {
    runFolder(runs, id)
    ids = [id]
  }
  let removed = 0
  for (const each of ids) {
    if (askOutcome(join(runs, each)).exit === null) {
      if (id !== null) throw new AskRefusal('RUNNING', `ask ${each} is still running: stop it first`)
      continue
    }
    if (removeRun(runs, each, now)) removed += 1
  }
  return removed
}

/** Exports one ask's allowlisted record into a new folder in `into`; returns that folder and its files. */
export function appAskExport(id, into, { runs = teamRunsDirectory() } = {}) {
  const folder = runFolder(runs, id)
  const output = join(into, `bmn-ask-${id}`)
  if (existsSync(output)) throw new AskRefusal('EXISTS', `${output} already exists`)
  try {
    return { output, files: exportAsk(folder, output) }
  } catch (error) {
    // A running ask is refused as the command refuses it: said to the owner, not an internal error.
    if (error instanceof StartRefusal) throw new AskRefusal(error.code, error.message)
    throw error
  }
}
