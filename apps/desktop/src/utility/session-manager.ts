import { randomUUID } from 'node:crypto'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { kill as signalProcessByPid } from 'node:process'
import {
  ERROR_CODES,
  MAX_TERMINAL_CHUNK_BYTES,
  TERMINAL_UNDELIVERED_OUTPUT_BYTES,
  TERMINAL_SAVED_OUTPUT_BYTES,
  TERMINAL_SCROLLBACK_LINES,
  SAVED_OUTPUT_FORMAT_VERSION,
  TERMINAL_SAVED_OUTPUT_RETENTION,
  decsetResetSequence,
  lifecycleStopDetail,
  lifecycleStopSource,
  type BackgroundChoice,
  type ListeningPort,
  type BoundConversationBinding,
  type ConversationBindingState,
  type ConversationObservation,
  type ConversationObservationResult,
  type ExplicitConversationBinding,
  type PersistedConversationBinding,
  type ReplaceableConversationBinding,
  type ProtocolErrorCode,
  type SavedOutputCapture,
  type SavedOutputCatalog,
  type SavedOutputFinalCaptureUnavailable,
  type SavedOutputProcessState,
  type SavedOutputSnapshot,
  type SavedOutputUnavailableReason,
  type SavedOutputUnreadableEntry,
  type SessionProcessStatus,
  type SessionRecord,
  type InterruptedSessionCohort,
  type InterruptedSessionEntry,
  type SessionCohortOfferedResult,
  type SessionCohortResumeEntry,
  type SessionCohortResumeEntryResult,
  type SessionCohortResumeParams,
  type SessionCohortResumeResult,
  type SessionCohortStartedProcess,
  type SessionResumeParams,
  type SessionResumePreview,
  type SessionResumeResult,
  type ReportedResumeCommand,
  type ReportedResumePreview,
  isReportedResumePreview,
  reportedResumeArgvProblem,
  type SessionStopCause,
  type TerminalGraphicsChoice,
  type SessionProcessStateChangedMessage,
  type ProgramCopyMessage,
  type TerminalAckMessage,
  type TerminalActivationResult,
  type TerminalInputMessage,
  type TerminalPortMessage,
  type WorkspaceRecord
} from '@bmn/protocol'
import { processStartIdentity } from './process-start-identity'
import { scanOwnedWindowsSessionPorts } from './windows-session-ports'
import { findWindowsExecutable, windowsEnvironment } from './windows-launch'
import {
  newestInterruptionCohort,
  resumableStopCause,
  type InterruptedIncarnationRow
} from './interrupted-cohort'
import { HostOutputQueue, type HostOutputQueueTransition } from './transport'
import { TerminalByteFramer, type TerminalFrame } from './terminal-byte-framer'
import { terminalGraphicsEnvironment, type TerminfoAsset } from './terminal-graphics'
import { DecsetModeTracker } from './decset-modes'
import { Osc52Reader } from './osc52'
import { findProgramOnPath, missingProgramReason } from './reported-resume'
import { OutputTail, ScreenMirror } from './screen-mirror'
import {
  agentCli,
  applyCapturedLaunchEnvironment,
  bindingFromObservation,
  buildNativeResumeLaunch,
  conversationIdentity,
  conversationObservationDetail,
  conversationObservationSourceDetail,
  conversationReferenceExists,
  codexResumeArguments,
  describeDroppedCodexArguments,
  describeDroppedOpenCodeArguments,
  isConversationReference,
  isLowercaseConversationReference,
  opencodeResumeArguments,
  cursorResumeArguments,
  parseBoundBinding,
  parseClaudeHelpOptionGrammar,
  prepareConversationLaunch,
  shownCommand,
  type ClaudeOptionGrammar,
  type ClaudeSessionIdCapability
} from './conversation-binding'

export interface IncarnationExit {
  exitCode: number
  signal?: number
}

interface Disposable {
  dispose(): void
}

/** A Codex app-server daemon keeps its first client's environment, so its hooks cannot address this session. */
const CODEX_VALUE_OPTIONS = new Set([
  '-c', '--config', '-C', '--cd', '-m', '--model', '-p', '--profile', '-s', '--sandbox',
  '-a', '--ask-for-approval', '--remote-auth-token-env', '--add-dir', '-i', '--image', '--local-provider',
  '--enable', '--disable'
])

function codexSessionArgv(
  executable: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): readonly string[] {
  if (agentCli(executable) !== 'codex' || environment.CODEX_EXEC_SERVER_URL) return argv
  let skipValue = false
  let command: string | null = null
  for (const arg of argv) {
    if (skipValue) { skipValue = false; continue }
    // Following `--`, even flag-shaped words are prompt text.
    if (arg === '--') break
    if (arg === '--no-daemon' || arg === '--remote' || arg.startsWith('--remote=')) return argv
    if (CODEX_VALUE_OPTIONS.has(arg)) { skipValue = true; continue }
    if (!arg.startsWith('-') && command === null) command = arg
  }
  if (['agents', 'app-server', 'remote-control'].includes(command ?? '')) return argv
  return ['--no-daemon', ...argv]
}

/** Bash startup files may move a global Codex ahead of BMN's session-local launcher on PATH. */
function bashSessionArgv(
  executable: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): readonly string[] {
  const bin = environment.BMN_CLI_BIN_DIR
  if (!bin || executable.split('/').pop() !== 'bash') return argv
  let interactive = argv.length === 0
  for (const arg of argv) {
    if (arg === '--' || !arg.startsWith('-')) break
    if (arg === '--norc' || arg === '--rcfile' || arg.startsWith('--rcfile=') ||
      arg === '--init-file' || arg.startsWith('--init-file=') ||
      arg === '--login' || /^-[^-]*l/.test(arg)) return argv
    if (arg === '--interactive' || /^-[^-]*i/.test(arg)) interactive = true
    // The word after -c is shell code, even when it begins with a dash.
    if (/^-[^-]*c/.test(arg)) break
  }
  return interactive ? ['--rcfile', join(bin, 'bmn-bashrc'), ...argv] : argv
}

export interface PtyLike {
  readonly processOwnership?: 'windows-job'
  readonly processStartIdentity?: string
  queryListeningPorts?(): Promise<readonly ListeningPort[]>
  onLifecycleError?(listener: (reason: string) => void): Disposable
  readonly pid: number
  readonly cols: number
  readonly rows: number
  onData(listener: (data: string | Uint8Array) => void): Disposable
  onExit(listener: (exit: IncarnationExit) => void): Disposable
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
  pause(): void
  resume(): void
}

export interface CreateStartingRecord {
  sessionId: string
  incarnationId: string
  workspaceId: string
  name: string
  cwd: string
  executable: string
  argv: readonly string[]
  backgroundChoice: BackgroundChoice | null
  terminalGraphics: TerminalGraphicsChoice
  processStartIdentity: string
  startedAt: string
  binding: PersistedConversationBinding
}

export interface CreateResumingRecord {
  sessionId: string
  incarnationId: string
  processStartIdentity: string
  startedAt: string
  /** Only the reported command's own Resume keeps it; every other start clears it (Story 43.1 AC4). */
  keepReportedResume?: true
}

/** The manager's store also owns stored-session reads, so resume gates on the persisted record. */
/**
 * A start that repeats a command the owner has already read. `expectedCommand` is compared with the
 * command about to be spawned, so a binding that changed after the row was drawn fails the row
 * instead of quietly starting something else.
 */
export interface ConfirmedStartParams extends SessionResumeParams {
  expectedCommand?: string
}

export interface SessionStore extends StoredSessionReader {
  createStarting(record: CreateStartingRecord): Promise<void>
  createResuming(record: CreateResumingRecord): Promise<void>
  getConversationBinding(sessionId: string): Promise<PersistedConversationBinding | undefined>
  replaceConversationBinding(
    binding: ReplaceableConversationBinding
  ): Promise<PersistedConversationBinding>
  clearConversationBinding(sessionId: string): Promise<boolean>
  /** Story 43.1: throws when `incarnationId` is not the session's running process. */
  setReportedResume(record: { sessionId: string; incarnationId: string; argv: readonly string[]; reportedAt: string }): Promise<void>
  clearReportedResume(record: { sessionId: string; incarnationId: string }): Promise<boolean>
  markRunning(incarnationId: string): Promise<void>
  markExited(incarnationId: string, exit: IncarnationExit): Promise<void>
  markInterrupted(incarnationId: string, reason: string): Promise<void>
  listInterruptedIncarnations(): Promise<readonly InterruptedIncarnationRow[]>
  markCohortOffered(incarnationIds: readonly string[], offeredAt: string): Promise<void>
  health(): Promise<{
    runningIncarnations: number
    interruptedIncarnations?: number
    schemaTables?: readonly string[]
    sessionRecords?: number
    incarnationRecords?: number
    workspaceRecords?: number
    database?: { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number }
  }>
}

export interface SavedOutputStore {
  save(snapshot: SavedOutputSnapshot): Promise<void>
  load(identity: SessionIdentity, viewEpoch?: string): Promise<SavedOutputSnapshot | undefined>
  loadCatalog(): Promise<{
    snapshots: SavedOutputSnapshot[]
    finalCaptureUnavailable: SavedOutputFinalCaptureUnavailable[]
    unreadable: SavedOutputUnreadableEntry[]
    pruned: number
  }>
  recordFinalCaptureUnavailable(
    record: Omit<SavedOutputFinalCaptureUnavailable, 'formatVersion' | 'lastCaptureAt'>
  ): Promise<SavedOutputFinalCaptureUnavailable>
  markProcessState(
    identity: SessionIdentity,
    processState: Exclude<SavedOutputProcessState, 'live'>
  ): Promise<void>
}

interface PtyLaunchParams {
  cwd: string
  executable: string
  argv: readonly string[]
  cols: number
  rows: number
  terminalGraphics?: TerminalGraphicsChoice
}

export interface CreateSessionParams extends PtyLaunchParams {
  workspaceId: string
  name: string
  backgroundChoice?: BackgroundChoice | null
}

export interface SessionIdentity {
  sessionId: string
  incarnationId: string
}

export interface AttachmentIdentity extends SessionIdentity {
  attachmentId: string
  streamSeq: 0
  captureStartedAt: string
  /**
   * The private modes whose state a view created now would get wrong, so it can be brought up to
   * the program's. Empty for a process that changed none, and for one that has exited.
   */
  modes: number[]
}

interface SpawnOptions {
  cwd: string
  cols: number
  rows: number
  env: Readonly<Record<string, string | undefined>>
}

type SpawnPty = (executable: string, argv: readonly string[], options: SpawnOptions) => PtyLike

interface SessionManagerOptions {
  store: SessionStore
  savedOutputStore?: SavedOutputStore
  spawnPty: SpawnPty
  processStartIdentity?: (pid: number) => Promise<string>
  sendTerminalMessage: (message: TerminalPortMessage) => void
  environment?: Readonly<Record<string, string | undefined>>
  terminfoAsset?: TerminfoAsset
  /** Where a launch directory written as ~ or ~/… points; the owner's home by default. */
  homeDirectory?: string
  signalProcess?: (pid: number, signal: NodeJS.Signals) => boolean
  stopGraceMs?: number
  stopKillWaitMs?: number
  undeliveredOutputLimitBytes?: number
  outputQueueLimits?: {
    consumerBytes: number
    hostBytes: number
    acknowledgementDeadlineMs?: number
  }
  conversationReferenceExists?: (binding: BoundConversationBinding) => Promise<boolean>
  /** True while agent-history cleanup is deleting this conversation; Resume refuses it meanwhile. */
  conversationBeingDeleted?: (binding: BoundConversationBinding) => boolean
  capabilityProbeTimeoutMs?: number
  onSessionStateChange?: (message: SessionProcessStateChangedMessage) => void
  /** Every chunk a session's program writes, before any view sees it; it must return quickly. */
  onOutput?: (sessionId: string, bytes: Uint8Array) => void
  /** Story 42.1: text a program asked, with OSC 52, to put on the clipboard while a window had its view. */
  onProgramCopy?: (message: ProgramCopyMessage) => void
  /** Story 43.1: the PATH every process this manager starts sees; a reported resume command must resolve on it. */
  sessionPath?: () => string
  /** Addressed-control variables added after the private-variable filter for each process incarnation. */
  sessionEnvironment?: (identity: SessionIdentity) => Readonly<Record<string, string>>
}

export interface UndeliveredOutputState {
  limitBytes: number
  bufferedBytes: number
  droppedBytes: number
  truncated: boolean
}

interface LiveSession extends SessionIdentity {
  pty: PtyLike
  /** Host ownership survives a failed record write until the process confirms exit. */
  ownership: Pick<SessionRecord, 'workspaceId' | 'name'>
  dataSubscription?: Disposable
  exitSubscription?: Disposable
  lifecycleSubscription?: Disposable | undefined
  cwd: string
  executable: string
  captureStartedAt: string
  attachmentId?: string
  outputQueue?: HostOutputQueue
  outputFramer: TerminalByteFramer
  /** The private modes this program has turned on, read from its own output as it streams. */
  decsetModes: DecsetModeTracker
  /** Clipboard writes (OSC 52) read from the live stream; replayed or saved output never passes here. */
  programCopy: Osc52Reader
  /** The last output bytes, so a screen mirror started when an agent shows up can see what it drew. */
  outputTail: OutputTail
  /** A headless copy of the screen, only for sessions running an agent (Epic 30). */
  mirror?: ScreenMirror | undefined
  undeliveredOutput: TerminalFrame[]
  undeliveredOutputState: UndeliveredOutputState
  exitComplete: Promise<void>
  resolveExit: () => void
  recordReady: Promise<void>
  resolveRecordReady: () => void
  rejectRecordReady: (error: Error) => void
  exited: boolean
  exitUnconfirmed: boolean
  stopCause?: SessionStopCause
  teardown?: Promise<string | undefined>
  processStartIdentity: string
  conversationIdentity?: string
  conversationReservation?: ConversationReservation
}

interface ClaudeCapabilityProbeResult extends ClaudeSessionIdCapability {
  exitSettled: boolean
}

type ConversationReservationState = 'resuming' | 'live' | 'exit-unconfirmed'

interface ConversationReservation {
  conversationIdentity: string
  /** The session the reservation was claimed for, so a refused claim can name the holder. */
  sessionId: string
  state: ConversationReservationState
  live?: LiveSession
}

const CAPABILITY_PROBE_OUTPUT_BYTES = 256 * 1024
const SHELL_ENVIRONMENT_PRIVATE_PREFIXES = [
  'ELECTRON_',
  'CHROME_',
  'CHROMIUM_',
  'BMN_',
  'AITERM_',
  // Identity of whichever terminal launched the app; shells here run in BMN's xterm, not there.
  'AGTERM',
  'GHOSTTY_',
  'KITTY_',
  'WEZTERM_',
  'ALACRITTY_',
  'KONSOLE_'
] as const
const SHELL_ENVIRONMENT_PRIVATE_KEYS = new Set([
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERMINFO',
  'TMUX',
  'TMUX_PANE',
  'VTE_VERSION',
  'WINDOWID',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  // Session identity of an agent that launched the app (Claude Code 2.1.280 measured 2026-09-23;
  // Codex 0.156.1 measured 2026-09-23, and OMP from herdr src/pane.rs:166-180).
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'OMPCODE',
  // Terminal handles herdr strips (src/pane.rs:101-117).
  'ITERM_SESSION_ID',
  'WT_SESSION',
  'STY',
  'ZELLIJ',
  'ZELLIJ_SESSION_NAME',
  'ZELLIJ_PANE_ID',
  'ZELLIJ_VERSION'
])

export function buildShellEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform
): Record<string, string | undefined> {
  const shellEnvironment: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(environment)) {
    const checkedKey = platform === 'win32' ? key.toUpperCase() : key
    if (
      SHELL_ENVIRONMENT_PRIVATE_KEYS.has(checkedKey) ||
      (platform === 'win32' && checkedKey === 'TERMINFO_DIRS') ||
      SHELL_ENVIRONMENT_PRIVATE_PREFIXES.some((prefix) => checkedKey.startsWith(prefix))
    ) {
      continue
    }
    shellEnvironment[key] = value
  }
  shellEnvironment.TERM = 'xterm-256color'
  // xterm renders 24-bit color; without this Claude Code and Codex quantize their colors to the 256-color palette.
  shellEnvironment.COLORTERM = 'truecolor'
  return platform === 'win32' ? windowsEnvironment(shellEnvironment) : shellEnvironment
}

export class HostControlError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'HostControlError'
  }
}

/** A fresh process failed after its ordinary session row was saved; the owner can still inspect it. */
export class PersistedSessionStartError extends HostControlError {
  constructor(readonly sessionId: string, cause: HostControlError) {
    super(cause.code, cause.message, cause.retryable)
    this.name = 'PersistedSessionStartError'
  }
}

export interface StoredSessionReader {
  listWorkspaces(includeArchived: boolean): Promise<readonly WorkspaceRecord[]>
  listSessions(workspaceId: string): Promise<readonly SessionRecord[]>
}

/**
 * The row the owner read is the contract: if the command a start is about to run differs by a
 * byte, the row fails instead of starting something the owner never saw.
 */
function requireConfirmedCommand(expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new HostControlError(
      ERROR_CODES.invalidArgument,
      `The command changed since it was shown; nothing was started. It now reads: ${actual}`
    )
  }
}

export async function findStoredSession(
  reader: StoredSessionReader,
  sessionId: string
): Promise<SessionRecord | undefined> {
  const workspaces = await reader.listWorkspaces(true)
  for (const workspace of workspaces) {
    const stored = (await reader.listSessions(workspace.workspaceId))
      .find((session) => session.sessionId === sessionId)
    if (stored) return stored
  }
  return undefined
}

function bytesFromPty(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
}

/** Expands a leading ~ or ~/ the way a shell would, so a folder typed as ~/code/app launches; other paths are unchanged. */
export function resolveHomeDirectory(path: string, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && (path === '~' || /^~[\\/]/.test(path))) return win32.resolve(home, path.slice(2))
  if (path !== '~' && !path.startsWith('~/')) return path
  return posix.resolve(posix.join(home, path.slice(1)))
}

export async function validateLaunch(params: PtyLaunchParams, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  let cwdInfo
  try {
    cwdInfo = await stat(params.cwd)
  } catch {
    throw new HostControlError(
      ERROR_CODES.invalidArgument,
      `Launch directory does not exist or is not a directory: ${params.cwd}`
    )
  }
  if (!cwdInfo.isDirectory()) {
    throw new HostControlError(
      ERROR_CODES.invalidArgument,
      `Launch directory does not exist or is not a directory: ${params.cwd}`
    )
  }

  try {
    const executable = process.platform === 'win32' ? findWindowsExecutable(params.executable, params.cwd, environment) ?? params.executable : params.executable
    const executableInfo = await stat(executable)
    if (!executableInfo.isFile()) throw new Error('not a file')
    await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  } catch {
    throw new HostControlError(
      ERROR_CODES.invalidArgument,
      `Shell executable does not exist or is not executable: ${params.executable}`
    )
  }

  if (
    !Number.isInteger(params.cols) ||
    !Number.isInteger(params.rows) ||
    params.cols < 2 ||
    params.rows < 1 ||
    params.cols > 1000 ||
    params.rows > 1000
  ) {
    throw new HostControlError(ERROR_CODES.invalidArgument, 'Terminal dimensions are invalid')
  }
  if (!params.argv.every((argument) => typeof argument === 'string')) {
    throw new HostControlError(ERROR_CODES.invalidArgument, 'Shell arguments must be strings')
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>()
  private readonly store: SessionStore
  private readonly spawnPty: SpawnPty
  private readonly identifyProcess: (pid: number) => Promise<string>
  private readonly sendTerminalMessage: (message: TerminalPortMessage) => void
  private readonly environment: Readonly<Record<string, string | undefined>>
  private readonly terminfoAsset: TerminfoAsset | undefined
  private readonly homeDirectory: string
  private readonly sessionEnvironment:
    | ((identity: SessionIdentity) => Readonly<Record<string, string>>)
    | undefined
  private readonly sessionPath: () => string
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => boolean
  private readonly stopGraceMs: number
  private readonly stopKillWaitMs: number
  private readonly undeliveredOutputLimitBytes: number
  private readonly savedOutputStore: SavedOutputStore | undefined
  private readonly outputQueueLimits: {
    consumerBytes: number
    hostBytes: number
    acknowledgementDeadlineMs?: number
  } | undefined
  private readonly referenceExists: (binding: BoundConversationBinding) => Promise<boolean>
  private readonly beingDeleted: (binding: BoundConversationBinding) => boolean
  private readonly capabilityProbeTimeoutMs: number
  private readonly onSessionStateChange: (message: SessionProcessStateChangedMessage) => void
  private readonly onOutput: ((sessionId: string, bytes: Uint8Array) => void) | undefined
  private readonly onProgramCopy: ((message: ProgramCopyMessage) => void) | undefined
  private readonly claudeSessionIdCapabilities = new Map<string, Promise<ClaudeCapabilityProbeResult>>()
  private readonly conversationBindings = new Map<string, PersistedConversationBinding>()
  /** One SessionStart observation at a time per session, so a claim swap is never interleaved. */
  private readonly conversationObservations = new Map<string, Promise<unknown>>()
  private readonly conversationReservations = new Map<string, ConversationReservation>()
  /** Sessions with a Start again or Resume between its checks and its process being tracked. */
  private readonly launchingSessions = new Set<string>()
  /** One workspace admission boundary for starts and moves, paired with archive reservations. */
  private readonly workspaceAdmissions = new Map<string, Set<{ sessionId?: string; name: string }>>()
  private readonly archivingWorkspaces = new Set<string>()
  private readonly mutatingSessions = new Set<string>()
  /**
   * One dialog action per key, for the process lifetime. Repeated clicks, IPC retries and renderer
   * reconnects join the run already in flight and read its recorded result; nothing starts twice.
   */
  private readonly cohortResumeActions = new Map<string, Promise<SessionCohortResumeResult>>()

  constructor(options: SessionManagerOptions) {
    this.store = options.store
    this.spawnPty = options.spawnPty
    this.identifyProcess = options.processStartIdentity ?? processStartIdentity
    this.sendTerminalMessage = options.sendTerminalMessage
    this.environment = options.environment ?? process.env
    this.terminfoAsset = options.terminfoAsset
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.sessionEnvironment = options.sessionEnvironment
    this.sessionPath = options.sessionPath ?? (() => buildShellEnvironment(this.environment).PATH ?? '')
    this.signalProcess = options.signalProcess ?? signalProcessByPid
    this.stopGraceMs = options.stopGraceMs ?? 2_000
    this.stopKillWaitMs = options.stopKillWaitMs ?? 2_000
    this.undeliveredOutputLimitBytes =
      options.undeliveredOutputLimitBytes ?? TERMINAL_UNDELIVERED_OUTPUT_BYTES
    this.savedOutputStore = options.savedOutputStore
    this.outputQueueLimits = options.outputQueueLimits
    this.referenceExists = options.conversationReferenceExists ?? conversationReferenceExists
    this.beingDeleted = options.conversationBeingDeleted ?? (() => false)
    this.capabilityProbeTimeoutMs = options.capabilityProbeTimeoutMs ?? 2_000
    this.onSessionStateChange = options.onSessionStateChange ?? (() => undefined)
    this.onOutput = options.onOutput
    this.onProgramCopy = options.onProgramCopy
  }

  async create(
    requested: CreateSessionParams
  ): Promise<SessionIdentity & { binding: PersistedConversationBinding }> {
    return this.withWorkspaceAdmission(requested.workspaceId, { name: requested.name }, () => this.createAdmitted(requested))
  }

  private async createAdmitted(
    requested: CreateSessionParams
  ): Promise<SessionIdentity & { binding: PersistedConversationBinding }> {
    const params = { ...requested, cwd: resolveHomeDirectory(requested.cwd, this.homeDirectory) }
    if (!params.workspaceId || !params.name.trim() || params.name.length > 120) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Session workspace and name are invalid')
    }
    await this.validateLaunch(params)
    const sessionId = randomUUID()
    const captureStartedAt = new Date().toISOString()
    const prepared = await prepareConversationLaunch(
      sessionId,
      params,
      this.environment,
      randomUUID,
      captureStartedAt,
      () => this.claudeSessionIdCapability(params)
    )
    const bindingIdentity = conversationIdentity(prepared.binding)
    const reservation = bindingIdentity ? this.claimConversation(bindingIdentity, sessionId) : undefined
    // A launch that names an existing conversation (`codex resume <id>`) stands back from cleanup as Resume does.
    if (reservation && prepared.binding.status === 'bound') {
      try {
        this.refuseWhileDeleted(prepared.binding)
      } catch (error) {
        this.removeIfCurrent(reservation)
        throw error
      }
    }
    let recordPersisted = false
    let live: LiveSession
    try {
      live = await this.startIncarnation(
        sessionId,
        {
          ...params,
          executable: prepared.executable,
          argv: prepared.argv
        },
        this.environment,
        captureStartedAt,
        { workspaceId: params.workspaceId, name: params.name.trim() },
        async (record) => {
          await this.store.createStarting({
            ...record,
            workspaceId: params.workspaceId,
            name: params.name.trim(),
            cwd: params.cwd,
            executable: params.executable,
            argv: params.argv,
            backgroundChoice: params.backgroundChoice ?? null,
            terminalGraphics: params.terminalGraphics ?? null,
            binding: prepared.binding
          })
          recordPersisted = true
        },
        prepared.injectedArguments,
        reservation
      )
    } catch (error) {
      if (recordPersisted && error instanceof HostControlError) {
        throw new PersistedSessionStartError(sessionId, error)
      }
      throw error
    }
    this.conversationBindings.set(sessionId, prepared.binding)
    return {
      sessionId,
      incarnationId: live.incarnationId,
      binding: prepared.binding
    }
  }

  async conversationBinding(sessionId: string): Promise<ConversationBindingState> {
    const stored = await this.store.getConversationBinding(sessionId)
    const binding = stored ? parseBoundBinding(stored) : undefined
    if (!binding) {
      const live = this.sessions.get(sessionId)
      return {
        sessionId,
        agentCli: 'other',
        status: 'unsupported',
        captureRoute: 'unsupported',
        launchContext: {
          cwd: live?.cwd ?? '',
          executable: live?.executable ?? '',
          argv: [],
          environment: {}
        },
        detail: 'No conversation binding was captured for this session',
        capturedAt: new Date().toISOString()
      }
    }
    this.conversationBindings.set(sessionId, binding)
    if (binding.status === 'unsupported' || this.sessions.has(sessionId)) return binding
    if (await this.referenceExists(binding)) return binding
    return {
      ...binding,
      status: 'missing',
      detail: `The bound ${binding.agentCli} conversation reference is missing; no process was started`
    }
  }

  async replaceConversationBinding(
    input: ExplicitConversationBinding
  ): Promise<PersistedConversationBinding> {
    const binding = parseBoundBinding(input)
    if (binding.status !== 'bound' || binding.captureRoute !== 'explicit-resume-reference') {
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        'Replacement conversation bindings require an explicit resume reference'
      )
    }
    const explicitBinding: ExplicitConversationBinding = {
      ...binding,
      captureRoute: 'explicit-resume-reference'
    }
    const stored = await this.store.replaceConversationBinding(explicitBinding)
    this.conversationBindings.set(binding.sessionId, stored)
    return stored
  }

  async clearConversationBinding(sessionId: string): Promise<{ cleared: boolean }> {
    const cleared = await this.store.clearConversationBinding(sessionId)
    this.conversationBindings.delete(sessionId)
    return { cleared }
  }

  /**
   * The harness's own SessionStart word about which conversation its process is in. The latest
   * accepted observation from the live incarnation wins, because the process, not the launch
   * command, knows where it is. A refusal changes nothing and says why.
   */
  async observeConversation(
    observation: ConversationObservation
  ): Promise<ConversationObservationResult> {
    const queued = (this.conversationObservations.get(observation.sessionId) ?? Promise.resolve())
      .then(() => this.applyConversationObservation(observation))
    const settled = queued.then(() => undefined, () => undefined).then(() => {
      if (this.conversationObservations.get(observation.sessionId) === settled) {
        this.conversationObservations.delete(observation.sessionId)
      }
    })
    this.conversationObservations.set(observation.sessionId, settled)
    return queued
  }

  private async applyConversationObservation(
    observation: ConversationObservation
  ): Promise<ConversationObservationResult> {
    const refuse = (reason: string): ConversationObservationResult => ({
      accepted: false,
      detail: conversationObservationDetail([
        conversationObservationSourceDetail(observation.agentCli, observation.source),
        `refused: ${reason}`
      ])
    })
    const live = this.sessions.get(observation.sessionId)
    if (!live || live.exited) return refuse('the session has no live process')
    // An unconfirmed exit keeps the conversation reserved until BMN restarts; do not release it.
    if (live.exitUnconfirmed) return refuse('the process exit of this session is unconfirmed')
    if (observation.incarnationId !== null && observation.incarnationId !== live.incarnationId) {
      return refuse('the reporting process incarnation is no longer live')
    }
    const launched = agentCli(live.executable)
    if (launched !== observation.agentCli) {
      return refuse(`the session was launched as ${launched}, not ${observation.agentCli}`)
    }
    if (observation.agentCli === 'opencode'
      ? !isConversationReference('opencode', observation.conversationReference)
      : !isLowercaseConversationReference(observation.conversationReference)) {
      return refuse(observation.agentCli === 'opencode'
        ? 'the reported conversation reference is not an OpenCode session ID'
        : 'the reported conversation reference is not a storable UUID')
    }
    // A harness can report before its own session record has been written: the process is spawned
    // and registered live before `createStarting` completes, so wait for the record it needs.
    try {
      await live.recordReady
    } catch {
      return refuse('the session record was not created')
    }
    const stored = await this.store.getConversationBinding(observation.sessionId)
    const current = stored ? parseBoundBinding(stored) : undefined
    if (!current) return refuse('the session has no stored conversation binding')
    // A live session may have ended while the binding was read.
    if (this.sessions.get(observation.sessionId) !== live || live.exited) {
      return refuse('the session has no live process')
    }
    if (live.exitUnconfirmed) return refuse('the process exit of this session is unconfirmed')
    const identity = `${observation.agentCli}:${observation.conversationReference}`
    // Checked even when the stored binding already names this conversation: a binding the owner
    // located by hand carries no claim, so its session must still not take one another session holds.
    const holder = this.conversationReservations.get(identity)
    if (holder && holder !== live.conversationReservation) {
      const name = await this.storedSessionName(holder.sessionId)
      return refuse(`already resumed in ${JSON.stringify(name)}`)
    }
    // Cursor names its chat with every prompt; the same chat again changes nothing and is not rewritten.
    if (observation.source === 'prompt' && current.status === 'bound' && current.agentCli === observation.agentCli &&
      current.conversationReference === observation.conversationReference) {
      this.swapConversationClaim(live, identity)
      return { accepted: true, detail: current.detail }
    }
    const binding = bindingFromObservation(observation, current, new Date().toISOString())
    const restoreClaim = this.swapConversationClaim(live, identity)
    try {
      const persisted = await this.store.replaceConversationBinding(binding)
      this.conversationBindings.set(observation.sessionId, persisted)
    } catch (error) {
      restoreClaim()
      throw error
    }
    return { accepted: true, detail: binding.detail }
  }

  private async storedSessionName(sessionId: string): Promise<string> {
    const stored = await findStoredSession(this.store, sessionId).catch(() => undefined)
    return stored?.name ?? sessionId
  }

  /**
   * Moves a live session's conversation claim to the identity the harness reported: the new
   * reservation is acquired, the old one released and the live session re-attached, so teardown
   * releases the identity the session actually holds.
   */
  private swapConversationClaim(live: LiveSession, identity: string): () => void {
    const previous = live.conversationReservation
    if (previous && previous.conversationIdentity === identity) return () => undefined
    const reservation: ConversationReservation = {
      conversationIdentity: identity,
      sessionId: live.sessionId,
      state: 'live',
      live
    }
    this.conversationReservations.set(identity, reservation)
    if (previous && this.conversationReservations.get(previous.conversationIdentity) === previous) {
      this.conversationReservations.delete(previous.conversationIdentity)
    }
    live.conversationIdentity = identity
    live.conversationReservation = reservation
    // Rolling back must give up only what this session still owns: while the store write was in
    // flight another session may have taken the released identity, or this one may have torn down.
    return () => {
      if (this.conversationReservations.get(identity) === reservation) {
        this.conversationReservations.delete(identity)
      }
      if (live.conversationReservation !== reservation) return
      const stillLive = this.sessions.get(live.sessionId) === live && !live.exited
      if (previous && stillLive && !this.conversationReservations.has(previous.conversationIdentity)) {
        this.conversationReservations.set(previous.conversationIdentity, previous)
        live.conversationIdentity = previous.conversationIdentity
        live.conversationReservation = previous
        return
      }
      delete live.conversationIdentity
      delete live.conversationReservation
    }
  }

  /**
   * The complete stored-session gate runs before any binding lookup or launch: a session that is
   * not stored is NOT_FOUND, and stored launch metadata that cannot be used is IO_ERROR with its
   * actionable reason.
   */
  async resume(params: ConfirmedStartParams): Promise<SessionResumeResult> {
    const stored = await findStoredSession(this.store, params.sessionId)
    if (!stored) throw new HostControlError(ERROR_CODES.notFound, 'The session was not found')
    return this.withWorkspaceAdmission(stored.workspaceId, { sessionId: stored.sessionId, name: stored.name }, () => this.resumeAdmitted(params))
  }

  private async resumeAdmitted(params: ConfirmedStartParams): Promise<SessionResumeResult> {
    const stored = await findStoredSession(this.store, params.sessionId)
    if (!stored) {
      throw new HostControlError(ERROR_CODES.notFound, 'The session was not found')
    }
    if (stored.launchDisabledReason) {
      throw new HostControlError(ERROR_CODES.ioError, stored.launchDisabledReason)
    }
    if (stored.archivedAt !== null) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Restore the session before starting it')
    }
    // Story 43.2: a conversation BMN captured wins; else the command a program in the session reported; else
    // neither, and the binding's own reason, or its absence, is what the owner reads.
    const binding = this.conversationBindings.get(params.sessionId) ?? await this.loadStoredBinding(params.sessionId)
    if (binding?.status === 'bound' || (binding && !stored.reportedResume)) return this.resumeBinding(params, binding)
    if (stored.reportedResume) return this.resumeReported(params, stored, stored.reportedResume)
    throw new HostControlError(ERROR_CODES.invalidArgument, 'No conversation binding was captured for this session')
  }

  /**
   * Story 43.1: a program in the session reports the command that resumes it, for its own running process only,
   * replacing any earlier one. The name must resolve on the PATH the session's processes see, the one Resume uses.
   */
  async reportResumeCommand(p: {
    sessionId: string
    incarnationId: string
    argv: readonly string[]
  }): Promise<ReportedResumeCommand> {
    const problem = reportedResumeArgvProblem(p.argv)
    if (problem !== null) throw new HostControlError(ERROR_CODES.invalidArgument, problem)
    if (findProgramOnPath(p.argv[0]!, this.sessionPath()) === null) {
      throw new HostControlError(ERROR_CODES.invalidArgument, `The program "${p.argv[0]}" is not on this session's PATH`)
    }
    const command: ReportedResumeCommand = { argv: [...p.argv], reportedAt: new Date().toISOString() }
    await this.whileCurrent(p, () => this.store.setReportedResume({ ...p, ...command }))
    return command
  }

  /** Story 43.1: `bmn resume-command --clear`; false when nothing was kept. */
  async clearResumeCommand(p: { sessionId: string; incarnationId: string }): Promise<boolean> {
    return this.whileCurrent(p, () => this.store.clearReportedResume(p))
  }

  /** Runs a write that belongs to the session's running process, and names a refusal when that process has ended. */
  private async whileCurrent<Result>(
    p: { sessionId: string; incarnationId: string },
    write: () => Promise<Result>
  ): Promise<Result> {
    const ended = (): HostControlError =>
      new HostControlError(ERROR_CODES.unauthorized, 'This process is no longer the session\'s running one')
    if (this.liveIncarnationId(p.sessionId) !== p.incarnationId) throw ended()
    // A program can report before its process's record is written (it is registered live first), as
    // observeConversation also waits for.
    try {
      await this.sessions.get(p.sessionId)!.recordReady
    } catch {
      throw ended()
    }
    if (this.liveIncarnationId(p.sessionId) !== p.incarnationId) throw ended()
    try {
      return await write()
    } catch (error) {
      if (this.liveIncarnationId(p.sessionId) !== p.incarnationId) throw ended()
      throw new HostControlError(
        ERROR_CODES.ioError,
        `The resume command could not be saved: ${error instanceof Error ? error.message : 'unknown database error'}`
      )
    }
  }

  /**
   * Story 43.2: starts the command a program reported, as any session launch starts (BMN's environment rules, a new
   * token, no shell), in the session's working folder. The name is resolved on the session's PATH again now, and the
   * command the owner confirmed must be the one that runs.
   */
  private async resumeReported(
    params: ConfirmedStartParams,
    stored: SessionRecord,
    command: ReportedResumeCommand
  ): Promise<SessionResumeResult> {
    const program = findProgramOnPath(command.argv[0]!, this.sessionPath())
    if (program === null) throw new HostControlError(ERROR_CODES.notFound, missingProgramReason(command.argv[0]!))
    // A reported command came from text in the session, so it never runs without the command the owner confirmed.
    if (params.expectedCommand === undefined) {
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        'A command a program reported runs only after the owner has seen it; nothing was started'
      )
    }
    const argv = command.argv.slice(1)
    requireConfirmedCommand(params.expectedCommand, shownCommand(program, codexSessionArgv(program, argv, this.environment)))
    const releaseLaunch = this.claimSessionLaunch(params.sessionId)
    try {
      const launchParams: PtyLaunchParams = {
        cwd: stored.cwd,
        executable: program,
        argv,
        cols: params.cols,
        rows: params.rows,
        terminalGraphics: stored.terminalGraphics
      }
      await this.validateLaunch(launchParams)
      const live = await this.startIncarnation(
        params.sessionId,
        launchParams,
        this.environment,
        new Date().toISOString(),
        stored,
        (record) => this.store.createResuming({ ...record, keepReportedResume: true })
      )
      try {
        return { ...this.attach(live), launch: { cwd: stored.cwd, executable: program } }
      } catch (error) {
        await this.teardownSession(live)
        throw error
      }
    } finally {
      releaseLaunch()
    }
  }

  /** What Resume shows for a reported command; a program no longer on PATH is shown with the reason it cannot run. */
  private reportedResumePreview(stored: SessionRecord, command: ReportedResumeCommand): ReportedResumePreview {
    const program = findProgramOnPath(command.argv[0]!, this.sessionPath())
    return {
      sessionId: stored.sessionId,
      source: 'reported',
      argv: [...command.argv],
      program,
      cwd: stored.cwd,
      reportedAt: command.reportedAt,
      command: program === null ? '' : shownCommand(program,
        codexSessionArgv(program, command.argv.slice(1), this.environment)),
      refusal: program === null ? missingProgramReason(command.argv[0]!) : null
    }
  }

  /**
   * What one stop interrupted, and what starting each of them again would run. Reads records and
   * builds commands; it starts nothing, and a session the host is holding live has already been
   * resumed by hand, so it is left out.
   */
  async interruptedCohort(): Promise<InterruptedSessionCohort | null> {
    const selection = newestInterruptionCohort(await this.store.listInterruptedIncarnations())
    if (!selection) return null
    const entries: InterruptedSessionEntry[] = []
    for (const member of selection.members) {
      // The host still holding the session means it was resumed by hand, or its stop never
      // confirmed an exit. Neither can be started from here, so neither is offered.
      if (this.liveIncarnationId(member.sessionId)) continue
      entries.push(await this.interruptedEntry(member))
    }
    if (entries.length === 0) return null
    return {
      cohortId: selection.cohortId,
      cause: selection.cause,
      stoppedAt: selection.stoppedAt,
      offeredAt: selection.offeredAt,
      entries
    }
  }

  /**
   * Records that the dialog was shown for this cohort, so the offer is made once per stop. The
   * stamp is about the question, never about a process: nothing here starts or stops anything.
   */
  async markCohortOffered(cohortId: string): Promise<SessionCohortOfferedResult> {
    const selection = this.requireNewestCohort(
      newestInterruptionCohort(await this.store.listInterruptedIncarnations()),
      cohortId
    )
    const offeredAt = selection.offeredAt ?? new Date().toISOString()
    await this.store.markCohortOffered(selection.members.map((row) => row.incarnationId), offeredAt)
    return { cohortId: selection.cohortId, offeredAt }
  }

  /**
   * Starts the rows the owner checked, in their order, through the same Resume and Start again the
   * per-session controls use. Epic 10's contract: one in-memory key per dialog action, sequential
   * starts, stop after the first failure, and an outcome for every row. Nothing is retried or
   * killed, so a session that started stays running whatever the row after it does.
   */
  async resumeCohort(params: SessionCohortResumeParams): Promise<SessionCohortResumeResult> {
    const recorded = this.cohortResumeActions.get(params.idempotencyKey)
    if (recorded) return recorded
    const action = this.runCohortResume(params)
    this.cohortResumeActions.set(params.idempotencyKey, action)
    // The first caller awaits the rejection; this only keeps a retry-less failure from being unhandled.
    void action.catch(() => undefined)
    return action
  }

  private async runCohortResume(
    params: SessionCohortResumeParams
  ): Promise<SessionCohortResumeResult> {
    const entries: SessionCohortResumeEntryResult[] = []
    let stopped = false
    for (const entry of params.entries) {
      if (stopped) {
        entries.push({ sessionId: entry.sessionId, outcome: 'not-started' })
        continue
      }
      try {
        entries.push({
          sessionId: entry.sessionId,
          outcome: 'started',
          started: await this.startCohortEntry(entry)
        })
      } catch (error) {
        entries.push({
          sessionId: entry.sessionId,
          outcome: 'failed',
          error: error instanceof Error ? error.message : 'The session could not be started'
        })
        stopped = true
      }
    }
    return { cohortId: params.cohortId, entries }
  }

  /**
   * Re-reads the records immediately before the start. The row must still be a session a lifecycle
   * stop interrupted; live, archived and exit-unconfirmed sessions fall out here or at the launch
   * claim the two start paths already take. The check is per row, not per cohort, so one row that
   * stopped qualifying does not invalidate the command another row still shows.
   */
  private async startCohortEntry(
    entry: SessionCohortResumeEntry
  ): Promise<SessionCohortStartedProcess> {
    const interrupted = await this.store.listInterruptedIncarnations()
    const member = interrupted.find((row) =>
      row.sessionId === entry.sessionId && resumableStopCause(row.detail) !== null)
    if (!member) {
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        'This session is no longer one a stop interrupted; nothing was started'
      )
    }
    const start: ConfirmedStartParams = {
      sessionId: entry.sessionId,
      cols: entry.cols,
      rows: entry.rows,
      expectedCommand: entry.command
    }
    if (entry.action === 'relaunch') {
      const started = await this.relaunch(start)
      return { ...started, cwd: member.cwd, executable: member.executable }
    }
    const resumed = await this.resume(start)
    return {
      sessionId: resumed.sessionId,
      incarnationId: resumed.incarnationId,
      attachmentId: resumed.attachmentId,
      streamSeq: resumed.streamSeq,
      captureStartedAt: resumed.captureStartedAt,
      modes: resumed.modes,
      cwd: resumed.launch.cwd,
      executable: resumed.launch.executable
    }
  }

  private requireNewestCohort(
    selection: ReturnType<typeof newestInterruptionCohort>,
    cohortId: string
  ): NonNullable<ReturnType<typeof newestInterruptionCohort>> {
    if (!selection || selection.cohortId !== cohortId) {
      throw new HostControlError(
        ERROR_CODES.notFound,
        'The interruption this offer described is no longer the newest one'
      )
    }
    return selection
  }

  /** One row: what the start would run, or why this session can only be started again. */
  private async interruptedEntry(row: InterruptedIncarnationRow): Promise<InterruptedSessionEntry> {
    const shared = {
      sessionId: row.sessionId,
      incarnationId: row.incarnationId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      name: row.name,
      detail: row.detail,
      interruptedAt: row.interruptedAt
    }
    try {
      const preview = await this.conversationResumePreview(row.sessionId)
      if (isReportedResumePreview(preview)) {
        // Story 43.2: listed with its exact command, never checked for the owner; one that cannot run any more
        // offers Start again and says why.
        return preview.refusal === null
          ? { ...shared, action: 'resume', command: preview.command, notCarried: '', relaunchReason: null, reportedAt: preview.reportedAt }
          : { ...shared, action: 'relaunch', command: shownCommand(row.executable,
            codexSessionArgv(row.executable, row.argv, this.environment)), notCarried: '', relaunchReason: preview.refusal }
      }
      return {
        ...shared,
        action: 'resume',
        command: preview.command,
        notCarried: preview.notCarried,
        relaunchReason: null
      }
    } catch (error) {
      // A session without a usable binding is honest about it and offers the stored command instead.
      return {
        ...shared,
        action: 'relaunch',
        command: shownCommand(row.executable, codexSessionArgv(row.executable, row.argv, this.environment)),
        notCarried: '',
        relaunchReason: error instanceof Error
          ? error.message
          : 'No conversation binding was captured for this session'
      }
    }
  }

  /**
   * Runs a stopped session's saved command again in a new process. Nothing is injected, so an agent
   * CLI starts a fresh conversation and the stored conversation binding is left for Resume.
   */
  async relaunch(params: ConfirmedStartParams): Promise<AttachmentIdentity> {
    const stored = await findStoredSession(this.store, params.sessionId)
    if (!stored) throw new HostControlError(ERROR_CODES.notFound, 'The session was not found')
    return this.withWorkspaceAdmission(stored.workspaceId, { sessionId: stored.sessionId, name: stored.name }, () => this.relaunchAdmitted(params))
  }

  private async relaunchAdmitted(params: ConfirmedStartParams): Promise<AttachmentIdentity> {
    const stored = await findStoredSession(this.store, params.sessionId)
    if (!stored) {
      throw new HostControlError(ERROR_CODES.notFound, 'The session was not found')
    }
    if (stored.launchDisabledReason) {
      throw new HostControlError(ERROR_CODES.ioError, stored.launchDisabledReason)
    }
    if (stored.archivedAt !== null) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Restore the session before starting it')
    }
    requireConfirmedCommand(params.expectedCommand, shownCommand(stored.executable,
      codexSessionArgv(stored.executable, stored.argv, this.environment)))
    const releaseLaunch = this.claimSessionLaunch(params.sessionId)
    try {
      const launchParams: PtyLaunchParams = {
        cwd: stored.cwd,
        executable: stored.executable,
        argv: [...stored.argv],
        cols: params.cols,
        rows: params.rows,
        terminalGraphics: stored.terminalGraphics
      }
      await this.validateLaunch(launchParams)
      const live = await this.startIncarnation(
        params.sessionId,
        launchParams,
        this.environment,
        new Date().toISOString(),
        stored,
        (record) => this.store.createResuming(record)
      )
      try {
        return this.attach(live)
      } catch (error) {
        await this.teardownSession(live)
        throw error
      }
    } finally {
      releaseLaunch()
    }
  }

  private async loadStoredBinding(sessionId: string): Promise<PersistedConversationBinding | undefined> {
    const stored = await this.store.getConversationBinding(sessionId)
    const binding = stored ? parseBoundBinding(stored) : undefined
    if (binding) this.conversationBindings.set(sessionId, binding)
    return binding
  }

  private resumeBinding(
    params: ConfirmedStartParams,
    persistedBinding: PersistedConversationBinding
  ): Promise<SessionResumeResult> {
    const binding = parseBoundBinding(persistedBinding)
    if (binding.status === 'unsupported') {
      return Promise.reject(new HostControlError(ERROR_CODES.invalidArgument, binding.detail))
    }
    const bindingIdentity = conversationIdentity(binding)!
    let reservation: ConversationReservation
    let releaseLaunch: () => void
    try {
      reservation = this.claimConversation(bindingIdentity, params.sessionId)
    } catch (error) {
      return Promise.reject(error)
    }
    try {
      releaseLaunch = this.claimSessionLaunch(params.sessionId)
    } catch (error) {
      this.removeIfCurrent(reservation)
      return Promise.reject(error)
    }
    return this.resumeOnce(params, binding, reservation).catch((error: unknown) => {
      if (!reservation.live) this.removeIfCurrent(reservation)
      throw error
    }).finally(releaseLaunch)
  }

  /**
   * The launch Resume will run: the same probe, the same argv builder and the same failures, so
   * the command the owner confirms and the process that starts cannot drift apart.
   */
  private async prepareResumeLaunch(binding: BoundConversationBinding): Promise<{
    launch: ReturnType<typeof buildNativeResumeLaunch>
    environment: ReturnType<typeof applyCapturedLaunchEnvironment>
  }> {
    const environment = applyCapturedLaunchEnvironment(
      this.environment,
      binding.launchContext.environment
    )
    let claudeGrammar: ClaudeOptionGrammar | undefined
    if (binding.agentCli === 'claude') {
      const capability = await this.claudeSessionIdCapability(
        {
          cwd: binding.launchContext.cwd,
          executable: binding.launchContext.executable,
          argv: [],
          cols: 80,
          rows: 24
        },
        environment
      )
      if (!capability.supported || !capability.grammar) {
        throw new HostControlError(
          ERROR_CODES.invalidArgument,
          `The stored Claude launch context cannot be re-admitted: ${capability.detail}`
        )
      }
      claudeGrammar = capability.grammar
    }
    try {
      const launch = buildNativeResumeLaunch(binding, claudeGrammar)
      return { launch: { ...launch, argv: [...codexSessionArgv(launch.executable, launch.argv, environment)] }, environment }
    } catch (error) {
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        error instanceof Error ? error.message : 'The stored launch context is unsupported'
      )
    }
  }

  /**
   * What Resume would run for a session, without starting anything. The owner reads this before
   * confirming, so no conversation is reopened by a command they have not seen.
   */
  async conversationResumePreview(sessionId: string): Promise<SessionResumePreview> {
    const stored = this.conversationBindings.get(sessionId)
      ?? await this.store.getConversationBinding(sessionId)
    const binding = stored ? parseBoundBinding(stored) : undefined
    if (!binding || binding.status !== 'bound') {
      // Story 43.2: without a conversation of its own, BMN offers what a program in the session reported.
      const session = await findStoredSession(this.store, sessionId)
      if (session?.reportedResume) return this.reportedResumePreview(session, session.reportedResume)
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        binding?.detail ?? 'No conversation binding was captured for this session'
      )
    }
    const { launch } = await this.prepareResumeLaunch(binding)
    const dropped = binding.agentCli === 'codex' && binding.captureRoute === 'hook-session-start'
      ? describeDroppedCodexArguments(codexResumeArguments(binding.launchContext.argv))
      : binding.agentCli === 'opencode'
        ? describeDroppedOpenCodeArguments(opencodeResumeArguments(binding.launchContext.argv))
      : binding.agentCli === 'cursor'
        ? describeDroppedCodexArguments(cursorResumeArguments(binding.launchContext.argv))
      : undefined
    return {
      sessionId,
      agentCli: binding.agentCli,
      conversationReference: binding.conversationReference,
      command: shownCommand(launch.executable, launch.argv),
      notCarried: dropped ?? ''
    }
  }

  private async resumeOnce(
    params: ConfirmedStartParams,
    binding: BoundConversationBinding,
    reservation: ConversationReservation
  ): Promise<SessionResumeResult> {
    this.refuseWhileDeleted(binding)
    if (!await this.referenceExists(binding)) {
      throw new HostControlError(
        ERROR_CODES.notFound,
        `The bound ${binding.agentCli} conversation reference is missing; no process was started`
      )
    }
    const { launch, environment: resumeEnvironment } = await this.prepareResumeLaunch(binding)
    requireConfirmedCommand(params.expectedCommand, shownCommand(launch.executable, launch.argv))
    const stored = await findStoredSession(this.store, params.sessionId)
    if (!stored) throw new HostControlError(ERROR_CODES.notFound, 'The session was not found')
    const launchParams: PtyLaunchParams = {
      cwd: launch.cwd,
      executable: launch.executable,
      argv: launch.argv,
      cols: params.cols,
      rows: params.rows,
      terminalGraphics: stored.terminalGraphics
    }
    await this.validateLaunch(launchParams, resumeEnvironment)
    const startedAt = new Date().toISOString()
    const live = await this.startIncarnation(
      params.sessionId,
      launchParams,
      resumeEnvironment,
      startedAt,
      stored,
      (record) => this.store.createResuming(record),
      binding.agentCli === 'claude' ? ['--resume']
        : binding.agentCli === 'opencode' ? ['--session']
          : binding.agentCli === 'cursor' ? ['--resume'] : ['resume'],
      reservation
    )
    try {
      return {
        ...this.attach(live),
        binding,
        launch: { cwd: launch.cwd, executable: launch.executable }
      }
    } catch (error) {
      await this.teardownSession(live)
      throw error
    }
  }

  /** Called only after the conversation's reservation is held, so cleanup either saw it or is deleting now. */
  private refuseWhileDeleted(binding: BoundConversationBinding): void {
    if (this.beingDeleted(binding)) {
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        `BMN is cleaning up this ${binding.agentCli} conversation's history right now; try again in a moment`
      )
    }
  }

  private async startIncarnation(
    sessionId: string,
    params: PtyLaunchParams,
    environment: Readonly<Record<string, string | undefined>>,
    captureStartedAt: string,
    ownership: Pick<SessionRecord, 'workspaceId' | 'name'>,
    createRecord: (record: CreateResumingRecord) => Promise<void>,
    injectedArguments: readonly string[] = [],
    reservation?: ConversationReservation
  ): Promise<LiveSession> {
    let pty: PtyLike
    const incarnationId = randomUUID()
    try {
      pty = this.spawnValidatedPty(params, environment, { sessionId, incarnationId })
    } catch (error) {
      if (reservation) this.removeIfCurrent(reservation)
      if (injectedArguments.length === 0) throw error
      throw new HostControlError(
        ERROR_CODES.ioError,
        `${error instanceof Error ? error.message : 'The shell process could not be started'}. BMN injected ${injectedArguments.join(', ')} for exact conversation binding.`
      )
    }
    let resolveExit = (): void => undefined
    const exitComplete = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    let resolveRecordReady = (): void => undefined
    let rejectRecordReady: (error: Error) => void = () => undefined
    const recordReady = new Promise<void>((resolve, reject) => {
      resolveRecordReady = resolve
      rejectRecordReady = reject
    })
    void recordReady.catch(() => undefined)
    const live: LiveSession = {
      sessionId,
      incarnationId,
      pty,
      ownership: { workspaceId: ownership.workspaceId, name: ownership.name },
      cwd: params.cwd,
      executable: params.executable,
      captureStartedAt,
      outputFramer: new TerminalByteFramer(),
      decsetModes: new DecsetModeTracker(),
      programCopy: new Osc52Reader(),
      outputTail: new OutputTail(),
      undeliveredOutput: [],
      undeliveredOutputState: {
        limitBytes: this.undeliveredOutputLimitBytes,
        bufferedBytes: 0,
        droppedBytes: 0,
        truncated: false
      },
      exitComplete,
      resolveExit,
      recordReady,
      resolveRecordReady,
      rejectRecordReady,
      exited: false,
      exitUnconfirmed: false,
      processStartIdentity: '',
      ...(reservation
        ? {
            conversationIdentity: reservation.conversationIdentity,
            conversationReservation: reservation
          }
        : {})
    }
    if (reservation) {
      reservation.state = 'live'
      reservation.live = live
    }
    this.sessions.set(sessionId, live)
    live.dataSubscription = pty.onData((data) => this.onPtyData(live, bytesFromPty(data)))
    live.exitSubscription = pty.onExit((exit) => void this.onPtyExit(live, exit))
    live.lifecycleSubscription = pty.onLifecycleError?.((reason) => void this.markInterrupted(live, reason))

    try {
      live.processStartIdentity = pty.processOwnership === 'windows-job'
        ? pty.processStartIdentity ?? ''
        : await this.identifyProcess(pty.pid)
      if (!live.processStartIdentity) throw new Error('Retained process creation identity is unavailable')
      await createRecord({
        sessionId,
        incarnationId,
        processStartIdentity: live.processStartIdentity,
        startedAt: captureStartedAt
      })
      await this.store.markRunning(incarnationId)
      live.resolveRecordReady()
      if (live.exited) {
        await live.exitComplete
        throw new HostControlError(
          ERROR_CODES.ioError,
          injectedArguments.length === 0
            ? 'The shell process exited before startup completed'
            : `The shell process exited before startup completed after BMN injected ${injectedArguments.join(', ')} for exact conversation binding`
        )
      }
    } catch (error) {
      live.rejectRecordReady(error instanceof Error ? error : new Error('session record failed'))
      await this.teardownSession(live)
      if (error instanceof HostControlError) throw error
      throw new HostControlError(
        ERROR_CODES.ioError,
        `The shell started but its session record could not be saved: ${error instanceof Error ? error.message : 'unknown database error'}`
      )
    }

    return live
  }

  /** The companion's PATH is available before an incarnation receives credentials. */
  async validateLaunch(params: PtyLaunchParams, environment = this.environment): Promise<void> {
    await validateLaunch(params, process.platform === 'win32'
      ? windowsEnvironment(environment, { PATH: this.sessionPath() }) : environment)
  }

  spawnValidatedPty(
    params: PtyLaunchParams,
    environment: Readonly<Record<string, string | undefined>> = this.environment,
    identity?: SessionIdentity
  ): PtyLike {
    try {
      const env = {
        ...buildShellEnvironment(environment),
        ...terminalGraphicsEnvironment(params.terminalGraphics ?? null, environment, this.terminfoAsset),
        ...(identity ? this.sessionEnvironment?.(identity) : undefined)
      }
      const childEnvironment = process.platform === 'win32' ? windowsEnvironment(env) : env
      const argv = identity === undefined ? params.argv
        : bashSessionArgv(params.executable, codexSessionArgv(params.executable, params.argv, env), env)
      return this.spawnPty(params.executable, argv, {
        cwd: params.cwd,
        cols: params.cols,
        rows: params.rows,
        env: childEnvironment
      })
    } catch (error) {
      throw new HostControlError(
        ERROR_CODES.ioError,
        `The shell process could not be started: ${error instanceof Error ? error.message : 'unknown PTY error'}`
      )
    }
  }

  private async claudeSessionIdCapability(
    params: PtyLaunchParams,
    environment: Readonly<Record<string, string | undefined>> = this.environment
  ): Promise<ClaudeSessionIdCapability> {
    if (agentCli(params.executable) !== 'claude') {
      return { supported: false, detail: 'the executable is not the Claude CLI' }
    }
    let executableIdentity: string
    try {
      const executableInfo = await stat(params.executable)
      executableIdentity = [
        params.executable,
        executableInfo.dev,
        executableInfo.ino,
        executableInfo.size,
        executableInfo.mtimeMs
      ].join(':')
    } catch {
      return { supported: false, detail: 'the Claude executable identity could not be read' }
    }
    const cached = this.claudeSessionIdCapabilities.get(executableIdentity)
    if (cached) return cached
    const probed = this.probeClaudeSessionIdCapability(params, environment)
    this.claudeSessionIdCapabilities.set(executableIdentity, probed)
    void probed.then((result) => {
      if (
        !result.exitSettled &&
        this.claudeSessionIdCapabilities.get(executableIdentity) === probed
      ) {
        this.claudeSessionIdCapabilities.delete(executableIdentity)
      }
    })
    return probed
  }

  private async probeClaudeSessionIdCapability(
    params: PtyLaunchParams,
    environment: Readonly<Record<string, string | undefined>>
  ): Promise<ClaudeCapabilityProbeResult> {
    let probe: PtyLike
    try {
      probe = this.spawnValidatedPty(
        { ...params, argv: ['--help'], cols: 80, rows: 24 },
        environment
      )
    } catch (error) {
      return {
        supported: false,
        exitSettled: false,
        detail: `the capability probe could not start (${error instanceof Error ? error.message : 'unknown PTY error'})`
      }
    }

    return new Promise((resolve) => {
      const decoder = new TextDecoder()
      let output = ''
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const subscriptions: { data?: Disposable; exit?: Disposable } = {}
      const finish = (capability: ClaudeCapabilityProbeResult): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        subscriptions.data?.dispose()
        subscriptions.exit?.dispose()
        resolve(capability)
      }
      subscriptions.data = probe.onData((data) => {
        if (output.length >= CAPABILITY_PROBE_OUTPUT_BYTES) return
        const chunk = typeof data === 'string' ? data : decoder.decode(data, { stream: true })
        output += chunk.slice(0, CAPABILITY_PROBE_OUTPUT_BYTES - output.length)
      })
      subscriptions.exit = probe.onExit((exit) => {
        output += decoder.decode()
        const grammar = exit.exitCode === 0
          ? parseClaudeHelpOptionGrammar(output)
          : undefined
        const sessionIdOption = grammar?.byAlias.get('--session-id')
        const supported =
          exit.exitCode === 0 &&
          sessionIdOption?.canonicalName === '--session-id' &&
          sessionIdOption.arity === 'required'
        finish({
          supported,
          exitSettled: true,
          ...(grammar ? { grammar } : {}),
          detail: supported
            ? 'Claude --help provides a parsable option grammar with --session-id <uuid>'
            : exit.exitCode !== 0
              ? `Claude --help exited with code ${exit.exitCode}`
              : grammar
                ? 'Claude --help does not advertise required --session-id syntax'
                : 'Claude --help did not contain a parsable option table'
        })
      })
      if (!settled) {
        timer = setTimeout(() => {
          finish({
            supported: false,
            exitSettled: false,
            detail: 'the Claude --help capability probe timed out'
          })
          try {
            probe.kill()
          } catch {
            // The failed probe is already classified as unsupported.
          }
        }, this.capabilityProbeTimeoutMs)
        timer.unref()
      }
    })
  }

  attach(identity: SessionIdentity): AttachmentIdentity {
    const session = this.current(identity)
    if (session.attachmentId) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'This process already has an interactive terminal')
    }
    const attachmentId = randomUUID()
    session.captureStartedAt = new Date().toISOString()
    session.attachmentId = attachmentId
    // Callers may pass the live process record; return only plain identity data so it survives IPC.
    return {
      sessionId: identity.sessionId,
      incarnationId: identity.incarnationId,
      attachmentId,
      streamSeq: 0,
      captureStartedAt: session.captureStartedAt,
      modes: session.decsetModes.modes()
    }
  }

  activateAttachment(attachmentId: string): TerminalActivationResult {
    const session = this.byAttachment(attachmentId)
    if (session.outputQueue) {
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        'The terminal attachment is already active'
      )
    }
    const disclosure = {
      limitBytes: session.undeliveredOutputState.limitBytes,
      droppedBytes: session.undeliveredOutputState.droppedBytes,
      truncated: session.undeliveredOutputState.truncated
    }
    session.undeliveredOutputState = {
      limitBytes: this.undeliveredOutputLimitBytes,
      bufferedBytes: session.undeliveredOutputState.bufferedBytes,
      droppedBytes: 0,
      truncated: false
    }
    const queue = new HostOutputQueue({
      attachmentId,
      ...(this.outputQueueLimits ?? {}),
      send: (message) => this.sendTerminalMessage(message),
      pause: () => session.pty.pause(),
      resume: () => session.pty.resume(),
      disconnect: (reason, transition) => {
        this.sendTerminalMessage({ kind: 'terminal-view-disconnected', attachmentId, reason })
        this.revokeAttachment(session, transition)
      }
    })
    session.outputQueue = queue
    // Replay straight from the session buffer: if the queue overflows, its unsent frames
    // return ahead of the frames not yet replayed, and output arriving meanwhile queues behind them.
    while (session.outputQueue === queue && session.undeliveredOutput.length > 0) {
      const frame = session.undeliveredOutput.shift()!
      session.undeliveredOutputState.bufferedBytes -= frame.bytes.byteLength
      queue.enqueue(frame)
    }
    // The disclosure covers output produced without a view, so only backlog skipped here counts.
    if (queue.skippedBytes > 0) {
      disclosure.droppedBytes += queue.skippedBytes
      disclosure.truncated = true
    }
    return { activated: true, undeliveredOutput: disclosure }
  }

  /**
   * Conversation references BMN holds now: resuming or starting, live, or awaiting an unconfirmed exit.
   * History cleanup never deletes these; a Resume claims its hold before it checks cleanup's deleting mark,
   * so either one sees the other.
   */
  heldConversationReferences(): string[] {
    return [...this.conversationReservations.keys()].map((identity) => identity.slice(identity.indexOf(':') + 1))
  }

  /** Sessions whose process this host holds live now. */
  liveSessionIds(): string[] {
    return [...this.sessions].filter(([, live]) => !live.exited).map(([sessionId]) => sessionId)
  }

  /** Attribute native listeners only through each live retained Windows job. */
  scanWindowsSessionPorts(ids: ReadonlySet<string>): Promise<Map<string, ListeningPort[]>> {
    return scanOwnedWindowsSessionPorts(ids, id => this.sessions.get(id))
  }

  /** The incarnation the host currently holds live for a session, if any. */
  liveIncarnationId(sessionId: string): string | undefined {
    const live = this.sessions.get(sessionId)
    return live && !live.exited ? live.incarnationId : undefined
  }

  /** The directory the live process was started in, which an edit to the stored launch settings does not move. */
  liveLaunchDirectory(sessionId: string): string | undefined {
    const live = this.sessions.get(sessionId)
    return live && !live.exited ? live.cwd : undefined
  }

  /** Addressed input written straight to a session's live process, independent of any attached view. */
  writeToSession(sessionId: string, bytes: Uint8Array): void {
    const live = this.sessions.get(sessionId)
    if (!live || live.exited) {
      throw new HostControlError(ERROR_CODES.notFound, 'The session has no live process')
    }
    if (bytes.byteLength > MAX_TERMINAL_CHUNK_BYTES) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Terminal input chunk exceeds 256 KiB')
    }
    live.pty.write(bytes)
  }

  write(message: Pick<TerminalInputMessage, 'attachmentId' | 'bytes'>): void {
    if (message.bytes.byteLength > MAX_TERMINAL_CHUNK_BYTES) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Terminal input chunk exceeds 256 KiB')
    }
    this.byAttachment(message.attachmentId).pty.write(message.bytes)
  }

  acknowledge(message: Pick<TerminalAckMessage, 'attachmentId' | 'streamSeq'>): void {
    this.byAttachment(message.attachmentId).outputQueue?.acknowledge(message.streamSeq)
  }

  resize(params: { attachmentId: string; cols: number; rows: number }): { cols: number; rows: number } {
    const session = this.byAttachment(params.attachmentId)
    if (
      !Number.isInteger(params.cols) ||
      !Number.isInteger(params.rows) ||
      params.cols < 2 ||
      params.rows < 1 ||
      params.cols > 1000 ||
      params.rows > 1000
    ) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Terminal dimensions are invalid')
    }
    session.pty.resize(params.cols, params.rows)
    session.mirror?.resize(session.pty.cols, session.pty.rows)
    return { cols: session.pty.cols, rows: session.pty.rows }
  }

  /**
   * The live session's screen mirror, started on first use from the recent output tail. BMN asks for it
   * once an agent reports through its hooks; a plain shell never pays for a second parser.
   */
  screenMirror(sessionId: string, incarnationId?: string): ScreenMirror | undefined {
    const live = this.sessions.get(sessionId)
    if (!live || live.exited || (incarnationId !== undefined && live.incarnationId !== incarnationId)) return undefined
    live.mirror ??= new ScreenMirror(live.pty.cols, live.pty.rows, live.outputTail.read())
    return live.mirror
  }

  /** Stops the mirror when the agent that needed it has left the session; the tail keeps going. */
  stopScreenMirror(sessionId: string): void {
    const live = this.sessions.get(sessionId)
    live?.mirror?.dispose()
    if (live) live.mirror = undefined
  }

  detach(params: { attachmentId: string }): void {
    this.revokeAttachment(this.byAttachment(params.attachmentId))
  }

  rendererDisconnected(): void {
    for (const session of this.sessions.values()) {
      if (session.attachmentId) this.revokeAttachment(session)
    }
  }

  /** Electron self-test only: ends every session the way a crashed host would; reached only from pty-host's
   * `selfTestHealthProbe` in a host started with `--self-test-host`. */
  abandonForHostLossSelfTest(): void {
    for (const session of this.sessions.values()) {
      if (session.attachmentId) this.revokeAttachment(session)
      session.dataSubscription?.dispose()
      session.exitSubscription?.dispose()
      session.lifecycleSubscription?.dispose()
      if (session.pty.processOwnership === 'windows-job') {
        session.pty.kill()
        continue
      }
      try {
        this.signalProcess(-session.pty.pid, 'SIGKILL')
      } catch {
        try {
          this.signalProcess(session.pty.pid, 'SIGKILL')
        } catch {
          // The process may already have exited; the persisted incarnation intentionally stays live.
        }
      }
    }
    this.sessions.clear()
    this.conversationReservations.clear()
  }

  async stop(identity: SessionIdentity, cause: SessionStopCause = 'explicit'): Promise<void> {
    const session = this.current(identity)
    session.stopCause ??= cause
    if (session.exitUnconfirmed) {
      throw new HostControlError(
        ERROR_CODES.ioError,
        'The shell stop outcome is still unknown. Fix: restart BMN before reusing this session.',
        true
      )
    }
    const reason = await this.teardownSession(session)
    if (!reason) return
    throw new HostControlError(
      ERROR_CODES.ioError,
      `The shell stop outcome is unknown: ${reason}. Fix: restart BMN before reusing this session.`,
      true
    )
  }

  async health(): Promise<{
    liveSessions: number
    runningIncarnations: number
    interruptedIncarnations?: number
    sessions: Array<
      SessionIdentity & {
        cols: number
        rows: number
        attached: boolean
        state: 'live' | 'exited' | 'exit-unconfirmed'
        outputDraining: boolean
      }
    >
    schemaTables?: readonly string[]
    sessionRecords?: number
    incarnationRecords?: number
    workspaceRecords?: number
    database?: { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number }
  }> {
    const persisted = await this.store.health()
    return {
      ...persisted,
      liveSessions: [...this.sessions.values()].filter((session) => !session.exited).length,
      sessions: [...this.sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        incarnationId: session.incarnationId,
        cols: session.pty.cols,
        rows: session.pty.rows,
        attached: !!session.attachmentId,
        state: session.exited
          ? 'exited'
          : session.exitUnconfirmed
            ? 'exit-unconfirmed'
            : 'live',
        outputDraining: session.exited && !!session.outputQueue
      }))
    }
  }

  hasAttachment(attachmentId: string): boolean {
    return [...this.sessions.values()].some((session) => session.attachmentId === attachmentId)
  }

  undeliveredOutputState(identity: SessionIdentity): Readonly<UndeliveredOutputState> {
    return { ...this.current(identity).undeliveredOutputState }
  }

  /**
   * Story 32.3: returns the view and the tracker to a fresh terminal's modes at one point in the output stream. The
   * reset bytes follow every byte already read, so output still queued for the view cannot re-arm it after the
   * reset, and output that comes later reaches the view and the tracker in the same order. They go to the view only:
   * nothing reaches the PTY, and saved output keeps the program's own bytes.
   *
   * Only between characters and sequences: while the program is part-way through one, added bytes would split it,
   * so nothing changes and the answer is `busy`. `reset` means the view acknowledged writing the reset; `unconfirmed`
   * means the view went, or did not answer in time, first. The reset was sent then, and the tracker keeps it.
   */
  async resetTerminalModes(
    identity: SessionIdentity
  ): Promise<{ outcome: 'reset' | 'busy' | 'unconfirmed'; modes: number[] }> {
    const session = this.current(identity)
    if (session.exited || session.exitUnconfirmed) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The program in this session has exited')
    }
    const queue = session.outputQueue
    if (!queue || session.undeliveredOutput.length > 0) {
      throw new HostControlError(ERROR_CODES.notFound, 'This session has no terminal view to reset')
    }
    if (!session.outputFramer.atGround || !session.decsetModes.atGround) return { outcome: 'busy', modes: [] }
    const armed = session.decsetModes.reset()
    this.deliverFrames(session, session.outputFramer.push(new TextEncoder().encode(decsetResetSequence(armed))))
    return { outcome: (await queue.whenAcknowledged()) ? 'reset' : 'unconfirmed', modes: armed }
  }

  async saveTerminalSnapshot(
    identity: SessionIdentity,
    capture: SavedOutputCapture,
    context: {
      viewEpoch?: string
      captureStartedAt?: string
      processState?: SavedOutputProcessState
    } = {}
  ): Promise<SavedOutputSnapshot> {
    if (!this.savedOutputStore) {
      throw new HostControlError(ERROR_CODES.ioError, 'Saved output storage is unavailable')
    }
    if (
      !Number.isInteger(capture.retainedLines) ||
      capture.retainedLines < 0 ||
      capture.retainedLines > TERMINAL_SCROLLBACK_LINES
    ) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Saved output line count is invalid')
    }
    if (
      typeof capture.snapshotTruncated !== 'boolean' ||
      !Number.isInteger(capture.snapshotDroppedLines) ||
      capture.snapshotDroppedLines < 0 ||
      (capture.snapshotDroppedBytes !== null &&
        (!Number.isInteger(capture.snapshotDroppedBytes) || capture.snapshotDroppedBytes < 0)) ||
      !Number.isInteger(capture.transportDroppedBytes) ||
      capture.transportDroppedBytes < 0 ||
      capture.snapshotTruncated !== (capture.snapshotDroppedLines > 0) ||
      (capture.snapshotTruncated
        ? capture.snapshotDroppedBytes !== null
        : capture.snapshotDroppedBytes !== 0)
    ) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Saved output truncation metadata is invalid')
    }
    if (
      typeof capture.capturedAt !== 'string' ||
      !Number.isFinite(Date.parse(capture.capturedAt))
    ) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Saved output capture time is invalid')
    }
    if (new TextEncoder().encode(capture.content).byteLength > TERMINAL_SAVED_OUTPUT_BYTES) {
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        `Saved output exceeds the ${TERMINAL_SAVED_OUTPUT_BYTES / (1024 * 1024)} MiB limit`
      )
    }
    const session = this.sessions.get(identity.sessionId)
    const matchingSession = session?.incarnationId === identity.incarnationId ? session : undefined
    const viewEpoch = context.viewEpoch ?? matchingSession?.attachmentId ?? `initial:${identity.incarnationId}`
    if (
      matchingSession?.attachmentId &&
      context.viewEpoch &&
      context.viewEpoch !== matchingSession.attachmentId
    ) {
      throw new HostControlError(ERROR_CODES.notFound, 'The saved-output view epoch is no longer current')
    }
    const captureStartedAt = matchingSession?.captureStartedAt ?? context.captureStartedAt
    if (!captureStartedAt || !Number.isFinite(Date.parse(captureStartedAt))) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Saved output capture start time is invalid')
    }
    const processState = matchingSession
      ? matchingSession.exited
        ? 'exited'
        : matchingSession.exitUnconfirmed
          ? 'interrupted'
          : 'live'
      : context.processState
    if (!processState) {
      throw new HostControlError(ERROR_CODES.notFound, 'The saved-output process incarnation is unavailable')
    }
    const snapshot: SavedOutputSnapshot = {
      formatVersion: SAVED_OUTPUT_FORMAT_VERSION,
      ...identity,
      viewEpoch,
      ...capture,
      captureStartedAt,
      lineLimit: TERMINAL_SCROLLBACK_LINES,
      snapshotLimitBytes: TERMINAL_SAVED_OUTPUT_BYTES,
      processState
    }
    await this.savedOutputStore.save(snapshot)
    return snapshot
  }

  async savedOutput(
    identity: SessionIdentity,
    viewEpoch?: string
  ): Promise<SavedOutputSnapshot | undefined> {
    const snapshot = await this.savedOutputStore?.load(identity, viewEpoch)
    return this.savedOutputWithCurrentProcessState(snapshot)
  }

  async savedOutputCatalog(identity: SessionIdentity, requestedViewEpoch?: string): Promise<SavedOutputCatalog> {
    const stored = await this.savedOutputStore?.loadCatalog() ?? {
      snapshots: [],
      finalCaptureUnavailable: [],
      unreadable: [],
      pruned: 0
    }
    const live = this.sessions.get(identity.sessionId)
    const viewEpoch = requestedViewEpoch ??
      (live?.incarnationId === identity.incarnationId ? live.attachmentId : undefined) ??
      stored.snapshots.find(
        (snapshot) =>
          snapshot.sessionId === identity.sessionId &&
          snapshot.incarnationId === identity.incarnationId
      )?.viewEpoch ??
      `unknown:${identity.incarnationId}`
    const all = stored.snapshots
      .filter((snapshot) => snapshot.sessionId === identity.sessionId)
      .map((snapshot) => this.savedOutputWithCurrentProcessState(snapshot)!)
    const current = all.find(
      (snapshot) =>
        snapshot.sessionId === identity.sessionId &&
        snapshot.incarnationId === identity.incarnationId &&
        snapshot.viewEpoch === viewEpoch
    )
    const history = all
      .filter((snapshot) => snapshot !== current)
      .map((snapshot) => this.savedOutputWithCurrentProcessState(snapshot)!)
    return {
      view: {
        sessionId: identity.sessionId,
        incarnationId: identity.incarnationId,
        viewEpoch
      },
      ...(current ? { current } : {}),
      history,
      finalCaptureUnavailable: stored.finalCaptureUnavailable
        .filter((record) => record.sessionId === identity.sessionId)
        .map((record) => this.finalCaptureUnavailableWithCurrentProcessState(record)),
      unreadable: stored.unreadable.filter((entry) => entry.sessionId === identity.sessionId),
      retention: { limit: TERMINAL_SAVED_OUTPUT_RETENTION, pruned: stored.pruned }
    }
  }

  async savedOutputCatalogForSession(sessionId: string): Promise<SavedOutputCatalog> {
    const live = this.sessions.get(sessionId)
    if (live) {
      return this.savedOutputCatalog(
        { sessionId, incarnationId: live.incarnationId },
        live.attachmentId
      )
    }
    const stored = await this.savedOutputStore?.loadCatalog() ?? {
      snapshots: [],
      finalCaptureUnavailable: [],
      unreadable: [],
      pruned: 0
    }
    const newestSnapshot = stored.snapshots.find((snapshot) => snapshot.sessionId === sessionId)
    const newestFailure = stored.finalCaptureUnavailable.find((record) => record.sessionId === sessionId)
    const incarnationId = newestSnapshot?.incarnationId ?? newestFailure?.incarnationId ?? `unknown:${sessionId}`
    const viewEpoch = newestSnapshot?.viewEpoch ?? newestFailure?.viewEpoch ?? `unknown:${incarnationId}`
    const snapshots = stored.snapshots
      .filter((snapshot) => snapshot.sessionId === sessionId)
      .map((snapshot) => this.savedOutputWithCurrentProcessState(snapshot)!)
    const current = snapshots.find(
      (snapshot) => snapshot.incarnationId === incarnationId && snapshot.viewEpoch === viewEpoch
    )
    return {
      view: { sessionId, incarnationId, viewEpoch },
      ...(current ? { current } : {}),
      history: snapshots.filter((snapshot) => snapshot !== current),
      finalCaptureUnavailable: stored.finalCaptureUnavailable
        .filter((record) => record.sessionId === sessionId)
        .map((record) => this.finalCaptureUnavailableWithCurrentProcessState(record)),
      unreadable: stored.unreadable.filter((entry) => entry.sessionId === sessionId),
      retention: { limit: TERMINAL_SAVED_OUTPUT_RETENTION, pruned: stored.pruned }
    }
  }

  async recordFinalCaptureUnavailable(
    identity: SessionIdentity,
    params: {
      viewEpoch: string
      captureStartedAt: string
      unavailableAt: string
      reason: SavedOutputUnavailableReason
      detail: string
      processState: SavedOutputProcessState
    }
  ): Promise<SavedOutputFinalCaptureUnavailable> {
    if (!this.savedOutputStore) {
      throw new HostControlError(ERROR_CODES.ioError, 'Saved output storage is unavailable')
    }
    if (!Number.isFinite(Date.parse(params.unavailableAt))) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Final capture failure time is invalid')
    }
    const reasons: readonly SavedOutputUnavailableReason[] = [
      'no-renderer',
      'renderer-destroyed',
      'not-acknowledged-in-time',
      'capture-persist-failure'
    ]
    if (!reasons.includes(params.reason)) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Final capture failure reason is invalid')
    }
    return this.savedOutputStore.recordFinalCaptureUnavailable({
      ...identity,
      viewEpoch: params.viewEpoch,
      unavailableAt: params.unavailableAt,
      reason: params.reason,
      detail: params.detail.slice(0, 240),
      processState: params.processState
    })
  }

  /**
   * The single liveness rule: an incarnation is live only while this host holds it and its exit is
   * neither observed nor unconfirmed; otherwise the recorded outcome stands, and anything not
   * recorded as exited is interrupted.
   */
  private currentProcessState(
    sessionId: string,
    incarnationId: string,
    recorded: SavedOutputProcessState
  ): SavedOutputProcessState {
    const session = this.sessions.get(sessionId)
    const isLive =
      session?.incarnationId === incarnationId &&
      !session.exited &&
      !session.exitUnconfirmed
    if (isLive) return 'live'
    return recorded === 'exited' ? 'exited' : 'interrupted'
  }

  private savedOutputWithCurrentProcessState(
    snapshot: SavedOutputSnapshot | undefined
  ): SavedOutputSnapshot | undefined {
    if (!snapshot) return undefined
    return {
      ...snapshot,
      processState: this.currentProcessState(snapshot.sessionId, snapshot.incarnationId, snapshot.processState)
    }
  }

  private finalCaptureUnavailableWithCurrentProcessState(
    record: SavedOutputFinalCaptureUnavailable
  ): SavedOutputFinalCaptureUnavailable {
    return {
      ...record,
      processState: this.currentProcessState(record.sessionId, record.incarnationId, record.processState)
    }
  }

  /** Claim before the first await, then validate the saved catalogue under the reservation. */
  private async withWorkspaceAdmission<T>(
    workspaceId: string,
    admission: { sessionId?: string; name: string },
    action: () => Promise<T>
  ): Promise<T> {
    if (this.archivingWorkspaces.has(workspaceId)) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The workspace is being archived; nothing was started or moved')
    }
    if (admission.sessionId && this.mutatingSessions.has(admission.sessionId)) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The session is being archived or moved; try again')
    }
    const entries = this.workspaceAdmissions.get(workspaceId) ?? new Set()
    entries.add(admission)
    this.workspaceAdmissions.set(workspaceId, entries)
    try {
      const workspace = (await this.store.listWorkspaces(true)).find(row => row.workspaceId === workspaceId)
      if (!workspace) throw new HostControlError(ERROR_CODES.notFound, 'The workspace was not found')
      if (workspace.archivedAt !== null) {
        throw new HostControlError(ERROR_CODES.invalidArgument, 'Restore the workspace before starting or moving a session into it')
      }
      if (admission.sessionId) {
        const stored = await findStoredSession(this.store, admission.sessionId)
        if (!stored || stored.workspaceId !== workspaceId) {
          throw new HostControlError(ERROR_CODES.invalidArgument, 'The session changed before starting; nothing was started')
        }
        if (stored.archivedAt !== null) throw new HostControlError(ERROR_CODES.invalidArgument, 'Restore the session before starting it')
      }
      return await action()
    } finally {
      entries.delete(admission)
      if (entries.size === 0) this.workspaceAdmissions.delete(workspaceId)
    }
  }

  private ownsSession(sessionId: string): boolean {
    const live = this.sessions.get(sessionId)
    return !!live && (!live.exited || live.exitUnconfirmed) || this.launchingSessions.has(sessionId) ||
      [...this.workspaceAdmissions.values()].some(entries => [...entries].some(entry => entry.sessionId === sessionId))
  }

  /** Host-authoritative archive gate; the reservation also refuses later asynchronous admissions. */
  async archiveWorkspace<T>(workspaceId: string, mutation: () => Promise<T>): Promise<T> {
    if (this.archivingWorkspaces.has(workspaceId)) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The workspace is already being archived')
    }
    this.archivingWorkspaces.add(workspaceId)
    try {
      const pending = [...(this.workspaceAdmissions.get(workspaceId) ?? [])].map(entry => entry.name)
      const records = await this.store.listSessions(workspaceId)
      const savedNames = new Map(records.map(row => [row.sessionId, row.name]))
      const owned = [...this.sessions.values()].filter(live => live.ownership.workspaceId === workspaceId &&
        (!live.exited || live.exitUnconfirmed)).map(live => savedNames.get(live.sessionId) ?? live.ownership.name)
      const names = [...new Set([...pending, ...owned, ...records.filter(row => this.ownsSession(row.sessionId)).map(row => row.name)])]
      if (names.length > 0) {
        throw new HostControlError(ERROR_CODES.invalidArgument, `Stop the workspace's work before archiving: ${names.join(', ')}`)
      }
      return await mutation()
    } finally {
      this.archivingWorkspaces.delete(workspaceId)
    }
  }

  /** Starts cannot overtake a session archive/move, and moves share destination admission. */
  async updateSessionAvailability<T>(
    sessionId: string,
    change: { archived?: boolean; workspaceId?: string },
    mutation: () => Promise<T>
  ): Promise<T> {
    if (this.mutatingSessions.has(sessionId)) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The session is already being archived or moved')
    }
    const owned = this.ownsSession(sessionId)
    if (change.archived === true && owned) {
      const stored = await findStoredSession(this.store, sessionId)
      throw new HostControlError(ERROR_CODES.invalidArgument, `Stop ${stored?.name ?? 'the session'} before archiving it; its process may still be starting or its exit unconfirmed`)
    }
    // A live process may move; a start already in flight must finish in its admitted workspace.
    if (change.workspaceId && (this.launchingSessions.has(sessionId) ||
      [...this.workspaceAdmissions.values()].some(entries => [...entries].some(entry => entry.sessionId === sessionId)))) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The session is starting; wait before moving it')
    }
    this.mutatingSessions.add(sessionId)
    try {
      if (!change.workspaceId && change.archived !== false) return await mutation()
      const stored = await findStoredSession(this.store, sessionId)
      if (!stored) throw new HostControlError(ERROR_CODES.notFound, 'The session was not found')
      // A move has no launch-record check, because its saved workspace is still the source.
      return await this.withWorkspaceAdmission(change.workspaceId ?? stored.workspaceId, { name: stored.name }, async () => {
        const result = await mutation()
        const live = this.sessions.get(sessionId)
        if (live && change.workspaceId) live.ownership.workspaceId = change.workspaceId
        return result
      })
    } finally {
      this.mutatingSessions.delete(sessionId)
    }
  }

  /** A stored session record with its latest incarnation state decided by the liveness rule. */
  sessionWithCurrentProcessState(record: SessionRecord): SessionRecord {
    const last = record.lastProcess
    if (!last) return record
    const state = this.currentProcessState(record.sessionId, last.incarnationId, last.state)
    if (state === last.state) return record
    const lastProcess: SessionProcessStatus = state === 'live'
      ? { incarnationId: last.incarnationId, state, exitCode: null, signal: null, detail: null }
      : { ...last, state }
    return { ...record, lastProcess }
  }

  /**
   * Start again and Resume both launch into an existing session ID. Claimed synchronously, so only one launch
   * proceeds, and never while an earlier process of the session is still tracked, which would lose control of it.
   */
  private claimSessionLaunch(sessionId: string): () => void {
    if (this.mutatingSessions.has(sessionId)) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The session is being archived or moved; try again')
    }
    const current = this.sessions.get(sessionId)
    if (current?.exitUnconfirmed) {
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        'The previous process of this session has not confirmed its exit; restart BMN before starting it again'
      )
    }
    if (current && !current.exited) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The session is already running')
    }
    if (this.launchingSessions.has(sessionId)) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The session is already starting')
    }
    this.launchingSessions.add(sessionId)
    return () => this.launchingSessions.delete(sessionId)
  }

  private claimConversation(conversationIdentity: string, sessionId: string): ConversationReservation {
    const existing = this.conversationReservations.get(conversationIdentity)
    if (!existing) {
      const reservation: ConversationReservation = { conversationIdentity, sessionId, state: 'resuming' }
      this.conversationReservations.set(conversationIdentity, reservation)
      return reservation
    }
    throw new HostControlError(
      ERROR_CODES.invalidArgument,
      existing.state === 'exit-unconfirmed'
        ? 'The bound conversation has an exit-unconfirmed process incarnation; restart BMN before resuming it'
        : existing.state === 'live'
          ? 'The bound conversation already has a live process incarnation'
          : 'The bound conversation is already resuming or starting'
    )
  }

  private async teardownSession(session: LiveSession): Promise<string | undefined> {
    session.teardown ??= this.performTeardownSession(session)
    return session.teardown
  }

  private async performTeardownSession(session: LiveSession): Promise<string | undefined> {
    if (session.exited) return undefined
    if (session.pty.processOwnership === 'windows-job') {
      try {
        // The retained native job, not a PID lookup, is termination authority.
        session.pty.kill()
      } catch {
        // A request is not an exit confirmation. Keep the bounded waiter authoritative.
      }
      if (await this.waitForExit(session, this.stopGraceMs + this.stopKillWaitMs)) return undefined
      const reason = 'Exit of the owned Windows process tree was not confirmed'
      await this.markInterrupted(session, reason)
      return reason
    }
    const identityMatches = async (): Promise<boolean> => {
      try {
        return session.processStartIdentity.length > 0 &&
          (await this.identifyProcess(session.pty.pid)) === session.processStartIdentity
      } catch {
        // The OS process may have disappeared before node-pty delivered its exit event.
        return false
      }
    }
    let identityStillMatches = await identityMatches()
    if (identityStillMatches) {
      try {
        session.pty.kill()
      } catch {
        // The bounded wait and identity-checked force-kill path below decide the outcome.
      }
    }
    if (await this.waitForExit(session, this.stopGraceMs)) return undefined

    identityStillMatches = await identityMatches()
    if (identityStillMatches) {
      try {
        this.signalProcess(-session.pty.pid, 'SIGKILL')
      } catch {
        try {
          this.signalProcess(session.pty.pid, 'SIGKILL')
        } catch {
          // The bounded wait below decides whether the PTY reported the real outcome.
        }
      }
    }
    if (await this.waitForExit(session, this.stopKillWaitMs)) return undefined

    const reason = identityStillMatches
      ? 'SIGKILL was sent but a PTY exit event was not observed'
      : 'The process identity disappeared or changed before a PTY exit event was observed'
    const lifecycleCause = session.stopCause && session.stopCause !== 'explicit'
      ? session.stopCause
      : undefined
    await this.markInterrupted(session, lifecycleCause
      ? `${lifecycleStopSource(lifecycleCause)} · ${reason}`
      : reason)
    return reason
  }

  private current(identity: SessionIdentity): LiveSession {
    const session = this.sessions.get(identity.sessionId)
    if (!session || session.incarnationId !== identity.incarnationId) {
      throw new HostControlError(ERROR_CODES.notFound, 'The requested process incarnation is not live')
    }
    return session
  }

  private byAttachment(attachmentId: string): LiveSession {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.attachmentId === attachmentId
    )
    if (!session) {
      throw new HostControlError(ERROR_CODES.notFound, 'The terminal attachment is unknown or revoked')
    }
    return session
  }

  private onPtyData(session: LiveSession, bytes: Uint8Array): void {
    // Read before anything is queued or dropped: the mode set must follow the program even when
    // the view is gone, because that is exactly when the next view will need it.
    session.decsetModes.read(bytes)
    session.outputTail.push(bytes)
    session.mirror?.write(bytes)
    // Neither the port watch nor a clipboard write may cost the view this chunk: a failure in one stops here.
    try {
      this.onOutput?.(session.sessionId, bytes)
    } catch {
      // The next chunk tries again.
    }
    try {
      // Read always, so a sequence split across chunks stays whole. A copy counts only while a BMN window has this
      // session's view, the way herdr hands it to an attached client only: output kept for a later view never copies.
      for (const write of session.programCopy.push(bytes)) {
        if (session.outputQueue) this.onProgramCopy?.({ kind: 'program-copy', sessionId: session.sessionId, ...write })
      }
    } catch {
      // A copy that could not be reported is lost; the program is never told either way.
    }
    this.deliverFrames(session, session.outputFramer.push(bytes))
  }

  private deliverFrames(session: LiveSession, frames: readonly TerminalFrame[]): void {
    for (const frame of frames) {
      if (!session.outputQueue) this.retainUndeliveredFrames(session, [frame])
      else if (session.undeliveredOutput.length === 0) session.outputQueue.enqueue(frame)
      else {
        // Activation is still replaying the backlog into this view. The frame follows it
        // there untrimmed, so the view's stream stays contiguous; the queue bounds it.
        session.undeliveredOutput.push(frame)
        session.undeliveredOutputState.bufferedBytes += frame.bytes.byteLength
      }
    }
  }

  private async onPtyExit(session: LiveSession, exit: IncarnationExit): Promise<void> {
    if (session.exited) return session.exitComplete
    session.exited = true
    session.lifecycleSubscription?.dispose()
    // The program is gone; its modes go with it, so nothing stale can reach a later view.
    session.decsetModes.clear()
    session.mirror?.dispose()
    session.mirror = undefined
    this.onSessionStateChange({
      kind: 'session-process-state-changed',
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      state: 'exited'
    })
    const pendingFrames = session.outputFramer.flush()
    const outputQueue = session.outputQueue
    this.deliverFrames(session, pendingFrames)
    if (outputQueue) await outputQueue.whenPublished()
    const lifecycleCause = session.stopCause && session.stopCause !== 'explicit'
      ? session.stopCause
      : undefined
    const lifecycleDetail = lifecycleCause
      ? lifecycleStopDetail(lifecycleCause, exit)
      : undefined
    if (session.attachmentId && session.outputQueue === outputQueue) {
      this.sendTerminalMessage(lifecycleCause
        ? {
            kind: 'terminal-exit',
            state: 'interrupted',
            attachmentId: session.attachmentId,
            cause: lifecycleCause,
            exitCode: exit.exitCode,
            ...(exit.signal === undefined ? {} : { signal: exit.signal })
          }
        : {
            kind: 'terminal-exit',
            state: 'exited',
            attachmentId: session.attachmentId,
            exitCode: exit.exitCode,
            ...(exit.signal === undefined ? {} : { signal: exit.signal })
          })
    }
    this.revokeAttachment(session)
    this.removeIfCurrent(session)
    try {
      await session.recordReady
      await Promise.all([
        lifecycleDetail
          ? this.store.markInterrupted(session.incarnationId, lifecycleDetail)
          : this.store.markExited(session.incarnationId, exit),
        this.savedOutputStore?.markProcessState(
          session,
          lifecycleDetail ? 'interrupted' : 'exited'
        )
      ])
    } catch {
      // A failed starting record has nothing to transition; the process is still removed from live state.
    } finally {
      session.resolveExit()
    }
  }

  private waitForExit(session: LiveSession, timeoutMs: number): Promise<boolean> {
    if (session.exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      void session.exitComplete.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private async markInterrupted(session: LiveSession, reason: string): Promise<void> {
    if (session.exited) return session.exitComplete
    session.exitUnconfirmed = true
    this.onSessionStateChange({
      kind: 'session-process-state-changed',
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      state: 'exit-unconfirmed'
    })
    if (session.conversationReservation?.live === session) {
      session.conversationReservation.state = 'exit-unconfirmed'
    }
    if (session.attachmentId) {
      this.sendTerminalMessage({
        kind: 'terminal-exit',
        state: 'interrupted',
        attachmentId: session.attachmentId,
        cause: 'unobserved-loss',
        reason: reason.slice(0, 240)
      })
    }
    this.revokeAttachment(session)
    try {
      await session.recordReady
      await Promise.all([
        this.store.markInterrupted(session.incarnationId, reason),
        this.savedOutputStore?.markProcessState(session, 'interrupted')
      ])
    } catch {
      // The in-memory exit-unconfirmed tombstone remains authoritative for this app run.
    }
  }

  private revokeAttachment(
    session: LiveSession,
    transition?: HostOutputQueueTransition
  ): void {
    if (!transition && session.outputQueue) {
      session.outputQueue.close([], (returned) => {
        this.revokeAttachment(session, returned)
      })
      return
    }
    const returned = transition
    delete session.outputQueue
    delete session.attachmentId
    if (!returned) return
    if (returned.unsentFrames.length > 0) {
      session.undeliveredOutput = [
        ...returned.unsentFrames,
        ...session.undeliveredOutput
      ]
      session.undeliveredOutputState.bufferedBytes += returned.unsentFrames.reduce(
        (total, frame) => total + frame.bytes.byteLength,
        0
      )
    }
    if (returned.discardedPartialFrameBytes > 0) {
      session.undeliveredOutputState.droppedBytes += returned.discardedPartialFrameBytes
      session.undeliveredOutputState.truncated = true
    }
    this.trimUndeliveredFrames(session)
  }

  private removeIfCurrent(target: LiveSession | ConversationReservation): void {
    if ('pty' in target) {
      if (this.sessions.get(target.sessionId) !== target) return
      this.sessions.delete(target.sessionId)
      const reservation = target.conversationReservation
      if (
        reservation?.live === target &&
        this.conversationReservations.get(reservation.conversationIdentity) === reservation
      ) {
        this.conversationReservations.delete(reservation.conversationIdentity)
      }
      return
    }
    if (
      !target.live &&
      this.conversationReservations.get(target.conversationIdentity) === target
    ) {
      this.conversationReservations.delete(target.conversationIdentity)
    }
  }

  private retainUndeliveredFrames(session: LiveSession, frames: readonly TerminalFrame[]): void {
    for (const frame of frames) {
      session.undeliveredOutput.push(frame)
      session.undeliveredOutputState.bufferedBytes += frame.bytes.byteLength
    }
    this.trimUndeliveredFrames(session)
  }

  private trimUndeliveredFrames(session: LiveSession): void {
    // A later view starts where its first frame lets a fresh parser start; see HostOutputQueue.
    while (
      session.undeliveredOutputState.bufferedBytes > session.undeliveredOutputState.limitBytes &&
      session.undeliveredOutput.length > 0
    ) {
      const dropped = session.undeliveredOutput.shift()!
      session.undeliveredOutputState.bufferedBytes -= dropped.bytes.byteLength
      session.undeliveredOutputState.droppedBytes += dropped.bytes.byteLength
      session.undeliveredOutputState.truncated = true
    }
  }
}
