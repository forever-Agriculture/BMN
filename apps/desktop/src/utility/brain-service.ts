// MODULE: brain-service.ts - Closed agent commands; session identity comes only from authenticated scope
import { BrainError, type BrainContent } from './brain-store'
import type { BrainWorkerClient } from './brain-client'
import type { ControlScope } from './control-auth'
const KEYS:Record<string,readonly string[]> = {
  search:['query','archived'],read:['name','section','links'],history:['name'],
  write:['revision','title','kind','origin','scope','markdown','source_time','superseded_by'],
  edit:['name','revision','title','kind','origin','scope','markdown','source_time','superseded_by'],
  withdraw:['name','revision'],restore:['name','revision'],delete:[],export:[]
}
export class BrainService {
  constructor(readonly client:BrainWorkerClient,private readonly canWrite:()=>boolean|Promise<boolean>) {}
  async request(scope:ControlScope,params:Record<string,unknown>):Promise<unknown> {
    const command=params.command
    if(typeof command!=='string' || !Object.hasOwn(KEYS,command))throw new BrainError('INVALID_ARGUMENT','Unknown brain command')
    const keys=KEYS[command]!
    if(Object.keys(params).some(k=>k!=='command' && !keys.includes(k)))throw new BrainError('INVALID_ARGUMENT','Unexpected brain parameter')
    const text=(key:string):string=>{
      const value=params[key];if(typeof value!=='string')throw new BrainError('INVALID_ARGUMENT',`Brain ${key} must be text`);return value
    }
    const flag=(key:string):boolean=>{
      if(params[key]!==undefined && typeof params[key]!=='boolean')throw new BrainError('INVALID_ARGUMENT',`Brain ${key} must be true or false`)
      return params[key]===true
    }
    if(command==='search')return this.client.search(text('query'),flag('archived'))
    if(command==='read')return this.client.read(text('name'),{...(params.section===undefined?{}:{section:text('section')}),links:flag('links')})
    if(command==='history')return this.client.history(text('name'))
    if(command==='delete')return this.client.delete()
    if(command==='export')return this.client.currentExport()
    if(scope.kind!=='session')throw new BrainError('UNAUTHORIZED','Brain writes require a live BMN session')
    if(!await this.canWrite())throw new BrainError('CUTOVER_PENDING','The brain is read-only until the owner switches in BMN’s command palette')
    const session=scope.sessionId
    const revision=():number=>{
      if(typeof params.revision!=='number' || !Number.isSafeInteger(params.revision))throw new BrainError('INVALID_ARGUMENT','Read the brain note and supply its revision')
      return params.revision
    }
    if(command==='withdraw')return this.client.withdraw(text('name'),revision(),session)
    if(command==='restore')return this.client.restore(text('name'),revision(),session)
    if(command==='write' && params.revision!==0)throw new BrainError('INVALID_ARGUMENT','A new brain note requires revision 0')
    const content:BrainContent={title:text('title'),kind:text('kind'),origin:text('origin'),scope:text('scope'),markdown:text('markdown'),...(params.source_time===undefined?{}:{source_time:text('source_time')}),...(params.superseded_by===undefined?{}:{superseded_by:params.superseded_by===null?null:text('superseded_by')})}
    return command==='write'?this.client.create(content,session):this.client.edit(text('name'),revision(),content,session)
  }
}
