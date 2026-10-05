// MODULE: runner.ts - the main-process self-test: drives the real host, window and renderer through every phase
import {
  captureRelevantLaunchEnvironment
} from '../../utility/conversation-binding'
import {
  resolveApplicationRoots
} from '../../utility/roots'
import {
  DEFAULT_WORKSPACE_ID,
  STORY_SCHEMA_TABLES
} from '../../utility/store-schema'
import {
  backupsOf,
  claudeDays,
  type HistoryFixture,
  historyView,
  prepareHistoryFixture,
  recordedCalls,
  selfTestHistoryRoots
} from '../agent-history-self-test'
import {
  type BackgroundChoice,
  runningTargetForRuntime
} from '../app-lifecycle'
import {
  loadWorkspaceStartup
} from '../application-startup'
import type {
  FakeBotCall,
  FakeBotStep
} from '../fake-bot-api'
import {
  runLaunchSetRepositorySelfTest
} from '../launch-set-repository-self-test'
import { runCheckoutPeersSelfTest } from '../checkout-peers-self-test'
import {
  closeWithinDeadline,
  drainAfterExit,
  PtyHostRemoteError
} from '../pty-host-client'
import {
  WHISPER_ENGINE_FILE,
  SPEECH_DETECTOR_FILE,
  SPEECH_MODEL_FILE,
  VOICE_MODELS
} from '../voice-engine'
import {
  type AgentHistoryStatus,
  type AppSettings,
  type ArtifactRecord,
  type AttentionRecord,
  type BoundConversationBinding,
  ERROR_CODES,
  type ExplicitConversationBinding,
  HANDOFF_OUTLINE,
  type InputDraftRecord,
  type InterruptedSessionCohort,
  isTerminalOutputMessage,
  type LaunchTemplateRecord,
  type LayoutGetResult,
  METHOD_REGISTRY,
  type PersistedConversationBinding,
  type ProgressRecord,
  type SavedOutputCatalog,
  type SessionCohortOfferedResult,
  type SessionProcessStatus,
  type SessionRecord,
  type TelegramStatus,
  type TerminalOutputMessage,
  type WorkspaceRecord
} from '@bmn/protocol'
import {
  app,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  MessageChannelMain,
  type MessagePortMain,
  utilityProcess
} from 'electron'
import {
  spawnSync
} from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  truncateSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import {
  basename,
  join,
  sep
} from 'node:path'
import type { AttachmentIdentity, HostHealth, SelfTestHost, SessionIdentity } from '../index'
import { fileReferenceFixtureNames } from '../../renderer/src/file-reference-probe'
import {
  MODE_PASTE_TEXT,
  closePromptDialogText,
  closeResumeOffer,
  driveModeSensitiveInput,
  inverseTextContrast,
  liveExitPaneLabel,
  pressResumeOffer,
  recoveredStoppedLabel,
  resumeOfferShown,
  resumeOfferStaysAway,
  runPaletteCommand,
  sidebarSessionWord,
  stoppedPanelLabel,
  stoppedPanelProgress,
  terminalViewModes,
  untilModeProgramRead,
  waitForRendererHook,
  waitForRendererIntegration,
  waitForRendererLoad
} from './probes'
import {
  type OriginProbe,
  fireOriginGate,
  harnessRuns,
  listedConversation,
  modelOriginProbe,
  selfTestCodexHome,
  terminalModeProgramInput,
  untilFileExists,
  untilHarnessRuns,
  writeAcceptanceHarness,
  writeArgvRecorder,
  writeClaudeHookHarness,
  writeCodexHarness,
  writeIsolationHookHarness,
  writeOriginHarness,
  writeRemoteAnswerHarness,
  writeTerminalModeProgram,
  writeTerminalNoticeHarness
} from './harnesses'
import {
  powerShellQuote,
  selfTestShell,
  useStandInLauncher,
  WINDOWS_FULL_SCREEN,
  WINDOWS_SHELL_CHECKS,
  windowsSystemFolder,
  writeNodeProgram
} from './programs'
import { sixelTerminfoReady } from '../../utility/terminal-graphics'
import { SELF_TEST_LAUNCH_DISABLED_REASON, SELF_TEST_TELEGRAM_CHAT_ID, type SelfTestRecorder } from './taps'

export { SelfTestRecorder } from './taps'

const SELF_TEST_TIMEOUT_MS = 15_000
/** A failed self-test's release may still run after the reason is printed; it waits this long for the host. */
const SELF_TEST_RELEASE_CLOSE_DEADLINE_MS = 5_000
let selfTestFailureReported = false
/** Production main's state and functions, handed over by the entry; set before anything below runs. */
let host!: SelfTestHost
/** What production main recorded for this run. */
let taps!: SelfTestRecorder

/** What the renderer's activity probe hands back for one self-test sampling window. */
interface ActivitySampling {
  samples: {
    at: number
    words: Record<string, string | null>
    titles: Record<string, string | null>
    burstDone: boolean
  }[]
  attentionBefore: number
  attentionAfter: number
  updates: Record<string, number>
  before: Record<string, { cols: number; rows: number; refits: number; inputEvents: number } | null>
  after: Record<string, { cols: number; rows: number; refits: number; inputEvents: number } | null>
  burstBuffer: string
}

/** What the renderer observed while the hook fixture's requests were opened, resolved and listed. */
interface TerminalNoticeProbe {
  openedBy: string | null
  title: string
  body: string | null
  kind: string
  provenance: string
  ptyInputEvents: number
  /** The terminal around a second notice: AC5 says reading one never resizes or retypes anything. */
  aroundSecondNotice: { title: string; openedBy: string; sameSize: boolean; sameElement: boolean; refits: number; inputEvents: number }
  hookedSessionRows: number
  hookedSessionEvents: { agent: string; event: string; effects: string[] }[]
  resolvedState: string
  resolvedBy: string | null
}

interface HookProvenanceProbe {
  answeredByTypingResolvedBy: string | null
  answeredByTypingState: string
  rows: string[]
  events: { event: string; effects: string[]; toolName: string | null }[]
  /** The other live session's own log, read with the same bridge call: each session sees only its own events. */
  otherSessionEvents: { event: string; effects: string[] }[]
  listWroteToPty: boolean
  openRequestsBefore: number
  openRequestsAfter: number
  closed: boolean
}


async function expectRemoteFailure(
  operation: Promise<unknown>,
  expectedCode: string,
  expectedCopy: string
): Promise<void> {
  try {
    await operation
    throw new Error(`expected ${expectedCode} failure`)
  } catch (error) {
    if (!(error instanceof PtyHostRemoteError)) throw error
    if (error.protocolError.data.code !== expectedCode || !error.message.includes(expectedCopy)) {
      throw new Error(`unexpected host failure: ${error.message}`, { cause: error })
    }
  }
}

async function nativeFailureSelfTest(hostEntry: string, repoRoot: string): Promise<void> {
  const dataRoot = process.env.BMN_DATA_HOME
  if (!dataRoot) throw new Error('self-test requires BMN_DATA_HOME')
  const databasePath = join(dataRoot, 'state.sqlite3')
  const child = utilityProcess.fork(hostEntry, ['--native-failure-self-test'], {
    serviceName: 'pty-host-native-failure',
    stdio: 'pipe',
    env: {
      ...host.hostEnvironment(repoRoot),
      BMN_TEST_FAIL_NATIVE: 'node-pty'
    }
  })
  let stderr = ''
  const collect = (chunk: Buffer): void => {
    stderr += chunk.toString('utf8')
  }
  const stream = child.stderr
  stream?.on('data', collect)
  // The message can arrive after the exit, when Electron has already dropped this listener (an empty stderr twice
  // under load, 2026-09-28); the drain listens again and waits for the stream's end.
  let drained: Promise<void> = Promise.resolve()
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('native failure self-test timed out'))
    }, SELF_TEST_TIMEOUT_MS)
    child.once('exit', (code) => {
      clearTimeout(timer)
      drained = drainAfterExit([[stream, collect]], 10_000)
      resolveExit(code)
    })
  })
  await drained
  if (exitCode === 0) throw new Error('native failure host unexpectedly exited zero')
  if (!stderr.includes('native module "node-pty" failed to load') || !stderr.includes('No sessions were started.')) {
    throw new Error(`native failure copy was not actionable (exit ${exitCode}): ${stderr.slice(-480)}`)
  }
  if (existsSync(databasePath)) {
    throw new Error('native failure created the database before dependency loading completed')
  }
}

async function waitForTerminalMarker(
  port: MessagePortMain,
  attachmentId: string,
  marker: string
): Promise<{ sequences: number[]; output: string }> {
  return new Promise((resolveMarker, reject) => {
    const decoder = new TextDecoder()
    const sequences: number[] = []
    let output = ''
    const timer = setTimeout(
      () => reject(new Error(`terminal marker was not observed; output=${JSON.stringify(output.slice(-500))}`)),
      SELF_TEST_TIMEOUT_MS
    )
    port.on('message', (event) => {
      if (!isTerminalOutputMessage(event.data)) return
      const message: TerminalOutputMessage = event.data
      if (message.attachmentId !== attachmentId) return
      sequences.push(message.streamSeq)
      output += decoder.decode(message.bytes, { stream: true })
      port.postMessage({
        kind: 'terminal-ack',
        attachmentId,
        streamSeq: message.streamSeq
      })
      if (output.includes(marker)) {
        clearTimeout(timer)
        resolveMarker({ sequences, output })
      }
    })
    port.start()
  })
}


/**
 * Clicks Resume on a stopped, bound session and reads what the owner is actually shown before
 * anything starts, then cancels. The caller checks that nothing was launched.
 */
async function resumeConfirmationShown(
  window: BrowserWindow,
  session: { sessionId: string; name: string },
  restoreSelectionTo: string
): Promise<{ command: string; note: string | null }> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      let selected = false;
      let clicked = false;
      const treeButton = (id) => [...document.querySelectorAll('.session-row > button[data-session-id]')]
        .find((candidate) => candidate.dataset.sessionId === id);
      const probe = () => {
        const button = treeButton(${JSON.stringify(session.sessionId)});
        if (!button) {
          reject(new Error('the bound session tree button was not rendered'));
          return;
        }
        if (!selected) {
          selected = true;
          button.click();
          setTimeout(probe, 25);
          return;
        }
        // The panel is shared, so wait for it to be this session's before touching its buttons.
        const shown = document.querySelector('.stopped-session h2')?.textContent?.trim();
        if (shown !== ${JSON.stringify(session.name)}) {
          if (Date.now() >= deadline) reject(new Error('the bound session panel never appeared: ' + shown));
          else setTimeout(probe, 25);
          return;
        }
        if (!clicked) {
          const resume = [...document.querySelectorAll('.stopped-session .actions button')]
            .find((candidate) => candidate.textContent.trim() === 'Resume');
          if (resume) {
            clicked = true;
            resume.click();
          }
          setTimeout(probe, 25);
          return;
        }
        const command = document.querySelector('dialog[open] .resume-command')?.textContent ?? null;
        if (command) {
          const note = document.querySelector('dialog[open] .dialog-note')?.textContent?.trim() ?? null;
          const cancel = [...document.querySelectorAll('dialog[open] .dialog-actions button')]
            .find((candidate) => candidate.textContent.trim() === 'Cancel');
          if (!cancel) {
            reject(new Error('the Resume confirmation offered no way out'));
            return;
          }
          cancel.click();
          // Leave the selection where this phase found it, so the persisted layout is unchanged.
          treeButton(${JSON.stringify(restoreSelectionTo)})?.click();
          resolve({ command, note });
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('the Resume confirmation did not show a command: ' + JSON.stringify({
            selected,
            clicked,
            actions: [...document.querySelectorAll('.stopped-session .actions button')]
              .map((candidate) => candidate.textContent.trim()),
            dialog: document.querySelector('dialog[open]')?.textContent?.trim() ?? null,
            feedback: document.querySelector('.feedback-notice')?.textContent?.trim() ?? null
          })));
        } else setTimeout(probe, 25);
      };
      probe();
    })
  `) as Promise<{ command: string; note: string | null }>
}


async function verifyRegisteredInvokeEnvelopes(): Promise<string[]> {
  const unauthorizedSender = { id: -1, mainFrame: {} }
  const event = {
    sender: unauthorizedSender,
    senderFrame: unauthorizedSender.mainFrame
  } as unknown as IpcMainInvokeEvent
  const channels: string[] = []
  for (const registration of host.bridgeRegistrations()) {
    if (!registration.channel.startsWith('aiterm:')) {
      throw new Error(`invoke channel ${registration.channel} is outside the aiterm: namespace`)
    }
    const answer = await registration.invoke(event)
    if (
      answer.ok !== false ||
      answer.code !== ERROR_CODES.unauthorized ||
      typeof answer.message !== 'string'
    ) {
      throw new Error(`invoke channel ${registration.channel} bypassed the typed bridge envelope`)
    }
    channels.push(registration.channel)
  }
  if (channels.length === 0 || new Set(channels).size !== channels.length) {
    throw new Error('runtime invoke-channel enumeration was empty or duplicated')
  }
  return channels
}

/** A binding the agent's SessionStart hook recorded, naming this conversation. */
function boundBy(binding: PersistedConversationBinding, agentCli: string, reference: string): boolean {
  return binding.status === 'bound' && binding.agentCli === agentCli && binding.captureRoute === 'hook-session-start' &&
    binding.conversationReference === reference
}

/** The one printer for a failed self-test: the first failure is the reason, printed once. */
export function reportSelfTestFailure(error: unknown): void {
  if (selfTestFailureReported) return
  selfTestFailureReported = true
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[BMN] session self-test failed: ${message}`)
}

export async function runSelfTest(selfTestHost: SelfTestHost, recorder: SelfTestRecorder): Promise<void> {
  host = selfTestHost
  taps = recorder
  const { hostEntry, repoRoot } = host.appPaths()
  // Windows stand-ins run as copies of the bmn.exe launcher; sessions type into PowerShell there.
  useStandInLauncher(host.hostEnvironment(repoRoot).BMN_CLI_PATH)
  const typedShell = selfTestShell()
  // PowerShell forms of POSIX redirection: `>` would write UTF-16 there, and `&&`/`||` do not exist in 5.1.
  const savedOutput = (command: string, file: string): string =>
    `[IO.File]::WriteAllLines(${powerShellQuote(file)}, [string[]](${command}))`
  const writtenLine = (line: string, file: string, append: boolean): string =>
    `[IO.File]::${append ? 'AppendAllText' : 'WriteAllText'}(${powerShellQuote(file)}, "${line}\`n")`
  const whenExit = (command: string, success: boolean, then: string): string =>
    `${command}${success ? '' : ' 2>$null'}; if ($LASTEXITCODE ${success ? '-eq' : '-ne'} 0) { ${then} }`
  /** Prints the parts joined, so the echoed command never holds the joined marker. */
  const printed = (...parts: string[]): string => `Write-Output (${parts.map(powerShellQuote).join(' + ')})`
  const ran = (program: string, ...args: string[]): string => [`& ${powerShellQuote(program)}`, ...args].join(' ')
  /** The shell's arguments that run one program, as an agent typed into a shell would be. */
  const shellRunning = (program: string): string[] =>
    typedShell.windows ? ['-NoLogo', '-NoProfile', '-Command', ran(program)] : ['-c', program]
  const displayedFile = (file: string): string => `[Console]::Out.Write([IO.File]::ReadAllText(${powerShellQuote(file)}))`
  // Set before the host starts: the utility captures CODEX_HOME into every session's launch context.
  process.env.CODEX_HOME = selfTestCodexHome()
  await nativeFailureSelfTest(hostEntry, repoRoot)
  const launched = await host.launchHostWithChannel()
  let client = launched.client
  const ready = launched.ready
  let applicationPort: MessagePortMain | undefined = launched.applicationPort
  let receipt: Record<string, unknown> | undefined
  /** Epic 31's fixture; its holder process is stopped when the self-test releases its resources. */
  let historyFixture: HistoryFixture | undefined
  /** Epic 12.1: what the CLI stored, what it refused, and whether the links survive a restart. */
  let progressEvidence: {
    sameIdOnRetry: boolean
    outcome: string[]
    state: string
    label: string
    links: ProgressRecord['evidence']
    artifactId: string
  } | undefined
  let graceful = true
  let clientClosed = false
  try {
    const isolatedCwd = process.env.BMN_STATE_HOME
    if (!isolatedCwd) throw new Error('self-test requires BMN_STATE_HOME')
    const envelopedInvokeChannels = await verifyRegisteredInvokeEnvelopes()

    await expectRemoteFailure(
      client.request(METHOD_REGISTRY.sessionCreate, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        name: 'Invalid directory probe',
        cwd: join(isolatedCwd, 'missing-launch-directory'),
        executable: typedShell.executable,
        argv: [],
        cols: 80,
        rows: 24
      }),
      ERROR_CODES.invalidArgument,
      'Launch directory does not exist or is not a directory:'
    )
    await expectRemoteFailure(
      client.request(METHOD_REGISTRY.sessionCreate, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        name: 'Invalid executable probe',
        cwd: isolatedCwd,
        executable: join(isolatedCwd, 'missing-shell'),
        argv: [],
        cols: 80,
        rows: 24
      }),
      ERROR_CODES.invalidArgument,
      'Shell executable does not exist or is not executable:'
    )
    const failedHealth = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    if (
      failedHealth.liveSessions !== 0 ||
      failedHealth.runningIncarnations !== 0 ||
      failedHealth.sessionRecords !== 0 ||
      failedHealth.incarnationRecords !== 0 ||
      failedHealth.workspaceRecords !== 1
    ) {
      throw new Error('a failed session.create appeared live')
    }

    const session = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionCreate, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Self-test shell',
      cwd: isolatedCwd,
      executable: typedShell.executable,
      argv: [...typedShell.argv],
      cols: 80,
      rows: 24
    })
    const attachment = await client.request<AttachmentIdentity>(METHOD_REGISTRY.terminalAttach, session)
    await client.request(METHOD_REGISTRY.terminalActivate, {
      attachmentId: attachment.attachmentId
    })
    const marker = 'AITERM-1-1-PORT-ROUNDTRIP'
    const environmentMarker = 'AITERM-1-1-ELECTRON-ENV-UNSET'
    const markerResult = waitForTerminalMarker(
      applicationPort,
      attachment.attachmentId,
      environmentMarker
    )
    applicationPort.postMessage({
      kind: 'terminal-input',
      method: METHOD_REGISTRY.terminalWrite,
      attachmentId: attachment.attachmentId,
      // Each marker is printed in parts, so the echoed command never contains it whole.
      bytes: new TextEncoder().encode(typedShell.windows
        ? "if ($null -eq $env:ELECTRON_RUN_AS_NODE) { 'AITERM-1-1-' + 'PORT-ROUNDTRIP'; 'AITERM-1-1-ELECTRON-ENV-' + 'UNSET' } else { 'AITERM-1-1-ELECTRON-ENV-' + 'LEAK' }\r"
        : `if [ -z "\${ELECTRON_RUN_AS_NODE+x}" ]; then printf 'AITERM-1-1-%s\\nAITERM-1-1-ELECTRON-ENV-%s\\n' 'PORT-ROUNDTRIP' 'UNSET'; else printf 'AITERM-1-1-ELECTRON-ENV-%s\\n' 'LEAK'; fi\r`
      )
    })
    const observed = await markerResult
    if (!observed.output.includes(marker) || observed.output.includes('AITERM-1-1-ELECTRON-ENV-LEAK')) {
      throw new Error('the spawned shell inherited ELECTRON_RUN_AS_NODE')
    }
    if (!observed.sequences.every((sequence, index) => sequence === index)) {
      throw new Error(`terminal stream sequence was not contiguous from zero: ${observed.sequences.join(',')}`)
    }

    await client.request(METHOD_REGISTRY.terminalResize, {
      attachmentId: attachment.attachmentId,
      cols: 101,
      rows: 37
    })
    const resizedHealth = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    const resized = resizedHealth.sessions.find(
      (candidate) => candidate.incarnationId === session.incarnationId
    )
    if (resized?.cols !== 101 || resized.rows !== 37) {
      throw new Error('PTY dimensions did not follow terminal.resize')
    }

    await client.request(METHOD_REGISTRY.terminalDetach, {
      attachmentId: attachment.attachmentId
    })
    const detachedHealth = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    if (detachedHealth.liveSessions !== 1 || detachedHealth.sessions[0]?.attached !== false) {
      throw new Error('terminal.detach stopped the process or retained its lease')
    }

    const secondWorkspace = await client.request<WorkspaceRecord>(METHOD_REGISTRY.workspaceCreate, {
      name: 'Self-test archived workspace',
      defaultCwd: isolatedCwd,
      position: 1
    })
    const rendererTemplate = await client.request<LaunchTemplateRecord>(
      METHOD_REGISTRY.templateCreate,
      {
        name: 'Template-picked shell',
        executable: typedShell.executable,
        argv: [...typedShell.argv],
        cwd: isolatedCwd,
        backgroundChoice: 'stop'
      }
    )
    const secondSession = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionCreate, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Same CLI chat B',
      cwd: isolatedCwd,
      executable: typedShell.executable,
      argv: [...typedShell.argv],
      cols: 80,
      rows: 24
    })
    taps.rendererLaunchBlockedSessionId = secondSession.sessionId
    taps.rendererUnavailableTemplate = {
      ...rendererTemplate,
      templateId: 'renderer-unavailable-template',
      name: 'Unavailable launch template',
      launchDisabledReason: SELF_TEST_LAUNCH_DISABLED_REASON
    }
    const thirdSession = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionCreate, {
      workspaceId: secondWorkspace.workspaceId,
      name: 'Archived running chat',
      cwd: isolatedCwd,
      executable: typedShell.executable,
      argv: [...typedShell.argv],
      cols: 80,
      rows: 24,
      backgroundChoice: 'hide'
    })
    const bindingFor = (
      identity: SessionIdentity,
      reference: string,
      agentCli: 'claude' | 'codex'
    ): ExplicitConversationBinding => ({
      sessionId: identity.sessionId,
      agentCli,
      status: 'bound',
      conversationReference: reference,
      captureRoute: 'explicit-resume-reference',
      launchContext: {
        cwd: isolatedCwd,
        executable: agentCli === 'codex' ? '/usr/bin/codex' : '/usr/bin/claude',
        argv: [],
        environment: captureRelevantLaunchEnvironment({})
      },
      detail: 'self-test fixture binding',
      capturedAt: '2026-09-13T00:00:00.000Z'
    })
    const bindingA = bindingFor(session, '11111111-1111-4111-8111-111111111111', 'codex')
    const bindingB = bindingFor(secondSession, '22222222-2222-4222-8222-222222222222', 'codex')
    const bindingC = bindingFor(thirdSession, '33333333-3333-4333-8333-333333333333', 'claude')
    for (const binding of [bindingA, bindingB, bindingC]) {
      await client.request(METHOD_REGISTRY.sessionBindingReplace, { binding })
    }
    const bindingBBeforeLocate = JSON.stringify(
      await client.request(METHOD_REGISTRY.sessionBindingGet, { sessionId: secondSession.sessionId })
    )
    await client.request(METHOD_REGISTRY.sessionBindingReplace, {
      binding: { ...bindingA, conversationReference: '44444444-4444-4444-8444-444444444444' }
    })
    const bindingBAfterLocate = JSON.stringify(
      await client.request(METHOD_REGISTRY.sessionBindingGet, { sessionId: secondSession.sessionId })
    )
    if (bindingBBeforeLocate !== bindingBAfterLocate) {
      throw new Error('Locate chat changed another session binding')
    }
    await client.request(METHOD_REGISTRY.sessionBindingClear, { sessionId: session.sessionId })
    const bindingBAfterStartNew = JSON.stringify(
      await client.request(METHOD_REGISTRY.sessionBindingGet, { sessionId: secondSession.sessionId })
    )
    if (bindingBBeforeLocate !== bindingBAfterStartNew) {
      throw new Error('Start new changed another session binding')
    }
    await client.request(METHOD_REGISTRY.sessionBindingReplace, {
      binding: { ...bindingA, conversationReference: '44444444-4444-4444-8444-444444444444' }
    })

    const defaultSessions = await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
      workspaceId: DEFAULT_WORKSPACE_ID
    })
    const editableSession = defaultSessions.find((record) => record.sessionId === session.sessionId)!
    await expectRemoteFailure(
      client.request(METHOD_REGISTRY.sessionUpdate, {
        sessionId: editableSession.sessionId,
        expectedRevision: editableSession.revision,
        cwd: join(isolatedCwd, 'missing-edited-directory')
      }),
      ERROR_CODES.invalidArgument,
      'Launch directory does not exist or is not a directory:'
    )
    const afterInvalidEdit = await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
      workspaceId: DEFAULT_WORKSPACE_ID
    })
    if (afterInvalidEdit.find((record) => record.sessionId === session.sessionId)?.cwd !== isolatedCwd) {
      throw new Error('invalid session edit changed the stored launch directory')
    }
    await client.request(METHOD_REGISTRY.layoutPut, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      expectedRevision: 1,
      state: {
        workspaceId: DEFAULT_WORKSPACE_ID,
        selectedSessionId: secondSession.sessionId,
        split: {
          orientation: 'side-by-side',
          panes: [
            { sessionId: session.sessionId, ratio: 0.5 },
            { sessionId: secondSession.sessionId, ratio: 0.5 }
          ]
        },
        sessionView: {
          [session.sessionId]: { scrollLine: 19, followTail: false },
          [secondSession.sessionId]: { scrollLine: null, followTail: true }
        },
        revision: 1
      }
    })
    const rendererChannel = new MessageChannelMain()
    client.attachTerminalPort(rendererChannel.port1)
    applicationPort.close()
    applicationPort = rendererChannel.port2
    host.hostClient = client
    host.hostRendererPort = applicationPort
    host.trackSessionProcessStates(client)
    client.onAppEvent((message) => host.appEvents.forward(message))
    host.runtimes.clear()
    host.processTracking.unconfirmedExits.clear()
    host.sessionRecords.clear()
    const allSessions = [
      ...defaultSessions,
      ...await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
        workspaceId: secondWorkspace.workspaceId
      })
    ]
    const identities = [session, secondSession, thirdSession]
    const launchBackgroundChoiceRecorded = allSessions.find(
      (record) => record.sessionId === thirdSession.sessionId
    )?.backgroundChoice
    if (launchBackgroundChoiceRecorded !== 'hide') {
      throw new Error(`session.create did not record the launch background choice: ${String(launchBackgroundChoiceRecorded)}`)
    }
    if (!allSessions.every((record) =>
      record.lastProcess?.state === 'live' &&
      identities.some((identity) => identity.incarnationId === record.lastProcess?.incarnationId)
    )) {
      throw new Error('session.list did not report the live incarnation of every running session')
    }
    for (const record of allSessions) {
      host.sessionRecords.set(record.sessionId, record)
      const identity = identities.find((item) => item.sessionId === record.sessionId)!
      const liveAttachment = await client.request<AttachmentIdentity>(METHOD_REGISTRY.terminalAttach, identity)
      host.runtimes.set(record.sessionId, {
        client,
        session: identity,
        attachment: liveAttachment,
        rendererPort: applicationPort,
        dimensions: { cols: 80, rows: 24 },
        cwd: record.cwd,
        executable: record.executable,
        workspaceId: record.workspaceId,
        name: record.name,
        testMode: true,
        processState: 'live'
      })
    }
    const beforeRenderer = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    if (beforeRenderer.liveSessions !== 3 || beforeRenderer.incarnationRecords !== 3) {
      throw new Error('multi-session fixture did not create exactly three live processes')
    }
    const writeFixtureInput = (identity: SessionIdentity, input: string): void => {
      const runtime = host.runtimes.get(identity.sessionId)
      if (!runtime) throw new Error(`attention fixture runtime missing for ${identity.sessionId}`)
      applicationPort!.postMessage({
        kind: 'terminal-input',
        method: METHOD_REGISTRY.terminalWrite,
        attachmentId: runtime.attachment.attachmentId,
        bytes: new TextEncoder().encode(input)
      })
    }
    const writeFixtureCommand = (identity: SessionIdentity, command: string): void => {
      writeFixtureInput(identity, `${command}\r`)
    }
    writeFixtureCommand(
      session,
      'bmn ask self-question "Choose the self-test answer" --kind question'
    )
    writeFixtureCommand(
      secondSession,
      `bmn ask self-permission "Allow the self-test action" --kind permission --expires ${new Date(Date.now() + 10 * 60_000).toISOString()}; ` +
      'bmn ask self-review "Review the self-test result" --kind review; ' +
      'bmn ask self-update "Self-test turn finished" --kind notice; ' +
      'bmn progress failed "Observed self-test failure" --source self-test ' +
      '--observed 2026-09-18T20:00:00.000Z'
    )
    const attentionFixtureDeadline = Date.now() + 5_000
    while (Date.now() < attentionFixtureDeadline) {
      const [fixtureAttention, fixtureProgress] = await Promise.all([
        client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}),
        client.request<ProgressRecord[]>(METHOD_REGISTRY.progressList, {})
      ])
      if (
        fixtureAttention.filter((request) => request.state === 'open').length === 4 &&
        fixtureProgress.some((record) =>
          record.sessionId === secondSession.sessionId && record.state === 'failed' && record.source === 'self-test')
      ) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const [fixtureAttention, fixtureProgress] = await Promise.all([
      client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}),
      client.request<ProgressRecord[]>(METHOD_REGISTRY.progressList, {})
    ])
    if (
      fixtureAttention.filter((request) => request.state === 'open').length !== 4 ||
      !fixtureProgress.some((record) =>
        record.sessionId === secondSession.sessionId && record.state === 'failed' && record.source === 'self-test')
    ) {
      throw new Error('the attention/progress CLI fixture did not reach the utility owner')
    }
    // Epic 12.1: a session publishes a file of its own and then reports progress that points at it,
    // exactly as the CLI documents it. The three refusals in the same shell prove the report is all
    // or nothing: an ID from another session, a file handed *to* this session, and an unknown ID each
    // leave the previous observation exactly where it was.
    const evidenceDirectory = join(isolatedCwd, 'evidence')
    mkdirSync(evidenceDirectory, { recursive: true })
    const evidenceLog = join(evidenceDirectory, 'checks.log')
    writeFileSync(evidenceLog, 'self-test: 3 checks passed\n')
    const evidenceReceipt = join(evidenceDirectory, 'publish.json')
    const evidenceRetryReceipt = join(evidenceDirectory, 'publish-retry.json')
    const evidenceOutcome = join(evidenceDirectory, 'outcome.txt')
    const attachedToSession = await client.request<ArtifactRecord>(METHOD_REGISTRY.artifactImportBytes, {
      sessionId: session.sessionId,
      name: 'brief-handed-to-the-agent.txt',
      bytes: new TextEncoder().encode('what the owner asked for\n')
    })
    const otherSessionEvidence = await client.request<ArtifactRecord>(METHOD_REGISTRY.artifactImportBytes, {
      sessionId: secondSession.sessionId,
      name: 'another-sessions-file.txt',
      bytes: new TextEncoder().encode('not this session\n')
    })
    const publish = `bmn publish ${typedShell.windows ? powerShellQuote(evidenceLog) : evidenceLog} --key self-test-evidence --json`
    writeFixtureCommand(
      session,
      `bmn progress running "Self-test evidence baseline" --source evidence --observed 2026-09-18T19:00:00.000Z; ` +
      (typedShell.windows
        ? `${savedOutput(publish, evidenceReceipt)}; ${savedOutput(publish, evidenceRetryReceipt)}`
        // The same key must return the same artifact, which is what makes a later reference safe.
        : `${publish} > ${evidenceReceipt}; ${publish} > ${evidenceRetryReceipt}`)
    )
    const publishedEvidence = await (async (): Promise<{ first: string; retry: string }> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (existsSync(evidenceReceipt) && existsSync(evidenceRetryReceipt)) {
          try {
            const first = JSON.parse(readFileSync(evidenceReceipt, 'utf8')) as { artifactId?: string }
            const retry = JSON.parse(readFileSync(evidenceRetryReceipt, 'utf8')) as { artifactId?: string }
            if (first.artifactId && retry.artifactId) return { first: first.artifactId, retry: retry.artifactId }
          } catch {
            // The shell is still writing the file; read it again.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the session did not publish its own evidence file')
    })()
    const refusals: Array<[string, string]> = [
      [`--evidence-id ${otherSessionEvidence.artifactId}`, 'refused-other-session'],
      [`--evidence-id ${attachedToSession.artifactId}`, 'refused-input'],
      ['--evidence-id no-such-artifact', 'refused-unknown'],
      [`--evidence-id ${publishedEvidence.first} --evidence-id ${publishedEvidence.first}`, 'refused-duplicate']
    ]
    writeFixtureCommand(
      session,
      typedShell.windows ? [
        whenExit(`bmn progress verified "Self-test checks passed" --source evidence --detail "3 checks, 0 failures" ` +
          `--evidence-id ${publishedEvidence.first}`, true, writtenLine('accepted', evidenceOutcome, false)),
        ...refusals.map(([references, line]) => whenExit(`bmn progress failed "Should not be stored" --source evidence ${references}`,
          false, writtenLine(line, evidenceOutcome, true))),
        writtenLine('done', evidenceOutcome, true)
      ].join('; ') :
      // No --observed: the accepted report must be fresh, so the strip reads "Reported verified"
      // rather than the stale "Last reported verified". The baseline above is the old one.
      `bmn progress verified "Self-test checks passed" --source evidence ` +
      `--detail "3 checks, 0 failures" --evidence-id ${publishedEvidence.first} ` +
      `&& echo accepted > ${evidenceOutcome}; ` +
      `bmn progress failed "Should not be stored" --source evidence --evidence-id ${otherSessionEvidence.artifactId} ` +
      `2>/dev/null || echo refused-other-session >> ${evidenceOutcome}; ` +
      `bmn progress failed "Should not be stored" --source evidence --evidence-id ${attachedToSession.artifactId} ` +
      `2>/dev/null || echo refused-input >> ${evidenceOutcome}; ` +
      `bmn progress failed "Should not be stored" --source evidence --evidence-id no-such-artifact ` +
      `2>/dev/null || echo refused-unknown >> ${evidenceOutcome}; ` +
      `bmn progress failed "Should not be stored" --source evidence ` +
      `--evidence-id ${publishedEvidence.first} --evidence-id ${publishedEvidence.first} ` +
      `2>/dev/null || echo refused-duplicate >> ${evidenceOutcome}; ` +
      `echo done >> ${evidenceOutcome}`
    )
    const evidenceOutcomeLines = await (async (): Promise<string[]> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (existsSync(evidenceOutcome)) {
          const lines = readFileSync(evidenceOutcome, 'utf8').split('\n').filter((line) => line !== '')
          if (lines.at(-1) === 'done') return lines
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the evidence refusal fixture did not finish')
    })()
    const evidenceProgress = await (async (): Promise<ProgressRecord> => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const found = (await client.request<ProgressRecord[]>(METHOD_REGISTRY.progressList, {}))
          .find((record) => record.sessionId === session.sessionId && record.source === 'evidence')
        if (found?.state === 'verified') return found
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the evidence progress report did not reach the utility owner')
    })()
    progressEvidence = {
      sameIdOnRetry: publishedEvidence.first === publishedEvidence.retry,
      outcome: evidenceOutcomeLines,
      state: evidenceProgress.state,
      label: evidenceProgress.label,
      links: evidenceProgress.evidence,
      artifactId: publishedEvidence.first
    }

    const handoffArtifact = await client.request<ArtifactRecord>(METHOD_REGISTRY.artifactImportBytes, {
      sessionId: secondSession.sessionId,
      name: 'handoff-self-test.txt',
      bytes: new TextEncoder().encode('synthetic handoff original\n')
    })
    // Story 32.1: what holds an agent comes first, whatever order the requests arrived in.
    const expectedResponseTitles = ['Allow the self-test action', 'Choose the self-test answer', 'Review the self-test result']
    writeFixtureCommand(session, 'bmn ask self-race "A stale notice" --kind notice')
    const raceNotice = await (async (): Promise<AttentionRecord> => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const found = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
          .find((request) => request.requestKey === 'self-race' && request.state === 'open')
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the notice race fixture did not open')
    })()
    writeFixtureCommand(session, 'bmn ask self-race "A revised question" --kind question')
    const revisedPrompt = await (async (): Promise<AttentionRecord> => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const found = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
          .find((request) =>
            request.requestId === raceNotice.requestId &&
            request.kind === 'question' &&
            request.revision > raceNotice.revision)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the notice race fixture did not revise into a question')
    })()
    await expectRemoteFailure(
      client.request(METHOD_REGISTRY.attentionResolve, {
        requestId: raceNotice.requestId,
        resolution: 'Opened in BMN',
        expectedKind: raceNotice.kind,
        expectedRevision: raceNotice.revision
      }),
      ERROR_CODES.revisionConflict,
      'changed before it was opened'
    )
    const revisedAfterStaleActivation = (await client.request<AttentionRecord[]>(
      METHOD_REGISTRY.attentionList,
      {}
    )).find((request) => request.requestId === revisedPrompt.requestId)
    const revisedPromptPreserved =
      revisedAfterStaleActivation?.kind === 'question' && revisedAfterStaleActivation.state === 'open'
    if (!revisedPromptPreserved) {
      throw new Error(`activating a stale notice changed the question it became: ${JSON.stringify(revisedAfterStaleActivation)}`)
    }
    await client.request(METHOD_REGISTRY.attentionResolve, {
      requestId: revisedPrompt.requestId,
      resolution: 'Self-test cleanup'
    })
    // The probe pane prints a reference relative to its launch directory, then its shell moves elsewhere.
    const fileReferenceRoot = join(isolatedCwd, 'refs')
    mkdirSync(join(fileReferenceRoot, 'src'), { recursive: true })
    writeFileSync(
      join(fileReferenceRoot, 'src', 'parser.ts'),
      Array.from({ length: 60 }, (_, index) => index === 41 ? 'FILE-REFERENCE-TARGET line 42' : `line ${index + 1}`)
        .join('\n') + '\n'
    )
    const searchRoot = join(isolatedCwd, 'file-search-fixture')
    mkdirSync(searchRoot, { recursive: true })
    for (let index = 0; index < 120; index += 1) {
      writeFileSync(join(searchRoot, `search-cap-${String(index).padStart(3, '0')}.ts`), 'fixture\n')
    }
    const fixtureNames = fileReferenceFixtureNames(process.platform)
    writeFileSync(join(searchRoot, fixtureNames.unrepresentable), 'exact unrepresentable file\n')
    writeFileSync(join(searchRoot, fixtureNames.sibling), Array.from({ length: 60 }, () => 'wrong sibling').join('\n'))
    writeFileSync(join(searchRoot, fixtureNames.representable), 'representable quoted file\n')
    mkdirSync(join(searchRoot, 'node_modules'), { recursive: true })
    mkdirSync(join(searchRoot, '.git'), { recursive: true })
    writeFileSync(join(searchRoot, 'node_modules', 'bmn-excluded.ts'), 'fixture\n')
    writeFileSync(join(searchRoot, '.git', 'bmn-excluded.ts'), 'fixture\n')
    const deepSearchRoot = join(searchRoot, 'one', 'two', 'three', 'four', 'five', 'six', 'seven')
    mkdirSync(deepSearchRoot, { recursive: true })
    writeFileSync(join(deepSearchRoot, 'bmn-deep.ts'), 'fixture\n')
    writeFixtureInput(session, 'EXISTING-HANDOFF-PREFIX ')
    // Dictation needs an engine and an installed model to start; both are stand-ins, and transcription is synthetic.
    mkdirSync(join(taps.voiceFolder(), 'models'), { recursive: true })
    writeFileSync(join(taps.voiceFolder(), WHISPER_ENGINE_FILE), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(taps.voiceFolder(), SPEECH_DETECTOR_FILE), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(taps.voiceFolder(), SPEECH_MODEL_FILE), '')
    writeFileSync(join(taps.voiceFolder(), 'models', VOICE_MODELS[0]!.file), '')
    // A sparse file at the pinned size counts as installed; no model bytes are written.
    truncateSync(join(taps.voiceFolder(), 'models', VOICE_MODELS[0]!.file), VOICE_MODELS[0]!.bytes)
    const rendererStartup = await host.loadApplicationStartup(true)
    console.error('[BMN] self-test phase: renderer preload integration')
    host.applicationWindow = host.createWindow(rendererStartup, {
      forceHidden: true,
      terminalPort: applicationPort,
      recoverRenderer: host.recoverApplicationRenderer,    })
    let releaseAttentionUpdate: (() => void) | undefined
    const attentionBaselineCaptured = new Promise<void>((resolve) => {
      releaseAttentionUpdate = resolve
    })
    host.applicationWindow.webContents.on('console-message', (_event, level, message) => {
      if (level === 2) console.error(`[BMN] renderer console: ${message}`)
      if (message.includes('attention baseline captured')) releaseAttentionUpdate?.()
    })
    await waitForRendererLoad(host.applicationWindow)
    const cspProbe = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      let evalRefused = false;
      try { window.eval('1 + 1'); } catch { evalRefused = true; }
      let wasmAllowed = false;
      try {
        await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        wasmAllowed = true;
      } catch { /* reported below */ }
      return { evalRefused, wasmAllowed };
    })()`) as { evalRefused: boolean; wasmAllowed: boolean }
    if (!cspProbe.evalRefused || !cspProbe.wasmAllowed) {
      throw new Error(`Sixel CSP did not preserve the eval boundary: ${JSON.stringify(cspProbe)}`)
    }
    const sixelPtyPath = join(isolatedCwd, 'sixel-pty-frame.bin')
    writeFileSync(sixelPtyPath,
      `\u001bP9;1;0q"1;1;60;75#1;2;100;0;0#1${Array(13).fill('!60~').join('-')}\u001b\\`)
    const sixelPtyBefore = await host.applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const probe = () => {
          const snapshot = window.__aitermTest?.snapshots()[${JSON.stringify(secondSession.sessionId)}];
          if (snapshot) resolve(snapshot.imageStorageMB);
          else if (Date.now() >= deadline) reject(new Error('PTY Sixel pane did not mount'));
          else setTimeout(probe, 25);
        };
        probe();
      })
    `) as number
    const sixelPtyRuntime = host.runtimes.get(secondSession.sessionId)
    if (!sixelPtyRuntime) throw new Error('PTY Sixel fixture runtime was unavailable')
    await client.request(METHOD_REGISTRY.terminalWrite, {
      attachmentId: sixelPtyRuntime.attachment.attachmentId,
      bytes: new TextEncoder().encode(typedShell.windows ? `${displayedFile(sixelPtyPath)}\r` : `cat '${sixelPtyPath.replaceAll("'", "'\\''")}'\r`)
    })
    const sixelPty = await host.applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const probe = () => {
          const snapshot = window.__aitermTest?.snapshot(${JSON.stringify(secondSession.sessionId)});
          if (snapshot?.imageStorageMB > ${sixelPtyBefore} && snapshot.imageLayerPresent) {
            resolve({ beforeMB: ${sixelPtyBefore}, afterMB: snapshot.imageStorageMB,
              layer: snapshot.imageLayerPresent });
          } else if (Date.now() >= deadline) reject(new Error('PTY Sixel frame did not reach the live pane: ' +
            JSON.stringify({ storageMB: snapshot?.imageStorageMB,
              lines: snapshot?.bufferLines.slice(-8) })));
          else setTimeout(probe, 25);
        };
        probe();
      })
    `) as { beforeMB: number; afterMB: number; layer: boolean }
    if (!(sixelPtyBefore === 0 && sixelPty.afterMB > 0 && sixelPty.layer)) {
      throw new Error(`PTY Sixel transport did not decode in the live pane: ${JSON.stringify(sixelPty)}`)
    }
    // Decode a known frame in one real pane. This bypasses shell command timing so a failure names
    // the renderer itself; transport has its own framing and queue checks.
    const sixelDirect = await host.applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const probe = () => {
          const hook = window.__aitermTest;
          if (hook?.snapshots()[${JSON.stringify(secondSession.sessionId)}]) {
            const otherBefore = hook.snapshot(${JSON.stringify(session.sessionId)});
            hook.sixelFixture(${JSON.stringify(secondSession.sessionId)}).then((fixture) => {
              const otherAfter = hook.snapshot(${JSON.stringify(session.sessionId)});
              resolve({ fixture, otherBefore, otherAfter });
            }, reject);
          } else if (Date.now() >= deadline) reject(new Error('the Sixel pane did not mount'));
          else setTimeout(probe, 25);
        };
        probe();
      })
    `) as { fixture: { storageMB: number; layer: boolean };
      otherBefore: { imageStorageMB: number; imageLayerPresent: boolean };
      otherAfter: { imageStorageMB: number; imageLayerPresent: boolean } }
    const sixelRender = {
      ownStorageMB: sixelDirect.fixture.storageMB,
      ownLayer: sixelDirect.fixture.layer,
      otherStorageMB: sixelDirect.otherAfter.imageStorageMB,
      otherImageUnchanged: sixelDirect.otherBefore.imageStorageMB === sixelDirect.otherAfter.imageStorageMB &&
        sixelDirect.otherBefore.imageLayerPresent === sixelDirect.otherAfter.imageLayerPresent
    }
    if (!(sixelRender.ownStorageMB > 0 && sixelRender.ownLayer)) {
      throw new Error(`the real pane could not decode the Sixel fixture: ${JSON.stringify(sixelRender)}`)
    }
    if (!sixelRender.otherImageUnchanged || sixelRender.otherStorageMB !== 0) {
      throw new Error(`Sixel output changed the other pane image layer: ${JSON.stringify(sixelRender)}`)
    }

    // Epic 28.1 AC2/AC3/AC5: a Codex-style animation in one of two visible panes. Codex 0.157.1's
    // built-in pets change frame every 120–150 ms (pets/model.rs) and allow up to 60 fps; each
    // frame blanks the pet's rows, draws the next image there and restores the cursor.
    const animationDirectory = join(isolatedCwd, 'sixel-animation')
    mkdirSync(animationDirectory, { recursive: true })
    const codexFrame = (seed: number): string => {
      let body = ''
      for (let color = 0; color < 8; color += 1) {
        body += `#${color};2;${(color * 37 + seed * 11) % 100};${(color * 53) % 100};${(color * 71 + seed * 5) % 100}`
      }
      for (let row = 0; row < 13; row += 1) {
        for (let color = 0; color < 8; color += 1) {
          body += `#${color}`
          for (let x = 0; x < 96; x += 1) body += String.fromCharCode(63 + ((x * 7 + row * 13 + color * 5 + seed) % 64))
          if (color < 7) body += '$'
        }
        if (row < 12) body += '-'
      }
      return `\u001bP9;1;0q"1;1;96;75${body}\u001b\\`
    }
    writeFileSync(join(animationDirectory, 'frame0.six'), codexFrame(0))
    writeFileSync(join(animationDirectory, 'frame1.six'), codexFrame(1))
    const posixAnimationScript = join(animationDirectory, 'animate.sh')
    // Windows: the same frames, cursor save/restore and pacing from a Node stand-in.
    const animationScript = typedShell.windows ? writeNodeProgram(animationDirectory, 'animate', [
      "const { readFileSync } = require('node:fs')",
      'const [frames, delay, label] = process.argv.slice(2)',
      ';(async () => {',
      '  for (let i = 0; i < Number(frames); i += 1) {',
      "    let out = '\\u001b7'",
      "    for (let r = 2; r <= 7; r += 1) out += '\\u001b[' + r + ';40H' + ' '.repeat(24)",
      "    out += '\\u001b[2;40H' + readFileSync(__dirname + '/frame' + (i % 2) + '.six', 'latin1') + '\\u001b8'",
      '    process.stdout.write(out)',
      '    await new Promise((resolve) => setTimeout(resolve, Number(delay) * 1000))',
      '  }',
      "  process.stdout.write(label + '-DONE\\r\\n')",
      '})()',
      ''
    ].join('\n')) : posixAnimationScript
    if (!typedShell.windows) writeFileSync(posixAnimationScript, [
      '#!/bin/sh',
      'frames=$1; delay=$2; label=$3; dir=$(dirname "$0"); i=0',
      'while [ "$i" -lt "$frames" ]; do',
      "  printf '\\0337'",
      "  r=2; while [ \"$r\" -le 7 ]; do printf '\\033[%d;40H%24s' \"$r\" ''; r=$((r + 1)); done",
      "  printf '\\033[2;40H'; cat \"$dir/frame$((i % 2)).six\"; printf '\\0338'",
      '  i=$((i + 1)); sleep "$delay"',
      'done',
      "printf '%s-DONE\\r\\n' \"$label\""
    ].join('\n') + '\n', { mode: 0o700 })
    const animatedRuntime = host.runtimes.get(secondSession.sessionId)
    if (!animatedRuntime) throw new Error('the animation pane runtime was unavailable')
    const animatedAttachment = animatedRuntime.attachment.attachmentId
    const typeIntoAnimatedPane = (text: string) => client.request(METHOD_REGISTRY.terminalWrite, {
      attachmentId: (host.runtimes.get(secondSession.sessionId) ?? animatedRuntime).attachment.attachmentId,
      bytes: new TextEncoder().encode(text)
    })
    const animatedId = JSON.stringify(secondSession.sessionId)
    const quietId = JSON.stringify(session.sessionId)
    const waitForAnimatedLine = (marker: string, timeoutMs: number) => host.applicationWindow!.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + ${timeoutMs};
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshot(${animatedId}).bufferLines.some((line) => line.includes(${JSON.stringify(marker)}))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // The pane's last lines show whether the command arrived, ran or is still waiting.
      const lines = (window.__aitermTest?.snapshot(${animatedId}).bufferLines ?? []).filter((line) => line.trim())
        .slice(-12).map((line) => line.trimEnd().slice(0, 160));
      throw new Error(${JSON.stringify(`the animation pane never printed ${marker}: `)} + JSON.stringify(lines));
    })()`) as Promise<void>
    const quietBefore = await host.applicationWindow.webContents.executeJavaScript(`(() => {
      const hook = window.__aitermTest;
      const selection = hook.view(${quietId}).select(0, 0, 12);
      const snapshot = hook.snapshot(${quietId});
      return { lines: snapshot.bufferLines, storageMB: snapshot.imageStorageMB, layer: snapshot.imageLayerPresent, selection };
    })()`) as { lines: string[]; storageMB: number; layer: boolean; selection: string }
    await typeIntoAnimatedPane(typedShell.windows
      ? `Clear-Host; ${ran(animationScript, '64', '0.12', 'CODEX-RATE')}; ${ran(animationScript, '120', '0.016', 'MAX-RATE')}\r`
      : `clear; '${animationScript}' 64 0.12 CODEX-RATE; '${animationScript}' 120 0.016 MAX-RATE\r`)
    await waitForAnimatedLine('CODEX-RATE-DONE', 30_000)
    await waitForAnimatedLine('MAX-RATE-DONE', 30_000)
    // Scroll the pane well past its rows: only the last frame drawn may remain in the buffer.
    await typeIntoAnimatedPane(typedShell.windows
      ? `0..79 | ForEach-Object { "scroll-$_" }; ${printed('SCROLL', 'ED')}\r`
      : `i=0; while [ $i -lt 80 ]; do echo scroll-$i; i=$((i + 1)); done; printf '%s%s\\n' SCROLL ED\r`)
    await waitForAnimatedLine('SCROLLED', 10_000)
    const animation = await host.applicationWindow.webContents.executeJavaScript(`(() => {
      const hook = window.__aitermTest;
      const own = hook.snapshot(${animatedId});
      const quiet = hook.snapshot(${quietId});
      return { storageMB: own.imageStorageMB, imageLines: hook.view(${animatedId}).imageCells().lines,
        quiet: { lines: quiet.bufferLines, storageMB: quiet.imageStorageMB, layer: quiet.imageLayerPresent,
          selection: (() => {
            const selection = hook.view(${quietId}).selection();
            hook.view(${quietId}).clearSelection();
            return selection;
          })() } };
    })()`) as { storageMB: number; imageLines: number[];
      quiet: { lines: string[]; storageMB: number; layer: boolean; selection: string } }
    const sixelAnimation = {
      noViewRebuild: host.runtimes.get(secondSession.sessionId)?.attachment.attachmentId === animatedAttachment,
      storageMB: animation.storageMB,
      imageLinesAfterScroll: animation.imageLines.length,
      quietPaneUnchanged: JSON.stringify(animation.quiet.lines) === JSON.stringify(quietBefore.lines) &&
        animation.quiet.storageMB === quietBefore.storageMB && animation.quiet.layer === quietBefore.layer,
      quietSelectionKept: quietBefore.selection.length > 0 && animation.quiet.selection === quietBefore.selection
    }
    // One 75 px frame covers at most 7 rows at the smallest font; more means stale frames stayed.
    if (!sixelAnimation.noViewRebuild || !(sixelAnimation.storageMB > 0) || sixelAnimation.imageLinesAfterScroll > 7 ||
      !sixelAnimation.quietPaneUnchanged || !sixelAnimation.quietSelectionKept) {
      throw new Error(`the two-pane Sixel animation failed: ${JSON.stringify(sixelAnimation)}`)
    }

    // AC3: both visible panes animate at once, at Codex's cadence; neither view is rebuilt.
    const quietRuntime = host.runtimes.get(session.sessionId)
    if (!quietRuntime) throw new Error('the second animation pane runtime was unavailable')
    const quietAttachment = quietRuntime.attachment.attachmentId
    const animatedAttachmentBoth = host.runtimes.get(secondSession.sessionId)!.attachment.attachmentId
    await client.request(METHOD_REGISTRY.terminalWrite, { attachmentId: quietAttachment,
      // Ctrl+U first (PSReadLine: Ctrl+C cancels the line): this prompt holds unsent handoff-fixture input, restored below.
      bytes: new TextEncoder().encode(typedShell.windows
        ? `\u0003Clear-Host; ${ran(animationScript, '64', '0.12', 'BOTH-B')}\r`
        : `\u0015clear; '${animationScript}' 64 0.12 BOTH-B\r`) })
    await typeIntoAnimatedPane(typedShell.windows
      ? `Clear-Host; ${ran(animationScript, '64', '0.12', 'BOTH-A')}\r`
      : `clear; '${animationScript}' 64 0.12 BOTH-A\r`)
    await waitForAnimatedLine('BOTH-A-DONE', 30_000)
    await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshot(${quietId}).bufferLines.some((line) => line.includes('BOTH-B-DONE'))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the second animated pane never finished');
    })()`)
    const sixelTwoPaneAnimation = {
      noViewRebuild: host.runtimes.get(session.sessionId)?.attachment.attachmentId === quietAttachment &&
        host.runtimes.get(secondSession.sessionId)?.attachment.attachmentId === animatedAttachmentBoth,
      storageMB: await host.applicationWindow.webContents.executeJavaScript(`(() => {
        const snapshots = window.__aitermTest.snapshots();
        return [snapshots[${animatedId}].imageStorageMB, snapshots[${quietId}].imageStorageMB];
      })()`) as number[]
    }
    if (!sixelTwoPaneAnimation.noViewRebuild || sixelTwoPaneAnimation.storageMB.length !== 2 ||
      sixelTwoPaneAnimation.storageMB.some((value) => !(value > 0))) {
      throw new Error(`the two-pane animation rebuilt a view or lost its images: ${JSON.stringify(sixelTwoPaneAnimation)}`)
    }
    await client.request(METHOD_REGISTRY.terminalWrite, { attachmentId: quietAttachment,
      bytes: new TextEncoder().encode(typedShell.windows
        ? `Clear-Host; ${printed('QUIET-PANE', '-', 'CLEARED')}\r`
        : `clear; printf '%s-%s\\n' QUIET-PANE CLEARED\r`) })
    await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshot(${quietId}).bufferLines.some((line) => line.includes('QUIET-PANE-CLEARED'))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the second animated pane did not clear');
    })()`)
    await client.request(METHOD_REGISTRY.terminalWrite, { attachmentId: quietAttachment,
      bytes: new TextEncoder().encode('EXISTING-HANDOFF-PREFIX ') })
    await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshot(${quietId}).bufferLines.some((line) => line.includes('EXISTING-HANDOFF-PREFIX'))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the handoff fixture input was not restored: ' +
        JSON.stringify(window.__aitermTest?.snapshot(${quietId}).bufferLines.filter((line) => line.trim()).slice(-4)));
    })()`)

    // The alternate screen keeps its image out of the normal buffer.
    // A known image above the prompt, so the commands typed below it overwrite no image cell.
    await typeIntoAnimatedPane(`clear; cat '${join(animationDirectory, 'frame0.six')}'; printf '\\n%s-%s\\n' ALT BASE\r`)
    await waitForAnimatedLine('ALT-BASE', 10_000)
    const imageLinesBeforeAlternate = await host.applicationWindow.webContents.executeJavaScript(
      `window.__aitermTest.view(${animatedId}).imageCells().lines`) as number[]
    await typeIntoAnimatedPane(`printf '\\033[?1049h'; cat '${join(animationDirectory, 'frame0.six')}'; printf '%s-%s' ALT-SCREEN TEXT; sleep 1.5; printf '\\033[?1049l'; printf '%s-%s\\n' ALT DONE\r`)
    // While the alternate screen is active, its own image and text are what the view shows.
    await waitForAnimatedLine('ALT-SCREEN-TEXT', 10_000)
    const duringAlternate = await host.applicationWindow.webContents.executeJavaScript(
      `window.__aitermTest.view(${animatedId}).imageCells().lines.length`) as number
    await waitForAnimatedLine('ALT-DONE', 10_000)
    const alternate = await host.applicationWindow.webContents.executeJavaScript(`(() => {
      const hook = window.__aitermTest;
      return { lines: hook.snapshot(${animatedId}).bufferLines, imageLines: hook.view(${animatedId}).imageCells().lines };
    })()`) as { lines: string[]; imageLines: number[] }
    const sixelAlternateScreen = {
      imageRowsWhileActive: duringAlternate,
      alternateTextLeftBehind: alternate.lines.some((line) => line.includes('ALT-SCREEN-TEXT')),
      normalImagesKept: JSON.stringify(alternate.imageLines) === JSON.stringify(imageLinesBeforeAlternate)
    }
    if (!(duringAlternate > 0) || sixelAlternateScreen.alternateTextLeftBehind || !sixelAlternateScreen.normalImagesKept) {
      throw new Error(`the alternate screen changed the normal buffer images: ${JSON.stringify(sixelAlternateScreen)}`)
    }


    // Later steps read this pane from its first rows, as a fresh shell leaves it.
    await typeIntoAnimatedPane(typedShell.windows
      ? `Clear-Host; ${printed('ANIMATION-PANE', '-', 'CLEARED')}\r`
      : `clear; printf '%s-%s\\n' ANIMATION-PANE CLEARED\r`)
    await waitForAnimatedLine('ANIMATION-PANE-CLEARED', 10_000)

    const layoutSelectionsBeforeRendererProbe = taps.layoutPutSelections.length
    const incomingAttentionUpdate = attentionBaselineCaptured.then(async () => {
      console.error('[BMN] self-test phase: sending live attention revision')
      const runtime = host.runtimes.get(secondSession.sessionId)
      if (!runtime) throw new Error('the incoming attention fixture runtime was unavailable')
      await client.request(METHOD_REGISTRY.terminalWrite, {
        attachmentId: runtime.attachment.attachmentId,
        bytes: new TextEncoder().encode(
          'bmn ask self-update "Self-test turn revised" --kind notice; ' + (typedShell.windows
            ? `${printed('FILEREF ', 'refs/src/parser.ts:42:7')}; cd refs\r`
            : "printf 'FILEREF %s/%s\\n' refs src/parser.ts:42:7; cd refs\r")
        )
      })
      console.error('[BMN] self-test phase: live attention revision accepted by host')
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const found = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
          .find((request) =>
            request.requestKey === 'self-update' &&
            request.kind === 'notice' &&
            request.title === 'Self-test turn revised')
        const markerPrinted = await host.applicationWindow!.webContents.executeJavaScript(
          `window.__aitermTest?.snapshot(${JSON.stringify(secondSession.sessionId)}).bufferLines
            .some((line) => line.includes('FILEREF refs/src/parser.ts:42:7'))`
        ) as boolean
        if (found && markerPrinted) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          console.error('[BMN] self-test phase: live attention revision observed')
          return found
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the incoming attention update did not reach the utility owner')
    })
    const [preloadProbe] = await Promise.all([
      waitForRendererIntegration(host.applicationWindow),
      incomingAttentionUpdate
    ])
    if (
      preloadProbe.bridgeErrorCodes.staleLayoutPut !== ERROR_CODES.revisionConflict ||
      preloadProbe.bridgeErrorCodes.unknownSessionSavedOutput !== ERROR_CODES.notFound
    ) {
      throw new Error(
        `typed bridge errors did not survive the contextBridge: ${JSON.stringify(preloadProbe.bridgeErrorCodes)}`
      )
    }
    if (
      preloadProbe.attentionTriage.totalCount !== 4 ||
      JSON.stringify(preloadProbe.attentionTriage.responseTitles) !== JSON.stringify(expectedResponseTitles) ||
      JSON.stringify(preloadProbe.attentionTriage.responseTitlesAfterUpdate) !==
        JSON.stringify(expectedResponseTitles) ||
      JSON.stringify(preloadProbe.attentionTriage.remainingResponseTitles) !==
        JSON.stringify(expectedResponseTitles.filter(title => title !== 'Choose the self-test answer').toSorted()) ||
      JSON.stringify(preloadProbe.attentionTriage.updateTitles) !== JSON.stringify(['Self-test turn finished']) ||
      JSON.stringify(preloadProbe.attentionTriage.updatedUpdateTitles) !== JSON.stringify(['Self-test turn revised']) ||
      !preloadProbe.attentionTriage.progressText.includes('Observed self-test failure') ||
      !preloadProbe.attentionTriage.progressText.includes('Last observed failed') ||
      !preloadProbe.attentionTriage.progressText.includes('stale') ||
      !preloadProbe.attentionTriage.detailsProgressText.includes('Observed self-test failure') ||
      !preloadProbe.attentionTriage.detailsProgressText.includes('Last observed failed') ||
      !preloadProbe.attentionTriage.detailsProgressText.includes('stale') ||
      // From the permission's own session, Ctrl+Shift+U stays in the top tier and moves to the question's session.
      preloadProbe.attentionTriage.keyboardTargetSessionId !== session.sessionId ||
      !/^\d+ (s|min) ago · expires in (9|10) min$/.test(preloadProbe.attentionTriage.firstResponseRow.age) ||
      !preloadProbe.attentionTriage.firstResponseRow.label.startsWith('Permission · Allow the self-test action · ') ||
      !/ · expires in (9|10) min$/.test(preloadProbe.attentionTriage.firstResponseRow.label) ||
      !preloadProbe.attentionTriage.noticeResolved ||
      !preloadProbe.attentionTriage.focusReturned ||
      !preloadProbe.attentionTriage.focusStableAfterIncomingUpdate
    ) {
      throw new Error(
        `the renderer did not preserve attention triage semantics: ${JSON.stringify(preloadProbe.attentionTriage)}`
      )
    }
    if (
      typeof preloadProbe.handoffFlow.draftId !== 'string' ||
      preloadProbe.handoffFlow.targetSessionId !== session.sessionId ||
      preloadProbe.handoffFlow.editedText !== HANDOFF_OUTLINE.replace('Goal:', 'Goal: Edited handoff line one\nQuestion line two') ||
      Object.values(preloadProbe.handoffFlow.outline ?? {}).length !== 8 ||
      Object.values(preloadProbe.handoffFlow.outline ?? {}).some((value) => value !== true) ||
      preloadProbe.handoffFlow.fileName !== handoffArtifact.originalName ||
      preloadProbe.handoffFlow.acceptedState !== 'accepted' ||
      !preloadProbe.handoffFlow.existingInputPreserved ||
      preloadProbe.handoffFlow.payloadOccurrences !== 1 ||
      !preloadProbe.handoffFlow.attentionResponsesPreserved ||
      !preloadProbe.handoffFlow.discardedDraftHidden
    ) {
      throw new Error(`the renderer did not complete the explicit handoff flow: ${JSON.stringify(preloadProbe.handoffFlow)}`)
    }
    const fileReferenceFlow = preloadProbe.fileReferenceFlow
    const referencedFile = realpathSync(join(fileReferenceRoot, 'src', 'parser.ts'))
    // Only explicit opens read: palette, launch-directory miss, chosen folder, rejected expansion, Ctrl+click, the
    // macOS-order Ctrl+click (once, though both its context menu and its release could open it), the reference
    // printed over a redrawn link, the missing session and the other workspace's pane. Hovers, clicks and drags add
    // nothing.
    const expectedFileReferenceReads = [
      'refs/src/parser.ts:42:7',
      'src/parser.ts',
      'src/parser.ts',
      '$HOME/notes.txt',
      'refs/src/parser.ts:42:7',
      'refs/src/parser.ts:42:7',
      'refs/src/parser.ts:7',
      'refs/src/parser.ts:42:7',
      'refs/src/parser.ts:42:7',
      'refs/src/parser.ts:42:7',
      'refs/src/parser.ts:42:7',
      referencedFile,
      referencedFile,
      '"' + join(searchRoot, 'a:b.ts') + '"'
    ]
    if (
      !fileReferenceFlow.palette.focusedInput ||
      fileReferenceFlow.palette.base !== realpathSync(isolatedCwd) && fileReferenceFlow.palette.base !== isolatedCwd ||
      fileReferenceFlow.palette.file !== referencedFile ||
      fileReferenceFlow.palette.marked !== 'FILE-REFERENCE-TARGET line 42' ||
      !fileReferenceFlow.palette.position.startsWith('Line 42, column 7 of 60 lines') ||
      fileReferenceFlow.palette.copied !== `${referencedFile}:42:7` ||
      fileReferenceFlow.palette.shownFeedback !== 'Shown in the file manager.' ||
      JSON.stringify(taps.shownFileReferences) !== JSON.stringify([referencedFile]) ||
      !fileReferenceFlow.palette.focusReturned ||
      fileReferenceFlow.shellDirectoryIgnored.message !== 'No file exists at this path.' ||
      fileReferenceFlow.shellDirectoryIgnored.file !== join(fileReferenceFlow.launchDirectory, 'src', 'parser.ts') ||
      !fileReferenceFlow.chosenFolder.pickerMessage.includes('File dialogs are unavailable') ||
      fileReferenceFlow.chosenFolder.kind !== 'chosen-directory' ||
      fileReferenceFlow.chosenFolder.canonicalPath !== referencedFile ||
      fileReferenceFlow.rejected.message !== 'Shell variables are not expanded; enter the full path.' ||
      !fileReferenceFlow.rejected.inputPreserved ||
      fileReferenceFlow.link.reference !== 'refs/src/parser.ts:42:7' ||
      !fileReferenceFlow.link.session.startsWith('Same CLI chat B · ') ||
      fileReferenceFlow.link.marked !== 'FILE-REFERENCE-TARGET line 42' ||
      !fileReferenceFlow.link.selectedElsewhere ||
      !fileReferenceFlow.link.underlinedWithCtrl ||
      !fileReferenceFlow.link.focusReturned ||
      fileReferenceFlow.contextMenuClick.reference !== 'refs/src/parser.ts:42:7' ||
      !fileReferenceFlow.contextMenuClick.focusReturned ||
      fileReferenceFlow.plainClick.underlined ||
      fileReferenceFlow.plainClick.opened ||
      fileReferenceFlow.ctrlDrag.selected.length < 3 ||
      !'refs/src/parser.ts:42:7'.startsWith(fileReferenceFlow.ctrlDrag.selected) ||
      !fileReferenceFlow.ctrlDrag.copiedSelection ||
      fileReferenceFlow.ctrlDrag.opened ||
      fileReferenceFlow.missingSessionCode !== ERROR_CODES.notFound ||
      fileReferenceFlow.mouseMode.underlined ||
      fileReferenceFlow.mouseMode.opened ||
      fileReferenceFlow.mouseMode.reportsToProgram < 1 ||
      fileReferenceFlow.mouseMode.dragReportsToProgram < 1 ||
      !fileReferenceFlow.mouseMode.copiedSelection ||
      !fileReferenceFlow.mouseMode.rightClickPasted ||
      fileReferenceFlow.crossWorkspace?.session !== 'Archived running chat · Self-test archived workspace' ||
      fileReferenceFlow.crossWorkspace.base !== fileReferenceFlow.palette.base ||
      fileReferenceFlow.crossWorkspace.file !== referencedFile ||
      fileReferenceFlow.crossWorkspace.marked !== 'FILE-REFERENCE-TARGET line 42' ||
      !fileReferenceFlow.redraw.underlinedBefore ||
      fileReferenceFlow.redraw.staleOpened ||
      fileReferenceFlow.redraw.staleUnderlined ||
      fileReferenceFlow.redraw.reference !== 'refs/src/parser.ts:7' ||
      fileReferenceFlow.redraw.marked !== 'line 7' ||
      fileReferenceFlow.redraw.ptyInputEvents !== 0 ||
      JSON.stringify(taps.readFileReferences.map((read) => read.reference)) !==
        JSON.stringify(expectedFileReferenceReads) ||
      taps.readFileReferences.at(-1)?.sessionId !== secondSession.sessionId ||
      !fileReferenceFlow.epic27?.chooserDefaultEmpty ||
      !fileReferenceFlow.epic27.chooserCrossWorkspace ||
      fileReferenceFlow.epic27.previewPayload !== `${referencedFile}:42:7` ||
      !fileReferenceFlow.epic27.previewTarget.includes('Same CLI chat B') ||
      !fileReferenceFlow.epic27.previewTarget.includes('without pressing Enter') ||
      fileReferenceFlow.epic27.previewIncarnation !== secondSession.incarnationId ||
      !fileReferenceFlow.epic27.pastedFeedback.includes('not submitted') ||
      !fileReferenceFlow.epic27.pastedIntoTarget ||
      !fileReferenceFlow.epic27.focusLossClearedTarget ||
      !fileReferenceFlow.epic27.searchCapLabel.includes('Showing first 50') ||
      fileReferenceFlow.epic27.searchRows !== 50 ||
      !fileReferenceFlow.epic27.skippedRowsAbsent ||
      !fileReferenceFlow.epic27.supersededRowsAbsent ||
      !fileReferenceFlow.epic27.openedFromSession.includes('Same CLI chat B') ||
      fileReferenceFlow.epic27.openedFile !== referencedFile ||
      !fileReferenceFlow.epic27.foreignSearchSession.includes('Archived running chat') ||
      fileReferenceFlow.epic27.foreignSearchFile !== referencedFile ||
      fileReferenceFlow.epic27.colonFile !== join(searchRoot, fixtureNames.representable) ||
      !fileReferenceFlow.epic27.numericSuffixRejected ||
      fileReferenceFlow.ptyInputEvents !== 0 ||
      !fileReferenceFlow.terminalUnchanged ||
      !fileReferenceFlow.attentionUnchanged
    ) {
      throw new Error(`the renderer did not complete the file-reference flow: ${JSON.stringify({
        ...fileReferenceFlow,
        shownPaths: taps.shownFileReferences,
        reads: taps.readFileReferences,
        expectedFile: referencedFile
      })}`)
    }
    const voiceFlow = preloadProbe.voiceFlow
    const expectedTranscriptions = [
      voiceFlow.approvedAfterRemove,
      [...voiceFlow.approvedAfterRemove, 'Changed'],
      [...voiceFlow.approvedAfterRemove, 'Changed']
    ]
    if (
      !voiceFlow.suggested.includes('SessionManager') ||
      !voiceFlow.suggested.includes('pty_host') ||
      !voiceFlow.suggested.includes('Personal') ||
      !voiceFlow.suggested.includes('parser.ts') ||
      voiceFlow.suggested.some((word) => /^\d/u.test(word)) ||
      voiceFlow.editedApproved !== 'pty-host' ||
      !voiceFlow.chipsShareLine ||
      !voiceFlow.addWordRejected.message.includes('commas') ||
      !voiceFlow.addWordRejected.inputPreserved ||
      !voiceFlow.addWordRejected.listUnchanged ||
      !voiceFlow.duplicateRejected.message.includes('already in the list') ||
      !voiceFlow.duplicateRejected.candidateKept ||
      JSON.stringify(voiceFlow.approvedAfterRemove) !== JSON.stringify(['SessionManager', 'BMN']) ||
      voiceFlow.promptShown !== 'SessionManager, BMN' ||
      !voiceFlow.persistedInSettings ||
      !voiceFlow.recording.pastedOnce ||
      !voiceFlow.recording.commandNotRun ||
      !voiceFlow.recording.announced.includes('Transcript pasted') ||
      voiceFlow.fallback.modelChosenBefore !== 'small' ||
      voiceFlow.fallback.modelAfter !== 'base' ||
      !voiceFlow.fallback.vocabularyKept ||
      voiceFlow.fallback.modelAfterApproval !== 'base' ||
      !voiceFlow.editDuringRecording.savedWhileRecording ||
      !voiceFlow.editDuringRecording.secondPastedOnce ||
      !voiceFlow.restarted.notice.includes('nothing was pasted') ||
      voiceFlow.restarted.pastedIntoNewIncarnation ||
      !voiceFlow.noLiveSessionMessage.includes('Select a running session') ||
      !voiceFlow.download.firstStarted ||
      !voiceFlow.download.duplicateRefused ||
      !voiceFlow.download.progressShown ||
      !voiceFlow.download.cancelledReleased ||
      !voiceFlow.download.failureText.includes('connection reset') ||
      !voiceFlow.download.retryRefusedWhileErrorVisible ||
      !voiceFlow.download.dismissVisible ||
      !voiceFlow.download.dismissed ||
      !voiceFlow.download.dismissStayedDismissed ||
      !voiceFlow.download.modelRestored ||
      // Exactly two transfers were attempted: one held open and cancelled, one refused connection. The
      // refused duplicate and the pre-transfer paths never reach fetch.
      taps.voiceFetchCalls !== 2 ||
      taps.voiceTranscriptions.length !== 3 ||
      taps.voiceTranscriptions.some((run, index) =>
        JSON.stringify(run.vocabulary) !== JSON.stringify(expectedTranscriptions[index]) ||
        run.durationSeconds < 0.3 ||
        run.args.indexOf('--prompt') !== run.args.length - 2 ||
        run.args.at(-1) !== run.vocabulary.join(', ') ||
        run.args.filter((argument) => argument === '--prompt').length !== 1 ||
        run.args.includes('--carry-initial-prompt')) ||
      taps.voiceTranscriptions[0]!.args.at(-1) !== voiceFlow.promptShown
    ) {
      throw new Error(`the renderer did not complete the voice flow: ${JSON.stringify({ ...voiceFlow, transcriptions: taps.voiceTranscriptions })}`)
    }
    preloadProbe.attentionTriage.revisedPromptPreserved = revisedPromptPreserved

    const selectedBeforeUnavailableTarget = (await client.request<LayoutGetResult>(
      METHOD_REGISTRY.layoutGet,
      { workspaceId: DEFAULT_WORKSPACE_ID }
    )).layout.selectedSessionId
    host.applicationWindow.webContents.send('aiterm:open-session', '00000000-0000-4000-8000-000000000099')
    const unavailableFeedback = await host.applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const probe = () => {
          const text = document.querySelector('.feedback-notice')?.textContent?.trim() ?? '';
          if (text === 'That session is unavailable. Refreshing attention items.') resolve(text);
          else if (Date.now() >= deadline) reject(new Error('unavailable target feedback was not rendered: ' + text));
          else setTimeout(probe, 25);
        };
        probe();
      })
    `) as string
    const selectedAfterUnavailableTarget = (await client.request<LayoutGetResult>(
      METHOD_REGISTRY.layoutGet,
      { workspaceId: DEFAULT_WORKSPACE_ID }
    )).layout.selectedSessionId
    preloadProbe.attentionTriage.unavailableTargetIgnored =
      unavailableFeedback.length > 0 && selectedAfterUnavailableTarget === selectedBeforeUnavailableTarget
    if (!preloadProbe.attentionTriage.unavailableTargetIgnored) {
      throw new Error('opening an unavailable session changed the selection or said nothing')
    }
    if (
      preloadProbe.launchUnavailable.sessionId !== secondSession.sessionId ||
      preloadProbe.launchUnavailable.notice !==
        `Launch unavailable: ${SELF_TEST_LAUNCH_DISABLED_REASON}` ||
      preloadProbe.launchUnavailable.resumeDisabled !== true ||
      preloadProbe.launchUnavailable.resumeTitle !== SELF_TEST_LAUNCH_DISABLED_REASON
    ) {
      throw new Error(
        `the renderer did not block Resume with its stored reason: ${JSON.stringify(preloadProbe.launchUnavailable)}`
      )
    }
    if (
      preloadProbe.unavailableTemplate.name !== 'Unavailable launch template — unavailable' ||
      preloadProbe.unavailableTemplate.disabled !== true ||
      preloadProbe.unavailableTemplate.title !== SELF_TEST_LAUNCH_DISABLED_REASON
    ) {
      throw new Error(
        `the renderer did not disable the unavailable template: ${JSON.stringify(preloadProbe.unavailableTemplate)}`
      )
    }
    if (
      preloadProbe.templateCreatedSession.name !== rendererTemplate.name ||
      preloadProbe.templateCreatedSession.executable !== rendererTemplate.executable ||
      JSON.stringify(preloadProbe.templateCreatedSession.argv) !== JSON.stringify(rendererTemplate.argv) ||
      preloadProbe.templateCreatedSession.cwd !== rendererTemplate.cwd ||
      preloadProbe.templateCreatedSession.backgroundChoice !== rendererTemplate.backgroundChoice
    ) {
      throw new Error(
        `the real renderer template pick created the wrong session: ${JSON.stringify(preloadProbe.templateCreatedSession)}`
      )
    }
    const rendererProbeLayoutSelections = taps.layoutPutSelections.slice(
      layoutSelectionsBeforeRendererProbe
    )
    if (
      preloadProbe.treeSelection.layoutSelectedSessionId !== preloadProbe.treeSelection.sessionId ||
      !rendererProbeLayoutSelections.includes(preloadProbe.treeSelection.sessionId)
    ) {
      throw new Error(
        `the real tree selection did not issue a matching layout.put: ${JSON.stringify({
          probe: preloadProbe.treeSelection,
          puts: rendererProbeLayoutSelections
        })}`
      )
    }
    if (
      preloadProbe.crossWorkspaceSplit.layoutWorkspaceId !== DEFAULT_WORKSPACE_ID ||
      preloadProbe.crossWorkspaceSplit.sourceWorkspaceId !== secondWorkspace.workspaceId ||
      !preloadProbe.crossWorkspaceSplit.paneSessionIds.includes(thirdSession.sessionId) ||
      preloadProbe.crossWorkspaceSplit.selectedAfterFocus !== preloadProbe.treeSelection.sessionId ||
      !preloadProbe.crossWorkspaceSplit.sourceWorkspaceArchiveRefused ||
      !preloadProbe.crossWorkspaceSplit.foreignPaneClosed
    ) {
      throw new Error(
        `the renderer did not keep a cross-workspace split in the active workspace: ${JSON.stringify(
          preloadProbe.crossWorkspaceSplit
        )}`
      )
    }
    const archivedWorkspace = (await client.request<WorkspaceRecord[]>(METHOD_REGISTRY.workspaceList, {
      includeArchived: true
    })).find((workspace) => workspace.workspaceId === secondWorkspace.workspaceId)
    if (!archivedWorkspace) throw new Error('the renderer archive action removed its workspace record')
    // Epic 11 AC1-AC4: a marker chosen from a workspace's own menu reaches only that workspace's rows
    // and panes, is stored with one revision bump, and moves no terminal geometry.
    const markers = preloadProbe.workspaceMarkers
    if (
      markers.before.localPane !== null ||
      markers.before.foreignPane !== null ||
      markers.foreignPaneAfterLocalChoice !== null ||
      markers.localPane !== 'teal' ||
      markers.foreignPane !== 'rose' ||
      markers.localSidebar !== 'teal' ||
      markers.foreignSidebar !== 'rose' ||
      markers.foreignPaneLabel !== `${secondWorkspace.name} workspace · Rose marker` ||
      markers.storedRevisions.local !== 1 ||
      markers.storedRevisions.foreign !== 1
    ) {
      throw new Error(
        `workspace markers did not follow their own workspace: ${JSON.stringify(markers)}`
      )
    }
    if (
      markers.grid.cols !== markers.before.grid.cols ||
      markers.grid.rows !== markers.before.grid.rows ||
      markers.localHeading !== markers.before.localHeading ||
      markers.foreignHeading !== markers.before.foreignHeading ||
      markers.before.localHeading <= 0
    ) {
      throw new Error(
        `choosing a workspace marker moved the pane geometry: ${JSON.stringify(markers)}`
      )
    }
    // Epic 12.2 AC1-AC4: the words are the reporter's, the detail opens both ways, and opening it
    // writes nothing to the PTY and leaves the terminal exactly the size it was.
    const evidenceSurface = preloadProbe.progressEvidenceSurface
    if (
      !evidenceSurface.reportedStrip.includes('Reported verified') ||
      !evidenceSurface.reportedStrip.includes('Evidence attached (1)') ||
      evidenceSurface.reportedStrip.includes('Verified ·') ||
      !evidenceSurface.bareStrip.includes('No evidence attached') ||
      !evidenceSurface.bareStrip.includes('Last observed failed') ||
      !evidenceSurface.dialog.title.startsWith('Progress — ') ||
      !evidenceSurface.dialog.note.includes('it does not check the work') ||
      !evidenceSurface.dialog.provenance.startsWith('Reported verified · from evidence · ') ||
      evidenceSurface.dialog.rowName !== 'checks.log' ||
      !evidenceSurface.dialog.rowAvailability.startsWith('text/plain · ') ||
      !evidenceSurface.dialog.previewText.includes('self-test: 3 checks passed') ||
      !evidenceSurface.focusReturnedToStrip ||
      !evidenceSurface.focusReturnedToMenuButton ||
      !evidenceSurface.openedFromPaneMenu ||
      !evidenceSurface.bareDialog.body.includes('No evidence attached to this report.')
    ) {
      throw new Error(`the progress detail did not read honestly: ${JSON.stringify(evidenceSurface)}`)
    }
    // Epic 5's four states must stay legible now that the word is a button, and the evidence word
    // must stay muted: no colour may endorse a claim.
    const inks = evidenceSurface.colours
    if (
      inks.verifiedInk !== inks.verifiedToken ||
      inks.failedInk !== inks.errorToken ||
      inks.evidenceInk !== inks.mutedToken ||
      inks.evidenceInk === inks.verifiedToken ||
      inks.verifiedContrast < 4.5 ||
      inks.evidenceContrast < 4.5
    ) {
      throw new Error(`the strip state button lost its palette: ${JSON.stringify(inks)}`)
    }
    const quiet = evidenceSurface.quiet
    if (
      quiet.inputEventsAfter !== quiet.inputEventsBefore ||
      quiet.surfaceHeightWhileOpen !== quiet.surfaceHeightBefore ||
      quiet.surfaceHeightAfter !== quiet.surfaceHeightBefore ||
      quiet.surfaceHeightBefore <= 0 ||
      quiet.gridAfter.cols !== quiet.gridBefore.cols ||
      quiet.gridAfter.rows !== quiet.gridBefore.rows
    ) {
      throw new Error(`opening the progress detail disturbed the terminal: ${JSON.stringify(quiet)}`)
    }
    // Epic 12.1 AC1-AC2 through the real CLI: one accepted report and four refusals, all or nothing.
    if (
      !progressEvidence?.sameIdOnRetry ||
      progressEvidence.state !== 'verified' ||
      progressEvidence.links.length !== 1 ||
      progressEvidence.links[0]?.artifactId !== progressEvidence.artifactId ||
      progressEvidence.links[0]?.name !== 'checks.log' ||
      JSON.stringify(progressEvidence.outcome) !== JSON.stringify([
        'accepted', 'refused-other-session', 'refused-input', 'refused-unknown', 'refused-duplicate', 'done'
      ])
    ) {
      throw new Error(`the evidence CLI contract did not hold: ${JSON.stringify(progressEvidence)}`)
    }
    // AC1 again, at the inspector: every strip site says whether anything backs the word.
    if (!preloadProbe.attentionTriage.detailsProgressText.includes('No evidence attached')) {
      throw new Error(
        `the inspector strip kept the old word: ${preloadProbe.attentionTriage.detailsProgressText}`
      )
    }
    if (archivedWorkspace.marker !== 'rose') {
      throw new Error(
        `archiving a workspace dropped its marker: ${JSON.stringify(archivedWorkspace)}`
      )
    }
    const { shown, hidden } = preloadProbe.hiddenPaneSize
    if (shown.cols < 20 || hidden.cols !== shown.cols || hidden.rows !== shown.rows) {
      throw new Error(
        `a hidden pane resized its terminal: ${JSON.stringify(preloadProbe.hiddenPaneSize)}`
      )
    }
    const templateRuntime = host.runtimes.get(preloadProbe.templateCreatedSession.sessionId)
    const applicationQuitTarget = templateRuntime
      ? runningTargetForRuntime({
          ...templateRuntime.session,
          executable: templateRuntime.executable,
          processState: templateRuntime.processState,
          ...(templateRuntime.backgroundChoice
            ? { backgroundChoice: templateRuntime.backgroundChoice }
            : {})
        })
      : undefined
    if (!applicationQuitTarget) throw new Error('the template-created session was not live')
    await host.stopCurrentTargets([applicationQuitTarget], 'application-quit')
    const defaultSessionsAfterLifecycleStop = await client.request<SessionRecord[]>(
      METHOD_REGISTRY.sessionList,
      { workspaceId: DEFAULT_WORKSPACE_ID }
    )
    const lifecycleStoppedBeforeRestart = defaultSessionsAfterLifecycleStop.find(
      (record) => record.sessionId === preloadProbe.templateCreatedSession.sessionId
    )?.lastProcess
    if (
      lifecycleStoppedBeforeRestart?.state !== 'interrupted' ||
      !lifecycleStoppedBeforeRestart.detail?.startsWith('application quit · signal ')
    ) {
      throw new Error(
        `application-quit stop was not recorded as interrupted: ${JSON.stringify(lifecycleStoppedBeforeRestart)}`
      )
    }
    // Epic 26.2: the quit row's saved-output column is not claimed here — driving the real
    // beforeQuit would quit the app mid-test, so the flush-before-stop order for the quit cause
    // rests on the lifecycle unit tests (host-loss.test.ts, flush before beforeQuit's stop) and on
    // the same captureThen the close and explicit endings exercise in this run through the real
    // lifecycle.
    /**
     * Epic 17.1 AC2: this stop is mid-run, which only a self-test can arrange, so the offer is
     * recorded as made here. What the renderer restart below then proves is the rule itself: a
     * cohort BMN has already asked about never asks again by itself.
     */
    const quitCohortBeforeRestart = await client.request<InterruptedSessionCohort | null>(
      METHOD_REGISTRY.sessionCohortList,
      {}
    )
    if (quitCohortBeforeRestart?.cause !== 'application-quit') {
      throw new Error(
        `the application-quit stop did not form a resumable cohort: ${JSON.stringify(quitCohortBeforeRestart)}`
      )
    }
    const quitCohortOffer = await client.request<SessionCohortOfferedResult>(
      METHOD_REGISTRY.sessionCohortOffered,
      { cohortId: quitCohortBeforeRestart.cohortId }
    )

    console.error('[BMN] self-test phase: inactive workspace following output')
    const inactiveAttachmentId = host.runtimes.get(thirdSession.sessionId)?.attachment.attachmentId
    if (!inactiveAttachmentId) throw new Error('the inactive workspace session has no renderer attachment')
    const inactiveMarker = 'AITERM-2-1-INACTIVE-FOLLOWING-DONE'
    const inactiveSavedOutput = (): Promise<SavedOutputCatalog> =>
      client.request<SavedOutputCatalog>(METHOD_REGISTRY.terminalSavedOutputGet, { sessionId: thirdSession.sessionId })
    const withinPhase = <Value,>(step: string, pending: Promise<Value>): Promise<Value> => Promise.race([
      pending,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`inactive workspace output step timed out: ${step}`)), 5_000))
    ])
    const rendererPause = (milliseconds: number): Promise<unknown> => withinPhase(
      'renderer pause',
      host.applicationWindow!.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, ${milliseconds}))`)
    )
    await rendererPause(400)
    const inactiveCaptureBefore = (await withinPhase('saved output before', inactiveSavedOutput())).current?.capturedAt ?? null
    const layoutPutsBeforeOutput = taps.layoutPutRequests
    await withinPhase('type into existing attachment', host.applicationWindow.webContents.executeJavaScript(`
      window.aiTerminal.sendTerminalInput(
        ${JSON.stringify(inactiveAttachmentId)},
        new TextEncoder().encode(${JSON.stringify(typedShell.windows
          ? `1..80 | ForEach-Object { "inactive-following-output-$_" }; ${printed('AITERM-2-1-', 'INACTIVE-FOLLOWING-DONE')}\r`
          : "for line in $(seq 1 80); do echo \"inactive-following-output-$line\"; done; printf 'AITERM-2-1-%s\\n' INACTIVE-FOLLOWING-DONE\r"
        )})
      );
      true;
    `))
    console.error('[BMN] self-test phase: inactive workspace output requested')
    const captureDeadline = Date.now() + 10_000
    let inactiveFollowingOutputCaptured = false
    while (!inactiveFollowingOutputCaptured && Date.now() < captureDeadline) {
      const current = (await withinPhase('saved output get', inactiveSavedOutput())).current
      inactiveFollowingOutputCaptured = current !== undefined &&
        current.capturedAt !== inactiveCaptureBefore &&
        current.content.replace(/\s+/g, '').includes(inactiveMarker)
      if (!inactiveFollowingOutputCaptured) await rendererPause(100)
    }
    if (!inactiveFollowingOutputCaptured) {
      throw new Error('output streamed to the inactive workspace session did not advance its saved output capture')
    }
    console.error('[BMN] self-test phase: inactive workspace output captured')
    await rendererPause(500)
    const inactiveFollowingOutputLayoutPuts = taps.layoutPutRequests - layoutPutsBeforeOutput
    console.error(`[BMN] self-test phase: inactive workspace output layout puts ${inactiveFollowingOutputLayoutPuts}`)
    if (inactiveFollowingOutputLayoutPuts !== 0) {
      throw new Error(
        `output to a following session of an inactive workspace issued ${inactiveFollowingOutputLayoutPuts} layout.put request(s)`
      )
    }
    const showArchivedReachable = await host.applicationWindow.webContents.executeJavaScript(
      "document.body.innerText.includes('Show archived')"
    ) as boolean
    console.error('[BMN] self-test phase: agent handoff and OpenCode acceptance')
    const acceptanceWait = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const value = await read()
        if (value !== undefined) return value
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`acceptance timed out: ${label}`)
    }
    const acceptanceWindow = host.applicationWindow
    if (!acceptanceWindow) throw new Error('the acceptance window is unavailable')
    const inspectHarnessObservation = async (
      sessionId: string, sessionName: string, agentName: string, eventName: string,
      recover = true
    ): Promise<{ observed: boolean; openedEvents: boolean; ptyInputUnchanged: boolean; attentionUnchanged: boolean }> => {
      if (recover) await host.recoverApplicationRenderer(acceptanceWindow)
      return acceptanceWindow.webContents.executeJavaScript(`(async () => {
        const wait = async (read, name) => { const end = Date.now() + 10000; while (Date.now() < end) {
          const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
        } throw new Error('harness observation timed out: ' + name); };
        const sessionId = ${JSON.stringify(sessionId)};
        const beforeRequests = (await window.aiTerminal.listAttention()).length;
        (await wait(() => document.querySelector('[aria-label="Actions for ${sessionName}"]'), 'session menu')).click();
        (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
          .find(row => row.textContent.trim() === 'Session details'), 'details action')).click();
        const view = await wait(() => {
          const current = document.querySelector('.session-inspector .hook-observation');
          return current?.textContent.includes('Observed by BMN') ? current : null;
        }, 'observed summary');
        const observed = view.textContent.includes(${JSON.stringify(agentName)}) &&
          view.textContent.includes(${JSON.stringify(eventName)}) &&
          view.textContent.includes(${JSON.stringify(sessionName)}) && view.textContent.includes('run ');
        const beforeInput = window.__aitermTest.snapshots()[sessionId]?.inputEvents ?? 0;
        (await wait(() => [...view.querySelectorAll('button')]
          .find(button => button.textContent === 'Open Hook events'), 'Hook events link')).click();
        const dialog = await wait(() => document.querySelector('dialog.hook-events-dialog[open]'), 'Hook events dialog');
        const openedEvents = await wait(() =>
          dialog.textContent.includes(${JSON.stringify(eventName)}) ? true : undefined, 'the events to render');
        dialog.querySelector('.app-dialog-heading button').click();
        await wait(() => !document.querySelector('dialog.hook-events-dialog') ? true : null, 'Hook events close');
        document.querySelector('.session-inspector .panel-heading button')?.click();
        await wait(() => !document.querySelector('.session-inspector') ? true : null, 'Session details close');
        return { observed, openedEvents, ptyInputUnchanged:
            (window.__aitermTest.snapshots()[sessionId]?.inputEvents ?? 0) === beforeInput,
          attentionUnchanged: (await window.aiTerminal.listAttention()).length === beforeRequests };
      })()`) as Promise<{ observed: boolean; openedEvents: boolean; ptyInputUnchanged: boolean; attentionUnchanged: boolean }>
    }
    const destinationHarness = writeTerminalModeProgram(join(isolatedCwd, 'petition-destination'))
    const petitionDestination = await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Petition destination', cwd: isolatedCwd, executable: destinationHarness.executable,
      argv: [], cols: 80, rows: 24 }, true)
    const petitionDirectory = join(isolatedCwd, 'petition-source')
    const petitionText = 'Synthetic agent handoff result'
    const petitionExecutable = writeAcceptanceHarness(petitionDirectory, 'petition', [
      "writeFileSync(file('petition-result.txt'), 'Published by the petition source\\n')",
      "const published = JSON.parse(cli(['publish', file('petition-result.txt'), '--key', 'electron-petition-file', '--json']))",
      "writeFileSync(file('published.json'), JSON.stringify(published))",
      `writeFileSync(file('prepared.json'), cli(['handoff', ${JSON.stringify(petitionDestination.session.sessionId)}, '--text', ${JSON.stringify(petitionText)}, '--file-id', published.artifactId, '--key', 'electron-petition', '--json']))`,
      "await wait('status-gate')",
      "writeFileSync(file('status.txt'), cli(['handoff', 'status']))",
      "writeFileSync(file('snapshot.json'), cli(['snapshot', '--json']))"
    ])
    const petitionSource = await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Petition source', cwd: isolatedCwd, executable: petitionExecutable,
      argv: [], cols: 80, rows: 24 }, true)
    await untilFileExists(join(petitionDirectory, 'prepared.json'), 'prepared an agent handoff')
    const petitionPublished = JSON.parse(readFileSync(join(petitionDirectory, 'published.json'), 'utf8')) as { artifactId: string }
    const petitionRequest = await acceptanceWait(async () =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .find(row => row.sessionId === petitionSource.session.sessionId && row.kind === 'handoff' && row.state === 'open'), 'source handoff request')
    await host.recoverApplicationRenderer(host.applicationWindow)
    const beforeResultsInput = terminalModeProgramInput(destinationHarness.input)
    const workspaceResultsUi = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read, name) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('workspace results timed out: ' + name); };
      const refits = () => JSON.stringify(Object.fromEntries(Object.entries(window.__aitermTest.snapshots())
        .map(([id, row]) => [id, row.refits])));
      await wait(() => {
        const snapshots = window.__aitermTest.snapshots();
        return snapshots[${JSON.stringify(petitionSource.session.sessionId)}] &&
          snapshots[${JSON.stringify(petitionDestination.session.sessionId)}] ? true : null;
      }, 'recovered petition panes');
      let settled = false;
      let previous = '';
      let unchangedSince = Date.now();
      const settleDeadline = Date.now() + 10000;
      while (!settled && Date.now() < settleDeadline) {
        const current = refits();
        if (current !== previous) { previous = current; unchangedSince = Date.now(); }
        else if (Date.now() - unchangedSince >= 1000) settled = true;
        if (!settled) await new Promise(r => setTimeout(r, 25));
      }
      if (!settled) throw new Error('recovered terminal layout did not settle before results read');
      const beforeRefits = refits();
      const requestBefore = (await window.aiTerminal.listAttention())
        .find(row => row.requestId === ${JSON.stringify(petitionRequest.requestId)});
      const menuButton = await wait(() => [...document.querySelectorAll('.workspace-group')]
        .find(group => group.textContent.includes('Petition source'))?.querySelector('.row-menu-button'), 'workspace menu');
      const openResults = async () => {
        menuButton.click();
        (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
          .find(row => row.textContent.trim() === 'Review results…'), 'results action')).click();
        return wait(() => {
          const dialog = document.querySelector('dialog.workspace-results-dialog[open]');
          return dialog?.querySelector('.workspace-results-handoffs') ? dialog : null;
        }, 'results dialog');
      };
      let dialog = await openResults();
      const refitsAfterOpen = refits();
      const report = [...dialog.querySelectorAll('.workspace-results-sessions > li > ul > li')]
        .find(row => row.textContent.includes('Self-test checks passed'));
      const reportShown = !!report && report.textContent.includes('Reported verified') &&
        report.textContent.includes('evidence');
      const evidenceShown = !!report && report.textContent.includes('checks.log');
      const handoff = [...dialog.querySelectorAll('.workspace-results-handoffs > li')]
        .find(row => row.textContent.includes('Petition source') && row.textContent.includes('Petition destination'));
      const pendingHandoffShown = !!handoff && handoff.textContent.includes('Saved draft') &&
        handoff.textContent.includes('Prepared by the agent');
      report?.querySelector('button')?.click();
      const progress = await wait(() => document.querySelector('dialog.progress-evidence-dialog[open]'), 'progress details');
      const progressMatches = progress.textContent.includes('Self-test checks passed') &&
        progress.textContent.includes('checks.log');
      progress.querySelector('.app-dialog-heading button').click();
      await wait(() => !document.querySelector('dialog.progress-evidence-dialog') ? true : null, 'progress close');
      const refitsAfterRead = refits();
      if (beforeRefits !== refitsAfterRead) {
        throw new Error('results or progress detail refit after recovery: ' +
          JSON.stringify({ beforeRefits, afterOpen: refitsAfterOpen, refitsAfterRead }));
      }
      dialog = await openResults();
      const review = [...dialog.querySelectorAll('.workspace-results-handoffs > li')]
        .find(row => row.textContent.includes('Petition source') && row.textContent.includes('Petition destination'));
      review?.querySelector('button')?.click();
      const form = await wait(() => document.querySelector('.handoff-form'), 'exact handoff review');
      const exactDraftReviewed = form.querySelector('textarea')?.value === ${JSON.stringify(petitionText)} &&
        form.querySelector('select')?.value === ${JSON.stringify(petitionDestination.session.sessionId)};
      [...form.querySelectorAll('button')].find(b => b.textContent === 'Cancel')?.click();
      document.querySelector('.files-close')?.click();
      const requestAfter = (await window.aiTerminal.listAttention())
        .find(row => row.requestId === ${JSON.stringify(petitionRequest.requestId)});
      return { reportShown: reportShown && progressMatches, evidenceShown, pendingHandoffShown,
        exactDraftReviewed, reminderCleared: requestBefore?.state === 'open' &&
          requestAfter?.state === 'withdrawn' && requestAfter.resolvedBy === 'owner' &&
          requestAfter.resolution === 'Opened in BMN; reminder cleared' };
    })()`) as {
      reportShown: boolean; evidenceShown: boolean; pendingHandoffShown: boolean;
      exactDraftReviewed: boolean; reminderCleared: boolean
    }
    const workspaceResultsAcceptance = {
      ...workspaceResultsUi,
      ptyInputUnchanged: terminalModeProgramInput(destinationHarness.input) === beforeResultsInput
    }
    if (Object.values(workspaceResultsAcceptance).some((value) => value !== true)) {
      throw new Error(`workspace results did not read and review safely: ${JSON.stringify(workspaceResultsAcceptance)}`)
    }
    const beforePetitionPaste = terminalModeProgramInput(destinationHarness.input)
    const petitionEditor = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('petition UI timed out'); };
      const files = await wait(() => document.querySelector('.session-terminal.selected button[title="Files"]') ||
        [...document.querySelectorAll('.session-terminal.selected button')].find(b => b.textContent === 'Files'));
      files.click();
      const saved = await wait(() => [...document.querySelectorAll('.handoff-card')].find(r => r.textContent.includes(${JSON.stringify(petitionText)})));
      [...saved.querySelectorAll('button')].find(b => b.textContent === 'Edit').click();
      const form = await wait(() => document.querySelector('.handoff-form'));
      const result = { destination: form.querySelector('select').value, text: form.querySelector('textarea').value, byline: form.textContent,
        fileListed: form.textContent.includes('petition-result.txt') };
      [...form.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click();
      const card = await wait(() => [...document.querySelectorAll('.handoff-card')].find(r => r.textContent.includes(${JSON.stringify(petitionText)})));
      [...card.querySelectorAll('button')].find(b => b.textContent === 'Open destination').click();
      const paste = await wait(() => [...document.querySelectorAll('.handoff-card button')].find(b => b.textContent === 'Paste handoff' && !b.disabled));
      paste.click(); return result;
    })()`) as { destination: string; text: string; byline: string; fileListed: boolean }
    const petitionResolved = await acceptanceWait(async () =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .find(row => row.requestId === petitionRequest.requestId && row.state !== 'open'), 'owner paste resolution')
    const pastedDraft = await acceptanceWait(async () =>
      (await client.request<InputDraftRecord[]>(METHOD_REGISTRY.draftList, {}))
        .find(row => row.draftId === petitionRequest.requestKey?.slice('handoff:'.length) && row.state === 'accepted'), 'persisted handoff paste');
    const petitionPayload = await acceptanceWait(async () => {
      const input = terminalModeProgramInput(destinationHarness.input).slice(beforePetitionPaste.length)
      return input.includes(petitionText) ? input : undefined
    }, 'destination PTY paste')
    writeFileSync(join(petitionDirectory, 'status-gate'), '')
    await untilFileExists(join(petitionDirectory, 'snapshot.json'), 'read bounded handoff status')
    const petitionSnapshot = JSON.parse(readFileSync(join(petitionDirectory, 'snapshot.json'), 'utf8'))
    const agentHandoff = {
      preparedWithoutDelivery: !beforePetitionPaste.includes(petitionText),
      ...petitionEditor, destinationMatches: petitionEditor.destination === petitionDestination.session.sessionId,
      state: petitionResolved.state, resolvedBy: petitionResolved.resolvedBy, resolution: petitionResolved.resolution,
      payloadOccurrences: petitionPayload.split(petitionText).length - 1,
      agentOwnerStamp: petitionPayload.includes('prepared by the agent, delivered by the owner'),
      publishedFile: petitionEditor.fileListed && petitionPayload.includes('- petition-result.txt: ') &&
        petitionPayload.includes(petitionPublished.artifactId),
      bracketedPaste: petitionPayload.includes('\u001b[200~') && petitionPayload.includes('\u001b[201~'),
      noSubmit: !petitionPayload.includes('\r'),
      status: readFileSync(join(petitionDirectory, 'status.txt'), 'utf8'),
      bounded: petitionSnapshot.handoffs?.length === 1 &&
        JSON.stringify(Object.keys(petitionSnapshot.handoffs[0]).sort()) === JSON.stringify(['destinationSessionId', 'draftId', 'state', 'updatedAt'])
    }
    if (!agentHandoff.preparedWithoutDelivery || !agentHandoff.destinationMatches || agentHandoff.text !== petitionText ||
      !agentHandoff.byline.includes('Prepared by the agent in Petition source') ||
      agentHandoff.resolvedBy !== 'owner' || agentHandoff.state !== 'withdrawn' ||
      pastedDraft.detail !== 'Pasted to terminal — not submitted' ||
      agentHandoff.payloadOccurrences !== 1 || !agentHandoff.agentOwnerStamp || !agentHandoff.publishedFile ||
      !agentHandoff.bracketedPaste || !agentHandoff.noSubmit || !agentHandoff.status.includes('pasted (not submitted)') ||
      !agentHandoff.bounded) {
      throw new Error(`the agent's handoff was not prepared, then pasted by the owner: ${JSON.stringify(agentHandoff)}`)
    }
    // The raw-mode synthetic receiver records the exact PTY bytes for this owner-confirmed file send.
    const beforeFileReferenceWire = terminalModeProgramInput(destinationHarness.input)
    const fileReferenceWireUi = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read, label) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('file reference wire probe: ' + label); };
      const setInput = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true
      }));
      const palette = await wait(() => document.querySelector('.command-palette input'), 'palette');
      setInput(palette, 'Open file reference');
      await wait(() => document.querySelector('#palette-file-reference[aria-selected="true"]'), 'command');
      palette.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const dialog = await wait(() => document.querySelector('dialog.file-reference-dialog[open]'), 'dialog');
      const input = await wait(() => dialog.querySelector('input[aria-label="File reference"]'), 'reference input');
      setInput(input, 'refs/src/parser.ts:42:7');
      input.closest('form').requestSubmit();
      await wait(() => dialog.querySelector('.file-reference-line'), 'file ready');
      const chooser = await wait(() => dialog.querySelector('select[aria-label="Send to session"]'), 'chooser');
      chooser.value = ${JSON.stringify(petitionDestination.session.sessionId)};
      chooser.dispatchEvent(new Event('change', { bubbles: true }));
      const review = await wait(() => [...dialog.querySelectorAll('button')]
        .find(button => button.textContent.trim() === 'Review send…' && !button.disabled), 'review');
      review.click();
      const preview = await wait(() => dialog.querySelector('.file-reference-send-preview'), 'preview');
      const payloadShown = preview.querySelector('pre')?.textContent ?? '';
      const targetShown = preview.textContent ?? '';
      [...preview.querySelectorAll('button')].find(button => button.textContent.trim() === 'Paste reference').click();
      const feedback = await wait(() => {
        const error = dialog.querySelector('[role="alert"]')?.textContent?.trim();
        if (error) throw new Error('paste rejected: ' + error);
        const text = dialog.querySelector('.file-reference-feedback')?.textContent?.trim();
        return text?.includes('not submitted') ? text : null;
      }, 'receipt');
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      return { payloadShown, targetShown, feedback };
    })()`) as { payloadShown: string; targetShown: string; feedback: string }
    const fileReferenceWirePayload = `${referencedFile}:42:7`
    const fileReferenceWireBytes = await acceptanceWait(async () => {
      const input = terminalModeProgramInput(destinationHarness.input).slice(beforeFileReferenceWire.length)
      return input.includes(fileReferenceWirePayload) ? input : undefined
    }, 'file-reference PTY bytes')
    const fileReferenceWire = {
      payloadExact: fileReferenceWireUi.payloadShown === fileReferenceWirePayload,
      targetNamed: fileReferenceWireUi.targetShown.includes('Petition destination') &&
        fileReferenceWireUi.targetShown.includes(petitionDestination.startup.incarnationId),
      receiptShown: fileReferenceWireUi.feedback.includes('not submitted'),
      exactPaste: fileReferenceWireBytes.includes(`\x1b[200~${fileReferenceWirePayload}\x1b[201~`),
      noEnter: !fileReferenceWireBytes.includes('\r'),
      onePaste: fileReferenceWireBytes.split(fileReferenceWirePayload).length - 1 === 1
    }
    if (Object.values(fileReferenceWire).length !== 6 || Object.values(fileReferenceWire).some((value) => value !== true)) {
      throw new Error(`the file-reference wire proof failed: ${JSON.stringify(fileReferenceWire)}`)
    }
    const openCodeDirectory = join(isolatedCwd, 'opencode-acceptance')
    const openCodeReference = 'ses_0123456789abSyntheticTest0'
    const openCodeExecutable = writeAcceptanceHarness(openCodeDirectory, 'opencode', [
      `const sessionID = ${JSON.stringify(openCodeReference)}`,
      "const event = (hook_event_name, props = {}) => cli(['hook', 'opencode'], JSON.stringify({ hook_event_name, sessionID, ...props }))",
      "event('session.created', { info: { id: sessionID } })",
      "event('permission.asked', { permission: 'bash', patterns: ['echo acceptance'] })",
      "writeFileSync(file('opened'), '')",
      "await wait('reply-gate')",
      "event('permission.replied', { reply: 'once' })",
      "event('session.idle')",
      "writeFileSync(file('finished'), '')"
    ])
    const openCodeSession = await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'OpenCode acceptance', cwd: isolatedCwd, executable: openCodeExecutable,
      argv: ['--model', 'fixture/model'], cols: 80, rows: 24 }, true)
    await untilFileExists(join(openCodeDirectory, 'opened'), 'opened OpenCode permission')
    const openCodePermission = await acceptanceWait(async () =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .find(row => row.sessionId === openCodeSession.session.sessionId && row.kind === 'permission' && row.state === 'open'), 'OpenCode permission')
    await host.recoverApplicationRenderer(host.applicationWindow)
    const openCodeProvenance = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('OpenCode provenance UI timed out'); };
      (await wait(() => document.querySelector('.needs-you-button'))).click();
      const row = await wait(() => [...document.querySelectorAll('.attention-item')]
        .find(r => r.textContent.includes('OpenCode asks to bash')));
      const provenance = row.querySelector('.provenance').textContent;
      document.querySelector('.needs-you-button').click();
      return provenance;
    })()`) as string
    writeFileSync(join(openCodeDirectory, 'reply-gate'), '')
    await untilFileExists(join(openCodeDirectory, 'finished'), 'finished OpenCode events')
    const openCodeRequests = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .filter(row => row.sessionId === openCodeSession.session.sessionId)
    const openCodeBinding = await client.request<PersistedConversationBinding>(METHOD_REGISTRY.sessionBindingGet, { sessionId: openCodeSession.session.sessionId })
    const openCodeEvents = await client.request<Array<{ agent: string; event: string; effects: string[] }>>(METHOD_REGISTRY.hookEventsList, { sessionId: openCodeSession.session.sessionId })
    const openCodeObservationUi = await inspectHarnessObservation(
      openCodeSession.session.sessionId, 'OpenCode acceptance', 'OpenCode', 'session.idle', false
    )
    if (Object.values(openCodeObservationUi).some((value) => value !== true)) {
      throw new Error(`OpenCode observation view failed: ${JSON.stringify(openCodeObservationUi)}`)
    }
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: openCodeSession.session.sessionId,
      incarnationId: openCodeSession.session.lastProcess?.incarnationId, cause: 'explicit' })
    const openCodePreview = await client.request<{ command: string }>(METHOD_REGISTRY.sessionResumePreview, { sessionId: openCodeSession.session.sessionId })
    const openCodeResumed = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionResume, { sessionId: openCodeSession.session.sessionId, cols: 80, rows: 24 })
    const openCodeArguments = await untilHarnessRuns(join(openCodeDirectory, 'argv.log'), 2)
    const openCodeAcceptance = {
      provenance: openCodeProvenance,
      openedBy: openCodePermission.openedBy,
      resolvedBy: openCodeRequests.find(row => row.requestId === openCodePermission.requestId)?.resolvedBy,
      permissionState: openCodeRequests.find(row => row.requestId === openCodePermission.requestId)?.state,
      notice: openCodeRequests.some(row => row.kind === 'notice' && row.title === 'OpenCode finished a turn'),
      events: openCodeEvents, binding: openCodeBinding, preview: openCodePreview.command,
      resumedArguments: openCodeArguments[1]
    }
    if (openCodeAcceptance.provenance !== 'from OpenCode permission.asked' ||
      openCodeAcceptance.openedBy !== 'hook:opencode:permission.asked' ||
      openCodeAcceptance.resolvedBy !== 'hook:opencode:permission.replied' || openCodeAcceptance.permissionState !== 'answered' ||
      !openCodeAcceptance.notice || !boundBy(openCodeBinding, 'opencode', openCodeReference) ||
      !openCodeAcceptance.preview.includes('--session ' + openCodeReference) ||
      JSON.stringify(openCodeAcceptance.resumedArguments) !== JSON.stringify(['--session', openCodeReference, '--model', 'fixture/model']) ||
      JSON.stringify(openCodeEvents.map((event) => event.event)) !==
        JSON.stringify(['session.created', 'permission.asked', 'permission.replied', 'session.idle']) ||
      !openCodeEvents.every((event) => event.agent === 'opencode') ||
      !openCodeEvents[1]?.effects.includes('opened') || !openCodeEvents[2]?.effects.includes('answered')) {
      throw new Error(`OpenCode acceptance failed: ${JSON.stringify(openCodeAcceptance)}`)
    }
    for (const stopped of [
      { sessionId: petitionSource.session.sessionId, incarnationId: petitionSource.session.lastProcess?.incarnationId },
      { sessionId: petitionDestination.session.sessionId, incarnationId: petitionDestination.session.lastProcess?.incarnationId },
      { sessionId: openCodeResumed.sessionId, incarnationId: openCodeResumed.incarnationId }
    ]) await client.request(METHOD_REGISTRY.sessionStop, { ...stopped, cause: 'explicit' })

    console.error('[BMN] self-test phase: Cursor terminal agent')
    // Payloads shaped like the recorded ones (utility/test-fixtures/cursor), sent through the real `bmn hook cursor`.
    const cursorChat = 'c741bb07-352f-457b-8e7c-ee00517cd9ff'
    const cursorEvents = [
      `const conversation_id = ${JSON.stringify(cursorChat)}`,
      "const base = { conversation_id, session_id: conversation_id, generation_id: 'gen-1', model: 'default', cursor_version: '2026.09.26-dd393fe', workspace_roots: [process.cwd()], user_email: 'owner@example.com', transcript_path: null }",
      "const event = (hook_event_name, props = {}) => cli(['hook', 'cursor'], JSON.stringify({ ...base, hook_event_name, ...props }))"
    ]
    const cursorDirectory = join(isolatedCwd, 'cursor-acceptance')
    const cursorExecutable = writeAcceptanceHarness(cursorDirectory, 'cursor-agent', [
      ...cursorEvents,
      "if (process.argv.slice(2).some((argument) => argument.startsWith('--resume='))) {",
      "  event('beforeSubmitPrompt', { prompt: 'again' })",
      "  writeFileSync(file('resumed'), '')",
      "  return",
      "}",
      "event('sessionStart', { is_background_agent: false, composer_mode: 'agent' })",
      "event('beforeSubmitPrompt', { prompt: 'hello' })",
      "event('postToolUse', { tool_name: 'Shell', tool_input: { command: 'true' } })",
      "event('stop', { status: 'completed', loop_count: 0 })",
      "writeFileSync(file('finished'), '')"
    ])
    const cursorSession = await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Cursor acceptance', cwd: isolatedCwd, executable: cursorExecutable,
      argv: ['--model', 'fixture-model', '--force'], cols: 80, rows: 24 }, true)
    await untilFileExists(join(cursorDirectory, 'finished'), 'finished Cursor events')
    const cursorNotice = await acceptanceWait(async () =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .find(row => row.sessionId === cursorSession.session.sessionId && row.kind === 'notice' && row.state === 'open'), 'Cursor turn notice')
    await host.recoverApplicationRenderer(host.applicationWindow)
    const cursorNeedsYou = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('Cursor Needs you row timed out'); };
      (await wait(() => document.querySelector('.needs-you-button'))).click();
      const row = await wait(() => [...document.querySelectorAll('.attention-item')]
        .find(r => r.textContent.includes('Cursor finished its turn')));
      const provenance = row.querySelector('.provenance')?.textContent ?? null;
      document.querySelector('.needs-you-button').click();
      return { provenance };
    })()`) as { provenance: string | null }
    const cursorBinding = await client.request<PersistedConversationBinding>(METHOD_REGISTRY.sessionBindingGet, { sessionId: cursorSession.session.sessionId })
    const cursorEventLog = await client.request<Array<{ agent: string; event: string; effects: string[] }>>(METHOD_REGISTRY.hookEventsList, { sessionId: cursorSession.session.sessionId })
    // The owner's way: cursor-agent typed into a shell. The chip says "Shell" until Cursor's own hooks report.
    const cursorShellDirectory = join(isolatedCwd, 'cursor-shell-acceptance')
    const cursorShellHarness = writeAcceptanceHarness(cursorShellDirectory, 'cursor-in-shell', [
      ...cursorEvents,
      "event('sessionStart', { is_background_agent: false, composer_mode: 'agent' })",
      "event('stop', { status: 'completed', loop_count: 0 })",
      "writeFileSync(file('finished'), '')"
    ])
    const cursorShell = await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Cursor in a shell', cwd: isolatedCwd, executable: typedShell.executable,
      argv: shellRunning(cursorShellHarness), cols: 80, rows: 24 }, true)
    await untilFileExists(join(cursorShellDirectory, 'finished'), 'finished shell Cursor events')
    await host.recoverApplicationRenderer(host.applicationWindow)
    const cursorChip = await modelOriginProbe(host.applicationWindow, cursorShell.session.sessionId, 'Cursor in a shell', 'default')
    const cursorShellBinding = await client.request<PersistedConversationBinding>(METHOD_REGISTRY.sessionBindingGet, { sessionId: cursorShell.session.sessionId })
    // Resume reopens the chat Cursor reported; its chat folder lives in the self-test's own home.
    mkdirSync(join(selfTestHistoryRoots()!.home, '.cursor', 'chats', 'self-test-workspace', cursorChat), { recursive: true })
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: cursorSession.session.sessionId,
      incarnationId: cursorSession.session.lastProcess?.incarnationId, cause: 'explicit' })
    const cursorPreview = await client.request<{ command: string; notCarried: string }>(METHOD_REGISTRY.sessionResumePreview, { sessionId: cursorSession.session.sessionId })
    const cursorResumed = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionResume, { sessionId: cursorSession.session.sessionId, cols: 80, rows: 24 })
    const cursorArguments = await untilHarnessRuns(join(cursorDirectory, 'argv.log'), 2)
    await untilFileExists(join(cursorDirectory, 'resumed'), 'the resumed Cursor prompt')
    const cursorAcceptance = {
      notice: cursorNotice.title, openedBy: cursorNotice.openedBy, needsYou: cursorNeedsYou,
      binding: cursorBinding, events: cursorEventLog, chip: cursorChip.rowChip, paneChip: cursorChip.paneChip,
      modelRow: cursorChip.modelRow, shellBinding: cursorShellBinding.status,
      preview: cursorPreview.command, notCarried: cursorPreview.notCarried, resumedArguments: cursorArguments[1]
    }
    if (cursorAcceptance.notice !== 'Cursor finished its turn' || cursorAcceptance.openedBy !== 'hook:cursor:stop' ||
      cursorNeedsYou.provenance !== 'from Cursor stop' || !boundBy(cursorBinding, 'cursor', cursorChat) ||
      JSON.stringify(cursorEventLog.map((event) => event.event)) !==
        JSON.stringify(['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'stop']) ||
      !cursorEventLog.every((event) => event.agent === 'cursor') || !cursorEventLog[3]?.effects.includes('opened') ||
      cursorAcceptance.chip !== 'Cursor' || cursorAcceptance.paneChip !== 'Cursor' || !cursorAcceptance.modelRow?.includes('default') ||
      cursorAcceptance.shellBinding !== 'unsupported' ||
      !cursorAcceptance.preview.endsWith(`cursor-agent --resume=${cursorChat} --model fixture-model`) ||
      cursorAcceptance.notCarried !== '--force' ||
      JSON.stringify(cursorAcceptance.resumedArguments) !== JSON.stringify([`--resume=${cursorChat}`, '--model', 'fixture-model'])) {
      throw new Error(`Cursor acceptance failed: ${JSON.stringify(cursorAcceptance)}`)
    }
    for (const stopped of [
      { sessionId: cursorResumed.sessionId, incarnationId: cursorResumed.incarnationId },
      { sessionId: cursorShell.session.sessionId, incarnationId: cursorShell.session.lastProcess?.incarnationId }
    ]) await client.request(METHOD_REGISTRY.sessionStop, { ...stopped, cause: 'explicit' })

    console.error('[BMN] self-test phase: subagent routing and repeat watch')
    const dormantSidebar = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const button = document.querySelector('button[data-session-id="${petitionDestination.session.sessionId}"]');
      if (!button) throw new Error('dormant sidebar fixture missing');
      button.click();
      // Selection focuses its terminal in a React effect; let that effect finish before this
      // keyboard probe explicitly focuses the sidebar button.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      button.focus();
      const row = button.closest('.session-row');
      const end = Date.now() + 10000;
      while (row.dataset.live !== 'false' || row.querySelector('.unread-mark')) {
        if (Date.now() >= end) throw new Error('dormant row did not settle');
        await new Promise(r => setTimeout(r, 25));
      }
      const sample = document.createElement('span'); sample.style.color = 'var(--muted)'; row.append(sample);
      const muted = getComputedStyle(sample).color; sample.remove();
      return { live: row.dataset.live, colour: getComputedStyle(row.querySelector('.session-name')).color, muted };
    })()`) as { live: string; colour: string; muted: string }
    host.applicationWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 400 })
    host.applicationWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    host.applicationWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    const dormantMenu = await acceptanceWait(async () =>
      await host.applicationWindow!.webContents.executeJavaScript(`(() => {
        const menu = document.querySelector('[aria-label="Actions for Petition destination"]');
        if (document.activeElement !== menu) return undefined;
        return { focused: true, opacity: getComputedStyle(menu).opacity, hovered: menu.closest('.session-row').matches(':hover') };
      })()`) as { focused: boolean; opacity: string; hovered: boolean } | undefined, 'Tab to dormant session actions')
      .catch(async (error: unknown) => {
        const diagnostic = await host.applicationWindow!.webContents.executeJavaScript(`(() => ({
          active: document.activeElement?.outerHTML.slice(0, 260) ?? null,
          menu: document.querySelector('[aria-label="Actions for Petition destination"]')?.outerHTML.slice(0, 260) ?? null,
          button: document.querySelector('button[data-session-id="${petitionDestination.session.sessionId}"]')?.outerHTML.slice(0, 260) ?? null,
          dialogs: [...document.querySelectorAll('dialog[open]')].map(row => row.getAttribute('aria-label')),
          detailsOpen: !!document.querySelector('.session-inspector')
        }))()`)
        throw new Error(`Tab to dormant session actions diagnostic: ${JSON.stringify(diagnostic)}`, { cause: error })
      })
    const quietSidebarAcceptance = { ...dormantSidebar, ...dormantMenu }
    if (quietSidebarAcceptance.live !== 'false' || typeof quietSidebarAcceptance.muted !== 'string' ||
      quietSidebarAcceptance.colour !== quietSidebarAcceptance.muted || !quietSidebarAcceptance.focused ||
      quietSidebarAcceptance.opacity !== '1' || quietSidebarAcceptance.hovered !== false) {
      throw new Error(`a dormant session row was not quiet or its actions not reachable by Tab: ${JSON.stringify(quietSidebarAcceptance)}`)
    }
    const routingWorkspace = await client.request<WorkspaceRecord>(METHOD_REGISTRY.workspaceCreate, {
      name: 'Routing acceptance B', defaultCwd: isolatedCwd, position: 20
    })
    const routingDirectory = join(isolatedCwd, 'routing-acceptance')
    const routingExecutable = writeAcceptanceHarness(routingDirectory, 'opencode', [
      "process.env.BMN_OPENCODE_SESSION_ID = 'ses_main'",
      "const event = (hook_event_name, props = {}) => cli(['hook', 'opencode'], JSON.stringify({ hook_event_name, sessionID: 'ses_main', ...props }))",
      "event('permission.asked', { permission: 'main-tool' })",
      "event('permission.asked', { sessionID: 'ses_child', permission: 'child-tool', patterns: ['child-pattern'] })",
      "event('question.asked', { sessionID: 'ses_child', questions: [{ question: 'Child routing question?' }] })",
      "event('session.status', { status: { type: 'busy' } })",
      "event('permission.asked', { permission: 'main-tool' })",
      "writeFileSync(file('opened'), '')",
      "await wait('reply')",
      "event('permission.replied', { sessionID: 'ses_child', reply: 'once' })",
      "event('question.rejected', { sessionID: 'ses_child' })",
      "event('permission.replied', { reply: 'reject' })",
      "writeFileSync(file('resolved'), '')"
    ])
    const routingSession = await host.createSessionRuntime({ workspaceId: routingWorkspace.workspaceId,
      name: 'Child routing', cwd: isolatedCwd, executable: routingExecutable, argv: [], cols: 80, rows: 24 }, true)
    await untilFileExists(join(routingDirectory, 'opened'), 'child permission and question after parent busy')
    const routingRequests = async () => (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .filter(row => row.sessionId === routingSession.session.sessionId)
    const routingOpened = await routingRequests()
    await host.recoverApplicationRenderer(host.applicationWindow)
    const workspaceAttentionOpened = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('button[data-session-id="${petitionDestination.session.sessionId}"]')?.click();
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        const row = document.querySelector('.workspace-group[aria-label="Routing acceptance B"] .workspace-row');
        if (row?.querySelector('.status-dot.needs-you')) return {
          dot: true, text: row.querySelector('.visually-hidden')?.textContent,
          selectedInA: !!document.querySelector('button[data-session-id="${petitionDestination.session.sessionId}"][aria-current="true"]')
        };
        await new Promise(r => setTimeout(r, 25));
      } throw new Error('workspace B attention dot missing');
    })()`) as { dot: boolean; text: string; selectedInA: boolean }
    writeFileSync(join(routingDirectory, 'reply'), '')
    await untilFileExists(join(routingDirectory, 'resolved'), 'matching child replies')
    const routingResolved = await routingRequests()
    const workspaceAttentionCleared = await acceptanceWait(async () =>
      await host.applicationWindow!.webContents.executeJavaScript(`(() => {
        const row = document.querySelector('.workspace-group[aria-label="Routing acceptance B"] .workspace-row');
        return row && !row.querySelector('.status-dot.needs-you') && !row.querySelector('.visually-hidden') ? true : undefined;
      })()`) as true | undefined, 'workspace B attention cleared')
    const subagentAcceptance = {
      open: routingOpened.map(({ requestKey, kind, title, body, state }) => ({ requestKey, kind, title, body, state })),
      resolved: routingResolved.map(({ requestKey, state, resolvedBy }) => ({ requestKey, state, resolvedBy })),
      workspaceAttentionOpened, workspaceAttentionCleared
    }
    const openedRouting = (key: string) => subagentAcceptance.open.find((request) => request.requestKey === key && request.state === 'open')
    const resolvedRouting = (key: string, state: string, event: string) => subagentAcceptance.resolved.some((request) =>
      request.requestKey === key && request.state === state && request.resolvedBy === event)
    if (openedRouting('opencode:permission')?.kind !== 'permission' ||
      openedRouting('opencode:subagent-permission')?.kind !== 'permission' ||
      openedRouting('opencode:subagent-permission')?.title !== 'OpenCode subagent asks to child-tool' ||
      openedRouting('opencode:subagent-permission')?.body !== 'child-pattern' ||
      openedRouting('opencode:subagent-question')?.kind !== 'question' ||
      !resolvedRouting('opencode:subagent-permission', 'answered', 'hook:opencode:permission.replied') ||
      !resolvedRouting('opencode:subagent-question', 'withdrawn', 'hook:opencode:question.rejected') ||
      !workspaceAttentionOpened.selectedInA || workspaceAttentionOpened.text !== '1 waiting for your response') {
      throw new Error(`subagent requests were not routed and answered as their own: ${JSON.stringify(subagentAcceptance)}`)
    }
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: routingSession.session.sessionId,
      incarnationId: routingSession.session.lastProcess?.incarnationId, cause: 'explicit' })

    const repeatDirectory = join(isolatedCwd, 'repeat-acceptance')
    // The Claude capability probe runs --help without a session credential; only the real PTY may publish markers.
    const repeatExecutable = writeAcceptanceHarness(repeatDirectory, 'claude', [
      "if (process.argv.includes('--help')) process.exit(0)",
      "const event = (hook_event_name) => spawnSync('bmn', ['hook', 'claude'], { input: JSON.stringify({ hook_event_name, tool_name: 'Bash', tool_input: { command: 'synthetic-repeat' }, tool_response: { output: 'fixture' } }), stdio: ['pipe', 'ignore', 'ignore'] })",
      "for (let i = 0; i < 3; i++) event('PostToolUse')",
      "writeFileSync(file('three'), '')",
      "await wait('eight-gate')",
      "for (let i = 3; i < 8; i++) event('PostToolUse')",
      "writeFileSync(file('eight'), '')",
      "await wait('reset-gate')",
      "event('UserPromptSubmit')",
      "writeFileSync(file('reset'), '')"
    ])
    const repeatSession = await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Repeat acceptance', cwd: isolatedCwd, executable: repeatExecutable, argv: [], cols: 80, rows: 24 }, true)
    await untilFileExists(join(repeatDirectory, 'three'), 'three repeated calls')
    const repeatBeforeUi = await client.request<Array<{ event: string; toolName: string | null; repeat: number | null; effects: string[] }>>(
      METHOD_REGISTRY.hookEventsList, { sessionId: repeatSession.session.sessionId })
    if (JSON.stringify(repeatBeforeUi.map(({ repeat }) => repeat)) !== '[1,2,3]') {
      throw new Error(`the three real hook calls were not counted: ${JSON.stringify(repeatBeforeUi)}`)
    }
    await host.recoverApplicationRenderer(host.applicationWindow)
    const repeatLogProbe = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read, label) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('repeat log UI timed out: ' + label); };
      (await wait(() => document.querySelector('button[data-session-id="${repeatSession.session.sessionId}"]'), 'session row')).click();
      await wait(() => window.__aitermTest?.snapshots()?.['${repeatSession.session.sessionId}'], 'terminal snapshot');
      (await wait(() => document.querySelector('[aria-label="Actions for Repeat acceptance"]'), 'row menu')).click();
      (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')].find(r => r.textContent.trim() === 'Hook events…'), 'Hook events action')).click();
      const dialog = await wait(() => document.querySelector('dialog.hook-events-dialog[open]'), 'dialog');
      const text = await wait(() => dialog.textContent.includes('same call ×3') && dialog.textContent, 'same call ×3');
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      return { text, inputEvents: window.__aitermTest.snapshot('${repeatSession.session.sessionId}').inputEvents };
    })()`) as { text: string; inputEvents: number }
    writeFileSync(join(repeatDirectory, 'eight-gate'), '')
    await untilFileExists(join(repeatDirectory, 'eight'), 'eight repeated calls')
    const repeatRows = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .filter(row => row.sessionId === repeatSession.session.sessionId && row.requestKey === 'watch:repeat' && row.state === 'open')
    const repeatProvenance = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('.needs-you-button').click();
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        const row = [...document.querySelectorAll('.attention-item')].find(r => r.textContent.includes('Repeat acceptance repeated'));
        if (row) { const text = row.querySelector('.provenance')?.textContent; document.querySelector('.needs-you-button').click(); return text; }
        await new Promise(r => setTimeout(r, 25));
      } throw new Error('repeat notice missing from Needs you');
    })()`) as string
    writeFileSync(join(repeatDirectory, 'reset-gate'), '')
    await untilFileExists(join(repeatDirectory, 'reset'), 'repeat withdrawal on owner prompt')
    const repeatAfterReset = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .find(row => row.requestId === repeatRows[0]?.requestId)
    const repeatInputAfterNotice = await host.applicationWindow.webContents.executeJavaScript(
      `window.__aitermTest.snapshot('${repeatSession.session.sessionId}').inputEvents`
    ) as number
    if (repeatInputAfterNotice !== 0 || repeatInputAfterNotice !== repeatLogProbe.inputEvents) {
      throw new Error(`repeat notice wrote to the PTY: before=${repeatLogProbe.inputEvents}, after=${repeatInputAfterNotice}`)
    }
    const repeatAcceptance = {
      logShowsThree: repeatLogProbe.text.includes('PostToolUse · Bash · same call ×3'),
      noticeCount: repeatRows.length, kind: repeatRows[0]?.kind, openedBy: repeatRows[0]?.openedBy,
      provenance: repeatProvenance, ptyInputEvents: repeatInputAfterNotice,
      resetState: repeatAfterReset?.state
    }
    if (!repeatAcceptance.logShowsThree || repeatAcceptance.noticeCount !== 1 || repeatAcceptance.kind !== 'notice' ||
      repeatAcceptance.openedBy !== 'watch:repeat' || repeatAcceptance.provenance !== "from BMN's repeat watch" ||
      repeatAcceptance.resetState !== 'withdrawn') {
      throw new Error(`the repeat watch did not open one notice and withdraw it: ${JSON.stringify(repeatAcceptance)}`)
    }
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: repeatSession.session.sessionId,
      incarnationId: repeatSession.session.lastProcess?.incarnationId, cause: 'explicit' })

    // Story 32.3: a TUI died with mouse, paste and focus modes on while its shell lives on. Reset terminal modes
    // turns them off in the view and in the tracker, writing nothing to the PTY, and a rebuilt view stays plain.
    console.error('[BMN] self-test phase: reset terminal modes')
    const resetDirectory = join(isolatedCwd, 'reset-modes')
    mkdirSync(resetDirectory, { recursive: true })
    const resetInputLog = join(resetDirectory, 'input.log')
    // Windows: the same raw-mode program as a Node stand-in; stty and cat are POSIX.
    const resetExecutable = typedShell.windows ? writeNodeProgram(resetDirectory, 'shell', [
      "const { createWriteStream } = require('node:fs')",
      'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
      "process.stdout.write('\\u001b[?1000h\\u001b[?1006h\\u001b[?2004h\\u001b[?1004hMODES-ARMED\\r\\n')",
      `process.stdin.pipe(createWriteStream(${JSON.stringify(resetInputLog)}))`,
      ''
    ].join('\n')) : join(resetDirectory, 'shell.sh')
    if (!typedShell.windows) writeFileSync(resetExecutable, [
      '#!/bin/sh',
      'stty raw -echo',
      "printf '\\033[?1000h\\033[?1006h\\033[?2004h\\033[?1004hMODES-ARMED\\r\\n'",
      `exec cat > ${JSON.stringify(resetInputLog)}`,
      ''
    ].join('\n'), { mode: 0o755 })
    const resetSession = await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Reset modes acceptance', cwd: isolatedCwd, executable: resetExecutable, argv: [], cols: 80, rows: 24 }, true)
    const resetId = JSON.stringify(resetSession.session.sessionId)
    const resetView = (): Promise<{ bufferLines: string[]; cols: number; rows: number; refits: number; inputEvents: number;
      modes: Record<string, unknown> }> => host.applicationWindow!.webContents.executeJavaScript(
      `window.__aitermTest.snapshot(${resetId})`) as never
    const wheel = (): Promise<number> => host.applicationWindow!.webContents.executeJavaScript(`(async () => {
      const pane = document.querySelector('.session-terminal[data-session-id=' + JSON.stringify(${resetId}) + ']:not(.session-terminal-hidden)');
      const screen = pane?.querySelector('.xterm-screen');
      if (!screen) throw new Error('reset modes: no terminal screen');
      const box = screen.getBoundingClientRect();
      const before = window.__aitermTest.snapshot(${resetId}).inputEvents;
      screen.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, deltaMode: 0, bubbles: true, cancelable: true,
        clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return window.__aitermTest.snapshot(${resetId}).inputEvents - before;
    })()`) as Promise<number>
    const logSize = (): number => existsSync(resetInputLog) ? readFileSync(resetInputLog).byteLength : -1
    // A session made through the host reaches the tree when the window reloads, as the repeat fixture's does.
    await host.recoverApplicationRenderer(host.applicationWindow)
    await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        document.querySelector('.session-row > button[data-session-id=' + JSON.stringify(${resetId}) + ']')?.click();
        const shot = window.__aitermTest?.snapshots()?.[${resetId}];
        if (shot && shot.bufferLines.some((line) => line.includes('MODES-ARMED')) && shot.modes.mouseTrackingMode !== 'none') return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } throw new Error('reset modes: the fixture never armed its modes: ' + JSON.stringify({
        row: !!document.querySelector('.session-row > button[data-session-id=' + JSON.stringify(${resetId}) + ']'),
        shot: window.__aitermTest?.snapshots()?.[${resetId}] ?? null }).slice(0, 2000));
    })()`)
    await untilFileExists(resetInputLog, 'the reset fixture shell')
    const armedModes = (await resetView()).modes
    const logBeforeWheel = logSize()
    const wheelInputBefore = await wheel()
    const armedWheelReached = await acceptanceWait(async () => logSize() > logBeforeWheel ? true : undefined, 'armed wheel input at the PTY')
    // The view was rebuilt moments ago; measure it once its fit has settled.
    const settledView = async (): Promise<Awaited<ReturnType<typeof resetView>>> => {
      let previous = await resetView()
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const current = await resetView()
        if (current.cols === previous.cols && current.rows === previous.rows && current.refits === previous.refits &&
          JSON.stringify(current.bufferLines) === JSON.stringify(previous.bufferLines)) return current
        previous = current
      }
      return previous
    }
    // In the hidden self-test window a rebuilt view gets its first fit only when the layout next changes, and the
    // palette's dialog is such a change; open and close it once so the reset is measured against a fitted view.
    if (await runPaletteCommand(host.applicationWindow, 'No such command: fit before the reset baseline') !== 'missing') {
      throw new Error('reset modes: the baseline palette probe ran a command')
    }
    const beforeReset = await settledView()
    const logBeforeReset = readFileSync(resetInputLog)
    const resetRan = await runPaletteCommand(host.applicationWindow, 'Reset terminal modes')
    const resetToast = await acceptanceWait(async () => await host.applicationWindow!.webContents.executeJavaScript(
      `document.body.textContent.includes('Terminal modes reset for Reset modes acceptance') || undefined`) as true | undefined,
    'the reset toast')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterReset = await resetView()
    const wheelInputAfter = await wheel()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const logAfterReset = readFileSync(resetInputLog)
    await host.recoverApplicationRenderer(host.applicationWindow)
    await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        document.querySelector('.session-row > button[data-session-id=' + JSON.stringify(${resetId}) + ']')?.click();
        if (window.__aitermTest?.snapshots()?.[${resetId}]) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } throw new Error('reset modes: no rebuilt view');
    })()`)
    const rebuilt = await resetView()
    const plainModes = (modes: Record<string, unknown>): boolean => modes.mouseTrackingMode === 'none' &&
      modes.bracketedPasteMode === false && modes.sendFocusMode === false && modes.wraparoundMode === true &&
      modes.applicationCursorKeysMode === false && modes.originMode === false && modes.alternateScreen === false &&
      modes.cursorHidden === false && modes.mouseEncoding === 'DEFAULT'
    const resetModes = {
      armed: armedModes, ran: resetRan, toast: resetToast === true,
      wheelInputBefore, armedWheelReached: armedWheelReached === true,
      after: afterReset.modes, wheelInputAfter,
      ptyUnchangedByReset: Buffer.compare(logBeforeReset, logAfterReset) === 0,
      screenUnchanged: JSON.stringify(afterReset.bufferLines) === JSON.stringify(beforeReset.bufferLines),
      geometryUnchanged: afterReset.cols === beforeReset.cols && afterReset.rows === beforeReset.rows &&
        afterReset.refits === beforeReset.refits,
      geometry: { before: [beforeReset.cols, beforeReset.rows, beforeReset.refits], after: [afterReset.cols, afterReset.rows, afterReset.refits] },
      changedLines: afterReset.bufferLines.map((line, index) => line === beforeReset.bufferLines[index] ? null
        : { index, before: beforeReset.bufferLines[index] ?? null, after: line }).filter(Boolean).slice(0, 3),
      rebuilt: rebuilt.modes
    }
    console.error(`[BMN] self-test phase: reset terminal modes ${JSON.stringify(resetModes)}`)
    if (armedModes.mouseTrackingMode === 'none' || armedModes.bracketedPasteMode !== true || armedModes.sendFocusMode !== true ||
      armedModes.mouseEncoding !== 'SGR' || resetRan !== 'ran' || !resetModes.toast || wheelInputBefore < 1 ||
      !resetModes.armedWheelReached || !plainModes(afterReset.modes) || wheelInputAfter !== 0 || !resetModes.ptyUnchangedByReset ||
      !resetModes.screenUnchanged || !resetModes.geometryUnchanged || !plainModes(rebuilt.modes)) {
      throw new Error(`Reset terminal modes went wrong: ${JSON.stringify(resetModes)}`)
    }
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: resetSession.session.sessionId,
      incarnationId: resetSession.session.lastProcess?.incarnationId, cause: 'explicit' })

    // Return selection to the lifecycle fixture expected by the existing restart checks.
    await host.applicationWindow.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.session-row button[data-session-id="' + ${JSON.stringify(preloadProbe.templateCreatedSession.sessionId)} + '"]');
      if (!row) throw new Error('the lifecycle fixture disappeared after acceptance');
      row.click();
    })()`)
    console.error('[BMN] self-test phase: conversation reported by a session hook')
    const hookReference = '01a0b657-21a8-7f00-addd-b73646828f5b'
    const rolloutDirectory = join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '20')
    mkdirSync(rolloutDirectory, { recursive: true })
    writeFileSync(join(rolloutDirectory, `rollout-2026-09-20T00-00-00-${hookReference}.jsonl`), '')
    const reportingHarness = writeCodexHarness(join(isolatedCwd, 'codex-harness-a'), hookReference)
    const rivalHarness = writeCodexHarness(join(isolatedCwd, 'codex-harness-b'), hookReference)
    const reportingSession = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionCreate, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Hook-reported Codex',
      cwd: isolatedCwd,
      executable: reportingHarness.executable,
      argv: ['--model', 'gpt-6', '--full-auto'],
      cols: 80,
      rows: 24
    })
    const startedUnsupported = await client.request<PersistedConversationBinding>(
      METHOD_REGISTRY.sessionBindingGet,
      { sessionId: reportingSession.sessionId }
    )
    await untilHarnessRuns(reportingHarness.log, 1)
    const reportedBinding = await (async (): Promise<BoundConversationBinding> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const binding = await client.request<PersistedConversationBinding>(
          METHOD_REGISTRY.sessionBindingGet,
          { sessionId: reportingSession.sessionId }
        )
        if (binding.status === 'bound' && binding.captureRoute === 'hook-session-start') return binding
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the reported conversation never reached the binding')
    })()
    const codexObservationUi = await inspectHarnessObservation(
      reportingSession.sessionId, 'Hook-reported Codex', 'Codex', 'SessionStart'
    )
    if (Object.values(codexObservationUi).some((value) => value !== true)) {
      throw new Error(`Codex observation view failed: ${JSON.stringify(codexObservationUi)}`)
    }
    const rivalSession = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionCreate, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Rival Codex',
      cwd: isolatedCwd,
      executable: rivalHarness.executable,
      argv: [],
      cols: 80,
      rows: 24
    })
    await untilHarnessRuns(rivalHarness.log, 1)
    const rivalBinding = await client.request<PersistedConversationBinding>(
      METHOD_REGISTRY.sessionBindingGet,
      { sessionId: rivalSession.sessionId }
    )
    await client.request(METHOD_REGISTRY.sessionStop, {
      sessionId: reportingSession.sessionId,
      incarnationId: reportingSession.incarnationId,
      cause: 'explicit'
    })
    const resumedSession = await client.request<SessionIdentity>(METHOD_REGISTRY.sessionResume, {
      sessionId: reportingSession.sessionId,
      cols: 80,
      rows: 24
    })
    const harnessRunArguments = await untilHarnessRuns(reportingHarness.log, 2)
    for (const stopping of [
      { sessionId: reportingSession.sessionId, incarnationId: resumedSession.incarnationId },
      { sessionId: rivalSession.sessionId, incarnationId: rivalSession.incarnationId }
    ]) {
      await client.request(METHOD_REGISTRY.sessionStop, { ...stopping, cause: 'explicit' })
    }
    /** Sessions deliberately stopped before the application restart: they are exited, not interrupted. */
    const stoppedBeforeRestartSessionIds = new Set([
      reportingSession.sessionId, rivalSession.sessionId,
      petitionSource.session.sessionId, petitionDestination.session.sessionId,
      openCodeSession.session.sessionId, routingSession.session.sessionId, repeatSession.session.sessionId,
      cursorSession.session.sessionId, cursorShell.session.sessionId, resetSession.session.sessionId
    ])
    // The rival's report was refused; the owner must be able to read why while BMN is still running.
    const refusalLog = join(resolveApplicationRoots().state, 'refused-requests.log')
    const refusalReason = await (async (): Promise<string | null> => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        if (existsSync(refusalLog)) {
          const line = readFileSync(refusalLog, 'utf8')
            .split('\n')
            .filter((entry) => entry.includes(rivalSession.sessionId))
            .at(-1)
          if (line) return line.slice(line.indexOf('refused for'))
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return null
    })()
    const conversationFromHook = {
      startedRoute: startedUnsupported.captureRoute,
      listed: listedConversation(reportingHarness.listing),
      refusalReason,
      reportedRoute: reportedBinding.captureRoute,
      reportedReference: reportedBinding.conversationReference,
      reportedDetail: reportedBinding.detail,
      rivalRoute: rivalBinding.captureRoute,
      resumedArguments: harnessRunArguments[1] ?? null,
      launchArguments: harnessRunArguments[0] ?? null
    }
    console.error(`[BMN] self-test phase: conversation reported ${JSON.stringify(conversationFromHook)}`)
    const reportedConversation = '01a0b657-21a8-7f00-addd-b73646828f5b'
    const listedRow = conversationFromHook.listed.conversation as { status?: string; captureRoute?: string } | null
    if (conversationFromHook.startedRoute !== 'unsupported' ||
      conversationFromHook.reportedReference !== reportedConversation ||
      !conversationFromHook.reportedDetail?.startsWith('Reported by Codex at session start') ||
      !conversationFromHook.reportedDetail.includes('not carried: --full-auto') ||
      conversationFromHook.rivalRoute !== 'unsupported' ||
      conversationFromHook.listed.sessions !== 1 || listedRow?.status !== 'bound' ||
      listedRow.captureRoute !== 'hook-session-start' ||
      !conversationFromHook.refusalReason?.endsWith('already resumed in "Hook-reported Codex"') ||
      JSON.stringify(conversationFromHook.launchArguments) !== JSON.stringify(['--no-daemon', '--model', 'gpt-6', '--full-auto']) ||
      JSON.stringify(conversationFromHook.resumedArguments) !== JSON.stringify(['--no-daemon', 'resume', reportedConversation, '--model', 'gpt-6'])) {
      throw new Error(`the conversation a Codex hook reported was not bound, listed and resumed: ${JSON.stringify(conversationFromHook)}`)
    }

    const openRequestCount = async (): Promise<number> =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .filter((request) => request.state === 'open').length
    const openRequestsBeforeRendererRestart = await openRequestCount()

    /**
     * Epic 17.2: a program that turned bracketed paste, focus reports and SGR mouse on, so the
     * renderer-crash row can be asked the question it never answered — does the rebuilt view still
     * speak to the program the way the program asked to be spoken to?
     */
    const modeProgram = writeTerminalModeProgram(join(isolatedCwd, 'terminal-modes'))
    const { session: modeRecord, startup: modeStartup } = await host.createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Terminal modes',
      cwd: isolatedCwd,
      executable: modeProgram.executable,
      argv: [],
      cols: 80,
      rows: 24
    }, true)
    await host.recoverApplicationRenderer(host.applicationWindow)
    const modesBeforeRestart = await terminalViewModes(host.applicationWindow, modeRecord.sessionId, true)

    console.error('[BMN] self-test phase: renderer restart')
    const reloaded = waitForRendererLoad(host.applicationWindow)
    host.applicationWindow.webContents.reload()
    await reloaded
    await waitForRendererHook(host.applicationWindow)
    console.error('[BMN] self-test phase: renderer restart loaded')
    // The view is new; the program is the same one, still believing the modes it set.
    const modesAfterRestart = await terminalViewModes(host.applicationWindow, modeRecord.sessionId, false)
    const inputBeforeDriving = terminalModeProgramInput(modeProgram.input)
    const driven = await driveModeSensitiveInput(host.applicationWindow, modeRecord.sessionId, MODE_PASTE_TEXT)
    const programSaw = await untilModeProgramRead(modeProgram.input, inputBeforeDriving)
    const terminalModes = {
      before: modesBeforeRestart,
      after: modesAfterRestart,
      // What the program was actually sent, so a failure says which half of the path broke.
      saw: JSON.stringify(programSaw).slice(0, 200),
      clipboard: driven.clipboard,
      ptyWrites: driven.ptyWrites,
      notice: driven.notice,
      pasteBracketed: programSaw.includes(`\u001b[200~${MODE_PASTE_TEXT}\u001b[201~`),
      pasteArrivedBare: programSaw.includes(MODE_PASTE_TEXT) &&
        !programSaw.includes(`\u001b[200~${MODE_PASTE_TEXT}`),
      focusReported: programSaw.includes('\u001b[I') || programSaw.includes('\u001b[O')
    }
    console.error(`[BMN] self-test phase: terminal modes ${JSON.stringify(terminalModes)}`)
    if (
      !modesBeforeRestart.bracketedPasteMode ||
      !modesBeforeRestart.sendFocusMode ||
      modesBeforeRestart.mouseTrackingMode === 'none' ||
      modesBeforeRestart.wraparoundMode
    ) {
      throw new Error(`the mode program never reached the first view: ${JSON.stringify(modesBeforeRestart)}`)
    }
    if (
      !modesAfterRestart.bracketedPasteMode ||
      !modesAfterRestart.sendFocusMode ||
      modesAfterRestart.mouseTrackingMode !== modesBeforeRestart.mouseTrackingMode ||
      // A mode the program turned off is as much its state as one it turned on.
      modesAfterRestart.wraparoundMode
    ) {
      throw new Error(
        `the rebuilt view lost the program's terminal modes: ${JSON.stringify(terminalModes)}`
      )
    }
    if (!terminalModes.pasteBracketed || !terminalModes.focusReported) {
      throw new Error(`the rebuilt view no longer speaks to the program: ${JSON.stringify(terminalModes)}`)
    }
    await client.request(METHOD_REGISTRY.sessionStop, {
      sessionId: modeStartup.sessionId,
      incarnationId: modeStartup.incarnationId,
      cause: 'explicit'
    })
    stoppedBeforeRestartSessionIds.add(modeRecord.sessionId)
    // Epic 17.1 AC2: the offer was made once; a rebuilt view is not a new start, so it stays away.
    const offerStayedAwayAfterRendererRestart = await resumeOfferStaysAway(host.applicationWindow, 750)
    if (!offerStayedAwayAfterRendererRestart) {
      throw new Error('an already-offered interruption asked again after the renderer restart')
    }
    // Epic 11 AC1: the marker is stored, not remembered by the view, so it is still there after a restart.
    const markersAfterRestart = await client.request<WorkspaceRecord[]>(METHOD_REGISTRY.workspaceList, {
      includeArchived: true
    })
    const restartedLocalWorkspace = markersAfterRestart
      .find((workspace) => workspace.workspaceId === DEFAULT_WORKSPACE_ID)
    const restartedLocalMarker = restartedLocalWorkspace?.marker
    const restartedForeignMarker = markersAfterRestart
      .find((workspace) => workspace.workspaceId === secondWorkspace.workspaceId)?.marker
    if (!restartedLocalWorkspace || restartedLocalMarker !== 'teal' || restartedForeignMarker !== 'rose') {
      throw new Error(
        `workspace markers did not survive the renderer restart: ${JSON.stringify({
          restartedLocalMarker,
          restartedForeignMarker
        })}`
      )
    }
    const rendererMarkerAfterRestart = await host.applicationWindow.webContents.executeJavaScript(
      `document.querySelector('.workspace-group[aria-label=${JSON.stringify(restartedLocalWorkspace.name)}] `
      + `.workspace-row .workspace-marker')?.dataset.marker ?? null`
    ) as string | null
    if (rendererMarkerAfterRestart !== 'teal') {
      throw new Error(
        `the reloaded renderer did not redraw the stored marker: ${JSON.stringify(rendererMarkerAfterRestart)}`
      )
    }
    const rendererStoppedPanelLabel = await stoppedPanelLabel(
      host.applicationWindow,
      preloadProbe.templateCreatedSession.sessionId
    )
    const expectedStoppedPanelLabel =
      `Interrupted · ${lifecycleStoppedBeforeRestart!.detail} · ${rendererTemplate.cwd}`
    if (rendererStoppedPanelLabel !== expectedStoppedPanelLabel) {
      throw new Error(
        `the stopped panel did not render the recorded process label: ${JSON.stringify(rendererStoppedPanelLabel)}`
      )
    }
    // AC4: what the owner reads before Resume is the command that runs, and Cancel starts nothing.
    const liveBeforeConfirmation = (await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})).liveSessions
    const resumeConfirmation = await resumeConfirmationShown(
      host.applicationWindow,
      { sessionId: reportingSession.sessionId, name: 'Hook-reported Codex' },
      preloadProbe.templateCreatedSession.sessionId
    )
    const liveAfterCancel = (await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})).liveSessions
    if (liveAfterCancel !== liveBeforeConfirmation) {
      throw new Error('cancelling the Resume confirmation started or stopped a process')
    }
    const resumeConfirmationShownToOwner = {
      command: resumeConfirmation.command,
      note: resumeConfirmation.note,
      // The command the owner read must be exactly the one the earlier real Resume spawned.
      matchesSpawnedArguments:
        resumeConfirmation.command ===
        [reportingHarness.executable, ...(harnessRunArguments[1] ?? [])].join(' '),
      startedNothing: liveAfterCancel === liveBeforeConfirmation
    }
    console.error(`[BMN] self-test phase: resume confirmation ${JSON.stringify(resumeConfirmationShownToOwner)}`)
    if (!resumeConfirmationShownToOwner.matchesSpawnedArguments ||
      !resumeConfirmationShownToOwner.command?.includes('resume 01a0b657-21a8-7f00-addd-b73646828f5b --model gpt-6') ||
      resumeConfirmationShownToOwner.note !==
        'Not carried over from the original launch: --full-auto. codex resume does not accept them.') {
      throw new Error(`the Resume confirmation did not show the command that runs: ${JSON.stringify(resumeConfirmationShownToOwner)}`)
    }

    // Epic 29: the model maker's flag, from what a Claude stand-in's own `bmn hook claude` reports
    // under each base URL. This run stays live into the application restart below.
    console.error('[BMN] self-test phase: model origin flags')
    const originDirectory = join(isolatedCwd, 'model-origin')
    const { session: originSession } = await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Model origin', cwd: isolatedCwd, executable: typedShell.executable, argv: shellRunning(writeOriginHarness(originDirectory)),
      cols: 80, rows: 24 }, true)
    await host.recoverApplicationRenderer(host.applicationWindow)
    const originScenarios = [
      { label: 'default', baseUrl: null, model: 'claude-opus-4-5', flag: '🇺🇸',
        name: 'Model origin: the United States · claude-opus-4-5', row: 'claude-opus-4-5' },
      { label: 'zai', baseUrl: 'https://api.z.ai/api/anthropic', model: 'claude-sonnet-4-5', flag: '🇨🇳',
        name: 'Model origin: China · claude-sonnet-4-5 via api.z.ai', row: 'claude-sonnet-4-5 via api.z.ai' },
      { label: 'mistral', baseUrl: 'https://api.mistral.ai', model: 'mistral-large-latest', flag: '🇫🇷',
        name: 'Model origin: France · mistral-large-latest via api.mistral.ai', row: 'mistral-large-latest via api.mistral.ai' },
      { label: 'openrouter', baseUrl: 'https://openrouter.ai/api', model: 'moonshotai/kimi-k2', flag: '🇨🇳',
        name: 'Model origin: China · moonshotai/kimi-k2 via openrouter.ai', row: 'moonshotai/kimi-k2 via openrouter.ai' },
      { label: 'unknown', baseUrl: 'https://llm.internal.example/v1', model: 'custom-tuned', flag: null,
        name: null, row: 'custom-tuned via llm.internal.example' }
    ]
    const modelOriginFlags: Record<string, OriginProbe> = {}
    for (const [n, scenario] of originScenarios.entries()) {
      await fireOriginGate(originDirectory, n, { baseUrl: scenario.baseUrl, model: scenario.model, event: 'SessionStart' })
      const seen = await modelOriginProbe(host.applicationWindow, originSession.sessionId, 'Model origin', scenario.row)
      modelOriginFlags[scenario.label] = seen
      if (seen.rowFlag !== scenario.flag || seen.paneFlag !== scenario.flag || seen.inspectorFlag !== scenario.flag ||
        seen.rowLabel !== scenario.name || seen.paneLabel !== scenario.name ||
        seen.modelTitle !== (scenario.name ?? 'Model origin unclassified') ||
        [seen.rowChip, seen.paneChip, seen.inspectorChip].some((chip) => chip !== 'Claude')) {
        throw new Error(`model origin ${scenario.label} rendered wrongly: ${JSON.stringify(seen)}`)
      }
    }
    // Epic 30.2: a phone answer reaches only the dialog that asked, with exactly the keys the owner would type.
    console.error('[BMN] self-test phase: remote answers')
    const answerDirectory = join(isolatedCwd, 'remote-answers')
    const answerFixtures = app.isPackaged
      ? join(process.resourcesPath, 'self-test', 'remote-answers')
      : join(repoRoot, 'apps', 'desktop', 'src', 'utility', 'test-fixtures', 'remote-answers')
    const { session: answerSession } = await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Remote answers', cwd: isolatedCwd, executable: typedShell.executable,
      argv: shellRunning(writeRemoteAnswerHarness(answerDirectory, answerFixtures)), cols: 200, rows: 50 }, true)
    await host.recoverApplicationRenderer(host.applicationWindow)
    const answerRun = async (scenario: string, requestKey: string, answer: unknown) => {
      writeFileSync(join(answerDirectory, `fire-${scenario}`), '')
      await untilFileExists(join(answerDirectory, `opened-${scenario}`), `drew the ${scenario} dialog`)
      // The stand-in's drawing reaches the mirror a moment after its hook returns.
      await new Promise((resolve) => setTimeout(resolve, 300))
      const opened = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .find((row) => row.sessionId === answerSession.sessionId && row.requestKey === requestKey && row.state === 'open')
      const { selfTestRemoteAnswer } = await client.request<{
        selfTestRemoteAnswer: { outcome: { state: string; reason?: string; sent?: string[] } | null; request: AttentionRecord | null }
      }>(METHOD_REGISTRY.healthGet, { selfTestRemoteAnswer: { sessionId: answerSession.sessionId, requestKey, answer } })
      await untilFileExists(join(answerDirectory, `done-${scenario}`), `finished the ${scenario} dialog`)
      if (existsSync(join(answerDirectory, 'error'))) {
        throw new Error(`remote answer stand-in failed: ${readFileSync(join(answerDirectory, 'error'), 'utf8')}`)
      }
      const request = selfTestRemoteAnswer.request
      return {
        prompt: opened?.prompt ?? null,
        outcome: selfTestRemoteAnswer.outcome,
        keys: JSON.parse(readFileSync(join(answerDirectory, `done-${scenario}`), 'utf8')) as string[],
        request: request ? { state: request.state, resolvedBy: request.resolvedBy, resolution: request.resolution } : null
      }
    }
    const single = await answerRun('single', 'claude:question', { type: 'choices', choices: [1] })
    const three = await answerRun('three', 'claude:question', { type: 'choices', choices: [0, 1, 0] })
    const codexTwo = await answerRun('codex', 'codex:question', { type: 'choices', choices: [1, 0] })
    const permissionsOff = await answerRun('off', 'claude:permission', { type: 'permission', decision: 'allow' })
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: {
      ...(await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram, answerPermissions: true } })
    const allowOnce = await answerRun('allow', 'claude:permission', { type: 'permission', decision: 'allow' })
    const denied = await answerRun('deny', 'claude:permission', { type: 'permission', decision: 'deny' })
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: {
      ...(await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram, answerPermissions: false } })
    const allKeys = readFileSync(join(answerDirectory, 'keys.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string).join('')
    const remoteAnswers = {
      readBack: single.prompt?.type === 'questions'
        ? { type: single.prompt.type, harness: single.prompt.harness, labels: single.prompt.questions[0]?.options.map((option) => option.label) }
        : null,
      single, three, codexTwo, permissionsOff, allowOnce, denied,
      // Every byte the stand-in ever received, across all six dialogs.
      allKeys
    }
    console.error(`[BMN] self-test phase: remote answers ${JSON.stringify(remoteAnswers)}`)
    const answered = (run: typeof single, keys: string[], sent: string[]) =>
      JSON.stringify(run.keys) === JSON.stringify(keys) && run.outcome?.state === 'confirmed' &&
      JSON.stringify(run.outcome.sent) === JSON.stringify(sent) && run.request?.resolvedBy === 'telegram'
    if (remoteAnswers.readBack?.type !== 'questions' ||
      remoteAnswers.readBack.labels?.join('|') !== 'JWT|Session cookies|OAuth only' ||
      !answered(single, ['2'], ['Session cookies']) || !answered(three, ['1', '2', '1', '1'], ['Postgres', 'Later', 'Staging']) ||
      !answered(codexTwo, ['2', '1'], ['SQLite', 'Yes']) || !answered(allowOnce, ['1'], ['Allow once']) ||
      permissionsOff.outcome?.state !== 'refused' || permissionsOff.outcome.reason !== 'permissions-off' || permissionsOff.keys.length !== 0 ||
      denied.outcome?.state !== 'sent-unconfirmed' || JSON.stringify(denied.keys) !== '["3"]' || denied.request?.resolvedBy !== 'telegram' ||
      allKeys !== '2' + '1211' + '21' + '1' + '3') {
      throw new Error(`remote answers went wrong: ${JSON.stringify(remoteAnswers)}`)
    }

    // Story 30.3: the same three-question dialog, answered by tapping its Telegram card on a fake Bot API.
    console.error('[BMN] self-test phase: telegram cards')
    const bot = await taps.telegram()
    const telegramBefore = (await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})).telegram
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: { ...telegramBefore, enabled: true,
      allowedChatId: SELF_TEST_TELEGRAM_CHAT_ID, allowedUserId: null, notifyOn: 'attention', autoSubmitReplies: false } })
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: '123456789:SELFTEST_fake_bot_token_not_real' })
    const pollingBy = Date.now() + 15_000
    while ((await client.request<{ state: string }>(METHOD_REGISTRY.telegramStatus, {})).state !== 'polling') {
      if (Date.now() > pollingBy) throw new Error('the self-test Telegram connector never started polling')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const firstCall = bot.calls.length
    bot.tapOn('Which database should store users?', [0, 1, 0])
    await client.request(METHOD_REGISTRY.presenceSet, { away: true })
    writeFileSync(join(answerDirectory, 'fire-card'), '')
    // The page waits its (self-test) 2 s before it is sent; the three taps and the delivery follow.
    const cardBy = Date.now() + 60_000
    while (!existsSync(join(answerDirectory, 'done-card'))) {
      if (Date.now() > cardBy) throw new Error(`the card dialog never finished: ${JSON.stringify(bot.calls.slice(firstCall))}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const finishedBy = Date.now() + 15_000
    const finalEdit = (): boolean => bot.calls.slice(firstCall).some((call) =>
      call.method === 'editMessageText' && String(call.body.text).includes('✓ <i>Sent:'))
    while (!finalEdit() && Date.now() < finishedBy) await new Promise((resolve) => setTimeout(resolve, 100))
    const cardMessage = bot.calls.slice(firstCall).find((call) =>
      call.method === 'sendMessage' && String(call.body.text).includes('Which database should store users?'))
    const buttonsOf = (body: Record<string, unknown>): number =>
      ((body.reply_markup as { inline_keyboard?: unknown[][] } | undefined)?.inline_keyboard ?? []).flat().length
    const lastLine = (body: Record<string, unknown>): string => String(body.text ?? '').split('\n').pop() ?? ''
    // Only this card's own messages: other sessions' pages may arrive when the owner turns away.
    const cardCalls = cardMessage ? bot.calls.slice(bot.calls.indexOf(cardMessage)).filter((call) => call === cardMessage ||
      call.method === 'answerCallbackQuery' || call.method === 'editMessageText' && call.body.message_id === cardMessage.messageId) : []
    const cardRequest = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .filter((row) => row.sessionId === answerSession.sessionId && row.requestKey === 'claude:question')
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt))[0]
    const telegramCards = {
      card: cardMessage ? { parseMode: cardMessage.body.parse_mode, buttons: buttonsOf(cardMessage.body),
        header: String(cardMessage.body.text).split('\n')[0] } : null,
      sequence: cardCalls.map((call) => call.method === 'answerCallbackQuery'
        ? `toast:${String(call.body.text)}`
        : call.method === 'sendMessage' ? `send:${buttonsOf(call.body)}` : `edit:${buttonsOf(call.body)}:${lastLine(call.body)}`),
      keys: JSON.parse(readFileSync(join(answerDirectory, 'done-card'), 'utf8')) as string[],
      request: cardRequest ? { state: cardRequest.state, resolvedBy: cardRequest.resolvedBy } : null
    }
    console.error(`[BMN] self-test phase: telegram cards ${JSON.stringify(telegramCards)}`)
    // Every step offers Other… (Epic 31), and every step after the first ‹ Back.
    const expectedSequence = [
      'send:3', 'toast:Question 2 of 3', 'edit:4:In a follow-up', 'toast:Question 3 of 3',
      'edit:4:<i>Nothing is sent until this answer.</i>', 'toast:Sending Postgres · Later · Staging…',
      'edit:0:<i>Sending: Postgres · Later · Staging…</i>', 'edit:0:✓ <i>Sent: Postgres · Later · Staging</i>'
    ]
    if (telegramCards.card?.parseMode !== 'HTML' || !telegramCards.card.header?.startsWith('❓ <b>') ||
      JSON.stringify(telegramCards.sequence) !== JSON.stringify(expectedSequence) ||
      JSON.stringify(telegramCards.keys) !== '["1","2","1","1"]' || telegramCards.request?.resolvedBy !== 'telegram') {
      throw new Error(`telegram cards went wrong: ${JSON.stringify(telegramCards)}`)
    }

    // Story 31.4: multi-select, Other… with a typed reply, and Back, each through its agent's verified route.
    console.error('[BMN] self-test phase: fuller telegram answers')
    const fullerRun = async (scenario: string, requestKey: string, match: string, steps: FakeBotStep[]) => {
      const from = bot.calls.length
      bot.tapOn(match, steps)
      writeFileSync(join(answerDirectory, `fire-${scenario}`), '')
      const doneBy = Date.now() + 30_000
      while (!existsSync(join(answerDirectory, `done-${scenario}`))) {
        if (existsSync(join(answerDirectory, 'error'))) {
          throw new Error(`remote answer stand-in failed: ${readFileSync(join(answerDirectory, 'error'), 'utf8')}`)
        }
        if (Date.now() > doneBy) throw new Error(`the ${scenario} dialog never finished: ${JSON.stringify(bot.calls.slice(from))}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const sentBy = Date.now() + 15_000
      const card = (): FakeBotCall | undefined => bot.calls.slice(from).find((call) =>
        call.method === 'sendMessage' && String(call.body.text).includes(match))
      const ended = (): boolean => bot.calls.slice(from).some((call) => call.method === 'editMessageText' &&
        call.body.message_id === card()?.messageId && /✓ <i>Sent:|⚠ <i>/.test(String(call.body.text)))
      while (!ended() && Date.now() < sentBy) await new Promise((resolve) => setTimeout(resolve, 100))
      const message = card()
      const labelsOf = (body: Record<string, unknown>): string =>
        ((body.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined)?.inline_keyboard ?? [])
          .flat().map((button) => button.text).join('|')
      const sequence = message ? bot.calls.slice(bot.calls.indexOf(message)).flatMap((call) => {
        if (call === message) return [`send:${labelsOf(call.body)}`]
        if (call.method === 'answerCallbackQuery') return [`toast:${String(call.body.text)}`]
        if (call.method === 'editMessageText' && call.body.message_id === message.messageId) {
          return [`edit:${labelsOf(call.body)}:${String(call.body.text).split('\n').pop()}`]
        }
        // BMN's own replies to the owner's messages, such as "Tap Other… first".
        if (call.method === 'sendMessage' && call.body.reply_parameters) return [`reply:${String(call.body.text)}`]
        return []
      }) : []
      const request = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .filter((row) => row.sessionId === answerSession.sessionId && row.requestKey === requestKey)
        .sort((left, right) => right.openedAt.localeCompare(left.openedAt))[0]
      return {
        sequence,
        keys: (JSON.parse(readFileSync(join(answerDirectory, `done-${scenario}`), 'utf8')) as string[]).join(''),
        request: request ? { state: request.state, resolvedBy: request.resolvedBy } : null
      }
    }
    const claudeMore = await fullerRun('claude-more', 'claude:question', 'Which auth method should the API use?', [
      { tap: '2 · Sessions' }, { tap: '‹ Back' }, { tap: '1 · JWT' },
      [{ reply: 'too early' }, { tap: '○ 1 · Rate limiting' }], { tap: '○ 3 · Webhooks' }, { tap: 'Other…' }, { reply: 'GraphQL' }
    ])
    const codexOther = await fullerRun('codex-other', 'codex:question', 'Which auth method should the API use?', [
      { tap: 'Other…' }, { reply: 'Passkeys first' }
    ])
    const openCodeMore = await fullerRun('opencode-more', 'opencode:question', 'Which features should v1 include?', [
      { tap: '○ 2 · Rate limiting' }, { tap: 'Next · 1 selected' }, { tap: '2 · Sessions' }
    ])
    const fuller = { claudeMore, codexOther, openCodeMore }
    console.error(`[BMN] self-test phase: fuller telegram answers ${JSON.stringify(fuller)}`)
    const DOWN = '\u001b[B'
    const inOrder = (sequence: string[], expected: string[]): boolean => {
      let at = 0
      for (const entry of sequence) if (at < expected.length && entry === expected[at]) at += 1
      return at === expected.length
    }
    if (!inOrder(claudeMore.sequence, [
      'send:1 · JWT|2 · Sessions|Other…',
      'edit:○ 1 · Rate limiting|○ 2 · Audit log|○ 3 · Webhooks|Other…|‹ Back:<i>Choose one or more, then Send.</i>',
      'toast:Question 1 of 2',
      // Back reopens question 1 with its choice marked, and no Back on it.
      'edit:1 · JWT|● 2 · Sessions|Other…:Server-side cookies',
      'reply:Tap Other… first, then reply with your answer.',
      'edit:● 1 · Rate limiting|○ 2 · Audit log|● 3 · Webhooks|Other…|‹ Back|Send 2 selected:<i>Chosen: Rate limiting · Webhooks</i>',
      'edit:‹ Options:<i>Reply to this message with your answer.</i>',
      'edit::<i>Sending: JWT · Rate limiting · Webhooks · “GraphQL”…</i>',
      'edit::✓ <i>Sent: JWT · Rate limiting · Webhooks · “GraphQL”</i>'
    ]) || claudeMore.keys !== `113${DOWN.repeat(3)}GraphQL${DOWN}\r1` || claudeMore.request?.resolvedBy !== 'telegram' ||
      !inOrder(codexOther.sequence, [
        'send:1 · JWT|2 · Sessions|Other…', 'edit:‹ Options:<i>Reply to this message with your answer.</i>',
        'edit::✓ <i>Sent: “Passkeys first”</i>'
      ]) || codexOther.keys !== `${DOWN}${DOWN}\tPasskeys first\r` || codexOther.request?.resolvedBy !== 'telegram' ||
      !inOrder(openCodeMore.sequence, [
        'send:○ 1 · SSO|○ 2 · Rate limiting|○ 3 · Audit log|Other…',
        // OpenCode's second question turned typed answers off: no Other… there.
        'edit:1 · JWT|2 · Sessions|‹ Back:<i>Nothing is sent until this answer.</i>',
        'edit::✓ <i>Sent: Rate limiting · Sessions</i>'
      ]) || openCodeMore.keys !== '[["Rate limiting"],["Sessions"]]' || openCodeMore.request?.resolvedBy !== 'telegram') {
      throw new Error(`fuller telegram answers went wrong: ${JSON.stringify(fuller)}`)
    }
    // Story 34.2: a `bmn ask` body quoting a key reaches the Bot API with the key hidden and the card saying so.
    console.error('[BMN] self-test phase: telegram secret masking')
    const secretKey = 'sk-ant-api03-' + 'SelfTestSyntheticKey_0123456789'
    const secretFrom = bot.calls.length
    writeFileSync(join(answerDirectory, 'fire-secret-ask'), '')
    const secretCard = (): FakeBotCall | undefined => bot.calls.slice(secretFrom).find((call) =>
      call.method === 'sendMessage' && String(call.body.text).includes('Commit the key I found?'))
    const secretBy = Date.now() + 30_000
    while (!secretCard()) {
      if (existsSync(join(answerDirectory, 'error'))) {
        throw new Error(`remote answer stand-in failed: ${readFileSync(join(answerDirectory, 'error'), 'utf8')}`)
      }
      if (Date.now() > secretBy) throw new Error(`the secret-ask card never arrived: ${JSON.stringify(bot.calls.slice(secretFrom))}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // Needs you keeps the exact text; only what leaves for Telegram is masked.
    const secretStored = (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
      .filter((row) => row.sessionId === answerSession.sessionId && row.requestKey === 'secret-ask')
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt))[0]
    writeFileSync(join(answerDirectory, 'fire-secret-ask-close'), '')
    const secretClosedBy = Date.now() + 15_000
    while (!existsSync(join(answerDirectory, 'done-secret-ask')) && Date.now() < secretClosedBy) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const secretMasking = {
      card: String(secretCard()!.body.text),
      leaked: bot.calls.slice(secretFrom).some((call) => JSON.stringify(call.body).includes(secretKey)),
      storedWhole: secretStored?.body?.includes(secretKey) ?? false,
      withdrawn: existsSync(join(answerDirectory, 'done-secret-ask'))
    }
    console.error(`[BMN] self-test phase: telegram secret masking ${JSON.stringify({ ...secretMasking, card: secretMasking.card.replaceAll(secretKey, '<key>') })}`)
    if (secretMasking.leaked || !secretMasking.card.includes('Should I commit [secret hidden] to the repo?') ||
      !secretMasking.card.endsWith('<i>Some text looked like a secret and was hidden. The full text is on the laptop.</i>') ||
      !secretMasking.storedWhole || !secretMasking.withdrawn) {
      throw new Error(`telegram secret masking went wrong: ${JSON.stringify({ ...secretMasking, card: secretMasking.card.replaceAll(secretKey, '<key>') })}`)
    }

    // Story 32.2: a channel that stops delivering shows on the gear and notifies once; a short outage stays quiet.
    console.error('[BMN] self-test phase: telegram channel cue')
    const telegramStatusNow = (): Promise<TelegramStatus> => client.request<TelegramStatus>(METHOD_REGISTRY.telegramStatus, {})
    const gearCue = (): Promise<{ title: string; description: string | null; dot: boolean }> =>
      host.applicationWindow!.webContents.executeJavaScript(`(() => {
        const gear = document.querySelector('.preferences-button');
        return { title: gear?.title ?? '', description: gear?.getAttribute('aria-description') ?? null,
          dot: !!gear?.querySelector('.status-dot.needs-you') };
      })()`) as Promise<{ title: string; description: string | null; dot: boolean }>
    const gearUntil = async (label: string, match: (cue: Awaited<ReturnType<typeof gearCue>>) => boolean): Promise<Awaited<ReturnType<typeof gearCue>>> => {
      const by = Date.now() + 15_000
      for (;;) {
        const cue = await gearCue()
        if (match(cue)) return cue
        if (Date.now() > by) throw new Error(`the gear never showed ${label}: ${JSON.stringify({ cue, status: await telegramStatusNow() })}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    const telegramToken = '123456789:SELFTEST_fake_bot_token_not_real'
    const noticesBefore = taps.appNotices.length
    bot.failWith(409)
    const conflictCue = await gearUntil('the conflict cue', (cue) => cue.title.includes('Telegram is not delivering: Another client is polling this bot token'))
    const conflictPreferences = await host.applicationWindow!.webContents.executeJavaScript(`(async () => {
      const wait = async (read, label) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('telegram cue preferences: ' + label); };
      document.querySelector('.preferences-button').click();
      const preferences = await wait(() => document.querySelector('dialog.preferences-dialog[open]'), 'Preferences');
      const section = await wait(() => [...preferences.querySelectorAll('.preferences-section')].find(s => s.querySelector('h3')?.textContent === 'Telegram'), 'section');
      const text = section.querySelector('.telegram-cue')?.textContent ?? null;
      const first = section.querySelector('.preferences-section-head')?.nextElementSibling?.classList.contains('telegram-cue') ?? false;
      preferences.querySelector('.app-dialog-heading button').click();
      await wait(() => !document.querySelector('dialog.preferences-dialog[open]') ? true : null, 'close');
      return { text, first };
    })()`) as { text: string | null; first: boolean }
    const noticesAfterConflict = taps.appNotices.slice(noticesBefore)
    bot.failWith(401)
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: telegramToken })
    const unauthorizedCue = await gearUntil('the unauthorized cue', (cue) => cue.title.includes('Telegram is not delivering: Telegram rejected the bot token'))
    bot.failWith('network')
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: telegramToken })
    const backoffBy = Date.now() + 15_000
    while ((await telegramStatusNow()).state !== 'backoff') {
      if (Date.now() > backoffBy) throw new Error(`the connector never backed off: ${JSON.stringify(await telegramStatusNow())}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const backoffStatus = await telegramStatusNow()
    const shortOutageCue = await gearCue()
    bot.failWith(null)
    const recoveredBy = Date.now() + 15_000
    while ((await telegramStatusNow()).state !== 'polling') {
      if (Date.now() > recoveredBy) throw new Error(`the connector never recovered: ${JSON.stringify(await telegramStatusNow())}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const recoveredStatus = await telegramStatusNow()
    // The gear may keep its dot for History cleanup; the Telegram words must go.
    const recoveredCue = await gearUntil('no Telegram cue after recovery', (cue) => !cue.title.includes('Telegram'))
    const telegramCue = {
      conflict: conflictCue, conflictPreferences, unauthorized: unauthorizedCue,
      shortOutage: { cue: shortOutageCue, failingSince: backoffStatus.failingSince },
      recovered: { cue: recoveredCue, failingSince: recoveredStatus.failingSince },
      notices: taps.appNotices.slice(noticesBefore), noticesAfterConflict
    }
    console.error(`[BMN] self-test phase: telegram channel cue ${JSON.stringify(telegramCue)}`)
    if (!conflictCue.dot || conflictCue.description !== 'Telegram is not delivering: Another client is polling this bot token' &&
      !conflictCue.description?.endsWith('. Telegram is not delivering: Another client is polling this bot token') ||
      conflictPreferences.text !== 'Telegram is not delivering: Another client is polling this bot token' || !conflictPreferences.first ||
      !unauthorizedCue.dot || shortOutageCue.title.includes('Telegram') || backoffStatus.failingSince === null ||
      recoveredCue.title.includes('Telegram') || recoveredStatus.failingSince !== null ||
      JSON.stringify(telegramCue.notices.map((notice) => notice.body)) !== JSON.stringify([
        'Telegram is not delivering: Another client is polling this bot token',
        'Telegram is not delivering: Telegram rejected the bot token'
      ]) || noticesAfterConflict.length !== 1) {
      throw new Error(`the Telegram channel cue went wrong: ${JSON.stringify(telegramCue)}`)
    }
    await client.request(METHOD_REGISTRY.settingsPut, { section: 'telegram', value: telegramBefore })
    await client.request(METHOD_REGISTRY.telegramConfigure, { token: null })
    host.reportPresence()

    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: answerSession.sessionId,
      incarnationId: answerSession.lastProcess?.incarnationId, cause: 'explicit' })
    stoppedBeforeRestartSessionIds.add(answerSession.sessionId)

    // Epic 31 (Stories 31.1, 31.2): one history limit. The stand-in's own `bmn hook claude` calls teach BMN two
    // more Claude folders; Start cleanup, clicked in Preferences, writes all three and prunes the fake Codex and
    // OpenCode stores through recording binaries. The owner's real files are never in reach: the host's home,
    // CODEX_HOME and XDG_DATA_HOME are this run's scratch folders.
    console.error('[BMN] self-test phase: agent history')
    historyFixture = prepareHistoryFixture(isolatedCwd)
    // PostToolUse opens nothing, so the open-request counts the survival table compares stay put.
    const originGates = readdirSync(originDirectory).filter((name) => name.startsWith('done-')).length
    await fireOriginGate(originDirectory, originGates, { baseUrl: null, model: null, event: 'PostToolUse', configDir: historyFixture.glm })
    await fireOriginGate(originDirectory, originGates + 1, { baseUrl: null, model: null, event: 'PostToolUse', configDir: historyFixture.work })
    const historyStoreBefore = historyFixture.storeFiles()
    const historyPending = await client.request<AgentHistoryStatus>(METHOD_REGISTRY.historyStatus, {})
    const historyPendingView = await historyView(host.applicationWindow, 'read')
    const historyClicked = await historyView(host.applicationWindow, 'start-cleanup')
    const historyRunBy = Date.now() + 15_000
    let historySettled = await client.request<AgentHistoryStatus>(METHOD_REGISTRY.historyStatus, {})
    while ((historySettled.running || historySettled.agents.some((row) => row.lastRun === undefined)) && Date.now() < historyRunBy) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      historySettled = await client.request<AgentHistoryStatus>(METHOD_REGISTRY.historyStatus, {})
    }
    const historySettledView = await historyView(host.applicationWindow, 'read')
    const agentHistory = {
      pending: {
        needsConfirmation: historyPending.needsConfirmation,
        folders: historyPending.claude.map((folder) => ({ path: folder.path, current: folder.currentDays, target: folder.targetDays, pending: folder.pending })),
        agents: historyPending.agents.map((row) => ({ agent: row.agent, state: row.state, sessions: row.sessions, candidates: row.candidates })),
        view: historyPendingView
      },
      clicked: historyClicked,
      settled: {
        needsConfirmation: historySettled.needsConfirmation,
        days: [claudeDays(historyFixture.claudeHome), claudeDays(historyFixture.glm), claudeDays(historyFixture.work)],
        backups: [backupsOf(historyFixture.claudeHome), backupsOf(historyFixture.glm), backupsOf(historyFixture.work)],
        glmEnvKept: JSON.parse(readFileSync(join(historyFixture.glm, 'settings.json'), 'utf8')).env?.ANTHROPIC_MODEL === 'glm',
        codexCalls: recordedCalls(historyFixture.codexLog),
        openCodeCalls: recordedCalls(historyFixture.openCodeLog),
        cursorCalls: recordedCalls(historyFixture.cursorLog),
        runs: historySettled.agents.map((row) => ({ agent: row.agent, deleted: row.lastRun?.deleted, failures: row.lastRun?.failures.length })),
        storeUnchanged: JSON.stringify(historyFixture.storeFiles()) === JSON.stringify(historyStoreBefore),
        view: historySettledView
      }
    }
    console.error(`[BMN] self-test phase: agent history ${JSON.stringify(agentHistory)}`)
    const learnedFolders = [historyFixture.claudeHome, historyFixture.glm, historyFixture.work]
    const pendingFolder = (path: string, current: number | null) => agentHistory.pending.folders
      .some((folder) => folder.path === path && folder.current === current && folder.target === 30 && folder.pending)
    if (!agentHistory.pending.needsConfirmation || !pendingFolder(historyFixture.claudeHome, null) ||
      !pendingFolder(historyFixture.glm, 90) || !pendingFolder(historyFixture.work, null) ||
      JSON.stringify(agentHistory.pending.agents) !== JSON.stringify([
        { agent: 'codex', state: 'managed', sessions: 3, candidates: 1 }, { agent: 'opencode', state: 'managed', sessions: 3, candidates: 1 },
        { agent: 'cursor', state: 'own' }]) ||
      !historyPendingView.rows.includes('Cursor | keeps its own history · not managed by BMN') ||
      !historyPendingView.dot || historyPendingView.confirm !== 'Sets 3 Claude folders to 30 days; deletes 2 sessions for good.' ||
      !historyPendingView.rows.some((row) => row.startsWith('GLM | ') && row.endsWith('90 days → 30 days')) ||
      agentHistory.settled.needsConfirmation || historySettledView.dot || historySettledView.confirm !== null ||
      JSON.stringify(agentHistory.settled.days) !== '[30,30,30]' || JSON.stringify(agentHistory.settled.backups) !== '[1,1,1]' ||
      !agentHistory.settled.glmEnvKept ||
      JSON.stringify(agentHistory.settled.codexCalls) !== JSON.stringify([`${historyFixture.home}|delete --force ${historyFixture.ids.oldCodex}`]) ||
      JSON.stringify(agentHistory.settled.openCodeCalls) !== JSON.stringify([`${historyFixture.home}|session delete ${historyFixture.ids.oldOpenCode} --pure`]) ||
      JSON.stringify(agentHistory.settled.runs) !== '[{"agent":"codex","deleted":1,"failures":0},{"agent":"opencode","deleted":1,"failures":0},{"agent":"cursor"}]' ||
      agentHistory.settled.cursorCalls.length !== 0 ||
      !agentHistory.settled.storeUnchanged || learnedFolders.some((folder) => !historySettled.claude.some((row) => row.path === folder && !row.pending))) {
      throw new Error(`agent history went wrong: ${JSON.stringify(agentHistory)}`)
    }
    // The owner's own hand edit, made while BMN runs: after the restart it must show, not be undone.
    writeFileSync(join(historyFixture.glm, 'settings.json'), '{\n  "cleanupPeriodDays": 14\n}\n')

    // Close details and return selection to the lifecycle fixture the restart checks expect.
    await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('.session-inspector .panel-heading button')?.click();
      const row = document.querySelector('.session-row button[data-session-id="' + ${JSON.stringify(preloadProbe.templateCreatedSession.sessionId)} + '"]');
      if (!row) throw new Error('the lifecycle fixture disappeared after the model origin phase');
      row.click();
    })()`)

    const afterRenderer = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    // The voice flow stops and starts the destination session once, the hook-reported Codex phase
    // starts two sessions and resumes one, the terminal-mode program adds one, and Epic 16/18's
    // three synthetic sessions plus OpenCode Resume add four; the new OpenCode routing and repeat
    // fixtures add two more incarnations, and all are stopped again. Epic 29's model-origin run adds
    // one live incarnation that the application restart below interrupts.
    // Epic 30.2's remote-answer stand-in adds one more incarnation, stopped before this check.
    // Epic 31.3's Cursor phase adds three (direct, typed into a shell, resumed), all stopped.
    // Story 32.3's armed shell adds one more, stopped after its reset.
    if (afterRenderer.liveSessions !== 4 || afterRenderer.incarnationRecords !== 21) {
      throw new Error(`renderer restart duplicated or stopped a process: ${afterRenderer.liveSessions} live, ${afterRenderer.incarnationRecords} incarnations`)
    }
    // "What survives", renderer-crash row: the processes, the layout and the open requests outlive the view.
    const survivingRendererCrash = {
      liveProcesses: afterRenderer.liveSessions,
      incarnationRecords: afterRenderer.incarnationRecords,
      openRequestsBefore: openRequestsBeforeRendererRestart,
      openRequestsAfter: await openRequestCount()
    }
    if (!(survivingRendererCrash.openRequestsBefore > 0) ||
      survivingRendererCrash.openRequestsAfter !== survivingRendererCrash.openRequestsBefore) {
      throw new Error(`open requests did not outlive the renderer crash: ${JSON.stringify(survivingRendererCrash)}`)
    }
    const archivedStillLive = afterRenderer.sessions.some(
      (candidate) => candidate.sessionId === thirdSession.sessionId && candidate.state === 'live'
    )
    if (!archivedStillLive || !showArchivedReachable) {
      throw new Error('archive-refused running session was not reachable')
    }
    if (archivedWorkspace.archivedAt !== null) throw new Error('live workspace was archived despite host refusal')
    const expectedBindings = await Promise.all(identities.map((identity) =>
      client.request(METHOD_REGISTRY.sessionBindingGet, { sessionId: identity.sessionId })
    ))

    console.error('[BMN] self-test phase: application restart')
    const firstHostAbandoned = new Promise<void>((resolveAbandoned) => {
      const onMessage = (message: unknown): void => {
        if (
          message &&
          typeof message === 'object' &&
          (message as { kind?: unknown }).kind === 'host-loss-self-test-ready'
        ) {
          client.process.off('message', onMessage)
          resolveAbandoned()
        }
      }
      client.process.on('message', onMessage)
    })
    console.error('[BMN] self-test phase: terminating first host')
    await client.request(METHOD_REGISTRY.healthGet, { selfTestHostLoss: true })
    console.error('[BMN] self-test phase: first host termination requested')
    await Promise.race([
      firstHostAbandoned,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('self-test host termination timed out')), 5_000))
    ])
    console.error('[BMN] self-test phase: first host released its database')
    host.applicationWindow.webContents.postMessage('aiterm:startup', {
      ok: false,
      code: ERROR_CODES.ioError,
      message: 'The self-test simulated application restart'
    })
    await host.applicationWindow.webContents.executeJavaScript(
      'new Promise((resolve) => setTimeout(resolve, 0))'
    )
    clientClosed = true
    host.hostClient = undefined
    host.hostRendererPort = undefined
    host.runtimes.clear()
    host.processTracking.unconfirmedExits.clear()
    host.sessionRecords.clear()

    const restarted = await host.launchHostWithChannel()
    console.error('[BMN] self-test phase: restarted host ready')
    host.applicationWindow.hide()
    client = restarted.client
    client.onAppEvent((message) => host.appEvents.forward(message))
    clientClosed = false
    applicationPort = restarted.applicationPort
    const restoredWorkspaces = await client.request<WorkspaceRecord[]>(METHOD_REGISTRY.workspaceList, {
      includeArchived: true
    })
    const restoredDefaultSessions = await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
      workspaceId: DEFAULT_WORKSPACE_ID
    })
    const restoredArchivedSessions = await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, {
      workspaceId: secondWorkspace.workspaceId
    })
    const { layout: restoredLayout } = await client.request<LayoutGetResult>(METHOD_REGISTRY.layoutGet, {
      workspaceId: DEFAULT_WORKSPACE_ID
    })
    const restoredHealth = await client.request<HostHealth>(METHOD_REGISTRY.healthGet, {})
    const restoredSettings = await client.request<AppSettings>(METHOD_REGISTRY.settingsGet, {})
    const voicePersistedAfterRestart =
      JSON.stringify(restoredSettings.voice.vocabulary) === JSON.stringify([...preloadProbe.voiceFlow.approvedAfterRemove, 'Changed'])
    if (!voicePersistedAfterRestart) {
      throw new Error(`the voice vocabulary did not survive the restart: ${JSON.stringify(restoredSettings.voice)}`)
    }
    const restoredDrafts = await client.request<InputDraftRecord[]>(METHOD_REGISTRY.draftList, {})
    const restoredHandoff = restoredDrafts.find((draft) => draft.draftId === preloadProbe.handoffFlow.draftId)
    console.error('[BMN] self-test phase: restored state queried')
    const restoredBindings = await Promise.all(identities.map((identity) =>
      client.request(METHOD_REGISTRY.sessionBindingGet, { sessionId: identity.sessionId })
    ))
    const persistedBindingView = (value: unknown): unknown => {
      const binding = value as ExplicitConversationBinding
      return {
        sessionId: binding.sessionId,
        agentCli: binding.agentCli,
        conversationReference: binding.conversationReference,
        captureRoute: binding.captureRoute,
        launchContext: binding.launchContext,
        capturedAt: binding.capturedAt
      }
    }
    if (
      restoredHealth.liveSessions !== 0 ||
      restoredHealth.runningIncarnations !== 0 ||
      restoredHealth.interruptedIncarnations !== 5
    ) {
      throw new Error('application restart did not interrupt every prior live incarnation')
    }
    // The sessions stopped before the restart are exited, not interrupted: only what the restart
    // itself ended is interrupted here.
    const priorLiveSessions = [...restoredDefaultSessions, ...restoredArchivedSessions]
      .filter((record) => !stoppedBeforeRestartSessionIds.has(record.sessionId))
    if (!priorLiveSessions.every((record) =>
      record.lastProcess?.state === 'interrupted' &&
      record.lastProcess.exitCode === null &&
      record.lastProcess.signal === null
    )) {
      throw new Error('session.list did not report the interrupted incarnation after application restart')
    }
    const openRequestsAfterApplicationRestart = await openRequestCount()
    if (openRequestsAfterApplicationRestart !== survivingRendererCrash.openRequestsAfter) {
      throw new Error(`open requests did not outlive the application restart: ${openRequestsAfterApplicationRestart} ` +
        `after, ${survivingRendererCrash.openRequestsAfter} before`)
    }
    const lifecycleStoppedAfterRestart = restoredDefaultSessions.find(
      (record) => record.sessionId === preloadProbe.templateCreatedSession.sessionId
    )?.lastProcess
    if (
      lifecycleStoppedAfterRestart?.state !== 'interrupted' ||
      lifecycleStoppedAfterRestart.detail !== lifecycleStoppedBeforeRestart.detail
    ) {
      throw new Error(
        `application-quit interruption source did not survive restart: ${JSON.stringify(lifecycleStoppedAfterRestart)}`
      )
    }
    if (
      restoredWorkspaces.length !== 3 ||
      restoredDefaultSessions.filter((item) => !stoppedBeforeRestartSessionIds.has(item.sessionId) &&
        item.sessionId !== originSession.sessionId)
        .map((item) => item.sessionId).join(',') !==
        defaultSessionsAfterLifecycleStop.map((item) => item.sessionId).join(',') ||
      restoredArchivedSessions[0]?.sessionId !== thirdSession.sessionId ||
      restoredLayout.selectedSessionId !== preloadProbe.templateCreatedSession.sessionId ||
      restoredLayout.sessionView[session.sessionId]?.scrollLine !== 19 ||
      restoredLayout.sessionView[session.sessionId]?.followTail !== false ||
      JSON.stringify(restoredBindings.map(persistedBindingView)) !==
        JSON.stringify(expectedBindings.map(persistedBindingView)) ||
      restoredHandoff?.state !== 'accepted' ||
      restoredHandoff.detail !== 'Pasted to terminal — not submitted' ||
      !restoredHandoff.artifactIds.includes(handoffArtifact.artifactId) ||
      restoredHandoff.attemptedIncarnationId === null
    ) {
      throw new Error('workspace/session order, layout, or bindings did not restore')
    }
    host.hostClient = client
    host.hostRendererPort = applicationPort
    host.trackSessionProcessStates(client)
    await host.recoverApplicationRenderer(host.applicationWindow)
    // The interrupted process is the selected dormant row after restart: its name quiets,
    // while selection still has the identity bar, selected fill and stronger weight.
    const interruptedSidebarAcceptance = await acceptanceWait(async () =>
      await host.applicationWindow!.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('.session-row.selected > button[data-session-id="${preloadProbe.templateCreatedSession.sessionId}"]');
        const row = button?.closest('.session-row');
        const name = row?.querySelector('.session-name');
        if (!button || !row || !name) return undefined;
        const probe = document.createElement('span');
        probe.style.color = 'var(--muted)';
        probe.style.borderLeft = '2px solid var(--identity)';
        probe.style.backgroundColor = 'var(--selected)';
        document.body.append(probe);
        const tokens = getComputedStyle(probe);
        const result = { live: row.getAttribute('data-live'), nameColor: getComputedStyle(name).color,
          muted: tokens.color, weight: getComputedStyle(name).fontWeight,
          bar: getComputedStyle(button).borderLeftColor, identity: tokens.borderLeftColor,
          fill: getComputedStyle(button).backgroundColor, selected: tokens.backgroundColor };
        probe.remove();
        // Recovery posts startup before the renderer finishes its first selected-row paint.
        return result.bar === result.identity && result.fill === result.selected ? result : undefined;
      })()`), 'interrupted selected sidebar row') as {
        live: string; nameColor: string; muted: string; weight: string
        bar: string; identity: string; fill: string; selected: string
      }
    if (lifecycleStoppedAfterRestart?.state !== 'interrupted' ||
      interruptedSidebarAcceptance.live !== 'false' ||
      interruptedSidebarAcceptance.nameColor !== interruptedSidebarAcceptance.muted ||
      interruptedSidebarAcceptance.weight !== '500' ||
      interruptedSidebarAcceptance.bar !== interruptedSidebarAcceptance.identity ||
      interruptedSidebarAcceptance.fill !== interruptedSidebarAcceptance.selected) {
      throw new Error(`the selected interrupted row lost its dormant or selection styling: ${JSON.stringify(interruptedSidebarAcceptance)}`)
    }
    console.error(`[BMN] self-test phase: interrupted selected sidebar ${JSON.stringify(interruptedSidebarAcceptance)}`)
    // Epic 12.1 AC4: the link and its name are still there after the database was closed and reopened.
    const restoredEvidence = (await client.request<ProgressRecord[]>(METHOD_REGISTRY.progressList, {}))
      .find((record) => record.sessionId === session.sessionId && record.source === 'evidence')
    if (
      restoredEvidence?.state !== 'verified' ||
      JSON.stringify(restoredEvidence.evidence) !== JSON.stringify(progressEvidence?.links)
    ) {
      throw new Error(
        `progress evidence did not survive the restart: ${JSON.stringify(restoredEvidence?.evidence)}`
      )
    }
    const stoppedStaleProgress = await stoppedPanelProgress(host.applicationWindow, secondSession.sessionId)
    if (
      !stoppedStaleProgress.includes('Observed self-test failure') ||
      !stoppedStaleProgress.includes('Last observed failed') ||
      !stoppedStaleProgress.includes('stale') ||
      !stoppedStaleProgress.includes('self-test')
    ) {
      throw new Error(`stale current-incarnation progress did not survive into the stopped view: ${stoppedStaleProgress}`)
    }
    // Epic 29 AC3: the restart dropped every origin; the next hook of the new run, not a SessionStart,
    // brings the flag back. After every restored-state check, so no count above sees this run.
    console.error('[BMN] self-test phase: model origin after restart')
    const originRelaunched = await host.applicationWindow.webContents.executeJavaScript(
      `window.aiTerminal.relaunchSession(${JSON.stringify(originSession.sessionId)})`
    ) as { incarnationId: string }
    await host.recoverApplicationRenderer(host.applicationWindow)
    const originBeforeHook = await modelOriginProbe(host.applicationWindow, originSession.sessionId, 'Model origin', null)
    // The next unused gate: the agent history phase fired two more after the origin scenarios.
    await fireOriginGate(originDirectory, readdirSync(originDirectory).filter((name) => name.startsWith('done-')).length,
      { baseUrl: 'https://api.z.ai/api/anthropic', model: null, event: 'PostToolUse' })
    const originAfterHook = await modelOriginProbe(host.applicationWindow, originSession.sessionId, 'Model origin', 'via api.z.ai')
    await client.request(METHOD_REGISTRY.sessionStop, { sessionId: originSession.sessionId,
      incarnationId: originRelaunched.incarnationId, cause: 'explicit' })
    const originStopped = await acceptanceWait(async () => {
      const seen = await modelOriginProbe(host.applicationWindow!, originSession.sessionId, 'Model origin', null)
      return seen.rowFlag === null ? seen : undefined
    }, 'stopped model origin row')
    await host.applicationWindow.webContents.executeJavaScript(
      `document.querySelector('.session-inspector .panel-heading button')?.click()`)
    const modelOriginAfterRestart = { before: originBeforeHook, after: originAfterHook, stopped: originStopped }
    if (originBeforeHook.rowFlag !== null || originBeforeHook.paneFlag !== null || originBeforeHook.modelRow !== null ||
      originBeforeHook.rowChip !== 'Shell' || originAfterHook.rowChip !== 'Claude' || originStopped.rowChip !== 'Shell' ||
      originAfterHook.rowFlag !== '🇨🇳' || originAfterHook.paneFlag !== '🇨🇳' ||
      originAfterHook.rowLabel !== 'Model origin: China via api.z.ai' ||
      originStopped.paneFlag !== null || originStopped.inspectorFlag !== null || originStopped.modelRow !== null) {
      throw new Error(`the model origin did not follow the restart: ${JSON.stringify(modelOriginAfterRestart)}`)
    }
    // Epic 31: the owner's hand edit survived the restart as a pending row with the dot, and was not rewritten.
    console.error('[BMN] self-test phase: agent history after restart')
    const historyAfterRestart = await client.request<AgentHistoryStatus>(METHOD_REGISTRY.historyStatus, {})
    const driftedFolder = historyAfterRestart.claude.find((folder) => folder.path === historyFixture?.glm)
    const historyAfterRestartView = await historyView(host.applicationWindow, 'read')
    const historyDrift = { needsConfirmation: historyAfterRestart.needsConfirmation, folder: driftedFolder ?? null,
      onDisk: historyFixture ? claudeDays(historyFixture.glm) : null, view: historyAfterRestartView }
    console.error(`[BMN] self-test phase: agent history after restart ${JSON.stringify(historyDrift)}`)
    if (!historyDrift.needsConfirmation || driftedFolder?.currentDays !== 14 || !driftedFolder.pending || historyDrift.onDisk !== 14 ||
      !historyAfterRestartView.dot || !historyAfterRestartView.rows.some((row) => row.startsWith('GLM | ') && row.endsWith('14 days → 30 days'))) {
      throw new Error(`agent history drift went wrong after the restart: ${JSON.stringify(historyDrift)}`)
    }
    // A dedicated live session on the restarted host, after every restored-state check, so no
    // earlier count, order or receipt value sees it.
    console.error('[BMN] self-test phase: renderer live exit feedback')
    const { startup: liveExitCreated } = await host.createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Live exit shell',
      cwd: isolatedCwd,
      executable: typedShell.executable,
      argv: [...typedShell.argv],
      cols: 80,
      rows: 24
    }, true)
    await host.recoverApplicationRenderer(host.applicationWindow)
    const liveExitRuntime = host.runtimes.get(liveExitCreated.sessionId)
    if (!liveExitRuntime) throw new Error('the live exit session has no renderer runtime')
    const rendererInverseTextContrast = await inverseTextContrast(host.applicationWindow, {
      sessionId: liveExitRuntime.session.sessionId,
      attachmentId: liveExitRuntime.attachment.attachmentId,
      name: liveExitRuntime.name
    })
    if (rendererInverseTextContrast < 4.5) {
      throw new Error(`reverse-video terminal text rendered at contrast ${rendererInverseTextContrast.toFixed(2)}, below 4.5`)
    }
    const rendererLiveExitLabel = await liveExitPaneLabel(host.applicationWindow, {
      attachmentId: liveExitRuntime.attachment.attachmentId,
      name: liveExitRuntime.name
    })
    if (rendererLiveExitLabel !== `Process exited · code 23 · ${liveExitRuntime.cwd}`) {
      throw new Error(
        `the live pane did not render the observed exit label: ${JSON.stringify(rendererLiveExitLabel)}`
      )
    }
    // The row the owner actually scans must stop calling a dead process live, without a restart.
    const rendererLiveExitSidebarWord = await sidebarSessionWord(host.applicationWindow, {
      sessionId: liveExitCreated.sessionId
    })
    if (rendererLiveExitSidebarWord !== 'Process exited') {
      throw new Error(
        `the sidebar row did not follow the exit: ${JSON.stringify(rendererLiveExitSidebarWord)}`
      )
    }
    console.error('[BMN] self-test phase: renderer recovery after shell exit')
    const exitRecordDeadline = Date.now() + 5_000
    while (
      (await loadWorkspaceStartup(client)).sessions
        .find((item) => item.sessionId === liveExitCreated.sessionId)?.lastProcess?.state !== 'exited'
    ) {
      if (Date.now() >= exitRecordDeadline) throw new Error('the live exit session did not record its exit')
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    const rendererPortBeforeExitRecovery = host.hostRendererPort
    await host.recoverApplicationRenderer(host.applicationWindow)
    if (host.hostRendererPort === rendererPortBeforeExitRecovery) {
      throw new Error('renderer recovery after a shell exit did not complete')
    }
    if (host.runtimes.has(liveExitCreated.sessionId)) {
      throw new Error('the exited session is still a renderer runtime after recovery')
    }
    const recoveredExitLabel = await recoveredStoppedLabel(host.applicationWindow, {
      sessionId: liveExitCreated.sessionId,
      name: liveExitRuntime.name
    })
    if (recoveredExitLabel !== `Process exited · code 23 · ${liveExitRuntime.cwd}`) {
      throw new Error(
        `the recovered workspace did not show the exited session as stopped: ${JSON.stringify(recoveredExitLabel)}`
      )
    }

    // Epic 14.1: the working/idle word the shell observes, from real output and real titles, with
    // nothing derived acting. Each fixture waits on a gate file, so its clock starts after the
    // renderer holds the session and the first byte lands where the assertions expect it.
    console.error('[BMN] self-test phase: observed session activity')
    const activityGate = join(isolatedCwd, 'activity-gate')
    const gated = (body: string): string[] => [
      '--noprofile',
      '--norc',
      '-c',
      `while [ ! -f ${JSON.stringify(activityGate)} ]; do sleep 0.05; done; ${body}`
    ]
    // PowerShell forms of the same output and pacing; titles go out as UTF-8 OSC 0 sequences.
    const powerShellGated = (body: string): string[] => ['-NoLogo', '-NoProfile', '-Command',
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; while (-not (Test-Path -LiteralPath ${powerShellQuote(activityGate)})) ` +
      `{ Start-Sleep -Milliseconds 50 }; ${body}`]
    const title = (text: string): string => `[Console]::Write([char]27 + ']0;' + ${powerShellQuote(text)} + [char]7 + [char]10)`
    const dots = (count: number, milliseconds: number): string =>
      `1..${count} | ForEach-Object { Write-Output '.'; Start-Sleep -Milliseconds ${milliseconds} }`
    const activityFixtures = typedShell.windows ? [
      ['burst', 'Activity burst', powerShellGated(
        "1..8 | ForEach-Object { Write-Output 'x'; Start-Sleep -Milliseconds 200 }; Write-Output 'DONE'; Start-Sleep 300")],
      ['silent', 'Activity silent', ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep 300']],
      ['late', 'Activity late first byte', powerShellGated("Start-Sleep 1; Write-Output 'FIRST'; Start-Sleep 300")],
      ['titled', 'Activity titles', powerShellGated(
        `${title('\u2733 x')}; Start-Sleep 4; ${title('Action Required x')}; Start-Sleep 4; ${title('\u2733 y')}; ${dots(200, 50)}`)],
      ['flood', 'Activity flood', powerShellGated(`${dots(1200, 10)}; Start-Sleep 300`)]
    ] as const : [
      // Prints every 200 ms, then stops: Working while it prints, Idle 1.5-2.0 s after the last byte.
      ['burst', 'Activity burst', gated("for index in $(seq 1 8); do printf 'x\\n'; sleep 0.2; done; printf 'DONE\\n'; sleep 300")],
      // Never prints: Running for the start grace, then Idle, and never Working.
      ['silent', 'Activity silent', ['--noprofile', '--norc', '-c', 'sleep 300']],
      // First byte inside the 3 s grace: Working at once, and never Running again.
      ['late', 'Activity late first byte', gated("sleep 1; printf 'FIRST\\n'; sleep 300")],
      // The two titles the table knows, each while otherwise silent, then output under a known title.
      ['titled', 'Activity titles', gated(
        "printf '\\033]0;\u2733 x\\007\\n'; sleep 4; printf '\\033]0;Action Required x\\007\\n'; sleep 4; " +
        "printf '\\033]0;\u2733 y\\007\\n'; for index in $(seq 1 200); do printf '.\\n'; sleep 0.05; done"
      )],
      // A ~100 Hz source: the presented word must still change at most twice a second.
      ['flood', 'Activity flood', gated("for index in $(seq 1 1200); do printf '.\\n'; sleep 0.01; done; sleep 300")]
    ] as const
    const activityIds: Record<string, string> = {}
    for (const [key, name, argv] of activityFixtures) {
      const created = await host.createSessionRuntime({
        workspaceId: DEFAULT_WORKSPACE_ID,
        name,
        cwd: isolatedCwd,
        executable: typedShell.executable,
        argv: [...argv],
        cols: 80,
        rows: 24
      }, true)
      activityIds[key] = created.session.sessionId
    }
    await host.recoverApplicationRenderer(host.applicationWindow)
    // The gate opens only once the renderer holds every fixture: output before the pane exists is
    // output the shell never observes, and the assertions below measure from the first byte.
    await host.applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const ids = Object.values(${JSON.stringify(activityIds)});
        const deadline = Date.now() + 15000;
        const probe = () => {
          const words = window.__bmnActivity?.words() ?? {};
          const hook = window.__aitermTest;
          const ready = hook && ids.every((id) => {
            if (words[id] === undefined) return false;
            try { return hook.snapshot(id) !== null } catch { return false }
          });
          if (ready) resolve(true);
          else if (Date.now() >= deadline) reject(new Error('the activity fixtures never reached the renderer'));
          else setTimeout(probe, 25);
        };
        probe();
      })
    `)
    const activityWindowMs = 10_500
    const activitySampling = host.applicationWindow.webContents.executeJavaScript(`
      (async () => {
        const ids = ${JSON.stringify(activityIds)};
        const probe = window.__bmnActivity;
        const hook = window.__aitermTest;
        if (!probe || !hook) throw new Error('the activity probes are unavailable');
        const entries = Object.entries(ids);
        const snapshotOf = (id) => { try { return hook.snapshot(id) } catch { return null } };
        const shapeOf = (id) => {
          const snapshot = snapshotOf(id);
          return snapshot === null ? null : {
            cols: snapshot.cols, rows: snapshot.rows, refits: snapshot.refits, inputEvents: snapshot.inputEvents
          };
        };
        const byKey = (read) => Object.fromEntries(entries.map(([key, id]) => [key, read(id)]));
        const before = byKey(shapeOf);
        const attentionBefore = (await window.aiTerminal.listAttention()).length;
        const samples = [];
        const until = Date.now() + ${activityWindowMs};
        while (Date.now() < until) {
          const words = probe.words();
          const titles = probe.titles();
          const burst = snapshotOf(ids.burst);
          samples.push({
            at: Date.now(),
            words: byKey((id) => words[id] ?? null),
            titles: byKey((id) => titles[id] ?? null),
            burstDone: burst !== null && burst.bufferLines.join('').includes('DONE')
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const updates = probe.updates();
        return {
          samples,
          attentionBefore,
          attentionAfter: (await window.aiTerminal.listAttention()).length,
          updates: byKey((id) => updates[id] ?? 0),
          before,
          after: byKey(shapeOf),
          burstBuffer: ((snapshotOf(ids.burst) ?? {}).bufferLines ?? []).join('|').slice(0, 300)
        };
      })()
    `) as Promise<ActivitySampling>
    writeFileSync(activityGate, '')
    console.error(`[BMN] self-test phase: activity gate ${activityGate} exists=${existsSync(activityGate)}`)
    const gateAt = Date.now()
    const activity = await activitySampling
    const wordAt = (offset: number, key: string): string | null => {
      const target = gateAt + offset
      const closest = activity.samples.reduce((best, candidate) =>
        Math.abs(candidate.at - target) < Math.abs(best.at - target) ? candidate : best)
      return closest.words[key] ?? null
    }
    const wordsOf = (key: string): (string | null)[] => activity.samples.map((sample) => sample.words[key] ?? null)
    const burstDoneAt = activity.samples.find((sample) => sample.burstDone)?.at ?? null
    const burstWord = (offset: number): string | null => {
      const target = (burstDoneAt ?? gateAt) + offset
      const closest = activity.samples.reduce((best, candidate) =>
        Math.abs(candidate.at - target) < Math.abs(best.at - target) ? candidate : best)
      return closest.words.burst ?? null
    }
    const lateWords = wordsOf('late')
    const lateWorking = lateWords.indexOf('Working')
    const silentWords = wordsOf('silent')
    const silentIdle = silentWords.indexOf('Idle')
    const sessionActivity = {
      burstLastByteAfterGateMs: burstDoneAt === null ? null : burstDoneAt - gateAt,
      // AC1: Working at 1.0 s of silence, Idle by 2.5 s.
      burstAfterOneSecond: burstWord(1_000),
      burstAfterTwoAndAHalf: burstWord(2_500),
      // AC1: a silent fresh incarnation reads Running, then Idle, and never Working.
      silentEarly: wordAt(500, 'silent'),
      silentLate: wordAt(4_500, 'silent'),
      silentEverWorking: silentWords.includes('Working'),
      silentRunningAfterIdle: silentIdle === -1 ? true : silentWords.slice(silentIdle).includes('Running'),
      // AC1: the first byte wins inside the grace, and Running never comes back.
      lateBeforeFirstByte: lateWords.slice(0, lateWorking === -1 ? 0 : lateWorking),
      lateRunningAfterOutput: lateWorking === -1 ? true : lateWords.slice(lateWorking).includes('Running'),
      lateAfterFourSeconds: wordAt(4_000, 'late'),
      // AC2: a known title names the resting word, is shown, and never makes a session working.
      titledResting: wordAt(2_500, 'titled'),
      titledRestingTitle: activity.samples.reduce((best, candidate) =>
        Math.abs(candidate.at - (gateAt + 2_500)) < Math.abs(best.at - (gateAt + 2_500)) ? candidate : best).titles.titled,
      titledActionRequired: wordAt(6_500, 'titled'),
      titledWhilePrinting: wordAt(9_500, 'titled'),
      // AC4: at most two presentation updates per second per session, even at ~100 Hz.
      updates: activity.updates,
      updateCap: Math.ceil((activityWindowMs / 1_000) * 2),
      // AC4: nothing derived writes to a PTY, refits a terminal or touches a request.
      inputEvents: Object.fromEntries(Object.entries(activity.after).map(([key, shape]) => [key, shape?.inputEvents ?? null])),
      geometryUnchanged: Object.entries(activity.after).every(([key, shape]) => {
        const start = activity.before[key]
        return !!shape && !!start && shape.cols === start.cols && shape.rows === start.rows && shape.refits === start.refits
      }),
      attentionUnchanged: activity.attentionBefore === activity.attentionAfter
    }
    console.error(`[BMN] self-test phase: session activity ${JSON.stringify(sessionActivity)}`)
    console.error(`[BMN] self-test phase: activity last sample ${JSON.stringify({
      words: activity.samples.at(-1)?.words ?? null,
      titles: activity.samples.at(-1)?.titles ?? null,
      samples: activity.samples.length,
      burstBuffer: activity.burstBuffer,
      shapes: activity.before
    })}`)
    if (burstDoneAt === null) throw new Error('the activity burst session never printed its last byte')
    if (sessionActivity.burstAfterOneSecond !== 'Working' || sessionActivity.burstAfterTwoAndAHalf !== 'Idle') {
      throw new Error('output activity did not hold Working for 1.5 s of silence and then rest')
    }
    if (sessionActivity.silentEarly !== 'Running' || sessionActivity.silentLate !== 'Idle') {
      throw new Error('a silent fresh incarnation did not read Running and then Idle')
    }
    if (sessionActivity.silentEverWorking || sessionActivity.silentRunningAfterIdle) {
      throw new Error('a session that printed nothing was called working, or went back to Running')
    }
    if (lateWorking === -1 || sessionActivity.lateBeforeFirstByte.includes('Idle')) {
      throw new Error('the first byte did not make a starting session working inside its grace')
    }
    if (sessionActivity.lateRunningAfterOutput || sessionActivity.lateAfterFourSeconds !== 'Idle') {
      throw new Error('a session that has printed went back to Running')
    }
    if (sessionActivity.titledResting !== 'Idle' || sessionActivity.titledRestingTitle !== '\u2733 x') {
      throw new Error('the terminal title was not kept and shown while the session rested')
    }
    if (sessionActivity.titledActionRequired !== 'Action required') {
      throw new Error('a known title did not name the resting word')
    }
    if (sessionActivity.titledWhilePrinting !== 'Working') {
      throw new Error('a title overruled output activity')
    }
    for (const [key, count] of Object.entries(sessionActivity.updates)) {
      if (count > sessionActivity.updateCap) {
        throw new Error(`${count} activity updates for ${key}, past the throttle`)
      }
    }
    if (Object.values(sessionActivity.inputEvents).some((count) => count !== 0)) {
      throw new Error('observing activity wrote to a PTY')
    }
    if (!sessionActivity.geometryUnchanged) throw new Error('observing activity refit or remounted a terminal')
    if (!sessionActivity.attentionUnchanged) throw new Error('observing activity opened or resolved a request')

    // Epic 14.2: what opened a request and what closed it, and the log of events that says why a
    // request the owner expected never arrived. Real hook events through the installed `bmn hook`.
    /**
     * Epic 17.1: exercise the resume cohort for an update-restart stop cause. The source updater
     * waits for BMN to exit and does not issue that cause; this fixture tests the cohort UI, not
     * the `update:desktop` use site.
     */
    console.error('[BMN] self-test phase: resume after an update stop')
    const resumeOfferDirectory = join(isolatedCwd, 'resume-offer')
    const firstRecorder = writeArgvRecorder(resumeOfferDirectory, 'first-agent')
    const secondRecorder = writeArgvRecorder(resumeOfferDirectory, 'second-agent')
    const stoppedByUpdate = []
    for (const recorder of [firstRecorder, secondRecorder]) {
      const { session: record, startup: created } = await host.createSessionRuntime({
        workspaceId: DEFAULT_WORKSPACE_ID,
        name: `Update ${basename(recorder.executable)}`,
        cwd: isolatedCwd,
        executable: recorder.executable,
        argv: ['--keep-going'],
        cols: 80,
        rows: 24
      }, true)
      stoppedByUpdate.push({ record, created, recorder })
    }
    await untilHarnessRuns(firstRecorder.log, 1)
    await untilHarnessRuns(secondRecorder.log, 1)
    const updateTargets = stoppedByUpdate.flatMap(({ record }) => {
      const runtime = host.runtimes.get(record.sessionId)
      const target = runtime
        ? runningTargetForRuntime({
            ...runtime.session,
            executable: runtime.executable,
            processState: runtime.processState
          })
        : undefined
      return target ? [target] : []
    })
    if (updateTargets.length !== 2) throw new Error('the update-stop fixture did not start two sessions')
    await host.stopCurrentTargets(updateTargets, 'update-restart')
    const updateCohort = await client.request<InterruptedSessionCohort | null>(
      METHOD_REGISTRY.sessionCohortList,
      {}
    )
    if (updateCohort?.cause !== 'update-restart' || updateCohort.entries.length !== 2) {
      throw new Error(`the update stop did not form its own cohort: ${JSON.stringify(updateCohort)}`)
    }
    // The next start: a fresh window load, exactly what the owner sees after `update:desktop`.
    const reloadedAfterUpdate = waitForRendererLoad(host.applicationWindow)
    host.applicationWindow.webContents.reload()
    await reloadedAfterUpdate
    await waitForRendererHook(host.applicationWindow)
    const offerAfterUpdate = await resumeOfferShown(host.applicationWindow)
    const expectedCommands = stoppedByUpdate
      .map(({ recorder }) => `${recorder.executable} --keep-going`)
    if (
      offerAfterUpdate.heading !== 'Resume what the update stopped?' ||
      offerAfterUpdate.summary !== 'a desktop update stopped 2 sessions. Nothing has started since.' ||
      // No conversation was ever captured for these, so both rows are Start again and start unchecked.
      offerAfterUpdate.button !== 'Resume 0 sessions' ||
      JSON.stringify(offerAfterUpdate.rows.map((row) => row.command).sort()) !==
        JSON.stringify([...expectedCommands].sort()) ||
      offerAfterUpdate.rows.some((row) => row.checked)
    ) {
      throw new Error(`the resume offer did not read as expected: ${JSON.stringify(offerAfterUpdate)}`)
    }
    // Dismissed without an answer: nothing may have started, and the palette must bring it back.
    await closeResumeOffer(host.applicationWindow)
    if (harnessRuns(firstRecorder.log).length !== 1 || harnessRuns(secondRecorder.log).length !== 1) {
      throw new Error('dismissing the resume offer started a process')
    }
    const paletteReopened = await runPaletteCommand(host.applicationWindow, 'Resume interrupted sessions…')
    if (paletteReopened !== 'ran') {
      throw new Error(`the palette did not offer to reopen the dismissed offer: ${paletteReopened}`)
    }
    const reopenedOffer = await resumeOfferShown(host.applicationWindow)
    if (JSON.stringify(reopenedOffer.rows.map((row) => row.command).sort()) !==
      JSON.stringify([...expectedCommands].sort())) {
      throw new Error(`the palette reopened something else: ${JSON.stringify(reopenedOffer)}`)
    }
    const offerAnswered = await host.applicationWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const dialog = document.querySelector('dialog.resume-interrupted[open]');
        if (!dialog) { reject(new Error('the resume offer closed before it was answered')); return; }
        for (const box of dialog.querySelectorAll('input[type=checkbox]')) box.click();
        resolve(true);
      })
    `) as boolean
    if (!offerAnswered) throw new Error('the resume offer rows could not be checked')
    const offerResult = await pressResumeOffer(host.applicationWindow)
    if (offerResult.rows.some((row) => row.outcome !== 'Started')) {
      throw new Error(`a checked row did not start: ${JSON.stringify(offerResult.rows)}`)
    }
    const restartedArgv = await Promise.all([firstRecorder, secondRecorder]
      .map((recorder) => untilHarnessRuns(recorder.log, 2)))
    if (!restartedArgv.every((runs) => JSON.stringify(runs[1]) === JSON.stringify(['--keep-going']))) {
      throw new Error(`the started rows ran something else: ${JSON.stringify(restartedArgv)}`)
    }
    await closeResumeOffer(host.applicationWindow)
    // A second start must not ask again: the cohort was offered, and both of its rows are running.
    const reloadedAgain = waitForRendererLoad(host.applicationWindow)
    host.applicationWindow.webContents.reload()
    await reloadedAgain
    await waitForRendererHook(host.applicationWindow)
    const offerStayedAwayAfterSecondStart = await resumeOfferStaysAway(host.applicationWindow, 750)
    if (!offerStayedAwayAfterSecondStart) {
      throw new Error('the resume offer asked again after a second start')
    }
    console.error(`[BMN] self-test phase: resume after an update stop ${JSON.stringify({
      heading: offerAfterUpdate.heading,
      summary: offerAfterUpdate.summary,
      commands: offerAfterUpdate.rows.map((row) => row.command),
      startsUnchecked: offerAfterUpdate.rows.every((row) => !row.checked),
      reopenedFromPalette: reopenedOffer.rows.map((row) => row.command),
      outcomes: offerResult.rows.map((row) => row.outcome),
      argv: restartedArgv.map((runs) => runs[1] ?? null),
      quitCohortOfferedAt: quitCohortOffer.offeredAt,
      offerStayedAwayAfterRendererRestart,
      offerStayedAwayAfterSecondStart
    })}`)
    // The fixture leaves nothing running: later phases count on the sessions they started themselves.
    for (const { record } of stoppedByUpdate) {
      const runtime = host.runtimes.get(record.sessionId)
      if (!runtime) continue
      await client.request(METHOD_REGISTRY.sessionStop, {
        sessionId: runtime.session.sessionId,
        incarnationId: runtime.session.incarnationId,
        cause: 'explicit'
      })
    }

    console.error('[BMN] self-test phase: request provenance and hook events')
    const hookHarness = writeClaudeHookHarness(join(isolatedCwd, 'claude-harness'))
    const hookSession = await host.createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Hook provenance',
      cwd: isolatedCwd,
      executable: hookHarness.executable,
      argv: [],
      cols: 80,
      rows: 24
    }, true)
    const isolationHarness = writeIsolationHookHarness(join(isolatedCwd, 'isolation-harness'))
    const isolationSession = await host.createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Hook isolation',
      cwd: isolatedCwd,
      executable: isolationHarness.executable,
      argv: [],
      cols: 80,
      rows: 24
    }, true)
    await host.recoverApplicationRenderer(host.applicationWindow)
    await untilFileExists(hookHarness.opened, 'opened its first request')
    await untilFileExists(isolationHarness.fired, 'fired its own hook event')
    const requestsOf = async (): Promise<AttentionRecord[]> =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .filter((request) => request.sessionId === hookSession.session.sessionId)
    const untilRequest = async (
      what: string,
      matches: (request: AttentionRecord) => boolean
    ): Promise<AttentionRecord> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const found = (await requestsOf()).find(matches)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`the hook fixture never produced ${what}: ${JSON.stringify(await requestsOf())}`)
    }
    const openedByHook = await untilRequest('an open request', (request) => request.state === 'open')
    writeFileSync(hookHarness.toolGate, '')
    await untilFileExists(hookHarness.resolved, 'ran its tool')
    const resolvedByHook = await untilRequest(
      'a resolved request',
      (request) => request.requestId === openedByHook.requestId && request.state !== 'open'
    )
    // A second identical prompt, so the owner can answer one in the terminal instead of through a hook.
    writeFileSync(hookHarness.secondGate, '')
    await untilFileExists(hookHarness.reopened, 'reopened its request')
    const reopenedByHook = await untilRequest(
      'a second open request',
      (request) => request.requestId !== openedByHook.requestId && request.state === 'open'
    )
    const hookProvenance = await host.applicationWindow.webContents.executeJavaScript(`
      (async () => {
        const sessionId = ${JSON.stringify(hookSession.session.sessionId)};
        const otherSessionId = ${JSON.stringify(isolationSession.session.sessionId)};
        const wait = async (read, what) => {
          const deadline = Date.now() + 10000;
          for (;;) {
            const value = await read();
            if (value !== undefined && value !== null) return value;
            if (Date.now() >= deadline) throw new Error('the hook events probe timed out waiting for ' + what);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        };
        const hook = window.__aitermTest;
        const pane = await wait(() => document.querySelector('.session-terminal[data-session-id="' + sessionId + '"]'), 'the pane');
        const textarea = pane.querySelector('.xterm-helper-textarea');
        if (!textarea) throw new Error('the hook fixture pane has no terminal input');
        const openRequestsBefore = (await window.aiTerminal.listAttention()).length;
        // The pane only answers for the owner once the window itself knows the request is open.
        await wait(() => pane.querySelector('.pane-heading .status-dot.needs-you'), 'the pane to need the owner');
        // Typing into a pane that needs the owner answers its open requests, and records that it did.
        // xterm reads the legacy keyCode, so a synthetic event without one produces no key at all.
        const typeOneKey = () => textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'y', code: 'KeyY', keyCode: 89, which: 89, bubbles: true, cancelable: true
        }));
        typeOneKey();
        const answeredByTyping = await wait(async () => {
          const found = (await window.aiTerminal.listAttention())
            .find((request) => request.requestId === ${JSON.stringify(reopenedByHook.requestId)});
          if (found && found.state !== 'open') return found;
          typeOneKey();
          return undefined;
        }, 'the typed answer');
        const beforeList = hook.snapshot(sessionId).inputEvents;
        const rowMenu = await wait(() => document.querySelector('[aria-label="Actions for Hook provenance"]'), 'the row menu');
        rowMenu.click();
        const entry = await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
          .find((item) => item.textContent?.trim() === 'Hook events…'), 'the Hook events entry');
        entry.click();
        const dialog = await wait(() => document.querySelector('dialog.hook-events-dialog[open]'), 'the Hook events dialog');
        const rows = await wait(() => {
          const listed = [...dialog.querySelectorAll('.hook-events li')];
          return listed.length >= 3 ? listed.map((row) => row.textContent?.trim() ?? '') : undefined;
        }, 'the listed events');
        const events = await window.aiTerminal.listHookEvents(sessionId);
        const afterList = hook.snapshot(sessionId).inputEvents;
        dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
        const closed = await wait(() => document.querySelector('dialog.hook-events-dialog') === null ? true : undefined, 'the dialog to close');
        return {
          answeredByTypingResolvedBy: answeredByTyping.resolvedBy,
          answeredByTypingState: answeredByTyping.state,
          rows,
          events: events.map((event) => ({ event: event.event, effects: event.effects, toolName: event.toolName })),
          otherSessionEvents: (await window.aiTerminal.listHookEvents(otherSessionId))
            .map((event) => ({ event: event.event, effects: event.effects })),
          listWroteToPty: afterList !== beforeList,
          openRequestsBefore,
          openRequestsAfter: (await window.aiTerminal.listAttention()).length,
          closed
        };
      })()
    `) as HookProvenanceProbe
    const syntheticClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    const syntheticCodexConfigDir = process.env.CODEX_HOME
    const syntheticOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (!syntheticClaudeConfigDir || !syntheticCodexConfigDir || !syntheticOpenCodeConfigDir) {
      throw new Error('hook integration self-test requires isolated harness config directories')
    }
    const syntheticClaudeSettings = join(syntheticClaudeConfigDir, 'settings.json')
    mkdirSync(syntheticClaudeConfigDir, { recursive: true })
    const configuredClaudeEvents = [
      'Notification', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit',
      'Stop', 'SessionStart', 'SessionEnd'
    ]
    writeFileSync(syntheticClaudeSettings, `${JSON.stringify({ hooks: Object.fromEntries(
      configuredClaudeEvents.map((event) => [event, [{ hooks: [{ type: 'command', command: 'bmn hook claude' }] }]])
    ) }, null, 2)}\n`)
    const configBefore = readFileSync(syntheticClaudeSettings, 'utf8')
    const codexFile = join(syntheticCodexConfigDir, 'hooks.json')
    const openCodePlugin = join(syntheticOpenCodeConfigDir, 'plugins', 'bmn.ts')
    const absentBefore = !existsSync(codexFile) && !existsSync(openCodePlugin)
    const hookIntegrationUi = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read, name) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('hook integration timed out: ' + name); };
      const hookSessionId = ${JSON.stringify(hookSession.session.sessionId)};
      const beforeRequests = (await window.aiTerminal.listAttention()).length;
      const openDetails = async (name) => {
        (await wait(() => document.querySelector('[aria-label="Actions for ' + name + '"]'), name + ' menu')).click();
        (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
          .find(row => row.textContent.trim() === 'Session details'), 'Session details action')).click();
        return wait(() => document.querySelector('.session-inspector .hook-observation'), 'observation panel');
      };
      let observation = await openDetails('Hook provenance');
      await wait(() => observation.textContent.includes('Observed by BMN') ? true : null, 'observed hook');
      const observed = observation.textContent.includes('Claude Code') &&
        observation.textContent.includes('Notification') &&
        observation.textContent.includes('Hook provenance') &&
        observation.textContent.includes('run ');
      const inputBefore = window.__aitermTest.snapshot(hookSessionId).inputEvents;
      (await wait(() => [...observation.querySelectorAll('button')]
        .find(button => button.textContent === 'Open Hook events'), 'events link')).click();
      const events = await wait(() => document.querySelector('dialog.hook-events-dialog[open]'), 'hook events from observation');
      const openedEvents = await wait(() => events.textContent.includes('Notification') ? true : null, 'hook events rendered');
      events.querySelector('.app-dialog-heading button').click();
      observation = await wait(() => document.querySelector('.session-inspector .hook-observation'), 'returned observation');
      (await wait(() => [...observation.querySelectorAll('button')]
        .find(button => button.textContent === 'Check configured hooks in Preferences'), 'configuration link')).click();
      const preferences = await wait(() => document.querySelector('dialog.preferences-dialog[open]'), 'Preferences');
      const limit = preferences.textContent.includes('Configured entries do not prove hooks fired.') &&
        preferences.textContent.includes('trust hooks with /hooks');
      (await wait(() => [...preferences.querySelectorAll('button')]
        .find(button => button.textContent === 'Check configured hooks'), 'check button')).click();
      const report = await wait(() => preferences.querySelector('.hook-check-report'), 'dated hook check');
      const configured = report.textContent.includes('Claude Code') &&
        report.textContent.includes('Configured') && report.textContent.includes('Checked ');
      const missing = report.textContent.includes('Codex') &&
        report.textContent.includes('OpenCode') && report.textContent.includes('Cursor') && report.textContent.includes('Missing entry');
      preferences.querySelector('.app-dialog-heading button').click();
      const inputAfter = window.__aitermTest.snapshot(hookSessionId).inputEvents;
      document.querySelector('.session-inspector .panel-heading button')?.click();
      observation = await openDetails('Petition destination');
      await wait(() => observation.textContent.includes('Not observed in this run') ? true : null, 'untouched run');
      const notObserved = observation.textContent.includes('Not observed in this run') &&
        !observation.textContent.includes('Broken');
      document.querySelector('.session-inspector .panel-heading button')?.click();
      return { observed, openedEvents, configured, missing, limit, notObserved,
        ptyInputUnchanged: inputBefore === inputAfter,
        attentionUnchanged: (await window.aiTerminal.listAttention()).length === beforeRequests };
    })()`) as {
      observed: boolean; openedEvents: boolean; configured: boolean; missing: boolean;
      limit: boolean; notObserved: boolean; ptyInputUnchanged: boolean; attentionUnchanged: boolean
    }
    const hookIntegrationAcceptance = {
      ...hookIntegrationUi,
      configUnchanged: readFileSync(syntheticClaudeSettings, 'utf8') === configBefore &&
        absentBefore && !existsSync(codexFile) && !existsSync(openCodePlugin)
    }
    if (Object.values(hookIntegrationAcceptance).some((value) => value !== true)) {
      throw new Error(`hook integration view did not distinguish configured and observed: ${JSON.stringify(hookIntegrationAcceptance)}`)
    }
    for (const runtime of [hookSession, isolationSession]) {
      await client.request(METHOD_REGISTRY.sessionStop, {
        sessionId: runtime.session.sessionId,
        incarnationId: runtime.session.lastProcess?.incarnationId,
        cause: 'explicit'
      })
    }
    const requestProvenance = {
      openedBy: openedByHook.openedBy,
      openedResolvedBy: openedByHook.resolvedBy,
      resolvedState: resolvedByHook.state,
      resolvedBy: resolvedByHook.resolvedBy,
      typedState: hookProvenance.answeredByTypingState,
      typedResolvedBy: hookProvenance.answeredByTypingResolvedBy,
      hookEvents: hookProvenance.events,
      listedRows: hookProvenance.rows,
      otherSessionEvents: hookProvenance.otherSessionEvents,
      listWroteToPty: hookProvenance.listWroteToPty,
      openRequestsUnchanged: hookProvenance.openRequestsBefore === hookProvenance.openRequestsAfter,
      dialogClosed: hookProvenance.closed
    }
    console.error(`[BMN] self-test phase: request provenance ${JSON.stringify(requestProvenance)}`)
    if (requestProvenance.openedBy !== 'hook:claude:Notification') {
      throw new Error(`the hook-opened request did not record its event: ${requestProvenance.openedBy}`)
    }
    if (requestProvenance.openedResolvedBy !== null) {
      throw new Error('an open request already carried a resolver')
    }
    if (requestProvenance.resolvedState !== 'answered' ||
      requestProvenance.resolvedBy !== 'hook:claude:PostToolUse') {
      throw new Error(`the tool run did not record what resolved the request: ${JSON.stringify(requestProvenance)}`)
    }
    if (requestProvenance.typedState === 'open' || requestProvenance.typedResolvedBy !== 'input') {
      throw new Error(`typing did not record that it answered: ${JSON.stringify(requestProvenance)}`)
    }
    const listedEvents = requestProvenance.hookEvents.map((event) => event.event)
    if (JSON.stringify(listedEvents) !== JSON.stringify(['Notification', 'PostToolUse', 'Notification'])) {
      throw new Error(`the hook event log did not hold the events that arrived: ${listedEvents.join(',')}`)
    }
    if (!requestProvenance.hookEvents[0]?.effects.includes('opened') ||
      !requestProvenance.hookEvents[1]?.effects.includes('answered') ||
      requestProvenance.hookEvents[1]?.toolName !== 'Bash') {
      throw new Error(`the hook event log did not say what each event changed: ${JSON.stringify(requestProvenance.hookEvents)}`)
    }
    if (!requestProvenance.listedRows.some((row) => row.includes('PostToolUse · Bash'))) {
      throw new Error(`the Hook events list did not show the events: ${JSON.stringify(requestProvenance.listedRows)}`)
    }
    // Two live sessions, each firing its own events: neither log may carry the other's.
    if (JSON.stringify(requestProvenance.otherSessionEvents) !==
      JSON.stringify([{ event: 'Isolation-Probe', effects: [] }])) {
      throw new Error(`the other session's log is not its own: ${JSON.stringify(requestProvenance.otherSessionEvents)}`)
    }
    if (listedEvents.includes('Isolation-Probe')) throw new Error('a session read another session’s hook events')
    if (requestProvenance.listWroteToPty) throw new Error('opening the Hook events list wrote to a PTY')
    if (!requestProvenance.openRequestsUnchanged) throw new Error('opening the Hook events list changed a request')
    if (!requestProvenance.dialogClosed) throw new Error('the Hook events dialog did not close on Escape')


    // The close question itself: asked inside the window, in session names, and answerable.
    console.error('[BMN] self-test phase: close prompt')
    const closePromptRuntime = host.runtimes.get(hookSession.startup.sessionId)
    if (!closePromptRuntime) throw new Error('the hook session has no runtime for the close prompt')
    const closePromptAnswer = host.askTheWindow('close', [{
      sessionId: closePromptRuntime.session.sessionId,
      incarnationId: closePromptRuntime.session.incarnationId,
      executable: closePromptRuntime.executable,
      processState: 'live'
    }])
    const closePromptShown = await closePromptDialogText(host.applicationWindow)
    const closePromptDecision = await closePromptAnswer
    const closePrompt = {
      heading: closePromptShown.heading,
      summary: closePromptShown.summary,
      rows: closePromptShown.rows,
      decision: closePromptDecision?.kind ?? 'unanswered'
    }
    console.error(`[BMN] self-test phase: close prompt ${JSON.stringify(closePrompt)}`)
    if (closePrompt.heading !== 'Close BMN?') {
      throw new Error(`the close prompt did not head with its question: ${closePrompt.heading}`)
    }
    if (closePrompt.summary !== '1 session is still running. Keep them running, or stop them.') {
      throw new Error(`the close prompt did not summarize the running work: ${closePrompt.summary}`)
    }
    // The owner's words for the session, and no identifier anywhere in the row.
    if (!closePrompt.rows[0]?.includes(closePromptRuntime.name) || closePrompt.rows.length !== 1) {
      throw new Error(`the close prompt did not name the session: ${JSON.stringify(closePrompt.rows)}`)
    }
    if (closePrompt.rows[0]?.includes(closePromptRuntime.session.sessionId)) {
      throw new Error('the close prompt showed an identifier to the owner')
    }
    if (closePrompt.decision !== 'cancel') {
      throw new Error(`the owner's answer did not reach the main process: ${closePrompt.decision}`)
    }

    // Epic 26.2: the survival-table endings no automated check had exercised. The two stops run
    // through the exact paths the window close and the Stop button drive; the sessions are the
    // long-lived fixtures whose panes are mounted, so the final capture is the real snapshot.
    console.error('[BMN] self-test phase: survival endings')
    const processRow = async (sessionId: string): Promise<SessionProcessStatus | null> =>
      (await client.request<SessionRecord[]>(METHOD_REGISTRY.sessionList, { workspaceId: DEFAULT_WORKSPACE_ID }))
        .find((row) => row.sessionId === sessionId)?.lastProcess ?? null
    const catalogFor = async (sessionId: string): Promise<SavedOutputCatalog> =>
      await client.request<SavedOutputCatalog>(METHOD_REGISTRY.terminalSavedOutputGet, { sessionId })
    const savedCurrent = async (sessionId: string): Promise<string | null> =>
      (await catalogFor(sessionId)).current?.content ?? null

    /**
     * The renderer also takes activity captures after output, so a marker in saved output alone
     * cannot prove the lifecycle flush ran. The self-test recorder observes only calls made by
     * flushAllSavedOutput through the production lifecycle, and only counts an acknowledged
     * capture for this exact session after the ending begins.
     */
    const stopWithFinalCapture = async (
      sessionId: string,
      marker: string,
      stop: () => Promise<unknown> | void,
      description: string
    ): Promise<void> => {
      const catalog = await catalogFor(sessionId)
      if ([catalog.current, ...catalog.history].some((entry) => entry?.content.includes(marker))) {
        throw new Error(`the ${marker} marker already exists in the saved output`)
      }
      const runtime = host.runtimes.get(sessionId)
      if (!runtime) throw new Error(`the ${marker} target runtime is missing`)
      await client.request(METHOD_REGISTRY.terminalWrite, {
        attachmentId: runtime.attachment.attachmentId,
        bytes: new TextEncoder().encode(`echo ${marker}\r`)
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
      const firstCapture = taps.lifecycleCaptures.length
      await stop()
      await acceptanceWait(async () =>
        taps.lifecycleCaptures.slice(firstCapture).some((entry) =>
          entry.sessionId === sessionId && entry.status === 'saved') ? true : undefined,
        `the ${description} lifecycle acknowledged final capture for ${sessionId}`)
      await acceptanceWait(async () =>
        (await savedCurrent(sessionId))?.includes(marker) ? true : undefined,
        `the ${description} saved output carries ${marker}`)
    }

    const openRequestIds = async (): Promise<string[]> =>
      (await client.request<AttentionRecord[]>(METHOD_REGISTRY.attentionList, {}))
        .filter((request) => request.state === 'open')
        .map((request) => request.requestId)
        .sort()

    /** A live session whose pane is mounted: its terminal is attached, so captures are real. */
    const liveMountedSession = async (label: string): Promise<string> => {
      const mounted = await host.applicationWindow!.webContents.executeJavaScript(
        `[...document.querySelectorAll('.session-terminal[data-session-id]')]
          .map((element) => element.dataset.sessionId)`
      ) as string[]
      for (const sessionId of mounted) {
        const row = await processRow(sessionId)
        if (row?.state === 'live') return sessionId
      }
      throw new Error(`no live mounted session for the ${label} trial`)
    }

    /** The production remember-a-choice path the close dialog's checkbox itself drives. */
    const rememberChoice = async (sessionId: string, choice: BackgroundChoice): Promise<void> => {
      const current = host.runtimes.get(sessionId)
      const record = host.sessionRecords.get(sessionId)
      if (!current || !record) throw new Error(`cannot remember a choice for a missing session: ${sessionId}`)
      const updated = await current.client.request<SessionRecord>(METHOD_REGISTRY.sessionUpdate, {
        sessionId,
        expectedRevision: record.revision,
        backgroundChoice: choice
      })
      host.sessionRecords.set(updated.sessionId, updated)
      current.backgroundChoice = choice
    }

    // The explicit ending runs first, on the untouched renderer; the close ending minimizes the
    // window as production does, so it runs last and the renderer is recovered after it.
    const closeStopId = await liveMountedSession('close-stop')
    const mounted = await host.applicationWindow!.webContents.executeJavaScript(
      `[...document.querySelectorAll('.session-terminal[data-session-id]')]
        .map((element) => element.dataset.sessionId)`
    ) as string[]
    let explicitId: string | undefined
    for (const sessionId of mounted) {
      if (sessionId === closeStopId || !host.sessionRecords.has(sessionId)) continue
      if ((await processRow(sessionId))?.state === 'live') { explicitId = sessionId; break }
    }
    if (!explicitId) throw new Error('no second live mounted session for the explicit-stop trial')
    const closeStopName = host.sessionRecords.get(closeStopId)?.name ?? ''
    // Ending: stop a session explicitly — an exit record, never an interruption.
    const explicitRuntime = host.runtimes.get(explicitId)
    if (!explicitRuntime) throw new Error('the explicit-stop runtime is missing')
    const explicitTarget = runningTargetForRuntime({
      ...explicitRuntime.session,
      executable: explicitRuntime.executable,
      processState: explicitRuntime.processState,
      ...(explicitRuntime.backgroundChoice
        ? { backgroundChoice: explicitRuntime.backgroundChoice }
        : {})
    })
    if (!explicitTarget) throw new Error('the explicit-stop session is not a running target')
    await stopWithFinalCapture(explicitId, 'SURVIVAL-EXPLICIT-MARKER', () =>
      host.applicationLifecycle.stopCurrentTarget(explicitTarget), 'explicit')
    const explicitRow = await acceptanceWait(async () => {
      const row = await processRow(explicitId)
      return row?.state === 'exited' && (row.exitCode !== null || row.signal !== null) ? row : undefined
    }, 'the explicit stop recorded an exit')
    const explicitStop = {
      recordedState: explicitRow?.state ?? '',
      recordedExit: explicitRow?.exitCode ?? null,
      recordedSignal: explicitRow?.signal ?? null,
      neverInterrupted: explicitRow?.state === 'exited',
      finalCaptureTookTheMarker: (await savedCurrent(explicitId))?.includes('SURVIVAL-EXPLICIT-MARKER') === true
    }
    // Read again once the exit is recorded: a later write must not have replaced the final capture.
    if (!explicitStop.finalCaptureTookTheMarker) {
      throw new Error(`the explicit stop's saved output lost its final capture: ${JSON.stringify(explicitStop)}`)
    }

    const answerTheClosePrompt = host.applicationWindow!.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const probe = () => {
          const dialog = document.querySelector('dialog.close-sessions[open]');
          if (!dialog) {
            if (Date.now() >= deadline) reject(new Error('the close prompt never appeared'));
            else setTimeout(probe, 25);
            return;
          }
          const rows = [...dialog.querySelectorAll('.close-sessions-list li')];
          for (const row of rows) {
            const wanted = row.querySelector('.name')?.textContent?.trim() === ${JSON.stringify(closeStopName)}
              ? 'Stop'
              : 'Keep running';
            const button = [...row.querySelectorAll('button')]
              .find((candidate) => candidate.textContent.trim() === wanted);
            if (button) button.click();
          }
          const proceed = [...dialog.querySelectorAll('.dialog-actions button')]
            .find((button) => button.textContent.trim() === 'Close BMN');
          if (!proceed) { reject(new Error('the close prompt has no Close BMN button')); return; }
          proceed.click();
          resolve(rows.length);
        };
        probe();
      })
    `) as Promise<number>
    let keptId: string | undefined
    for (const sessionId of host.runtimes.keys()) {
      if (sessionId === closeStopId) continue
      if ((await processRow(sessionId))?.state === 'live') { keptId = sessionId; break }
    }
    if (!keptId) throw new Error('no second live session for the kept-sibling check')
    await rememberChoice(closeStopId, 'stop')
    await rememberChoice(keptId, 'hide')
    const requestsBeforeClose = await openRequestIds()
    const closeCaptureStart = taps.lifecycleCaptures.length
    await stopWithFinalCapture(closeStopId, 'SURVIVAL-CLOSE-STOP-MARKER', async () => {
      host.applicationLifecycle.closeLastWindow({ preventDefault(): void {} })
      await answerTheClosePrompt
    }, 'close-last-window')
    const closeStopRow = await acceptanceWait(async () => {
      const row = await processRow(closeStopId)
      return row?.state === 'interrupted' && row.detail?.startsWith('last window close') ? row : undefined
    }, 'the close-stop target recorded last window close')
    const requestsAfterClose = await openRequestIds()
    const closeWindowKeep = {
      processesLive: await acceptanceWait(async () =>
        (await processRow(keptId))?.state === 'live' ? true : undefined,
        'the kept sessions stayed live') === true,
      noInterruption: (await processRow(keptId))?.state === 'live',
      noLifecycleCapture: !taps.lifecycleCaptures.slice(closeCaptureStart).some((entry) =>
        entry.sessionId === keptId
      ),
      requestsStayOpen: requestsBeforeClose.length === 0
        ? 'none-open'
        : (JSON.stringify(requestsBeforeClose) === JSON.stringify(requestsAfterClose)
          ? true
          : false)
    }
    if (!closeWindowKeep.noInterruption || !closeWindowKeep.noLifecycleCapture || closeWindowKeep.requestsStayOpen === false) {
      throw new Error(`keeping sessions on window close interrupted, captured or closed something: ${JSON.stringify(closeWindowKeep)}`)
    }
    const closeAndStop = {
      recordedInterrupted: closeStopRow?.state === 'interrupted',
      recordedDetail: closeStopRow?.detail ?? '',
      finalCaptureTookTheMarker: (await savedCurrent(closeStopId))?.includes('SURVIVAL-CLOSE-STOP-MARKER') === true,
      keptSessionStillLive: (await processRow(keptId))?.state === 'live'
    }
    if (!closeAndStop.keptSessionStillLive) {
      throw new Error(`stopping on window close stopped a session the owner kept: ${JSON.stringify(closeAndStop)}`)
    }
    if (!closeAndStop.finalCaptureTookTheMarker) {
      throw new Error(`the window-close stop's saved output lost its final capture: ${JSON.stringify(closeAndStop)}`)
    }
    // The close lifecycle minimized the window, as production does; the remaining phases need a
    // live renderer again, so the harness recovers it the same way a crash does.
    await host.recoverApplicationRenderer(host.applicationWindow!)

    console.error(`[BMN] self-test phase: survival endings ${JSON.stringify({
      closeWindowKeep, closeAndStop: { ...closeAndStop, recordedDetail: '…' }, explicitStop
    })}`)

    /**
     * Epic 15.1: a program with no BMN hook reaches Needs you through the terminal's own
     * notification sequence, and a session whose harness already reports through `bmn hook` is
     * left to that hook. Two synthetic sessions, one of each kind.
     */
    console.error('[BMN] self-test phase: terminal notices')
    const noticeCwd = join(isolatedCwd, 'terminal-notice')
    mkdirSync(noticeCwd, { recursive: true })
    const plainHarness = writeTerminalNoticeHarness(join(noticeCwd, 'plain'), { hookFirst: false })
    const plainSession = await host.createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Terminal notice',
      cwd: noticeCwd,
      executable: plainHarness.executable,
      argv: [],
      cols: 80,
      rows: 24
    }, true)
    const hookedHarness = writeTerminalNoticeHarness(join(noticeCwd, 'hooked'), { hookFirst: true })
    const hookedSession = await host.createSessionRuntime({
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Terminal notice with a hook',
      cwd: noticeCwd,
      executable: hookedHarness.executable,
      argv: [],
      cols: 80,
      rows: 24
    }, true)
    await host.recoverApplicationRenderer(host.applicationWindow)
    await untilFileExists(plainHarness.printed, 'printed its notification')
    await untilFileExists(hookedHarness.printed, 'printed its notification after its hook')
    const terminalNotice = await host.applicationWindow.webContents.executeJavaScript(`
      (async () => {
        const plainId = ${JSON.stringify(plainSession.session.sessionId)};
        const hookedId = ${JSON.stringify(hookedSession.session.sessionId)};
        const wait = async (read, what) => {
          const deadline = Date.now() + 10000;
          for (;;) {
            const value = await read();
            if (value !== undefined && value !== null) return value;
            if (Date.now() >= deadline) throw new Error('the terminal notice probe timed out waiting for ' + what);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        };
        const hook = window.__aitermTest;
        const rowsOf = async (sessionId) => (await window.aiTerminal.listAttention())
          .filter((request) => request.sessionId === sessionId && request.state === 'open');
        const opened = await wait(async () => (await rowsOf(plainId))[0], 'the terminal notice');
        // The hooked session's own hook opened a turn notice; the OSC one must add nothing to it.
        await wait(async () => (await rowsOf(hookedId)).length > 0 ? true : undefined, 'the hooked session row');
        const hookedEvents = await wait(async () => {
          const events = await window.aiTerminal.listHookEvents(hookedId);
          return events.some((event) => event.agent === 'terminal') ? events : undefined;
        }, 'the suppressed notification in the hook log');
        const pane = await wait(() => document.querySelector('.session-terminal[data-session-id="' + plainId + '"]'), 'the pane');
        // The words the owner reads: Needs you says where the row came from.
        const needsButton = await wait(() => document.querySelector('.needs-you-button'), 'the Needs you button');
        needsButton.click();
        const provenance = await wait(() => {
          const row = [...document.querySelectorAll('.attention-item')]
            .find((item) => item.querySelector('h3')?.textContent?.trim() === 'BMN self-test notice');
          return row?.querySelector('.provenance')?.textContent?.trim() || undefined;
        }, 'the provenance words');
        document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const before = hook.snapshot(plainId);
        const textarea = pane.querySelector('.xterm-helper-textarea');
        if (!textarea) throw new Error('the notice pane has no terminal input');
        const typeOneKey = () => textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'y', code: 'KeyY', keyCode: 89, which: 89, bubbles: true, cancelable: true
        }));
        typeOneKey();
        const resolved = await wait(async () => {
          const found = (await window.aiTerminal.listAttention())
            .find((request) => request.requestId === opened.requestId);
          if (found && found.state !== 'open') return found;
          typeOneKey();
          return undefined;
        }, 'the notice to be answered by typing');
        return {
          openedBy: opened.openedBy,
          title: opened.title,
          body: opened.body,
          kind: opened.kind,
          provenance,
          ptyInputEvents: before.inputEvents,
          hookedSessionRows: (await rowsOf(hookedId)).length,
          hookedSessionEvents: (await window.aiTerminal.listHookEvents(hookedId))
            .map((event) => ({ agent: event.agent, event: event.event, effects: event.effects })),
          resolvedState: resolved.state,
          resolvedBy: resolved.resolvedBy
        };
      })()
    `) as TerminalNoticeProbe
    // AC5 again, this time measured: a notice arriving into a live pane changes nothing about it.
    const beforeSecond = await host.applicationWindow.webContents.executeJavaScript(`
      (() => {
        const hook = window.__aitermTest;
        const snapshot = hook.snapshot(${JSON.stringify(plainSession.session.sessionId)});
        // Kept so the check after the notice is identity, not "some element is there".
        window.__bmnNoticeElement = document.querySelector('.session-terminal[data-session-id="${plainSession.session.sessionId}"] .xterm-screen');
        return { cols: snapshot.cols, rows: snapshot.rows, refits: snapshot.refits, inputEvents: snapshot.inputEvents };
      })()
    `) as { cols: number; rows: number; refits: number; inputEvents: number }
    writeFileSync(plainHarness.trigger, '')
    await untilFileExists(plainHarness.second, 'printed its second notification')
    terminalNotice.aroundSecondNotice = await host.applicationWindow.webContents.executeJavaScript(`
      (async () => {
        const plainId = ${JSON.stringify(plainSession.session.sessionId)};
        const before = ${JSON.stringify(beforeSecond)};
        const deadline = Date.now() + 10000;
        let row;
        for (;;) {
          row = (await window.aiTerminal.listAttention())
            .find((request) => request.sessionId === plainId && request.title === 'BMN self-test second notice');
          if (row) break;
          if (Date.now() >= deadline) throw new Error('the second terminal notice never opened');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // Give any refit or write a chance to land before reading the terminal again.
        await new Promise((resolve) => setTimeout(resolve, 250));
        const after = window.__aitermTest.snapshot(plainId);
        const element = document.querySelector('.session-terminal[data-session-id="' + plainId + '"] .xterm-screen');
        return {
          title: row.title,
          openedBy: row.openedBy,
          sameSize: after.cols === before.cols && after.rows === before.rows,
          sameElement: !!element && element.isConnected && element === window.__bmnNoticeElement,
          refits: after.refits - before.refits,
          inputEvents: after.inputEvents - before.inputEvents
        };
      })()
    `) as TerminalNoticeProbe['aroundSecondNotice']
    for (const runtime of [plainSession, hookedSession]) {
      await client.request(METHOD_REGISTRY.sessionStop, {
        sessionId: runtime.session.sessionId,
        incarnationId: runtime.session.lastProcess?.incarnationId,
        cause: 'explicit'
      })
    }
    console.error(`[BMN] self-test phase: terminal notices ${JSON.stringify(terminalNotice)}`)
    if (terminalNotice.kind !== 'notice' || terminalNotice.openedBy !== 'osc:9') {
      throw new Error(`the OSC 9 sequence did not open a notice from the terminal: ${JSON.stringify(terminalNotice)}`)
    }
    if (terminalNotice.title !== 'BMN self-test notice') {
      throw new Error(`the notice did not carry the program's own words: ${terminalNotice.title}`)
    }
    if (terminalNotice.provenance !== 'from the terminal (OSC 9)') {
      throw new Error(`Needs you did not say where the notice came from: ${terminalNotice.provenance}`)
    }
    // The sequence is consumed and answered by the window alone: the program hears nothing back.
    if (terminalNotice.ptyInputEvents !== 0) throw new Error('reading a terminal notification wrote to the PTY')
    const suppressed = terminalNotice.hookedSessionEvents.filter((event) => event.agent === 'terminal')
    if (suppressed.length !== 1 || suppressed[0]?.event !== 'osc:9' || suppressed[0]?.effects.length !== 0) {
      throw new Error(`the suppressed notification was not logged: ${JSON.stringify(terminalNotice.hookedSessionEvents)}`)
    }
    if (terminalNotice.hookedSessionRows !== 1) {
      throw new Error(`a hooked session got a second row from its terminal: ${terminalNotice.hookedSessionRows}`)
    }
    if (terminalNotice.resolvedState === 'open' || terminalNotice.resolvedBy !== 'input') {
      throw new Error(`typing did not resolve the terminal notice: ${JSON.stringify(terminalNotice)}`)
    }
    const aroundSecondNotice = terminalNotice.aroundSecondNotice
    if (aroundSecondNotice.title !== 'BMN self-test second notice' || aroundSecondNotice.openedBy !== 'osc:9' ||
      !aroundSecondNotice.sameSize || !aroundSecondNotice.sameElement || aroundSecondNotice.refits !== 0 ||
      aroundSecondNotice.inputEvents !== 0) {
      throw new Error(`a second terminal notice resized, rebuilt or wrote to its pane: ${JSON.stringify(aroundSecondNotice)}`)
    }

    console.error('[BMN] self-test phase: launch sets and repository identity')
    const launchSetRepository = await runLaunchSetRepositorySelfTest(host.applicationWindow, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      workspaceName: restoredWorkspaces.find((item) => item.workspaceId === DEFAULT_WORKSPACE_ID)!.name,
      directory: isolatedCwd,
      existingSessionId: session.sessionId
    }, {
      pauseNextSetRead: taps.pauseNextLaunchSetRead,
      startRequestCount: () => taps.launchSetStartRequests
    })
    if (!launchSetRepository.savedWithoutStart ||
        !launchSetRepository.cancelledPendingStart ||
        !launchSetRepository.equivalentDirectoryWarning ||
        !launchSetRepository.previewBranch.includes('Branch main') ||
        !launchSetRepository.changedBranchBlocked ||
        JSON.stringify(launchSetRepository.startedOrder) !== JSON.stringify(['First', 'Second', 'Third']) ||
        !launchSetRepository.selectionPreserved ||
        JSON.stringify(launchSetRepository.partialOutcomes) !== JSON.stringify(['started', 'failed', 'not-started']) ||
        launchSetRepository.retryAddedSessions !== 2 ||
        launchSetRepository.reconnectAddedSessions !== 0 ||
        !launchSetRepository.failedSessionLinked ||
        !launchSetRepository.preparationPreservedTerminals ||
        !launchSetRepository.keyboardFocusInDialog ||
        !launchSetRepository.editDeletePreservedSessions ||
        JSON.stringify(launchSetRepository.reorderedEntries) !== JSON.stringify(['First', 'Third', 'Second']) ||
        !launchSetRepository.ordinaryChangedBlocked ||
        !launchSetRepository.nonRepositoryStarted ||
        !launchSetRepository.detailRoots[0]?.includes(isolatedCwd) ||
        !launchSetRepository.detailRoots[1]?.includes(join(isolatedCwd, 'nested-launch-repo')) ||
        launchSetRepository.detailRoots.length !== 2 ||
        launchSetRepository.detailRoots[0] === launchSetRepository.detailRoots[1] ||
        !/^git version /u.test(launchSetRepository.gitVersion)) {
      throw new Error(`launch set or repository acceptance failed: ${JSON.stringify(launchSetRepository)}`)
    }
    const checkoutPeers = await runCheckoutPeersSelfTest(host.applicationWindow, {
      directory: isolatedCwd,
      workspaceId: DEFAULT_WORKSPACE_ID,
      workspaceName: restoredWorkspaces.find((item) => item.workspaceId === DEFAULT_WORKSPACE_ID)!.name,
      peerWorkspaceId: routingWorkspace.workspaceId,
      peerWorkspaceName: routingWorkspace.name
    })
    if (!checkoutPeers.latePeerBlocked || !checkoutPeers.secondClickStarted ||
      !checkoutPeers.bothPreviewsNamedPeer || !checkoutPeers.previewPreservedTerminal ||
      !checkoutPeers.setPreviewDidNotStart) {
      throw new Error(`checkout peer acceptance failed: ${JSON.stringify(checkoutPeers)}`)
    }

    if (!progressEvidence) throw new Error('the results fixture has no evidence report')
    const evidenceArtifactId = progressEvidence.artifactId
    const evidenceOriginal = (await client.request<ArtifactRecord[]>(METHOD_REGISTRY.artifactList, {}))
      .find((row) => row.artifactId === evidenceArtifactId)
    const syntheticDataRoot = resolveApplicationRoots().data
    if (!evidenceOriginal?.storedPath.startsWith(`${syntheticDataRoot}${sep}`)) {
      throw new Error('the results evidence original is outside the isolated data root')
    }
    unlinkSync(evidenceOriginal.storedPath)
    await expectRemoteFailure(
      client.request(METHOD_REGISTRY.artifactPreview, { artifactId: evidenceOriginal.artifactId }),
      ERROR_CODES.notFound, 'The stored original is missing'
    )
    const crossWorkspaceDraft = await client.request<InputDraftRecord>(METHOD_REGISTRY.draftSave, {
      sourceSessionId: petitionSource.session.sessionId,
      sessionId: routingSession.session.sessionId,
      text: 'Synthetic cross-workspace handoff',
      artifactIds: []
    })
    const sourceWorkspace = (await client.request<WorkspaceRecord[]>(METHOD_REGISTRY.workspaceList, {
      includeArchived: true
    })).find((row) => row.workspaceId === DEFAULT_WORKSPACE_ID)
    if (!sourceWorkspace) throw new Error('the source workspace is unavailable for results')
    await host.recoverApplicationRenderer(host.applicationWindow)
    const crossWorkspaceUi = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const wait = async (read, name) => { const end = Date.now() + 10000; while (Date.now() < end) {
        const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
      } throw new Error('cross-workspace results timed out: ' + name); };
      const open = async (name) => {
        const section = await wait(() => [...document.querySelectorAll('.workspace-group')]
          .find(row => row.getAttribute('aria-label') === name), 'workspace ' + name);
        section.querySelector('.row-menu-button').click();
        (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
          .find(row => row.textContent.trim() === 'Review results…'), 'results action')).click();
        return wait(() => {
          const dialog = document.querySelector('dialog.workspace-results-dialog[open]');
          return dialog?.querySelector('.workspace-results-handoffs') ? dialog : null;
        }, 'results ' + name);
      };
      const sourceName = ${JSON.stringify(sourceWorkspace.name)};
      const destinationName = ${JSON.stringify(routingWorkspace.name)};
      const sourceDialog = await open(sourceName);
      const sourceReport = sourceDialog.textContent.includes('Self-test checks passed');
      const missingEvidence = sourceDialog.textContent.includes('checks.log · Original unavailable');
      const sourceRows = [...sourceDialog.querySelectorAll('.workspace-results-handoffs > li')]
        .filter(row => row.textContent.includes('Petition source') && row.textContent.includes('Child routing'));
      const sourceHandoffOnce = sourceRows.length === 1 &&
        sourceRows[0].textContent.includes(sourceName) && sourceRows[0].textContent.includes(destinationName);
      sourceDialog.querySelector('.app-dialog-heading button').click();
      const destinationDialog = await open(destinationName);
      const destinationNoReport = destinationDialog.textContent.includes('No progress reported') &&
        !destinationDialog.textContent.includes('Self-test checks passed');
      const destinationRows = [...destinationDialog.querySelectorAll('.workspace-results-handoffs > li')]
        .filter(row => row.textContent.includes('Petition source') && row.textContent.includes('Child routing'));
      const destinationHandoffOnce = destinationRows.length === 1 &&
        destinationRows[0].textContent.includes(sourceName) && destinationRows[0].textContent.includes(destinationName);
      destinationRows[0]?.querySelector('button')?.click();
      const form = await wait(() => document.querySelector('.handoff-form'), 'cross-workspace review');
      const routeExact = form.querySelector('textarea')?.value === 'Synthetic cross-workspace handoff' &&
        form.querySelector('select')?.value === ${JSON.stringify(routingSession.session.sessionId)};
      [...form.querySelectorAll('button')].find(b => b.textContent === 'Cancel')?.click();
      document.querySelector('.files-close')?.click();
      return { sourceReport, missingEvidence, sourceHandoffOnce, destinationNoReport,
        destinationHandoffOnce, routeExact };
    })()`) as {
      sourceReport: boolean; missingEvidence: boolean; sourceHandoffOnce: boolean;
      destinationNoReport: boolean; destinationHandoffOnce: boolean; routeExact: boolean
    }
    const crossWorkspaceResults = {
      ...crossWorkspaceUi,
      noAutoDelivery: (await client.request<InputDraftRecord[]>(METHOD_REGISTRY.draftList, {}))
        .find((row) => row.draftId === crossWorkspaceDraft.draftId)?.state === 'draft'
    }
    if (Object.values(crossWorkspaceResults).some((value) => value !== true)) {
      throw new Error(`cross-workspace results failed: ${JSON.stringify(crossWorkspaceResults)}`)
    }

    // AC5: the frame's rows at font sizes 10, 14 and 24, and at 14 px with 150 % zoom, against
    // the 5 rows Codex reserves. Overflow is measured and reported, not hidden.
    // Its own shell: the panes used earlier may be stopped by now.
    const placementShell = await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Sixel placement', cwd: isolatedCwd, executable: typedShell.windows ? typedShell.executable : '/bin/sh',
      argv: typedShell.windows ? [...typedShell.argv] : [], cols: 80, rows: 24 }, true)
    await host.recoverApplicationRenderer(host.applicationWindow)
    const placementId = JSON.stringify(placementShell.session.sessionId)
    const typeIntoPlacementPane = (text: string) => client.request(METHOD_REGISTRY.terminalWrite, {
      attachmentId: host.runtimes.get(placementShell.session.sessionId)!.attachment.attachmentId,
      bytes: new TextEncoder().encode(text)
    })
    const waitForPlacementLine = (marker: string) => host.applicationWindow!.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshots()[${placementId}]?.bufferLines.some((line) => line.includes(${JSON.stringify(marker)}))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(${JSON.stringify('the placement pane never printed ')} + ${JSON.stringify(marker)});
    })()`) as Promise<void>
    const appearanceBefore = await host.applicationWindow.webContents.executeJavaScript(
      'window.aiTerminal.getSettings().then((settings) => settings.appearance)') as { terminalFontSize: number }
    const placement = async (fontSize: number, zoom: number) => {
      await host.applicationWindow!.webContents.executeJavaScript(
        `window.aiTerminal.putSettings('appearance', ${JSON.stringify({ ...appearanceBefore, terminalFontSize: fontSize })})`)
      host.applicationWindow!.webContents.setZoomFactor(zoom)
      // The frame is drawn only once the view uses the new font size.
      await host.applicationWindow!.webContents.executeJavaScript(`(async () => {
        const end = Date.now() + 5000;
        while (Date.now() < end && window.__aitermTest.view(${placementId}).imageCells().fontSize !== ${fontSize}) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await typeIntoPlacementPane(typedShell.windows
        ? `Clear-Host; ${displayedFile(sixelPtyPath)}; Write-Output ''; ${printed('PLACED-', `${fontSize}-${zoom * 100}`)}\r`
        : `clear; cat '${sixelPtyPath}'; echo; printf 'PLACED-%s\\n' ${fontSize}-${zoom * 100}\r`)
      await waitForPlacementLine(`PLACED-${fontSize}-${zoom * 100}`)
      const cells = await host.applicationWindow!.webContents.executeJavaScript(`(async () => {
        const end = Date.now() + 3000;
        let cells = window.__aitermTest.view(${placementId}).imageCells();
        while (cells.lines.length === 0 && Date.now() < end) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          cells = window.__aitermTest.view(${placementId}).imageCells();
        }
        return { ...cells, storageMB: window.__aitermTest.snapshots()[${placementId}].imageStorageMB };
      })()`) as { lines: number[]; cssCellHeight: number; deviceCellHeight: number; devicePixelRatio: number;
        fontSize: number; storageMB: number }
      return { fontSize: cells.fontSize, fontApplied: cells.fontSize === fontSize, zoom, cssCellHeight: cells.cssCellHeight, devicePixelRatio: cells.devicePixelRatio,
        rows: cells.lines.length, withinReservedRows: cells.lines.length <= 5, storageMB: cells.storageMB }
    }
    const sixelPlacement = []
    for (const [fontSize, zoom] of [[10, 1], [14, 1], [24, 1], [14, 1.5]] as const) {
      sixelPlacement.push(await placement(fontSize, zoom))
    }
    host.applicationWindow.webContents.setZoomFactor(1)
    await host.applicationWindow.webContents.executeJavaScript(
      `window.aiTerminal.putSettings('appearance', ${JSON.stringify(appearanceBefore)})`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    if (sixelPlacement.length !== 4 || sixelPlacement.some((row) => !row.fontApplied || row.rows === 0 || row.cssCellHeight <= 0)) {
      throw new Error(`Sixel placement could not be measured: ${JSON.stringify(sixelPlacement)}`)
    }

    // Resizing the window refits the panes; the placement pane's text and image stay usable.
    // (Run last: an earlier resize changes the layout later integration steps read.)
    const [windowWidth, windowHeight] = host.applicationWindow.getSize() as [number, number]
    host.applicationWindow.setSize(Math.max(800, windowWidth - 240), Math.max(600, windowHeight - 160))
    await new Promise((resolve) => setTimeout(resolve, 400))
    await typeIntoPlacementPane(typedShell.windows
      ? `${displayedFile(join(animationDirectory, 'frame1.six'))}; Write-Output ''; ${printed('RESIZE', 'D')}\r`
      : `cat '${join(animationDirectory, 'frame1.six')}'; echo; printf '%sD\\n' RESIZE\r`)
    await waitForPlacementLine('RESIZED')
    host.applicationWindow.setSize(windowWidth, windowHeight)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const [restoredWidth, restoredHeight] = host.applicationWindow.getSize() as [number, number]
    if (restoredWidth !== windowWidth || restoredHeight !== windowHeight) {
      throw new Error(`the self-test window size was not restored: ${restoredWidth}x${restoredHeight}`)
    }
    const sixelResize = await host.applicationWindow.webContents.executeJavaScript(`(() => {
      const hook = window.__aitermTest;
      const own = hook.snapshot(${placementId}); return { storageMB: own.imageStorageMB, imageLines: hook.view(${placementId}).imageCells().lines.length, cols: own.cols, rows: own.rows, layer: own.imageLayerPresent };
    })()`) as { storageMB: number; imageLines: number; cols: number; rows: number; layer: boolean }
    if (!(sixelResize.storageMB > 0) || sixelResize.imageLines === 0) {
      throw new Error(`a resized pane lost its image: ${JSON.stringify(sixelResize)}`)
    }

    // AC1 cap pressure and AC4/AC7 cold views: nine programs fill image storage and a program
    // named codex draws its first frame, all before any view exists. After renderer recovery,
    // each new view receives that output in its first writes.
    const coldDirectory = join(isolatedCwd, 'sixel-cold-views')
    mkdirSync(join(coldDirectory, 'bin'), { recursive: true })
    const largeImage = `\u001bP9;1;0q"1;1;256;256#1;2;0;0;100#1${Array(43).fill('!256~').join('-')}\u001b\\`
    writeFileSync(join(coldDirectory, 'large.six'), largeImage)
    writeFileSync(join(coldDirectory, 'frame.six'), codexFrame(2))
    // Windows: the same output from Node stand-ins (cat, date and sleep are POSIX).
    const capProgram = typedShell.windows ? writeNodeProgram(coldDirectory, 'fill-images', [
      "const image = require('node:fs').readFileSync(__dirname + '/large.six', 'latin1')",
      'let written = 0',
      "const next = () => written++ < 40 ? process.stdout.write(image, next) : process.stdout.write('CAP-AFTER\\r\\n')",
      'next()',
      'setTimeout(() => undefined, 60000)',
      ''
    ].join('\n')) : join(coldDirectory, 'fill-images')
    const coldCodex = typedShell.windows ? writeNodeProgram(join(coldDirectory, 'bin'), 'codex', [
      "const { readFileSync, writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(join(coldDirectory, 'started'))}, String(Date.now()) + '\\n')`,
      `process.stdout.write(readFileSync(${JSON.stringify(join(coldDirectory, 'frame.six'))}, 'latin1'))`,
      "process.stdout.write('COLD-AFTER TERM=' + (process.env.TERM ?? '') + '\\r\\n')",
      'setTimeout(() => undefined, 60000)',
      ''
    ].join('\n')) : join(coldDirectory, 'bin', 'codex')
    if (!typedShell.windows) {
      writeFileSync(capProgram, [
        '#!/bin/sh',
        'i=0; while [ "$i" -lt 40 ]; do cat "$(dirname "$0")/large.six"; i=$((i + 1)); done',
        "printf 'CAP-AFTER\\r\\n'",
        'sleep 60'
      ].join('\n') + '\n', { mode: 0o700 })
      writeFileSync(coldCodex, [
        '#!/bin/sh',
        `date +%s%3N > '${join(coldDirectory, 'started').replaceAll("'", "'\\''")}'`,
        `cat '${join(coldDirectory, 'frame.six').replaceAll("'", "'\\''")}'`,
        "printf 'COLD-AFTER TERM=%s\\r\\n' \"$TERM\"",
        'sleep 60'
      ].join('\n') + '\n', { mode: 0o700 })
    }
    const capSessions = []
    for (let index = 0; index < 9; index += 1) {
      capSessions.push((await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
        name: `Sixel cap ${index + 1}`, cwd: isolatedCwd, executable: capProgram, argv: [], cols: 80, rows: 24 }, true)).session.sessionId)
    }
    const coldRequestedAt = Date.now()
    const coldSession = (await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Sixel cold codex', cwd: isolatedCwd, executable: coldCodex, argv: [], cols: 80, rows: 24,
      terminalGraphics: null }, true)).session.sessionId
    const coldStartedAt = await acceptanceWait(async () => existsSync(join(coldDirectory, 'started'))
      ? Number(readFileSync(join(coldDirectory, 'started'), 'utf8').trim()) : undefined, 'cold codex start')
    await host.recoverApplicationRenderer(host.applicationWindow)
    const coldViews = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const capIds = ${JSON.stringify(capSessions)};
      const coldId = ${JSON.stringify(coldSession)};
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        const snapshots = window.__aitermTest?.snapshots() ?? {};
        const shown = (id, marker) => snapshots[id]?.bufferLines.some((line) => line.includes(marker));
        if (capIds.every((id) => shown(id, 'CAP-AFTER')) && shown(coldId, 'COLD-AFTER')) {
          // Let a decoder that was still being created finish, so a dropped frame shows as zero storage.
          await new Promise((resolve) => setTimeout(resolve, 500));
          const latest = window.__aitermTest.snapshots();
          const views = Object.keys(latest).length;
          const storage = Object.values(latest).map((row) => row.imageStorageMB);
          return {
            views,
            viewLimitMB: Math.min(16, 128 / views),
            capStorageMB: capIds.map((id) => latest[id].imageStorageMB),
            totalStorageMB: storage.reduce((sum, value) => sum + value, 0),
            coldStorageMB: latest[coldId].imageStorageMB,
            coldTerm: (latest[coldId].bufferLines.find((line) => line.includes('COLD-AFTER')) ?? '').split('TERM=')[1]?.trim()
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the cap-pressure and cold views did not show their text after images');
    })()`) as { views: number; viewLimitMB: number; capStorageMB: number[]; totalStorageMB: number;
      coldStorageMB: number; coldTerm: string }
    const sixelCapPressure = {
      views: coldViews.views,
      viewLimitMB: coldViews.viewLimitMB,
      largestViewMB: Math.max(...coldViews.capStorageMB),
      totalStorageMB: coldViews.totalStorageMB,
      withinLimits: coldViews.capStorageMB.every((value) => value > 0 && value <= coldViews.viewLimitMB + 0.01) &&
        coldViews.totalStorageMB <= 128
    }
    const sixelColdView = {
      firstFrameDecoded: coldViews.coldStorageMB > 0,
      storageMB: coldViews.coldStorageMB,
      term: coldViews.coldTerm,
      startMs: coldStartedAt - coldRequestedAt
    }
    if (!sixelCapPressure.withinLimits || coldViews.views <= 8) {
      throw new Error(`image storage exceeded its caps: ${JSON.stringify(sixelCapPressure)}`)
    }
    if (!sixelColdView.firstFrameDecoded || sixelColdView.term !== 'xterm-sixel-256color' || sixelColdView.startMs > 2000) {
      throw new Error(`a view-less codex start or its first frame failed: ${JSON.stringify(sixelColdView)}`)
    }

    // 28.2 AC3: ordinary shells under each terminal entry, clean (/etc/skel/.bashrc) and with the
    // owner's own ~/.bashrc: colors, dircolors, prompt color and title, the addon's device
    // attributes reply, bracketed paste at the prompt, and a full-screen mouse TUI (less).
    const regressionDirectory = join(isolatedCwd, 'shell-regression')
    mkdirSync(regressionDirectory, { recursive: true })
    const shellRegression: Record<string, Record<string, unknown>> = {}
    if (typedShell.windows) {
      // Windows: Windows PowerShell clean (-NoProfile) and with the owner's profile, and cmd without
      // AutoRun. Each shell runs the shared checks: TERM and COLORTERM, the device attributes reply
      // the shell itself reads, a console-API and a 256-color run as the view stores them, the
      // shell's own coloring (cmd's prompt, PSReadLine's input) and the title it sets; then a
      // full-screen program's alternate screen, mouse and bracketed paste reach the view.
      const checksScript = join(regressionDirectory, 'checks.ps1')
      const fullScreenScript = join(regressionDirectory, 'full-screen.ps1')
      writeFileSync(checksScript, WINDOWS_SHELL_CHECKS)
      writeFileSync(fullScreenScript, WINDOWS_FULL_SCREEN)
      const regressionShells = [
        { label: 'clean-sixel', graphics: 'sixel' as const, executable: typedShell.executable, argv: [...typedShell.argv], cmd: false },
        { label: 'clean-standard', graphics: 'standard' as const, executable: typedShell.executable, argv: [...typedShell.argv], cmd: false },
        { label: 'owner-sixel', graphics: 'sixel' as const, executable: typedShell.executable, argv: ['-NoLogo'], cmd: false },
        { label: 'cmd-sixel', graphics: 'sixel' as const, executable: join(windowsSystemFolder(), 'cmd.exe'), argv: ['/d'], cmd: true }
      ]
      const regressionIds: Record<string, string> = {}
      for (const shell of regressionShells) {
        regressionIds[shell.label] = (await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
          name: `Shell regression ${shell.label}`, cwd: isolatedCwd, executable: shell.executable, argv: shell.argv,
          cols: 100, rows: 30, terminalGraphics: shell.graphics }, true)).session.sessionId
      }
      await host.recoverApplicationRenderer(host.applicationWindow)
      type Color = { mode: string; color: number; bold: boolean } | null
      type Modes = { alternateScreen: boolean; mouseTrackingMode: string; bracketedPasteMode: boolean }
      for (const shell of regressionShells) {
        const sessionId = regressionIds[shell.label]!
        const id = JSON.stringify(sessionId)
        const type = (text: string) => client.request(METHOD_REGISTRY.terminalWrite, {
          attachmentId: host.runtimes.get(sessionId)!.attachment.attachmentId,
          bytes: new TextEncoder().encode(text)
        })
        const page = <Value>(script: string) => host.applicationWindow!.webContents.executeJavaScript(script) as Promise<Value>
        // A PowerShell start under a loaded runner can take tens of seconds.
        const read = (marker: string) => page<string>(`(async () => {
          const end = Date.now() + 60000;
          while (Date.now() < end) {
            const line = window.__aitermTest?.snapshots()[${id}]?.bufferLines.find((row) => row.includes(${JSON.stringify(marker)}));
            if (line) return line;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error(${JSON.stringify(`the ${shell.label} shell never printed `)} + ${JSON.stringify(marker)});
        })()`)
        const colorOf = (text: string) => page<Color>(`window.__aitermTest.view(${id}).textColor(${JSON.stringify(text)})`)
        const modes = () => page<Modes>(`window.__aitermTest.snapshots()[${id}].modes`)
        // The checks run in PowerShell itself, or from cmd as a program it starts.
        const runScript = (file: string) => shell.cmd
          ? `"${typedShell.executable}" -NoLogo -NoProfile -Command "iex ([IO.File]::ReadAllText(${powerShellQuote(file)}))"\r`
          : `iex ([IO.File]::ReadAllText(${powerShellQuote(file)}))\r`
        await type(runScript(checksScript))
        const terms = await read('REGRESSION term=')
        const replies = await read('REGRESSION2 da1=')
        await read('REGRESSION-256')
        const color256 = await colorOf('REGRESSION-256')
        const hostColor = await colorOf('REGRESSION-HOSTCOLOR')
        await type(shell.cmd ? 'title REGRESSION-TITLE\r' : "$Host.UI.RawUI.WindowTitle = 'REGRESSION-' + 'TITLE'\r")
        const title = await page<string | null>(`(async () => {
          const end = Date.now() + 15000;
          while (Date.now() < end) {
            if (window.__bmnActivity?.titles()[${id}]?.includes('REGRESSION-TITLE')) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return window.__bmnActivity?.titles()[${id}] ?? null;
        })()`)
        let shellColor: Color
        if (shell.cmd) {
          await type('prompt $E[01;32mREGRESSION-PROMPT$G$E[0m\r')
          await read('REGRESSION-PROMPT>')
          shellColor = await colorOf('REGRESSION-PROMPT>')
        } else {
          await type("Write-Output ('PROMPT-' + 'READY')\r")
          await read('PROMPT-READY')
          shellColor = await colorOf('Write-Output')
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
        const atPrompt = await modes()
        await type(runScript(fullScreenScript))
        await read('FULL-SCREEN-READY')
        const fullScreen = await page<Modes>(`(async () => {
          const end = Date.now() + 3000;
          let modes = window.__aitermTest.snapshots()[${id}].modes;
          while (Date.now() < end && !(modes.alternateScreen && modes.mouseTrackingMode !== 'none' && modes.bracketedPasteMode)) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            modes = window.__aitermTest.snapshots()[${id}].modes;
          }
          return modes;
        })()`)
        await type('q')
        await read('FULL-SCREEN-DONE')
        const restored = await modes()
        const fields = Object.fromEntries(`${terms.replace(/^.*REGRESSION /, '')} ${replies.replace(/^.*REGRESSION2 /, '')}`
          .trim().split(' ').map((pair) => pair.split('=') as [string, string]))
        shellRegression[shell.label] = { ...fields, color256, hostColor, shellColor, title,
          bracketedPasteAtPrompt: atPrompt.bracketedPasteMode,
          fullScreen: { alternateScreen: fullScreen.alternateScreen, mouse: fullScreen.mouseTrackingMode, bracketedPaste: fullScreen.bracketedPasteMode },
          restored: { alternateScreen: restored.alternateScreen, mouse: restored.mouseTrackingMode, bracketedPaste: restored.bracketedPasteMode } }
      }
      const expectedTerms: Record<string, string> = { 'clean-sixel': 'xterm-sixel-256color',
        'clean-standard': 'xterm-256color', 'owner-sixel': 'xterm-sixel-256color', 'cmd-sixel': 'xterm-sixel-256color' }
      const colored = (value: unknown) => (value as Color)?.mode === 'palette' || (value as Color)?.mode === 'rgb'
      for (const [label, row] of Object.entries(shellRegression)) {
        const color256 = row.color256 as Color
        const fullScreen = row.fullScreen as { alternateScreen: boolean; mouse: string; bracketedPaste: boolean }
        // xterm's palette entry 202 is #ff5f00; a route that sends it as 24-bit color shows the same color.
        const exact256 = color256?.mode === 'palette' ? color256.color === 202 : color256?.mode === 'rgb' && color256.color === 0xff5f00
        if (row.term !== expectedTerms[label] || row.colorterm !== 'truecolor' || !exact256 || !colored(row.hostColor) ||
          !colored(row.shellColor) || !String(row.title ?? '').includes('REGRESSION-TITLE') ||
          !/^033\[\?[\d;]+c$/u.test(String(row.da1)) || !fullScreen.alternateScreen || fullScreen.mouse === 'none' || !fullScreen.bracketedPaste) {
          throw new Error(`an ordinary shell regressed under its terminal entry: ${JSON.stringify(shellRegression)}`)
        }
      }
    } else {
      const regressionChecks = join(regressionDirectory, 'checks.sh')
      writeFileSync(regressionChecks, [
        "old=$(stty -g); stty raw -echo min 0 time 10; printf '\\033[c'; reply=$(dd bs=64 count=1 2>/dev/null); stty \"$old\"",
        "da1=$(printf '%s' \"$reply\" | od -An -c | tr -d ' \\n')",
        'lscolors=$(eval "$(dircolors -b)"; [ -n "$LS_COLORS" ] && echo yes || echo no)',
        "case \"$PS1\" in *'[01;32m'*) prompt=color;; *) prompt=plain;; esac",
        "case \"$PS1\" in *']0;'*) title=yes;; *) title=no;; esac",
        "printf 'REGRESSION term=%s colors=%s lscolors=%s\\n' \"$TERM\" \"$(tput colors)\" \"$lscolors\"",
        "printf 'REGRESSION2 prompt=%s title=%s da1=%s\\n' \"$prompt\" \"$title\" \"$da1\""
      ].join('\n') + '\n')
      const regressionShells = [
        { label: 'clean-sixel', graphics: 'sixel' as const, argv: ['--rcfile', '/etc/skel/.bashrc', '-i'] },
        { label: 'clean-standard', graphics: 'standard' as const, argv: ['--rcfile', '/etc/skel/.bashrc', '-i'] },
        { label: 'owner-sixel', graphics: 'sixel' as const, argv: ['-i'] }
      ]
      const regressionIds: Record<string, string> = {}
      for (const shell of regressionShells) {
        regressionIds[shell.label] = (await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
          name: `Shell regression ${shell.label}`, cwd: isolatedCwd, executable: '/bin/bash', argv: shell.argv,
          cols: 100, rows: 30, terminalGraphics: shell.graphics }, true)).session.sessionId
      }
      await host.recoverApplicationRenderer(host.applicationWindow)
      for (const shell of regressionShells) {
        const id = JSON.stringify(regressionIds[shell.label])
        const type = (text: string) => client.request(METHOD_REGISTRY.terminalWrite, {
          attachmentId: host.runtimes.get(regressionIds[shell.label]!)!.attachment.attachmentId,
          bytes: new TextEncoder().encode(text)
        })
        const read = (marker: string) => host.applicationWindow!.webContents.executeJavaScript(`(async () => {
          const end = Date.now() + 15000;
          while (Date.now() < end) {
            const snapshot = window.__aitermTest?.snapshots()[${id}];
            const line = snapshot?.bufferLines.find((row) => row.includes(${JSON.stringify(marker)}));
            if (line) return { line, modes: snapshot.modes };
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error(${JSON.stringify(`the ${shell.label} shell never printed `)} + ${JSON.stringify(marker)});
        })()`) as Promise<{ line: string; modes: { bracketedPasteMode: boolean; mouseTrackingMode: string } }>
        await type(`. '${regressionChecks}'\r`)
        const result = await read('REGRESSION term=')
        const result2 = await read('REGRESSION2 prompt=')
        // Readline turns bracketed paste on at the prompt; the view's modes show what the program asked for.
        await type(`printf '%s-%s\\n' PROMPT READY\r`)
        const prompt = await read('PROMPT-READY')
        await new Promise((resolve) => setTimeout(resolve, 300))
        const atPrompt = await host.applicationWindow.webContents.executeJavaScript(
          `window.__aitermTest.snapshots()[${id}].modes`) as { bracketedPasteMode: boolean }
        await type(`less --mouse '${regressionChecks}'\r`)
        await new Promise((resolve) => setTimeout(resolve, 800))
        const inLess = await host.applicationWindow.webContents.executeJavaScript(
          `window.__aitermTest.snapshots()[${id}].modes`) as { mouseTrackingMode: string }
        await type('q')
        await type(`printf '%s-%s\\n' LESS DONE\r`)
        await read('LESS-DONE')
        const fields = Object.fromEntries(`${result.line.replace(/^.*REGRESSION /, '')} ${result2.line.replace(/^.*REGRESSION2 /, '')}`
          .trim().split(' ').map((pair) => pair.split('=') as [string, string]))
        shellRegression[shell.label] = { ...fields, bracketedPaste: atPrompt.bracketedPasteMode,
          lessMouse: inLess.mouseTrackingMode, promptSeen: prompt.line.includes('PROMPT-READY') }
      }
      const expectedTerms: Record<string, string> = { 'clean-sixel': 'xterm-sixel-256color',
        'clean-standard': 'xterm-256color', 'owner-sixel': 'xterm-sixel-256color' }
      for (const [label, row] of Object.entries(shellRegression)) {
        if (row.term !== expectedTerms[label] || row.colors !== '256' || row.lscolors !== 'yes' || row.prompt !== 'color' ||
          row.title !== 'yes' || row.da1 !== '033[?62;4;9;22c' || row.bracketedPaste !== true || row.lessMouse === 'none') {
          throw new Error(`an ordinary shell regressed under its terminal entry: ${JSON.stringify(shellRegression)}`)
        }
      }
    }

    // A pane's view is replaced while its program is inside a Sixel image, after ESC and a line
    // feed that xterm executes without leaving the sequence. The new view must read the next
    // DCS as a DCS, not print its payload, and still show later text and a fresh image.
    const viewSwapDirectory = join(isolatedCwd, 'sixel-view-swap')
    mkdirSync(viewSwapDirectory, { recursive: true })
    writeFileSync(join(viewSwapDirectory, 'part1.bin'),
      `\u001bP9;1;0q"1;1;60;75#1;2;0;100;0${'#1'.repeat(40_000)}\u001b\n`)
    writeFileSync(join(viewSwapDirectory, 'part2.bin'),
      `PqLEAK${'~'.repeat(200)}\u001b\\VISIBLE-AFTER\r\n` +
      `\u001bP9;1;0q"1;1;60;75#1;2;100;0;0#1${Array(13).fill('!60~').join('-')}\u001b\\\r\n`)
    // Windows: the same two-part output from a Node stand-in.
    const viewSwapScript = typedShell.windows ? writeNodeProgram(viewSwapDirectory, 'program', [
      "const { existsSync, readFileSync } = require('node:fs')",
      "const part = (name) => readFileSync(__dirname + '/' + name, 'latin1')",
      "process.stdout.write('VIEW-SWAP-START\\n' + part('part1.bin'))",
      "const waiting = setInterval(() => { if (!existsSync(__dirname + '/go')) return; clearInterval(waiting); process.stdout.write(part('part2.bin')) }, 50)",
      'setTimeout(() => undefined, 30000)',
      ''
    ].join('\n')) : join(viewSwapDirectory, 'program')
    if (!typedShell.windows) writeFileSync(viewSwapScript, [
      '#!/bin/sh',
      `cd '${viewSwapDirectory.replaceAll("'", "'\\''")}'`,
      "printf 'VIEW-SWAP-START\\n'",
      'cat part1.bin',
      // The rest waits until the replacement view is live.
      'while [ ! -e go ]; do sleep 0.05; done',
      'cat part2.bin',
      'sleep 30'
    ].join('\n') + '\n', { mode: 0o700 })
    const viewSwap = await host.createSessionRuntime({ workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'Sixel view swap', cwd: isolatedCwd, executable: viewSwapScript,
      argv: [], cols: 80, rows: 24 }, true)
    const viewSwapId = JSON.stringify(viewSwap.session.sessionId)
    await host.recoverApplicationRenderer(host.applicationWindow)
    await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshots()[${viewSwapId}]?.bufferLines.some((line) => line.includes('VIEW-SWAP-START'))) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the first view of the Sixel view swap pane did not show its start');
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    await host.recoverApplicationRenderer(host.applicationWindow)
    await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (window.__aitermTest?.snapshots()[${viewSwapId}]) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the replacement view of the Sixel view swap pane did not mount');
    })()`)
    writeFileSync(join(viewSwapDirectory, 'go'), '')
    const sixelViewSwap = await host.applicationWindow.webContents.executeJavaScript(`(async () => {
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        const snapshots = window.__aitermTest?.snapshots() ?? {};
        const own = snapshots[${viewSwapId}];
        // The pane may be off screen, so decoded image storage, not a drawn layer, shows the image.
        if (own?.bufferLines.some((line) => line.includes('VISIBLE-AFTER')) && own.imageStorageMB > 0) {
          return {
            visibleAfter: true,
            leakedText: own.bufferLines.some((line) => line.includes('LEAK') || line.includes('#1#1')),
            storageMB: own.imageStorageMB,
            layer: own.imageLayerPresent,
            otherPanesLeak: Object.entries(snapshots).some(([id, row]) =>
              id !== ${viewSwapId} && row.bufferLines.some((line) => line.includes('LEAK')))
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const own = window.__aitermTest?.snapshots()[${viewSwapId}];
      throw new Error('the replacement view did not show text after the image: ' + JSON.stringify({
        text: own?.bufferLines.filter((line) => line.trim()).slice(-8),
        storageMB: own?.imageStorageMB, layer: own?.imageLayerPresent }));
    })()`) as { visibleAfter: boolean; leakedText: boolean; storageMB: number; layer: boolean;
      otherPanesLeak: boolean }
    if (!sixelViewSwap.visibleAfter || sixelViewSwap.leakedText || !(sixelViewSwap.storageMB > 0) ||
      sixelViewSwap.otherPanesLeak) {
      throw new Error(`a replacement view misread output after an interrupted image: ${JSON.stringify(sixelViewSwap)}`)
    }

    const graphicsRoot = process.env.BMN_DATA_HOME
    if (!graphicsRoot) throw new Error('self-test graphics entry requires BMN_DATA_HOME')
    const terminfoDirectory = join(graphicsRoot, 'terminfo')
    const terminfoEntry = join(terminfoDirectory, 'x', 'xterm-sixel-256color')
    // Windows has no ncurses database: the sixel entry is checked by the product's own compiled-entry
    // reading, and no standard entry exists to resolve (null, not a claimed success).
    const terminfoSource = app.isPackaged
      ? join(process.resourcesPath, 'terminfo', 'x', 'xterm-sixel-256color')
      : join(repoRoot, 'apps', 'desktop', 'resources', 'terminfo', 'x', 'xterm-sixel-256color')
    const sixelResolved = typedShell.windows
      ? sixelTerminfoReady({ directory: terminfoDirectory, source: terminfoSource }, 'win32')
      : existsSync(terminfoEntry) && spawnSync('infocmp',
        ['-A', terminfoDirectory, 'xterm-sixel-256color'], { stdio: 'ignore' }).status === 0
    const standardResolved = typedShell.windows ? null : spawnSync('infocmp', ['xterm-256color'], {
      stdio: 'ignore', env: { ...process.env, TERMINFO_DIRS: `${terminfoDirectory}:` }
    }).status === 0
    const graphicsProbeDirectory = join(isolatedCwd, 'graphics-probe')
    mkdirSync(graphicsProbeDirectory, { recursive: true })
    // BMN launches a direct Codex executable with --no-daemon so its hooks keep this session's environment.
    const fakeCodex = typedShell.windows ? writeNodeProgram(graphicsProbeDirectory, 'codex', [
      'const args = process.argv.slice(2)',
      "if (args[0] === '--no-daemon') args.shift()",
      "require('node:fs').writeFileSync(args[0], (process.env.TERM ?? '') + '\\n')",
      'setTimeout(() => undefined, 2000)',
      ''
    ].join('\n')) : join(graphicsProbeDirectory, 'codex')
    if (!typedShell.windows) {
      writeFileSync(fakeCodex, '#!/bin/sh\n[ "$1" = "--no-daemon" ] && shift\nprintf "%s\\n" "$TERM" > "$1"\nsleep 2\n',
        { mode: 0o700 })
    }
    const probeTerm = async (file: string): Promise<string> => {
      await client.request(METHOD_REGISTRY.sessionCreate, {
        workspaceId: DEFAULT_WORKSPACE_ID, name: 'Synthetic graphics TERM probe',
        cwd: isolatedCwd, executable: fakeCodex, argv: [file], cols: 80, rows: 24,
        terminalGraphics: null
      })
      return acceptanceWait(async () => existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined,
        'synthetic Codex TERM receipt')
    }
    const initialTerm = await probeTerm(join(isolatedCwd, 'graphics-before.txt'))
    writeFileSync(terminfoEntry, 'corrupt test entry')
    const fallbackTerm = await probeTerm(join(isolatedCwd, 'graphics-after.txt'))
    const graphicsTerminfo = { sixelResolved, standardResolved, initialTerm, fallbackTerm }
    if (!sixelResolved || standardResolved === false || initialTerm !== 'xterm-sixel-256color' ||
      fallbackTerm !== 'xterm-256color') {
      throw new Error(`isolated terminfo fallback failed: ${JSON.stringify(graphicsTerminfo)}`)
    }

    const secondClose = await client.close()
    console.error('[BMN] self-test phase: second host closed')
    clientClosed = true
    graceful &&= secondClose.graceful
    applicationPort.close()
    applicationPort = undefined

    if (JSON.stringify(restoredHealth.schemaTables) !== JSON.stringify(STORY_SCHEMA_TABLES)) {
      throw new Error(`unexpected database tables: ${restoredHealth.schemaTables.join(',')}`)
    }
    if (
      ready.database.journalMode !== 'wal' ||
      !ready.database.foreignKeys ||
      ready.database.busyTimeoutMs !== 5_000
    ) {
      throw new Error('database worker did not enable WAL, foreign keys, and the busy timeout')
    }

    // The fourteen reads checked with the file-reference flow, plus the one the send dialog made.
    if (taps.readFileReferences.length !== 15) {
      throw new Error(`the renderer read file references ${taps.readFileReferences.length} times, not 15`)
    }
    const registeredInvokeChannels = host.bridgeRegistrations().map(({ channel }) => channel)
    if (JSON.stringify(registeredInvokeChannels) !== JSON.stringify(envelopedInvokeChannels)) {
      throw new Error('an invoke channel was registered after the typed-envelope check')
    }
    receipt = {
      selfTest: 'session-roundtrip',
      electronVersion: ready.electronVersion,
      nativeModules: ready.nativeModules,
      streamMessages: observed.sequences.length,
      workspaceCount: restoredWorkspaces.length,
      sessionCount: restoredHealth.sessionRecords,
      interruptedIncarnations: restoredHealth.interruptedIncarnations,
      bindingsRestored: restoredBindings.length,
      mainPreloadWorkspaceMethod: preloadProbe.workspaceCount,
      mainPreloadSessionMethod: preloadProbe.sessionMethodSessionId,
      bridgeErrorCodesTyped: preloadProbe.bridgeErrorCodes,
      resumeConfirmationShownToOwner,
      rendererLaunchUnavailable: preloadProbe.launchUnavailable,
      rendererUnavailableTemplate: preloadProbe.unavailableTemplate,
      rendererStoppedPanelLabel,
      stoppedStaleProgress,
      rendererInverseTextContrast,
      rendererLiveExitLabel,
      rendererLiveExitSidebarWord,
      closePrompt,
      registeredInvokeChannels,
      envelopedInvokeChannels,
      templateCreatedSession: preloadProbe.templateCreatedSession,
      treeSelectionLayoutPut: preloadProbe.treeSelection,
      crossWorkspaceSplit: preloadProbe.crossWorkspaceSplit,
      workspaceMarkers: preloadProbe.workspaceMarkers,
      progressEvidence,
      progressEvidenceSurface: preloadProbe.progressEvidenceSurface,
      workspaceResults: workspaceResultsAcceptance,
      crossWorkspaceResults,
      hiddenPaneSize: preloadProbe.hiddenPaneSize,
      handoffFlow: preloadProbe.handoffFlow,
      agentHandoff,
      fileReferenceWire,
      sixelRender,
      sixelPty,
      sixelAnimation,
      sixelTwoPaneAnimation,
      sixelAlternateScreen,
      sixelPlacement,
      sixelResize,
      sixelCapPressure,
      sixelColdView,
      shellRegression,
      sixelViewSwap,
      cspProbe,
      graphicsTerminfo,
      openCodeAcceptance,
      cursorAcceptance,
      subagentAcceptance,
      repeatAcceptance,
      resetModes,
      quietSidebarAcceptance,
      interruptedSidebarAcceptance,
      voiceFlow: {
        ...preloadProbe.voiceFlow,
        transcriptions: taps.voiceTranscriptions,
        persistedAfterRestart: voicePersistedAfterRestart
      },
      fileReferenceFlow: {
        ...preloadProbe.fileReferenceFlow,
        shownPaths: [...taps.shownFileReferences],
        reads: [...taps.readFileReferences]
      },
      attentionTriage: preloadProbe.attentionTriage,
      inactiveFollowingOutputLayoutPuts,
      inactiveFollowingOutputCaptured,
      launchBackgroundChoiceRecorded,
      applicationQuitStoppedSession: {
        beforeRestart: lifecycleStoppedBeforeRestart,
        afterRestart: lifecycleStoppedAfterRestart
      },
      conversationFromHook,
      sessionActivity,
      requestProvenance,
      hookIntegration: hookIntegrationAcceptance,
      harnessObservations: { opencode: openCodeObservationUi, codex: codexObservationUi },
      terminalNotice,
      launchSetRepository,
      checkoutPeers,
      modelOrigin: { flags: modelOriginFlags, afterRestart: modelOriginAfterRestart },
      remoteAnswers,
      telegramCards,
      fullerAnswers: fuller,
      telegramCue,
      survivalTable: {
        rendererCrash: survivingRendererCrash,
        quit: {
          recorded: lifecycleStoppedBeforeRestart.detail,
          afterApplicationRestart: lifecycleStoppedAfterRestart?.detail ?? null,
          openRequestsAfter: openRequestsAfterApplicationRestart,
        },
        closeWindowKeep,
        closeAndStop,
        explicitStop
      },
      // Epic 17.1: what the offer said after an update stop, what the button started, and that it asked once.
      resumeOffer: {
        heading: offerAfterUpdate.heading,
        summary: offerAfterUpdate.summary,
        button: offerAfterUpdate.button,
        startsUnchecked: offerAfterUpdate.rows.every((row) => !row.checked),
        reopenedFromPalette: reopenedOffer.rows.length,
        outcomes: offerResult.rows.map((row) => row.outcome),
        argv: restartedArgv.map((runs) => runs[1] ?? null),
        askedAgain: !(offerStayedAwayAfterRendererRestart && offerStayedAwayAfterSecondStart)
      },
      // Epic 17.2: the modes the rebuilt view came back with, and what the program was sent through them.
      terminalModes,
      schemaTables: restoredHealth.schemaTables
    }
  } catch (error) {
    // Print the reason before release, so a release that stalls cannot hide it.
    reportSelfTestFailure(error)
    throw error
  } finally {
    console.error('[BMN] self-test phase: releasing self-test resources')
    historyFixture?.holder.kill()
    if (host.applicationWindow && !host.applicationWindow.isDestroyed()) host.applicationWindow.destroy()
    host.applicationWindow = undefined
    if (applicationPort) applicationPort.close()
    if (!clientClosed) {
      const finalClose = await closeWithinDeadline(client, SELF_TEST_RELEASE_CLOSE_DEADLINE_MS)
      graceful &&= finalClose.graceful
    }
    if (host.hostClient === client) host.hostClient = undefined
    host.hostRendererPort = undefined
    host.runtimes.clear()
    host.processTracking.unconfirmedExits.clear()
    host.sessionRecords.clear()
    taps.rendererLaunchBlockedSessionId = undefined
    taps.rendererUnavailableTemplate = undefined
  }
  if (!graceful) throw new Error('the real terminal host did not shut down gracefully')
  console.log(JSON.stringify({ ...receipt, graceful }))
}
