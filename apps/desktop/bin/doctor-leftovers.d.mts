// MODULE: doctor-leftovers.d.mts - Read-only projected acquisition result and current-version input types
import type { ProjectedDoctorResult } from './doctor-results.mjs'
export declare const leftoversModule: string
export declare function inspectLeftovers(currentVersions?: Partial<Record<'claude' | 'codex' | 'opencode', string | null>>): Promise<ProjectedDoctorResult>
