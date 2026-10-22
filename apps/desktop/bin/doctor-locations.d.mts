// MODULE: doctor-locations.d.mts - Safe coordinates and bounded resolution types
import type { DoctorLocator, DoctorLocationSource } from '../../../shared/protocol/src/doctor'
import type { SelectedDoctorProfile } from './doctor-profile.mjs'
export declare const LOCATION_ROOTS: readonly string[]
export declare const LOCATION_HELP: string
export declare function locationRoots(profile: SelectedDoctorProfile): Record<string, string>
export declare function unresolvedLocation(): { status: 'unresolved' }
export interface DoctorObservation { path: string; text?: string; bytes?: Buffer; locator: DoctorLocator }
export interface DoctorTreeObservation extends DoctorObservation {
  body: string; link: string | null; kind: string; missingTarget: boolean
  files: Map<string, Buffer>; directories: Map<string, string[]>; hash: string
}
export declare function observeFile(path: string, roots: Record<string, string>, options?: { maxBytes?: number; expected?: DoctorLocationSource | null; binary?: boolean }): DoctorObservation & { bytes: Buffer; text: string }
export declare function observeTree(path: string, roots: Record<string, string>): DoctorTreeObservation
export declare function observeDatabases(paths: string[], roots: Record<string, string>): ((DoctorObservation & { bytes: Buffer; walBytes: Buffer | null }) | null)[]
export declare function bindLocation(observation: DoctorObservation | null, roots: Record<string, string>, options?: { start?: number | null; rowid?: number | null; dependencies?: DoctorObservation[] }): DoctorLocator
export declare function unchangedAt(path: string, value: unknown): boolean
export declare function locateItem(path: string, roots: Record<string, string>, options?: { text?: string | null; start?: number | null; rowid?: number | null }): DoctorLocator
export declare function validateLocation(value: unknown): DoctorLocator | null
export declare function resolveLocation(value: unknown, roots: Record<string, string>, budget?: { remaining: number }): string | null
export declare function locationText(value: unknown): string
