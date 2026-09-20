// MODULE: companion-service.test.ts - backup export/verify completeness and artifact reconciliation against the real store
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ERROR_CODES,
  METHOD_REGISTRY,
  type AppEventMessage,
  type ArtifactRecord,
  type BackupManifest,
  type BackupVerifyResult,
  type SessionRecord
} from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanionService } from './companion-service'
import type { DatabaseWorkerClient } from './database-client'
import { COMPANION_OPERATIONS, insertArtifact, listReadyArtifacts, type CompanionOperationName } from './database-companion-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { selectConversationRoutes } from './database-binding-store'
import { listSessions, listWorkspaces } from './database-workspace-store'
import type { SessionManager } from './session-manager'
import type { TelegramConnector } from './telegram-connector'
import { DEFAULT_WORKSPACE_ID } from './store-schema'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => DatabaseConnection
const now = '2026-09-14T12:00:00.000Z'
let root: string
let database: DatabaseConnection
let service: CompanionService
let writes: Array<{ sessionId: string; bytes: Uint8Array }>
let liveIncarnations: Map<string, string>
let emitted: AppEventMessage[]

/** Runs the real store operations the worker would, on an in-memory database. */
function workerLike(connection: DatabaseConnection): DatabaseWorkerClient {
  return {
    companion: async (name: CompanionOperationName, ...args: unknown[]) => {
      const operation = COMPANION_OPERATIONS[name] as (connection: DatabaseConnection, ...args: unknown[]) => unknown
      return connection.transaction(() => operation(connection, ...args))()
    },
    backupInto: async (path: string) => {
      connection.prepare('VACUUM INTO ?').run(path)
    },
    readyArtifactsInBackup: async (path: string) => {
      const snapshot = new BetterSqlite3(path, { readonly: true, fileMustExist: true })
      try {
        return listReadyArtifacts(snapshot)
      } finally {
        snapshot.close()
      }
    },
    listWorkspaces: async (includeArchived = false) => listWorkspaces(connection, includeArchived),
    listSessions: async (workspaceId: string) => listSessions(connection, workspaceId),
    listConversationRoutes: async () => selectConversationRoutes(connection)
  } as unknown as DatabaseWorkerClient
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-companion-'))
  database = new BetterSqlite3(':memory:')
  initializeDatabase(database, now)
  database.prepare(
    `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
     VALUES ('s1', ?, 'One', '/work', '/bin/bash', '[]', 1, ?, 0)`
  ).run(DEFAULT_WORKSPACE_ID, now)
  database.prepare(
    `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
     VALUES ('s2', ?, 'Two', '/work/two', '/usr/bin/codex', '[]', 1, ?, 1)`
  ).run(DEFAULT_WORKSPACE_ID, now)
  writes = []
  emitted = []
  liveIncarnations = new Map([['s1', 'incarnation-1'], ['s2', 'incarnation-2']])
  const manager = {
    liveIncarnationId: (sessionId: string) => liveIncarnations.get(sessionId),
    writeToSession: (sessionId: string, bytes: Uint8Array) => writes.push({ sessionId, bytes }),
    sessionWithCurrentProcessState: (session: SessionRecord) => session
  } as unknown as SessionManager
  service = new CompanionService({
    database: workerLike(database),
    manager,
    roots: { config: join(root, 'config'), data: join(root, 'data'), state: join(root, 'state'), runtime: join(root, 'runtime') },
    cliPath: join(root, 'bin', 'bmn'),
    emit: (message) => emitted.push(message),
    now: () => new Date(now)
  })
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

/** Stores `count` ready originals on disk, one second apart, oldest first. */
async function storeArtifacts(count: number): Promise<ArtifactRecord[]> {
  const originals = join(root, 'data', 'artifacts', 'originals')
  await mkdir(originals, { recursive: true })
  const records: ArtifactRecord[] = []
  for (let index = 0; index < count; index += 1) {
    const artifactId = `artifact-${String(index).padStart(5, '0')}`
    const bytes = Buffer.from(`original ${index}`)
    const storedPath = join(originals, artifactId)
    await writeFile(storedPath, bytes)
    records.push(insertArtifact(database, {
      artifactId,
      sessionId: 's1',
      incarnationId: null,
      direction: 'input',
      source: 'owner',
      originalName: `${artifactId}.txt`,
      mediaType: 'text/plain',
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      storedPath,
      sourcePath: null,
      state: 'ready',
      createdAt: new Date(Date.parse(now) + index * 1000).toISOString()
    }))
  }
  return records
}

const exportBackup = (parent: string) =>
  service.route('backup.export', { directory: parent }) as Promise<{ directory: string; manifest: BackupManifest }>
const verifyBackup = (directory: string) =>
  service.route('backup.verify', { directory }) as Promise<BackupVerifyResult>

describe('session environment', () => {
  it('publishes BMN credentials and matching legacy aliases for existing hooks', () => {
    const environment = service.sessionEnvironment({ sessionId: 's1', incarnationId: 'run-1' })
    expect(environment.BMN_CONTROL_SOCKET).toBe(environment.AITERM_CONTROL_SOCKET)
    expect(environment.BMN_TOKEN).toBe(environment.AITERM_TOKEN)
    expect(environment.BMN_SESSION_ID).toBe(environment.AITERM_SESSION_ID)
  })
})

describe('handoff drafts', () => {
  const save = (params: Record<string, unknown>) =>
    service.route(METHOD_REGISTRY.draftSave, params) as Promise<import('@bmn/protocol').InputDraftRecord>

  it('saves and edits an addressed handoff without terminal input', async () => {
    const [artifact] = await storeArtifacts(1)
    const created = await save({
      sourceSessionId: 's1', sessionId: 's2', text: 'Please review this.', artifactIds: [artifact!.artifactId]
    })
    const edited = await save({
      draftId: created.draftId,
      sourceSessionId: 's1',
      sessionId: 's2',
      text: 'Please review this carefully.',
      artifactIds: [artifact!.artifactId],
      expectedUpdatedAt: created.updatedAt
    })

    expect(writes).toEqual([])
    expect(edited).toMatchObject({
      origin: 'handoff', sourceSessionId: 's1', sessionId: 's2',
      text: 'Please review this carefully.', artifactIds: [artifact!.artifactId], state: 'draft'
    })
    expect(Date.parse(edited.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt))
    await expect(save({
      draftId: created.draftId,
      sourceSessionId: 's1', sessionId: 's2', text: 'Stale edit', artifactIds: [],
      expectedUpdatedAt: created.updatedAt
    })).rejects.toMatchObject({ code: ERROR_CODES.revisionConflict })
  })

  it('pastes one bounded package without Enter and returns the stored result to duplicates', async () => {
    const [artifact] = await storeArtifacts(1)
    const draft = await save({
      sourceSessionId: 's1', sessionId: 's2', text: 'Result line one\nQuestion line two',
      artifactIds: [artifact!.artifactId]
    })
    const request = {
      draftId: draft.draftId,
      submit: false,
      expectedIncarnationId: 'incarnation-2',
      expectedUpdatedAt: draft.updatedAt
    }
    const [first, duplicate] = await Promise.all([
      service.route(METHOD_REGISTRY.draftSend, request),
      service.route(METHOD_REGISTRY.draftSend, request)
    ]) as import('@bmn/protocol').InputDraftRecord[]

    expect(writes).toHaveLength(1)
    expect(writes[0]?.sessionId).toBe('s2')
    const payload = new TextDecoder().decode(writes[0]!.bytes)
    expect(payload).toContain('[BMN handoff from One · /bin/bash · /work]')
    expect(payload).toContain('Result line one\nQuestion line two')
    expect(payload).toContain(`${artifact!.originalName}: `)
    expect(payload.endsWith('\r')).toBe(false)
    expect(first).toMatchObject({ state: 'accepted', detail: 'Pasted to terminal — not submitted' })
    expect(duplicate).toMatchObject({ state: 'accepted', detail: 'Pasted to terminal — not submitted' })
  })

  it('rejects stale targets and missing or oversized originals before input', async () => {
    const records = await storeArtifacts(10)
    const stale = await save({
      sourceSessionId: 's1', sessionId: 's2', text: 'Stale target', artifactIds: []
    })
    liveIncarnations.set('s2', 'incarnation-replaced')
    await expect(service.route(METHOD_REGISTRY.draftSend, {
      draftId: stale.draftId,
      submit: false,
      expectedIncarnationId: 'incarnation-2',
      expectedUpdatedAt: stale.updatedAt
    })).rejects.toMatchObject({ code: ERROR_CODES.revisionConflict })
    expect((await service.route(METHOD_REGISTRY.draftList, {}) as import('@bmn/protocol').InputDraftRecord[])
      .find((item) => item.draftId === stale.draftId)?.state).toBe('draft')

    liveIncarnations.set('s2', 'incarnation-2')
    const missing = await save({
      sourceSessionId: 's1', sessionId: 's2', text: 'Missing original', artifactIds: [records[0]!.artifactId]
    })
    await rm(records[0]!.storedPath)
    await expect(service.route(METHOD_REGISTRY.draftSend, {
      draftId: missing.draftId,
      submit: false,
      expectedIncarnationId: 'incarnation-2',
      expectedUpdatedAt: missing.updatedAt
    })).rejects.toThrow(/missing/i)

    for (const record of records.slice(1)) {
      database.prepare('UPDATE artifact SET original_name = ? WHERE artifact_id = ?')
        .run(`${record.artifactId}-${'x'.repeat(6_000)}.txt`, record.artifactId)
    }
    const oversized = await save({
      sourceSessionId: 's1', sessionId: 's2', text: 'x'.repeat(16 * 1024),
      artifactIds: records.slice(1).map((record) => record.artifactId)
    })
    await expect(service.route(METHOD_REGISTRY.draftSend, {
      draftId: oversized.draftId,
      submit: false,
      expectedIncarnationId: 'incarnation-2',
      expectedUpdatedAt: oversized.updatedAt
    })).rejects.toThrow(/64 KiB/)
    expect(writes).toEqual([])
  })

  it('keeps legacy draft send semantics', async () => {
    const legacy = COMPANION_OPERATIONS.createDraft(database, {
      draftId: 'legacy-draft', sessionId: 's1', origin: 'telegram', originKey: 'telegram:1',
      requestId: null, text: 'legacy reply', artifactId: null, state: 'draft', detail: null
    }, now).record
    const sent = await service.route(METHOD_REGISTRY.draftSend, { draftId: legacy.draftId, submit: true }) as
      import('@bmn/protocol').InputDraftRecord
    expect(sent.state).toBe('submitted')
    expect(new TextDecoder().decode(writes[0]!.bytes)).toContain('legacy reply')
    expect(new TextDecoder().decode(writes[0]!.bytes).endsWith('\r')).toBe(true)
  })

  it('restores definite pre-write failures and leaves a possible write uncertain', async () => {
    const beforeWrite = await save({
      sourceSessionId: 's1', sessionId: 's2', text: 'Recheck target', artifactIds: []
    })
    let incarnationReads = 0
    const manager = service['options'].manager
    manager.liveIncarnationId = () => (++incarnationReads === 1 ? 'incarnation-2' : 'incarnation-new')
    emitted = []
    await expect(service.route(METHOD_REGISTRY.draftSend, {
      draftId: beforeWrite.draftId,
      submit: false,
      expectedIncarnationId: 'incarnation-2',
      expectedUpdatedAt: beforeWrite.updatedAt
    })).rejects.toMatchObject({ code: ERROR_CODES.revisionConflict })
    expect((await service.route(METHOD_REGISTRY.draftList, {}) as import('@bmn/protocol').InputDraftRecord[])
      .find((item) => item.draftId === beforeWrite.draftId)).toMatchObject({
      state: 'draft', detail: 'Destination process changed before paste'
    })
    expect(emitted).toEqual([
      { kind: 'app-event', topic: 'drafts', sessionId: 's2' },
      { kind: 'app-event', topic: 'drafts', sessionId: 's2' }
    ])

    manager.liveIncarnationId = () => 'incarnation-2'
    manager.writeToSession = () => { throw new Error('PTY write outcome unavailable') }
    const ambiguous = await save({
      sourceSessionId: 's1', sessionId: 's2', text: 'Possible write', artifactIds: []
    })
    emitted = []
    await expect(service.route(METHOD_REGISTRY.draftSend, {
      draftId: ambiguous.draftId,
      submit: false,
      expectedIncarnationId: 'incarnation-2',
      expectedUpdatedAt: ambiguous.updatedAt
    })).rejects.toThrow('PTY write outcome unavailable')
    expect((await service.route(METHOD_REGISTRY.draftList, {}) as import('@bmn/protocol').InputDraftRecord[])
      .find((item) => item.draftId === ambiguous.draftId)).toMatchObject({
      state: 'uncertain', detail: 'Pasting…', attemptedIncarnationId: 'incarnation-2'
    })
    expect(emitted).toEqual([{ kind: 'app-event', topic: 'drafts', sessionId: 's2' }])
  })
})

describe('backup', () => {
  it('exports every ready artifact, not only the newest 1,000', async () => {
    const records = await storeArtifacts(1001)
    const { manifest, directory } = await exportBackup(join(root, 'backups'))
    expect(manifest.artifacts.map((entry) => entry.artifactId).sort()).toEqual(records.map((record) => record.artifactId))
    expect(await verifyBackup(directory)).toMatchObject({ ok: true, checked: 1002, failures: [] })
  }, 30_000)

  it('fails verification when a ready artifact in the backup database has no manifest entry', async () => {
    const [kept, dropped] = await storeArtifacts(2)
    const { directory } = await exportBackup(join(root, 'backups'))
    const manifestPath = join(directory, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
    writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      artifacts: manifest.artifacts.filter((entry) => entry.artifactId !== dropped!.artifactId)
    }))
    const result = await verifyBackup(directory)
    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([{ file: `artifacts/${dropped!.sha256.slice(0, 2)}/${dropped!.artifactId}`, reason: 'not-in-manifest' }])
    expect(result.failures.some((failure) => failure.file.endsWith(kept!.artifactId))).toBe(false)
  })

  it('fails verification when a manifest artifact points at another recorded artifact file', async () => {
    await storeArtifacts(2)
    const { directory } = await exportBackup(join(root, 'backups'))
    const manifestPath = join(directory, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
    const [first, second] = manifest.artifacts
    if (!first || !second) throw new Error('expected two backup artifacts')
    await rm(join(directory, second.file))
    writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      artifacts: [first, { ...first, artifactId: second.artifactId }]
    }))

    const result = await verifyBackup(directory)

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual({ file: first.file, reason: 'database-mismatch' })
  })

  it('reports a backup database that cannot be read instead of failing the check', async () => {
    await storeArtifacts(1)
    const { directory } = await exportBackup(join(root, 'backups'))
    const manifestPath = join(directory, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
    const garbage = Buffer.from('not a database')
    writeFileSync(join(directory, manifest.database.file), garbage)
    writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      database: { ...manifest.database, sha256: createHash('sha256').update(garbage).digest('hex'), byteLength: garbage.byteLength }
    }))
    expect(await verifyBackup(directory)).toMatchObject({
      ok: false,
      failures: [{ file: manifest.database.file, reason: 'unreadable-database' }]
    })
  })

  it('leaves out artifacts that are not ready', async () => {
    const [ready, missing] = await storeArtifacts(2)
    await rm(missing!.storedPath)
    database.prepare("UPDATE artifact SET state = 'missing' WHERE artifact_id = ?").run(missing!.artifactId)
    const { manifest, directory } = await exportBackup(join(root, 'backups'))
    expect(manifest.artifacts.map((entry) => entry.artifactId)).toEqual([ready!.artifactId])
    expect((await verifyBackup(directory)).ok).toBe(true)
  })
})

describe('artifact reconciliation', () => {
  it('marks a vanished original as missing even when more than 1,000 artifacts are newer', async () => {
    const [oldest] = await storeArtifacts(1001)
    await rm(oldest!.storedPath)
    await service['reconcileArtifacts']()
    const row = database.prepare('SELECT state FROM artifact WHERE artifact_id = ?').get(oldest!.artifactId) as { state: string }
    expect(row.state).toBe('missing')
  }, 30_000)
})

describe('Telegram attention notifications', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('binds each notification to the process incarnation live when it was sent', async () => {
    service['telegram'] = {
      sendMessage: async () => ({ messageId: 77 })
    } as unknown as TelegramConnector
    service['telegramHealth'] = {
      state: 'polling', detail: '', lastPollAt: null, lastError: null, rejectedUpdates: 0
    }

    await service['telegramNotify']('s1', 'request-1', 'Session needs you')

    expect(COMPANION_OPERATIONS.getTelegramMessage(database, 77)).toEqual({
      sessionId: 's1',
      requestId: 'request-1',
      incarnationId: 'incarnation-1'
    })
  })

  it('sends a repeated prompt once after it waited unseen, and nothing for a prompt seen at the desk', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    service['telegram'] = {
      sendMessage: async (message: string) => {
        sent.push(message)
        return { messageId: sent.length }
      }
    } as unknown as TelegramConnector
    service['telegramHealth'] = { state: 'polling', detail: '', lastPollAt: null, lastError: null, rejectedUpdates: 0 }
    const prompt = { sessionId: 's1', incarnationId: null, kind: 'permission' as const, title: 'Claude wants to use Bash' }

    await service['openAttention']({ ...prompt, requestKey: 'claude:permission' })
    await service['openAttention']({ ...prompt, requestKey: 'claude:permission' })
    const seen = await service['openAttention']({ ...prompt, requestKey: 'claude:question' })
    await service.route(METHOD_REGISTRY.attentionSeen, { requestId: seen.requestId })
    await vi.advanceTimersByTimeAsync(14_000)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    await service['openAttention']({ ...prompt, requestKey: 'claude:permission' })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(sent).toEqual(['● Session needs you (permission)\nClaude wants to use Bash\n\nReply to this message to answer.'])
  })

  it('pages only once the owner is away, never for a prompt their phone already got, and reports exits only away', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    service['telegram'] = {
      sendMessage: async (message: string) => {
        sent.push(message)
        return { messageId: sent.length }
      }
    } as unknown as TelegramConnector
    service['telegramHealth'] = { state: 'polling', detail: '', lastPollAt: null, lastError: null, rejectedUpdates: 0 }
    service['sessionsChanged'] = async () => undefined
    await database.transaction(() => COMPANION_OPERATIONS.putSettingsSection(database, 'telegram', {
      enabled: true, allowedChatId: 1, allowedUserId: null, notifyOn: 'attention-and-exit', autoSubmitReplies: false
    }, now))()
    const prompt = { sessionId: 's1', incarnationId: null, kind: 'permission' as const, title: 'Claude wants to use Bash' }

    await service.route(METHOD_REGISTRY.presenceSet, { away: false })
    await service['openAttention']({ ...prompt, requestKey: 'claude:permission' })
    await service['openAttention']({ ...prompt, requestKey: 'claude:question', phoneNotified: true })
    service.sessionStateChanged('s1', 'exited')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sent).toEqual([])

    await service.route(METHOD_REGISTRY.presenceSet, { away: true })
    await vi.advanceTimersByTimeAsync(0)
    await service.route(METHOD_REGISTRY.presenceSet, { away: true })
    service.sessionStateChanged('s1', 'exited')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(sent).toEqual([
      '● Session needs you (permission)\nClaude wants to use Bash\n\nReply to this message to answer.',
      '■ A session exited'
    ])
    await expect(service.route(METHOD_REGISTRY.presenceSet, { away: 'yes' })).rejects.toThrow('away must be')
  })

  it.each([
    ['the request was already resolved', async (requestId: string) => {
      COMPANION_OPERATIONS.closeAttention(database, { requestId }, 'answered', 'handled at the desk', now)
    }],
    ['the notified process was replaced', async () => {
      liveIncarnations.set('s1', 'replacement-incarnation')
    }]
  ])('keeps an automatic reply as a draft when %s', async (_case, makeStale) => {
    const sent: string[] = []
    service['telegram'] = {
      sendMessage: async (message: string) => {
        sent.push(message)
        return { messageId: sent.length }
      }
    } as unknown as TelegramConnector
    await service.sessionsChanged()
    COMPANION_OPERATIONS.putSettingsSection(database, 'telegram', {
      enabled: true, allowedChatId: 1, allowedUserId: null,
      notifyOn: 'attention-and-exit', autoSubmitReplies: true
    }, now)
    const request = COMPANION_OPERATIONS.openAttention(database, {
      sessionId: 's1', incarnationId: 'incarnation-1', requestKey: 'telegram-stale',
      kind: 'permission', title: 'Old permission'
    }, 'telegram-stale-request', now)
    COMPANION_OPERATIONS.putTelegramMessage(
      database, 77, 's1', request.requestId, 'incarnation-1', now
    )
    await makeStale(request.requestId)

    await service['handleTelegramReply']({
      updateId: 88,
      chatId: 1,
      fromUserId: 1,
      messageId: 99,
      replyToMessageId: 77,
      text: 'yes',
      file: null
    })

    expect(writes).toEqual([])
    expect(sent).toEqual(['Saved as a draft in BMN for that session.'])
    expect(COMPANION_OPERATIONS.listDrafts(database)).toContainEqual(
      expect.objectContaining({ origin: 'telegram', state: 'draft', text: 'yes' })
    )
  })

  it('submits a reply only while its exact notified process and request are current', async () => {
    const sent: string[] = []
    service['telegram'] = {
      sendMessage: async (message: string) => {
        sent.push(message)
        return { messageId: sent.length }
      }
    } as unknown as TelegramConnector
    await service.sessionsChanged()
    COMPANION_OPERATIONS.putSettingsSection(database, 'telegram', {
      enabled: true, allowedChatId: 1, allowedUserId: null,
      notifyOn: 'attention-and-exit', autoSubmitReplies: true
    }, now)
    const request = COMPANION_OPERATIONS.openAttention(database, {
      sessionId: 's1', incarnationId: 'incarnation-1', requestKey: 'telegram-current',
      kind: 'question', title: 'Current question'
    }, 'telegram-current-request', now)
    COMPANION_OPERATIONS.putTelegramMessage(
      database, 77, 's1', request.requestId, 'incarnation-1', now
    )

    await service['handleTelegramReply']({
      updateId: 88,
      chatId: 1,
      fromUserId: 1,
      messageId: 99,
      replyToMessageId: 77,
      text: 'current answer',
      file: null
    })

    expect(writes).toHaveLength(1)
    expect(new TextDecoder().decode(writes[0]!.bytes)).toBe(
      '\x1b[200~current answer\x1b[201~\r'
    )
    expect(sent).toEqual(['Sent to the session.'])
    expect(COMPANION_OPERATIONS.getAttention(database, request.requestId)).toMatchObject({
      state: 'answered', resolution: 'current answer'
    })
  })

  it('keeps the reply as a draft when the process changes immediately before the write', async () => {
    const sent: string[] = []
    service['telegram'] = {
      sendMessage: async (message: string) => {
        sent.push(message)
        return { messageId: sent.length }
      }
    } as unknown as TelegramConnector
    await service.sessionsChanged()
    COMPANION_OPERATIONS.putSettingsSection(database, 'telegram', {
      enabled: true, allowedChatId: 1, allowedUserId: null,
      notifyOn: 'attention-and-exit', autoSubmitReplies: true
    }, now)
    const request = COMPANION_OPERATIONS.openAttention(database, {
      sessionId: 's1', incarnationId: 'incarnation-1', requestKey: 'telegram-race',
      kind: 'question', title: 'Racing question'
    }, 'telegram-race-request', now)
    COMPANION_OPERATIONS.putTelegramMessage(
      database, 77, 's1', request.requestId, 'incarnation-1', now
    )
    let incarnationReads = 0
    service['options'].manager.liveIncarnationId = () =>
      ++incarnationReads === 1 ? 'incarnation-1' : 'replacement-incarnation'

    await service['handleTelegramReply']({
      updateId: 88,
      chatId: 1,
      fromUserId: 1,
      messageId: 99,
      replyToMessageId: 77,
      text: 'racing answer',
      file: null
    })

    expect(writes).toEqual([])
    expect(sent).toEqual(['Saved as a draft in BMN for that session.'])
    expect(COMPANION_OPERATIONS.listDrafts(database)).toContainEqual(
      expect.objectContaining({ origin: 'telegram', state: 'draft', text: 'racing answer' })
    )
  })
})

describe('conversation route in list and snapshot', () => {
  /** The control handlers are private; the projection is the surface both of them are built from. */
  function listed(scope: { kind: 'owner' } | { kind: 'session'; sessionId: string }): Promise<
    Array<{ sessionId: string; conversation: { status: string; captureRoute: string } | null }>
  > {
    const reach = service as unknown as {
      listedSessions(scope: unknown): Promise<
        Array<{ sessionId: string; conversation: { status: string; captureRoute: string } | null }>
      >
    }
    return reach.listedSessions(scope)
  }

  function storeBinding(sessionId: string, status: string, captureRoute: string, reference: string | null): void {
    database.prepare(
      `INSERT INTO conversation_binding(
         session_id, agent_cli, status, conversation_reference, capture_route,
         launch_cwd, launch_executable, launch_argv_json, launch_environment_json, detail, captured_at
       ) VALUES (?, 'codex', ?, ?, ?, '/work', '/usr/bin/codex', '[]', '{}', 'stored', ?)`
    ).run(sessionId, status, reference, captureRoute, now)
  }

  it('adds the hook route beside the existing session fields, and null without a binding', async () => {
    storeBinding('s2', 'bound', 'hook-session-start', '01a0b657-0000-4000-8000-000000000001')

    const sessions = await listed({ kind: 'owner' })

    expect(sessions.map((session) => [session.sessionId, session.conversation])).toEqual([
      ['s1', null],
      ['s2', { status: 'bound', captureRoute: 'hook-session-start' }]
    ])
    // Backward compatible: every field a client read before is still there, untouched.
    expect(sessions[0]).toMatchObject({ sessionId: 's1', name: 'One', cwd: '/work' })
  })

  it('reports the legacy routes unchanged', async () => {
    storeBinding('s1', 'unsupported', 'unsupported', null)
    storeBinding('s2', 'bound', 'claude-session-id', '01a0b657-0000-4000-8000-000000000002')

    expect((await listed({ kind: 'owner' })).map((session) => session.conversation)).toEqual([
      { status: 'unsupported', captureRoute: 'unsupported' },
      { status: 'bound', captureRoute: 'claude-session-id' }
    ])
  })

  it('never shows one session the route of another', async () => {
    storeBinding('s2', 'bound', 'hook-session-start', '01a0b657-0000-4000-8000-000000000003')

    const sessions = await listed({ kind: 'session', sessionId: 's1' })

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ sessionId: 's1', conversation: null })
  })

  it('carries the route into the snapshot the owner sees', async () => {
    storeBinding('s2', 'bound', 'hook-session-start', '01a0b657-0000-4000-8000-000000000004')

    const reach = service as unknown as { snapshot(scope: unknown): Promise<{ sessions: unknown[] }> }
    const snapshot = await reach.snapshot({ kind: 'owner' })

    expect(snapshot.sessions).toEqual([
      { sessionId: 's1', name: 'One', cwd: '/work', process: 'never-started', conversation: null },
      {
        sessionId: 's2',
        name: 'Two',
        cwd: '/work/two',
        process: 'never-started',
        conversation: { status: 'bound', captureRoute: 'hook-session-start' }
      }
    ])
  })
})

describe('refused agent requests', () => {
  it('writes the reason where the owner can read it while BMN runs', async () => {
    const reach = service as unknown as {
      logRefusal(method: string, sessionId: string | null, reason: string): void
      refusalWrites: Promise<void>
    }

    reach.logRefusal('conversation.observe', 's1', 'already resumed in "Two"')
    reach.logRefusal('conversation.observe', null, 'conversationReference must be a UUID')
    await reach.refusalWrites

    const written = await readFile(service.refusalLogPath, 'utf8')
    expect(written).toBe([
      `${now} conversation.observe refused for s1: already resumed in "Two"`,
      `${now} conversation.observe refused for the owner: conversationReference must be a UUID`,
      ''
    ].join('\n'))
    expect(statSync(service.refusalLogPath).mode & 0o777).toBe(0o600)
  })

  it('trims back to the newest refusals once an append carries it past the cap', async () => {
    const reach = service as unknown as {
      logRefusal(method: string, sessionId: string | null, reason: string): void
      refusalWrites: Promise<void>
    }

    for (let index = 0; index < 4_000; index += 1) {
      reach.logRefusal('conversation.observe', 's1', `refusal number ${index} ${'x'.repeat(80)}`)
    }
    await reach.refusalWrites

    const written = await readFile(service.refusalLogPath, 'utf8')
    expect(Buffer.byteLength(written)).toBeLessThanOrEqual(256 * 1024)
    expect(written).toContain('refusal number 3999')
    expect(written).not.toContain('refusal number 0 ')
  })
})
