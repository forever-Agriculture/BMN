import {
  ERROR_CODES,
  type LaunchSetRecord,
  type LaunchSetStartParams,
  type LaunchSetStartResult,
  type WorkspaceRecord
} from '@bmn/protocol'
import {
  HostControlError, PersistedSessionStartError, resolveHomeDirectory,
  type CreateSessionParams
} from './session-manager'

interface StartedEntry {
  sessionId: string
  incarnationId: string
  attachment?: {
    attachmentId: string
    streamSeq: 0
    captureStartedAt: string
    modes: number[]
  }
}

interface LaunchSetDependencies {
  getSet(workspaceId: string, setId: string): Promise<LaunchSetRecord>
  listWorkspaces(): Promise<WorkspaceRecord[]>
  validate(params: CreateSessionParams): Promise<void>
  create(params: CreateSessionParams): Promise<StartedEntry>
}

/** One utility-process action per key, including a running action and its final partial result. */
export class LaunchSetCoordinator {
  private readonly actions = new Map<string, Promise<LaunchSetStartResult>>()

  constructor(private readonly dependencies: LaunchSetDependencies) {}

  start(request: LaunchSetStartParams): Promise<LaunchSetStartResult> {
    const existing = this.actions.get(request.idempotencyKey)
    if (existing) return existing
    const action = this.run(request)
    this.actions.set(request.idempotencyKey, action)
    void action.catch(() => undefined)
    return action
  }

  private async run(request: LaunchSetStartParams): Promise<LaunchSetStartResult> {
    const [set, workspaces] = await Promise.all([
      this.dependencies.getSet(request.workspaceId, request.setId),
      this.dependencies.listWorkspaces()
    ])
    const workspace = workspaces.find((item) => item.workspaceId === request.workspaceId)
    if (!workspace || workspace.archivedAt !== null) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Restore the workspace before launching a set')
    }
    if (set.revision !== request.expectedRevision) {
      throw new HostControlError(ERROR_CODES.revisionConflict, 'The launch set changed. Reopen its preview')
    }
    const directory = resolveHomeDirectory(request.directory)
    // Freeze the exact definitions before the first asynchronous validation or process start.
    const entries = set.entries.map((entry) => ({
      entryId: entry.entryId,
      name: entry.name,
      executable: entry.executable,
      argv: [...entry.argv],
      backgroundChoice: entry.backgroundChoice
    }))
    if (entries.length < 1 || entries.length > 8) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'A launch set must have 1–8 entries')
    }
    const launches: CreateSessionParams[] = entries.map((entry) => ({
      workspaceId: request.workspaceId,
      name: entry.name,
      cwd: directory,
      executable: entry.executable,
      argv: entry.argv,
      backgroundChoice: entry.backgroundChoice,
      cols: request.cols,
      rows: request.rows
    }))
    // A bad later entry must not leave earlier ones running from this action.
    for (const launch of launches) await this.dependencies.validate(launch)

    const result: LaunchSetStartResult = {
      workspaceId: request.workspaceId,
      setId: request.setId,
      revision: set.revision,
      directory: request.directory,
      entries: []
    }
    let stopped = false
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!
      if (stopped) {
        result.entries.push({ entryId: entry.entryId, name: entry.name, outcome: 'not-started' })
        continue
      }
      try {
        const started = await this.dependencies.create(launches[index]!)
        result.entries.push({
          entryId: entry.entryId,
          name: entry.name,
          outcome: 'started',
          sessionId: started.sessionId,
          incarnationId: started.incarnationId,
          ...(started.attachment ? { attachment: started.attachment } : {})
        })
      } catch (error) {
        result.entries.push({
          entryId: entry.entryId,
          name: entry.name,
          outcome: 'failed',
          ...(error instanceof PersistedSessionStartError ? { sessionId: error.sessionId } : {}),
          error: error instanceof Error ? error.message : 'The session could not be started'
        })
        stopped = true
      }
    }
    return result
  }
}
