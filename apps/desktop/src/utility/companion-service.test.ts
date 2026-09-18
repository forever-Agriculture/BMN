// MODULE: companion-service.test.ts - backup export/verify completeness and artifact reconciliation against the real store
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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
    listSessions: async (workspaceId: string) => listSessions(connection, workspaceId)
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
})
