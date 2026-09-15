import type { BoundConversationBinding, PersistedConversationBinding } from './binding'
import { hasExactKeys } from './closed-shape'

export const DEFAULT_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
export const WORKSPACE_NAME_MAX_LENGTH = 120
export const LAYOUT_RATIO_TOLERANCE = 0.000_001

export type BackgroundChoice = 'hide' | 'stop'
export type SessionStopCause =
  | 'explicit'
  | 'application-quit'
  | 'close-last-window'
  | 'update-restart'
export type LifecycleStopCause = Exclude<SessionStopCause, 'explicit'>

/** The single owner of lifecycle-stop wording used by persisted and live process feedback. */
export function lifecycleStopSource(cause: LifecycleStopCause): string {
  switch (cause) {
    case 'application-quit':
      return 'application quit'
    case 'close-last-window':
      return 'last window close'
    case 'update-restart':
      return 'update restart'
  }
}

export function lifecycleStopDetail(
  cause: LifecycleStopCause,
  exit: { exitCode: number; signal?: number }
): string {
  const source = lifecycleStopSource(cause)
  if (exit.signal !== undefined && exit.signal !== 0) {
    return exit.exitCode === 0
      ? `${source} · signal ${exit.signal}`
      : `${source} · signal ${exit.signal} · code ${exit.exitCode}`
  }
  return `${source} · exit code ${exit.exitCode}`
}

export function isLifecycleStopCause(value: unknown): value is LifecycleStopCause {
  return (
    value === 'application-quit' ||
    value === 'close-last-window' ||
    value === 'update-restart'
  )
}

export interface WorkspaceRecord {
  workspaceId: string
  name: string
  defaultCwd: string | null
  position: number
  archivedAt: string | null
  revision: number
}

/**
 * The session's latest process incarnation as the host reports it. `state` comes from the host's
 * single liveness rule: `live` only for the incarnation the host currently holds, otherwise the
 * recorded outcome (`exited` with its exit code and signal, or `interrupted` with its detail).
 */
export interface SessionProcessStatus {
  incarnationId: string
  state: 'live' | 'exited' | 'interrupted'
  exitCode: number | null
  signal: number | null
  detail: string | null
}

export interface SessionRecord {
  sessionId: string
  workspaceId: string
  name: string
  cwd: string
  executable: string
  argv: string[]
  position: number
  backgroundChoice: BackgroundChoice | null
  revision: number
  createdAt: string
  lastProcess: SessionProcessStatus | null
  /** Actionable reason persisted launch metadata cannot currently be used. */
  launchDisabledReason?: string
}

export interface LaunchTemplateRecord {
  templateId: string
  name: string
  executable: string
  argv: string[]
  cwd: string
  backgroundChoice: BackgroundChoice | null
  revision: number
  createdAt: string
  /** Actionable reason persisted launch metadata cannot currently be applied. */
  launchDisabledReason?: string
}

export interface WorkspaceLayoutState {
  workspaceId: string
  selectedSessionId: string | null
  split: {
    orientation: 'stacked' | 'side-by-side'
    panes: Array<{ sessionId: string; ratio: number }>
  }
  sessionView: Record<string, {
    scrollLine: number | null
    followTail: boolean
  }>
  revision: number
}

export interface WorkspaceListParams {
  includeArchived?: boolean
}

export interface WorkspaceCreateParams {
  name: string
  defaultCwd?: string | null
  position?: number
}

export interface WorkspaceUpdateParams {
  workspaceId: string
  expectedRevision: number
  name?: string
  defaultCwd?: string | null
  position?: number
  archived?: boolean
}

export interface SessionListParams {
  workspaceId: string
}

export interface SessionCreateParams {
  workspaceId: string
  name: string
  cwd: string
  executable: string
  argv: string[]
  cols: number
  rows: number
  backgroundChoice?: BackgroundChoice | null
}

export interface SessionUpdateParams {
  sessionId: string
  expectedRevision: number
  workspaceId?: string
  name?: string
  cwd?: string
  executable?: string
  argv?: string[]
  position?: number
  backgroundChoice?: BackgroundChoice | null
}

export interface SessionStopParams {
  sessionId: string
  incarnationId: string
  cause: SessionStopCause
}

export type TemplateListParams = Record<string, never>

export interface TemplateCreateParams {
  name: string
  executable: string
  argv: string[]
  cwd: string
  backgroundChoice?: BackgroundChoice | null
}

export interface LayoutGetParams {
  workspaceId: string
}

export interface LayoutPutParams {
  workspaceId: string
  expectedRevision: number
  state: WorkspaceLayoutState
}

export interface ExplicitConversationBinding extends BoundConversationBinding {
  captureRoute: 'explicit-resume-reference'
}

export interface SessionBindingReplaceParams {
  binding: ExplicitConversationBinding
}

export interface SessionBindingClearParams {
  sessionId: string
}

export type WorkspaceListResult = WorkspaceRecord[]
export type WorkspaceCreateResult = WorkspaceRecord
export type WorkspaceUpdateResult = WorkspaceRecord
export type SessionListResult = SessionRecord[]
export type SessionCreateResult = {
  sessionId: string
  incarnationId: string
  binding: PersistedConversationBinding
}
export type SessionUpdateResult = SessionRecord
export type TemplateListResult = LaunchTemplateRecord[]
export type TemplateCreateResult = LaunchTemplateRecord
/**
 * A layout is a per-workspace view cache. When the persisted row is unreadable or invalid the host
 * returns that workspace's empty layout at the row's revision plus a visible notice; the row is
 * not rewritten on read and the next valid put replaces it.
 */
export interface LayoutGetResult {
  layout: WorkspaceLayoutState
  notice: string | null
}
export type LayoutPutResult = WorkspaceLayoutState
export type SessionBindingReplaceResult = ExplicitConversationBinding
export interface SessionBindingClearResult {
  cleared: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const WORKSPACE_RECORD_KEYS = ['workspaceId', 'name', 'defaultCwd', 'position', 'archivedAt', 'revision'] as const
const SESSION_RECORD_KEYS = [
  'sessionId', 'workspaceId', 'name', 'cwd', 'executable', 'argv', 'position', 'backgroundChoice',
  'revision', 'createdAt', 'lastProcess'
] as const
const SESSION_RECORD_OPTIONAL_KEYS = ['launchDisabledReason'] as const
const SESSION_PROCESS_KEYS = ['incarnationId', 'state', 'exitCode', 'signal', 'detail'] as const
const TEMPLATE_RECORD_KEYS = [
  'templateId', 'name', 'executable', 'argv', 'cwd', 'backgroundChoice', 'revision', 'createdAt'
] as const
const TEMPLATE_RECORD_OPTIONAL_KEYS = ['launchDisabledReason'] as const
const WORKSPACE_UPDATE_FIELDS = ['name', 'defaultCwd', 'position', 'archived'] as const
const SESSION_UPDATE_FIELDS = [
  'workspaceId', 'name', 'cwd', 'executable', 'argv', 'position', 'backgroundChoice'
] as const
const SESSION_STOP_KEYS = ['sessionId', 'incarnationId', 'cause'] as const
const LAYOUT_KEYS = ['workspaceId', 'selectedSessionId', 'split', 'sessionView', 'revision'] as const
const LAYOUT_SPLIT_KEYS = ['orientation', 'panes'] as const
const LAYOUT_PANE_KEYS = ['sessionId', 'ratio'] as const
const LAYOUT_VIEW_KEYS = ['scrollLine', 'followTail'] as const

/** The one empty layout for a workspace: owned here, consumed by the host store and the renderer. */
export function emptyWorkspaceLayout(workspaceId: string): WorkspaceLayoutState {
  return {
    workspaceId,
    selectedSessionId: null,
    split: { orientation: 'side-by-side', panes: [] },
    sessionView: {},
    revision: 1
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= WORKSPACE_NAME_MAX_LENGTH
  )
}

function isPosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isBackgroundChoice(value: unknown): value is BackgroundChoice | null {
  return value === null || value === 'hide' || value === 'stop'
}

function isRfc3339(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (!isRecord(value) || !hasExactKeys(value, WORKSPACE_RECORD_KEYS)) return false
  return (
    isIdentifier(value.workspaceId) &&
    isName(value.name) &&
    isNullableText(value.defaultCwd) &&
    isPosition(value.position) &&
    (value.archivedAt === null || isRfc3339(value.archivedAt)) &&
    isRevision(value.revision)
  )
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value)
}

export function isSessionProcessStatus(value: unknown): value is SessionProcessStatus {
  if (!isRecord(value) || !hasExactKeys(value, SESSION_PROCESS_KEYS)) return false
  if (!isIdentifier(value.incarnationId) || !isNullableText(value.detail)) return false
  if (!isNullableInteger(value.exitCode) || !isNullableInteger(value.signal)) return false
  if (value.state === 'exited') return value.detail === null
  if (value.state === 'interrupted') return value.exitCode === null && value.signal === null
  return value.state === 'live' && value.exitCode === null && value.signal === null && value.detail === null
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isRecord(value) || !hasExactKeys(value, SESSION_RECORD_KEYS, SESSION_RECORD_OPTIONAL_KEYS)) {
    return false
  }
  return (
    isIdentifier(value.sessionId) &&
    isIdentifier(value.workspaceId) &&
    isName(value.name) &&
    typeof value.cwd === 'string' &&
    isIdentifier(value.executable) &&
    isStringArray(value.argv) &&
    isPosition(value.position) &&
    isBackgroundChoice(value.backgroundChoice) &&
    isRevision(value.revision) &&
    isRfc3339(value.createdAt) &&
    (!('launchDisabledReason' in value) ||
      (typeof value.launchDisabledReason === 'string' &&
        value.launchDisabledReason.trim().length > 0)) &&
    (value.lastProcess === null || isSessionProcessStatus(value.lastProcess))
  )
}

export function isLaunchTemplateRecord(value: unknown): value is LaunchTemplateRecord {
  if (!isRecord(value) || !hasExactKeys(value, TEMPLATE_RECORD_KEYS, TEMPLATE_RECORD_OPTIONAL_KEYS)) {
    return false
  }
  return (
    isIdentifier(value.templateId) &&
    isName(value.name) &&
    isIdentifier(value.executable) &&
    isStringArray(value.argv) &&
    typeof value.cwd === 'string' &&
    isBackgroundChoice(value.backgroundChoice) &&
    isRevision(value.revision) &&
    isRfc3339(value.createdAt) &&
    (!('launchDisabledReason' in value) ||
      (typeof value.launchDisabledReason === 'string' &&
        value.launchDisabledReason.trim().length > 0))
  )
}

export function isWorkspaceCreateParams(value: unknown): value is WorkspaceCreateParams {
  if (!isRecord(value) || !hasExactKeys(value, ['name'], ['defaultCwd', 'position'])) return false
  if (!isName(value.name)) return false
  if ('defaultCwd' in value && !isNullableText(value.defaultCwd)) return false
  return !('position' in value) || isPosition(value.position)
}

export function isWorkspaceUpdateParams(value: unknown): value is WorkspaceUpdateParams {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['workspaceId', 'expectedRevision'], WORKSPACE_UPDATE_FIELDS) ||
    !isIdentifier(value.workspaceId) ||
    !isRevision(value.expectedRevision)
  ) {
    return false
  }
  if ('name' in value && !isName(value.name)) return false
  if ('defaultCwd' in value && !isNullableText(value.defaultCwd)) return false
  if ('position' in value && !isPosition(value.position)) return false
  if ('archived' in value && typeof value.archived !== 'boolean') return false
  return WORKSPACE_UPDATE_FIELDS.some((key) => key in value)
}

export function isSessionCreateParams(value: unknown): value is SessionCreateParams {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['workspaceId', 'name', 'cwd', 'executable', 'argv', 'cols', 'rows'],
      ['backgroundChoice']
    )
  ) {
    return false
  }
  return (
    isIdentifier(value.workspaceId) &&
    isName(value.name) &&
    (!('backgroundChoice' in value) || isBackgroundChoice(value.backgroundChoice)) &&
    typeof value.cwd === 'string' &&
    isIdentifier(value.executable) &&
    isStringArray(value.argv) &&
    Number.isSafeInteger(value.cols) &&
    Number.isSafeInteger(value.rows)
  )
}

export function isSessionUpdateParams(value: unknown): value is SessionUpdateParams {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['sessionId', 'expectedRevision'], SESSION_UPDATE_FIELDS) ||
    !isIdentifier(value.sessionId) ||
    !isRevision(value.expectedRevision)
  ) {
    return false
  }
  if ('workspaceId' in value && !isIdentifier(value.workspaceId)) return false
  if ('name' in value && !isName(value.name)) return false
  if ('cwd' in value && typeof value.cwd !== 'string') return false
  if ('executable' in value && !isIdentifier(value.executable)) return false
  if ('argv' in value && !isStringArray(value.argv)) return false
  if ('position' in value && !isPosition(value.position)) return false
  if ('backgroundChoice' in value && !isBackgroundChoice(value.backgroundChoice)) return false
  return SESSION_UPDATE_FIELDS.some((key) => key in value)
}

export function isSessionStopParams(value: unknown): value is SessionStopParams {
  if (!isRecord(value) || !hasExactKeys(value, SESSION_STOP_KEYS)) return false
  return (
    isIdentifier(value.sessionId) &&
    isIdentifier(value.incarnationId) &&
    (value.cause === 'explicit' ||
      value.cause === 'application-quit' ||
      value.cause === 'close-last-window' ||
      value.cause === 'update-restart')
  )
}

export function isTemplateCreateParams(value: unknown): value is TemplateCreateParams {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['name', 'executable', 'argv', 'cwd'], ['backgroundChoice'])
  ) {
    return false
  }
  return (
    isName(value.name) &&
    isIdentifier(value.executable) &&
    isStringArray(value.argv) &&
    typeof value.cwd === 'string' &&
    (!('backgroundChoice' in value) || isBackgroundChoice(value.backgroundChoice))
  )
}

export function isWorkspaceLayoutState(
  value: unknown,
  workspaceSessionIds: ReadonlySet<string> | readonly string[]
): value is WorkspaceLayoutState {
  if (!isRecord(value) || !hasExactKeys(value, LAYOUT_KEYS)) return false
  if (!isIdentifier(value.workspaceId) || !isRevision(value.revision)) return false
  if (!isRecord(value.split) || !hasExactKeys(value.split, LAYOUT_SPLIT_KEYS)) return false
  if (!isRecord(value.sessionView)) return false
  if (value.split.orientation !== 'stacked' && value.split.orientation !== 'side-by-side') {
    return false
  }
  if (!Array.isArray(value.split.panes) || value.split.panes.length > 2) return false

  const allowed = workspaceSessionIds instanceof Set
    ? workspaceSessionIds
    : new Set(workspaceSessionIds)
  const paneSessionIds = new Set<string>()
  let ratioTotal = 0
  for (const pane of value.split.panes) {
    if (!isRecord(pane) || !hasExactKeys(pane, LAYOUT_PANE_KEYS) || !isIdentifier(pane.sessionId)) {
      return false
    }
    if (!allowed.has(pane.sessionId) || paneSessionIds.has(pane.sessionId)) return false
    if (typeof pane.ratio !== 'number' || !Number.isFinite(pane.ratio) || pane.ratio <= 0) {
      return false
    }
    paneSessionIds.add(pane.sessionId)
    ratioTotal += pane.ratio
  }
  if (value.split.panes.length === 0) {
    if (value.selectedSessionId !== null) return false
  } else {
    if (!isIdentifier(value.selectedSessionId) || !paneSessionIds.has(value.selectedSessionId)) {
      return false
    }
    if (Math.abs(ratioTotal - 1) > LAYOUT_RATIO_TOLERANCE) return false
  }

  for (const [sessionId, view] of Object.entries(value.sessionView)) {
    if (!allowed.has(sessionId) || !isRecord(view) || !hasExactKeys(view, LAYOUT_VIEW_KEYS)) {
      return false
    }
    if (
      view.scrollLine !== null &&
      (typeof view.scrollLine !== 'number' ||
        !Number.isSafeInteger(view.scrollLine) ||
        view.scrollLine < 0)
    ) {
      return false
    }
    if (typeof view.followTail !== 'boolean') return false
  }
  return true
}
