// MODULE: doctor-state.d.mts - Durable doctor state and cadence types
import type { DoctorCheck, DoctorView } from '../../../shared/protocol/src/doctor'
import type { ProjectedDoctorResult } from './doctor-results.mjs'
import type { ContinuityEnvelope } from './doctor-continuity.mjs'
export interface SavedDoctorResult extends ProjectedDoctorResult { checkedAt: number; version: string; acquisitionId?: string }
export interface DoctorAttempt {
  id: string; startedAt: number; finishedAt: number | null; kind: 'cycle' | 'retry' | 'availability'; startupId: string | null
  checks: DoctorCheck[]; completed: DoctorCheck[]
  /** Missing on legacy states; only true permits the just-acquired cohort shortcut. */
  completedNormally?: boolean
}
export interface DoctorQualification { identity: string; checkedAt: number; state: 'qualified' | 'unsupported' | 'failed' | 'timeout' }
export interface SavedDoctorState {
  profileKey: string | null; profileIdentity: string | null
  availabilityFailure: { recordedAt: number; startupId: string | null } | null
  schemaVersion: 1; cycleStartedAt: number | null; versions: string | null; cycleStartupId: string | null
  appVersions: Record<'claude' | 'codex' | 'opencode', string | null>
  retryUsed: boolean; attempt: DoctorAttempt | null
  qualifications: Partial<Record<'claude' | 'codex', DoctorQualification>>
  results: Partial<Record<DoctorCheck, SavedDoctorResult>>
  continuity: ContinuityEnvelope | null
}
export interface DoctorPlan { kind: 'cycle' | 'retry' | 'availability'; checks: DoctorCheck[] }
export declare const DAY: number
export declare function emptyDoctorState(): SavedDoctorState
export declare function validateDoctorState(value: unknown): SavedDoctorState | null
export declare function recoverDoctorAttempt(state: SavedDoctorState, now: number): boolean
export declare function doctorPlan(state: SavedDoctorState, versions: string, startupId: string | null, now: number): DoctorPlan | null
export declare function beginDoctorAttempt(state: SavedDoctorState, plan: DoctorPlan, terms: { versions: string; startupId: string | null; now: number; runId: string }): SavedDoctorState
export declare function doctorView(state: SavedDoctorState, terms?: { now?: number; running?: boolean; versions?: string | null; appVersions?: Partial<SavedDoctorState['appVersions']> | null; profileMatches?: boolean; error?: DoctorView['error'] }): DoctorView
