// MODULE: index.ts - Electron main process: windows, bridge IPC and host lifecycle; `--self-test` loads ./self-test
import { homedir } from 'node:os'
import { ensurePrivateDirectories } from '../utility/private-directory'
import { join, resolve } from 'node:path'
import {
  ERROR_CODES,
  METHOD_REGISTRY,
  isLaunchSetStartParams,
  type AppSettings,
  type ClosePromptDecision,
  type ClosePromptMode,
  type ClosePromptSession,
  type ExplicitConversationBinding,
  type InterruptedSessionCohort,
  type LaunchTemplateRecord,
  type LaunchSetStartResult,
  type SavedOutputCapture,
  type SavedOutputCaptureOutcome,
  type SavedOutputSnapshot,
  type SessionCohortOfferedResult,
  type SessionCohortResumeResult,
  type SessionCreateParams,
  type SessionProcessState,
  type SessionRecord,
  type SessionStopCause,
  type WorkspaceLayoutState,
  type WorkspaceRecord
} from '@bmn/protocol'
import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  Notification,
  powerMonitor,
  session as electronSession,
  shell,
  webContents,
  type IpcMainInvokeEvent,
  type MessagePortMain,
  type WebContents
} from 'electron'
import { PtyHostClient, PtyHostRemoteError, type HostReady } from './pty-host-client'
import { createProgramCopy, programCopyAllowed } from './program-copy'
import {
  connectRendererChannel,
  createRendererRecoveryCoalescer,
  recoverExistingSessionRenderers,
  adoptsStartedAttachment,
  scheduleTerminalViewRecovery,
  wireLiveWindowLifecycle,
  watchHostLoss
} from './host-loss'
import { resolveApplicationRoots } from '../utility/roots'
import { acquireRootScopedSingleInstance, focusExistingWindow } from './single-instance'
import { protectWindowsApplicationLifetime } from './windows-application-lifetime'
import { trackAllowedSender } from './allowed-senders'
import { createDevelopmentRoot } from './development-root'
import { installSavedOutputIpcHandler } from './saved-output-ipc'
import { shouldAdoptLaunchSetRuntime } from './launch-set-runtime'
import {
  bridgeInvokeRegistrar,
  type BridgeInvokeRegistration
} from './bridge-ipc'
import {
  SavedOutputCaptureCoordinator,
  captureWebContents,
  captureSavedOutputForLifecycle
} from './saved-output-capture-ipc'
import { hasExplicitApplicationLaunch, parseApplicationLaunchSpec } from './launch-spec'
import {
  activateAttentionNotification,
  createAppEventForwarder,
  installCompanionIpcHandlers,
  noticeResolution
} from './companion-ipc'
import { installFileReferenceIpcHandlers } from './file-reference-ipc'
import { createPresenceMonitor, readMutterIdleMs } from './presence-monitor'
import { installVoiceIpcHandlers } from './voice-ipc'
import { transcribeRecording } from './voice-engine'
import {
  attachCreatedSession,
  createExplicitLaunchSession,
  loadWorkspaceStartup
} from './application-startup'
import {
  activateBoundSession,
  loadConversationBinding,
  previewConversationResume,
  locateConversationBinding,
  resumeBoundSession,
  startNewConversation
} from './conversation-resume-ipc'
import {
  createApplicationLifecycle,
  runningTargetForRuntime,
  type BackgroundChoice,
  type CloseChoicePrompt,
  type QuitChoicePrompt,
  type RunningSessionTarget
} from './app-lifecycle'
import { ClosePromptCoordinator, agentName } from './close-prompt-ipc'
import {
  applyProcessState,
  createProcessTracking,
  dropRuntimeView,
  runningTargets as trackedRunningTargets,
  stopTrackedTargets
} from './process-tracking'
import {
  MainIpcError,
  installWorkspaceIpcHandlers,
  requireSessionRuntime
} from './workspace-ipc'
import type { SelfTestTaps } from './self-test/contract'

const EXPECTED_ELECTRON_VERSION = '44.3.0'

export interface SessionIdentity {
  sessionId: string
  incarnationId: string
}

export interface AttachmentIdentity extends SessionIdentity {
  attachmentId: string
  streamSeq: 0
  captureStartedAt: string
}

export interface HostHealth {
  liveSessions: number
  runningIncarnations: number
  interruptedIncarnations: number
  sessionRecords: number
  incarnationRecords: number
  workspaceRecords: number
  sessions: Array<SessionIdentity & {
    cols: number
    rows: number
    attached: boolean
    state: SessionProcessState
    outputDraining: boolean
  }>
  schemaTables: readonly string[]
  database: { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number }
}

/** What the renderer may ask for: the rows it drew, with the command each row showed. */
interface RendererCohortResumeRequest {
  cohortId: string
  idempotencyKey: string
  entries: Array<{ sessionId: string; action: 'resume' | 'relaunch'; command: string }>
}

function isRendererCohortResumeRequest(value: unknown): value is RendererCohortResumeRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<RendererCohortResumeRequest>
  if (typeof request.cohortId !== 'string' || request.cohortId.length === 0) return false
  if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length === 0) return false
  if (!Array.isArray(request.entries) || request.entries.length === 0) return false
  return request.entries.every((entry) =>
    !!entry &&
    typeof entry.sessionId === 'string' && entry.sessionId.length > 0 &&
    (entry.action === 'resume' || entry.action === 'relaunch') &&
    typeof entry.command === 'string' && entry.command.length > 0)
}

interface StartupSuccess extends AttachmentIdentity {
  ok: true
  cwd: string
  executable: string
  workspaceId: string
  name: string
  testMode: boolean
  viewRestored?: true
}

interface StartupFailure {
  ok: false
  message: string
  code: string
}

interface ApplicationStartupSuccess {
  ok: true
  testMode: boolean
  activeWorkspaceId: string | null
  workspaces: WorkspaceRecord[]
  sessions: SessionRecord[]
  templates: LaunchTemplateRecord[]
  layouts: WorkspaceLayoutState[]
  layoutNotices: string[]
  liveSessions: StartupSuccess[]
}

type StartupResult = ApplicationStartupSuccess | StartupFailure

interface ApplicationRuntime {
  client: PtyHostClient
  session: SessionIdentity
  attachment: AttachmentIdentity
  rendererPort: MessagePortMain
  dimensions: { cols: number; rows: number }
  cwd: string
  executable: string
  workspaceId: string
  name: string
  testMode: boolean
  processState: SessionProcessState
  backgroundChoice?: BackgroundChoice
}

const processTracking = createProcessTracking<ApplicationRuntime>()
const runtimes = processTracking.runtimes
const sessionRecords = new Map<string, SessionRecord>()
let hostClient: PtyHostClient | undefined
let hostRendererPort: MessagePortMain | undefined
let applicationWindow: BrowserWindow | undefined
let quitRequested = false
let developmentRoot: ReturnType<typeof createDevelopmentRoot>
let savedOutputCaptureCoordinator: SavedOutputCaptureCoordinator | undefined
let closePromptCoordinator: ClosePromptCoordinator | undefined
/** Present only while `--self-test` runs; production code calls it with optional chaining. */
let selfTestTaps: SelfTestTaps | undefined

const allowedSenders = new Set<number>()
/** The session each renderer shows as selected, so a notification skips the session the owner is looking at. */
const selectedSessions = new Map<number, string | null>()
const allowedTargets = (): WebContents[] => [...allowedSenders]
  .map((id) => webContents.fromId(id))
  .filter((contents): contents is WebContents => contents !== undefined && !contents.isDestroyed())
const presence = createPresenceMonitor({
  // X11 sessions report idle time through powerMonitor; on Wayland only the compositor knows.
  readIdleMs: async () => (await readMutterIdleMs()) ??
    (process.env.WAYLAND_DISPLAY ? null : powerMonitor.getSystemIdleTime() * 1_000),
  onChange: (current) => {
    for (const target of allowedTargets()) target.send('aiterm:presence', current)
    appEvents.watchChanged()
    reportPresence()
  },
  schedule: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  }
})
const appEvents = createAppEventForwarder({
  client: () => hostClient,
  targets: allowedTargets,
  watching: (sessionId) => !presence.current().away && BrowserWindow.getAllWindows().some((window) =>
    !window.isDestroyed() && window.isFocused() && selectedSessions.get(window.webContents.id) === sessionId
  ),
  notify: ({ title, body, sessionId, requestId, kind, revision }) => {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body, silent: false })
    notification.on('click', () => {
      void activateAttentionNotification({ sessionId, requestId, kind, revision }, {
        close: () => notification.close(),
        openSession: (targetSessionId) => {
          focusExistingWindow(applicationWindow)
          applicationWindow?.webContents.send('aiterm:open-session', targetSessionId)
        },
        resolveNotice: (targetRequestId, expectedRevision) => hostClient
          ? hostClient.request(METHOD_REGISTRY.attentionResolve, noticeResolution(targetRequestId, expectedRevision))
          : Promise.resolve()
      })
    })
    notification.show()
  },
  notificationsEnabled: () => !selfTestTaps?.headless,
  notifyApp: (notice) => {
    if (selfTestTaps) {
      selfTestTaps.appNotice(notice)
      return
    }
    if (!Notification.isSupported()) return
    const notification = new Notification({ ...notice, silent: false })
    notification.on('click', () => {
      notification.close()
      focusExistingWindow(applicationWindow)
    })
    notification.show()
  },
  appNotificationsEnabled: () => true,
  place: async (sessionId) => {
    const client = hostClient
    if (!client) return null
    for (const workspace of await client.request<WorkspaceRecord[]>(METHOD_REGISTRY.workspaceList, {})) {
      const sessions = await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, { workspaceId: workspace.workspaceId })
      const session = sessions.find((candidate) => candidate.sessionId === sessionId)
      if (session) return `${workspace.name} / ${session.name}`
    }
    return null
  }
})

/** The host pages the owner's phone only while they are away; null tells it presence cannot be read. */
function reportPresence(): void {
  const current = presence.current()
  void hostClient?.request(METHOD_REGISTRY.presenceSet, { away: current.known ? current.away : null })
    .catch(() => undefined)
}

function appPaths(): { appRoot: string; hostEntry: string; repoRoot: string } {
  const appRoot = app.getAppPath()
  return {
    appRoot,
    hostEntry: join(__dirname, 'pty-host.js'),
    repoRoot: app.isPackaged ? appRoot : resolve(appRoot, '../..')
  }
}

function ensureDevelopmentRoots(): void {
  if (app.isPackaged) return
  developmentRoot = createDevelopmentRoot(process.env)
}

function cleanupDevelopmentRoot(): void {
  if (!developmentRoot) return
  developmentRoot.cleanup()
  developmentRoot = undefined
}

function hostEnvironment(repoRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BMN_REPO_ROOT: repoRoot,
    BMN_CLI_PATH: bmnCliPath(),
    BMN_CLI_SCRIPT: bmnCliScript()
  }
}

/** The JavaScript the CLI runs; the packaged `bmn` is a shell launcher for it that node cannot load. */
function bmnCliScript(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bin', 'bmn.mjs') : join(app.getAppPath(), 'bin', 'bmn')
}

/**
 * Sessions get this file's directory on PATH; packaged builds carry a launcher for it under resources/bin.
 * Windows uses the native bmn.exe launcher (scripts/build/windows-cli.mjs), never the Unix shell launcher.
 */
function bmnCliPath(): string {
  if (process.platform === 'win32') {
    return app.isPackaged
      ? join(process.resourcesPath, 'bin', 'bmn.exe')
      : join(app.getAppPath(), 'native-out', 'windows-cli', 'bmn.exe')
  }
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'bmn')
    : join(app.getAppPath(), 'bin', 'bmn')
}

async function launchHostWithChannel(): Promise<{
  client: PtyHostClient
  ready: HostReady
  applicationPort: MessagePortMain
}> {
  const { hostEntry, repoRoot } = appPaths()
  const { environment, args } = selfTestTaps
    ? await selfTestTaps.hostLaunch(hostEnvironment(repoRoot))
    : { environment: hostEnvironment(repoRoot), args: [] }
  const client = await PtyHostClient.launch(hostEntry, environment, { args })
  const ready = await client.ready
  if (ready.electronVersion !== EXPECTED_ELECTRON_VERSION) {
    await client.close()
    throw new Error(
      `utility host reported Electron ${ready.electronVersion}; expected ${EXPECTED_ELECTRON_VERSION}`
    )
  }
  const { port1, port2 } = new MessageChannelMain()
  client.attachTerminalPort(port1)
  return { client, ready, applicationPort: port2 }
}

function requireHostClient(): PtyHostClient {
  if (!hostClient) throw new MainIpcError(ERROR_CODES.ioError, 'The terminal host is unavailable')
  return hostClient
}

async function createSessionRuntime(
  params: SessionCreateParams,
  testMode: boolean
): Promise<{ session: SessionRecord; startup: StartupSuccess }> {
  const client = requireHostClient()
  const { identity, attachment, record } = await attachCreatedSession<AttachmentIdentity>(client, params)
  const current: ApplicationRuntime = {
    client,
    session: identity,
    attachment,
    rendererPort: hostRendererPort!,
    dimensions: { cols: params.cols, rows: params.rows },
    cwd: record.cwd,
    executable: record.executable,
    workspaceId: record.workspaceId,
    name: record.name,
    testMode,
    processState: 'live',
    ...(record.backgroundChoice ? { backgroundChoice: record.backgroundChoice } : {})
  }
  runtimes.set(record.sessionId, current)
  sessionRecords.set(record.sessionId, record)
  return { session: record, startup: startupForRuntime(current) }
}

async function loadApplicationStartup(testMode: boolean): Promise<ApplicationStartupSuccess> {
  const state = await loadWorkspaceStartup(requireHostClient())
  sessionRecords.clear()
  for (const session of state.sessions) sessionRecords.set(session.sessionId, session)
  const rendererState = selfTestTaps && testMode ? selfTestTaps.rendererState(state) : state
  return {
    ok: true,
    testMode,
    ...rendererState,
    liveSessions: [...runtimes.values()].map((runtime) => startupForRuntime(runtime))
  }
}

/** A runtime's process state follows the host's ordered state reports for its current incarnation. */
function trackSessionProcessStates(client: PtyHostClient): void {
  client.onSessionStateChanged((message) => applyProcessState(processTracking, message))
}

async function initializeApplication(testMode: boolean): Promise<ApplicationStartupSuccess> {
  const launched = await launchHostWithChannel()
  hostClient = launched.client
  hostRendererPort = launched.applicationPort
  trackSessionProcessStates(launched.client)
  launched.client.onAppEvent((message) => appEvents.forward(message))
  const programCopy = createProgramCopy({
    allowed: async () => programCopyAllowed(await launched.client.request<Partial<AppSettings>>(METHOD_REGISTRY.settingsGet, {})),
    write: async (target, text) => {
      // The primary selection exists on Linux only; elsewhere a write to it is ignored.
      const board = target === 'clipboard' ? clipboard : clipboard.selection
      if (!board) return false
      await board.writeText(text)
      return true
    },
    announce: (notice) => applicationWindow?.webContents.send('aiterm:program-copy', notice)
  })
  launched.client.onProgramCopy((message) => void programCopy(message))
  void appEvents.prime()
  reportPresence()
  let startup = await loadApplicationStartup(testMode)
  if (hasExplicitApplicationLaunch(process.argv)) {
    const launch = parseApplicationLaunchSpec(process.argv, process.env, process.cwd())
    await createExplicitLaunchSession(
      requireHostClient(),
      startup,
      launch,
      (params) => createSessionRuntime(params, testMode)
    )
    startup = await loadApplicationStartup(testMode)
  }
  return startup
}

function senderIsAllowed(event: IpcMainInvokeEvent): boolean {
  const sender: WebContents = event.sender
  return allowedSenders.has(sender.id) && event.senderFrame === sender.mainFrame
}

function requireRuntime(event: IpcMainInvokeEvent, sessionId: unknown): ApplicationRuntime {
  return requireSessionRuntime(event, sessionId, senderIsAllowed, runtimes)
}

function requireKnownSession(event: IpcMainInvokeEvent, sessionId: unknown): string {
  if (!senderIsAllowed(event)) {
    throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new MainIpcError(ERROR_CODES.invalidArgument, 'An explicit sessionId is required')
  }
  if (!sessionRecords.has(sessionId)) {
    throw new MainIpcError(ERROR_CODES.notFound, 'The session was not found')
  }
  return sessionId
}

/** Built by `pnpm run voice:build`; packaged builds carry it under resources/whisper. */
function whisperBinaryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'whisper', 'whisper-cli')
    : join(app.getAppPath(), 'resources', 'whisper', 'whisper-cli')
}

/** Only the app window may use the microphone, and only for dictation; every other web permission is refused. */
function restrictWebPermissions(): void {
  const microphoneOnly = (contents: WebContents | null, permission: string, mediaTypes?: readonly string[]): boolean =>
    permission === 'media' && !!contents && allowedSenders.has(contents.id) &&
    (mediaTypes ?? ['audio']).every((type) => type === 'audio')
  electronSession.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(microphoneOnly(contents, permission, 'mediaTypes' in details ? details.mediaTypes : undefined))
  })
  electronSession.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    microphoneOnly(contents, permission, details.mediaType ? [details.mediaType] : undefined)
  )
}

function installIpcHandlers(): ReturnType<typeof bridgeInvokeRegistrar> {
  savedOutputCaptureCoordinator = new SavedOutputCaptureCoordinator(
    ipcMain,
    (sender) => allowedSenders.has(sender.id) && !sender.isDestroyed()
  )
  closePromptCoordinator = new ClosePromptCoordinator(
    ipcMain,
    (sender) => allowedSenders.has(sender.id) && !sender.isDestroyed()
  )
  const bridgeIpc = bridgeInvokeRegistrar(ipcMain)
  installWorkspaceIpcHandlers(bridgeIpc, senderIsAllowed, {
    client: () => ({
      request: async <Result,>(method: Parameters<PtyHostClient['request']>[0], params: object) => {
        if (selfTestTaps) await selfTestTaps.workspaceRequest(method, params)
        const result = await requireHostClient().request<Result>(method, params)
        if (selfTestTaps && method === METHOD_REGISTRY.sessionList) {
          return selfTestTaps.rendererState({ sessions: result as SessionRecord[], templates: [] }).sessions as Result
        }
        if (method === METHOD_REGISTRY.sessionUpdate) {
          const record = result as SessionRecord
          sessionRecords.set(record.sessionId, record)
          const runtime = runtimes.get(record.sessionId)
          if (runtime) {
            runtime.workspaceId = record.workspaceId
            runtime.name = record.name
            if (record.backgroundChoice) runtime.backgroundChoice = record.backgroundChoice
            else delete runtime.backgroundChoice
          }
        }
        return result
      }
    }),
    createSession: (params) => {
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new MainIpcError(ERROR_CODES.invalidArgument, 'Session create parameters must be an object')
      }
      return createSessionRuntime(params as SessionCreateParams, rendererTestMode)
    }
  })
  bridgeIpc.handle('aiterm:launch-directory:normalize', (event, value: unknown) => {
    if (!senderIsAllowed(event)) {
      throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
    }
    const directories = (value as { directories?: unknown } | null)?.directories
    if (!Array.isArray(directories) || directories.length > 256 ||
        !directories.every((item) => typeof item === 'string' && item.length <= 4096)) {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'Launch directories are invalid')
    }
    return directories.map((directory: string) => resolve(
      directory === '~' || directory.startsWith('~/') || (process.platform === 'win32' && directory.startsWith('~\\'))
        ? join(homedir(), directory.slice(1)) : directory
    ))
  })
  bridgeIpc.handle('aiterm:launch-set:start', async (event, value: unknown) => {
    if (!senderIsAllowed(event)) {
      throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
    }
    if (!isLaunchSetStartParams(value)) {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'Launch set start parameters are invalid')
    }
    selfTestTaps?.launchSetStarted()
    const client = requireHostClient()
    const result = await client.request<LaunchSetStartResult>(METHOD_REGISTRY.launchSetStart, value)
    const records = await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
      workspaceId: result.workspaceId
    })
    const byId = new Map(records.map((record) => [record.sessionId, record]))
    const sessions: SessionRecord[] = []
    const startups: StartupSuccess[] = []
    for (const entry of result.entries) {
      if (!entry.sessionId) continue
      const record = byId.get(entry.sessionId)
      if (!record) throw new Error('A started session was not saved')
      sessionRecords.set(record.sessionId, record)
      sessions.push(record)
      if (!shouldAdoptLaunchSetRuntime(
        entry, record,
        entry.incarnationId ? client.sessionProcessState(record.sessionId, entry.incarnationId) : undefined
      )) continue
      const existing = runtimes.get(record.sessionId)
      if (existing) {
        startups.push(startupForRuntime(existing))
        continue
      }
      const attachment = { sessionId: entry.sessionId, incarnationId: entry.incarnationId,
        ...entry.attachment }
      const runtime: ApplicationRuntime = {
        client, session: attachment, attachment, rendererPort: hostRendererPort!,
        dimensions: { cols: value.cols, rows: value.rows },
        cwd: record.cwd, executable: record.executable, workspaceId: record.workspaceId,
        name: record.name, testMode: rendererTestMode, processState: 'live',
        ...(record.backgroundChoice ? { backgroundChoice: record.backgroundChoice } : {})
      }
      runtimes.set(record.sessionId, runtime)
      startups.push(startupForRuntime(runtime))
    }
    return {
      ...result,
      entries: result.entries.map((entry) => ({
        entryId: entry.entryId, name: entry.name, outcome: entry.outcome,
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        ...(entry.incarnationId ? { incarnationId: entry.incarnationId } : {}),
        ...(entry.error ? { error: entry.error } : {})
      })),
      sessions,
      startups
    }
  })
  installCompanionIpcHandlers(bridgeIpc, {
    client: () => requireHostClient(),
    senderIsAllowed,
    dialogsEnabled: () => !selfTestTaps?.headless
  })
  installFileReferenceIpcHandlers(bridgeIpc, {
    client: () => {
      const client = requireHostClient()
      return selfTestTaps?.fileReferenceClient(client) ?? client
    },
    senderIsAllowed,
    // The isolated self-test window is deliberately hidden, so it has no OS focus to report.
    ownerFocused: (event) => selfTestTaps?.headless || BrowserWindow.fromWebContents(event.sender)?.isFocused() === true,
    chooseFolder: async (event) => {
      if (selfTestTaps?.headless) throw new MainIpcError(ERROR_CODES.invalidArgument, 'File dialogs are unavailable in this run')
      const options = { title: 'Resolve the reference from this folder', properties: ['openDirectory'] as Array<'openDirectory'> }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? null : picked.filePaths[0] ?? null
    },
    showInFolder: (path) => {
      if (selfTestTaps) selfTestTaps.shownInFolder(path)
      else shell.showItemInFolder(path)
    }
  })
  const defaultVoiceModelFolder = join(resolveApplicationRoots().data, 'voice', 'models')
  const productionVoiceBinary = whisperBinaryPath()
  installVoiceIpcHandlers(bridgeIpc, {
    senderIsAllowed,
    // Handlers install before the self-test's taps exist, so its stand-ins are read per call.
    get binary() { return selfTestTaps?.voice.binary ?? productionVoiceBinary },
    transcribe: (options) => (selfTestTaps?.voice.transcribe ?? transcribeRecording)(options),
    fetch: (url, init) => (selfTestTaps?.voice.fetch ?? fetch)(url, init),
    modelFolder: async () => {
      const settings = await requireHostClient().request<AppSettings>(METHOD_REGISTRY.settingsGet, {})
      const chosen = settings.voice.modelFolder
      return chosen ? { path: chosen, custom: true } : { path: defaultVoiceModelFolder, custom: false }
    },
    chooseFolder: async (event) => {
      if (selfTestTaps?.headless) throw new MainIpcError(ERROR_CODES.invalidArgument, 'File dialogs are unavailable in this run')
      const options = { title: 'Choose the voice model folder', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? null : picked.filePaths[0] ?? null
    }
  })
  bridgeIpc.handle('aiterm:terminal:activate', async (event, sessionId: unknown) => {
    const current = requireRuntime(event, sessionId)
    return activateBoundSession(current.client, current.attachment.attachmentId)
  })
  bridgeIpc.handle('aiterm:terminal:resize', async (event, sessionId: unknown, cols: unknown, rows: unknown) => {
    const current = requireRuntime(event, sessionId)
    const dimensions = await current.client.request<{ cols: number; rows: number }>(METHOD_REGISTRY.terminalResize, {
      attachmentId: current.attachment.attachmentId,
      cols,
      rows
    })
    current.dimensions = dimensions
    return dimensions
  })
  bridgeIpc.handle('aiterm:terminal:detach', async (event, sessionId: unknown) => {
    const current = requireRuntime(event, sessionId)
    return current.client.request(METHOD_REGISTRY.terminalDetach, {
      attachmentId: current.attachment.attachmentId
    })
  })
  bridgeIpc.handle('aiterm:terminal:recover-view', (event, sessionId: unknown, reason: unknown) => {
    requireRuntime(event, sessionId)
    return scheduleTerminalViewRecovery(reason, event.sender)
  })
  bridgeIpc.handle('aiterm:terminal:modes-reset', (event, sessionId: unknown) => {
    const current = requireRuntime(event, sessionId)
    return current.client.request<{ outcome: 'reset' | 'busy' | 'unconfirmed'; modes: number[] }>(
      METHOD_REGISTRY.terminalModesReset, current.session)
  })
  bridgeIpc.handle('aiterm:terminal:snapshot-save', async (event, sessionId: unknown, capture: SavedOutputCapture) => {
    const current = requireRuntime(event, sessionId)
    return current.client.request<SavedOutputSnapshot>(
      METHOD_REGISTRY.terminalSnapshotSave,
      {
        ...current.session,
        ...capture,
        viewEpoch: current.attachment.attachmentId,
        captureStartedAt: current.attachment.captureStartedAt,
        processState: current.processState === 'exit-unconfirmed'
          ? 'interrupted'
          : current.processState
      }
    )
  })
  installSavedOutputIpcHandler(bridgeIpc, (event, sessionId) => {
    requireKnownSession(event, sessionId)
    return { client: requireHostClient() }
  })
  bridgeIpc.handle('aiterm:session:stop', async (event, sessionId: unknown) => {
    const current = requireRuntime(event, sessionId)
    const target = runningTargetForRuntime({
      ...current.session,
      executable: current.executable,
      processState: current.processState,
      ...(current.backgroundChoice ? { backgroundChoice: current.backgroundChoice } : {})
    })
    if (target) await applicationLifecycle.stopCurrentTarget(target)
    return { stopped: true }
  })
  bridgeIpc.handle('aiterm:session:binding-get', (event, sessionId: unknown) => {
    const id = requireKnownSession(event, sessionId)
    return loadConversationBinding(requireHostClient(), id)
  })
  bridgeIpc.handle('aiterm:session:resume-preview', (event, sessionId: unknown) => {
    const id = requireKnownSession(event, sessionId)
    return previewConversationResume(requireHostClient(), id)
  })
  bridgeIpc.handle('aiterm:session:binding-replace', (event, sessionId: unknown, binding: ExplicitConversationBinding) => {
    const id = requireKnownSession(event, sessionId)
    if (!binding || binding.sessionId !== id) {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'Binding target must match sessionId')
    }
    return locateConversationBinding(requireHostClient(), binding)
  })
  bridgeIpc.handle('aiterm:session:binding-clear', (event, sessionId: unknown) => {
    const id = requireKnownSession(event, sessionId)
    return startNewConversation(requireHostClient(), id)
  })
  const adoptRestartedRuntime = (
    id: string,
    attachment: AttachmentIdentity,
    launch: { cwd: string; executable: string },
    dimensions: { cols: number; rows: number }
  ): StartupSuccess => {
    const record = sessionRecords.get(id)!
    const adopted = runtimes.get(id)
    // A retry of a recorded start names an incarnation this window may already be running; taking
    // its old attachment back would hand the pane a lease the renderer's recovery has revoked.
    if (adopted && !adoptsStartedAttachment(adopted.attachment, attachment)) return startupForRuntime(adopted)
    const runtime: ApplicationRuntime = runtimes.get(id) ?? {
      client: requireHostClient(),
      session: attachment,
      attachment,
      rendererPort: hostRendererPort!,
      dimensions,
      cwd: record.cwd,
      executable: record.executable,
      workspaceId: record.workspaceId,
      name: record.name,
      testMode: rendererTestMode,
      processState: 'live'
    }
    runtime.session = { sessionId: attachment.sessionId, incarnationId: attachment.incarnationId }
    runtime.attachment = attachment
    runtime.processState = 'live'
    runtime.cwd = launch.cwd
    runtime.executable = launch.executable
    runtimes.set(id, runtime)
    return startupForRuntime(runtime)
  }
  bridgeIpc.handle('aiterm:session:resume', async (event, sessionId: unknown, expectedCommand: unknown) => {
    const id = requireKnownSession(event, sessionId)
    if (expectedCommand !== undefined && (typeof expectedCommand !== 'string' || expectedCommand.length === 0)) {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'The confirmed command must be text')
    }
    const dimensions = runtimes.get(id)?.dimensions ?? { cols: 80, rows: 24 }
    const resumed = await resumeBoundSession(requireHostClient(), id, dimensions, expectedCommand)
    return adoptRestartedRuntime(id, resumed, resumed.launch, dimensions)
  })
  bridgeIpc.handle('aiterm:session:cohort-list', (event) => {
    if (!senderIsAllowed(event)) {
      throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
    }
    return requireHostClient().request<InterruptedSessionCohort | null>(
      METHOD_REGISTRY.sessionCohortList,
      {}
    )
  })
  bridgeIpc.handle('aiterm:session:cohort-offered', (event, cohortId: unknown) => {
    if (!senderIsAllowed(event)) {
      throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
    }
    if (typeof cohortId !== 'string' || cohortId.length === 0) {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'An explicit cohortId is required')
    }
    return requireHostClient().request<SessionCohortOfferedResult>(
      METHOD_REGISTRY.sessionCohortOffered,
      { cohortId }
    )
  })
  /**
   * The dialog's one action. The utility owns the starts and their order; this adopts each started
   * process as an ordinary pane, exactly as a single Resume or Start again does.
   */
  bridgeIpc.handle('aiterm:session:cohort-resume', async (event, request: unknown) => {
    if (!senderIsAllowed(event)) {
      throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
    }
    if (!isRendererCohortResumeRequest(request)) {
      throw new MainIpcError(ERROR_CODES.invalidArgument, 'Cohort resume parameters are invalid')
    }
    for (const entry of request.entries) {
      if (!sessionRecords.has(entry.sessionId)) {
        throw new MainIpcError(ERROR_CODES.notFound, 'The session was not found')
      }
    }
    const result = await requireHostClient().request<SessionCohortResumeResult>(
      METHOD_REGISTRY.sessionCohortResume,
      {
        cohortId: request.cohortId,
        idempotencyKey: request.idempotencyKey,
        entries: request.entries.map((entry) => ({
          ...entry,
          ...(runtimes.get(entry.sessionId)?.dimensions ?? { cols: 80, rows: 24 })
        }))
      }
    )
    return {
      cohortId: result.cohortId,
      entries: result.entries.map((entry) => {
        if (entry.outcome !== 'started' || !entry.started) {
          return { sessionId: entry.sessionId, outcome: entry.outcome, ...(entry.error ? { error: entry.error } : {}) }
        }
        const { cwd, executable, ...attachment } = entry.started
        return {
          sessionId: entry.sessionId,
          outcome: entry.outcome,
          startup: adoptRestartedRuntime(
            entry.sessionId,
            attachment,
            { cwd, executable },
            runtimes.get(entry.sessionId)?.dimensions ?? { cols: 80, rows: 24 }
          )
        }
      })
    }
  })
  bridgeIpc.handle('aiterm:session:relaunch', async (event, sessionId: unknown) => {
    const id = requireKnownSession(event, sessionId)
    const record = sessionRecords.get(id)!
    const dimensions = runtimes.get(id)?.dimensions ?? { cols: 80, rows: 24 }
    const started = await requireHostClient().request<AttachmentIdentity>(METHOD_REGISTRY.sessionRelaunch, {
      sessionId: id,
      ...dimensions
    })
    return adoptRestartedRuntime(id, started, record, dimensions)
  })
  ipcMain.on('aiterm:selected-session', (event, sessionId: unknown) => {
    if (!allowedSenders.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) return
    selectedSessions.set(event.sender.id, typeof sessionId === 'string' ? sessionId : null)
    appEvents.watchChanged()
  })
  bridgeIpc.handle('aiterm:app:quit', (event) => {
    if (!senderIsAllowed(event)) {
      throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
    }
    // before-quit still asks before running sessions are stopped.
    app.quit()
  })
  return bridgeIpc
}

function createWindow(
  startup: StartupResult,
  options: {
    forceHidden?: boolean
    terminalPort?: MessagePortMain
    recoverRenderer?: (window: BrowserWindow) => Promise<void>
    handleClose?: (event: { preventDefault(): void }) => void
  } = {}
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  trackAllowedSender(allowedSenders, window.webContents)
  const contentsId = window.webContents.id
  window.webContents.once('destroyed', () => selectedSessions.delete(contentsId))
  window.on('focus', () => appEvents.watchChanged())
  // A reloaded renderer starts believing the owner is present; tell it the truth.
  window.webContents.on('did-finish-load', () => window.webContents.send('aiterm:presence', presence.current()))
  wireLiveWindowLifecycle({
    onDidFinishLoad: (listener) => window.webContents.on('did-finish-load', listener),
    onRendererGone: (listener) =>
      window.webContents.on('render-process-gone', (_event, details) => listener(details.reason)),
    onClose: (listener) => window.on('close', listener),
    deliverStartup: () => {
      const port = options.terminalPort
      window.webContents.postMessage('aiterm:startup', startup, port ? [port] : [])
    },
    recoverRenderer: () => {
      void options.recoverRenderer?.(window)
    },
    shouldReloadRenderer: () => !quitRequested && !!hostClient && !window.isDestroyed(),
    reloadRenderer: () => window.webContents.reload(),
    keepResident: () => !quitRequested && runningTargets().length > 0,
    hideWindow: () => window.minimize(),
    ...(options.handleClose ? { handleClose: options.handleClose } : {})
  })
  if (!options.forceHidden) window.once('ready-to-show', () => window.show())
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

function startupForRuntime(current: ApplicationRuntime, viewRestored = false): StartupSuccess {
  return {
    ok: true,
    ...current.attachment,
    cwd: current.cwd,
    executable: current.executable,
    workspaceId: current.workspaceId,
    name: current.name,
    testMode: current.testMode,
    ...(viewRestored ? { viewRestored: true as const } : {})
  }
}

async function recoverApplicationRendererOnce(window: BrowserWindow): Promise<void> {
  const current = [...runtimes.values()]
  if (!hostClient || window.isDestroyed()) return
  selfTestTaps?.recoveryPhase('renderer recovery: started')
  let emptyRuntimeChannel:
    | { hostPort: MessagePortMain; rendererPort: MessagePortMain }
    | undefined
  const closeEmptyRuntimeChannel = (): void => {
    if (!emptyRuntimeChannel) return
    try {
      emptyRuntimeChannel.hostPort.close()
    } catch {
      // Preserve the recovery failure while still closing the renderer peer.
    }
    try {
      emptyRuntimeChannel.rendererPort.close()
    } catch {
      // Preserve the recovery failure.
    }
    emptyRuntimeChannel = undefined
  }
  try {
    // Load workspace state before any replacement port exists: a failed load must not strand an
    // attached host port that is never delivered to the renderer.
    const startup = await loadApplicationStartup(
      rendererTestMode || current.some((runtime) => runtime.testMode)
    )
    selfTestTaps?.recoveryPhase('renderer recovery: startup loaded')
    let rendererPort: MessagePortMain
    if (current.length > 0) {
      const recovered = await recoverExistingSessionRenderers(current, {
        createChannel: () => {
          const { port1, port2 } = new MessageChannelMain()
          return { hostPort: port1, rendererPort: port2 }
        },
        isMissingAttachment: (error) =>
          error instanceof PtyHostRemoteError && error.protocolError.data.code === ERROR_CODES.notFound,
        closeRendererPort: (port) => port.close(),
        isGone: (runtime) =>
          hostClient === runtime.client &&
          (runtimes.get(runtime.session.sessionId) !== runtime || runtime.processState !== 'live')
      })
      rendererPort = recovered.rendererPort
      // An ended session's view is replaced here and can never be reattached; an unconfirmed exit stays listed for Quit.
      for (const runtime of recovered.gone) dropRuntimeView(processTracking, runtime)
      selfTestTaps?.recoveryPhase('renderer recovery: sessions reattached')
      for (const item of recovered.attachments) {
        const runtime = runtimes.get(item.sessionId)
        if (runtime) {
          runtime.attachment = item.attachment
          runtime.rendererPort = rendererPort
        }
      }
    } else {
      emptyRuntimeChannel = connectRendererChannel({
        requireClient: requireHostClient,
        createChannel: () => {
          const { port1, port2 } = new MessageChannelMain()
          return { hostPort: port1, rendererPort: port2 }
        },
        connect: (client, port) => client.attachTerminalPort(port),
        closeHostPort: (port) => port.close(),
        closeRendererPort: (port) => port.close()
      })
      rendererPort = emptyRuntimeChannel.rendererPort
    }
    hostRendererPort = rendererPort
    if (window.isDestroyed()) {
      if (emptyRuntimeChannel) closeEmptyRuntimeChannel()
      else rendererPort.close()
      return
    }
    startup.liveSessions = [...runtimes.values()].map((runtime) => startupForRuntime(runtime, true))
    window.webContents.postMessage('aiterm:startup', startup, [rendererPort])
    selfTestTaps?.recoveryPhase('renderer recovery: startup posted')
  } catch (error) {
    closeEmptyRuntimeChannel()
    if (selfTestTaps) {
      const detail = error instanceof Error ? error.message : String(error)
      selfTestTaps.recoveryPhase(`renderer recovery failed: ${detail}`)
    }
    if (!window.isDestroyed()) {
      window.webContents.postMessage('aiterm:startup', actionableStartupFailure(error))
    }
  }
}

const requestRendererRecovery = createRendererRecoveryCoalescer(recoverApplicationRendererOnce)

function recoverApplicationRenderer(window: BrowserWindow): Promise<void> {
  return requestRendererRecovery(window)
}

function actionableStartupFailure(error: unknown): StartupFailure {
  if (error instanceof PtyHostRemoteError) {
    return { ok: false, code: error.protocolError.data.code, message: error.message }
  }
  const message = error instanceof Error ? error.message : 'The terminal host could not start'
  return { ok: false, code: ERROR_CODES.ioError, message: message.slice(0, 1_000) }
}


const selfTest = process.argv.includes('--self-test')
const rendererTestMode = process.argv.includes('--bmn-test-mode')
if (selfTest) {
  // The dictation flow records from Chromium's fake microphone, so the real recorder path runs without hardware.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}
ensureDevelopmentRoots()
app.on('will-quit', cleanupDevelopmentRoot)
process.once('exit', cleanupDevelopmentRoot)
const instanceRoots = resolveApplicationRoots()
const instanceDataRoot = instanceRoots.data
ensurePrivateDirectories(Object.values(instanceRoots), process.platform, instanceDataRoot)
protectWindowsApplicationLifetime()
const primaryInstance = acquireRootScopedSingleInstance(app, instanceDataRoot, () =>
  focusExistingWindow(applicationWindow)
)

function runningTargets(): RunningSessionTarget[] {
  return trackedRunningTargets(processTracking)
}

async function stopCurrentTargets(
  targets: readonly RunningSessionTarget[],
  cause: SessionStopCause
): Promise<void> {
  quitRequested = true
  try {
    await stopTrackedTargets(processTracking, targets, cause, (current, stopCause) =>
      current.client.request(METHOD_REGISTRY.sessionStop, {
        sessionId: current.session.sessionId,
        incarnationId: current.session.incarnationId,
        cause: stopCause
      })
    )
  } finally {
    quitRequested = false
  }
}

async function flushAllSavedOutput(targets?: readonly RunningSessionTarget[]): Promise<SavedOutputCaptureOutcome> {
  const current = [...runtimes.values()].filter((runtime) =>
    targets === undefined || targets.some((target) =>
      target.sessionId === runtime.session.sessionId &&
      target.incarnationId === runtime.session.incarnationId
    )
  )
  const view = captureWebContents(current.length > 0, applicationWindow)
  let aggregate: SavedOutputCaptureOutcome = { status: 'saved' }
  for (const runtime of current) {
    const outcome = await captureSavedOutputForLifecycle(
      runtime,
      view,
      savedOutputCaptureCoordinator,
      () => new Date(),
      (error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[BMN] final-capture loss disclosure could not be persisted: ${message}`)
      }
    )
    selfTestTaps?.lifecycleCaptured(runtime.session.sessionId, outcome.status)
    if (outcome.status === 'unavailable') aggregate = outcome
  }
  return aggregate
}

/**
 * Asks the window itself, so the owner reads session names in BMN's own dialog instead of a native
 * box full of identifiers. Resolves undefined when there is no window able to answer.
 */
async function askTheWindow(
  mode: ClosePromptMode,
  targets: readonly RunningSessionTarget[]
): Promise<ClosePromptDecision | undefined> {
  const sessions: ClosePromptSession[] = targets.map((target) => ({
    sessionId: target.sessionId,
    name: sessionRecords.get(target.sessionId)?.name ?? 'Untitled session',
    agent: agentName(target.executable),
    processState: target.processState
  }))
  const view = applicationWindow && !applicationWindow.isDestroyed()
    ? applicationWindow.webContents
    : undefined
  return closePromptCoordinator?.request(view, mode, sessions)
}

async function nativeChoice(
  type: 'question' | 'warning',
  prompt: CloseChoicePrompt | QuitChoicePrompt
): Promise<number> {
  const options = {
    type,
    noLink: true,
    message: prompt.message,
    detail: prompt.detail,
    buttons: [...prompt.buttons],
    defaultId: prompt.defaultId,
    cancelId: prompt.cancelId
  }
  const result = applicationWindow && !applicationWindow.isDestroyed()
    ? await dialog.showMessageBox(applicationWindow, options)
    : await dialog.showMessageBox(options)
  return result.response
}

const applicationLifecycle = createApplicationLifecycle({
  runningTargets,
  saveBackgroundChoice: async (decisions) => {
    for (const { target, choice } of decisions) {
      const current = runtimes.get(target.sessionId)
      const record = sessionRecords.get(target.sessionId)
      if (!current || !record || current.session.incarnationId !== target.incarnationId) continue
      const updated = await current.client.request<SessionRecord>(METHOD_REGISTRY.sessionUpdate, {
        sessionId: target.sessionId,
        expectedRevision: record.revision,
        backgroundChoice: choice
      })
      sessionRecords.set(updated.sessionId, updated)
      current.backgroundChoice = choice
    }
  },
  promptForClose: async (choice) => {
    const answered = await askTheWindow('close', choice.targets)
    if (answered) return answered
    // No window to ask: the native box is the honest fallback, and it answers for every session.
    const response = await nativeChoice('question', choice)
    if (response === 2) return { kind: 'cancel' }
    return {
      kind: 'proceed',
      choices: Object.fromEntries(
        choice.targets.map((target) => [target.sessionId, response === 0 ? 'hide' : 'stop'])
      ),
      remember: true
    }
  },
  promptForQuit: async (choice) => {
    const answered = await askTheWindow('quit', choice.targets)
    if (answered) return answered.kind === 'cancel' ? 'cancel' : 'quit'
    return (await nativeChoice('warning', choice)) === 0 ? 'quit' : 'cancel'
  },
  flushSavedOutput: flushAllSavedOutput,
  stopTargets: stopCurrentTargets,
  // A hidden (unmapped) window cannot be brought back on GNOME Wayland without a tray, so keeping
  // sessions running minimizes it; it stays in Alt+Tab and the overview.
  hideWindow: () => applicationWindow?.minimize(),
  quitApplication: () => app.quit(),
  restartForUpdate: () => autoUpdater.quitAndInstall(),
  reportFailure: (error) => {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('BMN could not complete the lifecycle action', message)
  }
})

const bridgeIpc = primaryInstance ? installIpcHandlers() : undefined

/** What the self-test may reach in this module; built only when `--self-test` runs. */
export interface SelfTestHost {
  hostClient: PtyHostClient | undefined
  hostRendererPort: MessagePortMain | undefined
  applicationWindow: BrowserWindow | undefined
  readonly runtimes: typeof runtimes
  readonly processTracking: typeof processTracking
  readonly sessionRecords: typeof sessionRecords
  readonly appEvents: typeof appEvents
  readonly applicationLifecycle: typeof applicationLifecycle
  readonly hostEnvironment: typeof hostEnvironment
  readonly appPaths: typeof appPaths
  readonly launchHostWithChannel: typeof launchHostWithChannel
  readonly trackSessionProcessStates: typeof trackSessionProcessStates
  readonly loadApplicationStartup: typeof loadApplicationStartup
  readonly createWindow: typeof createWindow
  readonly recoverApplicationRenderer: typeof recoverApplicationRenderer
  readonly stopCurrentTargets: typeof stopCurrentTargets
  readonly createSessionRuntime: typeof createSessionRuntime
  readonly reportPresence: typeof reportPresence
  readonly askTheWindow: typeof askTheWindow
  bridgeRegistrations(): readonly BridgeInvokeRegistration[]
}

function selfTestHost(): SelfTestHost {
  return {
    get hostClient() { return hostClient },
    set hostClient(client) { hostClient = client },
    get hostRendererPort() { return hostRendererPort },
    set hostRendererPort(port) { hostRendererPort = port },
    get applicationWindow() { return applicationWindow },
    set applicationWindow(window) { applicationWindow = window },
    runtimes,
    processTracking,
    sessionRecords,
    appEvents,
    applicationLifecycle,
    hostEnvironment,
    appPaths,
    launchHostWithChannel,
    trackSessionProcessStates,
    loadApplicationStartup,
    createWindow,
    recoverApplicationRenderer,
    stopCurrentTargets,
    createSessionRuntime,
    reportPresence,
    askTheWindow,
    bridgeRegistrations: () => bridgeIpc?.registrations() ?? []
  }
}
if (primaryInstance) autoUpdater.on('update-downloaded', () => applicationLifecycle.updateDownloaded())

if (primaryInstance) void app.whenReady().then(async () => {
  // The Chancel header replaces Electron's default File/Edit/View/Window bar and its stray
  // accelerators (reload, zoom, close); Quit lives in the command palette.
  Menu.setApplicationMenu(null)
  restrictWebPermissions()
  if (selfTest) {
    let exitCode = 0
    try {
      // The self-test and everything only it needs load here, so a normal run never parses them.
      const { runSelfTest, reportSelfTestFailure, SelfTestRecorder } = await import('./self-test/runner')
      const recorder = new SelfTestRecorder()
      selfTestTaps = recorder
      try {
        await runSelfTest(selfTestHost(), recorder)
      } catch (error) {
        reportSelfTestFailure(error)
        exitCode = 1
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[BMN] session self-test failed: the self-test could not load: ${message}`)
      exitCode = 1
    }
    console.error('[BMN] self-test phase: exiting application')
    app.exit(exitCode)
    return
  }

  // Automated runs share the owner's desktop session, so their panes must not follow the owner's idle time.
  if (!rendererTestMode) presence.start()
  try {
    const startup = await initializeApplication(rendererTestMode)
    if (!hostRendererPort) throw new Error('The renderer terminal channel is unavailable')
    applicationWindow = createWindow(startup, {
      terminalPort: hostRendererPort,
      recoverRenderer: recoverApplicationRenderer,
      handleClose: (event) => applicationLifecycle.closeLastWindow(event)
    })
    const startedHost = hostClient!
    watchHostLoss(startedHost, {
      isCurrent: () => hostClient === startedHost,
      clearRuntime: () => {
        // The shell processes ended with the host, so nothing is left to track.
        runtimes.clear()
        processTracking.unconfirmedExits.clear()
        hostClient = undefined
        hostRendererPort = undefined
      },
      publish: (notice) => {
        const window = applicationWindow
        if (window && !window.isDestroyed()) {
          window.webContents.postMessage('aiterm:startup', notice)
        }
      }
    })
  } catch (error) {
    const failure = actionableStartupFailure(error)
    console.error(`[BMN] terminal startup failed: ${failure.message}`)
    applicationWindow = createWindow(failure)
  }
})

app.on('activate', () => {
  if (applicationWindow && !applicationWindow.isDestroyed()) applicationWindow.show()
})

app.on('before-quit', (event) => {
  if (selfTest) return
  applicationLifecycle.beforeQuit(event)
})

app.on('window-all-closed', () => {
  if (selfTest || runtimes.size > 0) return
  app.quit()
})
