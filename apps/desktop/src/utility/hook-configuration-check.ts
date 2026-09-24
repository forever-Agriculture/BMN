// MODULE: hook-configuration-check.ts - the CLI's read-only hooks check, surfaced as a typed dated snapshot
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  HOOK_CHECK_AGENTS,
  HOOK_CHECK_ENTRY_STATES,
  HOOK_CHECK_FILE_STATES,
  type HookCheckAgentReport,
  type HookCheckEntry,
  type HookCheckReport
} from '@bmn/protocol'

const execFileAsync = promisify(execFile)

/** One bounded child per check; a stuck checker must not hold the window's request open. */
const CHECK_TIMEOUT_MS = 15_000
const CHECK_OUTPUT_LIMIT = 256 * 1024
const CHECK_ENTRY_LIMIT = 64

/**
 * The only variables the checker reads to find each harness's own hook file. Forwarding exactly
 * these keeps the child reading the same files the owner's harnesses do, and nothing else of this
 * process's environment.
 */
const CONFIG_DISCOVERY_ENV = ['HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR'] as const

export interface HookCheckRunOptions {
  /** The binary that runs the CLI script; defaults to this process's own, whatever packaged it. */
  executable?: string
  timeoutMs?: number
  now?: () => Date
  /** Config-discovery variables for the child, over the ones forwarded from this process. */
  env?: NodeJS.ProcessEnv
}

type CheckChildError = Error & {
  code?: number | string
  killed?: boolean
  signal?: string
  stdout?: string
}

function childEnv(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of CONFIG_DISCOVERY_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return {
    ...env,
    ...overrides,
    // This process may be an Electron binary; the CLI is a plain script it must run as node would.
    ELECTRON_RUN_AS_NODE: '1'
  }
}

function failed(checkedAt: string, reason: string): HookCheckReport {
  return { state: 'failed', checkedAt, reason }
}

function failureReason(error: CheckChildError): string {
  if (error.code === 'ENOENT') return 'The hook checker could not start'
  if (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') return 'The hook checker timed out'
  if (error.code === 2) return 'The hook checker refused its arguments'
  return typeof error.code === 'number'
    ? `The hook checker exited with status ${error.code}`
    : 'The hook checker failed'
}

function boundedName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return null
  }
  return value
}

function oneOf<const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** One agent row of the CLI's JSON, kept to the fields the window shows; commands and reasons are dropped. */
function readAgentReport(value: unknown): HookCheckAgentReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const agent = row.agent
  if (!oneOf(HOOK_CHECK_AGENTS, agent)) return null
  if (typeof row.file !== 'string' || row.file.length === 0 || row.file.length > 4096) return null
  const state = row.state
  if (!oneOf(HOOK_CHECK_FILE_STATES, state)) return null
  if (!Array.isArray(row.events) || row.events.length > CHECK_ENTRY_LIMIT) return null
  const entries: HookCheckEntry[] = []
  for (const entry of row.events) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const candidate = entry as Record<string, unknown>
    const event = boundedName(candidate.event)
    if (event === null || typeof candidate.optional !== 'boolean') return null
    const entryState = candidate.state
    if (!oneOf(HOOK_CHECK_ENTRY_STATES, entryState)) return null
    entries.push({ event, optional: candidate.optional, state: entryState })
  }
  if (!Array.isArray(row.missing) || row.missing.length > CHECK_ENTRY_LIMIT) return null
  const missing: string[] = []
  for (const name of row.missing) {
    const event = boundedName(name)
    // An unreadable file may have no event rows: the CLI still names its expected missing entries.
    if (event === null || (state !== 'unreadable' && !entries.some((entry) => entry.event === event))) return null
    missing.push(event)
  }
  return { agent, file: row.file, state, entries, missing }
}

/**
 * Runs `bmn hooks check --json` and reads its report. The check is bounded and read-only - the same
 * owner command the docs describe, never `hooks install` - and an exit code of 1 for missing or
 * unreadable entries is report data, not a transport failure.
 */
export async function runHookConfigurationCheck(
  cliPath: string,
  options: HookCheckRunOptions = {}
): Promise<HookCheckReport> {
  const checkedAt = (): string => (options.now ?? (() => new Date()))().toISOString()
  let stdout: string
  try {
    const result = await execFileAsync(options.executable ?? process.execPath, [cliPath, 'hooks', 'check', '--json'], {
      timeout: options.timeoutMs ?? CHECK_TIMEOUT_MS,
      maxBuffer: CHECK_OUTPUT_LIMIT,
      windowsHide: true,
      encoding: 'utf8',
      env: childEnv(options.env)
    })
    stdout = result.stdout
  } catch (error) {
    const failure = error as CheckChildError
    // Exit 1 with a report is the checker's own "something is missing or unreadable": keep reading it.
    if (typeof failure.stdout === 'string' && (failure.code === 0 || failure.code === 1)) stdout = failure.stdout
    else return failed(checkedAt(), failureReason(failure))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return failed(checkedAt(), 'The hook checker printed a report BMN cannot read')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failed(checkedAt(), 'The hook checker printed a report BMN cannot read')
  }
  const report = parsed as Record<string, unknown>
  const agents = Array.isArray(report.agents) ? report.agents : []
  const rows = agents.map(readAgentReport)
  // The check asks for every harness, so a report naming fewer or more is not the check BMN ran.
  const named = new Set(rows.filter((row): row is HookCheckAgentReport => row !== null).map((row) => row.agent))
  if (
    typeof report.ok !== 'boolean' ||
    rows.some((row) => row === null) ||
    named.size !== agents.length ||
    named.size !== HOOK_CHECK_AGENTS.length
  ) {
    return failed(checkedAt(), 'The hook checker printed a report BMN cannot read')
  }
  return { state: 'checked', checkedAt: checkedAt(), ok: report.ok, agents: rows as HookCheckAgentReport[] }
}
