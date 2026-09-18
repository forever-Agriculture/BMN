import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { PersistedConversationBinding } from '@bmn/protocol'
import {
  initializeDatabase,
  type DatabaseConnection
} from './database-initialization'
import {
  clearConversationBinding,
  insertConversationBinding,
  replaceConversationBinding,
  selectConversationBinding
} from './database-binding-store'
import { captureRelevantLaunchEnvironment } from './conversation-binding'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection

function insertSession(database: DatabaseConnection, sessionId: string): void {
  database
    .prepare(
      `INSERT INTO session(
        session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at
      ) VALUES (?, '00000000-0000-4000-8000-000000000001', 'Claude',
                '/workspace', '/usr/bin/claude', '[]', 1, '2026-09-12T12:00:00.000Z')`
    )
    .run(sessionId)
}

function insertRawBinding(
  database: DatabaseConnection,
  values: readonly (string | null)[]
): void {
  database
    .prepare(
      `INSERT INTO conversation_binding(
        session_id, agent_cli, status, conversation_reference, capture_route,
        launch_cwd, launch_executable, launch_argv_json, launch_environment_json,
        detail, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(...values)
}

describe('conversation binding SQL persistence', () => {
  it('round-trips all columns and enforces FK, CHECK, and primary-key constraints', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, '2026-09-12T12:00:00.000Z')
      insertSession(database, 'bound-session')
      insertSession(database, 'invalid-write-session')
      insertSession(database, 'constraint-session')
      insertSession(database, 'uppercase-reference-session')
      insertSession(database, 'executable-mismatch-session')
      insertSession(database, 'environment-tamper-session')
      const binding: PersistedConversationBinding = {
        sessionId: 'bound-session',
        agentCli: 'claude',
        status: 'bound',
        conversationReference: '11111111-1111-4111-8111-111111111111',
        captureRoute: 'claude-session-id',
        launchContext: {
          cwd: '/workspace',
          executable: '/usr/bin/claude',
          argv: ['--model', 'sonnet'],
          environment: captureRelevantLaunchEnvironment({ CLAUDE_CONFIG_DIR: '/config/claude' })
        },
        detail: 'pinned before spawn',
        capturedAt: '2026-09-12T12:00:00.000Z'
      }

      insertConversationBinding(database, binding)
      expect(selectConversationBinding(database, binding.sessionId)).toEqual(binding)
      expect(() => insertConversationBinding(database, binding)).toThrow(/UNIQUE|PRIMARY KEY/i)
      expect(() => insertConversationBinding(database, {
        ...binding,
        sessionId: 'invalid-write-session',
        launchContext: {
          ...binding.launchContext,
          environment: { TERM: 'xterm-256color' }
        }
      })).toThrow(/exactly the relevant keys/)

      const validTail = [
        '/workspace',
        '/usr/bin/claude',
        '[]',
        '{}',
        'constraint probe',
        '2026-09-12T12:00:00.000Z'
      ] as const
      expect(() => insertRawBinding(database, [
        'missing-session',
        'claude',
        'bound',
        binding.conversationReference,
        'claude-session-id',
        ...validTail
      ])).toThrow(/FOREIGN KEY/i)
      expect(() => insertRawBinding(database, [
        'constraint-session',
        'claude',
        'bound',
        null,
        'claude-session-id',
        ...validTail
      ])).toThrow(/CHECK/i)

      insertRawBinding(database, [
        'uppercase-reference-session',
        'claude',
        'bound',
        'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        'claude-session-id',
        ...validTail
      ])
      expect(selectConversationBinding(database, 'uppercase-reference-session')).toMatchObject({
        status: 'unsupported',
        detail: expect.stringContaining('Stored conversation binding is unsupported')
      })

      insertRawBinding(database, [
        'executable-mismatch-session',
        'claude',
        'bound',
        binding.conversationReference,
        'claude-session-id',
        '/workspace',
        '/bin/sh',
        '[]',
        '{}',
        'tampered executable',
        '2026-09-12T12:00:00.000Z'
      ])
      expect(selectConversationBinding(database, 'executable-mismatch-session')).toMatchObject({
        status: 'unsupported',
        detail: expect.stringContaining('executable identity')
      })

      insertRawBinding(database, [
        'environment-tamper-session',
        'claude',
        'bound',
        binding.conversationReference,
        'claude-session-id',
        '/workspace',
        '/usr/bin/claude',
        '[]',
        '{"LD_PRELOAD":"/tmp/injected.so"}',
        'tampered environment',
        '2026-09-12T12:00:00.000Z'
      ])
      expect(selectConversationBinding(database, 'environment-tamper-session')).toMatchObject({
        status: 'unsupported',
        detail: expect.stringContaining('exactly the relevant keys')
      })
      expect(() => insertRawBinding(database, [
        'constraint-session',
        'claude',
        'unsupported',
        binding.conversationReference,
        'unsupported',
        ...validTail
      ])).toThrow(/CHECK/i)
    } finally {
      database.close()
    }
  })

  it('replaces and clears only the addressed session binding row', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, '2026-09-13T12:00:00.000Z')
      insertSession(database, 'session-a')
      insertSession(database, 'session-b')
      const base = {
        agentCli: 'codex' as const,
        status: 'bound' as const,
        captureRoute: 'explicit-resume-reference' as const,
        launchContext: {
          cwd: '/workspace',
          executable: '/usr/bin/codex',
          argv: [],
          environment: captureRelevantLaunchEnvironment({})
        },
        detail: 'explicit owner selection',
        capturedAt: '2026-09-13T12:00:00.000Z'
      }
      insertConversationBinding(database, {
        ...base,
        sessionId: 'session-a',
        conversationReference: '11111111-1111-4111-8111-111111111111'
      })
      insertConversationBinding(database, {
        ...base,
        sessionId: 'session-b',
        conversationReference: '22222222-2222-4222-8222-222222222222'
      })
      const selectRawB = (): unknown => database.prepare(
        'SELECT * FROM conversation_binding WHERE session_id = ?'
      ).get('session-b')
      const sessionBBefore = JSON.stringify(selectRawB())

      expect(replaceConversationBinding(database, {
        ...base,
        sessionId: 'session-a',
        conversationReference: '33333333-3333-4333-8333-333333333333',
        capturedAt: '2026-09-13T12:01:00.000Z'
      })).toMatchObject({
        sessionId: 'session-a',
        conversationReference: '33333333-3333-4333-8333-333333333333',
        captureRoute: 'explicit-resume-reference'
      })
      expect(JSON.stringify(selectRawB())).toBe(sessionBBefore)
      expect(clearConversationBinding(database, 'session-a')).toBe(true)
      expect(selectConversationBinding(database, 'session-a')).toBeUndefined()
      expect(JSON.stringify(selectRawB())).toBe(sessionBBefore)
    } finally {
      database.close()
    }
  })
})
