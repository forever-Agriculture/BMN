import { createRequire } from 'node:module'
import {
  DEFAULT_WORKSPACE_ID,
  METHOD_REGISTRY,
  emptyWorkspaceLayout,
  type ProtocolMethod,
  type SessionCreateParams,
  type WorkspaceCreateParams,
  type WorkspaceUpdateParams
} from '@ai-terminal/protocol'
import { describe, expect, it, vi } from 'vitest'
import { initializeDatabase, type DatabaseConnection } from '../utility/database-initialization'
import {
  createTemplate,
  createWorkspace,
  getLayout,
  listSessions,
  listTemplates,
  listWorkspaces,
  putLayout,
  updateWorkspace
} from '../utility/database-workspace-store'
import {
  DEFAULT_LAUNCH_WORKSPACE_NAME,
  attachCreatedSession,
  createExplicitLaunchSession,
  loadWorkspaceStartup,
  type StartupHostClient
} from './application-startup'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-09-13T12:00:00.000Z'

/** Routes the startup control methods to the real SQLite workspace store, as the host does. */
function storeClient(database: DatabaseConnection): StartupHostClient & { methods: string[] } {
  const methods: string[] = []
  let nextWorkspace = 1
  return {
    methods,
    async request<Result>(method: ProtocolMethod, params: object): Promise<Result> {
      methods.push(method)
      const input = params as Record<string, unknown>
      switch (method) {
        case METHOD_REGISTRY.workspaceList:
          return listWorkspaces(database, input.includeArchived === true) as Result
        case METHOD_REGISTRY.workspaceCreate:
          return database.transaction(() => createWorkspace(
            database,
            params as WorkspaceCreateParams,
            `workspace-created-${nextWorkspace++}`,
            now
          ))() as Result
        case METHOD_REGISTRY.sessionList:
          return listSessions(database, String(input.workspaceId)) as Result
        case METHOD_REGISTRY.layoutGet:
          return getLayout(database, String(input.workspaceId)) as Result
        case METHOD_REGISTRY.templateList:
          return listTemplates(database) as Result
        default:
          throw new Error(`unexpected startup method ${method}`)
      }
    }
  }
}

function insertSession(database: DatabaseConnection, sessionId: string, workspaceId: string): void {
  database.prepare(
    `INSERT INTO session(
      session_id, workspace_id, name, cwd, executable, argv_json,
      revision, created_at, position, background_choice
    ) VALUES (?, ?, ?, '/workspace', '/bin/bash', '[]', 1, ?, 0, NULL)`
  ).run(sessionId, workspaceId, `Session ${sessionId}`, now)
}

describe('application startup', () => {
  it('proceeds with a degraded, noticed layout when one workspace row holds invalid JSON', async () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      database.transaction(() => createWorkspace(database, { name: 'Broken' }, 'workspace-broken', now))()
      insertSession(database, 'session-healthy', DEFAULT_WORKSPACE_ID)
      const healthy = database.transaction(() => putLayout(database, DEFAULT_WORKSPACE_ID, 1, {
        ...emptyWorkspaceLayout(DEFAULT_WORKSPACE_ID),
        selectedSessionId: 'session-healthy',
        split: { orientation: 'stacked', panes: [{ sessionId: 'session-healthy', ratio: 1 }] }
      }, now))()
      database.prepare('UPDATE workspace_layout SET layout_json = ? WHERE workspace_id = ?')
        .run('not json at all', 'workspace-broken')

      const startup = await loadWorkspaceStartup(storeClient(database))

      expect(startup.activeWorkspaceId).toBe(DEFAULT_WORKSPACE_ID)
      expect(startup.workspaces.map((workspace) => workspace.workspaceId))
        .toEqual([DEFAULT_WORKSPACE_ID, 'workspace-broken'])
      expect(startup.layouts).toEqual([healthy, emptyWorkspaceLayout('workspace-broken')])
      expect(startup.layoutNotices).toHaveLength(1)
      expect(startup.layoutNotices[0]).toContain('workspace "Broken"')
      expect(startup.sessions.map((session) => session.sessionId)).toEqual(['session-healthy'])
    } finally {
      database.close()
    }
  })

  it('starts with a corrupt-argv session visible and blocked while healthy sessions remain usable', async () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      insertSession(database, 'session-broken', DEFAULT_WORKSPACE_ID)
      insertSession(database, 'session-healthy', DEFAULT_WORKSPACE_ID)
      database.prepare('UPDATE session SET argv_json = ? WHERE session_id = ?')
        .run('{broken-json', 'session-broken')

      const startup = await loadWorkspaceStartup(storeClient(database))
      const byId = new Map(startup.sessions.map((session) => [session.sessionId, session]))

      expect(byId.get('session-broken')).toMatchObject({
        argv: [],
        launchDisabledReason: expect.stringContaining('launching or resuming')
      })
      expect(byId.get('session-healthy')).toMatchObject({ argv: [] })
      expect(byId.get('session-healthy')).not.toHaveProperty('launchDisabledReason')
      expect(startup.layouts).toEqual([emptyWorkspaceLayout(DEFAULT_WORKSPACE_ID)])
    } finally {
      database.close()
    }
  })

  it('starts with one corrupt template unavailable while healthy records remain usable', async () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      insertSession(database, 'session-healthy', DEFAULT_WORKSPACE_ID)
      database.transaction(() => createTemplate(database, {
        name: 'Healthy template',
        executable: '/bin/bash',
        argv: ['--noprofile'],
        cwd: '/workspace/healthy'
      }, 'template-healthy', now))()
      database.transaction(() => createTemplate(database, {
        name: 'Broken template',
        executable: '/bin/bash',
        argv: ['before-corruption'],
        cwd: '/workspace/broken'
      }, 'template-broken', now))()
      database.prepare('UPDATE launch_template SET argv_json = ? WHERE template_id = ?')
        .run('{broken-json', 'template-broken')

      const startup = await loadWorkspaceStartup(storeClient(database))
      const templates = new Map(startup.templates.map((template) => [template.templateId, template]))

      expect(startup.workspaces.map((workspace) => workspace.workspaceId))
        .toEqual([DEFAULT_WORKSPACE_ID])
      expect(startup.sessions).toHaveLength(1)
      expect(startup.sessions[0]).toMatchObject({ sessionId: 'session-healthy', argv: [] })
      expect(templates.get('template-healthy')).toMatchObject({ argv: ['--noprofile'] })
      expect(templates.get('template-healthy')).not.toHaveProperty('launchDisabledReason')
      expect(templates.get('template-broken')).toMatchObject({
        argv: [],
        launchDisabledReason: expect.stringContaining('Recreate this launch template')
      })
      expect(startup.layouts).toEqual([emptyWorkspaceLayout(DEFAULT_WORKSPACE_ID)])
    } finally {
      database.close()
    }
  })

  it('creates the default workspace through workspace.create when an explicit launch finds none active', async () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      const personal = listWorkspaces(database)[0]!
      database.transaction(() => updateWorkspace(database, {
        workspaceId: personal.workspaceId,
        expectedRevision: personal.revision,
        archived: true
      } satisfies WorkspaceUpdateParams, now))()
      const client = storeClient(database)
      const before = await loadWorkspaceStartup(client)
      expect(before.activeWorkspaceId).toBeNull()
      const createSession = vi.fn(async (params: SessionCreateParams) => {
        insertSession(database, 'session-launched', params.workspaceId)
        return { sessionId: 'session-launched' }
      })

      await expect(createExplicitLaunchSession(client, before, {
        cwd: '/workspace',
        executable: '/usr/bin/codex',
        argv: ['resume']
      }, createSession)).resolves.toEqual({ sessionId: 'session-launched' })

      expect(client.methods).toContain(METHOD_REGISTRY.workspaceCreate)
      expect(createSession).toHaveBeenCalledWith({
        workspaceId: 'workspace-created-1',
        name: 'codex',
        cwd: '/workspace',
        executable: '/usr/bin/codex',
        argv: ['resume'],
        cols: 80,
        rows: 24
      })
      const after = await loadWorkspaceStartup(client)
      expect(after.activeWorkspaceId).toBe('workspace-created-1')
      expect(after.workspaces.find((workspace) => workspace.workspaceId === 'workspace-created-1'))
        .toMatchObject({ name: DEFAULT_LAUNCH_WORKSPACE_NAME, archivedAt: null })
      expect(after.sessions.find((session) => session.sessionId === 'session-launched'))
        .toMatchObject({ workspaceId: 'workspace-created-1' })
      expect(after.layouts.find((layout) => layout.workspaceId === 'workspace-created-1'))
        .toEqual(emptyWorkspaceLayout('workspace-created-1'))
    } finally {
      database.close()
    }
  })

  it('places an explicit launch in the active workspace without creating one', async () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      const client = storeClient(database)
      const startup = await loadWorkspaceStartup(client)
      const createSession = vi.fn(async (params: SessionCreateParams) => params.workspaceId)
      await expect(createExplicitLaunchSession(client, startup, {
        cwd: '/workspace', executable: '/bin/bash', argv: []
      }, createSession)).resolves.toBe(DEFAULT_WORKSPACE_ID)
      expect(client.methods).not.toContain(METHOD_REGISTRY.workspaceCreate)
    } finally {
      database.close()
    }
  })
})

describe('created session registration', () => {
  const params: SessionCreateParams = {
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: 'Shell',
    cwd: '/workspace',
    executable: '/bin/bash',
    argv: [],
    cols: 80,
    rows: 24
  }
  const persisted = {
    sessionId: 'session-new',
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: 'Shell',
    cwd: '/workspace',
    executable: '/bin/bash',
    argv: [],
    backgroundChoice: null,
    revision: 1,
    createdAt: now,
    position: 0
  }

  function registrationClient(sessionList: () => Promise<unknown>) {
    const calls: Array<{ method: ProtocolMethod; params: object }> = []
    const client: StartupHostClient = {
      async request<Result>(method: ProtocolMethod, requestParams: object): Promise<Result> {
        calls.push({ method, params: requestParams })
        if (method === METHOD_REGISTRY.sessionCreate) {
          return { sessionId: 'session-new', incarnationId: 'incarnation-new', binding: null } as Result
        }
        if (method === METHOD_REGISTRY.terminalAttach) {
          return { ...(requestParams as object), attachmentId: 'attachment-new', streamSeq: 0 } as Result
        }
        if (method === METHOD_REGISTRY.sessionList) return (await sessionList()) as Result
        if (method === METHOD_REGISTRY.terminalDetach) return { detached: true } as Result
        throw new Error(`unexpected registration method ${method}`)
      }
    }
    return { client, calls }
  }

  it.each([
    { failure: 'the created record was not persisted', sessionList: async () => [] },
    {
      failure: 'the session list request fails',
      sessionList: async () => Promise.reject(new Error('host list failed'))
    }
  ])('detaches the attached lease before propagating when $failure', async ({ sessionList }) => {
    const { client, calls } = registrationClient(sessionList)

    await expect(attachCreatedSession<{ attachmentId: string }>(client, params)).rejects.toThrow()

    expect(calls.map((call) => call.method)).toEqual([
      METHOD_REGISTRY.sessionCreate,
      METHOD_REGISTRY.terminalAttach,
      METHOD_REGISTRY.sessionList,
      METHOD_REGISTRY.terminalDetach
    ])
    expect(calls.at(-1)?.params).toEqual({ attachmentId: 'attachment-new' })
  })

  it('keeps the lease attached and returns the persisted record when registration succeeds', async () => {
    const { client, calls } = registrationClient(async () => [persisted])

    const created = await attachCreatedSession<{ attachmentId: string }>(client, params)

    expect(created.record).toEqual(persisted)
    expect(created.attachment.attachmentId).toBe('attachment-new')
    expect(calls.map((call) => call.method)).not.toContain(METHOD_REGISTRY.terminalDetach)
  })
})
