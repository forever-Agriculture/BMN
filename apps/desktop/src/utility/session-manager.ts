import { randomUUID } from 'node:crypto'
import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { kill as signalProcessByPid } from 'node:process'
import {
  ERROR_CODES,
  MAX_TERMINAL_CHUNK_BYTES,
  TERMINAL_UNDELIVERED_OUTPUT_BYTES,
  TERMINAL_SAVED_OUTPUT_BYTES,
  TERMINAL_SCROLLBACK_LINES,
  SAVED_OUTPUT_FORMAT_VERSION,
  TERMINAL_SAVED_OUTPUT_RETENTION,
  lifecycleStopDetail,
  lifecycleStopSource,
  type BackgroundChoice,
  type BoundConversationBinding,
  type ConversationBindingState,
  type ExplicitConversationBinding,
  type PersistedConversationBinding,
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
  type SessionResumeParams,
  type SessionResumeResult,
  type SessionStopCause,
  type SessionProcessStateChangedMessage,
  type TerminalAckMessage,
  type TerminalActivationResult,
  type TerminalInputMessage,
  type TerminalPortMessage,
  type WorkspaceRecord
} from '@ai-terminal/protocol'
import { HostOutputQueue, type HostOutputQueueTransition } from './transport'
import { TerminalByteFramer } from './terminal-byte-framer'
import {
  agentCli,
  applyCapturedLaunchEnvironment,
  buildNativeResumeLaunch,
  conversationIdentity,
  conversationReferenceExists,
  parseBoundBinding,
  parseClaudeHelpOptionGrammar,
  prepareConversationLaunch,
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

export interface PtyLike {
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
  processStartIdentity: string
  startedAt: string
  binding: PersistedConversationBinding
}

export interface CreateResumingRecord {
  sessionId: string
  incarnationId: string
  processStartIdentity: string
  startedAt: string
}

/** The manager's store also owns stored-session reads, so resume gates on the persisted record. */
export interface SessionStore extends StoredSessionReader {
  createStarting(record: CreateStartingRecord): Promise<void>
  createResuming(record: CreateResumingRecord): Promise<void>
  getConversationBinding(sessionId: string): Promise<PersistedConversationBinding | undefined>
  replaceConversationBinding(
    binding: ExplicitConversationBinding
  ): Promise<PersistedConversationBinding>
  clearConversationBinding(sessionId: string): Promise<boolean>
  markRunning(incarnationId: string): Promise<void>
  markExited(incarnationId: string, exit: IncarnationExit): Promise<void>
  markInterrupted(incarnationId: string, reason: string): Promise<void>
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
  capabilityProbeTimeoutMs?: number
  onSessionStateChange?: (message: SessionProcessStateChangedMessage) => void
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
  dataSubscription?: Disposable
  exitSubscription?: Disposable
  cwd: string
  executable: string
  captureStartedAt: string
  attachmentId?: string
  outputQueue?: HostOutputQueue
  outputFramer: TerminalByteFramer
  undeliveredOutput: Uint8Array[]
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
  state: ConversationReservationState
  live?: LiveSession
}

const CAPABILITY_PROBE_OUTPUT_BYTES = 256 * 1024
const SHELL_ENVIRONMENT_PRIVATE_PREFIXES = [
  'ELECTRON_',
  'CHROME_',
  'CHROMIUM_',
  'AITERM_',
  // Identity of whichever terminal launched the app; shells here run in AI-Terminal's xterm, not there.
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
  'LC_TERMINAL_VERSION'
])

export function buildShellEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): Record<string, string | undefined> {
  const shellEnvironment: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (
      SHELL_ENVIRONMENT_PRIVATE_KEYS.has(key) ||
      SHELL_ENVIRONMENT_PRIVATE_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      continue
    }
    shellEnvironment[key] = value
  }
  shellEnvironment.TERM = 'xterm-256color'
  // xterm renders 24-bit color; without this Claude Code and Codex quantize their colors to the 256-color palette.
  shellEnvironment.COLORTERM = 'truecolor'
  return shellEnvironment
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

export interface StoredSessionReader {
  listWorkspaces(includeArchived: boolean): Promise<readonly WorkspaceRecord[]>
  listSessions(workspaceId: string): Promise<readonly SessionRecord[]>
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

async function linuxProcessStartIdentity(pid: number): Promise<string> {
  const processStat = await readFile(`/proc/${pid}/stat`, 'utf8')
  const commandEnd = processStat.lastIndexOf(')')
  const fieldsAfterCommand = processStat.slice(commandEnd + 2).trim().split(/\s+/)
  const startTicks = fieldsAfterCommand[19]
  if (!startTicks) throw new Error('process start ticks are unavailable')
  return `linux-proc-start:${startTicks}`
}

/** Expands a leading ~ or ~/ the way a shell would, so a folder typed as ~/code/app launches; other paths are unchanged. */
export function resolveHomeDirectory(path: string, home: string = homedir()): string {
  if (path !== '~' && !path.startsWith('~/')) return path
  return resolve(join(home, path.slice(1)))
}

export async function validateLaunch(params: PtyLaunchParams): Promise<void> {
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
    const executableInfo = await stat(params.executable)
    if (!executableInfo.isFile()) throw new Error('not a file')
    await access(params.executable, constants.X_OK)
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
  private readonly homeDirectory: string
  private readonly sessionEnvironment:
    | ((identity: SessionIdentity) => Readonly<Record<string, string>>)
    | undefined
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
  private readonly capabilityProbeTimeoutMs: number
  private readonly onSessionStateChange: (message: SessionProcessStateChangedMessage) => void
  private readonly claudeSessionIdCapabilities = new Map<string, Promise<ClaudeCapabilityProbeResult>>()
  private readonly conversationBindings = new Map<string, PersistedConversationBinding>()
  private readonly conversationReservations = new Map<string, ConversationReservation>()
  /** Sessions with a Start again or Resume between its checks and its process being tracked. */
  private readonly launchingSessions = new Set<string>()

  constructor(options: SessionManagerOptions) {
    this.store = options.store
    this.spawnPty = options.spawnPty
    this.identifyProcess = options.processStartIdentity ?? linuxProcessStartIdentity
    this.sendTerminalMessage = options.sendTerminalMessage
    this.environment = options.environment ?? process.env
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.sessionEnvironment = options.sessionEnvironment
    this.signalProcess = options.signalProcess ?? signalProcessByPid
    this.stopGraceMs = options.stopGraceMs ?? 2_000
    this.stopKillWaitMs = options.stopKillWaitMs ?? 2_000
    this.undeliveredOutputLimitBytes =
      options.undeliveredOutputLimitBytes ?? TERMINAL_UNDELIVERED_OUTPUT_BYTES
    this.savedOutputStore = options.savedOutputStore
    this.outputQueueLimits = options.outputQueueLimits
    this.referenceExists = options.conversationReferenceExists ?? conversationReferenceExists
    this.capabilityProbeTimeoutMs = options.capabilityProbeTimeoutMs ?? 2_000
    this.onSessionStateChange = options.onSessionStateChange ?? (() => undefined)
  }

  async create(
    requested: CreateSessionParams
  ): Promise<SessionIdentity & { binding: PersistedConversationBinding }> {
    const params = { ...requested, cwd: resolveHomeDirectory(requested.cwd, this.homeDirectory) }
    if (!params.workspaceId || !params.name.trim() || params.name.length > 120) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Session workspace and name are invalid')
    }
    await validateLaunch(params)
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
    const reservation = bindingIdentity ? this.claimConversation(bindingIdentity) : undefined
    const live = await this.startIncarnation(
      sessionId,
      {
        ...params,
        executable: prepared.executable,
        argv: prepared.argv
      },
      this.environment,
      captureStartedAt,
      (record) => this.store.createStarting({
        ...record,
        workspaceId: params.workspaceId,
        name: params.name.trim(),
        cwd: params.cwd,
        executable: params.executable,
        argv: params.argv,
        backgroundChoice: params.backgroundChoice ?? null,
        binding: prepared.binding
      }),
      prepared.injectedArguments,
      reservation
    )
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
   * The complete stored-session gate runs before any binding lookup or launch: a session that is
   * not stored is NOT_FOUND, and stored launch metadata that cannot be used is IO_ERROR with its
   * actionable reason.
   */
  async resume(params: SessionResumeParams): Promise<SessionResumeResult> {
    const stored = await findStoredSession(this.store, params.sessionId)
    if (!stored) {
      throw new HostControlError(ERROR_CODES.notFound, 'The session was not found')
    }
    if (stored.launchDisabledReason) {
      throw new HostControlError(ERROR_CODES.ioError, stored.launchDisabledReason)
    }
    const knownBinding = this.conversationBindings.get(params.sessionId)
    return knownBinding
      ? this.resumeBinding(params, knownBinding)
      : this.loadBindingAndResume(params)
  }

  /**
   * Runs a stopped session's saved command again in a new process. Nothing is injected, so an agent
   * CLI starts a fresh conversation and the stored conversation binding is left for Resume.
   */
  async relaunch(params: SessionResumeParams): Promise<AttachmentIdentity> {
    const stored = await findStoredSession(this.store, params.sessionId)
    if (!stored) {
      throw new HostControlError(ERROR_CODES.notFound, 'The session was not found')
    }
    if (stored.launchDisabledReason) {
      throw new HostControlError(ERROR_CODES.ioError, stored.launchDisabledReason)
    }
    const releaseLaunch = this.claimSessionLaunch(params.sessionId)
    try {
      const launchParams: PtyLaunchParams = {
        cwd: stored.cwd,
        executable: stored.executable,
        argv: [...stored.argv],
        cols: params.cols,
        rows: params.rows
      }
      await validateLaunch(launchParams)
      const live = await this.startIncarnation(
        params.sessionId,
        launchParams,
        this.environment,
        new Date().toISOString(),
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

  private async loadBindingAndResume(params: SessionResumeParams): Promise<SessionResumeResult> {
    const stored = await this.store.getConversationBinding(params.sessionId)
    const binding = stored ? parseBoundBinding(stored) : undefined
    if (!binding) {
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        'No conversation binding was captured for this session'
      )
    }
    this.conversationBindings.set(params.sessionId, binding)
    return this.resumeBinding(params, binding)
  }

  private resumeBinding(
    params: SessionResumeParams,
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
      reservation = this.claimConversation(bindingIdentity)
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

  private async resumeOnce(
    params: SessionResumeParams,
    binding: BoundConversationBinding,
    reservation: ConversationReservation
  ): Promise<SessionResumeResult> {
    if (!await this.referenceExists(binding)) {
      throw new HostControlError(
        ERROR_CODES.notFound,
        `The bound ${binding.agentCli} conversation reference is missing; no process was started`
      )
    }
    const resumeEnvironment = applyCapturedLaunchEnvironment(
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
        resumeEnvironment
      )
      if (!capability.supported || !capability.grammar) {
        throw new HostControlError(
          ERROR_CODES.invalidArgument,
          `The stored Claude launch context cannot be re-admitted: ${capability.detail}`
        )
      }
      claudeGrammar = capability.grammar
    }
    let launch
    try {
      launch = buildNativeResumeLaunch(binding, claudeGrammar)
    } catch (error) {
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        error instanceof Error ? error.message : 'The stored launch context is unsupported'
      )
    }
    const launchParams: PtyLaunchParams = {
      cwd: launch.cwd,
      executable: launch.executable,
      argv: launch.argv,
      cols: params.cols,
      rows: params.rows
    }
    await validateLaunch(launchParams)
    const startedAt = new Date().toISOString()
    const live = await this.startIncarnation(
      params.sessionId,
      launchParams,
      resumeEnvironment,
      startedAt,
      (record) => this.store.createResuming(record),
      binding.agentCli === 'claude' ? ['--resume'] : ['resume'],
      reservation
    )
    try {
      return {
        ...this.attach(live),
        binding
      }
    } catch (error) {
      await this.teardownSession(live)
      throw error
    }
  }

  private async startIncarnation(
    sessionId: string,
    params: PtyLaunchParams,
    environment: Readonly<Record<string, string | undefined>>,
    captureStartedAt: string,
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
        `${error instanceof Error ? error.message : 'The shell process could not be started'}. AI Terminal injected ${injectedArguments.join(', ')} for exact conversation binding.`
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
      cwd: params.cwd,
      executable: params.executable,
      captureStartedAt,
      outputFramer: new TerminalByteFramer(),
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

    try {
      live.processStartIdentity = await this.identifyProcess(pty.pid)
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
            : `The shell process exited before startup completed after AI Terminal injected ${injectedArguments.join(', ')} for exact conversation binding`
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

  spawnValidatedPty(
    params: PtyLaunchParams,
    environment: Readonly<Record<string, string | undefined>> = this.environment,
    identity?: SessionIdentity
  ): PtyLike {
    try {
      return this.spawnPty(params.executable, params.argv, {
        cwd: params.cwd,
        cols: params.cols,
        rows: params.rows,
        env: {
          ...buildShellEnvironment(environment),
          ...(identity ? this.sessionEnvironment?.(identity) : undefined)
        }
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
      captureStartedAt: session.captureStartedAt
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
    session.outputQueue = new HostOutputQueue({
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
    const buffered = session.undeliveredOutput
    const disclosure = {
      limitBytes: session.undeliveredOutputState.limitBytes,
      droppedBytes: session.undeliveredOutputState.droppedBytes,
      truncated: session.undeliveredOutputState.truncated
    }
    session.undeliveredOutput = []
    session.undeliveredOutputState = {
      limitBytes: this.undeliveredOutputLimitBytes,
      bufferedBytes: 0,
      droppedBytes: 0,
      truncated: false
    }
    for (const bytes of buffered) session.outputQueue?.enqueue(bytes)
    return { activated: true, undeliveredOutput: disclosure }
  }

  /** The incarnation the host currently holds live for a session, if any. */
  liveIncarnationId(sessionId: string): string | undefined {
    const live = this.sessions.get(sessionId)
    return live && !live.exited ? live.incarnationId : undefined
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
    return { cols: session.pty.cols, rows: session.pty.rows }
  }

  detach(params: { attachmentId: string }): void {
    this.revokeAttachment(this.byAttachment(params.attachmentId))
  }

  rendererDisconnected(): void {
    for (const session of this.sessions.values()) {
      if (session.attachmentId) this.revokeAttachment(session)
    }
  }

  abandonForHostLossSelfTest(): void {
    for (const session of this.sessions.values()) {
      if (session.attachmentId) this.revokeAttachment(session)
      session.dataSubscription?.dispose()
      session.exitSubscription?.dispose()
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
        'The shell stop outcome is still unknown. Fix: restart AI Terminal before reusing this session.',
        true
      )
    }
    const reason = await this.teardownSession(session)
    if (!reason) return
    throw new HostControlError(
      ERROR_CODES.ioError,
      `The shell stop outcome is unknown: ${reason}. Fix: restart AI Terminal before reusing this session.`,
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
    const current = this.sessions.get(sessionId)
    if (current?.exitUnconfirmed) {
      throw new HostControlError(
        ERROR_CODES.invalidArgument,
        'The previous process of this session has not confirmed its exit; restart AI Terminal before starting it again'
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

  private claimConversation(conversationIdentity: string): ConversationReservation {
    const existing = this.conversationReservations.get(conversationIdentity)
    if (!existing) {
      const reservation: ConversationReservation = { conversationIdentity, state: 'resuming' }
      this.conversationReservations.set(conversationIdentity, reservation)
      return reservation
    }
    throw new HostControlError(
      ERROR_CODES.invalidArgument,
      existing.state === 'exit-unconfirmed'
        ? 'The bound conversation has an exit-unconfirmed process incarnation; restart AI Terminal before resuming it'
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
    try {
      session.pty.kill()
    } catch {
      // Identity verification and the bounded force-kill path below remain authoritative.
    }
    if (await this.waitForExit(session, this.stopGraceMs)) return undefined

    let identityStillMatches = false
    try {
      identityStillMatches =
        session.processStartIdentity.length > 0 &&
        (await this.identifyProcess(session.pty.pid)) === session.processStartIdentity
    } catch {
      // The OS process may have disappeared before node-pty delivered its exit event.
    }
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
    const frames = session.outputFramer.push(bytes)
    if (session.outputQueue) {
      for (const frame of frames) session.outputQueue.enqueue(frame)
      return
    }
    this.retainUndeliveredFrames(session, frames)
  }

  private async onPtyExit(session: LiveSession, exit: IncarnationExit): Promise<void> {
    if (session.exited) return session.exitComplete
    session.exited = true
    this.onSessionStateChange({
      kind: 'session-process-state-changed',
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      state: 'exited'
    })
    const pendingFrames = session.outputFramer.flush()
    const outputQueue = session.outputQueue
    if (outputQueue) {
      for (const frame of pendingFrames) outputQueue.enqueue(frame)
      await outputQueue.whenPublished()
    } else {
      this.retainUndeliveredFrames(session, pendingFrames)
    }
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
        (total, frame) => total + frame.byteLength,
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

  private retainUndeliveredFrames(session: LiveSession, frames: readonly Uint8Array[]): void {
    for (const frame of frames) {
      session.undeliveredOutput.push(frame)
      session.undeliveredOutputState.bufferedBytes += frame.byteLength
    }
    this.trimUndeliveredFrames(session)
  }

  private trimUndeliveredFrames(session: LiveSession): void {
    while (
      session.undeliveredOutputState.bufferedBytes > session.undeliveredOutputState.limitBytes &&
      session.undeliveredOutput.length > 0
    ) {
      const dropped = session.undeliveredOutput.shift()!
      session.undeliveredOutputState.bufferedBytes -= dropped.byteLength
      session.undeliveredOutputState.droppedBytes += dropped.byteLength
      session.undeliveredOutputState.truncated = true
    }
  }
}
