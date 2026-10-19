// MODULE: agents-team-app.d.mts - types for Agents › Asks (Story 73.1): the list, one opened, stop, remove and export
import type { TeamAskDetail, TeamAsksSnapshot } from '@bmn/protocol'
export declare function appAsks(options?: { runs?: string; now?: Date }): TeamAsksSnapshot
export declare function appAskDetail(id: string, options?: { runs?: string; now?: Date }): TeamAskDetail
export declare function appAskStop(id: string, options?: { runs?: string }): void
export declare function appAskRemove(id: string | null, options?: { runs?: string; now?: Date }): number
export declare function appAskExport(id: string, into: string, options?: { runs?: string }): { output: string; files: string[] }
