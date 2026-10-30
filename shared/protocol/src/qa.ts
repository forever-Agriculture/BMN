// MODULE: qa.ts - durable QA pane lifecycle and the main-process launch request (Epic 100.5)
import { isRecord } from './shared-helpers'
import type { QaAuditState, QaHostSummary } from './qa-grants'

export interface QaRun {
  id: string
  callerSessionId: string
  workspaceId: string
  key: string
  inputSha256: string
  brief: Record<string, unknown>
  folder: string
  state: 'preparing' | 'running' | 'finished' | 'failed' | 'stopped'
  sessionId: string | null
  incarnationId: string | null
  createdAt: string
  failure: string | null
  agent?: { pid: number; ticks: string; at: string } | null
  relayConnectAttempts?: number
  audit?: QaAuditState
  accountsSealedAt?: string
  connection: { pid: number; ticks: string; at: string } | null
  result: { valid: boolean; verdict: string | null; errors: string[]; report: unknown; hostSummary?: QaHostSummary } | null
}

export interface QaLaunchRequest {
  qaId: string
  workspaceId: string
  sourceRoot: string
  folder: string
  brief: Record<string, unknown>
}

export function isQaLaunchRequest(value: unknown): value is QaLaunchRequest {
  return isRecord(value) && Object.keys(value).length === 5 &&
    ['qaId', 'workspaceId', 'sourceRoot', 'folder'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 4096) &&
    isRecord(value.brief) && JSON.stringify(value.brief).length <= 128 * 1024
}
