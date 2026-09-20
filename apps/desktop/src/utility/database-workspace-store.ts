import {
  DEFAULT_WORKSPACE_MARKER,
  ERROR_CODES,
  emptyWorkspaceLayout,
  isLaunchTemplateRecord,
  isSessionRecord,
  isTemplateCreateParams,
  isWorkspaceCreateParams,
  isWorkspaceLayoutState,
  isWorkspaceMarker,
  isWorkspaceRecord,
  isWorkspaceUpdateParams,
  isSessionUpdateParams,
  type LaunchTemplateRecord,
  type LayoutGetResult,
  type ProtocolErrorCode,
  type SessionProcessStatus,
  type SessionRecord,
  type SessionUpdateParams,
  type TemplateCreateParams,
  type WorkspaceCreateParams,
  type WorkspaceLayoutState,
  type WorkspaceRecord,
  type WorkspaceUpdateParams
} from '@bmn/protocol'
import type { DatabaseConnection } from './database-initialization'

export class WorkspaceStoreError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'WorkspaceStoreError'
  }
}

interface WorkspaceRow {
  workspace_id: string
  name: string
  default_cwd: string | null
  position: number
  marker: string
  archived_at: string | null
  revision: number
}

interface SessionRow {
  session_id: string
  workspace_id: string
  name: string
  cwd: string
  executable: string
  argv_json: string
  position: number
  background_choice: string | null
  revision: number
  created_at: string
  archived_at: string | null
  last_incarnation_id: string | null
  last_state: string | null
  last_exit_code: number | null
  last_exit_signal: number | null
  last_exit_detail: string | null
}

/**
 * Session columns plus the latest process incarnation. The store reports only what was recorded;
 * it never claims a process is live — the host liveness owner decides that.
 */
const SESSION_SELECT = `SELECT s.session_id, s.workspace_id, s.name, s.cwd, s.executable, s.argv_json,
              s.position, s.background_choice, s.revision, s.created_at, s.archived_at,
              i.incarnation_id AS last_incarnation_id, i.state AS last_state,
              i.exit_code AS last_exit_code, i.exit_signal AS last_exit_signal,
              i.exit_detail AS last_exit_detail
       FROM session s
       LEFT JOIN process_incarnation i ON i.incarnation_id = (
         SELECT latest.incarnation_id FROM process_incarnation latest
         WHERE latest.session_id = s.session_id
         ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1
       )`

interface TemplateRow {
  template_id: string
  name: string
  executable: string
  argv_json: string
  cwd: string
  background_choice: string | null
  revision: number
  created_at: string
}

function invalid(message: string): never {
  throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, message)
}

function missing(kind: string, id: string): never {
  throw new WorkspaceStoreError(ERROR_CODES.notFound, `${kind} ${id} was not found`)
}

function conflict(kind: string, id: string, revision: number): never {
  throw new WorkspaceStoreError(
    ERROR_CODES.revisionConflict,
    `${kind} ${id} has revision ${revision}`
  )
}

function parseArgv(argvJson: string, owner: string): string[] {
  let argv: unknown
  try {
    argv = JSON.parse(argvJson)
  } catch {
    throw new WorkspaceStoreError(ERROR_CODES.ioError, `${owner} has invalid stored arguments`)
  }
  if (!Array.isArray(argv) || !argv.every((argument) => typeof argument === 'string')) {
    throw new WorkspaceStoreError(ERROR_CODES.ioError, `${owner} has invalid stored arguments`)
  }
  return argv
}

interface StoredArgvFields {
  argv: string[]
  launchDisabledReason?: string
}

/** Degrades unreadable stored argv per record so one corrupt row never hides healthy records. */
function storedArgvFields(
  argvJson: string,
  owner: string,
  repairInstruction: string
): StoredArgvFields {
  try {
    return { argv: parseArgv(argvJson, owner) }
  } catch {
    return {
      argv: [],
      launchDisabledReason: `${owner} has invalid stored arguments. ${repairInstruction}`
    }
  }
}

function workspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  const record: WorkspaceRecord = {
    workspaceId: row.workspace_id,
    name: row.name,
    defaultCwd: row.default_cwd,
    position: row.position,
    // A marker is decoration, so an unreadable one degrades to the default rather than hiding the
    // workspace and every session under it.
    marker: isWorkspaceMarker(row.marker) ? row.marker : DEFAULT_WORKSPACE_MARKER,
    archivedAt: row.archived_at,
    revision: row.revision
  }
  if (!isWorkspaceRecord(record)) {
    throw new WorkspaceStoreError(ERROR_CODES.ioError, 'A stored workspace record is invalid')
  }
  return record
}

function recordedProcessStatus(row: SessionRow): SessionProcessStatus | null {
  if (row.last_incarnation_id === null) return null
  if (row.last_state === 'exited') {
    return {
      incarnationId: row.last_incarnation_id,
      state: 'exited',
      exitCode: row.last_exit_code,
      signal: row.last_exit_signal,
      detail: null
    }
  }
  return {
    incarnationId: row.last_incarnation_id,
    state: 'interrupted',
    exitCode: null,
    signal: null,
    detail: row.last_state === 'interrupted' ? row.last_exit_detail : null
  }
}

function sessionRecord(row: SessionRow): SessionRecord {
  const record: SessionRecord = {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    name: row.name,
    cwd: row.cwd,
    executable: row.executable,
    ...storedArgvFields(
      row.argv_json,
      `Session ${row.session_id}`,
      'Edit and save its arguments before launching or resuming it.'
    ),
    position: row.position,
    backgroundChoice:
      row.background_choice === 'hide' || row.background_choice === 'stop'
        ? row.background_choice
        : null,
    revision: row.revision,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    lastProcess: recordedProcessStatus(row)
  }
  if (!isSessionRecord(record)) {
    throw new WorkspaceStoreError(ERROR_CODES.ioError, `Session ${row.session_id} is invalid`)
  }
  return record
}

function templateRecord(row: TemplateRow): LaunchTemplateRecord {
  const record: LaunchTemplateRecord = {
    templateId: row.template_id,
    name: row.name,
    executable: row.executable,
    ...storedArgvFields(
      row.argv_json,
      `Template ${row.template_id}`,
      'Recreate this launch template before applying it.'
    ),
    cwd: row.cwd,
    backgroundChoice:
      row.background_choice === 'hide' || row.background_choice === 'stop'
        ? row.background_choice
        : null,
    revision: row.revision,
    createdAt: row.created_at
  }
  if (!isLaunchTemplateRecord(record)) {
    throw new WorkspaceStoreError(ERROR_CODES.ioError, `Template ${row.template_id} is invalid`)
  }
  return record
}

function selectWorkspace(database: DatabaseConnection, workspaceId: string): WorkspaceRecord {
  const row = database
    .prepare(
      `SELECT workspace_id, name, default_cwd, position, marker, archived_at, revision
       FROM workspace WHERE workspace_id = ?`
    )
    .get(workspaceId) as WorkspaceRow | undefined
  if (!row) return missing('Workspace', workspaceId)
  return workspaceRecord(row)
}

function selectSession(database: DatabaseConnection, sessionId: string): SessionRecord {
  const row = database
    .prepare(
      `${SESSION_SELECT} WHERE s.session_id = ?`
    )
    .get(sessionId) as SessionRow | undefined
  if (!row) return missing('Session', sessionId)
  return sessionRecord(row)
}

/** Layout panes may combine sessions from different workspaces, so every existing stable ID is valid. */
function allSessionIds(database: DatabaseConnection): string[] {
  return (database
    .prepare('SELECT session_id FROM session')
    .all() as Array<{ session_id: string }>).map((row) => row.session_id)
}

export function listWorkspaces(
  database: DatabaseConnection,
  includeArchived = false
): WorkspaceRecord[] {
  const rows = database
    .prepare(
      `SELECT workspace_id, name, default_cwd, position, marker, archived_at, revision
       FROM workspace
       WHERE ? = 1 OR archived_at IS NULL
       ORDER BY CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END, position, workspace_id`
    )
    .all(includeArchived ? 1 : 0) as WorkspaceRow[]
  return rows.map(workspaceRecord)
}

export function createWorkspace(
  database: DatabaseConnection,
  params: WorkspaceCreateParams,
  workspaceId: string,
  now: string
): WorkspaceRecord {
  if (!isWorkspaceCreateParams(params)) invalid('Workspace create parameters are invalid')
  const nextPosition = params.position ?? Number((database
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM workspace')
    .get() as { position: number }).position)
  database
    .prepare(
      `INSERT INTO workspace(
        workspace_id, name, default_cwd, archived_at, revision, position, marker
      ) VALUES (?, ?, ?, NULL, 1, ?, ?)`
    )
    .run(
      workspaceId,
      params.name.trim(),
      params.defaultCwd ?? null,
      nextPosition,
      params.marker ?? DEFAULT_WORKSPACE_MARKER
    )
  const layout = emptyWorkspaceLayout(workspaceId)
  database
    .prepare(
      `INSERT INTO workspace_layout(workspace_id, layout_json, revision, updated_at)
       VALUES (?, ?, 1, ?)`
    )
    .run(workspaceId, JSON.stringify(layout), now)
  return selectWorkspace(database, workspaceId)
}

export function updateWorkspace(
  database: DatabaseConnection,
  params: WorkspaceUpdateParams,
  now: string
): WorkspaceRecord {
  if (!isWorkspaceUpdateParams(params)) invalid('Workspace update parameters are invalid')
  const current = selectWorkspace(database, params.workspaceId)
  if (current.revision !== params.expectedRevision) {
    return conflict('Workspace', params.workspaceId, current.revision)
  }
  const archivedAt = 'archived' in params
    ? params.archived
      ? current.archivedAt ?? now
      : null
    : current.archivedAt
  database
    .prepare(
      `UPDATE workspace
       SET name = ?, default_cwd = ?, position = ?, marker = ?, archived_at = ?, revision = ?
       WHERE workspace_id = ? AND revision = ?`
    )
    .run(
      params.name?.trim() ?? current.name,
      'defaultCwd' in params ? params.defaultCwd ?? null : current.defaultCwd,
      params.position ?? current.position,
      params.marker ?? current.marker,
      archivedAt,
      current.revision + 1,
      current.workspaceId,
      current.revision
    )
  return selectWorkspace(database, current.workspaceId)
}

export function listSessions(database: DatabaseConnection, workspaceId: string): SessionRecord[] {
  selectWorkspace(database, workspaceId)
  const rows = database
    .prepare(
      `${SESSION_SELECT} WHERE s.workspace_id = ?
       ORDER BY s.position, s.created_at, s.session_id`
    )
    .all(workspaceId) as SessionRow[]
  return rows.map(sessionRecord)
}

export function updateSession(
  database: DatabaseConnection,
  params: SessionUpdateParams,
  now: string
): SessionRecord {
  if (!isSessionUpdateParams(params)) invalid('Session update parameters are invalid')
  const current = selectSession(database, params.sessionId)
  if (current.revision !== params.expectedRevision) {
    return conflict('Session', params.sessionId, current.revision)
  }
  if (params.workspaceId !== undefined) selectWorkspace(database, params.workspaceId)
  const storedArgv = database
    .prepare('SELECT argv_json FROM session WHERE session_id = ?')
    .get(current.sessionId) as { argv_json: string }
  database
    .prepare(
      `UPDATE session
       SET workspace_id = ?, name = ?, cwd = ?, executable = ?, argv_json = ?,
           position = ?, background_choice = ?, archived_at = ?, revision = ?
       WHERE session_id = ? AND revision = ?`
    )
    .run(
      params.workspaceId ?? current.workspaceId,
      params.name?.trim() ?? current.name,
      params.cwd ?? current.cwd,
      params.executable ?? current.executable,
      params.argv !== undefined ? JSON.stringify(params.argv) : storedArgv.argv_json,
      params.position ?? current.position,
      'backgroundChoice' in params ? params.backgroundChoice ?? null : current.backgroundChoice,
      'archived' in params ? (params.archived ? current.archivedAt ?? now : null) : current.archivedAt,
      current.revision + 1,
      current.sessionId,
      current.revision
    )
  return selectSession(database, current.sessionId)
}

export function listTemplates(database: DatabaseConnection): LaunchTemplateRecord[] {
  const rows = database
    .prepare(
      `SELECT template_id, name, executable, argv_json, cwd, background_choice,
              revision, created_at
       FROM launch_template ORDER BY name, created_at, template_id`
    )
    .all() as TemplateRow[]
  return rows.map(templateRecord)
}

export function createTemplate(
  database: DatabaseConnection,
  params: TemplateCreateParams,
  templateId: string,
  now: string
): LaunchTemplateRecord {
  if (!isTemplateCreateParams(params)) invalid('Template create parameters are invalid')
  database
    .prepare(
      `INSERT INTO launch_template(
        template_id, name, executable, argv_json, cwd, background_choice, revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      templateId,
      params.name.trim(),
      params.executable,
      JSON.stringify(params.argv),
      params.cwd,
      params.backgroundChoice ?? null,
      now
    )
  const row = database
    .prepare(
      `SELECT template_id, name, executable, argv_json, cwd, background_choice,
              revision, created_at
       FROM launch_template WHERE template_id = ?`
    )
    .get(templateId) as TemplateRow
  return templateRecord(row)
}

export function getLayout(
  database: DatabaseConnection,
  workspaceId: string
): LayoutGetResult {
  const workspace = selectWorkspace(database, workspaceId)
  const row = database
    .prepare('SELECT layout_json, revision FROM workspace_layout WHERE workspace_id = ?')
    .get(workspaceId) as { layout_json: string; revision: unknown } | undefined
  const revisionIsValid = !!row &&
    Number.isSafeInteger(row.revision) && Number(row.revision) >= 1
  const recoveryRevision = revisionIsValid ? Number(row.revision) : 1
  let layout: unknown
  try {
    layout = row ? JSON.parse(row.layout_json) : undefined
  } catch {
    layout = undefined
  }
  if (
    row && revisionIsValid &&
    isWorkspaceLayoutState(layout, allSessionIds(database)) &&
    layout.workspaceId === workspaceId &&
    layout.revision === recoveryRevision
  ) {
    return { layout, notice: null }
  }
  // Degrade only this workspace's view cache; never rewrite the row on read.
  return {
    layout: { ...emptyWorkspaceLayout(workspaceId), revision: recoveryRevision },
    notice: `The saved layout for workspace "${workspace.name}" could not be read, so it opened ` +
      'with an empty view. Your sessions are unaffected; the next layout change replaces it.'
  }
}

export function putLayout(
  database: DatabaseConnection,
  workspaceId: string,
  expectedRevision: number,
  state: unknown,
  now: string
): WorkspaceLayoutState {
  selectWorkspace(database, workspaceId)
  const current = database
    .prepare('SELECT revision FROM workspace_layout WHERE workspace_id = ?')
    .get(workspaceId) as { revision: unknown } | undefined
  const currentRevision = current &&
    Number.isSafeInteger(current.revision) && Number(current.revision) >= 1
    ? Number(current.revision)
    : 1
  if (currentRevision !== expectedRevision) {
    return conflict('Workspace layout', workspaceId, currentRevision)
  }
  const sessionIds = allSessionIds(database)
  if (
    !isWorkspaceLayoutState(state, sessionIds) ||
    state.workspaceId !== workspaceId ||
    state.revision !== expectedRevision
  ) {
    return invalid('Workspace layout state is invalid')
  }
  const next: WorkspaceLayoutState = { ...state, revision: currentRevision + 1 }
  const revisionWasValid = !!current && currentRevision === current.revision
  const result = !current
    ? database
        .prepare(
          `INSERT INTO workspace_layout(workspace_id, layout_json, revision, updated_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(workspaceId, JSON.stringify(next), next.revision, now)
    : revisionWasValid
      ? database
          .prepare(
            `UPDATE workspace_layout SET layout_json = ?, revision = ?, updated_at = ?
             WHERE workspace_id = ? AND revision = ?`
          )
          .run(JSON.stringify(next), next.revision, now, workspaceId, currentRevision)
      : database
          .prepare(
            `UPDATE workspace_layout SET layout_json = ?, revision = ?, updated_at = ?
             WHERE workspace_id = ?`
          )
          .run(JSON.stringify(next), next.revision, now, workspaceId)
  if (Number(result.changes) !== 1) {
    return conflict('Workspace layout', workspaceId, currentRevision)
  }
  return next
}
