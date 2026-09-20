export type AgentCli = 'claude' | 'codex' | 'other'

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
  agentCli: 'claude' | 'codex'
  status: 'bound'
  conversationReference: string
  captureRoute: 'claude-session-id' | 'explicit-resume-reference' | 'hook-session-start'
}

/** The harness's own SessionStart word: which conversation the running process is in right now. */
export type ConversationObservationSource = 'startup' | 'resume' | 'clear' | 'fork'

export interface ConversationObservation {
  sessionId: string
  incarnationId: string | null
  agentCli: 'claude' | 'codex'
  conversationReference: string
  source: ConversationObservationSource
  transcriptPath?: string
}

export interface ConversationObservationResult {
  accepted: boolean
  detail: string
}

export interface MissingConversationBinding extends ConversationBindingBase {
  agentCli: 'claude' | 'codex'
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
  binding: BoundConversationBinding
}

export interface TerminalActivateParams {
  attachmentId: string
}

export interface TerminalActivateResult {
  activated: true
}
