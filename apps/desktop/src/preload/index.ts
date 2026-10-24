// MODULE: index.ts - preload that exposes the typed bmn bridge over context isolation
import {
  MAX_TERMINAL_CHUNK_BYTES,
  CONSUMER_OUTPUT_QUEUE_BYTES,
  METHOD_REGISTRY,
  isTerminalOutputMessage,
  isTerminalExitMessage,
  isTerminalViewDisconnectedMessage,
  isAppEventMessage,
  isClosePromptRequest,
  type AppEventMessage,
  type ProgramCopyNotice,
  type AgentHistoryStatus,
  type AgentsApprovalRequest,
  type AgentsOutcome,
  type OpenCodeGoView,
  type AgentsPreview,
  type AgentsShownRevision,
  type AgentsSnapshot,
  type AgentsTeamUpdateShown,
  type RosterDataShape,
  type RosterHarness,
  type ContextLimitApp,
  type ContextLimitPlan,
  type ResearchLookup,
  type JudgeTried,
  type JudgeView,
  type WebQuestionAsked,
  type WebQuestionsSnapshot,
  type TeamAskDetail,
  type TeamAsksSnapshot,
  type ResearchSnapshot,
  type ToolProposalView,
  type ToolsPlan,
  type RulesOutcome,
  type RulesMasterPlan,
  type RulesPlan,
  type RulesSavePlan,
  type RulesRevertPlan,
  type RulesSnapshot,
  type AppSettings,
  type ArtifactPreview,
  type ArtifactRecord,
  type AttentionOrigin,
  type AttentionRecord,
  type AutoTestsView,
  type HookEventRecord,
  type HookEventsView,
  type HookObservation,
  type HookOriginRecord,
  type SessionPorts,
  type SessionUsage,
  type UsageReading,
  type GuardStop,
  type TurnDetailAnswer,
  type TurnDifferenceAnswer,
  type TurnSessionView,
  type TurnSummary,
  type BackupExportResult,
  type ControlInfo,
  type OwnerAwayView,
  type OwnerGrantView,
  type GrantChoice,
  type GrantRefusalReason,
  type AwaySummaryPayload,
  type PushPolicyChange,
  type PushPolicyView,
  type DraftSendExpectation,
  type FileReferenceReadParams,
  type QuickLookListParams,
  type QuickLookListResult,
  type QuickLookReadParams,
  type QuickLookIdentityParams,
  type QuickLookIdentityResult,
  type QuickLookSearchParams,
  type QuickLookSearchResult,
  type QuickLookReadResult,
  type QuickLookSaveParams,
  type QuickLookSaveResult,
  type QuickLookRootResult,
  type QuickLookSource,
  type FileReferenceReadResult,
  type FileReferencePasteParams,
  type FileReferencePasteReceipt,
  type FileReferenceSearchParams,
  type FileReferenceSearchResult,
  type ClosePromptDecision,
  type ClosePromptRequest,
  type InputDraftRecord,
  type SessionMessageListing,
  type InterruptedSessionCohort,
  type ProgressRecord,
  type RepositoryIdentity,
  type DevAutoRunsResult,
  type SessionCohortOfferedResult,
  type TelegramStatus,
  type VoiceLanguage,
  type VoiceModelId,
  type VoiceStatus,
  type ConversationBindingState,
  type SessionResumePreview,
  type ExplicitConversationBinding,
  type LayoutGetResult,
  type SavedOutputCapture,
  type SavedOutputCatalog,
  type SavedOutputSnapshot,
  type SessionCreateParams,
  type SessionRecord,
  type SessionUpdateParams,
  type TerminalActivationResult,
  type TerminalExitMessage,
  type TerminalOutputMessage,
  type TerminalViewDisconnectedMessage,
  type TerminalNoticeCode,
  type TerminalViewDisconnectReason,
  type WorkspaceCreateParams,
  type WorkspaceLayoutState,
  type WorkspaceRecord,
  type WorkspaceUpdateParams
} from '@bmn/protocol'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { recoverAfterTransportFailure } from './overflow-detach'
import { failureDetail, unwrapBridgeInvoke } from './bridge-invoke'
import { withLiveSession } from './live-session-registry'

interface StartupSuccess {
  ok: true
  sessionId: string
  incarnationId: string
  attachmentId: string
  streamSeq: 0
  captureStartedAt: string
  /** Private terminal modes a view created after the program started must be brought to. */
  modes: number[]
  cwd: string
  executable: string
  workspaceId: string
  name: string
  testMode: boolean
  viewRestored?: true
  setup?: import('@bmn/protocol').SetupSessionPurpose
}

interface StartupFailure {
  ok: false
  message: string
  code: string
}

interface RendererCohortResumeRequest {
  cohortId: string
  idempotencyKey: string
  entries: Array<{ sessionId: string; action: 'resume' | 'relaunch'; command: string }>
}

interface RendererCohortResumeResult {
  cohortId: string
  entries: Array<{
    sessionId: string
    outcome: 'started' | 'failed' | 'not-started'
    error?: string
    startup?: StartupSuccess
  }>
}

interface ApplicationStartupSuccess {
  ok: true
  testMode: boolean
  activeWorkspaceId: string | null
  workspaces: WorkspaceRecord[]
  sessions: SessionRecord[]
  layouts: WorkspaceLayoutState[]
  layoutNotices: string[]
  liveSessions: StartupSuccess[]
  setup?: import('@bmn/protocol').FirstRunSetupRecord
}

type StartupResult = ApplicationStartupSuccess | StartupFailure
type StartupListener = (startup: StartupResult) => void
type OutputListener = (message: TerminalOutputMessage) => void
type ExitListener = (message: TerminalExitMessage) => void
type ViewDisconnectedListener = (message: TerminalViewDisconnectedMessage) => void
type CaptureRequestListener = (sessionId: string) => Promise<void>

interface RendererMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: unknown): void
  start(): void
  close(): void
}

/** Every `aiterm:*` invoke goes through this one envelope unwrap (typed BridgeError on failure). */
function invokeBridge<Result>(channel: `aiterm:${string}`, ...args: unknown[]): Promise<Result> {
  return unwrapBridgeInvoke<Result>(() => ipcRenderer.invoke(channel, ...args))
}

function listHookEvents(sessionId: string): Promise<HookEventRecord[]>
function listHookEvents(sessionId: string, includeHistory: true): Promise<HookEventsView>
function listHookEvents(sessionId: string, includeHistory?: true): Promise<HookEventRecord[] | HookEventsView> {
  return invokeBridge('aiterm:hook-events:list', { sessionId, ...(includeHistory ? { includeHistory } : {}) })
}

let terminalPort: RendererMessagePort | undefined
let latestStartup: StartupResult | undefined
const startupListeners = new Set<StartupListener>()
const outputListeners = new Set<OutputListener>()
const exitListeners = new Set<ExitListener>()
const viewDisconnectedListeners = new Set<ViewDisconnectedListener>()
const captureRequestListeners = new Set<CaptureRequestListener>()
let latestExit: TerminalExitMessage | undefined
const pendingOutput = new Map<string, TerminalOutputMessage[]>()
const pendingOutputBytes = new Map<string, number>()
const pendingSequence = new Map<string, number>()
const attachmentSessions = new Map<string, string>()

/** Registers a session that became live after startup so late subscribers and transport recovery see it. */
function recordLiveSession(live: StartupSuccess, session?: SessionRecord): void {
  latestStartup = withLiveSession(latestStartup, live, session)
  attachmentSessions.set(live.attachmentId, live.sessionId)
  pendingSequence.set(live.attachmentId, 0)
}

function reportTransportFailure(
  reason: TerminalViewDisconnectReason,
  attachmentId?: string
): void {
  terminalPort?.close()
  terminalPort = undefined
  pendingOutput.clear()
  pendingOutputBytes.clear()
  pendingSequence.clear()
  const failure: StartupFailure = {
    ok: false,
    code: 'IO_ERROR',
    message: reason === 'output-overflow'
      ? `Terminal output exceeded the ${CONSUMER_OUTPUT_QUEUE_BYTES / (1024 * 1024)} MiB view queue. Recovering a fresh terminal view; the shell process was not stopped.`
      : reason === 'acknowledgement-timeout'
        ? 'Terminal output acknowledgements stalled. Recovering a fresh terminal view; the shell process was not stopped.'
        : 'Terminal output sequence was invalid. Recovering a fresh terminal view; the shell process was not stopped.'
  }
  latestStartup = failure
  for (const listener of startupListeners) listener(failure)
  const sessionId = attachmentId ? attachmentSessions.get(attachmentId) : undefined
  if (sessionId) {
    void recoverAfterTransportFailure(() =>
      invokeBridge('aiterm:terminal:recover-view', sessionId, reason)
    )
  }
}

function connectTerminalPort(port: RendererMessagePort): void {
  terminalPort = port
  port.onmessage = (event) => {
    if (isTerminalExitMessage(event.data)) {
      latestExit = event.data
      for (const listener of exitListeners) listener(event.data)
      return
    }
    if (isTerminalViewDisconnectedMessage(event.data)) {
      if (viewDisconnectedListeners.size === 0) {
        reportTransportFailure(event.data.reason, event.data.attachmentId)
        return
      }
      for (const listener of viewDisconnectedListeners) listener(event.data)
      return
    }
    if (!isTerminalOutputMessage(event.data)) return
    if (outputListeners.size === 0) {
      const attachmentId = event.data.attachmentId
      if (event.data.streamSeq !== (pendingSequence.get(attachmentId) ?? 0)) {
        reportTransportFailure('sequence-gap', attachmentId)
        return
      }
      pendingSequence.set(attachmentId, event.data.streamSeq + 1)
      const bytes = (pendingOutputBytes.get(attachmentId) ?? 0) + event.data.bytes.byteLength
      pendingOutputBytes.set(attachmentId, bytes)
      if (bytes > CONSUMER_OUTPUT_QUEUE_BYTES) {
        reportTransportFailure('output-overflow', attachmentId)
      } else {
        pendingOutput.set(attachmentId, [...pendingOutput.get(attachmentId) ?? [], event.data])
      }
    }
    else for (const listener of outputListeners) listener(event.data)
  }
  port.start()
}

ipcRenderer.on('aiterm:startup', (event, startup: StartupResult) => {
  latestStartup = startup
  if (startup.ok) {
    for (const live of startup.liveSessions) {
      attachmentSessions.set(live.attachmentId, live.sessionId)
      pendingSequence.set(live.attachmentId, 0)
    }
  }
  const port = event.ports[0] as unknown as RendererMessagePort | undefined
  if (terminalPort && terminalPort !== port) terminalPort.close()
  terminalPort = undefined
  if (port) connectTerminalPort(port)
  for (const listener of startupListeners) listener(startup)
})

ipcRenderer.on('aiterm:terminal:capture-request', (_event, requestId: unknown, sessionId: unknown) => {
  if (typeof requestId !== 'string' || typeof sessionId !== 'string') return
  if (captureRequestListeners.size === 0) {
    ipcRenderer.send('aiterm:terminal:capture-result', requestId, {
      ok: false,
      message: 'renderer capture handler is unavailable'
    })
    return
  }
  void Promise.all([...captureRequestListeners].map((listener) => listener(sessionId)))
    .then(() => ipcRenderer.send('aiterm:terminal:capture-result', requestId, { ok: true }))
    .catch((error: unknown) => {
      const message = failureDetail(error, 'unknown renderer capture failure')
      ipcRenderer.send('aiterm:terminal:capture-result', requestId, {
        ok: false,
        message: message.slice(0, 240)
      })
    })
})

const appEventListeners = new Set<(message: AppEventMessage) => void>()
const openSessionListeners = new Set<(sessionId: string) => void>()

ipcRenderer.on('aiterm:app-event', (_event, message: unknown) => {
  if (!isAppEventMessage(message)) return
  for (const listener of appEventListeners) listener(message)
})

ipcRenderer.on('aiterm:open-session', (_event, sessionId: unknown) => {
  if (typeof sessionId !== 'string') return
  for (const listener of openSessionListeners) listener(sessionId)
})

const closePromptListeners = new Set<(request: ClosePromptRequest) => void>()

ipcRenderer.on('aiterm:lifecycle:close-prompt', (_event, request: unknown) => {
  if (!isClosePromptRequest(request)) return
  for (const listener of closePromptListeners) listener(request)
})

const programCopyListeners = new Set<(notice: ProgramCopyNotice) => void>()

ipcRenderer.on('aiterm:program-copy', (_event, message: unknown) => {
  const notice = message as Partial<ProgramCopyNotice> | null
  if (!notice || typeof notice.sessionId !== 'string' || !Number.isInteger(notice.characters)) return
  for (const listener of programCopyListeners) listener({ sessionId: notice.sessionId, characters: notice.characters! })
})

const presenceListeners = new Set<(presence: { away: boolean }) => void>()
let presence = { away: false }

ipcRenderer.on('aiterm:presence', (_event, message: unknown) => {
  if (!message || typeof message !== 'object' || typeof (message as { away?: unknown }).away !== 'boolean') return
  presence = { away: (message as { away: boolean }).away }
  for (const listener of presenceListeners) listener(presence)
})

contextBridge.exposeInMainWorld('aiTerminal', {
  security: {
    sandboxed: process.sandboxed === true,
    contextIsolated: process.contextIsolated === true
  },
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  onStartup(listener: StartupListener): () => void {
    startupListeners.add(listener)
    if (latestStartup) queueMicrotask(() => listener(latestStartup!))
    return () => startupListeners.delete(listener)
  },
  onTerminalOutput(listener: OutputListener): () => void {
    outputListeners.add(listener)
    queueMicrotask(() => {
      if (!outputListeners.has(listener)) return
      for (const messages of pendingOutput.values()) {
        for (const message of messages) listener(message)
      }
      pendingOutput.clear()
      pendingOutputBytes.clear()
    })
    return () => outputListeners.delete(listener)
  },
  onTerminalExit(listener: ExitListener): () => void {
    exitListeners.add(listener)
    if (latestExit) queueMicrotask(() => listener(latestExit!))
    return () => exitListeners.delete(listener)
  },
  onTerminalViewDisconnected(listener: ViewDisconnectedListener): () => void {
    viewDisconnectedListeners.add(listener)
    return () => viewDisconnectedListeners.delete(listener)
  },
  onSavedOutputCaptureRequest(listener: CaptureRequestListener): () => void {
    captureRequestListeners.add(listener)
    return () => captureRequestListeners.delete(listener)
  },
  sendTerminalInput(attachmentId: string, bytes: Uint8Array): void {
    if (!terminalPort) throw new Error('The terminal byte channel is unavailable')
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_TERMINAL_CHUNK_BYTES) {
      terminalPort.postMessage({
        kind: 'terminal-input',
        method: METHOD_REGISTRY.terminalWrite,
        attachmentId,
        bytes: bytes.slice(offset, offset + MAX_TERMINAL_CHUNK_BYTES)
      })
    }
  },
  acknowledgeTerminalOutput(attachmentId: string, streamSeq: number): void {
    terminalPort?.postMessage({ kind: 'terminal-ack', attachmentId, streamSeq })
  },
  activateTerminal(sessionId: string): Promise<TerminalActivationResult> {
    return invokeBridge('aiterm:terminal:activate', sessionId)
  },
  resizeTerminal(sessionId: string, cols: number, rows: number): Promise<{ cols: number; rows: number }> {
    return invokeBridge('aiterm:terminal:resize', sessionId, cols, rows)
  },
  detachTerminal(sessionId: string): Promise<{ detached: true }> {
    return invokeBridge('aiterm:terminal:detach', sessionId)
  },
  recoverTerminalView(sessionId: string, reason: TerminalViewDisconnectReason): Promise<{ recovering: true }> {
    terminalPort?.close()
    terminalPort = undefined
    return invokeBridge('aiterm:terminal:recover-view', sessionId, reason)
  },
  saveTerminalSnapshot(sessionId: string, capture: SavedOutputCapture): Promise<SavedOutputSnapshot> {
    return invokeBridge('aiterm:terminal:snapshot-save', sessionId, capture)
  },
  resetTerminalModes(sessionId: string): Promise<{ outcome: 'reset' | 'busy' | 'unconfirmed'; modes: number[] }> {
    return invokeBridge('aiterm:terminal:modes-reset', sessionId)
  },
  getSavedOutput(sessionId: string): Promise<SavedOutputCatalog> {
    return invokeBridge('aiterm:terminal:saved-output-get', sessionId)
  },
  stopSession(sessionId: string): Promise<{ stopped: true }> {
    return invokeBridge('aiterm:session:stop', sessionId)
  },
  getConversationBinding(sessionId: string): Promise<ConversationBindingState> {
    return invokeBridge('aiterm:session:binding-get', sessionId)
  },
  /** What Resume would run for this session. Read-only: no process is started. */
  previewConversationResume(sessionId: string): Promise<SessionResumePreview> {
    return invokeBridge('aiterm:session:resume-preview', sessionId)
  },
  locateConversation(binding: ExplicitConversationBinding): Promise<ExplicitConversationBinding> {
    return invokeBridge('aiterm:session:binding-replace', binding.sessionId, binding)
  },
  startNewConversation(sessionId: string): Promise<{ cleared: boolean }> {
    return invokeBridge('aiterm:session:binding-clear', sessionId)
  },
  async resumeConversation(sessionId: string, expectedCommand?: string): Promise<StartupSuccess> {
    // Only a reported command's Resume carries the command the owner read (Story 43.2).
    const startup = expectedCommand === undefined
      ? await invokeBridge<StartupSuccess>('aiterm:session:resume', sessionId)
      : await invokeBridge<StartupSuccess>('aiterm:session:resume', sessionId, expectedCommand)
    latestExit = undefined
    recordLiveSession(startup)
    return startup
  },
  async relaunchSession(sessionId: string): Promise<StartupSuccess> {
    const startup = await invokeBridge<StartupSuccess>('aiterm:session:relaunch', sessionId)
    latestExit = undefined
    recordLiveSession(startup)
    return startup
  },
  /** What the newest update or quit interrupted. Reads records only; nothing starts here. */
  listInterruptedCohort(): Promise<InterruptedSessionCohort | null> {
    return invokeBridge('aiterm:session:cohort-list')
  },
  markCohortOffered(cohortId: string): Promise<SessionCohortOfferedResult> {
    return invokeBridge('aiterm:session:cohort-offered', cohortId)
  },
  async resumeCohort(request: RendererCohortResumeRequest): Promise<RendererCohortResumeResult> {
    const result = await invokeBridge<RendererCohortResumeResult>('aiterm:session:cohort-resume', request)
    for (const entry of result.entries) {
      if (entry.startup) {
        latestExit = undefined
        recordLiveSession(entry.startup)
      }
    }
    return result
  },
  listWorkspaces(includeArchived = false): Promise<WorkspaceRecord[]> {
    return invokeBridge('aiterm:workspace:list', { includeArchived })
  },
  getSetupProgress(): Promise<import('@bmn/protocol').FirstRunSetupRecord | null> {
    return invokeBridge('aiterm:setup:get')
  },
  getSetupApps(): Promise<import('@bmn/protocol').SetupAppsSnapshot> {
    return invokeBridge('aiterm:setup:apps')
  },
  getSetupDefaults(): Promise<import('@bmn/protocol').SetupDefaultsReport | null> {
    return invokeBridge('aiterm:setup:defaults')
  },
  async startSetupSession(app: import('@bmn/protocol').SetupApp, action: import('@bmn/protocol').SetupSessionPurpose['action'], expectedProgram: string | null): Promise<{ session: SessionRecord; startup: StartupSuccess }> {
    const created = await invokeBridge<{ session: SessionRecord; startup: StartupSuccess }>('aiterm:setup:start', { app, action, expectedProgram })
    recordLiveSession(created.startup, created.session)
    return created
  },
  confirmSetupSignIn(app: import('@bmn/protocol').SetupApp, sessionId: string, version: string): Promise<import('@bmn/protocol').SetupAppsSnapshot> {
    return invokeBridge('aiterm:setup:confirm', { app, sessionId, version })
  },
  updateSetupProgress(params: import('@bmn/protocol').FirstRunSetupUpdate): Promise<import('@bmn/protocol').FirstRunSetupRecord> {
    return invokeBridge('aiterm:setup:update', params)
  },
  createWorkspace(params: WorkspaceCreateParams): Promise<WorkspaceRecord> {
    return invokeBridge('aiterm:workspace:create', params)
  },
  updateWorkspace(params: WorkspaceUpdateParams): Promise<WorkspaceRecord> {
    return invokeBridge('aiterm:workspace:update', params)
  },
  listSessions(workspaceId: string): Promise<SessionRecord[]> {
    return invokeBridge('aiterm:session:list', { workspaceId })
  },
  async createSession(params: SessionCreateParams): Promise<{ session: SessionRecord; startup: StartupSuccess }> {
    const created = await invokeBridge<{ session: SessionRecord; startup: StartupSuccess }>(
      'aiterm:session:create',
      params
    )
    recordLiveSession(created.startup, created.session)
    return created
  },
  updateSession(params: SessionUpdateParams): Promise<SessionRecord> {
    return invokeBridge('aiterm:session:update', params)
  },
  inspectRepository(directory: string): Promise<RepositoryIdentity> {
    return invokeBridge('aiterm:repository:inspect', { directory })
  },
  readDevAutoRuns(workspaceId?: string): Promise<DevAutoRunsResult> {
    return invokeBridge('aiterm:dev-auto:runs', workspaceId ? { workspaceId } : {})
  },
  getLayout(workspaceId: string): Promise<LayoutGetResult> {
    return invokeBridge('aiterm:layout:get', { workspaceId })
  },
  putLayout(params: {
    workspaceId: string
    expectedRevision: number
    state: WorkspaceLayoutState
  }): Promise<WorkspaceLayoutState> {
    return invokeBridge('aiterm:layout:put', params)
  },
  quitApplication(): Promise<void> {
    return invokeBridge('aiterm:app:quit')
  },
  onAppEvent(listener: (message: AppEventMessage) => void): () => void {
    appEventListeners.add(listener)
    return () => appEventListeners.delete(listener)
  },
  onOpenSession(listener: (sessionId: string) => void): () => void {
    openSessionListeners.add(listener)
    return () => openSessionListeners.delete(listener)
  },
  onProgramCopy(listener: (notice: ProgramCopyNotice) => void): () => void {
    programCopyListeners.add(listener)
    return () => programCopyListeners.delete(listener)
  },
  onClosePrompt(listener: (request: ClosePromptRequest) => void): () => void {
    closePromptListeners.add(listener)
    return () => closePromptListeners.delete(listener)
  },
  /** The owner's answer to one close or quit question; the main process holds the window open for it. */
  answerClosePrompt(requestId: string, decision: ClosePromptDecision): void {
    ipcRenderer.send('aiterm:lifecycle:close-decision', requestId, decision)
  },
  /** Whether Quick look holds unsaved edits, so the window's close and Quit ask first; never what they are. */
  reportQuickLookUnsaved(unsaved: boolean): void {
    ipcRenderer.send('aiterm:lifecycle:unsaved-edits', unsaved)
  },
  onPresence(listener: (presence: { away: boolean }) => void): () => void {
    presenceListeners.add(listener)
    listener(presence)
    return () => presenceListeners.delete(listener)
  },
  reportSelectedSession(sessionId: string | null): void {
    ipcRenderer.send('aiterm:selected-session', sessionId)
  },
  listArtifacts(sessionId: string | null = null): Promise<ArtifactRecord[]> {
    return invokeBridge('aiterm:artifact:list', { sessionId })
  },
  attachFiles(sessionId: string): Promise<ArtifactRecord[]> {
    return invokeBridge('aiterm:artifact:import-pick', { sessionId })
  },
  attachDroppedFiles(sessionId: string, files: File[]): Promise<ArtifactRecord[]> {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter((path) => path.length > 0)
    return invokeBridge('aiterm:artifact:import-paths', { sessionId, paths })
  },
  pasteImage(sessionId: string): Promise<ArtifactRecord | null> {
    return invokeBridge('aiterm:artifact:paste-image', { sessionId })
  },
  previewArtifact(artifactId: string): Promise<ArtifactPreview> {
    return invokeBridge('aiterm:artifact:preview', { artifactId })
  },
  deliverArtifact(artifactId: string, sessionId: string, expectedIncarnationId?: string): Promise<{ delivered: true; path: string; pastedAt: string }> {
    return invokeBridge('aiterm:artifact:deliver', { artifactId, sessionId, expectedIncarnationId })
  },
  saveArtifactAs(artifactId: string): Promise<{ saved: string | null }> {
    return invokeBridge('aiterm:artifact:save-as', { artifactId })
  },
  openArtifact(artifactId: string): Promise<{ opened: true }> {
    return invokeBridge('aiterm:artifact:open', { artifactId })
  },
  showArtifact(artifactId: string): Promise<{ shown: true }> {
    return invokeBridge('aiterm:artifact:show', { artifactId })
  },
  readFileReference(params: FileReferenceReadParams): Promise<FileReferenceReadResult> {
    return invokeBridge('aiterm:file-reference:read', params)
  },
  pasteFileReference(params: FileReferencePasteParams): Promise<FileReferencePasteReceipt> {
    return invokeBridge('aiterm:file-reference:paste', params)
  },
  searchFileReferences(params: FileReferenceSearchParams): Promise<FileReferenceSearchResult> {
    return invokeBridge('aiterm:file-reference:search', params)
  },
  async cancelFileReferenceSearch(ownerId: string, requestId: string): Promise<void> {
    await invokeBridge('aiterm:file-reference:search-cancel', { ownerId, requestId })
  },
  chooseFileReferenceBase(): Promise<string | null> {
    return invokeBridge('aiterm:file-reference:choose-base', {})
  },
  showFileReference(path: string): Promise<{ shown: true }> {
    return invokeBridge('aiterm:file-reference:show', { path })
  },
  quickLookRoot(source: QuickLookSource): Promise<QuickLookRootResult> {
    return invokeBridge('aiterm:quick-look:root', source)
  },
  listQuickLookFolder(params: QuickLookListParams): Promise<QuickLookListResult> {
    return invokeBridge('aiterm:quick-look:list', params)
  },
  readQuickLookFile(params: QuickLookReadParams): Promise<QuickLookReadResult> {
    return invokeBridge('aiterm:quick-look:read', params)
  },
  quickLookIdentity(params: QuickLookIdentityParams): Promise<QuickLookIdentityResult> {
    return invokeBridge('aiterm:quick-look:identity', params)
  },
  quickLookSearch(params: QuickLookSearchParams): Promise<QuickLookSearchResult> {
    return invokeBridge('aiterm:quick-look:search', params)
  },
  cancelQuickLookSearch(requestId: string): Promise<{ cancelled: true }> {
    return invokeBridge('aiterm:quick-look:search-cancel', { requestId })
  },
  saveQuickLookFile(params: QuickLookSaveParams): Promise<QuickLookSaveResult> {
    return invokeBridge('aiterm:quick-look:save', params)
  },
  listAttention(): Promise<AttentionRecord[]> {
    return invokeBridge('aiterm:attention:list', {})
  },
  markAttentionSeen(requestId: string): Promise<AttentionRecord> {
    return invokeBridge('aiterm:attention:seen', { requestId })
  },
  resolveAttention(
    requestId: string,
    resolution?: string,
    expected?: Pick<AttentionRecord, 'kind' | 'revision'>,
    origin?: AttentionOrigin,
    state?: 'answered' | 'withdrawn'
  ): Promise<AttentionRecord> {
    return invokeBridge('aiterm:attention:resolve', {
      requestId,
      ...(resolution ? { resolution } : {}),
      ...(expected ? { expectedKind: expected.kind, expectedRevision: expected.revision } : {}),
      ...(origin ? { origin } : {}),
      ...(state ? { state } : {})
    })
  },
  listHookEvents,
  getHookObservation(sessionId: string, incarnationId?: string): Promise<HookObservation> {
    return invokeBridge('aiterm:hook-observation:get', {
      sessionId,
      ...(incarnationId === undefined ? {} : { incarnationId })
    })
  },
  listHookOrigins(): Promise<HookOriginRecord[]> {
    return invokeBridge('aiterm:hook-origins:list', {})
  },
  getUsage(sessionId: string): Promise<SessionUsage> {
    return invokeBridge('aiterm:usage:get', { sessionId })
  },
  listUsage(): Promise<UsageReading[]> {
    return invokeBridge('aiterm:usage:list', {})
  },
  listGuardStops(): Promise<GuardStop[]> {
    return invokeBridge('aiterm:guard:list', {})
  },
  keepGuardStop(sessionId: string): Promise<{ kept: boolean }> {
    return invokeBridge('aiterm:guard:keep', { sessionId })
  },
  clearGuardStop(sessionId: string): Promise<{ cleared: boolean }> {
    return invokeBridge('aiterm:guard:clear', { sessionId })
  },
  allowGuardStop(stop: GuardStop): Promise<AgentsOutcome> {
    const { agent, pid, start, folder, processFolder, workspace, providerId, host, conversation } = stop
    return invokeBridge('aiterm:agents:guard-allow', { stop: { agent, pid, start, folder, processFolder, workspace, providerId, host, conversation } })
  },
  listPorts(): Promise<SessionPorts[]> {
    return invokeBridge('aiterm:ports:list', {})
  },
  openPort(sessionId: string, port: number): Promise<{ url: string }> {
    return invokeBridge('aiterm:ports:open', { sessionId, port })
  },
  reportTerminalNotice(params: {
    sessionId: string
    incarnationId: string
    code: TerminalNoticeCode
    title: string
    body?: string
  }): Promise<{ opened: boolean; requestKey: string; reason?: string }> {
    return invokeBridge('aiterm:attention:terminal-notice', params)
  },
  listProgress(): Promise<ProgressRecord[]> {
    return invokeBridge('aiterm:progress:list', {})
  },
  listDrafts(): Promise<InputDraftRecord[]> {
    return invokeBridge('aiterm:draft:list', {})
  },
  retryDraft(draftId: string): Promise<InputDraftRecord> {
    return invokeBridge('aiterm:draft:retry', { draftId })
  },
  sendDraft(draftId: string, submit: boolean, expected?: DraftSendExpectation): Promise<InputDraftRecord> {
    return invokeBridge('aiterm:draft:send', { draftId, submit, ...expected })
  },
  discardDraft(draftId: string): Promise<InputDraftRecord> {
    return invokeBridge('aiterm:draft:discard', { draftId })
  },
  listSessionMessages(workspaceId: string): Promise<SessionMessageListing> {
    return invokeBridge('aiterm:messages:list', { workspaceId })
  },
  listTurnRecording(): Promise<TurnSessionView[]> {
    return invokeBridge('aiterm:turn-changes:state', {})
  },
  listTurns(sessionId: string): Promise<TurnSummary[]> {
    return invokeBridge('aiterm:turn-changes:list', { sessionId })
  },
  readTurn(sessionId: string, turnId: string, from = 0): Promise<TurnDetailAnswer> {
    return invokeBridge('aiterm:turn-changes:turn', { sessionId, turnId, from })
  },
  readTurnDifference(sessionId: string, turnId: string, path: string): Promise<TurnDifferenceAnswer> {
    return invokeBridge('aiterm:turn-changes:difference', { sessionId, turnId, path })
  },
  getSettings(): Promise<AppSettings> {
    return invokeBridge('aiterm:settings:get', {})
  },
  putSettings<Section extends keyof AppSettings>(section: Section, value: AppSettings[Section]): Promise<AppSettings> {
    return invokeBridge('aiterm:settings:put', { section, value })
  },
  getHistoryStatus(): Promise<AgentHistoryStatus> {
    return invokeBridge('aiterm:history:status', {})
  },
  confirmHistory(): Promise<AgentHistoryStatus> {
    return invokeBridge('aiterm:history:confirm', {})
  },
  configureTelegram(token: string | null): Promise<TelegramStatus> {
    return invokeBridge('aiterm:telegram:configure', { token })
  },
  getTelegramStatus(): Promise<TelegramStatus> {
    return invokeBridge('aiterm:telegram:status', {})
  },
  testTelegram(): Promise<TelegramStatus> {
    return invokeBridge('aiterm:telegram:test', {})
  },
  testHealthAlerts(): Promise<TelegramStatus> {
    return invokeBridge('aiterm:telegram:health-test', {})
  },
  getControlInfo(): Promise<ControlInfo> {
    return invokeBridge('aiterm:control:info', {})
  },
  /** Story 76.3: the owner's said away state, as his own surfaces see it. */
  getAway(): Promise<OwnerAwayView> {
    return invokeBridge('aiterm:away:get', {})
  },
  /** Away (with an optional note, which replaces the period's) or back, said in the app. */
  setAway(to: 'away' | 'back', note?: string | null): Promise<OwnerAwayView> {
    return invokeBridge('aiterm:away:set', note === undefined ? { to } : { to, note })
  },
  markAwaySummaryShown(periodId: string): Promise<OwnerAwayView> {
    return invokeBridge('aiterm:away:summary-shown', { periodId })
  },
  /** Story 76.6: the current away period's summary sources, closed or still running. */
  awaySummary(): Promise<AwaySummaryPayload> {
    return invokeBridge('aiterm:away:summary', {})
  },
  /** Story 83.3: the push policy as Health shows it, and the owner's one change at a time against the revision he saw. */
  getPushPolicy(): Promise<PushPolicyView> {
    return invokeBridge('aiterm:policy:get', {})
  },
  setPushPolicy(change: PushPolicyChange): Promise<PushPolicyView> {
    return invokeBridge('aiterm:policy:set', change)
  },
  /** Story 84.3: the departure's cards as the owner sees them, and his answer to one card. */
  getGrant(): Promise<OwnerGrantView> {
    return invokeBridge('aiterm:grant:get', {})
  },
  answerGrant(answer: { periodId: string; runId: string; cardRevision: number; choices: Record<string, GrantChoice>; operationKey: string }): Promise<{
    outcome: 'granted' | 'repeated' | 'refused'; reason?: GrantRefusalReason; detail?: string; view: OwnerGrantView
  }> {
    return invokeBridge('aiterm:grant:answer', answer)
  },
  exportBackup(): Promise<BackupExportResult | null> {
    return invokeBridge('aiterm:backup:export', {})
  },
  agentsSnapshot(): Promise<AgentsSnapshot> {
    return invokeBridge('aiterm:agents:snapshot', {})
  },
  previewAgents(request: AgentsApprovalRequest): Promise<AgentsPreview> {
    return invokeBridge('aiterm:agents:preview', { request })
  },
  approveAgents(shown: AgentsShownRevision, scope?: string[], teamUpdate?: AgentsTeamUpdateShown): Promise<AgentsOutcome> {
    return invokeBridge('aiterm:agents:approve', { shown, ...(scope === undefined ? {} : { scope }), ...(teamUpdate === undefined ? {} : { teamUpdate }) })
  },
  saveAgents(shown: AgentsShownRevision, data: RosterDataShape, teamUpdate?: AgentsTeamUpdateShown): Promise<AgentsOutcome> {
    return invokeBridge('aiterm:agents:save', { shown, data, ...(teamUpdate === undefined ? {} : { teamUpdate }) })
  },
  revertAgents(shown: AgentsShownRevision, scope: string[] | null): Promise<AgentsOutcome> {
    return invokeBridge('aiterm:agents:revert', { shown, scope })
  },
  restoreAgents(shown: AgentsShownRevision, number: number, teamUpdate?: AgentsTeamUpdateShown): Promise<AgentsOutcome> {
    return invokeBridge('aiterm:agents:restore', { shown, number, ...(teamUpdate === undefined ? {} : { teamUpdate }) })
  },
  agentsGeneration(number: number): Promise<{ generation: number; createdAt: string; data: RosterDataShape } | null> {
    return invokeBridge('aiterm:agents:generation', { number })
  },
  startTeam(): Promise<AgentsOutcome> {
    return invokeBridge('aiterm:agents:start', {})
  },
  openTeamFile(): Promise<{ ok: boolean; path: string; message?: string }> {
    return invokeBridge('aiterm:agents:open-file', {})
  },
  saveAgentNotes(shown: AgentsShownRevision, agent: string, text: string): Promise<AgentsOutcome> {
    return invokeBridge('aiterm:agents:notes', { shown, agent, text })
  },
  openCodeGo(copy?: boolean): Promise<OpenCodeGoView> {
    return invokeBridge('aiterm:agents:opencode-go', copy === true ? { copy: true } : {})
  },
  rulesSnapshot(freshDoctorLocations = false): Promise<RulesSnapshot> {
    return invokeBridge('aiterm:rules:snapshot', { freshDoctorLocations })
  },
  planRulesMaster(text: string): Promise<RulesMasterPlan> {
    return invokeBridge('aiterm:rules:plan-master', { text })
  },
  planRulesSave(text: string): Promise<RulesSavePlan> {
    return invokeBridge('aiterm:rules:plan-save', { text })
  },
  saveRules(text: string, expectedHash: string | null, expectedLink: string | null, expectedDirectory: string | null, planHash: string): Promise<RulesOutcome> {
    return invokeBridge('aiterm:rules:save', { text, expectedHash, expectedLink, expectedDirectory, planHash })
  },
  planRulesRestore(transaction: string): Promise<RulesPlan> {
    return invokeBridge('aiterm:rules:plan-restore', { transaction })
  },
  restoreRules(transaction: string, planHash: string): Promise<RulesOutcome> {
    return invokeBridge('aiterm:rules:restore', { transaction, planHash })
  },
  planRulesRevertMaster(revision: number): Promise<RulesRevertPlan> {
    return invokeBridge('aiterm:rules:plan-revert-master', { revision })
  },
  probeRules(harness: RosterHarness): Promise<RulesOutcome> {
    return invokeBridge('aiterm:rules:probe', { harness })
  },
  planContextLimit(harness: ContextLimitApp, limit: number | null, compact: number | null): Promise<ContextLimitPlan> {
    return invokeBridge('aiterm:rules:context-plan', { harness, limit, compact })
  },
  applyContextLimit(harness: ContextLimitApp, limit: number | null, compact: number | null, planHash: string): Promise<RulesOutcome> {
    return invokeBridge('aiterm:rules:context-apply', { harness, limit, compact, planHash })
  },
  testContextLimit(harness: ContextLimitApp): Promise<RulesOutcome> {
    return invokeBridge('aiterm:rules:context-test', { harness })
  },
  /** BMN's own tests (Story 75.8): `fresh` makes it look now, without it the call waits for the tests under way. Resolves when none is. */
  autoTests(fresh: boolean): Promise<AutoTestsView> {
    return invokeBridge('aiterm:rules:auto-tests', { fresh })
  },
  testSkills(harness: RosterHarness): Promise<RulesOutcome> {
    return invokeBridge('aiterm:rules:skills-test', { harness })
  },
  testSkillsLoading(harness: RosterHarness): Promise<RulesOutcome> {
    return invokeBridge('aiterm:rules:skills-loading-test', { harness })
  },
  planToolsInstall(removeUnlisted = false): Promise<ToolsPlan> {
    return invokeBridge('aiterm:rules:tools-plan', { removeUnlisted })
  },
  installTools(planHash: string, removeUnlisted = false): Promise<RulesOutcome> {
    return invokeBridge('aiterm:rules:tools-install', { planHash, removeUnlisted })
  },
  testTools(harness: RosterHarness): Promise<RulesOutcome> {
    return invokeBridge('aiterm:rules:tools-test', { harness })
  },
  proposeTools(): Promise<{ ok: boolean; message?: string; proposals: ToolProposalView[] }> {
    return invokeBridge('aiterm:rules:tools-proposals', {})
  },
  researchSnapshot(fresh: boolean): Promise<ResearchSnapshot> {
    return invokeBridge('aiterm:research:load', { fresh })
  },
  chooseResearcher(researcher: string): Promise<ResearchSnapshot> {
    return invokeBridge('aiterm:research:choose', { researcher })
  },
  startResearch(researcher: string): Promise<ResearchSnapshot> {
    return invokeBridge('aiterm:research:start', { researcher })
  },
  stopResearch(): Promise<ResearchSnapshot> {
    return invokeBridge('aiterm:research:stop', {})
  },
  testCodexFence(harness?: 'codex' | 'opencode'): Promise<ResearchSnapshot> {
    return invokeBridge('aiterm:research:fence-test', harness === undefined ? {} : { harness })
  },
  lookUpModel(researcher: string, provider: string, model: string): Promise<ResearchLookup> {
    return invokeBridge('aiterm:research:lookup', { researcher, provider, model })
  },
  webQuestions(): Promise<WebQuestionsSnapshot> {
    return invokeBridge('aiterm:questions:load', {})
  },
  teamAsks(): Promise<TeamAsksSnapshot> {
    return invokeBridge('aiterm:asks:load', {})
  },
  teamAskDetail(id: string): Promise<TeamAskDetail> {
    return invokeBridge('aiterm:asks:detail', { id })
  },
  stopTeamAsk(id: string): Promise<TeamAsksSnapshot> {
    return invokeBridge('aiterm:asks:stop', { id })
  },
  removeTeamAsks(id: string | null): Promise<TeamAsksSnapshot> {
    return invokeBridge('aiterm:asks:remove', { id })
  },
  exportTeamAsk(id: string): Promise<{ output: string | null; files: number }> {
    return invokeBridge('aiterm:asks:export', { id })
  },
  askWebQuestion(question: string): Promise<WebQuestionAsked> {
    return invokeBridge('aiterm:questions:ask', { question })
  },
  stopWebQuestion(): Promise<WebQuestionsSnapshot> {
    return invokeBridge('aiterm:questions:stop', {})
  },
  setAgentsMayAsk(on: boolean): Promise<WebQuestionsSnapshot> {
    return invokeBridge('aiterm:questions:allow', { on })
  },
  removeWebQuestions(id: string | null): Promise<WebQuestionsSnapshot> {
    return invokeBridge('aiterm:questions:remove', { id })
  },
  openWebQuestionPage(id: string, claim: number): Promise<{ opened: boolean }> {
    return invokeBridge('aiterm:questions:open-page', { id, claim })
  },
  judgeCalls(): Promise<JudgeView> {
    return invokeBridge('aiterm:judge:load', {})
  },
  setJudgeLimit(limit: { on: boolean; usd: number }): Promise<JudgeView> {
    return invokeBridge('aiterm:judge:limit', limit)
  },
  tryJudge(text: string, statement: string, data: 'public' | 'private'): Promise<JudgeTried> {
    return invokeBridge('aiterm:judge:try', { text, statement, data })
  },
  readClipboardText(): Promise<{ text: string }> {
    return invokeBridge('aiterm:clipboard:read-text', {})
  },
  writeClipboardText(text: string): Promise<{ written: true }> {
    return invokeBridge('aiterm:clipboard:write-text', { text })
  },
  getVoiceStatus(): Promise<VoiceStatus> {
    return invokeBridge('aiterm:voice:status', {})
  },
  downloadVoiceModel(model: VoiceModelId): Promise<{ started: boolean }> {
    return invokeBridge('aiterm:voice:download', { model })
  },
  cancelVoiceModelDownload(model: VoiceModelId): Promise<{ cancelled: boolean }> {
    return invokeBridge('aiterm:voice:cancel-download', { model })
  },
  chooseVoiceModelFolder(): Promise<{ path: string } | null> {
    return invokeBridge('aiterm:voice:choose-folder', {})
  },
  transcribeVoice(request: {
    wav: Uint8Array
    model: VoiceModelId
    language: VoiceLanguage
    vocabulary: string[]
  }): Promise<{ text: string }> {
    return invokeBridge('aiterm:voice:transcribe', {
      wav: request.wav,
      model: request.model,
      language: request.language,
      vocabulary: request.vocabulary
    })
  }
})
