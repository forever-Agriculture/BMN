// MODULE: companion-service.test.ts - backup export/verify completeness and artifact reconciliation against the real store
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { METHOD_REGISTRY, type ArtifactRecord, type BackupManifest, type BackupVerifyResult } from '@ai-terminal/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanionService } from './companion-service'
import type { DatabaseWorkerClient } from './database-client'
import { COMPANION_OPERATIONS, insertArtifact, listReadyArtifacts, type CompanionOperationName } from './database-companion-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import type { SessionManager } from './session-manager'
import type { TelegramConnector } from './telegram-connector'
import { DEFAULT_WORKSPACE_ID } from './store-schema'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => DatabaseConnection
const now = '2026-09-14T12:00:00.000Z'
let root: string
let database: DatabaseConnection
let service: CompanionService

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
    }
  } as unknown as DatabaseWorkerClient
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiterm-companion-'))
  database = new BetterSqlite3(':memory:')
  initializeDatabase(database, now)
  database.prepare(
    `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
     VALUES ('s1', ?, 'One', '/work', '/bin/bash', '[]', 1, ?, 0)`
  ).run(DEFAULT_WORKSPACE_ID, now)
  service = new CompanionService({
    database: workerLike(database),
    manager: {} as SessionManager,
    roots: { config: join(root, 'config'), data: join(root, 'data'), state: join(root, 'state'), runtime: join(root, 'runtime') },
    cliPath: join(root, 'bin', 'bmn'),
    emit: () => undefined
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
