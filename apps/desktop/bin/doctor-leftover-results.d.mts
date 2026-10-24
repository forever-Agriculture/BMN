// MODULE: doctor-leftover-results.d.mts - Fixed show-only inventory projection types
import type { DoctorLeftover } from '../../../shared/protocol/src/doctor'
export declare const LEFTOVER_REASONS: Readonly<Record<string, string>>
export declare function leftoverLocation(item: DoctorLeftover): string
export declare function validateLeftovers(value: unknown): DoctorLeftover[] | null
