import { Worker } from 'node:worker_threads'
import {
  ERROR_CODES,
  type ArtifactRecord,
  type LaunchTemplateRecord,
  type LaunchSetRecord,
  type LaunchSetCreateParams,
  type LaunchSetUpdateParams,
  type LaunchSetDeleteParams,
  type LayoutGetResult,
  type ConversationRouteSummary,
  type PersistedConversationBinding,
  type ReplaceableConversationBinding,
  type ProtocolErrorCode,
  type SessionRecord,
  type SessionUpdateParams,
  type TemplateCreateParams,
  type WorkspaceCreateParams,
  type WorkspaceLayoutState,
  type WorkspaceRecord,
  type WorkspaceUpdateParams
} from '@bmn/protocol'
import type {
  CreateResumingRecord,
  CreateStartingRecord,
  IncarnationExit,
  SessionStore
} from './session-manager'
import type { ArchivePurgeResult } from './database-archive-purge'
import type { InterruptedIncarnationRow } from './interrupted-cohort'
import type { CompanionOperationName, CompanionOperations } from './database-companion-store'

type CompanionArguments<Name extends CompanionOperationName> =
  CompanionOperations[Name] extends (connection: never, ...args: infer Args) => unknown ? Args : never

interface WorkerResponse {
  id: number
  result?: unknown
  error?: { message: string; code?: string }
}

export class DatabaseClientError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'DatabaseClientError'
  }
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

export class DatabaseWorkerClient implements SessionStore {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private failure: Error | undefined
  private closed = false

  constructor(workerEntry: string, databasePath: string) {
    this.worker = new Worker(workerEntry, { workerData: { databasePath } })
    this.worker.on('message', (response: WorkerResponse) => {
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      if (response.error) {
        const code = Object.values(ERROR_CODES).includes(response.error.code as ProtocolErrorCode)
          ? response.error.code as ProtocolErrorCode
          : ERROR_CODES.ioError
        pending.reject(new DatabaseClientError(code, response.error.message))
      }
      else pending.resolve(response.result)
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => {
      if (!this.closed) this.fail(new Error(`database worker exited with code ${code}`))
    })
  }

  async initialize(): Promise<{
    schemaTables: readonly string[]
    database: { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number }
    interruptedIncarnations: number
  }> {
    return (await this.request('initialize')) as {
      schemaTables: readonly string[]
      database: { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number }
      interruptedIncarnations: number
    }
  }

  async createStarting(record: CreateStartingRecord): Promise<void> {
    await this.request('create-starting', { ...record, argv: [...record.argv] })
  }

  async createResuming(record: CreateResumingRecord): Promise<void> {
    await this.request('create-resuming', { ...record })
  }

  async getConversationBinding(
    sessionId: string
  ): Promise<PersistedConversationBinding | undefined> {
    return (await this.request('binding-get', { sessionId })) as
      | PersistedConversationBinding
      | undefined
  }

  /** The route of every stored binding, for the snapshot and list projections. */
  async listConversationRoutes(): Promise<ConversationRouteSummary[]> {
    return (await this.request('binding-routes')) as ConversationRouteSummary[]
  }

  async replaceConversationBinding(
    binding: ReplaceableConversationBinding
  ): Promise<PersistedConversationBinding> {
    return (await this.request('binding-replace', { binding })) as PersistedConversationBinding
  }

  async clearConversationBinding(sessionId: string): Promise<boolean> {
    return (await this.request('binding-clear', { sessionId })) as boolean
  }

  /** Deletes sessions and workspaces archived longer than the owner's setting; call only before any launch. */
  async purgeExpiredArchives(): Promise<ArchivePurgeResult> {
    return (await this.request('archive-purge')) as ArchivePurgeResult
  }

  async listWorkspaces(includeArchived = false): Promise<WorkspaceRecord[]> {
    return (await this.request('workspace-list', { includeArchived })) as WorkspaceRecord[]
  }

  async createWorkspace(params: WorkspaceCreateParams): Promise<WorkspaceRecord> {
    return (await this.request('workspace-create', { ...params })) as WorkspaceRecord
  }

  async updateWorkspace(params: WorkspaceUpdateParams): Promise<WorkspaceRecord> {
    return (await this.request('workspace-update', { ...params })) as WorkspaceRecord
  }

  async listSessions(workspaceId: string): Promise<SessionRecord[]> {
    return (await this.request('session-list', { workspaceId })) as SessionRecord[]
  }

  async updateSession(params: SessionUpdateParams): Promise<SessionRecord> {
    return (await this.request('session-update', { ...params })) as SessionRecord
  }

  async listTemplates(): Promise<LaunchTemplateRecord[]> {
    return (await this.request('template-list')) as LaunchTemplateRecord[]
  }

  async createTemplate(params: TemplateCreateParams): Promise<LaunchTemplateRecord> {
    return (await this.request('template-create', { ...params, argv: [...params.argv] })) as LaunchTemplateRecord
  }

  async listLaunchSets(workspaceId: string): Promise<LaunchSetRecord[]> {
    return (await this.request('launch-set-list', { workspaceId })) as LaunchSetRecord[]
  }

  async getLaunchSet(workspaceId: string, setId: string): Promise<LaunchSetRecord> {
    return (await this.request('launch-set-get', { workspaceId, setId })) as LaunchSetRecord
  }

  async createLaunchSet(params: LaunchSetCreateParams): Promise<LaunchSetRecord> {
    return (await this.request('launch-set-create', { ...params })) as LaunchSetRecord
  }

  async updateLaunchSet(params: LaunchSetUpdateParams): Promise<LaunchSetRecord> {
    return (await this.request('launch-set-update', { ...params })) as LaunchSetRecord
  }

  async deleteLaunchSet(params: LaunchSetDeleteParams): Promise<{ deleted: true }> {
    return (await this.request('launch-set-delete', { ...params })) as { deleted: true }
  }

  async getLayout(workspaceId: string): Promise<LayoutGetResult> {
    return (await this.request('layout-get', { workspaceId })) as LayoutGetResult
  }

  async putLayout(
    workspaceId: string,
    expectedRevision: number,
    state: WorkspaceLayoutState
  ): Promise<WorkspaceLayoutState> {
    return (await this.request('layout-put', {
      workspaceId,
      expectedRevision,
      state
    })) as WorkspaceLayoutState
  }

  async markRunning(incarnationId: string): Promise<void> {
    await this.request('mark-running', { incarnationId })
  }

  async markExited(incarnationId: string, exit: IncarnationExit): Promise<void> {
    await this.request('mark-exited', { incarnationId, ...exit })
  }

  async markInterrupted(incarnationId: string, reason: string): Promise<void> {
    await this.request('mark-interrupted', { incarnationId, reason })
  }

  /** Every unarchived session whose latest incarnation is recorded interrupted. Reads only. */
  async listInterruptedIncarnations(): Promise<InterruptedIncarnationRow[]> {
    return (await this.request('interrupted-incarnations')) as InterruptedIncarnationRow[]
  }

  async markCohortOffered(incarnationIds: readonly string[], offeredAt: string): Promise<void> {
    await this.request('cohort-offered', { incarnationIds: [...incarnationIds], offeredAt })
  }

  async health(): Promise<{
    runningIncarnations: number
    interruptedIncarnations: number
    sessionRecords: number
    incarnationRecords: number
    workspaceRecords: number
    schemaTables: readonly string[]
    database: { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number }
  }> {
    return (await this.request('health')) as {
      runningIncarnations: number
      interruptedIncarnations: number
      sessionRecords: number
      incarnationRecords: number
      workspaceRecords: number
      schemaTables: readonly string[]
      database: { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number }
    }
  }

  async companion<Name extends CompanionOperationName>(
    name: Name,
    ...args: CompanionArguments<Name>
  ): Promise<ReturnType<CompanionOperations[Name]>> {
    return (await this.request(`companion:${name}`, { args })) as ReturnType<CompanionOperations[Name]>
  }

  async backupInto(path: string): Promise<void> {
    await this.request('backup-into', { path })
  }

  /** Ready artifacts recorded in a backup's database file, read without modifying it. */
  async readyArtifactsInBackup(path: string): Promise<ArtifactRecord[]> {
    return (await this.request('backup-ready-artifacts', { path })) as ArtifactRecord[]
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.request('close')
    this.closed = true
    await this.worker.terminate()
  }

  private request(operation: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed) return Promise.reject(new Error('database worker is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.worker.postMessage({ id, operation, ...(params ? { params } : {}) })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error('database worker request could not be sent'))
      }
    })
  }

  private fail(error: Error): void {
    this.failure ??= error
    this.rejectAll(this.failure)
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
