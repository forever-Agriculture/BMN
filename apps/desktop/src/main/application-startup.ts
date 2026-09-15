import { basename } from 'node:path'
import {
  METHOD_REGISTRY,
  type LaunchTemplateRecord,
  type LayoutGetResult,
  type ProtocolMethod,
  type SessionCreateParams,
  type SessionRecord,
  type WorkspaceLayoutState,
  type WorkspaceRecord
} from '@ai-terminal/protocol'
import type { ApplicationLaunchSpec } from './launch-spec'

export const DEFAULT_LAUNCH_WORKSPACE_NAME = 'Personal'

export interface StartupHostClient {
  request<Result>(method: ProtocolMethod, params: object): Promise<Result>
}

export interface WorkspaceStartupState {
  activeWorkspaceId: string | null
  workspaces: WorkspaceRecord[]
  sessions: SessionRecord[]
  templates: LaunchTemplateRecord[]
  layouts: WorkspaceLayoutState[]
  layoutNotices: string[]
}

/**
 * Loads every workspace, its sessions and its layout. A workspace whose persisted layout is
 * unreadable arrives degraded with a notice from the host, so one bad view cache never fails the
 * rest of startup.
 */
export async function loadWorkspaceStartup(client: StartupHostClient): Promise<WorkspaceStartupState> {
  const workspaces = await client.request<WorkspaceRecord[]>(METHOD_REGISTRY.workspaceList, {
    includeArchived: true
  })
  const sessions = (
    await Promise.all(workspaces.map((workspace) =>
      client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
        workspaceId: workspace.workspaceId
      })
    ))
  ).flat()
  const layoutResults = await Promise.all(workspaces.map((workspace) =>
    client.request<LayoutGetResult>(METHOD_REGISTRY.layoutGet, {
      workspaceId: workspace.workspaceId
    })
  ))
  const templates = await client.request<LaunchTemplateRecord[]>(METHOD_REGISTRY.templateList, {})
  return {
    activeWorkspaceId: workspaces.find((workspace) => workspace.archivedAt === null)?.workspaceId ?? null,
    workspaces,
    sessions,
    templates,
    layouts: layoutResults.map((result) => result.layout),
    layoutNotices: layoutResults.flatMap((result) => (result.notice ? [result.notice] : []))
  }
}

export interface CreatedSessionIdentity {
  sessionId: string
  incarnationId: string
  binding: unknown
}

/**
 * Creates a session, attaches the renderer lease and resolves the persisted record. When
 * registration fails after the attach, the lease is detached before the failure propagates so no
 * attachment outlives a session the main process never registered.
 */
export async function attachCreatedSession<Attachment extends { attachmentId: string }>(
  client: StartupHostClient,
  params: SessionCreateParams
): Promise<{ identity: CreatedSessionIdentity; attachment: Attachment; record: SessionRecord }> {
  const identity = await client.request<CreatedSessionIdentity>(METHOD_REGISTRY.sessionCreate, params)
  const attachment = await client.request<Attachment>(METHOD_REGISTRY.terminalAttach, identity)
  try {
    const sessions = await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
      workspaceId: params.workspaceId
    })
    const record = sessions.find((candidate) => candidate.sessionId === identity.sessionId)
    if (!record) throw new Error(`Created session ${identity.sessionId} was not persisted`)
    return { identity, attachment, record }
  } catch (error) {
    try {
      await client.request(METHOD_REGISTRY.terminalDetach, { attachmentId: attachment.attachmentId })
    } catch {
      // Preserve the registration failure; the host revokes the lease when its port closes.
    }
    throw error
  }
}

/**
 * Places an explicit `--` launch: in the active workspace, or — when every workspace is archived or
 * none exists — in a default workspace created through the normal `workspace.create` store path.
 */
export async function createExplicitLaunchSession<Result>(
  client: StartupHostClient,
  startup: Pick<WorkspaceStartupState, 'activeWorkspaceId'>,
  launch: ApplicationLaunchSpec,
  createSession: (params: SessionCreateParams) => Promise<Result>
): Promise<Result> {
  const workspaceId = startup.activeWorkspaceId ?? (
    await client.request<WorkspaceRecord>(METHOD_REGISTRY.workspaceCreate, {
      name: DEFAULT_LAUNCH_WORKSPACE_NAME
    })
  ).workspaceId
  return createSession({
    workspaceId,
    name: basename(launch.executable) || 'Shell',
    cwd: launch.cwd,
    executable: launch.executable,
    argv: launch.argv,
    cols: 80,
    rows: 24
  })
}
