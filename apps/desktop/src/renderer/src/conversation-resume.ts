import type { ConversationBindingState } from '@bmn/protocol'

export interface ConversationBindingPresentation {
  label: string
  detail: string
  canResume: boolean
  canLocate: boolean
  canStartNew: boolean
}

export function conversationBindingPresentation(
  binding: ConversationBindingState | undefined
): ConversationBindingPresentation {
  if (!binding) {
    return {
      label: 'Conversation binding loading',
      detail: 'Checking whether this CLI conversation can be resumed exactly.',
      canResume: false,
      canLocate: false,
      canStartNew: false
    }
  }
  const cli = binding.agentCli === 'other'
    ? 'CLI'
    : `${binding.agentCli[0]!.toUpperCase()}${binding.agentCli.slice(1)}`
  if (binding.status === 'bound') {
    return {
      label: `${cli} conversation bound`,
      detail: `${binding.detail}. Reference ${binding.conversationReference}.`,
      canResume: true,
      canLocate: false,
      canStartNew: false
    }
  }
  if (binding.status === 'missing') {
    return {
      label: 'Chat unavailable',
      detail: binding.detail,
      canResume: false,
      canLocate: true,
      canStartNew: true
    }
  }
  return {
    label: `${cli} conversation resume unsupported`,
    detail: binding.detail,
    canResume: false,
    canLocate: false,
    canStartNew: true
  }
}

export async function resumeBoundConversation<Result>(
  binding: ConversationBindingState | undefined,
  resume: () => Promise<Result>
): Promise<{ started: true; result: Result } | { started: false; message: string }> {
  const presentation = conversationBindingPresentation(binding)
  if (!presentation.canResume) return { started: false, message: presentation.detail }
  return { started: true, result: await resume() }
}
