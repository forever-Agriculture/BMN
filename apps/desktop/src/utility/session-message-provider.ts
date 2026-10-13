// MODULE: session-message-provider.ts - asks the approved team whether a receiving agent's provider may see a sender's work (Epic 66.4)
import { privateWorkAnswer, workspaceRoot } from '../../bin/agents-check.mjs'
import { readApproved } from '../../bin/agents-state.mjs'
import type { MessageDestination } from './session-messages'

/** The Git root (or the folder itself) a resolved, existing folder belongs to: the prompt guard's own rule. */
export function messageSourceRoot(folder: string): string {
  return workspaceRoot(folder)
}

/**
 * The prompt guard's question (bin/agents-guard.mjs `decide`), asked for a message instead of a prompt: may the
 * provider the receiving agent's hook resolved see private work in the root the message came from? The
 * approved team is read at this call, so an exception the owner made or withdrew a moment ago counts. A
 * destination that is only the owner's word, or names no provider of the team, gets nothing. It throws when
 * no approved team can be read, which the caller treats as a refusal.
 */
export function messageProviderAnswer(destination: MessageDestination, senderRoot: string): { allowed: boolean; reason: string } {
  const data = readApproved().data
  if (!data.providers.some((provider) => provider.id === destination.provider)) {
    return { allowed: false, reason: 'the approved team names no such provider' }
  }
  const answer = privateWorkAnswer(data, {
    known: true, default: destination.default, provider: destination.provider, host: destination.host, basis: destination.basis
  }, senderRoot)
  return { allowed: answer.allowed, reason: answer.reason }
}
