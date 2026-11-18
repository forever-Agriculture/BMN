// MODULE: brain-cutover-peer.ts - Attest the kernel peer against an exact user-manager unit
import {execFile} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {promisify} from 'node:util'
import type {CutoverPeer} from './brain-cutover-authorization'
const execute=promisify(execFile)
/** The production caller supplies its fixed unit; no environment, CLI or stored setting selects it. */
export async function attestBrainCutoverPeer(peer:CutoverPeer,unit:string):Promise<boolean> {
 try{
  if(!Number.isSafeInteger(peer.pid)||peer.pid<=0||peer.uid!==process.getuid?.()||!/^\d+$/.test(peer.ticks)||!/^[a-f0-9]{32}$/.test(peer.connection)||!/^[a-f0-9]{32}$/.test(peer.invocation))return false
  const ticks=readFileSync(`/proc/${peer.pid}/stat`,'utf8').split(') ').at(-1)!.trim().split(/\s+/)[19]
  if(ticks!==peer.ticks)return false
  const {stdout}=await execute('/usr/bin/systemctl',['--user','show',unit,'--property=MainPID','--property=InvocationID','--property=ActiveState'],{timeout:5000})
  const fields=Object.fromEntries(stdout.trim().split('\n').map(line=>line.split('=')))
  return Number(fields.MainPID)===peer.pid&&fields.InvocationID===peer.invocation&&['activating','active'].includes(fields.ActiveState??'')
 }catch{return false}
}
