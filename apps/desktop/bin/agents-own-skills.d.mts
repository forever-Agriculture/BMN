// MODULE: agents-own-skills.d.mts - types for agents-own-skills.mjs (Story 77.4: BMN's own skills install themselves)
type Environment = NodeJS.ProcessEnv | Record<string, string>
export type OwnSkillState = 'installed' | 'current' | 'updated' | 'repaired' | 'taken-over' | 'foreign' | 'removed' | 'unavailable'
export interface OwnSkillRow { name: string; state: OwnSkillState; path: string; copy?: string; detail?: string }
export interface OwnSkillsResult { ok: boolean; code: string; message?: string; source?: string; shipped?: string; copies?: string; rows: OwnSkillRow[] }
export declare const OWN_SKILLS_RECORD_VERSION: 1
export declare function ownSkillsRecordPath(): string
export declare function shippedSkillsRoot(environment?: Environment): string | null
export declare function ownCopiesRoot(environment?: Environment): string
export declare function shippedNames(root: string): string[]
export declare function pointsIntoBmn(target: string, name: string): boolean
export declare function installOwnSkills(options?: { source?: string; environment?: Environment; apply?: boolean; now?: Date }): OwnSkillsResult
export declare function ownSkillNames(source: string | null | undefined, environment?: Environment): string[]
