export interface LaunchSetStartParams {
  workspaceId: string
  setId: string
  expectedRevision: number
  directory: string
  idempotencyKey: string
  cols: number
  rows: number
}

export interface LaunchSetStartEntryResult {
  entryId: string
  name: string
  outcome: 'started' | 'failed' | 'not-started'
  sessionId?: string
  incarnationId?: string
  attachment?: {
    attachmentId: string
    streamSeq: 0
    captureStartedAt: string
    modes: number[]
  }
  error?: string
}

export interface LaunchSetStartResult {
  workspaceId: string
  setId: string
  revision: number
  directory: string
  entries: LaunchSetStartEntryResult[]
}

export function isLaunchSetStartParams(value: unknown): value is LaunchSetStartParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<LaunchSetStartParams>
  return Object.keys(candidate).length === 7 &&
    typeof candidate.workspaceId === 'string' && candidate.workspaceId.length > 0 &&
    typeof candidate.setId === 'string' && candidate.setId.length > 0 &&
    Number.isSafeInteger(candidate.expectedRevision) && candidate.expectedRevision! > 0 &&
    typeof candidate.directory === 'string' && candidate.directory.length > 0 && candidate.directory.length <= 4096 &&
    typeof candidate.idempotencyKey === 'string' && candidate.idempotencyKey.length > 0 && candidate.idempotencyKey.length <= 128 &&
    Number.isInteger(candidate.cols) && Number.isInteger(candidate.rows)
}
