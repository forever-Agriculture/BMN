// MODULE: setup-ipc.ts - Owner-window setup commands, sessions and explicit sign-in assertions
import type { IpcMainInvokeEvent } from 'electron'
import { ERROR_CODES, isSetupApp, METHOD_REGISTRY, SETUP_APP_NAMES, SETUP_INSTALL_COMMANDS, SETUP_LOGIN_ARGUMENTS,
  type FirstRunSetupRecord, type ProtocolMethod, type SessionCreateParams, type SessionRecord, type SetupAppsSnapshot, type SetupDefaultsReport } from '@bmn/protocol'
import { homedir } from 'node:os'
import { SetupReadinessReader } from './setup-readiness'
import { MainIpcError } from './workspace-ipc'

interface SetupIpcOptions {
  senderIsAllowed(event: IpcMainInvokeEvent): boolean
  reader: SetupReadinessReader
  client(): { request<Result>(method: ProtocolMethod, params: object): Promise<Result> }
  createSession(params: SessionCreateParams): Promise<unknown>
  session(sessionId: string): SessionRecord | undefined
  onRead?(snapshot: SetupAppsSnapshot): Promise<void>
  defaultsReport?(): SetupDefaultsReport
}

export function installSetupIpcHandlers(
  ipc: { handle(channel: string, listener: (event: IpcMainInvokeEvent, params?: unknown) => unknown): void }, options: SetupIpcOptions
): void {
  const starting = new Set<string>()
  const read = async (): Promise<SetupAppsSnapshot> => {
    const snapshot = await options.reader.read()
    await options.onRead?.(snapshot)
    const defaults = options.defaultsReport?.()
    const codexHooks = defaults?.rows.some(row => row.app === 'codex' && row.kind === 'hooks' && row.code === 'OK' && row.state === 'installed')
    if (!codexHooks) return snapshot
    let evidence: { codex?: unknown } | null = null
    try { evidence = await options.client().request(METHOD_REGISTRY.setupHookEvidence, {}) } catch { /* No observation is claimed on a failed read. */ }
    return { ...snapshot, apps: snapshot.apps.map(row => row.app !== 'codex' ? row : { ...row,
      hookTrust: evidence?.codex === 'observed' ? 'observed' : evidence?.codex === 'not-observed' ? 'pending' : 'unavailable' }) }

  }
  const checked = (event: IpcMainInvokeEvent, params: unknown, keys: string[]): Record<string, unknown> => {
    if (!options.senderIsAllowed(event)) throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length !== keys.length ||
      !keys.every(key => Object.hasOwn(params, key))) throw new MainIpcError(ERROR_CODES.invalidArgument, 'Setup action parameters are invalid')
    return params as Record<string, unknown>
  }
  ipc.handle('aiterm:setup:apps', (event) => {
    checked(event, {}, [])
    return read()
  })
  ipc.handle('aiterm:setup:defaults', (event) => {
    checked(event, {}, [])
    return options.defaultsReport?.() ?? null
  })
  ipc.handle('aiterm:setup:start', async (event, input) => {
    const params = checked(event, input, ['app', 'action', 'expectedProgram'])
    if (!isSetupApp(params.app) || !['install', 'login', 'check'].includes(params.action as string) ||
      !(params.expectedProgram === null || typeof params.expectedProgram === 'string')) {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'Setup session parameters are invalid')
    }
    const app = params.app, action = params.action as 'install' | 'login' | 'check'
    if (starting.has(app)) throw new MainIpcError(ERROR_CODES.invalidArgument, 'This setup action is already starting')
    starting.add(app)
    try {
      const apps = await read(), row = apps.apps.find(row => row.app === app)!
      if (apps.platform !== 'linux') throw new MainIpcError(ERROR_CODES.invalidArgument, 'Setup supports Linux')
      if (row.program !== params.expectedProgram) throw new MainIpcError(ERROR_CODES.revisionConflict, 'The app command changed; check it again before starting')
      if (action === 'install' && !apps.curlAvailable) throw new MainIpcError(ERROR_CODES.invalidArgument, 'Install curl with the displayed root command first')
      if (action !== 'install' && row.program === null) throw new MainIpcError(ERROR_CODES.notFound, 'The app program is not available yet')
      const progress = await options.client().request<FirstRunSetupRecord>(METHOD_REGISTRY.setupWorkspace, {})
      if (!progress.workspaceId) throw new MainIpcError(ERROR_CODES.ioError, 'The Setup workspace is unavailable')
      const records = await options.client().request<SessionRecord[]>(METHOD_REGISTRY.sessionList, { workspaceId: progress.workspaceId })
      if (records.some(record => record.setup?.app === app && record.lastProcess?.state === 'live')) {
        throw new MainIpcError(ERROR_CODES.invalidArgument, 'Open the running setup session for this app')
      }
      const command = action === 'install' ? SETUP_INSTALL_COMMANDS[app]
        : { executable: row.program!, argv: action === 'login' ? SETUP_LOGIN_ARGUMENTS[app] : [] }
      return await options.createSession({ workspaceId: progress.workspaceId,
        name: `${action === 'install' ? 'Install' : action === 'login' ? 'Sign in to' : 'Check'} ${SETUP_APP_NAMES[app]}`,
        cwd: homedir(), executable: command.executable, argv: [...command.argv], cols: 80, rows: 24,
        setup: { app, action } })
    } finally { starting.delete(app) }
  })
  ipc.handle('aiterm:setup:confirm', async (event, input) => {
    const params = checked(event, input, ['app', 'sessionId', 'version'])
    if (!isSetupApp(params.app) || typeof params.sessionId !== 'string' || typeof params.version !== 'string') {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'Sign-in confirmation parameters are invalid')
    }
    const app = params.app
    const known = options.session(params.sessionId)
    if (!known || known.setup?.app !== app || known.setup.action === 'install') {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'Run this app’s sign-in or check session first')
    }
    const records = await options.client().request<SessionRecord[]>(METHOD_REGISTRY.sessionList, { workspaceId: known.workspaceId })
    const record = records.find(row => row.sessionId === params.sessionId)
    if (!record?.lastProcess || record.lastProcess.state === 'live') {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'Finish the app session before confirming sign-in')
    }
    const snapshot = await read(), row = snapshot.apps.find(row => row.app === app)!
    if (row.version !== params.version || row.signIn !== 'unknown') {
      throw new MainIpcError(ERROR_CODES.revisionConflict, 'The sign-in state changed; check it again')
    }
    options.reader.confirm(app, params.version)
    return read()
  })
}
