// MODULE: agents-supervised.d.mts - types for the supervised run of a checked command (Epic 64)
import type { ChildProcess } from 'node:child_process'

/** A process as a lock names it: its number and the start time it had then. */
export interface ProcessIdentity { pid: number; start: string }
/** The supervisor's code when it ended without starting the command. */
export declare const NOTHING_STARTED: 125
export declare function processStart(pid: number): string | null
export declare function processLives(identity: unknown): boolean
export declare function supervisorScript(): string | null
export interface SupervisedRun {
  /** The supervisor's own process; absent when none could be made. */
  child?: ChildProcess
  /** Asks the command to end, and makes it after a moment. */
  stop?: () => void
  /** Ends the command at once. */
  kill?: () => void
  /** Why the command was never started. */
  failed?: string
}
export declare function startSupervised(argv: string[], options: {
  cwd: string
  stdio: ['ignore' | number, 'ignore' | 'pipe', 'ignore' | 'pipe']
  deadline: number
  register?: (supervisor: ProcessIdentity) => void
}): SupervisedRun
