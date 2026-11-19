// MODULE: brain-build-proof.ts - Bind consent to the actual executable and packaged app bytes
import {brainResourcesHash} from '../../../../scripts/lib/brain-provenance.mjs'
import {createHash} from 'node:crypto'
import {readFileSync,readlinkSync,readdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
export interface BrainPreparationSnapshot {readonly text:string;readonly sha256:string;readonly value?:unknown}
export interface CompletedBrainBuild {phase:'complete';commit:string;brainDeliveryCommit:string;binary:string;archive:string;binaryHash:string;archiveHash:string;resourcesHash?:string;preparedHash?:string|null;brainVersion:126;preparation?:BrainPreparationSnapshot}
const hash=(path:string,read=readFileSync):string=>createHash('sha256').update(read(path)).digest('hex')
/** Completed records persist separately from latest.json; later queued/failed updates cannot hide them. */
export function proveBrainBuild(options:{stateDirectory:string;pid:number;archive:string;contains:(commit:string,delivery:string)=>boolean;procRoot?:string;resources?:string;preparedPath?:string}):CompletedBrainBuild {
 const delivery=JSON.parse(readFileSync(join(options.stateDirectory,'brain-delivery.json'),'utf8')) as {version:number;epic:number;commit:string}
 if(delivery.version!==1||delivery.epic!==126||!/^[a-f0-9]{40,64}$/.test(delivery.commit))throw new Error('The brain delivery identity is missing')
 const executable=readlinkSync(join(options.procRoot??'/proc',String(options.pid),'exe'))
 if(executable.endsWith(' (deleted)'))throw new Error('The running BMN executable has been replaced; reopen the installed build')
 const records=[join(options.stateDirectory,'latest.json')]
 try{records.push(...readdirSync(join(options.stateDirectory,'completed')).filter(n=>/^[a-f0-9]{40,64}\.json$/.test(n)).map(n=>join(options.stateDirectory,'completed',n)))}catch{/* No historical completed install. */}
 const preparedBytes=options.preparedPath?readFileSync(options.preparedPath):undefined
 const preparation=preparedBytes?Object.freeze({text:preparedBytes.toString('utf8'),sha256:createHash('sha256').update(preparedBytes).digest('hex')}):undefined
 // Electron exposes app.asar as a virtual directory. Provenance hashes the file on disk.
 const rawFs=process.getBuiltinModule('original-fs') as Pick<typeof import('node:fs'),'readFileSync'>|undefined
 const binaryHash=hash(executable),archiveHash=hash(options.archive,rawFs?.readFileSync)
 for(const path of records){
  let record:CompletedBrainBuild
  try{record=JSON.parse(readFileSync(path,'utf8')) as CompletedBrainBuild}catch{continue}
  if(record.phase!=='complete'||record.brainVersion!==126||!/^[a-f0-9]{40,64}$/.test(record.commit)||typeof record.binary!=='string'||typeof record.archive!=='string')continue
  if(resolve(record.binary)!==resolve(executable)||resolve(record.archive)!==resolve(options.archive)||record.binaryHash!==binaryHash||record.archiveHash!==archiveHash)continue
  if(options.resources&&record.resourcesHash!==brainResourcesHash(options.resources))continue
  if(preparation&&record.preparedHash!==preparation.sha256)continue
  if(record.brainDeliveryCommit===delivery.commit&&options.contains(record.commit,delivery.commit))return {...record,...(preparation?{preparation}:{})}
 }
 throw new Error('The running BMN build has no completed install containing the brain; wait for the update, reopen BMN and choose the palette entry again')
}
