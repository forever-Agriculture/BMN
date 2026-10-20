// MODULE: doctor-leftover-results.d.mts - Fixed show-only inventory projection types
import type { DoctorLeftover } from '../../../shared/protocol/src/doctor'
import type { ProjectedDoctorResult } from './doctor-results.mjs'
export declare const LEFTOVER_REASONS: Readonly<Record<string, string>>
export declare function leftoverLocation(item: DoctorLeftover): string
export declare function validateLeftovers(value: unknown): DoctorLeftover[] | null
export declare function projectLeftovers(report: Record<string, unknown>): ProjectedDoctorResult
