// MODULE: agents-ipc.ts - Epic 60.5/60.6: renderer channels for the Preferences Agents and Rules sections
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  ERROR_CODES,
  type AgentsOutcome,
  type AgentsPreview,
  type AgentsShownRevision,
  type AgentsSnapshot,
  type RosterDataShape,
  type RosterHarness,
  type RouteInspectionView,
  type RulesOutcome,
  type RulesPlan,
  type RulesProbeView,
  type RulesRenderingView,
  type RulesSnapshot,
  type RulesTargetHealth,
  type WorkspaceLabelView
} from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { HARNESSES, RosterError, parseRoster, proseOf, rewriteProse, rewriteRoster, rosterPath, sha256, type RosterData } from '../../bin/agents-roster.mjs'
import { listGenerations, machineDiff, readApproved, readGeneration, type Generation } from '../../bin/agents-state.mjs'
import { consequences, inspectRoute, labelFor } from '../../bin/agents-check.mjs'
import { lastProbes, listTransactions, masterHistory, masterPath, parseMaster, render, writeMaster, type RulesHarness } from '../../bin/agents-rules.mjs'
import { pathState, replaceFileSafely } from '../../bin/safe-config-write.mjs'
import { unifiedDiff } from '../../bin/text-diff.mjs'
import { approveRoster, approveSections, restoreGeneration, revertFileToApproved, saveAndApprove } from './agents-approval'
import { judgeInspection } from './route-baselines'
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
  now?(): Date
}

/** Variables the rules CLI reads to find each harness's file and its route; nothing else of this process's environment. */
const RULES_ENV = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR',
  'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const
const PROBE_OUTCOME_WORDS: Readonly<Record<string, string>> = { pass: 'passed', fail: 'failed', inconclusive: 'was inconclusive', unavailable: 'was unavailable' }
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
    invalid('shown must name the generation and file hash the panel showed')
  }
  return { generation: shown.generation, fileHash: shown.fileHash }
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

/** Everything the Agents section shows, read fresh from the roster file and approved state. */
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
  const differences = generation && data ? machineDiff(generation.data, data) : null
  const effects = data && (generation || problem?.code === 'NOT_APPROVED') && (differences === null || differences.length > 0)
    ? consequences(generation?.data ?? null, data) : []
  return {
    rosterPath: path,
    file: {
      exists: text !== null, hash: text === null ? null : sha256(text),
      errors: parsed?.errors ?? [], warnings: parsed?.warnings ?? [], data: data as RosterDataShape | null, prose
    },
    approved: generation ? { generation: generation.number, createdAt: generation.created_at, data: generation.data as RosterDataShape } : null,
    approvalProblem: problem,
    differences,
    consequences: effects,
    history: listGenerations() as unknown as AgentsSnapshot['history']
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

/** Staged data as the file would hold it: rewritten, re-read and validated exactly as a save would. */
export function previewStaged(staged: RosterDataShape): AgentsPreview {
  let text: string
  try {
    text = readFileSync(rosterPath(), 'utf8')
  } catch {
    return { valid: false, errors: [{ code: 'ROSTER_MISSING', message: `no roster at ${rosterPath()}` }], differences: [], consequences: [] }
  }
  const parsed = parseRoster(rewriteRoster(text, staged as RosterData))
  if (parsed.data === null) return { valid: false, errors: parsed.errors, differences: [], consequences: [] }
  const { generation } = approvedOrProblem()
  const differences = generation ? machineDiff(generation.data, parsed.data) : []
  return { valid: true, errors: [], differences, consequences: consequences(generation?.data ?? null, parsed.data) }
}

function stagedParam(params: Record<string, unknown>): RosterDataShape {
  const data = params.data as RosterDataShape | undefined
  if (!data || typeof data !== 'object' || data.schema_version !== 1 || !Array.isArray(data.agents) || !Array.isArray(data.roles)
    || !Array.isArray(data.harness_routes) || !data.data_labels || !Array.isArray(data.data_labels.paths)) {
    invalid('data must be roster machine data')
  }
  return data
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

/** Each harness's exact rendering of `text` against the approved generation (60.6 AC2). */
function renderAll(path: string, text: string, generation: Generation | null): RulesRenderingView[] {
  const master = { path, text, hash: sha256(text), parts: parseMaster(text).parts }
  return (HARNESSES as RulesHarness[]).map((harness) => {
    const rendering = render(master, harness, generation)
    return { harness, text: rendering.text, bytes: rendering.bytes, restricted: rendering.restricted, reason: rendering.reason, teamForm: rendering.team_form }
  })
}

export interface RulesIpcContext { script: string; env: NodeJS.ProcessEnv; probeEnv: NodeJS.ProcessEnv; now: () => Date }

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
    restricted: row.restricted === true, reason: String(row.reason ?? ''),
    ...(typeof row.link_target === 'string' ? { linkTarget: row.link_target } : {})
  }))
  return { state: 'checked', checkedAt, ok: report.ok, targets }
}

export async function rulesSnapshot(context: RulesIpcContext): Promise<RulesSnapshot> {
  const path = masterPath()
  let text: string | null
  try {
    text = readFileSync(path, 'utf8')
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
    master: { exists: text !== null, text, hash: text === null ? null : sha256(text), bytes: text === null ? 0 : Buffer.byteLength(text), errors },
    renderings,
    health: text === null ? { state: 'failed', checkedAt: context.now().toISOString(), reason: `No rules master at ${path}` } : await rulesHealth(context),
    probes: lastProbes() as RulesProbeView[],
    transactions: listTransactions().slice(0, 10).map((entry) => ({
      id: entry.id, valid: entry.valid, ...(entry.created_at ? { createdAt: entry.created_at } : {}),
      ...(entry.state ? { state: entry.state } : {}), ...(entry.targets ? { targets: entry.targets } : {})
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
    ...(typeof row.restricted === 'boolean' ? { restricted: row.restricted } : {}),
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

  handle('aiterm:agents:snapshot', () => agentsSnapshot())
  handle('aiterm:agents:preview', (params) => previewStaged(stagedParam(params)))
  handle('aiterm:agents:approve', (params) => {
    const shown = shownParam(params)
    const scope = scopeParam(params)
    return outcome(() => scope === null
      ? `Approved generation ${approveRoster(shown).number}.`
      : `Approved ${scope.join(', ')} as generation ${approveSections(shown, scope).number}; other differences stay pending.`)
  })
  handle('aiterm:agents:save', (params) => {
    const shown = shownParam(params)
    const data = stagedParam(params)
    return outcome(() => `Saved and approved generation ${saveAndApprove(shown, data as RosterData).number}.`)
  })
  handle('aiterm:agents:revert', (params) => {
    const shown = shownParam(params)
    const scope = scopeParam(params)
    return outcome(() => revertFileToApproved(shown, scope).changed ? 'The file holds the approved data again.' : 'The file already matched the approved data.')
  })
  handle('aiterm:agents:restore', (params) => {
    const shown = shownParam(params)
    const number = params.number
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) invalid('number must be a generation number')
    return outcome(() => `Generation ${number} restored as generation ${restoreGeneration(shown, number).number}.`)
  })
  handle('aiterm:agents:generation', (params) => {
    const number = params.number
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) invalid('number must be a generation number')
    const generation = readGeneration(number)
    return generation === null ? null : { generation: generation.number, createdAt: generation.created_at, data: generation.data }
  })
  handle('aiterm:agents:opinion', (params) => {
    const shown = shownParam(params)
    const agent = textParam(params, 'agent', 32)
    const text = textParam(params, 'text', 8_000)
    return outcome(() => {
      const state = pathState(rosterPath())
      if (state.kind === 'missing') throw new RosterError('ROSTER_MISSING', `no roster at ${rosterPath()}`)
      const current = state.kind === 'file' ? state.text : readFileSync(rosterPath(), 'utf8')
      if (sha256(current) !== shown.fileHash) throw new RosterError('REVISION_CONFLICT', 'the roster changed since it was shown; reload to see it')
      const next = rewriteProse(current, agent, text)
      if (next !== current) replaceFileSafely(rosterPath(), state, next)
      return 'Opinion saved. Prose takes effect at once and never reaches an agent.'
    })
  })
  handle('aiterm:agents:labels', (params) => {
    if (!Array.isArray(params.paths) || params.paths.length > 64 || !params.paths.every((path) => typeof path === 'string' && path.startsWith('/'))) {
      invalid('paths must be at most 64 absolute paths')
    }
    const data = params.data === undefined ? null : stagedParam(params)
    const labels = data?.data_labels ?? approvedOrProblem().generation?.data.data_labels ?? { default: 'private' as const, paths: [] }
    return (params.paths as string[]).map((path): WorkspaceLabelView => {
      const result = labelFor(path, labels)
      return { path, label: result.label, source: result.source }
    })
  })
  handle('aiterm:agents:inspect-route', (params) => {
    const harness = harnessParam(params.harness)
    const environment = options.environment?.() ?? process.env
    const result = inspectRoute({ harness } as never, null, rulesEnvironment(environment), environment.HOME ?? '/') as Record<string, unknown>
    const resolution = {
      harness, basis: String(result.basis ?? 'unknown'), provider: (result.provider as string | null) ?? null, host: (result.host as string | null) ?? null,
      sources: Array.isArray(result.sources) ? result.sources as string[] : [], version: (result.version as string | null) ?? null
    }
    const accepted = approvedOrProblem().generation?.data.harness_routes.find((route) => route.harness === harness)?.accepted_versions ?? []
    const versionTested = result.version_tested === true
    const verdict = harness === 'claude' || harness === 'codex'
      ? judgeInspection(resolution, accepted, versionTested || (resolution.version !== null && accepted.includes(resolution.version)), (options.now ?? (() => new Date()))())
      : { acceptable: false, comparison: 'Inspection only: BMN does not check this harness\'s dispatches.' }
    const view: RouteInspectionView = {
      ...resolution, versionTested, acceptable: verdict.acceptable, comparison: verdict.comparison,
      ...(typeof result.reason === 'string' ? { reason: result.reason } : {})
    }
    return view
  })

  handle('aiterm:rules:snapshot', () => rulesSnapshot(context()))
  handle('aiterm:rules:plan-master', (params) => {
    const text = textParam(params, 'text')
    const state = pathState(masterPath())
    const current = state.kind === 'file' ? state.text : state.kind === 'missing' ? '' : readFileSync(masterPath(), 'utf8')
    const errors = parseMaster(text).errors
    return {
      valid: errors.length === 0, errors, diff: unifiedDiff(current, text, masterPath()), expectedHash: state.kind === 'missing' ? null : sha256(current),
      renderings: errors.length === 0 ? renderAll(masterPath(), text, approvedOrProblem().generation) : []
    }
  })
  handle('aiterm:rules:save-master', async (params) => {
    const text = textParam(params, 'text')
    const expectedHash = params.expectedHash === null ? null : textParam(params, 'expectedHash', 64)
    const ctx = context()
    try {
      const state = pathState(masterPath())
      const current = state.kind === 'missing' ? null : state.kind === 'file' ? state.text : readFileSync(masterPath(), 'utf8')
      if ((current === null ? null : sha256(current)) !== expectedHash) throw new RosterError('REVISION_CONFLICT', 'the master changed since it was shown; reload to see it')
      writeMaster(state, text, 'saved in Preferences > Rules', { now: ctx.now() })
      return { ok: true, message: 'Master saved and kept as a new revision. Install to write the agents\' files.', snapshot: await rulesSnapshot(ctx) } satisfies RulesOutcome
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
      ? 'Every target already held its current rendering.'
      : `Wrote ${(report.written as unknown[]).length} file(s) in transaction ${String(report.transaction)}. Sessions started before this keep their old rules.`)
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
    return rulesOutcome(ctx, result, (report) => `Restored ${((report.restored as string[] | undefined) ?? []).join(', ')} to their state before ${id}.`)
  })
  handle('aiterm:rules:plan-revert-master', (params) => {
    const revision = params.revision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) invalid('revision must be a number')
    const entry = masterHistory().find((item) => item.revision === revision)
    if (entry === undefined || !entry.intact) return { ok: false, diff: '', expectedHash: null, message: `revision ${revision} is missing or corrupt` }
    const text = readFileSync(`${masterPath().replace(/global-rules\.md$/, '')}state/rules/master-history/${String(revision).padStart(6, '0')}.md`, 'utf8')
    const state = pathState(masterPath())
    const current = state.kind === 'file' ? state.text : ''
    return { ok: true, diff: unifiedDiff(current, text, masterPath()), expectedHash: state.kind === 'file' ? sha256(current) : null, text }
  })
  handle('aiterm:rules:probe', async (params) => {
    const harness = harnessParam(params.harness)
    const ctx = context()
    const result = await runCli(ctx.script, ['rules', 'probe', harness, '--json'], ctx.probeEnv, PROBE_TIMEOUT_MS)
    return rulesOutcome(ctx, result, (report) => `${harness} probe ${PROBE_OUTCOME_WORDS[String(report.outcome)] ?? String(report.outcome)}: ${String(report.detail)}`)
  })
}
