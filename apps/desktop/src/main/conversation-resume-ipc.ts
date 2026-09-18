import {
  METHOD_REGISTRY,
  type ConversationBindingState,
  type ExplicitConversationBinding,
  type ProtocolMethod,
  type SessionBindingClearResult,
  type SessionResumeResult,
  type TerminalActivationResult
} from '@bmn/protocol'

export interface ConversationHostClient {
  request<Result>(method: ProtocolMethod, params: object): Promise<Result>
}

export type ResumedAttachment = SessionResumeResult

export function loadConversationBinding(
  client: ConversationHostClient,
  sessionId: string
): Promise<ConversationBindingState> {
  return client.request(METHOD_REGISTRY.sessionBindingGet, { sessionId })
}

export async function resumeBoundSession(
  client: ConversationHostClient,
  sessionId: string,
  dimensions: { cols: number; rows: number }
): Promise<ResumedAttachment> {
  return client.request<SessionResumeResult>(METHOD_REGISTRY.sessionResume, {
    sessionId,
    ...dimensions
  })
}

export function activateBoundSession(
  client: ConversationHostClient,
  attachmentId: string
): Promise<TerminalActivationResult> {
  return client.request(METHOD_REGISTRY.terminalActivate, { attachmentId })
}

export function locateConversationBinding(
  client: ConversationHostClient,
  binding: ExplicitConversationBinding
): Promise<ExplicitConversationBinding> {
  return client.request(METHOD_REGISTRY.sessionBindingReplace, { binding })
}

export function startNewConversation(
  client: ConversationHostClient,
  sessionId: string
): Promise<SessionBindingClearResult> {
  return client.request(METHOD_REGISTRY.sessionBindingClear, { sessionId })
}
