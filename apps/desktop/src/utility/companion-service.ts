// MODULE: companion-service.ts - host-side artifacts, attention, progress, drafts, settings, control socket, Telegram and backup
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import {
  ERROR_CODES,
  METHOD_REGISTRY,
  PROGRESS_STALE_AFTER_MS,
  type AppEventMessage,
  type AppEventTopic,
  type AppSettings,
  type ArtifactPreview,
  type ArtifactRecord,
  type AttentionRecord,
  type BackupManifest,
  type BackupManifestEntry,
  type BackupVerifyResult,
  type ControlInfo,
  type ProgressRecord,
  type SessionRecord,
  type TelegramStatus
} from '@ai-terminal/protocol'
import { ArtifactFileError, ArtifactFileStore, type InstalledOriginal } from './artifact-files'
import { ControlAuth, writeOwnerToken, type ControlScope } from './control-auth'
import { ControlError, ControlServer, type ReceiptRecord } from './control-server'
import type { DatabaseWorkerClient } from './database-client'
import type { ApplicationRoots } from './roots'
import { HostControlError, type SessionIdentity, type SessionManager } from './session-manager'
import { TelegramConnector, maskToken, redactToken, type ConnectorHealth, type InboundReply } from './telegram-connector'

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024
const PREVIEW_TEXT_BYTES = 256 * 1024
const TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024
const TELEGRAM_TOKEN_FILE = 'telegram-bot.token'
const TELEGRAM_OFFSET_KEY = 'telegram.offset'
const ATTENTION_SWEEP_MS = 30_000
const TEXT_MEDIA = /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml|toml))/

export const UNROUTED = Symbol('unrouted')

export interface CompanionServiceOptions {
  database: DatabaseWorkerClient
  manager: SessionManager
  roots: ApplicationRoots
  cliPath: string
  emit(message: AppEventMessage): void
  fetch?: typeof fetch
  now?: () => Date
}

function invalid(message: string): never {
  throw new HostControlError(ERROR_CODES.invalidArgument, message)
}

function text(params: Record<string, unknown>, key: string, max = 4096): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalid(`${key} must be text`)
  return value
}

function optionalText(params: Record<string, unknown>, key: string): string | null {
  const value = params[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') invalid(`${key} must be text`)
  return value
}

/** Paste text as one bracketed paste; the end marker is removed from the payload so it cannot close the paste early. */
export function bracketedPaste(payload: string, submit: boolean): Uint8Array {
  const safe = payload.split(BRACKETED_PASTE_END).join('')
  return new TextEncoder().encode(`${BRACKETED_PASTE_START}${safe}${BRACKETED_PASTE_END}${submit ? '\r' : ''}`)
}

function fileError(error: unknown): never {
  if (error instanceof ArtifactFileError) {
    const code = error.code === 'missing' || error.code === 'source-missing'
      ? ERROR_CODES.notFound
      : error.code === 'io-error' || error.code === 'disk-full'
        ? ERROR_CODES.ioError
        : ERROR_CODES.invalidArgument
    throw new HostControlError(code, error.message)
  }
  throw error
}

function toControlError(error: unknown): never {
  if (error instanceof HostControlError) throw new ControlError(error.code, error.message, error.retryable)
  if (error instanceof ArtifactFileError) {
    try {
      fileError(error)
    } catch (mapped) {
      toControlError(mapped)
    }
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error instanceof Error) {
    const code = Object.values(ERROR_CODES).find((value) => value === error.code)
    if (code) throw new ControlError(code, error.message)
  }
  throw error
}

async function sha256File(path: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash('sha256')
  let byteLength = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
    byteLength += (chunk as Buffer).byteLength
  }
  return { sha256: hash.digest('hex'), byteLength }
}

function backupArtifactFile(artifact: ArtifactRecord): string {
  return join('artifacts', artifact.sha256.slice(0, 2), artifact.artifactId)
}

function linkExtension(record: ArtifactRecord): string {
  const fromName = extname(record.originalName)
  if (/^\.[A-Za-z0-9]{1,8}$/.test(fromName)) return fromName.toLowerCase()
  const byType: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt'
  }
  return byType[record.mediaType] ?? ''
}

/** sockaddr_un.sun_path holds 108 bytes on Linux and 104 on macOS, in both cases including the terminator. */
const MAX_SOCKET_PATH_BYTES = process.platform === 'darwin' ? 103 : 107

export class CompanionService {
  readonly auth = new ControlAuth()
  readonly socketPath: string
  private readonly files: ArtifactFileStore
  private readonly control: ControlServer
  private readonly knownSessions = new Map<string, SessionRecord>()
  private controlListening = false
  private controlDetail = 'The control socket has not started'
  private telegram: TelegramConnector | undefined
  private telegramToken: string | null = null
  private telegramHealth: ConnectorHealth | undefined
  private telegramDetail = 'Telegram is off'
  private sweepTimer: NodeJS.Timeout | undefined
  private readonly now: () => Date

  constructor(private readonly options: CompanionServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.socketPath = join(options.roots.runtime, 'control', 'control.sock')
    this.files = new ArtifactFileStore({
      root: join(options.roots.data, 'artifacts', 'originals'),
      stagingRoot: join(options.roots.state, 'artifact-staging'),
      usedBytes: () => options.database.companion('artifactBytesUsed')
    })
    this.control = new ControlServer({
      socketPath: this.socketPath,
      auth: this.auth,
      receipts: {
        get: async (key) => (await options.database.companion('getReceipt', key)) as ReceiptRecord | undefined,
        put: (record) => options.database.companion('putReceipt', record, this.iso())
      },
      handlers: {
        isCurrentIncarnation: (sessionId, incarnationId) =>
          options.manager.liveIncarnationId(sessionId) === incarnationId,
        sessionExists: (sessionId) => this.knownSessions.has(sessionId),
        snapshot: (scope) => this.controlCall(() => this.snapshot(scope)),
        listSessions: (scope) => this.controlCall(async () => this.sessionsFor(scope)),
        publishArtifact: (p) => this.controlCall(() => this.publishArtifact(p)),
        reportProgress: (p) => this.controlCall(() => this.reportProgress(p)),
        openAttention: (p) => this.controlCall(() => this.openAttention(p)),
        withdrawAttention: (p) => this.controlCall(() => this.closeAttentionByKey(p.sessionId, p.requestKey, 'withdrawn', null)),
        resolveAttention: (p) => this.controlCall(() => this.closeAttentionByKey(p.sessionId, p.requestKey, 'answered', p.resolution)),
        submitInput: (p) => this.controlCall(async () => {
          this.options.manager.writeToSession(p.sessionId, bracketedPaste(p.text, p.submit))
        })
      }
    })
  }

  /** Environment for one incarnation: its scoped control credential and the CLI on PATH. */
  sessionEnvironment(identity: SessionIdentity): Record<string, string> {
    const binDirectory = dirname(this.options.cliPath)
    return {
      AITERM_CONTROL_SOCKET: this.socketPath,
      AITERM_TOKEN: this.auth.sessionToken(identity.sessionId, identity.incarnationId),
      AITERM_SESSION_ID: identity.sessionId,
      PATH: [binDirectory, process.env.PATH ?? '/usr/bin:/bin'].join(':')
    }
  }

  async start(): Promise<void> {
    await this.sessionsChanged()
    await this.files.reconcileStaging().catch(() => [])
    await this.reconcileArtifacts()
    try {
      await writeOwnerToken(dirname(this.socketPath), this.auth.ownerToken)
      await this.control.listen()
      this.controlListening = true
      this.controlDetail = 'Agents and the aiterm CLI can reach this app'
    } catch (error) {
      // The kernel caps a Unix socket path and reports only EINVAL, so name the real cause.
      const tooLong = Buffer.byteLength(this.socketPath) > MAX_SOCKET_PATH_BYTES
      this.controlDetail = tooLong
        ? `The control socket is unavailable: its path is longer than ${MAX_SOCKET_PATH_BYTES} bytes (${this.socketPath}); use a shorter runtime directory`
        : `The control socket is unavailable: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`
    }
    this.sweepTimer = setInterval(() => void this.sweepAttention(), ATTENTION_SWEEP_MS)
    this.sweepTimer.unref()
    // Telegram's first network check must never delay terminal startup.
    void this.restartTelegram().catch(() => undefined)
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    await Promise.allSettled([this.control.close(), this.telegram?.stop()])
    await unlink(join(dirname(this.socketPath), 'owner.token')).catch(() => undefined)
  }

  /** Called for every session process transition so exit notices and the session cache stay current. */
  sessionStateChanged(sessionId: string, state: string): void {
    void this.sessionsChanged().then(async () => {
      if (state !== 'exited') return
      const settings = await this.options.database.companion('getSettings')
      if (!settings.telegram.enabled || settings.telegram.notifyOn !== 'attention-and-exit') return
      const session = this.knownSessions.get(sessionId)
      await this.telegramNotify(sessionId, null, `■ ${session?.name ?? 'A session'} exited`)
    }).catch(() => undefined)
  }

  /** Routes renderer-facing methods; returns UNROUTED for methods this service does not own. */
  async route(method: string, params: Record<string, unknown>): Promise<unknown> {
    const database = this.options.database
    switch (method) {
      case METHOD_REGISTRY.artifactList:
        return database.companion('listArtifacts', optionalText(params, 'sessionId'))
      case METHOD_REGISTRY.artifactImport: {
        const path = text(params, 'path')
        if (!isAbsolute(path)) invalid('The file path must be absolute')
        return this.recordImport(
          await this.files.importFile(path, { artifactId: randomUUID() }).catch(fileError),
          { sessionId: text(params, 'sessionId'), direction: 'input', source: 'owner', sourcePath: path }
        )
      }
      case METHOD_REGISTRY.artifactImportBytes: {
        const bytes = params.bytes
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) invalid('Image bytes are required')
        const installed = await this.files
          .importBytes(bytes, { artifactId: randomUUID(), originalName: text(params, 'name', 255) })
          .catch(fileError)
        return this.recordImport(installed, {
          sessionId: text(params, 'sessionId'), direction: 'input', source: 'owner', sourcePath: null
        })
      }
      case METHOD_REGISTRY.artifactSaveAs: {
        const artifact = await this.readyArtifact(text(params, 'artifactId'))
        const destination = text(params, 'destinationPath')
        if (!isAbsolute(destination)) invalid('The destination must be an absolute path')
        return this.files
          .saveAs(artifact.storedPath, artifact.sha256, destination, { overwrite: params.overwrite === true })
          .catch(async (error: unknown) => {
            await this.markDamaged(artifact, error)
            fileError(error)
          })
      }
      case METHOD_REGISTRY.artifactPreview:
        return this.preview(text(params, 'artifactId'))
      case METHOD_REGISTRY.artifactDeliver:
        return this.deliver(text(params, 'artifactId'), text(params, 'sessionId'))
      case METHOD_REGISTRY.attentionList:
        return database.companion('listAttention')
      case METHOD_REGISTRY.attentionSeen: {
        const record = await database.companion('markAttentionSeen', text(params, 'requestId'), this.iso())
        this.emit('attention', record.sessionId)
        return record
      }
      case METHOD_REGISTRY.attentionResolve: {
        const state = params.state === 'withdrawn' ? 'withdrawn' : 'answered'
        const record = await database.companion(
          'closeAttention',
          { requestId: text(params, 'requestId') },
          state,
          optionalText(params, 'resolution') ?? 'Acknowledged in BMN',
          this.iso()
        )
        this.emit('attention', record.sessionId)
        return record
      }
      case METHOD_REGISTRY.progressList:
        return database.companion('listProgress')
      case METHOD_REGISTRY.draftList:
        return database.companion('listDrafts')
      case METHOD_REGISTRY.draftSend:
        return this.sendDraft(text(params, 'draftId'), params.submit === true)
      case METHOD_REGISTRY.draftDiscard: {
        const record = await database.companion('updateDraft', text(params, 'draftId'), 'discarded', null, this.iso())
        this.emit('drafts', record.sessionId)
        return record
      }
      case METHOD_REGISTRY.settingsGet:
        return database.companion('getSettings')
      case METHOD_REGISTRY.settingsPut: {
        const section = text(params, 'section', 32)
        const settings = await database.companion('putSettingsSection', section, params.value, this.iso())
        this.emit('settings', null)
        if (section === 'telegram') await this.restartTelegram()
        return settings
      }
      case METHOD_REGISTRY.backupExport:
        return this.exportBackup(text(params, 'directory'))
      case METHOD_REGISTRY.backupVerify:
        return this.verifyBackup(text(params, 'directory'))
      case METHOD_REGISTRY.telegramConfigure:
        return this.configureTelegram(params.token)
      case METHOD_REGISTRY.telegramStatus:
        return this.telegramStatus()
      case METHOD_REGISTRY.telegramTest: {
        if (!this.telegram || this.telegramHealth?.state !== 'polling') {
          throw new HostControlError(ERROR_CODES.ioError, 'Telegram is not connected', true)
        }
        await this.telegram.sendMessage('BMN test message. Replies to notifications return to their session.')
        return this.telegramStatus()
      }
      case METHOD_REGISTRY.controlInfo:
        return {
          socketPath: this.socketPath,
          cliPath: this.options.cliPath,
          listening: this.controlListening,
          detail: this.controlDetail
        } satisfies ControlInfo
      default:
        return UNROUTED
    }
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private emit(topic: AppEventTopic, sessionId: string | null): void {
    this.options.emit({ kind: 'app-event', topic, sessionId })
  }

  private async controlCall<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation()
    } catch (error) {
      return toControlError(error)
    }
  }

  /** Refreshes the session cache the control socket uses to check owner targets. */
  async sessionsChanged(): Promise<void> {
    const workspaces = await this.options.database.listWorkspaces(true)
    const lists = await Promise.all(workspaces.map((workspace) => this.options.database.listSessions(workspace.workspaceId)))
    this.knownSessions.clear()
    for (const session of lists.flat()) {
      this.knownSessions.set(session.sessionId, this.options.manager.sessionWithCurrentProcessState(session))
    }
  }

  private async sessionsFor(scope: ControlScope): Promise<SessionRecord[]> {
    await this.sessionsChanged()
    const sessions = [...this.knownSessions.values()]
    return scope.kind === 'owner' ? sessions : sessions.filter((session) => session.sessionId === scope.sessionId)
  }

  private async snapshot(scope: ControlScope): Promise<unknown> {
    const sessions = await this.sessionsFor(scope)
    const visible = new Set(sessions.map((session) => session.sessionId))
    const [attention, progress] = await Promise.all([
      this.options.database.companion('listAttention'),
      this.options.database.companion('listProgress')
    ])
    const nowMs = this.now().getTime()
    return {
      watermark: nowMs,
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        name: session.name,
        cwd: session.cwd,
        process: session.lastProcess?.state ?? 'never-started'
      })),
      attention: attention.filter((request) => request.state === 'open' && visible.has(request.sessionId)),
      progress: progress
        .filter((row) => visible.has(row.sessionId))
        .map((row) => ({ ...row, stale: nowMs - Date.parse(row.observedAt) > PROGRESS_STALE_AFTER_MS }))
    }
  }

  private async recordImport(
    installed: InstalledOriginal,
    origin: Pick<ArtifactRecord, 'sessionId' | 'direction' | 'source' | 'sourcePath'>
  ): Promise<ArtifactRecord> {
    const record: ArtifactRecord = {
      artifactId: installed.artifactId,
      sessionId: origin.sessionId,
      incarnationId: origin.sessionId ? this.options.manager.liveIncarnationId(origin.sessionId) ?? null : null,
      direction: origin.direction,
      source: origin.source,
      originalName: installed.originalName,
      mediaType: installed.mediaType,
      byteLength: installed.byteLength,
      sha256: installed.sha256,
      storedPath: installed.storedPath,
      sourcePath: origin.sourcePath,
      state: 'ready',
      createdAt: this.iso()
    }
    try {
      await this.options.database.companion('insertArtifact', record)
    } catch (error) {
      await rm(installed.storedPath, { force: true }).catch(() => undefined)
      throw error
    }
    this.emit('artifacts', origin.sessionId)
    return record
  }

  private async publishArtifact(p: {
    sessionId: string
    incarnationId: string | null
    path: string
    name?: string
    source: 'agent' | 'owner'
  }): Promise<unknown> {
    const session = this.knownSessions.get(p.sessionId)
    const allowedRoots = p.source === 'agent' && session ? [session.cwd, tmpdir()] : undefined
    const installed = await this.files.importFile(p.path, {
      artifactId: randomUUID(),
      ...(p.name ? { originalName: p.name } : {}),
      ...(allowedRoots ? { allowedRoots } : {})
    }).catch(fileError)
    const record = await this.recordImport(installed, {
      sessionId: p.sessionId, direction: 'output', source: p.source, sourcePath: p.path
    })
    return {
      artifactId: record.artifactId,
      name: record.originalName,
      sha256: record.sha256,
      byteLength: record.byteLength,
      mediaType: record.mediaType
    }
  }

  private async reportProgress(p: {
    sessionId: string
    incarnationId: string | null
    source: string
    state: ProgressRecord['state']
    label: string
    detail?: string
    observedAt: string
  }): Promise<unknown> {
    if (Number.isNaN(Date.parse(p.observedAt))) invalid('observedAt must be an ISO timestamp')
    const result = await this.options.database.companion('upsertProgress', {
      sessionId: p.sessionId,
      source: p.source,
      incarnationId: p.incarnationId,
      state: p.state,
      label: p.label,
      detail: p.detail ?? null,
      observedAt: new Date(p.observedAt).toISOString(),
      receivedAt: this.iso()
    })
    if (result.applied) this.emit('progress', p.sessionId)
    return { applied: result.applied, current: result.record }
  }

  private async openAttention(p: {
    sessionId: string
    incarnationId: string | null
    requestKey: string
    kind: AttentionRecord['kind']
    title: string
    body?: string
    expiresAt?: string
  }): Promise<AttentionRecord> {
    const record = await this.options.database.companion('openAttention', {
      sessionId: p.sessionId,
      incarnationId: p.incarnationId,
      requestKey: p.requestKey,
      kind: p.kind,
      title: p.title,
      ...(p.body !== undefined ? { body: p.body } : {}),
      ...(p.expiresAt !== undefined ? { expiresAt: new Date(p.expiresAt).toISOString() } : {})
    }, randomUUID(), this.iso())
    this.emit('attention', p.sessionId)
    if (record.seenAt === null) {
      const session = this.knownSessions.get(p.sessionId)
      const body = record.body ? `\n${record.body}` : ''
      void this.telegramNotify(
        p.sessionId,
        record.requestId,
        `● ${session?.name ?? 'Session'} needs you (${record.kind})\n${record.title}${body}\n\nReply to this message to answer.`
      )
    }
    return record
  }

  private async closeAttentionByKey(
    sessionId: string,
    requestKey: string,
    state: 'answered' | 'withdrawn',
    resolution: string | null
  ): Promise<AttentionRecord> {
    const record = await this.options.database.companion(
      'closeAttention', { sessionId, requestKey }, state, resolution, this.iso()
    )
    this.emit('attention', sessionId)
    return record
  }

  private async sweepAttention(): Promise<void> {
    const expired = await this.options.database.companion('expireAttention', this.iso()).catch(() => 0)
    if (expired > 0) this.emit('attention', null)
  }

  private async readyArtifact(artifactId: string): Promise<ArtifactRecord> {
    const artifact = await this.options.database.companion('getArtifact', artifactId)
    const verdict = await this.files.verify(artifact.storedPath, artifact.sha256)
    if (verdict !== 'ok') {
      if (artifact.state !== verdict) {
        await this.options.database.companion('setArtifactState', artifactId, verdict)
        this.emit('artifacts', artifact.sessionId)
      }
      throw new HostControlError(
        verdict === 'missing' ? ERROR_CODES.notFound : ERROR_CODES.ioError,
        verdict === 'missing' ? 'The stored original is missing' : 'The stored original no longer matches its hash'
      )
    }
    if (artifact.state !== 'ready') {
      await this.options.database.companion('setArtifactState', artifactId, 'ready')
      this.emit('artifacts', artifact.sessionId)
    }
    return { ...artifact, state: 'ready' }
  }

  private async markDamaged(artifact: ArtifactRecord, error: unknown): Promise<void> {
    if (error instanceof ArtifactFileError && (error.code === 'missing' || error.code === 'corrupt')) {
      await this.options.database.companion('setArtifactState', artifact.artifactId, error.code).catch(() => undefined)
      this.emit('artifacts', artifact.sessionId)
    }
  }

  /** Marks originals whose file disappeared or changed so the UI never offers a broken artifact as ready. */
  private async reconcileArtifacts(): Promise<void> {
    const artifacts = await this.options.database.companion('listAllArtifacts')
    for (const artifact of artifacts) {
      const exists = await lstat(artifact.storedPath).then((stats) => stats.isFile(), () => false)
      const state = exists ? artifact.state === 'missing' ? 'ready' : artifact.state : 'missing'
      if (state !== artifact.state) await this.options.database.companion('setArtifactState', artifact.artifactId, state)
    }
  }

  private async preview(artifactId: string): Promise<ArtifactPreview> {
    const artifact = await this.readyArtifact(artifactId)
    if (artifact.mediaType.startsWith('image/')) {
      const { bytes, truncated } = await this.files.readPreview(artifact.storedPath, PREVIEW_IMAGE_BYTES)
      if (truncated) {
        return { artifactId, kind: 'unsupported', mediaType: artifact.mediaType, content: null, truncated: true }
      }
      return {
        artifactId, kind: 'image', mediaType: artifact.mediaType,
        content: Buffer.from(bytes).toString('base64'), truncated: false
      }
    }
    if (TEXT_MEDIA.test(artifact.mediaType)) {
      const { bytes, truncated } = await this.files.readPreview(artifact.storedPath, PREVIEW_TEXT_BYTES)
      return {
        artifactId, kind: 'text', mediaType: artifact.mediaType,
        content: new TextDecoder('utf-8', { fatal: false }).decode(bytes), truncated
      }
    }
    return { artifactId, kind: 'unsupported', mediaType: artifact.mediaType, content: null, truncated: false }
  }

  /**
   * Delivers an owned original to the target session by pasting a path to it, never pressing Enter.
   * The path is a symlink named with the original's extension so TUIs recognize images.
   */
  private async deliver(artifactId: string, sessionId: string): Promise<{ delivered: true; path: string }> {
    const artifact = await this.readyArtifact(artifactId)
    if (!this.options.manager.liveIncarnationId(sessionId)) {
      throw new HostControlError(ERROR_CODES.notFound, 'The target session has no live process')
    }
    const linkDirectory = join(this.options.roots.data, 'artifacts', 'links')
    await mkdir(linkDirectory, { recursive: true, mode: 0o700 })
    const linkPath = join(linkDirectory, `${artifact.artifactId}${linkExtension(artifact)}`)
    const existing = await lstat(linkPath).catch(() => undefined)
    if (!existing) await symlink(artifact.storedPath, linkPath)
    else if (!existing.isSymbolicLink()) throw new HostControlError(ERROR_CODES.ioError, 'The delivery path is occupied')
    const quoted = /[\s'"\\]/.test(linkPath) ? `'${linkPath.replaceAll("'", "'\\''")}'` : linkPath
    this.options.manager.writeToSession(sessionId, bracketedPaste(`${quoted} `, false))
    return { delivered: true, path: linkPath }
  }

  private async sendDraft(draftId: string, submit: boolean): Promise<unknown> {
    const database = this.options.database
    const draft = await database.companion('getDraft', draftId)
    if (draft.state !== 'draft' && draft.state !== 'uncertain') invalid('Only an unsent draft can be sent')
    if (draft.text) this.options.manager.writeToSession(draft.sessionId, bracketedPaste(draft.text, submit))
    if (draft.artifactId) await this.deliver(draft.artifactId, draft.sessionId)
    const record = await database.companion('updateDraft', draftId, submit ? 'submitted' : 'accepted', null, this.iso())
    this.emit('drafts', draft.sessionId)
    return record
  }

  private async exportBackup(parent: string): Promise<{ directory: string; manifest: BackupManifest }> {
    if (!isAbsolute(parent)) invalid('The backup location must be an absolute path')
    const createdAt = this.iso()
    const directory = join(parent, `ai-terminal-backup-${createdAt.replaceAll(':', '-').replace(/\..*$/, '')}`)
    await mkdir(join(directory, 'artifacts'), { recursive: true, mode: 0o700 })
    const databaseFile = join(directory, 'state.sqlite3')
    await this.options.database.backupInto(databaseFile)
    const artifacts: BackupManifest['artifacts'] = []
    // Read the snapshot, not the live table, so the manifest names exactly the ready artifacts the backup database holds.
    for (const artifact of await this.options.database.readyArtifactsInBackup(databaseFile)) {
      const file = backupArtifactFile(artifact)
      await mkdir(dirname(join(directory, file)), { recursive: true, mode: 0o700 })
      await copyFile(artifact.storedPath, join(directory, file))
      const copied = await sha256File(join(directory, file))
      if (copied.sha256 !== artifact.sha256) {
        throw new HostControlError(ERROR_CODES.ioError, `Artifact ${artifact.originalName} changed while backing up`)
      }
      artifacts.push({ file, artifactId: artifact.artifactId, ...copied })
    }
    const manifest: BackupManifest = {
      formatVersion: 1,
      createdAt,
      database: { file: 'state.sqlite3', ...(await sha256File(databaseFile)) },
      artifacts,
      excluded: ['Telegram bot token', 'control socket credentials', 'saved terminal output']
    }
    const manifestPath = join(directory, 'manifest.json')
    await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await rename(`${manifestPath}.tmp`, manifestPath)
    return { directory, manifest }
  }

  private async verifyBackup(directory: string): Promise<BackupVerifyResult> {
    if (!isAbsolute(directory)) invalid('The backup location must be an absolute path')
    let manifest: BackupManifest
    try {
      manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as BackupManifest
      if (manifest.formatVersion !== 1 || !manifest.database || !Array.isArray(manifest.artifacts)) throw new Error()
    } catch {
      return { directory, ok: false, checked: 0, failures: [{ file: 'manifest.json', reason: 'unreadable-manifest' }] }
    }
    const entries: BackupManifestEntry[] = [manifest.database, ...manifest.artifacts]
    const failures: BackupVerifyResult['failures'] = []
    for (const entry of entries) {
      const path = join(directory, entry.file)
      if (relative(directory, path).startsWith('..')) {
        failures.push({ file: entry.file, reason: 'unreadable-manifest' })
        continue
      }
      const actual = await sha256File(path).catch(() => undefined)
      if (!actual) failures.push({ file: entry.file, reason: 'missing' })
      else if (actual.sha256 !== entry.sha256 || actual.byteLength !== entry.byteLength) {
        failures.push({ file: entry.file, reason: 'hash-mismatch' })
      }
    }
    // Hashes only prove the listed files; the database says which artifacts the backup must hold.
    if (failures.length === 0) {
      const listed = new Set(manifest.artifacts.map((entry) => entry.artifactId))
      const recorded = await this.options.database.readyArtifactsInBackup(join(directory, manifest.database.file))
        .catch(() => undefined)
      if (!recorded) failures.push({ file: manifest.database.file, reason: 'unreadable-database' })
      for (const artifact of recorded ?? []) {
        if (!listed.has(artifact.artifactId)) failures.push({ file: backupArtifactFile(artifact), reason: 'not-in-manifest' })
      }
    }
    return { directory, ok: failures.length === 0, checked: entries.length, failures }
  }

  private tokenPath(): string {
    return join(this.options.roots.config, TELEGRAM_TOKEN_FILE)
  }

  private async readTelegramToken(): Promise<string | null> {
    const token = (await readFile(this.tokenPath(), 'utf8').catch(() => '')).trim()
    return token.length > 0 ? token : null
  }

  private async configureTelegram(token: unknown): Promise<TelegramStatus> {
    if (token === null) {
      await rm(this.tokenPath(), { force: true })
    } else {
      if (typeof token !== 'string' || !/^\d{3,20}:[A-Za-z0-9_-]{20,80}$/.test(token.trim())) {
        invalid('The bot token does not look like a Telegram bot token')
      }
      await mkdir(this.options.roots.config, { recursive: true, mode: 0o700 })
      const temporary = `${this.tokenPath()}.${randomUUID()}.tmp`
      await writeFile(temporary, `${token.trim()}\n`, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.tokenPath())
    }
    await this.restartTelegram()
    return this.telegramStatus()
  }

  private async telegramStatus(): Promise<TelegramStatus> {
    const token = this.telegramToken ?? await this.readTelegramToken()
    const redact = (value: string | null): string | null => value && token ? redactToken(value, token) : value
    if (this.telegram && this.telegramHealth) {
      return {
        state: this.telegramHealth.state,
        detail: redact(this.telegramHealth.detail) ?? '',
        tokenMask: token ? maskToken(token) : null,
        lastPollAt: this.telegramHealth.lastPollAt,
        lastError: redact(this.telegramHealth.lastError),
        rejectedUpdates: this.telegramHealth.rejectedUpdates
      }
    }
    const settings = await this.options.database.companion('getSettings')
    return {
      state: settings.telegram.enabled ? 'unconfigured' : 'disabled',
      detail: this.telegramDetail,
      tokenMask: token ? maskToken(token) : null,
      lastPollAt: null,
      lastError: null,
      rejectedUpdates: 0
    }
  }

  private async restartTelegram(): Promise<void> {
    const previous = this.telegram
    this.telegram = undefined
    this.telegramHealth = undefined
    await previous?.stop().catch(() => undefined)
    const settings: AppSettings = await this.options.database.companion('getSettings')
    const token = await this.readTelegramToken()
    this.telegramToken = token
    if (!settings.telegram.enabled) {
      this.telegramDetail = 'Telegram is off'
    } else if (!token) {
      this.telegramDetail = 'Add a bot token to connect Telegram'
    } else if (settings.telegram.allowedChatId === null) {
      this.telegramDetail = 'Choose the allowed chat to connect Telegram'
    } else {
      const connector = new TelegramConnector({
        token,
        allowedChatId: settings.telegram.allowedChatId,
        allowedUserId: settings.telegram.allowedUserId,
        fetch: this.options.fetch ?? fetch,
        lockDirectory: this.options.roots.runtime,
        offset: {
          get: async () => {
            const value = await this.options.database.companion('getRawSetting', TELEGRAM_OFFSET_KEY)
            return typeof value === 'number' ? value : null
          },
          set: (next) => this.options.database.companion('putRawSetting', TELEGRAM_OFFSET_KEY, next, this.iso())
        },
        onReply: (reply) => this.handleTelegramReply(reply),
        onHealth: (health) => {
          if (this.telegram !== connector) return
          this.telegramHealth = health
          this.emit('telegram', null)
        }
      })
      this.telegram = connector
      this.telegramHealth = connector.health()
      try {
        await connector.start()
      } catch (error) {
        this.telegramHealth = connector.health()
        this.telegramDetail = redactToken(error instanceof Error ? error.message : 'Telegram could not start', token)
      }
    }
    this.emit('telegram', null)
  }

  private async telegramNotify(sessionId: string, requestId: string | null, message: string): Promise<void> {
    const connector = this.telegram
    if (!connector || this.telegramHealth?.state !== 'polling') return
    try {
      const sent = await connector.sendMessage(message)
      await this.options.database.companion('putTelegramMessage', sent.messageId, sessionId, requestId, this.iso())
    } catch {
      // Connector health carries the redacted failure; attention stays open in the app either way.
    }
  }

  /**
   * A reply is addressed only by the notification it replies to. Without that correlation it is refused;
   * with it, text becomes a draft for that session unless the owner opted into automatic submission.
   */
  private async handleTelegramReply(reply: InboundReply): Promise<void> {
    const connector = this.telegram
    if (!connector) return
    const database = this.options.database
    const target = reply.replyToMessageId === null
      ? undefined
      : await database.companion('getTelegramMessage', reply.replyToMessageId)
    if (!target || !this.knownSessions.has(target.sessionId)) {
      await connector.sendMessage('Reply to a notification so BMN knows which session this is for.', {
        replyToMessageId: reply.messageId
      }).catch(() => undefined)
      return
    }
    const originKey = `telegram:${reply.updateId}`
    let artifactId: string | null = null
    if (reply.file) {
      const downloaded = await connector.downloadFile(reply.file.fileId, TELEGRAM_DOWNLOAD_BYTES)
      const installed = await this.files.importBytes(downloaded.bytes, {
        artifactId: randomUUID(),
        originalName: reply.file.fileName || basename(downloaded.filePath)
      })
      artifactId = (await this.recordImport(installed, {
        sessionId: target.sessionId, direction: 'input', source: 'telegram', sourcePath: null
      })).artifactId
    }
    const settings = await database.companion('getSettings')
    const { record, created } = await database.companion('createDraft', {
      draftId: randomUUID(),
      sessionId: target.sessionId,
      origin: 'telegram',
      originKey,
      requestId: target.requestId,
      text: reply.text,
      artifactId,
      state: 'draft',
      detail: null
    }, this.iso())
    if (!created) return
    this.emit('drafts', target.sessionId)
    const live = this.options.manager.liveIncarnationId(target.sessionId)
    if (settings.telegram.autoSubmitReplies && live) {
      try {
        await this.sendDraft(record.draftId, true)
        if (target.requestId && reply.text) {
          await database.companion('closeAttention', { requestId: target.requestId }, 'answered', reply.text, this.iso())
            .then(() => this.emit('attention', target.sessionId), () => undefined)
        }
        await connector.sendMessage('Sent to the session.', { replyToMessageId: reply.messageId }).catch(() => undefined)
        return
      } catch {
        await database.companion('updateDraft', record.draftId, 'uncertain', 'Automatic submission failed', this.iso())
      }
    }
    await connector.sendMessage('Saved as a draft in BMN for that session.', {
      replyToMessageId: reply.messageId
    }).catch(() => undefined)
  }
}
