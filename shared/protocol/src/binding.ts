export type AgentCli = 'claude' | 'codex' | 'opencode' | 'other'

export interface ConversationLaunchContext {
  cwd: string
  executable: string
  argv: readonly string[]
  environment: Readonly<Record<string, string | null>>
}

interface ConversationBindingBase {
  sessionId: string
  agentCli: AgentCli
  launchContext: ConversationLaunchContext
  detail: string
  capturedAt: string
}

export interface BoundConversationBinding extends ConversationBindingBase {
  agentCli: 'claude' | 'codex' | 'opencode'
  status: 'bound'
  conversationReference: string
  captureRoute: 'claude-session-id' | 'explicit-resume-reference' | 'hook-session-start'
}

/** The harness's own SessionStart word: which conversation the running process is in right now. */
export type ConversationObservationSource = 'startup' | 'resume' | 'clear' | 'fork'

export interface ConversationObservation {
  sessionId: string
  incarnationId: string | null
  agentCli: 'claude' | 'codex' | 'opencode'
  conversationReference: string
  source: ConversationObservationSource
  transcriptPath?: string
}

export interface ConversationObservationResult {
  accepted: boolean
  detail: string
}

export interface MissingConversationBinding extends ConversationBindingBase {
  agentCli: 'claude' | 'codex' | 'opencode'
  status: 'missing'
  conversationReference: string
  captureRoute: BoundConversationBinding['captureRoute']
}

export interface UnsupportedConversationBinding extends ConversationBindingBase {
  status: 'unsupported'
  captureRoute: 'unsupported'
}

export type ConversationBindingState =
  | BoundConversationBinding
  | MissingConversationBinding
  | UnsupportedConversationBinding

export type PersistedConversationBinding =
  | BoundConversationBinding
  | UnsupportedConversationBinding

/**
 * What `session.list` and `state.snapshot` say about a session's conversation: the route only,
 * never the reference. Added beside the existing fields, so a client that ignores it is unaffected.
 */
export interface ConversationRouteSummary {
  sessionId: string
  status: PersistedConversationBinding['status']
  captureRoute: PersistedConversationBinding['captureRoute']
}

export interface SessionBindingGetParams {
  sessionId: string
}

export interface SessionResumeParams {
  sessionId: string
  cols: number
  rows: number
}

export interface SessionResumeResult {
  sessionId: string
  incarnationId: string
  attachmentId: string
  streamSeq: 0
  captureStartedAt: string
  /** The private terminal modes a new view would get wrong; empty when a fresh view matches. */
  modes: number[]
  binding: BoundConversationBinding
}

/**
 * What Resume will run, read before anything starts. `command` is built from the same launch the
 * process is started with, so the owner confirms the exact command rather than a description.
 */
export interface ConversationResumePreview {
  sessionId: string
  agentCli: 'claude' | 'codex' | 'opencode'
  conversationReference: string
  command: string
  /** Stored arguments `<cli> resume` will not accept, named for the owner; empty when none. */
  notCarried: string
}

export interface TerminalActivateParams {
  attachmentId: string
}

export interface TerminalActivateResult {
  activated: true
}
