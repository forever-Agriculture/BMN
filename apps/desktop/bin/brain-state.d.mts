// MODULE: brain-state.d.mts - Pure completion-receipt contract, injected outside the Rules graph
export interface BrainCommitReceipt {version:2;cutoverId:string;storeId:string;payloadHash:string;revoked?:boolean}
export function managedBrainSkillPath(home?:string,environment?:NodeJS.ProcessEnv):string
export function brainStateRoot(environment?:NodeJS.ProcessEnv,home?:string):string
export function configureBrainReceiptReader(reader:(stateRoot:string)=>((BrainCommitReceipt&{open:boolean})|null)):void
export function brainEvidenceHash(value:unknown):string
export function brainJournalCommit(journal:unknown,storeId:string):BrainCommitReceipt
export function brainReceiptMatches(journal:unknown,receipt:unknown):boolean
export function brainSwitchComplete(environment?:NodeJS.ProcessEnv,home?:string):boolean
