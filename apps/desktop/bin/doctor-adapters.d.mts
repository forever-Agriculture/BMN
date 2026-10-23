// MODULE: doctor-adapters.d.mts - Sandbox and disposable doctor qualification types
import type { ProjectedDoctorResult } from './doctor-results.mjs'
import type { DoctorQualification } from './doctor-state.mjs'
export interface DoctorLimits { timeoutMs?: number; outputBytes?: number }
export interface DoctorExecutable { executable: string | null; version: string | null; identity: string; executableIdentity?: string }
export interface DoctorVersions { identity: string; apps: Record<'claude' | 'codex' | 'opencode', DoctorExecutable> }
export declare const SANDBOX_POLICY: string
export declare const PARSER_VERSION: string
export declare const LIMITS: Readonly<{ timeoutMs: number; outputBytes: number }>
export declare function boundedProcess(command: string, args: string[], options?: DoctorLimits & { environment?: NodeJS.ProcessEnv; cwd?: string }): Promise<{ code: number | null; failure: 'timeout' | 'overflow' | 'unavailable' | null; stdout: string }>
export declare function doctorEnvironment(environment: NodeJS.ProcessEnv, home?: string): Record<string, string>
export declare function sandboxArguments(home: string, command: string, args: string[], environment?: NodeJS.ProcessEnv, options?: { runtime?: boolean }): string[]
export declare function sandboxProcess(home: string, command: string, args: string[], environment: NodeJS.ProcessEnv, limits?: DoctorLimits & { inspection?: boolean; runtime?: boolean }): ReturnType<typeof boundedProcess>
export declare function qualificationProcess(home: string, command: string, args: string[], environment: NodeJS.ProcessEnv, limits?: DoctorLimits): ReturnType<typeof boundedProcess>
export declare function executableIdentity(path: string): string
export declare function doctorVersions(environment: NodeJS.ProcessEnv): Promise<DoctorVersions>
export declare function stillSameExecutable(entry: DoctorExecutable): boolean
export declare function qualifyDoctor(app: 'claude' | 'codex', entry: DoctorExecutable, environment: NodeJS.ProcessEnv, limits?: DoctorLimits): Promise<DoctorQualification['state']>
export declare function runAppDoctor(app: 'claude' | 'codex', entry: DoctorExecutable, home: string, environment: NodeJS.ProcessEnv, limits?: DoctorLimits): Promise<ProjectedDoctorResult>
export declare function runBmnDoctor(check: 'hooks' | 'skills' | 'tools' | 'rules', home: string, environment: NodeJS.ProcessEnv, limits?: DoctorLimits): Promise<ProjectedDoctorResult>
export declare function runLeftoversDoctor(home: string, environment: NodeJS.ProcessEnv, versions: Record<string, string | null>, limits?: DoctorLimits): Promise<ProjectedDoctorResult>
