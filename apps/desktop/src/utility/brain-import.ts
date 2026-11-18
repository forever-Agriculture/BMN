// MODULE: brain-import.ts - Read-only vault manifest and verbatim triage-directed import batch
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { BrainImport } from './brain-store'
export interface BrainLabel {source:string;source_kind:'vault'|'memory';label:'brain'|'project home'|'drop'}
export interface BrainProjectHome {name:string;repository:string|null;summary:string;board:string|null;rules:string|null;archive:string}
const digest=(bytes:Buffer):string=>createHash('sha256').update(bytes).digest('hex')
export function vaultManifest(root:string):Record<string,string> {
  const manifest:Record<string,string>={}
  const visit=(directory:string):void=>{
    for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(directory===root&&['.git','.obsidian','ARCHIVE.md'].includes(entry.name))continue
      const path=join(directory,entry.name)
      if(entry.isSymbolicLink())continue
      if(entry.isDirectory())visit(path)
      else if(entry.isFile())manifest[relative(root,path)]=digest(readFileSync(path))
    }
  }
  visit(root);return manifest
}
function safelyInside(root:string,path:string):string {
  const actual=realpathSync(path);const child=relative(root,actual)
  if(isAbsolute(child)||child==='..'||child.startsWith('../'))throw new Error('Vault import source escaped the vault')
  if(lstatSync(path).isSymbolicLink())throw new Error('Vault import does not follow note aliases')
  return actual
}
export function prepareVaultImport(root:string,labels:BrainLabel[],projects:BrainProjectHome[]):{notes:BrainImport[];manifest:Record<string,string>;active:number;archived:number} {
  root=realpathSync(root)
  const manifest=vaultManifest(root)
  const selected=new Map<string,'active'|'archived'>()
  for(const label of labels)if(label.source_kind==='vault'&&label.label==='brain')selected.set(safelyInside(root,label.source),'active')
  for(const folder of ['projects','daily','templates']) {
    const directory=join(root,folder)
    try {
      for(const entry of readdirSync(directory,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.md')) {
        const path=safelyInside(root,join(directory,entry.name));if(!selected.has(path))selected.set(path,'archived')
      }
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  }
  const notes:BrainImport[]=[]
  for(const [path,status] of [...selected].sort(([a],[b])=>a.localeCompare(b))) {
    const bytes=readFileSync(path);const markdown=bytes.toString('utf8')
    if(!Buffer.from(markdown,'utf8').equals(bytes))throw new Error('Vault markdown is not valid UTF-8; import refused without rewriting it')
    const key=relative(root,path)
    if(digest(bytes)!==manifest[key])throw new Error('Vault source changed while preparing the import')
    notes.push({source:'vault:'+key,title:basename(path,'.md'),kind:status==='active'?'fact':'archive',origin:'import',scope:'all',markdown,status,source_time:statSync(path).mtime.toISOString()})
  }
  const escape=(text:string):string=>text.replaceAll('|','\\|').replace(/[\r\n]/g,' ')
  const link=(path:string|null):string=>path?`[records](<${path}>)`:'—'
  const map=['# Project map','','Projects keep their own facts. Follow the project records before using archived context.','','| Project | Repository | Summary | Board | Rules | Archive |','|---|---|---|---|---|---|',...projects.map(p=>`| ${escape(p.name)} | ${p.repository?escape(p.repository):'No repository yet'} | ${escape(p.summary)} | ${link(p.board)} | ${link(p.rules)} | ${link(p.archive)} |`)].join('\n')+'\n'
  notes.push({source:'generated:project-map',title:'Project map',kind:'map',origin:'import',scope:'all',markdown:map,status:'active'})
  const after=vaultManifest(root)
  if(JSON.stringify(manifest)!==JSON.stringify(after))throw new Error('Vault changed during import preparation')
  return {notes,manifest,active:notes.filter(n=>n.status==='active').length,archived:notes.filter(n=>n.status==='archived').length}
}
export function verifyVaultImport(root:string,manifest:Record<string,string>):void {
  if(JSON.stringify(vaultManifest(resolve(root)))!==JSON.stringify(manifest))throw new Error('Vault source hash proof failed')
}
