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

export type AttentionKind = 'question' | 'permission' | 'review' | 'notice'
export type AttentionState = 'open' | 'answered' | 'withdrawn' | 'expired'

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
}

export type ProgressState =
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'claimed-done'
  | 'verified'
  | 'failed'
  | 'unknown'

export const PROGRESS_STALE_AFTER_MS = 10 * 60 * 1000

/** The latest observation per session and named source. */
export interface ProgressRecord {
  sessionId: string
  source: string
  incarnationId: string | null
  state: ProgressState
  label: string
  detail: string | null
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

export interface DraftSendExpectation {
  expectedIncarnationId?: string
  expectedUpdatedAt?: string
}

/** The header's emblem and motto, chosen independently of the colors. */
export type IdentityName = 'knight' | 'cross'
export const IDENTITY_NAMES: readonly IdentityName[] = Object.freeze(['knight', 'cross'])
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

export type AppEventTopic = 'artifacts' | 'attention' | 'progress' | 'drafts' | 'settings' | 'telegram'

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
    ['artifacts', 'attention', 'progress', 'drafts', 'settings', 'telegram'].includes(candidate.topic) &&
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
