// MODULE: setup-readiness.ts - State-only sign-in projections and once-per-version qualification
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SETUP_APPS, type SetupApp, type SetupAppReadiness, type SetupAppsSnapshot } from '@bmn/protocol'
import { writeAtomically } from '../../bin/safe-config-write.mjs'
import { resolveApplicationRoots } from '../utility/roots'
import { findAppProgram } from './app-program'
import { runSetupProcess, type SetupProcessResult } from './setup-process'
import { qualifySetupProbe } from './setup-probe-qualification'

export type SignInProjection = Pick<SetupAppReadiness, 'signIn' | 'method'>
const UNKNOWN: SignInProjection = { signIn: 'unknown', method: null }
const MEASURED: Readonly<Record<SetupApp, string>> = { claude: '2.1.303', codex: '0.163.0', opencode: '2.0.32' }
const VERSION_OUTPUT: Readonly<Record<SetupApp, RegExp>> = {
  claude: /^(?:claude(?: code)?\s+)?(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/i,
  codex: /^(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)$/i,
  opencode: /^(?:opencode\s+)?v?(\d+\.\d+\.\d+)$/i
}
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Deliberately returns no provider, identity, key fragment, raw text or parser exception. */
export function projectSetupSignIn(app: SetupApp, run: SetupProcessResult): SignInProjection {
  if (run.failure !== null) return { ...UNKNOWN }
  const text = run.output.trim()
  if (app === 'codex') {
    if (run.code === 1 && /^Not logged in\.?$/i.test(text)) return { signIn: 'signed-out', method: null }
    if (run.code !== 0) return { ...UNKNOWN }
    if (/^Logged in using ChatGPT$/i.test(text)) return { signIn: 'ready', method: 'chatgpt' }
    if (/^Logged in using an API key(?:[^\r\n]*)$/i.test(text)) return { signIn: 'ready', method: 'api-key' }
    return { ...UNKNOWN }
  }
  try {
    const value: unknown = JSON.parse(text)
    if (app === 'claude' && value && typeof value === 'object' && !Array.isArray(value)) {
      const status = value as Record<string, unknown>
      if (run.code === 1 && status.loggedIn === false && status.authMethod === 'none') return { signIn: 'signed-out', method: null }
      if (run.code === 0 && status.loggedIn === true) {
        const method = status.authMethod === 'claude.ai' ? 'oauth'
          : status.authMethod === 'api_key' || status.authMethod === 'api-key' ? 'api-key' : null
        if (method) return { signIn: 'ready', method }
      }
    }
    if (app === 'opencode' && run.code === 0 && Array.isArray(value)) {
      if (value.length === 0) return { signIn: 'signed-out', method: null }
      const credentials = value.flatMap((row: unknown) => row && typeof row === 'object' &&
        Array.isArray((row as { connections?: unknown }).connections) ? (row as { connections: unknown[] }).connections : [])
        .filter((row: unknown) => row && typeof row === 'object' && (row as { type?: unknown }).type === 'credential')
      if (credentials.length > 0) return { signIn: 'ready', method: 'other' }
    }
  } catch { /* Unknown words never become a status detail. */ }
  return { ...UNKNOWN }
}

export function setupProbeArguments(app: SetupApp): string[] {
  return app === 'claude' ? ['auth', 'status'] : app === 'codex' ? ['login', 'status'] : ['auth', 'list', '--standalone', '--format', 'json']
}

export function disposableSetupEnvironment(root: string, path: string | undefined): NodeJS.ProcessEnv {
  for (const folder of ['home', 'config', 'data', 'state', 'cache', 'work', 'markers']) mkdirSync(join(root, folder), { recursive: true, mode: 0o700 })
  return { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), PATH: `${dirname(process.execPath)}:${path ?? '/usr/bin:/bin'}`,
    TERM: 'dumb', LANG: 'C.UTF-8', NO_COLOR: '1', ELECTRON_RUN_AS_NODE: '1', DISABLE_AUTOUPDATER: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' }
}

export function findSetupProgram(app: SetupApp, env: NodeJS.ProcessEnv, skip: string | null): { path: string; onPath: boolean } | null {
  const found = findAppProgram(app, env.PATH, skip)
  if (found) return { path: found.path, onPath: true }
  const home = env.HOME ?? homedir()
  const path = join(home, app === 'opencode' ? '.opencode/bin/opencode' : `.local/bin/${app}`)
  try {
    if (!statSync(path).isFile()) return null
    accessSync(path, constants.X_OK)
    realpathSync(path)
    return { path, onPath: false }
  } catch { return null }
}

interface QualificationRecord { schemaVersion: 1; app: SetupApp; version: string; result: 'passed' | 'failed' }
interface ReadinessSeams {
  environment(): NodeJS.ProcessEnv
  skipDirectory: string | null
  stateDirectory?: string
  run?: typeof runSetupProcess
  qualify?: typeof qualifySetupProbe
}

export class SetupReadinessReader {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly run: typeof runSetupProcess
  private readonly qualify: typeof qualifySetupProbe
  constructor(private readonly seams: ReadinessSeams) {
    this.run = seams.run ?? runSetupProcess
    this.qualify = seams.qualify ?? qualifySetupProbe
  }

  private directory(): string {
    return this.seams.stateDirectory ?? join(resolveApplicationRoots(this.seams.environment()).state, 'setup')
  }

  private qualification(app: SetupApp, version: string, program: string, env: NodeJS.ProcessEnv): SetupAppReadiness['qualification'] {
    if (version === MEASURED[app]) return 'measured'
    const path = join(this.directory(), `${app}-${sha(version)}.json`)
    if (this.pending.has(path)) return 'checking'
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as Partial<QualificationRecord>
      return cached.schemaVersion === 1 && cached.app === app && cached.version === version && cached.result === 'passed' ? 'passed' : 'failed'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'failed'
    }
    try {
      mkdirSync(this.directory(), { recursive: true, mode: 0o700 })
      // Reserve before any process starts. A crash or a second reader never earns another attempt.
      const record: QualificationRecord = { schemaVersion: 1, app, version, result: 'failed' }
      writeFileSync(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
      const job = this.qualify(app, program, env, this.run).then(passed => {
        if (!passed) return
        writeAtomically(path, JSON.stringify({ ...record, result: 'passed' }), target => {
          if (readFileSync(target, 'utf8') !== JSON.stringify(record)) throw new Error('Qualification state changed')
        })
        const readBack = JSON.parse(readFileSync(path, 'utf8')) as QualificationRecord
        if (readBack.result !== 'passed' || readBack.version !== version) throw new Error('Qualification state could not be verified')
      }).catch(() => undefined).finally(() => this.pending.delete(path))
      this.pending.set(path, job)
      return 'checking'
    } catch { return 'failed' }
  }

  async idle(): Promise<void> { await Promise.all(this.pending.values()) }

  async read(): Promise<SetupAppsSnapshot> {
    const env = this.seams.environment()
    const apps = await Promise.all(SETUP_APPS.map(async (app): Promise<SetupAppReadiness> => {
      const found = findSetupProgram(app, env, this.seams.skipDirectory)
      const row: SetupAppReadiness = { app, program: found?.path ?? null, onPath: found?.onPath ?? false,
        version: null, signIn: found ? 'unknown' : 'missing', method: null, qualification: 'unavailable' }
      if (!found) return row
      try {
      const versionRun = await this.run(found.path, ['--version'], { env: this.probeEnvironment(env), cwd: env.HOME ?? homedir() })
      const match = versionRun.failure === null && versionRun.code === 0 ? VERSION_OUTPUT[app].exec(versionRun.output.trim()) : null
      row.version = match?.[1] ?? null
      if (!row.version) return row
      row.qualification = this.qualification(app, row.version, found.path, env)
      if (row.qualification !== 'passed' && row.qualification !== 'measured') {
        if (this.confirmed(app, row.version, env)) row.signIn = 'confirmed'
        return row
      }
      let result: SetupProcessResult
      if (app === 'opencode') {
        const root = mkdtempSync(join(tmpdir(), 'bmn-setup-status-'))
        try {
          const isolated = disposableSetupEnvironment(root, env.PATH)
          isolated.XDG_DATA_HOME = env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), '.local/share')
          result = await this.run(found.path, setupProbeArguments(app), { env: isolated, cwd: join(root, 'work') })
        } finally { rmSync(root, { recursive: true, force: true }) }
      } else result = await this.run(found.path, setupProbeArguments(app), { env: this.probeEnvironment(env), cwd: env.HOME ?? homedir() })
      Object.assign(row, projectSetupSignIn(app, result))
      if (app === 'opencode' && row.signIn === 'signed-out' && (env.OPENCODE_CONFIG_CONTENT || env.OPENCODE_CONFIG || env.OPENCODE_CONFIG_DIR ||
        env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || ['opencode.json', 'opencode.jsonc'].some(name =>
          existsSync(join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config'), 'opencode', name)) ||
          existsSync(join('/etc/opencode', name))))) row.signIn = 'unknown'
      if (row.signIn === 'unknown' && this.confirmed(app, row.version, env)) row.signIn = 'confirmed'
      return row
      } catch { return { ...row, signIn: 'unknown', method: null } }
    }))
    return { apps, curlAvailable: findAppProgram('curl', env.PATH, null) !== null, checkedAt: new Date().toISOString(), platform: process.platform }
  }

  private probeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries({ ...env, ELECTRON_RUN_AS_NODE: '1', DISABLE_AUTOUPDATER: '1' })
      .filter(([name]) => !name.startsWith('BMN_') && !name.startsWith('AITERM_')))
  }

  private confirmationPath(app: SetupApp, version: string, env: NodeJS.ProcessEnv): string {
    const profile = [env.HOME, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME,
      env.OPENCODE_CONFIG_DIR, env.OPENCODE_CONFIG].map(value => value ?? null)
    return join(this.directory(), `confirmed-${app}-${sha(JSON.stringify([version, profile]))}.json`)
  }

  private confirmed(app: SetupApp, version: string, env: NodeJS.ProcessEnv): boolean {
    try { return readFileSync(this.confirmationPath(app, version, env), 'utf8') === '{"confirmed":true}' } catch { return false }
  }

  /** The IPC caller verifies a real app session and the user's explicit confirmation first. */
  confirm(app: SetupApp, version: string): void {
    const path = this.confirmationPath(app, version, this.seams.environment())
    mkdirSync(this.directory(), { recursive: true, mode: 0o700 })
    writeAtomically(path, '{"confirmed":true}')
    if (!this.confirmed(app, version, this.seams.environment())) throw new Error('Confirmation could not be verified')
  }
}
