// MODULE: index.ts - Electron main process: windows, bridge IPC, host lifecycle and the self-test driver
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  ERROR_CODES,
  METHOD_REGISTRY,
  isLaunchSetStartParams,
  isTerminalOutputMessage,
  type AgentHistoryStatus,
  type AppSettings,
  type ArtifactRecord,
  type AttentionRecord,
  type BoundConversationBinding,
  type ClosePromptDecision,
  type ClosePromptMode,
  type ClosePromptSession,
  type ExplicitConversationBinding,
  type InputDraftRecord,
  type SessionProcessStatus,
  type InterruptedSessionCohort,
  type LaunchTemplateRecord,
  type LaunchSetStartResult,
  type LayoutGetResult,
  type PersistedConversationBinding,
  type ProgressRecord,
  type ProtocolMethod,
  type SavedOutputCapture,
  type SavedOutputCaptureOutcome,
  type SavedOutputCatalog,
  type SavedOutputSnapshot,
  type SessionCohortOfferedResult,
  type SessionCohortResumeResult,
  type SessionCreateParams,
  type SessionProcessState,
  type SessionRecord,
  type TelegramStatus,
  type SessionStopCause,
  type TerminalOutputMessage,
  type WorkspaceLayoutState,
  type WorkspaceRecord
} from '@bmn/protocol'
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
  shell,
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
  adoptsStartedAttachment,
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
import { runLaunchSetRepositorySelfTest } from './launch-set-repository-self-test'
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
import type { FileReferenceFlowProbe } from '../renderer/src/file-reference-probe'
import type { VoiceFlowProbe } from '../renderer/src/voice-probe'
import { installFileReferenceIpcHandlers } from './file-reference-ipc'
import { createPresenceMonitor, readMutterIdleMs } from './presence-monitor'
import { startFakeBotApi, type FakeBotApi, type FakeBotCall, type FakeBotStep } from './fake-bot-api'
import {
  backupsOf,
  claudeDays,
  historyView,
  prepareHistoryFixture,
  recordedCalls,
  selfTestHistoryEnvironment,
  selfTestHistoryRoots,
  type HistoryFixture
} from './agent-history-self-test'
import { installVoiceIpcHandlers } from './voice-ipc'
import {
  SPEECH_DETECTOR_FILE,
  SPEECH_MODEL_FILE,
  VOICE_MODELS,
  validateWav,
  whisperArguments,
  type transcribeRecording
} from './voice-engine'
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

const EXPECTED_ELECTRON_VERSION = '44.3.0'
const SELF_TEST_TIMEOUT_MS = 15_000
/** The self-test's pages wait this long instead of 15 s, so each card shape costs seconds, not a quarter minute. */
const SELF_TEST_PAGE_AFTER_MS = 2_000

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
/** Self-test only: acknowledgements from the production lifecycle flush, distinct from activity captures. */
const selfTestLifecycleCaptures: Array<{ sessionId: string; status: SavedOutputCaptureOutcome['status'] }> = []
let closePromptCoordinator: ClosePromptCoordinator | undefined
/** Self-test hook: every renderer layout.put request main forwards, counted before the host answers. */
let selfTestLayoutPutRequests = 0
const selfTestLayoutPutSelections: Array<string | null> = []
let selfTestLaunchSetStartRequests = 0
let selfTestLaunchSetReadGate: { entered(): void; released: Promise<void> } | null = null
function pauseNextSelfTestLaunchSetRead(): { entered: Promise<void>; release(): void } {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  selfTestLaunchSetReadGate = { entered: enter, released }
  return { entered, release }
}
let selfTestBridgeInvokeRegistrations: readonly BridgeInvokeRegistration[] = []
/** What the renderer's activity probe hands back for one self-test sampling window. */
interface ActivitySampling {
  samples: {
    at: number
    words: Record<string, string | null>
    titles: Record<string, string | null>
    burstDone: boolean
  }[]
  attentionBefore: number
  attentionAfter: number
  updates: Record<string, number>
  before: Record<string, { cols: number; rows: number; refits: number; inputEvents: number } | null>
  after: Record<string, { cols: number; rows: number; refits: number; inputEvents: number } | null>
  burstBuffer: string
}

/** What the renderer observed while the hook fixture's requests were opened, resolved and listed. */
interface TerminalNoticeProbe {
  openedBy: string | null
  title: string
  body: string | null
  kind: string
  provenance: string
  ptyInputEvents: number
  /** The terminal around a second notice: AC5 says reading one never resizes or retypes anything. */
  aroundSecondNotice: { title: string; openedBy: string; sameSize: boolean; sameElement: boolean; refits: number; inputEvents: number }
  hookedSessionRows: number
  hookedSessionEvents: { agent: string; event: string; effects: string[] }[]
  resolvedState: string
  resolvedBy: string | null
}

interface HookProvenanceProbe {
  answeredByTypingResolvedBy: string | null
  answeredByTypingState: string
  rows: string[]
  events: { event: string; effects: string[]; toolName: string | null }[]
  /** The other live session's own log, read with the same bridge call: each session sees only its own events. */
  otherSessionEvents: { event: string; effects: string[] }[]
  listWroteToPty: boolean
  openRequestsBefore: number
  openRequestsAfter: number
  closed: boolean
}

const SELF_TEST_LAUNCH_DISABLED_REASON =
  'Stored arguments are unavailable in the renderer boundary probe.'
let selfTestRendererLaunchBlockedSessionId: string | undefined
let selfTestRendererUnavailableTemplate: LaunchTemplateRecord | undefined
/** A failed self-test's release may still run after the reason is printed; it waits this long for the host. */
const SELF_TEST_RELEASE_CLOSE_DEADLINE_MS = 5_000
let selfTestFailureReported = false
/** Self-test hook: paths Show in folder received; the automated run never opens a file manager. */
const selfTestShownFileReferences: string[] = []
/** Story 32.2: app notices the self-test records instead of showing. */
const selfTestAppNotices: Array<{ title: string; body: string }> = []
/** Every reference the renderer asked to read during a self-test, in order: hovering and output must add none. */
const selfTestReadFileReferences: Array<{ sessionId: string; reference: string }> = []
/** Self-test hook: each transcription main ran, with the argv the real engine would get; no whisper process runs. */
interface SelfTestTranscription {
  language: string
  vocabulary: string[]
  durationSeconds: number
  args: string[]
}
const selfTestVoiceTranscriptions: SelfTestTranscription[] = []
/** The self-test's stand-in engine and model live in the isolated data folder; the transcript is synthetic. */
function selfTestVoiceFolder(): string {
  return join(resolveApplicationRoots().data, 'voice')
}
const selfTestTranscribe: typeof transcribeRecording = async (options) => {
  const { durationSeconds } = validateWav(options.wav)
  const vocabulary = [...(options.vocabulary ?? [])]
  selfTestVoiceTranscriptions.push({
    language: options.language,
    vocabulary,
    durationSeconds,
    args: whisperArguments({ modelPath: options.modelPath, wavPath: 'recording.wav', language: options.language, durationSeconds, threads: 1, vocabulary })
  })
  return `echo VOICE-PASTE-${selfTestVoiceTranscriptions.length}`
}
const allowedSenders = new Set<number>()
/** The self-test's model transfer is served from memory: the first download holds one chunk open until
 * cancelled, and every later fetch refuses the connection, so no network is touched and the download
 * handler's reservation, cancel and failure paths run for real. */
let selfTestVoiceFetchCalls = 0
const selfTestVoiceFetch = async (_url: string, init: { signal: AbortSignal }): Promise<Response> => {
  selfTestVoiceFetchCalls += 1
  if (selfTestVoiceFetchCalls > 1) throw new TypeError('connection reset')
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_000_000))
      init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
    }
  }))
}
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
  notificationsEnabled: () => !selfTest,
  notifyApp: (notice) => {
    if (selfTest) {
      selfTestAppNotices.push(notice)
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
  return app.isPackaged ? join(process.resourcesPath, 'bin', 'bmn.mjs') : bmnCliPath()
}

/** Sessions get this file's directory on PATH; packaged builds carry a launcher for it under resources/bin. */
function bmnCliPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'bmn')
    : join(app.getAppPath(), 'bin', 'bmn')
}

/** The self-test's Telegram: one local fake Bot API for the whole run, started before the first host. */
const SELF_TEST_TELEGRAM_CHAT_ID = 424242
let selfTestBotApi: Promise<FakeBotApi> | null = null
function selfTestTelegram(): Promise<FakeBotApi> {
  selfTestBotApi ??= startFakeBotApi(SELF_TEST_TELEGRAM_CHAT_ID, SELF_TEST_TELEGRAM_CHAT_ID)
  return selfTestBotApi
}

async function launchHostWithChannel(): Promise<{
  client: PtyHostClient
  ready: HostReady
  applicationPort: MessagePortMain
}> {
  const { hostEntry, repoRoot } = appPaths()
  const environment = process.argv.includes('--self-test')
    ? {
        ...hostEnvironment(repoRoot), ...selfTestHistoryEnvironment(),
        BMN_SELF_TEST_TELEGRAM_ORIGIN: (await selfTestTelegram()).origin,
        BMN_SELF_TEST_PAGE_AFTER_MS: String(SELF_TEST_PAGE_AFTER_MS)
      }
    : hostEnvironment(repoRoot)
  const client = await PtyHostClient.launch(hostEntry, environment, {
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
  closePromptCoordinator = new ClosePromptCoordinator(
    ipcMain,
    (sender) => allowedSenders.has(sender.id) && !sender.isDestroyed()
  )
  const bridgeIpc = bridgeInvokeRegistrar(ipcMain)
  installWorkspaceIpcHandlers(bridgeIpc, senderIsAllowed, {
    client: () => ({
      request: async <Result,>(method: Parameters<PtyHostClient['request']>[0], params: object) => {
        if (selfTest && method === METHOD_REGISTRY.launchSetGet && selfTestLaunchSetReadGate) {
          const gate = selfTestLaunchSetReadGate
          selfTestLaunchSetReadGate = null
          gate.entered()
          await gate.released
        }
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
      directory === '~' || directory.startsWith('~/')
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
    if (selfTest) selfTestLaunchSetStartRequests += 1
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
      if (!record) throw new Error(`Started session ${entry.sessionId} was not persisted`)
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
    dialogsEnabled: () => !selfTest
  })
  installFileReferenceIpcHandlers(bridgeIpc, {
    client: () => {
      const client = requireHostClient()
      if (!selfTest) return client
      return {
        request: <Result>(method: ProtocolMethod, params: object) => {
          if (method === METHOD_REGISTRY.fileReferenceRead) {
            const { sessionId, reference } = params as { sessionId?: unknown; reference?: unknown }
            selfTestReadFileReferences.push({ sessionId: String(sessionId), reference: String(reference) })
          }
          return client.request<Result>(method, params)
        }
      }
    },
    senderIsAllowed,
    // The isolated self-test window is deliberately hidden, so it has no OS focus to report.
    ownerFocused: (event) => selfTest || BrowserWindow.fromWebContents(event.sender)?.isFocused() === true,
    chooseFolder: async (event) => {
      if (selfTest) throw new MainIpcError(ERROR_CODES.invalidArgument, 'File dialogs are unavailable in this run')
      const options = { title: 'Resolve the reference from this folder', properties: ['openDirectory'] as Array<'openDirectory'> }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? null : picked.filePaths[0] ?? null
    },
    showInFolder: (path) => {
      if (selfTest) selfTestShownFileReferences.push(path)
      else shell.showItemInFolder(path)
    }
  })
  const defaultVoiceModelFolder = join(resolveApplicationRoots().data, 'voice', 'models')
  installVoiceIpcHandlers(bridgeIpc, {
    senderIsAllowed,
    binary: selfTest ? join(selfTestVoiceFolder(), 'whisper-cli') : whisperBinaryPath(),
    ...(selfTest ? { transcribe: selfTestTranscribe, fetch: selfTestVoiceFetch } : {}),
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
  bridgeIpc.handle('aiterm:session:resume', async (event, sessionId: unknown) => {
    const id = requireKnownSession(event, sessionId)
    const dimensions = runtimes.get(id)?.dimensions ?? { cols: 80, rows: 24 }
    const resumed = await resumeBoundSession(requireHostClient(), id, dimensions)
    return adoptRestartedRuntime(id, resumed, resumed.binding.launchContext, dimensions)
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
        throw new MainIpcError(ERROR_CODES.notFound, `Session ${entry.sessionId} was not found`)
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
  if (selfTest) console.error('[BMN] renderer recovery: started')
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
    if (selfTest) console.error('[BMN] renderer recovery: startup loaded')
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
      if (selfTest) console.error('[BMN] renderer recovery: sessions reattached')
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
    if (selfTest) console.error('[BMN] renderer recovery: startup posted')
  } catch (error) {
    closeEmptyRuntimeChannel()
    if (selfTest) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[BMN] renderer recovery failed: ${detail}`)
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
  const dataRoot = process.env.BMN_DATA_HOME
  if (!dataRoot) throw new Error('self-test requires BMN_DATA_HOME')
  const databasePath = join(dataRoot, 'state.sqlite3')
  const child = utilityProcess.fork(hostEntry, ['--native-failure-self-test'], {
    serviceName: 'pty-host-native-failure',
    stdio: 'pipe',
    env: {
      ...hostEnvironment(repoRoot),
      BMN_TEST_FAIL_NATIVE: 'node-pty'
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
  crossWorkspaceSplit: {
    layoutWorkspaceId: string
    sourceWorkspaceId: string
    paneSessionIds: string[]
    selectedAfterFocus: string | null
    sourceWorkspaceArchived: boolean
    foreignPaneRemovedAfterArchive: boolean
  }
  /** Epic 11: each pane's marker comes from its own workspace, and choosing one moves no geometry. */
  workspaceMarkers: {
    before: {
      localPane: string | null
      foreignPane: string | null
      grid: { cols: number; rows: number }
      localHeading: number
      foreignHeading: number
    }
    foreignPaneAfterLocalChoice: string | null
    localPane: string | null
    foreignPane: string | null
    localSidebar: string | null
    foreignSidebar: string | null
    foreignPaneLabel: string | null
    storedRevisions: { local: number; foreign: number }
    grid: { cols: number; rows: number }
    localHeading: number
    foreignHeading: number
  }
  /** Epic 12.2: the detail's words, that it wrote nothing and resized nothing, and both ways in. */
  progressEvidenceSurface: {
    reportedStrip: string
    bareStrip: string
    dialog: {
      title: string
      note: string
      provenance: string
      rowName: string
      rowAvailability: string
      previewText: string
    }
    quiet: {
      inputEventsBefore: number
      inputEventsAfter: number
      surfaceHeightBefore: number
      surfaceHeightWhileOpen: number
      surfaceHeightAfter: number
      gridBefore: { cols: number; rows: number }
      gridAfter: { cols: number; rows: number }
    }
    colours: {
      verifiedInk: string
      verifiedToken: string
      failedInk: string
      errorToken: string
      evidenceInk: string
      mutedToken: string
      verifiedContrast: number
      evidenceContrast: number
    }
    focusReturnedToStrip: boolean
    focusReturnedToMenuButton: boolean
    openedFromPaneMenu: boolean
    bareDialog: { title: string; body: string }
  }
  hiddenPaneSize: { shown: { cols: number; rows: number }; hidden: { cols: number; rows: number } }
  attentionTriage: {
    responseTitles: string[]
    responseTitlesAfterUpdate: string[]
    remainingResponseTitles: string[]
    updateTitles: string[]
    updatedUpdateTitles: string[]
    totalCount: number
    progressText: string
    detailsProgressText: string
    keyboardTargetSessionId: string
    noticeResolved: boolean
    focusReturned: boolean
    focusStableAfterIncomingUpdate: boolean
    firstResponseRow: { age: string; label: string }
    staleNoticeRejected?: boolean
    revisedPromptPreserved?: boolean
    unavailableTargetIgnored?: boolean
  }
  handoffFlow: {
    draftId: string
    targetSessionId: string
    editedText: string
    fileName: string
    acceptedState: string
    existingInputPreserved: boolean
    payloadOccurrences: number
    attentionResponsesPreserved: boolean
    discardedDraftHidden: boolean
  }
  fileReferenceFlow: FileReferenceFlowProbe
  voiceFlow: VoiceFlowProbe
}

/**
 * Clicks Resume on a stopped, bound session and reads what the owner is actually shown before
 * anything starts, then cancels. The caller checks that nothing was launched.
 */
async function resumeConfirmationShown(
  window: BrowserWindow,
  session: { sessionId: string; name: string },
  restoreSelectionTo: string
): Promise<{ command: string; note: string | null }> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      let selected = false;
      let clicked = false;
      const treeButton = (id) => [...document.querySelectorAll('.session-row > button[data-session-id]')]
        .find((candidate) => candidate.dataset.sessionId === id);
      const probe = () => {
        const button = treeButton(${JSON.stringify(session.sessionId)});
        if (!button) {
          reject(new Error('the bound session tree button was not rendered'));
          return;
        }
        if (!selected) {
          selected = true;
          button.click();
          setTimeout(probe, 25);
          return;
        }
        // The panel is shared, so wait for it to be this session's before touching its buttons.
        const shown = document.querySelector('.stopped-session h2')?.textContent?.trim();
        if (shown !== ${JSON.stringify(session.name)}) {
          if (Date.now() >= deadline) reject(new Error('the bound session panel never appeared: ' + shown));
          else setTimeout(probe, 25);
          return;
        }
        if (!clicked) {
          const resume = [...document.querySelectorAll('.stopped-session .actions button')]
            .find((candidate) => candidate.textContent.trim() === 'Resume');
          if (resume) {
            clicked = true;
            resume.click();
          }
          setTimeout(probe, 25);
          return;
        }
        const command = document.querySelector('dialog[open] .resume-command')?.textContent ?? null;
        if (command) {
          const note = document.querySelector('dialog[open] .dialog-note')?.textContent?.trim() ?? null;
          const cancel = [...document.querySelectorAll('dialog[open] .dialog-actions button')]
            .find((candidate) => candidate.textContent.trim() === 'Cancel');
          if (!cancel) {
            reject(new Error('the Resume confirmation offered no way out'));
            return;
          }
          cancel.click();
          // Leave the selection where this phase found it, so the persisted layout is unchanged.
          treeButton(${JSON.stringify(restoreSelectionTo)})?.click();
          resolve({ command, note });
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('the Resume confirmation did not show a command: ' + JSON.stringify({
            selected,
            clicked,
            actions: [...document.querySelectorAll('.stopped-session .actions button')]
              .map((candidate) => candidate.textContent.trim()),
            dialog: document.querySelector('dialog[open]')?.textContent?.trim() ?? null,
            feedback: document.querySelector('.feedback-notice')?.textContent?.trim() ?? null
          })));
        } else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<{ command: string; note: string | null }>
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
        else if (Date.now() >= deadline) reject(new Error('the stopped session label was not rendered: ' + JSON.stringify({
          selected,
          panel: document.querySelector('.stopped-session')?.textContent?.trim() ?? null,
          feedback: document.querySelector('.feedback-notice')?.textContent?.trim() ?? null,
          visiblePanes: [...document.querySelectorAll('.session-terminal:not(.session-terminal-hidden)')]
            .map((pane) => pane.getAttribute('data-session-id'))
        })));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<string>
}

async function stoppedPanelProgress(window: BrowserWindow, sessionId: string): Promise<string> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      let selected = false;
      const probe = () => {
        const button = [...document.querySelectorAll('.session-row > button[data-session-id]')]
          .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(sessionId)});
        if (!button) {
          reject(new Error('the stopped progress session tree button was not rendered'));
          return;
        }
        if (!selected) {
          selected = true;
          button.click();
        }
        const text = document.querySelector('.stopped-session .progress-strip')?.textContent?.trim();
        if (text) resolve(text);
        else if (Date.now() >= deadline) reject(new Error('the stopped progress summary was not rendered'));
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
  live: { attachmentId: string; name: string }
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
          // Every live pane activated when it mounted, so the attachment already carries input both ways.
          window.aiTerminal.sendTerminalInput(
            ${JSON.stringify(live.attachmentId)},
            new TextEncoder().encode(${JSON.stringify('exit 23\r')})
          );
        }
        // A live pane now says what it observes (Running, Working, Idle); only the exit ends this wait.
        if (label && (label.startsWith('Process exited') || label.startsWith('Interrupted'))) resolve(label);
        else if (Date.now() >= deadline) reject(new Error('the live pane header did not show the exit: ' + label));
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
/**
 * The word the sidebar row shows for a session, once it stops saying `Running`. The pane heading and
 * the row read the same process from different state, and only the row went stale when a process
 * ended on its own.
 */
async function sidebarSessionWord(
  window: BrowserWindow,
  session: { sessionId: string }
): Promise<string> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const probe = () => {
        const button = [...document.querySelectorAll('.session-row > button[data-session-id]')]
          .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(session.sessionId)});
        const word = button?.querySelector('.session-state')?.textContent?.trim();
        if (word && word !== 'Running' && word !== 'Working' && word !== 'Idle') resolve(word);
        else if (Date.now() >= deadline) reject(new Error('the sidebar row still reads ' + word + ' for an ended process'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<string>
}

/**
 * Reads the in-app close question the way the owner meets it, then cancels it. Returns what the
 * dialog said, so the self-test can prove the window -- not a native box -- asked, and that the
 * answer travelled back.
 */
async function closePromptDialogText(window: BrowserWindow): Promise<{
  heading: string
  summary: string
  rows: string[]
}> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const probe = () => {
        const dialog = document.querySelector('dialog.close-sessions[open]');
        if (dialog) {
          const read = {
            heading: dialog.querySelector('.app-dialog-heading h2')?.textContent?.trim() ?? '',
            summary: dialog.querySelector('.close-sessions-summary')?.textContent?.trim() ?? '',
            rows: [...dialog.querySelectorAll('.close-sessions-list li')].map((row) => row.textContent.trim())
          };
          const cancel = [...dialog.querySelectorAll('.dialog-actions button')]
            .find((button) => button.textContent.trim() === 'Cancel');
          if (!cancel) { reject(new Error('the close prompt has no Cancel')); return; }
          cancel.click();
          resolve(read);
        } else if (Date.now() >= deadline) reject(new Error('the window never showed the close prompt'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<{ heading: string; summary: string; rows: string[] }>
}

/** What the resume-after-stop offer says, without answering it. */
interface ResumeOfferReading {
  heading: string
  summary: string
  rows: Array<{ name: string; command: string; checked: boolean; outcome: string }>
  button: string
}

const RESUME_OFFER_READER = `(dialog) => ({
  heading: dialog.querySelector('.app-dialog-heading h2')?.textContent?.trim() ?? '',
  summary: dialog.querySelector('.resume-interrupted-summary')?.textContent?.trim() ?? '',
  rows: [...dialog.querySelectorAll('.resume-interrupted-list li')].map((row) => ({
    name: row.querySelector('.name')?.textContent?.trim() ?? '',
    command: row.querySelector('.command code')?.textContent?.trim() ?? '',
    checked: row.querySelector('input[type=checkbox]')?.checked === true,
    outcome: row.querySelector('.outcome')?.textContent?.trim() ?? ''
  })),
  button: [...dialog.querySelectorAll('.dialog-actions button')]
    .map((button) => button.textContent.trim())
    .find((label) => label.startsWith('Resume ')) ?? ''
})`

async function resumeOfferShown(
  window: BrowserWindow,
  timeoutMs = 10_000
): Promise<ResumeOfferReading> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + ${timeoutMs};
      const read = ${RESUME_OFFER_READER};
      const probe = () => {
        const dialog = document.querySelector('dialog.resume-interrupted[open]');
        if (dialog) resolve(read(dialog));
        else if (Date.now() >= deadline) reject(new Error('the window never offered to resume the stopped sessions'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<ResumeOfferReading>
}

/** True when the offer stays away for the whole window; used where asking again would be wrong. */
async function resumeOfferStaysAway(window: BrowserWindow, forMs: number): Promise<boolean> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const deadline = Date.now() + ${forMs};
      const probe = () => {
        if (document.querySelector('dialog.resume-interrupted[open]')) resolve(false);
        else if (Date.now() >= deadline) resolve(true);
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<boolean>
}

/** Presses the offer's one button and reads every row back once the action has settled. */
async function pressResumeOffer(window: BrowserWindow): Promise<ResumeOfferReading> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const read = ${RESUME_OFFER_READER};
      let pressed = false;
      const probe = () => {
        const dialog = document.querySelector('dialog.resume-interrupted[open]');
        if (!dialog) {
          if (Date.now() >= deadline) reject(new Error('the resume offer closed before it was answered'));
          else setTimeout(probe, 25);
          return;
        }
        const button = [...dialog.querySelectorAll('.dialog-actions button')]
          .find((candidate) => candidate.textContent.trim().startsWith('Resume '));
        if (!pressed) {
          if (!button) { reject(new Error('the resume offer has no button')); return; }
          pressed = true;
          button.click();
          setTimeout(probe, 25);
          return;
        }
        const current = read(dialog);
        if (current.rows.every((row) => row.outcome !== '')) { resolve(current); return; }
        if (Date.now() >= deadline) reject(new Error('the resume offer never reported its rows: ' + JSON.stringify(current)));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<ResumeOfferReading>
}

/** Closes the offer the way the owner would, and says whether it went. */
async function closeResumeOffer(window: BrowserWindow): Promise<boolean> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      let clicked = false;
      const probe = () => {
        const dialog = document.querySelector('dialog.resume-interrupted[open]');
        if (!dialog) { resolve(clicked); return; }
        if (!clicked) {
          const close = [...dialog.querySelectorAll('.dialog-actions button')]
            .find((candidate) => ['Cancel', 'Close'].includes(candidate.textContent.trim()));
          if (!close) { reject(new Error('the resume offer has no way out')); return; }
          clicked = true;
          close.click();
        }
        if (Date.now() >= deadline) reject(new Error('the resume offer would not close'));
        else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<boolean>
}

/**
 * Runs one palette command by its label, the way the owner reaches it. A command the palette does
 * not offer — `filterCommands` drops a disabled one — comes back as `missing`, with the palette
 * closed again, so a test can assert either outcome.
 */
async function runPaletteCommand(
  window: BrowserWindow,
  label: string
): Promise<'ran' | 'missing'> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const settleMs = 1500;
      let opened = 0;
      const probe = () => {
        const palette = document.querySelector('dialog.command-palette[open]');
        if (!palette) {
          if (opened > 0) { resolve('missing'); return; }
          const paletteButton = document.querySelector('button[aria-label="Command palette"]');
          if (!paletteButton) { reject(new Error('the palette button is not rendered')); return; }
          opened = Date.now();
          paletteButton.click();
          setTimeout(probe, 25);
          return;
        }
        const option = [...palette.querySelectorAll('li[role=option]')]
          .find((candidate) => candidate.textContent.trim().startsWith(${JSON.stringify(label)}));
        if (option) { option.click(); resolve('ran'); return; }
        if (Date.now() - opened >= settleMs) {
          palette.dispatchEvent(new Event('cancel', { cancelable: true }));
          const close = palette.querySelector('.app-dialog-heading .icon-button');
          if (close) close.click();
          setTimeout(() => resolve('missing'), 25);
          return;
        }
        setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<'ran' | 'missing'>
}

/** The text a paste must carry into the program, chosen so it cannot appear in ordinary output. */
const MODE_PASTE_TEXT = 'MODE-PASTE-PAYLOAD'

/** What one pane's view believes the program's modes are, read from the view itself. */
async function terminalViewModes(
  window: BrowserWindow,
  sessionId: string,
  waitForThem: boolean
): Promise<{
  bracketedPasteMode: boolean
  sendFocusMode: boolean
  mouseTrackingMode: string
  wraparoundMode: boolean
}> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const probe = () => {
        const hook = window.__aitermTest;
        let modes;
        try { modes = hook?.snapshot(${JSON.stringify(sessionId)})?.modes; } catch { modes = undefined; }
        const settled = modes && (!${waitForThem ? 'true' : 'false'} ||
          (modes.bracketedPasteMode && modes.sendFocusMode && modes.mouseTrackingMode !== 'none' &&
            !modes.wraparoundMode));
        if (settled) { resolve(modes); return; }
        if (Date.now() >= deadline) {
          if (modes) resolve(modes);
          else reject(new Error('the mode session has no view to read'));
          return;
        }
        setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<{
    bracketedPasteMode: boolean
    sendFocusMode: boolean
    mouseTrackingMode: string
    wraparoundMode: boolean
  }>
}

/**
 * Drives the two things the modes change: one paste through the app's own clipboard command, and
 * one focus change on the pane. Both go the way the owner's keyboard and mouse would.
 */
async function driveModeSensitiveInput(
  window: BrowserWindow,
  sessionId: string,
  text: string
): Promise<{ clipboard: string; ptyWrites: number; notice: string }> {
  return window.webContents.executeJavaScript(`
    (async () => {
      const wait = async (probe, what) => {
        const deadline = Date.now() + 8000;
        for (;;) {
          const value = probe();
          if (value) return value;
          if (Date.now() >= deadline) throw new Error('terminal modes: ' + what);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      const row = await wait(
        () => [...document.querySelectorAll('.session-row > button[data-session-id]')]
          .find((candidate) => candidate.dataset.sessionId === ${JSON.stringify(sessionId)}),
        'the session row'
      );
      row.click();
      // The paste must land in this program's pane, not whichever pane happens to be first.
      const pane = await wait(
        () => document.querySelector('.session-terminal[data-session-id=' +
          JSON.stringify(${JSON.stringify(sessionId)}) + ']:not(.session-terminal-hidden)'),
        'the mode session pane'
      );
      const textarea = await wait(
        () => pane.querySelector('.terminal-surface .xterm-helper-textarea'),
        'the terminal textarea'
      );
      await window.aiTerminal.writeClipboardText(${JSON.stringify(text)});
      const clipboard = (await window.aiTerminal.readClipboardText()).text;
      const inputsBefore = window.__aitermTest.snapshot(${JSON.stringify(sessionId)}).inputEvents;
      textarea.focus();
      // Ctrl+V is the app's own paste command; xterm brackets it only if the program asked it to.
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true
      }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      // One focus change: out and back, so the program sees a report whichever way it started.
      // The self-test window is never shown, so Chromium gives it no focus of its own and moving the
      // caret raises no focus event; the events are raised here instead, on the same textarea and
      // through the same listeners the owner's click would reach.
      textarea.blur();
      textarea.dispatchEvent(new FocusEvent('blur'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      textarea.focus();
      textarea.dispatchEvent(new FocusEvent('focus'));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return {
        clipboard,
        ptyWrites: window.__aitermTest.snapshot(${JSON.stringify(sessionId)}).inputEvents - inputsBefore,
        notice: document.querySelector('.app-notice, .app-failure')?.textContent?.trim() ?? ''
      };
    })()
  `) as Promise<{ clipboard: string; ptyWrites: number; notice: string }>
}

async function untilModeProgramRead(input: string, before: string): Promise<string> {
  const deadline = Date.now() + 8_000
  let latest = before
  while (Date.now() < deadline) {
    latest = terminalModeProgramInput(input)
    if (latest.length > before.length) return latest.slice(before.length)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return latest.slice(before.length)
}

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
      setTimeout(() => reject(new Error('renderer integration main-process timeout')), 60_000))
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
  console.error(`[BMN] session self-test failed: ${message}`)
}

/** Resume checks that a Codex rollout exists, so the self-test gives the host its own CODEX_HOME. */
function selfTestCodexHome(): string {
  const home = join(process.env.BMN_STATE_HOME ?? '', 'codex-home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return home
}

/**
 * A synthetic Codex harness: it records the arguments it was started with and reports the
 * conversation it is in through the real `bmn hook codex`, exactly as the installed CLI's
 * SessionStart hook does. It keeps running so its session stays live.
 */
function writeCodexHarness(
  directory: string,
  reference: string
): { executable: string; log: string; listing: string } {
  mkdirSync(directory, { recursive: true })
  const log = join(directory, 'argv.log')
  const listing = join(directory, 'list.json')
  const executable = join(directory, 'codex')
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { spawnSync } = require('node:child_process')",
      "const { appendFileSync, writeFileSync } = require('node:fs')",
      "const event = JSON.stringify({",
      "  hook_event_name: 'SessionStart',",
      "  source: 'startup',",
      `  session_id: ${JSON.stringify(reference)},`,
      "})",
      "spawnSync('bmn', ['hook', 'codex'], { input: event, stdio: ['pipe', 'ignore', 'ignore'] })",
      // The session reads its own listing back with its own token, the way an agent would.
      "const listed = spawnSync('bmn', ['list', '--json'], { encoding: 'utf8' })",
      `writeFileSync(${JSON.stringify(listing)}, listed.stdout ?? '')`,
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      "process.stdout.write('codex harness ready\\n')",
      "setInterval(() => undefined, 1_000)",
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, log, listing }
}

/** Gated real-CLI fixture: every step finishes before its receipt is published. */
function writeAcceptanceHarness(directory: string, name: string, steps: string[]): string {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  const executable = join(directory, name)
  writeFileSync(executable, [
    `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
    "const { spawnSync } = require('node:child_process')",
    "const { existsSync, appendFileSync, writeFileSync } = require('node:fs')",
    `const directory = ${JSON.stringify(directory)}`,
    "const file = (name) => directory + '/' + name",
    "const wait = async (name) => { while (!existsSync(file(name))) await new Promise(r => setTimeout(r, 25)) }",
    "const cli = (args, input) => { const r = spawnSync('bmn', args, { input, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout }",
    "appendFileSync(file('argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n')",
    "setInterval(() => undefined, 1000)",
    ";(async () => {", ...steps,
    "})().catch(error => writeFileSync(file('error'), String(error)))", ''
  ].join('\n'), { mode: 0o700 })
  return executable
}

/**
 * Epic 29 stand-in Claude, typed into a shell the way the owner runs agents, so its chip reads
 * "Shell" until its own hooks report: gate `fire-N` carries one scenario (base URL, model, event)
 * and the real `bmn hook claude` runs under exactly that environment. A resumed run skips gates
 * already `done-N`, so after a restart it waits for the next gate instead of replaying old ones.
 */
function writeOriginHarness(directory: string): string {
  return writeAcceptanceHarness(directory, 'origin-agent', [
    "for (let n = 0; ; n++) {",
    "  if (existsSync(file('done-' + n))) continue",
    "  await wait('fire-' + n)",
    "  const scenario = JSON.parse(require('node:fs').readFileSync(file('fire-' + n), 'utf8'))",
    "  const env = { ...process.env }",
    "  if (scenario.baseUrl === null) delete env.ANTHROPIC_BASE_URL; else env.ANTHROPIC_BASE_URL = scenario.baseUrl",
    "  if (scenario.configDir) env.CLAUDE_CONFIG_DIR = scenario.configDir",
    "  const payload = scenario.event === 'SessionStart' ? { hook_event_name: 'SessionStart', source: 'startup' }",
    "    : { hook_event_name: scenario.event, tool_name: 'Bash', tool_input: { command: 'origin-' + n }, tool_response: { output: 'fixture' } }",
    "  if (scenario.model !== null) payload.model = scenario.model",
    "  const result = spawnSync('bmn', ['hook', 'claude'], { input: JSON.stringify(payload), env, encoding: 'utf8' })",
    "  writeFileSync(file('done-' + n), String(result.status))",
    "}"
  ])
}

/**
 * Epic 30.2 stand-in agent. Each gate `fire-<scenario>` makes it draw one recorded dialog in raw mode,
 * report it through the real `bmn hook`, and log every byte the terminal sends it, so the self-test
 * proves exactly which keys a phone answer wrote. After the keys it reports the answer the way the
 * harness does (`PostToolUse`), except Claude's deny, which reports nothing.
 */
function writeRemoteAnswerHarness(directory: string, fixtures: string): string {
  return writeAcceptanceHarness(directory, 'remote-agent', [
    "const fs = require('node:fs')",
    `const fixtures = ${JSON.stringify(fixtures)}`,
    "const read = (name) => JSON.parse(fs.readFileSync(fixtures + '/' + name, 'utf8'))",
    "const screen = (name) => fs.readFileSync(fixtures + '/screens/' + name, 'utf8').replace(/\\s+$/, '').split('\\n')",
    "let current = ['']",
    "const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + current.slice(-(process.stdout.rows || 24)).join('\\r\\n'))",
    "process.stdout.on('resize', draw)",
    "const show = (name) => { current = name ? screen(name) : ['']; draw() }",
    "const hook = (agent, name, patch) => spawnSync('bmn', ['hook', agent], { input: JSON.stringify({ ...read(name), ...patch }), encoding: 'utf8' }).status",
    "const queue = []",
    "let waiter = null",
    "process.stdin.setRawMode(true)",
    "process.stdin.on('data', (chunk) => {",
    "  const text = chunk.toString('utf8')",
    "  appendFileSync(file('keys.log'), JSON.stringify(text) + '\\n')",
    "  for (const key of text) { if (waiter) { const next = waiter; waiter = null; next(key) } else queue.push(key) }",
    "})",
    "const keys = []",
    "const take = async () => { const key = queue.length ? queue.shift() : await new Promise((resolve) => { waiter = resolve }); keys.push(key); return key }",
    // Epic 31.4: a key is one character, or an arrow's escape sequence.
    "const takeKey = async () => { const key = await take(); return key === '\\x1b' ? key + await take() + await take() : key }",
    "const DOWN = '\\x1b[B'",
    // Claude's dialog as the spike recorded it: ticks, a typed-entry row, Next/Submit, then the review.
    "const claudeAsk = async (questions) => {",
    "  const answers = {}",
    "  for (const [q, Q] of questions.entries()) {",
    "    const n = Q.options.length",
    "    let cursor = 0, other = null, otherTicked = false, order = []",
    "    const tabs = '←  ' + questions.map((x, i) => (i < q ? '☒ ' : '☐ ') + x.header).join('  ') + '  ✔ Submit  →'",
    "    const box = (on) => (Q.multiSelect ? '[' + (on ? '✔' : ' ') + '] ' : '')",
    "    const render = () => { current = [tabs, Q.question,",
    "      ...Q.options.flatMap((o, i) => [(cursor === i ? '❯' : ' ') + ' ' + (i + 1) + '. ' + box(order.includes(i)) + o.label, '     ' + o.description]),",
    "      (cursor === n ? '❯' : ' ') + ' ' + (n + 1) + '. ' + box(otherTicked) + (other ?? (Q.multiSelect ? 'Type something' : 'Type something.')),",
    "      ...(Q.multiSelect ? [(cursor === n + 1 ? '❯' : ' ') + '    ' + (q === questions.length - 1 ? 'Submit' : 'Next')] : []),",
    "      '────────────────────────────────────────', '  ' + (n + 2) + '. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel']; draw() }",
    "    render()",
    "    for (;;) {",
    "      const key = await takeKey()",
    "      if (key === DOWN) { cursor = Math.min(cursor + 1, Q.multiSelect ? n + 1 : n); render(); continue }",
    "      if (key === '\\r') { if (Q.multiSelect ? cursor === n + 1 : cursor === n && other !== null) break; continue }",
    // With the cursor on the typed-entry row every key is text, digits included.
    "      if (cursor === n) { other = (other ?? '') + key; otherTicked = true; render(); continue }",
    "      if (!/^\\d$/.test(key)) continue",
    "      const digit = Number(key)",
    "      if (!Q.multiSelect && digit <= n) { answers[Q.question] = Q.options[digit - 1].label; break }",
    "      if (digit === n + 1) { if (Q.multiSelect) otherTicked = !otherTicked; else cursor = n; render(); continue }",
    "      if (digit <= n) { order = order.includes(digit - 1) ? order.filter((x) => x !== digit - 1) : [...order, digit - 1]; render() }",
    "    }",
    // Claude reports a multi-select answer in the order the boxes were ticked, typed text last.
    "    if (!(Q.question in answers)) answers[Q.question] = Q.multiSelect",
    "      ? [...order.map((i) => Q.options[i].label), ...(otherTicked && other ? [other] : [])].join(', ') : other",
    "  }",
    "  if (questions.length > 1 || questions.some((Q) => Q.multiSelect)) {",
    "    current = ['Review your answers', ...questions.flatMap((Q) => [' ● ' + Q.question, '   → ' + answers[Q.question]]),",
    "      'Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel']; draw()",
    "    if (await takeKey() !== '1') return null",
    "  }",
    "  show(null)",
    "  return answers",
    "}",
    // Codex's picker: every question ends with None of the above, whose notes Tab opens.
    "const codexAsk = async (Q) => {",
    "  const n = Q.options.length",
    "  let cursor = 0, notes = null",
    "  const render = () => { current = ['  Question 1/1 (1 unanswered)', '  ' + Q.question,",
    "    ...Q.options.map((o, i) => '  ' + (cursor === i ? '›' : ' ') + ' ' + (i + 1) + '. ' + o.label.padEnd(18) + o.description),",
    "    '  ' + (cursor === n ? '›' : ' ') + ' ' + (n + 1) + '. None of the above  Optionally, add details in notes (tab)',",
    "    ...(notes === null ? [] : ['  › ' + (notes || 'Add notes')]), '', '  tab to add notes | enter to submit answer']; draw() }",
    "  render()",
    "  for (;;) {",
    "    const key = await takeKey()",
    "    if (notes !== null && key !== '\\r') { notes += key; render(); continue }",
    "    if (key === DOWN) { cursor = Math.min(cursor + 1, n); render(); continue }",
    "    if (key === '\\t' && cursor === n) { notes = ''; render(); continue }",
    "    if (key === '\\r') { show(null); return cursor === n ? ['None of the above', ...(notes ? ['user_note: ' + notes] : [])] : [Q.options[cursor].label] }",
    "    if (/^\\d$/.test(key)) { show(null); return [Q.options[Number(key) - 1].label] }",
    "  }",
    "}",
    "for (const scenario of ['single', 'three', 'codex', 'off', 'allow', 'deny', 'card', 'claude-more', 'codex-other', 'opencode-more', 'secret-ask']) {",
    "  await wait('fire-' + scenario)",
    "  keys.length = 0",
    "  if (scenario === 'single') {",
    "    const ask = read('claude/ask-single.pre-tool-use.json')",
    "    show('claude-single-200.txt'); hook('claude', 'claude/ask-single.pre-tool-use.json')",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    const question = ask.tool_input.questions[0]",
    "    const label = question.options[Number(await take()) - 1].label",
    "    show(null)",
    "    hook('claude', 'claude/ask-single.post-tool-use.json', { tool_use_id: ask.tool_use_id, tool_response: { answers: { [question.question]: label } } })",
    "  } else if (scenario === 'three' || scenario === 'card') {",
    "    const ask = read('claude/ask-three.pre-tool-use.json')",
    "    show('claude-three-step1.txt'); hook('claude', 'claude/ask-three.pre-tool-use.json')",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    const answers = {}",
    "    for (const [index, next] of ['claude-three-step2.txt', 'claude-three-step3.txt', 'claude-three-review.txt'].entries()) {",
    "      const question = ask.tool_input.questions[index]",
    "      answers[question.question] = question.options[Number(await take()) - 1].label",
    "      show(next)",
    "    }",
    "    if (await take() === '1') { show(null); hook('claude', 'claude/ask-three.post-tool-use.json', { tool_use_id: ask.tool_use_id, tool_response: { answers } }) }",
    "  } else if (scenario === 'codex') {",
    "    const ask = read('codex/ask-two.pre-tool-use.json')",
    "    show('codex-two-step1.txt'); hook('codex', 'codex/ask-two.pre-tool-use.json')",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    const byId = {}",
    "    for (const [index, next] of ['codex-two-step2.txt', null].entries()) {",
    "      const question = ask.tool_input.questions[index]",
    "      byId[question.id] = { answers: [question.options[Number(await take()) - 1].label] }",
    "      show(next)",
    "    }",
    "    hook('codex', 'codex/ask-two.post-tool-use.json', { tool_use_id: ask.tool_use_id, tool_response: JSON.stringify({ answers: byId }) })",
    "  } else if (scenario === 'claude-more') {",
    "    const questions = [",
    "      { question: 'Which auth method should the API use?', header: 'Auth', multiSelect: false,",
    "        options: [{ label: 'JWT', description: 'Stateless tokens' }, { label: 'Sessions', description: 'Server-side cookies' }] },",
    "      { question: 'Which features should the first release include?', header: 'Features', multiSelect: true,",
    "        options: [{ label: 'Rate limiting', description: 'Per-key caps' }, { label: 'Audit log', description: 'Admin actions' },",
    "          { label: 'Webhooks', description: 'Notify services' }] }",
    "    ]",
    "    show(null); hook('claude', 'claude/ask-single.pre-tool-use.json', { tool_use_id: 'toolu_selftest_more', tool_input: { questions } })",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    const answers = await claudeAsk(questions)",
    "    if (answers) hook('claude', 'claude/ask-single.post-tool-use.json', { tool_use_id: 'toolu_selftest_more', tool_input: { questions }, tool_response: { questions, answers } })",
    "  } else if (scenario === 'codex-other') {",
    "    const questions = [{ id: 'auth', header: 'Auth', question: 'Which auth method should the API use?',",
    "      options: [{ label: 'JWT', description: 'Stateless tokens' }, { label: 'Sessions', description: 'Server-side cookies' }] }]",
    "    show(null); hook('codex', 'codex/ask-single.pre-tool-use.json', { tool_use_id: 'call_selftest_other', tool_input: { questions } })",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    const answers = await codexAsk(questions[0])",
    "    hook('codex', 'codex/ask-single.post-tool-use.json', { tool_use_id: 'call_selftest_other', tool_input: { questions },",
    "      tool_response: JSON.stringify({ answers: { auth: { answers } } }) })",
    "  } else if (scenario === 'opencode-more') {",
    // OpenCode is answered through its plugin, which this stand-in plays: it asks, collects BMN's answer, replies.
    "    const asked = read('opencode/question.asked.multiple.json')",
    "    const requestRef = 'que_0e4a19711001SelfTestMore1'",
    "    const questions = [asked.questions[0], { ...asked.questions[1], custom: false }]",
    "    show(null); hook('opencode', 'opencode/question.asked.multiple.json', { id: requestRef, questions })",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    let taken = null",
    "    for (let attempt = 0; attempt < 6 && !taken; attempt++) {",
    "      taken = (JSON.parse(cli(['answer', 'take', '--wait', '10', '--json'])).answers ?? []).find((answer) => answer.requestRef === requestRef) ?? null",
    "    }",
    "    if (taken) {",
    "      keys.push(JSON.stringify(taken.answers))",
    "      hook('opencode', 'opencode/question.replied.multiple-typed.json', { requestID: requestRef, sessionID: asked.sessionID, answers: taken.answers })",
    "      cli(['answer', 'take', '--wait', '0', '--reported', requestRef + '=ok', '--json'])",
    "    }",
    // Story 34.2: a plain `bmn ask` whose body quotes a synthetic key, withdrawn once its card has been checked.
    "  } else if (scenario === 'secret-ask') {",
    "    cli(['ask', 'secret-ask', 'Commit the key I found?', '--body', 'Should I commit ' + 'sk-ant-api03-' + 'SelfTestSyntheticKey_0123456789 to the repo?'])",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    await wait('fire-secret-ask-close')",
    "    cli(['withdraw', 'secret-ask'])",
    "  } else {",
    "    show('claude-bash-permission.txt'); hook('claude', 'claude/bash.permission-request.json')",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    if (scenario === 'allow' && await take() === '1') { show(null); hook('claude', 'claude/bash.post-tool-use.json') }",
    "    if (scenario === 'deny' && await take() === '3') show('claude-bash-denied.txt')",
    "  }",
    "  writeFileSync(file('done-' + scenario), JSON.stringify(keys))",
    "}"
  ])
}

interface OriginProbe {
  rowChip: string | null
  rowFlag: string | null
  rowLabel: string | null
  paneChip: string | null
  paneFlag: string | null
  paneLabel: string | null
  inspectorChip: string | null
  inspectorFlag: string | null
  modelRow: string | null
  modelTitle: string | null
}

/**
 * Reads the origin flag where the owner sees it: the sidebar row, the pane heading, and Session
 * details' header and Model row. It selects the session and opens details itself, and waits until
 * `until` (the Model row text, or null for "no Model row") holds before reading anything.
 */
async function modelOriginProbe(
  window: BrowserWindow, sessionId: string, name: string, until: string | null
): Promise<OriginProbe> {
  return window.webContents.executeJavaScript(`(async () => {
    const wait = async (read, label) => { const end = Date.now() + 10000; while (Date.now() < end) {
      const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
    } throw new Error('model origin probe timed out: ' + label); };
    const id = ${JSON.stringify(sessionId)};
    const until = ${JSON.stringify(until)};
    (await wait(() => document.querySelector('.session-row > button[data-session-id="' + id + '"]'), 'session row')).click();
    if (document.querySelector('.session-inspector h2')?.textContent !== ${JSON.stringify(name)}) {
      (await wait(() => document.querySelector('[aria-label="Actions for ${name}"]'), 'row menu')).click();
      (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
        .find(row => row.textContent.trim() === 'Session details'), 'details action')).click();
      await wait(() => document.querySelector('.session-inspector h2')?.textContent === ${JSON.stringify(name)}, 'details');
    }
    const modelRow = () => {
      const term = [...document.querySelectorAll('.session-inspector .hook-observation dt')].find(dt => dt.textContent === 'Model');
      return term?.nextElementSibling ?? null;
    };
    await wait(() => until === null ? modelRow() === null : modelRow()?.textContent.includes(until), 'Model row ' + until)
      .catch(async (error) => { throw new Error(error.message + ' ' + JSON.stringify({ shown: modelRow()?.textContent ?? null,
        details: document.querySelector('.session-inspector')?.textContent.slice(0, 300) ?? null,
        origins: await window.aiTerminal.listHookOrigins() })); });
    const row = document.querySelector('.session-row > button[data-session-id="' + id + '"]');
    const pane = document.querySelector('.session-terminal[data-session-id="' + id + '"]:not(.session-terminal-hidden) .pane-heading');
    const inspector = document.querySelector('.session-inspector .inspector-state');
    const flag = (root) => root?.querySelector('.origin-flag') ?? null;
    return {
      rowChip: row?.querySelector('.chips .chip')?.textContent ?? null,
      rowFlag: flag(row)?.textContent ?? null, rowLabel: flag(row)?.getAttribute('aria-label') ?? null,
      paneChip: pane?.querySelector('.chip')?.textContent ?? null,
      paneFlag: flag(pane)?.textContent ?? null, paneLabel: flag(pane)?.getAttribute('aria-label') ?? null,
      inspectorChip: inspector?.querySelector('.chip')?.textContent ?? null,
      inspectorFlag: flag(inspector)?.textContent ?? null,
      modelRow: modelRow()?.textContent ?? null, modelTitle: modelRow()?.getAttribute('title') ?? null
    };
  })()`) as Promise<OriginProbe>
}

/** Fires one origin gate and waits until the stand-in's `bmn hook claude` call has returned. */
async function fireOriginGate(
  directory: string, n: number, scenario: { baseUrl: string | null; model: string | null; event: string; configDir?: string }
): Promise<void> {
  writeFileSync(join(directory, `fire-${n}`), JSON.stringify(scenario))
  await untilFileExists(join(directory, `done-${n}`), `model origin hook ${n}`)
  const status = readFileSync(join(directory, `done-${n}`), 'utf8')
  if (status !== '0') throw new Error(`model origin hook ${n} exited ${status}`)
}

/** What a session's own `bmn list --json` says about its conversation, once the hook has reported. */
function listedConversation(listing: string): { sessions: number; conversation: unknown } {
  if (!existsSync(listing)) return { sessions: 0, conversation: null }
  const rows = JSON.parse(readFileSync(listing, 'utf8')) as Array<{ conversation?: unknown }>
  return { sessions: rows.length, conversation: rows[0]?.conversation ?? null }
}

/** A command that records its argv and then stays up, so a started row can be proved by its argv. */
function writeArgvRecorder(directory: string, name: string): { executable: string; log: string } {
  mkdirSync(directory, { recursive: true })
  const log = join(directory, `${name}.log`)
  const executable = join(directory, name)
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { appendFileSync } = require('node:fs')",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      `process.stdout.write(${JSON.stringify(name)} + ' started\\n')`,
      'setInterval(() => undefined, 1_000)',
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, log }
}

/**
 * A program that turns on the modes a TUI turns on — bracketed paste, focus reports and SGR mouse —
 * and then records every byte the terminal sends it. What the log holds is what the program would
 * actually have received, which is the only honest way to ask whether a rebuilt view still speaks
 * to it the same way.
 */
function writeTerminalModeProgram(directory: string): { executable: string; input: string } {
  mkdirSync(directory, { recursive: true })
  const input = join(directory, 'stdin.log')
  const executable = join(directory, 'modes')
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { appendFileSync } = require('node:fs')",
      // Bracketed paste, focus reports, and mouse tracking with SGR encoding.
      // On: bracketed paste, focus reports, mouse with SGR. Off: autowrap, which a fresh view has on.
      "process.stdout.write('\\u001b[?2004h\\u001b[?1004h\\u001b[?1000h\\u001b[?1006h\\u001b[?7l')",
      "process.stdout.write('MODE-PROGRAM-READY\\r\\n')",
      // Raw mode, as every TUI does: the line discipline must not hold a paste back until Enter.
      "if (process.stdin.isTTY) process.stdin.setRawMode(true)",
      "process.stdin.setEncoding('latin1')",
      `process.stdin.on('data', (chunk) => appendFileSync(${JSON.stringify(input)}, JSON.stringify(chunk) + '\\n'))`,
      'setInterval(() => undefined, 1_000)',
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, input }
}

/** Everything the mode program has been sent, as one string. */
function terminalModeProgramInput(input: string): string {
  if (!existsSync(input)) return ''
  return readFileSync(input, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as string)
    .join('')
}

function harnessRuns(log: string): string[][] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as string[])
}

async function untilHarnessRuns(log: string, count: number): Promise<string[][]> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const runs = harnessRuns(log)
    if (runs.length >= count) return runs
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`the synthetic Codex harness did not reach ${count} run(s): ${log}`)
}

/**
 * A synthetic Claude harness: it fires real hook events through the installed `bmn hook claude`, the
 * way the CLI's own hooks do, and waits on gate files so the caller can read the app between events.
 */
function writeClaudeHookHarness(directory: string): {
  executable: string
  opened: string
  toolGate: string
  resolved: string
  secondGate: string
  reopened: string
} {
  mkdirSync(directory, { recursive: true })
  const opened = join(directory, 'opened')
  const toolGate = join(directory, 'tool-gate')
  const resolved = join(directory, 'resolved')
  const secondGate = join(directory, 'second-gate')
  const reopened = join(directory, 'reopened')
  const executable = join(directory, 'claude')
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { spawnSync } = require('node:child_process')",
      "const { existsSync, writeFileSync } = require('node:fs')",
      "const fire = (event) => spawnSync('bmn', ['hook', 'claude'], {",
      "  input: JSON.stringify(event), stdio: ['pipe', 'ignore', 'ignore']",
      "})",
      "const prompt = { hook_event_name: 'Notification', notification_type: 'permission_prompt',",
      "  message: 'Allow the hook self-test action' }",
      "fire(prompt)",
      `writeFileSync(${JSON.stringify(opened)}, '')`,
      "const after = (gate, run, marker) => {",
      "  const timer = setInterval(() => {",
      "    if (!existsSync(gate)) return",
      "    clearInterval(timer)",
      "    run()",
      "    writeFileSync(marker, '')",
      "  }, 25)",
      "}",
      `after(${JSON.stringify(toolGate)}, () => fire({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} }), ${JSON.stringify(resolved)})`,
      `after(${JSON.stringify(secondGate)}, () => fire(prompt), ${JSON.stringify(reopened)})`,
      "process.stdout.write('claude hook harness ready\\n')",
      "setInterval(() => undefined, 1_000)",
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, opened, toolGate, resolved, secondGate, reopened }
}

/**
 * A second session that fires one hook event of its own. Its name is not in either agent's table, so it opens
 * nothing and only reaches the log - which is what the log is for, and what keeps the two sessions' logs apart.
 */
function writeIsolationHookHarness(directory: string): { executable: string; fired: string; event: string } {
  mkdirSync(directory, { recursive: true })
  const fired = join(directory, 'fired')
  const executable = join(directory, 'claude')
  const event = 'Isolation-Probe'
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { spawnSync } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `spawnSync('bmn', ['hook', 'claude'], {`,
      `  input: JSON.stringify({ hook_event_name: ${JSON.stringify(event)} }), stdio: ['pipe', 'ignore', 'ignore']`,
      '})',
      `writeFileSync(${JSON.stringify(fired)}, '')`,
      "process.stdout.write('isolation hook harness ready\\n')",
      'setInterval(() => undefined, 1_000)',
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, fired, event }
}

/**
 * Epic 15.1: a program that knows nothing of `bmn` and only writes a terminal notification. With
 * `hookFirst` it reports one real hook event before printing, which is the session BMN must leave
 * to its own harness.
 */
function writeTerminalNoticeHarness(
  directory: string,
  options: { hookFirst: boolean }
): { executable: string; printed: string; trigger: string; second: string } {
  mkdirSync(directory, { recursive: true })
  const printed = join(directory, 'printed')
  const trigger = join(directory, 'trigger')
  const second = join(directory, 'second')
  const executable = join(directory, 'notice-harness')
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { spawnSync } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      ...(options.hookFirst
        ? [
          "spawnSync('bmn', ['hook', 'claude'], {",
          "  input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'the harness finished' }),",
          "  stdio: ['pipe', 'ignore', 'ignore']",
          '})'
        ]
        : []),
      // OSC 9, the plainest of the three: ESC ] 9 ; text BEL.
      "process.stdout.write('\\u001b]9;BMN self-test notice\\u0007')",
      `writeFileSync(${JSON.stringify(printed)}, '')`,
      // A second notice on demand, so the probe can snapshot the terminal on both sides of one.
      "const { existsSync } = require('node:fs')",
      'const waiting = setInterval(() => {',
      `  if (!existsSync(${JSON.stringify(trigger)})) return`,
      '  clearInterval(waiting)',
      "  process.stdout.write('\\u001b]9;BMN self-test second notice\\u0007')",
      `  writeFileSync(${JSON.stringify(second)}, '')`,
      '}, 25)',
      'setInterval(() => undefined, 1_000)',
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, printed, trigger, second }
}

/** Waits for one of the harness's marker files; the harness writes each one after its event landed. */
async function untilFileExists(path: string, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`the Claude hook harness never ${what}: ${path}`)
}

async function runSelfTest(): Promise<void> {
  const { hostEntry, repoRoot } = appPaths()
  // Set before the host starts: the utility captures CODEX_HOME into every session's launch context.
  process.env.CODEX_HOME = selfTestCodexHome()
  await nativeFailureSelfTest(hostEntry, repoRoot)
  const launched = await launchHostWithChannel()
  let client = launched.client
  const ready = launched.ready
  let applicationPort: MessagePortMain | undefined = launched.applicationPort
  let receipt: Record<string, unknown> | undefined
  /** Epic 31's fixture; its holder process is stopped when the self-test releases its resources. */
  let historyFixture: HistoryFixture | undefined
  /** Epic 12.1: what the CLI stored, what it refused, and whether the links survive a restart. */
  let progressEvidence: {
    sameIdOnRetry: boolean
    outcome: string[]
    state: string
    label: string
    links: ProgressRecord['evidence']
    artifactId: string
  } | undefined
  let graceful = true
  let clientClosed = false
  try {
    const isolatedCwd = process.env.BMN_STATE_HOME
    if (!isolatedCwd) throw new Error('self-test requires BMN_STATE_HOME')
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
    const rendererChannel = new MessageChannelMain()
    client.attachTerminalPort(rendererChannel.port1)
    applicationPort.close()
    applicationPort = rendererChannel.port2
    hostClient = client
    hostRendererPort = applicationPort
    trackSessionProcessStates(client)
    client.onAppEvent((message) => appEvents.forward(message))
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
    const writeFixtureInput = (identity: SessionIdentity, input: string): void => {
      const runtime = runtimes.get(identity.sessionId)
      if (!runtime) throw new Error(`attention fixture runtime missing for ${identity.sessionId}`)
      applicationPort!.postMessage({
        kind: 'terminal-input',
        method: METHOD_REGISTRY.terminalWrite,
        attachmentId: runtime.attachment.attachmentId,
        bytes: new TextEncoder().encode(input)
      })
    }
    const writeFixtureCommand = (identity: SessionIdentity, command: string): void => {
      writeFixtureInput(identity, `${command}\r`)
    }
    writeFixtureCommand(
      session,
      'bmn ask self-question "Choose the self-test answer" --kind question'
    )
    writeFixtureCommand(
      secondSession,
      `bmn ask self-permission "Allow the self-test action" --kind permission --expires ${new Date(Date.now() + 10 * 60_000).toISOString()}; ` +
      'bmn ask self-review "Review the self-test result" --kind review; ' +
      'bmn ask self-update "Self-test turn finished" --kind notice; ' +
      'bmn progress failed "Observed self-test failure" --source self-test ' +
      '--observed 2026-09-18T20:00:00.000Z'
    )
    const attentionFixtureDeadline = Date.now() + 5_000
    while (Date.now() < attentionFixtureDeadline) {
      const [fixtureAttention, fixtureProgress] = await Promise.all([
        client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}),
        client.request<ProgressRecord[]>(METHOD_REGISTRY.progressList, {})
      ])
      if (
        fixtureAttention.filter((request) => request.state === 'open').length === 4 &&
        fixtureProgress.some((record) =>
          record.sessionId === secondSession.sessionId && record.state === 'failed' && record.source === 'self-test')
      ) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const [fixtureAttention, fixtureProgress] = await Promise.all([
      client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}),
      client.request<ProgressRecord[]>(METHOD_REGISTRY.progressList, {})
    ])
    if (
      fixtureAttention.filter((request) => request.state === 'open').length !== 4 ||
      !fixtureProgress.some((record) =>
        record.sessionId === secondSession.sessionId && record.state === 'failed' && record.source === 'self-test')
    ) {
      throw new Error('the attention/progress CLI fixture did not reach the utility owner')
    }
    // Epic 12.1: a session publishes a file of its own and then reports progress that points at it,
    // exactly as the CLI documents it. The three refusals in the same shell prove the report is all
    // or nothing: an ID from another session, a file handed *to* this session, and an unknown ID each
    // leave the previous observation exactly where it was.
    const evidenceDirectory = join(isolatedCwd, 'evidence')
    mkdirSync(evidenceDirectory, { recursive: true })
    const evidenceLog = join(evidenceDirectory, 'checks.log')
    writeFileSync(evidenceLog, 'self-test: 3 checks passed\n')
    const evidenceReceipt = join(evidenceDirectory, 'publish.json')
    const evidenceRetryReceipt = join(evidenceDirectory, 'publish-retry.json')
    const evidenceOutcome = join(evidenceDirectory, 'outcome.txt')
    const attachedToSession = await client.request<ArtifactRecord>(METHOD_REGISTRY.artifactImportBytes, {
      sessionId: session.sessionId,
      name: 'brief-handed-to-the-agent.txt',
      bytes: new TextEncoder().encode('what the owner asked for\n')
    })
    const otherSessionEvidence = await client.request<ArtifactRecord>(METHOD_REGISTRY.artifactImportBytes, {
      sessionId: secondSession.sessionId,
      name: 'another-sessions-file.txt',
      bytes: new TextEncoder().encode('not this session\n')
    })
    writeFixtureCommand(
      session,
      `bmn progress running "Self-test evidence baseline" --source evidence --observed 2026-09-18T19:00:00.000Z; ` +
      `bmn publish ${evidenceLog} --key self-test-evidence --json > ${evidenceReceipt}; ` +
      // The same key must return the same artifact, which is what makes a later reference safe.
      `bmn publish ${evidenceLog} --key self-test-evidence --json > ${evidenceRetryReceipt}`
    )
    const publishedEvidence = await (async (): Promise<{ first: string; retry: string }> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (existsSync(evidenceReceipt) && existsSync(evidenceRetryReceipt)) {
          try {
            const first = JSON.parse(readFileSync(evidenceReceipt, 'utf8')) as { artifactId?: string }
            const retry = JSON.parse(readFileSync(evidenceRetryReceipt, 'utf8')) as { artifactId?: string }
            if (first.artifactId && retry.artifactId) return { first: first.artifactId, retry: retry.artifactId }
          } catch {
            // The shell is still writing the file; read it again.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the session did not publish its own evidence file')
    })()
    writeFixtureCommand(
      session,
      // No --observed: the accepted report must be fresh, so the strip reads "Reported verified"
      // rather than the stale "Last reported verified". The baseline above is the old one.
      `bmn progress verified "Self-test checks passed" --source evidence ` +
      `--detail "3 checks, 0 failures" --evidence-id ${publishedEvidence.first} ` +
      `&& echo accepted > ${evidenceOutcome}; ` +
      `bmn progress failed "Should not be stored" --source evidence --evidence-id ${otherSessionEvidence.artifactId} ` +
      `2>/dev/null || echo refused-other-session >> ${evidenceOutcome}; ` +
      `bmn progress failed "Should not be stored" --source evidence --evidence-id ${attachedToSession.artifactId} ` +
      `2>/dev/null || echo refused-input >> ${evidenceOutcome}; ` +
      `bmn progress failed "Should not be stored" --source evidence --evidence-id no-such-artifact ` +
      `2>/dev/null || echo refused-unknown >> ${evidenceOutcome}; ` +
      `bmn progress failed "Should not be stored" --source evidence ` +
      `--evidence-id ${publishedEvidence.first} --evidence-id ${publishedEvidence.first} ` +
      `2>/dev/null || echo refused-duplicate >> ${evidenceOutcome}; ` +
      `echo done >> ${evidenceOutcome}`
    )
    const evidenceOutcomeLines = await (async (): Promise<string[]> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (existsSync(evidenceOutcome)) {
          const lines = readFileSync(evidenceOutcome, 'utf8').split('\n').filter((line) => line !== '')
          if (lines.at(-1) === 'done') return lines
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the evidence refusal fixture did not finish')
    })()
    const evidenceProgress = await (async (): Promise<ProgressRecord> => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const found = (await client.request<ProgressRecord[]>(METHOD_REGISTRY.progressList, {}))
          .find((record) => record.sessionId === session.sessionId && record.source === 'evidence')
        if (found?.state === 'verified') return found
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the evidence progress report did not reach the utility owner')
    })()
    progressEvidence = {
      sameIdOnRetry: publishedEvidence.first === publishedEvidence.retry,
      outcome: evidenceOutcomeLines,
      state: evidenceProgress.state,
      label: evidenceProgress.label,
      links: evidenceProgress.evidence,
      artifactId: publishedEvidence.first
    }

    const handoffArtifact = await client.request<ArtifactRecord>(METHOD_REGISTRY.artifactImportBytes, {
      sessionId: secondSession.sessionId,
      name: 'handoff-self-test.txt',
      bytes: new TextEncoder().encode('synthetic handoff original\n')
    })
    // Story 32.1: what holds an agent comes first, whatever order the requests arrived in.
    const expectedResponseTitles = ['Allow the self-test action', 'Choose the self-test answer', 'Review the self-test result']
    writeFixtureCommand(session, 'bmn ask self-race "A stale notice" --kind notice')
    const raceNotice = await (async (): Promise<AttentionRecord> => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const found = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
          .find((request) => request.requestKey === 'self-race' && request.state === 'open')
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the notice race fixture did not open')
    })()
    writeFixtureCommand(session, 'bmn ask self-race "A revised question" --kind question')
    const revisedPrompt = await (async (): Promise<AttentionRecord> => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const found = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
          .find((request) =>
            request.requestId === raceNotice.requestId &&
            request.kind === 'question' &&
            request.revision > raceNotice.revision)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the notice race fixture did not revise into a question')
    })()
    await expectRemoteFailure(
      client.request(METHOD_REGISTRY.attentionResolve, {
        requestId: raceNotice.requestId,
        resolution: 'Opened in BMN',
        expectedKind: raceNotice.kind,
        expectedRevision: raceNotice.revision
      }),
      ERROR_CODES.revisionConflict,
      'changed before it was opened'
    )
    const revisedAfterStaleActivation = (await client.request<AttentionRecord[]>(
      METHOD_REGISTRY.attentionList,
      {}
    )).find((request) => request.requestId === revisedPrompt.requestId)
    const staleNoticeRejected = true
    const revisedPromptPreserved =
      revisedAfterStaleActivation?.kind === 'question' && revisedAfterStaleActivation.state === 'open'
    await client.request(METHOD_REGISTRY.attentionResolve, {
      requestId: revisedPrompt.requestId,
      resolution: 'Self-test cleanup'
    })
    // The probe pane prints a reference relative to its launch directory, then its shell moves elsewhere.
    const fileReferenceRoot = join(isolatedCwd, 'refs')
    mkdirSync(join(fileReferenceRoot, 'src'), { recursive: true })
    writeFileSync(
      join(fileReferenceRoot, 'src', 'parser.ts'),
      Array.from({ length: 60 }, (_, index) => index === 41 ? 'FILE-REFERENCE-TARGET line 42' : `line ${index + 1}`)
        .join('\n') + '\n'
    )
    const searchRoot = join(isolatedCwd, 'file-search-fixture')
    mkdirSync(searchRoot, { recursive: true })
    for (let index = 0; index < 120; index += 1) {
      writeFileSync(join(searchRoot, `search-cap-${String(index).padStart(3, '0')}.ts`), 'fixture\n')
    }
    writeFileSync(join(searchRoot, 'report:42'), 'exact colon-named file\n')
    writeFileSync(join(searchRoot, 'report'), Array.from({ length: 60 }, () => 'wrong sibling').join('\n'))
    writeFileSync(join(searchRoot, 'a:b.ts'), 'representable colon-named file\n')
    mkdirSync(join(searchRoot, 'node_modules'), { recursive: true })
    mkdirSync(join(searchRoot, '.git'), { recursive: true })
    writeFileSync(join(searchRoot, 'node_modules', 'bmn-excluded.ts'), 'fixture\n')
    writeFileSync(join(searchRoot, '.git', 'bmn-excluded.ts'), 'fixture\n')
    const deepSearchRoot = join(searchRoot, 'one', 'two', 'three', 'four', 'five', 'six', 'seven')
    mkdirSync(deepSearchRoot, { recursive: true })
    writeFileSync(join(deepSearchRoot, 'bmn-deep.ts'), 'fixture\n')
    writeFixtureInput(session, 'EXISTING-HANDOFF-PREFIX ')
    // Dictation needs an engine and an installed model to start; both are stand-ins, and transcription is synthetic.
    mkdirSync(join(selfTestVoiceFolder(), 'models'), { recursive: true })
    writeFileSync(join(selfTestVoiceFolder(), 'whisper-cli'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(selfTestVoiceFolder(), SPEECH_DETECTOR_FILE), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(selfTestVoiceFolder(), SPEECH_MODEL_FILE), '')
    writeFileSync(join(selfTestVoiceFolder(), 'models', VOICE_MODELS[0]!.file), '')
    // A sparse file at the pinned size counts as installed; no model bytes are written.
    truncateSync(join(selfTestVoiceFolder(), 'models', VOICE_MODELS[0]!.file), VOICE_MODELS[0]!.bytes)
    const rendererStartup = await loadApplicationStartup(true)
    console.error('[BMN] self-test phase: renderer preload integration')
    applicationWindow = createWindow(rendererStartup, {
      forceHidden: true,
      terminalPort: applicationPort,
      recoverRenderer: recoverApplicationRenderer,    })
    let releaseAttentionUpdate: (() => void) | undefined
    const attentionBaselineCaptured = new Promise<void>((resolve) => {
      releaseAttentionUpdate = resolve
    })
    applicationWindow.webContents.on('console-message', (_event, level, message) => {
      if (level === 2) console.error(`[BMN] renderer console: ${message}`)
      if (message.includes('attention baseline captured')) releaseAttentionUpdate?.()
    })
    await waitForRendererLoad(applicationWindow)
    const cspProbe = await applicationWindow.webContents.executeJavaScript(`(async () => {
      let evalRefused = false;
      try { window.eval('1 + 1'); } catch { evalRefused = true; }
      let wasmAllowed = false;
      try {
        await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        wasmAllowed = true;
      } catch { /* reported below */ }
      return { evalRefused, wasmAllowed };
    })()`) as { evalRefused: boolean; wasmAllowed: boolean }
    if (!cspProbe.evalRefused || !cspProbe.wasmAllowed) {
      throw new Error(`Sixel CSP did not preserve the eval boundary: ${JSON.stringify(cspProbe)}`)
    }
    const sixelPtyPath = join(isolatedCwd, 'sixel-pty-frame.bin')
    writeFileSync(sixelPtyPath,
      `\u001bP9;1;0q"1;1;60;75#1;2;100;0;0#1${Array(13).fill('!60~').join('-')}\u001b\\`)
    const sixelPtyBefore = await applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const probe = () => {
          const snapshot = window.__aitermTest?.snapshots()[${JSON.stringify(secondSession.sessionId)}];
          if (snapshot) resolve(snapshot.imageStorageMB);
          else if (Date.now() >= deadline) reject(new Error('PTY Sixel pane did not mount'));
          else setTimeout(probe, 25);
        };
        probe();
      })
    `) as number
    const sixelPtyRuntime = runtimes.get(secondSession.sessionId)
    if (!sixelPtyRuntime) throw new Error('PTY Sixel fixture runtime was unavailable')
    await client.request(METHOD_REGISTRY.terminalWrite, {
      attachmentId: sixelPtyRuntime.attachment.attachmentId,
      bytes: new TextEncoder().encode(`cat '${sixelPtyPath.replaceAll("'", "'\\''")}'\r`)
    })
    const sixelPty = await applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const probe = () => {
          const snapshot = window.__aitermTest?.snapshot(${JSON.stringify(secondSession.sessionId)});
          if (snapshot?.imageStorageMB > ${sixelPtyBefore} && snapshot.imageLayerPresent) {
            resolve({ beforeMB: ${sixelPtyBefore}, afterMB: snapshot.imageStorageMB,
              layer: snapshot.imageLayerPresent });
          } else if (Date.now() >= deadline) reject(new Error('PTY Sixel frame did not reach the live pane: ' +
            JSON.stringify({ storageMB: snapshot?.imageStorageMB,
              lines: snapshot?.bufferLines.slice(-8) })));
          else setTimeout(probe, 25);
        };
        probe();
      })
    `) as { beforeMB: number; afterMB: number; layer: boolean }
    if (!(sixelPtyBefore === 0 && sixelPty.afterMB > 0 && sixelPty.layer)) {
      throw new Error(`PTY Sixel transport did not decode in the live pane: ${JSON.stringify(sixelPty)}`)
    }
    // Decode a known frame in one real pane. This bypasses shell command timing so a failure names
    // the renderer itself; transport has its own framing and queue checks.
    const sixelDirect = await applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const probe = () => {
          const hook = window.__aitermTest;
          if (hook?.snapshots()[${JSON.stringify(secondSession.sessionId)}]) {
            const otherBefore = hook.snapshot(${JSON.stringify(session.sessionId)});
            hook.sixelFixture(${JSON.stringify(secondSession.sessionId)}).then((fixture) => {
              const otherAfter = hook.snapshot(${JSON.stringify(session.sessionId)});
              resolve({ fixture, otherBefore, otherAfter });
            }, reject);
          } else if (Date.now() >= deadline) reject(new Error('the Sixel pane did not mount'));
          else setTimeout(probe, 25);
        };
        probe();
      })
    `) as { fixture: { storageMB: number; layer: boolean };
      otherBefore: { imageStorageMB: number; imageLayerPresent: boolean };
      otherAfter: { imageStorageMB: number; imageLayerPresent: boolean } }
    const sixelRender = {
      ownStorageMB: sixelDirect.fixture.storageMB,
      ownLayer: sixelDirect.fixture.layer,
      otherStorageMB: sixelDirect.otherAfter.imageStorageMB,
      otherImageUnchanged: sixelDirect.otherBefore.imageStorageMB === sixelDirect.otherAfter.imageStorageMB &&
        sixelDirect.otherBefore.imageLayerPresent === sixelDirect.otherAfter.imageLayerPresent
    }
    if (!(sixelRender.ownStorageMB > 0 && sixelRender.ownLayer)) {
      throw new Error(`the real pane could not decode the Sixel fixture: ${JSON.stringify(sixelRender)}`)
    }
    if (!sixelRender.otherImageUnchanged) {
      throw new Error('Sixel output changed the other pane image layer')
    }

    // Epic 28.1 AC2/AC3/AC5: a Codex-style animation in one of two visible panes. Codex 0.157.1's
    // built-in pets change frame every 120–150 ms (pets/model.rs) and allow up to 60 fps; each
    // frame blanks the pet's rows, draws the next image there and restores the cursor.
    const animationDirectory = join(isolatedCwd, 'sixel-animation')
    mkdirSync(animationDirectory, { recursive: true })
    const codexFrame = (seed: number): string => {
      let body = ''
      for (let color = 0; color < 8; color += 1) {
        body += `#${color};2;${(color * 37 + seed * 11) % 100};${(color * 53) % 100};${(color * 71 + seed * 5) % 100}`
      }
      for (let row = 0; row < 13; row += 1) {
        for (let color = 0; color < 8; color += 1) {
          body += `#${color}`
          for (let x = 0; x < 96; x += 1) body += String.fromCharCode(63 + ((x * 7 + row * 13 + color * 5 + seed) % 64))
          if (color < 7) body += '$'
        }
        if (row < 12) body += '-'
      }
      return `\u001bP9;1;0q"1;1;96;75${body}\u001b\\`
    }
    writeFileSync(join(animationDirectory, 'frame0.six'), codexFrame(0))
    writeFileSync(join(animationDirectory, 'frame1.six'), codexFrame(1))
    const animationScript = join(animationDirectory, 'animate.sh')
    writeFileSync(animationScript, [
      '#!/bin/sh',
      'frames=$1; delay=$2; label=$3; dir=$(dirname "$0"); i=0',
      'while [ "$i" -lt "$frames" ]; do',
      "  printf '\\0337'",
      "  r=2; while [ \"$r\" -le 7 ]; do printf '\\033[%d;40H%24s' \"$r\" ''; r=$((r + 1)); done",
      "  printf '\\033[2;40H'; cat \"$dir/frame$((i % 2)).six\"; printf '\\0338'",
      '  i=$((i + 1)); sleep "$delay"',
      'done',
      "printf '%s-DONE\\r\\n' \"$label\""
    ].join('\n') + '\n', { mode: 0o700 })
    const animatedRuntime = runtimes.get(secondSession.sessionId)
    if (!animatedRuntime) throw new Error('the animation pane runtime was unavailable')
    const animatedAttachment = animatedRuntime.attachment.attachmentId
    const typeIntoAnimatedPane = (text: string) => client.request(METHOD_REGISTRY.terminalWrite, {
      attachmentId: (runtimes.get(secondSession.sessionId) ?? animatedRuntime).attachment.attachmentId,
      bytes: new TextEncoder().encode(text)
    })
    const animatedId = JSON.stringify(secondSession.sessionId)
    const quietId = JSON.stringify(session.sessionId)
    const waitForAnimatedLine = (marker: string, timeoutMs: number) => applicationWindow!.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + ${timeoutMs};
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshot(${animatedId}).bufferLines.some((line) => line.includes(${JSON.stringify(marker)}))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(${JSON.stringify(`the animation pane never printed ${marker}`)});
    })()`) as Promise<void>
    const quietBefore = await applicationWindow.webContents.executeJavaScript(`(() => {
      const hook = window.__aitermTest;
      const selection = hook.view(${quietId}).select(0, 0, 12);
      const snapshot = hook.snapshot(${quietId});
      return { lines: snapshot.bufferLines, storageMB: snapshot.imageStorageMB, layer: snapshot.imageLayerPresent, selection };
    })()`) as { lines: string[]; storageMB: number; layer: boolean; selection: string }
    await typeIntoAnimatedPane(`clear; '${animationScript}' 64 0.12 CODEX-RATE; '${animationScript}' 120 0.016 MAX-RATE\r`)
    await waitForAnimatedLine('CODEX-RATE-DONE', 30_000)
    await waitForAnimatedLine('MAX-RATE-DONE', 30_000)
    // Scroll the pane well past its rows: only the last frame drawn may remain in the buffer.
    await typeIntoAnimatedPane(`i=0; while [ $i -lt 80 ]; do echo scroll-$i; i=$((i + 1)); done; printf '%s%s\\n' SCROLL ED\r`)
    await waitForAnimatedLine('SCROLLED', 10_000)
    const animation = await applicationWindow.webContents.executeJavaScript(`(() => {
      const hook = window.__aitermTest;
      const own = hook.snapshot(${animatedId});
      const quiet = hook.snapshot(${quietId});
      return { storageMB: own.imageStorageMB, imageLines: hook.view(${animatedId}).imageCells().lines,
        quiet: { lines: quiet.bufferLines, storageMB: quiet.imageStorageMB, layer: quiet.imageLayerPresent,
          selection: (() => {
            const selection = hook.view(${quietId}).selection();
            hook.view(${quietId}).clearSelection();
            return selection;
          })() } };
    })()`) as { storageMB: number; imageLines: number[];
      quiet: { lines: string[]; storageMB: number; layer: boolean; selection: string } }
    const sixelAnimation = {
      frames: 184,
      noViewRebuild: runtimes.get(secondSession.sessionId)?.attachment.attachmentId === animatedAttachment,
      storageMB: animation.storageMB,
      imageLinesAfterScroll: animation.imageLines.length,
      quietPaneUnchanged: JSON.stringify(animation.quiet.lines) === JSON.stringify(quietBefore.lines) &&
        animation.quiet.storageMB === quietBefore.storageMB && animation.quiet.layer === quietBefore.layer,
      quietSelectionKept: quietBefore.selection.length > 0 && animation.quiet.selection === quietBefore.selection
    }
    // One 75 px frame covers at most 7 rows at the smallest font; more means stale frames stayed.
    if (!sixelAnimation.noViewRebuild || !(sixelAnimation.storageMB > 0) || sixelAnimation.imageLinesAfterScroll > 7 ||
      !sixelAnimation.quietPaneUnchanged || !sixelAnimation.quietSelectionKept) {
      throw new Error(`the two-pane Sixel animation failed: ${JSON.stringify(sixelAnimation)}`)
    }

    // AC3: both visible panes animate at once, at Codex's cadence; neither view is rebuilt.
    const quietRuntime = runtimes.get(session.sessionId)
    if (!quietRuntime) throw new Error('the second animation pane runtime was unavailable')
    const quietAttachment = quietRuntime.attachment.attachmentId
    const animatedAttachmentBoth = runtimes.get(secondSession.sessionId)!.attachment.attachmentId
    await client.request(METHOD_REGISTRY.terminalWrite, { attachmentId: quietAttachment,
      // Ctrl+U first: this prompt holds unsent handoff-fixture input, restored below.
      bytes: new TextEncoder().encode(`\u0015clear; '${animationScript}' 64 0.12 BOTH-B\r`) })
    await typeIntoAnimatedPane(`clear; '${animationScript}' 64 0.12 BOTH-A\r`)
    await waitForAnimatedLine('BOTH-A-DONE', 30_000)
    await applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshot(${quietId}).bufferLines.some((line) => line.includes('BOTH-B-DONE'))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the second animated pane never finished');
    })()`)
    const sixelTwoPaneAnimation = {
      framesPerPane: 64,
      noViewRebuild: runtimes.get(session.sessionId)?.attachment.attachmentId === quietAttachment &&
        runtimes.get(secondSession.sessionId)?.attachment.attachmentId === animatedAttachmentBoth,
      storageMB: await applicationWindow.webContents.executeJavaScript(`(() => {
        const snapshots = window.__aitermTest.snapshots();
        return [snapshots[${animatedId}].imageStorageMB, snapshots[${quietId}].imageStorageMB];
      })()`) as number[]
    }
    if (!sixelTwoPaneAnimation.noViewRebuild || sixelTwoPaneAnimation.storageMB.some((value) => !(value > 0))) {
      throw new Error(`the two-pane animation rebuilt a view or lost its images: ${JSON.stringify(sixelTwoPaneAnimation)}`)
    }
    await client.request(METHOD_REGISTRY.terminalWrite, { attachmentId: quietAttachment,
      bytes: new TextEncoder().encode(`clear; printf '%s-%s\\n' QUIET-PANE CLEARED\r`) })
    await applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshot(${quietId}).bufferLines.some((line) => line.includes('QUIET-PANE-CLEARED'))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the second animated pane did not clear');
    })()`)
    await client.request(METHOD_REGISTRY.terminalWrite, { attachmentId: quietAttachment,
      bytes: new TextEncoder().encode('EXISTING-HANDOFF-PREFIX ') })
    await applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshot(${quietId}).bufferLines.some((line) => line.includes('EXISTING-HANDOFF-PREFIX'))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the handoff fixture input was not restored: ' +
        JSON.stringify(window.__aitermTest?.snapshot(${quietId}).bufferLines.filter((line) => line.trim()).slice(-4)));
    })()`)

    // The alternate screen keeps its image out of the normal buffer.
    // A known image above the prompt, so the commands typed below it overwrite no image cell.
    await typeIntoAnimatedPane(`clear; cat '${join(animationDirectory, 'frame0.six')}'; printf '\\n%s-%s\\n' ALT BASE\r`)
    await waitForAnimatedLine('ALT-BASE', 10_000)
    const imageLinesBeforeAlternate = await applicationWindow.webContents.executeJavaScript(
      `window.__aitermTest.view(${animatedId}).imageCells().lines`) as number[]
    await typeIntoAnimatedPane(`printf '\\033[?1049h'; cat '${join(animationDirectory, 'frame0.six')}'; printf '%s-%s' ALT-SCREEN TEXT; sleep 1.5; printf '\\033[?1049l'; printf '%s-%s\\n' ALT DONE\r`)
    // While the alternate screen is active, its own image and text are what the view shows.
    await waitForAnimatedLine('ALT-SCREEN-TEXT', 10_000)
    const duringAlternate = await applicationWindow.webContents.executeJavaScript(
      `window.__aitermTest.view(${animatedId}).imageCells().lines.length`) as number
    await waitForAnimatedLine('ALT-DONE', 10_000)
    const alternate = await applicationWindow.webContents.executeJavaScript(`(() => {
      const hook = window.__aitermTest;
      return { lines: hook.snapshot(${animatedId}).bufferLines, imageLines: hook.view(${animatedId}).imageCells().lines };
    })()`) as { lines: string[]; imageLines: number[] }
    const sixelAlternateScreen = {
      imageRowsWhileActive: duringAlternate,
      alternateTextLeftBehind: alternate.lines.some((line) => line.includes('ALT-SCREEN-TEXT')),
      normalImagesKept: JSON.stringify(alternate.imageLines) === JSON.stringify(imageLinesBeforeAlternate)
    }
    if (!(duringAlternate > 0) || sixelAlternateScreen.alternateTextLeftBehind || !sixelAlternateScreen.normalImagesKept) {
      throw new Error(`the alternate screen changed the normal buffer images: ${JSON.stringify(sixelAlternateScreen)}`)
    }


    // Later steps read this pane from its first rows, as a fresh shell leaves it.
    await typeIntoAnimatedPane(`clear; printf '%s-%s\\n' ANIMATION-PANE CLEARED\r`)
    await waitForAnimatedLine('ANIMATION-PANE-CLEARED', 10_000)

    const layoutSelectionsBeforeRendererProbe = selfTestLayoutPutSelections.length
    const incomingAttentionUpdate = attentionBaselineCaptured.then(async () => {
      console.error('[BMN] self-test phase: sending live attention revision')
      const runtime = runtimes.get(secondSession.sessionId)
      if (!runtime) throw new Error('the incoming attention fixture runtime was unavailable')
      await client.request(METHOD_REGISTRY.terminalWrite, {
        attachmentId: runtime.attachment.attachmentId,
        bytes: new TextEncoder().encode(
          'bmn ask self-update "Self-test turn revised" --kind notice; ' +
          "printf 'FILEREF %s/%s\\n' refs src/parser.ts:42:7; cd refs\r"
        )
      })
      console.error('[BMN] self-test phase: live attention revision accepted by host')
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const found = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
          .find((request) =>
            request.requestKey === 'self-update' &&
            request.kind === 'notice' &&
            request.title === 'Self-test turn revised')
        const markerPrinted = await applicationWindow!.webContents.executeJavaScript(
          `window.__aitermTest?.snapshot(${JSON.stringify(secondSession.sessionId)}).bufferLines
            .some((line) => line.includes('FILEREF refs/src/parser.ts:42:7'))`
        ) as boolean
        if (found && markerPrinted) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          console.error('[BMN] self-test phase: live attention revision observed')
          return found
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the incoming attention update did not reach the utility owner')
    })
    const [preloadProbe] = await Promise.all([
      waitForRendererIntegration(applicationWindow),
      incomingAttentionUpdate
    ])
    if (
      preloadProbe.bridgeErrorCodes.staleLayoutPut !== ERROR_CODES.revisionConflict ||
      preloadProbe.bridgeErrorCodes.unknownSessionSavedOutput !== ERROR_CODES.notFound
    ) {
      throw new Error(
        `typed bridge errors did not survive the contextBridge: ${JSON.stringify(preloadProbe.bridgeErrorCodes)}`
      )
    }
    if (
      preloadProbe.attentionTriage.totalCount !== 4 ||
      JSON.stringify(preloadProbe.attentionTriage.responseTitles) !== JSON.stringify(expectedResponseTitles) ||
      JSON.stringify(preloadProbe.attentionTriage.responseTitlesAfterUpdate) !==
        JSON.stringify(expectedResponseTitles) ||
      JSON.stringify(preloadProbe.attentionTriage.remainingResponseTitles) !==
        JSON.stringify(expectedResponseTitles.toSorted()) ||
      JSON.stringify(preloadProbe.attentionTriage.updateTitles) !== JSON.stringify(['Self-test turn finished']) ||
      JSON.stringify(preloadProbe.attentionTriage.updatedUpdateTitles) !== JSON.stringify(['Self-test turn revised']) ||
      !preloadProbe.attentionTriage.progressText.includes('Observed self-test failure') ||
      !preloadProbe.attentionTriage.progressText.includes('Last observed failed') ||
      !preloadProbe.attentionTriage.progressText.includes('stale') ||
      !preloadProbe.attentionTriage.detailsProgressText.includes('Observed self-test failure') ||
      !preloadProbe.attentionTriage.detailsProgressText.includes('Last observed failed') ||
      !preloadProbe.attentionTriage.detailsProgressText.includes('stale') ||
      // From the permission's own session, Ctrl+Shift+U stays in the top tier and moves to the question's session.
      preloadProbe.attentionTriage.keyboardTargetSessionId !== session.sessionId ||
      !/^\d+ (s|min) ago · expires in (9|10) min$/.test(preloadProbe.attentionTriage.firstResponseRow.age) ||
      !preloadProbe.attentionTriage.firstResponseRow.label.startsWith('Permission · Allow the self-test action · ') ||
      !/ · expires in (9|10) min$/.test(preloadProbe.attentionTriage.firstResponseRow.label) ||
      !preloadProbe.attentionTriage.noticeResolved ||
      !preloadProbe.attentionTriage.focusReturned ||
      !preloadProbe.attentionTriage.focusStableAfterIncomingUpdate
    ) {
      throw new Error(
        `the renderer did not preserve attention triage semantics: ${JSON.stringify(preloadProbe.attentionTriage)}`
      )
    }
    if (
      preloadProbe.handoffFlow.targetSessionId !== session.sessionId ||
      preloadProbe.handoffFlow.editedText !== 'Edited handoff line one\nQuestion line two' ||
      preloadProbe.handoffFlow.fileName !== handoffArtifact.originalName ||
      preloadProbe.handoffFlow.acceptedState !== 'accepted' ||
      !preloadProbe.handoffFlow.existingInputPreserved ||
      preloadProbe.handoffFlow.payloadOccurrences !== 1 ||
      !preloadProbe.handoffFlow.attentionResponsesPreserved ||
      !preloadProbe.handoffFlow.discardedDraftHidden
    ) {
      throw new Error(`the renderer did not complete the explicit handoff flow: ${JSON.stringify(preloadProbe.handoffFlow)}`)
    }
    const fileReferenceFlow = preloadProbe.fileReferenceFlow
    const referencedFile = realpathSync(join(fileReferenceRoot, 'src', 'parser.ts'))
    // Only explicit opens read: palette, launch-directory miss, chosen folder, rejected expansion, Ctrl+click, the
    // macOS-order Ctrl+click (once, though both its context menu and its release could open it), the reference
    // printed over a redrawn link, the missing session and the other workspace's pane. Hovers, clicks and drags add
    // nothing.
    const expectedFileReferenceReads = [
      'refs/src/parser.ts:42:7',
      'src/parser.ts',
      'src/parser.ts',
      '$HOME/notes.txt',
      'refs/src/parser.ts:42:7',
      'refs/src/parser.ts:42:7',
      'refs/src/parser.ts:7',
      'refs/src/parser.ts:42:7',
      'refs/src/parser.ts:42:7',
      'refs/src/parser.ts:42:7',
      'refs/src/parser.ts:42:7',
      referencedFile,
      referencedFile,
      '"' + join(searchRoot, 'a:b.ts') + '"'
    ]
    if (
      !fileReferenceFlow.palette.focusedInput ||
      fileReferenceFlow.palette.base !== realpathSync(isolatedCwd) && fileReferenceFlow.palette.base !== isolatedCwd ||
      fileReferenceFlow.palette.file !== referencedFile ||
      fileReferenceFlow.palette.marked !== 'FILE-REFERENCE-TARGET line 42' ||
      !fileReferenceFlow.palette.position.startsWith('Line 42, column 7 of 60 lines') ||
      fileReferenceFlow.palette.copied !== `${referencedFile}:42:7` ||
      fileReferenceFlow.palette.shownFeedback !== 'Shown in the file manager.' ||
      JSON.stringify(selfTestShownFileReferences) !== JSON.stringify([referencedFile]) ||
      !fileReferenceFlow.palette.focusReturned ||
      fileReferenceFlow.shellDirectoryIgnored.message !== 'No file exists at this path.' ||
      fileReferenceFlow.shellDirectoryIgnored.file !== join(fileReferenceFlow.launchDirectory, 'src', 'parser.ts') ||
      !fileReferenceFlow.chosenFolder.pickerMessage.includes('File dialogs are unavailable') ||
      fileReferenceFlow.chosenFolder.kind !== 'chosen-directory' ||
      fileReferenceFlow.chosenFolder.canonicalPath !== referencedFile ||
      fileReferenceFlow.rejected.message !== 'Shell variables are not expanded; enter the full path.' ||
      !fileReferenceFlow.rejected.inputPreserved ||
      fileReferenceFlow.link.reference !== 'refs/src/parser.ts:42:7' ||
      !fileReferenceFlow.link.session.startsWith('Same CLI chat B · ') ||
      fileReferenceFlow.link.marked !== 'FILE-REFERENCE-TARGET line 42' ||
      !fileReferenceFlow.link.selectedElsewhere ||
      !fileReferenceFlow.link.underlinedWithCtrl ||
      !fileReferenceFlow.link.focusReturned ||
      fileReferenceFlow.contextMenuClick.reference !== 'refs/src/parser.ts:42:7' ||
      !fileReferenceFlow.contextMenuClick.focusReturned ||
      fileReferenceFlow.plainClick.underlined ||
      fileReferenceFlow.plainClick.opened ||
      fileReferenceFlow.ctrlDrag.selected.length < 3 ||
      !'refs/src/parser.ts:42:7'.startsWith(fileReferenceFlow.ctrlDrag.selected) ||
      !fileReferenceFlow.ctrlDrag.copiedSelection ||
      fileReferenceFlow.ctrlDrag.opened ||
      fileReferenceFlow.missingSessionCode !== ERROR_CODES.notFound ||
      fileReferenceFlow.mouseMode.underlined ||
      fileReferenceFlow.mouseMode.opened ||
      fileReferenceFlow.mouseMode.reportsToProgram < 1 ||
      fileReferenceFlow.mouseMode.dragReportsToProgram < 1 ||
      !fileReferenceFlow.mouseMode.copiedSelection ||
      !fileReferenceFlow.mouseMode.rightClickPasted ||
      fileReferenceFlow.crossWorkspace?.session !== 'Archived running chat · Self-test archived workspace' ||
      fileReferenceFlow.crossWorkspace.base !== fileReferenceFlow.palette.base ||
      fileReferenceFlow.crossWorkspace.file !== referencedFile ||
      fileReferenceFlow.crossWorkspace.marked !== 'FILE-REFERENCE-TARGET line 42' ||
      !fileReferenceFlow.redraw.underlinedBefore ||
      fileReferenceFlow.redraw.staleOpened ||
      fileReferenceFlow.redraw.staleUnderlined ||
      fileReferenceFlow.redraw.reference !== 'refs/src/parser.ts:7' ||
      fileReferenceFlow.redraw.marked !== 'line 7' ||
      fileReferenceFlow.redraw.ptyInputEvents !== 0 ||
      JSON.stringify(selfTestReadFileReferences.map((read) => read.reference)) !==
        JSON.stringify(expectedFileReferenceReads) ||
      selfTestReadFileReferences.at(-1)?.sessionId !== secondSession.sessionId ||
      !fileReferenceFlow.epic27?.chooserDefaultEmpty ||
      !fileReferenceFlow.epic27.chooserCrossWorkspace ||
      fileReferenceFlow.epic27.previewPayload !== `${referencedFile}:42:7` ||
      !fileReferenceFlow.epic27.previewTarget.includes('Same CLI chat B') ||
      !fileReferenceFlow.epic27.previewTarget.includes('without pressing Enter') ||
      fileReferenceFlow.epic27.previewIncarnation !== secondSession.incarnationId ||
      !fileReferenceFlow.epic27.pastedFeedback.includes('not submitted') ||
      !fileReferenceFlow.epic27.pastedIntoTarget ||
      !fileReferenceFlow.epic27.focusLossClearedTarget ||
      !fileReferenceFlow.epic27.searchCapLabel.includes('Showing first 50') ||
      fileReferenceFlow.epic27.searchRows !== 50 ||
      !fileReferenceFlow.epic27.skippedRowsAbsent ||
      !fileReferenceFlow.epic27.supersededRowsAbsent ||
      !fileReferenceFlow.epic27.openedFromSession.includes('Same CLI chat B') ||
      fileReferenceFlow.epic27.openedFile !== referencedFile ||
      !fileReferenceFlow.epic27.foreignSearchSession.includes('Archived running chat') ||
      fileReferenceFlow.epic27.foreignSearchFile !== referencedFile ||
      fileReferenceFlow.epic27.colonFile !== join(searchRoot, 'a:b.ts') ||
      !fileReferenceFlow.epic27.numericSuffixRejected ||
      fileReferenceFlow.ptyInputEvents !== 0 ||
      !fileReferenceFlow.terminalUnchanged ||
      !fileReferenceFlow.attentionUnchanged
    ) {
      throw new Error(`the renderer did not complete the file-reference flow: ${JSON.stringify({
        ...fileReferenceFlow,
        shownPaths: selfTestShownFileReferences,
        reads: selfTestReadFileReferences,
        expectedFile: referencedFile
      })}`)
    }
    const voiceFlow = preloadProbe.voiceFlow
    const expectedTranscriptions = [
      voiceFlow.approvedAfterRemove,
      [...voiceFlow.approvedAfterRemove, 'Changed'],
      [...voiceFlow.approvedAfterRemove, 'Changed']
    ]
    if (
      !voiceFlow.suggested.includes('SessionManager') ||
      !voiceFlow.suggested.includes('pty_host') ||
      !voiceFlow.suggested.includes('Personal') ||
      !voiceFlow.suggested.includes('parser.ts') ||
      voiceFlow.suggested.some((word) => /^\d/u.test(word)) ||
      voiceFlow.editedApproved !== 'pty-host' ||
      !voiceFlow.chipsShareLine ||
      !voiceFlow.addWordRejected.message.includes('commas') ||
      !voiceFlow.addWordRejected.inputPreserved ||
      !voiceFlow.addWordRejected.listUnchanged ||
      !voiceFlow.duplicateRejected.message.includes('already in the list') ||
      !voiceFlow.duplicateRejected.candidateKept ||
      JSON.stringify(voiceFlow.approvedAfterRemove) !== JSON.stringify(['SessionManager', 'BMN']) ||
      voiceFlow.promptShown !== 'SessionManager, BMN' ||
      !voiceFlow.persistedInSettings ||
      !voiceFlow.recording.pastedOnce ||
      !voiceFlow.recording.commandNotRun ||
      !voiceFlow.recording.announced.includes('Transcript pasted') ||
      voiceFlow.fallback.modelChosenBefore !== 'small' ||
      voiceFlow.fallback.modelAfter !== 'base' ||
      !voiceFlow.fallback.vocabularyKept ||
      voiceFlow.fallback.modelAfterApproval !== 'base' ||
      !voiceFlow.editDuringRecording.savedWhileRecording ||
      !voiceFlow.editDuringRecording.secondPastedOnce ||
      !voiceFlow.restarted.notice.includes('nothing was pasted') ||
      voiceFlow.restarted.pastedIntoNewIncarnation ||
      !voiceFlow.noLiveSessionMessage.includes('Select a running session') ||
      !voiceFlow.download.firstStarted ||
      !voiceFlow.download.duplicateRefused ||
      !voiceFlow.download.progressShown ||
      !voiceFlow.download.cancelledReleased ||
      !voiceFlow.download.failureText.includes('connection reset') ||
      !voiceFlow.download.retryRefusedWhileErrorVisible ||
      !voiceFlow.download.dismissVisible ||
      !voiceFlow.download.dismissed ||
      !voiceFlow.download.dismissStayedDismissed ||
      !voiceFlow.download.modelRestored ||
      // Exactly two transfers were attempted: one held open and cancelled, one refused connection. The
      // refused duplicate and the pre-transfer paths never reach fetch.
      selfTestVoiceFetchCalls !== 2 ||
      selfTestVoiceTranscriptions.length !== 3 ||
      selfTestVoiceTranscriptions.some((run, index) =>
        JSON.stringify(run.vocabulary) !== JSON.stringify(expectedTranscriptions[index]) ||
        run.durationSeconds < 0.3 ||
        run.args.indexOf('--prompt') !== run.args.length - 2 ||
        run.args.at(-1) !== run.vocabulary.join(', ') ||
        run.args.filter((argument) => argument === '--prompt').length !== 1 ||
        run.args.includes('--carry-initial-prompt')) ||
      selfTestVoiceTranscriptions[0]!.args.at(-1) !== voiceFlow.promptShown
    ) {
      throw new Error(`the renderer did not complete the voice flow: ${JSON.stringify({ ...voiceFlow, transcriptions: selfTestVoiceTranscriptions })}`)
    }
    preloadProbe.attentionTriage.staleNoticeRejected = staleNoticeRejected
    preloadProbe.attentionTriage.revisedPromptPreserved = revisedPromptPreserved

    const selectedBeforeUnavailableTarget = (await client.request<LayoutGetResult>(
      METHOD_REGISTRY.layoutGet,
      { workspaceId: DEFAULT_WORKSPACE_ID }
    )).layout.selectedSessionId
    applicationWindow.webContents.send('aiterm:open-session', thirdSession.sessionId)
    const unavailableFeedback = await applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const probe = () => {
          const text = document.querySelector('.feedback-notice')?.textContent?.trim() ?? '';
          if (text === 'That session is unavailable. Refreshing attention items.') resolve(text);
          else if (Date.now() >= deadline) reject(new Error('unavailable target feedback was not rendered: ' + text));
          else setTimeout(probe, 25);
        };
        probe();
      })
    `) as string
    const selectedAfterUnavailableTarget = (await client.request<LayoutGetResult>(
      METHOD_REGISTRY.layoutGet,
      { workspaceId: DEFAULT_WORKSPACE_ID }
    )).layout.selectedSessionId
    preloadProbe.attentionTriage.unavailableTargetIgnored =
      unavailableFeedback.length > 0 && selectedAfterUnavailableTarget === selectedBeforeUnavailableTarget
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
    if (
      preloadProbe.crossWorkspaceSplit.layoutWorkspaceId !== DEFAULT_WORKSPACE_ID ||
      preloadProbe.crossWorkspaceSplit.sourceWorkspaceId !== secondWorkspace.workspaceId ||
      !preloadProbe.crossWorkspaceSplit.paneSessionIds.includes(thirdSession.sessionId) ||
      preloadProbe.crossWorkspaceSplit.selectedAfterFocus !== preloadProbe.treeSelection.sessionId ||
      !preloadProbe.crossWorkspaceSplit.sourceWorkspaceArchived ||
      !preloadProbe.crossWorkspaceSplit.foreignPaneRemovedAfterArchive
    ) {
      throw new Error(
        `the renderer did not keep a cross-workspace split in the active workspace: ${JSON.stringify(
          preloadProbe.crossWorkspaceSplit
        )}`
      )
    }
    const archivedWorkspace = (await client.request<WorkspaceRecord[]>(METHOD_REGISTRY.workspaceList, {
      includeArchived: true
    })).find((workspace) => workspace.workspaceId === secondWorkspace.workspaceId)
    if (!archivedWorkspace) throw new Error('the renderer archive action removed its workspace record')
    // Epic 11 AC1-AC4: a marker chosen from a workspace's own menu reaches only that workspace's rows
    // and panes, is stored with one revision bump, and moves no terminal geometry.
    const markers = preloadProbe.workspaceMarkers
    if (
      markers.before.localPane !== null ||
      markers.before.foreignPane !== null ||
      markers.foreignPaneAfterLocalChoice !== null ||
      markers.localPane !== 'teal' ||
      markers.foreignPane !== 'rose' ||
      markers.localSidebar !== 'teal' ||
      markers.foreignSidebar !== 'rose' ||
      markers.foreignPaneLabel !== `${secondWorkspace.name} workspace · Rose marker` ||
      markers.storedRevisions.local !== 1 ||
      markers.storedRevisions.foreign !== 1
    ) {
      throw new Error(
        `workspace markers did not follow their own workspace: ${JSON.stringify(markers)}`
      )
    }
    if (
      markers.grid.cols !== markers.before.grid.cols ||
      markers.grid.rows !== markers.before.grid.rows ||
      markers.localHeading !== markers.before.localHeading ||
      markers.foreignHeading !== markers.before.foreignHeading ||
      markers.before.localHeading <= 0
    ) {
      throw new Error(
        `choosing a workspace marker moved the pane geometry: ${JSON.stringify(markers)}`
      )
    }
    // Epic 12.2 AC1-AC4: the words are the reporter's, the detail opens both ways, and opening it
    // writes nothing to the PTY and leaves the terminal exactly the size it was.
    const evidenceSurface = preloadProbe.progressEvidenceSurface
    if (
      !evidenceSurface.reportedStrip.includes('Reported verified') ||
      !evidenceSurface.reportedStrip.includes('Evidence attached (1)') ||
      evidenceSurface.reportedStrip.includes('Verified ·') ||
      !evidenceSurface.bareStrip.includes('No evidence attached') ||
      !evidenceSurface.bareStrip.includes('Last observed failed') ||
      !evidenceSurface.dialog.title.startsWith('Progress — ') ||
      !evidenceSurface.dialog.note.includes('it does not check the work') ||
      !evidenceSurface.dialog.provenance.startsWith('Reported verified · from evidence · ') ||
      evidenceSurface.dialog.rowName !== 'checks.log' ||
      !evidenceSurface.dialog.rowAvailability.startsWith('text/plain · ') ||
      !evidenceSurface.dialog.previewText.includes('self-test: 3 checks passed') ||
      !evidenceSurface.focusReturnedToStrip ||
      !evidenceSurface.focusReturnedToMenuButton ||
      !evidenceSurface.openedFromPaneMenu ||
      !evidenceSurface.bareDialog.body.includes('No evidence attached to this report.')
    ) {
      throw new Error(`the progress detail did not read honestly: ${JSON.stringify(evidenceSurface)}`)
    }
    // Epic 5's four states must stay legible now that the word is a button, and the evidence word
    // must stay muted: no colour may endorse a claim.
    const inks = evidenceSurface.colours
    if (
      inks.verifiedInk !== inks.verifiedToken ||
      inks.failedInk !== inks.errorToken ||
      inks.evidenceInk !== inks.mutedToken ||
      inks.evidenceInk === inks.verifiedToken ||
      inks.verifiedContrast < 4.5 ||
      inks.evidenceContrast < 4.5
    ) {
      throw new Error(`the strip state button lost its palette: ${JSON.stringify(inks)}`)
    }
    const quiet = evidenceSurface.quiet
    if (
      quiet.inputEventsAfter !== quiet.inputEventsBefore ||
      quiet.surfaceHeightWhileOpen !== quiet.surfaceHeightBefore ||
      quiet.surfaceHeightAfter !== quiet.surfaceHeightBefore ||
      quiet.surfaceHeightBefore <= 0 ||
      quiet.gridAfter.cols !== quiet.gridBefore.cols ||
      quiet.gridAfter.rows !== quiet.gridBefore.rows
    ) {
      throw new Error(`opening the progress detail disturbed the terminal: ${JSON.stringify(quiet)}`)
    }
    // Epic 12.1 AC1-AC2 through the real CLI: one accepted report and four refusals, all or nothing.
    if (
      !progressEvidence?.sameIdOnRetry ||
      progressEvidence.state !== 'verified' ||
      progressEvidence.links.length !== 1 ||
      progressEvidence.links[0]?.artifactId !== progressEvidence.artifactId ||
      progressEvidence.links[0]?.name !== 'checks.log' ||
      JSON.stringify(progressEvidence.outcome) !== JSON.stringify([
        'accepted', 'refused-other-session', 'refused-input', 'refused-unknown', 'refused-duplicate', 'done'
      ])
    ) {
      throw new Error(`the evidence CLI contract did not hold: ${JSON.stringify(progressEvidence)}`)
    }
    // AC1 again, at the inspector: every strip site says whether anything backs the word.
    if (!preloadProbe.attentionTriage.detailsProgressText.includes('No evidence attached')) {
      throw new Error(
        `the inspector strip kept the old word: ${preloadProbe.attentionTriage.detailsProgressText}`
      )
    }
    if (archivedWorkspace.marker !== 'rose') {
      throw new Error(
        `archiving a workspace dropped its marker: ${JSON.stringify(archivedWorkspace)}`
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
    // Epic 26.2: the quit row's saved-output column is not claimed here — driving the real
    // beforeQuit would quit the app mid-test, so the flush-before-stop order for the quit cause
    // rests on the lifecycle unit tests (host-loss.test.ts, flush before beforeQuit's stop) and on
    // the same captureThen the close and explicit endings exercise in this run through the real
    // lifecycle.
    /**
     * Epic 17.1 AC2: this stop is mid-run, which only a self-test can arrange, so the offer is
     * recorded as made here. What the renderer restart below then proves is the rule itself: a
     * cohort BMN has already asked about never asks again by itself.
     */
    const quitCohortBeforeRestart = await client.request<InterruptedSessionCohort | null>(
      METHOD_REGISTRY.sessionCohortList,
      {}
    )
    if (quitCohortBeforeRestart?.cause !== 'application-quit') {
      throw new Error(
        `the application-quit stop did not form a resumable cohort: ${JSON.stringify(quitCohortBeforeRestart)}`
      )
    }
    const quitCohortOffer = await client.request<SessionCohortOfferedResult>(
      METHOD_REGISTRY.sessionCohortOffered,
      { cohortId: quitCohortBeforeRestart.cohortId }
    )

    console.error('[BMN] self-test phase: inactive workspace following output')
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
    await withinPhase('type into existing attachment', applicationWindow.webContents.executeJavaScript(`
      window.aiTerminal.sendTerminalInput(
        ${JSON.stringify(inactiveAttachmentId)},
        new TextEncoder().encode(${JSON.stringify(
          "for line in $(seq 1 80); do echo \"inactive-following-output-$line\"; done; printf 'AITERM-2-1-%s\\n' INACTIVE-FOLLOWING-DONE\r"
        )})
      );
      true;
    `))
    console.error('[BMN] self-test phase: inactive workspace output requested')
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
    console.error('[BMN] self-test phase: inactive workspace output captured')
    await rendererPause(500)
    const inactiveFollowingOutputLayoutPuts = selfTestLayoutPutRequests - layoutPutsBeforeOutput
    console.error(`[BMN] self-test phase: inactive workspace output layout puts ${inactiveFollowingOutputLayoutPuts}`)
    if (inactiveFollowingOutputLayoutPuts !== 0) {
      throw new Error(
        `output to a following session of an inactive workspace issued ${inactiveFollowingOutputLayoutPuts} layout.put request(s)`
      )
    }
    const showArchivedReachable = await applicationWindow.webContents.executeJavaScript(
      "document.body.innerText.includes('Show archived')"
    ) as boolean
    console.error('[BMN] self-test phase: agent handoff and OpenCode acceptance')
    const acceptanceWait = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const value = await read()
        if (value !== undefined) return value
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`acceptance timed out: ${label}`)
    }
    const acceptanceWindow = applicationWindow
    if (!acceptanceWindow) throw new Error('the acceptance window is unavailable')
    const inspectHarnessObservation = async (
      sessionId: string, sessionName: string, agentName: string, eventName: string,
      recover = true
    ): Promise<{ observed: boolean; openedEvents: boolean; ptyInputUnchanged: boolean; attentionUnchanged: boolean }> => {
      if (recover) await recoverApplicationRenderer(acceptanceWindow)
      return acceptanceWindow.webContents.executeJavaScript(`(async () => {
        const wait = async (read, name) => { const end = Date.now() + 10000; while (Date.now() < end) {
          const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
        } throw new Error('harness observation timed out: ' + name); };
        const sessionId = ${JSON.stringify(sessionId)};
        const beforeRequests = (await window.aiTerminal.listAttention()).length;
        (await wait(() => document.querySelector('[aria-label="Actions for ${sessionName}"]'), 'session menu')).click();
        (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
          .find(row => row.textContent.trim() === 'Session details'), 'details action')).click();
        const view = await wait(() => {
          const current = document.querySelector('.session-inspector .hook-observation');
          return current?.textContent.includes('Observed by BMN') ? current : null;
        }, 'observed summary');
        const observed = view.textContent.includes(${JSON.stringify(agentName)}) &&
          view.textContent.includes(${JSON.stringify(eventName)}) &&
          view.textContent.includes(${JSON.stringify(sessionName)}) && view.textContent.includes('run ');
        const beforeInput = window.__aitermTest.snapshots()[sessionId]?.inputEvents ?? 0;
        (await wait(() => [...view.querySelectorAll('button')]
          .find(button => button.textContent === 'Open Hook events'), 'Hook events link')).click();
        const dialog = await wait(() => document.querySelector('dialog.hook-events-dialog[open]'), 'Hook events dialog');
        const openedEvents = await wait(() =>
          dialog.textContent.includes(${JSON.stringify(eventName)}) ? true : undefined, 'the events to render');
        dialog.querySelector('.app-dialog-heading button').click();
        await wait(() => !document.querySelector('dialog.hook-events-dialog') ? true : null, 'Hook events close');
        document.querySelector('.session-inspector .panel-heading button')?.click();
        await wait(() => !document.querySelector('.session-inspector') ? true : null, 'Session details close');
        return { observed, openedEvents, ptyInputUnchanged:
            (window.__aitermTest.snapshots()[sessionId]?.inputEvents ?? 0) === beforeInput,
          attentionUnchanged: (await window.aiTerminal.listAttention()).length === beforeRequests };
      })()`) as Promise<{ observed: boolean; openedEvents: boolean; ptyInputUnchanged: boolean; attentionUnchanged: boolean }>
    }
    const destinationHarness = writeTerminalModeProgram(join(isolatedCwd, 'petition-destination'))
    const petitionDestination = await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Petition destination', cwd: isolatedCwd, executable: destinationHarness.executable,
      argv: [], cols: 80, rows: 24 }, true)
    const petitionDirectory = join(isolatedCwd, 'petition-source')
    const petitionText = 'Synthetic agent handoff result'
    const petitionExecutable = writeAcceptanceHarness(petitionDirectory, 'petition', [
      "writeFileSync(file('petition-result.txt'), 'Published by the petition source\\n')",
      "const published = JSON.parse(cli(['publish', file('petition-result.txt'), '--key', 'electron-petition-file', '--json']))",
      "writeFileSync(file('published.json'), JSON.stringify(published))",
      `writeFileSync(file('prepared.json'), cli(['handoff', ${JSON.stringify(petitionDestination.session.sessionId)}, '--text', ${JSON.stringify(petitionText)}, '--file-id', published.artifactId, '--key', 'electron-petition', '--json']))`,
      "await wait('status-gate')",
      "writeFileSync(file('status.txt'), cli(['handoff', 'status']))",
      "writeFileSync(file('snapshot.json'), cli(['snapshot', '--json']))"
    ])
    const petitionSource = await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Petition source', cwd: isolatedCwd, executable: petitionExecutable,
      argv: [], cols: 80, rows: 24 }, true)
    await untilFileExists(join(petitionDirectory, 'prepared.json'), 'prepared an agent handoff')
    const petitionPublished = JSON.parse(readFileSync(join(petitionDirectory, 'published.json'), 'utf8')) as { artifactId: string }
    const petitionRequest = await acceptanceWait(async () =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .find(row => row.sessionId === petitionSource.session.sessionId && row.kind === 'handoff' && row.state === 'open'), 'source handoff request')
    await recoverApplicationRenderer(applicationWindow)
    const beforeResultsInput = terminalModeProgramInput(destinationHarness.input)
    const workspaceResultsUi = await applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read, name) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('workspace results timed out: ' + name); };
      const refits = () => JSON.stringify(Object.fromEntries(Object.entries(window.__aitermTest.snapshots())
        .map(([id, row]) => [id, row.refits])));
      await wait(() => {
        const snapshots = window.__aitermTest.snapshots();
        return snapshots[${JSON.stringify(petitionSource.session.sessionId)}] &&
          snapshots[${JSON.stringify(petitionDestination.session.sessionId)}] ? true : null;
      }, 'recovered petition panes');
      let settled = false;
      let previous = '';
      let unchangedSince = Date.now();
      const settleDeadline = Date.now() + 10000;
      while (!settled && Date.now() < settleDeadline) {
        const current = refits();
        if (current !== previous) { previous = current; unchangedSince = Date.now(); }
        else if (Date.now() - unchangedSince >= 1000) settled = true;
        if (!settled) await new Promise(r => setTimeout(r, 25));
      }
      if (!settled) throw new Error('recovered terminal layout did not settle before results read');
      const beforeRefits = refits();
      const requestBefore = (await window.aiTerminal.listAttention())
        .find(row => row.requestId === ${JSON.stringify(petitionRequest.requestId)});
      const menuButton = await wait(() => [...document.querySelectorAll('.workspace-group')]
        .find(group => group.textContent.includes('Petition source'))?.querySelector('.row-menu-button'), 'workspace menu');
      const openResults = async () => {
        menuButton.click();
        (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
          .find(row => row.textContent.trim() === 'Review results…'), 'results action')).click();
        return wait(() => {
          const dialog = document.querySelector('dialog.workspace-results-dialog[open]');
          return dialog?.querySelector('.workspace-results-handoffs') ? dialog : null;
        }, 'results dialog');
      };
      let dialog = await openResults();
      const refitsAfterOpen = refits();
      const report = [...dialog.querySelectorAll('.workspace-results-sessions > li > ul > li')]
        .find(row => row.textContent.includes('Self-test checks passed'));
      const reportShown = !!report && report.textContent.includes('Reported verified') &&
        report.textContent.includes('evidence');
      const evidenceShown = !!report && report.textContent.includes('checks.log');
      const handoff = [...dialog.querySelectorAll('.workspace-results-handoffs > li')]
        .find(row => row.textContent.includes('Petition source') && row.textContent.includes('Petition destination'));
      const pendingHandoffShown = !!handoff && handoff.textContent.includes('Saved draft') &&
        handoff.textContent.includes('Prepared by the agent');
      report?.querySelector('button')?.click();
      const progress = await wait(() => document.querySelector('dialog.progress-evidence-dialog[open]'), 'progress details');
      const progressMatches = progress.textContent.includes('Self-test checks passed') &&
        progress.textContent.includes('checks.log');
      progress.querySelector('.app-dialog-heading button').click();
      await wait(() => !document.querySelector('dialog.progress-evidence-dialog') ? true : null, 'progress close');
      const refitsAfterRead = refits();
      if (beforeRefits !== refitsAfterRead) {
        throw new Error('results or progress detail refit after recovery: ' +
          JSON.stringify({ beforeRefits, afterOpen: refitsAfterOpen, refitsAfterRead }));
      }
      dialog = await openResults();
      const review = [...dialog.querySelectorAll('.workspace-results-handoffs > li')]
        .find(row => row.textContent.includes('Petition source') && row.textContent.includes('Petition destination'));
      review?.querySelector('button')?.click();
      const form = await wait(() => document.querySelector('.handoff-form'), 'exact handoff review');
      const exactDraftReviewed = form.querySelector('textarea')?.value === ${JSON.stringify(petitionText)} &&
        form.querySelector('select')?.value === ${JSON.stringify(petitionDestination.session.sessionId)};
      form.querySelector('button[type="button"]')?.click();
      document.querySelector('.files-close')?.click();
      const requestAfter = (await window.aiTerminal.listAttention())
        .find(row => row.requestId === ${JSON.stringify(petitionRequest.requestId)});
      return { reportShown: reportShown && progressMatches, evidenceShown, pendingHandoffShown,
        exactDraftReviewed, attentionUnchanged: requestBefore?.state === 'open' &&
          requestAfter?.state === 'open' && requestBefore.revision === requestAfter.revision,
        terminalRefitsUnchanged: true };
    })()`) as {
      reportShown: boolean; evidenceShown: boolean; pendingHandoffShown: boolean;
      exactDraftReviewed: boolean; attentionUnchanged: boolean; terminalRefitsUnchanged: boolean
    }
    const workspaceResultsAcceptance = {
      ...workspaceResultsUi,
      ptyInputUnchanged: terminalModeProgramInput(destinationHarness.input) === beforeResultsInput
    }
    if (Object.values(workspaceResultsAcceptance).some((value) => value !== true)) {
      throw new Error(`workspace results did not read and review safely: ${JSON.stringify(workspaceResultsAcceptance)}`)
    }
    const beforePetitionPaste = terminalModeProgramInput(destinationHarness.input)
    const petitionEditor = await applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('petition UI timed out'); };
      (await wait(() => document.querySelector('.needs-you-button'))).click();
      const row = await wait(() => [...document.querySelectorAll('.attention-item')].find(r => r.textContent.includes('Petition source') && r.textContent.includes('Handoff')));
      const provenance = row.querySelector('.provenance').textContent;
      [...row.querySelectorAll('button')].find(b => b.textContent === 'Open handoff').click();
      const form = await wait(() => document.querySelector('.handoff-form'));
      const result = { destination: form.querySelector('select').value, text: form.querySelector('textarea').value, byline: form.textContent, provenance,
        fileListed: form.textContent.includes('petition-result.txt') };
      [...form.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click();
      const card = await wait(() => [...document.querySelectorAll('.handoff-card')].find(r => r.textContent.includes(${JSON.stringify(petitionText)})));
      [...card.querySelectorAll('button')].find(b => b.textContent === 'Open destination').click();
      const paste = await wait(() => [...document.querySelectorAll('.handoff-card button')].find(b => b.textContent === 'Paste handoff' && !b.disabled));
      paste.click(); return result;
    })()`) as { destination: string; text: string; byline: string; provenance: string; fileListed: boolean }
    const petitionResolved = await acceptanceWait(async () =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .find(row => row.requestId === petitionRequest.requestId && row.state !== 'open'), 'owner paste resolution')
    const petitionPayload = await acceptanceWait(async () => {
      const input = terminalModeProgramInput(destinationHarness.input).slice(beforePetitionPaste.length)
      return input.includes(petitionText) ? input : undefined
    }, 'destination PTY paste')
    writeFileSync(join(petitionDirectory, 'status-gate'), '')
    await untilFileExists(join(petitionDirectory, 'snapshot.json'), 'read bounded handoff status')
    const petitionSnapshot = JSON.parse(readFileSync(join(petitionDirectory, 'snapshot.json'), 'utf8'))
    const agentHandoff = {
      preparedWithoutDelivery: !beforePetitionPaste.includes(petitionText),
      ...petitionEditor, destinationMatches: petitionEditor.destination === petitionDestination.session.sessionId,
      state: petitionResolved.state, resolvedBy: petitionResolved.resolvedBy, resolution: petitionResolved.resolution,
      payloadOccurrences: petitionPayload.split(petitionText).length - 1,
      agentOwnerStamp: petitionPayload.includes('prepared by the agent, delivered by the owner'),
      publishedFile: petitionEditor.fileListed && petitionPayload.includes('- petition-result.txt: ') &&
        petitionPayload.includes(petitionPublished.artifactId),
      bracketedPaste: petitionPayload.includes('\u001b[200~') && petitionPayload.includes('\u001b[201~'),
      noSubmit: !petitionPayload.includes('\r'),
      status: readFileSync(join(petitionDirectory, 'status.txt'), 'utf8'),
      bounded: petitionSnapshot.handoffs?.length === 1 &&
        JSON.stringify(Object.keys(petitionSnapshot.handoffs[0]).sort()) === JSON.stringify(['destinationSessionId', 'draftId', 'state', 'updatedAt'])
    }
    // The raw-mode synthetic receiver records the exact PTY bytes for this owner-confirmed file send.
    const beforeFileReferenceWire = terminalModeProgramInput(destinationHarness.input)
    const fileReferenceWireUi = await applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read, label) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('file reference wire probe: ' + label); };
      const setInput = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true
      }));
      const palette = await wait(() => document.querySelector('.command-palette input'), 'palette');
      setInput(palette, 'Open file reference');
      await wait(() => document.querySelector('#palette-file-reference[aria-selected="true"]'), 'command');
      palette.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const dialog = await wait(() => document.querySelector('dialog.file-reference-dialog[open]'), 'dialog');
      const input = await wait(() => dialog.querySelector('input[aria-label="File reference"]'), 'reference input');
      setInput(input, 'refs/src/parser.ts:42:7');
      input.closest('form').requestSubmit();
      await wait(() => dialog.querySelector('.file-reference-line'), 'file ready');
      const chooser = await wait(() => dialog.querySelector('select[aria-label="Send to session"]'), 'chooser');
      chooser.value = ${JSON.stringify(petitionDestination.session.sessionId)};
      chooser.dispatchEvent(new Event('change', { bubbles: true }));
      const review = await wait(() => [...dialog.querySelectorAll('button')]
        .find(button => button.textContent.trim() === 'Review send…' && !button.disabled), 'review');
      review.click();
      const preview = await wait(() => dialog.querySelector('.file-reference-send-preview'), 'preview');
      const payloadShown = preview.querySelector('pre')?.textContent ?? '';
      const targetShown = preview.textContent ?? '';
      [...preview.querySelectorAll('button')].find(button => button.textContent.trim() === 'Paste reference').click();
      const feedback = await wait(() => {
        const error = dialog.querySelector('[role="alert"]')?.textContent?.trim();
        if (error) throw new Error('paste rejected: ' + error);
        const text = dialog.querySelector('.file-reference-feedback')?.textContent?.trim();
        return text?.includes('not submitted') ? text : null;
      }, 'receipt');
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      return { payloadShown, targetShown, feedback };
    })()`) as { payloadShown: string; targetShown: string; feedback: string }
    const fileReferenceWirePayload = `${referencedFile}:42:7`
    const fileReferenceWireBytes = await acceptanceWait(async () => {
      const input = terminalModeProgramInput(destinationHarness.input).slice(beforeFileReferenceWire.length)
      return input.includes(fileReferenceWirePayload) ? input : undefined
    }, 'file-reference PTY bytes')
    const fileReferenceWire = {
      payloadExact: fileReferenceWireUi.payloadShown === fileReferenceWirePayload,
      targetNamed: fileReferenceWireUi.targetShown.includes('Petition destination') &&
        fileReferenceWireUi.targetShown.includes(petitionDestination.startup.incarnationId),
      receiptShown: fileReferenceWireUi.feedback.includes('not submitted'),
      exactPaste: fileReferenceWireBytes.includes(`\x1b[200~${fileReferenceWirePayload}\x1b[201~`),
      noEnter: !fileReferenceWireBytes.includes('\r'),
      onePaste: fileReferenceWireBytes.split(fileReferenceWirePayload).length - 1 === 1
    }
    if (Object.values(fileReferenceWire).some((value) => value !== true)) {
      throw new Error(`the file-reference wire proof failed: ${JSON.stringify(fileReferenceWire)}`)
    }
    const openCodeDirectory = join(isolatedCwd, 'opencode-acceptance')
    const openCodeReference = 'ses_0123456789abSyntheticTest0'
    const openCodeExecutable = writeAcceptanceHarness(openCodeDirectory, 'opencode', [
      `const sessionID = ${JSON.stringify(openCodeReference)}`,
      "const event = (hook_event_name, props = {}) => cli(['hook', 'opencode'], JSON.stringify({ hook_event_name, sessionID, ...props }))",
      "event('session.created', { info: { id: sessionID } })",
      "event('permission.asked', { permission: 'bash', patterns: ['echo acceptance'] })",
      "writeFileSync(file('opened'), '')",
      "await wait('reply-gate')",
      "event('permission.replied', { reply: 'once' })",
      "event('session.idle')",
      "writeFileSync(file('finished'), '')"
    ])
    const openCodeSession = await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'OpenCode acceptance', cwd: isolatedCwd, executable: openCodeExecutable,
      argv: ['--model', 'fixture/model'], cols: 80, rows: 24 }, true)
    await untilFileExists(join(openCodeDirectory, 'opened'), 'opened OpenCode permission')
    const openCodePermission = await acceptanceWait(async () =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .find(row => row.sessionId === openCodeSession.session.sessionId && row.kind === 'permission' && row.state === 'open'), 'OpenCode permission')
    await recoverApplicationRenderer(applicationWindow)
    const openCodeProvenance = await applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('OpenCode provenance UI timed out'); };
      (await wait(() => document.querySelector('.needs-you-button'))).click();
      const row = await wait(() => [...document.querySelectorAll('.attention-item')]
        .find(r => r.textContent.includes('OpenCode asks to bash')));
      const provenance = row.querySelector('.provenance').textContent;
      document.querySelector('.needs-you-button').click();
      return provenance;
    })()`) as string
    writeFileSync(join(openCodeDirectory, 'reply-gate'), '')
    await untilFileExists(join(openCodeDirectory, 'finished'), 'finished OpenCode events')
    const openCodeRequests = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .filter(row => row.sessionId === openCodeSession.session.sessionId)
    const openCodeBinding = await client.request<PersistedConversationBinding>(METHOD_REGISTRY.sessionBindingGet, { sessionId: openCodeSession.session.sessionId })
    const openCodeEvents = await client.request<Array<{ agent: string; event: string; effects: string[] }>>(METHOD_REGISTRY.hookEventsList, { sessionId: openCodeSession.session.sessionId })
    const openCodeObservationUi = await inspectHarnessObservation(
      openCodeSession.session.sessionId, 'OpenCode acceptance', 'OpenCode', 'session.idle', false
    )
    if (Object.values(openCodeObservationUi).some((value) => value !== true)) {
      throw new Error(`OpenCode observation view failed: ${JSON.stringify(openCodeObservationUi)}`)
    }
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: openCodeSession.session.sessionId,
      incarnationId: openCodeSession.session.lastProcess?.incarnationId, cause: 'explicit' })
    const openCodePreview = await client.request<{ command: string }>(METHOD_REGISTRY.sessionResumePreview, { sessionId: openCodeSession.session.sessionId })
    const openCodeResumed = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionResume, { sessionId: openCodeSession.session.sessionId, cols: 80, rows: 24 })
    const openCodeArguments = await untilHarnessRuns(join(openCodeDirectory, 'argv.log'), 2)
    const openCodeAcceptance = {
      provenance: openCodeProvenance,
      openedBy: openCodePermission.openedBy,
      resolvedBy: openCodeRequests.find(row => row.requestId === openCodePermission.requestId)?.resolvedBy,
      permissionState: openCodeRequests.find(row => row.requestId === openCodePermission.requestId)?.state,
      notice: openCodeRequests.some(row => row.kind === 'notice' && row.title === 'OpenCode finished a turn'),
      events: openCodeEvents, binding: openCodeBinding, preview: openCodePreview.command,
      resumedArguments: openCodeArguments[1]
    }
    for (const stopped of [
      { sessionId: petitionSource.session.sessionId, incarnationId: petitionSource.session.lastProcess?.incarnationId },
      { sessionId: petitionDestination.session.sessionId, incarnationId: petitionDestination.session.lastProcess?.incarnationId },
      { sessionId: openCodeResumed.sessionId, incarnationId: openCodeResumed.incarnationId }
    ]) await client.request(METHOD_REGISTRY.sessionStop, { ...stopped, cause: 'explicit' })

    console.error('[BMN] self-test phase: Cursor terminal agent')
    // Payloads shaped like the recorded ones (utility/test-fixtures/cursor), sent through the real `bmn hook cursor`.
    const cursorChat = 'c741bb07-352f-457b-8e7c-ee00517cd9ff'
    const cursorEvents = [
      `const conversation_id = ${JSON.stringify(cursorChat)}`,
      "const base = { conversation_id, session_id: conversation_id, generation_id: 'gen-1', model: 'default', cursor_version: '2026.09.26-dd393fe', workspace_roots: [process.cwd()], user_email: 'owner@example.com', transcript_path: null }",
      "const event = (hook_event_name, props = {}) => cli(['hook', 'cursor'], JSON.stringify({ ...base, hook_event_name, ...props }))"
    ]
    const cursorDirectory = join(isolatedCwd, 'cursor-acceptance')
    const cursorExecutable = writeAcceptanceHarness(cursorDirectory, 'cursor-agent', [
      ...cursorEvents,
      "if (process.argv.slice(2).some((argument) => argument.startsWith('--resume='))) {",
      "  event('beforeSubmitPrompt', { prompt: 'again' })",
      "  writeFileSync(file('resumed'), '')",
      "  return",
      "}",
      "event('sessionStart', { is_background_agent: false, composer_mode: 'agent' })",
      "event('beforeSubmitPrompt', { prompt: 'hello' })",
      "event('postToolUse', { tool_name: 'Shell', tool_input: { command: 'true' } })",
      "event('stop', { status: 'completed', loop_count: 0 })",
      "writeFileSync(file('finished'), '')"
    ])
    const cursorSession = await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Cursor acceptance', cwd: isolatedCwd, executable: cursorExecutable,
      argv: ['--model', 'fixture-model', '--force'], cols: 80, rows: 24 }, true)
    await untilFileExists(join(cursorDirectory, 'finished'), 'finished Cursor events')
    const cursorNotice = await acceptanceWait(async () =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .find(row => row.sessionId === cursorSession.session.sessionId && row.kind === 'notice' && row.state === 'open'), 'Cursor turn notice')
    await recoverApplicationRenderer(applicationWindow)
    const cursorNeedsYou = await applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('Cursor Needs you row timed out'); };
      (await wait(() => document.querySelector('.needs-you-button'))).click();
      const row = await wait(() => [...document.querySelectorAll('.attention-item')]
        .find(r => r.textContent.includes('Cursor finished its turn')));
      const provenance = row.querySelector('.provenance')?.textContent ?? null;
      document.querySelector('.needs-you-button').click();
      return { shown: true, provenance };
    })()`) as { shown: boolean; provenance: string | null }
    const cursorBinding = await client.request<PersistedConversationBinding>(METHOD_REGISTRY.sessionBindingGet, { sessionId: cursorSession.session.sessionId })
    const cursorEventLog = await client.request<Array<{ agent: string; event: string; effects: string[] }>>(METHOD_REGISTRY.hookEventsList, { sessionId: cursorSession.session.sessionId })
    // The owner's way: cursor-agent typed into a shell. The chip says "Shell" until Cursor's own hooks report.
    const cursorShellDirectory = join(isolatedCwd, 'cursor-shell-acceptance')
    const cursorShellHarness = writeAcceptanceHarness(cursorShellDirectory, 'cursor-in-shell', [
      ...cursorEvents,
      "event('sessionStart', { is_background_agent: false, composer_mode: 'agent' })",
      "event('stop', { status: 'completed', loop_count: 0 })",
      "writeFileSync(file('finished'), '')"
    ])
    const cursorShell = await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Cursor in a shell', cwd: isolatedCwd, executable: '/bin/bash',
      argv: ['-c', cursorShellHarness], cols: 80, rows: 24 }, true)
    await untilFileExists(join(cursorShellDirectory, 'finished'), 'finished shell Cursor events')
    await recoverApplicationRenderer(applicationWindow)
    const cursorChip = await modelOriginProbe(applicationWindow, cursorShell.session.sessionId, 'Cursor in a shell', 'default')
    const cursorShellBinding = await client.request<PersistedConversationBinding>(METHOD_REGISTRY.sessionBindingGet, { sessionId: cursorShell.session.sessionId })
    // Resume reopens the chat Cursor reported; its chat folder lives in the self-test's own home.
    mkdirSync(join(selfTestHistoryRoots()!.home, '.cursor', 'chats', 'self-test-workspace', cursorChat), { recursive: true })
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: cursorSession.session.sessionId,
      incarnationId: cursorSession.session.lastProcess?.incarnationId, cause: 'explicit' })
    const cursorPreview = await client.request<{ command: string; notCarried: string }>(METHOD_REGISTRY.sessionResumePreview, { sessionId: cursorSession.session.sessionId })
    const cursorResumed = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionResume, { sessionId: cursorSession.session.sessionId, cols: 80, rows: 24 })
    const cursorArguments = await untilHarnessRuns(join(cursorDirectory, 'argv.log'), 2)
    await untilFileExists(join(cursorDirectory, 'resumed'), 'the resumed Cursor prompt')
    const cursorAcceptance = {
      notice: cursorNotice.title, openedBy: cursorNotice.openedBy, needsYou: cursorNeedsYou,
      binding: cursorBinding, events: cursorEventLog, chip: cursorChip.rowChip, paneChip: cursorChip.paneChip,
      modelRow: cursorChip.modelRow, shellBinding: cursorShellBinding.status,
      preview: cursorPreview.command, notCarried: cursorPreview.notCarried, resumedArguments: cursorArguments[1]
    }
    for (const stopped of [
      { sessionId: cursorResumed.sessionId, incarnationId: cursorResumed.incarnationId },
      { sessionId: cursorShell.session.sessionId, incarnationId: cursorShell.session.lastProcess?.incarnationId }
    ]) await client.request(METHOD_REGISTRY.sessionStop, { ...stopped, cause: 'explicit' })

    console.error('[BMN] self-test phase: subagent routing and repeat watch')
    const dormantSidebar = await applicationWindow.webContents.executeJavaScript(`(async () => {
      const button = document.querySelector('button[data-session-id="${petitionDestination.session.sessionId}"]');
      if (!button) throw new Error('dormant sidebar fixture missing');
      button.click();
      // Selection focuses its terminal in a React effect; let that effect finish before this
      // keyboard probe explicitly focuses the sidebar button.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      button.focus();
      const row = button.closest('.session-row');
      const end = Date.now() + 10000;
      while (row.dataset.live !== 'false' || row.querySelector('.unread-mark')) {
        if (Date.now() >= end) throw new Error('dormant row did not settle');
        await new Promise(r => setTimeout(r, 25));
      }
      const sample = document.createElement('span'); sample.style.color = 'var(--muted)'; row.append(sample);
      const muted = getComputedStyle(sample).color; sample.remove();
      return { live: row.dataset.live, colour: getComputedStyle(row.querySelector('.session-name')).color, muted };
    })()`) as { live: string; colour: string; muted: string }
    applicationWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 400 })
    applicationWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    applicationWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    const dormantMenu = await acceptanceWait(async () =>
      await applicationWindow!.webContents.executeJavaScript(`(() => {
        const menu = document.querySelector('[aria-label="Actions for Petition destination"]');
        if (document.activeElement !== menu) return undefined;
        return { focused: true, opacity: getComputedStyle(menu).opacity, hovered: menu.closest('.session-row').matches(':hover') };
      })()`) as { focused: boolean; opacity: string; hovered: boolean } | undefined, 'Tab to dormant session actions')
      .catch(async (error: unknown) => {
        const diagnostic = await applicationWindow!.webContents.executeJavaScript(`(() => ({
          active: document.activeElement?.outerHTML.slice(0, 260) ?? null,
          menu: document.querySelector('[aria-label="Actions for Petition destination"]')?.outerHTML.slice(0, 260) ?? null,
          button: document.querySelector('button[data-session-id="${petitionDestination.session.sessionId}"]')?.outerHTML.slice(0, 260) ?? null,
          dialogs: [...document.querySelectorAll('dialog[open]')].map(row => row.getAttribute('aria-label')),
          detailsOpen: !!document.querySelector('.session-inspector')
        }))()`)
        throw new Error(`Tab to dormant session actions diagnostic: ${JSON.stringify(diagnostic)}`, { cause: error })
      })
    const quietSidebarAcceptance = { ...dormantSidebar, ...dormantMenu }
    const routingWorkspace = await client.request<WorkspaceRecord>(METHOD_REGISTRY.workspaceCreate, {
      name: 'Routing acceptance B', defaultCwd: isolatedCwd, position: 20
    })
    const routingDirectory = join(isolatedCwd, 'routing-acceptance')
    const routingExecutable = writeAcceptanceHarness(routingDirectory, 'opencode', [
      "process.env.BMN_OPENCODE_SESSION_ID = 'ses_main'",
      "const event = (hook_event_name, props = {}) => cli(['hook', 'opencode'], JSON.stringify({ hook_event_name, sessionID: 'ses_main', ...props }))",
      "event('permission.asked', { permission: 'main-tool' })",
      "event('permission.asked', { sessionID: 'ses_child', permission: 'child-tool', patterns: ['child-pattern'] })",
      "event('question.asked', { sessionID: 'ses_child', questions: [{ question: 'Child routing question?' }] })",
      "event('session.status', { status: { type: 'busy' } })",
      "event('permission.asked', { permission: 'main-tool' })",
      "writeFileSync(file('opened'), '')",
      "await wait('reply')",
      "event('permission.replied', { sessionID: 'ses_child', reply: 'once' })",
      "event('question.rejected', { sessionID: 'ses_child' })",
      "event('permission.replied', { reply: 'reject' })",
      "writeFileSync(file('resolved'), '')"
    ])
    const routingSession = await createSessionRuntime({ workspaceId: routingWorkspace.workspaceId,
      name: 'Child routing', cwd: isolatedCwd, executable: routingExecutable, argv: [], cols: 80, rows: 24 }, true)
    await untilFileExists(join(routingDirectory, 'opened'), 'child permission and question after parent busy')
    const routingRequests = async () => (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .filter(row => row.sessionId === routingSession.session.sessionId)
    const routingOpened = await routingRequests()
    await recoverApplicationRenderer(applicationWindow)
    const workspaceAttentionOpened = await applicationWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('button[data-session-id="${petitionDestination.session.sessionId}"]')?.click();
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        const row = document.querySelector('.workspace-group[aria-label="Routing acceptance B"] .workspace-row');
        if (row?.querySelector('.status-dot.needs-you')) return {
          dot: true, text: row.querySelector('.visually-hidden')?.textContent,
          selectedInA: !!document.querySelector('button[data-session-id="${petitionDestination.session.sessionId}"][aria-current="true"]')
        };
        await new Promise(r => setTimeout(r, 25));
      } throw new Error('workspace B attention dot missing');
    })()`) as { dot: boolean; text: string; selectedInA: boolean }
    writeFileSync(join(routingDirectory, 'reply'), '')
    await untilFileExists(join(routingDirectory, 'resolved'), 'matching child replies')
    const routingResolved = await routingRequests()
    const workspaceAttentionCleared = await acceptanceWait(async () =>
      await applicationWindow!.webContents.executeJavaScript(`(() => {
        const row = document.querySelector('.workspace-group[aria-label="Routing acceptance B"] .workspace-row');
        return row && !row.querySelector('.status-dot.needs-you') && !row.querySelector('.visually-hidden') ? true : undefined;
      })()`) as true | undefined, 'workspace B attention cleared')
    const subagentAcceptance = {
      open: routingOpened.map(({ requestKey, kind, title, body, state }) => ({ requestKey, kind, title, body, state })),
      resolved: routingResolved.map(({ requestKey, state, resolvedBy }) => ({ requestKey, state, resolvedBy })),
      workspaceAttentionOpened, workspaceAttentionCleared
    }
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: routingSession.session.sessionId,
      incarnationId: routingSession.session.lastProcess?.incarnationId, cause: 'explicit' })

    const repeatDirectory = join(isolatedCwd, 'repeat-acceptance')
    // The Claude capability probe runs --help without a session credential; only the real PTY may publish markers.
    const repeatExecutable = writeAcceptanceHarness(repeatDirectory, 'claude', [
      "if (process.argv.includes('--help')) process.exit(0)",
      "const event = (hook_event_name) => spawnSync('bmn', ['hook', 'claude'], { input: JSON.stringify({ hook_event_name, tool_name: 'Bash', tool_input: { command: 'synthetic-repeat' }, tool_response: { output: 'fixture' } }), stdio: ['pipe', 'ignore', 'ignore'] })",
      "for (let i = 0; i < 3; i++) event('PostToolUse')",
      "writeFileSync(file('three'), '')",
      "await wait('eight-gate')",
      "for (let i = 3; i < 8; i++) event('PostToolUse')",
      "writeFileSync(file('eight'), '')",
      "await wait('reset-gate')",
      "event('UserPromptSubmit')",
      "writeFileSync(file('reset'), '')"
    ])
    const repeatSession = await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Repeat acceptance', cwd: isolatedCwd, executable: repeatExecutable, argv: [], cols: 80, rows: 24 }, true)
    await untilFileExists(join(repeatDirectory, 'three'), 'three repeated calls')
    const repeatBeforeUi = await client.request<Array<{ event: string; toolName: string | null; repeat: number | null; effects: string[] }>>(
      METHOD_REGISTRY.hookEventsList, { sessionId: repeatSession.session.sessionId })
    if (JSON.stringify(repeatBeforeUi.map(({ repeat }) => repeat)) !== '[1,2,3]') {
      throw new Error(`the three real hook calls were not counted: ${JSON.stringify(repeatBeforeUi)}`)
    }
    await recoverApplicationRenderer(applicationWindow)
    const repeatLogProbe = await applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read, label) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('repeat log UI timed out: ' + label); };
      (await wait(() => document.querySelector('button[data-session-id="${repeatSession.session.sessionId}"]'), 'session row')).click();
      await wait(() => window.__aitermTest?.snapshots()?.['${repeatSession.session.sessionId}'], 'terminal snapshot');
      (await wait(() => document.querySelector('[aria-label="Actions for Repeat acceptance"]'), 'row menu')).click();
      (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')].find(r => r.textContent.trim() === 'Hook events…'), 'Hook events action')).click();
      const dialog = await wait(() => document.querySelector('dialog.hook-events-dialog[open]'), 'dialog');
      const text = await wait(() => dialog.textContent.includes('same call ×3') && dialog.textContent, 'same call ×3');
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      return { text, inputEvents: window.__aitermTest.snapshot('${repeatSession.session.sessionId}').inputEvents };
    })()`) as { text: string; inputEvents: number }
    writeFileSync(join(repeatDirectory, 'eight-gate'), '')
    await untilFileExists(join(repeatDirectory, 'eight'), 'eight repeated calls')
    const repeatRows = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .filter(row => row.sessionId === repeatSession.session.sessionId && row.requestKey === 'watch:repeat' && row.state === 'open')
    const repeatProvenance = await applicationWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('.needs-you-button').click();
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        const row = [...document.querySelectorAll('.attention-item')].find(r => r.textContent.includes('Repeat acceptance repeated'));
        if (row) { const text = row.querySelector('.provenance')?.textContent; document.querySelector('.needs-you-button').click(); return text; }
        await new Promise(r => setTimeout(r, 25));
      } throw new Error('repeat notice missing from Needs you');
    })()`) as string
    writeFileSync(join(repeatDirectory, 'reset-gate'), '')
    await untilFileExists(join(repeatDirectory, 'reset'), 'repeat withdrawal on owner prompt')
    const repeatAfterReset = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .find(row => row.requestId === repeatRows[0]?.requestId)
    const repeatInputAfterNotice = await applicationWindow.webContents.executeJavaScript(
      `window.__aitermTest.snapshot('${repeatSession.session.sessionId}').inputEvents`
    ) as number
    if (repeatInputAfterNotice !== 0 || repeatInputAfterNotice !== repeatLogProbe.inputEvents) {
      throw new Error(`repeat notice wrote to the PTY: before=${repeatLogProbe.inputEvents}, after=${repeatInputAfterNotice}`)
    }
    const repeatAcceptance = {
      logShowsThree: repeatLogProbe.text.includes('PostToolUse · Bash · same call ×3'),
      noticeCount: repeatRows.length, kind: repeatRows[0]?.kind, openedBy: repeatRows[0]?.openedBy,
      provenance: repeatProvenance, ptyInputEvents: repeatInputAfterNotice,
      resetState: repeatAfterReset?.state
    }
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: repeatSession.session.sessionId,
      incarnationId: repeatSession.session.lastProcess?.incarnationId, cause: 'explicit' })

    // Story 32.3: a TUI died with mouse, paste and focus modes on while its shell lives on. Reset terminal modes
    // turns them off in the view and in the tracker, writing nothing to the PTY, and a rebuilt view stays plain.
    console.error('[BMN] self-test phase: reset terminal modes')
    const resetDirectory = join(isolatedCwd, 'reset-modes')
    mkdirSync(resetDirectory, { recursive: true })
    const resetInputLog = join(resetDirectory, 'input.log')
    const resetExecutable = join(resetDirectory, 'shell.sh')
    writeFileSync(resetExecutable, [
      '#!/bin/sh',
      'stty raw -echo',
      "printf '\\033[?1000h\\033[?1006h\\033[?2004h\\033[?1004hMODES-ARMED\\r\\n'",
      `exec cat > ${JSON.stringify(resetInputLog)}`,
      ''
    ].join('\n'), { mode: 0o755 })
    const resetSession = await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Reset modes acceptance', cwd: isolatedCwd, executable: resetExecutable, argv: [], cols: 80, rows: 24 }, true)
    const resetId = JSON.stringify(resetSession.session.sessionId)
    const resetView = (): Promise<{ bufferLines: string[]; cols: number; rows: number; refits: number; inputEvents: number;
      modes: Record<string, unknown> }> => applicationWindow!.webContents.executeJavaScript(
      `window.__aitermTest.snapshot(${resetId})`) as never
    const wheel = (): Promise<number> => applicationWindow!.webContents.executeJavaScript(`(async () => {
      const pane = document.querySelector('.session-terminal[data-session-id=' + JSON.stringify(${resetId}) + ']:not(.session-terminal-hidden)');
      const screen = pane?.querySelector('.xterm-screen');
      if (!screen) throw new Error('reset modes: no terminal screen');
      const box = screen.getBoundingClientRect();
      const before = window.__aitermTest.snapshot(${resetId}).inputEvents;
      screen.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, deltaMode: 0, bubbles: true, cancelable: true,
        clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return window.__aitermTest.snapshot(${resetId}).inputEvents - before;
    })()`) as Promise<number>
    const logSize = (): number => existsSync(resetInputLog) ? readFileSync(resetInputLog).byteLength : -1
    // A session made through the host reaches the tree when the window reloads, as the repeat fixture's does.
    await recoverApplicationRenderer(applicationWindow)
    await applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        document.querySelector('.session-row > button[data-session-id=' + JSON.stringify(${resetId}) + ']')?.click();
        const shot = window.__aitermTest?.snapshots()?.[${resetId}];
        if (shot && shot.bufferLines.some((line) => line.includes('MODES-ARMED')) && shot.modes.mouseTrackingMode !== 'none') return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } throw new Error('reset modes: the fixture never armed its modes: ' + JSON.stringify({
        row: !!document.querySelector('.session-row > button[data-session-id=' + JSON.stringify(${resetId}) + ']'),
        shot: window.__aitermTest?.snapshots()?.[${resetId}] ?? null }).slice(0, 2000));
    })()`)
    await untilFileExists(resetInputLog, 'the reset fixture shell')
    const armedModes = (await resetView()).modes
    const logBeforeWheel = logSize()
    const wheelInputBefore = await wheel()
    const armedWheelReached = await acceptanceWait(async () => logSize() > logBeforeWheel ? true : undefined, 'armed wheel input at the PTY')
    // The view was rebuilt moments ago; measure it once its fit has settled.
    const settledView = async (): Promise<Awaited<ReturnType<typeof resetView>>> => {
      let previous = await resetView()
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const current = await resetView()
        if (current.cols === previous.cols && current.rows === previous.rows && current.refits === previous.refits &&
          JSON.stringify(current.bufferLines) === JSON.stringify(previous.bufferLines)) return current
        previous = current
      }
      return previous
    }
    // In the hidden self-test window a rebuilt view gets its first fit only when the layout next changes, and the
    // palette's dialog is such a change; open and close it once so the reset is measured against a fitted view.
    if (await runPaletteCommand(applicationWindow, 'No such command: fit before the reset baseline') !== 'missing') {
      throw new Error('reset modes: the baseline palette probe ran a command')
    }
    const beforeReset = await settledView()
    const logBeforeReset = readFileSync(resetInputLog)
    const resetRan = await runPaletteCommand(applicationWindow, 'Reset terminal modes')
    const resetToast = await acceptanceWait(async () => await applicationWindow!.webContents.executeJavaScript(
      `document.body.textContent.includes('Terminal modes reset for Reset modes acceptance') || undefined`) as true | undefined,
    'the reset toast')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterReset = await resetView()
    const wheelInputAfter = await wheel()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const logAfterReset = readFileSync(resetInputLog)
    await recoverApplicationRenderer(applicationWindow)
    await applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        document.querySelector('.session-row > button[data-session-id=' + JSON.stringify(${resetId}) + ']')?.click();
        if (window.__aitermTest?.snapshots()?.[${resetId}]) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } throw new Error('reset modes: no rebuilt view');
    })()`)
    const rebuilt = await resetView()
    const plainModes = (modes: Record<string, unknown>): boolean => modes.mouseTrackingMode === 'none' &&
      modes.bracketedPasteMode === false && modes.sendFocusMode === false && modes.wraparoundMode === true &&
      modes.applicationCursorKeysMode === false && modes.originMode === false && modes.alternateScreen === false &&
      modes.cursorHidden === false && modes.mouseEncoding === 'DEFAULT'
    const resetModes = {
      armed: armedModes, ran: resetRan, toast: resetToast === true,
      wheelInputBefore, armedWheelReached: armedWheelReached === true,
      after: afterReset.modes, wheelInputAfter,
      ptyUnchangedByReset: Buffer.compare(logBeforeReset, logAfterReset) === 0,
      screenUnchanged: JSON.stringify(afterReset.bufferLines) === JSON.stringify(beforeReset.bufferLines),
      geometryUnchanged: afterReset.cols === beforeReset.cols && afterReset.rows === beforeReset.rows &&
        afterReset.refits === beforeReset.refits,
      geometry: { before: [beforeReset.cols, beforeReset.rows, beforeReset.refits], after: [afterReset.cols, afterReset.rows, afterReset.refits] },
      changedLines: afterReset.bufferLines.map((line, index) => line === beforeReset.bufferLines[index] ? null
        : { index, before: beforeReset.bufferLines[index] ?? null, after: line }).filter(Boolean).slice(0, 3),
      rebuilt: rebuilt.modes
    }
    console.error(`[BMN] self-test phase: reset terminal modes ${JSON.stringify(resetModes)}`)
    if (armedModes.mouseTrackingMode === 'none' || armedModes.bracketedPasteMode !== true || armedModes.sendFocusMode !== true ||
      armedModes.mouseEncoding !== 'SGR' || resetRan !== 'ran' || !resetModes.toast || wheelInputBefore < 1 ||
      !resetModes.armedWheelReached || !plainModes(afterReset.modes) || wheelInputAfter !== 0 || !resetModes.ptyUnchangedByReset ||
      !resetModes.screenUnchanged || !resetModes.geometryUnchanged || !plainModes(rebuilt.modes)) {
      throw new Error(`Reset terminal modes went wrong: ${JSON.stringify(resetModes)}`)
    }
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: resetSession.session.sessionId,
      incarnationId: resetSession.session.lastProcess?.incarnationId, cause: 'explicit' })

    // Return selection to the lifecycle fixture expected by the existing restart checks.
    await applicationWindow.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.session-row button[data-session-id="' + ${JSON.stringify(preloadProbe.templateCreatedSession.sessionId)} + '"]');
      if (!row) throw new Error('the lifecycle fixture disappeared after acceptance');
      row.click();
    })()`)
    console.error('[BMN] self-test phase: conversation reported by a session hook')
    const hookReference = '01a0b657-21a8-7f00-addd-b73646828f5b'
    const rolloutDirectory = join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '20')
    mkdirSync(rolloutDirectory, { recursive: true })
    writeFileSync(join(rolloutDirectory, `rollout-2026-09-20T00-00-00-${hookReference}.jsonl`), '')
    const reportingHarness = writeCodexHarness(join(isolatedCwd, 'codex-harness-a'), hookReference)
    const rivalHarness = writeCodexHarness(join(isolatedCwd, 'codex-harness-b'), hookReference)
    const reportingSession = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionCreate, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Hook-reported Codex',
      cwd: isolatedCwd,
      executable: reportingHarness.executable,
      argv: ['--model', 'gpt-6', '--full-auto'],
      cols: 80,
      rows: 24
    })
    const startedUnsupported = await client.request<PersistedConversationBinding>(
      METHOD_REGISTRY.sessionBindingGet,
      { sessionId: reportingSession.sessionId }
    )
    await untilHarnessRuns(reportingHarness.log, 1)
    const reportedBinding = await (async (): Promise<BoundConversationBinding> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const binding = await client.request<PersistedConversationBinding>(
          METHOD_REGISTRY.sessionBindingGet,
          { sessionId: reportingSession.sessionId }
        )
        if (binding.status === 'bound' && binding.captureRoute === 'hook-session-start') return binding
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the reported conversation never reached the binding')
    })()
    const codexObservationUi = await inspectHarnessObservation(
      reportingSession.sessionId, 'Hook-reported Codex', 'Codex', 'SessionStart'
    )
    if (Object.values(codexObservationUi).some((value) => value !== true)) {
      throw new Error(`Codex observation view failed: ${JSON.stringify(codexObservationUi)}`)
    }
    const rivalSession = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionCreate, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Rival Codex',
      cwd: isolatedCwd,
      executable: rivalHarness.executable,
      argv: [],
      cols: 80,
      rows: 24
    })
    await untilHarnessRuns(rivalHarness.log, 1)
    const rivalBinding = await client.request<PersistedConversationBinding>(
      METHOD_REGISTRY.sessionBindingGet,
      { sessionId: rivalSession.sessionId }
    )
    await client.request(METHOD_REGISTRY.sessionStop, {
      sessionId: reportingSession.sessionId,
      incarnationId: reportingSession.incarnationId,
      cause: 'explicit'
    })
    const resumedSession = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionResume, {
      sessionId: reportingSession.sessionId,
      cols: 80,
      rows: 24
    })
    const harnessRunArguments = await untilHarnessRuns(reportingHarness.log, 2)
    for (const stopping of [
      { sessionId: reportingSession.sessionId, incarnationId: resumedSession.incarnationId },
      { sessionId: rivalSession.sessionId, incarnationId: rivalSession.incarnationId }
    ]) {
      await client.request(METHOD_REGISTRY.sessionStop, { ...stopping, cause: 'explicit' })
    }
    /** Sessions deliberately stopped before the application restart: they are exited, not interrupted. */
    const stoppedBeforeRestartSessionIds = new Set([
      reportingSession.sessionId, rivalSession.sessionId,
      petitionSource.session.sessionId, petitionDestination.session.sessionId,
      openCodeSession.session.sessionId, routingSession.session.sessionId, repeatSession.session.sessionId,
      cursorSession.session.sessionId, cursorShell.session.sessionId, resetSession.session.sessionId
    ])
    // The rival's report was refused; the owner must be able to read why while BMN is still running.
    const refusalLog = join(resolveApplicationRoots().state, 'refused-requests.log')
    const refusalReason = await (async (): Promise<string | null> => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        if (existsSync(refusalLog)) {
          const line = readFileSync(refusalLog, 'utf8')
            .split('\n')
            .filter((entry) => entry.includes(rivalSession.sessionId))
            .at(-1)
          if (line) return line.slice(line.indexOf('refused for'))
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return null
    })()
    const conversationFromHook = {
      startedRoute: startedUnsupported.captureRoute,
      listed: listedConversation(reportingHarness.listing),
      refusalReason,
      reportedRoute: reportedBinding.captureRoute,
      reportedReference: reportedBinding.conversationReference,
      reportedDetail: reportedBinding.detail,
      rivalRoute: rivalBinding.captureRoute,
      resumedArguments: harnessRunArguments[1] ?? null,
      launchArguments: harnessRunArguments[0] ?? null
    }
    console.error(`[BMN] self-test phase: conversation reported ${JSON.stringify(conversationFromHook)}`)

    const openRequestCount = async (): Promise<number> =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .filter((request) => request.state === 'open').length
    const openRequestsBeforeRendererRestart = await openRequestCount()

    /**
     * Epic 17.2: a program that turned bracketed paste, focus reports and SGR mouse on, so the
     * renderer-crash row can be asked the question it never answered — does the rebuilt view still
     * speak to the program the way the program asked to be spoken to?
     */
    const modeProgram = writeTerminalModeProgram(join(isolatedCwd, 'terminal-modes'))
    const { session: modeRecord, startup: modeStartup } = await createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Terminal modes',
      cwd: isolatedCwd,
      executable: modeProgram.executable,
      argv: [],
      cols: 80,
      rows: 24
    }, true)
    await recoverApplicationRenderer(applicationWindow)
    const modesBeforeRestart = await terminalViewModes(applicationWindow, modeRecord.sessionId, true)

    console.error('[BMN] self-test phase: renderer restart')
    const reloaded = waitForRendererLoad(applicationWindow)
    applicationWindow.webContents.reload()
    await reloaded
    await waitForRendererHook(applicationWindow)
    console.error('[BMN] self-test phase: renderer restart loaded')
    // The view is new; the program is the same one, still believing the modes it set.
    const modesAfterRestart = await terminalViewModes(applicationWindow, modeRecord.sessionId, false)
    const inputBeforeDriving = terminalModeProgramInput(modeProgram.input)
    const driven = await driveModeSensitiveInput(applicationWindow, modeRecord.sessionId, MODE_PASTE_TEXT)
    const programSaw = await untilModeProgramRead(modeProgram.input, inputBeforeDriving)
    const terminalModes = {
      before: modesBeforeRestart,
      after: modesAfterRestart,
      // What the program was actually sent, so a failure says which half of the path broke.
      saw: JSON.stringify(programSaw).slice(0, 200),
      clipboard: driven.clipboard,
      ptyWrites: driven.ptyWrites,
      notice: driven.notice,
      pasteBracketed: programSaw.includes(`\u001b[200~${MODE_PASTE_TEXT}\u001b[201~`),
      pasteArrivedBare: programSaw.includes(MODE_PASTE_TEXT) &&
        !programSaw.includes(`\u001b[200~${MODE_PASTE_TEXT}`),
      focusReported: programSaw.includes('\u001b[I') || programSaw.includes('\u001b[O')
    }
    console.error(`[BMN] self-test phase: terminal modes ${JSON.stringify(terminalModes)}`)
    if (
      !modesBeforeRestart.bracketedPasteMode ||
      !modesBeforeRestart.sendFocusMode ||
      modesBeforeRestart.mouseTrackingMode === 'none' ||
      modesBeforeRestart.wraparoundMode
    ) {
      throw new Error(`the mode program never reached the first view: ${JSON.stringify(modesBeforeRestart)}`)
    }
    if (
      !modesAfterRestart.bracketedPasteMode ||
      !modesAfterRestart.sendFocusMode ||
      modesAfterRestart.mouseTrackingMode === 'none' ||
      // A mode the program turned off is as much its state as one it turned on.
      modesAfterRestart.wraparoundMode
    ) {
      throw new Error(
        `the rebuilt view lost the program's terminal modes: ${JSON.stringify(terminalModes)}`
      )
    }
    if (!terminalModes.pasteBracketed || !terminalModes.focusReported) {
      throw new Error(`the rebuilt view no longer speaks to the program: ${JSON.stringify(terminalModes)}`)
    }
    await client.request(METHOD_REGISTRY.sessionStop, {
      sessionId: modeStartup.sessionId,
      incarnationId: modeStartup.incarnationId,
      cause: 'explicit'
    })
    stoppedBeforeRestartSessionIds.add(modeRecord.sessionId)
    // Epic 17.1 AC2: the offer was made once; a rebuilt view is not a new start, so it stays away.
    const offerStayedAwayAfterRendererRestart = await resumeOfferStaysAway(applicationWindow, 750)
    if (!offerStayedAwayAfterRendererRestart) {
      throw new Error('an already-offered interruption asked again after the renderer restart')
    }
    // Epic 11 AC1: the marker is stored, not remembered by the view, so it is still there after a restart.
    const markersAfterRestart = await client.request<WorkspaceRecord[]>(METHOD_REGISTRY.workspaceList, {
      includeArchived: true
    })
    const restartedLocalWorkspace = markersAfterRestart
      .find((workspace) => workspace.workspaceId === DEFAULT_WORKSPACE_ID)
    const restartedLocalMarker = restartedLocalWorkspace?.marker
    const restartedForeignMarker = markersAfterRestart
      .find((workspace) => workspace.workspaceId === secondWorkspace.workspaceId)?.marker
    if (!restartedLocalWorkspace || restartedLocalMarker !== 'teal' || restartedForeignMarker !== 'rose') {
      throw new Error(
        `workspace markers did not survive the renderer restart: ${JSON.stringify({
          restartedLocalMarker,
          restartedForeignMarker
        })}`
      )
    }
    const rendererMarkerAfterRestart = await applicationWindow.webContents.executeJavaScript(
      `document.querySelector('.workspace-group[aria-label=${JSON.stringify(restartedLocalWorkspace.name)}] `
      + `.workspace-row .workspace-marker')?.dataset.marker ?? null`
    ) as string | null
    if (rendererMarkerAfterRestart !== 'teal') {
      throw new Error(
        `the reloaded renderer did not redraw the stored marker: ${JSON.stringify(rendererMarkerAfterRestart)}`
      )
    }
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
    // AC4: what the owner reads before Resume is the command that runs, and Cancel starts nothing.
    const liveBeforeConfirmation = (await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})).liveSessions
    const resumeConfirmation = await resumeConfirmationShown(
      applicationWindow,
      { sessionId: reportingSession.sessionId, name: 'Hook-reported Codex' },
      preloadProbe.templateCreatedSession.sessionId
    )
    const liveAfterCancel = (await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})).liveSessions
    if (liveAfterCancel !== liveBeforeConfirmation) {
      throw new Error('cancelling the Resume confirmation started or stopped a process')
    }
    const resumeConfirmationShownToOwner = {
      command: resumeConfirmation.command,
      note: resumeConfirmation.note,
      // The command the owner read must be exactly the one the earlier real Resume spawned.
      matchesSpawnedArguments:
        resumeConfirmation.command ===
        [reportingHarness.executable, ...(harnessRunArguments[1] ?? [])].join(' '),
      startedNothing: liveAfterCancel === liveBeforeConfirmation
    }
    console.error(`[BMN] self-test phase: resume confirmation ${JSON.stringify(resumeConfirmationShownToOwner)}`)

    // Epic 29: the model maker's flag, from what a Claude stand-in's own `bmn hook claude` reports
    // under each base URL. This run stays live into the application restart below.
    console.error('[BMN] self-test phase: model origin flags')
    const originDirectory = join(isolatedCwd, 'model-origin')
    const { session: originSession } = await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Model origin', cwd: isolatedCwd, executable: '/bin/bash', argv: ['-c', writeOriginHarness(originDirectory)],
      cols: 80, rows: 24 }, true)
    await recoverApplicationRenderer(applicationWindow)
    const originScenarios = [
      { label: 'default', baseUrl: null, model: 'claude-opus-4-5', flag: '🇺🇸',
        name: 'Model origin: the United States · claude-opus-4-5', row: 'claude-opus-4-5' },
      { label: 'zai', baseUrl: 'https://api.z.ai/api/anthropic', model: 'claude-sonnet-4-5', flag: '🇨🇳',
        name: 'Model origin: China · claude-sonnet-4-5 via api.z.ai', row: 'claude-sonnet-4-5 via api.z.ai' },
      { label: 'mistral', baseUrl: 'https://api.mistral.ai', model: 'mistral-large-latest', flag: '🇫🇷',
        name: 'Model origin: France · mistral-large-latest via api.mistral.ai', row: 'mistral-large-latest via api.mistral.ai' },
      { label: 'openrouter', baseUrl: 'https://openrouter.ai/api', model: 'moonshotai/kimi-k2', flag: '🇨🇳',
        name: 'Model origin: China · moonshotai/kimi-k2 via openrouter.ai', row: 'moonshotai/kimi-k2 via openrouter.ai' },
      { label: 'unknown', baseUrl: 'https://llm.internal.example/v1', model: 'custom-tuned', flag: null,
        name: null, row: 'custom-tuned via llm.internal.example' }
    ]
    const modelOriginFlags: Record<string, OriginProbe> = {}
    for (const [n, scenario] of originScenarios.entries()) {
      await fireOriginGate(originDirectory, n, { baseUrl: scenario.baseUrl, model: scenario.model, event: 'SessionStart' })
      const seen = await modelOriginProbe(applicationWindow, originSession.sessionId, 'Model origin', scenario.row)
      modelOriginFlags[scenario.label] = seen
      if (seen.rowFlag !== scenario.flag || seen.paneFlag !== scenario.flag || seen.inspectorFlag !== scenario.flag ||
        seen.rowLabel !== scenario.name || seen.paneLabel !== scenario.name ||
        seen.modelTitle !== (scenario.name ?? 'Model origin unclassified') ||
        [seen.rowChip, seen.paneChip, seen.inspectorChip].some((chip) => chip !== 'Claude')) {
        throw new Error(`model origin ${scenario.label} rendered wrongly: ${JSON.stringify(seen)}`)
      }
    }
    // Epic 30.2: a phone answer reaches only the dialog that asked, with exactly the keys the owner would type.
    console.error('[BMN] self-test phase: remote answers')
    const answerDirectory = join(isolatedCwd, 'remote-answers')
    const answerFixtures = app.isPackaged
      ? join(process.resourcesPath, 'self-test', 'remote-answers')
      : join(repoRoot, 'apps', 'desktop', 'src', 'utility', 'test-fixtures', 'remote-answers')
    const { session: answerSession } = await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Remote answers', cwd: isolatedCwd, executable: '/bin/bash',
      argv: ['-c', writeRemoteAnswerHarness(answerDirectory, answerFixtures)], cols: 200, rows: 50 }, true)
    await recoverApplicationRenderer(applicationWindow)
    const answerRun = async (scenario: string, requestKey: string, answer: unknown) => {
      writeFileSync(join(answerDirectory, `fire-${scenario}`), '')
      await untilFileExists(join(answerDirectory, `opened-${scenario}`), `drew the ${scenario} dialog`)
      // The stand-in's drawing reaches the mirror a moment after its hook returns.
      await new Promise((resolve) => setTimeout(resolve, 300))
      const opened = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .find((row) => row.sessionId === answerSession.sessionId && row.requestKey === requestKey && row.state === 'open')
      const { selfTestRemoteAnswer } = await client.request<{
        selfTestRemoteAnswer: { outcome: { state: string; reason?: string; sent?: string[] } | null; request: AttentionRecord | null }
      }>(METHOD_REGISTRY.healthGet, { selfTestRemoteAnswer: { sessionId: answerSession.sessionId, requestKey, answer } })
      await untilFileExists(join(answerDirectory, `done-${scenario}`), `finished the ${scenario} dialog`)
      if (existsSync(join(answerDirectory, 'error'))) {
        throw new Error(`remote answer stand-in failed: ${readFileSync(join(answerDirectory, 'error'), 'utf8')}`)
      }
      const request = selfTestRemoteAnswer.request
      return {
        prompt: opened?.prompt ?? null,
        outcome: selfTestRemoteAnswer.outcome,
        keys: JSON.parse(readFileSync(join(answerDirectory, `done-${scenario}`), 'utf8')) as string[],
        request: request ? { state: request.state, resolvedBy: request.resolvedBy, resolution: request.resolution } : null
      }
    }
    const single = await answerRun('single', 'claude:question', { type: 'choices', choices: [1] })
    const three = await answerRun('three', 'claude:question', { type: 'choices', choices: [0, 1, 0] })
    const codexTwo = await answerRun('codex', 'codex:question', { type: 'choices', choices: [1, 0] })
    const permissionsOff = await answerRun('off', 'claude:permission', { type: 'permission', decision: 'allow' })
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: {
      ...(await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram, answerPermissions: true } })
    const allowOnce = await answerRun('allow', 'claude:permission', { type: 'permission', decision: 'allow' })
    const denied = await answerRun('deny', 'claude:permission', { type: 'permission', decision: 'deny' })
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: {
      ...(await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram, answerPermissions: false } })
    const allKeys = readFileSync(join(answerDirectory, 'keys.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string).join('')
    const remoteAnswers = {
      readBack: single.prompt?.type === 'questions'
        ? { type: single.prompt.type, harness: single.prompt.harness, labels: single.prompt.questions[0]?.options.map((option) => option.label) }
        : null,
      single, three, codexTwo, permissionsOff, allowOnce, denied,
      // Every byte the stand-in ever received, across all six dialogs.
      allKeys
    }
    console.error(`[BMN] self-test phase: remote answers ${JSON.stringify(remoteAnswers)}`)
    const answered = (run: typeof single, keys: string[], sent: string[]) =>
      JSON.stringify(run.keys) === JSON.stringify(keys) && run.outcome?.state === 'confirmed' &&
      JSON.stringify(run.outcome.sent) === JSON.stringify(sent) && run.request?.resolvedBy === 'telegram'
    if (!answered(single, ['2'], ['Session cookies']) || !answered(three, ['1', '2', '1', '1'], ['Postgres', 'Later', 'Staging']) ||
      !answered(codexTwo, ['2', '1'], ['SQLite', 'Yes']) || !answered(allowOnce, ['1'], ['Allow once']) ||
      permissionsOff.outcome?.state !== 'refused' || permissionsOff.outcome.reason !== 'permissions-off' || permissionsOff.keys.length !== 0 ||
      denied.outcome?.state !== 'sent-unconfirmed' || JSON.stringify(denied.keys) !== '["3"]' || denied.request?.resolvedBy !== 'telegram' ||
      allKeys !== '2' + '1211' + '21' + '1' + '3') {
      throw new Error(`remote answers went wrong: ${JSON.stringify(remoteAnswers)}`)
    }

    // Story 30.3: the same three-question dialog, answered by tapping its Telegram card on a fake Bot API.
    console.error('[BMN] self-test phase: telegram cards')
    const bot = await selfTestTelegram()
    const telegramBefore = (await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: { ...telegramBefore, enabled: true,
      allowedChatId: SELF_TEST_TELEGRAM_CHAT_ID, allowedUserId: null, notifyOn: 'attention', autoSubmitReplies: false } })
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: '123456789:SELFTEST_fake_bot_token_not_real' })
    const pollingBy = Date.now() + 15_000
    while ((await client.request<{ state: string }>(METHOD_REGISTRY.telegramStatus, {})).state !== 'polling') {
      if (Date.now() > pollingBy) throw new Error('the self-test Telegram connector never started polling')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const firstCall = bot.calls.length
    bot.tapOn('Which database should store users?', [0, 1, 0])
    await client.request(METHOD_REGISTRY.presenceSet, { away: true })
    writeFileSync(join(answerDirectory, 'fire-card'), '')
    // The page waits its (self-test) 2 s before it is sent; the three taps and the delivery follow.
    const cardBy = Date.now() + 60_000
    while (!existsSync(join(answerDirectory, 'done-card'))) {
      if (Date.now() > cardBy) throw new Error(`the card dialog never finished: ${JSON.stringify(bot.calls.slice(firstCall))}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const finishedBy = Date.now() + 15_000
    const finalEdit = (): boolean => bot.calls.slice(firstCall).some((call) =>
      call.method === 'editMessageText' && String(call.body.text).includes('✓ <i>Sent:'))
    while (!finalEdit() && Date.now() < finishedBy) await new Promise((resolve) => setTimeout(resolve, 100))
    const cardMessage = bot.calls.slice(firstCall).find((call) =>
      call.method === 'sendMessage' && String(call.body.text).includes('Which database should store users?'))
    const buttonsOf = (body: Record<string, unknown>): number =>
      ((body.reply_markup as { inline_keyboard?: unknown[][] } | undefined)?.inline_keyboard ?? []).flat().length
    const lastLine = (body: Record<string, unknown>): string => String(body.text ?? '').split('\n').pop() ?? ''
    // Only this card's own messages: other sessions' pages may arrive when the owner turns away.
    const cardCalls = cardMessage ? bot.calls.slice(bot.calls.indexOf(cardMessage)).filter((call) => call === cardMessage ||
      call.method === 'answerCallbackQuery' || call.method === 'editMessageText' && call.body.message_id === cardMessage.messageId) : []
    const cardRequest = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .filter((row) => row.sessionId === answerSession.sessionId && row.requestKey === 'claude:question')
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt))[0]
    const telegramCards = {
      card: cardMessage ? { parseMode: cardMessage.body.parse_mode, buttons: buttonsOf(cardMessage.body),
        header: String(cardMessage.body.text).split('\n')[0] } : null,
      sequence: cardCalls.map((call) => call.method === 'answerCallbackQuery'
        ? `toast:${String(call.body.text)}`
        : call.method === 'sendMessage' ? `send:${buttonsOf(call.body)}` : `edit:${buttonsOf(call.body)}:${lastLine(call.body)}`),
      keys: JSON.parse(readFileSync(join(answerDirectory, 'done-card'), 'utf8')) as string[],
      request: cardRequest ? { state: cardRequest.state, resolvedBy: cardRequest.resolvedBy } : null
    }
    console.error(`[BMN] self-test phase: telegram cards ${JSON.stringify(telegramCards)}`)
    // Every step offers Other… (Epic 31), and every step after the first ‹ Back.
    const expectedSequence = [
      'send:3', 'toast:Question 2 of 3', 'edit:4:In a follow-up', 'toast:Question 3 of 3',
      'edit:4:<i>Nothing is sent until this answer.</i>', 'toast:Sending Postgres · Later · Staging…',
      'edit:0:<i>Sending: Postgres · Later · Staging…</i>', 'edit:0:✓ <i>Sent: Postgres · Later · Staging</i>'
    ]
    if (telegramCards.card?.parseMode !== 'HTML' || JSON.stringify(telegramCards.sequence) !== JSON.stringify(expectedSequence) ||
      JSON.stringify(telegramCards.keys) !== '["1","2","1","1"]' || telegramCards.request?.resolvedBy !== 'telegram') {
      throw new Error(`telegram cards went wrong: ${JSON.stringify(telegramCards)}`)
    }

    // Story 31.4: multi-select, Other… with a typed reply, and Back, each through its agent's verified route.
    console.error('[BMN] self-test phase: fuller telegram answers')
    const fullerRun = async (scenario: string, requestKey: string, match: string, steps: FakeBotStep[]) => {
      const from = bot.calls.length
      bot.tapOn(match, steps)
      writeFileSync(join(answerDirectory, `fire-${scenario}`), '')
      const doneBy = Date.now() + 30_000
      while (!existsSync(join(answerDirectory, `done-${scenario}`))) {
        if (existsSync(join(answerDirectory, 'error'))) {
          throw new Error(`remote answer stand-in failed: ${readFileSync(join(answerDirectory, 'error'), 'utf8')}`)
        }
        if (Date.now() > doneBy) throw new Error(`the ${scenario} dialog never finished: ${JSON.stringify(bot.calls.slice(from))}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const sentBy = Date.now() + 15_000
      const card = (): FakeBotCall | undefined => bot.calls.slice(from).find((call) =>
        call.method === 'sendMessage' && String(call.body.text).includes(match))
      const ended = (): boolean => bot.calls.slice(from).some((call) => call.method === 'editMessageText' &&
        call.body.message_id === card()?.messageId && /✓ <i>Sent:|⚠ <i>/.test(String(call.body.text)))
      while (!ended() && Date.now() < sentBy) await new Promise((resolve) => setTimeout(resolve, 100))
      const message = card()
      const labelsOf = (body: Record<string, unknown>): string =>
        ((body.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined)?.inline_keyboard ?? [])
          .flat().map((button) => button.text).join('|')
      const sequence = message ? bot.calls.slice(bot.calls.indexOf(message)).flatMap((call) => {
        if (call === message) return [`send:${labelsOf(call.body)}`]
        if (call.method === 'answerCallbackQuery') return [`toast:${String(call.body.text)}`]
        if (call.method === 'editMessageText' && call.body.message_id === message.messageId) {
          return [`edit:${labelsOf(call.body)}:${String(call.body.text).split('\n').pop()}`]
        }
        // BMN's own replies to the owner's messages, such as "Tap Other… first".
        if (call.method === 'sendMessage' && call.body.reply_parameters) return [`reply:${String(call.body.text)}`]
        return []
      }) : []
      const request = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .filter((row) => row.sessionId === answerSession.sessionId && row.requestKey === requestKey)
        .sort((left, right) => right.openedAt.localeCompare(left.openedAt))[0]
      return {
        sequence,
        keys: (JSON.parse(readFileSync(join(answerDirectory, `done-${scenario}`), 'utf8')) as string[]).join(''),
        request: request ? { state: request.state, resolvedBy: request.resolvedBy } : null
      }
    }
    const claudeMore = await fullerRun('claude-more', 'claude:question', 'Which auth method should the API use?', [
      { tap: '2 · Sessions' }, { tap: '‹ Back' }, { tap: '1 · JWT' },
      [{ reply: 'too early' }, { tap: '○ 1 · Rate limiting' }], { tap: '○ 3 · Webhooks' }, { tap: 'Other…' }, { reply: 'GraphQL' }
    ])
    const codexOther = await fullerRun('codex-other', 'codex:question', 'Which auth method should the API use?', [
      { tap: 'Other…' }, { reply: 'Passkeys first' }
    ])
    const openCodeMore = await fullerRun('opencode-more', 'opencode:question', 'Which features should v1 include?', [
      { tap: '○ 2 · Rate limiting' }, { tap: 'Next · 1 selected' }, { tap: '2 · Sessions' }
    ])
    const fuller = { claudeMore, codexOther, openCodeMore }
    console.error(`[BMN] self-test phase: fuller telegram answers ${JSON.stringify(fuller)}`)
    const DOWN = '\u001b[B'
    const inOrder = (sequence: string[], expected: string[]): boolean => {
      let at = 0
      for (const entry of sequence) if (at < expected.length && entry === expected[at]) at += 1
      return at === expected.length
    }
    if (!inOrder(claudeMore.sequence, [
      'send:1 · JWT|2 · Sessions|Other…',
      'edit:○ 1 · Rate limiting|○ 2 · Audit log|○ 3 · Webhooks|Other…|‹ Back:<i>Choose one or more, then Send.</i>',
      'toast:Question 1 of 2',
      // Back reopens question 1 with its choice marked, and no Back on it.
      'edit:1 · JWT|● 2 · Sessions|Other…:Server-side cookies',
      'reply:Tap Other… first, then reply with your answer.',
      'edit:● 1 · Rate limiting|○ 2 · Audit log|● 3 · Webhooks|Other…|‹ Back|Send 2 selected:<i>Chosen: Rate limiting · Webhooks</i>',
      'edit:‹ Options:<i>Reply to this message with your answer.</i>',
      'edit::<i>Sending: JWT · Rate limiting · Webhooks · “GraphQL”…</i>',
      'edit::✓ <i>Sent: JWT · Rate limiting · Webhooks · “GraphQL”</i>'
    ]) || claudeMore.keys !== `113${DOWN.repeat(3)}GraphQL${DOWN}\r1` || claudeMore.request?.resolvedBy !== 'telegram' ||
      !inOrder(codexOther.sequence, [
        'send:1 · JWT|2 · Sessions|Other…', 'edit:‹ Options:<i>Reply to this message with your answer.</i>',
        'edit::✓ <i>Sent: “Passkeys first”</i>'
      ]) || codexOther.keys !== `${DOWN}${DOWN}\tPasskeys first\r` || codexOther.request?.resolvedBy !== 'telegram' ||
      !inOrder(openCodeMore.sequence, [
        'send:○ 1 · SSO|○ 2 · Rate limiting|○ 3 · Audit log|Other…',
        // OpenCode's second question turned typed answers off: no Other… there.
        'edit:1 · JWT|2 · Sessions|‹ Back:<i>Nothing is sent until this answer.</i>',
        'edit::✓ <i>Sent: Rate limiting · Sessions</i>'
      ]) || openCodeMore.keys !== '[["Rate limiting"],["Sessions"]]' || openCodeMore.request?.resolvedBy !== 'telegram') {
      throw new Error(`fuller telegram answers went wrong: ${JSON.stringify(fuller)}`)
    }
    // Story 34.2: a `bmn ask` body quoting a key reaches the Bot API with the key hidden and the card saying so.
    console.error('[BMN] self-test phase: telegram secret masking')
    const secretKey = 'sk-ant-api03-' + 'SelfTestSyntheticKey_0123456789'
    const secretFrom = bot.calls.length
    writeFileSync(join(answerDirectory, 'fire-secret-ask'), '')
    const secretCard = (): FakeBotCall | undefined => bot.calls.slice(secretFrom).find((call) =>
      call.method === 'sendMessage' && String(call.body.text).includes('Commit the key I found?'))
    const secretBy = Date.now() + 30_000
    while (!secretCard()) {
      if (existsSync(join(answerDirectory, 'error'))) {
        throw new Error(`remote answer stand-in failed: ${readFileSync(join(answerDirectory, 'error'), 'utf8')}`)
      }
      if (Date.now() > secretBy) throw new Error(`the secret-ask card never arrived: ${JSON.stringify(bot.calls.slice(secretFrom))}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // Needs you keeps the exact text; only what leaves for Telegram is masked.
    const secretStored = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .filter((row) => row.sessionId === answerSession.sessionId && row.requestKey === 'secret-ask')
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt))[0]
    writeFileSync(join(answerDirectory, 'fire-secret-ask-close'), '')
    const secretClosedBy = Date.now() + 15_000
    while (!existsSync(join(answerDirectory, 'done-secret-ask')) && Date.now() < secretClosedBy) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const secretMasking = {
      card: String(secretCard()!.body.text),
      leaked: bot.calls.slice(secretFrom).some((call) => JSON.stringify(call.body).includes(secretKey)),
      storedWhole: secretStored?.body?.includes(secretKey) ?? false,
      withdrawn: existsSync(join(answerDirectory, 'done-secret-ask'))
    }
    console.error(`[BMN] self-test phase: telegram secret masking ${JSON.stringify({ ...secretMasking, card: secretMasking.card.replaceAll(secretKey, '<key>') })}`)
    if (secretMasking.leaked || !secretMasking.card.includes('Should I commit [secret hidden] to the repo?') ||
      !secretMasking.card.endsWith('<i>Some text looked like a secret and was hidden. The full text is on the laptop.</i>') ||
      !secretMasking.storedWhole || !secretMasking.withdrawn) {
      throw new Error(`telegram secret masking went wrong: ${JSON.stringify({ ...secretMasking, card: secretMasking.card.replaceAll(secretKey, '<key>') })}`)
    }

    // Story 32.2: a channel that stops delivering shows on the gear and notifies once; a short outage stays quiet.
    console.error('[BMN] self-test phase: telegram channel cue')
    const telegramStatusNow = (): Promise<TelegramStatus> => client.request<TelegramStatus>(METHOD_REGISTRY.telegramStatus, {})
    const gearCue = (): Promise<{ title: string; description: string | null; dot: boolean }> =>
      applicationWindow!.webContents.executeJavaScript(`(() => {
        const gear = document.querySelector('.preferences-button');
        return { title: gear?.title ?? '', description: gear?.getAttribute('aria-description') ?? null,
          dot: !!gear?.querySelector('.status-dot.needs-you') };
      })()`) as Promise<{ title: string; description: string | null; dot: boolean }>
    const gearUntil = async (label: string, match: (cue: Awaited<ReturnType<typeof gearCue>>) => boolean): Promise<Awaited<ReturnType<typeof gearCue>>> => {
      const by = Date.now() + 15_000
      for (;;) {
        const cue = await gearCue()
        if (match(cue)) return cue
        if (Date.now() > by) throw new Error(`the gear never showed ${label}: ${JSON.stringify({ cue, status: await telegramStatusNow() })}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    const telegramToken = '123456789:SELFTEST_fake_bot_token_not_real'
    const noticesBefore = selfTestAppNotices.length
    bot.failWith(409)
    const conflictCue = await gearUntil('the conflict cue', (cue) => cue.title.includes('Telegram is not delivering: Another client is polling this bot token'))
    const conflictPreferences = await applicationWindow!.webContents.executeJavaScript(`(async () => {
      const wait = async (read, label) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('telegram cue preferences: ' + label); };
      document.querySelector('.preferences-button').click();
      const preferences = await wait(() => document.querySelector('dialog.preferences-dialog[open]'), 'Preferences');
      const section = await wait(() => [...preferences.querySelectorAll('.preferences-section')].find(s => s.querySelector('h3')?.textContent === 'Telegram'), 'section');
      const text = section.querySelector('.telegram-cue')?.textContent ?? null;
      const first = section.querySelector('h3')?.nextElementSibling?.classList.contains('telegram-cue') ?? false;
      preferences.querySelector('.app-dialog-heading button').click();
      await wait(() => !document.querySelector('dialog.preferences-dialog[open]') ? true : null, 'close');
      return { text, first };
    })()`) as { text: string | null; first: boolean }
    const noticesAfterConflict = selfTestAppNotices.slice(noticesBefore)
    bot.failWith(401)
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: telegramToken })
    const unauthorizedCue = await gearUntil('the unauthorized cue', (cue) => cue.title.includes('Telegram is not delivering: Telegram rejected the bot token'))
    bot.failWith('network')
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: telegramToken })
    const backoffBy = Date.now() + 15_000
    while ((await telegramStatusNow()).state !== 'backoff') {
      if (Date.now() > backoffBy) throw new Error(`the connector never backed off: ${JSON.stringify(await telegramStatusNow())}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const backoffStatus = await telegramStatusNow()
    const shortOutageCue = await gearCue()
    bot.failWith(null)
    const recoveredBy = Date.now() + 15_000
    while ((await telegramStatusNow()).state !== 'polling') {
      if (Date.now() > recoveredBy) throw new Error(`the connector never recovered: ${JSON.stringify(await telegramStatusNow())}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const recoveredStatus = await telegramStatusNow()
    // The gear may keep its dot for History cleanup; the Telegram words must go.
    const recoveredCue = await gearUntil('no Telegram cue after recovery', (cue) => !cue.title.includes('Telegram'))
    const telegramCue = {
      conflict: conflictCue, conflictPreferences, unauthorized: unauthorizedCue,
      shortOutage: { cue: shortOutageCue, failingSince: backoffStatus.failingSince },
      recovered: { cue: recoveredCue, failingSince: recoveredStatus.failingSince },
      notices: selfTestAppNotices.slice(noticesBefore), noticesAfterConflict
    }
    console.error(`[BMN] self-test phase: telegram channel cue ${JSON.stringify(telegramCue)}`)
    if (!conflictCue.dot || conflictCue.description !== 'Telegram is not delivering: Another client is polling this bot token' &&
      !conflictCue.description?.endsWith('. Telegram is not delivering: Another client is polling this bot token') ||
      conflictPreferences.text !== 'Telegram is not delivering: Another client is polling this bot token' || !conflictPreferences.first ||
      !unauthorizedCue.dot || shortOutageCue.title.includes('Telegram') || backoffStatus.failingSince === null ||
      recoveredCue.title.includes('Telegram') || recoveredStatus.failingSince !== null ||
      JSON.stringify(telegramCue.notices.map((notice) => notice.body)) !== JSON.stringify([
        'Telegram is not delivering: Another client is polling this bot token',
        'Telegram is not delivering: Telegram rejected the bot token'
      ]) || noticesAfterConflict.length !== 1) {
      throw new Error(`the Telegram channel cue went wrong: ${JSON.stringify(telegramCue)}`)
    }
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: telegramBefore })
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: null })
    reportPresence()

    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: answerSession.sessionId,
      incarnationId: answerSession.lastProcess?.incarnationId, cause: 'explicit' })
    stoppedBeforeRestartSessionIds.add(answerSession.sessionId)

    // Epic 31 (Stories 31.1, 31.2): one history limit. The stand-in's own `bmn hook claude` calls teach BMN two
    // more Claude folders; Start cleanup, clicked in Preferences, writes all three and prunes the fake Codex and
    // OpenCode stores through recording binaries. The owner's real files are never in reach: the host's home,
    // CODEX_HOME and XDG_DATA_HOME are this run's scratch folders.
    console.error('[BMN] self-test phase: agent history')
    historyFixture = prepareHistoryFixture(isolatedCwd)
    // PostToolUse opens nothing, so the open-request counts the survival table compares stay put.
    const originGates = readdirSync(originDirectory).filter((name) => name.startsWith('done-')).length
    await fireOriginGate(originDirectory, originGates, { baseUrl: null, model: null, event: 'PostToolUse', configDir: historyFixture.glm })
    await fireOriginGate(originDirectory, originGates + 1, { baseUrl: null, model: null, event: 'PostToolUse', configDir: historyFixture.work })
    const historyStoreBefore = historyFixture.storeFiles()
    const historyPending = await client.request<AgentHistoryStatus>(METHOD_REGISTRY.historyStatus, {})
    const historyPendingView = await historyView(applicationWindow, 'read')
    const historyClicked = await historyView(applicationWindow, 'start-cleanup')
    const historyRunBy = Date.now() + 15_000
    let historySettled = await client.request<AgentHistoryStatus>(METHOD_REGISTRY.historyStatus, {})
    while ((historySettled.running || historySettled.agents.some((row) => row.lastRun === undefined)) && Date.now() < historyRunBy) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      historySettled = await client.request<AgentHistoryStatus>(METHOD_REGISTRY.historyStatus, {})
    }
    const historySettledView = await historyView(applicationWindow, 'read')
    const agentHistory = {
      pending: {
        needsConfirmation: historyPending.needsConfirmation,
        folders: historyPending.claude.map((folder) => ({ path: folder.path, current: folder.currentDays, target: folder.targetDays, pending: folder.pending })),
        agents: historyPending.agents.map((row) => ({ agent: row.agent, state: row.state, sessions: row.sessions, candidates: row.candidates })),
        view: historyPendingView
      },
      clicked: historyClicked,
      settled: {
        needsConfirmation: historySettled.needsConfirmation,
        days: [claudeDays(historyFixture.claudeHome), claudeDays(historyFixture.glm), claudeDays(historyFixture.work)],
        backups: [backupsOf(historyFixture.claudeHome), backupsOf(historyFixture.glm), backupsOf(historyFixture.work)],
        glmEnvKept: JSON.parse(readFileSync(join(historyFixture.glm, 'settings.json'), 'utf8')).env?.ANTHROPIC_MODEL === 'glm',
        codexCalls: recordedCalls(historyFixture.codexLog),
        openCodeCalls: recordedCalls(historyFixture.openCodeLog),
        cursorCalls: recordedCalls(historyFixture.cursorLog),
        runs: historySettled.agents.map((row) => ({ agent: row.agent, deleted: row.lastRun?.deleted, failures: row.lastRun?.failures.length })),
        storeUnchanged: JSON.stringify(historyFixture.storeFiles()) === JSON.stringify(historyStoreBefore),
        view: historySettledView
      }
    }
    console.error(`[BMN] self-test phase: agent history ${JSON.stringify(agentHistory)}`)
    const learnedFolders = [historyFixture.claudeHome, historyFixture.glm, historyFixture.work]
    const pendingFolder = (path: string, current: number | null) => agentHistory.pending.folders
      .some((folder) => folder.path === path && folder.current === current && folder.target === 30 && folder.pending)
    if (!agentHistory.pending.needsConfirmation || !pendingFolder(historyFixture.claudeHome, null) ||
      !pendingFolder(historyFixture.glm, 90) || !pendingFolder(historyFixture.work, null) ||
      JSON.stringify(agentHistory.pending.agents) !== JSON.stringify([
        { agent: 'codex', state: 'managed', sessions: 3, candidates: 1 }, { agent: 'opencode', state: 'managed', sessions: 3, candidates: 1 },
        { agent: 'cursor', state: 'own' }]) ||
      !historyPendingView.rows.includes('Cursor | keeps its own history · not managed by BMN') ||
      !historyPendingView.dot || historyPendingView.confirm !== 'Sets 3 Claude folders to 30 days; deletes 2 sessions for good.' ||
      !historyPendingView.rows.some((row) => row.startsWith('GLM | ') && row.endsWith('90 days → 30 days')) ||
      agentHistory.settled.needsConfirmation || historySettledView.dot || historySettledView.confirm !== null ||
      JSON.stringify(agentHistory.settled.days) !== '[30,30,30]' || JSON.stringify(agentHistory.settled.backups) !== '[1,1,1]' ||
      !agentHistory.settled.glmEnvKept ||
      JSON.stringify(agentHistory.settled.codexCalls) !== JSON.stringify([`${historyFixture.home}|delete --force ${historyFixture.ids.oldCodex}`]) ||
      JSON.stringify(agentHistory.settled.openCodeCalls) !== JSON.stringify([`${historyFixture.home}|session delete ${historyFixture.ids.oldOpenCode} --pure`]) ||
      JSON.stringify(agentHistory.settled.runs) !== '[{"agent":"codex","deleted":1,"failures":0},{"agent":"opencode","deleted":1,"failures":0},{"agent":"cursor"}]' ||
      agentHistory.settled.cursorCalls.length !== 0 ||
      !agentHistory.settled.storeUnchanged || learnedFolders.some((folder) => !historySettled.claude.some((row) => row.path === folder && !row.pending))) {
      throw new Error(`agent history went wrong: ${JSON.stringify(agentHistory)}`)
    }
    // The owner's own hand edit, made while BMN runs: after the restart it must show, not be undone.
    writeFileSync(join(historyFixture.glm, 'settings.json'), '{\n  "cleanupPeriodDays": 14\n}\n')

    // Close details and return selection to the lifecycle fixture the restart checks expect.
    await applicationWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('.session-inspector .panel-heading button')?.click();
      const row = document.querySelector('.session-row button[data-session-id="' + ${JSON.stringify(preloadProbe.templateCreatedSession.sessionId)} + '"]');
      if (!row) throw new Error('the lifecycle fixture disappeared after the model origin phase');
      row.click();
    })()`)

    const afterRenderer = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    // The voice flow stops and starts the destination session once, the hook-reported Codex phase
    // starts two sessions and resumes one, the terminal-mode program adds one, and Epic 16/18's
    // three synthetic sessions plus OpenCode Resume add four; the new OpenCode routing and repeat
    // fixtures add two more incarnations, and all are stopped again. Epic 29's model-origin run adds
    // one live incarnation that the application restart below interrupts.
    // Epic 30.2's remote-answer stand-in adds one more incarnation, stopped before this check.
    // Epic 31.3's Cursor phase adds three (direct, typed into a shell, resumed), all stopped.
    // Story 32.3's armed shell adds one more, stopped after its reset.
    if (afterRenderer.liveSessions !== 4 || afterRenderer.incarnationRecords !== 21) {
      throw new Error(`renderer restart duplicated or stopped a process: ${afterRenderer.liveSessions} live, ${afterRenderer.incarnationRecords} incarnations`)
    }
    // "What survives", renderer-crash row: the processes, the layout and the open requests outlive the view.
    const survivingRendererCrash = {
      liveProcesses: afterRenderer.liveSessions,
      incarnationRecords: afterRenderer.incarnationRecords,
      openRequestsBefore: openRequestsBeforeRendererRestart,
      openRequestsAfter: await openRequestCount()
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

    console.error('[BMN] self-test phase: application restart')
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
    console.error('[BMN] self-test phase: terminating first host')
    await client.request(METHOD_REGISTRY.healthGet, { selfTestHostLoss: true })
    console.error('[BMN] self-test phase: first host termination requested')
    await Promise.race([
      firstHostAbandoned,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('self-test host termination timed out')), 5_000))
    ])
    console.error('[BMN] self-test phase: first host released its database')
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
    console.error('[BMN] self-test phase: restarted host ready')
    applicationWindow.hide()
    client = restarted.client
    client.onAppEvent((message) => appEvents.forward(message))
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
    const restoredSettings = await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})
    const voicePersistedAfterRestart =
      JSON.stringify(restoredSettings.voice.vocabulary) === JSON.stringify([...preloadProbe.voiceFlow.approvedAfterRemove, 'Changed'])
    if (!voicePersistedAfterRestart) {
      throw new Error(`the voice vocabulary did not survive the restart: ${JSON.stringify(restoredSettings.voice)}`)
    }
    const restoredDrafts = await client.request<InputDraftRecord[]>(METHOD_REGISTRY.draftList, {})
    const restoredHandoff = restoredDrafts.find((draft) => draft.draftId === preloadProbe.handoffFlow.draftId)
    console.error('[BMN] self-test phase: restored state queried')
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
      restoredHealth.interruptedIncarnations !== 5
    ) {
      throw new Error('application restart did not interrupt every prior live incarnation')
    }
    // The sessions stopped before the restart are exited, not interrupted: only what the restart
    // itself ended is interrupted here.
    const priorLiveSessions = [...restoredDefaultSessions, ...restoredArchivedSessions]
      .filter((record) => !stoppedBeforeRestartSessionIds.has(record.sessionId))
    if (!priorLiveSessions.every((record) =>
      record.lastProcess?.state === 'interrupted' &&
      record.lastProcess.exitCode === null &&
      record.lastProcess.signal === null
    )) {
      throw new Error('session.list did not report the interrupted incarnation after application restart')
    }
    const openRequestsAfterApplicationRestart = await openRequestCount()
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
      restoredWorkspaces.length !== 3 ||
      restoredDefaultSessions.filter((item) => !stoppedBeforeRestartSessionIds.has(item.sessionId) &&
        item.sessionId !== originSession.sessionId)
        .map((item) => item.sessionId).join(',') !==
        defaultSessionsAfterLifecycleStop.map((item) => item.sessionId).join(',') ||
      restoredArchivedSessions[0]?.sessionId !== thirdSession.sessionId ||
      restoredLayout.selectedSessionId !== preloadProbe.templateCreatedSession.sessionId ||
      restoredLayout.sessionView[session.sessionId]?.scrollLine !== 19 ||
      restoredLayout.sessionView[session.sessionId]?.followTail !== false ||
      JSON.stringify(restoredBindings.map(persistedBindingView)) !==
        JSON.stringify(expectedBindings.map(persistedBindingView)) ||
      restoredHandoff?.state !== 'accepted' ||
      restoredHandoff.detail !== 'Pasted to terminal — not submitted' ||
      !restoredHandoff.artifactIds.includes(handoffArtifact.artifactId) ||
      restoredHandoff.attemptedIncarnationId === null
    ) {
      throw new Error('workspace/session order, layout, or bindings did not restore')
    }
    hostClient = client
    hostRendererPort = applicationPort
    trackSessionProcessStates(client)
    await recoverApplicationRenderer(applicationWindow)
    // The interrupted process is the selected dormant row after restart: its name quiets,
    // while selection still has the identity bar, selected fill and stronger weight.
    const interruptedSidebarAcceptance = await acceptanceWait(async () =>
      await applicationWindow!.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('.session-row.selected > button[data-session-id="${preloadProbe.templateCreatedSession.sessionId}"]');
        const row = button?.closest('.session-row');
        const name = row?.querySelector('.session-name');
        if (!button || !row || !name) return undefined;
        const probe = document.createElement('span');
        probe.style.color = 'var(--muted)';
        probe.style.borderLeft = '2px solid var(--identity)';
        probe.style.backgroundColor = 'var(--selected)';
        document.body.append(probe);
        const tokens = getComputedStyle(probe);
        const result = { live: row.getAttribute('data-live'), nameColor: getComputedStyle(name).color,
          muted: tokens.color, weight: getComputedStyle(name).fontWeight,
          bar: getComputedStyle(button).borderLeftColor, identity: tokens.borderLeftColor,
          fill: getComputedStyle(button).backgroundColor, selected: tokens.backgroundColor };
        probe.remove();
        // Recovery posts startup before the renderer finishes its first selected-row paint.
        return result.bar === result.identity && result.fill === result.selected ? result : undefined;
      })()`), 'interrupted selected sidebar row') as {
        live: string; nameColor: string; muted: string; weight: string
        bar: string; identity: string; fill: string; selected: string
      }
    if (lifecycleStoppedAfterRestart?.state !== 'interrupted' ||
      interruptedSidebarAcceptance.live !== 'false' ||
      interruptedSidebarAcceptance.nameColor !== interruptedSidebarAcceptance.muted ||
      interruptedSidebarAcceptance.weight !== '500' ||
      interruptedSidebarAcceptance.bar !== interruptedSidebarAcceptance.identity ||
      interruptedSidebarAcceptance.fill !== interruptedSidebarAcceptance.selected) {
      throw new Error(`the selected interrupted row lost its dormant or selection styling: ${JSON.stringify(interruptedSidebarAcceptance)}`)
    }
    console.error(`[BMN] self-test phase: interrupted selected sidebar ${JSON.stringify(interruptedSidebarAcceptance)}`)
    // Epic 12.1 AC4: the link and its name are still there after the database was closed and reopened.
    const restoredEvidence = (await client.request<ProgressRecord[]>(METHOD_REGISTRY.progressList, {}))
      .find((record) => record.sessionId === session.sessionId && record.source === 'evidence')
    if (
      restoredEvidence?.state !== 'verified' ||
      JSON.stringify(restoredEvidence.evidence) !== JSON.stringify(progressEvidence?.links)
    ) {
      throw new Error(
        `progress evidence did not survive the restart: ${JSON.stringify(restoredEvidence?.evidence)}`
      )
    }
    const stoppedStaleProgress = await stoppedPanelProgress(applicationWindow, secondSession.sessionId)
    if (
      !stoppedStaleProgress.includes('Observed self-test failure') ||
      !stoppedStaleProgress.includes('Last observed failed') ||
      !stoppedStaleProgress.includes('stale') ||
      !stoppedStaleProgress.includes('self-test')
    ) {
      throw new Error(`stale current-incarnation progress did not survive into the stopped view: ${stoppedStaleProgress}`)
    }
    // Epic 29 AC3: the restart dropped every origin; the next hook of the new run, not a SessionStart,
    // brings the flag back. After every restored-state check, so no count above sees this run.
    console.error('[BMN] self-test phase: model origin after restart')
    const originRelaunched = await applicationWindow.webContents.executeJavaScript(
      `window.aiTerminal.relaunchSession(${JSON.stringify(originSession.sessionId)})`
    ) as { incarnationId: string }
    await recoverApplicationRenderer(applicationWindow)
    const originBeforeHook = await modelOriginProbe(applicationWindow, originSession.sessionId, 'Model origin', null)
    // The next unused gate: the agent history phase fired two more after the origin scenarios.
    await fireOriginGate(originDirectory, readdirSync(originDirectory).filter((name) => name.startsWith('done-')).length,
      { baseUrl: 'https://api.z.ai/api/anthropic', model: null, event: 'PostToolUse' })
    const originAfterHook = await modelOriginProbe(applicationWindow, originSession.sessionId, 'Model origin', 'via api.z.ai')
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: originSession.sessionId,
      incarnationId: originRelaunched.incarnationId, cause: 'explicit' })
    const originStopped = await acceptanceWait(async () => {
      const seen = await modelOriginProbe(applicationWindow!, originSession.sessionId, 'Model origin', null)
      return seen.rowFlag === null ? seen : undefined
    }, 'stopped model origin row')
    await applicationWindow.webContents.executeJavaScript(
      `document.querySelector('.session-inspector .panel-heading button')?.click()`)
    const modelOriginAfterRestart = { before: originBeforeHook, after: originAfterHook, stopped: originStopped }
    if (originBeforeHook.rowFlag !== null || originBeforeHook.paneFlag !== null || originBeforeHook.modelRow !== null ||
      originBeforeHook.rowChip !== 'Shell' || originAfterHook.rowChip !== 'Claude' || originStopped.rowChip !== 'Shell' ||
      originAfterHook.rowFlag !== '🇨🇳' || originAfterHook.paneFlag !== '🇨🇳' ||
      originAfterHook.rowLabel !== 'Model origin: China via api.z.ai' ||
      originStopped.paneFlag !== null || originStopped.inspectorFlag !== null || originStopped.modelRow !== null) {
      throw new Error(`the model origin did not follow the restart: ${JSON.stringify(modelOriginAfterRestart)}`)
    }
    // Epic 31: the owner's hand edit survived the restart as a pending row with the dot, and was not rewritten.
    console.error('[BMN] self-test phase: agent history after restart')
    const historyAfterRestart = await client.request<AgentHistoryStatus>(METHOD_REGISTRY.historyStatus, {})
    const driftedFolder = historyAfterRestart.claude.find((folder) => folder.path === historyFixture?.glm)
    const historyAfterRestartView = await historyView(applicationWindow, 'read')
    const historyDrift = { needsConfirmation: historyAfterRestart.needsConfirmation, folder: driftedFolder ?? null,
      onDisk: historyFixture ? claudeDays(historyFixture.glm) : null, view: historyAfterRestartView }
    console.error(`[BMN] self-test phase: agent history after restart ${JSON.stringify(historyDrift)}`)
    if (!historyDrift.needsConfirmation || driftedFolder?.currentDays !== 14 || !driftedFolder.pending || historyDrift.onDisk !== 14 ||
      !historyAfterRestartView.dot || !historyAfterRestartView.rows.some((row) => row.startsWith('GLM | ') && row.endsWith('14 days → 30 days'))) {
      throw new Error(`agent history drift went wrong after the restart: ${JSON.stringify(historyDrift)}`)
    }
    // A dedicated live session on the restarted host, after every restored-state check, so no
    // earlier count, order or receipt value sees it.
    console.error('[BMN] self-test phase: renderer live exit feedback')
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
      attachmentId: liveExitRuntime.attachment.attachmentId,
      name: liveExitRuntime.name
    })
    if (rendererLiveExitLabel !== `Process exited · code 23 · ${liveExitRuntime.cwd}`) {
      throw new Error(
        `the live pane did not render the observed exit label: ${JSON.stringify(rendererLiveExitLabel)}`
      )
    }
    // The row the owner actually scans must stop calling a dead process live, without a restart.
    const rendererLiveExitSidebarWord = await sidebarSessionWord(applicationWindow, {
      sessionId: liveExitCreated.sessionId
    })
    if (rendererLiveExitSidebarWord !== 'Process exited') {
      throw new Error(
        `the sidebar row did not follow the exit: ${JSON.stringify(rendererLiveExitSidebarWord)}`
      )
    }
    console.error('[BMN] self-test phase: renderer recovery after shell exit')
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

    // Epic 14.1: the working/idle word the shell observes, from real output and real titles, with
    // nothing derived acting. Each fixture waits on a gate file, so its clock starts after the
    // renderer holds the session and the first byte lands where the assertions expect it.
    console.error('[BMN] self-test phase: observed session activity')
    const activityGate = join(isolatedCwd, 'activity-gate')
    const gated = (body: string): string[] => [
      '--noprofile',
      '--norc',
      '-c',
      `while [ ! -f ${JSON.stringify(activityGate)} ]; do sleep 0.05; done; ${body}`
    ]
    const activityFixtures = [
      // Prints every 200 ms, then stops: Working while it prints, Idle 1.5-2.0 s after the last byte.
      ['burst', 'Activity burst', gated("for index in $(seq 1 8); do printf 'x\\n'; sleep 0.2; done; printf 'DONE\\n'; sleep 300")],
      // Never prints: Running for the start grace, then Idle, and never Working.
      ['silent', 'Activity silent', ['--noprofile', '--norc', '-c', 'sleep 300']],
      // First byte inside the 3 s grace: Working at once, and never Running again.
      ['late', 'Activity late first byte', gated("sleep 1; printf 'FIRST\\n'; sleep 300")],
      // The two titles the table knows, each while otherwise silent, then output under a known title.
      ['titled', 'Activity titles', gated(
        "printf '\\033]0;\u2733 x\\007\\n'; sleep 4; printf '\\033]0;Action Required x\\007\\n'; sleep 4; " +
        "printf '\\033]0;\u2733 y\\007\\n'; for index in $(seq 1 200); do printf '.\\n'; sleep 0.05; done"
      )],
      // A ~100 Hz source: the presented word must still change at most twice a second.
      ['flood', 'Activity flood', gated("for index in $(seq 1 1200); do printf '.\\n'; sleep 0.01; done; sleep 300")]
    ] as const
    const activityIds: Record<string, string> = {}
    for (const [key, name, argv] of activityFixtures) {
      const created = await createSessionRuntime({
        workspaceId: DEFAULT_WORKSPACE_ID,
        name,
        cwd: isolatedCwd,
        executable: '/bin/bash',
        argv: [...argv],
        cols: 80,
        rows: 24
      }, true)
      activityIds[key] = created.session.sessionId
    }
    await recoverApplicationRenderer(applicationWindow)
    // The gate opens only once the renderer holds every fixture: output before the pane exists is
    // output the shell never observes, and the assertions below measure from the first byte.
    await applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const ids = Object.values(${JSON.stringify(activityIds)});
        const deadline = Date.now() + 15000;
        const probe = () => {
          const words = window.__bmnActivity?.words() ?? {};
          const hook = window.__aitermTest;
          const ready = hook && ids.every((id) => {
            if (words[id] === undefined) return false;
            try { return hook.snapshot(id) !== null } catch { return false }
          });
          if (ready) resolve(true);
          else if (Date.now() >= deadline) reject(new Error('the activity fixtures never reached the renderer'));
          else setTimeout(probe, 25);
        };
        probe();
      })
    `)
    const activityWindowMs = 10_500
    const activitySampling = applicationWindow.webContents.executeJavaScript(`
      (async () => {
        const ids = ${JSON.stringify(activityIds)};
        const probe = window.__bmnActivity;
        const hook = window.__aitermTest;
        if (!probe || !hook) throw new Error('the activity probes are unavailable');
        const entries = Object.entries(ids);
        const snapshotOf = (id) => { try { return hook.snapshot(id) } catch { return null } };
        const shapeOf = (id) => {
          const snapshot = snapshotOf(id);
          return snapshot === null ? null : {
            cols: snapshot.cols, rows: snapshot.rows, refits: snapshot.refits, inputEvents: snapshot.inputEvents
          };
        };
        const byKey = (read) => Object.fromEntries(entries.map(([key, id]) => [key, read(id)]));
        const before = byKey(shapeOf);
        const attentionBefore = (await window.aiTerminal.listAttention()).length;
        const samples = [];
        const until = Date.now() + ${activityWindowMs};
        while (Date.now() < until) {
          const words = probe.words();
          const titles = probe.titles();
          const burst = snapshotOf(ids.burst);
          samples.push({
            at: Date.now(),
            words: byKey((id) => words[id] ?? null),
            titles: byKey((id) => titles[id] ?? null),
            burstDone: burst !== null && burst.bufferLines.join('').includes('DONE')
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const updates = probe.updates();
        return {
          samples,
          attentionBefore,
          attentionAfter: (await window.aiTerminal.listAttention()).length,
          updates: byKey((id) => updates[id] ?? 0),
          before,
          after: byKey(shapeOf),
          burstBuffer: ((snapshotOf(ids.burst) ?? {}).bufferLines ?? []).join('|').slice(0, 300)
        };
      })()
    `) as Promise<ActivitySampling>
    writeFileSync(activityGate, '')
    console.error(`[BMN] self-test phase: activity gate ${activityGate} exists=${existsSync(activityGate)}`)
    const gateAt = Date.now()
    const activity = await activitySampling
    const wordAt = (offset: number, key: string): string | null => {
      const target = gateAt + offset
      const closest = activity.samples.reduce((best, candidate) =>
        Math.abs(candidate.at - target) < Math.abs(best.at - target) ? candidate : best)
      return closest.words[key] ?? null
    }
    const wordsOf = (key: string): (string | null)[] => activity.samples.map((sample) => sample.words[key] ?? null)
    const burstDoneAt = activity.samples.find((sample) => sample.burstDone)?.at ?? null
    const burstWord = (offset: number): string | null => {
      const target = (burstDoneAt ?? gateAt) + offset
      const closest = activity.samples.reduce((best, candidate) =>
        Math.abs(candidate.at - target) < Math.abs(best.at - target) ? candidate : best)
      return closest.words.burst ?? null
    }
    const lateWords = wordsOf('late')
    const lateWorking = lateWords.indexOf('Working')
    const silentWords = wordsOf('silent')
    const silentIdle = silentWords.indexOf('Idle')
    const sessionActivity = {
      burstLastByteAfterGateMs: burstDoneAt === null ? null : burstDoneAt - gateAt,
      // AC1: Working at 1.0 s of silence, Idle by 2.5 s.
      burstAfterOneSecond: burstWord(1_000),
      burstAfterTwoAndAHalf: burstWord(2_500),
      // AC1: a silent fresh incarnation reads Running, then Idle, and never Working.
      silentEarly: wordAt(500, 'silent'),
      silentLate: wordAt(4_500, 'silent'),
      silentEverWorking: silentWords.includes('Working'),
      silentRunningAfterIdle: silentIdle === -1 ? true : silentWords.slice(silentIdle).includes('Running'),
      // AC1: the first byte wins inside the grace, and Running never comes back.
      lateBeforeFirstByte: lateWords.slice(0, lateWorking === -1 ? 0 : lateWorking),
      lateRunningAfterOutput: lateWorking === -1 ? true : lateWords.slice(lateWorking).includes('Running'),
      lateAfterFourSeconds: wordAt(4_000, 'late'),
      // AC2: a known title names the resting word, is shown, and never makes a session working.
      titledResting: wordAt(2_500, 'titled'),
      titledRestingTitle: activity.samples.reduce((best, candidate) =>
        Math.abs(candidate.at - (gateAt + 2_500)) < Math.abs(best.at - (gateAt + 2_500)) ? candidate : best).titles.titled,
      titledActionRequired: wordAt(6_500, 'titled'),
      titledWhilePrinting: wordAt(9_500, 'titled'),
      // AC4: at most two presentation updates per second per session, even at ~100 Hz.
      updates: activity.updates,
      updateCap: Math.ceil((activityWindowMs / 1_000) * 2),
      // AC4: nothing derived writes to a PTY, refits a terminal or touches a request.
      inputEvents: Object.fromEntries(Object.entries(activity.after).map(([key, shape]) => [key, shape?.inputEvents ?? null])),
      geometryUnchanged: Object.entries(activity.after).every(([key, shape]) => {
        const start = activity.before[key]
        return !!shape && !!start && shape.cols === start.cols && shape.rows === start.rows && shape.refits === start.refits
      }),
      attentionUnchanged: activity.attentionBefore === activity.attentionAfter
    }
    console.error(`[BMN] self-test phase: session activity ${JSON.stringify(sessionActivity)}`)
    console.error(`[BMN] self-test phase: activity last sample ${JSON.stringify({
      words: activity.samples.at(-1)?.words ?? null,
      titles: activity.samples.at(-1)?.titles ?? null,
      samples: activity.samples.length,
      burstBuffer: activity.burstBuffer,
      shapes: activity.before
    })}`)
    if (burstDoneAt === null) throw new Error('the activity burst session never printed its last byte')
    if (sessionActivity.burstAfterOneSecond !== 'Working' || sessionActivity.burstAfterTwoAndAHalf !== 'Idle') {
      throw new Error('output activity did not hold Working for 1.5 s of silence and then rest')
    }
    if (sessionActivity.silentEarly !== 'Running' || sessionActivity.silentLate !== 'Idle') {
      throw new Error('a silent fresh incarnation did not read Running and then Idle')
    }
    if (sessionActivity.silentEverWorking || sessionActivity.silentRunningAfterIdle) {
      throw new Error('a session that printed nothing was called working, or went back to Running')
    }
    if (lateWorking === -1 || sessionActivity.lateBeforeFirstByte.includes('Idle')) {
      throw new Error('the first byte did not make a starting session working inside its grace')
    }
    if (sessionActivity.lateRunningAfterOutput || sessionActivity.lateAfterFourSeconds !== 'Idle') {
      throw new Error('a session that has printed went back to Running')
    }
    if (sessionActivity.titledResting !== 'Idle' || sessionActivity.titledRestingTitle !== '\u2733 x') {
      throw new Error('the terminal title was not kept and shown while the session rested')
    }
    if (sessionActivity.titledActionRequired !== 'Action required') {
      throw new Error('a known title did not name the resting word')
    }
    if (sessionActivity.titledWhilePrinting !== 'Working') {
      throw new Error('a title overruled output activity')
    }
    for (const [key, count] of Object.entries(sessionActivity.updates)) {
      if (count > sessionActivity.updateCap) {
        throw new Error(`session ${key} published ${count} activity updates, past the throttle`)
      }
    }
    if (Object.values(sessionActivity.inputEvents).some((count) => count !== 0)) {
      throw new Error('observing activity wrote to a PTY')
    }
    if (!sessionActivity.geometryUnchanged) throw new Error('observing activity refit or remounted a terminal')
    if (!sessionActivity.attentionUnchanged) throw new Error('observing activity opened or resolved a request')

    // Epic 14.2: what opened a request and what closed it, and the log of events that says why a
    // request the owner expected never arrived. Real hook events through the installed `bmn hook`.
    /**
     * Epic 17.1: exercise the resume cohort for an update-restart stop cause. The source updater
     * waits for BMN to exit and does not issue that cause; this fixture tests the cohort UI, not
     * the `update:desktop` use site.
     */
    console.error('[BMN] self-test phase: resume after an update stop')
    const resumeOfferDirectory = join(isolatedCwd, 'resume-offer')
    const firstRecorder = writeArgvRecorder(resumeOfferDirectory, 'first-agent')
    const secondRecorder = writeArgvRecorder(resumeOfferDirectory, 'second-agent')
    const stoppedByUpdate = []
    for (const recorder of [firstRecorder, secondRecorder]) {
      const { session: record, startup: created } = await createSessionRuntime({
        workspaceId: DEFAULT_WORKSPACE_ID,
        name: `Update ${basename(recorder.executable)}`,
        cwd: isolatedCwd,
        executable: recorder.executable,
        argv: ['--keep-going'],
        cols: 80,
        rows: 24
      }, true)
      stoppedByUpdate.push({ record, created, recorder })
    }
    await untilHarnessRuns(firstRecorder.log, 1)
    await untilHarnessRuns(secondRecorder.log, 1)
    const updateTargets = stoppedByUpdate.flatMap(({ record }) => {
      const runtime = runtimes.get(record.sessionId)
      const target = runtime
        ? runningTargetForRuntime({
            ...runtime.session,
            executable: runtime.executable,
            processState: runtime.processState
          })
        : undefined
      return target ? [target] : []
    })
    if (updateTargets.length !== 2) throw new Error('the update-stop fixture did not start two sessions')
    await stopCurrentTargets(updateTargets, 'update-restart')
    const updateCohort = await client.request<InterruptedSessionCohort | null>(
      METHOD_REGISTRY.sessionCohortList,
      {}
    )
    if (updateCohort?.cause !== 'update-restart' || updateCohort.entries.length !== 2) {
      throw new Error(`the update stop did not form its own cohort: ${JSON.stringify(updateCohort)}`)
    }
    // The next start: a fresh window load, exactly what the owner sees after `update:desktop`.
    const reloadedAfterUpdate = waitForRendererLoad(applicationWindow)
    applicationWindow.webContents.reload()
    await reloadedAfterUpdate
    await waitForRendererHook(applicationWindow)
    const offerAfterUpdate = await resumeOfferShown(applicationWindow)
    const expectedCommands = stoppedByUpdate
      .map(({ recorder }) => `${recorder.executable} --keep-going`)
    if (
      offerAfterUpdate.heading !== 'Resume what the update stopped?' ||
      offerAfterUpdate.summary !== 'a desktop update stopped 2 sessions. Nothing has started since.' ||
      // No conversation was ever captured for these, so both rows are Start again and start unchecked.
      offerAfterUpdate.button !== 'Resume 0 sessions' ||
      JSON.stringify(offerAfterUpdate.rows.map((row) => row.command).sort()) !==
        JSON.stringify([...expectedCommands].sort()) ||
      offerAfterUpdate.rows.some((row) => row.checked)
    ) {
      throw new Error(`the resume offer did not read as expected: ${JSON.stringify(offerAfterUpdate)}`)
    }
    // Dismissed without an answer: nothing may have started, and the palette must bring it back.
    await closeResumeOffer(applicationWindow)
    if (harnessRuns(firstRecorder.log).length !== 1 || harnessRuns(secondRecorder.log).length !== 1) {
      throw new Error('dismissing the resume offer started a process')
    }
    const paletteReopened = await runPaletteCommand(applicationWindow, 'Resume interrupted sessions…')
    if (paletteReopened !== 'ran') {
      throw new Error(`the palette did not offer to reopen the dismissed offer: ${paletteReopened}`)
    }
    const reopenedOffer = await resumeOfferShown(applicationWindow)
    if (JSON.stringify(reopenedOffer.rows.map((row) => row.command).sort()) !==
      JSON.stringify([...expectedCommands].sort())) {
      throw new Error(`the palette reopened something else: ${JSON.stringify(reopenedOffer)}`)
    }
    const offerAnswered = await applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const dialog = document.querySelector('dialog.resume-interrupted[open]');
        if (!dialog) { reject(new Error('the resume offer closed before it was answered')); return; }
        for (const box of dialog.querySelectorAll('input[type=checkbox]')) box.click();
        resolve(true);
      })
    `) as boolean
    if (!offerAnswered) throw new Error('the resume offer rows could not be checked')
    const offerResult = await pressResumeOffer(applicationWindow)
    if (offerResult.rows.some((row) => row.outcome !== 'Started')) {
      throw new Error(`a checked row did not start: ${JSON.stringify(offerResult.rows)}`)
    }
    const restartedArgv = await Promise.all([firstRecorder, secondRecorder]
      .map((recorder) => untilHarnessRuns(recorder.log, 2)))
    if (!restartedArgv.every((runs) => JSON.stringify(runs[1]) === JSON.stringify(['--keep-going']))) {
      throw new Error(`the started rows ran something else: ${JSON.stringify(restartedArgv)}`)
    }
    await closeResumeOffer(applicationWindow)
    // A second start must not ask again: the cohort was offered, and both of its rows are running.
    const reloadedAgain = waitForRendererLoad(applicationWindow)
    applicationWindow.webContents.reload()
    await reloadedAgain
    await waitForRendererHook(applicationWindow)
    const offerStayedAwayAfterSecondStart = await resumeOfferStaysAway(applicationWindow, 750)
    if (!offerStayedAwayAfterSecondStart) {
      throw new Error('the resume offer asked again after a second start')
    }
    console.error(`[BMN] self-test phase: resume after an update stop ${JSON.stringify({
      heading: offerAfterUpdate.heading,
      summary: offerAfterUpdate.summary,
      commands: offerAfterUpdate.rows.map((row) => row.command),
      startsUnchecked: offerAfterUpdate.rows.every((row) => !row.checked),
      dismissedStartedNothing: true,
      reopenedFromPalette: reopenedOffer.rows.map((row) => row.command),
      outcomes: offerResult.rows.map((row) => row.outcome),
      argv: restartedArgv.map((runs) => runs[1] ?? null),
      quitCohortOfferedAt: quitCohortOffer.offeredAt,
      offerStayedAwayAfterRendererRestart,
      offerStayedAwayAfterSecondStart
    })}`)
    // The fixture leaves nothing running: later phases count on the sessions they started themselves.
    for (const { record } of stoppedByUpdate) {
      const runtime = runtimes.get(record.sessionId)
      if (!runtime) continue
      await client.request(METHOD_REGISTRY.sessionStop, {
        sessionId: runtime.session.sessionId,
        incarnationId: runtime.session.incarnationId,
        cause: 'explicit'
      })
    }

    console.error('[BMN] self-test phase: request provenance and hook events')
    const hookHarness = writeClaudeHookHarness(join(isolatedCwd, 'claude-harness'))
    const hookSession = await createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Hook provenance',
      cwd: isolatedCwd,
      executable: hookHarness.executable,
      argv: [],
      cols: 80,
      rows: 24
    }, true)
    const isolationHarness = writeIsolationHookHarness(join(isolatedCwd, 'isolation-harness'))
    const isolationSession = await createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Hook isolation',
      cwd: isolatedCwd,
      executable: isolationHarness.executable,
      argv: [],
      cols: 80,
      rows: 24
    }, true)
    await recoverApplicationRenderer(applicationWindow)
    await untilFileExists(hookHarness.opened, 'opened its first request')
    await untilFileExists(isolationHarness.fired, 'fired its own hook event')
    const requestsOf = async (): Promise<AttentionRecord[]> =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .filter((request) => request.sessionId === hookSession.session.sessionId)
    const untilRequest = async (
      what: string,
      matches: (request: AttentionRecord) => boolean
    ): Promise<AttentionRecord> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const found = (await requestsOf()).find(matches)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`the hook fixture never produced ${what}: ${JSON.stringify(await requestsOf())}`)
    }
    const openedByHook = await untilRequest('an open request', (request) => request.state === 'open')
    writeFileSync(hookHarness.toolGate, '')
    await untilFileExists(hookHarness.resolved, 'ran its tool')
    const resolvedByHook = await untilRequest(
      'a resolved request',
      (request) => request.requestId === openedByHook.requestId && request.state !== 'open'
    )
    // A second identical prompt, so the owner can answer one in the terminal instead of through a hook.
    writeFileSync(hookHarness.secondGate, '')
    await untilFileExists(hookHarness.reopened, 'reopened its request')
    const reopenedByHook = await untilRequest(
      'a second open request',
      (request) => request.requestId !== openedByHook.requestId && request.state === 'open'
    )
    const hookProvenance = await applicationWindow.webContents.executeJavaScript(`
      (async () => {
        const sessionId = ${JSON.stringify(hookSession.session.sessionId)};
        const otherSessionId = ${JSON.stringify(isolationSession.session.sessionId)};
        const wait = async (read, what) => {
          const deadline = Date.now() + 10000;
          for (;;) {
            const value = await read();
            if (value !== undefined && value !== null) return value;
            if (Date.now() >= deadline) throw new Error('the hook events probe timed out waiting for ' + what);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        };
        const hook = window.__aitermTest;
        const pane = await wait(() => document.querySelector('.session-terminal[data-session-id="' + sessionId + '"]'), 'the pane');
        const textarea = pane.querySelector('.xterm-helper-textarea');
        if (!textarea) throw new Error('the hook fixture pane has no terminal input');
        const openRequestsBefore = (await window.aiTerminal.listAttention()).length;
        // The pane only answers for the owner once the window itself knows the request is open.
        await wait(() => pane.querySelector('.pane-heading .status-dot.needs-you'), 'the pane to need the owner');
        // Typing into a pane that needs the owner answers its open requests, and records that it did.
        // xterm reads the legacy keyCode, so a synthetic event without one produces no key at all.
        const typeOneKey = () => textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'y', code: 'KeyY', keyCode: 89, which: 89, bubbles: true, cancelable: true
        }));
        typeOneKey();
        const answeredByTyping = await wait(async () => {
          const found = (await window.aiTerminal.listAttention())
            .find((request) => request.requestId === ${JSON.stringify(reopenedByHook.requestId)});
          if (found && found.state !== 'open') return found;
          typeOneKey();
          return undefined;
        }, 'the typed answer');
        const beforeList = hook.snapshot(sessionId).inputEvents;
        const rowMenu = await wait(() => document.querySelector('[aria-label="Actions for Hook provenance"]'), 'the row menu');
        rowMenu.click();
        const entry = await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
          .find((item) => item.textContent?.trim() === 'Hook events…'), 'the Hook events entry');
        entry.click();
        const dialog = await wait(() => document.querySelector('dialog.hook-events-dialog[open]'), 'the Hook events dialog');
        const rows = await wait(() => {
          const listed = [...dialog.querySelectorAll('.hook-events li')];
          return listed.length >= 3 ? listed.map((row) => row.textContent?.trim() ?? '') : undefined;
        }, 'the listed events');
        const events = await window.aiTerminal.listHookEvents(sessionId);
        const afterList = hook.snapshot(sessionId).inputEvents;
        dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
        const closed = await wait(() => document.querySelector('dialog.hook-events-dialog') === null ? true : undefined, 'the dialog to close');
        return {
          answeredByTypingResolvedBy: answeredByTyping.resolvedBy,
          answeredByTypingState: answeredByTyping.state,
          rows,
          events: events.map((event) => ({ event: event.event, effects: event.effects, toolName: event.toolName })),
          otherSessionEvents: (await window.aiTerminal.listHookEvents(otherSessionId))
            .map((event) => ({ event: event.event, effects: event.effects })),
          listWroteToPty: afterList !== beforeList,
          openRequestsBefore,
          openRequestsAfter: (await window.aiTerminal.listAttention()).length,
          closed
        };
      })()
    `) as HookProvenanceProbe
    const syntheticClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    const syntheticCodexConfigDir = process.env.CODEX_HOME
    const syntheticOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (!syntheticClaudeConfigDir || !syntheticCodexConfigDir || !syntheticOpenCodeConfigDir) {
      throw new Error('hook integration self-test requires isolated harness config directories')
    }
    const syntheticClaudeSettings = join(syntheticClaudeConfigDir, 'settings.json')
    mkdirSync(syntheticClaudeConfigDir, { recursive: true })
    const configuredClaudeEvents = [
      'Notification', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit',
      'Stop', 'SessionStart', 'SessionEnd'
    ]
    writeFileSync(syntheticClaudeSettings, `${JSON.stringify({ hooks: Object.fromEntries(
      configuredClaudeEvents.map((event) => [event, [{ hooks: [{ type: 'command', command: 'bmn hook claude' }] }]])
    ) }, null, 2)}\n`)
    const configBefore = readFileSync(syntheticClaudeSettings, 'utf8')
    const codexFile = join(syntheticCodexConfigDir, 'hooks.json')
    const openCodePlugin = join(syntheticOpenCodeConfigDir, 'plugins', 'bmn.ts')
    const absentBefore = !existsSync(codexFile) && !existsSync(openCodePlugin)
    const hookIntegrationUi = await applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read, name) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('hook integration timed out: ' + name); };
      const hookSessionId = ${JSON.stringify(hookSession.session.sessionId)};
      const beforeRequests = (await window.aiTerminal.listAttention()).length;
      const openDetails = async (name) => {
        (await wait(() => document.querySelector('[aria-label="Actions for ' + name + '"]'), name + ' menu')).click();
        (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
          .find(row => row.textContent.trim() === 'Session details'), 'Session details action')).click();
        return wait(() => document.querySelector('.session-inspector .hook-observation'), 'observation panel');
      };
      let observation = await openDetails('Hook provenance');
      await wait(() => observation.textContent.includes('Observed by BMN') ? true : null, 'observed hook');
      const observed = observation.textContent.includes('Claude Code') &&
        observation.textContent.includes('Notification') &&
        observation.textContent.includes('Hook provenance') &&
        observation.textContent.includes('run ');
      const inputBefore = window.__aitermTest.snapshot(hookSessionId).inputEvents;
      (await wait(() => [...observation.querySelectorAll('button')]
        .find(button => button.textContent === 'Open Hook events'), 'events link')).click();
      const events = await wait(() => document.querySelector('dialog.hook-events-dialog[open]'), 'hook events from observation');
      const openedEvents = await wait(() => events.textContent.includes('Notification') ? true : null, 'hook events rendered');
      events.querySelector('.app-dialog-heading button').click();
      observation = await wait(() => document.querySelector('.session-inspector .hook-observation'), 'returned observation');
      (await wait(() => [...observation.querySelectorAll('button')]
        .find(button => button.textContent === 'Check configured hooks in Preferences'), 'configuration link')).click();
      const preferences = await wait(() => document.querySelector('dialog.preferences-dialog[open]'), 'Preferences');
      const limit = preferences.textContent.includes('Configured entries do not prove hooks fired.') &&
        preferences.textContent.includes('trust hooks with /hooks');
      (await wait(() => [...preferences.querySelectorAll('button')]
        .find(button => button.textContent === 'Check configured hooks'), 'check button')).click();
      const report = await wait(() => preferences.querySelector('.hook-check-report'), 'dated hook check');
      const configured = report.textContent.includes('Claude Code') &&
        report.textContent.includes('Configured') && report.textContent.includes('Checked ');
      const missing = report.textContent.includes('Codex') &&
        report.textContent.includes('OpenCode') && report.textContent.includes('Cursor') && report.textContent.includes('Missing entry');
      preferences.querySelector('.app-dialog-heading button').click();
      const inputAfter = window.__aitermTest.snapshot(hookSessionId).inputEvents;
      document.querySelector('.session-inspector .panel-heading button')?.click();
      observation = await openDetails('Petition destination');
      await wait(() => observation.textContent.includes('Not observed in this run') ? true : null, 'untouched run');
      const notObserved = observation.textContent.includes('Not observed in this run') &&
        !observation.textContent.includes('Broken');
      document.querySelector('.session-inspector .panel-heading button')?.click();
      return { observed, openedEvents, configured, missing, limit, notObserved,
        ptyInputUnchanged: inputBefore === inputAfter,
        attentionUnchanged: (await window.aiTerminal.listAttention()).length === beforeRequests };
    })()`) as {
      observed: boolean; openedEvents: boolean; configured: boolean; missing: boolean;
      limit: boolean; notObserved: boolean; ptyInputUnchanged: boolean; attentionUnchanged: boolean
    }
    const hookIntegrationAcceptance = {
      ...hookIntegrationUi,
      configUnchanged: readFileSync(syntheticClaudeSettings, 'utf8') === configBefore &&
        absentBefore && !existsSync(codexFile) && !existsSync(openCodePlugin)
    }
    if (Object.values(hookIntegrationAcceptance).some((value) => value !== true)) {
      throw new Error(`hook integration view did not distinguish configured and observed: ${JSON.stringify(hookIntegrationAcceptance)}`)
    }
    for (const runtime of [hookSession, isolationSession]) {
      await client.request(METHOD_REGISTRY.sessionStop, {
        sessionId: runtime.session.sessionId,
        incarnationId: runtime.session.lastProcess?.incarnationId,
        cause: 'explicit'
      })
    }
    const requestProvenance = {
      openedBy: openedByHook.openedBy,
      openedResolvedBy: openedByHook.resolvedBy,
      resolvedState: resolvedByHook.state,
      resolvedBy: resolvedByHook.resolvedBy,
      typedState: hookProvenance.answeredByTypingState,
      typedResolvedBy: hookProvenance.answeredByTypingResolvedBy,
      hookEvents: hookProvenance.events,
      listedRows: hookProvenance.rows,
      otherSessionEvents: hookProvenance.otherSessionEvents,
      listWroteToPty: hookProvenance.listWroteToPty,
      openRequestsUnchanged: hookProvenance.openRequestsBefore === hookProvenance.openRequestsAfter,
      dialogClosed: hookProvenance.closed
    }
    console.error(`[BMN] self-test phase: request provenance ${JSON.stringify(requestProvenance)}`)
    if (requestProvenance.openedBy !== 'hook:claude:Notification') {
      throw new Error(`the hook-opened request did not record its event: ${requestProvenance.openedBy}`)
    }
    if (requestProvenance.openedResolvedBy !== null) {
      throw new Error('an open request already carried a resolver')
    }
    if (requestProvenance.resolvedState !== 'answered' ||
      requestProvenance.resolvedBy !== 'hook:claude:PostToolUse') {
      throw new Error(`the tool run did not record what resolved the request: ${JSON.stringify(requestProvenance)}`)
    }
    if (requestProvenance.typedState === 'open' || requestProvenance.typedResolvedBy !== 'input') {
      throw new Error(`typing did not record that it answered: ${JSON.stringify(requestProvenance)}`)
    }
    const listedEvents = requestProvenance.hookEvents.map((event) => event.event)
    if (JSON.stringify(listedEvents) !== JSON.stringify(['Notification', 'PostToolUse', 'Notification'])) {
      throw new Error(`the hook event log did not hold the events that arrived: ${listedEvents.join(',')}`)
    }
    if (!requestProvenance.hookEvents[0]?.effects.includes('opened') ||
      !requestProvenance.hookEvents[1]?.effects.includes('answered') ||
      requestProvenance.hookEvents[1]?.toolName !== 'Bash') {
      throw new Error(`the hook event log did not say what each event changed: ${JSON.stringify(requestProvenance.hookEvents)}`)
    }
    if (!requestProvenance.listedRows.some((row) => row.includes('PostToolUse · Bash'))) {
      throw new Error(`the Hook events list did not show the events: ${JSON.stringify(requestProvenance.listedRows)}`)
    }
    // Two live sessions, each firing its own events: neither log may carry the other's.
    if (JSON.stringify(requestProvenance.otherSessionEvents) !==
      JSON.stringify([{ event: 'Isolation-Probe', effects: [] }])) {
      throw new Error(`the other session's log is not its own: ${JSON.stringify(requestProvenance.otherSessionEvents)}`)
    }
    if (listedEvents.includes('Isolation-Probe')) throw new Error('a session read another session’s hook events')
    if (requestProvenance.listWroteToPty) throw new Error('opening the Hook events list wrote to a PTY')
    if (!requestProvenance.openRequestsUnchanged) throw new Error('opening the Hook events list changed a request')
    if (!requestProvenance.dialogClosed) throw new Error('the Hook events dialog did not close on Escape')


    // The close question itself: asked inside the window, in session names, and answerable.
    console.error('[BMN] self-test phase: close prompt')
    const closePromptRuntime = runtimes.get(hookSession.startup.sessionId)
    if (!closePromptRuntime) throw new Error('the hook session has no runtime for the close prompt')
    const closePromptAnswer = askTheWindow('close', [{
      sessionId: closePromptRuntime.session.sessionId,
      incarnationId: closePromptRuntime.session.incarnationId,
      executable: closePromptRuntime.executable,
      processState: 'live'
    }])
    const closePromptShown = await closePromptDialogText(applicationWindow)
    const closePromptDecision = await closePromptAnswer
    const closePrompt = {
      heading: closePromptShown.heading,
      summary: closePromptShown.summary,
      rows: closePromptShown.rows,
      decision: closePromptDecision?.kind ?? 'unanswered'
    }
    console.error(`[BMN] self-test phase: close prompt ${JSON.stringify(closePrompt)}`)
    if (closePrompt.heading !== 'Close BMN?') {
      throw new Error(`the close prompt did not head with its question: ${closePrompt.heading}`)
    }
    if (closePrompt.summary !== '1 session is still running. Keep them running, or stop them.') {
      throw new Error(`the close prompt did not summarize the running work: ${closePrompt.summary}`)
    }
    // The owner's words for the session, and no identifier anywhere in the row.
    if (!closePrompt.rows[0]?.includes(closePromptRuntime.name) || closePrompt.rows.length !== 1) {
      throw new Error(`the close prompt did not name the session: ${JSON.stringify(closePrompt.rows)}`)
    }
    if (closePrompt.rows[0]?.includes(closePromptRuntime.session.sessionId)) {
      throw new Error('the close prompt showed an identifier to the owner')
    }
    if (closePrompt.decision !== 'cancel') {
      throw new Error(`the owner's answer did not reach the main process: ${closePrompt.decision}`)
    }

    // Epic 26.2: the survival-table endings no automated check had exercised. The two stops run
    // through the exact paths the window close and the Stop button drive; the sessions are the
    // long-lived fixtures whose panes are mounted, so the final capture is the real snapshot.
    console.error('[BMN] self-test phase: survival endings')
    const processRow = async (sessionId: string): Promise<SessionProcessStatus | null> =>
      (await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, { workspaceId: DEFAULT_WORKSPACE_ID }))
        .find((row) => row.sessionId === sessionId)?.lastProcess ?? null
    const catalogFor = async (sessionId: string): Promise<SavedOutputCatalog> =>
      await client.request<SavedOutputCatalog>(METHOD_REGISTRY.terminalSavedOutputGet, { sessionId })
    const savedCurrent = async (sessionId: string): Promise<string | null> =>
      (await catalogFor(sessionId)).current?.content ?? null

    /**
     * The renderer also takes activity captures after output, so a marker in saved output alone
     * cannot prove the lifecycle flush ran. The self-test recorder observes only calls made by
     * flushAllSavedOutput through the production lifecycle, and only counts an acknowledged
     * capture for this exact session after the ending begins.
     */
    const stopWithFinalCapture = async (
      sessionId: string,
      marker: string,
      stop: () => Promise<unknown> | void,
      description: string
    ): Promise<{ lifecycleCaptureAcknowledged: boolean }> => {
      const catalog = await catalogFor(sessionId)
      if ([catalog.current, ...catalog.history].some((entry) => entry?.content.includes(marker))) {
        throw new Error(`the ${marker} marker already exists in the saved output`)
      }
      const runtime = runtimes.get(sessionId)
      if (!runtime) throw new Error(`the ${marker} target runtime is missing`)
      await client.request(METHOD_REGISTRY.terminalWrite, {
        attachmentId: runtime.attachment.attachmentId,
        bytes: new TextEncoder().encode(`echo ${marker}\r`)
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
      const firstCapture = selfTestLifecycleCaptures.length
      await stop()
      await acceptanceWait(async () =>
        selfTestLifecycleCaptures.slice(firstCapture).some((entry) =>
          entry.sessionId === sessionId && entry.status === 'saved') ? true : undefined,
        `the ${description} lifecycle acknowledged final capture for ${sessionId}`)
      await acceptanceWait(async () =>
        (await savedCurrent(sessionId))?.includes(marker) ? true : undefined,
        `the ${description} saved output carries ${marker}`)
      return { lifecycleCaptureAcknowledged: true }
    }

    const openRequestIds = async (): Promise<string[]> =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .filter((request) => request.state === 'open')
        .map((request) => request.requestId)
        .sort()

    /** A live session whose pane is mounted: its terminal is attached, so captures are real. */
    const liveMountedSession = async (label: string): Promise<string> => {
      const mounted = await applicationWindow!.webContents.executeJavaScript(
        `[...document.querySelectorAll('.session-terminal[data-session-id]')]
          .map((element) => element.dataset.sessionId)`
      ) as string[]
      for (const sessionId of mounted) {
        const row = await processRow(sessionId)
        if (row?.state === 'live') return sessionId
      }
      throw new Error(`no live mounted session for the ${label} trial`)
    }

    /** The production remember-a-choice path the close dialog's checkbox itself drives. */
    const rememberChoice = async (sessionId: string, choice: BackgroundChoice): Promise<void> => {
      const current = runtimes.get(sessionId)
      const record = sessionRecords.get(sessionId)
      if (!current || !record) throw new Error(`cannot remember a choice for a missing session: ${sessionId}`)
      const updated = await current.client.request<SessionRecord>(METHOD_REGISTRY.sessionUpdate, {
        sessionId,
        expectedRevision: record.revision,
        backgroundChoice: choice
      })
      sessionRecords.set(updated.sessionId, updated)
      current.backgroundChoice = choice
    }

    // The explicit ending runs first, on the untouched renderer; the close ending minimizes the
    // window as production does, so it runs last and the renderer is recovered after it.
    const closeStopId = await liveMountedSession('close-stop')
    const mounted = await applicationWindow!.webContents.executeJavaScript(
      `[...document.querySelectorAll('.session-terminal[data-session-id]')]
        .map((element) => element.dataset.sessionId)`
    ) as string[]
    let explicitId: string | undefined
    for (const sessionId of mounted) {
      if (sessionId === closeStopId || !sessionRecords.has(sessionId)) continue
      if ((await processRow(sessionId))?.state === 'live') { explicitId = sessionId; break }
    }
    if (!explicitId) throw new Error('no second live mounted session for the explicit-stop trial')
    const closeStopName = sessionRecords.get(closeStopId)?.name ?? ''
    // Ending: stop a session explicitly — an exit record, never an interruption.
    const explicitRuntime = runtimes.get(explicitId)
    if (!explicitRuntime) throw new Error('the explicit-stop runtime is missing')
    const explicitTarget = runningTargetForRuntime({
      ...explicitRuntime.session,
      executable: explicitRuntime.executable,
      processState: explicitRuntime.processState,
      ...(explicitRuntime.backgroundChoice
        ? { backgroundChoice: explicitRuntime.backgroundChoice }
        : {})
    })
    if (!explicitTarget) throw new Error('the explicit-stop session is not a running target')
    const explicitProof = await stopWithFinalCapture(explicitId, 'SURVIVAL-EXPLICIT-MARKER', () =>
      applicationLifecycle.stopCurrentTarget(explicitTarget), 'explicit')
    const explicitRow = await acceptanceWait(async () => {
      const row = await processRow(explicitId)
      return row?.state === 'exited' && (row.exitCode !== null || row.signal !== null) ? row : undefined
    }, 'the explicit stop recorded an exit')
    const explicitStop = {
      recordedState: explicitRow?.state ?? '',
      recordedExit: explicitRow?.exitCode ?? null,
      recordedSignal: explicitRow?.signal ?? null,
      neverInterrupted: explicitRow?.state === 'exited',
      finalCaptureTookTheMarker: (await savedCurrent(explicitId))?.includes('SURVIVAL-EXPLICIT-MARKER') === true,
      lifecycleCaptureAcknowledged: explicitProof.lifecycleCaptureAcknowledged
    }

    const answerTheClosePrompt = applicationWindow!.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const probe = () => {
          const dialog = document.querySelector('dialog.close-sessions[open]');
          if (!dialog) {
            if (Date.now() >= deadline) reject(new Error('the close prompt never appeared'));
            else setTimeout(probe, 25);
            return;
          }
          const rows = [...dialog.querySelectorAll('.close-sessions-list li')];
          for (const row of rows) {
            const wanted = row.querySelector('.name')?.textContent?.trim() === ${JSON.stringify(closeStopName)}
              ? 'Stop'
              : 'Keep running';
            const button = [...row.querySelectorAll('button')]
              .find((candidate) => candidate.textContent.trim() === wanted);
            if (button) button.click();
          }
          const proceed = [...dialog.querySelectorAll('.dialog-actions button')]
            .find((button) => button.textContent.trim() === 'Close BMN');
          if (!proceed) { reject(new Error('the close prompt has no Close BMN button')); return; }
          proceed.click();
          resolve(rows.length);
        };
        probe();
      })
    `) as Promise<number>
    let keptId: string | undefined
    for (const sessionId of runtimes.keys()) {
      if (sessionId === closeStopId) continue
      if ((await processRow(sessionId))?.state === 'live') { keptId = sessionId; break }
    }
    if (!keptId) throw new Error('no second live session for the kept-sibling check')
    await rememberChoice(closeStopId, 'stop')
    await rememberChoice(keptId, 'hide')
    const requestsBeforeClose = await openRequestIds()
    const closeCaptureStart = selfTestLifecycleCaptures.length
    const closeProof = await stopWithFinalCapture(closeStopId, 'SURVIVAL-CLOSE-STOP-MARKER', async () => {
      applicationLifecycle.closeLastWindow({ preventDefault(): void {} })
      await answerTheClosePrompt
    }, 'close-last-window')
    const closeStopRow = await acceptanceWait(async () => {
      const row = await processRow(closeStopId)
      return row?.state === 'interrupted' && row.detail?.startsWith('last window close') ? row : undefined
    }, 'the close-stop target recorded last window close')
    const requestsAfterClose = await openRequestIds()
    const closeWindowKeep = {
      processesLive: await acceptanceWait(async () =>
        (await processRow(keptId))?.state === 'live' ? true : undefined,
        'the kept sessions stayed live') === true,
      noInterruption: (await processRow(keptId))?.state === 'live',
      noLifecycleCapture: !selfTestLifecycleCaptures.slice(closeCaptureStart).some((entry) =>
        entry.sessionId === keptId
      ),
      requestsStayOpen: requestsBeforeClose.length === 0
        ? 'none-open'
        : (JSON.stringify(requestsBeforeClose) === JSON.stringify(requestsAfterClose)
          ? true
          : false)
    }
    const closeAndStop = {
      recordedInterrupted: closeStopRow?.state === 'interrupted',
      recordedDetail: closeStopRow?.detail ?? '',
      finalCaptureTookTheMarker: (await savedCurrent(closeStopId))?.includes('SURVIVAL-CLOSE-STOP-MARKER') === true,
      lifecycleCaptureAcknowledged: closeProof.lifecycleCaptureAcknowledged,
      keptSessionStillLive: (await processRow(keptId))?.state === 'live'
    }
    // The close lifecycle minimized the window, as production does; the remaining phases need a
    // live renderer again, so the harness recovers it the same way a crash does.
    await recoverApplicationRenderer(applicationWindow!)

    console.error(`[BMN] self-test phase: survival endings ${JSON.stringify({
      closeWindowKeep, closeAndStop: { ...closeAndStop, recordedDetail: '…' }, explicitStop
    })}`)

    /**
     * Epic 15.1: a program with no BMN hook reaches Needs you through the terminal's own
     * notification sequence, and a session whose harness already reports through `bmn hook` is
     * left to that hook. Two synthetic sessions, one of each kind.
     */
    console.error('[BMN] self-test phase: terminal notices')
    const noticeCwd = join(isolatedCwd, 'terminal-notice')
    mkdirSync(noticeCwd, { recursive: true })
    const plainHarness = writeTerminalNoticeHarness(join(noticeCwd, 'plain'), { hookFirst: false })
    const plainSession = await createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Terminal notice',
      cwd: noticeCwd,
      executable: plainHarness.executable,
      argv: [],
      cols: 80,
      rows: 24
    }, true)
    const hookedHarness = writeTerminalNoticeHarness(join(noticeCwd, 'hooked'), { hookFirst: true })
    const hookedSession = await createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Terminal notice with a hook',
      cwd: noticeCwd,
      executable: hookedHarness.executable,
      argv: [],
      cols: 80,
      rows: 24
    }, true)
    await recoverApplicationRenderer(applicationWindow)
    await untilFileExists(plainHarness.printed, 'printed its notification')
    await untilFileExists(hookedHarness.printed, 'printed its notification after its hook')
    const terminalNotice = await applicationWindow.webContents.executeJavaScript(`
      (async () => {
        const plainId = ${JSON.stringify(plainSession.session.sessionId)};
        const hookedId = ${JSON.stringify(hookedSession.session.sessionId)};
        const wait = async (read, what) => {
          const deadline = Date.now() + 10000;
          for (;;) {
            const value = await read();
            if (value !== undefined && value !== null) return value;
            if (Date.now() >= deadline) throw new Error('the terminal notice probe timed out waiting for ' + what);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        };
        const hook = window.__aitermTest;
        const rowsOf = async (sessionId) => (await window.aiTerminal.listAttention())
          .filter((request) => request.sessionId === sessionId && request.state === 'open');
        const opened = await wait(async () => (await rowsOf(plainId))[0], 'the terminal notice');
        // The hooked session's own hook opened a turn notice; the OSC one must add nothing to it.
        await wait(async () => (await rowsOf(hookedId)).length > 0 ? true : undefined, 'the hooked session row');
        const hookedEvents = await wait(async () => {
          const events = await window.aiTerminal.listHookEvents(hookedId);
          return events.some((event) => event.agent === 'terminal') ? events : undefined;
        }, 'the suppressed notification in the hook log');
        const pane = await wait(() => document.querySelector('.session-terminal[data-session-id="' + plainId + '"]'), 'the pane');
        // The words the owner reads: Needs you says where the row came from.
        const needsButton = await wait(() => document.querySelector('.needs-you-button'), 'the Needs you button');
        needsButton.click();
        const provenance = await wait(() => {
          const row = [...document.querySelectorAll('.attention-item')]
            .find((item) => item.querySelector('h3')?.textContent?.trim() === 'BMN self-test notice');
          return row?.querySelector('.provenance')?.textContent?.trim() || undefined;
        }, 'the provenance words');
        document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const before = hook.snapshot(plainId);
        const textarea = pane.querySelector('.xterm-helper-textarea');
        if (!textarea) throw new Error('the notice pane has no terminal input');
        const typeOneKey = () => textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'y', code: 'KeyY', keyCode: 89, which: 89, bubbles: true, cancelable: true
        }));
        typeOneKey();
        const resolved = await wait(async () => {
          const found = (await window.aiTerminal.listAttention())
            .find((request) => request.requestId === opened.requestId);
          if (found && found.state !== 'open') return found;
          typeOneKey();
          return undefined;
        }, 'the notice to be answered by typing');
        return {
          openedBy: opened.openedBy,
          title: opened.title,
          body: opened.body,
          kind: opened.kind,
          provenance,
          ptyInputEvents: before.inputEvents,
          hookedSessionRows: (await rowsOf(hookedId)).length,
          hookedSessionEvents: (await window.aiTerminal.listHookEvents(hookedId))
            .map((event) => ({ agent: event.agent, event: event.event, effects: event.effects })),
          resolvedState: resolved.state,
          resolvedBy: resolved.resolvedBy
        };
      })()
    `) as TerminalNoticeProbe
    // AC5 again, this time measured: a notice arriving into a live pane changes nothing about it.
    const beforeSecond = await applicationWindow.webContents.executeJavaScript(`
      (() => {
        const hook = window.__aitermTest;
        const snapshot = hook.snapshot(${JSON.stringify(plainSession.session.sessionId)});
        // Kept so the check after the notice is identity, not "some element is there".
        window.__bmnNoticeElement = document.querySelector('.session-terminal[data-session-id="${plainSession.session.sessionId}"] .xterm-screen');
        return { cols: snapshot.cols, rows: snapshot.rows, refits: snapshot.refits, inputEvents: snapshot.inputEvents };
      })()
    `) as { cols: number; rows: number; refits: number; inputEvents: number }
    writeFileSync(plainHarness.trigger, '')
    await untilFileExists(plainHarness.second, 'printed its second notification')
    terminalNotice.aroundSecondNotice = await applicationWindow.webContents.executeJavaScript(`
      (async () => {
        const plainId = ${JSON.stringify(plainSession.session.sessionId)};
        const before = ${JSON.stringify(beforeSecond)};
        const deadline = Date.now() + 10000;
        let row;
        for (;;) {
          row = (await window.aiTerminal.listAttention())
            .find((request) => request.sessionId === plainId && request.title === 'BMN self-test second notice');
          if (row) break;
          if (Date.now() >= deadline) throw new Error('the second terminal notice never opened');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // Give any refit or write a chance to land before reading the terminal again.
        await new Promise((resolve) => setTimeout(resolve, 250));
        const after = window.__aitermTest.snapshot(plainId);
        const element = document.querySelector('.session-terminal[data-session-id="' + plainId + '"] .xterm-screen');
        return {
          title: row.title,
          openedBy: row.openedBy,
          sameSize: after.cols === before.cols && after.rows === before.rows,
          sameElement: !!element && element.isConnected && element === window.__bmnNoticeElement,
          refits: after.refits - before.refits,
          inputEvents: after.inputEvents - before.inputEvents
        };
      })()
    `) as TerminalNoticeProbe['aroundSecondNotice']
    for (const runtime of [plainSession, hookedSession]) {
      await client.request(METHOD_REGISTRY.sessionStop, {
        sessionId: runtime.session.sessionId,
        incarnationId: runtime.session.lastProcess?.incarnationId,
        cause: 'explicit'
      })
    }
    console.error(`[BMN] self-test phase: terminal notices ${JSON.stringify(terminalNotice)}`)
    if (terminalNotice.kind !== 'notice' || terminalNotice.openedBy !== 'osc:9') {
      throw new Error(`the OSC 9 sequence did not open a notice from the terminal: ${JSON.stringify(terminalNotice)}`)
    }
    if (terminalNotice.title !== 'BMN self-test notice') {
      throw new Error(`the notice did not carry the program's own words: ${terminalNotice.title}`)
    }
    if (terminalNotice.provenance !== 'from the terminal (OSC 9)') {
      throw new Error(`Needs you did not say where the notice came from: ${terminalNotice.provenance}`)
    }
    // The sequence is consumed and answered by the window alone: the program hears nothing back.
    if (terminalNotice.ptyInputEvents !== 0) throw new Error('reading a terminal notification wrote to the PTY')
    const suppressed = terminalNotice.hookedSessionEvents.filter((event) => event.agent === 'terminal')
    if (suppressed.length !== 1 || suppressed[0]?.event !== 'osc:9' || suppressed[0]?.effects.length !== 0) {
      throw new Error(`the suppressed notification was not logged: ${JSON.stringify(terminalNotice.hookedSessionEvents)}`)
    }
    if (terminalNotice.hookedSessionRows !== 1) {
      throw new Error(`a hooked session got a second row from its terminal: ${terminalNotice.hookedSessionRows}`)
    }
    if (terminalNotice.resolvedState === 'open' || terminalNotice.resolvedBy !== 'input') {
      throw new Error(`typing did not resolve the terminal notice: ${JSON.stringify(terminalNotice)}`)
    }

    console.error('[BMN] self-test phase: launch sets and repository identity')
    const launchSetRepository = await runLaunchSetRepositorySelfTest(applicationWindow, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      workspaceName: restoredWorkspaces.find((item) => item.workspaceId === DEFAULT_WORKSPACE_ID)!.name,
      directory: isolatedCwd,
      existingSessionId: session.sessionId
    }, {
      pauseNextSetRead: pauseNextSelfTestLaunchSetRead,
      startRequestCount: () => selfTestLaunchSetStartRequests
    })
    if (!launchSetRepository.savedWithoutStart ||
        !launchSetRepository.cancelledPendingStart ||
        !launchSetRepository.equivalentDirectoryWarning ||
        !launchSetRepository.previewBranch.includes('Branch main') ||
        !launchSetRepository.changedBranchBlocked ||
        JSON.stringify(launchSetRepository.startedOrder) !== JSON.stringify(['First', 'Second', 'Third']) ||
        !launchSetRepository.selectionPreserved ||
        JSON.stringify(launchSetRepository.partialOutcomes) !== JSON.stringify(['started', 'failed', 'not-started']) ||
        launchSetRepository.retryAddedSessions !== 2 ||
        launchSetRepository.reconnectAddedSessions !== 0 ||
        !launchSetRepository.failedSessionLinked ||
        !launchSetRepository.preparationPreservedTerminals ||
        !launchSetRepository.keyboardFocusInDialog ||
        !launchSetRepository.editDeletePreservedSessions ||
        JSON.stringify(launchSetRepository.reorderedEntries) !== JSON.stringify(['First', 'Third', 'Second']) ||
        !launchSetRepository.ordinaryChangedBlocked ||
        !launchSetRepository.nonRepositoryStarted ||
        !launchSetRepository.detailRoots[0]?.includes(isolatedCwd) ||
        !launchSetRepository.detailRoots[1]?.includes(join(isolatedCwd, 'nested-launch-repo'))) {
      throw new Error(`launch set or repository acceptance failed: ${JSON.stringify(launchSetRepository)}`)
    }

    if (!progressEvidence) throw new Error('the results fixture has no evidence report')
    const evidenceArtifactId = progressEvidence.artifactId
    const evidenceOriginal = (await client.request<ArtifactRecord[]>(METHOD_REGISTRY.artifactList, {}))
      .find((row) => row.artifactId === evidenceArtifactId)
    const syntheticDataRoot = resolveApplicationRoots().data
    if (!evidenceOriginal?.storedPath.startsWith(`${syntheticDataRoot}/`)) {
      throw new Error('the results evidence original is outside the isolated data root')
    }
    unlinkSync(evidenceOriginal.storedPath)
    await expectRemoteFailure(
      client.request(METHOD_REGISTRY.artifactPreview, { artifactId: evidenceOriginal.artifactId }),
      ERROR_CODES.notFound, 'The stored original is missing'
    )
    const crossWorkspaceDraft = await client.request<InputDraftRecord>(METHOD_REGISTRY.draftSave, {
      sourceSessionId: petitionSource.session.sessionId,
      sessionId: routingSession.session.sessionId,
      text: 'Synthetic cross-workspace handoff',
      artifactIds: []
    })
    const sourceWorkspace = (await client.request<WorkspaceRecord[]>(METHOD_REGISTRY.workspaceList, {
      includeArchived: true
    })).find((row) => row.workspaceId === DEFAULT_WORKSPACE_ID)
    if (!sourceWorkspace) throw new Error('the source workspace is unavailable for results')
    await recoverApplicationRenderer(applicationWindow)
    const crossWorkspaceUi = await applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read, name) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('cross-workspace results timed out: ' + name); };
      const open = async (name) => {
        const section = await wait(() => [...document.querySelectorAll('.workspace-group')]
          .find(row => row.getAttribute('aria-label') === name), 'workspace ' + name);
        section.querySelector('.row-menu-button').click();
        (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
          .find(row => row.textContent.trim() === 'Review results…'), 'results action')).click();
        return wait(() => {
          const dialog = document.querySelector('dialog.workspace-results-dialog[open]');
          return dialog?.querySelector('.workspace-results-handoffs') ? dialog : null;
        }, 'results ' + name);
      };
      const sourceName = ${JSON.stringify(sourceWorkspace.name)};
      const destinationName = ${JSON.stringify(routingWorkspace.name)};
      const sourceDialog = await open(sourceName);
      const sourceReport = sourceDialog.textContent.includes('Self-test checks passed');
      const missingEvidence = sourceDialog.textContent.includes('checks.log · Original unavailable');
      const sourceRows = [...sourceDialog.querySelectorAll('.workspace-results-handoffs > li')]
        .filter(row => row.textContent.includes('Petition source') && row.textContent.includes('Child routing'));
      const sourceHandoffOnce = sourceRows.length === 1 &&
        sourceRows[0].textContent.includes(sourceName) && sourceRows[0].textContent.includes(destinationName);
      sourceDialog.querySelector('.app-dialog-heading button').click();
      const destinationDialog = await open(destinationName);
      const destinationNoReport = destinationDialog.textContent.includes('No progress reported') &&
        !destinationDialog.textContent.includes('Self-test checks passed');
      const destinationRows = [...destinationDialog.querySelectorAll('.workspace-results-handoffs > li')]
        .filter(row => row.textContent.includes('Petition source') && row.textContent.includes('Child routing'));
      const destinationHandoffOnce = destinationRows.length === 1 &&
        destinationRows[0].textContent.includes(sourceName) && destinationRows[0].textContent.includes(destinationName);
      destinationRows[0]?.querySelector('button')?.click();
      const form = await wait(() => document.querySelector('.handoff-form'), 'cross-workspace review');
      const routeExact = form.querySelector('textarea')?.value === 'Synthetic cross-workspace handoff' &&
        form.querySelector('select')?.value === ${JSON.stringify(routingSession.session.sessionId)};
      form.querySelector('button[type="button"]')?.click();
      document.querySelector('.files-close')?.click();
      return { sourceReport, missingEvidence, sourceHandoffOnce, destinationNoReport,
        destinationHandoffOnce, routeExact };
    })()`) as {
      sourceReport: boolean; missingEvidence: boolean; sourceHandoffOnce: boolean;
      destinationNoReport: boolean; destinationHandoffOnce: boolean; routeExact: boolean
    }
    const crossWorkspaceResults = {
      ...crossWorkspaceUi,
      noAutoDelivery: (await client.request<InputDraftRecord[]>(METHOD_REGISTRY.draftList, {}))
        .find((row) => row.draftId === crossWorkspaceDraft.draftId)?.state === 'draft'
    }
    if (Object.values(crossWorkspaceResults).some((value) => value !== true)) {
      throw new Error(`cross-workspace results failed: ${JSON.stringify(crossWorkspaceResults)}`)
    }

    // AC5: the frame's rows at font sizes 10, 14 and 24, and at 14 px with 150 % zoom, against
    // the 5 rows Codex reserves. Overflow is measured and reported, not hidden.
    // Its own shell: the panes used earlier may be stopped by now.
    const placementShell = await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Sixel placement', cwd: isolatedCwd, executable: '/bin/sh', argv: [], cols: 80, rows: 24 }, true)
    await recoverApplicationRenderer(applicationWindow)
    const placementId = JSON.stringify(placementShell.session.sessionId)
    const typeIntoPlacementPane = (text: string) => client.request(METHOD_REGISTRY.terminalWrite, {
      attachmentId: runtimes.get(placementShell.session.sessionId)!.attachment.attachmentId,
      bytes: new TextEncoder().encode(text)
    })
    const waitForPlacementLine = (marker: string) => applicationWindow!.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshots()[${placementId}]?.bufferLines.some((line) => line.includes(${JSON.stringify(marker)}))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(${JSON.stringify('the placement pane never printed ')} + ${JSON.stringify(marker)});
    })()`) as Promise<void>
    const appearanceBefore = await applicationWindow.webContents.executeJavaScript(
      'window.aiTerminal.getSettings().then((settings) => settings.appearance)') as { terminalFontSize: number }
    const placement = async (fontSize: number, zoom: number) => {
      await applicationWindow!.webContents.executeJavaScript(
        `window.aiTerminal.putSettings('appearance', ${JSON.stringify({ ...appearanceBefore, terminalFontSize: fontSize })})`)
      applicationWindow!.webContents.setZoomFactor(zoom)
      // The frame is drawn only once the view uses the new font size.
      await applicationWindow!.webContents.executeJavaScript(`(async () => {
        const end = Date.now() + 5000;
        while (Date.now() < end && window.__aitermTest.view(${placementId}).imageCells().fontSize !== ${fontSize}) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await typeIntoPlacementPane(`clear; cat '${sixelPtyPath}'; echo; printf 'PLACED-%s\\n' ${fontSize}-${zoom * 100}\r`)
      await waitForPlacementLine(`PLACED-${fontSize}-${zoom * 100}`)
      const cells = await applicationWindow!.webContents.executeJavaScript(`(async () => {
        const end = Date.now() + 3000;
        let cells = window.__aitermTest.view(${placementId}).imageCells();
        while (cells.lines.length === 0 && Date.now() < end) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          cells = window.__aitermTest.view(${placementId}).imageCells();
        }
        return { ...cells, storageMB: window.__aitermTest.snapshots()[${placementId}].imageStorageMB };
      })()`) as { lines: number[]; cssCellHeight: number; deviceCellHeight: number; devicePixelRatio: number;
        fontSize: number; storageMB: number }
      return { fontSize: cells.fontSize, fontApplied: cells.fontSize === fontSize, zoom, cssCellHeight: cells.cssCellHeight, devicePixelRatio: cells.devicePixelRatio,
        rows: cells.lines.length, withinReservedRows: cells.lines.length <= 5, storageMB: cells.storageMB }
    }
    const sixelPlacement = []
    for (const [fontSize, zoom] of [[10, 1], [14, 1], [24, 1], [14, 1.5]] as const) {
      sixelPlacement.push(await placement(fontSize, zoom))
    }
    applicationWindow.webContents.setZoomFactor(1)
    await applicationWindow.webContents.executeJavaScript(
      `window.aiTerminal.putSettings('appearance', ${JSON.stringify(appearanceBefore)})`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    if (sixelPlacement.some((row) => !row.fontApplied || row.rows === 0 || row.cssCellHeight <= 0)) {
      throw new Error(`Sixel placement could not be measured: ${JSON.stringify(sixelPlacement)}`)
    }

    // Resizing the window refits the panes; the placement pane's text and image stay usable.
    // (Run last: an earlier resize changes the layout later integration steps read.)
    const [windowWidth, windowHeight] = applicationWindow.getSize() as [number, number]
    applicationWindow.setSize(Math.max(800, windowWidth - 240), Math.max(600, windowHeight - 160))
    await new Promise((resolve) => setTimeout(resolve, 400))
    await typeIntoPlacementPane(`cat '${join(animationDirectory, 'frame1.six')}'; echo; printf '%sD\\n' RESIZE\r`)
    await waitForPlacementLine('RESIZED')
    applicationWindow.setSize(windowWidth, windowHeight)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const [restoredWidth, restoredHeight] = applicationWindow.getSize() as [number, number]
    if (restoredWidth !== windowWidth || restoredHeight !== windowHeight) {
      throw new Error(`the self-test window size was not restored: ${restoredWidth}x${restoredHeight}`)
    }
    const sixelResize = await applicationWindow.webContents.executeJavaScript(`(() => {
      const hook = window.__aitermTest;
      const own = hook.snapshot(${placementId}); return { storageMB: own.imageStorageMB, imageLines: hook.view(${placementId}).imageCells().lines.length, cols: own.cols, rows: own.rows, layer: own.imageLayerPresent };
    })()`) as { storageMB: number; imageLines: number; cols: number; rows: number; layer: boolean }
    if (!(sixelResize.storageMB > 0) || sixelResize.imageLines === 0) {
      throw new Error(`a resized pane lost its image: ${JSON.stringify(sixelResize)}`)
    }

    // AC1 cap pressure and AC4/AC7 cold views: nine programs fill image storage and a program
    // named codex draws its first frame, all before any view exists. After renderer recovery,
    // each new view receives that output in its first writes.
    const coldDirectory = join(isolatedCwd, 'sixel-cold-views')
    mkdirSync(join(coldDirectory, 'bin'), { recursive: true })
    const largeImage = `\u001bP9;1;0q"1;1;256;256#1;2;0;0;100#1${Array(43).fill('!256~').join('-')}\u001b\\`
    writeFileSync(join(coldDirectory, 'large.six'), largeImage)
    writeFileSync(join(coldDirectory, 'frame.six'), codexFrame(2))
    const capProgram = join(coldDirectory, 'fill-images')
    writeFileSync(capProgram, [
      '#!/bin/sh',
      'i=0; while [ "$i" -lt 40 ]; do cat "$(dirname "$0")/large.six"; i=$((i + 1)); done',
      "printf 'CAP-AFTER\\r\\n'",
      'sleep 60'
    ].join('\n') + '\n', { mode: 0o700 })
    const coldCodex = join(coldDirectory, 'bin', 'codex')
    writeFileSync(coldCodex, [
      '#!/bin/sh',
      `date +%s%3N > '${join(coldDirectory, 'started').replaceAll("'", "'\\''")}'`,
      `cat '${join(coldDirectory, 'frame.six').replaceAll("'", "'\\''")}'`,
      "printf 'COLD-AFTER TERM=%s\\r\\n' \"$TERM\"",
      'sleep 60'
    ].join('\n') + '\n', { mode: 0o700 })
    const capSessions = []
    for (let index = 0; index < 9; index += 1) {
      capSessions.push((await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
        name: `Sixel cap ${index + 1}`, cwd: isolatedCwd, executable: capProgram, argv: [], cols: 80, rows: 24 }, true)).session.sessionId)
    }
    const coldRequestedAt = Date.now()
    const coldSession = (await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Sixel cold codex', cwd: isolatedCwd, executable: coldCodex, argv: [], cols: 80, rows: 24,
      terminalGraphics: null }, true)).session.sessionId
    const coldStartedAt = await acceptanceWait(async () => existsSync(join(coldDirectory, 'started'))
      ? Number(readFileSync(join(coldDirectory, 'started'), 'utf8').trim()) : undefined, 'cold codex start')
    await recoverApplicationRenderer(applicationWindow)
    const coldViews = await applicationWindow.webContents.executeJavaScript(`(async () => {
      const capIds = ${JSON.stringify(capSessions)};
      const coldId = ${JSON.stringify(coldSession)};
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        const snapshots = window.__aitermTest?.snapshots() ?? {};
        const shown = (id, marker) => snapshots[id]?.bufferLines.some((line) => line.includes(marker));
        if (capIds.every((id) => shown(id, 'CAP-AFTER')) && shown(coldId, 'COLD-AFTER')) {
          // Let a decoder that was still being created finish, so a dropped frame shows as zero storage.
          await new Promise((resolve) => setTimeout(resolve, 500));
          const latest = window.__aitermTest.snapshots();
          const views = Object.keys(latest).length;
          const storage = Object.values(latest).map((row) => row.imageStorageMB);
          return {
            views,
            viewLimitMB: Math.min(16, 128 / views),
            capStorageMB: capIds.map((id) => latest[id].imageStorageMB),
            totalStorageMB: storage.reduce((sum, value) => sum + value, 0),
            coldStorageMB: latest[coldId].imageStorageMB,
            coldTerm: (latest[coldId].bufferLines.find((line) => line.includes('COLD-AFTER')) ?? '').split('TERM=')[1]?.trim()
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the cap-pressure and cold views did not show their text after images');
    })()`) as { views: number; viewLimitMB: number; capStorageMB: number[]; totalStorageMB: number;
      coldStorageMB: number; coldTerm: string }
    const sixelCapPressure = {
      views: coldViews.views,
      viewLimitMB: coldViews.viewLimitMB,
      largestViewMB: Math.max(...coldViews.capStorageMB),
      totalStorageMB: coldViews.totalStorageMB,
      textAfterImages: true,
      withinLimits: coldViews.capStorageMB.every((value) => value > 0 && value <= coldViews.viewLimitMB + 0.01) &&
        coldViews.totalStorageMB <= 128
    }
    const sixelColdView = {
      firstFrameDecoded: coldViews.coldStorageMB > 0,
      storageMB: coldViews.coldStorageMB,
      term: coldViews.coldTerm,
      startMs: coldStartedAt - coldRequestedAt
    }
    if (!sixelCapPressure.withinLimits || coldViews.views <= 8) {
      throw new Error(`image storage exceeded its caps: ${JSON.stringify(sixelCapPressure)}`)
    }
    if (!sixelColdView.firstFrameDecoded || sixelColdView.term !== 'xterm-sixel-256color' || sixelColdView.startMs > 2000) {
      throw new Error(`a view-less codex start or its first frame failed: ${JSON.stringify(sixelColdView)}`)
    }

    // 28.2 AC3: ordinary shells under each terminal entry, clean (/etc/skel/.bashrc) and with the
    // owner's own ~/.bashrc: colors, dircolors, prompt color and title, the addon's device
    // attributes reply, bracketed paste at the prompt, and a full-screen mouse TUI (less).
    const regressionDirectory = join(isolatedCwd, 'shell-regression')
    mkdirSync(regressionDirectory, { recursive: true })
    const regressionChecks = join(regressionDirectory, 'checks.sh')
    writeFileSync(regressionChecks, [
      "old=$(stty -g); stty raw -echo min 0 time 10; printf '\\033[c'; reply=$(dd bs=64 count=1 2>/dev/null); stty \"$old\"",
      "da1=$(printf '%s' \"$reply\" | od -An -c | tr -d ' \\n')",
      'lscolors=$(eval "$(dircolors -b)"; [ -n "$LS_COLORS" ] && echo yes || echo no)',
      "case \"$PS1\" in *'[01;32m'*) prompt=color;; *) prompt=plain;; esac",
      "case \"$PS1\" in *']0;'*) title=yes;; *) title=no;; esac",
      "printf 'REGRESSION term=%s colors=%s lscolors=%s\\n' \"$TERM\" \"$(tput colors)\" \"$lscolors\"",
      "printf 'REGRESSION2 prompt=%s title=%s da1=%s\\n' \"$prompt\" \"$title\" \"$da1\""
    ].join('\n') + '\n')
    const regressionShells = [
      { label: 'clean-sixel', graphics: 'sixel' as const, argv: ['--rcfile', '/etc/skel/.bashrc', '-i'] },
      { label: 'clean-standard', graphics: 'standard' as const, argv: ['--rcfile', '/etc/skel/.bashrc', '-i'] },
      { label: 'owner-sixel', graphics: 'sixel' as const, argv: ['-i'] }
    ]
    const regressionIds: Record<string, string> = {}
    for (const shell of regressionShells) {
      regressionIds[shell.label] = (await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
        name: `Shell regression ${shell.label}`, cwd: isolatedCwd, executable: '/bin/bash', argv: shell.argv,
        cols: 100, rows: 30, terminalGraphics: shell.graphics }, true)).session.sessionId
    }
    await recoverApplicationRenderer(applicationWindow)
    const shellRegression: Record<string, Record<string, unknown>> = {}
    for (const shell of regressionShells) {
      const id = JSON.stringify(regressionIds[shell.label])
      const type = (text: string) => client.request(METHOD_REGISTRY.terminalWrite, {
        attachmentId: runtimes.get(regressionIds[shell.label]!)!.attachment.attachmentId,
        bytes: new TextEncoder().encode(text)
      })
      const read = (marker: string) => applicationWindow!.webContents.executeJavaScript(`(async () => {
        const end = Date.now() + 15000;
        while (Date.now() < end) {
          const snapshot = window.__aitermTest?.snapshots()[${id}];
          const line = snapshot?.bufferLines.find((row) => row.includes(${JSON.stringify(marker)}));
          if (line) return { line, modes: snapshot.modes };
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(${JSON.stringify(`the ${shell.label} shell never printed `)} + ${JSON.stringify(marker)});
      })()`) as Promise<{ line: string; modes: { bracketedPasteMode: boolean; mouseTrackingMode: string } }>
      await type(`. '${regressionChecks}'\r`)
      const result = await read('REGRESSION term=')
      const result2 = await read('REGRESSION2 prompt=')
      // Readline turns bracketed paste on at the prompt; the view's modes show what the program asked for.
      await type(`printf '%s-%s\\n' PROMPT READY\r`)
      const prompt = await read('PROMPT-READY')
      await new Promise((resolve) => setTimeout(resolve, 300))
      const atPrompt = await applicationWindow.webContents.executeJavaScript(
        `window.__aitermTest.snapshots()[${id}].modes`) as { bracketedPasteMode: boolean }
      await type(`less --mouse '${regressionChecks}'\r`)
      await new Promise((resolve) => setTimeout(resolve, 800))
      const inLess = await applicationWindow.webContents.executeJavaScript(
        `window.__aitermTest.snapshots()[${id}].modes`) as { mouseTrackingMode: string }
      await type('q')
      await type(`printf '%s-%s\\n' LESS DONE\r`)
      await read('LESS-DONE')
      const fields = Object.fromEntries(`${result.line.replace(/^.*REGRESSION /, '')} ${result2.line.replace(/^.*REGRESSION2 /, '')}`
        .trim().split(' ').map((pair) => pair.split('=') as [string, string]))
      shellRegression[shell.label] = { ...fields, bracketedPaste: atPrompt.bracketedPasteMode,
        lessMouse: inLess.mouseTrackingMode, lessQuit: true, promptSeen: prompt.line.includes('PROMPT-READY') }
    }
    const expectedTerms: Record<string, string> = { 'clean-sixel': 'xterm-sixel-256color',
      'clean-standard': 'xterm-256color', 'owner-sixel': 'xterm-sixel-256color' }
    for (const [label, row] of Object.entries(shellRegression)) {
      if (row.term !== expectedTerms[label] || row.colors !== '256' || row.lscolors !== 'yes' || row.prompt !== 'color' ||
        row.title !== 'yes' || row.da1 !== '033[?62;4;9;22c' || row.bracketedPaste !== true || row.lessMouse === 'none') {
        throw new Error(`an ordinary shell regressed under its terminal entry: ${JSON.stringify(shellRegression)}`)
      }
    }

    // A pane's view is replaced while its program is inside a Sixel image, after ESC and a line
    // feed that xterm executes without leaving the sequence. The new view must read the next
    // DCS as a DCS, not print its payload, and still show later text and a fresh image.
    const viewSwapDirectory = join(isolatedCwd, 'sixel-view-swap')
    mkdirSync(viewSwapDirectory, { recursive: true })
    writeFileSync(join(viewSwapDirectory, 'part1.bin'),
      `\u001bP9;1;0q"1;1;60;75#1;2;0;100;0${'#1'.repeat(40_000)}\u001b\n`)
    writeFileSync(join(viewSwapDirectory, 'part2.bin'),
      `PqLEAK${'~'.repeat(200)}\u001b\\VISIBLE-AFTER\r\n` +
      `\u001bP9;1;0q"1;1;60;75#1;2;100;0;0#1${Array(13).fill('!60~').join('-')}\u001b\\\r\n`)
    const viewSwapScript = join(viewSwapDirectory, 'program')
    writeFileSync(viewSwapScript, [
      '#!/bin/sh',
      `cd '${viewSwapDirectory.replaceAll("'", "'\\''")}'`,
      "printf 'VIEW-SWAP-START\\n'",
      'cat part1.bin',
      // The rest waits until the replacement view is live.
      'while [ ! -e go ]; do sleep 0.05; done',
      'cat part2.bin',
      'sleep 30'
    ].join('\n') + '\n', { mode: 0o700 })
    const viewSwap = await createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Sixel view swap', cwd: isolatedCwd, executable: viewSwapScript,
      argv: [], cols: 80, rows: 24 }, true)
    const viewSwapId = JSON.stringify(viewSwap.session.sessionId)
    await recoverApplicationRenderer(applicationWindow)
    await applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshots()[${viewSwapId}]?.bufferLines.some((line) => line.includes('VIEW-SWAP-START'))) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the first view of the Sixel view swap pane did not show its start');
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    await recoverApplicationRenderer(applicationWindow)
    await applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshots()[${viewSwapId}]) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the replacement view of the Sixel view swap pane did not mount');
    })()`)
    writeFileSync(join(viewSwapDirectory, 'go'), '')
    const sixelViewSwap = await applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        const snapshots = window.__aitermTest?.snapshots() ?? {};
        const own = snapshots[${viewSwapId}];
        // The pane may be off screen, so decoded image storage, not a drawn layer, shows the image.
        if (own?.bufferLines.some((line) => line.includes('VISIBLE-AFTER')) && own.imageStorageMB > 0) {
          return {
            visibleAfter: true,
            leakedText: own.bufferLines.some((line) => line.includes('LEAK') || line.includes('#1#1')),
            storageMB: own.imageStorageMB,
            layer: own.imageLayerPresent,
            otherPanesLeak: Object.entries(snapshots).some(([id, row]) =>
              id !== ${viewSwapId} && row.bufferLines.some((line) => line.includes('LEAK')))
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const own = window.__aitermTest?.snapshots()[${viewSwapId}];
      throw new Error('the replacement view did not show text after the image: ' + JSON.stringify({
        text: own?.bufferLines.filter((line) => line.trim()).slice(-8),
        storageMB: own?.imageStorageMB, layer: own?.imageLayerPresent }));
    })()`) as { visibleAfter: boolean; leakedText: boolean; storageMB: number; layer: boolean;
      otherPanesLeak: boolean }
    if (!sixelViewSwap.visibleAfter || sixelViewSwap.leakedText || !(sixelViewSwap.storageMB > 0) ||
      sixelViewSwap.otherPanesLeak) {
      throw new Error(`a replacement view misread output after an interrupted image: ${JSON.stringify(sixelViewSwap)}`)
    }

    const graphicsRoot = process.env.BMN_DATA_HOME
    if (!graphicsRoot) throw new Error('self-test graphics entry requires BMN_DATA_HOME')
    const terminfoDirectory = join(graphicsRoot, 'terminfo')
    const terminfoEntry = join(terminfoDirectory, 'x', 'xterm-sixel-256color')
    const sixelResolved = existsSync(terminfoEntry) && spawnSync('infocmp',
      ['-A', terminfoDirectory, 'xterm-sixel-256color'], { stdio: 'ignore' }).status === 0
    const standardResolved = spawnSync('infocmp', ['xterm-256color'], {
      stdio: 'ignore', env: { ...process.env, TERMINFO_DIRS: `${terminfoDirectory}:` }
    }).status === 0
    const fakeCodex = join(isolatedCwd, 'graphics-probe', 'codex')
    mkdirSync(join(isolatedCwd, 'graphics-probe'), { recursive: true })
    writeFileSync(fakeCodex, '#!/bin/sh\nprintf "%s\\n" "$TERM" > "$1"\nsleep 2\n', { mode: 0o700 })
    const probeTerm = async (file: string): Promise<string> => {
      await client.request(METHOD_REGISTRY.sessionCreate, {
        workspaceId: DEFAULT_WORKSPACE_ID, name: 'Synthetic graphics TERM probe',
        cwd: isolatedCwd, executable: fakeCodex, argv: [file], cols: 80, rows: 24,
        terminalGraphics: null
      })
      return acceptanceWait(async () => existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined,
        'synthetic Codex TERM receipt')
    }
    const initialTerm = await probeTerm(join(isolatedCwd, 'graphics-before.txt'))
    writeFileSync(terminfoEntry, 'corrupt test entry')
    const fallbackTerm = await probeTerm(join(isolatedCwd, 'graphics-after.txt'))
    const graphicsTerminfo = { sixelResolved, standardResolved, initialTerm, fallbackTerm }
    if (!sixelResolved || !standardResolved || initialTerm !== 'xterm-sixel-256color' ||
      fallbackTerm !== 'xterm-256color') {
      throw new Error(`isolated terminfo fallback failed: ${JSON.stringify(graphicsTerminfo)}`)
    }

    const secondClose = await client.close()
    console.error('[BMN] self-test phase: second host closed')
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
      resumeConfirmationShownToOwner,
      rendererLaunchUnavailable: preloadProbe.launchUnavailable,
      rendererUnavailableTemplate: preloadProbe.unavailableTemplate,
      rendererStoppedPanelLabel,
      stoppedStaleProgress,
      rendererInverseTextContrast,
      rendererLiveExitLabel,
      rendererLiveExitSidebarWord,
      closePrompt,
      rendererRecoveredAfterShellExit,
      registeredInvokeChannels: selfTestBridgeInvokeRegistrations.map(({ channel }) => channel),
      envelopedInvokeChannels,
      templateCreatedSession: preloadProbe.templateCreatedSession,
      treeSelectionLayoutPut: preloadProbe.treeSelection,
      crossWorkspaceSplit: preloadProbe.crossWorkspaceSplit,
      workspaceMarkers: preloadProbe.workspaceMarkers,
      progressEvidence: { ...progressEvidence, persistedAfterRestart: true },
      progressEvidenceSurface: preloadProbe.progressEvidenceSurface,
      workspaceResults: workspaceResultsAcceptance,
      crossWorkspaceResults,
      hiddenPaneSize: preloadProbe.hiddenPaneSize,
      handoffFlow: { ...preloadProbe.handoffFlow, persistedAfterRestart: true },
      agentHandoff,
      fileReferenceWire,
      sixelRender,
      sixelPty,
      sixelAnimation,
      sixelTwoPaneAnimation,
      sixelAlternateScreen,
      sixelPlacement,
      sixelResize,
      sixelCapPressure,
      sixelColdView,
      shellRegression,
      sixelViewSwap,
      cspProbe,
      graphicsTerminfo,
      openCodeAcceptance,
      cursorAcceptance,
      subagentAcceptance,
      repeatAcceptance,
      resetModes,
      quietSidebarAcceptance,
      interruptedSidebarAcceptance,
      voiceFlow: {
        ...preloadProbe.voiceFlow,
        transcriptions: selfTestVoiceTranscriptions,
        persistedAfterRestart: voicePersistedAfterRestart
      },
      fileReferenceFlow: {
        ...preloadProbe.fileReferenceFlow,
        shownPaths: [...selfTestShownFileReferences],
        reads: [...selfTestReadFileReferences]
      },
      attentionTriage: preloadProbe.attentionTriage,
      inactiveFollowingOutputLayoutPuts,
      inactiveFollowingOutputCaptured,
      launchBackgroundChoiceRecorded,
      sessionProcessStatus: { beforeRestart: 'live', afterApplicationRestart: 'interrupted' },
      applicationQuitStoppedSession: {
        beforeRestart: lifecycleStoppedBeforeRestart,
        afterRestart: lifecycleStoppedAfterRestart
      },
      conversationFromHook,
      sessionActivity,
      requestProvenance,
      hookIntegration: hookIntegrationAcceptance,
      harnessObservations: { opencode: openCodeObservationUi, codex: codexObservationUi },
      terminalNotice,
      launchSetRepository,
      modelOrigin: { flags: modelOriginFlags, afterRestart: modelOriginAfterRestart },
      remoteAnswers,
      telegramCards,
      fullerAnswers: fuller,
      telegramCue,
      survivalTable: {
        rendererCrash: survivingRendererCrash,
        quit: {
          recorded: lifecycleStoppedBeforeRestart.detail,
          afterApplicationRestart: lifecycleStoppedAfterRestart?.detail ?? null,
          openRequestsAfter: openRequestsAfterApplicationRestart,
        },
        closeWindowKeep,
        closeAndStop,
        explicitStop,
        // Rows no automated check exercises; docs/architecture.md marks them UNVERIFIED.
        documented: ['app-crash-or-reboot', 'desktop-update']
      },
      // Epic 17.1: what the offer said after an update stop, what the button started, and that it asked once.
      resumeOffer: {
        heading: offerAfterUpdate.heading,
        summary: offerAfterUpdate.summary,
        button: offerAfterUpdate.button,
        startsUnchecked: offerAfterUpdate.rows.every((row) => !row.checked),
        dismissedStartedNothing: true,
        reopenedFromPalette: reopenedOffer.rows.length,
        outcomes: offerResult.rows.map((row) => row.outcome),
        argv: restartedArgv.map((runs) => runs[1] ?? null),
        askedAgain: !(offerStayedAwayAfterRendererRestart && offerStayedAwayAfterSecondStart)
      },
      // Epic 17.2: the modes the rebuilt view came back with, and what the program was sent through them.
      terminalModes,
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
    console.error('[BMN] self-test phase: releasing self-test resources')
    historyFixture?.holder.kill()
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
const rendererTestMode = process.argv.includes('--bmn-test-mode')
if (selfTest) {
  // The dictation flow records from Chromium's fake microphone, so the real recorder path runs without hardware.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}
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
    if (selfTest) selfTestLifecycleCaptures.push({ sessionId: runtime.session.sessionId, status: outcome.status })
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

if (primaryInstance) installIpcHandlers()
if (primaryInstance) autoUpdater.on('update-downloaded', () => applicationLifecycle.updateDownloaded())

if (primaryInstance) void app.whenReady().then(async () => {
  // The Chancel header replaces Electron's default File/Edit/View/Window bar and its stray
  // accelerators (reload, zoom, close); Quit lives in the command palette.
  Menu.setApplicationMenu(null)
  restrictWebPermissions()
  if (selfTest) {
    let exitCode = 0
    try {
      await runSelfTest()
    } catch (error) {
      reportSelfTestFailure(error)
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
