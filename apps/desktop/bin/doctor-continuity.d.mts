// MODULE: doctor-continuity.d.mts - Private continuity types, never part of the renderer protocol
import type { ProjectedDoctorResult } from './doctor-results.mjs'
export interface ContinuityBinding { profileBinding: string; attemptId: string }
export interface ContinuityWorkerKeys { item: string; context: string }
export interface ContinuityKeys extends ContinuityWorkerKeys { envelope: string }
export interface ContinuityRow { item: number; itemTag: string; contextTag: string }
export interface ContinuityEnvelope extends ContinuityBinding { schema: 1; scannerId: string; resultTag: string; rows: ContinuityRow[]; tag: string }
export declare const CONTINUITY_SCANNER: string
export declare function privateTag(key: string, domain: string, value: unknown): string
export declare function deriveContinuityKeys(profileKey: string, binding: ContinuityBinding): ContinuityKeys
export declare function validWorkerKeys(value: unknown): value is ContinuityWorkerKeys
export declare function validRowReceipts(value: unknown, maximum?: number): value is ContinuityRow[]
export declare function sealContinuity(rows: ContinuityRow[], result: ProjectedDoctorResult, binding: ContinuityBinding, key: string): ContinuityEnvelope
export declare function validateContinuity(value: unknown, result: ProjectedDoctorResult, binding: ContinuityBinding, key: string): ContinuityEnvelope | null
export declare function matchContinuity(original: ContinuityRow[], fresh: ContinuityRow[]): { item: number; current: number | null }[]
