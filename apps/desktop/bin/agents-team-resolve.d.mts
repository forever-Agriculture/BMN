// MODULE: agents-team-resolve.d.mts - types for the one resolver that picks who answers an ask (Epic 72)
import type { RosterAgent, RosterData, RosterRole } from './agents-roster.mjs'
export declare class AskRefusal extends Error { code: string; alternatives?: string[]; constructor(code: string, message: string, alternatives?: string[]) }
export interface ResolveContext {
  project: string | null
  standing: (agent: RosterAgent) => string
  allowed: (agent: RosterAgent) => { allowed: boolean; reason?: string }
  projectChoice?: (role: RosterRole) => { agent: string; effort?: string } | null
}
export interface ResolveRequest {
  role: string; agent?: string; effort?: string; smallWork?: boolean
  recheck?: { id: string; run: { role: string; project: string | null; agent: string } | null } | null
}
export interface Teammate { agent: RosterAgent; effort: string; rule: 'recheck' | 'project-choice' | 'agent' | 'small-work' | 'chain'; phase: 'initial' | 'recheck' | 'small-work' }
export declare function notEligible(data: RosterData, role: RosterRole, agent: RosterAgent | undefined, context: ResolveContext): string | null
export declare function phaseEfforts(role: RosterRole, agent: RosterAgent, phase: string): string[]
export declare function alternatives(data: RosterData, role: RosterRole, context: ResolveContext): string[]
export declare function resolveTeammate(data: RosterData, request: ResolveRequest, context: ResolveContext): Teammate
