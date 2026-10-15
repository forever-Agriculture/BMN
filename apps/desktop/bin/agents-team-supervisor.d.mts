// MODULE: agents-team-supervisor.d.mts - types for the supervisor of one teammate's ask (Epic 72)
import type { ProcessIdentity } from './agents-supervised.mjs'
export declare const KILL_AFTER_MS: number
export declare const RUN_FILES: Readonly<{ launch: string; state: string; stop: string; events: string; stderr: string; exit: string; args: string }>
export declare function writeWhole(path: string, text: string): void
export declare function teamSupervisorScript(): string | null
export declare function folderBytes(folder: string): number
export declare function startTeamSupervisor(folder: string, options?: { execPath?: string }): { pid: number; start: string; failed?: undefined } | { failed: string; pid?: undefined; start?: undefined }
export declare function requestStop(folder: string): void
export declare function runState(folder: string): { state: string; exit: Record<string, unknown> | null; was?: string }
export declare function supervisorLives(identity: ProcessIdentity | unknown): boolean
