// MODULE: bridge.d.ts - the typed window.aiTerminal bridge the preload exposes to the renderer
import type {
  AppEventMessage,
  ProgramCopyNotice,
  AgentHistoryStatus,
  AgentsApprovalRequest,
  AgentsOutcome,
  OpenCodeGoView,
  AgentsPreview,
  AgentsShownRevision,
  AgentsSnapshot,
  AgentsTeamUpdateShown,
  RosterDataShape,
  RosterHarness,
  ContextLimitApp,
  ContextLimitPlan,
  ResearchLookup,
  JudgeTried,
  JudgeView,
  WebQuestionAsked,
  WebQuestionsSnapshot,
  TeamAskDetail,
  TeamAsksSnapshot,
  ResearchSnapshot,
  ToolProposalView,
  ToolsPlan,
  RulesOutcome,
  RulesMasterPlan,
  RulesPlan,
  RulesSavePlan,
  RulesRevertPlan,
  RulesSnapshot,
  AppSettings,
  ArtifactPreview,
  ArtifactRecord,
  AttentionOrigin,
  AttentionRecord,
  AutoTestsView,
  BackupExportResult,
  ClosePromptDecision,
  ClosePromptRequest,
  ControlInfo,
  OwnerAwayView,
  DraftSendExpectation,
  FileReferenceReadParams,
  FileReferenceReadResult,
  FileReferencePasteParams,
  FileReferencePasteReceipt,
  FileReferenceSearchParams,
  FileReferenceSearchResult,
  HookEventRecord,
  HookEventsView,
  HookObservation,
  HookOriginRecord,
  SessionPorts,
  SessionUsage,
  UsageReading,
  GuardStop,
  TurnDetailAnswer,
  TurnDifferenceAnswer,
  TurnSessionView,
  TurnSummary,
  InputDraftRecord,
  InterruptedSessionCohort,
  SessionCohortOfferedResult,
  ProgressRecord,
  RepositoryIdentity,
  DevAutoRunsResult,
  TelegramStatus,
  TerminalNoticeCode,
  VoiceLanguage,
  VoiceModelId,
  VoiceStatus,
  ConversationBindingState,
  SessionResumePreview,
  ExplicitConversationBinding,
  LayoutGetResult,
  LayoutPutParams,
  ProtocolErrorCode,
  SavedOutputCapture,
  SavedOutputCatalog,
  SavedOutputSnapshot,
  SessionCreateParams,
  SessionMessageListing,
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
  /**
   * Story 32.3: the host resets the tracker and, in order with the output, the view: `reset` once the view wrote it,
   * `busy` (nothing changed) while the program is part-way through a sequence, `unconfirmed` if the view went first.
   */
  resetTerminalModes(sessionId: string): Promise<{ outcome: 'reset' | 'busy' | 'unconfirmed'; modes: number[] }>
  getSavedOutput(sessionId: string): Promise<SavedOutputCatalog>
  stopSession(sessionId: string): Promise<{ stopped: true }>
  getConversationBinding(sessionId: string): Promise<ConversationBindingState>
  previewConversationResume(sessionId: string): Promise<SessionResumePreview>
  locateConversation(binding: ExplicitConversationBinding): Promise<ExplicitConversationBinding>
  startNewConversation(sessionId: string): Promise<{ cleared: boolean }>
  /** `expectedCommand`, the command the Resume dialog showed, makes a start that would run anything else fail. */
  resumeConversation(sessionId: string, expectedCommand?: string): Promise<TerminalStartupSuccess>
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
  inspectRepository(directory: string): Promise<RepositoryIdentity>
  readDevAutoRuns(workspaceId?: string): Promise<DevAutoRunsResult>
  getLayout(workspaceId: string): Promise<LayoutGetResult>
  putLayout(params: LayoutPutParams): Promise<WorkspaceLayoutState>
  /** Quits the app; the owner is asked first when sessions are running. */
  quitApplication(): Promise<void>
  onAppEvent(listener: (message: AppEventMessage) => void): () => void
  onClosePrompt(listener: (request: ClosePromptRequest) => void): () => void
  answerClosePrompt(requestId: string, decision: ClosePromptDecision): void
  onOpenSession(listener: (sessionId: string) => void): () => void
  /** Story 42.1: a program in one of the window's sessions put text on the clipboard with OSC 52. */
  onProgramCopy(listener: (notice: ProgramCopyNotice) => void): () => void
  /** Whether the owner has left the desktop idle; replays the current value to each new listener. */
  onPresence(listener: (presence: { away: boolean }) => void): () => void
  /** Desktop notifications skip the session the owner is looking at. */
  reportSelectedSession(sessionId: string | null): void
  listArtifacts(sessionId?: string | null): Promise<ArtifactRecord[]>
  attachFiles(sessionId: string): Promise<ArtifactRecord[]>
  attachDroppedFiles(sessionId: string, files: File[]): Promise<ArtifactRecord[]>
  pasteImage(sessionId: string): Promise<ArtifactRecord | null>
  previewArtifact(artifactId: string): Promise<ArtifactPreview>
  deliverArtifact(artifactId: string, sessionId: string, expectedIncarnationId?: string): Promise<{ delivered: true; path: string; pastedAt: string }>
  saveArtifactAs(artifactId: string): Promise<{ saved: string | null }>
  openArtifact(artifactId: string): Promise<{ opened: true }>
  showArtifact(artifactId: string): Promise<{ shown: true }>
  /** A read-only snapshot of a live local file; the utility resolves and checks the reference again. */
  readFileReference(params: FileReferenceReadParams): Promise<FileReferenceReadResult>
  pasteFileReference(params: FileReferencePasteParams): Promise<FileReferencePasteReceipt>
  searchFileReferences(params: FileReferenceSearchParams): Promise<FileReferenceSearchResult>
  cancelFileReferenceSearch(ownerId: string, requestId: string): Promise<void>
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
    origin?: AttentionOrigin,
    state?: 'answered' | 'withdrawn'
  ): Promise<AttentionRecord>
  /** Read-only: the recent hook events of one session, in memory only and never another session's. */
  listHookEvents(sessionId: string): Promise<HookEventRecord[]>
  listHookEvents(sessionId: string, includeHistory: true): Promise<HookEventsView>
  /**
   * Read-only: the latest harness event one run of a session actually reported, kept beyond the
   * 30-event log's evictions. `none` is an absence of evidence, never a verdict that hooks are broken.
   */
  getHookObservation(sessionId: string, incarnationId?: string): Promise<HookObservation>
  /**
   * Read-only: each session's latest model-origin facts (maker's country, model name, API host),
   * kept per live incarnation in memory only. One list read backs every flag in the window.
   */
  listHookOrigins(): Promise<HookOriginRecord[]>
  /**
   * Read-only: what one session's current run reported about plan use (Story 37.2), in memory only.
   * A Codex run's own session file is read first when its last read is older than 15 s.
   */
  getUsage(sessionId: string): Promise<SessionUsage>
  /** Read-only: the latest plan reading per agent across all sessions, since a plan belongs to the account. */
  listUsage(): Promise<UsageReading[]>
  /** Story 60.8: what each live session's prompt guard last stopped or warned about; memory only. */
  listGuardStops(): Promise<GuardStop[]>
  /** Keep blocked: the card closes and the session keeps its mark until a prompt passes. */
  keepGuardStop(sessionId: string): Promise<{ kept: boolean }>
  clearGuardStop(sessionId: string): Promise<{ cleared: boolean }>
  /** Allow here: asks about the same session again and, if nothing changed, approves that provider in that workspace. */
  allowGuardStop(stop: GuardStop): Promise<AgentsOutcome>
  /** Epic 69: where recording of turn changes stands for each session that records or still has a kept turn, with its latest turn. Window only. */
  listTurnRecording(): Promise<TurnSessionView[]>
  /** A session's latest kept turns, newest first. */
  listTurns(sessionId: string): Promise<TurnSummary[]>
  /** One kept turn with its labels and one page of its files, the one that `from` files stand before; `kept: false` once it is no longer kept. */
  readTurn(sessionId: string, turnId: string, from?: number): Promise<TurnDetailAnswer>
  /** One file's difference of a kept turn: bounded, every secret value already masked. Nothing reveals one. */
  readTurnDifference(sessionId: string, turnId: string, path: string): Promise<TurnDifferenceAnswer>
  /** Resume: a session's count of failed scans goes back to zero. */
  /** Read-only: the local ports each session's programs listen on, as the last /proc scan found them (Story 41.1). */
  listPorts(): Promise<SessionPorts[]>
  /**
   * Opens one listed port in the default browser (Story 41.2). The main process checks the port is still listed
   * for that session and builds the address itself; nothing is sent to the process.
   */
  openPort(sessionId: string, port: number): Promise<{ url: string }>
  /**
   * A terminal notification (OSC 9, 99 or 777) the view read out of this session's own output.
   * Only the window can see it, so only the window reports it; it opens a notice and nothing else.
   */
  reportTerminalNotice(params: {
    sessionId: string
    incarnationId: string
    code: TerminalNoticeCode
    title: string
    body?: string
  }): Promise<{ opened: boolean; requestKey: string; reason?: string }>
  listProgress(): Promise<ProgressRecord[]>
  /** Telegram and control drafts; no handoff is in any owner queue (Story 75.5). */
  listDrafts(): Promise<InputDraftRecord[]>
  retryDraft(draftId: string): Promise<InputDraftRecord>
  sendDraft(draftId: string, submit: boolean, expected?: DraftSendExpectation): Promise<InputDraftRecord>
  discardDraft(draftId: string): Promise<InputDraftRecord>
  /** Epic 66: one workspace's latest messages between its sessions, with what the hourly limit holds. Read-only (Story 75.4). */
  listSessionMessages(workspaceId: string): Promise<SessionMessageListing>
  getSettings(): Promise<AppSettings>
  putSettings<Section extends keyof AppSettings>(section: Section, value: AppSettings[Section]): Promise<AppSettings>
  /** Preferences → History: each Claude folder, each agent's counts and whether Start cleanup is waiting. */
  getHistoryStatus(): Promise<AgentHistoryStatus>
  /** Start cleanup: the owner's one confirmation; writes the Claude folders and starts the first run. */
  confirmHistory(): Promise<AgentHistoryStatus>
  configureTelegram(token: string | null): Promise<TelegramStatus>
  getTelegramStatus(): Promise<TelegramStatus>
  testTelegram(): Promise<TelegramStatus>
  /** Sends the machine's current readings to Telegram marked as a test; no stored state changes. */
  testHealthAlerts(): Promise<TelegramStatus>
  getControlInfo(): Promise<ControlInfo>
  /** Story 76.3: the owner's said away state, as his own surfaces see it. */
  getAway(): Promise<OwnerAwayView>
  setAway(to: 'away' | 'back', note?: string | null): Promise<OwnerAwayView>
  markAwaySummaryShown(periodId: string): Promise<OwnerAwayView>
  /** Writes a backup to a folder the owner picks and checks the copy at once (Story 75.7); null when he cancels. */
  exportBackup(): Promise<BackupExportResult | null>
  /** Epic 60.5: the team file, the approved version, pending differences with consequences, and approval history. */
  agentsSnapshot(): Promise<AgentsSnapshot>
  /** What an approving control would approve: validity, the grouped diff, its consequences in words and the rules files it would also update. */
  previewAgents(request: AgentsApprovalRequest): Promise<AgentsPreview>
  /** Approves the team file exactly as shown, or only the named sections' changes; refused when the file or the approval moved. `teamUpdate` names the rules files shown beside it. */
  approveAgents(shown: AgentsShownRevision, scope?: string[], teamUpdate?: AgentsTeamUpdateShown): Promise<AgentsOutcome>
  /** Writes the staged data into the file, then approves exactly that. */
  saveAgents(shown: AgentsShownRevision, data: RosterDataShape, teamUpdate?: AgentsTeamUpdateShown): Promise<AgentsOutcome>
  /** Writes the approved data back into the file's yaml blocks (all, or the named sections). */
  revertAgents(shown: AgentsShownRevision, scope: string[] | null): Promise<AgentsOutcome>
  /** An earlier version's data becomes a new version. */
  restoreAgents(shown: AgentsShownRevision, number: number, teamUpdate?: AgentsTeamUpdateShown): Promise<AgentsOutcome>
  agentsGeneration(number: number): Promise<{ generation: number; createdAt: string; data: RosterDataShape } | null>
  /** A new install: writes the starter team file (no agents, nothing approved). Refused when a team file exists. */
  startTeam(): Promise<AgentsOutcome>
  /** Opens the team file in the owner's own editor. */
  openTeamFile(): Promise<{ ok: boolean; path: string; message?: string }>
  /** An agent's notes, the owner's own words; never reach an agent. */
  saveAgentNotes(shown: AgentsShownRevision, agent: string, text: string): Promise<AgentsOutcome>
  /** Luna through OpenCode Go (70.4): whether OpenCode lists her and BMN's folder is signed in; `copy` copies the owner's Go sign-in there. */
  openCodeGo(copy?: boolean): Promise<OpenCodeGoView>
  /** Epic 60.6: the master, each app's rendering, health from `bmn rules check`, loading tests, the agent apps, installs and history. */
  rulesSnapshot(): Promise<RulesSnapshot>
  planRulesMaster(text: string): Promise<RulesMasterPlan>
  /** Story 75.9: what saving `text` writes, the master and each app's file, then the save itself, bound to that plan; Undo puts both back. */
  planRulesSave(text: string): Promise<RulesSavePlan>
  saveRules(text: string, expectedHash: string | null, expectedLink: string | null, expectedDirectory: string | null, planHash: string): Promise<RulesOutcome>
  planRulesRestore(transaction: string): Promise<RulesPlan>
  restoreRules(transaction: string, planHash: string): Promise<RulesOutcome>
  planRulesRevertMaster(revision: number): Promise<RulesRevertPlan>
  /** Owner-run: sends the rules to that app's provider, so only where it may receive private work. */
  probeRules(harness: RosterHarness): Promise<RulesOutcome>
  /** Story 60.9: what changing an app's default context limit would write, then the write itself, bound to that plan. */
  planContextLimit(harness: ContextLimitApp, limit: number | null, compact: number | null): Promise<ContextLimitPlan>
  applyContextLimit(harness: ContextLimitApp, limit: number | null, compact: number | null, planHash: string): Promise<RulesOutcome>
  /** Owner-run: starts the app once in an empty folder to see whether it takes the setting. */
  testContextLimit(harness: ContextLimitApp): Promise<RulesOutcome>
  /** BMN's own tests (Story 75.8): `fresh` makes it look now, without it the call waits for the tests under way. */
  autoTests(fresh: boolean): Promise<AutoTestsView>
  /** Owner-run: asks the app which skills it sees, first in an empty home folder, then with one test skill placed where its skills live. */
  testSkills(harness: RosterHarness): Promise<RulesOutcome>
  /** Owner-run: one prompt to that app's provider, to see whether the app hands a test skill to its model. */
  testSkillsLoading(harness: RosterHarness): Promise<RulesOutcome>
  /** Story 60.12: what removing the entries that are not on the list would change in each app's settings, then the change itself, bound to that plan (75.9: the rest installs itself). */
  planToolsInstall(removeUnlisted?: boolean): Promise<ToolsPlan>
  installTools(planHash: string, removeUnlisted?: boolean): Promise<RulesOutcome>
  /** Owner-run: starts the app in an empty home folder and asks which tools it sees there. */
  testTools(harness: RosterHarness): Promise<RulesOutcome>
  /** The entries the apps already hold, proposed as tools; a value an entry held is never part of a proposal. */
  proposeTools(): Promise<{ ok: boolean; message?: string; proposals: ToolProposalView[] }>
  /** Story 60.10: what model research has found and who may research. `fresh` asks each agent's app again; a plain read does not. */
  researchSnapshot(fresh: boolean): Promise<ResearchSnapshot>
  chooseResearcher(researcher: string): Promise<ResearchSnapshot>
  /** Owner-run: starts the research with that agent. It runs in the background; the snapshot says how far it is. */
  startResearch(researcher: string): Promise<ResearchSnapshot>
  stopResearch(): Promise<ResearchSnapshot>
  /** The owner's Test again: starts the fence test of the installed app named, or of Codex and OpenCode. It calls no provider and runs in the background; the snapshot says when it has ended. */
  testCodexFence(harness?: 'codex' | 'opencode'): Promise<ResearchSnapshot>
  /** Owner-run: researches one model name on one provider and resolves when that run ends. */
  lookUpModel(researcher: string, provider: string, model: string): Promise<ResearchLookup>
  /** Story 64.3: the kept web questions, what holds the research lock now, the switch and the day's count. */
  /** Team › the judge's page (65.3): its calls and the monthly limit, and one statement asked from the page. */
  judgeCalls(): Promise<JudgeView>
  setJudgeLimit(limit: { on: boolean; usd: number }): Promise<JudgeView>
  tryJudge(text: string, statement: string, data: 'public' | 'private'): Promise<JudgeTried>
  webQuestions(): Promise<WebQuestionsSnapshot>
  /** Story 73.1: every ask on this computer (his agents' and any from a shell), newest first. */
  teamAsks(): Promise<TeamAsksSnapshot>
  /** One ask opened: the whole question, what it read, who answered, and the answer as the teammate's own words. */
  teamAskDetail(id: string): Promise<TeamAskDetail>
  stopTeamAsk(id: string): Promise<TeamAsksSnapshot>
  /** Removes one ended ask, or every ended one with null. */
  removeTeamAsks(id: string | null): Promise<TeamAsksSnapshot>
  /** Exports one ask's allowlisted record into a folder he picks; `output` null when he cancels. */
  exportTeamAsk(id: string): Promise<{ output: string | null; files: number }>
  /** Owner-run: asks the web one question through the researcher picked on Models. It runs in the background; a refusal comes back in the command's own words. */
  askWebQuestion(question: string): Promise<WebQuestionAsked>
  /** Ends the research or question that is under way, whoever started it. */
  stopWebQuestion(): Promise<WebQuestionsSnapshot>
  setAgentsMayAsk(on: boolean): Promise<WebQuestionsSnapshot>
  /** Removes one kept question, or all of them with null; the kept text is deleted. */
  removeWebQuestions(id: string | null): Promise<WebQuestionsSnapshot>
  /** Opens the page one kept claim cites in the owner's browser. The address is read from the kept record, never taken from the window. */
  openWebQuestionPage(id: string, claim: number): Promise<{ opened: boolean }>
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
