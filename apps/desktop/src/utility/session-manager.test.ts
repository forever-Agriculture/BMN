import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  ERROR_CODES,
  SAVED_OUTPUT_FORMAT_VERSION,
  TERMINAL_SAVED_OUTPUT_BYTES,
  TERMINAL_SCROLLBACK_LINES,
  type ExplicitConversationBinding,
  type PersistedConversationBinding,
  type SavedOutputCapture,
  type SavedOutputFinalCaptureUnavailable,
  type SavedOutputSnapshot,
  type SessionRecord,
  type TerminalPortMessage,
  type TerminalViewDisconnectReason,
  type WorkspaceRecord
} from '@ai-terminal/protocol'
import {
  HostControlError,
  SessionManager,
  buildShellEnvironment,
  resolveHomeDirectory,
  type CreateResumingRecord,
  type CreateStartingRecord,
  type IncarnationExit,
  type PtyLike,
  type SavedOutputStore,
  type SessionIdentity,
  type SessionStore
} from './session-manager'
import { FileSavedOutputStore } from './saved-output-store'
import {
  APPLICATION_INTERRUPTION_REASON,
  databaseSettings,
  initializeDatabase,
  type DatabaseConnection
} from './database-initialization'
import { captureRelevantLaunchEnvironment } from './conversation-binding'
import {
  clearSessionConversationBinding,
  createResumingSession,
  createStartingSession,
  getSessionConversationBinding,
  markSessionExited,
  markSessionInterrupted,
  markSessionRunning,
  replaceSessionConversationBinding
} from './database-session-store'
import { listSessions, listWorkspaces } from './database-workspace-store'

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
)

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
    markRunning: async (incarnationId) => markSessionRunning(database, incarnationId),
    markExited: async (incarnationId, exit) => markSessionExited(database, incarnationId, exit),
    markInterrupted: async (incarnationId, reason) => markSessionInterrupted(database, incarnationId, reason),
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
  readonly starting: string[] = []
  readonly startingRecords: CreateStartingRecord[] = []
  readonly resuming: string[] = []
  readonly bindings = new Map<string, PersistedConversationBinding>()
  readonly running = new Set<string>()
  readonly exited = new Map<string, IncarnationExit>()
  readonly interrupted = new Map<string, string>()

  async listWorkspaces(): Promise<readonly WorkspaceRecord[]> {
    return [{
      workspaceId: DEFAULT_SESSION_CREATION.workspaceId,
      name: 'Default',
      defaultCwd: null,
      position: 0,
      archivedAt: null,
      revision: 1
    }]
  }

  /** A session is stored once it was created here or a test seeded its persisted binding. */
  async listSessions(workspaceId: string): Promise<readonly SessionRecord[]> {
    const sessionIds = new Set([
      ...this.startingRecords.map((record) => record.sessionId),
      ...this.bindings.keys()
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
        revision: 1,
        createdAt: created?.startedAt ?? '2026-09-13T00:00:00.000Z',
        lastProcess: null
      }
    })
  }

  async createStarting(record: CreateStartingRecord): Promise<void> {
    this.starting.push(record.incarnationId)
    this.startingRecords.push(structuredClone(record))
    this.bindings.set(record.sessionId, structuredClone(record.binding))
  }

  async createResuming(record: CreateResumingRecord): Promise<void> {
    this.resuming.push(record.incarnationId)
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
  const cwd = await mkdtemp(join(tmpdir(), 'aiterm-session-test-'))
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
  }
): Promise<{
  manager: SessionManager
  pty: FakePty
  store: FakeStore
  harness: Awaited<ReturnType<typeof terminalFlowHarness>>
  cwd: string
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'aiterm-flow-test-'))
  createdRoots.add(cwd)
  const pty = new FakePty()
  const store = new FakeStore()
  const harness = await terminalFlowHarness()
  const manager = new SessionManager({
    store,
    spawnPty: () => pty,
    processStartIdentity: async () => 'linux-proc-start:flow',
    sendTerminalMessage: harness.send,
    ...(outputQueueLimits === undefined ? {} : { outputQueueLimits })
  })
  harness.setAcknowledger((attachmentId, streamSeq) => {
    manager.acknowledge({ attachmentId, streamSeq })
  })
  return { manager, pty, store, harness, cwd }
}

describe('shell session lifecycle', () => {
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
        AITERM_DATA_HOME: '/private/data',
        AITERM_REPO_ROOT: '/repo',
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
    const home = await mkdtemp(join(tmpdir(), 'aiterm-home-test-'))
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

  it('expands only a leading ~ or ~/ in a launch directory', () => {
    expect(resolveHomeDirectory('~', '/home/owner')).toBe('/home/owner')
    expect(resolveHomeDirectory('~/', '/home/owner')).toBe('/home/owner')
    expect(resolveHomeDirectory('~/code/Piche_Projects/app', '/home/owner')).toBe('/home/owner/code/Piche_Projects/app')
    expect(resolveHomeDirectory('~other/code', '/home/owner')).toBe('~other/code')
    expect(resolveHomeDirectory('/srv/~/code', '/home/owner')).toBe('/srv/~/code')
    expect(resolveHomeDirectory('', '/home/owner')).toBe('')
  })

  it('persists the supplied workspace and session name when creating a session', async () => {
    const { manager, store, cwd } = await fixture()

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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-lifecycle-stop-store-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-relaunch-test-'))
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
      expect(Object.keys(structuredClone(relaunched)).sort()).toEqual(['attachmentId', 'captureStartedAt', 'incarnationId', 'sessionId', 'streamSeq'])
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
      const cwd = await mkdtemp(join(tmpdir(), 'aiterm-one-process-test-'))
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
      const cwd = await mkdtemp(join(tmpdir(), 'aiterm-unconfirmed-relaunch-test-'))
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
      const created = await manager.create({ ...DEFAULT_SESSION_CREATION, cwd, executable: '/bin/sh', argv: [], cols: 80, rows: 24 })
      await expect(manager.stop(created, 'explicit')).rejects.toMatchObject({ code: ERROR_CODES.ioError })

      await expect(manager.relaunch({ sessionId: created.sessionId, cols: 80, rows: 24 }))
        .rejects.toMatchObject({ code: ERROR_CODES.invalidArgument })
      expect(ptys).toHaveLength(1)
    })
  })

  it('keeps the first explicit stop cause when an application quit races the same teardown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-first-stop-cause-test-'))
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
      expect(pty.killCalls).toBe(1)
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
        message: expect.stringContaining('Session session-corrupt-argv has invalid stored arguments')
      })
      expect(spawnPty).not.toHaveBeenCalled()
      await expect(manager.health()).resolves.toMatchObject({ liveSessions: 0 })
    } finally {
      database.close()
    }
  })

  it('T-A streams resume-window output from sequence zero in emission order without a renderer gap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-resume-flow-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-resume-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-grammar-refusal-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-grammar-admission-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-stored-selector-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-help-shape-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-concurrent-resume-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-concurrent-resume-no-stop-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-create-during-resume-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-resume-during-create-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-environment-resume-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-shared-conversation-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-stale-interruption-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-unsupported-claude-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-timeout-reprobe-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-probe-exit-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-injected-spawn-failure-test-'))
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
    ).rejects.toThrow(/AI Terminal injected --session-id/)
  })

  it('names the injected session-id flag when the modified launch exits during startup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-injected-startup-failure-test-'))
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
    ).rejects.toThrow(/AI Terminal injected --session-id/)
    expect(spawns).toHaveLength(2)
    expect(spawns[1]).toEqual(['--session-id', expect.any(String)])
  })

  it('reports a missing bound reference and spawns nothing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-missing-binding-test-'))
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
      revision: 1,
      createdAt: '2026-09-13T00:00:00.000Z',
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

  it('escalates a SIGHUP-ignoring shell and records the PTY-reported signal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-session-test-'))
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

  it('tears down exactly once when host-side resume attachment fails and blocks re-resume until exit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-resume-attach-failure-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-resume-record-failure-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-unconfirmed-stop-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-session-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-saved-output-unconfirmed-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-session-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-stopped-catalog-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-session-view-history-test-'))
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
    const cwd = await mkdtemp(join(tmpdir(), 'aiterm-session-final-capture-loss-test-'))
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
    const root = await mkdtemp(join(tmpdir(), 'aiterm-database-config-test-'))
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
    const root = await mkdtemp(join(tmpdir(), 'aiterm-database-settings-test-'))
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
