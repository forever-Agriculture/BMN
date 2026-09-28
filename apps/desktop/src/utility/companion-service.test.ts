// MODULE: companion-service.test.ts - backup export/verify completeness and artifact reconciliation against the real store
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_ATTENTION_ORIGINS,
  DEFAULT_APP_SETTINGS,
  ERROR_CODES,
  HOOK_EVENT_LOG_LIMIT,
  isAttentionOrigin,
  METHOD_REGISTRY,
  TERMINAL_NOTICE_BODY_MAX,
  TERMINAL_NOTICE_WINDOW_MS,
  isAppEventMessage,
  type AppEventMessage,
  type ArtifactRecord,
  type AttentionRecord,
  type BackupManifest,
  type BackupVerifyResult,
  type HookEventRecord,
  type HookObservation,
  type HookOriginRecord,
  type HandoffReviewSnapshot,
  type SessionRecord,
  type SessionUsage,
  type TelegramStatus,
  type UsageReading,
  type UsageWindow
} from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanionService } from './companion-service'
import type { DatabaseWorkerClient } from './database-client'
import { COMPANION_OPERATIONS, insertArtifact, listReadyArtifacts, type CompanionOperationName } from './database-companion-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { selectConversationRoutes } from './database-binding-store'
import { createWorkspace, listSessions, listWorkspaces } from './database-workspace-store'
import type { SessionManager } from './session-manager'
import type { ScreenLike } from './remote-answer'
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
let liveDirectories: Map<string, string>
let reportedProcesses: Map<string, string>
/** Screen mirrors a test hands the service for a session (Epic 30); none unless a test sets one. */
let screens: Map<string, ScreenLike>
let emitted: AppEventMessage[]
let clock: string
let archiveAtFinalTargetRead: (() => void) | null
let workspaceReads: number
let targetAvailabilityReads: number
let holdFinalAvailabilityResponse: (() => Promise<void>) | null
/** Conversation bindings the store would return, by session; none unless a test sets one. */
let bindings: Map<string, unknown>

/** Runs the real store operations the worker would, on an in-memory database. */
function workerLike(connection: DatabaseConnection): DatabaseWorkerClient {
  return {
    companion: async (name: CompanionOperationName, ...args: unknown[]) => {
      if (String(name) === 'fileReferenceTargetAvailability' && ++targetAvailabilityReads === 2) {
        archiveAtFinalTargetRead?.()
      }
      const operation = COMPANION_OPERATIONS[name] as (connection: DatabaseConnection, ...args: unknown[]) => unknown
      const value = connection.transaction(() => operation(connection, ...args))()
      if (String(name) === 'fileReferenceTargetAvailability' && targetAvailabilityReads === 2) {
        await holdFinalAvailabilityResponse?.()
      }
      return value
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
    listWorkspaces: async (includeArchived = false) => {
      if (includeArchived && ++workspaceReads === 4) archiveAtFinalTargetRead?.()
      return listWorkspaces(connection, includeArchived)
    },
    listSessions: async (workspaceId: string) => listSessions(connection, workspaceId),
    listConversationRoutes: async () => selectConversationRoutes(connection),
    getConversationBinding: async (sessionId: string) => bindings.get(sessionId)
  } as unknown as DatabaseWorkerClient
}

beforeEach(() => {
  clock = now
  archiveAtFinalTargetRead = null
  workspaceReads = 0
  targetAvailabilityReads = 0
  holdFinalAvailabilityResponse = null
  bindings = new Map()
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
  liveDirectories = new Map()
  reportedProcesses = new Map()
  screens = new Map()
  const manager = {
    liveIncarnationId: (sessionId: string) => liveIncarnations.get(sessionId),
    liveLaunchDirectory: (sessionId: string) => liveDirectories.get(sessionId),
    writeToSession: (sessionId: string, bytes: Uint8Array) => writes.push({ sessionId, bytes }),
    screenMirror: (sessionId: string) => screens.get(sessionId),
    stopScreenMirror: (sessionId: string) => screens.delete(sessionId),
    sessionWithCurrentProcessState: (session: SessionRecord) => {
      const incarnationId = reportedProcesses.get(session.sessionId)
      return incarnationId === undefined
        ? session
        : {
            ...session,
            lastProcess: { incarnationId, state: 'live', exitCode: null, signal: null, detail: null }
          }
    }
  } as unknown as SessionManager
  service = new CompanionService({
    database: workerLike(database),
    manager,
    roots: { config: join(root, 'config'), data: join(root, 'data'), state: join(root, 'state'), runtime: join(root, 'runtime') },
    cliPath: join(root, 'bin', 'bmn'),
    emit: (message) => emitted.push(message),
    now: () => new Date(clock)
  })
})

describe('file reference paste', () => {
  const request = {
    requestId: 'paste-one', sessionId: 's2', expectedIncarnationId: 'incarnation-2',
    sourcePath: '/synthetic/notes and [plans]:v2.ts', line: 42, column: 7
  }

  it('claims concurrent duplicate clicks and writes the exact unstamped reference once without Enter', async () => {
    const [first, duplicate] = await Promise.all([
      service.route(METHOD_REGISTRY.fileReferencePaste, request),
      service.route(METHOD_REGISTRY.fileReferencePaste, request)
    ])
    expect(first).toEqual(duplicate)
    expect(first).toMatchObject({
      sessionId: 's2', incarnationId: 'incarnation-2', status: 'pasted-not-submitted'
    })
    expect(writes).toHaveLength(1)
    const bytes = new TextDecoder().decode(writes[0]!.bytes)
    expect(bytes).toBe(`\u001b[200~"/synthetic/notes and [plans]:v2.ts":42:7\u001b[201~`)
    expect(bytes).not.toContain('[BMN handoff')
    const receipt = await workerLike(database).companion('getReceipt', 'file-reference-paste:paste-one')
    expect(receipt).toMatchObject({ state: 'done', result: first })
    await expect(service.route(METHOD_REGISTRY.fileReferencePaste, { ...request, sourcePath: '/other.ts' }))
      .rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })
  })

  it('rejects a stopped, restarted or archived destination before writing', async () => {
    liveIncarnations.delete('s2')
    await expect(service.route(METHOD_REGISTRY.fileReferencePaste, request))
      .rejects.toThrow(/stopped/)
    liveIncarnations.set('s2', 'new-process')
    await expect(service.route(METHOD_REGISTRY.fileReferencePaste, { ...request, requestId: 'restarted' }))
      .rejects.toThrow(/changed/)
    liveIncarnations.set('s2', 'incarnation-2')
    database.prepare('UPDATE session SET archived_at = ? WHERE session_id = ?').run(now, 's2')
    await expect(service.route(METHOD_REGISTRY.fileReferencePaste, { ...request, requestId: 'archived' }))
      .rejects.toThrow(/archived/)
    database.prepare('UPDATE session SET archived_at = NULL WHERE session_id = ?').run('s2')
    database.prepare('UPDATE workspace SET archived_at = ? WHERE workspace_id = ?')
      .run(now, DEFAULT_WORKSPACE_ID)
    await expect(service.route(METHOD_REGISTRY.fileReferencePaste, { ...request, requestId: 'archived-workspace' }))
      .rejects.toThrow(/archived/)
    expect(writes).toEqual([])
  })

  it('rejects an archive committed during the final availability read before any PTY write', async () => {
    let archived = false
    archiveAtFinalTargetRead = () => {
      database.prepare('UPDATE session SET archived_at = ? WHERE session_id = ?').run(now, 's2')
      archived = true
    }
    await expect(service.route(METHOD_REGISTRY.fileReferencePaste, {
      ...request, requestId: 'archive-race'
    })).rejects.toThrow(/archived/)
    expect(archived).toBe(true)
    expect(writes).toEqual([])
  })

  it('rejects a workspace archive requested while the final worker response is held', async () => {
    let releaseResponse!: () => void
    let reachedSnapshot!: () => void
    const held = new Promise<void>((resolve) => { releaseResponse = resolve })
    const snapshot = new Promise<void>((resolve) => { reachedSnapshot = resolve })
    holdFinalAvailabilityResponse = async () => { reachedSnapshot(); await held }
    const pending = service.route(METHOD_REGISTRY.fileReferencePaste, {
      ...request, requestId: 'response-gap'
    })
    await snapshot
    const finishArchive = service.beginFileReferenceAvailabilityChange()
    database.prepare('UPDATE workspace SET archived_at = ? WHERE workspace_id = ?')
      .run(now, DEFAULT_WORKSPACE_ID)
    finishArchive()
    releaseResponse()
    await expect(pending).rejects.toThrow(/archiv/)
    expect(writes).toEqual([])
  })

  it('treats a staged receipt from an interrupted host as uncertain and never replays the write', async () => {
    const payload = '"/synthetic/notes and [plans]:v2.ts":42:7'
    const paramsHash = createHash('sha256')
      .update(JSON.stringify([request.sessionId, request.expectedIncarnationId, payload])).digest('hex')
    await workerLike(database).companion('putReceipt', {
      key: 'file-reference-paste:paste-one', paramsHash, state: 'staged'
    }, now)
    await expect(service.route(METHOD_REGISTRY.fileReferencePaste, request))
      .rejects.toThrow(/may have reached/)
    await workerLike(database).companion('putReceipt', {
      key: 'file-reference-paste:known-failure', paramsHash, state: 'failed',
      error: { code: ERROR_CODES.revisionConflict, message: 'Destination stopped before paste' }
    }, now)
    await expect(service.route(METHOD_REGISTRY.fileReferencePaste, { ...request, requestId: 'known-failure' }))
      .rejects.toThrow(/rejected before writing/)
    expect(writes).toEqual([])
  })

  it('rejects grammar failures and malformed positions before any PTY write', async () => {
    for (const sourcePath of ['/synthetic/$HOME.ts', '/synthetic/a`b.ts', '/synthetic/a\\b.ts', '/synthetic/a*.ts', '/synthetic/a\'"b.ts']) {
      await expect(service.route(METHOD_REGISTRY.fileReferencePaste, { ...request, requestId: sourcePath, sourcePath }))
        .rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })
    }
    await expect(service.route(METHOD_REGISTRY.fileReferencePaste, { ...request, requestId: 'bad-line', line: 0 }))
      .rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })
    expect(writes).toEqual([])
  })
})

describe('file search address', () => {
  it('uses the selected session directory or the workspace root and keeps them distinct', async () => {
    const workspaceRoot = join(root, 'workspace')
    const sessionRoot = join(root, 'session')
    const liveRoot = join(root, 'live')
    await mkdir(workspaceRoot)
    await mkdir(sessionRoot)
    await mkdir(liveRoot)
    await writeFile(join(workspaceRoot, 'workspace-match.ts'), 'x')
    await writeFile(join(sessionRoot, 'session-match.ts'), 'x')
    await writeFile(join(liveRoot, 'live-match.ts'), 'x')
    database.prepare('UPDATE workspace SET default_cwd = ? WHERE workspace_id = ?')
      .run(workspaceRoot, DEFAULT_WORKSPACE_ID)
    database.prepare('UPDATE session SET cwd = ? WHERE session_id = ?').run(sessionRoot, 's2')
    const base = { ownerId: 'palette', workspaceId: DEFAULT_WORKSPACE_ID, query: 'match' }
    const fromSession = await service.route(METHOD_REGISTRY.fileReferenceSearch, {
      ...base, requestId: 'session', sessionId: 's2'
    }) as import('@bmn/protocol').FileReferenceSearchResult
    const fromWorkspace = await service.route(METHOD_REGISTRY.fileReferenceSearch, {
      ...base, requestId: 'workspace', sessionId: null
    }) as import('@bmn/protocol').FileReferenceSearchResult
    expect(fromSession.files.map((file) => file.name)).toEqual(['session-match.ts'])
    expect(fromSession.root).toBe(sessionRoot)
    expect(fromWorkspace.files.map((file) => file.name)).toEqual(['workspace-match.ts'])
    expect(fromWorkspace.root).toBe(workspaceRoot)
    liveDirectories.set('s2', liveRoot)
    const fromLive = await service.route(METHOD_REGISTRY.fileReferenceSearch, {
      ...base, requestId: 'live', sessionId: 's2'
    }) as import('@bmn/protocol').FileReferenceSearchResult
    expect(fromLive.root).toBe(liveRoot)
    expect(fromLive.files.map((file) => file.name)).toEqual(['live-match.ts'])
    // The retained renderer startup is no longer the search root after its process exits.
    liveDirectories.delete('s2')
    await writeFile(join(workspaceRoot, 'after-exit.ts'), 'x')
    database.prepare('UPDATE session SET cwd = ? WHERE session_id = ?').run(workspaceRoot, 's2')
    const afterExit = await service.route(METHOD_REGISTRY.fileReferenceSearch, {
      ...base, requestId: 'after-exit', sessionId: 's2', query: 'after-exit'
    }) as import('@bmn/protocol').FileReferenceSearchResult
    expect(afterExit.root).toBe(workspaceRoot)
    expect(afterExit.files.map((file) => file.name)).toEqual(['after-exit.ts'])
  })

  it('searches a foreign split-pane session in its owning workspace', async () => {
    const foreignRoot = join(root, 'foreign')
    await mkdir(foreignRoot)
    await writeFile(join(foreignRoot, 'foreign-match.ts'), 'x')
    createWorkspace(database, { name: 'Foreign', defaultCwd: foreignRoot }, 'foreign-workspace', now)
    database.prepare('UPDATE session SET workspace_id = ?, cwd = ? WHERE session_id = ?')
      .run('foreign-workspace', foreignRoot, 's2')
    const result = await service.route(METHOD_REGISTRY.fileReferenceSearch, {
      ownerId: 'foreign-palette', requestId: 'foreign-query',
      workspaceId: DEFAULT_WORKSPACE_ID, sessionId: 's2', query: 'foreign-match'
    }) as import('@bmn/protocol').FileReferenceSearchResult
    expect(result.unavailable).toBe(false)
    expect(result.root).toBe(foreignRoot)
    expect(result.files.map((file) => file.name)).toEqual(['foreign-match.ts'])
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

async function storePublishedArtifact(artifactId: string, sessionId = 's1'): Promise<ArtifactRecord> {
  const originals = join(root, 'data', 'artifacts', 'originals')
  await mkdir(originals, { recursive: true })
  const bytes = Buffer.from(`published ${artifactId}`)
  const storedPath = join(originals, artifactId)
  await writeFile(storedPath, bytes)
  return insertArtifact(database, {
    artifactId,
    sessionId,
    incarnationId: sessionId === 's1' ? 'incarnation-1' : 'incarnation-2',
    direction: 'output',
    source: 'agent',
    originalName: `${artifactId}.txt`,
    mediaType: 'text/plain',
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    storedPath,
    sourcePath: null,
    state: 'ready',
    createdAt: now
  })
}

const exportBackup = (parent: string) =>
  service.route('backup.export', { directory: parent }) as Promise<{ directory: string; manifest: BackupManifest }>
const verifyBackup = (directory: string) =>
  service.route('backup.verify', { directory }) as Promise<BackupVerifyResult>

type AgentHandoffParams = {
  sourceSessionId: string
  sourceIncarnationId: string
  destinationSessionId: string
  text: string
  artifactIds: string[]
}

const prepareAgentHandoff = (params: AgentHandoffParams) =>
  (service as unknown as {
    prepareAgentHandoff(value: AgentHandoffParams): Promise<{ draftId: string; requestId: string; state: 'draft' }>
  }).prepareAgentHandoff(params)

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
  const review = (draftId: string, expectedToken?: string) =>
    service.route(METHOD_REGISTRY.handoffReview, {
      draftId, workspaceId: DEFAULT_WORKSPACE_ID, ...(expectedToken ? { expectedToken } : {})
    }) as Promise<HandoffReviewSnapshot>

  it('reads one exact handoff revision and rejects a draft changed before confirmation', async () => {
    const draft = await save({ sourceSessionId: 's1', sessionId: 's2', text: 'First', artifactIds: [] })
    const first = await review(draft.draftId)
    expect(first).toMatchObject({ draft: { text: 'First' }, source: { sessionId: 's1' },
      destination: { sessionId: 's2' } })
    expect(first.token).toMatch(/^[a-f0-9]{64}$/)
    await expect(review(draft.draftId, first.token)).resolves.toMatchObject({ token: first.token })

    await save({ draftId: draft.draftId, sourceSessionId: 's1', sessionId: 's2',
      text: 'Replacement', artifactIds: [], expectedUpdatedAt: draft.updatedAt })
    await expect(review(draft.draftId, first.token)).rejects.toThrow('handoff or destination changed')
    expect(writes).toEqual([])
  })

  it('rejects a destination archived between coherent review reads', async () => {
    const draft = await save({ sourceSessionId: 's1', sessionId: 's2', text: 'Review', artifactIds: [] })
    const first = await review(draft.draftId)
    database.prepare("UPDATE session SET archived_at = ?, revision = revision + 1 WHERE session_id = 's2'")
      .run('2026-09-24T12:01:00.000Z')

    await expect(review(draft.draftId, first.token)).rejects.toThrow('handoff or destination changed')
    await expect(review(draft.draftId)).rejects.toThrow('handoff or destination changed')
    expect(writes).toEqual([])
  })

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

describe('agent-prepared handoffs', () => {
  it('derives the source identity and validates destination and published files', async () => {
    const published = await storePublishedArtifact('published-source')
    const input = (await storeArtifacts(1))[0]!
    const foreign = await storePublishedArtifact('published-foreign', 's2')
    const common = { sourceSessionId: 's1', destinationSessionId: 's2', text: 'result', artifactIds: [] }

    await expect(prepareAgentHandoff({ ...common, sourceIncarnationId: 'old-incarnation' }))
      .rejects.toThrow(/different process/i)
    await expect(prepareAgentHandoff({
      ...common, sourceIncarnationId: 'incarnation-1', destinationSessionId: 's1'
    })).rejects.toThrow(/different destination/i)
    await expect(prepareAgentHandoff({
      ...common, sourceIncarnationId: 'incarnation-1', destinationSessionId: 'missing-session'
    })).rejects.toThrow(/destination is unavailable/i)
    await expect(prepareAgentHandoff({
      ...common, sourceIncarnationId: 'incarnation-1', artifactIds: [input.artifactId]
    })).rejects.toThrow(/published output/i)
    await expect(prepareAgentHandoff({
      ...common, sourceIncarnationId: 'incarnation-1', artifactIds: [foreign.artifactId]
    })).rejects.toThrow(/belong to the source/i)
    await expect(prepareAgentHandoff({
      ...common, sourceIncarnationId: 'incarnation-1', text: 'bad\u0007text'
    })).rejects.toThrow(/newline and tab/i)

    const result = await prepareAgentHandoff({
      ...common,
      sourceIncarnationId: 'incarnation-1',
      text: 'result\nwith\ttab',
      artifactIds: [published.artifactId]
    })
    expect(result.state).toBe('draft')

    const draft = (await service.route(METHOD_REGISTRY.draftList, {}) as import('@bmn/protocol').InputDraftRecord[])
      .find((record) => record.draftId === result.draftId)
    expect(draft).toMatchObject({
      sessionId: 's2', sourceSessionId: 's1', preparedBy: 'agent',
      requestId: result.requestId, text: 'result\nwith\ttab', artifactIds: [published.artifactId], state: 'draft'
    })
    const request = (await service.route(METHOD_REGISTRY.attentionList, {}) as AttentionRecord[])
      .find((record) => record.requestId === result.requestId)
    expect(request).toMatchObject({
      sessionId: 's1', incarnationId: 'incarnation-1', kind: 'handoff',
      requestKey: `handoff:${result.draftId}`, title: 'Asks to hand off to "Two"',
      body: 'result\nwith\ttab\n1 files', openedBy: 'cli', state: 'open'
    })
    expect(writes).toEqual([])
  })

  it('delivers an agent petition with its stamp and resolves the source request', async () => {
    const result = await prepareAgentHandoff({
      sourceSessionId: 's1', sourceIncarnationId: 'incarnation-1', destinationSessionId: 's2',
      text: 'owner delivery', artifactIds: []
    })
    const draft = (await service.route(METHOD_REGISTRY.draftList, {}) as import('@bmn/protocol').InputDraftRecord[])
      .find((record) => record.draftId === result.draftId)
    if (!draft) throw new Error('expected prepared draft')

    const delivered = await service.route(METHOD_REGISTRY.draftSend, {
      draftId: result.draftId,
      submit: false,
      expectedIncarnationId: 'incarnation-2',
      expectedUpdatedAt: draft.updatedAt
    }) as import('@bmn/protocol').InputDraftRecord
    expect(delivered).toMatchObject({ state: 'accepted', detail: 'Pasted to terminal — not submitted' })
    const payload = new TextDecoder().decode(writes[0]!.bytes)
    expect(payload).toContain('[BMN handoff from One · /bin/bash · /work · prepared by the agent, delivered by the owner]')
    expect(payload).toContain('owner delivery')
    expect(payload.endsWith('\r')).toBe(false)
    expect((await service.route(METHOD_REGISTRY.attentionList, {}) as AttentionRecord[])
      .find((record) => record.requestId === result.requestId)).toMatchObject({
        state: 'answered', resolution: 'pasted, not submitted', resolvedBy: 'owner'
      })
  })

  it('keeps a claimed petition open when its expiry arrives during owner paste', async () => {
    const result = await prepareAgentHandoff({
      sourceSessionId: 's1', sourceIncarnationId: 'incarnation-1', destinationSessionId: 's2',
      text: 'late delivery', artifactIds: []
    })
    const draft = COMPANION_OPERATIONS.getDraft(database, result.draftId)
    clock = '2026-09-15T12:00:00.000Z'
    let sweep: Promise<void> | undefined
    service['options'].manager.writeToSession = (sessionId, bytes) => {
      expect(service['draftOperations'].has(result.draftId)).toBe(true)
      sweep = service['sweepAttention']()
      writes.push({ sessionId, bytes })
    }

    const delivered = await service.route(METHOD_REGISTRY.draftSend, {
      draftId: result.draftId, submit: false,
      expectedIncarnationId: 'incarnation-2', expectedUpdatedAt: draft.updatedAt
    }) as import('@bmn/protocol').InputDraftRecord

    await sweep
    expect(delivered.state).toBe('accepted')
    expect(writes).toHaveLength(1)
    expect(COMPANION_OPERATIONS.getAttention(database, result.requestId)).toMatchObject({
      state: 'answered', resolution: 'pasted, not submitted', resolvedBy: 'owner'
    })
  })

  it('expires a recovered uncertain petition and abandoned retry without claiming a paste failed', async () => {
    const result = await prepareAgentHandoff({
      sourceSessionId: 's1', sourceIncarnationId: 'incarnation-1', destinationSessionId: 's2',
      text: 'possible paste', artifactIds: []
    })
    const original = COMPANION_OPERATIONS.getDraft(database, result.draftId)
    COMPANION_OPERATIONS.claimHandoffDraft(
      database, result.draftId, original.updatedAt, 'incarnation-2', '2026-09-14T12:00:01.000Z'
    )
    const retry = await service.route(METHOD_REGISTRY.draftRetry, { draftId: result.draftId }) as
      import('@bmn/protocol').InputDraftRecord
    clock = '2026-09-15T12:00:00.000Z'
    expect(service['draftOperations'].size).toBe(0)

    await service['sweepAttention']()

    expect(COMPANION_OPERATIONS.getAttention(database, result.requestId)).toMatchObject({
      state: 'expired', resolvedBy: 'expiry'
    })
    expect(COMPANION_OPERATIONS.getDraft(database, result.draftId)).toMatchObject({ state: 'uncertain' })
    expect(COMPANION_OPERATIONS.getDraft(database, retry.draftId)).toMatchObject({
      state: 'discarded', detail: 'The handoff request expired'
    })
    expect(writes).toEqual([])
  })

  it('keeps agent authorship and resolves its petition after an explicit uncertain-paste retry', async () => {
    const result = await prepareAgentHandoff({
      sourceSessionId: 's1', sourceIncarnationId: 'incarnation-1', destinationSessionId: 's2',
      text: 'retry result', artifactIds: []
    })
    const original = COMPANION_OPERATIONS.getDraft(database, result.draftId)
    COMPANION_OPERATIONS.claimHandoffDraft(
      database, result.draftId, original.updatedAt, 'incarnation-2', '2026-09-14T12:00:01.000Z'
    )

    const retry = await service.route(METHOD_REGISTRY.draftRetry, { draftId: result.draftId }) as
      import('@bmn/protocol').InputDraftRecord
    expect(retry).toMatchObject({
      state: 'draft', text: 'retry result', preparedBy: 'agent', requestId: result.requestId
    })
    expect(writes).toEqual([])
    const delivered = await service.route(METHOD_REGISTRY.draftSend, {
      draftId: retry.draftId, submit: false,
      expectedIncarnationId: 'incarnation-2', expectedUpdatedAt: retry.updatedAt
    }) as import('@bmn/protocol').InputDraftRecord
    expect(delivered.state).toBe('accepted')
    expect(new TextDecoder().decode(writes[0]!.bytes)).toContain('prepared by the agent, delivered by the owner')
    expect(COMPANION_OPERATIONS.getAttention(database, result.requestId)).toMatchObject({
      state: 'answered', resolution: 'pasted, not submitted', resolvedBy: 'owner'
    })
    expect(COMPANION_OPERATIONS.getDraft(database, result.draftId).state).toBe('uncertain')
  })

  it('keeps source snapshots to handoff metadata and marks an old source incarnation', async () => {
    const published = await storePublishedArtifact('snapshot-source')
    const result = await prepareAgentHandoff({
      sourceSessionId: 's1', sourceIncarnationId: 'incarnation-1', destinationSessionId: 's2',
      text: 'agent text', artifactIds: [published.artifactId]
    })
    const draft = (await service.route(METHOD_REGISTRY.draftList, {}) as import('@bmn/protocol').InputDraftRecord[])
      .find((record) => record.draftId === result.draftId)
    if (!draft) throw new Error('expected prepared draft')
    const edited = await service.route(METHOD_REGISTRY.draftSave, {
      draftId: result.draftId,
      sourceSessionId: 's1', sessionId: 's2', text: 'owner-only edited text', artifactIds: [],
      expectedUpdatedAt: draft.updatedAt
    }) as import('@bmn/protocol').InputDraftRecord

    const reach = service as unknown as {
      snapshot(scope: unknown): Promise<{
        handoffs: unknown[]
        attention: AttentionRecord[]
      }>
    }
    const sessionSnapshot = await reach.snapshot({ kind: 'session', sessionId: 's1', incarnationId: 'incarnation-1' })
    expect(sessionSnapshot.handoffs).toEqual([{
      draftId: result.draftId, destinationSessionId: 's2', state: 'draft', updatedAt: edited.updatedAt
    }])
    expect(JSON.stringify(sessionSnapshot)).not.toContain('owner-only edited text')
    expect(JSON.stringify(sessionSnapshot)).not.toContain(published.artifactId)

    const ownerSnapshot = await reach.snapshot({ kind: 'owner' })
    expect(ownerSnapshot.handoffs).toEqual([expect.objectContaining({
      draftId: result.draftId, text: 'owner-only edited text', preparedBy: 'agent'
    })])

    reportedProcesses.set('s1', 'incarnation-new')
    const staleSnapshot = await reach.snapshot({ kind: 'session', sessionId: 's1', incarnationId: 'incarnation-new' })
    expect(staleSnapshot.attention.find((record) => record.requestId === result.requestId)?.body)
      .toContain('prepared by an earlier process of this session')
  })

  it('resolves an owner discard and refuses a second delivery', async () => {
    const result = await prepareAgentHandoff({
      sourceSessionId: 's1', sourceIncarnationId: 'incarnation-1', destinationSessionId: 's2',
      text: 'discard me', artifactIds: []
    })
    const discarded = await service.route(METHOD_REGISTRY.draftDiscard, { draftId: result.draftId }) as
      import('@bmn/protocol').InputDraftRecord
    expect(discarded).toMatchObject({ state: 'discarded' })
    expect((await service.route(METHOD_REGISTRY.attentionList, {}) as AttentionRecord[])
      .find((record) => record.requestId === result.requestId)).toMatchObject({
        state: 'answered', resolution: 'discarded', resolvedBy: 'owner'
      })
    const repeated = await service.route(METHOD_REGISTRY.draftSend, {
      draftId: result.draftId,
      submit: false,
      expectedIncarnationId: 'incarnation-2',
      expectedUpdatedAt: discarded.updatedAt
    }) as import('@bmn/protocol').InputDraftRecord
    expect(repeated).toMatchObject({ draftId: result.draftId, state: 'discarded' })
    expect(writes).toEqual([])
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
      state: 'polling', detail: '', lastPollAt: null, lastError: null, rejectedUpdates: 0, failingSince: null
    }

    const record = await service['openAttention']({
      sessionId: 's1', incarnationId: null, kind: 'question', title: 'Session needs you', requestKey: 'bind'
    })
    await service['cards'].page(record)

    expect(COMPANION_OPERATIONS.getTelegramMessage(database, 77)).toEqual({
      sessionId: 's1',
      requestId: record.requestId,
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
    service['telegramHealth'] = { state: 'polling', detail: '', lastPollAt: null, lastError: null, rejectedUpdates: 0, failingSince: null }
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

    expect(sent).toEqual(['🔐 <b>Session</b>\n<b>Claude wants to use Bash</b>\n\n<i>Reply to this message to answer.</i>'])
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
    service['telegramHealth'] = { state: 'polling', detail: '', lastPollAt: null, lastError: null, rejectedUpdates: 0, failingSince: null }
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
      '🔐 <b>Session</b>\n<b>Claude wants to use Bash</b>\n\n<i>Reply to this message to answer.</i>',
      '■ <b>Session</b> exited'
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

  it('keeps a reply to an open structured dialog as a draft even with automatic replies on (Story 30.3)', async () => {
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
      sessionId: 's1', incarnationId: 'incarnation-1', requestKey: 'question',
      kind: 'question', title: 'Claude asks: Which auth method?',
      prompt: {
        type: 'questions', harness: 'claude', shape: 'multi-select', requestRef: null, toolUseId: 'toolu_1',
        questions: [{ id: null, header: 'Auth', text: 'Which auth method?', multiSelect: true,
          options: [{ label: 'JWT', description: null }, { label: 'Cookies', description: null }] }]
      }
    }, 'telegram-structured-request', now)
    COMPANION_OPERATIONS.putTelegramMessage(database, 77, 's1', request.requestId, 'incarnation-1', now)

    await service['handleTelegramReply']({
      updateId: 90, chatId: 1, fromUserId: 1, messageId: 99, replyToMessageId: 77, text: 'JWT please', file: null
    })

    expect(writes).toEqual([])
    expect(sent).toEqual([
      'Saved as a draft in BMN. A typed reply cannot pick an option in this dialog: tap a button or answer at the laptop.'
    ])
    expect(COMPANION_OPERATIONS.getAttention(database, request.requestId)).toMatchObject({ state: 'open' })
    expect(COMPANION_OPERATIONS.listDrafts(database)).toContainEqual(
      expect.objectContaining({ sessionId: 's1', origin: 'telegram', state: 'draft', text: 'JWT please' })
    )
  })

  it('hands a reply to a card that offers Other… to the card, and makes no draft of it (Story 31.4)', async () => {
    const sent: string[] = []
    service['telegram'] = {
      sendMessage: async (message: string) => {
        sent.push(message)
        return { messageId: sent.length }
      }
    } as unknown as TelegramConnector
    await service.sessionsChanged()
    const typedReply = vi.spyOn(service['cards'], 'typedReply').mockResolvedValue(true)
    const request = COMPANION_OPERATIONS.openAttention(database, {
      sessionId: 's1', incarnationId: 'incarnation-1', requestKey: 'question', kind: 'question', title: 'Claude asks'
    }, 'telegram-other-request', now)
    COMPANION_OPERATIONS.putTelegramMessage(database, 78, 's1', request.requestId, 'incarnation-1', now)
    const reply = { updateId: 91, chatId: 1, fromUserId: 1, messageId: 99, replyToMessageId: 78, text: 'Passkeys', file: null }
    await service['handleTelegramReply'](reply)
    expect(typedReply).toHaveBeenCalledWith(reply)
    expect(sent).toEqual([])
    expect(COMPANION_OPERATIONS.listDrafts(database).filter((draft) => draft.text === 'Passkeys')).toEqual([])
    typedReply.mockRestore()
  })

  it('keeps a handoff page reply as a source draft even when automatic replies are enabled', async () => {
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
      sessionId: 's1', incarnationId: 'incarnation-1', requestKey: 'handoff:source-draft',
      kind: 'handoff', title: 'Asks to hand off to another session'
    }, 'telegram-handoff-request', now)
    COMPANION_OPERATIONS.putTelegramMessage(
      database, 77, 's1', request.requestId, 'incarnation-1', now
    )

    await service['handleTelegramReply']({
      updateId: 88,
      chatId: 1,
      fromUserId: 1,
      messageId: 99,
      replyToMessageId: 77,
      text: 'Please revise the summary',
      file: null
    })

    expect(writes).toEqual([])
    expect(sent).toEqual(['Saved as a draft in BMN for that session.'])
    expect(COMPANION_OPERATIONS.getAttention(database, request.requestId)).toMatchObject({ state: 'open' })
    expect(COMPANION_OPERATIONS.listDrafts(database)).toContainEqual(
      expect.objectContaining({ sessionId: 's1', origin: 'telegram', state: 'draft', text: 'Please revise the summary' })
    )
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

describe('Telegram state entries (Story 32.2)', () => {
  it('sends every entry into a stopped state with its event, numbered across restarts and without the token', async () => {
    await database.transaction(() => COMPANION_OPERATIONS.putSettingsSection(database, 'telegram', {
      ...DEFAULT_APP_SETTINGS.telegram, enabled: true, allowedChatId: 1
    }, new Date(clock).toISOString()))()
    const token = '123456789:ENTRY_fake_token_not_real'
    const emitted: AppEventMessage[] = []
    const conflicted = new CompanionService({
      ...service['options'],
      emit: (message) => emitted.push(message),
      telegramApiOrigin: 'http://127.0.0.1:9',
      fetch: async () => new Response(JSON.stringify({ ok: false, error_code: 409, description: `Conflict for ${token}` }),
        { status: 409, headers: { 'content-type': 'application/json' } })
    })
    const first = await conflicted.route(METHOD_REGISTRY.telegramConfigure, { token }) as TelegramStatus
    const again = await conflicted.route(METHOD_REGISTRY.telegramConfigure, { token }) as TelegramStatus
    expect(first.state).toBe('conflict')
    expect(again.state).toBe('conflict')
    const entries = emitted.flatMap((message) => message.telegramEntry ? [message.telegramEntry] : [])
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.state)).toEqual(['conflict', 'conflict'])
    expect(entries[1]!.host).toBe(entries[0]!.host)
    expect(entries[1]!.entry).toBeGreaterThan(entries[0]!.entry)
    expect(JSON.stringify(emitted)).not.toContain(token)
    expect(emitted.every((message) => isAppEventMessage(message))).toBe(true)
    await conflicted.close()
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

  it('keeps a refusal on one line, whatever the caller put in the parameter name', async () => {
    const reach = service as unknown as {
      logRefusal(method: string, sessionId: string | null, reason: string): void
      refusalWrites: Promise<void>
    }

    // `Unknown parameter: <key>` carries the caller's own key; a newline in it would forge a second entry.
    reach.logRefusal('conversation.observe', 's1', 'Unknown parameter: x\n2026-01-01T00:00:00.000Z forged line')
    await reach.refusalWrites

    const written = await readFile(service.refusalLogPath, 'utf8')
    expect(written.trimEnd().split('\n')).toHaveLength(1)
    expect(written).toContain('Unknown parameter: x 2026-01-01T00:00:00.000Z forged line')
    expect(written).not.toContain('\n2026-01-01')
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

describe('progress evidence through the service', () => {
  /** `progress.report` is a control method, so drive the handler the control server is given. */
  const report = (p: Record<string, unknown>) =>
    (service as unknown as {
      reportProgress: (p: unknown) => Promise<{ applied: boolean; current: { evidence: unknown[] } }>
    }).reportProgress({ sessionId: 's1', incarnationId: null, source: 'agent', ...p })

  /** A ready file this session published: the only kind a report may point at. */
  const published = (artifactId: string, sessionId = 's1'): ArtifactRecord =>
    insertArtifact(database, {
      artifactId,
      sessionId,
      incarnationId: null,
      direction: 'output',
      source: 'agent',
      originalName: `${artifactId}.txt`,
      mediaType: 'text/plain',
      byteLength: 4,
      sha256: createHash('sha256').update(artifactId).digest('hex'),
      storedPath: join(root, 'data', 'artifacts', 'originals', artifactId),
      sourcePath: null,
      state: 'ready',
      createdAt: now
    })

  it('carries the reported ids to the store in the order they were given', async () => {
    published('out-1')
    published('out-2')

    const result = await report({
      state: 'verified',
      label: 'Checks passed',
      evidenceIds: ['out-2', 'out-1'],
      observedAt: now
    })

    expect(result.applied).toBe(true)
    expect(result.current.evidence).toEqual([
      { artifactId: 'out-2', name: 'out-2.txt' },
      { artifactId: 'out-1', name: 'out-1.txt' }
    ])
    expect(emitted.at(-1)).toMatchObject({ kind: 'app-event', topic: 'progress', sessionId: 's1' })
  })

  it('reports nothing at all when one named file is not this session\'s own output', async () => {
    published('out-1')
    published('other-session', 's2')
    await report({ state: 'running', label: 'Building', observedAt: now })
    emitted = []

    await expect(report({
      state: 'verified',
      label: 'Checks passed',
      evidenceIds: ['out-1', 'other-session'],
      observedAt: '2026-09-14T12:05:00.000Z'
    })).rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })

    // The earlier report stands untouched, and nothing told the renderer otherwise.
    const standing = COMPANION_OPERATIONS.listProgress(database)
    expect(standing).toEqual([expect.objectContaining({ state: 'running', label: 'Building', evidence: [] })])
    expect(emitted).toEqual([])
  })
})

describe('hook event log', () => {
  const observe = async (sessionId: string, event: string, effects: HookEventRecord['effects'] = []): Promise<void> => {
    await (service as unknown as {
      observeHookEvent(p: {
        sessionId: string
        incarnationId: string | null
        agent: HookEventRecord['agent']
        event: string
        source: string | null
        toolName: string | null
        effects: readonly HookEventRecord['effects'][number][]
      }): unknown
    }).observeHookEvent({
      sessionId,
      incarnationId: liveIncarnations.get(sessionId) ?? null,
      agent: 'claude',
      event,
      source: null,
      toolName: null,
      effects
    })
  }

  it('keeps only the newest events per session and never mixes two sessions', async () => {
    for (let index = 0; index < HOOK_EVENT_LOG_LIMIT + 5; index += 1) await observe('s1', `Event${index}`)
    await observe('s2', 'OnlyTheirs', ['opened'])

    const mine = await service.route(METHOD_REGISTRY.hookEventsList, { sessionId: 's1' }) as HookEventRecord[]
    const theirs = await service.route(METHOD_REGISTRY.hookEventsList, { sessionId: 's2' }) as HookEventRecord[]

    expect(mine).toHaveLength(HOOK_EVENT_LOG_LIMIT)
    expect(mine[0]?.event).toBe('Event5')
    expect(mine.at(-1)?.event).toBe(`Event${HOOK_EVENT_LOG_LIMIT + 4}`)
    expect(mine.some((entry) => entry.sessionId === 's2')).toBe(false)
    expect(theirs).toEqual([expect.objectContaining({ event: 'OnlyTheirs', effects: ['opened'] })])
  })

  it('reads as empty for a session that reported nothing, and keeps the log out of the snapshot', async () => {
    await observe('s1', 'Stop', ['withdrew', 'opened'])

    const empty = await service.route(METHOD_REGISTRY.hookEventsList, { sessionId: 's2' })
    const snapshot = await service.route(METHOD_REGISTRY.attentionList, {})

    expect(empty).toEqual([])
    expect(JSON.stringify(snapshot)).not.toContain('withdrew')
  })
})

describe('hook observation summary', () => {
  const observe = async (params: {
    sessionId: string
    incarnationId?: string | null
    agent?: HookEventRecord['agent']
    event: string
    source?: string | null
  }): Promise<void> => {
    const { sessionId, incarnationId = liveIncarnations.get(sessionId) ?? null, agent = 'claude', event, source = null } = params
    await (service as unknown as {
      observeHookEvent(p: {
        sessionId: string
        incarnationId: string | null
        agent: HookEventRecord['agent']
        event: string
        source: string | null
        toolName: string | null
        effects: readonly HookEventRecord['effects'][number][]
      }): unknown
    }).observeHookEvent({
      sessionId,
      incarnationId,
      agent,
      event,
      source,
      toolName: null,
      effects: []
    })
  }

  const observation = (params: Record<string, unknown>) =>
    service.route(METHOD_REGISTRY.hookObservationGet, params) as Promise<HookObservation>

  it('retains the latest attributable harness event of the current run with its receipt time', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart' })
    clock = '2026-09-14T12:00:01.000Z'
    await observe({ sessionId: 's1', event: 'PostToolUse' })

    await expect(observation({ sessionId: 's1' })).resolves.toEqual({
      state: 'observed',
      sessionId: 's1',
      incarnationId: 'incarnation-1',
      agent: 'claude',
      event: 'PostToolUse',
      observedAt: '2026-09-14T12:00:01.000Z',
      detailAvailable: true,
      compaction: null
    })
  })

  it('counts each agent\'s compaction in this run with the time of the last one (Story 36.1)', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'startup' })
    clock = '2026-09-14T12:00:01.000Z'
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'compact' })
    clock = '2026-09-14T12:00:02.000Z'
    await observe({ sessionId: 's1', event: 'PostToolUse' })
    await expect(observation({ sessionId: 's1' })).resolves.toMatchObject({
      event: 'PostToolUse', compaction: { lastAt: '2026-09-14T12:00:01.000Z', count: 1 }
    })
    clock = '2026-09-14T12:00:03.000Z'
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'compact' })
    await expect(observation({ sessionId: 's1' })).resolves.toMatchObject({
      compaction: { lastAt: '2026-09-14T12:00:03.000Z', count: 2 }
    })

    // Codex: automatic compaction arrives as PostCompact auto then SessionStart compact, and is one.
    await observe({ sessionId: 's2', agent: 'codex', event: 'PostCompact', source: 'auto' })
    await observe({ sessionId: 's2', agent: 'codex', event: 'SessionStart', source: 'compact' })
    await observe({ sessionId: 's2', agent: 'codex', event: 'PreCompact', source: 'manual' })
    await observe({ sessionId: 's2', agent: 'codex', event: 'PostCompact', source: 'manual' })
    await expect(observation({ sessionId: 's2' })).resolves.toMatchObject({ compaction: { count: 2 } })

    // OpenCode: the owner's session counts; a subagent's is logged but not counted.
    liveIncarnations.set('s3', 'incarnation-3')
    await observe({ sessionId: 's3', agent: 'opencode', event: 'session.compacted', source: 'subagent' })
    await expect(observation({ sessionId: 's3' })).resolves.toMatchObject({ compaction: null })
    await observe({ sessionId: 's3', agent: 'opencode', event: 'session.compacted' })
    await expect(observation({ sessionId: 's3' })).resolves.toMatchObject({ compaction: { count: 1 } })
  })

  it('does not count a new conversation, a resume or a clear as a compaction', async () => {
    for (const source of ['startup', 'resume', 'clear']) {
      await observe({ sessionId: 's1', event: 'SessionStart', source })
      await observe({ sessionId: 's1', agent: 'codex', event: 'SessionStart', source })
    }
    await observe({ sessionId: 's1', agent: 'cursor', event: 'sessionStart', source: 'compact' })

    await expect(observation({ sessionId: 's1' })).resolves.toMatchObject({ state: 'observed', compaction: null })
  })

  it('starts a new incarnation from no compaction, and never counts a replaced run\'s late one', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'compact' })
    liveIncarnations.set('s1', 'incarnation-2')
    await observe({ sessionId: 's1', incarnationId: 'incarnation-1', event: 'SessionStart', source: 'compact' })
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'startup' })

    await expect(observation({ sessionId: 's1' })).resolves.toMatchObject({
      incarnationId: 'incarnation-2', compaction: null
    })
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'compact' })
    await expect(observation({ sessionId: 's1' })).resolves.toMatchObject({ compaction: { count: 1 } })
    // The replaced run's summary went with it.
    await expect(observation({ sessionId: 's1', incarnationId: 'incarnation-1' })).resolves.toMatchObject({ state: 'none' })
  })

  it('treats a compaction as information: no Needs you row and no attention event', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'compact' })

    await expect(service.route(METHOD_REGISTRY.attentionList, {})).resolves.toEqual([])
    expect(emitted.filter((message) => message.topic === 'attention')).toEqual([])
  })

  it('does not count terminal OSC notices as a harness observation', async () => {
    await observe({ sessionId: 's1', agent: 'terminal', event: 'osc:9' })

    await expect(observation({ sessionId: 's1' })).resolves.toEqual({
      state: 'none', sessionId: 's1', incarnationId: 'incarnation-1'
    })
  })

  it('does not attribute a prior incarnation\'s event to the run that replaced it', async () => {
    await observe({ sessionId: 's1', event: 'Stop' })
    liveIncarnations.set('s1', 'incarnation-2')

    await expect(observation({ sessionId: 's1' })).resolves.toEqual({
      state: 'none', sessionId: 's1', incarnationId: 'incarnation-2'
    })
    clock = '2026-09-14T12:00:02.000Z'
    await observe({ sessionId: 's1', agent: 'codex', event: 'PreToolUse' })
    await expect(observation({ sessionId: 's1' })).resolves.toMatchObject({
      state: 'observed', incarnationId: 'incarnation-2', agent: 'codex', event: 'PreToolUse'
    })
  })

  it('ignores a late event from an incarnation the host has already replaced', async () => {
    liveIncarnations.set('s1', 'incarnation-2')
    await observe({ sessionId: 's1', event: 'PostToolUse' })

    await observe({ sessionId: 's1', incarnationId: 'incarnation-1', event: 'Stop' })

    await expect(observation({ sessionId: 's1', incarnationId: 'incarnation-2' })).resolves.toMatchObject({
      state: 'observed', event: 'PostToolUse', incarnationId: 'incarnation-2'
    })
  })

  it('keeps two sessions\' observations independent, per session and harness', async () => {
    await observe({ sessionId: 's1', agent: 'claude', event: 'Stop' })
    await observe({ sessionId: 's2', agent: 'codex', event: 'PreToolUse' })

    await expect(observation({ sessionId: 's1' })).resolves.toMatchObject({ agent: 'claude', event: 'Stop' })
    await expect(observation({ sessionId: 's2' })).resolves.toMatchObject({
      agent: 'codex', event: 'PreToolUse', incarnationId: 'incarnation-2'
    })
  })

  it('says its detail is no longer available once the bounded log has evicted the event', async () => {
    await observe({ sessionId: 's1', event: 'Stop' })
    // Notices reach the same log without ever counting as the harness's own report.
    for (let index = 0; index < HOOK_EVENT_LOG_LIMIT; index += 1) {
      await observe({ sessionId: 's1', agent: 'terminal', event: 'osc:9' })
    }

    await expect(observation({ sessionId: 's1' })).resolves.toMatchObject({
      state: 'observed', event: 'Stop', detailAvailable: false
    })
  })

  it('answers for the incarnation the caller names, and names none when there is no live run', async () => {
    await observe({ sessionId: 's1', event: 'Stop' })
    liveIncarnations.delete('s1')

    await expect(observation({ sessionId: 's1' })).resolves.toEqual({
      state: 'none', sessionId: 's1', incarnationId: null
    })
    await expect(observation({ sessionId: 's1', incarnationId: 'incarnation-1' })).resolves.toMatchObject({
      state: 'observed', incarnationId: 'incarnation-1', event: 'Stop', detailAvailable: true
    })
    await expect(observation({ sessionId: 's1', incarnationId: 'incarnation-9' })).resolves.toEqual({
      state: 'none', sessionId: 's1', incarnationId: 'incarnation-9'
    })
  })

  it('starts a fresh service with no observation from the earlier process', async () => {
    await observe({ sessionId: 's1', event: 'Stop' })
    const restarted = new CompanionService(service['options'])

    await expect(restarted.route(METHOD_REGISTRY.hookObservationGet, {
      sessionId: 's1', incarnationId: 'incarnation-1'
    })).resolves.toEqual({ state: 'none', sessionId: 's1', incarnationId: 'incarnation-1' })
  })

  it('does not count an event no incarnation can be named for', async () => {
    await observe({ sessionId: 's1', incarnationId: null, event: 'Stop' })

    await expect(observation({ sessionId: 's1', incarnationId: 'incarnation-1' })).resolves.toEqual({
      state: 'none', sessionId: 's1', incarnationId: 'incarnation-1'
    })
  })

  it('requires a session to read', async () => {
    await expect(observation({})).rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })
    await expect(observation({ sessionId: '' })).rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })
  })
})

describe('model origins', () => {
  const observe = async (params: {
    sessionId: string
    incarnationId?: string | null
    agent?: HookEventRecord['agent']
    event: string
    toolName?: string
    source?: string
    apiHost?: string
    model?: string
  }): Promise<void> => {
    const { sessionId, incarnationId = liveIncarnations.get(sessionId) ?? null, agent = 'claude', event } = params
    await (service as unknown as {
      observeHookEvent(p: {
        sessionId: string
        incarnationId: string | null
        agent: HookEventRecord['agent']
        event: string
        source: string | null
        toolName: string | null
        apiHost?: string
        model?: string
        effects: readonly HookEventRecord['effects'][number][]
      }): unknown
    }).observeHookEvent({
      sessionId,
      incarnationId,
      agent,
      event,
      source: params.source ?? null,
      toolName: params.toolName ?? null,
      ...(params.apiHost === undefined ? {} : { apiHost: params.apiHost }),
      ...(params.model === undefined ? {} : { model: params.model }),
      effects: []
    })
  }

  const origins = () =>
    service.route(METHOD_REGISTRY.hookOriginsList, {}) as Promise<HookOriginRecord[]>

  it('classifies the reported host and serves it as one list read', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', apiHost: 'api.z.ai', model: 'GLM-5.3' })

    await expect(origins()).resolves.toEqual([{
      state: 'observed',
      sessionId: 's1',
      incarnationId: 'incarnation-1',
      agent: 'claude',
      country: 'CN',
      model: 'GLM-5.3',
      apiHost: 'api.z.ai',
      observedAt: now
    }])
  })

  it('publishes a hooks invalidation when what the window shows changes, not for repeats or terminal notices', async () => {
    await observe({ sessionId: 's1', event: 'Notification', apiHost: 'api.z.ai' })
    await observe({ sessionId: 's1', event: 'PostToolUse', apiHost: 'api.z.ai' })
    await observe({ sessionId: 's1', agent: 'terminal', event: 'osc:9' })
    clock = '2026-09-14T12:00:05.000Z'
    await observe({ sessionId: 's1', event: 'Stop', apiHost: 'api.z.ai', model: 'GLM-5.3' })

    const hookTopics = emitted.filter((message) => message.topic === 'hooks')
    expect(hookTopics).toEqual([
      { kind: 'app-event', topic: 'hooks', sessionId: 's1' },
      { kind: 'app-event', topic: 'hooks', sessionId: 's1' }
    ])
    // The record's time still follows the latest event.
    await expect(origins()).resolves.toMatchObject([{ observedAt: '2026-09-14T12:00:05.000Z' }])
  })

  it('falls back to the agent default when no host was reported', async () => {
    await observe({ sessionId: 's2', agent: 'codex', event: 'Stop' })

    await expect(origins()).resolves.toMatchObject([{
      sessionId: 's2', agent: 'codex', country: 'US', model: null, apiHost: null
    }])
  })

  it('keeps an unclassifiable origin as a record with no country, never a guess', async () => {
    await observe({ sessionId: 's1', event: 'Stop', apiHost: 'llm.internal.example', model: 'custom-tuned' })

    await expect(origins()).resolves.toMatchObject([{ sessionId: 's1', country: null, model: 'custom-tuned' }])
  })

  it('keeps the same agent\'s last model when later events carry none, and compaction keeps it too', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'startup', apiHost: 'openrouter.ai', model: 'moonshotai/kimi-k2' })
    await observe({ sessionId: 's1', event: 'PostToolUse', toolName: 'Bash', apiHost: 'openrouter.ai' })
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'compact', apiHost: 'openrouter.ai' })

    await expect(origins()).resolves.toMatchObject([{
      sessionId: 's1', country: 'CN', model: 'moonshotai/kimi-k2', apiHost: 'openrouter.ai'
    }])
  })

  it('never carries the host: the CLI reads it for every event, so absent means unset now', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'startup', apiHost: 'api.z.ai', model: 'claude-opus-4-5' })
    await observe({ sessionId: 's1', event: 'PostToolUse', toolName: 'Bash' })

    await expect(origins()).resolves.toMatchObject([{ country: 'US', model: 'claude-opus-4-5', apiHost: null }])
  })

  it('starts from its own report when another agent, or a new session, takes over the shell', async () => {
    // `claude glm` killed without a SessionEnd, then plain Claude in the same shell.
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'startup', apiHost: 'api.z.ai', model: 'glm-5.3' })
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'startup' })
    await expect(origins()).resolves.toMatchObject([{ agent: 'claude', country: 'US', model: null, apiHost: null }])

    // Then Codex: nothing from the Claude run speaks for it.
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'startup', model: 'kimi-k2' })
    await observe({ sessionId: 's1', agent: 'codex', event: 'Stop' })
    await expect(origins()).resolves.toMatchObject([{ agent: 'codex', country: 'US', model: null, apiHost: null }])
  })

  it('replaces the facts when a new event reports different ones', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', apiHost: 'api.z.ai', model: 'GLM-5.3' })
    clock = '2026-09-14T12:00:05.000Z'
    await observe({ sessionId: 's1', event: 'SessionStart', apiHost: 'api.mistral.ai', model: 'mistral-large-2' })

    await expect(origins()).resolves.toMatchObject([{
      sessionId: 's1', country: 'FR', model: 'mistral-large-2', apiHost: 'api.mistral.ai',
      observedAt: '2026-09-14T12:00:05.000Z'
    }])
  })

  it('drops the origin when the agent ends, leaving its shell unflagged until the next agent reports', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', apiHost: 'api.z.ai', model: 'GLM-5.3' })
    await observe({ sessionId: 's1', event: 'SessionEnd' })

    await expect(origins()).resolves.toEqual([])
    expect(emitted.filter((message) => message.topic === 'hooks')).toHaveLength(2)

    await observe({ sessionId: 's1', agent: 'codex', event: 'SessionStart' })
    await expect(origins()).resolves.toMatchObject([{ sessionId: 's1', agent: 'codex', country: 'US', apiHost: null }])
  })

  it('leaves the newer agent\'s flag when an earlier agent\'s SessionEnd arrives late', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', source: 'startup', apiHost: 'api.z.ai' })
    await observe({ sessionId: 's1', agent: 'codex', event: 'SessionStart', source: 'startup', model: 'gpt-5.5' })
    await observe({ sessionId: 's1', event: 'SessionEnd' })

    await expect(origins()).resolves.toMatchObject([{ agent: 'codex', country: 'US', model: 'gpt-5.5' }])
  })

  it('carries nothing across an incarnation boundary', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', apiHost: 'api.z.ai', model: 'GLM-5.3' })
    liveIncarnations.set('s1', 'incarnation-9')
    await observe({ sessionId: 's1', event: 'PostToolUse' })

    await expect(origins()).resolves.toMatchObject([{
      sessionId: 's1', incarnationId: 'incarnation-9', country: 'US', model: null, apiHost: null
    }])
  })

  it('ignores a late event from an incarnation the host has already replaced', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', apiHost: 'api.mistral.ai' })
    liveIncarnations.set('s1', 'incarnation-2')

    await observe({ sessionId: 's1', incarnationId: 'incarnation-1', event: 'Stop', apiHost: 'api.z.ai' })

    await expect(origins()).resolves.toMatchObject([{ sessionId: 's1', country: 'FR', incarnationId: 'incarnation-1' }])
  })

  it('starts a fresh service with no origins from the earlier process', async () => {
    await observe({ sessionId: 's1', event: 'SessionStart', apiHost: 'api.z.ai' })
    const restarted = new CompanionService(service['options'])

    await expect(restarted.route(METHOD_REGISTRY.hookOriginsList, {})).resolves.toEqual([])
  })
})

describe('terminal notices (OSC 9, 99, 777)', () => {
  const notice = (params: Record<string, unknown>): Promise<unknown> =>
    service.route(METHOD_REGISTRY.attentionTerminalNotice, {
      sessionId: 's1',
      incarnationId: 'incarnation-1',
      code: 9,
      title: 'Build finished',
      ...params
    })

  const observeHook = async (sessionId: string, incarnationId: string | null): Promise<void> => {
    await (service as unknown as {
      observeHookEvent(p: {
        sessionId: string
        incarnationId: string | null
        agent: HookEventRecord['agent']
        event: string
        source: string | null
        toolName: string | null
        effects: readonly HookEventRecord['effects'][number][]
      }): unknown
    }).observeHookEvent({
      sessionId,
      incarnationId,
      agent: 'claude',
      event: 'Stop',
      source: null,
      toolName: null,
      effects: ['opened']
    })
  }

  const openRows = async (): Promise<AttentionRecord[]> =>
    (await service.route(METHOD_REGISTRY.attentionList, {}) as AttentionRecord[])
      .filter((record) => record.state === 'open')

  it('opens one notice with the terminal as its origin, and writes nothing to the session', async () => {
    await service.sessionsChanged()

    const result = await notice({ body: 'three warnings' })
    const [row, ...extra] = await openRows()

    expect(result).toMatchObject({ opened: true, requestKey: 'osc:9' })
    expect(extra).toEqual([])
    expect(row).toMatchObject({
      sessionId: 's1',
      kind: 'notice',
      requestKey: 'osc:9',
      title: 'Build finished',
      body: 'three warnings',
      openedBy: 'osc:9'
    })
    expect(writes).toEqual([])
  })

  it('logs the notice as the terminal, so the hook log still explains what arrived', async () => {
    await service.sessionsChanged()

    await notice({ code: 777, title: 'Deploy' })
    const log = await service.route(METHOD_REGISTRY.hookEventsList, { sessionId: 's1' }) as HookEventRecord[]

    expect(log).toEqual([expect.objectContaining({ agent: 'terminal', event: 'osc:777', effects: ['opened'] })])
  })

  it('opens nothing for a session whose harness reported a hook this incarnation, and says so in the log', async () => {
    await service.sessionsChanged()
    await observeHook('s1', 'incarnation-1')

    const result = await notice({})
    const log = await service.route(METHOD_REGISTRY.hookEventsList, { sessionId: 's1' }) as HookEventRecord[]

    expect(result).toMatchObject({ opened: false })
    expect(await openRows()).toEqual([])
    expect(log.at(-1)).toMatchObject({ agent: 'terminal', event: 'osc:9', effects: [] })
  })

  it('opens the notice when the only hook events belong to a previous incarnation', async () => {
    await service.sessionsChanged()
    await observeHook('s1', 'incarnation-0')

    const result = await notice({})

    expect(result).toMatchObject({ opened: true })
    expect(await openRows()).toHaveLength(1)
  })

  it('appends further notices of any code to the open row instead of opening a second one', async () => {
    await service.sessionsChanged()

    await notice({ title: 'First' })
    await notice({ code: 777, title: 'Second', body: 'more' })
    await notice({ code: 99, title: 'Third' })
    const rows = await openRows()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ requestKey: 'osc:9', title: 'First' })
    expect(rows[0]?.body).toBe('Second\nmore\nThird')
  })

  it('opens a fresh row once the coalescing window has passed, replacing the text of the same key', async () => {
    await service.sessionsChanged()
    let clock = Date.parse(now)
    ;(service as unknown as { now(): Date }).now = () => new Date(clock)

    await notice({ title: 'First' })
    clock += TERMINAL_NOTICE_WINDOW_MS
    await notice({ title: 'Later' })
    const rows = await openRows()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ requestKey: 'osc:9', title: 'Later' })
    expect(rows[0]?.body).toBeNull()
  })

  it('measures the window from the row it opened, so a steady trickle cannot hold it open forever', async () => {
    await service.sessionsChanged()
    let clock = Date.parse(now)
    ;(service as unknown as { now(): Date }).now = () => new Date(clock)

    await notice({ title: 'First' })
    // Inside the window, so this joins the row. If the window rolled, it would also extend it.
    clock += TERMINAL_NOTICE_WINDOW_MS - 1
    await notice({ title: 'Second' })
    clock += 2
    await notice({ title: 'Third' })
    const rows = await openRows()

    expect(rows).toHaveLength(1)
    // The third is past two seconds from the row opening, so it interrupts afresh rather than
    // appending: the body the trickle had built up is gone, replaced by the newest word alone.
    expect(rows[0]).toMatchObject({ title: 'Third' })
    expect(rows[0]?.body).toBeNull()
  })

  it('starts a new row rather than reopening one the owner already answered', async () => {
    await service.sessionsChanged()
    await notice({ title: 'First' })
    const [opened] = await openRows()
    await service.route(METHOD_REGISTRY.attentionResolve, { requestId: opened?.requestId, resolution: 'read' })

    await notice({ title: 'Second' })
    const rows = await openRows()

    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('Second')
    expect(rows[0]?.requestId).not.toBe(opened?.requestId)
  })

  it('refuses a notice for another process, an unknown session and an unknown sequence', async () => {
    await service.sessionsChanged()

    await expect(notice({ incarnationId: 'incarnation-gone' })).rejects.toThrow(/different process/)
    await expect(notice({ sessionId: 'nobody' })).rejects.toThrow(/unknown/)
    await expect(notice({ code: 8 })).rejects.toThrow(/BMN reads/)
    expect(await openRows()).toEqual([])
  })

  it('keeps suppressing after the diagnostic log has been filled with suppressed notices', async () => {
    await service.sessionsChanged()
    await observeHook('s1', 'incarnation-1')

    // The hook event log holds 30 entries; each suppressed notice adds one, so reading suppression
    // out of that log would let the hook fall off the end and switch suppression back on.
    for (let index = 0; index < HOOK_EVENT_LOG_LIMIT + 5; index += 1) await notice({ title: `n${index}` })
    const log = await service.route(METHOD_REGISTRY.hookEventsList, { sessionId: 's1' }) as HookEventRecord[]

    expect(await openRows()).toEqual([])
    expect(log.some((entry) => entry.agent === 'claude')).toBe(false)
    expect(await notice({ title: 'still suppressed' })).toMatchObject({ opened: false })
  })

  it('adds a coalesced line without a second interruption: same revision, and what was seen stays seen', async () => {
    await service.sessionsChanged()
    // The two surfaces that actually interrupt the owner, counted rather than inferred: the pager
    // is what sends a Telegram page, and the desktop notifier keys on requestId:revision.
    const pager = service['pager'] as { opened(record: AttentionRecord): void }
    const paged: string[] = []
    pager.opened = (record) => { paged.push(`${record.requestId}:${record.revision}`) }
    await notice({ title: 'First' })
    const [opened] = await openRows()
    await service.route(METHOD_REGISTRY.attentionSeen, { requestId: opened?.requestId })

    await notice({ title: 'Second' })
    const [after] = await openRows()

    // One page and one desktop notification key for the pair, not two.
    expect(paged).toEqual([`${opened?.requestId}:${opened?.revision}`])

    expect(after?.requestId).toBe(opened?.requestId)
    // The desktop notifier keys on requestId:revision and the pending Telegram page refuses a
    // revision that moved, so a bumped revision would mean a second pop-up and no page at all.
    expect(after?.revision).toBe(opened?.revision)
    expect(after?.seenAt).not.toBeNull()
    expect(after?.body).toBe('Second')
  })

  it('opens one row for two notices that arrive together', async () => {
    await service.sessionsChanged()

    const [first, second] = await Promise.all([notice({ code: 9, title: 'A' }), notice({ code: 777, title: 'B' })])
    const rows = await openRows()

    expect(rows).toHaveLength(1)
    expect([first, second].filter((result) => (result as { opened: boolean }).opened)).toHaveLength(2)
    expect(rows[0]?.body).toContain('B')
  })

  it('drops the lines the owner has already read rather than the newest one, and clips the body', async () => {
    await service.sessionsChanged()
    const long = 'x'.repeat(3000)

    await notice({ title: 'first', body: long })
    await notice({ title: 'second', body: long })
    await notice({ title: 'third', body: long })
    const rows = await openRows()

    const body = rows[0]?.body ?? ''
    expect(body.length).toBeLessThanOrEqual(TERMINAL_NOTICE_BODY_MAX)
    // The newest line is the one that has not been read yet, so it is the one that survives.
    expect(body).toContain('third')
    expect(body).not.toContain('first')
  })

  it('gives a restarted program its own row instead of a line under the last run', async () => {
    await service.sessionsChanged()
    await notice({ title: 'Before the restart' })
    const [before] = await openRows()
    // The program is restarted inside the coalescing window; the window belongs to the run, not the clock.
    liveIncarnations.set('s1', 'incarnation-restarted')

    await notice({ incarnationId: 'incarnation-restarted', title: 'After the restart' })
    const rows = await openRows()

    // The new run's word replaces the old one the way an expired window does, rather than being
    // appended silently under it: a restart is a fresh interruption, not more of the last one.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ requestKey: 'osc:9', title: 'After the restart' })
    expect(rows[0]?.body).toBeNull()
    expect(rows[0]?.revision).toBeGreaterThan(before?.revision ?? 0)
  })

  it('forgets a deleted session rather than keeping its notice and hook state for ever', async () => {
    await service.sessionsChanged()
    await observeHook('s1', 'incarnation-1')
    await (service as unknown as { observeHookEvent(p: unknown): Promise<unknown> }).observeHookEvent({
      sessionId: 's1', incarnationId: 'incarnation-1', agent: 'claude', event: 'SessionStart', source: 'compact',
      toolName: null, effects: []
    })
    await notice({ sessionId: 's2', incarnationId: 'incarnation-2', title: 'Still open' })
    const kept = service as unknown as {
      hookReporters: Map<string, unknown>; hookObservations: Map<string, unknown>; terminalNotices: Map<string, unknown>
      hookCompactions: Map<string, unknown>
    }
    expect([kept.hookReporters.size, kept.hookObservations.size, kept.terminalNotices.size, kept.hookCompactions.size])
      .toEqual([1, 1, 1, 1])

    database.prepare("DELETE FROM attention_request WHERE session_id IN ('s1', 's2')").run()
    database.prepare("DELETE FROM session WHERE session_id IN ('s1', 's2')").run()
    await service.sessionsChanged()

    // These are in memory and per session, so a long-lived app must not accumulate one entry per
    // session it has ever had. They are pruned with the hook log, on the same pass.
    expect([kept.hookReporters.size, kept.hookObservations.size, kept.terminalNotices.size, kept.hookCompactions.size])
      .toEqual([0, 0, 0, 0])
    await expect(service.route(METHOD_REGISTRY.hookObservationGet, {
      sessionId: 's1', incarnationId: 'incarnation-1'
    })).resolves.toEqual({ state: 'none', sessionId: 's1', incarnationId: 'incarnation-1' })
  })

  it('drops a notice whose process ended while it waited behind another one', async () => {
    await service.sessionsChanged()
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    const database = service['options'].database as { companion: (op: string, ...rest: unknown[]) => Promise<unknown> }
    const companion = database.companion.bind(database)
    // The first notice is held open, so the second is still queued when the process is replaced.
    database.companion = async (op, ...rest) => {
      if (op === 'openAttention') await held
      return companion(op, ...rest)
    }
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    const first = notice({ title: 'First' })
    await tick()
    const second = notice({ title: 'Second' })
    await tick()
    liveIncarnations.set('s1', 'incarnation-replaced')
    release()
    const results = [await first, await second]
    database.companion = companion

    // The door checked the incarnation before either was queued; only the second waited long enough
    // for it to change, and it must not speak for the process that replaced its own.
    expect(results[0]).toMatchObject({ opened: true })
    expect(results[1]).toMatchObject({ opened: false, reason: 'the session is running a different process now' })
    expect((await openRows()).map((row) => row.title)).toEqual(['First'])
  })

  it('never lets a session token claim a terminal origin on a request of its own', () => {
    for (const origin of ['osc:9', 'osc:99', 'osc:777']) {
      expect(isAttentionOrigin(origin)).toBe(true)
      expect((AGENT_ATTENTION_ORIGINS as readonly string[]).includes(origin)).toBe(false)
    }
  })
})

describe('repeat watch notices and calibration', () => {
  const observe = (params: Partial<Parameters<CompanionService['observeHookEvent']>[0]> = {}) =>
    service['observeHookEvent']({ sessionId: 's1', incarnationId: 'incarnation-1', agent: 'claude',
      event: 'PostToolUse', source: null, toolName: 'Bash', fingerprint: 'aaaaaaaaaaaaaaaa', effects: [], ...params })
  const calls = async (count: number) => { for (let i = 0; i < count; i++) await observe() }
  const reset = (event = 'Interrupt') => observe({ event, fingerprint: undefined })
  const rows = () => service.route(METHOD_REGISTRY.attentionList, {}) as Promise<AttentionRecord[]>

  it('opens exactly once at eight, records the successful effect, and never writes to the PTY', async () => {
    await service.sessionsChanged()
    await calls(7)
    expect(await rows()).toHaveLength(0)
    await calls(1)
    expect(await rows()).toEqual([expect.objectContaining({ requestKey: 'watch:repeat', kind: 'notice',
      openedBy: 'watch:repeat', title: 'One repeated the same Bash call 8 times',
      body: 'BMN counted identical calls since your last message. It did not stop or change anything.' })])
    expect(service.listHookEvents('s1').at(-1)).toMatchObject({ repeat: 8, effects: ['opened'] })
    await calls(12)
    expect(await rows()).toHaveLength(1)
    expect(service.listHookEvents('s1').filter((row) => row.effects.includes('opened'))).toHaveLength(1)
    expect(JSON.stringify(service.listHookEvents('s1'))).not.toContain('aaaaaaaaaaaaaaaa')
    expect(writes).toEqual([])
  })

  it('keeps an open notice across reset, then permits another after owner input withdraws it', async () => {
    await service.sessionsChanged()
    await calls(8)
    const original = (await rows())[0]!.requestId
    await reset()
    await calls(8)
    expect((await rows())[0]!.requestId).toBe(original)
    await reset('UserPromptSubmit')
    expect((await rows())[0]).toMatchObject({ state: 'withdrawn', resolvedBy: 'hook:claude:UserPromptSubmit' })
    await calls(8)
    const all = await rows()
    expect(all.filter((row) => row.state === 'open')).toHaveLength(1)
    expect(all.find((row) => row.state === 'open')!.requestId).not.toBe(original)
  })

  it('writes only calibration fields on qualifying resets, with successful notification status', async () => {
    await service.sessionsChanged()
    await calls(2)
    await reset()
    await expect(readFile(join(root, 'state/repeat-watch.log'))).rejects.toMatchObject({ code: 'ENOENT' })
    await calls(3)
    await reset()
    await calls(8)
    await reset()
    const lines = (await readFile(join(root, 'state/repeat-watch.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { at: now, agent: 'claude', sessionId: 's1', toolName: 'Bash', maxRepeat: 3, toolEvents: 3, notified: false },
      { at: now, agent: 'claude', sessionId: 's1', toolName: 'Bash', maxRepeat: 8, toolEvents: 8, notified: true }
    ])
  })

  it('records original effects when the notice fails and does not retry within the segment', async () => {
    await service.sessionsChanged()
    const open = vi.spyOn(service as unknown as { openAttention: () => Promise<AttentionRecord> }, 'openAttention')
      .mockRejectedValue(new Error('store failed'))
    await calls(8)
    expect(service.listHookEvents('s1').at(-1)).toMatchObject({ repeat: 8, effects: [] })
    await calls(12)
    expect(open).toHaveBeenCalledTimes(1)
    await reset()
    expect(JSON.parse((await readFile(join(root, 'state/repeat-watch.log'), 'utf8')).trim()).notified).toBe(false)
  })

  it('does not claim an opened effect when the store reports an unchanged request', async () => {
    await service.sessionsChanged()
    vi.spyOn(service as unknown as { openAttention: () => Promise<AttentionRecord & { changed: boolean }> }, 'openAttention')
      .mockResolvedValue({ changed: false } as AttentionRecord & { changed: boolean })
    await calls(8)
    expect(service.listHookEvents('s1').at(-1)).toMatchObject({ repeat: 8, effects: [] })
    await reset()
    expect(JSON.parse((await readFile(join(root, 'state/repeat-watch.log'), 'utf8')).trim()).notified).toBe(false)
  })

  it('waits for the open before recording its effect and queues a prompt behind it', async () => {
    await service.sessionsChanged()
    await calls(7)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const actual = service['openAttention'].bind(service)
    vi.spyOn(service as unknown as { openAttention: typeof actual }, 'openAttention')
      .mockImplementation(async (params) => { await held; return actual(params) })
    const eighth = observe()
    const prompt = reset('UserPromptSubmit')
    await new Promise((resolve) => setImmediate(resolve))
    expect(service.listHookEvents('s1')).toHaveLength(7)
    release()
    await Promise.all([eighth, prompt])
    expect(service.listHookEvents('s1').slice(-2).map((row) => row.effects)).toEqual([['opened'], ['withdrew']])
    expect((await rows())[0]?.state).toBe('withdrawn')
  })

  it('records a prompt when the owner resolves the repeat notice before its hook withdrawal', async () => {
    await service.sessionsChanged()
    await calls(8)
    const request = (await rows()).find((row) => row.requestKey === 'watch:repeat')!
    const databaseClient = service['options'].database as {
      companion: (op: string, ...args: unknown[]) => Promise<unknown>
    }
    const companion = databaseClient.companion.bind(databaseClient)
    let raced = false
    databaseClient.companion = async (op, ...args) => {
      if (!raced && op === 'closeAttention' &&
        (args[0] as { requestKey?: string }).requestKey === 'watch:repeat') {
        raced = true
        await service.route(METHOD_REGISTRY.attentionResolve, {
          requestId: request.requestId, resolution: 'read'
        })
      }
      return companion(op, ...args)
    }
    try {
      await expect(observe({ event: 'UserPromptSubmit', fingerprint: undefined,
        effects: ['answered'] })).resolves.toEqual({ recorded: true })
    } finally {
      databaseClient.companion = companion
    }
    expect(raced).toBe(true)
    expect((await rows())[0]).toMatchObject({ state: 'answered' })
    expect(service.listHookEvents('s1').at(-1)).toMatchObject({ event: 'UserPromptSubmit', effects: ['answered'] })
  })

  it('records the firing call when the repeat watch store lookup fails', async () => {
    await service.sessionsChanged()
    await calls(7)
    const databaseClient = service['options'].database as {
      companion: (op: string, ...args: unknown[]) => Promise<unknown>
    }
    const companion = databaseClient.companion.bind(databaseClient)
    databaseClient.companion = async (op, ...args) => {
      if (op === 'listAttention') throw new Error('store failed')
      return companion(op, ...args)
    }
    try {
      await expect(observe()).resolves.toEqual({ recorded: true })
    } finally {
      databaseClient.companion = companion
    }
    expect(service.listHookEvents('s1').at(-1)).toMatchObject({ repeat: 8 })
    expect(service.listHookEvents('s1').at(-1)!.effects).not.toContain('opened')
  })

  it('records a prompt when the store lookup fails before its hook withdrawal', async () => {
    await service.sessionsChanged()
    await calls(8)
    expect((await rows()).filter((row) => row.state === 'open')).toHaveLength(1)
    const databaseClient = service['options'].database as {
      companion: (op: string, ...args: unknown[]) => Promise<unknown>
    }
    const companion = databaseClient.companion.bind(databaseClient)
    databaseClient.companion = async (op, ...args) => {
      if (op === 'listAttention') throw new Error('store failed')
      return companion(op, ...args)
    }
    try {
      await expect(observe({ event: 'UserPromptSubmit', fingerprint: undefined })).resolves.toEqual({ recorded: true })
    } finally {
      databaseClient.companion = companion
    }
    expect(service.listHookEvents('s1').at(-1)).toMatchObject({ event: 'UserPromptSubmit', repeat: null })
    expect(service.listHookEvents('s1').at(-1)!.effects).not.toContain('withdrew')
    expect((await rows()).filter((row) => row.state === 'open')).toHaveLength(1)
  })

  it('bounds calibration by keeping complete newest lines and clears deleted session state', async () => {
    await service.sessionsChanged()
    const path = join(root, 'state/repeat-watch.log')
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(path, `${JSON.stringify({ old: 'x'.repeat(100) })}\n`.repeat(2400), { mode: 0o600 })
    await calls(3)
    await reset()
    const content = await readFile(path, 'utf8')
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(128 * 1024)
    expect(content.trim().split('\n').every((line) => typeof JSON.parse(line) === 'object')).toBe(true)
    expect(JSON.parse(content.trim().split('\n').at(-1)!)).toMatchObject({ maxRepeat: 3 })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await calls(2)
    database.prepare("DELETE FROM session WHERE session_id = 's1'").run()
    await service.sessionsChanged()
    expect(service['repeatStates'].has('s1')).toBe(false)
    expect(service.listHookEvents('s1')).toEqual([])
  })

  it('serializes concurrent observations before withdrawal and keeps sessions independent', async () => {
    await service.sessionsChanged()
    await Promise.all(Array.from({ length: 8 }, () => observe()))
    await reset('UserPromptSubmit')
    expect((await rows()).filter((row) => row.state === 'open')).toHaveLength(0)
    expect(service.listHookEvents('s1').map((row) => row.repeat)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, null])
    await observe({ sessionId: 's2', incarnationId: 'incarnation-2', agent: 'codex' })
    expect(service.listHookEvents('s2')[0]?.repeat).toBe(1)
  })
})

describe('answers from the phone go only into the dialog that asked (Epic 30.2)', () => {
  const SCREENS = join(__dirname, 'test-fixtures', 'remote-answers', 'screens')
  const screenOf = (name: string): string[] => readFileSync(join(SCREENS, name), 'utf8').split('\n')
  class FakeScreen implements ScreenLike {
    private readonly listeners = new Set<() => void>()
    constructor(private current: string[]) {}
    lines(): string[] { return this.current }
    settled(): Promise<void> { return Promise.resolve() }
    onChange(listener: () => void): () => void {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }
    show(lines: string[]): void {
      this.current = lines
      for (const listener of [...this.listeners]) listener()
    }
  }
  const bash = {
    sessionId: 's1', incarnationId: 'incarnation-1', requestKey: 'claude:permission', kind: 'permission' as const,
    title: 'Claude wants to use Bash', origin: 'hook:claude:PermissionRequest',
    prompt: {
      type: 'permission' as const, harness: 'claude' as const, shape: 'permission' as const, requestRef: null, toolUseId: null,
      tool: 'Bash', command: 'touch spike-allow.txt', cwd: '/work/project', description: 'Create spike-allow.txt file'
    }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200))
  const allowPermissions = async () => {
    await database.transaction(() => COMPANION_OPERATIONS.putSettingsSection(database, 'telegram', {
      enabled: false, allowedChatId: null, allowedUserId: null, notifyOn: 'attention-and-exit', autoSubmitReplies: false,
      answerPermissions: true
    }, new Date().toISOString()))()
  }
  const keys = () => writes.map((write) => new TextDecoder().decode(write.bytes))

  it('refuses an allow for A while an identical successor prompt B is on screen (RED first)', async () => {
    await allowPermissions()
    const screen = new FakeScreen(screenOf('claude-bash-permission.txt'))
    screens.set('s1', screen)
    const first = await service['openAttention'](bash)
    await settle()
    const card = { requestId: first.requestId, revision: first.revision, epoch: service.answerEpoch(first.requestId)!, incarnationId: 'incarnation-1' }
    // The owner denies A at the laptop (no hook fires), then Claude asks the very same command again.
    screen.show(screenOf('claude-bash-denied.txt'))
    await settle()
    const second = await service['openAttention'](bash)
    screen.show(screenOf('claude-bash-permission.txt'))
    await settle()
    // To the store B is A: same request, same revision. Only the epoch tells them apart.
    expect([second.requestId, second.revision, second.changed]).toEqual([first.requestId, first.revision, false])
    const outcome = service.answerAttention({ ...card, answer: { type: 'permission', decision: 'allow' } })
    await settle()
    expect(keys()).toEqual([])
    await expect(outcome).resolves.toEqual({ state: 'refused', reason: 'changed' })
  })

  it('closes the request as answered from Telegram when the harness reports exactly the answer sent', async () => {
    await allowPermissions()
    screens.set('s1', new FakeScreen(screenOf('claude-bash-permission.txt')))
    const opened = await service['openAttention'](bash)
    const outcome = service.answerAttention({
      requestId: opened.requestId, revision: opened.revision, epoch: service.answerEpoch(opened.requestId)!,
      incarnationId: 'incarnation-1', answer: { type: 'permission', decision: 'allow' }
    })
    await settle()
    expect(keys()).toEqual(['1'])
    const closed = await service['closeAttentionByKey']('s1', 'claude:permission', 'answered', 'answered in the terminal', 'hook:claude:PostToolUse', {
      toolUseId: 'toolu_x', requestRef: null, answers: null, permission: 'allowed', tool: 'Bash', command: 'touch spike-allow.txt'
    })
    expect(closed).toMatchObject({ state: 'answered', resolvedBy: 'telegram', resolution: 'Answered from Telegram' })
    await expect(outcome).resolves.toEqual({ state: 'confirmed', sent: ['Allow once'] })
  })

  it('keeps the hook as the answerer when its report names a different answer', async () => {
    await allowPermissions()
    screens.set('s1', new FakeScreen(screenOf('claude-bash-permission.txt')))
    await service['openAttention'](bash)
    const closed = await service['closeAttentionByKey']('s1', 'claude:permission', 'answered', 'answered in the terminal', 'hook:claude:PostToolUse', {
      toolUseId: 'toolu_x', requestRef: null, answers: null, permission: 'allowed', tool: 'Bash', command: 'touch spike-allow.txt'
    })
    expect(closed).toMatchObject({ resolvedBy: 'hook:claude:PostToolUse', resolution: 'answered in the terminal' })
  })

  it('closes a Claude deny it could not confirm, saying so, because no hook will', async () => {
    await allowPermissions()
    screens.set('s1', new FakeScreen(screenOf('claude-bash-permission.txt')))
    const opened = await service['openAttention'](bash)
    await expect(service.answerAttention({
      requestId: opened.requestId, revision: opened.revision, epoch: service.answerEpoch(opened.requestId)!,
      incarnationId: 'incarnation-1', answer: { type: 'permission', decision: 'deny' }
    })).resolves.toEqual({ state: 'sent-unconfirmed', sent: ['Deny'] })
    expect(keys()).toEqual(['3'])
    expect(COMPANION_OPERATIONS.getAttention(database, opened.requestId)).toMatchObject({
      state: 'answered', resolvedBy: 'telegram', resolution: 'Deny sent from Telegram, not confirmed'
    })
  })

  it('credits the phone when OpenCode confirms its answer after a busy report already closed the question', async () => {
    const question = {
      sessionId: 's1', incarnationId: 'incarnation-1', requestKey: 'opencode:question', kind: 'question' as const,
      title: 'OpenCode asks', origin: 'hook:opencode:question.asked',
      prompt: {
        type: 'questions' as const, harness: 'opencode' as const, shape: 'choice' as const, requestRef: 'que_1', toolUseId: null,
        questions: [{ id: null, header: 'Auth', text: 'Which auth?', multiSelect: false,
          options: [{ label: 'JWT', description: null }, { label: 'Cookies', description: null }] }]
      }
    }
    const opened = await service['openAttention'](question)
    const outcome = service.answerAttention({
      requestId: opened.requestId, revision: opened.revision, epoch: service.answerEpoch(opened.requestId)!,
      incarnationId: 'incarnation-1', answer: { type: 'choices', choices: [1] }
    })
    await expect(service['answers'].take('s1', 'incarnation-1', 1_000))
      .resolves.toEqual([{ requestRef: 'que_1', kind: 'question', answers: [['Cookies']] }])
    // OpenCode's busy report can land before its replied event and close the slot first.
    await service['closeAttentionByKey']('s1', 'opencode:question', 'answered', 'answered in the terminal', 'hook:opencode:session.status')
    await expect(service['closeAttentionByKey']('s1', 'opencode:question', 'answered', 'answered in the terminal',
      'hook:opencode:question.replied',
      { toolUseId: null, requestRef: 'que_1', answers: [['Cookies']], permission: null, tool: null, command: null }))
      .rejects.toMatchObject({ code: ERROR_CODES.notFound })
    await expect(outcome).resolves.toEqual({ state: 'confirmed', sent: ['Cookies'] })
    expect(COMPANION_OPERATIONS.getAttention(database, opened.requestId)).toMatchObject({
      state: 'answered', resolvedBy: 'telegram', resolution: 'Answered from Telegram'
    })
  })

  it('leaves an OpenCode permission open when the report is about another request of the same slot', async () => {
    const opencode = {
      sessionId: 's1', incarnationId: 'incarnation-1', requestKey: 'opencode:permission', kind: 'permission' as const,
      title: 'OpenCode asks to bash',
      prompt: { type: 'permission' as const, harness: 'opencode' as const, shape: 'permission' as const, requestRef: 'per_2', toolUseId: null, tool: 'bash', command: 'touch b', cwd: null }
    }
    const opened = await service['openAttention'](opencode)
    const cascade = { toolUseId: null, requestRef: 'per_1', answers: null, permission: 'denied' as const, tool: null, command: null }
    await expect(service['closeAttentionByKey']('s1', 'opencode:permission', 'withdrawn', null, 'hook:opencode:permission.replied', cascade))
      .rejects.toMatchObject({ code: ERROR_CODES.notFound })
    expect(COMPANION_OPERATIONS.getAttention(database, opened.requestId).state).toBe('open')
    await service['closeAttentionByKey']('s1', 'opencode:permission', 'withdrawn', null, 'hook:opencode:permission.replied', { ...cascade, requestRef: 'per_2' })
    expect(COMPANION_OPERATIONS.getAttention(database, opened.requestId).state).toBe('withdrawn')
  })

  it('starts a screen mirror only for an agent it can answer by keys, and stops it when the agent ends', async () => {
    const started: string[] = []
    const stopped: string[] = []
    const manager = service['options'].manager
    manager.screenMirror = (sessionId: string) => {
      started.push(sessionId)
      return undefined
    }
    manager.stopScreenMirror = (sessionId: string) => {
      stopped.push(sessionId)
    }
    const observe = (sessionId: string, incarnationId: string, agent: HookEventRecord['agent'], event: string) =>
      (service as unknown as { observeHookEvent(p: unknown): Promise<unknown> }).observeHookEvent({
        sessionId, incarnationId, agent, event, source: null, toolName: null, effects: []
      })
    await observe('s1', 'incarnation-1', 'claude', 'SessionStart')
    await observe('s2', 'incarnation-2', 'opencode', 'session.created')
    await observe('s2', 'incarnation-old', 'codex', 'SessionStart')
    await observe('s1', 'incarnation-1', 'claude', 'SessionEnd')
    expect(started).toEqual(['s1'])
    expect(stopped).toEqual(['s1'])
  })

  it('has no owner route, socket method or CLI command that reaches the answer function', () => {
    expect(Object.values(METHOD_REGISTRY).filter((method) => String(method).startsWith('answer'))).toEqual([])
    const server = readFileSync(join(__dirname, 'control-server.ts'), 'utf8')
    expect(server).not.toMatch(/answerAttention/)
    expect([...server.matchAll(/case '(answer\.[^']*)'/g)].map((match) => match[1])).toEqual(['answer.take'])
    const service = readFileSync(join(__dirname, 'companion-service.ts'), 'utf8')
    // The engine's answer is called from answerAttention alone; the owner route and socket handlers never name it.
    expect([...service.matchAll(/this\.answers\.answer\(/g)]).toHaveLength(1)
    const cli = readFileSync(join(__dirname, '..', '..', 'bin', 'bmn'), 'utf8')
    expect([...cli.matchAll(/method: '(answer\.[^']*)'/g)].map((match) => match[1])).toEqual(['answer.take'])
  })
})

describe('plan use (Story 37.2)', () => {
  const RESETS = '2026-09-14T16:10:00.000Z'
  const WEEK_RESETS = '2026-09-18T09:00:00.000Z'
  const report = (p: { sessionId?: string; incarnationId?: string; agent?: 'claude' | 'codex'; windows?: UsageWindow[]; contextUsedPercent?: number | null }) =>
    (service as unknown as { recordUsage(p: Omit<UsageReading, 'readAt'>): Promise<{ recorded: boolean }> }).recordUsage({
      sessionId: p.sessionId ?? 's1',
      incarnationId: p.incarnationId ?? liveIncarnations.get(p.sessionId ?? 's1') ?? 'none',
      agent: p.agent ?? 'claude',
      windows: p.windows ?? [],
      contextUsedPercent: p.contextUsedPercent ?? null
    })
  const usage = (sessionId: string) => service.route(METHOD_REGISTRY.usageGet, { sessionId }) as Promise<SessionUsage>
  const plans = () => service.route(METHOD_REGISTRY.usageList, {}) as Promise<UsageReading[]>
  const notices = async () => (await service.route(METHOD_REGISTRY.attentionList, {}) as AttentionRecord[])
    .filter((row) => row.requestKey.startsWith('usage:'))
  const observe = (sessionId: string, agent: HookEventRecord['agent'], event: string) =>
    (service as unknown as { observeHookEvent(p: object): Promise<unknown> }).observeHookEvent({
      sessionId, incarnationId: liveIncarnations.get(sessionId) ?? null, agent, event, source: null, toolName: null, effects: []
    })

  it('keeps each run\'s reading and each agent\'s plan reading; a reading with no windows keeps only its context use', async () => {
    const windows = [{ minutes: 300, usedPercent: 42, resetsAt: RESETS }, { minutes: 10_080, usedPercent: 18, resetsAt: WEEK_RESETS }]
    await expect(report({ windows, contextUsedPercent: 37 })).resolves.toEqual({ recorded: true })
    clock = '2026-09-14T12:01:00.000Z'
    // `claude glm` in another session: context use only, and Claude's plan reading stands.
    await report({ sessionId: 's2', contextUsedPercent: 12 })

    await expect(usage('s1')).resolves.toEqual({
      sessionId: 's1', incarnationId: 'incarnation-1', agent: null,
      reading: { sessionId: 's1', incarnationId: 'incarnation-1', agent: 'claude', windows, contextUsedPercent: 37, readAt: now }
    })
    await expect(usage('s2')).resolves.toMatchObject({ reading: { windows: [], contextUsedPercent: 12 } })
    await expect(plans()).resolves.toEqual([expect.objectContaining({ sessionId: 's1', agent: 'claude', windows })])
    await expect(notices()).resolves.toEqual([])
  })

  it('names the reporting harness when a run has no reading', async () => {
    await observe('s1', 'opencode', 'session.idle')
    await expect(usage('s1')).resolves.toEqual({ sessionId: 's1', incarnationId: 'incarnation-1', agent: 'opencode', reading: null })
  })

  it('forgets a replaced run\'s reading and ignores a late one from it', async () => {
    await report({ windows: [{ minutes: 300, usedPercent: 42, resetsAt: RESETS }] })
    liveIncarnations.set('s1', 'incarnation-9')

    await expect(usage('s1')).resolves.toMatchObject({ incarnationId: 'incarnation-9', reading: null })
    await expect(report({ incarnationId: 'incarnation-1', windows: [{ minutes: 300, usedPercent: 99, resetsAt: RESETS }] }))
      .resolves.toEqual({ recorded: false })
    await expect(notices()).resolves.toEqual([])
  })

  it('opens one notice per agent, window and reset period at 90%, and it expires when the window resets', async () => {
    const five = (usedPercent: number, resetsAt = RESETS) => report({ windows: [{ minutes: 300, usedPercent, resetsAt }] })
    await five(89)
    await five(89.4)
    await expect(notices()).resolves.toEqual([])

    await five(89.6)
    await five(91)
    await five(95)
    const opened = await notices()
    expect(opened).toEqual([expect.objectContaining({
      kind: 'notice', state: 'open', sessionId: 's1', openedBy: 'watch:usage', expiresAt: RESETS
    })])
    expect(opened[0]!.title).toMatch(/^Claude 5-hour limit at 90% · resets \S/)

    // Dismissed by the owner, it stays closed for the rest of this period.
    await service.route(METHOD_REGISTRY.attentionResolve, { requestId: opened[0]!.requestId })
    await five(97)
    await expect(notices()).resolves.toEqual([expect.objectContaining({ state: 'answered' })])

    // The weekly window of the same agent is its own notice, worded as a limit.
    await report({ windows: [{ minutes: 10_080, usedPercent: 93, resetsAt: WEEK_RESETS }] })
    expect((await notices()).filter((row) => row.state === 'open').map((row) => row.title))
      .toEqual([expect.stringMatching(/^Claude weekly limit at 93% · resets /)])

    // The window resets: the open notice expires, and the next period may notify again.
    clock = '2026-09-18T09:00:01.000Z'
    await (service as unknown as { sweepAttention(): Promise<void> }).sweepAttention()
    expect((await notices()).filter((row) => row.state === 'open')).toEqual([])
    await report({ windows: [{ minutes: 10_080, usedPercent: 90, resetsAt: '2026-09-25T09:00:00.000Z' }] })
    expect((await notices()).filter((row) => row.state === 'open')).toHaveLength(1)
  })

  it('opens no notice for a window that has already reset', async () => {
    await report({ windows: [{ minutes: 300, usedPercent: 99, resetsAt: '2026-09-14T11:59:00.000Z' }] })
    await expect(notices()).resolves.toEqual([])
  })

  it('reads a Codex run\'s plan windows from its own session file, through the conversation it is bound to', async () => {
    const conversation = '01a0e82f-81fe-7f70-b2d6-df18576f6cb9'
    const codexHome = join(root, 'codex-home')
    const folder = join(codexHome, 'sessions', '2026', '09', '14')
    await mkdir(folder, { recursive: true })
    const line = (used: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null,
      rate_limits: { primary: { used_percent: used, window_minutes: 10_080, resets_at: Date.parse(WEEK_RESETS) / 1000 }, secondary: null } } })
    const file = join(folder, `rollout-2026-09-14T11-00-00-${conversation}.jsonl`)
    await writeFile(file, `${line(40)}\n{"type":"response_item","payload":{"type":"message"}}\n`)
    bindings.set('s2', { status: 'bound', agentCli: 'codex', conversationReference: conversation,
      launchContext: { cwd: '/work/two', executable: '/usr/bin/codex', argv: [], environment: { CODEX_HOME: codexHome } } })

    await observe('s2', 'codex', 'SessionStart')
    await expect(usage('s2')).resolves.toMatchObject({
      agent: 'codex', reading: { agent: 'codex', windows: [{ minutes: 10_080, usedPercent: 40, resetsAt: WEEK_RESETS }], contextUsedPercent: null }
    })

    // A busy run is not reread on every event; a finished turn reads again at once.
    await writeFile(file, `${line(92)}\n`, { flag: 'a' })
    await observe('s2', 'codex', 'PostToolUse')
    await expect(usage('s2')).resolves.toMatchObject({ reading: { windows: [{ usedPercent: 40 }] } })
    await observe('s2', 'codex', 'Stop')
    await expect(usage('s2')).resolves.toMatchObject({ reading: { windows: [{ usedPercent: 92 }] } })
    expect((await notices()).map((row) => row.title)).toEqual([expect.stringMatching(/^Codex weekly limit at 92% · resets /)])
    await expect(plans()).resolves.toEqual([expect.objectContaining({ agent: 'codex', sessionId: 's2' })])
  })

  it('forgets a deleted session\'s reading but keeps the agent\'s plan reading', async () => {
    await report({ windows: [{ minutes: 300, usedPercent: 42, resetsAt: RESETS }] })
    database.prepare("DELETE FROM session WHERE session_id = 's1'").run()
    await service.sessionsChanged()

    expect((service as unknown as { usageReadings: Map<string, unknown> }).usageReadings.has('s1')).toBe(false)
    await expect(plans()).resolves.toHaveLength(1)
  })
})
