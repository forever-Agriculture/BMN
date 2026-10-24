// MODULE: doctor-locations.d.mts - Safe coordinates and bounded resolution types
import type { DoctorLocator, DoctorLocationSource } from '../../../shared/protocol/src/doctor'
import type { SelectedDoctorProfile } from './doctor-profile.mjs'
export declare const LOCATION_ROOTS: readonly string[]
export declare const LOCATION_HELP: string
export declare const OBSERVATION_LIMITS: Readonly<{ entries: number; treeBytes: number; depth: number; databaseBytes: number }>
export declare function locationRoots(profile: SelectedDoctorProfile): Record<string, string>
export declare function unresolvedLocation(): { status: 'unresolved' }
export interface DoctorRouteObservation {
  nodes: { path: string; name: Buffer; object: import('../../../shared/protocol/src/doctor').DoctorLocationStat; link?: Buffer; target?: import('../../../shared/protocol/src/doctor').DoctorLocationStat | null }[]
  missing?: { path: string; code: 'ENOENT' | 'ENOTDIR' }
}
export interface DoctorAbsenceObservation { path: string; route: DoctorRouteObservation; outcome: 'absent' | 'blocked' | 'present' }
export interface DoctorAccessObservation { path: string; route: DoctorRouteObservation; outcome: boolean; uid: number; gid: number; groups: number[] }
export interface DoctorObservation { path: string; text?: string; bytes?: Buffer; locator: DoctorLocator; revisions?: { path: string; snapshot: DoctorLocationSource | null }[]; routes?: DoctorRouteObservation[] }
export interface DoctorTreeObservation extends DoctorObservation {
  body: string; link: string | null; kind: string; missingTarget: boolean
  files: Map<string, Buffer>; directories: Map<string, string[]>; hash: string
}
export declare function observeFile(path: string, roots: Record<string, string>, options?: { maxBytes?: number; expected?: DoctorLocationSource | null; binary?: boolean; routeObservation?: DoctorRouteObservation | null }): DoctorObservation & { bytes: Buffer; text: string }
export declare function observeRoute(path: string): DoctorRouteObservation
export declare function routeUnchanged(observation: DoctorRouteObservation): boolean
export declare function observeAbsent(path: string): DoctorAbsenceObservation
export declare function absenceUnchanged(observation: DoctorAbsenceObservation): boolean
export declare function observeAccess(path: string): DoctorAccessObservation
export declare function accessUnchanged(observation: DoctorAccessObservation): boolean
export declare function observeDirectory(path: string): DoctorObservation & { names: string[] }
export declare function observeTree(path: string, roots: Record<string, string>): DoctorTreeObservation
export declare function observeDatabases(paths: string[], roots: Record<string, string>): ((DoctorObservation & { bytes: Buffer; walBytes: Buffer | null }) | null)[] & { parts: Pick<DoctorObservation, 'path' | 'revisions' | 'routes'>[] }
export declare function unchangedSince(observation: unknown): boolean
export declare function validateLocation(value: unknown): DoctorLocator | null
export declare function locationText(value: unknown): string
