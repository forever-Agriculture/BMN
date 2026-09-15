import { randomUUID } from 'node:crypto'
import { kill as killProcess } from 'node:process'
import {
  METHOD_REGISTRY,
  PROTOCOL_VERSION,
  isAppEventMessage,
  isProtocolError,
  isSessionProcessStateChangedMessage,
  type AppEventMessage,
  type ProtocolError,
  type ProtocolMethod,
  type RpcFailure,
  type RpcSuccess,
  type SessionProcessStateChangedMessage
} from '@ai-terminal/protocol'
import { utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron'

export interface HostReady {
  kind: 'host-ready'
  electronVersion: string
  nativeModules: { nodePty: true; betterSqlite3: true }
  databasePath: string
  schemaTables: readonly string[]
  database: { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number }
}

interface ControlResponse {
  kind: 'control-response'
  response: RpcSuccess | RpcFailure
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export const HOST_DIAGNOSTIC_BUFFER_BYTES = 16 * 1024

interface PtyHostClientOptions {
  readyTimeoutMs?: number
  requestTimeoutMs?: number
  shutdownGraceMs?: number
  terminateWaitMs?: number
  signalProcess?: (pid: number, signal: NodeJS.Signals) => boolean
}

/**
 * Closes a host client but settles by the deadline: a close still pending then counts as ungraceful,
 * so a wedged host cannot stall the caller's release.
 */
export function closeWithinDeadline(
  client: { close(): Promise<{ graceful: boolean }> },
  deadlineMs: number
): Promise<{ graceful: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ graceful: false }), deadlineMs)
    client.close().then(
      (outcome) => {
        clearTimeout(timer)
        resolve(outcome)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function isHostReady(value: unknown): value is HostReady {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<HostReady>
  return (
    candidate.kind === 'host-ready' &&
    typeof candidate.electronVersion === 'string' &&
    candidate.nativeModules?.nodePty === true &&
    candidate.nativeModules.betterSqlite3 === true &&
    typeof candidate.databasePath === 'string' &&
    Array.isArray(candidate.schemaTables) &&
    candidate.database?.journalMode === 'wal' &&
    candidate.database.foreignKeys === true &&
    candidate.database.busyTimeoutMs === 5_000
  )
}

function isControlResponse(value: unknown): value is ControlResponse {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'control-response' &&
    !!(value as { response?: unknown }).response
  )
}

export class PtyHostRemoteError extends Error {
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message)
    this.name = 'PtyHostRemoteError'
  }
}

export class PtyHostExitedError extends Error {
  readonly code = 'PTY_HOST_EXITED'

  constructor(
    readonly exitCode: number,
    message: string
  ) {
    super(message)
    this.name = 'PtyHostExitedError'
  }
}

export class PtyHostRequestTimeoutError extends Error {
  readonly code = 'PTY_HOST_REQUEST_TIMEOUT'

  constructor(
    readonly method: ProtocolMethod,
    readonly timeoutMs: number
  ) {
    super(`utility host request ${method} did not settle within ${timeoutMs} ms`)
    this.name = 'PtyHostRequestTimeoutError'
  }
}

export class PtyHostClient {
  readonly ready: Promise<HostReady>
  private readonly pending = new Map<string, PendingRequest>()
  private readonly output: { stderr: Buffer; stdout: Buffer }
  private readonly requestTimeoutMs: number
  private readonly shutdownGraceMs: number
  private readonly terminateWaitMs: number
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => boolean
  private readonly exitListeners = new Set<(error: PtyHostExitedError) => void>()
  private readonly appEventListeners = new Set<(message: AppEventMessage) => void>()
  private readonly sessionStateListeners = new Set<
    (message: SessionProcessStateChangedMessage) => void
  >()
  private readonly latestSessionStates = new Map<string, SessionProcessStateChangedMessage>()
  private readonly exitComplete: Promise<void>
  private resolveExit = (): void => undefined
  private rejectReady: (error: Error) => void = () => undefined
  private exitedError: PtyHostExitedError | undefined
  private nextId = 1

  constructor(
    readonly process: UtilityProcess,
    options: PtyHostClientOptions = {}
  ) {
    const readyTimeoutMs = options.readyTimeoutMs ?? 15_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2_000
    this.terminateWaitMs = options.terminateWaitMs ?? 2_000
    this.signalProcess = options.signalProcess ?? killProcess
    this.output = { stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) }
    this.exitComplete = new Promise((resolve) => (this.resolveExit = resolve))
    process.stderr?.on('data', (chunk: Buffer) => this.appendDiagnostic('stderr', chunk))
    process.stdout?.on('data', (chunk: Buffer) => this.appendDiagnostic('stdout', chunk))
    process.once('exit', (code) => this.handleExit(code))
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject
      const timer = setTimeout(
        () => reject(new Error(`utility host did not become ready within ${readyTimeoutMs} ms`)),
        readyTimeoutMs
      )
      const onMessage = (message: unknown): void => {
        if (!isHostReady(message)) return
        clearTimeout(timer)
        process.off('message', onMessage)
        resolve(message)
      }
      process.on('message', onMessage)
      void this.exitComplete.then(() => clearTimeout(timer))
    })

    process.on('message', (message: unknown) => {
      if (isAppEventMessage(message)) {
        for (const listener of this.appEventListeners) listener(message)
        return
      }
      if (isSessionProcessStateChangedMessage(message)) {
        this.latestSessionStates.set(message.sessionId, message)
        for (const listener of this.sessionStateListeners) listener(message)
        return
      }
      if (!isControlResponse(message)) return
      const id = message.response.id
      if (typeof id !== 'string') return
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if ('error' in message.response && isProtocolError(message.response.error)) {
        pending.reject(new PtyHostRemoteError(message.response.error))
      } else if ('result' in message.response) {
        pending.resolve(message.response.result)
      } else {
        pending.reject(new Error('utility host returned an invalid control response'))
      }
    })
  }

  static async launch(
    hostEntry: string,
    environment: NodeJS.ProcessEnv,
    options: { args?: string[]; timeoutMs?: number } = {}
  ): Promise<PtyHostClient> {
    const child = utilityProcess.fork(hostEntry, options.args ?? [], {
      serviceName: 'pty-host',
      stdio: 'pipe',
      env: environment
    })
    const client = new PtyHostClient(
      child,
      options.timeoutMs === undefined ? {} : { readyTimeoutMs: options.timeoutMs }
    )
    await client.ready
    await client.request(METHOD_REGISTRY.hello, {
      protocol: PROTOCOL_VERSION,
      clientVersion: '0.1.0',
      instanceId: randomUUID()
    })
    return client
  }

  attachTerminalPort(port: MessagePortMain): void {
    this.process.postMessage({ kind: 'terminal-port' }, [port])
  }

  request<Result = unknown>(method: ProtocolMethod, params: object): Promise<Result> {
    if (this.exitedError) return Promise.reject(this.exitedError)
    const id = `main-${this.nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new PtyHostRequestTimeoutError(method, this.requestTimeoutMs))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.process.postMessage({
          kind: 'control-request',
          request: { jsonrpc: '2.0', id, method, params }
        })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error('utility host request could not be posted'))
      }
    }) as Promise<Result>
  }

  onExit(listener: (error: PtyHostExitedError) => void): () => void {
    this.exitListeners.add(listener)
    if (this.exitedError) queueMicrotask(() => listener(this.exitedError!))
    return () => this.exitListeners.delete(listener)
  }

  onSessionStateChanged(listener: (message: SessionProcessStateChangedMessage) => void): () => void {
    this.sessionStateListeners.add(listener)
    for (const message of this.latestSessionStates.values()) {
      queueMicrotask(() => {
        if (this.sessionStateListeners.has(listener)) listener(message)
      })
    }
    return () => this.sessionStateListeners.delete(listener)
  }

  onAppEvent(listener: (message: AppEventMessage) => void): () => void {
    this.appEventListeners.add(listener)
    return () => this.appEventListeners.delete(listener)
  }

  get diagnosticBufferBytes(): number {
    return this.output.stderr.byteLength + this.output.stdout.byteLength
  }

  async close(): Promise<{ graceful: boolean }> {
    if (this.exitedError) return { graceful: false }
    const pid = this.process.pid
    let shutdownRequested = false
    try {
      this.process.postMessage({ kind: 'host-shutdown' })
      shutdownRequested = true
    } catch {
      // A dead channel is handled by the bounded signal fallback below.
    }
    if (await this.waitForExit(this.shutdownGraceMs)) return { graceful: shutdownRequested }
    if (pid === undefined) return { graceful: false }
    this.trySignal(pid, 'SIGTERM')
    if (await this.waitForExit(this.terminateWaitMs)) return { graceful: false }
    this.trySignal(pid, 'SIGKILL')
    await this.waitForExit(this.terminateWaitMs)
    return { graceful: false }
  }

  private exitMessage(code: number): string {
    const stderr = this.output.stderr.toString('utf8').trim().slice(-1_000)
    const stdout = this.output.stdout.toString('utf8').trim().slice(-1_000)
    return `utility host exited with code ${code}; stderr=${JSON.stringify(stderr)}; stdout=${JSON.stringify(stdout)}`
  }

  private appendDiagnostic(stream: 'stderr' | 'stdout', chunk: Buffer): void {
    const combined = Buffer.concat([this.output[stream], chunk])
    this.output[stream] = combined.subarray(Math.max(0, combined.byteLength - HOST_DIAGNOSTIC_BUFFER_BYTES))
  }

  private handleExit(code: number): void {
    if (this.exitedError) return
    const error = new PtyHostExitedError(code, this.exitMessage(code))
    this.exitedError = error
    this.rejectReady(error)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.resolveExit()
    for (const listener of this.exitListeners) listener(error)
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitedError) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      void this.exitComplete.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private trySignal(pid: number, signal: NodeJS.Signals): void {
    try {
      this.signalProcess(pid, signal)
    } catch {
      // Exit delivery can race with a signal; the following bounded wait still applies.
    }
  }
}
