import {
  MAX_TERMINAL_CHUNK_BYTES,
  CONSUMER_OUTPUT_QUEUE_BYTES,
  METHOD_REGISTRY,
  isTerminalOutputMessage,
  isTerminalExitMessage,
  isTerminalViewDisconnectedMessage,
  isAppEventMessage,
  type AppEventMessage,
  type AppSettings,
  type ArtifactPreview,
  type ArtifactRecord,
  type AttentionOrigin,
  type AttentionRecord,
  type HookEventRecord,
  type BackupManifest,
  type BackupVerifyResult,
  type ControlInfo,
  type DraftSendExpectation,
  type FileReferenceReadParams,
  type FileReferenceReadResult,
  type HandoffDraftSaveParams,
  type InputDraftRecord,
  type ProgressRecord,
  type TelegramStatus,
  type VoiceLanguage,
  type VoiceModelId,
  type VoiceStatus,
  type ConversationBindingState,
  type ConversationResumePreview,
  type ExplicitConversationBinding,
  type LaunchTemplateRecord,
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
  previewConversationResume(sessionId: string): Promise<ConversationResumePreview> {
    return invokeBridge('aiterm:session:resume-preview', sessionId)
  },
  locateConversation(binding: ExplicitConversationBinding): Promise<ExplicitConversationBinding> {
    return invokeBridge('aiterm:session:binding-replace', binding.sessionId, binding)
  },
  startNewConversation(sessionId: string): Promise<{ cleared: boolean }> {
    return invokeBridge('aiterm:session:binding-clear', sessionId)
  },
  async resumeConversation(sessionId: string): Promise<StartupSuccess> {
    const startup = await invokeBridge<StartupSuccess>('aiterm:session:resume', sessionId)
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
  listWorkspaces(includeArchived = false): Promise<WorkspaceRecord[]> {
    return invokeBridge('aiterm:workspace:list', { includeArchived })
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
  listTemplates(): Promise<LaunchTemplateRecord[]> {
    return invokeBridge('aiterm:template:list', {})
  },
  createTemplate(params: {
    name: string
    executable: string
    argv: string[]
    cwd: string
    backgroundChoice?: 'hide' | 'stop' | null
  }): Promise<LaunchTemplateRecord> {
    return invokeBridge('aiterm:template:create', params)
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
  deliverArtifact(artifactId: string, sessionId: string): Promise<{ delivered: true; path: string }> {
    return invokeBridge('aiterm:artifact:deliver', { artifactId, sessionId })
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
  chooseFileReferenceBase(): Promise<string | null> {
    return invokeBridge('aiterm:file-reference:choose-base', {})
  },
  showFileReference(path: string): Promise<{ shown: true }> {
    return invokeBridge('aiterm:file-reference:show', { path })
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
    origin?: AttentionOrigin
  ): Promise<AttentionRecord> {
    return invokeBridge('aiterm:attention:resolve', {
      requestId,
      ...(resolution ? { resolution } : {}),
      ...(expected ? { expectedKind: expected.kind, expectedRevision: expected.revision } : {}),
      ...(origin ? { origin } : {})
    })
  },
  listHookEvents(sessionId: string): Promise<HookEventRecord[]> {
    return invokeBridge('aiterm:hook-events:list', { sessionId })
  },
  listProgress(): Promise<ProgressRecord[]> {
    return invokeBridge('aiterm:progress:list', {})
  },
  listDrafts(): Promise<InputDraftRecord[]> {
    return invokeBridge('aiterm:draft:list', {})
  },
  saveHandoffDraft(params: HandoffDraftSaveParams): Promise<InputDraftRecord> {
    return invokeBridge('aiterm:draft:save', params)
  },
  retryHandoffDraft(draftId: string): Promise<InputDraftRecord> {
    return invokeBridge('aiterm:draft:retry', { draftId })
  },
  sendDraft(draftId: string, submit: boolean, expected?: DraftSendExpectation): Promise<InputDraftRecord> {
    return invokeBridge('aiterm:draft:send', { draftId, submit, ...expected })
  },
  discardDraft(draftId: string): Promise<InputDraftRecord> {
    return invokeBridge('aiterm:draft:discard', { draftId })
  },
  getSettings(): Promise<AppSettings> {
    return invokeBridge('aiterm:settings:get', {})
  },
  putSettings<Section extends keyof AppSettings>(section: Section, value: AppSettings[Section]): Promise<AppSettings> {
    return invokeBridge('aiterm:settings:put', { section, value })
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
  getControlInfo(): Promise<ControlInfo> {
    return invokeBridge('aiterm:control:info', {})
  },
  exportBackup(): Promise<{ directory: string; manifest: BackupManifest } | null> {
    return invokeBridge('aiterm:backup:export', {})
  },
  verifyBackup(directory?: string): Promise<BackupVerifyResult | null> {
    return invokeBridge('aiterm:backup:verify', directory ? { directory } : {})
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
