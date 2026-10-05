import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  ERROR_CODES,
  SAVED_OUTPUT_FORMAT_VERSION,
  TERMINAL_SAVED_OUTPUT_BYTES,
  TERMINAL_SCROLLBACK_LINES,
  type ConversationObservationResult,
  type ExplicitConversationBinding,
  type PersistedConversationBinding,
  type SavedOutputCapture,
  type SavedOutputFinalCaptureUnavailable,
  type SavedOutputSnapshot,
  type SessionRecord,
  type ProgramCopyMessage,
  type TerminalPortMessage,
  type TerminalViewDisconnectReason,
  type WorkspaceRecord
} from '@bmn/protocol'
import {
  HostControlError,
  POWERSHELL_CLI_PATH_RESTORE,
  PersistedSessionStartError,
  SessionManager,
  buildShellEnvironment,
  findStoredSession,
  resolveHomeDirectory,
  type CreateResumingRecord,
  type CreateStartingRecord,
  type IncarnationExit,
  type PtyLike,
  type SavedOutputStore,
  type SessionIdentity,
  type SessionStore
} from './session-manager'
import { AgentHistory, emptyHistoryState, type AgentHistoryAdapter } from './agent-history'
import { FileSavedOutputStore } from './saved-output-store'
import { windowsEnvironment } from './windows-launch'
import {
  APPLICATION_INTERRUPTION_REASON,
  databaseSettings,
  initializeDatabase,
  type DatabaseConnection
} from './database-initialization'
import { captureRelevantLaunchEnvironment, shownCommand } from './conversation-binding'
import {
  clearReportedResume,
  clearSessionConversationBinding,
  createResumingSession,
  createStartingSession,
  setReportedResume,
  getSessionConversationBinding,
  markCohortOffered,
  markSessionExited,
  markSessionInterrupted,
  markSessionRunning,
  replaceSessionConversationBinding,
  selectInterruptedIncarnations
} from './database-session-store'
import { createWorkspace, listSessions, listWorkspaces, updateSession } from './database-workspace-store'
import { missingProgramReason } from './reported-resume'
import { installBundledTerminfo } from './terminal-graphics'
import { TerminalByteFramer, type TerminalFrame } from './terminal-byte-framer'
import { HostOutputQueue } from './transport'
import { generatedTerminalOutput, pick, seeded } from './test-fixtures/terminal-output'
import { XtermStream } from './test-fixtures/xterm-parser'
import type { InterruptedIncarnationRow } from './interrupted-cohort'

const testRequire = createRequire(import.meta.url)
const nodePty = testRequire('node-pty') as {
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
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const createdRoots = new Set<string>()
const encoder = new TextEncoder()
const DEFAULT_SESSION_CREATION = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  name: 'Shell'
} as const

function validCapture(overrides: Partial<SavedOutputCapture> = {}): SavedOutputCapture {
  return {
    capturedAt: '2026-09-12T08:00:00.000Z',
    content: 'saved plain text',
    retainedLines: 1,
    snapshotTruncated: false,
    snapshotDroppedLines: 0,
    snapshotDroppedBytes: 0,
    transportDroppedBytes: 0,
    ...overrides
  }
}
const claudeHelp = readFileSync(
  new URL('./test-fixtures/claude-2.1.270-help.txt', import.meta.url),
  'utf8'
).replaceAll('\r\n', '\n')

function terminalOutput(sent: TerminalPortMessage[], attachmentId: string): Uint8Array {
  const chunks = sent.flatMap((message) =>
    message.kind === 'terminal-output' && message.attachmentId === attachmentId
      ? [message.bytes]
      : []
  )
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

type TerminalOutputMessage = Extract<TerminalPortMessage, { kind: 'terminal-output' }>

interface TerminalOutputFlowLike {
  attach(attachmentId: string): void
  detach(attachmentId: string): void
  accept(
    message: TerminalOutputMessage,
    actions: {
      write(bytes: Uint8Array, settled: () => void): void
      acknowledge(attachmentId: string, streamSeq: number): void
      recover(reason: TerminalViewDisconnectReason): void
    }
  ): boolean
}

const TERMINAL_OUTPUT_FLOW_MODULE = '../renderer/src/terminal-output-flow'

async function terminalFlowHarness(): Promise<{
  flow: TerminalOutputFlowLike
  sent: TerminalPortMessage[]
  writes: Uint8Array[]
  acknowledgements: number[]
  recoveries: string[]
  setAcknowledger: (
    acknowledge: (attachmentId: string, streamSeq: number) => void
  ) => void
  send: (message: TerminalPortMessage) => void
}> {
  const { TerminalOutputFlow } = await vi.importActual(TERMINAL_OUTPUT_FLOW_MODULE) as {
    TerminalOutputFlow: new () => TerminalOutputFlowLike
  }
  const flow = new TerminalOutputFlow()
  const sent: TerminalPortMessage[] = []
  const writes: Uint8Array[] = []
  const acknowledgements: number[] = []
  const recoveries: string[] = []
  let acknowledge: (attachmentId: string, streamSeq: number) => void = () => undefined
  return {
    flow,
    sent,
    writes,
    acknowledgements,
    recoveries,
    setAcknowledger: (next) => {
      acknowledge = next
    },
    send: (message) => {
      sent.push(message)
      if (message.kind !== 'terminal-output') return
      flow.accept(message, {
        write: (bytes, settled) => {
          writes.push(bytes)
          settled()
        },
        acknowledge: (attachmentId, streamSeq) => {
          acknowledgements.push(streamSeq)
          acknowledge(attachmentId, streamSeq)
        },
        recover: (reason) => recoveries.push(reason)
      })
    }
  }
}

function decoded(chunks: readonly Uint8Array[]): string {
  return chunks.map((chunk) => new TextDecoder().decode(chunk)).join('')
}

function writeTerminal(terminal: Terminal, data: Uint8Array): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all([...createdRoots].map((root) => rm(root, { recursive: true, force: true })))
  createdRoots.clear()
})

class FakePty implements PtyLike {
  readonly pid = 4242
  cols = 80
  rows = 24
  readonly writes: Array<string | Uint8Array> = []
  killed = false
  paused = false
  private dataListener: ((data: string | Uint8Array) => void) | undefined
  private exitListener: ((exit: IncarnationExit) => void) | undefined

  onData(listener: (data: string | Uint8Array) => void): { dispose(): void } {
    this.dataListener = listener
    return { dispose: () => (this.dataListener = undefined) }
  }

  onExit(listener: (exit: IncarnationExit) => void): { dispose(): void } {
    this.exitListener = listener
    return { dispose: () => (this.exitListener = undefined) }
  }

  write(data: string | Uint8Array): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
  }

  kill(): void {
    this.killed = true
    this.exitListener?.({ exitCode: 0 })
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  emit(data: string | Uint8Array): void {
    this.dataListener?.(data)
  }

  emitExit(exit: IncarnationExit): void {
    this.exitListener?.(exit)
  }
}

class NonExitingFakePty extends FakePty {
  killCalls = 0

  override kill(): void {
    this.killCalls += 1
    this.killed = true
  }
}

class SignalExitFakePty extends FakePty {
  override kill(): void {
    this.killed = true
    this.emitExit({ exitCode: 0, signal: 15 })
  }
}

function sqliteSessionStore(database: DatabaseConnection): SessionStore {
  return {
    listWorkspaces: async (includeArchived) => listWorkspaces(database, includeArchived),
    listSessions: async (workspaceId) => listSessions(database, workspaceId),
    createStarting: async (record) => createStartingSession(database, record),
    createResuming: async (record) => createResumingSession(database, record),
    getConversationBinding: async (sessionId) => getSessionConversationBinding(database, sessionId),
    replaceConversationBinding: async (binding) => replaceSessionConversationBinding(database, binding),
    clearConversationBinding: async (sessionId) => clearSessionConversationBinding(database, sessionId),
    setReportedResume: async (record) => setReportedResume(database, record),
    clearReportedResume: async (record) => clearReportedResume(database, record),
    markRunning: async (incarnationId) => markSessionRunning(database, incarnationId),
    markExited: async (incarnationId, exit) => markSessionExited(database, incarnationId, exit),
    markInterrupted: async (incarnationId, reason) => markSessionInterrupted(database, incarnationId, reason),
    listInterruptedIncarnations: async () => selectInterruptedIncarnations(database),
    markCohortOffered: async (incarnationIds, offeredAt) =>
      markCohortOffered(database, incarnationIds, offeredAt),
    health: async () => ({
      runningIncarnations: Number((database
        .prepare("SELECT COUNT(*) AS count FROM process_incarnation WHERE state IN ('starting', 'running')")
        .get() as { count: number }).count)
    })
  }
}

function completeCapabilityProbe(
  pty: FakePty,
  output = claudeHelp,
  exitCode = 0
): void {
  queueMicrotask(() => {
    pty.emit(output)
    pty.emitExit({ exitCode })
  })
}

class FakeStore implements SessionStore {
  /** Rows a test seeds when it exercises the resume-after-stop offer; empty for every other test. */
  readonly interruptedIncarnations: InterruptedIncarnationRow[] = []
  readonly cohortOffers: Array<{ incarnationIds: readonly string[]; offeredAt: string }> = []
  readonly starting: string[] = []
  readonly startingRecords: CreateStartingRecord[] = []
  readonly resuming: string[] = []
  readonly bindings = new Map<string, PersistedConversationBinding>()
  readonly running = new Set<string>()
  readonly exited = new Map<string, IncarnationExit>()
  readonly interrupted = new Map<string, string>()
  /** Story 43.1: each session's reported resume command, with the process that reported it. */
  readonly reportedResume = new Map<string, { argv: string[]; reportedAt: string; incarnationId: string }>()
  /** Holds a binding write open, so a test can act while a claim swap is still uncommitted. */
  replaceGate: (() => Promise<void>) | undefined
  /** Fails the next binding write once, to exercise the rollback of an uncommitted swap. */
  replaceFailure: Error | undefined
  /** Runs while a session record is still being created, before anything can read it. */
  onCreateStarting: ((record: CreateStartingRecord) => void) | undefined
  /** Holds record creation open, so a test can act during the window before the record exists. */
  createGate: (() => Promise<void>) | undefined

  async listWorkspaces(): Promise<readonly WorkspaceRecord[]> {
    return [{
      workspaceId: DEFAULT_SESSION_CREATION.workspaceId,
      name: 'Default',
      defaultCwd: null,
      pinnedFilePaths: [],
      position: 0,
      marker: 'none',
      archivedAt: null,
      revision: 1
    }]
  }

  /** A session is stored once it was created here or a test seeded its persisted binding. */
  async listSessions(workspaceId: string): Promise<readonly SessionRecord[]> {
    const sessionIds = new Set([
      ...this.startingRecords.map((record) => record.sessionId),
      ...this.bindings.keys(),
      ...this.reportedResume.keys()
    ])
    return [...sessionIds].map((sessionId, position) => {
      const created = this.startingRecords.find((record) => record.sessionId === sessionId)
      return {
        sessionId,
        workspaceId,
        name: created?.name ?? sessionId,
        cwd: created?.cwd ?? '/',
        executable: created?.executable ?? '/bin/sh',
        argv: [...(created?.argv ?? [])],
        position,
        backgroundChoice: created?.backgroundChoice ?? null,
        terminalGraphics: created?.terminalGraphics ?? null,
        revision: 1,
        createdAt: created?.startedAt ?? '2026-09-13T00:00:00.000Z',
        archivedAt: null,
        lastProcess: null,
        ...((reported) => reported ? { reportedResume: { argv: [...reported.argv], reportedAt: reported.reportedAt } } : {})(
          this.reportedResume.get(sessionId))
      }
    })
  }

  async createStarting(record: CreateStartingRecord): Promise<void> {
    this.onCreateStarting?.(record)
    if (this.createGate) await this.createGate()
    this.starting.push(record.incarnationId)
    this.startingRecords.push(structuredClone(record))
    this.bindings.set(record.sessionId, structuredClone(record.binding))
  }

  async createResuming(record: CreateResumingRecord): Promise<void> {
    this.resuming.push(record.incarnationId)
    if (!record.keepReportedResume) this.reportedResume.delete(record.sessionId)
  }

  async setReportedResume(record: { sessionId: string; incarnationId: string; argv: readonly string[]; reportedAt: string }): Promise<void> {
    if (!this.running.has(record.incarnationId)) throw new Error(`incarnation ${record.incarnationId} is not current`)
    this.reportedResume.set(record.sessionId, { argv: [...record.argv], reportedAt: record.reportedAt, incarnationId: record.incarnationId })
  }

  async clearReportedResume(record: { sessionId: string; incarnationId: string }): Promise<boolean> {
    if (!this.running.has(record.incarnationId)) throw new Error(`incarnation ${record.incarnationId} is not current`)
    return this.reportedResume.delete(record.sessionId)
  }

  async getConversationBinding(
    sessionId: string
  ): Promise<PersistedConversationBinding | undefined> {
    const binding = this.bindings.get(sessionId)
    return binding ? structuredClone(binding) : undefined
  }

  async replaceConversationBinding(
    binding: ExplicitConversationBinding
  ): Promise<PersistedConversationBinding> {
    if (this.replaceGate) await this.replaceGate()
    if (this.replaceFailure) {
      const failure = this.replaceFailure
      this.replaceFailure = undefined
      throw failure
    }
    this.bindings.set(binding.sessionId, structuredClone(binding))
    return structuredClone(binding)
  }

  async clearConversationBinding(sessionId: string): Promise<boolean> {
    return this.bindings.delete(sessionId)
  }

  async markRunning(incarnationId: string): Promise<void> {
    this.running.add(incarnationId)
  }

  async markExited(incarnationId: string, exit: IncarnationExit): Promise<void> {
    this.running.delete(incarnationId)
    this.exited.set(incarnationId, exit)
  }

  async markInterrupted(incarnationId: string, reason: string): Promise<void> {
    this.running.delete(incarnationId)
    this.interrupted.set(incarnationId, reason)
  }

  async listInterruptedIncarnations(): Promise<readonly InterruptedIncarnationRow[]> {
    return this.interruptedIncarnations
  }

  async markCohortOffered(incarnationIds: readonly string[], offeredAt: string): Promise<void> {
    this.cohortOffers.push({ incarnationIds: [...incarnationIds], offeredAt })
    for (const row of this.interruptedIncarnations) {
      if (incarnationIds.includes(row.incarnationId)) row.offeredAt ??= offeredAt
    }
  }

  async health(): Promise<{ runningIncarnations: number }> {
    return { runningIncarnations: this.running.size }
  }
}

class FakeSavedOutputStore implements SavedOutputStore {
  readonly snapshots = new Map<string, SavedOutputSnapshot>()
  readonly failures: SavedOutputFinalCaptureUnavailable[] = []

  async save(snapshot: SavedOutputSnapshot): Promise<void> {
    this.snapshots.set(this.key(snapshot), structuredClone(snapshot))
  }

  async load(identity: SessionIdentity, viewEpoch?: string): Promise<SavedOutputSnapshot | undefined> {
    const snapshot = [...this.snapshots.values()]
      .filter((candidate) =>
        candidate.sessionId === identity.sessionId &&
        candidate.incarnationId === identity.incarnationId &&
        (viewEpoch === undefined || candidate.viewEpoch === viewEpoch)
      )
      .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0]
    return snapshot ? structuredClone(snapshot) : undefined
  }

  async loadCatalog() {
    return {
      snapshots: [...this.snapshots.values()].sort((left, right) =>
        Date.parse(right.capturedAt) - Date.parse(left.capturedAt)
      ).map((snapshot) => structuredClone(snapshot)),
      finalCaptureUnavailable: structuredClone(this.failures),
      unreadable: [],
      pruned: 0
    }
  }

  async recordFinalCaptureUnavailable(
    input: Omit<SavedOutputFinalCaptureUnavailable, 'formatVersion' | 'lastCaptureAt'>
  ): Promise<SavedOutputFinalCaptureUnavailable> {
    const latest = await this.load(input, input.viewEpoch)
    const record: SavedOutputFinalCaptureUnavailable = {
      ...input,
      formatVersion: SAVED_OUTPUT_FORMAT_VERSION,
      lastCaptureAt: latest?.capturedAt ?? null
    }
    this.failures.push(record)
    return structuredClone(record)
  }

  async markProcessState(
    identity: SessionIdentity,
    processState: 'exited' | 'interrupted'
  ): Promise<void> {
    for (const [key, snapshot] of this.snapshots) {
      if (
        snapshot.sessionId === identity.sessionId &&
        snapshot.incarnationId === identity.incarnationId
      ) this.snapshots.set(key, { ...snapshot, processState })
    }
    for (const failure of this.failures) {
      if (
        failure.sessionId === identity.sessionId &&
        failure.incarnationId === identity.incarnationId
      ) failure.processState = processState
    }
  }

  private key(identity: SessionIdentity & { viewEpoch: string }): string {
    return JSON.stringify([identity.sessionId, identity.incarnationId, identity.viewEpoch])
  }
}

async function fixture(
  undeliveredOutputLimitBytes?: number,
  outputQueueLimits?: {
    consumerBytes: number
    hostBytes: number
    acknowledgementDeadlineMs?: number
  }
): Promise<{
  manager: SessionManager
  pty: FakePty
  store: FakeStore
  savedOutputStore: FakeSavedOutputStore
  sent: TerminalPortMessage[]
  cwd: string
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'bmn-session-test-'))
  createdRoots.add(cwd)
  const pty = new FakePty()
  const store = new FakeStore()
  const savedOutputStore = new FakeSavedOutputStore()
  const sent: TerminalPortMessage[] = []
  const manager = new SessionManager({
    store,
    savedOutputStore,
    spawnPty: () => pty,
    processStartIdentity: async () => 'linux-proc-start:12345',
    sendTerminalMessage: (message) => sent.push(message),
    ...(undeliveredOutputLimitBytes === undefined ? {} : { undeliveredOutputLimitBytes }),
    ...(outputQueueLimits === undefined ? {} : { outputQueueLimits })
  })
  return { manager, pty, store, savedOutputStore, sent, cwd }
}

async function flowFixture(
  outputQueueLimits?: {
    consumerBytes: number
    hostBytes: number
    acknowledgementDeadlineMs?: number
  },
  extra: { onProgramCopy?: (message: ProgramCopyMessage) => void; onOutput?: (sessionId: string, bytes: Uint8Array) => void } = {}
): Promise<{
  manager: SessionManager
  pty: FakePty
  store: FakeStore
  harness: Awaited<ReturnType<typeof terminalFlowHarness>>
  cwd: string
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'bmn-flow-test-'))
  createdRoots.add(cwd)
  const pty = new FakePty()
  const store = new FakeStore()
  const harness = await terminalFlowHarness()
  const manager = new SessionManager({
    store,
    spawnPty: () => pty,
    processStartIdentity: async () => 'linux-proc-start:flow',
    sendTerminalMessage: harness.send,
    ...(outputQueueLimits === undefined ? {} : { outputQueueLimits }),
    ...extra
  })
  harness.setAcknowledger((attachmentId, streamSeq) => {
    manager.acknowledge({ attachmentId, streamSeq })
  })
  return { manager, pty, store, harness, cwd }
}

describe('shell session lifecycle', () => {
  it('removes private environment aliases on Windows and emits one effective PATH', () => {
    expect(buildShellEnvironment({ Path: 'first', PATH: 'second', bmn_token: 'synthetic-secret', electron_run_as_node: '1', SystemRoot: 'C:\\Windows' }, 'win32'))
      .toEqual({ PATH: 'second', SystemRoot: 'C:\\Windows', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
  })

  it('builds a user shell environment without Electron, Chromium, or app-internal launch variables', () => {
    expect(
      buildShellEnvironment({
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        CUSTOM_USER_VALUE: 'kept',
        TERM: 'old',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ATTACH_CONSOLE: '1',
        CHROME_DESKTOP: 'electron.desktop',
        CHROMIUM_FLAGS: 'internal',
        BMN_DATA_HOME: '/private/data',
        BMN_REPO_ROOT: '/repo',
        AITERM_TOKEN: 'legacy-private-token',
        NODE_CHANNEL_FD: '3'
      })
    ).toEqual({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      CUSTOM_USER_VALUE: 'kept',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    })
  })

  it('advertises truecolor and drops identity variables inherited from the terminal that launched the app', () => {
    // Launched from a desktop entry there is no COLORTERM, so Claude and Codex fell back to 256 colors;
    // launched from agterm, shells claimed to be Ghostty inside tmux.
    expect(
      buildShellEnvironment({
        PATH: '/usr/bin',
        TERM: 'xterm-ghostty',
        COLORTERM: '24bit',
        TERM_PROGRAM: 'agterm',
        TERM_PROGRAM_VERSION: '1.4.0',
        TERMINFO: '/opt/ghostty/terminfo',
        GHOSTTY_RESOURCES_DIR: '/opt/ghostty',
        GHOSTTY_SURFACE_ID: '7',
        AGTERM_PANE_ID: 'p1',
        AGTERMCTL: '/usr/bin/agtermctl',
        TMUX: '/tmp/tmux-1000/default,1,0',
        TMUX_PANE: '%1',
        VTE_VERSION: '7600',
        KITTY_WINDOW_ID: '1',
        WEZTERM_PANE: '0',
        ALACRITTY_WINDOW_ID: '1',
        KONSOLE_VERSION: '240800',
        WINDOWID: '52',
        LC_TERMINAL: 'iTerm2',
        LC_TERMINAL_VERSION: '3.5'
      })
    ).toEqual({ PATH: '/usr/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
  })

  it('drops exact launching-agent session identities while preserving owner configuration', () => {
    const inheritedIdentities = [
      'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID',
      'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_SANDBOX_NETWORK_DISABLED',
      'OMPCODE', 'ITERM_SESSION_ID', 'WT_SESSION', 'STY',
      'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID', 'ZELLIJ_VERSION'
    ]
    const configuration = {
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CONFIG_DIR: '/custom/claude',
      CLAUDE_EFFORT: 'high',
      ANTHROPIC_BASE_URL: 'https://example.test',
      CODEX_HOME: '/custom/codex',
      OPENCODE_CONFIG: '/custom/opencode.json',
      PATH: '/usr/bin',
      HOME: '/home/owner'
    }
    const result = buildShellEnvironment({
      ...Object.fromEntries(inheritedIdentities.map((name) => [name, 'outer-session'])),
      ...configuration
    })
    for (const name of inheritedIdentities) expect(result).not.toHaveProperty(name)
    for (const [name, value] of Object.entries(configuration)) expect(result[name]).toBe(value)
  })

  it('issues fresh BMN and AITERM credentials even when launched inside another BMN session', () => {
    let spawnedEnvironment: Readonly<Record<string, string | undefined>> | undefined
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: (_executable, _argv, options) => {
        spawnedEnvironment = options.env
        return new FakePty()
      },
      sendTerminalMessage: () => undefined,
      environment: {
        BMN_CONTROL_SOCKET: '/outer/socket', BMN_SESSION_ID: 'outer', BMN_TOKEN: 'outer-token',
        AITERM_CONTROL_SOCKET: '/outer/socket', AITERM_SESSION_ID: 'outer', AITERM_TOKEN: 'outer-token'
      },
      sessionEnvironment: (identity) => ({
        BMN_CONTROL_SOCKET: '/new/socket', BMN_SESSION_ID: identity.sessionId, BMN_TOKEN: 'new-token',
        AITERM_CONTROL_SOCKET: '/new/socket', AITERM_SESSION_ID: identity.sessionId, AITERM_TOKEN: 'new-token'
      })
    })
    manager.spawnValidatedPty(
      { cwd: '/tmp', executable: '/usr/bin/bash', argv: [], cols: 80, rows: 24 },
      undefined,
      { sessionId: 'new-session', incarnationId: 'new-incarnation' }
    )
    expect(spawnedEnvironment).toMatchObject({
      BMN_CONTROL_SOCKET: '/new/socket', BMN_SESSION_ID: 'new-session', BMN_TOKEN: 'new-token',
      AITERM_CONTROL_SOCKET: '/new/socket', AITERM_SESSION_ID: 'new-session', AITERM_TOKEN: 'new-token'
    })
  })

  it.skipIf(process.platform !== 'win32')('validates Windows launches against the companion session PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bmn-session-path-'))
    createdRoots.add(root)
    await writeFile(join(root, 'synthetic-path-tool.exe'), 'synthetic executable fixture; PTY is mocked')
    const manager = new SessionManager({
      store: new FakeStore(), spawnPty: () => new FakePty(), sendTerminalMessage: () => undefined,
      environment: { PATH: '', PATHEXT: '.EXE' }, sessionPath: () => root,
      sessionEnvironment: () => ({ PATH: root })
    })
    await expect(manager.validateLaunch({ cwd: root, executable: 'synthetic-path-tool', argv: [], cols: 80, rows: 24 })).resolves.toBeUndefined()
  })

  it('keeps direct Codex hooks in this session unless the owner selected a remote server', () => {
    const launches: Array<{ executable: string; argv: readonly string[] }> = []
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: (executable, argv) => {
        launches.push({ executable, argv })
        return new FakePty()
      },
      sendTerminalMessage: () => undefined,
      environment: { PATH: '/usr/bin' }
    })
    const identity = { sessionId: 'codex-session', incarnationId: 'codex-incarnation' }
    const launch = (executable: string, argv: string[], environment?: Record<string, string>): void => {
      manager.spawnValidatedPty({ cwd: '/tmp', executable, argv, cols: 80, rows: 24 }, environment, identity)
    }
    launch('/usr/bin/codex', ['--model', 'gpt-6'])
    launch('/usr/bin/codex', ['--remote', 'unix:///tmp/owner.sock'])
    launch('/usr/bin/codex', ['--no-daemon'])
    launch('/usr/bin/codex', [], { CODEX_EXEC_SERVER_URL: 'unix:///tmp/executor.sock' })
    launch('/usr/bin/codex', ['--', '--remote'])
    launch('/usr/bin/codex', ['--', '--no-daemon'])
    launch('/usr/bin/codex', ['-C', '/work', 'agents', '--help'])
    launch('/usr/bin/codex', ['--enable', 'agents'])
    launch('/usr/bin/codex', ['--disable', 'agents', 'agents', '--help'])
    launch('/usr/bin/bash', ['-ic', 'codex'])
    expect(launches).toEqual([
      { executable: '/usr/bin/codex', argv: ['--no-daemon', '--model', 'gpt-6'] },
      { executable: '/usr/bin/codex', argv: ['--remote', 'unix:///tmp/owner.sock'] },
      { executable: '/usr/bin/codex', argv: ['--no-daemon'] },
      { executable: '/usr/bin/codex', argv: [] },
      { executable: '/usr/bin/codex', argv: ['--no-daemon', '--', '--remote'] },
      { executable: '/usr/bin/codex', argv: ['--no-daemon', '--', '--no-daemon'] },
      { executable: '/usr/bin/codex', argv: ['-C', '/work', 'agents', '--help'] },
      { executable: '/usr/bin/codex', argv: ['--no-daemon', '--enable', 'agents'] },
      { executable: '/usr/bin/codex', argv: ['--disable', 'agents', 'agents', '--help'] },
      { executable: '/usr/bin/bash', argv: ['-ic', 'codex'] }
    ])
  })

  it.skipIf(process.platform === 'win32')('keeps the BMN Codex wrapper first after an interactive Bash startup changes PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bmn-bash-path-'))
    try {
      const competingBin = join(root, 'real-bin')
      await mkdir(competingBin)
      await writeFile(join(competingBin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
      await writeFile(join(root, '.bashrc'), `PATH=${competingBin}:$PATH\n`)
      const bmnBin = fileURLToPath(new URL('../../bin/', import.meta.url))
      let launched: { argv: readonly string[]; env: Readonly<Record<string, string | undefined>> } | null = null
      const manager = new SessionManager({
        store: new FakeStore(),
        spawnPty: (_executable, argv, options) => {
          launched = { argv, env: options.env }
          return new FakePty()
        },
        sendTerminalMessage: () => undefined,
        environment: { PATH: `${bmnBin}:/usr/bin:/bin`, HOME: root },
        sessionEnvironment: () => ({
          BMN_CONTROL_SOCKET: '/tmp/bmn-test.sock', BMN_TOKEN: 'test-token',
          BMN_CLI_BIN_DIR: bmnBin, PATH: `${bmnBin}:/usr/bin:/bin`
        })
      })
      manager.spawnValidatedPty(
        { cwd: root, executable: '/bin/bash', argv: ['-ic', 'command -v codex'], cols: 80, rows: 24 },
        undefined,
        { sessionId: 's1', incarnationId: 'i1' }
      )
      expect(launched).not.toBeNull()
      const actual = launched!
      const result = spawnSync('/bin/bash', [...actual.argv], {
        cwd: root, env: actual.env as NodeJS.ProcessEnv, encoding: 'utf8'
      })
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(join(bmnBin, 'codex'))

      const afterPrompt = spawnSync('/bin/bash', [
        ...actual.argv.slice(0, -1),
        `PATH=${competingBin}:$PATH; eval "$PROMPT_COMMAND"; command -v codex`
      ], { cwd: root, env: actual.env as NodeJS.ProcessEnv, encoding: 'utf8' })
      expect(afterPrompt.status).toBe(0)
      expect(afterPrompt.stdout.trim()).toBe(join(bmnBin, 'codex'))

      manager.spawnValidatedPty(
        { cwd: root, executable: '/bin/bash', argv: [], cols: 80, rows: 24 },
        undefined,
        { sessionId: 's2', incarnationId: 'i2' }
      )
      expect(launched!.argv).toEqual(['--rcfile', join(bmnBin, 'bmn-bashrc')])

      manager.spawnValidatedPty(
        { cwd: root, executable: '/bin/bash', argv: ['-c', '-i'], cols: 80, rows: 24 },
        undefined,
        { sessionId: 's3', incarnationId: 'i3' }
      )
      expect(launched!.argv).toEqual(['-c', '-i'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('starts a plain interactive PowerShell with the step that keeps the BMN CLI folder first on PATH', () => {
    let launched: readonly string[] = []
    const bmnBin = join(tmpdir(), 'bmn-bin')
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: (_executable, argv) => {
        launched = argv
        return new FakePty()
      },
      sendTerminalMessage: () => undefined,
      environment: { PATH: '/usr/bin' },
      sessionEnvironment: () => ({ BMN_CONTROL_SOCKET: '/tmp/bmn-test.sock', BMN_TOKEN: 'test-token', BMN_CLI_BIN_DIR: bmnBin, PATH: bmnBin })
    })
    const launch = (executable: string, argv: string[]): readonly string[] => {
      manager.spawnValidatedPty({ cwd: tmpdir(), executable, argv, cols: 80, rows: 24 }, undefined, { sessionId: 's1', incarnationId: 'i1' })
      return launched
    }
    const restore = ['-NoExit', '-Command', POWERSHELL_CLI_PATH_RESTORE]
    expect(launch('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [])).toEqual(restore)
    expect(launch('C:\\Program Files\\PowerShell\\7\\PWSH.EXE', ['-NoLogo'])).toEqual(['-NoLogo', ...restore])
    expect(launch('/usr/bin/pwsh', [])).toEqual(restore)
    // A command, a file, -NoProfile or -NoExit is the owner's own startup, left exactly as given.
    for (const argv of [['-NoProfile'], ['-NoLogo', '-NoProfile'], ['-Command', 'codex'], ['-File', 'start.ps1'], ['-NoExit']]) {
      expect(launch('powershell.exe', argv)).toEqual(argv)
    }
    expect(launch('C:\\Windows\\System32\\cmd.exe', [])).toEqual([])
    expect(POWERSHELL_CLI_PATH_RESTORE).not.toContain('"')
  })

  // Windows runs its default shell; elsewhere a PowerShell 7 on PATH runs the same step.
  const powerShell = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((folder) => join(folder, 'pwsh')).find((path) => existsSync(path))
  it.skipIf(!powerShell)('restores the BMN CLI folder in a real PowerShell after its profile and before each prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bmn-powershell-path-'))
    try {
      const bmnBin = join(root, 'bmn bin')
      const competingBin = join(root, 'real-bin')
      const program = process.platform === 'win32' ? 'codex.cmd' : 'codex'
      for (const folder of [bmnBin, competingBin]) {
        await mkdir(folder)
        await writeFile(join(folder, program), process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\n', { mode: 0o755 })
      }
      const first = (folder: string): string => `$env:PATH = '${folder.replaceAll("'", "''")}' + [IO.Path]::PathSeparator + $env:PATH`
      const codex = '(Get-Command codex -CommandType Application | Select-Object -First 1).Source'
      const script = [
        // The owner's profile: a global Codex first, and a prompt of its own.
        first(competingBin), "function global:prompt { 'OWNER-PROMPT>' }",
        POWERSHELL_CLI_PATH_RESTORE, codex,
        // A later tool moves PATH again; the next prompt restores it and still shows the owner's prompt.
        first(competingBin), 'prompt', codex
      ].join('; ')
      const result = spawnSync(powerShell!, ['-NoLogo', '-NoProfile', '-Command', script], {
        env: windowsEnvironment(process.env, { BMN_CLI_BIN_DIR: bmnBin, PATH: `${bmnBin}${delimiter}${process.env.PATH ?? ''}` }),
        encoding: 'utf8',
        timeout: 60_000
      })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout.trim().split(/\r?\n/u).map((line) => line.trimEnd())).toEqual([join(bmnBin, program), 'OWNER-PROMPT>', join(bmnBin, program)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('selects graphics at spawn from the saved choice, Sixel by default, then falls back if terminfo changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bmn-terminal-env-'))
    try {
      const bundled = fileURLToPath(new URL('../../resources/terminfo/x/xterm-sixel-256color', import.meta.url))
      const asset = installBundledTerminfo(root, bundled)
      const environments: Array<Readonly<Record<string, string | undefined>>> = []
      const manager = new SessionManager({
        store: new FakeStore(),
        spawnPty: (_executable, _argv, options) => {
          environments.push(options.env)
          return new FakePty()
        },
        sendTerminalMessage: () => undefined,
        environment: { HOME: join(root, 'home'), TERMINFO_DIRS: '/owner/entries', ZELLIJ_VERSION: '0.40' },
        terminfoAsset: asset
      })
      const launch = (executable: string, terminalGraphics: 'sixel' | 'standard' | null): void => {
        manager.spawnValidatedPty({ cwd: '/tmp', executable, argv: [], cols: 80, rows: 24,
          terminalGraphics })
      }
      launch('/usr/bin/codex', null)
      expect(environments.at(-1)).toMatchObject({ TERM: 'xterm-sixel-256color', COLORTERM: 'truecolor' })
      expect(environments.at(-1)).not.toHaveProperty('ZELLIJ_VERSION')
      if (process.platform === 'win32') expect(environments.at(-1)).not.toHaveProperty('TERMINFO_DIRS')
      else expect(environments.at(-1)?.TERMINFO_DIRS).toContain('/owner/entries')
      // A shell the owner starts Codex, Claude Code or OpenCode inside gets graphics too.
      launch('/bin/bash', null)
      expect(environments.at(-1)?.TERM).toBe('xterm-sixel-256color')
      if (process.platform === 'win32') expect(environments.at(-1)).not.toHaveProperty('TERMINFO_DIRS')
      else expect(environments.at(-1)?.TERMINFO_DIRS).toContain('/owner/entries')
      launch('/bin/bash', 'sixel')
      expect(environments.at(-1)?.TERM).toBe('xterm-sixel-256color')
      launch('/bin/bash', 'standard')
      expect(environments.at(-1)?.TERM).toBe('xterm-256color')
      launch('/usr/bin/codex', 'standard')
      expect(environments.at(-1)?.TERM).toBe('xterm-256color')
      await writeFile(join(asset.directory, 'x', 'xterm-sixel-256color'), 'damaged')
      launch('/usr/bin/codex', null)
      expect(environments.at(-1)?.TERM).toBe('xterm-256color')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects an invalid cwd before spawn/record and reports no live incarnation', async () => {
    const { manager, store, cwd } = await fixture()
    const spawn = vi.spyOn(manager, 'spawnValidatedPty')

    await expect(
      manager.create({ ...DEFAULT_SESSION_CREATION,
        cwd: join(cwd, 'missing'),
        executable: process.execPath,
        argv: [],
        cols: 80,
        rows: 24
      })
    ).rejects.toMatchObject<Partial<HostControlError>>({ code: ERROR_CODES.invalidArgument })
    expect(spawn).not.toHaveBeenCalled()
    expect(store.starting).toEqual([])
    await expect(manager.health()).resolves.toMatchObject({
      liveSessions: 0,
      runningIncarnations: 0
    })
  })

  it('rejects a missing executable without recording a live incarnation', async () => {
    const { manager, store, cwd } = await fixture()
    await expect(
      manager.create({ ...DEFAULT_SESSION_CREATION,
        cwd,
        executable: join(cwd, 'missing-shell'),
        argv: [],
        cols: 80,
        rows: 24
      })
    ).rejects.toMatchObject<Partial<HostControlError>>({ code: ERROR_CODES.invalidArgument })
    expect(store.starting).toEqual([])
    await expect(manager.health()).resolves.toMatchObject({ runningIncarnations: 0 })
  })

  it('launches in a ~/ directory by expanding it to the home directory, and stores the absolute path', async () => {
    // A workspace saved as "~/code/…" prefilled every New session form with a path the host rejected.
    const home = await mkdtemp(join(tmpdir(), 'bmn-home-test-'))
    createdRoots.add(home)
    await mkdir(join(home, 'code', 'project'), { recursive: true })
    const store = new FakeStore()
    const spawned: string[] = []
    const manager = new SessionManager({
      store,
      spawnPty: (_executable, _argv, options) => {
        spawned.push(options.cwd)
        return new FakePty()
      },
      processStartIdentity: async () => 'linux-proc-start:home',
      sendTerminalMessage: () => undefined,
      homeDirectory: home
    })
    const launch = { ...DEFAULT_SESSION_CREATION, executable: process.execPath, argv: [], cols: 80, rows: 24 }

    await manager.create({ ...launch, cwd: '~/code/project/' })
    await manager.create({ ...launch, cwd: '~' })

    expect(store.startingRecords.map((record) => record.cwd)).toEqual([join(home, 'code', 'project'), home])
    expect(spawned).toEqual([join(home, 'code', 'project'), home])
  })

  it('reports the live process launch directory for file references until the process exits', async () => {
    const { manager, pty, cwd } = await fixture()
    const created = await manager.create({
      ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    })

    expect(manager.liveLaunchDirectory(created.sessionId)).toBe(cwd)
    expect(manager.liveLaunchDirectory('unknown-session')).toBeUndefined()
    pty.emitExit({ exitCode: 0 })
    await vi.waitFor(() => expect(manager.liveLaunchDirectory(created.sessionId)).toBeUndefined())
  })

  it('expands only a leading home marker using the selected platform grammar', () => {
    expect(resolveHomeDirectory('~', '/home/owner', 'linux')).toBe('/home/owner')
    expect(resolveHomeDirectory('~/', '/home/owner', 'linux')).toBe('/home/owner')
    expect(resolveHomeDirectory('~/code/Piche_Projects/app', '/home/owner', 'linux')).toBe('/home/owner/code/Piche_Projects/app')
    expect(resolveHomeDirectory('~other/code', '/home/owner', 'linux')).toBe('~other/code')
    expect(resolveHomeDirectory('/srv/~/code', '/home/owner', 'linux')).toBe('/srv/~/code')
    expect(resolveHomeDirectory('', '/home/owner', 'linux')).toBe('')
    expect(resolveHomeDirectory('~\\code\\app', 'C:\\Users\\owner', 'win32')).toBe('C:\\Users\\owner\\code\\app')
    expect(resolveHomeDirectory('~/code/app', 'C:\\Users\\owner', 'win32')).toBe('C:\\Users\\owner\\code\\app')
    expect(resolveHomeDirectory('~', 'C:\\Users\\owner', 'win32')).toBe('C:\\Users\\owner')
    expect(resolveHomeDirectory('~other\\code', 'C:\\Users\\owner', 'win32')).toBe('~other\\code')
  })

  it('persists the supplied workspace and session name when creating a session', async () => {
    const { manager, store, cwd } = await fixture()
    const workspaces = await store.listWorkspaces()
    vi.spyOn(store, 'listWorkspaces').mockResolvedValue([{ ...workspaces[0]!, workspaceId: 'workspace-work' }])

    await manager.create({
      workspaceId: 'workspace-work',
      name: 'Review session',
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })

    expect(store.startingRecords[0]).toMatchObject({
      workspaceId: 'workspace-work',
      name: 'Review session'
    })
  })

  it('records the launch background choice with the created session, and none when omitted', async () => {
    const { manager, store, cwd } = await fixture()
    const launch = { ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 }

    await manager.create({ ...launch, backgroundChoice: 'hide' })
    await manager.create(launch)

    expect(store.startingRecords.map((record) => record.backgroundChoice)).toEqual(['hide', null])
  })

  it('names a saved session when its process fails after the record is created', async () => {
    const { manager, store, cwd } = await fixture()
    store.markRunning = async () => { throw new Error('synthetic startup failure after persistence') }
    const error = await manager.create({
      ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(PersistedSessionStartError)
    expect(error).toMatchObject({ sessionId: store.startingRecords[0]?.sessionId })
    expect(store.startingRecords).toHaveLength(1)
  })

  it('gives, for the self-test only, one extra read credit to a Windows ConPTY output reader and to nothing else', async () => {
    const { manager, pty, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 })
    expect(manager.nudgeOutputReaderForSelfTest('missing')).toBeUndefined()
    // A POSIX PTY has no such reader.
    expect(manager.nudgeOutputReaderForSelfTest(created.sessionId)).toBe(false)
    // node-pty's Windows terminal: agent, then its output connection, then the worker thread that reads ConPTY.
    const messages: unknown[] = []
    Object.assign(pty, { _agent: { _worker: { _worker: { postMessage: (message: unknown) => messages.push(message) } } } })
    expect(manager.nudgeOutputReaderForSelfTest(created.sessionId)).toBe(true)
    expect(messages).toEqual(['read'])
  })

  it('reports, for the self-test only, what a session printed last and where that output stands for its view', async () => {
    const { manager, pty, cwd } = await fixture(undefined, { consumerBytes: 8, hostBytes: 1024 })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 })
    expect(manager.outputStateForSelfTest('missing')).toBeUndefined()
    pty.emit('scroll-79\r\nSCROLLED\x1b[0m')
    expect(manager.outputStateForSelfTest(created.sessionId)).toMatchObject({ exited: false, outputBytes: 23, view: null, ptyStream: null,
      size: { cols: 80, rows: 24 }, tail: 'scroll-79\\x0d\\x0aSCROLLED\\x1b[0m' })
    const attached = manager.attach(created)
    manager.activateAttachment(attached.attachmentId)
    // An 8-byte view credit: the rest waits here, the PTY is paused, and nothing is acknowledged yet.
    expect(manager.outputStateForSelfTest(created.sessionId, 4)).toMatchObject({ tail: '\\x1b[0m',
      view: { paused: true, inFlightBytes: 8, pendingBytes: 15, enqueuedBytes: 23, acknowledgedBytes: 0 } })
  })

  it('buffers initial output, grants one lease, forwards bytes in order, resizes, and stops the current incarnation', async () => {
    const { manager, pty, store, sent, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    pty.emit('prompt')
    expect(sent).toEqual([])

    const attached = manager.attach(created)
    manager.activateAttachment(attached.attachmentId)
    expect(sent[0]).toMatchObject({ attachmentId: attached.attachmentId, streamSeq: 0 })
    manager.write({ attachmentId: attached.attachmentId, bytes: new TextEncoder().encode('echo') })
    expect(pty.writes).toHaveLength(1)
    manager.resize({ attachmentId: attached.attachmentId, cols: 120, rows: 40 })
    expect([pty.cols, pty.rows]).toEqual([120, 40])

    await manager.stop(created)
    expect(pty.killed).toBe(true)
    expect(store.exited.get(created.incarnationId)).toEqual({ exitCode: 0 })
    await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0, runningIncarnations: 0 })
  })

  it('records lifecycle stops as interrupted with observed evidence while explicit Stop stays exited', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-lifecycle-stop-store-test-'))
    createdRoots.add(cwd)
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, '2026-09-13T09:00:00.000Z')
      const ptys = [new SignalExitFakePty(), new SignalExitFakePty()]
      const sent: TerminalPortMessage[] = []
      const manager = new SessionManager({
        store: sqliteSessionStore(database),
        spawnPty: () => ptys.shift()!,
        processStartIdentity: async (pid) => `linux-proc-start:${pid}`,
        sendTerminalMessage: (message) => sent.push(message)
      })
      const launch = {
        ...DEFAULT_SESSION_CREATION,
        cwd,
        executable: process.execPath,
        argv: [],
        cols: 80,
        rows: 24
      }
      const lifecycleStopped = await manager.create({ ...launch, name: 'Lifecycle stopped' })
      const lifecycleAttachment = manager.attach(lifecycleStopped)
      manager.activateAttachment(lifecycleAttachment.attachmentId)
      await manager.stop(lifecycleStopped, 'application-quit')
      const explicitlyStopped = await manager.create({ ...launch, name: 'Explicitly stopped' })
      const explicitAttachment = manager.attach(explicitlyStopped)
      manager.activateAttachment(explicitAttachment.attachmentId)
      await manager.stop(explicitlyStopped, 'explicit')

      expect(sent).toContainEqual({
        kind: 'terminal-exit',
        state: 'interrupted',
        attachmentId: lifecycleAttachment.attachmentId,
        cause: 'application-quit',
        exitCode: 0,
        signal: 15
      })
      expect(sent).toContainEqual({
        kind: 'terminal-exit',
        state: 'exited',
        attachmentId: explicitAttachment.attachmentId,
        exitCode: 0,
        signal: 15
      })

      expect(() => markSessionExited(database, lifecycleStopped.incarnationId, {
        exitCode: 0,
        signal: 15
      })).toThrow('is not current')

      const records = new Map(
        listSessions(database, DEFAULT_SESSION_CREATION.workspaceId)
          .map((record) => [record.sessionId, record])
      )
      expect(records.get(lifecycleStopped.sessionId)?.lastProcess).toEqual({
        incarnationId: lifecycleStopped.incarnationId,
        state: 'interrupted',
        exitCode: null,
        signal: null,
        detail: 'application quit · signal 15'
      })
      expect(records.get(explicitlyStopped.sessionId)?.lastProcess).toEqual({
        incarnationId: explicitlyStopped.incarnationId,
        state: 'exited',
        exitCode: 0,
        signal: 15,
        detail: null
      })
    } finally {
      database.close()
    }
  })

  it('starts a stopped session again with its saved launch settings and refuses while it runs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-relaunch-test-'))
    createdRoots.add(cwd)
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, '2026-09-13T09:00:00.000Z')
      const spawns: Array<{ executable: string; argv: readonly string[]; cwd: string | undefined }> = []
      const manager = new SessionManager({
        store: sqliteSessionStore(database),
        spawnPty: (executable, argv, options) => {
          spawns.push({ executable, argv, cwd: options.cwd })
          return new SignalExitFakePty()
        },
        processStartIdentity: async (pid) => `linux-proc-start:${pid}`,
        sendTerminalMessage: () => undefined
      })
      const created = await manager.create({
        ...DEFAULT_SESSION_CREATION,
        name: 'Shell',
        cwd,
        executable: process.execPath,
        argv: ['--version'],
        cols: 80,
        rows: 24
      })

      await expect(manager.relaunch({ sessionId: created.sessionId, cols: 80, rows: 24 }))
        .rejects.toThrow('already running')
      await manager.stop(created, 'explicit')

      const relaunched = await manager.relaunch({ sessionId: created.sessionId, cols: 100, rows: 30 })

      expect(relaunched).toMatchObject({ sessionId: created.sessionId, streamSeq: 0 })
      // The result crosses Electron IPC, so it must be plain data rather than the live process record.
      expect(Object.keys(structuredClone(relaunched)).sort()).toEqual(['attachmentId', 'captureStartedAt', 'incarnationId', 'modes', 'sessionId', 'streamSeq'])
      // A process that has just started has printed nothing, so its new view has no modes to restore.
      expect(relaunched.modes).toEqual([])
      expect(relaunched.incarnationId).not.toBe(created.incarnationId)
      expect(relaunched.attachmentId).toEqual(expect.any(String))
      expect(spawns).toEqual([
        { executable: process.execPath, argv: ['--version'], cwd },
        { executable: process.execPath, argv: ['--version'], cwd }
      ])
      expect(database
        .prepare('SELECT state FROM process_incarnation WHERE incarnation_id = ?')
        .get(relaunched.incarnationId)).toEqual({ state: 'running' })
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 1 })
      await expect(manager.relaunch({ sessionId: 'missing', cols: 80, rows: 24 }))
        .rejects.toThrow('not found')
    } finally {
      database.close()
    }
  })

  describe('one process per session across Start again and Resume', () => {
    const reference = '11111111-1111-4111-8111-111111111111'

    /** A bound Claude session whose first process has exited; each later spawn gets the next PTY. */
    async function stoppedClaudeSession(options: { referenceExists?: () => Promise<boolean> } = {}) {
      const cwd = await mkdtemp(join(tmpdir(), 'bmn-one-process-test-'))
      createdRoots.add(cwd)
      const executable = join(cwd, 'claude')
      await writeFile(executable, '#!/bin/sh\n')
      await chmod(executable, 0o700)
      const ptys: FakePty[] = []
      const manager = new SessionManager({
        store: new FakeStore(),
        spawnPty: (_command, argv) => {
          if (argv.length === 1 && argv[0] === '--help') {
            const probe = new FakePty()
            completeCapabilityProbe(probe)
            return probe
          }
          const pty = new FakePty()
          ptys.push(pty)
          return pty
        },
        processStartIdentity: async () => `linux-proc-start:${ptys.length}`,
        conversationReferenceExists: options.referenceExists ?? (async () => true),
        sendTerminalMessage: () => undefined
      })
      const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
        cwd,
        executable,
        argv: ['--session-id', reference],
        cols: 80,
        rows: 24
      })
      ptys[0]!.emitExit({ exitCode: 0 })
      await vi.waitFor(async () => {
        await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
      })
      return { manager, ptys, sessionId: created.sessionId }
    }

    it('refuses Resume while the process from Start again runs, and keeps control of that process', async () => {
      const { manager, ptys, sessionId } = await stoppedClaudeSession()
      const relaunched = await manager.relaunch({ sessionId, cols: 80, rows: 24 })

      await expect(manager.resume({ sessionId, cols: 80, rows: 24 }))
        .rejects.toMatchObject({ code: ERROR_CODES.invalidArgument, message: expect.stringContaining('already running') })
      expect(ptys).toHaveLength(2)

      await manager.stop(relaunched, 'explicit')
      expect(ptys[1]!.killed).toBe(true)
      await expect(manager.resume({ sessionId, cols: 80, rows: 24 })).resolves.toMatchObject({ attachmentId: expect.any(String) })
      expect(ptys).toHaveLength(3)
    })

    it('starts only one process when Start again is pressed twice at once', async () => {
      const { manager, ptys, sessionId } = await stoppedClaudeSession()
      const outcomes = await Promise.allSettled([
        manager.relaunch({ sessionId, cols: 80, rows: 24 }),
        manager.relaunch({ sessionId, cols: 80, rows: 24 })
      ])

      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(ptys).toHaveLength(2)
    })

    it('refuses Start again while Resume is still starting', async () => {
      let resumeChecking = false
      let releaseReferenceCheck = (): void => undefined
      const referenceCheck = new Promise<boolean>((resolve) => (releaseReferenceCheck = () => resolve(true)))
      const { manager, ptys, sessionId } = await stoppedClaudeSession({
        referenceExists: () => {
          resumeChecking = true
          return referenceCheck
        }
      })
      const resuming = manager.resume({ sessionId, cols: 80, rows: 24 })
      await vi.waitFor(() => expect(resumeChecking).toBe(true))
      await expect(manager.relaunch({ sessionId, cols: 80, rows: 24 }))
        .rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })
      releaseReferenceCheck()

      await expect(resuming).resolves.toMatchObject({ attachmentId: expect.any(String) })
      expect(ptys).toHaveLength(2)
    })

    it('refuses Start again while the previous process has not confirmed its exit', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'bmn-unconfirmed-relaunch-test-'))
      createdRoots.add(cwd)
      const ptys: FakePty[] = []
      const manager = new SessionManager({
        store: new FakeStore(),
        spawnPty: () => {
          const pty = new NonExitingFakePty()
          ptys.push(pty)
          return pty
        },
        processStartIdentity: async () => 'linux-proc-start:unchanged',
        signalProcess: () => true,
        stopGraceMs: 1,
        stopKillWaitMs: 1,
        sendTerminalMessage: () => undefined
      })
      const created = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 })
      await expect(manager.stop(created, 'explicit')).rejects.toMatchObject({ code: ERROR_CODES.ioError })

      await expect(manager.relaunch({ sessionId: created.sessionId, cols: 80, rows: 24 }))
        .rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })
      expect(ptys).toHaveLength(1)
    })
  })

  it('keeps the first explicit stop cause when an application quit races the same teardown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-first-stop-cause-test-'))
    createdRoots.add(cwd)
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, '2026-09-13T09:00:00.000Z')
      const pty = new NonExitingFakePty()
      const manager = new SessionManager({
        store: sqliteSessionStore(database),
        spawnPty: () => pty,
        processStartIdentity: async (pid) => `linux-proc-start:${pid}`,
        sendTerminalMessage: () => undefined
      })
      const created = await manager.create({
        ...DEFAULT_SESSION_CREATION,
        cwd,
        executable: process.execPath,
        argv: [],
        cols: 80,
        rows: 24
      })

      const explicitStop = manager.stop(created, 'explicit')
      const applicationQuitStop = manager.stop(created, 'application-quit')
      await vi.waitFor(() => expect(pty.killCalls).toBe(1))
      pty.emitExit({ exitCode: 0, signal: 15 })

      await expect(Promise.all([explicitStop, applicationQuitStop]))
        .resolves.toEqual([undefined, undefined])
      expect(pty.killCalls).toBe(1)
      expect(listSessions(database, DEFAULT_SESSION_CREATION.workspaceId)[0]?.lastProcess).toEqual({
        incarnationId: created.incarnationId,
        state: 'exited',
        exitCode: 0,
        signal: 15,
        detail: null
      })
    } finally {
      database.close()
    }
  })

  it('refuses to start an archived session until it is restored', async () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, '2026-09-13T09:00:00.000Z')
      database.prepare(
        `INSERT INTO session(
          session_id, workspace_id, name, cwd, executable, argv_json,
          revision, created_at, position, archived_at
        ) VALUES ('session-archived', ?, 'Archived', '/workspace', '/bin/bash', '[]', 1, ?, 0, ?)`
      ).run(DEFAULT_SESSION_CREATION.workspaceId, '2026-09-13T09:00:00.000Z', '2026-09-14T09:00:00.000Z')
      const spawnPty = vi.fn((): PtyLike => new FakePty())
      const manager = new SessionManager({
        store: sqliteSessionStore(database),
        spawnPty,
        processStartIdentity: async (pid) => `linux-proc-start:${pid}`,
        conversationReferenceExists: async () => true,
        sendTerminalMessage: () => undefined
      })
      const refusal = { code: ERROR_CODES.invalidArgument, message: 'Restore the session before starting it' }
      await expect(manager.resume({ sessionId: 'session-archived', cols: 80, rows: 24 })).rejects.toMatchObject(refusal)
      await expect(manager.relaunch({ sessionId: 'session-archived', cols: 80, rows: 24 })).rejects.toMatchObject(refusal)
      expect(spawnPty).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it('refuses stored-session resume in the manager before launch when real SQLite argv metadata is corrupt', async () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, '2026-09-13T09:00:00.000Z')
      database.prepare(
        `INSERT INTO session(
          session_id, workspace_id, name, cwd, executable, argv_json,
          revision, created_at, position, background_choice
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, NULL)`
      ).run(
        'session-corrupt-argv',
        DEFAULT_SESSION_CREATION.workspaceId,
        'Corrupt argv session',
        '/workspace',
        '/bin/bash',
        '{not-json',
        '2026-09-13T09:00:00.000Z'
      )
      const spawnPty = vi.fn((): PtyLike => new FakePty())
      const manager = new SessionManager({
        store: sqliteSessionStore(database),
        spawnPty,
        processStartIdentity: async (pid) => `linux-proc-start:${pid}`,
        conversationReferenceExists: async () => true,
        sendTerminalMessage: () => undefined
      })

      await expect(
        manager.resume({ sessionId: 'session-missing', cols: 80, rows: 24 })
      ).rejects.toMatchObject<Partial<HostControlError>>({
        code: ERROR_CODES.notFound,
        message: 'The session was not found'
      })
      await expect(
        manager.resume({ sessionId: 'session-corrupt-argv', cols: 80, rows: 24 })
      ).rejects.toMatchObject<Partial<HostControlError>>({
        code: ERROR_CODES.ioError,
        message: expect.stringContaining('This session has invalid stored arguments')
      })
      expect(spawnPty).not.toHaveBeenCalled()
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    } finally {
      database.close()
    }
  })

  it('T-A streams resume-window output from sequence zero in emission order without a renderer gap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-resume-flow-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const firstPty = new FakePty()
    const resumedPty = new FakePty()
    const actualPtys = [firstPty, resumedPty]
    const store = new FakeStore()
    const harness = await terminalFlowHarness()
    const manager = new SessionManager({
      store,
      spawnPty: (_command, argv) => {
        if (argv.length === 1 && argv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        const pty = actualPtys.shift()!
        if (pty === resumedPty) queueMicrotask(() => pty.emit('resume-banner'))
        return pty
      },
      processStartIdentity: async () => 'linux-proc-start:resume-flow',
      conversationReferenceExists: async () => true,
      sendTerminalMessage: harness.send
    })
    harness.setAcknowledger((attachmentId, streamSeq) => {
      manager.acknowledge({ attachmentId, streamSeq })
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--model', 'sonnet'],
      cols: 80,
      rows: 24
    })
    firstPty.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })

    const resumed = await manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    expect(() => structuredClone(resumed)).not.toThrow()
    resumedPty.emit('-window')
    expect(harness.writes).toEqual([])
    harness.flow.attach(resumed.attachmentId)
    manager.activateAttachment(resumed.attachmentId)
    resumedPty.emit('-live')

    expect(harness.acknowledgements).toEqual([0, 1, 2])
    expect(decoded(harness.writes)).toBe('resume-banner-window-live')
    expect(harness.recoveries).toEqual([])
  })

  it('T-B sends only recovery-window output exactly once before recovery live output', async () => {
    const { manager, pty, harness, cwd } = await flowFixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const first = manager.attach(created)
    harness.flow.attach(first.attachmentId)
    manager.activateAttachment(first.attachmentId)
    pty.emit('consumed-by-first-view')
    manager.detach({ attachmentId: first.attachmentId })
    harness.flow.detach(first.attachmentId)
    harness.writes.length = 0
    harness.acknowledgements.length = 0

    const replacement = manager.attach(created)
    harness.flow.attach(replacement.attachmentId)
    pty.emit('-window')
    manager.activateAttachment(replacement.attachmentId)
    pty.emit('-live')

    expect(harness.acknowledgements).toEqual([0, 1])
    expect(decoded(harness.writes)).toBe('-window-live')
    expect(harness.recoveries).toEqual([])
  })

  it('T-C keeps the create banner ahead of activation-window output from sequence zero', async () => {
    const { manager, pty, harness, cwd } = await flowFixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    pty.emit('create-banner')
    const attached = manager.attach(created)
    harness.flow.attach(attached.attachmentId)
    pty.emit('-window')
    expect(harness.writes).toEqual([])

    manager.activateAttachment(attached.attachmentId)

    expect(harness.acknowledgements).toEqual([0, 1])
    expect(decoded(harness.writes)).toBe('create-banner-window')
    expect(harness.recoveries).toEqual([])
  })

  it('copies for a program only from live output while a view is attached, never from the replayed backlog (Story 42.1)', async () => {
    const copies: ProgramCopyMessage[] = []
    const { manager, pty, harness, cwd } = await flowFixture(undefined, { onProgramCopy: (message) => copies.push(message) })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const osc52 = (text: string): string => `\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`
    // No view: the sequence waits in the backlog for the next view and copies nothing.
    pty.emit(`hidden ${osc52('while hidden')}`)
    const attached = manager.attach(created)
    harness.flow.attach(attached.attachmentId)
    manager.activateAttachment(attached.attachmentId)
    // The view receives the backlog byte for byte, and replaying it copies nothing.
    expect(decoded(harness.writes)).toBe(`hidden ${osc52('while hidden')}`)
    expect(copies).toEqual([])
    // Live output while shown copies, even when the sequence arrives split across chunks.
    const live = osc52('hello')
    pty.emit(live.slice(0, 9))
    pty.emit(live.slice(9))
    expect(copies).toEqual([{ kind: 'program-copy', sessionId: created.sessionId, targets: ['clipboard'], text: 'hello' }])
    expect(decoded(harness.writes)).toBe(`hidden ${osc52('while hidden')}${live}`)
  })

  it('delivers every chunk to the view even when the output hooks throw', async () => {
    const { manager, pty, harness, cwd } = await flowFixture(undefined, {
      onOutput: () => { throw new Error('port watch failed') },
      onProgramCopy: () => { throw new Error('host port closed') }
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const attached = manager.attach(created)
    harness.flow.attach(attached.attachmentId)
    manager.activateAttachment(attached.attachmentId)
    const copy = `\u001b]52;c;${Buffer.from('hello').toString('base64')}\u0007`
    pty.emit(`before ${copy} after`)
    pty.emit(' next')
    expect(decoded(harness.writes)).toBe(`before ${copy} after next`)
  })

  it('T-D delivers pre-activation output through the paced stream without a spurious disconnect', async () => {
    const overflow = await flowFixture({ consumerBytes: 4, hostBytes: 16 })
    const created = await overflow.manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd: overflow.cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const attached = overflow.manager.attach(created)
    overflow.pty.emit('1234')
    overflow.pty.emit('5678')
    overflow.pty.emit('9')
    expect(overflow.pty.paused).toBe(false)
    expect(overflow.harness.sent).toEqual([])

    overflow.harness.flow.attach(attached.attachmentId)
    const activation = overflow.manager.activateAttachment(attached.attachmentId)

    expect(activation).toEqual({
      activated: true,
      undeliveredOutput: { limitBytes: 16 * 1024 * 1024, droppedBytes: 0, truncated: false }
    })
    expect(overflow.manager.hasAttachment(attached.attachmentId)).toBe(true)
  })

  it('orders a mode reset after output the view has not received yet, and before output that follows (Story 32.3)', async () => {
    const { manager, pty, harness, cwd } = await flowFixture({ consumerBytes: 4, hostBytes: 1024 })
    const held: Array<{ attachmentId: string; streamSeq: number }> = []
    harness.setAcknowledger((attachmentId, streamSeq) => held.push({ attachmentId, streamSeq }))
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const attached = manager.attach(created)
    harness.flow.attach(attached.attachmentId)
    manager.activateAttachment(attached.attachmentId)
    // The view's credit runs out, so the program's mouse mode is still queued for it when the owner resets.
    pty.emit('ok\r\n\u001b[?1000h')
    let answer: { outcome: string; modes: number[] } | undefined
    const reset = manager.resetTerminalModes(created).then((result) => (answer = result))
    // A program that is still running arms paste afterwards; the view must follow it, as the tracker does.
    pty.emit('\u001b[?2004h')
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Nothing is reported done while the view has not written the reset.
    expect(answer).toBeUndefined()
    while (held.length > 0) manager.acknowledge(held.shift()!)
    await expect(reset).resolves.toEqual({ outcome: 'reset', modes: [1000] })

    const view = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 })
    for (const bytes of harness.writes) await writeTerminal(view, bytes)
    expect(view.modes.mouseTrackingMode).toBe('none')
    expect(view.modes.bracketedPasteMode).toBe(true)
    harness.setAcknowledger((attachmentId, streamSeq) => manager.acknowledge({ attachmentId, streamSeq }))
    await expect(manager.resetTerminalModes(created)).resolves.toEqual({ outcome: 'reset', modes: [2004] })
    expect(pty.writes).toEqual([])
    view.dispose()
  })

  // Story 32.3: bytes added part-way through a character or a sequence would split it, so the reset waits for a gap.
  it.each([
    ['a mode sequence', [Buffer.from('\u001b[?1000'), Buffer.from('h$ ')], '$ ', [1000]],
    ['a UTF-8 character', [Buffer.from([0x24, 0x20, 0xe2]), Buffer.from([0x82, 0xac])], '$ €', []],
    ['a title string', [Buffer.from('\u001b]0;hello'), Buffer.from('world\u0007$ ')], '$ ', []],
    ['a device control string', [Buffer.from('\u001bPq#0'), Buffer.from('\u001b\\$ ')], '$ ', []]
  ] as const)('changes nothing while the program is part-way through %s, and resets once it ends', async (_name, parts, screen, armed) => {
    const { manager, pty, harness, cwd } = await flowFixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const attached = manager.attach(created)
    harness.flow.attach(attached.attachmentId)
    manager.activateAttachment(attached.attachmentId)
    pty.emit(new Uint8Array(parts[0]))
    const before = harness.writes.length
    await expect(manager.resetTerminalModes(created)).resolves.toEqual({ outcome: 'busy', modes: [] })
    expect(harness.writes.length).toBe(before)
    pty.emit(new Uint8Array(parts[1]))
    await expect(manager.resetTerminalModes(created)).resolves.toEqual({ outcome: 'reset', modes: [...armed] })

    const view = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 })
    for (const bytes of harness.writes) await writeTerminal(view, bytes)
    expect(view.buffer.active.getLine(0)?.translateToString(true)).toBe(screen)
    expect(view.modes.mouseTrackingMode).toBe('none')
    expect(Buffer.concat(harness.writes.map((bytes) => Buffer.from(bytes))).includes(Buffer.concat([...parts]))).toBe(true)
    expect(pty.writes).toEqual([])
    view.dispose()
  })

  it('refuses a mode reset without a live program or an active view, and says when the view went first (Story 32.3)', async () => {
    const { manager, pty, harness, cwd } = await flowFixture({ consumerBytes: 1024, hostBytes: 4096, acknowledgementDeadlineMs: 20 })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    await expect(manager.resetTerminalModes(created)).rejects.toMatchObject({ code: ERROR_CODES.notFound })
    const attached = manager.attach(created)
    harness.flow.attach(attached.attachmentId)
    manager.activateAttachment(attached.attachmentId)
    pty.emit('\u001b[?1000h')
    // The view stops answering: past its deadline the reset is sent but not confirmed.
    harness.setAcknowledger(() => undefined)
    await expect(manager.resetTerminalModes(created)).resolves.toEqual({ outcome: 'unconfirmed', modes: [1000] })
    // The view is replaced while the reset waits: not confirmed either, and the tracker keeps the reset.
    pty.emit('\u001b[?2004h')
    const waiting = manager.resetTerminalModes(created)
    manager.detach({ attachmentId: attached.attachmentId })
    await expect(waiting).resolves.toEqual({ outcome: 'unconfirmed', modes: [2004] })
    expect(manager.attach(created).modes).toEqual([])
    pty.emitExit({ exitCode: 0 })
    await expect(manager.resetTerminalModes(created)).rejects.toBeInstanceOf(HostControlError)
    expect(pty.writes).toEqual([])
  })

  it('T-E refuses a second activation without disturbing the active stream', async () => {
    const { manager, pty, harness, cwd } = await flowFixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const attached = manager.attach(created)
    harness.flow.attach(attached.attachmentId)
    manager.activateAttachment(attached.attachmentId)

    let duplicateActivation: unknown
    try {
      manager.activateAttachment(attached.attachmentId)
    } catch (error) {
      duplicateActivation = error
    }
    expect(duplicateActivation).toMatchObject<Partial<HostControlError>>({
      code: ERROR_CODES.invalidArgument,
      message: 'The terminal attachment is already active'
    })

    pty.emit('still-live')
    expect(harness.acknowledgements).toEqual([0])
    expect(decoded(harness.writes)).toBe('still-live')
    expect(harness.recoveries).toEqual([])
  })

  it('resumes the exact bound conversation as a new incarnation with its original context', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-resume-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const ptys = [new FakePty(), new FakePty()]
    let nextPty = 0
    const spawns: Array<{
      executable: string
      argv: readonly string[]
      options: {
        cwd: string
        cols: number
        rows: number
        env: Readonly<Record<string, string | undefined>>
      }
    }> = []
    const store = new FakeStore()
    const manager = new SessionManager({
      store,
      environment: {
        CLAUDE_CONFIG_DIR: '/original/claude-config',
        LANG: 'en_US.UTF-8'
      },
      spawnPty: (command, argv, options) => {
        spawns.push({ executable: command, argv: [...argv], options })
        if (argv.length === 1 && argv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        return ptys[nextPty++]!
      },
      processStartIdentity: async () => `linux-proc-start:${spawns.length}`,
      conversationReferenceExists: async () => true,
      sendTerminalMessage: () => undefined
    })

    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--model', 'sonnet'],
      cols: 80,
      rows: 24
    })
    expect(created.binding).toMatchObject({ status: 'bound', agentCli: 'claude' })
    const reference = created.binding.status === 'bound'
      ? created.binding.conversationReference
      : 'unreachable'
    ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })

    const resumed = await manager.resume({ sessionId: created.sessionId, cols: 100, rows: 35 })

    expect(resumed.sessionId).toBe(created.sessionId)
    expect(resumed.incarnationId).not.toBe(created.incarnationId)
    expect(store.resuming).toEqual([resumed.incarnationId])
    expect(spawns).toHaveLength(3)
    expect(spawns[0]).toMatchObject({
      executable,
      argv: ['--help'],
      options: { cwd, cols: 80, rows: 24 }
    })
    expect(spawns[2]).toMatchObject({
      executable,
      argv: ['--model', 'sonnet', '--resume', reference],
      options: {
        cwd,
        env: {
          CLAUDE_CONFIG_DIR: '/original/claude-config',
          LANG: 'en_US.UTF-8',
          TERM: 'xterm-256color'
        }
      }
    })
    expect(resumed).toMatchObject({
      attachmentId: expect.any(String),
      streamSeq: 0
    })
  })

  it.each([
    ['from-pr selector', ['--from-pr', '123']],
    ['short worktree alias', ['-w', 'feature']],
    ['tmux before continue', ['--tmux', '--continue']],
    ['worktree before continue', ['--worktree', '--continue']],
    ['non-persistent session', ['--no-session-persistence']],
    ['remote-control session', ['--remote-control', 'name']],
    ['optional safe flag before continue', ['--debug', '--continue']],
    ['variadic safe flag before continue', ['--add-dir', '/a', '--continue']],
    ['valueless safe flag before continue', ['--verbose', '--continue']],
    ['positional prompt', ['submit this task']],
    ['attached variadic followed by another bare value', ['--add-dir=/a', '/b']],
    ['attached variadic followed by a prompt', ['--add-dir=/repo', 'fix it']],
    ['attached variadic followed by a subcommand', ['--add-dir=/a', 'attach', '11111111-1111-4111-8111-111111111111']],
    ['variadic with no value', ['--add-dir']],
    ['variadic followed by an option', ['--add-dir', '--verbose']],
    ['required option with no value', ['--model']],
    ['variadic followed by an explicit selector', ['--add-dir', '--session-id', '11111111-1111-4111-8111-111111111111']],
    ['attached value on a valueless option', ['--verbose=x']],
    ['empty attached required value', ['--model=']],
    ['explicit session-id with a non-UUID value', ['--session-id', 'not-a-uuid']]
  ])('refuses %s through the probed grammar at capture and resume', async (_name, argv) => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-grammar-refusal-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const captureSpawns: string[][] = []
    const captureStore = new FakeStore()
    const captureManager = new SessionManager({
      store: captureStore,
      spawnPty: (_command, spawnedArgv) => {
        captureSpawns.push([...spawnedArgv])
        const pty = new FakePty()
        if (spawnedArgv.length === 1 && spawnedArgv[0] === '--help') {
          completeCapabilityProbe(pty)
        }
        return pty
      },
      processStartIdentity: async () => 'linux-proc-start:capture',
      sendTerminalMessage: () => undefined
    })

    const captured = await captureManager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable, argv, cols: 9, rows: 3 })
    expect(captured.binding).toMatchObject({ status: 'unsupported' })
    expect(captureSpawns).toEqual([['--help'], argv])

    const resumeStore = new FakeStore()
    resumeStore.bindings.set('tampered-session', {
      sessionId: 'tampered-session',
      agentCli: 'claude',
      status: 'bound',
      conversationReference: '11111111-1111-4111-8111-111111111111',
      captureRoute: 'claude-session-id',
      launchContext: {
        cwd,
        executable,
        argv,
        environment: captureRelevantLaunchEnvironment({})
      },
      detail: 'tampered stored context',
      capturedAt: '2026-09-12T12:00:00.000Z'
    })
    const resumeSpawns: string[][] = []
    const resumeManager = new SessionManager({
      store: resumeStore,
      spawnPty: (_command, spawnedArgv) => {
        resumeSpawns.push([...spawnedArgv])
        const pty = new FakePty()
        if (spawnedArgv.length === 1 && spawnedArgv[0] === '--help') {
          completeCapabilityProbe(pty)
        }
        return pty
      },
      processStartIdentity: async () => 'linux-proc-start:resume',
      conversationReferenceExists: async () => true,
      sendTerminalMessage: () => undefined
    })

    await expect(
      resumeManager.resume({ sessionId: 'tampered-session', cols: 9, rows: 3 })
    ).rejects.toMatchObject<Partial<HostControlError>>({ code: ERROR_CODES.invalidArgument })
    expect(resumeSpawns).toEqual([['--help']])
    expect(resumeStore.resuming).toEqual([])
  })

  it.each([
    ['camelCase alias', ['--allowedTools', 'Bash', 'Edit']],
    ['kebab-case alias', ['--allowed-tools', 'Bash', 'Edit']],
    ['variadic values', ['--add-dir', '/a', '/b']],
    ['attached value', ['--model=sonnet']]
  ])('replays %s admitted by the probed grammar at both call sites', async (_name, argv) => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-grammar-admission-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const actualPtys = [new FakePty(), new FakePty()]
    const spawns: string[][] = []
    const store = new FakeStore()
    const manager = new SessionManager({
      store,
      spawnPty: (_command, spawnedArgv) => {
        spawns.push([...spawnedArgv])
        if (spawnedArgv.length === 1 && spawnedArgv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        return actualPtys.shift()!
      },
      processStartIdentity: async () => `linux-proc-start:${spawns.length}`,
      conversationReferenceExists: async () => true,
      sendTerminalMessage: () => undefined
    })

    const created = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable, argv, cols: 13, rows: 4 })
    expect(created.binding.status).toBe('bound')
    const reference = created.binding.status === 'bound'
      ? created.binding.conversationReference
      : 'unreachable'
    const createdPty = (manager as unknown as { sessions: Map<string, { pty: FakePty }> })
      .sessions.get(created.sessionId)!.pty
    createdPty.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })

    await expect(
      manager.resume({ sessionId: created.sessionId, cols: 17, rows: 5 })
    ).resolves.toMatchObject({ attachmentId: expect.any(String), streamSeq: 0 })
    expect(spawns).toEqual([
      ['--help'],
      [...argv, '--session-id', reference],
      [...argv, '--resume', reference]
    ])
  })

  it.each([
    ['stored resume selector', ['--resume', '22222222-2222-4222-8222-222222222222']],
    ['stored session-id selector', ['--session-id', '22222222-2222-4222-8222-222222222222']]
  ])('rejects %s after probing and never starts a native resume', async (_name, argv) => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-stored-selector-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const store = new FakeStore()
    store.bindings.set('stored-session', {
      sessionId: 'stored-session',
      agentCli: 'claude',
      status: 'bound',
      conversationReference: '11111111-1111-4111-8111-111111111111',
      captureRoute: 'claude-session-id',
      launchContext: {
        cwd,
        executable,
        argv,
        environment: captureRelevantLaunchEnvironment({})
      },
      detail: 'stored selector mutation',
      capturedAt: '2026-09-12T12:00:00.000Z'
    })
    const spawns: string[][] = []
    const manager = new SessionManager({
      store,
      spawnPty: (_command, spawnedArgv) => {
        spawns.push([...spawnedArgv])
        const probe = new FakePty()
        completeCapabilityProbe(probe)
        return probe
      },
      conversationReferenceExists: async () => true,
      sendTerminalMessage: () => undefined
    })

    await expect(
      manager.resume({ sessionId: 'stored-session', cols: 80, rows: 24 })
    ).rejects.toMatchObject<Partial<HostControlError>>({ code: ERROR_CODES.invalidArgument })
    expect(spawns).toEqual([['--help']])
    expect(store.resuming).toEqual([])
  })

  it.each([
    ['unparseable help', 'Usage: claude [options]\n(no option table)'],
    [
      'non-required session-id arity',
      claudeHelp.replace('--session-id <uuid>', '--session-id [uuid]')
    ],
    [
      'allowlisted flag absent from help',
      claudeHelp.replace(/^ {2}--model <model>.*\n(?: {40}.*\n)*/m, '')
    ]
  ])('fails closed with %s at capture and resume', async (_name, helpOutput) => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-help-shape-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const makeManager = (
      store: FakeStore,
      spawns: string[][]
    ): SessionManager => new SessionManager({
      store,
      spawnPty: (_command, spawnedArgv) => {
        spawns.push([...spawnedArgv])
        const pty = new FakePty()
        if (spawnedArgv.length === 1 && spawnedArgv[0] === '--help') {
          completeCapabilityProbe(pty, helpOutput)
        }
        return pty
      },
      processStartIdentity: async () => 'linux-proc-start:shape',
      conversationReferenceExists: async () => true,
      sendTerminalMessage: () => undefined
    })

    const captureStore = new FakeStore()
    const captureSpawns: string[][] = []
    const captured = await makeManager(captureStore, captureSpawns).create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--model', 'sonnet'],
      cols: 80,
      rows: 24
    })
    expect(captured.binding.status).toBe('unsupported')
    expect(captureSpawns).toEqual([['--help'], ['--model', 'sonnet']])

    const resumeStore = new FakeStore()
    resumeStore.bindings.set('stored-session', {
      sessionId: 'stored-session',
      agentCli: 'claude',
      status: 'bound',
      conversationReference: '11111111-1111-4111-8111-111111111111',
      captureRoute: 'claude-session-id',
      launchContext: {
        cwd,
        executable,
        argv: ['--model', 'sonnet'],
        environment: captureRelevantLaunchEnvironment({})
      },
      detail: 'stored grammar mutation',
      capturedAt: '2026-09-12T12:00:00.000Z'
    })
    const resumeSpawns: string[][] = []
    await expect(
      makeManager(resumeStore, resumeSpawns).resume({
        sessionId: 'stored-session',
        cols: 80,
        rows: 24
      })
    ).rejects.toMatchObject<Partial<HostControlError>>({ code: ERROR_CODES.invalidArgument })
    expect(resumeSpawns).toEqual([['--help']])
  })

  it('refuses a concurrent resume while the first owns the conversation reservation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-concurrent-resume-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const reference = '11111111-1111-4111-8111-111111111111'
    const ptys = [new FakePty(), new FakePty()]
    let nextPty = 0
    const spawn = vi.fn((_executable: string, argv: readonly string[]) => {
      if (argv.length === 1 && argv[0] === '--help') {
        const probe = new FakePty()
        completeCapabilityProbe(probe)
        return probe
      }
      return ptys[nextPty++]!
    })
    let releaseReferenceCheck = (): void => undefined
    const referenceCheck = new Promise<boolean>(
      (resolve) => (releaseReferenceCheck = () => resolve(true))
    )
    const store = new FakeStore()
    const manager = new SessionManager({
      store,
      spawnPty: spawn,
      processStartIdentity: async () => `linux-proc-start:${spawn.mock.calls.length}`,
      conversationReferenceExists: async () => referenceCheck,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', reference],
      cols: 80,
      rows: 24
    })
    ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })

    const firstResume = manager.resume({ sessionId: created.sessionId, cols: 100, rows: 35 })
    const secondResume = manager.resume({ sessionId: created.sessionId, cols: 100, rows: 35 })
    releaseReferenceCheck()
    const [first, second] = await Promise.allSettled([firstResume, secondResume])

    expect(first).toMatchObject({
      status: 'fulfilled',
      value: { attachmentId: expect.any(String), streamSeq: 0 }
    })
    expect(second).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        code: ERROR_CODES.invalidArgument,
        message: expect.stringMatching(/already resuming|live process incarnation/)
      })
    })
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(spawn.mock.calls[2]?.[1]).toEqual(['--resume', reference])
    expect(store.resuming).toHaveLength(1)
    expect(ptys[1]!.killed).toBe(false)
  })

  it('refuses a concurrent resume without stopping the already-spawned winner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-concurrent-resume-no-stop-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const reference = '11111111-1111-4111-8111-111111111111'
    let signalResumeRecord = (): void => undefined
    const resumeRecordStarted = new Promise<void>((resolve) => (signalResumeRecord = resolve))
    let releaseResumeRecord = (): void => undefined
    const resumeRecordReady = new Promise<void>((resolve) => (releaseResumeRecord = resolve))
    class GatedResumeStore extends FakeStore {
      override async createResuming(record: CreateResumingRecord): Promise<void> {
        await super.createResuming(record)
        signalResumeRecord()
        await resumeRecordReady
      }
    }
    const firstPty = new FakePty()
    const resumedPty = new FakePty()
    let actualSpawn = 0
    const manager = new SessionManager({
      store: new GatedResumeStore(),
      spawnPty: (_command, argv) => {
        if (argv.length === 1 && argv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        actualSpawn += 1
        return actualSpawn === 1 ? firstPty : resumedPty
      },
      processStartIdentity: async () => `linux-proc-start:${actualSpawn}`,
      conversationReferenceExists: async () => true,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', reference],
      cols: 80,
      rows: 24
    })
    firstPty.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })

    const winner = manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    await resumeRecordStarted
    await expect(
      manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    ).rejects.toMatchObject<Partial<HostControlError>>({
      code: ERROR_CODES.invalidArgument,
      message: expect.stringContaining('live process incarnation')
    })
    const killedByRefusal = resumedPty.killed
    releaseResumeRecord()
    await expect(winner).resolves.toMatchObject({ attachmentId: expect.any(String) })

    expect(killedByRefusal).toBe(false)
    expect(resumedPty.killed).toBe(false)
    expect(actualSpawn).toBe(2)
  })

  it('refuses create while resume holds the same conversation reservation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-create-during-resume-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const reference = '11111111-1111-4111-8111-111111111111'
    const ptys = [new FakePty(), new FakePty()]
    const spawnArgv: string[][] = []
    let actualPty = 0
    let releaseReferenceCheck = (): void => undefined
    const referenceCheck = new Promise<boolean>(
      (resolve) => (releaseReferenceCheck = () => resolve(true))
    )
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: (_command, argv) => {
        spawnArgv.push([...argv])
        if (argv.length === 1 && argv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        return ptys[actualPty++]!
      },
      processStartIdentity: async () => `linux-proc-start:${spawnArgv.length}`,
      conversationReferenceExists: async () => referenceCheck,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', reference],
      cols: 80,
      rows: 24
    })
    ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })

    const resuming = manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    await expect(manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', reference],
      cols: 80,
      rows: 24
    })).rejects.toMatchObject<Partial<HostControlError>>({
      code: ERROR_CODES.invalidArgument,
      message: expect.stringContaining('already resuming')
    })
    releaseReferenceCheck()
    await expect(resuming).resolves.toMatchObject({ attachmentId: expect.any(String) })

    expect(spawnArgv.filter((argv) => argv[0] !== '--help')).toEqual([
      ['--session-id', reference],
      ['--resume', reference]
    ])
  })

  it('refuses resume while create holds the same conversation reservation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-resume-during-create-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const reference = '11111111-1111-4111-8111-111111111111'
    const ptys = [new FakePty(), new FakePty()]
    const spawnArgv: string[][] = []
    let actualPty = 0
    let signalSecondSpawn = (): void => undefined
    const secondSpawned = new Promise<void>((resolve) => (signalSecondSpawn = resolve))
    let releaseIdentity = (): void => undefined
    const identityReady = new Promise<void>((resolve) => (releaseIdentity = resolve))
    let identityCalls = 0
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: (_command, argv) => {
        spawnArgv.push([...argv])
        if (argv.length === 1 && argv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        actualPty += 1
        if (actualPty === 2) signalSecondSpawn()
        return ptys[actualPty - 1]!
      },
      processStartIdentity: async () => {
        identityCalls += 1
        if (identityCalls === 2) await identityReady
        return `linux-proc-start:${identityCalls}`
      },
      conversationReferenceExists: async () => true,
      sendTerminalMessage: () => undefined
    })
    const first = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', reference],
      cols: 80,
      rows: 24
    })
    ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })

    const creating = manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', reference],
      cols: 80,
      rows: 24
    })
    await secondSpawned
    await expect(
      manager.resume({ sessionId: first.sessionId, cols: 80, rows: 24 })
    ).rejects.toMatchObject<Partial<HostControlError>>({
      code: ERROR_CODES.invalidArgument,
      message: expect.stringContaining('live process incarnation')
    })
    releaseIdentity()
    await expect(creating).resolves.toMatchObject({ binding: { status: 'bound' } })

    expect(spawnArgv.filter((argv) => argv[0] === '--resume')).toEqual([])
    expect(spawnArgv.filter((argv) => argv[0] === '--session-id')).toHaveLength(2)
  })

  it('captures relevant environment absence and unsets later values for existence and resume', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-environment-resume-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const environment: Record<string, string | undefined> = {
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8'
    }
    const ptys = [new FakePty(), new FakePty()]
    let nextPty = 0
    const spawns: Array<{
      argv: string[]
      env: Readonly<Record<string, string | undefined>>
    }> = []
    const checkedBindings: PersistedConversationBinding[] = []
    const manager = new SessionManager({
      store: new FakeStore(),
      environment,
      spawnPty: (_command, argv, options) => {
        spawns.push({ argv: [...argv], env: { ...options.env } })
        if (argv.length === 1 && argv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        return ptys[nextPty++]!
      },
      processStartIdentity: async () => `linux-proc-start:${spawns.length}`,
      conversationReferenceExists: async (binding) => {
        checkedBindings.push(structuredClone(binding))
        return true
      },
      sendTerminalMessage: () => undefined
    })

    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', '11111111-1111-4111-8111-111111111111'],
      cols: 80,
      rows: 24
    })
    expect(created.binding.launchContext.environment).toMatchObject({
      CLAUDE_CONFIG_DIR: null,
      CODEX_HOME: null,
      LANG: 'en_US.UTF-8',
      LC_ALL: null,
      TERM: 'xterm-256color'
    })
    ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })
    environment.CLAUDE_CONFIG_DIR = '/later/claude-config'
    environment.CODEX_HOME = '/later/codex-home'
    environment.LC_ALL = 'uk_UA.UTF-8'

    await manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })

    expect(checkedBindings[0]?.launchContext.environment).toMatchObject({
      CLAUDE_CONFIG_DIR: null,
      CODEX_HOME: null,
      LC_ALL: null
    })
    const resumeEnvironment = spawns.at(-1)!.env
    expect(Object.hasOwn(resumeEnvironment, 'CLAUDE_CONFIG_DIR')).toBe(false)
    expect(Object.hasOwn(resumeEnvironment, 'CODEX_HOME')).toBe(false)
    expect(Object.hasOwn(resumeEnvironment, 'LC_ALL')).toBe(false)
    expect(resumeEnvironment).toMatchObject({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color'
    })
  })

  it('refuses two app-session resumes that target the same conversation identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-shared-conversation-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const reference = '11111111-1111-4111-8111-111111111111'
    const actualPtys = [new FakePty(), new FakePty(), new FakePty()]
    let nextPty = 0
    const spawnArgv: string[][] = []
    const store = new FakeStore()
    let releaseReferenceCheck = (): void => undefined
    const referenceCheck = new Promise<boolean>((resolve) => (releaseReferenceCheck = () => resolve(true)))
    const manager = new SessionManager({
      store,
      spawnPty: (_command, argv) => {
        spawnArgv.push([...argv])
        if (argv.length === 1 && argv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        return actualPtys[nextPty++]!
      },
      processStartIdentity: async () => `linux-proc-start:${spawnArgv.length}`,
      conversationReferenceExists: async () => referenceCheck,
      sendTerminalMessage: () => undefined
    })
    const firstSession = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', reference],
      cols: 80,
      rows: 24
    })
    actualPtys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })
    const secondSession = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', reference],
      cols: 80,
      rows: 24
    })
    actualPtys[1]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })

    const firstResume = manager.resume({ sessionId: firstSession.sessionId, cols: 80, rows: 24 })
    const secondResume = manager.resume({ sessionId: secondSession.sessionId, cols: 80, rows: 24 })
    releaseReferenceCheck()
    const [first, second] = await Promise.allSettled([firstResume, secondResume])

    expect(first).toMatchObject({
      status: 'fulfilled',
      value: { sessionId: firstSession.sessionId, attachmentId: expect.any(String) }
    })
    expect(second).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        code: ERROR_CODES.invalidArgument,
        message: expect.stringMatching(/already resuming|live process incarnation/)
      })
    })
    expect(spawnArgv.filter((argv) => argv[0] === '--resume')).toEqual([
      ['--resume', reference]
    ])
    await expect(
      manager.resume({ sessionId: secondSession.sessionId, cols: 80, rows: 24 })
    ).rejects.toThrow(/already has a live process incarnation/)
  })

  it('does not let a stale PTY exit evict a different registered incarnation', async () => {
    const { manager, pty, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const sessionMap = (manager as unknown as {
      sessions: Map<string, SessionIdentity & Record<string, unknown>>
    }).sessions
    const stale = sessionMap.get(created.sessionId)!
    sessionMap.set(created.sessionId, { ...stale, incarnationId: 'surviving-incarnation' })

    pty.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({
        liveSessions: 1,
        sessions: [{ sessionId: created.sessionId, incarnationId: 'surviving-incarnation' }]
      })
    })
  })

  it('does not let stale interruption cleanup evict a different registered incarnation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-stale-interruption-test-'))
    createdRoots.add(cwd)
    const pty = new NonExitingFakePty()
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: () => pty,
      processStartIdentity: async () => 'linux-proc-start:stable',
      signalProcess: () => true,
      stopGraceMs: 0,
      stopKillWaitMs: 0,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const sessionMap = (manager as unknown as {
      sessions: Map<string, SessionIdentity & Record<string, unknown>>
    }).sessions
    const stale = sessionMap.get(created.sessionId)!
    const stopping = manager.stop(created)
    sessionMap.set(created.sessionId, { ...stale, incarnationId: 'surviving-incarnation' })

    await expect(stopping).rejects.toMatchObject<Partial<HostControlError>>({
      code: ERROR_CODES.ioError
    })
    await expect(manager.health()).resolves.toMatchObject({
      liveSessions: 1,
      sessions: [{ sessionId: created.sessionId, incarnationId: 'surviving-incarnation' }]
    })
  })

  it('probes once per Claude executable identity and launches unmodified when unsupported', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-unsupported-claude-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const spawns: string[][] = []
    const actualPtys: FakePty[] = []
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: (_command, argv) => {
        spawns.push([...argv])
        const pty = new FakePty()
        if (argv.length === 1 && argv[0] === '--help') {
          completeCapabilityProbe(pty, 'Usage: claude [options]\n  --model <model>')
        } else {
          actualPtys.push(pty)
        }
        return pty
      },
      processStartIdentity: async () => `linux-proc-start:${spawns.length}`,
      sendTerminalMessage: () => undefined
    })

    const first = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--model', 'sonnet'],
      cols: 80,
      rows: 24
    })
    expect(first.binding).toMatchObject({
      status: 'unsupported',
      detail: expect.stringContaining('--session-id')
    })
    actualPtys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })
    const second = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--model', 'sonnet'],
      cols: 80,
      rows: 24
    })

    expect(second.binding.status).toBe('unsupported')
    expect(spawns).toEqual([
      ['--help'],
      ['--model', 'sonnet'],
      ['--model', 'sonnet']
    ])
  })

  it('does not cache a timed-out Claude help probe and retries on the next create', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-timeout-reprobe-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    let helpCalls = 0
    const actualPtys: FakePty[] = []
    const manager = new SessionManager({
      store: new FakeStore(),
      capabilityProbeTimeoutMs: 1,
      spawnPty: (_command, argv) => {
        const pty = new FakePty()
        if (argv.length === 1 && argv[0] === '--help') {
          helpCalls += 1
          if (helpCalls === 2) completeCapabilityProbe(pty)
        } else {
          actualPtys.push(pty)
        }
        return pty
      },
      processStartIdentity: async () => `linux-proc-start:${actualPtys.length}`,
      sendTerminalMessage: () => undefined
    })

    const first = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable, argv: [], cols: 8, rows: 2 })
    expect(first.binding.status).toBe('unsupported')
    actualPtys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })
    const second = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable, argv: [], cols: 8, rows: 2 })

    expect(second.binding.status).toBe('bound')
    expect(helpCalls).toBe(2)
  })

  it('requires a zero exit code from a fixed 80 by 24 Claude help probe', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-probe-exit-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const probeShapes: Array<{ cols: number; rows: number }> = []
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: (_command, argv, options) => {
        const pty = new FakePty()
        if (argv.length === 1 && argv[0] === '--help') {
          probeShapes.push({ cols: options.cols, rows: options.rows })
          completeCapabilityProbe(pty, claudeHelp, 7)
        }
        return pty
      },
      processStartIdentity: async () => 'linux-proc-start:probe-exit',
      sendTerminalMessage: () => undefined
    })

    const created = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable, argv: [], cols: 2, rows: 1 })

    expect(created.binding).toMatchObject({
      status: 'unsupported',
      detail: expect.stringContaining('exited with code 7')
    })
    expect(probeShapes).toEqual([{ cols: 80, rows: 24 }])
  })

  it('names the injected session-id flag when the modified launch throws during spawn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-injected-spawn-failure-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: (_command, argv) => {
        if (argv.length === 1 && argv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        throw new Error('injected launch rejected')
      },
      sendTerminalMessage: () => undefined
    })

    await expect(
      manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable, argv: [], cols: 80, rows: 24 })
    ).rejects.toThrow(/BMN injected --session-id/)
  })

  it('names the injected session-id flag when the modified launch exits during startup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-injected-startup-failure-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const spawns: string[][] = []
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: (_command, argv) => {
        spawns.push([...argv])
        const pty = new FakePty()
        if (argv.length === 1 && argv[0] === '--help') {
          completeCapabilityProbe(pty)
        } else {
          queueMicrotask(() => pty.emitExit({ exitCode: 2 }))
        }
        return pty
      },
      processStartIdentity: async () => `linux-proc-start:${spawns.length}`,
      sendTerminalMessage: () => undefined
    })

    await expect(
      manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable, argv: [], cols: 80, rows: 24 })
    ).rejects.toThrow(/BMN injected --session-id/)
    expect(spawns).toHaveLength(2)
    expect(spawns[1]).toEqual(['--session-id', expect.any(String)])
  })

  it('reports a missing bound reference and spawns nothing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-missing-binding-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const firstPty = new FakePty()
    const spawn = vi.fn((_command: string, argv: readonly string[]) => {
      if (argv.length === 1 && argv[0] === '--help') {
        const probe = new FakePty()
        completeCapabilityProbe(probe)
        return probe
      }
      return firstPty
    })
    const store = new FakeStore()
    const manager = new SessionManager({
      store,
      spawnPty: spawn,
      processStartIdentity: async () => 'linux-proc-start:1',
      conversationReferenceExists: async () => false,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable, argv: [], cols: 80, rows: 24 })
    firstPty.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })

    await expect(manager.conversationBinding(created.sessionId)).resolves.toMatchObject({
      status: 'missing',
      detail: expect.stringContaining('no process was started')
    })
    await expect(
      manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    ).rejects.toMatchObject<Partial<HostControlError>>({ code: ERROR_CODES.notFound })
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('revokes a dropped renderer stream immediately without stopping its process', async () => {
    const { manager, pty, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const attached = manager.attach(created)
    manager.activateAttachment(attached.attachmentId)
    manager.rendererDisconnected()

    expect(pty.killed).toBe(false)
    expect(manager.hasAttachment(attached.attachmentId)).toBe(false)
    await expect(manager.health()).resolves.toMatchObject({ liveSessions: 1 })
  })

  it('surfaces an observed shell exit through the terminal transport', async () => {
    const { manager, pty, sent, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const attached = manager.attach(created)
    manager.activateAttachment(attached.attachmentId)

    pty.emitExit({ exitCode: 23, signal: 15 })
    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        kind: 'terminal-exit',
        state: 'exited',
        attachmentId: attached.attachmentId,
        exitCode: 23,
        signal: 15
      })
    })
  })

  it('reports a session record live only while the host holds its incarnation, then the recorded outcome', async () => {
    const { manager, pty, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const stored = (lastProcess: SessionRecord['lastProcess']): SessionRecord => ({
      sessionId: created.sessionId,
      workspaceId: DEFAULT_SESSION_CREATION.workspaceId,
      name: 'Shell',
      cwd,
      executable: process.execPath,
      argv: [],
      position: 0,
      backgroundChoice: null,
      terminalGraphics: null,
      revision: 1,
      createdAt: '2026-09-13T00:00:00.000Z',
      archivedAt: null,
      lastProcess
    })
    const runningRow = stored({ incarnationId: created.incarnationId, state: 'interrupted', exitCode: null, signal: null, detail: null })
    expect(manager.sessionWithCurrentProcessState(runningRow).lastProcess)
      .toEqual({ incarnationId: created.incarnationId, state: 'live', exitCode: null, signal: null, detail: null })
    const olderRow = stored({ incarnationId: 'older-incarnation', state: 'exited', exitCode: 0, signal: null, detail: null })
    expect(manager.sessionWithCurrentProcessState(olderRow)).toBe(olderRow)
    expect(manager.sessionWithCurrentProcessState(stored(null)).lastProcess).toBeNull()

    pty.emitExit({ exitCode: 0, signal: 1 })
    await vi.waitFor(() => {
      expect(manager.sessionWithCurrentProcessState(runningRow).lastProcess?.state).toBe('interrupted')
    })
    const exitedRow = stored({ incarnationId: created.incarnationId, state: 'exited', exitCode: 0, signal: 1, detail: null })
    expect(manager.sessionWithCurrentProcessState(exitedRow)).toBe(exitedRow)
  })

  // Windows Stop uses owned jobs; windows-pty-ownership.mjs exercises its native path.
  it.skipIf(process.platform === 'win32')('escalates a SIGHUP-ignoring shell and records the PTY-reported signal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-session-test-'))
    createdRoots.add(cwd)
    const store = new FakeStore()
    let ready = (): void => undefined
    const shellReady = new Promise<void>((resolve) => (ready = resolve))
    const manager = new SessionManager({
      store,
      spawnPty: (executable, argv, options) => {
        const spawned = nodePty.spawn(executable, [...argv], { ...options, env: { ...options.env }, encoding: null })
        spawned.onData((data) => {
          if (String(data).includes('READY')) ready()
        })
        return spawned
      },
      sendTerminalMessage: () => undefined,
      stopGraceMs: 50,
      stopKillWaitMs: 2_000
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: '/bin/bash',
      argv: ['--noprofile', '--norc', '-c', "trap '' HUP; printf READY; sleep 30"],
      cols: 80,
      rows: 24
    })
    await shellReady

    await manager.stop(created)

    expect(store.exited.get(created.incarnationId)?.signal).toBe(9)
    expect(store.interrupted.has(created.incarnationId)).toBe(false)
  })

  it('uses retained Windows ownership when PID identity lookup fails', async () => {
    const { pty, store, cwd } = await fixture()
    Object.assign(pty, { processOwnership: 'windows-job', processStartIdentity: 'windows-filetime:12345' })
    const identify = vi.fn(async () => { throw new Error('PID lookup denied') })
    const signalProcess = vi.fn(() => true)
    const manager = new SessionManager({
      store, spawnPty: () => pty, processStartIdentity: identify, signalProcess,
      sendTerminalMessage: () => undefined, stopGraceMs: 1, stopKillWaitMs: 1
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    })
    await manager.stop(created)
    expect(pty.killed).toBe(true)
    expect(identify).not.toHaveBeenCalled()
    expect(signalProcess).not.toHaveBeenCalled()
    expect(store.exited.has(created.incarnationId)).toBe(true)
  })

  it('keeps unconfirmed Windows job termination interrupted without PID fallback', async () => {
    const { store, cwd } = await fixture()
    const pty = new NonExitingFakePty()
    Object.assign(pty, { processOwnership: 'windows-job', processStartIdentity: 'windows-filetime:12345' })
    const signalProcess = vi.fn(() => true)
    const manager = new SessionManager({
      store, spawnPty: () => pty, processStartIdentity: async () => 'windows-filetime:12345', signalProcess,
      sendTerminalMessage: () => undefined, stopGraceMs: 1, stopKillWaitMs: 1
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    })
    await expect(manager.stop(created)).rejects.toThrow(/stop outcome is unknown/)
    expect(pty.killCalls).toBe(1)
    expect(signalProcess).not.toHaveBeenCalled()
    expect(store.interrupted.get(created.incarnationId)).toMatch(/owned Windows process tree.*not confirmed/i)
  })

  it('records an explicit interrupted outcome when SIGKILL cannot be reaped', async () => {
    const { pty, store, sent, cwd } = await fixture()
    pty.kill = () => {
      pty.killed = true
    }
    const manager = new SessionManager({
      store,
      spawnPty: () => pty,
      processStartIdentity: async () => 'linux-proc-start:12345',
      sendTerminalMessage: (message) => sent.push(message),
      signalProcess: () => true,
      stopGraceMs: 1,
      stopKillWaitMs: 1
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const attached = manager.attach(created)
    manager.activateAttachment(attached.attachmentId)

    await expect(manager.stop(created)).rejects.toMatchObject<Partial<HostControlError>>({
      code: ERROR_CODES.ioError,
      retryable: true
    })
    expect(store.exited.has(created.incarnationId)).toBe(false)
    expect(store.interrupted.get(created.incarnationId)).toMatch(/SIGKILL.*not observed/i)
    expect(sent).toContainEqual({
      kind: 'terminal-exit',
      state: 'interrupted',
      attachmentId: attached.attachmentId,
      cause: 'unobserved-loss',
      reason: 'SIGKILL was sent but a PTY exit event was not observed'
    })
    await expect(manager.health()).resolves.toMatchObject({ liveSessions: 1 })
  })

  it('does not signal a recycled pid when the process identity changed before stop', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-recycled-pid-test-'))
    createdRoots.add(cwd)
    const pty = new NonExitingFakePty()
    const store = new FakeStore()
    const signalProcess = vi.fn(() => true)
    let identityReads = 0
    const manager = new SessionManager({
      store,
      spawnPty: () => pty,
      processStartIdentity: async () =>
        ++identityReads === 1 ? 'linux-proc-start:original' : 'linux-proc-start:replacement',
      signalProcess,
      stopGraceMs: 0,
      stopKillWaitMs: 0,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })

    await expect(manager.stop(created)).rejects.toThrow(/stop outcome is unknown/)

    expect(pty.killCalls).toBe(0)
    expect(signalProcess).not.toHaveBeenCalled()
    expect(store.interrupted.get(created.incarnationId)).toMatch(/identity disappeared or changed/i)
  })

  it('tears down exactly once when host-side resume attachment fails and blocks re-resume until exit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-resume-attach-failure-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const reference = '11111111-1111-4111-8111-111111111111'
    const firstPty = new FakePty()
    const resumedPty = new NonExitingFakePty()
    const spawnArgv: string[][] = []
    let actualSpawn = 0
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: (_command, argv) => {
        spawnArgv.push([...argv])
        if (argv.length === 1 && argv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        actualSpawn += 1
        return actualSpawn === 1 ? firstPty : resumedPty
      },
      processStartIdentity: async () => 'linux-proc-start:stable',
      conversationReferenceExists: async () => true,
      signalProcess: () => true,
      stopGraceMs: 0,
      stopKillWaitMs: 0,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', reference],
      cols: 80,
      rows: 24
    })
    firstPty.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })
    vi.spyOn(manager, 'attach').mockImplementationOnce(() => {
      throw new HostControlError(ERROR_CODES.ioError, 'injected host attachment failure')
    })

    await expect(
      manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    ).rejects.toThrow(/injected host attachment failure/)
    expect(resumedPty.killCalls).toBe(1)
    await expect(manager.health()).resolves.toMatchObject({
      liveSessions: 1,
      sessions: [{ state: 'exit-unconfirmed', attached: false }]
    })
    await expect(
      manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    ).rejects.toThrow(/exit-unconfirmed process incarnation/)
    expect(resumedPty.killCalls).toBe(1)
    expect(spawnArgv.filter((argv) => argv[0] === '--resume')).toEqual([
      ['--resume', reference]
    ])
  })

  it('keeps the reservation when the resume record fails and the spawned PTY never exits', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-resume-record-failure-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const reference = '11111111-1111-4111-8111-111111111111'
    class FailingResumeStore extends FakeStore {
      override async createResuming(record: CreateResumingRecord): Promise<void> {
        this.resuming.push(record.incarnationId)
        if (this.resuming.length === 1) throw new Error('disk full')
      }
    }
    const store = new FailingResumeStore()
    const firstPty = new FakePty()
    const resumedPty = new NonExitingFakePty()
    const spawnArgv: string[][] = []
    let actualSpawn = 0
    const manager = new SessionManager({
      store,
      spawnPty: (_command, argv) => {
        spawnArgv.push([...argv])
        if (argv.length === 1 && argv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        actualSpawn += 1
        return actualSpawn === 1 ? firstPty : resumedPty
      },
      processStartIdentity: async () => 'linux-proc-start:stable',
      conversationReferenceExists: async () => true,
      signalProcess: () => true,
      stopGraceMs: 0,
      stopKillWaitMs: 0,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', reference],
      cols: 80,
      rows: 24
    })
    firstPty.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })

    await expect(
      manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    ).rejects.toThrow(/disk full/)
    expect(resumedPty.killCalls).toBe(1)
    await expect(
      manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    ).rejects.toThrow(/exit-unconfirmed process incarnation/)
    await expect(manager.health()).resolves.toMatchObject({
      liveSessions: 1,
      sessions: [{ state: 'exit-unconfirmed', attached: false }]
    })
    expect(spawnArgv.filter((argv) => argv[0] === '--resume')).toEqual([
      ['--resume', reference]
    ])
  })

  it('keeps an exit-unconfirmed bound incarnation registered and blocks resume', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-unconfirmed-stop-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const runningPty = new NonExitingFakePty()
    const spawnArgv: string[][] = []
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: (_command, argv) => {
        spawnArgv.push([...argv])
        if (argv.length === 1 && argv[0] === '--help') {
          const probe = new FakePty()
          completeCapabilityProbe(probe)
          return probe
        }
        return runningPty
      },
      processStartIdentity: async () => 'linux-proc-start:stable',
      conversationReferenceExists: async () => true,
      signalProcess: () => true,
      stopGraceMs: 0,
      stopKillWaitMs: 0,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable,
      argv: ['--session-id', '11111111-1111-4111-8111-111111111111'],
      cols: 80,
      rows: 24
    })

    await expect(manager.stop(created)).rejects.toThrow(/stop outcome is unknown/)
    await expect(manager.health()).resolves.toMatchObject({
      liveSessions: 1,
      sessions: [
        {
          sessionId: created.sessionId,
          incarnationId: created.incarnationId,
          state: 'exit-unconfirmed'
        }
      ]
    })
    await expect(
      manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    ).rejects.toThrow(/exit-unconfirmed process incarnation/)
    expect(spawnArgv.filter((argv) => argv[0] === '--resume')).toEqual([])
  })

  it('buffers output from port close immediately for exactly one replacement attachment', async () => {
    const { manager, pty, sent, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const stale = manager.attach(created)
    manager.activateAttachment(stale.attachmentId)
    manager.rendererDisconnected()
    pty.emit('after-port-close')
    const fresh = manager.attach(created)
    const activation = manager.activateAttachment(fresh.attachmentId)

    expect(activation.undeliveredOutput.truncated).toBe(false)
    expect(terminalOutput(sent, fresh.attachmentId)).toEqual(encoder.encode('after-port-close'))
    expect(manager.hasAttachment(fresh.attachmentId)).toBe(true)
  })

  it('does not replay a consumed terminal query into a replacement xterm and preserves pre-activation repaint', async () => {
    const { manager, pty, sent, cwd } = await fixture()
    const spawn = vi.spyOn(manager, 'spawnValidatedPty')
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 40,
      rows: 8
    })
    const first = manager.attach(created)
    manager.activateAttachment(first.attachmentId)
    const original = new Terminal({ cols: 40, rows: 8, allowProposedApi: true })
    const replacementTerminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true })
    const originalReplies: string[] = []
    const replacementReplies: string[] = []
    original.onData((reply) => originalReplies.push(reply))
    replacementTerminal.onData((reply) => replacementReplies.push(reply))
    pty.emit('\u001b[6n')
    await writeTerminal(original, terminalOutput(sent, first.attachmentId))
    manager.detach({ attachmentId: first.attachmentId })
    sent.length = 0
    pty.emit('repaint-before-activation')

    const replacement = manager.attach(created)
    manager.activateAttachment(replacement.attachmentId)
    try {
      await writeTerminal(replacementTerminal, terminalOutput(sent, replacement.attachmentId))
      expect(originalReplies).toEqual(['\u001b[1;1R'])
      expect(replacementReplies).toEqual([])
      expect(terminalOutput(sent, replacement.attachmentId)).toEqual(
        encoder.encode('repaint-before-activation')
      )
    } finally {
      original.dispose()
      replacementTerminal.dispose()
    }
    expect(spawn).toHaveBeenCalledOnce()
    expect(pty.killed).toBe(false)
    await expect(manager.health()).resolves.toMatchObject({ liveSessions: 1 })
  })

  it('routes PTY output through the byte framer before publishing it', async () => {
    const { manager, pty, sent, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const attached = manager.attach(created)
    manager.activateAttachment(attached.attachmentId)
    const prefix = encoder.encode('\u001b]0;Мод')

    pty.emit(prefix)
    expect(terminalOutput(sent, attached.attachmentId)).toEqual(new Uint8Array())
    pty.emit(encoder.encode('уль\u0007'))

    expect(terminalOutput(sent, attached.attachmentId)).toEqual(
      encoder.encode('\u001b]0;Модуль\u0007')
    )
  })

  it('does not replay a Sixel tail as text after the renderer disconnects mid-frame', async () => {
    const { manager, pty, sent, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    })
    const first = manager.attach(created)
    manager.activateAttachment(first.attachmentId)
    pty.emit(`\u001bP9;1;0q"1;1;1;1#1;2;100;0;0#1${'1#1'.repeat(22_000)}`)
    // The first 64 KiB parser atom of the image reached the view; the rest waits for its end.
    expect(terminalOutput(sent, first.attachmentId).byteLength).toBe(64 * 1024)

    manager.rendererDisconnected()
    pty.emit(`${'1#1'.repeat(2_000)}\u001b\\safe-after-image`)
    const replacement = manager.attach(created)
    manager.activateAttachment(replacement.attachmentId)

    expect(terminalOutput(sent, replacement.attachmentId)).toEqual(encoder.encode('\u001b\\safe-after-image'))
  })

  // With 64 KiB + 1 credit the old view starts the frame holding the terminator, so the rest of
  // that frame is dropped rather than replayed. Every replacement discloses the image tail it lacks.
  it.each([
    // The replacement's credit is the same, so it holds the first 4 bytes after the fresh start.
    [4, '\u001b\\sa'],
    [65_536, '\u001b\\safe-after-image'],
    [65_537, '']
  ])('does not replay a completed Sixel tail with %i byte old-view credit', async (credit, expected) => {
    const { manager, pty, sent, cwd } = await fixture(undefined, {
      consumerBytes: credit, hostBytes: 128 * 1024
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    })
    const first = manager.attach(created)
    manager.activateAttachment(first.attachmentId)
    pty.emit(`\u001bP9;1;0q${'1#1'.repeat(22_000)}`)
    expect(terminalOutput(sent, first.attachmentId).byteLength).toBe(Math.min(credit, 64 * 1024))
    pty.emit(`${'1#1'.repeat(2_000)}\u001b\\safe-after-image`)
    manager.rendererDisconnected()
    const replacement = manager.attach(created)
    const activation = manager.activateAttachment(replacement.attachmentId)

    expect(new TextDecoder().decode(terminalOutput(sent, replacement.attachmentId))).toBe(expected)
    expect(activation.undeliveredOutput.truncated).toBe(true)
  })

  it('does not replay a Sixel tail after the undelivered cap drops its header', async () => {
    const { manager, pty, sent, cwd } = await fixture(10 * 1024)
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    })
    pty.emit(`\u001bP9;1;0q${'1#1'.repeat(22_000)}`)
    pty.emit(`${'1#1'.repeat(2_000)}\u001b\\safe-after-image`)
    const replacement = manager.attach(created)
    const activation = manager.activateAttachment(replacement.attachmentId)

    expect(activation.undeliveredOutput.truncated).toBe(true)
    expect(terminalOutput(sent, replacement.attachmentId)).toEqual(encoder.encode('\u001b\\safe-after-image'))
  })

  it('keeps an evicted Sixel tail out when a view activates before its terminator', async () => {
    const { manager, pty, sent, cwd } = await fixture(10 * 1024)
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    })
    pty.emit(`\u001bP9;1;0q${'1#1'.repeat(22_000)}`)
    const replacement = manager.attach(created)
    expect(manager.activateAttachment(replacement.attachmentId).undeliveredOutput.truncated).toBe(true)
    pty.emit(`${'1#1'.repeat(2_000)}\u001b\\safe-after-image`)
    const fresh = encoder.encode('\u001bP9;1;0q"1;1;1;1#1~\u001b\\')
    pty.emit(fresh)

    const output = terminalOutput(sent, replacement.attachmentId)
    expect(new TextDecoder().decode(output.subarray(0, '\u001b\\safe-after-image'.length)))
      .toBe('\u001b\\safe-after-image')
    expect(Buffer.from(output).includes(Buffer.from(fresh))).toBe(true)
  })

  it('replays a buffered Sixel image whole after views attach and leave without activating', async () => {
    const { manager, pty, sent, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    })
    const image = `\u001bP9;1;0q${'1#1'.repeat(22_000)}`
    pty.emit(image)
    const unactivated = manager.attach(created)
    manager.detach({ attachmentId: unactivated.attachmentId })
    const stillUnactivated = manager.attach(created)
    manager.detach({ attachmentId: stillUnactivated.attachmentId })
    pty.emit(`${'1#1'.repeat(2_000)}\u001b\\safe-after-image`)
    const replacement = manager.attach(created)
    manager.activateAttachment(replacement.attachmentId)

    expect(terminalOutput(sent, replacement.attachmentId)).toEqual(
      encoder.encode(`${image}${'1#1'.repeat(2_000)}\u001b\\safe-after-image`)
    )
  })

  it('flushes an incomplete parser atom before publishing terminal exit', async () => {
    const { manager, pty, sent, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const attached = manager.attach(created)
    manager.activateAttachment(attached.attachmentId)
    const incomplete = encoder.encode('\u001bP1;2|unfinished')

    pty.emit(incomplete)
    expect(terminalOutput(sent, attached.attachmentId)).toEqual(new Uint8Array())
    pty.emitExit({ exitCode: 0 })

    await vi.waitFor(() => {
      expect(terminalOutput(sent, attached.attachmentId)).toEqual(incomplete)
      expect(sent.at(-1)).toMatchObject({ kind: 'terminal-exit', exitCode: 0 })
    })
  })

  it('reports a confirmed exit as exited and not live while paced output is still draining', async () => {
    const { manager, pty, cwd } = await fixture(undefined, {
      consumerBytes: 4,
      hostBytes: 64,
      acknowledgementDeadlineMs: 25
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const view = manager.attach(created)
    manager.activateAttachment(view.attachmentId)
    pty.emit('abcdefgh')

    pty.emitExit({ exitCode: 0 })

    await expect(manager.health()).resolves.toMatchObject({
      liveSessions: 0,
      sessions: [{
        sessionId: created.sessionId,
        incarnationId: created.incarnationId,
        attached: true,
        state: 'exited',
        outputDraining: true
      }]
    })
    manager.acknowledge({ attachmentId: view.attachmentId, streamSeq: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ sessions: [] })
    })
  })

  it('bounds undelivered output by whole frames, keeps the PTY draining, and resets disclosure per activation', async () => {
    const { manager, pty, sent, cwd } = await fixture(8)
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    pty.emit('abcd')
    pty.emit('efgh')
    pty.emit('ij')

    expect(pty.paused).toBe(false)
    expect(manager.undeliveredOutputState(created)).toEqual({
      limitBytes: 8,
      bufferedBytes: 6,
      droppedBytes: 4,
      truncated: true
    })

    const replacement = manager.attach(created)
    const activation = manager.activateAttachment(replacement.attachmentId)
    expect(terminalOutput(sent, replacement.attachmentId)).toEqual(encoder.encode('efghij'))
    expect(activation.undeliveredOutput).toEqual({ limitBytes: 8, droppedBytes: 4, truncated: true })

    manager.detach({ attachmentId: replacement.attachmentId })
    pty.emit('next')
    const next = manager.attach(created)
    expect(manager.activateAttachment(next.attachmentId).undeliveredOutput).toEqual({
      limitBytes: 8,
      droppedBytes: 0,
      truncated: false
    })
  })

  it('paces recovery activation by acknowledgement credit', async () => {
    const { manager, pty, sent, cwd } = await fixture(8, {
      consumerBytes: 4,
      hostBytes: 16
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    pty.emit('abcd')
    pty.emit('efgh')
    pty.emit('ij')
    const replacement = manager.attach(created)

    const activation = manager.activateAttachment(replacement.attachmentId)

    expect(activation.undeliveredOutput).toEqual({ limitBytes: 8, droppedBytes: 4, truncated: true })
    expect(terminalOutput(sent, replacement.attachmentId)).toEqual(encoder.encode('efgh'))
    expect(pty.paused).toBe(true)

    manager.acknowledge({ attachmentId: replacement.attachmentId, streamSeq: 0 })

    expect(terminalOutput(sent, replacement.attachmentId)).toEqual(encoder.encode('efghij'))
    expect(pty.paused).toBe(false)
  })

  it('retains later buffered frames if activation overflows and revokes its queue', async () => {
    const { manager, pty, sent, cwd } = await fixture(64, {
      consumerBytes: 4, hostBytes: 4
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    })
    pty.emit('abcd')
    pty.emit('efgh')
    pty.emit('ij')
    const first = manager.attach(created)
    manager.activateAttachment(first.attachmentId)

    expect(terminalOutput(sent, first.attachmentId)).toEqual(encoder.encode('abcd'))
    expect(manager.hasAttachment(first.attachmentId)).toBe(false)
    expect(manager.undeliveredOutputState(created)).toMatchObject({
      bufferedBytes: 6, droppedBytes: 0, truncated: false
    })
  })

  it('keeps output from a PTY resumed by replay overflow behind the unreplayed backlog', async () => {
    const { manager, pty, sent, cwd } = await fixture(64, {
      consumerBytes: 4, hostBytes: 8
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    })
    pty.emit('abcd')
    pty.emit('efgh')
    pty.emit('ij')
    pty.emit('k')
    const resume = pty.resume.bind(pty)
    pty.resume = () => {
      pty.resume = resume
      resume()
      pty.emit('N')
    }
    const first = manager.attach(created)
    manager.activateAttachment(first.attachmentId)
    expect(manager.hasAttachment(first.attachmentId)).toBe(false)

    const replacement = manager.attach(created)
    manager.activateAttachment(replacement.attachmentId)
    manager.acknowledge({ attachmentId: replacement.attachmentId, streamSeq: 0 })

    expect(terminalOutput(sent, replacement.attachmentId)).toEqual(encoder.encode('efghijkN'))
  })

  it('revokes a stalled attachment after the acknowledgement deadline and continues draining without a view', async () => {
    vi.useFakeTimers()
    const { manager, pty, sent, cwd } = await fixture(8, {
      consumerBytes: 4,
      hostBytes: 16,
      acknowledgementDeadlineMs: 25
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const attached = manager.attach(created)
    manager.activateAttachment(attached.attachmentId)
    pty.emit('stalled')
    expect(pty.paused).toBe(true)

    vi.advanceTimersByTime(25)

    expect(sent).toContainEqual({
      kind: 'terminal-view-disconnected',
      attachmentId: attached.attachmentId,
      reason: 'acknowledgement-timeout'
    })
    expect(manager.hasAttachment(attached.attachmentId)).toBe(false)
    expect(pty.paused).toBe(false)

    pty.emit('abcd')
    pty.emit('efgh')
    pty.emit('ij')
    expect(pty.paused).toBe(false)
    expect(manager.undeliveredOutputState(created)).toEqual({
      limitBytes: 8,
      bufferedBytes: 6,
      droppedBytes: 7,
      truncated: true
    })
  })

  it('returns whole never-published frames on timeout and counts a partially sent tail for the replacement view', async () => {
    vi.useFakeTimers()
    const { manager, pty, sent, cwd } = await fixture(64, {
      consumerBytes: 4,
      hostBytes: 64,
      acknowledgementDeadlineMs: 25
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const first = manager.attach(created)
    manager.activateAttachment(first.attachmentId)
    pty.emit('abcdUNSENT')
    pty.emit('WHOLE')

    vi.advanceTimersByTime(25)
    const replacement = manager.attach(created)
    const activation = manager.activateAttachment(replacement.attachmentId)

    expect(terminalOutput(sent, first.attachmentId)).toEqual(encoder.encode('abcd'))
    manager.acknowledge({ attachmentId: replacement.attachmentId, streamSeq: 0 })
    expect(terminalOutput(sent, replacement.attachmentId)).toEqual(encoder.encode('WHOLE'))
    expect(activation.undeliveredOutput).toEqual({
      limitBytes: 64,
      droppedBytes: encoder.encode('UNSENT').byteLength,
      truncated: true
    })
  })

  it('disconnects only a slow view under continuous output while other views and both processes continue', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-session-test-'))
    createdRoots.add(cwd)
    const ptys = [new FakePty(), new FakePty()]
    const store = new FakeStore()
    const sent: TerminalPortMessage[] = []
    const manager = new SessionManager({
      store,
      savedOutputStore: new FakeSavedOutputStore(),
      spawnPty: () => ptys.shift()!,
      processStartIdentity: async (pid) => `linux-proc-start:${pid}`,
      sendTerminalMessage: (message) => sent.push(message),
      outputQueueLimits: { consumerBytes: 4, hostBytes: 8 }
    })
    const firstPty = ptys[0]!
    const secondPty = ptys[1]!
    const first = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 })
    const second = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 })
    const firstView = manager.attach(first)
    const secondView = manager.attach(second)
    manager.activateAttachment(firstView.attachmentId)
    manager.activateAttachment(secondView.attachmentId)

    firstPty.emit(new Uint8Array(3))
    firstPty.emit(new Uint8Array(3))
    firstPty.emit(new Uint8Array(3))
    secondPty.emit('ok')

    expect(sent).toContainEqual({
      kind: 'terminal-view-disconnected',
      attachmentId: firstView.attachmentId,
      reason: 'output-overflow'
    })
    expect(terminalOutput(sent, secondView.attachmentId)).toEqual(encoder.encode('ok'))
    expect(manager.hasAttachment(firstView.attachmentId)).toBe(false)
    expect(manager.hasAttachment(secondView.attachmentId)).toBe(true)
    expect(firstPty.killed).toBe(false)
    expect(secondPty.killed).toBe(false)
  })

  it('rejects an invalid acknowledgement sequence without killing the session', async () => {
    const { manager, pty, sent, cwd } = await fixture(undefined, {
      consumerBytes: 32,
      hostBytes: 64
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 })
    const view = manager.attach(created)
    manager.activateAttachment(view.attachmentId)
    pty.emit('first')
    pty.emit('second')

    manager.acknowledge({ attachmentId: view.attachmentId, streamSeq: 1 })

    expect(sent).toContainEqual({
      kind: 'terminal-view-disconnected',
      attachmentId: view.attachmentId,
      reason: 'sequence-gap'
    })
    expect(manager.hasAttachment(view.attachmentId)).toBe(false)
    expect(pty.killed).toBe(false)
    await expect(manager.health()).resolves.toMatchObject({ liveSessions: 1 })
  })

  it('persists Part A retention disclosure and never labels a genuinely exited PTY as live', async () => {
    const { manager, pty, savedOutputStore, cwd } = await fixture(8)
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 })
    pty.emit('abcd')
    pty.emit('efgh')
    pty.emit('ij')

    await manager.saveTerminalSnapshot(created, validCapture())
    await expect(savedOutputStore.load(created)).resolves.toMatchObject({
      captureStartedAt: expect.stringMatching(/T/),
      lineLimit: TERMINAL_SCROLLBACK_LINES,
      snapshotLimitBytes: 64 * 1024 * 1024,
      snapshotTruncated: false,
      snapshotDroppedLines: 0,
      snapshotDroppedBytes: 0,
      transportDroppedBytes: 0,
      processState: 'live'
    })

    pty.emitExit({ exitCode: 23 })
    await vi.waitFor(async () => {
      await expect(manager.savedOutput(created)).resolves.toMatchObject({
        content: 'saved plain text',
        processState: 'exited'
      })
    })
  })

  it.each([
    ['non-integer', 0.5],
    ['negative', -1],
    ['above the scrollback bound', TERMINAL_SCROLLBACK_LINES + 1]
  ])('rejects a %s saved-output line count', async (_description, retainedLines) => {
    const { manager, savedOutputStore, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })

    await expect(
      manager.saveTerminalSnapshot(created, validCapture({ retainedLines }))
    ).rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })
    expect(savedOutputStore.snapshots.size).toBe(0)
  })

  it.each([
    ['zero', 0],
    ['the scrollback limit', TERMINAL_SCROLLBACK_LINES]
  ])('accepts %s as a saved-output line count', async (_description, retainedLines) => {
    const { manager, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })

    await expect(
      manager.saveTerminalSnapshot(created, validCapture({ retainedLines }))
    ).resolves.toMatchObject({ retainedLines })
  })

  it.each([
    ['a non-string value', 42],
    ['an unparseable string', 'not-a-date']
  ])('rejects %s as a saved-output capture time', async (_description, capturedAt) => {
    const { manager, savedOutputStore, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })

    await expect(
      manager.saveTerminalSnapshot(created, validCapture({ capturedAt: capturedAt as string }))
    ).rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })
    expect(savedOutputStore.snapshots.size).toBe(0)
  })

  it('rejects saved output whose encoded content exceeds the byte limit', async () => {
    const { manager, savedOutputStore, cwd } = await fixture()
    const save = vi.spyOn(savedOutputStore, 'save').mockResolvedValue()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const oversizedContent = '\u0800'.repeat(Math.floor(TERMINAL_SAVED_OUTPUT_BYTES / 3) + 1)
    let rejection: unknown

    try {
      await manager.saveTerminalSnapshot(created, validCapture({ content: oversizedContent }))
    } catch (error) {
      rejection = error
    }

    expect(rejection).toMatchObject({ code: ERROR_CODES.invalidArgument })
    expect(save).not.toHaveBeenCalled()
  })

  it('reports a live session snapshot as live even when its stored state is stale', async () => {
    const { manager, savedOutputStore, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    await manager.saveTerminalSnapshot(created, validCapture())
    await savedOutputStore.markProcessState(created, 'interrupted')

    await expect(manager.savedOutput(created)).resolves.toMatchObject({ processState: 'live' })
  })

  it('never reports saved output live for an exit-unconfirmed incarnation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-saved-output-unconfirmed-test-'))
    createdRoots.add(cwd)
    const pty = new NonExitingFakePty()
    const savedOutputStore = new FakeSavedOutputStore()
    const manager = new SessionManager({
      store: new FakeStore(),
      savedOutputStore,
      spawnPty: () => pty,
      processStartIdentity: async () => 'linux-proc-start:stable',
      signalProcess: () => true,
      stopGraceMs: 0,
      stopKillWaitMs: 0,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    await manager.saveTerminalSnapshot(created, validCapture())

    await expect(manager.stop(created)).rejects.toThrow(/stop outcome is unknown/)

    await expect(manager.savedOutput(created)).resolves.toMatchObject({
      processState: 'interrupted'
    })
  })

  it('keeps a fresh session catalog isolated from another session snapshot and loss records', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-session-test-'))
    createdRoots.add(cwd)
    const savedOutputDirectory = join(cwd, 'saved-output')
    const pty = new FakePty()
    const manager = new SessionManager({
      store: new FakeStore(),
      savedOutputStore: new FileSavedOutputStore(savedOutputDirectory),
      spawnPty: () => pty,
      processStartIdentity: async () => 'linux-proc-start:4242',
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 })
    pty.emit('captured before loss')
    await manager.saveTerminalSnapshot(created, validCapture({ content: 'captured before loss' }))
    await manager.recordFinalCaptureUnavailable(created, {
      viewEpoch: `initial:${created.incarnationId}`,
      captureStartedAt: '2026-09-12T08:00:00.000Z',
      unavailableAt: '2026-09-12T08:00:30.000Z',
      reason: 'no-renderer',
      detail: 'the other session lost its renderer',
      processState: 'live'
    })
    await writeFile(
      join(savedOutputDirectory, `${encodeURIComponent(created.sessionId)}--broken--view.snapshot.json`),
      '{not-json',
      'utf8'
    )
    const restartedManager = new SessionManager({
      store: new FakeStore(),
      savedOutputStore: new FileSavedOutputStore(savedOutputDirectory),
      spawnPty: () => new FakePty(),
      processStartIdentity: async () => 'linux-proc-start:fresh',
      sendTerminalMessage: () => undefined
    })
    const fresh = await restartedManager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    await restartedManager.saveTerminalSnapshot(
      fresh,
      validCapture({ capturedAt: '2026-09-12T08:01:00.000Z', content: 'fresh shell prompt' })
    )

    await expect(restartedManager.savedOutputCatalog(fresh)).resolves.toMatchObject({
      current: {
        sessionId: fresh.sessionId,
        incarnationId: fresh.incarnationId,
        content: 'fresh shell prompt',
        processState: 'live'
      },
      history: [],
      finalCaptureUnavailable: [],
      unreadable: []
    })
  })

  it('returns only a stopped session own capture and loss notices while other sessions have newer captures', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-stopped-catalog-test-'))
    createdRoots.add(cwd)
    const savedOutputDirectory = join(cwd, 'saved-output')
    const manager = new SessionManager({
      store: new FakeStore(),
      savedOutputStore: new FileSavedOutputStore(savedOutputDirectory),
      spawnPty: () => new FakePty(),
      processStartIdentity: async () => 'linux-proc-start:4242',
      sendTerminalMessage: () => undefined
    })
    const creation = { ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 }
    const stopped = await manager.create({ ...creation, name: 'Stopped' })
    const other = await manager.create({ ...creation, name: 'Other' })
    const lossOnly = await manager.create({ ...creation, name: 'Loss only' })
    const stoppedView = manager.attach(stopped)
    const lossOnlyView = manager.attach(lossOnly)
    const otherView = manager.attach(other)
    await manager.saveTerminalSnapshot(
      stopped,
      validCapture({ capturedAt: '2026-09-12T08:00:00.000Z', content: 'stopped session final screen' }),
      { viewEpoch: stoppedView.attachmentId }
    )
    await manager.recordFinalCaptureUnavailable(stopped, {
      viewEpoch: stoppedView.attachmentId,
      captureStartedAt: stoppedView.captureStartedAt,
      unavailableAt: '2026-09-12T08:00:30.000Z',
      reason: 'no-renderer',
      detail: 'the stopped session lost its renderer',
      processState: 'live'
    })
    await manager.saveTerminalSnapshot(
      other,
      validCapture({ capturedAt: '2026-09-12T09:00:00.000Z', content: 'other session newer output' }),
      { viewEpoch: otherView.attachmentId }
    )
    manager.detach({ attachmentId: otherView.attachmentId })
    const otherRestoredView = manager.attach(other)
    await manager.saveTerminalSnapshot(
      other,
      validCapture({ capturedAt: '2026-09-12T09:05:00.000Z', content: 'other session newest output' }),
      { viewEpoch: otherRestoredView.attachmentId }
    )
    await manager.recordFinalCaptureUnavailable(other, {
      viewEpoch: otherView.attachmentId,
      captureStartedAt: otherView.captureStartedAt,
      unavailableAt: '2026-09-12T09:10:00.000Z',
      reason: 'renderer-destroyed',
      detail: 'the other session lost its renderer',
      processState: 'live'
    })
    await manager.recordFinalCaptureUnavailable(lossOnly, {
      viewEpoch: lossOnlyView.attachmentId,
      captureStartedAt: lossOnlyView.captureStartedAt,
      unavailableAt: '2026-09-12T08:30:00.000Z',
      reason: 'no-renderer',
      detail: 'the loss-only session never captured',
      processState: 'live'
    })
    await writeFile(
      join(savedOutputDirectory, `${encodeURIComponent(other.sessionId)}--broken--view.snapshot.json`),
      '{not-json',
      'utf8'
    )
    // A restarted host has no live incarnation for either session: both are interrupted.
    const restarted = new SessionManager({
      store: new FakeStore(),
      savedOutputStore: new FileSavedOutputStore(savedOutputDirectory),
      spawnPty: () => new FakePty(),
      processStartIdentity: async () => 'linux-proc-start:restarted',
      sendTerminalMessage: () => undefined
    })

    const catalog = await restarted.savedOutputCatalogForSession(stopped.sessionId)

    expect(catalog.view).toEqual({
      sessionId: stopped.sessionId,
      incarnationId: stopped.incarnationId,
      viewEpoch: stoppedView.attachmentId
    })
    expect(catalog.current).toMatchObject({
      sessionId: stopped.sessionId,
      incarnationId: stopped.incarnationId,
      content: 'stopped session final screen',
      processState: 'interrupted'
    })
    expect(catalog.history).toEqual([])
    expect(catalog.finalCaptureUnavailable).toHaveLength(1)
    expect(catalog.finalCaptureUnavailable[0]).toMatchObject({
      sessionId: stopped.sessionId,
      detail: 'the stopped session lost its renderer',
      processState: 'interrupted'
    })
    expect(catalog.unreadable).toEqual([])
    const otherCatalog = await restarted.savedOutputCatalogForSession(other.sessionId)
    expect(otherCatalog.current?.content).toBe('other session newest output')
    expect(otherCatalog.history.map((snapshot) => snapshot.content)).toEqual(['other session newer output'])
    expect(otherCatalog.finalCaptureUnavailable.map((record) => record.sessionId)).toEqual([other.sessionId])
    expect(otherCatalog.unreadable).toHaveLength(1)
    const lossOnlyCatalog = await restarted.savedOutputCatalogForSession(lossOnly.sessionId)
    expect(lossOnlyCatalog.view).toEqual({
      sessionId: lossOnly.sessionId,
      incarnationId: lossOnly.incarnationId,
      viewEpoch: lossOnlyView.attachmentId
    })
    expect(lossOnlyCatalog.current).toBeUndefined()
    expect(lossOnlyCatalog.history).toEqual([])
    expect(lossOnlyCatalog.finalCaptureUnavailable).toEqual([
      expect.objectContaining({ sessionId: lossOnly.sessionId, processState: 'interrupted' })
    ])
  })

  it('keeps both captures when the same incarnation is restored into a new view epoch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-09-13T10:00:00.000Z')
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-session-view-history-test-'))
    createdRoots.add(cwd)
    const manager = new SessionManager({
      store: new FakeStore(),
      savedOutputStore: new FileSavedOutputStore(join(cwd, 'saved-output')),
      spawnPty: () => new FakePty(),
      processStartIdentity: async () => 'linux-proc-start:4242',
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const beforeCrash = manager.attach(created)
    await manager.saveTerminalSnapshot(
      created,
      validCapture({ content: 'valuable pre-crash history' }),
      { viewEpoch: beforeCrash.attachmentId }
    )
    manager.detach({ attachmentId: beforeCrash.attachmentId })
    vi.setSystemTime('2026-09-13T10:01:00.000Z')
    const restored = manager.attach(created)
    expect(restored.captureStartedAt).toBe('2026-09-13T10:01:00.000Z')
    expect(restored.captureStartedAt).not.toBe(beforeCrash.captureStartedAt)
    await manager.saveTerminalSnapshot(
      created,
      validCapture({
        capturedAt: '2026-09-13T12:01:00.000Z',
        content: 'new repaint prompt'
      }),
      { viewEpoch: restored.attachmentId }
    )

    await expect(manager.savedOutputCatalog(created, restored.attachmentId)).resolves.toMatchObject({
      view: {
        sessionId: created.sessionId,
        incarnationId: created.incarnationId,
        viewEpoch: restored.attachmentId
      },
      current: {
        viewEpoch: restored.attachmentId,
        content: 'new repaint prompt'
      },
      history: [{
        viewEpoch: beforeCrash.attachmentId,
        content: 'valuable pre-crash history'
      }]
    })
  })

  it('persists final-capture unavailability for an incarnation with no prior capture', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-session-final-capture-loss-test-'))
    createdRoots.add(cwd)
    const savedOutputStore = new FileSavedOutputStore(join(cwd, 'saved-output'))
    const manager = new SessionManager({
      store: new FakeStore(),
      savedOutputStore,
      spawnPty: () => new FakePty(),
      processStartIdentity: async () => 'linux-proc-start:4242',
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd,
      executable: process.execPath,
      argv: [],
      cols: 80,
      rows: 24
    })
    const view = manager.attach(created)

    await manager.recordFinalCaptureUnavailable(created, {
      viewEpoch: view.attachmentId,
      captureStartedAt: view.captureStartedAt,
      unavailableAt: '2026-09-13T12:00:00.000Z',
      reason: 'no-renderer',
      detail: 'no terminal window was available for final capture',
      processState: 'live'
    })

    await expect(savedOutputStore.loadCatalog()).resolves.toMatchObject({
      finalCaptureUnavailable: [{
        sessionId: created.sessionId,
        incarnationId: created.incarnationId,
        viewEpoch: view.attachmentId,
        lastCaptureAt: null,
        reason: 'no-renderer'
      }]
    })
  })

  it('applies the database connection configuration during initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bmn-database-config-test-'))
    createdRoots.add(root)
    const database = new BetterSqlite3(join(root, 'terminal.sqlite'))
    try {
      database.pragma('journal_mode = DELETE')
      database.pragma('foreign_keys = OFF')
      database.pragma('busy_timeout = 1')

      initializeDatabase(database, '2026-09-12T08:00:00.000Z')

      expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      expect(database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5_000 })
      expect(databaseSettings(database)).toEqual({
        journalMode: 'wal',
        foreignKeys: true,
        busyTimeoutMs: 5_000
      })
    } finally {
      database.close()
    }
  })

  it('reads the actual database connection configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bmn-database-settings-test-'))
    createdRoots.add(root)
    const database = new BetterSqlite3(join(root, 'terminal.sqlite'))
    try {
      database.pragma('journal_mode = DELETE')
      database.pragma('foreign_keys = OFF')
      database.pragma('busy_timeout = 1')

      expect(databaseSettings(database)).toEqual({
        journalMode: 'delete',
        foreignKeys: false,
        busyTimeoutMs: 1
      })
    } finally {
      database.close()
    }
  })

  it('marks every prior starting or running incarnation interrupted on the next database start', () => {
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, '2026-09-12T07:00:00.000Z')
      database
        .prepare(
          `INSERT INTO session(
            session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(
          'session-before-loss',
          '00000000-0000-4000-8000-000000000001',
          'Claude',
          '/workspace',
          '/usr/bin/claude',
          '[]',
          '2026-09-12T07:00:00.000Z'
        )
      const insertIncarnation = database.prepare(
        `INSERT INTO process_incarnation(
          incarnation_id, session_id, process_start_identity, state, started_at,
          exited_at, exit_code
        ) VALUES (?, 'session-before-loss', ?, ?, '2026-09-12T07:00:00.000Z', ?, ?)`
      )
      insertIncarnation.run('starting-before-loss', 'proc:1', 'starting', null, null)
      insertIncarnation.run('running-before-loss', 'proc:2', 'running', null, null)
      insertIncarnation.run(
        'exited-before-loss',
        'proc:3',
        'exited',
        '2026-09-12T07:30:00.000Z',
        0
      )

      const restarted = initializeDatabase(database, '2026-09-12T08:00:00.000Z')
      const rows = database
        .prepare(
          `SELECT incarnation_id, state, exited_at, exit_code, exit_detail
           FROM process_incarnation ORDER BY incarnation_id`
        )
        .all()

      expect(restarted.interruptedIncarnations).toBe(2)
      expect(rows).toEqual([
        {
          incarnation_id: 'exited-before-loss',
          state: 'exited',
          exited_at: '2026-09-12T07:30:00.000Z',
          exit_code: 0,
          exit_detail: null
        },
        {
          incarnation_id: 'running-before-loss',
          state: 'interrupted',
          exited_at: '2026-09-12T08:00:00.000Z',
          exit_code: null,
          exit_detail: APPLICATION_INTERRUPTION_REASON
        },
        {
          incarnation_id: 'starting-before-loss',
          state: 'interrupted',
          exited_at: '2026-09-12T08:00:00.000Z',
          exit_code: null,
          exit_detail: APPLICATION_INTERRUPTION_REASON
        }
      ])
    } finally {
      database.close()
    }
  })
})

describe('conversation identity reported by the harness', () => {
  const OBSERVED = '01a0b657-21a8-7f00-addd-b73646828f5b'
  const OTHER = '01a0b659-2862-7d93-a4c5-bc1bd2a47915'

  /** Conversations agent-history cleanup is deleting this moment, as codexFixture's managers see them. */
  const deletingReferences = new Set<string>()
  /** Asked by codexFixture's managers before a Resume starts; a test may hold a Resume here. */
  let referenceCheck: () => Promise<boolean> = async () => true
  /** A history runner's deleting mark, when a test wires one in as pty-host does. */
  let cleanupDeleting: (reference: string) => boolean = () => false
  async function codexFixture(argv: readonly string[] = [], names: readonly string[] = ['Codex'], agent = 'codex',
    graphics: 'sixel' | 'standard' | null = null, bundledTerminfo = false): Promise<{
    manager: SessionManager
    store: FakeStore
    executable: string
    cwd: string
    spawns: Array<{ executable: string; argv: readonly string[] }>
    environments: Array<Readonly<Record<string, string | undefined>>>
    ptys: FakePty[]
    sessions: Array<SessionIdentity & { binding: PersistedConversationBinding }>
  }> {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-observe-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, agent)
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const store = new FakeStore()
    const spawns: Array<{ executable: string; argv: readonly string[] }> = []
    const environments: Array<Readonly<Record<string, string | undefined>>> = []
    const ptys: FakePty[] = []
    const asset = bundledTerminfo ? installBundledTerminfo(cwd,
      fileURLToPath(new URL('../../resources/terminfo/x/xterm-sixel-256color', import.meta.url))) : undefined
    const manager = new SessionManager({
      store,
      ...(asset ? { terminfoAsset: asset } : {}),
      spawnPty: (command, spawnArgv, options) => {
        spawns.push({ executable: command, argv: [...spawnArgv] })
        environments.push(options.env)
        const pty = new FakePty()
        ptys.push(pty)
        return pty
      },
      processStartIdentity: async () => `linux-proc-start:${spawns.length}`,
      conversationReferenceExists: () => referenceCheck(),
      conversationBeingDeleted: (binding) =>
        deletingReferences.has(binding.conversationReference) || cleanupDeleting(binding.conversationReference),
      sendTerminalMessage: () => undefined
    })
    const sessions = []
    for (const name of names) {
      sessions.push(await manager.create({
        ...DEFAULT_SESSION_CREATION, name, cwd, executable, argv: [...argv], cols: 80, rows: 24,
        terminalGraphics: graphics
      }))
    }
    return { manager, store, executable, cwd, spawns, environments, ptys, sessions }
  }

  it('binds an unsupported Codex session from its own word and resumes the conversation it named', async () => {
    const fixture = await codexFixture(['--model', 'gpt-6', '--full-auto'])
    const [created] = fixture.sessions
    expect(created!.binding).toMatchObject({ status: 'unsupported', captureRoute: 'unsupported' })

    const observed = await fixture.manager.observeConversation({
      sessionId: created!.sessionId,
      incarnationId: created!.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })

    expect(observed).toEqual({
      accepted: true,
      detail: `Reported by Codex at session start; Resume runs: ${fixture.executable} resume ${OBSERVED} --model gpt-6; not carried: --full-auto`
    })
    await expect(fixture.manager.conversationBinding(created!.sessionId)).resolves.toMatchObject({
      status: 'bound',
      agentCli: 'codex',
      captureRoute: 'hook-session-start',
      conversationReference: OBSERVED
    })

    fixture.ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(fixture.manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })
    await fixture.manager.resume({ sessionId: created!.sessionId, cols: 80, rows: 24 })

    expect(fixture.spawns.at(-1)).toMatchObject({
      executable: fixture.executable,
      argv: ['--no-daemon', 'resume', OBSERVED, '--model', 'gpt-6']
    })
  })

  it('takes Codex resume and Start again TERM from the current stored graphics choice', async () => {
    const fixture = await codexFixture([], ['Codex'], 'codex', null, true)
    const created = fixture.sessions[0]!
    expect(fixture.environments[0]?.TERM).toBe('xterm-sixel-256color')
    await fixture.manager.observeConversation({
      sessionId: created.sessionId, incarnationId: created.incarnationId,
      agentCli: 'codex', conversationReference: OBSERVED, source: 'startup'
    })
    fixture.ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => expect((await fixture.manager.health()).liveSessions).toBe(0))
    await fixture.manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    expect(fixture.environments.at(-1)?.TERM).toBe('xterm-sixel-256color')
    fixture.ptys[1]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => expect((await fixture.manager.health()).liveSessions).toBe(0))
    fixture.store.startingRecords[0]!.terminalGraphics = 'standard'
    await fixture.manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    expect(fixture.environments.at(-1)?.TERM).toBe('xterm-256color')
    fixture.ptys[2]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => expect((await fixture.manager.health()).liveSessions).toBe(0))
    fixture.store.startingRecords[0]!.terminalGraphics = 'sixel'
    await fixture.manager.relaunch({ sessionId: created.sessionId, cols: 80, rows: 24 })
    expect(fixture.environments.at(-1)?.TERM).toBe('xterm-sixel-256color')
    fixture.ptys[3]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => expect((await fixture.manager.health()).liveSessions).toBe(0))
    await writeFile(join(fixture.cwd, 'terminfo', 'x', 'xterm-sixel-256color'), 'damaged')
    await fixture.manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })
    expect(fixture.environments.at(-1)?.TERM).toBe('xterm-256color')
  })

  it('refreshes the capture time when the harness repeats the conversation it already reported', async () => {
    const fixture = await codexFixture()
    const [created] = fixture.sessions
    const observe = (): Promise<unknown> => fixture.manager.observeConversation({
      sessionId: created!.sessionId,
      incarnationId: created!.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })

    await observe()
    const first = await fixture.manager.conversationBinding(created!.sessionId)
    await new Promise((resolve) => setTimeout(resolve, 2))
    await observe()
    const second = await fixture.manager.conversationBinding(created!.sessionId)

    expect(second).toMatchObject({ status: 'bound', conversationReference: OBSERVED })
    expect(Date.parse(second.capturedAt)).toBeGreaterThanOrEqual(Date.parse(first.capturedAt))
  })

  it('follows the conversation a cleared Claude session moved to and says which one it replaced', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-observe-claude-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'claude')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const store = new FakeStore()
    const manager = new SessionManager({
      store,
      spawnPty: (_command, argv) => {
        const pty = new FakePty()
        if (argv.length === 1 && argv[0] === '--help') completeCapabilityProbe(pty)
        return pty
      },
      processStartIdentity: async () => 'linux-proc-start:claude',
      conversationReferenceExists: async () => true,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({
      ...DEFAULT_SESSION_CREATION, cwd, executable, argv: ['--model', 'sonnet'], cols: 80, rows: 24
    })
    const pinned = created.binding.status === 'bound' ? created.binding.conversationReference : 'unreachable'

    const observed = await manager.observeConversation({
      sessionId: created.sessionId,
      incarnationId: created.incarnationId,
      agentCli: 'claude',
      conversationReference: OBSERVED,
      source: 'clear'
    })

    expect(observed).toEqual({
      accepted: true,
      detail: `Reported by Claude Code after the conversation was cleared; replaces ${pinned}`
    })
    await expect(manager.conversationBinding(created.sessionId)).resolves.toMatchObject({
      captureRoute: 'hook-session-start',
      conversationReference: OBSERVED,
      launchContext: { argv: ['--model', 'sonnet'] }
    })
  })

  it('refuses a conversation another live session already holds and keeps the stored binding', async () => {
    const fixture = await codexFixture([], ['BMN lead', 'Second'])
    const [lead, second] = fixture.sessions
    await fixture.manager.observeConversation({
      sessionId: lead!.sessionId,
      incarnationId: lead!.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })

    const refused = await fixture.manager.observeConversation({
      sessionId: second!.sessionId,
      incarnationId: second!.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })

    expect(refused).toEqual({
      accepted: false,
      detail: 'Reported by Codex at session start; refused: already resumed in "BMN lead"'
    })
    await expect(fixture.manager.conversationBinding(second!.sessionId)).resolves.toMatchObject({
      status: 'unsupported',
      captureRoute: 'unsupported'
    })
    await expect(fixture.manager.conversationBinding(lead!.sessionId)).resolves.toMatchObject({
      conversationReference: OBSERVED
    })
  })

  it('refuses rival OpenCode claims and releases swapped and exited conversations', async () => {
    const fixture = await codexFixture([], ['First', 'Second'], 'opencode')
    const [first, second] = fixture.sessions
    const observed = 'ses_0123456789abSyntheticTest0'
    const other = 'ses_0123456789abSyntheticTest1'
    const observe = (session: typeof first, reference: string) => fixture.manager.observeConversation({
      sessionId: session!.sessionId, incarnationId: session!.incarnationId,
      agentCli: 'opencode', conversationReference: reference, source: 'resume'
    })
    expect(await observe(first, observed)).toMatchObject({ accepted: true })
    expect(await observe(second, observed)).toMatchObject({ accepted: false, detail: expect.stringContaining('already resumed in "First"') })
    await expect(fixture.manager.conversationBinding(second!.sessionId)).resolves.toMatchObject({ status: 'unsupported' })
    await expect(fixture.manager.conversationBinding(first!.sessionId)).resolves.toMatchObject({ conversationReference: observed })
    expect(await observe(first, other)).toMatchObject({ accepted: true })
    expect(await observe(second, observed)).toMatchObject({ accepted: true })
    expect(await observe(second, other)).toMatchObject({ accepted: false })
    fixture.ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(fixture.manager.health()).resolves.toMatchObject({ liveSessions: 1 })
    })
    expect(await observe(second, other)).toMatchObject({ accepted: true })
    await expect(fixture.manager.conversationBinding(second!.sessionId)).resolves.toMatchObject({
      agentCli: 'opencode', captureRoute: 'hook-session-start', conversationReference: other
    })
  })

  it('releases the conversation it swapped to, and the one it left, when the process ends', async () => {
    const fixture = await codexFixture([], ['First', 'Second'])
    const [first, second] = fixture.sessions
    await fixture.manager.observeConversation({
      sessionId: first!.sessionId,
      incarnationId: first!.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })
    // The same session then reports a different conversation, so only the latest is held.
    await fixture.manager.observeConversation({
      sessionId: first!.sessionId,
      incarnationId: first!.incarnationId,
      agentCli: 'codex',
      conversationReference: OTHER,
      source: 'clear'
    })

    const freed = await fixture.manager.observeConversation({
      sessionId: second!.sessionId,
      incarnationId: second!.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })
    expect(freed).toMatchObject({ accepted: true })

    fixture.ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(fixture.manager.health()).resolves.toMatchObject({ liveSessions: 1 })
    })
    // The identity the first session ended on is free again; the one the second holds is not.
    await expect(fixture.manager.resume({ sessionId: first!.sessionId, cols: 80, rows: 24 }))
      .resolves.toMatchObject({ binding: { conversationReference: OTHER } })
  })

  it.each([
    ['the launch classification does not match', (id: SessionIdentity) => ({
      sessionId: id.sessionId, incarnationId: id.incarnationId, agentCli: 'claude' as const,
      conversationReference: OBSERVED, source: 'startup' as const
    }), 'the session was launched as codex, not claude'],
    ['the reporting incarnation is stale', (id: SessionIdentity) => ({
      sessionId: id.sessionId, incarnationId: 'incarnation-gone', agentCli: 'codex' as const,
      conversationReference: OBSERVED, source: 'startup' as const
    }), 'the reporting process incarnation is no longer live'],
    ['the reference is not a storable UUID', (id: SessionIdentity) => ({
      sessionId: id.sessionId, incarnationId: id.incarnationId, agentCli: 'codex' as const,
      conversationReference: 'ffffffff-ffff-ffff-ffff-ffffffffffff', source: 'startup' as const
    }), 'the reported conversation reference is not a storable UUID']
  ])('refuses and stores nothing when %s', async (_label, build, reason) => {
    const fixture = await codexFixture()
    const [created] = fixture.sessions

    const refused = await fixture.manager.observeConversation(build(created!))

    expect(refused.accepted).toBe(false)
    expect(refused.detail).toContain(`refused: ${reason}`)
    await expect(fixture.manager.conversationBinding(created!.sessionId)).resolves.toMatchObject({
      status: 'unsupported'
    })
  })

  it('keeps an unconfirmed exit reserved instead of letting a late report release it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-observe-unconfirmed-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'codex')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const pty = new NonExitingFakePty()
    const manager = new SessionManager({
      store: new FakeStore(),
      spawnPty: () => pty,
      processStartIdentity: async () => 'linux-proc-start:unconfirmed',
      stopGraceMs: 0,
      stopKillWaitMs: 0,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({
      ...DEFAULT_SESSION_CREATION, cwd, executable, argv: [], cols: 80, rows: 24
    })
    await expect(manager.stop({
      sessionId: created.sessionId,
      incarnationId: created.incarnationId
    })).rejects.toThrow(/stop outcome is unknown/)
    await expect(manager.health()).resolves.toMatchObject({
      sessions: [{ state: 'exit-unconfirmed' }]
    })

    const refused = await manager.observeConversation({
      sessionId: created.sessionId,
      incarnationId: created.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })

    expect(refused).toEqual({
      accepted: false,
      detail: 'Reported by Codex at session start; refused: the process exit of this session is unconfirmed'
    })
    await expect(manager.conversationBinding(created.sessionId)).resolves.toMatchObject({
      status: 'unsupported'
    })
  })

  it('does not take a claim another live session holds, even when the owner located the same chat', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-observe-located-test-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'codex')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const ptys: FakePty[] = []
    const store = new FakeStore()
    const manager = new SessionManager({
      store,
      spawnPty: () => {
        const pty = new FakePty()
        ptys.push(pty)
        return pty
      },
      processStartIdentity: async () => `linux-proc-start:${ptys.length}`,
      conversationReferenceExists: async () => true,
      sendTerminalMessage: () => undefined
    })
    // The holder resumed the conversation explicitly, so it owns the claim.
    const holder = await manager.create({
      ...DEFAULT_SESSION_CREATION, name: 'Holder', cwd, executable, argv: ['resume', OBSERVED], cols: 80, rows: 24
    })
    expect(holder.binding).toMatchObject({ status: 'bound', captureRoute: 'explicit-resume-reference' })
    const latecomer = await manager.create({
      ...DEFAULT_SESSION_CREATION, name: 'Latecomer', cwd, executable, argv: [], cols: 80, rows: 24
    })
    // Locate chat points the second session at the same conversation without taking a claim.
    await manager.replaceConversationBinding({
      ...(holder.binding as ExplicitConversationBinding),
      sessionId: latecomer.sessionId,
      captureRoute: 'explicit-resume-reference'
    })

    const refused = await manager.observeConversation({
      sessionId: latecomer.sessionId,
      incarnationId: latecomer.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })

    expect(refused).toEqual({
      accepted: false,
      detail: 'Reported by Codex at session start; refused: already resumed in "Holder"'
    })
    await expect(manager.conversationBinding(latecomer.sessionId)).resolves.toMatchObject({
      captureRoute: 'explicit-resume-reference'
    })
    // The holder still owns the conversation, so the latecomer cannot resume into it.
    ptys[1]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 1 })
    })
    await expect(manager.resume({ sessionId: latecomer.sessionId, cols: 80, rows: 24 }))
      .rejects.toThrow(/already has a live process incarnation/)
  })

  it('refuses a conversation reported after the process has gone', async () => {
    const fixture = await codexFixture()
    const [created] = fixture.sessions
    fixture.ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(fixture.manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })

    const refused = await fixture.manager.observeConversation({
      sessionId: created!.sessionId,
      incarnationId: created!.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })

    expect(refused).toEqual({
      accepted: false,
      detail: 'Reported by Codex at session start; refused: the session has no live process'
    })
  })

  it('shows the command Resume then runs, argument for argument', async () => {
    const fixture = await codexFixture(['--model', 'gpt-6', '--full-auto', 'write the release notes'])
    const [created] = fixture.sessions
    await fixture.manager.observeConversation({
      sessionId: created!.sessionId,
      incarnationId: created!.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })

    const preview = await fixture.manager.conversationResumePreview(created!.sessionId)

    expect(preview).toEqual({
      sessionId: created!.sessionId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      command: `${fixture.executable} --no-daemon resume ${OBSERVED} --model gpt-6`,
      notCarried: '--full-auto, 1 positional argument'
    })

    fixture.ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(fixture.manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })
    await fixture.manager.resume({ sessionId: created!.sessionId, cols: 80, rows: 24 })

    const spawned = fixture.spawns.at(-1)!
    expect([spawned.executable, ...spawned.argv].join(' ')).toBe(preview.command)
  })

  it('binds Cursor from its first report, leaves a repeated prompt report unwritten and resumes with --resume=<id>', async () => {
    const fixture = await codexFixture(['--model', 'sonnet-4', '--force'], ['Cursor'], 'cursor-agent')
    const [created] = fixture.sessions
    const chat = 'c741bb07-352f-457b-8e7c-ee00517cd9ff'
    const observe = (source: 'startup' | 'prompt', conversationReference = chat) => fixture.manager.observeConversation({
      sessionId: created!.sessionId, incarnationId: created!.incarnationId, agentCli: 'cursor', conversationReference, source
    })
    expect(created!.binding).toMatchObject({ agentCli: 'cursor', status: 'unsupported' })

    const first = await observe('prompt')
    expect(first).toEqual({ accepted: true, detail: `Reported by Cursor when a prompt was sent; Resume runs: ${fixture.executable} --resume=${chat} --model sonnet-4; not carried: --force` })
    // The same chat again is not rewritten; a session start still is.
    const writes = vi.spyOn(fixture.store, 'replaceConversationBinding')
    expect(await observe('prompt')).toEqual(first)
    expect(writes).not.toHaveBeenCalled()
    expect(await observe('startup')).toMatchObject({ accepted: true, detail: expect.stringContaining('Reported by Cursor at session start') })
    expect(writes).toHaveBeenCalledTimes(1)
    // A different chat from a prompt replaces the binding, as `/resume` inside Cursor would.
    const other = '9f0c7a3e-1b2d-4c5e-8f6a-7b8c9d0e1f2a'
    expect(await observe('prompt', other)).toMatchObject({ accepted: true, detail: expect.stringContaining(`replaces ${chat}`) })

    const preview = await fixture.manager.conversationResumePreview(created!.sessionId)
    expect(preview).toMatchObject({ agentCli: 'cursor', command: `${fixture.executable} --resume=${other} --model sonnet-4`, notCarried: '--force' })
    fixture.ptys[0]!.emitExit({ exitCode: 0 })
    await vi.waitFor(async () => {
      await expect(fixture.manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    })
    // While history cleanup deletes this chat, Resume is refused and starts nothing (Astra recheck, R2).
    deletingReferences.add(other)
    const spawnsBefore = fixture.spawns.length
    await expect(fixture.manager.resume({ sessionId: created!.sessionId, cols: 80, rows: 24 }))
      .rejects.toThrow("BMN is cleaning up this cursor conversation's history right now; try again in a moment")
    expect(fixture.spawns).toHaveLength(spawnsBefore)
    deletingReferences.delete(other)
    await fixture.manager.resume({ sessionId: created!.sessionId, cols: 80, rows: 24 })
    const spawned = fixture.spawns.at(-1)!
    expect([spawned.executable, ...spawned.argv].join(' ')).toBe(preview.command)
  })

  it('keeps a conversation BMN is resuming out of history cleanup, and refuses Resume while cleanup deletes it', async () => {
    const fixture = await codexFixture()
    const [created] = fixture.sessions
    await fixture.manager.observeConversation({
      sessionId: created!.sessionId, incarnationId: created!.incarnationId, agentCli: 'codex', conversationReference: OBSERVED, source: 'startup'
    })
    const exitLatest = async (): Promise<void> => {
      fixture.ptys.at(-1)!.emitExit({ exitCode: 0 })
      await vi.waitFor(async () => {
        await expect(fixture.manager.health()).resolves.toMatchObject({ liveSessions: 0 })
      })
    }
    await exitLatest()
    const removed: string[] = []
    let holdRemove: (() => void) | undefined
    let blockRemove = false
    const codex: AgentHistoryAdapter = {
      agent: 'codex',
      available: async () => ({ ok: true, sessions: 1 }),
      candidates: async () => removed.includes(OBSERVED) ? [] : [{ id: OBSERVED, updatedAt: 0 }],
      remove: async (id) => {
        if (blockRemove) await new Promise<void>((resolve) => { holdRemove = resolve })
        removed.push(id)
        return { ok: true }
      }
    }
    const home = await mkdtemp(join(tmpdir(), 'bmn-history-race-'))
    createdRoots.add(home)
    // Wired as CompanionService and pty-host wire them: what the manager holds is protected, and Resume asks cleanup.
    const history = new AgentHistory({
      home,
      adapters: [codex],
      readSettings: async () => ({ keepDays: 30, confirmedKeepDays: 30, claudeConfigDirs: [] }),
      writeSettings: async () => undefined,
      readState: async () => emptyHistoryState(),
      writeState: async () => undefined,
      liveConversationIds: async () => new Set(fixture.manager.heldConversationReferences()),
      commandLines: () => ''
    })
    cleanupDeleting = (reference) => history.isDeleting(reference)
    try {
      // Resume first: held past its guard at the conversation check, cleanup runs meanwhile and skips it (Astra recheck 2, A2).
      let release: ((exists: boolean) => void) | undefined
      referenceCheck = () => new Promise((resolve) => { release = resolve })
      const resuming = fixture.manager.resume({ sessionId: created!.sessionId, cols: 80, rows: 24 })
      await vi.waitFor(() => expect(release).toBeDefined())
      await history.run()
      expect(removed).toEqual([])
      release!(true)
      await resuming
      expect(fixture.spawns.at(-1)!.argv).toContain(OBSERVED)
      referenceCheck = async () => true
      await exitLatest()

      // Cleanup first: while its delete runs, Resume is refused and starts nothing.
      blockRemove = true
      const running = history.run()
      await vi.waitFor(() => expect(holdRemove).toBeDefined())
      const spawnsBefore = fixture.spawns.length
      await expect(fixture.manager.resume({ sessionId: created!.sessionId, cols: 80, rows: 24 }))
        .rejects.toThrow("BMN is cleaning up this codex conversation's history right now; try again in a moment")
      expect(fixture.spawns).toHaveLength(spawnsBefore)
      holdRemove!()
      await running
      expect(removed).toEqual([OBSERVED])
    } finally {
      referenceCheck = async () => true
      cleanupDeleting = () => false
    }
  })

  it('refuses a start naming a conversation cleanup is deleting, and releases its hold', async () => {
    const fixture = await codexFixture([], [])
    const launch = { ...DEFAULT_SESSION_CREATION, name: 'Explicit', cwd: fixture.cwd, executable: fixture.executable,
      argv: ['resume', OBSERVED], cols: 80, rows: 24 }
    deletingReferences.add(OBSERVED)
    try {
      await expect(fixture.manager.create(launch))
        .rejects.toThrow("BMN is cleaning up this codex conversation's history right now; try again in a moment")
      expect(fixture.spawns).toHaveLength(0)
      expect(fixture.manager.heldConversationReferences()).toEqual([])
    } finally {
      deletingReferences.delete(OBSERVED)
    }
    const started = await fixture.manager.create(launch)
    expect(started.binding).toMatchObject({ status: 'bound', conversationReference: OBSERVED })
    expect(fixture.spawns).toHaveLength(1)
  })

  it('refuses a Cursor report from a session that runs a shell, as for every agent', async () => {
    const fixture = await codexFixture([], ['Shell'], 'bash')
    const [created] = fixture.sessions

    expect(await fixture.manager.observeConversation({
      sessionId: created!.sessionId, incarnationId: created!.incarnationId, agentCli: 'cursor',
      conversationReference: 'c741bb07-352f-457b-8e7c-ee00517cd9ff', source: 'startup'
    })).toEqual({ accepted: false, detail: 'Reported by Cursor at session start; refused: the session was launched as other, not cursor' })
  })

  it('refuses a preview for a session whose conversation it never learned', async () => {
    const fixture = await codexFixture()

    await expect(fixture.manager.conversationResumePreview(fixture.sessions[0]!.sessionId))
      .rejects.toThrow('cannot pin a TUI session id at launch')
  })

  it('leaves a conversation released mid-swap to the session that took it', async () => {
    const fixture = await codexFixture([], ['One', 'Two'])
    const [one, two] = fixture.sessions
    const observe = (
      session: SessionIdentity,
      conversationReference: string
    ): Promise<ConversationObservationResult> => fixture.manager.observeConversation({
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      agentCli: 'codex',
      conversationReference,
      source: 'startup'
    })
    await observe(one!, OBSERVED)

    // While One's move to OTHER is still uncommitted, Two takes the conversation One just released.
    let taken: Promise<ConversationObservationResult> | undefined
    fixture.store.replaceGate = async () => {
      fixture.store.replaceGate = undefined
      taken = observe(two!, OBSERVED)
      await taken
      fixture.store.replaceFailure = new Error('the database is unavailable')
    }

    await expect(observe(one!, OTHER)).rejects.toThrow('the database is unavailable')

    await expect(taken).resolves.toMatchObject({ accepted: true })
    // The rollback must not take back what Two now owns: One sees Two named as the holder.
    await expect(observe(one!, OBSERVED)).resolves.toEqual({
      accepted: false,
      detail: 'Reported by Codex at session start; refused: already resumed in "Two"'
    })
  })

  it('does not resurrect the claim of a session that ended while its swap was uncommitted', async () => {
    const fixture = await codexFixture([], ['One', 'Two'])
    const [one, two] = fixture.sessions
    await fixture.manager.observeConversation({
      sessionId: one!.sessionId,
      incarnationId: one!.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })

    // One's process ends while its move to OTHER is still uncommitted, then the write fails.
    fixture.store.replaceGate = async () => {
      fixture.store.replaceGate = undefined
      fixture.ptys[0]!.emitExit({ exitCode: 0 })
      await vi.waitFor(async () => {
        await expect(fixture.manager.health()).resolves.toMatchObject({ liveSessions: 1 })
      })
    }
    fixture.store.replaceFailure = new Error('the database is unavailable')

    await expect(fixture.manager.observeConversation({
      sessionId: one!.sessionId,
      incarnationId: one!.incarnationId,
      agentCli: 'codex',
      conversationReference: OTHER,
      source: 'startup'
    })).rejects.toThrow('the database is unavailable')

    // Neither conversation may stay reserved for a process that has gone.
    await expect(fixture.manager.observeConversation({
      sessionId: two!.sessionId,
      incarnationId: two!.incarnationId,
      agentCli: 'codex',
      conversationReference: OBSERVED,
      source: 'startup'
    })).resolves.toMatchObject({ accepted: true })
  })

  it('waits for the session record a hook beat, instead of refusing the first report', async () => {
    const fixture = await codexFixture()
    let writeRecord = (): void => undefined
    let reported: Promise<ConversationObservationResult> | undefined
    // The process is live before its record is written; hold that window open.
    fixture.store.createGate = () => new Promise<void>((resolve) => {
      writeRecord = resolve
    })
    fixture.store.onCreateStarting = (record) => {
      fixture.store.onCreateStarting = undefined
      // The harness reports its conversation before the record this observation reads exists.
      reported = fixture.manager.observeConversation({
        sessionId: record.sessionId,
        incarnationId: record.incarnationId,
        agentCli: 'codex',
        conversationReference: OTHER,
        source: 'startup'
      })
    }

    const creating = fixture.manager.create({
      ...DEFAULT_SESSION_CREATION,
      name: 'Early',
      cwd: fixture.cwd,
      executable: fixture.executable,
      argv: [],
      cols: 80,
      rows: 24
    })
    // Let the observation run all the way to the record it needs, which is not there yet.
    await new Promise((resolve) => setTimeout(resolve, 5))
    writeRecord()
    const created = await creating

    await expect(reported).resolves.toMatchObject({ accepted: true })
    await expect(fixture.manager.conversationBinding(created.sessionId)).resolves.toMatchObject({
      status: 'bound',
      captureRoute: 'hook-session-start',
      conversationReference: OTHER
    })
  })
})

describe('resuming what a lifecycle stop interrupted', () => {
  /**
   * Real records, because the cohort is decided from them: three shell sessions started and then
   * stopped as one update restart, exactly as `stopCurrentTargets` does at quit and update time.
   */
  async function interruptedSessions(count: number, options: { cause?: 'update-restart' | 'application-quit' } = {}) {
    const database = new BetterSqlite3(':memory:') as DatabaseConnection
    initializeDatabase(database, '2026-09-21T09:00:00.000Z')
    const spawns: Array<{ executable: string; argv: readonly string[] }> = []
    const spawnFailures = new Set<string>()
    const manager = new SessionManager({
      store: sqliteSessionStore(database),
      spawnPty: (executable, argv) => {
        if (spawnFailures.has(String(argv[1]))) throw new Error('no pseudo-terminal was available')
        spawns.push({ executable, argv: [...argv] })
        return new SignalExitFakePty()
      },
      processStartIdentity: async (pid) => `linux-proc-start:${pid}`,
      sendTerminalMessage: () => undefined
    })
    const created = []
    for (let index = 0; index < count; index += 1) {
      const identity = await manager.create({
        ...DEFAULT_SESSION_CREATION,
        name: `Session ${index}`,
        cwd: tmpdir(),
        executable: process.execPath,
        argv: ['--version', `session-${index}`],
        cols: 80,
        rows: 24
      })
      created.push(identity)
    }
    for (const identity of created) await manager.stop(identity, options.cause ?? 'update-restart')
    spawns.length = 0
    return { database, manager, created, spawns, spawnFailures }
  }

  const relaunchCommand = (index: number): string =>
    `${process.execPath} --version session-${index}`

  /**
   * One session bound to a real conversation, stopped by the same update restart. AC4 is about a
   * Resume row: what it starts must be the command the row showed, built from the same launch.
   */
  async function boundInterruptedSession(options: { reference?: () => boolean } = {}) {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-cohort-bound-'))
    createdRoots.add(cwd)
    const executable = join(cwd, 'codex')
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    const database = new BetterSqlite3(':memory:') as DatabaseConnection
    initializeDatabase(database, '2026-09-21T09:00:00.000Z')
    const spawns: Array<{ executable: string; argv: readonly string[] }> = []
    const manager = new SessionManager({
      store: sqliteSessionStore(database),
      spawnPty: (command, argv) => {
        spawns.push({ executable: command, argv: [...argv] })
        return new SignalExitFakePty()
      },
      processStartIdentity: async (pid) => `linux-proc-start:${pid}`,
      conversationReferenceExists: async () => options.reference?.() ?? true,
      sendTerminalMessage: () => undefined
    })
    const created = await manager.create({
      ...DEFAULT_SESSION_CREATION,
      name: 'Bound Codex',
      cwd,
      executable,
      argv: ['--model', 'gpt-6', '--full-auto'],
      cols: 80,
      rows: 24
    })
    await manager.observeConversation({
      sessionId: created.sessionId,
      incarnationId: created.incarnationId,
      agentCli: 'codex',
      conversationReference: '01a0b657-21a8-7f00-addd-b73646828f5b',
      source: 'startup'
    })
    const preview = await manager.conversationResumePreview(created.sessionId)
    await manager.stop(created, 'update-restart')
    spawns.length = 0
    return { database, manager, created, spawns, preview }
  }

  it('offers a bound session as Resume, with the command Resume itself would run', async () => {
    const { database, manager, created, preview } = await boundInterruptedSession()
    try {
      const cohort = await manager.interruptedCohort()

      expect(cohort?.entries).toEqual([expect.objectContaining({
        sessionId: created.sessionId,
        action: 'resume',
        command: preview.command,
        notCarried: '--full-auto',
        relaunchReason: null
      })])
    } finally {
      database.close()
    }
  })

  it('starts a Resume row with exactly the command the row showed', async () => {
    const { database, manager, created, spawns, preview } = await boundInterruptedSession()
    try {
      const cohort = (await manager.interruptedCohort())!
      const result = await manager.resumeCohort({
        cohortId: cohort.cohortId,
        idempotencyKey: 'bound-1',
        entries: [{
          sessionId: created.sessionId,
          action: 'resume',
          command: cohort.entries[0]!.command,
          cols: 100,
          rows: 30
        }]
      })

      expect(result.entries.map((entry) => entry.outcome)).toEqual(['started'])
      expect(spawns).toHaveLength(1)
      expect([spawns[0]!.executable, ...spawns[0]!.argv].join(' ')).toBe(preview.command)
    } finally {
      database.close()
    }
  })

  it('refuses a Resume row whose command changed after the owner read it', async () => {
    const { database, manager, created, spawns } = await boundInterruptedSession()
    try {
      const cohort = (await manager.interruptedCohort())!
      const result = await manager.resumeCohort({
        cohortId: cohort.cohortId,
        idempotencyKey: 'bound-2',
        entries: [{
          sessionId: created.sessionId,
          action: 'resume',
          command: `${cohort.entries[0]!.command} --dangerously-bypass-approvals`,
          cols: 80,
          rows: 24
        }]
      })

      expect(result.entries[0]).toMatchObject({ outcome: 'failed' })
      expect(result.entries[0]?.error).toContain('The command changed since it was shown')
      expect(spawns).toEqual([])
    } finally {
      database.close()
    }
  })

  /** AC4: a binding that went stale between the preview and the button fails with its own words. */
  it('fails a Resume row whose conversation disappeared, in the binding’s own words', async () => {
    let reference = true
    const { database, manager, created, spawns } = await boundInterruptedSession({ reference: () => reference })
    try {
      const cohort = (await manager.interruptedCohort())!
      reference = false
      const result = await manager.resumeCohort({
        cohortId: cohort.cohortId,
        idempotencyKey: 'bound-3',
        entries: [{
          sessionId: created.sessionId,
          action: 'resume',
          command: cohort.entries[0]!.command,
          cols: 80,
          rows: 24
        }]
      })

      expect(result.entries[0]).toMatchObject({
        outcome: 'failed',
        error: 'The bound codex conversation reference is missing; no process was started'
      })
      expect(spawns).toEqual([])
    } finally {
      database.close()
    }
  })

  it('lists every session the stop interrupted with the command Start again would run', async () => {
    const { database, manager, created } = await interruptedSessions(2)
    try {
      const cohort = await manager.interruptedCohort()
      expect(cohort).toMatchObject({ cause: 'update-restart', offeredAt: null })
      expect(cohort?.entries.map((entry) => ({
        sessionId: entry.sessionId,
        name: entry.name,
        workspaceName: entry.workspaceName,
        action: entry.action,
        command: entry.command,
        notCarried: entry.notCarried
      }))).toEqual([
        {
          sessionId: created[0]!.sessionId,
          name: 'Session 0',
          workspaceName: 'Personal',
          action: 'relaunch',
          command: relaunchCommand(0),
          notCarried: ''
        },
        {
          sessionId: created[1]!.sessionId,
          name: 'Session 1',
          workspaceName: 'Personal',
          action: 'relaunch',
          command: relaunchCommand(1),
          notCarried: ''
        }
      ])
      // A session without a binding says so in the harness's own words rather than offering Resume.
      expect(cohort?.entries[0]?.relaunchReason)
        .toContain('Native conversation resume is available only for direct Claude, Codex or OpenCode CLI launches')
      expect(cohort?.entries[0]?.detail).toMatch(/^update restart · /)
    } finally {
      database.close()
    }
  })

  it('offers once per stop and reopens the same cohort afterwards', async () => {
    const { database, manager } = await interruptedSessions(2)
    try {
      const cohort = (await manager.interruptedCohort())!
      const offer = await manager.markCohortOffered(cohort.cohortId)
      expect(offer.cohortId).toBe(cohort.cohortId)

      const reread = await manager.interruptedCohort()
      expect(reread?.cohortId).toBe(cohort.cohortId)
      expect(reread?.offeredAt).toBe(offer.offeredAt)
      // Asking again is not a second offer: the stamp names when BMN first asked.
      await expect(manager.markCohortOffered(cohort.cohortId)).resolves.toEqual(offer)
      await expect(manager.markCohortOffered('not-this-cohort')).rejects.toMatchObject({
        code: ERROR_CODES.notFound
      })
    } finally {
      database.close()
    }
  })

  it('leaves out a session the owner already resumed by hand', async () => {
    const { database, manager, created } = await interruptedSessions(2)
    try {
      await manager.relaunch({ sessionId: created[0]!.sessionId, cols: 80, rows: 24 })
      const cohort = await manager.interruptedCohort()
      expect(cohort?.entries.map((entry) => entry.sessionId)).toEqual([created[1]!.sessionId])
    } finally {
      database.close()
    }
  })

  it('has nothing to offer once every interrupted session is running again', async () => {
    const { database, manager, created } = await interruptedSessions(1)
    try {
      await manager.relaunch({ sessionId: created[0]!.sessionId, cols: 80, rows: 24 })
      await expect(manager.interruptedCohort()).resolves.toBeNull()
    } finally {
      database.close()
    }
  })

  it('starts the checked rows in order and reports each one', async () => {
    const { database, manager, created, spawns } = await interruptedSessions(3)
    try {
      const cohort = (await manager.interruptedCohort())!
      const result = await manager.resumeCohort({
        cohortId: cohort.cohortId,
        idempotencyKey: 'action-1',
        entries: [0, 2].map((index) => ({
          sessionId: created[index]!.sessionId,
          action: 'relaunch' as const,
          command: relaunchCommand(index),
          cols: 100,
          rows: 30
        }))
      })

      expect(result.entries.map((entry) => entry.outcome)).toEqual(['started', 'started'])
      expect(spawns.map((spawn) => spawn.argv[1])).toEqual(['session-0', 'session-2'])
      expect(result.entries[0]?.started).toMatchObject({
        sessionId: created[0]!.sessionId,
        cwd: tmpdir(),
        executable: process.execPath,
        attachmentId: expect.any(String)
      })
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 2 })
    } finally {
      database.close()
    }
  })

  it('returns the recorded result for a repeated click and starts nothing twice', async () => {
    const { database, manager, created, spawns } = await interruptedSessions(2)
    try {
      const cohort = (await manager.interruptedCohort())!
      const request = {
        cohortId: cohort.cohortId,
        idempotencyKey: 'one-press',
        entries: [{
          sessionId: created[0]!.sessionId,
          action: 'relaunch' as const,
          command: relaunchCommand(0),
          cols: 80,
          rows: 24
        }]
      }
      const [first, second] = await Promise.all([
        manager.resumeCohort(request),
        manager.resumeCohort(request)
      ])
      const third = await manager.resumeCohort(request)

      expect(second).toBe(first)
      expect(third).toBe(first)
      expect(spawns).toHaveLength(1)
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 1 })
    } finally {
      database.close()
    }
  })

  it('stops after the first failure, keeps the started row and never starts the rest', async () => {
    const { database, manager, created, spawns, spawnFailures } = await interruptedSessions(3)
    try {
      spawnFailures.add('session-1')
      const cohort = (await manager.interruptedCohort())!
      const result = await manager.resumeCohort({
        cohortId: cohort.cohortId,
        idempotencyKey: 'action-1',
        entries: [0, 1, 2].map((index) => ({
          sessionId: created[index]!.sessionId,
          action: 'relaunch' as const,
          command: relaunchCommand(index),
          cols: 80,
          rows: 24
        }))
      })

      expect(result.entries.map((entry) => entry.outcome)).toEqual(['started', 'failed', 'not-started'])
      expect(result.entries[1]?.error).toContain('no pseudo-terminal was available')
      expect(result.entries[2]?.error).toBeUndefined()
      expect(spawns.map((spawn) => spawn.argv[1])).toEqual(['session-0'])
      // Nothing is rolled back: the session that started keeps running.
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 1 })
    } finally {
      database.close()
    }
  })

  it('refuses a row whose command is no longer the one the owner read', async () => {
    const { database, manager, created, spawns } = await interruptedSessions(1)
    try {
      const cohort = (await manager.interruptedCohort())!
      const result = await manager.resumeCohort({
        cohortId: cohort.cohortId,
        idempotencyKey: 'action-1',
        entries: [{
          sessionId: created[0]!.sessionId,
          action: 'relaunch' as const,
          command: '/bin/sh -c "something else"',
          cols: 80,
          rows: 24
        }]
      })

      expect(result.entries[0]).toMatchObject({ outcome: 'failed' })
      expect(result.entries[0]?.error).toContain('The command changed since it was shown')
      expect(spawns).toHaveLength(0)
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    } finally {
      database.close()
    }
  })

  it('refuses a row whose session is already running and does not start the row after it', async () => {
    const { database, manager, created, spawns } = await interruptedSessions(2)
    try {
      const cohort = (await manager.interruptedCohort())!
      await manager.relaunch({ sessionId: created[0]!.sessionId, cols: 80, rows: 24 })
      spawns.length = 0
      const result = await manager.resumeCohort({
        cohortId: cohort.cohortId,
        idempotencyKey: 'action-1',
        entries: [0, 1].map((index) => ({
          sessionId: created[index]!.sessionId,
          action: 'relaunch' as const,
          command: relaunchCommand(index),
          cols: 80,
          rows: 24
        }))
      })

      expect(result.entries.map((entry) => entry.outcome)).toEqual(['failed', 'not-started'])
      expect(result.entries[0]?.error).toContain('no longer one a stop interrupted')
      expect(spawns).toHaveLength(0)
    } finally {
      database.close()
    }
  })

  /**
   * A stop whose exit never arrived leaves a process BMN has lost track of. It is recorded
   * interrupted, so it would otherwise read as resumable; it is not offered, and naming it anyway
   * is refused by the same launch claim a single Start again takes.
   */
  it('never offers a session whose previous process has not confirmed its exit, and refuses it if named', async () => {
    const database = new BetterSqlite3(':memory:') as DatabaseConnection
    try {
      initializeDatabase(database, '2026-09-21T09:00:00.000Z')
      const spawns: string[] = []
      const manager = new SessionManager({
        store: sqliteSessionStore(database),
        spawnPty: (_executable, argv) => {
          spawns.push(String(argv[1]))
          return new NonExitingFakePty()
        },
        processStartIdentity: async (pid) => `linux-proc-start:${pid}`,
        signalProcess: () => true,
        stopGraceMs: 1,
        stopKillWaitMs: 1,
        sendTerminalMessage: () => undefined
      })
      const created = await manager.create({
        ...DEFAULT_SESSION_CREATION,
        cwd: tmpdir(),
        executable: process.execPath,
        argv: ['--version', 'session-0'],
        cols: 80,
        rows: 24
      })
      await expect(manager.stop(created, 'update-restart')).rejects.toMatchObject({
        code: ERROR_CODES.ioError
      })
      spawns.length = 0

      expect(await manager.interruptedCohort()).toBeNull()
      const result = await manager.resumeCohort({
        cohortId: created.incarnationId,
        idempotencyKey: 'action-1',
        entries: [{
          sessionId: created.sessionId,
          action: 'relaunch' as const,
          command: `${process.execPath} --version session-0`,
          cols: 80,
          rows: 24
        }]
      })

      expect(result.entries[0]).toMatchObject({ outcome: 'failed' })
      expect(result.entries[0]?.error).toContain('has not confirmed its exit')
      expect(spawns).toEqual([])
    } finally {
      database.close()
    }
  })
})

/**
 * Test-only provenance: every frame a framer emits is tagged with its offset in that framer's
 * stream, and every frame a view's queue accepts after synchronizing is recorded as a span of
 * the stream. A view's bytes can then be checked against where they came from, not only
 * against matching content.
 */
function recordViewSpans(): { spans(attachmentId: string): Array<{ start: number; length: number }> } {
  const streamed = new WeakMap<TerminalByteFramer, number>()
  const origins = new WeakMap<ArrayBufferLike, number>()
  const tag = (framer: TerminalByteFramer, frames: TerminalFrame[]): TerminalFrame[] => {
    let offset = streamed.get(framer) ?? 0
    for (const frame of frames) {
      origins.set(frame.bytes.buffer, offset - frame.bytes.byteOffset)
      offset += frame.bytes.byteLength
    }
    streamed.set(framer, offset)
    return frames
  }
  const push = TerminalByteFramer.prototype.push
  const flush = TerminalByteFramer.prototype.flush
  vi.spyOn(TerminalByteFramer.prototype, 'push').mockImplementation(function (this: TerminalByteFramer, bytes) {
    return tag(this, push.call(this, bytes))
  })
  vi.spyOn(TerminalByteFramer.prototype, 'flush').mockImplementation(function (this: TerminalByteFramer) {
    return tag(this, flush.call(this))
  })
  const views = new Map<string, Array<{ start: number; length: number }>>()
  const queue = HostOutputQueue.prototype as unknown as {
    synchronize(frame: TerminalFrame): TerminalFrame | undefined
  }
  const synchronize = queue.synchronize
  vi.spyOn(queue, 'synchronize').mockImplementation(function (this: { options: { attachmentId: string } }, frame) {
    const accepted = synchronize.call(this, frame)
    if (accepted) {
      const origin = origins.get(accepted.bytes.buffer)
      if (origin === undefined) throw new Error('a view accepted a frame no framer emitted')
      const spans = views.get(this.options.attachmentId) ?? []
      spans.push({ start: origin + accepted.bytes.byteOffset, length: accepted.bytes.byteLength })
      views.set(this.options.attachmentId, spans)
    }
    return accepted
  })
  return { spans: (attachmentId) => views.get(attachmentId) ?? [] }
}

describe('terminal replay across view changes', () => {
  const DCS_HEADER = '\u001bP9;1;0q'

  async function liveShell(
    undeliveredOutputLimitBytes?: number,
    outputQueueLimits?: { consumerBytes: number; hostBytes: number }
  ) {
    const context = await fixture(undeliveredOutputLimitBytes, outputQueueLimits)
    const created = await context.manager.create({ ...DEFAULT_SESSION_CREATION,
      cwd: context.cwd, executable: process.execPath, argv: [], cols: 80, rows: 24
    })
    return { ...context, created }
  }

  it('strips a Sixel continuation left buffered after replay overflow revokes a view', async () => {
    const { manager, pty, sent, created } = await liveShell(undefined, {
      consumerBytes: 65_537, hostBytes: 65_537
    })
    // Three frames: the 64 KiB parser atom with the header, one more atom, then the terminator.
    pty.emit(`${DCS_HEADER}${'~'.repeat(65_537 - DCS_HEADER.length)}`)
    pty.emit('~'.repeat(65_537))
    pty.emit(`${'~'.repeat(6_900)}\u001b\\safe-after-image`)
    const first = manager.attach(created)
    manager.activateAttachment(first.attachmentId)
    expect(terminalOutput(sent, first.attachmentId).byteLength).toBe(65_536)
    expect(manager.hasAttachment(first.attachmentId)).toBe(false)

    const replacement = manager.attach(created)
    const activation = manager.activateAttachment(replacement.attachmentId)
    const fresh = encoder.encode(`${DCS_HEADER}"1;1;1;1#1~\u001b\\`)
    pty.emit(fresh)

    expect(activation.undeliveredOutput.truncated).toBe(true)
    expect(terminalOutput(sent, replacement.attachmentId)).toEqual(
      Uint8Array.of(...encoder.encode('\u001b\\safe-after-image'), ...fresh)
    )
  })

  it('resumes a replacement view at an ST whose ESC reached the parser atom edge', async () => {
    const { manager, pty, sent, created } = await liveShell()
    const first = manager.attach(created)
    manager.activateAttachment(first.attachmentId)
    // The header and payload fill one 64 KiB parser atom; the ESC starts the next frame.
    pty.emit(`${DCS_HEADER}${'~'.repeat(65_536 - DCS_HEADER.length)}\u001b`)
    expect(terminalOutput(sent, first.attachmentId).byteLength).toBe(65_536)
    manager.detach({ attachmentId: first.attachmentId })
    pty.emit('\\safe-after-image')
    const replacement = manager.attach(created)
    manager.activateAttachment(replacement.attachmentId)

    expect(terminalOutput(sent, replacement.attachmentId)).toEqual(encoder.encode('\u001b\\safe-after-image'))
  })

  it.each([
    ['CAN at the parser atom edge', true, '\u0018'],
    ['SUB at the parser atom edge', true, '\u001a'],
    ['CAN inside the continuation', false, '\u0018'],
    ['SUB inside the continuation', false, '\u001a'],
    ['a shell prompt after an interrupted image', false, '[01;32muser@host\u001b[0m$ ']
  ])('keeps text and a fresh image after ESC ends a string with %s', async (_name, atEdge, after) => {
    const { manager, pty, sent, created } = await liveShell()
    const first = manager.attach(created)
    manager.activateAttachment(first.attachmentId)
    const payload = '~'.repeat(65_536 - DCS_HEADER.length)
    pty.emit(atEdge ? `${DCS_HEADER}${payload}\u001b` : `${DCS_HEADER}${payload}~`)
    manager.detach({ attachmentId: first.attachmentId })
    const fresh = `${DCS_HEADER}"1;1;1;1#1~\u001b\\`
    const tail = `${after}safe-after-cancel${fresh}later`
    pty.emit(atEdge ? tail : `~~\u001b${tail}`)
    const replacement = manager.attach(created)
    manager.activateAttachment(replacement.attachmentId)

    expect(terminalOutput(sent, replacement.attachmentId)).toEqual(encoder.encode(`\u001b${tail}`))
  })

  // xterm executes a C0 control, or ignores DEL, after ESC and stays in the sequence, so `P` then
  // starts a DCS. These five controls leaked `PqLEAK` into a replacement view before.
  it.each([
    ['LF', '\n'],
    ['CR', '\r'],
    ['TAB', '\t'],
    ['BEL', '\u0007'],
    ['DEL', '\u007f']
  ])('keeps a DCS that ESC %s P starts out of a replacement view as text', async (_name, control) => {
    const { manager, pty, sent, created } = await liveShell()
    const first = manager.attach(created)
    manager.activateAttachment(first.attachmentId)
    pty.emit(`\u001bPq${'~'.repeat(65_534)}`)
    // The old view reads as far as the control; the replacement starts with the output after it.
    pty.emit(`\u001b${control}`)
    manager.detach({ attachmentId: first.attachmentId })
    pty.emit('PqLEAK\u001b\\after')
    const replacement = manager.attach(created)
    manager.activateAttachment(replacement.attachmentId)

    expect(new TextDecoder().decode(terminalOutput(sent, replacement.attachmentId)))
      .toBe(`\u001b${control}PqLEAK\u001b\\after`)
  })

  /**
   * Output random in content and in how it is read and viewed. Each view's bytes must be one
   * exact range of the stream, later than any earlier view's, starting where a fresh xterm
   * parser reads on as xterm reading the whole stream does.
   */
  it.each(Array.from({ length: 72 }, (_, index) => index + 1))(
    'gives every view an exact stream range that a fresh xterm reads as the whole stream does (seed %i)',
    async (seed) => {
      const random = seeded(seed)
      const consumerBytes = pick(random, [4, 7, 4_096, 65_537, 131_072])
      const hostBytes = pick(random, consumerBytes > 70_000 ? [140_000, 262_144] : [70_000, 140_000, 262_144])
      // A frame is at most one retained 64 KiB atom plus one PTY read, so every frame fits the host queue.
      const largestRead = hostBytes - 65_600
      const limit = consumerBytes < 4_096 ? 10_240 : pick(random, [10_240, 150_000, 300_000])
      // Rare activations let a view-less backlog span several atoms of one string before replay.
      const activationRate = pick(random, [0.01, 0.03, 0.08, 0.16])
      const provenance = recordViewSpans()
      const { manager, pty, sent, created } = await liveShell(limit, { consumerBytes, hostBytes })
      const output = generatedTerminalOutput(random, { segments: 60, largestString: 200_000 })
      const suffix = encoder.encode(`after-everything${DCS_HEADER}~?AB\u001b\\final-text`)
      const stream = Buffer.concat([output, suffix])
      // The same reads through a second framer give each frame's offset and fresh start.
      const shadow = new TerminalByteFramer()
      const freshStarts: number[] = []
      let framed = 0
      const read = (bytes: Uint8Array) => {
        for (const emitted of shadow.push(bytes)) {
          if (emitted.freshStart !== null) freshStarts.push(framed + emitted.freshStart)
          framed += emitted.bytes.byteLength
        }
        pty.emit(bytes)
      }
      const views: string[] = []
      const acknowledged = new Map<string, number>()
      const published = new Map<string, number>()
      let scanned = 0
      let current: string | undefined
      const observe = () => {
        for (; scanned < sent.length; scanned += 1) {
          const message = sent[scanned]!
          if (message.kind === 'terminal-output') {
            published.set(message.attachmentId, (published.get(message.attachmentId) ?? 0) + 1)
          }
        }
        if (current && !manager.hasAttachment(current)) current = undefined
      }
      const acknowledge = (id: string, count: number) => {
        for (let step = 0; step < count && manager.hasAttachment(id); step += 1) {
          observe()
          const next = acknowledged.get(id) ?? 0
          if (next >= (published.get(id) ?? 0)) return
          manager.acknowledge({ attachmentId: id, streamSeq: next })
          acknowledged.set(id, next + 1)
        }
        observe()
      }
      const activate = () => {
        const attached = manager.attach(created)
        views.push(attached.attachmentId)
        current = attached.attachmentId
        manager.activateAttachment(attached.attachmentId)
        observe()
      }
      let position = 0
      while (position < output.byteLength) {
        const roll = random()
        if (roll < activationRate) {
          if (!current) activate()
        } else if (roll < 0.5) {
          const size = random()
          const end = Math.min(output.byteLength, position + (size < 0.5
            ? 1 + Math.floor(random() * 500)
            : size < 0.85 ? 500 + Math.floor(random() * 8_000) : 500 + Math.floor(random() * (largestRead - 500))))
          read(output.subarray(position, end))
          position = end
          observe()
        } else if (roll < 0.75) {
          if (current) acknowledge(current, 1 + Math.floor(random() * 3))
        } else if (roll < 0.85) {
          if (current) manager.detach({ attachmentId: current })
          observe()
        } else if (roll < 0.9) {
          manager.rendererDisconnected()
          observe()
        } else if (roll < 0.95 && !current) {
          manager.detach({ attachmentId: manager.attach(created).attachmentId })
        }
      }

      if (current) manager.detach({ attachmentId: current })
      observe()
      for (let round = 0; round < 64 && !current; round += 1) {
        activate()
        if (current) acknowledge(current, Number.MAX_SAFE_INTEGER)
      }
      expect(current).toBeDefined()
      read(suffix)
      acknowledge(current!, Number.MAX_SAFE_INTEGER)
      expect(manager.hasAttachment(current!)).toBe(true)
      // An unfinished string may swallow `after-everything`; the fresh image and text after it always arrive.
      const image = encoder.encode(`${DCS_HEADER}~?AB\u001b\\final-text`)
      const finalOutput = Buffer.from(terminalOutput(sent, current!))
      expect(finalOutput.subarray(finalOutput.byteLength - image.byteLength).equals(image), 'fresh image and text').toBe(true)

      const reference = new XtermStream(stream)
      try {
        let earliest = 0
        for (const [index, id] of views.entries()) {
          const received = Buffer.from(terminalOutput(sent, id))
          if (received.byteLength === 0) continue
          const label = `seed ${seed} view ${index}`
          // Where the view's bytes came from: frames that follow each other in the stream.
          const spans = provenance.spans(id)
          const start = spans[0]?.start ?? -1
          for (const [next, span] of spans.entries()) {
            if (next > 0) expect(span.start, `${label}: frame ${next} does not follow the one before`).toBe(spans[next - 1]!.start + spans[next - 1]!.length)
          }
          expect(stream.subarray(start, start + received.byteLength).equals(received), `${label}: bytes differ from their stream range`).toBe(true)
          expect(freshStarts, `${label}: starts where no frame recorded a fresh start`).toContain(start)
          expect(start, `${label}: starts before the previous view's end`).toBeGreaterThanOrEqual(earliest)
          expect(reference.freshStartProblem(start), label).toBeUndefined()
          earliest = start + received.byteLength
        }
      } finally {
        reference.dispose()
        vi.restoreAllMocks()
      }
    }
  )
})

describe('screen mirror for sessions running an agent (Epic 30.2)', () => {
  it('starts only when asked, from the recent output, then follows output, resize and exit', async () => {
    const { manager, pty, cwd } = await fixture()
    const created = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 })
    pty.emit('before the agent\r\n')
    expect(manager.screenMirror(created.sessionId, 'another-incarnation')).toBeUndefined()
    const mirror = manager.screenMirror(created.sessionId, created.incarnationId)!
    expect(manager.screenMirror(created.sessionId)).toBe(mirror)
    pty.emit('the dialog\r\n')
    await mirror.settled()
    expect(mirror.lines().slice(0, 2)).toEqual(['before the agent', 'the dialog'])
    const attached = manager.attach(created)
    manager.resize({ attachmentId: attached.attachmentId, cols: 100, rows: 30 })
    expect(mirror.lines()).toHaveLength(30)
    manager.stopScreenMirror(created.sessionId)
    const restarted = manager.screenMirror(created.sessionId)!
    expect(restarted).not.toBe(mirror)
    await restarted.settled()
    // A restarted mirror is seeded from the tail again, so it still sees what was drawn.
    expect(restarted.lines().join('\n')).toContain('the dialog')
    pty.emitExit({ exitCode: 0 })
    expect(manager.screenMirror(created.sessionId)).toBeUndefined()
  })
})

describe('a command a program in the session reports to resume it (Epic 43)', () => {
  const reference = '01a0b657-21a8-7f00-addd-b73646828f5b'

  /**
   * Real records, because the command lives in them: one session whose PATH holds a single program, `my-agent`, in a
   * folder of its own. `build` makes another manager over the same records, as BMN does when it starts again.
   */
  async function reportingSession(options: { executableName?: string; argv?: readonly string[] } = {}) {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-reported-resume-'))
    createdRoots.add(cwd)
    const bin = join(cwd, 'bin')
    await mkdir(bin)
    const program = join(bin, process.platform === 'win32' ? 'my-agent.EXE' : 'my-agent')
    await writeFile(program, '#!/bin/sh\n')
    await chmod(program, 0o700)
    let executable = process.execPath
    if (options.executableName) {
      executable = join(cwd, options.executableName)
      await writeFile(executable, '#!/bin/sh\n')
      await chmod(executable, 0o700)
    }
    const database = new BetterSqlite3(':memory:')
    initializeDatabase(database, '2026-09-29T09:00:00.000Z')
    const spawns: Array<{
      executable: string
      argv: readonly string[]
      cwd: string | undefined
      env: Readonly<Record<string, string | undefined>>
    }> = []
    const build = (): SessionManager => new SessionManager({
      store: sqliteSessionStore(database),
      spawnPty: (command, argv, spawnOptions) => {
        spawns.push({ executable: command, argv: [...argv], cwd: spawnOptions.cwd, env: spawnOptions.env })
        return new SignalExitFakePty()
      },
      processStartIdentity: async (pid) => `linux-proc-start:${pid}`,
      conversationReferenceExists: async () => true,
      sessionPath: () => [join(cwd, 'missing-folder'), bin].join(delimiter),
      sendTerminalMessage: () => undefined
    })
    const manager = build()
    const created = await manager.create({
      ...DEFAULT_SESSION_CREATION,
      name: 'Wrapper',
      cwd,
      executable,
      argv: [...(options.argv ?? ['--version'])],
      cols: 80,
      rows: 24
    })
    const stored = async () => (await findStoredSession(sqliteSessionStore(database), created.sessionId))?.reportedResume
    const report = (argv: readonly string[], from = manager) =>
      from.reportResumeCommand({ sessionId: created.sessionId, incarnationId: created.incarnationId, argv })
    return { database, manager, build, created, cwd, program, executable, spawns, stored, report }
  }

  it('records the command for the running process, replaces an earlier one, and clears it (43.1 AC1)', async () => {
    const { database, manager, created, stored, report } = await reportingSession()
    try {
      const first = await report(['my-agent', '--resume', 'abc'])
      expect(first).toEqual({ argv: ['my-agent', '--resume', 'abc'], reportedAt: expect.any(String) })
      await expect(stored()).resolves.toEqual(first)

      const second = await report(['my-agent', '--resume', 'def', '--model', 'my-model'])
      await expect(stored()).resolves.toEqual(second)

      const identity = { sessionId: created.sessionId, incarnationId: created.incarnationId }
      await expect(manager.clearResumeCommand(identity)).resolves.toBe(true)
      await expect(stored()).resolves.toBeUndefined()
      await expect(manager.clearResumeCommand(identity)).resolves.toBe(false)
    } finally {
      database.close()
    }
  })

  it('refuses a command that breaks a rule, says which, and keeps the one it had (43.1 AC2)', async () => {
    const { database, stored, report } = await reportingSession()
    try {
      const kept = await report(['my-agent', '--resume', 'abc'])
      const refusals: Array<[readonly string[], string]> = [
        [[], 'The command is missing'],
        [['/usr/bin/my-agent'], 'The program must be a plain command name found on PATH, not a path'],
        [['./my-agent'], 'The program must be a plain command name found on PATH, not a path'],
        [['missing-agent', '--resume'], 'The program "missing-agent" is not on this session\'s PATH'],
        [['my-agent', 'a‮b'], 'Part 2 of the command contains a control or invisible formatting character'],
        [['my-agent', 'line\nbreak'], 'Part 2 of the command contains a control or invisible formatting character'],
        [['my-agent', ...Array.from({ length: 64 }, () => 'x')], 'The command has 65 parts; at most 64 are allowed'],
        [['my-agent', 'x'.repeat(1025)], 'each may be at most 1024'],
        [['my-agent', ...Array.from({ length: 9 }, () => 'x'.repeat(1000))], 'at most 8192 are allowed']
      ]
      for (const [argv, message] of refusals) {
        await expect(report(argv)).rejects.toMatchObject({
          code: ERROR_CODES.invalidArgument,
          message: expect.stringContaining(message)
        })
      }
      await expect(stored()).resolves.toEqual(kept)
    } finally {
      database.close()
    }
  })

  it('accepts a report only from the process that is running now (43.1 AC1)', async () => {
    const { database, manager, created, stored, report } = await reportingSession()
    try {
      const refused = { code: ERROR_CODES.unauthorized, message: 'This process is no longer the session\'s running one' }
      await expect(manager.reportResumeCommand({
        sessionId: created.sessionId, incarnationId: 'not-the-running-one', argv: ['my-agent']
      })).rejects.toMatchObject(refused)
      await report(['my-agent', '--resume', 'abc'])
      await manager.stop(created, 'explicit')

      await expect(report(['my-agent', '--resume', 'later'])).rejects.toMatchObject(refused)
      await expect(manager.clearResumeCommand({ sessionId: created.sessionId, incarnationId: created.incarnationId }))
        .rejects.toMatchObject(refused)
      await expect(stored()).resolves.toMatchObject({ argv: ['my-agent', '--resume', 'abc'] })
    } finally {
      database.close()
    }
  })

  it('refuses in the database itself a write for a process that is not the running one', async () => {
    const { database, manager, created } = await reportingSession()
    try {
      const command = { argv: ['my-agent'], reportedAt: '2026-09-29T09:05:00.000Z' }
      // The manager refuses first everywhere; this is the guard beneath it.
      expect(() => setReportedResume(database, { sessionId: created.sessionId, incarnationId: 'not-running', ...command }))
        .toThrow('incarnation not-running is not current')
      expect(() => clearReportedResume(database, { sessionId: created.sessionId, incarnationId: 'not-running' }))
        .toThrow('incarnation not-running is not current')
      await manager.stop(created, 'explicit')
      expect(() => setReportedResume(database, { sessionId: created.sessionId, incarnationId: created.incarnationId, ...command }))
        .toThrow(`incarnation ${created.incarnationId} is not current`)
    } finally {
      database.close()
    }
  })

  it('keeps a report that arrives before the process\'s record is written (Epic 43 review)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'bmn-reported-early-'))
    createdRoots.add(cwd)
    const program = join(cwd, process.platform === 'win32' ? 'my-agent.EXE' : 'my-agent')
    await writeFile(program, '#!/bin/sh\n')
    await chmod(program, 0o700)
    const database = new BetterSqlite3(':memory:')
    try {
      initializeDatabase(database, '2026-09-29T09:00:00.000Z')
      const sqlite = sqliteSessionStore(database)
      let openGate = (): void => undefined
      const gate = new Promise<void>((resolve) => { openGate = resolve })
      let early: Promise<unknown> | undefined
      const manager: SessionManager = new SessionManager({
        store: {
          ...sqlite,
          // The program reports while its record is still being written.
          createStarting: async (record) => {
            early = manager.reportResumeCommand({
              sessionId: record.sessionId, incarnationId: record.incarnationId, argv: ['my-agent', '--resume', 'early']
            })
            await gate
            return sqlite.createStarting(record)
          }
        },
        spawnPty: () => new SignalExitFakePty(),
        processStartIdentity: async (pid) => `linux-proc-start:${pid}`,
        sessionPath: () => cwd,
        sendTerminalMessage: () => undefined
      })
      const creating = manager.create({
        ...DEFAULT_SESSION_CREATION, name: 'Early', cwd, executable: process.execPath, argv: ['--version'], cols: 80, rows: 24
      })
      await vi.waitFor(() => expect(early).toBeDefined())
      openGate()
      const created = await creating
      await expect(early).resolves.toMatchObject({ argv: ['my-agent', '--resume', 'early'] })
      await expect(findStoredSession(sqlite, created.sessionId))
        .resolves.toMatchObject({ reportedResume: { argv: ['my-agent', '--resume', 'early'] } })
    } finally {
      database.close()
    }
  })

  it('keeps the command through a stop and a restart of BMN, and drops it when Start again runs (43.1 AC4, AC5)', async () => {
    const { database, manager, build, created, stored, report } = await reportingSession()
    try {
      const reported = await report(['my-agent', '--resume', 'abc'])
      await manager.stop(created, 'explicit')
      await expect(stored()).resolves.toEqual(reported)

      const restarted = build()
      await expect(restarted.conversationResumePreview(created.sessionId))
        .resolves.toMatchObject({ source: 'reported', argv: reported.argv, reportedAt: reported.reportedAt })

      await restarted.relaunch({ sessionId: created.sessionId, cols: 80, rows: 24 })
      await expect(stored()).resolves.toBeUndefined()
      // What a session never bound says today (43.2 AC5).
      await expect(restarted.conversationResumePreview(created.sessionId))
        .rejects.toThrow('Native conversation resume is available only for direct')
    } finally {
      database.close()
    }
  })

  it('Resume starts the reported command in the session folder, exactly as shown, and keeps it (43.2 AC2)', async () => {
    const { database, manager, created, cwd, program, spawns, stored, report } = await reportingSession()
    try {
      const odd = ['two words', '$(touch pwned)', `it's "quoted"`, '', '-rf', '*']
      const reported = await report(['my-agent', '--resume', 'abc', '--title', ...odd])
      await manager.stop(created, 'explicit')
      const preview = await manager.conversationResumePreview(created.sessionId)
      expect(preview).toEqual({
        sessionId: created.sessionId,
        source: 'reported',
        argv: reported.argv,
        program,
        cwd,
        reportedAt: reported.reportedAt,
        command: shownCommand(program, ['--resume', 'abc', '--title', ...odd]),
        refusal: null
      })
      const firstLaunch = spawns[0]!

      await expect(manager.resume({
        sessionId: created.sessionId, cols: 80, rows: 24, expectedCommand: `${preview.command} --yolo`
      })).rejects.toThrow('The command changed since it was shown; nothing was started')
      // Text from the session never starts unseen: a caller that confirmed nothing starts nothing.
      await expect(manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })).rejects.toMatchObject({
        code: ERROR_CODES.invalidArgument,
        message: 'A command a program reported runs only after the owner has seen it; nothing was started'
      })
      expect(spawns).toHaveLength(1)

      const resumed = await manager.resume({
        sessionId: created.sessionId, cols: 100, rows: 30, expectedCommand: preview.command
      })
      expect(resumed.launch).toEqual({ cwd, executable: program })
      expect(resumed.binding).toBeUndefined()
      // Each part arrives as it was reported, as its own argument, so no shell ever read them; the environment is
      // any launch's.
      expect(spawns.at(-1)).toEqual({
        executable: program, argv: ['--resume', 'abc', '--title', ...odd], cwd, env: firstLaunch.env
      })
      await expect(stored()).resolves.toEqual(reported)
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 1 })
      // A second Resume while that process runs starts nothing.
      await expect(manager.resume({
        sessionId: created.sessionId, cols: 80, rows: 24, expectedCommand: preview.command
      })).rejects.toThrow('The session is already running')
      expect(spawns).toHaveLength(2)
    } finally {
      database.close()
    }
  })

  it('refuses Resume once the program has left PATH, names why, and Start again still runs (43.2 AC4)', async () => {
    const { database, manager, created, program, executable, spawns, report } = await reportingSession()
    try {
      await report(['my-agent', '--resume', 'abc'])
      await manager.stop(created, 'explicit')
      await rm(program)
      spawns.length = 0

      await expect(manager.conversationResumePreview(created.sessionId)).resolves.toMatchObject({
        source: 'reported', program: null, command: '', refusal: missingProgramReason('my-agent')
      })
      await expect(manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 }))
        .rejects.toMatchObject({ code: ERROR_CODES.notFound, message: missingProgramReason('my-agent') })
      expect(spawns).toEqual([])

      await manager.relaunch({ sessionId: created.sessionId, cols: 80, rows: 24 })
      expect(spawns.map(({ executable: started, argv }) => [started, argv])).toEqual([[executable, ['--version']]])
    } finally {
      database.close()
    }
  })

  it('says so when a session has neither a conversation nor a reported command (43.2 AC5)', async () => {
    const { database, manager, created, spawns } = await reportingSession()
    try {
      await manager.stop(created, 'explicit')
      spawns.length = 0
      // The binding's own reason, as before this epic.
      const neither = 'Native conversation resume is available only for direct'
      await expect(manager.conversationResumePreview(created.sessionId)).rejects.toThrow(neither)
      await expect(manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })).rejects.toThrow(neither)
      expect(spawns).toEqual([])
    } finally {
      database.close()
    }
  })

  it('resumes a captured conversation as before even when a command was reported, and then drops the command (43.2 AC1)', async () => {
    const { database, manager, created, cwd, executable, spawns, stored, report } =
      await reportingSession({ executableName: 'codex', argv: ['--model', 'gpt-6'] })
    try {
      await report(['my-agent', '--resume', 'abc'])
      await manager.observeConversation({
        sessionId: created.sessionId,
        incarnationId: created.incarnationId,
        agentCli: 'codex',
        conversationReference: reference,
        source: 'startup'
      })
      await manager.stop(created, 'explicit')
      await expect(manager.conversationResumePreview(created.sessionId))
        .resolves.toMatchObject({ agentCli: 'codex', conversationReference: reference })

      const resumed = await manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24 })

      expect(resumed.binding).toMatchObject({ status: 'bound', conversationReference: reference })
      expect(resumed.launch).toEqual({ cwd, executable })
      expect(spawns.at(-1)).toMatchObject({ executable, argv: ['--no-daemon', 'resume', reference, '--model', 'gpt-6'], cwd })
      await expect(stored()).resolves.toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('resumes an agent BMN knows but holds no conversation for by the command it reported (43.2 AC2)', async () => {
    const { database, manager, created, program, spawns, report } =
      await reportingSession({ executableName: 'codex', argv: ['--model', 'gpt-6'] })
    try {
      await expect(manager.conversationBinding(created.sessionId)).resolves.toMatchObject({ status: 'unsupported' })
      await report(['my-agent', '--resume', 'abc'])
      await manager.stop(created, 'explicit')
      const preview = await manager.conversationResumePreview(created.sessionId)
      expect(preview).toMatchObject({ source: 'reported', program })

      await manager.resume({ sessionId: created.sessionId, cols: 80, rows: 24, expectedCommand: preview.command })

      expect(spawns.at(-1)).toMatchObject({ executable: program, argv: ['--resume', 'abc'] })
    } finally {
      database.close()
    }
  })

  it('lists a reported command after an update restart with its exact command, and starts it from the row (43.2 AC3)', async () => {
    const { database, manager, created, cwd, program, spawns, report } = await reportingSession()
    try {
      const reported = await report(['my-agent', '--resume', 'abc'])
      await manager.stop(created, 'update-restart')
      spawns.length = 0
      const command = shownCommand(program, ['--resume', 'abc'])

      const cohort = (await manager.interruptedCohort())!
      expect(cohort.entries).toEqual([expect.objectContaining({
        sessionId: created.sessionId,
        action: 'resume',
        command,
        notCarried: '',
        relaunchReason: null,
        reportedAt: reported.reportedAt
      })])

      const result = await manager.resumeCohort({
        cohortId: cohort.cohortId,
        idempotencyKey: 'reported-1',
        entries: [{ sessionId: created.sessionId, action: 'resume', command, cols: 80, rows: 24 }]
      })
      expect(result.entries[0]).toMatchObject({ outcome: 'started', started: { cwd, executable: program } })
      expect(spawns).toEqual([expect.objectContaining({ executable: program, argv: ['--resume', 'abc'], cwd })])
    } finally {
      database.close()
    }
  })

  it('lists a reported command whose program is gone as Start again, with the reason (43.2 AC3, AC4)', async () => {
    const { database, manager, created, program, executable, report } = await reportingSession()
    try {
      await report(['my-agent', '--resume', 'abc'])
      await manager.stop(created, 'update-restart')
      await rm(program)

      const cohort = (await manager.interruptedCohort())!
      expect(cohort.entries).toEqual([expect.objectContaining({
        sessionId: created.sessionId,
        action: 'relaunch',
        command: shownCommand(executable, ['--version']),
        relaunchReason: missingProgramReason('my-agent')
      })])
      expect(cohort.entries[0]).not.toHaveProperty('reportedAt')
    } finally {
      database.close()
    }
  })
})

describe('workspace admission and archive ordering (47.1)', () => {
  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  }
  async function guardedFixture(unconfirmed = false) {
    const f = await fixture()
    const pty = unconfirmed ? new NonExitingFakePty() : f.pty
    const spawn = vi.fn(() => pty)
    const manager = new SessionManager({ store: f.store, spawnPty: spawn,
      processStartIdentity: async () => 'synthetic:47', sendTerminalMessage: () => undefined,
      stopGraceMs: 0, stopKillWaitMs: 0, signalProcess: () => true })
    return { ...f, manager, pty, spawn,
      launch: { ...DEFAULT_SESSION_CREATION, cwd: f.cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 } }
  }
  it('refuses a live workspace and session with names, changing no records or process input', async () => {
    const f = await guardedFixture(); const created = await f.manager.create(f.launch)
    const mutate = vi.fn(async () => true)
    await expect(f.manager.archiveWorkspace(f.launch.workspaceId, mutate)).rejects.toThrow('Shell')
    await expect(f.manager.updateSessionAvailability(created.sessionId, { archived: true }, mutate)).rejects.toThrow('Shell')
    expect(mutate).not.toHaveBeenCalled(); expect(f.pty.writes).toEqual([]); expect(f.pty.killed).toBe(false)
  })
  it('blocks workspace archive before creation has even enumerated its workspace', async () => {
    const f = await guardedFixture(); const gate = deferred(); const entered = deferred()
    const list = f.store.listWorkspaces.bind(f.store)
    vi.spyOn(f.store, 'listWorkspaces').mockImplementation(async () => { entered.resolve(); await gate.promise; return list() })
    const created = f.manager.create(f.launch); await entered.promise
    const mutate = vi.fn(async () => true)
    await expect(f.manager.archiveWorkspace(f.launch.workspaceId, mutate)).rejects.toThrow('Shell')
    expect(f.spawn).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled()
    gate.resolve(); await created
  })
  it('reserves archive before its database await and refuses create without spawning', async () => {
    const f = await guardedFixture(); const gate = deferred(); const entered = deferred()
    const archive = f.manager.archiveWorkspace(f.launch.workspaceId, async () => { entered.resolve(); await gate.promise; return true })
    await entered.promise
    await expect(f.manager.create(f.launch)).rejects.toThrow(/being archived/)
    expect(f.spawn).not.toHaveBeenCalled(); gate.resolve(); await archive
    // A failed or completed mutation releases the reservation.
    await f.manager.create(f.launch)
  })
  it('refuses starting ownership while the created record is still in flight', async () => {
    const f = await guardedFixture(); const gate = deferred(); const entered = deferred()
    f.store.createGate = async () => { entered.resolve(); await gate.promise }
    const pending = f.manager.create(f.launch); await entered.promise
    const mutate = vi.fn(async () => true)
    await expect(f.manager.archiveWorkspace(f.launch.workspaceId, mutate)).rejects.toThrow('Shell')
    expect(mutate).not.toHaveBeenCalled(); gate.resolve(); await pending
  })
  it('allows stopped records but keeps exit-unconfirmed ownership blocking both archives', async () => {
    const stopped = await guardedFixture(); const created = await stopped.manager.create(stopped.launch)
    await stopped.manager.stop(created, 'explicit')
    await expect(stopped.manager.archiveWorkspace(stopped.launch.workspaceId, async () => 'archived')).resolves.toBe('archived')
    await expect(stopped.manager.updateSessionAvailability(created.sessionId, { archived: true }, async () => 'archived')).resolves.toBe('archived')
    const f = await guardedFixture(true); const live = await f.manager.create(f.launch)
    await expect(f.manager.stop(live, 'explicit')).rejects.toThrow(/stop outcome is unknown/)
    await expect(f.manager.archiveWorkspace(f.launch.workspaceId, async () => true)).rejects.toThrow('Shell')
    await expect(f.manager.updateSessionAvailability(live.sessionId, { archived: true }, async () => true)).rejects.toThrow(/exit unconfirmed/)
  })
  it.each(['relaunch', 'resume'] as const)('revalidates %s after an archive wins its initial saved-record read', async route => {
    const f = await guardedFixture(); const created = await f.manager.create(f.launch)
    await f.manager.stop(created, 'explicit')
    const gate = deferred(); const entered = deferred()
    const read = f.store.listSessions.bind(f.store)
    vi.spyOn(f.store, 'listSessions').mockImplementationOnce(async ws => { const rows = await read(ws); entered.resolve(); await gate.promise; return rows })
    const pending = f.manager[route]({ sessionId: created.sessionId, cols: 80, rows: 24 })
    await entered.promise
    await f.manager.archiveWorkspace(f.launch.workspaceId, async () => {
      const rows = await f.store.listWorkspaces(); vi.spyOn(f.store, 'listWorkspaces').mockResolvedValue(rows.map(row => ({ ...row, archivedAt: '2026-10-01' })))
    })
    gate.resolve(); await expect(pending).rejects.toThrow(/Restore the workspace/)
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })
  it('keeps a failed record write with an unconfirmed process exit blocking workspace archive', async () => {
    const f = await guardedFixture(true)
    f.store.createGate = async () => { throw new Error('Synthetic failed record write') }
    await expect(f.manager.create(f.launch)).rejects.toThrow()
    expect(f.store.startingRecords).toEqual([])
    expect((await f.manager.health()).sessions).toEqual([expect.objectContaining({ state: 'exit-unconfirmed' })])
    const mutate = vi.fn(async () => true)
    await expect(f.manager.archiveWorkspace(f.launch.workspaceId, mutate)).rejects.toThrow('Shell')
    expect(mutate).not.toHaveBeenCalled()
  })
  it('blocks session archive and moves while relaunch admission is waiting', async () => {
    const f = await guardedFixture(); const created = await f.manager.create(f.launch); await f.manager.stop(created, 'explicit')
    const gate = deferred(); const entered = deferred(); const list = f.store.listWorkspaces.bind(f.store)
    vi.spyOn(f.store, 'listWorkspaces').mockImplementationOnce(() => list()).mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return list() })
    const pending = f.manager.relaunch({ sessionId: created.sessionId, cols: 80, rows: 24 }); await entered.promise
    await expect(f.manager.updateSessionAvailability(created.sessionId, { archived: true }, async () => true)).rejects.toThrow(/starting/)
    await expect(f.manager.updateSessionAvailability(created.sessionId, { workspaceId: 'destination' }, async () => true)).rejects.toThrow(/starting/)
    gate.resolve(); await pending
  })
  it('move wins destination admission, archive refuses, and archive wins against a later move', async () => {
    const f = await guardedFixture(); const created = await f.manager.create(f.launch)
    const original = await f.store.listWorkspaces()
    vi.spyOn(f.store, 'listWorkspaces').mockResolvedValue([...original, { ...original[0]!, workspaceId: 'destination' }])
    const gate = deferred(); const entered = deferred()
    const moved = f.manager.updateSessionAvailability(created.sessionId, { workspaceId: 'destination' }, async () => { entered.resolve(); await gate.promise })
    await entered.promise
    await expect(f.manager.archiveWorkspace('destination', async () => true)).rejects.toThrow('Shell')
    gate.resolve(); await moved
    await f.manager.stop(created, 'explicit')
    // After the moved process confirms exit the destination can archive.
    const readSource = f.store.listSessions.bind(f.store)
    vi.spyOn(f.store, 'listSessions').mockImplementation(async ws => ws === 'destination' ? [] : readSource(ws))
    const gate2 = deferred()
    const archiveEntered = deferred()
    const archived = f.manager.archiveWorkspace('destination', async () => { archiveEntered.resolve(); await gate2.promise })
    await archiveEntered.promise
    await expect(f.manager.updateSessionAvailability(created.sessionId, { workspaceId: 'destination' }, async () => true)).rejects.toThrow(/being archived/)
    gate2.resolve(); await archived
  })
  it('holds a session archive across its write and refuses a concurrent start', async () => {
    const f = await guardedFixture(); const created = await f.manager.create(f.launch); await f.manager.stop(created, 'explicit')
    const gate = deferred(); const entered = deferred()
    const archive = f.manager.updateSessionAvailability(created.sessionId, { archived: true }, async () => { entered.resolve(); await gate.promise })
    await entered.promise
    await expect(f.manager.relaunch({ sessionId: created.sessionId, cols: 80, rows: 24 })).rejects.toThrow(/being archived or moved/)
    gate.resolve(); await archive
  })
  it('moves live ownership with the saved record, keeping only the destination blocked', async () => {
    const f = await fixture()
    const database = new BetterSqlite3(':memory:')
    try {
      const now = '2026-10-01T02:00:00.000Z'
      initializeDatabase(database, now)
      const store = sqliteSessionStore(database)
      const source = listWorkspaces(database)[0]!
      const destination = createWorkspace(database, { name: 'Destination', defaultCwd: f.cwd },
        '00000000-0000-4000-8000-000000000047', now)
      const manager = new SessionManager({ store, spawnPty: () => f.pty,
        processStartIdentity: async () => 'synthetic:47', sendTerminalMessage: () => undefined })
      const created = await manager.create({ workspaceId: source.workspaceId, name: 'Original',
        cwd: f.cwd, executable: process.execPath, argv: [], cols: 80, rows: 24 })
      const stored = listSessions(database, source.workspaceId)[0]!
      await manager.updateSessionAvailability(created.sessionId, { workspaceId: destination.workspaceId }, async () =>
        updateSession(database, { sessionId: created.sessionId, expectedRevision: stored.revision,
          workspaceId: destination.workspaceId, name: 'Moved shell' }, now))
      await expect(manager.archiveWorkspace(source.workspaceId, async () => true)).resolves.toBe(true)
      await expect(manager.archiveWorkspace(destination.workspaceId, async () => true)).rejects.toThrow('Moved shell')
      expect((await manager.health()).sessions).toEqual([expect.objectContaining({
        sessionId: created.sessionId, incarnationId: created.incarnationId, state: 'live' })])
      expect(f.pty.writes).toEqual([])
      expect(f.pty.killed).toBe(false)
      await manager.stop(created, 'explicit')
    } finally {
      database.close()
    }
  })
  it('a session restore refuses an archived parent without overriding it', async () => {
    const f = await guardedFixture(); const created = await f.manager.create(f.launch); await f.manager.stop(created, 'explicit')
    const rows = await f.store.listWorkspaces(); vi.spyOn(f.store, 'listWorkspaces').mockResolvedValue(rows.map(row => ({ ...row, archivedAt: '2026-10-01' })))
    const mutate = vi.fn(async () => true)
    await expect(f.manager.updateSessionAvailability(created.sessionId, { archived: false }, mutate)).rejects.toThrow(/Restore the workspace/)
    expect(mutate).not.toHaveBeenCalled()
  })
})
