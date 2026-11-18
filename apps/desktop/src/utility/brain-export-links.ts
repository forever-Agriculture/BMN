// MODULE: brain-export-links.ts - Generation-bound Quick Look targets for verbatim Brain Markdown
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { resolveApplicationRoots } from './roots'
const uuid=/^[a-f0-9-]{36}$/
export async function readBrainExportLinks(canonicalPath:string,digest:string):Promise<Record<string,string>|undefined> {
  const expected=await realpath(join(resolveApplicationRoots().data,'brain-export')).catch(()=>null)
  const folder=dirname(canonicalPath),name=basename(canonicalPath)
  if(!expected||dirname(folder)!==expected||!uuid.test(basename(folder))||!name.endsWith('.md')||!uuid.test(name.slice(0,-3)))return undefined
  try {
    const path=join(folder,'.links',name.slice(0,-3)+'.json'),stat=await lstat(path)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024||stat.mode&0o222)return {}
    const map=JSON.parse(await readFile(path,'utf8')) as {version:number;checksum:string;targets:unknown}
    if(map.version!==1||map.checksum!==digest||!map.targets||typeof map.targets!=='object'||Array.isArray(map.targets))return {}
    const targets:Record<string,string>={}
    for(const [address,value]of Object.entries(map.targets)){
      if(!/^(?:wiki|markdown):/.test(address)||typeof value!=='string'||!(/^[a-f0-9-]{36}\.md$/.test(value)||/^assets\/[a-f0-9]{64}(?:\.[a-z0-9]{1,10})?$/.test(value)))return {}
      const target=join(folder,value),entry=await lstat(target)
      if(!entry.isFile()||entry.isSymbolicLink()||entry.mode&0o222||await realpath(target)!==target)return {}
      targets[address]=target
    }
    return targets
  }catch{return {}}
}
