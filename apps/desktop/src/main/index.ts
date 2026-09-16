import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ERROR_CODES,
  METHOD_REGISTRY,
  isTerminalOutputMessage,
  type AppSettings,
  type ExplicitConversationBinding,
  type LaunchTemplateRecord,
  type LayoutGetResult,
  type SavedOutputCapture,
  type SavedOutputCaptureOutcome,
  type SavedOutputCatalog,
  type SavedOutputSnapshot,
  type SessionCreateParams,
  type SessionProcessState,
  type SessionRecord,
  type SessionStopCause,
  type TerminalOutputMessage,
  type WorkspaceLayoutState,
  type WorkspaceRecord
} from '@ai-terminal/protocol'
import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  Notification,
  powerMonitor,
  session as electronSession,
  utilityProcess,
  webContents,
  type IpcMainInvokeEvent,
  type MessagePortMain,
  type WebContents
} from 'electron'
import {
  closeWithinDeadline,
  PtyHostClient,
  PtyHostRemoteError,
  type HostReady
} from './pty-host-client'
import {
  connectRendererChannel,
  createRendererRecoveryCoalescer,
  recoverExistingSessionRenderers,
  scheduleTerminalViewRecovery,
  wireLiveWindowLifecycle,
  watchHostLoss
} from './host-loss'
import { DEFAULT_WORKSPACE_ID, STORY_SCHEMA_TABLES } from '../utility/store-schema'
import { resolveApplicationRoots } from '../utility/roots'
import { captureRelevantLaunchEnvironment } from '../utility/conversation-binding'
import { acquireRootScopedSingleInstance, focusExistingWindow } from './single-instance'
import { trackAllowedSender } from './allowed-senders'
import { createDevelopmentRoot } from './development-root'
import { installSavedOutputIpcHandler } from './saved-output-ipc'
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
import { createAppEventForwarder, installCompanionIpcHandlers } from './companion-ipc'
import { createPresenceMonitor, readMutterIdleMs } from './presence-monitor'
import { installVoiceIpcHandlers } from './voice-ipc'
import {
  attachCreatedSession,
  createExplicitLaunchSession,
  loadWorkspaceStartup
} from './application-startup'
import {
  activateBoundSession,
  loadConversationBinding,
  locateConversationBinding,
  resumeBoundSession,
  startNewConversation
} from './conversation-resume-ipc'
import {
  createApplicationLifecycle,
  runningTargetForRuntime,
  type BackgroundChoice,
  type RunningSessionTarget
} from './app-lifecycle'
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

const EXPECTED_ELECTRON_VERSION = '44.3.0'
const SELF_TEST_TIMEOUT_MS = 15_000

interface SessionIdentity {
  sessionId: string
  incarnationId: string
}

interface AttachmentIdentity extends SessionIdentity {
  attachmentId: string
  streamSeq: 0
  captureStartedAt: string
}

interface HostHealth {
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
/** Self-test hook: every renderer layout.put request main forwards, counted before the host answers. */
let selfTestLayoutPutRequests = 0
const selfTestLayoutPutSelections: Array<string | null> = []
let selfTestBridgeInvokeRegistrations: readonly BridgeInvokeRegistration[] = []
const SELF_TEST_LAUNCH_DISABLED_REASON =
  'Stored arguments are unavailable in the renderer boundary probe.'
let selfTestRendererLaunchBlockedSessionId: string | undefined
let selfTestRendererUnavailableTemplate: LaunchTemplateRecord | undefined
/** A failed self-test's release may still run after the reason is printed; it waits this long for the host. */
const SELF_TEST_RELEASE_CLOSE_DEADLINE_MS = 5_000
let selfTestFailureReported = false
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
  notify: ({ title, body, sessionId }) => {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body, silent: false })
    notification.on('click', () => {
      focusExistingWindow(applicationWindow)
      applicationWindow?.webContents.send('aiterm:open-session', sessionId)
    })
    notification.show()
  },
  notificationsEnabled: () => !selfTest,
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
    AITERM_REPO_ROOT: repoRoot,
    AITERM_CLI_PATH: aitermCliPath()
  }
}

/** Sessions get this file's directory on PATH; packaged builds carry a launcher for it under resources/bin. */
function aitermCliPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'aiterm')
    : join(app.getAppPath(), 'bin', 'aiterm')
}

async function launchHostWithChannel(): Promise<{
  client: PtyHostClient
  ready: HostReady
  applicationPort: MessagePortMain
}> {
  const { hostEntry, repoRoot } = appPaths()
  const client = await PtyHostClient.launch(hostEntry, hostEnvironment(repoRoot), {
    args: process.argv.includes('--self-test') ? ['--self-test-host'] : []
  })
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
  const rendererState = selfTest && testMode
    ? {
        ...state,
        sessions: state.sessions.map((session) =>
          session.sessionId === selfTestRendererLaunchBlockedSessionId
            ? { ...session, launchDisabledReason: SELF_TEST_LAUNCH_DISABLED_REASON }
            : session
        ),
        templates: selfTestRendererUnavailableTemplate
          ? [...state.templates, selfTestRendererUnavailableTemplate]
          : state.templates
      }
    : state
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
    throw new MainIpcError(ERROR_CODES.notFound, `Session ${sessionId} was not found`)
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

function installIpcHandlers(): void {
  savedOutputCaptureCoordinator = new SavedOutputCaptureCoordinator(
    ipcMain,
    (sender) => allowedSenders.has(sender.id) && !sender.isDestroyed()
  )
  const bridgeIpc = bridgeInvokeRegistrar(ipcMain)
  installWorkspaceIpcHandlers(bridgeIpc, senderIsAllowed, {
    client: () => ({
      request: async <Result,>(method: Parameters<PtyHostClient['request']>[0], params: object) => {
        if (selfTest && method === METHOD_REGISTRY.layoutPut) {
          selfTestLayoutPutRequests += 1
          const selectedSessionId = (params as { state?: { selectedSessionId?: unknown } })
            .state?.selectedSessionId
          selfTestLayoutPutSelections.push(
            typeof selectedSessionId === 'string' ? selectedSessionId : null
          )
        }
        const result = await requireHostClient().request<Result>(method, params)
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
  installCompanionIpcHandlers(bridgeIpc, {
    client: () => requireHostClient(),
    senderIsAllowed,
    dialogsEnabled: () => !selfTest
  })
  const defaultVoiceModelFolder = join(resolveApplicationRoots().data, 'voice', 'models')
  installVoiceIpcHandlers(bridgeIpc, {
    senderIsAllowed,
    binary: whisperBinaryPath(),
    modelFolder: async () => {
      const settings = await requireHostClient().request<AppSettings>(METHOD_REGISTRY.settingsGet, {})
      const chosen = settings.voice.modelFolder
      return chosen ? { path: chosen, custom: true } : { path: defaultVoiceModelFolder, custom: false }
    },
    chooseFolder: async (event) => {
      if (selfTest) throw new MainIpcError(ERROR_CODES.invalidArgument, 'File dialogs are unavailable in this run')
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
  bridgeIpc.handle('aiterm:session:resume', async (event, sessionId: unknown) => {
    const id = requireKnownSession(event, sessionId)
    const dimensions = runtimes.get(id)?.dimensions ?? { cols: 80, rows: 24 }
    const resumed = await resumeBoundSession(requireHostClient(), id, dimensions)
    return adoptRestartedRuntime(id, resumed, resumed.binding.launchContext, dimensions)
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
  if (selfTest) selfTestBridgeInvokeRegistrations = bridgeIpc.registrations()
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
    backgroundColor: '#14171b',
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
  if (selfTest) console.error('[ai-terminal] renderer recovery: started')
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
    if (selfTest) console.error('[ai-terminal] renderer recovery: startup loaded')
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
      if (selfTest) console.error('[ai-terminal] renderer recovery: sessions reattached')
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
    if (selfTest) console.error('[ai-terminal] renderer recovery: startup posted')
  } catch (error) {
    closeEmptyRuntimeChannel()
    if (selfTest) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[ai-terminal] renderer recovery failed: ${detail}`)
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

async function expectRemoteFailure(
  operation: Promise<unknown>,
  expectedCode: string,
  expectedCopy: string
): Promise<void> {
  try {
    await operation
    throw new Error(`expected ${expectedCode} failure`)
  } catch (error) {
    if (!(error instanceof PtyHostRemoteError)) throw error
    if (error.protocolError.data.code !== expectedCode || !error.message.includes(expectedCopy)) {
      throw new Error(`unexpected host failure: ${error.message}`, { cause: error })
    }
  }
}

async function nativeFailureSelfTest(hostEntry: string, repoRoot: string): Promise<void> {
  const dataRoot = process.env.AITERM_DATA_HOME
  if (!dataRoot) throw new Error('self-test requires AITERM_DATA_HOME')
  const databasePath = join(dataRoot, 'state.sqlite3')
  const child = utilityProcess.fork(hostEntry, ['--native-failure-self-test'], {
    serviceName: 'pty-host-native-failure',
    stdio: 'pipe',
    env: {
      ...hostEnvironment(repoRoot),
      AITERM_TEST_FAIL_NATIVE: 'node-pty'
    }
  })
  let stderr = ''
  let resolveActionableCopy = (): void => undefined
  const actionableCopyReceived = new Promise<void>((resolve) => {
    resolveActionableCopy = resolve
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
    if (stderr.includes('native module "node-pty" failed to load')) resolveActionableCopy()
  })
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('native failure self-test timed out'))
    }, SELF_TEST_TIMEOUT_MS)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })
  await Promise.race([
    actionableCopyReceived,
    new Promise<void>((resolve) => setTimeout(resolve, 500))
  ])
  if (exitCode === 0) throw new Error('native failure host unexpectedly exited zero')
  if (!stderr.includes('native module "node-pty" failed to load') || !stderr.includes('No sessions were started.')) {
    throw new Error(`native failure copy was not actionable: ${stderr.slice(-480)}`)
  }
  if (existsSync(databasePath)) {
    throw new Error('native failure created the database before dependency loading completed')
  }
}

async function waitForTerminalMarker(
  port: MessagePortMain,
  attachmentId: string,
  marker: string
): Promise<{ sequences: number[]; output: string }> {
  return new Promise((resolveMarker, reject) => {
    const decoder = new TextDecoder()
    const sequences: number[] = []
    let output = ''
    const timer = setTimeout(
      () => reject(new Error(`terminal marker was not observed; output=${JSON.stringify(output.slice(-500))}`)),
      SELF_TEST_TIMEOUT_MS
    )
    port.on('message', (event) => {
      if (!isTerminalOutputMessage(event.data)) return
      const message: TerminalOutputMessage = event.data
      if (message.attachmentId !== attachmentId) return
      sequences.push(message.streamSeq)
      output += decoder.decode(message.bytes, { stream: true })
      port.postMessage({
        kind: 'terminal-ack',
        attachmentId,
        streamSeq: message.streamSeq
      })
      if (output.includes(marker)) {
        clearTimeout(timer)
        resolveMarker({ sequences, output })
      }
    })
    port.start()
  })
}

interface RendererIntegrationProbe {
  workspaceCount: number
  sessionMethodSessionId: string
  bridgeErrorCodes: { staleLayoutPut: string; unknownSessionSavedOutput: string }
  launchUnavailable: {
    sessionId: string
    notice: string
    resumeDisabled: boolean
    resumeTitle: string
  }
  unavailableTemplate: { name: string; disabled: boolean; title: string }
  templateCreatedSession: {
    sessionId: string
    name: string
    executable: string
    argv: string[]
    cwd: string
    backgroundChoice: 'hide' | 'stop' | null
  }
  treeSelection: { sessionId: string; layoutSelectedSessionId: string | null }
  hiddenPaneSize: { shown: { cols: number; rows: number }; hidden: { cols: number; rows: number } }
}

async function stoppedPanelLabel(window: BrowserWindow, sessionId: string): Promise<string> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      let selected = false;
      const probe = () => {
        const button = [...document.querySelectorAll('.session-row > button[data-session-id]')]
          .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(sessionId)});
        if (!button) {
          reject(new Error('the stopped session tree button was not rendered'));
          return;
        }
        if (!selected) {
          selected = true;
          button.click();
        }
        const label = document.querySelector('.stopped-session p')?.textContent?.trim();
        if (label) resolve(label);
        else if (Date.now() >= deadline) reject(new Error('the stopped session label was not rendered'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<string>
}

/**
 * Ends a live pane's shell with `exit 23` and returns that pane's header once it stops reading
 * `Running`, so the caller compares the rendered live-exit wording exactly.
 */
async function liveExitPaneLabel(
  window: BrowserWindow,
  live: { sessionId: string; attachmentId: string; name: string }
): Promise<string> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const selector = ${JSON.stringify(`section.session-terminal[aria-label="${live.name} terminal"] header .pane-status`)};
      let exitRequested = false;
      const probe = () => {
        const label = document.querySelector(selector)?.textContent?.trim();
        if (label && !exitRequested) {
          exitRequested = true;
          const exit = () => window.aiTerminal.sendTerminalInput(
            ${JSON.stringify(live.attachmentId)},
            new TextEncoder().encode(${JSON.stringify('exit 23\r')})
          );
          // A pane selected in the tree already holds the active attachment and refuses a second activation.
          const pane = document.querySelector(${JSON.stringify(`section.session-terminal[aria-label="${live.name} terminal"]`)});
          if (pane && !pane.classList.contains('session-terminal-hidden')) exit();
          else window.aiTerminal.activateTerminal(${JSON.stringify(live.sessionId)}).then(exit, reject);
        }
        if (label && !label.startsWith('Running · ')) resolve(label);
        else if (Date.now() >= deadline) reject(new Error('the live pane header did not leave Running: ' + label));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<string>
}

/**
 * Prints reverse-video text in a live pane and returns the WCAG contrast ratio the renderer painted it with.
 * xterm.js 6.0.0 checks minimum contrast for default-colored inverse cells against the normal foreground, which
 * paints that text almost the color of its own background; bash highlights pasted text this way.
 */
async function inverseTextContrast(
  window: BrowserWindow,
  live: { sessionId: string; attachmentId: string; name: string }
): Promise<number> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const paneSelector = ${JSON.stringify(`section.session-terminal[aria-label="${live.name} terminal"]`)};
      const luminance = (css) => {
        const channels = css.slice(css.indexOf('(') + 1, css.indexOf(')')).split(',').slice(0, 3).map((value) => {
          const channel = Number(value) / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      let selected = false;
      let printed = false;
      const probe = () => {
        const pane = document.querySelector(paneSelector);
        if (!selected) {
          const button = [...document.querySelectorAll('.session-row > button[data-session-id]')]
            .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(live.sessionId)});
          if (button) {
            selected = true;
            button.click();
          }
        }
        // A pane that is not selected is laid out at one pixel and renders a single row.
        const shown = pane && !pane.classList.contains('session-terminal-hidden') && pane.querySelector('.xterm-rows')?.children.length > 1;
        if (shown && !printed) {
          printed = true;
          // Selecting the session in the tree already made its attachment the active one.
          window.aiTerminal.sendTerminalInput(
            ${JSON.stringify(live.attachmentId)},
            new TextEncoder().encode(${JSON.stringify("printf '\\033[7m%s\\033[0m\\n' INVERSE-PROBE\r")})
          );
        }
        const span = shown && [...pane.querySelectorAll('.xterm-rows span')].find((item) => item.textContent === 'INVERSE-PROBE');
        if (span) {
          const style = getComputedStyle(span);
          const [lighter, darker] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
          resolve((lighter + 0.05) / (darker + 0.05));
        } else if (Date.now() >= deadline) {
          reject(new Error('the live pane did not render reverse-video output: ' + JSON.stringify({ selected, shown: !!shown, rows: pane?.querySelector('.xterm-rows')?.textContent?.slice(-300) })));
        } else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<number>
}

/**
 * Waits for a recovered startup to replace an exited session's pane (a failed recovery leaves the pane
 * mounted), then selects that session in the rendered tree and returns its stopped-panel label.
 */
async function recoveredStoppedLabel(
  window: BrowserWindow,
  stopped: { sessionId: string; name: string }
): Promise<string> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const pane = ${JSON.stringify(`section.session-terminal[aria-label="${stopped.name} terminal"]`)};
      let selected = false;
      const probe = () => {
        const button = [...document.querySelectorAll('.session-row > button[data-session-id]')]
          .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(stopped.sessionId)});
        if (!selected && button && !document.querySelector(pane)) {
          selected = true;
          button.click();
        }
        const panel = document.querySelector('.stopped-session');
        if (selected && panel?.querySelector('h2')?.textContent === ${JSON.stringify(stopped.name)}) {
          resolve(panel.querySelector('p')?.textContent?.trim() ?? '');
        } else if (Date.now() >= deadline) {
          const notice = document.querySelector('.feedback-notice')?.textContent ?? '';
          reject(new Error('the recovered workspace did not show the stopped session: ' + notice));
        } else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<string>
}

async function waitForRendererIntegration(window: BrowserWindow): Promise<RendererIntegrationProbe> {
  const rendererProbe = window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const probe = () => {
        const integration = window.__aitermTest?.integration;
        if (integration) integration().then(resolve, reject);
        else if (Date.now() >= deadline) reject(new Error('renderer integration hook timed out'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<RendererIntegrationProbe>
  return Promise.race([
    rendererProbe,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('renderer integration main-process timeout')), 20_000))
  ])
}

function waitForRendererLoad(window: BrowserWindow): Promise<void> {
  return new Promise((resolveLoad, reject) => {
    const timer = setTimeout(
      () => reject(new Error('renderer did-finish-load timed out')),
      5_000
    )
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      resolveLoad()
    })
  })
}

async function waitForRendererHook(window: BrowserWindow): Promise<void> {
  try {
    await Promise.race([
      window.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const probe = () => {
            if (window.__aitermTest?.snapshot) resolve(true);
            else if (Date.now() >= deadline) reject(new Error('recovered renderer hook timed out'));
            else setTimeout(probe, 25);
          };
          probe();
        })
      `),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('recovered renderer hook main-process timeout')), 11_000))
    ])
  } catch (error) {
    const diagnostics = await window.webContents.executeJavaScript(`({
      hasBridge: !!window.aiTerminal,
      hasHook: !!window.__aitermTest,
      body: document.body.innerText.slice(0, 500)
    })`)
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${detail}; diagnostics ${JSON.stringify(diagnostics)}`, { cause: error })
  }
}

async function verifyRegisteredInvokeEnvelopes(): Promise<string[]> {
  const unauthorizedSender = { id: -1, mainFrame: {} }
  const event = {
    sender: unauthorizedSender,
    senderFrame: unauthorizedSender.mainFrame
  } as unknown as IpcMainInvokeEvent
  const channels: string[] = []
  for (const registration of selfTestBridgeInvokeRegistrations) {
    const answer = await registration.invoke(event)
    if (
      answer.ok !== false ||
      answer.code !== ERROR_CODES.unauthorized ||
      typeof answer.message !== 'string'
    ) {
      throw new Error(`invoke channel ${registration.channel} bypassed the typed bridge envelope`)
    }
    channels.push(registration.channel)
  }
  if (channels.length === 0 || new Set(channels).size !== channels.length) {
    throw new Error('runtime invoke-channel enumeration was empty or duplicated')
  }
  return channels
}

/** The one printer for a failed self-test: the first failure is the reason, printed once. */
function reportSelfTestFailure(error: unknown): void {
  if (selfTestFailureReported) return
  selfTestFailureReported = true
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[ai-terminal] session self-test failed: ${message}`)
}

async function runSelfTest(): Promise<void> {
  const { hostEntry, repoRoot } = appPaths()
  await nativeFailureSelfTest(hostEntry, repoRoot)
  const launched = await launchHostWithChannel()
  let client = launched.client
  const ready = launched.ready
  let applicationPort: MessagePortMain | undefined = launched.applicationPort
  let receipt: Record<string, unknown> | undefined
  let graceful = true
  let clientClosed = false
  try {
    const isolatedCwd = process.env.AITERM_STATE_HOME
    if (!isolatedCwd) throw new Error('self-test requires AITERM_STATE_HOME')
    const envelopedInvokeChannels = await verifyRegisteredInvokeEnvelopes()

    await expectRemoteFailure(
      client.request(METHOD_REGISTRY.sessionCreate, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        name: 'Invalid directory probe',
        cwd: join(isolatedCwd, 'missing-launch-directory'),
        executable: '/bin/bash',
        argv: [],
        cols: 80,
        rows: 24
      }),
      ERROR_CODES.invalidArgument,
      'Launch directory does not exist or is not a directory:'
    )
    await expectRemoteFailure(
      client.request(METHOD_REGISTRY.sessionCreate, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        name: 'Invalid executable probe',
        cwd: isolatedCwd,
        executable: join(isolatedCwd, 'missing-shell'),
        argv: [],
        cols: 80,
        rows: 24
      }),
      ERROR_CODES.invalidArgument,
      'Shell executable does not exist or is not executable:'
    )
    const failedHealth = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    if (
      failedHealth.liveSessions !== 0 ||
      failedHealth.runningIncarnations !== 0 ||
      failedHealth.sessionRecords !== 0 ||
      failedHealth.incarnationRecords !== 0 ||
      failedHealth.workspaceRecords !== 1
    ) {
      throw new Error('a failed session.create appeared live')
    }

    const session = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionCreate, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Self-test shell',
      cwd: isolatedCwd,
      executable: '/bin/bash',
      argv: ['--noprofile', '--norc'],
      cols: 80,
      rows: 24
    })
    const attachment = await client.request<AttachmentIdentity>(METHOD_REGISTRY.terminalAttach, session)
    await client.request(METHOD_REGISTRY.terminalActivate, {
      attachmentId: attachment.attachmentId
    })
    const marker = 'AITERM-1-1-PORT-ROUNDTRIP'
    const environmentMarker = 'AITERM-1-1-ELECTRON-ENV-UNSET'
    const markerResult = waitForTerminalMarker(
      applicationPort,
      attachment.attachmentId,
      environmentMarker
    )
    applicationPort.postMessage({
      kind: 'terminal-input',
      method: METHOD_REGISTRY.terminalWrite,
      attachmentId: attachment.attachmentId,
      bytes: new TextEncoder().encode(
        `if [ -z "\${ELECTRON_RUN_AS_NODE+x}" ]; then printf 'AITERM-1-1-%s\\nAITERM-1-1-ELECTRON-ENV-%s\\n' 'PORT-ROUNDTRIP' 'UNSET'; else printf 'AITERM-1-1-ELECTRON-ENV-%s\\n' 'LEAK'; fi\r`
      )
    })
    const observed = await markerResult
    if (!observed.output.includes(marker) || observed.output.includes('AITERM-1-1-ELECTRON-ENV-LEAK')) {
      throw new Error('the spawned shell inherited ELECTRON_RUN_AS_NODE')
    }
    if (!observed.sequences.every((sequence, index) => sequence === index)) {
      throw new Error(`terminal stream sequence was not contiguous from zero: ${observed.sequences.join(',')}`)
    }

    await client.request(METHOD_REGISTRY.terminalResize, {
      attachmentId: attachment.attachmentId,
      cols: 101,
      rows: 37
    })
    const resizedHealth = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    const resized = resizedHealth.sessions.find(
      (candidate) => candidate.incarnationId === session.incarnationId
    )
    if (resized?.cols !== 101 || resized.rows !== 37) {
      throw new Error('PTY dimensions did not follow terminal.resize')
    }

    await client.request(METHOD_REGISTRY.terminalDetach, {
      attachmentId: attachment.attachmentId
    })
    const detachedHealth = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    if (detachedHealth.liveSessions !== 1 || detachedHealth.sessions[0]?.attached !== false) {
      throw new Error('terminal.detach stopped the process or retained its lease')
    }

    const secondWorkspace = await client.request<WorkspaceRecord>(METHOD_REGISTRY.workspaceCreate, {
      name: 'Self-test archived workspace',
      defaultCwd: isolatedCwd,
      position: 1
    })
    const rendererTemplate = await client.request<LaunchTemplateRecord>(
      METHOD_REGISTRY.templateCreate,
      {
        name: 'Template-picked shell',
        executable: '/bin/bash',
        argv: ['--noprofile', '--norc'],
        cwd: isolatedCwd,
        backgroundChoice: 'stop'
      }
    )
    const secondSession = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionCreate, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Same CLI chat B',
      cwd: isolatedCwd,
      executable: '/bin/bash',
      argv: ['--noprofile', '--norc'],
      cols: 80,
      rows: 24
    })
    selfTestRendererLaunchBlockedSessionId = secondSession.sessionId
    selfTestRendererUnavailableTemplate = {
      ...rendererTemplate,
      templateId: 'renderer-unavailable-template',
      name: 'Unavailable launch template',
      launchDisabledReason: SELF_TEST_LAUNCH_DISABLED_REASON
    }
    const thirdSession = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionCreate, {
      workspaceId: secondWorkspace.workspaceId,
      name: 'Archived running chat',
      cwd: isolatedCwd,
      executable: '/bin/bash',
      argv: ['--noprofile', '--norc'],
      cols: 80,
      rows: 24,
      backgroundChoice: 'hide'
    })
    const bindingFor = (
      identity: SessionIdentity,
      reference: string,
      agentCli: 'claude' | 'codex'
    ): ExplicitConversationBinding => ({
      sessionId: identity.sessionId,
      agentCli,
      status: 'bound',
      conversationReference: reference,
      captureRoute: 'explicit-resume-reference',
      launchContext: {
        cwd: isolatedCwd,
        executable: agentCli === 'codex' ? '/usr/bin/codex' : '/usr/bin/claude',
        argv: [],
        environment: captureRelevantLaunchEnvironment({})
      },
      detail: 'self-test fixture binding',
      capturedAt: '2026-09-13T00:00:00.000Z'
    })
    const bindingA = bindingFor(session, '11111111-1111-4111-8111-111111111111', 'codex')
    const bindingB = bindingFor(secondSession, '22222222-2222-4222-8222-222222222222', 'codex')
    const bindingC = bindingFor(thirdSession, '33333333-3333-4333-8333-333333333333', 'claude')
    for (const binding of [bindingA, bindingB, bindingC]) {
      await client.request(METHOD_REGISTRY.sessionBindingReplace, { binding })
    }
    const bindingBBeforeLocate = JSON.stringify(
      await client.request(METHOD_REGISTRY.sessionBindingGet, { sessionId: secondSession.sessionId })
    )
    await client.request(METHOD_REGISTRY.sessionBindingReplace, {
      binding: { ...bindingA, conversationReference: '44444444-4444-4444-8444-444444444444' }
    })
    const bindingBAfterLocate = JSON.stringify(
      await client.request(METHOD_REGISTRY.sessionBindingGet, { sessionId: secondSession.sessionId })
    )
    if (bindingBBeforeLocate !== bindingBAfterLocate) {
      throw new Error('Locate chat changed another session binding')
    }
    await client.request(METHOD_REGISTRY.sessionBindingClear, { sessionId: session.sessionId })
    const bindingBAfterStartNew = JSON.stringify(
      await client.request(METHOD_REGISTRY.sessionBindingGet, { sessionId: secondSession.sessionId })
    )
    if (bindingBBeforeLocate !== bindingBAfterStartNew) {
      throw new Error('Start new changed another session binding')
    }
    await client.request(METHOD_REGISTRY.sessionBindingReplace, {
      binding: { ...bindingA, conversationReference: '44444444-4444-4444-8444-444444444444' }
    })

    const defaultSessions = await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
      workspaceId: DEFAULT_WORKSPACE_ID
    })
    const editableSession = defaultSessions.find((record) => record.sessionId === session.sessionId)!
    await expectRemoteFailure(
      client.request(METHOD_REGISTRY.sessionUpdate, {
        sessionId: editableSession.sessionId,
        expectedRevision: editableSession.revision,
        cwd: join(isolatedCwd, 'missing-edited-directory')
      }),
      ERROR_CODES.invalidArgument,
      'Launch directory does not exist or is not a directory:'
    )
    const afterInvalidEdit = await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
      workspaceId: DEFAULT_WORKSPACE_ID
    })
    if (afterInvalidEdit.find((record) => record.sessionId === session.sessionId)?.cwd !== isolatedCwd) {
      throw new Error('invalid session edit changed the stored launch directory')
    }
    await client.request(METHOD_REGISTRY.layoutPut, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      expectedRevision: 1,
      state: {
        workspaceId: DEFAULT_WORKSPACE_ID,
        selectedSessionId: secondSession.sessionId,
        split: {
          orientation: 'side-by-side',
          panes: [
            { sessionId: session.sessionId, ratio: 0.5 },
            { sessionId: secondSession.sessionId, ratio: 0.5 }
          ]
        },
        sessionView: {
          [session.sessionId]: { scrollLine: 19, followTail: false },
          [secondSession.sessionId]: { scrollLine: null, followTail: true }
        },
        revision: 1
      }
    })
    const archivedWorkspace = await client.request<WorkspaceRecord>(METHOD_REGISTRY.workspaceUpdate, {
      workspaceId: secondWorkspace.workspaceId,
      expectedRevision: secondWorkspace.revision,
      archived: true
    })

    const rendererChannel = new MessageChannelMain()
    client.attachTerminalPort(rendererChannel.port1)
    applicationPort.close()
    applicationPort = rendererChannel.port2
    hostClient = client
    hostRendererPort = applicationPort
    trackSessionProcessStates(client)
    runtimes.clear()
    processTracking.unconfirmedExits.clear()
    sessionRecords.clear()
    const allSessions = [
      ...defaultSessions,
      ...await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
        workspaceId: secondWorkspace.workspaceId
      })
    ]
    const identities = [session, secondSession, thirdSession]
    const launchBackgroundChoiceRecorded = allSessions.find(
      (record) => record.sessionId === thirdSession.sessionId
    )?.backgroundChoice
    if (launchBackgroundChoiceRecorded !== 'hide') {
      throw new Error(`session.create did not record the launch background choice: ${String(launchBackgroundChoiceRecorded)}`)
    }
    if (!allSessions.every((record) =>
      record.lastProcess?.state === 'live' &&
      identities.some((identity) => identity.incarnationId === record.lastProcess?.incarnationId)
    )) {
      throw new Error('session.list did not report the live incarnation of every running session')
    }
    for (const record of allSessions) {
      sessionRecords.set(record.sessionId, record)
      const identity = identities.find((item) => item.sessionId === record.sessionId)!
      const liveAttachment = await client.request<AttachmentIdentity>(METHOD_REGISTRY.terminalAttach, identity)
      runtimes.set(record.sessionId, {
        client,
        session: identity,
        attachment: liveAttachment,
        rendererPort: applicationPort,
        dimensions: { cols: 80, rows: 24 },
        cwd: record.cwd,
        executable: record.executable,
        workspaceId: record.workspaceId,
        name: record.name,
        testMode: true,
        processState: 'live'
      })
    }
    const beforeRenderer = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    if (beforeRenderer.liveSessions !== 3 || beforeRenderer.incarnationRecords !== 3) {
      throw new Error('multi-session fixture did not create exactly three live processes')
    }
    const rendererStartup = await loadApplicationStartup(true)
    console.error('[ai-terminal] self-test phase: renderer preload integration')
    applicationWindow = createWindow(rendererStartup, {
      forceHidden: true,
      terminalPort: applicationPort,
      recoverRenderer: recoverApplicationRenderer
    })
    applicationWindow.webContents.on('console-message', (_event, level, message) => {
      if (level === 2) console.error(`[ai-terminal] renderer console: ${message}`)
    })
    await waitForRendererLoad(applicationWindow)
    const layoutSelectionsBeforeRendererProbe = selfTestLayoutPutSelections.length
    const preloadProbe = await waitForRendererIntegration(applicationWindow)
    if (
      preloadProbe.bridgeErrorCodes.staleLayoutPut !== ERROR_CODES.revisionConflict ||
      preloadProbe.bridgeErrorCodes.unknownSessionSavedOutput !== ERROR_CODES.notFound
    ) {
      throw new Error(
        `typed bridge errors did not survive the contextBridge: ${JSON.stringify(preloadProbe.bridgeErrorCodes)}`
      )
    }
    if (
      preloadProbe.launchUnavailable.sessionId !== secondSession.sessionId ||
      preloadProbe.launchUnavailable.notice !==
        `Launch unavailable: ${SELF_TEST_LAUNCH_DISABLED_REASON}` ||
      preloadProbe.launchUnavailable.resumeDisabled !== true ||
      preloadProbe.launchUnavailable.resumeTitle !== SELF_TEST_LAUNCH_DISABLED_REASON
    ) {
      throw new Error(
        `the renderer did not block Resume with its stored reason: ${JSON.stringify(preloadProbe.launchUnavailable)}`
      )
    }
    if (
      preloadProbe.unavailableTemplate.name !== 'Unavailable launch template — unavailable' ||
      preloadProbe.unavailableTemplate.disabled !== true ||
      preloadProbe.unavailableTemplate.title !== SELF_TEST_LAUNCH_DISABLED_REASON
    ) {
      throw new Error(
        `the renderer did not disable the unavailable template: ${JSON.stringify(preloadProbe.unavailableTemplate)}`
      )
    }
    if (
      preloadProbe.templateCreatedSession.name !== rendererTemplate.name ||
      preloadProbe.templateCreatedSession.executable !== rendererTemplate.executable ||
      JSON.stringify(preloadProbe.templateCreatedSession.argv) !== JSON.stringify(rendererTemplate.argv) ||
      preloadProbe.templateCreatedSession.cwd !== rendererTemplate.cwd ||
      preloadProbe.templateCreatedSession.backgroundChoice !== rendererTemplate.backgroundChoice
    ) {
      throw new Error(
        `the real renderer template pick created the wrong session: ${JSON.stringify(preloadProbe.templateCreatedSession)}`
      )
    }
    const rendererProbeLayoutSelections = selfTestLayoutPutSelections.slice(
      layoutSelectionsBeforeRendererProbe
    )
    if (
      preloadProbe.treeSelection.layoutSelectedSessionId !== preloadProbe.treeSelection.sessionId ||
      !rendererProbeLayoutSelections.includes(preloadProbe.treeSelection.sessionId)
    ) {
      throw new Error(
        `the real tree selection did not issue a matching layout.put: ${JSON.stringify({
          probe: preloadProbe.treeSelection,
          puts: rendererProbeLayoutSelections
        })}`
      )
    }
    const { shown, hidden } = preloadProbe.hiddenPaneSize
    if (shown.cols < 20 || hidden.cols !== shown.cols || hidden.rows !== shown.rows) {
      throw new Error(
        `a hidden pane resized its terminal: ${JSON.stringify(preloadProbe.hiddenPaneSize)}`
      )
    }
    const templateRuntime = runtimes.get(preloadProbe.templateCreatedSession.sessionId)
    const applicationQuitTarget = templateRuntime
      ? runningTargetForRuntime({
          ...templateRuntime.session,
          executable: templateRuntime.executable,
          processState: templateRuntime.processState,
          ...(templateRuntime.backgroundChoice
            ? { backgroundChoice: templateRuntime.backgroundChoice }
            : {})
        })
      : undefined
    if (!applicationQuitTarget) throw new Error('the template-created session was not live')
    await stopCurrentTargets([applicationQuitTarget], 'application-quit')
    const defaultSessionsAfterLifecycleStop = await client.request<SessionRecord[]>(
      METHOD_REGISTRY.sessionList,
      { workspaceId: DEFAULT_WORKSPACE_ID }
    )
    const lifecycleStoppedBeforeRestart = defaultSessionsAfterLifecycleStop.find(
      (record) => record.sessionId === preloadProbe.templateCreatedSession.sessionId
    )?.lastProcess
    if (
      lifecycleStoppedBeforeRestart?.state !== 'interrupted' ||
      !lifecycleStoppedBeforeRestart.detail?.startsWith('application quit · signal ')
    ) {
      throw new Error(
        `application-quit stop was not recorded as interrupted: ${JSON.stringify(lifecycleStoppedBeforeRestart)}`
      )
    }
    console.error('[ai-terminal] self-test phase: inactive workspace following output')
    const inactiveAttachmentId = runtimes.get(thirdSession.sessionId)?.attachment.attachmentId
    if (!inactiveAttachmentId) throw new Error('the inactive workspace session has no renderer attachment')
    const inactiveMarker = 'AITERM-2-1-INACTIVE-FOLLOWING-DONE'
    const inactiveSavedOutput = (): Promise<SavedOutputCatalog> =>
      client.request<SavedOutputCatalog>(METHOD_REGISTRY.terminalSavedOutputGet, { sessionId: thirdSession.sessionId })
    const withinPhase = <Value,>(step: string, pending: Promise<Value>): Promise<Value> => Promise.race([
      pending,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`inactive workspace output step timed out: ${step}`)), 5_000))
    ])
    const rendererPause = (milliseconds: number): Promise<unknown> => withinPhase(
      'renderer pause',
      applicationWindow!.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, ${milliseconds}))`)
    )
    await rendererPause(400)
    const inactiveCaptureBefore = (await withinPhase('saved output before', inactiveSavedOutput())).current?.capturedAt ?? null
    const layoutPutsBeforeOutput = selfTestLayoutPutRequests
    await withinPhase('activate and type', applicationWindow.webContents.executeJavaScript(`
      window.aiTerminal.activateTerminal(${JSON.stringify(thirdSession.sessionId)}).then(() => {
        window.aiTerminal.sendTerminalInput(
          ${JSON.stringify(inactiveAttachmentId)},
          new TextEncoder().encode(${JSON.stringify(
            "for line in $(seq 1 80); do echo \"inactive-following-output-$line\"; done; printf 'AITERM-2-1-%s\\n' INACTIVE-FOLLOWING-DONE\r"
          )})
        );
        return true;
      })
    `))
    console.error('[ai-terminal] self-test phase: inactive workspace output requested')
    const captureDeadline = Date.now() + 10_000
    let inactiveFollowingOutputCaptured = false
    while (!inactiveFollowingOutputCaptured && Date.now() < captureDeadline) {
      const current = (await withinPhase('saved output get', inactiveSavedOutput())).current
      inactiveFollowingOutputCaptured = current !== undefined &&
        current.capturedAt !== inactiveCaptureBefore &&
        current.content.replace(/\s+/g, '').includes(inactiveMarker)
      if (!inactiveFollowingOutputCaptured) await rendererPause(100)
    }
    if (!inactiveFollowingOutputCaptured) {
      throw new Error('output streamed to the inactive workspace session did not advance its saved output capture')
    }
    console.error('[ai-terminal] self-test phase: inactive workspace output captured')
    await rendererPause(500)
    const inactiveFollowingOutputLayoutPuts = selfTestLayoutPutRequests - layoutPutsBeforeOutput
    console.error(`[ai-terminal] self-test phase: inactive workspace output layout puts ${inactiveFollowingOutputLayoutPuts}`)
    if (inactiveFollowingOutputLayoutPuts !== 0) {
      throw new Error(
        `output to a following session of an inactive workspace issued ${inactiveFollowingOutputLayoutPuts} layout.put request(s)`
      )
    }
    const showArchivedReachable = await applicationWindow.webContents.executeJavaScript(
      "document.body.innerText.includes('Show archived')"
    ) as boolean
    console.error('[ai-terminal] self-test phase: renderer restart')
    const reloaded = waitForRendererLoad(applicationWindow)
    applicationWindow.webContents.reload()
    await reloaded
    await waitForRendererHook(applicationWindow)
    console.error('[ai-terminal] self-test phase: renderer restart loaded')
    const rendererStoppedPanelLabel = await stoppedPanelLabel(
      applicationWindow,
      preloadProbe.templateCreatedSession.sessionId
    )
    const expectedStoppedPanelLabel =
      `Interrupted · ${lifecycleStoppedBeforeRestart!.detail} · ${rendererTemplate.cwd}`
    if (rendererStoppedPanelLabel !== expectedStoppedPanelLabel) {
      throw new Error(
        `the stopped panel did not render the recorded process label: ${JSON.stringify(rendererStoppedPanelLabel)}`
      )
    }
    const afterRenderer = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    if (afterRenderer.liveSessions !== 3 || afterRenderer.incarnationRecords !== 4) {
      throw new Error('renderer restart duplicated or stopped a process')
    }
    const archivedStillLive = afterRenderer.sessions.some(
      (candidate) => candidate.sessionId === thirdSession.sessionId && candidate.state === 'live'
    )
    if (!archivedStillLive || !showArchivedReachable) {
      throw new Error('archived running session was not reachable')
    }
    if (archivedWorkspace.archivedAt === null) throw new Error('workspace archive did not persist')
    const expectedBindings = await Promise.all(identities.map((identity) =>
      client.request(METHOD_REGISTRY.sessionBindingGet, { sessionId: identity.sessionId })
    ))

    console.error('[ai-terminal] self-test phase: application restart')
    const supersededHostPid = client.process.pid
    const firstHostAbandoned = new Promise<void>((resolveAbandoned) => {
      const onMessage = (message: unknown): void => {
        if (
          message &&
          typeof message === 'object' &&
          (message as { kind?: unknown }).kind === 'host-loss-self-test-ready'
        ) {
          client.process.off('message', onMessage)
          resolveAbandoned()
        }
      }
      client.process.on('message', onMessage)
    })
    console.error('[ai-terminal] self-test phase: terminating first host')
    await client.request(METHOD_REGISTRY.healthGet, { selfTestHostLoss: true })
    console.error('[ai-terminal] self-test phase: first host termination requested')
    await Promise.race([
      firstHostAbandoned,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('self-test host termination timed out')), 5_000))
    ])
    console.error('[ai-terminal] self-test phase: first host released its database')
    applicationWindow.webContents.postMessage('aiterm:startup', {
      ok: false,
      code: ERROR_CODES.ioError,
      message: 'The self-test simulated application restart'
    })
    await applicationWindow.webContents.executeJavaScript(
      'new Promise((resolve) => setTimeout(resolve, 0))'
    )
    clientClosed = true
    hostClient = undefined
    hostRendererPort = undefined
    runtimes.clear()
    processTracking.unconfirmedExits.clear()
    sessionRecords.clear()

    const restarted = await launchHostWithChannel()
    console.error('[ai-terminal] self-test phase: restarted host ready')
    applicationWindow.hide()
    client = restarted.client
    clientClosed = false
    applicationPort = restarted.applicationPort
    const restoredWorkspaces = await client.request<WorkspaceRecord[]>(METHOD_REGISTRY.workspaceList, {
      includeArchived: true
    })
    const restoredDefaultSessions = await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
      workspaceId: DEFAULT_WORKSPACE_ID
    })
    const restoredArchivedSessions = await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
      workspaceId: secondWorkspace.workspaceId
    })
    const { layout: restoredLayout } = await client.request<LayoutGetResult>(METHOD_REGISTRY.layoutGet, {
      workspaceId: DEFAULT_WORKSPACE_ID
    })
    const restoredHealth = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    console.error('[ai-terminal] self-test phase: restored state queried')
    const restoredBindings = await Promise.all(identities.map((identity) =>
      client.request(METHOD_REGISTRY.sessionBindingGet, { sessionId: identity.sessionId })
    ))
    const persistedBindingView = (value: unknown): unknown => {
      const binding = value as ExplicitConversationBinding
      return {
        sessionId: binding.sessionId,
        agentCli: binding.agentCli,
        conversationReference: binding.conversationReference,
        captureRoute: binding.captureRoute,
        launchContext: binding.launchContext,
        capturedAt: binding.capturedAt
      }
    }
    if (
      restoredHealth.liveSessions !== 0 ||
      restoredHealth.runningIncarnations !== 0 ||
      restoredHealth.interruptedIncarnations !== 4
    ) {
      throw new Error('application restart did not interrupt every prior live incarnation')
    }
    if (![...restoredDefaultSessions, ...restoredArchivedSessions].every((record) =>
      record.lastProcess?.state === 'interrupted' &&
      record.lastProcess.exitCode === null &&
      record.lastProcess.signal === null
    )) {
      throw new Error('session.list did not report the interrupted incarnation after application restart')
    }
    const lifecycleStoppedAfterRestart = restoredDefaultSessions.find(
      (record) => record.sessionId === preloadProbe.templateCreatedSession.sessionId
    )?.lastProcess
    if (
      lifecycleStoppedAfterRestart?.state !== 'interrupted' ||
      lifecycleStoppedAfterRestart.detail !== lifecycleStoppedBeforeRestart.detail
    ) {
      throw new Error(
        `application-quit interruption source did not survive restart: ${JSON.stringify(lifecycleStoppedAfterRestart)}`
      )
    }
    if (
      restoredWorkspaces.length !== 2 ||
      restoredDefaultSessions.map((item) => item.sessionId).join(',') !== defaultSessionsAfterLifecycleStop.map((item) => item.sessionId).join(',') ||
      restoredArchivedSessions[0]?.sessionId !== thirdSession.sessionId ||
      restoredLayout.selectedSessionId !== preloadProbe.templateCreatedSession.sessionId ||
      restoredLayout.sessionView[session.sessionId]?.scrollLine !== 19 ||
      restoredLayout.sessionView[session.sessionId]?.followTail !== false ||
      JSON.stringify(restoredBindings.map(persistedBindingView)) !==
        JSON.stringify(expectedBindings.map(persistedBindingView))
    ) {
      throw new Error('workspace/session order, layout, or bindings did not restore')
    }
    // A dedicated live session on the restarted host, after every restored-state check, so no
    // earlier count, order or receipt value sees it.
    console.error('[ai-terminal] self-test phase: renderer live exit feedback')
    hostClient = client
    hostRendererPort = applicationPort
    trackSessionProcessStates(client)
    const { startup: liveExitCreated } = await createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Live exit shell',
      cwd: isolatedCwd,
      executable: '/bin/bash',
      argv: ['--noprofile', '--norc'],
      cols: 80,
      rows: 24
    }, true)
    await recoverApplicationRenderer(applicationWindow)
    const liveExitRuntime = runtimes.get(liveExitCreated.sessionId)
    if (!liveExitRuntime) throw new Error('the live exit session has no renderer runtime')
    const rendererInverseTextContrast = await inverseTextContrast(applicationWindow, {
      sessionId: liveExitRuntime.session.sessionId,
      attachmentId: liveExitRuntime.attachment.attachmentId,
      name: liveExitRuntime.name
    })
    if (rendererInverseTextContrast < 4.5) {
      throw new Error(`reverse-video terminal text rendered at contrast ${rendererInverseTextContrast.toFixed(2)}, below 4.5`)
    }
    const rendererLiveExitLabel = await liveExitPaneLabel(applicationWindow, {
      sessionId: liveExitRuntime.session.sessionId,
      attachmentId: liveExitRuntime.attachment.attachmentId,
      name: liveExitRuntime.name
    })
    if (rendererLiveExitLabel !== `Process exited · code 23 · ${liveExitRuntime.cwd}`) {
      throw new Error(
        `the live pane did not render the observed exit label: ${JSON.stringify(rendererLiveExitLabel)}`
      )
    }
    console.error('[ai-terminal] self-test phase: renderer recovery after shell exit')
    const exitRecordDeadline = Date.now() + 5_000
    while (
      (await loadWorkspaceStartup(client)).sessions
        .find((item) => item.sessionId === liveExitCreated.sessionId)?.lastProcess?.state !== 'exited'
    ) {
      if (Date.now() >= exitRecordDeadline) throw new Error('the live exit session did not record its exit')
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    const rendererPortBeforeExitRecovery = hostRendererPort
    await recoverApplicationRenderer(applicationWindow)
    if (hostRendererPort === rendererPortBeforeExitRecovery) {
      throw new Error('renderer recovery after a shell exit did not complete')
    }
    if (runtimes.has(liveExitCreated.sessionId)) {
      throw new Error('the exited session is still a renderer runtime after recovery')
    }
    const recoveredExitLabel = await recoveredStoppedLabel(applicationWindow, {
      sessionId: liveExitCreated.sessionId,
      name: liveExitRuntime.name
    })
    if (recoveredExitLabel !== `Process exited · code 23 · ${liveExitRuntime.cwd}`) {
      throw new Error(
        `the recovered workspace did not show the exited session as stopped: ${JSON.stringify(recoveredExitLabel)}`
      )
    }
    const rendererRecoveredAfterShellExit = true
    const secondClose = await client.close()
    console.error('[ai-terminal] self-test phase: second host closed')
    clientClosed = true
    graceful &&= secondClose.graceful
    applicationPort.close()
    applicationPort = undefined

    if (JSON.stringify(restoredHealth.schemaTables) !== JSON.stringify(STORY_SCHEMA_TABLES)) {
      throw new Error(`unexpected database tables: ${restoredHealth.schemaTables.join(',')}`)
    }
    if (
      ready.database.journalMode !== 'wal' ||
      !ready.database.foreignKeys ||
      ready.database.busyTimeoutMs !== 5_000
    ) {
      throw new Error('database worker did not enable WAL, foreign keys, and the busy timeout')
    }

    receipt = {
      selfTest: 'session-roundtrip',
      electronVersion: ready.electronVersion,
      nativeModules: ready.nativeModules,
      markerObserved: true,
      helloHandshake: true,
      streamMessages: observed.sequences.length,
      resized: { cols: 101, rows: 37 },
      detachedProcessSurvived: true,
      workspaceCount: restoredWorkspaces.length,
      sessionCount: restoredHealth.sessionRecords,
      sameCliSameCwdBindings: true,
      locateAndStartNewBindingIsolation: true,
      archivedRunningReachable: true,
      layoutOrderSelectionScrollFollowTailRestored: true,
      rendererRestartNoDuplicateProcesses: true,
      applicationRestartNoAutoStart: true,
      sameDatabaseHostRestart: true,
      supersededHostPidRecorded: typeof supersededHostPid === 'number',
      interruptedIncarnations: restoredHealth.interruptedIncarnations,
      bindingsRestored: restoredBindings.length,
      mainPreloadWorkspaceMethod: preloadProbe.workspaceCount,
      mainPreloadSessionMethod: preloadProbe.sessionMethodSessionId,
      bridgeErrorCodesTyped: preloadProbe.bridgeErrorCodes,
      rendererLaunchUnavailable: preloadProbe.launchUnavailable,
      rendererUnavailableTemplate: preloadProbe.unavailableTemplate,
      rendererStoppedPanelLabel,
      rendererInverseTextContrast,
      rendererLiveExitLabel,
      rendererRecoveredAfterShellExit,
      registeredInvokeChannels: selfTestBridgeInvokeRegistrations.map(({ channel }) => channel),
      envelopedInvokeChannels,
      templateCreatedSession: preloadProbe.templateCreatedSession,
      treeSelectionLayoutPut: preloadProbe.treeSelection,
      hiddenPaneSize: preloadProbe.hiddenPaneSize,
      inactiveFollowingOutputLayoutPuts,
      inactiveFollowingOutputCaptured,
      launchBackgroundChoiceRecorded,
      sessionProcessStatus: { beforeRestart: 'live', afterApplicationRestart: 'interrupted' },
      applicationQuitStoppedSession: {
        beforeRestart: lifecycleStoppedBeforeRestart,
        afterRestart: lifecycleStoppedAfterRestart
      },
      rendererRestarted: true,
      schemaTables: restoredHealth.schemaTables,
      nativeFailureBeforeDatabase: true,
      invalidLaunchesStayedNonLive: true,
      invalidSessionEditStayedUnchanged: true,
      shellEnvironmentSanitized: true
    }
  } catch (error) {
    // Print the reason before release, so a release that stalls cannot hide it.
    reportSelfTestFailure(error)
    throw error
  } finally {
    console.error('[ai-terminal] self-test phase: releasing self-test resources')
    if (applicationWindow && !applicationWindow.isDestroyed()) applicationWindow.destroy()
    applicationWindow = undefined
    if (applicationPort) applicationPort.close()
    if (!clientClosed) {
      const finalClose = await closeWithinDeadline(client, SELF_TEST_RELEASE_CLOSE_DEADLINE_MS)
      graceful &&= finalClose.graceful
    }
    if (hostClient === client) hostClient = undefined
    hostRendererPort = undefined
    runtimes.clear()
    processTracking.unconfirmedExits.clear()
    sessionRecords.clear()
    selfTestRendererLaunchBlockedSessionId = undefined
    selfTestRendererUnavailableTemplate = undefined
  }
  if (!graceful) throw new Error('the real terminal host did not shut down gracefully')
  console.log(JSON.stringify({ ...receipt, graceful }))
}

const selfTest = process.argv.includes('--self-test')
const rendererTestMode = process.argv.includes('--aiterm-test-mode')
ensureDevelopmentRoots()
app.on('will-quit', cleanupDevelopmentRoot)
process.once('exit', cleanupDevelopmentRoot)
const instanceDataRoot = resolveApplicationRoots().data
mkdirSync(instanceDataRoot, { recursive: true, mode: 0o700 })
chmodSync(instanceDataRoot, 0o700)
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

async function flushAllSavedOutput(): Promise<SavedOutputCaptureOutcome> {
  const current = [...runtimes.values()]
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
        console.error(`[ai-terminal] final-capture loss disclosure could not be persisted: ${message}`)
      }
    )
    if (outcome.status === 'unavailable') aggregate = outcome
  }
  return aggregate
}

const applicationLifecycle = createApplicationLifecycle({
  runningTargets,
  saveBackgroundChoice: async (targets, choice) => {
    for (const target of targets) {
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
    const result = applicationWindow && !applicationWindow.isDestroyed()
      ? await dialog.showMessageBox(applicationWindow, {
          type: 'question',
          noLink: true,
          ...choice,
          buttons: [...choice.buttons]
        })
      : await dialog.showMessageBox({
          type: 'question',
          noLink: true,
          ...choice,
          buttons: [...choice.buttons]
        })
    return result.response as 0 | 1 | 2
  },
  promptForQuit: async (choice) => {
    const result = applicationWindow && !applicationWindow.isDestroyed()
      ? await dialog.showMessageBox(applicationWindow, {
          type: 'warning',
          noLink: true,
          ...choice,
          buttons: [...choice.buttons]
        })
      : await dialog.showMessageBox({
          type: 'warning',
          noLink: true,
          ...choice,
          buttons: [...choice.buttons]
        })
    return result.response as 0 | 1
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

if (primaryInstance) installIpcHandlers()
if (primaryInstance) autoUpdater.on('update-downloaded', () => applicationLifecycle.updateDownloaded())

if (primaryInstance) void app.whenReady().then(async () => {
  // The Chancel header replaces Electron's default File/Edit/View/Window bar and its stray
  // accelerators (reload, zoom, close); Quit lives in the command palette. macOS always shows a
  // menu bar, so there it keeps the one menu the system owns, and nothing else.
  Menu.setApplicationMenu(
    process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }]) : null
  )
  restrictWebPermissions()
  if (selfTest) {
    let exitCode = 0
    try {
      await runSelfTest()
    } catch (error) {
      reportSelfTestFailure(error)
      exitCode = 1
    }
    console.error('[ai-terminal] self-test phase: exiting application')
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
    console.error(`[ai-terminal] terminal startup failed: ${failure.message}`)
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
  if (selfTest || runtimes.size > 0 || process.platform === 'darwin') return
  app.quit()
})
