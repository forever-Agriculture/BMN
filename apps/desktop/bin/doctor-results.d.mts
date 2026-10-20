// MODULE: doctor-results.d.mts - Types for the strict doctor publication boundary
import type { DoctorCheck, DoctorLeftover, DoctorProblem, DoctorState } from '../../../shared/protocol/src/doctor'
export interface ProjectedDoctorResult { state: DoctorState; problems: DoctorProblem[]; leftovers?: DoctorLeftover[] }
export declare const CHECKS: readonly DoctorCheck[]
export declare const STATES: readonly DoctorState[]
export declare const PROBLEMS: Readonly<Record<string, readonly [string, string]>>
export declare function parseCodexDoctor(text: string, exitCode: number | null): ProjectedDoctorResult
export declare function parseClaudeDoctor(text: string, exitCode: number | null): ProjectedDoctorResult
export declare function parseBmnDoctor(check: DoctorCheck, text: string, exitCode: number | null): ProjectedDoctorResult
export declare function projectedResult(value: unknown): ProjectedDoctorResult | null
