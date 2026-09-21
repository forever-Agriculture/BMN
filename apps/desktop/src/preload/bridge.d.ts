import type {
  AppEventMessage,
  AppSettings,
  ArtifactPreview,
  ArtifactRecord,
  AttentionOrigin,
  AttentionRecord,
  BackupManifest,
  BackupVerifyResult,
  ClosePromptDecision,
  ClosePromptRequest,
  ControlInfo,
  DraftSendExpectation,
  FileReferenceReadParams,
  FileReferenceReadResult,
  HandoffDraftSaveParams,
  HookEventRecord,
  InputDraftRecord,
  InterruptedSessionCohort,
  SessionCohortOfferedResult,
  ProgressRecord,
  TelegramStatus,
  VoiceLanguage,
  VoiceModelId,
  VoiceStatus,
  ConversationBindingState,
  ConversationResumePreview,
  ExplicitConversationBinding,
  LaunchTemplateRecord,
  LayoutGetResult,
  LayoutPutParams,
  ProtocolErrorCode,
  SavedOutputCapture,
  SavedOutputCatalog,
  SavedOutputSnapshot,
  SessionCreateParams,
  SessionRecord,
  SessionUpdateParams,
  TerminalActivationResult,
  TerminalExitMessage,
  TerminalOutputMessage,
  TerminalViewDisconnectedMessage,
  TerminalViewDisconnectReason,
  WorkspaceCreateParams,
  WorkspaceLayoutState,
  WorkspaceRecord,
  WorkspaceUpdateParams
} from '@bmn/protocol'

/**
 * The one typed failure every `aiterm:*` bridge invoke rejects with. It is a plain object, not an
 * Error subclass: contextBridge rebuilds Error instances with only their message, while plain
 * objects cross intact, so `code` reaches the renderer structurally.
 */
export interface BridgeError {
  name: 'BridgeError'
  code: ProtocolErrorCode
  message: string
}

/** The envelope every main-process `aiterm:*` invoke handler resolves with. */
export type BridgeInvokeResult<Result> =
  | { ok: true; result: Result }
  | { ok: false; code: ProtocolErrorCode; message: string }

export interface TerminalStartupSuccess {
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
}

/** One checked row of the resume-after-stop dialog, carrying the command that row showed. */
export interface RendererCohortResumeRequest {
  cohortId: string
  idempotencyKey: string
  entries: Array<{ sessionId: string; action: 'resume' | 'relaunch'; command: string }>
}

export interface RendererCohortResumeEntryResult {
  sessionId: string
  outcome: 'started' | 'failed' | 'not-started'
  error?: string
  startup?: TerminalStartupSuccess
}

export interface RendererCohortResumeResult {
  cohortId: string
  entries: RendererCohortResumeEntryResult[]
}

export interface TerminalStartupFailure {
  ok: false
  message: string
  code: string
}

export interface ApplicationStartupSuccess {
  ok: true
  testMode: boolean
  activeWorkspaceId: string | null
  workspaces: WorkspaceRecord[]
  sessions: SessionRecord[]
  templates: LaunchTemplateRecord[]
  layouts: WorkspaceLayoutState[]
  /** Visible notices for workspaces whose persisted layout was unreadable and opened empty. */
  layoutNotices: string[]
  liveSessions: TerminalStartupSuccess[]
}

export type ApplicationStartup = ApplicationStartupSuccess | TerminalStartupFailure

export interface CreatedSession {
  session: SessionRecord
  startup: TerminalStartupSuccess
}

export interface AiTerminalBridge {
  security: { sandboxed: boolean; contextIsolated: boolean }
  versions: { chrome: string; electron: string }
  onStartup(listener: (startup: ApplicationStartup) => void): () => void
  onTerminalOutput(listener: (message: TerminalOutputMessage) => void): () => void
  onTerminalExit(listener: (message: TerminalExitMessage) => void): () => void
  onTerminalViewDisconnected(
    listener: (message: TerminalViewDisconnectedMessage) => void
  ): () => void
  onSavedOutputCaptureRequest(listener: (sessionId: string) => Promise<void>): () => void
  sendTerminalInput(attachmentId: string, bytes: Uint8Array): void
  acknowledgeTerminalOutput(attachmentId: string, streamSeq: number): void
  activateTerminal(sessionId: string): Promise<TerminalActivationResult>
  resizeTerminal(sessionId: string, cols: number, rows: number): Promise<{ cols: number; rows: number }>
  detachTerminal(sessionId: string): Promise<{ detached: true }>
  recoverTerminalView(sessionId: string, reason: TerminalViewDisconnectReason): Promise<{ recovering: true }>
  saveTerminalSnapshot(sessionId: string, capture: SavedOutputCapture): Promise<SavedOutputSnapshot>
  getSavedOutput(sessionId: string): Promise<SavedOutputCatalog>
  stopSession(sessionId: string): Promise<{ stopped: true }>
  getConversationBinding(sessionId: string): Promise<ConversationBindingState>
  previewConversationResume(sessionId: string): Promise<ConversationResumePreview>
  locateConversation(binding: ExplicitConversationBinding): Promise<ExplicitConversationBinding>
  startNewConversation(sessionId: string): Promise<{ cleared: boolean }>
  resumeConversation(sessionId: string): Promise<TerminalStartupSuccess>
  /** Runs the saved command again in a new process; agents start a fresh conversation. */
  relaunchSession(sessionId: string): Promise<TerminalStartupSuccess>
  /** What the newest update or quit interrupted, with the command each row would run. */
  listInterruptedCohort(): Promise<InterruptedSessionCohort | null>
  markCohortOffered(cohortId: string): Promise<SessionCohortOfferedResult>
  resumeCohort(request: RendererCohortResumeRequest): Promise<RendererCohortResumeResult>
  listWorkspaces(includeArchived?: boolean): Promise<WorkspaceRecord[]>
  createWorkspace(params: WorkspaceCreateParams): Promise<WorkspaceRecord>
  updateWorkspace(params: WorkspaceUpdateParams): Promise<WorkspaceRecord>
  listSessions(workspaceId: string): Promise<SessionRecord[]>
  createSession(params: SessionCreateParams): Promise<CreatedSession>
  updateSession(params: SessionUpdateParams): Promise<SessionRecord>
  listTemplates(): Promise<LaunchTemplateRecord[]>
  createTemplate(params: {
    name: string
    executable: string
    argv: string[]
    cwd: string
    backgroundChoice?: 'hide' | 'stop' | null
  }): Promise<LaunchTemplateRecord>
  getLayout(workspaceId: string): Promise<LayoutGetResult>
  putLayout(params: LayoutPutParams): Promise<WorkspaceLayoutState>
  /** Quits the app; the owner is asked first when sessions are running. */
  quitApplication(): Promise<void>
  onAppEvent(listener: (message: AppEventMessage) => void): () => void
  onClosePrompt(listener: (request: ClosePromptRequest) => void): () => void
  answerClosePrompt(requestId: string, decision: ClosePromptDecision): void
  onOpenSession(listener: (sessionId: string) => void): () => void
  /** Whether the owner has left the desktop idle; replays the current value to each new listener. */
  onPresence(listener: (presence: { away: boolean }) => void): () => void
  /** Desktop notifications skip the session the owner is looking at. */
  reportSelectedSession(sessionId: string | null): void
  listArtifacts(sessionId?: string | null): Promise<ArtifactRecord[]>
  attachFiles(sessionId: string): Promise<ArtifactRecord[]>
  attachDroppedFiles(sessionId: string, files: File[]): Promise<ArtifactRecord[]>
  pasteImage(sessionId: string): Promise<ArtifactRecord | null>
  previewArtifact(artifactId: string): Promise<ArtifactPreview>
  deliverArtifact(artifactId: string, sessionId: string): Promise<{ delivered: true; path: string }>
  saveArtifactAs(artifactId: string): Promise<{ saved: string | null }>
  openArtifact(artifactId: string): Promise<{ opened: true }>
  showArtifact(artifactId: string): Promise<{ shown: true }>
  /** A read-only snapshot of a live local file; the utility resolves and checks the reference again. */
  readFileReference(params: FileReferenceReadParams): Promise<FileReferenceReadResult>
  /** A native folder picker for resolving one reference; null when cancelled. */
  chooseFileReferenceBase(): Promise<string | null>
  /** Reveals the displayed file in the system file manager without opening it. */
  showFileReference(path: string): Promise<{ shown: true }>
  listAttention(): Promise<AttentionRecord[]>
  markAttentionSeen(requestId: string): Promise<AttentionRecord>
  resolveAttention(
    requestId: string,
    resolution?: string,
    expected?: Pick<AttentionRecord, 'kind' | 'revision'>,
    origin?: AttentionOrigin
  ): Promise<AttentionRecord>
  /** Read-only: the recent hook events of one session, in memory only and never another session's. */
  listHookEvents(sessionId: string): Promise<HookEventRecord[]>
  listProgress(): Promise<ProgressRecord[]>
  listDrafts(): Promise<InputDraftRecord[]>
  saveHandoffDraft(params: HandoffDraftSaveParams): Promise<InputDraftRecord>
  retryHandoffDraft(draftId: string): Promise<InputDraftRecord>
  sendDraft(draftId: string, submit: boolean, expected?: DraftSendExpectation): Promise<InputDraftRecord>
  discardDraft(draftId: string): Promise<InputDraftRecord>
  getSettings(): Promise<AppSettings>
  putSettings<Section extends keyof AppSettings>(section: Section, value: AppSettings[Section]): Promise<AppSettings>
  configureTelegram(token: string | null): Promise<TelegramStatus>
  getTelegramStatus(): Promise<TelegramStatus>
  testTelegram(): Promise<TelegramStatus>
  getControlInfo(): Promise<ControlInfo>
  exportBackup(): Promise<{ directory: string; manifest: BackupManifest } | null>
  verifyBackup(directory?: string): Promise<BackupVerifyResult | null>
  readClipboardText(): Promise<{ text: string }>
  writeClipboardText(text: string): Promise<{ written: true }>
  /** Local Whisper dictation: engine and model availability, with progress for running downloads. */
  getVoiceStatus(): Promise<VoiceStatus>
  downloadVoiceModel(model: VoiceModelId): Promise<{ started: boolean }>
  cancelVoiceModelDownload(model: VoiceModelId): Promise<{ cancelled: boolean }>
  /** Opens a folder picker in the main process; null when the owner cancels. */
  chooseVoiceModelFolder(): Promise<{ path: string } | null>
  /** Transcribes a 16 kHz mono WAV recording on this machine; nothing is typed into a session. */
  transcribeVoice(request: { wav: Uint8Array; model: VoiceModelId; language: VoiceLanguage; vocabulary: string[] }): Promise<{ text: string }>
}

declare global {
  interface Window {
    aiTerminal: AiTerminalBridge
  }
}
