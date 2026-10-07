// MODULE: contract.ts - the one seam between production main-process code and the self-test (types only)
import type {
  LaunchTemplateRecord,
  ProtocolMethod,
  SavedOutputCaptureOutcome,
  SessionRecord
} from '@bmn/protocol'
import type { DownloadOptions, transcribeRecording } from '../voice-engine'

type RequestClient = { request<Result>(method: ProtocolMethod, params: object): Promise<Result> }

/**
 * What production code lets the self-test observe or stand in for. A normal run has none: production
 * holds `undefined` and every call site uses optional chaining, so this file is type-only and a normal
 * run never loads the self-test modules.
 */
export interface SelfTestTaps {
  /** The self-test window is hidden: no OS dialog, desktop notification, file manager or window focus. */
  readonly headless: true
  /** The environment and argv for a terminal host the self-test starts. */
  hostLaunch(base: NodeJS.ProcessEnv): Promise<{ environment: NodeJS.ProcessEnv; args: string[] }>
  /** The renderer boundary probes: a session whose launch is refused and a template that cannot start. */
  rendererState<State extends { sessions: SessionRecord[]; templates: LaunchTemplateRecord[] }>(state: State): State
  /** Every renderer workspace request main forwards, before the host answers. */
  workspaceRequest(method: ProtocolMethod, params: object): Promise<void>
  launchSetStarted(): void
  fileReferenceClient(client: RequestClient): RequestClient
  shownInFolder(path: string): void
  appNotice(notice: { title: string; body: string }): void
  readonly captureAttentionNotifications: boolean
  attentionNotice(notice: { title: string; body: string; sessionId: string }): void
  readonly voice: {
    binary: string
    transcribe: typeof transcribeRecording
    fetch: DownloadOptions['fetch']
  }
  lifecycleCaptured(sessionId: string, status: SavedOutputCaptureOutcome['status']): void
  /** A renderer recovery step, printed so a stalled recovery names where it stopped. */
  recoveryPhase(message: string): void
}
