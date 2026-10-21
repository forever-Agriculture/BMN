// MODULE: database-setup-store.ts - Atomic first-run initialization and durable completion
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { ERROR_CODES, isFirstRunSetupRecord, isFirstRunSetupUpdate,
  type FirstRunSetupRecord, type FirstRunSetupUpdate, type SetupDefaultsClaim } from '@bmn/protocol'
import type { DatabaseConnection } from './database-initialization'
import { createWorkspace, selectWorkspace, WorkspaceStoreError } from './database-workspace-store'

export function getFirstRunSetup(database: DatabaseConnection): FirstRunSetupRecord | null {
  const row = database.prepare(`SELECT state, workspace_id AS workspaceId, revision, updated_at AS updatedAt
    FROM first_run_setup WHERE singleton = 1`).get()
  if (row === undefined) return null
  if (!isFirstRunSetupRecord(row)) throw new WorkspaceStoreError(ERROR_CODES.ioError, 'Stored setup progress is invalid')
  return row
}

/** The record and workspace either both exist or neither does; later reads never create another. */
export function initializeFirstRunSetup(
  database: DatabaseConnection, existingProfile: boolean, home: string, now: string
): FirstRunSetupRecord {
  return database.transaction(() => {
    const previous = getFirstRunSetup(database)
    if (previous) return previous
    if (typeof existingProfile !== 'boolean' || !isAbsolute(home)) {
      throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, 'Setup initialization parameters are invalid')
    }
    const workspaceId = existingProfile ? null : randomUUID()
    if (workspaceId) createWorkspace(database, { name: 'Setup', defaultCwd: home }, workspaceId, now)
    const record: FirstRunSetupRecord = { state: existingProfile ? 'existing' : 'active', workspaceId, revision: 1, updatedAt: now }
    if (!isFirstRunSetupRecord(record)) throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, 'Setup initialization time is invalid')
    database.prepare('INSERT INTO first_run_setup (singleton, state, workspace_id, revision, updated_at) VALUES (1, ?, ?, ?, ?)')
      .run(record.state, record.workspaceId, record.revision, record.updatedAt)
    return record
  })()
}

/** Commit the identity before filesystem initialization; a later caller never receives creation authority. */
export function claimSetupDefaults(database: DatabaseConnection): SetupDefaultsClaim {
  return database.transaction(() => {
    const progress = getFirstRunSetup(database)
    if (!progress) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'Setup progress has not been initialized')
    if (progress.state === 'existing') throw new WorkspaceStoreError(ERROR_CODES.unauthorized, 'Existing profiles do not receive automatic setup defaults')
    const row = database.prepare('SELECT defaults_id AS setupId FROM first_run_setup WHERE singleton = 1').get() as { setupId: unknown }
    if (row.setupId !== null) {
      if (typeof row.setupId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.setupId)) {
        throw new WorkspaceStoreError(ERROR_CODES.ioError, 'Stored defaults identity is invalid; automatic initialization is blocked')
      }
      return { setupId: row.setupId, initialize: false }
    }
    const setupId = randomUUID()
    database.prepare('UPDATE first_run_setup SET defaults_id = ? WHERE singleton = 1').run(setupId)
    return { setupId, initialize: true }
  })()
}

export function updateFirstRunSetup(
  database: DatabaseConnection, params: FirstRunSetupUpdate, now: string
): FirstRunSetupRecord {
  return database.transaction(() => {
    if (!isFirstRunSetupUpdate(params) || !Number.isFinite(Date.parse(now))) {
      throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, 'Setup progress parameters are invalid')
    }
    const previous = getFirstRunSetup(database)
    if (!previous) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'Setup progress has not been initialized')
    if (previous.revision !== params.expectedRevision) {
      throw new WorkspaceStoreError(ERROR_CODES.revisionConflict, 'Setup progress changed; read it again')
    }
    // Existing profiles stay protected even if a stale window submits Finish or Skip.
    if (previous.state === 'existing' || previous.state === params.state) return previous
    database.prepare('UPDATE first_run_setup SET state = ?, revision = revision + 1, updated_at = ? WHERE singleton = 1')
      .run(params.state, now)
    return getFirstRunSetup(database)!
  })()
}

/** Only an explicit setup action calls this; reads and startup never recreate a workspace. */
export function ensureSetupWorkspace(database: DatabaseConnection, home: string, now: string): FirstRunSetupRecord {
  return database.transaction(() => {
    const progress = getFirstRunSetup(database)
    if (!progress) throw new WorkspaceStoreError(ERROR_CODES.notFound, 'Setup progress has not been initialized')
    if (progress.workspaceId) {
      if (selectWorkspace(database, progress.workspaceId).archivedAt !== null) {
        throw new WorkspaceStoreError(ERROR_CODES.invalidArgument, 'Restore the Setup workspace before starting another setup session')
      }
      return progress
    }
    const workspaceId = randomUUID()
    createWorkspace(database, { name: 'Setup', defaultCwd: home }, workspaceId, now)
    database.prepare('UPDATE first_run_setup SET workspace_id = ?, revision = revision + 1, updated_at = ? WHERE singleton = 1')
      .run(workspaceId, now)
    return getFirstRunSetup(database)!
  })()
}
