// MODULE: agents-guard.d.mts - types for the prompt guard so the main process can ask it again before an exception is recorded
export type GuardCause = 'inactive' | 'allowed' | 'exception' | 'public-only' | 'declared' | 'unknown' | 'state' | 'process' | 'slow'
export interface GuardInput {
  agent: string
  /** The owner's agent process; 0 when the process table could not tell. */
  pid: number
  procRoot?: string
  /** Only where and which session: the prompt is never part of a decision. */
  event: { cwd?: unknown; session_id?: unknown; transcript_path?: unknown }
}
export interface GuardVerdict {
  agent: string
  app: string
  outcome: 'pass' | 'stop'
  cause: GuardCause
  line?: string
  allow?: boolean
  pid: number | null
  start: string | null
  folder: string | null
  /** The folder the agent's own process is in, as the system reports it. */
  processFolder: string | null
  workspace: string | null
  provider: { id: string; name: string } | null
  host: string | null
  name: string | null
  exception?: string | null
}
export declare const GUARD_LIMIT_MS: number
export declare const GUARD_APPS: Record<string, { event: string; stops: boolean }>
export declare const GUARD_MEASURED: Record<string, string | null>
export declare function guardState(): { state: 'inactive' } | { state: 'active'; data: import('./agents-roster.mjs').RosterData } | { state: 'broken'; fix: string }
export declare function readAgentProcess(procRoot: string, pid: number): { argv: string[]; env: Record<string, string>; cwd: string | null; start: string | null } | null
export declare function parseLaunch(agent: string, argv: string[]): Record<string, unknown> & { unknown?: string }
export declare function decide(input: GuardInput): GuardVerdict
/** `startThread` is the seam for tests: what starts the thread that decides. */
export declare function decideWithin(input: GuardInput, limitMs?: number, seams?: { startThread?: (data: { bmnGuard: GuardInput }) => { once(event: string, listener: (...values: unknown[]) => void): unknown; terminate(): unknown } }): Promise<GuardVerdict>
export declare function stopAnswer(agent: string, line: string): string | null
export declare function guardStanding(agent: string): string
/** Epic 66.4: where an agent sends work, as its own hook resolved it for an event after a tool call. */
export interface MessageDestination { provider: string; host: string; basis: string; default: boolean }
export declare const MESSAGE_HANDOVER: Record<string, { event: string; version: string } | undefined>
export declare const MESSAGE_LIMIT_MS: number
export declare function messageDestination(input: GuardInput): MessageDestination | null
export declare function messageDestinationWithin(input: GuardInput, limitMs?: number, seams?: { startThread?: (data: { bmnMessageDestination: GuardInput }) => { once(event: string, listener: (...values: unknown[]) => void): unknown; terminate(): unknown } }): Promise<MessageDestination | null>
export declare function messageStanding(agent: string): string
