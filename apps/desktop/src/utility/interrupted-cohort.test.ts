import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import {
  markCohortOffered,
  selectInterruptedIncarnations
} from './database-session-store'
import {
  newestInterruptionCohort,
  resumableStopCause,
  type InterruptedIncarnationRow
} from './interrupted-cohort'
import { DEFAULT_WORKSPACE_ID } from './store-schema'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection

function row(
  overrides: Partial<InterruptedIncarnationRow> & Pick<InterruptedIncarnationRow, 'sessionId' | 'interruptedAt'>
): InterruptedIncarnationRow {
  return {
    incarnationId: `incarnation-${overrides.sessionId}`,
    workspaceId: DEFAULT_WORKSPACE_ID,
    workspaceName: 'Personal',
    name: `Session ${overrides.sessionId}`,
    cwd: '/work',
    executable: '/usr/bin/codex',
    argv: [],
    detail: 'update restart · exit code 0',
    offeredAt: null,
    ...overrides
  }
}

describe('resumableStopCause', () => {
  it('recognises only the two stops the owner asked for', () => {
    expect(resumableStopCause('update restart · exit code 0')).toBe('update-restart')
    expect(resumableStopCause('application quit · signal 15')).toBe('application-quit')
    expect(resumableStopCause('last window close · exit code 0')).toBeNull()
    expect(resumableStopCause('BMN restarted before this process exited')).toBeNull()
    expect(resumableStopCause(null)).toBeNull()
    expect(resumableStopCause('')).toBeNull()
  })
})

describe('newestInterruptionCohort', () => {
  it('has nothing to offer when no interruption came from an update or a quit', () => {
    expect(newestInterruptionCohort([])).toBeNull()
    expect(newestInterruptionCohort([
      row({ sessionId: 'crashed', interruptedAt: '2026-09-21T10:00:00.000Z', detail: 'BMN restarted before this process exited' }),
      row({ sessionId: 'closed', interruptedAt: '2026-09-21T10:00:01.000Z', detail: 'last window close · exit code 0' })
    ])).toBeNull()
  })

  it('takes the newest stop and leaves an earlier one alone', () => {
    const selection = newestInterruptionCohort([
      row({ sessionId: 'older-a', interruptedAt: '2026-09-21T10:00:00.000Z' }),
      row({ sessionId: 'older-b', interruptedAt: '2026-09-21T10:00:02.000Z' }),
      row({ sessionId: 'newer-a', interruptedAt: '2026-09-21T10:10:00.000Z' }),
      row({ sessionId: 'newer-b', interruptedAt: '2026-09-21T10:10:03.000Z' })
    ])
    expect(selection?.cohortId).toBe('incarnation-newer-b')
    expect(selection?.stoppedAt).toBe('2026-09-21T10:10:03.000Z')
    expect(selection?.members.map((member) => member.sessionId)).toEqual(['newer-a', 'newer-b'])
  })

  it('keeps one stop to one wording, so a quit and an update never share a cohort', () => {
    const selection = newestInterruptionCohort([
      row({ sessionId: 'quit', interruptedAt: '2026-09-21T10:00:00.000Z', detail: 'application quit · exit code 0' }),
      row({ sessionId: 'update', interruptedAt: '2026-09-21T10:00:01.000Z', detail: 'update restart · exit code 0' })
    ])
    expect(selection?.cause).toBe('update-restart')
    expect(selection?.members.map((member) => member.sessionId)).toEqual(['update'])
  })

  /** A slow sequential stop is split rather than widened: the window is the rule, not a hint. */
  it('splits a stop whose recorded times straddle the 60 s window', () => {
    const selection = newestInterruptionCohort([
      row({ sessionId: 'slow', interruptedAt: '2026-09-21T10:00:00.000Z' }),
      row({ sessionId: 'inside', interruptedAt: '2026-09-21T10:01:00.000Z' }),
      row({ sessionId: 'last', interruptedAt: '2026-09-21T10:01:00.500Z' })
    ])
    expect(selection?.members.map((member) => member.sessionId)).toEqual(['inside', 'last'])
    expect(selection?.members.some((member) => member.sessionId === 'slow')).toBe(false)
  })

  it('reads the offer stamp from the incarnation that anchors the cohort', () => {
    const offered = newestInterruptionCohort([
      row({ sessionId: 'a', interruptedAt: '2026-09-21T10:00:00.000Z', offeredAt: '2026-09-21T10:05:00.000Z' })
    ])
    expect(offered?.offeredAt).toBe('2026-09-21T10:05:00.000Z')
  })

  it('ignores a record whose interruption time cannot be read', () => {
    expect(newestInterruptionCohort([row({ sessionId: 'broken', interruptedAt: 'not a time' })])).toBeNull()
  })

  it('breaks a tie by incarnation id, so the cohort identity is stable', () => {
    const rows = [
      row({ sessionId: 'a', incarnationId: 'incarnation-a', interruptedAt: '2026-09-21T10:00:00.000Z' }),
      row({ sessionId: 'b', incarnationId: 'incarnation-b', interruptedAt: '2026-09-21T10:00:00.000Z' })
    ]
    expect(newestInterruptionCohort(rows)?.cohortId).toBe('incarnation-b')
    expect(newestInterruptionCohort([...rows].reverse())?.cohortId).toBe('incarnation-b')
  })
})

describe('selectInterruptedIncarnations', () => {
  function seed(database: DatabaseConnection): void {
    initializeDatabase(database, '2026-09-21T09:00:00.000Z')
    database.prepare(
      `INSERT INTO workspace(workspace_id, name, default_cwd, archived_at, revision, position, marker)
       VALUES ('workspace-2', 'Second', NULL, NULL, 1, 1, 'none')`
    ).run()
  }

  function insertSession(
    database: DatabaseConnection,
    input: { sessionId: string; workspaceId?: string; archivedAt?: string | null; position?: number }
  ): void {
    database.prepare(
      `INSERT INTO session(
        session_id, workspace_id, name, cwd, executable, argv_json,
        revision, created_at, position, background_choice, archived_at
      ) VALUES (?, ?, ?, '/work', '/usr/bin/codex', '["--sandbox"]', 1, ?, ?, NULL, ?)`
    ).run(
      input.sessionId,
      input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      `Session ${input.sessionId}`,
      '2026-09-21T09:00:00.000Z',
      input.position ?? 0,
      input.archivedAt ?? null
    )
  }

  function insertIncarnation(
    database: DatabaseConnection,
    input: {
      incarnationId: string
      sessionId: string
      state: string
      startedAt: string
      exitedAt?: string | null
      detail?: string | null
    }
  ): void {
    database.prepare(
      `INSERT INTO process_incarnation(
        incarnation_id, session_id, process_start_identity, state, started_at, exited_at,
        exit_code, exit_signal, exit_detail
      ) VALUES (?, ?, 'linux-proc-start:1', ?, ?, ?, NULL, NULL, ?)`
    ).run(
      input.incarnationId,
      input.sessionId,
      input.state,
      input.startedAt,
      input.exitedAt ?? null,
      input.detail ?? null
    )
  }

  it('lists only unarchived sessions whose latest incarnation is interrupted', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      seed(database)
      insertSession(database, { sessionId: 'stopped-by-update', position: 0 })
      insertSession(database, { sessionId: 'archived', archivedAt: '2026-09-21T09:30:00.000Z', position: 1 })
      insertSession(database, { sessionId: 'resumed-by-hand', position: 2 })
      insertSession(database, { sessionId: 'exited-cleanly', position: 3 })
      insertSession(database, { sessionId: 'other-workspace', workspaceId: 'workspace-2' })
      insertIncarnation(database, {
        incarnationId: 'i-update', sessionId: 'stopped-by-update', state: 'interrupted',
        startedAt: '2026-09-21T09:00:00.000Z', exitedAt: '2026-09-21T10:00:00.000Z',
        detail: 'update restart · exit code 0'
      })
      insertIncarnation(database, {
        incarnationId: 'i-archived', sessionId: 'archived', state: 'interrupted',
        startedAt: '2026-09-21T09:00:00.000Z', exitedAt: '2026-09-21T10:00:00.000Z',
        detail: 'update restart · exit code 0'
      })
      // The hand-resumed session's newest incarnation is running, so its interrupted one is history.
      insertIncarnation(database, {
        incarnationId: 'i-old', sessionId: 'resumed-by-hand', state: 'interrupted',
        startedAt: '2026-09-21T09:00:00.000Z', exitedAt: '2026-09-21T10:00:00.000Z',
        detail: 'update restart · exit code 0'
      })
      insertIncarnation(database, {
        incarnationId: 'i-live', sessionId: 'resumed-by-hand', state: 'running',
        startedAt: '2026-09-21T10:30:00.000Z'
      })
      insertIncarnation(database, {
        incarnationId: 'i-exited', sessionId: 'exited-cleanly', state: 'exited',
        startedAt: '2026-09-21T09:00:00.000Z', exitedAt: '2026-09-21T10:00:00.000Z'
      })
      insertIncarnation(database, {
        incarnationId: 'i-second', sessionId: 'other-workspace', state: 'interrupted',
        startedAt: '2026-09-21T09:00:00.000Z', exitedAt: '2026-09-21T10:00:01.000Z',
        detail: 'update restart · exit code 0'
      })

      const rows = selectInterruptedIncarnations(database)
      expect(rows.map((item) => item.sessionId)).toEqual(['stopped-by-update', 'other-workspace'])
      expect(rows[0]).toMatchObject({
        incarnationId: 'i-update',
        workspaceName: 'Personal',
        name: 'Session stopped-by-update',
        cwd: '/work',
        executable: '/usr/bin/codex',
        argv: ['--sandbox'],
        detail: 'update restart · exit code 0',
        interruptedAt: '2026-09-21T10:00:00.000Z',
        offeredAt: null
      })
      expect(rows[1]?.workspaceName).toBe('Second')
    } finally {
      database.close()
    }
  })

  it('stamps every incarnation in the cohort once and never restamps it', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      seed(database)
      insertSession(database, { sessionId: 'a', position: 0 })
      insertSession(database, { sessionId: 'b', position: 1 })
      insertIncarnation(database, {
        incarnationId: 'i-a', sessionId: 'a', state: 'interrupted',
        startedAt: '2026-09-21T09:00:00.000Z', exitedAt: '2026-09-21T10:00:00.000Z',
        detail: 'application quit · exit code 0'
      })
      insertIncarnation(database, {
        incarnationId: 'i-b', sessionId: 'b', state: 'interrupted',
        startedAt: '2026-09-21T09:00:00.000Z', exitedAt: '2026-09-21T10:00:02.000Z',
        detail: 'application quit · exit code 0'
      })

      const cohort = newestInterruptionCohort(selectInterruptedIncarnations(database))!
      expect(cohort.offeredAt).toBeNull()
      markCohortOffered(database, cohort.members.map((member) => member.incarnationId), '2026-09-21T10:05:00.000Z')
      markCohortOffered(database, cohort.members.map((member) => member.incarnationId), '2026-09-21T11:00:00.000Z')

      const stamped = selectInterruptedIncarnations(database)
      expect(stamped.map((item) => item.offeredAt))
        .toEqual(['2026-09-21T10:05:00.000Z', '2026-09-21T10:05:00.000Z'])
      expect(newestInterruptionCohort(stamped)?.offeredAt).toBe('2026-09-21T10:05:00.000Z')
    } finally {
      database.close()
    }
  })
})
