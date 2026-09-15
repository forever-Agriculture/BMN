import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  ERROR_CODES,
  METHOD_REGISTRY,
  PROTOCOL_VERSION,
  isCompatibleProtocol,
  isRpcRequest,
  isSessionCreateParams,
  isSessionStopParams,
  isSessionUpdateParams,
  isTemplateCreateParams,
  isTerminalAckMessage,
  isTerminalInputMessage,
  isWorkspaceCreateParams,
  isWorkspaceUpdateParams,
  type ExplicitConversationBinding,
  type HelloParams,
  type ProtocolErrorCode,
  type RpcFailure,
  type RpcId,
  type RpcRequest,
  type RpcSuccess,
  type SavedOutputProcessState,
  type SavedOutputUnavailableReason,
  type TerminalPortMessage,
  type WorkspaceLayoutState
} from '@ai-terminal/protocol'
import { CompanionService, UNROUTED } from './companion-service'
import { DatabaseClientError, DatabaseWorkerClient } from './database-client'
import { nativeLoadFailureMessage } from './native-load-error'
import { ensureApplicationRoots, resolveApplicationRoots } from './roots'
import { FileSavedOutputStore } from './saved-output-store'
import { routeTerminalSavedOutputGet } from './saved-output-route'
import {
  HostControlError,
  SessionManager,
  findStoredSession,
  resolveHomeDirectory,
  validateLaunch,
  type CreateSessionParams,
  type PtyLike,
  type SessionIdentity
} from './session-manager'

type NativeModuleName = 'node-pty' | 'better-sqlite3'

interface NodePtyModule {
  spawn(
    executable: string,
    argv: string[],
    options: {
      cwd: string
      cols: number
      rows: number
      env: Record<string, string | undefined>
      encoding: null
    }
  ): PtyLike
}

interface TerminalPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): TerminalPort
  on(event: 'close', listener: () => void): TerminalPort
  postMessage(message: TerminalPortMessage): void
  start(): void
  close(): void
}

interface ParentMessageEvent {
  data: unknown
  ports: TerminalPort[]
}

interface ControlMessage {
  kind: 'control-request'
  request: RpcRequest
}

const nativeRequire = createRequire(__filename)
const nativeFailureProbe = process.argv.includes('--native-failure-self-test')

function loadNativeModule(moduleName: NativeModuleName): unknown {
  try {
    if (nativeFailureProbe && process.env.AITERM_TEST_FAIL_NATIVE === moduleName) {
      throw new Error('self-test simulated missing dependency')
    }
    return nativeRequire(moduleName)
  } catch (error) {
    const repoRoot = process.env.AITERM_REPO_ROOT ?? '<repo root>'
    process.stderr.write(`${nativeLoadFailureMessage(moduleName, error, repoRoot)}\n`)
    process.exit(1)
  }
}

const nodePty = loadNativeModule('node-pty') as Partial<NodePtyModule>
const BetterSqlite3 = loadNativeModule('better-sqlite3')

if (typeof nodePty.spawn !== 'function') {
  process.stderr.write(
    `${nativeLoadFailureMessage('node-pty', new Error('module does not export spawn'), process.env.AITERM_REPO_ROOT ?? '<repo root>')}\n`
  )
  process.exit(1)
}
if (typeof BetterSqlite3 !== 'function') {
  process.stderr.write(
    `${nativeLoadFailureMessage('better-sqlite3', new Error('module does not export a database constructor'), process.env.AITERM_REPO_ROOT ?? '<repo root>')}\n`
  )
  process.exit(1)
}

const parentPort = process.parentPort
if (!parentPort) {
  process.stderr.write('[ai-terminal] the terminal host cannot start outside an Electron utility process.\n')
  process.exit(1)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new HostControlError(ERROR_CODES.invalidArgument, 'Control parameters must be an object')
  }
  return value as Record<string, unknown>
}

function stringValue(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new HostControlError(ERROR_CODES.invalidArgument, `Control parameter ${key} must be a string`)
  }
  return value
}

function textValue(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string') {
    throw new HostControlError(ERROR_CODES.invalidArgument, `Control parameter ${key} must be text`)
  }
  return value
}

function numberValue(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HostControlError(ERROR_CODES.invalidArgument, `Control parameter ${key} must be an integer`)
  }
  return value
}

function booleanValue(params: Record<string, unknown>, key: string): boolean {
  const value = params[key]
  if (typeof value !== 'boolean') {
    throw new HostControlError(ERROR_CODES.invalidArgument, `Control parameter ${key} must be a boolean`)
  }
  return value
}

function savedOutputProcessStateValue(
  params: Record<string, unknown>,
  key: string
): SavedOutputProcessState {
  const value = params[key]
  if (value !== 'live' && value !== 'exited' && value !== 'interrupted') {
    throw new HostControlError(ERROR_CODES.invalidArgument, `Control parameter ${key} is invalid`)
  }
  return value
}

function savedOutputUnavailableReasonValue(
  params: Record<string, unknown>,
  key: string
): SavedOutputUnavailableReason {
  const value = params[key]
  if (
    value !== 'no-renderer' &&
    value !== 'renderer-destroyed' &&
    value !== 'not-acknowledged-in-time' &&
    value !== 'capture-persist-failure'
  ) {
    throw new HostControlError(ERROR_CODES.invalidArgument, `Control parameter ${key} is invalid`)
  }
  return value
}

function identity(params: Record<string, unknown>): SessionIdentity {
  return {
    sessionId: stringValue(params, 'sessionId'),
    incarnationId: stringValue(params, 'incarnationId')
  }
}

function failure(
  id: RpcId,
  code: ProtocolErrorCode,
  message: string,
  retryable = false
): RpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: message.slice(0, 480), data: { code, retryable } }
  }
}

/**
 * Applies the owner's archive retention once per host start, before any session can launch. A failure
 * is logged and never blocks startup; the next start tries again.
 */
async function purgeExpiredArchives(
  database: DatabaseWorkerClient,
  savedOutputStore: FileSavedOutputStore
): Promise<void> {
  try {
    const purged = await database.purgeExpiredArchives()
    if (purged.sessionIds.length === 0 && purged.workspaceIds.length === 0) return
    await savedOutputStore.removeSessions(purged.sessionIds)
    process.stderr.write(
      `[ai-terminal] deleted ${purged.sessionIds.length} archived session(s) and ${purged.workspaceIds.length} archived workspace(s)\n`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    process.stderr.write(`[ai-terminal] archive cleanup failed: ${message.slice(0, 240)}\n`)
  }
}

async function start(): Promise<void> {
  const roots = resolveApplicationRoots()
  await ensureApplicationRoots(roots)
  const database = new DatabaseWorkerClient(
    join(__dirname, 'database-worker.js'),
    join(roots.data, 'state.sqlite3')
  )
  const initialized = await database.initialize()
  const savedOutputStore = new FileSavedOutputStore(join(roots.state, 'saved-output'))
  await purgeExpiredArchives(database, savedOutputStore)
  let terminalPort: TerminalPort | undefined
  let handshaken = false
  // The manager's callbacks run before the companion exists, so they read it through a holder.
  const companionHolder: { current?: CompanionService } = {}
  const manager = new SessionManager({
    store: database,
    savedOutputStore,
    spawnPty: (executable, argv, options) =>
      nodePty.spawn!(executable, [...argv], {
        ...options,
        env: { ...options.env },
        encoding: null
      }),
    sendTerminalMessage: (message) => terminalPort?.postMessage(message),
    onSessionStateChange: (message) => {
      parentPort.postMessage(message)
      companionHolder.current?.sessionStateChanged(message.sessionId, message.state)
    },
    sessionEnvironment: (sessionIdentity) => companionHolder.current?.sessionEnvironment(sessionIdentity) ?? {}
  })
  const companion = new CompanionService({
    database,
    manager,
    roots,
    cliPath: process.env.AITERM_CLI_PATH ?? join(__dirname, '..', '..', 'bin', 'aiterm'),
    emit: (message) => parentPort.postMessage(message)
  })
  companionHolder.current = companion
  await companion.start()
  const companionService = companion

  function connectTerminalPort(port: TerminalPort): void {
    terminalPort = port
    port.on('message', (event) => {
      try {
        if (isTerminalInputMessage(event.data)) manager.write(event.data)
        else if (isTerminalAckMessage(event.data)) manager.acknowledge(event.data)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid terminal transport message'
        process.stderr.write(`[ai-terminal] terminal transport rejected: ${message.slice(0, 240)}\n`)
      }
    })
    port.on('close', () => {
      if (terminalPort !== port) return
      terminalPort = undefined
      manager.rendererDisconnected()
    })
    port.start()
  }

  async function route(request: RpcRequest): Promise<unknown> {
    if (!handshaken && request.method !== METHOD_REGISTRY.hello) {
      throw new HostControlError(
        ERROR_CODES.protocolMismatch,
        'The protocol hello handshake must complete before other methods'
      )
    }
    const params = record(request.params)
    switch (request.method) {
      case METHOD_REGISTRY.hello: {
        const hello = params as unknown as HelloParams
        if (!isCompatibleProtocol(hello.protocol)) {
          throw new HostControlError(
            ERROR_CODES.protocolMismatch,
            'The terminal host protocol major is incompatible'
          )
        }
        handshaken = true
        return { protocol: PROTOCOL_VERSION, instanceId: randomUUID() }
      }
      case METHOD_REGISTRY.healthGet:
        if (params.selfTestHostLoss === true && process.argv.includes('--self-test-host')) {
          setTimeout(() => {
            void database.close().then(() => {
              parentPort.postMessage({ kind: 'host-loss-self-test-ready' })
              manager.abandonForHostLossSelfTest()
              process.exit(0)
            })
          }, 0)
          return { selfTestHostLossScheduled: true }
        }
        return manager.health()
      case METHOD_REGISTRY.workspaceList:
        if ('includeArchived' in params && typeof params.includeArchived !== 'boolean') {
          throw new HostControlError(
            ERROR_CODES.invalidArgument,
            'Control parameter includeArchived must be a boolean'
          )
        }
        return database.listWorkspaces(params.includeArchived === true)
      case METHOD_REGISTRY.workspaceCreate:
        if (!isWorkspaceCreateParams(params)) {
          throw new HostControlError(ERROR_CODES.invalidArgument, 'Workspace create parameters are invalid')
        }
        return database.createWorkspace(
          typeof params.defaultCwd === 'string'
            ? { ...params, defaultCwd: resolveHomeDirectory(params.defaultCwd) }
            : params
        )
      case METHOD_REGISTRY.workspaceUpdate:
        if (!isWorkspaceUpdateParams(params)) {
          throw new HostControlError(ERROR_CODES.invalidArgument, 'Workspace update parameters are invalid')
        }
        return database.updateWorkspace(
          typeof params.defaultCwd === 'string'
            ? { ...params, defaultCwd: resolveHomeDirectory(params.defaultCwd) }
            : params
        )
      case METHOD_REGISTRY.sessionCreate: {
        if (!isSessionCreateParams(params)) {
          throw new HostControlError(
            ERROR_CODES.invalidArgument,
            'Session create parameters are invalid'
          )
        }
        const createParams: CreateSessionParams = {
          workspaceId: params.workspaceId,
          name: params.name,
          ...('backgroundChoice' in params ? { backgroundChoice: params.backgroundChoice ?? null } : {}),
          cwd: stringValue(params, 'cwd'),
          executable: stringValue(params, 'executable'),
          argv: params.argv,
          cols: numberValue(params, 'cols'),
          rows: numberValue(params, 'rows')
        }
        const created = await manager.create(createParams)
        void companionService.sessionsChanged().catch(() => undefined)
        return created
      }
      case METHOD_REGISTRY.sessionList:
        return (await database.listSessions(stringValue(params, 'workspaceId')))
          .map((record) => manager.sessionWithCurrentProcessState(record))
      case METHOD_REGISTRY.sessionUpdate: {
        if (!isSessionUpdateParams(params)) {
          throw new HostControlError(ERROR_CODES.invalidArgument, 'Session update parameters are invalid')
        }
        const update = typeof params.cwd === 'string'
          ? { ...params, cwd: resolveHomeDirectory(params.cwd) }
          : params
        if (update.archived === true) {
          const current = await findStoredSession(database, update.sessionId)
          if (!current) throw new HostControlError(ERROR_CODES.notFound, 'The session was not found')
          if (manager.sessionWithCurrentProcessState(current).lastProcess?.state === 'live') {
            throw new HostControlError(ERROR_CODES.invalidArgument, 'Stop the session before archiving it')
          }
        }
        if ('cwd' in update || 'executable' in update || 'argv' in update) {
          const current = await findStoredSession(database, update.sessionId)
          if (!current) throw new HostControlError(ERROR_CODES.notFound, 'The session was not found')
          await validateLaunch({
            cwd: update.cwd ?? current.cwd,
            executable: update.executable ?? current.executable,
            argv: update.argv ?? current.argv,
            cols: 80,
            rows: 24
          })
        }
        return manager.sessionWithCurrentProcessState(await database.updateSession(update))
      }
      case METHOD_REGISTRY.sessionBindingGet:
        return manager.conversationBinding(stringValue(params, 'sessionId'))
      case METHOD_REGISTRY.sessionBindingReplace:
        return manager.replaceConversationBinding(
          params.binding as ExplicitConversationBinding
        )
      case METHOD_REGISTRY.sessionBindingClear:
        return manager.clearConversationBinding(stringValue(params, 'sessionId'))
      case METHOD_REGISTRY.sessionResume:
        if (!terminalPort) {
          throw new HostControlError(
            ERROR_CODES.ioError,
            'The terminal byte channel is not connected',
            true
          )
        }
        return manager.resume({
          sessionId: stringValue(params, 'sessionId'),
          cols: numberValue(params, 'cols'),
          rows: numberValue(params, 'rows')
        })
      case METHOD_REGISTRY.sessionRelaunch:
        if (!terminalPort) {
          throw new HostControlError(
            ERROR_CODES.ioError,
            'The terminal byte channel is not connected',
            true
          )
        }
        return manager.relaunch({
          sessionId: stringValue(params, 'sessionId'),
          cols: numberValue(params, 'cols'),
          rows: numberValue(params, 'rows')
        })
      case METHOD_REGISTRY.sessionStop:
        if (!isSessionStopParams(params)) {
          throw new HostControlError(ERROR_CODES.invalidArgument, 'Session stop parameters are invalid')
        }
        await manager.stop(identity(params), params.cause)
        return { stopped: true }
      case METHOD_REGISTRY.templateList:
        return database.listTemplates()
      case METHOD_REGISTRY.templateCreate:
        if (!isTemplateCreateParams(params)) {
          throw new HostControlError(ERROR_CODES.invalidArgument, 'Template create parameters are invalid')
        }
        return database.createTemplate({ ...params, cwd: resolveHomeDirectory(params.cwd) })
      case METHOD_REGISTRY.layoutGet:
        return database.getLayout(stringValue(params, 'workspaceId'))
      case METHOD_REGISTRY.layoutPut:
        return database.putLayout(
          stringValue(params, 'workspaceId'),
          numberValue(params, 'expectedRevision'),
          params.state as WorkspaceLayoutState
        )
      case METHOD_REGISTRY.terminalAttach: {
        if (!terminalPort) {
          throw new HostControlError(
            ERROR_CODES.ioError,
            'The terminal byte channel is not connected',
            true
          )
        }
        const attached = manager.attach(identity(params))
        return attached
      }
      case METHOD_REGISTRY.terminalActivate:
        return manager.activateAttachment(stringValue(params, 'attachmentId'))
      case METHOD_REGISTRY.terminalWrite: {
        const bytes = params.bytes
        if (!(bytes instanceof Uint8Array)) {
          throw new HostControlError(
            ERROR_CODES.invalidArgument,
            'Control parameter bytes must be a byte array'
          )
        }
        manager.write({ attachmentId: stringValue(params, 'attachmentId'), bytes })
        return { accepted: bytes.byteLength }
      }
      case METHOD_REGISTRY.terminalResize:
        return manager.resize({
          attachmentId: stringValue(params, 'attachmentId'),
          cols: numberValue(params, 'cols'),
          rows: numberValue(params, 'rows')
        })
      case METHOD_REGISTRY.terminalDetach:
        manager.detach({ attachmentId: stringValue(params, 'attachmentId') })
        return { detached: true }
      case METHOD_REGISTRY.terminalSnapshotSave:
        return manager.saveTerminalSnapshot(
          identity(params),
          {
            capturedAt: stringValue(params, 'capturedAt'),
            content: textValue(params, 'content'),
            retainedLines: numberValue(params, 'retainedLines'),
            snapshotTruncated: booleanValue(params, 'snapshotTruncated'),
            snapshotDroppedLines: numberValue(params, 'snapshotDroppedLines'),
            snapshotDroppedBytes:
              params.snapshotDroppedBytes === null
                ? null
                : numberValue(params, 'snapshotDroppedBytes'),
            transportDroppedBytes: numberValue(params, 'transportDroppedBytes')
          },
          {
            viewEpoch: stringValue(params, 'viewEpoch'),
            captureStartedAt: stringValue(params, 'captureStartedAt'),
            processState: savedOutputProcessStateValue(params, 'processState')
          }
        )
      case METHOD_REGISTRY.terminalFinalCaptureUnavailable:
        return manager.recordFinalCaptureUnavailable(identity(params), {
          viewEpoch: stringValue(params, 'viewEpoch'),
          captureStartedAt: stringValue(params, 'captureStartedAt'),
          unavailableAt: stringValue(params, 'unavailableAt'),
          reason: savedOutputUnavailableReasonValue(params, 'reason'),
          detail: stringValue(params, 'detail'),
          processState: savedOutputProcessStateValue(params, 'processState')
        })
      case METHOD_REGISTRY.terminalSavedOutputGet:
        return routeTerminalSavedOutputGet(
          manager,
          {
            sessionId: stringValue(params, 'sessionId'),
            ...(typeof params.incarnationId === 'string'
              ? { incarnationId: params.incarnationId }
              : {})
          },
          typeof params.viewEpoch === 'string' ? params.viewEpoch : undefined
        )
    }
    const routed = await companionService.route(request.method, params)
    if (routed === UNROUTED) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The control method is not allowed')
    }
    return routed
  }

  parentPort.on('message', (event: ParentMessageEvent) => {
    if (
      event.data &&
      typeof event.data === 'object' &&
      (event.data as { kind?: unknown }).kind === 'host-shutdown'
    ) {
      const forcedExit = setTimeout(() => process.exit(0), 1_000)
      void companionService.close().then(() => database.close()).finally(() => {
        clearTimeout(forcedExit)
        process.exit(0)
      })
      return
    }
    if (
      event.data &&
      typeof event.data === 'object' &&
      (event.data as { kind?: unknown }).kind === 'terminal-port' &&
      event.ports[0]
    ) {
      connectTerminalPort(event.ports[0])
      return
    }
    const message = event.data as Partial<ControlMessage>
    const possibleRequest = message.request as Partial<RpcRequest> | undefined
    if (message.kind !== 'control-request' || !isRpcRequest(message.request)) {
      const id =
        possibleRequest &&
        (typeof possibleRequest.id === 'string' || typeof possibleRequest.id === 'number')
          ? possibleRequest.id
          : null
      parentPort.postMessage({
        kind: 'control-response',
        response: failure(
          id,
          ERROR_CODES.invalidArgument,
          'The control method or envelope is not allowed'
        )
      })
      return
    }
    const request = message.request
    void route(request)
      .then((result) => {
        const response: RpcSuccess = { jsonrpc: '2.0', id: request.id ?? null, result }
        parentPort.postMessage({ kind: 'control-response', response })
      })
      .catch((error: unknown) => {
        const hostError =
          error instanceof HostControlError
            ? error
            : error instanceof DatabaseClientError
              ? new HostControlError(error.code, error.message)
            : new HostControlError(
                ERROR_CODES.ioError,
                error instanceof Error ? error.message : 'The terminal host request failed'
              )
        parentPort.postMessage({
          kind: 'control-response',
          response: failure(
            request.id ?? null,
            hostError.code,
            hostError.message,
            hostError.retryable
          )
        })
      })
  })

  parentPort.postMessage({
    kind: 'host-ready',
    electronVersion: process.versions.electron ?? '',
    nativeModules: { nodePty: true, betterSqlite3: true },
    databasePath: join(roots.data, 'state.sqlite3'),
    schemaTables: initialized.schemaTables,
    database: initialized.database
  })
}

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown initialization error'
  process.stderr.write(`[ai-terminal] the terminal host cannot initialize: ${message.slice(0, 480)}\n`)
  process.exit(1)
})
