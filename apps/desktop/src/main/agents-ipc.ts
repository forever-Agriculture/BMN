// MODULE: agents-ipc.ts - Epic 60.5/60.6: renderer channels for the Preferences Team and Rules pages
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  ERROR_CODES,
  ROSTER_APP_NAMES,
  type AgentAppView,
  type AgentsApprovalRequest,
  type AgentsOutcome,
  type AgentsPreview,
  type AgentsRulesUpdate,
  type AgentsShownRevision,
  type AgentsSnapshot,
  type ContextLimitApp,
  type ContextLimitPlan,
  type ContextLimitView,
  type ResearchLookup,
  type ResearchSnapshot,
  type ResearcherView,
  type WebQuestionAsked,
  type WebQuestionAsker,
  type WebQuestionView,
  type WebQuestionsSnapshot,
  type RosterDataShape,
  type RosterHarness,
  type RulesOutcome,
  type RulesPlan,
  type RulesProbeView,
  type RulesRenderingView,
  type RulesSnapshot,
  type RulesTargetHealth,
  type SkillStateName,
  type SkillsPlan,
  type SkillsView,
  type ToolProposalView,
  type ToolStateName,
  type ToolsPlan,
  type ToolsView,
  type TeamUpdateTarget
} from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { HARNESSES, RosterError, agentsDirectory, parseRoster, proseOf, readOnlyProposal, rewriteProse, rewriteRoster, rosterPath, sha256, starterRoster, type RosterData } from '../../bin/agents-roster.mjs'
import { approvedIfAny, listGenerations, machineDiff, readApproved, readGeneration, type Generation } from '../../bin/agents-state.mjs'
import { TESTED_HARNESS_VERSIONS, consequences, contextTestSources, harnessVersion, inspectRoute, limitStanding, versionStanding, type FenceTestEntry } from '../../bin/agents-check.mjs'
import {
  applyTeamUpdate, lastProbes, listTransactions, masterHistory, masterPath, parseMaster, planTeamUpdate, probeInspector, render, writeMaster, type RulesHarness
} from '../../bin/agents-rules.mjs'
import { pathState, replaceFileSafely } from '../../bin/safe-config-write.mjs'
import { unifiedDiff } from '../../bin/text-diff.mjs'
import { decide as decidePrompt } from '../../bin/agents-guard.mjs'
import {
  CONTEXT_APPS, ContextError, applyContextDefault, contextAuto, contextAutoPlan, contextDefault, contextTestFolder, limitedAgents, planContextDefault, setContextAuto, sharingAgents,
  type ContextAutoPlanEntry, type ContextTestOutcome
} from '../../bin/agents-context.mjs'
import { ASK_KEPT, ASK_LIMIT_MS, ASK_MAX_CHARS, ASK_PER_DAY, agentsMayAsk, askedCount, readQuestions, removeQuestions, runAsk, setAgentsMayAsk, type QuestionRecord } from '../../bin/agents-ask.mjs'
import { chooseResearcher, fetchPublicPage, processStart, publicHostName, readResearch, researchLockHolder, researchView, researcherChoice, researchers, runResearch, settledResearcher, type ResearchRunRecord } from '../../bin/agents-research.mjs'
import { runFenceTest } from '../../bin/agents-fence.mjs'
import { SKILL_APPS, appStateWord, checkSkills, lastListingTests, lastLoadingTests, lastSkillsTest, pendingCounts, skillsTests } from '../../bin/agents-skills.mjs'
import { appStateWord as toolsStateWord, checkTools, lastToolsTest, pendingCounts as toolsPendingCounts, proposeTools, toolsTests } from '../../bin/agents-tools.mjs'
import { allowWorkspace, approveRoster, approveSections, mergeSections, restoreGeneration, revertFileToApproved, saveAndApprove, type ApprovalSeams } from './agents-approval'
import { findAppProgram } from './app-program'
import { createContextAuto, type ContextAutoSeams } from './context-auto'
import { MainIpcError } from './workspace-ipc'

interface AgentsIpcRegistrar {
  handle(channel: `aiterm:${string}`, listener: (event: IpcMainInvokeEvent, params?: unknown) => unknown): void
}

export interface AgentsIpcOptions {
  senderIsAllowed(event: IpcMainInvokeEvent): boolean
  /** The bmn CLI script the Rules section runs for check, install, restore and probe. */
  cliScript(): string
  /** This process's environment; tests replace it. */
  environment?(): NodeJS.ProcessEnv
  /**
   * The environment a session's shell ends up with, read again before each call. A session finds
   * agent apps and their destinations through it, so the app inspects with it rather than its own.
   */
  sessionEnvironment?: { current(): { env: NodeJS.ProcessEnv; source: 'shell' | 'app'; reason?: string }; refresh(): Promise<void> }
  /** Opens a file in the owner's own editor; resolves to an error message, or '' when it opened. */
  openPath?(path: string): Promise<string>
  /** Opens an https address in the owner's own browser; absent where there is none to open. */
  openExternal?(address: string): Promise<void>
  now?(): Date
  /** Where the process table is read when Allow here asks about a stopped session again; tests replace it. */
  procRoot?: string
  /**
   * The app's own self-test only: a folder that serves cited pages whose site name ends in `.test`,
   * a name no real site can have. Null everywhere else, where every cited page is read from its site.
   */
  researchPages?(): string | null
  /** Reads one cited page for a research; tests replace it to hold a page open. */
  researchFetch?: typeof fetchPublicPage
  /** How long one research may take in all; tests shorten it. */
  researchLimitMs?(): number | undefined
  /** Runs the fence test of the installed Codex; tests replace it. */
  fenceTest?: typeof runFenceTest
  /** Compares a Codex researcher's tools under the provider's own model list before its first run; tests replace it. */
  researchCompare?: NonNullable<Parameters<typeof runResearch>[0]['compare']>
  /** Shows the owner a notice from BMN itself; absent in tests that have nobody to tell. */
  notifyApp?(notice: { title: string; body: string }): void
  /** The timer BMN's own context testing waits on before it tries once more; tests replace it. */
  contextRetryLater?: ContextAutoSeams['later']
}

/** What installing the handlers hands back to the app. */
export interface AgentsIpcHandle {
  /** BMN has started: a new app version an agent has a context limit on is tested now (63.1 AC1). Resolves when that is done. */
  contextAutoAtStart(): Promise<void>
}

/** Variables the rules CLI reads to find each app's file and its destination; nothing else of this process's environment. */
const RULES_ENV = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG',
  'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const
/** Variables the rules CLI only needs to know are set; their value may hold a key, so a mark is passed on instead. */
const RULES_ENV_MARKS = ['OPENCODE_CONFIG_CONTENT'] as const
const PROBE_OUTCOME_WORDS: Readonly<Record<string, string>> = { pass: 'passed', fail: 'failed', inconclusive: 'was inconclusive', unavailable: 'was unavailable' }
/** The command whose `--version` names each app's installed version. */
const APP_COMMANDS: Readonly<Record<RosterHarness, string>> = { claude: 'claude', codex: 'codex', opencode: 'opencode', cursor: 'cursor-agent' }
/** How many approved versions Team › Changes describes; older ones stay in `bmn roster status`. */
const HISTORY_LIMIT = 40
const CLI_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 240_000
const OUTPUT_LIMIT = 2 * 1024 * 1024

function invalid(message: string): never {
  throw new MainIpcError(ERROR_CODES.invalidArgument, message)
}

function objectParams(params: unknown): Record<string, unknown> {
  if (params === undefined) return {}
  if (!params || typeof params !== 'object' || Array.isArray(params)) invalid('Agents parameters must be an object')
  return params as Record<string, unknown>
}

function shownParam(params: Record<string, unknown>): AgentsShownRevision {
  const shown = params.shown as Partial<AgentsShownRevision> | undefined
  if (!shown || typeof shown !== 'object' || typeof shown.fileHash !== 'string'
    || !(shown.generation === null || (typeof shown.generation === 'number' && Number.isSafeInteger(shown.generation)))) {
    invalid('shown must name the approved version and file hash the page showed')
  }
  if (shown.link !== undefined && shown.link !== null && typeof shown.link !== 'string') invalid('shown.link must be the link target or null')
  if (shown.directory !== undefined && shown.directory !== null && (typeof shown.directory !== 'string' || shown.directory.length > 4096)) invalid('shown.directory must be a folder path or null')
  return { generation: shown.generation, fileHash: shown.fileHash, ...(shown.link === undefined ? {} : { link: shown.link }), ...(typeof shown.directory === 'string' ? { directory: shown.directory } : {}) }
}

/** What a path linked to when read (the target, or null for a regular file or no file) and the real folder holding it. */
function placeOf(path: string): { link: string | null; directory: string | null } {
  try {
    const state = pathState(path)
    return { link: state.kind === 'link' ? state.target : null, directory: state.directory }
  } catch {
    return { link: null, directory: null }
  }
}

function scopeParam(params: Record<string, unknown>): string[] | null {
  if (params.scope === undefined || params.scope === null) return null
  if (Array.isArray(params.scope) && params.scope.length > 0 && params.scope.length <= 64
    && params.scope.every((id) => typeof id === 'string' && id.length <= 32)) return params.scope as string[]
  invalid('scope must be a list of section ids')
}

function harnessParam(value: unknown): RosterHarness {
  if (typeof value !== 'string' || !(HARNESSES as readonly string[]).includes(value)) invalid('harness is not one of claude, codex, opencode, cursor')
  return value as RosterHarness
}

function textParam(params: Record<string, unknown>, key: string, max = 256 * 1024): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length > max) invalid(`${key} must be text of at most ${max} characters`)
  return value
}

function approvedOrProblem(): { generation: Generation | null; problem: AgentsSnapshot['approvalProblem'] } {
  try {
    return { generation: readApproved(), problem: null }
  } catch (error) {
    if (!(error instanceof RosterError)) throw error
    return { generation: null, problem: { code: error.code, message: error.message, lastGood: error.lastGood ?? null } }
  }
}

/**
 * The approved team for the Skills and Tools pages, or the reason it cannot be read. "No team"
 * is an answer only where none was ever approved: state that went missing or unreadable afterwards
 * is said on those pages, never judged as a team without skills marks or tools (R60-NFR1).
 */
function approvedForPages(): { generation: Generation | null; broken: string | null } {
  try {
    return { generation: approvedIfAny(), broken: null }
  } catch (error) {
    if (!(error instanceof RosterError)) throw error
    return { generation: null, broken: error.message }
  }
}

/** One line saying what an approved version changed, from the same sentences the review shows. */
function versionSummary(entry: AgentsSnapshot['history'][number]): string | undefined {
  if (!entry.valid || entry.earlier_schema !== undefined || entry.unfinished === true) return undefined
  if (entry.kind === 'restore' && entry.restored_from !== undefined) return `Restored version ${entry.restored_from}`
  const version = readGeneration(entry.number)
  if (version === null) return undefined
  const parent = typeof entry.parent === 'number' ? readGeneration(entry.parent) : null
  const agents = version.data.agents.length
  if (parent === null) return `First approval · ${agents} agent${agents === 1 ? '' : 's'}`
  const effects = consequences(parent.data, version.data)
  if (effects.length > 0) return effects.length === 1 ? effects[0] : `${effects[0]} · ${effects.length - 1} more`
  const changed = machineDiff(parent.data, version.data).length
  return changed === 0 ? 'Nothing changed' : `${changed} value${changed === 1 ? '' : 's'} changed`
}

/** Everything the Team pages show, read fresh from the roster file and approved state. */
export function agentsSnapshot(): AgentsSnapshot {
  const path = rosterPath()
  let text: string | null
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    text = null
  }
  const parsed = text === null ? null : parseRoster(text)
  const { generation, problem } = approvedOrProblem()
  const data = parsed?.data ?? null
  const prose: Record<string, string> = {}
  if (text !== null && data !== null) for (const agent of data.agents) prose[agent.id] = proseOf(text, agent.id) ?? ''
  // The owner's own review names an exception's folder; `bmn roster status` never does.
  const differences = generation && data ? machineDiff(generation.data, data, { folders: true }) : null
  const effects = data && (generation || problem?.code === 'NOT_APPROVED') && (differences === null || differences.length > 0)
    ? consequences(generation?.data ?? null, data) : []
  const history = (listGenerations() as unknown as AgentsSnapshot['history']).slice(0, HISTORY_LIMIT).map((entry) => {
    const summary = versionSummary(entry)
    return summary === undefined ? entry : { ...entry, summary }
  })
  return {
    rosterPath: path,
    home: process.env.HOME ?? null,
    file: {
      exists: text !== null, hash: text === null ? null : sha256(text), ...placeOf(path),
      errors: parsed?.errors ?? [], warnings: parsed?.warnings ?? [], data: data as RosterDataShape | null, prose
    },
    approved: generation ? { generation: generation.number, createdAt: generation.created_at, data: generation.data as RosterDataShape } : null,
    approvalProblem: problem,
    differences,
    consequences: effects,
    history
  }
}

interface ShownGuardStop { agent: string; pid: number; start: string; folder: string; processFolder: string | null; workspace: string; providerId: string; host: string | null; conversation: string | null }

/** What the card showed when Allow here was pressed; every part is checked again against the live process. */
function guardStopParam(params: Record<string, unknown>): ShownGuardStop {
  const stop = params.stop
  const text = (value: unknown): value is string => typeof value === 'string' && value !== ''
  if (stop === null || typeof stop !== 'object' || Array.isArray(stop)) throw new MainIpcError(ERROR_CODES.invalidArgument, 'stop must be an object')
  const { agent, pid, start, folder, processFolder, workspace, providerId, host, conversation } = stop as Record<string, unknown>
  if (!text(agent) || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2 || !text(start) || !text(folder) || !text(workspace) || !text(providerId)
    || !(host === null || text(host)) || !(conversation === null || text(conversation)) || !(processFolder === null || processFolder === undefined || text(processFolder))) {
    throw new MainIpcError(ERROR_CODES.invalidArgument, 'stop does not name a session, a provider and a workspace')
  }
  return { agent, pid, start, folder, processFolder: processFolder ?? null, workspace, providerId, host, conversation }
}

function outcome(run: () => string): AgentsOutcome {
  try {
    const message = run()
    return { ok: true, message, snapshot: agentsSnapshot() }
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'IO_ERROR'
    const errors = error instanceof RosterError ? error.errors : undefined
    return { ok: false, code, message: error instanceof Error ? error.message : String(error), ...(errors ? { errors } : {}), snapshot: agentsSnapshot() }
  }
}

/**
 * After a restore the team file still holds the later text. It goes back to the restored version
 * when that changes only yaml blocks; when a section was added since, the file is left alone and
 * its differences show on the Team page to keep or revert. Returns whether the file still differs.
 */
export function fileToApproved(shown: AgentsShownRevision): boolean {
  const now = agentsSnapshot()
  if (now.approved === null || now.file.hash === null || (now.differences ?? []).length === 0) return false
  try {
    // Only the file the owner was shown may be replaced: one that changed since then keeps its bytes and shows its differences.
    revertFileToApproved({ ...shown, generation: now.approved.generation }, null)
    return false
  } catch {
    return true
  }
}

const NOT_PREVIEWED = { differences: [], consequences: [], teamUpdate: [] }

/**
 * What an approving control would approve, before it commits: the data exactly as the approval
 * would publish it, its differences and consequences against the approved version, and the rules
 * files whose Team phrase the approval would also update (60.4 AC6).
 */
export async function previewApproval(request: AgentsApprovalRequest, environment: NodeJS.ProcessEnv): Promise<AgentsPreview> {
  let text: string
  try {
    text = readFileSync(rosterPath(), 'utf8')
  } catch {
    return { valid: false, errors: [{ code: 'ROSTER_MISSING', message: `no team file at ${rosterPath()}` }], ...NOT_PREVIEWED }
  }
  const { generation } = approvedOrProblem()
  let next: RosterData | null
  let errors: AgentsPreview['errors'] = []
  if (request.kind === 'restore') {
    next = readGeneration(request.number)?.data ?? null
    if (next === null) errors = [{ code: 'INVALID_VALUE', message: `version ${request.number} cannot be restored` }]
  } else {
    const file = parseRoster(text)
    const staged = request.kind === 'staged' ? parseRoster(rewriteRoster(text, request.data as RosterData))
      // A first approval takes the whole file, whatever was named.
      : request.kind === 'sections' && file.data !== null && generation !== null ? parseRoster(rewriteRoster(text, mergeSections(generation.data, file.data, request.scope)))
        : file
    next = staged.data
    errors = staged.errors
  }
  if (next === null) return { valid: false, errors, ...NOT_PREVIEWED }
  return {
    ...(request.kind === 'restore' ? { restored: next as RosterDataShape } : {}),
    valid: true, errors: [], differences: generation ? machineDiff(generation.data, next, { folders: true }) : [], consequences: consequences(generation?.data ?? null, next),
    teamUpdate: (await planTeamUpdate(next, { environment })).targets.map(({ resolved_path: resolved, ...target }) => (
      { ...target, ...(resolved === target.path ? {} : { resolvedPath: resolved }) }))
  }
}

function stagedParam(params: Record<string, unknown>): RosterDataShape {
  const data = params.data as RosterDataShape | undefined
  if (!data || typeof data !== 'object' || data.schema_version !== 2 || !Array.isArray(data.agents) || !Array.isArray(data.roles)
    || !Array.isArray(data.providers) || !Array.isArray(data.exceptions) || !Array.isArray(data.harness_routes)) {
    invalid('data must be team data')
  }
  return data
}

function numberParam(params: Record<string, unknown>): number {
  const number = params.number
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) invalid('number must be a version number')
  return number
}

function requestParam(params: Record<string, unknown>): AgentsApprovalRequest {
  const request = objectParams(params.request)
  if (request.kind === 'staged') return { kind: 'staged', data: stagedParam(request) }
  if (request.kind === 'file') return { kind: 'file' }
  if (request.kind === 'restore') return { kind: 'restore', number: numberParam(request) }
  const scope = request.kind === 'sections' ? scopeParam(request) : null
  if (scope === null) invalid('request must name what to approve')
  return { kind: 'sections', scope }
}

/** The rules files the owner was shown beside an approving control; absent means none were shown. */
function teamUpdateParam(params: Record<string, unknown>): Pick<TeamUpdateTarget, 'harness' | 'binding'>[] {
  if (params.teamUpdate === undefined) return []
  if (!Array.isArray(params.teamUpdate) || params.teamUpdate.length > HARNESSES.length) invalid('teamUpdate must list the rules files that were shown')
  return (params.teamUpdate as unknown[]).map((entry) => {
    const target = objectParams(entry)
    if (typeof target.binding !== 'string' || !/^[0-9a-f]{64}$/.test(target.binding)) invalid('teamUpdate entries carry the binding that was shown')
    return { harness: harnessParam(target.harness), binding: target.binding }
  })
}

// ---------------------------------------------------------------------------------------------
// Rules

interface CliResult { code: number | null; stdout: string; stderr: string; failed?: string }

function runCli(script: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = CLI_TIMEOUT_MS): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: timeoutMs, maxBuffer: OUTPUT_LIMIT, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr })
        const failure = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean }
        if (typeof failure.code === 'number') return resolve({ code: failure.code, stdout, stderr })
        resolve({ code: null, stdout, stderr, failed: failure.killed ? 'timed out' : 'could not start' })
      })
  })
}

function rulesEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of RULES_ENV) if (source[name] !== undefined) env[name] = source[name]
  for (const name of RULES_ENV_MARKS) if (source[name]) env[name] = 'set'
  return env
}

/** A probe runs the owner's harness, which needs its own environment; BMN's session credentials stay out. */
function probeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (!name.startsWith('BMN_') && !name.startsWith('AITERM_') && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value
  }
  return env
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Each app's exact rendering of `text` against the approved version (60.6 AC2). */
function renderAll(path: string, text: string, generation: Generation | null): RulesRenderingView[] {
  const master = { path, text, hash: sha256(text), parts: parseMaster(text).parts }
  return (HARNESSES as RulesHarness[]).map((harness) => {
    const rendering = render(master, harness, generation)
    return { harness, text: rendering.text, bytes: rendering.bytes, kind: rendering.kind, reason: rendering.reason, teamForm: rendering.team_form }
  })
}

export interface RulesIpcContext {
  script: string; env: NodeJS.ProcessEnv; probeEnv: NodeJS.ProcessEnv; now: () => Date
  /** Why the shell's settings could not be read, when BMN's own environment stands in for them. */
  ownEnvironment?: string
  /** BMN's own context testing as it stands now; absent where nothing can start a test. */
  contextAuto?(): RulesSnapshot['contextAuto']
}

/** What an inspection resolved: the app's installed version and where it sends data. */
interface RouteResolution { harness: RosterHarness; version: string | null; provider: string | null; host: string | null; basis: string; sources: string[] }
interface AppInspection { resolution: RouteResolution; reason?: string }

/** Where an app sends data as inspected now, and its installed version. Inspection only. */
function inspectApp(harness: RosterHarness, environment: NodeJS.ProcessEnv, probeEnvironment: NodeJS.ProcessEnv): AppInspection {
  const result = inspectRoute({ harness } as never, null, environment, environment.HOME ?? '/')
  const checked = harness === 'claude' || harness === 'codex'
  const version = checked ? (result.version as string | null | undefined) ?? null : harnessVersion(APP_COMMANDS[harness], probeEnvironment)
  return {
    resolution: {
      harness, basis: String(result.basis ?? 'unknown'), provider: (result.provider as string | null) ?? null, host: (result.host as string | null) ?? null,
      sources: Array.isArray(result.sources) ? result.sources as string[] : [], version
    },
    ...(typeof result.reason === 'string' ? { reason: result.reason } : {})
  }
}

/**
 * One row of Rules › Health › Agent apps (60.6 AC4). Any installed version is supported (owner
 * decision 2026-10-10); the row only says whether BMN's tests ran against it.
 */
function appView(harness: RosterHarness, context: RulesIpcContext): AgentAppView {
  const { resolution, reason } = inspectApp(harness, context.env, context.probeEnv)
  const app = ROSTER_APP_NAMES[harness]
  const checked = harness === 'claude' || harness === 'codex'
  const tested = (TESTED_HARNESS_VERSIONS[harness] ?? []).join(', ')
  const same = 'BMN reads where it sends data the same way on every version.'
  const [versionState, versionNote]: [AgentAppView['versionState'], string] = !checked
    ? ['unknown', `BMN does not check ${app} dispatches.`]
    : resolution.version === null
      ? ['unknown', `${app} is not installed, or its version cannot be read.`]
      : versionStanding(harness, resolution.version).tested
        ? ['tested', 'BMN tested how this version picks where to send data.']
        : versionStanding(harness, resolution.version).state === 'newer than BMN tested'
          ? ['newer', `Newer than the version BMN tested (${tested}). ${same}`]
          : ['other', `Not the version BMN tested (${tested}). ${same}`]
  // The same PATH the version was read through, so the program shown is the one that answered.
  const program = findAppProgram(APP_COMMANDS[harness], context.probeEnv.PATH, dirname(context.script))
  return {
    ...resolution, program: program?.path ?? null, ...(program?.target === undefined ? {} : { programTarget: program.target }),
    versionState, versionNote, ...(reason === undefined ? {} : { reason })
  }
}

/** One row of Rules › Health › Context limits (60.9 AC3): the default the app's file holds, and whether BMN may change it. */
function contextView(harness: ContextLimitApp, version: string | null, generation: Generation | null, context: RulesIpcContext): ContextLimitView {
  const row = contextDefault(harness, { environment: context.env, version })
  return {
    harness, path: row.path, exists: row.exists, limit: row.limit, compact: row.compact, version,
    ...(row.resolved_path !== undefined && row.resolved_path !== row.path ? { resolvedPath: row.resolved_path } : {}),
    ...(row.link_target === undefined ? {} : { linkTarget: row.link_target }),
    ...(row.unreadable === undefined ? {} : { unreadable: row.unreadable }),
    limitProven: row.proven.limit, compactProven: row.proven.compact,
    ...(row.min === undefined || row.max === undefined ? {} : { min: row.min, max: row.max }),
    test: row.test === null ? null : { at: row.test.at, version: row.test.version, outcome: row.test.limit, detail: row.test.detail, ...(row.test.by === 'bmn' ? { by: 'bmn' as const } : {}) },
    limits: limitedAgents(generation?.data ?? null, harness).map((agent) => {
      const limit = agent.context_limit as number
      try {
        const standing = limitStanding(agent, version, { environment: context.env })
        return { agent: agent.name, limit, state: standing?.state ?? 'applied', ...(standing === null || standing.state === 'applied' ? {} : { reason: standing.reason }) }
      } catch (error) {
        // A file the check cannot read stops the run it would judge, so it is said as a refusal.
        return { agent: agent.name, limit, state: 'refused' as const, reason: error instanceof Error ? error.message : String(error) }
      }
    }),
    agents: sharingAgents(generation?.data ?? null, harness)
  }
}

/**
 * Rules › Skills and Health's Skills group (60.11 AC5): the skills folder, each skill's state in
 * each app, and where each app reads skills. A skill's description is its first line only, and
 * never its text; the versions are the ones Health's Agent apps rows show.
 */
function skillsView(apps: AgentAppView[], team: ReturnType<typeof approvedForPages>, context: RulesIpcContext): SkillsView {
  const versions = Object.fromEntries(apps.map((app) => [app.harness, app.version]))
  const { generation } = team
  try {
    if (team.broken !== null) throw new Error(team.broken)
    const tests = skillsTests()
    const check = checkSkills({ environment: context.env, tests, versions, generation, descriptions: true })
    const bound = { environment: context.env, tests, versions, generation }
    const last = (found: ReturnType<typeof lastLoadingTests>, harness: RosterHarness): SkillsView['apps'][number]['loading'] => {
      const entry = found.find((one) => one.harness === harness)
      return entry === undefined || entry.outcome === null || entry.outcome === 'unavailable' ? null
        : { at: String(entry.at), version: entry.version ?? null, outcome: entry.outcome, detail: String(entry.detail ?? ''), stale: entry.stale === true }
    }
    // Two records kept apart: a listing (no prompt) never stands in for a loading test (one prompt).
    const listing = lastListingTests(bound)
    const loading = lastLoadingTests(bound)
    return {
      source: check.source,
      markedMissing: check.marked_missing,
      ...pendingCounts(check),
      skills: check.skills.map((skill) => ({
        name: skill.name, description: skill.description ?? '', readable: skill.readable, ...(skill.detail === undefined ? {} : { detail: skill.detail }),
        states: Object.fromEntries(check.apps.filter((app) => app.supported).flatMap((app) => {
          const row = app.skills.find((entry) => entry.name === skill.name && entry.removed !== true)
          return row === undefined ? [] : [[app.harness, row.state as SkillStateName]]
        }))
      })),
      apps: check.apps.map((app) => {
        const test = lastSkillsTest(app.harness, 'capability', tests)
        return {
          harness: app.harness, version: app.version, supported: app.supported, ...(app.reason === undefined ? {} : { reason: app.reason }),
          testable: SKILL_APPS[app.harness].list !== null, location: app.location, format: app.format, readsSource: app.reads_source,
          kind: app.kind, kindReason: app.kind_reason, state: appStateWord(app, check.source.readable),
          test: test === null ? null : { at: test.at, version: test.version, outcome: test.outcome, detail: test.detail },
          loadTestable: SKILL_APPS[app.harness].prompt, listing: last(listing, app.harness), loading: last(loading, app.harness)
        }
      })
    }
  } catch (error) {
    // The approved team, or BMN's own record of what it wrote, cannot be read: say so on the page rather than fail every Rules page.
    return { source: { path: '', readable: false, detail: error instanceof Error ? error.message : String(error) }, skills: [], markedMissing: [], apps: [], pending: 0, exposed: 0 }
  }
}

function skillsPlanFrom(result: CliResult): SkillsPlan {
  const report = parseJson(result.stdout)
  const refused = (code: string, message: string): SkillsPlan => ({ ok: false, code, message, planHash: null, targets: [], exposed: [] })
  if (result.failed || report === null) return refused('IO_ERROR', `The skills plan could not be read${result.failed ? ` (${result.failed})` : ''}`)
  if (report.code !== 'OK') return refused(String(report.code ?? 'IO_ERROR'), String(report.message ?? 'The plan was refused'))
  const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value as Record<string, unknown>[] : [])
  return {
    ok: true, code: 'OK', planHash: typeof report.plan_hash === 'string' ? report.plan_hash : null,
    targets: rows(report.targets).map((row) => ({
      harness: row.harness as RosterHarness, skill: String(row.skill), path: String(row.path), kind: String(row.words ?? ''), change: String(row.change ?? ''),
      // A skill's lines are never shown: what the entry holds, or becomes, is said in words.
      diff: '', note: typeof row.detail === 'string' ? row.detail : row.action === 'remove' ? 'The entry is removed; the skill itself stays in the skills folder.'
        : row.action === 'copy' ? "A copy of the skill, with BMN's line in its SKILL.md." : 'A link to the skill in the skills folder.',
      ...(typeof row.resolved_path === 'string' && row.resolved_path !== row.path ? { resolvedPath: row.resolved_path } : {}),
      ...(typeof row.link_target === 'string' ? { linkTarget: row.link_target } : {})
    })),
    exposed: rows(report.exposed).map((row) => ({ harness: row.harness as RosterHarness, skill: String(row.skill), fix: String(row.fix) }))
  }
}

/**
 * Rules › Tools and Health's Tools group (60.12 AC6): each approved tool's state in each app and
 * where each app keeps its tools. Nothing an app's entry holds is part of it, only names and states.
 */
function toolsView(apps: AgentAppView[], team: ReturnType<typeof approvedForPages>, context: RulesIpcContext): ToolsView {
  const versions = Object.fromEntries(apps.map((app) => [app.harness, app.version]))
  const { generation } = team
  try {
    if (team.broken !== null) throw new Error(team.broken)
    const tests = toolsTests()
    const check = checkTools({ environment: context.env, tests, versions, generation })
    return {
      ...toolsPendingCounts(check),
      tools: check.tools.map((tool) => {
        const rows = check.apps.filter((app) => app.supported).flatMap((app) => {
          const row = app.tools.find((entry) => entry.id === tool.id)
          return row === undefined ? [] : [{ harness: app.harness, row }]
        })
        return {
          id: tool.id,
          states: Object.fromEntries(rows.map(({ harness, row }) => [harness, row.state as ToolStateName])),
          details: Object.fromEntries(rows.flatMap(({ harness, row }) => (row.detail === undefined ? [] : [[harness, row.detail]])))
        }
      }),
      apps: check.apps.map((app) => {
        const test = lastToolsTest(app.harness, tests)
        return {
          harness: app.harness, version: app.version, supported: app.supported, ...(app.reason === undefined ? {} : { reason: app.reason }),
          path: app.path, readable: app.readable, ...(app.detail === undefined ? {} : { detail: app.detail }), ...(app.link === undefined ? {} : { link: app.link }),
          kind: app.kind, kindReason: app.kind_reason, state: toolsStateWord(app), variable: app.variable, isolation: app.isolation,
          test: test === null ? null : { at: test.at, version: test.version, outcome: test.outcome, detail: test.detail },
          unlisted: app.unlisted.map((entry) => ({ id: entry.id, state: entry.state, managed: entry.managed }))
        }
      })
    }
  } catch (error) {
    // BMN's own record of what it wrote cannot be read: say so on the page rather than fail every Rules page.
    return { tools: [], apps: [], pending: 0, exposed: 0, blocked: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

function toolsPlanFrom(result: CliResult, removeUnlisted: boolean): ToolsPlan {
  const report = parseJson(result.stdout)
  const refused = (code: string, message: string): ToolsPlan => ({ ok: false, code, message, planHash: null, removeUnlisted, targets: [], exposed: [], blocked: [] })
  if (result.failed || report === null) return refused('IO_ERROR', `The tools plan could not be read${result.failed ? ` (${result.failed})` : ''}`)
  if (report.code !== 'OK') return refused(String(report.code ?? 'IO_ERROR'), String(report.message ?? 'The plan was refused'))
  const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value as Record<string, unknown>[] : [])
  const open = (value: unknown): ToolsPlan['exposed'] => rows(value).map((row) => ({ harness: row.harness as RosterHarness, tool: String(row.tool), fix: String(row.fix) }))
  return {
    ok: true, code: 'OK', planHash: typeof report.plan_hash === 'string' ? report.plan_hash : null, removeUnlisted,
    // What an entry held is shown as the command line showed it: values already masked there.
    targets: rows(report.targets).map((row) => ({
      harness: row.harness as RosterHarness, tool: String(row.tool), path: String(row.path), action: row.action === 'remove' ? 'remove' : 'set', words: String(row.words ?? ''),
      before: typeof row.before === 'string' ? row.before : null, after: typeof row.after === 'string' ? row.after : null
    })),
    exposed: open(report.exposed), blocked: open(report.blocked)
  }
}

function contextApp(value: unknown): ContextLimitApp {
  if (typeof value !== 'string' || !(CONTEXT_APPS as readonly string[]).includes(value)) invalid('harness is not one of codex, claude')
  return value as ContextLimitApp
}

/** A number of tokens, or null for the app's own default. */
function sizeParam(params: Record<string, unknown>, key: string): number | null {
  const value = params[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 999_999_999) invalid(`${key} must be a positive whole number of tokens, or null`)
  return value
}

async function rulesHealth(context: RulesIpcContext): Promise<RulesSnapshot['health']> {
  const checkedAt = context.now().toISOString()
  const result = await runCli(context.script, ['rules', 'check', '--json'], context.env)
  if (result.failed) return { state: 'failed', checkedAt, reason: `The rules check ${result.failed}` }
  const report = parseJson(result.stdout)
  if (report === null) return { state: 'failed', checkedAt, reason: 'The rules check printed a report BMN cannot read' }
  if (result.code === 3 || result.code === 4) return { state: 'failed', checkedAt, reason: String(report.message ?? 'The master cannot be read') }
  if (!Array.isArray(report.targets) || typeof report.ok !== 'boolean') return { state: 'failed', checkedAt, reason: 'The rules check printed a report BMN cannot read' }
  const targets: RulesTargetHealth[] = (report.targets as Record<string, unknown>[]).map((row) => ({
    harness: row.harness as RosterHarness, path: String(row.path), state: row.state as RulesTargetHealth['state'],
    kind: row.kind === 'full' ? 'full' : 'public', reason: String(row.reason ?? ''),
    ...(typeof row.link_target === 'string' ? { linkTarget: row.link_target } : {})
  }))
  return { state: 'checked', checkedAt, ok: report.ok, targets }
}

export async function rulesSnapshot(context: RulesIpcContext): Promise<RulesSnapshot> {
  const path = masterPath()
  let text: string | null
  let savedAt: string | null = null
  try {
    text = readFileSync(path, 'utf8')
    savedAt = statSync(path).mtime.toISOString()
  } catch {
    text = null
  }
  const errors = text === null ? [] : parseMaster(text).errors
  const { generation } = approvedOrProblem()
  const pages = approvedForPages()
  const renderings = text !== null && errors.length === 0 ? renderAll(path, text, generation) : []
  const apps = (HARNESSES as RosterHarness[]).map((harness) => appView(harness, context))
  let history: RulesSnapshot['history']
  try {
    history = masterHistory()
  } catch {
    history = null
  }
  return {
    masterPath: path,
    home: context.env.HOME ?? null,
    master: { exists: text !== null, text, hash: text === null ? null : sha256(text), bytes: text === null ? 0 : Buffer.byteLength(text), savedAt, errors },
    renderings,
    health: text === null ? { state: 'failed', checkedAt: context.now().toISOString(), reason: `No rules master at ${path}` } : await rulesHealth(context),
    probes: lastProbes({ inspect: await probeInspector(context.probeEnv) }) as RulesProbeView[],
    apps,
    // The version each limit setting is judged against is the one the row above shows.
    context: (CONTEXT_APPS as ContextLimitApp[]).map((harness) => contextView(harness, apps.find((app) => app.harness === harness)?.version ?? null, generation, context)),
    contextAuto: context.contextAuto?.() ?? { enabled: contextAuto().enabled, running: null },
    readOnlyRoles: generation === null ? null : { held: generation.data.roles.filter((role) => role.read_only === true).map((role) => role.id), proposed: readOnlyProposal(generation.data) },
    skills: skillsView(apps, pages, context),
    tools: toolsView(apps, pages, context),
    ...(context.ownEnvironment === undefined ? {} : { ownEnvironment: context.ownEnvironment }),
    transactions: listTransactions().slice(0, 10).map((entry) => ({
      id: entry.id, valid: entry.valid, ...(entry.created_at ? { createdAt: entry.created_at } : {}),
      ...(entry.state ? { state: entry.state } : {}), ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.targets ? { targets: entry.targets } : {})
    })),
    history
  }
}

function planFrom(result: CliResult, kind: 'install' | 'restore'): RulesPlan {
  const report = parseJson(result.stdout)
  if (result.failed || report === null) return { ok: false, code: 'IO_ERROR', message: `The ${kind} plan could not be read${result.failed ? ` (${result.failed})` : ''}`, planHash: null, targets: [] }
  if (report.code !== 'OK') return { ok: false, code: String(report.code ?? 'IO_ERROR'), message: String(report.message ?? 'The plan was refused'), planHash: null, targets: [] }
  const targets = Array.isArray(report.targets) ? (report.targets as Record<string, unknown>[]).map((row) => ({
    harness: row.harness as RosterHarness, path: String(row.path), kind: String(row.kind ?? row.becomes ?? ''), change: String(row.change ?? row.becomes ?? ''), diff: String(row.diff ?? ''),
    ...(typeof row.resolved_path === 'string' && row.resolved_path !== row.path ? { resolvedPath: row.resolved_path } : {}),
    ...(row.rendering === 'full' ? { rendering: 'full' as const } : row.rendering === 'public' ? { rendering: 'public' as const } : {}),
    ...(typeof row.link_target === 'string' ? { linkTarget: row.link_target } : {}),
    ...(typeof row.note === 'string' ? { note: row.note } : {}),
    ...(typeof row.tool === 'string' ? { entry: row.tool } : {}),
    ...(Array.isArray(row.fold) ? { fold: (row.fold as unknown[]).map(String) } : {})
  })) : []
  return { ok: true, code: 'OK', planHash: typeof report.plan_hash === 'string' ? report.plan_hash : null, targets }
}

async function rulesOutcome(context: RulesIpcContext, result: CliResult, success: (report: Record<string, unknown>) => string): Promise<RulesOutcome> {
  const report = parseJson(result.stdout)
  const snapshot = await rulesSnapshot(context)
  if (result.failed) return { ok: false, code: 'IO_ERROR', message: `The rules command ${result.failed}`, snapshot }
  if (report === null) return { ok: false, code: 'IO_ERROR', message: result.stderr.trim().split('\n').pop() || 'The rules command printed nothing BMN can read', snapshot }
  if (report.code !== 'OK' && report.outcome === undefined) {
    return { ok: false, code: String(report.code ?? 'IO_ERROR'), message: String(report.message ?? 'The rules command was refused'), snapshot }
  }
  return { ok: true, message: success(report), snapshot }
}

// ---------------------------------------------------------------------------------------------

export function installAgentsIpcHandlers(ipc: AgentsIpcRegistrar, options: AgentsIpcOptions): AgentsIpcHandle {
  const handle = (channel: `aiterm:${string}`, listener: (params: Record<string, unknown>) => unknown): void => {
    ipc.handle(channel, (event, params) => {
      if (!options.senderIsAllowed(event)) throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
      const run = (): unknown => listener(objectParams(params))
      // Every call inspects with the shell's settings as they are now, not as they were when BMN started.
      return options.sessionEnvironment ? options.sessionEnvironment.refresh().then(run) : run()
    })
  }
  const context = (): RulesIpcContext => {
    const session = options.environment ? undefined : options.sessionEnvironment?.current()
    const environment = options.environment?.() ?? session?.env ?? process.env
    return {
      script: options.cliScript(), env: rulesEnvironment(environment), probeEnv: probeEnvironment(environment), now: options.now ?? (() => new Date()),
      ...(session?.source === 'app' ? { ownEnvironment: session.reason ?? 'the shell could not be asked' } : {}),
      contextAuto: () => auto.view()
    }
  }
  const installedVersion = (harness: ContextLimitApp, ctx: RulesIpcContext): string | null => inspectApp(harness, ctx.env, ctx.probeEnv).resolution.version
  /**
   * BMN's own context testing (63.1). What to test is decided from the approved team, the installed
   * versions and the sources a test would meet today; the test itself is the owner's own, `bmn context
   * test`, started with his environment and marked as BMN's.
   */
  const auto = createContextAuto({
    plan: (known): ContextAutoPlanEntry[] => {
      if (!contextAuto().enabled) return []
      let data: RosterData | null
      try {
        data = approvedIfAny()?.data ?? null
      } catch {
        data = null
      }
      // An app no agent has a limit for is not even asked for its version.
      const apps = (CONTEXT_APPS as ContextLimitApp[]).filter((harness) => limitedAgents(data, harness).length > 0)
      if (apps.length === 0) return []
      const ctx = context()
      const versions = Object.fromEntries(apps.map((harness) => [harness, known !== undefined && harness in known ? known[harness] ?? null : installedVersion(harness, ctx)]))
      const folder = contextTestFolder(ctx.probeEnv)
      const sources = Object.fromEntries(apps.map((harness) => {
        try {
          return [harness, contextTestSources(harness, ctx.probeEnv, folder)]
        } catch {
          // A source that cannot be read is not a new one to test against.
          return [harness, []]
        }
      }))
      return contextAutoPlan({ data, versions, sources })
    },
    test: async (harness) => {
      const ctx = context()
      const result = await runCli(ctx.script, ['context', 'test', harness, '--json', '--auto'], ctx.probeEnv, PROBE_TIMEOUT_MS)
      const report = parseJson(result.stdout)
      if (result.failed || report === null || typeof report.outcome !== 'string') return null
      return { outcome: report.outcome as ContextTestOutcome, version: typeof report.version === 'string' ? report.version : null, detail: String(report.detail ?? '') }
    },
    tell: (notice) => options.notifyApp?.(notice),
    read: contextAuto,
    write: (change) => { setContextAuto(change) },
    ...(options.contextRetryLater === undefined ? {} : { later: options.contextRetryLater })
  })

  const inspect = (harness: RosterHarness): AppInspection => {
    const ctx = context()
    return inspectApp(harness, ctx.env, ctx.probeEnv)
  }
  /** Approval seams: what an approval newly records as inspected is inspected again at commit (60.6 AC4). */
  const seams: ApprovalSeams = {
    checkInspectedRoutes: (routes) => {
      for (const route of routes) {
        const harness = route.harness as RosterHarness
        const { resolution, reason } = inspect(harness)
        if (resolution.basis !== 'default' || resolution.provider !== route.provider) {
          throw new RosterError('ROUTE_CHANGED', `${ROSTER_APP_NAMES[harness]} sends data to ${resolution.host ?? `an unknown destination${reason ? ` (${reason})` : ''}`}, not to ${route.provider}'s own servers; set its destination again in Rules > Health`)
        }
      }
    }
  }
  /**
   * Runs an approval, then updates the Team phrase in exactly the rules files the owner was shown
   * beside it. An approval that showed none updates none; a failure there leaves the approval standing.
   */
  const approving = async (params: Record<string, unknown>, run: () => string): Promise<AgentsOutcome> => {
    const shownTargets = teamUpdateParam(params)
    const result = outcome(run)
    if (!result.ok || shownTargets.length === 0) return result
    const ctx = context()
    let rulesUpdate: AgentsRulesUpdate
    try {
      const update = await applyTeamUpdate(shownTargets, { environment: ctx.env, now: ctx.now() })
      rulesUpdate = { transaction: update.transaction, written: update.written.map((entry) => entry.harness), skipped: update.skipped, ...(update.code === 'OK' ? {} : { failed: update.message ?? update.code }) }
    } catch (error) {
      rulesUpdate = { transaction: null, written: [], skipped: shownTargets.map((target) => target.harness), failed: error instanceof Error ? error.message : String(error) }
    }
    return { ...result, rulesUpdate }
  }

  handle('aiterm:agents:snapshot', () => agentsSnapshot())
  handle('aiterm:agents:preview', (params) => previewApproval(requestParam(params), context().env))
  handle('aiterm:agents:approve', (params) => {
    const shown = shownParam(params)
    const scope = scopeParam(params)
    return approving(params, () => scope === null
      ? `Approved · version ${approveRoster(shown, seams).number}`
      : `Kept · version ${approveSections(shown, scope, seams).number}`)
  })
  handle('aiterm:agents:save', (params) => {
    const shown = shownParam(params)
    const data = stagedParam(params)
    return approving(params, () => `Approved · version ${saveAndApprove(shown, data as RosterData, seams).number}`)
  })
  handle('aiterm:agents:guard-allow', (params) => {
    const shown = guardStopParam(params)
    return outcome(() => {
      // The same process, asked again now: Allow here records what is true at the press, not what was true at the stop.
      // The folder the card showed came from the app's own event, which nothing repeats here; whether the session is
      // still where it was is told by the process itself: it must be in the folder it was in when the prompt stopped.
      const again = decidePrompt({ agent: shown.agent, pid: shown.pid, ...(options.procRoot === undefined ? {} : { procRoot: options.procRoot }),
        event: { cwd: shown.folder, ...(shown.conversation === null ? {} : { session_id: shown.conversation }) } })
      if (again.start !== shown.start || again.outcome !== 'stop' || again.allow !== true || again.provider?.id !== shown.providerId
        || again.workspace !== shown.workspace || again.host !== shown.host || again.processFolder !== shown.processFolder) {
        throw new RosterError('REVISION_CONFLICT', 'This session changed since the prompt was stopped. Send the prompt again.')
      }
      const generation = allowWorkspace(shown.providerId, shown.workspace, seams)
      return `${again.provider.name} allowed in this workspace · version ${generation.number}`
    })
  })
  handle('aiterm:agents:revert', (params) => {
    const shown = shownParam(params)
    const scope = scopeParam(params)
    return outcome(() => revertFileToApproved(shown, scope).changed ? 'Team file put back to the approved version' : 'The team file already matched the approved version')
  })
  handle('aiterm:agents:restore', (params) => {
    const shown = shownParam(params)
    const number = numberParam(params)
    return approving(params, () => {
      // The team file follows the restored version, so edits nobody reviewed would go with it unseen: its sheet never showed them.
      const before = agentsSnapshot()
      if ((before.differences ?? []).length > 0) throw new RosterError('PENDING_CHANGES', 'Keep or revert the changes made outside BMN first.')
      const restored = restoreGeneration(shown, number, seams).number
      // With no approved team to compare with, the file's own edits were never shown: it keeps them, and they show as differences.
      const differs = before.approved === null ? (agentsSnapshot().differences ?? []).length > 0 : fileToApproved(shown)
      return `Version ${number} restored as version ${restored}${differs ? ' · the team file still holds later edits; keep or revert each' : ''}`
    })
  })
  handle('aiterm:agents:generation', (params) => {
    const generation = readGeneration(numberParam(params))
    return generation === null ? null : { generation: generation.number, createdAt: generation.created_at, data: generation.data }
  })
  handle('aiterm:agents:start', () => outcome(() => {
    // A new install: the starter team file, with no agents and nothing approved.
    const state = pathState(rosterPath())
    if (state.kind !== 'missing') throw new RosterError('REVISION_CONFLICT', 'a team file already exists; reload to see it')
    mkdirSync(agentsDirectory(), { recursive: true, mode: 0o700 })
    replaceFileSafely(rosterPath(), state, starterRoster())
    return 'Team file created'
  }))
  handle('aiterm:agents:open-file', async () => {
    const failure = options.openPath === undefined ? 'BMN cannot open files here' : await options.openPath(rosterPath())
    return { ok: failure === '', path: rosterPath(), ...(failure === '' ? {} : { message: failure }) }
  })
  handle('aiterm:agents:notes', (params) => {
    const shown = shownParam(params)
    const agent = textParam(params, 'agent', 32)
    const text = textParam(params, 'text', 8_000)
    return outcome(() => {
      const state = pathState(rosterPath())
      if (state.kind === 'missing') throw new RosterError('ROSTER_MISSING', `no team file at ${rosterPath()}`)
      const current = state.kind === 'file' ? state.text : readFileSync(rosterPath(), 'utf8')
      if (sha256(current) !== shown.fileHash || (shown.link !== undefined && shown.link !== (state.kind === 'link' ? state.target : null))
        || (typeof shown.directory === 'string' && shown.directory !== state.directory)) {
        throw new RosterError('REVISION_CONFLICT', 'the team file changed since it was shown; reload to see it')
      }
      const next = rewriteProse(current, agent, text)
      if (next !== current) replaceFileSafely(rosterPath(), state, next)
      return 'Notes saved'
    })
  })

  handle('aiterm:rules:snapshot', async () => {
    const snapshot = await rulesSnapshot(context())
    // Health has read the machine: a new app version is tested from here, with the versions this read found.
    void auto.trigger(Object.fromEntries(snapshot.context.map((row) => [row.harness, row.version])))
    return { ...snapshot, contextAuto: auto.view() }
  })
  handle('aiterm:rules:plan-master', (params) => {
    const text = textParam(params, 'text')
    const state = pathState(masterPath())
    const current = state.kind === 'file' ? state.text : state.kind === 'missing' ? '' : readFileSync(masterPath(), 'utf8')
    const errors = parseMaster(text).errors
    return {
      valid: errors.length === 0, errors, diff: unifiedDiff(current, text, masterPath()), expectedHash: state.kind === 'missing' ? null : sha256(current),
      expectedLink: state.kind === 'link' ? state.target : null, expectedDirectory: state.directory,
      renderings: errors.length === 0 ? renderAll(masterPath(), text, approvedOrProblem().generation) : []
    }
  })
  handle('aiterm:rules:save-master', async (params) => {
    const text = textParam(params, 'text')
    const expectedHash = params.expectedHash === null ? null : textParam(params, 'expectedHash', 64)
    const expectedLink = params.expectedLink === undefined || params.expectedLink === null ? null : textParam(params, 'expectedLink', 4096)
    const expectedDirectory = params.expectedDirectory === undefined || params.expectedDirectory === null ? null : textParam(params, 'expectedDirectory', 4096)
    const ctx = context()
    try {
      const state = pathState(masterPath())
      const current = state.kind === 'missing' ? null : state.kind === 'file' ? state.text : readFileSync(masterPath(), 'utf8')
      // The same bytes in another folder are not the rules that were shown: a link on the way moved (R60-NFR2).
      if ((current === null ? null : sha256(current)) !== expectedHash || (state.kind === 'link' ? state.target : null) !== expectedLink
        || (expectedDirectory !== null && expectedDirectory !== state.directory)) {
        throw new RosterError('REVISION_CONFLICT', 'the rules changed since they were shown; reload to see them')
      }
      writeMaster(state, text, 'saved in Preferences > Rules', { now: ctx.now() })
      return { ok: true, message: 'Saved · not installed yet', snapshot: await rulesSnapshot(ctx) } satisfies RulesOutcome
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'IO_ERROR'
      return { ok: false, code, message: error instanceof Error ? error.message : String(error), snapshot: await rulesSnapshot(ctx) } satisfies RulesOutcome
    }
  })
  handle('aiterm:rules:plan-install', async () => {
    const ctx = context()
    return planFrom(await runCli(ctx.script, ['rules', 'install', '--plan', '--json'], ctx.env), 'install')
  })
  handle('aiterm:rules:install', async (params) => {
    const planHash = textParam(params, 'planHash', 64)
    const ctx = context()
    const result = await runCli(ctx.script, ['rules', 'install', '--expect-plan', planHash, '--yes', '--json'], ctx.env)
    return rulesOutcome(ctx, result, (report) => report.transaction === null || report.transaction === undefined
      ? 'Every app already had the current rules'
      : `Installed to ${(report.written as unknown[]).length} agent app${(report.written as unknown[]).length === 1 ? '' : 's'}. Sessions started before this keep their old rules.`)
  })
  handle('aiterm:rules:plan-restore', async (params) => {
    const id = textParam(params, 'transaction', 80)
    const ctx = context()
    return planFrom(await runCli(ctx.script, ['rules', 'restore', '--transaction', id, '--plan', '--json'], ctx.env), 'restore')
  })
  handle('aiterm:rules:restore', async (params) => {
    const id = textParam(params, 'transaction', 80)
    const planHash = textParam(params, 'planHash', 64)
    const ctx = context()
    const result = await runCli(ctx.script, ['rules', 'restore', '--transaction', id, '--expect-plan', planHash, '--yes', '--json'], ctx.env)
    return rulesOutcome(ctx, result, (report) => {
      const apps = ((report.restored as RosterHarness[] | undefined) ?? []).map((harness) => ROSTER_APP_NAMES[harness] ?? harness)
      return `Put back the ${report.kind === 'skills' ? 'skills' : report.kind === 'tools' ? 'tools' : 'rules'} in ${apps.length <= 1 ? apps.join('') : `${apps.slice(0, -1).join(', ')} and ${apps.at(-1) as string}`}`
    })
  })
  handle('aiterm:rules:plan-revert-master', (params) => {
    const revision = params.revision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) invalid('revision must be a number')
    const entry = masterHistory().find((item) => item.revision === revision)
    if (entry === undefined || !entry.intact) return { ok: false, diff: '', expectedHash: null, message: `revision ${revision} is missing or corrupt` }
    const text = readFileSync(`${masterPath().replace(/global-rules\.md$/, '')}state/rules/master-history/${String(revision).padStart(6, '0')}.md`, 'utf8')
    const state = pathState(masterPath())
    const currentText = state.kind === 'missing' ? null : state.kind === 'file' ? state.text : readFileSync(masterPath(), 'utf8')
    return {
      ok: true, diff: unifiedDiff(currentText ?? '', text, masterPath()), expectedHash: currentText === null ? null : sha256(currentText),
      expectedLink: state.kind === 'link' ? state.target : null, expectedDirectory: state.directory, text
    }
  })
  handle('aiterm:rules:context-plan', (params): ContextLimitPlan => {
    const harness = contextApp(params.harness)
    const limit = sizeParam(params, 'limit')
    const compact = sizeParam(params, 'compact')
    const ctx = context()
    try {
      const plan = planContextDefault(harness, { limit, compact }, { environment: ctx.env, version: installedVersion(harness, ctx) })
      return {
        ok: true, code: 'OK', path: plan.path, diff: plan.diff, planHash: plan.plan_hash,
        ...(plan.resolved_path === undefined ? {} : { resolvedPath: plan.resolved_path }), ...(plan.link_target === undefined ? {} : { linkTarget: plan.link_target })
      }
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'IO_ERROR'
      return { ok: false, code, message: error instanceof Error ? error.message : String(error), diff: '', planHash: null }
    }
  })
  handle('aiterm:rules:context-apply', async (params) => {
    const harness = contextApp(params.harness)
    const limit = sizeParam(params, 'limit')
    const compact = sizeParam(params, 'compact')
    const planHash = textParam(params, 'planHash', 64)
    const ctx = context()
    try {
      const done = applyContextDefault(harness, { limit, compact }, planHash, { environment: ctx.env, version: installedVersion(harness, ctx), now: ctx.now() })
      const message = !done.written ? `${ROSTER_APP_NAMES[harness]} already had that default`
        : `${ROSTER_APP_NAMES[harness]}'s default context limit changed. Sessions started before this keep their old limit.`
      return { ok: true, message, snapshot: await rulesSnapshot(ctx) } satisfies RulesOutcome
    } catch (error) {
      const code = error instanceof ContextError || typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'IO_ERROR'
      return { ok: false, code, message: error instanceof Error ? error.message : String(error), snapshot: await rulesSnapshot(ctx) } satisfies RulesOutcome
    }
  })
  handle('aiterm:rules:context-test', async (params) => {
    const harness = contextApp(params.harness)
    const ctx = context()
    // Owner-run: the app starts once with its own environment, as a loading test does.
    const result = await runCli(ctx.script, ['context', 'test', harness, '--json'], ctx.probeEnv, PROBE_TIMEOUT_MS)
    return rulesOutcome(ctx, result, (report) => `${ROSTER_APP_NAMES[harness]} context test ${PROBE_OUTCOME_WORDS[String(report.outcome)] ?? String(report.outcome)}: ${String(report.detail)}`)
  })
  // `fresh` makes BMN look now (an update command ended); without it the call only waits for a test under way.
  handle('aiterm:rules:context-auto', async (params) => {
    await (params.fresh === true ? auto.trigger() : auto.settled())
    return auto.view()
  })
  handle('aiterm:rules:context-auto-set', async (params) => {
    if (typeof params.enabled !== 'boolean') invalid('enabled must be true or false')
    const ctx = context()
    try {
      setContextAuto({ enabled: params.enabled })
    } catch (error) {
      return { ok: false, code: 'IO_ERROR', message: error instanceof Error ? error.message : String(error), snapshot: await rulesSnapshot(ctx) } satisfies RulesOutcome
    }
    const snapshot = await rulesSnapshot(ctx)
    if (params.enabled) void auto.trigger(Object.fromEntries(snapshot.context.map((row) => [row.harness, row.version])))
    const message = params.enabled ? 'BMN tests context limits by itself after an app update' : 'BMN no longer tests context limits by itself'
    return { ok: true, message, snapshot: { ...snapshot, contextAuto: auto.view() } } satisfies RulesOutcome
  })
  handle('aiterm:rules:skills-plan', async () => {
    const ctx = context()
    return skillsPlanFrom(await runCli(ctx.script, ['skills', 'install', '--plan', '--json'], ctx.env))
  })
  handle('aiterm:rules:skills-install', async (params) => {
    const planHash = textParam(params, 'planHash', 64)
    const ctx = context()
    const result = await runCli(ctx.script, ['skills', 'install', '--expect-plan', planHash, '--yes', '--json'], ctx.env)
    return rulesOutcome(ctx, result, (report) => {
      const changed = Array.isArray(report.written) ? report.written.length : 0
      const open = Array.isArray(report.exposed) ? report.exposed.length : 0
      const done = changed === 0 ? 'Every app already had its skills.' : `Changed ${changed} skill entr${changed === 1 ? 'y' : 'ies'}. Sessions started before this keep the skills they had.`
      return open === 0 ? done : `${done} ${open} skill${open === 1 ? ' stays' : 's stay'} exposed.`
    })
  })
  handle('aiterm:rules:skills-test', async (params) => {
    const harness = harnessParam(params.harness)
    const ctx = context()
    // Owner-run: the app starts with its own environment, as a loading test does.
    const result = await runCli(ctx.script, ['skills', 'test', harness, '--json'], ctx.probeEnv, PROBE_TIMEOUT_MS)
    return rulesOutcome(ctx, result, (report) => `${ROSTER_APP_NAMES[harness]} skills test ${PROBE_OUTCOME_WORDS[String(report.outcome)] ?? String(report.outcome)}: ${String(report.detail)}`)
  })
  handle('aiterm:rules:skills-loading-test', async (params) => {
    const harness = harnessParam(params.harness)
    const ctx = context()
    // Owner-run: one prompt goes to that app's provider, from the app's own environment.
    const result = await runCli(ctx.script, ['skills', 'test', harness, '--prompt', '--json'], ctx.probeEnv, PROBE_TIMEOUT_MS)
    return rulesOutcome(ctx, result, (report) => `${ROSTER_APP_NAMES[harness]} skill loading test ${PROBE_OUTCOME_WORDS[String(report.outcome)] ?? String(report.outcome)}: ${String(report.detail)}`)
  })
  handle('aiterm:rules:tools-plan', async (params) => {
    const removeUnlisted = params.removeUnlisted === true
    const ctx = context()
    return toolsPlanFrom(await runCli(ctx.script, ['tools', 'install', '--plan', '--json', ...(removeUnlisted ? ['--remove-unlisted'] : [])], ctx.env), removeUnlisted)
  })
  handle('aiterm:rules:tools-install', async (params) => {
    const planHash = textParam(params, 'planHash', 64)
    const ctx = context()
    const result = await runCli(ctx.script, ['tools', 'install', '--expect-plan', planHash, '--yes', '--json', ...(params.removeUnlisted === true ? ['--remove-unlisted'] : [])], ctx.env)
    return rulesOutcome(ctx, result, (report) => {
      const changed = Array.isArray(report.written) ? report.written.length : 0
      const exposed = Array.isArray(report.exposed) ? report.exposed.length : 0
      const blocked = Array.isArray(report.blocked) ? report.blocked.length : 0
      const done = changed === 0 ? 'Every app already had its tools.' : `Changed ${changed} tool entr${changed === 1 ? 'y' : 'ies'}. Sessions started before this keep the tools they had.`
      return [done, ...(exposed === 0 ? [] : [`${exposed} ${exposed === 1 ? 'stays' : 'stay'} exposed.`]), ...(blocked === 0 ? [] : [`${blocked} could not be changed.`])].join(' ')
    })
  })
  handle('aiterm:rules:tools-test', async (params) => {
    const harness = harnessParam(params.harness)
    const ctx = context()
    // Owner-run: the app starts in an empty home folder, found with the owner's own program path.
    const result = await runCli(ctx.script, ['tools', 'test', harness, '--json'], ctx.probeEnv, PROBE_TIMEOUT_MS)
    return rulesOutcome(ctx, result, (report) => `${ROSTER_APP_NAMES[harness]} tools test ${PROBE_OUTCOME_WORDS[String(report.outcome)] ?? String(report.outcome)}: ${String(report.detail)}`)
  })
  // What the apps already hold, proposed as tools: read only, and never a value an entry held (60.12 AC3).
  handle('aiterm:rules:tools-proposals', () => {
    const ctx = context()
    try {
      return { ok: true, proposals: proposeTools({ environment: ctx.env, generation: approvedIfAny() }).proposals as ToolProposalView[] }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), proposals: [] as ToolProposalView[] }
    }
  })
  handle('aiterm:rules:probe', async (params) => {
    const harness = harnessParam(params.harness)
    const ctx = context()
    const result = await runCli(ctx.script, ['rules', 'probe', harness, '--json'], ctx.probeEnv, PROBE_TIMEOUT_MS)
    return rulesOutcome(ctx, result, (report) => `${ROSTER_APP_NAMES[harness]} loading test ${PROBE_OUTCOME_WORDS[String(report.outcome)] ?? String(report.outcome)}: ${String(report.detail)}`)
  })

  // Team › Models (60.10). One research at a time; it runs in this process so Stop can end it and the page can say how far it is.
  let research: { researcher: string; done: number; total: number; lookup: boolean; controller: AbortController } | null = null
  let researchEnded: ResearchSnapshot['ended'] = null
  let researcherList: ResearcherView[] | null = null
  // The fence test of the installed Codex (63.3): the owner starts it here, one at a time; it calls no provider.
  let fenceTest: ResearchSnapshot['fenceTest'] = { running: false, ended: null }
  /** A research run starts the owner's own app: his environment, without BMN's stand-in commands on the program path. */
  const researchEnvironment = (ctx: RulesIpcContext): NodeJS.ProcessEnv => {
    const own = dirname(ctx.script)
    return { ...ctx.probeEnv, PATH: (ctx.probeEnv.PATH ?? '').split(':').filter((entry) => entry !== own).join(':') }
  }
  // Stop and what is left of the research's time reach the page read itself, so neither waits for a slow site.
  const readPage: typeof fetchPublicPage = (address, limits) => (options.researchFetch ?? fetchPublicPage)(address, { ...limits, selfTestPages: options.researchPages?.() ?? null })
  const researchLimit = (): { limitMs?: number; compare?: NonNullable<AgentsIpcOptions['researchCompare']> } => {
    const limitMs = options.researchLimitMs?.()
    return { ...(limitMs === undefined ? {} : { limitMs }), ...(options.researchCompare === undefined ? {} : { compare: options.researchCompare }) }
  }
  const researchSnapshot = (fresh: boolean): ResearchSnapshot => {
    const ctx = context()
    // Asking each agent's app for its version takes a moment, so it happens when Models or New agent opens, not on every look at a run.
    if (fresh) researcherList = researchers({ environment: researchEnvironment(ctx), now: ctx.now() }) as ResearcherView[]
    const able = (researcherList ?? []).filter((entry) => entry.ok)
    // A pick the team no longer names falls back to none picked here, and the page says so (63.3 AC8).
    const { researcher: chosen, dropped } = settledResearcher()
    return {
      ...researchView(readResearch()) as Pick<ResearchSnapshot, 'last' | 'previousAt' | 'models'>,
      researchers: researcherList ?? [],
      // With no pick yet the first one offered stands; after a pick fell away nobody does, until the owner picks again (63.3 AC8).
      researcher: able.some((entry) => entry.id === chosen) ? chosen : dropped !== null ? null : able[0]?.id ?? null,
      choice: researcherChoice(),
      dropped: dropped === null ? null : approvedIfAny()?.data.agents.find((agent) => agent.id === dropped)?.name ?? dropped,
      fenceTest,
      running: research === null ? null : { researcher: research.researcher, done: research.done, total: research.total, lookup: research.lookup },
      ended: researchEnded
    }
  }
  /**
   * A research with a Codex agent may have closed that agent's offer: the comparison under the
   * provider's own model list is recorded where the check reads it. So who can research is read
   * again before the page hears that the research ended, and the page shows the refusal at once.
   */
  const rereadAfter = (researcher: string, ctx: RulesIpcContext): void => {
    if (researcherList?.find((entry) => entry.id === researcher)?.harness !== 'codex') return
    try {
      researcherList = researchers({ environment: researchEnvironment(ctx), now: ctx.now() }) as ResearcherView[]
    } catch {
      // The list as last read stays; the next look at Models reads it again.
    }
  }
  const begin = (researcher: string, lookup: boolean): NonNullable<typeof research> => {
    const state = { researcher, done: 0, total: 0, lookup, controller: new AbortController() }
    research = state
    researchEnded = null
    return state
  }
  handle('aiterm:research:load', (params) => researchSnapshot(params.fresh === true))
  handle('aiterm:research:choose', (params) => {
    const researcher = textParam(params, 'researcher', 64)
    // Only one of the listed researchers can be picked: an agent the team does not name is not among them.
    if ((researcherList ?? []).some((entry) => entry.id === researcher)) chooseResearcher(researcher)
    return researchSnapshot(false)
  })
  handle('aiterm:research:fence-test', () => {
    if (fenceTest.running || research !== null) return researchSnapshot(false)
    const ctx = context()
    fenceTest = { running: true, ended: null }
    const finish = (ended: NonNullable<ResearchSnapshot['fenceTest']['ended']>): void => {
      // Who is offered depends on the record the test just wrote, so the list is read again before the page hears of the end.
      researcherList = researchers({ environment: researchEnvironment(ctx), now: ctx.now() }) as ResearcherView[]
      fenceTest = { running: false, ended }
    }
    void (options.fenceTest ?? runFenceTest)({ environment: researchEnvironment(ctx), now: ctx.now() }).then(
      (entry) => finish({ ok: entry.verdict === 'pass', text: fenceEndedWords(entry) }),
      (error: unknown) => finish({ ok: false, text: `The fence test could not run: ${error instanceof Error ? error.message : String(error)}` }))
    return researchSnapshot(false)
  })
  handle('aiterm:research:start', (params) => {
    const researcher = textParam(params, 'researcher', 64)
    // One at a time, the fence test included: a research asks how that test stands.
    if (research !== null || fenceTest.running) return researchSnapshot(false)
    // A web question holds the same lock, whoever asked it (64.3 AC2): nothing starts, and the page says why.
    const held = researchLockHolder()
    if (held !== null) {
      researchEnded = { ok: false, text: `${held.kind === 'question' ? 'A web question is running' : 'Another research is running'}, so this research did not start. Wait for it to end, or stop it.`, kept: false }
      return researchSnapshot(false)
    }
    const ctx = context()
    chooseResearcher(researcher)
    const state = begin(researcher, false)
    void runResearch({
      researcher, environment: researchEnvironment(ctx), now: ctx.now, signal: state.controller.signal, fetchPage: readPage, ...researchLimit(),
      onProgress: ({ done, total }) => Object.assign(state, { done, total })
    }).then(({ run }) => {
      // A run the owner stopped ended as he asked; only a run that failed or ran out of time reads as a problem.
      researchEnded = { ok: run.state === 'complete' || state.controller.signal.aborted, text: researchEndedWords(run), kept: run.models > 0 }
    }, (error: unknown) => {
      researchEnded = { ok: false, text: `Research failed: ${error instanceof Error ? error.message : String(error)}`, kept: false }
    }).finally(() => {
      rereadAfter(researcher, ctx)
      if (research === state) research = null
    })
    return researchSnapshot(false)
  })
  handle('aiterm:research:stop', () => {
    research?.controller.abort()
    return researchSnapshot(false)
  })
  handle('aiterm:research:lookup', async (params): Promise<ResearchLookup> => {
    const researcher = textParam(params, 'researcher', 64)
    const provider = textParam(params, 'provider', 64)
    const model = textParam(params, 'model', 100)
    if (research !== null) return { ok: false, message: 'A research is going. Wait for it to end, or stop it.', model: null }
    if (fenceTest.running) return { ok: false, message: 'The Codex fence test is running. Wait for it to end.', model: null }
    if (researchLockHolder()?.kind === 'question') return { ok: false, message: 'A web question is running. Wait for it to end, or stop it.', model: null }
    const ctx = context()
    const state = begin(researcher, true)
    try {
      const { run, found } = await runResearch({
        researcher, only: { provider, model }, environment: researchEnvironment(ctx), now: ctx.now, signal: state.controller.signal, fetchPage: readPage, ...researchLimit(),
        onProgress: ({ done, total }) => Object.assign(state, { done, total })
      })
      const view = (researchView(readResearch()).models as ResearchSnapshot['models']).find((entry) => entry.providerId === provider && entry.id === model) ?? null
      if (found.length === 0 || view === null) return { ok: false, message: `Look up found nothing: ${run.note ?? 'the researcher gave no answer'}`, model: null }
      return { ok: true, message: `Looked up ${model}.`, model: view }
    } catch (error) {
      return { ok: false, message: `Look up failed: ${error instanceof Error ? error.message : String(error)}`, model: null }
    } finally {
      rereadAfter(researcher, ctx)
      if (research === state) research = null
    }
  })

  // Team › Models, "Web questions" (64.3). The owner's own Ask runs in this process, as a research does; an agent's runs in its own.
  let asking: { controller: AbortController } | null = null
  const questionsSnapshot = (): WebQuestionsSnapshot => {
    const kept = readQuestions()
    const held = researchLockHolder()
    // A team that cannot be read names nobody: the list still shows, with the ids the records hold.
    let names = new Map<string, string>()
    try {
      names = new Map((approvedIfAny()?.data.agents ?? []).map((agent) => [agent.id, agent.name]))
    } catch {
      // Said on the Team page; nothing to add here.
    }
    return {
      questions: kept.map((entry) => questionView(entry, names)).reverse(),
      holder: held === null ? null : {
        kind: held.kind === 'question' || held.kind === 'lookup' ? held.kind : 'research',
        ...(typeof held.id === 'string' ? { id: held.id.slice(0, 64) } : {}), ...(typeof held.at === 'string' ? { at: held.at.slice(0, 32) } : {}),
        ...(typeof held.researcher === 'string' ? { researcher: names.get(held.researcher) ?? held.researcher.slice(0, 64) } : {}),
        ...(askerOf(held.by) === null ? {} : { by: askerOf(held.by)! })
      },
      agentsMayAsk: agentsMayAsk(),
      today: askedCount(context().now()),
      limits: { perDay: ASK_PER_DAY, minutes: ASK_LIMIT_MS / 60_000, characters: ASK_MAX_CHARS, kept: ASK_KEPT }
    }
  }
  handle('aiterm:questions:load', () => questionsSnapshot())
  handle('aiterm:questions:ask', async (params): Promise<WebQuestionAsked> => {
    // Longer than the command takes, so that a question too long is refused in the command's own words.
    const question = textParam(params, 'question', 16 * ASK_MAX_CHARS)
    if (fenceTest.running) return { ok: false, message: 'The Codex fence test is running. Wait for it to end.', snapshot: questionsSnapshot() }
    const ctx = context()
    const state = { controller: new AbortController() }
    let begun!: () => void
    const started = new Promise<null>((resolve) => { begun = () => resolve(null) })
    const run = runAsk({
      question, by: { kind: 'owner' }, owner: true, environment: researchEnvironment(ctx), now: ctx.now, signal: state.controller.signal, fetchPage: readPage, ...researchLimit(),
      onStart: () => { asking = state; begun() }
    }).then((result) => result, (error: unknown) => ({ ok: false, outcome: 'failed' as const, researcher: null, message: `The question failed: ${error instanceof Error ? error.message : String(error)}` }))
    void run.then((result) => {
      if (asking === state) asking = null
      if (typeof result.researcher === 'string') rereadAfter(result.researcher, ctx)
    })
    // Refused before anything started: said now, in the command's words. Started: the list shows it running.
    const first = await Promise.race([started, run])
    if (first === null) return { ok: true, message: null, snapshot: questionsSnapshot() }
    return { ok: first.ok, message: first.ok ? null : first.message ?? ('note' in first ? first.note : undefined) ?? 'The question could not be asked.', snapshot: questionsSnapshot() }
  })
  handle('aiterm:questions:stop', () => {
    // Whoever started it (AC2): this window's own question or research by its own switch, another process's question by the signal Ctrl-C sends.
    if (asking !== null) asking.controller.abort()
    else if (research !== null) research.controller.abort()
    else {
      const held = researchLockHolder()
      if (held !== null && held.kind === 'question' && held.pid !== process.pid && isQuestionCommand(held.pid, held.start)) {
        try {
          process.kill(held.pid, 'SIGINT')
        } catch {
          // It ended by itself in between.
        }
      }
    }
    return questionsSnapshot()
  })
  handle('aiterm:questions:allow', (params) => {
    if (typeof params.on !== 'boolean') invalid('on must be true or false')
    setAgentsMayAsk(params.on)
    return questionsSnapshot()
  })
  handle('aiterm:questions:open-page', async (params) => {
    const id = textParam(params, 'id', 64)
    if (!Number.isSafeInteger(params.claim) || (params.claim as number) < 0) invalid('claim must be a claim\'s place in the record')
    // The address comes from the kept record, written by a researcher: only an https address of a public name is opened, and only in the browser.
    const source = readQuestions().find((entry) => entry.id === id)?.claims?.[params.claim as number]?.source
    const address = httpsPage(source)
    if (address === null || options.openExternal === undefined) return { opened: false }
    await options.openExternal(address)
    return { opened: true }
  })
  handle('aiterm:questions:remove', (params) => {
    if (params.id !== null && (typeof params.id !== 'string' || params.id.length > 64)) invalid('id must be a question id or null')
    removeQuestions(params.id, context().now())
    return questionsSnapshot()
  })
  return { contextAutoAtStart: () => auto.trigger() }
}

/**
 * A kept page address as the browser may be given it: https, no sign-in part, and a host that is a
 * public name. A researcher's answer never sends the owner's browser to this machine or his network.
 */
function httpsPage(source: unknown): string | null {
  if (typeof source !== 'string') return null
  try {
    const address = new URL(source)
    const plain = address.protocol === 'https:' && address.username === '' && address.password === ''
    return plain && publicHostName(address.hostname.toLowerCase().replace(/\.$/, '')) ? address.href : null
  } catch {
    return null
  }
}

/** Who asked, as far as a stored value says it; anything else is nobody BMN can name. */
function askerOf(value: unknown): WebQuestionAsker | null {
  if (value === null || typeof value !== 'object') return null
  const by = value as { kind?: unknown; session?: unknown; app?: unknown }
  if (by.kind === 'owner' || by.kind === 'shell') return { kind: by.kind }
  if (by.kind !== 'session' || typeof by.session !== 'string') return null
  return { kind: 'session', session: by.session.slice(0, 64), ...(typeof by.app === 'string' ? { app: by.app.slice(0, 32) } : {}) }
}

/** One kept question as the page lists it; a field of the wrong kind is left out, never shown. */
function questionView(entry: QuestionRecord, names: ReadonlyMap<string, string>): WebQuestionView {
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
  const claims = Array.isArray(entry.claims)
    ? entry.claims.filter((claim) => claim !== null && typeof claim === 'object' && [claim.claim, claim.source, claim.passage, claim.mark].every((part) => typeof part === 'string'))
      .map((claim) => ({ claim: claim.claim, source: claim.source, passage: claim.passage, mark: claim.mark, ...(typeof claim.why === 'string' ? { why: claim.why } : {}) }))
    : undefined
  const counts = entry.counts
  return {
    id: entry.id, at: entry.at, by: askerOf(entry.by) ?? { kind: 'shell' },
    researcher: text(entry.researcher_name) ?? (typeof entry.researcher === 'string' ? names.get(entry.researcher) ?? entry.researcher : null),
    question: text(entry.question) ?? null, outcome: entry.outcome,
    ...(text(entry.note) === undefined ? {} : { note: text(entry.note)! }), ...(text(entry.answer) === undefined ? {} : { answer: text(entry.answer)! }),
    ...(claims === undefined ? {} : { claims }),
    ...(Array.isArray(entry.not_found) ? { notFound: entry.not_found.filter((line): line is string => typeof line === 'string') } : {}),
    ...(counts !== undefined && [counts.found, counts.not_found, counts.unreadable].every(Number.isSafeInteger) ? { counts: { found: counts.found, not_found: counts.not_found, unreadable: counts.unreadable } } : {}),
    ...(Number.isSafeInteger(entry.took_ms) ? { tookMs: entry.took_ms! } : {})
  }
}

/**
 * Whether a process is BMN's own `bmn research ask`, still the one that wrote the lock: its start
 * time is the lock's, and its command line is the command's. Stop signals nothing else.
 */
function isQuestionCommand(pid: number, start: string): boolean {
  if (processStart(pid) !== start) return false
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    const script = argv.findIndex((part) => basename(part) === 'bmn')
    return script !== -1 && argv[script + 1] === 'research' && argv[script + 2] === 'ask'
  } catch {
    return false
  }
}

/** How a fence test ended, for the page's notice. */
export function fenceEndedWords(entry: Pick<FenceTestEntry, 'verdict' | 'version' | 'models' | 'reasons'>): string {
  const app = `${ROSTER_APP_NAMES.codex}${entry.version === null ? '' : ` ${entry.version}`}`
  if (entry.verdict === 'pass') return `The fence test of ${app} passed: a research run sends its provider nothing of yours.`
  const why = [...entry.models.flatMap((model) => model.reasons.map((reason) => `${model.model}: ${reason}`)), ...(entry.reasons ?? [])]
  return `The fence test of ${app} ${entry.verdict === 'fail' ? 'failed' : 'showed nothing'}${why.length === 0 ? '.' : `: ${why.slice(0, 3).join('; ')}.`} No Codex agent is offered as a researcher.`
}

/** How a research ended, for the page's notice. */
export function researchEndedWords(run: Pick<ResearchRunRecord, 'state' | 'models' | 'note'>): string {
  const count = `${run.models} model${run.models === 1 ? '' : 's'}`
  if (run.state === 'complete') return `Research found ${count}.`
  if (run.state === 'partial') return `Research kept ${count}. ${run.note ?? ''}`.trim()
  if (run.state === 'stopped') return `${run.note ?? 'Research stopped.'} Nothing was kept.`
  return `Research failed: ${run.note ?? 'no reason was given'}`
}
