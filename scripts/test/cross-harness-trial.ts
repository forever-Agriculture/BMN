import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  METHOD_REGISTRY,
  type AppEventMessage,
  type ArtifactRecord,
  type InputDraftRecord,
  type SessionRecord
} from '../../shared/protocol/src/index'
import { afterAll, describe, expect, it } from 'vitest'
import { CompanionService } from '../../apps/desktop/src/utility/companion-service'
import type { DatabaseWorkerClient } from '../../apps/desktop/src/utility/database-client'
import {
  COMPANION_OPERATIONS,
  insertArtifact,
  type CompanionOperationName
} from '../../apps/desktop/src/utility/database-companion-store'
import { initializeDatabase, type DatabaseConnection } from '../../apps/desktop/src/utility/database-initialization'
import { listSessions, listWorkspaces } from '../../apps/desktop/src/utility/database-workspace-store'
import type { SessionManager } from '../../apps/desktop/src/utility/session-manager'
import { DEFAULT_WORKSPACE_ID } from '../../apps/desktop/src/utility/store-schema'
import { disposableProviderEnvironment } from '../lib/disposable-provider-env.mjs'

/** Explicitly invoked acceptance harness; excluded from the ordinary unit-test discovery path. */
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(join(REPO, 'apps/desktop/package.json'))
const BetterSqlite3 = require('better-sqlite3') as new (path: string) => DatabaseConnection
const pty = require('node-pty') as {
  spawn(command: string, args: string[], options: {
    name: string
    cols: number
    rows: number
    cwd: string
    env: Record<string, string>
  }): {
    write(data: string): void
    kill(signal?: string): void
    onData(listener: (data: string) => void): void
    onExit(listener: () => void): void
  }
}

interface Harness {
  kind: 'claude' | 'codex'
  output(): string
  inputWrites(): readonly string[]
  write(text: string): void
  stop(): Promise<void>
}

interface DirectionReceipt {
  direction: string
  codexVersion: string
  claudeVersion: string
  sourceReady: boolean
  destinationReady: boolean
  pasteWrites: number
  oneBoundedPaste: boolean
  existingInputSeenInOutput: boolean
  inputBytesSentBeforeSubmit: boolean
  inputRetention: 'UNVERIFIED'
  noResponseBeforeSubmit: boolean
  acceptedState: string
  responseObserved: boolean
  selectedOriginalReadable: boolean
  responseMarker: string
  manualConfirmationUsed: boolean
}

/** What the codex TUI actually showed for the model chip, kept for an honest receipt. */
let codexModelObserved = ''

function stripTerminal(value: string): string {
  return value
    // Terminal control bytes are the exact bytes this trial strips before inspecting TUI output.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replaceAll('\r', '')
}

async function waitFor(probe: () => boolean, description: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probe()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function startHarness(kind: Harness['kind'], cwd: string, env: Record<string, string>): Promise<Harness> {
  const command = kind === 'codex' ? 'codex' : 'claude'
  const args = kind === 'codex'
    ? [
        '--no-alt-screen', '-C', cwd,
        '-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort=low',
        '-c', 'project_doc_max_bytes=0', '-c', 'mcp_servers={}',
        '-s', 'read-only', '-a', 'never'
      ]
    : [
        '--ax-screen-reader', '--safe-mode', '--restricted',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--permission-mode', 'dontAsk', '--model', 'sonnet', '--effort', 'low',
        '--tools', 'Read', '--allowedTools', 'Read'
      ]
  const child = pty.spawn(command, args, {
    name: 'xterm-256color', cols: 120, rows: 40, cwd, env
  })
  let exited = false
  let resolveExit!: () => void
  const exit = new Promise<void>((resolve) => { resolveExit = resolve })
  child.onExit(() => { exited = true; resolveExit() })
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (exited) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })])
    if (timer) clearTimeout(timer)
    return exited
  }
  const stop = async (): Promise<void> => {
    if (exited) return
    try { child.kill('SIGHUP') } catch (error) { if (!exited) throw error }
    if (await waitForExit(2_000)) return
    try { child.kill('SIGKILL') } catch (error) { if (!exited) throw error }
    if (!(await waitForExit(2_000))) throw new Error(`Disposable ${kind} trial process did not exit`)
  }
  let raw = ''
  const inputWrites: string[] = []
  let trustAnswered = false
  let codexTrustAnswered = false
  child.onData((data) => {
    raw += data
    if (kind === 'codex' && !codexModelObserved) {
      const chip = stripTerminal(raw).match(/gpt-5\.6-luna(?:\s+\w+)?/i)
      if (chip) codexModelObserved = chip[0]
    }
    if (!trustAnswered && raw.includes('Enter y/n:')) {
      trustAnswered = true
      child.write('y\r')
    }
    if (!codexTrustAnswered && stripTerminal(raw).replaceAll(/\s/g, '')
      .includes('Pressentertocontinue')) {
      codexTrustAnswered = true
      child.write('\n')
    }
  })
  // Codex 0.157 capitalizes the chip ("GPT-5.6-Luna") and truncates the context line to "Con…"
  // at 120 columns, so the probe matches the chip case-insensitively and takes either the full
  // context line or the empty-input hint as the ready signal.
  const ready = kind === 'codex'
    ? () => stripTerminal(raw).toLowerCase().includes('gpt-5.6-luna') &&
      (stripTerminal(raw).includes('Context 0% used') ||
        stripTerminal(raw).includes('Ask Codex to do anything'))
    : () => stripTerminal(raw).includes('effort: low') && stripTerminal(raw).includes('$')
  try {
    await waitFor(ready, `${kind} prompt`, 30_000)
  } catch (error) {
    await stop()
    throw new Error(`Timed out waiting for the ${kind} prompt in its disposable profile`, { cause: error })
  }
  return {
    kind,
    output: () => stripTerminal(raw),
    inputWrites: () => inputWrites,
    write: (text) => { inputWrites.push(text); child.write(text) },
    stop
  }
}

function workerLike(connection: DatabaseConnection): DatabaseWorkerClient {
  return {
    companion: async (name: CompanionOperationName, ...args: unknown[]) => {
      const operation = COMPANION_OPERATIONS[name] as
        (database: DatabaseConnection, ...operationArgs: unknown[]) => unknown
      return connection.transaction(() => operation(connection, ...args))()
    },
    backupInto: async () => undefined,
    readyArtifactsInBackup: async () => [],
    listWorkspaces: async (includeArchived = false) => listWorkspaces(connection, includeArchived),
    listSessions: async (workspaceId: string) => listSessions(connection, workspaceId)
  } as unknown as DatabaseWorkerClient
}

async function runDirection(sourceKind: Harness['kind'], destinationKind: Harness['kind']): Promise<DirectionReceipt> {
  const root = mkdtempSync(join(tmpdir(), 'bmn-cross-harness-runtime-'))
  try {
    // Fail closed before either real CLI starts. The caller must separately provision credentials
    // into a private disposable /tmp root; this trial never copies or inherits the owner's profiles.
    const env = disposableProviderEnvironment(root, process.env.BMN_CROSS_HARNESS_PROFILE_ROOT)
    for (const name of ['home', 'config', 'data', 'state', 'cache', 'runtime']) {
      mkdirSync(join(root, name), { recursive: true, mode: 0o700 })
    }
    const codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8', env }).trim()
    const claudeVersion = execFileSync('claude', ['--version'], { encoding: 'utf8', env }).trim()
    const source = await startHarness(sourceKind, root, env)
    try {
      const destination = await startHarness(destinationKind, root, env)
      try {
        const database = new BetterSqlite3(':memory:')
        try {
          const now = '2026-09-19T01:00:00.000Z'
          initializeDatabase(database, now)
          const sourceId = `${sourceKind}-source`
          const destinationId = `${destinationKind}-destination`
          const executable = (kind: Harness['kind']): string => kind === 'codex' ? '/usr/bin/codex' : '/usr/bin/claude'
          for (const [position, sessionId, kind] of [
            [0, sourceId, sourceKind],
            [1, destinationId, destinationKind]
          ] as const) {
            database.prepare(
              `INSERT INTO session(
                 session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position
               ) VALUES (?, ?, ?, ?, ?, '[]', 1, ?, ?)`
            ).run(sessionId, DEFAULT_WORKSPACE_ID, `${kind} synthetic session`, root, executable(kind), now, position)
          }
          const firstLine = sourceKind === 'claude' ? 'claude source original' : 'codex source original'
          const artifactId = randomUUID()
          const storedDirectory = join(root, 'data', 'artifacts', 'originals')
          mkdirSync(storedDirectory, { recursive: true })
          const storedPath = join(storedDirectory, artifactId)
          const originalBytes = Buffer.from(`${firstLine}\nsecond synthetic line\n`)
          writeFileSync(storedPath, originalBytes)
          const artifact: ArtifactRecord = {
            artifactId,
            sessionId: sourceId,
            incarnationId: null,
            direction: 'output',
            source: 'agent',
            originalName: `${sourceKind}-result.txt`,
            mediaType: 'text/plain',
            byteLength: originalBytes.byteLength,
            sha256: createHash('sha256').update(originalBytes).digest('hex'),
            storedPath,
            sourcePath: null,
            state: 'ready',
            createdAt: now
          }
          insertArtifact(database, artifact)
          const writes: Uint8Array[] = []
          const events: AppEventMessage[] = []
          const manager = {
            liveIncarnationId: (sessionId: string) => sessionId === destinationId ? `${destinationId}-incarnation` : `${sourceId}-incarnation`,
            writeToSession: (sessionId: string, bytes: Uint8Array) => {
              if (sessionId !== destinationId) throw new Error('Handoff addressed the wrong harness')
              writes.push(bytes)
              destination.write(new TextDecoder().decode(bytes))
            },
            sessionWithCurrentProcessState: (session: SessionRecord) => session
          } as unknown as SessionManager
          const service = new CompanionService({
            database: workerLike(database),
            manager,
            roots: {
              config: join(root, 'config'), data: join(root, 'data'),
              state: join(root, 'state'), runtime: join(root, 'runtime')
            },
            cliPath: join(REPO, 'apps/desktop/bin/bmn'),
            emit: (message) => events.push(message),
            now: () => new Date(now)
          })
          await mkdir(join(root, 'config'), { recursive: true })
          await writeFile(join(root, 'README.txt'), 'Synthetic BMN cross-harness trial.\n')

          const prefixToken = sourceKind === 'claude' ? 'PREFIX_CLAUDE_TO_CODEX' : 'PREFIX_CODEX_TO_CLAUDE'
          const existingInput = destinationKind === 'claude'
            ? 'I am testing my local BMN handoff with a synthetic text file I created. Direct request: read the selected file and report its first line so I can verify BMN preserved the correct original. The package is: '
            : `Reply with ${prefixToken}, then one space, then follow this handoff: `
          const existingInputMarker = destinationKind === 'claude' ? 'testing my local BMN handoff' : prefixToken
          const responseMarker = destinationKind === 'claude' ? firstLine : `${prefixToken} … ${firstLine} (both present)`
          // Codex 0.157 interleaves status-bar redraws through the streaming response and echoes the
          // handoff stamp between the prefix and the first line, so an exact adjacency match never lands;
          // the response signal is both tokens present (the prefix echoes in input, the first line only
          // arrives with the destination's answer). Every response check uses this one test.
          const responseIn = (text: string) => destinationKind === 'claude'
            ? text.includes(firstLine)
            : text.includes(prefixToken) && text.includes(firstLine)
          destination.write(existingInput)
          await waitFor(() => destination.output().includes(existingInputMarker), `${destinationKind} existing input`, 10_000)
          const draft = await service.route(METHOD_REGISTRY.draftSave, {
            sourceSessionId: sourceId,
            sessionId: destinationId,
            text: destinationKind === 'claude'
              ? 'Synthetic owner-reviewed context from the source session; the listed text file is the selected original.'
              : 'Read the selected original with your available file-reading tool. Append only its first line to the response format already present in the destination input.',
            artifactIds: [artifactId]
          }) as InputDraftRecord
          const result = await service.route(METHOD_REGISTRY.draftSend, {
            draftId: draft.draftId,
            submit: false,
            expectedIncarnationId: `${destinationId}-incarnation`,
            expectedUpdatedAt: draft.updatedAt
          }) as InputDraftRecord
          await new Promise((resolve) => setTimeout(resolve, 1_500))
          const beforeSubmit = destination.output()
          const noResponseBeforeSubmit = !responseIn(beforeSubmit)
          const payloadBeforeSubmit = new TextDecoder().decode(writes[0])
          // This checks only what BMN sent to the PTY. The CLI can still erase the prior input, so the
          // actual submitted prompt and input-retention promise remain UNVERIFIED.
          const inputBytesSentBeforeSubmit = destination.inputWrites().join('') === existingInput + payloadBeforeSubmit &&
            destination.inputWrites().every((write) => !write.includes('\r'))
          destination.write('\r')
          try {
            await waitFor(() => responseIn(destination.output()), `${destinationKind} handoff response`)
          } catch (error) {
            const transcriptPath = join(REPO, `.dev-auto/evidence/${sourceKind}-to-${destinationKind}-failure.txt`)
            writeFileSync(transcriptPath, destination.output())
            throw new Error(`Timed out waiting for the ${destinationKind} handoff response; output is in the local failure receipt`, { cause: error })
          }

          const payload = new TextDecoder().decode(writes[0])
          const receipt: DirectionReceipt = {
            direction: `${sourceKind}->${destinationKind}`,
            codexVersion,
            claudeVersion,
            sourceReady: source.output().length > 0,
            destinationReady: destination.output().length > 0,
            pasteWrites: writes.length,
            oneBoundedPaste: writes.length === 1 && !payload.endsWith('\r') && payload.includes('[BMN handoff from') &&
              payload.includes(artifact.originalName),
            existingInputSeenInOutput: beforeSubmit.includes(existingInputMarker),
            inputBytesSentBeforeSubmit,
            inputRetention: 'UNVERIFIED',
            noResponseBeforeSubmit,
            acceptedState: result.state,
            responseObserved: responseIn(destination.output()),
            selectedOriginalReadable: destination.output().includes(firstLine),
            responseMarker,
            manualConfirmationUsed: false
          }
          expect(events.some((event) => event.topic === 'drafts')).toBe(true)
          return receipt
        } finally {
          database.close()
        }
      } finally {
        await destination.stop()
      }
    } finally {
      await source.stop()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('real BMN cross-harness compatibility', () => {
  const receipts: DirectionReceipt[] = []

  it('hands synthetic content from Claude to Codex', async () => {
    const receipt = await runDirection('claude', 'codex')
    receipts.push(receipt)
    expect(receipt).toMatchObject({
      direction: 'claude->codex', pasteWrites: 1, oneBoundedPaste: true,
      existingInputSeenInOutput: true, inputBytesSentBeforeSubmit: true, inputRetention: 'UNVERIFIED',
      noResponseBeforeSubmit: true,
      acceptedState: 'accepted', responseObserved: true, selectedOriginalReadable: true
    })
  }, 180_000)

  it('hands synthetic content from Codex to Claude', async () => {
    const receipt = await runDirection('codex', 'claude')
    receipts.push(receipt)
    expect(receipt).toMatchObject({
      direction: 'codex->claude', pasteWrites: 1, oneBoundedPaste: true,
      existingInputSeenInOutput: true, inputBytesSentBeforeSubmit: true, inputRetention: 'UNVERIFIED',
      noResponseBeforeSubmit: true,
      acceptedState: 'accepted', responseObserved: true, selectedOriginalReadable: true
    })
  }, 180_000)

  afterAll(() => {
    if (receipts.length === 0) return
    const receiptPath = join(REPO, '.dev-auto/evidence/cross-harness-receipt.json')
    writeFileSync(receiptPath, `${JSON.stringify({
      createdAt: new Date().toISOString(),
      acceptanceVerdict: 'UNVERIFIED',
      reason: 'The current TUI input and submitted prompt were not directly inspected; passing method checks cannot certify retained input.',
      codexVersion: receipts[0]!.codexVersion,
      claudeVersion: receipts[0]!.claudeVersion,
      modelsObservedInTui: {
        codex: codexModelObserved || 'gpt-5.6-luna (-c model_reasoning_effort=low)',
        claude: 'Sonnet 5 low'
      },
      permissions: { codex: 'read-only / never', claude: 'safe + restricted / Read only / dontAsk' },
      receipts: receipts.toSorted((left, right) => left.direction.localeCompare(right.direction)),
      manualPreparation: [
        'Write or edit the handoff summary.',
        'Select the destination and any stored originals.',
        'Open the destination, paste once, inspect current input, then submit manually.',
        'Claude safe/restricted mode may ask for a direct follow-up confirmation before reading a path received in bracketed pasted text; no summary or file path needs to be copied again.'
      ]
    }, null, 2)}\n`)
  })
})
