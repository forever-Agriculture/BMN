// MODULE: pty-host.ts - the host process: starts the database, sessions, the companion service and their workers, and answers the app's requests
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { QUIET_LEDGER_KEY } from './quiet-hours-delivery'
import {
  ERROR_CODES,
  METHOD_REGISTRY,
  PROTOCOL_VERSION,
  isCompatibleProtocol,
  isRpcRequest,
  isSessionCohortResumeParams,
  isRepositoryInspectParams,
  isSessionCreateParams,
  isSessionStopParams,
  isSessionUpdateParams,
  isTerminalAckMessage,
  isTerminalInputMessage,
  isWorkspaceCreateParams,
  isWorkspaceUpdateParams,
  type ExplicitConversationBinding,
  type HelloParams,
  type ProtocolErrorCode,
  type QuickLookSearchResult,
  type RpcFailure,
  type RpcId,
  type RpcRequest,
  type RpcSuccess,
  type SavedOutputProcessState,
  type SavedOutputUnavailableReason,
  type SessionRecord,
  type TerminalPortMessage,
  type WorkspaceLayoutState
} from '@bmn/protocol'
import { CompanionService, UNROUTED } from './companion-service'
import type { AnswerRequest } from './remote-answer'
import { DatabaseClientError, DatabaseWorkerClient } from './database-client'
import { readFileReference } from './file-reference-reader'
import { listQuickLookFolder, quickLookIdentity, quickLookRoot, quickLookSourceFolder, readQuickLookFile } from './quick-look'
import { QuickLookSearches } from './quick-look-search'
import { QuickLookSearchClient } from './quick-look-search-client'
import { searchFileReferences } from './file-reference-search'
import { inspectRepositoryIdentity } from './repository-identity'
import { readDevAutoRuns } from './dev-auto-runs'
import { isDevAutoRunsParams } from '@bmn/protocol'
import {
  isMessageTeamAnswerMessage, type MessageTeamAnswer, type MessageTeamQuestion, type MessageTeamQuestionMessage
} from '@bmn/protocol'

/** How long the host waits for the app's answer about a message's folder or provider before it reads none. */
const MESSAGE_TEAM_ANSWER_MS = 200
import { nativeLoadFailureMessage } from './native-load-error'
import { ensureApplicationRoots, resolveApplicationRoots } from './roots'
import { installBundledTerminfo } from './terminal-graphics'
import { FileSavedOutputStore } from './saved-output-store'
import { removeOriginals } from './artifact-files'
import { removePurgedFiles } from './archive-purge-files'
import { routeTerminalSavedOutputGet } from './saved-output-route'
import { type AgentHistoryAdapter } from './agent-history'
import { codexHistoryAdapter } from './agent-history-codex'
import { openCodeHistoryAdapter } from './agent-history-opencode'
import { conversationReferenceExists } from './conversation-binding'
import type { OpenReadOnly } from './agent-history-store'
import { testTelegramOrigin } from './telegram-connector'
import { TurnChangesClient } from './turn-changes-client'
import { TurnRetention } from './turn-changes-retention'
import { TURN_STORE_FOLDER } from './turn-changes-store'
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
    if (nativeFailureProbe && process.env.BMN_TEST_FAIL_NATIVE === moduleName) {
      throw new Error('self-test simulated missing dependency')
    }
    return nativeRequire(moduleName)
  } catch (error) {
    const repoRoot = process.env.BMN_REPO_ROOT ?? '<repo root>'
    process.stderr.write(`${nativeLoadFailureMessage(moduleName, error, repoRoot)}\n`)
    process.exit(1)
  }
}

const nodePty = loadNativeModule('node-pty') as Partial<NodePtyModule>
const BetterSqlite3 = loadNativeModule('better-sqlite3')

if (typeof nodePty.spawn !== 'function') {
  process.stderr.write(
    `${nativeLoadFailureMessage('node-pty', new Error('module does not export spawn'), process.env.BMN_REPO_ROOT ?? '<repo root>')}\n`
  )
  process.exit(1)
}
if (typeof BetterSqlite3 !== 'function') {
  process.stderr.write(
    `${nativeLoadFailureMessage('better-sqlite3', new Error('module does not export a database constructor'), process.env.BMN_REPO_ROOT ?? '<repo root>')}\n`
  )
  process.exit(1)
}

const parentPort = process.parentPort
if (!parentPort) {
  process.stderr.write('[BMN] the terminal host cannot start outside an Electron utility process.\n')
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
  savedOutputStore: FileSavedOutputStore,
  dataRoot: string
): Promise<void> {
  try {
    const purged = await database.purgeExpiredArchives()
    if (purged.sessionIds.length === 0 && purged.workspaceIds.length === 0) return
    // After the commit: a crash before this leaves only unused files, never a record without its file.
    const lines = await removePurgedFiles(purged, {
      savedOutput: async (sessionIds) => { await savedOutputStore.removeSessions(sessionIds) },
      originals: (originals) => removeOriginals(dataRoot, originals)
    })
    process.stderr.write(`${lines.join('\n')}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    process.stderr.write(`[BMN] archive cleanup failed: ${message.slice(0, 240)}\n`)
  }
}

/** The home agent stores are read from: the owner's, or the Electron self-test's own. */
function agentHome(): string {
  return process.env.BMN_SELF_TEST_HOME && process.argv.includes('--self-test-host') ? process.env.BMN_SELF_TEST_HOME : homedir()
}

/** Codex and OpenCode, pruned by their own delete commands (databases only ever opened read-only). */
function historyAdapters(): AgentHistoryAdapter[] {
  const home = agentHome()
  const open: OpenReadOnly = (path) => new (BetterSqlite3 as unknown as new (path: string, options: { readonly: true; fileMustExist: true }) =>
    ReturnType<OpenReadOnly>)(path, { readonly: true, fileMustExist: true })
  return [codexHistoryAdapter({ home, open }), openCodeHistoryAdapter({ home, open })]
}

async function start(): Promise<void> {
  const roots = resolveApplicationRoots()
  await ensureApplicationRoots(roots)
  const packagedTerminfo = join(process.resourcesPath, 'terminfo', 'x', 'xterm-sixel-256color')
  const developmentTerminfo = join(__dirname, '..', '..', 'resources', 'terminfo', 'x', 'xterm-sixel-256color')
  let terminfoAsset
  try {
    terminfoAsset = installBundledTerminfo(roots.data,
      existsSync(packagedTerminfo) ? packagedTerminfo : developmentTerminfo)
  } catch {
    // A missing asset leaves every new process on the standard TERM.
  }
  const database = new DatabaseWorkerClient(
    join(__dirname, 'database-worker.js'),
    join(roots.data, 'state.sqlite3')
  )
  const initialized = await database.initialize()
  const savedOutputStore = new FileSavedOutputStore(join(roots.state, 'saved-output'))
  await purgeExpiredArchives(database, savedOutputStore, roots.data)
  let terminalPort: TerminalPort | undefined
  let handshaken = false
  // The manager's callbacks run before the companion exists, so they read it through a holder.
  const companionHolder: { current?: CompanionService } = {}
  const manager = new SessionManager({
    ...(terminfoAsset ? { terminfoAsset } : {}),
    store: database,
    savedOutputStore,
    spawnPty: (executable, argv, options) =>
      nodePty.spawn!(executable, [...argv], {
        ...options,
        env: { ...options.env },
        encoding: null
      }),
    sendTerminalMessage: (message) => terminalPort?.postMessage(message),
    conversationReferenceExists,
    conversationBeingDeleted: (binding) => companionHolder.current?.historyDeleting(binding.conversationReference) ?? false,
    onSessionStateChange: (message) => {
      parentPort.postMessage(message)
      companionHolder.current?.sessionStateChanged(message.sessionId, message.state)
    },
    onOutput: (sessionId, bytes) => companionHolder.current?.sessionOutput(sessionId, bytes),
    // Main owns the clipboard and the owner's setting; the host only reports what a live program asked for.
    onProgramCopy: (message) => parentPort.postMessage(message),
    sessionEnvironment: (sessionIdentity) => companionHolder.current?.sessionEnvironment(sessionIdentity) ?? {},
    sessionPath: () => companionHolder.current?.sessionPath() ?? process.env.PATH ?? ''
  })
  const cliPath = process.env.BMN_CLI_PATH ?? join(__dirname, '..', '..', 'bin', 'bmn')
  /**
   * Questions about a message put to the app's entry point, each waiting for its answer. An answer that does
   * not come in time is a failure, which the caller reads as a refusal: a hook has 300 ms for everything.
   */
  const teamQuestions = new Map<string, { resolve(answer: MessageTeamAnswer): void; timer: NodeJS.Timeout }>()
  let teamQuestionNumber = 0
  const askTeam = (question: MessageTeamQuestion): Promise<MessageTeamAnswer> => new Promise((resolve) => {
    const id = `team-${++teamQuestionNumber}`
    const timer = setTimeout(() => {
      teamQuestions.delete(id)
      resolve({ failed: true })
    }, MESSAGE_TEAM_ANSWER_MS)
    teamQuestions.set(id, { resolve, timer })
    parentPort.postMessage({ kind: 'message-team-question', id, question } satisfies MessageTeamQuestionMessage)
  })
  let selfTestClock: Date | undefined
  const selfTestQuietTrace: Array<Record<string, unknown>> = []
  let stopSelfTestQuietTrace: (() => void) | undefined
  // Epic 69: the thread that captures work trees starts with its first request.
  const turnChanges = new TurnChangesClient(join(__dirname, 'turn-changes-worker.js'), { dataRoot: roots.data, home: agentHome() })
  const companion = new CompanionService({
    database,
    manager,
    turnChanges,
    roots,
    cliPath,
    ...(process.argv.includes('--self-test-host') ? { now: () => selfTestClock ?? new Date() } : {}),
    // Electron self-test only (Story 30.3): Telegram talks to the main process's local fake Bot API.
    ...(process.argv.includes('--self-test-host') && process.env.BMN_SELF_TEST_TELEGRAM_ORIGIN
      ? { telegramApiOrigin: process.env.BMN_SELF_TEST_TELEGRAM_ORIGIN }
      : {}),
    // A test-mode run (Story 76.8): Telegram talks to the run's own loopback fake Bot API.
    ...(testTelegramOrigin(process.argv, process.env) === null ? {} : { telegramApiOrigin: testTelegramOrigin(process.argv, process.env)! }),
    historyAdapters: historyAdapters(),
    // Electron self-test only (Story 62.2): the health watch reads a fixture tree and starts no nvidia-smi.
    ...(process.argv.includes('--self-test-host') && process.env.BMN_SELF_TEST_SYSFS_ROOT
      ? { health: { root: process.env.BMN_SELF_TEST_SYSFS_ROOT, run: () => Promise.reject(new Error('no nvidia-smi in the self-test')) } }
      : {}),
    ...(process.env.BMN_SELF_TEST_HOME && process.argv.includes('--self-test-host') ? { home: process.env.BMN_SELF_TEST_HOME } : {}),
    // Electron self-test only (Story 31.4): pages sooner, so every answer shape fits the run's time.
    ...(process.argv.includes('--self-test-host') && process.env.BMN_SELF_TEST_PAGE_AFTER_MS
      ? { pageAfterMs: Number(process.env.BMN_SELF_TEST_PAGE_AFTER_MS) }
      : {}),
    // Epic 66: the app's entry point alone reads the owner's team; this process only asks it (R60-NFR3).
    messageSourceRoot: async (folder) => {
      const answer = await askTeam({ kind: 'source-root', folder })
      if (!('root' in answer)) throw new Error('The app did not answer for the folder')
      return answer.root
    },
    messageProviderAnswer: async (destination, senderRoot) => {
      const answer = await askTeam({ kind: 'provider', destination, senderRoot })
      if (!('allowed' in answer)) throw new Error('The app did not answer for the approved team')
      return answer
    },
    emit: (message) => parentPort.postMessage(message)
  })
  companionHolder.current = companion
  await companion.start()
  const companionService = companion
  // Epic 69: the sweep removes what turn changes may no longer keep, now (after the archive purge wrote its
  // jobs) and every hour.
  new TurnRetention({
    database: {
      keepDays: async () => (await database.companion('getSettings')).agentHistory.confirmedKeepDays,
      sweep: (sweep) => database.companion('sweepTurns', sweep),
      jobs: () => database.companion('listTurnRemovalJobs'),
      finish: (jobId) => database.companion('finishTurnRemovalJob', jobId),
      fail: (failure) => database.companion('failTurnRemovalJob', failure),
      named: () => database.companion('namedTurnCaptures')
    },
    keeper: turnChanges,
    storePresent: () => existsSync(join(roots.data, TURN_STORE_FOLDER)),
    log: (line) => process.stderr.write(line),
    changed: () => companionService.turnsChanged()
  }).start()
  function connectTerminalPort(port: TerminalPort): void {
    terminalPort = port
    port.on('message', (event) => {
      try {
        if (isTerminalInputMessage(event.data)) manager.write(event.data)
        else if (isTerminalAckMessage(event.data)) manager.acknowledge(event.data)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid terminal transport message'
        process.stderr.write(`[BMN] terminal transport rejected: ${message.slice(0, 240)}\n`)
      }
    })
    port.on('close', () => {
      if (terminalPort !== port) return
      terminalPort = undefined
      manager.rendererDisconnected()
    })
    port.start()
  }

  /**
   * Electron self-test only: the two health.get requests the self-test uses to end this host abruptly
   * (host loss) and to answer an open request at a key the way a Telegram tap will (Epic 30.2).
   * Undefined for every other request and for any host not started with `--self-test-host`; the control
   * socket never reaches it.
   */
  function selfTestHealthProbe(params: Record<string, unknown>): Promise<unknown> | undefined {
    if (!process.argv.includes('--self-test-host')) return undefined
    if (typeof params.selfTestQuietTrace === 'boolean') {
      stopSelfTestQuietTrace?.(); stopSelfTestQuietTrace = undefined
      if (!params.selfTestQuietTrace) return Promise.resolve({ stopped: true })
      selfTestQuietTrace.length = 0
      const quiet = companionService['quietDelivery'], deps = quiet['deps']
      const before = quiet.before.bind(quiet), maySend = quiet.maySend.bind(quiet), settle = quiet.settle.bind(quiet)
      const page = deps.page, summary = deps.sendSummary
      const trace = (step: string, identity: { requestId?: string; revision?: number }, result: unknown): void => {
        if (selfTestQuietTrace.length < 40) selfTestQuietTrace.push({ seq: selfTestQuietTrace.length, step, ...identity,
          result, away: companionService['ownerAway'](), ready: deps.ready() })
      }
      const failure = (error: unknown): string => error instanceof Error ? error.name : 'unknown'
      quiet.before = async record => {
        try { const result = await before(record); trace('before', { requestId: record.requestId, revision: record.revision },
          result.action === 'hold' ? result.reason ?? 'hold' : result.action); return result }
        catch (error) { trace('before-error', { requestId: record.requestId, revision: record.revision }, failure(error)); throw error }
      }
      quiet.maySend = (record, managed) => {
        const result = maySend(record, managed); trace('maySend', { requestId: record.requestId, revision: record.revision }, result); return result
      }
      quiet.settle = async (claim, outcome) => {
        const entry = quiet['ledger']?.entries.find(entry => 'claim' in entry && entry.claim === claim)
        const identity = entry && 'requestId' in entry ? { requestId: entry.requestId, revision: entry.revision } : {}
        try { await settle(claim, outcome); trace('settle', identity, outcome) }
        catch (error) { trace('settle-error', identity, failure(error)); throw error }
      }
      deps.page = async record => {
        const identity = { requestId: record.requestId, revision: record.revision }; trace('page', identity, 'start')
        try { const result = await page(record); trace('page-end', identity, result); return result }
        catch (error) { trace('page-error', identity, failure(error)); throw error }
      }
      deps.sendSummary = async text => {
        trace('summary', {}, 'start')
        try { await summary(text); trace('summary-end', {}, true) }
        catch (error) { trace('summary-error', {}, failure(error)); throw error }
      }
      stopSelfTestQuietTrace = () => { quiet.before = before; quiet.maySend = maySend; quiet.settle = settle; deps.page = page; deps.sendSummary = summary }
      return Promise.resolve({ tracing: true })
    }
    if (Array.isArray(params.selfTestQuietSnapshot) && params.selfTestQuietSnapshot.length <= 2 &&
      params.selfTestQuietSnapshot.every(id => typeof id === 'string')) {
      if (params.selfTestQuietExit !== undefined && (typeof params.selfTestQuietExit !== 'string' || params.selfTestQuietExit.length > 200)) {
        return Promise.reject(new Error('Invalid self-test exit identity'))
      }
      return (async () => {
        const ids = params.selfTestQuietSnapshot as string[]
        const members = await database.companion('listQuietAttention')
        const cards = await database.companion('listTelegramCards', ['buttons', 'open', 'sending', 'final'])
        const rows = await Promise.all(ids.map(async id => {
          const row = await database.companion('getAttention', id)
          return { id, kind: row.kind, revision: row.revision, state: row.state, seen: row.seenAt !== null, expires: row.expiresAt,
            member: members.some(item => item.record.requestId === id), eligible: members.find(item => item.record.requestId === id)?.eligible ?? false,
            delivered: await database.companion('quietDelivered', id, row.revision), card: cards.some(card => card.requestId === id && card.revision === row.revision) }
        }))
        const quiet = companionService['quietDelivery']
        return { rows, ready: companionService['telegramReady'], health: companionService['telegramHealth']?.state,
          away: companionService['ownerAway'](), flushing: !!quiet['flushing'], permits: quiet['permits'].size,
          exitHeld: quiet['ledger']?.entries.some(entry => 'sessionId' in entry && entry.sessionId === params.selfTestQuietExit) ?? false,
          trace: [...selfTestQuietTrace] }
      })()
    }
    if (params.selfTestQuietClock !== undefined) {
      const value = params.selfTestQuietClock
      if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) {
        return Promise.reject(new Error('Invalid self-test clock'))
      }
      selfTestClock = value === null ? undefined : new Date(value as string)
      return companionService['sweepAttention']().then(async () => ({ selfTestQuietClock: value,
        ledger: await database.companion('getRawSetting', QUIET_LEDGER_KEY),
        digest: await database.companion('getRawSetting', 'dev-auto-morning-digest-v1') }))
        // The sweep starts the health check without waiting for it; the self-test reads its stored state after it.
        .then(async receipt => { await companionService['healthAlerts'].sweep(); return { ...receipt, health: await database.companion('getRawSetting', 'health-alerts-v1') } })
    }
    if (params.selfTestHostLoss === true) {
      setTimeout(() => {
        void database.close().then(() => {
          parentPort.postMessage({ kind: 'host-loss-self-test-ready' })
          manager.abandonForHostLossSelfTest()
          process.exit(0)
        })
      }, 0)
      return Promise.resolve({ selfTestHostLossScheduled: true })
    }
    if (typeof params.selfTestTurns === 'string') {
      // Epic 69: a session's turns as their rows hold them, once nothing of them is waited for. The window
      // gets its own channels for them in Story 69.5; no token reads them.
      const sessionId = params.selfTestTurns
      return (async () => {
        await companionService.turnsIdle()
        return { selfTestTurns: await database.companion('listTurns', { sessionId, limit: 50 }) }
      })()
    }
    if (typeof params.selfTestTurnsForget === 'string') {
      // Epic 69: the keep rule with no day left removes every turn now, as a sweep at its hour would, and
      // leaves the jobs for their bytes waiting; the window is told as after any sweep.
      return (async () => {
        await companionService.turnsIdle()
        const swept = await database.companion('sweepTurns', { now: new Date().toISOString(), keepDays: 0 })
        companionService.turnsChanged()
        return { selfTestTurnsForget: swept }
      })()
    }
    if (typeof params.selfTestTurnsRetryNow === 'string') {
      // Story 75.4: each pause of the session's recording is due its next try now, as if its wait had passed; its
      // next turn is the probe. Nothing the owner does resumes it.
      const sessionId = params.selfTestTurnsRetryNow
      return (async () => {
        await companionService.turnsIdle()
        const paused = companionService['turns']?.['sessions'].get(sessionId)?.paused
        for (const pause of paused?.values() ?? []) pause.retryAt = companionService['now']().getTime()
        return { selfTestTurnsRetryNow: paused?.size ?? 0 }
      })()
    }
    if (params.selfTestRemoteAnswer === undefined) return undefined
    const probe = record(params.selfTestRemoteAnswer)
    return (async () => {
      const rows = await database.companion('listAttention')
      const open = rows.find((row) => row.sessionId === probe.sessionId && row.requestKey === probe.requestKey && row.state === 'open')
      if (!open) return { selfTestRemoteAnswer: { outcome: null, request: null } }
      const outcome = await companionService.answerAttention({
        requestId: open.requestId,
        revision: open.revision,
        epoch: companionService.answerEpoch(open.requestId) ?? -1,
        incarnationId: open.incarnationId ?? '',
        answer: probe.answer as AnswerRequest['answer']
      })
      return { selfTestRemoteAnswer: { outcome, request: await database.companion('getAttention', open.requestId) } }
    })()
  }

  /**
   * Quick look's source (Story 67.1): a session's launch folder, its stored folder once stopped, or a live workspace's
   * folder. Every Quick look call names one, so a closed session or an archived workspace reads nothing more.
   */
  async function quickLookFolderFor(params: Record<string, unknown>): Promise<string | null> {
    if ((params.sessionId !== undefined) === (params.workspaceId !== undefined)) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'Choose exactly one source session or workspace')
    }
    if (params.workspaceId !== undefined) {
      const workspaceId = stringValue(params, 'workspaceId')
      const workspace = (await database.listWorkspaces(true)).find(record => record.workspaceId === workspaceId && record.archivedAt === null)
      if (!workspace) throw new HostControlError(ERROR_CODES.notFound, 'The source workspace is unavailable')
      return quickLookSourceFolder({ kind: 'workspace', folder: workspace.defaultCwd ?? null })
    }
    const sessionId = stringValue(params, 'sessionId')
    const session = await findStoredSession(database, sessionId)
    if (!session) throw new HostControlError(ERROR_CODES.notFound, 'The source session no longer exists')
    return quickLookSourceFolder({ kind: 'session', liveLaunchDirectory: manager.liveLaunchDirectory(sessionId) ?? null, storedCwd: session.cwd })
  }

  const quickLookSearches = new QuickLookSearches()
  // A file's masking and matching can take longer than a terminal may wait, so the contents search runs in its own thread.
  const quickLookContents = new QuickLookSearchClient(join(__dirname, 'quick-look-search-worker.js'))

  /**
   * Quick look's top field (Story 67.5): "Go to file" through the name search, or "Contents". The root must be the
   * source's folder or the Git root above it, the two roots the sheet offers.
   */
  async function quickLookSearch(params: Record<string, unknown>): Promise<QuickLookSearchResult> {
    const ownerId = stringValue(params, 'ownerId')
    const requestId = stringValue(params, 'requestId')
    const root = stringValue(params, 'root')
    const query = textValue(params, 'query')
    const mode = params.mode
    if (mode !== 'files' && mode !== 'contents') throw new HostControlError(ERROR_CODES.invalidArgument, 'Control parameter mode is invalid')
    return quickLookSearches.checkedRun(ownerId, requestId, async () => {
      const roots = await quickLookRoot(await quickLookFolderFor(params))
      if (roots.status !== 'ready' || (root !== roots.sessionFolder && root !== roots.gitRoot)) {
        throw new HostControlError(ERROR_CODES.invalidArgument, 'Search only the folder Quick look shows')
      }
    }, async (signal) => mode === 'files'
      ? { mode: 'files' as const, ...(await searchFileReferences(root, query, signal)) }
      : quickLookContents.contents(root, { query, matchCase: params.matchCase === true, wholeWord: params.wholeWord === true }, signal))
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
        return selfTestHealthProbe(params) ?? manager.health()
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
        {
          const created = await database.createWorkspace(
            typeof params.defaultCwd === 'string'
              ? { ...params, defaultCwd: resolveHomeDirectory(params.defaultCwd) }
              : params
          )
          companionService.catalogueChanged()
          return created
        }
      case METHOD_REGISTRY.workspaceUpdate:
        if (!isWorkspaceUpdateParams(params)) {
          throw new HostControlError(ERROR_CODES.invalidArgument, 'Workspace update parameters are invalid')
        }
        {
          const finish = params.archived === true
            ? companionService.beginFileReferenceAvailabilityChange() : () => undefined
          try {
            const mutate = () => database.updateWorkspace(
              typeof params.defaultCwd === 'string'
                ? { ...params, defaultCwd: resolveHomeDirectory(params.defaultCwd) }
                : params
            )
            const updated = await (params.archived === true ? manager.archiveWorkspace(params.workspaceId, mutate) : mutate())
            companionService.catalogueChanged()
            // Turn changes are recorded in every unarchived workspace: archiving or restoring one takes effect at once.
            if (params.archived !== undefined) await companionService.sessionsChanged().catch(() => undefined)
            return updated
          } finally {
            finish()
          }
        }
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
          ...('terminalGraphics' in params ? { terminalGraphics: params.terminalGraphics ?? null } : {}),
          cwd: stringValue(params, 'cwd'),
          executable: stringValue(params, 'executable'),
          argv: params.argv,
          cols: numberValue(params, 'cols'),
          rows: numberValue(params, 'rows')
        }
        const created = await manager.create(createParams)
        companionService.catalogueChanged()
        void companionService.sessionsChanged().catch(() => undefined)
        return created
      }
      case METHOD_REGISTRY.sessionList:
        return (await database.listSessions(stringValue(params, 'workspaceId')))
          .map((record) => manager.sessionWithCurrentProcessState(record))
      case METHOD_REGISTRY.devAutoRuns: {
        if (!isDevAutoRunsParams(params)) throw new HostControlError(ERROR_CODES.invalidArgument, 'Run view parameters are invalid')
        const workspaces = await database.listWorkspaces()
        const sessions = (await Promise.all(workspaces.filter((workspace) => workspace.archivedAt === null)
          .map((workspace) => database.listSessions(workspace.workspaceId)))).flat()
          .map((session) => manager.sessionWithCurrentProcessState(session))
        const liveDirectories = new Map(sessions.flatMap(session => {
          const directory = manager.liveLaunchDirectory(session.sessionId)
          return directory ? [[session.sessionId, directory] as const] : []
        }))
        return readDevAutoRuns(workspaces, sessions, await database.companion('listAttention'), params.workspaceId, undefined, liveDirectories)
      }
      case METHOD_REGISTRY.repositoryInspect:
        if (!isRepositoryInspectParams(params)) {
          throw new HostControlError(ERROR_CODES.invalidArgument, 'Repository inspection parameters are invalid')
        }
        return {
          ...await inspectRepositoryIdentity(resolveHomeDirectory(params.directory)),
          directory: params.directory
        }
      case METHOD_REGISTRY.sessionUpdate: {
        if (!isSessionUpdateParams(params)) {
          throw new HostControlError(ERROR_CODES.invalidArgument, 'Session update parameters are invalid')
        }
        const update = typeof params.cwd === 'string'
          ? { ...params, cwd: resolveHomeDirectory(params.cwd) }
          : params
        const finish = update.archived === true || typeof update.workspaceId === 'string'
          ? companionService.beginFileReferenceAvailabilityChange() : () => undefined
        try {
          const mutate = async (): Promise<SessionRecord> => {
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
          const updated = await (typeof update.archived === 'boolean' || typeof update.workspaceId === 'string'
            ? manager.updateSessionAvailability(update.sessionId, update, mutate) : mutate())
          companionService.catalogueChanged()
          // Epic 69: a session moved to another workspace follows that workspace's switch for turn changes.
          if (typeof update.workspaceId === 'string') await companionService.sessionsChanged().catch(() => undefined)
          return updated
        } finally {
          finish()
        }
      }
      case METHOD_REGISTRY.sessionBindingGet:
        return manager.conversationBinding(stringValue(params, 'sessionId'))
      case METHOD_REGISTRY.sessionBindingReplace:
        return manager.replaceConversationBinding(
          params.binding as ExplicitConversationBinding
        )
      case METHOD_REGISTRY.sessionResumePreview:
        return manager.conversationResumePreview(stringValue(params, 'sessionId'))
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
          rows: numberValue(params, 'rows'),
          ...(params.expectedCommand === undefined ? {} : { expectedCommand: stringValue(params, 'expectedCommand') })
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
      case METHOD_REGISTRY.sessionCohortList:
        return manager.interruptedCohort()
      case METHOD_REGISTRY.sessionCohortOffered:
        return manager.markCohortOffered(stringValue(params, 'cohortId'))
      case METHOD_REGISTRY.sessionCohortResume:
        if (!terminalPort) {
          throw new HostControlError(
            ERROR_CODES.ioError,
            'The terminal byte channel is not connected',
            true
          )
        }
        if (!isSessionCohortResumeParams(params)) {
          throw new HostControlError(
            ERROR_CODES.invalidArgument,
            'Session cohort resume parameters are invalid'
          )
        }
        return manager.resumeCohort(params)
      case METHOD_REGISTRY.sessionStop:
        if (!isSessionStopParams(params)) {
          throw new HostControlError(ERROR_CODES.invalidArgument, 'Session stop parameters are invalid')
        }
        await manager.stop(identity(params), params.cause)
        return { stopped: true }
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
      case METHOD_REGISTRY.terminalModesReset:
        return manager.resetTerminalModes(identity(params))
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
      case METHOD_REGISTRY.quickLookRoot:
        return quickLookRoot(await quickLookFolderFor(params))
      case METHOD_REGISTRY.quickLookList:
        await quickLookFolderFor(params)
        return listQuickLookFolder(stringValue(params, 'folder'))
      case METHOD_REGISTRY.quickLookRead:
        await quickLookFolderFor(params)
        return readQuickLookFile(stringValue(params, 'path'))
      case METHOD_REGISTRY.quickLookIdentity:
        await quickLookFolderFor(params)
        return quickLookIdentity(stringValue(params, 'path'))
      case METHOD_REGISTRY.quickLookSearch:
        return quickLookSearch(params)
      case METHOD_REGISTRY.quickLookSearchCancel:
        quickLookSearches.cancel(stringValue(params, 'ownerId'), stringValue(params, 'requestId'))
        return { cancelled: true }
      case METHOD_REGISTRY.fileReferenceRead: {
        if ((params.sessionId !== undefined) === (params.workspaceId !== undefined)) {
          throw new HostControlError(ERROR_CODES.invalidArgument, 'Choose exactly one source session or workspace')
        }
        if (params.workspaceId !== undefined) {
          const workspaceId = stringValue(params, 'workspaceId')
          const workspace = (await database.listWorkspaces(true)).find(record => record.workspaceId === workspaceId && record.archivedAt === null)
          if (!workspace) throw new HostControlError(ERROR_CODES.notFound, 'The source workspace is unavailable')
          const result = await readFileReference({ workspaceId, reference: params.reference,
            baseDirectory: params.baseDirectory, launchDirectory: workspace.defaultCwd ?? '/' })
          const current = (await database.listWorkspaces(true)).find(record => record.workspaceId === workspaceId)
          if (!current || current.archivedAt !== null || current.revision !== workspace.revision) {
            throw new HostControlError(ERROR_CODES.revisionConflict, 'The source workspace changed; open the pin again')
          }
          return result
        }
        const sessionId = stringValue(params, 'sessionId')
        const session = await findStoredSession(database, sessionId)
        if (!session) throw new HostControlError(ERROR_CODES.notFound, 'The source session no longer exists')
        return readFileReference({
          sessionId,
          reference: params.reference,
          baseDirectory: params.baseDirectory,
          launchDirectory: manager.liveLaunchDirectory(sessionId) ?? session.cwd
        })
      }
    }
    const routed = await companionService.route(request.method, params)
    if (routed === UNROUTED) {
      throw new HostControlError(ERROR_CODES.invalidArgument, 'The control method is not allowed')
    }
    return routed
  }

  parentPort.on('message', (event: ParentMessageEvent) => {
    if (isMessageTeamAnswerMessage(event.data)) {
      const pending = teamQuestions.get(event.data.id)
      if (!pending) return
      teamQuestions.delete(event.data.id)
      clearTimeout(pending.timer)
      pending.resolve(event.data.answer)
      return
    }
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
  process.stderr.write(`[BMN] the terminal host cannot initialize: ${message.slice(0, 480)}\n`)
  process.exit(1)
})
