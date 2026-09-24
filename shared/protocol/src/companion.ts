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
  // App-assigned terminal notifications and repeat watch. Never claimable by a token.
  ...TERMINAL_NOTICE_CODES.map(terminalNoticeOrigin),
  'watch:repeat'
] as const)

/** Origins a session's own token may claim: its harness's hook events, and the CLI it runs itself. */
export const AGENT_ATTENTION_ORIGINS = Object.freeze(['cli'] as const)

/** `terminal` is not a harness: it is what a program's own OSC notification is logged as. */
export const HOOK_EVENT_AGENTS = Object.freeze(['claude', 'codex', 'opencode', 'terminal'] as const)
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

/** The most recent hook events the utility keeps per session; older ones are dropped. */
export const HOOK_EVENT_LOG_LIMIT = 30

/** At most one effect per slot the hook touches, so a malformed array is refused rather than stored. */
export const MAX_HOOK_EVENT_EFFECTS = 8

/**
 * The harnesses whose own hook files `bmn hooks check` reads. A report says what is *configured*,
 * never that a hook fired; the labels for that limit live with the report, not in the data.
 */
export const HOOK_CHECK_AGENTS = Object.freeze(['claude', 'codex', 'opencode'] as const)
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

export interface AppSettings {
  appearance: AppearanceSettings
  notifications: NotificationSettings
  telegram: TelegramSettings
  voice: VoiceSettings
  archive: ArchiveSettings
}

export const DEFAULT_APP_SETTINGS: AppSettings = Object.freeze({
  appearance: Object.freeze({ identity: 'knight', colorMode: 'black', terminalFontSize: 14 }),
  notifications: Object.freeze({ desktop: true }),
  telegram: Object.freeze({
    enabled: false,
    allowedChatId: null,
    allowedUserId: null,
    notifyOn: 'attention',
    autoSubmitReplies: false
  }),
  voice: Object.freeze({ model: 'base', language: 'auto', modelFolder: null, holdSpaceToTalk: true, vocabulary: Object.freeze([]) as unknown as string[] }),
  archive: Object.freeze({ deleteAfterDays: null })
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
}

/** One list, because a topic the validator does not know is a message the window never receives. */
export const APP_EVENT_TOPICS = [
  'artifacts',
  'attention',
  'progress',
  'drafts',
  'settings',
  'telegram',
  'conversations'
] as const

export type AppEventTopic = (typeof APP_EVENT_TOPICS)[number]

export interface AppEventMessage {
  kind: 'app-event'
  topic: AppEventTopic
  sessionId: string | null
}

export function isAppEventMessage(value: unknown): value is AppEventMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AppEventMessage>
  return (
    candidate.kind === 'app-event' &&
    typeof candidate.topic === 'string' &&
    (APP_EVENT_TOPICS as readonly string[]).includes(candidate.topic) &&
    (candidate.sessionId === null || typeof candidate.sessionId === 'string')
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
