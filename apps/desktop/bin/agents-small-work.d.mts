// MODULE: agents-small-work.d.mts - types for pure shared Small work configuration access
import type { RosterData, RosterRole } from './agents-roster.mjs'
export declare const EPIC_REVIEW: 'epic-reviewer'
export declare const SMALL_EPIC_REVIEW: 'small-epic-reviewer'
export declare function isSmallWorkReference(value: unknown): value is { role: 'small-epic-reviewer' }
export declare function linkedSmallWork(data: Pick<RosterData, 'roles'>, role: RosterRole | undefined): RosterRole | null
export declare function sharedSmallWork(data: Pick<RosterData, 'roles'>): { outer: RosterRole; target: RosterRole } | null
export declare function smallWorkCandidates(data: Pick<RosterData, 'roles'>, role: RosterRole): string[]
export declare function unlinkedSmallWork(data: Pick<RosterData, 'roles'>): { outer: RosterRole; target: RosterRole } | null
