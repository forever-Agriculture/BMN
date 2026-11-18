// MODULE: brain-cutover-authorization.ts - One-use owner consent held only in the main process
import type {BrainPreparationSnapshot} from './brain-build-proof'
const issuedPermits=new WeakSet<object>()
export interface BrainCutoverPermit {readonly preparation?:BrainPreparationSnapshot;readonly signal?:AbortSignal;assert():void;decide(payloadHash:string):Promise<void>;commit():void;retireFailed?(payloadHash:string):void}
export function assertBrainCutoverPermit(value:unknown):asserts value is BrainCutoverPermit {
 if(!value||typeof value!=='object'||!issuedPermits.has(value))throw new Error('The brain switch requires a live owner authorization from BMN’s palette')
 ;(value as BrainCutoverPermit).assert()
}
export interface CutoverPeer { pid:number; uid:number; ticks:string; connection:string; invocation:string }
export interface CutoverAuthorizationDependencies {
  confirm():Promise<boolean>
  start():Promise<void>
  attest(peer:CutoverPeer):Promise<boolean>
  decide(peer:CutoverPeer,payloadHash:string,accept:()=>void):Promise<void>
  proveBuild():Promise<BrainPreparationSnapshot|void>
  now():number
}
/** No token, file or database row can create a grant. Only the window handler calls begin. */
export class BrainCutoverAuthorization {
  private state:'held'|'confirming'|'starting'|'ready'|'checking'|'running'|'deciding'|'decided'|'complete'='held'
  private decidedHash:string|null=null
  private expires=0
  private generation=0
  private peer:CutoverPeer|null=null
  private launch:Promise<void>|null=null
  private permit:BrainCutoverPermit|null=null
  private controller:AbortController|null=null
  expirePending():void {if(['starting','ready'].includes(this.state)&&this.dependencies.now()>this.expires)this.invalidate()}
  constructor(private readonly dependencies:CutoverAuthorizationDependencies) {}
  status() {this.expirePending();return {available:this.state==='held',running:['starting','ready','checking','running','deciding','decided'].includes(this.state),complete:this.state==='complete'}}
  async begin():Promise<void> {
    this.expirePending()
    if(this.state!=='held')throw new Error('The brain switch is already in progress')
    const generation=++this.generation
    this.state='confirming'
    try {
      const confirmed=await this.dependencies.confirm()
      if(generation!==this.generation)throw new Error('The brain switch confirmation expired')
      if(!confirmed){this.invalidate();return}
      if(this.state!=='confirming')throw new Error('The brain switch confirmation expired')
      this.state='starting';this.expires=this.dependencies.now()+30_000
      this.launch=this.dependencies.start()
      await this.launch
      if(generation!==this.generation)throw new Error('The brain switch confirmation expired')
      if(this.state==='starting')this.state='ready'
    }catch(error){if(generation===this.generation)this.invalidate();throw error}
  }
  async consume(peer:CutoverPeer):Promise<BrainCutoverPermit> {
    const generation=this.generation
    if(this.state==='starting')await this.launch
    if(generation!==this.generation)throw new Error('Choose and confirm Switch to the BMN brain… in BMN again')
    if(this.state!=='ready'||this.dependencies.now()>this.expires){this.invalidateUnlessRunning();throw new Error('Choose and confirm Switch to the BMN brain… in BMN again')}
    // Reserve synchronously before any I/O: two requests cannot consume one grant.
    this.state='checking';this.peer={...peer}
    try {
      if(!await this.dependencies.attest(peer))throw new Error('The brain cutover caller is not the authorized user service')
      const checked=await this.dependencies.proveBuild()
      const preparation=checked?Object.freeze({text:checked.text,sha256:checked.sha256,...(checked.value===undefined?{}:{value:checked.value})}):undefined
      if(generation!==this.generation||this.state!=='checking'||this.dependencies.now()>this.expires)throw new Error('The brain switch authorization expired')
      this.state='running';this.controller=new AbortController()
      const permit:BrainCutoverPermit=Object.freeze({signal:this.controller.signal,...(preparation?{preparation}:{}),assert:()=>{if(!['running','deciding','decided'].includes(this.state)||this.permit!==permit)throw new Error('The brain switch authorization was cancelled')},decide:(hash:string)=>this.decide(permit,hash),retireFailed:(hash:string)=>{if(!this.hasDecision(permit,hash))throw new Error('No matching failed publication decision');this.state='held';this.decidedHash=null;this.generation++;this.controller?.abort();this.controller=null;issuedPermits.delete(permit);this.permit=null;this.peer=null;this.expires=0;this.launch=null},commit:()=>{permit.assert();this.finish()}})
      this.permit=permit;issuedPermits.add(permit);return permit
    }catch(error){if(generation===this.generation)this.invalidate();throw error}
  }
  disconnected(peer:Omit<CutoverPeer,'invocation'>):void {
    if(this.peer&&['checking','running','deciding'].includes(this.state)&&['pid','uid','ticks','connection'].every(key=>this.peer![key as keyof CutoverPeer]===peer[key as keyof typeof peer]))this.invalidate()
  }
  async check(peer:CutoverPeer):Promise<void> {
    const generation=this.generation,expected=this.peer
    if(this.state!=='running'||!expected||Object.keys(expected).some(k=>expected[k as keyof CutoverPeer]!==peer[k as keyof CutoverPeer]))throw new Error('No live brain switch authorization')
    const attested=await this.dependencies.attest(peer)
    if(generation!==this.generation||this.state!=='running'||this.peer!==expected)throw new Error('No live brain switch authorization')
    if(!attested){this.invalidate();throw new Error('No live brain switch authorization')}
  }
  pendingDecision(permit:BrainCutoverPermit):string|null {
    return this.state==='decided'&&this.permit===permit?this.decidedHash:null
  }
  private hasDecision(permit:BrainCutoverPermit,hash:string):boolean {return this.state==='decided'&&this.permit===permit&&this.decidedHash===hash}
  private async decide(permit:BrainCutoverPermit,hash:string):Promise<void> {
    if(this.state!=='running'||this.permit!==permit||!this.peer||!/^[a-f0-9]{64}$/.test(hash))throw new Error('No unused final brain decision')
    const generation=this.generation,peer=this.peer
    this.state='deciding'
    try{
      if(!await this.dependencies.attest(peer)||generation!==this.generation||this.state!=='deciding')throw new Error('The brain peer was lost before the final decision')
      await this.dependencies.decide(peer,hash,()=>{
        if(generation!==this.generation||this.state!=='deciding'||this.permit!==permit)throw new Error('The final brain decision was cancelled')
        // Called synchronously while handling the broker line, before a later `gone` line.
        this.decidedHash=hash;this.state='decided'
      })
      if(!this.hasDecision(permit,hash))throw new Error('The broker did not accept the final brain decision')
    }catch(error){if(this.hasDecision(permit,hash))return;if(generation===this.generation)this.invalidate();throw error}
  }
  finish():void {if(this.state!=='decided'||!this.decidedHash)throw new Error('The final brain decision is required before publication');this.state='complete';this.peer=null}
  invalidate():void {if(['decided','complete'].includes(this.state))return;this.decidedHash=null;this.generation++;this.controller?.abort();this.controller=null;if(this.permit)issuedPermits.delete(this.permit);this.permit=null;this.state='held';this.peer=null;this.expires=0;this.launch=null}
  private invalidateUnlessRunning():void {if(!['checking','running','deciding','decided','complete'].includes(this.state))this.invalidate()}
}
