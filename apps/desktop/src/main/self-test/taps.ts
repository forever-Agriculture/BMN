// MODULE: taps.ts - what the self-test records from production main-process code, and its stand-ins
import { join } from 'node:path'
import {
  METHOD_REGISTRY,
  type LaunchTemplateRecord,
  type ProtocolMethod,
  type SavedOutputCaptureOutcome,
  type SessionRecord
} from '@bmn/protocol'
import { resolveApplicationRoots } from '../../utility/roots'
import { selfTestHistoryEnvironment } from '../agent-history-self-test'
import { startFakeBotApi, type FakeBotApi } from '../fake-bot-api'
import { validateWav, whisperArguments, type transcribeRecording } from '../voice-engine'
import type { SelfTestTaps } from './contract'

/** The self-test's pages wait this long instead of 15 s, so each card shape costs seconds, not a quarter minute. */
const SELF_TEST_PAGE_AFTER_MS = 2_000
/** The self-test's Telegram: one local fake Bot API for the whole run, started before the first host. */
export const SELF_TEST_TELEGRAM_CHAT_ID = 424242
export const SELF_TEST_LAUNCH_DISABLED_REASON =
  'Stored arguments are unavailable in the renderer boundary probe.'

/** Each transcription main ran, with the argv the real engine would get; no whisper process runs. */
interface SelfTestTranscription {
  language: string
  vocabulary: string[]
  durationSeconds: number
  args: string[]
}

export class SelfTestRecorder implements SelfTestTaps {
  readonly headless = true as const
  /** Every renderer layout.put request main forwards, counted before the host answers. */
  layoutPutRequests = 0
  readonly layoutPutSelections: Array<string | null> = []
  launchSetStartRequests = 0
  rendererLaunchBlockedSessionId: string | undefined
  rendererUnavailableTemplate: LaunchTemplateRecord | undefined
  /** Paths Show in folder received; the automated run never opens a file manager. */
  readonly shownFileReferences: string[] = []
  /** Story 32.2: app notices the self-test records instead of showing. */
  readonly appNotices: Array<{ title: string; body: string }> = []
  captureAttentionNotifications = false
  windowUnwatched = false
  readonly attentionNotices: Array<{ title: string; body: string; sessionId: string }> = []
  attentionNotice(notice: { title: string; body: string; sessionId: string }): void { this.attentionNotices.push(notice) }
  /** Every reference the renderer asked to read, in order: hovering and output must add none. */
  readonly readFileReferences: Array<{ sessionId: string; reference: string }> = []
  readonly voiceTranscriptions: SelfTestTranscription[] = []
  voiceFetchCalls = 0
  /** Acknowledgements from the production lifecycle flush, distinct from activity captures. */
  readonly lifecycleCaptures: Array<{ sessionId: string; status: SavedOutputCaptureOutcome['status'] }> = []
  private launchSetReadGate: { entered(): void; released: Promise<void> } | null = null
  private botApi: Promise<FakeBotApi> | null = null

  /** The stand-in engine and model live in the isolated data folder; the transcript is synthetic. */
  readonly voice: SelfTestTaps['voice'] = {
    binary: join(this.voiceFolder(), 'whisper-cli'),
    transcribe: async (options: Parameters<typeof transcribeRecording>[0]) => {
      const { durationSeconds } = validateWav(options.wav)
      const vocabulary = [...(options.vocabulary ?? [])]
      this.voiceTranscriptions.push({
        language: options.language,
        vocabulary,
        durationSeconds,
        args: whisperArguments({ modelPath: options.modelPath, wavPath: 'recording.wav', language: options.language, durationSeconds, threads: 1, vocabulary })
      })
      return `echo VOICE-PASTE-${this.voiceTranscriptions.length}`
    },
    /** The model transfer is served from memory: the first download holds one chunk open until
     * cancelled, and every later fetch refuses the connection, so no network is touched and the download
     * handler's reservation, cancel and failure paths run for real. */
    fetch: async (_url, init) => {
      this.voiceFetchCalls += 1
      if (this.voiceFetchCalls > 1) throw new TypeError('connection reset')
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1_000_000))
          init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
        }
      }))
    }
  }

  voiceFolder(): string {
    return join(resolveApplicationRoots().data, 'voice')
  }

  telegram(): Promise<FakeBotApi> {
    this.botApi ??= startFakeBotApi(SELF_TEST_TELEGRAM_CHAT_ID, SELF_TEST_TELEGRAM_CHAT_ID)
    return this.botApi
  }

  /** Holds the next renderer launch-set read until the self-test releases it. */
  pauseNextLaunchSetRead = (): { entered: Promise<void>; release(): void } => {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const released = new Promise<void>((resolve) => { release = resolve })
    this.launchSetReadGate = { entered: enter, released }
    return { entered, release }
  }

  async hostLaunch(base: NodeJS.ProcessEnv): Promise<{ environment: NodeJS.ProcessEnv; args: string[] }> {
    return {
      environment: {
        ...base, ...selfTestHistoryEnvironment(),
        BMN_SELF_TEST_TELEGRAM_ORIGIN: (await this.telegram()).origin,
        BMN_SELF_TEST_PAGE_AFTER_MS: String(SELF_TEST_PAGE_AFTER_MS)
      },
      args: ['--self-test-host']
    }
  }

  rendererState<State extends { sessions: SessionRecord[]; templates: LaunchTemplateRecord[] }>(state: State): State {
    return {
      ...state,
      sessions: state.sessions.map((session) =>
        session.sessionId === this.rendererLaunchBlockedSessionId
          ? { ...session, launchDisabledReason: SELF_TEST_LAUNCH_DISABLED_REASON }
          : session
      ),
      templates: this.rendererUnavailableTemplate
        ? [...state.templates, this.rendererUnavailableTemplate]
        : state.templates
    }
  }

  async workspaceRequest(method: ProtocolMethod, params: object): Promise<void> {
    if (method === METHOD_REGISTRY.launchSetGet && this.launchSetReadGate) {
      const gate = this.launchSetReadGate
      this.launchSetReadGate = null
      gate.entered()
      await gate.released
    }
    if (method === METHOD_REGISTRY.layoutPut) {
      this.layoutPutRequests += 1
      const selectedSessionId = (params as { state?: { selectedSessionId?: unknown } })
        .state?.selectedSessionId
      this.layoutPutSelections.push(typeof selectedSessionId === 'string' ? selectedSessionId : null)
    }
  }

  launchSetStarted(): void {
    this.launchSetStartRequests += 1
  }

  fileReferenceClient(client: { request<Result>(method: ProtocolMethod, params: object): Promise<Result> }) {
    return {
      request: <Result>(method: ProtocolMethod, params: object) => {
        if (method === METHOD_REGISTRY.fileReferenceRead) {
          const { sessionId, reference } = params as { sessionId?: unknown; reference?: unknown }
          this.readFileReferences.push({ sessionId: String(sessionId), reference: String(reference) })
        }
        return client.request<Result>(method, params)
      }
    }
  }

  shownInFolder(path: string): void {
    this.shownFileReferences.push(path)
  }

  appNotice(notice: { title: string; body: string }): void {
    this.appNotices.push(notice)
  }

  lifecycleCaptured(sessionId: string, status: SavedOutputCaptureOutcome['status']): void {
    this.lifecycleCaptures.push({ sessionId, status })
  }

  recoveryPhase(message: string): void {
    console.error(`[BMN] ${message}`)
  }
}
