// MODULE: lifecycle.ts - what the owner is asked when closing or quitting would leave live processes behind
import type { BackgroundChoice } from './workspace'

/** Why the owner is being asked: closing the last window, or quitting outright. */
export type ClosePromptMode = 'close' | 'quit'

/**
 * One running session, named the way the owner named it. Identifiers stay in the main process:
 * a person deciding whether to keep their work running has no use for a UUID. The window fills in
 * the workspace and whether the agent is working from its own live state.
 */
export interface ClosePromptSession {
  sessionId: string
  name: string
  /** The command's own name, never its path: `claude`, `codex`, `bash`. */
  agent: string
  /** `exit-unconfirmed` states a fact -- the process outcome is unknown -- and is not an alarm. */
  processState: 'live' | 'exit-unconfirmed'
}

export interface ClosePromptRequest {
  requestId: string
  mode: ClosePromptMode
  sessions: ClosePromptSession[]
}

/**
 * The owner's answer. `choices` carries one choice per session so a close can keep one agent
 * working and stop another; a session the renderer omits is kept running, never stopped.
 */
export type ClosePromptDecision =
  | { kind: 'cancel' }
  | { kind: 'proceed'; choices: Record<string, BackgroundChoice>; remember: boolean }

function isChoiceMap(value: unknown): value is Record<string, BackgroundChoice> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((choice) => choice === 'hide' || choice === 'stop')
  )
}

/** Validates a decision arriving from the renderer; anything unrecognized is refused, not guessed. */
export function isClosePromptDecision(value: unknown): value is ClosePromptDecision {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { kind?: unknown; choices?: unknown; remember?: unknown }
  if (candidate.kind === 'cancel') return true
  return (
    candidate.kind === 'proceed' &&
    typeof candidate.remember === 'boolean' &&
    isChoiceMap(candidate.choices)
  )
}

function isPromptSession(value: unknown): value is ClosePromptSession {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ClosePromptSession>
  return (
    typeof candidate.sessionId === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.agent === 'string' &&
    (candidate.processState === 'live' || candidate.processState === 'exit-unconfirmed')
  )
}

/** Validates a prompt arriving in the renderer, which draws nothing it cannot read completely. */
export function isClosePromptRequest(value: unknown): value is ClosePromptRequest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ClosePromptRequest>
  return (
    typeof candidate.requestId === 'string' &&
    (candidate.mode === 'close' || candidate.mode === 'quit') &&
    Array.isArray(candidate.sessions) &&
    candidate.sessions.every(isPromptSession)
  )
}
