export function brainFileHash(path:string):string
export function brainResourcesHash(root:string):string
export function brainCutoverStateRoot(environment?:NodeJS.ProcessEnv,home?:string):string

export declare function brainDeliveryCommit(project:string,installedCommit:string):string
export declare function brainContainsDelivery(project:string,delivery:string,installed:string):boolean
