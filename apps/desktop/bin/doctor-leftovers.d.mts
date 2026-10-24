// MODULE: doctor-leftovers.d.mts - Read-only projected acquisition result and current-version input types
import type { ProjectedDoctorResult } from './doctor-results.mjs'
import type { ContinuityRow, ContinuityWorkerKeys } from './doctor-continuity.mjs'
export declare const leftoversModule: string
type Versions = Partial<Record<'claude' | 'codex' | 'opencode', string | null>>
export declare function inspectLeftovers(currentVersions: Versions, options: { keys?: ContinuityWorkerKeys | null; privateReceipts: true; deadline?: number }): Promise<{ result: ProjectedDoctorResult; rows: ContinuityRow[] }>
export declare function inspectLeftovers(currentVersions?: Versions, options?: { keys?: ContinuityWorkerKeys | null; privateReceipts?: false; deadline?: number }): Promise<ProjectedDoctorResult>
