// MODULE: setup-defaults.ts - Serialize automatic defaults reads with durable profile and creation authority
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { SETUP_APPS, type FirstRunSetupRecord, type SetupAppsSnapshot, type SetupDefaultsClaim, type SetupDefaultsReport } from '@bmn/protocol'

interface DefaultsRequest {
  mode: 'prepare' | 'apply'
  claim: SetupDefaultsClaim
  ready: Array<{ app: typeof SETUP_APPS[number]; version: string }>
}
interface Seams {
  profile(): Promise<FirstRunSetupRecord | null>
  claim(): Promise<SetupDefaultsClaim>
  apps(): Promise<SetupAppsSnapshot>
  run(request: DefaultsRequest): Promise<SetupDefaultsReport>
}
const empty = (code: string): SetupDefaultsReport => ({ code, source: null, names: [], rows: [] })

/** A refresh requested from startup, approval or Health joins the same main-process job. */
export class SetupDefaultsCoordinator {
  private serial: Promise<unknown> = Promise.resolve()
  private refreshing: Promise<SetupDefaultsReport> | null = null
  private latest: SetupDefaultsReport = empty('WAITING_FOR_TEAM')
  constructor(private readonly seams: Seams) {}

  report(): SetupDefaultsReport { return structuredClone(this.latest) }

  private enqueue(work: () => Promise<SetupDefaultsReport>): Promise<SetupDefaultsReport> {
    const job = this.serial.then(work).catch(() => empty('DEFAULTS_STATE_UNAVAILABLE'))
    this.serial = job
    return job.then(result => { this.latest = result; return result })
  }

  /** Prepares only the source and ownership journal; no team, rules, hook, skill or tool is written. */
  prepare(): Promise<SetupDefaultsReport> {
    return this.enqueue(async () => {
      const profile = await this.seams.profile()
      if (!profile || profile.state === 'existing') return empty('EXISTING_PROFILE')
      return this.seams.run({ mode: 'prepare', claim: await this.seams.claim(), ready: [] })
    })
  }

  refresh(snapshot?: SetupAppsSnapshot): Promise<SetupDefaultsReport> {
    if (this.refreshing) return this.refreshing
    const job = this.enqueue(async () => {
      const profile = await this.seams.profile()
      if (!profile || profile.state === 'existing') return empty('EXISTING_PROFILE')
      const apps = snapshot ?? await this.seams.apps()
      if (apps.platform !== 'linux') return empty('UNSUPPORTED_PLATFORM')
      const claim = await this.seams.claim()
      const prepared = await this.seams.run({ mode: 'prepare', claim, ready: [] })
      if (prepared.code !== 'OK') return prepared
      const ready = apps.apps.filter(row => row.program !== null && row.version !== null && ['ready', 'confirmed'].includes(row.signIn))
        .map(row => ({ app: row.app, version: row.version! }))
      const applied = await this.seams.run({ mode: 'apply', claim: { ...claim, initialize: false }, ready })
      return applied.code === 'NOT_APPROVED' ? { ...applied, source: prepared.source, names: prepared.names } : applied
    })
    this.refreshing = job
    void job.finally(() => { if (this.refreshing === job) this.refreshing = null })
    return job
  }
}

/** Config roots and routing selectors only; the defaults child receives no credential environment values. */
export function setupDefaultsEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'BMN_SHIPPED_SKILLS',
    'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
  return { ...Object.fromEntries(names.filter(name => environment[name] !== undefined).map(name => [name, environment[name]])),
    ...(environment.OPENCODE_CONFIG_CONTENT ? { OPENCODE_CONFIG_CONTENT: 'set' } : {}), ELECTRON_RUN_AS_NODE: '1' }
}

export function parseSetupDefaultsReport(value: unknown): SetupDefaultsReport | null {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  const keys = (value: Record<string, unknown>, names: string[]): boolean => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
  const word = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
  const paths = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 4096 && value.every(path => typeof path === 'string' && isAbsolute(path) && !path.includes('\0'))
  if (!object(value) || !keys(value, ['code', 'source', 'names', 'rows']) || !word(value.code) || !(value.source === null || typeof value.source === 'string' && isAbsolute(value.source) && !value.source.includes('\0')) ||
    !Array.isArray(value.names) || !value.names.every(name => typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) ||
    !Array.isArray(value.rows) || value.rows.length > 4096 || !value.rows.every(row => object(row) && keys(row, ['kind', 'app', 'code', 'state', 'transaction', 'paths', 'recoveryPaths']) &&
      ['master', 'own-skills', 'rules', 'skills', 'hooks', 'tools'].includes(row.kind as string) &&
      (row.app === null || SETUP_APPS.includes(row.app as typeof SETUP_APPS[number])) && word(row.code) &&
      typeof row.state === 'string' && /^[a-z][a-z-]{0,39}$/.test(row.state) &&
      (row.transaction === null || typeof row.transaction === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(row.transaction)) &&
      paths(row.paths) && paths(row.recoveryPaths))) return null
  return structuredClone(value) as unknown as SetupDefaultsReport
}

/** Process isolation preserves each module's intended HOME/XDG roots without changing main's environment. */
export function runSetupDefaults(script: string, request: DefaultsRequest, environment: NodeJS.ProcessEnv): Promise<SetupDefaultsReport> {
  return new Promise(resolve => {
    execFile(process.execPath, [script, 'setup-defaults', '--request', JSON.stringify(request), '--json'],
      { env: setupDefaultsEnvironment(environment), timeout: 120_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (_error, stdout) => {
        try { resolve(parseSetupDefaultsReport(JSON.parse(stdout)) ?? empty('DEFAULTS_STATE_UNAVAILABLE')) }
        catch { resolve(empty('DEFAULTS_STATE_UNAVAILABLE')) }
      })
  })
}
