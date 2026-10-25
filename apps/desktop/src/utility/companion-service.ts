// MODULE: companion-service.ts - host-side artifacts, attention, progress, drafts, settings, control socket, Telegram and backup
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import {
  ERROR_CODES,
  pushPolicyStatus,
  agentStartBrief,
  type PushLevel,
  type PushPolicyChange,
  type PushPolicyView,
  DEFAULT_TELEGRAM_QUIET_HOURS,
  type TelegramQuietHours,
  exactAbsoluteFileReference,
  HOOK_EVENT_LOG_LIMIT,
  isAttentionOrigin,
  retiredOriginApp,
  hasDisallowedHandoffControl,
  sessionHandoffFileText,
  sessionHandoffPointer,
  hasControlOrFormatCharacter,
  METHOD_REGISTRY,
  countryFlag,
  modelOrigin,
  PROGRESS_STALE_AFTER_MS,
  TERMINAL_NOTICE_BODY_MAX,
  TERMINAL_NOTICE_CODES,
  TERMINAL_NOTICE_TITLE_MAX,
  TERMINAL_NOTICE_WINDOW_MS,
  terminalNoticeOrigin,
  isCompactionEvent,
  USAGE_NOTICE_PERCENT,
  usageClock,
  usagePercent,
  usageWindowName,
  type AppEventMessage,
  type AppEventTopic,
  AGENT_HISTORY_KEEP_DAYS,
  type AgentHistoryKeepDays,
  type AppSettings,
  type AwayChange,
  type AwayChangeResult,
  type AwayRecord,
  agentAwayView,
  AWAY_QUESTION_REFUSAL,
  awayTelegramWaiting,
  awayTelegramWentOn,
  AWAY_SUMMARY_LIMITS,
  AWAY_NOTE_LIMIT,
  AWAY_REFUSED_QUESTION_TOOLS,
  effectiveAway,
  ownerAwayView,
  parseAwayRecord,
  EMPTY_GRANT_RECORD,
  grantStatus,
  grantStatusLines,
  grantedRepositoryActions,
  openGrantPeriod,
  ownerGrantView,
  type GrantAnswerResult,
  type GrantRead,
  type GrantedRepositoryAction,
  type OwnerGrantView,
  type ArtifactPreview,
  type ArtifactRecord,
  type AttentionEvidence,
  type AttentionPrompt,
  type AttentionProducer,
  type ManualChoices,
  type AttentionRecord,
  type BackupExportResult,
  type BackupManifest,
  type BackupManifestEntry,
  type BackupVerifyResult,
  type ControlInfo,
  type HookCompaction,
  type HookEventEffect,
  type HookObservation,
  type HookOriginRecord,
  type HookEventAgent,
  type HookEventRecord,
  type InputDraftRecord,
  type FileReferencePasteReceipt,
  type FileReferenceSearchResult,
  type ProgressRecord,
  type SessionAgentNow,
  type SessionRecord,
  type TelegramStatus,
  type TerminalNoticeCode,
  type SessionPorts,
  type SessionUsage,
  type UsageAgent,
  type UsageReading,
  type GuardReport,
  type GuardStop,
  TURN_FILES_LIMIT,
  TURN_LIST_LIMIT,
  TURN_MARK_LIMIT_MS,
  TURN_SWITCH_FOLDER,
  type TurnDetailAnswer,
  type TurnDifferenceAnswer,
  type TurnFileView,
  type TurnSessionView
} from '@bmn/protocol'
import {
  ArtifactFileError,
  ArtifactFileStore,
  artifactLinksRoot,
  artifactOriginalsRoot,
  type InstalledOriginal
} from './artifact-files'
import { ControlAuth, writeOwnerToken, type ControlScope } from './control-auth'
import { HookEventHistory } from './hook-event-history'
import { LiveProducers } from './live-producers'
import { ControlError, ControlServer, type ReceiptRecord } from './control-server'
import type { DatabaseWorkerClient } from './database-client'
import type { SendOutcome } from './database-message-store'
import type { ApplicationRoots } from './roots'
import { HostControlError, invalidHostControl as invalid, type SessionIdentity, type SessionManager } from './session-manager'
import { codexRolloutPath } from './conversation-binding'
import { readCodexUsage } from './codex-usage'
import { searchFileReferences } from './file-reference-search'
import { PAGE_AFTER_MS, createAttentionPager } from './attention-pager'
import { observeTelegramDelivery, type TelegramDeliveryEvent } from './telegram-delivery'
import { RemoteAnswers, answerRoute, type AnswerOutcome, type AnswerRequest, type PluginAnswer, type PromptDeadline } from './remote-answer'
import { observeRepeat, ownerTurn, REPEAT_NOTICE_AT, type RepeatState, type RepeatSegment } from './repeat-watch'
import { TelegramCardKeeper } from './telegram-card-keeper'
import { GRANT_TOKEN_PREFIX, GRANT_TYPED_REPLY, TelegramGrantCards } from './telegram-grant-cards'
import { QUIET_LEDGER_KEY, QuietHoursDelivery, phoneField } from './quiet-hours-delivery'
import { DEFAULT_TELEGRAM_HEALTH_ALERTS, DEFAULT_TELEGRAM_MORNING_DIGEST, telegramQuietWindow, type TelegramHealthAlerts, type TelegramMorningDigest } from '@bmn/protocol'
import { DIGEST_KEY, DevAutoMorningDigest } from './dev-auto-digest'
import { HEALTH_ALERTS_KEY, HealthAlerts } from './health-alerts'
import { readMachineHealth, type HealthReaderOptions } from './machine-health'
import { readDevAutoRuns } from './dev-auto-runs'
import { pushPolicyView, systemPolicyReader, type PolicyReader } from './push-policy-listing'
import { manualCardFits } from './telegram-cards'
import { createScanMemory, procReader, scanSessionPorts, type ProcReader } from './listening-ports'
import { PortWatch } from './port-watch'
import { AGENT_HISTORY_STATE_KEY, AgentHistory, readHistoryState, type AgentHistoryAdapter } from './agent-history'
import { TelegramConnector, TelegramConnectorError, maskToken, redactToken, type ConnectorHealth, type InboundReply } from './telegram-connector'
import { TELEGRAM_HELP_TEXT, awayReplyText, backReplyText, telegramAwayCommand, telegramOtherCommand, type TelegramAwayCommand } from './telegram-away'
import { SessionMessages, type MessageDestination } from './session-messages'
import { AgentBriefs } from './agent-briefs'
import { AwayNotices } from './agent-away-notices'
import { AwayWake } from './away-wake'
import { GrantDepartureNotices } from './agent-grant-notices'
import { foregroundProcessFolder } from './foreground-process'
import type { TurnChangesPort, TurnStoreKeeper } from './turn-changes-engine'
import { TurnRecorder, turnPausesFile } from './turn-changes-recorder'
import { readAppVersion } from './turn-changes-version'
import { turnFileView, turnSummary, turnUnavailable } from './turn-changes-view'

/** A listed session plus its conversation route; `null` when the session has no stored binding. */
type ListedSession = SessionRecord & {
  conversation: { status: string; captureRoute: string } | null
}

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024
const PREVIEW_TEXT_BYTES = 256 * 1024
const TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024
const TELEGRAM_TOKEN_FILE = 'telegram-bot.token'
const TELEGRAM_OFFSET_KEY = 'telegram.offset'
const ATTENTION_SWEEP_MS = 30_000
/** How often a read for the Turn changes dialog is asked while prompts' scans keep stopping it (Story 69.5). */
const TURN_READ_ATTEMPTS = 3
const MESSAGE_SWEEP_EVERY_MS = 60 * 60_000
/** How often a busy Codex run's session file is reread for plan use (Story 37.2). */
const CODEX_USAGE_READ_EVERY_MS = 15_000
/**
 * Two readings of one window whose reset times lie this close are one reset period: a product assumption
 * (docs/usage-sources.md). Across the owner's 200 newest Codex session files, one period's reset moved by
 * at most 10 s; Claude's was not followed over time. A window is at least five hours long, so one account's
 * periods never fall this close; with no account identity, two accounts whose resets do share one notice.
 */
const USAGE_PERIOD_TOLERANCE_MS = 10 * 60_000
/** The first history run waits this long after start, so restored sessions launch first. */
const HISTORY_FIRST_RUN_DELAY_MS = 30_000
const REMOTE_ANSWER_RESOLUTION = 'Answered from Telegram'
/** The refusal log is trimmed back to half this size as soon as one append carries it past. */
const REFUSAL_LOG_BYTES = 256 * 1024
/** One refusal reason on one line; longer than this is a validator quoting the caller, not a reason. */
const REFUSAL_REASON_CHARACTERS = 500

/** Every control character becomes a space, so one refused request can never write two log lines. */
function flattenRefusalReason(reason: string): string {
  let flattened = ''
  for (const character of reason.slice(0, REFUSAL_REASON_CHARACTERS)) {
    const code = character.codePointAt(0) ?? 0
    flattened += code === 0x7f || code < 0x20 ? ' ' : character
  }
  return flattened
}
const HANDOFF_TEXT_BYTES = 16 * 1024
const HANDOFF_PAYLOAD_BYTES = 64 * 1024
const HANDOFF_ARTIFACTS = 10
const TEXT_MEDIA = /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml|toml))/

export const UNROUTED = Symbol('unrouted')

interface CompanionServiceOptions {
  database: DatabaseWorkerClient
  manager: SessionManager
  roots: ApplicationRoots
  cliPath: string
  emit(message: AppEventMessage): void
  fetch?: typeof fetch
  /** The Bot API origin; only the self-test host sets it, to a local fake. */
  telegramApiOrigin?: string
  /** Agents whose sessions the history limit prunes (Story 31.2); none means Claude folders only. */
  historyAdapters?: readonly AgentHistoryAdapter[]
  /** The owner's home, where `~/.claude` lives; the self-test points it at a scratch folder. */
  home?: string
  /** Epic 69: the thread that scans and compares work trees. Without it no turn is recorded. */
  turnChanges?: TurnChangesPort & Pick<TurnStoreKeeper, 'removeCaptures'>
  /** Epic 69: reads an app's version from a foreground process; a test gives its own. */
  turnVersion?: (identity: string, app: string) => string | null | Promise<string | null>
  /** Epic 69: the folder Linux reports for a foreground process; a test gives its own. */
  turnForegroundFolder?: (identity: string) => string | null
  /** How long a question or permission waits before it is paged; only the self-test host shortens it. */
  pageAfterMs?: number
  now?: () => Date
  /** Where port scans read /proc; tests hand it a fixture tree. */
  proc?: ProcReader
  /** Where the health watch reads sensors; tests and the self-test host hand it a fixture tree. */
  health?: HealthReaderOptions
  /**
   * Epic 66: the two answers about a message that only the app's entry point may give, because nothing of the
   * owner's team is read in this process (R60-NFR3): the Git root a folder belongs to, by the prompt guard's
   * rule, and whether a receiving agent's provider may see a sender's work. Without them a send and a hook's
   * hand-over are refused; the owner's Paste needs neither.
   */
  messageSourceRoot?: (folder: string) => Promise<string> | string
  messageProviderAnswer?: (destination: MessageDestination, senderRoot: string) => Promise<{ allowed: boolean; reason: string }> | { allowed: boolean; reason: string }
  /** Story 83.3: whether the rules master carries the push policy's pointer, answered by the entry point; without it, null (not in force). */
  policyPointer?: () => Promise<boolean | null>
  /** Story 83.3: the git and gh reads Health's policy listing needs; tests give their own. */
  policyReader?: PolicyReader
  /** Story 90.6: a test-mode host shortens the Away wake-up's 2 hours and 15 minutes. */
  awayWake?: { everyMs?: number; quietMs?: number }
}

function text(params: Record<string, unknown>, key: string, max = 4096): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid(`${key} must be text`)
  return value
}

function optionalText(params: Record<string, unknown>, key: string): string | null {
  const value = params[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') invalid(`${key} must be text`)
  return value
}

/** Where a page of a turn's files starts: at the first file when nothing is said, else at a whole number of pages. */
function turnFilesFrom(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value % TURN_FILES_LIMIT !== 0) invalid(`${key} must be where a page starts`)
  return value
}

/** Paste text as one bracketed paste; the end marker is removed from the payload so it cannot close the paste early. */
function bracketedPaste(payload: string, submit: boolean): Uint8Array {
  const safe = payload.split(BRACKETED_PASTE_END).join('')
  return new TextEncoder().encode(`${BRACKETED_PASTE_START}${safe}${BRACKETED_PASTE_END}${submit ? '\r' : ''}`)
}

function fileError(error: unknown): never {
  if (error instanceof ArtifactFileError) {
    const code = error.code === 'missing' || error.code === 'source-missing'
      ? ERROR_CODES.notFound
      : error.code === 'io-error' || error.code === 'disk-full'
        ? ERROR_CODES.ioError
        : ERROR_CODES.invalidArgument
    throw new HostControlError(code, error.message)
  }
  throw error
}

function toControlError(error: unknown): never {
  if (error instanceof HostControlError) throw new ControlError(error.code, error.message, error.retryable)
  if (error instanceof ArtifactFileError) {
    try {
      fileError(error)
    } catch (mapped) {
      toControlError(mapped)
    }
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error instanceof Error) {
    const code = Object.values(ERROR_CODES).find((value) => value === error.code)
    if (code) throw new ControlError(code, error.message)
  }
  throw error
}

async function sha256File(path: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash('sha256')
  let byteLength = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
    byteLength += (chunk as Buffer).byteLength
  }
  return { sha256: hash.digest('hex'), byteLength }
}

function backupArtifactFile(artifact: ArtifactRecord): string {
  return join('artifacts', artifact.sha256.slice(0, 2), artifact.artifactId)
}

function isBackupManifestEntry(value: unknown): value is BackupManifestEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<BackupManifestEntry>
  return typeof entry.file === 'string' && entry.file.length > 0 &&
    typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256) &&
    typeof entry.byteLength === 'number' && Number.isSafeInteger(entry.byteLength) && entry.byteLength >= 0
}

function isBackupManifest(value: unknown): value is BackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const manifest = value as Partial<BackupManifest>
  if (
    manifest.formatVersion !== 1 ||
    typeof manifest.createdAt !== 'string' ||
    !isBackupManifestEntry(manifest.database) ||
    !Array.isArray(manifest.artifacts) ||
    !Array.isArray(manifest.excluded) ||
    !manifest.excluded.every((item) => typeof item === 'string')
  ) return false
  const artifactIds = new Set<string>()
  for (const entry of manifest.artifacts) {
    if (!isBackupManifestEntry(entry)) return false
    const artifactId = (entry as { artifactId?: unknown }).artifactId
    if (typeof artifactId !== 'string' || artifactId.length === 0 || artifactIds.has(artifactId)) return false
    artifactIds.add(artifactId)
  }
  return true
}

function linkExtension(record: ArtifactRecord): string {
  const fromName = extname(record.originalName)
  if (/^\.[A-Za-z0-9]{1,8}$/.test(fromName)) return fromName.toLowerCase()
  const byType: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt'
  }
  return byType[record.mediaType] ?? ''
}

/** sockaddr_un.sun_path holds 108 bytes on Linux, including the terminator. */
const MAX_SOCKET_PATH_BYTES = 107

export class CompanionService {
  readonly auth = new ControlAuth()
  readonly socketPath: string
  /** Where a refused agent request and its reason are written, for the owner to read. */
  readonly refusalLogPath: string
  private readonly telegramDeliveryLogPath: string
  private readonly files: ArtifactFileStore
  private readonly control: ControlServer
  private readonly knownSessions = new Map<string, SessionRecord>()
  private controlListening = false
  private controlDetail = 'The control socket has not started'
  private telegram: TelegramConnector | undefined
  private telegramToken: string | null = null
  private telegramHealth: ConnectorHealth | undefined
  /** Overlapping polling reports share stale-card cleanup before any recovery pages are flushed. */
  private telegramRecovery: Promise<void> | undefined
  /** Story 32.2: one more for every connector state change, kept across restarts; with `telegramHost`, names an entry. */
  private telegramStateEntry = 0
  private readonly telegramHost = randomUUID()
  private telegramDetail = 'Telegram is off'
  private sweepTimer: NodeJS.Timeout | undefined
  /** Story 90.6: while he is Away, the fixed wake line every 2 hours into sessions idle at an empty prompt. */
  private readonly awayWake: AwayWake
  /** Local ports each session's programs listen on, read from /proc on its own cadence (Story 41.1). */
  private readonly ports: PortWatch
  private readonly now: () => Date
  /** Whether the owner is away from the desk by its input, as the app last reported; null while it cannot tell. */
  private measuredAway: boolean | null = null
  /** Story 76.3: what he said (away, back or nothing yet), read before any delivery at start. */
  private awayRecord: AwayRecord = parseAwayRecord(undefined)
  /** Story 84.3: every departure's cards and grants, as last read or written; reads for authority go to the store. */
  private grantRead: GrantRead = { state: 'read', record: EMPTY_GRANT_RECORD }
  private readonly grantNotices: GrantDepartureNotices
  private readonly policyReader: PolicyReader
  private readonly pager: ReturnType<typeof createAttentionPager>
  /** Delivers a phone answer into the dialog that asked; reachable only from inside this process (Epic 30). */
  private readonly answers: RemoteAnswers
  /** The Telegram card of each page, kept true to its request (Story 30.3). */
  private readonly cards: TelegramCardKeeper
  /** Story 84.3: the departure cards on the phone, beside the request cards. */
  private readonly grantCards: TelegramGrantCards
  private readonly draftOperations = new Map<string, Promise<void>>()
  private readonly telegramReplyOperations = new Map<string, Promise<void>>()
  /** A request key claims the one PTY write before any asynchronous availability check. */
  private readonly fileReferencePastes = new Map<string, {
    fingerprint: string
    result: Promise<FileReferencePasteReceipt>
    settled: boolean
  }>()
  private readonly fileReferenceSearches = new Map<string, { requestId: string; controller: AbortController }>()
  private fileReferenceAvailabilityEpoch = 0
  private fileReferenceAvailabilityChanges = 0
  /** A host archive/move request announces itself before its first await, invalidating in-flight pastes. */
  beginFileReferenceAvailabilityChange(): () => void {
    this.fileReferenceAvailabilityEpoch += 1
    this.fileReferenceAvailabilityChanges += 1
    let finished = false
    return () => {
      if (finished) return
      finished = true
      this.fileReferenceAvailabilityChanges -= 1
    }
  }

  private ensureFileReferenceAvailabilityUnchanged(epoch: number): void {
    if (this.fileReferenceAvailabilityEpoch !== epoch || this.fileReferenceAvailabilityChanges > 0) {
      throw new HostControlError(ERROR_CODES.revisionConflict,
        'An archive or move request overlapped delivery; choose the destination again')
    }
  }
  /** The last `HOOK_EVENT_LOG_LIMIT` hook events per session, in memory only; a restart clears them. */
  private readonly hookEvents = new Map<string, HookEventRecord[]>()
  private readonly retainedHooks: HookEventHistory
  /**
   * The incarnation of each session whose harness has reported a hook of its own. It is kept apart
   * from `hookEvents` on purpose: that log is bounded at 30 entries and is a diagnostic, so reading
   * suppression out of it would let 30 suppressed notices evict the hook and switch suppression off.
   */
  private readonly hookReporters = new Map<string, string>()
  private readonly producers: LiveProducers
  private readonly quietDelivery: QuietHoursDelivery
  private readonly morningDigest: DevAutoMorningDigest
  private digestSettings: TelegramMorningDigest = { ...DEFAULT_TELEGRAM_MORNING_DIGEST }
  private readonly healthAlerts: HealthAlerts
  private healthSettings: TelegramHealthAlerts = { ...DEFAULT_TELEGRAM_HEALTH_ALERTS }
  private quietSettings: TelegramQuietHours = { ...DEFAULT_TELEGRAM_QUIET_HOURS }
  private telegramReady = false
  private readonly manualAnswerClaims = new Set<string>()
  private readonly attentionChanges = new Map<string, { generation: number; pending: number }>()
  /**
   * The latest harness event each session's current run has actually reported, with its receipt
   * time. Kept apart from `hookEvents` because that log is bounded at 30 entries: terminal notices
   * can evict the very event this summary is about, and the summary must still name it.
   */
  private readonly hookObservations = new Map<string, {
    sessionId: string
    incarnationId: string
    agent: Exclude<HookEventAgent, 'terminal'>
    event: string
    /** `subagent` for an OpenCode child's event, `interrupted` for the owner's stop of an OpenCode run (Story 93.3). */
    source: string | null
    observedAt: string
    /** The terminal's foreground process when the report came, which is the agent's own (Story 75.4); null once it ended. */
    foreground: string | null
  }>()
  /**
   * The model origin each session's current run last reported: the maker's country with the model
   * name and API host behind it, classified here by the protocol's one table. In memory only, like
   * the observation it accompanies, so a restart of BMN starts empty and the next hook refills it.
   */
  private readonly hookOrigins = new Map<string, HookOriginRecord>()
  /**
   * The compactions each session's current run has reported (Story 36.1). Kept apart from the
   * bounded log for the same reason as the observation, and in memory only: information, never an ask.
   */
  private readonly hookCompactions = new Map<string, HookCompaction & { incarnationId: string }>()
  /**
   * Plan use (Story 37.2): each session's latest reading from its current run, and each agent's latest
   * reading that named plan windows, because a plan belongs to the account rather than the session.
   * In memory only, so a restart shows no reading until the agent reports again.
   */
  private readonly usageReadings = new Map<string, UsageReading>()
  /**
   * Story 60.8: what each session's prompt guard last stopped or warned about. Memory only and for
   * the reporting run: it never reaches the database, a Backup export, Telegram or a notification.
   */
  private readonly guardStops = new Map<string, GuardStop>()
  /** Epic 69: what brackets turns, and the sessions it was last told of. Null when this host scans nothing. */
  private readonly turns: TurnRecorder | null
  private turnSessions = new Set<string>()
  private readonly planReadings = new Map<UsageAgent, UsageReading>()
  /** The 90% notice decisions, one at a time (Story 37.2). */
  private usageNoticeQueue: Promise<void> = Promise.resolve()
  /** Each Codex session's last read of its own file, so a busy run is not reread on every tool call. */
  private readonly codexUsageReads = new Map<string, {
    at: number
    running: Promise<void> | null
    /** The one read that follows the running one for every finished turn that arrived during it. */
    again: Promise<void> | null
  }>()
  /** The terminal notice each session has open, so a burst becomes more lines and not more rows. */
  private readonly terminalNotices = new Map<string, {
    requestId: string
    requestKey: string
    incarnationId: string
    title: string
    openedAt: number
    lines: string[]
  }>()
  /** One notice at a time per session: two arriving together must not each open their own row. */
  private readonly noticeOperations = new Map<string, Promise<unknown>>()
  private readonly repeatStates = new Map<string, RepeatState>()
  /** The one history limit for every agent (Stories 31.1, 31.2). */
  private readonly history: AgentHistory
  /** Epic 66: messages the sessions of one workspace leave each other. */
  private readonly messages: SessionMessages
  private readonly briefs: AgentBriefs
  private readonly awayNotices: AwayNotices
  private lastMessageSweepAt = 0
  /** Each bounded log has its own serialized append queue. */
  private repeatWrites: Promise<void> = Promise.resolve()
  private refusalWrites: Promise<void> = Promise.resolve()
  private awayWakeWrites: Promise<void> = Promise.resolve()
  private telegramDeliveryWrites: Promise<void> = Promise.resolve()

  constructor(private readonly options: CompanionServiceOptions) {
    this.policyReader = options.policyReader ?? systemPolicyReader(options.policyPointer ?? (async () => null))
    this.retainedHooks = new HookEventHistory({ root: options.roots.state,
      sessionExists: sessionId => this.knownSessions.has(sessionId), live: () => this.liveHookEvents() })
    this.now = options.now ?? (() => new Date())
    this.awayWake = new AwayWake({
      ...options.awayWake,
      now: () => this.now(),
      away: () => this.awayRecord,
      observations: () => this.hookObservations.values(),
      observation: (sessionId) => this.hookObservations.get(sessionId),
      openAttention: async () => (await options.database.companion('listAttention')).filter((row) => row.state === 'open'),
      liveIncarnation: (sessionId) => options.manager.liveIncarnationId(sessionId),
      foreground: (sessionId) => options.manager.foregroundProcessIdentity(sessionId),
      generation: (sessionId) => this.attentionChanges.get(sessionId) ?? { generation: 0, pending: 0 },
      screen: async (sessionId, incarnationId) => {
        const mirror = options.manager.runningScreenMirror(sessionId, incarnationId)
        if (!mirror) return null
        await mirror.settled()
        return { lines: mirror.undimmedLines(), cursor: mirror.cursor() }
      },
      write: (sessionId, text) => options.manager.writeToSession(sessionId, bracketedPaste(text, true)),
      log: (line) => {
        const entry = `${this.iso()} ${line}\n`
        process.stderr.write(`[BMN] ${entry}`)
        this.awayWakeWrites = this.awayWakeWrites
          .then(() => this.appendBoundedLog(join(options.roots.state, 'away-wake.log'), entry))
          .catch(() => undefined)
      }
    })
    this.quietDelivery = new QuietHoursDelivery({
      read: () => options.database.companion('getRawSetting', QUIET_LEDGER_KEY),
      write: (value, changes) => options.database.companion('commitQuietDelivery', value, changes ?? {}, this.iso()),
      settings: () => this.quietSettings,
      now: () => this.now(), ownerAway: () => this.ownerAway(),
      ready: () => this.telegramReady && this.telegramHealth?.state === 'polling',
      requests: () => options.database.companion('listQuietAttention'),
      retire: record => this.pager.retire(record),
      current: async id => {
        try { return await options.database.companion('getAttention', id) }
        catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === ERROR_CODES.notFound) return null
          throw error
        }
      },
      mapped: (id, revision) => options.database.companion('quietDelivered', id, revision),
      sessionName: id => this.knownSessions.get(id)?.name ?? 'Session',
      home: options.home ?? homedir(),
      sendSummary: async text => { await this.telegram!.sendMessage(text) },
      page: record => this.cards.page(record),
      changed: () => this.emit('telegram', null)
    })
    this.morningDigest = new DevAutoMorningDigest({
      read: () => options.database.companion('getRawSetting', DIGEST_KEY),
      write: value => options.database.companion('putRawSetting', DIGEST_KEY, value, this.iso()),
      settings: () => this.digestSettings,
      ready: () => this.telegramHealth?.state === 'polling',
      quiet: () => telegramQuietWindow(this.now(), this.quietSettings).active,
      now: () => this.now(), monotonic: () => performance.now(), home: options.home ?? homedir(),
      snapshot: async () => {
        const workspaces = await options.database.listWorkspaces()
        const sessions = (await Promise.all(workspaces.filter(workspace => workspace.archivedAt === null)
          .map(workspace => options.database.listSessions(workspace.workspaceId)))).flat()
          .map(session => options.manager.sessionWithCurrentProcessState(session))
        const liveDirectories = new Map(sessions.flatMap(session => {
          const directory = options.manager.liveLaunchDirectory(session.sessionId)
          return directory ? [[session.sessionId, directory] as const] : []
        }))
        const result = await readDevAutoRuns(workspaces, sessions, await options.database.companion('listAttention'), undefined,
          value => phoneField(value, options.home ?? homedir(), Infinity), liveDirectories)
        return { result, workspaceNames: Object.fromEntries(workspaces.map(workspace => [workspace.workspaceId, workspace.name])) }
      },
      send: async text => { await this.telegram!.sendMessage(text) }
    })
    this.healthAlerts = new HealthAlerts({
      read: () => options.database.companion('getRawSetting', HEALTH_ALERTS_KEY),
      write: value => options.database.companion('putRawSetting', HEALTH_ALERTS_KEY, value, this.iso()),
      settings: () => this.healthSettings,
      ready: () => this.telegram !== undefined && this.telegramHealth?.state === 'polling',
      now: () => this.now(),
      // An injected clock (tests, the self-test host) also paces the checks.
      monotonic: () => options.now ? this.now().getTime() : performance.now(),
      host: () => hostname(),
      check: () => readMachineHealth(options.health),
      // Health alerts are sent at once, also in quiet hours: a fire warning that waits is useless.
      send: async html => { await this.telegram!.sendMessage(html, { html: true }) },
      turnOff: async state => {
        // One step in the store: the saved switch and the watch's state change together, and a save the
        // owner makes at the same moment is not overwritten with an older copy of the section.
        await options.database.companion('switchHealthAlertsOff', HEALTH_ALERTS_KEY, state, this.iso())
        this.healthSettings = { ...DEFAULT_TELEGRAM_HEALTH_ALERTS }
        this.emit('settings', null)
      }
    })
    const proc = options.proc ?? procReader
    const uid = process.getuid?.() ?? -1
    const scanMemory = createScanMemory()
    this.ports = new PortWatch({
      scan: (sessionIds) => scanSessionPorts(proc, sessionIds, uid, scanMemory),
      knownSessionIds: () => new Set(this.knownSessions.keys()),
      liveSessionIds: () => options.manager.liveSessionIds(),
      changed: () => this.emit('ports', null)
    })
    this.pager = createAttentionPager({
      current: (requestId) => this.attentionForDelivery(requestId),
      send: (record) => this.cards.page(record),
      holdQuiet: record => this.quietDelivery.hold(record),
      schedule: (callback, ms) => {
        const timer = setTimeout(callback, ms)
        timer.unref()
        return () => clearTimeout(timer)
      },
      ownerAway: () => this.ownerAway(),
      // Story 78.5: once he said he is away, a permission goes out with no wait of BMN's own.
      saidAway: () => this.awayRecord.state === 'away',
      now: () => this.now().getTime(),
      observeDelivery: (event) => this.logTelegramDelivery(event),
      ...(options.pageAfterMs !== undefined
        ? { pageAfterMs: { ...PAGE_AFTER_MS, question: options.pageAfterMs, permission: options.pageAfterMs } }
        : {})
    })
    this.history = new AgentHistory({
      home: options.home ?? homedir(),
      adapters: options.historyAdapters ?? [],
      readSettings: async () => (await options.database.companion('getSettings')).agentHistory,
      writeSettings: async (next) => {
        await options.database.companion('putSettingsSection', 'agentHistory', next, this.iso())
      },
      readState: async () => readHistoryState(await options.database.companion('getRawSetting', AGENT_HISTORY_STATE_KEY)),
      writeState: (next) => options.database.companion('putRawSetting', AGENT_HISTORY_STATE_KEY, next, this.iso()),
      liveConversationIds: () => this.liveConversationIds(),
      now: () => this.now(),
      log: (line) => process.stderr.write(line),
      changed: () => this.emit('settings', null)
    })
    this.briefs = new AgentBriefs({
      liveIncarnationId: (sessionId) => options.manager.liveIncarnationId(sessionId),
      now: () => this.now().getTime()
    })
    this.awayNotices = new AwayNotices({
      liveIncarnationId: (sessionId) => options.manager.liveIncarnationId(sessionId),
      now: () => this.now(),
      save: (entries) => options.database.companion('putAwayNotices', entries, this.iso())
    })
    this.grantNotices = new GrantDepartureNotices({
      now: () => this.now(),
      mark: async (periodId, sessionId) => {
        const result = await options.database.companion('markGrantTold', periodId, sessionId, this.iso())
        if (result.outcome === 'changed') this.grantChanged({ state: 'read', record: result.record })
      }
    })
    this.messages = new SessionMessages({
      database: options.database,
      liveIncarnationId: (sessionId) => options.manager.liveIncarnationId(sessionId),
      session: async (sessionId) => {
        await this.sessionsChanged()
        return this.knownSessions.get(sessionId)
      },
      foreground: (sessionId) => this.sessionForeground(sessionId),
      notice: async (p) => {
        await this.openAttention({
          sessionId: p.sessionId, incarnationId: p.incarnationId, requestKey: p.requestKey, kind: 'notice',
          origin: 'watch:messages', title: p.title.slice(0, TERMINAL_NOTICE_TITLE_MAX), body: p.body
        })
      },
      changed: () => this.emit('messages', null),
      now: () => this.now(),
      sourceRoot: options.messageSourceRoot ?? (() => Promise.reject(new Error('The app does not answer for a folder\'s repository'))),
      providerAnswer: options.messageProviderAnswer ?? (() => Promise.reject(new Error('The app does not answer for the approved team'))),
      confirmedKeepDays: async () => (await options.database.companion('getSettings')).agentHistory.confirmedKeepDays
    })
    this.producers = new LiveProducers((sessionId) => options.manager.liveIncarnationId(sessionId),
      process.platform === 'linux' ? (sessionId) => options.manager.foregroundProcessIdentity(sessionId) : undefined)
    this.answers = new RemoteAnswers({
      getAttention: (requestId) => options.database.companion('getAttention', requestId).catch(() => null),
      liveIncarnationId: (sessionId) => options.manager.liveIncarnationId(sessionId),
      producerCurrent: (record) => this.nativeProducerCurrent(record) && !this.requestExpired(record),
      screen: (sessionId, incarnationId) => options.manager.screenMirror(sessionId, incarnationId),
      write: (sessionId, bytes) => options.manager.writeToSession(sessionId, bytes),
      submitMessage: (record, request, text, current, markWritten) =>
        this.submitTelegramAnswerMessage(record, request, text, current, markWritten),
      answerPermissions: async () => (await options.database.companion('getSettings')).telegram.answerPermissions,
      countdownChanged: (sessionId) => this.cards.changed(sessionId),
      now: () => this.now().getTime()
    })
    this.cards = new TelegramCardKeeper({
      connector: () => this.telegram && this.telegramHealth?.state === 'polling' ? this.telegram : undefined,
      getAttention: (requestId) => this.attentionForDelivery(requestId),
      header: (sessionId, record) => {
        const origin = this.hookOrigins.get(sessionId)
        const live = origin !== undefined && origin.incarnationId === options.manager.liveIncarnationId(sessionId)
        return {
          session: this.knownSessions.get(sessionId)?.name ?? 'Session',
          // A request a retired app opened before its retirement still names it (Epic 71).
          agent: live ? origin.agent : record?.prompt?.harness ?? retiredOriginApp(record?.openedBy ?? null),
          flag: live && origin.country ? countryFlag(origin.country) : null
        }
      },
      answerability: (record) => this.answerability(record),
      deadline: (record) => record.state === 'open' && record.prompt?.type === 'permission' && record.prompt.harness === 'claude'
        ? deadlineLine(this.answers.deadline(record, this.now().getTime())) : null,
      answerEpoch: (requestId) => this.answerEpoch(requestId),
      liveIncarnationId: (sessionId) => options.manager.liveIncarnationId(sessionId),
      answer: (request) => this.answerAttention(request),
      acknowledge: async (record) => {
        if (record.kind !== 'notice') invalid('Only an informational update can be acknowledged')
        await options.database.companion('closeAttention', {
          requestId: record.requestId, expectedKind: 'notice', expectedRevision: record.revision
        }, 'answered', 'Update acknowledged from Telegram; no terminal input sent', this.iso(), 'telegram')
        this.emit('attention', record.sessionId)
      },
      store: {
        put: (card) => options.database.companion('putTelegramCard', card, this.iso()),
        update: (messageId, revision, state, card) =>
          options.database.companion('updateTelegramCard', messageId, revision, state, card),
        list: (states) => options.database.companion('listTelegramCards', states),
        message: (messageId, sessionId, requestId, incarnationId) =>
          options.database.companion('putTelegramMessage', messageId, sessionId, requestId, incarnationId, this.iso())
      },
      home: homedir(),
      beforeNewDelivery: async record => {
        const decision = await this.quietDelivery.before(record)
        if (decision.action === 'hold') observeTelegramDelivery(event => this.logTelegramDelivery(event), record, decision.reason ?? 'held-quiet')
        return decision
      },
      maySend: (record, managed) => this.quietDelivery.maySend(record, managed),
      settleNewDelivery: (claim, outcome) => this.quietDelivery.settle(claim, outcome),
      holdExit: (sessionId, incarnationId) => this.quietDelivery.holdExit(sessionId, incarnationId),
      observeDelivery: (event) => this.logTelegramDelivery(event)
    })
    this.answers.onLateOutcome((requestId, outcome) => this.cards.lateOutcome(requestId, outcome))
    this.grantCards = new TelegramGrantCards({
      connector: () => this.telegram && this.telegramHealth?.state === 'polling' ? this.telegram : undefined,
      read: () => this.grantRead,
      header: (run) => ({
        session: run.card.sessionId === null ? 'bmn grant' : this.knownSessions.get(run.card.sessionId)?.name ?? 'Session',
        agent: run.card.agentCli === 'claude' || run.card.agentCli === 'codex' || run.card.agentCli === 'opencode' ? run.card.agentCli : null,
        flag: null
      }),
      ownerAway: () => this.ownerAway(),
      quiet: () => this.quietSettings,
      now: () => this.now(),
      answer: (answer) => this.answerGrant(answer),
      keep: async (periodId, runId, phone) => {
        const result = await options.database.companion('setGrantPhoneMessage', periodId, runId, phone, this.iso())
        if (result.outcome === 'changed') this.grantChanged({ state: 'read', record: result.record })
      }
    })
    this.socketPath = join(options.roots.runtime, 'control', 'control.sock')
    this.turns = options.turnChanges === undefined ? null : new TurnRecorder({
      port: options.turnChanges,
      keeper: options.turnChanges,
      foreground: {
        identity: (sessionId) => options.manager.foregroundProcessIdentity(sessionId),
        folder: options.turnForegroundFolder ?? foregroundProcessFolder
      },
      database: {
        putTurn: (input) => options.database.companion('putTurn', input),
        nextTurnNumber: (sessionId) => options.database.companion('nextTurnNumber', sessionId),
        listUnclosedTurns: () => options.database.companion('listUnclosedTurns')
      },
      version: options.turnVersion ?? ((identity, app) => readAppVersion(identity, app)),
      shared: (sessionId, root) => this.startedInWorkTree(sessionId, root),
      hintFolder: join(dirname(this.socketPath), TURN_SWITCH_FOLDER),
      changed: (sessionId) => this.emit('turns', sessionId),
      now: () => this.now().getTime(),
      pauses: turnPausesFile(join(options.roots.state, 'turn-pauses.json'))
    })
    this.refusalLogPath = join(options.roots.state, 'refused-requests.log')
    this.telegramDeliveryLogPath = join(options.roots.state, 'telegram-delivery.log')
    this.files = new ArtifactFileStore({
      root: artifactOriginalsRoot(options.roots.data),
      stagingRoot: join(options.roots.state, 'artifact-staging'),
      usedBytes: () => options.database.companion('artifactBytesUsed')
    })
    this.control = new ControlServer({
      socketPath: this.socketPath,
      auth: this.auth,
      receipts: {
        get: async (key) => (await options.database.companion('getReceipt', key)) as ReceiptRecord | undefined,
        put: (record) => options.database.companion('putReceipt', record, this.iso())
      },
      handlers: {
        isCurrentIncarnation: (sessionId, incarnationId) =>
          options.manager.liveIncarnationId(sessionId) === incarnationId,
        sessionExists: (sessionId) => this.knownSessions.has(sessionId),
        snapshot: (scope) => this.controlCall(() => this.snapshot(scope)),
        listSessions: (scope) => this.controlCall(async () => this.listedSessions(scope)),
        publishArtifact: (p) => this.controlCall(() => this.publishArtifact(p)),
        reportProgress: (p) => this.controlCall(() => this.reportProgress(p)),
        openAttention: (p) => this.controlCall(async () => {
          // Story 76.4 AC3: while he said away, the blocking question the hook can still refuse opens nothing: no card, no
          // native request; the hook refuses the tool with this reason. An already open dialog is never touched.
          if (p.awayRefusable === true && this.awayRecord.state === 'away' && this.refusableQuestion(p.origin)) {
            return { refused: true, changed: false, reason: AWAY_QUESTION_REFUSAL }
          }
          return this.publicAttention(await this.openAttention(p))
        }),
        prepareHandoff: (p) => this.controlCall(() => this.queueAgentHandoff(p)),
        listPeers: (sessionId) => this.controlCall(() => this.messages.peers(sessionId)),
        sendMessage: (p) => this.controlCall(() => this.messages.send(p)),
        messageStatus: (sessionId, messageId) => this.controlCall(() => this.messages.status(sessionId, messageId)),
        takeMessage: (p) => this.controlCall(() => this.messages.take(p)),
        reportMessage: (p) => this.controlCall(() => this.messages.report(p)),
        // Epic 69: the answer is one status word. Without the scanning thread nothing is recorded.
        markTurn: (p) => this.controlCall(async () => {
          if (this.turns === null) return 'off'
          // A prompt's scan never waits for something the owner only reads: that is stopped and asked again.
          if (p.edge === 'start') for (const read of this.turnReads) read.abort()
          return this.turns.mark(p)
        }),
        dropTurnMark: (sessionId, requestId) => this.turns?.dropped(sessionId, requestId),
        reportRefusal: (method, sessionId, reason) => this.logRefusal(method, sessionId, reason),
        awayStatus: async (scope) => scope.kind === 'owner' ? this.awayForOwner() : this.awayForAgent(),
        policyStatus: async () => ({
          ...pushPolicyStatus(await this.options.database.companion('getPushPolicy'), await this.policyReader.masterHasPointer()),
          granted: await this.grantedActions()
        }),
        awayPrinted: async (p) => ({ recorded: await this.awayNotices.printed(p.sessionId, p.agent, p.conversation, p.claimId) }),
        // Story 76.5: BMN binds the decision to this process's conversation, as its own hook reported it, never the caller's word.
        recordDecision: (p) => this.controlCall(async () => {
          const producer = p.incarnationId === null ? null : this.producers.stamp(p.sessionId, p.incarnationId)
          if (producer === null || p.incarnationId === null) {
            throw new HostControlError(ERROR_CODES.notFound, 'BMN does not know which conversation this process is in; nothing was recorded. Keep the decision in your workflow\'s log and say BMN\'s list may be incomplete')
          }
          const result = await this.options.database.companion('recordDecision', {
            sessionId: p.sessionId, incarnationId: p.incarnationId, key: p.key, payload: p.payload, expectedRevision: p.revision,
            provenance: { agentCli: producer.agentCli, conversation: producer.conversationReference }
          }, this.iso())
          // The record's identity is its session and key; dev-auto keeps both with its entry (Story 76.7 AC2).
          return { outcome: result.outcome, sessionId: result.record.sessionId, key: result.record.key, periodId: result.record.periodId, revision: result.record.revision, recordedAt: result.record.recordedAt }
        }),
        decisionOutcome: (p) => this.controlCall(async () => {
          const result = await this.options.database.companion('addDecisionOutcome', p, this.iso())
          return { outcome: result.outcome, key: result.record.key, outcomes: result.record.outcomes.length }
        }),
        changeAway: (p) => this.controlCall(async () => {
          const result = await this.changeAway({
            to: p.to, source: p.scope.kind === 'owner' ? 'cli' : 'agent',
            ...(p.scope.kind === 'session' ? { agentSessionId: p.scope.sessionId } : {}),
            ...(p.note === undefined ? {} : { note: p.note }),
            ...(p.expectedRevision === undefined ? {} : { expectedRevision: p.expectedRevision }),
            ...(p.operationKey === undefined ? {} : { operationKey: p.operationKey })
          })
          if (result.outcome === 'invalid') throw new HostControlError(ERROR_CODES.invalidArgument, result.reason)
          if (result.outcome === 'stale') {
            throw new HostControlError(ERROR_CODES.revisionConflict, `The away state changed since the revision you saw; it is at revision ${result.record.revision} now; nothing was changed`)
          }
          const view = p.scope.kind === 'owner' ? ownerAwayView(result.record) : agentAwayView(result.record)
          return { outcome: result.outcome, ...view }
        }),
        leaveAway: (p) => this.controlCall(async () => {
          if (p.expectedRevision !== undefined && p.expectedRevision !== this.awayRecord.revision) {
            throw new HostControlError(ERROR_CODES.revisionConflict, `The away state changed since the revision you saw; it is at revision ${this.awayRecord.revision} now; nothing was changed`)
          }
          return this.leaveAway(p.scope.kind === 'owner' ? 'cli' : 'agent', p.scope.kind === 'session' ? p.scope.sessionId : null)
        }),
        askGrant: (p) => this.controlCall(async () => {
          const sessionId = p.scope.kind === 'session' ? p.scope.sessionId : null
          const producer = p.scope.kind === 'session' ? this.producers.stamp(p.scope.sessionId, p.scope.incarnationId) : null
          const result = await this.options.database.companion('askGrantCard', {
            runId: p.runId, sessionId, agentCli: producer?.agentCli ?? null, card: p.card, ...(p.operationKey === undefined ? {} : { operationKey: p.operationKey })
          }, this.iso())
          if (result.outcome === 'no-departure') throw new HostControlError(ERROR_CODES.notFound, `${result.reason}; nothing was asked`)
          if (result.outcome === 'opened' || result.outcome === 'replaced') this.grantChanged({ state: 'read', record: result.record })
          return { outcome: result.outcome, periodId: result.periodId, runId: result.run.runId, cardRevision: result.run.card.revision, state: result.run.card.state }
        }),
        grantStatus: (p) => this.controlCall(async () => this.grantStatusFor(p.scope, p.runId)),
        useGrant: (p) => this.controlCall(async () => {
          const use = p.boundary !== undefined
            ? { runId: p.runId, sessionId: p.sessionId, id: p.useId, kind: 'round' as const, boundary: p.boundary }
            : { runId: p.runId, sessionId: p.sessionId, id: p.useId, kind: 'action' as const, item: p.item ?? '' }
          const result = await this.options.database.companion('useGrantRecord', use, this.iso())
          if (result.outcome !== 'repeated') this.grantChanged({ state: 'read', record: result.record })
          if (result.outcome === 'refused') throw new HostControlError(ERROR_CODES.invalidArgument, `Not recorded: ${result.reason}; the step waits`)
          return { outcome: result.outcome, left: result.left, periodId: result.periodId }
        }),
        reportGrant: (p) => this.controlCall(async () => {
          const result = await this.options.database.companion('reportGrantRecord', p, this.iso())
          // The window's view is this cache; a report it never hears of stays missing there (matrix full-3).
          if (result.outcome === 'recorded') this.grantChanged({ state: 'read', record: result.record })
          if (result.outcome === 'refused') throw new HostControlError(ERROR_CODES.invalidArgument, `Not kept: ${result.reason}`)
          return { outcome: result.outcome }
        }),
        observeConversation: (p) => this.controlCall(async () => {
          if (p.agentCli === 'claude' || p.agentCli === 'codex') {
            const previous = this.producers.stamp(p.sessionId, p.incarnationId)
            const current = this.producers.observe(p.sessionId, p.incarnationId, {
              agentCli: p.agentCli, conversationReference: p.conversationReference
            })
            if (current && current.generation !== previous?.generation) this.emit('attention', p.sessionId)
          } else if (p.incarnationId === options.manager.liveIncarnationId(p.sessionId)) {
            // Observing another supported harness is a conflict for the lightweight Claude/Codex stamp.
            this.producers.unavailable(p.sessionId)
            this.emit('attention', p.sessionId)
          }
          const result = await options.manager.observeConversation(p)
          if (!result.accepted) this.logRefusal('conversation.observe', p.sessionId, result.detail)
          // The window loads a binding when the selection changes; a hook changes it at any time.
          else this.emit('conversations', p.sessionId)
          return result
        }),
        withdrawAttention: (p) => this.controlCall(() => p.requestKey.startsWith('handoff:')
          ? this.withdrawAgentHandoff(p.sessionId, p.requestKey.slice('handoff:'.length))
          : this.closeAttentionByKey(p.sessionId, p.requestKey, 'withdrawn', null, p.origin ?? null, p.evidence, p.producer).then(record => this.publicAttention(record))
        ),
        resolveAttention: (p) => this.controlCall(
          () => this.closeAttentionByKey(p.sessionId, p.requestKey, 'answered', p.resolution, p.origin ?? null, p.evidence, p.producer).then(record => this.publicAttention(record))
        ),
        takeAnswers: (p) => this.controlCall(async (): Promise<{ answers: PluginAnswer[]; waiting?: boolean }> => {
          if (p.requestRef === undefined) return { answers: await this.answers.take(p.sessionId, p.incarnationId, p.waitMs, p.report ?? undefined) }
          // Claude's hook waits only while its request is open here and a phone could answer it (Epic 78).
          const answers = await this.answers.take(p.sessionId, p.incarnationId, await this.phoneMayAnswer() ? p.waitMs : 0, undefined, p.requestRef)
          const waiting = answers.length === 0 && this.answers.hookWanted(p.sessionId, p.incarnationId, p.requestRef) && await this.phoneMayAnswer()
          // The hook leaves on either; an answer tapped after that must not wait for it.
          if (!waiting) this.answers.hookEnded(p.sessionId, p.incarnationId, p.requestRef)
          return { answers, waiting }
        }),
        observeHookEvent: (p) => this.controlCall(async () => {
          const recorded = await this.observeHookEvent(p)
          // Epic 69: a tool that ran, a conversation that started or ended; it moves a turn's record and answers nothing.
          this.turns?.seen(p.sessionId, p.agent)
          if (p.turn !== undefined) this.turns?.observe({ sessionId: p.sessionId, app: p.agent, event: p.event, source: p.source, ...p.turn })
          // Story 76.4: the away state rides beside the brief and a message, on its own rules; its claim is stored first, within
          // its own limit, so the brief below is counted as given only when the answer goes back at once (the final recheck).
          const notice = await this.awayNotices.answer(p, () => this.awayRecord, p.awayLock === true)
          // Epic 66.4: the hook asks for a message only when told one waits, so an ordinary tool call adds nothing.
          const waiting = await this.messages.waiting(p)
          // Story 75.6: BMN's start brief rides in this answer once per conversation and once after a compaction.
          const due = this.briefs.answer(p)
          // Story 83.5: with the push policy's line only while Health allows at least one owner.
          const brief = due === null ? null : agentStartBrief(await this.anyOwnerAllowed())
          // Story 84.3: while he is leaving or away, once per conversation and departure: a run may ask him on one card.
          const departure = this.grantNotices.answer(p, this.grantRead.state === 'read' ? openGrantPeriod(this.grantRead.record) : null)
          return {
            ...recorded, ...(waiting ? { messageWaiting: true } : {}), ...(brief === null ? {} : { brief }),
            ...(notice === null ? {} : { awayNotice: notice.text, awayRevision: notice.revision, awayClaim: notice.claimId }),
            ...(departure === null ? {} : { grantNotice: departure })
          }
        }),
        reportUsage: (p) => this.controlCall(async () => this.recordUsage(p)),
        reportGuard: (p) => this.controlCall(async () => this.recordGuard(p)),
        submitInput: (p) => this.controlCall(async () => {
          this.options.manager.writeToSession(p.sessionId, bracketedPaste(p.text, p.submit))
        }),
        // The window shows the command in Session details and offers Resume with it, so it reloads the record.
        reportResumeCommand: (p) => this.controlCall(async () => {
          const command = await options.manager.reportResumeCommand(p)
          this.emit('conversations', p.sessionId)
          return { recorded: true, ...command }
        }),
        clearResumeCommand: (p) => this.controlCall(async () => {
          const cleared = await options.manager.clearResumeCommand(p)
          this.emit('conversations', p.sessionId)
          return { cleared }
        })
      }
    })
  }

  /**
   * A hook prints nothing and drops what the app answers, so a refused conversation report would
   * otherwise leave no trace at all. The utility's stderr is no help: the main process captures it
   * into a bounded buffer and prints it only if the host dies. So the reason goes to a file the
   * owner can open while BMN runs, newest last, bounded and owner-only. A write that fails leaves
   * only the stderr line, which is written first for exactly that reason.
   */
  private logRefusal(method: string, sessionId: string | null, reason: string): void {
    // One refusal is one line. A validator that names the offending parameter can carry the caller's
    // own bytes into this file, so control characters become spaces and no agent can forge entries.
    const flattened = flattenRefusalReason(reason)
    const line = `${this.iso()} ${method} refused for ${sessionId ?? 'the owner'}: ${flattened}\n`
    process.stderr.write(`[BMN] ${line}`)
    this.refusalWrites = this.refusalWrites
      .then(() => this.appendRefusal(line))
      .catch(() => undefined)
  }

  /**
   * Appends one refusal. The file is trimmed from the front only once it passes its cap, and then
   * back to half of it, so a refused report costs one append and not a rewrite of the whole log.
   */
  private async appendRefusal(line: string): Promise<void> {
    return this.appendBoundedLog(this.refusalLogPath, line)
  }

  /** A bounded, owner-only paging timeline, separate from message text and agent-readable control responses. */
  private logTelegramDelivery(event: TelegramDeliveryEvent): void {
    try {
      const line = `${JSON.stringify({ at: this.iso(), ...event })}\n`
      this.telegramDeliveryWrites = this.telegramDeliveryWrites
        .then(() => this.appendBoundedLog(this.telegramDeliveryLogPath, line))
        .catch(() => undefined)
    } catch { /* Best-effort diagnostics must not change delivery or shutdown. */ }
  }

  private async attentionForDelivery(requestId: string): Promise<AttentionRecord | null> {
    try {
      return await this.options.database.companion('getAttention', requestId)
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === ERROR_CODES.notFound)) {
        this.logTelegramDelivery({ requestId, phase: 'request-read-failed' })
      }
      return null
    }
  }

  private async appendBoundedLog(path: string, line: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await appendFile(path, line, { mode: 0o600 })
    const { size } = await stat(path)
    if (size <= REFUSAL_LOG_BYTES) return
    const written = await readFile(path)
    const kept = written.subarray(written.byteLength - Math.floor(REFUSAL_LOG_BYTES / 2))
    const firstLineBreak = kept.indexOf(0x0a)
    await writeFile(path, firstLineBreak === -1 ? kept : kept.subarray(firstLineBreak + 1), { mode: 0o600 })
  }

  /** The PATH every session's processes see: BMN's CLI first, then BMN's own PATH. */
  sessionPath(): string {
    return [dirname(this.options.cliPath), process.env.PATH ?? '/usr/bin:/bin'].join(':')
  }

  /** Environment for one incarnation: its scoped control credential and the CLI on PATH. */
  sessionEnvironment(identity: SessionIdentity): Record<string, string> {
    const token = this.auth.sessionToken(identity.sessionId, identity.incarnationId)
    return {
      BMN_CONTROL_SOCKET: this.socketPath,
      BMN_TOKEN: token,
      BMN_SESSION_ID: identity.sessionId,
      // Transitional aliases keep existing owner hooks working while docs and new sessions use BMN.
      AITERM_CONTROL_SOCKET: this.socketPath,
      AITERM_TOKEN: token,
      AITERM_SESSION_ID: identity.sessionId,
      BMN_CLI_BIN_DIR: dirname(this.options.cliPath),
      PATH: this.sessionPath()
    }
  }

  async start(): Promise<void> {
    // Story 76.3 (R76-NFR1): the said state is restored before anything at start can deliver.
    this.awayRecord = await this.options.database.companion('getAway')
    this.grantRead = (await this.options.database.companion('getGrants')).read
    this.awayNotices.load(await this.options.database.companion('getAwayNotices'))
    // Epic 69: a turn stored as open has nobody left to end it.
    await this.turns?.start()
    await this.sessionsChanged()
    await this.retainedHooks.load()
    await this.files.reconcileStaging().catch(() => [])
    await this.reconcileArtifacts()
    try {
      await writeOwnerToken(dirname(this.socketPath), this.auth.ownerToken)
      await this.control.listen()
      this.controlListening = true
      this.controlDetail = 'Agents and the bmn CLI can reach this app'
    } catch (error) {
      // The kernel caps a Unix socket path and reports only EINVAL, so name the real cause.
      const tooLong = Buffer.byteLength(this.socketPath) > MAX_SOCKET_PATH_BYTES
      this.controlDetail = tooLong
        ? `The control socket is unavailable: its path is longer than ${MAX_SOCKET_PATH_BYTES} bytes (${this.socketPath}); use a shorter runtime directory`
        : `The control socket is unavailable: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`
    }
    this.sweepTimer = setInterval(() => void this.sweepAttention(), ATTENTION_SWEEP_MS)
    this.sweepTimer.unref()
    this.ports.start()
    // Telegram's first network check must never delay terminal startup.
    void this.restartTelegram().catch(() => undefined)
    // After the archive purge (it ran before this service existed), and late enough not to compete with launches.
    this.history.startSchedule(HISTORY_FIRST_RUN_DELAY_MS)
  }

  /**
   * Conversation references bound to a session whose process runs now, or held by a Resume or start still
   * under way; the history runner never deletes these.
   */
  private async liveConversationIds(): Promise<Set<string>> {
    const ids = new Set<string>(this.options.manager.heldConversationReferences())
    for (const sessionId of this.options.manager.liveSessionIds()) {
      const binding = await this.options.database.getConversationBinding(sessionId).catch(() => undefined)
      if (binding?.status === 'bound' && binding.conversationReference) ids.add(binding.conversationReference)
    }
    return ids
  }

  async close(): Promise<void> {
    this.history.stop()
    this.ports.stop()
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.pager.close()
    this.cards.dispose()
    this.grantCards.dispose()
    this.answers.dispose()
    await Promise.allSettled([this.control.close(), this.telegram?.stop(), this.retainedHooks.close()])
    await unlink(join(dirname(this.socketPath), 'owner.token')).catch(() => undefined)
  }

  /** Every chunk a session's program writes: it paces the port scan and may bring it forward. */
  sessionOutput(sessionId: string, bytes: Uint8Array): void {
    this.ports.output(sessionId, bytes)
  }

  /** Called for every session process transition so exit notices and the session cache stay current. */
  sessionStateChanged(sessionId: string, state: string): void {
    if (state === 'exited') this.turns?.sessionEnded(sessionId)
    void this.sessionsChanged().then(async () => {
      if (state !== 'exited') return
      const settings = await this.options.database.companion('getSettings')
      if (!settings.telegram.enabled || settings.telegram.notifyOn !== 'attention-and-exit') return
      if (this.ownerAway() === false) return
      if (await this.quietDelivery.holdExit(sessionId, this.options.manager.liveIncarnationId(sessionId) ?? null)) return
      await this.cards.exited(sessionId)
    }).catch(() => undefined)
  }

  /** Routes renderer-facing methods; returns UNROUTED for methods this service does not own. */
  async route(method: string, params: Record<string, unknown>): Promise<unknown> {
    const database = this.options.database
    switch (method) {
      case METHOD_REGISTRY.artifactList:
        return database.companion('listArtifacts', optionalText(params, 'sessionId'))
      case METHOD_REGISTRY.artifactImport: {
        const path = text(params, 'path')
        if (!isAbsolute(path)) invalid('The file path must be absolute')
        return this.recordImport(
          await this.files.importFile(path, { artifactId: randomUUID() }).catch(fileError),
          { sessionId: text(params, 'sessionId'), direction: 'input', source: 'owner', sourcePath: path }
        )
      }
      case METHOD_REGISTRY.artifactImportBytes: {
        const bytes = params.bytes
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) invalid('Image bytes are required')
        const installed = await this.files
          .importBytes(bytes, { artifactId: randomUUID(), originalName: text(params, 'name', 255) })
          .catch(fileError)
        return this.recordImport(installed, {
          sessionId: text(params, 'sessionId'), direction: 'input', source: 'owner', sourcePath: null
        })
      }
      case METHOD_REGISTRY.artifactSaveAs: {
        const artifact = await this.readyArtifact(text(params, 'artifactId'))
        const destination = text(params, 'destinationPath')
        if (!isAbsolute(destination)) invalid('The destination must be an absolute path')
        return this.files
          .saveAs(artifact.storedPath, artifact.sha256, destination, { overwrite: params.overwrite === true })
          .catch(async (error: unknown) => {
            await this.markDamaged(artifact, error)
            fileError(error)
          })
      }
      case METHOD_REGISTRY.artifactPreview:
        return this.preview(text(params, 'artifactId'))
      case METHOD_REGISTRY.artifactDeliver:
        return this.deliver(text(params, 'artifactId'), text(params, 'sessionId'), optionalText(params, 'expectedIncarnationId'))
      case METHOD_REGISTRY.fileReferencePaste:
        return this.pasteFileReference(params)
      case METHOD_REGISTRY.fileReferenceSearch:
        return this.searchFileReferences(params)
      case METHOD_REGISTRY.fileReferenceSearchCancel: {
        const ownerId = text(params, 'ownerId', 128)
        const requestId = text(params, 'requestId', 128)
        const active = this.fileReferenceSearches.get(ownerId)
        if (active?.requestId === requestId) active.controller.abort()
        return { cancelled: true }
      }
      case METHOD_REGISTRY.attentionList:
        await this.refreshHandoffStaleness()
        return database.companion('listAttention')
      case METHOD_REGISTRY.hookEventsList:
        // Read-only and scoped to one session; the log never reaches `state.snapshot` or another session.
        if (params.includeHistory === true) {
          await this.sessionsChanged()
          const sessionId = text(params, 'sessionId')
          if (!this.knownSessions.has(sessionId)) throw new HostControlError(ERROR_CODES.notFound, 'The session was not found')
          return { events: this.listHookEvents(sessionId), earlier: this.retainedHooks.history(sessionId),
            historyUnavailable: this.retainedHooks.unavailable }
        }
        return this.listHookEvents(text(params, 'sessionId'))
      case METHOD_REGISTRY.hookObservationGet:
        // Read-only and scoped to one session's run; no other session's observation reaches this answer.
        return this.hookObservation(text(params, 'sessionId'), optionalText(params, 'incarnationId') ?? undefined)
      case METHOD_REGISTRY.usageGet:
        // Read-only and scoped to one session's current run; a Codex run's own file is read first when due.
        return this.sessionUsage(text(params, 'sessionId'))
      case METHOD_REGISTRY.usageList:
        // The latest plan reading per agent: the plan is the account's, so any session's reading speaks for it.
        return [...this.planReadings.values()]
      case METHOD_REGISTRY.guardList:
        // Only what a live run reported: a session started again answers for itself.
        return [...this.guardStops.values()].filter((stop) => this.options.manager.liveIncarnationId(stop.sessionId) === stop.incarnationId) satisfies GuardStop[]
      case METHOD_REGISTRY.guardKeep: {
        const stop = this.guardStops.get(text(params, 'sessionId'))
        if (stop !== undefined && !stop.kept) {
          this.guardStops.set(stop.sessionId, { ...stop, kept: true })
          this.emit('guard', stop.sessionId)
        }
        return { kept: stop !== undefined }
      }
      case METHOD_REGISTRY.guardClear: {
        const sessionId = text(params, 'sessionId')
        const cleared = this.guardStops.delete(sessionId)
        if (cleared) this.emit('guard', sessionId)
        return { cleared }
      }
      case METHOD_REGISTRY.turnChangesState:
        // Epic 69: where recording stands per session, with its latest kept turn. These four reads are for the
        // window only; they reach no snapshot, token or phone, and the control socket has no method for them.
        return await this.turnViews()
      case METHOD_REGISTRY.turnChangesList:
        return (await this.options.database.companion('listTurns', { sessionId: text(params, 'sessionId'), limit: TURN_LIST_LIMIT })).map(turnSummary)
      case METHOD_REGISTRY.turnChangesTurn:
        return await this.turnDetail(text(params, 'sessionId'), text(params, 'turnId'), turnFilesFrom(params, 'from'))
      case METHOD_REGISTRY.turnChangesDifference:
        return await this.turnDifference(text(params, 'sessionId'), text(params, 'turnId'), text(params, 'path'))
      case METHOD_REGISTRY.portsList:
        // Read-only: what the last scan found, with a stopped session's leftovers marked. Nothing here reads /proc.
        return this.ports.list() satisfies SessionPorts[]
      case METHOD_REGISTRY.setupHookEvidence: {
        if (Object.keys(params).length !== 0) invalid('Hook evidence takes no parameters')
        await this.sessionsChanged()
        const observed = this.retainedHooks.observedAgent('codex')
        return { codex: observed === true ? 'observed' : observed === false ? 'not-observed' : 'unavailable' }
      }
      case METHOD_REGISTRY.hookOriginsList:
        // Read-only: each session's own latest origin, never another session's facts beside it.
        return [...this.hookOrigins.values()]
      case METHOD_REGISTRY.attentionTerminalNotice: {
        // Only the owner's own window reaches this switch, and only it can see a session's output,
        // so a session token has no way in: the control socket has no method for this at all.
        const sessionId = text(params, 'sessionId')
        if (!this.knownSessions.has(sessionId)) invalid('The session is unknown')
        const incarnationId = text(params, 'incarnationId')
        const code = params.code
        if (!(TERMINAL_NOTICE_CODES as readonly unknown[]).includes(code)) {
          invalid('The notification sequence is not one BMN reads')
        }
        // A sequence from a process that has already gone must not speak for the one that replaced it.
        if (this.options.manager.liveIncarnationId(sessionId) !== incarnationId) {
          invalid('The session is running a different process now')
        }
        const body = optionalText(params, 'body')
        return this.terminalNotice({
          sessionId,
          incarnationId,
          code: code as TerminalNoticeCode,
          title: text(params, 'title', TERMINAL_NOTICE_TITLE_MAX),
          ...(body === null || body === '' ? {} : { body: body.slice(0, TERMINAL_NOTICE_BODY_MAX) })
        })
      }
      case METHOD_REGISTRY.attentionSeen: {
        const record = await database.companion('markAttentionSeen', text(params, 'requestId'), this.iso())
        this.emit('attention', record.sessionId)
        return record
      }
      case METHOD_REGISTRY.attentionResolve: {
        const state = params.state === 'withdrawn' ? 'withdrawn' : 'answered'
        const expectedKind = params.expectedKind
        if (
          expectedKind !== undefined &&
          expectedKind !== 'question' && expectedKind !== 'permission' &&
          expectedKind !== 'review' && expectedKind !== 'notice'
          && expectedKind !== 'handoff'
        ) invalid('The expected attention kind is invalid')
        const expectedRevision = params.expectedRevision
        if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)) {
          invalid('The expected attention revision is invalid')
        }
        const origin = optionalText(params, 'origin')
        if (origin !== null && !isAttentionOrigin(origin)) invalid('The request origin is invalid')
        const requestId = text(params, 'requestId')
        const held = await database.companion('getAttention', requestId)
        this.answers.hookReported(held.sessionId, held.requestKey)
        const record = await this.withAttentionChange(held.sessionId, () => database.companion(
          'closeAttention',
          {
            requestId,
            ...(expectedKind !== undefined ? { expectedKind } : {}),
            ...(expectedRevision !== undefined ? { expectedRevision: Number(expectedRevision) } : {})
          },
          state,
          optionalText(params, 'resolution') ?? 'Acknowledged in BMN',
          this.iso(),
          origin
        ))
        this.emit('attention', record.sessionId)
        return record
      }
      case METHOD_REGISTRY.progressList:
        return database.companion('listProgress')
      case METHOD_REGISTRY.draftList:
        return database.companion('listDrafts')
      case METHOD_REGISTRY.draftRetry:
        return this.retryDraft(text(params, 'draftId'))
      case METHOD_REGISTRY.draftSend:
        return this.sendDraft(
          text(params, 'draftId'),
          params.submit === true,
          optionalText(params, 'expectedIncarnationId'),
          optionalText(params, 'expectedUpdatedAt')
        )
      case METHOD_REGISTRY.draftDiscard: {
        const draftId = text(params, 'draftId')
        return this.withDraft(draftId, async () => {
          const record = await database.companion('discardDraft', draftId, this.iso())
          this.emit('drafts', record.sessionId)
          return record
        })
      }
      case METHOD_REGISTRY.messagesList:
        return this.messages.list(text(params, 'workspaceId'))
      case METHOD_REGISTRY.settingsGet:
        return database.companion('getSettings')
      case METHOD_REGISTRY.settingsPut: {
        const section = text(params, 'section', 32)
        if (section === 'agentHistory') {
          // Only the limit comes from the window; confirmation and learned folders are BMN's own record.
          const value = params.value as { keepDays?: unknown } | null
          const keepDays = value && typeof value === 'object' ? value.keepDays : undefined
          if (!AGENT_HISTORY_KEEP_DAYS.includes(keepDays as AgentHistoryKeepDays)) {
            invalid('Keep agent history must be 10, 30 or 90 days, or Never')
          }
          await this.history.setKeepDays(keepDays as AgentHistoryKeepDays)
          return database.companion('getSettings')
        }
        // A switch-off time is judged against this moment, not against when a running check lets the save through.
        const savedAt = this.now()
        const settings = await database.companion('putSettingsSection', section, params.value, this.iso())
        this.emit('settings', null)
        if (section === 'telegram') await this.restartTelegram(savedAt)
        return settings
      }
      case METHOD_REGISTRY.historyStatus:
        return this.history.status()
      case METHOD_REGISTRY.historyConfirm:
        await this.history.confirm()
        return this.history.status()
      case METHOD_REGISTRY.backupExport:
        return this.exportBackup(text(params, 'directory'))
      case METHOD_REGISTRY.telegramConfigure:
        return this.configureTelegram(params.token)
      case METHOD_REGISTRY.telegramStatus:
        return this.telegramStatus()
      case METHOD_REGISTRY.telegramTest: {
        if (!this.telegram || this.telegramHealth?.state !== 'polling') {
          throw new HostControlError(ERROR_CODES.ioError, 'Telegram is not connected', true)
        }
        await this.telegram.sendMessage('BMN test message. Replies to notifications return to their session.')
        return this.telegramStatus()
      }
      case METHOD_REGISTRY.telegramHealthTest: {
        if (!this.telegram || this.telegramHealth?.state !== 'polling') {
          throw new HostControlError(ERROR_CODES.ioError, 'Telegram is not connected', true)
        }
        await this.healthAlerts.sendTest()
        return this.telegramStatus()
      }
      case METHOD_REGISTRY.presenceSet: {
        const away = params.away
        if (away !== true && away !== false && away !== null) invalid('away must be true, false or null')
        const before = this.ownerAway()
        this.measuredAway = away
        this.presenceChanged(before)
        return { away }
      }
      case METHOD_REGISTRY.awayGet:
        return this.awayForOwner()
      case METHOD_REGISTRY.grantGet:
        return this.grantForOwner()
      case METHOD_REGISTRY.grantAnswer: {
        // Story 84.3 AC2: the window's own answer; the control socket refuses this method for every token.
        const { periodId, runId, cardRevision, choices, operationKey } = params
        if (typeof periodId !== 'string' || typeof runId !== 'string' || !Number.isSafeInteger(cardRevision) || typeof operationKey !== 'string' ||
          typeof choices !== 'object' || choices === null || Array.isArray(choices)) invalid('periodId, runId, cardRevision, choices and operationKey are required')
        const result = await this.answerGrant({
          periodId: periodId as string, runId: runId as string, cardRevision: cardRevision as number, choices: choices as Record<string, unknown>,
          via: 'app', operationKey: `app:${operationKey as string}`
        })
        return { outcome: result.outcome, ...(result.outcome === 'refused' ? { reason: result.reason, detail: result.detail } : {}), view: this.grantForOwner() }
      }
      case METHOD_REGISTRY.awaySet: {
        const to = params.to
        if (to !== 'away' && to !== 'back') invalid('to must be away or back')
        // Back while only leaving is the dialog's Not leaving: it cancels the departure and withdraws its cards (84.3 AC1).
        const result = await this.changeAway({ to, source: 'app', ...(params.note === undefined ? {} : { note: params.note as string | null }) })
        if (result.outcome === 'invalid') invalid(result.reason)
        return ownerAwayView(result.record)
      }
      case METHOD_REGISTRY.policyGet:
        return this.pushPolicyForOwner()
      case METHOD_REGISTRY.policySet: {
        // Story 83.3: only Health, the owner's own surface, reaches this method; the control socket refuses every write.
        const expectedRevision = params.expectedRevision as number
        const change: PushPolicyChange = params.kind === 'owner'
          ? { kind: 'owner', login: params.login as string, allowed: params.allowed as boolean, expectedRevision }
          : params.kind === 'level'
            ? { kind: 'level', repository: params.repository as string, level: params.level as PushLevel, expectedRevision }
            : invalid('kind must be owner or level')
        const result = await this.options.database.companion('changePushPolicy', change, this.iso())
        if (result.outcome === 'invalid') invalid(result.reason)
        if (result.outcome === 'stale') throw new HostControlError(ERROR_CODES.revisionConflict, 'The policy changed since Health read it; read it again')
        if (result.outcome === 'unknown') throw new HostControlError(ERROR_CODES.revisionConflict, `The policy could not be read (${result.reason}); it is left as it is`)
        return this.pushPolicyForOwner()
      }
      case METHOD_REGISTRY.awaySummary: {
        // Story 76.6: the current period, closed or still running; the renderer adds the live requests, asks and dev-auto runs.
        const record = this.awayRecord
        if (record.periodId === null || record.since === null) throw new HostControlError(ERROR_CODES.notFound, 'There is no away period yet')
        const keepDays = await this.history.status().then((status) => status.confirmedKeepDays ?? null).catch(() => null)
        const now = this.iso()
        const until = record.state === 'away' ? null : record.endedAt
        const data = await this.options.database.companion('awaySummaryData', {
          periodId: record.periodId, since: record.since, until, now, keepDays
        })
        const wentOn = await this.options.database.companion('awayWentOn', { since: record.since, until: until ?? now, limit: AWAY_SUMMARY_LIMITS.wentOn })
          .catch(() => null)
        // Story 84.8 [d29]: the long waits he answered himself, up to the period's end (Back) or now while away.
        const answeredWaits = await this.options.database.companion('awayAnsweredWaits', {
          since: record.since, until: until ?? now, limit: AWAY_SUMMARY_LIMITS.answeredWaits, minWaitMs: AWAY_SUMMARY_LIMITS.longWaitMinutes * 60_000
        }).catch(() => null)
        return { away: ownerAwayView(record), ...data, wentOn, answeredWaits }
      }
      case METHOD_REGISTRY.awaySummaryShown: {
        const periodId = params.periodId
        if (typeof periodId !== 'string' || periodId === '') invalid('periodId is required')
        const before = this.awayRecord.summaryShownAt
        this.awayRecord = await this.options.database.companion('markAwaySummaryShown', periodId as string, this.iso())
        if (before !== this.awayRecord.summaryShownAt) this.emit('away', null)
        return this.awayForOwner()
      }
      case METHOD_REGISTRY.controlInfo:
        return {
          socketPath: this.socketPath,
          cliPath: this.options.cliPath,
          listening: this.controlListening,
          detail: this.controlDetail
        } satisfies ControlInfo
      default:
        return UNROUTED
    }
  }

  private iso(): string {
    return this.now().toISOString()
  }

  /**
   * Effective delivery presence (R76-NFR1): away while he said away, otherwise the desk input's true, false or unknown.
   * Paging, quiet-hours release, exit cards and watched sessions all go by this.
   */
  private ownerAway(): boolean | null {
    return effectiveAway(this.awayRecord, this.measuredAway)
  }

  /** The owner turning away, by his words or by the desk input, starts what waited for that; nothing else changes. */
  private presenceChanged(before: boolean | null): void {
    if (before === true || this.ownerAway() !== true) return
    this.pager.ownerLeft()
    void this.quietDelivery.sweep().catch(() => undefined)
    void this.grantCards.reconcile()
  }

  /** Story 76.3: one serialised change of the said state, from any surface; the caller's source decides what it may do. */
  async changeAway(change: Omit<AwayChange, 'periodId'>): Promise<AwayChangeResult> {
    const before = this.ownerAway()
    const result = await this.options.database.companion('changeAway', change, this.iso())
    if (result.outcome === 'changed' || result.record.revision > this.awayRecord.revision) {
      this.awayRecord = result.record
      this.presenceChanged(before)
      this.emit('away', null)
    }
    // Epic 84: Away carried the departure, Back ended its grants, or back while leaving cancelled it.
    if (result.grant !== null) this.grantChanged(result.grant)
    return result
  }

  /** Story 84.3 AC1: his departure words, `bmn away --leaving` or the CLI: a pending departure; the runs are told on their next tool call. */
  private async leaveAway(source: 'cli' | 'agent', agentSessionId: string | null): Promise<unknown> {
    const result = await this.options.database.companion('leaveAway', { source, agentSessionId }, this.iso())
    if (result.outcome === 'changed') this.grantChanged(result.read)
    const open = result.read.state === 'read' ? openGrantPeriod(result.read.record) : null
    return { outcome: result.outcome, state: open?.state ?? this.awayRecord.state, periodId: open?.periodId ?? null, since: open?.startedAt ?? null, revision: this.awayRecord.revision }
  }

  /** Story 84.3 AC2–AC3: the owner's answer from the window or Telegram, the only two callers. */
  private async answerGrant(answer: { periodId: string; runId: string; cardRevision: number; choices: Record<string, unknown>; via: 'app' | 'telegram'; operationKey: string }): Promise<GrantAnswerResult> {
    const result = await this.options.database.companion('answerGrantCard', answer, this.iso())
    // A refused answer is kept too; an unreadable record (reason 'invalid') stays unknown in the cache.
    if (result.outcome === 'granted' || (result.outcome === 'refused' && result.reason !== 'invalid')) this.grantChanged({ state: 'read', record: result.record })
    return result
  }

  private grantChanged(read: GrantRead): void {
    this.grantRead = read
    this.emit('grant', null)
    void this.grantCards.reconcile()
  }

  grantForOwner(): OwnerGrantView {
    return ownerGrantView(this.grantRead)
  }

  /**
   * Story 84.3 AC4: read fresh from the store, never from a handoff or a cache. One run when named (any session may read
   * the run it names); otherwise every run whose latest card this session asked, or all for the owner's token.
   */
  private async grantStatusFor(scope: ControlScope, runId?: string): Promise<unknown> {
    let read: GrantRead
    let away: AwayRecord
    try {
      ({ read, away } = await this.options.database.companion('getGrants'))
    } catch {
      const reason = 'BMN could not read its grant record, so nothing is granted'
      return { departure: null, runs: runId === undefined ? [] : [{ runId, active: false, reason, lines: grantStatusLines(runId, { active: false, reason }) }] }
    }
    const open = read.state === 'read' ? openGrantPeriod(read.record) : null
    const departure = open === null ? null : { periodId: open.periodId, state: open.state, since: open.startedAt }
    const ids = runId !== undefined ? [runId]
      : (open?.runs ?? []).filter((run) => scope.kind === 'owner' || run.card.sessionId === scope.sessionId).map((run) => run.runId)
    return {
      departure,
      runs: ids.map((id) => {
        const status = grantStatus(read, away, id)
        return { runId: id, ...status, lines: grantStatusLines(id, status) }
      })
    }
  }

  /**
   * Story 84.9: the night's granted merges and pushes, for `bmn policy`, where an agent app's own reviewer reads what the owner
   * granted. A record BMN cannot read grants nothing, so it lists none.
   */
  private async grantedActions(): Promise<GrantedRepositoryAction[]> {
    try {
      const { read, away } = await this.options.database.companion('getGrants')
      return grantedRepositoryActions(read, away)
    } catch {
      return []
    }
  }

  /** A blocking question tool of an app whose refusal Story 76.2 measured clean, reported by that app's own PreToolUse. */
  private refusableQuestion(origin: string | undefined): boolean {
    return Object.keys(AWAY_REFUSED_QUESTION_TOOLS).some((agent) => origin === `hook:${agent}:PreToolUse`)
  }

  /** What the owner's surfaces see. */
  /** Story 83.3: Health's view of the push policy, over the folders BMN's sessions work in. */
  private async anyOwnerAllowed(): Promise<boolean> {
    try {
      const read = await this.options.database.companion('getPushPolicy')
      return read.state === 'read' && read.record.owners.some((owner) => owner.allowed)
    } catch {
      return false
    }
  }

  private async pushPolicyForOwner(): Promise<PushPolicyView> {
    const workspaces = (await this.options.database.listWorkspaces()).filter((workspace) => workspace.archivedAt === null)
    const sessions = (await Promise.all(workspaces.map((workspace) => this.options.database.listSessions(workspace.workspaceId)))).flat()
      .filter((session) => session.archivedAt === null)
    const directories = [...workspaces.map((workspace) => workspace.defaultCwd), ...sessions.map((session) => session.cwd),
      ...sessions.flatMap((session) => this.options.manager.liveLaunchDirectory(session.sessionId) ?? [])].filter((cwd): cwd is string => !!cwd)
    return pushPolicyView(await this.options.database.companion('getPushPolicy'), directories, this.policyReader)
  }

  awayForOwner(): ReturnType<typeof ownerAwayView> {
    return ownerAwayView(this.awayRecord)
  }

  /** What an agent sees: state, since, revision. */
  awayForAgent(): ReturnType<typeof agentAwayView> {
    return agentAwayView(this.awayRecord)
  }

  private emit(topic: AppEventTopic, sessionId: string | null): void {
    this.options.emit({ kind: 'app-event', topic, sessionId })
    if (topic === 'attention') this.cards.changed(sessionId)
  }

  /** Owner-window catalogue invalidation; no new agent socket capability. */
  catalogueChanged(): void { this.emit('catalogue', null) }

  private async controlCall<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation()
    } catch (error) {
      return toControlError(error)
    }
  }

  private sessionRefreshSequence = 0
  private hookArrivalSequence = 0
  private latestSessionRefresh: Promise<void> = Promise.resolve()

  /** Only the newest requested enumeration may publish or prune per-session state. */
  sessionsChanged(): Promise<void> {
    const sequence = ++this.sessionRefreshSequence
    const refresh = Promise.resolve().then(async () => {
      try {
        for (;;) {
          const hookSequence = this.hookArrivalSequence
          const workspaces = await this.options.database.listWorkspaces(true)
          const lists = await Promise.all(workspaces.map(workspace => this.options.database.listSessions(workspace.workspaceId)))
          if (sequence !== this.sessionRefreshSequence) { await this.latestSessionRefresh; return }
          // A hook can precede a newly created session's enumeration. Read again before pruning its evidence.
          if (hookSequence !== this.hookArrivalSequence) continue
          this.knownSessions.clear()
          for (const session of lists.flat()) {
            this.knownSessions.set(session.sessionId, this.options.manager.sessionWithCurrentProcessState(session))
          }
          // A deleted session keeps no hook events: the log, and everything else kept per session in
          // memory here, follows the sessions that still exist.
          let removedHooks = false
          for (const map of [this.hookEvents, this.hookReporters, this.hookObservations, this.hookOrigins, this.hookCompactions,
            this.usageReadings, this.guardStops, this.codexUsageReads, this.terminalNotices, this.repeatStates, this.attentionChanges]) {
            for (const sessionId of map.keys()) {
              if (!this.knownSessions.has(sessionId)) {
                if (map === this.hookEvents) removedHooks = true
                map.delete(sessionId)
              }
            }
          }
          this.retainedHooks.sessionsChanged()
          if (removedHooks) this.retainedHooks.markDirty()
          this.ports.sessionsChanged()
          if (this.turns !== null) {
            // Recording is on for the sessions of every unarchived workspace, wherever a session is now (Story 75.4).
            const recording = new Set(workspaces.filter((workspace) => workspace.archivedAt === null)
              .map((workspace) => workspace.workspaceId))
            for (const sessionId of this.turnSessions) if (!this.knownSessions.has(sessionId)) this.turns.forget(sessionId)
            this.turnSessions = new Set(this.knownSessions.keys())
            this.turns.setSwitches(new Set([...this.knownSessions.values()].filter((session) => recording.has(session.workspaceId))
              .map((session) => session.sessionId)))
          }
          return
        }
      } catch (error) {
        if (sequence !== this.sessionRefreshSequence) { await this.latestSessionRefresh; return }
        throw error
      }
    })
    this.latestSessionRefresh = refresh
    return refresh
  }

  /** Epic 69: the comparisons the window waits for now. A prompt that needs the worker stops them. */
  private readonly turnReads = new Set<AbortController>()

  /**
   * One read for the window in the worker thread. Stopped by a prompt's scan, it is asked again once that scan's
   * time has passed, and after the third time it says so instead of keeping the owner waiting.
   */
  private async turnRead<Answer extends { state: string }>(ask: (signal: AbortSignal) => Promise<Answer>): Promise<Answer> {
    for (let attempt = 1; ; attempt += 1) {
      const stop = new AbortController()
      this.turnReads.add(stop)
      try {
        const answer = await ask(stop.signal)
        if (answer.state !== 'cancelled' || attempt === TURN_READ_ATTEMPTS) return answer
      } finally {
        this.turnReads.delete(stop)
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, TURN_MARK_LIMIT_MS + 50) })
    }
  }

  /**
   * Epic 69: every session that records now, still has a kept turn, or has stored bytes whose removal still waits,
   * as its pane's header and the dialog read it. The last keeps "Removal pending" readable with recording off and
   * no turn left.
   */
  private async turnViews(): Promise<TurnSessionView[]> {
    const states = new Map((this.turns?.states() ?? []).map((state) => [state.sessionId, state]))
    const latest = new Map((await this.options.database.companion('latestTurns')).map((row) => [row.sessionId, turnSummary(row)]))
    const pending = new Set(await this.options.database.companion('turnRemovalPendingSessions'))
    return [...new Set([...states.keys(), ...latest.keys(), ...pending])].sort().map((sessionId) => ({
      ...(states.get(sessionId) ?? { sessionId, state: 'off' as const, app: null, pausedRoot: null, pauseReason: null, retryAt: null }),
      latest: latest.get(sessionId) ?? null,
      removalPending: pending.has(sessionId)
    }))
  }

  /** Whether a turn of this session is still kept now. */
  private async turnKept(sessionId: string, turnId: string): Promise<boolean> {
    const row = await this.options.database.companion('getTurn', turnId)
    return row !== null && row.sessionId === sessionId
  }

  /**
   * One kept turn of a session with one page of its files, compared again from its two stored scans. Every file
   * of the turn is on some page: `from` says how many stand before the one asked for.
   */
  private async turnDetail(sessionId: string, turnId: string, from: number): Promise<TurnDetailAnswer> {
    const row = await this.options.database.companion('getTurn', turnId)
    if (row === null || row.sessionId !== sessionId) return { kept: false }
    const detail = {
      turn: turnSummary(row), workTree: row.workTree, labels: row.labels, files: [] as TurnFileView[], from: 0, total: 0, unavailable: null as string | null
    }
    const port = this.options.turnChanges
    if (row.totals === null || row.before === null || row.after === null || row.workTree === null || port === undefined) return { kept: true, detail }
    const pair = { session: sessionId, root: row.workTree, a: row.before, b: row.after }
    const compared = await this.turnRead((signal) => port.compare(pair, signal))
    // The comparison took its time: a turn that was removed meanwhile is not answered as kept.
    if (!(await this.turnKept(sessionId, turnId))) return { kept: false }
    if (compared.state !== 'compared') return { kept: true, detail: { ...detail, unavailable: turnUnavailable(compared.reason) } }
    const total = compared.files.length
    // A page past the last one (the scans list fewer files than when it was asked for) is answered with the last.
    const start = Math.min(from, Math.max(0, Math.ceil(total / TURN_FILES_LIMIT) - 1) * TURN_FILES_LIMIT)
    return { kept: true, detail: { ...detail, files: compared.files.slice(start, start + TURN_FILES_LIMIT).map(turnFileView), from: start, total } }
  }

  /** One file's difference of a kept turn: bounded, every secret value masked before it leaves the worker thread. */
  private async turnDifference(sessionId: string, turnId: string, path: string): Promise<TurnDifferenceAnswer> {
    const row = await this.options.database.companion('getTurn', turnId)
    if (row === null || row.sessionId !== sessionId) return { kept: false }
    const port = this.options.turnChanges
    if (row.before === null || row.after === null || row.workTree === null || port === undefined) return { kept: true, unavailable: turnUnavailable('') }
    const pair = { session: sessionId, root: row.workTree, a: row.before, b: row.after, path }
    const difference = await this.turnRead((signal) => port.difference(pair, signal))
    // Read while the turn was being removed: nothing of it is shown as kept.
    if (!(await this.turnKept(sessionId, turnId))) return { kept: false }
    return difference.state === 'text' || difference.state === 'binary' ? { kept: true, difference } : { kept: true, unavailable: turnUnavailable(difference.reason) }
  }

  /** Epic 69: the sweep removed a turn, or a removal now waits or no longer does; the window reads again. */
  turnsChanged(): void {
    this.emit('turns', null)
  }

  /** Epic 69, self-test only: resolves when no scan, comparison or record of a turn is waited for. */
  async turnsIdle(): Promise<void> {
    await this.turns?.idle()
  }

  /** Epic 69: whether another live BMN session was started in a folder of this work tree. */
  private startedInWorkTree(sessionId: string, root: string): boolean {
    const inside = (folder: string): boolean => {
      let real = folder
      try {
        real = realpathSync(folder)
      } catch {
        // Compared as written.
      }
      return real === root || real.startsWith(root.endsWith('/') ? root : `${root}/`)
    }
    for (const other of this.knownSessions.values()) {
      if (other.sessionId === sessionId || !this.options.manager.liveIncarnationId(other.sessionId)) continue
      if (inside(this.options.manager.liveLaunchDirectory(other.sessionId) ?? other.cwd)) return true
    }
    return false
  }

  private async sessionsFor(scope: ControlScope): Promise<SessionRecord[]> {
    await this.sessionsChanged()
    const sessions = [...this.knownSessions.values()]
    return scope.kind === 'owner' ? sessions : sessions.filter((session) => session.sessionId === scope.sessionId)
  }

  /**
   * The session records a caller may see, each carrying its conversation route. The route is added
   * beside the existing fields and the reference itself is never listed: a client that ignores the
   * field sees exactly what it saw before.
   */
  private async listedSessions(scope: ControlScope): Promise<ListedSession[]> {
    const sessions = await this.sessionsFor(scope)
    const routes = new Map(
      (await this.options.database.listConversationRoutes()).map((route) => [route.sessionId, route])
    )
    return sessions.map((session) => {
      const route = routes.get(session.sessionId)
      return {
        ...session,
        conversation: route
          ? { status: route.status, captureRoute: route.captureRoute }
          : null
      }
    })
  }

  private publicAttention(record: AttentionRecord): AttentionRecord {
    const visible = { ...record }
    delete visible.producer
    return visible
  }

  private async snapshot(scope: ControlScope): Promise<unknown> {
    await this.refreshHandoffStaleness()
    const sessions = await this.listedSessions(scope)
    const visible = new Set(sessions.map((session) => session.sessionId))
    // No handoff is in any owner queue (Story 75.5): an agent reads its own, queued or from before, and nothing else.
    const [attention, progress, handoffs] = await Promise.all([
      this.options.database.companion('listAttention'),
      this.options.database.companion('listProgress'),
      scope.kind === 'owner' ? [] : this.options.database.companion('listAgentHandoffs', scope.sessionId, this.iso())
    ])
    const nowMs = this.now().getTime()
    return {
      watermark: nowMs,
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        name: session.name,
        cwd: session.cwd,
        process: session.lastProcess?.state ?? 'never-started',
        conversation: session.conversation
      })),
      attention: attention.filter((request) => request.state === 'open' && visible.has(request.sessionId))
        .map(request => this.publicAttention(request)),
      handoffs,
      progress: progress
        .filter((row) => visible.has(row.sessionId))
        .map((row) => ({ ...row, stale: nowMs - Date.parse(row.observedAt) > PROGRESS_STALE_AFTER_MS }))
    }
  }

  private async recordImport(
    installed: InstalledOriginal,
    origin: Pick<ArtifactRecord, 'sessionId' | 'direction' | 'source' | 'sourcePath'>
  ): Promise<ArtifactRecord> {
    const record: ArtifactRecord = {
      artifactId: installed.artifactId,
      sessionId: origin.sessionId,
      incarnationId: origin.sessionId ? this.options.manager.liveIncarnationId(origin.sessionId) ?? null : null,
      direction: origin.direction,
      source: origin.source,
      originalName: installed.originalName,
      mediaType: installed.mediaType,
      byteLength: installed.byteLength,
      sha256: installed.sha256,
      storedPath: installed.storedPath,
      sourcePath: origin.sourcePath,
      state: 'ready',
      createdAt: this.iso()
    }
    try {
      await this.options.database.companion('insertArtifact', record)
    } catch (error) {
      await rm(installed.storedPath, { force: true }).catch(() => undefined)
      throw error
    }
    this.emit('artifacts', origin.sessionId)
    return record
  }

  private async publishArtifact(p: {
    sessionId: string
    incarnationId: string | null
    path: string
    name?: string
    source: 'agent' | 'owner'
  }): Promise<unknown> {
    const session = this.knownSessions.get(p.sessionId)
    const allowedRoots = p.source === 'agent' && session ? [session.cwd, tmpdir()] : undefined
    const installed = await this.files.importFile(p.path, {
      artifactId: randomUUID(),
      ...(p.name ? { originalName: p.name } : {}),
      ...(allowedRoots ? { allowedRoots } : {})
    }).catch(fileError)
    const record = await this.recordImport(installed, {
      sessionId: p.sessionId, direction: 'output', source: p.source, sourcePath: p.path
    })
    return {
      artifactId: record.artifactId,
      name: record.originalName,
      sha256: record.sha256,
      byteLength: record.byteLength,
      mediaType: record.mediaType
    }
  }

  private async reportProgress(p: {
    sessionId: string
    incarnationId: string | null
    source: string
    state: ProgressRecord['state']
    label: string
    detail?: string
    evidenceIds?: readonly string[]
    observedAt: string
  }): Promise<unknown> {
    if (Number.isNaN(Date.parse(p.observedAt))) invalid('observedAt must be an ISO timestamp')
    // The store resolves the IDs inside the same transaction that writes the observation, so an
    // ineligible file refuses the whole report and leaves the previous one exactly as it was.
    const result = await this.options.database.companion('upsertProgress', {
      sessionId: p.sessionId,
      source: p.source,
      incarnationId: p.incarnationId,
      state: p.state,
      label: p.label,
      detail: p.detail ?? null,
      observedAt: new Date(p.observedAt).toISOString(),
      receivedAt: this.iso()
    }, [...(p.evidenceIds ?? [])])
    if (result.applied) this.emit('progress', p.sessionId)
    return { applied: result.applied, current: result.record }
  }

  private async withAttentionChange<Result>(sessionId: string, operation: () => Promise<Result>): Promise<Result> {
    const held = this.attentionChanges.get(sessionId) ?? { generation: 0, pending: 0 }
    this.attentionChanges.set(sessionId, held)
    held.generation += 1; held.pending += 1
    try { return await operation() } finally { held.pending -= 1 }
  }

  private openAttention(p: Parameters<CompanionService['openAttentionOnce']>[0]): ReturnType<CompanionService['openAttentionOnce']> {
    return this.withAttentionChange(p.sessionId, () => this.openAttentionOnce(p))
  }

  private async openAttentionOnce(p: {
    sessionId: string
    incarnationId: string | null
    requestKey: string
    kind: AttentionRecord['kind']
    title: string
    body?: string
    expiresAt?: string
    phoneNotified?: boolean
    origin?: string
    prompt?: AttentionPrompt
    producer?: AttentionProducer
    manualChoices?: ManualChoices
  }): Promise<AttentionRecord & { changed: boolean }> {
    if (p.manualChoices && !manualCardFits(p.title, p.manualChoices.options.map(option => option.label), p.requestKey)) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Choice labels and decision title do not fit a Telegram card')
    }
    const pluginPrompt = p.prompt?.harness === 'opencode'
    if (pluginPrompt) this.producers.unavailable(p.sessionId)
    const producer = pluginPrompt || p.origin === 'watch:repeat' || p.origin === 'watch:messages' ? null : p.producer && p.origin?.endsWith(':PreToolUse')
      ? this.producers.observe(p.sessionId, p.incarnationId, p.producer)
      : this.producers.stamp(p.sessionId, p.incarnationId)
    if (p.producer && producer && (p.producer.agentCli !== producer.agentCli ||
      p.producer.conversationReference !== producer.conversationReference)) {
      throw new HostControlError(ERROR_CODES.revisionConflict, 'This hook belongs to an earlier conversation')
    }
    if (producer && p.origin?.startsWith('hook:') && !p.origin.startsWith(`hook:${producer.agentCli}:`)) {
      this.producers.unavailable(p.sessionId)
      throw new HostControlError(ERROR_CODES.revisionConflict, 'Foreground producer not confirmed for this harness')
    }
    // Before the store is touched: a card sent for the dialog as it was must not answer what comes next.
    this.answers.hookReported(p.sessionId, p.requestKey)
    const record = await this.options.database.companion('openAttention', {
      sessionId: p.sessionId,
      incarnationId: p.incarnationId,
      requestKey: p.requestKey,
      kind: p.kind,
      title: p.title,
      ...(p.body !== undefined ? { body: p.body } : {}),
      ...(p.expiresAt !== undefined ? { expiresAt: new Date(p.expiresAt).toISOString() } : {}),
      ...(p.origin !== undefined ? { origin: p.origin } : {}),
      ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
      ...(p.manualChoices !== undefined ? { manualChoices: p.manualChoices } : {}),
      ...(producer ? { producer } : {})
    }, randomUUID(), this.iso())
    this.answers.track(record)
    this.emit('attention', p.sessionId)
    if (!p.phoneNotified) this.pager.opened(record)
    else observeTelegramDelivery((event) => this.logTelegramDelivery(event), record, 'already-notified-elsewhere')
    return record
  }

  /**
   * A terminal notification the window read out of the session's own output (OSC 9, 99 or 777).
   *
   * It is the one route into Needs you for a program that knows nothing of BMN, so it is kept as
   * small as it can be: it opens a `notice` and never a question or a permission, it writes nothing
   * to the PTY, and a session whose harness already reports through its own BMN hook is left to that
   * hook, because two routes for one turn would mean two rows. That suppression is per incarnation,
   * never per time window: a hook seen an hour ago in *this* process is still the truthful reporter,
   * and one seen in a previous process says nothing about the program running now.
   */
  private async terminalNotice(p: {
    sessionId: string
    incarnationId: string
    code: TerminalNoticeCode
    title: string
    body?: string
  }): Promise<{ opened: boolean; requestKey: string; reason?: string }> {
    // One at a time per session: a program can write two sequences in the same breath, and two
    // concurrent calls that each found no open row would each open one.
    const previous = this.noticeOperations.get(p.sessionId) ?? Promise.resolve()
    const result = previous.then(() => this.terminalNoticeLocked(p), () => this.terminalNoticeLocked(p))
    const tail = result.then(() => undefined, () => undefined)
    this.noticeOperations.set(p.sessionId, tail)
    return result.finally(() => {
      if (this.noticeOperations.get(p.sessionId) === tail) this.noticeOperations.delete(p.sessionId)
    })
  }

  private async terminalNoticeLocked(p: {
    sessionId: string
    incarnationId: string
    code: TerminalNoticeCode
    title: string
    body?: string
  }): Promise<{ opened: boolean; requestKey: string; reason?: string }> {
    const requestKey = terminalNoticeOrigin(p.code)
    // Checked again here, not only at the door: a notice can wait behind another one for as long as
    // that one takes, and the process that wrote it may be gone by the time its turn comes.
    if (this.options.manager.liveIncarnationId(p.sessionId) !== p.incarnationId) {
      return { opened: false, requestKey, reason: 'the session is running a different process now' }
    }
    if (this.hookReporters.get(p.sessionId) === p.incarnationId) {
      // Counted but not acted on, so "why is there no request for this?" still has an answer.
      this.observeTerminalNotice(p, requestKey, [])
      return { opened: false, requestKey, reason: 'this session reports through its own BMN hook' }
    }
    const now = this.now().getTime()
    const open = this.terminalNotices.get(p.sessionId)
    const text = p.body === undefined ? p.title : `${p.title}\n${p.body}`
    if (open && open.incarnationId === p.incarnationId && now - open.openedAt < TERMINAL_NOTICE_WINDOW_MS) {
      open.lines.push(text)
      // Oldest first out: the newest line is the one the owner has not read yet.
      while (open.lines.join('\n').length > TERMINAL_NOTICE_BODY_MAX && open.lines.length > 1) open.lines.shift()
      // One statement, so the owner answering the row between the read and the write cannot lose the
      // race: a row that is no longer open takes no more text and a fresh one is opened instead.
      const appended = await this.options.database.companion(
        'appendAttentionBody', open.requestId, open.lines.join('\n').slice(0, TERMINAL_NOTICE_BODY_MAX)
      )
      if (appended !== null) {
        this.emit('attention', p.sessionId)
        this.observeTerminalNotice(p, requestKey, ['opened'])
        return { opened: true, requestKey: open.requestKey }
      }
      this.terminalNotices.delete(p.sessionId)
    }
    const record = await this.openAttention({
      sessionId: p.sessionId,
      incarnationId: p.incarnationId,
      requestKey,
      kind: 'notice',
      title: p.title,
      ...(p.body === undefined ? {} : { body: p.body }),
      origin: requestKey
    })
    this.terminalNotices.set(p.sessionId, {
      requestId: record.requestId,
      requestKey,
      // Per run of the program: a restart's first word opens its own row, never a line under the last.
      incarnationId: p.incarnationId,
      title: p.title,
      openedAt: now,
      lines: p.body === undefined ? [] : [p.body]
    })
    this.observeTerminalNotice(p, requestKey, ['opened'])
    return { opened: true, requestKey }
  }

  private observeTerminalNotice(
    p: { sessionId: string; incarnationId: string },
    event: string,
    effects: readonly HookEventEffect[]
  ): void {
    this.recordHookEvent({
      sessionId: p.sessionId,
      incarnationId: p.incarnationId,
      agent: 'terminal',
      event,
      source: null,
      toolName: null,
      repeat: null,
      effects
    })
  }

  private closeAttentionByKey(...args: Parameters<CompanionService['closeAttentionByKeyOnce']>): Promise<AttentionRecord> {
    // Invalidate native claims before even the attribution read can yield.
    this.answers.hookReported(args[0], args[1])
    return this.withAttentionChange(args[0], () => this.closeAttentionByKeyOnce(...args))
  }

  private async closeAttentionByKeyOnce(
    sessionId: string,
    requestKey: string,
    state: 'answered' | 'withdrawn',
    resolution: string | null,
    origin: string | null = null,
    evidence?: AttentionEvidence,
    producer?: AttentionProducer
  ): Promise<AttentionRecord> {
    const held = (await this.options.database.companion('listAttention')).find(
      row => row.sessionId === sessionId && row.requestKey === requestKey && row.state === 'open')
    if (!held && origin === 'cli' && state === 'withdrawn') {
      const completed = (await this.options.database.companion('listAttention')).find(
        row => row.sessionId === sessionId && row.requestKey === requestKey && row.state !== 'open' && row.manualChoices)
      if (completed) return completed
    }
    const correlated = !!held?.prompt && !!evidence && (
      !!evidence.requestRef && evidence.requestRef === held.prompt.requestRef ||
      !!evidence.toolUseId && evidence.toolUseId === held.prompt.toolUseId)
    // OpenCode keeps its existing exact-key hook cleanup. Its unbound legacy notices are
    // independent of the lightweight Claude/Codex conversation slot.
    const legacyHookCleanup = !!held && !held.producer && !held.manualChoices && (
      held.prompt?.harness === 'opencode' && !!origin?.startsWith('hook:opencode:') ||
      !!origin?.startsWith('hook:opencode:') && !!held.openedBy?.startsWith('hook:opencode:'))
    if (held && !legacyHookCleanup && origin?.startsWith('hook:') &&
      !this.producers.canClose(held, producer, correlated, !!origin?.endsWith(':SessionEnd') || !!origin?.endsWith(':Interrupt'))) {
      this.emit('attention', sessionId)
      return Object.assign(held, { changed: false })
    }
    if (origin?.endsWith(':SessionEnd') || origin?.endsWith(':Interrupt')) this.producers.ended(sessionId, producer)
    // The harness reporting exactly the answer sent from the phone closes the request as the phone's.
    const remoteRequestId = evidence ? this.answers.evidence(sessionId, requestKey, evidence) : null
    const answeredRemotely = remoteRequestId !== null
    // R78-FR4: a Claude permission is "answered" only on the tool running with exactly its input; a turn that ended,
    // a new prompt or another tool may follow a deny, an expiry or Claude's own denial, so it is only no longer open.
    const heldPermission = held?.prompt?.type === 'permission' && held.prompt.harness === 'claude' ? held.prompt : null
    if (state === 'answered' && !answeredRemotely && heldPermission !== null && !(evidence?.permission === 'allowed' &&
      evidence.tool === heldPermission.tool && evidence.command === heldPermission.command)) state = 'withdrawn'
    const record = await this.options.database.companion(
      'closeAttention',
      // A report about another request of the same slot (OpenCode's queued permissions) leaves this one open.
      { sessionId, requestKey, ...(held ? { expectedRevision: held.revision, expectedProducer: held.producer ?? null } : {}),
        ...(evidence?.requestRef ? { expectedRequestRef: evidence.requestRef } : {}) },
      answeredRemotely ? 'answered' : state,
      answeredRemotely ? REMOTE_ANSWER_RESOLUTION : resolution,
      this.iso(),
      answeredRemotely ? 'telegram' : origin
    ).catch(async (error: unknown) => {
      // Another hook of the same harness closed it first; the phone's confirmed answer still gets the credit.
      if (remoteRequestId !== null) {
        const credited = await this.options.database.companion(
          'creditTelegramAnswer', remoteRequestId, REMOTE_ANSWER_RESOLUTION, this.iso()
        ).catch(() => null)
        if (credited) this.emit('attention', sessionId)
      }
      throw error
    })
    this.answers.closed(record)
    this.emit('attention', sessionId)
    return record
  }

  /**
   * Answers an open request from a Telegram tap (Story 30.3). Internal to the utility process: no control
   * socket method, owner route or CLI command reaches it, because agents can read the owner token.
   */
  async answerAttention(request: AnswerRequest): Promise<AnswerOutcome> {
    const manual = await this.options.database.companion('getAttention', request.requestId).catch(() => null)
    if (manual?.manualChoices) return this.answerManual(manual, request, false)
    const outcome = await this.answers.answer(request)
    if (outcome.state === 'submitted') {
      await this.clearSubmittedQuestionReminder(request.requestId, request.revision)
    }
    if (outcome.state === 'sent-unconfirmed' && request.answer.type === 'permission' && request.answer.decision === 'deny') {
      // Claude reports a deny through no hook, so its request would otherwise stay open after the dialog closed.
      const record = await this.options.database.companion('getAttention', request.requestId).catch(() => null)
      if (record?.state === 'open' && record.prompt?.harness === 'claude') {
        const closed = await this.options.database.companion('closeAttention',
          { requestId: record.requestId, expectedRevision: record.revision }, 'answered',
          'Deny sent from Telegram, not confirmed', this.iso(), 'telegram').catch(() => null)
        if (closed) {
          this.answers.closed(closed)
          this.emit('attention', closed.sessionId)
        }
      }
    }
    return outcome
  }

  private async answerManual(record: AttentionRecord, request: AnswerRequest, automatic: boolean): Promise<AnswerOutcome> {
    if (this.requestExpired(record)) return { state: 'refused', reason: 'gone' }
    if (!record.manualChoices || record.state !== 'open' || record.revision !== request.revision ||
      record.incarnationId !== request.incarnationId || !this.producers.current(record, false)) {
      return { state: 'refused', reason: 'changed' }
    }
    if (request.answer.type !== 'choices' || request.answer.choices.length !== 1) return { state: 'refused', reason: 'unsupported' }
    const choice = request.answer.choices[0]!
    const label = typeof choice === 'number' ? record.manualChoices.options[choice]?.label :
      'typed' in choice && !('set' in choice) ? choice.typed : undefined
    if (label === undefined || !label.trim() || label.length > 4000 || hasControlOrFormatCharacter(label)) {
      return { state: 'refused', reason: 'unsupported' }
    }
    const key = `${record.requestId}:${record.revision}`
    if (this.manualAnswerClaims.has(key)) return { state: 'refused', reason: 'claimed' }
    this.manualAnswerClaims.add(key)
    const generation = this.attentionChanges.get(record.sessionId)?.generation ?? 0
    const current = (): boolean => {
      const changes = this.attentionChanges.get(record.sessionId)
      return this.producers.current(record, false) && (changes?.generation ?? 0) === generation && (changes?.pending ?? 0) === 0
    }
    let attempted = false
    try {
      const text = `Owner answer to ${JSON.stringify(record.requestKey)} (${JSON.stringify(record.title)}):\n${label}`
      const outcome = await this.submitTelegramAnswerMessage(record, request, text,
        current, () => { attempted = true }, automatic)
      if (outcome.state === 'submitted') {
        const closed = await this.options.database.companion('closeAttention',
          { requestId: record.requestId, expectedRevision: record.revision, expectedProducer: record.producer ?? null },
          'answered', `Submitted from Telegram: ${typeof choice === 'number' ? label : 'Other'}`, this.iso(), 'telegram').catch(() => null)
        if (closed) this.emit('attention', closed.sessionId)
      }
      return outcome.state === 'submitted' ? { state: 'submitted', sent: [label] } : outcome
    } catch {
      return attempted ? { state: 'sent-unconfirmed', sent: [label] } : { state: 'refused', reason: 'unsupported' }
    } finally { this.manualAnswerClaims.delete(key) }
  }

  /** A successful ordinary message clears only its reminder, without a native answer receipt. */
  private async clearSubmittedQuestionReminder(requestId: string, revision: number): Promise<void> {
    const database = this.options.database
    const record = await database.companion('getAttention', requestId).catch(() => null)
    if (!record || record.state !== 'open' || record.revision !== revision || record.kind !== 'question' ||
      answerRoute(record.prompt) !== 'codex-message') return
    const closed = await database.companion('closeAttention',
      { requestId, expectedKind: 'question', expectedRevision: revision }, 'withdrawn',
      'Message submitted from Telegram; native answer not confirmed; reminder cleared', this.iso(), 'telegram'
    ).catch(() => null)
    if (closed) {
      this.answers.closed(closed)
      this.emit('attention', closed.sessionId)
    }
  }

  /** The dialog epoch a card for this request is sent for; null when it cannot be answered by a tap. */
  answerEpoch(requestId: string): number | null {
    return this.answers.epochOf(requestId)
  }

  /** A Codex Default card sends an ordinary message, never picker keys or a consumption receipt. */
  private async submitTelegramAnswerMessage(
    attention: AttentionRecord, request: AnswerRequest, text: string,
    current: () => boolean, markWritten: () => void, automatic = false
  ): Promise<AnswerOutcome> {
    const refused = (reason: 'changed' | 'gone' | 'claimed' | 'unsupported'): AnswerOutcome => ({ state: 'refused', reason })
    if (!(attention.kind === 'question' || attention.kind === 'permission' && attention.manualChoices) || hasDisallowedHandoffControl(text) ||
      new TextEncoder().encode(text).byteLength > HANDOFF_PAYLOAD_BYTES) return refused('unsupported')
    const database = this.options.database
    // Earlier unrelated hooks may leave a queued card valid, but mutations during
    // this delivery must still invalidate a stale final-boundary snapshot.
    const attentionGeneration = this.attentionChanges.get(attention.sessionId)?.generation ?? 0
    const availabilityEpoch = this.fileReferenceAvailabilityEpoch
    const { record } = await database.companion('createDraft', {
      draftId: randomUUID(), sessionId: attention.sessionId, origin: 'telegram',
      originKey: `telegram-answer:${attention.requestId}:${attention.revision}`, requestId: attention.requestId,
      text, artifactId: null, state: 'draft', detail: null
    }, this.iso())
    return this.withDraft(record.draftId, async () => {
      let draft = await database.companion('getDraft', record.draftId)
      if (draft.state !== 'draft') return refused('claimed')
      if (draft.text !== text) draft = await database.companion('replaceDraftText', draft.draftId, draft.updatedAt, text, this.iso())
      let written = false
      try {
        // Persist before input: a restart or ambiguous write cannot replay the message.
        await database.companion('updateDraft', draft.draftId, 'uncertain', 'Message submission pending', this.iso())
        const { attention: open, available, settings } = await database.companion('telegramMessageBoundary', attention.sessionId)
        const latest = open.find(row => row.requestId === attention.requestId)
        const nativeDialog = open.some(row => row.sessionId === attention.sessionId && row.state === 'open' &&
          row.requestId !== attention.requestId && this.nativeMessageBlocker(row))
        const policyOff = attention.manualChoices && (attention.kind === 'permission' && !settings.telegram.answerPermissions || automatic && !settings.telegram.autoSubmitReplies)
        const reason = !latest || latest.state !== 'open' || this.requestExpired(latest) ? 'gone' :
          latest.revision !== request.revision || !current() || !available ||
            (this.attentionChanges.get(attention.sessionId)?.generation ?? 0) !== attentionGeneration ||
            (this.attentionChanges.get(attention.sessionId)?.pending ?? 0) > 0 ||
            this.fileReferenceAvailabilityEpoch !== availabilityEpoch || this.fileReferenceAvailabilityChanges > 0 ? 'changed' : nativeDialog || policyOff ? 'unsupported' : null
        if (reason) {
          await database.companion('updateDraft', draft.draftId, 'draft', 'Nothing submitted; card changed or a native dialog is open', this.iso())
          return refused(reason)
        }
        written = true
        markWritten()
        this.options.manager.writeToSession(attention.sessionId, bracketedPaste(draft.text!, true))
        await database.companion('updateDraft', draft.draftId, 'submitted', 'Ordinary message submitted; native answer not confirmed', this.iso())
        this.emit('drafts', attention.sessionId)
        return { state: 'submitted', sent: [text] }
      } catch (error) {
        if (!written) await database.companion('updateDraft', draft.draftId, 'draft', 'Nothing submitted; preparation failed. Try again.', this.iso()).catch(() => undefined)
        throw error
      }
    })
  }

  private nativeProducerCurrent(record: AttentionRecord): boolean {
    return record.prompt?.harness === 'opencode'
      ? record.incarnationId !== null && this.options.manager.liveIncarnationId(record.sessionId) === record.incarnationId
      : this.producers.current(record)
  }

  /** Whether a permission could be answered from Telegram at all: Telegram on and permission answers allowed. */
  private async phoneMayAnswer(): Promise<boolean> {
    const settings = await this.options.database.companion('getSettings').catch(() => null)
    return settings !== null && settings.telegram.enabled && settings.telegram.answerPermissions
  }

  /** Whether a tap could answer this request now, and whether it may offer Deny. */
  async answerability(record: AttentionRecord): Promise<
    { answerable: true; deny: boolean } | { answerable: false; reason: 'unsupported' | 'permissions-off'; detail?: string }
  > {
    if (this.requestExpired(record)) return { answerable: false, reason: 'unsupported', detail: 'This request expired. Nothing sent.' }
    if (record.manualChoices) {
      if (!this.producers.current(record, false)) return { answerable: false, reason: 'unsupported', detail: record.producer ? 'Conversation unavailable. Nothing sent; use its current question at the laptop.' : 'Conversation not confirmed. Nothing sent; use the laptop.' }
      const settings = await this.options.database.companion('getSettings')
      if (record.state !== 'open' || !this.producers.current(record, false)) return { answerable: false, reason: 'unsupported' }
      return record.kind === 'permission' && !settings.telegram.answerPermissions
        ? { answerable: false, reason: 'permissions-off' } : { answerable: true, deny: false }
    }
    if (!this.nativeProducerCurrent(record)) return { answerable: false, reason: 'unsupported', detail: 'Conversation unavailable. Nothing sent; use its current question at the laptop.' }
    if (record.state !== 'open' || answerRoute(record.prompt) === null) return { answerable: false, reason: 'unsupported' }
    if (record.prompt?.type === 'permission') {
      const settings = await this.options.database.companion('getSettings')
      if (!settings.telegram.answerPermissions) return { answerable: false, reason: 'permissions-off' }
      if (!this.nativeProducerCurrent(record)) return { answerable: false, reason: 'unsupported' }
      return { answerable: true, deny: this.answers.canDeny(record) }
    }
    return { answerable: true, deny: false }
  }

  private nativeMessageBlocker(record: AttentionRecord): boolean {
    return !record.manualChoices && (record.prompt ? answerRoute(record.prompt) !== 'codex-message' : record.kind === 'permission')
  }

  private requestExpired(record: AttentionRecord): boolean {
    return record.expiresAt !== null && Date.parse(record.expiresAt) <= this.now().getTime()
  }

  /** The repeat watch is the sole exception to the otherwise diagnostic hook log. */
  private async observeHookEvent(p: {
    sessionId: string
    incarnationId: string | null
    agent: HookEventAgent
    event: string
    source: string | null
    toolName: string | null
    fingerprint?: string | undefined
    apiHost?: string | undefined
    model?: string | undefined
    claudeConfigDir?: string | undefined
    effects: readonly HookEventEffect[]
  }): Promise<{ recorded: true }> {
    if (p.claudeConfigDir !== undefined) void this.history.learnClaudeFolder(p.claudeConfigDir).catch(() => undefined)
    // Share the notice queue: observe/reset/open must complete in arrival order.
    const previous = this.noticeOperations.get(p.sessionId) ?? Promise.resolve()
    const operation = async (): Promise<{ recorded: true }> => {
      let repeat: number | null = null
      const effects = [...p.effects]
      if (p.agent === 'claude' || p.agent === 'codex' || p.agent === 'opencode') {
        const result = observeRepeat(this.repeatStates.get(p.sessionId), { ...p, agent: p.agent })
        this.repeatStates.set(p.sessionId, result.state)
        repeat = result.repeat
        if (result.closed) await this.writeRepeatSegment(p.sessionId, result.closed)
        const turn = ownerTurn({ ...p, agent: p.agent })
        if (turn || result.fire) {
          try {
            const rows = await this.options.database.companion('listAttention')
            const open = rows.find((row) => row.sessionId === p.sessionId &&
              row.requestKey === 'watch:repeat' && row.state === 'open')
            if (turn && open) {
              const closed = await this.closeAttentionByKey(p.sessionId, 'watch:repeat', 'withdrawn', null, 'watch:repeat')
              if (closed.state === 'withdrawn' && !effects.includes('withdrew')) effects.push('withdrew')
            } else if (result.fire && !open && p.incarnationId !== null &&
              this.options.manager.liveIncarnationId(p.sessionId) === p.incarnationId) {
              const opened = await this.openAttention({
                sessionId: p.sessionId, incarnationId: p.incarnationId,
                requestKey: 'watch:repeat', kind: 'notice', origin: 'watch:repeat',
                title: `${this.knownSessions.get(p.sessionId)?.name ?? 'Session'} repeated the same ${p.toolName ?? 'tool'} call ${REPEAT_NOTICE_AT} times`.slice(0, TERMINAL_NOTICE_TITLE_MAX),
                body: 'BMN counted identical calls since your last message. It did not stop or change anything.'
              })
              if (opened.changed) {
                result.state.notified = true
                if (!effects.includes('opened')) effects.push('opened')
              }
            }
          } catch {
            // A failed store call must not invent an effect or lose the original observation.
          }
        }
      }
      return this.recordHookEvent({ ...p, repeat, effects })
    }
    const result = previous.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.noticeOperations.set(p.sessionId, tail)
    return result.finally(() => {
      if (this.noticeOperations.get(p.sessionId) === tail) this.noticeOperations.delete(p.sessionId)
    })
  }

  private writeRepeatSegment(sessionId: string, segment: RepeatSegment): Promise<void> {
    const line = `${JSON.stringify({ at: this.iso(), agent: segment.agent, sessionId,
      toolName: segment.toolName, maxRepeat: segment.maxRepeat, toolEvents: segment.toolEvents,
      notified: segment.notified })}\n`
    this.repeatWrites = this.repeatWrites
      .then(() => this.appendBoundedLog(join(this.options.roots.state, 'repeat-watch.log'), line))
      .catch(() => undefined)
    return this.repeatWrites
  }

  private recordHookEvent(p: Omit<HookEventRecord, 'observedAt' | 'agent'> & {
    /** Only a live agent reports; a saved row may still name a retired one. */
    agent: HookEventAgent
    apiHost?: string | undefined
    model?: string | undefined
  }): { recorded: true } {
    const observedAt = this.iso()
    // Which incarnation has a harness reporting for it, kept whatever the log later drops.
    if (p.agent !== 'terminal' && p.incarnationId !== null) {
      this.hookReporters.set(p.sessionId, p.incarnationId)
      // Only this run's own report may speak for it, so a queued event from a process that has
      // already been replaced never becomes the current run's observation.
      if (this.options.manager.liveIncarnationId(p.sessionId) === p.incarnationId) {
        // The agent left its terminal: Claude's and Codex's SessionEnd, or BMN's OpenCode plugin unloading as OpenCode quits.
        const ended = p.event === 'SessionEnd' || (p.agent === 'opencode' && p.event === 'tui.exit')
        // Remote answers and the Away wake read an agent's screen; a plain shell never pays for a mirror (Epic 30.2 AC1).
        if (p.agent === 'claude' || p.agent === 'codex' || p.agent === 'opencode') {
          if (ended) this.options.manager.stopScreenMirror(p.sessionId)
          else this.options.manager.screenMirror(p.sessionId, p.incarnationId)
        }
        this.hookObservations.set(p.sessionId, {
          sessionId: p.sessionId,
          incarnationId: p.incarnationId,
          agent: p.agent,
          event: p.event,
          source: p.source,
          observedAt,
          foreground: ended ? null : this.options.manager.foregroundProcessIdentity(p.sessionId)
        })
        if (p.agent === 'codex') void this.readCodexUsage(p.sessionId, p.incarnationId, p.event === 'Stop')
        if (isCompactionEvent(p)) {
          const earlier = this.hookCompactions.get(p.sessionId)
          const count = earlier?.incarnationId === p.incarnationId ? earlier.count + 1 : 1
          this.hookCompactions.set(p.sessionId, { incarnationId: p.incarnationId, lastAt: observedAt, count })
        }
        // Every hook event refreshes the origin, so a flag lost to a BMN restart comes back on the
        // next hook without waiting for a SessionStart. The CLI reads the base URL afresh for every
        // event, so the host is never carried: absent means unset now. Most events carry no model,
        // so the same agent's last model still speaks within its session; a new agent, or a new
        // session in it (SessionStart other than compaction), starts from what it reports itself.
        const previous = this.hookOrigins.get(p.sessionId)
        const newSession = p.event === 'SessionStart' && p.source !== 'compact'
        const carried = previous !== undefined && previous.incarnationId === p.incarnationId &&
          previous.agent === p.agent && !newSession ? previous : null
        const model = p.model ?? carried?.model ?? null
        const apiHost = p.apiHost ?? null
        // An agent that ended leaves a plain shell behind in the same run, and a shell has no flag;
        // a late end from an agent that has already been replaced leaves the newer one's facts.
        const staleEnd = ended && previous !== undefined && previous.incarnationId === p.incarnationId &&
          previous.agent !== p.agent
        const next: HookOriginRecord | null | undefined = staleEnd ? previous : ended ? null : {
          state: 'observed',
          sessionId: p.sessionId,
          incarnationId: p.incarnationId,
          agent: p.agent,
          country: modelOrigin({ agent: p.agent, apiHost, model }),
          model,
          apiHost,
          observedAt
        }
        if (next === null) this.hookOrigins.delete(p.sessionId)
        else if (next !== undefined) this.hookOrigins.set(p.sessionId, next)
        // Only a change the window can show is published, so a busy agent's every tool call does
        // not re-read the list; the record's time still moves with each event.
        const shown = (record: HookOriginRecord | null | undefined): string => record
          ? JSON.stringify([record.incarnationId, record.agent, record.country, record.model, record.apiHost]) : ''
        if (shown(previous) !== shown(next)) this.emit('hooks', p.sessionId)
      }
    }
    const log = this.hookEvents.get(p.sessionId) ?? []
    log.push({
      sessionId: p.sessionId,
      incarnationId: p.incarnationId,
      agent: p.agent,
      event: p.event,
      source: p.source,
      toolName: p.toolName,
      repeat: p.repeat,
      effects: [...p.effects],
      observedAt
    })
    if (log.length > HOOK_EVENT_LOG_LIMIT) log.splice(0, log.length - HOOK_EVENT_LOG_LIMIT)
    this.hookEvents.set(p.sessionId, log)
    this.hookArrivalSequence += 1
    this.retainedHooks.markDirty()
    return { recorded: true }
  }

  private *liveHookEvents(): Generator<HookEventRecord> {
    for (const rows of this.hookEvents.values()) yield* rows
  }

  /** The window's read-only view of one session's log; a session never sees another session's events. */
  listHookEvents(sessionId: string): HookEventRecord[] {
    return [...(this.hookEvents.get(sessionId) ?? [])]
  }

  /**
   * What one run of a session has actually reported to BMN, or the absence of such an event. The
   * run is the one the caller names, else the session's live incarnation; an observation from any
   * other incarnation is not attributed to it. This is evidence one event arrived, never a verdict
   * that hooks work.
   */
  hookObservation(sessionId: string, incarnationId?: string): HookObservation {
    const run = incarnationId ?? this.options.manager.liveIncarnationId(sessionId) ?? null
    const stored = this.hookObservations.get(sessionId)
    if (run === null || stored === undefined || stored.incarnationId !== run) {
      return { state: 'none', sessionId, incarnationId: run }
    }
    return {
      state: 'observed',
      sessionId,
      incarnationId: stored.incarnationId,
      agent: stored.agent,
      event: stored.event,
      observedAt: stored.observedAt,
      // The summary outlives its detail: the bounded log may have evicted this event's own row.
      detailAvailable: (this.hookEvents.get(sessionId) ?? []).some(
        (row) => row.incarnationId === stored.incarnationId && row.agent === stored.agent &&
          row.event === stored.event && row.observedAt === stored.observedAt
      ),
      compaction: this.hookCompaction(sessionId, stored.incarnationId)
    }
  }

  /**
   * What holds a session's terminal now, as a message to it sees it (Story 75.4): the agent whose own hook
   * reported from the very process in the foreground, not the last app seen there. An agent that exited into its
   * still-running shell leaves the shell in front, which Linux reports as no foreground process of an agent.
   */
  private sessionForeground(sessionId: string): SessionAgentNow {
    const run = this.options.manager.liveIncarnationId(sessionId)
    if (!run) return { state: 'stopped' }
    const front = this.options.manager.foregroundProcessIdentity(sessionId)
    if (front === null) return { state: 'shell' }
    const seen = this.hookObservations.get(sessionId)
    return seen !== undefined && seen.incarnationId === run && seen.foreground === front
      ? { state: 'agent', app: seen.agent }
      : { state: 'program' }
  }

  private hookCompaction(sessionId: string, incarnationId: string): HookCompaction | null {
    const stored = this.hookCompactions.get(sessionId)
    return stored === undefined || stored.incarnationId !== incarnationId
      ? null : { lastAt: stored.lastAt, count: stored.count }
  }

  /**
   * Keeps one plan-use reading for the run that sent it. A reading with plan windows also becomes its
   * agent's plan reading and may open the 90% notice; one without (`claude glm`) keeps only its context use.
   */
  private async recordUsage(p: Omit<UsageReading, 'readAt'>): Promise<{ recorded: boolean }> {
    // Only the live run speaks for the session, as with hook observations.
    if (this.options.manager.liveIncarnationId(p.sessionId) !== p.incarnationId) return { recorded: false }
    const earlier = this.usageReadings.get(p.sessionId)
    // Claude leaves `rate_limits` out of some refreshes (before a run's first reply, for one); a refresh
    // like that updates the context share and keeps the windows this run already reported, with their time.
    const kept = p.windows.length === 0 && earlier?.incarnationId === p.incarnationId && earlier.agent === p.agent &&
      earlier.windows.length > 0 ? earlier : null
    const reading: UsageReading = {
      sessionId: p.sessionId,
      incarnationId: p.incarnationId,
      agent: p.agent,
      windows: (kept?.windows ?? p.windows).map((window) => ({ ...window })),
      contextUsedPercent: p.contextUsedPercent,
      readAt: kept?.readAt ?? this.iso()
    }
    this.usageReadings.set(p.sessionId, reading)
    if (kept !== null) return { recorded: true }
    if (reading.windows.length > 0) {
      this.planReadings.set(reading.agent, reading)
      // The reading stands whatever becomes of its notice; the next reading at 90% or more decides again.
      await this.usageNotice(reading).catch(() => undefined)
    }
    return { recorded: true }
  }

  /**
   * Story 60.8: keeps the last prompt a session's prompt guard stopped, for the run that sent it.
   * A prompt that passed clears it. A stopped prompt sent again opens its card again.
   */
  private recordGuard(p: GuardReport): { recorded: boolean } {
    // Only the live run speaks for the session, as with hook observations.
    if (this.options.manager.liveIncarnationId(p.sessionId) !== p.incarnationId) return { recorded: false }
    if (p.outcome === 'pass') {
      if (this.guardStops.has(p.sessionId)) {
        this.guardStops.delete(p.sessionId)
        this.emit('guard', p.sessionId)
      }
      return { recorded: true }
    }
    this.guardStops.set(p.sessionId, { ...p, at: this.iso(), kept: false })
    this.emit('guard', p.sessionId)
    return { recorded: true }
  }

  /**
   * One Needs you notice per agent, window and reset period once a window reaches 90%. It expires when
   * the window resets, and it reaches Telegram only by the pager's rule for any notice. Every decision
   * waits its turn in one queue, so two readings arriving together cannot both find no notice and both
   * open one.
   */
  private usageNotice(reading: UsageReading): Promise<void> {
    const decided = this.usageNoticeQueue.then(() => this.usageNoticeNow(reading))
    // A decision that failed must not hold up the ones queued behind it.
    this.usageNoticeQueue = decided.catch(() => undefined)
    return decided
  }

  private async usageNoticeNow(reading: UsageReading): Promise<void> {
    // Checked when its turn comes rather than when it queued: the run may have been replaced meanwhile.
    if (this.options.manager.liveIncarnationId(reading.sessionId) !== reading.incarnationId) return
    const now = this.now()
    for (const window of reading.windows) {
      const resetsAt = Date.parse(window.resetsAt)
      if (usagePercent(window.usedPercent) < USAGE_NOTICE_PERCENT || resetsAt <= now.getTime()) continue
      const period = `usage:${reading.agent}:${window.minutes}:`
      // A period is known by its reset time, anchored at the first notice's expiry: a notice of any state,
      // from any session and from before a BMN restart, whose reset lies within the tolerance is this
      // period's. A store that cannot answer opens nothing now, and a later reading asks again.
      const noticed = await this.options.database.companion('usageNoticeExists', period,
        new Date(resetsAt - USAGE_PERIOD_TOLERANCE_MS).toISOString(),
        new Date(resetsAt + USAGE_PERIOD_TOLERANCE_MS).toISOString()).catch(() => null)
      if (noticed !== false) continue
      const agent = reading.agent === 'claude' ? 'Claude' : 'Codex'
      try {
        await this.openAttention({
          sessionId: reading.sessionId,
          incarnationId: reading.incarnationId,
          requestKey: `${period}${Math.round(resetsAt / 60_000)}`,
          kind: 'notice',
          origin: 'watch:usage',
          title: `${agent} ${usageWindowName(window.minutes, 'limit')} limit at ${usagePercent(window.usedPercent)}% · resets ${usageClock(window.resetsAt, now)}`,
          body: `${agent} reported this in ${this.knownSessions.get(reading.sessionId)?.name ?? 'a session'}. BMN only shows it; nothing was stopped or changed.`,
          expiresAt: window.resetsAt
        })
      } catch {
        // Nothing was stored, so the next reading at 90% or more tries again.
      }
    }
  }

  /**
   * Reads a Codex run's plan windows from the tail of its own session file, found through the
   * conversation it is bound to, the way Resume finds it. At most once every 15 s per session unless
   * forced (a finished turn, or the owner opening Session details); reads never overlap.
   */
  private readCodexUsage(sessionId: string, incarnationId: string, force: boolean): Promise<void> {
    let state = this.codexUsageReads.get(sessionId)
    if (state === undefined) {
      state = { at: -Infinity, running: null, again: null }
      this.codexUsageReads.set(sessionId, state)
    }
    const current = state
    if (current.running) {
      if (!force) return current.running
      // A finished turn arriving mid-read may have written a newer line than that read saw, so one more read
      // follows it; every finished turn until that read starts shares it.
      return current.again ??= current.running.then(() => {
        current.again = null
        return this.readCodexUsage(sessionId, incarnationId, true)
      })
    }
    const now = this.now().getTime()
    if (!force && now - current.at < CODEX_USAGE_READ_EVERY_MS) return Promise.resolve()
    current.running = (async () => {
      const binding = await this.options.database.getConversationBinding(sessionId).catch(() => undefined)
      if (binding?.status !== 'bound' || binding.agentCli !== 'codex') return
      const home = binding.launchContext.environment.CODEX_HOME ?? join(homedir(), '.codex')
      const path = await codexRolloutPath(join(home, 'sessions'), binding.conversationReference)
      const windows = path === null ? null : await readCodexUsage(path)
      if (windows === null || windows.length === 0) return
      await this.recordUsage({ sessionId, incarnationId, agent: 'codex', windows, contextUsedPercent: null })
    })().catch(() => undefined).finally(() => {
      current.at = now
      current.running = null
    })
    return current.running
  }

  /** What the session's current run reported about plan use; a Codex run's file is read first when due. */
  private async sessionUsage(sessionId: string): Promise<SessionUsage> {
    const incarnationId = this.options.manager.liveIncarnationId(sessionId) ?? null
    const observed = this.hookObservations.get(sessionId)
    const agent = incarnationId !== null && observed?.incarnationId === incarnationId ? observed.agent : null
    if (incarnationId !== null && agent === 'codex') await this.readCodexUsage(sessionId, incarnationId, false)
    const stored = this.usageReadings.get(sessionId)
    return {
      sessionId,
      incarnationId,
      reading: stored !== undefined && stored.incarnationId === incarnationId ? stored : null,
      agent
    }
  }

  private async sweepAttention(): Promise<void> {
    const activeDraftIds = [...this.draftOperations.keys()]
    const expired = await this.options.database.companion('expireAttention', this.iso(), activeDraftIds).catch(() => 0)
    if (expired > 0) {
      this.emit('attention', null)
      this.emit('drafts', null)
    }
    // Requests closed by expiry or by the owner are forgotten here; hooks report their own closes.
    const rows = await this.options.database.companion('listAttention').catch(() => null)
    if (rows) this.answers.retain(new Set(rows.filter((row) => row.state === 'open').map((row) => row.requestId)))
    await this.quietDelivery.sweep(true).catch(() => undefined)
    await this.morningDigest.sweep().catch(() => undefined)
    // Not awaited: a slow sensor or a slow send must not hold the sweep, and an overlapping check skips.
    void this.healthAlerts.sweep().catch(() => undefined)
    // Not awaited either: each tick is claimed before its first await, so an overlapping sweep types nothing twice.
    void this.awayWake.sweep().catch(() => undefined)
    // Epic 66.3: old messages go by the owner's confirmed Keep agent history days; once an hour is often enough.
    if (this.now().getTime() - this.lastMessageSweepAt >= MESSAGE_SWEEP_EVERY_MS) {
      this.lastMessageSweepAt = this.now().getTime()
      await this.messages.sweep().catch(() => undefined)
    }
  }

  private async readyArtifact(artifactId: string): Promise<ArtifactRecord> {
    const artifact = await this.options.database.companion('getArtifact', artifactId)
    const verdict = await this.files.verify(artifact.storedPath, artifact.sha256)
    if (verdict !== 'ok') {
      if (artifact.state !== verdict) {
        await this.options.database.companion('setArtifactState', artifactId, verdict)
        this.emit('artifacts', artifact.sessionId)
      }
      throw new HostControlError(
        verdict === 'missing' ? ERROR_CODES.notFound : ERROR_CODES.ioError,
        verdict === 'missing' ? 'The stored original is missing' : 'The stored original no longer matches its hash'
      )
    }
    if (artifact.state !== 'ready') {
      await this.options.database.companion('setArtifactState', artifactId, 'ready')
      this.emit('artifacts', artifact.sessionId)
    }
    return { ...artifact, state: 'ready' }
  }

  private async markDamaged(artifact: ArtifactRecord, error: unknown): Promise<void> {
    if (error instanceof ArtifactFileError && (error.code === 'missing' || error.code === 'corrupt')) {
      await this.options.database.companion('setArtifactState', artifact.artifactId, error.code).catch(() => undefined)
      this.emit('artifacts', artifact.sessionId)
    }
  }

  /** Marks originals whose file disappeared or changed so the UI never offers a broken artifact as ready. */
  private async reconcileArtifacts(): Promise<void> {
    const artifacts = await this.options.database.companion('listAllArtifacts')
    for (const artifact of artifacts) {
      const exists = await lstat(artifact.storedPath).then((stats) => stats.isFile(), () => false)
      const state = exists ? artifact.state === 'missing' ? 'ready' : artifact.state : 'missing'
      if (state !== artifact.state) await this.options.database.companion('setArtifactState', artifact.artifactId, state)
    }
  }

  private async preview(artifactId: string): Promise<ArtifactPreview> {
    const artifact = await this.readyArtifact(artifactId)
    if (artifact.mediaType.startsWith('image/')) {
      const { bytes, truncated } = await this.files.readPreview(artifact.storedPath, PREVIEW_IMAGE_BYTES)
      if (truncated) {
        return { artifactId, kind: 'unsupported', mediaType: artifact.mediaType, content: null, truncated: true }
      }
      return {
        artifactId, kind: 'image', mediaType: artifact.mediaType,
        content: Buffer.from(bytes).toString('base64'), truncated: false
      }
    }
    if (TEXT_MEDIA.test(artifact.mediaType)) {
      const { bytes, truncated } = await this.files.readPreview(artifact.storedPath, PREVIEW_TEXT_BYTES)
      return {
        artifactId, kind: 'text', mediaType: artifact.mediaType,
        content: new TextDecoder('utf-8', { fatal: false }).decode(bytes), truncated
      }
    }
    return { artifactId, kind: 'unsupported', mediaType: artifact.mediaType, content: null, truncated: false }
  }

  /**
   * Delivers an owned original to the target session by pasting a path to it, never pressing Enter.
   * The path is a symlink named with the original's extension so TUIs recognize images.
   */
  private async deliver(artifactId: string, sessionId: string, expectedIncarnationId: string | null = null): Promise<{ delivered: true; path: string; pastedAt: string }> {
    const artifact = await this.readyArtifact(artifactId)
    const incarnation = this.options.manager.liveIncarnationId(sessionId)
    if (!incarnation) {
      throw new HostControlError(ERROR_CODES.notFound, 'The target session has no live process')
    }
    if (expectedIncarnationId !== null && incarnation !== expectedIncarnationId) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The destination process changed. Review it before delivering.')
    }
    const linkPath = await this.prepareArtifactLink(artifact)
    if (this.options.manager.liveIncarnationId(sessionId) !== incarnation) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The destination stopped or changed before paste. Nothing was pasted.')
    }
    // One original has one delivery identity for this live destination, including after panel/host restart.
    // Reuse the persisted paste guard: a lost response or uncertain write must never append again.
    const requestId = `artifact-delivery:${createHash('sha256')
      .update(JSON.stringify([artifactId, sessionId, incarnation])).digest('hex')}`
    const receipt = await this.pasteFileReference({
      requestId, sessionId, expectedIncarnationId: incarnation, sourcePath: linkPath, line: null, column: null
    }, { retryRejected: true, ownedArtifactPath: linkPath })
    return { delivered: true, path: linkPath, pastedAt: receipt.pastedAt }
  }

  private async prepareArtifactLink(artifact: ArtifactRecord): Promise<string> {
    const linkDirectory = artifactLinksRoot(this.options.roots.data)
    await mkdir(linkDirectory, { recursive: true, mode: 0o700 })
    const linkPath = join(linkDirectory, `${artifact.artifactId}${linkExtension(artifact)}`)
    const existing = await lstat(linkPath).catch(() => undefined)
    if (!existing) await symlink(artifact.storedPath, linkPath)
    else if (!existing.isSymbolicLink()) throw new HostControlError(ERROR_CODES.ioError, 'The delivery path is occupied')
    return linkPath
  }

  private quotePath(path: string): string {
    return /[\s'"\\]/.test(path) ? `'${path.replaceAll("'", "'\\''")}'` : path
  }

  private withDraft<Result>(draftId: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.draftOperations.get(draftId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.draftOperations.set(draftId, tail)
    return result.finally(() => {
      if (this.draftOperations.get(draftId) === tail) this.draftOperations.delete(draftId)
    })
  }

  private pasteFileReference(
    raw: Record<string, unknown>,
    delivery: { retryRejected?: boolean; ownedArtifactPath?: string } = {}
  ): Promise<FileReferencePasteReceipt> {
    const requestId = text(raw, 'requestId', 128)
    const sessionId = text(raw, 'sessionId', 128)
    const expectedIncarnationId = text(raw, 'expectedIncarnationId', 128)
    const sourcePath = text(raw, 'sourcePath')
    const line = raw.line
    const column = raw.column
    if ((line !== null && (!Number.isSafeInteger(line) || Number(line) < 1)) ||
      (column !== null && (!Number.isSafeInteger(column) || Number(column) < 1))) {
      invalid('The reference position is invalid')
    }
    const payload = delivery.ownedArtifactPath
      ? `${this.quotePath(delivery.ownedArtifactPath)} `
      : exactAbsoluteFileReference(sourcePath, line as number | null, column as number | null)
    if (!payload) invalid('This path cannot be sent as an exact file reference')
    const fingerprint = JSON.stringify([sessionId, expectedIncarnationId, payload])
    const paramsHash = createHash('sha256').update(fingerprint).digest('hex')
    const receiptKey = `file-reference-paste:${requestId}`
    const previous = this.fileReferencePastes.get(requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) invalid('The paste request changed; choose the target again')
      return previous.result
    }
    const availabilityEpoch = this.fileReferenceAvailabilityEpoch
    const result = (async (): Promise<FileReferencePasteReceipt> => {
      this.ensureFileReferenceAvailabilityUnchanged(availabilityEpoch)
      const database = this.options.database
      const previousReceipt = await database.companion('getReceipt', receiptKey)
      if (previousReceipt) {
        if (previousReceipt.paramsHash !== paramsHash) invalid('The paste request changed; choose the target again')
        if (previousReceipt.state === 'done' && previousReceipt.result) {
          return previousReceipt.result as FileReferencePasteReceipt
        }
        if (previousReceipt.state === 'failed') {
          if (!delivery.retryRejected) {
            throw new HostControlError(ERROR_CODES.revisionConflict,
              'The earlier paste was rejected before writing; choose the destination again')
          }
          // Artifact delivery may retry a definite pre-write rejection; staged/uncertain writes stay blocked.
        } else {
          throw new HostControlError(ERROR_CODES.revisionConflict,
            'An earlier paste may have reached the input; inspect the destination before choosing it again')
        }
      }
      await this.availableFileReferenceTarget(sessionId, expectedIncarnationId)
      // The staged receipt survives a host crash. A retry with the same key never repeats an uncertain write.
      await database.companion('putReceipt', { key: receiptKey, paramsHash, state: 'staged' }, this.iso())
      let live: string
      try {
        live = await this.availableFileReferenceTarget(sessionId, expectedIncarnationId)
        // Host archive/move requests enter through this same event loop and mark the epoch before awaiting the DB.
        // No await separates this guard and the PTY write, so a response-gap archive cannot sneak past it.
        this.ensureFileReferenceAvailabilityUnchanged(availabilityEpoch)
      } catch (error) {
        await database.companion('putReceipt', {
          key: receiptKey, paramsHash, state: 'failed',
          error: { code: error instanceof HostControlError ? error.code : ERROR_CODES.ioError,
            message: error instanceof Error ? error.message : 'Destination unavailable before paste' }
        }, this.iso())
        throw error
      }
      // No await separates the final checks and the bounded write.
      try {
        this.options.manager.writeToSession(sessionId, bracketedPaste(payload, false))
      } catch {
        throw new HostControlError(ERROR_CODES.ioError,
          'Paste outcome is uncertain; inspect the destination before choosing it again')
      }
      const receipt: FileReferencePasteReceipt = {
        requestId, sessionId, incarnationId: live, payload,
        pastedAt: this.iso(), status: 'pasted-not-submitted'
      }
      try {
        await database.companion('putReceipt', {
          key: receiptKey, paramsHash, state: 'done', result: receipt
        }, this.iso())
      } catch {
        throw new HostControlError(ERROR_CODES.ioError,
          'Paste reached the destination, but its receipt is uncertain; inspect it before choosing again')
      }
      return receipt
    })()
    this.fileReferencePastes.set(requestId, { fingerprint, result, settled: false })
    void result.then(() => {
      const claim = this.fileReferencePastes.get(requestId)
      if (claim?.result === result) claim.settled = true
    }, () => undefined)
    // Failed preflight may be tried again after the owner explicitly reselects with a fresh key.
    void result.catch(() => {
      if (this.fileReferencePastes.get(requestId)?.result === result) this.fileReferencePastes.delete(requestId)
    })
    if (this.fileReferencePastes.size > 512) {
      for (const [key, claim] of this.fileReferencePastes) {
        if (key !== requestId && claim.settled) this.fileReferencePastes.delete(key)
        if (this.fileReferencePastes.size <= 512) break
      }
    }
    return result
  }

  private async availableFileReferenceTarget(sessionId: string, expectedIncarnationId: string): Promise<string> {
    if (!await this.options.database.companion('fileReferenceTargetAvailability', sessionId)) {
      throw new HostControlError(ERROR_CODES.revisionConflict, 'The destination was archived or removed; choose it again')
    }
    const live = this.options.manager.liveIncarnationId(sessionId)
    if (!live) throw new HostControlError(ERROR_CODES.revisionConflict, 'The destination stopped; choose it again')
    if (live !== expectedIncarnationId) {
      throw new HostControlError(ERROR_CODES.revisionConflict, 'The destination process changed; choose it again')
    }
    return live
  }

  private async searchFileReferences(raw: Record<string, unknown>): Promise<FileReferenceSearchResult> {
    const ownerId = text(raw, 'ownerId', 128)
    const requestId = text(raw, 'requestId', 128)
    const workspaceId = text(raw, 'workspaceId', 128)
    const sessionId = optionalText(raw, 'sessionId')
    const query = text(raw, 'query', 256).trim()
    if (!query || /[\p{Cc}\p{Cf}]/u.test(query)) invalid('Search needs visible text')
    this.fileReferenceSearches.get(ownerId)?.controller.abort()
    const controller = new AbortController()
    this.fileReferenceSearches.set(ownerId, { requestId, controller })
    try {
      const address = await this.options.database.companion('fileReferenceSearchAddress', workspaceId, sessionId)
      const root = sessionId && address.root
        ? this.options.manager.liveLaunchDirectory(sessionId) ?? address.root
        : address.root
      return await searchFileReferences(root, query, controller.signal)
    } finally {
      if (this.fileReferenceSearches.get(ownerId)?.requestId === requestId) {
        this.fileReferenceSearches.delete(ownerId)
      }
    }
  }

  private async availableHandoffSessions(sourceSessionId: string, sessionId: string): Promise<{
    source: SessionRecord
    target: SessionRecord
  }> {
    await this.sessionsChanged()
    if (sourceSessionId === sessionId) invalid('Choose a different destination session')
    const source = this.knownSessions.get(sourceSessionId)
    const target = this.knownSessions.get(sessionId)
    const workspaces = await this.options.database.listWorkspaces(true)
    const availableWorkspaces = new Set(
      workspaces.filter((workspace) => workspace.archivedAt === null).map((workspace) => workspace.workspaceId)
    )
    if (!source || source.archivedAt !== null || !availableWorkspaces.has(source.workspaceId)) {
      invalid('The handoff source session is unavailable')
    }
    if (!target || target.archivedAt !== null || !availableWorkspaces.has(target.workspaceId)) {
      invalid('The handoff destination is unavailable; choose it again')
    }
    return { source, target }
  }

  private handoffText(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) invalid('Handoff text must not be empty')
    if (new TextEncoder().encode(value).byteLength > HANDOFF_TEXT_BYTES) {
      invalid('Handoff text must be at most 16 KiB')
    }
    return value
  }

  private handoffArtifactIds(value: unknown): string[] {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
      invalid('Handoff artifacts must be stored artifact IDs')
    }
    const distinct = [...new Set(value)]
    if (distinct.length !== value.length) invalid('Choose each handoff file only once')
    if (distinct.length > HANDOFF_ARTIFACTS) invalid('Choose at most 10 handoff files')
    return distinct
  }

  private async validateHandoffArtifacts(sourceSessionId: string, artifactIds: string[]): Promise<ArtifactRecord[]> {
    const artifacts: ArtifactRecord[] = []
    for (const artifactId of artifactIds) {
      const artifact = await this.readyArtifact(artifactId)
      if (artifact.sessionId !== sourceSessionId) invalid('Every handoff file must belong to the source session')
      artifacts.push(artifact)
    }
    return artifacts
  }

  /**
   * Story 75.5: `bmn handoff` stores the text, with the list of its attached files, as a file of the sending
   * session, and queues a bounded, stamped pointer to it as a message for the receiving agent's own hook. Nobody
   * reviews or pastes it. A receiver in any unarchived workspace may be named, under the message limits; the
   * provider is asked at hand-over for the sender's folder and every attached file's. It is stored in one
   * transaction or not at all, and then the stored bytes and their link are removed too.
   */
  private async queueAgentHandoff(p: {
    sourceSessionId: string
    sourceIncarnationId: string
    destinationSessionId: string
    text: string
    artifactIds: string[]
    senderCwd: string
  }): Promise<{ draftId: string; state: 'queued' }> {
    if (this.options.manager.liveIncarnationId(p.sourceSessionId) !== p.sourceIncarnationId) {
      invalid('The source session is running a different process now')
    }
    await this.availableHandoffSessions(p.sourceSessionId, p.destinationSessionId)
    this.handoffText(p.text)
    if (hasDisallowedHandoffControl(p.text)) {
      invalid('Handoff text may contain only newline and tab control characters')
    }
    const artifacts = await this.validateHandoffArtifacts(p.sourceSessionId, this.handoffArtifactIds(p.artifactIds))
    if (artifacts.some((artifact) => artifact.direction !== 'output')) {
      invalid('Every agent handoff file must be a published output from its session')
    }
    const prepared = await this.messages.prepareHandoff({
      senderSessionId: p.sourceSessionId, senderIncarnationId: p.sourceIncarnationId, senderCwd: p.senderCwd,
      destinationSessionId: p.destinationSessionId,
      attachments: artifacts.map((artifact) => ({ artifactId: artifact.artifactId, name: artifact.originalName, sourcePath: artifact.sourcePath }))
    })
    const files = await Promise.all(artifacts.map(async (artifact) => ({
      name: artifact.originalName, path: this.quotePath(await this.prepareArtifactLink(artifact))
    })))
    const draftId = randomUUID()
    const bytes = new TextEncoder().encode(sessionHandoffFileText(prepared.stamp, p.text, files))
    if (bytes.byteLength > HANDOFF_PAYLOAD_BYTES) invalid('The assembled handoff must be at most 64 KiB')
    const installed = await this.files.importBytes(bytes, {
      artifactId: randomUUID(), originalName: `handoff-${draftId.slice(0, 8)}.md`
    }).catch(fileError)
    const file: ArtifactRecord = {
      artifactId: installed.artifactId, sessionId: p.sourceSessionId, incarnationId: p.sourceIncarnationId,
      direction: 'output', source: 'agent', originalName: installed.originalName, mediaType: installed.mediaType,
      byteLength: installed.byteLength, sha256: installed.sha256, storedPath: installed.storedPath, sourcePath: null,
      state: 'ready', createdAt: this.iso()
    }
    let link: string | null = null
    const removeStored = async (): Promise<void> => {
      if (link !== null) await rm(link, { force: true }).catch(() => undefined)
      await rm(installed.storedPath, { force: true }).catch(() => undefined)
    }
    let outcome: SendOutcome
    try {
      link = await this.prepareArtifactLink(file)
      const pointer = sessionHandoffPointer({ handoffId: draftId, filePath: this.quotePath(link), bytes: bytes.byteLength, files })
      if (pointer === null) invalid("The path of BMN's data folder is too long for a handoff to name")
      // The reads above took time: the handoff is the word of the process that asked, and of no later one.
      if (this.options.manager.liveIncarnationId(p.sourceSessionId) !== p.sourceIncarnationId) {
        invalid('The source session is running a different process now')
      }
      outcome = await this.options.database.companion('queueAgentHandoff', {
        handoffId: draftId, messageId: randomUUID(), senderSessionId: p.sourceSessionId,
        receiverSessionId: p.destinationSessionId, senderRoot: prepared.senderRoot, stamp: prepared.stamp, pointer,
        text: p.text, file, attachmentIds: artifacts.map((artifact) => artifact.artifactId),
        receiverRefusal: prepared.receiverRefusal
      }, this.iso())
    } catch (error) {
      await removeStored()
      throw error
    }
    if (!outcome.accepted) {
      await removeStored()
      return this.messages.paused(outcome, {
        senderSessionId: p.sourceSessionId, senderIncarnationId: p.sourceIncarnationId, destinationSessionId: p.destinationSessionId
      })
    }
    this.emit('artifacts', p.sourceSessionId)
    this.messages.handoffQueued()
    return { draftId, state: 'queued' }
  }

  private async withdrawAgentHandoff(sourceSessionId: string, draftId: string): Promise<AttentionRecord> {
    return this.withDraft(draftId, async () => {
      const record = await this.options.database.companion('withdrawAgentHandoff', sourceSessionId, draftId, this.iso())
      this.emit('attention', sourceSessionId)
      this.emit('drafts', null)
      return record
    })
  }

  private async refreshHandoffStaleness(): Promise<void> {
    await this.sessionsChanged()
    const live = Object.fromEntries([...this.knownSessions.values()]
      .filter((session) => session.lastProcess?.state === 'live')
      .map((session) => [session.sessionId, session.lastProcess!.incarnationId]))
    if (Object.keys(live).length > 0) {
      await this.options.database.companion('markStaleAgentHandoffs', live)
    }
  }

  /** An uncertain Telegram or control draft is copied for an explicit retry; a handoff is never retried here. */
  private async retryDraft(draftId: string): Promise<InputDraftRecord> {
    return this.withDraft(draftId, async () => {
      const draft = await this.options.database.companion('getDraft', draftId)
      if (draft.origin === 'handoff' || draft.state !== 'uncertain') invalid('Only an uncertain draft can be copied for an explicit retry')
      const { record } = await this.options.database.companion('createDraft', {
        draftId: randomUUID(), sessionId: draft.sessionId, origin: draft.origin, originKey: null,
        requestId: null, text: draft.text, artifactId: draft.artifactId,
        state: 'draft', detail: `Retry of ${draft.draftId}; check the terminal for an earlier delivery`
      }, this.iso())
      this.emit('drafts', draft.sessionId)
      return record
    })
  }

  private async sendDraft(
    draftId: string,
    submit: boolean,
    expectedIncarnationId: string | null = null,
    expectedUpdatedAt: string | null = null
  ): Promise<unknown> {
    return this.withDraft(draftId, async () => this.sendDraftLocked(
      draftId,
      submit,
      expectedIncarnationId,
      expectedUpdatedAt
    ))
  }

  private async sendDraftLocked(
    draftId: string,
    submit: boolean,
    expectedIncarnationId: string | null,
    expectedUpdatedAt: string | null
  ): Promise<unknown> {
    const database = this.options.database
    const draft = await database.companion('getDraft', draftId)
    // A handoff reaches its agent through that agent's own hook, never typed into a terminal (Story 75.5).
    if (draft.origin === 'handoff') invalid('A handoff is never typed into a terminal')
    if (draft.state === 'uncertain') {
      throw new HostControlError(ERROR_CODES.revisionConflict,
        'Input delivery is uncertain; inspect the terminal and create a separate retry draft')
    }
    if (draft.state !== 'draft') invalid('Only an unsent draft can be sent')
    const availabilityEpoch = this.fileReferenceAvailabilityEpoch
    const incarnation = expectedIncarnationId ?? this.options.manager.liveIncarnationId(draft.sessionId)
    if (!incarnation) throw new HostControlError(ERROR_CODES.notFound, 'The target session has no live process')
    await this.availableFileReferenceTarget(draft.sessionId, incarnation)
    const artifact = draft.artifactId ? await this.readyArtifact(draft.artifactId) : null
    const path = artifact ? await this.prepareArtifactLink(artifact) : null
    const payload = [draft.text, path ? `${this.quotePath(path)} ` : null].filter(Boolean).join('\n')
    if (!payload) invalid('The draft is empty')
    if (new TextEncoder().encode(payload).byteLength > HANDOFF_PAYLOAD_BYTES) invalid('The draft must be at most 64 KiB')
    const claim = await database.companion('claimInputDraft', draftId, expectedUpdatedAt ?? draft.updatedAt, incarnation, this.iso())
    if (!claim.claimed) {
      throw new HostControlError(
        ERROR_CODES.revisionConflict, 'The draft was already sent or its delivery is uncertain'
      )
    }
    this.emit('drafts', draft.sessionId)
    try {
      await this.availableFileReferenceTarget(draft.sessionId, incarnation)
      this.ensureFileReferenceAvailabilityUnchanged(availabilityEpoch)
      if (this.options.manager.liveIncarnationId(draft.sessionId) !== incarnation) {
        throw new HostControlError(ERROR_CODES.revisionConflict, 'The destination process changed before input was sent')
      }
    } catch (error) {
      await database.companion('updateDraft', draftId, 'draft', 'Nothing sent; review the destination before retrying', this.iso())
      this.emit('drafts', draft.sessionId)
      throw error
    }
    // Text and its attachment reach the same incarnation in one write; Enter follows the whole payload.
    this.options.manager.writeToSession(draft.sessionId, bracketedPaste(payload, submit))
    const record = await database.companion('updateDraft', draftId, submit ? 'submitted' : 'accepted', null, this.iso())
    this.emit('drafts', draft.sessionId)
    return record
  }

  /** Writes a backup and checks the copy at once against its manifest and its own database (Story 75.7). */
  private async exportBackup(parent: string): Promise<BackupExportResult> {
    if (!isAbsolute(parent)) invalid('The backup location must be an absolute path')
    const createdAt = this.iso()
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(parent, `bmn-backup-${createdAt.replaceAll(':', '-')}-`))
    await mkdir(join(directory, 'artifacts'), { recursive: true, mode: 0o700 })
    const databaseFile = join(directory, 'state.sqlite3')
    await this.options.database.backupInto(databaseFile)
    const artifacts: BackupManifest['artifacts'] = []
    // Read the snapshot, not the live table, so the manifest names exactly the ready artifacts the backup database holds.
    for (const artifact of await this.options.database.readyArtifactsInBackup(databaseFile)) {
      const file = backupArtifactFile(artifact)
      await mkdir(dirname(join(directory, file)), { recursive: true, mode: 0o700 })
      await copyFile(artifact.storedPath, join(directory, file))
      const copied = await sha256File(join(directory, file))
      if (copied.sha256 !== artifact.sha256) {
        throw new HostControlError(ERROR_CODES.ioError, `Artifact ${artifact.originalName} changed while backing up`)
      }
      artifacts.push({ file, artifactId: artifact.artifactId, ...copied })
    }
    const manifest: BackupManifest = {
      formatVersion: 1,
      createdAt,
      database: { file: 'state.sqlite3', ...(await sha256File(databaseFile)) },
      artifacts,
      excluded: ['Telegram bot token', 'control socket credentials', 'saved terminal output', 'retained hook event history', 'live question producer bindings']
    }
    const manifestPath = join(directory, 'manifest.json')
    await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await rename(`${manifestPath}.tmp`, manifestPath)
    return { directory, manifest, verification: await this.verifyBackup(directory) }
  }

  private async verifyBackup(directory: string): Promise<BackupVerifyResult> {
    if (!isAbsolute(directory)) invalid('The backup location must be an absolute path')
    let manifest: BackupManifest
    try {
      const parsed: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
      if (!isBackupManifest(parsed)) throw new Error()
      manifest = parsed
    } catch {
      return { directory, ok: false, checked: 0, failures: [{ file: 'manifest.json', reason: 'unreadable-manifest' }] }
    }
    const entries: BackupManifestEntry[] = [manifest.database, ...manifest.artifacts]
    const failures: BackupVerifyResult['failures'] = []
    for (const entry of entries) {
      const path = join(directory, entry.file)
      if (relative(directory, path).startsWith('..')) {
        failures.push({ file: entry.file, reason: 'unreadable-manifest' })
        continue
      }
      const actual = await sha256File(path).catch(() => undefined)
      if (!actual) failures.push({ file: entry.file, reason: 'missing' })
      else if (actual.sha256 !== entry.sha256 || actual.byteLength !== entry.byteLength) {
        failures.push({ file: entry.file, reason: 'hash-mismatch' })
      }
    }
    // Hashes only prove the listed files; the database says which artifacts the backup must hold.
    if (failures.length === 0) {
      const recorded = await this.options.database.readyArtifactsInBackup(join(directory, manifest.database.file))
        .catch(() => undefined)
      if (!recorded) {
        failures.push({ file: manifest.database.file, reason: 'unreadable-database' })
      } else {
        const listed = new Map(manifest.artifacts.map((entry) => [entry.artifactId, entry]))
        const recordedById = new Map(recorded.map((artifact) => [artifact.artifactId, artifact]))
        for (const artifact of recorded) {
          const entry = listed.get(artifact.artifactId)
          if (!entry) {
            failures.push({ file: backupArtifactFile(artifact), reason: 'not-in-manifest' })
          } else if (
            entry.file !== backupArtifactFile(artifact) ||
            entry.sha256 !== artifact.sha256 ||
            entry.byteLength !== artifact.byteLength
          ) {
            failures.push({ file: entry.file, reason: 'database-mismatch' })
          }
        }
        for (const entry of manifest.artifacts) {
          if (!recordedById.has(entry.artifactId)) {
            failures.push({ file: entry.file, reason: 'database-mismatch' })
          }
        }
      }
    }
    return { directory, ok: failures.length === 0, checked: entries.length, failures }
  }

  private tokenPath(): string {
    return join(this.options.roots.config, TELEGRAM_TOKEN_FILE)
  }

  private async readTelegramToken(): Promise<string | null> {
    const token = (await readFile(this.tokenPath(), 'utf8').catch(() => '')).trim()
    return token.length > 0 ? token : null
  }

  private async configureTelegram(token: unknown): Promise<TelegramStatus> {
    if (token === null) {
      await rm(this.tokenPath(), { force: true })
    } else {
      if (typeof token !== 'string' || !/^\d{3,20}:[A-Za-z0-9_-]{20,80}$/.test(token.trim())) {
        invalid('The bot token does not look like a Telegram bot token')
      }
      await mkdir(this.options.roots.config, { recursive: true, mode: 0o700 })
      const temporary = `${this.tokenPath()}.${randomUUID()}.tmp`
      await writeFile(temporary, `${token.trim()}\n`, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.tokenPath())
    }
    await this.restartTelegram()
    return this.telegramStatus()
  }

  private async telegramStatus(): Promise<TelegramStatus> {
    const quietHours = await this.quietDelivery.status().catch(() => undefined)
    const token = this.telegramToken ?? await this.readTelegramToken()
    const redact = (value: string | null): string | null => value && token ? redactToken(value, token) : value
    if (this.telegram && this.telegramHealth) {
      return {
        state: this.telegramHealth.state,
        detail: redact(this.telegramHealth.detail) ?? '',
        tokenMask: token ? maskToken(token) : null,
        lastPollAt: this.telegramHealth.lastPollAt,
        lastError: redact(this.telegramHealth.lastError),
        rejectedUpdates: this.telegramHealth.rejectedUpdates,
        failingSince: this.telegramHealth.failingSince,
        ...(this.telegramHealth.menu ? { menu: { state: this.telegramHealth.menu.state, error: redact(this.telegramHealth.menu.error) } } : {}),
        ...(quietHours ? { quietHours } : {})
      }
    }
    const settings = await this.options.database.companion('getSettings')
    return {
      state: settings.telegram.enabled ? 'unconfigured' : 'disabled',
      detail: this.telegramDetail,
      tokenMask: token ? maskToken(token) : null,
      lastPollAt: null,
      lastError: null,
      rejectedUpdates: 0,
      failingSince: null,
      ...(quietHours ? { quietHours } : {})
    }
  }

  private async restartTelegram(savedAt?: Date): Promise<void> {
    this.telegramReady = false
    const previous = this.telegram
    this.telegram = undefined
    this.telegramHealth = undefined
    await previous?.stop().catch(() => undefined)
    const settings: AppSettings = await this.options.database.companion('getSettings')
    this.quietSettings = settings.telegram.quietHours ?? { ...DEFAULT_TELEGRAM_QUIET_HOURS }
    this.digestSettings = settings.telegram.morningDigest ?? { ...DEFAULT_TELEGRAM_MORNING_DIGEST }
    this.healthSettings = settings.telegram.healthAlerts ?? { ...DEFAULT_TELEGRAM_HEALTH_ALERTS }
    await this.healthAlerts.configure(savedAt).catch(() => undefined)
    const token = await this.readTelegramToken()
    this.telegramToken = token
    if (!settings.telegram.enabled) {
      this.telegramDetail = 'Telegram is off'
    } else if (!token) {
      this.telegramDetail = 'Add a bot token to connect Telegram'
    } else if (settings.telegram.allowedChatId === null) {
      this.telegramDetail = 'Choose the allowed chat to connect Telegram'
    } else {
      const connector = new TelegramConnector({
        token,
        ...(this.options.telegramApiOrigin ? { apiOrigin: this.options.telegramApiOrigin } : {}),
        allowedChatId: settings.telegram.allowedChatId,
        allowedUserId: settings.telegram.allowedUserId,
        fetch: this.options.fetch ?? fetch,
        lockDirectory: this.options.roots.runtime,
        offset: {
          get: async () => {
            const value = await this.options.database.companion('getRawSetting', TELEGRAM_OFFSET_KEY)
            return typeof value === 'number' ? value : null
          },
          set: (next) => this.options.database.companion('putRawSetting', TELEGRAM_OFFSET_KEY, next, this.iso())
        },
        onReply: (reply) => this.handleTelegramReply(reply),
        onTap: (tap) => tap.data.startsWith(GRANT_TOKEN_PREFIX) ? this.grantCards.tap(tap) : this.cards.tap(tap),
        onHealth: (health) => {
          if (this.telegram !== connector) return
          const entered = health.state !== this.telegramHealth?.state
          if (entered) this.telegramStateEntry += 1
          this.telegramHealth = health
          // Cards a previous run left with buttons are finished once Telegram is reachable, before new pages.
          if (health.state === 'polling' && (entered || !this.telegramReady) && !this.telegramRecovery) {
            this.telegramRecovery = this.cards.sweep().then(async ready => {
              if (this.telegram !== connector) return
              this.telegramReady = ready
              // Story 84.3: an open departure card is redrawn on its own message with fresh buttons after a restart.
              if (this.telegramHealth?.state === 'polling') void this.grantCards.reconcile()
              if (ready && this.telegramHealth?.state === 'polling') {
                try { await this.quietDelivery.sweep() }
                finally {
                  if (this.telegram === connector && this.telegramHealth?.state === 'polling') this.pager.retryUnsent()
                }
              }
            }).catch(() => undefined).finally(() => {
              this.telegramRecovery = undefined
            })
          }
          // An entry into a stopped state travels with its event, as it is now, so no later change can hide it.
          this.options.emit({
            kind: 'app-event',
            topic: 'telegram',
            sessionId: null,
            ...(entered && (health.state === 'conflict' || health.state === 'unauthorized')
              ? { telegramEntry: { host: this.telegramHost, entry: this.telegramStateEntry, state: health.state,
                  detail: redactToken(health.detail, token).slice(0, 500) } }
              : {})
          })
        }
      })
      this.telegram = connector
      this.telegramHealth = connector.health()
      try {
        await connector.start()
      } catch (error) {
        this.telegramHealth = connector.health()
        this.telegramDetail = redactToken(error instanceof Error ? error.message : 'Telegram could not start', token)
      }
    }
    this.emit('telegram', null)
  }

  /** Whether agent-history cleanup is deleting this conversation right now (Resume refuses it meanwhile). */
  historyDeleting(conversationId: string): boolean {
    return this.history.isDeleting(conversationId)
  }

  /**
   * A reply is addressed only by the notification it replies to. Without that correlation it is refused;
   * with it, text becomes a draft for that session unless the owner opted into automatic submission. A reply
   * to a question card that offers Other… is the card's own (Story 31.4).
   */
  private async handleTelegramReply(reply: InboundReply): Promise<void> {
    const connector = this.telegram
    if (!connector) return
    const bot = createHash('sha256').update(this.telegramToken ?? 'unconfigured').digest('hex')
    // Story 76.3: /away and /back come before Other answers and ordinary replies, whether or not they reply to a card.
    const away = telegramAwayCommand(reply, () => connector.botUsername())
    if (away) return this.telegramAway(connector, reply, away, bot)
    // Story 78.6: /help, and any other command for this bot, is answered with help before a card or a session sees it.
    const other = telegramOtherCommand(reply, () => connector.botUsername())
    if (other === 'elsewhere') return
    if (other !== null) return this.telegramCommandReply(connector, reply, TELEGRAM_HELP_TEXT, bot)
    // Story 84.3: a departure card is answered with its buttons only; a typed reply to one does nothing else.
    if (reply.replyToMessageId !== null && this.grantCards.owns(reply.replyToMessageId)) return this.telegramCommandReply(connector, reply, GRANT_TYPED_REPLY, bot)
    const key = `telegram-reply:${bot}:${reply.updateId}`
    const pending = this.telegramReplyOperations.get(key)
    if (pending) return pending
    const database = this.options.database
    const operation = (async () => {
      // Claim the inbound update before either Other or conversation handling. Telegram can
      // redeliver an update after offset-save failure/reconnect, even when the original card finished.
      if (await database.companion('getReceipt', key)) return
      const paramsHash = createHash('sha256').update(JSON.stringify(reply)).digest('hex')
      await database.companion('putReceipt', { key, paramsHash, state: 'staged' }, this.iso())
      if (this.telegram !== connector) return
      await this.handleTelegramReplyOnce(reply)
      await database.companion('putReceipt', { key, paramsHash, state: 'done' }, this.iso())
    })()
    this.telegramReplyOperations.set(key, operation)
    try { await operation } finally {
      if (this.telegramReplyOperations.get(key) === operation) this.telegramReplyOperations.delete(key)
    }
  }

  /**
   * Story 76.6 AC4: Waiting on you for the `/back` reply, masked and clipped per field; and the period's cards that went
   * on without him (Epic 78, owner 2026-10-17). Each is null when it could not be read.
   */
  private async telegramWaiting(period: { since: string | null; endedAt: string | null }): Promise<{
    waiting: string[] | null; more: number; wentOn: string[] | null; wentOnMore: number
  }> {
    const database = this.options.database
    const home = this.options.home ?? homedir()
    const field = (text: string, limit: number): string => phoneField(text, home, limit)
    const names = await database.companion('awaySessionNames').catch(() => null)
    const name = (sessionId: string): string | null => names?.[sessionId] ?? null
    let waiting: string[] | null = null
    let more = 0
    let wentOn: string[] | null = null
    let wentOnMore = 0
    if (names !== null) {
      try {
        ({ lines: waiting, more } = awayTelegramWaiting(await database.companion('listAttention'), name, field))
      } catch { /* said as could not be read */ }
      if (period.since !== null && period.endedAt !== null) {
        try {
          const closed = await database.companion('awayWentOn', { since: period.since, until: period.endedAt, limit: AWAY_SUMMARY_LIMITS.wentOn })
          ;({ lines: wentOn, more: wentOnMore } = awayTelegramWentOn(closed.records, name, field))
          wentOnMore += closed.total - closed.records.length
        } catch { /* said as could not be read */ }
      }
    }
    return { waiting, more, wentOn, wentOnMore }
  }

  /**
   * Story 76.3 AC4: the state change carries the update's key, stored in the same operation, so a redelivered update neither
   * repeats nor reverses it. The reply is claimed before it is sent and sent again only when Telegram definitely refused
   * it; a reply that failed leaves the state as it is.
   */
  private async telegramAway(connector: TelegramConnector, reply: InboundReply, command: TelegramAwayCommand, bot: string): Promise<void> {
    const operationKey = `telegram:${bot}:${reply.updateId}`
    const before = this.awayRecord.state
    const noteBefore = this.awayRecord.note
    let note: 'none' | 'kept' | 'replaced' | 'too-long' | 'refused' = 'none'
    let result = await this.changeAway(command.to === 'away'
      ? { to: 'away', source: 'telegram', operationKey, ...(command.note === null ? {} : { note: command.note }) }
      : { to: 'back', source: 'telegram', operationKey })
    if (result.outcome === 'invalid' && command.to === 'away') {
      // Leaving never fails for a refused note: away is set and only the note is refused (Fable's question 2), with its reason.
      note = command.note !== null && [...command.note].length > AWAY_NOTE_LIMIT ? 'too-long' : 'refused'
      result = await this.changeAway({ to: 'away', source: 'telegram', operationKey })
    } else if (command.to === 'away' && command.note !== null) note = before === 'away' && noteBefore !== command.note ? 'replaced' : 'kept'
    const record = result.record
    const text = command.to === 'away'
      ? record.state === 'away' && record.since !== null
        ? awayReplyText({ since: record.since, repeated: result.outcome !== 'repeated' && before === 'away', note, now: this.now() })
        : 'Not away; nothing changed.'
      : backReplyText({
        since: record.since, endedAt: record.endedAt, changed: record.state === 'back' && (result.outcome === 'changed' || result.outcome === 'repeated'),
        now: this.now(), ...await this.telegramWaiting(record)
      })
    return this.telegramCommandReply(connector, reply, text, bot)
  }

  /** The bot's own reply to a command, once per update, retried only when Telegram said no. */
  private async telegramCommandReply(connector: TelegramConnector, reply: InboundReply, text: string, bot: string): Promise<void> {
    const replyKey = `telegram-away-reply:${bot}:${reply.updateId}`
    const database = this.options.database
    if (await database.companion('getReceipt', replyKey)) return
    const paramsHash = createHash('sha256').update(text).digest('hex')
    await database.companion('putReceipt', { key: replyKey, paramsHash, state: 'staged' }, this.iso())
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await connector.sendMessage(text, { replyToMessageId: reply.messageId })
        await database.companion('putReceipt', { key: replyKey, paramsHash, state: 'done' }, this.iso())
        return
      } catch (error) {
        // Only an answer from Telegram saying no proves the reply was not sent; anything else may have been delivered.
        if (!(error instanceof TelegramConnectorError) || error.kind !== 'http' || attempt === 1) return
      }
    }
  }

  private async handleTelegramReplyOnce(reply: InboundReply): Promise<void> {
    const connector = this.telegram
    if (!connector) return
    // A reply to a card that offers Other… is its typed answer (or refused), never a draft or a prompt.
    if (await this.cards.typedReply(reply)) return
    const database = this.options.database
    const target = reply.replyToMessageId === null
      ? undefined
      : await database.companion('getTelegramMessage', reply.replyToMessageId)
    if (!target || !this.knownSessions.has(target.sessionId)) {
      await connector.sendMessage('Reply to a notification so BMN knows which session this is for.', {
        replyToMessageId: reply.messageId
      }).catch(() => undefined)
      return
    }
    const manual = target.requestId ? await this.options.database.companion('getAttention', target.requestId).catch(() => null) : null
    if (manual?.manualChoices && manual.state === 'open' && reply.text && !reply.file) {
      if (target.revision !== manual.revision) {
        await connector.sendMessage('Nothing sent. This card changed; use its latest controls or open the request at the laptop.',
          { replyToMessageId: reply.messageId }).catch(() => undefined)
        return
      }
      const policy = await this.options.database.companion('getSettings')
      if (policy.telegram.autoSubmitReplies && (manual.kind !== 'permission' || policy.telegram.answerPermissions)) {
        const outcome = await this.answerManual(manual, {
          requestId: manual.requestId, revision: manual.revision, epoch: -1, incarnationId: target.incarnationId ?? '',
          answer: { type: 'choices', choices: [{ typed: reply.text }] }
        }, true)
        await connector.sendMessage(outcome.state === 'submitted' ? 'Message submitted to the named conversation.' :
          outcome.state === 'refused' ? 'Nothing sent. Review this card or its draft at the laptop.' : 'Submission uncertain. Check the laptop before retrying.',
          { replyToMessageId: reply.messageId }).catch(() => undefined)
        return
      }
    }
    const originKey = `telegram:${reply.updateId}`
    const attentionGeneration = this.attentionChanges.get(target.sessionId)?.generation ?? 0
    const availabilityEpoch = this.fileReferenceAvailabilityEpoch
    let artifactId: string | null = null
    if (reply.file) {
      const downloaded = await connector.downloadFile(reply.file.fileId, TELEGRAM_DOWNLOAD_BYTES)
      const installed = await this.files.importBytes(downloaded.bytes, {
        artifactId: randomUUID(),
        originalName: reply.file.fileName || basename(downloaded.filePath)
      })
      artifactId = (await this.recordImport(installed, {
        sessionId: target.sessionId, direction: 'input', source: 'telegram', sourcePath: null
      })).artifactId
    }
    const settings = await database.companion('getSettings')
    const { record, created } = await database.companion('createDraft', {
      draftId: randomUUID(),
      sessionId: target.sessionId,
      origin: 'telegram',
      originKey,
      requestId: target.requestId,
      text: reply.text,
      artifactId,
      state: 'draft',
      detail: null
    }, this.iso())
    if (!created) return
    this.emit('drafts', target.sessionId)
    const live = this.options.manager.liveIncarnationId(target.sessionId)
    const request = target.requestId
      ? await database.companion('getAttention', target.requestId).catch(() => undefined)
      : undefined
    const currentTarget =
      (!request || !this.requestExpired(request) && request.state !== 'expired') &&
      live !== undefined &&
      target.incarnationId !== null &&
      live === target.incarnationId &&
      (request === undefined || (request.sessionId === target.sessionId &&
      (request.incarnationId === null || request.incarnationId === target.incarnationId)))
    // A typed line cannot pick an option in the agent's own dialog, so a reply to one stays a draft.
    const structured = request?.state === 'open' && (request.prompt !== null || !!request.manualChoices)
    const ordinaryCard = !request || request.kind === 'notice' || request.kind === 'handoff' ||
      !!request.manualChoices && request.state !== 'open' ||
      request.kind === 'question' && request.state !== 'open' && request.prompt !== null ||
      request.prompt?.type === 'questions' && request.prompt.harness === 'codex' && request.prompt.shape === 'async-choice'
    if (settings.telegram.autoSubmitReplies && currentTarget && (ordinaryCard || request?.state === 'open' && !structured)) {
      let messageWriteAttempted = false
      try {
        if (ordinaryCard) {
          await this.withDraft(record.draftId, async () => {
            await database.companion('updateDraft', record.draftId, 'uncertain', 'Message submission pending', this.iso())
            const boundary = await database.companion('telegramMessageBoundary', target.sessionId)
            const open = boundary.attention
            if (this.options.manager.liveIncarnationId(target.sessionId) !== target.incarnationId ||
              this.fileReferenceAvailabilityEpoch !== availabilityEpoch || this.fileReferenceAvailabilityChanges > 0 ||
              (this.attentionChanges.get(target.sessionId)?.generation ?? 0) !== attentionGeneration ||
              (this.attentionChanges.get(target.sessionId)?.pending ?? 0) > 0 ||
              !boundary.settings.telegram.autoSubmitReplies || !boundary.available ||
              request && !this.producers.current(request, !request.manualChoices) ||
              open.some(row => row.state === 'open' && row.sessionId === target.sessionId &&
                this.nativeMessageBlocker(row))) {
              await database.companion('updateDraft', record.draftId, 'draft', 'Nothing submitted; session changed or a native dialog is open', this.iso())
              throw new HostControlError(ERROR_CODES.revisionConflict, 'Answer the current native dialog first')
            }
            // One synchronous text write after the final incarnation/dialog checks. Attachments stay drafts.
            if (!record.text || record.artifactId || hasDisallowedHandoffControl(record.text)) {
              await database.companion('updateDraft', record.draftId, 'draft', 'Send a text reply without an attachment', this.iso())
              throw new HostControlError(ERROR_CODES.revisionConflict, 'Send a text reply without an attachment')
            }
            messageWriteAttempted = true
            this.options.manager.writeToSession(target.sessionId, bracketedPaste(record.text, true))
            await database.companion('updateDraft', record.draftId, 'submitted', 'Ordinary message submitted; native answer not confirmed', this.iso())
            this.emit('drafts', target.sessionId)
          })
        } else await this.sendDraft(record.draftId, true, target.incarnationId)
        if (ordinaryCard && request) await this.clearSubmittedQuestionReminder(request.requestId, request.revision)
        if (reply.text && !ordinaryCard && request) {
          await database.companion(
            'closeAttention',
            { requestId: request.requestId, expectedRevision: request.revision },
            'answered',
            reply.text,
            this.iso(),
            'telegram'
          )
            .then(() => this.emit('attention', target.sessionId), () => undefined)
        }
        await connector.sendMessage(ordinaryCard ? 'Message submitted to this session. Native answer not confirmed.' : 'Sent to the session.', { replyToMessageId: reply.messageId }).catch(() => undefined)
        return
      } catch (error) {
        if (ordinaryCard && messageWriteAttempted) {
          await connector.sendMessage('Message submission is uncertain. Check this session before sending it again.',
            { replyToMessageId: reply.messageId }).catch(() => undefined)
          return
        }
        if (!(error instanceof HostControlError) || error.code !== ERROR_CODES.revisionConflict) {
          await database.companion(
            'updateDraft', record.draftId, 'uncertain', 'Automatic submission failed', this.iso()
          )
        }
      }
    }
    await connector.sendMessage(structured && !ordinaryCard
      ? 'Saved as a draft in BMN. A typed reply cannot pick an option in this dialog: tap a button or answer at the laptop.'
      : 'Saved as a draft in BMN for that session.', {
      replyToMessageId: reply.messageId
    }).catch(() => undefined)
  }
}

/** Story 78.5: what a Claude permission card says about Claude denying it by itself; never a guessed length. */
export function deadlineLine(deadline: PromptDeadline): string {
  if (deadline.state === 'none') return 'No auto-deny countdown shown at the laptop'
  if (deadline.state === 'unknown') return 'Auto-deny deadline unknown'
  const at = new Date(deadline.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `Claude denies this by itself at ${at} unless answered`
}
