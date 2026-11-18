// MODULE: brain-attachment-crash-probe.mjs - Actual worker kill, restart and restored binding history
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {removeOwnedDirectory} from '../lib/owned-directories.mjs'
export function probeBrainAttachmentCrashes(stage){
const require=createRequire(stage+'/apps/desktop/package.json'),compiler=createRequire(require.resolve('vite'))('esbuild'),SQLite=require('better-sqlite3'),harness=mkdtempSync(join(tmpdir(),'bmn-d19-worker-')),identity=lstatSync(harness),results=[]
try{
 symlinkSync(stage+'/apps/desktop/node_modules',join(harness,'node_modules'),'dir')
 const entry=join(harness,'worker.cjs'),control=join(harness,'control.cjs'),fault=join(harness,'fault.cjs')
 compiler.buildSync({entryPoints:[stage+'/apps/desktop/src/utility/brain-worker.ts'],outfile:entry,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3'],logLevel:'error'})
 writeFileSync(control,`const {Worker}=require('node:worker_threads'),path=require('node:path');const [entry,root,fault,recover]=process.argv.slice(2),worker=new Worker(entry,{workerData:{databasePath:path.join(root,'brain.sqlite3'),attachmentsRoot:path.join(root,'files')},execArgv:['--require',fault]}),pending=new Map();let next=0;worker.on('message',r=>{const p=pending.get(r.id);pending.delete(r.id);if(r.error)p.reject(Error(r.error.message));else p.resolve(r.result)});worker.on('error',e=>{console.error(e);process.exit(1)});const ask=(operation,args=[])=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});worker.postMessage({id,operation,args})});(async()=>{const content={title:'Crash attachment',kind:'fact',origin:'synthetic',scope:'all',markdown:'[asset](files/asset.bin) [[Target]]'};let held=false;try{await ask('initialize')}catch(error){if(recover!=='after-commit')throw error;held=true}if(!recover){await ask('write-door',[true]);await ask('create',[content,'synthetic'])}else if(recover==='after-commit'){if(!held)throw Error('Changed current bytes must hold restart export');const note=await ask('read',['Crash attachment',{}]);if(note.revision!==1)throw Error('Restart invented a revision');await ask('edit',[note.id,1,content,'synthetic']);const backup=await ask('backup'),restored=await ask('restore-check',[backup,path.join(root,'restored')]);if(restored.attachments!==2||restored.versions!==2)throw Error('Restored revision bindings differ');console.log(JSON.stringify({held,restored}))}else{const notes=await ask('list');if(notes.length)throw Error('Precommit crash exposed a note');console.log(JSON.stringify({empty:true}))}await ask('close');await worker.terminate()})().catch(e=>{console.error(e);process.exit(1)});`)
 writeFileSync(fault,`const fs=require('node:fs'),path=require('node:path'),root=process.env.BMN126_WORKER_ROOT,mode=process.env.BMN126_WORKER_FAULT;if(!root||!root.includes('/bmn-d19-worker-'))throw Error('Synthetic root required');const mark=where=>{fs.writeFileSync(path.join(root,'interrupted.json'),JSON.stringify({where}));process.kill(process.pid,'SIGKILL')};if(mode==='before-commit'){const original=fs.fsyncSync;fs.fsyncSync=fd=>{const result=original(fd);if(fs.readlinkSync('/proc/self/fd/'+fd)===path.join(root,'brain-backups/objects'))mark('objects directory fsynced before commit');return result};require('node:module').syncBuiltinESMExports()}if(mode==='after-commit'){const SQLite=require('better-sqlite3'),transaction=SQLite.prototype.transaction;SQLite.prototype.transaction=function(callback){const wrapped=transaction.call(this,callback),database=this;return function(...args){const result=wrapped.apply(this,args);try{if(database.prepare('SELECT id FROM brain_note WHERE normalized_title=?').get('crash attachment'))mark('SQLite committed before export/reply')}catch(error){if(!/no such table/.test(error.message))throw error}return result}}}`)
 for(const mode of ['before-commit','after-commit']){
  const root=join(harness,mode);mkdirSync(root);mkdirSync(join(root,'files'));writeFileSync(join(root,'files/asset.bin'),'Original committed bytes')
  const child=spawnSync(process.execPath,[control,entry,root,fault],{env:{...process.env,BMN126_WORKER_ROOT:root,BMN126_WORKER_FAULT:mode},encoding:'utf8',timeout:15000});assert.equal(child.signal,'SIGKILL',child.stderr)
  writeFileSync(join(root,'files/asset.bin'),'Replacement after crash')
  const db=new SQLite(join(root,'brain.sqlite3'));try{
   const notes=db.prepare('SELECT * FROM brain_note').all(),versions=db.prepare('SELECT * FROM brain_version').all(),bindings=db.prepare('SELECT * FROM brain_attachment').all()
   if(mode==='before-commit'){assert.equal(notes.length,0);assert.equal(versions.length,0);assert.equal(bindings.length,0)}else{
    assert.equal(notes.length,1);assert.equal(versions.length,1);assert.equal(bindings.length,1);assert.equal(readFileSync(join(root,'brain-backups/objects',bindings[0].hash),'utf8'),'Original committed bytes');assert.equal(db.prepare('SELECT target FROM brain_link').get().target,'Target');assert.equal(db.prepare("SELECT count(*) n FROM brain_search WHERE brain_search MATCH 'asset'").get().n,1)
   }
  }finally{db.close()}
  const recovered=spawnSync(process.execPath,[control,entry,root,fault,mode],{env:{...process.env,BMN126_WORKER_ROOT:root,BMN126_WORKER_FAULT:'none'},encoding:'utf8',timeout:15000});assert.equal(recovered.status,0,recovered.stderr)
  results.push({mode,recovery:JSON.parse(recovered.stdout),signal:child.signal,interrupted:JSON.parse(readFileSync(join(root,'interrupted.json'),'utf8')),pass:true})
 }
 return {ok:true,results,scope:'Actual worker process crashes, restart holds changed bytes, edit makes next binding and restore proves both hashes'}
}finally{removeOwnedDirectory(harness,{device:identity.dev,inode:identity.ino})}

}
