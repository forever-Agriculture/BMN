// MODULE: brain-cutover-skills.d.mts - Typed journal boundary for normal managed brain ownership
import type {BrainCutoverPaths} from '../src/utility/brain-cutover-journal'
export interface BrainSkillOwnership {version:1;state:string;[key:string]:unknown}
export interface BrainCutoverSkills {prepare():BrainSkillOwnership;install(proof:BrainSkillOwnership,record:(proof:BrainSkillOwnership)=>void):void;verify(proof:BrainSkillOwnership,restored?:string[]):string[];rollback(proof:BrainSkillOwnership,record:(proof:BrainSkillOwnership)=>void,restored?:string[]):void}
export declare function managedBrainSkillPath(home?:string):string
export declare function brainCutoverSkills(paths:BrainCutoverPaths,guard:()=>void):BrainCutoverSkills
