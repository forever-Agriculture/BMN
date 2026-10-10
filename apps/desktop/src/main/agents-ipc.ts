// MODULE: agents-ipc.ts - Epic 60.5/60.6: renderer channels for the Preferences Team and Rules pages
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
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
  type RosterDataShape,
  type RosterHarness,
  type RulesOutcome,
  type RulesPlan,
  type RulesProbeView,
  type RulesRenderingView,
  type RulesSnapshot,
  type RulesTargetHealth,
  type TeamUpdateTarget
} from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { HARNESSES, RosterError, agentsDirectory, parseRoster, proseOf, rewriteProse, rewriteRoster, rosterPath, sha256, starterRoster, type RosterData } from '../../bin/agents-roster.mjs'
import { listGenerations, machineDiff, readApproved, readGeneration, type Generation } from '../../bin/agents-state.mjs'
import { TESTED_HARNESS_VERSIONS, consequences, harnessVersion, inspectRoute, versionStanding } from '../../bin/agents-check.mjs'
import {
  applyTeamUpdate, lastProbes, listTransactions, masterHistory, masterPath, parseMaster, planTeamUpdate, probeInspector, render, writeMaster, type RulesHarness
} from '../../bin/agents-rules.mjs'
import { pathState, replaceFileSafely } from '../../bin/safe-config-write.mjs'
import { unifiedDiff } from '../../bin/text-diff.mjs'
import { approveRoster, approveSections, mergeSections, restoreGeneration, revertFileToApproved, saveAndApprove, type ApprovalSeams } from './agents-approval'
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
  /** Opens a file in the owner's own editor; resolves to an error message, or '' when it opened. */
  openPath?(path: string): Promise<string>
  now?(): Date
}

/** Variables the rules CLI reads to find each app's file and its destination; nothing else of this process's environment. */
const RULES_ENV = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR',
  'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const
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

/** One line saying what an approved version changed, from the same sentences the review shows. */
function versionSummary(entry: AgentsSnapshot['history'][number]): string | undefined {
  if (!entry.valid || entry.earlier_schema !== undefined) return undefined
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
function fileToApproved(): boolean {
  const now = agentsSnapshot()
  if (now.approved === null || now.file.hash === null || (now.differences ?? []).length === 0) return false
  try {
    revertFileToApproved({ generation: now.approved.generation, fileHash: now.file.hash, link: now.file.link, directory: now.file.directory }, null)
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

export interface RulesIpcContext { script: string; env: NodeJS.ProcessEnv; probeEnv: NodeJS.ProcessEnv; now: () => Date }

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
  return { ...resolution, versionState, versionNote, ...(reason === undefined ? {} : { reason }) }
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
  const renderings = text !== null && errors.length === 0 ? renderAll(path, text, generation) : []
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
    apps: (HARNESSES as RosterHarness[]).map((harness) => appView(harness, context)),
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

export function installAgentsIpcHandlers(ipc: AgentsIpcRegistrar, options: AgentsIpcOptions): void {
  const handle = (channel: `aiterm:${string}`, listener: (params: Record<string, unknown>) => unknown): void => {
    ipc.handle(channel, (event, params) => {
      if (!options.senderIsAllowed(event)) throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
      return listener(objectParams(params))
    })
  }
  const context = (): RulesIpcContext => {
    const environment = options.environment?.() ?? process.env
    return { script: options.cliScript(), env: rulesEnvironment(environment), probeEnv: probeEnvironment(environment), now: options.now ?? (() => new Date()) }
  }

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
  handle('aiterm:agents:revert', (params) => {
    const shown = shownParam(params)
    const scope = scopeParam(params)
    return outcome(() => revertFileToApproved(shown, scope).changed ? 'Team file put back to the approved version' : 'The team file already matched the approved version')
  })
  handle('aiterm:agents:restore', (params) => {
    const shown = shownParam(params)
    const number = numberParam(params)
    return approving(params, () => {
      const restored = restoreGeneration(shown, number, seams).number
      return `Version ${number} restored as version ${restored}${fileToApproved() ? ' · the team file still holds later edits; keep or revert each' : ''}`
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

  handle('aiterm:rules:snapshot', () => rulesSnapshot(context()))
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
    return rulesOutcome(ctx, result, (report) => `Put back ${((report.restored as RosterHarness[] | undefined) ?? []).map((harness) => ROSTER_APP_NAMES[harness] ?? harness).join(', ')}`)
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
  handle('aiterm:rules:probe', async (params) => {
    const harness = harnessParam(params.harness)
    const ctx = context()
    const result = await runCli(ctx.script, ['rules', 'probe', harness, '--json'], ctx.probeEnv, PROBE_TIMEOUT_MS)
    return rulesOutcome(ctx, result, (report) => `${ROSTER_APP_NAMES[harness]} loading test ${PROBE_OUTCOME_WORDS[String(report.outcome)] ?? String(report.outcome)}: ${String(report.detail)}`)
  })
}
