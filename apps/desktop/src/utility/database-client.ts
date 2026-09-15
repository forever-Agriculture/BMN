import { Worker } from 'node:worker_threads'
import {
  ERROR_CODES,
  type ArtifactRecord,
  type ExplicitConversationBinding,
  type LaunchTemplateRecord,
  type LayoutGetResult,
  type PersistedConversationBinding,
  type ProtocolErrorCode,
  type SessionRecord,
  type SessionUpdateParams,
  type TemplateCreateParams,
  type WorkspaceCreateParams,
  type WorkspaceLayoutState,
  type WorkspaceRecord,
  type WorkspaceUpdateParams
} from '@ai-terminal/protocol'
import type {
  CreateResumingRecord,
  CreateStartingRecord,
  IncarnationExit,
  SessionStore
} from './session-manager'
import type { ArchivePurgeResult } from './database-archive-purge'
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
    this.worker.on('error', (error) => this.rejectAll(error))
    this.worker.on('exit', (code) => {
      if (code !== 0) this.rejectAll(new Error(`database worker exited with code ${code}`))
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

  async replaceConversationBinding(
    binding: ExplicitConversationBinding
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
    await this.request('close')
    await this.worker.terminate()
  }

  private request(operation: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, operation, ...(params ? { params } : {}) })
    })
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
