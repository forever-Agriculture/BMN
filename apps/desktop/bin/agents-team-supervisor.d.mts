// MODULE: agents-team-supervisor.d.mts - types for the supervisor of one teammate's ask (Epic 72)
import type { ProcessIdentity } from './agents-supervised.mjs'
export declare const KILL_AFTER_MS: number
export declare const RUN_FILES: Readonly<{ launch: string; state: string; stop: string; events: string; stderr: string; exit: string; status: string }>
export declare const SYSTEMD_RUN: string
export declare const SCOPE_WRAPPER: string
export declare function writeWhole(path: string, text: string): void
export declare function scopeEnvironment(environment?: NodeJS.ProcessEnv | Record<string, string>): Record<string, string>
export declare function scopeUnit(id: string): string
export declare function scopeStarts(options?: { environment?: NodeJS.ProcessEnv | Record<string, string>; timeoutMs?: number; systemdRun?: string }): { ok: true; reason?: undefined } | { ok: false; reason: string }
export declare function cgroupOf(pid: number): string | null
export declare function endScope(cgroup: unknown, id: string): boolean
export declare function teamSupervisorScript(): string | null
export declare function startTeamSupervisor(folder: string, options?: { execPath?: string; environment?: NodeJS.ProcessEnv | Record<string, string> }): { pid: number; start: string; failed?: undefined } | { failed: string; pid?: undefined; start?: undefined }
export declare function requestStop(folder: string): void
export declare function runState(folder: string): { state: string; exit: Record<string, unknown> | null; was?: string }
export declare function supervisorLives(identity: ProcessIdentity | unknown): boolean
