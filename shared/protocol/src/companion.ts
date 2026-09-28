// MODULE: companion.ts - records, topics and settings for the host-side companion service
import type { ModelOriginAgent, ModelOriginCountry } from './model-origin'
import type { AttentionPrompt } from './attention-prompt'
import type { SessionRecord, WorkspaceRecord } from './workspace'

export type ArtifactDirection = 'input' | 'output'
export type ArtifactSource = 'owner' | 'agent' | 'telegram'
export type ArtifactState = 'ready' | 'missing' | 'corrupt'

/** An owned immutable original. `input` files were attached for an agent; `output` files were published by one. */
export interface ArtifactRecord {
  artifactId: string
  sessionId: string | null
  incarnationId: string | null
  direction: ArtifactDirection
  source: ArtifactSource
  originalName: string
  mediaType: string
  byteLength: number
  sha256: string
  storedPath: string
  sourcePath: string | null
  state: ArtifactState
  createdAt: string
}

export interface ArtifactPreview {
  artifactId: string
  kind: 'image' | 'text' | 'unsupported'
  mediaType: string
  /** Base64 bytes for images, UTF-8 text for text, null when unsupported. */
  content: string | null
  truncated: boolean
}

export type AttentionKind = 'question' | 'permission' | 'review' | 'notice' | 'handoff'
export type AttentionState = 'open' | 'answered' | 'withdrawn' | 'expired'

/** Agent-authored handoff text may contain line breaks and tabs, but no other C0/C1 controls. */
export function hasDisallowedHandoffControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

/**
 * Story 35.2: the optional outline of a complete handoff, one that lets the receiver start without asking.
 * `bmn handoff --outline` prints it, the owner's form inserts it and docs/agent-control.md shows it; a test holds
 * all three to this text. Nothing checks that a handoff fills it in (Epic 7 keeps sections optional).
 */
export const HANDOFF_OUTLINE = `Goal:

Where it stands:

Done and checked (with published evidence ids):

Left to do:

Risks and open questions:

How to check:`

/** A request stays open until correlated resolution arrives; seeing it only changes `seenAt`. */
export interface AttentionRecord {
  requestId: string
  sessionId: string
  incarnationId: string | null
  requestKey: string
  kind: AttentionKind
  title: string
  body: string | null
  state: AttentionState
  resolution: string | null
  openedAt: string
  expiresAt: string | null
  resolvedAt: string | null
  seenAt: string | null
  revision: number
  /** What opened the request, from the closed origin vocabulary; null for a row that predates provenance. */
  openedBy: AttentionOrigin | null
  /** What answered, withdrew or expired it; null while it is open or for a legacy row. */
  resolvedBy: AttentionOrigin | null
  /** The agent's own question or permission, as its hook reported it; null for plain requests. */
  prompt: AttentionPrompt | null
}

/**
 * Who or what acted on a request. `hook:<agent>:<Event>` names the harness hook that did it; the rest name
 * the owner's own routes. Free-form by shape so an unknown hook event still reads, closed by validation.
 */
export type AttentionOrigin = string

/**
 * Terminal notification sequences BMN reads from a session's own output: iTerm2's OSC 9, kitty's
 * OSC 99 and urxvt's OSC 777. A program that knows none of BMN still speaks these, so they are how
 * a harness without a BMN hook reaches Needs you. They open a `notice` and nothing else.
 */
export const TERMINAL_NOTICE_CODES = Object.freeze([9, 99, 777] as const)
export type TerminalNoticeCode = (typeof TERMINAL_NOTICE_CODES)[number]

/** Caps the renderer applies before sending; they mirror `RULES.title` and `RULES.body`, which enforce them. */
export const TERMINAL_NOTICE_TITLE_MAX = 200
export const TERMINAL_NOTICE_BODY_MAX = 8000

/** Further notices this soon after a row opened join it instead of opening another one. */
export const TERMINAL_NOTICE_WINDOW_MS = 2_000

export function terminalNoticeOrigin(code: TerminalNoticeCode): string {
  return `osc:${code}`
}

export const ATTENTION_ORIGINS = Object.freeze([
  'cli', 'owner', 'input', 'telegram', 'expiry',
  // App-assigned terminal notifications, repeat watch and plan-use watch. Never claimable by a token.
  ...TERMINAL_NOTICE_CODES.map(terminalNoticeOrigin),
  'watch:repeat',
  'watch:usage'
] as const)

/** Origins a session's own token may claim: its harness's hook events, and the CLI it runs itself. */
export const AGENT_ATTENTION_ORIGINS = Object.freeze(['cli'] as const)

/** `terminal` is not a harness: it is what a program's own OSC notification is logged as. */
export const HOOK_EVENT_AGENTS = Object.freeze(['claude', 'codex', 'opencode', 'cursor', 'terminal'] as const)
export type HookEventAgent = (typeof HOOK_EVENT_AGENTS)[number]

/** `RULES.source` size: the whole origin and a hook event name alike are at most this many characters. */
const ORIGIN_MAX = 64

/** The one place the closed origin vocabulary is decided, so every entry point accepts the same words. */
export function isAttentionOrigin(value: string): boolean {
  if (value.length < 1 || value.length > ORIGIN_MAX) return false
  if ((ATTENTION_ORIGINS as readonly string[]).includes(value)) return true
  if (!value.startsWith('hook:')) return false
  // Only the agent is split off: an event name may itself contain a colon, and the log should still read.
  const rest = value.slice('hook:'.length)
  const separator = rest.indexOf(':')
  if (separator < 0) return false
  return (HOOK_EVENT_AGENTS as readonly string[]).includes(rest.slice(0, separator)) &&
    isHookEventName(rest.slice(separator + 1))
}

/**
 * A hook event name the log will store: exactly the `RULES.source` shape the socket already enforces -
 * 1 to 64 characters with no control characters. Spaces and non-ASCII letters are names too, and an
 * unfamiliar event is precisely what the log exists to show.
 */
export function isHookEventName(value: string): boolean {
  if (value.length < 1 || value.length > ORIGIN_MAX) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x7f || code < 0x20) return false
  }
  return true
}

export const HOOK_EVENT_EFFECTS = Object.freeze(['opened', 'withdrew', 'answered'] as const)
export type HookEventEffect = (typeof HOOK_EVENT_EFFECTS)[number]

/** The most recent hook events of one session, kept in memory only so a restart starts an empty log. */
export interface HookEventRecord {
  sessionId: string
  /** The process incarnation that reported it; null for a row recorded before this was tracked. */
  incarnationId: string | null
  agent: HookEventAgent
  /** The harness's own event name, for example `PostToolUse`. */
  event: string
  /** The harness's `source` field, when it sent one. */
  source: string | null
  toolName: string | null
  /** Occurrences of this call in the last 20 fingerprinted tool events. */
  repeat: number | null
  /** What the event changed in Needs you; empty when it changed nothing. */
  effects: readonly HookEventEffect[]
  observedAt: string
}

/**
 * Whether one harness event says the conversation was compacted (Story 36.1), so each compaction
 * counts once. Claude Code, and Codex 0.157.1 after an automatic compaction, send `SessionStart`
 * with source `compact`; Codex's manual `/compact` sends only `PostCompact`, whose trigger the CLI
 * logs as the source (measured 2026-09-28, docs/agent-control.md). Codex's automatic `PostCompact`
 * is not counted because its `SessionStart` already was. OpenCode publishes `session.compacted`;
 * the CLI logs a subagent's with source `subagent`, which is not the owner's conversation.
 */
export function isCompactionEvent(record: Pick<HookEventRecord, 'agent' | 'event' | 'source'>): boolean {
  switch (record.agent) {
    case 'claude': return record.event === 'SessionStart' && record.source === 'compact'
    case 'codex': return (record.event === 'SessionStart' && record.source === 'compact') ||
      (record.event === 'PostCompact' && record.source === 'manual')
    case 'opencode': return record.event === 'session.compacted' && record.source !== 'subagent'
    default: return false
  }
}

/** The compactions one run has reported, kept in memory beside its hook observation. */
export interface HookCompaction {
  /** When BMN received the latest compaction event. */
  lastAt: string
  /** Compactions reported in this run; a new incarnation starts from none. */
  count: number
}

/**
 * The agents whose plan use BMN can read without a network call (Story 37.1, docs/usage-sources.md):
 * Claude Code through its status-line input, Codex through the `token_count` lines of its own session
 * file. `claude glm`, OpenCode and Cursor report no plan windows on this machine.
 */
export const USAGE_AGENTS = Object.freeze(['claude', 'codex'] as const)
export type UsageAgent = (typeof USAGE_AGENTS)[number]

/** Claude reports a five-hour and a weekly window; Codex a primary and a secondary one. */
export const MAX_USAGE_WINDOWS = 2

/** A window at or above this share of its limit opens one Needs you notice per reset period (Story 37.2). */
export const USAGE_NOTICE_PERCENT = 90

/** One plan window as the agent reported it: its length, how much of it is used, and when it starts over. */
export interface UsageWindow {
  minutes: number
  usedPercent: number
  resetsAt: string
}

/**
 * One reading of an agent's plan use, kept in memory only (a restart forgets it). A reading with no
 * windows still carries context use, as `claude glm` reports it; it never replaces an agent's plan reading.
 */
export interface UsageReading {
  sessionId: string
  incarnationId: string
  agent: UsageAgent
  windows: readonly UsageWindow[]
  /** How full the conversation's context window is, when the agent says so. */
  contextUsedPercent: number | null
  /** When BMN received or read it, independent of when the agent measured it. */
  readAt: string
}

/** What one run of a session reported about plan use, and whose harness it runs when it reported none. */
export interface SessionUsage {
  sessionId: string
  incarnationId: string | null
  reading: UsageReading | null
  /** The harness this run last reported through its hooks, or null when none has. */
  agent: Exclude<HookEventAgent, 'terminal'> | null
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** The whole percent BMN shows and the notice threshold compares, so a shown 90% is the one that notifies. */
export function usagePercent(value: number): number {
  return Math.round(value)
}

/** "5-hour" and "week" in a row; "5-hour" and "weekly" when naming the limit in a notice. */
export function usageWindowName(minutes: number, form: 'row' | 'limit'): string {
  if (minutes === 10_080) return form === 'row' ? 'week' : 'weekly'
  if (minutes === 1_440) return form === 'row' ? 'day' : 'daily'
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`
  if (minutes % 60 === 0) return `${minutes / 60}-hour`
  return `${minutes}-minute`
}

/** A local time a reader can place: "16:10" today, "Fri 09:00" within the week, "Oct 3 09:00" beyond it. */
export function usageClock(iso: string, now: Date): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '--:--'
  const pad = (value: number): string => String(value).padStart(2, '0')
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const day = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((day(at) - day(now)) / 86_400_000)
  if (days === 0) return clock
  if (days > 0 && days < 7) return `${WEEKDAYS[at.getDay()]} ${clock}`
  return `${MONTHS[at.getMonth()]} ${at.getDate()} ${clock}`
}

/** The most recent hook events the utility keeps per session; older ones are dropped. */
export const HOOK_EVENT_LOG_LIMIT = 30

/** At most one effect per slot the hook touches, so a malformed array is refused rather than stored. */
export const MAX_HOOK_EVENT_EFFECTS = 8

/**
 * The harnesses whose own hook files `bmn hooks check` reads. A report says what is *configured*,
 * never that a hook fired; the labels for that limit live with the report, not in the data.
 */
export const HOOK_CHECK_AGENTS = Object.freeze(['claude', 'codex', 'opencode', 'cursor'] as const)
export type HookCheckAgent = (typeof HOOK_CHECK_AGENTS)[number]

/** What the checker could do with one harness's hook file; the reason detail stays out of the window. */
export const HOOK_CHECK_FILE_STATES = Object.freeze(['read', 'missing', 'unreadable', 'unparsable', 'unusable'] as const)
export type HookCheckFileState = (typeof HOOK_CHECK_FILE_STATES)[number]

/** One expected entry as the checker read it: wired by BMN's own wording, an older one, or absent. */
export const HOOK_CHECK_ENTRY_STATES = Object.freeze(['wired', 'wired (older wording)', 'missing'] as const)
export type HookCheckEntryState = (typeof HOOK_CHECK_ENTRY_STATES)[number]

export interface HookCheckEntry {
  /** The harness's own event name the entry belongs to; `plugin` for OpenCode. */
  event: string
  /** Optional entries are reported but never required of the owner. */
  optional: boolean
  state: HookCheckEntryState
}

/** One harness's file as the checker read it: a path and states, never the file's contents. */
export interface HookCheckAgentReport {
  agent: HookCheckAgent
  file: string
  state: HookCheckFileState
  entries: readonly HookCheckEntry[]
  /** The required entries the file did not carry; an exit code of 1 for this is report data. */
  missing: readonly string[]
}

/**
 * A dated snapshot of what the hook checker found configured, or why no snapshot could be taken.
 * It is not a live watch of harness settings, and never a verdict that hooks work.
 */
export type HookCheckReport =
  | { state: 'checked'; checkedAt: string; ok: boolean; agents: readonly HookCheckAgentReport[] }
  | { state: 'failed'; checkedAt: string; reason: string }

/**
 * The latest harness event one run of a session actually reported to BMN, kept independently of the
 * bounded hook-event log so a summary survives that log's evictions. Terminal OSC notices are logged
 * as `terminal` and never count as a harness observation.
 */
export interface HookObservationObserved {
  state: 'observed'
  sessionId: string
  incarnationId: string
  agent: Exclude<HookEventAgent, 'terminal'>
  /** The harness's own event name, for example `PostToolUse`. */
  event: string
  /** When BMN received the event, independent of when the harness says it happened. */
  observedAt: string
  /** False once the bounded log has evicted this event's row, so its detail is no longer readable. */
  detailAvailable: boolean
  /** The compactions this run reported, or null when none was observed. */
  compaction: HookCompaction | null
}

/**
 * The model origin one run of a session last reported: the country of the company that made the
 * model (null when nothing known speaks), with the model name and API host that produced it. Kept
 * per live incarnation in memory only, like the hook observation it accompanies.
 */
export interface HookOriginRecord {
  state: 'observed'
  sessionId: string
  incarnationId: string
  agent: ModelOriginAgent
  /** ISO country code from `modelOrigin`, or null when the facts classify to no country. */
  country: ModelOriginCountry | null
  model: string | null
  apiHost: string | null
  /** When BMN received the facts, independent of when the harness says it ran. */
  observedAt: string
}

export interface HookObservationNone {
  state: 'none'
  sessionId: string
  /** The run the answer is about: the requested or live incarnation, or null when there is none. */
  incarnationId: string | null
}

/** No attributable event in the run this answer is about; that is an absence of evidence, not a verdict. */
export type HookObservation = HookObservationObserved | HookObservationNone

export type ProgressState =
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'claimed-done'
  | 'verified'
  | 'failed'
  | 'unknown'

export const PROGRESS_STALE_AFTER_MS = 10 * 60 * 1000

/**
 * One already-published file a report points at. The name is the artifact's display name as it was
 * when the link was made, so a deleted or renamed original is still nameable. Presence says the
 * reporter attached something, never that BMN checked the work.
 */
export interface ProgressEvidence {
  artifactId: string
  /** The artifact's display name at link time; kept even when the original is gone. */
  name: string
}

/** At most this many distinct evidence references on one observation. */
export const MAX_PROGRESS_EVIDENCE = 10

/** The latest observation per session and named source. */
export interface ProgressRecord {
  sessionId: string
  source: string
  incarnationId: string | null
  state: ProgressState
  label: string
  detail: string | null
  /** Empty for every legacy report and for any report that named no files. */
  evidence: ProgressEvidence[]
  observedAt: string
  receivedAt: string
}

export type InputDraftState = 'draft' | 'accepted' | 'submitted' | 'uncertain' | 'discarded'

/** Addressed input that was not delivered automatically; it never follows focus. */
export interface InputDraftRecord {
  draftId: string
  sessionId: string
  origin: 'telegram' | 'control' | 'handoff'
  sourceSessionId: string | null
  /** Null for owner and legacy drafts; an agent-prepared handoff still needs owner delivery. */
  preparedBy: 'agent' | null
  requestId: string | null
  text: string | null
  artifactId: string | null
  artifactIds: string[]
  attemptedIncarnationId: string | null
  state: InputDraftState
  detail: string | null
  createdAt: string
  updatedAt: string
}

export interface HandoffDraftSaveParams {
  draftId?: string
  sourceSessionId: string
  sessionId: string
  text: string
  artifactIds: string[]
  expectedUpdatedAt?: string
}

/** One coherent owner-only read of an exact handoff and its addressed sessions. */
export interface HandoffReviewSnapshot {
  draft: InputDraftRecord
  source: SessionRecord
  destination: SessionRecord
  sourceWorkspace: WorkspaceRecord
  destinationWorkspace: WorkspaceRecord
  /** Opaque revision of rows needed for review; never an authorization token. */
  token: string
}

export interface DraftSendExpectation {
  expectedIncarnationId?: string
  expectedUpdatedAt?: string
}

/** The header's emblem and motto, chosen independently of the colors. */
export type IdentityName = 'knight' | 'cross' | 'boss'
export const IDENTITY_NAMES: readonly IdentityName[] = Object.freeze(['knight', 'cross', 'boss'])
/** Chrome and terminal palette. Black is the default; Brown is the original warm Chancel look. */
export type ColorModeName = 'steel' | 'brown' | 'dark' | 'black'
export const COLOR_MODE_NAMES: readonly ColorModeName[] = Object.freeze(['steel', 'brown', 'dark', 'black'])
export const TERMINAL_FONT_SIZE_RANGE = Object.freeze({ min: 10, max: 24 } as const)

export interface AppearanceSettings {
  identity: IdentityName
  colorMode: ColorModeName
  terminalFontSize: number
}

export interface NotificationSettings {
  desktop: boolean
}

export interface TelegramSettings {
  enabled: boolean
  allowedChatId: number | null
  allowedUserId: number | null
  notifyOn: 'attention' | 'attention-and-exit'
  /** Replies are typed and submitted only when the owner opted in; otherwise they stay addressed drafts. */
  autoSubmitReplies: boolean
  /** Telegram may answer permission prompts (allow once or deny, never always); off until the owner turns it on. */
  answerPermissions: boolean
}

export type VoiceModelId = 'base' | 'small'
export const VOICE_MODEL_IDS: readonly VoiceModelId[] = Object.freeze(['base', 'small'])

/** Whisper language codes offered for dictation; `auto` lets Whisper detect the language. */
export const VOICE_LANGUAGES = Object.freeze([
  { code: 'auto', label: 'Detect automatically' },
  { code: 'en', label: 'English' },
  { code: 'uk', label: 'Українська' },
  { code: 'ru', label: 'Русский' },
  { code: 'pl', label: 'Polski' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' }
] as const)
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number]['code']

export interface VoiceSettings {
  model: VoiceModelId
  language: VoiceLanguage
  /** Absolute folder the owner chose for models; null keeps them in the app data folder. */
  modelFolder: string | null
  /** Holding Space in a terminal records until release; a quick tap still types a space. */
  holdSpaceToTalk: boolean
  /** Owner-approved words passed to Whisper as its initial prompt; empty keeps dictation unchanged. */
  vocabulary: string[]
}

export interface VoiceModelStatus {
  id: VoiceModelId
  label: string
  bytes: number
  installed: boolean
  /** Present while a download runs or after one failed. */
  download?: { receivedBytes: number; error?: string }
}

export interface VoiceStatus {
  /** False when the whisper.cpp binary was not built (`pnpm run voice:build`). */
  engineAvailable: boolean
  /** The folder models are read from and downloaded to; a chosen folder is unavailable while its disk is unmounted. */
  modelFolder: { path: string; custom: boolean; available: boolean }
  models: VoiceModelStatus[]
}

/** Days an archived session or workspace is kept before BMN deletes it; null never deletes. */
export type ArchiveDeleteAfterDays = 90 | 30 | 10 | null
export const ARCHIVE_DELETE_AFTER_DAYS: readonly ArchiveDeleteAfterDays[] = Object.freeze([null, 90, 30, 10])

export interface ArchiveSettings {
  deleteAfterDays: ArchiveDeleteAfterDays
}

/** Days every agent keeps a session untouched before its own mechanism deletes it; null keeps everything. */
export type AgentHistoryKeepDays = 10 | 30 | 90 | null
/** Shortest to longest, Never last: the order the segmented control shows. */
export const AGENT_HISTORY_KEEP_DAYS: readonly AgentHistoryKeepDays[] = Object.freeze([10, 30, 90, null])
/** What BMN writes as Claude's `cleanupPeriodDays` for Never; 0 is never written (docs/agent-history.md). */
export const CLAUDE_KEEP_FOREVER_DAYS = 36_500
/** At most this many sessions per agent are deleted in one run; the rest wait for the next. */
export const MAX_DELETIONS_PER_RUN = 200
/** Learned Claude config folders BMN remembers; the oldest is dropped first, `~/.claude` never. */
export const MAX_CLAUDE_CONFIG_DIRS = 8

export interface AgentHistorySettings {
  keepDays: AgentHistoryKeepDays
  /** The limit the owner last confirmed with Start cleanup; absent until the first press. */
  confirmedKeepDays?: AgentHistoryKeepDays
  /** Absolute Claude config folders learned from hook calls, oldest first. */
  claudeConfigDirs: string[]
}

export interface AppSettings {
  appearance: AppearanceSettings
  notifications: NotificationSettings
  telegram: TelegramSettings
  voice: VoiceSettings
  archive: ArchiveSettings
  agentHistory: AgentHistorySettings
}

/** One Claude-family config folder in Preferences → History. */
export interface AgentHistoryClaudeFolder {
  path: string
  /** "Claude Code" for `~/.claude`, "GLM" for a folder named `.claude-glm`, else "Claude". */
  name: string
  /** The path with the home folder written as `~`. */
  displayPath: string
  /** `cleanupPeriodDays` on disk now; null when unset (Claude's default). */
  currentDays: number | null
  /** The value BMN writes for the owner's limit. */
  targetDays: number
  /** The file differs from the target and waits for Start cleanup. */
  pending: boolean
  /** Last successful write by BMN. */
  applied?: { days: number; at: string }
  /** Why the last write or read failed, in one short phrase. */
  failure?: string
}

export type AgentHistoryAgent = 'codex' | 'opencode' | 'cursor'

export interface AgentHistoryRun {
  at: string
  deleted: number
  /** Candidates left for the next run (the per-run cap). */
  remaining: number
  failures: Array<{ id: string; reason: string }>
}

/** One agent BMN prunes by the agent's own delete command (Story 31.2). */
export interface AgentHistoryAgentRow {
  agent: AgentHistoryAgent
  /** `managed`: BMN counts and deletes; `unrecognised`: the store or command is not what BMN measured; `own`: the agent keeps its own history. */
  state: 'managed' | 'unrecognised' | 'own'
  detail?: string
  sessions?: number
  /** Sessions older than the owner's (pending) limit that a run would delete. */
  candidates?: number
  lastRun?: AgentHistoryRun
}

export interface AgentHistoryStatus {
  keepDays: AgentHistoryKeepDays
  confirmedKeepDays: AgentHistoryKeepDays | undefined
  /** Something waits for Start cleanup: the first press, a shorter limit, or a folder that differs. */
  needsConfirmation: boolean
  running: boolean
  claude: AgentHistoryClaudeFolder[]
  agents: AgentHistoryAgentRow[]
}

export const DEFAULT_APP_SETTINGS: AppSettings = Object.freeze({
  appearance: Object.freeze({ identity: 'knight', colorMode: 'black', terminalFontSize: 14 }),
  notifications: Object.freeze({ desktop: true }),
  telegram: Object.freeze({
    enabled: false,
    allowedChatId: null,
    allowedUserId: null,
    notifyOn: 'attention',
    autoSubmitReplies: false,
    answerPermissions: false
  }),
  voice: Object.freeze({ model: 'base', language: 'auto', modelFolder: null, holdSpaceToTalk: true, vocabulary: Object.freeze([]) as unknown as string[] }),
  archive: Object.freeze({ deleteAfterDays: null }),
  agentHistory: Object.freeze({ keepDays: 30, claudeConfigDirs: Object.freeze([]) as unknown as string[] })
}) as AppSettings

export type TelegramConnectorState =
  | 'disabled'
  | 'unconfigured'
  | 'starting'
  | 'polling'
  | 'backoff'
  | 'conflict'
  | 'unauthorized'
  | 'stopped'

export interface TelegramStatus {
  state: TelegramConnectorState
  detail: string
  tokenMask: string | null
  lastPollAt: string | null
  lastError: string | null
  rejectedUpdates: number
  /** When the current run of transient failures began; null once Telegram answers. */
  failingSince: string | null
}

/**
 * One entry into a state only the owner can fix, as it was when it happened. It rides on the `telegram` app event,
 * so each entry reaches the desktop notice with its own words however many follow before the notice is raised.
 * `host` names the utility process that numbered it; `entry` grows with every state change in that process.
 */
export interface TelegramOwnerEntry {
  host: string
  entry: number
  state: 'conflict' | 'unauthorized'
  detail: string
}

const MAX_TELEGRAM_DETAIL_CHARACTERS = 500

function isTelegramOwnerEntry(value: unknown): value is TelegramOwnerEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TelegramOwnerEntry>
  return (
    typeof candidate.host === 'string' && candidate.host.length > 0 && candidate.host.length <= 64 &&
    Number.isSafeInteger(candidate.entry) && candidate.entry! > 0 &&
    (candidate.state === 'conflict' || candidate.state === 'unauthorized') &&
    typeof candidate.detail === 'string' && candidate.detail.length <= MAX_TELEGRAM_DETAIL_CHARACTERS
  )
}

/** A shorter outage, such as a laptop waking up, retries quietly. */
export const TELEGRAM_UNREACHABLE_CUE_AFTER_MS = 5 * 60_000

/** `conflict` and `unauthorized` stop retrying: only the owner can fix them. */
export function telegramNeedsOwner(state: TelegramConnectorState): boolean {
  return state === 'conflict' || state === 'unauthorized'
}

/**
 * The one sentence that says Telegram is not delivering, or null. A stopped connector needs the owner at once;
 * a retrying one speaks only after five minutes without reaching the server. `clock` words a time as HH:MM.
 */
export function telegramOwnerCue(
  enabled: boolean,
  status: Pick<TelegramStatus, 'state' | 'detail' | 'failingSince'> | null,
  now: number,
  clock: (ms: number) => string = (ms) => new Date(ms).toTimeString().slice(0, 5)
): string | null {
  if (!enabled || !status) return null
  if (telegramNeedsOwner(status.state)) return `Telegram is not delivering: ${status.detail}`
  if (status.state !== 'backoff' || status.failingSince === null) return null
  const since = Date.parse(status.failingSince)
  if (!Number.isFinite(since) || now - since < TELEGRAM_UNREACHABLE_CUE_AFTER_MS) return null
  return `Telegram cannot reach the server since ${clock(since)} · retrying`
}

/** One list, because a topic the validator does not know is a message the window never receives. */
export const APP_EVENT_TOPICS = [
  'artifacts',
  'attention',
  'progress',
  'drafts',
  'hooks',
  'settings',
  'telegram',
  'conversations'
] as const

export type AppEventTopic = (typeof APP_EVENT_TOPICS)[number]

export interface AppEventMessage {
  kind: 'app-event'
  topic: AppEventTopic
  sessionId: string | null
  /** Story 32.2: on a `telegram` event, the entry into `conflict` or `unauthorized` that raised it. */
  telegramEntry?: TelegramOwnerEntry
}

export function isAppEventMessage(value: unknown): value is AppEventMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AppEventMessage>
  return (
    candidate.kind === 'app-event' &&
    typeof candidate.topic === 'string' &&
    (APP_EVENT_TOPICS as readonly string[]).includes(candidate.topic) &&
    (candidate.sessionId === null || typeof candidate.sessionId === 'string') &&
    (candidate.telegramEntry === undefined ||
      (candidate.topic === 'telegram' && isTelegramOwnerEntry(candidate.telegramEntry)))
  )
}

export interface BackupManifestEntry {
  file: string
  sha256: string
  byteLength: number
}

export interface BackupManifest {
  formatVersion: 1
  createdAt: string
  database: BackupManifestEntry
  artifacts: Array<BackupManifestEntry & { artifactId: string }>
  /** Named categories intentionally left out, such as credentials. */
  excluded: string[]
}

export interface BackupVerifyResult {
  directory: string
  ok: boolean
  checked: number
  failures: Array<{
    file: string
    reason:
      | 'missing'
      | 'hash-mismatch'
      | 'unreadable-manifest'
      | 'unreadable-database'
      | 'not-in-manifest'
      | 'database-mismatch'
  }>
}

export interface ControlInfo {
  socketPath: string
  cliPath: string
  listening: boolean
  detail: string
}
