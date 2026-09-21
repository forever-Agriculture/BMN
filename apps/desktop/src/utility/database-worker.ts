import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import type {
  SessionUpdateParams,
  TemplateCreateParams,
  WorkspaceCreateParams,
  WorkspaceUpdateParams
} from '@bmn/protocol'
import { purgeExpiredArchives } from './database-archive-purge'
import {
  databaseSettings,
  initializeDatabase,
  type DatabaseConnection
} from './database-initialization'
import {
  clearSessionConversationBinding,
  createResumingSession,
  createStartingSession,
  getSessionConversationBinding,
  listSessionConversationRoutes,
  markCohortOffered,
  markSessionExited,
  markSessionInterrupted,
  markSessionRunning,
  replaceSessionConversationBinding,
  selectInterruptedIncarnations
} from './database-session-store'
import {
  WorkspaceStoreError,
  createTemplate,
  createWorkspace,
  getLayout,
  listSessions,
  listTemplates,
  listWorkspaces,
  putLayout,
  updateSession,
  updateWorkspace
} from './database-workspace-store'
import { COMPANION_OPERATIONS, listReadyArtifacts, type CompanionOperationName } from './database-companion-store'

type DatabaseConstructor = new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => DatabaseConnection

interface WorkerRequest {
  id: number
  operation: string
  params?: Record<string, unknown>
}

interface WorkerResponse {
  id: number
  result?: unknown
  error?: { message: string; code?: string }
}

const workerParent = parentPort
if (!workerParent) throw new Error('database worker requires a parent port')

const databasePath = (workerData as { databasePath?: unknown }).databasePath
if (typeof databasePath !== 'string' || databasePath.length === 0) {
  throw new Error('database worker requires a database path')
}

const workerRequire = createRequire(__filename)
const BetterSqlite3 = workerRequire('better-sqlite3') as DatabaseConstructor
const database = new BetterSqlite3(databasePath)

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string') throw new Error(`database parameter ${key} must be a string`)
  return value
}

function requiredNumber(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`database parameter ${key} must be a number`)
  }
  return value
}

function requiredStringArray(params: Record<string, unknown>, key: string): string[] {
  const value = params[key]
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`database parameter ${key} must be an array of strings`)
  }
  return value
}

function health(): {
  runningIncarnations: number
  interruptedIncarnations: number
  sessionRecords: number
  incarnationRecords: number
  workspaceRecords: number
  schemaTables: string[]
  database: { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number }
} {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM process_incarnation WHERE state IN ('starting', 'running')")
    .get() as { count: number }
  const interruptedRow = database
    .prepare("SELECT COUNT(*) AS count FROM process_incarnation WHERE state = 'interrupted'")
    .get() as { count: number }
  const sessionRow = database.prepare('SELECT COUNT(*) AS count FROM session').get() as { count: number }
  const incarnationRow = database.prepare('SELECT COUNT(*) AS count FROM process_incarnation').get() as {
    count: number
  }
  const workspaceRow = database.prepare('SELECT COUNT(*) AS count FROM workspace').get() as {
    count: number
  }
  const schemaTables = (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>
  ).map((table) => table.name)
  return {
    runningIncarnations: row.count,
    interruptedIncarnations: interruptedRow.count,
    sessionRecords: sessionRow.count,
    incarnationRecords: incarnationRow.count,
    workspaceRecords: workspaceRow.count,
    schemaTables,
    database: databaseSettings(database)
  }
}

function handle(request: WorkerRequest): unknown {
  const params = request.params ?? {}
  switch (request.operation) {
    case 'initialize':
      return initializeDatabase(database)
    case 'create-starting':
      return createStartingSession(database, {
        sessionId: requiredString(params, 'sessionId'),
        incarnationId: requiredString(params, 'incarnationId'),
        workspaceId: requiredString(params, 'workspaceId'),
        name: requiredString(params, 'name'),
        cwd: requiredString(params, 'cwd'),
        executable: requiredString(params, 'executable'),
        argv: requiredStringArray(params, 'argv'),
        backgroundChoice:
          params.backgroundChoice === 'hide' || params.backgroundChoice === 'stop'
            ? params.backgroundChoice
            : null,
        processStartIdentity: requiredString(params, 'processStartIdentity'),
        startedAt: requiredString(params, 'startedAt'),
        binding: params.binding as never
      })
    case 'create-resuming':
      return createResumingSession(database, {
        sessionId: requiredString(params, 'sessionId'),
        incarnationId: requiredString(params, 'incarnationId'),
        processStartIdentity: requiredString(params, 'processStartIdentity'),
        startedAt: requiredString(params, 'startedAt')
      })
    case 'binding-get':
      return getSessionConversationBinding(database, requiredString(params, 'sessionId'))
    case 'binding-routes':
      return listSessionConversationRoutes(database)
    case 'binding-replace':
      return replaceSessionConversationBinding(database, params.binding as never)
    case 'binding-clear':
      return clearSessionConversationBinding(database, requiredString(params, 'sessionId'))
    case 'workspace-list':
      return listWorkspaces(database, params.includeArchived === true)
    case 'workspace-create':
      return database.transaction(() => createWorkspace(
        database,
        params as unknown as WorkspaceCreateParams,
        randomUUID(),
        new Date().toISOString()
      ))()
    case 'archive-purge':
      return database.transaction(() => purgeExpiredArchives(database, new Date().toISOString()))()
    case 'workspace-update':
      return database.transaction(() => updateWorkspace(
        database,
        params as unknown as WorkspaceUpdateParams,
        new Date().toISOString()
      ))()
    case 'session-list':
      return listSessions(database, requiredString(params, 'workspaceId'))
    case 'session-update':
      return database.transaction(() => updateSession(
        database,
        params as unknown as SessionUpdateParams,
        new Date().toISOString()
      ))()
    case 'template-list':
      return listTemplates(database)
    case 'template-create':
      return database.transaction(() => createTemplate(
        database,
        params as unknown as TemplateCreateParams,
        randomUUID(),
        new Date().toISOString()
      ))()
    case 'layout-get':
      return getLayout(database, requiredString(params, 'workspaceId'))
    case 'layout-put':
      return database.transaction(() => putLayout(
        database,
        requiredString(params, 'workspaceId'),
        requiredNumber(params, 'expectedRevision'),
        params.state,
        new Date().toISOString()
      ))()
    case 'mark-running':
      return markSessionRunning(database, requiredString(params, 'incarnationId'))
    case 'mark-exited':
      return markSessionExited(database, requiredString(params, 'incarnationId'), {
        exitCode: requiredNumber(params, 'exitCode'),
        ...(typeof params.signal === 'number' && Number.isInteger(params.signal)
          ? { signal: params.signal }
          : {})
      })
    case 'mark-interrupted':
      return markSessionInterrupted(
        database,
        requiredString(params, 'incarnationId'),
        requiredString(params, 'reason')
      )
    case 'interrupted-incarnations':
      return selectInterruptedIncarnations(database)
    case 'cohort-offered':
      return markCohortOffered(
        database,
        (params.incarnationIds as string[]) ?? [],
        requiredString(params, 'offeredAt')
      )
    case 'backup-into':
      // VACUUM INTO writes a consistent snapshot and cannot run inside a transaction.
      database.prepare('VACUUM INTO ?').run(requiredString(params, 'path'))
      return null
    case 'backup-ready-artifacts': {
      const snapshot = new BetterSqlite3(requiredString(params, 'path'), { readonly: true, fileMustExist: true })
      try {
        return listReadyArtifacts(snapshot)
      } finally {
        snapshot.close()
      }
    }
    case 'health':
      return health()
    case 'close':
      database.close()
      return null
    default: {
      const name = request.operation.startsWith('companion:')
        ? request.operation.slice('companion:'.length)
        : ''
      if (Object.hasOwn(COMPANION_OPERATIONS, name)) {
        const operation = COMPANION_OPERATIONS[name as CompanionOperationName] as (
          connection: DatabaseConnection,
          ...args: unknown[]
        ) => unknown
        const args = Array.isArray(params.args) ? params.args : []
        return database.transaction(() => operation(database, ...args))()
      }
      throw new Error(`unknown database worker operation: ${request.operation}`)
    }
  }
}

workerParent.on('message', (request: WorkerRequest) => {
  let response: WorkerResponse
  try {
    response = { id: request.id, result: handle(request) }
  } catch (error) {
    response = {
      id: request.id,
      error: {
        message: (error instanceof Error ? error.message : 'unknown database error').slice(0, 240),
        ...(error instanceof WorkspaceStoreError ? { code: error.code } : {})
      }
    }
  }
  workerParent.postMessage(response)
})
