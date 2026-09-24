// MODULE: database-companion-store.ts - artifacts, attention, progress, receipts, drafts, Telegram message map and settings rows
import { createHash } from 'node:crypto'
import {
  ARCHIVE_DELETE_AFTER_DAYS,
  COLOR_MODE_NAMES,
  DEFAULT_APP_SETTINGS,
  ERROR_CODES,
  IDENTITY_NAMES,
  TERMINAL_FONT_SIZE_RANGE,
  VOICE_LANGUAGES,
  VOICE_MODEL_IDS,
  validateVocabulary,
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
  type HandoffReviewSnapshot,
  MAX_PROGRESS_EVIDENCE,
  type ProgressEvidence,
  type ProgressRecord,
  type ProgressState,
  type VoiceLanguage,
  type VoiceModelId
} from '@bmn/protocol'
import { isAbsolute, normalize } from 'node:path'
import type { DatabaseConnection } from './database-initialization'
import { selectSession, selectWorkspace, WorkspaceStoreError } from './database-workspace-store'

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
  opened_by: string | null
  resolved_by: string | null
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
    revision: row.revision,
    // Rows written before migration 9 have no provenance; they read as unknown rather than guessing.
    openedBy: row.opened_by,
    resolvedBy: row.resolved_by
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
  /** What opened it; a caller that does not say leaves the column null. */
  origin?: string
}

/** Opening the same key again while it is open updates that request instead of duplicating it. */
/**
 * The record, plus whether this open changed anything. A caller that repeats an identical request needs to
 * be able to say "nothing changed" rather than claim it opened one; `changed` is reported, never stored.
 */
export type AttentionOpenResult = AttentionRecord & { changed: boolean }

export function openAttention(
  database: DatabaseConnection,
  params: AttentionOpenParams,
  requestId: string,
  now: string
): AttentionOpenResult {
  const existing = database.prepare(
    "SELECT * FROM attention_request WHERE session_id = ? AND request_key = ? AND state = 'open'"
  ).get(params.sessionId, params.requestKey) as AttentionRow | undefined
  if (existing) {
    const unchanged = existing.kind === params.kind &&
      existing.title === params.title &&
      existing.body === (params.body ?? null) &&
      existing.expires_at === (params.expiresAt ?? null)
    // Provenance alone never counts as a change: a re-open that says only a different origin must not clear
    // `seen_at` and show the owner a request they have already read. What opened it stays what opened it.
    if (unchanged) return { ...attentionFromRow(existing), changed: false }
    database.prepare(
      `UPDATE attention_request SET kind = ?, title = ?, body = ?, expires_at = ?, incarnation_id = ?,
         opened_by = ?, seen_at = NULL, revision = revision + 1
       WHERE request_id = ?`
    ).run(
      params.kind,
      params.title,
      params.body ?? null,
      params.expiresAt ?? null,
      params.incarnationId,
      params.origin ?? null,
      existing.request_id
    )
    return { ...getAttention(database, existing.request_id), changed: true }
  }
  database.prepare(
    `INSERT INTO attention_request(request_id, session_id, incarnation_id, request_key, kind, title, body,
       state, resolution, opened_at, expires_at, resolved_at, seen_at, revision, opened_by, resolved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, NULL, NULL, 1, ?, NULL)`
  ).run(
    requestId,
    params.sessionId,
    params.incarnationId,
    params.requestKey,
    params.kind,
    params.title,
    params.body ?? null,
    now,
    params.expiresAt ?? null,
    params.origin ?? null
  )
  return { ...getAttention(database, requestId), changed: true }
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
  target: ({ requestId: string } | { sessionId: string; requestKey: string }) & {
    expectedKind?: AttentionKind
    expectedRevision?: number
  },
  state: Exclude<AttentionState, 'open'>,
  resolution: string | null,
  now: string,
  /** What closed it; null keeps the column empty for a caller that does not say. */
  origin: string | null = null
): AttentionRecord {
  const row = ('requestId' in target
    ? database.prepare("SELECT * FROM attention_request WHERE request_id = ? AND state = 'open'")
        .get(target.requestId)
    : database.prepare(
        "SELECT * FROM attention_request WHERE session_id = ? AND request_key = ? AND state = 'open'"
  ).get(target.sessionId, target.requestKey)) as AttentionRow | undefined
  if (!row) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'No matching open attention request')
  if (
    (target.expectedKind !== undefined && row.kind !== target.expectedKind) ||
    (target.expectedRevision !== undefined && row.revision !== target.expectedRevision)
  ) {
    throw new WorkspaceStoreError(ERROR_CODES.revisionConflict, 'The attention request changed before it was opened')
  }
  database.prepare(
    `UPDATE attention_request SET state = ?, resolution = ?, resolved_at = ?, resolved_by = ?,
       revision = revision + 1
     WHERE request_id = ?`
  ).run(state, resolution, now, origin, row.request_id)
  return getAttention(database, row.request_id)
}

export function expireAttention(database: DatabaseConnection, now: string, activeDraftIds: readonly string[] = []): number {
  // Protect only active owner operations. A recovered uncertain paste has no such operation;
  // its petition may expire while the draft keeps its truthful uncertain state.
  const result = database.prepare(
    `UPDATE attention_request SET state = 'expired', resolved_at = ?, resolved_by = 'expiry',
       revision = revision + 1
     WHERE state = 'open' AND expires_at IS NOT NULL AND expires_at <= ?
       AND NOT (kind = 'handoff' AND EXISTS (
         SELECT 1 FROM input_draft AS draft
         WHERE draft.request_id = attention_request.request_id
           AND draft.prepared_by = 'agent'
           AND draft.draft_id IN (SELECT value FROM json_each(?))
       ))`
  ).run(now, now, JSON.stringify(activeDraftIds))
  database.prepare(
    `UPDATE input_draft SET state = 'discarded', detail = 'The handoff request expired', updated_at = ?
     WHERE prepared_by = 'agent' AND state = 'draft' AND request_id IN
       (SELECT request_id FROM attention_request WHERE state = 'expired')`
  ).run(now)
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

interface ProgressEvidenceRow {
  session_id: string
  source: string
  position: number
  artifact_id: string
  display_name: string
}

function progressFromRow(row: ProgressRow, evidence: ProgressEvidence[]): ProgressRecord {
  return {
    sessionId: row.session_id,
    source: row.source,
    incarnationId: row.incarnation_id,
    state: row.state,
    label: row.label,
    detail: row.detail,
    evidence,
    observedAt: row.observed_at,
    receivedAt: row.received_at
  }
}

function readEvidence(database: DatabaseConnection, sessionId: string, source: string): ProgressEvidence[] {
  return (database.prepare(
    'SELECT * FROM progress_evidence WHERE session_id = ? AND source = ? ORDER BY position'
  ).all(sessionId, source) as ProgressEvidenceRow[])
    .map((row) => ({ artifactId: row.artifact_id, name: row.display_name }))
}

/**
 * Turns the IDs a report named into links, refusing the whole report if any one of them is not this
 * session's own published output. `bmn publish` stores `direction: 'output'`; files the owner or
 * Telegram hand *to* a session are `'input'`, so the rule means "published by this session, not given
 * to it" and an agent cannot cite its own brief as proof it did the work. The display name is
 * snapshotted here, because the original may be gone by the time anyone looks.
 */
function resolveEvidence(
  database: DatabaseConnection,
  sessionId: string,
  artifactIds: readonly string[]
): ProgressEvidence[] {
  if (artifactIds.length > MAX_PROGRESS_EVIDENCE) {
    throw new WorkspaceStoreError(
      ERROR_CODES.invalidArgument,
      `A report may reference at most ${MAX_PROGRESS_EVIDENCE} evidence files`
    )
  }
  const seen = new Set<string>()
  const statement = database.prepare(
    'SELECT session_id, direction, state, original_name FROM artifact WHERE artifact_id = ?'
  )
  return artifactIds.map((artifactId) => {
    if (seen.has(artifactId)) {
      throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, `Evidence ${artifactId} was given twice`)
    }
    seen.add(artifactId)
    const row = statement.get(artifactId) as
      | Pick<ArtifactRow, 'session_id' | 'direction' | 'state' | 'original_name'>
      | undefined
    if (!row || row.session_id !== sessionId || row.direction !== 'output') {
      throw new WorkspaceStoreError(
        ERROR_CODES.invalidArgument,
        `Evidence ${artifactId} is not a file this session published`
      )
    }
    if (row.state !== 'ready') {
      throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, `Evidence ${artifactId} is not ready`)
    }
    return { artifactId, name: row.original_name }
  })
}

/**
 * Keeps the newest observation per source; an older out-of-order observation is not applied, and its
 * evidence is not applied either, so the current report and the files behind it always belong
 * together. Ineligible evidence refuses the report before the timestamp rule runs, so a refusal never
 * silently means "too old". The whole thing runs in the worker's transaction.
 */
export function upsertProgress(
  database: DatabaseConnection,
  record: Omit<ProgressRecord, 'evidence'>,
  evidenceIds: readonly string[] = []
): { record: ProgressRecord; applied: boolean } {
  const evidence = resolveEvidence(database, record.sessionId, evidenceIds)
  const existing = database.prepare(
    'SELECT * FROM progress_observation WHERE session_id = ? AND source = ?'
  ).get(record.sessionId, record.source) as ProgressRow | undefined
  if (existing && Date.parse(existing.observed_at) > Date.parse(record.observedAt)) {
    return {
      record: progressFromRow(existing, readEvidence(database, record.sessionId, record.source)),
      applied: false
    }
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
  // A new report replaces its links outright: omitting IDs means this report has no evidence, never
  // that it inherits the last task's files.
  database.prepare('DELETE FROM progress_evidence WHERE session_id = ? AND source = ?')
    .run(record.sessionId, record.source)
  const insert = database.prepare(
    'INSERT INTO progress_evidence(session_id, source, position, artifact_id, display_name) VALUES (?, ?, ?, ?, ?)'
  )
  evidence.forEach((link, position) => {
    insert.run(record.sessionId, record.source, position, link.artifactId, link.name)
  })
  return { record: { ...record, evidence }, applied: true }
}

export function listProgress(database: DatabaseConnection): ProgressRecord[] {
  const evidence = new Map<string, ProgressEvidence[]>()
  for (const row of database.prepare(
    'SELECT * FROM progress_evidence ORDER BY session_id, source, position'
  ).all() as ProgressEvidenceRow[]) {
    const key = `${row.session_id}\u0000${row.source}`
    const links = evidence.get(key)
    const link = { artifactId: row.artifact_id, name: row.display_name }
    if (links) links.push(link)
    else evidence.set(key, [link])
  }
  return (database.prepare(
    'SELECT * FROM progress_observation ORDER BY observed_at DESC'
  ).all() as ProgressRow[])
    .map((row) => progressFromRow(row, evidence.get(`${row.session_id}\u0000${row.source}`) ?? []))
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
  origin: 'telegram' | 'control' | 'handoff'
  origin_key: string | null
  source_session_id: string | null
  prepared_by: 'agent' | null
  request_id: string | null
  text: string | null
  artifact_id: string | null
  artifact_ids_json: string
  attempted_incarnation_id: string | null
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
    sourceSessionId: row.source_session_id,
    preparedBy: row.prepared_by,
    requestId: row.request_id,
    text: row.text,
    artifactId: row.artifact_id,
    artifactIds: JSON.parse(row.artifact_ids_json) as string[],
    attemptedIncarnationId: row.attempted_incarnation_id,
    state: row.state,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** A draft keyed by its origin (for example one Telegram update) is created once. */
export function createDraft(
  database: DatabaseConnection,
  draft: Omit<InputDraftRecord, 'createdAt' | 'updatedAt' | 'sourceSessionId' | 'artifactIds' | 'attemptedIncarnationId' | 'preparedBy'> & {
    originKey: string | null
    sourceSessionId?: string | null
    artifactIds?: string[]
    attemptedIncarnationId?: string | null
    preparedBy?: 'agent' | null
  },
  now: string
): { record: InputDraftRecord; created: boolean } {
  if (draft.originKey !== null) {
    const existing = database.prepare('SELECT * FROM input_draft WHERE origin_key = ?').get(draft.originKey) as
      | DraftRow
      | undefined
    if (existing) return { record: draftFromRow(existing), created: false }
  }
  database.prepare(
    `INSERT INTO input_draft(
       draft_id, session_id, origin, origin_key, source_session_id, request_id, text, artifact_id,
       artifact_ids_json, attempted_incarnation_id, state, detail, created_at, updated_at, prepared_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    draft.draftId,
    draft.sessionId,
    draft.origin,
    draft.originKey,
    draft.sourceSessionId ?? null,
    draft.requestId,
    draft.text,
    draft.artifactId,
    JSON.stringify(draft.artifactIds ?? []),
    draft.attemptedIncarnationId ?? null,
    draft.state,
    draft.detail,
    now,
    now,
    draft.preparedBy ?? null
  )
  return { record: getDraft(database, draft.draftId), created: true }
}

/**
 * Adds text to a request that is already open, without touching its revision or `seen_at`. That is
 * the difference between "more of the same interruption" and a new one: the desktop notifier keys
 * on `requestId:revision`, and the pending Telegram page refuses a revision that moved under it, so
 * re-opening the row would notify twice on the desktop and never page at all. Returns null when the
 * request is no longer open, which is also what makes the read and the write one atomic step.
 */
export function appendAttentionBody(
  database: DatabaseConnection,
  requestId: string,
  body: string
): AttentionRecord | null {
  const changed = database.prepare(
    "UPDATE attention_request SET body = ? WHERE request_id = ? AND state = 'open'"
  ).run(body, requestId)
  return Number(changed.changes) === 0 ? null : getAttention(database, requestId)
}

export function getDraft(database: DatabaseConnection, draftId: string): InputDraftRecord {
  const row = database.prepare('SELECT * FROM input_draft WHERE draft_id = ?').get(draftId) as DraftRow | undefined
  if (!row) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'The draft was not found')
  return draftFromRow(row)
}

/** One worker transaction reads the exact draft and both addressed sessions as a coherent revision. */
export function readHandoffReview(
  database: DatabaseConnection,
  draftId: string,
  workspaceId: string,
  expectedToken: string | null = null
): HandoffReviewSnapshot {
  const unavailable = (): never => {
    throw new WorkspaceStoreError(ERROR_CODES.revisionConflict,
      'The handoff or destination changed. Refresh results before review.')
  }
  let draft: InputDraftRecord
  try { draft = getDraft(database, draftId) } catch { return unavailable() }
  if (draft.origin !== 'handoff' || (draft.state !== 'draft' && draft.state !== 'uncertain') ||
    draft.sourceSessionId === null) return unavailable()
  let source: HandoffReviewSnapshot['source']
  let destination: HandoffReviewSnapshot['destination']
  let sourceWorkspace: HandoffReviewSnapshot['sourceWorkspace']
  let destinationWorkspace: HandoffReviewSnapshot['destinationWorkspace']
  try {
    source = selectSession(database, draft.sourceSessionId)
    destination = selectSession(database, draft.sessionId)
    sourceWorkspace = selectWorkspace(database, source.workspaceId)
    destinationWorkspace = selectWorkspace(database, destination.workspaceId)
  } catch { return unavailable() }
  const route = draft.state === 'draft' ? source : destination
  const routeWorkspace = draft.state === 'draft' ? sourceWorkspace : destinationWorkspace
  if (destination.archivedAt !== null || destinationWorkspace.archivedAt !== null ||
    route.archivedAt !== null || routeWorkspace.archivedAt !== null ||
    (source.workspaceId !== workspaceId && destination.workspaceId !== workspaceId)) return unavailable()
  const token = createHash('sha256').update(JSON.stringify([
    draft, source.sessionId, source.workspaceId, source.revision, source.archivedAt,
    destination.sessionId, destination.workspaceId, destination.revision, destination.archivedAt,
    sourceWorkspace.workspaceId, sourceWorkspace.revision, sourceWorkspace.archivedAt,
    destinationWorkspace.workspaceId, destinationWorkspace.revision, destinationWorkspace.archivedAt
  ])).digest('hex')
  if (expectedToken !== null && token !== expectedToken) return unavailable()
  return { draft, source, destination, sourceWorkspace, destinationWorkspace, token }
}

export function updateDraft(
  database: DatabaseConnection,
  draftId: string,
  state: InputDraftState,
  detail: string | null,
  now: string
): InputDraftRecord {
  const current = getDraft(database, draftId)
  const updatedAt = monotonicDraftTime(current.updatedAt, now)
  database.prepare('UPDATE input_draft SET state = ?, detail = ?, updated_at = ? WHERE draft_id = ?')
    .run(state, detail, updatedAt, draftId)
  return getDraft(database, draftId)
}

function monotonicDraftTime(previous: string, now: string): string {
  const previousMs = Date.parse(previous)
  const nowMs = Date.parse(now)
  return new Date(Math.max(nowMs, previousMs + 1)).toISOString()
}

export function updateHandoffDraft(
  database: DatabaseConnection,
  draftId: string,
  params: {
    sessionId: string
    sourceSessionId: string
    text: string
    artifactIds: string[]
    expectedUpdatedAt: string
  },
  now: string
): InputDraftRecord {
  const current = getDraft(database, draftId)
  if (current.origin !== 'handoff') invalid('Only a handoff draft can be edited here')
  if (current.state !== 'draft') invalid('Only an unsent handoff can be edited')
  if (current.updatedAt !== params.expectedUpdatedAt) {
    throw new WorkspaceStoreError(ERROR_CODES.revisionConflict, 'The handoff changed after this preview opened')
  }
  const updatedAt = monotonicDraftTime(current.updatedAt, now)
  database.prepare(
    `UPDATE input_draft
     SET session_id = ?, source_session_id = ?, text = ?, artifact_ids_json = ?, detail = NULL,
       attempted_incarnation_id = NULL, updated_at = ?
     WHERE draft_id = ?`
  ).run(
    params.sessionId,
    params.sourceSessionId,
    params.text,
    JSON.stringify(params.artifactIds),
    updatedAt,
    draftId
  )
  return getDraft(database, draftId)
}

export function claimHandoffDraft(
  database: DatabaseConnection,
  draftId: string,
  expectedUpdatedAt: string,
  attemptedIncarnationId: string,
  now: string
): { record: InputDraftRecord; claimed: boolean } {
  const current = getDraft(database, draftId)
  if (current.origin !== 'handoff') invalid('Only a handoff draft can use guarded paste')
  if (current.state !== 'draft') return { record: current, claimed: false }
  if (current.updatedAt !== expectedUpdatedAt) {
    throw new WorkspaceStoreError(ERROR_CODES.revisionConflict, 'The handoff changed after this preview opened')
  }
  database.prepare(
    `UPDATE input_draft
     SET state = 'uncertain', detail = 'Pasting…', attempted_incarnation_id = ?, updated_at = ?
     WHERE draft_id = ?`
  ).run(attemptedIncarnationId, monotonicDraftTime(current.updatedAt, now), draftId)
  return { record: getDraft(database, draftId), claimed: true }
}

export function finishHandoffDraft(
  database: DatabaseConnection,
  draftId: string,
  state: 'draft' | 'accepted',
  detail: string | null,
  now: string
): InputDraftRecord {
  const current = getDraft(database, draftId)
  if (current.origin !== 'handoff' || current.state !== 'uncertain') {
    invalid('The handoff has no in-flight paste attempt')
  }
  database.prepare('UPDATE input_draft SET state = ?, detail = ?, updated_at = ? WHERE draft_id = ?')
    .run(state, detail, monotonicDraftTime(current.updatedAt, now), draftId)
  if (state === 'accepted' && current.preparedBy === 'agent' && current.requestId) {
    if (getAttention(database, current.requestId).state === 'open') {
      closeAttention(database, { requestId: current.requestId }, 'answered', 'pasted, not submitted', now, 'owner')
    }
  }
  return getDraft(database, draftId)
}

/** One worker transaction owns the cap, draft and source request, so no partial petition appears. */
export function prepareAgentHandoff(database: DatabaseConnection, p: {
  draftId: string
  requestId: string
  sourceSessionId: string
  sourceIncarnationId: string
  destinationSessionId: string
  destinationName: string
  text: string
  artifactIds: string[]
}, now: string): { draftId: string; requestId: string; state: 'draft' } {
  const pending = database.prepare(
    "SELECT COUNT(*) AS count FROM input_draft WHERE prepared_by = 'agent' AND source_session_id = ? AND state = 'draft'"
  ).get(p.sourceSessionId) as { count: number }
  if (pending.count >= 3) invalid('This session already has three pending handoffs')
  const recent = database.prepare(
    "SELECT created_at FROM input_draft WHERE prepared_by = 'agent' AND source_session_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(p.sourceSessionId) as { created_at: string } | undefined
  if (recent && Date.parse(now) - Date.parse(recent.created_at) < 10_000) {
    invalid('Wait 10 seconds before preparing another handoff')
  }
  createDraft(database, {
    draftId: p.draftId,
    sessionId: p.destinationSessionId,
    origin: 'handoff',
    originKey: null,
    sourceSessionId: p.sourceSessionId,
    requestId: p.requestId,
    text: p.text,
    artifactId: null,
    artifactIds: p.artifactIds,
    attemptedIncarnationId: null,
    state: 'draft',
    detail: null,
    preparedBy: 'agent'
  }, now)
  const titlePrefix = 'Asks to hand off to "'
  const title = `${titlePrefix}${p.destinationName.slice(0, 200 - titlePrefix.length - 1)}"`
  const body = `${p.text.slice(0, 200)}${p.artifactIds.length ? `\n${p.artifactIds.length} files` : ''}`
  openAttention(database, {
    sessionId: p.sourceSessionId,
    incarnationId: p.sourceIncarnationId,
    requestKey: `handoff:${p.draftId}`,
    kind: 'handoff',
    title,
    body,
    expiresAt: new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(),
    origin: 'cli'
  }, p.requestId, now)
  return { draftId: p.draftId, requestId: p.requestId, state: 'draft' }
}

/** A token reads only its own agent-prepared metadata, never the owner's edits or other sessions. */
export interface AgentHandoffSummary {
  draftId: string
  destinationSessionId: string
  state: InputDraftState
  updatedAt: string
}

export function listAgentHandoffs(database: DatabaseConnection, sourceSessionId: string): AgentHandoffSummary[] {
  const rows = database.prepare(
    "SELECT draft_id, session_id, state, updated_at FROM input_draft WHERE prepared_by = 'agent' AND source_session_id = ? ORDER BY created_at DESC"
  ).all(sourceSessionId) as Pick<DraftRow, 'draft_id' | 'session_id' | 'state' | 'updated_at'>[]
  return rows.map((row) => ({
    draftId: row.draft_id, destinationSessionId: row.session_id,
    state: row.state, updatedAt: row.updated_at
  }))
}

/** The source may withdraw its petition, but an owner-edited draft remains for the owner to judge. */
export function withdrawAgentHandoff(
  database: DatabaseConnection, sourceSessionId: string, draftId: string, now: string
): AttentionRecord {
  const draft = getDraft(database, draftId)
  if (draft.preparedBy !== 'agent' || draft.sourceSessionId !== sourceSessionId ||
      draft.state !== 'draft' || !draft.requestId) {
    invalid('Only an open handoff from this session can be withdrawn')
  }
  const request = getAttention(database, draft.requestId)
  if (request.state !== 'open' || request.sessionId !== sourceSessionId ||
      request.requestKey !== `handoff:${draftId}`) {
    invalid('Only an open handoff from this session can be withdrawn')
  }
  if (draft.updatedAt === draft.createdAt) {
    updateDraft(database, draftId, 'discarded', 'Withdrawn by the agent', now)
  } else {
    updateDraft(database, draftId, 'draft', "The agent withdrew this; the owner's edits are kept", now)
    appendAttentionBody(database, draft.requestId,
      `${request.body ?? ''}\nThe agent withdrew this; the owner's edits are kept`.trim())
  }
  return closeAttention(database, { requestId: draft.requestId }, 'withdrawn', 'withdrawn by agent', now, 'cli')
}

/** Owner discard and its attention resolution are one stored outcome. */
export function discardHandoffDraft(database: DatabaseConnection, draftId: string, now: string): InputDraftRecord {
  const draft = getDraft(database, draftId)
  if (draft.origin === 'handoff' && draft.state !== 'draft') invalid('Only an unsent handoff can be discarded')
  const record = updateDraft(database, draftId, 'discarded', null, now)
  if (draft.preparedBy === 'agent' && draft.requestId) {
    const request = getAttention(database, draft.requestId)
    if (request.state === 'open') {
      closeAttention(database, { requestId: draft.requestId }, 'answered', 'discarded', now, 'owner')
    }
  }
  return record
}

/** A restarted source makes its old petition visibly stale without changing the draft's state. */
export function markStaleAgentHandoffs(
  database: DatabaseConnection, liveIncarnations: Readonly<Record<string, string>>
): number {
  const rows = database.prepare(
    `SELECT a.request_id, a.body, a.incarnation_id, d.source_session_id
     FROM attention_request a JOIN input_draft d ON d.request_id = a.request_id
     WHERE d.prepared_by = 'agent' AND d.state = 'draft' AND a.state = 'open'`
  ).all() as { request_id: string; body: string | null; incarnation_id: string | null; source_session_id: string }[]
  let changed = 0
  for (const row of rows) {
    const current = liveIncarnations[row.source_session_id]
    if (!current || current === row.incarnation_id) continue
    if (row.body?.includes('prepared by an earlier process of this session')) continue
    appendAttentionBody(database, row.request_id,
      `${row.body ?? ''}\nprepared by an earlier process of this session`.trim())
    changed += 1
  }
  return changed
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
  incarnationId: string | null,
  now: string
): void {
  database.prepare(
    `INSERT OR REPLACE INTO telegram_message(
       message_id, session_id, request_id, incarnation_id, sent_at
     ) VALUES (?, ?, ?, ?, ?)`
  ).run(messageId, sessionId, requestId, incarnationId, now)
}

export function getTelegramMessage(
  database: DatabaseConnection,
  messageId: number
): { sessionId: string; requestId: string | null; incarnationId: string | null } | undefined {
  const row = database.prepare(
    'SELECT session_id, request_id, incarnation_id FROM telegram_message WHERE message_id = ?'
  ).get(messageId) as {
    session_id: string
    request_id: string | null
    incarnation_id: string | null
  } | undefined
  return row
    ? { sessionId: row.session_id, requestId: row.request_id, incarnationId: row.incarnation_id }
    : undefined
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
      if (!IDENTITY_NAMES.includes(identity as IdentityName)) invalid('Identity must be Knight, Cross or Boss')
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
      // Sections saved before the vocabulary existed have none; the storage rules are the shared ones.
      const vocabulary = validateVocabulary(candidate.vocabulary ?? [])
      if (!vocabulary.ok) invalid(vocabulary.reason)
      return {
        model: candidate.model as VoiceModelId,
        language: candidate.language as VoiceLanguage,
        modelFolder: folder === null ? null : normalize(folder),
        holdSpaceToTalk,
        vocabulary: vocabulary.words
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
  appendAttentionBody,
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
  updateHandoffDraft,
  claimHandoffDraft,
  finishHandoffDraft,
  prepareAgentHandoff,
  listAgentHandoffs,
  withdrawAgentHandoff,
  discardHandoffDraft,
  markStaleAgentHandoffs,
  listDrafts,
  readHandoffReview,
  putTelegramMessage,
  getTelegramMessage,
  getSettings,
  putSettingsSection,
  getRawSetting,
  putRawSetting
})

export type CompanionOperations = typeof COMPANION_OPERATIONS
export type CompanionOperationName = keyof CompanionOperations
