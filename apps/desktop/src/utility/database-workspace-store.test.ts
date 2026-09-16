import { createRequire } from 'node:module'
import {
  ERROR_CODES,
  emptyWorkspaceLayout,
  type PersistedConversationBinding,
  type WorkspaceLayoutState
} from '@ai-terminal/protocol'
import { describe, expect, it } from 'vitest'
import { captureRelevantLaunchEnvironment } from './conversation-binding'
import { insertConversationBinding } from './database-binding-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
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
import { DEFAULT_WORKSPACE_ID } from './store-schema'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-09-13T12:00:00.000Z'

function insertSession(
  database: DatabaseConnection,
  input: { sessionId: string; workspaceId: string; position: number; cwd: string; argv: string[] }
): void {
  database.prepare(
    `INSERT INTO session(
      session_id, workspace_id, name, cwd, executable, argv_json,
      revision, created_at, position, background_choice
    ) VALUES (?, ?, ?, ?, '/usr/bin/codex', ?, 1, ?, ?, NULL)`
  ).run(
    input.sessionId,
    input.workspaceId,
    `Session ${input.sessionId}`,
    input.cwd,
    JSON.stringify(input.argv),
    now,
    input.position
  )
}

function binding(sessionId: string, reference: string): PersistedConversationBinding {
  return {
    sessionId,
    agentCli: 'codex',
    status: 'bound',
    conversationReference: reference,
    captureRoute: 'explicit-resume-reference',
    launchContext: {
      cwd: `/workspace/${sessionId}`,
      executable: '/usr/bin/codex',
      argv: [],
      environment: captureRelevantLaunchEnvironment({})
    },
    detail: 'explicit fixture binding',
    capturedAt: now
  }
}

describe('workspace database store', () => {
  it('keeps stable records through workspace and session mutations', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      const work = database.transaction(() => createWorkspace(
        database,
        { name: 'Work', defaultCwd: '/workspace', position: 1 },
        'workspace-work',
        now
      ))()
      insertSession(database, {
        sessionId: 'session-a',
        workspaceId: DEFAULT_WORKSPACE_ID,
        position: 0,
        cwd: '/workspace/a',
        argv: ['resume', 'one']
      })
      insertSession(database, {
        sessionId: 'session-b',
        workspaceId: work.workspaceId,
        position: 0,
        cwd: '/workspace/b',
        argv: ['resume', 'two']
      })
      insertConversationBinding(
        database,
        binding('session-a', '11111111-1111-4111-8111-111111111111')
      )
      insertConversationBinding(
        database,
        binding('session-b', '22222222-2222-4222-8222-222222222222')
      )
      database.prepare(
        `INSERT INTO process_incarnation(
          incarnation_id, session_id, process_start_identity, state, started_at
        ) VALUES ('incarnation-a', 'session-a', 'linux-proc-start:1', 'exited', ?)`
      ).run(now)

      const renamed = database.transaction(() => updateSession(database, {
        sessionId: 'session-a',
        expectedRevision: 1,
        name: 'Renamed A',
        cwd: '/workspace/edited',
        executable: '/bin/bash',
        argv: ['--noprofile'],
        position: 3
      }, now))()
      expect(renamed).toMatchObject({
        sessionId: 'session-a',
        workspaceId: DEFAULT_WORKSPACE_ID,
        name: 'Renamed A',
        position: 3,
        cwd: '/workspace/edited',
        executable: '/bin/bash',
        argv: ['--noprofile'],
        revision: 2
      })

      const archivedAt = '2026-09-14T10:00:00.000Z'
      const archivedSession = database.transaction(() => updateSession(database, {
        sessionId: 'session-a',
        expectedRevision: renamed.revision,
        archived: true
      }, archivedAt))()
      expect(archivedSession).toEqual({ ...renamed, archivedAt, revision: renamed.revision + 1 })
      const archivedAgain = database.transaction(() => updateSession(database, {
        sessionId: 'session-a',
        expectedRevision: archivedSession.revision,
        archived: true
      }, '2026-09-15T10:00:00.000Z'))()
      expect(archivedAgain.archivedAt).toBe(archivedAt)
      const restored = database.transaction(() => updateSession(database, {
        sessionId: 'session-a',
        expectedRevision: archivedAgain.revision,
        archived: false
      }, now))()
      expect(restored).toEqual({ ...renamed, archivedAt: null, revision: archivedAgain.revision + 1 })
      expect(database.prepare("SELECT COUNT(*) AS n FROM process_incarnation WHERE session_id = 'session-a'").get())
        .toEqual({ n: 1 })

      const moved = database.transaction(() => updateSession(database, {
        sessionId: 'session-a',
        expectedRevision: restored.revision,
        workspaceId: work.workspaceId,
        position: 1,
        backgroundChoice: 'hide'
      }, now))()
      expect(moved).toMatchObject({
        sessionId: 'session-a',
        workspaceId: work.workspaceId,
        name: 'Renamed A',
        cwd: '/workspace/edited',
        executable: '/bin/bash',
        argv: ['--noprofile'],
        position: 1,
        backgroundChoice: 'hide',
        revision: restored.revision + 1
      })
      expect(database.prepare(
        `SELECT session_id, cwd, executable, argv_json
         FROM session WHERE session_id = 'session-a'`
      ).get()).toEqual({
        session_id: 'session-a',
        cwd: '/workspace/edited',
        executable: '/bin/bash',
        argv_json: '["--noprofile"]'
      })
      expect(listSessions(database, work.workspaceId).map((session) => session.sessionId))
        .toEqual(['session-b', 'session-a'])

      const incarnationsBefore = database.prepare(
        'SELECT * FROM process_incarnation ORDER BY incarnation_id'
      ).all()
      const bindingsBefore = database.prepare(
        'SELECT * FROM conversation_binding ORDER BY session_id'
      ).all()
      const archived = database.transaction(() => updateWorkspace(
        database,
        { workspaceId: work.workspaceId, expectedRevision: 1, archived: true },
        '2026-09-13T12:01:00.000Z'
      ))()
      expect(archived).toMatchObject({
        workspaceId: work.workspaceId,
        archivedAt: '2026-09-13T12:01:00.000Z',
        revision: 2
      })
      expect(database.prepare('SELECT * FROM process_incarnation ORDER BY incarnation_id').all())
        .toEqual(incarnationsBefore)
      expect(database.prepare('SELECT * FROM conversation_binding ORDER BY session_id').all())
        .toEqual(bindingsBefore)
      expect(listWorkspaces(database).map((workspace) => workspace.workspaceId))
        .toEqual([DEFAULT_WORKSPACE_ID])
      expect(listWorkspaces(database, true).map((workspace) => workspace.workspaceId))
        .toEqual([DEFAULT_WORKSPACE_ID, work.workspaceId])
    } finally {
      database.close()
    }
  })

  it('reports each session latest recorded incarnation outcome and never claims a process is live', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      for (const [position, sessionId] of ['exited', 'stopped', 'interrupted', 'running', 'never'].entries()) {
        insertSession(database, { sessionId, workspaceId: DEFAULT_WORKSPACE_ID, position, cwd: '/workspace', argv: [] })
      }
      const incarnation = database.prepare(
        `INSERT INTO process_incarnation(
          incarnation_id, session_id, process_start_identity, state, started_at, exit_code, exit_signal, exit_detail
        ) VALUES (?, ?, 'linux-proc-start:1', ?, ?, ?, ?, ?)`
      )
      incarnation.run('exited-old', 'exited', 'interrupted', '2026-09-13T11:00:00.000Z', null, null, 'older restart')
      incarnation.run('exited-new', 'exited', 'exited', '2026-09-13T11:30:00.000Z', 3, null, null)
      incarnation.run('stopped-1', 'stopped', 'exited', now, 0, 1, null)
      incarnation.run('interrupted-1', 'interrupted', 'interrupted', now, null, null, 'BMN restarted before this process exited')
      incarnation.run('running-1', 'running', 'running', now, null, null, null)

      const byId = new Map(listSessions(database, DEFAULT_WORKSPACE_ID).map((record) => [record.sessionId, record.lastProcess]))
      expect(byId.get('exited')).toEqual({ incarnationId: 'exited-new', state: 'exited', exitCode: 3, signal: null, detail: null })
      expect(byId.get('stopped')).toEqual({ incarnationId: 'stopped-1', state: 'exited', exitCode: 0, signal: 1, detail: null })
      expect(byId.get('interrupted')).toEqual({
        incarnationId: 'interrupted-1',
        state: 'interrupted',
        exitCode: null,
        signal: null,
        detail: 'BMN restarted before this process exited'
      })
      expect(byId.get('running')).toEqual({ incarnationId: 'running-1', state: 'interrupted', exitCode: null, signal: null, detail: null })
      expect(byId.get('never')).toBeNull()
      const updated = database.transaction(() => updateSession(database, {
        sessionId: 'stopped',
        expectedRevision: 1,
        name: 'Renamed'
      }, now))()
      expect(updated.lastProcess).toEqual(byId.get('stopped'))
    } finally {
      database.close()
    }
  })

  it('round-trips templates and validates layout writes with optimistic revisions', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      insertSession(database, {
        sessionId: 'session-a',
        workspaceId: DEFAULT_WORKSPACE_ID,
        position: 0,
        cwd: '/workspace/a',
        argv: []
      })
      insertSession(database, {
        sessionId: 'session-b',
        workspaceId: DEFAULT_WORKSPACE_ID,
        position: 1,
        cwd: '/workspace/b',
        argv: []
      })
      const template = database.transaction(() => createTemplate(
        database,
        {
          name: 'Codex review',
          executable: '/usr/bin/codex',
          argv: ['--model', 'gpt'],
          cwd: '/workspace',
          backgroundChoice: 'stop'
        },
        'template-codex',
        now
      ))()
      expect(listTemplates(database)).toEqual([template])

      expect(getLayout(database, DEFAULT_WORKSPACE_ID)).toEqual({
        layout: {
          workspaceId: DEFAULT_WORKSPACE_ID,
          selectedSessionId: null,
          split: { orientation: 'side-by-side', panes: [] },
          sessionView: {},
          revision: 1
        },
        notice: null
      })
      const state: WorkspaceLayoutState = {
        workspaceId: DEFAULT_WORKSPACE_ID,
        selectedSessionId: 'session-a',
        split: {
          orientation: 'side-by-side',
          panes: [
            { sessionId: 'session-a', ratio: 0.5 },
            { sessionId: 'session-b', ratio: 0.5 }
          ]
        },
        sessionView: {
          'session-a': { scrollLine: 20, followTail: false },
          'session-b': { scrollLine: null, followTail: true }
        },
        revision: 1
      }
      const stored = database.transaction(() => putLayout(
        database,
        DEFAULT_WORKSPACE_ID,
        1,
        state,
        now
      ))()
      expect(stored).toMatchObject({ revision: 2, selectedSessionId: 'session-a' })
      expect(JSON.stringify(stored)).not.toContain('orderedSessionIds')
      expect(() => database.transaction(() => putLayout(
        database,
        DEFAULT_WORKSPACE_ID,
        1,
        state,
        now
      ))()).toThrowError(expect.objectContaining({
        code: ERROR_CODES.revisionConflict
      }))

      const duplicatePane = {
        ...stored,
        split: {
          ...stored.split,
          panes: [
            { sessionId: 'session-a', ratio: 0.5 },
            { sessionId: 'session-a', ratio: 0.5 }
          ]
        }
      }
      expect(() => database.transaction(() => putLayout(
        database,
        DEFAULT_WORKSPACE_ID,
        stored.revision,
        duplicatePane,
        now
      ))()).toThrowError(expect.objectContaining({
        code: ERROR_CODES.invalidArgument
      }))
      expect(() => database.transaction(() => putLayout(
        database,
        DEFAULT_WORKSPACE_ID,
        stored.revision,
        { ...stored, selectedSessionId: 'session-outside' },
        now
      ))()).toThrow(WorkspaceStoreError)
      expect(getLayout(database, DEFAULT_WORKSPACE_ID)).toEqual({ layout: stored, notice: null })
    } finally {
      database.close()
    }
  })

  it('persists a split containing sessions from two workspaces and rejects a missing session', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      database.transaction(() => createWorkspace(database, { name: 'Other' }, 'workspace-other', now))()
      insertSession(database, {
        sessionId: 'session-home', workspaceId: DEFAULT_WORKSPACE_ID, position: 0, cwd: '/workspace/home', argv: []
      })
      insertSession(database, {
        sessionId: 'session-other', workspaceId: 'workspace-other', position: 0, cwd: '/workspace/other', argv: []
      })
      const initial = getLayout(database, DEFAULT_WORKSPACE_ID).layout
      const crossWorkspace: WorkspaceLayoutState = {
        ...initial,
        selectedSessionId: 'session-other',
        split: {
          orientation: 'side-by-side',
          panes: [
            { sessionId: 'session-home', ratio: 0.5 },
            { sessionId: 'session-other', ratio: 0.5 }
          ]
        },
        sessionView: {
          'session-home': { scrollLine: null, followTail: true },
          'session-other': { scrollLine: null, followTail: true }
        }
      }

      const stored = database.transaction(() => putLayout(
        database, DEFAULT_WORKSPACE_ID, initial.revision, crossWorkspace, now
      ))()
      expect(getLayout(database, DEFAULT_WORKSPACE_ID)).toEqual({ layout: stored, notice: null })
      expect(() => database.transaction(() => putLayout(
        database,
        DEFAULT_WORKSPACE_ID,
        stored.revision,
        {
          ...stored,
          selectedSessionId: 'session-missing',
          split: { ...stored.split, panes: [{ sessionId: 'session-missing', ratio: 1 }] }
        },
        now
      ))()).toThrowError(expect.objectContaining({ code: ERROR_CODES.invalidArgument }))
    } finally {
      database.close()
    }
  })

  it.each([
    ['invalid JSON', () => '{"workspaceId": "workspace-broken", "split": '],
    ['a closed-shape violation', () => JSON.stringify({
      ...emptyWorkspaceLayout('workspace-broken'),
      sessionOrder: ['session-broken']
    })]
  ])('degrades only the workspace whose stored layout holds %s and replaces it on the next valid put', (_case, corruptJson) => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      database.transaction(() => createWorkspace(
        database,
        { name: 'Broken', defaultCwd: '/workspace' },
        'workspace-broken',
        now
      ))()
      insertSession(database, {
        sessionId: 'session-broken',
        workspaceId: 'workspace-broken',
        position: 0,
        cwd: '/workspace',
        argv: []
      })
      insertSession(database, {
        sessionId: 'session-healthy',
        workspaceId: DEFAULT_WORKSPACE_ID,
        position: 0,
        cwd: '/workspace',
        argv: []
      })
      const healthy = database.transaction(() => putLayout(
        database,
        DEFAULT_WORKSPACE_ID,
        1,
        {
          ...emptyWorkspaceLayout(DEFAULT_WORKSPACE_ID),
          selectedSessionId: 'session-healthy',
          split: { orientation: 'side-by-side', panes: [{ sessionId: 'session-healthy', ratio: 1 }] }
        },
        now
      ))()
      const corrupt = corruptJson()
      database.prepare(
        'UPDATE workspace_layout SET layout_json = ?, revision = 3 WHERE workspace_id = ?'
      ).run(corrupt, 'workspace-broken')
      const storedRow = () => database
        .prepare('SELECT layout_json, revision, updated_at FROM workspace_layout WHERE workspace_id = ?')
        .get('workspace-broken')
      const rowBeforeRead = storedRow()

      const degraded = getLayout(database, 'workspace-broken')
      expect(degraded.layout).toEqual({ ...emptyWorkspaceLayout('workspace-broken'), revision: 3 })
      expect(degraded.notice).toContain('workspace "Broken"')
      expect(storedRow()).toEqual(rowBeforeRead)
      expect(storedRow()).toMatchObject({ layout_json: corrupt })
      expect(getLayout(database, DEFAULT_WORKSPACE_ID)).toEqual({ layout: healthy, notice: null })

      const replaced = database.transaction(() => putLayout(
        database,
        'workspace-broken',
        degraded.layout.revision,
        {
          ...degraded.layout,
          selectedSessionId: 'session-broken',
          split: { orientation: 'side-by-side', panes: [{ sessionId: 'session-broken', ratio: 1 }] }
        },
        now
      ))()
      expect(replaced.revision).toBe(4)
      expect(getLayout(database, 'workspace-broken')).toEqual({ layout: replaced, notice: null })
      expect(storedRow()).toMatchObject({ layout_json: JSON.stringify(replaced), revision: 4 })
    } finally {
      database.close()
    }
  })

  it.each([
    {
      corruption: 'a missing row',
      corrupt: (database: DatabaseConnection) => {
        database.prepare('DELETE FROM workspace_layout WHERE workspace_id = ?')
          .run('workspace-broken')
      }
    },
    {
      corruption: 'a non-integer revision',
      corrupt: (database: DatabaseConnection) => {
        database.prepare('UPDATE workspace_layout SET revision = ? WHERE workspace_id = ?')
          .run(1.5, 'workspace-broken')
      }
    },
    {
      corruption: 'an invalid revision',
      corrupt: (database: DatabaseConnection) => {
        database.prepare('UPDATE workspace_layout SET revision = ? WHERE workspace_id = ?')
          .run('not-a-revision', 'workspace-broken')
      }
    }
  ])('degrades a workspace layout with $corruption at a revision the next put accepts', ({ corrupt }) => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      database.transaction(() => createWorkspace(
        database,
        { name: 'Broken' },
        'workspace-broken',
        now
      ))()
      const healthy = getLayout(database, DEFAULT_WORKSPACE_ID)
      corrupt(database)

      const degraded = getLayout(database, 'workspace-broken')
      expect(degraded.layout).toEqual(emptyWorkspaceLayout('workspace-broken'))
      expect(degraded.notice).toContain('workspace "Broken"')
      expect(getLayout(database, DEFAULT_WORKSPACE_ID)).toEqual(healthy)

      const replaced = database.transaction(() => putLayout(
        database,
        'workspace-broken',
        degraded.layout.revision,
        degraded.layout,
        now
      ))()
      expect(replaced).toEqual({ ...emptyWorkspaceLayout('workspace-broken'), revision: 2 })
      expect(getLayout(database, 'workspace-broken')).toEqual({ layout: replaced, notice: null })
      expect(() => getLayout(database, 'workspace-does-not-exist')).toThrowError(
        expect.objectContaining({ code: ERROR_CODES.notFound })
      )
    } finally {
      database.close()
    }
  })

  it('keeps one session visible with an actionable launch block when its argv JSON is corrupt', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      insertSession(database, {
        sessionId: 'session-broken',
        workspaceId: DEFAULT_WORKSPACE_ID,
        position: 0,
        cwd: '/workspace/broken',
        argv: ['before-corruption']
      })
      insertSession(database, {
        sessionId: 'session-healthy',
        workspaceId: DEFAULT_WORKSPACE_ID,
        position: 1,
        cwd: '/workspace/healthy',
        argv: ['healthy']
      })
      database.prepare('UPDATE session SET argv_json = ? WHERE session_id = ?')
        .run('{not-json', 'session-broken')

      const records = new Map(listSessions(database, DEFAULT_WORKSPACE_ID)
        .map((record) => [record.sessionId, record]))
      expect(records.get('session-broken')).toMatchObject({
        argv: [],
        launchDisabledReason: expect.stringContaining('Edit and save its arguments')
      })
      expect(records.get('session-healthy')).toMatchObject({ argv: ['healthy'] })
      expect(records.get('session-healthy')).not.toHaveProperty('launchDisabledReason')

      const renamed = database.transaction(() => updateSession(database, {
        sessionId: 'session-broken',
        expectedRevision: 1,
        name: 'Still blocked'
      }, now))()
      expect(renamed.launchDisabledReason).toContain('invalid stored arguments')
      expect(database.prepare('SELECT argv_json FROM session WHERE session_id = ?')
        .get('session-broken')).toEqual({ argv_json: '{not-json' })

      const repaired = database.transaction(() => updateSession(database, {
        sessionId: 'session-broken',
        expectedRevision: renamed.revision,
        argv: ['--fixed']
      }, now))()
      expect(repaired.argv).toEqual(['--fixed'])
      expect(repaired).not.toHaveProperty('launchDisabledReason')
    } finally {
      database.close()
    }
  })

  it('degrades one corrupt template argv record without hiding healthy stored records', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, now)
      insertSession(database, {
        sessionId: 'session-healthy',
        workspaceId: DEFAULT_WORKSPACE_ID,
        position: 0,
        cwd: '/workspace/healthy',
        argv: ['healthy-session']
      })
      const healthyTemplate = database.transaction(() => createTemplate(database, {
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
        .run('{not-json', 'template-broken')

      const templates = new Map(listTemplates(database)
        .map((template) => [template.templateId, template]))
      expect(templates.get('template-broken')).toMatchObject({
        argv: [],
        launchDisabledReason: expect.stringContaining('Recreate this launch template')
      })
      expect(templates.get('template-healthy')).toEqual(healthyTemplate)
      expect(listSessions(database, DEFAULT_WORKSPACE_ID)[0]).toMatchObject({
        sessionId: 'session-healthy',
        argv: ['healthy-session']
      })
      expect(listWorkspaces(database)).toHaveLength(1)
    } finally {
      database.close()
    }
  })
})
