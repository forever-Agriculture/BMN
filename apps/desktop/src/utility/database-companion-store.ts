// MODULE: database-companion-store.ts - artifacts, attention, progress, receipts, drafts, Telegram message map and settings rows
import {
  ARCHIVE_DELETE_AFTER_DAYS,
  COLOR_MODE_NAMES,
  DEFAULT_APP_SETTINGS,
  ERROR_CODES,
  IDENTITY_NAMES,
  TERMINAL_FONT_SIZE_RANGE,
  VOICE_LANGUAGES,
  VOICE_MODEL_IDS,
  type AppearanceSettings,
  type AppSettings,
  type ArchiveDeleteAfterDays,
  type ArtifactRecord,
  type ArtifactState,
  type AttentionKind,
  type AttentionRecord,
  type AttentionState,
  type ColorModeName,
  type IdentityName,
  type InputDraftRecord,
  type InputDraftState,
  type ProgressRecord,
  type ProgressState,
  type VoiceLanguage,
  type VoiceModelId
} from '@ai-terminal/protocol'
import { isAbsolute, normalize } from 'node:path'
import type { DatabaseConnection } from './database-initialization'
import { WorkspaceStoreError } from './database-workspace-store'

interface ArtifactRow {
  artifact_id: string
  session_id: string | null
  incarnation_id: string | null
  direction: 'input' | 'output'
  source: 'owner' | 'agent' | 'telegram'
  original_name: string
  media_type: string
  byte_length: number
  sha256: string
  stored_path: string
  source_path: string | null
  state: ArtifactState
  created_at: string
}

function artifactFromRow(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.artifact_id,
    sessionId: row.session_id,
    incarnationId: row.incarnation_id,
    direction: row.direction,
    source: row.source,
    originalName: row.original_name,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    storedPath: row.stored_path,
    sourcePath: row.source_path,
    state: row.state,
    createdAt: row.created_at
  }
}

export function insertArtifact(database: DatabaseConnection, record: ArtifactRecord): ArtifactRecord {
  database.prepare(
    `INSERT INTO artifact(artifact_id, session_id, incarnation_id, direction, source, original_name,
       media_type, byte_length, sha256, stored_path, source_path, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.artifactId,
    record.sessionId,
    record.incarnationId,
    record.direction,
    record.source,
    record.originalName,
    record.mediaType,
    record.byteLength,
    record.sha256,
    record.storedPath,
    record.sourcePath,
    record.state,
    record.createdAt
  )
  return record
}

export function listArtifacts(database: DatabaseConnection, sessionId: string | null): ArtifactRecord[] {
  const rows = sessionId === null
    ? database.prepare('SELECT * FROM artifact ORDER BY created_at DESC, rowid DESC LIMIT 1000').all()
    : database.prepare(
        'SELECT * FROM artifact WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1000'
      ).all(sessionId)
  return (rows as ArtifactRow[]).map(artifactFromRow)
}

/** Every artifact, unbounded, for maintenance that must not stop at the listing cap. */
export function listAllArtifacts(database: DatabaseConnection): ArtifactRecord[] {
  return (database.prepare('SELECT * FROM artifact ORDER BY created_at, rowid').all() as ArtifactRow[]).map(artifactFromRow)
}

/** Every ready artifact, unbounded; a backup must hold exactly these. */
export function listReadyArtifacts(database: DatabaseConnection): ArtifactRecord[] {
  return (database.prepare("SELECT * FROM artifact WHERE state = 'ready' ORDER BY created_at, rowid").all() as ArtifactRow[])
    .map(artifactFromRow)
}

export function getArtifact(database: DatabaseConnection, artifactId: string): ArtifactRecord {
  const row = database.prepare('SELECT * FROM artifact WHERE artifact_id = ?').get(artifactId) as
    | ArtifactRow
    | undefined
  if (!row) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'The artifact was not found')
  return artifactFromRow(row)
}

export function setArtifactState(
  database: DatabaseConnection,
  artifactId: string,
  state: ArtifactState
): ArtifactRecord {
  database.prepare('UPDATE artifact SET state = ? WHERE artifact_id = ?').run(state, artifactId)
  return getArtifact(database, artifactId)
}

export function artifactBytesUsed(database: DatabaseConnection): number {
  const row = database.prepare('SELECT COALESCE(SUM(byte_length), 0) AS used FROM artifact').get() as {
    used: number
  }
  return row.used
}

interface AttentionRow {
  request_id: string
  session_id: string
  incarnation_id: string | null
  request_key: string
  kind: AttentionKind
  title: string
  body: string | null
  state: AttentionState
  resolution: string | null
  opened_at: string
  expires_at: string | null
  resolved_at: string | null
  seen_at: string | null
  revision: number
}

function attentionFromRow(row: AttentionRow): AttentionRecord {
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    incarnationId: row.incarnation_id,
    requestKey: row.request_key,
    kind: row.kind,
    title: row.title,
    body: row.body,
    state: row.state,
    resolution: row.resolution,
    openedAt: row.opened_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    seenAt: row.seen_at,
    revision: row.revision
  }
}

export interface AttentionOpenParams {
  sessionId: string
  incarnationId: string | null
  requestKey: string
  kind: AttentionKind
  title: string
  body?: string
  expiresAt?: string
}

/** Opening the same key again while it is open updates that request instead of duplicating it. */
export function openAttention(
  database: DatabaseConnection,
  params: AttentionOpenParams,
  requestId: string,
  now: string
): AttentionRecord {
  const existing = database.prepare(
    "SELECT * FROM attention_request WHERE session_id = ? AND request_key = ? AND state = 'open'"
  ).get(params.sessionId, params.requestKey) as AttentionRow | undefined
  if (existing) {
    const unchanged = existing.kind === params.kind &&
      existing.title === params.title &&
      existing.body === (params.body ?? null) &&
      existing.expires_at === (params.expiresAt ?? null)
    if (unchanged) return attentionFromRow(existing)
    database.prepare(
      `UPDATE attention_request SET kind = ?, title = ?, body = ?, expires_at = ?, incarnation_id = ?,
         seen_at = NULL, revision = revision + 1
       WHERE request_id = ?`
    ).run(
      params.kind,
      params.title,
      params.body ?? null,
      params.expiresAt ?? null,
      params.incarnationId,
      existing.request_id
    )
    return getAttention(database, existing.request_id)
  }
  database.prepare(
    `INSERT INTO attention_request(request_id, session_id, incarnation_id, request_key, kind, title, body,
       state, resolution, opened_at, expires_at, resolved_at, seen_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, NULL, NULL, 1)`
  ).run(
    requestId,
    params.sessionId,
    params.incarnationId,
    params.requestKey,
    params.kind,
    params.title,
    params.body ?? null,
    now,
    params.expiresAt ?? null
  )
  return getAttention(database, requestId)
}

export function getAttention(database: DatabaseConnection, requestId: string): AttentionRecord {
  const row = database.prepare('SELECT * FROM attention_request WHERE request_id = ?').get(requestId) as
    | AttentionRow
    | undefined
  if (!row) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'The attention request was not found')
  return attentionFromRow(row)
}

/**
 * Closes only the matching open request. A stale or duplicate resolution finds no open request and
 * reports NOT_FOUND instead of touching a newer request that reuses the key.
 */
export function closeAttention(
  database: DatabaseConnection,
  target: { requestId: string } | { sessionId: string; requestKey: string },
  state: Exclude<AttentionState, 'open'>,
  resolution: string | null,
  now: string
): AttentionRecord {
  const row = ('requestId' in target
    ? database.prepare("SELECT * FROM attention_request WHERE request_id = ? AND state = 'open'")
        .get(target.requestId)
    : database.prepare(
        "SELECT * FROM attention_request WHERE session_id = ? AND request_key = ? AND state = 'open'"
      ).get(target.sessionId, target.requestKey)) as AttentionRow | undefined
  if (!row) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'No matching open attention request')
  database.prepare(
    `UPDATE attention_request SET state = ?, resolution = ?, resolved_at = ?, revision = revision + 1
     WHERE request_id = ?`
  ).run(state, resolution, now, row.request_id)
  return getAttention(database, row.request_id)
}

export function expireAttention(database: DatabaseConnection, now: string): number {
  const result = database.prepare(
    `UPDATE attention_request SET state = 'expired', resolved_at = ?, revision = revision + 1
     WHERE state = 'open' AND expires_at IS NOT NULL AND expires_at <= ?`
  ).run(now, now)
  return Number(result.changes)
}

export function markAttentionSeen(
  database: DatabaseConnection,
  requestId: string,
  now: string
): AttentionRecord {
  const record = getAttention(database, requestId)
  if (record.seenAt === null) {
    database.prepare('UPDATE attention_request SET seen_at = ? WHERE request_id = ?').run(now, requestId)
  }
  return getAttention(database, requestId)
}

/** Every open request plus the most recent closed ones. */
export function listAttention(database: DatabaseConnection): AttentionRecord[] {
  const open = database.prepare(
    "SELECT * FROM attention_request WHERE state = 'open' ORDER BY opened_at, rowid"
  ).all() as AttentionRow[]
  const closed = database.prepare(
    "SELECT * FROM attention_request WHERE state != 'open' ORDER BY resolved_at DESC, rowid DESC LIMIT 50"
  ).all() as AttentionRow[]
  return [...open, ...closed].map(attentionFromRow)
}

interface ProgressRow {
  session_id: string
  source: string
  incarnation_id: string | null
  state: ProgressState
  label: string
  detail: string | null
  observed_at: string
  received_at: string
}

function progressFromRow(row: ProgressRow): ProgressRecord {
  return {
    sessionId: row.session_id,
    source: row.source,
    incarnationId: row.incarnation_id,
    state: row.state,
    label: row.label,
    detail: row.detail,
    observedAt: row.observed_at,
    receivedAt: row.received_at
  }
}

/** Keeps the newest observation per source; an older out-of-order observation is not applied. */
export function upsertProgress(
  database: DatabaseConnection,
  record: ProgressRecord
): { record: ProgressRecord; applied: boolean } {
  const existing = database.prepare(
    'SELECT * FROM progress_observation WHERE session_id = ? AND source = ?'
  ).get(record.sessionId, record.source) as ProgressRow | undefined
  if (existing && Date.parse(existing.observed_at) > Date.parse(record.observedAt)) {
    return { record: progressFromRow(existing), applied: false }
  }
  database.prepare(
    `INSERT INTO progress_observation(session_id, source, incarnation_id, state, label, detail, observed_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, source) DO UPDATE SET incarnation_id = excluded.incarnation_id,
       state = excluded.state, label = excluded.label, detail = excluded.detail,
       observed_at = excluded.observed_at, received_at = excluded.received_at`
  ).run(
    record.sessionId,
    record.source,
    record.incarnationId,
    record.state,
    record.label,
    record.detail,
    record.observedAt,
    record.receivedAt
  )
  return { record, applied: true }
}

export function listProgress(database: DatabaseConnection): ProgressRecord[] {
  return (database.prepare(
    'SELECT * FROM progress_observation ORDER BY observed_at DESC'
  ).all() as ProgressRow[]).map(progressFromRow)
}

export interface StoredReceipt {
  key: string
  paramsHash: string
  state: 'staged' | 'done' | 'failed'
  result?: unknown
  error?: { code: string; message: string }
}

export function getReceipt(database: DatabaseConnection, key: string): StoredReceipt | undefined {
  const row = database.prepare('SELECT * FROM control_receipt WHERE receipt_key = ?').get(key) as
    | { receipt_key: string; params_hash: string; state: StoredReceipt['state']; result_json: string | null; error_json: string | null }
    | undefined
  if (!row) return undefined
  return {
    key: row.receipt_key,
    paramsHash: row.params_hash,
    state: row.state,
    ...(row.result_json !== null ? { result: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.error_json !== null ? { error: JSON.parse(row.error_json) as { code: string; message: string } } : {})
  }
}

export function putReceipt(database: DatabaseConnection, receipt: StoredReceipt, now: string): void {
  database.prepare(
    `INSERT INTO control_receipt(receipt_key, params_hash, state, result_json, error_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(receipt_key) DO UPDATE SET params_hash = excluded.params_hash, state = excluded.state,
       result_json = excluded.result_json, error_json = excluded.error_json, updated_at = excluded.updated_at`
  ).run(
    receipt.key,
    receipt.paramsHash,
    receipt.state,
    receipt.result === undefined ? null : JSON.stringify(receipt.result),
    receipt.error === undefined ? null : JSON.stringify(receipt.error),
    now
  )
}

interface DraftRow {
  draft_id: string
  session_id: string
  origin: 'telegram' | 'control'
  origin_key: string | null
  request_id: string | null
  text: string | null
  artifact_id: string | null
  state: InputDraftState
  detail: string | null
  created_at: string
  updated_at: string
}

function draftFromRow(row: DraftRow): InputDraftRecord {
  return {
    draftId: row.draft_id,
    sessionId: row.session_id,
    origin: row.origin,
    requestId: row.request_id,
    text: row.text,
    artifactId: row.artifact_id,
    state: row.state,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** A draft keyed by its origin (for example one Telegram update) is created once. */
export function createDraft(
  database: DatabaseConnection,
  draft: Omit<InputDraftRecord, 'createdAt' | 'updatedAt'> & { originKey: string | null },
  now: string
): { record: InputDraftRecord; created: boolean } {
  if (draft.originKey !== null) {
    const existing = database.prepare('SELECT * FROM input_draft WHERE origin_key = ?').get(draft.originKey) as
      | DraftRow
      | undefined
    if (existing) return { record: draftFromRow(existing), created: false }
  }
  database.prepare(
    `INSERT INTO input_draft(draft_id, session_id, origin, origin_key, request_id, text, artifact_id, state,
       detail, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    draft.draftId,
    draft.sessionId,
    draft.origin,
    draft.originKey,
    draft.requestId,
    draft.text,
    draft.artifactId,
    draft.state,
    draft.detail,
    now,
    now
  )
  return { record: getDraft(database, draft.draftId), created: true }
}

export function getDraft(database: DatabaseConnection, draftId: string): InputDraftRecord {
  const row = database.prepare('SELECT * FROM input_draft WHERE draft_id = ?').get(draftId) as DraftRow | undefined
  if (!row) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'The draft was not found')
  return draftFromRow(row)
}

export function updateDraft(
  database: DatabaseConnection,
  draftId: string,
  state: InputDraftState,
  detail: string | null,
  now: string
): InputDraftRecord {
  getDraft(database, draftId)
  database.prepare('UPDATE input_draft SET state = ?, detail = ?, updated_at = ? WHERE draft_id = ?')
    .run(state, detail, now, draftId)
  return getDraft(database, draftId)
}

export function listDrafts(database: DatabaseConnection): InputDraftRecord[] {
  return (database.prepare(
    `SELECT * FROM input_draft WHERE state != 'discarded'
     ORDER BY created_at DESC, rowid DESC LIMIT 200`
  ).all() as DraftRow[]).map(draftFromRow)
}

export function putTelegramMessage(
  database: DatabaseConnection,
  messageId: number,
  sessionId: string,
  requestId: string | null,
  now: string
): void {
  database.prepare(
    `INSERT OR REPLACE INTO telegram_message(message_id, session_id, request_id, sent_at) VALUES (?, ?, ?, ?)`
  ).run(messageId, sessionId, requestId, now)
}

export function getTelegramMessage(
  database: DatabaseConnection,
  messageId: number
): { sessionId: string; requestId: string | null } | undefined {
  const row = database.prepare('SELECT session_id, request_id FROM telegram_message WHERE message_id = ?')
    .get(messageId) as { session_id: string; request_id: string | null } | undefined
  return row ? { sessionId: row.session_id, requestId: row.request_id } : undefined
}

type SettingsSection = keyof AppSettings

function invalid(message: string): never {
  throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, message)
}

function nullableInteger(value: unknown, name: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(`${name} must be an integer or empty`)
  return value
}

/**
 * Until 2026-09-15 one `theme` named both the identity and the colors; `brown` is the name Cross had before Knight
 * became the default.
 */
const LEGACY_THEMES: ReadonlyMap<string, Pick<AppearanceSettings, 'identity' | 'colorMode'>> = new Map([
  ['knight', { identity: 'knight', colorMode: 'steel' }],
  ['cross', { identity: 'cross', colorMode: 'brown' }],
  ['brown', { identity: 'cross', colorMode: 'brown' }],
  ['dark', { identity: 'cross', colorMode: 'dark' }]
])

/** Validates one settings section; an invalid value throws and the stored value stays unchanged. */
export function validateSettingsSection(section: string, value: unknown): AppSettings[SettingsSection] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Settings must be an object')
  const candidate = value as Record<string, unknown>
  switch (section) {
    case 'appearance': {
      const legacy = typeof candidate.theme === 'string' ? LEGACY_THEMES.get(candidate.theme) : undefined
      const identity = candidate.identity ?? legacy?.identity
      const colorMode = candidate.colorMode ?? legacy?.colorMode
      if (!IDENTITY_NAMES.includes(identity as IdentityName)) invalid('Identity must be Knight or Cross')
      if (!COLOR_MODE_NAMES.includes(colorMode as ColorModeName)) invalid('Color mode must be Steel, Brown, Dark or Black')
      const size = candidate.terminalFontSize
      if (
        typeof size !== 'number' ||
        !Number.isInteger(size) ||
        size < TERMINAL_FONT_SIZE_RANGE.min ||
        size > TERMINAL_FONT_SIZE_RANGE.max
      ) {
        invalid(`Terminal font size must be ${TERMINAL_FONT_SIZE_RANGE.min}–${TERMINAL_FONT_SIZE_RANGE.max}`)
      }
      return { identity: identity as IdentityName, colorMode: colorMode as ColorModeName, terminalFontSize: size }
    }
    case 'notifications':
      if (typeof candidate.desktop !== 'boolean') invalid('Desktop notifications must be on or off')
      return { desktop: candidate.desktop }
    case 'telegram': {
      if (typeof candidate.enabled !== 'boolean') invalid('Telegram enabled must be on or off')
      if (candidate.notifyOn !== 'attention' && candidate.notifyOn !== 'attention-and-exit') {
        invalid('Telegram notification scope is invalid')
      }
      if (typeof candidate.autoSubmitReplies !== 'boolean') invalid('Reply submission must be on or off')
      const allowedChatId = nullableInteger(candidate.allowedChatId, 'Allowed chat id')
      const allowedUserId = nullableInteger(candidate.allowedUserId, 'Allowed user id')
      if (candidate.enabled && allowedChatId === null) invalid('Choose the allowed chat before enabling Telegram')
      return {
        enabled: candidate.enabled,
        allowedChatId,
        allowedUserId,
        notifyOn: candidate.notifyOn,
        autoSubmitReplies: candidate.autoSubmitReplies
      }
    }
    case 'voice': {
      if (!VOICE_MODEL_IDS.includes(candidate.model as VoiceModelId)) invalid('Voice model must be Base or Small')
      if (!VOICE_LANGUAGES.some((language) => language.code === candidate.language)) invalid('Voice language is not supported')
      // Sections saved before the folder setting existed have no modelFolder and keep the default folder.
      const folder = candidate.modelFolder ?? null
      if (folder !== null && (typeof folder !== 'string' || !isAbsolute(folder) || folder.length > 4_096 || folder.includes('\0'))) {
        invalid('Voice model folder must be an absolute path')
      }
      // Sections saved before hold to talk existed keep it on, like a fresh install.
      const holdSpaceToTalk = candidate.holdSpaceToTalk ?? DEFAULT_APP_SETTINGS.voice.holdSpaceToTalk
      if (typeof holdSpaceToTalk !== 'boolean') invalid('Hold Space to talk must be on or off')
      return {
        model: candidate.model as VoiceModelId,
        language: candidate.language as VoiceLanguage,
        modelFolder: folder === null ? null : normalize(folder),
        holdSpaceToTalk
      }
    }
    case 'archive':
      if (!ARCHIVE_DELETE_AFTER_DAYS.includes(candidate.deleteAfterDays as ArchiveDeleteAfterDays)) {
        invalid('Delete archived items after must be Never, 90, 30 or 10 days')
      }
      return { deleteAfterDays: candidate.deleteAfterDays as ArchiveDeleteAfterDays }
    default:
      return invalid(`Unknown settings section ${section}`)
  }
}

export function getSettings(database: DatabaseConnection): AppSettings {
  const rows = database.prepare("SELECT key, value_json FROM app_setting WHERE key IN ('appearance', 'notifications', 'telegram', 'voice', 'archive')")
    .all() as Array<{ key: SettingsSection; value_json: string }>
  const settings: AppSettings = {
    appearance: { ...DEFAULT_APP_SETTINGS.appearance },
    notifications: { ...DEFAULT_APP_SETTINGS.notifications },
    telegram: { ...DEFAULT_APP_SETTINGS.telegram },
    voice: { ...DEFAULT_APP_SETTINGS.voice },
    archive: { ...DEFAULT_APP_SETTINGS.archive }
  }
  for (const row of rows) {
    try {
      Object.assign(settings[row.key], validateSettingsSection(row.key, JSON.parse(row.value_json)))
    } catch {
      // A corrupt stored section falls back to defaults; the next valid save replaces it.
    }
  }
  return settings
}

export function putSettingsSection(
  database: DatabaseConnection,
  section: string,
  value: unknown,
  now: string
): AppSettings {
  const validated = validateSettingsSection(section, value)
  database.prepare(
    `INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(section, JSON.stringify(validated), now)
  return getSettings(database)
}

export function getRawSetting(database: DatabaseConnection, key: string): unknown {
  const row = database.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined
  return row ? JSON.parse(row.value_json) as unknown : undefined
}

export function putRawSetting(database: DatabaseConnection, key: string, value: unknown, now: string): void {
  database.prepare(
    `INSERT INTO app_setting(key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), now)
}

/** Store functions reachable through the database worker; each runs in one transaction. */
export const COMPANION_OPERATIONS = Object.freeze({
  insertArtifact,
  listArtifacts,
  listAllArtifacts,
  getArtifact,
  setArtifactState,
  artifactBytesUsed,
  openAttention,
  getAttention,
  closeAttention,
  expireAttention,
  markAttentionSeen,
  listAttention,
  upsertProgress,
  listProgress,
  getReceipt,
  putReceipt,
  createDraft,
  getDraft,
  updateDraft,
  listDrafts,
  putTelegramMessage,
  getTelegramMessage,
  getSettings,
  putSettingsSection,
  getRawSetting,
  putRawSetting
})

export type CompanionOperations = typeof COMPANION_OPERATIONS
export type CompanionOperationName = keyof CompanionOperations
