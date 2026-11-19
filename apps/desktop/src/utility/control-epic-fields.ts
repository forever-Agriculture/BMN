// MODULE: control-epic-fields.ts - Epic 132 on the control socket: the bound run's methods and the native hook's own fields
import type { ForegroundCaller } from './foreground-process'

/** Reads the socket peer's process once the handler needs it (Epic 132). */
export type NativePeer = () => Promise<ForegroundCaller | undefined>

/** Answering an action or unbinding a run is the owner's, in the window or Telegram; no socket caller may. */
export const EPIC_OWNER_ONLY = 'Only the owner in the BMN window or Telegram may answer. Unbind is available in the BMN window.'

/** Each socket method of a bound run (Epic 132) and the parameters it may carry. */
export const EPIC_ACTION_PARAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'epic.actions.ask': ['project', 'epic', 'callerPid'],
  'epic.actions.status': ['project', 'epic', 'callerPid'],
  'epic.run.bind': ['project', 'epic', 'callerPid'],
  'epic.run.status': [],
  'epic.run.reserve': ['action', 'useId', 'command', 'cwd', 'callerPid'],
  'epic.run.dispatch': ['action', 'useId', 'command', 'cwd', 'callerPid'],
  'epic.run.result': ['useId', 'outcome', 'callerPid'],
  'epic.guard.claim': ['agent', 'conversation', 'callerPid', 'command', 'cwd', 'callId']
})

export interface NativeHookFields {
  callerPid?: number
  epicActionCall?: string
  /** What the native Bash result said about its exit, where it named a code (Codex has no failure event). */
  epicActionExit?: 'ok' | 'failed'
}

/** What a hook event hands its handler beyond the event itself. */
export interface NativeHookObservation {
  callerPid?: number | undefined
  caller?: ForegroundCaller | undefined
  epicActionCall?: string | undefined
  epicActionExit?: 'ok' | 'failed' | undefined
}

/** A conversation observation's hook process: absent, a real process id, or null when it names none. */
export function observerPid(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1 ? value : null
}

/**
 * A hook event's native fields, or why they are refused. Only a session's own native conversation (Claude Code or Codex,
 * not nested) may carry them: its end names the caller process, a Bash result names the epic action call it settles.
 */
export function nativeHookFields(params: Record<string, unknown>, event: { session: boolean; name: string;
  conversation: string | undefined; agent: string; toolName: string | undefined; call: string | undefined }): NativeHookFields | string {
  const native = event.session && event.conversation !== undefined && params.nested !== true && (event.agent === 'claude' || event.agent === 'codex')
  const callerPid = params.callerPid
  if (callerPid !== undefined && (!native || event.name !== 'SessionEnd' ||
    typeof callerPid !== 'number' || !Number.isSafeInteger(callerPid) || callerPid <= 1)) {
    return 'Only the native conversation’s end carries a caller process'
  }
  const call = event.call
  if (call !== undefined && (!native || (event.name !== 'PostToolUse' && event.name !== 'PostToolUseFailure') || event.toolName !== 'Bash')) {
    return 'An epic action outcome needs its native Bash call'
  }
  const exit = params.epicActionExit
  if (exit !== undefined && (exit !== 'ok' && exit !== 'failed' || call === undefined)) return 'epicActionExit must be ok or failed, with its Bash call'
  return { ...(typeof callerPid === 'number' ? { callerPid } : {}), ...(call === undefined ? {} : { epicActionCall: call }),
    ...(exit === undefined ? {} : { epicActionExit: exit }) }
}
